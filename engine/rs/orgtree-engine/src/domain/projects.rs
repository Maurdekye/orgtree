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
//! as it arrives; ack mode caps unacked mails at each watcher's batch size
//! (default one). Each mail needs its own completion record, a reply sent
//! to the project's mailbox. An un-acked mail goes back to the front of the
//! queue when its holder is retired, halted or stops watching.

use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::util::{gist, iso, uid};
use crate::domain::user_regs::USER;

#[cfg(test)]
mod claim_boundary_tests;
mod credit_settlement;
#[cfg(test)]
mod credit_scale_tests;
#[cfg(test)]
mod broadcast_tests;

/// Physical ancestry only: root-first rows and locks, never the reporting superior.
#[logged]
pub(crate) async fn locked_ancestor_rows(tx: &tokio_postgres::Transaction<'_>, id: i64, columns: &str) -> Result<Vec<tokio_postgres::Row>> {
    Ok(tx.query(&format!(
        "WITH RECURSIVE up(id,parent_id) AS (
           SELECT id,parent_id FROM ot.agents WHERE id=$1
           UNION SELECT a.id,a.parent_id FROM ot.agents a JOIN up u ON a.id=u.parent_id),
         root_first(id,depth) AS (
           SELECT id,0 FROM up WHERE parent_id IS NULL
           UNION ALL SELECT u.id,r.depth+1 FROM up u JOIN root_first r ON u.parent_id=r.id)
         SELECT {columns} FROM ot.agents a JOIN root_first r ON a.id=r.id
         ORDER BY r.depth FOR UPDATE OF a"), &[&id]).await?)
}

/// Physical scope-chain order only; the caller still skips projects and clamps tools.
/// Columns are scope, parent, depth, kind, id; existing tool callers keep their indices.
#[logged]
pub(crate) async fn scope_ancestor_rows<C: GenericClient + Sync>(client: &C, agent_id: i64, org_id: i64) -> Result<Vec<tokio_postgres::Row>> {
    Ok(client.query(
        "WITH RECURSIVE chain(id,parent_id,scope,kind) AS (
           SELECT id,parent_id,scope,kind FROM ot.agents WHERE id=$1 AND org_id=$2
           UNION SELECT a.id,a.parent_id,a.scope,a.kind FROM ot.agents a JOIN chain c ON a.id=c.parent_id
             WHERE a.org_id=$2),
         root_first(id,depth) AS (
           SELECT id,0 FROM chain WHERE parent_id IS NULL
           UNION ALL SELECT c.id,r.depth+1 FROM chain c JOIN root_first r ON c.parent_id=r.id)
         SELECT c.scope,c.parent_id,r.depth,c.kind,c.id FROM chain c JOIN root_first r ON c.id=r.id
         ORDER BY r.depth", &[&agent_id, &org_id]).await?)
}

/// `ot.agents.kind` of a project node.
pub const KIND: &str = "project";
/// The `tier` a project row stores: a sentinel, never a catalog tier.
pub const TIER: &str = "project";
/// Mails one `dispatch` call hands out before it yields to the next trigger.
const DISPATCH_BATCH: usize = 200;
/// Fires a fair-queue dog keeps in its `events` ring (as the other kinds).
const EVENTS_KEEP: i64 = 50;
/// Maximum messages per listener in one committed assignment round.
pub const MAX_QUEUE_BATCH: u64 = 20;
#[nolog]
pub fn batch_size(memo: &Value) -> usize {
    memo["batch"].as_u64().filter(|n| (1..=MAX_QUEUE_BATCH).contains(n)).unwrap_or(1) as usize
}
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
               a(id, parent_id, org_id) AS (
                 SELECT id, parent_id, org_id FROM ot.agents WHERE id = $1
                 UNION SELECT x.id, x.parent_id, x.org_id FROM ot.agents x JOIN a ON x.id = a.parent_id AND x.org_id = a.org_id),
               p(id, parent_id, org_id) AS (
                 SELECT id, parent_id, org_id FROM ot.agents WHERE id = $2
                 UNION SELECT x.id, x.parent_id, x.org_id FROM ot.agents x JOIN p ON x.id = p.parent_id AND x.org_id = p.org_id)
             SELECT EXISTS (SELECT 1 FROM a WHERE id = $2 AND id <> $1) OR EXISTS (SELECT 1 FROM p WHERE id = $1 AND id <> $2)",
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
    /// the watching agent; None is the user's own listener (docket
    /// let-the-user-manually-hold-a-number-of-a-project), named `"user"`:
    /// it takes its turn in the round-robin like any other
    pub owner: Option<i64>,
    pub owner_name: String,
    pub last_fired: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub once: bool,
    pub notice: bool,
    /// Remaining capacity in this assignment round (also bounded by unacked mail).
    pub remaining: usize,
    /// when its last job ended (acked or taken back): `memo.run.freed_at`
    pub freed_at: Option<DateTime<Utc>>,
}

impl Watcher {
    /// Since when it has waited for mail: its arming, its last hand-out or
    /// its last job's end, whichever is latest (the desk's Waited, user
    /// 2026-10-20 06:22Z). Recorded with each hand-out as `waited_from`.
    #[nolog]
    pub fn waiting_since(&self) -> DateTime<Utc> {
        [self.last_fired, self.freed_at].into_iter().flatten().fold(self.created_at, |a, b| a.max(b))
    }
}

/// The one watcher a project's next mail goes to: the least recently woken
/// (a watcher never woken comes first), ties to the oldest watcher (created
/// first, then the lower row). The user delegated the choice; this is the
/// coordinator's (2026-10-16 16:13Z). Busy, halted or frozen owners are not
/// filtered here: they stay eligible and read the mail when they next run.
#[logged]
pub fn pick(watchers: &[Watcher]) -> Option<&Watcher> {
    watchers.iter().filter(|w| w.remaining > 0).min_by_key(|w| (w.last_fired, w.created_at, w.row))
}

/// [`pick`] for a mail taken back from some of its holders (the desk's take
/// back, user 2026-10-20 06:42Z): another listener first; one it was taken
/// from only when nobody else can take it.
#[logged]
pub fn pick_avoiding<'a>(watchers: &'a [Watcher], taken_from: &[i64]) -> Option<&'a Watcher> {
    if taken_from.is_empty() {
        return pick(watchers);
    }
    let others: Vec<Watcher> = watchers.iter().filter(|w| !w.owner.is_some_and(|o| taken_from.contains(&o))).cloned().collect();
    match pick(&others) {
        Some(o) => watchers.iter().find(|w| w.row == o.row),
        None => pick(watchers),
    }
}

/// Is this watcher the mail's own sender (the exclude-sender setting hands
/// nobody their own mail)? The user's listener is the sender of the mail
/// the user wrote (`@user`).
#[nolog]
fn is_sender(w: &Watcher, sender: Option<i64>, sender_name: &str) -> bool {
    match w.owner {
        Some(agent) => Some(agent) == sender,
        None => sender_name == "@user",
    }
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
    /// None: the job went to the user's inbox
    watcher_id: Option<i64>,
    notice: bool,
    dog_row: i64,
    spent: bool,
}

/// Hand the project's waiting mail out: oldest first, bounded assignment
/// rounds committed before one wake per recipient. `pick` still deals each
/// message separately, so larger batches do not skip other listeners. Stops when no mail
/// waits or nobody eligible watches; the mail then waits in the project's
/// mailbox until a `fair_queue` dog is armed. Runs when mail lands, when a
/// fair-queue dog is armed (create, resume, rehire, engine start).
#[logged]
pub async fn dispatch(engine: &Arc<Engine>, org_id: i64, project: i64) -> Result<Vec<Handed>> {
    release_stale(engine, org_id, project).await?;
    let mut out = Vec::new();
    while out.len() < DISPATCH_BATCH {
        let steps = hand_batch(engine, org_id, project, (DISPATCH_BATCH - out.len()).min(64)).await?;
        if steps.is_empty() { break; }
        out.extend(notify_handed(engine, org_id, project, steps));
    }
    Ok(out)
}

/// Publish committed queue changes. A create-time candidate (row 0) has
/// already consumed its copies through the tool result, so it never wakes.
#[logged]
fn notify_handed(engine: &Arc<Engine>, org_id: i64, project: i64, steps: Vec<Step>) -> Vec<Handed> {
        let mut out = Vec::new();
        let mut wakes: HashMap<i64, bool> = HashMap::new();
        for step in steps {
            if step.dog_row == 0 {
                let mut ch = vec![Change::Mailbox(project)];
                if let Some(owner) = step.watcher_id { ch.push(Change::Mailbox(owner)); }
                changes::notify_id(engine, org_id, ch);
                out.push(step.handed);
                continue;
            }
            if step.spent {
                crate::runtime::watchdogs::disarm(engine, step.dog_row);
            }
            let mut ch = vec![Change::Mailbox(project), Change::Watchdogs,
                Change::Spark { from: step.project.clone(), to: step.handed.watcher.clone() }];
            match step.watcher_id {
                Some(watcher_id) => {
                    ch.push(Change::Mailbox(watcher_id));
                    ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event(
                        "mail.waiting",
                        crate::runtime::watchdogs::events::Scope::Agent(org_id, watcher_id),
                        json!({ "agent_id": watcher_id, "mail_id": step.handed.copy }),
                    )));
                    *wakes.entry(watcher_id).or_default() |= !step.notice;
                }
                // the user's job arrives in their inbox: nobody to wake
                None => ch.push(Change::UserMail),
            }
            changes::notify_id(engine, org_id, ch);
            out.push(step.handed);
        }
        for (watcher, wake) in wakes {
            if wake {
                crate::runtime::wake(engine, org_id, watcher);
            } else if let Some(h) = engine.agents.get(watcher) {
                // a running agent also receives notices at its next tool boundary
                h.send(crate::runtime::AgentMsg::Wake);
            }
        }
    out
}

#[logged]
async fn hand_batch(engine: &Arc<Engine>, org_id: i64, project: i64, limit: usize) -> Result<Vec<Step>> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let steps = hand_batch_in(&*tx, org_id, project, limit, None).await?;
    tx.commit().await?;
    Ok(steps)
}

/// The normal queue allocator with a transient one-shot listener. A probe
/// that assigns this listener nothing rolls back, including other handouts.
// Full mail bodies belong only in the tool result, never invocation logs.
#[nolog]
pub async fn take_once(engine: &Arc<Engine>, org_id: i64, project: i64, owner: i64, name: &str, dog: &str, batch: usize) -> Result<Option<Vec<Value>>> {
    release_stale(engine, org_id, project).await?;
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let candidate = Watcher { row: 0, uid: dog.to_string(), owner: Some(owner), owner_name: name.to_string(),
        last_fired: None, created_at: Utc::now(), once: true, notice: false, remaining: batch, freed_at: None };
    let steps = hand_batch_in(&*tx, org_id, project, 64, Some(candidate)).await?;
    let copies: Vec<String> = steps.iter().filter(|s| s.dog_row == 0).map(|s| s.handed.copy.clone()).collect();
    if copies.is_empty() { return Ok(None); }
    let rows = tx.query("SELECT to_jsonb(m) FROM ot.mail m WHERE uid=ANY($1) ORDER BY id", &[&copies]).await?;
    let consumed = tx.query("SELECT uid,kind,org_id,net_id,net_hub,sender_agent_id FROM ot.mail WHERE uid=ANY($1)", &[&copies]).await?;
    tx.commit().await?;
    drop(client);
    let raw:Vec<Value>=rows.iter().map(|r|r.get(0)).collect();
    let mail:Vec<_>=raw.iter().map(crate::runtime::actor::mail_of).collect();
    let senders=mail.iter().map(|m|m.sender.clone()).collect::<Vec<_>>();
    let rels=crate::runtime::envelope::relationships(engine,owner,&senders).await.unwrap_or_default();
    let messages=mail.iter().zip(&raw).map(|(m,r)|json!({"id":m.uid,"message_id":m.uid,"from":m.sender,
        "kind":crate::domain::mail::shown_kind(&m.kind),"body":m.body,"at":iso(m.at),
        "content":crate::runtime::envelope::mail_block(&[m],&rels,false),
        "attachments":m.attachments.as_array().into_iter().flatten().filter(|a|a["transfer_removed"]!=true).cloned().collect::<Vec<_>>(),
        "reply_to":m.reply_to,"replies":m.replies,"via_project":r["extra"]["via_project"],"direction":"received",
        "state":"read","will_redeliver":false})).collect();
    notify_handed(engine, org_id, project, steps);
    let receipts = crate::domain::mail::consumed(engine, &consumed);
    crate::runtime::watchdogs::events::mail_delivered(engine, org_id, owner, receipts);
    Ok(Some(messages))
}

#[logged]
async fn hand_batch_in(tx: &impl GenericClient, org_id: i64, project: i64, limit: usize, inline: Option<Watcher>) -> Result<Vec<Step>> {
    // one dispatcher per project at a time: a row lock on this project only
    // (NO KEY, so documents and other rows referencing it are not held up)
    let Some(p) = tx
        .query_opt("SELECT name, state, scope FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(Vec::new());
    };
    let pname: String = p.get(0);
    let ack = ack_mode(&p.get::<_, Value>(2));
    let skip_own = exclude_sender(&p.get::<_, Value>(2));
    if p.get::<_, String>(1) != "live" {
        return Ok(Vec::new());
    }
    let rows = tx
        .query(
            // the user's listener has no agent row (LEFT JOIN): it is always
            // eligible, never halted, and its held jobs are counted by `by_user`
            &format!("SELECT w.id, w.uid, w.owner_agent_id, coalesce(a.name, '{USER}'), w.last_fired, w.created_at, w.once,
                    coalesce((w.memo->>'notice')::boolean, false), w.memo,
                    held.n
               FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
               CROSS JOIN LATERAL (SELECT count(*) AS n FROM ot.mail m WHERE m.recipient_agent_id = $2
                       AND CASE WHEN w.owner_kind = 'user' THEN m.extra->'claimed'->>'by_user' = 'true'
                                ELSE (m.extra->'claimed'->>'by_id')::bigint = a.id END AND {OUTSTANDING}) held
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2
                AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent' AND (NOT $3 OR a.halt IS NULL)))
                AND NOT EXISTS (SELECT 1 FROM ot.watchdogs older WHERE older.org_id=w.org_id
                      AND older.kind='fair_queue' AND older.state='armed' AND older.id<w.id
                      AND older.owner_agent_id IS NOT DISTINCT FROM w.owner_agent_id
                      AND (older.memo->>'target_id')::bigint=$2)
                AND (w.owner_kind='user' OR EXISTS (
                    WITH RECURSIVE owners(id,parent_id,org_id) AS (
                      SELECT id,parent_id,org_id FROM ot.agents WHERE id=a.id
                      UNION SELECT x.id,x.parent_id,x.org_id FROM ot.agents x JOIN owners o ON x.id=o.parent_id AND x.org_id=o.org_id),
                    project_line(id,parent_id,org_id) AS (
                      SELECT id,parent_id,org_id FROM ot.agents WHERE id=$2
                      UNION SELECT x.id,x.parent_id,x.org_id FROM ot.agents x JOIN project_line p ON x.id=p.parent_id AND x.org_id=p.org_id)
                    SELECT 1 FROM owners WHERE id=$2 AND id<>a.id
                    UNION ALL SELECT 1 FROM project_line WHERE id=a.id AND id<>$2))
                AND (NOT $3 OR held.n < CASE WHEN w.memo->>'batch' IN
                      ('1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20')
                      THEN (w.memo->>'batch')::int ELSE 1 END)
              ORDER BY w.last_fired NULLS FIRST, w.created_at, w.id LIMIT 64 FOR UPDATE OF w"),
            &[&org_id, &project, &ack],
        )
        .await?;
    let mut eligible: Vec<Watcher> = Vec::with_capacity(rows.len());
    for r in &rows {
        let owner: Option<i64> = r.get(2);
        // Legacy duplicate registrations must not multiply an agent's share
        // or ACK capacity. The oldest armed dog is its canonical listener.
        if eligible.iter().any(|w| w.owner == owner) { continue; }
        // a watcher that has since moved out of the project's line no longer reaches it
        // (the user, who listens from the desk, reaches every project)
        let reached = match owner {
            Some(agent) => reaches(&*tx, agent, project).await?,
            None => true,
        };
        if reached {
            let memo: Value = r.get(8);
            eligible.push(Watcher {
                row: r.get(0),
                uid: r.get(1),
                owner,
                owner_name: r.get(3),
                last_fired: r.get(4),
                created_at: r.get(5),
                once: r.get(6),
                notice: r.get(7),
                remaining: batch_size(&memo).saturating_sub(if ack { r.get::<_, i64>(9) as usize } else { 0 }),
                freed_at: memo["run"]["freed_at"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc)),
            });
        }
    }
    if let Some(mut candidate) = inline {
        let owner = candidate.owner.unwrap();
        if tx.query_opt("SELECT 1 FROM ot.watchdogs WHERE kind='fair_queue' AND owner_agent_id=$1 AND state IN ('armed','paused') AND (memo->>'target_id')::bigint=$2 LIMIT 1", &[&owner,&project]).await?.is_some() {
            crate::refuse!(Conflict,"you already watch this project's mailbox; keep using that listener");
        }
        let active = tx.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND state='live' AND kind='agent' AND (NOT $2 OR halt IS NULL)", &[&owner,&ack]).await?.is_some();
        if active && reaches(tx, owner, project).await? {
            if ack {
                let held: i64 = tx.query_one(&format!("SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id=$1 AND (m.extra->'claimed'->>'by_id')::bigint=$2 AND {OUTSTANDING}"), &[&project,&owner]).await?.get(0);
                candidate.remaining = candidate.remaining.saturating_sub(held as usize);
            }
            eligible.push(candidate);
        }
    }
    if eligible.is_empty() {
        return Ok(Vec::new());
    }
    // the oldest waiting mail a watcher can take. With the project's
    // exclude-sender setting on (user 2026-10-18 08:07Z-08:08Z; off by
    // default) nobody is handed their own mail, and a mail only its sender
    // could take waits without holding up the rest
    let owners: Vec<i64> = eligible.iter().filter(|w| w.remaining > 0).filter_map(|w| w.owner).collect();
    let user = eligible.iter().any(|w| w.remaining > 0 && w.owner.is_none());
    let waiting = tx
        .query(
            "SELECT id, uid, sender, sender_agent_id, sender_generation, kind, notice, body, attachments, reply_to, ev,
                    urgent, urgent_reason, net_id, net_hub, replies, client_op, extra->'taken_from', extra->'one_time'
               FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending'
                 AND (NOT $2 OR EXISTS (SELECT 1 FROM unnest($3::bigint[]) AS o(id) WHERE sender_agent_id IS DISTINCT FROM o.id)
                      OR ($4 AND sender <> '@user'))
               ORDER BY id LIMIT 64 FOR UPDATE",
            &[&project, &skip_own, &owners, &user],
        )
        .await?;
    let mut steps = Vec::new();
    for m in &waiting {
        if steps.len() == limit { break; }
        let sender: Option<i64> = m.get(3);
        let sender_name: String = m.get(2);
        let others: Vec<Watcher> = eligible.iter().filter(|w| !skip_own || !is_sender(w, sender, &sender_name)).cloned().collect();
        // a mail the user took back from a holder goes to someone else first
        let taken_from: Vec<i64> = m.get::<_, Option<Value>>(17).and_then(|v| v.as_array().cloned()).unwrap_or_default()
            .iter().filter_map(Value::as_i64).collect();
        let Some(w) = pick_avoiding(&others, &taken_from).cloned() else { continue };
        let mail_id: i64 = m.get(0);
        let mail_uid: String = m.get(1);
        let body: String = m.get(7);
        let notice = m.get::<_, bool>(6) || w.notice;
        let copy = uid("m");
        // since when this listener waited for it (its Waited on the desk)
        let waited_from = w.waiting_since();
        let mut via = json!({ "via_project": { "id": project, "name": pname, "mail": mail_uid, "dog": w.uid, "ack": ack,
                                            "waited_from": iso(waited_from) } });
        if m.get::<_,Option<Value>>(18).is_some_and(|v|v==true) { via["one_time"]=json!(true); }
        // an agent's copy lands in its mailbox; the user's in their inbox
        // (recipient_kind 'user', named '@user', as mail to the user is stored)
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason,
                                  client_op, state, net_id, net_hub, replies, extra)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::bigint IS NULL THEN 'user' ELSE 'agent' END, $6,
                     CASE WHEN $6::bigint IS NULL THEN '@user' ELSE $7::text END, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                     'pending', $17, $18, $19, $20)",
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
                            'by_user', $3::bigint IS NULL,
                            'dog', $4::text, 'copy', $5::text, 'at', now(), 'ack', $6::boolean, 'wakes', 0,
                            'waited_from', $7::timestamptz),
                            'attempts', coalesce((extra->>'attempts')::int, 0) + 1,
                            'attempt_log', coalesce(extra->'attempt_log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                                'n', coalesce((extra->>'attempts')::int, 0) + 1, 'by', $2::text, 'by_id', $3::bigint,
                                'copy', $5::text, 'at', now(), 'waited_from', $7::timestamptz, 'dog', $4::text)))
              WHERE id = $1",
            &[&mail_id, &w.owner_name, &w.owner, &w.uid, &copy, &ack, &waited_from],
        )
        .await?;
        let ring = json!([{ "at": iso(Utc::now()), "gist": gist(&format!("mail from {sender_name}: {body}"), 200) }]);
        let served: DateTime<Utc> = if w.row == 0 {
            // No watchdog exists. Custody survives until its normal ACK,
            // halt/retirement/reach loss, timeout or explicit user reclaim.
            tx.execute("UPDATE ot.mail SET extra=jsonb_set(jsonb_set(extra,'{claimed,inline}', 'true'::jsonb),'{claimed,dog}','null'::jsonb) WHERE id=$1", &[&mail_id]).await?;
            tx.execute("UPDATE ot.mail SET state='read',read_at=now(),delivered_at=now(),extra=jsonb_set(jsonb_set(extra || '{\"manual_read\":true}'::jsonb,'{via_project,inline}','true'::jsonb),'{via_project,dog}','null'::jsonb) WHERE uid=$1", &[&copy]).await?;
            Utc::now()
        } else { tx
            .query_one(
                "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = clock_timestamp(),
                        events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                            SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                             ORDER BY n DESC LIMIT $3) s)
                  WHERE id = $1 RETURNING last_fired",
                &[&w.row, &ring, &EVENTS_KEEP],
            )
            .await?
            .get(0) };
        if let Some(next) = eligible.iter_mut().find(|next| next.row == w.row) {
            next.remaining -= 1;
            next.last_fired = Some(served);
        }
        steps.push(Step {
            handed: Handed { mail: mail_uid, copy, watcher: w.owner_name.clone(), dog: w.uid.clone() },
            project: pname.clone(),
            watcher_id: w.owner,
            notice,
            dog_row: w.row,
            spent: w.once,
        });
    }
    // A one-shot accepts its whole available batch; becoming spent is atomic
    // with those copies, never after the first message of the batch.
    let once: Vec<i64> = steps.iter().filter(|s| s.spent && s.dog_row != 0).map(|s| s.dog_row).collect();
    if !once.is_empty() {
        tx.execute("UPDATE ot.watchdogs SET state='spent', spent_at=now() WHERE id=ANY($1)", &[&once]).await?;
    }
    Ok(steps)
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
/// of every tree operation, inside its transaction. Sum the first live agent
/// frontier through live projects, never their possibly stale mirror grants.
/// One active-row read, iterative aggregation and one batched update. Returns the projects
/// whose grant moved and their parents (whose free credits moved with them).
#[logged]
pub async fn settle_credits(tx: &impl GenericClient, org_id: i64) -> Result<Vec<i64>> {
    let live = tx.query(
        "SELECT id,parent_id,kind='project',seat+grant_credits,seat,grant_credits,row_version FROM ot.agents
          WHERE org_id=$1 AND state='live' ORDER BY id", &[&org_id]).await?;
    let totals = credit_settlement::totals(live.iter().map(|r| (r.get(0),r.get(1),r.get(2),r.get(3))).collect())?;
    let snapshots: HashMap<i64, _> = live.iter().filter(|r| r.get::<_,bool>(2)).map(|r|
        (r.get(0),(r.get::<_,rust_decimal::Decimal>(4),r.get::<_,rust_decimal::Decimal>(5),r.get::<_,i64>(6)))).collect();
    let mut ids=Vec::new();let mut stakes=Vec::new();let mut versions=Vec::new();
    for (id,stake) in totals {
        let (seat,grant,version)=snapshots[&id];
        if seat!=rust_decimal::Decimal::ZERO || grant!=stake {
            ids.push(id);stakes.push(stake);versions.push(version);
        }
    }
    if ids.is_empty() { return Ok(Vec::new()); }
    let rows = tx.query(
        "UPDATE ot.agents a SET grant_credits=held.stake,seat=0,row_version=a.row_version+1
           FROM unnest($1::bigint[],$2::numeric[],$4::bigint[]) AS held(id,stake,version)
          WHERE a.id=held.id AND a.org_id=$3 AND a.state='live'
            AND a.row_version=held.version
          RETURNING a.id,a.parent_id", &[&ids,&stakes,&org_id,&versions]).await?;
    if rows.len()!=ids.len() {
        crate::refuse!(Conflict,"project credits changed concurrently; retry this operation (nothing changed)");
    }
    let mut changed = Vec::new();
    for r in &rows {
        changed.push(r.get::<_, i64>(0));
        changed.extend(r.get::<_, Option<i64>>(1));
    }
    Ok(changed)
}

/// The live projects below `agent` (its descendants, nested ones included),
/// nearest first: the folders an agent above a project holds.
#[logged]
pub async fn below(client: &impl GenericClient, agent: i64) -> Result<Vec<(i64, String)>> {
    let mut out = Vec::new();
    let mut after = 0_i64;
    loop {
      let page = client
        .query(
            // Stable edges stop cycles; excluding the root makes the ordering
            // walk acyclic without a quadratic path array or a depth ceiling.
            "WITH RECURSIVE down(id,parent_id,org_id) AS (
               SELECT a.id,a.parent_id,a.org_id FROM ot.agents a JOIN ot.agents root ON root.id=$1
                WHERE a.parent_id=$1 AND a.id<>$1 AND a.org_id=root.org_id AND a.state='live'
               UNION SELECT a.id,a.parent_id,a.org_id FROM ot.agents a JOIN down d ON a.parent_id=d.id
                WHERE a.id<>$1 AND a.org_id=d.org_id AND a.state='live'),
             ordered(id,depth) AS (
               SELECT id,1 FROM down WHERE parent_id=$1
               UNION ALL SELECT d.id,o.depth+1 FROM down d JOIN ordered o ON d.parent_id=o.id)
             SELECT a.id,a.name,o.depth,a.sibling_order FROM ordered o JOIN ot.agents a ON a.id=o.id
              WHERE a.kind='project' AND a.id>$2 ORDER BY a.id LIMIT 256",
            &[&agent,&after],
        )
        .await?;
      if page.is_empty() { break; }
      for r in page {
          after=r.get(0);
          out.push((r.get::<_,i32>(2),r.get::<_,f64>(3),after,r.get::<_,String>(1)));
      }
    }
    out.sort_by(|a,b|a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.cmp(&b.2)));
    Ok(out.into_iter().map(|(_,_,id,name)|(id,name)).collect())
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
                             coalesce(m.extra->'claimed'->>'dog', ''), m.extra->'claimed'->>'inline'='true'
                        FROM ot.mail m WHERE m.recipient_agent_id = $1 AND {OUTSTANDING} ORDER BY m.id LIMIT 200"),
            &[&project],
        )
        .await?;
    let mut gone = Vec::new();
    for h in &held {
        let (row, holder): (i64, Option<i64>) = (h.get(0), h.get(1));
        let Some(holder) = holder else { continue };
        let a = client.query_opt("SELECT state, halt IS NOT NULL FROM ot.agents WHERE id = $1", &[&holder]).await?;
        let listening = (h.get::<_,Option<bool>>(5).unwrap_or(false) || client
            .query_opt(
                // a one-shot dog that handed this very mail is spent, and still counts
                "SELECT 1 FROM ot.watchdogs w WHERE w.org_id = $1 AND w.kind = 'fair_queue'
                   AND (w.state = 'armed' OR (w.state = 'spent' AND w.uid = $4))
                   AND w.owner_agent_id = $2 AND (w.memo->>'target_id')::bigint = $3 LIMIT 1",
                &[&org_id, &holder, &project, &h.get::<_, String>(4)],
            )
            .await?
            .is_some())
            && reaches(&**client, holder, project).await?;
        let why = match a {
            None => "is gone",
            Some(r) if r.get::<_, String>(0) != "live" => "was retired",
            Some(r) if r.get::<_, bool>(1) => "was halted",
            _ if !listening => "stopped watching the project",
            _ => continue,
        };
        gone.push((row, holder, h.get::<_, Option<String>>(2).unwrap_or_default(), why, h.get::<_,Option<String>>(3)));
    }
    drop(client);
    let mut released = Vec::new();
    for (row, holder, by, why, copy) in gone {
        if reclaim(engine, org_id, project, row, holder, &by, why, "released", copy.as_deref()).await?.is_some() {
            released.push(by);
        }
    }
    Ok(released)
}

/// Revalidate abandonment using the CURRENT holder/claim under the job lock.
#[nolog]
async fn stale_claim_reason(tx:&impl GenericClient,org_id:i64,project:i64,holder:i64,claimed:&Value)->Result<Option<&'static str>> {
    let Some(a)=tx.query_opt("SELECT state,halt IS NOT NULL FROM ot.agents WHERE id=$1",&[&holder]).await? else{return Ok(Some("is gone"))};
    if a.get::<_,String>(0)!="live"{return Ok(Some("was retired"))}
    if a.get::<_,bool>(1){return Ok(Some("was halted"))}
    let dog=claimed["dog"].as_str().unwrap_or("");
    let listening=claimed["inline"]==true || tx.query_opt("SELECT 1 FROM ot.watchdogs WHERE org_id=$1 AND kind='fair_queue' AND owner_agent_id=$2 AND (memo->>'target_id')::bigint=$3 AND (state='armed' OR (state='spent' AND uid=$4)) LIMIT 1",&[&org_id,&holder,&project,&dog]).await?.is_some();
    if !listening || !reaches(tx,holder,project).await?{return Ok(Some("stopped watching the project"))}
    Ok(None)
}

/// Take an un-acked mail back from its holder: to the front of the queue,
/// or, when it has used up the project's max attempts and the 20-minute
/// checkup is on (user 2026-10-18 08:11Z), to the dead-letter list, which
/// tells the user. One short transaction. `Some(dead)` when it was taken.
#[logged]
#[allow(clippy::too_many_arguments)]
async fn reclaim(engine: &Arc<Engine>, org_id: i64, project: i64, row: i64, holder: i64, by: &str,
                 why: &str, how: &str, expected_copy: Option<&str>) -> Result<Option<bool>> {
    let counted = crate::runtime::reminders::switches(engine).checkups;
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let Some(taken) = reclaim_in(&*tx, org_id, project, row, holder, by, why, how, "failed", counted, expected_copy).await? else {
        return Ok(None);
    };
    tx.commit().await?;
    drop(client);
    after_reclaim(engine, org_id, project, &taken).await;
    Ok(Some(taken.dead))
}

/// What [`reclaim_in`] took back, for the work after its commit.
#[derive(Debug, Clone)]
pub struct Reclaimed {
    pub project: String,
    pub holder: i64,
    pub by: String,
    pub why: String,
    /// the project's copy (the job)
    pub mail: String,
    /// the copy its holder was handed
    pub copy: Option<String>,
    pub sender: String,
    pub attempts: i64,
    pub dead: bool,
}

/// [`reclaim`]'s writes, in the caller's transaction (the engine's own
/// reclaims, and the user's take back in its op): the project's row first,
/// then the job, as the hand-out takes them. Records the ending (`ending`
/// unless it was the job's last attempt, a dead letter) and frees the
/// holder's listener. `None` when the mail is not held any more.
#[logged]
#[allow(clippy::too_many_arguments)]
pub async fn reclaim_in(tx: &impl GenericClient, org_id: i64, project: i64, row: i64, holder: i64, by: &str, why: &str,
                        how: &str, ending: &str, counted: bool, expected_copy: Option<&str>) -> Result<Option<Reclaimed>> {
    let Some(p) = tx.query_opt("SELECT name, scope FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&project]).await? else {
        return Ok(None);
    };
    let (pname, scope): (String, Value) = (p.get(0), p.get(1));
    let Some(m) = tx
        .query_opt(&format!("SELECT m.uid, coalesce((m.extra->>'attempts')::bigint, 0), m.sender, m.extra->'claimed'
                               FROM ot.mail m WHERE m.id = $1 AND {OUTSTANDING} FOR UPDATE"),
            &[&row])
        .await?
    else {
        return Ok(None);
    };
    let (uid, attempts, sender, claimed): (String, i64, String, Value) = (m.get(0), m.get(1), m.get(2), m.get(3));
    // Holder + unique handed-copy identity also rejects same-holder ABA and
    // transfers to the user. All callers bind their earlier observation.
    if claimed["by_id"].as_i64()!=Some(holder) || claimed["copy"].as_str()!=expected_copy {
        return Ok(None);
    }
    let current_why = if ending=="failed" {
        if !ack_mode(&scope) {return Ok(None)}
        if how=="timed_out" {
            if !ack_reminders_exhausted(&scope,claimed["wakes"].as_i64().unwrap_or(0)){return Ok(None)}
            Some(format!("did not ack it after {} reminders",ack_reminders(&scope)))
        } else {
            let Some(reason)=stale_claim_reason(tx,org_id,project,holder,&claimed).await? else{return Ok(None)};
            Some(reason.to_string())
        }
    } else {None};
    let why=current_why.as_deref().unwrap_or(why);
    let copy = claimed["copy"].as_str().map(str::to_string);
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
    if ending == "taken_back" {
        // the next hand-out prefers another listener (`pick_avoiding`)
        tx.execute(
            "UPDATE ot.mail SET extra = jsonb_set(extra, '{taken_from}', coalesce(extra->'taken_from', '[]'::jsonb) || to_jsonb($2::bigint))
              WHERE id = $1",
            &[&row, &holder],
        )
        .await?;
    }
    if let Some(c) = &copy {
        tx.execute(
            "UPDATE ot.mail SET extra = extra || jsonb_build_object('released', jsonb_build_object('why', $2::text, 'at', now()))
              WHERE uid = $1",
            &[c, &why],
        )
        .await?;
    }
    record_ending(tx, org_id, project, &uid, &claimed, Some(holder), by, if dead { "dead_letter" } else { ending }, Some(why),
                  attempts, None).await?;
    free_listener(tx, Some(holder), &claimed).await?;
    Ok(Some(Reclaimed { project: pname, holder, by: by.to_string(), why: why.to_string(), mail: uid, copy, sender, attempts, dead }))
}

/// After a reclaim commits: the mailboxes move, and a dead letter is
/// announced and told to the project's superior.
#[logged]
pub async fn after_reclaim(engine: &Arc<Engine>, org_id: i64, project: i64, r: &Reclaimed) {
    changes::notify_id(engine, org_id, vec![Change::Mailbox(project), Change::Mailbox(r.holder)]);
    let (pname, uid, by, why, attempts) = (&r.project, &r.mail, &r.by, &r.why, r.attempts);
    if r.dead {
        tracing::warn!(project = %pname, mail = %uid, attempts, "a project mail ran out of attempts and was dead-lettered");
        crate::runtime::watchdogs::events::emit(engine, crate::runtime::watchdogs::events::event(
            "project.dead_letter", crate::runtime::watchdogs::events::Scope::Agent(org_id, project),
            json!({ "project": pname, "mail": uid, "from": r.sender, "attempts": attempts, "by": by, "why": why })));
        let body = format!(
            "Project {pname} gave up on mail {uid}: it was handed out {attempts} times without an ack (the last holder, {by}, {why}). \
             It is in the project's dead-letter list (orgtree_project action=dead_letters name={pname}) and will not be handed out again              unless someone retries it.");
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
}

/// One handed project mail's ending, for the desk's Recently Finished (user
/// 2026-10-20 06:22Z-06:41Z): `how` is acked, failed, taken_back or
/// dead_letter. Written in the ending's own transaction, at its instant.
#[logged]
#[allow(clippy::too_many_arguments)]
pub async fn record_ending(tx: &impl GenericClient, org_id: i64, project: i64, mail: &str, claimed: &Value, agent: Option<i64>, agent_name: &str,
                           how: &str, why: Option<&str>, attempt: i64, ack: Option<&str>) -> Result<()> {
    let at = |k: &str| claimed[k].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc));
    tx.execute(
        "INSERT INTO ot.project_mail_endings (org_id, project_id, mail_uid, copy_uid, agent_id, agent_name, dog_uid, how, why,
                                              attempt, waited_from, held_at, ended_at, ack_uid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)",
        &[&org_id, &project, &mail, &claimed["copy"].as_str(), &agent, &agent_name, &claimed["dog"].as_str(), &how, &why,
          &(attempt as i32), &at("waited_from"), &at("at"), &ack],
    )
    .await?;
    Ok(())
}

/// The holder's fair_queue dog is free again: its next wait starts now
/// (`memo.run.freed_at`, read back as [`Watcher::freed_at`]). `holder` None
/// is the user, whose dog has no agent owner.
#[logged]
pub async fn free_listener(tx: &impl GenericClient, holder: Option<i64>, claimed: &Value) -> Result<()> {
    if let Some(dog) = claimed["dog"].as_str() {
        tx.execute(
            "UPDATE ot.watchdogs SET memo = jsonb_set(memo || jsonb_build_object('run', coalesce(memo->'run', '{}'::jsonb)),
                                                       '{run,freed_at}', to_jsonb(now()))
              WHERE owner_agent_id IS NOT DISTINCT FROM $1 AND uid = $2 AND kind = 'fair_queue' AND state IN ('armed', 'paused', 'spent')",
            &[&holder, &dog],
        )
        .await?;
    }
    Ok(())
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
    let rows = ack_timeouts_page(&**client, agent).await?;
    drop(client);
    let mut kept = Vec::new();
    for r in &rows {
        let (row,project,pname,copy):(i64,i64,String,Option<String>)=(r.get(0),r.get(1),r.get(2),r.get(4));
        let mut client=engine.db.get().await?;
        let tx=client.transaction().await?;
        let Some(p)=tx.query_opt("SELECT scope FROM ot.agents WHERE id=$1 FOR NO KEY UPDATE",&[&project]).await? else{continue};
        let scope:Value=p.get(0);
        if !ack_mode(&scope){continue}
        let Some(m)=tx.query_opt(&format!("SELECT m.extra->'claimed' FROM ot.mail m WHERE m.id=$1 AND {OUTSTANDING} FOR UPDATE"),&[&row]).await? else{continue};
        let claim:Value=m.get(0);
        if claim["by_id"].as_i64()!=Some(agent) || claim["copy"].as_str()!=copy.as_deref(){continue}
        let wakes=claim["wakes"].as_i64().unwrap_or(0);
        if ack_reminders_exhausted(&scope,wakes) {
            let why=format!("did not ack it after {} reminders",ack_reminders(&scope));
            let counted=crate::runtime::reminders::switches(engine).checkups;
            let taken=reclaim_in(&*tx,org_id,project,row,agent,name,&why,"timed_out","failed",counted,copy.as_deref()).await?;
            tx.commit().await?;drop(client);
            if let Some(taken)=taken {after_reclaim(engine,org_id,project,&taken).await;Box::pin(dispatch(engine,org_id,project)).await?;}
            continue;
        }
        if ack_timeout(&scope) {
            tx.execute("UPDATE ot.mail SET extra=jsonb_set(extra,'{claimed,wakes}',to_jsonb($2::bigint)) WHERE id=$1",&[&row,&(wakes+1)]).await?;
        }
        tx.commit().await?;
        if let Some(copy)=copy {kept.push((copy,pname));}
    }
    super::checkup_pages::advance(&**engine.db.get().await?, agent, super::checkup_pages::JOBS, &rows).await?;
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
pub async fn ack_of(tx: &impl GenericClient, project: i64, agent: i64, reply: &str) -> Result<Option<(i64, String, Value)>> {
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
    Ok(Some((row.get(0), orig, claimed)))
}

/// The job the queue handed the USER, for their ack (`op user_job_ack`):
/// the user's copy (a mail in their inbox) names the project and its job;
/// the job must be held by the user in ack mode and not acked yet. Returns
/// (project id, the job's row, the job's uid, its claim). Refuses mail that
/// is not a job handed to the user, one already acked, and one the project
/// took back. The job row is locked (the project's row was taken first).
#[logged]
pub async fn user_ack_of(tx: &impl GenericClient, org_id: i64, copy: &str) -> Result<(i64, i64, String, Value)> {
    let Some(c) = tx
        .query_opt(
            "SELECT extra->'via_project', extra->'released'->>'why' FROM ot.mail
              WHERE uid = $1 AND org_id = $2 AND recipient_kind = 'user'",
            &[&copy, &org_id],
        )
        .await?
    else {
        crate::refuse!(NotFound, "no mail {copy} in your inbox");
    };
    let via: Option<Value> = c.get(0);
    let Some(via) = via.filter(|v| v["id"].as_i64().is_some()) else {
        crate::refuse!(BadRequest, "mail {copy} was not handed to you by a project's mail queue, so there is nothing to acknowledge");
    };
    let project = via["id"].as_i64().unwrap_or_default();
    // the project's row first, then its job, as the hand-out takes them
    tx.query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project]).await?;
    if via["ack"].as_bool() != Some(true) {
        crate::refuse!(Conflict, "project {}'s queue is not in ACK mode for this mail: nothing to acknowledge", via["name"].as_str().unwrap_or("?"));
    }
    if let Some(why) = c.get::<_, Option<String>>(1) {
        crate::refuse!(Conflict, "mail {copy} went back to project {}'s queue ({why}); it is no longer yours to acknowledge",
            via["name"].as_str().unwrap_or("?"));
    }
    let orig = via["mail"].as_str().unwrap_or("").to_string();
    let Some(row) = tx
        .query_opt("SELECT id, extra->'claimed' FROM ot.mail WHERE uid = $1 AND recipient_agent_id = $2 FOR UPDATE", &[&orig, &project])
        .await?
    else {
        crate::refuse!(NotFound, "the project's copy of mail {copy} is gone");
    };
    let claimed: Value = row.get::<_, Option<Value>>(1).unwrap_or(Value::Null);
    if claimed["copy"].as_str() != Some(copy) || claimed["ack"].as_bool() != Some(true) || claimed["by_user"].as_bool() != Some(true) {
        crate::refuse!(Conflict, "mail {copy} is not held by you any more");
    }
    if claimed.get("acked_at").is_some_and(|v| !v.is_null()) {
        crate::refuse!(Conflict, "mail {copy} is already acknowledged; nothing more to do for it");
    }
    Ok((project, row.get(0), orig, claimed))
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
        format!("Project {name}'s mail queue is now in ACK MODE. Your listener's batch setting limits how many unacked mails you hold (default 1). \
                 Finish and ack each mail individually: orgtree_message to={name} reply_to=<the id of that mail> with a short completion record. \
                 Each ack frees one place and hands you waiting mail at once; abandonment returns only the unacked mails.")
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
                         AND (m.extra->'claimed'->>'inline'='true' OR EXISTS (SELECT 1 FROM ot.watchdogs w WHERE w.kind = 'fair_queue' AND w.state = 'armed'
                                       AND (w.memo->>'target_id')::bigint = p.id))
                       ORDER BY m.id LIMIT 20"),
            &[&agent],
        )
        .await?
        .iter()
        .filter_map(|r| Some((r.get::<_, Option<String>>(0)?, r.get(1))))
        .collect())
}

/// Whether anyone could take the project's next mail: an armed fair_queue dog
/// on it, owned by a live agent that still reaches it (the set `hand_batch`
/// picks from).
#[logged]
pub async fn watched(client: &impl GenericClient, org_id: i64, project: i64) -> Result<bool> {
    let rows = client
        .query(
            "SELECT w.owner_agent_id FROM ot.watchdogs w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND (w.owner_kind = 'user' OR (a.state = 'live' AND a.kind = 'agent'))
              ORDER BY w.id LIMIT 64",
            &[&org_id, &project],
        )
        .await?;
    for r in &rows {
        // the user, who listens from the desk, is a listener that always reaches the project
        match r.get::<_, Option<i64>>(0) {
            None => return Ok(true),
            Some(agent) => {
                if reaches(client, agent, project).await? {
                    return Ok(true);
                }
            }
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

/// The warning that leads a sender's note when the project's inbox has no
/// listener at all (user 2026-10-20 11:04Z, docket
/// warn-senders-when-they-mail-a-project-whose-inbo): no fair_queue dog on
/// it, armed or paused, whose owner could take the mail. A paused listener
/// is attached; its sender gets `wait_note`'s paused note instead. The mail
/// is queued all the same.
#[nolog]
pub fn no_listener_warning(project: &str) -> String {
    format!("Warning: project {project}'s inbox has no listeners, so this mail may not be read by anyone or delivered anywhere until one attaches.")
}

/// What an agent's send result says about its mail that waits in the queue
/// (`mail::send_project`): `wait_note`, or with no listener the warning, how
/// to attach one and where the mail can be read. `orgtree_inbox project`
/// keeps `wait_note`'s own line: the warning is per send.
#[nolog]
pub fn sent_note(project: &str, st: &QueueState) -> String {
    if st.listeners > 0 || st.paused > 0 {
        return wait_note(project, st);
    }
    let place = st.position.map(|k| format!(" (position {k} in line)")).unwrap_or_default();
    format!(
        "{} It waits in the mailbox{place}; an agent above or below the project attaches one with orgtree_watchdog action=create kind=fair_queue target={project} and can read it with orgtree_inbox project={project}.",
        no_listener_warning(project))
}

/// The user wrote to a project nobody watches (`mail::nudge_project`): who
/// was asked to arm a fair_queue dog, or why nobody was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Nudge {
    /// Runtime settings turn the wake off
    Off,
    /// no live, unhalted agent works directly under the project
    Nobody,
    /// this agent was woken and asked to arm one
    Woke(String),
}

/// The user's send note for a project nobody watches: the warning agents get
/// (`no_listener_warning`), then what the listener wake did, in the user's
/// terms (no tool syntax).
#[nolog]
pub fn unwatched_note(project: &str, nudge: &Nudge) -> String {
    let warning = no_listener_warning(project);
    match nudge {
        Nudge::Off => format!(
            "{warning} It waits in the mailbox; waking an agent to attach one is off in Runtime settings."),
        Nudge::Nobody => format!(
            "{warning} It waits in the mailbox, but no live, unhalted agent works directly under {project}, so nobody can pick it up until one is hired or unhalted."),
        Nudge::Woke(name) => format!(
            "{warning} It waits in the mailbox; {name} was woken and asked to attach one (a fair_queue watchdog), and the mail goes to whoever attaches first."),
    }
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
            &format!("SELECT DISTINCT ON (a.id) a.id, a.halt IS NOT NULL,
                    (SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $2
                             AND (m.extra->'claimed'->>'by_id')::bigint = a.id AND {OUTSTANDING}), w.memo
               FROM ot.agents a JOIN ot.watchdogs w ON w.owner_agent_id = a.id
              WHERE a.state = 'live' AND a.kind = 'agent' AND w.org_id = $1 AND w.kind = 'fair_queue'
                AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $2
              ORDER BY a.id, w.id LIMIT 64"),
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
            } else if r.get::<_, i64>(2) as usize >= batch_size(&r.get::<_, Value>(3)) {
                st.holding += 1;
            }
        }
    }
    // the user's own listener has no agent row: it is a listener that is
    // never halted, and holds a job while its held jobs fill its batch
    if let Some(u) = client
        .query_opt(
            &format!("SELECT w.memo, (SELECT count(*) FROM ot.mail m WHERE m.recipient_agent_id = $2
                                        AND m.extra->'claimed'->>'by_user' = 'true' AND {OUTSTANDING})
                        FROM ot.watchdogs w WHERE w.org_id = $1 AND w.owner_kind = 'user' AND w.kind = 'fair_queue'
                         AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $2 ORDER BY w.id LIMIT 1"),
            &[&org_id, &project],
        )
        .await?
    {
        st.listeners += 1;
        if ack && u.get::<_, i64>(1) as usize >= batch_size(&u.get::<_, Value>(0)) {
            st.holding += 1;
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
    // the user's own listener, when it is paused and not also armed
    st.paused += client
        .query_one(
            "SELECT (EXISTS (SELECT 1 FROM ot.watchdogs w WHERE w.org_id = $1 AND w.owner_kind = 'user' AND w.kind = 'fair_queue'
                               AND w.state = 'paused' AND (w.memo->>'target_id')::bigint = $2)
                     AND NOT EXISTS (SELECT 1 FROM ot.watchdogs w WHERE w.org_id = $1 AND w.owner_kind = 'user' AND w.kind = 'fair_queue'
                               AND w.state = 'armed' AND (w.memo->>'target_id')::bigint = $2))::int::bigint",
            &[&org_id, &project],
        )
        .await?
        .get::<_, i64>(0);
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

/// Existing desktop cap/order and agent-tool keyset paging stay distinct.
#[derive(Clone, Copy, Debug)]
pub enum BroadcastPage {
    Desk,
    Tool { after: i64, through: i64 },
}

/// One recipient traversal for desktop and tool: live projects are transparent,
/// live agents receive once and stop the walk (user 2026-10-23 09:42Z).
#[logged]
pub async fn broadcast_members(client: &impl GenericClient, project: i64, page: BroadcastPage) -> Result<Vec<(i64, String)>> {
    let (after, through, limit, order) = match page {
        BroadcastPage::Desk => (0i64, i64::MAX, 1000i64, "l.depth,a.sibling_order,a.id"),
        BroadcastPage::Tool { after, through } => (after, through, 100i64, "a.id"),
    };
    Ok(client.query(&format!(
        "WITH RECURSIVE down(id,parent_id,org_id,kind) AS (
           SELECT a.id,a.parent_id,a.org_id,a.kind FROM ot.agents a JOIN ot.agents root ON root.id=$1 AND root.org_id=a.org_id
            WHERE a.parent_id=$1 AND a.id<>$1 AND a.state='live'
           UNION SELECT a.id,a.parent_id,a.org_id,a.kind FROM ot.agents a JOIN down d ON a.parent_id=d.id AND a.org_id=d.org_id
            WHERE d.kind='project' AND a.id<>$1 AND a.state='live'),
         levels(id,depth) AS (
           SELECT id,1 FROM down WHERE parent_id=$1
           UNION ALL SELECT a.id,l.depth+1 FROM down a JOIN levels l ON a.parent_id=l.id)
         SELECT a.id,a.name FROM levels l JOIN ot.agents a ON a.id=l.id
          WHERE a.kind='agent' AND a.id>$2 AND a.id<=$3 ORDER BY {order} LIMIT $4"),
        &[&project,&after,&through,&limit]).await?.iter().map(|r| (r.get(0),r.get(1))).collect())
}

/// The project desk's recipients, nearest first, with its existing cap.
#[logged]
pub async fn members(client: &impl GenericClient, project: i64) -> Result<Vec<String>> {
    Ok(broadcast_members(client,project,BroadcastPage::Desk).await?.into_iter().map(|(_,name)| name).collect())
}

/// Kept rows one page of a project's Recently Finished or Recently
/// Delivered shows.
const QUEUE_PAGE: usize = 30;

/// SQL: the dog (alias `w`) a history row names, by its owner and id; the
/// newest of that id, since a newer dog may reuse it (D67).
#[nolog]
fn dog_of(owner: &str, uid: &str) -> String {
    format!("LEFT JOIN LATERAL (SELECT x.name, x.kind, x.once, CASE WHEN x.spent_at IS NOT NULL THEN 'spent' ELSE x.state END AS state
                                  FROM ot.watchdogs x WHERE x.owner_agent_id IS NOT DISTINCT FROM {owner} AND x.uid = {uid}
                                 ORDER BY x.id DESC LIMIT 1) w ON true")
}

/// A history row's dog: its identity, kept after the dog is gone.
#[nolog]
fn row_dog(r: &tokio_postgres::Row, owner: &str, uid: Option<&str>, at: usize, kind: &str) -> Value {
    match uid {
        Some(uid) => crate::domain::watchdogs::identity(owner, uid, r.get::<_, Option<&str>>(at),
            r.get::<_, Option<&str>>(at + 1).unwrap_or(kind), r.get(at + 2), r.get::<_, Option<&str>>(at + 3)),
        None => Value::Null,
    }
}

/// The desk's table times: an ISO string, or null.
#[nolog]
fn when(t: Option<DateTime<Utc>>) -> Value {
    t.map(|t| json!(iso(t))).unwrap_or(Value::Null)
}

/// A JSON timestamp (`to_jsonb(now())`) as one.
#[nolog]
fn json_time(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

/// The line a dead-letter listener's pattern is tried on for `project`:
/// the event as its dog would see it, the job's details left empty.
#[nolog]
pub fn dead_letter_line(project: &str) -> String {
    format!("{} {} (1 matches)", crate::runtime::watchdogs::events::DEAD_LETTER,
        json!({ "project": project, "mail": "", "from": "", "attempts": 0, "by": "", "why": "" }))
}

/// A project's dead-letter listeners, its Dead Letter Line (user 2026-10-20
/// 06:41Z): the armed or paused `event` dogs on `project.dead_letter` or
/// `project.*` whose owner is above or below the project and whose pattern
/// takes its dead letters, in delivery (dog) order, at most 200. Read here,
/// not from the tree, whose generic watchdogs are an eight-per-owner
/// preview (watchdog uncap 2026-10-20).
#[logged]
pub async fn dead_letter_listeners(client: &impl GenericClient, org_id: i64, project: i64, name: &str) -> Result<Vec<Value>> {
    let rows = client
        .query(
            "WITH RECURSIVE
               up(id, depth) AS (
                 SELECT parent_id, 1 FROM ot.agents WHERE id = $2 AND parent_id IS NOT NULL
                 UNION ALL SELECT x.parent_id, up.depth + 1 FROM ot.agents x JOIN up ON x.id = up.id
                  WHERE x.parent_id IS NOT NULL AND up.depth < 1024),
               down(id, depth) AS (
                 SELECT id, 1 FROM ot.agents WHERE parent_id = $2
                 UNION ALL SELECT x.id, down.depth + 1 FROM ot.agents x JOIN down ON x.parent_id = down.id WHERE down.depth < 1024)
             SELECT to_jsonb(w), a.name, w.pattern FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'event' AND w.state IN ('armed', 'paused') AND w.spent_at IS NULL
                AND w.target IN ('project.dead_letter', 'project.*')
                AND (w.owner_agent_id IN (SELECT id FROM up) OR w.owner_agent_id IN (SELECT id FROM down))
              ORDER BY w.id LIMIT 200",
            &[&org_id, &project],
        )
        .await?;
    let line = dead_letter_line(name);
    Ok(rows
        .iter()
        .filter(|r| crate::runtime::watchdogs::pattern_takes(r.get::<_, Option<&str>>(2), &line))
        .map(|r| crate::domain::watchdogs::view(&r.get::<_, Value>(0), &r.get::<_, String>(1)))
        .collect())
}

/// A project's mail listener history for the desk's Mail › listeners
/// folder (user 2026-10-20 06:22Z-06:42Z). Ack mode: the jobs held now
/// (Working, with the first page) and the endings, newest first (Recently
/// Finished: acked, failed, taken back, dead-lettered). Round-robin: the
/// hand-outs, newest first (Recently Delivered). Every list is a bounded
/// indexed read; `before` is the previous page's cursor.
#[logged]
pub async fn queue_history(client: &impl GenericClient, project: i64, name: &str, scope: &Value, before: Option<&str>,
                           dead_letters: bool) -> Result<Value> {
    let ack = ack_mode(scope);
    let cursor = crate::domain::listeners::page_cursor(before, "mail history")?;
    let limit = QUEUE_PAGE as i64 + 1;
    let mut out = json!({ "project": name, "ack": ack, "max_attempts": max_attempts(scope), "dead_letters": dead_letters });
    if ack && cursor.is_none() {
        let rows = client
            .query(
                &format!("SELECT m.uid, m.body, m.extra->'claimed', coalesce((m.extra->>'attempts')::bigint, 0),
                                 w.name, w.kind, w.once, w.state
                            FROM ot.mail m {}
                           WHERE m.recipient_agent_id = $1 AND m.state = 'read' AND m.extra->'claimed'->>'ack' = 'true'
                             AND m.extra->'claimed'->>'acked_at' IS NULL AND NOT (m.extra ? 'dead_letter')
                           ORDER BY m.id LIMIT 200",
                    dog_of("(m.extra->'claimed'->>'by_id')::bigint", "m.extra->'claimed'->>'dog'")),
                &[&project],
            )
            .await?;
        out["working"] = Value::Array(rows.iter().map(|r| {
            let c: Value = r.get(2);
            let agent = c["by"].as_str().unwrap_or("?");
            json!({ "mail": r.get::<_, String>(0), "gist": first_line(r.get(1)), "copy": c["copy"], "agent": agent,
                    "dog": row_dog(r, agent, c["dog"].as_str(), 4, "fair_queue"), "attempts": r.get::<_, i64>(3),
                    "waited_from": when(json_time(&c["waited_from"])), "held_at": when(json_time(&c["at"])) })
        }).collect());
    }
    let (rows, history): (usize, Vec<Value>) = if ack {
        let sql = |page: &str| format!(
            "SELECT e.id, e.mail_uid, e.copy_uid, e.agent_name, e.dog_uid, e.how, e.why, e.attempt, e.waited_from, e.held_at,
                    e.ended_at, e.ack_uid, j.body, k.body, w.name, w.kind, w.once, w.state
               FROM ot.project_mail_endings e
               LEFT JOIN ot.mail j ON j.uid = e.mail_uid
               LEFT JOIN ot.mail k ON k.uid = e.ack_uid {}
              WHERE e.project_id = $1 {page} ORDER BY e.id DESC LIMIT {limit}", dog_of("e.agent_id", "e.dog_uid"));
        let rows = match cursor {
            Some(c) => client.query(&sql("AND e.id < $2"), &[&project, &c]).await?,
            None => client.query(&sql(""), &[&project]).await?,
        };
        (rows.len(), rows.iter().take(QUEUE_PAGE).map(|r| {
            let agent: String = r.get(3);
            json!({ "id": r.get::<_, i64>(0), "mail": r.get::<_, String>(1), "copy": r.get::<_, Option<String>>(2), "agent": agent,
                    "dog": row_dog(r, &agent, r.get(4), 14, "fair_queue"), "how": r.get::<_, String>(5),
                    "why": r.get::<_, Option<String>>(6), "attempt": r.get::<_, Option<i32>>(7),
                    "waited_from": when(r.get(8)), "held_at": when(r.get(9)), "ended_at": iso(r.get(10)),
                    "ack": r.get::<_, Option<String>>(11), "gist": r.get::<_, Option<&str>>(12).map(first_line),
                    "ack_gist": r.get::<_, Option<&str>>(13).map(first_line) })
        }).collect())
    } else {
        let sql = |page: &str| format!(
            "SELECT c.id, c.uid, c.recipient_name, c.created_at, c.body, c.extra->'via_project', w.name, w.kind, w.once, w.state
               FROM ot.mail c {}
              WHERE c.extra ? 'via_project' AND c.extra->'via_project'->>'id' = $1 {page}
              ORDER BY c.id DESC LIMIT {limit}", dog_of("c.recipient_agent_id", "c.extra->'via_project'->>'dog'"));
        let key = project.to_string();
        let rows = match cursor {
            Some(c) => client.query(&sql("AND c.id < $2"), &[&key, &c]).await?,
            None => client.query(&sql(""), &[&key]).await?,
        };
        (rows.len(), rows.iter().take(QUEUE_PAGE).map(|r| {
            // the user's copy is addressed '@user'; the history names them "user"
            let agent: String = r.get::<_, String>(2).replace("@user", USER);
            let via: Value = r.get(5);
            json!({ "id": r.get::<_, i64>(0), "copy": r.get::<_, String>(1), "agent": agent, "mail": via["mail"],
                    "dog": row_dog(r, &agent, via["dog"].as_str(), 6, "fair_queue"), "gist": first_line(r.get(4)),
                    "held_at": iso(r.get(3)), "waited_from": when(json_time(&via["waited_from"])) })
        }).collect())
    };
    let next = if rows > QUEUE_PAGE { history.last().and_then(|v| v["id"].as_i64()).map(|id| id.to_string()) } else { None };
    out["history"] = Value::Array(history);
    out["history_next"] = json!(next);
    Ok(out)
}

/// After the user's take back commits (the desk's Working table, user
/// 2026-10-20 06:42Z): the reclaim's own after-work, the holder is told
/// to stop (its ack of it is refused from now on), and the queue runs, so
/// another listener takes the job first.
#[logged]
pub async fn after_take_back(engine: &Arc<Engine>, org_id: i64, project: i64, r: &Reclaimed) {
    after_reclaim(engine, org_id, project, r).await;
    let copy = r.copy.as_deref().unwrap_or(&r.mail);
    // `by` is the holder's name, as every reclaim names it
    let to = r.by.clone();
    let body = if r.dead {
        format!("Project {} took mail {copy} back from you ({}); it had used its last attempt, so it went to the project's dead letters. \
                 Stop working on it: an ack of it is refused.", r.project, r.why)
    } else {
        format!("Project {} took mail {copy} back from you ({}); it went back to the front of the queue, for another listener first. \
                 Stop working on it: an ack of it is refused.", r.project, r.why)
    };
    let mut out = crate::domain::mail::Outgoing::new(crate::domain::mail::From::System, &to, &body);
    out.notice = true;
    out.grant_reply_audience = false;
    if let Err(e) = Box::pin(crate::domain::mail::send(engine, org_id, out)).await {
        tracing::warn!(holder = %to, error = %format!("{e:#}"), "telling a holder its job was taken back failed");
    }
    if let Err(e) = Box::pin(dispatch(engine, org_id, project)).await {
        tracing::warn!(project, error = %format!("{e:#}"), "running a project's queue after a take back failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_letter_listener_is_tried_on_its_projects_event_line() {
        let line = dead_letter_line("hd");
        assert_eq!(line, r#"project.dead_letter {"project":"hd","mail":"","from":"","attempts":0,"by":"","why":""} (1 matches)"#);
        let takes = crate::runtime::watchdogs::pattern_takes;
        assert!(takes(None, &line), "no pattern takes every project's");
        assert!(takes(Some(r#""project":"hd""#), &line));
        assert!(!takes(Some(r#""project":"other""#), &line));
        assert!(!takes(Some("(unclosed"), &line), "a pattern that does not compile takes nothing, as its dog");
    }

    fn at(s: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_760_000_000 + s, 0).unwrap()
    }

    fn w(row: i64, last: Option<i64>, created: i64) -> Watcher {
        Watcher { row, uid: format!("q{row}"), owner: Some(row * 10), owner_name: format!("a{row}"), last_fired: last.map(at),
                  created_at: at(created), once: false, notice: false, remaining: 1, freed_at: None }
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

    // a send to a project whose inbox has no listeners (user 2026-10-20
    // 11:04Z, docket warn-senders-when-they-mail-a-project-whose-inbo)
    const UNREAD: &str = "inbox has no listeners, so this mail may not be read by anyone or delivered anywhere until one attaches";

    #[test]
    fn an_agent_mailing_an_inbox_with_no_listeners_is_warned_and_told_how_to_attach_one() {
        let t = sent_note("q", &st(0, 0, 0, 0, Some(3)));
        assert!(t.starts_with("Warning: project q's ") && t.contains(UNREAD), "{t}");
        assert!(t.contains("orgtree_watchdog action=create kind=fair_queue target=q"), "how to attach one: {t}");
        assert!(t.contains("orgtree_inbox project=q"), "where it can be read: {t}");
        assert!(t.contains("position 3 in line"), "it is still queued: {t}");
    }

    #[test]
    fn a_paused_listener_is_attached_so_its_sender_gets_the_paused_note() {
        let t = sent_note("q", &st(0, 0, 0, 1, Some(1)));
        assert!(!t.contains("Warning") && !t.contains("no listeners"), "{t}");
        assert_eq!(t, wait_note("q", &st(0, 0, 0, 1, Some(1))));
    }

    #[test]
    fn a_send_to_a_listened_inbox_keeps_the_queue_note() {
        for s in [st(1, 0, 0, 0, Some(1)), st(2, 2, 0, 0, Some(1)), st(2, 1, 1, 0, None), st(1, 1, 0, 2, None)] {
            assert_eq!(sent_note("q", &s), wait_note("q", &s), "{s:?}");
        }
    }

    #[test]
    fn the_user_is_warned_too_ahead_of_what_the_wake_did() {
        for (n, kept) in [(Nudge::Off, "off in Runtime settings"), (Nudge::Nobody, "nobody can pick it up"),
                          (Nudge::Woke("dev5".into()), "dev5 was woken and asked to")] {
            let t = unwatched_note("q", &n);
            assert!(t.starts_with("Warning: project q's ") && t.contains(UNREAD), "{n:?}: {t}");
            assert!(t.contains(kept), "{n:?} still says what the wake did: {t}");
            assert!(!t.contains("orgtree_"), "the user gets no agent tool syntax: {t}");
        }
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
    fn a_listener_waits_from_its_arming_last_hand_out_or_freed_job_whichever_is_latest() {
        let mut x = w(1, None, 5);
        assert_eq!(x.waiting_since(), at(5), "never handed anything: since its arming");
        x.last_fired = Some(at(20));
        assert_eq!(x.waiting_since(), at(20), "since its last hand-out");
        x.freed_at = Some(at(30));
        assert_eq!(x.waiting_since(), at(30), "an ack after it: since the ack");
        x.freed_at = Some(at(10));
        assert_eq!(x.waiting_since(), at(20), "an older end never moves it back");
    }

    #[test]
    fn a_taken_back_mail_goes_to_another_listener_first_else_back() {
        let ws = vec![w(1, Some(5), 0), w(2, Some(50), 0)];
        assert_eq!(pick_avoiding(&ws, &[]).map(|x| x.row), Some(1), "no take back: the plain pick");
        assert_eq!(pick_avoiding(&ws, &[10]).map(|x| x.row), Some(2), "taken from 1's owner: 2 first");
        let lone = vec![w(1, Some(5), 0)];
        assert_eq!(pick_avoiding(&lone, &[10]).map(|x| x.row), Some(1), "nobody else: back to it");
        let mut full = ws.clone();
        full[1].remaining = 0;
        assert_eq!(pick_avoiding(&full, &[10]).map(|x| x.row), Some(1), "the other has no room: back to it");
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

#[cfg(test)]
mod attempt_log_tests {
    use super::closed_attempt;

    #[test]
    fn ending_an_attempt_only_touches_a_mail_that_has_a_log() {
        let sql = closed_attempt("m.extra", "$6::text", "$4::text");
        assert!(sql.contains("jsonb_array_length(coalesce(m.extra->'attempt_log', '[]'::jsonb)) > 0"), "{sql}");
        assert!(sql.contains("jsonb_build_object('how', $6::text, 'why', $4::text, 'at', now())"), "{sql}");
        assert!(sql.trim_end().ends_with("ELSE m.extra END"), "{sql}");
    }
}

#[logged]
pub(crate) async fn ack_timeouts_page(client: &impl GenericClient, agent: i64) -> Result<Vec<tokio_postgres::Row>> {
    super::checkup_pages::read(client, &format!("SELECT m.id, m.recipient_agent_id, p.name, p.scope, m.extra->'claimed'->>'copy',
                             coalesce((m.extra->'claimed'->>'wakes')::bigint, 0)
                        FROM ot.mail m JOIN ot.agents p ON p.id = m.recipient_agent_id
                       WHERE (m.extra->'claimed'->>'by_id')::bigint = $1 AND {OUTSTANDING} AND p.kind = 'project'
                       AND m.id > $2 AND m.id <= $3 ORDER BY m.id LIMIT 20"), &format!("SELECT coalesce(max(m.id),0) FROM ot.mail m JOIN ot.agents p ON p.id=m.recipient_agent_id WHERE (m.extra->'claimed'->>'by_id')::bigint=$1 AND {OUTSTANDING} AND p.kind='project'"), agent, super::checkup_pages::JOBS).await
}
