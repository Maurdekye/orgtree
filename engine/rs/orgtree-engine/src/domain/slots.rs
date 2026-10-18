//! Project slots (docket project-slots-first-come-permits-claimed-through;
//! user 2026-10-18 08:37Z-08:43Z): a project with a slot count N gives out N
//! permits, first come first served, for work only N agents may do at once
//! (a heavy build). An agent claims with a one-shot `slot` watchdog on the
//! project: with a slot free it is granted at once and the dog fires;
//! otherwise the armed dog is its place in the line and fires when it is
//! granted. A lease (`ot.slot_leases`) is one held slot; ended leases are the
//! history. Release is explicit (`orgtree_project action=release_slot`).
//! Reclaim reuses the mail queue's ack-mode machinery: a retired or halted
//! holder loses its slot at once, and an idle holder gets the 20-minute
//! checkup up to 3 times, then the slot is taken back (only while that
//! checkup and the project's ack-timeout setting are on).
//!
//! Only agents above or below the project may claim (the mail queue's reach
//! rule). The line is strictly first-come: armed `slot` dogs ordered by
//! `memo.queued_at`, which a resume resets (back of the line).

use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::util::{iso, uid};

/// The watchdog kind that claims a slot.
pub const KIND: &str = "slot";
/// Checkup wakes an idle holder gets before its slot is taken back (as an
/// un-acked mail's, `projects::ACK_WAKES`).
pub const IDLE_WAKES: i32 = 3;
/// The largest slot count a project may have.
pub const MAX_CAPACITY: i64 = 64;

/// A project's slot count (`scope.slots_capacity`; 0, the default, is no
/// slots: user 2026-10-18 08:42Z).
#[nolog]
pub fn capacity(scope: &Value) -> i64 {
    scope.get("slots_capacity").and_then(Value::as_i64).filter(|n| (0..=MAX_CAPACITY).contains(n)).unwrap_or(0)
}

/// The lowest slot numbers (1-based) not in `held`, up to `capacity`.
#[nolog]
pub fn free_slots(capacity: i64, held: &[i32]) -> Vec<i32> {
    (1..=capacity as i32).filter(|n| !held.contains(n)).collect()
}

/// A grant made by `grant`, fired after its transaction commits.
#[derive(Debug, Clone)]
struct Granted {
    dog: i64,
    owner: i64,
    lease: String,
    slot: i32,
    project: String,
}

/// The grant line a slot dog fires with.
#[nolog]
fn grant_line(project: &str, slot: i32, lease: &str) -> String {
    format!("You now hold slot {slot} of project {project} (lease {lease}). Release it as soon as the work that needs it \
             ends: orgtree_project action=release_slot lease={lease}. Until you do, nobody else in line gets it. If that tool is missing, your CLI has an old startup schema: start a fresh CLI before another claim, and ask a project ancestor to force-release this lease.")
}

/// Give free slots to the first in line: one short transaction holding the
/// project row lock, then each granted dog fires. Also fires a dog granted
/// before a crash but not fired yet. Returns the leases granted.
#[logged]
pub async fn grant(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<Vec<String>> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx
        .query_opt("SELECT name, state, scope FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(Vec::new());
    };
    let (pname, state, scope): (String, String, Value) = (p.get(0), p.get(1), p.get(2));
    // granted before a crash but not fired: fire now
    let mut granted: Vec<Granted> = tx
        .query(
            "SELECT w.id, w.owner_agent_id, w.memo->>'lease', coalesce((w.memo->>'slot')::int, 0) FROM ot.watchdogs w
              WHERE w.kind = 'slot' AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $1 AND w.memo ? 'lease'",
            &[&project],
        )
        .await?
        .iter()
        .map(|r| Granted { dog: r.get(0), owner: r.get(1), lease: r.get(2), slot: r.get(3), project: pname.clone() })
        .collect();
    let mut fresh = Vec::new();
    if state == "live" {
        let held: Vec<i32> = tx
            .query("SELECT slot_no FROM ot.slot_leases WHERE project_id = $1 AND ended_at IS NULL", &[&project])
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect();
        let free = free_slots(capacity(&scope), &held);
        if !free.is_empty() {
            let waiting = tx
                .query(
                    "SELECT w.id, w.owner_agent_id, coalesce(w.memo->>'reason', w.name, '') FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
                      WHERE w.kind = 'slot' AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $1 AND NOT w.memo ? 'lease'
                        AND a.state = 'live' AND a.kind = 'agent' AND a.halt IS NULL
                      ORDER BY (w.memo->>'queued_at')::bigint, w.id LIMIT 200",
                    &[&project],
                )
                .await?;
            let mut slots = free.into_iter();
            for w in &waiting {
                let owner: i64 = w.get(1);
                // a claimant that has since moved out of the project's line no longer reaches it
                if !crate::domain::projects::reaches(&*tx, owner, project).await? {
                    continue;
                }
                let Some(slot) = slots.next() else { break };
                let dog: i64 = w.get(0);
                let lease = uid("s");
                tx.execute(
                    "INSERT INTO ot.slot_leases (uid, org_id, project_id, holder_agent_id, slot_no, reason, dog_id)
                     VALUES ($1, $2, $3, $4, $5, nullif($6, ''), $7)",
                    &[&lease, &org_id, &project, &owner, &slot, &w.get::<_, String>(2), &dog],
                )
                .await?;
                tx.execute(
                    "UPDATE ot.watchdogs SET memo = memo || jsonb_build_object('lease', $2::text, 'slot', $3::int) WHERE id = $1",
                    &[&dog, &lease, &slot],
                )
                .await?;
                fresh.push(lease.clone());
                granted.push(Granted { dog, owner, lease, slot, project: pname.clone() });
            }
        }
    }
    tx.commit().await?;
    drop(client);
    for g in &granted {
        tracing::info!(project = %g.project, slot = g.slot, lease = %g.lease, "a project slot was granted");
        Box::pin(crate::runtime::watchdogs::fire_slot(engine, g.dog, grant_line(&g.project, g.slot, &g.lease))).await?;
        changes::notify_id(engine, org_id, vec![Change::Agent(g.owner)]);
    }
    // every lease change (a grant, or the release or reclaim that ran this
    // grant) and every claim joining the line reaches the desk and canvas
    changes::notify_id(engine, org_id, vec![Change::Agent(project), Change::Watchdogs]);
    Ok(fresh)
}

/// The line on a project, first first: (dog row, dog id, owner name, queued
/// at). A dog's id is unique per owner only, so places are found by row.
#[logged]
pub async fn line(client: &impl GenericClient, project: i64) -> Result<Vec<(i64, String, String, Option<DateTime<Utc>>)>> {
    Ok(client
        .query(
            "SELECT w.id, w.uid, a.name, to_timestamp((w.memo->>'queued_at')::bigint / 1000.0) FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.kind = 'slot' AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $1 AND NOT w.memo ? 'lease'
              ORDER BY (w.memo->>'queued_at')::bigint, w.id LIMIT 200",
            &[&project],
        )
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect())
}

/// A project's slots as the tool's `slots` action and the desk show them:
/// count, holders, the line in order, and recent history.
#[logged]
pub async fn status(client: &impl GenericClient, project: i64, name: &str, scope: &Value) -> Result<Value> {
    let holders: Vec<Value> = client
        .query(
            "SELECT l.uid, a.name, l.slot_no, l.reason, l.granted_at, l.wakes FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id
              WHERE l.project_id = $1 AND l.ended_at IS NULL ORDER BY l.slot_no",
            &[&project],
        )
        .await?
        .iter()
        .map(|r| json!({ "lease": r.get::<_, String>(0), "agent": r.get::<_, String>(1), "slot": r.get::<_, i32>(2),
                         "reason": r.get::<_, Option<String>>(3), "since": iso(r.get::<_, DateTime<Utc>>(4)),
                         "reminders": r.get::<_, i32>(5) }))
        .collect();
    let waiting: Vec<Value> = line(client, project).await?.into_iter().enumerate()
        .map(|(i, (_, dog, agent, at))| json!({ "position": i + 1, "agent": agent, "dog": dog, "since": at.map(iso) }))
        .collect();
    let history: Vec<Value> = client
        .query(
            "SELECT l.uid, a.name, l.slot_no, l.reason, l.granted_at, l.ended_at, l.end_reason, l.ended_by
               FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id
              WHERE l.project_id = $1 AND l.ended_at IS NOT NULL ORDER BY l.id DESC LIMIT 20",
            &[&project],
        )
        .await?
        .iter()
        .map(|r| json!({ "lease": r.get::<_, String>(0), "agent": r.get::<_, String>(1), "slot": r.get::<_, i32>(2),
                         "reason": r.get::<_, Option<String>>(3), "since": iso(r.get::<_, DateTime<Utc>>(4)),
                         "ended": r.get::<_, Option<DateTime<Utc>>>(5).map(iso), "how": r.get::<_, Option<String>>(6),
                         "by": r.get::<_, Option<String>>(7) }))
        .collect();
    Ok(json!({ "project": name, "slots": capacity(scope), "held": holders.len(), "holders": holders,
               "line": waiting, "history": history }))
}

/// The org's held slots for the tree feed's watchdogs group: what the
/// canvas draws holder lines, badges and chips from.
#[logged]
pub async fn held_in_org(client: &impl GenericClient, org_id: i64) -> Result<Vec<Value>> {
    Ok(client
        .query(
            "SELECT p.name, a.name, l.slot_no, l.uid, l.reason, l.granted_at, l.wakes FROM ot.slot_leases l
               JOIN ot.agents a ON a.id = l.holder_agent_id JOIN ot.agents p ON p.id = l.project_id
              WHERE l.org_id = $1 AND l.ended_at IS NULL ORDER BY l.project_id, l.slot_no LIMIT 500",
            &[&org_id],
        )
        .await?
        .iter()
        .map(|r| json!({ "project": r.get::<_, String>(0), "agent": r.get::<_, String>(1), "slot": r.get::<_, i32>(2),
                         "lease": r.get::<_, String>(3), "reason": r.get::<_, Option<String>>(4),
                         "since": iso(r.get::<_, DateTime<Utc>>(5)), "reminders": r.get::<_, i32>(6) }))
        .collect())
}

/// End a lease: `how` is recorded (released, released (forced by …),
/// halted, retired, idle …) with who ended it. Runs in the caller's
/// transaction; the caller grants after commit. False when it had ended.
#[logged]
pub async fn end(tx: &impl GenericClient, lease_id: i64, how: &str, by: &str) -> Result<bool> {
    Ok(tx
        .execute(
            "UPDATE ot.slot_leases SET ended_at = now(), end_reason = $2, ended_by = $3 WHERE id = $1 AND ended_at IS NULL",
            &[&lease_id, &how, &by],
        )
        .await?
        == 1)
}

/// Take back the slots of holders that are gone (retired) or halted, tell
/// a halted holder why, then grant (user 2026-10-18 08:40Z: reclaim as ack
/// mode does). Runs on halt, retire and engine start.
#[logged]
pub async fn check(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<()> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let pname: Option<String> = tx
        .query_opt("SELECT name FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
        .map(|r| r.get(0));
    let Some(pname) = pname else { return Ok(()) };
    let gone = tx
        .query(
            "SELECT l.id, l.uid, l.slot_no, a.id, a.name, a.state, a.halt IS NOT NULL FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id
              WHERE l.project_id = $1 AND l.ended_at IS NULL AND (a.state <> 'live' OR a.halt IS NOT NULL)",
            &[&project],
        )
        .await?;
    let mut tell = Vec::new();
    for g in &gone {
        let how = if g.get::<_, String>(5) != "live" { "retired" } else { "halted" };
        if end(&*tx, g.get(0), how, "orgtree").await? && how == "halted" {
            tell.push((g.get::<_, String>(4), g.get::<_, String>(1), g.get::<_, i32>(2)));
        }
    }
    tx.commit().await?;
    drop(client);
    for (who, lease, slot) in tell {
        notify(engine, org_id, &who, &format!(
            "Your slot {slot} of project {pname} (lease {lease}) was taken back because you were halted; the next in line has it now. \
             Claim again with a slot watchdog when you are unhalted.")).await;
    }
    Box::pin(grant(engine, org_id, project)).await?;
    Ok(())
}

/// A System notice to a holder about its slot.
#[logged]
async fn notify(engine: &Arc<Engine>, org_id: i64, to: &str, body: &str) {
    let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, to, body);
    out.notice = true;
    out.grant_reply_audience = false;
    if let Err(e) = Box::pin(crate::domain::mail::send(engine, org_id, out)).await {
        tracing::warn!(error = %format!("{e:#}"), "telling a slot holder failed");
    }
}

/// The slots an agent holds, as (slot, project name, lease): it counts as
/// working for the 20-minute checkup, as held mail does.
#[logged]
pub async fn held_by(client: &impl GenericClient, agent: i64) -> Result<Vec<(i32, String, String)>> {
    Ok(client
        .query(
            "SELECT l.slot_no, p.name, l.uid FROM ot.slot_leases l JOIN ot.agents p ON p.id = l.project_id
              WHERE l.holder_agent_id = $1 AND l.ended_at IS NULL ORDER BY l.id LIMIT 20",
            &[&agent],
        )
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect())
}

/// The idle reclaim, run by the working checkup a holder is due for (user
/// 2026-10-18 08:40Z, ack mode's machinery): with the project's ack timeout
/// on, the wake counts against each held slot, and one that already had
/// `IDLE_WAKES` is taken back, its holder told, and the next in line granted.
/// Returns what the agent still holds, for the checkup's note.
#[logged]
pub async fn idle_timeouts(engine: &Arc<Engine>, org_id: i64, agent: i64, name: &str) -> Result<Vec<(i32, String, String)>> {
    let client = engine.db.get().await?;
    let rows = client
        .query(
            "SELECT l.id, l.uid, l.slot_no, l.wakes, p.id, p.name, p.scope FROM ot.slot_leases l JOIN ot.agents p ON p.id = l.project_id
              WHERE l.holder_agent_id = $1 AND l.ended_at IS NULL ORDER BY l.id LIMIT 20",
            &[&agent],
        )
        .await?;
    drop(client);
    let mut kept = Vec::new();
    for r in &rows {
        let (id, lease, slot, wakes, project, pname, scope): (i64, String, i32, i32, i64, String, Value) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6));
        let timeout = crate::domain::projects::ack_timeout(&scope);
        if timeout && wakes >= IDLE_WAKES {
            let mut c = engine.db.get().await?;
            let tx = c.transaction().await?;
            tx.query_opt("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&project]).await?;
            let how = format!("idle: not released after {IDLE_WAKES} reminders");
            let ended = end(&*tx, id, &how, "orgtree").await?;
            tx.commit().await?;
            drop(c);
            if ended {
                notify(engine, org_id, name, &format!(
                    "Your slot {slot} of project {pname} (lease {lease}) was taken back: you did not release it after {IDLE_WAKES} \
                     reminders. The next in line has it now; claim again with a slot watchdog if you still need it.")).await;
                Box::pin(grant(engine, org_id, project)).await?;
            }
            continue;
        }
        if timeout {
            engine.db.get().await?.execute("UPDATE ot.slot_leases SET wakes = wakes + 1 WHERE id = $1", &[&id]).await?;
        }
        kept.push((slot, pname, lease));
    }
    Ok(kept)
}

/// The projects an agent holds a slot of or waits in line for: what its
/// halt, retire or claim change can move (`projects::recheck_holder`).
#[logged]
pub async fn projects_of(client: &impl GenericClient, agent: i64) -> Result<Vec<i64>> {
    Ok(client
        .query(
            "SELECT project_id FROM ot.slot_leases WHERE holder_agent_id = $1 AND ended_at IS NULL
             UNION SELECT (memo->>'target_id')::bigint FROM ot.watchdogs
              WHERE owner_agent_id = $1 AND kind = 'slot' AND state = 'armed' AND memo ? 'target_id' LIMIT 64",
            &[&agent],
        )
        .await?
        .iter()
        .filter_map(|r| r.get::<_, Option<i64>>(0))
        .collect())
}

/// Engine start (requirement 9): every project with slots or a claim is
/// re-checked: a holder that went away loses its slot, and free slots go to
/// the line.
#[logged]
pub async fn startup(engine: &Arc<Engine>) {
    let projects: Vec<(i64, i64)> = match engine.db.get().await {
        Ok(c) => c
            .query(
                "SELECT DISTINCT project_id, org_id FROM ot.slot_leases WHERE ended_at IS NULL
                 UNION SELECT DISTINCT (memo->>'target_id')::bigint, org_id FROM ot.watchdogs WHERE kind = 'slot' AND state = 'armed'",
                &[],
            )
            .await
            .map(|rows| rows.iter().filter_map(|r| Some((r.get::<_, Option<i64>>(0)?, r.get(1)))).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for (project, org) in projects {
        if let Err(e) = check(engine, org, project).await {
            tracing::warn!(project, error = %format!("{e:#}"), "re-checking a project's slots at start failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// User 2026-10-18 08:42Z: a slot count, 0 (the default) is none.
    #[test]
    fn the_slot_count_defaults_to_none() {
        assert_eq!(capacity(&json!({})), 0);
        assert_eq!(capacity(&json!({ "slots_capacity": 2 })), 2);
        assert_eq!(capacity(&json!({ "slots_capacity": 1000 })), 0, "out of range reads as none");
    }

    /// The lowest free slots, never one already held.
    #[test]
    fn free_slots_are_the_lowest_not_held() {
        assert_eq!(free_slots(3, &[2]), vec![1, 3]);
        assert_eq!(free_slots(1, &[1]), Vec::<i32>::new());
        assert_eq!(free_slots(0, &[]), Vec::<i32>::new());
    }
}
