//! Operation receipts: the E7 claim, replay classification, the §4.12
//! lookup fence and the E-D13 in-flight rows (CONTRACT-M1 §3.2, §4).

use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Binding, OpIdentity};
use crate::session::{DbError, Session};
use crate::value::{Rows, Val};
use crate::Tx;

pub const CLAIM_LABEL: &str = "receipt.claim";
pub const READ_LABEL: &str = "receipt.read";
pub const FINALIZE_LABEL: &str = "receipt.finalize";
pub const LATE_INSERT_LABEL: &str = "receipt.late_insert";
pub const FENCE_LABEL: &str = "receipt.fence";
pub const INFLIGHT_INSERT_LABEL: &str = "inflight.insert";
pub const INFLIGHT_DELETE_LABEL: &str = "inflight.delete";
pub const INFLIGHT_LIVE_LABEL: &str = "inflight.live";

/// E7: the first write after admission. An uncommitted claim under the same
/// key makes this INSERT wait; a committed one makes it insert nothing.
pub const CLAIM_SQL: &str = "INSERT INTO operation_receipts \
    (org_id, ns_kind, ns_id, op_key, receipt_id, state, family, verb, fingerprint, fingerprint_codec, \
     principal_kind, principal_id, generation, acting_id, db_incarnation, created_at) \
    VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp()) \
    ON CONFLICT ON CONSTRAINT operation_receipts_original_key DO NOTHING \
    RETURNING receipt_id";

pub const READ_SQL: &str = "SELECT state, fingerprint, result, receipt_id FROM operation_receipts \
    WHERE org_id = $1 AND ns_kind = $2 AND ns_id = $3 AND op_key = $4";

pub const FINALIZE_SQL: &str = "UPDATE operation_receipts \
    SET state = 'applied', result = $5, decided_at = clock_timestamp() \
    WHERE org_id = $1 AND ns_kind = $2 AND ns_id = $3 AND op_key = $4 AND state = 'claimed' \
    RETURNING receipt_id";

/// Unsafe control `Q-RL1.late_receipt_separate_fence` only: the receipt
/// written at the END, as a plain insert, with no earlier claim.
pub const LATE_INSERT_SQL: &str = "INSERT INTO operation_receipts \
    (org_id, ns_kind, ns_id, op_key, receipt_id, state, family, verb, fingerprint, fingerprint_codec, \
     principal_kind, principal_id, generation, acting_id, db_incarnation, created_at, result, decided_at) \
    VALUES ($1, $2, $3, $4, $5, 'applied', $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp(), $15, clock_timestamp()) \
    RETURNING receipt_id";

/// §4.12 step 5: the fence is an insert on the ORIGINAL's key.
pub const FENCE_SQL: &str = "INSERT INTO operation_receipts \
    (org_id, ns_kind, ns_id, op_key, receipt_id, state, family, principal_kind, principal_id, generation, \
     db_incarnation, created_at, decided_at) \
    VALUES ($1, $2, $3, $4, $5, 'fenced', 'receipt-lookup', $6, $7, $8, $9, clock_timestamp(), clock_timestamp()) \
    ON CONFLICT ON CONSTRAINT operation_receipts_original_key DO NOTHING \
    RETURNING receipt_id";

pub const INFLIGHT_INSERT_SQL: &str = "INSERT INTO runtime_inflight \
    (org_id, ns_kind, ns_id, op_key, service_incarnation, call_id, admitted_at) \
    VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())";

/// Deletes exactly this call's row (a same-key duplicate keeps its own).
pub const INFLIGHT_DELETE_SQL: &str = "DELETE FROM runtime_inflight \
    WHERE org_id = $1 AND ns_kind = $2 AND ns_id = $3 AND op_key = $4 AND service_incarnation = $5 AND call_id = $6";

/// An in-flight row counts only if its owning service is live: the liveness
/// connection's (pid, backend_start) is in pg_stat_activity (CONTRACT-M1 §4).
pub const INFLIGHT_LIVE_SQL: &str = "SELECT i.service_incarnation FROM runtime_inflight i \
    JOIN service_incarnations s ON s.incarnation_id = i.service_incarnation \
    JOIN pg_stat_activity a ON a.pid = s.liveness_pid AND a.backend_start = s.liveness_backend_start \
    WHERE i.org_id = $1 AND i.ns_kind = $2 AND i.ns_id = $3 AND i.op_key = $4 AND s.stopped_at IS NULL \
    LIMIT 1";

pub fn key_params(op: &OpIdentity) -> [Val; 4] {
    [
        Val::Uuid(op.org),
        Val::text(op.ns.kind()),
        Val::Uuid(op.ns.id()),
        Val::text(op.key.clone()),
    ]
}

fn identity_params(b: &Binding, family: &str, verb: &str, receipt_id: Uuid) -> Vec<Val> {
    let mut p: Vec<Val> = key_params(&b.op).into();
    p.push(Val::Uuid(receipt_id));
    p.push(Val::text(family));
    p.push(Val::text(verb));
    p.push(Val::text(b.op.fingerprint.clone()));
    p.push(Val::text(b.op.fingerprint_codec));
    p.push(Val::text(b.principal.kind()));
    p.push(Val::opt_uuid(b.principal.id()));
    p.push(Val::opt_int(b.principal.generation()));
    p.push(Val::opt_uuid(b.acting));
    p.push(Val::Uuid(b.db_incarnation));
    p
}

/// Returns true when this attempt's claim was inserted.
pub async fn claim<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, family: &str, verb: &str) -> Result<bool, DbError> {
    let rows = tx.exec(CLAIM_LABEL, CLAIM_SQL, &identity_params(b, family, verb, Uuid::new_v4())).await?;
    Ok(!rows.is_empty())
}

pub async fn late_insert<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, family: &str, verb: &str, result: Value) -> Result<bool, DbError> {
    let mut p = identity_params(b, family, verb, Uuid::new_v4());
    p.push(Val::Json(result));
    let rows = tx.exec(LATE_INSERT_LABEL, LATE_INSERT_SQL, &p).await?;
    Ok(!rows.is_empty())
}

pub async fn finalize<S: Session>(tx: &mut Tx<'_, S>, op: &OpIdentity, result: Value) -> Result<bool, DbError> {
    let mut p: Vec<Val> = key_params(op).into();
    p.push(Val::Json(result));
    let rows = tx.exec(FINALIZE_LABEL, FINALIZE_SQL, &p).await?;
    Ok(rows.len() == 1)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub state: String,
    pub fingerprint: Option<String>,
    pub result: Option<Value>,
}

pub fn decode_stored(rows: &Rows) -> Option<Stored> {
    let r = rows.first()?;
    Some(Stored {
        state: r.first()?.as_text()?.to_string(),
        fingerprint: r.get(1).and_then(|v| v.as_text()).map(str::to_string),
        result: r.get(2).and_then(|v| v.as_json()).cloned(),
    })
}

pub async fn read<S: Session>(tx: &mut Tx<'_, S>, op: &OpIdentity) -> Result<Option<Stored>, DbError> {
    let rows = tx.exec(READ_LABEL, READ_SQL, &key_params(op)).await?;
    Ok(decode_stored(&rows))
}

/// What an existing committed row means for a call with fingerprint `fp`.
#[derive(Clone, Debug, PartialEq)]
pub enum Existing {
    Replay(Value),
    Compensated(Value),
    Conflict,
    Fenced,
    /// A committed row in a state this build does not know, or `claimed`
    /// (which the commit trigger makes impossible): a defect, never a replay.
    Invalid(String),
}

pub fn classify(stored: &Stored, fp: &str) -> Existing {
    match stored.state.as_str() {
        "fenced" => Existing::Fenced,
        "applied" | "compensated" => {
            if stored.fingerprint.as_deref() != Some(fp) {
                return Existing::Conflict;
            }
            let v = stored.result.clone().unwrap_or(Value::Null);
            if stored.state == "applied" {
                Existing::Replay(v)
            } else {
                Existing::Compensated(v)
            }
        }
        other => Existing::Invalid(format!("receipt in state {other:?}")),
    }
}
