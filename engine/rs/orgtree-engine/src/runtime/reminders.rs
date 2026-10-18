//! Automatic wakes ported from 3.x (user 4.0 sign-off 2026-10-07): the
//! working checkup, the idle-docket reminder and its blocked-docket option.
//! Each is a switch in App settings › Runtime.
//!
//! One task sweeps every org every 20 seconds (3.x `_auto_wake_keeper_pass`
//! on its WORKING_CACHE_POLL_S tick), in 3.x's order: the abandoned docket
//! recovery, then the docket reminder and the working checkup, then, with
//! checkups off, the cache keeper (`keepalive.rs`), so a reminder is sent
//! before a keepalive could take the agent. Per org it reads, in small
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

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::docket::{self, Agents};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::util::iso;

/// 3.x WORKING_CHECKUP_AFTER_S / IDLE_DOCKET_REMINDER_AFTER_S: more than this, not exactly.
const AFTER_S: i64 = 20 * 60;
/// How often the sweep runs (3.x WORKING_CACHE_POLL_S: a 4-minute
/// keepalive interval must not slip past a 5-minute cache).
const SWEEP_S: u64 = 20;
/// 3.x IDLE_DOCKET_REMINDER_MAX_ITEMS.
const MAX_ITEMS: usize = 20;
/// Bounds on the per-org reads.
const MAX_AGENTS: i64 = 5000;
const MAX_WORK: i64 = 5000;

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
            for org in engine.orgs.all() {
                let span = crate::trace::request(&format!("reminders:{}", org.slug));
                tracing::Instrument::instrument(tick_org(&engine, &org, sw), span).await;
            }
        }
    });
}

/// One org's automatic wakes for this tick, in 3.x's order. Recovery is
/// independent of the optional switches, as in the 3.x keeper.
#[logged]
async fn tick_org(engine: &Arc<Engine>, org: &Arc<OrgHandle>, sw: Switches) {
    if let Err(e) = crate::domain::docket::recover_abandoned(engine, org).await {
        tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "abandoned docket recovery failed; retry next pass");
    }
    if sw.checkups || sw.idle {
        if let Err(e) = sweep_org(engine, org, sw, false).await {
            tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "reminder sweep failed");
        }
    }
    // the checkup and the keeper are one switch's two modes
    if !sw.checkups {
        if let Err(e) = crate::runtime::keepalive::pass(engine, org).await {
            tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "cache keeper pass failed");
        }
    }
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
    /// un-acked mail it holds from projects in ack mode, as (mail id,
    /// project): it counts as working for the checkup (user 2026-10-18 08:04Z)
    held: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
struct WorkRow {
    slug: String,
    title: String,
    status: String,
    /// next-action recipient and the role it was reached by (`docket::next_recipient`)
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
async fn sweep_org(engine: &Arc<Engine>, org: &Arc<OrgHandle>, sw: Switches, early: bool) -> Result<()> {
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
              WHERE a.org_id = $1 AND a.state = 'live' AND a.kind = 'agent' AND a.halt IS NULL AND a.frozen IS NULL AND NOT a.limit_locked
                AND a.inflight_at IS NULL
                AND (NOT $3 OR coalesce(a.extra->>'session', 'session0') <> 'signed-in')
                AND NOT EXISTS (SELECT 1 FROM ot.turns t WHERE t.agent_id = a.id AND t.ended_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND m.recipient_agent_id = a.id
                                 AND (m.state = 'delivering' OR (m.state = 'pending' AND NOT m.notice)))
              ORDER BY a.id LIMIT $2",
            &[&org.id, &MAX_AGENTS, &early],
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
            held: Vec::new(),
        });
    }
    if agents.is_empty() {
        return Ok(());
    }
    for a in &mut agents {
        a.held = crate::domain::projects::held_by(&**client, a.id).await?;
    }
    // every agent but the deleted, for the reviewer's liveness and the owner's superior chain
    let everyone: Agents = client
        .query("SELECT name, id, state, parent_id FROM ot.agents WHERE org_id = $1 AND state <> 'deleted' LIMIT $2", &[&org.id, &MAX_AGENTS])
        .await?
        .iter()
        .map(|r| (r.get(0), (r.get(1), r.get(2), r.get(3))))
        .collect();
    let work: Vec<WorkRow> = client
        .query(
            "SELECT w.slug, w.title, w.status, w.owner, w.owner_agent_id, w.reviewer, w.reviewer_agent_id,
                    w.manual_attention IS NOT NULL,
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
            let owner: Option<Value> = r.get(3);
            let reviewer: Option<Value> = r.get(5);
            let (to, role) = docket::next_recipient(&status, owner.as_ref(), r.get(4), reviewer.as_ref(), r.get(6), &everyone);
            WorkRow { slug: r.get(0), title: r.get(1), status, to, role, attention: r.get::<_, bool>(7) || r.get::<_, bool>(8) }
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
        // 3.x `_working_cache_idle`: a turn, a wait for a slot or a running
        // cache keepalive defers the wake to a later sweep, nothing stamped
        if let Some(h) = engine.agents.get(a.id) {
            let v = h.view.load();
            if ["busy", "waiting", "cache_keepalive"].iter().any(|k| v[*k].as_bool() == Some(true)) {
                continue;
            }
        }
        let span = crate::trace::request_from(&crate::trace::agent_client(a.id, &a.name), crate::trace::current_rq().as_deref());
        // 3.x `work_docket_reminder_items` with the blocked option: purely additive
        let items: Vec<&WorkRow> = if !actionable.is_empty() || !sw.blocked || !all_blocked {
            actionable.clone()
        } else {
            work.iter().filter(|w| w.to.as_deref() == Some(a.name.as_str()) && w.status == "blocked").collect()
        };
        let (remind, check) = wakes(sw, early, a.working || !a.held.is_empty(), !items.is_empty());
        let wake = async {
            if remind && idle_reminder(engine, org, a, &items, now).await? {
                return Ok(());
            }
            if check {
                checkup(engine, org, a, now, early).await?;
            }
            anyhow::Ok(())
        };
        if let Err(e) = tracing::Instrument::instrument(wake, span.clone()).await {
            let _entered = span.enter();
            tracing::warn!(org = %org.slug, agent = %a.name, error = %format!("{e:#}"), "reminder failed");
        }
    }
    Ok(())
}

/// What the sweep tries for an idle agent, in this order: (the docket
/// reminder, the working checkup). 3.x `_auto_wake_keeper_pass`: the
/// reminder first, because it names the work; the checkup for an agent the
/// reminder passes over. Either one is waking mail, so nobody is woken twice.
/// User 2026-10-16: working checkups are independent of docket work. A due
/// docket reminder takes precedence and is a real wake. The sign-in sweep
/// (`early`, 2c) looks only at working agents.
#[logged]
fn wakes(sw: Switches, early: bool, working: bool, owes: bool) -> (bool, bool) {
    if early && !working {
        return (false, false);
    }
    (sw.idle && owes, sw.checkups && working)
}

/// The user signed in (`session_watch`; the user, 2026-10-16 12:12Z, 2c): a
/// working agent that sits idle with its last turn in Session 0 gets its
/// checkup now, not up to 20 minutes later, so its next turn runs in the
/// signed-in session. Docket work or not (the user, 10:01-10:03Z); a docket
/// reminder goes instead only if one is due at that moment (the
/// coordinator's correction, 13:03Z). The stamp it writes restarts its 20
/// minutes, so over time this adds no checkup. Nobody else is woken.
#[logged]
pub async fn checkups_at_sign_in(engine: &Arc<Engine>) {
    let sw = switches(engine);
    if !sw.checkups {
        return;
    }
    for org in engine.orgs.all() {
        if let Err(e) = sweep_org(engine, &org, sw, true).await {
            tracing::warn!(org = %org.slug, error = %format!("{e:#}"), "the sign-in checkups failed");
        }
    }
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
                AND NOT EXISTS (SELECT 1 FROM ot.mail m WHERE ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=m.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND m.recipient_agent_id = $1
                                 AND (m.state = 'delivering' OR (m.state = 'pending' AND NOT m.notice)))",
            &[&agent, &key, &iso(now)],
        )
        .await?;
    Ok(n == 1)
}

/// What a working checkup does now: (stamp the agent, send the checkup).
/// 3.x `_working_checkup_decision`: a missing anchor is only stamped, so a
/// never-active agent waits 20 minutes too, and a recent one waits; at
/// sign-in (`early`) it is sent at once.
#[logged]
fn checkup_now(activity: Option<DateTime<Utc>>, now: DateTime<Utc>, early: bool) -> (bool, bool) {
    if early {
        return (true, true);
    }
    match activity {
        None => (true, false),
        Some(t) if (now - t).num_seconds() <= AFTER_S => (false, false),
        _ => (true, true),
    }
}

/// 3.x `_working_checkup_decision` + `_working_checkup_reserve`.
#[logged]
async fn checkup(engine: &Arc<Engine>, org: &OrgHandle, a: &Agent, now: DateTime<Utc>, early: bool) -> Result<()> {
    let (stamp, send_now) = checkup_now(a.activity, now, early);
    if !stamp {
        return Ok(());
    }
    if !claim(engine, a.id, "working_activity_at", now).await? || !send_now {
        return Ok(());
    }
    let ev = crate::events::reminder_working_checkup(&org.slug, &a.name, a.generation as i64);
    send(engine, org.id, a, ev, held_note(&a.held)).await
}

/// What a checkup adds for an agent holding un-acked project mail: each
/// mail and how to ack it (user 2026-10-18 08:04Z).
#[nolog]
fn held_note(held: &[(String, String)]) -> Option<String> {
    if held.is_empty() {
        return None;
    }
    let lines: Vec<String> = held.iter()
        .map(|(id, p)| format!("- mail {id} from project {p}: ack it with orgtree_message to={p} reply_to={id} and a short completion record"))
        .collect();
    Some(format!("You hold project mail you have not acked yet, so its project hands you nothing more until you do:\n{}",
        lines.join("\n")))
}

/// 3.x `_idle_docket_reminder_decision` + its reservation body. True when
/// a reminder was due and claimed (sent, or withdrawn by a refused wake).
#[logged]
async fn idle_reminder(engine: &Arc<Engine>, org: &OrgHandle, a: &Agent, items: &[&WorkRow], now: DateTime<Utc>) -> Result<bool> {
    match a.activity.into_iter().chain(a.reminded).max() {
        None => {
            claim(engine, a.id, "docket_reminder_at", now).await?;
            return Ok(false);
        }
        Some(t) if (now - t).num_seconds() <= AFTER_S => return Ok(false),
        _ => {}
    }
    if !claim(engine, a.id, "docket_reminder_at", now).await? {
        return Ok(false);
    }
    let shown = &items[..items.len().min(MAX_ITEMS)];
    let rows: Vec<Value> =
        shown.iter().map(|w| json!({ "slug": w.slug, "title": w.title, "status": w.status, "role": w.role })).collect();
    let ev = crate::events::reminder_idle_docket(&org.slug, &a.name, a.generation as i64, rows, (items.len() - shown.len()) as i64);
    send(engine, org.id, a, ev, None).await?;
    Ok(true)
}

/// System mail whose body is the event's own text, the one the agent reads
/// (3.x stored `events.render_agent(ev)`), so the desk shows what was sent.
/// It wakes the agent only if it is idle (3.x `idle_only`): an automatic
/// wake never joins or queues behind real work. A refused wake withdraws the
/// mail (3.x `_auto_wake_cancel`); the stamp already written stays as the
/// cooldown.
#[logged]
async fn send(engine: &Arc<Engine>, org_id: i64, a: &Agent, ev: Value, extra: Option<String>) -> Result<()> {
    if let Some(pause) = crate::rig::reminder_pause() {
        tokio::time::sleep(pause).await;
    }
    let mut body = crate::runtime::event_text::render_agent(&ev).ok_or_else(|| anyhow::anyhow!("the reminder event has no text"))?;
    if let Some(x) = extra {
        body.push_str("\n\n");
        body.push_str(&x);
    }
    let mut out = Outgoing::new(From::System, &a.name, &body);
    out.kind = "system".into();
    out.ev = Some(ev);
    out.wake = false;
    let sent = mail::send(engine, org_id, out).await?;
    if crate::runtime::wake_idle(engine, org_id, a.id).await {
        return Ok(());
    }
    // a turn that already took it owns it
    let client = engine.db.get().await?;
    let withdrawn = client
        .execute("DELETE FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND uid = $1 AND recipient_agent_id = $2 AND state = 'pending'", &[&sent.uid, &a.id])
        .await?;
    drop(client);
    changes::notify_id(engine, org_id, vec![Change::Mailbox(a.id)]);
    tracing::info!(agent = %a.name, withdrawn, "automatic wake refused (the agent is not idle); its mail is withdrawn");
    Ok(())
}

#[cfg(test)]
mod checkup_tests {
    use super::*;

    /// The user, 2026-10-18 08:04Z: a checkup for an agent holding un-acked
    /// project mail names each mail and how to ack it; none without.
    #[test]
    fn a_held_mail_checkup_names_the_mail_and_the_ack() {
        assert_eq!(held_note(&[]), None);
        let note = held_note(&[("m1".into(), "q".into())]).unwrap();
        assert!(note.contains("mail m1 from project q"), "{note}");
        assert!(note.contains("orgtree_message to=q reply_to=m1"), "{note}");
    }

    /// The user, 2026-10-16 12:12Z (2c): at sign-in a working agent idle in
    /// Session 0 gets its checkup at once instead of up to 20 minutes later;
    /// otherwise 3.x's rule holds.
    #[test]
    fn a_sign_in_checkup_does_not_wait_out_the_20_minutes() {
        let now = Utc::now();
        let recent = Some(now - chrono::Duration::seconds(60));
        let old = Some(now - chrono::Duration::seconds(AFTER_S + 60));
        assert_eq!(checkup_now(None, now, false), (true, false), "never active: stamped, waits");
        assert_eq!(checkup_now(recent, now, false), (false, false));
        assert_eq!(checkup_now(old, now, false), (true, true));
        assert_eq!(checkup_now(recent, now, true), (true, true), "at sign-in: now");
        assert_eq!(checkup_now(None, now, true), (true, true));
    }

    const ON: Switches = Switches { checkups: true, idle: true, blocked: false };
    const OFF: Switches = Switches { checkups: false, idle: false, blocked: false };

    // wakes(switches, early, working, owes) -> (the docket reminder, the working checkup)

    /// The user, 2026-10-16 10:01-10:03Z: the working checkup is independent
    /// of docket work, and a due docket reminder takes precedence.
    #[test]
    fn a_working_agent_gets_its_checkup_without_docket_work() {
        assert_eq!(wakes(ON, false, true, false), (false, true));
        assert_eq!(wakes(ON, false, true, true), (true, true), "the reminder first, the checkup when it is not due");
        assert_eq!(wakes(ON, false, false, true), (true, false), "an idle owner is reminded");
    }

    /// The coordinator's correction of 2c (2026-10-16 13:03Z): at sign-in
    /// every working agent idle in Session 0 gets its checkup at once, docket
    /// work or not.
    #[test]
    fn the_sign_in_checkup_needs_no_docket_work() {
        assert_eq!(wakes(ON, true, true, false), (false, true));
    }

    /// The same correction: at sign-in a docket reminder goes instead only if
    /// one is due at that moment (`idle_reminder` decides; the checkup follows
    /// when it is not).
    #[test]
    fn a_due_docket_reminder_goes_first_at_sign_in() {
        assert_eq!(wakes(ON, true, true, true), (true, true));
    }

    /// The sign-in sweep looks only at working agents, and the switches hold.
    #[test]
    fn the_sign_in_sweep_wakes_only_working_agents() {
        assert_eq!(wakes(ON, true, false, true), (false, false));
        assert_eq!(wakes(OFF, true, true, true), (false, false));
        assert_eq!(wakes(OFF, false, true, true), (false, false));
    }
}
