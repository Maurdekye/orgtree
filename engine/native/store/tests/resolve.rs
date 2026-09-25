//! In-transaction name resolution (`resolve.rs`) over the fake session. The
//! fake does not model locks, so these prove WHICH statement runs (the
//! key-share variant in a write, the plain one in a read) and what each
//! answer means, not PostgreSQL's locking; that is a DB-backed case.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use orgtree_store::fake::FakeDb;
use orgtree_store::read::Read;
use orgtree_store::resolve::{self, Resolved, WorkTarget};
use orgtree_store::{Binding, CmdError, Command, Decided, Family, Isolation, Rows, Session, Tx, Uuid, Val};

fn principal() -> Uuid {
    Uuid::from_u128(0xb0b)
}
fn other_org() -> Uuid {
    Uuid::from_u128(0x0e9)
}
fn item() -> Uuid {
    Uuid::from_u128(0x17e)
}

/// Rows the fake answers: agent "bob", org "acme" (and kiosk orgs are
/// filtered by the SQL, so the fake simply has none), active work name
/// "w-new", legacy work name "w-old".
fn seeded() -> Arc<FakeDb> {
    let db = FakeDb::new();
    let agent = |p: &[Val]| Ok(if p.get(1) == Some(&Val::text("bob")) { Rows::one(vec![Val::Uuid(principal())]) } else { Rows::default() });
    db.respond(resolve::AGENT_LABEL, agent);
    db.respond(resolve::AGENT_LOCKED_LABEL, agent);
    db.respond(resolve::ORG_LABEL, |p| Ok(if p.first() == Some(&Val::text("acme")) { Rows::one(vec![Val::Uuid(other_org())]) } else { Rows::default() }));
    let work = |p: &[Val]| Ok(if p.get(1) == Some(&Val::text("w-new")) { Rows::one(vec![Val::Uuid(item())]) } else { Rows::default() });
    db.respond(resolve::WORK_LABEL, work);
    db.respond(resolve::WORK_LOCKED_LABEL, work);
    db.respond(resolve::LEGACY_WORK_LABEL, |p| {
        Ok(if p.get(1) == Some(&Val::text("w-old")) { Rows::one(vec![Val::Null, Val::Bool(false)]) } else { Rows::default() })
    });
    db
}

/// What a probe resolves (an enum rather than a closure, so it stays generic
/// over the session).
#[derive(Clone)]
enum Op {
    Agent(&'static str),
    Address(String),
    Work(&'static str),
}

async fn apply<S: Session>(tx: &mut Tx<'_, S>, op: &Op) -> Result<String, CmdError> {
    Ok(match op {
        Op::Agent(n) => format!("{:?}", resolve::agent(tx, org(), n).await?),
        Op::Address(to) => format!("{:?}", resolve::address(tx, org(), to).await?),
        Op::Work(n) => format!("{:?}", resolve::work_item(tx, org(), n).await?),
    })
}

/// Runs one probe inside a WRITE (at the family's isolation) and records its answer.
struct InWrite {
    fam: &'static Family,
    op: Op,
    out: Arc<Mutex<Vec<String>>>,
}

static RC: Family = Family { name: "resolve_rc", isolation: Isolation::ReadCommitted, retry_unique: &[] };
static SER: Family = Family { name: "resolve_ser", isolation: Isolation::Serializable, retry_unique: &[] };

impl Command for InWrite {
    type Output = common::Out;
    fn family(&self) -> &'static Family {
        self.fam
    }
    fn verb(&self) -> &'static str {
        "probe"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _s: &common::Out) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<common::Out>, CmdError> {
        let answer = apply(tx, &self.op).await?;
        self.out.lock().unwrap().push(answer);
        Ok(Decided::Applied(common::Out { n: 1, ts: None }))
    }
}

struct InRead {
    op: Op,
}

impl Read for InRead {
    type Output = String;
    fn family(&self) -> &'static str {
        "resolve_read"
    }
    fn verb(&self) -> &'static str {
        "probe"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<String, CmdError> {
        apply(tx, &self.op).await
    }
}

async fn in_write(db: &Arc<FakeDb>, fam: &'static Family, op: Op) -> String {
    let (ex, _) = exec(db);
    let out = Arc::new(Mutex::new(vec![]));
    let key = format!("k-{}", Uuid::new_v4().simple());
    ex.run(&InWrite { fam, op, out: out.clone() }, &binding(&key, "fp")).await.unwrap();
    let got = out.lock().unwrap().pop().expect("the probe ran");
    got
}

async fn in_read(db: &Arc<FakeDb>, op: Op) -> String {
    let (ex, _) = exec(db);
    ex.read(&InRead { op }, org(), None).await.unwrap()
}

fn resolution_labels(db: &FakeDb) -> Vec<String> {
    db.labels().into_iter().filter(|l| l.starts_with("resolve.")).collect()
}

#[tokio::test]
async fn a_write_resolves_an_agent_under_a_key_share_lock_and_a_read_without_one() {
    for fam in [&RC, &SER] {
        let db = seeded();
        let got = in_write(&db, fam, Op::Agent("bob")).await;
        assert_eq!(got, format!("{:?}", Some(principal())), "{}", fam.name);
        assert_eq!(resolution_labels(&db), vec![resolve::AGENT_LOCKED_LABEL], "{}", fam.name);
        let params = db.log().into_iter().find(|e| e.label == resolve::AGENT_LOCKED_LABEL).unwrap().params;
        assert_eq!(params, vec![Val::Uuid(org()), Val::text("bob")], "scoped to the command's org");
    }
    let db = seeded();
    let got = in_read(&db, Op::Agent("bob")).await;
    assert_eq!(got, format!("{:?}", Some(principal())));
    assert_eq!(resolution_labels(&db), vec![resolve::AGENT_LABEL], "a read-only snapshot must not take row locks");
}

#[tokio::test]
async fn addresses() {
    let cases: Vec<(&str, Resolved, Vec<&str>)> = vec![
        ("@user", Resolved::User, vec![]),
        ("bob", Resolved::Agent { principal: principal() }, vec![resolve::AGENT_LOCKED_LABEL]),
        ("acme", Resolved::NotANode { local_org: Some(other_org()) }, vec![resolve::AGENT_LOCKED_LABEL, resolve::ORG_LABEL]),
        ("nobody", Resolved::NotANode { local_org: None }, vec![resolve::AGENT_LOCKED_LABEL, resolve::ORG_LABEL]),
        ("@org:acme", Resolved::LocalOrg { org: other_org() }, vec![resolve::ORG_LABEL]),
        ("@org:gone", Resolved::NotANode { local_org: None }, vec![resolve::ORG_LABEL]),
        ("@net:hub.peer", Resolved::External { handle: "@net:hub.peer".into() }, vec![]),
        ("@mcp:chat", Resolved::Refused { reason: "retired_transport" }, vec![]),
        ("@org:", Resolved::Refused { reason: "malformed_address" }, vec![]),
        ("@net:", Resolved::Refused { reason: "malformed_address" }, vec![]),
        ("@bob", Resolved::Refused { reason: "malformed_address" }, vec![]),
        ("", Resolved::Refused { reason: "malformed_address" }, vec![]),
    ];
    let long = "x".repeat(resolve::MAX_NAME + 1);
    let mut cases = cases;
    cases.push((long.as_str(), Resolved::Refused { reason: "malformed_address" }, vec![]));
    for (to, want, labels) in cases {
        let db = seeded();
        let got = in_write(&db, &RC, Op::Address(to.to_string())).await;
        assert_eq!(got, format!("{want:?}"), "{to:?}");
        assert_eq!(resolution_labels(&db), labels, "{to:?}");
    }
}

#[tokio::test]
async fn work_names_active_first_then_the_legacy_corpus() {
    let db = seeded();
    let got = in_write(&db, &RC, Op::Work("w-new")).await;
    assert_eq!(got, format!("{:?}", Some(WorkTarget::Active { item: item() })));
    assert_eq!(resolution_labels(&db), vec![resolve::WORK_LOCKED_LABEL], "an active hit never reads the corpus");

    let db = seeded();
    let got = in_read(&db, Op::Work("w-old")).await;
    assert_eq!(got, format!("{:?}", Some(WorkTarget::Legacy { item: None, live: false })));
    assert_eq!(resolution_labels(&db), vec![resolve::WORK_LABEL, resolve::LEGACY_WORK_LABEL]);

    let db = seeded();
    let got = in_read(&db, Op::Work("none")).await;
    assert_eq!(got, "None");
}

/// The resolver is reachable only through a `Tx`, and only this crate can
/// build one: its constructors stay crate-private.
#[test]
fn only_the_executor_can_build_a_tx() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/exec.rs")).unwrap();
    let body = &src[src.find("impl<'a, S: Session> Tx<'a, S> {").expect("the Tx impl")..];
    assert!(body.contains("pub(crate) fn new_internal("), "the constructor moved; re-check this test");
    for public in ["pub fn new_internal(", "pub fn new(", "pub async fn begin(", "pub(crate) fn new("] {
        assert!(!body.contains(public), "Tx gained `{public}`: a caller could run resolution outside the executor");
    }
}
