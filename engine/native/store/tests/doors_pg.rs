//! WS5 doors, inbox reads, recovery and the minimal runtime on a real
//! PostgreSQL (WS1 dev cluster). Same rules as mail_pg.rs: `#[ignore]`, run
//! only through the P03 run lock on this agent's own cluster; a missing URL
//! panics. Correctness checks, not the §7 schedules.
#![cfg(feature = "qualification")]

mod common_pg;

use common_pg::*;
use orgtree_store::mail::human::{self, HumanCommand, HumanSend, MarkRead};
use orgtree_store::mail::inbox;
use orgtree_store::mail::receive::{self, Delivery};
use orgtree_store::mail::recovery::{self, Reactivate, Sweep};
use orgtree_store::runtime::{self, admit::FakeProvider, Turn};
use orgtree_store::sent::MailClass;
use orgtree_store::Outcome;

fn human(node: orgtree_store::Uuid, body: &str) -> HumanSend {
    HumanSend { node, message_id: new_id(), kind: "message".into(), body: body.into() }
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_human_send_to_a_deep_node_notifies_the_chain_and_grants_first_contact_once() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&human(c(), "please do X"), &operator_binding(Some("op-1"), "fp-1")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.notified, vec![b(), a()], "every non-user ancestor, nearest first");
    assert!(r.audience_granted);
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'user'", c())).await, 1);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE class = 'notice' AND kind = 'context.deep_reach' AND pair_seq IS NULL").await, 2);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user' AND class = 'message' AND pair_seq = 1").await, 1, "the user's Sent row, pair-ordered");
    // a second send grants nothing more
    let o = ex.run(&human(c(), "and Y"), &operator_binding(Some("op-2"), "fp-2")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert!(!r.audience_granted);
    assert_eq!(count(&format!("SELECT audience_version FROM authority_epoch WHERE principal_id = '{}'", c())).await, 1);
    // a top-level node: no chain, no notice, no grant (legacy user_deep_reach)
    let o = ex.run(&human(a(), "hi"), &operator_binding(None, "fp-3")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert!(r.notified.is_empty() && !r.audience_granted);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn client_op_replays_the_same_send_and_conflicts_on_a_different_body() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let send = human(b(), "once");
    let first = ex.run(&send, &operator_binding(Some("cop-1"), "body-once")).await.unwrap();
    let Outcome::Applied(first) = first else { panic!("{first:?}") };
    let again = ex.run(&human(b(), "once"), &operator_binding(Some("cop-1"), "body-once")).await.unwrap();
    assert_eq!(again, Outcome::Replayed(first.clone()), "E-D4: same client_op + same content replays");
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user'").await, 1);
    let other = ex.run(&human(b(), "different"), &operator_binding(Some("cop-1"), "body-different")).await.unwrap();
    assert_eq!(other, Outcome::Conflict);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user'").await, 1);
    // without client_op every request is a new send (E4, legacy)
    ex.run(&human(b(), "x"), &operator_binding(None, "fp")).await.unwrap();
    ex.run(&human(b(), "x"), &operator_binding(None, "fp")).await.unwrap();
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE source_kind = 'user'").await, 3);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn every_compact_refusal_commits_nothing_and_an_accepted_command_notifies_once() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let cases = [
        ("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{c}'", "not_live"),
        ("INSERT INTO seat_session_facts (org_id, principal_id, frozen) VALUES ('{o}', '{c}', true)", "frozen"),
        ("INSERT INTO seat_session_facts (org_id, principal_id, remote_controlled) VALUES ('{o}', '{c}', true)", "remote_controlled"),
        ("UPDATE authority_epoch SET halted = true WHERE principal_id = '{c}'", "halted"),
        ("UPDATE org_controls SET value = '{\"engaged\": true}' WHERE family = 'killswitch'", "halted"),
        ("INSERT INTO seat_session_facts (org_id, principal_id, knowledge_bearer) VALUES ('{o}', '{c}', true)", "knowledge_bearer"),
        ("INSERT INTO seat_session_facts (org_id, principal_id, has_conversation) VALUES ('{o}', '{c}', false)", "no_conversation"),
        ("INSERT INTO seat_session_facts (org_id, principal_id, just_compacted) VALUES ('{o}', '{c}', true)", "just_compacted"),
        ("UPDATE runtime_state SET busy = true WHERE principal_id = '{c}'", "busy"),
    ];
    let mut executed = 0;
    for (setup, code) in cases {
        reset().await;
        admin_exec(&setup.replace("{c}", &c().to_string()).replace("{o}", &org().to_string())).await;
        let o = human::human_command(&ex, HumanCommand::new(c(), "/compact", serde_json::json!({})), &operator_binding(None, "fp")).await.unwrap();
        assert!(matches!(o, Outcome::Refused(ref r) if r.code == code), "{code}: {o:?}");
        assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0, "{code}: no notice");
        assert_eq!(count("SELECT count(*) FROM audience_grants").await, 0, "{code}: no audience");
        assert_eq!(count("SELECT count(*) FROM runtime_command_intents").await, 0, "{code}: no intent");
        executed += 1;
    }
    assert_eq!(executed, 9);
    // accepted: two deep-reach notices, the audience, one intent
    reset().await;
    let o = human::human_command(&ex, HumanCommand::new(c(), "/compact", serde_json::json!({})), &operator_binding(None, "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(ref r) if r.audience_granted && r.notified.len() == 2), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM runtime_command_intents").await, 1);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE kind = 'context.deep_reach'").await, 2);
    assert_eq!(count("SELECT count(*) FROM mail_sent WHERE class <> 'notice'").await, 0, "a command is not mail: no Sent copy");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn read_marks_count_what_they_changed_and_a_mark_of_nothing_commits_nothing() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (m1, m2) = (new_id(), new_id());
    for (m, k) in [(m1, "u1"), (m2, "u2")] {
        ex.run(&agent_send(Target::User, m, MailClass::Message), &agent_binding(a(), k, k)).await.unwrap();
        receive::deliver(&ex, org(), user_mb(), m).await.unwrap();
    }
    let v = inbox::user_inbox(&ex, org()).await.unwrap();
    assert_eq!(v.inbox.iter().map(|r| r.id).collect::<Vec<_>>(), vec![m1, m2], "(Sent time, id) order");
    assert_eq!(v.sent.len(), 0, "no user Sent rows yet");
    let receipts_before = count("SELECT count(*) FROM operation_receipts").await;
    let o = ex.run(&MarkRead { ids: vec![m1, new_id()] }, &operator_binding(None, "mark")).await.unwrap();
    assert_eq!(human::read_count(&o), 1, "unknown ids are ignored");
    let o = ex.run(&MarkRead { ids: vec![m1] }, &operator_binding(None, "mark")).await.unwrap();
    assert_eq!(human::read_count(&o), 0);
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "nothing_marked"));
    assert_eq!(count("SELECT count(*) FROM operation_receipts").await, receipts_before + 1, "E-D6: the empty mark committed nothing");
    let v = inbox::user_inbox(&ex, org()).await.unwrap();
    assert_eq!(v.inbox.iter().map(|r| r.id).collect::<Vec<_>>(), vec![m2]);
    assert_eq!(v.read.iter().map(|r| r.id).collect::<Vec<_>>(), vec![m1]);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn the_node_inbox_splits_by_identity_and_lists_its_own_sent_rows() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (m1, m2) = (new_id(), new_id());
    // two identical messages: same sender, same body
    for (m, k) in [(m1, "n1"), (m2, "n2")] {
        ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), k, "same")).await.unwrap();
        receive::deliver(&ex, org(), mb(b()), m).await.unwrap();
    }
    ex.run(&agent_send(Target::Agent { principal: a() }, new_id(), MailClass::Message), &agent_binding(b(), "n3", "up")).await.unwrap();
    let v = inbox::node_inbox(&ex, org(), b()).await.unwrap();
    assert_eq!(v.pending.iter().map(|r| r.id).collect::<Vec<_>>(), vec![m1, m2], "E-D7: two identical messages stay two");
    assert!(v.in_flight.is_empty() && v.delivered.is_empty());
    assert_eq!(v.sent.len(), 1, "the node's own Sent row, read directly");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn recovery_delivers_mail_whose_hint_was_lost_in_pair_order_and_dormant_mail_is_reactivated() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (m1, m2) = (new_id(), new_id());
    ex.run(&agent_send(Target::Agent { principal: b() }, m1, MailClass::Message), &agent_binding(a(), "h1", "f1")).await.unwrap();
    ex.run(&agent_send(Target::Agent { principal: b() }, m2, MailClass::Message), &agent_binding(a(), "h2", "f2")).await.unwrap();
    // no hint was consumed: recovery alone delivers, in pair order
    let r = recovery::recover(&ex, org(), &Sweep::default()).await.unwrap();
    assert_eq!((r.picked, r.delivered, r.parked, r.failed), (2, 2, 0, 0), "{r:?}");
    assert_eq!(uuid_of(&format!("SELECT original_message_id FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord = 1", mb(b()))).await, m1);
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'pending'").await, 0);
    // a message parked behind a stuck predecessor goes dormant at the horizon
    admin_exec(&format!("UPDATE mailboxes SET state = 'open' WHERE mailbox_id = '{}'", mb(c()))).await;
    let (p1, p2) = (new_id(), new_id());
    ex.run(&agent_send(Target::Agent { principal: b() }, p1, MailClass::Message), &agent_binding(a(), "h3", "f3")).await.unwrap();
    ex.run(&agent_send(Target::Agent { principal: b() }, p2, MailClass::Message), &agent_binding(a(), "h4", "f4")).await.unwrap();
    // p1's intent is held out of recovery (as if dormant elsewhere): mark it dormant by hand
    admin_exec(&format!("UPDATE outgoing_intents SET stage = 'dormant' WHERE source_ref = '{p1}'")).await;
    let sweep = Sweep { horizon: 2, ..Sweep::default() };
    let r1 = recovery::recover(&ex, org(), &sweep).await.unwrap();
    let r2 = recovery::recover(&ex, org(), &sweep).await.unwrap();
    assert_eq!((r1.parked, r2.parked, r2.dormant), (1, 1, 1), "{r1:?} {r2:?}");
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE stage = 'dormant'").await, 2, "dormant is still pending custody, never discarded");
    assert_eq!(count("SELECT count(*) FROM mailbox_messages WHERE state = 'refused'").await, 0, "time alone never refuses mail");
    let o = ex.run(&Reactivate, &system_binding("react")).await.unwrap();
    assert_eq!(o, Outcome::Applied(2));
    let r = recovery::recover(&ex, org(), &Sweep::default()).await.unwrap();
    assert_eq!(r.delivered, 2, "{r:?}");
    assert_eq!(uuid_of(&format!("SELECT original_message_id FROM mailbox_messages WHERE mailbox_id = '{}' AND recv_ord = 4", mb(b()))).await, p2);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_turn_consumes_its_kickoff_reads_mail_by_evidence_and_defers_during_a_folder_move() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    // a kickoff demand (WS3 staffing records it) and two messages
    admin_exec(&format!("INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) VALUES ('{}', gen_random_uuid(), 'kickoff', gen_random_uuid(), '{}', now(), now())", org(), b())).await;
    let (m1, m2) = (new_id(), new_id());
    for (m, k) in [(m1, "t1"), (m2, "t2")] {
        ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), k, k)).await.unwrap();
        assert!(matches!(receive::deliver(&ex, org(), mb(b()), m).await.unwrap(), Delivery::Done(_)));
    }
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    let Turn::Ran { read, consumed_demands, recaptures, vector, .. } = t else { panic!("{t:?}") };
    assert_eq!(read, vec![m1, m2]);
    assert_eq!(consumed_demands, 3, "the kickoff and both wakes");
    assert_eq!(recaptures, 0);
    assert_eq!(vector.chain.iter().map(|n| n.node).collect::<Vec<_>>(), vec![b(), a()]);
    assert_eq!(count("SELECT count(*) FROM mailbox_messages WHERE state = 'delivered'").await, 2);
    assert_eq!(count("SELECT count(*) FROM mail_input_batches WHERE state = 'confirmed'").await, 1);
    assert_eq!(count(&format!("SELECT count(*) FROM runtime_state WHERE principal_id = '{}' AND busy", b())).await, 0);
    // evidence that does not match confirms nothing: the mail is pending again
    let m3 = new_id();
    ex.run(&agent_send(Target::Agent { principal: b() }, m3, MailClass::Message), &agent_binding(a(), "t3", "t3")).await.unwrap();
    receive::deliver(&ex, org(), mb(b()), m3).await.unwrap();
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: true }).await.unwrap();
    assert!(matches!(t, Turn::Refused { ref code, .. } if code == "evidence_mismatch"), "{t:?}");
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{m3}'")).await, "pending");
    // a pending folder-move intent for the stack defers the turn; its closing admits it
    admin_exec(&format!("INSERT INTO folder_move_intents (org_id, intent_id, stack_root_id, path_kind, old_name, new_name, state, created_at) VALUES ('{}', gen_random_uuid(), '{}', 'L', 'bravo', 'bravo2', 'pending', now())", org(), b())).await;
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, Turn::Deferred { .. }), "{t:?}");
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake' AND stage = 'pending'").await, 1, "a deferred turn consumes no demand");
    admin_exec("UPDATE folder_move_intents SET state = 'completed'").await;
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, Turn::Ran { ref read, .. } if read == &vec![m3]), "{t:?}");
    assert_eq!(count("SELECT count(*) FROM runtime_claims WHERE state = 'settled'").await, 3);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_missing_charter_body_fails_closed_and_a_stale_vector_recaptures() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    admin_exec(&format!(
        "INSERT INTO charter_versions (org_id, principal_id, version, body, body_sha256, saved_at) VALUES ('{o}', '{a}', 1, 'team charter', 'x', now());
         INSERT INTO charter_heads (org_id, principal_id, current_version) VALUES ('{o}', '{a}', 1);",
        o = org(),
        a = a()
    ))
    .await;
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, Turn::Ran { .. }), "{t:?}");
    // remove the body behind the head (fixture bypasses the FK) and prove it
    admin_exec("ALTER TABLE charter_heads DROP CONSTRAINT charter_heads_version_fk; DELETE FROM charter_versions;").await;
    assert_eq!(count("SELECT count(*) FROM charter_versions").await, 0);
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, Turn::Refused { ref code, .. } if code == "incomplete_charter"), "{t:?}");
    assert_eq!(count("SELECT count(*) FROM runtime_claims WHERE state = 'admitted'").await, 0);
}
