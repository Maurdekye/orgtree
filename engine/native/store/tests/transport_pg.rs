//! The outside-send transport executor with the FAKE transport (the P03 E
//! endpoint) on a real PostgreSQL: the captured send is dispatched as
//! captured (no holder re-read, no reroute), under a fenced dispatch claim,
//! with no transaction open during the (fake) network send.
#![cfg(feature = "qualification")]

mod common_pg;

use common_pg::*;
use orgtree_store::mail::transport::{self, ClaimDispatch, FakeTransport, Sent, SettleDispatch};
use orgtree_store::mail::receive::receiver_binding;
use orgtree_store::sent::MailClass;
use orgtree_store::Outcome;

fn outside(key: &str) -> (AgentSend, orgtree_store::Binding) {
    let m = new_id();
    (agent_send(Target::External { handle: "@net:peer".into() }, m, MailClass::Message), agent_binding(a(), key, key))
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn an_outside_send_is_dispatched_as_captured_even_after_the_holder_changes() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (cmd, b) = outside("x1");
    let m = cmd.message_id;
    assert!(matches!(ex.run(&cmd, &b).await.unwrap(), Outcome::Applied(_)));
    // E takes the org-inbox audience over (single-holder): A is no longer a holder
    let o = ex.run(&agent_send(Target::External { handle: "@net:other".into() }, new_id(), MailClass::Message), &agent_binding(e(), "x2", "x2")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)));
    assert_eq!(uuid_of("SELECT grantee_id FROM audience_grants WHERE target_kind = 'extern'").await, e());
    let fake = FakeTransport::default();
    let mut sent = Vec::new();
    while let Some(d) = transport::dispatch_one(&ex, org(), &fake, 30_000).await.unwrap() {
        assert!(d.settled);
        sent.push(d.claimed.message_id);
    }
    assert!(sent.contains(&m), "A's committed send still goes out with its captured destination and authority");
    let log = fake.log.lock().unwrap().clone();
    assert!(log.iter().any(|(h, id, body)| h == "@net:peer" && *id == m && body == "hello"), "{log:?}");
    assert_eq!(count("SELECT count(*) FROM transport_intents WHERE stage = 'sent'").await, 2);
}

#[tokio::test]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_stale_dispatch_claim_is_fenced_and_transient_failures_retry() {
    reset().await;
    let (ex, _ev) = executor(vec![]);
    let (cmd, b) = outside("f1");
    ex.run(&cmd, &b).await.unwrap();
    // claimer 1's lease expires at once (0 ms); claimer 2 re-claims the same intent
    let c1 = match ex.run(&ClaimDispatch { lease_ms: 0 }, &receiver_binding(org(), "c1")).await.unwrap() {
        Outcome::Applied(Some(c)) => c,
        o => panic!("{o:?}"),
    };
    let c2 = match ex.run(&ClaimDispatch { lease_ms: 60_000 }, &receiver_binding(org(), "c2")).await.unwrap() {
        Outcome::Applied(Some(c)) => c,
        o => panic!("{o:?}"),
    };
    assert_eq!(c1.intent_id, c2.intent_id);
    assert_ne!(c1.token, c2.token);
    let s1 = SettleDispatch { intent_id: c1.intent_id, token: c1.token, sent: Sent::Acked { remote_id: "late".into() }, backoff_ms: 0 };
    assert_eq!(ex.run(&s1, &receiver_binding(org(), "s1")).await.unwrap(), Outcome::Applied(false), "the stale claimer is fenced out");
    let s2 = SettleDispatch { intent_id: c2.intent_id, token: c2.token, sent: Sent::Retry { reason: "transient".into() }, backoff_ms: 0 };
    assert_eq!(ex.run(&s2, &receiver_binding(org(), "s2")).await.unwrap(), Outcome::Applied(true));
    assert_eq!(text("SELECT stage FROM transport_intents").await, "pending", "a transient failure stays pending");
    // the next dispatch: the connection dies mid-send
    let fake = FakeTransport::default();
    fake.script.lock().unwrap().push(Sent::Uncertain);
    let d = transport::dispatch_one(&ex, org(), &fake, 60_000).await.unwrap().expect("re-dispatched");
    assert!(d.settled);
    assert_eq!(text("SELECT stage FROM transport_intents").await, "uncertain", "an uncertain outcome is recorded, never claimed as sent");
    assert_eq!(count("SELECT attempts::bigint FROM transport_intents").await, 3);
}
