//! WS5 minimal runtime claims (S3 §8 obligations 1-3, minimal; v6 I08;
//! Q-CR r2 `runtime.admit`). Only what makes mail Read, kickoff after
//! staffing, wake, and deferral during a folder-move intent real; the rest
//! of the runtime is P08.
//!
//! Durable demands are rows written INSIDE the causing transaction
//! (`outgoing_intents` kinds `kickoff` and `wake`); nothing starts a turn
//! before that transaction commits, and the post-commit hint is volatile.

use uuid::Uuid;

use crate::mail::hints::{self, Hint};
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

pub const KICKOFF_SQL: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'kickoff', $3, $4, $5, $5) ON CONFLICT ON CONSTRAINT outgoing_intents_unique_effect DO NOTHING RETURNING intent_id";

/// Staffing (WS3) records the kickoff of a newly staffed seat inside its own
/// transaction. `cause` is a stable id of the causing operation (for example
/// the kickoff message's original id, or the staffing receipt id), so a
/// replayed or retried staffing records one kickoff. Returns whether a row
/// was inserted.
pub async fn record_kickoff<S: Session>(tx: &mut Tx<'_, S>, principal: Uuid, cause: Uuid) -> Result<bool, DbError> {
    let org = tx.op().org;
    let now = tx.now().await?;
    let rows = tx.exec("runtime.kickoff", KICKOFF_SQL, &[Val::Uuid(org), Val::Uuid(Uuid::new_v4()), Val::Uuid(cause), Val::Uuid(principal), Val::Ts(now)]).await?;
    let inserted = !rows.is_empty();
    if inserted {
        let h = Hint::Runtime { org, principal };
        tx.after_commit(move || hints::emit(h));
    }
    Ok(inserted)
}

pub mod admit;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::exec::{Binding, ExecError, Executor, OpIdentity, Outcome, Principal};
use crate::hooks::{controls, Scope};
use crate::session::Connector;
use admit::{Admission, Admit, Capture, ClaimInput, ConfirmInput, FakeProvider, Settle, Vector, MAX_RECAPTURE};

/// What one turn of the minimal runtime did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Turn {
    /// Admitted, input read and confirmed, settled.
    Ran { claim_id: uuid::Uuid, recaptures: u32, consumed_demands: i64, read: Vec<uuid::Uuid>, vector: Vector },
    /// A folder-move intent is pending for the stack: the turn waits.
    Deferred { claim_id: uuid::Uuid, recaptures: u32 },
    /// Refused (not admissible, busy, an incomplete charter, or the provider's
    /// evidence did not match); `recaptures` counts complete recaptures.
    Refused { code: String, recaptures: u32 },
}

pub fn runtime_binding(org: uuid::Uuid, what: &str) -> Binding {
    Binding { principal: Principal::System, acting: None, op: OpIdentity::minted(org, what, "ws5-runtime-1"), db_incarnation: uuid::Uuid::nil(), op_tag: None }
}

/// One turn of seat `seat` (Q-CR r2 steps 1-2; S3 §8 (2); v6 "Read"):
/// capture (a closed snapshot) → admit (anchored recheck; a stale vector
/// forces a COMPLETE recapture, at most [`MAX_RECAPTURE`] times, counted) →
/// claim input → the fake provider consumes it with NO SQL transaction open
/// (trace markers `runtime.turn.provider_input.begin/.end`) → confirm by
/// evidence → settle.
///
/// Under the Q-CR2.snapshot_held_over_input control a capture snapshot is
/// held open across the whole turn, including the provider input step.
pub async fn run_turn<C: Connector>(exec: &Executor<C>, org: uuid::Uuid, seat: uuid::Uuid, provider: &FakeProvider) -> Result<Turn, ExecError> {
    let op = OpIdentity::minted(org, "turn", "ws5-runtime-1");
    let held = {
        let scope = Scope { hooks: exec.hooks(), family: "runtime", verb: "turn", op: Some(&op), op_tag: None, attempt: 0 };
        controls::fire(&scope, "Q-CR2.snapshot_held_over_input")
    };
    if !held {
        return turn(exec, org, seat, provider, &op).await;
    }
    let h = Arc::new(tokio::sync::Notify::new());
    let cap = Capture { org, seat, hold: Some(h.clone()) };
    let (_, r) = tokio::join!(exec.read(&cap, org, None), async {
        let r = turn(exec, org, seat, provider, &op).await;
        h.notify_one();
        r
    });
    r
}

fn mark(exec_hooks: &crate::hooks::Hooks, op: &OpIdentity, point: &str) {
    let s = Scope { hooks: exec_hooks, family: "runtime", verb: "turn", op: Some(op), op_tag: None, attempt: 0 };
    s.emit(crate::hooks::EventKind::Pause { point }, false);
}

async fn turn<C: Connector>(exec: &Executor<C>, org: uuid::Uuid, seat: uuid::Uuid, provider: &FakeProvider, op: &OpIdentity) -> Result<Turn, ExecError> {
    let scope = Scope { hooks: exec.hooks(), family: "runtime", verb: "turn", op: Some(op), op_tag: None, attempt: 0 };
    let mut recaptures = 0u32;
    let mut last: Option<Vector> = None;
    let turn_id = uuid::Uuid::new_v4();
    let (claim_id, consumed, vector) = loop {
        let partial = recaptures > 0 && last.is_some() && controls::fire(&scope, "Q-CR2.partial_recapture");
        let captured = if partial {
            // Unsafe: re-read only the versions of the nodes already captured,
            // keeping the old chain membership and its charters.
            exec.read(&admit::PartialRecapture { org, old: last.clone().unwrap() }, org, None).await?
        } else {
            exec.read(&Capture { org, seat, hold: None }, org, None).await?
        };
        let vector = match captured {
            Ok(v) => v,
            Err(r) => {
                // Q-CR3 (c): fail closed. The unsafe control reuses the last vector.
                match (&last, controls::fire(&scope, "Q-CR3.cached_fallback")) {
                    (Some(v), true) => v.clone(),
                    _ => return Ok(Turn::Refused { code: r.code, recaptures }),
                }
            }
        };
        last = Some(vector.clone());
        let a = Admit { vector: vector.clone(), turn_id };
        match exec.run(&a, &runtime_binding(org, &format!("admit:{turn_id}:{recaptures}"))).await? {
            Outcome::Applied(Admission::Admitted { claim_id, consumed }) => break (claim_id, consumed, vector),
            Outcome::Applied(Admission::Deferred { claim_id, .. }) => return Ok(Turn::Deferred { claim_id, recaptures }),
            Outcome::Refused(r) if r.code == "recapture" => {
                recaptures += 1;
                if recaptures >= MAX_RECAPTURE {
                    return Ok(Turn::Refused { code: "recapture_exhausted".into(), recaptures });
                }
                continue;
            }
            Outcome::Refused(r) => return Ok(Turn::Refused { code: r.code, recaptures }),
            other => return Ok(Turn::Refused { code: other.name().into(), recaptures }),
        }
    };
    let mut read = Vec::new();
    let batch = match exec.run(&ClaimInput { seat, claim_id }, &runtime_binding(org, &format!("claim-input:{claim_id}"))).await? {
        Outcome::Applied(b) => b,
        other => return Ok(Turn::Refused { code: format!("claim_input {}", other.name()), recaptures }),
    };
    if let Some(b) = batch {
        mark(exec.hooks(), op, "runtime.turn.provider_input.begin");
        let evidence = provider.consume(&b.messages);
        mark(exec.hooks(), op, "runtime.turn.provider_input.end");
        match exec.run(&ConfirmInput { batch_id: b.batch_id, evidence }, &runtime_binding(org, &format!("confirm:{}", b.batch_id))).await? {
            Outcome::Applied(_) => read = b.messages,
            Outcome::Refused(r) => {
                exec.run(&admit::AbandonInput { batch_id: b.batch_id }, &runtime_binding(org, &format!("abandon:{}", b.batch_id))).await?;
                exec.run(&Settle { claim_id }, &runtime_binding(org, &format!("settle:{claim_id}"))).await?;
                return Ok(Turn::Refused { code: r.code, recaptures });
            }
            other => return Ok(Turn::Refused { code: format!("confirm {}", other.name()), recaptures }),
        }
    }
    exec.run(&Settle { claim_id }, &runtime_binding(org, &format!("settle:{claim_id}"))).await?;
    Ok(Turn::Ran { claim_id, recaptures, consumed_demands: consumed, read, vector })
}
