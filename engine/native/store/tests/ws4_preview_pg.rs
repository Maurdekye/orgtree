//! WS4 preview of `reallocate` on a real PostgreSQL (r7 §6; D10, D11):
//! Q-P1–Q-P6. Run ONLY through the P03 run lock (`artifacts\run-pg.ps1
//! -Test ws4_preview_pg` via `p03-run.ps1`).
#![cfg(feature = "qualification")]

mod common_ws4;

use std::collections::BTreeMap;

use common_ws4::*;
use orgtree_funding_core::pynum::PyNum;
use orgtree_store::claims::ClaimRegistry;
use orgtree_store::funding::Reallocate;
use orgtree_store::preview::{self, Decision, PreviewReallocate, RollbackPreview};
use orgtree_store::strict::{self, OrgLockedRead};
use orgtree_store::work::WorkCreate;
use orgtree_store::{Binding, Outcome, Uuid};
use serde_json::{json, Value};

fn pq(me: Option<Uuid>, node: Uuid, delta: i128) -> PreviewReallocate {
    PreviewReallocate { org: org(), me: me.map(|m| (m, 1)), node, delta: PyNum::Int(delta), include_archived: false }
}

async fn grants() -> BTreeMap<String, i64> {
    let c = {
        let (c, conn) = tokio_postgres::connect(&url("P03_PG_ADMIN_URL"), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        c
    };
    c.query("SELECT a.name, f.grant_centi FROM funding_edges f JOIN agents a ON a.org_id = f.org_id AND a.principal_id = f.child_id", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1)))
        .collect()
}

/// Q-P3's parity oracle: the preview's decision equals the real command's
/// decision executed alone at the same state (refusal class and text, write
/// set, result).
async fn parity(x: &Ex, me: Option<Uuid>, node: Uuid, delta: i128, key: &str) -> Result<(), String> {
    let reg = ClaimRegistry::new();
    let (_h, p) = preview::preview(&x.ex, &reg, pq(me, node, delta)).await.unwrap();
    let (_before, d) = p.map_err(|r| format!("preview refused the caller: {r:?}"))?;
    let g0 = grants().await;
    let b: Binding = match me {
        Some(m) => agent_binding(m, key),
        None => user_binding(key),
    };
    let real = x.ex.run(&Reallocate::new(node, PyNum::Int(delta)), &b).await.unwrap();
    let g1 = grants().await;
    let written: BTreeMap<String, i64> = g1.iter().filter(|(k, v)| g0.get(*k) != Some(v)).map(|(k, v)| (k.clone(), *v)).collect();
    match (&d, &real) {
        (Decision::Refused(pr), Outcome::Refused(rr)) if pr.code == rr.code && pr.message == rr.message => Ok(()),
        (Decision::Applied { grant, warnings, changes }, Outcome::Applied(r)) if *grant == r.grant && *warnings == r.warnings && *changes == written => Ok(()),
        _ => Err(format!("preview {d:?} vs real {real:?} (written {written:?})")),
    }
}

// ================================================================ Q-P3 / Q-P6: parity over a fixture matrix, and the predicate mutation

type Case = (&'static str, fn() -> (Option<Uuid>, Uuid, i128), &'static str);

fn cases() -> Vec<Case> {
    vec![
        ("agent gives from own free", || (Some(b()), c(), 3), ""),
        ("agent chain short at the last credit", || (Some(b()), c(), 4), "last_credit"),
        ("user deep bubbling with whole-credit carry", || (None, c(), 20), "fractional"),
        ("reduction beyond free", || (None, c(), -50), ""),
        ("no authority", || (Some(d()), c(), 1), ""),
        ("top-level grant cap", || (None, a(), 500), "cap"),
        ("kiosk pool cap", || (None, e(), 10), "kiosk"),
    ]
}

async fn setup(tag: &str) {
    reset().await;
    match tag {
        "last_credit" => admin_exec(&format!("UPDATE funding_edges SET grant_centi = 1400 WHERE child_id = '{c}'; UPDATE issuer_capacity SET child_grants_centi = 1400 WHERE principal_id = '{b}';", c = c(), b = b())).await,
        "fractional" => admin_exec(&format!("UPDATE agents SET tier = 'sonnet' WHERE principal_id = '{c}'; UPDATE funding_edges SET tier = 'sonnet' WHERE child_id = '{c}'; UPDATE issuer_capacity SET child_seats = '{{\"sonnet\": 1}}' WHERE principal_id = '{b}'; UPDATE price_catalog SET seat_centi = 250 WHERE tier = 'sonnet';", c = c(), b = b())).await,
        "cap" => admin_exec("UPDATE org_controls SET value = '{\"max_top_grant\": 120}' WHERE family = 'caps'").await,
        "kiosk" => admin_exec(&format!("UPDATE organizations SET kiosk = true; INSERT INTO kiosk_pool (org_id, pool_centi, top_grants_centi, top_seats) VALUES ('{}', 16000, 15000, '{{\"opus\": 2}}');", org())).await,
        _ => {}
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p3_preview_decides_exactly_as_the_real_command() {
    for (label, f, tag) in cases() {
        setup(tag).await;
        let x = executor(vec![]);
        let (me, node, delta) = f();
        parity(&x, me, node, delta, "real").await.unwrap_or_else(|e| panic!("{label}: {e}"));
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p6_a_dropped_predicate_is_caught_by_the_parity_fixture() {
    let mut caught = Vec::new();
    for (label, f, tag) in cases() {
        setup(tag).await;
        let x = executor(vec!["Q-P6.drop_seat_prices"]);
        let (me, node, delta) = f();
        if parity(&x, me, node, delta, "real").await.is_err() {
            caught.push(label);
        }
        if label == "agent chain short at the last credit" {
            assert!(x.ev.has("control_executed:Q-P6.drop_seat_prices"), "the mutation did not run");
        }
    }
    assert!(!caught.is_empty(), "no parity case failed with the seat prices dropped from the read set: the fixtures detect nothing");
}

// ================================================================ the rendered preview

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn preview_renders_before_after_and_the_positional_diff() {
    reset().await;
    let x = executor(vec![]);
    set_team(b(), "subtree").await;
    let reg = ClaimRegistry::new();
    let (h, p) = preview::preview(&x.ex, &reg, pq(Some(b()), c(), 3)).await.unwrap();
    let (before, d) = p.unwrap();
    let v = preview::render(before, &d).unwrap();
    let v = strict::emit(&x.ex, org(), h.unwrap(), "Q-P4.fence_disabled", v).await.unwrap();
    assert_eq!(v["applied"], json!(false));
    assert_eq!(v["result"]["grant"], json!(8));
    let changes = v["changes"].as_array().unwrap();
    assert!(changes.iter().any(|c| c["after"] == json!(8) && c["before"] == json!(5)), "{changes:?}");
    assert!(changes.iter().any(|c| c["before"] == json!(12) && c["after"] == json!(9)), "bravo's free moves: {changes:?}");
    assert_eq!(grants().await.get("charlie"), Some(&500), "a preview writes nothing");
}

async fn set_team(who: Uuid, v: &str) {
    admin_exec(&format!("UPDATE scope_rows SET visibility = '{v}' WHERE principal_id = '{who}'")).await;
}

// ================================================================ Q-P1: bounded reads

async fn p1_rows(control: bool, history: i64) -> usize {
    reset().await;
    admin_exec(&format!(
        "INSERT INTO transcript_entries (org_id, principal_id, seq, role, body, at) SELECT '{}', '{}', g, 'assistant', 'h', now() FROM generate_series(1, {history}) g",
        org(),
        e()
    ))
    .await;
    let x = executor(if control { vec!["Q-P1.whole_document"] } else { vec![] });
    let reg = ClaimRegistry::new();
    let before = x.ev.rows_total();
    let (_h, p) = preview::preview(&x.ex, &reg, pq(Some(b()), c(), 1)).await.unwrap();
    assert!(p.is_ok());
    x.ev.rows_total() - before
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p1_reads_do_not_grow_with_history() {
    assert_eq!(p1_rows(false, 100).await, p1_rows(false, 1000).await, "rows grew with unrelated history");
    let (c1, c10) = (p1_rows(true, 100).await, p1_rows(true, 1000).await);
    assert!(c10 > c1, "control executed but reads did not grow: {c1} -> {c10}");
}

// ================================================================ Q-P2 / Q-P5: writers are never blocked by previews

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p2_q_p5_previews_never_block_writers() {
    // an agent preview and an operator preview held after their snapshot
    for me in [Some(b()), None] {
        reset().await;
        let x = executor(vec![]);
        let reg = ClaimRegistry::new();
        let mut h = x.script.hold(None, "preview.reallocate.after_snapshot");
        let w = Reallocate::new(c(), PyNum::Int(2));
        let bw = agent_binding(b(), "w");
        let (_, (o, no_wait)) = tokio::join!(preview::preview(&x.ex, &reg, pq(me, c(), 3)), while_held(&mut h, 1500, x.ex.run(&w, &bw)));
        assert!(matches!(o, Ok(Outcome::Applied(_))), "{o:?}");
        assert!(no_wait, "operator={}: the writer waited on a preview", me.is_none());
        assert_eq!(x.ev.count_prefix("retry:"), 0, "an abort attributable to the preview");
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p2_control_run_and_roll_back_blocks_the_writer() {
    reset().await;
    let x = executor(vec!["Q-P2.run_and_roll_back"]);
    let mut h = x.script.hold(Some("pv"), "preview.reallocate_rollback.after_plan");
    let pv = RollbackPreview::new(c(), PyNum::Int(3));
    let bp = user_binding("pv");
    let w = Reallocate::new(c(), PyNum::Int(2));
    let bw = agent_binding(b(), "w");
    let (_, (o, no_wait)) = tokio::join!(x.ex.run(&pv, &bp), while_held(&mut h, 1500, x.ex.run(&w, &bw)));
    assert!(x.ev.has("control_executed:Q-P2.run_and_roll_back"), "control did not record that it executed");
    assert!(matches!(o, Ok(Outcome::Applied(_))));
    assert!(!no_wait, "control executed but the writer did not wait: it proves nothing");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p5_control_operator_preview_under_org_lock_blocks_writers() {
    reset().await;
    let x = executor(vec!["Q-P5.org_wide_lock"]);
    let mut h = x.script.hold(Some("rd"), "strict.locked.read.after_snapshot");
    let r = OrgLockedRead { control: "Q-P5.org_wide_lock" };
    let br = user_binding("rd");
    let w = WorkCreate { item: new_id(), name: "fresh".into(), title: "t".into(), status: "open".into(), owner: Some(e()), participants: vec![] };
    let bw = user_binding("w");
    let (_, (o, no_wait)) = tokio::join!(x.ex.run(&r, &br), while_held(&mut h, 1500, x.ex.run(&w, &bw)));
    assert!(x.ev.has("control_executed:Q-P5.org_wide_lock"));
    assert!(matches!(o, Ok(Outcome::Applied(_))));
    assert!(!no_wait, "control executed but the writer did not wait");
}

// ================================================================ Q-P4: withheld on a restriction or generation change

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_p4_preview_withheld_after_restriction() {
    for control in [false, true] {
        reset().await;
        let x = executor(if control { vec!["Q-P4.fence_disabled"] } else { vec![] });
        let svc = Uuid::from_u128(0x5e42);
        register_read_service(&x, svc).await;
        let reg = ClaimRegistry::new();
        let (h, p) = preview::preview(&x.ex, &reg, pq(Some(b()), c(), 3)).await.unwrap();
        let (before, d) = p.unwrap();
        let v: Value = preview::render(before, &d).unwrap();
        // the caller's generation changes (a rehire)
        assert!(matches!(x.ex.run(&Racer::Rehire { node: b() }, &system_binding("rh")).await, Ok(Outcome::Applied(()))));
        assert!(!strict::consume_restrictions(&x.ex, &reg, org(), svc).await.unwrap().is_empty());
        let out = strict::emit(&x.ex, org(), h.unwrap(), "Q-P4.fence_disabled", v).await;
        assert_eq!(out.is_err(), !control, "control={control}");
        if control {
            assert!(x.ev.has("control_executed:Q-P4.fence_disabled"));
        }
    }
}
