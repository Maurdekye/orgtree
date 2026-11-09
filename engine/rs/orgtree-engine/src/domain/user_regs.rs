//! The user's own registrations on a project, shared helpers (docket
//! let-the-user-manually-hold-a-number-of-a-project; USER 2026-10-20
//! 13:03Z-13:22Z; ops: `domain/ops/user_regs.rs`). A registration is a
//! watchdog or slot lease with no agent owner (`owner_kind` / `holder_kind`
//! 'user', migration 0046). The user's data name is the reserved word
//! `"user"` (no agent can be named it); the desk shows it as "you".
//!
//! Fires and queued jobs reach the user as ordinary mail in their inbox
//! (USER 13:04Z "they both arrive as normal mail in your inbox").
use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::util::{gist, iso};

/// The user's data name; the desk renders it as "you".
pub const USER: &str = "user";

/// Fires a dog keeps in its `events` ring (as every kind).
const EVENTS_KEEP: i64 = 50;

/// Fire one of the user's armed dogs (a listener watch reaching its count):
/// record the fire (a one-shot is spent with it) and put it in the user's
/// inbox as a watchdog mail. There is no agent to wake and no runner to stop:
/// the user's dogs are never armed in the watchdog runtime. Returns whether
/// the dog was one-shot (spent). A dog already spent or removed is left alone.
#[logged]
pub async fn fire_dog(engine: &Arc<Engine>, org_id: i64, row: i64, prefix: &str, lines: Vec<String>) -> Result<bool> {
    let ring: Vec<Value> = lines.iter().take(20).map(|l| json!({ "at": iso(Utc::now()), "gist": gist(l, 200) })).collect();
    let fired = {
        let client = engine.db.get().await?;
        client
            .query_opt(
                "UPDATE ot.watchdogs SET fired = fired + 1, last_fired = now(),
                        events = (SELECT coalesce(jsonb_agg(x ORDER BY n), '[]'::jsonb) FROM (
                            SELECT x, n FROM jsonb_array_elements(events || $2) WITH ORDINALITY AS e(x, n)
                             ORDER BY n DESC LIMIT $3) s),
                        spent_at = CASE WHEN once THEN now() ELSE spent_at END,
                        state = CASE WHEN once THEN 'spent' ELSE state END
                  WHERE id = $1 AND state = 'armed' AND owner_kind = 'user'
                  RETURNING uid, name, kind, target, once, fired",
                &[&row, &Value::Array(ring), &EVENTS_KEEP],
            )
            .await?
    };
    let Some(r) = fired else { return Ok(false) };
    let (uid, name, kind, target, once, count): (String, String, String, String, bool, i32) =
        (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5));
    let mut body = format!("Watchdog \"{name}\" fired{prefix} ({kind} · {target}), fire #{count}:\n");
    let shown: Vec<String> = lines.iter().take(40).cloned().collect();
    for l in &shown {
        body.push_str("  ");
        body.push_str(l);
        body.push('\n');
    }
    if once {
        body.push_str("This was a ONE-SHOT registration: it removed itself with this fire.\n");
    }
    let slug = engine.orgs.by_id(org_id).map(|o| o.slug.clone()).unwrap_or_default();
    let ev = crate::events::watchdog_fired(&slug, &uid, &name, USER, prefix.trim(), &shown, once, None);
    let mut out = Outgoing::new(From::Watchdog { key: crate::domain::watchdogs::handle(USER, &uid), name }, USER, &body);
    out.kind = "watchdog".into();
    out.ev = Some(ev);
    if let Err(e) = mail::send(engine, org_id, out).await {
        tracing::warn!(watchdog = %uid, error = %format!("{e:#}"), "mailing the user their own registration's fire failed");
    }
    changes::notify_id(engine, org_id, vec![Change::Watchdogs, Change::UserMail]);
    Ok(once)
}

/// What `clear` took away, per project.
#[derive(Debug, Default)]
pub struct Cleared {
    /// project id -> (user dogs removed, user slot leases ended)
    pub by_project: std::collections::BTreeMap<i64, (usize, usize)>,
    /// every removed dog: (uid, kind, org id, project id), for the log
    pub dogs: Vec<(String, String, i64, i64)>,
}

impl Cleared {
    #[nolog]
    pub fn is_empty(&self) -> bool {
        self.by_project.is_empty()
    }
}

/// Remove the user's own registrations (listeners, watches, queue places, slot
/// requests and held slot leases) on projects that are no longer live
/// (docket switchboard-clicking-the-user-s-own-watchdog-chi, USER 2026-11-09
/// 20:30Z "Clean up on retire"). Retire, dissolve and delete call it in the
/// same transaction as the archive, with `only` the departing project ids;
/// the engine-start sweep calls it with no filter, so registrations left
/// behind by older versions go too. Idempotent. Restoring a project never
/// brings them back (they are removed, not paused). Agent- and project-owned
/// dogs are not touched. A held lease is ended as the user's own release
/// ends it; nothing is granted behind it (the project is gone).
#[logged]
pub async fn clear(tx: &impl tokio_postgres::GenericClient, org: Option<i64>, only: Option<&[i64]>, why: &str) -> Result<Cleared> {
    let mut out = Cleared::default();
    let leases = tx
        .query(
            "SELECT l.id, l.project_id FROM ot.slot_leases l
              WHERE l.holder_agent_id IS NULL AND l.ended_at IS NULL
                AND ($1::bigint IS NULL OR l.org_id = $1) AND ($2::bigint[] IS NULL OR l.project_id = ANY($2))
                AND NOT EXISTS (SELECT 1 FROM ot.agents p WHERE p.id = l.project_id AND p.state = 'live')
              ORDER BY l.id FOR UPDATE OF l",
            &[&org, &only],
        )
        .await?;
    for l in &leases {
        let (id, project): (i64, i64) = (l.get(0), l.get(1));
        if crate::domain::slots::end(tx, id, why, "the engine").await? {
            out.by_project.entry(project).or_default().1 += 1;
        }
    }
    let dogs = tx
        .query(
            "UPDATE ot.watchdogs w SET state = 'removed', memo = w.memo || jsonb_build_object('reason', $3::text)
              WHERE w.owner_kind = 'user' AND w.state IN ('armed', 'paused') AND w.memo->>'target_id' IS NOT NULL
                AND ($1::bigint IS NULL OR w.org_id = $1) AND ($2::bigint[] IS NULL OR (w.memo->>'target_id')::bigint = ANY($2))
                AND NOT EXISTS (SELECT 1 FROM ot.agents p WHERE p.id = (w.memo->>'target_id')::bigint AND p.state = 'live')
              RETURNING w.uid, w.kind, w.org_id, (w.memo->>'target_id')::bigint",
            &[&org, &only, &why],
        )
        .await?;
    for r in &dogs {
        let (uid, kind, org_id, project): (String, String, i64, i64) = (r.get(0), r.get(1), r.get(2), r.get(3));
        out.by_project.entry(project).or_default().0 += 1;
        out.dogs.push((uid, kind, org_id, project));
    }
    Ok(out)
}

/// Engine start: clear what retired, dissolved or deleted projects left
/// behind. Safe on every start (nothing left means nothing done); each
/// removed dog id is logged, nothing else about it.
#[logged]
pub async fn startup_sweep(engine: &Arc<Engine>) {
    let res: Result<Cleared> = async {
        let mut client = engine.db.get().await?;
        let tx = client.transaction().await?;
        let cleared = clear(&*tx, None, None, "its project is no longer live (cleared at engine start)").await?;
        tx.commit().await?;
        Ok(cleared)
    }
    .await;
    match res {
        Ok(c) => {
            for (uid, kind, org_id, project) in &c.dogs {
                tracing::info!(watchdog = %uid, kind = %kind, project, "removed a user registration left on a project that is no longer live");
                changes::notify_id(engine, *org_id, vec![Change::Watchdogs]);
            }
        }
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "the start-up sweep of the user's registrations on retired projects failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's data name is a word no agent can be given, so a row named
    /// "user" in a slot list, a line or a listener table is always the user.
    #[test]
    fn the_users_data_name_is_a_reserved_word() {
        assert_eq!(USER, "user");
        assert!(crate::domain::ops::valid_name(USER).is_err());
    }
}
