//! Dev-cluster smoke test: a REAL PostgreSQL cluster under a disposable
//! prototype root. It is `#[ignore]`d so a plain `cargo test` never starts a
//! database; run it under the P03 machine-test-run gate with
//!
//!   ORGTREE_P03_PG_BIN=<...>/artifacts/p03-postgresql/18.6-4/bin
//!   cargo test --test smoke_cluster -- --ignored --test-threads=1 --nocapture
//!
//! It refuses to report success unless each stage provably did work: the
//! rows it wrote come back, the owned process family it waited on is
//! non-empty and contains the postmaster, and every negative check fired
//! with its expected code.

use orgtree_pg_custodian::cluster::{self, ClusterState, InitOptions, PgBin, ABORT_BEFORE_COMMIT_ENV};
use orgtree_pg_custodian::guard::{self, process_env};
use serde_json::json;
use std::path::PathBuf;

fn bin() -> PgBin {
    let dir = std::env::var_os("ORGTREE_P03_PG_BIN")
        .expect("ORGTREE_P03_PG_BIN must name the PostgreSQL bin folder; this test never skips silently");
    PgBin::locate(&PathBuf::from(dir)).expect("pinned PostgreSQL bin")
}

fn git(args: &[&str]) -> String {
    std::process::Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn fresh_root(tag: &str) -> PathBuf {
    // A space in the path on purpose: real Windows paths have them.
    std::env::temp_dir().join(format!(
        "orgtree p03 {tag} {}",
        orgtree_pg_custodian::win::random_hex(4).unwrap()
    ))
}

fn expect_code<T: std::fmt::Debug>(r: orgtree_pg_custodian::Result<T>, code: &str) -> String {
    match r {
        Ok(v) => panic!("expected refusal {code}, got Ok({v:?})"),
        Err(e) => {
            assert_eq!(e.code, code, "wrong refusal: {e}");
            e.code.to_string()
        }
    }
}

#[test]
#[ignore = "starts a real PostgreSQL cluster; run under the P03 machine-test-run gate"]
fn dev_cluster_lifecycle() {
    let env = process_env();
    let b = bin();
    let head = git(&["rev-parse", "HEAD"]);
    let dirty = git(&["status", "--porcelain", "--", "."]);
    let mut checks: Vec<serde_json::Value> = Vec::new();

    let root_path = fresh_root("smoke");
    let root = guard::init_root(&root_path, &env).unwrap();
    let inst = cluster::init(&root, &b, &InitOptions::default()).unwrap();
    assert!(inst.system_identifier.len() >= 15, "system_identifier {:?}", inst.system_identifier);
    match cluster::state(&root, &b).unwrap() {
        ClusterState::Stopped { .. } => {}
        other => panic!("after init expected Stopped, got {other:?}"),
    }
    expect_code(cluster::init(&root, &b, &InitOptions::default()), "cluster.exists");
    checks.push(json!({"check": "second init refused", "code": "cluster.exists"}));

    // Occupied port: hold a listener, ask for its port.
    let holder = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let busy = holder.local_addr().unwrap().port();
    expect_code(cluster::start(&root, &b, Some(busy)), "port.occupied");
    drop(holder);
    checks.push(json!({"check": "occupied port refused", "port": busy, "code": "port.occupied"}));

    let rt = cluster::start(&root, &b, None).unwrap();
    let running_pid = match cluster::state(&root, &b).unwrap() {
        ClusterState::Running { postmaster_pid, .. } => postmaster_pid,
        other => panic!("after start expected Running, got {other:?}"),
    };
    assert_eq!(running_pid, rt.postmaster_pid);
    expect_code(cluster::start(&root, &b, None), "cluster.already_running");
    checks.push(json!({"check": "double start refused", "code": "cluster.already_running"}));

    let (_, id) = cluster::identify(&root, &b).unwrap();
    assert!(id.identity_ok(), "identity mismatches: {:?}", id.mismatches);
    assert!(id.ready(), "readiness failures: {:?}", id.readiness_failures);
    assert_eq!(id.system_identifier, inst.system_identifier);
    assert_eq!(id.current_user, cluster::ADMIN_ROLE);

    // Real work through a real connection.
    cluster::psql(&b, &rt, "postgres", "create table smoke(x int primary key); insert into smoke select generate_series(1,1000)").unwrap();
    let rows = cluster::psql(&b, &rt, "postgres", "select count(*), sum(x) from smoke").unwrap();
    assert_eq!(rows, vec![vec!["1000".to_string(), "500500".to_string()]]);
    checks.push(json!({"check": "rows round-trip", "count": 1000, "sum": 500500}));

    // SCRAM is enforced: the right user with a wrong password is refused.
    let wrong = root_path.join("wrong-pgpass.conf");
    std::fs::write(&wrong, format!("127.0.0.1:*:*:{}:{}\n", cluster::ADMIN_ROLE, "0".repeat(64))).unwrap();
    let mut bad = rt.clone();
    bad.pgpass_file = wrong.to_string_lossy().to_string();
    let e = cluster::psql(&b, &bad, "postgres", "select 1").unwrap_err();
    assert_eq!(e.code, "psql.failed");
    assert!(e.message.contains("password authentication failed"), "{}", e.message);
    std::fs::remove_file(&wrong).unwrap();
    checks.push(json!({"check": "wrong password refused", "code": "psql.failed"}));

    // The runtime role logs in to the app database but holds no privilege.
    let mut as_runtime = rt.clone();
    as_runtime.admin_role = cluster::RUNTIME_ROLE.into();
    let who = cluster::psql(&b, &as_runtime, cluster::APP_DB, "select current_user, current_database()").unwrap();
    assert_eq!(who, vec![vec![cluster::RUNTIME_ROLE.to_string(), cluster::APP_DB.to_string()]]);
    let e = cluster::psql(&b, &as_runtime, cluster::APP_DB, "select count(*) from pg_authid").unwrap_err();
    assert!(e.message.contains("permission denied"), "{}", e.message);
    let e = cluster::psql(&b, &as_runtime, cluster::APP_DB, "create database nope").unwrap_err();
    assert!(e.message.contains("permission denied"), "{}", e.message);
    checks.push(json!({"check": "runtime role: logs in to orgtree, denied pg_authid and CREATE DATABASE"}));

    // The URLs name the three roles, the port and the app database.
    let urls = cluster::urls(&root, &rt).unwrap();
    assert_eq!(urls.len(), 3);
    for (var, role) in [("P03_PG_ADMIN_URL", cluster::ADMIN_ROLE), ("P03_PG_RUNTIME_URL", cluster::RUNTIME_ROLE), ("P03_PG_REPL_URL", cluster::REPL_ROLE)] {
        let u = &urls[var];
        assert!(u.starts_with(&format!("postgresql://{role}:")), "{u}");
        assert!(u.ends_with(&format!("@127.0.0.1:{}/{}?sslmode=disable", rt.port, cluster::APP_DB)), "{u}");
    }

    let stop = cluster::stop(&root, &b, false, false).unwrap();
    assert!(stop.was_running && stop.pid_file_removed);
    assert!(stop.family.iter().any(|m| m.pid == rt.postmaster_pid), "family lacks the postmaster: {:?}", stop.family);
    let postgres_count = stop.family.iter().filter(|m| m.exe_name.eq_ignore_ascii_case("postgres.exe")).count();
    assert!(postgres_count >= 2, "expected postmaster + auxiliaries, saw {:?}", stop.family);
    assert!(stop.family.iter().all(|m| m.exited && !m.terminated_by_custodian), "{:?}", stop.family);
    match cluster::state(&root, &b).unwrap() {
        ClusterState::Stopped { .. } => {}
        other => panic!("after stop expected Stopped, got {other:?}"),
    }
    assert!(!root.path().join("pg").join("cluster").join("runtime.json").exists());

    // Restart keeps the identity and the data; immediate stop also cleans up.
    let rt2 = cluster::start(&root, &b, None).unwrap();
    let rows = cluster::psql(&b, &rt2, "postgres", "select count(*) from smoke").unwrap();
    assert_eq!(rows, vec![vec!["1000".to_string()]]);
    let (_, id2) = cluster::identify(&root, &b).unwrap();
    assert_eq!(id2.system_identifier, inst.system_identifier);
    let stop2 = cluster::stop(&root, &b, true, false).unwrap();
    assert!(stop2.family.iter().all(|m| m.exited));
    checks.push(json!({"check": "restart keeps identity and data; immediate stop exits family"}));

    cluster::destroy(&root, &b).unwrap();
    assert!(!root_path.exists());

    println!(
        "P03-WS1-SMOKE-RESULT {}",
        serde_json::to_string_pretty(&json!({
            "schema": "orgtree.p03.ws1-smoke/v1",
            "commit": head,
            "crate_dirty": dirty,
            "engine": b.version,
            "pg_bin": b.dir,
            "system_identifier": inst.system_identifier,
            "first_stop": stop,
            "second_stop_mode": stop2.mode,
            "second_stop_family": stop2.family.len(),
            "checks": checks,
        }))
        .unwrap()
    );
}

#[test]
#[ignore = "runs initdb; run under the P03 machine-test-run gate"]
fn init_killed_before_commit_leaves_only_quarantine() {
    let env = process_env();
    let b = bin();
    let root_path = fresh_root("abort");
    let root = guard::init_root(&root_path, &env).unwrap();
    std::env::set_var(ABORT_BEFORE_COMMIT_ENV, "1");
    let r = cluster::init(&root, &b, &InitOptions::default());
    std::env::remove_var(ABORT_BEFORE_COMMIT_ENV);
    expect_code(r, "init.aborted_before_commit");
    match cluster::state(&root, &b).unwrap() {
        ClusterState::Absent { quarantined: 1 } => {}
        other => panic!("a half-created cluster must read as Absent with one quarantined folder, got {other:?}"),
    }
    expect_code(cluster::start(&root, &b, None), "cluster.absent");
    expect_code(cluster::stop(&root, &b, false, false).map(|r| if r.was_running { panic!() } else { r }).and_then(|_| cluster::identify(&root, &b)), "cluster.not_running");
    // A fresh init still works beside the debris.
    cluster::init(&root, &b, &InitOptions::default()).unwrap();
    assert!(matches!(cluster::state(&root, &b).unwrap(), ClusterState::Stopped { .. }));
    cluster::destroy(&root, &b).unwrap();
    println!("P03-WS1-QUARANTINE-RESULT ok: aborted init read as Absent{{quarantined:1}}; start refused cluster.absent; re-init succeeded");
}
