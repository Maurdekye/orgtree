//! WS4 `charter.capture` on a real PostgreSQL: the capture parts of Q-CR1
//! and Q-CR3 (Q-CR r2). The claim side (`runtime.admit`, Q-CR2 and the
//! claim's success in each order) is WS5's; the pure charter edit is a
//! schedule-grade stand-in for WS3's retool (common_ws4::Racer::CharterEdit).
//! Run ONLY through the P03 run lock (`artifacts\run-pg.ps1 -Test
//! ws4_charter_pg` via `p03-run.ps1`).
#![cfg(feature = "qualification")]

mod common_ws4;

use common_ws4::*;
use orgtree_store::charter;
use orgtree_store::hooks::HookAction;
use orgtree_store::runtime::admit::Vector;
use orgtree_store::{Outcome, Uuid};

/// Chain root → A (alpha) → P (bravo) → S (charlie). State s0 = (S0, P0, A0):
/// charlie's role charter v1, bravo's and alpha's team charters v1.
async fn fixture(x: &Ex) {
    for (node, kind, body) in [(c(), "role", "S0"), (b(), "team", "P0"), (a(), "team", "A0")] {
        edit(x, node, kind, body, &format!("init-{kind}-{node}")).await;
    }
}

async fn edit(x: &Ex, node: Uuid, kind: &'static str, body: &'static str, key: &str) {
    let o = x.ex.run(&Racer::CharterEdit { node, kind, body }, &system_binding(key)).await;
    assert!(matches!(o, Ok(Outcome::Applied(()))), "{o:?}");
}

/// The vector's (S role, P team, A team) versions.
fn svec(v: &Vector) -> (Option<i64>, Option<i64>, Option<i64>) {
    let get = |n: Uuid, k: &str| v.bodies.iter().find(|(p, kind, _, _)| *p == n && kind == k).map(|x| x.2);
    (get(c(), "role"), get(b(), "team"), get(a(), "team"))
}

async fn edits_s_p_a(x: &Ex, tag: &str) {
    edit(x, c(), "role", "S1", &format!("es-{tag}")).await;
    edit(x, b(), "team", "P1", &format!("ep-{tag}")).await;
    edit(x, a(), "team", "A1", &format!("ea-{tag}")).await;
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_cr1_the_vector_is_one_committed_state_in_every_order() {
    // (a) every edit before the first statement: s3
    reset().await;
    let x = executor(vec![]);
    fixture(&x).await;
    edits_s_p_a(&x, "a").await;
    let v = charter::capture(&x.ex, org(), c(), None).await.unwrap().unwrap();
    assert_eq!(svec(&v), (Some(2), Some(2), Some(2)), "(a) s3");
    assert_eq!(v.chain.iter().map(|n| n.node).collect::<Vec<_>>(), vec![c(), b(), a()]);
    // (b) every edit after the first statement: s0
    reset().await;
    let x = executor(vec![]);
    fixture(&x).await;
    let mut h = x.script.hold(None, "charter.capture.after_first_read");
    let (v, _) = tokio::join!(charter::capture(&x.ex, org(), c(), None), async {
        h.arrive().await;
        edits_s_p_a(&x, "b").await;
        h.go();
    });
    assert_eq!(svec(&v.unwrap().unwrap()), (Some(1), Some(1), Some(1)), "(b) s0");
    // (c) E_S before the first statement, E_P and E_A after: s1
    reset().await;
    let x = executor(vec![]);
    fixture(&x).await;
    edit(&x, c(), "role", "S1", "es-c").await;
    let mut h = x.script.hold(None, "charter.capture.after_first_read");
    let (v, _) = tokio::join!(charter::capture(&x.ex, org(), c(), None), async {
        h.arrive().await;
        edit(&x, b(), "team", "P1", "ep-c").await;
        edit(&x, a(), "team", "A1", "ea-c").await;
        h.go();
    });
    assert_eq!(svec(&v.unwrap().unwrap()), (Some(2), Some(1), Some(1)), "(c) s1");
    // the next capture sees s3; each pure edit wrote only charter rows (N5)
    assert_eq!(svec(&charter::capture(&x.ex, org(), c(), None).await.unwrap().unwrap()), (Some(2), Some(2), Some(2)));
    let log = x.ev.0.lock().unwrap().clone();
    for key in ["ep-c", "ea-c"] {
        let stmts: Vec<&String> = log.iter().filter(|e| e.starts_with("stmt:sg.") && e.ends_with(&format!(":{key}"))).collect();
        assert!(stmts.iter().all(|e| e.starts_with("stmt:sg.charter.")), "{key}: a pure edit wrote more than its charter rows: {stmts:?}");
    }
    assert_eq!(count("SELECT count(*) FROM outgoing_intents").await, 0, "no intents, mail or wakes from an edit");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_cr1_control_per_statement_reads_yields_a_state_that_never_existed() {
    reset().await;
    let x = executor(vec!["Q-CR1.per_statement_reads"]);
    fixture(&x).await;
    // S's role head is read; E_S, E_P, E_A commit (in that order) before P's head is read
    let point = format!("charter.capture.stmt.head.{}.team.before", b());
    let mut h = x.script.hold(None, &point);
    let (v, _) = tokio::join!(charter::capture(&x.ex, org(), c(), None), async {
        h.arrive().await;
        edits_s_p_a(&x, "ctl").await;
        h.go();
    });
    assert!(x.ev.has("control_executed:Q-CR1.per_statement_reads"), "control did not record that it executed");
    let (es, ep, ea) = (
        x.ev.pos("commit:sg.outside.charter_edit:es-ctl").unwrap(),
        x.ev.pos("commit:sg.outside.charter_edit:ep-ctl").unwrap(),
        x.ev.pos("commit:sg.outside.charter_edit:ea-ctl").unwrap(),
    );
    assert!(es < ep && ep < ea, "control_invalid: the achieved commit order is not E_S < E_P < E_A");
    // (S0, P1, A1): P1 without S1 matches no committed state
    assert_eq!(svec(&v.unwrap().unwrap()), (Some(1), Some(2), Some(2)), "control executed but the vector is not torn");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_cr3_failed_capture_never_yields_a_partial_or_stale_vector() {
    // (a) 40001 at P's head: the capture fails; the next capture is complete, from a fresh snapshot
    reset().await;
    let x = executor(vec![]);
    fixture(&x).await;
    edit(&x, a(), "team", "A1", "ea").await;
    x.script.act(None, &format!("charter.capture.stmt.head.{}.team.before", b()), HookAction::FailNext("40001".into()));
    assert!(charter::capture(&x.ex, org(), c(), None).await.is_err(), "(a) the failed capture must not yield a vector");
    assert_eq!(svec(&charter::capture(&x.ex, org(), c(), None).await.unwrap().unwrap()), (Some(1), Some(1), Some(2)), "(a) recapture = (A1, P0)");
    // (b) the connection dropped at the same point: the read retries in a fresh snapshot
    x.script.act(None, &format!("charter.capture.stmt.head.{}.team.before", b()), HookAction::DropConn);
    let v = charter::capture(&x.ex, org(), c(), None).await.unwrap().unwrap();
    assert!(x.ev.any("retry:charter.capture:"), "(b) the drop never happened");
    assert_eq!(svec(&v), (Some(1), Some(1), Some(2)), "(b)");
}

async fn missing_body_fixture(x: &Ex) -> bool {
    fixture(x).await;
    // the fixture bypasses the head→version key and deletes P's team body
    admin_exec("ALTER TABLE charter_heads DROP CONSTRAINT charter_heads_version_fk").await;
    admin_exec(&format!("DELETE FROM charter_versions WHERE principal_id = '{}' AND charter_kind = 'team'", b())).await;
    count(&format!("SELECT count(*) FROM charter_versions WHERE principal_id = '{}' AND charter_kind = 'team'", b())).await == 0
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_cr3_c_a_missing_body_fails_closed() {
    reset().await;
    let x = executor(vec![]);
    assert!(missing_body_fixture(&x).await, "not_executed: the body row is still there");
    let r = charter::capture(&x.ex, org(), c(), None).await.unwrap();
    let e = r.expect_err("a vector with a missing body must never be produced");
    assert_eq!(e.code, "incomplete_charter");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_cr3_c_control_skip_missing_yields_a_partial_vector() {
    reset().await;
    let x = executor(vec!["Q-CR3.skip_missing"]);
    assert!(missing_body_fixture(&x).await, "not_executed: the body row is still there");
    let v = charter::capture(&x.ex, org(), c(), None).await.unwrap();
    assert!(x.ev.has("control_executed:Q-CR3.skip_missing"), "control did not record that it executed");
    let v = v.expect("control executed but the capture still failed closed");
    assert_eq!(svec(&v).1, None, "the partial vector lacks P's team charter");
}
