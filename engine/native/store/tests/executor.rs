//! Pure executor tests over the fake session (no database). They prove the
//! executor's decisions (CONTRACT-M1 §3), not PostgreSQL behaviour.

mod common;

use common::*;
use orgtree_store::fake::{FakeDb, FakeReceipt, FaultKind};
use orgtree_store::{DbError, ExecError, Outcome};

fn domain_rows(db: &FakeDb) -> usize {
    db.rows("rows").len()
}

fn applied_receipts(db: &FakeDb) -> usize {
    db.receipts().iter().filter(|(_, r)| r.state == "applied").count()
}

#[tokio::test]
async fn applies_once_and_writes_exactly_one_receipt() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let cmd = InsertOne::new();
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::Applied(Out { n: 7, ts: None }));
    assert_eq!(domain_rows(&db), 1);
    assert_eq!(db.receipts().len(), 1, "group identity: exactly one receipt row per committed tx");
    let (_, r) = &db.receipts()[0];
    assert_eq!(r.state, "applied");
    assert_eq!(r.fingerprint.as_deref(), Some("fp1"));
    assert_eq!(r.result, Some(serde_json::json!({"n": 7, "ts": null})));
    assert_eq!(cmd.effects_run(), 1);
}

#[tokio::test]
async fn anchor_runs_before_the_claim_and_the_claim_before_execute() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    let labels = db.labels();
    let pos = |l: &str| labels.iter().position(|x| x == l).unwrap_or_else(|| panic!("{l} not run: {labels:?}"));
    assert!(pos("test.anchor") < pos("receipt.claim"));
    assert!(pos("receipt.claim") < pos("test.lock_own_row"));
    assert!(pos("fake.insert:rows") < pos("receipt.finalize"));
}

#[tokio::test]
async fn same_key_same_fingerprint_replays_without_executing() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let cmd = InsertOne::new();
    ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::Replayed(Out { n: 7, ts: None }));
    assert_eq!(domain_rows(&db), 1);
    assert_eq!(cmd.effects_run(), 1, "a replay runs no effects");
    assert_eq!(db.count("test.lock_own_row"), 1, "execute ran once");
}

#[tokio::test]
async fn same_key_different_fingerprint_conflicts() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp2")).await.unwrap();
    assert_eq!(o, Outcome::Conflict);
    assert_eq!(domain_rows(&db), 1);
}

#[tokio::test]
async fn replay_still_checks_disclosure() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    let mut hidden = InsertOne::new();
    hidden.disclose = false;
    assert_eq!(ex.run(&hidden, &binding("k1", "fp1")).await.unwrap(), Outcome::NotDisclosed);
}

#[tokio::test]
async fn a_fenced_key_is_refused_with_nothing_done() {
    let db = FakeDb::new();
    let b = binding("k1", "fp1");
    db.seed_receipt(
        (b.op.org, "agent".into(), agent(), "k1".into()),
        FakeReceipt { state: "fenced".into(), fingerprint: None, result: None, receipt_id: orgtree_store::Uuid::new_v4() },
    );
    let (ex, _) = exec(&db);
    let cmd = InsertOne::new();
    assert_eq!(ex.run(&cmd, &b).await.unwrap(), Outcome::Fenced);
    assert_eq!(domain_rows(&db), 0);
    assert_eq!(db.count("test.lock_own_row"), 0);
}

#[tokio::test]
async fn a_refusal_commits_nothing_not_even_its_receipt() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let mut cmd = InsertOne::new();
    cmd.refuse = true;
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "test_refusal"));
    assert_eq!(domain_rows(&db), 0);
    assert!(db.receipts().is_empty());
    assert_eq!(cmd.effects_run(), 0);
    // Rolled back, not committed-and-rescued: without this the claimed-at-
    // commit trigger alone would hide a refusal that COMMITs (mutation M6
    // survived before this line was added).
    assert_eq!(db.count("commit"), 0, "a refusal must never reach COMMIT");
}

/// The claimed-at-commit trigger (emulated by the fake) turns a commit that
/// still holds a `claimed` receipt into a failure, never a silent success.
#[tokio::test]
async fn a_commit_with_an_unfinalized_claim_fails() {
    use orgtree_store::fake::FakeConnector;
    use orgtree_store::{Session, Val};
    let db = FakeDb::new();
    let mut s = <FakeConnector as orgtree_store::Connector>::connect(&FakeConnector { db: db.clone() }).await.unwrap();
    s.begin(orgtree_store::Isolation::ReadCommitted).await.unwrap();
    let b = binding("k9", "fp");
    let p = vec![
        Val::Uuid(b.op.org), Val::text("agent"), Val::Uuid(agent()), Val::text("k9"), Val::Uuid(orgtree_store::Uuid::new_v4()),
        Val::text("test"), Val::text("v"), Val::text("fp"), Val::text("legacy-1"), Val::text("agent"), Val::Null, Val::Null, Val::Null, Val::Null,
    ];
    s.exec("receipt.claim", "", &p).await.unwrap();
    let e = s.commit().await.unwrap_err();
    assert_eq!(e.sqlstate(), Some("OT001"));
    assert!(db.receipts().is_empty());
}

/// Q-C4 core (pure): inject 40001 and 40P01 at every statement and at
/// COMMIT; each run ends with exactly one outcome, one row, one receipt, the
/// same key on every attempt, and effects once.
#[tokio::test]
async fn injected_serialization_and_deadlock_at_every_step_retry_to_one_outcome() {
    let steps = ["begin", "test.anchor", "receipt.claim", "test.lock_own_row", "fake.insert:rows", "receipt.finalize", "commit"];
    let mut cases = 0;
    for code in ["40001", "40P01"] {
        for step in steps {
            let db = FakeDb::new();
            db.fault(step, 1, FaultKind::Error(DbError::sql(code)));
            let (ex, trace) = exec(&db);
            let cmd = InsertOne::new();
            let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
            assert_eq!(o, Outcome::Applied(Out { n: 7, ts: None }), "{code} at {step}");
            assert_eq!(domain_rows(&db), 1, "{code} at {step}");
            assert_eq!(applied_receipts(&db), 1, "{code} at {step}");
            assert_eq!(cmd.effects_run(), 1, "{code} at {step}: effects only from the committed attempt");
            let keys = claim_keys(&db);
            assert!(keys.iter().all(|k| k == "k1"), "{code} at {step}: identity changed across attempts: {keys:?}");
            assert_eq!(trace.events.lock().unwrap().iter().filter(|e| e.starts_with("retry:")).count(), 1, "{code} at {step}: the fault fired once");
            cases += 1;
        }
    }
    assert_eq!(cases, 14);
}

#[tokio::test]
async fn allowlisted_unique_violation_retries() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::unique("resource_reservations_held_resource")));
    let (ex, trace) = exec(&db);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)));
    assert!(trace.has("retry:unique_violation_allowlisted"));
    assert_eq!(domain_rows(&db), 1);
}

#[tokio::test]
async fn global_allowlist_unique_violation_retries() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::unique("mail_sent_pair_seq")));
    let (ex, _) = exec(&db);
    assert!(matches!(ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap(), Outcome::Applied(_)));
}

#[tokio::test]
async fn non_allowlisted_unique_violation_fails_fast() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::unique("agents_seat")));
    let (ex, trace) = exec(&db);
    let r = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await;
    assert_eq!(r, Err(ExecError::Sql(DbError::unique("agents_seat"))));
    assert_eq!(db.count("receipt.claim"), 1, "exactly one attempt");
    assert!(!trace.events.lock().unwrap().iter().any(|e| e.starts_with("retry:")));
    assert!(db.receipts().is_empty());
}

#[tokio::test]
async fn a_unique_violation_without_a_constraint_name_fails_fast() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::sql("23505")));
    let (ex, _) = exec(&db);
    assert!(matches!(ex.run(&InsertOne::new(), &binding("k1", "fp1")).await, Err(ExecError::Sql(_))));
    assert_eq!(db.count("receipt.claim"), 1);
}

#[tokio::test]
async fn other_sql_errors_fail_fast() {
    let db = FakeDb::new();
    db.fault("test.lock_own_row", 1, FaultKind::Error(DbError::sql("22P02")));
    let (ex, _) = exec(&db);
    assert!(matches!(ex.run(&InsertOne::new(), &binding("k1", "fp1")).await, Err(ExecError::Sql(_))));
    assert_eq!(db.count("receipt.claim"), 1);
}

#[tokio::test]
async fn exhaustion_is_a_truthful_retryable_refusal() {
    let db = FakeDb::new();
    for n in 1..=5 {
        db.fault("fake.insert:rows", n, FaultKind::Error(DbError::sql("40001")));
    }
    let (ex, _) = exec(&db);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::RetryExhausted { attempts: 5, last_sqlstate: Some("40001".into()) });
    assert_eq!(domain_rows(&db), 0);
    assert!(db.receipts().is_empty());
}

#[tokio::test]
async fn lock_timeout_is_answered_not_looped() {
    let db = FakeDb::new();
    db.fault("test.lock_own_row", 1, FaultKind::Error(DbError::sql("55P03")));
    let (ex, _) = exec(&db);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::RetryExhausted { attempts: 1, last_sqlstate: Some("55P03".into()) });
    assert_eq!(db.count("receipt.claim"), 1);
}

/// §3.6: COMMIT applied on the server, reply lost. Resolution re-claims the
/// SAME key, finds the committed row and replays: one row, not two.
#[tokio::test]
async fn lost_commit_after_apply_resolves_by_same_key_to_a_replay() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::CommitLostAfterApply);
    let (ex, trace) = exec(&db);
    let cmd = InsertOne::new();
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::Replayed(Out { n: 7, ts: None }));
    assert_eq!(domain_rows(&db), 1);
    assert_eq!(claim_keys(&db), vec!["k1", "k1"]);
    assert!(trace.has("commit_unknown"));
    assert_eq!(cmd.effects_run(), 0, "the in-doubt attempt ran no effects; the replay runs none either");
}

#[tokio::test]
async fn lost_commit_before_apply_resolves_by_executing_once() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::CommitLostBeforeApply);
    let (ex, _) = exec(&db);
    let cmd = InsertOne::new();
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    assert_eq!(o, Outcome::Applied(Out { n: 7, ts: None }));
    assert_eq!(domain_rows(&db), 1);
    assert_eq!(cmd.effects_run(), 1);
}

#[tokio::test]
async fn unresolved_lost_commit_is_unknown_never_exhausted() {
    let db = FakeDb::new();
    db.fault("commit", 1, FaultKind::CommitLostBeforeApply);
    // every resolution attempt's claim hits a lock timeout (in-doubt original)
    db.fault("receipt.claim", 2, FaultKind::Error(DbError::sql("55P03")));
    let (ex, _) = exec(&db);
    assert_eq!(ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap(), Outcome::Unknown);
}

#[tokio::test]
async fn the_attempt_clock_is_recaptured_on_retry() {
    let db = FakeDb::new();
    db.fault("fake.insert:rows", 1, FaultKind::Error(DbError::sql("40001")));
    let (ex, _) = exec(&db);
    let mut cmd = InsertOne::new();
    cmd.use_now = true;
    let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
    let clocks: Vec<i64> = db.log().into_iter().filter(|e| e.label == "exec.now").map(|_| 0).collect();
    assert_eq!(clocks.len(), 2, "one clock read per attempt");
    let stored = db.rows("rows")[0][1].as_int().unwrap();
    let Outcome::Applied(out) = o else { panic!() };
    assert_eq!(out.ts, Some(stored));
    // the fake clock starts at 1.7e15 and each read adds 1 s: attempt 2 read the second value
    assert_eq!(stored, 1_700_000_000_000_000 + 2_000_000);
}

#[tokio::test]
async fn the_clock_is_read_once_per_attempt() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    struct TwoReads;
    impl orgtree_store::Command for TwoReads {
        type Output = (i64, i64);
        fn family(&self) -> &'static orgtree_store::Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "two_reads"
        }
        async fn anchor<S: orgtree_store::Session>(&self, _tx: &mut orgtree_store::Tx<'_, S>, _b: &orgtree_store::Binding) -> Result<(), orgtree_store::CmdError> {
            Ok(())
        }
        async fn may_disclose<S: orgtree_store::Session>(&self, _tx: &mut orgtree_store::Tx<'_, S>, _b: &orgtree_store::Binding, _o: &(i64, i64)) -> Result<bool, orgtree_store::CmdError> {
            Ok(true)
        }
        async fn execute<S: orgtree_store::Session>(&self, tx: &mut orgtree_store::Tx<'_, S>, _b: &orgtree_store::Binding) -> Result<orgtree_store::Decided<(i64, i64)>, orgtree_store::CmdError> {
            let a = tx.now().await?;
            let b = tx.now().await?;
            Ok(orgtree_store::Decided::Applied((a, b)))
        }
    }
    let Outcome::Applied((a, b)) = ex.run(&TwoReads, &binding("k2", "fp")).await.unwrap() else { panic!() };
    assert_eq!(a, b);
    assert_eq!(db.count("exec.now"), 1);
}

#[tokio::test]
async fn a_connection_lost_mid_statement_retries_on_a_fresh_session() {
    let db = FakeDb::new();
    db.fault("test.lock_own_row", 1, FaultKind::Error(DbError::lost()));
    let (ex, _) = exec(&db);
    let o = ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)));
    let sessions: std::collections::BTreeSet<u32> = db.log().into_iter().map(|e| e.session).collect();
    assert_eq!(sessions.len(), 2, "the broken session was discarded, not reused");
}

#[tokio::test]
async fn distinct_keys_are_distinct_operations() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    ex.run(&InsertOne::new(), &binding("k1", "fp1")).await.unwrap();
    ex.run(&InsertOne::new(), &binding("k2", "fp1")).await.unwrap();
    assert_eq!(domain_rows(&db), 2);
    assert_eq!(applied_receipts(&db), 2);
}

#[tokio::test]
async fn the_pool_is_bounded() {
    let db = FakeDb::new();
    let (ex, _) = exec(&db);
    let pool = ex.pool();
    assert_eq!(pool.size(), 2);
    let a = pool.get().await.unwrap();
    let _b = pool.get().await.unwrap();
    assert_eq!(pool.available(), 0);
    let waiting = tokio::time::timeout(std::time::Duration::from_millis(50), pool.get()).await;
    assert!(waiting.is_err(), "a third get must wait while two are held");
    drop(a);
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50), pool.get()).await.is_ok());
}

/// WS5's application-level retry: same identity, fresh clock, bounded, and
/// traced with its true cause (no invented SQLSTATE).
mod retry_attempt {
    use super::*;
    use orgtree_store::{Binding, CmdError, Command, Decided, Family, Session, Tx};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct AskRetry {
        times: u32,
        seen: AtomicU32,
    }

    impl Command for AskRetry {
        type Output = i64;
        fn family(&self) -> &'static Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "ask_retry"
        }
        async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
            let t = tx.now().await?;
            tx.exec("fake.insert:rows", "INSERT ...", &[orgtree_store::Val::Int(t)]).await?;
            if self.seen.fetch_add(1, Ordering::SeqCst) < self.times {
                return Err(CmdError::RetryAttempt { cause: "route_needs_grant_lock" });
            }
            Ok(Decided::Applied(t))
        }
    }

    #[tokio::test]
    async fn a_requested_retry_reruns_with_the_same_key_and_a_fresh_clock() {
        let db = FakeDb::new();
        let (ex, trace) = exec(&db);
        let cmd = AskRetry { times: 1, seen: AtomicU32::new(0) };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        let Outcome::Applied(t) = o else { panic!("{o:?}") };
        assert_eq!(t, 1_700_000_000_000_000 + 2_000_000, "the second attempt read a fresh clock");
        assert_eq!(claim_keys(&db), vec!["k1", "k1"]);
        assert_eq!(db.rows("rows").len(), 1, "the first attempt's write was rolled back");
        assert!(trace.has("retry:route_needs_grant_lock"));
    }

    #[tokio::test]
    async fn requested_retries_are_bounded_and_invent_no_sqlstate() {
        let db = FakeDb::new();
        let (ex, _) = exec(&db);
        let cmd = AskRetry { times: 99, seen: AtomicU32::new(0) };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        assert_eq!(o, Outcome::RetryExhausted { attempts: 5, last_sqlstate: None });
        assert!(db.receipts().is_empty());
    }
}

#[test]
fn xact_diff_keeps_only_this_transactions_counters() {
    use orgtree_store::exec::xact_diff;
    use orgtree_store::hooks::XactTable;
    let t = |n: &str, ins: i64, upd: i64| XactTable { relname: n.into(), seq_scan: 0, idx_scan: ins + upd, n_tup_ins: ins, n_tup_upd: upd, n_tup_del: 0 };
    let base = vec![t("outgoing_intents", 1, 0), t("runtime_state", 0, 1)];
    let after = vec![t("outgoing_intents", 2, 0), t("runtime_state", 0, 1), t("authority_epoch", 0, 0)];
    let d = xact_diff(&base, &after);
    assert_eq!(d, vec![t("outgoing_intents", 1, 0)], "an earlier transaction's rows must not leak into this one");
}

/// Executor::read: one REPEATABLE READ READ ONLY snapshot, no receipt, never
/// committed; a lost connection retries on a fresh session.
mod reads {
    use super::*;
    use orgtree_store::read::Read;
    use orgtree_store::{CmdError, Rows, Session, Tx, Val};

    struct Count;
    impl Read for Count {
        type Output = i64;
        fn family(&self) -> &'static str {
            "inbox"
        }
        fn verb(&self) -> &'static str {
            "list"
        }
        async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<i64, CmdError> {
            let r = tx.exec("inbox.count", "SELECT count(*) FROM mailbox_messages", &[]).await?;
            Ok(r.first().and_then(|x| x.first()).and_then(Val::as_int).unwrap_or(-1))
        }
    }

    #[tokio::test]
    async fn a_read_writes_no_receipt_and_never_commits() {
        let db = FakeDb::new();
        db.respond("inbox.count", |_| Ok(Rows::one(vec![Val::Int(3)])));
        let (ex, _) = exec(&db);
        assert_eq!(ex.read(&Count, org(), None).await.unwrap(), 3);
        assert!(db.receipts().is_empty());
        assert_eq!(db.count("commit"), 0, "a read closes its snapshot with ROLLBACK");
        assert_eq!(db.count("receipt.claim"), 0);
    }

    #[tokio::test]
    async fn a_lost_connection_retries_on_a_fresh_session() {
        let db = FakeDb::new();
        db.respond("inbox.count", |_| Ok(Rows::one(vec![Val::Int(3)])));
        db.fault("inbox.count", 1, FaultKind::Error(DbError::lost()));
        let (ex, trace) = exec(&db);
        assert_eq!(ex.read(&Count, org(), None).await.unwrap(), 3);
        assert!(trace.has("retry:connection_lost"));
    }

    #[tokio::test]
    async fn other_errors_are_returned_not_retried() {
        let db = FakeDb::new();
        db.fault("inbox.count", 1, FaultKind::Error(DbError::sql("42P01")));
        let (ex, _) = exec(&db);
        assert!(matches!(ex.read(&Count, org(), None).await, Err(ExecError::Sql(_))));
        assert_eq!(db.count("inbox.count"), 1);
    }
}

/// WS5: an anchor can refuse (caller not live, halted, ...): nothing is
/// written — no claim, no domain row — and the refusal is the answer.
mod anchor_refusal {
    use super::*;
    use orgtree_store::{Binding, CmdError, Command, Decided, Family, Refusal, Session, Tx};

    struct RefuseInAnchor;
    impl Command for RefuseInAnchor {
        type Output = i64;
        fn family(&self) -> &'static Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "refuse_in_anchor"
        }
        async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            tx.exec("test.anchor", "SELECT 1", &[]).await?;
            Err(CmdError::Refused(Refusal::new("caller_not_live", "the caller is archived")))
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
            tx.exec("fake.insert:rows", "INSERT ...", &[]).await?;
            Ok(Decided::Applied(1))
        }
    }

    #[tokio::test]
    async fn an_anchor_refusal_writes_nothing_and_is_the_answer() {
        let db = FakeDb::new();
        let (ex, trace) = exec(&db);
        let o = ex.run(&RefuseInAnchor, &binding("k1", "fp1")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(ref r) if r.code == "caller_not_live"), "{o:?}");
        // freeze amendment 2: the claim runs (a committed receipt would have
        // replayed), then the refusal rolls it back
        assert_eq!(db.count("receipt.claim"), 1);
        assert!(db.receipts().is_empty(), "the rollback removed the claim");
        assert!(db.rows("rows").is_empty());
        assert_eq!(db.count("commit"), 0);
        assert!(!trace.events.lock().unwrap().iter().any(|e| e.starts_with("retry:")), "a refusal is never retried");
        assert!(trace.has("outcome:refused"));
    }
}

/// Review finding 1: after a lost COMMIT, the in-doubt original is settled by
/// re-claiming its key BEFORE any anchor runs, so an anchor that now refuses
/// (the operation retired its own caller; a halt landed) can never answer
/// "refused" for an operation that committed.
mod resolution_before_anchor {
    use super::*;
    use orgtree_store::{Binding, CmdError, Command, Decided, Family, Refusal, Session, Tx};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct SelfRetire {
        anchors: AtomicU32,
    }
    impl Command for SelfRetire {
        type Output = i64;
        fn family(&self) -> &'static Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "self_retire"
        }
        async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            // the first attempt retires the caller; any later anchor refuses
            if self.anchors.fetch_add(1, Ordering::SeqCst) > 0 {
                return Err(CmdError::Refused(Refusal::new("caller_not_live", "archived")));
            }
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
            tx.exec("fake.insert:rows", "INSERT ...", &[]).await?;
            Ok(Decided::Applied(1))
        }
    }

    #[tokio::test]
    async fn a_committed_operation_is_replayed_even_if_its_anchor_now_refuses() {
        let db = FakeDb::new();
        db.fault("commit", 1, FaultKind::CommitLostAfterApply);
        let (ex, _) = exec(&db);
        let cmd = SelfRetire { anchors: AtomicU32::new(0) };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        assert_eq!(o, Outcome::Replayed(1), "the committed outcome, not a refusal");
        assert_eq!(cmd.anchors.load(Ordering::SeqCst), 1, "no anchor ran before the resolution");
        assert_eq!(db.rows("rows").len(), 1);
    }

    #[tokio::test]
    async fn an_uncommitted_operation_then_meets_its_anchor_normally() {
        let db = FakeDb::new();
        db.fault("commit", 1, FaultKind::CommitLostBeforeApply);
        let (ex, _) = exec(&db);
        let cmd = SelfRetire { anchors: AtomicU32::new(0) };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(ref r) if r.code == "caller_not_live"), "{o:?}");
        assert!(db.rows("rows").is_empty());
    }
}


/// WS7: an operation's causal refs reach the trace with Admitted and Outcome.
mod causal_refs {
    use super::*;
    use orgtree_store::hooks::{EventKind, Hooks, TraceEvent, TraceSink};
    use orgtree_store::{Binding, CmdError, Command, Decided, Family, Session, Tx};
    use std::sync::{Arc, Mutex};

    struct WithRefs;
    impl Command for WithRefs {
        type Output = i64;
        fn family(&self) -> &'static Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "with_refs"
        }
        fn causal_refs(&self) -> Vec<String> {
            vec!["msg-1".into()]
        }
        async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
            Ok(Decided::Applied(1))
        }
    }

    #[derive(Default)]
    struct Kinds(Mutex<Vec<String>>);
    impl TraceSink for Kinds {
        fn event(&self, e: &TraceEvent<'_>) {
            let s = match &e.kind {
                EventKind::Admitted => "admitted".to_string(),
                EventKind::CausalRefs { refs } => format!("refs:{}", refs.join(",")),
                EventKind::Outcome { outcome } => format!("outcome:{outcome}"),
                _ => return,
            };
            self.0.lock().unwrap().push(s);
        }
    }

    #[tokio::test]
    async fn refs_follow_admitted_and_outcome() {
        let db = FakeDb::new();
        let k = Arc::new(Kinds::default());
        let ex = exec_with(&db, Hooks::with_trace(k.clone()));
        ex.run(&WithRefs, &binding("k1", "fp1")).await.unwrap();
        assert_eq!(*k.0.lock().unwrap(), vec!["admitted", "refs:msg-1", "outcome:applied", "refs:msg-1"]);
    }
}


/// Freeze amendment 2 (lead decision 3): tests (a), (b), (c) and the control
/// Q-C4.anchor_refuses_first.
mod amendment_2 {
    use super::*;
    use orgtree_store::{Binding, CmdError, Command, Decided, Family, Refusal, Session, Tx};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A caller whose anchor refuses once `halted` is set.
    struct Halting {
        halted: AtomicBool,
        retire_self: bool,
    }
    impl Command for Halting {
        type Output = i64;
        fn family(&self) -> &'static Family {
            &FAM
        }
        fn verb(&self) -> &'static str {
            "halting"
        }
        async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
            tx.exec("test.anchor", "SELECT 1 FOR SHARE", &[]).await?;
            if self.halted.load(Ordering::SeqCst) {
                return Err(CmdError::Refused(Refusal::new("halted", "the caller is halted")));
            }
            Ok(())
        }
        async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
            Ok(true)
        }
        async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<i64>, CmdError> {
            tx.exec("fake.insert:rows", "INSERT ...", &[]).await?;
            if self.retire_self {
                // the operation itself makes the caller's anchor refuse from now on
                self.halted.store(true, Ordering::SeqCst);
            }
            Ok(Decided::Applied(1))
        }
    }

    #[cfg(feature = "qualification")]
    fn armed(db: &std::sync::Arc<FakeDb>) -> orgtree_store::Executor<orgtree_store::fake::FakeConnector> {
        {
            use orgtree_store::hooks::{ControlPlan, Hooks};
            struct Arm;
            impl ControlPlan for Arm {
                fn armed(&self, id: &str, _: &orgtree_store::OpIdentity, _: Option<&str>) -> bool {
                    id == "Q-C4.anchor_refuses_first"
                }
            }
            let mut h = Hooks::default();
            h.controls = Some(std::sync::Arc::new(Arm));
            exec_with(db, h)
        }
    }

    /// (a) lost COMMIT, then the operation's own effect makes the anchor refuse.
    #[tokio::test]
    async fn a_lost_commit_then_self_retire_is_never_refused() {
        let db = FakeDb::new();
        db.fault("commit", 1, FaultKind::CommitLostAfterApply);
        let (ex, _) = exec(&db);
        let cmd = Halting { halted: AtomicBool::new(false), retire_self: true };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        assert!(matches!(o, Outcome::Replayed(_) | Outcome::NotDisclosed | Outcome::Unknown), "never Refused: {o:?}");
        assert_eq!(db.rows("rows").len(), 1);
    }

    /// (b) a same-key retry after the original applied, the caller since halted.
    #[tokio::test]
    async fn a_same_key_retry_after_halt_replays() {
        let db = FakeDb::new();
        let (ex, _) = exec(&db);
        let cmd = Halting { halted: AtomicBool::new(false), retire_self: false };
        assert_eq!(ex.run(&cmd, &binding("k1", "fp1")).await.unwrap(), Outcome::Applied(1));
        cmd.halted.store(true, Ordering::SeqCst);
        assert_eq!(ex.run(&cmd, &binding("k1", "fp1")).await.unwrap(), Outcome::Replayed(1), "replay, checked by may_disclose, not refused");
        assert_eq!(db.rows("rows").len(), 1);
    }

    /// (c) a NEW operation from a halted caller: Refused, nothing written.
    #[tokio::test]
    async fn a_new_operation_from_a_halted_caller_is_refused_with_nothing_written() {
        let db = FakeDb::new();
        let (ex, _) = exec(&db);
        let cmd = Halting { halted: AtomicBool::new(true), retire_self: false };
        let o = ex.run(&cmd, &binding("k2", "fp1")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(ref r) if r.code == "halted"), "{o:?}");
        assert!(db.receipts().is_empty());
        assert!(db.rows("rows").is_empty());
        assert_eq!(db.count("commit"), 0);
        let labels = db.labels();
        let pos = |l: &str| labels.iter().position(|x| x == l).unwrap();
        assert!(pos("test.anchor") < pos("receipt.claim"), "the anchor's locks are still taken first");
    }

    /// Control Q-C4.anchor_refuses_first: the old order fails (a) and (b).
    #[cfg(feature = "qualification")]
    #[tokio::test]
    async fn control_anchor_refuses_first_fails_a_and_b() {
        // (a)
        let db = FakeDb::new();
        db.fault("commit", 1, FaultKind::CommitLostAfterApply);
        let ex = armed(&db);
        let cmd = Halting { halted: AtomicBool::new(false), retire_self: true };
        let o = ex.run(&cmd, &binding("k1", "fp1")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(_)), "the unsafe control must answer Refused for a committed op: {o:?}");
        assert_eq!(db.rows("rows").len(), 1, "yet it committed");
        // (b)
        let db = FakeDb::new();
        let ex = armed(&db);
        let cmd = Halting { halted: AtomicBool::new(false), retire_self: false };
        assert_eq!(ex.run(&cmd, &binding("k1", "fp1")).await.unwrap(), Outcome::Applied(1));
        cmd.halted.store(true, Ordering::SeqCst);
        assert!(matches!(ex.run(&cmd, &binding("k1", "fp1")).await.unwrap(), Outcome::Refused(_)), "the unsafe control refuses the replay");
    }
}
