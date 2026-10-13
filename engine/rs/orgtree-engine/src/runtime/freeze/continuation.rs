//! Manual continuation resolves a native login without inventing a registry row.
//! All checks use published snapshots: no provider request or credential read.

use anyhow::Result;
use chrono::Utc;

use crate::accounts::{self, AccountInfo, Choice};
use crate::engine::Engine;
use crate::providers::catalog;
use crate::util::iso;

pub(super) struct Target {
    pub binding: Option<String>,
    pub lane: String,
    pub display: String,
}

#[logged]
pub(super) fn resolve(engine: &Engine, org: &str, tier: &str, raw: &str) -> Result<Target> {
    let provider = catalog::provider_of(tier);
    let raw = raw.trim();
    let view = engine.accounts.view();
    let account: Option<AccountInfo> = match accounts::choice(Some(raw)) {
        Choice::Unset => crate::refuse!(BadRequest, "choose an account to continue on"),
        Choice::Primary => {
            if let Some(p) = raw.strip_suffix("/primary") {
                if p != provider {
                    crate::refuse!(
                        BadRequest,
                        "{raw} is a {p} account; this agent runs on {provider}"
                    );
                }
            }
            if !matches!(
                provider,
                catalog::CLAUDE | catalog::OPENAI | catalog::GOOGLE | catalog::MUSE
            ) {
                crate::refuse!(BadRequest, "{provider} has no native primary account");
            }
            None
        }
        Choice::Account(id) => {
            let Some(a) = view.get(&id).filter(|a| a.available_origin(org)).cloned() else {
                crate::refuse!(NotFound, "no account {id}");
            };
            if a.provider != provider {
                crate::refuse!(
                    BadRequest,
                    "{id} is a {} account; this agent runs on {provider}",
                    a.provider
                );
            }
            Some(a)
        }
    };
    let lane = account
        .as_ref()
        .map(crate::org_accounts::lane_of)
        .unwrap_or_else(|| crate::org_accounts::primary(provider));
    if !crate::org_accounts::allowed(Some(org), &lane) {
        crate::refuse!(
            Conflict,
            "{}",
            crate::org_accounts::refusal(engine, org, &lane, provider)
        );
    }
    if !engine.settings.provider_enabled(provider)
        || !accounts::active(engine, provider, account.as_ref())
    {
        crate::refuse!(Conflict, "{lane} is inactive; nothing changed");
    }
    if let Some(a) = &account {
        if a.auth == "unauthenticated" {
            crate::refuse!(Conflict, "{lane} is signed out; nothing changed");
        }
    }
    // Ambient registry rows spend the same native login, not a second sign-in.
    let native = account.as_ref().is_none_or(|a| a.ambient);
    // Explicit native-home requests and '~' observe the same physical login.
    let native_accounts: Vec<&AccountInfo> = if native {
        view.all().into_iter().filter(|a| {
            a.provider == provider && !a.is_apikey() && (a.ambient || a.config_dir.is_none())
        }).collect()
    } else {
        Vec::new()
    };
    if native {
        let state = engine.providers.state.load();
        let status = match provider {
            catalog::CLAUDE => &state.claude,
            catalog::OPENAI => &state.codex,
            catalog::GOOGLE => &state.agy,
            // Muse's own login, as its last metadata read saw it
            catalog::MUSE => &state.muse,
            _ => crate::refuse!(BadRequest, "{provider} has no native primary account"),
        };
        if !status.installed || !status.connected {
            crate::refuse!(
                Conflict,
                "{lane} is not signed in or its CLI is unavailable; nothing changed"
            );
        }
        let auth_key = |folder| match provider {
            catalog::CLAUDE => crate::usage::claude_key(folder),
            catalog::OPENAI => crate::usage::codex_key(folder),
            catalog::MUSE => crate::usage::muse_key(folder),
            _ => "agy".to_string(),
        };
        let auth_keys: Vec<String> = std::iter::once(auth_key(None))
            .chain(native_accounts.iter().map(|a| auth_key(a.config_dir.as_deref())))
            .collect();
        if engine.usage.cached_reauth_required_across(auth_keys.iter().map(String::as_str)) == Some(true) {
            crate::refuse!(Conflict, "{lane} requires sign-in again; nothing changed");
        }
    }
    let now = Utc::now();
    // A primary alias cannot bypass a mark stored on an ambient registry row.
    let until = if native {
        native_accounts.iter()
            .filter_map(|a| a.limited_for(tier, now))
            .max()
    } else {
        account.as_ref().and_then(|a| a.limited_for(tier, now))
    };
    if let Some(until) = until {
        crate::refuse!(
            Conflict,
            "{lane} is itself limited for {tier} until {}; nothing changed",
            iso(until)
        );
    }
    // Every unexpired full window constrains this login, whichever alias read
    // it. Missing or quieter readings under another alias do not erase it.
    let exhausted = if native {
        std::iter::once(None).chain(native_accounts.iter().copied().map(Some))
            .find_map(|a| crate::usage::at_limit(engine, a, tier))
    } else {
        crate::usage::at_limit(engine, account.as_ref(), tier)
    };
    if let Some(why) = exhausted {
        crate::refuse!(
            Conflict,
            "{lane} is at its limit for {tier} right now: {why}; nothing changed"
        );
    }
    Ok(Target {
        binding: account.as_ref().map(|a| a.id.clone()),
        display: account
            .as_ref()
            .map(|a| a.display())
            .unwrap_or_else(|| lane.clone()),
        lane,
    })
}

/// The UI may offer primary explicitly; automatic fallback remains registry-only.
#[logged]
pub fn primary_tiers(engine: &Engine, org: &str) -> std::collections::HashSet<String> {
    catalog::TIERS
        .iter()
        .filter(|t| resolve(engine, org, t.tier, "primary").is_ok())
        .map(|t| t.tier.to_string())
        .collect()
}

/// Store the same pending system mail as `mail::system_wake`, inside the switch
/// transaction so a failed audit or mail write cannot discard the freeze replay.
/// The caller publishes and wakes only after commit.
#[logged]
pub(super) async fn queue_wake(
    tx: &tokio_postgres::Transaction<'_>,
    org: i64,
    agent: i64,
    name: &str,
    text: &str,
) -> Result<String> {
    let uid = crate::util::uid("m");
    let body = crate::util::pg_text(text).into_owned();
    let ev = crate::events::ordinary("@system", "system", false, &body);
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_agent_id, recipient_name,
                              kind, notice, body, attachments, ev, state)
         VALUES ($1, $2, '@system', 'agent', $3, $4, 'system', false, $5, '[]'::jsonb, $6, 'pending')",
        &[&uid, &org, &agent, &name, &body, &ev],
    ).await?;
    Ok(uid)
}
