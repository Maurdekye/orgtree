//! THROWAWAY P03 WS6 spike, phase 2 (item p03-ws6-spike-rust-logical-replication-pgoutput).
//! Go/no-go checks for pg_walstream =0.9.0 against a WS1 dev cluster. Not for landing.
//!
//!   ws6-spike --env <devdb.env> snapshot  [--control]   check 2 (+ control WS6.snapshot_separate_select)
//!   ws6-spike --env <devdb.env> toast     [--control]   check 3 (+ control WS6.toast_null_fill)
//!   ws6-spike --env <devdb.env> feedback  [--control]   check 4 (+ control WS6.ack_on_receipt)
//!   ws6-spike --env <devdb.env> invalidate               check 5
//!
//! Every run prints one JSON line starting `RESULT ` with a verdict. A control run's verdict is
//! `control_failed_as_expected` only if it ALSO printed `CONTROL_EXECUTED` and its race evidence
//! shows the interleaving happened; otherwise `control_invalid`.

use anyhow::{anyhow, bail, Context, Result};
use pg_walstream::{
    format_lsn, parse_lsn, CancellationToken, EventType, LogicalReplicationStream,
    ReplicationSlotOptions, ReplicationStreamConfig, RetryConfig, StreamingMode,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_postgres::{Client, NoTls};

struct Env {
    admin: String,
    repl: String,
}

fn load_env(path: &str) -> Result<Env> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {path}"))?;
    let mut m = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.trim().split_once('=') {
            m.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    let admin = m.remove("P03_PG_ADMIN_URL").ok_or_else(|| anyhow!("no P03_PG_ADMIN_URL"))?;
    let repl = m.remove("P03_PG_REPL_URL").ok_or_else(|| anyhow!("no P03_PG_REPL_URL"))?;
    Ok(Env { admin, repl: format!("{repl}&replication=database") })
}

async fn connect(url: &str) -> Result<Client> {
    let (client, conn) = tokio_postgres::connect(url, NoTls).await.context("connect")?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    Ok(client)
}

fn cfg(slot: &str, publication: &str, export: bool) -> ReplicationStreamConfig {
    ReplicationStreamConfig::builder(slot, publication)
        .with_protocol_version(1)
        .with_streaming_mode(StreamingMode::Off)
        .with_feedback_interval(Duration::from_millis(200))
        .with_retry_config(RetryConfig {
            max_attempts: 2,
            initial_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(1),
            multiplier: 2.0,
            max_duration: Duration::from_secs(10),
            jitter: false,
        })
        .with_slot_options(ReplicationSlotOptions {
            snapshot: Some(if export { "export" } else { "nothing" }.to_string()),
            ..Default::default()
        })
}

fn suffix() -> String {
    format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis())
}

fn result(check: &str, control: bool, verdict: &str, detail: serde_like::Obj) {
    println!(
        "RESULT {{\"check\":\"{check}\",\"control\":{control},\"verdict\":\"{verdict}\",{}}}",
        detail.render()
    );
}

/// Tiny JSON-ish renderer so the spike needs no serde dependency of its own.
mod serde_like {
    pub struct Obj(pub Vec<(String, String)>);
    impl Obj {
        pub fn new() -> Self { Obj(Vec::new()) }
        pub fn n(mut self, k: &str, v: impl std::fmt::Display) -> Self { self.0.push((k.into(), v.to_string())); self }
        pub fn s(mut self, k: &str, v: impl std::fmt::Display) -> Self {
            self.0.push((k.into(), format!("\"{}\"", v.to_string().replace('\\', "\\\\").replace('"', "'"))));
            self
        }
        pub fn render(&self) -> String {
            self.0.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect::<Vec<_>>().join(",")
        }
    }
}
use serde_like::Obj;

/// Drop a slot by exact name once its walsender has gone. Returns an error (never silent) if the
/// slot is still active after the bound, or if the drop fails. First spike run leaked 4 slots
/// because the EventStream was still alive (shutdown() does not close the connection).
async fn drop_slot(admin: &Client, slot: &str) -> Result<()> {
    for _ in 0..100 {
        let row = admin
            .query_opt("SELECT active FROM pg_replication_slots WHERE slot_name = $1", &[&slot])
            .await?;
        match row {
            None => return Ok(()),
            Some(r) if !r.get::<_, bool>(0) => {
                admin.execute("SELECT pg_drop_replication_slot($1)", &[&slot]).await
                    .with_context(|| format!("drop slot {slot}"))?;
                let left = admin.query_opt("SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", &[&slot]).await?;
                if left.is_some() { bail!("slot {slot} still present after drop"); }
                return Ok(());
            }
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
    bail!("slot {slot} still ACTIVE after 20s: leaked (walsender not released)")
}

// ---------------------------------------------------------------- check 2: snapshot join
async fn check_snapshot(env: &Env, control: bool) -> Result<()> {
    let sfx = suffix();
    let (tbl, publ, slot) = (format!("rows_{sfx}"), format!("spub_{sfx}"), format!("sslot_{sfx}"));
    let admin = connect(&env.admin).await?;
    admin.batch_execute(&format!(
        "CREATE SCHEMA IF NOT EXISTS spike; GRANT USAGE ON SCHEMA spike TO orgtree_repl;
         CREATE TABLE spike.{tbl} (id bigint PRIMARY KEY, v text NOT NULL);
         GRANT SELECT ON spike.{tbl} TO orgtree_repl;
         CREATE PUBLICATION {publ} FOR TABLE spike.{tbl};")).await?;

    // Continuous writer: autocommit inserts 1,2,3,... until stopped.
    let stop = Arc::new(AtomicBool::new(false));
    let commits = Arc::new(AtomicU64::new(0));
    let writer = {
        let (stop, commits, url, tbl) = (stop.clone(), commits.clone(), env.admin.clone(), tbl.clone());
        tokio::spawn(async move {
            let w = connect(&url).await.expect("writer connect");
            let mut id: i64 = 1;
            while !stop.load(Ordering::SeqCst) {
                w.execute(&format!("INSERT INTO spike.{tbl} VALUES ($1, 'x')"), &[&id]).await.expect("insert");
                commits.fetch_add(1, Ordering::SeqCst);
                id += 1;
            }
            w
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut stream = LogicalReplicationStream::new(&env.repl, cfg(&slot, &publ, true)).await?;
    stream.ensure_replication_slot().await?;
    let c0 = commits.load(Ordering::SeqCst);
    let snap = stream.exported_snapshot_name().map(str::to_string).ok_or_else(|| anyhow!("no exported snapshot"))?;

    let reader = connect(&env.admin).await?;
    let copied: Vec<i64>;
    let mut between = 0u64;
    if !control {
        reader.batch_execute(&format!("BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT '{snap}';")).await?;
        copied = reader.query(&format!("SELECT id FROM spike.{tbl}"), &[]).await?.iter().map(|r| r.get(0)).collect();
        reader.batch_execute("COMMIT").await?;
    } else {
        // UNSAFE CONTROL WS6.snapshot_separate_select: a separately timed SELECT, not the exported snapshot.
        println!("CONTROL_EXECUTED {{\"id\":\"WS6.snapshot_separate_select\",\"check\":\"snapshot\"}}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        between = commits.load(Ordering::SeqCst) - c0;
        copied = reader.query(&format!("SELECT id FROM spike.{tbl}"), &[]).await?.iter().map(|r| r.get(0)).collect();
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    stop.store(true, Ordering::SeqCst);
    let w = writer.await?;
    w.execute(&format!("INSERT INTO spike.{tbl} VALUES (-1, 'sentinel')"), &[]).await?;

    stream.start(None).await?;
    let cancel = CancellationToken::new();
    let mut es = stream.into_stream(cancel.clone());
    let mut streamed: Vec<i64> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    'outer: loop {
        if Instant::now() > deadline { bail!("timeout waiting for sentinel"); }
        let ev = tokio::time::timeout(Duration::from_secs(30), es.next_event()).await.context("event timeout")??;
        match ev.event_type {
            EventType::Insert { table, data, .. } if &*table == tbl.as_str() => {
                let id: i64 = data.get("id").and_then(|v| v.as_str()).ok_or_else(|| anyhow!("no id"))?.parse()?;
                if id == -1 { break 'outer; }
                streamed.push(id);
            }
            EventType::Commit { end_lsn, .. } => es.update_applied_lsn(end_lsn),
            _ => {}
        }
    }
    let _ = es.shutdown().await;
    drop(es);

    let truth: BTreeSet<i64> = admin.query(&format!("SELECT id FROM spike.{tbl} WHERE id > 0"), &[]).await?
        .iter().map(|r| r.get(0)).collect();
    let cset: BTreeSet<i64> = copied.iter().copied().collect();
    let mut counts: BTreeMap<i64, u32> = BTreeMap::new();
    for id in copied.iter().chain(streamed.iter()) { *counts.entry(*id).or_default() += 1; }
    let dups = counts.values().filter(|&&c| c > 1).count();
    let missing = truth.iter().filter(|id| !counts.contains_key(id)).count();
    let extra = counts.keys().filter(|id| !truth.contains(id)).count();
    let exact = dups == 0 && missing == 0 && extra == 0;
    let verdict = match (control, exact) {
        (false, true) => "pass",
        (false, false) => "fail",
        (true, false) if between > 0 => "control_failed_as_expected",
        (true, true) if between > 0 => "control_did_not_fail",
        _ => "control_invalid",
    };
    result("snapshot", control, verdict, Obj::new()
        .n("rows_total", truth.len()).n("copied", cset.len()).n("streamed", streamed.len())
        .n("dups", dups).n("missing", missing).n("extra", extra)
        .n("writer_commits_at_slot", c0).n("writer_commits_between_slot_and_select", between)
        .s("snapshot_name", &snap));

    drop_slot(&admin, &slot).await?;
    admin.batch_execute(&format!("DROP PUBLICATION {publ}; DROP TABLE spike.{tbl};")).await?;
    Ok(())
}

// ---------------------------------------------------------------- check 3: unchanged TOAST
async fn check_toast(env: &Env, control: bool) -> Result<()> {
    let sfx = suffix();
    let (tbl, publ, slot) = (format!("toast_{sfx}"), format!("tpub_{sfx}"), format!("tslot_{sfx}"));
    let admin = connect(&env.admin).await?;
    admin.batch_execute(&format!(
        "CREATE SCHEMA IF NOT EXISTS spike; GRANT USAGE ON SCHEMA spike TO orgtree_repl;
         CREATE TABLE spike.{tbl} (id int PRIMARY KEY, small int NOT NULL, big text NOT NULL);
         ALTER TABLE spike.{tbl} ALTER COLUMN big SET STORAGE EXTERNAL;
         GRANT SELECT ON spike.{tbl} TO orgtree_repl;
         CREATE PUBLICATION {publ} FOR TABLE spike.{tbl};")).await?;
    let mut x: u64 = 0x2545F4914F6CDD1D;
    let big: String = (0..200_000).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; (b'a' + (x % 26) as u8) as char }).collect();
    admin.execute(&format!("INSERT INTO spike.{tbl} VALUES (1, 0, $1)"), &[&big]).await?;
    let toast_bytes: i64 = admin.query_one(
        &format!("SELECT pg_relation_size(reltoastrelid) FROM pg_class WHERE oid = 'spike.{tbl}'::regclass"), &[]).await?.get(0);

    let mut stream = LogicalReplicationStream::new(&env.repl, cfg(&slot, &publ, false)).await?;
    stream.ensure_replication_slot().await?;
    stream.start(None).await?;
    admin.execute(&format!("UPDATE spike.{tbl} SET small = 1 WHERE id = 1"), &[]).await?;
    admin.execute(&format!("UPDATE spike.{tbl} SET small = -1 WHERE id = 1"), &[]).await?; // sentinel

    let mut es = stream.into_stream(CancellationToken::new());
    // Model: the row as the consumer knows it (from its initial copy).
    let mut model: BTreeMap<String, Option<String>> = BTreeMap::new();
    model.insert("id".into(), Some("1".into()));
    model.insert("small".into(), Some("0".into()));
    model.insert("big".into(), Some(big.clone()));
    let columns = ["id", "small", "big"];
    let mut first_update_had_big: Option<bool> = None;
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(30), es.next_event()).await.context("event timeout")??;
        if let EventType::Update { table, new_data, .. } = ev.event_type {
            if &*table != tbl.as_str() { continue; }
            let small = new_data.get("small").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if small == "-1" { break; }
            first_update_had_big.get_or_insert(new_data.get("big").is_some());
            if control {
                // UNSAFE CONTROL WS6.toast_null_fill: absent column treated as NULL.
                println!("CONTROL_EXECUTED {{\"id\":\"WS6.toast_null_fill\",\"check\":\"toast\"}}");
                for c in columns {
                    let v = new_data.get(c).and_then(|v| v.as_str()).map(str::to_string);
                    model.insert(c.to_string(), v);
                }
            } else {
                for (k, v) in new_data.iter() {
                    model.insert(k.to_string(), v.as_str().map(str::to_string));
                }
            }
        }
    }
    let _ = es.shutdown().await;
    drop(es);
    let db_md5: String = admin.query_one(&format!("SELECT md5(big) FROM spike.{tbl} WHERE id = 1"), &[]).await?.get(0);
    let model_md5: Option<String> = match model.get("big").cloned().flatten() {
        Some(b) => Some(admin.query_one("SELECT md5($1::text)", &[&b]).await?.get(0)),
        None => None,
    };
    let merged_ok = model.get("small").cloned().flatten().as_deref() == Some("1") && model_md5.as_deref() == Some(db_md5.as_str());
    let absent = first_update_had_big == Some(false);
    let verdict = match (control, absent && merged_ok) {
        (false, true) => "pass",
        (false, false) => "fail",
        (true, false) if absent => "control_failed_as_expected",
        (true, true) => "control_did_not_fail",
        _ => "control_invalid",
    };
    result("toast", control, verdict, Obj::new()
        .n("toast_relation_bytes", toast_bytes)
        .s("big_present_in_first_update", format!("{first_update_had_big:?}"))
        .n("merged_matches_db", merged_ok)
        .s("model_big", if model.get("big").cloned().flatten().is_some() { "present" } else { "NULL" }));
    drop_slot(&admin, &slot).await?;
    admin.batch_execute(&format!("DROP PUBLICATION {publ}; DROP TABLE spike.{tbl};")).await?;
    Ok(())
}

// ---------------------------------------------------------------- check 4: feedback
async fn check_feedback(env: &Env, control: bool) -> Result<()> {
    let sfx = suffix();
    let (tbl, publ, slot) = (format!("fb_{sfx}"), format!("fpub_{sfx}"), format!("fslot_{sfx}"));
    let admin = connect(&env.admin).await?;
    admin.batch_execute(&format!(
        "CREATE SCHEMA IF NOT EXISTS spike; GRANT USAGE ON SCHEMA spike TO orgtree_repl;
         CREATE TABLE spike.{tbl} (id int PRIMARY KEY);
         GRANT SELECT ON spike.{tbl} TO orgtree_repl;
         CREATE PUBLICATION {publ} FOR TABLE spike.{tbl};")).await?;

    let mut stream = LogicalReplicationStream::new(&env.repl, cfg(&slot, &publ, false)).await?;
    stream.ensure_replication_slot().await?;
    stream.start(None).await?;
    admin.execute(&format!("INSERT INTO spike.{tbl} VALUES (1)"), &[]).await?; // group G
    admin.execute(&format!("INSERT INTO spike.{tbl} VALUES (2)"), &[]).await?; // group G+1

    let mut es = stream.into_stream(CancellationToken::new());
    let mut model: BTreeSet<i32> = BTreeSet::new();
    let mut pending: Vec<i32> = Vec::new();
    let mut commits: Vec<u64> = Vec::new();
    while commits.len() < 2 {
        let ev = tokio::time::timeout(Duration::from_secs(30), es.next_event()).await.context("event timeout")??;
        match ev.event_type {
            EventType::Insert { table, data, .. } if &*table == tbl.as_str() => {
                pending.push(data.get("id").and_then(|v| v.as_str()).unwrap_or("0").parse()?);
            }
            EventType::Commit { end_lsn, .. } => {
                commits.push(end_lsn.value());
                if control {
                    // UNSAFE CONTROL WS6.ack_on_receipt: acknowledge on receipt, before apply.
                    if commits.len() == 2 {
                        println!("CONTROL_EXECUTED {{\"id\":\"WS6.ack_on_receipt\",\"check\":\"feedback\"}}");
                    }
                    es.update_applied_lsn(end_lsn);
                }
                if commits.len() == 1 {
                    model.extend(pending.drain(..)); // apply G
                    if !control { es.update_applied_lsn(end_lsn); } // ack G only after apply
                } else {
                    pending.clear(); // "crash" before applying G+1: never applied, never acked (safe path)
                }
            }
            _ => {}
        }
    }
    es.inner_mut().send_feedback().await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(es); // crash: no stop(), no final feedback

    let mut confirmed = String::new();
    for _ in 0..50 {
        if let Some(row) = admin.query_opt(
            "SELECT active, confirmed_flush_lsn::text FROM pg_replication_slots WHERE slot_name = $1", &[&slot]).await? {
            if !row.get::<_, bool>(0) { confirmed = row.get(1); break; }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let confirmed_v = parse_lsn(&confirmed).map_err(|e| anyhow!("{e}"))?;

    // Restart from the slot and see whether G+1 is redelivered.
    let mut s2 = LogicalReplicationStream::new(&env.repl, cfg(&slot, &publ, false)).await?;
    s2.ensure_replication_slot().await?; // PreExisting
    s2.start(None).await?;
    admin.execute(&format!("INSERT INTO spike.{tbl} VALUES (3)"), &[]).await?; // liveness sentinel
    let mut es2 = s2.into_stream(CancellationToken::new());
    let mut redelivered = Vec::new();
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(30), es2.next_event()).await.context("event timeout")??;
        if let EventType::Insert { table, data, .. } = ev.event_type {
            if &*table != tbl.as_str() { continue; }
            let id: i32 = data.get("id").and_then(|v| v.as_str()).unwrap_or("0").parse()?;
            redelivered.push(id);
            model.insert(id);
            if id == 3 { break; }
        }
    }
    let _ = es2.shutdown().await;
    drop(es2);
    // Normal: the ack of G must have reached the server (confirmed == G end) and nothing past it.
    let ok = model == BTreeSet::from([1, 2, 3]) && confirmed_v == commits[0] && redelivered.first() == Some(&2);
    // Control race evidence: the premature ack really moved the slot past G.
    let raced = confirmed_v > commits[0];
    let verdict = match (control, ok) {
        (false, true) => "pass",
        (false, false) => "fail",
        (true, false) if raced => "control_failed_as_expected",
        (true, true) => "control_did_not_fail",
        _ => "control_invalid",
    };
    result("feedback", control, verdict, Obj::new()
        .s("g_end_lsn", format_lsn(commits[0])).s("g1_end_lsn", format_lsn(commits[1]))
        .s("slot_confirmed_flush", &confirmed)
        .s("redelivered", format!("{redelivered:?}")).s("model", format!("{model:?}")));
    drop_slot(&admin, &slot).await?;
    admin.batch_execute(&format!("DROP PUBLICATION {publ}; DROP TABLE spike.{tbl};")).await?;
    Ok(())
}

// ---------------------------------------------------------------- check 5: invalidation
async fn check_invalidate(env: &Env) -> Result<()> {
    let sfx = suffix();
    let (tbl, publ, slot) = (format!("wal_{sfx}"), format!("ipub_{sfx}"), format!("islot_{sfx}"));
    let admin = connect(&env.admin).await?;
    let before: String = admin.query_one("SHOW max_slot_wal_keep_size", &[]).await?.get(0);
    // ALTER SYSTEM cannot run inside a (implicit multi-statement) transaction block: one statement each.
    admin.simple_query("ALTER SYSTEM SET max_slot_wal_keep_size = '1MB'").await?;
    admin.simple_query("SELECT pg_reload_conf()").await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let during: String = admin.query_one("SHOW max_slot_wal_keep_size", &[]).await?.get(0);
    admin.batch_execute(&format!(
        "CREATE SCHEMA IF NOT EXISTS spike; GRANT USAGE ON SCHEMA spike TO orgtree_repl;
         CREATE TABLE spike.{tbl} (id int, pad text);
         GRANT SELECT ON spike.{tbl} TO orgtree_repl;
         CREATE PUBLICATION {publ} FOR TABLE spike.{tbl};")).await?;
    admin.execute("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", &[&slot]).await?;

    let mut wal_status = String::new();
    let mut reason = String::new();
    let mut rounds = 0;
    while rounds < 12 {
        rounds += 1;
        admin.simple_query(&format!(
            "INSERT INTO spike.{tbl} SELECT g, repeat(md5(g::text), 64) FROM generate_series(1, 2000) g")).await?;
        admin.simple_query("SELECT pg_switch_wal()").await?;
        admin.simple_query("CHECKPOINT").await?;
        let row = admin.query_one(
            "SELECT coalesce(wal_status,''), coalesce(invalidation_reason,'') FROM pg_replication_slots WHERE slot_name = $1",
            &[&slot]).await?;
        wal_status = row.get(0);
        reason = row.get(1);
        if wal_status == "lost" { break; }
    }

    let t0 = Instant::now();
    let start_err = async {
        let mut s = LogicalReplicationStream::new(&env.repl, cfg(&slot, &publ, false)).await?;
        s.ensure_replication_slot().await?;
        s.start(None).await?;
        let mut es = s.into_stream(CancellationToken::new());
        let r = tokio::time::timeout(Duration::from_secs(20), es.next_event()).await;
        let _ = es.shutdown().await;
        drop(es);
        match r {
            Ok(Ok(_)) => Ok::<String, anyhow::Error>("NO ERROR: stream delivered an event".into()),
            Ok(Err(e)) => Ok(format!("next_event error: {e}")),
            Err(_) => Ok("timeout".into()),
        }
    };
    let err_text = match tokio::time::timeout(Duration::from_secs(40), start_err).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => format!("start error: {e:#}"),
        Err(_) => "OUTER TIMEOUT (possible infinite retry)".into(),
    };
    let elapsed = t0.elapsed().as_secs_f64();

    drop_slot(&admin, &slot).await?;
    let recreate = admin.execute("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", &[&slot]).await.is_ok();
    drop_slot(&admin, &slot).await?;
    admin.simple_query("ALTER SYSTEM RESET max_slot_wal_keep_size").await?;
    admin.simple_query("SELECT pg_reload_conf()").await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after: String = admin.query_one("SHOW max_slot_wal_keep_size", &[]).await?.get(0);
    admin.batch_execute(&format!("DROP PUBLICATION {publ}; DROP TABLE spike.{tbl};")).await?;

    let surfaced = err_text.contains("55000") || err_text.to_lowercase().contains("invalidat") || err_text.contains("can no longer");
    let ok = wal_status == "lost" && surfaced && elapsed < 30.0 && recreate && after == before;
    result("invalidate", false, if ok { "pass" } else { "fail" }, Obj::new()
        .s("keep_size_before", before).s("keep_size_during", during).s("keep_size_after", after)
        .n("wal_rounds", rounds).s("wal_status", &wal_status).s("invalidation_reason", &reason)
        .s("start_error", &err_text).n("error_elapsed_s", format!("{elapsed:.2}")).n("recreate_ok", recreate));
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let env_path = args.iter().position(|a| a == "--env").and_then(|i| args.get(i + 1)).ok_or_else(|| anyhow!("--env <file>"))?;
    let env = load_env(env_path)?;
    let control = args.iter().any(|a| a == "--control");
    match args.iter().find(|a| ["snapshot", "toast", "feedback", "invalidate"].contains(&a.as_str())).map(String::as_str) {
        Some("snapshot") => check_snapshot(&env, control).await,
        Some("toast") => check_toast(&env, control).await,
        Some("feedback") => check_feedback(&env, control).await,
        Some("invalidate") => check_invalidate(&env).await,
        _ => bail!("usage: ws6-spike --env <file> snapshot|toast|feedback|invalidate [--control]"),
    }
}
