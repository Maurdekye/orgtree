//! `Executor::read` (CONTRACT-M1 §3.1): one `REPEATABLE READ READ ONLY`
//! snapshot, no receipt, no row or predicate locks (r7 C5 step 3, S3 E2).
//!
//! The operation identity is minted for tracing and pause points only; it is
//! never written. A read never commits anything: the snapshot is closed with
//! ROLLBACK. A lost connection is retried on a fresh one (bounded); any other
//! error is returned. Protected reads register their output claim BEFORE
//! calling this and pass the emit check after it (r7 C5 steps 2 and 5).

use std::future::Future;

use uuid::Uuid;

use crate::exec::{CmdError, Executor, ExecError, Isolation, OpIdentity};
use crate::hooks::{EventKind, Scope};
use crate::retry;
use crate::session::{Connector, DbError, Session};
use crate::Tx;

pub trait Read: Send + Sync {
    type Output: Send;
    fn family(&self) -> &'static str;
    fn verb(&self) -> &'static str;
    /// Read everything the answer needs inside the one snapshot.
    fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> impl Future<Output = Result<Self::Output, CmdError>> + Send;
}

impl<C: Connector> Executor<C> {
    pub async fn read<R: Read>(&self, r: &R, org: Uuid, op_tag: Option<&str>) -> Result<R::Output, ExecError> {
        let op = OpIdentity::minted(org, "", "none");
        let max = self.config().max_attempts;
        let mut last: Option<DbError> = None;
        for attempt in 1..=max {
            let mut conn = match self.pool().get().await {
                Ok(c) => c,
                Err(e) => {
                    last = Some(e);
                    continue;
                }
            };
            let mut tx = Tx::new_internal(&mut *conn, self.hooks(), r.family(), r.verb(), &op, op_tag, attempt, None);
            let res: Result<R::Output, CmdError> = async {
                tx.begin(Isolation::RepeatableReadReadOnly).await?;
                tx.pause("begin").await?;
                let out = r.run(&mut tx).await?;
                tx.pause("before_emit").await?;
                Ok(out)
            }
            .await;
            // A read commits nothing: always close the snapshot with ROLLBACK.
            tx.rollback_quiet().await;
            match res {
                Ok(out) => return Ok(out),
                Err(CmdError::Db(e @ DbError::ConnectionLost { .. })) => {
                    let s = Scope { hooks: self.hooks(), family: r.family(), verb: r.verb(), op: Some(&op), op_tag, attempt };
                    s.emit(EventKind::Retry { reason: "connection_lost", sqlstate: None, constraint: None }, false);
                    last = Some(e);
                    let cfg = self.config();
                    tokio::time::sleep(retry::backoff(attempt, cfg.backoff_base, cfg.backoff_cap)).await;
                }
                Err(CmdError::Db(e)) => return Err(ExecError::Sql(e)),
                Err(CmdError::Defect(m)) => return Err(ExecError::Defect(m)),
                Err(CmdError::Refused(r)) => return Err(ExecError::Defect(format!("a read refused ({}); reads answer, they do not refuse through the executor", r.code))),
                Err(CmdError::RetryAttempt { cause }) => return Err(ExecError::Defect(format!("a read asked for a retry ({cause}); reads have no attempts to retry"))),
            }
        }
        Err(ExecError::Sql(last.unwrap_or_else(DbError::lost)))
    }
}
