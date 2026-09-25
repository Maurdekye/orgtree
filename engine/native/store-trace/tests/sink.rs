//! The collector over WS2's REAL executor (its in-memory fake session, no
//! database): every event of one operation becomes an `orgtree.p03-trace/v1`
//! record, statements carry relations derived from their SQL text, the
//! executor's own infrastructure statements are marked and not compared, and the
//! stream closes clean.
#![cfg(feature = "sink")]

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use orgtree_store::fake::{FakeConnector, FakeDb};
use orgtree_store::hooks::Hooks;
use orgtree_store::{
    Binding, CmdError, Command, Decided, ExecConfig, Executor, Family, Isolation, KeyNamespace, OpIdentity, Principal,
    Session, Tx, Uuid, Val,
};
use orgtree_store_trace::json::Value;
use orgtree_store_trace::sink::{fingerprint, Collector};
use orgtree_store_trace::stream::Record;

static FAM: Family = Family { name: "item", isolation: Isolation::ReadCommitted, retry_unique: &[] };

struct Edit;

impl Command for Edit {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &FAM
    }
    fn verb(&self) -> &'static str {
        "edit"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        tx.exec("item.anchor", "SELECT 1 FROM agents WHERE id = $1 FOR SHARE", &[Val::Int(1)]).await?;
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
        tx.exec("fake.insert:items", "INSERT INTO items (id, secret) VALUES ($1, $2)", &[Val::Int(9), Val::Int(918_273_645_501)])
            .await?;
        Ok(Decided::Applied(9))
    }
}

fn binding() -> Binding {
    let agent = Uuid::from_u128(0xa1);
    Binding {
        principal: Principal::Agent { id: agent, generation: 1 },
        acting: None,
        op: OpIdentity {
            org: Uuid::from_u128(1),
            ns: KeyNamespace::Agent { principal: agent },
            key: "k-edit-1".into(),
            fingerprint: "fp".into(),
            fingerprint_codec: "legacy-1",
            caller_keyed: true,
        },
        db_incarnation: Uuid::from_u128(0xdb),
        op_tag: Some("A".into()),
    }
}

fn field<'a>(r: &'a Record, name: &str) -> Option<&'a Value> {
    r.fields.iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

fn run_one() -> (Vec<Record>, Arc<Collector>) {
    let known: BTreeSet<String> =
        ["agents", "items", "operation_receipts"].iter().map(|s| s.to_string()).collect();
    let c = Arc::new(Collector::new("exec-1", 1024, "run-1", known));
    let db = FakeDb::new();
    let cfg = ExecConfig { max_attempts: 3, backoff_base: Duration::ZERO, backoff_cap: Duration::ZERO };
    let ex = Executor::new(FakeConnector { db: db.clone() }, 1, FakeConnector { db }, 1, cfg,
                           Hooks::with_trace(c.clone()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async { ex.run(&Edit, &binding()).await.unwrap() });
    let mut records = c.drain();
    records.extend(c.end(true));
    (records, c)
}

#[test]
fn one_operation_becomes_a_complete_trace() {
    let (records, _) = run_one();
    let kinds: Vec<&str> = records.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds.first(), Some(&"op_begin"), "{kinds:?}");
    for k in ["tx_begin", "stmt", "xact_stats", "tx_end", "op_end"] {
        assert!(kinds.contains(&k), "{k} missing: {kinds:?}");
    }
    // the server-side relation rows arrive as a list, before the commit
    let xs = records.iter().position(|r| r.kind == "xact_stats").unwrap();
    let commit = records.iter().position(|r| r.kind == "tx_end").unwrap();
    assert!(xs < commit);
    assert!(matches!(field(&records[xs], "tables"), Some(Value::List(_))));
    assert_eq!(kinds.last(), Some(&"stream_end"));
    let seqs: Vec<u64> = records.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, (1..=records.len() as u64).collect::<Vec<_>>(), "contiguous sequence");
    let end = records.last().unwrap();
    assert_eq!(field(end, "clean"), Some(&Value::Bool(true)));
    // every record names the operation, its attempt and the harness tag
    for r in &records[..records.len() - 1] {
        assert_eq!(field(r, "operation_id"), Some(&Value::str("agent:k-edit-1")), "{}", r.kind);
        assert_eq!(field(r, "op_tag"), Some(&Value::str("A")), "{}", r.kind);
        assert_eq!(field(r, "op_kind"), Some(&Value::str("item.edit")), "{}", r.kind);
    }
}

#[test]
fn statements_carry_derived_relations_and_no_values() {
    let (records, _) = run_one();
    let stmt = |label: &str| {
        records
            .iter()
            .find(|r| r.kind == "stmt" && field(r, "stmt_label") == Some(&Value::str(label)))
            .unwrap_or_else(|| panic!("no stmt {label}"))
    };
    let anchor = stmt("item.anchor");
    assert_eq!(field(anchor, "relation_modes"),
               Some(&Value::Obj(vec![("agents".into(),
                                      Value::List(vec![Value::str("for_share"), Value::str("read")]))])));
    let insert = stmt("fake.insert:items");
    assert_eq!(field(insert, "mode"), Some(&Value::str("write")));
    assert_eq!(field(insert, "fingerprint"),
               Some(&Value::str(fingerprint("INSERT INTO items (id, secret) VALUES ($1, $2)"))));
    // parameter values never reach a record
    for r in &records {
        assert!(!r.to_json().contains("918273645501"), "a value leaked into {}", r.to_json());
    }
    // every non-infrastructure statement resolved
    for r in records.iter().filter(|r| r.kind == "stmt" && field(r, "infrastructure").is_none()) {
        assert_eq!(field(r, "unresolved"), Some(&Value::List(vec![])), "{}", r.to_json());
    }
    // the executor's own qualification statements are marked and name no relation
    for label in ["trace.xact_stats", "trace.pre_commit_lsn"] {
        let r = stmt(label);
        assert_eq!(field(r, "infrastructure"), Some(&Value::Bool(true)), "{label}");
        assert_eq!(field(r, "relations"), Some(&Value::List(vec![])), "{label}");
    }
    // statements carry the backend pid their transaction began on
    let begin = records.iter().find(|r| r.kind == "tx_begin").unwrap();
    assert_eq!(field(anchor, "backend_pid"), field(begin, "backend_pid"));
}

struct StubbedEdit;

impl Command for StubbedEdit {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &FAM
    }
    fn verb(&self) -> &'static str {
        "stubbed"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
        // as WS2's Sent stub does around its statements
        tx.set_stub(true);
        tx.exec("fake.insert:items", "INSERT INTO items (id) VALUES ($1)", &[Val::Int(1)]).await?;
        tx.set_stub(false);
        Ok(Decided::Applied(1))
    }
}

#[test]
fn stub_statements_keep_their_stub_flag() {
    let known: BTreeSet<String> = ["items", "operation_receipts"].iter().map(|s| s.to_string()).collect();
    let c = Arc::new(Collector::new("exec-2", 1024, "run-2", known));
    let cfg = ExecConfig { max_attempts: 3, backoff_base: Duration::ZERO, backoff_cap: Duration::ZERO };
    let db = FakeDb::new();
    let ex = Executor::new(FakeConnector { db: db.clone() }, 1, FakeConnector { db }, 1, cfg,
                           Hooks::with_trace(c.clone()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async { ex.run(&StubbedEdit, &binding()).await.unwrap() });
    let records = c.drain();
    let stubbed: Vec<&Record> = records.iter().filter(|r| field(r, "stub") == Some(&Value::Bool(true))).collect();
    assert_eq!(stubbed.len(), 1, "exactly the stub's statement");
    assert_eq!(field(stubbed[0], "stmt_label"), Some(&Value::str("fake.insert:items")));
}

#[test]
fn fingerprint_ignores_whitespace_and_case_only() {
    assert_eq!(fingerprint("SELECT  1\n\tFROM items"), fingerprint("select 1 from items"));
    assert_ne!(fingerprint("SELECT 1 FROM items"), fingerprint("SELECT 2 FROM items"));
}

/// `KINDS` from tools/p03/harness/trace.py: the single definition of each record
/// kind's required fields (parsed, not copied, so the two sides cannot drift).
fn python_kinds() -> std::collections::HashMap<String, Vec<String>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/p03/harness/trace.py");
    // the repository checks files out with CRLF (.gitattributes eol=crlf)
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .replace("\r\n", "\n");
    let start = text.find("KINDS: dict").expect("KINDS table");
    let body = &text[start..text[start..].find("\n}\n").map(|i| start + i).expect("end of KINDS")];
    let mut out = std::collections::HashMap::new();
    let mut entry = String::new();
    for line in body.lines().skip(1) {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        entry.push_str(line);
        if entry.ends_with("),") {
            let (name, fields) = entry.split_once(':').expect("name: (fields)");
            let fields: Vec<String> = fields
                .split('"')
                .enumerate()
                .filter(|(i, _)| i % 2 == 1)
                .map(|(_, f)| f.to_string())
                .collect();
            out.insert(name.trim().trim_matches('"').to_string(), fields);
            entry.clear();
        }
    }
    assert!(out.len() >= 15, "parsed only {} kinds from trace.py", out.len());
    out
}

#[test]
fn every_record_meets_the_python_schema() {
    let kinds = python_kinds();
    let (records, _) = run_one();
    for r in &records {
        let required = kinds.get(&r.kind).unwrap_or_else(|| panic!("kind {} unknown to trace.py", r.kind));
        for f in required {
            assert!(field(r, f).is_some(), "{} lacks {f}: {}", r.kind, r.to_json());
        }
    }
}

#[test]
fn contacts_count_only_the_operations_own_statements() {
    let (records, _) = run_one();
    let end = records.iter().find(|r| r.kind == "op_end").unwrap();
    let own = records
        .iter()
        .filter(|r| r.kind == "stmt" && field(r, "infrastructure").is_none())
        .count() as i64;
    assert!(own >= 2, "anchor + insert at least");
    assert_eq!(field(end, "contacts"), Some(&Value::Int(own)));
    assert_eq!(field(end, "outcome"), Some(&Value::str("applied")));
}
