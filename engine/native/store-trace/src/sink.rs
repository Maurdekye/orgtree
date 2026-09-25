//! The collector: WS2's `orgtree_store::hooks::TraceSink` (CONTRACT-M1 §5),
//! mapped onto `orgtree.p03-trace/v1` records (`tools/p03/harness/trace.py`).
//!
//! | WS2 event        | record       | notes |
//! |------------------|--------------|-------|
//! | `ConnOpened`     | `conn_opened`| factory purpose, pid, backend_start, role, database (never a URL) |
//! | `Admitted`       | `op_begin`   | once per operation |
//! | `Begin`          | `tx_begin`   | remembers the attempt's backend pid |
//! | `Statement`      | `stmt`       | relations and modes DERIVED from the SQL text (`sqlmap`); a redacted fingerprint, never values |
//! | `Retry`          | `retry`      | |
//! | `Commit`/`Rollback`/`CommitUnknown` | `tx_end` | commit / rollback / unknown; `pre_commit_lsn` is a lower bound only |
//! | `Effects`        | `effect`     | shape `external_effect` |
//! | `Outcome`        | `op_end`     | `contacts` = the operation's non-infrastructure statements |
//! | `ControlExecuted`| `control_executed` | |
//! | `Pause`          | `pause`      | |
//! | `Lookup`         | `lookup`     | |
//! | `XactLocks`      | `xact_locks` | the backend's own relation locks (row-lock family check) |
//! | `XactStats`      | `xact_stats` | the server's per-transaction relation activity (qualification builds) |
//!
//! Statements labelled `trace.*` or `exec.*` are the executor's own
//! infrastructure (they read system views): they are recorded with
//! `infrastructure: true` and no relations, so Q-C5 does not compare them. A
//! `stub` event keeps `stub: true`; no schedule may pass on it (M1 §2 row 6).

use crate::json::Value;
use crate::sqlmap;
use crate::stream::{Pushed, Record, Stream};
use orgtree_store::hooks::{EventKind, TraceEvent, TraceSink};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

pub struct Collector {
    stream: Stream,
    run_id: String,
    known: BTreeSet<String>,
    pids: Mutex<HashMap<(String, u32), i32>>,
    contacts: Mutex<HashMap<String, i64>>,
}

fn s(v: &str) -> Value {
    Value::str(v)
}

fn opt_int(v: Option<i64>) -> Value {
    v.map(Value::Int).unwrap_or_else(Value::unknown)
}

/// FNV-1a 64 over the whitespace-normalized SQL: a stable, value-free fingerprint.
/// Leading and trailing whitespace are dropped: the server log's extended-protocol
/// lines keep a trailing space the executor's text may not have (measured on a WS1
/// dev cluster, tools/p03/probes/serverlog_probe.py).
pub fn fingerprint(sql: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut prev_space = true;
    for c in sql.trim_end().chars() {
        let c = if c.is_whitespace() { ' ' } else { c.to_ascii_lowercase() };
        if c == ' ' && prev_space {
            continue;
        }
        prev_space = c == ' ';
        let mut buf = [0u8; 4];
        for b in c.encode_utf8(&mut buf).bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("fnv1a64:{h:016x}")
}

pub fn is_infrastructure(label: &str) -> bool {
    label.starts_with("trace.") || label.starts_with("exec.")
}

impl Collector {
    /// `known`: the store schema's relations (the deriver resolves only these).
    pub fn new(stream_name: &str, capacity: usize, run_id: &str, known: BTreeSet<String>) -> Collector {
        Collector {
            stream: Stream::new(stream_name, capacity),
            run_id: run_id.to_string(),
            known,
            pids: Mutex::new(HashMap::new()),
            contacts: Mutex::new(HashMap::new()),
        }
    }

    pub fn stream(&self) -> &Stream {
        &self.stream
    }

    pub fn drain(&self) -> Vec<Record> {
        self.stream.drain()
    }

    pub fn end(&self, flushed: bool) -> Vec<Record> {
        self.stream.end(flushed)
    }

    fn op_id(e: &TraceEvent<'_>) -> String {
        e.op.map(|o| format!("{}:{}", o.ns.kind(), o.key)).unwrap_or_else(|| "none".to_string())
    }

    fn pid(&self, op: &str, attempt: u32) -> Value {
        let g = self.pids.lock().unwrap_or_else(|p| p.into_inner());
        g.get(&(op.to_string(), attempt)).map(|p| Value::Int(*p as i64)).unwrap_or_else(Value::unknown)
    }

    fn push(&self, e: &TraceEvent<'_>, kind: &str, mut fields: Vec<(String, Value)>) -> Pushed {
        let op = Self::op_id(e);
        let mut common = vec![
            ("operation_id".to_string(), s(&op)),
            ("attempt".to_string(), Value::Int(e.attempt as i64)),
            ("op_kind".to_string(), s(&format!("{}.{}", e.family, e.verb))),
            ("op_tag".to_string(), e.op_tag.map(s).unwrap_or(Value::Null)),
        ];
        if e.stub {
            common.push(("stub".to_string(), Value::Bool(true)));
        }
        common.append(&mut fields);
        self.stream.push(kind, common)
    }
}

impl TraceSink for Collector {
    fn event(&self, e: &TraceEvent<'_>) {
        let op = Self::op_id(e);
        match &e.kind {
            EventKind::ConnOpened { purpose, backend_pid, backend_start, host: _, port: _, role, database } => {
                // host and port are loopback plumbing; the URL and password never arrive here
                self.push(e, "conn_opened", vec![
                    ("factory".into(), s(purpose)),
                    ("backend_pid".into(), opt_int(backend_pid.map(|p| p as i64))),
                    ("backend_start".into(), opt_int(*backend_start)),
                    ("role".into(), s(role)),
                    ("database".into(), s(database)),
                ]);
            }
            EventKind::Admitted => {
                self.push(e, "op_begin", vec![("run_id".into(), s(&self.run_id))]);
            }
            EventKind::Begin { isolation, backend_pid } => {
                if let Some(p) = backend_pid {
                    self.pids.lock().unwrap_or_else(|p| p.into_inner()).insert((op.clone(), e.attempt), *p);
                }
                self.push(e, "tx_begin", vec![
                    ("backend_pid".into(), opt_int(backend_pid.map(|p| p as i64))),
                    ("isolation".into(), s(isolation)),
                ]);
            }
            EventKind::Statement { label, sql, micros, rows, sqlstate, backend_pid } => {
                let infra = is_infrastructure(label);
                // the event's own pid first (every statement carries it since WS2 c67c89d),
                // the attempt's Begin pid as the fallback
                let pid = backend_pid.map(|p| Value::Int(p as i64)).unwrap_or_else(|| self.pid(&op, e.attempt));
                let mut fields = vec![
                    ("backend_pid".into(), pid),
                    ("stmt_label".into(), s(label)),
                    ("fingerprint".into(), s(&fingerprint(sql))),
                    ("sqlstate".into(), s(sqlstate.unwrap_or("00000"))),
                    ("rows_returned".into(), Value::Int(*rows as i64)),
                    ("micros".into(), Value::Int(*micros as i64)),
                ];
                if infra {
                    fields.push(("infrastructure".into(), Value::Bool(true)));
                    fields.push(("mode".into(), s("read")));
                    fields.push(("relations".into(), Value::List(vec![])));
                } else {
                    *self.contacts.lock().unwrap_or_else(|p| p.into_inner()).entry(op.clone()).or_insert(0) += 1;
                    let c = sqlmap::derive(sql, &self.known);
                    let writes = c.relations.values().any(|m| m.contains("write"));
                    fields.push(("mode".into(), s(if writes { "write" } else { "read" })));
                    fields.push(("relations".into(),
                                 Value::List(c.relations.keys().map(|r| s(r)).collect())));
                    fields.push(("relation_modes".into(), Value::Obj(
                        c.relations.iter()
                            .map(|(r, m)| (r.clone(), Value::List(m.iter().map(|x| s(x)).collect())))
                            .collect())));
                    fields.push(("unresolved".into(),
                                 Value::List(c.unresolved.iter().map(|r| s(r)).collect())));
                }
                self.push(e, "stmt", fields);
            }
            EventKind::Retry { reason, sqlstate, constraint } => {
                self.push(e, "retry", vec![
                    ("retry_cause".into(), s(reason)),
                    ("sqlstate".into(), sqlstate.map(s).unwrap_or_else(Value::unknown)),
                    ("constraint".into(), constraint.map(s).unwrap_or(Value::Null)),
                ]);
            }
            EventKind::Commit { pre_commit_lsn } => {
                self.push(e, "tx_end", vec![
                    ("backend_pid".into(), self.pid(&op, e.attempt)),
                    ("outcome".into(), s("commit")),
                    ("sqlstate".into(), s("00000")),
                    ("pre_commit_lsn".into(), pre_commit_lsn.map(s).unwrap_or_else(Value::unknown)),
                ]);
            }
            EventKind::Rollback | EventKind::CommitUnknown => {
                let outcome = if matches!(e.kind, EventKind::Rollback) { "rollback" } else { "unknown" };
                self.push(e, "tx_end", vec![
                    ("backend_pid".into(), self.pid(&op, e.attempt)),
                    ("outcome".into(), s(outcome)),
                    ("sqlstate".into(), Value::unknown()),
                ]);
            }
            EventKind::Effects { count } => {
                self.push(e, "effect", vec![
                    ("shape".into(), s("external_effect")),
                    ("count".into(), Value::Int(*count as i64)),
                ]);
            }
            EventKind::Outcome { outcome } => {
                let n = *self.contacts.lock().unwrap_or_else(|p| p.into_inner()).get(&op).unwrap_or(&0);
                self.push(e, "op_end", vec![
                    ("outcome".into(), s(outcome)),
                    ("contacts".into(), Value::Int(n)),
                ]);
            }
            EventKind::ControlExecuted { id } => {
                self.push(e, "control_executed", vec![("control_id".into(), s(id))]);
            }
            EventKind::Pause { point } => {
                self.push(e, "pause", vec![("point".into(), s(point))]);
            }
            EventKind::Lookup { answer } => {
                self.push(e, "lookup", vec![("answer".into(), s(answer))]);
            }
            EventKind::Mark { name } => {
                // ordering evidence that is not a hookable point (WS5's provider-input step)
                self.push(e, "mark", vec![("name".into(), s(name))]);
            }
            EventKind::CausalRefs { refs } => {
                // opaque ids linking one workflow's steps (PROFILING test 2); ids only by
                // WS2's contract, never content
                self.push(e, "causal_refs", vec![("refs".into(), Value::List(refs.iter().map(|r| s(r)).collect()))]);
            }
            EventKind::XactLocks { locks } => {
                // the backend's own relation locks before COMMIT: the server-side row-lock
                // FAMILY cross-check (lead ruling, decision 4)
                let rows = locks
                    .iter()
                    .map(|l| Value::Obj(vec![("relname".into(), s(&l.relname)), ("mode".into(), s(&l.mode))]))
                    .collect();
                self.push(e, "xact_locks", vec![
                    ("backend_pid".into(), self.pid(&op, e.attempt)),
                    ("locks".into(), Value::List(rows)),
                ]);
            }
            EventKind::XactStats { tables } => {
                // the SERVER's per-transaction relation activity (pg_stat_xact_user_tables),
                // the cross-check of the SQL-text derivation (oracle.py reads it)
                let rows = tables
                    .iter()
                    .map(|t| {
                        Value::Obj(vec![
                            ("relname".into(), s(&t.relname)),
                            ("seq_scan".into(), Value::Int(t.seq_scan)),
                            ("idx_scan".into(), Value::Int(t.idx_scan)),
                            ("n_tup_ins".into(), Value::Int(t.n_tup_ins)),
                            ("n_tup_upd".into(), Value::Int(t.n_tup_upd)),
                            ("n_tup_del".into(), Value::Int(t.n_tup_del)),
                        ])
                    })
                    .collect();
                self.push(e, "xact_stats", vec![
                    ("backend_pid".into(), self.pid(&op, e.attempt)),
                    ("tables".into(), Value::List(rows)),
                ]);
            }
        }
    }
}
