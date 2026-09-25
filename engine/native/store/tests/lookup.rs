//! Receipt lookup over the fake session: answer order, what is fenced and
//! what is not. The concurrent cases (a lookup WAITING on an uncommitted
//! original, Q-RL1 (a)/(c), Q-RL2) need PostgreSQL and run on a WS1 cluster.

mod common;

use common::*;
use orgtree_store::fake::{FakeDb, FakeReceipt, FaultKind};
use orgtree_store::lookup::{LookupAnswer, LookupReq};
use orgtree_store::{DbError, Outcome, Rows, Uuid, Val};

const INC: u128 = 0x1c;
/// A legacy-grammar key minted at the fake clock's start (1.7e12 ms).
const KEY: &str = "1700000000000-0123456789abcdef01234567";

fn setup() -> std::sync::Arc<FakeDb> {
    let db = FakeDb::new();
    db.respond("lookup.anchor", |_| Ok(Rows::one(vec![Val::text("live"), Val::Int(3)])));
    db.respond("lookup.incarnation", |_| Ok(Rows::one(vec![Val::Uuid(Uuid::from_u128(INC))])));
    db
}

fn req(fp: &str) -> LookupReq {
    LookupReq {
        op: binding(KEY, fp).op,
        caller: agent(),
        caller_generation: 3,
        key_incarnation: Uuid::from_u128(INC),
        coverage: "document".into(),
        receipted: true,
        provable_absence: true,
    }
}

fn fences(db: &FakeDb) -> usize {
    db.receipts().iter().filter(|(_, r)| r.state == "fenced").count()
}

#[tokio::test]
async fn nothing_recorded_fences_and_answers_not_applied_then_the_original_is_refused() {
    let db = setup();
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::NotApplied);
    assert_eq!(fences(&db), 1);
    // Q-RL1 (b), sequential form: the delayed original arrives after the fence
    let cmd = InsertOne::new();
    assert_eq!(ex.run(&cmd, &binding(KEY, "fp1")).await.unwrap(), Outcome::Fenced);
    assert!(db.rows("rows").is_empty(), "the original did nothing");
    // a repeated lookup answers from its fence and writes no second row
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::NotApplied);
    assert_eq!(fences(&db), 1);
}

#[tokio::test]
async fn an_applied_original_is_reported_applied() {
    let db = setup();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding(KEY, "fp1")).await.unwrap();
    let a = ex.lookup(&req("fp1")).await.unwrap();
    assert_eq!(a, LookupAnswer::Applied { result: Some(serde_json::json!({"n": 7, "ts": null})), compensated: false });
    assert_eq!(fences(&db), 0);
}

#[tokio::test]
async fn a_different_call_under_the_key_is_a_conflict() {
    let db = setup();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding(KEY, "fp1")).await.unwrap();
    assert_eq!(ex.lookup(&req("other")).await.unwrap(), LookupAnswer::Conflict);
}

#[tokio::test]
async fn work_outside_the_transaction_makes_absence_unknown() {
    let db = setup();
    let (ex, _) = exec(&db);
    let mut r = req("fp1");
    r.provable_absence = false;
    assert_eq!(ex.lookup(&r).await.unwrap(), LookupAnswer::Unknown { reason: "pre_transaction_step", fenced: true });
    assert_eq!(fences(&db), 1, "still fenced");
}

#[tokio::test]
async fn a_live_in_flight_row_answers_running_and_fences_nothing() {
    let db = setup();
    db.respond("inflight.live", |_| Ok(Rows::one(vec![Val::Uuid(Uuid::from_u128(0x5e))])));
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::Running);
    assert_eq!(fences(&db), 0);
    // and the admitted call then applies on its own merits
    assert!(matches!(ex.run(&InsertOne::new(), &binding(KEY, "fp1")).await.unwrap(), Outcome::Applied(_)));
}

#[tokio::test]
async fn a_rotated_incarnation_fences_nothing_but_still_reports_an_applied_row() {
    let db = setup();
    let (ex, _) = exec(&db);
    let mut r = req("fp1");
    r.key_incarnation = Uuid::from_u128(0xdead);
    assert_eq!(ex.lookup(&r).await.unwrap(), LookupAnswer::Unknown { reason: "epoch_rotated", fenced: false });
    assert_eq!(fences(&db), 0);
    ex.run(&InsertOne::new(), &binding(KEY, "fp1")).await.unwrap();
    assert!(matches!(ex.lookup(&r).await.unwrap(), LookupAnswer::Applied { .. }));
}

#[tokio::test]
async fn a_fence_under_a_rotated_incarnation_says_it_is_fenced() {
    let db = setup();
    let (ex, _) = exec(&db);
    ex.lookup(&req("fp1")).await.unwrap();
    let mut r = req("fp1");
    r.key_incarnation = Uuid::from_u128(0xdead);
    assert_eq!(ex.lookup(&r).await.unwrap(), LookupAnswer::Unknown { reason: "epoch_rotated", fenced: true });
}

#[tokio::test]
async fn an_unreceipted_verb_is_unknown_and_unfenced() {
    let db = setup();
    let (ex, _) = exec(&db);
    let mut r = req("fp1");
    r.receipted = false;
    assert_eq!(ex.lookup(&r).await.unwrap(), LookupAnswer::Unknown { reason: "unsupported_operation", fenced: false });
    assert_eq!(fences(&db), 0);
}

#[tokio::test]
async fn key_admission_refusals_fence_nothing() {
    for (key, reason) in [
        ("not-a-key", "malformed_key"),
        ("1699999000000-0123456789abcdef01234567", "key_stale"),
        ("1700000100000-0123456789abcdef01234567", "key_from_the_future"),
    ] {
        let db = setup();
        let (ex, _) = exec(&db);
        let mut r = req("fp1");
        r.op.key = key.into();
        assert_eq!(ex.lookup(&r).await.unwrap(), LookupAnswer::Unknown { reason, fenced: false }, "{key}");
        assert_eq!(fences(&db), 0, "{key}");
    }
}

#[tokio::test]
async fn a_dead_or_stale_caller_is_refused() {
    let db = FakeDb::new();
    db.respond("lookup.anchor", |_| Ok(Rows::one(vec![Val::text("archived"), Val::Int(3)])));
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::CallerRefused);
    let db = FakeDb::new();
    db.respond("lookup.anchor", |_| Ok(Rows::one(vec![Val::text("live"), Val::Int(4)])));
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::CallerRefused);
}

#[tokio::test]
async fn a_fence_that_times_out_waiting_answers_running() {
    let db = setup();
    db.fault("receipt.fence", 1, FaultKind::Error(DbError::sql("55P03")));
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::Running);
    assert_eq!(fences(&db), 0);
}

#[tokio::test]
async fn a_compensated_receipt_reports_applied_and_compensated() {
    let db = setup();
    let b = binding(KEY, "fp1");
    db.seed_receipt(
        (b.op.org, "agent".into(), agent(), KEY.into()),
        FakeReceipt { state: "compensated".into(), fingerprint: Some("fp1".into()), result: Some(serde_json::json!(1)), receipt_id: Uuid::new_v4() },
    );
    let (ex, _) = exec(&db);
    assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::Applied { result: Some(serde_json::json!(1)), compensated: true });
}

#[tokio::test]
async fn run_keyed_brackets_the_call_with_its_in_flight_row() {
    let db = setup();
    let (ex, _) = exec(&db);
    let svc = Uuid::from_u128(0x5e);
    ex.run_keyed(&InsertOne::new(), &binding(KEY, "fp1"), svc).await.unwrap();
    let labels = db.labels();
    let pos = |l: &str| labels.iter().position(|x| x == l).unwrap_or_else(|| panic!("{l} missing: {labels:?}"));
    assert!(pos("inflight.insert") < pos("receipt.claim"));
    assert!(pos("receipt.finalize") < pos("inflight.delete"));
    // separate transactions: the in-flight insert committed before the command began
    let ins = db.log().into_iter().find(|e| e.label == "inflight.insert").unwrap();
    let claim = db.log().into_iter().find(|e| e.label == "receipt.claim").unwrap();
    assert_eq!(ins.params[4], Val::Uuid(svc));
    let _ = claim;
    assert!(db.commits() >= 3, "in-flight insert, command and in-flight delete each committed");
}

#[tokio::test]
async fn run_keyed_releases_the_row_when_the_call_fails() {
    let db = setup();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::sql("22P02")));
    let (ex, _) = exec(&db);
    assert!(ex.run_keyed(&InsertOne::new(), &binding(KEY, "fp1"), Uuid::from_u128(0x5e)).await.is_err());
    assert_eq!(db.count("inflight.delete"), 1);
}

#[tokio::test]
async fn an_unkeyed_call_writes_no_in_flight_row() {
    let db = setup();
    let (ex, _) = exec(&db);
    let mut b = binding(KEY, "fp1");
    b.op.caller_keyed = false;
    ex.run_keyed(&InsertOne::new(), &b, Uuid::from_u128(0x5e)).await.unwrap();
    assert_eq!(db.count("inflight.insert"), 0);
}

#[cfg(feature = "qualification")]
mod controls {
    use super::*;
    use orgtree_store::hooks::{ControlPlan, Hooks};
    use orgtree_store::OpIdentity;
    use std::sync::Arc;

    struct Arm(&'static str);
    impl ControlPlan for Arm {
        fn armed(&self, id: &str, _: &OpIdentity, _: Option<&str>) -> bool {
            id == self.0
        }
    }

    /// Q-RL3 control: the lookup skips its in-flight check, fences the
    /// admitted call, which is then refused at its claim (revision 1's
    /// behaviour, which E-D13 rejected).
    #[tokio::test]
    async fn control_skip_inflight_check_fences_an_admitted_call() {
        let db = setup();
        db.respond("inflight.live", |_| Ok(Rows::one(vec![Val::Uuid(Uuid::from_u128(0x5e))])));
        let c = Arc::new(Collect::default());
        let mut h = Hooks::with_trace(c.clone());
        h.controls = Some(Arc::new(Arm("Q-RL3.skip_inflight_check")));
        let ex = exec_with(&db, h);
        assert_eq!(ex.lookup(&req("fp1")).await.unwrap(), LookupAnswer::NotApplied);
        assert!(c.has("control_executed:Q-RL3.skip_inflight_check"));
        assert_eq!(ex.run(&InsertOne::new(), &binding(KEY, "fp1")).await.unwrap(), Outcome::Fenced, "the admitted call was refused");
    }
}
