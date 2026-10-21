//! The user's own registrations on a project (docket
//! let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
//! 13:03Z-13:22Z "B, and yes to all three"; coordinator rulings 13:30Z):
//! hold concurrency slots, keep a project event listener and a listener
//! watch, and join the project's mail queue, from the project desk.
//!
//! A registration is an ordinary watchdog or slot lease with NO agent owner
//! (`owner_kind` / `holder_kind` = 'user', migration 0046), so it reuses the
//! FIFO line, restart persistence, the event-listeners pause mark, the watch
//! edges and project history. The user's data name is the reserved word
//! `"user"` (an agent cannot be named it); the desk shows it as "you".
//! Agents see these rows named "user". Only the user can end them: every
//! op here refuses an agent, a project ancestor included. There is no tool
//! or Hubchat equivalent (desk ops only).
//!
//! The user's dogs are never armed in the watchdog runtime (it joins the
//! owner agent): a slot request is granted by `slots::grant`, a listener
//! receives fires from `listeners::fire`, a watch is read by
//! `listeners::evaluate` and a queue listener is handed jobs by
//! `projects::dispatch`; the ops here re-run those after commit.
use super::*;

pub(crate) use crate::domain::user_regs::USER;

/// The longest reason a user gives for a hold.
const MAX_REASON: usize = 200;

/// The user's own registrations are theirs alone to make and end.
#[nolog]
fn require_user(actor: &Actor, what: &str) -> Result<()> {
    if matches!(actor, Actor::Agent { .. }) {
        refuse!(Forbidden, "only the user {what}: these are the user's own registrations, made and ended from the project desk");
    }
    Ok(())
}

/// A project the user registers on (any state: removing a registration on a
/// retired project must work), its row read by `node_by_name`.
#[logged]
async fn project_node(org: &Arc<OrgHandle>, tx: &Transaction<'_>, req: &Value, what: &str) -> Result<Node> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project {what}", n.name);
    }
    Ok(n)
}

/// A live project the user may register on, its row locked.
#[logged]
async fn live_project(org: &Arc<OrgHandle>, tx: &Transaction<'_>, req: &Value, what: &str) -> Result<Node> {
    let n = project_node(org, tx, req, what).await?;
    if n.state != "live" {
        refuse!(Conflict, "project {} is retired", n.name);
    }
    // the project's row first, as the grant, a fire and the hand-out take it
    tx.query_one("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&n.id]).await?;
    Ok(n)
}

/// A new armed dog of the user's on a project. Its id is its own (unique per
/// org; `watchdogs_user_uid`). Returns (the dog's id, its row).
#[logged]
async fn insert_dog(tx: &Transaction<'_>, org_id: i64, kind: &str, n: &Node, name: &str, once: bool, memo: &Value) -> Result<(String, i64)> {
    let dog = crate::util::uid("u");
    let row: i64 = tx
        .query_one(
            "INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, owner_kind, name, kind, target, interval_s, fire_mode, once, state, memo)
             VALUES ($1, $2, NULL, 'user', $3, $4, $5, 60, 'event', $6, 'armed', $7) RETURNING id",
            &[&dog, &org_id, &name, &kind, &n.name, &once, memo],
        )
        .await?
        .get(0);
    Ok((dog, row))
}

/// The user's armed or paused dog of a kind on a project, locked: (row, uid,
/// state, once, memo). The user keeps one of each kind per project, as an
/// agent does; registering again CHANGES that dog in place (the desk header's
/// Register... menu and Join mail queue, USER 2026-10-20 16:39Z/16:43Z), so
/// its place in the order, its fire count and what it holds are kept.
#[logged]
async fn existing_dog(tx: &Transaction<'_>, org_id: i64, kind: &str, n: &Node) -> Result<Option<(i64, String, String, bool, Value)>> {
    let r = tx
        .query_opt(
            "SELECT id, uid, state, once, memo FROM ot.watchdogs WHERE org_id = $1 AND owner_kind = 'user' AND kind = $2
                AND state IN ('armed', 'paused') AND (memo->>'target_id')::bigint = $3 ORDER BY id LIMIT 1 FOR UPDATE",
            &[&org_id, &kind, &n.id],
        )
        .await?;
    Ok(r.map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))))
}

/// Registering a listener or watch switches the project's event listeners
/// ON, as an agent's does (user 2026-10-20 10:50Z); a switch-off's disabled
/// dogs come back and their owners are told.
#[logged]
async fn turn_events_on(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, n: &Node, dog: &str, fx: &mut Effects) -> Result<()> {
    let sw = crate::domain::listeners::switch_on(tx, n.id).await?;
    if sw.changed {
        let handles: Vec<String> = sw.dogs.iter().map(|d| crate::domain::watchdogs::handle(&d.owner_name, &d.uid)).collect();
        event(tx, org.id, "set_event_listeners", actor, Some(n.id),
            json!({ "node": n.name, "enabled": true, "by_listener": dog, "restored": handles }), fx).await?;
        // the user's own restored dogs are never armed in the runtime
        fx.dogs_on.extend(sw.dogs.iter().filter(|d| d.owner.is_some()).map(|d| d.row));
        if !sw.dogs.is_empty() {
            fx.listener_switches.push((n.name.clone(), true, "the user registered a listener".into(), sw.dogs.clone()));
        }
    }
    Ok(())
}

// ------------------------------------------------------------ slots

/// Hold concurrency slots as the user (`op user_slot_hold`; the desk's Slots
/// tab "Hold slots as you…"). The request waits in the project's FIFO line
/// like an agent's claim and is granted WHOLE, then lasts until the user
/// releases it (also across a restart). One hold may ask for any count the
/// project has slots for, and the user's holds together never exceed them.
#[logged]
pub(super) async fn slot_hold(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "holds concurrency slots as themselves")?;
    let n = live_project(org, tx, req, "has concurrency slots").await?;
    let Some(count) = req.get("slots").and_then(Value::as_i64).filter(|c| (1..=crate::domain::slots::MAX_CAPACITY).contains(c)) else {
        refuse!(BadRequest, "slots is how many concurrency slots to hold, 1 to {}", crate::domain::slots::MAX_CAPACITY);
    };
    let reason = str_arg(req, "reason").map(str::trim).unwrap_or("");
    if reason.chars().count() > MAX_REASON {
        refuse!(BadRequest, "the reason is at most {MAX_REASON} characters");
    }
    // Shared admission takes the project lock and re-reads current policy.
    crate::domain::slots::admit(tx,n.id,None,count,None).await?;
    let queued_at = chrono::Utc::now().timestamp_millis();
    let memo = json!({ "target_id": n.id, "slots": count, "queued_at": queued_at, "reason": reason, "notice": true, "run": {} });
    let (dog, row) = insert_dog(tx, org.id, "slot", &n, "user-hold", true, &memo).await?;
    event(tx, org.id, "user_slot_hold", actor, Some(n.id), json!({ "node": n.name, "slots": count, "dog": dog, "row": row, "reason": reason }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    // free slots go to the head of the line after commit (which may be this hold)
    fx.slot_grants.push(n.id);
    Ok(json!({ "node": n.name, "dog": dog, "slots": count, "reason": reason,
               "next": "it waits first-come in the project's line and is granted whole; the desk's Slots tab shows it, and releasing it frees the slots" }))
}

/// Cancel one of the user's waiting hold requests (`op user_slot_cancel`).
/// A request that was already granted is a lease: release that instead.
#[logged]
pub(super) async fn slot_cancel(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "cancels their own waiting slot request")?;
    let n = live_project(org, tx, req, "has concurrency slots").await?;
    let dog = str_arg(req, "dog").unwrap_or("").trim();
    let removed = tx
        .execute(
            "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', 'cancelled by the user')
              WHERE org_id = $1 AND owner_kind = 'user' AND kind = 'slot' AND uid = $2 AND state IN ('armed', 'paused')
                AND (memo->>'target_id')::bigint = $3 AND NOT memo ? 'lease'",
            &[&org.id, &dog, &n.id],
        )
        .await?;
    if removed == 0 {
        refuse!(NotFound, "no waiting slot request {dog} of yours on project {}; a granted hold is a lease: release it", n.name);
    }
    event(tx, org.id, "user_slot_cancel", actor, Some(n.id), json!({ "node": n.name, "dog": dog }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    // taking a blocking head out of the line can free the claims behind it
    fx.slot_grants.push(n.id);
    Ok(json!({ "node": n.name, "cancelled": dog }))
}

/// Remove every waiting slot request of the user from a project's line
/// (`slot_unqueue agent=user`); only the user may.
#[logged]
pub(super) async fn unqueue_user(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, n: &Node, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "removes their own slot requests from the line")?;
    let removed = tx
        .execute(
            "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', 'removed from the line by the user')
              WHERE org_id = $1 AND owner_kind = 'user' AND kind = 'slot' AND state IN ('armed', 'paused')
                AND (memo->>'target_id')::bigint = $2 AND NOT memo ? 'lease'",
            &[&org.id, &n.id],
        )
        .await?;
    if removed == 0 {
        refuse!(NotFound, "you have no waiting slot request on project {}", n.name);
    }
    event(tx, org.id, "slot_unqueue", actor, Some(n.id), json!({ "node": n.name, "agent": USER }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    fx.slot_grants.push(n.id);
    Ok(json!({ "node": n.name, "removed": USER }))
}

// ------------------------------------------------------------ event listener and listener watch

/// Register the user as an event listener on a project (`op
/// user_listener_register`; the desk's Listeners tab). Every event fired on
/// the project (`once`: only the next) arrives as mail in their inbox. It
/// counts toward listener watches, and switches the project's event
/// listeners on. Registering again with the other `once` SWITCHES the
/// listener in place (the same dog); the same kind changes nothing.
#[logged]
pub(super) async fn listener_register(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "registers as an event listener themselves")?;
    let n = live_project(org, tx, req, "has event listeners").await?;
    let once = req.get("once").and_then(Value::as_bool).unwrap_or(false);
    if let Some((row, dog, state, was_once, _)) = existing_dog(tx, org.id, "project_listener", &n).await? {
        if was_once != once {
            tx.execute("UPDATE ot.watchdogs SET once = $2 WHERE id = $1", &[&row, &once]).await?;
            event(tx, org.id, "user_listener_switch", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "once": once }), fx).await?;
            fx.agents.insert(n.id);
            fx.pulses.push(crate::changes::Change::Watchdogs);
        }
        return Ok(json!({ "node": n.name, "dog": dog, "state": state, "once": once, "updated": was_once != once,
                          "next": "the listener was switched in place: the same dog, each event fired on the project still arrives as normal mail in your inbox" }));
    }
    let memo = json!({ "target_id": n.id, "notice": false, "run": {} });
    let (dog, row) = insert_dog(tx, org.id, "project_listener", &n, "user-listener", once, &memo).await?;
    turn_events_on(org, tx, actor, &n, &dog, fx).await?;
    event(tx, org.id, "user_listener_register", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "once": once }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    // a new listener may complete a watch's count
    fx.listener_evals.push(n.id);
    Ok(json!({ "node": n.name, "dog": dog, "once": once,
               "next": "each event fired on the project arrives as normal mail in your inbox" }))
}

/// Register a listener watch for the user (`op user_watch_register`): a
/// one-time notification in their inbox when the project's armed event
/// listeners (theirs included) reach `count`; already there, it fires at once.
/// Registering again with another count UPDATES the watch in place (the same
/// dog, evaluated at once); the same count changes nothing.
#[logged]
pub(super) async fn watch_register(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "registers a listener watch themselves")?;
    let n = live_project(org, tx, req, "has event listeners").await?;
    let Some(count) = req.get("count").and_then(Value::as_i64).filter(|c| (1..=crate::domain::listeners::MAX_COUNT).contains(c)) else {
        refuse!(BadRequest, "count is how many armed event listeners on {} fire the watch, 1 to {}", n.name, crate::domain::listeners::MAX_COUNT);
    };
    if let Some((row, dog, state, _, memo)) = existing_dog(tx, org.id, "listener_watch", &n).await? {
        let before = memo.get("count").and_then(Value::as_i64).unwrap_or(0);
        if before != count {
            // a new count is a new crossing: it may fire at once if the project already has that many listeners
            tx.execute(
                "UPDATE ot.watchdogs SET memo = memo || jsonb_build_object('count', $2::bigint,
                        'run', coalesce(memo->'run', '{}'::jsonb) || jsonb_build_object('above', false)) WHERE id = $1",
                &[&row, &count],
            )
            .await?;
            event(tx, org.id, "user_watch_update", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "from": before, "count": count }), fx).await?;
            fx.agents.insert(n.id);
            fx.pulses.push(crate::changes::Change::Watchdogs);
            fx.listener_evals.push(n.id);
        }
        return Ok(json!({ "node": n.name, "dog": dog, "state": state, "count": count, "previous": before, "updated": before != count,
                          "next": "the watch was updated in place: a one-time notification arrives as normal mail in your inbox when the new count is reached" }));
    }
    let memo = json!({ "target_id": n.id, "count": count, "notice": false, "run": { "above": false } });
    let (dog, row) = insert_dog(tx, org.id, "listener_watch", &n, "user-watch", true, &memo).await?;
    turn_events_on(org, tx, actor, &n, &dog, fx).await?;
    event(tx, org.id, "user_watch_register", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "count": count }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    // evaluated at once, like an agent's: the count may already be there
    fx.listener_evals.push(n.id);
    Ok(json!({ "node": n.name, "dog": dog, "count": count,
               "next": "a one-time notification arrives as normal mail in your inbox when the count is reached" }))
}

/// Remove the user's event listener or listener watch (`op
/// user_registration_remove`; `dog` names it). Only the user may; the count
/// the project's watches read changes, so they are evaluated after commit.
#[logged]
pub(super) async fn registration_remove(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "removes their own event listener or watch")?;
    let n = project_node(org, tx, req, "has event listeners").await?;
    let dog = str_arg(req, "dog").unwrap_or("").trim();
    let removed = tx
        .query_opt(
            "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', 'removed by the user')
              WHERE org_id = $1 AND owner_kind = 'user' AND uid = $2 AND kind IN ('project_listener', 'listener_watch')
                AND state IN ('armed', 'paused') AND (memo->>'target_id')::bigint = $3
              RETURNING kind",
            &[&org.id, &dog, &n.id],
        )
        .await?;
    let Some(removed) = removed else {
        refuse!(NotFound, "no event listener or listener watch {dog} of yours on project {}", n.name);
    };
    let kind: String = removed.get(0);
    event(tx, org.id, "user_registration_remove", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "kind": kind }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    fx.listener_evals.push(n.id);
    Ok(json!({ "node": n.name, "removed": dog, "kind": kind }))
}

// ------------------------------------------------------------ the mail queue

/// Join a project's mail queue as the user (`op user_queue_join`; the
/// desk's Mail › listeners). The jobs it hands the user arrive as normal
/// mail in their inbox; in ACK mode each is theirs until they acknowledge
/// it. `batch` bounds the jobs they hold at once. The user takes their turn
/// in the round-robin like any listener.
///
/// Joining again while in the queue changes the batch IN PLACE (the desk
/// header's "Join mail queue N times", USER 2026-10-20 16:39Z: "it can be
/// changed after and pressed again to update the batch size"): the same dog
/// keeps its place in the order and every job already held; a raised batch
/// hands a waiting job at once, a lowered one reclaims nothing.
#[logged]
pub(super) async fn queue_join(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "joins a project's mail queue as themselves")?;
    let n = live_project(org, tx, req, "has a mail queue").await?;
    let batch = req.get("batch").and_then(Value::as_u64).unwrap_or(1);
    if !(1..=crate::domain::projects::MAX_QUEUE_BATCH).contains(&batch) {
        refuse!(BadRequest, "batch is how many jobs you hold at once, 1 to {}", crate::domain::projects::MAX_QUEUE_BATCH);
    }
    if let Some((row, dog, state, _, memo)) = existing_dog(tx, org.id, "fair_queue", &n).await? {
        let before = memo.get("batch").and_then(Value::as_u64).unwrap_or(1);
        if before != batch {
            tx.execute("UPDATE ot.watchdogs SET memo = memo || jsonb_build_object('batch', $2::bigint) WHERE id = $1", &[&row, &(batch as i64)]).await?;
            event(tx, org.id, "user_queue_batch", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "from": before, "batch": batch }), fx).await?;
            fx.agents.insert(n.id);
            fx.pulses.push(crate::changes::Change::Watchdogs);
            // a raised batch frees room: what waits is handed out now
            fx.queue_runs.push(n.id);
        }
        return Ok(json!({ "node": n.name, "dog": dog, "state": state, "batch": batch, "previous": before, "updated": before != batch,
                          "next": "the batch changed in place: your place in the order and any job you hold are kept" }));
    }
    let memo = json!({ "target_id": n.id, "batch": batch, "notice": false, "run": {} });
    let (dog, row) = insert_dog(tx, org.id, "fair_queue", &n, "user-queue", false, &memo).await?;
    event(tx, org.id, "user_queue_join", actor, Some(n.id), json!({ "node": n.name, "dog": dog, "row": row, "batch": batch }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    // what waited while nobody watched is handed out now
    fx.queue_runs.push(n.id);
    Ok(json!({ "node": n.name, "dog": dog, "batch": batch,
               "next": "jobs the queue hands you arrive as normal mail in your inbox; in ACK mode acknowledge each when it is done" }))
}

/// Leave a project's mail queue (`op user_queue_leave`). A job the user
/// already holds stays theirs until they acknowledge it (USER 13:22Z: "leaving
/// the mail queue keeps a held job until it's ACKed").
#[logged]
pub(super) async fn queue_leave(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "leaves a project's mail queue as themselves")?;
    let n = project_node(org, tx, req, "has a mail queue").await?;
    let left = tx
        .execute(
            "UPDATE ot.watchdogs SET state = 'removed', memo = memo || jsonb_build_object('reason', 'the user left the queue')
              WHERE org_id = $1 AND owner_kind = 'user' AND kind = 'fair_queue' AND state IN ('armed', 'paused')
                AND (memo->>'target_id')::bigint = $2",
            &[&org.id, &n.id],
        )
        .await?;
    if left == 0 {
        refuse!(NotFound, "you are not in project {}'s mail queue", n.name);
    }
    event(tx, org.id, "user_queue_leave", actor, Some(n.id), json!({ "node": n.name }), fx).await?;
    fx.agents.insert(n.id);
    fx.pulses.push(crate::changes::Change::Watchdogs);
    Ok(json!({ "node": n.name, "left": true, "note": "a job you already hold stays yours until you acknowledge it" }))
}

/// Acknowledge a job the queue handed the user (`op user_job_ack`; the inbox
/// reader's "Reply & acknowledge" / "Acknowledge without reply"). `copy` is
/// the job's mail in their inbox; `reply` is the id of a reply mail they
/// already sent to the job's sender, kept as the completion record. Frees
/// their place (the queue hands them the next job) and ends the attempt as
/// acked. Reading a job never acknowledges it.
#[logged]
pub(super) async fn job_ack(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    require_user(actor, "acknowledges a job handed to them")?;
    let copy = str_arg(req, "copy").unwrap_or("").trim().trim_start_matches('#').to_string();
    let reply = str_arg(req, "reply").map(str::trim).filter(|r| !r.is_empty()).map(str::to_string);
    if let Some(r) = &reply {
        let mine = tx.query_opt("SELECT 1 FROM ot.mail WHERE uid = $1 AND org_id = $2 AND sender = '@user'", &[r, &org.id]).await?;
        if mine.is_none() {
            refuse!(BadRequest, "reply is the id of a mail you sent; {r} is not");
        }
    }
    let (project, row, orig, claimed) = crate::domain::projects::user_ack_of(tx, org.id, &copy).await?;
    tx.execute(
        &format!("UPDATE ot.mail SET extra = {} WHERE id = $1", crate::domain::projects::closed_attempt(
            "jsonb_set(jsonb_set(extra, '{claimed,acked_at}', to_jsonb(now())), '{claimed,ack_mail}', coalesce(to_jsonb($2::text), 'null'::jsonb))",
            "'acked'", "'acked'")),
        &[&row, &reply],
    )
    .await?;
    let attempt: i64 = tx.query_one("SELECT coalesce((extra->>'attempts')::bigint, 0) FROM ot.mail WHERE id = $1", &[&row]).await?.get(0);
    crate::domain::projects::record_ending(tx, org.id, project, &orig, &claimed, None, USER, "acked", None, attempt, reply.as_deref()).await?;
    crate::domain::projects::free_listener(tx, None, &claimed).await?;
    // what the inbox reader shows: this job is acknowledged
    tx.execute("UPDATE ot.mail SET extra = jsonb_set(extra, '{via_project,acked_at}', to_jsonb(now())) WHERE uid = $1 AND org_id = $2", &[&copy, &org.id]).await?;
    let pname: String = tx.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&project]).await?.get(0);
    event(tx, org.id, "user_job_ack", actor, Some(project), json!({ "project": pname, "job": orig, "copy": copy, "reply": reply }), fx).await?;
    fx.agents.insert(project);
    fx.mailboxes.push(project);
    fx.pulses.push(crate::changes::Change::UserMail);
    // the freed place takes the next job at once
    fx.queue_runs.push(project);
    Ok(json!({ "project": pname, "acknowledged": copy, "reply": reply }))
}

#[cfg(test)]
#[path = "user_regs/slot_limit_tests.rs"]
mod slot_limit_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// Coordinator ruling 2026-10-20 13:30Z: only the user ends the user's
    /// registrations; the engine refuses every agent, project ancestors too.
    #[test]
    fn only_the_user_makes_and_ends_user_registrations() {
        assert!(require_user(&Actor::User, "holds slots").is_ok());
        let boss = Actor::Agent { id: 7, name: "boss".into() };
        let e = require_user(&boss, "holds concurrency slots as themselves").unwrap_err();
        assert!(matches!(e.downcast_ref::<crate::domain::UserError>(), Some(crate::domain::UserError::Forbidden(_))));
        assert!(e.to_string().contains("only the user"));
    }
}
