//! WS4 funding on a real PostgreSQL (the WS1 dev cluster of
//! p03-ws4-rcfamilies): `reallocate`, the credit request and the credit
//! decision (r7 §6.4, C2a P2; S3 §4.13, E8), with schedules Q-C8 (the
//! WS4 part), Q-FD1–Q-FD5 and Q-OP2.
//!
//! Run ONLY through the P03 run lock (`artifacts\run-pg.ps1 -Test
//! ws4_funding_pg` via `p03-run.ps1`). The racing hire, retire and
//! `mark_unrecoverable` are schedule-grade stand-ins (common_ws4::Racer).
//! Conservation is read from the committed state after every schedule
//! (`funding_violations`: no negative `free`, capacity aggregates equal the
//! live children, no fractional grant).
#![cfg(feature = "qualification")]

mod common_ws4;

use common_ws4::*;
use orgtree_funding_core::pynum::PyNum;
use orgtree_store::funding::{CreditDecide, CreditRequest, Reallocate, Reallocated};
use orgtree_store::{ExecError, Outcome, Uuid};
use serde_json::{json, Value};

fn realloc(node: Uuid, delta: i128) -> Reallocate {
    Reallocate { node, delta: PyNum::Int(delta) }
}

fn decide(id: &str, action: &str, granted: Option<i64>) -> CreditDecide {
    CreditDecide { request: id.into(), action: action.into(), granted: granted.map(|g| json!(g)), expected_rev: None }
}

fn name(o: &Result<Outcome<Value>, ExecError>) -> String {
    match o {
        Ok(o) => o.name().to_string(),
        Err(e) => format!("error {e:?}"),
    }
}

async fn file(x: &Ex, who: Uuid, new_limit: i64, key: &str) -> Value {
    match x.ex.run(&CreditRequest::new(json!(new_limit), "need more"), &agent_binding(who, key)).await.unwrap() {
        Outcome::Applied(v) => v,
        o => panic!("filing refused: {o:?}"),
    }
}

async fn assert_conserved(ctx: &str) {
    let v = funding_violations().await;
    assert!(v.is_empty(), "{ctx}: conservation broken: {v:?}");
}

async fn answer_mails_to(x: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM mail_sent WHERE dest_principal_id = '{x}' AND kind = 'decision.credit'")).await
}

// ================================================================ reallocate

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn reallocate_applies_legacy_rules_and_keeps_capacity_rows_true() {
    reset().await;
    let x = executor(vec![]);
    assert_conserved("fixture").await;
    // bravo gives its report charlie 3 from its own free
    let o = x.ex.run(&realloc(c(), 3), &agent_binding(b(), "r1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(Reallocated { ref grant, .. }) if *grant == json!(8)), "{o:?}");
    assert_eq!(grant_of(c()).await, 800);
    assert_eq!(count(&format!("SELECT child_grants_centi FROM issuer_capacity WHERE principal_id = '{}'", b())).await, 800);
    assert_conserved("after +3").await;
    // a grant-changed notice to the node (not the acting parent)
    assert_eq!(count(&format!("SELECT count(*) FROM mail_sent WHERE dest_principal_id = '{}' AND kind = 'access.grant_changed'", c())).await, 1);
    // refusals commit nothing, with legacy's words
    let o = x.ex.run(&realloc(c(), -10), &user_binding("r2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.message == "charlie has only 8 unused; the rest is committed"), "{o:?}");
    let o = x.ex.run(&realloc(c(), 1), &agent_binding(d(), "r3")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.message.starts_with("delta has no authority over charlie")), "{o:?}");
    assert_eq!(count("SELECT count(*) FROM operation_receipts WHERE op_key IN ('r2', 'r3')").await, 0);
    // top level, by the user
    let o = x.ex.run(&realloc(a(), 10), &user_binding("r4")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(Reallocated { ref grant, .. }) if *grant == json!(110)), "{o:?}");
    // deep, by the user: bravo's free (20 - 8 - 3 = 9) first, the rest bubbles to alpha
    let o = x.ex.run(&realloc(c(), 20), &user_binding("r5")).await.unwrap();
    let Outcome::Applied(r) = o else { panic!("{o:?}") };
    assert_eq!(r.grant, json!(28));
    assert!(r.warnings.iter().any(|w| w.contains("bubbled up to alpha")), "{:?}", r.warnings);
    assert_eq!(grant_of(b()).await, 3100, "bravo inflated by the 11 that bubbled");
    assert_conserved("after deep +20").await;
    // a keyed retry replays, nothing applied twice
    let o = x.ex.run(&realloc(c(), 3), &agent_binding(b(), "r1")).await.unwrap();
    assert!(matches!(o, Outcome::Replayed(_)), "{o:?}");
    assert_eq!(grant_of(c()).await, 2800);
}

// ================================================================ Q-C8 (WS4 part): P2 funding across the island boundary

/// bravo's last free credits: charlie's grant raised so bravo's free is 3.00
/// = exactly one opus seat.
async fn last_credit_fixture() {
    reset().await;
    admin_exec(&format!(
        "UPDATE funding_edges SET grant_centi = 1400 WHERE child_id = '{c}'; UPDATE issuer_capacity SET child_grants_centi = 1400 WHERE principal_id = '{b}';",
        c = c(),
        b = b()
    ))
    .await;
    assert_conserved("last-credit fixture").await;
}

fn hire_x() -> Racer {
    Racer::Hire { id: Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0f0), name: "xray", parent: Some(b()), tier: "opus", grant_centi: 0 }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c8_hire_racing_reallocate_serial_orders() {
    // reallocate first: the hire finds no free credit
    last_credit_fixture().await;
    let x = executor(vec![]);
    assert!(matches!(x.ex.run(&realloc(c(), 3), &agent_binding(b(), "q8-r")).await.unwrap(), Outcome::Applied(_)));
    let o = x.ex.run(&hire_x(), &system_binding("q8-h")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "chain_short"), "{o:?}");
    assert_conserved("realloc then hire").await;
    // hire first: the reallocation is refused (bravo acts; no bubbling above it)
    last_credit_fixture().await;
    let x = executor(vec![]);
    assert!(matches!(x.ex.run(&hire_x(), &system_binding("q8-h")).await.unwrap(), Outcome::Applied(_)));
    let o = x.ex.run(&realloc(c(), 3), &agent_binding(b(), "q8-r")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "funding.chainshort"), "{o:?}");
    assert_conserved("hire then realloc").await;
}

/// The reallocation holds its locks; the SERIALIZABLE hire takes its snapshot
/// and then waits on bravo's capacity row; the reallocation commits.
async fn q_c8_forced(control: bool) -> (String, bool, Vec<String>) {
    last_credit_fixture().await;
    let x = executor(if control { vec!["Q-C8.lock_not_update"] } else { vec![] });
    let mut h = x.script.hold(Some("q8-r"), "funding.reallocate.after_locks");
    let ex = &x.ex;
    let r = realloc(c(), 3);
    let br = agent_binding(b(), "q8-r");
    let hire = hire_x();
    let bh = system_binding("q8-h");
    let t1 = ex.run(&r, &br);
    let t2 = while_held(&mut h, 1500, ex.run(&hire, &bh));
    let (o1, (o2, _)) = tokio::join!(t1, t2);
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    let hire_outcome = o2.unwrap().name().to_string();
    let serialized = x.ev.any("retry:sg.island.hire:q8-h:serialization_failure:40001");
    (hire_outcome, x.ev.has("control_executed:Q-C8.lock_not_update"), {
        let mut v = funding_violations().await;
        if !serialized {
            v.push("(the hire did not get 40001)".into());
        }
        v
    })
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c8_forced_reallocate_updates_capacity_so_the_island_hire_retries() {
    let (hire, ran, v) = q_c8_forced(false).await;
    assert!(!ran);
    assert_eq!(hire, "refused", "the hire must retry on 40001 and then find no free credit");
    assert_eq!(v, Vec::<String>::new());
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c8_control_lock_not_update_spends_the_last_credit_twice() {
    let (hire, ran, v) = q_c8_forced(true).await;
    assert!(ran, "control did not record that it executed");
    assert_eq!(hire, "applied", "control executed but the hire did not overspend: the control proves nothing");
    assert!(v.iter().any(|s| s.starts_with("bravo: obligations")), "no overspend recorded: {v:?}");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c8_forced_hire_first_then_reallocate_sees_it() {
    last_credit_fixture().await;
    let x = executor(vec![]);
    let mut h = x.script.hold(Some("q8-h"), "sg.island.hire.after_capacity_lock");
    let ex = &x.ex;
    let hire = hire_x();
    let bh = system_binding("q8-h");
    let r = realloc(c(), 3);
    let br = agent_binding(b(), "q8-r");
    let t1 = ex.run(&hire, &bh);
    let t2 = while_held(&mut h, 1500, ex.run(&r, &br));
    let (o1, (o2, waited_not)) = tokio::join!(t1, t2);
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(!waited_not, "the reallocation did not wait for the hire's capacity lock");
    let o2 = o2.unwrap();
    assert!(matches!(o2, Outcome::Refused(ref r) if r.code == "funding.chainshort"), "{o2:?}");
    assert_conserved("hire first, forced").await;
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c8_retire_racing_reallocate_conserves() {
    for forced in [false, true] {
        last_credit_fixture().await;
        let x = executor(vec![]);
        let ex = &x.ex;
        let r = realloc(c(), 3);
        let br = agent_binding(b(), "q8-r");
        let ret = Racer::Retire { node: c() };
        let bw = system_binding("q8-w");
        if forced {
            let mut h = x.script.hold(Some("q8-r"), "funding.reallocate.after_locks");
            let (o1, (o2, _)) = tokio::join!(ex.run(&r, &br), while_held(&mut h, 1500, ex.run(&ret, &bw)));
            assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
            assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
        } else {
            assert!(matches!(ex.run(&ret, &bw).await.unwrap(), Outcome::Applied(_)));
            let o = ex.run(&r, &br).await.unwrap();
            assert!(matches!(o, Outcome::Refused(ref r) if r.message == "charlie is archived, not live"), "{o:?}");
        }
        assert_conserved(&format!("retire racing reallocate, forced={forced}")).await;
    }
}

// ================================================================ Q-FD1: two decisions on one request

/// echo (top level, 50) asks for 60. Two decisions overlap: the first holds
/// at `hold_at`, the second runs meanwhile.
async fn q_fd1(controls: Vec<&'static str>, first: CreditDecide, second: CreditDecide, hold_at: &str) -> (Ex, Result<Outcome<Value>, ExecError>, Result<Outcome<Value>, ExecError>) {
    reset().await;
    let x = executor(controls);
    let filed = file(&x, e(), 60, "fd1-file").await;
    assert_eq!(filed["id"], json!("cr1"));
    let mut h = x.script.hold(Some("fd1-1"), hold_at);
    let ub1 = user_binding("fd1-1");
    let ub2 = user_binding("fd1-2");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&first, &ub1), while_held(&mut h, 1500, x.ex.run(&second, &ub2)));
    (x, o1, o2)
}

async fn one_decision_applied(ctx: &str, o1: &Result<Outcome<Value>, ExecError>, o2: &Result<Outcome<Value>, ExecError>) {
    let applied = [o1, o2].iter().filter(|o| matches!(o, Ok(Outcome::Applied(_)))).count();
    assert_eq!(applied, 1, "{ctx}: {} / {}", name(o1), name(o2));
    let loser = if matches!(o1, Ok(Outcome::Applied(_))) { o2 } else { o1 };
    assert!(matches!(loser, Ok(Outcome::Refused(r)) if r.code == "no_pending"), "{ctx}: loser {loser:?}");
    let state = text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await;
    let g = grant_of(e()).await;
    match state.as_str() {
        "answered" => assert_eq!(Some(g), opt_text("SELECT (result->>'granted') FROM request_batches WHERE legacy_id = 'cr1'").await.and_then(|s| s.parse::<i64>().ok()).map(|x| x * 100), "{ctx}"),
        "denied" => assert_eq!(g, 5000, "{ctx}: denied but the grant moved"),
        s => panic!("{ctx}: state {s}"),
    }
    assert_eq!(answer_mails_to(e()).await, 1, "{ctx}: the agent must receive exactly one answer");
    assert_conserved(ctx).await;
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd1_exactly_one_decision_applies_in_every_pair_and_order() {
    let pairs: Vec<(&str, fn() -> CreditDecide, fn() -> CreditDecide)> = vec![
        ("approve/approve", || decide("cr1", "approve", None), || decide("cr1", "approve", None)),
        ("approve/deny", || decide("cr1", "approve", None), || decide("cr1", "deny", None)),
        ("deny/approve", || decide("cr1", "deny", None), || decide("cr1", "approve", None)),
        ("counter 55/counter 70", || decide("cr1", "approve", Some(55)), || decide("cr1", "approve", Some(70))),
        ("counter 70/counter 55", || decide("cr1", "approve", Some(70)), || decide("cr1", "approve", Some(55))),
    ];
    for (ctx, f, s) in pairs {
        let (x, o1, o2) = q_fd1(vec![], f(), s(), "funding.decide.after_cas").await;
        one_decision_applied(ctx, &o1, &o2).await;
        assert!(o1.as_ref().is_ok_and(|o| matches!(o, Outcome::Applied(_))), "{ctx}: the first (holding) decision must win");
        drop(x);
    }
    // the ask from 50 to 60 ends at 60 with two approvals
    let (_x, _o1, _o2) = q_fd1(vec![], decide("cr1", "approve", None), decide("cr1", "approve", None), "funding.decide.after_cas").await;
    assert_eq!(grant_of(e()).await, 6000);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd1_control_i_no_cas_and_prelock_delta_grants_twice() {
    // both approvals read the pending status unlocked and the grant (50)
    // BEFORE the funding locks; each applies Δ = 10 as an increment: 70.
    let (x, o1, o2) = q_fd1(
        vec!["Q-FD1.no_cas_prelock_delta"],
        decide("cr1", "approve", None),
        decide("cr1", "approve", None),
        "funding.decide.stmt.funding.decide_prelock_grant.after",
    )
    .await;
    assert!(x.ev.has("control_executed:Q-FD1.no_cas_prelock_delta"), "control did not record that it executed");
    assert_eq!(name(&o1), "applied");
    assert_eq!(name(&o2), "applied", "control executed but the second decision refused: it proves nothing");
    assert_eq!(grant_of(e()).await, 7000, "the ask from 50 to 60 must end at 70 under control (i)");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd1_control_ii_no_cas_lets_both_decisions_apply() {
    // approve racing deny: the request ends answered or denied while the other also committed
    let (x, o1, o2) = q_fd1(vec!["Q-FD1.no_cas_postlock_delta"], decide("cr1", "approve", None), decide("cr1", "deny", None), "funding.decide.after_liveness").await;
    assert!(x.ev.has("control_executed:Q-FD1.no_cas_postlock_delta"), "control did not record that it executed");
    assert_eq!((name(&o1).as_str(), name(&o2).as_str()), ("applied", "applied"), "control executed but one decision refused");
    assert_eq!(text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await, "answered");
    assert_eq!(grant_of(e()).await, 6000);
    assert_eq!(answer_mails_to(e()).await, 2, "an approval AND a denial were both sent");
    // two counter-offers: both apply, the last one winning
    let (_x, o1, o2) = q_fd1(vec!["Q-FD1.no_cas_postlock_delta"], decide("cr1", "approve", Some(55)), decide("cr1", "approve", Some(70)), "funding.decide.after_liveness").await;
    assert_eq!((name(&o1).as_str(), name(&o2).as_str()), ("applied", "applied"));
    assert_eq!(grant_of(e()).await, 5500, "the held (last-committing) counter-offer wins");
    assert_eq!(answer_mails_to(e()).await, 2);
}

// ================================================================ Q-FD2: one pending request per agent

async fn pending_of(x: Uuid) -> i64 {
    count(&format!("SELECT count(*) FROM request_batches WHERE asker_id = '{x}' AND kind = 'credit' AND state = 'pending'")).await
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd2_two_concurrent_filings_amend_one_pending_request() {
    reset().await;
    let x = executor(vec![]);
    let mut h = x.script.hold(Some("fd2-1"), "funding.request.after_anchor");
    let r1 = CreditRequest::new(json!(60), "first");
    let r2 = CreditRequest::new(json!(70), "second");
    let b1 = agent_binding(e(), "fd2-1");
    let b2 = agent_binding(e(), "fd2-2");
    let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&r1, &b1), while_held(&mut h, 1500, x.ex.run(&r2, &b2)));
    assert!(!no_wait, "the second filing did not wait on the first's P7 bump");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    let o2 = o2.unwrap();
    assert!(matches!(o2, Outcome::Applied(ref v) if v["status"].as_str().is_some_and(|s| s.contains("amended"))), "{o2:?}");
    assert_eq!(pending_of(e()).await, 1);
    assert_eq!(count("SELECT rev FROM request_batches WHERE legacy_id = 'cr1'").await, 2);
    assert_eq!(text("SELECT payload->>'new' FROM request_batches WHERE legacy_id = 'cr1'").await, "70");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd2_control_no_index_and_lookup_before_bump_makes_two_pending() {
    reset().await;
    // the harness drops the partial unique index for this run (as WS5's Q-HM1 drops audience_grants_key)
    admin_exec("DROP INDEX request_batches_one_pending").await;
    let x = executor(vec!["Q-FD2.lookup_before_bump"]);
    let mut h = x.script.hold(Some("fd2-1"), "funding.request.after_lookup");
    let r1 = CreditRequest::new(json!(60), "first");
    let r2 = CreditRequest::new(json!(70), "second");
    let b1 = agent_binding(e(), "fd2-1");
    let b2 = agent_binding(e(), "fd2-2");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&r1, &b1), while_held(&mut h, 1500, x.ex.run(&r2, &b2)));
    assert!(x.ev.has("control_executed:Q-FD2.lookup_before_bump"), "control did not record that it executed");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    assert_eq!(pending_of(e()).await, 2, "control executed but only one request is pending: it proves nothing");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd2_decision_racing_amendment_both_orders() {
    // decision first (holding its compare-and-set): the amendment then finds
    // no pending request and files a new one
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    let mut h = x.script.hold(Some("d1"), "funding.decide.after_cas");
    let d = decide("cr1", "approve", None);
    let amend = CreditRequest::new(json!(80), "more");
    let ub = user_binding("d1");
    let ab = agent_binding(e(), "f2");
    let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&d, &ub), while_held(&mut h, 1500, x.ex.run(&amend, &ab)));
    assert!(!no_wait, "the amendment did not wait on the decision's row lock");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    let o2 = o2.unwrap();
    assert!(matches!(o2, Outcome::Applied(ref v) if v["id"] == json!("cr2")), "{o2:?}");
    assert_eq!(grant_of(e()).await, 6000, "approve-as-asked granted the committed figure");
    assert_eq!(pending_of(e()).await, 1);
    // amendment first: approve-as-asked grants the amended figure; the batch
    // door's stale revision is refused instead (E-D14)
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    file(&x, e(), 80, "f2").await;
    let stale = CreditDecide { request: "cr1".into(), action: "approve".into(), granted: None, expected_rev: Some(1) };
    let o = x.ex.run(&stale, &user_binding("d0")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "stale_card"), "{o:?}");
    assert_eq!(grant_of(e()).await, 5000);
    let o = x.ex.run(&decide("cr1", "approve", None), &user_binding("d1")).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    assert_eq!(grant_of(e()).await, 8000);
}

// ================================================================ Q-FD3: decisions racing retire / unrecoverable

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_a_decision_racing_retire_both_orders() {
    // retire first: the request is mooted, the decision refuses
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    assert!(matches!(x.ex.run(&Racer::Retire { node: e() }, &system_binding("w")).await.unwrap(), Outcome::Applied(_)));
    let o = x.ex.run(&decide("cr1", "approve", None), &user_binding("d")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "no_pending"), "{o:?}");
    assert_eq!(grant_of(e()).await, 5000);
    // decision first (anchored): the retire waits, then archives an answered agent
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    let mut h = x.script.hold(Some("d"), "funding.decide.after_liveness");
    let d = decide("cr1", "approve", None);
    let ret = Racer::Retire { node: e() };
    let ub = user_binding("d");
    let wb = system_binding("w");
    let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&d, &ub), while_held(&mut h, 1500, x.ex.run(&ret, &wb)));
    assert!(!no_wait, "the retire did not wait on the decision's anchor");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    assert_eq!(text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await, "answered", "the retire's retry mooted nothing");
    assert!(x.ev.pos("commit:funding.decide:d") < x.ev.pos("commit:sg.island.retire:w"));
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_a_control_no_anchor_no_cas_grants_an_archived_agent() {
    reset().await;
    let x = executor(vec!["Q-FD3.no_anchor_no_cas"]);
    file(&x, e(), 60, "f1").await;
    let mut h = x.script.hold(Some("d"), "funding.decide.after_liveness");
    let d = decide("cr1", "approve", None);
    let ret = Racer::Retire { node: e() };
    let ub = user_binding("d");
    let wb = system_binding("w");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&d, &ub), while_held(&mut h, 1500, x.ex.run(&ret, &wb)));
    assert!(x.ev.has("control_executed:Q-FD3.no_anchor_no_cas"), "control did not record that it executed");
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)), "the retire must not wait without the anchor");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)), "control executed but the decision refused: it proves nothing");
    assert_eq!(text(&format!("SELECT lifecycle FROM authority_epoch WHERE principal_id = '{}'", e())).await, "archived");
    assert_eq!(grant_of(e()).await, 6000, "a grant to an archived agent");
}

async fn unrecoverable_with_request() -> Ex {
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'unrecoverable' WHERE principal_id = '{}'", e())).await;
    x
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_b_first_decision_wins_on_a_non_live_agent() {
    let x = unrecoverable_with_request().await;
    assert!(matches!(x.ex.run(&decide("cr1", "approve", None), &user_binding("d1")).await.unwrap(), Outcome::Applied(ref v) if v["status"] == json!("moot")));
    let o = x.ex.run(&decide("cr1", "deny", None), &user_binding("d2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "no_pending"), "{o:?}");
    assert_eq!(text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await, "moot");
    let x = unrecoverable_with_request().await;
    assert!(matches!(x.ex.run(&decide("cr1", "deny", None), &user_binding("d1")).await.unwrap(), Outcome::Applied(ref v) if v["status"] == json!("denied")));
    let o = x.ex.run(&decide("cr1", "approve", None), &user_binding("d2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(ref r) if r.code == "no_pending"), "{o:?}");
    assert_eq!(text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await, "denied", "a moot never overwrites an answer");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_b_control_unconditional_moot_overwrites_a_denial() {
    reset().await;
    let x = executor(vec!["Q-FD3.moot_unconditional"]);
    file(&x, e(), 60, "f1").await;
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'unrecoverable' WHERE principal_id = '{}'", e())).await;
    assert!(matches!(x.ex.run(&decide("cr1", "deny", None), &user_binding("d1")).await.unwrap(), Outcome::Applied(_)));
    let o = x.ex.run(&decide("cr1", "approve", None), &user_binding("d2")).await.unwrap();
    assert!(x.ev.has("control_executed:Q-FD3.moot_unconditional"), "control did not record that it executed");
    assert!(matches!(o, Outcome::Applied(_)), "control executed but the moot refused: {o:?}");
    assert_eq!(text("SELECT state FROM request_batches WHERE legacy_id = 'cr1'").await, "moot", "the denial the agent was told about was overwritten");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_c_approve_racing_mark_unrecoverable_both_orders() {
    // mark first: the approval moots
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    assert!(matches!(x.ex.run(&Racer::MarkUnrecoverable { node: e() }, &system_binding("m")).await.unwrap(), Outcome::Applied(_)));
    assert!(matches!(x.ex.run(&decide("cr1", "approve", None), &user_binding("d")).await.unwrap(), Outcome::Applied(ref v) if v["status"] == json!("moot")));
    assert_eq!(grant_of(e()).await, 5000);
    // approve first (anchored): the mark waits
    reset().await;
    let x = executor(vec![]);
    file(&x, e(), 60, "f1").await;
    let mut h = x.script.hold(Some("d"), "funding.decide.after_liveness");
    let d = decide("cr1", "approve", None);
    let m = Racer::MarkUnrecoverable { node: e() };
    let ub = user_binding("d");
    let mb_ = system_binding("m");
    let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&d, &ub), while_held(&mut h, 1500, x.ex.run(&m, &mb_)));
    assert!(!no_wait, "the mark did not wait on the decision's anchor");
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    assert_eq!(grant_of(e()).await, 6000, "granted before the mark");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd3_c_control_liveness_once_grants_an_unrecoverable_agent() {
    reset().await;
    let x = executor(vec!["Q-FD3.liveness_once"]);
    file(&x, e(), 60, "f1").await;
    let mut h = x.script.hold(Some("d"), "funding.decide.after_liveness");
    let d = decide("cr1", "approve", None);
    let m = Racer::MarkUnrecoverable { node: e() };
    let ub = user_binding("d");
    let mb_ = system_binding("m");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&d, &ub), while_held(&mut h, 1500, x.ex.run(&m, &mb_)));
    assert!(x.ev.has("control_executed:Q-FD3.liveness_once"), "control did not record that it executed");
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o1.unwrap(), Outcome::Applied(ref v) if v["status"] == json!("answered")), "control executed but the approval did not grant");
    assert_eq!(text(&format!("SELECT lifecycle FROM authority_epoch WHERE principal_id = '{}'", e())).await, "unrecoverable");
    assert_eq!(grant_of(e()).await, 6000, "a grant to an agent already marked unrecoverable");
}

// ================================================================ Q-FD4: deep bubbling through a finite manager

fn foxtrot() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a006)
}

/// bravo (14) manages charlie (5, sonnet seat 2.50) and foxtrot (0, opus
/// seat 3.00): committed 10.50, free 3.50 (fractional). Both reports hold a
/// user audience and each has a pending request: charlie 5→8, foxtrot 0→2.
async fn deep_fixture(x: &Ex) {
    let o = org();
    let f = foxtrot();
    admin_exec(&format!(
        "UPDATE agents SET tier = 'sonnet' WHERE principal_id = '{c}';
         UPDATE funding_edges SET tier = 'sonnet' WHERE child_id = '{c}';
         INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ('{o}', '{f}', 'foxtrot', gen_random_uuid(), 'opus', now());
         INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ('{o}', 'foxtrot', '{f}', 'active');
         INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ('{o}', '{f}', 'live', 1);
         INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ('{o}', '{f}', '{b}');
         INSERT INTO issuer_capacity (org_id, principal_id) VALUES ('{o}', '{f}');
         INSERT INTO funding_edges (org_id, child_id, issuer_id, tier, grant_centi) VALUES ('{o}', '{f}', '{b}', 'opus', 0);
         INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) VALUES ('{o}', '{fm}', 'agent', '{f}', 1, 'open');
         UPDATE funding_edges SET grant_centi = 1400 WHERE child_id = '{b}';
         UPDATE issuer_capacity SET child_grants_centi = 500, child_seats = '{{\"sonnet\": 1, \"opus\": 1}}' WHERE principal_id = '{b}';
         UPDATE issuer_capacity SET child_grants_centi = 2400 WHERE principal_id = '{a}';
         INSERT INTO audience_grants (org_id, grantee_id, target_kind, target_id, created_at) VALUES
           ('{o}', '{c}', 'user', '00000000-0000-0000-0000-000000000000', now()), ('{o}', '{f}', 'user', '00000000-0000-0000-0000-000000000000', now());",
        c = c(),
        b = b(),
        a = a(),
        fm = mb(f)
    ))
    .await;
    assert_conserved("deep fixture").await;
    file(x, c(), 8, "fc").await;
    file(x, f, 2, "ff").await;
}

async fn q_fd4(control: bool) -> (bool, Vec<String>, String) {
    reset().await;
    let x = executor(if control { vec!["Q-FD4.skip_one_hop_update"] } else { vec![] });
    deep_fixture(&x).await;
    let ids: Vec<String> = [c(), foxtrot()]
        .iter()
        .map(|p| format!("{p}"))
        .collect();
    let rc = text(&format!("SELECT legacy_id FROM request_batches WHERE asker_id = '{}' AND state = 'pending'", ids[0])).await;
    let rf = text(&format!("SELECT legacy_id FROM request_batches WHERE asker_id = '{}' AND state = 'pending'", ids[1])).await;
    let mut h = x.script.hold(Some("a1"), "funding.decide.after_locks");
    let a1 = decide(&rc, "approve", None);
    let a2 = decide(&rf, "approve", None);
    let hire = Racer::Hire { id: Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0f1), name: "yankee", parent: Some(b()), tier: "opus", grant_centi: 0 };
    let (b1, b2, bh) = (user_binding("a1"), user_binding("a2"), system_binding("h"));
    let others = async { tokio::join!(x.ex.run(&hire, &bh), x.ex.run(&a2, &b2)) };
    let (o1, ((oh, o2), _)) = tokio::join!(x.ex.run(&a1, &b1), while_held(&mut h, 1500, others));
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Applied(_)));
    let hire_outcome = oh.unwrap().name().to_string();
    (x.ev.has("control_executed:Q-FD4.skip_one_hop_update"), funding_violations().await, hire_outcome)
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd4_deep_bubbling_conserves_at_every_hop() {
    let (ran, v, hire) = q_fd4(false).await;
    assert!(!ran);
    assert_eq!(v, Vec::<String>::new(), "conservation broken at a hop");
    assert_eq!(hire, "refused", "the hire must not fund a seat from the manager's spent credit");
    assert_eq!(grant_of(c()).await, 800);
    assert_eq!(grant_of(foxtrot()).await, 200);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd4_control_one_hop_locked_not_updated_funds_two_obligations() {
    let (ran, v, hire) = q_fd4(true).await;
    assert!(ran, "control did not record that it executed");
    assert_eq!(hire, "applied", "control executed but the hire was refused: it proves nothing");
    assert!(v.iter().any(|s| s.starts_with("bravo:")), "no violation at bravo's hop: {v:?}");
}

// ================================================================ Q-FD5: the kiosk pool (synthetic harness, outside desktop mode)

/// A kiosk organization whose credits pool is 160: top-level holdings are
/// alpha 100 + 3 and echo 50 + 3 = 156. Exactly one of {alpha +3, echo +3,
/// a top-level opus hire} fits.
async fn kiosk_fixture(x: &Ex) {
    admin_exec(&format!(
        "UPDATE organizations SET kiosk = true; INSERT INTO kiosk_pool (org_id, pool_centi, top_grants_centi, top_seats) VALUES ('{}', 16000, 15000, '{{\"opus\": 2}}');",
        org()
    ))
    .await;
    file(x, a(), 103, "ka").await;
    file(x, e(), 53, "ke").await;
}

async fn top_holdings() -> (i64, i64) {
    let held = count(
        "SELECT coalesce(sum(f.grant_centi + p.seat_centi), 0)::bigint FROM topology_edges t
           JOIN authority_epoch ae ON ae.org_id = t.org_id AND ae.principal_id = t.principal_id AND ae.lifecycle <> 'archived'
           JOIN funding_edges f ON f.org_id = t.org_id AND f.child_id = t.principal_id
           JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id
           JOIN catalog_current c ON c.org_id = t.org_id JOIN price_catalog p ON p.org_id = t.org_id AND p.catalog_version = c.catalog_version AND p.tier = a.tier
          WHERE t.parent_id IS NULL",
    )
    .await;
    (held, count("SELECT pool_centi FROM kiosk_pool").await)
}

async fn q_fd5(control: bool) -> (bool, i64, i64, usize) {
    reset().await;
    let x = executor(if control { vec!["Q-FD5.no_kiosk_pool_row"] } else { vec![] });
    kiosk_fixture(&x).await;
    let ra = text(&format!("SELECT legacy_id FROM request_batches WHERE asker_id = '{}'", a())).await;
    let re = text(&format!("SELECT legacy_id FROM request_batches WHERE asker_id = '{}'", e())).await;
    let mut h = x.script.hold(Some("k1"), "funding.decide.before_commit");
    let d1 = decide(&ra, "approve", None);
    let d2 = decide(&re, "approve", None);
    let hire = Racer::Hire { id: Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0f2), name: "zulu", parent: None, tier: "opus", grant_centi: 0 };
    let (b1, b2, bh) = (user_binding("k1"), user_binding("k2"), system_binding("kh"));
    let others = async { tokio::join!(x.ex.run(&d2, &b2), x.ex.run(&hire, &bh)) };
    let (o1, ((o2, oh), _)) = tokio::join!(x.ex.run(&d1, &b1), while_held(&mut h, 1500, others));
    let applied = [name(&o1), name(&o2), oh.unwrap().name().to_string()].iter().filter(|n| *n == "applied").count();
    let (held, pool) = top_holdings().await;
    (x.ev.has("control_executed:Q-FD5.no_kiosk_pool_row"), held, pool, applied)
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd5_the_kiosk_pool_is_never_exceeded() {
    let (ran, held, pool, applied) = q_fd5(false).await;
    assert!(!ran);
    assert!(held <= pool, "held {held} > pool {pool}");
    assert_eq!(applied, 1, "exactly one of the three fits");
    // the pool row's aggregate equals the real top-level holdings
    assert_eq!(count("SELECT top_grants_centi + coalesce((top_seats->>'opus')::bigint, 0) * 300 FROM kiosk_pool").await, held);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_fd5_control_no_pool_row_exceeds_the_pool() {
    let (ran, held, pool, applied) = q_fd5(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(applied >= 2, "control executed but only {applied} applied");
    assert!(held > pool, "control executed but the pool held: {held} <= {pool}");
}

// ================================================================ Q-OP2: operator and agent reallocations

/// alpha (41) funds bravo (20 + 3) and delta (10 + 3): free 5.
async fn op2_fixture() {
    reset().await;
    admin_exec(&format!("UPDATE funding_edges SET grant_centi = 4100 WHERE child_id = '{}'", a())).await;
    assert_conserved("op2 fixture").await;
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_op2_operator_and_agent_on_one_payer_conserve_both_orders() {
    for operator_first in [true, false] {
        op2_fixture().await;
        let x = executor(vec![]);
        let (op, ag) = (realloc(b(), 4), realloc(d(), 4));
        let (ob, abind) = (user_binding("op"), agent_binding(a(), "ag"));
        let first_key = if operator_first { "op" } else { "ag" };
        let mut h = x.script.hold(Some(first_key), "funding.reallocate.after_locks");
        let (o1, (o2, no_wait)) = if operator_first {
            tokio::join!(x.ex.run(&op, &ob), while_held(&mut h, 1500, x.ex.run(&ag, &abind)))
        } else {
            tokio::join!(x.ex.run(&ag, &abind), while_held(&mut h, 1500, x.ex.run(&op, &ob)))
        };
        assert!(!no_wait, "operator_first={operator_first}: the second did not wait on the shared payer");
        assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
        let o2 = o2.unwrap();
        if operator_first {
            // alpha's free is 1 after the operator's +4: the agent (alpha acts) is short
            assert!(matches!(o2, Outcome::Refused(ref r) if r.code == "funding.chainshort"), "{o2:?}");
        } else {
            // the user's reallocation bubbles the shortfall to the unlimited pool
            assert!(matches!(o2, Outcome::Applied(_)), "{o2:?}");
        }
        assert_conserved(&format!("op2 operator_first={operator_first}")).await;
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_op2_disjoint_payers_do_not_wait() {
    // under different top-level trees, and under ONE top-level ancestor
    for (label, first, second) in [
        ("different trees", (realloc(e(), 5), user_binding("p1")), (realloc(d(), 1), agent_binding(a(), "p2"))),
        ("one tree", (realloc(c(), 1), agent_binding(b(), "p1")), (realloc(d(), 1), agent_binding(a(), "p2"))),
        ("one tree, user", (realloc(c(), 1), user_binding("p1")), (realloc(d(), 1), user_binding("p2"))),
    ] {
        reset().await;
        let x = executor(vec![]);
        let mut h = x.script.hold(Some("p1"), "funding.reallocate.before_commit");
        let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&first.0, &first.1), while_held(&mut h, 1500, x.ex.run(&second.0, &second.1)));
        assert!(matches!(o1.unwrap(), Outcome::Applied(_)), "{label}");
        assert!(matches!(o2.unwrap(), Outcome::Applied(_)), "{label}");
        assert!(no_wait, "{label}: a reallocation on a disjoint payer waited");
        assert_conserved(label).await;
    }
}

/// r7 names Q-C8's control for Q-OP2. Both writers here are READ COMMITTED
/// outside the island, and each reads its payer's obligations from the rows
/// after taking the payer's capacity lock, so a lock-only capacity row does
/// NOT let either overspend. This test records that measured fact for the
/// lead: under the control, conservation still holds in Q-OP2 (the control
/// fails only against an island writer, Q-C8/Q-FD4).
#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_op2_with_q_c8_control_armed_still_conserves_between_two_outside_writers() {
    op2_fixture().await;
    let x = executor(vec!["Q-C8.lock_not_update"]);
    let (op, ag) = (realloc(b(), 4), realloc(d(), 4));
    let (ob, abind) = (user_binding("op"), agent_binding(a(), "ag"));
    let mut h = x.script.hold(Some("op"), "funding.reallocate.after_locks");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&op, &ob), while_held(&mut h, 1500, x.ex.run(&ag, &abind)));
    assert!(x.ev.has("control_executed:Q-C8.lock_not_update"));
    assert!(matches!(o1.unwrap(), Outcome::Applied(_)));
    assert!(matches!(o2.unwrap(), Outcome::Refused(_)));
    let v = funding_violations().await;
    // obligations still within grants; only the aggregate is stale (the control's own damage)
    assert!(v.iter().all(|s| s.contains("capacity aggregate")), "{v:?}");
    assert!(!v.is_empty(), "the control left the aggregate true: it did not run as written");
}
