//! The working cache keeper, ported from 3.x (supervisor.py
//! `_working_cache_keeper_pass`, `_working_cache_due`, `_working_cache_read`).
//! With working checkups switched off (App settings › Runtime), a
//! reported-working Claude agent's prompt cache is kept warm between turns:
//! when its last real request (a turn, or the last keepalive) is older than
//! its lane's interval, one billed, disposable read of its session prefix is
//! made. The read is the agent's real launch (same system prompt, tools and
//! settings, so the same cache key) on a fork of its session
//! (`--fork-session --max-turns 1`), so the prompt and the answer never enter
//! the agent's session; every tool it tries is denied. 3.x runs the checkup or
//! this keeper, never both.
//!
//! The pass runs in the automatic wakes' tick, after the docket reminder
//! (`reminders.rs`), and only finds candidates; the agent's actor decides and
//! runs the read (`Actor::start_keepalive`), because it owns the agent's
//! runtime state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::providers::catalog;
use crate::runtime::AgentMsg;

/// 3.x WORKING_CACHE_SUBSCRIPTION_S: a subscription turn gets the one-hour
/// cache tier; read again after 50 minutes (headroom for scheduling and start).
pub const SUBSCRIPTION_S: i64 = 3000;
/// 3.x WORKING_CACHE_API_KEY_S: an API-key turn gets five minutes; read after 4.
pub const API_KEY_S: i64 = 240;
/// 3.x WORKING_CACHE_TIMEOUT_S: a read that takes longer is killed.
pub const TIMEOUT_S: u64 = 180;
/// 3.x WORKING_CACHE_RETRY_BASE_S / _MAX_S: a failed read backs off, doubling.
const RETRY_BASE_S: u64 = 60;
const RETRY_MAX_S: u64 = 1800;
/// 3.x WORKING_CACHE_PROMPT.
pub const PROMPT: &str = "This is an automated prompt-cache keepalive. Reply with exactly OK and do not use tools.";
/// Bound on the per-org read.
const MAX_AGENTS: i64 = 5000;

/// How long a read waits after `failures` failed ones in a row.
#[logged]
fn retry_after(failures: u32) -> Duration {
    let doubled = RETRY_BASE_S.saturating_mul(1u64 << failures.saturating_sub(1).min(30));
    Duration::from_secs(doubled.min(RETRY_MAX_S))
}

/// Failed reads in a row and when the next may start, per agent (3.x
/// `_working_cache_retry`): kept here, not in the actor, because an idle
/// actor exits and must not forget its backoff.
#[nolog]
fn retries() -> &'static Mutex<HashMap<i64, (u32, Instant)>> {
    static RETRIES: OnceLock<Mutex<HashMap<i64, (u32, Instant)>>> = OnceLock::new();
    RETRIES.get_or_init(Default::default)
}

/// May this agent's next read start (no backoff pending)?
#[logged]
pub fn retry_due(agent: i64) -> bool {
    retries().lock().map(|m| m.get(&agent).map_or(true, |(_, at)| Instant::now() >= *at)).unwrap_or(true)
}

/// A read failed: back the next off, doubling (60 s up to 30 minutes).
/// Returns (failures in a row, the wait).
#[logged]
pub fn note_failure(agent: i64) -> (u32, Duration) {
    let Ok(mut m) = retries().lock() else { return (0, Duration::ZERO) };
    let failures = m.get(&agent).map_or(0, |(n, _)| *n) + 1;
    let wait = retry_after(failures);
    m.insert(agent, (failures, Instant::now() + wait));
    (failures, wait)
}

/// A read succeeded: no backoff.
#[logged]
pub fn clear_failure(agent: i64) {
    if let Ok(mut m) = retries().lock() {
        m.remove(&agent);
    }
}

/// 3.x `_working_cache_slots`: at most two reads at once on this machine.
#[logged]
pub fn slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(2))).clone()
}

/// Ask each due agent's actor: a live, reported-working Claude agent with a
/// session, not halted, frozen or limit-locked, no turn running, no
/// automatic wake waiting, and no request for its lane's interval.
#[logged]
pub async fn pass(engine: &Arc<Engine>, org: &Arc<OrgHandle>) -> Result<()> {
    let client = engine.db.get().await?;
    let ks: Option<Value> = client.query_opt("SELECT killswitch FROM ot.orgs WHERE id = $1", &[&org.id]).await?.and_then(|r| r.get(0));
    if ks.is_some() {
        return Ok(());
    }
    let rows = client
        .query(
            "SELECT a.id, a.tier, a.account, a.extra->>'cache_keepalive_at',
                    (SELECT greatest(t.started_at, t.ended_at) FROM ot.turns t WHERE t.agent_id = a.id ORDER BY t.id DESC LIMIT 1)
               FROM ot.agents a
              WHERE a.org_id = $1 AND a.state = 'live' AND a.halt IS NULL AND a.frozen IS NULL AND NOT a.limit_locked
                AND a.session_id IS NOT NULL AND a.last_status->>'status' = 'working'
                AND NOT EXISTS (SELECT 1 FROM ot.turns t WHERE t.agent_id = a.id AND t.ended_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = a.id AND m.state = 'pending'
                                   AND m.ev->>'variant' LIKE 'reminder.%')
              ORDER BY a.id LIMIT $2",
            &[&org.id, &MAX_AGENTS],
        )
        .await?;
    drop(client);
    let now = Utc::now();
    let accounts = engine.accounts.view();
    for r in rows {
        let (id, tier, account): (i64, String, Option<String>) = (r.get(0), r.get(1), r.get(2));
        if catalog::provider_of(&tier) != catalog::CLAUDE {
            continue;
        }
        let Some(last) = last_request(r.get::<_, Option<String>>(3).as_deref(), r.get(4)) else { continue };
        let apikey = account.as_deref().and_then(|a| accounts.get(a)).map(|a| a.is_apikey()).unwrap_or(false);
        if (now - last).num_seconds() < interval(apikey) || !retry_due(id) {
            continue;
        }
        crate::runtime::actor(engine, org.id, id).send(AgentMsg::CacheKeepalive);
    }
    Ok(())
}

/// 3.x `_working_cache_interval`: the lane that will bill the next request
/// decides how long its cache lives.
#[logged]
pub fn interval(apikey: bool) -> i64 {
    if apikey { API_KEY_S } else { SUBSCRIPTION_S }
}

/// 3.x `_working_cache_last_request`: the later of the last turn and the
/// last successful keepalive; None when neither ever happened.
#[logged]
pub fn last_request(keepalive_at: Option<&str>, turn: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    let kept = keepalive_at.and_then(crate::util::parse_ts);
    [kept, turn].into_iter().flatten().max()
}
