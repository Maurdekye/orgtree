//! Project event listeners (docket
//! `project-event-listeners-sync-monitor-watchdogs-l`; user design
//! 2026-10-19 07:40Z): a project carries a manual event. An agent above or
//! below it arms a `project_listener` watchdog and receives every fired
//! event as watchdog mail; `orgtree_project action=fire_event` fires it,
//! optionally carrying a message. A `listener_watch` watchdog fires when
//! the armed listeners on its project reach its `count` — with a
//! `fire_actions` entry firing the event, a superior releases the whole
//! group in the same instant: the project's sync/monitor primitive.
//!
//! Delivery is one transaction per fire, serialized by a `FOR NO KEY
//! UPDATE` on the project row (as the mail queue's hand-out and the slot
//! grant): every eligible listener's mail and fire record lands together,
//! in dog creation order, then wakes and fire-time tool calls run after
//! commit. Reach is the project rule: the user, and agents above or below
//! the project.

use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::util::{gist, iso, uid};

/// The watchdog kind that receives a project's events.
pub const LISTENER_KIND: &str = "project_listener";
/// The watchdog kind that watches a project's armed-listener count.
pub const WATCH_KIND: &str = "listener_watch";
/// Fires a listener dog keeps in its `events` ring (as the other kinds).
const EVENTS_KEEP: i64 = 50;
/// Listeners one fire delivers to (the org-wide kept-dog cap binds lower;
/// this only keeps the transaction's row set explicit).
const FIRE_BATCH: i64 = 200;

/// The largest listener count a watch may ask for.
pub const MAX_COUNT: i64 = 1024;
/// The longest message a fired event may carry.
pub const MAX_MESSAGE: usize = 8000;

/// A `listener_watch`'s fire condition: the count crossed from below its
/// threshold to at or above it (staying above never re-fires; dropping
/// below and crossing again re-arms a continuous watch).
#[nolog]
pub fn crossed(was_above: bool, count: i64, threshold: i64) -> bool {
    !was_above && threshold >= 1 && count >= threshold
}

/// How many event listeners are armed on the project: `project_listener`
/// dogs in `armed` state whose owner is a live agent. Paused listeners do
/// not count; this one predicate feeds the watch evaluation, the tool
/// list and (through the tree's watchdogs) the desk cards.
#[logged]
pub async fn armed_count(client: &impl GenericClient, org_id: i64, project: i64) -> Result<i64> {
    Ok(client
        .query_one(
            "SELECT count(*) FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'project_listener' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'",
            &[&org_id, &project],
        )
        .await?
        .get(0))
}

/// Re-read the project's listener count and fire every `listener_watch`
/// whose threshold it just crossed. Runs when a listener or watch is
/// armed (create, resume, rehire, engine start), when one pauses,
/// removes or is spent, and after a fire spent one-shot listeners. The
/// edge (`memo.run.above`) is held under the project row lock in one
/// short transaction; the fires themselves run after it commits.
#[logged]
pub async fn evaluate(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<()> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx
        .query_opt("SELECT name, state FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(());
    };
    let pname: String = p.get(0);
    if p.get::<_, String>(1) != "live" {
        return Ok(());
    }
    let count = armed_count(&*tx, org_id, project).await?;
    let rows = tx
        .query(
            "SELECT w.id, w.owner_agent_id, (w.memo->>'count')::bigint,
                    coalesce((w.memo->'run'->>'above')::boolean, false)
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'listener_watch' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'
              ORDER BY w.id LIMIT 200",
            &[&org_id, &project],
        )
        .await?;
    let mut firing: Vec<(i64, i64)> = Vec::new();
    for r in &rows {
        let (row, owner): (i64, i64) = (r.get(0), r.get(1));
        let need = r.get::<_, Option<i64>>(2).unwrap_or(0);
        let was: bool = r.get(3);
        if need < 1 {
            continue;
        }
        // a watch whose owner moved out of the project's line no longer
        // reaches it: it never fires, as a fair-queue watcher out of reach
        // is never handed mail
        if crossed(was, count, need) && crate::domain::projects::reaches(&*tx, owner, project).await? {
            firing.push((row, need));
        }
        let above_now = count >= need;
        if above_now != was {
            tx.execute(
                "UPDATE ot.watchdogs SET memo = jsonb_set(memo || jsonb_build_object('run', coalesce(memo->'run', '{}'::jsonb)),
                                                           '{run,above}', to_jsonb($2::boolean))
                  WHERE id = $1",
                &[&row, &above_now],
            )
            .await?;
        }
    }
    tx.commit().await?;
    drop(client);
    for (row, need) in &firing {
        let line = format!(
            "project {pname} now has {count} event listeners armed — at or over the {need} this watch waits for"
        );
        Box::pin(crate::runtime::watchdogs::fire_listener_watch(engine, *row, line)).await?;
    }
    if !firing.is_empty() {
        changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Agent(project)]);
    }
    Ok(())
}

/// One listener an event fire delivered to (its fire-time tool calls and
/// wake run after the delivery transaction, in this order).
struct Delivery {
    row: i64,
    uid: String,
    name: String,
    owner: i64,
    owner_name: String,
    notice: bool,
    spent: bool,
    mail: String,
    fire_actions: Vec<Value>,
}

/// What one fire did, for the tool result.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Fired {
    pub project: String,
    /// the agents woken or notified, in delivery order
    pub delivered: Vec<String>,
    /// their listener dogs' ids, same order
    pub dogs: Vec<String>,
}

/// Fire the project's event: one transaction gives every eligible
/// listener its mail and records its fire (spending one-shots), in dog
/// creation order; then each listener's fire-time tool calls run and its
/// results are appended to its still-pending mail before it is woken.
/// `by` is the firer's label (`@user` or an agent name); authority to
/// fire (project reach) is the caller's check, rechecked here per
/// listener for delivery.
#[logged]
pub async fn fire(engine: &Arc<Engine>, org_id: i64, project: i64, by: &str, message: Option<&str>) -> Result<Fired> {
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if message.map(|m| m.chars().count()).unwrap_or(0) > MAX_MESSAGE {
        crate::refuse!(BadRequest, "a project event message is at most {MAX_MESSAGE} characters");
    }
    let org_slug = engine.orgs.by_id(org_id).map(|o| o.slug.clone()).unwrap_or_default();
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx
        .query_opt("SELECT name, state FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        crate::refuse!(NotFound, "no such project");
    };
    let pname: String = p.get(0);
    if p.get::<_, String>(1) != "live" {
        crate::refuse!(Conflict, "project {} is retired; its event cannot be fired", pname);
    }
    let rows = tx
        .query(
            "SELECT w.id, w.uid, w.name, w.owner_agent_id, a.name, w.once,
                    coalesce((w.memo->>'notice')::boolean, false), w.fired, w.memo->'fire_actions'
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'project_listener' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'
              ORDER BY w.id LIMIT $3 FOR UPDATE OF w",
            &[&org_id, &project, &FIRE_BATCH],
        )
        .await?;
    let mut deliveries: Vec<Delivery> = Vec::new();
    for r in &rows {
        let (row, dog_uid, name, owner, owner_name, once, notice, fired): (i64, String, String, i64, String, bool, bool, i32) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6), r.get(7));
        // a listener that has since moved out of the project's line no
        // longer reaches it and receives nothing
        if !crate::domain::projects::reaches(&*tx, owner, project).await? {
            continue;
        }
        let mail = uid("m");
        let mut body = format!(
            "Watchdog \"{name}\" fired — PROJECT EVENT — (project_listener · {pname}), fire #{}:\n  {by} fired the event on project {pname}\n",
            fired + 1
        );
        if let Some(m) = message {
            body.push('\n');
            body.push_str(m);
            body.push('\n');
        }
        if once {
            body.push_str("This was a ONE-SHOT watchdog: it removed itself with this fire and will not appear in `list` again.\n");
        }
        let lines: Vec<String> = std::iter::once(format!("{by} fired the event on project {pname}"))
            .chain(message.map(|m| gist(m, 200)))
            .collect();
        let ev = crate::events::watchdog_fired(&org_slug, &dog_uid, &name, &owner_name, "PROJECT EVENT —", &lines, once);
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state, replies)
             VALUES ($1, $2, $3, NULL, NULL, 'agent', $4, $5, 'watchdog', $6, $7, '[]', NULL, $8, false, NULL, NULL, 'pending', '[]')",
            &[&mail, &org_id, &name, &owner, &owner_name, &notice, &body, &ev],
        )
        .await?;
        let ring = json!([{ "at": iso(Utc::now()), "gist": gist(&format!("project event fired by {by}{}", message.map(|m| format!(": {m}")).unwrap_or_default()), 200) }]);
        let spent: bool = tx
            .query_one(
                "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now(),
                        events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                            SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                             ORDER BY n DESC LIMIT $3) s),
                        spent_at = CASE WHEN once THEN now() ELSE spent_at END,
                        state = CASE WHEN once THEN 'spent' ELSE state END
                  WHERE id = $1 AND state = 'armed' RETURNING state = 'spent'",
                &[&row, &ring, &EVENTS_KEEP],
            )
            .await?
            .get(0);
        deliveries.push(Delivery {
            row, uid: dog_uid, name, owner, owner_name, notice, spent, mail,
            fire_actions: r.get::<_, Option<Value>>(8).and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        });
    }
    let names: Vec<String> = deliveries.iter().map(|d| d.owner_name.clone()).collect();
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'project_event_fire', $2, $3, $4)",
        &[&org_id, &by, &project, &json!({ "project": pname, "delivered": names.len(), "listeners": names,
                                            "message": message.map(|m| gist(m, 200)) })],
    )
    .await?;
    tx.commit().await?;
    drop(client);
    // after commit, in delivery order: a spent dog stops, fire-time tool
    // calls run and their results join the mail, then the owner wakes
    let mut ch: Vec<Change> = vec![Change::Watchdogs, Change::Agent(project), Change::Events];
    for d in &deliveries {
        if d.spent {
            crate::runtime::watchdogs::disarm(engine, d.row);
        }
        if !d.fire_actions.is_empty() {
            let text = crate::runtime::watchdogs::run_fire_actions(
                engine, org_id, d.owner, &d.owner_name, &d.uid, &d.name, &d.fire_actions,
            ).await;
            if !text.is_empty() {
                append_results(engine, org_id, d, &text).await;
            }
        }
        ch.push(Change::Mailbox(d.owner));
        ch.push(Change::Spark { from: format!("dog:{}", crate::domain::watchdogs::handle(&d.owner_name, &d.uid)), to: d.owner_name.clone() });
        if !d.notice && !(crate::mailhub::safe_start() && !crate::rig::recovers()) {
            crate::runtime::wake(engine, org_id, d.owner);
        } else if let Some(h) = engine.agents.get(d.owner) {
            h.send(crate::runtime::AgentMsg::Wake);
        }
    }
    ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event(
        crate::runtime::watchdogs::events::PROJECT_EVENT,
        crate::runtime::watchdogs::events::Scope::Agent(org_id, project),
        json!({ "project": pname, "project_id": project, "by": by, "delivered": deliveries.len(),
                "has_message": message.is_some() }),
    )));
    changes::notify_id(engine, org_id, ch);
    // spent one-shot listeners changed the count the watches read
    Box::pin(evaluate(engine, org_id, project)).await?;
    Ok(Fired {
        project: pname,
        dogs: deliveries.iter().map(|d| d.uid.clone()).collect(),
        delivered: deliveries.into_iter().map(|d| d.owner_name).collect(),
    })
}

/// Append a listener's fire-action results to its fire mail while that
/// mail is still pending (the normal path: the owner is woken only after
/// this). If it was already claimed or read in between, the results
/// arrive as their own short watchdog mail instead of vanishing.
#[logged]
async fn append_results(engine: &Arc<Engine>, org_id: i64, d: &Delivery, text: &str) {
    let appended = match engine.db.get().await {
        Ok(client) => client
            .execute("UPDATE ot.mail SET body = body || $2 WHERE uid = $1 AND state = 'pending'", &[&d.mail, &text])
            .await
            .map(|n| n == 1)
            .unwrap_or(false),
        Err(_) => false,
    };
    if appended {
        return;
    }
    let key = crate::domain::watchdogs::handle(&d.owner_name, &d.uid);
    let mut out = crate::domain::mail::Outgoing::new(
        crate::domain::mail::From::Watchdog { key, name: d.name.clone() },
        &d.owner_name,
        &format!("Fire-action results of watchdog \"{}\" (its fire mail was already read, so they come separately):\n{text}", d.name),
    );
    out.kind = "watchdog".into();
    out.notice = d.notice || (crate::mailhub::safe_start() && !crate::rig::recovers());
    if let Err(e) = crate::domain::mail::send(engine, org_id, out).await {
        tracing::warn!(watchdog = %d.uid, error = %format!("{e:#}"), "listener fire-action results mail failed");
    }
}

/// A project's listeners and watches as `orgtree_project
/// action=listeners` shows them (the desk's Listeners tab reads the same
/// facts from the tree's watchdogs).
#[logged]
pub async fn status(client: &impl GenericClient, org_id: i64, project: i64, name: &str) -> Result<Value> {
    let rows = client
        .query(
            "SELECT w.uid, w.kind, a.name, w.state, w.once, coalesce((w.memo->>'notice')::boolean, false),
                    w.fired, w.last_fired, (w.memo->>'count')::bigint, w.memo->'fire_actions'
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind IN ('project_listener', 'listener_watch')
                AND w.state IN ('armed', 'paused') AND (w.memo->>'target_id')::bigint = $2
              ORDER BY w.kind, w.id LIMIT 200",
            &[&org_id, &project],
        )
        .await?;
    let tools = |r: &tokio_postgres::Row| -> Vec<Value> {
        r.get::<_, Option<Value>>(9)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|a| a["tool"].as_str().map(|t| json!(t)))
            .collect()
    };
    let (mut listeners, mut watches) = (Vec::new(), Vec::new());
    for r in &rows {
        let mut v = json!({
            "agent": r.get::<_, String>(2), "dog": r.get::<_, String>(0), "state": r.get::<_, String>(3),
            "once": r.get::<_, bool>(4), "notice": r.get::<_, bool>(5), "fired": r.get::<_, i32>(6),
            "last_fired": r.get::<_, Option<DateTime<Utc>>>(7).map(iso), "fire_actions": tools(r),
        });
        if r.get::<_, String>(1) == WATCH_KIND {
            v["count"] = json!(r.get::<_, Option<i64>>(8));
            watches.push(v);
        } else {
            listeners.push(v);
        }
    }
    Ok(json!({ "project": name, "listeners_armed": armed_count(client, org_id, project).await?,
               "listeners": listeners, "watches": watches }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_watch_fires_only_on_the_crossing() {
        assert!(crossed(false, 3, 3), "reaching the count fires");
        assert!(crossed(false, 4, 3), "jumping past it fires");
        assert!(!crossed(false, 2, 3), "below the count waits");
        assert!(!crossed(true, 3, 3), "staying at the count does not re-fire");
        assert!(!crossed(true, 9, 3), "staying above does not re-fire");
        assert!(crossed(false, 3, 3), "dropping below (edge cleared) and crossing again fires");
        assert!(!crossed(false, 0, 0), "a missing count never fires");
        assert!(crossed(false, 1, 1), "a count of one fires on the first listener");
    }
}
