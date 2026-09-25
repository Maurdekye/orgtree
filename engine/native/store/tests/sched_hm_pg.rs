//! S3 §7.3 human-mail and inbox schedules (Q-HM1..4, Q-IB1..3) and r7 Q-C7
//! (b)/(c) (P1: the reply grant and the audience tool racing a move), on a
//! real PostgreSQL with FORCED interleavings; every unsafe control is run and
//! shown to have executed and failed. Moves are the SCHEDULE-GRADE stand-in
//! (tests/common_pg/stand_ins.rs), not WS3's writer.
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::Arc;
use std::time::Duration;

use common_pg::stand_ins::Island;
use common_pg::*;
use orgtree_store::mail::audience::Audience;
use orgtree_store::mail::human::{self, HumanCommand, HumanSend, MarkRead};
use orgtree_store::mail::inbox;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::runtime::{self, admit::FakeProvider};
use orgtree_store::sent::MailClass;
use orgtree_store::{Outcome, Uuid};

async fn done<T>(h: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), h).await.expect("operation did not finish").unwrap()
}

fn applied<T: std::fmt::Debug>(o: &Outcome<T>) -> bool {
    matches!(o, Outcome::Applied(_))
}

fn spawn_human(ex: &Ex, node: Uuid, key: &'static str) -> tokio::task::JoinHandle<Outcome<human::HumanSendResult>> {
    let ex = ex.clone();
    tokio::spawn(async move {
        let cmd = HumanSend { node, message_id: new_id(), kind: "message".into(), body: format!("from {key}") };
        ex.run(&cmd, &operator_binding(Some(key), key)).await.unwrap()
    })
}

fn spawn_island(ex: &Ex, cmd: Island, key: &'static str) -> tokio::task::JoinHandle<Outcome<i64>> {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&cmd, &system_binding(key)).await.unwrap() })
}

async fn deep_reach_to(node: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM mail_sent WHERE kind = 'context.deep_reach' AND dest_principal_id = '{node}'")).await
}

// ================================================================ Q-HM1

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm1_concurrent_human_sends_create_the_first_contact_audience_once_and_notify_each_chain_once() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    // one deep node, two concurrent sends
    let (mut arrived, release) = script.hold("h1", "before_commit");
    let h1 = spawn_human(&ex, c(), "h1");
    arrive(&mut arrived).await;
    let h2 = spawn_human(&ex, c(), "h2");
    assert!(still_waiting(&h2, 500).await, "the second send takes turns on the node's epoch row");
    release.add_permits(1);
    let (o1, o2) = (done(h1).await, done(h2).await);
    let granted = |o: &Outcome<human::HumanSendResult>| matches!(o, Outcome::Applied(r) if r.audience_granted) as i32;
    assert_eq!(granted(&o1) + granted(&o2), 1, "the first-contact audience is created once");
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'user'", c())).await, 1);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user'").await, 2, "one Sent row per original");
    assert_eq!((deep_reach_to(b()).await, deep_reach_to(a()).await), (2, 2), "each chain notified once per send");
    // two nodes sharing ancestors: disjoint node rows, no wait
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (mut arrived, release) = script.hold("h3", "before_commit");
    let h3 = spawn_human(&ex, c(), "h3");
    arrive(&mut arrived).await;
    let h4 = spawn_human(&ex, f(), "h4");
    assert!(applied(&done(h4).await), "sends to nodes sharing ancestors do not wait on each other");
    release.add_permits(1);
    assert!(applied(&done(h3).await));
    assert_eq!((deep_reach_to(c()).await, deep_reach_to(b()).await, deep_reach_to(a()).await), (1, 2, 2));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm1_control_no_lock_and_no_key_makes_two_first_contact_grants() {
    reset().await;
    admin_exec("ALTER TABLE audience_grants DROP CONSTRAINT audience_grants_key").await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-HM1.no_lock_no_key"]);
    // h1 has read "no grant" and is about to insert; h2 runs through
    let (mut arrived, release) = script.hold("h1", "stmt.sent.grant_plain.before");
    let h1 = spawn_human(&ex, c(), "h1");
    arrive(&mut arrived).await;
    assert!(applied(&done(spawn_human(&ex, c(), "h2")).await));
    release.add_permits(1);
    assert!(applied(&done(h1).await));
    assert!(ev.has("control_executed:Q-HM1.no_lock_no_key"), "the control ran");
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'user'", c())).await, 2, "CONTROL FAILED AS DESIGNED: two (node, USER) grants");
}

// ================================================================ Q-HM2

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm2_the_same_client_op_replays_and_a_different_body_conflicts_and_the_control_posts_twice() {
    for control in [false, true] {
        reset().await;
        let controls = if control { vec!["Q-HM2.client_op_unbound"] } else { vec![] };
        let (ex, ev) = shared(Arc::new(Script::default()), controls);
        let send = |body: &str| HumanSend { node: b(), message_id: new_id(), kind: "message".into(), body: body.into() };
        let bind = |fp: &str| human::human_binding(ex.hooks(), org(), operator(), Some("cop-7"), fp);
        let first = ex.run(&send("x"), &bind("fp-x")).await.unwrap();
        let again = ex.run(&send("x"), &bind("fp-x")).await.unwrap();
        let other = ex.run(&send("y"), &bind("fp-y")).await.unwrap();
        let sent = count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user'").await;
        if !control {
            assert!(applied(&first));
            assert!(matches!(again, Outcome::Replayed(_)), "{again:?}");
            assert_eq!(other, Outcome::Conflict);
            assert_eq!(sent, 1, "one Sent row and a replay; then a conflict refusal");
        } else {
            assert!(ev.has("control_executed:Q-HM2.client_op_unbound"), "the control ran");
            assert_eq!(sent, 3, "CONTROL FAILED AS DESIGNED: client_op not bound as the key, the repeat posts again (the recorded defect)");
        }
    }
}

// ================================================================ Q-HM3

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm3_the_busy_race_after_commit_is_the_known_residue_and_the_legacy_order_control_notifies_a_refused_command() {
    // the busy race: the node becomes busy AFTER the send commits and before
    // the compaction command starts. Recorded as E-D5's known residue: the
    // notices are committed and the command (P08) would then refuse.
    reset().await;
    let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
    let o = human::human_command(&ex, HumanCommand::new(c(), "/compact", serde_json::json!({})), &operator_binding(None, "fp")).await.unwrap();
    assert!(applied(&o));
    admin_exec(&format!("UPDATE runtime_state SET busy = true WHERE principal_id = '{}'", c())).await;
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE kind = 'context.deep_reach'").await, 2, "RESIDUE (E-D5, N6): the chain was told, as in legacy");
    assert_eq!(count("SELECT count(*) FROM runtime_command_intents WHERE state = 'pending'").await, 1);
    // control: effects committed before the refusal checks (legacy order)
    reset().await;
    admin_exec(&format!("INSERT INTO seat_session_facts (org_id, principal_id, frozen) VALUES ('{}', '{}', true)", org(), c())).await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec!["Q-HM3.effects_before_refusals"]);
    let o = human::human_command(&ex, HumanCommand::new(c(), "/compact", serde_json::json!({})), &operator_binding(None, "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "frozen"), "{o:?}");
    assert!(ev.has("control_executed:Q-HM3.effects_before_refusals"), "the control ran");
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE kind = 'context.deep_reach'").await, 2, "CONTROL FAILED AS DESIGNED: the chain is notified of a refused command");
}

// ================================================================ Q-HM4

async fn q_hm4_run(controls: Vec<&'static str>) -> (i64, i64, Arc<Events>) {
    reset().await;
    // C already holds the user audience, so the send inserts no grant and
    // bumps nothing: the node-row lock and the edge anchors are the only
    // protections under test
    admin_exec(&format!("INSERT INTO audience_grants (org_id, grantee_id, target_kind, target_id, created_at) VALUES ('{}', '{}', 'user', '00000000-0000-0000-0000-000000000000', now())", org(), c())).await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), controls);
    // the send has read C's chain (B, A) and has not committed; the move of C
    // from under B to under D commits in between, if it can
    let (mut arrived, release) = script.hold("h1", "stmt.sent.insert.before");
    let h1 = spawn_human(&ex, c(), "h1");
    arrive(&mut arrived).await;
    let mv = spawn_island(&ex, Island::Move { node: c(), new_parent: Some(d()) }, "mv");
    let move_waited = still_waiting(&mv, 600).await;
    release.add_permits(1);
    assert!(applied(&done(h1).await));
    assert!(applied(&done(mv).await));
    if move_waited {
        assert_eq!(ev.achieved(&["h1", "mv"]), vec!["h1", "mv"]);
    }
    (deep_reach_to(b()).await, deep_reach_to(d()).await, ev)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm4_deep_reach_goes_to_the_chain_at_the_send_commit_in_both_orders() {
    // order 1: the send first; the move waits for it and the old chain is right
    let (to_b, to_d, _) = q_hm4_run(vec![]).await;
    assert_eq!((to_b, to_d), (1, 0), "notified the chain at the send's commit (B, A)");
    // order 2: the move first; the send waits, then reads the new chain
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (mut arrived, release) = script.hold("mv", "before_commit");
    let mv = spawn_island(&ex, Island::Move { node: c(), new_parent: Some(d()) }, "mv");
    arrive(&mut arrived).await;
    let h1 = spawn_human(&ex, c(), "h1");
    assert!(still_waiting(&h1, 600).await, "the send waits for the move");
    release.add_permits(1);
    assert!(applied(&done(mv).await));
    assert!(applied(&done(h1).await));
    assert_eq!((deep_reach_to(b()).await, deep_reach_to(d()).await), (0, 1), "notified the chain at the send's commit (D, A)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm4_edge_anchors_alone_removed_still_pass_because_the_node_row_orders_them() {
    let (to_b, to_d, ev) = q_hm4_run(vec!["Q-HM4.chain_unanchored_only"]).await;
    assert!(ev.has("control_executed:Q-HM4.chain_unanchored_only"), "the variant ran");
    assert_eq!((to_b, to_d), (1, 0), "FINDING: removing only the edge anchors is NOT a control (N4's node-row lock orders the move after the send)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_hm4_control_chain_and_node_unanchored_notifies_a_former_ancestor() {
    let (to_b, _to_d, ev) = q_hm4_run(vec!["Q-HM4.chain_unanchored"]).await;
    assert!(ev.has("control_executed:Q-HM4.chain_unanchored"), "the control ran");
    let moved_first = ev.achieved(&["h1", "mv"]) == vec!["mv", "h1"];
    assert!(moved_first && to_b == 1, "CONTROL FAILED AS DESIGNED: the move committed first, yet the former ancestor B was notified (order {:?}, to_b {to_b})", ev.achieved(&["h1", "mv"]));
}

// ================================================================ Q-IB1 / Q-IB2

async fn unread_to_user(ex: &Ex, n: usize) -> Vec<Uuid> {
    let mut ids = Vec::new();
    for i in 0..n {
        let m = new_id();
        let k = format!("u{i}-{m}");
        ex.run(&agent_send(Target::User, m, MailClass::Message), &agent_binding(a(), &k, &k)).await.unwrap();
        assert!(matches!(receive::deliver(ex, org(), user_mb(), m).await.unwrap(), Delivery::Done(_)));
        ids.push(m);
    }
    ids
}

fn spawn_mark(ex: &Ex, ids: Vec<Uuid>, key: &'static str) -> tokio::task::JoinHandle<Outcome<i64>> {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&MarkRead { ids }, &operator_binding(Some(key), key)).await.unwrap() })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_ib1_overlapping_marks_mark_each_message_once_and_never_block_a_receive() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let m = unread_to_user(&ex, 3).await;
    let (mut arrived, release) = script.hold("k1", "before_commit");
    let k1 = spawn_mark(&ex, vec![m[0], m[1]], "k1");
    arrive(&mut arrived).await;
    let k2 = spawn_mark(&ex, vec![m[1], m[2]], "k2");
    assert!(still_waiting(&k2, 500).await, "the overlapping mark waits on the shared row");
    // a receive into the user mailbox never waits on a mark
    let fresh = unread_to_user(&ex, 1).await;
    release.add_permits(1);
    let (o1, o2) = (done(k1).await, done(k2).await);
    assert_eq!((human::read_count(&o1), human::read_count(&o2)), (2, 1), "each message marked once; the answers sum to the rows marked");
    assert_eq!(count("SELECT count(*) FROM mailbox_messages WHERE state = 'read'").await, 3);
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{}'", fresh[0])).await, "pending");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_ib1_control_rewriting_the_unread_list_loses_a_concurrent_receive() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-IB1.rewrite_unread_list"]);
    let m = unread_to_user(&ex, 2).await;
    let (mut arrived, release) = script.hold("k1", "after_unread_list");
    let k1 = spawn_mark(&ex, vec![m[0]], "k1");
    arrive(&mut arrived).await;
    let fresh = unread_to_user(&ex, 1).await;
    release.add_permits(1);
    done(k1).await;
    assert!(ev.has("control_executed:Q-IB1.rewrite_unread_list"), "the control ran");
    assert_eq!(count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{}'", fresh[0])).await, 0, "CONTROL FAILED AS DESIGNED: the concurrent receive is lost");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_ib2_a_mark_of_unknown_ids_commits_nothing_and_the_control_commits_a_group() {
    for control in [false, true] {
        reset().await;
        let controls = if control { vec!["Q-IB2.commit_empty_mark"] } else { vec![] };
        let (ex, ev) = shared(Arc::new(Script::default()), controls);
        unread_to_user(&ex, 1).await;
        let before = count("SELECT count(*) FROM operation_receipts").await;
        let o = ex.run(&MarkRead { ids: vec![new_id(), new_id()] }, &operator_binding(Some("k-unknown"), "k")).await.unwrap();
        assert_eq!(human::read_count(&o), 0);
        let after = count("SELECT count(*) FROM operation_receipts").await;
        if !control {
            assert_eq!(after, before, "nothing committed, so no feed group (E-D6)");
        } else {
            assert!(ev.has("control_executed:Q-IB2.commit_empty_mark"), "the control ran");
            assert_eq!(after, before + 1, "CONTROL FAILED AS DESIGNED: the empty mark committed a (published) group");
        }
    }
}

// ================================================================ Q-IB3

async fn q_ib3_run(controls: Vec<&'static str>, hold_at: &str) -> (inbox::NodeInboxView, Vec<Uuid>, Arc<Events>) {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), controls);
    let mut ids = Vec::new();
    for _ in 0..2 {
        let m = new_id();
        ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), &m.to_string(), "fp")).await.unwrap();
        receive::deliver(&ex, org(), mb(b()), m).await.unwrap();
        ids.push(m);
    }
    let (mut arrived, release) = script.hold_named(hold_at);
    let ex2 = ex.clone();
    let reader = tokio::spawn(async move { inbox::node_inbox(&ex2, org(), b()).await.unwrap() });
    arrive(&mut arrived).await;
    // while the read is paused: a turn claims and confirms the pending mail,
    // and a new message is received
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, runtime::Turn::Ran { .. }), "{t:?}");
    let m3 = new_id();
    ex.run(&agent_send(Target::Agent { principal: b() }, m3, MailClass::Message), &agent_binding(a(), &m3.to_string(), "fp")).await.unwrap();
    receive::deliver(&ex, org(), mb(b()), m3).await.unwrap();
    release.add_permits(1);
    let v = done(reader).await;
    (v, ids, ev)
}

fn lists_containing(v: &inbox::NodeInboxView, id: Uuid) -> usize {
    [&v.pending, &v.in_flight, &v.delivered].iter().filter(|l| l.iter().any(|r| r.id == id)).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_ib3_a_node_inbox_read_racing_receives_and_confirmations_shows_each_message_in_exactly_one_list() {
    let (v, ids, _) = q_ib3_run(vec![], "mail.inbox.node_inbox.before_emit").await;
    for id in ids {
        assert_eq!(lists_containing(&v, id), 1, "{id} must be in exactly one of pending, in flight, delivered: {v:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_ib3_control_separate_snapshots_show_a_message_twice_or_not_at_all() {
    let (v, ids, ev) = q_ib3_run(vec!["Q-IB3.separate_snapshots"], "mail.inbox.node_inbox_in_flight.begin").await;
    assert!(ev.has("control_executed:Q-IB3.separate_snapshots"), "the control ran");
    let wrong: Vec<usize> = ids.iter().map(|id| lists_containing(&v, *id)).collect();
    assert!(wrong.iter().any(|n| *n != 1), "CONTROL FAILED AS DESIGNED: a message shown in more or fewer than one list across separate snapshots: {wrong:?}");
}

// ================================================================ Q-C7 (b) and (c)

/// P1: X = A sends to (or grants) G = C, deep under P1 = B; B moves from
/// under A to under E, so A stops being C's ancestor.
async fn q_c7_run(use_tool: bool, send_first_in_snapshot: bool, controls: Vec<&'static str>) -> (i64, Arc<Events>) {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), controls);
    let ex2 = ex.clone();
    let spawn_writer = move || {
        let ex2 = ex2.clone();
        tokio::spawn(async move {
            if use_tool {
                ex2.run(&Audience { grantee: c(), revoke: false }, &agent_binding(a(), "w", "w")).await.unwrap().name().to_string()
            } else {
                ex2.run(&agent_send(Target::Agent { principal: c() }, new_id(), MailClass::Message), &agent_binding(a(), "w", "w")).await.unwrap().name().to_string()
            }
        })
    };
    if send_first_in_snapshot {
        // the writer commits after the move's snapshot, before the move locks
        let (mut arrived, release) = script.hold("mv", "stmt.island.children.after");
        let mv = spawn_island(&ex, Island::Move { node: b(), new_parent: Some(e()) }, "mv");
        arrive(&mut arrived).await;
        done(spawn_writer()).await;
        release.add_permits(1);
        assert!(applied(&done(mv).await));
    } else {
        // the move holds its locks; the writer waits, then sees the new chain
        let (mut arrived, release) = script.hold("mv", "before_commit");
        let mv = spawn_island(&ex, Island::Move { node: b(), new_parent: Some(e()) }, "mv");
        arrive(&mut arrived).await;
        let w = spawn_writer();
        assert!(still_waiting(&w, 500).await, "the grant writer waits for the move");
        release.add_permits(1);
        assert!(applied(&done(mv).await));
        done(w).await;
    }
    let survivors = count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'agent' AND anchor_id = '{}'", c(), a())).await;
    (survivors, ev)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c7_b_and_c_no_grant_survives_a_move_in_either_order() {
    for use_tool in [false, true] {
        for first in [true, false] {
            let (survivors, ev) = q_c7_run(use_tool, first, vec![]).await;
            assert_eq!(survivors, 0, "tool={use_tool} writer_in_move_snapshot={first}: no (C, A) grant survives once A is not C's ancestor");
            if first {
                assert!(ev.has("retry:serialization_failure:40001"), "the move's FOR SHARE on C's bumped epoch raised 40001 and its retry swept the grant");
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c7_b_and_c_control_skipping_the_epoch_bump_leaves_a_grant_after_the_move() {
    for use_tool in [false, true] {
        let (survivors, ev) = q_c7_run(use_tool, true, vec!["Q-C7.skip_epoch_bump"]).await;
        assert!(ev.has("control_executed:Q-C7.skip_epoch_bump"), "tool={use_tool}: the control ran");
        assert_eq!(survivors, 1, "tool={use_tool}: CONTROL FAILED AS DESIGNED: the (C, A) grant survives the move");
    }
}
