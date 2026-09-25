//! Trace sink (always compiled), pause points and unsafe controls
//! (feature `qualification` only). CONTRACT-M1 §5.
//!
//! Without `qualification`, [`crate::exec::Tx::pause`] is an empty inline
//! function, [`controls::fire`] returns `false`, and the pause-hook and
//! control-plan types do not exist:
//!
#![cfg_attr(not(feature = "qualification"), doc = "```compile_fail")]
#![cfg_attr(feature = "qualification", doc = "```")]
//! // Compiles only in a qualification build: the hook type is absent otherwise.
//! fn _needs_hook(_: &dyn orgtree_store::hooks::PauseHook) {}
//! ```

use std::sync::Arc;

use crate::exec::OpIdentity;

/// True only in a qualification build.
pub const QUALIFICATION: bool = cfg!(feature = "qualification");

#[derive(Clone, Debug, PartialEq)]
pub enum EventKind<'a> {
    /// A connection opened through the factory (CONTRACT-M1 §3.8).
    /// `backend_start` (microseconds since the epoch) pairs with the pid so a
    /// reused pid cannot hide a connection. Never a password or URL (§3.8).
    ConnOpened { purpose: &'a str, backend_pid: Option<i32>, backend_start: Option<i64>, host: &'a str, port: u16, role: &'a str, database: &'a str },
    Admitted,
    Begin { isolation: &'static str, backend_pid: Option<i32> },
    /// `sql` is the statement text exactly as passed to `Tx::exec`; values
    /// travel separately and are never traced (v6 PROFILING:14).
    Statement { label: &'a str, sql: &'a str, micros: u64, rows: usize, sqlstate: Option<&'a str> },
    Retry { reason: &'static str, sqlstate: Option<&'a str>, constraint: Option<&'a str> },
    /// `pre_commit_lsn`: `pg_current_wal_insert_lsn()` read just before
    /// COMMIT (qualification builds only): a lower bound on the commit record.
    Commit { pre_commit_lsn: Option<&'a str> },
    Rollback,
    CommitUnknown,
    Effects { count: usize },
    Outcome { outcome: &'static str },
    ControlExecuted { id: &'a str },
    Pause { point: &'a str },
    Lookup { answer: &'static str },
    /// The rows of `trace.xact_stats` (qualification builds), emitted right
    /// after that statement: the server-side relation set for this attempt.
    XactStats { tables: &'a [XactTable] },
    /// The rows of `trace.xact_locks` (qualification builds): granted
    /// relation-level locks this backend holds on store tables before COMMIT.
    XactLocks { locks: &'a [XactLock] },
}

/// One granted relation lock from `pg_locks` (index relations excluded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XactLock {
    pub relname: String,
    /// e.g. `RowShareLock`, `RowExclusiveLock`.
    pub mode: String,
}

/// One row of `pg_stat_xact_user_tables` for the current transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XactTable {
    pub relname: String,
    pub seq_scan: i64,
    /// NULL (no index) is reported as 0.
    pub idx_scan: i64,
    pub n_tup_ins: i64,
    pub n_tup_upd: i64,
    pub n_tup_del: i64,
}

#[derive(Clone, Debug)]
pub struct TraceEvent<'a> {
    pub kind: EventKind<'a>,
    pub family: &'a str,
    pub verb: &'a str,
    pub op: Option<&'a OpIdentity>,
    pub op_tag: Option<&'a str>,
    pub attempt: u32,
    /// Emitted by a stub (the Sent stub): no schedule may pass on it.
    pub stub: bool,
}

pub trait TraceSink: Send + Sync {
    fn event(&self, e: &TraceEvent<'_>);
}

/// The default sink: drops everything.
pub struct NoTrace;

impl TraceSink for NoTrace {
    fn event(&self, _e: &TraceEvent<'_>) {}
}

#[cfg(feature = "qualification")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HookAction {
    Continue,
    /// For the channel mapping: an in-process hook implements Hold by not
    /// resolving until RELEASE, then the executor continues.
    Hold,
    /// The next statement fails with this SQLSTATE, as if from the server.
    FailNext(String),
    /// Close the socket without COMMIT or ROLLBACK.
    DropConn,
    Sleep(u64),
}

#[cfg(feature = "qualification")]
pub struct PausePoint<'a> {
    /// `<family>.<verb>.<point>`
    pub name: &'a str,
    pub family: &'a str,
    pub verb: &'a str,
    pub op: &'a OpIdentity,
    pub op_tag: Option<&'a str>,
    pub attempt: u32,
    pub backend_pid: Option<i32>,
}

#[cfg(feature = "qualification")]
pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[cfg(feature = "qualification")]
pub trait PauseHook: Send + Sync {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction>;
}

/// Which unsafe controls the current run's plan arms.
#[cfg(feature = "qualification")]
pub trait ControlPlan: Send + Sync {
    fn armed(&self, id: &str, op: &OpIdentity, op_tag: Option<&str>) -> bool;
}

#[derive(Clone)]
pub struct Hooks {
    pub trace: Arc<dyn TraceSink>,
    #[cfg(feature = "qualification")]
    pub pause: Option<Arc<dyn PauseHook>>,
    #[cfg(feature = "qualification")]
    pub controls: Option<Arc<dyn ControlPlan>>,
}

impl Default for Hooks {
    fn default() -> Self {
        Hooks {
            trace: Arc::new(NoTrace),
            #[cfg(feature = "qualification")]
            pause: None,
            #[cfg(feature = "qualification")]
            controls: None,
        }
    }
}

impl Hooks {
    pub fn with_trace(trace: Arc<dyn TraceSink>) -> Hooks {
        Hooks { trace, ..Hooks::default() }
    }
}

/// What a trace event or control site knows about the running operation.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub hooks: &'a Hooks,
    pub family: &'a str,
    pub verb: &'a str,
    pub op: Option<&'a OpIdentity>,
    pub op_tag: Option<&'a str>,
    pub attempt: u32,
}

impl<'a> Scope<'a> {
    pub fn emit(&self, kind: EventKind<'_>, stub: bool) {
        self.hooks.trace.event(&TraceEvent {
            kind,
            family: self.family,
            verb: self.verb,
            op: self.op,
            op_tag: self.op_tag,
            attempt: self.attempt,
            stub,
        });
    }
}

pub mod controls {
    use super::Scope;

    /// `if controls::fire(scope, "Q-C4.remint_identity") { <unsafe path> }`.
    /// True only in a qualification build whose plan arms `id` for this
    /// operation; when true it records `control_executed` at this site.
    #[inline(always)]
    pub fn fire(scope: &Scope<'_>, id: &str) -> bool {
        #[cfg(feature = "qualification")]
        {
            if let (Some(plan), Some(op)) = (scope.hooks.controls.as_ref(), scope.op) {
                if plan.armed(id, op, scope.op_tag) {
                    scope.emit(super::EventKind::ControlExecuted { id }, false);
                    return true;
                }
            }
            false
        }
        #[cfg(not(feature = "qualification"))]
        {
            let _ = (scope, id);
            false
        }
    }
}
