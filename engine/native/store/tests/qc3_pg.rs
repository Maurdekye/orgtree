//! S3 §7.1 Q-C3 extended (a): NOTICE FAN-IN ON THE MAILBOX HEAD ROW
//! (reviewer note M3). A MEASUREMENT, not a correctness schedule.
//!
//! One seat (B) receives system notices at a fixed rate while its own rehire
//! and notice fold race it, and a delete ends each run. Reported per rate:
//! notices sent and received, how many times each transition ran, their
//! retries and latency, and exactly-once delivery.
//!
//! LOAD: this is a STRESS CURVE (1, 2, 5, 10, 20 notices/s into one head),
//! per the lead's ruling (2026-09-25 11:19Z). The product's observed peak
//! rate is NOT MEASURED here: no sanctioned figure exists yet; that point is
//! WS8's single parameterized run (`P03_QC3_RATES`).
//!
//! WITHHOLDING (S3 Q-C3 extended; r7 §8.1): a rate's reading counts only if
//! its counters show the notices were received AND the racing transitions
//! ran; otherwise the row is written with `"withheld": true`.
//!
//! The rehire, fold and delete are SCHEDULE-GRADE stand-ins calling WS5's P8
//! helpers. Output: artifacts/logs/qc3-<unix>.jsonl (one JSON line per rate).
#![cfg(feature = "qualification")]

mod common_pg;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common_pg::stand_ins::Island;
use common_pg::*;
use orgtree_store::mail::receive::{self, Delivery, Received};
use orgtree_store::Outcome;

fn pct(v: &mut [u128], p: f64) -> u128 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    v[i]
}

#[derive(Default)]
struct Transition {
    runs: usize,
    exhausted: usize,
    latencies_ms: Vec<u128>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs a WS1 dev cluster; run through p03-run.ps1"]
async fn q_c3_ext_a_notice_fan_in_on_the_head_stress_curve() {
    let rates: Vec<f64> = std::env::var("P03_QC3_RATES").ok().map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect()).unwrap_or_else(|| vec![1.0, 2.0, 5.0, 10.0, 20.0]);
    let secs: u64 = std::env::var("P03_QC3_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(6);
    let out = format!(
        "E:\\Libraries\\Desktop\\orgtree\\.worktrees\\p03-ws5-mail\\artifacts\\logs\\qc3-{}.jsonl",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
    );
    let mut lines = Vec::new();
    for rate in rates {
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
                while !stop.load(Ordering::SeqCst) {
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
        // racing transitions: rehire (of an archived B) and the fold, in a loop
        let mut rehire = Transition::default();
        let mut fold = Transition::default();
        let t_end = Instant::now() + Duration::from_secs(secs);
        let mut k = 0;
        while Instant::now() < t_end {
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
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        stop.store(true, Ordering::SeqCst);
        producer.await.unwrap();
        // exactly-once, measured BEFORE the delete erases the box
        let ids = sent_ids.lock().unwrap().clone();
        let in_list = ids.iter().map(|i| format!("'{i}'")).collect::<Vec<_>>().join(",");
        let rows = if ids.is_empty() { 0 } else { count(&format!("SELECT count(*) FROM mailbox_messages WHERE original_message_id IN ({in_list})")).await };
        let dup_digest = count("SELECT count(*) FROM (SELECT x->>'id' AS id, count(*) c FROM mailbox_messages m, jsonb_array_elements(m.digest->'groups') g, jsonb_array_elements(g->'members') x WHERE m.kind = 'context.notice_digest' GROUP BY 1 HAVING count(*) > 1) d").await;
        let folded_not_in_digest = count("SELECT count(*) FROM mailbox_messages f WHERE f.state = 'folded' AND NOT EXISTS (SELECT 1 FROM mailbox_messages m, jsonb_array_elements(m.digest->'groups') g, jsonb_array_elements(g->'members') x WHERE m.kind = 'context.notice_digest' AND x->>'id' = f.original_message_id::text)").await;
        // the delete, racing one last notice
        let mut delete = Transition::default();
        let t0 = Instant::now();
        let o = ex.run(&Island::Delete(b()), &system_binding("del")).await.unwrap();
        delete.runs += matches!(o, Outcome::Applied(_)) as usize;
        delete.latencies_ms.push(t0.elapsed().as_millis());
        let retries = |prefix: &str| ev.snapshot().iter().filter(|e| e.starts_with(prefix)).count();
        let (r_rehire, r_fold, r_delete) = (retries("retry_op:island.rehire:"), retries("retry_op:island.fold:"), retries("retry_op:island.delete:"));
        let recv = received.load(Ordering::SeqCst);
        let withheld = recv == 0 || rehire.runs == 0 || fold.runs == 0 || delete.runs == 0;
        let exactly_once = rows == ids.len() as i64 && dup_digest == 0 && folded_not_in_digest == 0;
        let line = serde_json::json!({
            "schedule": "Q-C3 extended (a)", "label": "STRESS CURVE (observed-rate point not measured)",
            "rate_hz": rate, "seconds": secs,
            "notices_sent": ids.len(), "notices_received": recv,
            "exactly_once": exactly_once, "rows": rows, "duplicate_digest_members": dup_digest, "folded_outside_digest": folded_not_in_digest,
            "rehire": {"runs": rehire.runs, "retry_exhausted": rehire.exhausted, "retries": r_rehire, "p50_ms": pct(&mut rehire.latencies_ms.clone(), 0.5), "max_ms": rehire.latencies_ms.iter().max()},
            "fold": {"runs": fold.runs, "retry_exhausted": fold.exhausted, "retries": r_fold, "p50_ms": pct(&mut fold.latencies_ms.clone(), 0.5), "max_ms": fold.latencies_ms.iter().max()},
            "delete": {"runs": delete.runs, "retries": r_delete, "ms": delete.latencies_ms.first()},
            "withheld": withheld,
        });
        println!("QC3 {line}");
        lines.push(line.to_string());
        // the pass conditions, asserted only on readings that count
        if !withheld {
            assert!(exactly_once, "rate {rate}: every notice delivered exactly once: {line}");
            assert_eq!(rehire.exhausted + fold.exhausted, 0, "rate {rate}: transitions stay within C1's bounds: {line}");
        }
    }
    std::fs::write(&out, lines.join("\n") + "\n").unwrap();
    println!("QC3 report: {out}");
}
