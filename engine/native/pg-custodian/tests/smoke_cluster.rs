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

/// On panic, stop whatever cluster the test left running, with pg_ctl
/// directly (a mutant may have broken the custodian's own stop), so a failed
/// run never leaves an orphan postmaster holding the caller's pipes.
struct StopOnPanic {
    data: PathBuf,
    pg_ctl: PathBuf,
}

impl StopOnPanic {
    fn new(root: &std::path::Path, b: &PgBin) -> Self {
        Self { data: root.join("pg").join("cluster").join("data"), pg_ctl: b.exe("pg_ctl") }
    }
}

impl Drop for StopOnPanic {
    fn drop(&mut self) {
        if std::thread::panicking() && self.data.join("postmaster.pid").exists() {
            let _ = std::process::Command::new(&self.pg_ctl)
                .args(["stop", "-m", "immediate", "-w", "-D"])
                .arg(&self.data)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
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
    let _cleanup = StopOnPanic::new(root.path(), &b);
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

    // Secrets and the attach descriptor are owner-only; attach succeeds.
    let layout = cluster::Layout::of(&root);
    orgtree_pg_custodian::acl::require_owner_only(&layout.secrets).unwrap();
    orgtree_pg_custodian::acl::require_owner_only(&layout.secrets.join("pgpass.conf")).unwrap();
    orgtree_pg_custodian::acl::require_owner_only(&layout.attach).unwrap();
    assert!(!layout.runtime.exists(), "the legacy runtime.json is not written any more");
    let (_, attached) = cluster::attach(&root, &b).unwrap();
    assert!(attached.ready(), "{:?}", attached.readiness_failures);
    // Tamper 1: someone widens the descriptor's ACL -> attach refuses.
    let desc_text = std::fs::read_to_string(&layout.attach).unwrap();
    let widen = std::process::Command::new("icacls").arg(&layout.attach).args(["/grant", "*S-1-1-0:R"]).output().unwrap();
    assert!(widen.status.success(), "{}", String::from_utf8_lossy(&widen.stderr));
    assert_eq!(cluster::attach(&root, &b).unwrap_err().code, "acl.not_owner_only");
    orgtree_pg_custodian::acl::replace_owner_only(&layout.attach, desc_text.as_bytes()).unwrap();
    cluster::attach(&root, &b).unwrap();
    // Tamper 2: the descriptor names a different postmaster creation time
    // (what a reused pid looks like) -> refused before any connection.
    let mut forged: serde_json::Value = serde_json::from_str(&desc_text).unwrap();
    forged["postmaster_created"] = json!(forged["postmaster_created"].as_u64().unwrap() - 1);
    orgtree_pg_custodian::acl::replace_owner_only(&layout.attach, forged.to_string().as_bytes()).unwrap();
    assert_eq!(cluster::attach(&root, &b).unwrap_err().code, "identify.postmaster_replaced");
    orgtree_pg_custodian::acl::replace_owner_only(&layout.attach, desc_text.as_bytes()).unwrap();
    checks.push(json!({"check": "owner-only secrets + descriptor; attach ok; widened ACL and forged creation time refused"}));

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
    // Independent of the report: no family PID is a live process running our
    // postgres.exe now.
    let ours = b.exe("postgres");
    for m in &stop.family {
        if let Some(h) = orgtree_pg_custodian::win::ProcessHandle::open(m.pid) {
            let alive_ours = !h.wait_exit(0)
                && h.image_path().map(|p| orgtree_pg_custodian::win::same_file(&p, &ours)).unwrap_or(false);
            assert!(!alive_ours, "pid {} still runs our postgres.exe after stop", m.pid);
        }
    }
    match cluster::state(&root, &b).unwrap() {
        ClusterState::Stopped { .. } => {}
        other => panic!("after stop expected Stopped, got {other:?}"),
    }
    assert!(!root.path().join("pg").join("cluster").join("runtime.json").exists());

    // Restart keeps the identity and the data; immediate stop also cleans up.
    // This restart also runs with the qualification-logging switch ON.
    assert!(!cluster::qual_logging_configured(&root));
    assert!(cluster::set_qual_logging(&root, &b, true).unwrap());
    let rt2 = cluster::start(&root, &b, None).unwrap();
    expect_code(cluster::set_qual_logging(&root, &b, false), "qual_logging.running");
    let rows = cluster::psql(&b, &rt2, "postgres", "select count(*) from smoke").unwrap();
    assert_eq!(rows, vec![vec!["1000".to_string()]]);
    let (_, id2) = cluster::identify(&root, &b).unwrap();
    assert_eq!(id2.system_identifier, inst.system_identifier);
    assert!(id2.qual_logging_configured && id2.qual_logging_effective, "{id2:?}");
    assert!(id2.ready(), "readiness with qualification logging: {:?}", id2.readiness_failures);
    // One statement text that must be logged, one bind value that must not.
    let tag = orgtree_pg_custodian::win::random_hex(6).unwrap();
    let visible = format!("VISIBLE_MARKER_{tag}");
    let secret = format!("BIND_SECRET_{tag}");
    let script = root_path.join("bind.sql");
    std::fs::write(&script, format!("select '{visible}' as v;\nselect $1::text as s \\bind {secret} \\g\n")).unwrap();
    let out = cluster::child(&b.exe("psql"))
        .args(["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-d"])
        .arg(rt2.conninfo("postgres"))
        .arg("-f")
        .arg(&script)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains(&secret), "the bound query must really have run");
    let stop2 = cluster::stop(&root, &b, true, false).unwrap();
    assert!(stop2.family.iter().all(|m| m.exited));
    let mut logged = String::new();
    let mut files = 0;
    for e in std::fs::read_dir(root.path().join(cluster::QUAL_LOG_DIR)).unwrap() {
        let p = e.unwrap().path();
        files += 1;
        logged.push_str(&String::from_utf8_lossy(&std::fs::read(&p).unwrap()));
    }
    assert!(files > 0 && logged.contains(&visible), "qualification log did not record the marker statement ({files} files)");
    assert!(logged.contains("\"message\":\"statement: "), "not jsonlog statement records");
    assert!(!logged.contains(&secret), "a bind value reached the qualification log");
    assert!(cluster::set_qual_logging(&root, &b, false).unwrap());
    assert!(!cluster::qual_logging_configured(&root));
    checks.push(json!({
        "check": "restart keeps identity and data; qualification logging records statements but no bind values; immediate stop exits family",
        "qual_log_files": files,
        "qual_log_bytes": logged.len(),
    }));

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

/// Run the real CLI with stdout/stderr CAPTURED through pipes, as any
/// harness would. Before the handle fix, `start` hung its caller: the
/// postmaster inherited the pipe and EOF never came. A 90 s ceiling turns a
/// hang into a failure instead of a stuck run.
fn cli(home: &std::path::Path, b: &PgBin, args: &[&str]) -> (serde_json::Value, String) {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_pg-custodian"));
    cmd.args(args)
        .arg("--pg-bin")
        .arg(&b.dir)
        .env("ORGTREE_P03_HOME", home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let (tx, rx) = std::sync::mpsc::channel();
    let child = cmd.spawn().unwrap();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = rx
        .recv_timeout(std::time::Duration::from_secs(90))
        .unwrap_or_else(|_| panic!("pg-custodian {args:?} did not return EOF within 90 s (inherited pipe?)"))
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let v = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    (v, text)
}

#[test]
#[ignore = "starts a real PostgreSQL cluster through the CLI; run under the P03 machine-test-run gate"]
fn dev_cli_end_to_end_with_captured_output() {
    let b = bin();
    // A throwaway "repo home" so this never touches the shared artifacts/p03-db.
    let home = fresh_root("home");
    std::fs::create_dir_all(&home).unwrap();
    let agent = format!("smoke-{}", orgtree_pg_custodian::win::random_hex(3).unwrap());
    let root = home.join("artifacts").join("p03-db").join(&agent);
    let _cleanup = StopOnPanic { data: root.join("pg").join("cluster").join("data"), pg_ctl: b.exe("pg_ctl") };

    let (up, raw) = cli(&home, &b, &["dev", "up", "--agent", &agent]);
    assert_eq!(up["ok"], json!(true), "{raw}");
    let port = orgtree_pg_custodian::dev::port_for(&agent);
    assert_eq!(up["dev"]["runtime"]["port"], json!(port), "{raw}");
    assert_eq!(up["dev"]["ready"], json!(true), "{raw}");
    assert_eq!(up["dev"]["qual_logging_configured"], json!(false), "{raw}");
    assert!(raw.contains(":***@"), "dev up must print redacted URLs: {raw}");

    // Second `up` attaches to the running cluster by identity, not by port.
    let (again, raw) = cli(&home, &b, &["dev", "up", "--agent", &agent]);
    assert_eq!(again["dev"]["started"], json!(false), "{raw}");
    // A second process attaches strictly.
    let (att, raw) = cli(&home, &b, &["dev", "attach", "--agent", &agent]);
    assert_eq!(att["attached"], json!(true), "{raw}");

    // `dev env` is the only place a password is printed; use its URLs.
    let (_, envtext) = cli(&home, &b, &["dev", "env", "--agent", &agent, "--shell", "plain"]);
    let urls: std::collections::BTreeMap<String, String> = envtext
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    assert_eq!(urls.len(), 3, "{envtext}");
    for (var, role) in [("P03_PG_ADMIN_URL", "orgtree_admin"), ("P03_PG_RUNTIME_URL", "orgtree_runtime")] {
        let out = cluster::child(&b.exe("psql"))
            .args(["-X", "-A", "-t", "-w", "-c", "select current_user || '/' || current_database()"])
            .arg(&urls[var])
            .output()
            .unwrap();
        assert!(out.status.success(), "{var}: {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), format!("{role}/orgtree"));
    }
    // The replication URL opens a replication connection.
    let out = cluster::child(&b.exe("psql"))
        .args(["-X", "-A", "-t", "-w", "-c", "IDENTIFY_SYSTEM"])
        .arg(format!("{}&replication=database", urls["P03_PG_REPL_URL"]))
        .output()
        .unwrap();
    assert!(out.status.success(), "IDENTIFY_SYSTEM: {}", String::from_utf8_lossy(&out.stderr));

    let (all, raw) = cli(&home, &b, &["dev", "status", "--all"]);
    assert_eq!(all["all"]["running"], json!(1), "{raw}");
    assert_eq!(all["all"]["clusters"][0]["agent"], json!(agent), "{raw}");

    // Switching qualification logging while running is refused.
    let (q, raw) = cli(&home, &b, &["dev", "up", "--agent", &agent, "--qual-logging", "on"]);
    assert_eq!(q["code"], json!("qual_logging.running"), "{raw}");

    let (down, raw) = cli(&home, &b, &["dev", "down", "--agent", &agent]);
    assert_eq!(down["ok"], json!(true), "{raw}");
    assert!(!root.join("pg").join("cluster").join("data").join("postmaster.pid").exists());
    let (st, raw) = cli(&home, &b, &["dev", "status", "--agent", &agent]);
    assert_eq!(st["cluster"]["state"], json!("stopped"), "{raw}");
    let (d, raw) = cli(&home, &b, &["dev", "destroy", "--agent", &agent]);
    assert_eq!(d["ok"], json!(true), "{raw}");
    assert!(!root.exists());
    std::fs::remove_dir_all(&home).unwrap();
    println!("P03-WS1-CLI-RESULT ok: dev up/up/env/status --all/down/status/destroy via captured pipes; port {port}; 3 URLs connect");
}

fn schema_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ORGTREE_P03_SCHEMA_DIR").expect(
        "ORGTREE_P03_SCHEMA_DIR must name a checkout of engine/native/store-schema/migrations; this test never skips silently",
    ))
}

fn write_dir(dir: &std::path::Path, files: &[(&str, &str)]) {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).unwrap();
    let mut m = String::new();
    for (name, body) in files {
        std::fs::write(dir.join(name), body).unwrap();
        m.push_str(&format!("{}  {name}\n", orgtree_pg_custodian::migrate::checksum(body)));
    }
    std::fs::write(dir.join("SHA256SUMS"), m).unwrap();
}

#[test]
#[ignore = "starts real PostgreSQL clusters; run under the P03 machine-test-run gate with ORGTREE_P03_SCHEMA_DIR"]
fn migrations_apply_resume_and_refuse() {
    use orgtree_pg_custodian::migrate;
    let env = process_env();
    let b = bin();
    let ws2 = schema_dir();

    // --- Part 1: resume after a failed migration (synthetic schema). ---
    let root_path = fresh_root("migrate-resume");
    let root = guard::init_root(&root_path, &env).unwrap();
    let _cleanup = StopOnPanic::new(root.path(), &b);
    cluster::init(&root, &b, &InitOptions::default()).unwrap();
    let rt = cluster::start(&root, &b, None).unwrap();
    let dir = root_path.join("schema");
    write_dir(&dir, &[("0001_a.sql", "CREATE TABLE a (x int);\n"), ("0002_b.sql", "CREATE TABLE b (x int);\nCREATE TABLE b2 (x no_such_type);\n")]);
    let e = migrate::migrate(&b, &rt, &dir, 1).unwrap_err();
    assert_eq!(e.code, "migrate.apply_failed", "{e}");
    let applied = migrate::read_applied(&b, &rt).unwrap();
    assert_eq!(applied.iter().map(|a| a.version).collect::<Vec<_>>(), vec![1], "0001 committed, 0002 rolled back");
    let b_exists = cluster::psql(&b, &rt, cluster::APP_DB, "select to_regclass('public.b') is not null").unwrap();
    assert_eq!(b_exists, vec![vec!["f".to_string()]], "a failed migration must leave nothing behind");
    // Fix 0002; the re-run applies only 0002.
    write_dir(&dir, &[("0001_a.sql", "CREATE TABLE a (x int);\n"), ("0002_b.sql", "CREATE TABLE b (x int);\n")]);
    let r = migrate::migrate(&b, &rt, &dir, 1).unwrap();
    assert_eq!((r.already_applied.clone(), r.applied_now.clone()), (vec![1], vec![2]));
    assert!(!r.store_incarnation_written, "no store_incarnation table in this schema");
    // Rewriting applied history is refused against the database.
    write_dir(&dir, &[("0001_a.sql", "CREATE TABLE a (x bigint);\n"), ("0002_b.sql", "CREATE TABLE b (x int);\n")]);
    assert_eq!(migrate::migrate(&b, &rt, &dir, 1).unwrap_err().code, "migrate.history_mismatch");
    // A manifest that ends before the database does is refused.
    write_dir(&dir, &[("0001_a.sql", "CREATE TABLE a (x int);\n")]);
    assert_eq!(migrate::migrate(&b, &rt, &dir, 1).unwrap_err().code, "migrate.database_newer");
    cluster::stop(&root, &b, false, false).unwrap();
    cluster::destroy(&root, &b).unwrap();

    // --- Part 2: WS2's real schema. ---
    let root_path = fresh_root("migrate-ws2");
    let root = guard::init_root(&root_path, &env).unwrap();
    let _cleanup2 = StopOnPanic::new(root.path(), &b);
    cluster::init(&root, &b, &InitOptions::default()).unwrap();
    let rt = cluster::start(&root, &b, None).unwrap();
    let files = migrate::read_schema_dir(&ws2).unwrap();
    let r = migrate::migrate(&b, &rt, &ws2, 1).unwrap();
    assert_eq!(r.applied_now, files.iter().map(|m| m.version).collect::<Vec<_>>());
    assert!(r.store_incarnation_written);
    let inc = cluster::psql(&b, &rt, cluster::APP_DB, "select count(*), count(distinct incarnation) from store_incarnation").unwrap();
    assert_eq!(inc, vec![vec!["1".to_string(), "1".to_string()]]);
    // Idempotent: a second run applies nothing and keeps the incarnation.
    let r2 = migrate::migrate(&b, &rt, &ws2, 1).unwrap();
    assert!(r2.applied_now.is_empty() && !r2.store_incarnation_written, "{r2:?}");
    assert_eq!(migrate::check_writer(&migrate::read_applied(&b, &rt).unwrap(), 1).unwrap(), 1);
    // WS2's own grants (0008+) let the runtime role read store_incarnation;
    // without them it is denied. Either way the runner granted nothing.
    let mut as_runtime = rt.clone();
    as_runtime.admin_role = cluster::RUNTIME_ROLE.into();
    let has_grants = files.iter().any(|m| m.file.contains("grants"));
    let seen = cluster::psql(&b, &as_runtime, cluster::APP_DB, "select count(*) from store_incarnation");
    assert_eq!(seen.is_ok(), has_grants, "runtime access {seen:?} vs grants migration present {has_grants}");
    let bk = cluster::psql(&b, &as_runtime, cluster::APP_DB, "select count(*) from orgtree_custodian.applied_migrations");
    assert!(bk.is_err(), "the runtime role must not read the custodian's bookkeeping");
    let tables = cluster::psql(&b, &rt, cluster::APP_DB, "select count(*) from pg_tables where schemaname = 'public'").unwrap();
    cluster::stop(&root, &b, false, false).unwrap();
    cluster::destroy(&root, &b).unwrap();
    println!(
        "P03-WS1-MIGRATE-RESULT ok: resume after failed 0002; history_mismatch and database_newer refused; WS2 schema {:?} applied ({} public tables), store_incarnation written once, re-run no-op, schema_dir {}",
        r.applied_now,
        tables[0][0],
        ws2.display()
    );
}

/// Start a writer that commits `n` transactions, each inserting one ledger
/// row and bumping the counter: the invariant count(ledger) = counter.total
/// holds in every committed state.
fn spawn_writer(b: &PgBin, rt: &cluster::RuntimeRecord, n: usize) -> std::thread::JoinHandle<()> {
    let mut script = String::with_capacity(n * 90);
    for _ in 0..n {
        script.push_str("BEGIN; INSERT INTO ledger(amount) VALUES (1); UPDATE counter SET total = total + 1; COMMIT;\n");
    }
    let (b, rt) = (b.clone(), rt.clone());
    std::thread::spawn(move || {
        cluster::psql_stdin(&b, &rt, cluster::APP_DB, &script, false).unwrap();
    })
}

fn one(b: &PgBin, rt: &cluster::RuntimeRecord, sql: &str) -> String {
    cluster::psql(b, rt, cluster::APP_DB, sql).unwrap()[0][0].clone()
}

#[test]
#[ignore = "starts real PostgreSQL clusters; run under the P03 machine-test-run gate with ORGTREE_P03_SCHEMA_DIR"]
fn backup_under_concurrent_writes_restores_consistently_under_a_new_incarnation() {
    use orgtree_pg_custodian::backup;
    let env = process_env();
    let b = bin();
    let work = fresh_root("backup-work");
    std::fs::create_dir_all(&work).unwrap();

    // Source cluster A: WS2's real schema plus a ledger/counter pair.
    let a_path = fresh_root("backup-src");
    let a = guard::init_root(&a_path, &env).unwrap();
    let _ca = StopOnPanic::new(a.path(), &b);
    cluster::init(&a, &b, &InitOptions::default()).unwrap();
    let rt_a = cluster::start(&a, &b, None).unwrap();
    orgtree_pg_custodian::migrate::migrate(&b, &rt_a, &schema_dir(), 1).unwrap();
    cluster::psql(&b, &rt_a, cluster::APP_DB, "create table ledger(id bigserial primary key, amount int not null); create table counter(id int primary key, total bigint not null); insert into counter values (1, 0)").unwrap();
    let old_inc = one(&b, &rt_a, "select incarnation::text from store_incarnation");
    let dbid = one(&b, &rt_a, "select database_id::text from store_incarnation");

    // Back up WHILE a writer commits.
    let writer = spawn_writer(&b, &rt_a, 20_000);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while one(&b, &rt_a, "select count(*) from ledger").parse::<u64>().unwrap() < 200 {
        assert!(std::time::Instant::now() < deadline, "writer never got going");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let before: u64 = one(&b, &rt_a, "select count(*) from ledger").parse().unwrap();
    let out = work.join("backup-1");
    let manifest = backup::backup(&a, &b, &out, &env).unwrap();
    let after: u64 = one(&b, &rt_a, "select count(*) from ledger").parse().unwrap();
    writer.join().unwrap();
    let in_backup = manifest.tables["public.ledger"].rows;
    assert!(before < after, "no write happened during the backup window ({before}..{after}): the concurrency claim would be unproven");
    assert!(before <= in_backup && in_backup <= after, "backup rows {in_backup} not within [{before}, {after}]");
    assert_eq!(manifest.store_incarnation.as_ref().map(|i| i.1.clone()), Some(old_inc.clone()));
    cluster::stop(&a, &b, false, false).unwrap();

    // Restore into a fresh cluster B (one cluster runs at a time).
    let b_path = fresh_root("backup-dst");
    let bb = guard::init_root(&b_path, &env).unwrap();
    let _cb = StopOnPanic::new(bb.path(), &b);
    cluster::init(&bb, &b, &InitOptions::default()).unwrap();
    let rt_b = cluster::start(&bb, &b, None).unwrap();
    // A tampered dump is refused before anything is restored.
    let tampered = work.join("backup-tampered");
    std::fs::create_dir_all(&tampered).unwrap();
    for f in [backup::DUMP_FILE, backup::MANIFEST_FILE] {
        std::fs::copy(out.join(f), tampered.join(f)).unwrap();
    }
    let mut bytes = std::fs::read(tampered.join(backup::DUMP_FILE)).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xff;
    std::fs::write(tampered.join(backup::DUMP_FILE), bytes).unwrap();
    assert_eq!(backup::restore(&bb, &b, &tampered).unwrap_err().code, "restore.dump_mismatch");
    let report = backup::restore(&bb, &b, &out).unwrap();
    assert_eq!(report.tables_verified, manifest.tables.len());
    // Consistent: the invariant holds, and the restored database is exactly the snapshot.
    let n: u64 = one(&b, &rt_b, "select count(*) from ledger").parse().unwrap();
    let total: u64 = one(&b, &rt_b, "select total from counter").parse().unwrap();
    assert_eq!((n, total), (in_backup, in_backup), "restored ledger/counter disagree");
    // A new incarnation of the same database.
    assert_eq!(report.database_id.as_deref(), Some(dbid.as_str()));
    assert_ne!(report.new_incarnation.as_deref(), Some(old_inc.as_str()));
    assert_eq!(one(&b, &rt_b, "select incarnation::text from store_incarnation"), report.new_incarnation.clone().unwrap());
    // A second restore into the now non-empty database is refused.
    assert_eq!(backup::restore(&bb, &b, &out).unwrap_err().code, "restore.target_not_empty");
    // The applied-migrations bookkeeping came across: the runner sees nothing to do.
    let r = orgtree_pg_custodian::migrate::migrate(&b, &rt_b, &schema_dir(), 1).unwrap();
    assert!(r.applied_now.is_empty() && !r.store_incarnation_written, "{r:?}");
    cluster::stop(&bb, &b, false, false).unwrap();
    cluster::destroy(&bb, &b).unwrap();

    // A manifest that does not describe the dump: restore refuses AFTER
    // loading and never mints a new incarnation (the target must be destroyed).
    let lying = work.join("backup-lying-manifest");
    std::fs::create_dir_all(&lying).unwrap();
    std::fs::copy(out.join(backup::DUMP_FILE), lying.join(backup::DUMP_FILE)).unwrap();
    let mut m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(out.join(backup::MANIFEST_FILE)).unwrap()).unwrap();
    m["tables"]["public.ledger"]["rows"] = json!(in_backup + 1);
    std::fs::write(lying.join(backup::MANIFEST_FILE), m.to_string()).unwrap();
    let c_path = fresh_root("backup-dst2");
    let cc = guard::init_root(&c_path, &env).unwrap();
    let _cc = StopOnPanic::new(cc.path(), &b);
    cluster::init(&cc, &b, &InitOptions::default()).unwrap();
    let rt_c = cluster::start(&cc, &b, None).unwrap();
    assert_eq!(backup::restore(&cc, &b, &lying).unwrap_err().code, "restore.content_mismatch");
    assert_eq!(one(&b, &rt_c, "select incarnation::text from store_incarnation"), old_inc, "a refused restore must not mint an incarnation");
    cluster::stop(&cc, &b, false, false).unwrap();
    cluster::destroy(&cc, &b).unwrap();
    cluster::destroy(&a, &b).unwrap();
    std::fs::remove_dir_all(&work).unwrap();
    println!(
        "P03-WS1-BACKUP-RESULT ok: backup during writes (ledger {before}..{after}, snapshot has {in_backup}); tampered dump refused; restore verified {} tables / {} rows; invariant holds; incarnation {old_inc} -> {}; database_id kept; non-empty target refused",
        report.tables_verified,
        report.rows_verified,
        report.new_incarnation.unwrap()
    );
}

#[test]
#[ignore = "runs initdb; run under the P03 machine-test-run gate"]
fn init_killed_before_commit_leaves_only_quarantine() {
    let env = process_env();
    let b = bin();
    let root_path = fresh_root("abort");
    let root = guard::init_root(&root_path, &env).unwrap();
    let _cleanup = StopOnPanic::new(root.path(), &b);
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
