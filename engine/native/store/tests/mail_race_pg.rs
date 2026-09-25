//! The two targeted mail race tests kept by the P03 lean plan (lead, 15:33Z):
//! (1) a duplicate delivery racing the first one delivers the message ONCE;
//! (2) a send or a receive whose COMMIT reply is lost reaches ONE outcome
//! through its receipt on retry (no second Sent row, no second message row).
//!
//! Run ONLY through the P03 run lock (`run-pg.ps1 -Test mail_race_pg`).
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common_pg::*;
use orgtree_store::conn::{Factory, PgConfig};
use orgtree_store::hooks::Hooks;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::sent::MailClass;
use orgtree_store::{ExecConfig, Executor, Outcome, Uuid};

fn rows_of(m: Uuid) -> String {
    format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id = '{m}'")
}

fn head_of(agent: Uuid) -> String {
    format!("SELECT recv_seq FROM mailboxes WHERE mailbox_id = '{}'", mb(agent))
}

// ================================================================ (1)

/// Two deliveries of the same message race: the first is held at
/// `before_commit` holding the head; the second must WAIT on the head (not
/// insert beside it), then find the first's row and settle as a duplicate.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_duplicate_delivery_racing_the_first_delivers_the_message_once() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let m = new_id();
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "dup1", "dup1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    let (mut arrived, release) = script.hold_named("mail.receive.deliver_agent.before_commit");
    let (e1, e2) = (ex.clone(), ex.clone());
    let first = tokio::spawn(async move { receive::deliver(&e1, org(), mb(b()), m).await.unwrap() });
    arrive(&mut arrived).await;
    let second = tokio::spawn(async move { receive::deliver(&e2, org(), mb(b()), m).await.unwrap() });
    assert!(still_waiting(&second, 500).await, "the duplicate delivery waits on the mailbox head while the first holds it");
    release.add_permits(1);
    let r1 = tokio::time::timeout(Duration::from_secs(20), first).await.expect("first delivery finished").unwrap();
    let r2 = tokio::time::timeout(Duration::from_secs(20), second).await.expect("second delivery finished").unwrap();
    assert!(matches!(r1, Delivery::Done(Received::Received { recv_ord: Some(1), .. })), "{r1:?}");
    assert_eq!(r2, Delivery::Done(Received::Duplicate));
    assert_eq!(count(&rows_of(m)).await, 1, "one message row");
    assert_eq!(count(&head_of(b())).await, 1, "the head advanced once");
    assert_eq!(count(&format!("SELECT count(*) FROM outgoing_intents WHERE kind = 'wake' AND source_ref = '{m}'")).await, 1, "one wake");
    assert_eq!(count("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND stage = 'settled'").await, 1);
}

// ================================================================ (2)

/// A loopback proxy that forwards the client's COMMIT to the server, then
/// cuts both sockets before the server's reply returns (the ambiguous case).
struct CutAfterCommit {
    port: u16,
    armed: Arc<AtomicBool>,
    cuts: Arc<AtomicUsize>,
}

async fn proxy(upstream_port: u16) -> CutAfterCommit {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = l.local_addr().unwrap().port();
    let armed = Arc::new(AtomicBool::new(false));
    let cuts = Arc::new(AtomicUsize::new(0));
    let (a2, c2) = (armed.clone(), cuts.clone());
    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = l.accept().await else { return };
            let (armed, cuts) = (a2.clone(), c2.clone());
            tokio::spawn(async move {
                let Ok(server) = tokio::net::TcpStream::connect(("127.0.0.1", upstream_port)).await else { return };
                let (mut cr, mut cw) = client.into_split();
                let (mut sr, mut sw) = server.into_split();
                let cut = Arc::new(tokio::sync::Notify::new());
                let cut2 = cut.clone();
                let up = tokio::spawn(async move {
                    let mut buf = vec![0u8; 16384];
                    loop {
                        let n = match cr.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        if sw.write_all(&buf[..n]).await.is_err() {
                            return;
                        }
                        if armed.load(Ordering::SeqCst) && buf[..n].windows(7).any(|w| w == b"COMMIT\0") {
                            armed.store(false, Ordering::SeqCst);
                            cuts.fetch_add(1, Ordering::SeqCst);
                            let _ = sw.flush().await;
                            cut2.notify_one();
                            return;
                        }
                    }
                });
                let mut buf = vec![0u8; 16384];
                loop {
                    tokio::select! {
                        _ = cut.notified() => { break; }
                        r = sr.read(&mut buf) => match r {
                            Ok(0) | Err(_) => break,
                            Ok(n) => if cw.write_all(&buf[..n]).await.is_err() { break },
                        },
                    }
                }
                up.abort();
            });
        }
    });
    CutAfterCommit { port, armed, cuts }
}

fn executor_via(port: u16) -> Executor<Factory> {
    let mut cfg = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap();
    cfg.port = port;
    let mut h = Hooks::with_trace(Arc::new(Events::default()));
    h.pause = Some(Arc::new(Script::default()));
    h.controls = Some(Arc::new(Arm(vec![])));
    Executor::new(
        Factory::new(cfg.clone(), "executor", h.clone()),
        2,
        Factory::new(cfg, "lookup", h.clone()),
        1,
        ExecConfig { max_attempts: 6, backoff_base: Duration::from_millis(1), backoff_cap: Duration::from_millis(5), lock_timeout_ms: Some(10_000), ..ExecConfig::default() },
        h,
    )
}

/// The send's COMMIT is cut after the server received it: the executor
/// re-claims the SAME caller key, finds the committed receipt and replays.
/// Then the receive's COMMIT is cut the same way (a minted key): one row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_retry_after_a_lost_commit_reaches_one_outcome_through_the_receipt() {
    reset().await;
    let real = PgConfig::from_url(&url("P03_PG_RUNTIME_URL")).unwrap().port;
    let p = proxy(real).await;
    let ex = executor_via(p.port);
    let m = new_id();

    // the source transaction
    p.armed.store(true, Ordering::SeqCst);
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "lost1", "lost1")).await.unwrap();
    assert_eq!(p.cuts.load(Ordering::SeqCst), 1, "the send's COMMIT was never cut: the ambiguous case did not happen");
    assert!(matches!(o, Outcome::Replayed(_)), "resolved through the receipt, not re-executed: {o:?}");
    assert_eq!(count(&format!("SELECT count(*) FROM mail_sent WHERE message_id = '{m}'")).await, 1, "one Sent row");
    assert_eq!(count(&format!("SELECT count(*) FROM outgoing_intents WHERE kind = 'mail.deliver' AND source_ref = '{m}'")).await, 1, "one delivery intent");
    assert_eq!(count("SELECT count(*) FROM operation_receipts WHERE op_key = 'lost1'").await, 1, "one receipt");

    // the receiver transaction
    p.armed.store(true, Ordering::SeqCst);
    let d = receive::deliver(&ex, org(), mb(b()), m).await.unwrap();
    assert_eq!(p.cuts.load(Ordering::SeqCst), 2, "the receive's COMMIT was never cut");
    assert!(matches!(d, Delivery::Done(Received::Received { recv_ord: Some(1), .. })), "{d:?}");
    assert_eq!(count(&rows_of(m)).await, 1, "one message row");
    assert_eq!(count(&head_of(b())).await, 1, "the head advanced once");
}
