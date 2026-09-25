//! WS3b's one targeted race test (lean plan, lead 2026-09-25 15:33Z):
//! **halt during a turn.** A halt that commits while a turn of the seat is
//! being admitted or is running must not let that turn start new work after
//! the halt. "New work" is WS5's runtime claim taking an input batch
//! (`runtime::admit::ClaimInput`); admission is `runtime::admit::Admit`.
//!
//! Forced interleavings (each order, recorded):
//! (a) the halt commits after the turn's capture and before its admission;
//! (b) the admission holds the seat's epoch row (`FOR SHARE`, paused after
//!     its recheck) and the halt waits behind it;
//! (c) the turn is admitted and a ClaimInput holds the claim row; the halt
//!     waits, the in-flight batch (begun before the halt) commits, and the
//!     turn's NEXT ClaimInput is refused.
//! The halt is `lifecycle::outside::Outside(Halt)` (READ COMMITTED), whose
//! turn fence moves the seat's admitted claims to `settling` in its own
//! transaction.
#![cfg(feature = "qualification")]

mod common_ws3b;

use std::sync::Arc;
use std::time::Duration;

use common_ws3b::*;
use orgtree_store::lifecycle::outside::{Outside, OutsideKind};
use orgtree_store::runtime::admit::{Admission, Admit, Capture, ClaimInput, Vector};
use orgtree_store::sent::MailClass;
use orgtree_store::{Outcome, Uuid};

async fn done<T>(h: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), h).await.expect("operation did not finish").unwrap()
}

async fn capture(ex: &Ex, seat: Uuid) -> Vector {
    ex.read(&Capture { org: org(), seat, hold: None }, org(), None).await.unwrap().expect("capture")
}

async fn mail_to(ex: &Ex, seat: Uuid) -> Uuid {
    let m = new_id();
    let o = ex.run(&agent_send(Target::Agent { principal: seat }, m, MailClass::Message), &agent_binding(a(), &m.to_string(), "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    m
}

fn halt(seat: Uuid) -> Outside {
    Outside(OutsideKind::Halt { node: seat })
}

async fn admitted_claims(seat: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM runtime_claims WHERE principal_id = '{seat}' AND state = 'admitted'")).await
}

async fn batches(seat: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM mail_input_batches WHERE principal_id = '{seat}'")).await
}

/// A turn = capture, then admit (recapturing on a stale vector, bounded).
async fn admit(ex: &Ex, seat: Uuid, key: &str) -> Outcome<Admission> {
    for i in 0..4 {
        let v = capture(ex, seat).await;
        let o = ex.run(&Admit { vector: v, turn_id: new_id() }, &system_binding(&format!("{key}-{i}"))).await.unwrap();
        match &o {
            Outcome::Refused(r) if r.code == "recapture" => continue,
            _ => return o,
        }
    }
    panic!("admission never settled")
}

// ================================================================ (a)

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_halt_committed_between_capture_and_admission_refuses_the_turn() {
    reset().await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec![]);
    mail_to(&ex, c()).await;
    let stale = capture(&ex, c()).await;
    assert!(!stale.halted);
    let h = ex.run(&halt(c()), &system_binding("halt")).await.unwrap();
    assert!(matches!(h, Outcome::Applied(n) if n >= 1), "{h:?}");
    let o = ex.run(&Admit { vector: stale, turn_id: new_id() }, &system_binding("adm-stale")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "recapture"), "the stale vector is refused: {o:?}");
    let o = admit(&ex, c(), "adm").await;
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_admissible"), "the recaptured vector shows the halt: {o:?}");
    assert_eq!(admitted_claims(c()).await, 0);
    assert_eq!(batches(c()).await, 0, "no work started after the halt");
    assert_eq!(ev.achieved(&["halt", "adm-stale"]), vec!["halt"], "achieved: the halt committed, the stale admission did not");
}

// ================================================================ (b)

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn b_a_halt_waiting_behind_an_admission_stops_the_admitted_turn_from_new_work() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    mail_to(&ex, c()).await;
    let v = capture(&ex, c()).await;
    let (mut arrived, release) = script.hold("adm", "after_recheck");
    let ex2 = ex.clone();
    let adm = tokio::spawn(async move { ex2.run(&Admit { vector: v, turn_id: new_id() }, &system_binding("adm")).await.unwrap() });
    arrive(&mut arrived).await;
    let ex3 = ex.clone();
    let h = tokio::spawn(async move { ex3.run(&halt(c()), &system_binding("halt")).await.unwrap() });
    assert!(still_waiting(&h, 600).await, "the halt waits on the epoch row the admission holds FOR SHARE");
    release.add_permits(1);
    let Outcome::Applied(Admission::Admitted { claim_id, .. }) = done(adm).await else { panic!("the admission committed first") };
    assert!(matches!(done(h).await, Outcome::Applied(_)));
    assert_eq!(ev.achieved(&["adm", "halt"]), vec!["adm", "halt"], "achieved order: admission, then halt");
    // the admitted turn now tries to start work
    let o = ex.run(&ClaimInput { seat: c(), claim_id }, &system_binding("input")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "no_admitted_claim"), "no new work after the halt: {o:?}");
    assert_eq!(batches(c()).await, 0);
    assert_eq!(text(&format!("SELECT state FROM runtime_claims WHERE claim_id = '{claim_id}'")).await, "settling");
}

// ================================================================ (c)

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn c_a_halt_during_a_running_turn_lets_begun_work_finish_and_refuses_the_next() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec![]);
    mail_to(&ex, c()).await;
    let Outcome::Applied(Admission::Admitted { claim_id, .. }) = admit(&ex, c(), "adm").await else { panic!("admitted") };
    let (mut arrived, release) = script.hold("input1", "stmt.input.claim_row.after");
    let ex2 = ex.clone();
    let inp = tokio::spawn(async move { ex2.run(&ClaimInput { seat: c(), claim_id }, &system_binding("input1")).await.unwrap() });
    arrive(&mut arrived).await;
    let ex3 = ex.clone();
    let h = tokio::spawn(async move { ex3.run(&halt(c()), &system_binding("halt")).await.unwrap() });
    assert!(still_waiting(&h, 600).await, "the halt's turn fence waits on the claim row the in-flight input holds");
    release.add_permits(1);
    assert!(matches!(done(inp).await, Outcome::Applied(Some(_))), "the batch begun before the halt commits");
    assert!(matches!(done(h).await, Outcome::Applied(_)));
    assert_eq!(ev.achieved(&["input1", "halt"]), vec!["input1", "halt"]);
    mail_to(&ex, c()).await;
    let o = ex.run(&ClaimInput { seat: c(), claim_id }, &system_binding("input2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "no_admitted_claim"), "the turn's next work is refused: {o:?}");
    assert_eq!(batches(c()).await, 1, "exactly the batch begun before the halt");
}

// ================================================================ unhalt

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn unhalt_starts_nothing_and_a_new_turn_is_admitted_afterwards() {
    reset().await;
    let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
    mail_to(&ex, c()).await;
    let Outcome::Applied(Admission::Admitted { claim_id, .. }) = admit(&ex, c(), "adm").await else { panic!("admitted") };
    ex.run(&halt(c()), &system_binding("halt")).await.unwrap();
    ex.run(&Outside(OutsideKind::Unhalt { node: c() }), &system_binding("unhalt")).await.unwrap();
    assert_eq!(text(&format!("SELECT state FROM runtime_claims WHERE claim_id = '{claim_id}'")).await, "settling", "unhalt revives no claim (I10)");
    assert_eq!(batches(c()).await, 0);
}
