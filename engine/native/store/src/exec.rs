//! The C1 command executor (CONTRACT-M1 §3, §4).
//!
//! One attempt: admission → BEGIN at the family's isolation → caller anchor
//! → receipt claim (E7) → execute (read set, decide, apply) → receipt
//! finalize → COMMIT → post-commit effects. Errors are classified per §3.4;
//! a retry reuses the operation identity and recaptures the attempt clock;
//! a lost COMMIT is resolved by re-claiming the same key (§3.6).

use std::future::Future;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::hooks::{controls, EventKind, Hooks, Scope};
use crate::pool::Pool;
use crate::receipts::{self, Existing};
use crate::retry::{self, Class, GLOBAL_RETRY_UNIQUE};
use crate::session::{Connector, DbError, Session};
use crate::value::{Rows, Val};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    ReadCommitted,
    /// The island (r7 C2a).
    Serializable,
    /// Protected reads (r7 C5, S3 E2).
    RepeatableReadReadOnly,
}

impl Isolation {
    pub fn begin_sql(self) -> &'static str {
        match self {
            Isolation::ReadCommitted => "BEGIN ISOLATION LEVEL READ COMMITTED",
            Isolation::Serializable => "BEGIN ISOLATION LEVEL SERIALIZABLE",
            Isolation::RepeatableReadReadOnly => "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Isolation::ReadCommitted => "read_committed",
            Isolation::Serializable => "serializable",
            Isolation::RepeatableReadReadOnly => "repeatable_read_read_only",
        }
    }
}

/// One static per family, registered at startup.
#[derive(Debug)]
pub struct Family {
    pub name: &'static str,
    pub isolation: Isolation,
    /// `23505` constraints this family may retry on, in addition to
    /// [`GLOBAL_RETRY_UNIQUE`].
    pub retry_unique: &'static [&'static str],
}

/// S3 E7 key namespaces.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KeyNamespace {
    /// Agent keys under the IMMUTABLE principal, never the current name.
    Agent { principal: Uuid },
    QuickStaff { item: Uuid },
    Operator { operator: Uuid },
    /// A door without a caller key (E4): the adapter mints one per request.
    Minted,
}

impl KeyNamespace {
    pub fn kind(&self) -> &'static str {
        match self {
            KeyNamespace::Agent { .. } => "agent",
            KeyNamespace::QuickStaff { .. } => "quick_staff",
            KeyNamespace::Operator { .. } => "operator",
            KeyNamespace::Minted => "minted",
        }
    }
    pub fn id(&self) -> Uuid {
        match self {
            KeyNamespace::Agent { principal } => *principal,
            KeyNamespace::QuickStaff { item } => *item,
            KeyNamespace::Operator { operator } => *operator,
            KeyNamespace::Minted => Uuid::nil(),
        }
    }
}

/// Fixed for the whole `run`: every retry and the unknown-commit resolution
/// reuse it (C1, Q-C4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpIdentity {
    pub org: Uuid,
    pub ns: KeyNamespace,
    pub key: String,
    pub fingerprint: String,
    pub fingerprint_codec: &'static str,
    pub caller_keyed: bool,
}

impl OpIdentity {
    /// A keyless door's identity (E4), minted ONCE per request.
    pub fn minted(org: Uuid, fingerprint: impl Into<String>, fingerprint_codec: &'static str) -> OpIdentity {
        OpIdentity {
            org,
            ns: KeyNamespace::Minted,
            key: Uuid::new_v4().to_string(),
            fingerprint: fingerprint.into(),
            fingerprint_codec,
            caller_keyed: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Agent { id: Uuid, generation: i64 },
    Operator { id: Uuid },
    User,
    KioskVisitor { kiosk_incarnation: Uuid },
    System,
}

impl Principal {
    pub fn kind(&self) -> &'static str {
        match self {
            Principal::Agent { .. } => "agent",
            Principal::Operator { .. } => "operator",
            Principal::User => "user",
            Principal::KioskVisitor { .. } => "kiosk_visitor",
            Principal::System => "system",
        }
    }
    pub fn id(&self) -> Option<Uuid> {
        match self {
            Principal::Agent { id, .. } | Principal::Operator { id } => Some(*id),
            Principal::KioskVisitor { kiosk_incarnation } => Some(*kiosk_incarnation),
            Principal::User | Principal::System => None,
        }
    }
    pub fn generation(&self) -> Option<i64> {
        match self {
            Principal::Agent { generation, .. } => Some(*generation),
            _ => None,
        }
    }
}

/// Bound by the authenticated adapter, never by caller JSON.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub principal: Principal,
    /// S3 E5 acting identity.
    pub acting: Option<Uuid>,
    pub op: OpIdentity,
    pub db_incarnation: Uuid,
    /// Harness tag (§5); None outside qualification builds.
    pub op_tag: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

impl Refusal {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Refusal {
        Refusal { code: code.into(), message: message.into() }
    }
}

#[derive(Debug)]
pub enum CmdError {
    /// A statement failed; the executor classifies it (retry or fail).
    Db(DbError),
    /// A logic defect in the command: fail at once, never retry.
    Defect(String),
}

impl From<DbError> for CmdError {
    fn from(e: DbError) -> CmdError {
        CmdError::Db(e)
    }
}

pub enum Decided<T> {
    /// Commit. Post-commit effects are registered on the Tx.
    Applied(T),
    /// Roll back: nothing is written, not even the receipt (E-D5).
    Refused(Refusal),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome<T> {
    Applied(T),
    Replayed(T),
    Compensated(T),
    Conflict,
    Fenced,
    Refused(Refusal),
    RetryExhausted { attempts: u32, last_sqlstate: Option<String> },
    Unknown,
    NotDisclosed,
}

impl<T> Outcome<T> {
    pub fn name(&self) -> &'static str {
        match self {
            Outcome::Applied(_) => "applied",
            Outcome::Replayed(_) => "replayed",
            Outcome::Compensated(_) => "compensated",
            Outcome::Conflict => "conflict",
            Outcome::Fenced => "fenced",
            Outcome::Refused(_) => "refused",
            Outcome::RetryExhausted { .. } => "retry_exhausted",
            Outcome::Unknown => "unknown",
            Outcome::NotDisclosed => "not_disclosed",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum ExecError {
    /// A non-allowlisted unique violation or other non-retryable SQL error.
    Sql(DbError),
    Defect(String),
    Decode(String),
}

pub trait Command: Send + Sync {
    type Output: Serialize + DeserializeOwned + Send + Sync;
    fn family(&self) -> &'static Family;
    fn verb(&self) -> &'static str;
    /// C4 step 1: the caller (or acting) anchor. Runs BEFORE the claim.
    fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> impl Future<Output = Result<(), CmdError>> + Send;
    /// May the current caller see a replayed projection? (v6 I05)
    fn may_disclose<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding, stored: &Self::Output) -> impl Future<Output = Result<bool, CmdError>> + Send;
    /// Read set → decide → apply (C6).
    fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> impl Future<Output = Result<Decided<Self::Output>, CmdError>> + Send;
}

type Effect = Box<dyn FnOnce() + Send>;

/// The only handle a command gets on its transaction.
///
/// Statement text must be static, so a value cannot be spliced into SQL:
///
/// ```compile_fail
/// # use orgtree_store::{Tx, Session, DbError};
/// async fn bad<S: Session>(tx: &mut Tx<'_, S>, name: &str) -> Result<(), DbError> {
///     let sql = format!("SELECT * FROM agents WHERE name = '{name}'");
///     tx.exec("bad", &sql, &[]).await?;
///     Ok(())
/// }
/// ```
pub struct Tx<'a, S: Session> {
    sess: &'a mut S,
    hooks: &'a Hooks,
    family: &'a str,
    verb: &'a str,
    op: &'a OpIdentity,
    op_tag: Option<&'a str>,
    attempt: u32,
    now: Option<i64>,
    prev_attempt_now: Option<i64>,
    effects: Vec<Effect>,
    stub: bool,
    #[cfg(feature = "qualification")]
    fail_next: Option<String>,
}

impl<'a, S: Session> Tx<'a, S> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_internal(
        sess: &'a mut S,
        hooks: &'a Hooks,
        family: &'a str,
        verb: &'a str,
        op: &'a OpIdentity,
        op_tag: Option<&'a str>,
        attempt: u32,
        prev_attempt_now: Option<i64>,
    ) -> Self {
        Self::new(sess, hooks, family, verb, op, op_tag, attempt, prev_attempt_now)
    }

    pub(crate) async fn begin(&mut self, iso: Isolation) -> Result<(), DbError> {
        let r = self.sess.begin(iso).await;
        let pid = self.sess.backend_pid();
        self.emit(EventKind::Begin { isolation: iso.name(), backend_pid: pid });
        self.now = None;
        r
    }

    pub(crate) async fn rollback_quiet(&mut self) {
        if !self.sess.is_broken() {
            let _ = self.sess.rollback().await;
        }
        self.effects.clear();
        self.emit(EventKind::Rollback);
    }

    pub(crate) async fn commit_quiet(&mut self) -> Result<(), DbError> {
        let r = self.sess.commit().await;
        if r.is_ok() {
            self.emit(EventKind::Commit { pre_commit_lsn: None });
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        sess: &'a mut S,
        hooks: &'a Hooks,
        family: &'a str,
        verb: &'a str,
        op: &'a OpIdentity,
        op_tag: Option<&'a str>,
        attempt: u32,
        prev_attempt_now: Option<i64>,
    ) -> Self {
        Tx {
            sess,
            hooks,
            family,
            verb,
            op,
            op_tag,
            attempt,
            now: None,
            prev_attempt_now,
            effects: Vec::new(),
            stub: false,
            #[cfg(feature = "qualification")]
            fail_next: None,
        }
    }

    pub fn scope(&self) -> Scope<'_> {
        Scope { hooks: self.hooks, family: self.family, verb: self.verb, op: Some(self.op), op_tag: self.op_tag, attempt: self.attempt }
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn op(&self) -> &OpIdentity {
        self.op
    }

    /// Mark the following statements' trace events `stub: true` (Sent stub).
    pub fn set_stub(&mut self, stub: bool) {
        self.stub = stub;
    }

    fn emit(&self, kind: EventKind<'_>) {
        self.scope().emit(kind, self.stub);
    }

    /// Run one labelled statement.
    ///
    /// `sql` is `&'static str` ON PURPOSE: statement text reaches traces and
    /// (in qualification builds) the server log, so every user-derived value
    /// must be a bind parameter. A statement built with `format!` from
    /// arguments cannot be passed here (lead condition on `Statement.sql`).
    pub async fn exec(&mut self, label: &str, sql: &'static str, params: &[Val]) -> Result<Rows, DbError> {
        #[cfg(feature = "qualification")]
        {
            self.pause(&format!("stmt.{label}.before")).await?;
            if let Some(code) = self.fail_next.take() {
                let e = DbError::sql(&code);
                self.emit(EventKind::Statement { label, sql, micros: 0, rows: 0, sqlstate: Some(&code) });
                return Err(e);
            }
        }
        let t0 = Instant::now();
        let r = self.sess.exec(label, sql, params).await;
        let micros = t0.elapsed().as_micros() as u64;
        match &r {
            Ok(rows) => self.emit(EventKind::Statement { label, sql, micros, rows: rows.len(), sqlstate: None }),
            Err(e) => self.emit(EventKind::Statement { label, sql, micros, rows: 0, sqlstate: e.sqlstate() }),
        }
        #[cfg(feature = "qualification")]
        if r.is_ok() {
            self.pause(&format!("stmt.{label}.after")).await?;
        }
        r
    }

    /// The attempt clock (C7): `clock_timestamp()` once per attempt, on first
    /// call, cached for the attempt. Call it only after locking your own
    /// mutable rows. A retry gets a new value.
    pub async fn now(&mut self) -> Result<i64, DbError> {
        if let Some(t) = self.now {
            return Ok(t);
        }
        let rows = self.exec("exec.now", "SELECT clock_timestamp()", &[]).await?;
        let mut t = rows
            .first()
            .and_then(|r| r.first())
            .and_then(Val::as_ts)
            .ok_or_else(|| DbError::Sql { code: "XX000".into(), constraint: None, message: "clock_timestamp returned no timestamp".into() })?;
        if let Some(prev) = self.prev_attempt_now {
            // Unsafe control: reuse the old attempt's timestamp on retry.
            if controls::fire(&self.scope(), "Q-C4.stale_attempt_ts") {
                t = prev;
            }
        }
        self.now = Some(t);
        Ok(t)
    }

    /// Register a post-commit effect (a hint; durable intents are rows).
    pub fn after_commit(&mut self, f: impl FnOnce() + Send + 'static) {
        self.effects.push(Box::new(f));
    }

    /// A named pause point `<family>.<verb>.<point>` (qualification builds).
    #[cfg(feature = "qualification")]
    pub async fn pause(&mut self, point: &str) -> Result<(), DbError> {
        use crate::hooks::{HookAction, PausePoint};
        let Some(hook) = self.hooks.pause.clone() else { return Ok(()) };
        let name = format!("{}.{}.{}", self.family, self.verb, point);
        let action = {
            let pp = PausePoint {
                name: &name,
                family: self.family,
                verb: self.verb,
                op: self.op,
                op_tag: self.op_tag,
                attempt: self.attempt,
                backend_pid: self.sess.backend_pid(),
            };
            hook.at(&pp).await
        };
        self.emit(EventKind::Pause { point: &name });
        match action {
            HookAction::Continue | HookAction::Hold => Ok(()),
            HookAction::FailNext(code) => {
                self.fail_next = Some(code);
                Ok(())
            }
            HookAction::DropConn => {
                self.sess.drop_connection();
                Err(DbError::lost())
            }
            HookAction::Sleep(ms) => {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(())
            }
        }
    }

    /// Production build: compiles to nothing.
    #[cfg(not(feature = "qualification"))]
    #[inline(always)]
    pub async fn pause(&mut self, _point: &str) -> Result<(), DbError> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ExecConfig {
    pub max_attempts: u32,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
}

impl Default for ExecConfig {
    fn default() -> Self {
        ExecConfig { max_attempts: 8, backoff_base: Duration::from_millis(2), backoff_cap: Duration::from_millis(200) }
    }
}

enum Step<T> {
    Done(Outcome<T>),
    Fatal(ExecError),
    Retry { err: DbError, reason: &'static str, now: Option<i64>, claimed: bool },
    CommitUnknown { now: Option<i64> },
    LockTimeout { claim_phase: bool },
}

pub struct Executor<C: Connector> {
    pool: Pool<C>,
    reserved: Pool<C>,
    cfg: ExecConfig,
    hooks: Hooks,
}

impl<C: Connector> Executor<C> {
    /// `connector` feeds the command pool; `reserved` a small separate pool
    /// for receipt lookups, in-flight rows and recovery, so accepted work can
    /// still be resolved when new work saturates the main pool (v6
    /// §Scheduling).
    pub fn new(connector: C, pool_size: usize, reserved: C, reserved_size: usize, cfg: ExecConfig, hooks: Hooks) -> Self {
        Executor { pool: Pool::new(connector, pool_size), reserved: Pool::new(reserved, reserved_size), cfg, hooks }
    }

    pub fn reserved(&self) -> &Pool<C> {
        &self.reserved
    }

    pub fn hooks(&self) -> &Hooks {
        &self.hooks
    }

    pub fn pool(&self) -> &Pool<C> {
        &self.pool
    }

    /// The only entry for mutations.
    pub async fn run<Cmd: Command>(&self, cmd: &Cmd, b: &Binding) -> Result<Outcome<Cmd::Output>, ExecError> {
        let family = cmd.family();
        let mut binding = b.clone();
        let mut resolving = false;
        let mut prev_now: Option<i64> = None;
        let mut last_sqlstate: Option<String> = None;
        {
            let s = Scope { hooks: &self.hooks, family: family.name, verb: cmd.verb(), op: Some(&binding.op), op_tag: binding.op_tag.as_deref(), attempt: 0 };
            s.emit(EventKind::Admitted, false);
        }
        for attempt in 1..=self.cfg.max_attempts {
            let step = {
                let mut conn = match self.pool.get().await {
                    Ok(c) => c,
                    Err(e) => {
                        last_sqlstate = e.sqlstate().map(str::to_string);
                        tokio::time::sleep(retry::backoff(attempt, self.cfg.backoff_base, self.cfg.backoff_cap)).await;
                        continue;
                    }
                };
                self.attempt(&mut *conn, cmd, &binding, attempt, prev_now).await
            };
            let scope = Scope { hooks: &self.hooks, family: family.name, verb: cmd.verb(), op: Some(&binding.op), op_tag: binding.op_tag.as_deref(), attempt };
            match step {
                Step::Done(o) => {
                    scope.emit(EventKind::Outcome { outcome: o.name() }, false);
                    return Ok(o);
                }
                Step::Fatal(e) => {
                    scope.emit(EventKind::Outcome { outcome: "error" }, false);
                    return Err(e);
                }
                Step::LockTimeout { claim_phase } => {
                    let o = if resolving && claim_phase {
                        Outcome::Unknown
                    } else {
                        Outcome::RetryExhausted { attempts: attempt, last_sqlstate: Some("55P03".into()) }
                    };
                    scope.emit(EventKind::Outcome { outcome: o.name() }, false);
                    return Ok(o);
                }
                Step::Retry { err, reason, now, claimed } => {
                    scope.emit(EventKind::Retry { reason, sqlstate: err.sqlstate(), constraint: err.constraint() }, false);
                    last_sqlstate = err.sqlstate().map(str::to_string);
                    prev_now = now.or(prev_now);
                    if claimed {
                        // our claim went in, so an in-doubt earlier commit did not happen
                        resolving = false;
                    }
                }
                Step::CommitUnknown { now } => {
                    scope.emit(EventKind::CommitUnknown, false);
                    resolving = true;
                    prev_now = now.or(prev_now);
                }
            }
            // Unsafe control: a retry that regenerates the operation identity.
            if controls::fire(&scope, "Q-C4.remint_identity") {
                binding.op.key = Uuid::new_v4().to_string();
            }
            tokio::time::sleep(retry::backoff(attempt, self.cfg.backoff_base, self.cfg.backoff_cap)).await;
        }
        let o = if resolving {
            Outcome::Unknown
        } else {
            Outcome::RetryExhausted { attempts: self.cfg.max_attempts, last_sqlstate }
        };
        let scope = Scope { hooks: &self.hooks, family: family.name, verb: cmd.verb(), op: Some(&binding.op), op_tag: binding.op_tag.as_deref(), attempt: self.cfg.max_attempts };
        scope.emit(EventKind::Outcome { outcome: o.name() }, false);
        Ok(o)
    }

    async fn attempt<S: Session, Cmd: Command>(&self, sess: &mut S, cmd: &Cmd, b: &Binding, attempt: u32, prev_now: Option<i64>) -> Step<Cmd::Output> {
        let family = cmd.family();
        let mut tx = Tx::new(sess, &self.hooks, family.name, cmd.verb(), &b.op, b.op_tag.as_deref(), attempt, prev_now);
        let mut claimed = false;

        macro_rules! db {
            ($e:expr, $phase:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(e) => return self.fail(&mut tx, family, CmdError::Db(e), claimed, $phase).await,
                }
            };
        }
        macro_rules! cmd {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(e) => return self.fail(&mut tx, family, e, claimed, false).await,
                }
            };
        }

        db!(tx.pause("admitted").await, false);
        {
            let r = tx.sess.begin(family.isolation).await;
            let pid = tx.sess.backend_pid();
            tx.emit(EventKind::Begin { isolation: family.isolation.name(), backend_pid: pid });
            db!(r, false);
        }
        db!(tx.pause("begin").await, false);
        cmd!(cmd.anchor(&mut tx, b).await);
        db!(tx.pause("after_anchor").await, false);

        let late_receipt = controls::fire(&tx.scope(), "Q-RL1.late_receipt_separate_fence");
        if !late_receipt {
            claimed = db!(receipts::claim(&mut tx, b, family.name, cmd.verb()).await, true);
            if !claimed {
                // A committed row exists under this key: never execute again.
                let stored = db!(receipts::read(&mut tx, &b.op).await, false);
                let outcome = match stored {
                    None => Err(ExecError::Defect("claim inserted nothing but no row is visible".into())),
                    Some(s) => match receipts::classify(&s, &b.op.fingerprint) {
                        Existing::Conflict => Ok(Outcome::Conflict),
                        Existing::Fenced => Ok(Outcome::Fenced),
                        Existing::Invalid(m) => Err(ExecError::Defect(m)),
                        Existing::Replay(v) | Existing::Compensated(v) => {
                            let compensated = s.state == "compensated";
                            match serde_json::from_value::<Cmd::Output>(v) {
                                Err(e) => Err(ExecError::Decode(e.to_string())),
                                Ok(out) => match cmd.may_disclose(&mut tx, b, &out).await {
                                    Err(e) => return self.fail(&mut tx, family, e, false, false).await,
                                    Ok(false) => Ok(Outcome::NotDisclosed),
                                    Ok(true) if compensated => Ok(Outcome::Compensated(out)),
                                    Ok(true) => Ok(Outcome::Replayed(out)),
                                },
                            }
                        }
                    },
                };
                self.rollback(&mut tx).await;
                return match outcome {
                    Ok(o) => Step::Done(o),
                    Err(e) => Step::Fatal(e),
                };
            }
            db!(tx.pause("after_claim").await, false);
        }

        let decided = cmd!(cmd.execute(&mut tx, b).await);
        let out = match decided {
            Decided::Refused(r) => {
                self.rollback(&mut tx).await;
                return Step::Done(Outcome::Refused(r));
            }
            Decided::Applied(out) => out,
        };
        let json = match serde_json::to_value(&out) {
            Ok(j) => j,
            Err(e) => {
                self.rollback(&mut tx).await;
                return Step::Fatal(ExecError::Decode(e.to_string()));
            }
        };
        // Unsafe control: run effects before the commit is known.
        let early_effects = controls::fire(&tx.scope(), "Q-C4.effects_before_commit");
        if early_effects {
            let effects = std::mem::take(&mut tx.effects);
            tx.emit(EventKind::Effects { count: effects.len() });
            for f in effects {
                f();
            }
        }
        if late_receipt {
            let ok = db!(receipts::late_insert(&mut tx, b, family.name, cmd.verb(), json).await, false);
            if !ok {
                self.rollback(&mut tx).await;
                return Step::Fatal(ExecError::Defect("late receipt insert returned no row".into()));
            }
        } else {
            let ok = db!(receipts::finalize(&mut tx, &b.op, json).await, false);
            if !ok {
                self.rollback(&mut tx).await;
                return Step::Fatal(ExecError::Defect("receipt finalize updated no claimed row".into()));
            }
        }
        #[cfg(feature = "qualification")]
        {
            // Provisional server-side relation check (CONTRACT-M1 §5).
            let rows = db!(
                tx.exec(
                    "trace.xact_stats",
                    "SELECT relname::text, seq_scan, coalesce(idx_scan, 0), n_tup_ins, n_tup_upd, n_tup_del                      FROM pg_stat_xact_user_tables WHERE schemaname = current_schema()",
                    &[],
                )
                .await,
                false
            );
            let tables: Vec<crate::hooks::XactTable> = rows
                .0
                .iter()
                .filter_map(|r| {
                    Some(crate::hooks::XactTable {
                        relname: r.first()?.as_text()?.to_string(),
                        seq_scan: r.get(1)?.as_int().unwrap_or(0),
                        idx_scan: r.get(2)?.as_int().unwrap_or(0),
                        n_tup_ins: r.get(3)?.as_int().unwrap_or(0),
                        n_tup_upd: r.get(4)?.as_int().unwrap_or(0),
                        n_tup_del: r.get(5)?.as_int().unwrap_or(0),
                    })
                })
                .collect();
            tx.emit(EventKind::XactStats { tables: &tables });
        }
        #[cfg(feature = "qualification")]
        let pre_commit_lsn: Option<String> = {
            let rows = db!(tx.exec("trace.pre_commit_lsn", "SELECT pg_current_wal_insert_lsn()::text", &[]).await, false);
            rows.first().and_then(|r| r.first()).and_then(|v| v.as_text()).map(str::to_string)
        };
        #[cfg(not(feature = "qualification"))]
        let pre_commit_lsn: Option<String> = None;
        db!(tx.pause("before_commit").await, false);
        let now = tx.now;
        match tx.sess.commit().await {
            Ok(()) => tx.emit(EventKind::Commit { pre_commit_lsn: pre_commit_lsn.as_deref() }),
            Err(DbError::ConnectionLost { .. }) => return Step::CommitUnknown { now },
            Err(e) => return self.classify(&mut tx, family, e, claimed, false, false).await,
        }
        // After commit only: nothing below can undo the commit.
        let _ = tx.pause("after_commit").await;
        let _ = tx.pause("before_effects").await;
        let effects = std::mem::take(&mut tx.effects);
        tx.emit(EventKind::Effects { count: effects.len() });
        for f in effects {
            f();
        }
        Step::Done(Outcome::Applied(out))
    }

    async fn rollback<S: Session>(&self, tx: &mut Tx<'_, S>) {
        if !tx.sess.is_broken() {
            let _ = tx.sess.rollback().await;
        }
        tx.effects.clear();
        tx.emit(EventKind::Rollback);
    }

    async fn fail<S: Session, T>(&self, tx: &mut Tx<'_, S>, family: &Family, e: CmdError, claimed: bool, claim_phase: bool) -> Step<T> {
        match e {
            CmdError::Defect(m) => {
                self.rollback(tx).await;
                Step::Fatal(ExecError::Defect(m))
            }
            CmdError::Db(e) => self.classify(tx, family, e, claimed, claim_phase, true).await,
        }
    }

    async fn classify<S: Session, T>(&self, tx: &mut Tx<'_, S>, family: &Family, e: DbError, claimed: bool, claim_phase: bool, rollback: bool) -> Step<T> {
        if rollback {
            self.rollback(tx).await;
        } else {
            tx.effects.clear();
        }
        let allowed = |c: &str| GLOBAL_RETRY_UNIQUE.contains(&c) || family.retry_unique.contains(&c);
        // Unsafe control: retry every unique violation, allowlisted or not.
        let any = e.sqlstate() == Some("23505") && controls::fire(&tx.scope(), "Q-C4.retry_any_23505");
        match retry::classify(&e, &allowed, any) {
            Class::Retry(reason) => Step::Retry { err: e, reason, now: tx.now, claimed },
            Class::LockTimeout => Step::LockTimeout { claim_phase },
            Class::Fatal => Step::Fatal(ExecError::Sql(e)),
        }
    }
}
