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
        .query_opt("SELECT name, state FROM ot.agents WHERE id = $1 AND kind = 'project' FOR NO KEY UPDATE", &[&project])
        .await?
    else {
        return Ok(None);
    };
    let pname: String = p.get(0);
    if p.get::<_, String>(1) != "live" {
        return Ok(None);
    }
    let Some(m) = tx
        .query_opt(
            "SELECT id, uid, sender, sender_agent_id, sender_generation, kind, notice, body, attachments, reply_to, ev,
                    urgent, urgent_reason, net_id, net_hub, replies, client_op
               FROM ot.mail WHERE recipient_agent_id = $1 AND state = 'pending' ORDER BY id LIMIT 1 FOR UPDATE",
            &[&project],
        )
        .await?
    else {
        return Ok(None);
    };
    let rows = tx
        .query(
            "SELECT w.id, w.uid, w.owner_agent_id, a.name, w.last_fired, w.created_at, w.once,
                    coalesce((w.memo->>'notice')::boolean, false)
               FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id
              WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed'
                AND (w.memo->>'target_id')::bigint = $2 AND a.state = 'live' AND a.kind = 'agent'
              ORDER BY w.id LIMIT 64",
            &[&org_id, &project],
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
    let Some(w) = pick(&eligible).cloned() else { return Ok(None) };
    let mail_id: i64 = m.get(0);
    let mail_uid: String = m.get(1);
    let body: String = m.get(7);
    let notice = m.get::<_, bool>(6) || w.notice;
    let copy = uid("m");
    let via = json!({ "via_project": { "id": project, "name": pname, "mail": mail_uid, "dog": w.uid } });
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
                        'dog', $4::text, 'copy', $5::text, 'at', now()))
          WHERE id = $1",
        &[&mail_id, &w.owner_name, &w.owner, &w.uid, &copy],
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
