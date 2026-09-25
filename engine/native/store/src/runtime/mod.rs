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
