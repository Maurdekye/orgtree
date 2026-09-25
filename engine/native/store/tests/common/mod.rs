#![allow(dead_code)]
//! Shared fixtures for the pure executor tests.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orgtree_store::fake::{FakeConnector, FakeDb};
use orgtree_store::hooks::{EventKind, Hooks, TraceEvent, TraceSink};
use orgtree_store::{
    Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity, Principal,
    Refusal, Session, Tx, Uuid, Val,
};
use serde::{Deserialize, Serialize};

pub static FAM: Family = Family { name: "test", isolation: Isolation::ReadCommitted, retry_unique: &["resource_reservations_held_resource"] };

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Out {
    pub n: i64,
    pub ts: Option<i64>,
}

/// A command that anchors, inserts one domain row, and registers one effect.
pub struct InsertOne {
    pub refuse: bool,
    pub disclose: bool,
    pub use_now: bool,
    pub effects: Arc<AtomicUsize>,
}

impl InsertOne {
    pub fn new() -> InsertOne {
        InsertOne { refuse: false, disclose: true, use_now: false, effects: Arc::new(AtomicUsize::new(0)) }
    }
    pub fn effects_run(&self) -> usize {
        self.effects.load(Ordering::SeqCst)
    }
}

impl Command for InsertOne {
    type Output = Out;
    fn family(&self) -> &'static Family {
        &FAM
    }
    fn verb(&self) -> &'static str {
        "insert_one"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        tx.exec("test.anchor", "SELECT 1 FROM authority_epoch WHERE false FOR SHARE", &[]).await?;
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _stored: &Out) -> Result<bool, CmdError> {
        Ok(self.disclose)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<Out>, CmdError> {
        tx.exec("test.lock_own_row", "SELECT 1 FOR NO KEY UPDATE", &[]).await?;
        let ts = if self.use_now { Some(tx.now().await?) } else { None };
        tx.exec("fake.insert:rows", "INSERT ...", &[Val::Int(7), Val::opt_int(ts)]).await?;
        if self.refuse {
            return Ok(Decided::Refused(Refusal::new("test_refusal", "refused after writing")));
        }
        let c = self.effects.clone();
        tx.after_commit(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        Ok(Decided::Applied(Out { n: 7, ts }))
    }
}

pub fn org() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_0001)
}

pub fn agent() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0000_00a1)
}

pub fn binding(key: &str, fp: &str) -> Binding {
    Binding {
        principal: Principal::Agent { id: agent(), generation: 3 },
        acting: None,
        op: OpIdentity {
            org: org(),
            ns: KeyNamespace::Agent { principal: agent() },
            key: key.into(),
            fingerprint: fp.into(),
            fingerprint_codec: "legacy-1",
            caller_keyed: true,
        },
        db_incarnation: Uuid::from_u128(0xdb),
        op_tag: Some("t1".into()),
    }
}

pub fn fast() -> ExecConfig {
    ExecConfig { max_attempts: 5, backoff_base: Duration::ZERO, backoff_cap: Duration::ZERO, lock_timeout_ms: None }
}

#[derive(Default)]
pub struct Collect {
    pub events: Mutex<Vec<String>>,
}

impl TraceSink for Collect {
    fn event(&self, e: &TraceEvent<'_>) {
        let s = match &e.kind {
            EventKind::ControlExecuted { id } => format!("control_executed:{id}"),
            EventKind::Retry { reason, .. } => format!("retry:{reason}"),
            EventKind::Outcome { outcome } => format!("outcome:{outcome}"),
            EventKind::Statement { label, .. } => format!("stmt:{label}{}", if e.stub { ":stub" } else { "" }),
            EventKind::CommitUnknown => "commit_unknown".into(),
            EventKind::Commit { .. } => "commit".into(),
            EventKind::Rollback => "rollback".into(),
            other => format!("{other:?}"),
        };
        self.events.lock().unwrap().push(s);
    }
}

impl Collect {
    pub fn has(&self, s: &str) -> bool {
        self.events.lock().unwrap().iter().any(|e| e == s)
    }
    pub fn count(&self, s: &str) -> usize {
        self.events.lock().unwrap().iter().filter(|e| *e == s).count()
    }
}

pub fn exec_with(db: &Arc<FakeDb>, hooks: Hooks) -> Executor<FakeConnector> {
    Executor::new(FakeConnector { db: db.clone() }, 2, FakeConnector { db: db.clone() }, 1, fast(), hooks)
}

pub fn exec(db: &Arc<FakeDb>) -> (Executor<FakeConnector>, Arc<Collect>) {
    let c = Arc::new(Collect::default());
    (exec_with(db, Hooks::with_trace(c.clone())), c)
}

/// The op_key the claim of each attempt used, in order.
pub fn claim_keys(db: &FakeDb) -> Vec<String> {
    db.log().into_iter().filter(|e| e.label == "receipt.claim").map(|e| e.params[3].as_text().unwrap().to_string()).collect()
}
