//! WS1 G5 lifecycle drills at custodian level (v6 BUNDLED-DATABASE-SERVICE
//! :69-73). Each prints one `P03-WS1-DRILL {json}` line with its outcome.
//! Drills this machine cannot run (reboot, disk-full volume, uninstall/
//! reinstall, Windows-service mode, desktop window) are recorded as
//! environment_limited by `the_environment_limited_drills_are_recorded`;
//! nothing here reports them as passed.
//!
//!   ORGTREE_P03_PG_BIN=... cargo test --test drills -- --ignored --test-threads=1 --nocapture
//!   (under the P03 run lock)

use orgtree_pg_custodian::cluster::{self, ClusterState, InitOptions, Layout, PgBin, RuntimeRecord};
use orgtree_pg_custodian::guard::{self, process_env, PrototypeRoot};
use orgtree_pg_custodian::win;
use serde_json::json;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn bin() -> PgBin {
    let dir = std::env::var_os("ORGTREE_P03_PG_BIN").expect("ORGTREE_P03_PG_BIN must be set; drills never skip silently");
    PgBin::locate(&PathBuf::from(dir)).unwrap()
}

fn fresh(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("orgtree p03 drill-{tag} {}", win::random_hex(4).unwrap()))
}

struct StopOnPanic(PathBuf, PathBuf);
impl Drop for StopOnPanic {
    fn drop(&mut self) {
        if std::thread::panicking() && self.0.join("postmaster.pid").exists() {
            let _ = std::process::Command::new(&self.1).args(["stop", "-m", "immediate", "-w", "-D"]).arg(&self.0)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
        }
    }
}

fn new_cluster(tag: &str) -> (PathBuf, PrototypeRoot, PgBin, RuntimeRecord, StopOnPanic) {
    let b = bin();
    let p = fresh(tag);
    let r = guard::init_root(&p, &process_env()).unwrap();
    let guard_ = StopOnPanic(Layout::of(&r).data, b.exe("pg_ctl"));
    cluster::init(&r, &b, &InitOptions::default()).unwrap();
    let rt = cluster::start(&r, &b, None).unwrap();
    (p, r, b, rt, guard_)
}

fn one(b: &PgBin, rt: &RuntimeRecord, sql: &str) -> String {
    cluster::psql(b, rt, cluster::APP_DB, sql).unwrap()[0][0].clone()
}

fn report(drill: &str, outcome: &str, detail: serde_json::Value) {
    println!("P03-WS1-DRILL {}", json!({"drill": drill, "outcome": outcome, "detail": detail}));
}

/// Kill the postmaster and its whole family abruptly (no shutdown at all).
fn kill_postmaster(pid: u32) -> usize {
    let snap = win::snapshot().unwrap();
    let fam = win::family_pids(&snap, pid);
    let mut n = 0;
    for p in &fam {
        if let Some(h) = win::ProcessHandle::open(*p) {
            if h.terminate() {
                n += 1;
            }
            h.wait_exit(10_000);
        }
    }
    n
}

#[test]
#[ignore = "real cluster; P03 run lock"]
fn credential_conflict_is_refused() {
    let (p, r, b, rt, _g) = new_cluster("cred");
    let layout = Layout::of(&r);
    // The server's passwords change underneath the custodian's secrets.
    cluster::psql(&b, &rt, "postgres", &format!("alter role {} password 'something-else'", cluster::ADMIN_ROLE)).unwrap();
    let e = cluster::attach(&r, &b).unwrap_err();
    assert_eq!(e.code, "psql.failed", "{e}");
    assert!(e.message.contains("password authentication failed"), "{e}");
    // Nothing else accepted it either: identify refuses the same way.
    assert_eq!(cluster::identify(&r, &b).unwrap_err().code, "psql.failed");
    // The custodian can still stop it (stop needs no connection).
    cluster::stop(&r, &b, false, false).unwrap();
    assert!(!layout.data.join("postmaster.pid").exists());
    cluster::destroy(&r, &b).unwrap();
    let _ = p;
    report("credential conflict", "passed", json!({"attach": e.code, "stop_without_credentials": "ok"}));
}

#[test]
#[ignore = "real clusters; P03 run lock"]
fn data_identity_conflict_is_refused() {
    // Root B's data folder is swapped into root A (same layout, different cluster).
    let (pa, a, b, _rta, _ga) = new_cluster("ident-a");
    cluster::stop(&a, &b, false, false).unwrap();
    let (pb, bb, _, _rtb, _gb) = new_cluster("ident-b");
    cluster::stop(&bb, &b, false, false).unwrap();
    let la = Layout::of(&a);
    let lb = Layout::of(&bb);
    std::fs::rename(&la.data, la.cluster.join("data-original")).unwrap();
    // A folder copy (not a junction: the guard refuses those outright).
    let status = std::process::Command::new("robocopy").arg(&lb.data).arg(&la.data).args(["/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"]).status().unwrap();
    assert!(status.code().unwrap_or(16) < 8, "robocopy failed: {status}");
    let _g2 = StopOnPanic(la.data.clone(), b.exe("pg_ctl"));
    let e = cluster::start(&a, &b, None).unwrap_err();
    // B's server also has B's passwords, so SCRAM can refuse before the
    // identity comparison does; either way it is never accepted as A.
    assert!(e.code == "identity.mismatch" || e.code == "psql.failed", "{e}");
    assert!(cluster::attach(&a, &b).is_err(), "a swapped data folder must never attach");
    let refused_at = e.code;
    // The foreign server that start brought up is stopped again by pg_ctl (it is in OUR data folder).
    let _ = cluster::stop(&a, &b, true, false);
    std::fs::remove_dir_all(&la.data).unwrap();
    std::fs::rename(la.cluster.join("data-original"), &la.data).unwrap();
    cluster::start(&a, &b, None).unwrap();
    cluster::attach(&a, &b).unwrap();
    cluster::stop(&a, &b, false, false).unwrap();
    cluster::destroy(&a, &b).unwrap();
    cluster::destroy(&bb, &b).unwrap();
    let _ = (pa, pb);
    report("data-identity conflict", "passed", json!({"swapped_data_folder": refused_at, "original_restored_and_attached": true}));
}

#[test]
#[ignore = "real cluster; P03 run lock"]
fn abrupt_database_exit_recovers_committed_work_and_is_never_trusted_stale() {
    let (p, r, b, rt, _g) = new_cluster("crash");
    cluster::psql(&b, &rt, cluster::APP_DB, "create table ledger(id bigserial primary key, amount int); create table counter(total bigint); insert into counter values (0)").unwrap();
    // Commit ambiguity: kill everything while a writer is committing.
    let mut script = String::new();
    for _ in 0..50_000 {
        script.push_str("BEGIN; INSERT INTO ledger(amount) VALUES (1); UPDATE counter SET total = total + 1; COMMIT;\n");
    }
    let (b2, rt2) = (b.clone(), rt.clone());
    let writer = std::thread::spawn(move || cluster::psql_stdin(&b2, &rt2, cluster::APP_DB, &script, false));
    let deadline = Instant::now() + Duration::from_secs(60);
    while one(&b, &rt, "select count(*) from ledger").parse::<u64>().unwrap() < 500 {
        assert!(Instant::now() < deadline, "writer never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    let killed = kill_postmaster(rt.postmaster_pid);
    let writer_result = writer.join().unwrap();
    assert!(writer_result.is_err(), "the writer must have lost its server mid-stream");
    // The stale descriptor and lock file are never trusted.
    match cluster::state(&r, &b).unwrap() {
        ClusterState::StalePid { .. } => {}
        other => panic!("after a kill the state must be StalePid, got {other:?}"),
    }
    assert!(cluster::attach(&r, &b).is_err());
    // Restart runs crash recovery; committed work is intact and atomic.
    let rt3 = cluster::start(&r, &b, None).unwrap();
    let n: u64 = one(&b, &rt3, "select count(*) from ledger").parse().unwrap();
    let total: u64 = one(&b, &rt3, "select total from counter").parse().unwrap();
    assert_eq!(n, total, "a transaction was half-applied after the crash");
    assert!(n >= 500);
    cluster::attach(&r, &b).unwrap();
    // Normal (fast) and immediate shutdown after more writes; restart again.
    cluster::psql(&b, &rt3, cluster::APP_DB, "insert into ledger(amount) select 1 from generate_series(1,100); update counter set total = total + 100").unwrap();
    let s1 = cluster::stop(&r, &b, true, false).unwrap();
    let rt4 = cluster::start(&r, &b, None).unwrap();
    let n2: u64 = one(&b, &rt4, "select count(*) from ledger").parse().unwrap();
    assert_eq!(n2, n + 100);
    assert_eq!(one(&b, &rt4, "select total from counter").parse::<u64>().unwrap(), n2);
    let s2 = cluster::stop(&r, &b, false, false).unwrap();
    cluster::destroy(&r, &b).unwrap();
    let _ = p;
    report("abrupt database exit + commit ambiguity", "passed", json!({
        "killed_processes": killed, "rows_after_recovery": n, "invariant_after_recovery": true,
        "stale_state_refused_by_attach": true}));
    report("normal and forced shutdown", "passed", json!({
        "immediate_stop_family": s1.family.len(), "immediate_then_restart_rows": n2, "fast_stop_family": s2.family.len()}));
}

fn state_word(r: &PrototypeRoot, b: &PgBin) -> String {
    serde_json::to_value(cluster::state(r, b).unwrap()).unwrap()["state"].as_str().unwrap().to_string()
}

fn alive(pid: u32) -> bool {
    win::ProcessHandle::open(pid).map(|h| !h.wait_exit(0)).unwrap_or(false)
}

/// Review B1 (reproduced by the reviewer on a9993b4): root B's postmaster.pid
/// names a LIVE postgres.exe of the same bin that belongs to cluster A. B's
/// status must not read running, B's stop must signal nothing, and A must
/// still be up and attachable afterwards.
#[test]
#[ignore = "real clusters; P03 run lock"]
fn a_lock_naming_another_clusters_process_is_never_signalled() {
    let (pa, a, b, rta, _ga) = new_cluster("b1-a");
    let (pb, bb, _, _rtb, _gb) = new_cluster("b1-b");
    cluster::stop(&bb, &b, false, false).unwrap();
    let lb = Layout::of(&bb);
    let now = orgtree_pg_custodian::now_unix();
    let a_pm = rta.postmaster_pid;
    let snap = win::snapshot().unwrap();
    let a_child = win::family_pids(&snap, a_pm)
        .into_iter()
        .find(|p| *p != a_pm && snap.iter().any(|s| s.pid == *p && s.exe_name.eq_ignore_ascii_case("postgres.exe")))
        .expect("cluster A has a postgres.exe child");
    let lock = |pid: u32, started: u64| {
        std::fs::write(lb.data.join("postmaster.pid"), format!("{pid}\n{}\n{started}\n{}\n\n127.0.0.1\n  1  2\nready\n", lb.data.display(), rta.port)).unwrap();
    };
    let mut seen = Vec::new();
    for (case, pid, started) in [
        ("reviewer repro: A's postmaster, lock an hour older than A", a_pm, now - 3600),
        ("A's postmaster, lock claims a later start (only -D can tell)", a_pm, now + 60),
        ("one of A's child processes", a_child, now + 60),
    ] {
        lock(pid, started);
        let st = state_word(&bb, &b);
        assert_ne!(st, "running", "{case}: B must not read as running on pid {pid}");
        let e = cluster::stop(&bb, &b, false, true).unwrap_err();
        assert!(e.code.starts_with("stop."), "{case}: {e}");
        assert!(alive(a_pm) && alive(pid), "{case}: B's stop touched cluster A (pid {pid})");
        assert_eq!(state_word(&a, &b), "running", "{case}");
        cluster::attach(&a, &b).unwrap();
        seen.push(json!({"case": case, "b_state": st, "b_stop": e.code}));
    }
    // B's start clears a lock proven foreign and brings up B, and A is untouched.
    cluster::start(&bb, &b, None).unwrap();
    cluster::stop(&bb, &b, false, false).unwrap();
    assert!(alive(a_pm));
    cluster::attach(&a, &b).unwrap();
    cluster::stop(&a, &b, false, false).unwrap();
    cluster::destroy(&a, &b).unwrap();
    cluster::destroy(&bb, &b).unwrap();
    let _ = (pa, pb);
    report("foreign postmaster in a stale lock (review B1)", "passed", json!({"cases": seen, "a_survived": true, "b_started_after": true}));
}

#[test]
#[ignore = "real cluster; P03 run lock"]
fn interrupted_migration_resumes() {
    let (p, r, b, _rt, _g) = new_cluster("upgrade");
    let dir = p.join("schema");
    std::fs::create_dir_all(&dir).unwrap();
    let files = [
        ("0001_a.sql", "CREATE TABLE a (x int);\n".to_string()),
        ("0002_slow.sql", "SELECT pg_sleep(30);\nCREATE TABLE slow (x int);\n".to_string()),
    ];
    let mut m = String::new();
    for (f, body) in &files {
        std::fs::write(dir.join(f), body).unwrap();
        m.push_str(&format!("{}  {f}\n", orgtree_pg_custodian::migrate::checksum(body)));
    }
    std::fs::write(dir.join("SHA256SUMS"), m).unwrap();
    // Run the REAL CLI and kill it (and its psql) during 0002.
    let exe = env!("CARGO_BIN_EXE_pg-custodian");
    let mut child = std::process::Command::new(exe)
        .args(["migrate", "--root"]).arg(&p).arg("--schema-dir").arg(&dir).arg("--pg-bin").arg(&b.dir)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().unwrap();
    let rt = cluster::identify(&r, &b).unwrap().0;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let busy = cluster::psql(&b, &rt, "postgres", "select count(*) from pg_stat_activity where query like 'SELECT pg_sleep(30)%'").unwrap();
        if busy[0][0] != "0" {
            break;
        }
        assert!(Instant::now() < deadline, "0002 never started");
        std::thread::sleep(Duration::from_millis(50));
    }
    let snap = win::snapshot().unwrap();
    for pid in win::family_pids(&snap, child.id()) {
        if let Some(h) = win::ProcessHandle::open(pid) {
            h.terminate();
        }
    }
    let _ = child.wait();
    // The interrupted migration's backend may linger until its client is noticed gone.
    cluster::psql(&b, &rt, "postgres", "select pg_terminate_backend(pid) from pg_stat_activity where query like 'SELECT pg_sleep(30)%'").unwrap();
    let applied = orgtree_pg_custodian::migrate::read_applied(&b, &rt).unwrap();
    assert_eq!(applied.iter().map(|a| a.version).collect::<Vec<_>>(), vec![1], "only 0001 may be recorded");
    let slow = cluster::psql(&b, &rt, cluster::APP_DB, "select to_regclass('public.slow') is not null").unwrap();
    assert_eq!(slow[0][0], "f", "the interrupted migration left something behind");
    // Resume: make 0002 fast (a new checksum is allowed: it was never applied).
    let fast = "CREATE TABLE slow (x int);\n";
    std::fs::write(dir.join("0002_slow.sql"), fast).unwrap();
    let m2 = format!("{}  0001_a.sql\n{}  0002_slow.sql\n", orgtree_pg_custodian::migrate::checksum(&files[0].1), orgtree_pg_custodian::migrate::checksum(fast));
    std::fs::write(dir.join("SHA256SUMS"), m2).unwrap();
    let rep = orgtree_pg_custodian::migrate::migrate(&b, &rt, &dir, 1).unwrap();
    assert_eq!(rep.applied_now, vec![2]);
    cluster::stop(&r, &b, false, false).unwrap();
    cluster::destroy(&r, &b).unwrap();
    report("upgrade interruption (schema migration killed mid-way)", "passed", json!({"recorded_after_kill": [1], "left_behind": false, "resumed": rep.applied_now}));
}

#[test]
fn the_environment_limited_drills_are_recorded() {
    // Coordinator decision 1, Q5/Q6 (2026-09-25): no VHDX, no admin changes,
    // no reboot, no reinstall on this machine; these move to a P10 VM.
    for (drill, why) in [
        ("disk-full", "needs a small dedicated volume (VHDX, admin); Q5"),
        ("startup after reboot", "this machine is not rebooted for tests; Q6"),
        ("uninstall/reinstall data preservation", "no installer runs in P03; Q6"),
        ("Windows-service (background host) mode", "service spawn/identity unbuilt (engine/winservice), admin; Q6"),
        ("second desktop window attach", "engine.ts untouched in P03 and the app is not restarted (lead ruling 09:38Z)"),
    ] {
        report(drill, "environment_limited", json!({"reason": why, "moves_to": "P10 VM"}));
    }
}
