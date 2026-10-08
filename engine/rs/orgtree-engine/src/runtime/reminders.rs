//! Automatic wakes ported from 3.x (user 4.0 sign-off 2026-10-07): the
//! working checkup, the idle-docket reminder and its blocked-docket option.
//! Each is a switch in App settings › Runtime.
//!
//! One task sweeps every org once a minute. Per org it reads, in small
//! bounded queries, the live agents that could be woken (not halted, frozen,
//! limit-locked or mid-turn, no waking mail waiting, org not killswitched)
//! and the org's unfinished docket items. A notice is not waking mail: it
//! rides the next turn and never holds a wake back (3.x `waking_mail`). An agent is due when its last activity
//! (latest turn, latest status report, latest automatic wake) is more than
//! 20 minutes old. A due agent's stamp is written first, in one short
//! UPDATE that re-checks the gates, and then the reminder is sent as system
//! mail, which wakes it. The stamp is the cross-restart dedupe and the
//! cooldown, as in 3.x. Texts, timings, setting keys and defaults are the
//! 3.x engine's (dev: supervisor.py, ledger.py, appsettings.py).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::util::iso;

/// 3.x WORKING_CHECKUP_AFTER_S / IDLE_DOCKET_REMINDER_AFTER_S: more than this, not exactly.
const AFTER_S: i64 = 20 * 60;
/// How often the sweep runs.
const SWEEP_S: u64 = 60;
/// 3.x IDLE_DOCKET_REMINDER_MAX_ITEMS.
const MAX_ITEMS: usize = 20;
/// Bounds on the per-org reads.
const MAX_AGENTS: i64 = 5000;
const MAX_WORK: i64 = 5000;

const CHECKUP_TEXT: &str = "[AUTOMATIC 20-MINUTE WORKING-STATUS CHECK]\n\
You previously reported that you were working, but Orgtree has not woken you for 20 minutes. Check the actual work, files, \
processes, and messages. If useful work remains, make concrete progress now. Then report honestly with orgtree_status: use \
working only if work is still in progress, done if it is complete, or blocked if you truly cannot proceed. Do not claim that \
work is continuing without verifying it.";

const IDLE_HEAD: &str = "[AUTOMATIC IDLE DOCKET REMINDER]\n\
You have been idle for 20 minutes and these docket items are waiting on YOU for their next action:\n";

const IDLE_TAIL: &str = "\nPick the work back up: read each one with orgtree_work get, take the next concrete step, and leave an \
honest orgtree_work update. Assert review only if an item is really finished; blocked (with a blocked_reason naming what it is \
stuck on, who or what will unblock it, and how you will hear of it) if it truly cannot move. Items that are backlogged, blocked, \
or waiting on the user through an attention flag or an open question are deliberately not listed here — and nor is anything \
whose next action belongs to somebody else.";

/// 3.x IDLE_DOCKET_REMINDER_ROLE: why a row is on this agent's list.
fn role_note(role: &str) -> &'static str {
    match role {
        "deployer" => " — awaiting YOUR authorized deployment/publication action",
        "reviewer" => " — awaiting YOUR review",
        "unassigned_review" => " — NO REVIEWER NAMED: assign one, do not review your own work",
        "stale_reviewer" => " — its named reviewer is no longer live: name another, do not review your own work",
        _ => "",
    }
}

/// The three switches. Stored under the 3.x keys (an imported
/// app-settings.json keeps the user's choice); checkups and idle reminders
/// default on, blocked reminders default off (only an explicit true).
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Switches {
    pub checkups: bool,
    pub idle: bool,
    pub blocked: bool,
}

pub const KEY_CHECKUPS: &str = "working_checkups";
pub const KEY_IDLE: &str = "idle_docket_reminders";
pub const KEY_BLOCKED: &str = "blocked_docket_reminders_enabled";

#[logged]
pub fn switches(engine: &Engine) -> Switches {
    let s = engine.settings.get();
    let rt = s.get("runtime").cloned().unwrap_or_else(|| json!({}));
    Switches {
        checkups: rt.get(KEY_CHECKUPS).and_then(Value::as_bool) != Some(false),
        idle: rt.get(KEY_IDLE).and_then(Value::as_bool) != Some(false),
        blocked: rt.get(KEY_BLOCKED).and_then(Value::as_bool) == Some(true),
    }
}

#[logged]
pub fn start(engine: &Arc<Engine>) {
    start_recovery(engine);
    let engine = engine.clone();
    tokio::spawn(async move {
        let every = crate::rig::reminder_sweep_s().unwrap_or(SWEEP_S);
        let mut tick = tokio::time::interval(Duration::from_secs(every));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await; // the first tick is immediate: let startup settle
        loop {
            tokio::select! {
                _ = engine.shutdown.cancelled() => break,
                _ = tick.tick() => {}
            }
            let sw = switches(&engine);
            if !sw.checkups && !sw.idle {
                continue;
            }
            for org in engine.orgs.all() {
                let span = crate::trace::request(&format!("reminders:{}", org.slug));
                if let Err(e) = tracing::Instrument::instrument(sweep_org(&engine, &org, sw), span).await {
                    tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "reminder sweep failed");
                }
            }
        }
    });
}

#[derive(Debug)]
struct Agent {
    id: i64,
    name: String,
    generation: i32,
    working: bool,
    /// latest activity (turn, status report, checkup stamp)
    activity: Option<DateTime<Utc>>,
    /// latest idle reminder
    reminded: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct WorkRow {
    slug: String,
    title: String,
    status: String,
    /// next-action recipient and the role it was reached by (3.x `_work_next_recipient`)
    to: Option<String>,
    role: &'static str,
    /// manual attention flag or an open question attached
    attention: bool,
}

#[nolog]
fn stamp(v: &Value, key: &str) -> Option<DateTime<Utc>> {
    v.get(key).and_then(Value::as_str).and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc))
}

#[logged]
async fn sweep_org(engine: &Arc<Engine>, org: &Arc<OrgHandle>, sw: Switches) -> Result<()> {
    let client = engine.db.get().await?;
    let ks: Option<Value> = client.query_opt("SELECT killswitch FROM ot.orgs WHERE id = $1", &[&org.id]).await?.and_then(|r| r.get(0));
    if ks.is_some() {
        return Ok(());
    }
    let rows = client
        .query(
            "SELECT a.id, a.name, a.generation, a.last_status, a.extra,
                    (SELECT greatest(t.started_at, t.ended_at) FROM ot.turns t WHERE t.agent_id = a.id ORDER BY t.id DESC LIMIT 1)
               FROM ot.agents a
              WHERE a.org_id = $1 AND a.state = 'live' AND a.halt IS NULL AND a.frozen IS NULL AND NOT a.limit_locked
                AND a.inflight_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM ot.turns t WHERE t.agent_id = a.id AND t.ended_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = a.id
                                 AND (m.state = 'delivering' OR (m.state = 'pending' AND NOT m.notice)))
              ORDER BY a.id LIMIT $2",
            &[&org.id, &MAX_AGENTS],
        )
        .await?;
    let mut agents = Vec::with_capacity(rows.len());
    for r in &rows {
        let status: Option<Value> = r.get(3);
        let extra: Value = r.get(4);
        let turn: Option<DateTime<Utc>> = r.get(5);
        let status = status.unwrap_or(Value::Null);
        let activity = [turn, stamp(&status, "at"), stamp(&extra, "working_activity_at")].into_iter().flatten().max();
        agents.push(Agent {
            id: r.get(0),
            name: r.get(1),
            generation: r.get(2),
            working: status.get("status").and_then(Value::as_str) == Some("working"),
            activity,
            reminded: stamp(&extra, "docket_reminder_at"),
        });
    }
    if agents.is_empty() {
        return Ok(());
    }
    let live: HashMap<String, ()> = client
        .query("SELECT name FROM ot.agents WHERE org_id = $1 AND state = 'live' LIMIT $2", &[&org.id, &MAX_AGENTS])
        .await?
        .iter()
        .map(|r| (r.get::<_, String>(0), ()))
        .collect();
    let work: Vec<WorkRow> = client
        .query(
            "SELECT w.slug, w.title, w.status, w.owner->>'node', w.reviewer->>'node', w.manual_attention IS NOT NULL,
                    EXISTS (SELECT 1 FROM ot.asks k WHERE k.org_id = w.org_id AND k.status = 'open' AND w.slug = ANY (k.work_items))
               FROM ot.work_items w
              WHERE w.org_id = $1 AND w.archived_at IS NULL AND NOT coalesce((w.extra->>'deleted')::boolean, false)
                AND w.status NOT IN ('done', 'superseded', 'dropped', 'backlogged')
              ORDER BY w.slug LIMIT $2",
            &[&org.id, &MAX_WORK],
        )
        .await?
        .iter()
        .map(|r| {
            let status: String = r.get(2);
            let owner: Option<String> = r.get(3);
            let reviewer: Option<String> = r.get(4);
            let (to, role) = if status == "review" {
                match reviewer {
                    Some(rv) if live.contains_key(&rv) => (Some(rv), "reviewer"),
                    Some(_) => (owner, "stale_reviewer"),
                    None => (owner, "unassigned_review"),
                }
            } else {
                (owner, "owner")
            };
            WorkRow { slug: r.get(0), title: r.get(1), status, to, role, attention: r.get::<_, bool>(5) || r.get::<_, bool>(6) }
        })
        .collect();
    drop(client);
    // 3.x `work_org_all_blocked`: the org's whole nonterminal set is blocked (an empty set is not)
    let all_blocked = !work.is_empty() && work.iter().all(|w| w.status == "blocked");
    let now = Utc::now();
    for a in &agents {
        // 3.x `work_idle_reminder_items`: owed by this agent, not blocked, not waiting on the user
        let actionable: Vec<&WorkRow> =
            work.iter().filter(|w| w.to.as_deref() == Some(a.name.as_str()) && w.status != "blocked" && !w.attention).collect();
        if let Some(h) = engine.agents.get(a.id) {
            let v = h.view.load();
            if v["busy"].as_bool() == Some(true) || v["waiting"].as_bool() == Some(true) {
                continue;
            }
        }
        let span = crate::trace::request_from(&crate::trace::agent_client(a.id, &a.name), crate::trace::current_rq().as_deref());
        let result = if sw.checkups && a.working && !actionable.is_empty() {
            tracing::Instrument::instrument(checkup(engine, org, a, now), span.clone()).await
        } else if sw.idle {
            // 3.x `work_docket_reminder_items` with the blocked option: purely additive
            let items: Vec<&WorkRow> = if !actionable.is_empty() || !sw.blocked || !all_blocked {
                actionable
            } else {
                work.iter().filter(|w| w.to.as_deref() == Some(a.name.as_str()) && w.status == "blocked").collect()
            };
            if items.is_empty() {
                continue;
            }
            tracing::Instrument::instrument(idle_reminder(engine, org, a, &items, now), span.clone()).await
        } else {
            continue;
        };
        if let Err(e) = result {
            let _entered = span.enter();
            tracing::warn!(org = %org.slug, agent = %a.name, error = %format!("{e:#}"), "reminder failed");
        }
    }
    Ok(())
}

/// Write `key` = now on a still-wakeable agent; false when the gates changed
/// since the read (it was halted, frozen, started a turn, got waking mail).
#[logged]
async fn claim(engine: &Engine, agent: i64, key: &str, now: DateTime<Utc>) -> Result<bool> {
    let client = engine.db.get().await?;
    let n = client
        .execute(
            "UPDATE ot.agents SET extra = jsonb_set(extra, ARRAY[$2::text], to_jsonb($3::text)), row_version = row_version + 1
              WHERE id = $1 AND state = 'live' AND halt IS NULL AND frozen IS NULL AND NOT limit_locked AND inflight_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM ot.turns t WHERE t.agent_id = $1 AND t.ended_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = $1
                                 AND (m.state = 'delivering' OR (m.state = 'pending' AND NOT m.notice)))",
            &[&agent, &key, &iso(now)],
        )
        .await?;
    Ok(n == 1)
}

/// 3.x `_working_checkup_decision` + `_working_checkup_reserve`. A missing
/// anchor is stamped first, so a never-active agent waits 20 minutes too.
#[logged]
async fn checkup(engine: &Arc<Engine>, org: &OrgHandle, a: &Agent, now: DateTime<Utc>) -> Result<()> {
    match a.activity {
        None => {
            claim(engine, a.id, "working_activity_at", now).await?;
            return Ok(());
        }
        Some(t) if (now - t).num_seconds() <= AFTER_S => return Ok(()),
        _ => {}
    }
    if !claim(engine, a.id, "working_activity_at", now).await? {
        return Ok(());
    }
    let ev = crate::events::reminder_working_checkup(&org.slug, &a.name, a.generation as i64);
    send(engine, org.id, &a.name, CHECKUP_TEXT.to_string(), ev).await
}

/// 3.x `_idle_docket_reminder_decision` + its reservation body.
#[logged]
async fn idle_reminder(engine: &Arc<Engine>, org: &OrgHandle, a: &Agent, items: &[&WorkRow], now: DateTime<Utc>) -> Result<()> {
    match a.activity.into_iter().chain(a.reminded).max() {
        None => {
            claim(engine, a.id, "docket_reminder_at", now).await?;
            return Ok(());
        }
        Some(t) if (now - t).num_seconds() <= AFTER_S => return Ok(()),
        _ => {}
    }
    if !claim(engine, a.id, "docket_reminder_at", now).await? {
        return Ok(());
    }
    let shown = &items[..items.len().min(MAX_ITEMS)];
    let mut lines: Vec<String> =
        shown.iter().map(|w| format!("- {} ({}{}): {}", w.slug, w.status, role_note(w.role), w.title)).collect();
    if items.len() > shown.len() {
        lines.push(format!("- …and {} more item(s) waiting on you; orgtree_work list shows them all", items.len() - shown.len()));
    }
    let body = format!("{IDLE_HEAD}{}{IDLE_TAIL}", lines.join("\n"));
    let rows: Vec<Value> =
        shown.iter().map(|w| json!({ "slug": w.slug, "title": w.title, "status": w.status, "role": w.role })).collect();
    let ev = crate::events::reminder_idle_docket(&org.slug, &a.name, a.generation as i64, rows, (items.len() - shown.len()) as i64);
    send(engine, org.id, &a.name, body, ev).await
}

#[logged]
async fn send(engine: &Arc<Engine>, org_id: i64, to: &str, body: String, ev: Value) -> Result<()> {
    let mut out = Outgoing::new(From::System, to, &body);
    out.kind = "system".into();
    out.ev = Some(ev);
    mail::send(engine, org_id, out).await?;
    Ok(())
}

/// Recovery is independent of optional reminder switches, as in the 3.x keeper.
#[logged]
fn start_recovery(engine: &Arc<Engine>) {
    let engine = engine.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(20));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! { _ = engine.shutdown.cancelled() => break, _ = tick.tick() => {} }
            for org in engine.orgs.all() {
                if let Err(e) = crate::domain::docket::recover_abandoned(&engine, &org).await {
                    tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "abandoned docket recovery failed; retry next pass");
                }
            }
        }
    });
}
