//! The dev-cluster convention every P03 workstream uses (M1 interface
//! contract §5): one disposable cluster per agent at
//! `<repo>/artifacts/p03-db/<agent>/`, on a port derived from the agent's
//! name, with the pinned engine at `<repo>/artifacts/p03-postgresql/18.6-4/bin`.
//! `<repo>` is the MAIN checkout (the git common dir's parent), so every
//! worktree finds the same clusters and the same engine.

use crate::cluster::{self, ClusterState, InitOptions, PgBin, RuntimeRecord};
use crate::error::{CustodianError, Result};
use crate::guard::{self, Env, PrototypeRoot};
use crate::win;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PORT_BASE: u16 = 41000;
pub const PORT_SPAN: u16 = 8000;

/// Deterministic port for an agent: FNV-1a(name) into 41000-48999, below
/// Windows' dynamic range (49152+), so ephemeral client ports rarely collide.
pub fn port_for(agent: &str) -> u16 {
    let mut h: u32 = 0x811c9dc5;
    for b in agent.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    PORT_BASE + (h % PORT_SPAN as u32) as u16
}

pub fn check_agent(agent: &str) -> Result<()> {
    let ok = !agent.is_empty()
        && agent.len() <= 64
        && agent.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !agent.starts_with('-');
    if !ok {
        return Err(CustodianError::new("dev.bad_agent", format!("agent name {agent:?} must be 1-64 of [a-z0-9-]")));
    }
    Ok(())
}

/// The main checkout: `ORGTREE_P03_HOME`, else the parent of git's common dir.
pub fn repo_home(env: &Env) -> Result<PathBuf> {
    if let Some(h) = env.get("ORGTREE_P03_HOME").filter(|h| !h.trim().is_empty()) {
        return Ok(PathBuf::from(h.trim()));
    }
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .map_err(|e| CustodianError::new("dev.home", format!("git not runnable: {e}; set ORGTREE_P03_HOME")))?;
    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || common.is_empty() {
        return Err(CustodianError::new("dev.home", "not inside the orgtree repo; set ORGTREE_P03_HOME"));
    }
    Path::new(&common)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| CustodianError::new("dev.home", format!("odd git common dir {common}")))
}

pub fn db_home(home: &Path) -> PathBuf {
    home.join("artifacts").join("p03-db")
}

pub fn default_bin(home: &Path) -> PathBuf {
    home.join("artifacts").join("p03-postgresql").join(format!("{}-4", cluster::EXPECTED_ENGINE)).join("bin")
}

pub fn agent_root(home: &Path, agent: &str) -> Result<PathBuf> {
    check_agent(agent)?;
    Ok(db_home(home).join(agent))
}

#[derive(Debug, Serialize)]
pub struct DevUp {
    pub agent: String,
    pub root: PathBuf,
    pub created: bool,
    pub started: bool,
    pub runtime: RuntimeRecord,
    pub ready: bool,
    pub readiness_failures: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// Mark (if new), initialize (if absent), start (if stopped) and identify the
/// agent's cluster, then return its URLs. A cluster that is already running
/// is identified, never trusted by port or PID alone.
pub fn up(env: &Env, home: &Path, bin: &PgBin, agent: &str) -> Result<DevUp> {
    let path = agent_root(home, agent)?;
    let (root, created) = match guard::validate_root(&path, env) {
        Ok(r) => (r, false),
        Err(e) if e.code == "root.unmarked" || e.code == "root.missing" => (guard::init_root(&path, env)?, true),
        Err(e) => return Err(e),
    };
    if let ClusterState::Absent { .. } = cluster::state(&root, bin)? {
        cluster::init(&root, bin, &InitOptions::default())?;
    }
    let started = !matches!(cluster::state(&root, bin)?, ClusterState::Running { .. });
    if started {
        cluster::start(&root, bin, Some(port_for(agent)))?;
    }
    let (runtime, id) = cluster::identify(&root, bin)?;
    if !id.identity_ok() {
        return Err(CustodianError::new("identity.mismatch", format!("{:?}", id.mismatches)));
    }
    Ok(DevUp {
        agent: agent.into(),
        root: root.path().to_path_buf(),
        created,
        started,
        // Passwords are printed ONLY by `dev env` / `urls` (lead ruling
        // 2026-09-25); everything else shows the redacted form.
        env: cluster::urls(&root, &runtime)?.into_iter().map(|(k, v)| (k, redact(&v))).collect(),
        ready: id.ready(),
        readiness_failures: id.readiness_failures,
        runtime,
    })
}

pub fn root_for(env: &Env, home: &Path, agent: &str) -> Result<PrototypeRoot> {
    guard::validate_root(&agent_root(home, agent)?, env)
}

#[derive(Debug, Serialize)]
pub struct ClusterListing {
    pub agent: String,
    pub root: PathBuf,
    pub state: serde_json::Value,
    pub port: Option<u16>,
    pub postmaster_pid: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AllStatus {
    pub db_home: PathBuf,
    pub clusters: Vec<ClusterListing>,
    pub running: usize,
    /// Postmasters of the pinned engine that no listed cluster accounts for.
    pub unlisted_postmasters: Vec<u32>,
    pub commit_free_gb: f64,
}

/// Every P03 dev cluster under `artifacts/p03-db`, without connecting to any.
pub fn status_all(env: &Env, home: &Path, bin: &PgBin) -> Result<AllStatus> {
    let dir = db_home(home);
    let mut clusters = Vec::new();
    let mut listed_pids = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut names: Vec<_> = rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).collect();
        names.sort_by_key(|e| e.file_name());
        for e in names {
            let agent = e.file_name().to_string_lossy().to_string();
            let (state, port, pid) = match guard::validate_root(&e.path(), env).and_then(|r| cluster::state(&r, bin)) {
                Ok(ClusterState::Running { postmaster_pid, runtime, .. }) => {
                    listed_pids.push(postmaster_pid);
                    (serde_json::json!("running"), runtime.map(|r| r.port), Some(postmaster_pid))
                }
                Ok(s) => (serde_json::to_value(&s).map(|v| v["state"].clone()).unwrap_or_default(), None, None),
                Err(err) => (serde_json::json!({"refused": err.code, "message": err.message}), None, None),
            };
            clusters.push(ClusterListing { agent, root: e.path(), state, port, postmaster_pid: pid });
        }
    }
    // A postmaster is a postgres.exe whose parent is not a postgres.exe.
    let snap = win::snapshot()?;
    let ours = bin.exe("postgres");
    let mut unlisted = Vec::new();
    for p in &snap {
        if !p.exe_name.eq_ignore_ascii_case("postgres.exe") || listed_pids.contains(&p.pid) {
            continue;
        }
        let parent_is_pg = snap
            .iter()
            .any(|q| q.pid == p.parent_pid && q.exe_name.eq_ignore_ascii_case("postgres.exe"));
        if parent_is_pg {
            continue;
        }
        let is_ours = win::ProcessHandle::open(p.pid)
            .and_then(|h| h.image_path())
            .map(|img| win::same_file(&img, &ours))
            .unwrap_or(false);
        if is_ours {
            unlisted.push(p.pid);
        }
    }
    Ok(AllStatus {
        db_home: dir,
        running: clusters.iter().filter(|c| c.postmaster_pid.is_some()).count(),
        clusters,
        unlisted_postmasters: unlisted,
        commit_free_gb: win::free_commit_bytes().map(|b| b as f64 / 1e9).unwrap_or(-1.0),
    })
}

/// `postgresql://role:secret@host...` → `postgresql://role:***@host...`.
/// Anything that does not parse as such is replaced whole.
pub fn redact(url: &str) -> String {
    let Some(rest) = url.strip_prefix("postgresql://") else { return "***".into() };
    match (rest.find(':'), rest.find('@')) {
        (Some(c), Some(a)) if c < a => format!("postgresql://{}:***{}", &rest[..c], &rest[a..]),
        _ => "***".into(),
    }
}

/// Render URLs for a shell: `ps` → `$env:X='...'`, `sh` → `export X='...'`,
/// `plain` → `X=...`.
pub fn render_env(vars: &BTreeMap<String, String>, shell: &str) -> Result<String> {
    let mut s = String::new();
    for (k, v) in vars {
        match shell {
            "ps" => s.push_str(&format!("$env:{k}='{v}'\n")),
            "sh" => s.push_str(&format!("export {k}='{v}'\n")),
            "plain" => s.push_str(&format!("{k}={v}\n")),
            other => return Err(CustodianError::new("cli.usage", format!("--shell must be ps, sh or plain, not {other:?}"))),
        }
    }
    Ok(s)
}
