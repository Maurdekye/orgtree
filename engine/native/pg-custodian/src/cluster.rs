//! Cluster lifecycle: initialize, start, identify, stop, destroy.
//!
//! Layout under a validated prototype root:
//!
//! ```text
//! <root>/orgtree-p03-prototype-root.json   marker (guard.rs)
//! <root>/pg/cluster/                       the CURRENT cluster, committed by one rename
//!     instance.json                        identity: root id, system_identifier, token, engine
//!     pg-attach.json                       attach descriptor, owner-only, present only while it runs
//!     data/                                PGDATA
//!     secrets/                             owner-only from birth: pgpass.conf, credentials.json
//!     log/postgres.log, log/pg_ctl.log, log/initdb.log
//! <root>/pg/staging-<hex>/                 QUARANTINE: an initialization in progress or abandoned
//! ```
//!
//! Initialization builds the whole cluster inside a staging folder and makes
//! it current with ONE directory rename, after `instance.json` is written.
//! A kill at any point before the rename leaves only staging debris, which is
//! never started, attached or identified (WS1 unsafe control (c) is the
//! variant without this step).

use crate::error::{CustodianError, Result};
use crate::guard::{lexical, PrototypeRoot};
use crate::win::{self, ProcessHandle};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The pinned engine (docs/state-system/postgresql-qualification.md).
pub const EXPECTED_ENGINE: &str = "18.6";
/// Superuser: initdb bootstrap role, migrations, custodian checks.
pub const ADMIN_ROLE: &str = "orgtree_admin";
/// The store's runtime role: login only; table rights come from migrations.
pub const RUNTIME_ROLE: &str = "orgtree_runtime";
/// Logical replication for the change feed: login + REPLICATION only.
pub const REPL_ROLE: &str = "orgtree_repl";
pub const ROLES: [&str; 3] = [ADMIN_ROLE, RUNTIME_ROLE, REPL_ROLE];
/// The application database every P03 component uses.
pub const APP_DB: &str = "orgtree";
pub const INSTANCE_SCHEMA: &str = "orgtree.p03.pg-instance/v1";
pub const RUNTIME_SCHEMA: &str = "orgtree.p03.pg-runtime/v1";
pub const LOOPBACK: &str = "127.0.0.1";
pub const ATTACH_FILE: &str = "pg-attach.json";

// ---------------------------------------------------------------- binaries

#[derive(Debug, Clone)]
pub struct PgBin {
    pub dir: PathBuf,
    pub version: String,
}

impl PgBin {
    /// Accept a `bin` folder only if every tool is present and `postgres
    /// --version` reports the pinned engine.
    pub fn locate(dir: &Path) -> Result<Self> {
        for tool in ["postgres.exe", "pg_ctl.exe", "initdb.exe", "psql.exe", "pg_controldata.exe"] {
            if !dir.join(tool).is_file() {
                return Err(CustodianError::new("bin.missing_tool", format!("{} has no {tool}", dir.display())));
            }
        }
        let out = child(&dir.join("postgres.exe"))
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| CustodianError::io("bin.run", &dir.join("postgres.exe"), e))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let version = text.strip_prefix("postgres (PostgreSQL) ").unwrap_or("").trim().to_string();
        if version != EXPECTED_ENGINE {
            return Err(CustodianError::new(
                "bin.wrong_version",
                format!("{} reports {text:?}; the pinned engine is {EXPECTED_ENGINE}", dir.display()),
            ));
        }
        Ok(Self { dir: dir.to_path_buf(), version })
    }

    pub fn exe(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.exe"))
    }
}

/// A child process with a scrubbed environment: no inherited `PG*` settings
/// (they would silently redirect a tool to another server or data folder),
/// no Orgtree agent credentials, and C messages so output is parseable.
pub fn child(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_string();
        let up = k.to_ascii_uppercase();
        if up.starts_with("PG") || up.starts_with("ORGTREE_") || up == "LANGUAGE" {
            c.env_remove(&k);
        }
    }
    c.env("LC_ALL", "C").env("LC_MESSAGES", "C").env("LANG", "C");
    c
}

// ---------------------------------------------------------------- records

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InstanceRecord {
    pub schema: String,
    pub root_id: String,
    /// `pg_control_system().system_identifier`, as decimal text.
    pub system_identifier: String,
    /// Random per-initialization token, also set as the server GUC
    /// `orgtree.instance_token`.
    pub instance_token: String,
    pub engine_version: String,
    pub admin_role: String,
    pub created_at_unix: u64,
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRecord {
    pub schema: String,
    pub root_id: String,
    pub system_identifier: String,
    pub instance_token: String,
    pub postmaster_pid: u32,
    pub host: String,
    pub port: u16,
    pub admin_role: String,
    pub pgpass_file: String,
    pub started_at_unix: u64,
    pub boot_id: String,
    /// The postmaster's creation time (FILETIME ticks): with the pid, it
    /// names exactly one process, so a reused pid cannot pass for ours.
    #[serde(default)]
    pub postmaster_created: Option<u64>,
}

impl RuntimeRecord {
    /// libpq conninfo that REQUIRES SCRAM: a server that offers trust,
    /// password or md5 instead is refused by the client before any query.
    pub fn conninfo(&self, dbname: &str) -> String {
        format!(
            "host={} port={} user={} dbname={dbname} passfile='{}' require_auth=scram-sha-256 sslmode=disable connect_timeout=5 application_name=pg-custodian",
            self.host,
            self.port,
            self.admin_role,
            self.pgpass_file.replace('\\', "\\\\").replace('\'', "\\'"),
        )
    }
}

// ---------------------------------------------------------------- layout

#[derive(Debug, Clone)]
pub struct Layout {
    pub pg: PathBuf,
    pub cluster: PathBuf,
    pub data: PathBuf,
    pub secrets: PathBuf,
    pub log: PathBuf,
    pub instance: PathBuf,
    /// Legacy name of the descriptor (custodians before the ACL change).
    pub runtime: PathBuf,
    pub attach: PathBuf,
    pub pgpass: PathBuf,
}

impl Layout {
    pub fn under(cluster: PathBuf, pg: PathBuf) -> Self {
        Self {
            data: cluster.join("data"),
            secrets: cluster.join("secrets"),
            log: cluster.join("log"),
            instance: cluster.join("instance.json"),
            runtime: cluster.join("runtime.json"),
            attach: cluster.join(ATTACH_FILE),
            pgpass: cluster.join("secrets").join("pgpass.conf"),
            cluster,
            pg,
        }
    }
    pub fn of(root: &PrototypeRoot) -> Self {
        let pg = root.path().join("pg");
        Self::under(pg.join("cluster"), pg)
    }
}

// ---------------------------------------------------------------- settings

#[derive(Debug, Clone)]
pub struct InitOptions {
    pub max_connections: u32,
    pub shared_buffers: String,
    pub max_wal_senders: u32,
    pub max_replication_slots: u32,
    pub max_slot_wal_keep_size: String,
}

impl Default for InitOptions {
    fn default() -> Self {
        // Dev values from the M1 interface contract §5 (p03-lead-opus55),
        // NOT budgets: small on purpose because several agents may each run
        // one cluster on a machine with ~5-9 GB of commit free.
        Self {
            max_connections: 40,
            shared_buffers: "64MB".into(),
            max_wal_senders: 4,
            max_replication_slots: 4,
            max_slot_wal_keep_size: "256MB".into(),
        }
    }
}

fn settings(opts: &InitOptions, root_id: &str, token: &str) -> BTreeMap<String, String> {
    let mut s = BTreeMap::new();
    let q = |v: &str| format!("'{v}'");
    s.insert("listen_addresses".into(), q(LOOPBACK));
    s.insert("unix_socket_directories".into(), q(""));
    s.insert("max_connections".into(), opts.max_connections.to_string());
    s.insert("shared_buffers".into(), q(&opts.shared_buffers));
    s.insert("wal_level".into(), q("logical"));
    s.insert("max_prepared_transactions".into(), "0".into());
    s.insert("max_wal_senders".into(), opts.max_wal_senders.to_string());
    s.insert("max_replication_slots".into(), opts.max_replication_slots.to_string());
    s.insert("max_slot_wal_keep_size".into(), q(&opts.max_slot_wal_keep_size));
    s.insert("password_encryption".into(), q("scram-sha-256"));
    s.insert("huge_pages".into(), q("off"));
    s.insert("logging_collector".into(), q("off"));
    s.insert("orgtree.instance_token".into(), q(token));
    s.insert("orgtree.root_id".into(), q(root_id));
    s
}

const HBA: &str = "# Written by orgtree pg-custodian (P03). Loopback IPv4 only, SCRAM only.\r\n\
# TYPE  DATABASE     USER  ADDRESS       METHOD\r\n\
host    all          all   127.0.0.1/32  scram-sha-256\r\n\
host    replication  all   127.0.0.1/32  scram-sha-256\r\n";

// ---------------------------------------------------------------- state

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ClusterState {
    /// No committed cluster. `quarantined` counts abandoned staging folders.
    Absent { quarantined: usize },
    /// `pg/cluster` exists but is not a complete, consistent cluster.
    Incomplete { reason: String },
    Stopped { instance: InstanceRecord },
    /// `postmaster.pid` names a live process whose image is our postgres.exe.
    /// `pm_status` is line 8 of postmaster.pid: starting, ready or STOPPING.
    Running { instance: InstanceRecord, postmaster_pid: u32, pm_status: Option<String>, runtime: Option<RuntimeRecord> },
    /// `postmaster.pid` exists but its PID is dead or is not our postgres.exe.
    StalePid { instance: InstanceRecord, pid: u32 },
}

fn quarantined(layout: &Layout) -> usize {
    fs::read_dir(&layout.pg)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("staging-"))
                .count()
        })
        .unwrap_or(0)
}

pub fn load_instance(layout: &Layout, root: &PrototypeRoot) -> Result<InstanceRecord> {
    let text = fs::read_to_string(&layout.instance)
        .map_err(|e| CustodianError::io("cluster.incomplete", &layout.instance, e))?;
    let rec: InstanceRecord = serde_json::from_str(&text)
        .map_err(|e| CustodianError::new("cluster.incomplete", format!("{}: {e}", layout.instance.display())))?;
    if rec.schema != INSTANCE_SCHEMA {
        return Err(CustodianError::new("cluster.incomplete", format!("instance schema {:?}", rec.schema)));
    }
    if rec.root_id != root.root_id() {
        return Err(CustodianError::new(
            "identity.wrong_root",
            format!("instance.json belongs to root {} but this root is {}", rec.root_id, root.root_id()),
        ));
    }
    if !layout.data.join("PG_VERSION").is_file() {
        return Err(CustodianError::new("cluster.incomplete", "data/PG_VERSION is missing"));
    }
    Ok(rec)
}

/// Line 1 of postmaster.pid (the postmaster PID) and line 4 (its port).
/// Line 8 of postmaster.pid: the postmaster's own status word.
pub fn pm_status(data: &Path) -> Option<String> {
    let text = fs::read_to_string(data.join("postmaster.pid")).ok()?;
    text.lines().nth(7).map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

pub fn read_pid_file(data: &Path) -> Option<(u32, Option<u16>)> {
    let text = fs::read_to_string(data.join("postmaster.pid")).ok()?;
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse().ok()?;
    let port = lines.nth(2).and_then(|l| l.trim().parse().ok());
    Some((pid, port))
}

pub fn state(root: &PrototypeRoot, bin: &PgBin) -> Result<ClusterState> {
    let layout = Layout::of(root);
    if !layout.cluster.exists() {
        return Ok(ClusterState::Absent { quarantined: quarantined(&layout) });
    }
    let instance = match load_instance(&layout, root) {
        Ok(i) => i,
        Err(e) if e.code == "cluster.incomplete" => return Ok(ClusterState::Incomplete { reason: e.message }),
        Err(e) => return Err(e),
    };
    match read_pid_file(&layout.data) {
        None => Ok(ClusterState::Stopped { instance }),
        Some((pid, _)) => {
            let ours = ProcessHandle::open(pid)
                .filter(|h| !h.wait_exit(0))
                .and_then(|h| h.image_path())
                .map(|p| win::same_file(&p, &bin.exe("postgres")))
                .unwrap_or(false);
            if ours {
                let runtime = fs::read_to_string(&layout.attach)
                    .or_else(|_| fs::read_to_string(&layout.runtime))
                    .ok()
                    .and_then(|t| serde_json::from_str::<RuntimeRecord>(&t).ok());
                Ok(ClusterState::Running { instance, postmaster_pid: pid, pm_status: pm_status(&layout.data), runtime })
            } else {
                Ok(ClusterState::StalePid { instance, pid })
            }
        }
    }
}

// ---------------------------------------------------------------- init

fn run_logged(mut cmd: Command, log: &Path, what: &'static str) -> Result<()> {
    let f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| CustodianError::io(what, log, e))?;
    let f2 = f.try_clone().map_err(|e| CustodianError::io(what, log, e))?;
    let status = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::from(f))
        .stderr(Stdio::from(f2))
        .status()
        .map_err(|e| CustodianError::new(what, format!("could not run: {e}")))?;
    if !status.success() {
        let tail = fs::read_to_string(log).unwrap_or_default();
        let tail: String = tail.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(CustodianError::new(what, format!("exit {status}; log {}:\n{tail}", log.display())));
    }
    Ok(())
}

pub fn system_identifier(bin: &PgBin, data: &Path) -> Result<String> {
    let out = child(&bin.exe("pg_controldata"))
        .arg("-D")
        .arg(data)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| CustodianError::new("controldata.run", e.to_string()))?;
    if !out.status.success() {
        return Err(CustodianError::new("controldata.run", String::from_utf8_lossy(&out.stderr).to_string()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("Database system identifier:") {
            let v = v.trim();
            if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
                return Ok(v.to_string());
            }
        }
    }
    Err(CustodianError::new("controldata.parse", "no 'Database system identifier' line"))
}

/// Run SQL through `postgres --single` (terminator: `;` + blank line). The
/// single-user backend keeps going after an error, so any `ERROR:` in its
/// output fails the call.
fn single_user(bin: &PgBin, data: &Path, script: &str, log: &Path) -> Result<()> {
    use std::io::Write;
    let mut proc = child(&bin.exe("postgres"))
        .arg("--single")
        .arg("-j")
        .arg("-D")
        .arg(data)
        .arg("postgres")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CustodianError::new("init.bootstrap", format!("could not run postgres --single: {e}")))?;
    proc.stdin
        .take()
        .expect("piped stdin")
        .write_all(script.as_bytes())
        .map_err(|e| CustodianError::new("init.bootstrap", e.to_string()))?;
    let out = proc.wait_with_output().map_err(|e| CustodianError::new("init.bootstrap", e.to_string()))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    // Never log the script itself: it carries passwords.
    let _ = fs::write(log, &text);
    if !out.status.success() || text.contains("ERROR:") || text.contains("FATAL:") {
        return Err(CustodianError::new("init.bootstrap", format!("exit {}; see {}", out.status, log.display())));
    }
    Ok(())
}

/// Test hook for WS1 unsafe control (c) and the kill-during-initdb drill:
/// when set, init stops after initdb and BEFORE the committing rename, as a
/// kill at that moment would.
pub const ABORT_BEFORE_COMMIT_ENV: &str = "ORGTREE_P03_CUSTODIAN_ABORT_BEFORE_COMMIT";

pub fn init(root: &PrototypeRoot, bin: &PgBin, opts: &InitOptions) -> Result<InstanceRecord> {
    let layout = Layout::of(root);
    if layout.cluster.exists() {
        return Err(CustodianError::new(
            "cluster.exists",
            format!("{} already exists; a root holds one cluster", layout.cluster.display()),
        ));
    }
    win::require_commit(0, "initdb")?;
    fs::create_dir_all(&layout.pg).map_err(|e| CustodianError::io("init.mkdir", &layout.pg, e))?;
    let staging = layout.pg.join(format!("staging-{}", win::random_hex(8)?));
    let st = Layout::under(staging.clone(), layout.pg.clone());
    for d in [&st.cluster, &st.log] {
        fs::create_dir_all(d).map_err(|e| CustodianError::io("init.mkdir", d, e))?;
    }
    // Owner-only FROM BIRTH (operator + SYSTEM + Administrators, inheritance
    // off); everything created inside inherits it.
    crate::acl::create_owner_only_dir(&st.secrets)?;
    crate::acl::require_owner_only(&st.secrets)?;

    let password = win::random_hex(32)?;
    let token = win::random_hex(16)?;
    let pwfile = st.secrets.join("initdb.pw");
    crate::acl::write_owner_only_file(&pwfile, format!("{password}\n").as_bytes())?;

    let mut cmd = child(&bin.exe("initdb"));
    cmd.arg("-D")
        .arg(&st.data)
        .arg("-U")
        .arg(ADMIN_ROLE)
        .arg(format!("--pwfile={}", pwfile.display()))
        .arg("--auth=scram-sha-256")
        .arg("--encoding=UTF8")
        .arg("--locale=C")
        .arg("--no-instructions");
    let initdb = run_logged(cmd, &st.log.join("initdb.log"), "init.initdb");
    let _ = fs::remove_file(&pwfile);
    initdb?;

    let settings = settings(opts, root.root_id(), &token);
    let mut block = String::from("\r\n# --- orgtree pg-custodian (P03); later lines win ---\r\n");
    for (k, v) in &settings {
        block.push_str(&format!("{k} = {v}\r\n"));
    }
    let conf = st.data.join("postgresql.conf");
    let mut text = fs::read_to_string(&conf).map_err(|e| CustodianError::io("init.conf", &conf, e))?;
    text.push_str(&block);
    text.push_str(QUAL_INCLUDE_LINE);
    fs::write(&conf, text).map_err(|e| CustodianError::io("init.conf", &conf, e))?;
    let hba = st.data.join("pg_hba.conf");
    fs::write(&hba, HBA).map_err(|e| CustodianError::io("init.hba", &hba, e))?;

    // The other two roles and the app database, created in single-user mode
    // so no listening server exists before the cluster is committed.
    let mut creds = BTreeMap::new();
    creds.insert(ADMIN_ROLE.to_string(), password.clone());
    creds.insert(RUNTIME_ROLE.to_string(), win::random_hex(32)?);
    creds.insert(REPL_ROLE.to_string(), win::random_hex(32)?);
    let script = format!(
        "CREATE ROLE {RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{rt}';\n\n\
         CREATE ROLE {REPL_ROLE} LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '{rp}';\n\n\
         CREATE DATABASE {APP_DB} OWNER {ADMIN_ROLE} ENCODING 'UTF8' TEMPLATE template0;\n\n\
         REVOKE ALL ON DATABASE {APP_DB} FROM PUBLIC;\n\n\
         GRANT CONNECT, TEMPORARY ON DATABASE {APP_DB} TO {RUNTIME_ROLE};\n\n\
         GRANT CONNECT ON DATABASE {APP_DB} TO {REPL_ROLE};\n\n",
        rt = creds[RUNTIME_ROLE],
        rp = creds[REPL_ROLE],
    );
    single_user(bin, &st.data, &script, &st.log.join("bootstrap.log"))?;

    let pgpass: String = creds.iter().map(|(role, pw)| format!("{LOOPBACK}:*:*:{role}:{pw}\n")).collect();
    crate::acl::write_owner_only_file(&st.pgpass, pgpass.as_bytes())?;
    let creds_json = serde_json::to_string_pretty(&creds).map_err(|e| CustodianError::new("json.encode", e.to_string()))?;
    crate::acl::write_owner_only_file(&st.secrets.join("credentials.json"), creds_json.as_bytes())?;

    let record = InstanceRecord {
        schema: INSTANCE_SCHEMA.into(),
        root_id: root.root_id().into(),
        system_identifier: system_identifier(bin, &st.data)?,
        instance_token: token,
        engine_version: bin.version.clone(),
        admin_role: ADMIN_ROLE.into(),
        created_at_unix: crate::now_unix(),
        settings,
    };
    crate::write_json_atomic(&st.instance, &record)?;

    if std::env::var_os(ABORT_BEFORE_COMMIT_ENV).is_some() {
        return Err(CustodianError::new(
            "init.aborted_before_commit",
            format!("{ABORT_BEFORE_COMMIT_ENV} set: left {} uncommitted", staging.display()),
        ));
    }
    // THE commit: one rename makes the fully built cluster current.
    fs::rename(&staging, &layout.cluster).map_err(|e| CustodianError::io("init.commit", &layout.cluster, e))?;
    Ok(record)
}

// ---------------------------------------------------------------- qualification logging

/// The switch file. Present = qualification logging configured on.
pub const QUAL_FILE: &str = "orgtree-qual-logging.conf";
/// Last line of postgresql.conf, so the switch file wins over everything.
pub const QUAL_INCLUDE_LINE: &str = "include_if_exists = 'orgtree-qual-logging.conf'\r\n";
/// Folder under the prototype root (so it is deleted with the cluster).
pub const QUAL_LOG_DIR: &str = "qual-logs";

/// The settings the switch applies (lead ruling 2026-09-25, Q-C5 hidden-access
/// check): every statement and replication command, as JSON lines, with bind
/// values NEVER written (`log_parameter_max_length*=0`). Rotation is finite:
/// one file per weekday-hour (168), truncated when the name comes round again,
/// and a file also rotates at 64MB.
pub fn qual_logging_settings(log_dir: &Path) -> BTreeMap<String, String> {
    let dir = log_dir.to_string_lossy().replace('\\', "/").replace('\'', "''");
    let mut s = BTreeMap::new();
    for (k, v) in [
        ("logging_collector", "on".to_string()),
        ("log_destination", "'jsonlog'".to_string()),
        ("log_statement", "'all'".to_string()),
        ("log_replication_commands", "on".to_string()),
        ("log_parameter_max_length", "0".to_string()),
        ("log_parameter_max_length_on_error", "0".to_string()),
        ("log_directory", format!("'{dir}'")),
        ("log_filename", "'postgresql-%a-%H.log'".to_string()),
        ("log_rotation_age", "'60min'".to_string()),
        ("log_rotation_size", "'64MB'".to_string()),
        ("log_truncate_on_rotation", "on".to_string()),
        ("log_file_mode", "0600".to_string()),
    ] {
        s.insert(k.to_string(), v);
    }
    s
}

pub fn qual_logging_configured(root: &PrototypeRoot) -> bool {
    Layout::of(root).data.join(QUAL_FILE).is_file()
}

/// Turn the switch on or off. It takes effect at the next start
/// (`logging_collector` needs a restart), so a running cluster is refused.
pub fn set_qual_logging(root: &PrototypeRoot, bin: &PgBin, on: bool) -> Result<bool> {
    match state(root, bin)? {
        ClusterState::Stopped { .. } => {}
        ClusterState::Running { .. } => {
            return Err(CustodianError::new("qual_logging.running", "stop the cluster first; the switch applies at start"))
        }
        other => return Err(CustodianError::new("cluster.not_stopped", format!("{other:?}"))),
    }
    let layout = Layout::of(root);
    let conf = layout.data.join("postgresql.conf");
    let text = fs::read_to_string(&conf).map_err(|e| CustodianError::io("qual_logging.conf", &conf, e))?;
    if !text.ends_with(QUAL_INCLUDE_LINE) {
        return Err(CustodianError::new(
            "qual_logging.no_include",
            "postgresql.conf does not end with the switch include line (cluster made by an older custodian?)",
        ));
    }
    let file = layout.data.join(QUAL_FILE);
    let before = file.is_file();
    if on {
        let dir = root.path().join(QUAL_LOG_DIR);
        fs::create_dir_all(&dir).map_err(|e| CustodianError::io("qual_logging.mkdir", &dir, e))?;
        let mut body = String::from("# orgtree pg-custodian qualification logging (P03). Delete this file to turn it off.\r\n");
        for (k, v) in qual_logging_settings(&dir) {
            body.push_str(&format!("{k} = {v}\r\n"));
        }
        fs::write(&file, body).map_err(|e| CustodianError::io("qual_logging.write", &file, e))?;
    } else if before {
        fs::remove_file(&file).map_err(|e| CustodianError::io("qual_logging.remove", &file, e))?;
    }
    Ok(before != on)
}

/// Compare what the running server does with what the switch says.
pub fn qual_logging_failures(configured: bool, server: &BTreeMap<String, String>) -> Vec<String> {
    let get = |k: &str| server.get(k).map(String::as_str).unwrap_or("<missing>");
    let mut out = Vec::new();
    if configured {
        for (k, want) in [
            ("logging_collector", "on"),
            ("log_destination", "jsonlog"),
            ("log_statement", "all"),
            ("log_replication_commands", "on"),
            ("log_parameter_max_length", "0"),
            ("log_parameter_max_length_on_error", "0"),
        ] {
            if get(k) != want {
                out.push(format!("qualification logging is on but {k}={} (want {want}; restart needed?)", get(k)));
            }
        }
    } else if get("log_statement") != "none" {
        out.push(format!("qualification logging is off but log_statement={}", get("log_statement")));
    }
    out
}

// ---------------------------------------------------------------- start

fn port_free(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn pick_port() -> Result<u16> {
    let l = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| CustodianError::new("port.pick", e.to_string()))?;
    Ok(l.local_addr().map_err(|e| CustodianError::new("port.pick", e.to_string()))?.port())
}

pub fn start(root: &PrototypeRoot, bin: &PgBin, port: Option<u16>) -> Result<RuntimeRecord> {
    let layout = Layout::of(root);
    let instance = match state(root, bin)? {
        ClusterState::Stopped { instance } => instance,
        ClusterState::StalePid { instance, pid } => {
            // PostgreSQL itself removes a lock file whose PID is dead; we
            // only record that we saw it.
            eprintln!("pg-custodian: stale postmaster.pid (pid {pid}) will be checked by postgres");
            instance
        }
        ClusterState::Running { postmaster_pid, .. } => {
            return Err(CustodianError::new(
                "cluster.already_running",
                format!("postmaster {postmaster_pid} already runs this cluster; use `identify` to attach"),
            ))
        }
        ClusterState::Absent { .. } => return Err(CustodianError::new("cluster.absent", "no cluster; run `init` first")),
        ClusterState::Incomplete { reason } => return Err(CustodianError::new("cluster.incomplete", reason)),
    };
    if instance.engine_version != bin.version {
        return Err(CustodianError::new(
            "bin.wrong_version",
            format!("cluster was made by {} but bin is {}", instance.engine_version, bin.version),
        ));
    }
    win::require_commit(0, "start")?;
    let port = match port {
        Some(p) => {
            if !port_free(p) {
                return Err(CustodianError::new("port.occupied", format!("{LOOPBACK}:{p} is already in use")));
            }
            p
        }
        None => pick_port()?,
    };

    // The postmaster outlives us; it must not inherit a caller's pipe.
    win::stop_std_handle_inheritance();
    let mut cmd = child(&bin.exe("pg_ctl"));
    cmd.arg("start")
        .arg("-D")
        .arg(&layout.data)
        .arg("-l")
        .arg(layout.log.join("postgres.log"))
        .arg("-w")
        .arg("-t")
        .arg(START_TIMEOUT_SECS.to_string())
        .arg("-o")
        .arg(format!("-p {port}"));
    run_logged(cmd, &layout.log.join("pg_ctl.log"), "start.pg_ctl")?;

    let (pid, pid_port) = read_pid_file(&layout.data)
        .ok_or_else(|| CustodianError::new("start.no_pid_file", "pg_ctl reported success but postmaster.pid is absent"))?;
    let runtime = RuntimeRecord {
        schema: RUNTIME_SCHEMA.into(),
        root_id: instance.root_id.clone(),
        system_identifier: instance.system_identifier.clone(),
        instance_token: instance.instance_token.clone(),
        postmaster_pid: pid,
        host: LOOPBACK.into(),
        port,
        admin_role: instance.admin_role.clone(),
        pgpass_file: layout.pgpass.to_string_lossy().to_string(),
        started_at_unix: crate::now_unix(),
        boot_id: win::random_hex(16)?,
        postmaster_created: win::creation_time(pid),
    };
    if pid_port != Some(port) {
        return Err(CustodianError::new(
            "start.port_mismatch",
            format!("asked for port {port}, postmaster.pid says {pid_port:?}"),
        ));
    }
    let ident = identify_at(&layout, &instance, &runtime, bin)?;
    if !ident.identity_ok() {
        return Err(CustodianError::new(
            "identity.mismatch",
            format!("server we started does not identify as ours: {:?}", ident.mismatches),
        ));
    }
    let text = serde_json::to_string_pretty(&runtime).map_err(|e| CustodianError::new("json.encode", e.to_string()))?;
    crate::acl::replace_owner_only(&layout.attach, text.as_bytes())?;
    let _ = fs::remove_file(&layout.runtime);
    Ok(runtime)
}

// ---------------------------------------------------------------- identify

#[derive(Debug, Clone, Serialize)]
pub struct Identification {
    pub system_identifier: String,
    pub data_directory: String,
    pub instance_token: String,
    pub server_version: String,
    pub settings: BTreeMap<String, String>,
    pub backend_pid: u32,
    pub current_user: String,
    /// Identity failures: the server is not the instance we own.
    pub mismatches: Vec<String>,
    /// Readiness failures: it is ours but misconfigured.
    pub readiness_failures: Vec<String>,
    /// The qualification-logging switch file is present.
    pub qual_logging_configured: bool,
    /// The server is actually logging every statement.
    pub qual_logging_effective: bool,
}

impl Identification {
    pub fn identity_ok(&self) -> bool {
        self.mismatches.is_empty()
    }
    pub fn ready(&self) -> bool {
        self.mismatches.is_empty() && self.readiness_failures.is_empty()
    }
}

const IDENT_SQL: &str = "select system_identifier::text, current_setting('data_directory'), \
coalesce(current_setting('orgtree.instance_token', true), ''), current_setting('server_version'), \
current_setting('wal_level'), current_setting('max_prepared_transactions'), current_setting('listen_addresses'), \
current_setting('max_wal_senders'), current_setting('max_replication_slots'), current_setting('max_slot_wal_keep_size'), \
current_setting('password_encryption'), pg_backend_pid()::text, current_user from pg_control_system()";

/// Run one query through psql with the custodian's SCRAM-only conninfo and
/// return the rows, fields split on U+001F.
pub fn psql(bin: &PgBin, runtime: &RuntimeRecord, dbname: &str, sql: &str) -> Result<Vec<Vec<String>>> {
    let out = child(&bin.exe("psql"))
        .arg("-X")
        .arg("-q")
        .arg("-A")
        .arg("-t")
        .arg("-w")
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("-F")
        .arg("\u{1f}")
        .arg("-d")
        .arg(runtime.conninfo(dbname))
        .arg("-c")
        .arg(sql)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| CustodianError::new("psql.run", e.to_string()))?;
    if !out.status.success() {
        return Err(CustodianError::new(
            "psql.failed",
            format!("{}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim()),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.split('\u{1f}').map(str::to_string).collect())
        .collect())
}

/// Run a script through psql on stdin (`-f -`), stopping at the first error;
/// with `single_tx` the whole script is one transaction (`-1`), so an error
/// rolls all of it back.
pub fn psql_stdin(bin: &PgBin, runtime: &RuntimeRecord, dbname: &str, script: &str, single_tx: bool) -> Result<String> {
    use std::io::Write;
    let mut cmd = child(&bin.exe("psql"));
    cmd.args(["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"]);
    if single_tx {
        cmd.arg("-1");
    }
    let mut proc = cmd
        .arg("-d")
        .arg(runtime.conninfo(dbname))
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CustodianError::new("psql.run", e.to_string()))?;
    let mut stdin = proc.stdin.take().expect("piped stdin");
    let body = script.to_string();
    // Write on a thread so a large script cannot deadlock against output.
    let writer = std::thread::spawn(move || stdin.write_all(body.as_bytes()));
    let out = proc.wait_with_output().map_err(|e| CustodianError::new("psql.run", e.to_string()))?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(CustodianError::new(
            "psql.failed",
            format!("{}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim()),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub fn identify_at(layout: &Layout, instance: &InstanceRecord, runtime: &RuntimeRecord, bin: &PgBin) -> Result<Identification> {
    let rows = psql(bin, runtime, "postgres", IDENT_SQL)?;
    let row = rows.first().filter(|r| r.len() == 13).ok_or_else(|| {
        CustodianError::new("identify.parse", format!("unexpected identify output: {rows:?}"))
    })?;
    let names = [
        "wal_level",
        "max_prepared_transactions",
        "listen_addresses",
        "max_wal_senders",
        "max_replication_slots",
        "max_slot_wal_keep_size",
        "password_encryption",
    ];
    let settings: BTreeMap<String, String> =
        names.iter().zip(&row[4..11]).map(|(k, v)| (k.to_string(), v.clone())).collect();
    let mut id = Identification {
        system_identifier: row[0].clone(),
        data_directory: row[1].clone(),
        instance_token: row[2].clone(),
        server_version: row[3].clone(),
        settings,
        backend_pid: row[11].parse().unwrap_or(0),
        current_user: row[12].clone(),
        mismatches: vec![],
        readiness_failures: vec![],
        qual_logging_configured: false,
        qual_logging_effective: false,
    };
    if id.system_identifier != instance.system_identifier {
        id.mismatches.push(format!(
            "system_identifier {} != instance {}",
            id.system_identifier, instance.system_identifier
        ));
    }
    if id.instance_token != instance.instance_token {
        id.mismatches.push("orgtree.instance_token does not match instance.json".into());
    }
    let ours = crate::guard::resolved(&layout.data)?;
    let theirs = lexical(Path::new(&id.data_directory)).unwrap_or_default();
    if theirs != ours {
        id.mismatches.push(format!("data_directory {} is not {ours}", id.data_directory));
    }
    if !(id.server_version == instance.engine_version || id.server_version.starts_with(&format!("{} ", instance.engine_version))) {
        id.mismatches.push(format!("server_version {} != {}", id.server_version, instance.engine_version));
    }
    id.readiness_failures = readiness_failures(&id.settings);

    // Role privileges: exactly the attributes each role is meant to have.
    let roles = psql(
        bin,
        runtime,
        "postgres",
        &format!(
            "select rolname, rolsuper, rolreplication, rolcreatedb, rolcreaterole, rolcanlogin, rolbypassrls, \
             coalesce(rolpassword like 'SCRAM-SHA-256$%', false) from pg_authid where rolname in ('{ADMIN_ROLE}','{RUNTIME_ROLE}','{REPL_ROLE}') order by 1"
        ),
    )?;
    id.readiness_failures.extend(role_failures(&roles));
    let db = psql(bin, runtime, "postgres", &format!("select count(*) from pg_database where datname = '{APP_DB}'"))?;
    if db != vec![vec!["1".to_string()]] {
        id.readiness_failures.push(format!("database {APP_DB} is missing"));
    }

    let names = [
        "logging_collector",
        "log_destination",
        "log_statement",
        "log_replication_commands",
        "log_parameter_max_length",
        "log_parameter_max_length_on_error",
    ];
    let sql = format!("select {}", names.map(|n| format!("current_setting('{n}')")).join(", "));
    let row = psql(bin, runtime, "postgres", &sql)?.into_iter().next().unwrap_or_default();
    let server: BTreeMap<String, String> = names.iter().map(|n| n.to_string()).zip(row).collect();
    id.qual_logging_configured = layout.data.join(QUAL_FILE).is_file();
    id.readiness_failures.extend(qual_logging_failures(id.qual_logging_configured, &server));
    id.qual_logging_effective = server.get("log_statement").map(String::as_str) == Some("all");
    Ok(id)
}

/// Per-role connection URLs for a running, identified cluster, keyed by the
/// environment variable names of the M1 contract §5. The password is in the
/// URL because Rust drivers read no passfile; the server enforces SCRAM.
pub fn urls(root: &PrototypeRoot, runtime: &RuntimeRecord) -> Result<BTreeMap<String, String>> {
    let layout = Layout::of(root);
    let path = layout.secrets.join("credentials.json");
    let text = fs::read_to_string(&path).map_err(|e| CustodianError::io("secrets.read", &path, e))?;
    let creds: BTreeMap<String, String> =
        serde_json::from_str(&text).map_err(|e| CustodianError::new("secrets.read", e.to_string()))?;
    let mut out = BTreeMap::new();
    for (var, role) in [("P03_PG_ADMIN_URL", ADMIN_ROLE), ("P03_PG_RUNTIME_URL", RUNTIME_ROLE), ("P03_PG_REPL_URL", REPL_ROLE)] {
        let pw = creds.get(role).ok_or_else(|| CustodianError::new("secrets.read", format!("no password for {role}")))?;
        out.insert(var.to_string(), format!("postgresql://{role}:{pw}@{}:{}/{APP_DB}?sslmode=disable", runtime.host, runtime.port));
    }
    Ok(out)
}

/// Readiness settings (v6/BUNDLED-DATABASE-SERVICE.md:84), as reported by
/// the server. The slot/sender budget is checked as "configured, non-zero and
/// finite". Role privileges are checked by `identify_at`; the publication
/// allowlist arrives with WS6's catalog. A missing setting is a failure.
pub fn readiness_failures(s: &BTreeMap<String, String>) -> Vec<String> {
    let get = |k: &str| s.get(k).map(String::as_str).unwrap_or("<missing>");
    let mut out = Vec::new();
    let mut need = |cond: bool, msg: String| {
        if !cond {
            out.push(msg);
        }
    };
    let positive = |k: &str| get(k).parse::<u32>().map(|n| n > 0).unwrap_or(false);
    need(get("max_prepared_transactions") == "0", format!("max_prepared_transactions={} (must be 0)", get("max_prepared_transactions")));
    need(get("wal_level") == "logical", format!("wal_level={} (must be logical)", get("wal_level")));
    need(get("listen_addresses") == LOOPBACK, format!("listen_addresses={} (must be {LOOPBACK})", get("listen_addresses")));
    let keep = get("max_slot_wal_keep_size");
    need(keep != "-1" && keep != "<missing>", format!("max_slot_wal_keep_size={keep} (must be finite)"));
    need(positive("max_wal_senders"), format!("max_wal_senders={}", get("max_wal_senders")));
    need(positive("max_replication_slots"), format!("max_replication_slots={}", get("max_replication_slots")));
    need(get("password_encryption") == "scram-sha-256", format!("password_encryption={}", get("password_encryption")));
    out
}

/// Role privileges (v6 BUNDLED:78): each role has EXACTLY its attributes.
/// Rows: `rolname, rolsuper, rolreplication, rolcreatedb, rolcreaterole,
/// rolcanlogin, rolbypassrls, password-is-SCRAM`, as psql prints booleans.
pub fn role_failures(rows: &[Vec<String>]) -> Vec<String> {
    const COLS: &str = "(super,repl,createdb,createrole,login,bypassrls,scram)";
    let expect = |name: &str| -> [&str; 7] {
        match name {
            ADMIN_ROLE => ["t", "t", "t", "t", "t", "t", "t"],
            // The store's runtime role: login, and nothing else at all.
            RUNTIME_ROLE => ["f", "f", "f", "f", "t", "f", "t"],
            _ => ["f", "t", "f", "f", "t", "f", "t"],
        }
    };
    let mut out = Vec::new();
    for role in ROLES {
        match rows.iter().find(|r| r.first().map(String::as_str) == Some(role)) {
            None => out.push(format!("role {role} is missing")),
            Some(r) => {
                let got: Vec<&str> = r.iter().skip(1).map(String::as_str).collect();
                if got != expect(role) {
                    out.push(format!("role {role} attributes {COLS} = {got:?}, expected {:?}", expect(role)));
                }
            }
        }
    }
    out
}

/// Identify the server the runtime record points at. Refuses unless the
/// cluster is Running per its own lock file.
pub fn identify(root: &PrototypeRoot, bin: &PgBin) -> Result<(RuntimeRecord, Identification)> {
    let layout = Layout::of(root);
    match state(root, bin)? {
        ClusterState::Running { instance, runtime: Some(runtime), postmaster_pid, .. } => {
            if runtime.postmaster_pid != postmaster_pid {
                return Err(CustodianError::new(
                    "identify.stale_runtime",
                    format!("runtime.json names pid {} but postmaster.pid names {postmaster_pid}", runtime.postmaster_pid),
                ));
            }
            // The pid in the descriptor names exactly one process only
            // together with its creation time.
            if let Some(want) = runtime.postmaster_created {
                if win::creation_time(postmaster_pid) != Some(want) {
                    return Err(CustodianError::new(
                        "identify.postmaster_replaced",
                        format!("pid {postmaster_pid} is not the postmaster the descriptor recorded (creation time differs)"),
                    ));
                }
            }
            let mut id = identify_at(&layout, &instance, &runtime, bin)?;
            // Secrets and the descriptor must be owner-only (fails readiness,
            // so a cluster made by an older custodian still identifies).
            for (what, path) in [("secrets folder", &layout.secrets), ("attach descriptor", &layout.attach)] {
                if let Err(e) = crate::acl::require_owner_only(path) {
                    id.readiness_failures.push(format!("{what} is not owner-only: {}", e.message));
                }
            }
            if runtime.postmaster_created.is_none() {
                id.readiness_failures.push("attach descriptor lacks the postmaster creation time (made by an older custodian)".into());
            }
            Ok((runtime, id))
        }
        ClusterState::Running { .. } => Err(CustodianError::new(
            "identify.no_runtime",
            "the cluster runs but runtime.json is missing: it was not started by this custodian",
        )),
        other => Err(CustodianError::new("cluster.not_running", format!("{other:?}"))),
    }
}

/// Attach from a second window or a second host: the ONLY way to reuse a
/// running instance. It trusts nothing it can merely observe (a port that
/// answers, a pid that is alive): the descriptor must be owner-only, the pid
/// with its creation time must be the postmaster of THIS root's data folder,
/// and the server must prove over SCRAM that it has this instance's
/// system_identifier, token and data directory. Readiness must hold too.
/// WS1 unsafe control (a) is the variant that trusts port and pid alone.
pub fn attach(root: &PrototypeRoot, bin: &PgBin) -> Result<(RuntimeRecord, Identification)> {
    let layout = Layout::of(root);
    if !layout.attach.is_file() {
        return Err(CustodianError::new("attach.no_descriptor", format!("{} is missing: nothing to attach to", layout.attach.display())));
    }
    crate::acl::require_owner_only(&layout.attach)?;
    let (rt, id) = identify(root, bin)?;
    if !id.identity_ok() {
        return Err(CustodianError::new("identity.mismatch", format!("{:?}", id.mismatches)));
    }
    if !id.ready() {
        return Err(CustodianError::new("attach.not_ready", format!("{:?}", id.readiness_failures)));
    }
    Ok((rt, id))
}

// ---------------------------------------------------------------- stop

#[derive(Debug, Clone, Serialize)]
pub struct FamilyMember {
    pub pid: u32,
    pub exe_name: String,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub terminated_by_custodian: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StopReport {
    pub was_running: bool,
    pub postmaster_pid: Option<u32>,
    pub mode: String,
    pub family: Vec<FamilyMember>,
    pub pid_file_removed: bool,
    pub elapsed_ms: u128,
}

/// The owned process family: the postmaster, every descendant, and the
/// `cmd.exe` shim `pg_ctl` wraps it in on Windows (plus the shim's own
/// descendants, e.g. conhost). Handles are opened NOW, before the stop.
fn family(postmaster: u32) -> Result<Vec<(win::ProcessInfo, Option<ProcessHandle>)>> {
    let snap = win::snapshot()?;
    let set = win::family_pids(&snap, postmaster);
    Ok(snap
        .into_iter()
        .filter(|p| set.contains(&p.pid))
        .map(|p| {
            let h = ProcessHandle::open(p.pid);
            (p, h)
        })
        .collect())
}

/// Default patience for a stop. A fast shutdown ends with a checkpoint that
/// fsyncs every file touched since the last one; under disk contention that
/// measured 173 s on WS2's dev cluster (2026-09-25), so a short limit reports
/// a healthy shutdown as a failure.
pub const STOP_TIMEOUT_SECS: u64 = 600;
/// Patience for `pg_ctl start -w` (crash recovery can be slow too).
pub const START_TIMEOUT_SECS: u64 = 300;

pub fn stop(root: &PrototypeRoot, bin: &PgBin, immediate: bool, force: bool) -> Result<StopReport> {
    stop_with(root, bin, immediate, force, Duration::from_secs(STOP_TIMEOUT_SECS))
}

pub fn stop_with(root: &PrototypeRoot, bin: &PgBin, immediate: bool, force: bool, timeout: Duration) -> Result<StopReport> {
    let layout = Layout::of(root);
    let t0 = Instant::now();
    let mode = if immediate { "immediate" } else { "fast" };
    let (pm_pid, instance) = match state(root, bin)? {
        ClusterState::Running { postmaster_pid, instance, .. } => (postmaster_pid, instance),
        ClusterState::Stopped { .. } | ClusterState::Absent { .. } => {
            let _ = fs::remove_file(&layout.runtime);
            let _ = fs::remove_file(&layout.attach);
            return Ok(StopReport {
                was_running: false,
                postmaster_pid: None,
                mode: mode.into(),
                family: vec![],
                pid_file_removed: !layout.data.join("postmaster.pid").exists(),
                elapsed_ms: t0.elapsed().as_millis(),
            });
        }
        ClusterState::StalePid { pid, .. } => {
            return Err(CustodianError::new(
                "stop.stale_pid",
                format!("postmaster.pid names pid {pid}, which is not our running postgres.exe; nothing was signalled"),
            ))
        }
        ClusterState::Incomplete { reason } => return Err(CustodianError::new("cluster.incomplete", reason)),
    };
    let _ = instance;
    let fam = family(pm_pid)?;
    let our_postgres = bin.exe("postgres");
    let pm_ok = fam
        .iter()
        .find(|(p, _)| p.pid == pm_pid)
        .and_then(|(_, h)| h.as_ref())
        .and_then(|h| h.image_path())
        .map(|p| win::same_file(&p, &our_postgres))
        .unwrap_or(false);
    if !pm_ok {
        return Err(CustodianError::new("stop.foreign_postmaster", format!("pid {pm_pid} is not {}", our_postgres.display())));
    }

    let mut cmd = child(&bin.exe("pg_ctl"));
    cmd.arg("stop").arg("-D").arg(&layout.data).arg("-m").arg(mode).arg("-w").arg("-t").arg(timeout.as_secs().max(1).to_string());
    let stop_result = run_logged(cmd, &layout.log.join("pg_ctl.log"), "stop.pg_ctl");

    // pg_ctl may give up while the shutdown is still healthy; the family
    // handles are the authority, waited on until the same deadline.
    let deadline = t0 + timeout + Duration::from_secs(5);
    let mut members = Vec::new();
    for (p, h) in &fam {
        let left = deadline.saturating_duration_since(Instant::now()).as_millis() as u32;
        let (exited, code) = match h {
            Some(h) => {
                let ex = h.wait_exit(left);
                (ex, if ex { h.exit_code() } else { None })
            }
            // Could not open it even before the stop: it had already exited.
            None => (true, None),
        };
        members.push(FamilyMember { pid: p.pid, exe_name: p.exe_name.clone(), exited, exit_code: code, terminated_by_custodian: false });
    }
    if force {
        for (m, (_, h)) in members.iter_mut().zip(&fam) {
            if m.exited {
                continue;
            }
            if let Some(h) = h {
                let is_ours = h.image_path().map(|p| win::same_file(&p, &our_postgres)).unwrap_or(false);
                if is_ours && h.terminate() {
                    m.terminated_by_custodian = true;
                    m.exited = h.wait_exit(5000);
                    m.exit_code = h.exit_code();
                }
            }
        }
    }
    let report = StopReport {
        was_running: true,
        postmaster_pid: Some(pm_pid),
        mode: mode.into(),
        pid_file_removed: !layout.data.join("postmaster.pid").exists(),
        family: members,
        elapsed_ms: t0.elapsed().as_millis(),
    };
    let alive: Vec<u32> = report.family.iter().filter(|m| !m.exited).map(|m| m.pid).collect();
    if !alive.is_empty() {
        return Err(CustodianError::new(
            "stop.family_alive",
            format!("owned processes still alive after stop: {alive:?}; report: {}", serde_json::to_string(&report).unwrap_or_default()),
        ));
    }
    if let Err(e) = stop_result {
        if !report.pid_file_removed {
            return Err(e);
        }
    }
    let _ = fs::remove_file(&layout.runtime);
    let _ = fs::remove_file(&layout.attach);
    Ok(report)
}

// ---------------------------------------------------------------- destroy

/// Delete a stopped prototype root entirely (marker included). Only a
/// validated root can reach here, so this cannot delete anything the guard
/// did not accept.
pub fn destroy(root: &PrototypeRoot, bin: &PgBin) -> Result<()> {
    if let ClusterState::Running { postmaster_pid, .. } = state(root, bin)? {
        return Err(CustodianError::new("destroy.running", format!("postmaster {postmaster_pid} still runs; stop first")));
    }
    fs::remove_dir_all(root.path()).map_err(|e| CustodianError::io("destroy.remove", root.path(), e))
}
