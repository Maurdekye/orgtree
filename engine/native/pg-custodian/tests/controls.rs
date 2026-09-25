//! WS1 unsafe controls (a)-(d). Built only with `--features qualification`.
//! A control is ACCEPTED only when (1) its `control_executed` record exists
//! and (2) its unsafe outcome is observed; the safe custodian is run on the
//! same situation and must refuse or stay consistent. Each test prints one
//! `P03-WS1-CONTROL` line with both arms.
//!
//!   ORGTREE_P03_PG_BIN=... cargo test --features qualification --test controls \
//!       -- --ignored --test-threads=1 --nocapture      (under the P03 run lock)
#![cfg(feature = "qualification")]

use orgtree_pg_custodian::cluster::{self, ClusterState, InitOptions, Layout, PgBin};
use orgtree_pg_custodian::controls;
use orgtree_pg_custodian::guard::{self, process_env};
use orgtree_pg_custodian::win;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn bin() -> PgBin {
    let dir = std::env::var_os("ORGTREE_P03_PG_BIN").expect("ORGTREE_P03_PG_BIN must be set; controls never skip silently");
    PgBin::locate(&PathBuf::from(dir)).unwrap()
}

fn fresh(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("orgtree p03 ctl-{tag} {}", win::random_hex(4).unwrap()))
}

/// Fresh control log for one test.
fn control_log(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("orgtree-p03-controls-{tag}-{}.jsonl", win::random_hex(4).unwrap()));
    std::env::set_var(controls::CONTROL_LOG_ENV, &p);
    p
}

struct StopOnPanic(Vec<PathBuf>, PathBuf);
impl Drop for StopOnPanic {
    fn drop(&mut self) {
        if std::thread::panicking() {
            for d in &self.0 {
                if d.join("postmaster.pid").exists() {
                    let _ = std::process::Command::new(&self.1).args(["stop", "-m", "immediate", "-w", "-D"]).arg(d)
                        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
                }
            }
        }
    }
}

fn data_of(root: &Path) -> PathBuf {
    root.join("pg").join("cluster").join("data")
}

fn require_executed(log: &Path, id: &str) -> usize {
    let n = controls::executed_records(log, id).len();
    assert!(n > 0, "control {id} has no control_executed record: it did not run, so it proves nothing");
    n
}

// ---------------------------------------------------------------- (a)

#[test]
#[ignore = "real clusters; P03 run lock"]
fn a_port_pid_trust_attaches_to_a_planted_namesake() {
    let log = control_log("a");
    let env = process_env();
    let b = bin();
    let a_path = fresh("a-owner");
    let n_path = fresh("a-namesake");
    let _g = StopOnPanic(vec![data_of(&a_path), data_of(&n_path)], b.exe("pg_ctl"));
    let a = guard::init_root(&a_path, &env).unwrap();
    cluster::init(&a, &b, &InitOptions::default()).unwrap();
    let rt_a = cluster::start(&a, &b, None).unwrap();
    let stale = std::fs::read_to_string(Layout::of(&a).attach).unwrap();
    // A dies; its descriptor is left behind (as after a crash).
    cluster::stop(&a, &b, true, false).unwrap();
    orgtree_pg_custodian::acl::replace_owner_only(&Layout::of(&a).attach, stale.as_bytes()).unwrap();
    // A namesake instance (same roles, same database name, its own secrets)
    // is started on A's recorded port. Its postmaster takes over the recorded
    // pid slot in the stale descriptor, simulating pid reuse.
    let n = guard::init_root(&n_path, &env).unwrap();
    cluster::init(&n, &b, &InitOptions::default()).unwrap();
    let rt_n = cluster::start(&n, &b, Some(rt_a.port)).unwrap();
    let mut forged: serde_json::Value = serde_json::from_str(&stale).unwrap();
    forged["postmaster_pid"] = json!(rt_n.postmaster_pid);
    orgtree_pg_custodian::acl::replace_owner_only(&Layout::of(&a).attach, forged.to_string().as_bytes()).unwrap();

    // UNSAFE arm: attaches.
    let unsafe_rt = controls::attach_trusting_port_pid(&a).expect("the unsafe control should have attached");
    let executed = require_executed(&log, "WS1.a.attach_trusting_port_pid");
    // ...to a server that is NOT A: its system_identifier is N's.
    let (_, id_n) = cluster::identify(&n, &b).unwrap();
    assert_eq!(unsafe_rt.port, rt_n.port);
    assert_ne!(id_n.system_identifier, rt_a.system_identifier, "the planted server must really be foreign");
    // SAFE arm: refuses (A is not running per its own data folder).
    let safe = cluster::attach(&a, &b).unwrap_err();
    assert!(safe.code == "cluster.not_running" || safe.code.starts_with("identify.") || safe.code.starts_with("identity."), "{safe}");

    cluster::stop(&n, &b, false, false).unwrap();
    cluster::destroy(&n, &b).unwrap();
    cluster::destroy(&a, &b).unwrap();
    println!(
        "P03-WS1-CONTROL {}",
        json!({"id": "WS1.a.attach_trusting_port_pid", "executed_records": executed,
               "unsafe": {"attached": true, "to_system_identifier": id_n.system_identifier, "owner_system_identifier": rt_a.system_identifier},
               "safe": {"refused": safe.code}})
    );
}

// ---------------------------------------------------------------- (b)

#[test]
#[ignore = "real cluster; P03 run lock"]
fn b_readiness_without_the_prepared_check_accepts_a_misconfigured_cluster() {
    let log = control_log("b");
    let env = process_env();
    let b = bin();
    let p = fresh("b");
    let _g = StopOnPanic(vec![data_of(&p)], b.exe("pg_ctl"));
    let r = guard::init_root(&p, &env).unwrap();
    cluster::init(&r, &b, &InitOptions::default()).unwrap();
    // Misconfigure: the last line of postgresql.conf wins.
    let conf = Layout::of(&r).data.join("postgresql.conf");
    let mut t = std::fs::read_to_string(&conf).unwrap();
    t.push_str("max_prepared_transactions = 5\r\n");
    std::fs::write(&conf, t).unwrap();
    let rt = cluster::start(&r, &b, None).unwrap();
    let real = cluster::psql(&b, &rt, "postgres", "show max_prepared_transactions").unwrap();
    assert_eq!(real, vec![vec!["5".to_string()]], "the misconfiguration must be real");
    let (_, id) = cluster::identify(&r, &b).unwrap();
    // UNSAFE arm: accepts.
    let unsafe_failures = controls::readiness_without_prepared_check(&id.settings);
    let executed = require_executed(&log, "WS1.b.readiness_without_prepared_check");
    // Other readiness failures would muddy the verdict; there must be none.
    assert!(unsafe_failures.is_empty(), "unsafe readiness should accept, got {unsafe_failures:?}");
    // SAFE arm: refuses.
    assert!(id.readiness_failures.iter().any(|f| f.starts_with("max_prepared_transactions=5")), "{:?}", id.readiness_failures);
    let safe = cluster::attach(&r, &b).unwrap_err();
    assert_eq!(safe.code, "attach.not_ready");
    cluster::stop(&r, &b, false, false).unwrap();
    cluster::destroy(&r, &b).unwrap();
    println!(
        "P03-WS1-CONTROL {}",
        json!({"id": "WS1.b.readiness_without_prepared_check", "executed_records": executed,
               "unsafe": {"accepted": true, "server_max_prepared_transactions": "5"},
               "safe": {"refused": safe.code, "readiness_failures": id.readiness_failures}})
    );
}

// ---------------------------------------------------------------- (c)

/// Kill `initdb` (and its bootstrap postgres) once `data/PG_VERSION` exists
/// under `watch` (any depth <= 3), i.e. mid-initialization. Returns whether
/// the kill landed before initdb finished.
fn kill_initdb_when_half_made(watch: PathBuf, parent: u32) -> std::thread::JoinHandle<bool> {
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        let find_data = |w: &Path| -> Option<PathBuf> {
            let direct = w.join("PG_VERSION");
            if direct.is_file() {
                return Some(direct);
            }
            for e in std::fs::read_dir(w).ok()?.flatten() {
                let cand = e.path().join("data").join("PG_VERSION");
                if cand.is_file() {
                    return Some(cand);
                }
            }
            None
        };
        while Instant::now() < deadline {
            if find_data(&watch).is_some() {
                let snap = win::snapshot().unwrap();
                let initdbs: Vec<u32> = snap.iter().filter(|p| p.exe_name.eq_ignore_ascii_case("initdb.exe") && p.parent_pid == parent).map(|p| p.pid).collect();
                let mut killed = false;
                for pid in &initdbs {
                    for fam in win::family_pids(&snap, *pid) {
                        if let Some(h) = win::ProcessHandle::open(fam) {
                            killed |= h.terminate();
                        }
                    }
                }
                return killed;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        false
    })
}

#[test]
#[ignore = "runs initdb; P03 run lock"]
fn c_init_without_quarantine_treats_a_half_made_cluster_as_current() {
    let log = control_log("c");
    let env = process_env();
    let b = bin();
    let me = std::process::id();

    // UNSAFE arm.
    let u_path = fresh("c-unsafe");
    let u = guard::init_root(&u_path, &env).unwrap();
    let killer = kill_initdb_when_half_made(Layout::of(&u).data, me);
    let res = controls::init_without_quarantine(&u, &b, |_| {});
    let killed = killer.join().unwrap();
    let executed = require_executed(&log, "WS1.c.init_without_quarantine");
    assert!(killed && res.is_err(), "initdb must be killed mid-run for this control to mean anything (killed={killed}, result={res:?})");
    let unsafe_current = controls::current_without_quarantine(&u);
    require_executed(&log, "WS1.c.current_without_quarantine");
    assert!(unsafe_current, "the unsafe rule should call the half-made cluster current");
    // What the safe reader makes of the same folder: not a usable cluster.
    let safe_view_of_unsafe = cluster::state(&u, &b).unwrap();
    assert!(matches!(safe_view_of_unsafe, ClusterState::Incomplete { .. }), "{safe_view_of_unsafe:?}");

    // SAFE arm: the same kill during the custodian's init.
    let s_path = fresh("c-safe");
    let s = guard::init_root(&s_path, &env).unwrap();
    let killer = kill_initdb_when_half_made(Layout::of(&s).pg.clone(), me);
    let safe_res = cluster::init(&s, &b, &InitOptions::default());
    let killed_safe = killer.join().unwrap();
    assert!(killed_safe && safe_res.is_err(), "the safe arm's initdb must be killed too (killed={killed_safe}, result={safe_res:?})");
    match cluster::state(&s, &b).unwrap() {
        ClusterState::Absent { quarantined: 1 } => {}
        other => panic!("safe init killed mid-way must read as Absent with one quarantined folder, got {other:?}"),
    }
    assert_eq!(cluster::start(&s, &b, None).unwrap_err().code, "cluster.absent");
    std::fs::remove_dir_all(&u_path).unwrap();
    std::fs::remove_dir_all(&s_path).unwrap();
    println!(
        "P03-WS1-CONTROL {}",
        json!({"id": "WS1.c.init_without_quarantine", "executed_records": executed,
               "unsafe": {"initdb_killed": killed, "treated_as_current": unsafe_current, "safe_reader_says": format!("{safe_view_of_unsafe:?}").split(' ').next()},
               "safe": {"initdb_killed": killed_safe, "state": "Absent{quarantined:1}", "start_refused": "cluster.absent"}})
    );
}

// ---------------------------------------------------------------- (d)

#[test]
#[ignore = "real clusters; P03 run lock"]
fn d_a_live_directory_copy_restores_inconsistently_under_writes() {
    let log = control_log("d");
    let env = process_env();
    let b = bin();
    let p = fresh("d-src");
    let copy = fresh("d-copy").join("data");
    let _g = StopOnPanic(vec![data_of(&p), copy.clone()], b.exe("pg_ctl"));
    let r = guard::init_root(&p, &env).unwrap();
    cluster::init(&r, &b, &InitOptions::default()).unwrap();
    let rt = cluster::start(&r, &b, None).unwrap();
    cluster::psql(&b, &rt, cluster::APP_DB, "create table l(x int); create table r(x int); checkpoint").unwrap();
    let r_file = cluster::psql(&b, &rt, cluster::APP_DB, "select pg_relation_filepath('r')").unwrap()[0][0].clone();
    // Each transaction writes BOTH tables: count(l) = count(r) always holds.
    let workload: String = (0..500).map(|i| format!("BEGIN; INSERT INTO l VALUES ({i}); INSERT INTO r VALUES ({i}); COMMIT;\n")).collect::<String>() + "CHECKPOINT;\n";
    let (bb, rtt) = (b.clone(), rt.clone());
    let files = controls::backup_by_live_copy(&r, &copy, &[PathBuf::from(&r_file)], move || {
        cluster::psql_stdin(&bb, &rtt, cluster::APP_DB, &workload, false).unwrap();
    })
    .unwrap();
    let executed = require_executed(&log, "WS1.d.backup_by_live_copy");
    let src_counts = cluster::psql(&b, &rt, cluster::APP_DB, "select (select count(*) from l), (select count(*) from r)").unwrap();
    assert_eq!(src_counts, vec![vec!["500".to_string(), "500".to_string()]], "the source itself is consistent");
    cluster::stop(&r, &b, false, false).unwrap();

    // Unsafe restore: start the copy as it is.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let start = controls::start_copy(&b, &copy, &copy.parent().unwrap().join("copy.log"), port);
    let outcome = match start {
        Err(e) => json!({"restore": "server refused to start", "code": e.code}),
        Ok(()) => {
            let mut rt2 = rt.clone();
            rt2.port = port;
            let c = cluster::psql(&b, &rt2, cluster::APP_DB, "select (select count(*) from l), (select count(*) from r)").unwrap();
            controls::stop_copy(&b, &copy);
            assert_ne!(c[0][0], c[0][1], "the live copy restored CONSISTENTLY: control (d) failed to show the hazard ({c:?})");
            json!({"restore": "started", "count_l": c[0][0], "count_r": c[0][1], "invariant_broken": true})
        }
    };
    cluster::destroy(&r, &b).unwrap();
    let _ = std::fs::remove_dir_all(copy.parent().unwrap());
    println!(
        "P03-WS1-CONTROL {}",
        json!({"id": "WS1.d.backup_by_live_copy", "executed_records": executed, "files_copied": files,
               "unsafe": outcome,
               "safe": "see backup_under_concurrent_writes_restores_consistently_under_a_new_incarnation (smoke_cluster.rs): same-snapshot dump restores with the invariant intact"})
    );
}
