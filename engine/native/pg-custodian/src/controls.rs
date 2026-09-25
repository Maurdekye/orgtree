//! WS1's four UNSAFE CONTROLS (P03-PLAN WS1 "Verification"). Each is the
//! naive variant of a custodian safety step, built only with the cargo
//! feature `qualification` (the M1 contract §3 feature name), so a product
//! build cannot contain them. Every control records that it EXECUTED, at its
//! own site, before doing anything (G3: a control that "passes" without
//! evidence that it ran is a failed control). The tests in
//! `tests/controls.rs` accept a control only with that record AND the unsafe
//! outcome, and run the safe counterpart on the same situation.
//!
//! (a) `attach_trusting_port_pid`: attaches to whatever answers on the
//!     descriptor's port while its pid is alive: fooled by a planted namesake.
//! (b) `readiness_without_prepared_check`: readiness with the
//!     `max_prepared_transactions = 0` assertion removed: accepts a
//!     misconfigured cluster.
//! (c) `init_without_quarantine` + `current_without_quarantine`: initdb
//!     straight into the live cluster folder, and "current" means "PG_VERSION
//!     exists": a kill during initdb leaves a half-made cluster that is
//!     treated as current.
//! (d) `backup_by_live_copy`: a file copy of the running data directory:
//!     under concurrent writes the restore is inconsistent. The copy order is
//!     staged to the worst case so the failure is deterministic rather than
//!     lucky: everything first, then (after the caller's writes and a
//!     checkpoint) the control files, WAL, commit log and the second table.

use crate::cluster::{self, InitOptions, Layout, PgBin, RuntimeRecord};
use crate::error::{CustodianError, Result};
use crate::guard::PrototypeRoot;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const CONTROL_LOG_ENV: &str = "ORGTREE_P03_CONTROL_LOG";

/// Append `control_executed` to the control log (env ORGTREE_P03_CONTROL_LOG,
/// else stderr). Called at the control's own site, first thing.
pub fn executed(id: &str, detail: Value) -> Value {
    let rec = json!({"event": "control_executed", "id": id, "at_unix": crate::now_unix(), "pid": std::process::id(), "detail": detail});
    let line = format!("{rec}\n");
    match std::env::var_os(CONTROL_LOG_ENV) {
        Some(p) => {
            let _ = fs::OpenOptions::new().create(true).append(true).open(p).and_then(|mut f| f.write_all(line.as_bytes()));
        }
        None => eprint!("{line}"),
    }
    rec
}

/// Records of one control id in the log file.
pub fn executed_records(log: &Path, id: &str) -> Vec<Value> {
    fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["event"] == "control_executed" && v["id"] == id)
        .collect()
}

// ---------------------------------------------------------------- (a)

/// UNSAFE: read the descriptor as-is (no ACL check), and "attach" when a TCP
/// connection to its port succeeds and its pid is a live process.
pub fn attach_trusting_port_pid(root: &PrototypeRoot) -> Result<RuntimeRecord> {
    executed("WS1.a.attach_trusting_port_pid", json!({"root": root.path()}));
    let layout = Layout::of(root);
    let text = fs::read_to_string(&layout.attach).map_err(|e| CustodianError::io("control.a", &layout.attach, e))?;
    let rt: RuntimeRecord = serde_json::from_str(&text).map_err(|e| CustodianError::new("control.a", e.to_string()))?;
    let addr = format!("{}:{}", rt.host, rt.port);
    std::net::TcpStream::connect_timeout(&addr.parse().map_err(|_| CustodianError::new("control.a", addr.clone()))?, std::time::Duration::from_secs(2))
        .map_err(|e| CustodianError::new("control.a", format!("nothing listens on {addr}: {e}")))?;
    let alive = crate::win::ProcessHandle::open(rt.postmaster_pid).map(|h| !h.wait_exit(0)).unwrap_or(false);
    if !alive {
        return Err(CustodianError::new("control.a", format!("pid {} is not alive", rt.postmaster_pid)));
    }
    Ok(rt)
}

// ---------------------------------------------------------------- (b)

/// UNSAFE: readiness without the prepared-transactions assertion.
pub fn readiness_without_prepared_check(settings: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    executed("WS1.b.readiness_without_prepared_check", json!({"max_prepared_transactions": settings.get("max_prepared_transactions")}));
    cluster::readiness_failures(settings).into_iter().filter(|f| !f.starts_with("max_prepared_transactions")).collect()
}

// ---------------------------------------------------------------- (c)

/// UNSAFE: initdb directly into `<root>/pg/cluster/data` — no staging, no
/// committing rename. `on_spawn` receives the initdb child's pid (the test
/// kills it mid-run).
pub fn init_without_quarantine(root: &PrototypeRoot, bin: &PgBin, on_spawn: impl FnOnce(u32)) -> Result<()> {
    executed("WS1.c.init_without_quarantine", json!({"root": root.path()}));
    let layout = Layout::of(root);
    fs::create_dir_all(&layout.log).map_err(|e| CustodianError::io("control.c", &layout.log, e))?;
    let pw = layout.cluster.join("initdb.pw");
    fs::write(&pw, "x\n").map_err(|e| CustodianError::io("control.c", &pw, e))?;
    let mut child = cluster::child(&bin.exe("initdb"))
        .arg("-D")
        .arg(&layout.data)
        .args(["-U", cluster::ADMIN_ROLE, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--no-instructions"])
        .arg(format!("--pwfile={}", pw.display()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| CustodianError::new("control.c", e.to_string()))?;
    on_spawn(child.id());
    let status = child.wait().map_err(|e| CustodianError::new("control.c", e.to_string()))?;
    if !status.success() {
        return Err(CustodianError::new("control.c.initdb_died", format!("initdb {status}")));
    }
    Ok(())
}

/// UNSAFE: "the cluster is current when its data folder has a PG_VERSION".
pub fn current_without_quarantine(root: &PrototypeRoot) -> bool {
    executed("WS1.c.current_without_quarantine", json!({"root": root.path()}));
    Layout::of(root).data.join("PG_VERSION").is_file()
}

// ---------------------------------------------------------------- (d)

fn copy_tree(from: &Path, to: &Path, skip: &dyn Fn(&Path) -> bool) -> std::io::Result<u64> {
    let mut n = 0;
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let p = e.path();
        if skip(&p) {
            continue;
        }
        let dst = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            n += copy_tree(&p, &dst, skip)?;
        } else {
            // A live file may be mid-write or vanish: a naive copier shrugs.
            if fs::copy(&p, &dst).is_ok() {
                n += 1;
            }
        }
    }
    Ok(n)
}

/// UNSAFE: back up by copying the running data directory. Phase 1 copies
/// everything; `between` runs (the caller's writes + CHECKPOINT); phase 2
/// copies the control/WAL/commit-log folders and `late_files` (relative to
/// the data dir) again, as a slow copier would reach them later.
pub fn backup_by_live_copy(root: &PrototypeRoot, out: &Path, late_files: &[PathBuf], between: impl FnOnce()) -> Result<u64> {
    executed("WS1.d.backup_by_live_copy", json!({"root": root.path(), "out": out}));
    let data = Layout::of(root).data;
    let skip = |p: &Path| matches!(p.file_name().and_then(|n| n.to_str()), Some("postmaster.pid") | Some("postmaster.opts"));
    let mut n = copy_tree(&data, out, &skip).map_err(|e| CustodianError::new("control.d", e.to_string()))?;
    between();
    for dir in ["global", "pg_wal", "pg_xact", "pg_multixact", "pg_subtrans", "pg_commit_ts"] {
        let src = data.join(dir);
        if src.is_dir() {
            n += copy_tree(&src, &out.join(dir), &skip).map_err(|e| CustodianError::new("control.d", e.to_string()))?;
        }
    }
    for rel in late_files {
        let src = data.join(rel);
        fs::copy(&src, out.join(rel)).map_err(|e| CustodianError::io("control.d", &src, e))?;
        n += 1;
    }
    Ok(n)
}

/// Start a copied data directory on `port` with pg_ctl (the unsafe restore:
/// no manifest, no verification). Returns the pg_ctl outcome.
pub fn start_copy(bin: &PgBin, data: &Path, log: &Path, port: u16) -> Result<()> {
    crate::win::stop_std_handle_inheritance();
    let status = cluster::child(&bin.exe("pg_ctl"))
        .args(["start", "-w", "-t", "120", "-D"])
        .arg(data)
        .arg("-l")
        .arg(log)
        .arg("-o")
        .arg(format!("-p {port}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| CustodianError::new("control.d.start", e.to_string()))?;
    if !status.success() {
        return Err(CustodianError::new("control.d.start_failed", format!("pg_ctl start {status}; see {}", log.display())));
    }
    Ok(())
}

pub fn stop_copy(bin: &PgBin, data: &Path) {
    let _ = cluster::child(&bin.exe("pg_ctl"))
        .args(["stop", "-m", "immediate", "-w", "-t", "120", "-D"])
        .arg(data)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Default options, re-exported for control tests.
pub fn default_init() -> InitOptions {
    InitOptions::default()
}
