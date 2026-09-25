//! v6 PROFILING-AND-CONTACTS required deliberate-failure test 2 (WS5's half):
//! "A-to-B mail shows source transaction, no-DB MPSC handoff, receiver
//! transaction and input-confirmed Read. Labeling the workflow as one atomic
//! database transaction fails."
//!
//! WS5 builds the workload, the trace and the negative declaration; WS7 owns
//! the verdict function (`oracle.atomicity_failures`, agreed 2026-09-25).
//! Until that lands, `atomic_label_violations` below is a LOCAL STAND-IN with
//! the same rule: a workflow declared `native_tx` fails when its steps
//! committed in more than one transaction. Steps are grouped by the causal
//! ref (the original message id, and the input batch id) the executor emits.
//!
//! One test in its own binary: the hint queue is process-global.
#![cfg(feature = "qualification")]

mod common_pg;

use std::collections::BTreeSet;

use common_pg::*;
use orgtree_store::mail::hints::{self, Hint};
use orgtree_store::mail::receive::{self, Delivery};
use orgtree_store::runtime::{self, admit::FakeProvider, Turn};
use orgtree_store::sent::MailClass;
use orgtree_store::Outcome;

/// The op keys (family.verb:key) whose causal refs include `r`.
fn ops_for(ev: &Events, r: &str) -> Vec<String> {
    ev.snapshot()
        .into_iter()
        .filter_map(|e| {
            let rest = e.strip_prefix("causal:")?;
            let (op, refs) = rest.rsplit_once(':')?;
            refs.split(',').any(|x| x == r).then(|| op.to_string())
        })
        .collect()
}

/// LOCAL STAND-IN for WS7's oracle: violations of a `native_tx` label over
/// these steps = the number of distinct commits beyond one.
fn atomic_label_violations(ev: &Events, steps: &[String]) -> usize {
    let commits: BTreeSet<usize> = steps.iter().filter_map(|op| ev.pos(&format!("commit:{op}"))).collect();
    commits.len().saturating_sub(1)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn profiling_2_a_to_b_mail_is_four_stages_and_labelling_it_one_transaction_fails() {
    reset().await;
    let mut queue = hints::install(64);
    let (ex, ev) = executor(vec![]);
    let m = new_id();
    let (emitted0, _) = hints::counters();

    // 1. the SOURCE transaction
    let o = ex.run(&agent_send(Target::Agent { principal: b() }, m, MailClass::Message), &agent_binding(a(), "p2-send", "p2")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 0, "no receiver row at Sent");

    // 2. the no-DB MPSC handoff: a volatile hint, emitted after commit
    let h = queue.try_recv().expect("the committed send hinted the receiver's queue");
    assert_eq!(h, Hint::Deliver { org: org(), mailbox: mb(b()), message: m });
    assert!(hints::counters().0 > emitted0);

    // 3. the RECEIVER transaction (driven by that hint), then the ack
    let Hint::Deliver { mailbox, message, .. } = h else { unreachable!() };
    assert!(matches!(receive::deliver(&ex, org(), mailbox, message).await.unwrap(), Delivery::Done(_)));

    // 4. input-confirmed READ through the fake provider
    let t = runtime::run_turn(&ex, org(), b(), &FakeProvider { tamper: false }).await.unwrap();
    let Turn::Ran { read, .. } = t else { panic!("{t:?}") };
    assert_eq!(read, vec![m]);
    let batch = uuid_of(&format!("SELECT batch_id FROM mail_input_batches WHERE state = 'confirmed'")).await;
    assert_eq!(text(&format!("SELECT state FROM mailbox_messages WHERE original_message_id = '{m}'")).await, "delivered");

    // the trace: each stage is its own transaction, in stage order
    let by_msg = ops_for(&ev, &m.to_string());
    let by_batch = ops_for(&ev, &batch.to_string());
    let source = by_msg.iter().find(|o| o.starts_with("mail.source.message:")).cloned().expect("source op in trace");
    let recv = by_msg.iter().find(|o| o.starts_with("mail.receive.deliver_agent:")).cloned().expect("receiver op in trace");
    let ack = by_msg.iter().find(|o| o.starts_with("mail.ack.ack:")).cloned().expect("ack op in trace");
    let confirm = by_batch.iter().find(|o| o.starts_with("runtime.confirm_input:")).cloned().expect("input confirmation in trace");
    let pos = |op: &str| ev.pos(&format!("commit:{op}")).unwrap_or_else(|| panic!("no commit for {op}"));
    let (p1, p3, p4, p5) = (pos(&source), pos(&recv), pos(&ack), pos(&confirm));
    assert!(p1 < p3 && p3 < p4 && p4 < p5, "stage order source < receive < ack < confirmed Read: {p1} {p3} {p4} {p5}");
    // the provider consumed input with no SQL statement or transaction start between its markers
    let snap = ev.snapshot();
    let b0 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.begin").expect("provider begin marker");
    let b1 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.end").expect("provider end marker");
    assert!(b0 < b1);
    assert!(!snap[b0..b1].iter().any(|e| e.starts_with("stmt:") || e.starts_with("begin:")), "no SQL during provider input: {:?}", &snap[b0..b1]);

    // the declared workflow shape passes; labelling it ONE atomic transaction fails
    let steps = vec![source, recv, confirm];
    let violations = atomic_label_violations(&ev, &steps);
    assert_eq!(violations, 2, "NEGATIVE: the `native_tx` label over the A-to-B workflow fails (three separate commits)");
    hints::uninstall();
}
