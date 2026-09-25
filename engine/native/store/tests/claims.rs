//! r7 C5 output-claim registry (CONTRACT-M1 §6). Pure, in memory.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use orgtree_store::claims::{ClaimRegistry, Restriction, Withheld};
use orgtree_store::Uuid;

fn u(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

fn only(org: Uuid, p: Uuid) -> Restriction {
    Restriction { id: Uuid::new_v4(), org, principals: Some(HashSet::from([p])) }
}

#[tokio::test]
async fn an_unrestricted_claim_emits() {
    let reg = ClaimRegistry::new();
    let h = reg.register(u(1), u(10), 1);
    h.narrow("chart ancestor of T");
    assert_eq!(h.emit(|| async { 42 }).await, Ok(42));
    assert_eq!(reg.live(), 0, "released after emit");
}

#[tokio::test]
async fn a_restriction_before_emit_withholds_the_answer() {
    let reg = ClaimRegistry::new();
    let h = reg.register(u(1), u(10), 1);
    assert_eq!(reg.restrict(&only(u(1), u(10))).await, 1);
    let sent = AtomicBool::new(false);
    assert_eq!(h.emit(|| async { sent.store(true, Ordering::SeqCst) }).await, Err(Withheld));
    assert!(!sent.load(Ordering::SeqCst), "nothing was sent after the restriction");
}

#[tokio::test]
async fn restrictions_match_by_org_and_principal() {
    let reg = ClaimRegistry::new();
    let mine = reg.register(u(1), u(10), 1);
    let other_principal = reg.register(u(1), u(11), 1);
    let other_org = reg.register(u(2), u(10), 1);
    assert_eq!(reg.restrict(&only(u(1), u(10))).await, 1);
    assert!(mine.is_revoked());
    assert!(!other_principal.is_revoked());
    assert!(!other_org.is_revoked());
    // coarse fallback: every claim in the org
    assert_eq!(reg.restrict(&Restriction { id: Uuid::new_v4(), org: u(1), principals: None }).await, 1);
    assert!(other_principal.is_revoked());
    assert!(!other_org.is_revoked());
}

/// Effective waits for an answer already emitting, and does not revoke it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restrict_waits_for_an_emitting_claim() {
    let reg = ClaimRegistry::new();
    let h = reg.register(u(1), u(10), 1);
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let emitting = tokio::spawn(async move {
        h.emit(|| async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            "sent"
        })
        .await
    });
    entered_rx.await.unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let d2 = done.clone();
    let reg2 = reg.clone();
    let restricting = tokio::spawn(async move {
        let n = reg2.restrict(&only(u(1), u(10))).await;
        d2.store(true, Ordering::SeqCst);
        n
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!done.load(Ordering::SeqCst), "Effective must wait for the emitting claim");
    release_tx.send(()).unwrap();
    assert_eq!(emitting.await.unwrap(), Ok("sent"));
    assert_eq!(restricting.await.unwrap(), 0, "an emitting claim is finished, not revoked");
    assert!(done.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_dropped_claim_is_released() {
    let reg = ClaimRegistry::new();
    {
        let _h = reg.register(u(1), u(10), 1);
        assert_eq!(reg.live(), 1);
    }
    assert_eq!(reg.live(), 0);
    // and a restriction does not wait for it
    assert_eq!(tokio::time::timeout(Duration::from_millis(50), reg.restrict(&only(u(1), u(10)))).await, Ok(0));
}
