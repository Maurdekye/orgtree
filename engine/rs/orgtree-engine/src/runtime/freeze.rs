//! Usage-limit freezes: when a frozen agent wakes again (auto-resume), the
//! resume and unstick actions, and account fallback (a limited agent moving
//! to another account of the same provider).

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::domain::mail;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::runtime::AgentMsg;
use crate::util::{iso, parse_ts};

mod continuation;
pub use continuation::primary_tiers;

/// Seconds past the stated reset before an automatic wake (clock skew).
pub const WAKE_GRACE_S: i64 = 60;

/// The end of a replayed request kept in a freeze (3.x kept 8000 characters).
const REPLAY_CHARS: usize = 8000;

/// What a freeze keeps of the request it replays: its last characters.
#[logged]
pub fn replay_tail(text: &str) -> String {
    let n = text.chars().count();
    text.chars().skip(n.saturating_sub(REPLAY_CHARS)).collect()
}

/// The wake for a released freeze, followed by the request the freeze holds
/// (3.x `resume_texts`: a Codex or Antigravity turn refused for a usage limit
/// is given again, and so is what an imported 3.x freeze kept).
#[logged]
pub fn with_replay(wake: &str, rec: Option<&Value>) -> String {
    let mut texts: Vec<&str> = rec
        .and_then(|r| r["resume_texts"].as_array())
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    texts.retain(|t| !t.trim().is_empty());
    if texts.is_empty() {
        return wake.to_string();
    }
    format!("{wake}\n\nThe turn that was stopped got no answer. It was given:\n\n{}", texts.join("\n\n"))
}

/// Read canonical Rust timestamps or the numeric deadlines kept by 2.x/3.x.
/// Legacy `until` is a display label, never a timestamp. A committed wake is
/// valid only for the until_ts/reset_src pair for which it was promised.
#[logged]
pub fn deadline(rec: &Value) -> Option<DateTime<Utc>> {
    if let Some(until) = rec["until"].as_str().and_then(parse_ts) {
        return Some(until);
    }
    let wake = &rec["wake"];
    if wake.is_object()
        && wake["of_ts"].as_f64() == rec["until_ts"].as_f64()
        && wake["of_src"].as_str().unwrap_or("") == rec["reset_src"].as_str().unwrap_or("")
    {
        if let Some(ts) = epoch(&wake["ts"]) {
            return Some(ts);
        }
    }
    epoch(&rec["until_ts"])
}

#[logged]
fn epoch(value: &Value) -> Option<DateTime<Utc>> {
    let ts = value.as_f64()?;
    if !ts.is_finite() || ts <= 0.0 || ts >= i64::MAX as f64 {
        return None;
    }
    DateTime::from_timestamp(ts.floor() as i64, (ts.fract() * 1_000_000_000.0) as u32)
}

/// New imports use the Rust timestamp shape. Runtime readers also accept the
/// old shape so an already imported agent needs no live-data repair.
#[logged]
pub fn normalize(mut rec: Value) -> Value {
    if rec["until"].as_str().and_then(parse_ts).is_none() {
        if let Some(until) = deadline(&rec) {
            rec["until"] = json!(iso(until));
        }
    }
    rec
}

#[logged]
pub fn wake_at(rec: &Value) -> Option<DateTime<Utc>> {
    let grace = if rec["connection"].as_bool().unwrap_or(false) { 0 } else { WAKE_GRACE_S };
    deadline(rec)?.checked_add_signed(chrono::Duration::seconds(grace))
}

/// Arrange a wake for this exact freeze. A replacement owns its own timer.
#[logged]
pub fn schedule(engine: &Arc<Engine>, org_id: i64, agent_id: i64, name: &str, rec: &Value) {
    let Some(wake) = wake_at(rec) else {
        tracing::info!(org = org_id, agent = agent_id, "freeze not scheduled: no valid reset deadline; manual unstick required");
        return;
    };
    if matches!(rec["cause"].as_str(), Some("auth" | "balance")) {
        tracing::info!(org = org_id, agent = agent_id, "freeze not scheduled: authentication or balance needs manual action");
        return;
    }
    tracing::info!(org = org_id, agent = agent_id, wake = %iso(wake), overdue = wake <= Utc::now(),
                   "freeze wake scheduled");
    let expected = rec.clone();
    let engine = engine.clone();
    let span = crate::trace::request_from(&crate::trace::agent_client(agent_id, name), crate::trace::current_rq().as_deref());
    tokio::spawn(tracing::Instrument::instrument(async move {
        let mut wait = (wake - Utc::now()).to_std().unwrap_or(Duration::ZERO);
        let mut reported_off = false;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = engine.shutdown.cancelled() => return,
            }
            match resume_scheduled(&engine, org_id, agent_id, &expected).await {
                Ok(true) => return,
                Ok(false) => {
                    if !reported_off {
                        tracing::info!(org = org_id, agent = agent_id,
                            "freeze reset is due but auto-resume is off; rechecking in 30 seconds");
                        reported_off = true;
                    }
                }
                Err(e) => tracing::warn!(org = org_id, agent = agent_id, error = %format!("{e:#}"),
                                        "freeze wake failed; retrying in 30 seconds"),
            }
            // A disabled setting or transient database error must not consume
            // the only timer. No connection is held during this wait.
            wait = Duration::from_secs(30);
        }
    }, span));
}

#[logged]
pub(super) async fn auto_resume_on(engine: &Engine, org_id: i64) -> Result<bool> {
    let client = engine.db.get().await?;
    let s: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let eff = crate::feed::groups::effective_settings(&s, &engine.settings.defaults());
    Ok(eff["auto_resume"].as_bool().unwrap_or(true))
}

/// True means this timer is finished; false retains a due freeze behind the
/// auto-resume setting. As in 3.x, only a pure connection retry bypasses it.
#[logged]
async fn resume_scheduled(engine: &Arc<Engine>, org_id: i64, agent_id: i64, expected: &Value) -> Result<bool> {
    let client = engine.db.get().await?;
    let row = client.query_opt(
        "SELECT frozen FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live'",
        &[&agent_id, &org_id],
    ).await?;
    drop(client);
    let current: Option<Value> = row.and_then(|r| r.get(0));
    if current.as_ref() != Some(expected) {
        return Ok(true);
    }
    let connection = expected["connection"].as_bool().unwrap_or(false)
        && !expected["limit"].as_bool().unwrap_or(false);
    if !connection && !auto_resume_on(engine, org_id).await? {
        return Ok(false);
    }
    thaw_matching(engine, org_id, agent_id, Some(expected)).await?;
    Ok(true)
}

/// Manual unstick ignores the horizon. Automatic callers check it in Rust,
/// including legacy records and clock-skew grace, then compare-and-clear.
#[logged]
pub async fn thaw(engine: &Arc<Engine>, org_id: i64, agent_id: i64, only_due: bool) -> Result<bool> {
    if !only_due {
        return thaw_matching(engine, org_id, agent_id, None).await;
    }
    let client = engine.db.get().await?;
    let row = client.query_opt("SELECT frozen FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live'",
                               &[&agent_id, &org_id]).await?;
    drop(client);
    let rec: Option<Value> = row.and_then(|r| r.get(0));
    let Some(rec) = rec else { return Ok(false) };
    if !wake_at(&rec).map(|t| t <= Utc::now()).unwrap_or(false) {
        return Ok(false);
    }
    thaw_matching(engine, org_id, agent_id, Some(&rec)).await
}

#[logged]
pub async fn thaw_matching(engine: &Arc<Engine>, org_id: i64, agent_id: i64, expected: Option<&Value>) -> Result<bool> {
    let client = engine.db.get().await?;
    // One short statement. A timer for an older freeze can never erase a new
    // refusal, nor a manual clear followed by a new freeze.
    let row = client.query_opt(
        "WITH old AS (SELECT frozen FROM ot.agents WHERE id = $1)
         UPDATE ot.agents a SET frozen = NULL, limit_locked = false, row_version = row_version + 1
           FROM old
          WHERE a.id = $1 AND a.org_id = $2 AND a.frozen IS NOT NULL AND a.state = 'live'
            AND ($3::jsonb IS NULL OR a.frozen = $3)
          RETURNING old.frozen",
        &[&agent_id, &org_id, &expected],
    ).await?;
    drop(client);
    let Some(row) = row else { return Ok(false) };
    let old: Value = row.get::<_, Option<Value>>(0).unwrap_or(Value::Null);
    // a connection retry (parity P34) is neither a limit reset nor an unstick
    let retry = expected.is_some() && old["connection"].as_bool().unwrap_or(false) && !old["limit"].as_bool().unwrap_or(false);
    tracing::info!(org = org_id, agent = agent_id, automatic = expected.is_some(), retry, "freeze released; waking agent");
    changes::notify_id(engine, org_id, vec![Change::Agent(agent_id), Change::History(agent_id)]);
    if !retry {
        if let Err(e)=crate::domain::runtime_notices::released(engine, org_id, agent_id, expected.is_some()).await {
            tracing::warn!(agent=agent_id,error=%format!("{e:#}"),"release notice could not be sent");
        }
    }
    let text = match old["wake_text"].as_str() {
        // the freeze's own wake (a retry, a balance probe) when automatic
        Some(t) if expected.is_some() => t.to_string(),
        _ if expected.is_some() => "Your usage limit has reset. Continue where you left off.".to_string(),
        _ => "Your hold was released. Continue where you left off.".to_string(),
    };
    mail::system_wake(engine, org_id, agent_id, &with_replay(&text, Some(&old))).await?;
    Ok(true)
}

/// Every frozen agent of the org (the top bar's resume button).
#[logged]
pub async fn resume_org(engine: &Arc<Engine>, org_id: i64) -> Result<Vec<String>> {
    let client = engine.db.get().await?;
    let rows = client
        .query("SELECT id, name FROM ot.agents WHERE org_id = $1 AND state = 'live' AND frozen IS NOT NULL", &[&org_id])
        .await?;
    drop(client);
    let mut out = Vec::new();
    for r in rows {
        if thaw(engine, org_id, r.get(0), false).await? {
            out.push(r.get(1));
        }
    }
    Ok(out)
}

/// After a restart: re-arm the automatic wakes.
#[logged]
pub async fn recover(engine: &Arc<Engine>) {
    let mut after = 0_i64;
    let mut total = 0_usize;
    loop {
        let rows = async {
            let client = engine.db.get().await?;
            Ok::<_, anyhow::Error>(client.query(
                "SELECT id, org_id, frozen, name FROM ot.agents WHERE frozen IS NOT NULL AND state = 'live'
                  AND id > $1 ORDER BY id LIMIT 256", &[&after],
            ).await?)
        }.await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "freeze recovery failed");
                return;
            }
        };
        if rows.is_empty() { break; }
        for r in rows {
            after = r.get(0);
            total += 1;
            let name: String = r.get(3);
            let span = crate::trace::request_from(&crate::trace::agent_client(after, &name), crate::trace::current_rq().as_deref());
            let _entered = span.enter();
            schedule(engine, r.get(1), after, &name, &r.get::<_, Value>(2));
        }
    }
    tracing::info!(frozen_agents = total, "freeze recovery finished");
}

/// Another account of `provider` this agent could continue on, honoring the
/// API-key fallback and subscription switches: subscriptions first, then
/// metered keys. `version` is the seat's pinned model version (`muse_pin`).
/// `own_login`: a limit move, which may also take Muse's own login (see
/// `muse_primary_takes`); the org account-list move keeps its own order.
#[logged]
pub async fn pick_fallback(engine: &Engine, tier: &str, version: Option<&str>, current: Option<&str>, org_slug: &str,
    own_login: bool) -> Option<String> {
    let provider = crate::providers::catalog::provider_of(tier);
    let view = engine.accounts.view();
    let subs = engine.settings.subscription_inference(provider);
    let keys = engine.settings.apikey_fallback(provider);
    let candidates = view.continue_candidates(tier, current, org_slug);
    // the provider's own sign-in only while its checkbox is on (rows are
    // already filtered on their own); a move nobody asked for needs proof of
    // room in the login's reading (3.x `account_fallback.capacity`)
    for id in &candidates {
        // every OpenRouter login is a key, read like a subscription's room
        let Some(a) = view.get(id)
            .filter(|a| (!a.is_apikey() || a.provider == crate::providers::catalog::OPENROUTER) && (subs || !crate::accounts::is_ambient(a)))
            .cloned() else { continue };
        // a slow or hung provider proves nothing: that login is skipped
        if tokio::time::timeout(FALLBACK_READ, crate::usage::registered(engine, &a, false)).await.is_err() {
            tracing::info!(account = %a.id, tier, "account fallback: the usage read timed out; no proven room");
            continue;
        }
        // a Muse login must itself offer the tier's model (its own catalog,
        // never the user's own login's: user 2026-10-12 19:57Z)
        let offers = provider != crate::providers::catalog::MUSE || muse_login_offers(engine, &a, tier, version, org_slug).await;
        if offers && crate::usage::has_room(engine, Some(&a), tier)
            && continuation::resolve(engine, org_slug, tier, &a.id).is_ok() {
            return Some(a.id);
        }
        tracing::info!(account = %a.id, tier, "account fallback: no eligible proven room on this login");
    }
    // Muse's own login: Claude's or Codex's own login is a candidate above as
    // an ambient registry row (its default home registered), but a Muse login
    // is two roots Muse lays out itself and is never a row. So for an agent on
    // a registered Muse login (never one already on its own login), it is
    // asked here: after the registered subscriptions, before any key, under
    // the same subscription switch, with proven room (lead 2026-10-13 06:50Z)
    if own_login && provider == crate::providers::catalog::MUSE && current.is_some() && subs
        && muse_primary_takes(engine, tier, version, org_slug, true).await
    {
        return Some(crate::org_accounts::primary(provider));
    }
    if !keys {
        return None;
    }
    for id in &candidates {
        let Some(a) = view.get(id).filter(|a| a.is_apikey()).cloned() else { continue };
        if continuation::resolve(engine, org_slug, tier, id).is_err() {
            continue;
        }
        // nor is a Muse key's entitlement ever assumed: the key is asked itself
        if provider == crate::providers::catalog::MUSE && !muse_login_offers(engine, &a, tier, version, org_slug).await {
            tracing::info!(account = %a.id, tier, "account fallback: this Muse API key does not offer the tier's model, or could not be read");
            continue;
        }
        return Some(id.clone());
    }
    None
}

/// Whether a Muse login's own catalog offers the model the seat runs
/// (`tier` at its pinned `version`), read within the fallback's limit: a
/// profile in its own roots, an API key with its own stored key. Entitlement
/// is never borrowed from another login nor assumed for a key (user
/// 2026-10-12 19:57Z). Not logged: it handles the key.
#[nolog]
pub(crate) async fn muse_login_offers(engine: &Engine, a: &crate::accounts::AccountInfo, tier: &str, version: Option<&str>,
    org_slug: &str) -> bool {
    let key = if a.is_apikey() {
        let Some(key) = crate::providers::muse_stored_key(engine, &a.id, org_slug).await else { return false };
        Some(key)
    } else {
        None
    };
    let model = crate::providers::catalog::model_for(tier, version);
    matches!(
        tokio::time::timeout(FALLBACK_READ, crate::providers::muse_model_for(engine, Some(a), key.as_deref(), &model)).await,
        Ok(Ok(Some(_)))
    )
}

/// Whether `account` passes the shared continuation checks for `tier` in
/// `org_slug` now (org list, switches, sign-in, marks, usage), without
/// moving anything: what a forced move (an account's removal) offers.
#[logged]
pub fn eligible(engine: &Engine, org_slug: &str, tier: &str, account: &str) -> bool {
    continuation::resolve(engine, org_slug, tier, account).is_ok()
}

/// Whether the user's own Muse login may take a seat moved off another
/// login: its own catalog offers the seat's exact model (pin included) and
/// every continuation gate passes for `muse/primary` (the org's account
/// list, provider and login activation, sign-in, re-authentication, marks,
/// a full window). With `room`, a move nobody asked for, its own reading
/// must also prove room: an unknown reading is never room. The reading is
/// taken first, so the gates judge the same reading the room proof does.
#[logged]
pub(crate) async fn muse_primary_takes(engine: &Engine, tier: &str, version: Option<&str>, org_slug: &str, room: bool) -> bool {
    let primary = crate::org_accounts::primary(crate::providers::catalog::MUSE);
    if room && tokio::time::timeout(FALLBACK_READ, crate::usage::muse(engine, &primary, None, false)).await.is_err() {
        tracing::info!(tier, "account fallback: Muse's own login's usage read timed out; no proven room");
        return false;
    }
    let model = crate::providers::catalog::model_for(tier, version);
    if engine.providers.muse_model(&model).is_none() {
        tracing::info!(tier, model = %model, "Muse's own login does not offer the seat's model");
        return false;
    }
    if let Err(e) = continuation::resolve(engine, org_slug, tier, &primary) {
        tracing::info!(tier, why = %format!("{e:#}"), "Muse's own login cannot take the seat");
        return false;
    }
    if room && !crate::usage::has_room(engine, None, tier) {
        tracing::info!(tier, "account fallback: no proven room on Muse's own login");
        return false;
    }
    true
}

/// The model version a Muse seat is pinned to (its scope's `model_version`),
/// so a fallback asks a login for the exact model the seat runs (Spark 1.2
/// is not Spark 1.3). None for other providers: their fallback does not ask
/// a login's catalog.
#[logged]
pub async fn muse_pin(engine: &Engine, tier: &str, agent_id: i64) -> Option<String> {
    if crate::providers::catalog::provider_of(tier) != crate::providers::catalog::MUSE {
        return None;
    }
    let client = engine.db.get().await.ok()?;
    let row = client.query_opt("SELECT scope FROM ot.agents WHERE id = $1", &[&agent_id]).await.ok()??;
    crate::domain::scope::normalize(&row.get::<_, Value>(0)).get("model_version").and_then(Value::as_str).map(str::to_string)
}

/// The longest one login's usage read may take when the fallback asks it.
const FALLBACK_READ: Duration = Duration::from_secs(5);

/// An opted-in agent frozen by a usage limit moves to another account with
/// proven room, its held request going with it; without one it stays frozen.
/// Runs off the agent's actor, after its turn is settled.
#[logged]
pub async fn fall_back(engine: &Arc<Engine>, org_id: i64, agent_id: i64, tier: &str, current: Option<&str>, org_slug: &str) {
    let version = muse_pin(engine, tier, agent_id).await;
    let Some(acc) = pick_fallback(engine, tier, version.as_deref(), current, org_slug, true).await else {
        tracing::info!(agent = agent_id, tier, "account fallback: no other account can take it; it stays frozen");
        return;
    };
    if let Err(e) = continue_on(engine, org_id, agent_id, &acc, "account fallback").await {
        tracing::warn!(agent = agent_id, account = %acc, error = %format!("{e:#}"), "account fallback failed; it stays frozen");
    }
}

/// Move an agent to `account` and let its held work go on (with the request
/// its freeze held).
#[logged]
pub async fn continue_on(engine: &Arc<Engine>, org_id: i64, agent_id: i64, account: &str, why: &str) -> Result<Value> {
    let Some(org) = engine.orgs.by_id(org_id) else {
        crate::refuse!(NotFound, "no such org");
    };
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let was = tx
        .query_opt("SELECT frozen, tier, account, name FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' FOR UPDATE", &[&agent_id, &org_id])
        .await?;
    let Some(was) = was else {
        crate::refuse!(NotFound, "that agent is not live");
    };
    let old: Option<Value> = was.get(0);
    let tier: String = was.get(1);
    let previous: Option<String> = was.get(2);
    let name: String = was.get(3);
    let was_frozen = old.is_some();
    let target = continuation::resolve(engine, &org.slug, &tier, account)?;
    let provider = crate::providers::catalog::provider_of(&tier);
    let previous_lane = previous.as_deref().and_then(|a| engine.accounts.view().get(a).map(crate::org_accounts::lane_of))
        .unwrap_or_else(|| crate::org_accounts::default_lane(provider));
    let namespace_changed = previous_lane != target.lane;
    let account_id = target.binding.as_deref().unwrap_or(&target.lane);
    tx
        .execute(
            "UPDATE ot.agents SET account = $2, pending_account = NULL, frozen = NULL, limit_locked = false,
                    row_version = row_version + 1
              WHERE id = $1",
            &[&agent_id, &target.binding],
        )
        .await?;
    tx
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail)
             VALUES ($1, 'account_switch', '@engine', $2, jsonb_build_object('account', $3::text, 'why', $4::text,
                     'previous_account', $5::text, 'cache_namespace_changed', $6::boolean))",
            &[&org_id, &agent_id, &account_id, &why, &previous_lane, &namespace_changed],
        )
        .await?;
    let wake_text = with_replay(&format!("You now run on the account {}. {}Continue where you left off.", target.display,
        if namespace_changed { "This account switch starts a new provider cache namespace. " } else { "" }), old.as_ref());
    let wake_uid = continuation::queue_wake(&tx, org_id, agent_id, &name, &wake_text).await?;
    tx.commit().await?;
    drop(client);
    if let Some(h) = engine.agents.get(agent_id) {
        h.send(AgentMsg::Reconfigured);
    }
    changes::notify_id(engine, org_id, vec![Change::Agent(agent_id), Change::Credits, Change::Events, Change::History(agent_id),
        Change::Mailbox(agent_id), Change::Spark { from: "@system".into(), to: name },
        Change::EngineEvent(crate::runtime::watchdogs::events::event("mail.waiting",
            crate::runtime::watchdogs::events::Scope::Agent(org_id, agent_id), json!({"agent_id":agent_id,"mail_id":wake_uid}))) ]);
    crate::runtime::wake(engine, org_id, agent_id);
    Ok(json!({
        "switched": true, "resumed": true,
        "state": if was_frozen { "continued" } else { "switched_nothing_to_release" },
        "account": account_id, "status": "resumed", "cache_namespace_changed": namespace_changed,
    }))
}
