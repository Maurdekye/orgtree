//! WS5 mail on a real PostgreSQL (WS1 dev cluster), through the executor:
//! the source transaction, the receiver, the ack, the pair gate, dedupe, the
//! human mailbox, the closed-mailbox fence, the notice fold and EXTERN.
//!
//! Every test is `#[ignore]`: run them ONLY through the P03 run lock, with
//! `--features qualification -- --ignored --test-threads=1`, and with
//! `P03_PG_ADMIN_URL` / `P03_PG_RUNTIME_URL` from `devdb.cmd env --agent
//! p03-ws5-mail`. A missing URL PANICS (a skipped DB test must never read as
//! a pass). Each test rebuilds the `public` schema, so it refuses unless the
//! server's data directory is this agent's own disposable cluster.
//!
//! These are correctness checks of the implementation, not the S3 §7
//! schedules (those force interleavings; see `mail_sched_pg.rs`).
#![cfg(feature = "qualification")]

mod common_pg;

use common_pg::*;
use orgtree_store::mail::mailbox;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::sent::MailClass;
use orgtree_store::Outcome;

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_send_to_a_child_is_source_only_then_received_woken_and_acked() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "k1", "fp1")).await.unwrap();
    let Outcome::Applied(res) = o else { panic!("{o:?}") };
    assert_eq!(res.pair_seq, Some(1));
    assert!(res.warnings.is_empty(), "{:?}", res.warnings);
    // Sent: source rows only
    assert_eq!(count(&format!("SELECT count(*) FROM mail_sent WHERE message_id = '{m}'")).await, 1);
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'pending'").await, 1);
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 0, "no receiver row at Sent (v6 I07)");
    assert_eq!(count(&format!("SELECT recv_seq FROM mailboxes WHERE mailbox_id = '{}'", mb(b()))).await, 0, "the source never writes the head");
    assert_eq!(text(&format!("SELECT dest_label FROM mail_sent WHERE message_id = '{m}'")).await, "bravo");
    // Received and acknowledged
    let d = receive::deliver(&ex, org(), mb(b()), m).await.unwrap();
    assert_eq!(d, Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }));
    assert_eq!(count(&format!("SELECT recv_seq FROM mailboxes WHERE mailbox_id = '{}'", mb(b()))).await, 1);
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'settled'").await, 1);
    assert_eq!(count(&format!("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake' AND source_ref = '{m}' AND dest_ref = '{}'", b())).await, 1);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_deep_send_grants_the_reply_audience_once_with_its_bump_and_warning() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let r1 = ex.run(&agent_send(Target::Agent { principal: c() }, new_id(), MailClass::Message), &agent_binding(a(), "d1", "f1")).await.unwrap();
    let Outcome::Applied(r1) = r1 else { panic!("{r1:?}") };
    assert!(r1.warnings.iter().any(|w| w.starts_with("audience granted:")), "{:?}", r1.warnings);
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'agent' AND target_id = '{}' AND anchor_id = '{}'", c(), a(), a())).await, 1);
    assert_eq!(count(&format!("SELECT audience_version FROM authority_epoch WHERE principal_id = '{}'", c())).await, 1);
    // a second explicit send grants nothing more and bumps nothing
    let r2 = ex.run(&agent_send(Target::Agent { principal: c() }, new_id(), MailClass::Passive), &agent_binding(a(), "d2", "f2")).await.unwrap();
    let Outcome::Applied(r2) = r2 else { panic!("{r2:?}") };
    assert!(r2.warnings.is_empty());
    assert_eq!(count("SELECT count(*) FROM audience_grants").await, 1);
    assert_eq!(count(&format!("SELECT audience_version FROM authority_epoch WHERE principal_id = '{}'", c())).await, 1);
    assert_eq!(r2.pair_seq, Some(2), "a passive notice keeps the pair order");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn an_early_pair_member_is_parked_then_received_in_order() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (m1, m2) = (new_id(), new_id());
    ex.run(&agent_send(Target::Agent { principal: b() }, m1, MailClass::Message), &agent_binding(a(), "p1", "f1")).await.unwrap();
    ex.run(&agent_send(Target::Agent { principal: b() }, m2, MailClass::Message), &agent_binding(a(), "p2", "f2")).await.unwrap();
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m2).await.unwrap(), Delivery::Parked);
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 0, "parked commits nothing");
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m1).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }));
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m2).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(2), woke: true, deferred: false }));
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_redelivery_is_a_duplicate_and_regenerates_the_ack() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "r1", "f1")).await.unwrap();
    // receive without the ack (crash between receive and ack)
    let r = receive::Receive { org: org(), mailbox: mb(b()), message: m, human: false };
    ex.run(&r, &r.binding()).await.unwrap();
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'pending'").await, 1);
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m).await.unwrap(), Delivery::Done(Received::Duplicate));
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 1);
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'settled'").await, 1);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn the_human_mailbox_has_no_ordinal_and_notices_arrive_read() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    let o = ex.run(&agent_send(Target::User, m, MailClass::Message), &agent_binding(a(), "u1", "f1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(receive::deliver(&ex, org(), user_mb(), m).await.unwrap(), Delivery::Done(Received::Received { recv_ord: None, woke: false, deferred: false }));
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{m}'")).await, "pending");
    // a system notice to the user arrives already read
    let n = new_id();
    ex.run(&system_notice(Destination::UserMailbox { mailbox: user_mb() }, n, "context.x"), &system_binding("un1")).await.unwrap();
    receive::deliver(&ex, org(), user_mb(), n).await.unwrap();
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{n}'")).await, "read");
    // a non-top-level agent without a user audience is refused, nothing committed
    let o = ex.run(&agent_send(Target::User, new_id(), MailClass::Message), &agent_binding(b(), "u2", "f2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_addressable"), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM operation_receipts WHERE op_key = 'u2'").await, 0);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn unaddressable_and_not_live_senders_commit_nothing() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    // C (under B) may not address A (its grandparent)
    let o = ex.run(&agent_send(Target::Agent { principal: a() }, new_id(), MailClass::Message), &agent_binding(c(), "n1", "f")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_addressable"), "{o:?}");
    // a stale generation is refused at the caller anchor
    let mut bnd = agent_binding(b(), "n2", "f");
    bnd.principal = orgtree_store::Principal::Agent { id: b(), generation: 99 };
    let o = ex.run(&agent_send(Target::Agent { principal: a() }, new_id(), MailClass::Message), &bnd).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "stale_generation"), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0);
    assert_eq!(count("SELECT count(*) FROM operation_receipts").await, 0, "a refusal commits nothing, not even the receipt (E-D5)");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn an_archived_recipient_receives_deferred_without_a_wake() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "ar1", "f")).await.unwrap();
    let Outcome::Applied(res) = o else { panic!("{o:?}") };
    assert!(res.deferred && res.warnings.iter().any(|w| w.contains("NOTHING WILL READ IT")));
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(1), woke: false, deferred: true }));
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake'").await, 0);
    // unrecoverable: refused at the source
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'unrecoverable' WHERE principal_id = '{}'", b())).await;
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, new_id(), MailClass::Message), &agent_binding(a(), "ar2", "f")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "unrecoverable"), "{o:?}");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_closed_mailbox_records_a_refusal_fence_never_a_message() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "c1", "f")).await.unwrap();
    let o = ex.run(&Island::close(b()), &system_binding("close-b")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m).await.unwrap(), Delivery::Done(Received::Refused { reason: "closed".into() }));
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{m}'")).await, "refused");
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'refused'").await, 1);
    // a second delivery of the same original meets the fence again
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m).await.unwrap(), Delivery::Done(Received::Refused { reason: "fenced".into() }));
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn the_fold_makes_one_digest_first_keeps_untyped_in_order_and_tombstones_members() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let mut ids = Vec::new();
    for (i, kind) in ["context.a", "notice", "context.b", "context.a"].iter().enumerate() {
        let n = new_id();
        ex.run(&system_notice(dest_of(b()), n, kind), &system_binding(&format!("fn{i}"))).await.unwrap();
        assert!(matches!(receive::deliver(&ex, org(), mb(b()), n).await.unwrap(), Delivery::Done(Received::Received { woke: false, .. })), "a notice never wakes");
        ids.push(n);
    }
    let o = ex.run(&Island::fold(b()), &system_binding("fold-b")).await.unwrap();
    let Outcome::Applied(folded) = o else { panic!("{o:?}") };
    assert_eq!(folded, 3);
    // order: digest (ord 1), then the untyped notice (ord 2)
    assert_eq!(text("SELECT kind FROM mailbox_messages WHERE state = 'pending' ORDER BY recv_ord LIMIT 1").await, "context.notice_digest");
    assert_eq!(uuid_of("SELECT original_message_id FROM mailbox_messages WHERE state = 'pending' ORDER BY recv_ord OFFSET 1 LIMIT 1").await, ids[1]);
    assert_eq!(count("SELECT count(*) FROM mailbox_messages WHERE state = 'folded'").await, 3);
    assert_eq!(count("SELECT jsonb_array_length(digest->'groups')::bigint FROM mailbox_messages WHERE kind = 'context.notice_digest'").await, 2);
    // a folded member redelivered is still deduped
    assert_eq!(receive::deliver(&ex, org(), mb(b()), ids[0]).await.unwrap(), Delivery::Done(Received::Duplicate));
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn single_holder_extern_leaves_exactly_one_holder() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&agent_send(Target::External { handle: "@net:peer".into() }, new_id(), MailClass::Message), &agent_binding(a(), "x1", "f")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert!(r.warnings.iter().any(|w| w.contains("ORG-INBOX")));
    let o = ex.run(&agent_send(Target::External { handle: "@net:peer".into() }, new_id(), MailClass::Message), &agent_binding(e(), "x2", "f")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM audience_grants WHERE target_kind = 'extern'").await, 1);
    assert_eq!(uuid_of("SELECT grantee_id FROM audience_grants WHERE target_kind = 'extern'").await, e());
    assert_eq!(count("SELECT count(*) FROM transport_intents").await, 2);
    assert_eq!(count(&format!("SELECT count(*) FROM mail_sent WHERE class = 'notice' AND dest_principal_id = '{}'", a())).await, 1, "the replaced holder is told");
    // a non-top-level agent without EXTERN is refused
    let o = ex.run(&agent_send(Target::External { handle: "@net:peer".into() }, new_id(), MailClass::Message), &agent_binding(b(), "x3", "f")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_extern_holder"), "{o:?}");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_retraction_cancels_before_receipt_and_retracts_a_pending_message() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (m1, m2) = (new_id(), new_id());
    ex.run(&agent_send(Target::Agent { principal: b() }, m1, MailClass::Message), &agent_binding(a(), "rt1", "f")).await.unwrap();
    ex.run(&agent_send(Target::Agent { principal: b() }, m2, MailClass::Message), &agent_binding(a(), "rt2", "f")).await.unwrap();
    // m1 retracted before its receipt: a cancelled fence, and m2 is no longer parked behind it
    assert_eq!(receive::retract(&ex, org(), mb(b()), m1).await.unwrap(), Some(receive::Retracted::Cancelled));
    assert_eq!(receive::deliver(&ex, org(), mb(b()), m1).await.unwrap(), Delivery::Done(Received::Refused { reason: "cancelled".into() }));
    assert!(matches!(receive::deliver(&ex, org(), mb(b()), m2).await.unwrap(), Delivery::Done(Received::Received { .. })));
    assert_eq!(receive::retract(&ex, org(), mb(b()), m2).await.unwrap(), Some(receive::Retracted::Retracted));
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{m2}'")).await, "retracted");
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn rehire_drive_records_one_wake_per_pending_message() {
    reset().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
    let (ex, _ev) = executor(vec![]);
    let m = new_id();
    ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "rh1", "f")).await.unwrap();
    receive::deliver(&ex, org(), mb(b()), m).await.unwrap();
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake'").await, 0);
    let o = ex.run(&Island::drive(b()), &system_binding("drive-1")).await.unwrap();
    assert_eq!(o, Outcome::Applied(1));
    let o = ex.run(&Island::drive(b()), &system_binding("drive-2")).await.unwrap();
    assert_eq!(o, Outcome::Applied(0), "a message is driven exactly once");
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake'").await, 1);
    let _ = mailbox::CONTROLS;
}
