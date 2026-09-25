//! WS4 on a real PostgreSQL (the WS1 dev cluster of p03-ws4-rcfamilies):
//! `status.report` (S3 §4.1, Q-S1–Q-S3) and the work-item reads and
//! schedule-grade writers (S3 §4.11, Q-W1, Q-W2).
//!
//! Every test is `#[ignore]`: run them ONLY through the P03 run lock, with
//! `--features qualification -- --ignored --test-threads=1` and the URLs from
//! `devdb.cmd env --agent p03-ws4-rcfamilies` (artifacts\run-pg.ps1). Each
//! test rebuilds the `public` schema, so it refuses unless the server's data
//! directory is this agent's own disposable cluster.
//!
//! Schedules force their interleaving with holds at named points and fail
//! ("interleaving not achieved") if a planned point is never reached. Every
//! unsafe control asserts its `control_executed` record before its failure
//! is accepted. The racing move, retire and halt are schedule-grade
//! stand-ins (common_ws4::Racer).
#![cfg(feature = "qualification")]

mod common_ws4;

use common_ws4::*;
use orgtree_store::hooks::HookAction;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::status::{StatusReport, StatusResult, TOP_LEVEL_REPORTED_TO};
use orgtree_store::work::{self, Archive, ItemList, WorkCreate, WorkUpdate};
use orgtree_store::Outcome;

fn report(status: &str, summary: &str) -> StatusReport {
    StatusReport { status: status.into(), summary: summary.into(), message_id: new_id() }
}

async fn applied(o: Result<Outcome<StatusResult>, orgtree_store::ExecError>) -> StatusResult {
    match o.unwrap() {
        Outcome::Applied(r) => r,
        o => panic!("expected applied, got {o:?}"),
    }
}

// ================================================================ status.report

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn status_stores_legacy_values_and_reports_done_to_the_parent() {
    reset().await;
    let x = executor(vec![]);
    // working: stored, activity stamped; nothing sent
    let r = applied(x.ex.run(&report("working", "on it"), &agent_binding(c(), "s1")).await).await;
    assert_eq!(r, StatusResult { recorded: "working".into(), reported_to: None, delivered: None, id: None, warnings: None });
    assert_eq!(text(&format!("SELECT last_status->>'status' FROM status_rows WHERE principal_id = '{}'", c())).await, "working");
    assert_eq!(count(&format!("SELECT count(*) FROM status_rows WHERE principal_id = '{}' AND working_activity_at IS NOT NULL", c())).await, 1);
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0);
    // done: stored as idle, answered done, activity cleared, one paired status message to the parent
    let rep = report("done", "shipped");
    let mid = rep.message_id;
    let r = applied(x.ex.run(&rep, &agent_binding(c(), "s2")).await).await;
    assert_eq!(r.recorded, "done");
    assert_eq!(r.reported_to.as_deref(), Some("bravo"));
    assert_eq!(r.delivered.as_deref(), Some("bravo"));
    assert_eq!(r.id, Some(mid));
    assert_eq!(text(&format!("SELECT last_status->>'status' FROM status_rows WHERE principal_id = '{}'", c())).await, "idle");
    assert_eq!(text(&format!("SELECT last_status->>'summary' FROM status_rows WHERE principal_id = '{}'", c())).await, "shipped");
    assert_eq!(count(&format!("SELECT count(*) FROM status_rows WHERE principal_id = '{}' AND working_activity_at IS NULL", c())).await, 1);
    assert_eq!(text(&format!("SELECT body FROM mail_sent WHERE message_id = '{mid}'")).await, "[DONE] shipped");
    assert_eq!(text(&format!("SELECT kind || '/' || class || '/' || pair_seq FROM mail_sent WHERE message_id = '{mid}'")).await, "status/message/1");
    assert_eq!(uuid_of(&format!("SELECT dest_principal_id FROM mail_sent WHERE message_id = '{mid}'")).await, Some(b()));
    assert_eq!(count("SELECT count(*) FROM audience_grants").await, 0, "no grant: the parent is the superior");
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 0, "source only (v6 I07)");
    // the receiver files it and records the wake
    assert_eq!(receive::deliver(&x.ex, org(), mb(b()), mid).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }));
    // case-sensitive: "Done" is stored as is and reports nothing (legacy)
    let r = applied(x.ex.run(&report("Done", "x"), &agent_binding(c(), "s3")).await).await;
    assert_eq!(r.reported_to, None);
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 1);
    // a top-level caller: the chip text, nothing sent
    let r = applied(x.ex.run(&report("blocked", "stuck"), &agent_binding(a(), "s4")).await).await;
    assert_eq!(r.reported_to.as_deref(), Some(TOP_LEVEL_REPORTED_TO));
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 1);
    // a keyed retry replays
    let o = x.ex.run(&rep, &agent_binding(c(), "s2")).await.unwrap();
    assert!(matches!(o, Outcome::Replayed(ref p) if p.id == Some(mid)), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 1);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn status_refused_callers_commit_nothing() {
    reset().await;
    let x = executor(vec![]);
    admin_exec(&format!("UPDATE authority_epoch SET halted = true WHERE principal_id = '{}'", c())).await;
    let o = x.ex.run(&report("done", "x"), &agent_binding(c(), "r1")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "halted"), "{o:?}");
    admin_exec(&format!("UPDATE authority_epoch SET halted = false, lifecycle = 'archived' WHERE principal_id = '{}'", c())).await;
    let o = x.ex.run(&report("done", "x"), &agent_binding(c(), "r2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "not_live"), "{o:?}");
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'live' WHERE principal_id = '{}'; UPDATE org_controls SET value = '{{\"engaged\": true}}' WHERE family = 'killswitch'", c())).await;
    let o = x.ex.run(&report("done", "x"), &agent_binding(c(), "r3")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "killswitch"), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM operation_receipts").await, 0, "E-D5: not even the receipt");
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0);
    assert_eq!(count(&format!("SELECT count(*) FROM status_rows WHERE principal_id = '{}' AND last_status IS NOT NULL", c())).await, 0);
}

/// Q-S1 (a) two children to one parent; (c) one caller twice.
#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s1_a_and_c_same_parent_and_same_caller() {
    reset().await;
    let x = executor(vec![]);
    // (a) bravo and delta both report to alpha, overlapping: bravo holds before commit
    let r1 = report("done", "b");
    let r2 = report("blocked", "d");
    let mut h = x.script.hold(Some("q1a-b"), "status.report.before_commit");
    let ex = &x.ex;
    let t1 = async { ex.run(&r1, &agent_binding(b(), "q1a-b")).await };
    // delta's report runs while bravo's is held
    let bd = agent_binding(d(), "q1a-d");
    let t2 = while_held(&mut h, 1500, ex.run(&r2, &bd));
    let (o1, (o2, _)) = tokio::join!(t1, t2);
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    // delta committed first: receive in commit order, dense
    assert_eq!(receive::deliver(ex, org(), mb(a()), r2.message_id).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }));
    assert_eq!(receive::deliver(ex, org(), mb(a()), r1.message_id).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(2), woke: true, deferred: false }));
    // (c) charlie twice: later commit wins on the status row; both mails in pair order
    let c1 = report("blocked", "first");
    let c2 = report("done", "second");
    applied(ex.run(&c1, &agent_binding(c(), "q1c-1")).await).await;
    applied(ex.run(&c2, &agent_binding(c(), "q1c-2")).await).await;
    assert_eq!(text(&format!("SELECT last_status->>'summary' FROM status_rows WHERE principal_id = '{}'", c())).await, "second");
    assert_eq!(count(&format!("SELECT pair_seq FROM mail_sent WHERE message_id = '{}'", c1.message_id)).await, 1);
    assert_eq!(count(&format!("SELECT pair_seq FROM mail_sent WHERE message_id = '{}'", c2.message_id)).await, 2);
    // the second is parked until the first arrives, then both in order
    assert_eq!(receive::deliver(ex, org(), mb(b()), c2.message_id).await.unwrap(), Delivery::Parked);
    assert_eq!(receive::deliver(ex, org(), mb(b()), c1.message_id).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(1), woke: true, deferred: false }));
    assert_eq!(receive::deliver(ex, org(), mb(b()), c2.message_id).await.unwrap(), Delivery::Done(Received::Received { recv_ord: Some(2), woke: true, deferred: false }));
}

/// Q-S1 (b): children of different parents, forced to overlap at both
/// stages' source transaction: zero lock waits. Its unsafe control writes one
/// organization-wide row per report, so the second report waits.
async fn q_s1_b(control: bool) -> (bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-S1.org_wide_mail_row"] } else { vec![] });
    let r1 = report("done", "charlie to bravo");
    let r2 = report("done", "delta to alpha");
    let mut h = x.script.hold(Some("q1b-c"), "status.report.before_commit");
    let ex = &x.ex;
    let t1 = async { ex.run(&r1, &agent_binding(c(), "q1b-c")).await };
    let bd = agent_binding(d(), "q1b-d");
    let t2 = while_held(&mut h, 2000, ex.run(&r2, &bd));
    let (o1, (o2, no_wait)) = tokio::join!(t1, t2);
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    (no_wait, x.ev.has("control_executed:Q-S1.org_wide_mail_row"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s1_b_different_parents_never_wait() {
    let (no_wait, ran) = q_s1_b(false).await;
    assert!(!ran);
    assert!(no_wait, "a report to a different parent waited");
    // and the receivers: two different heads, both receive at once
    assert_eq!(count("SELECT count(*) FROM mail_sent").await, 2);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s1_b_control_org_wide_row_makes_reports_wait() {
    let (no_wait, ran) = q_s1_b(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!no_wait, "control executed but the second report did not wait: the control proves nothing");
}

/// Q-S2: a done report racing a move of the caller, both orders; the
/// control reads the parent without FOR SHARE.
async fn q_s2(control: bool, move_first: bool) -> (Option<orgtree_store::Uuid>, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-S2.parent_without_share"] } else { vec![] });
    let ex = &x.ex;
    let rep = report("done", "moving");
    let mv = Racer::Move { node: c(), new_parent: Some(d()) };
    if move_first {
        assert!(matches!(ex.run(&mv, &system_binding("q2-mv")).await.unwrap(), Outcome::Applied(_)));
        applied(ex.run(&rep, &agent_binding(c(), "q2-rep")).await).await;
    } else {
        // the report has read (and, safely, share-locked) its parent; the move then tries to commit
        let mut h = x.script.hold(Some("q2-rep"), "status.report.after_parent_read");
        let t1 = async { ex.run(&rep, &agent_binding(c(), "q2-rep")).await };
        let bm = system_binding("q2-mv");
        let t2 = while_held(&mut h, 2000, ex.run(&mv, &bm));
        let (o1, (o2, _moved_while_held)) = tokio::join!(t1, t2);
        assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
        assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    }
    let dest = uuid_of(&format!("SELECT dest_principal_id FROM mail_sent WHERE message_id = '{}'", rep.message_id)).await;
    // The oracle: the parent AT THE REPORT'S COMMIT, from the recorded commit order.
    let rep_commit = x.ev.pos("commit:status.report:q2-rep").expect("report committed");
    let move_commit = x.ev.pos("commit:sg.island.move:q2-mv").expect("move committed");
    let parent_at_commit = if move_commit < rep_commit { d() } else { b() };
    (dest, dest == Some(parent_at_commit) && x.ev.has("control_executed:Q-S2.parent_without_share") == control)
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s2_report_goes_to_the_parent_at_its_commit_both_orders() {
    let (dest, ok) = q_s2(false, true).await;
    assert_eq!(dest, Some(d()), "move first: the new parent");
    assert!(ok);
    let (dest, ok) = q_s2(false, false).await;
    assert_eq!(dest, Some(b()), "report first: the move waited, the old parent was the parent at commit");
    assert!(ok, "the report went to a node that was not the parent at its commit");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s2_control_parent_without_share_reaches_the_former_parent() {
    let (dest, ok) = q_s2(true, false).await;
    assert_eq!(dest, Some(b()), "the control read the old parent");
    assert!(!ok, "control executed but the report still went to the parent at its commit: the move did not commit in the gap");
}

/// Q-S3: a report racing a retire (and a halt) of the caller, both orders.
/// Returns (report outcome name, retire/halt committed before the report, report committed).
async fn q_s3(control: bool, halt: bool, report_first: bool) -> (String, bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-S3.no_anchor"] } else { vec![] });
    let ex = &x.ex;
    let rep = report("done", "racing");
    let racer = if halt { Racer::Halt { node: c() } } else { Racer::Retire { node: c() } };
    let racer_verb = if halt { "commit:sg.outside.halt:q3-w" } else { "commit:sg.island.retire:q3-w" };
    let outcome = if !report_first {
        assert!(matches!(ex.run(&racer, &system_binding("q3-w")).await.unwrap(), Outcome::Applied(_)));
        ex.run(&rep, &agent_binding(c(), "q3-rep")).await.unwrap()
    } else {
        // the report has anchored; the retire/halt then tries to commit
        let mut h = x.script.hold(Some("q3-rep"), "status.report.after_anchor");
        let t1 = async { ex.run(&rep, &agent_binding(c(), "q3-rep")).await };
        let bw = system_binding("q3-w");
        let t2 = while_held(&mut h, 2000, ex.run(&racer, &bw));
        let (o1, (o2, _)) = tokio::join!(t1, t2);
        assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
        o1.unwrap()
    };
    let w = x.ev.pos(racer_verb).expect("writer committed");
    let r = x.ev.pos("commit:status.report:q3-rep");
    (outcome.name().to_string(), r.map_or(true, |r| w < r), r.is_some())
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s3_report_commits_first_or_is_refused() {
    for halt in [false, true] {
        let (o, writer_first, committed) = q_s3(false, halt, false).await;
        assert_eq!(o, "refused", "halt={halt}: writer first must refuse the report");
        assert!(writer_first && !committed);
        assert_eq!(count("SELECT count(*) FROM mail_sent").await, 0);
        let (o, writer_first, committed) = q_s3(false, halt, true).await;
        assert_eq!(o, "applied", "halt={halt}");
        assert!(committed && !writer_first, "halt={halt}: the writer must wait for the anchored report");
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_s3_control_no_anchor_commits_after_archive() {
    for halt in [false, true] {
        let (o, writer_first, committed) = q_s3(true, halt, true).await;
        assert!(committed, "halt={halt}: {o}");
        assert!(writer_first, "halt={halt}: control executed but the writer still waited: the control proves nothing");
        // the violation: a report committed after its caller was archived/halted
        assert_eq!(count("SELECT count(*) FROM mail_sent").await, 1);
    }
}

// ================================================================ work items

async fn seed_item(x: &Ex, item: orgtree_store::Uuid, status: &str) {
    let o = x
        .ex
        .run(&WorkCreate { item, name: format!("item-{item}").chars().take(40).collect(), title: "t".into(), status: status.into(), owner: Some(b()), participants: vec![c()] }, &user_binding(&format!("mk-{item}")))
        .await
        .unwrap();
    assert!(matches!(o, Outcome::Applied(1)), "{o:?}");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn work_writers_bump_the_head_and_record_the_revision() {
    reset().await;
    let x = executor(vec![]);
    let it = new_id();
    seed_item(&x, it, "open").await;
    let o = x.ex.run(&WorkUpdate { item: it, status: Some("in_progress".into()), add_participants: vec![d()], ..Default::default() }, &agent_binding(b(), "w1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(ref u) if u.rev == 2), "{o:?}");
    let got = work::item_get(&x.ex, org(), it, None).await.unwrap().unwrap();
    assert_eq!(got.head.rev, 2);
    assert!(got.coherent());
    let mut want = vec![c(), d()];
    want.sort();
    assert_eq!(got.participants, want);
    // stale CAS refuses and commits nothing
    let o = x.ex.run(&WorkUpdate { item: it, expected_rev: Some(1), status: Some("done".into()), ..Default::default() }, &agent_binding(b(), "w2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "stale_rev"), "{o:?}");
    assert_eq!(count(&format!("SELECT rev FROM work_items WHERE item_id = '{it}'")).await, 2);
    // drop archives at once; reopen clears it
    let o = x.ex.run(&WorkUpdate { item: it, archive: Some(Archive::Drop), ..Default::default() }, &user_binding("w3")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(ref u) if u.archived && u.status == "dropped"), "{o:?}");
    let l = x.ex.read(&ItemList { org: org(), include_archived: true, include_backlogged: true }, org(), None).await.unwrap();
    assert_eq!(l.counts.archived, 1);
    assert_eq!(l.archived.as_ref().unwrap().len(), 1);
    let o = x.ex.run(&WorkUpdate { item: it, reopen: true, status: Some("open".into()), ..Default::default() }, &user_binding("w4")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(ref u) if !u.archived), "{o:?}");
}

/// Q-W1: an item read racing a docket write that changes the head,
/// participants and history together. The read is held after its first
/// statement (which fixes the snapshot); the writer commits; the read ends.
async fn q_w1(control: bool) -> (bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-W1.per_statement_reads"] } else { vec![] });
    let it = new_id();
    seed_item(&x, it, "open").await;
    let mut h = x.script.hold(None, "work.get.stmt.work.head.after");
    let ex = &x.ex;
    let t1 = async { work::item_get(ex, org(), it, None).await };
    let t2 = async {
        h.arrive().await;
        let o = ex.run(&WorkUpdate { item: it, status: Some("review".into()), add_participants: vec![d()], remove_participants: vec![c()], ..Default::default() }, &user_binding("q-w1-writer")).await.unwrap();
        assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
        h.go();
    };
    let (got, _) = tokio::join!(t1, t2);
    let got = got.unwrap().unwrap();
    (got.coherent(), x.ev.has("control_executed:Q-W1.per_statement_reads"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_w1_item_read_is_one_committed_revision() {
    let (coherent, ran) = q_w1(false).await;
    assert!(!ran);
    assert!(coherent, "a torn item: head and participants from different revisions");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_w1_control_per_statement_reads_tears_the_item() {
    let (coherent, ran) = q_w1(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!coherent, "control executed but the answer is still one revision: the writer did not commit between the reads");
}

/// Q-W2: a list read while an item's archive time passes during the read.
async fn q_w2(control: bool) -> (bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-W2.ts_per_item"] } else { vec![] });
    let it = new_id();
    seed_item(&x, it, "done").await;
    // its hour ends ~1.2 s after the read starts; the read sleeps 2.5 s between counts and groups
    admin_exec(&format!("UPDATE work_items SET updated_at = clock_timestamp() - interval '3598.8 seconds' WHERE item_id = '{it}'")).await;
    x.script.act(None, "work.list.after_counts", HookAction::Sleep(2500));
    let l = x.ex.read(&ItemList { org: org(), include_archived: true, include_backlogged: true }, org(), None).await.unwrap();
    let listed_archived = l.archived.as_ref().unwrap().iter().any(|h| h.item_id == it);
    let listed_active = l.items.iter().any(|h| h.item_id == it);
    let consistent = (l.counts.archived == 1) == listed_archived && (l.counts.active == 1) == listed_active && listed_archived != listed_active;
    (consistent, x.ev.has("control_executed:Q-W2.ts_per_item"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_w2_derived_archive_uses_one_timestamp() {
    let (consistent, ran) = q_w2(false).await;
    assert!(!ran);
    assert!(consistent, "the item is in different groups in one answer");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_w2_control_timestamp_per_item_disagrees_with_the_counts() {
    let (consistent, ran) = q_w2(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!consistent, "control executed but counts and groups agree: the archive time did not pass during the read");
}
