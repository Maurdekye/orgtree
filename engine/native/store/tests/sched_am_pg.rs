//! S3 §7.3 agent-mail schedules Q-AM1 to Q-AM5 on a real PostgreSQL, with
//! FORCED interleavings (pause-point holds) and every unsafe control run and
//! shown to (1) record `control_executed` at its site and (2) fail the pass
//! condition. Waits are proven by holding one side at `before_commit` and
//! observing whether the other finishes. The island writers raced here are
//! SCHEDULE-GRADE STAND-INS (tests/common_pg/stand_ins.rs), not WS3's.
//!
//! Run ONLY through the P03 run lock (`run-pg.ps1 -Test sched_am_pg`).
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::Arc;
use std::time::Duration;

use common_pg::stand_ins::Island;
use common_pg::*;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::mail::recovery::{self, Sweep};
use orgtree_store::sent::MailClass;
use orgtree_store::{Outcome, Uuid};

type Send = tokio::task::JoinHandle<Outcome<orgtree_store::mail::doors::SendResult>>;

fn spawn_send(ex: &Ex, from: Uuid, to: Target, key: &'static str) -> Send {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&agent_send(to, new_id(), MailClass::Message), &agent_binding(from, key, key)).await.unwrap() })
}

fn spawn_send_id(ex: &Ex, from: Uuid, to: Target, key: &'static str, id: Uuid) -> Send {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&agent_send(to, id, MailClass::Message), &agent_binding(from, key, key)).await.unwrap() })
}

fn spawn_deliver(ex: &Ex, mailbox: Uuid, m: Uuid) -> tokio::task::JoinHandle<Delivery> {
    let ex = ex.clone();
    tokio::spawn(async move { receive::deliver(&ex, org(), mailbox, m).await.unwrap() })
}

async fn done<T>(h: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), h).await.expect("operation did not finish").unwrap()
}

fn applied<T: std::fmt::Debug>(o: &Outcome<T>) -> bool {
    matches!(o, Outcome::Applied(_))
}

// ================================================================ Q-AM1

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am1_different_recipients_never_wait_at_either_stage() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (m1, m2) = (new_id(), new_id());
    let (mut arrived, release) = script.hold("s1", "before_commit");
    let s1 = spawn_send_id(&ex, a(), Target::Agent { principal: d() }, "s1", m1);
    arrive(&mut arrived).await;
    // s1 holds its source locks; a send to a different recipient finishes
    let s2 = spawn_send_id(&ex, b(), Target::Agent { principal: c() }, "s2", m2);
    assert!(applied(&done(s2).await), "different recipients: the source never waits");
    release.add_permits(1);
    assert!(applied(&done(s1).await));
    // receives into different mailboxes never wait on each other
    let (mut arrived, release) = script.hold_named("mail.receive.deliver_agent.before_commit");
    let r1 = spawn_deliver(&ex, mb(d()), m1);
    arrive(&mut arrived).await;
    let r2 = spawn_deliver(&ex, mb(c()), m2);
    assert!(matches!(done(r2).await, Delivery::Done(Received::Received { .. })), "different mailboxes: the receiver never waits");
    release.add_permits(1);
    assert!(matches!(done(r1).await, Delivery::Done(Received::Received { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am1_one_recipient_senders_without_grants_never_wait_and_receives_queue_on_the_head() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (m1, m2) = (new_id(), new_id());
    let (mut arrived, release) = script.hold("s1", "before_commit");
    let s1 = spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "s1", m1); // parent -> child
    arrive(&mut arrived).await;
    let s2 = spawn_send_id(&ex, c(), Target::Agent { principal: b() }, "s2", m2); // child -> parent
    assert!(applied(&done(s2).await), "no-grant senders to one recipient never wait at the source");
    release.add_permits(1);
    assert!(applied(&done(s1).await));
    // receives into ONE mailbox queue on its head, one short transaction each
    let (mut arrived, release) = script.hold_named("mail.receive.deliver_agent.before_commit");
    let r1 = spawn_deliver(&ex, mb(b()), m1);
    arrive(&mut arrived).await;
    let r2 = spawn_deliver(&ex, mb(b()), m2);
    assert!(still_waiting(&r2, 600).await, "the second receive waits on the head");
    release.add_permits(1);
    assert!(matches!(done(r1).await, Delivery::Done(Received::Received { .. })));
    assert!(matches!(done(r2).await, Delivery::Done(Received::Received { .. })));
    assert_eq!(count(&format!("SELECT count(DISTINCT recv_ord) FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord IN (1, 2)", mb(b()))).await, 2, "dense order, no gap, no duplicate");
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE mailbox_id = '{}'", mb(b()))).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am1_grant_bearing_senders_wait_only_on_the_recipient_epoch_and_create_each_grant_once() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    // two different first-time deep senders to F
    let (mut arrived, release) = script.hold("g1", "before_commit");
    let s1 = spawn_send(&ex, a(), Target::Agent { principal: f() }, "g1");
    arrive(&mut arrived).await;
    let s2 = spawn_send(&ex, b(), Target::Agent { principal: f() }, "g2");
    assert!(still_waiting(&s2, 600).await, "grant-bearing senders to one recipient take turns");
    assert!(ev.has("stmt:sent.plan_reply_grant:g2"), "g2 planned (unlocked) before it waited");
    assert!(!ev.has("stmt:sent.recipient_epoch_grant:g2"), "g2 waits exactly on the recipient's epoch row");
    release.add_permits(1);
    assert!(applied(&done(s1).await));
    assert!(applied(&done(s2).await));
    assert!(!ev.any("retry:deadlock"), "never a deadlock");
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}'", f())).await, 2, "(F,A) and (F,B), once each");
    // the same sender twice, concurrently: one grant
    let (mut arrived, release) = script.hold("g3", "before_commit");
    let s3 = spawn_send(&ex, a(), Target::Agent { principal: c() }, "g3");
    arrive(&mut arrived).await;
    let s4 = spawn_send(&ex, a(), Target::Agent { principal: c() }, "g4");
    assert!(still_waiting(&s4, 400).await);
    release.add_permits(1);
    let (o3, o4) = (done(s3).await, done(s4).await);
    let grants = |o: &Outcome<orgtree_store::mail::doors::SendResult>| match o {
        Outcome::Applied(r) => r.warnings.iter().filter(|w| w.starts_with("audience granted")).count(),
        _ => 99,
    };
    assert_eq!(grants(&o3) + grants(&o4), 1, "the grant is created once");
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}'", c())).await, 1);
    assert_eq!(count(&format!("SELECT audience_version FROM authority_epoch WHERE principal_id = '{}'", c())).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am1_control_i_source_writes_the_head_and_senders_wait() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-AM1.source_writes_head"]);
    let (mut arrived, release) = script.hold("c1", "before_commit");
    let s1 = spawn_send(&ex, a(), Target::Agent { principal: b() }, "c1");
    arrive(&mut arrived).await;
    let s2 = spawn_send(&ex, c(), Target::Agent { principal: b() }, "c2");
    let waited = still_waiting(&s2, 600).await;
    release.add_permits(1);
    done(s1).await;
    done(s2).await;
    assert!(ev.has("control_executed:Q-AM1.source_writes_head"), "the control ran");
    assert!(waited, "CONTROL FAILED AS DESIGNED: senders that insert no grant now wait on each other (the head)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am1_control_ii_share_then_upgrade_deadlocks_first_time_senders() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-AM1.share_then_upgrade"]);
    // both take F's epoch row FOR SHARE and reach the grant insert
    let (mut a1, r1) = script.hold("u1", "stmt.sent.grant.before");
    let (mut a2, r2) = script.hold("u2", "stmt.sent.grant.before");
    let s1 = spawn_send(&ex, a(), Target::Agent { principal: f() }, "u1");
    let s2 = spawn_send(&ex, b(), Target::Agent { principal: f() }, "u2");
    arrive(&mut a1).await;
    arrive(&mut a2).await;
    r1.add_permits(1);
    r2.add_permits(1);
    done(s1).await;
    done(s2).await;
    assert!(ev.has("control_executed:Q-AM1.share_then_upgrade"), "the control ran");
    assert!(ev.any("retry:deadlock"), "CONTROL FAILED AS DESIGNED: the share->update upgrade deadlocked (40P01) between two first-time senders: {:?}", ev.snapshot().iter().filter(|e| e.starts_with("retry")).collect::<Vec<_>>());
}

// ================================================================ Q-AM2

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am2_a_recovered_first_message_is_still_received_first() {
    for crash_after_m2_sent in [false, true] {
        reset().await;
        let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
        let (m1, m2) = (new_id(), new_id());
        done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "o1", m1)).await;
        done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "o2", m2)).await;
        if !crash_after_m2_sent {
            // m1's hint is dropped; m2's arrives first and is parked
            assert_eq!(done(spawn_deliver(&ex, mb(b()), m2)).await, Delivery::Parked);
        }
        // (with the crash, no hint was ever consumed) recovery delivers the rest
        let r = recovery::recover(&ex, org(), &Sweep::default()).await.unwrap();
        assert!(r.delivered >= 1, "{r:?}");
        let _ = recovery::recover(&ex, org(), &Sweep::default()).await.unwrap();
        assert_eq!(uuid_of(&format!("SELECT original_message_id FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord = 1", mb(b()))).await, m1, "crash={crash_after_m2_sent}");
        assert_eq!(uuid_of(&format!("SELECT original_message_id FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord = 2", mb(b()))).await, m2);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am2_control_no_pair_gate_receives_the_second_message_first() {
    reset().await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec!["Q-AM2.no_pair_gate"]);
    let (m1, m2) = (new_id(), new_id());
    done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "o1", m1)).await;
    done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "o2", m2)).await;
    done(spawn_deliver(&ex, mb(b()), m2)).await;
    recovery::recover(&ex, org(), &Sweep::default()).await.unwrap();
    assert!(ev.has("control_executed:Q-AM2.no_pair_gate"), "the control ran");
    assert_eq!(
        uuid_of(&format!("SELECT original_message_id FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord = 1", mb(b()))).await,
        m2,
        "CONTROL FAILED AS DESIGNED: without the pair gate m2 is received before m1"
    );
}

// ================================================================ Q-AM3

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am3_redelivery_after_the_receive_commit_is_one_row_and_a_changed_fingerprint_conflicts() {
    reset().await;
    let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
    let m = new_id();
    done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "d1", m)).await;
    // crash after the receive commit, before the acknowledgement
    let r = receive::Receive { org: org(), mailbox: mb(b()), message: m, human: false };
    assert!(applied(&ex.run(&r, &r.binding()).await.unwrap()));
    assert_eq!(done(spawn_deliver(&ex, mb(b()), m)).await, Delivery::Done(Received::Duplicate));
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{m}'")).await, 1);
    // a second delivery with a changed fingerprint is refused as a conflict
    admin_exec(&format!("UPDATE mail_sent SET fingerprint = 'changed' WHERE message_id = '{m}'")).await;
    let r = receive::Receive { org: org(), mailbox: mb(b()), message: m, human: false };
    assert!(matches!(ex.run(&r, &r.binding()).await.unwrap(), Outcome::Refused(ref x) if x.code == "conflict"));
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{m}'")).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am3_control_no_dedupe_key_makes_a_duplicate_row() {
    reset().await;
    admin_exec("ALTER TABLE mailbox_messages DROP CONSTRAINT mailbox_messages_original").await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec!["Q-AM3.no_dedupe_key"]);
    let m = new_id();
    done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "d1", m)).await;
    for _ in 0..2 {
        let r = receive::Receive { org: org(), mailbox: mb(b()), message: m, human: false };
        ex.run(&r, &r.binding()).await.unwrap();
    }
    assert!(ev.has("control_executed:Q-AM3.no_dedupe_key"), "the control ran");
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{m}'")).await, 2, "CONTROL FAILED AS DESIGNED: a duplicate row");
}

// ================================================================ Q-AM4

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am4_two_first_outside_sends_leave_exactly_one_holder_in_both_orders() {
    for (first, second, winner) in [(a(), e(), e()), (e(), a(), a())] {
        reset().await;
        let script = Arc::new(Script::default());
        let (ex, ev) = shared(script.clone(), vec![]);
        let (mut arrived, release) = script.hold("x1", "before_commit");
        let s1 = spawn_send(&ex, first, Target::External { handle: "@net:peer".into() }, "x1");
        arrive(&mut arrived).await;
        let s2 = spawn_send(&ex, second, Target::External { handle: "@net:peer".into() }, "x2");
        assert!(still_waiting(&s2, 500).await, "the second first-send waits on the holder-set row");
        release.add_permits(1);
        assert!(applied(&done(s1).await));
        assert!(applied(&done(s2).await));
        assert_eq!(ev.achieved(&["x1", "x2"]), vec!["x1", "x2"], "achieved order");
        assert_eq!(count("SELECT count(*) FROM audience_grants WHERE target_kind = 'extern'").await, 1, "exactly one holder");
        assert_eq!(uuid_of("SELECT grantee_id FROM audience_grants WHERE target_kind = 'extern'").await, winner, "the later send replaced the first under the source rule");
        assert_eq!(count("SELECT count(*) FROM mail_sent WHERE dest_kind = 'external' AND dest_external = '@net:peer'").await, 2, "both sends committed with their captured destinations");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am4_control_no_holder_lock_leaves_two_holders() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-AM4.no_holder_lock"]);
    let (mut arrived, release) = script.hold("x1", "stmt.sent.lock_self_epoch.before");
    let s1 = spawn_send(&ex, a(), Target::External { handle: "@net:peer".into() }, "x1");
    arrive(&mut arrived).await;
    let s2 = spawn_send(&ex, e(), Target::External { handle: "@net:peer".into() }, "x2");
    assert!(applied(&done(s2).await));
    release.add_permits(1);
    assert!(applied(&done(s1).await));
    assert!(ev.has("control_executed:Q-AM4.no_holder_lock"), "the control ran");
    assert_eq!(count("SELECT count(*) FROM audience_grants WHERE target_kind = 'extern'").await, 2, "CONTROL FAILED AS DESIGNED: two holders in single-holder mode");
}

// ================================================================ Q-AM5

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am5_a_send_racing_delete_is_refused_or_fenced_and_a_namesake_never_receives_it() {
    // order 1: Sent commits, then delete, then a namesake hire, then delivery
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    let m = new_id();
    assert!(applied(&done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "s1", m)).await));
    assert!(applied(&ex.run(&Island::Delete(b()), &system_binding("del1")).await.unwrap()));
    let namesake = new_id();
    assert!(applied(&ex.run(&Island::NamesakeHire { principal: namesake, name: "bravo", parent: Some(a()) }, &system_binding("hire1")).await.unwrap()));
    assert_eq!(done(spawn_deliver(&ex, mb(b()), m)).await, Delivery::Done(Received::Refused { reason: "closed".into() }));
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages m JOIN mailboxes b ON b.mailbox_id = m.mailbox_id WHERE b.owner_id = '{namesake}'")).await, 0, "the namesake never receives it");
    assert_eq!(ev.achieved(&["s1", "del1", "hire1"]), vec!["s1", "del1", "hire1"]);
    // order 2: delete holds its lock; the send waits, then is refused
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (mut arrived, release) = script.hold("del2", "before_commit");
    let ex2 = ex.clone();
    let del = tokio::spawn(async move { ex2.run(&Island::Delete(b()), &system_binding("del2")).await.unwrap() });
    arrive(&mut arrived).await;
    let s = spawn_send(&ex, a(), Target::Agent { principal: b() }, "s2");
    assert!(still_waiting(&s, 500).await, "the send waits on the recipient's epoch row");
    release.add_permits(1);
    assert!(applied(&done(del).await));
    assert!(matches!(done(s).await, Outcome::Refused(ref r) if r.code == "no_such_agent"));
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_am5_control_resolve_by_name_delivers_to_the_namesake() {
    reset().await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec!["Q-AM5.resolve_by_name"]);
    let m = new_id();
    done(spawn_send_id(&ex, a(), Target::Agent { principal: b() }, "s1", m)).await;
    ex.run(&Island::Delete(b()), &system_binding("del1")).await.unwrap();
    let namesake = new_id();
    ex.run(&Island::NamesakeHire { principal: namesake, name: "bravo", parent: Some(a()) }, &system_binding("hire1")).await.unwrap();
    // the delivery still names the captured (closed) mailbox; the control re-resolves by name
    done(spawn_deliver(&ex, mb(b()), m)).await;
    assert!(ev.has("control_executed:Q-AM5.resolve_by_name"), "the control ran");
    assert_eq!(
        count(&format!("SELECT count(*) FROM mailbox_messages m JOIN mailboxes b ON b.mailbox_id = m.mailbox_id WHERE b.owner_id = '{namesake}' AND m.original_message_id = '{m}'")).await,
        1,
        "CONTROL FAILED AS DESIGNED: the message landed in the namesake's mailbox"
    );
}
