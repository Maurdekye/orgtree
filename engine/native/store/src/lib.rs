//! P03 store core (`CONTRACT-M1.md`).
//!
//! * [`exec`]: the C1 command executor — bounded fair pool, per-family
//!   isolation, receipt claim before any new-execution predicate, bounded
//!   retries on `40001`/`40P01`/allowlisted `23505` with the same operation
//!   identity and a fresh attempt timestamp, unknown-commit resolution by the
//!   same key, effects only after commit.
//! * [`session`]: the driver boundary. Everything above it is testable with
//!   the in-memory [`fake`] session (feature `fake`, or in this crate's tests).
//! * [`hooks`]: trace sink (always), pause points and unsafe controls
//!   (feature `qualification` only).
//! * [`claims`]: the r7 C5 output-claim registry.
//! * [`sent`]: the Sent interface (WS5): the source half of two-stage mail.
//! * [`mail`]: the receiver half, the notice box and its fold, hints (WS5).
//! * [`runtime`]: WS5's minimal runtime claims (kickoff, wake, admission).
//!
//! What is NOT here yet: the tokio-postgres session, receipt lookup against a
//! real database, the store-service binary. Passing these tests proves the
//! executor's decision logic over a fake session, not PostgreSQL behaviour.

pub mod charter;
pub mod claims;
pub mod conn;
pub mod exec;
pub mod funding;
pub mod hooks;
pub mod island;
pub mod lookup;
pub mod mail;
pub mod pg;
pub mod pool;
pub mod preview;
pub mod read;
pub mod receipts;
pub mod reservation;
pub mod restrict;
pub mod retry;
pub mod runtime;
pub mod sent;
pub mod session;
pub mod staffing;
pub mod status;
pub mod strict;
pub mod value;
pub mod work;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use exec::{
    Binding, Command, CmdError, Decided, ExecConfig, ExecError, Executor, Family, Isolation,
    KeyNamespace, OpIdentity, Outcome, Principal, Refusal, Tx,
};
pub use session::{Connector, DbError, Session};
pub use value::{Rows, Val};
pub use uuid::Uuid;
