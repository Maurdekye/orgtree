//! WS3b database tests, part 1: every island topology/lifecycle writer
//! applied once on a real PostgreSQL (schedule-grade writers; no
//! concurrency here — the schedules are in `ws3b_sched_pg.rs`).
//!
//! Fixture (common_ws3b, WS5's shape): alpha (top) → bravo → charlie →
//! foxtrot; alpha → delta; echo (top). This file sets every scope row's
//! visibility to `full` (the fixture's `all` is not a legacy level, which the
//! clamp model leaves untouched, D9) and adds the `caps` control.
#![cfg(feature = "qualification")]

mod common_ws3b;

use common_ws3b::*;
use orgtree_store::lifecycle::harness::Island;
use orgtree_store::lifecycle::rehire::Rehire;
use orgtree_store::lifecycle::remove::{Remove, RemoveKind};
use orgtree_store::lifecycle::retool::{Retool, RetoolKind, ScopeChange};
use orgtree_store::lifecycle::split::{Lineage, Split, SplitKind};
use orgtree_store::lifecycle::topo::Move;
use orgtree_store::{Outcome, Uuid};

async fn setup() {
    reset().await;
    admin_exec(&format!(
        "UPDATE scope_rows SET visibility = 'full';
         INSERT INTO org_controls (org_id, family, value) VALUES ('{o}', 'caps', '{{\"max_depth\": 8, \"max_children\": 16}}');
         INSERT INTO seat_config (org_id, principal_id, tier) SELECT org_id, principal_id, 'opus' FROM agents;",
        o = org()
    ))
    .await;
}

fn applied<T: std::fmt::Debug>(o: &Outcome<T>) -> bool {
    matches!(o, Outcome::Applied(_))
}

async fn lifecycle(x: Uuid) -> String {
    text(&format!("SELECT coalesce((SELECT lifecycle FROM authority_epoch WHERE principal_id = '{x}'), 'gone')")).await
}

async fn parent(x: Uuid) -> String {
    text(&format!("SELECT coalesce((SELECT parent_id::text FROM topology_edges WHERE principal_id = '{x}'), 'none')")).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn rehire_revives_an_archived_node_and_its_archived_chain() {
    setup().await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id IN ('{}', '{}')", b(), c())).await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Rehire { node: c(), tier: None }, &system_binding("rh")).await.unwrap();
    let Outcome::Applied(out) = o else { panic!("{o:?}") };
    assert_eq!(out.rehired, vec![b(), c()], "the archived superior first, then the target");
    assert_eq!(lifecycle(b()).await, "live");
    assert_eq!(lifecycle(c()).await, "live");
    assert_eq!(count(&format!("SELECT generation FROM authority_epoch WHERE principal_id = '{}'", c())).await, 2);
    // live target: the E-D10 no-op
    let o = ex.run(&Rehire { node: c(), tier: None }, &system_binding("rh2")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(ref r) if r.noop), "{o:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn retire_archives_a_leaf_moots_its_requests_and_keeps_its_grants() {
    setup().await;
    admin_exec(&format!(
        "INSERT INTO request_batches (org_id, batch_id, asker_id, kind, state, payload, created_at) VALUES ('{o}', gen_random_uuid(), '{f}', 'ask', 'pending', '{{}}', now());
         INSERT INTO audience_grants (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) VALUES ('{o}', '{f}', 'agent', '{a}', '{a}', now());",
        o = org(), f = f(), a = a()
    ))
    .await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Remove { kind: RemoveKind::Retire, node: f() }, &agent_binding(c(), "ret", "fp")).await.unwrap();
    assert!(applied(&o), "{o:?}");
    assert_eq!(lifecycle(f()).await, "archived");
    assert_eq!(count(&format!("SELECT count(*) FROM request_batches WHERE asker_id = '{}' AND state = 'pending'", f())).await, 0, "P7: mooted");
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}'", f())).await, 1, "retire is paging: grants survive");
    // a superior's retire of a node with live reports becomes a dissolve
    let o = ex.run(&Remove { kind: RemoveKind::Retire, node: b() }, &agent_binding(a(), "ret2", "fp")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert!(r.nodes.contains(&b()) && r.nodes.contains(&c()), "{r:?}");
    assert!(r.warnings.iter().any(|w| w.contains("dissolve")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn delete_is_user_only_and_takes_the_subtree_and_its_names() {
    setup().await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Remove { kind: RemoveKind::Delete, node: c() }, &agent_binding(a(), "del-agent", "fp")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(_)), "only the user deletes: {o:?}");
    let o = ex.run(&Remove { kind: RemoveKind::Delete, node: c() }, &system_binding("del")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.nodes.len(), 2, "charlie and foxtrot: {r:?}");
    for x in [c(), f()] {
        assert_eq!(lifecycle(x).await, "gone");
        assert_eq!(parent(x).await, "none");
        assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE principal_id = '{x}'")).await, 0);
        assert_eq!(text(&format!("SELECT state FROM mailboxes WHERE owner_id = '{x}'")).await, "closed");
    }
    assert_eq!(count("SELECT count(*) FROM restrictions WHERE reason = 'delete'").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn move_reparents_sweeps_stale_grants_and_clamps_the_subtree() {
    setup().await;
    // f holds a grant anchored at b; moving c (f's parent) under d leaves b
    // off f's chain, so it is swept; a grant anchored at a survives.
    admin_exec(&format!(
        "INSERT INTO audience_grants (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) VALUES
           ('{o}', '{f}', 'agent', '{b}', '{b}', now()), ('{o}', '{f}', 'agent', '{e}', '{a}', now());
         UPDATE scope_rows SET visibility = 'team' WHERE principal_id = '{d}';",
        o = org(), f = f(), b = b(), e = e(), a = a(), d = d()
    ))
    .await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Move { node: c(), new_parent: Some(d()) }, &system_binding("mv")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.swept, 1, "{r:?}");
    assert_eq!(parent(c()).await, d().to_string());
    assert_eq!(count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}'", f())).await, 1);
    assert_eq!(text(&format!("SELECT visibility FROM scope_rows WHERE principal_id = '{}'", f())).await, "team", "clamped to the new chain");
    assert_eq!(count(&format!("SELECT depth FROM scope_rows WHERE principal_id = '{}'", f())).await, 3, "depth rewritten");
    // the cycle guard
    let o = ex.run(&Move { node: d(), new_parent: Some(f()) }, &system_binding("mv2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "cycle"), "{o:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_split_mints_a_bearer_and_a_later_move_carries_the_stack() {
    setup().await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Split { seat: b(), kind: SplitKind::CheapCompact }, &system_binding("cc")).await.unwrap();
    let Outcome::Applied(s) = o else { panic!("{o:?}") };
    assert_eq!(s.generation, 1);
    assert_eq!(parent(s.bearer).await, a().to_string(), "the bearer sits in the seat's slot");
    assert_eq!(lifecycle(s.bearer).await, "archived");
    assert_eq!(count(&format!("SELECT generation FROM authority_epoch WHERE principal_id = '{}'", b())).await, 2);
    assert_eq!(text(&format!("SELECT name FROM agent_names WHERE principal_id = '{}'", s.bearer)).await, "bravo@1");
    let o = ex.run(&Move { node: b(), new_parent: Some(e()) }, &system_binding("mv")).await.unwrap();
    assert!(applied(&o), "{o:?}");
    assert_eq!(parent(b()).await, e().to_string());
    assert_eq!(parent(s.bearer).await, e().to_string(), "the stack moves as one unit");
    // a bearer never moves on its own
    let o = ex.run(&Move { node: s.bearer, new_parent: Some(a()) }, &system_binding("mv2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "lineage_bearer"), "{o:?}");
    // lineage repair: a lost generation recovered, a switch split mooting asks
    let o = ex.run(&Split { seat: b(), kind: SplitKind::CliCompaction { lost: true } }, &system_binding("cli")).await.unwrap();
    let Outcome::Applied(lost) = o else { panic!("{o:?}") };
    let o = ex.run(&Lineage::RecoverLost { bearer: lost.bearer }, &system_binding("rec")).await.unwrap();
    assert!(applied(&o), "{o:?}");
    assert_eq!(text(&format!("SELECT bearer_state FROM lineage_bearers WHERE bearer_id = '{}'", lost.bearer)).await, "knowledge");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn reseed_revives_an_unrecoverable_seat_with_a_lost_generation() {
    setup().await;
    let (ex, _ev) = executor(vec![]);
    assert!(applied(&ex.run(&Lineage::MarkUnrecoverable { seat: c() }, &system_binding("mu")).await.unwrap()));
    assert_eq!(lifecycle(c()).await, "unrecoverable");
    // rehire of an unrecoverable node becomes a re-seed (legacy)
    let o = ex.run(&Rehire { node: c(), tier: None }, &system_binding("rh")).await.unwrap();
    assert!(applied(&o), "{o:?}");
    assert_eq!(lifecycle(c()).await, "live");
    assert_eq!(count(&format!("SELECT count(*) FROM lineage_bearers WHERE seat_id = '{}' AND bearer_state = 'lost'", c())).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn narrowing_clamps_the_subtree_and_widening_raises_the_chain() {
    setup().await;
    let (ex, _ev) = executor(vec![]);
    let o = ex.run(&Retool { target: b(), kind: RetoolKind::Set(ScopeChange { visibility: Some("team".into()), ..Default::default() }) }, &agent_binding(a(), "nar", "fp")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.clamped, 2, "charlie and foxtrot clamped: {r:?}");
    assert_eq!(text(&format!("SELECT visibility FROM scope_rows WHERE principal_id = '{}'", f())).await, "team");
    assert_eq!(count("SELECT count(*) FROM restrictions WHERE reason = 'retool'").await, 1);
    // D-106: alpha (full) grants foxtrot `subtree`; bravo and charlie raised
    let o = ex.run(
        &Retool { target: f(), kind: RetoolKind::Widen { granter: a(), change: ScopeChange { visibility: Some("subtree".into()), ..Default::default() } } },
        &agent_binding(a(), "wid", "fp"),
    )
    .await
    .unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.raised, 3, "{r:?}");
    for x in [b(), c(), f()] {
        assert_eq!(text(&format!("SELECT visibility FROM scope_rows WHERE principal_id = '{x}'")).await, "subtree");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn a_pure_charter_edit_bumps_no_scope_or_epoch_version() {
    setup().await;
    let before = text("SELECT string_agg(principal_id::text || ':' || version, ',' ORDER BY principal_id) FROM authority_epoch").await
        + &text("SELECT string_agg(principal_id::text || ':' || version, ',' ORDER BY principal_id) FROM scope_rows").await;
    let (ex, _ev) = executor(vec![]);
    for (i, kind) in ["role", "team", "role"].into_iter().enumerate() {
        let o = ex.run(&Retool { target: c(), kind: RetoolKind::Charter { kind: kind.into(), body: format!("charter {i}") } }, &agent_binding(b(), &format!("ch{i}"), "fp")).await.unwrap();
        assert!(applied(&o), "{o:?}");
    }
    let after = text("SELECT string_agg(principal_id::text || ':' || version, ',' ORDER BY principal_id) FROM authority_epoch").await
        + &text("SELECT string_agg(principal_id::text || ':' || version, ',' ORDER BY principal_id) FROM scope_rows").await;
    assert_eq!(before, after, "Q-CR1: pure");
    assert_eq!(count(&format!("SELECT current_version FROM charter_heads WHERE principal_id = '{}' AND charter_kind = 'role'", c())).await, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn the_stand_in_shaped_island_runs_every_variant() {
    setup().await;
    let (ex, _ev) = executor(vec![]);
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", d())).await;
    for (i, cmd) in [
        Island::Rehire(d()),
        Island::Move { node: c(), new_parent: Some(d()) },
        Island::Fold(b()),
        Island::Narrow(a()),
        Island::Delete(e()),
        Island::NamesakeHire { principal: new_id(), name: "echo", parent: Some(a()) },
    ]
    .into_iter()
    .enumerate()
    {
        let o = ex.run(&cmd, &system_binding(&format!("i{i}"))).await.unwrap();
        assert!(applied(&o), "variant {i}: {o:?}");
    }
}
