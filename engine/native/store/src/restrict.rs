//! The durable side of r7 C5 restrictions (CONTRACT-M1 §6, r3 lead ruling F1).
//!
//! * A **narrowing writer** calls [`record`] inside its own policy
//!   transaction: it takes the org's `restriction_epoch` control row
//!   `FOR SHARE` FIRST, then records the restriction (with the version it
//!   observed as `epoch`) and one obligation per registered read service.
//!   Narrowing writers never block each other.
//! * A **read service registers** with [`Executor::register_read_service`]:
//!   `FOR NO KEY UPDATE` on the same row, bump its version, insert the
//!   registration, install that version. A narrowing writer that waited on it
//!   reads registrations afterwards (READ COMMITTED) or gets `40001`
//!   (SERIALIZABLE) and retries; a registration that waited on a narrowing
//!   writer starts serving after that restriction committed.
//! * A service **acknowledges** with [`Executor::ack_restriction`]; the
//!   restriction becomes Effective when no obligation is pending.
//!
//! Registration and acknowledgement are infrastructure transactions, not
//! executor commands: they write no receipt (CONTRACT-M1 §3.7) and their
//! tables are excluded from publication.

use uuid::Uuid;

use crate::exec::{Executor, ExecError, Isolation, OpIdentity};
use crate::hooks::controls;
use crate::session::{Connector, DbError, Session};
use crate::value::Val;
use crate::Tx;

pub const EPOCH_SHARE_SQL: &str = "SELECT version FROM org_controls \
    WHERE org_id = $1 AND family = 'restriction_epoch' FOR SHARE";
pub const EPOCH_LOCK_SQL: &str = "SELECT version FROM org_controls \
    WHERE org_id = $1 AND family = 'restriction_epoch' FOR NO KEY UPDATE";
pub const EPOCH_READ_SQL: &str = "SELECT version FROM org_controls \
    WHERE org_id = $1 AND family = 'restriction_epoch'";
pub const EPOCH_BUMP_SQL: &str = "UPDATE org_controls SET version = version + 1 \
    WHERE org_id = $1 AND family = 'restriction_epoch' RETURNING version";
pub const REGISTER_SQL: &str = "INSERT INTO read_service_registrations \
    (org_id, service_incarnation, installed_epoch, registered_at) VALUES ($1, $2, $3, clock_timestamp()) \
    ON CONFLICT ON CONSTRAINT read_service_registrations_pk \
    DO UPDATE SET installed_epoch = EXCLUDED.installed_epoch, registered_at = EXCLUDED.registered_at";
pub const INSERT_RESTRICTION_SQL: &str = "INSERT INTO restrictions \
    (org_id, restriction_id, epoch, reason, principals, committed_at) VALUES ($1, $2, $3, $4, NULL, clock_timestamp())";
pub const INSERT_OBLIGATIONS_SQL: &str = "INSERT INTO restriction_obligations (org_id, restriction_id, service_incarnation) \
    SELECT org_id, $2, service_incarnation FROM read_service_registrations WHERE org_id = $1 \
    RETURNING service_incarnation";
pub const ACK_SQL: &str = "UPDATE restriction_obligations SET acked_at = clock_timestamp() \
    WHERE org_id = $1 AND restriction_id = $2 AND service_incarnation = $3 AND acked_at IS NULL";
pub const EFFECTIVE_SQL: &str = "UPDATE restrictions SET effective_at = clock_timestamp() \
    WHERE org_id = $1 AND restriction_id = $2 AND effective_at IS NULL \
    AND NOT EXISTS (SELECT 1 FROM restriction_obligations o WHERE o.org_id = $1 AND o.restriction_id = $2 AND o.acked_at IS NULL) \
    RETURNING restriction_id";

pub fn missing_epoch_row() -> DbError {
    DbError::Sql { code: "XX000".into(), constraint: None, message: "org has no restriction_epoch control row".into() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    pub restriction_id: Uuid,
    /// The restriction_epoch version this writer observed.
    pub epoch: i64,
    /// The services that now owe an acknowledgement.
    pub obligations: Vec<Uuid>,
}

/// Record a restriction inside the narrowing writer's transaction. Coarse
/// (principals = NULL = every claim in the org), which r7 C5 allows.
pub async fn record<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, reason: &str) -> Result<Recorded, DbError> {
    let rows = tx.exec("restrict.epoch_share", EPOCH_SHARE_SQL, &[Val::Uuid(org)]).await?;
    let epoch = rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(missing_epoch_row)?;
    let id = Uuid::new_v4();
    tx.exec("restrict.insert", INSERT_RESTRICTION_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Int(epoch), Val::text(reason)]).await?;
    let obl = tx.exec("restrict.obligations", INSERT_OBLIGATIONS_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
    let obligations = obl.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
    Ok(Recorded { restriction_id: id, epoch, obligations })
}

impl<C: Connector> Executor<C> {
    /// Register (or re-register) a read service for `org` and return the
    /// epoch it must install before serving.
    pub async fn register_read_service(&self, org: Uuid, service: Uuid) -> Result<i64, ExecError> {
        let mut conn = self.reserved().get().await.map_err(ExecError::Sql)?;
        let op = OpIdentity::minted(org, "", "none");
        let mut tx = Tx::new_internal(&mut *conn, self.hooks(), "restrict", "register", &op, None, 1, None);
        let r: Result<i64, DbError> = async {
            tx.begin(Isolation::ReadCommitted).await?;
            // Unsafe control (Q-C6 register-during-restriction variant):
            // registration without its lock and without the version bump.
            let epoch = if controls::fire(&tx.scope(), "Q-C6.register_without_lock") {
                let rows = tx.exec("restrict.epoch_read", EPOCH_READ_SQL, &[Val::Uuid(org)]).await?;
                rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(missing_epoch_row)?
            } else {
                tx.exec("restrict.epoch_lock", EPOCH_LOCK_SQL, &[Val::Uuid(org)]).await?;
                tx.pause("after_epoch_lock").await?;
                let rows = tx.exec("restrict.epoch_bump", EPOCH_BUMP_SQL, &[Val::Uuid(org)]).await?;
                rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(missing_epoch_row)?
            };
            tx.exec("restrict.register", REGISTER_SQL, &[Val::Uuid(org), Val::Uuid(service), Val::Int(epoch)]).await?;
            tx.pause("before_commit").await?;
            tx.commit_quiet().await?;
            Ok(epoch)
        }
        .await;
        if r.is_err() {
            tx.rollback_quiet().await;
        }
        r.map_err(ExecError::Sql)
    }

    /// A service acknowledges one obligation; returns true when this ack made
    /// the restriction Effective.
    pub async fn ack_restriction(&self, org: Uuid, restriction: Uuid, service: Uuid) -> Result<bool, ExecError> {
        let mut conn = self.reserved().get().await.map_err(ExecError::Sql)?;
        let op = OpIdentity::minted(org, "", "none");
        let mut tx = Tx::new_internal(&mut *conn, self.hooks(), "restrict", "ack", &op, None, 1, None);
        let r: Result<bool, DbError> = async {
            tx.begin(Isolation::ReadCommitted).await?;
            tx.exec("restrict.ack", ACK_SQL, &[Val::Uuid(org), Val::Uuid(restriction), Val::Uuid(service)]).await?;
            let eff = tx.exec("restrict.effective", EFFECTIVE_SQL, &[Val::Uuid(org), Val::Uuid(restriction)]).await?;
            tx.commit_quiet().await?;
            Ok(!eff.is_empty())
        }
        .await;
        if r.is_err() {
            tx.rollback_quiet().await;
        }
        r.map_err(ExecError::Sql)
    }
}
