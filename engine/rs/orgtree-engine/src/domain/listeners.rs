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
//! The whole feature is a project setting (`scope.event_listeners`; docket
//! `project-event-listeners-an-enable-setting-off-by`, user 2026-10-20
//! 10:50Z, design approved 10:58Z): OFF by default. Arming a listener or a
//! watch switches it on (agents never switch it off); a superior switches
//! it either way in the project's settings. While it is off no listener or
//! watch on the project is armed and its event cannot be fired; switching
//! it off disables the armed ones with a mark, switching it on re-arms
//! exactly the marked ones.
//!
//! Delivery uses durable, bounded pages, serialized by a `FOR NO KEY
//! UPDATE` on the project row (as the mail queue's hand-out and the slot
//! grant): each page's eligible listeners, mail and cursor land together,
//! in dog creation order, then wakes and fire-time tool calls run after
//! commit. Reach is the project rule: the user, and agents above or below
//! the project.
//!
//! The user registers listeners and watches too (docket
//! let-the-user-manually-hold-a-number-of-a-project; user 2026-10-20 13:03Z
//! "allow them to register an event listener or listen watcher manually"):
//! dogs with no agent owner (`owner_kind = 'user'`, data name `"user"`, shown
//! as "you"). They count toward watches, receive fires as normal mail in the
//! user's inbox (`domain/user_regs.rs`), are paused and restored by the
//! project's event-listeners switch like any other, and only the user ends them.

use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::{GenericClient, Transaction};

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::util::{gist, iso, uid};
use crate::domain::user_regs::USER;

/// The watchdog kind that receives a project's events.
pub const LISTENER_KIND: &str = "project_listener";
/// The watchdog kind that watches a project's armed-listener count.
pub const WATCH_KIND: &str = "listener_watch";
/// Fires a listener dog keeps in its `events` ring (as the other kinds).
const EVENTS_KEEP: i64 = 50;
/// Maximum listener/watch rows processed in one committed transaction.
const FIRE_BATCH: i64 = 200;

#[cfg(test)]
tokio::task_local! { static STOP_AFTER_WATCH_EDGE: bool; }
#[cfg(test)]
tokio::task_local! { static STOP_AFTER_EVENT_PAGE: bool; }
#[cfg(test)]
tokio::task_local! { static STOP_BEFORE_USER_FIRE_COMMIT: bool; }
#[cfg(test)]
mod watch_boundary_tests;

/// The largest listener count a watch may ask for.
pub const MAX_COUNT: i64 = 1024;
/// The longest message a fired event may carry.
pub const MAX_MESSAGE: usize = 8000;
/// Kept fires one page of the project's Recently Fired history shows.
const HISTORY_PAGE: usize = 30;

/// The memo key a switch-off writes on each dog it disables; a switch-on
/// re-arms exactly the dogs carrying it. A dog its owner paused never
/// carries it, so it stays as its owner left it.
pub const OFF_MARK: &str = "listeners_off";

/// A project's event-listeners setting (`scope.event_listeners`): OFF, the
/// default, until an agent arms a listener or watch on the project or a
/// superior switches it on. It decides the desk's Listeners tab, whether
/// the project's event can be fired and whether its listener dogs work.
#[nolog]
pub fn enabled(scope: &Value) -> bool {
    scope["event_listeners"].as_bool().unwrap_or(false)
}

/// Why a dog a switch-off disabled is paused: its `paused_why`, and the
/// desktop's `disabled`.
#[nolog]
pub fn off_reason(project: &str, by: &str) -> String {
    format!("project {project}'s event listeners were turned off by {by}")
}

/// The refusal of a fire on a project whose event listeners are off.
#[nolog]
pub fn off_refusal(project: &str) -> String {
    format!("project {project}'s event listeners are off, so nothing listens for its event. A superior turns them on in \
             the project's settings (orgtree_project action=configure settings={{\"event_listeners\":true}}), or registering \
             a listener on it turns them on")
}

/// One listener or watch dog a switch disabled or re-armed.
#[derive(Debug, Clone)]
pub struct SwitchedDog {
    pub row: i64,
    pub uid: String,
    pub name: String,
    /// None is the user's own registration (nobody to tell)
    pub owner: Option<i64>,
    pub owner_name: String,
    pub owner_live: bool,
}

/// What a switch did: whether the setting changed, and the dogs it
/// disabled (off) or re-armed (on), in dog order.
#[derive(Debug, Clone, Default)]
pub struct Switched {
    pub changed: bool,
    pub dogs: Vec<SwitchedDog>,
}

#[nolog]
fn switched_dogs(rows: &[tokio_postgres::Row]) -> Vec<SwitchedDog> {
    let mut dogs: Vec<SwitchedDog> = rows.iter().map(|r| SwitchedDog {
        row: r.get(0), owner: r.get(1), owner_name: r.get(2), name: r.get(3), uid: r.get(4), owner_live: r.get(5),
    }).collect();
    dogs.sort_by_key(|d| d.row);
    dogs
}

/// Switch the project's event listeners ON inside `tx`. The project row is
/// taken first, as a fire, a watch evaluation and a switch-off take it, so
/// the setting and its dogs change together. Already on: nothing. Else the
/// setting is written and every dog a switch-off disabled is armed again; a
/// watch keeps its edge, so a restore alone does not fire it. The caller
/// arms the returned dogs and tells their owners after commit.
#[logged]
pub async fn switch_on(tx: &Transaction<'_>, project: i64) -> Result<Switched> {
    let Some(r) = tx
        .query_opt("SELECT scope FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(Switched::default());
    };
    if enabled(&r.get::<_, Value>(0)) {
        return Ok(Switched::default());
    }
    tx.execute(
        "UPDATE ot.agents SET scope = jsonb_set(coalesce(scope, '{}'::jsonb), '{event_listeners}', 'true'::jsonb),
                row_version = row_version + 1 WHERE id = $1",
        &[&project],
    )
    .await?;
    let rows = tx
        .query(
            &format!("UPDATE ot.watchdogs w SET state = 'armed', memo = w.memo - 'paused_why' - '{OFF_MARK}'
                WHERE w.kind IN ('project_listener', 'listener_watch')
                 AND w.state = 'paused' AND w.memo ? '{OFF_MARK}' AND (w.memo->>'target_id')::bigint = $1
              RETURNING w.id, w.owner_agent_id, coalesce((SELECT a.name FROM ot.agents a WHERE a.id = w.owner_agent_id), '{USER}'),
                        w.name, w.uid, coalesce((SELECT a.state = 'live' FROM ot.agents a WHERE a.id = w.owner_agent_id), false)"),
            &[&project],
        )
        .await?;
    Ok(Switched { changed: true, dogs: switched_dogs(&rows) })
}

/// Switch the project's event listeners OFF inside `tx` (a superior's
/// settings; agents never can): the project row first, then every armed
/// project_listener and listener_watch on the project is paused with the
/// mark and the reason. Dogs their owners paused stay unmarked, so a later
/// switch-on leaves them as they are. The caller disarms the returned dogs
/// and tells their owners after commit.
#[logged]
pub async fn switch_off(tx: &Transaction<'_>, project: i64, by: &str) -> Result<Switched> {
    let Some(r) = tx
        .query_opt("SELECT scope, name FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(Switched::default());
    };
    let scope: Value = r.get(0);
    let name: String = r.get(1);
    let was_on = enabled(&scope);
    // written even while absent (off by default): an explicit off is a setting
    if scope.get("event_listeners") != Some(&Value::Bool(false)) {
        tx.execute(
            "UPDATE ot.agents SET scope = jsonb_set(coalesce(scope, '{}'::jsonb), '{event_listeners}', 'false'::jsonb),
                    row_version = row_version + 1 WHERE id = $1",
            &[&project],
        )
        .await?;
    }
    let rows = tx
        .query(
            &format!("UPDATE ot.watchdogs w SET state = 'paused',
                     memo = w.memo || jsonb_build_object('paused_why', $2::text, '{OFF_MARK}', true)
                WHERE w.kind IN ('project_listener', 'listener_watch')
                 AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $1
              RETURNING w.id, w.owner_agent_id, coalesce((SELECT a.name FROM ot.agents a WHERE a.id = w.owner_agent_id), '{USER}'),
                        w.name, w.uid, coalesce((SELECT a.state = 'live' FROM ot.agents a WHERE a.id = w.owner_agent_id), false)"),
            &[&project, &off_reason(&name, by)],
        )
        .await?;
    Ok(Switched { changed: was_on || !rows.is_empty(), dogs: switched_dogs(&rows) })
}

/// A listener or watch arming on a project whose event listeners are off
/// (a rehire re-arming an archived owner's dogs, an engine start after the
/// setting changed underneath) disables itself as a switch-off would have,
/// under the project row, so a switch racing it decides. Returns whether
/// the dog stays armed.
#[logged]
pub async fn guard(engine: &Arc<Engine>, org_id: i64, row: i64, project: i64) -> Result<bool> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(r) = tx
        .query_opt("SELECT scope, name FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(true);
    };
    if enabled(&r.get::<_, Value>(0)) {
        return Ok(true);
    }
    let name: String = r.get(1);
    let n = tx
        .execute(
            &format!("UPDATE ot.watchdogs SET state = 'paused',
                     memo = memo || jsonb_build_object('paused_why', $2::text, '{OFF_MARK}', true)
               WHERE id = $1 AND state = 'armed'"),
            &[&row, &format!("project {name}'s event listeners are off")],
        )
        .await?;
    tx.commit().await?;
    if n > 0 {
        changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Agent(project)]);
    }
    Ok(false)
}

/// Tell each live owner of the dogs a switch disabled or re-armed, once and
/// passively, as a mail-queue mode change is told: which of its dogs, and
/// how they come back. `how` says who switched (and, on, how).
#[logged]
pub async fn tell_owners(engine: &Arc<Engine>, org_id: i64, project: &str, on: bool, how: &str, dogs: &[SwitchedDog]) {
    let mut owners: Vec<(String, Vec<String>)> = Vec::new();
    for d in dogs.iter().filter(|d| d.owner_live) {
        match owners.iter_mut().find(|(o, _)| *o == d.owner_name) {
            Some((_, names)) => names.push(d.name.clone()),
            None => owners.push((d.owner_name.clone(), vec![d.name.clone()])),
        }
    }
    for (to, names) in owners {
        let (s, are) = if names.len() == 1 { ("", "is") } else { ("s", "are") };
        let list = names.join(", ");
        let body = if on {
            format!("Project {project}'s event listeners are ON again ({how}). Your watchdog{s} on it {are} re-armed: {list}.")
        } else {
            format!("Project {project}'s event listeners were turned OFF by {how}. Your watchdog{s} on it {are} disabled: {list}. \
                     A disabled dog listens for nothing and fires nothing; when the project's event listeners are on again it \
                     re-arms by itself.")
        };
        let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, &to, &body);
        out.notice = true;
        out.grant_reply_audience = false;
        if let Err(e) = Box::pin(crate::domain::mail::send(engine, org_id, out)).await {
            tracing::warn!(project = %project, to = %to, error = %format!("{e:#}"), "telling a listener's owner of the event-listeners switch failed");
        }
    }
}

/// After a switch-on outside an op (an agent's create or resume): arm the
/// re-armed dogs, tell their owners and refresh the project.
#[logged]
pub async fn after_switch_on(engine: &Arc<Engine>, org_id: i64, project: i64, name: &str, how: &str, sw: &Switched) {
    for d in &sw.dogs {
        crate::runtime::watchdogs::arm(engine, d.row);
    }
    tell_owners(engine, org_id, name, true, how, &sw.dogs).await;
    changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Agent(project)]);
}

/// SQL (alias `w`, a listener or watch dog): since when it has listened —
/// its arming, or its previous fire (the desk's Waited, user 2026-10-20).
const LISTENING_SINCE: &str = "greatest(w.created_at, coalesce(w.last_fired, w.created_at))";

/// One listener in a kept fire: who, which dog, and since when it listened;
/// for an event, the fire mail it got in its own mailbox.
#[nolog]
fn heard_entry(agent: &str, dog: &str, name: &str, once: bool, since: DateTime<Utc>, mail: Option<&str>) -> Value {
    let mut v = json!({ "agent": agent, "dog": dog, "name": name, "once": once, "since": iso(since) });
    if let Some(m) = mail {
        v["mail"] = json!(m);
    }
    v
}

/// A `listener_watch`'s fire condition: the count crossed from below its
/// threshold to at or above it (staying above never re-fires; dropping
/// below and crossing again re-arms a continuous watch).
#[nolog]
pub fn crossed(was_above: bool, count: i64, threshold: i64) -> bool {
    !was_above && threshold >= 1 && count >= threshold
}

/// How many event listeners are armed on the project: `project_listener`
/// dogs in `armed` state whose owner is a live agent, or the user (who has
/// no agent row: the LEFT JOIN is deliberate, an inner join would not count
/// the user's). Paused listeners do not count; this one predicate feeds the
/// watch evaluation, the tool list and (through the tree's watchdogs) the
/// desk cards.
#[logged]
pub async fn armed_count(client: &impl GenericClient, org_id: i64, project: i64) -> Result<i64> {
    Ok(client
        .query_one(
            "SELECT count(*) FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'project_listener' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent'))",
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
    let mut after = 0i64;
    while let Some(last) = Box::pin(evaluate_page(engine, org_id, project, after)).await? {
        after = last;
        tokio::task::yield_now().await;
    }
    Ok(())
}

#[logged]
async fn evaluate_page(engine: &Arc<Engine>, org_id: i64, project: i64, after: i64) -> Result<Option<i64>> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx
        .query_opt("SELECT name, state FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(None);
    };
    let pname: String = p.get(0);
    if p.get::<_, String>(1) != "live" {
        return Ok(None);
    }
    let count = armed_count(&*tx, org_id, project).await?;
    let rows = tx
        .query(
            &format!("SELECT w.id, w.owner_agent_id, (w.memo->>'count')::bigint,
                    coalesce((w.memo->'run'->>'above')::boolean, false), w.uid, w.name, coalesce(a.name, '{USER}'), {LISTENING_SINCE}
               FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'listener_watch' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND w.id > $3 AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent'))
              ORDER BY w.id LIMIT 200"),
            &[&org_id, &project, &after],
        )
        .await?;
    let last = rows.last().map(|r| r.get::<_, i64>(0));
    // (dog row, the count it waits for, the user's own watch)
    let mut firing: Vec<(i64, i64, bool)> = Vec::new();
    // each crossing's record for the project's Recently Fired history:
    // the watch, and the listeners armed at the crossing
    let mut crossings: Vec<Value> = Vec::new();
    for r in &rows {
        let (row, owner): (i64, Option<i64>) = (r.get(0), r.get(1));
        let need = r.get::<_, Option<i64>>(2).unwrap_or(0);
        let was: bool = r.get(3);
        if need < 1 {
            continue;
        }
        // a watch whose owner moved out of the project's line no longer
        // reaches it: it never fires, as a fair-queue watcher out of reach
        // is never handed mail (the user, who watches from the desk, reaches all)
        let reached = match owner {
            Some(agent) => crate::domain::projects::reaches(&*tx, agent, project).await?,
            None => true,
        };
        if crossed(was, count, need) && reached {
            let line=format!("project {pname} now has {count} event listeners armed — at or over the {need} this watch waits for");
            tx.execute("INSERT INTO ot.listener_fire_outbox(org_id,project_id,watchdog_id,line) VALUES($1,$2,$3,$4)",&[&org_id,&project,&row,&line]).await?;
            firing.push((row, need, owner.is_none()));
            crossings.push(json!({ "agent": r.get::<_, String>(6), "dog": r.get::<_, String>(4), "name": r.get::<_, String>(5),
                                   "count": need, "armed": count, "since": iso(r.get::<_, DateTime<Utc>>(7)) }));
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
    if !crossings.is_empty() {
        let heard: Vec<Value> = tx
            .query(
                &format!("SELECT coalesce(a.name, '{USER}'), w.uid, w.name, w.once, {LISTENING_SINCE}
                   FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
                  WHERE w.org_id = $1 AND w.kind = 'project_listener' AND w.state = 'armed'
                    AND (w.memo->>'target_id')::bigint = $2 AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent'))
                  ORDER BY w.id LIMIT $3"),
                &[&org_id, &project, &FIRE_BATCH],
            )
            .await?
            .iter()
            .map(|r| heard_entry(&r.get::<_, String>(0), &r.get::<_, String>(1), &r.get::<_, String>(2), r.get(3), r.get(4), None))
            .collect();
        // kept before the watches fire, so an event a watch's fire action
        // fires lands after the crossing that caused it
        for watch in &crossings {
            tx.execute(
                "INSERT INTO ot.project_fires (org_id, project_id, at, kind, fired_by, watch, listeners)
                 VALUES ($1, $2, now(), 'watch', $3, $4, $5)",
                &[&org_id, &project, &watch["agent"].as_str().unwrap_or(""), watch, &Value::Array(heard.clone())],
            )
            .await?;
        }
    }
    tx.commit().await?;
    drop(client);
    #[cfg(test)]
    if STOP_AFTER_WATCH_EDGE.try_with(|stop| *stop).unwrap_or(false) { return Ok(last); }
    Box::pin(drain_fires(engine,org_id,project)).await?;
    if !firing.is_empty() {
        changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::Agent(project)]);
    }
    Ok(last)
}

/// One listener an event fire delivered to (its fire-time tool calls and
/// wake run after the delivery transaction, in this order).
#[derive(serde::Serialize,serde::Deserialize)]
struct Delivery {
    row: i64,
    uid: String,
    name: String,
    /// None is the user's own listener: the mail is theirs, nobody wakes
    owner: Option<i64>,
    owner_name: String,
    notice: bool,
    spent: bool,
    mail: String,
    fire_actions: Vec<Value>,
}

/// The same project-fire wording in its delivered mail and recorded event lines.
#[logged]
fn project_fire_notice(
    name: &str,
    pname: &str,
    by: &str,
    fired: i32,
    once: bool,
    message: Option<&str>,
) -> (String, Vec<String>) {
    let line = format!("@{} fired the event on project @{pname}", by.trim_start_matches('@'));
    let mut body = format!(
        "Watchdog \"{name}\" fired — PROJECT EVENT — (project_listener · {pname}), fire #{}:\n  {line}\n",
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
    let lines = std::iter::once(line)
        .chain(message.map(|m| gist(m, 200)))
        .collect();
    (body, lines)
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

/// Fire the project's event: durable bounded pages give every eligible
/// listener its mail and record its fire (spending one-shots), in dog
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
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx
        .query_opt("SELECT name, state, scope FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        crate::refuse!(NotFound, "no such project");
    };
    let pname: String = p.get(0);
    if p.get::<_, String>(1) != "live" {
        crate::refuse!(Conflict, "project {} is retired; its event cannot be fired", pname);
    }
    if !enabled(&p.get::<_, Value>(2)) {
        crate::refuse!(Conflict, "{}", off_refusal(&pname));
    }
    let fire_id: i64 = tx.query_one(
        "INSERT INTO ot.project_fires(org_id,project_id,kind,fired_by,message) VALUES($1,$2,'event',$3,$4) RETURNING id",
        &[&org_id,&project,&by,&message]).await?.get(0);
    tx.execute("INSERT INTO ot.project_event_dispatch(fire_id,org_id,project_id,high_water)
        SELECT $1,$2,$3,coalesce(max(id),0) FROM ot.watchdogs WHERE org_id=$2 AND kind='project_listener' AND (memo->>'target_id')::bigint=$3",
        &[&fire_id,&org_id,&project]).await?;
    tx.commit().await?;
    drop(client);
    Box::pin(drain_pending(engine,org_id,project)).await?;
    let c=engine.db.get().await?;
    let heard: Value=c.query_one("SELECT listeners FROM ot.project_fires WHERE id=$1",&[&fire_id]).await?.get(0);
    let heard=heard.as_array().cloned().unwrap_or_default();
    Ok(Fired { project:pname, delivered:heard.iter().filter_map(|v|v["agent"].as_str().map(str::to_string)).collect(),
        dogs:heard.iter().filter_map(|v|v["dog"].as_str().map(str::to_string)).collect() })
}

/// Commit bounded pages of the oldest pending event first. A page's cursor,
/// mail, one-shot state and history are atomic, so restart cannot duplicate it.
#[logged]
async fn drain_pending(engine:&Arc<Engine>,org_id:i64,project:i64)->Result<()> {
    while Box::pin(deliver_page(engine,org_id,project)).await?.is_some() {
        #[cfg(test)]
        if STOP_AFTER_EVENT_PAGE.try_with(|stop|*stop).unwrap_or(false) {return Ok(())}
        tokio::task::yield_now().await;
    }
    Ok(())
}

/// Startup continuation, including user-only registrations. No new event is
/// synthesized: queued events retain their original fire id, actor and body.
#[logged]
pub async fn recover_pending(engine:&Arc<Engine>)->Result<()> {
    let mut after=0i64;
    loop {
        let c=engine.db.get().await?;
        let rows=c.query("SELECT fire_id,org_id,project_id FROM ot.project_event_dispatch WHERE NOT done AND fire_id>$1 ORDER BY fire_id LIMIT 64",&[&after]).await?;
        drop(c);
        if rows.is_empty(){break}
        for r in rows {after=r.get(0);Box::pin(drain_pending(engine,r.get(1),r.get(2))).await?;}
    }
    let mut after=0i64;
    loop {
        let c=engine.db.get().await?;
        let rows=c.query("SELECT id,org_id,project_id FROM ot.listener_fire_outbox WHERE NOT done AND id>$1 ORDER BY id LIMIT 64",&[&after]).await?;
        drop(c);
        if rows.is_empty(){return Ok(())}
        for r in rows {after=r.get(0);Box::pin(drain_fires(engine,r.get(1),r.get(2))).await?;}
    }

}

#[logged]
async fn deliver_page(engine:&Arc<Engine>,org_id:i64,project:i64)->Result<Option<i64>> {
    let org_slug=engine.orgs.by_id(org_id).map(|o|o.slug.clone()).unwrap_or_default();
    let mut client=engine.db.get().await?;
    let tx=client.transaction().await?;
    let Some(p)=tx.query_opt("SELECT name,state,scope FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await? else{return Ok(None)};
    let pname:String=p.get(0);
    let Some(job)=tx.query_opt("SELECT d.fire_id,d.after_id,d.high_water,f.fired_by,f.message FROM ot.project_event_dispatch d JOIN ot.project_fires f ON f.id=d.fire_id WHERE d.project_id=$1 AND NOT d.done ORDER BY d.fire_id LIMIT 1 FOR UPDATE OF d",&[&project]).await? else{return Ok(None)};
    let (fire_id,after,high):(i64,i64,i64)=(job.get(0),job.get(1),job.get(2));
    let by:String=job.get(3);let by=by.as_str();
    let message:Option<String>=job.get(4);let message=message.as_deref();
    if p.get::<_,String>(1)!="live" || !enabled(&p.get::<_,Value>(2)) {
        tx.execute("UPDATE ot.project_event_dispatch SET done=true,after_id=high_water WHERE fire_id=$1",&[&fire_id]).await?;
        tx.commit().await?;return Ok(Some(fire_id));
    }
    let rows = tx
        .query(
            &format!("SELECT w.id, w.uid, w.name, w.owner_agent_id, coalesce(a.name, '{USER}'), w.once,
                    coalesce((w.memo->>'notice')::boolean, false), w.fired, w.memo->'fire_actions', {LISTENING_SINCE}
               FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'project_listener' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND w.id > $4 AND w.id <= $5 AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent'))
              ORDER BY w.id LIMIT $3 FOR UPDATE OF w"),
            &[&org_id, &project, &FIRE_BATCH, &after, &high],
        )
        .await?;
    let next=rows.last().map(|r|r.get::<_,i64>(0)).unwrap_or(high);
    let done=rows.len() < FIRE_BATCH as usize || next>=high;
    let mut deliveries: Vec<Delivery> = Vec::new();
    // who this fire reached, for the project's Recently Fired history
    let mut heard: Vec<Value> = Vec::new();
    for r in &rows {
        let (row, dog_uid, name, owner, owner_name, once, notice, fired): (i64, String, String, Option<i64>, String, bool, bool, i32) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6), r.get(7));
        // a listener that has since moved out of the project's line no
        // longer reaches it and receives nothing (the user reaches every project)
        if let Some(agent) = owner {
            if !crate::domain::projects::reaches(&*tx, agent, project).await? {
                continue;
            }
        }
        let mail = uid("m");
        let (body, lines) = project_fire_notice(&name, &pname, by, fired, once, message);
        let ev = crate::events::watchdog_fired(&org_slug, &dog_uid, &name, &owner_name, "PROJECT EVENT —", &lines, once, None);
        // an agent's mail lands in its mailbox; the user's in their inbox
        // (recipient_kind 'user', named '@user', as mail to the user is stored)
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state, replies)
             VALUES ($1, $2, $3, NULL, NULL, CASE WHEN $4::bigint IS NULL THEN 'user' ELSE 'agent' END, $4,
                     CASE WHEN $4::bigint IS NULL THEN '@user' ELSE $5::text END, 'watchdog', $6, $7, '[]', NULL, $8, false, NULL, NULL, 'pending', '[]')",
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
        tx.execute("UPDATE ot.mail SET extra=extra||jsonb_build_object('project_event',jsonb_build_object('fire_id',$2::bigint,'dog_id',$3::bigint)) WHERE uid=$1",&[&mail,&fire_id,&row]).await?;
        heard.push(heard_entry(&owner_name, &dog_uid, &name, once, r.get(9), Some(&mail)));
        deliveries.push(Delivery {
            row, uid: dog_uid, name, owner, owner_name, notice, spent, mail,
            fire_actions: r.get::<_, Option<Value>>(8).and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        });
    }
    for d in &deliveries {
        tx.execute("INSERT INTO ot.listener_fire_outbox(org_id,project_id,watchdog_id,delivery) VALUES($1,$2,$3,$4)",&[&org_id,&project,&d.row,&serde_json::to_value(d)?]).await?;
    }
    let total:i32=tx.query_one("UPDATE ot.project_fires SET listeners=listeners||$2::jsonb WHERE id=$1 RETURNING jsonb_array_length(listeners)",&[&fire_id,&Value::Array(heard)]).await?.get(0);
    tx.execute("UPDATE ot.project_event_dispatch SET after_id=$2,done=$3 WHERE fire_id=$1",&[&fire_id,&next,&done]).await?;
    if done {
        tx.execute("INSERT INTO ot.events(org_id,op,actor,subject_agent_id,detail) SELECT $1,'project_event_fire',$2,$3,jsonb_build_object('project',$4::text,'delivered',$5::int,'fire_id',$6::bigint,'listeners',(SELECT coalesce(jsonb_agg(v->>'agent'),'[]'::jsonb) FROM jsonb_array_elements(f.listeners) v),'message',$7::text) FROM ot.project_fires f WHERE f.id=$6",
            &[&org_id,&by,&project,&pname,&total,&fire_id,&message.map(|m|gist(m,200))]).await?;
    }
    tx.commit().await?;
    drop(client);
    // after commit, in delivery order: a spent dog stops, fire-time tool
    // calls run and their results join the mail, then the owner wakes
    let mut ch: Vec<Change> = vec![Change::Watchdogs, Change::Agent(project), Change::Events];
    Box::pin(drain_fires(engine,org_id,project)).await?;
    if done { ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event(
        crate::runtime::watchdogs::events::PROJECT_EVENT,
        crate::runtime::watchdogs::events::Scope::Agent(org_id, project),
        json!({ "project": pname, "project_id": project, "by": by, "delivered": total, "fire_id": fire_id,
                "has_message": message.is_some() }),
    )));
    }
    changes::notify_id(engine, org_id, ch);
    // spent one-shot listeners changed the count the watches read
    Box::pin(evaluate(engine, org_id, project)).await?;
    Ok(Some(fire_id))
}

/// Claim one durable notification in a short project-locked transaction.
/// Mail allocation and a one-shot's spent state commit together. A different
/// engine boot may reclaim post-commit work, but never its already-attempted actions.
#[nolog]
async fn stage_fire(engine:&Arc<Engine>,org_id:i64,project:i64)->Result<Option<(i64,Option<Delivery>)>> {
    let mut c=engine.db.get().await?;let tx=c.transaction().await?;
    if tx.query_opt("SELECT id FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await?.is_none(){return Ok(None)}
    let boot=&engine.boot.id;
    let Some(work)=tx.query_opt("SELECT id,watchdog_id,line,delivery FROM ot.listener_fire_outbox WHERE project_id=$1 AND NOT done AND (processing_boot IS NULL OR processing_boot<>$2) ORDER BY id LIMIT 1 FOR UPDATE",&[&project,&boot]).await? else{return Ok(None)};
    let (id,row,line,saved):(i64,i64,Option<String>,Option<Value>)=(work.get(0),work.get(1),work.get(2),work.get(3));
    #[cfg(test)]
    let allocating=saved.is_none();
    let delivery=if let Some(saved)=saved {serde_json::from_value(saved)?} else {
        let Some(d)=tx.query_opt("SELECT w.uid,w.name,w.owner_agent_id,coalesce(a.name,'user'),w.once,w.fired,w.memo,w.state,a.state,coalesce(a.kind,'agent'),w.target FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id=w.owner_agent_id WHERE w.id=$1 FOR UPDATE OF w",&[&row]).await? else{return Ok(None)};
        let owner:Option<i64>=d.get(2);
        let allowed=d.get::<_,String>(7)=="armed" && match owner {
            None=>true,
            Some(owner)=>d.get::<_,Option<String>>(8).as_deref()==Some("live") && d.get::<_,String>(9)=="agent" && crate::domain::projects::reaches(&*tx,owner,project).await?,
        };
        if !allowed {
            tx.execute("UPDATE ot.listener_fire_outbox SET done=true WHERE id=$1",&[&id]).await?;
            tx.commit().await?;return Ok(Some((id,None)));
        }
        let (dog,name,owner_name,once,fired,memo,target):(String,String,String,bool,i32,Value,String)=(d.get(0),d.get(1),d.get(3),d.get(4),d.get(5),d.get(6),d.get(10));
        let line=line.unwrap_or_default();
        let mut body=format!("Watchdog \"{name}\" fired LISTENERS READY — (listener_watch · {target}), fire #{}:\n  {line}\n",fired+1);
        if once {body.push_str("This was a ONE-SHOT watchdog: it removed itself with this fire and will not appear in `list` again.\n");}
        let mail=uid("m");let notice=memo["notice"].as_bool().unwrap_or(false);
        let slug=engine.orgs.by_id(org_id).map(|o|o.slug.clone()).unwrap_or_default();
        let ev=crate::events::watchdog_fired(&slug,&dog,&name,&owner_name,"LISTENERS READY —",&[line.clone()],once,None);
        tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,ev,state) VALUES($1,$2,$3,CASE WHEN $4::bigint IS NULL THEN 'user' ELSE 'agent' END,$4,CASE WHEN $4::bigint IS NULL THEN '@user' ELSE $5::text END,'watchdog',$6,$7,$8,'pending')",&[&mail,&org_id,&name,&owner,&owner_name,&notice,&body,&ev]).await?;
        let ring=json!([{ "at":iso(Utc::now()),"gist":gist(&line,200)}]);
        tx.execute("UPDATE ot.watchdogs SET fired=fired+1,last_fired=now(),state=CASE WHEN once THEN 'spent' ELSE state END,spent_at=CASE WHEN once THEN now() ELSE spent_at END,events=(SELECT coalesce(jsonb_agg(x ORDER BY n),'[]'::jsonb) FROM(SELECT x,n FROM jsonb_array_elements(events||$2) WITH ORDINALITY e(x,n) ORDER BY n DESC LIMIT $3)s) WHERE id=$1",&[&row,&ring,&EVENTS_KEEP]).await?;
        Delivery {row,uid:dog,name,owner,owner_name,notice,spent:once,mail,fire_actions:memo["fire_actions"].as_array().cloned().unwrap_or_default()}
    };
    tx.execute("UPDATE ot.listener_fire_outbox SET delivery=$2,processing_boot=$3 WHERE id=$1",&[&id,&serde_json::to_value(&delivery)?,&boot]).await?;
    #[cfg(test)]
    if allocating && delivery.owner.is_none() && STOP_BEFORE_USER_FIRE_COMMIT.try_with(|stop|*stop).unwrap_or(false) {
        anyhow::bail!("isolated user fire commit boundary");
    }
    tx.commit().await?;
    Ok(Some((id,Some(delivery))))
}

#[nolog]
async fn drain_fires(engine:&Arc<Engine>,org_id:i64,project:i64)->Result<()> {
    while let Some((id,delivery))=Box::pin(stage_fire(engine,org_id,project)).await? {
        let Some(d)=delivery else {continue};
        let result=Box::pin(finish_fire(engine,org_id,project,id,&d)).await;
        if let Err(error)=result {
            let c=engine.db.get().await?;
            c.execute("UPDATE ot.listener_fire_outbox SET processing_boot=NULL WHERE id=$1 AND NOT done",&[&id]).await?;
            return Err(error);
        }
    }
    Ok(())
}

#[nolog]
async fn finish_fire(engine:&Arc<Engine>,org_id:i64,project:i64,id:i64,d:&Delivery)->Result<()> {
    if d.spent {crate::runtime::watchdogs::disarm(engine,d.row);}
    let c=engine.db.get().await?;
    let first=c.execute("UPDATE ot.listener_fire_outbox SET actions_claimed=true WHERE id=$1 AND NOT actions_claimed",&[&id]).await?==1;
    drop(c);
    if first && !d.fire_actions.is_empty() {
        if let Some(owner)=d.owner {
            let text=crate::runtime::watchdogs::run_fire_actions(engine,org_id,owner,&d.owner_name,&d.uid,&d.name,&d.fire_actions).await;
            if !text.is_empty(){append_results(engine,org_id,d,&text).await;}
        }
    }
    let mut ch=vec![Change::Watchdogs,Change::Agent(project)];
    if let Some(owner)=d.owner {
        ch.push(Change::Mailbox(owner));
        ch.push(Change::Spark{from:format!("dog:{}",crate::domain::watchdogs::handle(&d.owner_name,&d.uid)),to:d.owner_name.clone()});
        if !d.notice && !(crate::mailhub::safe_start() && !crate::rig::recovers()){crate::runtime::wake(engine,org_id,owner);}
        else if let Some(h)=engine.agents.get(owner){h.send(crate::runtime::AgentMsg::Wake);}
    }else{ch.push(Change::UserMail);}
    changes::notify_id(engine,org_id,ch);
    let c=engine.db.get().await?;
    c.execute("UPDATE ot.listener_fire_outbox SET done=true,processing_boot=NULL WHERE id=$1",&[&id]).await?;
    Ok(())
}

/// Append a listener's fire-action results to its fire mail (body and
/// the `ev` the owner's turn renders) while that
/// mail is still pending (the normal path: the owner is woken only after
/// this). If it was already claimed or read in between, the results
/// arrive as their own short watchdog mail instead of vanishing.
#[logged]
async fn append_results(engine: &Arc<Engine>, org_id: i64, d: &Delivery, text: &str) {
    let appended = match engine.db.get().await {
        Ok(client) => client
            .execute("UPDATE ot.mail SET body = body || $2,
                        ev = CASE WHEN ev IS NULL THEN ev ELSE jsonb_set(ev, '{fire_actions}', to_jsonb($2::text)) END
                     WHERE uid = $1 AND state = 'pending'", &[&d.mail, &text])
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
            "SELECT w.uid, w.kind, coalesce(a.name, 'user'), w.state, w.once, coalesce((w.memo->>'notice')::boolean, false),
                    w.fired, w.last_fired, (w.memo->>'count')::bigint, w.memo->'fire_actions'
               FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
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
    let scope: Value = client.query_one("SELECT scope FROM ot.agents WHERE id = $1", &[&project]).await?.get(0);
    Ok(json!({ "project": name, "event_listeners": enabled(&scope), "listeners_armed": armed_count(client, org_id, project).await?,
               "listeners": listeners, "watches": watches }))
}

/// A history cursor: the id of the last row a page showed. `what` names
/// the history in the refusal.
#[nolog]
pub fn page_cursor(before: Option<&str>, what: &str) -> Result<Option<i64>> {
    let Some(before) = before.map(str::trim).filter(|b| !b.is_empty()) else { return Ok(None) };
    match before.parse::<i64>() {
        Ok(id) if id > 0 => Ok(Some(id)),
        _ => crate::refuse!(BadRequest, "invalid {what} cursor"),
    }
}

/// A project's Recently Fired history, newest first (the desk's Listeners
/// tab; user 2026-10-20 06:22Z): one bounded indexed page of kept fires, and
/// the cursor to the next. Each listener's fire mail is marked
/// `mail_gone` once it is no longer in the mailbox, so its link is not
/// offered.
#[logged]
pub async fn history(client: &impl GenericClient, project: i64, before: Option<&str>) -> Result<Value> {
    let before = page_cursor(before, "listener history")?;
    let limit = HISTORY_PAGE as i64 + 1;
    let cols = "id, at, kind, fired_by, message, watch, listeners";
    let rows = match before {
        Some(b) => client.query(
            &format!("SELECT {cols} FROM ot.project_fires WHERE project_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3"),
            &[&project, &b, &limit]).await?,
        None => client.query(
            &format!("SELECT {cols} FROM ot.project_fires WHERE project_id = $1 ORDER BY id DESC LIMIT $2"),
            &[&project, &limit]).await?,
    };
    let more = rows.len() > HISTORY_PAGE;
    let rows = &rows[..rows.len().min(HISTORY_PAGE)];
    let mails: Vec<String> = rows.iter()
        .flat_map(|r| r.get::<_, Value>(6).as_array().cloned().unwrap_or_default())
        .filter_map(|l| l["mail"].as_str().map(str::to_string))
        .collect();
    let kept: std::collections::HashSet<String> = if mails.is_empty() { Default::default() } else {
        client.query("SELECT uid FROM ot.mail WHERE uid = ANY($1)", &[&mails]).await?.iter().map(|r| r.get(0)).collect()
    };
    let history: Vec<Value> = rows.iter().map(|r| {
        let mut listeners = r.get::<_, Value>(6);
        for l in listeners.as_array_mut().into_iter().flatten() {
            if l["mail"].as_str().is_some_and(|m| !kept.contains(m)) {
                l["mail_gone"] = json!(true);
            }
        }
        let mut v = json!({ "id": r.get::<_, i64>(0), "at": iso(r.get(1)), "kind": r.get::<_, String>(2),
                            "by": r.get::<_, Option<String>>(3), "message": r.get::<_, Option<String>>(4), "listeners": listeners });
        if let Some(w) = r.get::<_, Option<Value>>(5) {
            v["watch"] = w;
        }
        v
    }).collect();
    let next = if more { history.last().and_then(|v| v["id"].as_i64()).map(|id| id.to_string()) } else { None };
    Ok(json!({ "history": history, "history_next": next }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_fire_mentions_agent_and_project_in_mail_and_event() {
        let (body, lines) =
            project_fire_notice("ready", "listener-smoke", "worker", 2, false, None);
        assert!(
            body.contains("  @worker fired the event on project @listener-smoke\n"),
            "{body}"
        );
        assert_eq!(
            lines,
            vec!["@worker fired the event on project @listener-smoke"]
        );
        assert!(body.starts_with("Watchdog \"ready\" fired — PROJECT EVENT — (project_listener · listener-smoke), fire #3:\n"));
    }

    #[test]
    fn project_fire_keeps_user_mention_and_message_and_one_shot_words() {
        let (body, lines) = project_fire_notice(
            "ready",
            "listener-smoke",
            "@user",
            0,
            true,
            Some("payload stays unchanged"),
        );
        assert!(
            body.contains(
                "  @user fired the event on project @listener-smoke\n\npayload stays unchanged\n"
            ),
            "{body}"
        );
        assert!(!body.contains("@@user"));
        assert_eq!(
            lines,
            vec![
                "@user fired the event on project @listener-smoke",
                "payload stays unchanged"
            ]
        );
        assert!(body.ends_with("This was a ONE-SHOT watchdog: it removed itself with this fire and will not appear in `list` again.\n"));
    }

    #[test]
    fn project_fire_empty_payload_and_already_mentioned_agent_are_preserved() {
        let (body, lines) = project_fire_notice("ready", "sync", "@worker", 4, false, Some(""));
        assert!(
            body.contains("  @worker fired the event on project @sync\n\n\n"),
            "{body}"
        );
        assert_eq!(lines, vec!["@worker fired the event on project @sync", ""]);
        assert!(!body.contains("@@worker"));
    }


    #[test]
    fn history_cursors_are_ids_and_malformed_ones_are_refused() {
        assert_eq!(page_cursor(None, "x").unwrap(), None);
        assert_eq!(page_cursor(Some(" "), "x").unwrap(), None);
        assert_eq!(page_cursor(Some("9007199254740993"), "x").unwrap(), Some(9007199254740993));
        for bad in ["abc", "0", "-4", "1.5", "9223372036854775808"] {
            assert!(page_cursor(Some(bad), "listener history").is_err(), "{bad} is refused");
        }
    }

    #[test]
    fn a_kept_listener_names_its_fire_mail_only_for_an_event() {
        let since: DateTime<Utc> = "2026-10-20T06:00:00.123456Z".parse().unwrap();
        let ev = heard_entry("ha", "ear", "ear", false, since, Some("m1"));
        assert_eq!(ev["since"], json!("2026-10-20T06:00:00.123Z"));
        assert_eq!(ev["mail"], json!("m1"));
        assert!(heard_entry("ha", "ear", "ear", true, since, None).get("mail").is_none(), "a watch's listeners got no mail");
    }

    #[test]
    fn the_setting_is_off_unless_written_on() {
        assert!(!enabled(&json!({})), "absent is off: the default");
        assert!(!enabled(&json!({ "event_listeners": false })));
        assert!(!enabled(&json!({ "event_listeners": "true" })), "only a boolean switches it on");
        assert!(!enabled(&Value::Null));
        assert!(enabled(&json!({ "event_listeners": true, "slots_capacity": 2 })));
    }

    #[test]
    fn the_off_words_name_the_project_and_how_to_switch_back() {
        assert_eq!(off_reason("sync", "boss"), "project sync's event listeners were turned off by boss");
        let r = off_refusal("sync");
        assert!(r.starts_with("project sync's event listeners are off"), "{r}");
        assert!(r.contains(r#"settings={"event_listeners":true}"#) && r.contains("registering a listener"), "{r}");
    }

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
