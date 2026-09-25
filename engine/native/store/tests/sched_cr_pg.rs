//! Q-CR r2 (approved; coordinator-added, derived from v6 I13): WS5's part is
//! `runtime.admit` (the claim recheck), the recapture loop and the turn's
//! input step. WS4 owns `charter.capture`; until it lands, WS5's capture
//! STAND-IN (runtime/admit.rs `Capture`) supplies the same vector, and the
//! results say so. The racing writers (a move of S, a narrowing retool of P,
//! a pure charter edit) are SCHEDULE-GRADE stand-ins.
//!
//! Chain: A (root) -> B (P) -> C (S); D (Q) under A. Forced orders use the
//! pause points `charter.capture.after_first_read` and
//! `runtime.admit.after_recheck` (after the anchors and the comparison).
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::Arc;
use std::time::Duration;

use common_pg::stand_ins::Island;
use common_pg::*;
use orgtree_store::hooks::HookAction;
use orgtree_store::runtime::{self, admit::FakeProvider, Turn};
use orgtree_store::{Outcome, Uuid};

async fn done<T>(h: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), h).await.expect("operation did not finish").unwrap()
}

fn spawn_turn(ex: &Ex) -> tokio::task::JoinHandle<Turn> {
    let ex = ex.clone();
    tokio::spawn(async move { runtime::run_turn(&ex, org(), c(), &FakeProvider { tamper: false }).await.unwrap() })
}

fn spawn_writer(ex: &Ex, w: Island, key: &'static str) -> tokio::task::JoinHandle<Outcome<i64>> {
    let ex = ex.clone();
    tokio::spawn(async move { ex.run(&w, &system_binding(key)).await.unwrap() })
}

fn chain(t: &Turn) -> Vec<Uuid> {
    match t {
        Turn::Ran { vector, .. } => vector.chain.iter().map(|n| n.node).collect(),
        other => panic!("{other:?}"),
    }
}

fn scope_version_of(t: &Turn, node: Uuid) -> i64 {
    match t {
        Turn::Ran { vector, .. } => vector.chain.iter().find(|n| n.node == node).map(|n| n.scope_version).unwrap_or(-1),
        other => panic!("{other:?}"),
    }
}

fn recaptures(t: &Turn) -> u32 {
    match t {
        Turn::Ran { recaptures, .. } | Turn::Deferred { recaptures, .. } | Turn::Refused { recaptures, .. } => *recaptures,
    }
}

fn claim_commit(ev: &Events) -> Option<usize> {
    ev.snapshot().iter().position(|e| e.starts_with("commit:runtime.admit:"))
}

fn mv() -> Island {
    Island::Move { node: c(), new_parent: Some(d()) }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_a_and_d_writers_before_capture_or_after_the_claim() {
    for narrowing in [false, true] {
        // (a) the writer commits before the capture: the capture sees it
        reset().await;
        let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
        let w = if narrowing { Island::Narrow(b()) } else { mv() };
        assert!(matches!(ex.run(&w, &system_binding("w")).await.unwrap(), Outcome::Applied(_)));
        let t = done(spawn_turn(&ex)).await;
        assert_eq!(recaptures(&t), 0);
        if narrowing {
            assert_eq!(scope_version_of(&t, b()), 1);
        } else {
            assert_eq!(chain(&t), vec![c(), d(), a()]);
        }
        // (d) after the claim commits: the admitted vector is unchanged; the next capture sees it
        reset().await;
        let (ex, _ev) = shared(Arc::new(Script::default()), vec![]);
        let t = done(spawn_turn(&ex)).await;
        assert_eq!(chain(&t), vec![c(), b(), a()]);
        let w = if narrowing { Island::Narrow(b()) } else { mv() };
        ex.run(&w, &system_binding("w")).await.unwrap();
        let next = done(spawn_turn(&ex)).await;
        if narrowing {
            assert_eq!((scope_version_of(&t, b()), scope_version_of(&next, b())), (0, 1));
        } else {
            assert_eq!(chain(&next), vec![c(), d(), a()]);
        }
    }
}

async fn order_b(controls: Vec<&'static str>, narrowing: bool) -> (Turn, Arc<Events>) {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), controls);
    let (mut arrived, release) = script.hold_named("charter.capture.after_first_read");
    let turn = spawn_turn(&ex);
    arrive(&mut arrived).await;
    // the writer commits after the capture's first statement, before the claim
    let w = if narrowing { Island::Narrow(b()) } else { mv() };
    assert!(matches!(done(spawn_writer(&ex, w, "w")).await, Outcome::Applied(_)));
    release.add_permits(1);
    (done(turn).await, ev)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_b_a_writer_between_capture_and_claim_forces_a_complete_recapture() {
    let (t, _) = order_b(vec![], false).await;
    assert!(recaptures(&t) >= 1, "the stale vector was refused and recaptured (count recorded: {})", recaptures(&t));
    assert_eq!(chain(&t), vec![c(), d(), a()], "the turn runs on the new vector: Q's chain, not P's");
    let (t, _) = order_b(vec![], true).await;
    assert!(recaptures(&t) >= 1);
    assert_eq!(scope_version_of(&t, b()), 1, "the turn runs on the narrowed version");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_c_a_writer_meeting_the_claim_anchors_commits_after_the_claim() {
    for narrowing in [false, true] {
        reset().await;
        let script = Arc::new(Script::default());
        let (ex, ev) = shared(script.clone(), vec![]);
        let (mut arrived, release) = script.hold_named("runtime.admit.after_recheck");
        let turn = spawn_turn(&ex);
        arrive(&mut arrived).await;
        let w = if narrowing { Island::Narrow(b()) } else { mv() };
        let wh = spawn_writer(&ex, w, "w");
        assert!(still_waiting(&wh, 600).await, "the writer waits on the claim's anchors");
        release.add_permits(1);
        let t = done(turn).await;
        assert!(matches!(done(wh).await, Outcome::Applied(_)));
        let (claim, writer) = (claim_commit(&ev).unwrap(), ev.pos(&format!("commit:island.{}:w", if narrowing { "narrow" } else { "move" })).unwrap());
        assert!(claim < writer, "the writer's commit is recorded after the claim's");
        assert_eq!(chain(&t), vec![c(), b(), a()], "the admitted vector is unchanged");
        let next = done(spawn_turn(&ex)).await;
        if narrowing {
            assert_eq!(scope_version_of(&next, b()), 1);
        } else {
            assert_eq!(chain(&next), vec![c(), d(), a()], "the next capture sees the change");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_every_order_closes_the_capture_before_the_claim_and_runs_no_sql_during_input() {
    let (t, ev) = order_b(vec![], false).await;
    assert!(matches!(t, Turn::Ran { .. }));
    let snap = ev.snapshot();
    let b0 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.begin").expect("marker");
    let b1 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.end").expect("marker");
    assert!(!snap[b0..b1].iter().any(|e| e.starts_with("stmt:") || e.starts_with("begin:")), "no SQL during provider input");
    // every capture snapshot closed (rollback) before the next admit begins
    for (i, e) in snap.iter().enumerate() {
        if let Some(key) = e.strip_prefix("begin:charter.capture:") {
            let closed = snap.iter().position(|x| x == &format!("rollback:charter.capture:{key}")).expect("capture closed");
            let next_admit = snap[i..].iter().position(|x| x.starts_with("begin:runtime.admit:")).map(|p| p + i);
            if let Some(n) = next_admit {
                assert!(closed < n, "the capture transaction closed before the claim began");
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr1_a_pure_charter_edit_between_capture_and_claim_does_not_refuse_the_claim() {
    reset().await;
    admin_exec(&format!(
        "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) VALUES ('{o}', '{b}', 'team', 1, 'P0', 'x', now());
         INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ('{o}', '{b}', 'team', 1);",
        o = org(),
        b = b()
    ))
    .await;
    let script = Arc::new(Script::default());
    let (ex, _ev) = shared(script.clone(), vec![]);
    let (mut arrived, release) = script.hold_named("charter.capture.after_first_read");
    let turn = spawn_turn(&ex);
    arrive(&mut arrived).await;
    // a PURE edit (only the charter version row and its head)
    admin_exec(&format!(
        "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) VALUES ('{o}', '{b}', 'team', 2, 'P1', 'y', now());
         UPDATE charter_heads SET current_version = 2 WHERE org_id = '{o}' AND principal_id = '{b}' AND charter_kind = 'team';",
        o = org(),
        b = b()
    ))
    .await;
    release.add_permits(1);
    let t = done(turn).await;
    assert_eq!(recaptures(&t), 0, "charter edits are not permission epochs: the claim succeeds");
    let Turn::Ran { vector, .. } = &t else { panic!("{t:?}") };
    assert_eq!(vector.chain.iter().find(|n| n.node == b()).unwrap().team_charter, Some(1), "the vector is the one committed state the snapshot saw");
    let next = done(spawn_turn(&ex)).await;
    let Turn::Ran { vector, .. } = &next else { panic!("{next:?}") };
    assert_eq!(vector.chain.iter().find(|n| n.node == b()).unwrap().team_charter, Some(2), "the next capture returns the edit");
}

// ---------------------------------------------------------------- Q-CR2 controls

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_control_no_claim_recheck_admits_p_chain_after_the_move() {
    let (t, ev) = order_b(vec!["Q-CR2.no_claim_recheck"], false).await;
    assert!(ev.has("control_executed:Q-CR2.no_claim_recheck"), "the control ran");
    assert_eq!(chain(&t), vec![c(), b(), a()], "CONTROL FAILED AS DESIGNED: a turn admitted with P's chain after the move to Q committed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_control_no_anchor_lets_the_writer_commit_between_comparison_and_claim() {
    reset().await;
    let script = Arc::new(Script::default());
    let (ex, ev) = shared(script.clone(), vec!["Q-CR2.no_anchor"]);
    let (mut arrived, release) = script.hold_named("runtime.admit.after_recheck");
    let turn = spawn_turn(&ex);
    arrive(&mut arrived).await;
    assert!(matches!(done(spawn_writer(&ex, mv(), "w")).await, Outcome::Applied(_)), "without anchors the move does not wait");
    release.add_permits(1);
    let t = done(turn).await;
    assert!(ev.has("control_executed:Q-CR2.no_anchor"), "the control ran");
    let (claim, writer) = (claim_commit(&ev).unwrap(), ev.pos("commit:island.move:w").unwrap());
    assert!(writer < claim && chain(&t) == vec![c(), b(), a()], "CONTROL FAILED AS DESIGNED: the move committed before the claim, yet the claim admitted the old vector");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_control_partial_recapture_mixes_q_chain_with_p() {
    let (t, ev) = order_b(vec!["Q-CR2.partial_recapture"], false).await;
    assert!(ev.has("control_executed:Q-CR2.partial_recapture"), "the control ran");
    let Turn::Ran { vector, .. } = &t else { panic!("{t:?}") };
    let s_parent = vector.chain.first().and_then(|n| n.parent);
    let has_p = vector.chain.iter().any(|n| n.node == b());
    assert!(s_parent == Some(d()) && has_p, "CONTROL FAILED AS DESIGNED: S's parent is Q but the vector still carries P ({:?})", vector.chain.iter().map(|n| n.node).collect::<Vec<_>>());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr2_control_snapshot_held_over_input_is_visible_in_the_trace() {
    reset().await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec!["Q-CR2.snapshot_held_over_input"]);
    // a message, so the turn has an input step
    let m = new_id();
    ex.run(&agent_send(Target::Agent { principal: c() }, m, orgtree_store::sent::MailClass::Message), &agent_binding(b(), "in", "in")).await.unwrap();
    orgtree_store::mail::receive::deliver(&ex, org(), mb(c()), m).await.unwrap();
    let t = runtime::run_turn(&ex, org(), c(), &FakeProvider { tamper: false }).await.unwrap();
    assert!(matches!(t, Turn::Ran { .. }), "{t:?}");
    assert!(ev.has("control_executed:Q-CR2.snapshot_held_over_input"), "the control ran");
    let snap = ev.snapshot();
    let b0 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.begin").unwrap();
    let b1 = snap.iter().position(|e| e == "mark:runtime.turn.provider_input.end").unwrap();
    let open_capture = snap[..b0].iter().filter_map(|e| e.strip_prefix("begin:charter.capture:")).any(|k| {
        let closed = snap.iter().position(|x| x == &format!("rollback:charter.capture:{k}"));
        closed.map(|c| c > b1).unwrap_or(true)
    });
    assert!(open_capture, "CONTROL FAILED AS DESIGNED: a capture transaction was open during the provider's input step (and the trace can see it)");
}

// ---------------------------------------------------------------- Q-CR3

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr3_a_and_b_a_failed_capture_is_recaptured_in_a_fresh_snapshot() {
    for action in [HookAction::FailNext("40001".into()), HookAction::DropConn] {
        reset().await;
        let script = Arc::new(Script::default());
        let (ex, ev) = shared(script.clone(), vec![]);
        // T0
        assert!(matches!(done(spawn_turn(&ex)).await, Turn::Ran { .. }));
        // E_A commits (A's team charter), then T1's capture fails at P's head
        admin_exec(&format!(
            "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) VALUES ('{o}', '{a}', 'team', 1, 'A1', 'x', now());
             INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ('{o}', '{a}', 'team', 1);",
            o = org(),
            a = a()
        ))
        .await;
        script.act_named("charter.capture.stmt.capture.node.before", action.clone());
        let claims_before = count("SELECT count(*) FROM runtime_claims").await;
        let t = done(spawn_turn(&ex)).await;
        let Turn::Ran { vector, .. } = &t else { panic!("{action:?}: {t:?}") };
        assert_eq!(vector.chain.iter().find(|n| n.node == a()).unwrap().team_charter, Some(1), "{action:?}: T1 runs with (A1, P0) from a fresh snapshot");
        assert_eq!(count("SELECT count(*) FROM runtime_claims").await, claims_before + 1, "{action:?}: no claim from the failed attempt");
        let _ = ev;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_cr3_c_controls_cached_fallback_and_skip_missing_run_stale_or_partial() {
    for control in ["Q-CR3.cached_fallback", "Q-CR3.skip_missing"] {
        reset().await;
        admin_exec(&format!(
            "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) VALUES ('{o}', '{b}', 'team', 1, 'P0', 'x', now());
             INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ('{o}', '{b}', 'team', 1);",
            o = org(),
            b = b()
        ))
        .await;
        let (ex, ev) = shared(Arc::new(Script::default()), vec![control]);
        assert!(matches!(done(spawn_turn(&ex)).await, Turn::Ran { .. }), "T0");
        // P's body goes missing behind its head (the fixture proves it ran)
        admin_exec("ALTER TABLE charter_heads DROP CONSTRAINT charter_heads_version_fk; DELETE FROM charter_versions;").await;
        assert_eq!(count("SELECT count(*) FROM charter_versions").await, 0, "fixture executed");
        let t = done(spawn_turn(&ex)).await;
        assert!(ev.has(&format!("control_executed:{control}")), "{control}: the control ran");
        assert!(matches!(t, Turn::Ran { .. }), "CONTROL FAILED AS DESIGNED ({control}): T1 ran on a stale or partial vector instead of failing closed: {t:?}");
    }
}
