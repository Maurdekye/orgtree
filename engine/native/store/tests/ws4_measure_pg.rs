//! Q-C3 (WS4 part): share-lock fan-in on hot rows, measured — not a
//! correctness schedule (r7 §8.2, S3 §7.1). For each hot row WS4's families
//! share-lock, a stream of anchored readers runs while ONE writer of that row
//! tries to commit; we record the writer's wait and retries, the readers'
//! completed operations and latency, and the load it was measured at.
//!
//! Load: the headline arm is the OBSERVED fleet rate (coordinator charter:
//! 0.936 Hz aggregate, median zero concurrent turns — relayed, not measured
//! here): one paced stream at ~1 operation per second. The 4- and 16-stream
//! unpaced arms are STRESS CURVES and labelled so. A reading whose counters
//! did not advance is withheld (S3 §7.1 / r7 §8.1).
//!
//! Also reported (lead ruling 2 / S3 §4.13): the funding lock-set extension
//! rate under deep user reallocations, and the `cr<n>` id collision rate
//! under concurrent first filings by different agents.
//!
//! Hot rows WS4 share-locks: a manager's EDGE row (reservation acquires with
//! an item owned below it anchor the owner's chain), the CATALOG current-
//! version row (every funding writer), and the org's KILLSWITCH control row
//! (every agent-door command's anchor). The top-level scope row is share-
//! locked only by island movers (WS3), so it is not measured here.
//! Run ONLY through the P03 run lock (`-Test ws4_measure_pg`).
#![cfg(feature = "qualification")]

mod common_ws4;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common_ws4::*;
use orgtree_funding_core::pynum::PyNum;
use orgtree_store::funding::{CreditRequest, Reallocate};
use orgtree_store::reservation::{Acquire, RowAction};
use orgtree_store::status::StatusReport;
use orgtree_store::work::WorkCreate;
use orgtree_store::{Binding, Command, Outcome, Uuid};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug)]
enum Hot {
    /// bravo's edge row: acquires on items owned by charlie (below bravo)
    Edge,
    /// catalog_current: user reallocations of charlie
    Catalog,
    /// org killswitch control row: status reports
    Killswitch,
}

struct Arm {
    streams: usize,
    paced: bool,
    label: &'static str,
}

fn pct(v: &mut [u128], p: f64) -> u128 {
    if v.is_empty() {
        return 0;
    }
    v.sort();
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

/// One reader operation on the hot row (a fresh key each time).
async fn reader_op(x: &Ex, hot: Hot, who: Uuid, i: usize) -> bool {
    let key = format!("rd-{i}-{}", new_id());
    match hot {
        Hot::Edge => {
            let a = Acquire { args: json!({"resource": format!("r-{key}"), "candidate": "aaaaaaa", "base": "bbbbbbb", "item": "hot-item"}), reservation_id: new_id() };
            let o = x.ex.run(&a, &agent_binding(who, &key)).await;
            let ok = matches!(o, Ok(Outcome::Applied(_)));
            if let Ok(Outcome::Applied(v)) = &o {
                // release at once so the D1 cap never binds
                let rid = v["reservation"]["id"].as_str().unwrap_or_default().to_string();
                let _ = x.ex.run(&RowAction::new("release", json!({"reservation": rid})), &agent_binding(who, &format!("{key}-rel"))).await;
            }
            ok
        }
        Hot::Catalog => matches!(x.ex.run(&Reallocate::new(c(), PyNum::Int(if i % 2 == 0 { 1 } else { -1 })), &user_binding(&key)).await, Ok(Outcome::Applied(_))),
        Hot::Killswitch => matches!(x.ex.run(&StatusReport { status: "working".into(), summary: "m".into(), message_id: new_id() }, &agent_binding(who, &key)).await, Ok(Outcome::Applied(_))),
    }
}

/// The one writer of the hot row (schedule-grade), timed.
struct HotWriter(Hot);

static WRITER: orgtree_store::Family = orgtree_store::Family { name: "sg.hot", isolation: orgtree_store::Isolation::ReadCommitted, retry_unique: &[] };

impl Command for HotWriter {
    type Output = ();
    fn family(&self) -> &'static orgtree_store::Family {
        &WRITER
    }
    fn verb(&self) -> &'static str {
        "write"
    }
    async fn anchor<S: orgtree_store::Session>(&self, _tx: &mut orgtree_store::Tx<'_, S>, _b: &Binding) -> Result<(), orgtree_store::CmdError> {
        Ok(())
    }
    async fn may_disclose<S: orgtree_store::Session>(&self, _tx: &mut orgtree_store::Tx<'_, S>, _b: &Binding, _o: &()) -> Result<bool, orgtree_store::CmdError> {
        Ok(true)
    }
    async fn execute<S: orgtree_store::Session>(&self, tx: &mut orgtree_store::Tx<'_, S>, b: &Binding) -> Result<orgtree_store::Decided<()>, orgtree_store::CmdError> {
        use orgtree_store::Val;
        let org = b.op.org;
        match self.0 {
            // a writer of bravo's edge row (a move's update, keeping the parent)
            Hot::Edge => tx.exec("sg.hot.edge", "UPDATE topology_edges SET version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(b_())]).await?,
            // a catalog price change: only the version row (RN4)
            Hot::Catalog => tx.exec("sg.hot.catalog", "UPDATE catalog_current SET catalog_version = catalog_version WHERE org_id = $1", &[Val::Uuid(org)]).await?,
            // a killswitch latch (released at once: value unchanged)
            Hot::Killswitch => tx.exec("sg.hot.killswitch", "UPDATE org_controls SET version = version + 1 WHERE org_id = $1 AND family = 'killswitch'", &[Val::Uuid(org)]).await?,
        };
        Ok(orgtree_store::Decided::Applied(()))
    }
}

fn b_() -> Uuid {
    b()
}

async fn measure(hot: Hot, arm: &Arm) -> Value {
    reset().await;
    let x = executor_pool(vec![], arm.streams + 4);
    // the item the edge arm's acquires anchor (owned by charlie, below bravo)
    if matches!(hot, Hot::Edge) {
        let _ = x.ex.run(&WorkCreate { item: new_id(), name: "hot-item".into(), title: "t".into(), status: "open".into(), owner: Some(c()), participants: vec![a(), d(), e()] }, &user_binding("mk")).await;
    }
    let stop = AtomicBool::new(false);
    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let lat: Mutex<Vec<u128>> = Mutex::new(Vec::new());
    let readers = [a(), c(), d(), e()];
    let run_for = Duration::from_secs(if arm.paced { 20 } else { 10 });
    let streams = (0..arm.streams).map(|s| {
        let (x, stop, done, failed, lat) = (&x, &stop, &done, &failed, &lat);
        async move {
            let mut i = 0usize;
            while !stop.load(Ordering::SeqCst) {
                let t0 = Instant::now();
                let ok = reader_op(x, hot, readers[s % readers.len()], s * 100_000 + i).await;
                lat.lock().unwrap().push(t0.elapsed().as_micros());
                if ok {
                    done.fetch_add(1, Ordering::SeqCst);
                } else {
                    failed.fetch_add(1, Ordering::SeqCst);
                }
                i += 1;
                if arm.paced {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                }
            }
        }
    });
    let writer = async {
        // let the readers get going, then the writer tries to commit, three times
        tokio::time::sleep(run_for / 4).await;
        let mut waits = Vec::new();
        for k in 0..3 {
            let t0 = Instant::now();
            let o = x.ex.run(&HotWriter(hot), &system_binding(&format!("hw-{k}-{}", new_id()))).await;
            waits.push((t0.elapsed().as_micros(), matches!(o, Ok(Outcome::Applied(_)))));
            tokio::time::sleep(run_for / 5).await;
        }
        tokio::time::sleep(run_for / 4).await;
        stop.store(true, Ordering::SeqCst);
        waits
    };
    // the streams run CONCURRENTLY (an earlier version awaited them one after
    // another, so its "4/16-stream" arms were a single stream)
    let all = async {
        join_all(streams).await;
    };
    let (waits, ()) = tokio::join!(writer, all);
    let mut l = lat.lock().unwrap().clone();
    let completed = done.load(Ordering::SeqCst);
    let retries = x.ev.count_prefix("retry:");
    let writer_retries = x.ev.count_prefix("retry:sg.hot.write:");
    let mut w: Vec<u128> = waits.iter().map(|x| x.0).collect();
    let advanced = completed > 0 && waits.iter().all(|x| x.1);
    json!({
        "hot_row": format!("{hot:?}"),
        "arm": arm.label,
        "streams": arm.streams,
        "paced_1hz": arm.paced,
        "reported": advanced,
        "withheld_reason": if advanced { Value::Null } else { json!("counters did not advance or the writer never committed") },
        "reader_ops_completed": completed,
        "reader_ops_failed": failed.load(Ordering::SeqCst),
        "reader_latency_ms": {"p50": pct(&mut l, 0.5) as f64 / 1000.0, "p95": pct(&mut l, 0.95) as f64 / 1000.0, "max": l.iter().max().copied().unwrap_or(0) as f64 / 1000.0},
        "writer_wait_ms": {"each": w.iter().map(|x| *x as f64 / 1000.0).collect::<Vec<_>>(), "max": pct(&mut w, 1.0) as f64 / 1000.0},
        "writer_retries": writer_retries,
        "all_retries": retries,
    })
}

/// Deep user reallocations: how often the first lock set is too small.
async fn lockset_extension_rate() -> Value {
    reset().await;
    let x = executor_pool(vec![], 8);
    // bravo's free is 12: +1s stay local, +20s bubble to alpha (extension)
    let mut n = 0usize;
    for i in 0..40 {
        let d = if i % 4 == 0 { 20 } else { 1 };
        let _ = x.ex.run(&Reallocate::new(c(), PyNum::Int(d)), &user_binding(&format!("dl-{i}"))).await;
        n += 1;
    }
    let ext = x.ev.count_prefix("retry:funding.reallocate:").min(usize::MAX);
    let ext_named = x.ev.0.lock().unwrap().iter().filter(|e| e.contains("funding.lockset_extended")).count();
    json!({"operations": n, "lockset_extended_retries": ext_named, "all_funding_retries": ext, "load": "serial user reallocations of one deep node, 1 in 4 of +20 (synthetic worst case: the first +20 spends the payer's free, so every later one bubbles past it)"})
}

/// Concurrent first filings by different top-level agents: cr<n> collisions.
async fn legacy_id_collision_rate() -> Value {
    reset().await;
    let x = executor_pool(vec![], 8);
    let agents = [a(), e()];
    let mut collisions = 0usize;
    let mut filings = 0usize;
    for round in 0..10 {
        let reqs: Vec<(CreditRequest, Binding)> = agents.iter().map(|g| (CreditRequest::new(json!(200 + round), "r"), agent_binding(*g, &format!("f-{round}-{g}")))).collect();
        let (o1, o2) = tokio::join!(x.ex.run(&reqs[0].0, &reqs[0].1), x.ex.run(&reqs[1].0, &reqs[1].1));
        filings += [o1, o2].iter().filter(|o| matches!(o, Ok(Outcome::Applied(_)))).count();
        // answer both so the next round files new requests
        for g in agents {
            let id = text(&format!("SELECT legacy_id FROM request_batches WHERE asker_id = '{g}' AND state = 'pending'")).await;
            let _ = x.ex.run(&orgtree_store::funding::CreditDecide::new(id, "deny", None, None), &user_binding(&format!("dn-{round}-{g}"))).await;
        }
    }
    collisions += x.ev.0.lock().unwrap().iter().filter(|e| e.contains("request_batches_legacy_id")).count();
    json!({"filings": filings, "legacy_id_collision_retries": collisions, "load": "2 concurrent first filings per round, 10 rounds (stress: the observed filing rate is far lower)"})
}

#[tokio::test]
#[ignore = "needs the WS4 dev cluster; run through p03-run.ps1"]
async fn q_c3_hot_row_fan_in_measurement() {
    let arms = [
        Arm { streams: 1, paced: true, label: "observed (~1 Hz, one stream)" },
        Arm { streams: 4, paced: false, label: "stress curve (4 unpaced streams)" },
        Arm { streams: 16, paced: false, label: "stress curve (16 unpaced streams)" },
    ];
    let mut out = Vec::new();
    for hot in [Hot::Edge, Hot::Catalog, Hot::Killswitch] {
        for arm in &arms {
            out.push(measure(hot, arm).await);
        }
    }
    let report = json!({
        "schedule": "Q-C3 (WS4 part): share-lock fan-in on hot rows",
        "load_note": "observed arm = the coordinator's relayed fleet peak (0.936 Hz aggregate, median 0 concurrent turns); unpaced arms are stress curves",
        "hot_rows": out,
        "funding_lockset_extension": lockset_extension_rate().await,
        "credit_request_id_collisions": legacy_id_collision_rate().await,
    });
    let path = std::env::var("WS4_MEASURE_OUT").unwrap_or_else(|_| "../../../artifacts/logs/qc3-measure.json".into());
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    // the measurement ran: every OBSERVED-load arm reported (counters
    // advanced); a stress arm may be withheld, and that is itself a result
    for r in report["hot_rows"].as_array().unwrap() {
        if r["streams"] == json!(1) {
            assert_eq!(r["reported"], json!(true), "withheld at observed load: {r}");
        }
    }
}

#[allow(dead_code)]
fn _unused(_: Arc<()>) {}
