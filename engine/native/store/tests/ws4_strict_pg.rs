//! WS4 strict (protected) reads on a real PostgreSQL (the WS1 dev cluster of
//! p03-ws4-rcfamilies): `material.*` (r7 §4, Q-M1–Q-M7), `diagnostic.*`
//! (r7 §5, Q-D1–Q-D6) and `chart.read` (S3 §4.2, Q-CH1, Q-CH2).
//!
//! The C5 interleaving is driven directly: the test registers the claim and
//! takes the snapshot (`strict::inspect`/`chart`/`material`), commits the
//! narrowing writer (which records its restriction in its own transaction),
//! runs the read service's restriction consumer until the restriction is
//! Effective, and only then asks `strict::emit` to release the answer.
//! Run ONLY through the P03 run lock (`artifacts\run-pg.ps1 -Test
//! ws4_strict_pg` via `p03-run.ps1`).
#![cfg(feature = "qualification")]

mod common_ws4;

use std::sync::Arc;

use common_ws4::*;
use orgtree_store::claims::ClaimRegistry;
use orgtree_store::strict::{self, Capabilities, Chart, Inspect, Material, MintTranscriptIdentity, OrgLockedRead};
use orgtree_store::work::{Archive, WorkCreate, WorkUpdate};
use orgtree_store::{Outcome, Uuid};
use serde_json::{json, Value};

fn service() -> Uuid {
    Uuid::from_u128(0x5e41)
}

struct Svc {
    x: Ex,
    reg: Arc<ClaimRegistry>,
}

async fn svc(controls: Vec<&'static str>) -> Svc {
    let x = executor(controls);
    register_read_service(&x, service()).await;
    Svc { x, reg: ClaimRegistry::new() }
}

impl Svc {
    /// The read service applies every pending restriction and returns how
    /// many became Effective.
    async fn consume(&self) -> usize {
        strict::consume_restrictions(&self.x.ex, &self.reg, org(), service()).await.unwrap().len()
    }
}

async fn run_ok<T: std::fmt::Debug>(o: Result<Outcome<T>, orgtree_store::ExecError>) {
    assert!(matches!(o, Ok(Outcome::Applied(_))), "{o:?}");
}

fn inspect_q(me: Uuid) -> Inspect {
    Inspect { org: org(), me, generation: 1, targets: vec![], include_archived: false, skip_free: false }
}

fn chart_q(me: Uuid) -> Chart {
    Chart { org: org(), me, generation: 1, include_archived: false, include_standing_charter: true, roster_only: false, credits_only: false }
}

fn material_q(me: Uuid, target: Uuid, last: i64) -> Material {
    Material { org: org(), me, generation: 1, target, last }
}

async fn set_visibility(who: Uuid, v: &str) {
    admin_exec(&format!("UPDATE scope_rows SET visibility = '{v}' WHERE principal_id = '{who}'")).await;
}

/// The item fixture for the item route: delta held it first, then bravo
/// (the current holder); charlie is a participant.
async fn handed_over_item(x: &Ex) -> Uuid {
    let it = new_id();
    run_ok(x.ex.run(&WorkCreate { item: it, name: "item-m".into(), title: "the item".into(), status: "open".into(), owner: Some(d()), participants: vec![c()] }, &user_binding("mk")).await).await;
    run_ok(x.ex.run(&WorkUpdate { item: it, owner: Some(Some(b())), ..Default::default() }, &user_binding("hand")).await).await;
    it
}

// ================================================================ material: the three routes and the refusal

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn material_routes_follow_legacy_order_and_bounds() {
    reset().await;
    let s = svc(vec![]).await;
    handed_over_item(&s.x).await;
    admin_exec(&format!(
        "INSERT INTO transcript_entries (org_id, principal_id, seq, role, body, at) SELECT '{}', '{}', g, 'assistant', repeat('x', 2000), now() FROM generate_series(1, 30) g",
        org(),
        d()
    ))
    .await;
    // self
    let (h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), c(), 5), None).await.unwrap();
    assert_eq!(strict::emit(&s.x.ex, org(), h, "Q-M1.fence_disabled", a.unwrap()).await.unwrap()["access"]["via"], json!("self"));
    // chart: bravo reads its report charlie
    let (h, a) = strict::material(&s.x.ex, &s.reg, material_q(b(), c(), 5), None).await.unwrap();
    assert_eq!(strict::emit(&s.x.ex, org(), h, "Q-M1.fence_disabled", a.unwrap()).await.unwrap()["access"]["via"], json!("chart"));
    // item: charlie (participant) reads delta (an earlier holder), bounded content
    let (h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 50), None).await.unwrap();
    let v = strict::emit(&s.x.ex, org(), h, "Q-M1.fence_disabled", a.unwrap()).await.unwrap();
    assert_eq!(v["access"]["via"], json!("item"));
    assert_eq!(v["access"]["item"], json!("item-m"));
    assert_eq!(v["access"]["standing"], json!("participant"));
    let entries = v["entries"].as_array().unwrap();
    assert!(entries.iter().all(|e| e["text"].as_str().unwrap().chars().count() <= strict::MAX_MESSAGE_CHARS));
    assert!(entries.len() <= 16, "20 000 characters at 1 200 per message: {}", entries.len());
    // refused: the current holder (D7), and an unrelated peer
    let (_h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), b(), 5), None).await.unwrap();
    assert!(a.unwrap_err().message.starts_with("read access is strictly DOWNWARD (§7.6)"));
    let (_h, a) = strict::material(&s.x.ex, &s.reg, material_q(e(), a_(), 5), None).await.unwrap();
    assert_eq!(a.unwrap_err().code, "not_readable");
    // scratch: files read after the snapshot, inside the folder only
    let root = std::env::temp_dir().join(format!("ws4-scratch-{}", new_id()));
    std::fs::create_dir_all(root.join("delta")).unwrap();
    std::fs::write(root.join("delta").join("notes.md"), "hello").unwrap();
    std::fs::write(root.join("outside.md"), "secret").unwrap();
    let (h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 0), Some(&root)).await.unwrap();
    let v = strict::emit(&s.x.ex, org(), h, "Q-M1.fence_disabled", a.unwrap()).await.unwrap();
    assert_eq!(v["files"], json!([{"file": "notes.md", "text": "hello"}]));
    let _ = std::fs::remove_dir_all(&root);
}

fn a_() -> Uuid {
    a()
}

// ================================================================ Q-M1: a restriction between claim and emit, per route

/// One Q-M1 case: build the answer, commit `writer`, make its restriction
/// Effective, then emit. Returns (restrictions made Effective, withheld?).
async fn q_m1_case(control: bool, reader: Uuid, target: Uuid, writer: impl std::future::Future<Output = ()>, s: &Svc) -> (usize, bool) {
    let _ = control;
    // drain the fixture's own restrictions (its hand-over recorded one)
    s.consume().await;
    let (h, a) = strict::material(&s.x.ex, &s.reg, material_q(reader, target, 3), None).await.unwrap();
    let a = a.expect("the answer is granted before the restriction");
    writer.await;
    let n = s.consume().await;
    let out = strict::emit(&s.x.ex, org(), h, "Q-M1.fence_disabled", a).await;
    (n, out.is_err())
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m1_every_restriction_withholds_and_closing_does_not() {
    for control in [false, true] {
        let controls = if control { vec!["Q-M1.fence_disabled"] } else { vec![] };
        // chart route: bravo reads charlie; charlie moves under delta
        reset().await;
        let s = svc(controls.clone()).await;
        let mv = Racer::Move { node: c(), new_parent: Some(d()) };
        let (n, withheld) = q_m1_case(control, b(), c(), async { run_ok(s.x.ex.run(&mv, &system_binding("mv")).await).await }, &s).await;
        assert!(n >= 1, "the move recorded no Effective restriction");
        assert_eq!(withheld, !control, "chart route, control={control}");
        // item route restrictions
        for (label, upd) in [
            ("unlist the reader", WorkUpdate { remove_participants: vec![c()], ..Default::default() }),
            ("archive: drop", WorkUpdate { archive: Some(Archive::Drop), ..Default::default() }),
            ("archive: timed", WorkUpdate { archive: Some(Archive::Timed), ..Default::default() }),
            ("archive: explicit", WorkUpdate { archive: Some(Archive::Explicit), ..Default::default() }),
            ("assign to the target", WorkUpdate { owner: Some(Some(d())), ..Default::default() }),
        ] {
            reset().await;
            let s = svc(controls.clone()).await;
            let it = handed_over_item(&s.x).await;
            let w = WorkUpdate { item: it, ..upd };
            let (n, withheld) = q_m1_case(control, c(), d(), async { run_ok(s.x.ex.run(&w, &user_binding("w")).await).await }, &s).await;
            assert!(n >= 1, "{label}: no Effective restriction");
            assert_eq!(withheld, !control, "{label}, control={control}");
        }
        // the reader retired
        reset().await;
        let s = svc(controls.clone()).await;
        handed_over_item(&s.x).await;
        let rt = Racer::Retire { node: c() };
        let (n, withheld) = q_m1_case(control, c(), d(), async { run_ok(s.x.ex.run(&rt, &system_binding("rt")).await).await }, &s).await;
        assert!(n >= 1);
        assert_eq!(withheld, !control, "reader retired, control={control}");
        if control {
            assert!(s.x.ev.has("control_executed:Q-M1.fence_disabled"), "control did not record that it executed");
        }
    }
    // negative case: closing the item (done) is not a restriction; the answer is released
    reset().await;
    let s = svc(vec![]).await;
    let it = handed_over_item(&s.x).await;
    let close = WorkUpdate { item: it, status: Some("done".into()), ..Default::default() };
    let (n, withheld) = q_m1_case(false, c(), d(), async { run_ok(s.x.ex.run(&close, &user_binding("close")).await).await }, &s).await;
    assert_eq!(n, 0, "closing recorded a restriction");
    assert!(!withheld, "closing an item withheld the answer (D8)");
}

// ================================================================ Q-M2 (D6), Q-M3 (D7), Q-M4 (D8)

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m2_roster_matches_identity_not_name() {
    for control in [false, true] {
        reset().await;
        let s = svc(if control { vec!["Q-M2.match_by_name"] } else { vec![] }).await;
        handed_over_item(&s.x).await;
        // rename the previous holder, hire a namesake under the freed name
        admin_exec(&format!("UPDATE agents SET name = 'delta-2' WHERE principal_id = '{d}'; UPDATE agent_names SET name = 'delta-2' WHERE principal_id = '{d}';", d = d())).await;
        let ns = Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0dd);
        run_ok(s.x.ex.run(&Racer::Hire { id: ns, name: "delta", parent: Some(a()), tier: "sonnet", grant_centi: 0 }, &system_binding("hire")).await).await;
        let (_h, renamed) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 1), None).await.unwrap();
        let (_h, namesake) = strict::material(&s.x.ex, &s.reg, material_q(c(), ns, 1), None).await.unwrap();
        if control {
            assert!(s.x.ev.has("control_executed:Q-M2.match_by_name"), "control did not record that it executed");
            assert!(namesake.is_ok(), "control executed but the namesake was refused: it proves nothing");
        } else {
            assert!(renamed.is_ok(), "the renamed holder must stay readable");
            assert!(namesake.is_err(), "the namesake must not be readable");
        }
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m3_a_returning_current_holder_is_not_readable_through_the_item() {
    for control in [false, true] {
        reset().await;
        let s = svc(if control { vec!["Q-M3.positional_last_row"] } else { vec![] }).await;
        let it = handed_over_item(&s.x).await;
        // roster delta, bravo, delta — delta current
        run_ok(s.x.ex.run(&WorkUpdate { item: it, owner: Some(Some(d())), ..Default::default() }, &user_binding("back")).await).await;
        let (_h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 1), None).await.unwrap();
        if control {
            assert!(s.x.ev.has("control_executed:Q-M3.positional_last_row"));
            assert!(a.is_ok(), "control executed but the current holder was refused");
        } else {
            assert!(a.is_err(), "D7: the current holder is never readable through the item");
        }
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m4_access_ends_when_the_item_archives_not_when_it_closes() {
    for control in [false, true] {
        let controls = if control { vec!["Q-M4.end_at_close"] } else { vec![] };
        let mut got = Vec::new();
        for case in ["open", "done", "done_past_hour", "archived", "reopened"] {
            reset().await;
            let s = svc(controls.clone()).await;
            let it = handed_over_item(&s.x).await;
            match case {
                "done" => run_ok(s.x.ex.run(&WorkUpdate { item: it, status: Some("done".into()), ..Default::default() }, &user_binding("u")).await).await,
                "done_past_hour" => {
                    run_ok(s.x.ex.run(&WorkUpdate { item: it, status: Some("done".into()), ..Default::default() }, &user_binding("u")).await).await;
                    admin_exec(&format!("UPDATE work_items SET updated_at = now() - interval '2 hours' WHERE item_id = '{it}'")).await;
                }
                "archived" => run_ok(s.x.ex.run(&WorkUpdate { item: it, archive: Some(Archive::Explicit), ..Default::default() }, &user_binding("u")).await).await,
                "reopened" => {
                    run_ok(s.x.ex.run(&WorkUpdate { item: it, archive: Some(Archive::Explicit), ..Default::default() }, &user_binding("u")).await).await;
                    run_ok(s.x.ex.run(&WorkUpdate { item: it, reopen: true, status: Some("open".into()), ..Default::default() }, &user_binding("u2")).await).await;
                }
                _ => {}
            }
            let (_h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 1), None).await.unwrap();
            got.push((case, a.is_ok()));
        }
        let want: Vec<(&str, bool)> = if control {
            vec![("open", true), ("done", false), ("done_past_hour", false), ("archived", false), ("reopened", true)]
        } else {
            vec![("open", true), ("done", true), ("done_past_hour", true), ("archived", false), ("reopened", true)]
        };
        assert_eq!(got, want, "control={control}");
    }
}

// ================================================================ Q-M5: rows bounded by the reader's listings

async fn q_m5_rows(control: bool, unrelated: usize) -> usize {
    reset().await;
    let s = svc(if control { vec!["Q-M5.scan_all_items"] } else { vec![] }).await;
    handed_over_item(&s.x).await;
    for i in 0..unrelated {
        run_ok(s.x.ex.run(&WorkCreate { item: new_id(), name: format!("noise-{i}"), title: "n".into(), status: "open".into(), owner: Some(e()), participants: vec![] }, &user_binding(&format!("n{i}"))).await).await;
    }
    let before = s.x.ev.rows_of("material.listings");
    let (_h, a) = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 1), None).await.unwrap();
    assert!(a.is_ok());
    s.x.ev.rows_of("material.listings") - before
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m5_item_route_reads_are_bounded_by_the_readers_listings() {
    let (r1, r10) = (q_m5_rows(false, 5).await, q_m5_rows(false, 50).await);
    assert_eq!(r1, r10, "rows examined grew with unrelated items: {r1} -> {r10}");
    let (c1, c10) = (q_m5_rows(true, 5).await, q_m5_rows(true, 50).await);
    assert!(c10 > c1 * 5, "control executed but rows did not grow with the organization: {c1} -> {c10}");
}

// ================================================================ Q-M6 / Q-D4: reads never make writers wait

async fn reads_under_writer(control: Option<&'static str>) -> bool {
    reset().await;
    let s = svc(control.into_iter().collect()).await;
    handed_over_item(&s.x).await;
    let w = WorkCreate { item: new_id(), name: "fresh".into(), title: "t".into(), status: "open".into(), owner: Some(e()), participants: vec![] };
    let bw = user_binding("w");
    let free = if let Some(c) = control {
        let mut h = s.x.script.hold(Some("rd"), "strict.locked.read.after_snapshot");
        let r = OrgLockedRead { control: c };
        let br = user_binding("rd");
        let (_, (o, no_wait)) = tokio::join!(s.x.ex.run(&r, &br), while_held(&mut h, 1500, s.x.ex.run(&w, &bw)));
        assert!(matches!(o, Ok(Outcome::Applied(_))));
        assert!(s.x.ev.has(&format!("control_executed:{c}")));
        no_wait
    } else {
        let mut h = s.x.script.hold(None, "material.transcript.after_snapshot");
        let fut = strict::material(&s.x.ex, &s.reg, material_q(c(), d(), 1), None);
        let (_, (o, no_wait)) = tokio::join!(fut, while_held(&mut h, 1500, s.x.ex.run(&w, &bw)));
        assert!(matches!(o, Ok(Outcome::Applied(_))));
        no_wait
    };
    free
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m6_q_d4_reads_never_make_writers_wait() {
    assert!(reads_under_writer(None).await, "a writer waited on a protected read");
    assert!(!reads_under_writer(Some("Q-M6.org_wide_lock")).await, "Q-M6 control executed but the writer did not wait");
    assert!(!reads_under_writer(Some("Q-D4.org_wide_lock")).await, "Q-D4 control executed but the writer did not wait");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_d4_concurrent_full_inspections_never_delay_writers() {
    for n in [1usize, 4, 8] {
        reset().await;
        let s = svc(vec![]).await;
        set_visibility(a(), "full").await;
        let mut h = s.x.script.hold(None, "diagnostic.inspect.after_snapshot");
        let reads: Vec<_> = (0..n).map(|_| strict::inspect(&s.x.ex, &s.reg, inspect_q(a()))).collect();
        let rl = reallocate_by_user(c(), 1);
        let bu = user_binding("w");
        let all_reads = async {
            let mut out = Vec::new();
            for r in reads {
                out.push(r.await);
            }
            out
        };
        let (_, (o, no_wait)) = tokio::join!(all_reads, while_held(&mut h, 1500, s.x.ex.run(&rl, &bu)));
        assert!(matches!(o, Ok(Outcome::Applied(_))));
        assert!(no_wait, "n={n}: a funding writer waited on inspections");
    }
}

fn reallocate_by_user(node: Uuid, delta: i128) -> orgtree_store::funding::Reallocate {
    orgtree_store::funding::Reallocate::new(node, orgtree_funding_core::pynum::PyNum::Int(delta))
}

// ================================================================ Q-M7: one minted identity

async fn q_m7(drop_key: bool) -> i64 {
    reset().await;
    if drop_key {
        admin_exec("DROP INDEX transcript_identities_seat").await;
    }
    let x = executor(if drop_key { vec!["Q-M7.mint_without_key"] } else { vec![] });
    let mut h1 = x.script.hold(Some("m1"), "material.mint.before_mint");
    let mut h2 = x.script.hold(Some("m2"), "material.mint.before_mint");
    let (c1, c2) = (MintTranscriptIdentity { target: d(), candidate: new_id() }, MintTranscriptIdentity { target: d(), candidate: new_id() });
    let (b1, b2) = (system_binding("m1"), system_binding("m2"));
    let release = async {
        h1.arrive().await;
        h2.arrive().await;
        h1.go();
        h2.go();
    };
    let ((o1, o2), ()) = tokio::join!(async { tokio::join!(x.ex.run(&c1, &b1), x.ex.run(&c2, &b2)) }, release);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{o1:?}");
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "{o2:?}");
    if drop_key {
        assert!(x.ev.has("control_executed:Q-M7.mint_without_key"));
    }
    count(&format!("SELECT count(*) FROM transcript_identities WHERE principal_id = '{}'", d())).await
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_m7_concurrent_cold_reads_mint_one_identity() {
    assert_eq!(q_m7(false).await, 1);
    assert_eq!(q_m7(true).await, 2, "control executed but only one identity was minted");
}

// ================================================================ Q-D1: one snapshot, funding-consistent

/// Every live node's `free` equals its grant minus its listed live children's
/// grants and seat costs (a full-visibility answer lists every child).
fn funding_consistent(ans: &Value) -> bool {
    let nodes = ans["nodes"].as_array().unwrap();
    let credit = |v: &Value| (v.as_f64().unwrap_or(0.0) * 100.0).round() as i64;
    nodes.iter().filter(|n| !n["free"].is_null()).all(|n| {
        let used: i64 = nodes.iter().filter(|c| c["parent"] == n["id"] && c["state"] == json!("live")).map(|c| credit(&c["grant"]) + credit(&c["seat_cost"])).sum();
        credit(&n["free"]) == credit(&n["grant"]) - used
    })
}

async fn q_d1(control: bool) -> (bool, bool) {
    reset().await;
    let s = svc(if control { vec!["Q-D1.two_snapshots"] } else { vec![] }).await;
    set_visibility(a(), "full").await;
    let mut h = s.x.script.hold(None, "diagnostic.inspect.after_snapshot");
    let rl = orgtree_store::funding::Reallocate::new(c(), orgtree_funding_core::pynum::PyNum::Int(3));
    let br = agent_binding(b(), "rl");
    let (r, (o, _)) = tokio::join!(strict::inspect(&s.x.ex, &s.reg, inspect_q(a())), while_held(&mut h, 1000, s.x.ex.run(&rl, &br)));
    assert!(matches!(o, Ok(Outcome::Applied(_))));
    let (_h, ans) = r.unwrap();
    (funding_consistent(&ans.unwrap()), s.x.ev.has("control_executed:Q-D1.two_snapshots"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_d1_inspection_is_one_consistent_snapshot() {
    let (ok, ran) = q_d1(false).await;
    assert!(!ran);
    assert!(ok, "grants and free disagree in one answer");
    let (ok, ran) = q_d1(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!ok, "control executed but the answer is still consistent: the writer did not commit between the snapshots");
}

// ================================================================ Q-D2 / Q-D3: withheld on the caller's retire, rehire, narrowing, move

async fn diag_case(control: Option<&'static str>, fence: &'static str, capabilities: bool, writer: Racer) -> bool {
    reset().await;
    let s = svc(control.into_iter().collect()).await;
    set_visibility(b(), "subtree").await;
    let (h, a) = if capabilities {
        let h = strict::register(&s.reg, org(), b(), 1);
        let a = s.x.ex.read(&Capabilities { org: org(), me: b(), generation: 1 }, org(), None).await.unwrap();
        (h, a)
    } else {
        strict::inspect(&s.x.ex, &s.reg, inspect_q(b())).await.unwrap()
    };
    let a = a.unwrap();
    run_ok(s.x.ex.run(&writer, &system_binding("w")).await).await;
    assert!(s.consume().await >= 1, "the writer recorded no Effective restriction");
    strict::emit(&s.x.ex, org(), h, fence, a).await.is_err()
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_d2_q_d3_withheld_after_the_callers_authority_narrows() {
    for capabilities in [false, true] {
        assert!(diag_case(None, "Q-D2.fence_disabled", capabilities, Racer::Retire { node: b() }).await, "retired caller, capabilities={capabilities}");
        assert!(!diag_case(Some("Q-D2.fence_disabled"), "Q-D2.fence_disabled", capabilities, Racer::Retire { node: b() }).await, "Q-D2 control: released after Effective");
        assert!(diag_case(None, "Q-D2.fence_disabled", capabilities, Racer::Rehire { node: b() }).await, "rehired (generation change), capabilities={capabilities}");
    }
    assert!(diag_case(None, "Q-D3.fence_disabled", false, Racer::Narrow { node: b(), visibility: "self" }).await, "narrowed visibility");
    assert!(diag_case(None, "Q-D3.fence_disabled", false, Racer::Move { node: c(), new_parent: Some(d()) }).await, "a node moved out of the subtree");
    assert!(!diag_case(Some("Q-D3.fence_disabled"), "Q-D3.fence_disabled", false, Racer::Move { node: c(), new_parent: Some(d()) }).await, "Q-D3 control: released");
}

// ================================================================ Q-D5: bounded rows with 10x history

async fn q_d5_rows(control: bool, history: i64, targeted: bool) -> usize {
    reset().await;
    let s = svc(if control { vec!["Q-D5.whole_document"] } else { vec![] }).await;
    set_visibility(a(), "full").await;
    admin_exec(&format!(
        "INSERT INTO transcript_entries (org_id, principal_id, seq, role, body, at) SELECT '{}', '{}', g, 'assistant', 'h', now() FROM generate_series(1, {history}) g",
        org(),
        e()
    ))
    .await;
    let before = s.x.ev.rows_total();
    let mut q = inspect_q(a());
    if targeted {
        q.targets = vec![c()];
    }
    let (_h, a) = strict::inspect(&s.x.ex, &s.reg, q).await.unwrap();
    assert!(a.is_ok());
    s.x.ev.rows_total() - before
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_d5_inspection_reads_no_history() {
    for targeted in [true, false] {
        let (r1, r10) = (q_d5_rows(false, 100, targeted).await, q_d5_rows(false, 1000, targeted).await);
        assert_eq!(r1, r10, "targeted={targeted}: rows grew with unrelated history");
    }
    let (c1, c10) = (q_d5_rows(true, 100, false).await, q_d5_rows(true, 1000, false).await);
    assert_ne!(c1, c10, "control executed but rows did not grow with history");
}

// ================================================================ Q-D6: unknown visibility never widens (D9)

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_d6_unknown_visibility_refuses_and_missing_is_full() {
    for control in [false, true] {
        reset().await;
        let s = svc(if control { vec!["Q-D6.unknown_widens"] } else { vec![] }).await;
        set_visibility(b(), "everyone").await;
        let (_h, a) = strict::inspect(&s.x.ex, &s.reg, inspect_q(b())).await.unwrap();
        if control {
            assert!(s.x.ev.has("control_executed:Q-D6.unknown_widens"));
            assert_eq!(a.unwrap()["visibility"], json!("full"), "control executed but did not widen");
        } else {
            let r = a.unwrap_err();
            assert_eq!(r.code, "unknown_visibility");
            assert!(r.message.contains("bravo"), "{}", r.message);
        }
    }
    // valid values behave; a missing scope row reads as full (legacy backfill)
    reset().await;
    let s = svc(vec![]).await;
    set_visibility(b(), "self").await;
    let (_h, a) = strict::inspect(&s.x.ex, &s.reg, inspect_q(b())).await.unwrap();
    assert_eq!(a.unwrap()["nodes"].as_array().unwrap().len(), 1);
    admin_exec(&format!("DELETE FROM scope_rows WHERE principal_id = '{}'", b())).await;
    let (_h, a) = strict::inspect(&s.x.ex, &s.reg, inspect_q(b())).await.unwrap();
    assert_eq!(a.unwrap()["visibility"], json!("full"));
}

// ================================================================ Q-CH1 / Q-CH2: the chart

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_ch1_chart_withheld_after_narrowing_or_move_and_disjoint_writers_never_wait() {
    for (label, writer) in [("narrowing", Racer::Narrow { node: b(), visibility: "self" }), ("move", Racer::Move { node: c(), new_parent: Some(d()) })] {
        for control in [false, true] {
            reset().await;
            let s = svc(if control { vec!["Q-CH1.fence_disabled"] } else { vec![] }).await;
            set_visibility(b(), "subtree").await;
            let (h, a) = strict::chart(&s.x.ex, &s.reg, chart_q(b())).await.unwrap();
            let a = a.unwrap();
            run_ok(s.x.ex.run(&writer, &system_binding("w")).await).await;
            assert!(s.consume().await >= 1, "{label}: no Effective restriction");
            let out = strict::emit(&s.x.ex, org(), h, "Q-CH1.fence_disabled", a).await;
            assert_eq!(out.is_err(), !control, "{label}, control={control}");
        }
    }
    // (c) disjoint writers: no waits either way
    reset().await;
    let s = svc(vec![]).await;
    let mut h = s.x.script.hold(None, "chart.read.after_snapshot");
    let rl = reallocate_by_user(e(), 1);
    let bu = user_binding("w");
    let (_, (o, no_wait)) = tokio::join!(strict::chart(&s.x.ex, &s.reg, chart_q(b())), while_held(&mut h, 1500, s.x.ex.run(&rl, &bu)));
    assert!(matches!(o, Ok(Outcome::Applied(_))));
    assert!(no_wait, "a disjoint writer waited on a chart build");
}

async fn q_ch2(control: bool) -> (bool, bool) {
    reset().await;
    let s = svc(if control { vec!["Q-CH2.separate_snapshots"] } else { vec![] }).await;
    set_visibility(b(), "subtree").await;
    let mut h = s.x.script.hold(None, "chart.read.after_snapshot");
    let hire = Racer::Hire { id: Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0c2), name: "kilo", parent: Some(b()), tier: "opus", grant_centi: 0 };
    let bh = system_binding("hire");
    let (r, (o, _)) = tokio::join!(strict::chart(&s.x.ex, &s.reg, chart_q(b())), while_held(&mut h, 1000, s.x.ex.run(&hire, &bh)));
    assert!(matches!(o, Ok(Outcome::Applied(_))));
    let (_h, ans) = r.unwrap();
    let ans = ans.unwrap();
    let credit = |v: &Value| (v.as_f64().unwrap_or(0.0) * 100.0).round() as i64;
    let me = b().to_string();
    let listed: i64 = ans["rows"].as_array().unwrap().iter().filter(|r| r["parent"] == json!(me) && r["state"] == json!("live")).map(|r| credit(&r["grant"]) + OPUS_CENTI).sum();
    let consistent = credit(&ans["credits"]["free"]) == credit(&ans["credits"]["grant"]) - listed;
    (consistent, s.x.ev.has("control_executed:Q-CH2.separate_snapshots"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_ch2_roster_and_credits_come_from_one_state() {
    let (ok, ran) = q_ch2(false).await;
    assert!(!ran);
    assert!(ok, "listed reports and free disagree");
    let (ok, ran) = q_ch2(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!ok, "control executed but roster and credits still agree: the hire did not commit between the snapshots");
}
