//! Unsafe controls and pause hooks (feature `qualification`). Each control
//! must (a) record `control_executed` at its site and (b) produce the failure
//! its schedule names; a control that "passes" without (a) is a failed
//! control (r7 §8.1). Pure: fake session, no database.
#![cfg(feature = "qualification")]

mod common;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use common::*;
use orgtree_store::fake::{FakeDb, FaultKind};
use orgtree_store::hooks::{BoxFuture, ControlPlan, HookAction, Hooks, PauseHook, PausePoint};
use orgtree_store::{DbError, OpIdentity, Outcome};

struct Armed(HashSet<String>);

impl ControlPlan for Armed {
    fn armed(&self, id: &str, _op: &OpIdentity, _tag: Option<&str>) -> bool {
        self.0.contains(id)
    }
}

fn armed(ids: &[&str]) -> (Hooks, Arc<Collect>) {
    let c = Arc::new(Collect::default());
    let mut h = Hooks::with_trace(c.clone());
    h.controls = Some(Arc::new(Armed(ids.iter().map(|s| s.to_string()).collect())));
    (h, c)
}

#[tokio::test]
async fn unarmed_plan_fires_nothing() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::CommitLostAfterApply);
    let (h, c) = armed(&[]);
    let ex = exec_with(&db, h);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(!c.events.lock().unwrap().iter().any(|e| e.starts_with("control_executed")));
    assert_eq!(db.rows("rows").len(), 1);
}

/// Q-C4 control: a retry that regenerates the operation identity produces a
/// duplicate after an ambiguous commit.
#[tokio::test]
async fn control_remint_identity_duplicates_rows() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::CommitLostAfterApply);
    let (h, c) = armed(&["Q-C4.remint_identity"]);
    let ex = exec_with(&db, h);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(c.has("control_executed:Q-C4.remint_identity"), "control did not record that it ran");
    assert!(matches!(o, Outcome::Applied(_)));
    assert_eq!(db.rows("rows").len(), 2, "the unsafe control must produce the duplicate");
    let keys = claim_keys(&db);
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1]);
}

/// Q-C4 control: reusing the old attempt timestamp on retry.
#[tokio::test]
async fn control_stale_attempt_ts_keeps_the_first_attempts_clock() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::sql("40001")));
    let (h, c) = armed(&["Q-C4.stale_attempt_ts"]);
    let ex = exec_with(&db, h);
    let mut cmd = InsertOne::new();
    cmd.use_now = true;
    ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert!(c.has("control_executed:Q-C4.stale_attempt_ts"));
    let stored = db.rows("rows")[0][1].as_int().unwrap();
    assert_eq!(stored, 1_700_000_000_000_000 + 1_000_000, "the committed attempt used the FIRST attempt's clock");
}

/// WS2 mutation check: 23505 retried on a non-allowlisted constraint loops
/// instead of failing fast.
#[tokio::test]
async fn control_retry_any_23505_loops_to_the_attempt_limit() {
    let db = FakeDb::new();
    for n in 1..=5 {
        db.fault("fake.insert:rows", n, FaultKind::Error(DbError::unique("agents_seat")));
    }
    let (h, c) = armed(&["Q-C4.retry_any_23505"]);
    let ex = exec_with(&db, h);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(c.has("control_executed:Q-C4.retry_any_23505"));
    assert_eq!(o, Outcome::RetryExhausted { attempts: 5, last_sqlstate: Some("23505".into()) });
    assert_eq!(db.count("receipt.claim"), 5, "looped instead of failing fast");
}

/// Effects run from a failed attempt.
#[tokio::test]
async fn control_effects_before_commit_runs_effects_twice() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::Error(DbError::sql("40001")));
    let (h, c) = armed(&["Q-C4.effects_before_commit"]);
    let ex = exec_with(&db, h);
    let cmd = InsertOne::new();
    ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert!(c.has("control_executed:Q-C4.effects_before_commit"));
    assert_eq!(cmd.effects_run(), 2, "an effect ran from the failed attempt");
}

/// Q-RL1 control, executor half: no early claim, a plain insert at the end.
/// (The failure itself needs a concurrent lookup: DB-backed Q-RL1.)
#[tokio::test]
async fn control_late_receipt_skips_the_claim() {
    let db = FakeDb::new();
    let (h, c) = armed(&["Q-RL1.late_receipt_separate_fence"]);
    let ex = exec_with(&db, h);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(c.has("control_executed:Q-RL1.late_receipt_separate_fence"));
    assert_eq!(db.count("receipt.claim"), 0);
    assert_eq!(db.count("receipt.late_insert"), 1);
    let labels = db.labels();
    let pos = |l: &str| labels.iter().position(|x| x == l).unwrap();
    assert!(pos("fake.insert:rows") < pos("receipt.late_insert"));
}

// ---- pause hooks

struct Script {
    at: String,
    action: HookAction,
    seen: Mutex<Vec<String>>,
    fired: Mutex<bool>,
}

impl PauseHook for Script {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction> {
        self.seen.lock().unwrap().push(p.name.to_string());
        let mut fired = self.fired.lock().unwrap();
        let a = if p.name == self.at && !*fired {
            *fired = true;
            self.action.clone()
        } else {
            HookAction::Continue
        };
        Box::pin(async move { a })
    }
}

fn scripted(at: &str, action: HookAction) -> (Hooks, Arc<Script>, Arc<Collect>) {
    let c = Arc::new(Collect::default());
    let s = Arc::new(Script { at: at.into(), action, seen: Mutex::new(Vec::new()), fired: Mutex::new(false) });
    let mut h = Hooks::with_trace(c.clone());
    h.pause = Some(s.clone());
    (h, s, c)
}

#[tokio::test]
async fn generic_points_are_named_family_verb_point_in_order() {
    let db = FakeDb::new();
    let (h, s, _) = scripted("none", HookAction::Continue);
    exec_with(&db, h).run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    let seen = s.seen.lock().unwrap().clone();
    let generic: Vec<&str> = seen.iter().map(String::as_str).filter(|n| !n.contains(".stmt.")).collect();
    assert_eq!(
        generic,
        vec![
            "test.insert_one.admitted",
            "test.insert_one.begin",
            "test.insert_one.after_anchor",
            "test.insert_one.after_claim",
            "test.insert_one.before_commit",
            "test.insert_one.after_commit",
            "test.insert_one.before_effects",
        ]
    );
    assert!(seen.contains(&"test.insert_one.stmt.receipt.claim.before".to_string()));
    assert!(seen.contains(&"test.insert_one.stmt.fake.insert:rows.after".to_string()));
}

#[tokio::test]
async fn fail_next_makes_the_next_statement_fail_as_if_from_the_server() {
    let db = FakeDb::new();
    let (h, _, c) = scripted("test.insert_one.after_claim", HookAction::FailNext("40001".into()));
    let o = exec_with(&db, h).run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)));
    assert!(c.has("retry:serialization_failure"));
    assert_eq!(db.rows("rows").len(), 1);
}

#[tokio::test]
async fn drop_conn_before_commit_retries_on_a_fresh_session() {
    let db = FakeDb::new();
    let (h, _, c) = scripted("test.insert_one.before_commit", HookAction::DropConn);
    let o = exec_with(&db, h).run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)));
    assert!(c.has("retry:connection_lost"));
    assert_eq!(db.rows("rows").len(), 1);
    assert_eq!(db.commits(), 1);
}
