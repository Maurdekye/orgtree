//! Usage-limit freezes: when a frozen agent wakes again (auto-resume), the
//! resume and unstick actions, and account fallback (a limited agent moving
//! to another account of the same provider).

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};

use crate::domain::mail;
use crate::engine::Engine;
use crate::feed::Key;
use crate::runtime::AgentMsg;
use crate::util::parse_ts;

/// Seconds past the stated reset before an automatic wake (clock skew).
pub const WAKE_GRACE_S: i64 = 60;

/// Arrange the automatic wake for a freeze record (if the org auto-resumes).
pub fn schedule(engine: &Arc<Engine>, org_id: i64, agent_id: i64, rec: &Value) {
    let Some(until) = rec["until"].as_str().and_then(parse_ts) else { return };
    let grace = if rec["connection"].as_bool().unwrap_or(false) { 0 } else { WAKE_GRACE_S };
    let wake = until + chrono::Duration::seconds(grace);
    let engine = engine.clone();
    tokio::spawn(async move {
        let wait = (wake - Utc::now()).to_std().unwrap_or(Duration::ZERO);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = engine.shutdown.cancelled() => return,
        }
        match auto_resume_on(&engine, org_id).await {
            Ok(true) => {
                if let Err(e) = thaw(&engine, org_id, agent_id, true).await {
                    tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "auto-resume failed");
                }
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "auto-resume check failed"),
        }
    });
}

async fn auto_resume_on(engine: &Engine, org_id: i64) -> Result<bool> {
    let client = engine.db.get().await?;
    let s: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let eff = crate::feed::groups::effective_settings(&s, &engine.settings.defaults());
    Ok(eff["auto_resume"].as_bool().unwrap_or(true))
}

/// Release one agent's freeze and wake it to continue. With `only_due`, a
/// freeze whose reset is still ahead (a newer freeze) is left alone.
pub async fn thaw(engine: &Arc<Engine>, org_id: i64, agent_id: i64, only_due: bool) -> Result<bool> {
    let client = engine.db.get().await?;
    let row = client
        .query_opt(
            "UPDATE ot.agents SET frozen = NULL, limit_locked = false, row_version = row_version + 1
              WHERE id = $1 AND frozen IS NOT NULL AND state = 'live'
                AND (NOT $2 OR coalesce((frozen->>'until')::timestamptz, now()) <= now())
              RETURNING name",
            &[&agent_id, &only_due],
        )
        .await?;
    drop(client);
    if row.is_none() {
        return Ok(false);
    }
    if let Some(org) = engine.orgs.by_id(org_id) {
        org.invalidate([Key::Agent(agent_id)]);
    }
    engine.app.org_changed(org_id);
    mail::system_wake(engine, org_id, agent_id, "Your usage limit has reset. Continue where you left off.").await?;
    Ok(true)
}

/// Every frozen agent of the org (the top bar's resume button).
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
pub async fn recover(engine: &Arc<Engine>) {
    let Ok(client) = engine.db.get().await else { return };
    let rows = client
        .query("SELECT id, org_id, frozen FROM ot.agents WHERE frozen IS NOT NULL AND state = 'live'", &[])
        .await
        .unwrap_or_default();
    for r in rows {
        schedule(engine, r.get(1), r.get(0), &r.get::<_, Value>(2));
    }
}

/// Another account of `provider` this agent could continue on, honoring the
/// API-key fallback and subscription switches: subscriptions first, then
/// metered keys.
pub fn pick_fallback(engine: &Engine, provider: &str, current: Option<&str>) -> Option<String> {
    let view = engine.accounts.view();
    let subs = engine.settings.subscription_inference(provider);
    let keys = engine.settings.apikey_fallback(provider);
    let candidates = view.continue_candidates(provider, current);
    let sub = candidates.iter().find(|id| subs && view.get(id).map(|a| !a.is_apikey()).unwrap_or(false));
    let key = candidates.iter().find(|id| keys && view.get(id).map(|a| a.is_apikey()).unwrap_or(false));
    sub.or(key).cloned()
}

/// Move an agent to `account` and let its held work go on.
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
    if let Some(org) = engine.orgs.by_id(org_id) {
        org.invalidate([Key::Agent(agent_id), Key::Group("audit"), Key::Events]);
    }
    engine.app.org_changed(org_id);
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
