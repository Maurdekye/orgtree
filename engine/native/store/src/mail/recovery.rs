//! Recovery (v6 MAIL-STAGES "Recovery, refusal and eventual settlement"):
//! a model-independent sweep over indexed PENDING source intents with fair
//! per-destination limits. It is the durable fallback for every lost hint:
//! a Sent message is delivered by recovery whether or not its hint arrived,
//! and whether or not any AI turn runs.
//!
//! A pick is a conditional update of the intent (`attempts + 1`, a new
//! `due_at`), so two sweepers never pick the same intent at once; a pick past
//! the retry horizon makes the intent DORMANT (still pending custody, no hot
//! retries); [`Reactivate`] (the bounded periodic check) makes dormant
//! intents pending again. Nothing here ever refuses mail: terminal refusal
//! needs a receiver's proven fence.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, ExecError, Executor, Family, Isolation};
use crate::mail::receive::{self, Delivery};
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::Tx;

pub static RECOVERY: Family = Family { name: "mail.recovery", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Candidates: due pending intents, at most `per_dest` per destination
/// mailbox, a pair's members in pair order (so a parked successor follows its
/// predecessor), destinations in rotation by their oldest intent.
pub const CANDIDATES_SQL: &str = "SELECT intent_id, kind, source_ref, dest_ref FROM ( \
    SELECT i.intent_id, i.kind, i.source_ref, i.dest_ref, i.created_at, s.pair_seq, \
           row_number() OVER (PARTITION BY i.dest_ref ORDER BY s.pair_seq NULLS FIRST, i.created_at, i.intent_id) AS rn \
    FROM outgoing_intents i LEFT JOIN mail_sent s ON s.org_id = i.org_id AND s.message_id = i.source_ref \
    WHERE i.org_id = $1 AND i.kind IN ('mail.deliver', 'mail.retract') AND i.stage = 'pending' AND i.due_at <= $2) c \
    WHERE rn <= $3 ORDER BY rn, created_at, intent_id LIMIT $4";
pub const PICK_SQL: &str = "UPDATE outgoing_intents SET attempts = attempts + 1, due_at = $3, \
    stage = CASE WHEN attempts + 1 >= $4 THEN 'dormant' ELSE stage END \
    WHERE org_id = $1 AND intent_id = $2 AND stage = 'pending' AND due_at <= $5 RETURNING attempts, stage";
pub const REACTIVATE_SQL: &str = "WITH r AS (UPDATE outgoing_intents SET stage = 'pending', attempts = 0, due_at = $2 \
    WHERE org_id = $1 AND stage = 'dormant' AND kind IN ('mail.deliver', 'mail.retract') RETURNING 1) SELECT count(*) FROM r";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Picked {
    pub kind: String,
    pub message: Uuid,
    pub mailbox: Uuid,
    /// The pick moved this intent to dormant (retry horizon reached).
    pub dormant: bool,
}

/// One sweep's pick (its own short transaction).
pub struct Sweep {
    /// Only intents due at least this long ago (lets the hint path deliver a
    /// fresh send first; recovery is the fallback).
    pub grace_ms: i64,
    pub per_dest: i64,
    pub limit: i64,
    /// Attempts after which an intent becomes dormant.
    pub horizon: i64,
    /// Backoff before the next pick of the same intent.
    pub backoff_ms: i64,
}

impl Default for Sweep {
    fn default() -> Self {
        Sweep { grace_ms: 0, per_dest: 4, limit: 64, horizon: 16, backoff_ms: 0 }
    }
}

impl Command for Sweep {
    type Output = Vec<Picked>;
    fn family(&self) -> &'static Family {
        &RECOVERY
    }
    fn verb(&self) -> &'static str {
        "sweep"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Vec<Picked>) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Vec<Picked>>, CmdError> {
        let org = b.op.org;
        let now = tx.now().await?;
        let due = now - self.grace_ms * 1000;
        let rows = tx.exec("recovery.candidates", CANDIDATES_SQL, &[Val::Uuid(org), Val::Ts(due), Val::Int(self.per_dest), Val::Int(self.limit)]).await?;
        let mut out = Vec::new();
        for r in &rows.0 {
            let (Some(id), Some(kind), Some(msg), Some(mb)) = (r.first().and_then(Val::as_uuid), r.get(1).and_then(Val::as_text), r.get(2).and_then(Val::as_uuid), r.get(3).and_then(Val::as_uuid)) else {
                continue;
            };
            let picked = tx
                .exec("recovery.pick", PICK_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Ts(now + self.backoff_ms * 1000), Val::Int(self.horizon), Val::Ts(due)])
                .await?;
            if let Some(p) = picked.first() {
                out.push(Picked { kind: kind.to_string(), message: msg, mailbox: mb, dormant: p.get(1).and_then(Val::as_text) == Some("dormant") });
            }
        }
        Ok(Decided::Applied(out))
    }
}

/// The bounded periodic check: every dormant mail intent becomes pending again.
pub struct Reactivate;

impl Command for Reactivate {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &RECOVERY
    }
    fn verb(&self) -> &'static str {
        "reactivate"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let now = tx.now().await?;
        let rows = tx.exec("recovery.reactivate", REACTIVATE_SQL, &[Val::Uuid(b.op.org), Val::Ts(now)]).await?;
        Ok(Decided::Applied(rows.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0)))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovered {
    pub picked: usize,
    pub delivered: usize,
    pub parked: usize,
    pub failed: usize,
    pub dormant: usize,
}

/// One recovery pass: pick, then deliver (or retract) each picked intent in
/// its own receiver transaction and acknowledge it. A picked dormant intent is
/// still attempted once.
pub async fn recover<C: Connector>(exec: &Executor<C>, org: Uuid, sweep: &Sweep) -> Result<Recovered, ExecError> {
    let b = receive::receiver_binding(org, "recovery-sweep");
    let picked = match exec.run(sweep, &b).await? {
        crate::Outcome::Applied(p) | crate::Outcome::Replayed(p) => p,
        _ => return Ok(Recovered::default()),
    };
    let mut r = Recovered { picked: picked.len(), ..Recovered::default() };
    for p in picked {
        r.dormant += p.dormant as usize;
        if p.kind == "mail.retract" {
            match receive::retract(exec, org, p.mailbox, p.message).await? {
                Some(_) => r.delivered += 1,
                None => r.failed += 1,
            }
            continue;
        }
        match receive::deliver(exec, org, p.mailbox, p.message).await? {
            Delivery::Done(_) => r.delivered += 1,
            Delivery::Parked => r.parked += 1,
            Delivery::NotDone(_) => r.failed += 1,
        }
    }
    Ok(r)
}
