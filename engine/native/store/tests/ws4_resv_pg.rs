//! WS4 reservations on a real PostgreSQL (the WS1 dev cluster of
//! p03-ws4-rcfamilies): the eleven `reservation.*` variants (r7 §3) and the
//! schedules Q-R1–Q-R11, Q-C1 and the anchored-mutation part of Q-C3.
//!
//! Run ONLY through the P03 run lock (`artifacts\run-pg.ps1 -Test
//! ws4_resv_pg` via `p03-run.ps1`). Where a schedule's unsafe condition is a
//! missing index (K1 for Q-R1, K2 for Q-R3), the harness drops it for that
//! run and the code records `control_executed` at the insert.
#![cfg(feature = "qualification")]

mod common_ws4;

use common_ws4::*;
use orgtree_store::claims::ClaimRegistry;
use orgtree_store::hooks::HookAction;
use orgtree_store::reservation::{Acquire, ListScope, LockingList, ReservationRead, RowAction};
use orgtree_store::work::{WorkCreate, WorkUpdate};
use orgtree_store::{Binding, ExecError, Outcome, Uuid};
use serde_json::{json, Value};

const C1: &str = "aaaaaaa";
const B1: &str = "bbbbbbb";
const C2: &str = "ccccccc";

fn acq(resource: &str, item: Option<&str>, key: Option<&str>) -> Acquire {
    let mut a = json!({"resource": resource, "candidate": C1, "base": B1});
    if let Some(i) = item {
        a["item"] = json!(i);
    }
    if let Some(k) = key {
        a["integration_key"] = json!(k);
    }
    Acquire { args: a, reservation_id: new_id() }
}

fn act(action: &'static str, rid: &str, extra: Value) -> RowAction {
    let mut a = json!({"reservation": rid});
    if let Value::Object(m) = extra {
        for (k, v) in m {
            a[k] = v;
        }
    }
    RowAction::new(action, a)
}

fn name(o: &Result<Outcome<Value>, ExecError>) -> String {
    match o {
        Ok(o) => o.name().to_string(),
        Err(e) => format!("error {e:?}"),
    }
}

fn applied(o: Result<Outcome<Value>, ExecError>) -> Value {
    match o {
        Ok(Outcome::Applied(v)) | Ok(Outcome::Replayed(v)) => v,
        o => panic!("expected applied, got {o:?}"),
    }
}

fn refusal(o: &Result<Outcome<Value>, ExecError>) -> String {
    match o {
        Ok(Outcome::Refused(r)) => r.message.clone(),
        o => panic!("expected a refusal, got {o:?}"),
    }
}

/// An item owned by bravo with charlie as participant.
async fn item(x: &Ex, name: &str) -> Uuid {
    let id = new_id();
    let o = x.ex.run(&WorkCreate { item: id, name: name.into(), title: "t".into(), status: "open".into(), owner: Some(b()), participants: vec![c()] }, &user_binding(&format!("mk-{name}"))).await.unwrap();
    assert!(matches!(o, Outcome::Applied(_)), "{o:?}");
    id
}

async fn held(resource: &str) -> i64 {
    count(&format!("SELECT count(*) FROM resource_reservations WHERE resource = '{resource}' AND state = 'held'")).await
}

async fn age(rid: &str, lease_expired: bool, heartbeat_quiet: bool) {
    let mut set = Vec::new();
    if lease_expired {
        set.push("expires_at = clock_timestamp() - interval '1 second'".to_string());
    }
    if heartbeat_quiet {
        set.push("heartbeat_at = clock_timestamp() - interval '1 hour'".to_string());
    }
    admin_exec(&format!("UPDATE resource_reservations SET {} WHERE reservation_id = '{rid}'", set.join(", "))).await;
}

fn rid_of(v: &Value) -> String {
    v["reservation"]["id"].as_str().unwrap().to_string()
}

async fn read(x: &Ex, me: Uuid, action: &'static str, args: Value) -> Result<Value, orgtree_store::Refusal> {
    x.ex.read(&ReservationRead { org: org(), me, action, args }, org(), None).await.unwrap()
}

// ================================================================ the verbs, serially (legacy semantics)

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn reservation_verbs_keep_legacy_semantics() {
    reset().await;
    let x = executor(vec![]);
    item(&x, "item-one").await;
    // acquire, replay, contention refusal naming the holder
    let v = applied(x.ex.run(&acq("main", Some("item-one"), None), &agent_binding(c(), "a1")).await);
    assert_eq!(v["replayed"], json!(false));
    assert_eq!(v["reservation"]["owner"], json!("charlie"));
    assert_eq!(v["reservation"]["item"], json!("item-one"));
    let rid = rid_of(&v);
    let v2 = applied(x.ex.run(&acq("main", Some("item-one"), None), &agent_binding(c(), "a2")).await);
    assert_eq!(v2["replayed"], json!(true));
    let o = x.ex.run(&acq("main", None, None), &agent_binding(d(), "a3")).await;
    let m = refusal(&o);
    assert!(m.starts_with("main is already reserved by an active operation: held by charlie since "), "{m}");
    // an agent that cannot read the item is refused identically to a missing item
    let o = x.ex.run(&acq("other", Some("item-one"), None), &agent_binding(e(), "a4")).await;
    assert_eq!(refusal(&o), "reservation is not visible to this collaborator");
    let o = x.ex.run(&acq("other", Some("no-such-item"), None), &agent_binding(e(), "a5")).await;
    assert_eq!(refusal(&o), "reservation is not visible to this collaborator");
    // argument validation, legacy wording
    let o = x.ex.run(&Acquire { args: json!({"resource": "r", "candidate": "XYZ", "base": B1}), reservation_id: new_id() }, &agent_binding(c(), "a6")).await;
    assert!(refusal(&o).starts_with("candidate must be a commit SHA: "), "{o:?}");
    // list: the owner sees the full row, a stranger naming the resource sees contention only
    let l = read(&x, c(), "list", json!({})).await.unwrap();
    assert_eq!(l["count"], json!(1));
    assert!(l["reservations"][0].get("paths").is_some());
    let l = read(&x, e(), "list", json!({"resource": "main"})).await.unwrap();
    assert_eq!(l["reservations"][0]["view"], json!("contention"));
    assert!(l["reservations"][0].get("item").is_none());
    let l = read(&x, e(), "list", json!({})).await.unwrap();
    assert_eq!(l["count"], json!(0), "an unfiltered list is never a directory of private claims");
    // renew (owner only), recover refusals, release, release replay
    assert_eq!(refusal(&x.ex.run(&act("renew", &rid, json!({})), &agent_binding(b(), "a7")).await), "only the reservation owner may perform this action");
    assert_eq!(applied(x.ex.run(&act("renew", &rid, json!({"lease_s": 60})), &agent_binding(c(), "a8")).await)["renewed"], json!(true));
    assert_eq!(refusal(&x.ex.run(&act("recover", &rid, json!({})), &agent_binding(d(), "a9")).await), "reservation heartbeat is active; recovery cannot steal an active operation");
    let r = applied(x.ex.run(&act("release", &rid, json!({})), &agent_binding(c(), "a10")).await);
    assert_eq!(r["released"], json!(true));
    assert!(r["release_receipt"].as_str().unwrap().starts_with(&format!("release:{rid}:")));
    let r = applied(x.ex.run(&act("release", &rid, json!({})), &agent_binding(c(), "a11")).await);
    assert_eq!((r["replayed"].clone(), r["notified"].clone()), (json!(true), Value::Null));
    // land: acquire again, land with a key, replay, and the key identifies it
    let v = applied(x.ex.run(&acq("main", Some("item-one"), Some("k-1")), &agent_binding(c(), "b1")).await);
    let rid2 = rid_of(&v);
    let l = applied(x.ex.run(&act("land", &rid2, json!({})), &agent_binding(c(), "b2")).await);
    assert_eq!(l["landed"], json!(true));
    let l = applied(x.ex.run(&act("land", &rid2, json!({})), &agent_binding(c(), "b3")).await);
    assert_eq!(l["replayed"], json!(true));
    let lg = read(&x, b(), "landing", json!({"item": "item-one"})).await.unwrap();
    assert_eq!(lg["count"], json!(1), "the item's owner reads its landing");
    assert!(read(&x, e(), "landing", json!({"item": "item-one"})).await.is_err());
    // an acquire replaying the landed key's scope replays; another scope refuses
    let v = applied(x.ex.run(&acq("main", Some("item-one"), Some("k-1")), &agent_binding(c(), "b4")).await);
    assert_eq!(v["replayed"], json!(true));
    let o = x.ex.run(&Acquire { args: json!({"resource": "main", "candidate": C2, "base": B1, "integration_key": "k-1"}), reservation_id: new_id() }, &agent_binding(c(), "b5")).await;
    assert_eq!(refusal(&o), "integration_key already identifies a different reservation");
    // overlap by paths
    let v = applied(x.ex.run(&Acquire { args: json!({"resource": "wt", "candidate": C1, "base": B1, "item": "item-one", "paths": ["src//a/", "docs"]}), reservation_id: new_id() }, &agent_binding(c(), "b6")).await);
    assert_eq!(v["reservation"]["paths"], json!(["src/a", "docs"]));
    let ov = read(&x, b(), "overlap", json!({"item": "item-one", "paths": ["src"]})).await.unwrap();
    assert_eq!(ov["count"], json!(1));
    assert_eq!(ov["overlaps"][0]["overlap"], json!(["src"]));
}

// ================================================================ Q-R1: contenders on one free resource

async fn q_r1(k: usize, drop_k1: bool) -> (i64, Vec<String>, bool, bool) {
    reset().await;
    if drop_k1 {
        admin_exec("DROP INDEX resource_reservations_held_resource").await;
    }
    let x = executor_pool(if drop_k1 { vec!["Q-R1.no_k1"] } else { vec![] }, k + 2);
    // one distinct owner per contender: the five fixture agents, then hires under echo
    let mut agents = vec![a(), b(), c(), d(), e()];
    for i in 0..k.saturating_sub(5) {
        let id = Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_b100 + i as u128);
        let nm: &'static str = Box::leak(format!("x{i}").into_boxed_str());
        applied_unit(x.ex.run(&Racer::Hire { id, name: nm, parent: Some(e()), tier: "sonnet", grant_centi: 0 }, &system_binding(&format!("hx{i}"))).await);
        agents.push(id);
    }
    let keys: Vec<String> = (0..k).map(|i| format!("r1-{i}")).collect();
    // every contender reads "no holder" before any inserts: all held there
    let mut holds: Vec<Held> = keys.iter().map(|k| x.script.hold(Some(k), "reservation.acquire.after_holder_lock")).collect();
    let cmds: Vec<Acquire> = (0..k).map(|_| acq("main", None, None)).collect();
    let binds: Vec<Binding> = (0..k).map(|i| agent_binding(agents[i % agents.len()], &keys[i])).collect();
    let runs = futures_join_all(cmds.iter().zip(binds.iter()).map(|(c, b)| x.ex.run(c, b)));
    let release = async {
        for h in holds.iter_mut() {
            h.arrive().await;
        }
        for h in holds.iter() {
            h.go();
        }
    };
    let (outs, ()) = tokio::join!(runs, release);
    let names: Vec<String> = outs.iter().map(name).collect();
    let collided = x.ev.any("retry:reservation.acquire:") && x.ev.0.lock().unwrap().iter().any(|e| e.contains("resource_reservations_held_resource"));
    (held("main").await, names, collided, x.ev.has("control_executed:Q-R1.no_k1"))
}

/// A small join_all without an extra crate.
async fn futures_join_all<F: std::future::Future>(fs: impl Iterator<Item = F>) -> Vec<F::Output> {
    let mut v: Vec<std::pin::Pin<Box<F>>> = fs.map(Box::pin).collect();
    let mut out: Vec<Option<F::Output>> = (0..v.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, f) in v.iter_mut().enumerate() {
            if out[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(o) => out[i] = Some(o),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    out.into_iter().map(|o| o.unwrap()).collect()
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r1_exactly_one_holder_among_contenders() {
    for k in [2usize, 5, 16] {
        let (h, names, collided, ran) = q_r1(k, false).await;
        assert!(!ran);
        assert_eq!(h, 1, "k={k}: {names:?}");
        assert!(collided, "k={k}: no K1 collision was retried: the contenders did not overlap");
        assert_eq!(names.iter().filter(|n| *n == "applied").count(), 1, "k={k}: {names:?}");
        assert!(names.iter().all(|n| n == "applied" || n == "refused" || n == "replayed"), "k={k}: a constraint error surfaced: {names:?}");
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r1_control_without_k1_two_holders() {
    let (h, names, _, ran) = q_r1(4, true).await;
    assert!(ran, "control did not record that it executed");
    assert!(h >= 2, "control executed but only {h} HELD row: {names:?}");
}

// ================================================================ Q-R2 / Q-C1: disjoint resources never wait

async fn q_c1(control: bool) -> (bool, usize, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-C1.org_wide_lock"] } else { vec![] });
    let it = item(&x, "item-c1").await;
    // one acquire holds before commit; disjoint acquires, an item write, a
    // mail send and a status report run meanwhile
    let mut h = x.script.hold(Some("c1-0"), "reservation.acquire.before_commit");
    let first = acq("res-0", None, None);
    let b0 = agent_binding(a(), "c1-0");
    let (r1, r2) = (acq("res-1", None, None), acq("res-2", None, None));
    let (b1, b2) = (agent_binding(b(), "c1-1"), agent_binding(d(), "c1-2"));
    let up = WorkUpdate { item: it, status: Some("in_progress".into()), ..Default::default() };
    let bu = user_binding("c1-3");
    let st = orgtree_store::status::StatusReport { status: "working".into(), summary: "x".into(), message_id: new_id() };
    let bs = agent_binding(e(), "c1-4");
    let others = async { tokio::join!(x.ex.run(&r1, &b1), x.ex.run(&r2, &b2), x.ex.run(&up, &bu), x.ex.run(&st, &bs)) };
    let (o0, ((o1, o2, o3, o4), no_wait)) = tokio::join!(x.ex.run(&first, &b0), while_held(&mut h, 2000, others));
    let all = [name(&o0), name(&o1), name(&o2), o3.map(|o| o.name().to_string()).unwrap_or_default(), o4.map(|o| o.name().to_string()).unwrap_or_default()];
    assert!(all.iter().all(|n| n == "applied"), "{all:?}");
    let retries = x.ev.count_prefix("retry:");
    (no_wait, retries, x.ev.has("control_executed:Q-C1.org_wide_lock"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c1_q_r2_disjoint_writers_zero_waits_zero_aborts() {
    let (no_wait, retries, ran) = q_c1(false).await;
    assert!(!ran);
    assert!(no_wait, "a disjoint writer waited on the held acquire");
    assert_eq!(retries, 0, "serialization failures or deadlocks between disjoint writers");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c1_control_org_wide_lock_makes_them_wait() {
    let (no_wait, _, ran) = q_c1(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!no_wait, "control executed but nothing waited: it proves nothing");
}

// ================================================================ Q-R3: one row per integration key

async fn q_r3(drop_k2: bool, second_resource: &str) -> (i64, String, String, bool) {
    reset().await;
    if drop_k2 {
        admin_exec("DROP INDEX resource_reservations_integration_key").await;
    }
    let x = executor(if drop_k2 { vec!["Q-R3.no_k2"] } else { vec![] });
    // both read "no row with this key" before either inserts
    let mut h1 = x.script.hold(Some("k1"), "reservation.acquire.after_holder_lock");
    let mut h2 = x.script.hold(Some("k2"), "reservation.acquire.after_holder_lock");
    let (a1, a2) = (acq("main", None, Some("key-1")), acq(second_resource, None, Some("key-1")));
    let (b1, b2) = (agent_binding(c(), "k1"), agent_binding(c(), "k2"));
    let release = async {
        h1.arrive().await;
        h2.arrive().await;
        h1.go();
        h2.go();
    };
    let ((o1, o2), ()) = tokio::join!(async { tokio::join!(x.ex.run(&a1, &b1), x.ex.run(&a2, &b2)) }, release);
    let rows = count("SELECT count(*) FROM resource_reservations WHERE integration_key = 'key-1'").await;
    (rows, name(&o1), name(&o2), x.ev.has("control_executed:Q-R3.no_k2"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r3_at_most_one_row_per_key() {
    // acquire/acquire, same scope: one inserts, the other replays
    let (rows, o1, o2, ran) = q_r3(false, "main").await;
    assert!(!ran);
    assert_eq!(rows, 1);
    let mut both = [o1, o2];
    both.sort();
    assert_eq!(both, ["applied".to_string(), "applied".to_string()], "the retry replays (answer marked replayed)");
    // acquire/acquire, different resource: the loser refuses (another reservation)
    let (rows, o1, o2, _) = q_r3(false, "other").await;
    assert_eq!(rows, 1);
    assert!([o1.as_str(), o2.as_str()].contains(&"refused"), "{o1} {o2}");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r3_control_without_k2_two_rows_with_one_key() {
    let (rows, o1, o2, ran) = q_r3(true, "other").await;
    assert!(ran, "control did not record that it executed");
    assert_eq!(rows, 2, "control executed but one key still names one row: {o1} {o2}");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r3_acquire_land_and_land_land_on_one_key() {
    reset().await;
    let x = executor(vec![]);
    let v = applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "l0")).await);
    let rid = rid_of(&v);
    let v2 = applied(x.ex.run(&acq("side", None, None), &agent_binding(c(), "l1")).await);
    let rid2 = rid_of(&v2);
    // two lands of different rows claiming one key: one lands, the other refuses
    let (l1, l2) = (act("land", &rid, json!({"integration_key": "key-9"})), act("land", &rid2, json!({"integration_key": "key-9"})));
    let (b1, b2) = (agent_binding(c(), "l2"), agent_binding(c(), "l3"));
    let mut h = x.script.hold(Some("l2"), "reservation.land.before_commit");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&l1, &b1), while_held(&mut h, 1500, x.ex.run(&l2, &b2)));
    assert_eq!(name(&o1), "applied");
    // legacy `land`: another row already LANDED under the key replays THAT row
    let v2 = applied(o2);
    assert_eq!(v2["replayed"], json!(true));
    assert_eq!(v2["reservation"]["id"], json!(rid));
    assert_eq!(text(&format!("SELECT state FROM resource_reservations WHERE reservation_id = '{rid2}'")).await, "held", "the second row is untouched");
    assert_eq!(count("SELECT count(*) FROM resource_reservations WHERE integration_key = 'key-9'").await, 1);
    // an acquire with the landed key and its scope replays the LANDED row
    let v = applied(x.ex.run(&acq("main", None, Some("key-9")), &agent_binding(c(), "l4")).await);
    assert_eq!(v["replayed"], json!(true));
    assert_eq!(v["reservation"]["state"], json!("landed"));
}

// ================================================================ Q-R4: same-row writers in both orders

async fn expired_quiet_holder(x: &Ex) -> String {
    let v = applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "h0")).await);
    let rid = rid_of(&v);
    age(&rid, true, true).await;
    rid
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r4_release_and_recover_serialize_both_orders() {
    for recover_first in [true, false] {
        reset().await;
        let x = executor(vec![]);
        let rid = expired_quiet_holder(&x).await;
        let (rec, rel) = (act("recover", &rid, json!({})), act("release", &rid, json!({})));
        let (brec, brel) = (agent_binding(d(), "rec"), agent_binding(c(), "rel"));
        let first = if recover_first { "rec" } else { "rel" };
        let point = if recover_first { "reservation.recover.after_row_lock" } else { "reservation.release.after_row_lock" };
        let mut h = x.script.hold(Some(first), point);
        let (o1, (o2, no_wait)) = if recover_first {
            tokio::join!(x.ex.run(&rec, &brec), while_held(&mut h, 1500, x.ex.run(&rel, &brel)))
        } else {
            tokio::join!(x.ex.run(&rel, &brel), while_held(&mut h, 1500, x.ex.run(&rec, &brec)))
        };
        assert!(!no_wait, "recover_first={recover_first}: the second writer did not wait on the row lock");
        assert_eq!(name(&o1), "applied");
        // legacy: a recover of a non-HELD row checks visibility first, and
        // delta cannot see charlie's item-less claim
        let expect = if recover_first { "only a held reservation can be released" } else { "reservation is not visible to this collaborator" };
        assert_eq!(refusal(&o2), expect, "recover_first={recover_first}");
        let st = text(&format!("SELECT state FROM resource_reservations WHERE reservation_id = '{rid}'")).await;
        assert_eq!(st, if recover_first { "recovered" } else { "released" });
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r4_control_no_row_lock_double_transition() {
    reset().await;
    let x = executor(vec!["Q-R4.no_row_lock"]);
    let rid = expired_quiet_holder(&x).await;
    let (rec, rel) = (act("recover", &rid, json!({})), act("release", &rid, json!({})));
    let (brec, brel) = (agent_binding(d(), "rec"), agent_binding(c(), "rel"));
    let mut h = x.script.hold(Some("rec"), "reservation.recover.after_row_lock");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&rec, &brec), while_held(&mut h, 1500, x.ex.run(&rel, &brel)));
    assert!(x.ev.has("control_executed:Q-R4.no_row_lock"), "control did not record that it executed");
    assert_eq!((name(&o1).as_str(), name(&o2).as_str()), ("applied", "applied"), "control executed but one transition refused: it proves nothing");
    // both transitions reported success; the row holds only the last one
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r4_renew_and_recover_both_orders() {
    // renew first: the heartbeat is active, recovery refuses
    reset().await;
    let x = executor(vec![]);
    let rid = expired_quiet_holder(&x).await;
    applied(x.ex.run(&act("renew", &rid, json!({})), &agent_binding(c(), "rn")).await);
    assert_eq!(refusal(&x.ex.run(&act("recover", &rid, json!({})), &agent_binding(d(), "rc")).await), "reservation heartbeat is active; recovery cannot steal an active operation");
    // recover first: renew refuses
    reset().await;
    let x = executor(vec![]);
    let rid = expired_quiet_holder(&x).await;
    applied(x.ex.run(&act("recover", &rid, json!({})), &agent_binding(d(), "rc")).await);
    assert_eq!(refusal(&x.ex.run(&act("renew", &rid, json!({})), &agent_binding(c(), "rn")).await), "only a held reservation can be renewed");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r4_recover_and_holder_rehire_both_orders() {
    for rehire_first in [true, false] {
        reset().await;
        let x = executor(vec![]);
        // an unexpired lease, a quiet heartbeat, a holder that is not live
        let v = applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "h0")).await);
        let rid = rid_of(&v);
        age(&rid, false, true).await;
        admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", c())).await;
        let rec = act("recover", &rid, json!({}));
        let brec = agent_binding(d(), "rec");
        let rh = Racer::Rehire { node: c() };
        let bh = system_binding("rh");
        if rehire_first {
            applied_unit(x.ex.run(&rh, &bh).await);
            assert_eq!(refusal(&x.ex.run(&rec, &brec).await), "reservation is still leased; recovery cannot steal an active operation");
        } else {
            let mut h = x.script.hold(Some("rec"), "reservation.recover.stmt.reservation.holder_live.after");
            let (o1, (o2, no_wait)) = tokio::join!(x.ex.run(&rec, &brec), while_held(&mut h, 1500, x.ex.run(&rh, &bh)));
            assert!(!no_wait, "the rehire did not wait on the holder's membership anchor");
            assert_eq!(name(&o1), "applied");
            assert!(matches!(o2, Ok(Outcome::Applied(()))));
            assert_eq!(text(&format!("SELECT recovery_reason FROM resource_reservations WHERE reservation_id = '{rid}'")).await, "owner_not_live");
        }
    }
}

fn applied_unit(o: Result<Outcome<()>, ExecError>) {
    assert!(matches!(o, Ok(Outcome::Applied(()))), "{o:?}");
}

// ================================================================ Q-R5: list-scope and invalidate under renews

async fn q_r5(control: bool) -> (Vec<String>, Vec<String>, bool, usize) {
    reset().await;
    let x = executor(if control { vec!["Q-R5.no_recheck"] } else { vec![] });
    // three HELD rows at the old scope: one eligible, one protected by an
    // unexpired lease, one that becomes protected by a renew during the call
    let e1 = rid_of(&applied(x.ex.run(&acq("r-e1", None, None), &agent_binding(c(), "e1")).await));
    let p1 = rid_of(&applied(x.ex.run(&acq("r-p1", None, None), &agent_binding(c(), "p1")).await));
    let rn = rid_of(&applied(x.ex.run(&acq("r-rn", None, None), &agent_binding(c(), "rn")).await));
    age(&e1, true, true).await;
    age(&p1, false, true).await;
    age(&rn, true, true).await;
    let mut h = x.script.hold(Some("ls"), "reservation.list_scope.after_pass1");
    let ls = ListScope { args: json!({"candidate": C2, "base": B1}) };
    let bl = agent_binding(c(), "ls");
    let renew = act("renew", &rn, json!({}));
    let br = agent_binding(c(), "renew");
    let (o1, (o2, _)) = tokio::join!(x.ex.run(&ls, &bl), while_held(&mut h, 1000, x.ex.run(&renew, &br)));
    assert_eq!(name(&o2), "applied");
    let v = applied(o1);
    let staled: Vec<String> = v["stale"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    let locks = x.ev.count_prefix("stmt:reservation.row_lock:ls");
    (staled, vec![e1, p1, rn], x.ev.has("control_executed:Q-R5.no_recheck"), locks)
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r5_only_eligible_rows_are_staled_and_locked() {
    let (staled, ids, ran, locks) = q_r5(false).await;
    assert!(!ran);
    assert_eq!(staled, vec![ids[0].clone()], "only the eligible row");
    assert_eq!(locks, 2, "pass 2 locks exactly the rows pass 1 found eligible (the eligible one and the one renewed meanwhile)");
    assert_eq!(text(&format!("SELECT state FROM resource_reservations WHERE reservation_id = '{}'", ids[2])).await, "held", "the just-renewed row stays held");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r5_control_no_recheck_stales_a_just_renewed_row() {
    let (staled, ids, ran, _) = q_r5(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(staled.contains(&ids[2]), "control executed but the renewed row survived: {staled:?}");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r5_invalidate_follows_legacy() {
    reset().await;
    let x = executor(vec![]);
    let rid = rid_of(&applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "i0")).await));
    assert_eq!(refusal(&x.ex.run(&act("invalidate", &rid, json!({"candidate": C1, "base": B1})), &agent_binding(c(), "i1")).await), "candidate and base are unchanged");
    assert_eq!(refusal(&x.ex.run(&act("invalidate", &rid, json!({"candidate": C2, "base": B1})), &agent_binding(c(), "i2")).await), "reservation is active; changed candidate or base cannot steal it");
    age(&rid, true, true).await;
    assert_eq!(applied(x.ex.run(&act("invalidate", &rid, json!({"candidate": C2, "base": B1})), &agent_binding(c(), "i3")).await)["stale"], json!(true));
    assert_eq!(applied(x.ex.run(&act("invalidate", &rid, json!({"candidate": C2, "base": B1})), &agent_binding(c(), "i4")).await)["replayed"], json!(true));
}

// ================================================================ Q-R6: release-notify is all or nothing

/// A release by bravo (strict ancestor, not parent, of... ) — here: alpha
/// holds, delta is its child; alpha releases to charlie (grandchild via
/// bravo), so the route is a deep descendant and a reply grant is inserted.
async fn notify_fixture(x: &Ex) -> String {
    let it = item(x, "item-r6").await;
    let _ = it;
    // alpha can read the item (strict ancestor of the owner, bravo)
    rid_of(&applied(x.ex.run(&acq("main", Some("item-r6"), None), &agent_binding(a(), "h")).await))
}

fn notify(rid: &str) -> RowAction {
    let mut r = act("release", rid, json!({}));
    r.successor = Some(c());
    r
}

async fn r6_state(rid: &str) -> (String, i64, i64, i64) {
    (
        text(&format!("SELECT state FROM resource_reservations WHERE reservation_id = '{rid}'")).await,
        count(&format!("SELECT count(*) FROM mail_sent WHERE dest_principal_id = '{}' AND kind = 'status'", c())).await,
        count(&format!("SELECT count(*) FROM audience_grants WHERE grantee_id = '{}' AND target_kind = 'agent' AND target_id = '{}'", c(), a())).await,
        count(&format!("SELECT audience_version FROM authority_epoch WHERE principal_id = '{}'", c())).await,
    )
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r6_release_notify_commits_release_sent_grant_and_bump_together() {
    reset().await;
    let x = executor(vec![]);
    let rid = notify_fixture(&x).await;
    let r = applied(x.ex.run(&notify(&rid), &agent_binding(a(), "n1")).await);
    assert_eq!(r["notified"], json!("charlie"));
    assert!(r["warnings"][0].as_str().unwrap().starts_with("audience granted: charlie may now reply to alpha"), "{r}");
    assert_eq!(r6_state(&rid).await, ("released".into(), 1, 1, 1));
    assert_eq!(count("SELECT count(*) FROM mailbox_messages").await, 0, "no receiver row in the source transaction");
    // the labels of this run: the crash points for the next test
    let labels: Vec<String> = x.ev.0.lock().unwrap().iter().filter_map(|e| e.strip_prefix("stmt:").and_then(|s| s.strip_suffix(":n1")).map(str::to_string)).collect();
    assert!(labels.contains(&"reservation.release".to_string()), "{labels:?}");
    // replay posts nothing
    let r = applied(x.ex.run(&notify(&rid), &agent_binding(a(), "n2")).await);
    assert_eq!(r["replayed"], json!(true));
    assert_eq!(r6_state(&rid).await, ("released".into(), 1, 1, 1));
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r6_a_crash_at_every_statement_leaves_all_or_nothing() {
    // the statement labels of one clean release-notify
    reset().await;
    let x = executor(vec![]);
    let rid = notify_fixture(&x).await;
    applied(x.ex.run(&notify(&rid), &agent_binding(a(), "probe")).await);
    let labels: Vec<String> = x.ev.0.lock().unwrap().iter().filter_map(|e| e.strip_prefix("stmt:").and_then(|s| s.strip_suffix(":probe")).map(str::to_string)).filter(|l| !l.starts_with("trace.")).collect();
    assert!(labels.len() > 8, "{labels:?}");
    let mut crashed = 0;
    for label in labels.iter().chain(std::iter::once(&"__commit__".to_string())) {
        reset().await;
        let x = executor(vec![]);
        let rid = notify_fixture(&x).await;
        let point = if label == "__commit__" { "reservation.release_notify.before_commit".to_string() } else { format!("reservation.release_notify.stmt.{label}.before") };
        x.script.act(Some("crash"), &point, HookAction::DropConn);
        let o = x.ex.run(&notify(&rid), &agent_binding(a(), "crash")).await;
        assert_eq!(name(&o), "applied", "crash at {label}: the retry must apply once");
        assert!(x.ev.any("retry:reservation.release_notify:crash:connection_lost"), "crash at {label}: the crash never happened");
        crashed += 1;
        assert_eq!(r6_state(&rid).await, ("released".into(), 1, 1, 1), "crash at {label}: not all-or-nothing");
    }
    assert_eq!(crashed, labels.len() + 1);
    // an addressing refusal mid-transaction rolls back the whole release
    reset().await;
    let x = executor(vec![]);
    let rid = notify_fixture(&x).await;
    let mut r = act("release", &rid, json!({}));
    r.successor = Some(e()); // echo cannot read the item
    assert_eq!(refusal(&x.ex.run(&r, &agent_binding(a(), "bad")).await), "successor is not a live collaborator");
    assert_eq!(r6_state(&rid).await.0, "held");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r6_control_1_grant_in_a_later_transaction_leaves_a_release_without_its_grant() {
    reset().await;
    let x = executor(vec!["Q-R6.grant_after_release"]);
    let rid = notify_fixture(&x).await;
    let r = applied(x.ex.run(&notify(&rid), &agent_binding(a(), "n1")).await);
    assert!(x.ev.has("control_executed:Q-R6.grant_after_release"), "control did not record that it executed");
    assert_eq!(r["grant_pending"], json!(true));
    // the crash between the two transactions: the follow-up grant never runs
    let (state, sent, grants, bump) = r6_state(&rid).await;
    assert_eq!((state.as_str(), sent), ("released", 1));
    assert_eq!((grants, bump), (0, 0), "control executed but the grant is there: it proves nothing");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r6_control_2_receiver_write_in_source_is_flagged() {
    reset().await;
    let x = executor(vec!["Q-R6.receiver_write_in_source"]);
    let rid = notify_fixture(&x).await;
    applied(x.ex.run(&notify(&rid), &agent_binding(a(), "n1")).await);
    assert!(x.ev.has("control_executed:Q-R6.receiver_write_in_source"), "control did not record that it executed");
    assert!(count("SELECT count(*) FROM mailbox_messages").await > 0, "control executed but no receiver row: the trace rule has nothing to flag");
}

// ================================================================ Q-R7: land with a changed scope writes nothing

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r7_land_with_changed_scope_refuses_and_writes_nothing() {
    for control in [false, true] {
        reset().await;
        let x = executor(if control { vec!["Q-R7.stale_mark_committed"] } else { vec![] });
        let rid = rid_of(&applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "l0")).await));
        let o = x.ex.run(&act("land", &rid, json!({"candidate": C2})), &agent_binding(c(), "l1")).await;
        let st = text(&format!("SELECT state FROM resource_reservations WHERE reservation_id = '{rid}'")).await;
        if control {
            assert!(x.ev.has("control_executed:Q-R7.stale_mark_committed"), "control did not record that it executed");
            assert_eq!(st, "stale", "control executed but the row is still held: it proves nothing");
        } else {
            assert_eq!(refusal(&o), "candidate or base changed; reservation is stale");
            assert_eq!(st, "held");
            assert!(!x.ev.any("stmt:reservation.mark_stale:l1"), "a write was attempted");
        }
    }
}

// ================================================================ Q-R8: the D1 active-only cap

async fn seed_held(n: i64) {
    let o = org();
    admin_exec(&format!(
        "INSERT INTO resource_reservations (org_id, reservation_id, owner_id, resource, candidate, base, state, created_at, updated_at, expires_at, heartbeat_at, lease_s, stale_s)
         SELECT '{o}', gen_random_uuid(), '{}', 'seed-' || g, '{C1}', '{B1}', 'held', now(), now(), now() + interval '1 hour', now(), 3600, 300 FROM generate_series(1, {n}) g",
        e()
    ))
    .await;
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r8_active_cap_overshoot_is_bounded_by_the_achieved_k() {
    reset().await;
    seed_held(511).await;
    let x = executor(vec![]);
    let k = 4usize;
    let keys: Vec<String> = (0..k).map(|i| format!("cap-{i}")).collect();
    let mut holds: Vec<Held> = keys.iter().map(|k| x.script.hold(Some(k), "reservation.acquire.after_count")).collect();
    let cmds: Vec<Acquire> = (0..k).map(|i| acq(&format!("free-{i}"), None, None)).collect();
    let binds: Vec<Binding> = keys.iter().map(|k| agent_binding(c(), k)).collect();
    let runs = futures_join_all(cmds.iter().zip(binds.iter()).map(|(c, b)| x.ex.run(c, b)));
    let release = async {
        for h in holds.iter_mut() {
            h.arrive().await;
        }
        for h in holds.iter() {
            h.go();
        }
    };
    let (outs, ()) = tokio::join!(runs, release);
    // every one of the k counted before any committed: the achieved k is k
    let achieved_k = outs.iter().filter(|o| matches!(o, Ok(Outcome::Applied(_)))).count();
    let n = count("SELECT count(*) FROM resource_reservations WHERE state = 'held'").await;
    assert!(n <= 511 + k as i64, "HELD {n} > 511 + k");
    assert_eq!(n, 511 + achieved_k as i64);
    // lifetime acquires beyond 512 succeed while fewer than 512 are held
    reset().await;
    let x = executor(vec![]);
    for i in 0..520 {
        let rid = rid_of(&applied(x.ex.run(&acq("cycle", None, None), &agent_binding(c(), &format!("cy-{i}"))).await));
        applied(x.ex.run(&act("release", &rid, json!({})), &agent_binding(c(), &format!("cr-{i}"))).await);
    }
    assert_eq!(count("SELECT count(*) FROM resource_reservations").await, 520);
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r8_control_counting_all_rows_refuses_forever() {
    reset().await;
    let o = org();
    admin_exec(&format!(
        "INSERT INTO resource_reservations (org_id, reservation_id, owner_id, resource, candidate, base, state, created_at, updated_at, expires_at, heartbeat_at, lease_s, stale_s)
         SELECT '{o}', gen_random_uuid(), '{}', 'old-' || g, '{C1}', '{B1}', 'released', now(), now(), now(), now(), 3600, 300 FROM generate_series(1, 511) g",
        e()
    ))
    .await;
    let x = executor(vec!["Q-R8.count_all_rows"]);
    applied(x.ex.run(&acq("one", None, None), &agent_binding(c(), "c512")).await);
    let o = x.ex.run(&acq("two", None, None), &agent_binding(c(), "c513")).await;
    assert!(x.ev.has("control_executed:Q-R8.count_all_rows"), "control did not record that it executed");
    assert_eq!(refusal(&o), "reservation store is limited to 512 records", "control executed but the 513th lifetime acquire succeeded");
    assert_eq!(count("SELECT count(*) FROM resource_reservations WHERE state = 'held'").await, 1, "refused although only one claim is held");
}

// ================================================================ Q-R9: ownership by principal (D3)

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r9_a_renamed_owner_keeps_its_claim_and_a_namesake_does_not() {
    for control in [false, true] {
        reset().await;
        let x = executor(if control { vec!["Q-R9.owner_by_name"] } else { vec![] });
        let rid = rid_of(&applied(x.ex.run(&acq("main", None, None), &agent_binding(c(), "o0")).await));
        admin_exec(&format!("UPDATE agents SET name = 'charlie-2' WHERE principal_id = '{c}'; UPDATE agent_names SET name = 'charlie-2' WHERE principal_id = '{c}';", c = c())).await;
        let o = x.ex.run(&act("renew", &rid, json!({})), &agent_binding(c(), "o1")).await;
        if control {
            assert!(x.ev.has("control_executed:Q-R9.owner_by_name"), "control did not record that it executed");
            assert_eq!(refusal(&o), "only the reservation owner may perform this action", "control executed but the renamed owner was accepted");
            continue;
        }
        assert_eq!(name(&o), "applied", "the renamed owner keeps ownership");
        // a namesake hired under the freed name
        let ns = Uuid::from_u128(0x0000_0000_0000_4000_8000_0000_0004_a0aa);
        applied_unit(x.ex.run(&Racer::Hire { id: ns, name: "charlie", parent: Some(b()), tier: "opus", grant_centi: 0 }, &system_binding("hire")).await);
        let o = x.ex.run(&act("release", &rid, json!({})), &agent_binding(ns, "o2")).await;
        assert_eq!(refusal(&o), "only the reservation owner may perform this action");
        let r = applied(x.ex.run(&act("land", &rid, json!({})), &agent_binding(c(), "o3")).await);
        assert_eq!(r["reservation"]["owner"], json!("charlie-2"), "rendered by the current name");
    }
}

// ================================================================ Q-R10: reads never wait and never make writers wait

async fn q_r10(control: bool) -> (bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-R10.reads_lock_rows"] } else { vec![] });
    item(&x, "item-r10").await;
    let rid = rid_of(&applied(x.ex.run(&acq("main", Some("item-r10"), None), &agent_binding(c(), "w0")).await));
    let renew = act("renew", &rid, json!({}));
    let br = agent_binding(c(), "w1");
    // a read held after its snapshot; a writer of a row it read commits meanwhile
    let writer_free = if control {
        let mut h = x.script.hold(Some("rd"), "reservation.list_locking.after_snapshot");
        let l = LockingList { args: json!({}) };
        let bl = agent_binding(c(), "rd");
        let (_, (o2, no_wait)) = tokio::join!(x.ex.run(&l, &bl), while_held(&mut h, 1500, x.ex.run(&renew, &br)));
        assert_eq!(name(&o2), "applied");
        no_wait
    } else {
        let mut h = x.script.hold(None, "reservation.list.after_snapshot");
        let r = ReservationRead { org: org(), me: c(), action: "list", args: json!({}) };
        let (_, (o2, no_wait)) = tokio::join!(x.ex.read(&r, org(), None), while_held(&mut h, 1500, x.ex.run(&renew, &br)));
        assert_eq!(name(&o2), "applied");
        no_wait
    };
    // a writer held after its row lock; reads run meanwhile
    let mut h = x.script.hold(Some("w2"), "reservation.renew.after_row_lock");
    let renew2 = act("renew", &rid, json!({}));
    let b2 = agent_binding(c(), "w2");
    let reads = async {
        let l = read(&x, c(), "list", json!({})).await.unwrap();
        let g = read(&x, c(), "landing", json!({"item": "item-r10"})).await.unwrap();
        let o = read(&x, c(), "overlap", json!({"item": "item-r10", "paths": ["x"]})).await.unwrap();
        (l, g, o)
    };
    let (_, (_, reader_free)) = tokio::join!(x.ex.run(&renew2, &b2), while_held(&mut h, 1500, reads));
    (writer_free && reader_free, x.ev.has("control_executed:Q-R10.reads_lock_rows"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r10_reads_and_writers_never_wait_on_each_other() {
    let (free, ran) = q_r10(false).await;
    assert!(!ran);
    assert!(free, "a read waited for a writer or a writer for a read");
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r10_control_reads_taking_row_locks_make_writers_wait() {
    let (free, ran) = q_r10(true).await;
    assert!(ran, "control did not record that it executed");
    assert!(!free, "control executed but the writer did not wait: it proves nothing");
}

// ================================================================ Q-R11: bounded output (D2)

async fn seed_rows(held: i64, terminal: i64) {
    let o = org();
    admin_exec(&format!(
        "INSERT INTO resource_reservations (org_id, reservation_id, owner_id, resource, candidate, base, state, created_at, updated_at, expires_at, heartbeat_at, lease_s, stale_s)
         SELECT '{o}', gen_random_uuid(), '{c}', 'old-' || g, '{C1}', '{B1}', 'released', timestamptz '2026-01-01' + g * interval '1 second', now(), now(), now(), 3600, 300 FROM generate_series(1, {terminal}) g;
         INSERT INTO resource_reservations (org_id, reservation_id, owner_id, resource, candidate, base, state, created_at, updated_at, expires_at, heartbeat_at, lease_s, stale_s)
         SELECT '{o}', gen_random_uuid(), '{c}', 'held-' || g, '{C1}', '{B1}', 'held', timestamptz '2026-02-01' + g * interval '1 second', now(), now() + interval '1 hour', now(), 3600, 300 FROM generate_series(1, {held}) g;",
        c = c()
    ))
    .await;
}

async fn q_r11(controls: Vec<&'static str>, held: i64, terminal: i64) -> (Value, Ex) {
    reset().await;
    seed_rows(held, terminal).await;
    let x = executor(controls);
    let v = read(&x, c(), "list", json!({})).await.unwrap();
    (v, x)
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r11_list_is_bounded_keeping_every_held_row() {
    // (a) under the bound: every row, no marker
    let (v, _) = q_r11(vec![], 3, 100).await;
    assert_eq!(v["count"], json!(103));
    assert!(v.get("truncated").is_none());
    // (b) 600 terminal + 5 HELD: 512 rows, every HELD, oldest terminal omitted, marker
    let (v, _) = q_r11(vec![], 5, 600).await;
    let rows = v["reservations"].as_array().unwrap();
    assert_eq!(rows.len(), 512);
    assert_eq!(v["truncated"], json!(true));
    assert_eq!(rows.iter().filter(|r| r["state"] == json!("held")).count(), 5);
    assert!(!rows.iter().any(|r| r["resource"] == json!("old-1")), "the oldest terminal row must go first");
    assert!(rows.iter().any(|r| r["resource"] == json!("old-600")), "the newest history is kept");
    // (c) more than 512 HELD (after an overshoot): the first 512 HELD in insertion order
    let (v, _) = q_r11(vec![], 515, 10).await;
    let rows = v["reservations"].as_array().unwrap();
    assert_eq!(rows.len(), 512);
    assert!(rows.iter().all(|r| r["state"] == json!("held")));
    assert!(rows.iter().any(|r| r["resource"] == json!("held-1")) && !rows.iter().any(|r| r["resource"] == json!("held-515")));
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_r11_controls_unbounded_and_wrong_end() {
    let (v, x) = q_r11(vec!["Q-R11.unbounded"], 5, 600).await;
    assert!(x.ev.has("control_executed:Q-R11.unbounded"), "control did not record that it executed");
    assert!(v["count"].as_u64().unwrap() > 512, "control executed but the output was bounded");
    let (v, x) = q_r11(vec!["Q-R11.truncate_wrong_end"], 5, 600).await;
    assert!(x.ev.has("control_executed:Q-R11.truncate_wrong_end"), "control did not record that it executed");
    let rows = v["reservations"].as_array().unwrap();
    assert!(rows.iter().filter(|r| r["state"] == json!("held")).count() < 5, "control executed but every HELD row survived");
}

// ================================================================ Q-C3 (anchored mutation part): acquire with item vs participant removal

async fn q_c3(control: bool, acquire_first: bool) -> (String, bool, bool) {
    reset().await;
    let x = executor(if control { vec!["Q-C3.no_item_anchor"] } else { vec![] });
    let it = item(&x, "item-c3").await;
    let a1 = acq("main", Some("item-c3"), None);
    let ba = agent_binding(c(), "acq");
    let rm = WorkUpdate { item: it, remove_participants: vec![c()], ..Default::default() };
    let br = user_binding("rm");
    let outcome = if acquire_first {
        // the acquire has anchored the item; the removal then tries to commit
        let mut h = x.script.hold(Some("acq"), "reservation.acquire.after_holder_lock");
        let (o1, (o2, _)) = tokio::join!(x.ex.run(&a1, &ba), while_held(&mut h, 1500, x.ex.run(&rm, &br)));
        assert!(matches!(o2, Ok(Outcome::Applied(_))));
        name(&o1)
    } else {
        assert!(matches!(x.ex.run(&rm, &br).await, Ok(Outcome::Applied(_))));
        name(&x.ex.run(&a1, &ba).await)
    };
    // the commit-order audit: did the acquire commit AFTER the removal committed?
    let acq_commit = x.ev.pos("commit:reservation.acquire:acq");
    let rm_commit = x.ev.pos("commit:work.update:rm");
    let after_revoke = matches!((acq_commit, rm_commit), (Some(a), Some(r)) if a > r);
    (outcome, after_revoke, x.ev.has("control_executed:Q-C3.no_item_anchor"))
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c3_anchored_acquire_never_commits_on_revoked_authority() {
    for acquire_first in [true, false] {
        let (o, after_revoke, ran) = q_c3(false, acquire_first).await;
        assert!(!ran);
        if acquire_first {
            assert_eq!(o, "applied");
            assert!(!after_revoke, "the removal did not wait for the anchored acquire");
        } else {
            assert_eq!(o, "refused", "an acquire after the removal must refuse");
        }
    }
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c3_control_without_the_item_anchor_commits_after_the_revocation() {
    let (o, after_revoke, ran) = q_c3(true, true).await;
    assert!(ran, "control did not record that it executed");
    assert_eq!(o, "applied");
    assert!(after_revoke, "control executed but the removal still waited: it proves nothing");
}

#[allow(dead_code)]
fn _claims_type_check() -> std::sync::Arc<ClaimRegistry> {
    ClaimRegistry::new()
}
