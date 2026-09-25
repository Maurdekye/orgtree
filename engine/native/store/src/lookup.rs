//! Receipt lookup (S3 §4.12, E-D13; CONTRACT-M1 §4), in-flight rows and
//! store-service liveness registration.
//!
//! Answer order follows legacy `_op_lookup_call` (`api.py:11025-11140`):
//! conflict first; then a rotated incarnation (an applied row still answers
//! `applied`); applied; an earlier fence; `running`; unsupported verb; key
//! admission refusals; then the fence. The fence and the original contend on
//! one unique key, so exactly one commits (the insert WAITS on an uncommitted
//! original), which holds across processes.

use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Executor, ExecError, Isolation, OpIdentity};
use crate::hooks::{controls, EventKind};
use crate::receipts::{self, Existing, Stored};
use crate::session::{Connector, DbError, Session};
use crate::value::Val;
use crate::Tx;

/// What the door knows about the lost call (legacy `for_tool`/`for_args`).
#[derive(Clone, Debug)]
pub struct LookupReq {
    /// The ORIGINAL call's identity (org, namespace, key, fingerprint).
    pub op: OpIdentity,
    pub caller: Uuid,
    pub caller_generation: i64,
    /// The store incarnation the key was issued under (legacy `op_epoch`).
    pub key_incarnation: Uuid,
    /// Legacy `opreceipts.coverage(tool, args)`, echoed in answers.
    pub coverage: String,
    /// Legacy `opreceipts.receipted(tool, args)`.
    pub receipted: bool,
    /// Legacy `opreceipts.provable_absence(coverage)`.
    pub provable_absence: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LookupAnswer {
    Applied { result: Option<Value>, compensated: bool },
    NotApplied,
    Running,
    Conflict,
    Unknown { reason: &'static str, fenced: bool },
    /// The caller anchor failed (not live, or a stale generation).
    CallerRefused,
}

impl LookupAnswer {
    pub fn name(&self) -> &'static str {
        match self {
            LookupAnswer::Applied { .. } => "applied",
            LookupAnswer::NotApplied => "not_applied",
            LookupAnswer::Running => "running",
            LookupAnswer::Conflict => "conflict",
            LookupAnswer::Unknown { .. } => "unknown",
            LookupAnswer::CallerRefused => "caller_refused",
        }
    }
}

pub const ANCHOR_SQL: &str = "SELECT lifecycle, generation FROM authority_epoch \
    WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const INCARNATION_SQL: &str = "SELECT incarnation FROM store_incarnation";
pub const REGISTER_SERVICE_SQL: &str = "INSERT INTO service_incarnations \
    (incarnation_id, kind, db_incarnation, liveness_pid, liveness_backend_start, started_at) \
    VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000000), clock_timestamp())";
pub const STOP_SERVICE_SQL: &str = "UPDATE service_incarnations SET stopped_at = clock_timestamp() \
    WHERE incarnation_id = $1";

pub static LOOKUP_FAMILY: crate::Family = crate::Family { name: "receipt", isolation: Isolation::ReadCommitted, retry_unique: &[] };

fn absent(req: &LookupReq) -> LookupAnswer {
    if req.provable_absence {
        LookupAnswer::NotApplied
    } else {
        LookupAnswer::Unknown { reason: "pre_transaction_step", fenced: true }
    }
}

/// Legacy key admission for a lookup: grammar, skew and horizon (the
/// op-receipt-codec rules; strict inequalities as in Python).
fn key_refusal(key: &str, now_ms: i64) -> Option<&'static str> {
    use orgtree_op_receipt_codec::{key::parse_key, HORIZON_MS, SKEW_MS};
    let Some(mint) = parse_key(key) else { return Some("malformed_key") };
    if mint > now_ms + SKEW_MS {
        return Some("key_from_the_future");
    }
    if now_ms - mint > HORIZON_MS {
        return Some("key_stale");
    }
    None
}

enum Early {
    Answer(LookupAnswer),
    Continue,
}

fn classify_row(req: &LookupReq, stored: &Option<Stored>, incarnation_ok: bool) -> Early {
    let Some(s) = stored else {
        if !incarnation_ok {
            return Early::Answer(LookupAnswer::Unknown { reason: "epoch_rotated", fenced: false });
        }
        return Early::Continue;
    };
    let existing = receipts::classify(s, &req.op.fingerprint);
    if existing == Existing::Conflict {
        return Early::Answer(LookupAnswer::Conflict);
    }
    match existing {
        Existing::Replay(v) => Early::Answer(LookupAnswer::Applied { result: Some(v), compensated: false }),
        Existing::Compensated(v) => Early::Answer(LookupAnswer::Applied { result: Some(v), compensated: true }),
        Existing::Fenced if !incarnation_ok => Early::Answer(LookupAnswer::Unknown { reason: "epoch_rotated", fenced: true }),
        Existing::Fenced => Early::Answer(absent(req)),
        Existing::Invalid(_) => Early::Answer(LookupAnswer::Unknown { reason: "invalid_receipt", fenced: false }),
        Existing::Conflict => unreachable!(),
    }
}

impl<C: Connector> Executor<C> {
    /// Answer "did the call carrying this key apply?" (never itself keyed).
    pub async fn lookup(&self, req: &LookupReq) -> Result<LookupAnswer, ExecError> {
        let mut conn = self.reserved().get().await.map_err(ExecError::Sql)?;
        let r = self.lookup_on(&mut *conn, req).await;
        let scope = crate::hooks::Scope { hooks: self.hooks(), family: "receipt", verb: "lookup", op: Some(&req.op), op_tag: None, attempt: 1 };
        match &r {
            Ok(a) => scope.emit(EventKind::Lookup { answer: a.name() }, false),
            Err(_) => scope.emit(EventKind::Lookup { answer: "error" }, false),
        }
        r
    }

    async fn lookup_on<S: Session>(&self, sess: &mut S, req: &LookupReq) -> Result<LookupAnswer, ExecError> {
        let hooks = self.hooks();
        let mut tx = Tx::new_internal(sess, hooks, "receipt", "lookup", &req.op, None, 1, None);
        let fail = |e: DbError| ExecError::Sql(e);
        tx.begin(Isolation::ReadCommitted).await.map_err(fail)?;
        tx.set_timeouts(self.config()).await.map_err(fail)?;
        let a = tx.exec("lookup.anchor", ANCHOR_SQL, &[Val::Uuid(req.op.org), Val::Uuid(req.caller)]).await.map_err(fail)?;
        let live = a.first().map_or(false, |r| r.first().and_then(Val::as_text) == Some("live") && r.get(1).and_then(Val::as_int) == Some(req.caller_generation));
        if !live {
            tx.rollback_quiet().await;
            return Ok(LookupAnswer::CallerRefused);
        }
        let stored = receipts::read(&mut tx, &req.op).await.map_err(fail)?;
        let inc = tx.exec("lookup.incarnation", INCARNATION_SQL, &[]).await.map_err(fail)?;
        let incarnation_ok = inc.first().and_then(|r| r.first()).and_then(Val::as_uuid) == Some(req.key_incarnation);
        if let Early::Answer(ans) = classify_row(req, &stored, incarnation_ok) {
            tx.rollback_quiet().await;
            return Ok(ans);
        }
        // E-D13 step 4: an admitted call owned by a LIVE process is running.
        if !controls::fire(&tx.scope(), "Q-RL3.skip_inflight_check") {
            let rows = tx.exec(receipts::INFLIGHT_LIVE_LABEL, receipts::INFLIGHT_LIVE_SQL, &receipts::key_params(&req.op)).await.map_err(fail)?;
            if !rows.is_empty() {
                tx.rollback_quiet().await;
                return Ok(LookupAnswer::Running);
            }
        }
        tx.pause("after_inflight_check").await.map_err(fail)?;
        if !req.receipted {
            tx.rollback_quiet().await;
            return Ok(LookupAnswer::Unknown { reason: "unsupported_operation", fenced: false });
        }
        let now_ms = tx.now().await.map_err(fail)? / 1000;
        if let Some(reason) = key_refusal(&req.op.key, now_ms) {
            tx.rollback_quiet().await;
            return Ok(LookupAnswer::Unknown { reason, fenced: false });
        }
        let separate = controls::fire(&tx.scope(), "Q-RL1.late_receipt_separate_fence");
        if separate {
            // Unsafe control: the check above is committed on its own and the
            // fence runs in a SEPARATE transaction; the answer ignores it.
            tx.commit_quiet().await.map_err(fail)?;
            tx.begin(Isolation::ReadCommitted).await.map_err(fail)?;
        }
        tx.pause("before_fence").await.map_err(fail)?;
        let fence = tx.exec(receipts::FENCE_LABEL, receipts::FENCE_SQL, &fence_params(req)).await;
        let inserted = match fence {
            Ok(rows) => !rows.is_empty(),
            Err(DbError::Sql { code, .. }) if code == "55P03" => {
                // the original's uncommitted claim held the key past the lock
                // timeout: it is running; nothing is fenced
                tx.rollback_quiet().await;
                return Ok(LookupAnswer::Running);
            }
            Err(e) => {
                tx.rollback_quiet().await;
                return Err(fail(e));
            }
        };
        if separate {
            tx.commit_quiet().await.map_err(fail)?;
            return Ok(absent(req));
        }
        if inserted {
            tx.commit_quiet().await.map_err(fail)?;
            return Ok(absent(req));
        }
        // An original committed while we waited: report it.
        let stored = receipts::read(&mut tx, &req.op).await.map_err(fail)?;
        tx.rollback_quiet().await;
        match classify_row(req, &stored, true) {
            Early::Answer(a) => Ok(a),
            Early::Continue => Err(ExecError::Defect("fence inserted nothing but no row is visible".into())),
        }
    }

    /// E-D13: record an admitted keyed call in its own short transaction,
    /// BEFORE the command transaction starts.
    /// Returns this call's id; pass it to [`Self::release_inflight`].
    pub async fn admit_inflight(&self, op: &OpIdentity, service: Uuid) -> Result<Uuid, ExecError> {
        let call = Uuid::new_v4();
        self.short_write(op, "admit", receipts::INFLIGHT_INSERT_LABEL, receipts::INFLIGHT_INSERT_SQL, service, call).await?;
        Ok(call)
    }

    /// Remove it when the call ends, whatever the outcome.
    pub async fn release_inflight(&self, op: &OpIdentity, service: Uuid, call: Uuid) -> Result<(), ExecError> {
        self.short_write(op, "release", receipts::INFLIGHT_DELETE_LABEL, receipts::INFLIGHT_DELETE_SQL, service, call).await
    }

    async fn short_write(&self, op: &OpIdentity, verb: &'static str, label: &'static str, sql: &'static str, service: Uuid, call: Uuid) -> Result<(), ExecError> {
        let mut conn = self.reserved().get().await.map_err(ExecError::Sql)?;
        let mut tx = Tx::new_internal(&mut *conn, self.hooks(), "inflight", verb, op, None, 1, None);
        tx.begin(Isolation::ReadCommitted).await.map_err(ExecError::Sql)?;
        let mut p: Vec<Val> = receipts::key_params(op).into();
        p.push(Val::Uuid(service));
        p.push(Val::Uuid(call));
        if let Err(e) = tx.exec(label, sql, &p).await {
            tx.rollback_quiet().await;
            return Err(ExecError::Sql(e));
        }
        tx.commit_quiet().await.map_err(ExecError::Sql)
    }

    /// `run` wrapped in the in-flight row for a caller-keyed call.
    pub async fn run_keyed<Cmd: crate::Command>(&self, cmd: &Cmd, b: &crate::Binding, service: Uuid) -> Result<crate::Outcome<Cmd::Output>, ExecError> {
        let call = if b.op.caller_keyed { Some(self.admit_inflight(&b.op, service).await?) } else { None };
        let r = self.run(cmd, b).await;
        if let Some(call) = call {
            // a failure here leaves a row owned by a live process until it
            // stops; after that the liveness join ignores it (P08 sweeps)
            let _ = self.release_inflight(&b.op, service, call).await;
        }
        r
    }
}

fn fence_params(req: &LookupReq) -> Vec<Val> {
    let mut p: Vec<Val> = receipts::key_params(&req.op).into();
    p.push(Val::Uuid(Uuid::new_v4()));
    p.push(Val::text("agent"));
    p.push(Val::Uuid(req.caller));
    p.push(Val::Int(req.caller_generation));
    p.push(Val::Uuid(req.key_incarnation));
    p
}

/// A registered store-service process: holds its liveness connection open
/// for its lifetime (CONTRACT-M1 §4).
pub struct Liveness<S: Session> {
    pub incarnation: Uuid,
    sess: S,
    hooks: crate::hooks::Hooks,
}

/// Run one statement on a session outside any operation, TRACED as
/// infrastructure (`exec.service.*` labels; WS7's reconciler matches every
/// logged statement to a traced one on the same pid).
pub async fn traced_exec<S: Session>(sess: &mut S, hooks: &crate::hooks::Hooks, label: &'static str, sql: &'static str, params: &[Val]) -> Result<crate::Rows, DbError> {
    let t0 = std::time::Instant::now();
    let r = sess.exec(label, sql, params).await;
    let s = crate::hooks::Scope { hooks, family: "exec", verb: "service", op: None, op_tag: None, attempt: 0 };
    let micros = t0.elapsed().as_micros() as u64;
    let pid = sess.backend_pid();
    match &r {
        Ok(rows) => s.emit(EventKind::Statement { label, sql, micros, rows: rows.len(), sqlstate: None, backend_pid: pid }, false),
        Err(e) => s.emit(EventKind::Statement { label, sql, micros, rows: 0, sqlstate: e.sqlstate(), backend_pid: pid }, false),
    }
    r
}

impl<S: Session> Liveness<S> {
    pub async fn register<C: Connector<S = S>>(connector: &C, hooks: &crate::hooks::Hooks, kind: &str, db_incarnation: Uuid) -> Result<Liveness<S>, DbError> {
        let mut sess = connector.connect().await?;
        let incarnation = Uuid::new_v4();
        let pid = sess.backend_pid().ok_or_else(|| DbError::lost())?;
        let start = sess.backend_start().ok_or_else(|| DbError::lost())?;
        // one statement in autocommit: atomic, and no untraced BEGIN/COMMIT
        traced_exec(
            &mut sess,
            hooks,
            "exec.service.register",
            REGISTER_SERVICE_SQL,
            &[Val::Uuid(incarnation), Val::text(kind), Val::Uuid(db_incarnation), Val::Int(pid as i64), Val::Int(start)],
        )
        .await?;
        Ok(Liveness { incarnation, sess, hooks: hooks.clone() })
    }

    pub async fn stop(mut self) -> Result<(), DbError> {
        let h = self.hooks.clone();
        traced_exec(&mut self.sess, &h, "exec.service.stop", STOP_SERVICE_SQL, &[Val::Uuid(self.incarnation)]).await.map(|_| ())
    }

    pub fn session(&self) -> &S {
        &self.sess
    }
}
