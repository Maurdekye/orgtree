//! Which signed-in accounts an org may use (docket
//! per-org-account-allowlist-restrict-an-org-to-a-s, user 2026-10-10). An
//! org's settings carry `disabled_accounts`, the lanes switched OFF for it,
//! so a newly signed-in account is on for every org. A lane is named as the
//! usage board names it: a registry id (`claude-5`), a provider's own login
//! (`claude/primary`), `openrouter`, or `langserver:<server id>`.
//!
//! The sets live in memory (loaded at boot, replaced on every org settings
//! save) so the checks on every account choice stay synchronous and free.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use arc_swap::ArcSwap;
use serde_json::{json, Value};

use crate::accounts::AccountInfo;
use crate::engine::Engine;
use crate::providers::catalog;

/// The settings key: the lanes an org has switched off.
pub const KEY: &str = "disabled_accounts";
/// At most this many ids in one org's list.
pub const MAX_IDS: usize = 256;

type Sets = HashMap<String, HashSet<String>>;
static DISABLED: LazyLock<ArcSwap<Sets>> = LazyLock::new(|| ArcSwap::from_pointee(Sets::new()));

/// The ids in a settings value (anything else in it is ignored).
#[logged]
pub fn ids_of(v: &Value) -> HashSet<String> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).take(MAX_IDS).collect()
}

/// Read every org's list (at boot, and after a bulk change). Capped at
/// 10000 orgs with a list: past that, the rest load as "everything allowed"
/// until their settings are next saved (`set`).
#[logged]
pub async fn load(engine: &Engine) -> anyhow::Result<()> {
    let client = engine.db.get().await?;
    let rows = client
        .query("SELECT slug, settings -> 'disabled_accounts' FROM ot.orgs WHERE settings ? 'disabled_accounts' LIMIT 10000", &[])
        .await?;
    let mut sets = Sets::new();
    for r in rows {
        let ids = ids_of(&r.get::<_, Option<Value>>(1).unwrap_or(Value::Null));
        if !ids.is_empty() {
            sets.insert(r.get(0), ids);
        }
    }
    DISABLED.store(Arc::new(sets));
    Ok(())
}

/// One org's list changed (its settings were saved).
#[logged]
pub fn set(org_slug: &str, ids: HashSet<String>) {
    // compare-and-swap: two orgs saving at once must not drop each other's list
    DISABLED.rcu(|cur| {
        let mut sets: Sets = (**cur).clone();
        if ids.is_empty() {
            sets.remove(org_slug);
        } else {
            sets.insert(org_slug.to_string(), ids.clone());
        }
        sets
    });
}

/// May `org_slug` use the lane `lane`? `None` is the user's own app surface,
/// which may use everything. Called on every account choice: no logging.
#[nolog]
pub fn allowed(org_slug: Option<&str>, lane: &str) -> bool {
    match org_slug {
        None => true,
        Some(org) => DISABLED.load().get(org).is_none_or(|s| !s.contains(lane)),
    }
}

/// The lanes `org_slug` has switched off.
#[logged]
pub fn disabled(org_slug: &str) -> HashSet<String> {
    DISABLED.load().get(org_slug).cloned().unwrap_or_default()
}

/// A provider's own login, as the board names it.
#[nolog]
pub fn primary(provider: &str) -> String {
    format!("{provider}/primary")
}

/// The lane an unbound seat of `provider` runs on: the provider's own
/// login, or for OpenRouter the original key (`openrouter`).
#[nolog]
pub fn default_lane(provider: &str) -> String {
    if provider == catalog::OPENROUTER { crate::openrouter::LANE.to_string() } else { primary(provider) }
}

/// The lane a registry row is: the provider's own login for an ambient row,
/// an OpenRouter key's lane (`openrouter` for the original key, an added
/// key's id), else its id. The one mapping every lane consumer uses
/// (allowlists, the usage board, the usage tool).
#[nolog]
pub fn lane_of(a: &AccountInfo) -> String {
    if a.ambient {
        primary(&a.provider)
    } else if a.provider == catalog::OPENROUTER {
        crate::openrouter::lane(&a.id)
    } else {
        a.id.clone()
    }
}

/// The lane a seat on `tier` bound to `account` runs on, when that is not a
/// provider login: an OpenRouter tier its key's lane (the original key,
/// `openrouter`, when unbound), a language-server tier its server's. None
/// for a tier that runs on a provider account.
#[logged]
pub fn seat_lane(engine: &Engine, tier: &str, account: Option<&str>) -> Option<String> {
    if catalog::is_openrouter(tier) {
        return Some(crate::openrouter::lane(&crate::openrouter::seat_key(engine, account)));
    }
    tier_lane(engine, tier)
}

/// The lane an accountless tier runs on when no account is named:
/// OpenRouter's original key, or its language server's. None for a tier
/// that runs on a provider account.
#[logged]
pub fn tier_lane(engine: &Engine, tier: &str) -> Option<String> {
    if catalog::is_openrouter(tier) {
        return Some(crate::openrouter::LANE.to_string());
    }
    if catalog::is_langserver(tier) {
        let server = crate::langserver::route_of(engine, tier)
            .and_then(|(s, _)| s["id"].as_str().map(str::to_string))
            .unwrap_or_default();
        return Some(format!("langserver:{server}"));
    }
    None
}

/// Every lane an org could be given, with a label and whether `org_slug` may
/// use it: what the org settings section lists (`GET /api/orgs/{slug}/accounts-allowed`).
#[logged]
pub fn lanes(engine: &Engine, org_slug: &str) -> Vec<Value> {
    let off = disabled(org_slug);
    let view = engine.accounts.view();
    let mut out = Vec::new();
    // `allowed` is the org's own choice; `enabled` is whether the app may use
    // the lane at all (App settings › Providers), which an org tick cannot
    // override (user 2026-10-11 22:50), and `disabled_reason` says why not
    let mut push = |id: String, provider: &str, label: String, why_off: Option<&str>| {
        out.push(json!({ "id": id, "provider": provider, "label": label, "allowed": !off.contains(&id),
                         "enabled": why_off.is_none(), "disabled_reason": why_off }));
    };
    let provider_off = |p: &str| (!engine.settings.provider_enabled(p)).then_some("turned off in App settings › Providers");
    let muse = engine.providers.state.load().muse.installed;
    for provider in [catalog::CLAUDE, catalog::OPENAI, catalog::GOOGLE, catalog::MUSE] {
        if provider == catalog::MUSE && !muse && !view.all().into_iter().any(|a| a.provider == provider) {
            continue;
        }
        let why = provider_off(provider).or_else(|| (!engine.settings.subscription_inference(provider))
            .then_some("the signed-in subscription is inactive in App settings › Providers"));
        push(primary(provider), provider, format!("{} (default sign-in)", catalog::provider_label(provider)), why);
        for a in view.all().into_iter().filter(|a| a.provider == provider && !a.ambient && a.available_origin(org_slug)) {
            let why = provider_off(provider).or_else(|| (!a.enabled).then_some("this account is inactive in App settings › Providers"));
            push(a.id.clone(), provider, a.display(), why);
        }
    }
    // one tick per OpenRouter key (ruling 2026-10-11)
    let keys = crate::openrouter::keys(engine);
    for a in keys.iter().filter(|a| a.available_origin(org_slug)) {
        // a lone unnamed original key reads as it always did
        let label = if keys.len() == 1 && crate::openrouter::user_label(a).is_none() {
            "OpenRouter".to_string()
        } else {
            format!("OpenRouter: {} ({})", crate::openrouter::display(engine, a), crate::openrouter::lane(&a.id))
        };
        let why = provider_off(catalog::OPENROUTER).or_else(|| (!a.enabled).then_some("this key is inactive in App settings › Providers"));
        push(crate::openrouter::lane(&a.id), catalog::OPENROUTER, label, why);
    }
    for s in crate::langserver::servers(engine) {
        let id = s["id"].as_str().unwrap_or("").to_string();
        let label = s["label"].as_str().filter(|l| !l.is_empty()).unwrap_or(&id).to_string();
        let why = provider_off(catalog::LANGSERVER)
            .or_else(|| (s["enabled"].as_bool() == Some(false)).then_some("this server is turned off in App settings › Providers"));
        push(format!("langserver:{id}"), catalog::LANGSERVER, format!("{label} (language server)"), why);
    }
    out
}

/// The lanes of `provider` `org_slug` may use, for a refusal that names them.
#[logged]
pub fn allowed_of(engine: &Engine, org_slug: &str, provider: &str) -> Vec<String> {
    lanes(engine, org_slug).into_iter()
        .filter(|l| l["provider"] == provider && l["allowed"] == true)
        .filter_map(|l| l["id"].as_str().map(str::to_string))
        .collect()
}

/// The refusal text for a lane this org has switched off.
#[logged]
pub fn refusal(engine: &Engine, org_slug: &str, lane: &str, provider: &str) -> String {
    let ok = allowed_of(engine, org_slug, provider);
    if ok.is_empty() {
        format!("{lane} is not used by the org {org_slug}, and it allows no {} account (Org settings › Accounts)",
                catalog::provider_label(provider))
    } else {
        format!("{lane} is not used by the org {org_slug} (Org settings › Accounts); its {} accounts: {}",
                catalog::provider_label(provider), ok.join(", "))
    }
}

// ------------------------------------------------------------ agents on a lane switched off

/// The `cause` of a freeze for want of any allowed account.
pub const CAUSE: &str = "org_accounts";

/// The lane an agent of `org_slug` on `tier`/`account` would run its next
/// turn on, when the org has switched it off. None: it may go on.
#[logged]
pub fn barred(engine: &Engine, org_slug: &str, tier: &str, account: Option<&str>) -> Option<String> {
    let lane = match seat_lane(engine, tier, account) {
        Some(l) => l,
        None => match account.and_then(|id| engine.accounts.view().get(id).map(lane_of)) {
            Some(l) => l,
            // an unknown id is the other gates' business
            None if account.is_some() => return None,
            None => primary(catalog::provider_of(tier)),
        },
    };
    (!allowed(Some(org_slug), &lane)).then_some(lane)
}

/// Move an agent off a lane its org switched off, onto another account of
/// the same provider the org allows (one with proven room first, then any
/// that will take it, then the provider's own login); with none left it
/// freezes, saying so, until the org's list changes. Runs at its turn
/// boundary, before any mail is claimed: the mail waits for the next turn.
#[logged]
pub async fn leave(engine: &Arc<Engine>, org_id: i64, org_slug: &str, agent_id: i64, tier: &str, account: Option<&str>, lane: &str) {
    let why = "this org's account list (Org settings › Accounts)";
    // an OpenRouter seat moves between keys like any login; a language
    // server's seat has nowhere else to go
    if !catalog::is_langserver(tier) {
        let version = crate::runtime::freeze::muse_pin(engine, tier, agent_id).await;
        if let Some(to) = crate::runtime::freeze::pick_fallback(engine, tier, version.as_deref(), account, org_slug).await {
            if crate::runtime::freeze::continue_on(engine, org_id, agent_id, &to, why).await.is_ok() {
                return;
            }
        }
        let candidates = engine.accounts.view().continue_candidates(tier, account, org_slug);
        for to in candidates {
            if crate::runtime::freeze::continue_on(engine, org_id, agent_id, &to, why).await.is_ok() {
                return;
            }
        }
        let provider = catalog::provider_of(tier);
        if account.is_some() && allowed(Some(org_slug), &default_lane(provider)) {
            match to_primary(engine, org_id, agent_id, why).await {
                Ok(()) => return,
                Err(e) => tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "could not move the agent to the default sign-in"),
            }
        }
    }
    let error = if catalog::is_openrouter(tier) {
        format!("this org ({org_slug}) does not use the OpenRouter key {lane}, and it allows no other OpenRouter key this agent could run on; \
                 tick one in Org settings › Accounts (or move the agent to another tier)")
    } else if let Some(server) = lane.strip_prefix("langserver:") {
        format!("this org ({org_slug}) does not use the language server {server}; \
                 tick it in Org settings › Accounts (or move the agent to another tier)")
    } else {
        format!(
            "{lane} is not used by the org {org_slug}, and it allows no other {} account this agent could run on; \
             tick one in Org settings › Accounts (or move the agent to another tier)",
            catalog::provider_label(catalog::provider_of(tier))
        )
    };
    let rec = json!({ "at": crate::util::now_iso(), "until": null, "error": error, "limit": false, "cause": CAUSE,
                      "account": lane,
                      "wake_text": "Your org's account list now has an account for you. Continue where you left off." });
    let result = async {
        let client = engine.db.get().await?;
        Ok::<u64, anyhow::Error>(client.execute(
            "UPDATE ot.agents SET frozen = $2, row_version = row_version + 1 WHERE id = $1 AND state = 'live' AND frozen IS NULL",
            &[&agent_id, &rec],
        ).await?)
    }.await;
    match result {
        Ok(n) if n > 0 => {
            tracing::info!(agent = agent_id, lane, "no allowed account left for this agent: frozen");
            crate::changes::notify_id(engine, org_id, vec![crate::changes::Change::Agent(agent_id), crate::changes::Change::History(agent_id)]);
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "the agent could not be frozen for want of an allowed account"),
    }
}

/// Unbind an agent so it runs on its provider's own login.
#[logged]
async fn to_primary(engine: &Arc<Engine>, org_id: i64, agent_id: i64, why: &str) -> anyhow::Result<()> {
    let client = engine.db.get().await?;
    client.execute(
        "UPDATE ot.agents SET account = NULL, pending_account = NULL, row_version = row_version + 1 WHERE id = $1 AND state = 'live'",
        &[&agent_id],
    ).await?;
    client.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail)
         VALUES ($1, 'account_switch', '@engine', $2, jsonb_build_object('account', 'primary', 'why', $3::text))",
        &[&org_id, &agent_id, &why],
    ).await?;
    drop(client);
    if let Some(h) = engine.agents.get(agent_id) {
        h.send(crate::runtime::AgentMsg::Reconfigured);
    }
    crate::changes::notify_id(engine, org_id, vec![crate::changes::Change::Agent(agent_id), crate::changes::Change::Events]);
    Ok(())
}

/// The org's list changed: every agent frozen because nothing was left is
/// let go, and looks again at its next turn (it freezes again if still
/// nothing is allowed).
#[logged]
pub async fn recheck(engine: &Arc<Engine>, org_id: i64) {
    // bounded batches in id order until none are left; the cursor moves past
    // an agent that could not be released, so it is never read twice
    let mut after = 0i64;
    loop {
        let rows: anyhow::Result<Vec<tokio_postgres::Row>> = async {
            let c = engine.db.get().await?;
            Ok(c.query(
                "SELECT id, frozen FROM ot.agents WHERE org_id = $1 AND state = 'live' AND frozen ->> 'cause' = $2 AND id > $3
                 ORDER BY id LIMIT 500",
                &[&org_id, &CAUSE, &after],
            ).await?)
        }.await;
        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(org = org_id, error = %format!("{e:#}"), "agents frozen for want of an allowed account could not be read");
                return;
            }
        };
        let done = rows.len() < 500;
        for r in rows {
            let (id, rec): (i64, Value) = (r.get(0), r.get(1));
            after = id;
            if let Err(e) = crate::runtime::freeze::thaw_matching(engine, org_id, id, Some(&rec)).await {
                tracing::warn!(agent = id, error = %format!("{e:#}"), "could not release an agent frozen for want of an allowed account");
            }
        }
        if done {
            return;
        }
    }
}

/// The org's best allowed account for `tier` when its default login is
/// switched off (ruling 2026-10-10: an omitted account is auto-placed by the
/// balancing rule): a usable registry login of the provider, ordered by the
/// sooner-reset / lower-usage rule on the cached readings. Never a fetch.
#[logged]
pub fn best_allowed(engine: &Engine, org_slug: &str, tier: &str) -> Option<String> {
    let provider = catalog::provider_of(tier);
    let now = chrono::Utc::now();
    let view = engine.accounts.view();
    let usable: Vec<&AccountInfo> = view.all().into_iter()
        // every OpenRouter login is a key: those count here
        .filter(|a| a.provider == provider && !a.ambient && (!a.is_apikey() || provider == catalog::OPENROUTER)
            && a.available_to(Some(org_slug))
            && crate::accounts::active(engine, provider, Some(a))
            && a.auth != "signed_out" && a.auth != "unauthenticated"
            && a.limited_for(tier, now).is_none()
            && crate::usage::at_limit(engine, Some(a), tier).is_none())
        .collect();
    let order: Vec<String> = usable.iter().map(|a| a.id.clone()).collect();
    let readings: HashMap<String, crate::domain::templates::Reading> = usable.iter()
        .filter_map(|a| crate::usage::balance_reading(engine, Some(a), tier).map(|r| (a.id.clone(), r)))
        .collect();
    crate::domain::templates::balance(&order, &readings, now).into_iter().next()
}
