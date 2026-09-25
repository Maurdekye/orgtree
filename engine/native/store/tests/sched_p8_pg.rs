//! S3 §7.1 Q-E1, pair P8 (the mailbox head row), on a real PostgreSQL with
//! FORCED interleavings: (a) a receive racing the rehire of archived X, both
//! orders plus the deadlock order; (b) a receive racing the delete of X, both
//! orders; (c) a system-notice receive racing the notice fold, both orders,
//! with two typed notices already waiting. Each leg's unsafe control is run
//! and shown to have executed and failed.
//!
//! The rehire, delete and fold are SCHEDULE-GRADE STAND-INS for WS3's island
//! writers (tests/common_pg/stand_ins.rs) calling WS5's P8 helpers; the fold
//! stand-in represents every folding writer (cheap_compact, a cross-provider
//! switch_model, an account split, reseed), which all call the same helper.
//! Re-running (c) per real writer is WS3's.
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::Arc;
use std::time::Duration;

use common_pg::stand_ins::{FoldRc, Island};
use common_pg::*;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::sent::MailClass;
use orgtree_store::{Outcome, Uuid};

async fn done<T>(h: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), h).await.expect("operation did not finish").unwrap()
}

fn spawn_deliver(ex: &Ex, mailbox: Uuid, m: Uuid) -> tokio::task::JoinHandle<Delivery> {
    let ex = ex.clone();
    tokio::spawn(async move { receive::deliver(&ex, org(), mailbox, m).await.unwrap() })
}

fn spawn_island(ex: &Ex, cmd: Island, key: &'static str) -> tokio::task::JoinHandle<Outcome<i64>> {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&cmd, &system_binding(key)).await.unwrap() })
}

async fn sent_to_b(ex: &Ex) -> Uuid {
    let m = new_id();
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), &m.to_string(), "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    m
}

async fn wakes(m: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake' AND source_ref = '{m}'")).await
}

// ================================================================ (a) rehire

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_a_receive_committed_after_the_rehire_snapshot_is_driven_once() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("rh", "stmt.island.snapshot.after");
    let rh = spawn_island(&ex, Island::Rehire(b()), "rh");
    arrive(&mut arrived).await;
    // the receive commits after the rehire's snapshot: owner archived, no wake
    assert_eq!(done(spawn_deliver(&ex, mb(b()), m)).await, Delivery::Done(Received::Received { recv_ord: Some(1), woke: false, deferred: true }));
    release.add_permits(1);
    assert_eq!(done(rh).await, Outcome::Applied(1), "the rehire's retry sees the message and drives it");
    assert!(ev.has("retry:serialization_failure:40001"), "the head FOR SHARE raised 40001 on a head updated after its snapshot");
    assert_eq!(wakes(m).await, 1, "driven exactly once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_a_rehire_locking_the_head_first_makes_the_receive_wait_then_wake() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("rh", "stmt.mailbox.head_share.after");
    let rh = spawn_island(&ex, Island::Rehire(b()), "rh");
    arrive(&mut arrived).await;
    let r = spawn_deliver(&ex, mb(b()), m);
    assert!(still_waiting(&r, 600).await, "the receive waits on the head the rehire holds");
    release.add_permits(1);
    assert_eq!(done(rh).await, Outcome::Applied(0), "nothing was pending when the rehire looked");
    assert_eq!(done(r).await, Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }), "the receive then reads the owner live and wakes it");
    assert_eq!(wakes(m).await, 1, "driven exactly once");
    assert_eq!(ev.achieved(&["rh"]), vec!["rh"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_a_deadlock_order_is_detected_retried_and_drives_once() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let m = sent_to_b(&ex).await;
    // the rehire holds the epoch row it is updating; the receive holds the head
    let (mut arrived, release) = script.hold("rh", "stmt.island.lock_epoch.after");
    let rh = spawn_island(&ex, Island::Rehire(b()), "rh");
    arrive(&mut arrived).await;
    let r = spawn_deliver(&ex, mb(b()), m);
    assert!(still_waiting(&r, 600).await, "the receive (head held) waits on the owner's epoch row");
    release.add_permits(1);
    let (o_rh, o_r) = (done(rh).await, done(r).await);
    assert!(matches!(o_rh, Outcome::Applied(_)), "{o_rh:?}");
    assert!(matches!(o_r, Delivery::Done(Received::Received { .. })), "{o_r:?}");
    assert!(ev.any("retry:deadlock:40P01"), "PostgreSQL detected the deadlock and C1 retried the loser");
    assert_eq!(wakes(m).await, 1, "driven exactly once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_a_control_rehire_without_the_head_lock_loses_the_wake() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-E1.rehire_no_head_lock"]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("rh", "stmt.island.snapshot.after");
    let rh = spawn_island(&ex, Island::Rehire(b()), "rh");
    arrive(&mut arrived).await;
    done(spawn_deliver(&ex, mb(b()), m)).await;
    release.add_permits(1);
    done(rh).await;
    assert!(ev.has("control_executed:Q-E1.rehire_no_head_lock"), "the control ran");
    assert_eq!(wakes(m).await, 0, "CONTROL FAILED AS DESIGNED: received with no wake and the rehire drove nothing (the lost wake)");
}

// ================================================================ (b) delete

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_b_receive_racing_delete_never_leaves_a_message_in_a_closed_mailbox() {
    // order 1: the receive commits after delete's snapshot
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("del", "stmt.island.snapshot.after");
    let del = spawn_island(&ex, Island::Delete(b()), "del");
    arrive(&mut arrived).await;
    assert!(matches!(done(spawn_deliver(&ex, mb(b()), m)).await, Delivery::Done(Received::Received { .. })));
    release.add_permits(1);
    assert!(matches!(done(del).await, Outcome::Applied(_)));
    assert!(ev.has("retry:serialization_failure:40001"), "delete's head FOR UPDATE raised 40001 and it retried");
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE mailbox_id = '{}'", mb(b()))).await, 0, "erased with the mailbox");
    assert_eq!(text(&format!("SELECT state FROM mailboxes WHERE mailbox_id = '{}'", mb(b()))).await, "closed");
    // order 2: delete locks first; the receive waits, then records a fence
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("del", "before_commit");
    let del = spawn_island(&ex, Island::Delete(b()), "del");
    arrive(&mut arrived).await;
    let r = spawn_deliver(&ex, mb(b()), m);
    assert!(still_waiting(&r, 600).await, "the receive waits on the head delete holds");
    release.add_permits(1);
    assert!(matches!(done(del).await, Outcome::Applied(_)));
    assert_eq!(done(r).await, Delivery::Done(Received::Refused { reason: "closed".into() }));
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE mailbox_id = '{}' AND state <> 'refused'", mb(b()))).await, 0, "never a message in a closed mailbox");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_b_control_delete_without_the_head_lock_leaves_the_message_in_the_deleted_mailbox() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-E1.delete_no_head_lock"]);
    let m = sent_to_b(&ex).await;
    let (mut arrived, release) = script.hold("del", "stmt.island.snapshot.after");
    let del = spawn_island(&ex, Island::Delete(b()), "del");
    arrive(&mut arrived).await;
    done(spawn_deliver(&ex, mb(b()), m)).await;
    release.add_permits(1);
    assert!(matches!(done(del).await, Outcome::Applied(_)));
    assert!(ev.has("control_executed:Q-E1.delete_no_head_lock"), "the control ran");
    assert_eq!(count(&format!("SELECT count(*) FROM authority_epoch WHERE principal_id = '{}'", b())).await, 0, "the agent is deleted");
    assert_eq!(
        count(&format!("SELECT count(*) FROM mailbox_messages WHERE mailbox_id = '{}' AND original_message_id = '{m}' AND state = 'pending'", mb(b()))).await,
        1,
        "CONTROL FAILED AS DESIGNED: the message survives in the deleted mailbox"
    );
}

// ================================================================ (c) the notice fold

async fn notice(ex: &Ex, kind: &str) -> Uuid {
    let n = new_id();
    ex.run(&system_notice(dest_of(b()), n, kind), &system_binding(&n.to_string())).await.unwrap();
    n
}

/// Two typed notices already received, so the fold does fold.
async fn two_waiting(ex: &Ex) -> (Uuid, Uuid) {
    let (n1, n2) = (notice(ex, "context.a").await, notice(ex, "context.b").await);
    for n in [n1, n2] {
        assert!(matches!(receive::deliver(ex, org(), mb(b()), n).await.unwrap(), Delivery::Done(Received::Received { .. })));
    }
    (n1, n2)
}

async fn digest_members() -> Vec<String> {
    let admin_rows = text("SELECT coalesce(string_agg(x->>'id', ',' ORDER BY x->>'id'), '') FROM mailbox_messages m, jsonb_array_elements(m.digest->'groups') g, jsonb_array_elements(g->'members') x WHERE m.kind = 'context.notice_digest'").await;
    admin_rows.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_c_a_notice_received_after_the_fold_snapshot_is_folded_exactly_once() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let (n1, n2) = two_waiting(&ex).await;
    let n3 = notice(&ex, "context.a").await;
    let (mut arrived, release) = script.hold("fold", "stmt.island.snapshot.after");
    let fold = spawn_island(&ex, Island::Fold(b()), "fold");
    arrive(&mut arrived).await;
    assert!(matches!(done(spawn_deliver(&ex, mb(b()), n3)).await, Delivery::Done(Received::Received { .. })));
    release.add_permits(1);
    assert_eq!(done(fold).await, Outcome::Applied(3), "the retried fold folds the late notice with the rest");
    assert!(ev.has("retry:serialization_failure:40001"));
    let mut want: Vec<String> = [n1, n2, n3].iter().map(|u| u.to_string()).collect();
    want.sort();
    assert_eq!(digest_members().await, want, "delivered exactly once: inside the digest");
    assert_eq!(count("SELECT count(*) FROM mailbox_messages WHERE state = 'pending' AND kind <> 'context.notice_digest'").await, 0, "and nowhere else");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_c_a_notice_waiting_behind_the_fold_is_filed_after_the_digest() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (n1, n2) = two_waiting(&ex).await;
    let n3 = notice(&ex, "context.a").await;
    let (mut arrived, release) = script.hold("fold", "before_commit");
    let fold = spawn_island(&ex, Island::Fold(b()), "fold");
    arrive(&mut arrived).await;
    let r = spawn_deliver(&ex, mb(b()), n3);
    assert!(still_waiting(&r, 600).await, "the notice receive waits on the head the fold holds");
    release.add_permits(1);
    assert_eq!(done(fold).await, Outcome::Applied(2));
    assert!(matches!(done(r).await, Delivery::Done(Received::Received { .. })));
    let mut want: Vec<String> = [n1, n2].iter().map(|u| u.to_string()).collect();
    want.sort();
    assert_eq!(digest_members().await, want);
    let order = text("SELECT string_agg(original_message_id::text, ',' ORDER BY recv_ord) FROM mailbox_messages WHERE state = 'pending'").await;
    let parts: Vec<&str> = order.split(',').collect();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[1], n3.to_string(), "filed after the digest, exactly once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_e1_c_control_whole_box_fold_without_the_head_lock_loses_the_notice() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-E1.fold_whole_box_no_lock"]);
    two_waiting(&ex).await;
    let n3 = notice(&ex, "context.a").await;
    // the fold has read the box; the notice commits before the fold's delete
    let (mut arrived, release) = script.hold("fold", "stmt.mailbox.delete_box.before");
    let ex2 = ex.clone();
    let fold = tokio::spawn(async move { ex2.run(&FoldRc(b()), &system_binding("fold")).await.unwrap() });
    arrive(&mut arrived).await;
    assert!(matches!(done(spawn_deliver(&ex, mb(b()), n3)).await, Delivery::Done(Received::Received { .. })));
    release.add_permits(1);
    done(fold).await;
    assert!(ev.has("control_executed:Q-E1.fold_whole_box_no_lock"), "the control ran");
    let in_digest = digest_members().await.contains(&n3.to_string());
    let pending = count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{n3}'")).await;
    assert!(!in_digest && pending == 0, "CONTROL FAILED AS DESIGNED: the notice received between the read and the delete is lost (in digest: {in_digest}, rows: {pending})");
}
