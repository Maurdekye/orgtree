//! WS3a: `staffing.hire` and `operator.hire` on a real PostgreSQL (this
//! agent's WS1 dev cluster), with schedules Q-ST1, Q-ST2, Q-ST4, Q-ST5,
//! Q-OP1, Q-OP3, Q-OP4 and the hire's part of Q-C8 (S3 §7.4; r7 §8.2).
//!
//! Run ONLY through the P03 run lock (`artifacts\run-pg.ps1 -Test
//! ws3a_hire_pg` via `p03-run.ps1`). The racing retire and narrowing are
//! SCHEDULE-GRADE stand-ins defined below (WS3b builds the real ones): every
//! result that depends on them says so. The racing reallocation (Q-C8) is
//! WS4's real `funding::Reallocate`. Mail is WS5's real Sent.
//!
//! Every schedule records its achieved order and asserts it equals the
//! intended one; every unsafe control asserts `control_executed` AND the
//! failure it is supposed to cause.
#![cfg(feature = "qualification")]

mod common_ws3a;

use common_ws3a::*;
use orgtree_funding_core::pynum::PyNum;
use orgtree_store::funding::Reallocate;
use orgtree_store::mail::doors::{AgentSend, Target};
use orgtree_store::sent::MailClass;
use orgtree_store::staffing::hire::{operator_identity, Door, Hire, HireSpec, Hired};
use orgtree_store::{Binding, CmdError, Command, Decided, ExecError, Family, Isolation, Outcome, Refusal, Session, Tx, Uuid, Val};
use serde_json::{json, Value};

// ================================================================ helpers

fn tools_all() -> Value {
    json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["*"]})
}

/// An agent-door hire with every no-defaults field stated.
fn agent_spec(name: &str, target: Option<&str>, grant: i64) -> HireSpec {
    HireSpec {
        target: target.map(str::to_string),
        name: name.into(),
        tier: Some("opus".into()),
        grant: Some(json!(grant)),
        add_dirs: Some(json!([])),
        tools: Some(tools_all()),
        org_visibility: Some("full".into()),
        charter: Some(format!("You are {name}.\nDo the work.")),
        ..HireSpec::default()
    }
}

/// A user hire (defaults allowed).
fn user_spec(name: &str, target: Option<&str>, grant: i64) -> HireSpec {
    HireSpec { target: target.map(str::to_string), name: name.into(), tier: Some("opus".into()), grant: Some(json!(grant)), ..HireSpec::default() }
}

fn agent_hire(name: &str, target: Option<&str>, grant: i64) -> Hire {
    Hire::new(Door::Agent, agent_spec(name, target, grant))
}

fn oname(o: &Result<Outcome<Hired>, ExecError>) -> String {
    match o {
        Ok(Outcome::Refused(r)) => format!("refused:{}", r.message),
        Ok(o) => o.name().to_string(),
        Err(e) => format!("error {e:?}"),
    }
}

fn applied(o: &Result<Outcome<Hired>, ExecError>) -> Hired {
    match o {
        Ok(Outcome::Applied(h)) => h.clone(),
        other => panic!("expected applied, got {other:?}"),
    }
}

fn refused(o: &Result<Outcome<Hired>, ExecError>) -> String {
    match o {
        Ok(Outcome::Refused(r)) => r.message.clone(),
        other => panic!("expected refused, got {other:?}"),
    }
}

async fn assert_conserved(ctx: &str) {
    let v = funding_violations().await;
    assert!(v.is_empty(), "{ctx}: conservation broken: {v:?}");
}

async fn agents() -> i64 {
    count(&format!("SELECT count(*) FROM agents WHERE org_id = '{}'", org())).await
}

async fn principal_of(name: &str) -> Uuid {
    let s = text(&format!("SELECT principal_id::text FROM agent_names WHERE org_id = '{}' AND name = '{name}'", org())).await;
    s.parse().unwrap()
}

async fn mails(dest: Uuid, kind: &str) -> i64 {
    count(&format!("SELECT count(*) FROM mail_sent WHERE org_id = '{}' AND dest_principal_id = '{dest}' AND kind = '{kind}'", org())).await
}

/// Record the schedule's achieved order in the log (the WS7 comparator
/// reads the same events) and require it to equal the intended one.
fn order(x: &Ex, name: &str, intended: &[&str]) {
    let achieved = x.ev.achieved(intended);
    println!("SCHEDULE {name}: intended {intended:?} achieved {achieved:?}");
    assert_eq!(achieved, intended.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{name}: interleaving not achieved\n{}", x.ev.dump());
}

fn control_ran(x: &Ex, id: &str) {
    assert!(x.ev.has(&format!("control_executed:{id}")), "control {id} did not record that it ran:\n{}", x.ev.dump());
    println!("CONTROL {id}: executed");
}

// ================================================================ schedule-grade racing writers (stand-ins)
//
// SCHEDULE-GRADE: real SQL and the design's lock set for the rows these
// schedules race, driven from this harness (decision 1 Q4). WS3b builds the
// real retire and retool; results that depend on these say so.

static SG_ISLAND: Family = Family { name: "sg.island", isolation: Isolation::Serializable, retry_unique: &[] };
static SG_OUTSIDE: Family = Family { name: "sg.outside", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// `retire` of X (island): X's authority-epoch row FOR NO KEY UPDATE, then
/// X's live subtree (legacy auto-dissolve) archived top-down, each archived
/// seat's seat and grant freed from its payer's capacity row (P2 rule 1).
struct RetireSg(Uuid);

impl Command for RetireSg {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &SG_ISLAND
    }
    fn verb(&self) -> &'static str {
        "retire"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        let r = tx.exec("sg.retire.lock_epoch", "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(self.0)]).await?;
        if r.first().and_then(|r| r.first()).and_then(Val::as_text) != Some("live") {
            return Ok(Decided::Refused(Refusal::new("not_live", "already archived")));
        }
        tx.pause("after_lock").await?;
        let mut set = vec![self.0];
        let mut i = 0;
        while i < set.len() {
            let kids = tx
                .exec(
                    "sg.retire.children",
                    "SELECT t.principal_id FROM topology_edges t JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
                     WHERE t.org_id = $1 AND t.parent_id = $2 AND e.lifecycle = 'live' ORDER BY t.principal_id",
                    &[Val::Uuid(org), Val::Uuid(set[i])],
                )
                .await?;
            set.extend(kids.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)));
            i += 1;
        }
        for x in &set {
            tx.exec("sg.retire.archive", "UPDATE authority_epoch SET lifecycle = 'archived', version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*x)]).await?;
            tx.exec(
                "sg.retire.free",
                "UPDATE issuer_capacity c SET child_grants_centi = c.child_grants_centi - f.grant_centi, \
                 child_seats = jsonb_set(c.child_seats, ARRAY[f.tier], to_jsonb(coalesce((c.child_seats->>f.tier)::bigint, 0) - 1)), version = c.version + 1 \
                 FROM funding_edges f WHERE f.org_id = $1 AND f.child_id = $2 AND c.org_id = f.org_id AND c.principal_id = f.issuer_id",
                &[Val::Uuid(org), Val::Uuid(*x)],
            )
            .await?;
        }
        Ok(Decided::Applied(set.len() as i64))
    }
}

/// A narrowing retool of P (outside the island, READ COMMITTED; lead ruling
/// 2026-09-25): P's scope row FOR NO KEY UPDATE and updated, THEN P's
/// subtree listed once, then each listed row locked top-down and clamped
/// (r7 P3 outside side). Narrowing = the `bash` tool withdrawn.
struct NarrowSg(Uuid);

impl Command for NarrowSg {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &SG_OUTSIDE
    }
    fn verb(&self) -> &'static str {
        "narrow"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        const CLAMP: &str = "UPDATE scope_rows SET tools = jsonb_set(tools, '{bash}', 'false'::jsonb), version = version + 1 WHERE org_id = $1 AND principal_id = $2";
        tx.exec("sg.narrow.lock_own", "SELECT 1 FROM scope_rows WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(self.0)]).await?;
        tx.exec("sg.narrow.own", CLAMP, &[Val::Uuid(org), Val::Uuid(self.0)]).await?;
        // the subtree, listed ONCE after the own row is locked
        let mut set: Vec<Uuid> = Vec::new();
        let mut level = vec![self.0];
        while !level.is_empty() {
            let mut next = Vec::new();
            for p in &level {
                let kids = tx.exec("sg.narrow.children", "SELECT principal_id FROM topology_edges WHERE org_id = $1 AND parent_id = $2 ORDER BY principal_id", &[Val::Uuid(org), Val::Uuid(*p)]).await?;
                next.extend(kids.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)));
            }
            set.extend(next.iter().copied());
            level = next;
        }
        tx.pause("after_listing").await?;
        for x in &set {
            tx.exec("sg.narrow.lock_row", "SELECT 1 FROM scope_rows WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE", &[Val::Uuid(org), Val::Uuid(*x)]).await?;
            tx.exec("sg.narrow.clamp", CLAMP, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        }
        Ok(Decided::Applied(set.len() as i64))
    }
}

// ================================================================ behaviour

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn hire_writes_the_seat_and_its_effects() {
    reset().await;
    let x = executor(vec![]);
    let mut spec = agent_spec("Xray", None, 2);
    spec.kickoff = Some("go".into());
    let o = x.ex.run(&Hire::new(Door::Agent, spec), &agent_binding(b(), "h1")).await;
    let h = applied(&o);
    assert_eq!(h.node, "xray");
    assert!(h.started, "a kickoff starts the seat");
    assert_eq!(h.next_step, "\"xray\" is hired and RUNNING — its first turn starts on your kickoff. Nothing further needed.");
    let xr = principal_of("xray").await;
    assert_eq!(xr, h.principal);
    let o_ = org();
    assert_eq!(text(&format!("SELECT a.tier || '/' || e.lifecycle || '/' || e.generation || '/' || t.parent_id::text FROM agents a JOIN authority_epoch e USING (org_id, principal_id) JOIN topology_edges t USING (org_id, principal_id) WHERE a.org_id = '{o_}' AND a.principal_id = '{xr}'")).await, format!("opus/live/0/{}", b()));
    // scope: depth 2, the stated tools, no folders, full, the org default mode capped at bravo's
    assert_eq!(text(&format!("SELECT depth || '|' || tools::text || '|' || folders::text || '|' || visibility || '|' || permission_mode FROM scope_rows WHERE principal_id = '{xr}'")).await, r#"2|{"web": true, "bash": true, "edit": true, "mcp": ["*"], "subagents": true}|[]|full|acceptEdits"#);
    // funding: the seat's own edge, bravo's capacity gains a seat and the grant (P2)
    assert_eq!(grant_of(xr).await, 200);
    assert_eq!(text(&format!("SELECT child_grants_centi || ' ' || child_seats::text FROM issuer_capacity WHERE principal_id = '{}'", b())).await, r#"700 {"opus": 2}"#);
    assert_conserved("after hire").await;
    // idle status row (legacy _new_node)
    assert_eq!(text(&format!("SELECT last_status->>'status' FROM status_rows WHERE principal_id = '{xr}'")).await, "idle");
    // notices: the peer (charlie), never the actor (bravo, who is also the parent)
    assert_eq!(mails(c(), "lifecycle.hired").await, 1);
    assert_eq!(mails(b(), "lifecycle.hired").await, 0);
    // the kickoff: one request from bravo to the new seat
    assert_eq!(count(&format!("SELECT count(*) FROM mail_sent WHERE dest_principal_id = '{xr}' AND source_id = '{}' AND kind = 'request'", b())).await, 1);
    // the role charter
    assert_eq!(text(&format!("SELECT body FROM charter_versions WHERE principal_id = '{xr}' AND charter_kind = 'role'")).await, "You are Xray.\nDo the work.");
    // a keyed retry replays; nothing is written twice
    let n = agents().await;
    let o = x.ex.run(&agent_hire("Xray", None, 2), &agent_binding(b(), "h1")).await;
    assert!(matches!(o, Ok(Outcome::Replayed(_))), "{o:?}");
    assert_eq!(agents().await, n);
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn hire_refusals_commit_nothing_with_legacy_words() {
    reset().await;
    let x = executor(vec![]);
    let n = agents().await;
    let cases: Vec<(Hire, Binding, &str)> = vec![
        (Hire::new(Door::Agent, HireSpec { tier: Some("gpt".into()), ..agent_spec("x", None, 0) }), agent_binding(b(), "r1"), "unknown tier 'gpt'; know ['opus', 'sonnet']"),
        (Hire::new(Door::Agent, HireSpec { grant: Some(json!(1.5)), ..agent_spec("x", None, 0) }), agent_binding(b(), "r2"), "grant must be a non-negative integer (№7)"),
        (Hire::new(Door::Agent, HireSpec { grant: Some(json!(-1)), ..agent_spec("x", None, 0) }), agent_binding(b(), "r3"), "grant must be a non-negative integer (№7)"),
        (agent_hire("!!!", None, 0), agent_binding(b(), "r4"), "name is mandatory and must contain letters or digits (§4.7)"),
        (agent_hire("x", Some("bravo"), 0), agent_binding(d(), "r5"), "\"bravo\" is outside your subtree — a destination is yourself or one of your own descendants (§7.1)"),
        (Hire::new(Door::Agent, HireSpec { charter: None, ..agent_spec("x", None, 0) }), agent_binding(b(), "r6"), "agent hires have no defaults — specify exactly: charter (the hire's role and standing instructions — write it in full)"),
        (Hire::new(Door::Agent, HireSpec { tools: None, ..agent_spec("x", None, 0) }), agent_binding(b(), "r7"), "an ordinary hire (hire_type='subordinate', the default) has no defaults — state tools explicitly ([] is a valid add_dirs). Only hire_type='superior' takes them from the target instead"),
        (Hire::new(Door::Agent, HireSpec { kickoff: Some("go".into()), kickoff_kind: Some("notice".into()), ..agent_spec("x", None, 0) }), agent_binding(b(), "r8"), "kickoff_kind 'notice' contradicts a kickoff"),
        (Hire::new(Door::Agent, HireSpec { tools: Some(json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["nope"]})), ..agent_spec("x", Some("charlie"), 0) }), agent_binding(b(), "r9"), "ok-if-held"),
        (Hire::new(Door::Operator, user_spec("x", Some("nobody"), 0)), user_binding("r10"), "no such node: 'nobody'"),
        (Hire::new(Door::Agent, HireSpec { external_handles: vec!["@mcp:x".into()], ..agent_spec("x", None, 0) }), agent_binding(b(), "r11"), "external_handles are retired"),
    ];
    for (h, bnd, want) in cases {
        let key = bnd.op.key.clone();
        let o = x.ex.run(&h, &bnd).await;
        if want == "ok-if-held" {
            // charlie holds mcp "*", so the named server is within its grant
            assert!(matches!(o, Ok(Outcome::Applied(_))), "{key}: {o:?}");
            continue;
        }
        let m = refused(&o);
        assert!(m.starts_with(want), "{key}: got {m:?}, want {want:?}");
    }
    // charlie (grant 5, free 5) cannot fund an opus seat plus 10: no bubbling above the actor
    let o = x.ex.run(&agent_hire("big", None, 10), &agent_binding(c(), "r12")).await;
    let m = refused(&o);
    assert!(m.contains("not enough free credits"), "{m}");
    // only the r9 seat exists; no receipt for any refusal
    assert_eq!(agents().await, n + 1);
    assert_eq!(count("SELECT count(*) FROM operation_receipts WHERE op_key IN ('r1','r2','r3','r4','r5','r6','r7','r8','r10','r11','r12')").await, 0);
    assert_conserved("after refusals").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn names_take_the_lowest_free_suffix_and_the_user_hires_at_top_level() {
    reset().await;
    let x = executor(vec![]);
    // an existing name, archived holders included
    admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", e())).await;
    let h = applied(&x.ex.run(&Hire::new(Door::Operator, user_spec("Echo", None, 1)), &user_binding("n1")).await);
    assert_eq!(h.node, "echo-2");
    let h = applied(&x.ex.run(&Hire::new(Door::Operator, user_spec("echo!!", None, 0)), &user_binding("n2")).await);
    assert_eq!(h.node, "echo-3");
    // top level: the new seat has no parent and no payer; alpha and echo-2 are its peers
    let e3 = principal_of("echo-3").await;
    assert_eq!(count(&format!("SELECT count(*) FROM topology_edges WHERE principal_id = '{e3}' AND parent_id IS NULL")).await, 1);
    assert_eq!(mails(a(), "lifecycle.hired").await, 2);
    assert!(!h.started);
    assert_eq!(h.next_step, "\"echo-3\" is hired and IDLE. Hiring does not start it — send it an orgtree_message now saying what to do (or pass `kickoff` to this tool next time), or it will never run.");
    assert_conserved("after top-level hires").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn a_deep_user_hire_bubbles_and_conserves() {
    reset().await;
    let x = executor(vec![]);
    // under charlie (free 5): opus 3 + grant 10 = 13, so 8 bubbles from bravo
    let h = applied(&x.ex.run(&Hire::new(Door::Operator, user_spec("deep", Some("charlie"), 10)), &user_binding("d1")).await);
    assert!(h.warnings.iter().any(|w| w.contains("bravo")), "{:?}", h.warnings);
    assert_eq!(grant_of(c()).await, 1300, "charlie inflated by the 8 that bubbled");
    assert!(x.ev.any("retry:staffing.operator_hire:d1:funding.lockset_extended"), "the first attempt locked only the payer:\n{}", x.ev.dump());
    assert_conserved("after the bubbling hire").await;
}

// ================================================================ Q-ST1: the children cap

async fn q_st1_cap_fixture() {
    reset().await;
    admin_exec(&format!("UPDATE org_controls SET value = '{{\"max_children\": 2}}' WHERE org_id = '{}' AND family = 'caps'", org())).await;
}

/// One hire holds after all its reads and locks; the other runs into the
/// held one's capacity-row lock, waits, then retries (40001) and meets the cap.
async fn q_st1_forced(first: &'static str, second: &'static str) {
    q_st1_cap_fixture().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some(first), "staffing.hire.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&agent_hire(first, None, 0), &agent_binding(b(), first)).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&agent_hire(second, None, 0), &agent_binding(b(), second)).await });
    assert!(still_waiting(&h2, 400).await, "the second hire must wait on the first's capacity-row lock");
    held.go();
    let (o1, o2) = (h1.await.unwrap(), h2.await.unwrap());
    let x = &*ex;
    order(x, &format!("Q-ST1 {first} then {second}"), &[first]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert_eq!(refused(&o2), "bravo already has 2 reports (cap)");
    assert!(x.ev.any(&format!("retry:staffing.hire:{second}:serialization_failure:40001")) || x.ev.any(&format!("retry:staffing.hire:{second}:")), "{}", x.ev.dump());
    assert_eq!(children_of(b()).await, 2, "the cap holds");
    assert_conserved("Q-ST1").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st1_cap_holds_both_orders() {
    q_st1_forced("st1-a", "st1-b").await;
    q_st1_forced("st1-b", "st1-a").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st1_control_rc_count_first_exceeds_the_cap() {
    q_st1_cap_fixture().await;
    let x = executor(vec!["Q-ST1.rc_count_first"]);
    let mut held = x.script.hold(Some("st1-rc"), "staffing.hire.children_counted");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::unsafe_rc(Door::Agent, agent_spec("rc", None, 0), "Q-ST1.rc_count_first"), &agent_binding(b(), "st1-rc")).await });
    held.arrive().await;
    let o2 = ex.ex.run(&agent_hire("ser", None, 0), &agent_binding(b(), "st1-ser")).await;
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "{}", oname(&o2));
    held.go();
    let o1 = h1.await.unwrap();
    let x = &*ex;
    order(x, "Q-ST1 control", &["st1-ser", "st1-rc"]);
    control_ran(x, "Q-ST1.rc_count_first");
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert_eq!(children_of(b()).await, 3, "the control exceeds the cap (it must FAIL the pass condition)");
    println!("CONTROL Q-ST1.rc_count_first: failed as designed (bravo has 3 reports under a cap of 2)");
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st1_disjoint_destinations_do_not_conflict() {
    reset().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("dj-b"), "staffing.hire.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&agent_hire("under-bravo", None, 0), &agent_binding(b(), "dj-b")).await });
    held.arrive().await;
    let o2 = ex.ex.run(&agent_hire("under-delta", None, 0), &agent_binding(d(), "dj-d")).await;
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "the disjoint hire did not wait: {}", oname(&o2));
    held.go();
    let o1 = h1.await.unwrap();
    let x = &*ex;
    order(x, "Q-ST1 disjoint", &["dj-d", "dj-b"]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    let retries = x.ev.count_prefix("retry:");
    println!("Q-ST1 disjoint: retries observed = {retries}\n{}", x.ev.dump());
    assert_eq!(retries, 0, "hires under different destinations with disjoint payers must not conflict");
    assert_conserved("Q-ST1 disjoint").await;
}

// ================================================================ Q-ST2: bubbling through a shared finite ancestor

/// alpha (an agent actor) at its last 3 free credits; hires under bravo
/// (free 12, grant 12: needs 3 from alpha) and under delta (free 10, grant
/// 10: needs 3 from alpha). Only one fits.
async fn q_st2_fixture() {
    reset().await;
    // alpha's children cost 3+20 + 3+10 = 36; grant 39 leaves free 3
    admin_exec(&format!("UPDATE funding_edges SET grant_centi = 3900 WHERE child_id = '{}'", a())).await;
    assert_conserved("Q-ST2 fixture").await;
}

async fn q_st2_run(controls: Vec<&'static str>) -> (Ex, Result<Outcome<Hired>, ExecError>, Result<Outcome<Hired>, ExecError>) {
    q_st2_fixture().await;
    let x = executor(controls);
    let mut held = x.script.hold(Some("st2-b"), "staffing.hire.after_funding_locks");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&agent_hire("via-bravo", Some("bravo"), 12), &agent_binding(a(), "st2-b")).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&agent_hire("via-delta", Some("delta"), 10), &agent_binding(a(), "st2-d")).await });
    let waited = still_waiting(&h2, 400).await;
    println!("Q-ST2: second hire waiting on alpha's capacity row: {waited}");
    held.go();
    let (o1, o2) = (h1.await.unwrap(), h2.await.unwrap());
    (std::sync::Arc::try_unwrap(ex).ok().expect("single owner"), o1, o2)
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st2_the_last_credit_is_spent_once() {
    let (x, o1, o2) = q_st2_run(vec![]).await;
    order(&x, "Q-ST2", &["st2-b"]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert!(refused(&o2).contains("not enough free credits"), "{}", oname(&o2));
    assert_conserved("Q-ST2").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st2_control_lock_not_update() {
    let (x, o1, o2) = q_st2_run(vec!["Q-C8.lock_not_update"]).await;
    control_ran(&x, "Q-C8.lock_not_update");
    println!("Q-ST2 control: first {} second {}\n{}", oname(&o1), oname(&o2), x.ev.dump());
    let v = funding_violations().await;
    println!("Q-ST2 control violations: {v:?}");
    assert!(!v.is_empty(), "the control must FAIL conservation (the last credit spent twice); it did not: first {} second {}", oname(&o1), oname(&o2));
}

// ================================================================ Q-ST4: two hires of one name

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st4_one_name_distinct_keys() {
    // (a) one destination, (b) two destinations with disjoint chains and payers, (c) over an archived holder
    for (tag, first, second, archived) in [
        ("same-dest", (b(), None::<&str>), (b(), None::<&str>), false),
        ("disjoint", (b(), None), (e(), None), false),
        ("archived-holder", (b(), None), (e(), None), true),
    ] {
        reset().await;
        let name = if archived { "delta" } else { "zulu" };
        if archived {
            admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", d())).await;
        }
        let x = executor(vec![]);
        let k1 = format!("st4-{tag}-1");
        let k2 = format!("st4-{tag}-2");
        let mut held = x.script.hold(Some(&k1), "staffing.hire.name_probe.after");
        let ex = std::sync::Arc::new(x);
        let (e1, kk1) = (ex.clone(), k1.clone());
        let h1 = tokio::spawn(async move { e1.ex.run(&agent_hire(name, first.1, 0), &agent_binding(first.0, &kk1)).await });
        held.arrive().await;
        let (e2, kk2) = (ex.clone(), k2.clone());
        let h2 = tokio::spawn(async move { e2.ex.run(&agent_hire(name, second.1, 0), &agent_binding(second.0, &kk2)).await });
        // the second either waits (one destination: the capacity row) or commits
        let _ = still_waiting(&h2, 400).await;
        held.go();
        let (o1, o2) = (h1.await.unwrap(), h2.await.unwrap());
        let (h1, h2) = (applied(&o1), applied(&o2));
        let x = &*ex;
        println!("Q-ST4 {tag}: {} and {}; achieved {:?}", h1.node, h2.node, x.ev.achieved(&[&k1, &k2]));
        assert_ne!(h1.node, h2.node, "{tag}: two seats with one key");
        let mut got = vec![h1.node, h2.node];
        got.sort();
        let want: Vec<String> = if archived { vec!["delta-2".into(), "delta-3".into()] } else { vec!["zulu".into(), "zulu-2".into()] };
        assert_eq!(got, want, "{tag}");
        // no 500: every statement error was a retried conflict (23505 on the name index, or 40001)
        for e in x.ev.0.lock().unwrap().iter().filter(|e| e.starts_with("stmt_err:")) {
            assert!(e.ends_with(":23505") || e.ends_with(":40001") || e.ends_with(":40P01"), "{tag}: unexpected statement error {e}");
        }
        assert_conserved(tag).await;
    }
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st4_control_probe_outside_no_index_duplicates_a_key() {
    reset().await;
    admin_exec("ALTER TABLE agent_names DROP CONSTRAINT agent_names_active").await;
    let x = executor(vec!["Q-ST4.probe_outside_no_index"]);
    let mut held = x.script.hold(Some("st4c-1"), "staffing.hire.name_probe.after");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::unsafe_rc(Door::Agent, agent_spec("zulu", None, 0), "Q-ST4.probe_outside_no_index"), &agent_binding(b(), "st4c-1")).await });
    held.arrive().await;
    let o2 = ex.ex.run(&Hire::unsafe_rc(Door::Agent, agent_spec("zulu", None, 0), "Q-ST4.probe_outside_no_index"), &agent_binding(e(), "st4c-2")).await;
    held.go();
    let o1 = h1.await.unwrap();
    let x = &*ex;
    order(x, "Q-ST4 control", &["st4c-2", "st4c-1"]);
    control_ran(x, "Q-ST4.probe_outside_no_index");
    assert_eq!(applied(&o1).node, "zulu");
    assert_eq!(applied(&o2).node, "zulu");
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name = 'zulu'", org())).await, 2, "the control must produce a duplicate key");
    println!("CONTROL Q-ST4.probe_outside_no_index: failed as designed (two seats named zulu)");
}

// ================================================================ Q-ST5: a hire racing a narrowing of its destination's parent

/// Hire under charlie (Q) holds after its scope locks; the narrowing of
/// bravo (P) runs into the held locks; then the hire commits. SCHEDULE-GRADE
/// narrowing (NarrowSg).
async fn q_st5_hire_first(controls: Vec<&'static str>) -> (Ex, Uuid) {
    reset().await;
    let x = executor(controls);
    let mut held = x.script.hold(Some("st5-h"), "staffing.hire.after_funding_locks");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::new(Door::Operator, user_spec("quebec", Some("charlie"), 0)), &user_binding("st5-h")).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&NarrowSg(b()), &system_binding("st5-n")).await });
    let waited = still_waiting(&h2, 400).await;
    println!("Q-ST5: narrowing waiting: {waited}");
    held.go();
    let o1 = h1.await.unwrap();
    let o2 = h2.await.unwrap();
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "{o2:?}");
    let q = principal_of("quebec").await;
    (std::sync::Arc::try_unwrap(ex).ok().expect("single owner"), q)
}

async fn bash_of(x: Uuid) -> String {
    text(&format!("SELECT tools->>'bash' FROM scope_rows WHERE principal_id = '{x}'")).await
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st5_the_new_seat_is_within_the_narrowed_chain_both_orders() {
    // hire first: the narrowing waits on bravo's row (share-locked by the hire), then lists the subtree WITH the new seat
    let (x, q) = q_st5_hire_first(vec![]).await;
    order(&x, "Q-ST5 hire first", &["st5-h", "st5-n"]);
    assert_eq!(bash_of(b()).await, "false");
    assert_eq!(bash_of(q).await, "false", "the new seat was clamped with its chain");
    // narrowing first: the narrowing holds after listing; the hire meets bravo's updated row (40001) and derives from the narrowed chain
    reset().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("st5-n2"), "sg.outside.narrow.after_listing");
    let ex = std::sync::Arc::new(x);
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&NarrowSg(b()), &system_binding("st5-n2")).await });
    held.arrive().await;
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::new(Door::Operator, user_spec("quebec", Some("charlie"), 0)), &user_binding("st5-h2")).await });
    assert!(still_waiting(&h1, 400).await, "the hire waits on bravo's scope row");
    held.go();
    assert!(matches!(h2.await.unwrap(), Ok(Outcome::Applied(_))));
    let o1 = h1.await.unwrap();
    let x = &*ex;
    order(x, "Q-ST5 narrowing first", &["st5-n2", "st5-h2"]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    let q = principal_of("quebec").await;
    assert_eq!(bash_of(c()).await, "false");
    assert_eq!(bash_of(q).await, "false", "derived from the narrowed charlie");
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st5_control_share_destination_only_escapes_the_clamp() {
    let (x, q) = q_st5_hire_first(vec!["Q-ST5.share_destination_only"]).await;
    control_ran(&x, "Q-ST5.share_destination_only");
    println!("Q-ST5 control: bravo bash={} new seat bash={}", bash_of(b()).await, bash_of(q).await);
    assert_eq!(bash_of(b()).await, "false");
    assert_eq!(bash_of(q).await, "true", "the control must leave the seat wider than its narrowed chain");
    println!("CONTROL Q-ST5.share_destination_only: failed as designed (the new seat holds bash under a bravo without it)");
}

// ================================================================ Q-OP1: operator hire racing an agent hire on one chain

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op1_caps_hold_and_unrelated_mail_does_not_wait() {
    for (first, second) in [("op1-op", "op1-ag"), ("op1-ag", "op1-op")] {
        q_st1_cap_fixture().await;
        let x = executor(vec![]);
        let point = if first == "op1-op" { "staffing.operator_hire.name_probe.before" } else { "staffing.hire.name_probe.before" };
        let mut held = x.script.hold(Some(first), point);
        let ex = std::sync::Arc::new(x);
        let run = |k: &'static str| {
            let e = ex.clone();
            tokio::spawn(async move {
                if k == "op1-op" {
                    e.ex.run(&Hire::new(Door::Operator, user_spec("by-operator", Some("bravo"), 0)), &operator_binding(None, Some(k))).await
                } else {
                    e.ex.run(&agent_hire("by-agent", None, 0), &agent_binding(b(), k)).await
                }
            })
        };
        let h1 = run(first);
        held.arrive().await;
        // unrelated mail (echo -> delta) while the first holds all its locks
        let t0 = std::time::Instant::now();
        let m = ex.ex.run(&AgentSend { target: Target::Agent { principal: d() }, message_id: Uuid::new_v4(), class: MailClass::Message, kind: "message".into(), body: "unrelated".into(), urgent_reason: None, reply_grant: false }, &agent_binding(e(), "op1-mail")).await;
        let waited_ms = t0.elapsed().as_millis();
        assert!(matches!(m, Ok(Outcome::Applied(_))), "{m:?}");
        println!("Q-OP1 {first}: unrelated mail took {waited_ms} ms while the hire held");
        assert!(waited_ms < 2000, "the unrelated mail waited on the held hire");
        let h2 = run(second);
        assert!(still_waiting(&h2, 400).await);
        held.go();
        let (o1, o2) = (h1.await.unwrap(), h2.await.unwrap());
        let x = &*ex;
        order(x, &format!("Q-OP1 {first} first"), &["op1-mail", first]);
        assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
        assert_eq!(refused(&o2), "bravo already has 2 reports (cap)");
        assert_eq!(children_of(b()).await, 2);
        assert_conserved("Q-OP1").await;
    }
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op1_control_document_lock_makes_unrelated_mail_wait() {
    reset().await;
    let x = executor(vec!["Q-OP1.document_lock"]);
    let mut held = x.script.hold(Some("op1c"), "staffing.operator_hire.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::new(Door::Operator, user_spec("by-operator", Some("bravo"), 0)), &operator_binding(None, Some("op1c"))).await });
    held.arrive().await;
    let e2 = ex.clone();
    let m = tokio::spawn(async move {
        e2.ex.run(&AgentSend { target: Target::Agent { principal: d() }, message_id: Uuid::new_v4(), class: MailClass::Message, kind: "message".into(), body: "unrelated".into(), urgent_reason: None, reply_grant: false }, &agent_binding(e(), "op1c-mail")).await
    });
    let waited = still_waiting(&m, 800).await;
    held.go();
    let _ = h1.await.unwrap();
    let _ = m.await.unwrap();
    let x = &*ex;
    control_ran(x, "Q-OP1.document_lock");
    order(x, "Q-OP1 control", &["op1c", "op1c-mail"]);
    assert!(waited, "the control must make the unrelated mail wait");
    println!("CONTROL Q-OP1.document_lock: failed as designed (the unrelated send waited for the operator hire)");
}

// ================================================================ Q-OP3: an operator hire acting as A racing A's retire

fn op3_hire() -> Hire {
    Hire::new(Door::Operator, user_spec("as-bravo", Some("charlie"), 0))
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op3_hire_under_as_authority_or_refused_both_orders() {
    // hire first: the retire waits on bravo's epoch (the E5 anchor), then retries and archives the new seat too
    reset().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("op3-h"), "staffing.operator_hire.after_funding_locks");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&op3_hire(), &operator_binding(Some(b()), Some("op3-h"))).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&RetireSg(b()), &system_binding("op3-r")).await });
    assert!(still_waiting(&h2, 400).await, "the retire waits on bravo's epoch row");
    held.go();
    let o1 = h1.await.unwrap();
    let o2 = h2.await.unwrap();
    let x = &*ex;
    order(x, "Q-OP3 hire first", &["op3-h", "op3-r"]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "{o2:?}");
    let s = principal_of("as-bravo").await;
    assert_eq!(text(&format!("SELECT lifecycle FROM authority_epoch WHERE principal_id = '{s}'")).await, "archived", "the retire saw the committed seat and dissolved it with the subtree");
    // retire first (forced: the retire holds after its lock; the hire's anchor meets the updated row)
    reset().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("op3-r2"), "sg.island.retire.after_lock");
    let ex = std::sync::Arc::new(x);
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&RetireSg(b()), &system_binding("op3-r2")).await });
    held.arrive().await;
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&op3_hire(), &operator_binding(Some(b()), Some("op3-h2"))).await });
    assert!(still_waiting(&h1, 400).await, "the hire's acting anchor waits on the retire");
    held.go();
    assert!(matches!(h2.await.unwrap(), Ok(Outcome::Applied(_))));
    let o1 = h1.await.unwrap();
    let x = &*ex;
    order(x, "Q-OP3 retire first", &["op3-r2"]);
    assert!(refused(&o1).contains("not live"), "{}", oname(&o1));
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name = 'as-bravo'", org())).await, 0);
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op3_control_rc_prechecked_hires_under_an_archived_actor() {
    reset().await;
    let x = executor(vec!["Q-OP3.rc_acting_prechecked"]);
    let mut held = x.script.hold(Some("op3c"), "staffing.operator_hire.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move {
        e1.ex.run(&Hire::unsafe_rc(Door::Operator, user_spec("as-bravo", Some("charlie"), 0), "Q-OP3.rc_acting_prechecked"), &operator_binding(Some(b()), Some("op3c"))).await
    });
    held.arrive().await;
    let o2 = ex.ex.run(&RetireSg(b()), &system_binding("op3c-r")).await;
    assert!(matches!(o2, Ok(Outcome::Applied(_))), "the retire commits while the unanchored hire is paused: {o2:?}");
    held.go();
    let o1 = h1.await.unwrap();
    let x = &*ex;
    control_ran(x, "Q-OP3.rc_acting_prechecked");
    order(x, "Q-OP3 control", &["op3c-r", "op3c"]);
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    let s = principal_of("as-bravo").await;
    assert_eq!(text(&format!("SELECT lifecycle FROM authority_epoch WHERE principal_id = '{}'", b())).await, "archived");
    assert_eq!(text(&format!("SELECT lifecycle FROM authority_epoch WHERE principal_id = '{s}'")).await, "live", "the control must create a live seat under the authority of an archived actor");
    println!("CONTROL Q-OP3.rc_acting_prechecked: failed as designed (a live seat hired as an archived bravo, under an archived charlie)");
}

// ================================================================ Q-OP4: a retried operator hire

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op4_one_seat_with_a_key_two_without() {
    reset().await;
    let x = executor(vec![]);
    let hooks = x.ex.hooks();
    // with a key: sequential retry replays; a concurrent duplicate waits on the claim and replays
    let bind = |k: Option<&str>| {
        let op = operator_identity(hooks, org(), operator(), k, "fp-op4");
        Binding { principal: orgtree_store::Principal::Operator { id: operator() }, acting: None, op, db_incarnation: incarnation(), op_tag: None }
    };
    let b1 = bind(Some("op4"));
    let o1 = x.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &b1).await;
    let o2 = x.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &bind(Some("op4"))).await;
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert!(matches!(o2, Ok(Outcome::Replayed(_))), "{}", oname(&o2));
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name LIKE 'keyed%'", org())).await, 1);
    // without a key: legacy, two seats
    let o3 = x.ex.run(&Hire::new(Door::Operator, user_spec("unkeyed", Some("bravo"), 0)), &bind(None)).await;
    let o4 = x.ex.run(&Hire::new(Door::Operator, user_spec("unkeyed", Some("bravo"), 0)), &bind(None)).await;
    assert_eq!(applied(&o3).node, "unkeyed");
    assert_eq!(applied(&o4).node, "unkeyed-2");
    // concurrent duplicate with a key
    reset().await;
    let x = executor(vec![]);
    let hooks_b = operator_identity(x.ex.hooks(), org(), operator(), Some("op4c"), "fp-op4");
    let mk = || Binding { principal: orgtree_store::Principal::Operator { id: operator() }, acting: None, op: hooks_b.clone(), db_incarnation: incarnation(), op_tag: None };
    let mut held = x.script.hold(Some("op4c"), "staffing.operator_hire.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let (e1, b1) = (ex.clone(), mk());
    let h1 = tokio::spawn(async move { e1.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &b1).await });
    held.arrive().await;
    let (e2, b2) = (ex.clone(), mk());
    let h2 = tokio::spawn(async move { e2.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &b2).await });
    assert!(still_waiting(&h2, 400).await, "the duplicate waits on the uncommitted claim");
    held.go();
    let (o1, o2) = (h1.await.unwrap(), h2.await.unwrap());
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{}", oname(&o1));
    assert!(matches!(o2, Ok(Outcome::Replayed(_))), "{}", oname(&o2));
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name LIKE 'keyed%'", org())).await, 1);
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_op4_control_key_unbound_seats_two() {
    reset().await;
    let x = executor(vec!["Q-OP4.key_unbound"]);
    let bind = || {
        let op = operator_identity(x.ex.hooks(), org(), operator(), Some("op4"), "fp-op4");
        Binding { principal: orgtree_store::Principal::Operator { id: operator() }, acting: None, op, db_incarnation: incarnation(), op_tag: None }
    };
    let o1 = x.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &bind()).await;
    let o2 = x.ex.run(&Hire::new(Door::Operator, user_spec("keyed", Some("bravo"), 0)), &bind()).await;
    control_ran(&x, "Q-OP4.key_unbound");
    assert_eq!(applied(&o1).node, "keyed");
    assert_eq!(applied(&o2).node, "keyed-2", "the control must seat two agents for one key");
    println!("CONTROL Q-OP4.key_unbound: failed as designed (two seats for key op4)");
}

// ================================================================ Q-C8 (hire part): a hire under P racing a reallocation of P's child

/// bravo's last free credits: charlie raised so bravo's free is exactly one
/// opus seat (3.00).
async fn q_c8_fixture() {
    reset().await;
    admin_exec(&format!(
        "UPDATE funding_edges SET grant_centi = 1400 WHERE child_id = '{c}'; UPDATE issuer_capacity SET child_grants_centi = 1400 WHERE principal_id = '{b}';",
        c = c(),
        b = b()
    ))
    .await;
    assert_conserved("Q-C8 fixture").await;
}

async fn q_c8_forced(controls: Vec<&'static str>) -> (Ex, Result<Outcome<Hired>, ExecError>) {
    q_c8_fixture().await;
    let x = executor(controls);
    let mut held = x.script.hold(Some("c8-r"), "funding.reallocate.after_locks");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Reallocate::new(c(), PyNum::Int(3)), &agent_binding(b(), "c8-r")).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&agent_hire("xray", None, 0), &agent_binding(b(), "c8-h")).await });
    let waited = still_waiting(&h2, 400).await;
    println!("Q-C8: hire waiting on bravo's capacity row: {waited}");
    held.go();
    let o1 = h1.await.unwrap();
    assert!(matches!(o1, Ok(Outcome::Applied(_))), "{o1:?}");
    let o2 = h2.await.unwrap();
    (std::sync::Arc::try_unwrap(ex).ok().expect("single owner"), o2)
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_c8_hire_racing_reallocate_at_the_last_credit() {
    let (x, o) = q_c8_forced(vec![]).await;
    order(&x, "Q-C8 reallocate first", &["c8-r"]);
    assert!(refused(&o).contains("not enough free credits"), "{}", oname(&o));
    assert_conserved("Q-C8").await;
    // the other order: the hire first, then the reallocation is refused
    q_c8_fixture().await;
    let x = executor(vec![]);
    assert!(matches!(x.ex.run(&agent_hire("xray", None, 0), &agent_binding(b(), "c8-h2")).await, Ok(Outcome::Applied(_))));
    let o = x.ex.run(&Reallocate::new(c(), PyNum::Int(3)), &agent_binding(b(), "c8-r2")).await.unwrap();
    assert!(matches!(o, Outcome::Refused(_)), "{o:?}");
    assert_conserved("Q-C8 hire first").await;
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_c8_control_lock_not_update_spends_the_last_credit_twice() {
    let (x, o) = q_c8_forced(vec!["Q-C8.lock_not_update"]).await;
    control_ran(&x, "Q-C8.lock_not_update");
    println!("Q-C8 control: hire {}", oname(&o));
    let v = funding_violations().await;
    println!("Q-C8 control violations: {v:?}");
    assert!(!v.is_empty(), "the control must FAIL conservation; hire outcome {}", oname(&o));
}

// ================================================================ the staff door and Q-ST3

use orgtree_store::staffing::staff::{staff_split, ItemSpec, Staff, StaffSpec, Staffed};
use orgtree_store::work::{Archive, WorkUpdate};

fn item_id() -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_003a_1001)
}

/// One backlogged item `wi`, owned by charlie, at revision 1.
async fn item_fixture() {
    let o = org();
    admin_exec(&format!(
        "INSERT INTO work_items (org_id, item_id, name, title, kind, status, owner_id, creator_id, rev, created_at, updated_at)
           VALUES ('{o}', '{i}', 'wi', 'The item', 'code', 'backlogged', '{c}', '{b}', 1, now(), now());
         INSERT INTO active_work_names (org_id, name, item_id) VALUES ('{o}', 'wi', '{i}');",
        i = item_id(),
        c = c(),
        b = b()
    ))
    .await;
}

fn staff_update(name: &str) -> StaffSpec {
    StaffSpec { seat: agent_spec(name, None, 0), item: ItemSpec { slug: Some("wi".into()), ..ItemSpec::default() }, ..StaffSpec::default() }
}

fn sname(o: &Result<Outcome<Staffed>, ExecError>) -> String {
    match o {
        Ok(Outcome::Refused(r)) => format!("refused:{}", r.message),
        Ok(o) => o.name().to_string(),
        Err(e) => format!("error {e:?}"),
    }
}

async fn item_owner() -> String {
    text(&format!(
        "SELECT coalesce(a.name, '-') || '/' || w.status || '/' || w.rev FROM work_items w LEFT JOIN agents a ON a.org_id = w.org_id AND a.principal_id = w.owner_id WHERE w.item_id = '{}'",
        item_id()
    ))
    .await
}

#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn staff_creates_and_updates_with_the_seat_as_owner() {
    reset().await;
    item_fixture().await;
    let x = executor(vec![]);
    // update: the backlogged item moves from charlie to the new seat and starts
    let o = x.ex.run(&Staff::new(staff_update("kilo")), &agent_binding(b(), "sf1")).await;
    let Ok(Outcome::Applied(s)) = &o else { panic!("{}", sname(&o)) };
    assert_eq!((s.node.as_str(), s.item.as_str(), s.updated.as_deref(), s.started), ("kilo", "wi", Some("wi"), true));
    assert_eq!(item_owner().await, "kilo/open/2");
    let k = principal_of("kilo").await;
    assert_eq!(mails(k, "request").await, 1, "one assignment mail");
    assert_eq!(mails(c(), "work.reassigned").await, 1, "the previous owner is told");
    // create
    let spec = StaffSpec { seat: agent_spec("lima", None, 0), item: ItemSpec { title: Some("A New Thing".into()), ..ItemSpec::default() }, ..StaffSpec::default() };
    let o = x.ex.run(&Staff::new(spec), &agent_binding(b(), "sf2")).await;
    let Ok(Outcome::Applied(s)) = &o else { panic!("{}", sname(&o)) };
    assert_eq!(s.created.as_deref(), Some("a-new-thing"));
    // rehire mode on a LIVE agent: the no-op (E-D10 KEEP) and the item is still assigned
    let spec = StaffSpec { node: Some("charlie".into()), item: ItemSpec { slug: Some("wi".into()), ..ItemSpec::default() }, ..StaffSpec::default() };
    let o = x.ex.run(&Staff::new(spec), &agent_binding(b(), "sf3")).await;
    let Ok(Outcome::Applied(s)) = &o else { panic!("{}", sname(&o)) };
    assert!(s.already_live);
    assert_eq!(item_owner().await, "charlie/open/3");
    // refusals roll back the seat too
    let n = agents().await;
    let spec = StaffSpec { seat: agent_spec("mike", None, 0), item: ItemSpec { slug: Some("nope".into()), ..ItemSpec::default() }, ..StaffSpec::default() };
    let o = x.ex.run(&Staff::new(spec), &agent_binding(b(), "sf4")).await;
    assert_eq!(sname(&o), "refused:no such work item: nope");
    let spec = StaffSpec { seat: agent_spec("mike", None, 0), item: ItemSpec { action: Some("update".into()), ..ItemSpec::default() }, ..StaffSpec::default() };
    assert_eq!(sname(&x.ex.run(&Staff::new(spec), &agent_binding(b(), "sf5")).await), "refused:action 'update' needs `slug`: the item to update and hand to this agent");
    assert_eq!(agents().await, n, "no seat without its item");
    assert_conserved("staff").await;
}

/// Q-ST3: `orgtree_staff` racing an update of the same item, both orders.
#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st3_staff_racing_an_item_update_both_orders() {
    // docket write first: it holds the head; staffing waits, then retries (40001) and applies after it
    reset().await;
    item_fixture().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("st3-w"), "work.update.stmt.work.lock_head.after");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&WorkUpdate { item: item_id(), status: Some("in_progress".into()), ..WorkUpdate::default() }, &agent_binding(c(), "st3-w")).await });
    held.arrive().await;
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&Staff::new(staff_update("kilo")), &agent_binding(b(), "st3-s")).await });
    assert!(still_waiting(&h2, 400).await, "staffing waits on the item head");
    held.go();
    assert!(matches!(h1.await.unwrap(), Ok(Outcome::Applied(_))));
    let o = h2.await.unwrap();
    let x = &*ex;
    order(x, "Q-ST3 update first", &["st3-w", "st3-s"]);
    assert!(matches!(o, Ok(Outcome::Applied(_))), "{}", sname(&o));
    assert_eq!(item_owner().await, "kilo/in_progress/3", "both applied, serially");
    // staffing first: it holds before commit; the docket write waits and continues from staffing's row
    reset().await;
    item_fixture().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("st3-s2"), "staffing.staff.before_commit");
    let ex = std::sync::Arc::new(x);
    let e2 = ex.clone();
    let h2 = tokio::spawn(async move { e2.ex.run(&Staff::new(staff_update("kilo")), &agent_binding(b(), "st3-s2")).await });
    held.arrive().await;
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&WorkUpdate { item: item_id(), status: Some("in_progress".into()), ..WorkUpdate::default() }, &agent_binding(c(), "st3-w2")).await });
    assert!(still_waiting(&h1, 400).await, "the docket write waits on the head");
    held.go();
    assert!(matches!(h2.await.unwrap(), Ok(Outcome::Applied(_))));
    assert!(matches!(h1.await.unwrap(), Ok(Outcome::Applied(_))));
    let x = &*ex;
    order(x, "Q-ST3 staffing first", &["st3-s2", "st3-w2"]);
    assert_eq!(item_owner().await, "kilo/in_progress/3");
    // never an item owned by a seat that does not exist
    assert_eq!(count(&format!("SELECT count(*) FROM work_items w WHERE w.item_id = '{}' AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.principal_id = w.owner_id)", item_id())).await, 0);
}

/// The atomic staff call against an item dropped between its reads and its
/// lock: the whole call refuses, no seat. The split control: a seat without
/// its item.
#[tokio::test]
#[ignore = "needs the WS3a dev cluster; run through p03-run.ps1"]
async fn q_st3_control_split_transactions_leaves_a_seat_without_its_item() {
    // pass shape first: atomic
    reset().await;
    item_fixture().await;
    let x = executor(vec![]);
    let mut held = x.script.hold(Some("st3a"), "staffing.staff.name_probe.before");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { e1.ex.run(&Staff::new(staff_update("kilo")), &agent_binding(b(), "st3a")).await });
    held.arrive().await;
    let d = ex.ex.run(&WorkUpdate { item: item_id(), archive: Some(Archive::Drop), ..WorkUpdate::default() }, &agent_binding(c(), "st3a-drop")).await;
    assert!(matches!(d, Ok(Outcome::Applied(_))), "{d:?}");
    held.go();
    let o = h1.await.unwrap();
    assert!(sname(&o).starts_with("refused:work item wi is archived"), "{}", sname(&o));
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name = 'kilo'", org())).await, 0, "atomic: no seat");
    // the control: seat and item in two transactions, the drop between them
    reset().await;
    item_fixture().await;
    let x = executor(vec!["Q-ST3.split_transactions"]);
    let mut held = x.script.hold(None, "staffing.staff_item.begin");
    let ex = std::sync::Arc::new(x);
    let e1 = ex.clone();
    let h1 = tokio::spawn(async move { staff_split(&e1.ex, &staff_update("kilo"), &agent_binding(b(), "st3c")).await });
    held.arrive().await;
    let d = ex.ex.run(&WorkUpdate { item: item_id(), archive: Some(Archive::Drop), ..WorkUpdate::default() }, &agent_binding(c(), "st3c-drop")).await;
    assert!(matches!(d, Ok(Outcome::Applied(_))), "{d:?}");
    held.go();
    let (seat, item) = h1.await.unwrap().unwrap();
    let x = &*ex;
    control_ran(x, "Q-ST3.split_transactions");
    assert!(matches!(seat, Outcome::Applied(_)), "{seat:?}");
    assert!(matches!(item, Some(Outcome::Refused(_))), "{item:?}");
    assert_eq!(count(&format!("SELECT count(*) FROM agent_names WHERE org_id = '{}' AND name = 'kilo'", org())).await, 1, "the control must leave a seat without its item");
    println!("CONTROL Q-ST3.split_transactions: failed as designed (seat kilo exists, its item write was refused)");
}
