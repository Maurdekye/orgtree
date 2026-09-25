//! S3 §7.1 Q-C3 extended (a): NOTICE FAN-IN ON THE MAILBOX HEAD ROW
//! (reviewer note M3). A MEASUREMENT, not a correctness schedule.
//!
//! One seat (B) receives system notices at a fixed rate while its own rehire
//! and notice fold race it, and a delete ends each run (the same structure
//! for every row). Reported per row: notices sent and received, how often
//! each transition ran, their retries and latency, and exactly-once delivery.
//!
//! ROWS (lead rulings 2026-09-25 11:19Z and 11:34Z), reported separately and
//! never merged into one number:
//! * HEADLINE: an INFERRED burst point, 5 notices/s for 2 s (10 notices): a
//!   lower bound on the peak from ONE relayed sample (coordinator-opus's own
//!   mailbox, 09:55:03-05Z, 10 docket-assignment notices in about 2.0 s from
//!   retiring 3 reports, about 14 live reports; source: its turn-envelope
//!   timestamps). WS5 did not measure it. The SUSTAINED rate is NOT MEASURED.
//! * STRESS CURVE: 1, 2, 5, 10, 20 notices/s (`P03_QC3_RATES`,
//!   `P03_QC3_SECONDS`).
//!
//! WITHHOLDING (S3 Q-C3 extended; r7 §8.1): a row counts only if its counters
//! show the notices were received AND every racing transition ran; otherwise
//! it is written with `"withheld": true`.
//!
//! The rehire, fold and delete are SCHEDULE-GRADE stand-ins calling WS5's P8
//! helpers. Output: artifacts/logs/qc3-<nanos>.jsonl.
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common_pg::stand_ins::Island;
use common_pg::*;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::Outcome;

fn pct(v: &[u128], p: f64) -> u128 {
    if v.is_empty() {
        return 0;
    }
    let mut v = v.to_vec();
    v.sort_unstable();
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

#[derive(Default)]
struct Transition {
    runs: usize,
    exhausted: usize,
    latencies_ms: Vec<u128>,
}

impl Transition {
    fn json(&self, retries: usize) -> serde_json::Value {
        serde_json::json!({
            "runs": self.runs, "retry_exhausted": self.exhausted, "retries": retries,
            "p50_ms": pct(&self.latencies_ms, 0.5), "max_ms": self.latencies_ms.iter().max(),
        })
    }
}

async fn run_rate(rate: f64, secs: u64, max_notices: usize, label: &str) -> String {
    reset().await;
    let (ex, ev) = shared(Arc::new(Script::default()), vec![]);
    let stop = Arc::new(AtomicBool::new(false));
    let sent_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    let received = Arc::new(AtomicUsize::new(0));
    // producer: one system notice every 1/rate s, each received at once
    let producer = {
        let (ex, stop, sent_ids, received) = (ex.clone(), stop.clone(), sent_ids.clone(), received.clone());
        tokio::spawn(async move {
            let period = Duration::from_secs_f64(1.0 / rate);
            let mut next = Instant::now();
            let mut i = 0usize;
            while !stop.load(Ordering::SeqCst) && i < max_notices {
                let n = new_id();
                let kind = if i % 3 == 2 { "notice" } else { "context.lifecycle" };
                i += 1;
                if matches!(ex.run(&system_notice(dest_of(b()), n, kind), &system_binding(&n.to_string())).await.unwrap(), Outcome::Applied(_)) {
                    sent_ids.lock().unwrap().push(n);
                    if matches!(receive::deliver(&ex, org(), mb(b()), n).await.unwrap(), Delivery::Done(Received::Received { .. })) {
                        received.fetch_add(1, Ordering::SeqCst);
                    }
                }
                next += period;
                let now = Instant::now();
                if next > now {
                    tokio::time::sleep(next - now).await;
                }
            }
        })
    };
    // racing transitions: rehire (of an archived B), then the fold, in a loop
    let (mut rehire, mut fold) = (Transition::default(), Transition::default());
    let t_end = Instant::now() + Duration::from_secs(secs);
    let mut k = 0;
    while Instant::now() < t_end || (rehire.runs == 0 || fold.runs == 0) {
        admin_exec(&format!("UPDATE authority_epoch SET lifecycle = 'archived' WHERE principal_id = '{}'", b())).await;
        for (which, cmd) in [(0, Island::Rehire(b())), (1, Island::Fold(b()))] {
            let key = format!("t{which}-{k}");
            let t0 = Instant::now();
            let o = ex.run(&cmd, &system_binding(&key)).await.unwrap();
            let tr = if which == 0 { &mut rehire } else { &mut fold };
            tr.runs += matches!(o, Outcome::Applied(_)) as usize;
            tr.exhausted += matches!(o, Outcome::RetryExhausted { .. }) as usize;
            tr.latencies_ms.push(t0.elapsed().as_millis());
        }
        k += 1;
        if k > 1000 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // a count-limited burst runs to its count; a rate run stops with the transitions
    if max_notices == usize::MAX {
        stop.store(true, Ordering::SeqCst);
    }
    producer.await.unwrap();
    // exactly-once, measured BEFORE the delete erases the box
    let ids = sent_ids.lock().unwrap().clone();
    let in_list = ids.iter().map(|i| format!("'{i}'")).collect::<Vec<_>>().join(",");
    let rows = if ids.is_empty() { 0 } else { count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id IN ({in_list})")).await };
    let dup_digest = count("SELECT count(*) FROM (SELECT x->>'id' AS id FROM mailbox_messages m, jsonb_array_elements(m.digest->'groups') g, jsonb_array_elements(g->'members') x WHERE m.kind = 'context.notice_digest' GROUP BY 1 HAVING count(*) > 1) d").await;
    let folded_not_in_digest = count("SELECT count(*) FROM mailbox_messages f WHERE f.state = 'folded' AND NOT EXISTS (SELECT 1 FROM mailbox_messages m, jsonb_array_elements(m.digest->'groups') g, jsonb_array_elements(g->'members') x WHERE m.kind = 'context.notice_digest' AND x->>'id' = f.original_message_id::text)").await;
    // the delete ends the run
    let mut delete = Transition::default();
    let t0 = Instant::now();
    let o = ex.run(&Island::Delete(b()), &system_binding("del")).await.unwrap();
    delete.runs += matches!(o, Outcome::Applied(_)) as usize;
    delete.exhausted += matches!(o, Outcome::RetryExhausted { .. }) as usize;
    delete.latencies_ms.push(t0.elapsed().as_millis());
    let retries = |prefix: &str| ev.snapshot().iter().filter(|e| e.starts_with(prefix)).count();
    let recv = received.load(Ordering::SeqCst);
    let withheld = recv == 0 || rehire.runs == 0 || fold.runs == 0 || delete.runs == 0;
    let exactly_once = rows == ids.len() as i64 && dup_digest == 0 && folded_not_in_digest == 0 && recv == ids.len();
    let line = serde_json::json!({
        "schedule": "Q-C3 extended (a)", "label": label,
        "rate_hz": rate, "seconds": secs, "max_notices": if max_notices == usize::MAX { None } else { Some(max_notices) },
        "notices_sent": ids.len(), "notices_received": recv,
        "exactly_once": exactly_once, "rows": rows, "duplicate_digest_members": dup_digest, "folded_outside_digest": folded_not_in_digest,
        "rehire": rehire.json(retries("retry_op:island.rehire:")),
        "fold": fold.json(retries("retry_op:island.fold:")),
        "delete": delete.json(retries("retry_op:island.delete:")),
        "withheld": withheld,
    });
    println!("QC3 {line}");
    if !withheld {
        assert!(exactly_once, "rate {rate}: every notice delivered exactly once: {line}");
        assert_eq!(rehire.exhausted + fold.exhausted + delete.exhausted, 0, "rate {rate}: transitions stay within C1's bounds: {line}");
    }
    line.to_string()
}

fn report(lines: &[String]) {
    let out = format!(
        "E:\\Libraries\\Desktop\\orgtree\\.worktrees\\p03-ws5-mail\\artifacts\\logs\\qc3-{}.jsonl",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    std::fs::write(&out, lines.join("\n") + "\n").unwrap();
    println!("QC3 report: {out}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c3_ext_a_headline_inferred_burst_5_per_s_for_2_s() {
    let line = run_rate(
        5.0,
        2,
        10,
        "HEADLINE: INFERRED burst point, lower bound on the peak, ONE relayed sample (coordinator-opus mailbox 09:55:03-05Z, 10 notices in ~2 s from retiring 3 reports); not measured by WS5; sustained rate NOT MEASURED",
    )
    .await;
    report(&[line]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c3_ext_a_notice_fan_in_on_the_head_stress_curve() {
    let rates: Vec<f64> = std::env::var("P03_QC3_RATES").ok().map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect()).unwrap_or_else(|| vec![1.0, 2.0, 5.0, 10.0, 20.0]);
    let secs: u64 = std::env::var("P03_QC3_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(6);
    let mut lines = Vec::new();
    for rate in rates {
        lines.push(run_rate(rate, secs, usize::MAX, "STRESS CURVE (labelled; not the product's rate)").await);
    }
    report(&lines);
}
