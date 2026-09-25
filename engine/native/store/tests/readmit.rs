//! S3 §4.10 (quick-staff undo): a command that opts in with
//! `Command::readmit_compensated` re-admits a `compensated` receipt of the
//! same key and fingerprint as a fresh attempt; every other command replays
//! it. Pure tests over the fake session.

mod common;

use std::sync::Arc;

use common::*;
use orgtree_store::fake::{FakeDb, FakeReceipt, FaultKind};
use orgtree_store::{Binding, CmdError, Command, Decided, Family, Outcome, Session, Tx, Uuid};
use serde_json::json;

/// InsertOne, re-admitting compensated receipts.
struct Readmit(InsertOne);

impl Command for Readmit {
    type Output = Out;
    fn family(&self) -> &'static Family {
        self.0.family()
    }
    fn verb(&self) -> &'static str {
        self.0.verb()
    }
    fn readmit_compensated(&self) -> bool {
        true
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        self.0.anchor(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding, s: &Out) -> Result<bool, CmdError> {
        self.0.may_disclose(tx, b, s).await
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Out>, CmdError> {
        self.0.execute(tx, b).await
    }
}

fn key() -> (Uuid, String, Uuid, String) {
    (org(), "agent".into(), agent(), "k1".into())
}

fn rid() -> Uuid {
    Uuid::from_u128(0x5eed)
}

fn seed(db: &FakeDb, state: &str, fp: &str) {
    db.seed_receipt(key(), FakeReceipt { state: state.into(), fingerprint: Some(fp.into()), result: Some(json!({"n": 1, "ts": null})), receipt_id: rid() });
}

fn stored(db: &FakeDb) -> FakeReceipt {
    db.receipts().into_iter().find(|(k, _)| *k == key()).unwrap().1
}

#[tokio::test]
async fn by_default_a_compensated_receipt_is_replayed() {
    let db = FakeDb::new();
    seed(&db, "compensated", "fp1");
    let (ex, _) = exec(&db);
    let out = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Compensated(_)), "{out:?}");
    assert_eq!(db.count("receipt.readmit"), 0);
    assert!(db.rows("rows").is_empty());
}

#[tokio::test]
async fn an_opted_in_command_is_admitted_again_under_the_same_receipt() {
    let db = FakeDb::new();
    seed(&db, "compensated", "fp1");
    let (ex, _) = exec(&db);
    let cmd = Readmit(InsertOne::new());
    let out = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Applied(Out { n: 7, .. })), "{out:?}");
    assert_eq!(db.rows("rows").len(), 1, "executed once");
    assert_eq!(cmd.0.effects_run(), 1);
    let r = stored(&db);
    assert_eq!((r.state.as_str(), r.receipt_id), ("applied", rid()), "same receipt, now applied");
    assert_eq!(r.result, Some(json!({"n": 7, "ts": null})));
    assert_eq!(db.count("receipt.readmit"), 1);
}

#[tokio::test]
async fn a_different_fingerprint_is_still_a_conflict() {
    let db = FakeDb::new();
    seed(&db, "compensated", "other");
    let (ex, _) = exec(&db);
    let out = ex.run(&Readmit(InsertOne::new()), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Conflict), "{out:?}");
    assert_eq!(db.count("receipt.readmit"), 0);
    assert!(db.rows("rows").is_empty());
}

#[tokio::test]
async fn an_applied_receipt_is_replayed_not_readmitted() {
    let db = FakeDb::new();
    seed(&db, "applied", "fp1");
    let (ex, _) = exec(&db);
    let out = ex.run(&Readmit(InsertOne::new()), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Replayed(_)), "{out:?}");
    assert_eq!(db.count("receipt.readmit"), 0);
}

/// A racer re-admitted and committed first: this attempt's UPDATE matches
/// nothing, and it answers from the row as it now is.
#[tokio::test]
async fn losing_the_readmission_race_replays_the_winner() {
    let db = FakeDb::new();
    seed(&db, "compensated", "fp1");
    let racer = db.clone();
    db.respond("receipt.readmit", move |_| {
        racer.seed_receipt(key(), FakeReceipt { state: "applied".into(), fingerprint: Some("fp1".into()), result: Some(json!({"n": 9, "ts": null})), receipt_id: rid() });
        Ok(orgtree_store::Rows::empty())
    });
    let (ex, _) = exec(&db);
    let out = ex.run(&Readmit(InsertOne::new()), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Replayed(Out { n: 9, .. })), "{out:?}");
    assert!(db.rows("rows").is_empty(), "never executed");
}

/// The re-admitted attempt's COMMIT is lost before it applies: the row is
/// still compensated, which for this command means "not committed", so the
/// retry re-admits and applies once.
#[tokio::test]
async fn a_lost_commit_of_a_readmission_is_retried_not_answered_compensated() {
    let db: Arc<FakeDb> = FakeDb::new();
    seed(&db, "compensated", "fp1");
    db.fault("commit", 1, FaultKind::CommitLostBeforeApply);
    let (ex, _) = exec(&db);
    let out = ex.run(&Readmit(InsertOne::new()), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(out, Outcome::Applied(_)), "{out:?}");
    assert_eq!(db.rows("rows").len(), 1);
    assert_eq!(stored(&db).state, "applied");
}
