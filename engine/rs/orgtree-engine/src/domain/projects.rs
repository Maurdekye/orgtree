//! Project nodes (docs/rust-engine/PROJECT-NODES.md; user 2026-10-16): a
//! tree node that stands for a project and is not an agent. It is a row of
//! `ot.agents` with `kind = 'project'`, so names, moves, credits and the
//! canvas treat it like any node, but it runs no turns. The user, every agent
//! above it and every agent below it reach it (its folder, mailbox,
//! presentations, and control over it); nobody else does.
//!
//! Its mailbox is handed out by the fair project mail queue: each waiting
//! mail goes to exactly one of the agents watching the project with a
//! `fair_queue` watchdog, the least recently woken first, and from then on it
//! is that agent's mail as if it had been sent straight to it.
//!
//! Its queue has a mode (user 2026-10-18 08:01Z), the project's
//! `scope.mail_queue`: round-robin (the default) hands each mail out as soon
//! as it arrives; ack mode gives each watcher ONE mail at a time, and no
//! more until it acks it with a completion record, a reply to that mail sent
//! to the project's mailbox. An un-acked mail goes back to the front of the
//! queue when its holder is retired, halted or stops watching.

use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::util::{gist, iso, uid};

/// `ot.agents.kind` of a project node.
pub const KIND: &str = "project";
/// The `tier` a project row stores: a sentinel, never a catalog tier.
pub const TIER: &str = "project";
/// Mails one `dispatch` call hands out before it yields to the next trigger.
const DISPATCH_BATCH: usize = 200;
/// Fires a fair-queue dog keeps in its `events` ring (as the other kinds).
const EVENTS_KEEP: i64 = 50;
/// `scope.mail_queue` values; absent reads as round-robin.
pub const MODE_ROUND_ROBIN: &str = "round_robin";
pub const MODE_ACK: &str = "ack";

/// Is the project's queue in ack mode (its `scope`)?
#[nolog]
pub fn ack_mode(scope: &Value) -> bool {
    scope.get("mail_queue").and_then(Value::as_str) == Some(MODE_ACK)
}

/// Does the project keep a sender's own mail from being handed back to it
/// (its `scope.mail_queue_exclude_sender`; off by default, user 08:08Z)?
#[nolog]
pub fn exclude_sender(scope: &Value) -> bool {
    scope.get("mail_queue_exclude_sender").and_then(Value::as_bool) == Some(true)
}

/// Default checkup reminders before reclaiming held mail or an idle slot.
pub const ACK_WAKES: i64 = 3;
pub const MAX_ACK_REMINDERS: i64 = 10;

/// The project's reminder budget for both acknowledgement timeout paths.
#[nolog]
pub fn ack_reminders(scope: &Value) -> i64 {
    scope.get("mail_queue_ack_reminders").and_then(Value::as_i64)
        .filter(|n| (1..=MAX_ACK_REMINDERS).contains(n)).unwrap_or(ACK_WAKES)
}

/// A reminder is sent at each count below the budget; reclaim on the next
/// checkup after the configured reminders, preserving the default's timing.
#[nolog]
pub fn ack_reminders_exhausted(scope: &Value, wakes: i64) -> bool {
    ack_timeout(scope) && wakes >= ack_reminders(scope)
}

/// Is the project's ack timeout on (`scope.mail_queue_ack_timeout`, default on)?
#[nolog]
pub fn ack_timeout(scope: &Value) -> bool {
    scope.get("mail_queue_ack_timeout").and_then(Value::as_bool) != Some(false)
}

/// How many times a mail is handed out before a reclaim dead-letters it
/// (`scope.mail_queue_max_attempts`, default 3, 1 to 100).
#[nolog]
pub fn max_attempts(scope: &Value) -> i64 {
    scope.get("mail_queue_max_attempts").and_then(Value::as_i64).filter(|n| (1..=100).contains(n)).unwrap_or(3)
}

/// Does the project remind a listener at once when it ends a turn still holding
/// an un-acked job (`scope.mail_queue_turn_end_reminder`, default ON; user
/// 2026-10-18 18:05Z-18:06Z)? Only ack mode holds jobs.
#[nolog]
pub fn turn_end_reminder(scope: &Value) -> bool {
    scope.get("mail_queue_turn_end_reminder").and_then(Value::as_bool) != Some(false)
}

/// SQL: `extra` with the newest `attempt_log` entry ended (`how`: acked,
/// released or timed_out; `why`: a SQL text expression); `extra` unchanged
/// when the mail has no attempt log (mail handed out before it existed).
#[nolog]
pub fn closed_attempt(extra: &str, how: &str, why: &str) -> String {
    format!("CASE WHEN jsonb_array_length(coalesce({extra}->'attempt_log', '[]'::jsonb)) > 0 THEN
                 jsonb_set({extra}, ARRAY['attempt_log', (jsonb_array_length({extra}->'attempt_log') - 1)::text, 'ended'],
                           jsonb_build_object('how', {how}, 'why', {why}, 'at', now()))
             ELSE {extra} END")
}

/// SQL: a project mail (alias `m`) handed in ack mode and not acked yet.
const OUTSTANDING: &str = "m.state = 'read' AND coalesce((m.extra->'claimed'->>'ack')::boolean, false)
    AND m.extra->'claimed'->>'acked_at' IS NULL";

/// A project node, as the mail and watchdog paths need it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub state: String,
}

/// The project named `name` in the org, in any state but deleted.
#[logged]
pub async fn by_name(client: &impl GenericClient, org_id: i64, name: &str) -> Result<Option<Project>> {
    let name = name.trim().trim_start_matches('@');
    Ok(client
        .query_opt(
            "SELECT id, name, state FROM ot.agents WHERE org_id = $1 AND name = $2 AND kind = 'project' AND state <> 'deleted'",
            &[&org_id, &name],
        )
        .await?
        .map(|r| Project { id: r.get(0), name: r.get(1), state: r.get(2) }))
}

/// Is node `id` a project?
#[logged]
pub async fn is_project(client: &impl GenericClient, id: i64) -> Result<bool> {
    Ok(client
        .query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND kind = 'project'", &[&id])
        .await?
        .is_some())
}

/// Does `agent` reach `project`: is it above the project or below it (user
/// 2026-10-16 16:11Z)? The project itself, peers and cousins do not.
#[logged]
pub async fn reaches(client: &impl GenericClient, agent: i64, project: i64) -> Result<bool> {
    if agent == project {
        return Ok(false);
    }
    Ok(client
        .query_one(
            "WITH RECURSIVE
               a(id, parent_id, depth) AS (
                 SELECT id, parent_id, 0 FROM ot.agents WHERE id = $1
                 UNION ALL SELECT x.id, x.parent_id, a.depth + 1 FROM ot.agents x JOIN a ON x.id = a.parent_id WHERE a.depth < 1024),
               p(id, parent_id, depth) AS (
                 SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
                 UNION ALL SELECT x.id, x.parent_id, p.depth + 1 FROM ot.agents x JOIN p ON x.id = p.parent_id WHERE p.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM a WHERE id = $2 AND depth > 0) OR EXISTS (SELECT 1 FROM p WHERE id = $1 AND depth > 0)",
            &[&agent, &project],
        )
        .await?
        .get(0))
}

/// Refuse unless `agent` reaches `project`, naming what it tried.
#[logged]
pub async fn require_reach(client: &impl GenericClient, agent: i64, project: &Project, what: &str) -> Result<()> {
    if !reaches(client, agent, project.id).await? {
        crate::refuse!(
            Forbidden,
            "only the agents above or below project {} reach it, and you are neither; cannot {what}",
            project.name
        );
    }
    Ok(())
}

/// One agent watching a project with a `fair_queue` watchdog.
#[derive(Debug, Clone, PartialEq)]
pub struct Watcher {
    /// the dog's row id
    pub row: i64,
    /// the dog's id as its owner knows it
    pub uid: String,
    pub owner: i64,
    pub owner_name: String,
    pub last_fired: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub once: bool,
    pub notice: bool,
}

/// The one watcher a project's next mail goes to: the least recently woken
/// (a watcher never woken comes first), ties to the oldest watcher (created
/// first, then the lower row). The user delegated the choice; this is the
/// coordinator's (2026-10-16 16:13Z). Busy, halted or frozen owners are not
/// filtered here: they stay eligible and read the mail when they next run.
#[logged]
pub fn pick(watchers: &[Watcher]) -> Option<&Watcher> {
    watchers.iter().min_by_key(|w| (w.last_fired, w.created_at, w.row))
}

/// One mail the queue handed out.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Handed {
    /// the project's copy, now read
    pub mail: String,
    /// the watcher's copy
    pub copy: String,
    pub watcher: String,
    pub dog: String,
}

/// What one transaction did.
struct Step {
    handed: Handed,
    project: String,
    watcher_id: i64,
    notice: bool,
    dog_row: i64,
    spent: bool,
}

/// Hand the project's waiting mail out: oldest first, one mail per short
/// transaction, each to the one watcher `pick` names. Stops when no mail
/// waits or nobody eligible watches; the mail then waits in the project's
/// mailbox until a `fair_queue` dog is armed. Runs when mail lands, when a
/// fair-queue dog is armed (create, resume, rehire, engine start).
#[logged]
pub async fn dispatch(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<Vec<Handed>> {
    release_stale(engine, org_id, project).await?;
    let mut out = Vec::new();
    for _ in 0..DISPATCH_BATCH {
        let Some(step) = hand_one(engine, org_id, project).await? else { break };
        if step.spent {
            crate::runtime::watchdogs::disarm(engine, step.dog_row);
        }
        changes::notify_id(engine, org_id, vec![
            Change::Mailbox(project),
            Change::Mailbox(step.watcher_id),
            Change::Watchdogs,
            Change::Spark { from: step.project.clone(), to: step.handed.watcher.clone() },
            Change::EngineEvent(crate::runtime::watchdogs::events::event(
                "mail.waiting",
                crate::runtime::watchdogs::events::Scope::Agent(org_id, step.watcher_id),
                json!({ "agent_id": step.watcher_id, "mail_id": step.handed.copy }),
            )),
        ]);
        if !step.notice {
            crate::runtime::wake(engine, org_id, step.watcher_id);
        } else if let Some(h) = engine.agents.get(step.watcher_id) {
            // a running agent also receives notices at its next tool boundary
            h.send(crate::runtime::AgentMsg::Wake);
        }
        out.push(step.handed);
    }
    Ok(out)
}

#[logged]
async fn hand_one(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<Option<Step>> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    // one dispatcher per project at a time: a row lock on this project only
    // (NO KEY, so documents and other rows referencing it are not held up)
    let Some(p) = tx
        .query_opt("SELECT name, state, scope FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(None);
    };
    let pname: String = p.get(0);
    let ack = ack_mode(&p.get::<_, Value>(2));
    let skip_own = exclude_sender(&p.get::<_, Value>(2));
    if p.get::<_, String>(1) != "live" {
        return Ok(None);
    }
    let rows = tx
        .query(
            &format!("SELECT w.id, w.uid, w.owner_agent_id, a.name, w.last_fired, w.created_at, w.once,
                    coalesce((w.memo->>'notice')::boolean, false)
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'
                -- ack mode: a halted watcher, or one still holding an un-acked
                -- mail from this project, is handed nothing
                AND (NOT $3 OR (a.halt IS NULL AND NOT EXISTS (
                     SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = $2
                        AND (m.extra->'claimed'->>'by_id')::bigint = a.id AND {OUTSTANDING})))
              ORDER BY w.id LIMIT 64"),
            &[&org_id, &project, &ack],
        )
        .await?;
    let mut eligible = Vec::with_capacity(rows.len());
    for r in &rows {
        let owner: i64 = r.get(2);
        // a watcher that has since moved out of the project's line no longer reaches it
        if reaches(&*tx, owner, project).await? {
            eligible.push(Watcher {
                row: r.get(0),
                uid: r.get(1),
                owner,
                owner_name: r.get(3),
                last_fired: r.get(4),
                created_at: r.get(5),
                once: r.get(6),
                notice: r.get(7),
            });
        }
    }
    if eligible.is_empty() {
        return Ok(None);
    }
    // the oldest waiting mail a watcher can take. With the project's
    // exclude-sender setting on (user 2026-10-18 08:07Z-08:08Z; off by
    // default) nobody is handed their own mail, and a mail only its sender
    // could take waits without holding up the rest
    let waiting = tx
        .query(
            "SELECT id, uid, sender, sender_agent_id, sender_generation, kind, notice, body, attachments, reply_to, ev,
                    urgent, urgent_reason, net_id, net_hub, replies, client_op
               FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending' ORDER BY id LIMIT 64 FOR UPDATE",
            &[&project],
        )
        .await?;
    let Some((m, w)) = waiting.iter().find_map(|m| {
        let sender: Option<i64> = m.get(3);
        let others: Vec<Watcher> = eligible.iter().filter(|w| !skip_own || Some(w.owner) != sender).cloned().collect();
        pick(&others).cloned().map(|w| (m, w))
    }) else {
        return Ok(None);
    };
    let mail_id: i64 = m.get(0);
    let mail_uid: String = m.get(1);
    let body: String = m.get(7);
    let notice = m.get::<_, bool>(6) || w.notice;
    let copy = uid("m");
    let via = json!({ "via_project": { "id": project, "name": pname, "mail": mail_uid, "dog": w.uid, "ack": ack } });
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                              recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason,
                              client_op, state, net_id, net_hub, replies, extra)
         VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17, $18, $19, $20)",
        &[
            &copy, &org_id, &m.get::<_, String>(2), &m.get::<_, Option<i64>>(3), &m.get::<_, Option<i32>>(4), &w.owner,
            &w.owner_name, &m.get::<_, String>(5), &notice, &body, &m.get::<_, Value>(8), &m.get::<_, Option<Value>>(9),
            &m.get::<_, Option<Value>>(10), &m.get::<_, bool>(11), &m.get::<_, Option<String>>(12),
            &m.get::<_, Option<String>>(16), &m.get::<_, Option<String>>(13), &m.get::<_, Option<String>>(14),
            &m.get::<_, Value>(15), &via,
        ],
    )
    .await?;
    tx.execute(
        "UPDATE ot.mail SET state = 'read', read_at = now(), delivered_at = coalesce(delivered_at, now()),
                extra = extra || jsonb_build_object('claimed', jsonb_build_object('by', $2::text, 'by_id', $3::bigint,
                        'dog', $4::text, 'copy', $5::text, 'at', now(), 'ack', $6::boolean, 'wakes', 0),
                        'attempts', coalesce((extra->>'attempts')::int, 0) + 1,
                        'attempt_log', coalesce(extra->'attempt_log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                            'n', coalesce((extra->>'attempts')::int, 0) + 1, 'by', $2::text, 'by_id', $3::bigint,
                            'copy', $5::text, 'at', now())))
          WHERE id = $1",
        &[&mail_id, &w.owner_name, &w.owner, &w.uid, &copy, &ack],
    )
    .await?;
    let sender: String = m.get(2);
    let ring = json!([{ "at": iso(Utc::now()), "gist": gist(&format!("mail from {sender}: {body}"), 200) }]);
    let spent: bool = tx
        .query_one(
            "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now(),
                    events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                        SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                         ORDER BY n DESC LIMIT $3) s),
                    spent_at = CASE WHEN once THEN now() ELSE spent_at END,
                    state = CASE WHEN once THEN 'spent' ELSE state END
              WHERE id = $1 RETURNING state = 'spent'",
            &[&w.row, &ring, &EVENTS_KEEP],
        )
        .await?
        .get(0);
    tx.commit().await?;
    Ok(Some(Step {
        handed: Handed { mail: mail_uid, copy, watcher: w.owner_name.clone(), dog: w.uid.clone() },
        project: pname,
        watcher_id: w.owner,
        notice,
        dog_row: w.row,
        spent,
    }))
}

/// The project's waiting (unread) mail, newest first, for inspection by the
/// agents that reach it (user 2026-10-16 16:14Z): nothing is claimed.
#[logged]
pub async fn waiting(client: &impl GenericClient, project: i64, limit: i64) -> Result<(i64, Vec<Value>)> {
    let total: i64 = client
        .query_one("SELECT count(*) FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'", &[&project])
        .await?
        .get(0);
    let rows = client
        .query(
            "SELECT uid, sender, kind, notice, urgent, created_at, body, jsonb_array_length(attachments)
               FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending' ORDER BY id DESC LIMIT $2",
            &[&project, &limit],
        )
        .await?;
    let list = rows
        .iter()
        .map(|r| {
            let mut v = json!({
                "id": r.get::<_, String>(0), "from": r.get::<_, String>(1),
                "kind": crate::domain::mail::shown_kind(&r.get::<_, String>(2)),
                "at": iso(r.get(5)), "preview": gist(&r.get::<_, String>(6), 300),
            });
            if r.get::<_, bool>(3) { v["notice"] = json!(true); }
            if r.get::<_, bool>(4) { v["urgent"] = json!(true); }
            let files: i32 = r.get(7);
            if files > 0 { v["attachments"] = json!(files); }
            v
        })
        .collect();
    Ok((total, list))
}

/// Keep every live project of the org transparent in the credit hierarchy
/// (user 2026-10-16 20:40Z: "as though not present; all credit costs go to
/// the nearest superior above the project"): a project's grant always
/// equals the stake of its live children, so the agent above it holds those
/// stakes and the project never has credits of its own. Called at the end
/// of every tree operation, inside its transaction; nested projects settle
/// over successive passes, innermost changes first. Returns the projects
/// whose grant moved and their parents (whose free credits moved with them).
#[logged]
pub async fn settle_credits(tx: &impl GenericClient, org_id: i64) -> Result<Vec<i64>> {
    let mut changed = Vec::new();
    for _ in 0..64 {
        let rows = tx
            .query(
                "WITH held AS (
                   SELECT p.id, coalesce((SELECT sum(c.seat + c.grant_credits) FROM ot.agents c
                                           WHERE c.parent_id = p.id AND c.state = 'live'), 0) AS stake
                     FROM ot.agents p WHERE p.org_id = $1 AND p.kind = 'project' AND p.state = 'live')
                 UPDATE ot.agents a SET grant_credits = held.stake, seat = 0, row_version = a.row_version + 1
                   FROM held WHERE a.id = held.id AND (a.grant_credits <> held.stake OR a.seat <> 0)
                 RETURNING a.id, a.parent_id",
                &[&org_id],
            )
            .await?;
        if rows.is_empty() {
            break;
        }
        for r in &rows {
            changed.push(r.get::<_, i64>(0));
            changed.extend(r.get::<_, Option<i64>>(1));
        }
    }
    Ok(changed)
}

/// The live projects below `agent` (its descendants, nested ones included),
/// nearest first: the folders an agent above a project holds.
#[logged]
pub async fn below(client: &impl GenericClient, agent: i64) -> Result<Vec<(i64, String)>> {
    Ok(client
        .query(
            "WITH RECURSIVE down(id, depth) AS (
               SELECT id, 1 FROM ot.agents WHERE parent_id = $1 AND state = 'live'
               UNION ALL SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id
                WHERE d.depth < 1024 AND a.state = 'live')
             SELECT a.id, a.name FROM down d JOIN ot.agents a ON a.id = d.id
              WHERE a.kind = 'project' ORDER BY d.depth, a.sibling_order, a.id LIMIT 64",
            &[&agent],
        )
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect())
}

/// Ack mode: put every un-acked mail whose holder is gone back at the front
/// of the queue (it keeps its id, and the queue hands out oldest first).
/// Gone means retired, halted, or without an armed fair_queue dog on the
/// project it still reaches (coordinator 2026-10-18, open to change). The
/// project's copy records who held it and why; the holder's copy is marked
/// released. One short transaction per mail.
#[logged]
pub async fn release_stale(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<Vec<String>> {
    let client = engine.db.get().await?;
    let Some(p) = client.query_opt("SELECT scope FROM ot.agents WHERE id = $1 AND kind = 'project'", &[&project]).await? else {
        return Ok(Vec::new());
    };
    if !ack_mode(&p.get::<_, Value>(0)) {
        return Ok(Vec::new());
    }
    let held = client
        .query(
            &format!("SELECT m.id, (m.extra->'claimed'->>'by_id')::bigint, m.extra->'claimed'->>'by', m.extra->'claimed'->>'copy',
                             coalesce(m.extra->'claimed'->>'dog', '')
                        FROM ot.mail m WHERE m.recipient_agent_id = $1 AND {OUTSTANDING} ORDER BY m.id LIMIT 200"),
            &[&project],
        )
        .await?;
    let mut gone = Vec::new();
    for h in &held {
        let (row, holder): (i64, Option<i64>) = (h.get(0), h.get(1));
        let Some(holder) = holder else { continue };
        let a = client.query_opt("SELECT state, halt IS NOT NULL FROM ot.agents WHERE id = $1", &[&holder]).await?;
        let listening = client
            .query_opt(
                // a one-shot dog that handed this very mail is spent, and still counts
                "SELECT 1 FROM ot.watchdogs w WHERE w.org_id = $1 AND w.kind = 'fair_queue'
                   AND (w.state = 'armed' OR (w.state = 'spent' AND w.uid = $4))
                   AND w.owner_agent_id = $2 AND (w.memo->>'target_id')::bigint = $3 LIMIT 1",
                &[&org_id, &holder, &project, &h.get::<_, String>(4)],
            )
            .await?
            .is_some()
            && reaches(&**client, holder, project).await?;
        let why = match a {
            None => "is gone",
            Some(r) if r.get::<_, String>(0) != "live" => "was retired",
            Some(r) if r.get::<_, bool>(1) => "was halted",
            _ if !listening => "stopped watching the project",
            _ => continue,
        };
        gone.push((row, holder, h.get::<_, Option<String>>(2).unwrap_or_default(), h.get::<_, Option<String>>(3), why));
    }
    drop(client);
    let mut released = Vec::new();
    for (row, holder, by, copy, why) in gone {
        if reclaim(engine, org_id, project, row, holder, &by, copy.as_deref(), why, "released").await?.is_some() {
            released.push(by);
        }
    }
    Ok(released)
}

/// Take an un-acked mail back from its holder: to the front of the queue,
/// or, when it has used up the project's max attempts and the 20-minute
/// checkup is on (user 2026-10-18 08:11Z), to the dead-letter list, which
/// tells the user. One short transaction. `Some(dead)` when it was taken.
#[logged]
#[allow(clippy::too_many_arguments)]
async fn reclaim(engine: &Arc<Engine>, org_id: i64, project: i64, row: i64, holder: i64, by: &str, copy: Option<&str>,
                 why: &str, how: &str) -> Result<Option<bool>> {
    let counted = crate::runtime::reminders::switches(engine).checkups;
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(p) = tx.query_opt("SELECT name, scope FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&project]).await? else {
        return Ok(None);
    };
    let (pname, scope): (String, Value) = (p.get(0), p.get(1));
    let Some(m) = tx
        .query_opt(&format!("SELECT m.uid, coalesce((m.extra->>'attempts')::bigint, 0), m.sender FROM ot.mail m WHERE m.id = $1 AND {OUTSTANDING} FOR UPDATE"),
            &[&row])
        .await?
    else {
        return Ok(None);
    };
    let (uid, attempts, sender): (String, i64, String) = (m.get(0), m.get(1), m.get(2));
    let dead = counted && attempts >= max_attempts(&scope);
    let ended = closed_attempt("m.extra", "$6::text", "$4::text");
    if dead {
        tx.execute(
            &format!("UPDATE ot.mail m SET extra = (({ended}) - 'claimed') || jsonb_build_object('dead_letter', jsonb_build_object(
                    'by', $2::text, 'by_id', $3::bigint, 'why', $4::text, 'how', $6::text, 'attempts', $5::bigint, 'at', now()))
              WHERE m.id = $1"),
            &[&row, &by, &holder, &why, &attempts, &how],
        )
        .await?;
    } else {
        tx.execute(
            &format!("UPDATE ot.mail m SET state = 'pending', read_at = NULL,
                    extra = (({ended}) - 'claimed') || jsonb_build_object('released', jsonb_build_object(
                        'by', $2::text, 'by_id', $3::bigint, 'why', $4::text, 'copy', $5::text, 'at', now()))
              WHERE m.id = $1"),
            &[&row, &by, &holder, &why, &copy, &how],
        )
        .await?;
    }
    if let Some(c) = copy {
        tx.execute(
            "UPDATE ot.mail SET extra = extra || jsonb_build_object('released', jsonb_build_object('why', $2::text, 'at', now()))
              WHERE uid = $1",
            &[&c, &why],
        )
        .await?;
    }
    tx.commit().await?;
    drop(client);
    changes::notify_id(engine, org_id, vec![Change::Mailbox(project), Change::Mailbox(holder)]);
    if dead {
        tracing::warn!(project = %pname, mail = %uid, attempts, "a project mail ran out of attempts and was dead-lettered");
        crate::runtime::watchdogs::events::emit(engine, crate::runtime::watchdogs::events::event(
            "project.dead_letter", crate::runtime::watchdogs::events::Scope::Agent(org_id, project),
            json!({ "project": pname, "mail": uid, "from": sender, "attempts": attempts, "by": by, "why": why })));
        let body = format!(
            "Project {pname} gave up on mail {uid}: it was handed out {attempts} times without an ack (the last holder, {by}, {why}). \
             It is in the project's dead letters (orgtree_project action=dead_letters name={pname}) and will not be handed out again              unless someone retries it.");
        // to the project's superior, the nearest live agent above it; the user
        // for a top-level project (user 2026-10-18 08:13Z)
        let to = superior(engine, project).await.unwrap_or_else(|| "user".into());
        let out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, &to, &body);
        if let Err(e) = Box::pin(crate::domain::mail::send(engine, org_id, out)).await {
            tracing::warn!(error = %format!("{e:#}"), "telling the user of a dead letter failed");
        }
    } else {
        tracing::info!(project = %pname, holder = %by, why, "an un-acked project mail went back to the front of the queue");
    }
    Ok(Some(dead))
}

/// The nearest live agent above a project (projects are crossed), or None
/// when only projects stand above it.
#[logged]
async fn superior(engine: &Arc<Engine>, project: i64) -> Option<String> {
    let client = engine.db.get().await.ok()?;
    client
        .query_opt(
            "WITH RECURSIVE up(id, depth) AS (
               SELECT parent_id, 1 FROM ot.agents WHERE id = $1 AND parent_id IS NOT NULL
               UNION ALL SELECT a.parent_id, u.depth + 1 FROM ot.agents a JOIN up u ON a.id = u.id
                WHERE a.kind = 'project' AND a.parent_id IS NOT NULL AND u.depth < 1024)
             SELECT a.name FROM up u JOIN ot.agents a ON a.id = u.id
              WHERE a.kind = 'agent' AND a.state = 'live' ORDER BY u.depth LIMIT 1",
            &[&project],
        )
        .await
        .ok()
        .flatten()
        .map(|r| r.get(0))
}

/// The ack timeout (user 2026-10-18 08:11Z), run by the working checkup an
/// agent holding un-acked mail is due for: each held mail with the timeout
/// on counts the wake; one that used its project's reminder budget is reclaimed
/// and its project's queue runs. Returns what the agent still holds, for the
/// checkup's note.
#[logged]
pub async fn ack_timeouts(engine: &Arc<Engine>, org_id: i64, agent: i64, name: &str) -> Result<Vec<(String, String)>> {
    let client = engine.db.get().await?;
    let rows = client
        .query(
            &format!("SELECT m.id, m.recipient_agent_id, p.name, p.scope, m.extra->'claimed'->>'copy',
                             coalesce((m.extra->'claimed'->>'wakes')::bigint, 0)
                        FROM ot.mail m JOIN ot.agents p ON p.id = m.recipient_agent_id
                       WHERE (m.extra->'claimed'->>'by_id')::bigint = $1 AND {OUTSTANDING} AND p.kind = 'project'
                       ORDER BY m.id LIMIT 20"),
            &[&agent],
        )
        .await?;
    drop(client);
    let mut kept = Vec::new();
    for r in &rows {
        let (row, project, pname, scope, copy, wakes): (i64, i64, String, Value, Option<String>, i64) =
            (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5));
        if ack_reminders_exhausted(&scope, wakes) {
            let reminders = ack_reminders(&scope);
            let why = format!("did not ack it after {reminders} reminders");
            reclaim(engine, org_id, project, row, agent, name, copy.as_deref(), &why, "timed_out").await?;
            Box::pin(dispatch(engine, org_id, project)).await?;
            continue;
        }
        if ack_timeout(&scope) {
            engine.db.get().await?
                .execute("UPDATE ot.mail SET extra = jsonb_set(extra, '{claimed,wakes}', to_jsonb($2::bigint)) WHERE id = $1",
                    &[&row, &(wakes + 1)])
                .await?;
        }
        if let Some(c) = copy {
            kept.push((c, pname));
        }
    }
    Ok(kept)
}

/// Purge a project's waiting (unassigned) mail (user 2026-10-18 08:11Z):
/// marked retracted, with who purged it; handed, acked and dead-letter mail
/// is untouched. Runs in the op's transaction; returns how many.
#[logged]
pub async fn purge_waiting(tx: &impl GenericClient, project: i64, by: &str) -> Result<u64> {
    Ok(tx
        .execute(
            "UPDATE ot.mail SET state = 'retracted', extra = extra || jsonb_build_object('purged', jsonb_build_object('by', $2::text, 'at', now()))
              WHERE recipient_agent_id = $1 AND state = 'pending'",
            &[&project, &by],
        )
        .await?)
}

/// What an agent's mail to a project is when it answers mail the project
/// handed it in ack mode: the project mail it acks (id, uid). `None` for any
/// other mail, which stays ordinary project mail. Refuses an ack of mail
/// already acked, or released back to the queue. Runs in the sender's
/// transaction, which then stores the ack as a read record.
#[logged]
pub async fn ack_of(tx: &impl GenericClient, project: i64, agent: i64, reply: &str) -> Result<Option<(i64, String)>> {
    let Some(copy) = tx
        .query_opt(
            "SELECT extra->'via_project', extra->'released'->>'why' FROM ot.mail WHERE uid = $1 AND recipient_agent_id = $2",
            &[&reply, &agent],
        )
        .await?
    else {
        return Ok(None);
    };
    let via: Option<Value> = copy.get(0);
    let Some(via) = via.filter(|v| v["id"].as_i64() == Some(project) && v["ack"].as_bool() == Some(true)) else {
        return Ok(None);
    };
    if let Some(why) = copy.get::<_, Option<String>>(1) {
        crate::refuse!(Conflict, "mail {reply} went back to project {}'s queue (you {why}); it is no longer yours to ack",
            via["name"].as_str().unwrap_or("?"));
    }
    let orig = via["mail"].as_str().unwrap_or("").to_string();
    let Some(row) = tx
        .query_opt("SELECT id, extra->'claimed' FROM ot.mail WHERE uid = $1 AND recipient_agent_id = $2 FOR UPDATE", &[&orig, &project])
        .await?
    else {
        return Ok(None);
    };
    let claimed: Option<Value> = row.get(1);
    let claimed = claimed.unwrap_or(Value::Null);
    if claimed["copy"].as_str() != Some(reply) || claimed["ack"].as_bool() != Some(true) {
        return Ok(None);
    }
    if claimed.get("acked_at").is_some_and(|v| !v.is_null()) {
        crate::refuse!(Conflict, "mail {reply} is already acked; nothing more to do for it");
    }
    Ok(Some((row.get(0), orig)))
}

/// The user changed a project's queue mode (`set_mail_queue`): leaving ack
/// mode waives the acks still owed; every watcher (armed or paused) is told
/// what the mode now requires (user 2026-10-18 08:02Z); then the queue runs.
#[logged]
pub async fn mode_changed(engine: &Arc<Engine>, org_id: i64, project: i64, name: &str, ack: bool) -> Result<()> {
    let client = engine.db.get().await?;
    if !ack {
        client
            .execute(
                &format!("UPDATE ot.mail m SET extra = jsonb_set(jsonb_set(m.extra, '{{claimed,ack}}', 'false'),
                                                       '{{claimed,ack_waived_at}}', to_jsonb(now()))
                          WHERE m.recipient_agent_id = $1 AND {OUTSTANDING}"),
                &[&project],
            )
            .await?;
    }
    let owners: Vec<String> = client
        .query(
            "SELECT DISTINCT a.name FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state IN ('armed', 'paused')
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent' ORDER BY 1",
            &[&org_id, &project],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    drop(client);
    let body = if ack {
        format!("Project {name}'s mail queue is now in ACK MODE. Its fair queue hands you ONE mail at a time. When you have \
                 finished one, ack it: orgtree_message to={name} reply_to=<the id of that mail> with a short completion record. \
                 Until you do, the project hands you no more mail; the ack hands you the next one at once if any is waiting.")
    } else {
        format!("Project {name}'s mail queue is now ROUND-ROBIN: each mail goes out as soon as it arrives, and no ack is \
                 needed, including for mail you still hold from ack mode.")
    };
    for to in owners {
        let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, &to, &body);
        out.notice = true;
        out.grant_reply_audience = false;
        Box::pin(crate::domain::mail::send(engine, org_id, out)).await?;
    }
    Box::pin(dispatch(engine, org_id, project)).await?;
    Ok(())
}

/// Run the queues an agent's change can move (halt, unhalt, retire, a
/// fair_queue dog paused or removed): the projects it holds un-acked mail
/// from, which then release it, and the ones it watches.
#[logged]
pub async fn recheck_holder(engine: &Arc<Engine>, org_id: i64, agent: i64) {
    let projects: Vec<i64> = match engine.db.get().await {
        Ok(c) => c
            .query(
                &format!("SELECT DISTINCT m.recipient_agent_id FROM ot.mail m
                           WHERE m.org_id = $1 AND (m.extra->'claimed'->>'by_id')::bigint = $2 AND {OUTSTANDING}
                          UNION SELECT DISTINCT (w.memo->>'target_id')::bigint FROM ot.watchdogs w
                           WHERE w.org_id = $1 AND w.owner_agent_id = $2 AND w.kind = 'fair_queue'
                             AND w.memo ? 'target_id' LIMIT 64"),
                &[&org_id, &agent],
            )
            .await
            .map(|rows| rows.iter().filter_map(|r| r.get::<_, Option<i64>>(0)).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for p in projects {
        if let Err(e) = Box::pin(dispatch(engine, org_id, p)).await {
            tracing::warn!(project = p, error = %format!("{e:#}"), "project queue recheck failed");
        }
    }
    // its slots too (domain/slots.rs): a halted or retired holder loses its
    // slot, and an unhalted claimant may be granted one
    let slot_projects = match engine.db.get().await {
        Ok(c) => crate::domain::slots::projects_of(&**c, agent).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for p in slot_projects {
        if let Err(e) = Box::pin(crate::domain::slots::check(engine, org_id, p)).await {
            tracing::warn!(project = p, error = %format!("{e:#}"), "project slots recheck failed");
        }
    }
}

/// The un-acked mail an agent holds, as (handed copy's id, project name),
/// from projects in ack mode that still have a watcher: what its working
/// checkup reminds it of (user 2026-10-18 08:04Z).
#[logged]
pub async fn held_by(client: &impl GenericClient, agent: i64) -> Result<Vec<(String, String)>> {
    Ok(client
        .query(
            &format!("SELECT m.extra->'claimed'->>'copy', p.name FROM ot.mail m JOIN ot.agents p ON p.id = m.recipient_agent_id
                       WHERE (m.extra->'claimed'->>'by_id')::bigint = $1 AND {OUTSTANDING}
                         AND p.kind = 'project' AND p.scope->>'mail_queue' = 'ack'
                         AND EXISTS (SELECT 1 FROM ot.watchdogs w WHERE w.kind = 'fair_queue' AND w.state = 'armed'
                                       AND (w.memo->>'target_id')::bigint = p.id)
                       ORDER BY m.id LIMIT 20"),
            &[&agent],
        )
        .await?
        .iter()
        .filter_map(|r| Some((r.get::<_, Option<String>>(0)?, r.get(1))))
        .collect())
}

/// Whether anyone could take the project's next mail: an armed fair_queue dog
/// on it, owned by a live agent that still reaches it (the set `hand_one`
/// picks from).
#[logged]
pub async fn watched(client: &impl GenericClient, org_id: i64, project: i64) -> Result<bool> {
    let rows = client
        .query(
            "SELECT w.owner_agent_id FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'
              ORDER BY w.id LIMIT 64",
            &[&org_id, &project],
        )
        .await?;
    for r in &rows {
        if reaches(client, r.get(0), project).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// How a project's queue stands, for the note a waiting mail's sender is given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueueState {
    /// agents with an armed fair_queue dog on the project that still reach it
    pub listeners: i64,
    /// of those, ack mode: holding an un-acked job from the project
    pub holding: i64,
    /// of those, ack mode: halted (handed nothing)
    pub halted: i64,
    /// agents whose only fair_queue dogs on the project are paused
    pub paused: i64,
    /// the mail's place among the project's waiting mail (1 = next), when known
    pub position: Option<i64>,
}

/// The sender's note for mail that waits in the queue (it was not handed out
/// at once). Says who could take it and why not, with its place in line.
#[nolog]
pub fn wait_note(project: &str, st: &QueueState) -> String {
    let place = st.position.map(|k| format!(" (position {k} in line)")).unwrap_or_default();
    let who = |n: i64| if n == 1 { "1 listener".to_string() } else { format!("{n} listeners") };
    if st.listeners == 0 && st.paused == 0 {
        return format!(
            "Queued in project {project}'s mailbox{place}. No agent watches the project with a fair_queue watchdog right now, so it waits there until one does; agents above or below the project can see it with orgtree_inbox project={project}.");
    }
    if st.listeners == 0 {
        return format!(
            "Queued in project {project}'s mailbox{place}. Its {} paused (their fair_queue watchdogs are paused), so it waits there until one resumes or another agent starts watching.",
            if st.paused == 1 { "only listener is".to_string() } else { format!("{} listeners are", st.paused) });
    }
    let n = st.listeners;
    let paused = if st.paused > 0 { format!("; {} more paused", who(st.paused)) } else { String::new() };
    if st.holding == n {
        return format!(
            "Queued in project {project}'s mailbox{place}: {}, all holding an un-acked job; it is handed out as soon as one of them acks{paused}.", who(n));
    }
    if st.holding + st.halted == n && st.halted > 0 {
        let holding = if st.holding > 0 { format!("{} holding an un-acked job, ", st.holding) } else { String::new() };
        return format!(
            "Queued in project {project}'s mailbox{place}: {}, {holding}{} halted; it is handed out when one is free to take it{paused}.", who(n), st.halted);
    }
    format!("Queued in project {project}'s mailbox{place}; it goes to the next of its {} to become eligible{paused}.", who(n))
}

/// Read how a project's queue stands now; `mail` is the waiting mail whose
/// place in line is wanted (its uid).
#[logged]
pub async fn queue_state(client: &impl GenericClient, org_id: i64, project: i64, mail: Option<&str>) -> Result<QueueState> {
    let ack = match client.query_opt("SELECT scope FROM ot.agents WHERE id = $1", &[&project]).await? {
        Some(r) => ack_mode(&r.get::<_, Value>(0)),
        None => false,
    };
    let rows = client
        .query(
            &format!("SELECT a.id, a.halt IS NOT NULL,
                    EXISTS (SELECT 1 FROM ot.mail m WHERE m.recipient_agent_id = $2
                             AND (m.extra->'claimed'->>'by_id')::bigint = a.id AND {OUTSTANDING})
               FROM ot.agents a
              WHERE a.state = 'live' AND a.kind = 'agent' AND a.id IN (
                    SELECT w.owner_agent_id FROM ot.watchdogs w WHERE w.org_id = $1 AND w.kind = 'fair_queue'
                       AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $2)
              ORDER BY a.id LIMIT 64"),
            &[&org_id, &project],
        )
        .await?;
    let mut st = QueueState::default();
    for r in &rows {
        let id: i64 = r.get(0);
        if !reaches(client, id, project).await? {
            continue;
        }
        st.listeners += 1;
        if ack {
            if r.get::<_, bool>(1) {
                st.halted += 1;
            } else if r.get::<_, bool>(2) {
                st.holding += 1;
            }
        }
    }
    st.paused = client
        .query_one(
            "SELECT count(DISTINCT w.owner_agent_id) FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'paused' AND (w.memo->>'target_id')::bigint = $2
                AND a.state = 'live' AND a.kind = 'agent'
                AND NOT EXISTS (SELECT 1 FROM ot.watchdogs x WHERE x.kind = 'fair_queue' AND x.state = 'armed'
                                 AND x.owner_agent_id = w.owner_agent_id AND (x.memo->>'target_id')::bigint = $2)",
            &[&org_id, &project],
        )
        .await?
        .get(0);
    if let Some(uid) = mail {
        st.position = client
            .query_opt(
                "SELECT count(*) FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
                    AND id <= (SELECT id FROM ot.mail WHERE uid = $2)",
                &[&project, &uid],
            )
            .await?
            .map(|r| r.get::<_, i64>(0))
            .filter(|n| *n > 0);
    }
    Ok(st)
}

/// First line of a job, for the reminder (the mail body, cut short).
#[nolog]
fn first_line(body: &str) -> String {
    gist(body.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim(), 120)
}

/// A listener ended a turn: remind it ONCE, right away, of every un-acked job
/// it still holds whose project has the setting on (user 2026-10-18
/// 18:05Z-18:06Z). Skipped for a job whose handed copy the agent has not read
/// yet (its next turn will), for an agent that is halted, retired or whose
/// latest status, set after it took the job, is `blocked` with a reason (those
/// jobs get only the normal 20-minute reminders), and for a job already
/// reminded. The caller does not call this for a turn that was interrupted,
/// failed, hit a usage limit or froze the agent. The reminder is system mail,
/// which starts one new turn; it does not force the turn to keep running.
/// Returns how many jobs it named.
#[logged]
pub async fn remind_unfinished(engine: &Arc<Engine>, org_id: i64, agent: i64, name: &str) -> Result<usize> {
    let rows = {
        let client = engine.db.get().await?;
        client
            .query(
                &format!("SELECT m.id, m.extra->'claimed'->>'copy', p.name, m.body
                            FROM ot.mail m JOIN ot.agents p ON p.id = m.recipient_agent_id AND p.kind = 'project'
                            JOIN ot.agents a ON a.id = $1
                           WHERE (m.extra->'claimed'->>'by_id')::bigint = $1 AND {OUTSTANDING}
                             AND a.state = 'live' AND a.halt IS NULL
                             AND coalesce((p.scope->>'mail_queue_turn_end_reminder')::boolean, true)
                             AND m.extra->'claimed'->>'reminded_at' IS NULL
                             AND EXISTS (SELECT 1 FROM ot.mail c WHERE c.uid = m.extra->'claimed'->>'copy'
                                          AND c.state NOT IN ('pending', 'delivering', 'retracted'))
                             AND NOT (a.last_status->>'status' = 'blocked'
                                      AND length(trim(coalesce(a.last_status->>'summary', ''))) > 0
                                      AND (a.last_status->>'at')::timestamptz >= (m.extra->'claimed'->>'at')::timestamptz)
                           ORDER BY m.id LIMIT 20"),
                &[&agent],
            )
            .await?
    };
    let mut named = Vec::new();
    for r in &rows {
        let (row, copy, pname, body): (i64, Option<String>, String, String) = (r.get(0), r.get(1), r.get(2), r.get(3));
        let marked = engine.db.get().await?
            .execute(
                "UPDATE ot.mail SET extra = jsonb_set(extra, '{claimed,reminded_at}', to_jsonb(now()))
                  WHERE id = $1 AND extra->'claimed'->>'reminded_at' IS NULL",
                &[&row],
            )
            .await?;
        if marked == 1 {
            if let Some(c) = copy {
                named.push((c, pname, first_line(&body)));
            }
        }
    }
    if named.is_empty() {
        return Ok(0);
    }
    let list = named.iter()
        .map(|(c, p, line)| format!("- {c} (project {p}): {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let how = named.iter().map(|(c, p, _)| format!("orgtree_message to={p} reply_to={c}")).collect::<Vec<_>>().join(" / ");
    let body = format!(
        "You still hold {} un-acked job{} from a project work queue; your turn ended without acking {}:\n{list}\n\
         Finish {} and ack {} ({how} with a short completion record), or set your status to blocked with the reason \
         (orgtree_status status=blocked summary=...). Until you ack, the project hands you no more jobs.",
        named.len(), if named.len() == 1 { "" } else { "s" }, if named.len() == 1 { "it" } else { "them" },
        if named.len() == 1 { "it" } else { "them" }, if named.len() == 1 { "it" } else { "each" });
    let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, name, &body);
    out.grant_reply_audience = false;
    Box::pin(crate::domain::mail::send(engine, org_id, out)).await?;
    Ok(named.len())
}

/// The one agent asked to arm a fair_queue dog when the user writes to a
/// project nobody watches (user 2026-10-18 07:46Z; coordinator 07:47Z): a
/// live, unhalted agent directly under the project, an idle one first, else
/// the first in sibling order.
#[logged]
pub async fn nudge_target(engine: &Engine, client: &impl GenericClient, project: i64) -> Result<Option<(i64, String)>> {
    let rows = client
        .query(
            "SELECT id, name FROM ot.agents WHERE parent_id = $1 AND state = 'live' AND kind = 'agent' AND halt IS NULL
              ORDER BY sibling_order, id LIMIT 64",
            &[&project],
        )
        .await?;
    let members: Vec<(i64, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    let busy = |id: i64| engine.agents.get(id)
        .map(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false))
        .unwrap_or(false);
    Ok(members.iter().find(|(id, _)| !busy(*id)).or_else(|| members.first()).cloned())
}

/// The live agents under `project`, through live nested projects (the
/// projects themselves left out), nearest first: who a message from the
/// project desk reaches (user 2026-10-18 07:33Z, "broadcasts the message to
/// all project participants at once").
#[logged]
pub async fn members(client: &impl GenericClient, project: i64) -> Result<Vec<String>> {
    Ok(client
        .query(
            "WITH RECURSIVE down(id, depth) AS (
               SELECT id, 1 FROM ot.agents WHERE parent_id = $1 AND state = 'live'
               UNION ALL SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id
                WHERE d.depth < 1024 AND a.state = 'live')
             SELECT a.name FROM down d JOIN ot.agents a ON a.id = d.id
              WHERE a.kind IS DISTINCT FROM 'project' ORDER BY d.depth, a.sibling_order, a.id LIMIT 1000",
            &[&project],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_760_000_000 + s, 0).unwrap()
    }

    fn w(row: i64, last: Option<i64>, created: i64) -> Watcher {
        Watcher { row, uid: format!("q{row}"), owner: row * 10, owner_name: format!("a{row}"), last_fired: last.map(at),
                  created_at: at(created), once: false, notice: false }
    }

    #[test]
    fn the_least_recently_woken_watcher_gets_the_next_mail() {
        let ws = vec![w(1, Some(50), 0), w(2, Some(10), 5), w(3, Some(30), 1)];
        assert_eq!(pick(&ws).map(|x| x.row), Some(2));
    }

    #[test]
    fn a_watcher_never_woken_comes_first_and_ties_go_to_the_oldest() {
        let ws = vec![w(1, Some(1), 0), w(2, None, 9), w(3, None, 4)];
        assert_eq!(pick(&ws).map(|x| x.row), Some(3), "never woken first; of those, the oldest watcher");
        let same = vec![w(7, Some(5), 3), w(4, Some(5), 3), w(9, Some(5), 1)];
        assert_eq!(pick(&same).map(|x| x.row), Some(9), "same last wake: the oldest watcher");
        let twins = vec![w(7, Some(5), 3), w(4, Some(5), 3)];
        assert_eq!(pick(&twins).map(|x| x.row), Some(4), "same age too: the lower row");
        assert!(pick(&[]).is_none());
    }

    fn st(listeners: i64, holding: i64, halted: i64, paused: i64, position: Option<i64>) -> QueueState {
        QueueState { listeners, holding, halted, paused, position }
    }

    #[test]
    fn nobody_watching_keeps_the_old_text() {
        let t = wait_note("q", &st(0, 0, 0, 0, Some(1)));
        assert!(t.contains("No agent watches") && t.contains("position 1"), "{t}");
    }

    #[test]
    fn all_listeners_holding_a_job_is_said_with_the_place_in_line() {
        let t = wait_note("q", &st(3, 3, 0, 0, Some(2)));
        assert!(t.contains("3 listeners, all holding an un-acked job") && t.contains("position 2 in line"), "{t}");
        assert!(!t.contains("No agent watches"), "{t}");
        assert!(wait_note("q", &st(1, 1, 0, 0, None)).contains("1 listener, all holding"), "singular");
        assert!(!wait_note("q", &st(2, 2, 0, 0, None)).contains("position"), "no place when it is unknown");
    }

    #[test]
    fn halted_and_paused_listeners_are_named_not_called_absent() {
        let t = wait_note("q", &st(3, 1, 2, 0, Some(1)));
        assert!(t.contains("1 holding an un-acked job, 2 halted"), "{t}");
        let p = wait_note("q", &st(0, 0, 0, 1, Some(1)));
        assert!(p.contains("only listener is paused") && !p.contains("No agent watches"), "{p}");
        let m = wait_note("q", &st(2, 2, 0, 1, None));
        assert!(m.contains("1 listener more paused") || m.contains("1 listener paused") || m.contains("more paused"), "{m}");
    }

    #[test]
    fn the_turn_end_reminder_is_on_unless_the_project_turns_it_off() {
        assert!(turn_end_reminder(&json!({})));
        assert!(turn_end_reminder(&json!({"mail_queue_turn_end_reminder": true})));
        assert!(!turn_end_reminder(&json!({"mail_queue_turn_end_reminder": false})));
        assert!(turn_end_reminder(&json!({"mail_queue_turn_end_reminder": "no"})), "only an explicit false turns it off");
    }

    #[test]
    fn a_job_is_named_by_its_first_non_empty_line() {
        assert_eq!(first_line("\n\n  Fix the build  \nmore"), "Fix the build");
        assert_eq!(first_line(""), "");
    }

    #[test]
    fn round_robin_over_successive_mails() {
        // each handed mail makes its watcher the most recently woken
        let mut ws = vec![w(1, None, 0), w(2, None, 1), w(3, None, 2)];
        let mut order = Vec::new();
        for t in 100..106 {
            let row = pick(&ws).unwrap().row;
            order.push(row);
            ws.iter_mut().find(|x| x.row == row).unwrap().last_fired = Some(at(t));
        }
        assert_eq!(order, vec![1, 2, 3, 1, 2, 3]);
    }
}
