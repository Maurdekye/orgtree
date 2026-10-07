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

/// Seconds past the stated reset before an automatic wake (clock skew).
pub const WAKE_GRACE_S: i64 = 60;

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
async fn thaw_matching(engine: &Arc<Engine>, org_id: i64, agent_id: i64, expected: Option<&Value>) -> Result<bool> {
    let client = engine.db.get().await?;
    // One short statement. A timer for an older freeze can never erase a new
    // refusal, nor a manual clear followed by a new freeze.
    let row = client.query_opt(
        "UPDATE ot.agents SET frozen = NULL, limit_locked = false, row_version = row_version + 1
          WHERE id = $1 AND org_id = $2 AND frozen IS NOT NULL AND state = 'live'
            AND ($3::jsonb IS NULL OR frozen = $3)
          RETURNING name",
        &[&agent_id, &org_id, &expected],
    ).await?;
    drop(client);
    if row.is_none() {
        return Ok(false);
    }
    tracing::info!(org = org_id, agent = agent_id, automatic = expected.is_some(), "freeze released; waking agent");
    changes::notify_id(engine, org_id, vec![Change::Agent(agent_id), Change::History(agent_id)]);
    mail::system_wake(engine, org_id, agent_id, "Your usage limit has reset. Continue where you left off.").await?;
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
/// metered keys.
#[logged]
pub fn pick_fallback(engine: &Engine, provider: &str, current: Option<&str>) -> Option<String> {
    let view = engine.accounts.view();
    let subs = engine.settings.subscription_inference(provider);
    let keys = engine.settings.apikey_fallback(provider);
    let candidates = view.continue_candidates(provider, current);
    // the provider's own sign-in only while its checkbox is on (rows are
    // already filtered on their own)
    let sub = candidates.iter().find(|id| {
        view.get(id).map(|a| !a.is_apikey() && (subs || !crate::accounts::is_ambient(a))).unwrap_or(false)
    });
    let key = candidates.iter().find(|id| keys && view.get(id).map(|a| a.is_apikey()).unwrap_or(false));
    sub.or(key).cloned()
}

/// Move an agent to `account` and let its held work go on.
#[logged]
pub async fn continue_on(engine: &Arc<Engine>, org_id: i64, agent_id: i64, account: &str, why: &str) -> Result<Value> {
    let view = engine.accounts.view();
    let Some(acc) = view.get(account).cloned() else {
        crate::refuse!(NotFound, "no account {account}");
    };
    let client = engine.db.get().await?;
    let was = client
        .query_opt("SELECT frozen IS NOT NULL FROM ot.agents WHERE id = $1 AND state = 'live'", &[&agent_id])
        .await?;
    let Some(was) = was else {
        crate::refuse!(NotFound, "that agent is not live");
    };
    let was_frozen: bool = was.get(0);
    client
        .execute(
            "UPDATE ot.agents SET account = $2, pending_account = NULL, frozen = NULL, limit_locked = false,
                    row_version = row_version + 1
              WHERE id = $1",
            &[&agent_id, &account],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail)
             VALUES ($1, 'account_switch', '@engine', $2, jsonb_build_object('account', $3::text, 'why', $4::text))",
            &[&org_id, &agent_id, &account, &why],
        )
        .await?;
    drop(client);
    if let Some(h) = engine.agents.get(agent_id) {
        h.send(AgentMsg::Reconfigured);
    }
    changes::notify_id(engine, org_id, vec![Change::Agent(agent_id), Change::Credits, Change::Events, Change::History(agent_id)]);
    mail::system_wake(
        engine,
        org_id,
        agent_id,
        &format!("You now run on the account {}. Continue where you left off.", acc.display()),
    )
    .await?;
    Ok(json!({
        "switched": true, "resumed": true,
        "state": if was_frozen { "continued" } else { "switched_nothing_to_release" },
        "account": account, "status": "resumed",
    }))
}
