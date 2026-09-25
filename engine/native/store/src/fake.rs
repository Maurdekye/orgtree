//! An in-memory fake [`Session`] for pure tests (no database).
//!
//! It models what the executor's decisions depend on — the receipt table's
//! unique key and states, transactional buffering (commit applies, rollback
//! discards), the claimed-at-commit trigger, a monotonic `clock_timestamp()`
//! — and injects faults at the Nth execution of a labelled statement or of
//! COMMIT. It does NOT model locking, waiting on an uncommitted key, or
//! isolation: those are PostgreSQL behaviours, proven only on a WS1 cluster.
//!
//! Domain writes in tests use labels `fake.insert:<table>`; other labels
//! return no rows unless a responder is registered for them.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use uuid::Uuid;

use crate::exec::Isolation;
use crate::receipts::{CLAIM_LABEL, FENCE_LABEL, FINALIZE_LABEL, LATE_INSERT_LABEL, READ_LABEL};
use crate::session::{Connector, DbError, Session};
use crate::value::{Rows, Val};

type Key = (Uuid, String, Uuid, String);
type Responder = Arc<dyn Fn(&[Val]) -> Result<Rows, DbError> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct FakeReceipt {
    pub state: String,
    pub fingerprint: Option<String>,
    pub result: Option<Value>,
    pub receipt_id: Uuid,
}

#[derive(Clone, Debug)]
pub enum FaultKind {
    Error(DbError),
    /// COMMIT reaches the server and applies, then the reply is lost.
    CommitLostAfterApply,
    /// The connection dies before the server commits.
    CommitLostBeforeApply,
}

#[derive(Clone, Debug)]
struct Fault {
    label: String,
    nth: usize,
    kind: FaultKind,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub session: u32,
    pub label: String,
    pub params: Vec<Val>,
}

#[derive(Default)]
struct State {
    receipts: BTreeMap<Key, FakeReceipt>,
    tables: BTreeMap<String, Vec<Vec<Val>>>,
    clock: i64,
    faults: Vec<Fault>,
    counts: HashMap<String, usize>,
    log: Vec<LogEntry>,
    responders: HashMap<String, Responder>,
    next_session: u32,
    commits: usize,
}

#[derive(Default)]
pub struct FakeDb {
    st: Mutex<State>,
}

impl FakeDb {
    pub fn new() -> Arc<FakeDb> {
        let db = FakeDb::default();
        db.st.lock().unwrap().clock = 1_700_000_000_000_000;
        Arc::new(db)
    }

    /// Fail the `nth` (1-based) execution of `label` (`"begin"`, `"commit"`
    /// or a statement label), counted across all sessions.
    pub fn fault(&self, label: &str, nth: usize, kind: FaultKind) {
        self.st.lock().unwrap().faults.push(Fault { label: label.into(), nth, kind });
    }

    pub fn respond(&self, label: &str, f: impl Fn(&[Val]) -> Result<Rows, DbError> + Send + Sync + 'static) {
        self.st.lock().unwrap().responders.insert(label.into(), Arc::new(f));
    }

    pub fn receipts(&self) -> Vec<(Key, FakeReceipt)> {
        self.st.lock().unwrap().receipts.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn rows(&self, table: &str) -> Vec<Vec<Val>> {
        self.st.lock().unwrap().tables.get(table).cloned().unwrap_or_default()
    }

    pub fn log(&self) -> Vec<LogEntry> {
        self.st.lock().unwrap().log.clone()
    }

    pub fn labels(&self) -> Vec<String> {
        self.log().into_iter().map(|e| e.label).collect()
    }

    pub fn count(&self, label: &str) -> usize {
        self.st.lock().unwrap().counts.get(label).copied().unwrap_or(0)
    }

    pub fn commits(&self) -> usize {
        self.st.lock().unwrap().commits
    }

    /// Insert a committed receipt directly (test setup).
    pub fn seed_receipt(&self, key: Key, r: FakeReceipt) {
        self.st.lock().unwrap().receipts.insert(key, r);
    }

    fn take_fault(&self, label: &str) -> Option<FaultKind> {
        let mut st = self.st.lock().unwrap();
        let n = {
            let c = st.counts.entry(label.to_string()).or_insert(0);
            *c += 1;
            *c
        };
        st.faults.iter().position(|f| f.label == label && f.nth == n).map(|i| st.faults.remove(i).kind)
    }
}

pub struct FakeConnector {
    pub db: Arc<FakeDb>,
}

impl Connector for FakeConnector {
    type S = FakeSession;
    async fn connect(&self) -> Result<FakeSession, DbError> {
        let id = {
            let mut st = self.db.st.lock().unwrap();
            st.next_session += 1;
            st.next_session
        };
        Ok(FakeSession { db: self.db.clone(), id, pending: BTreeMap::new(), pending_rows: Vec::new(), broken: false })
    }
}

pub struct FakeSession {
    db: Arc<FakeDb>,
    id: u32,
    pending: BTreeMap<Key, FakeReceipt>,
    pending_rows: Vec<(String, Vec<Val>)>,
    broken: bool,
}

fn key_of(p: &[Val]) -> Key {
    (
        p[0].as_uuid().unwrap(),
        p[1].as_text().unwrap().to_string(),
        p[2].as_uuid().unwrap(),
        p[3].as_text().unwrap().to_string(),
    )
}

fn receipt_row(r: &FakeReceipt) -> Rows {
    Rows::one(vec![
        Val::text(r.state.clone()),
        r.fingerprint.clone().map(Val::Text).unwrap_or(Val::Null),
        r.result.clone().map(Val::Json).unwrap_or(Val::Null),
        Val::Uuid(r.receipt_id),
    ])
}

impl FakeSession {
    fn discard(&mut self) {
        self.pending.clear();
        self.pending_rows.clear();
    }

    fn exists(&self, k: &Key) -> bool {
        self.pending.contains_key(k) || self.db.st.lock().unwrap().receipts.contains_key(k)
    }
}

impl Session for FakeSession {
    async fn begin(&mut self, _iso: Isolation) -> Result<(), DbError> {
        if self.broken {
            return Err(DbError::lost());
        }
        self.discard();
        if let Some(FaultKind::Error(e)) = self.db.take_fault("begin") {
            return Err(e);
        }
        Ok(())
    }

    async fn exec(&mut self, label: &str, _sql: &str, params: &[Val]) -> Result<Rows, DbError> {
        if self.broken {
            return Err(DbError::lost());
        }
        self.db.st.lock().unwrap().log.push(LogEntry { session: self.id, label: label.into(), params: params.to_vec() });
        if let Some(kind) = self.db.take_fault(label) {
            let e = match kind {
                FaultKind::Error(e) => e,
                _ => DbError::lost(),
            };
            if matches!(e, DbError::ConnectionLost { .. }) {
                self.broken = true;
                self.discard();
            }
            return Err(e);
        }
        let responder = self.db.st.lock().unwrap().responders.get(label).cloned();
        if let Some(f) = responder {
            return f(params);
        }
        match label {
            "exec.now" => {
                let mut st = self.db.st.lock().unwrap();
                st.clock += 1_000_000;
                Ok(Rows::one(vec![Val::Ts(st.clock)]))
            }
            l if l == CLAIM_LABEL => {
                let k = key_of(params);
                if self.exists(&k) {
                    return Ok(Rows::empty());
                }
                let rid = params[4].as_uuid().unwrap();
                self.pending.insert(
                    k,
                    FakeReceipt { state: "claimed".into(), fingerprint: params[7].as_text().map(str::to_string), result: None, receipt_id: rid },
                );
                Ok(Rows::one(vec![Val::Uuid(rid)]))
            }
            l if l == READ_LABEL => {
                let k = key_of(params);
                if let Some(r) = self.pending.get(&k) {
                    return Ok(receipt_row(r));
                }
                let st = self.db.st.lock().unwrap();
                Ok(st.receipts.get(&k).map(receipt_row).unwrap_or_default())
            }
            l if l == FINALIZE_LABEL => {
                let k = key_of(params);
                match self.pending.get_mut(&k) {
                    Some(r) if r.state == "claimed" => {
                        r.state = "applied".into();
                        r.result = params[4].as_json().cloned();
                        Ok(Rows::one(vec![Val::Uuid(r.receipt_id)]))
                    }
                    _ => Ok(Rows::empty()),
                }
            }
            l if l == LATE_INSERT_LABEL => {
                let k = key_of(params);
                if self.exists(&k) {
                    return Err(DbError::unique("operation_receipts_original_key"));
                }
                let rid = params[4].as_uuid().unwrap();
                self.pending.insert(
                    k,
                    FakeReceipt { state: "applied".into(), fingerprint: params[7].as_text().map(str::to_string), result: params[14].as_json().cloned(), receipt_id: rid },
                );
                Ok(Rows::one(vec![Val::Uuid(rid)]))
            }
            l if l == FENCE_LABEL => {
                let k = key_of(params);
                if self.exists(&k) {
                    return Ok(Rows::empty());
                }
                let rid = params[4].as_uuid().unwrap();
                self.pending.insert(k, FakeReceipt { state: "fenced".into(), fingerprint: None, result: None, receipt_id: rid });
                Ok(Rows::one(vec![Val::Uuid(rid)]))
            }
            l if l.starts_with("fake.insert:") => {
                self.pending_rows.push((l["fake.insert:".len()..].to_string(), params.to_vec()));
                Ok(Rows::one(vec![Val::Int(1)]))
            }
            _ => Ok(Rows::empty()),
        }
    }

    async fn commit(&mut self) -> Result<(), DbError> {
        if self.broken {
            return Err(DbError::lost());
        }
        let fault = self.db.take_fault("commit");
        // The deferred trigger operation_receipts_claimed_at_commit.
        if self.pending.values().any(|r| r.state == "claimed") {
            self.discard();
            return Err(DbError::Sql { code: "OT001".into(), constraint: None, message: "operation receipt is still claimed at commit".into() });
        }
        match fault {
            Some(FaultKind::Error(e)) => {
                self.discard();
                if matches!(e, DbError::ConnectionLost { .. }) {
                    self.broken = true;
                }
                Err(e)
            }
            Some(FaultKind::CommitLostBeforeApply) => {
                self.discard();
                self.broken = true;
                Err(DbError::lost())
            }
            Some(FaultKind::CommitLostAfterApply) => {
                self.apply();
                self.broken = true;
                Err(DbError::lost())
            }
            None => {
                self.apply();
                Ok(())
            }
        }
    }

    async fn rollback(&mut self) -> Result<(), DbError> {
        self.discard();
        Ok(())
    }

    fn drop_connection(&mut self) {
        self.broken = true;
        self.discard();
    }

    fn backend_pid(&self) -> Option<i32> {
        Some(10_000 + self.id as i32)
    }

    fn backend_start(&self) -> Option<i64> {
        Some(1_700_000_000_000_000 + self.id as i64)
    }

    fn is_broken(&self) -> bool {
        self.broken
    }
}

impl FakeSession {
    fn apply(&mut self) {
        let mut st = self.db.st.lock().unwrap();
        for (k, r) in std::mem::take(&mut self.pending) {
            st.receipts.insert(k, r);
        }
        for (t, row) in std::mem::take(&mut self.pending_rows) {
            st.tables.entry(t).or_default().push(row);
        }
        st.commits += 1;
    }
}
