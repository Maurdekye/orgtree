//! The bundled mail hub: the pinned orgtree-mailhub product (v2: one binary,
//! `orgtree-mailhub.exe serve`, configured through its own `HUB_*`
//! variables), run as a child of this engine. Its records live in its own
//! database of the engine's PostgreSQL cluster (role and database
//! `orgtree_mailhub`, made once, docs/rust-engine/mailhub-v2-hosting.md);
//! its settings in `<data>/mailhub-hosting.json` and its files in
//! `<data>/mailhub`: the same folder the earlier hubs used, whose
//! `hub.sqlite3` v2 imports at its first start (keeping the file).
//!
//! The engine's job object ends the child with the engine. A pid file is
//! never used to kill anything: in a copied data folder it names someone
//! else's process.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::{ArcSwap, ArcSwapOption};
use serde_json::{json, Map, Value};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;

pub const DEFAULT_PORT: u16 = 7370;
pub const DEFAULT_ATTACHMENT_MAX: u64 = 1024 * 1024 * 1024;
/// the hub's relay-only public listener (its default `HUB_PUBLIC_PORT`)
pub const PUBLIC_LISTENER_PORT: u16 = 7371;
/// who may reach the relay-only door (`public_scope`)
pub const PUBLIC_SCOPES: [&str; 3] = ["tailnet", "lan", "all"];
/// the longest retention the settings accept
const KEEP_FOREVER_DAYS: i64 = 36500;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// The hub's own login role and database in the engine's cluster.
pub const HUB_ROLE: &str = "orgtree_mailhub";
pub const HUB_DB: &str = "orgtree_mailhub";
/// Connections the hub may hold (the cluster allows 200; the engine's pool
/// keeps the rest).
const HUB_DB_POOL: &str = "8";

/// Where the hub keeps its records: the connection URL (no password in it)
/// and the role's password, which only ever travels in the child's
/// environment. Never printed whole.
pub struct HubDb {
    url: String,
    password: String,
}

impl std::fmt::Debug for HubDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HubDb").field("url", &self.url).field("password", &"*****").finish()
    }
}

#[derive(Clone, Debug, Default)]
pub struct HubState {
    pub running: bool,
    pub healthy: bool,
    pub port: u16,
    pub exposed: bool,
    pub error: Option<String>,
    /// where the relay-only door listens (None: closed)
    pub door: Option<String>,
    /// the door is for the Tailscale network only, but this PC has no
    /// Tailscale address yet: it opens when one appears (`phone::reconcile_door`)
    pub door_waiting: bool,
}

/// The running child: `stop` asks it to end, `exited` says it has.
struct Run {
    stop: CancellationToken,
    exited: CancellationToken,
}

#[derive(Default)]
pub struct MailHub {
    pub state: ArcSwap<HubState>,
    config: ArcSwap<Value>,
    run: ArcSwapOption<Run>,
    /// where the hub answers once healthy: the org client's local hub
    pub address: ArcSwapOption<String>,
    /// the hub's database, prepared once at the engine's start
    db: ArcSwapOption<HubDb>,
    /// why it could not be prepared, for the settings page
    db_error: ArcSwapOption<String>,
    /// one stop-and-start at a time (settings saved, the door's address moved)
    lifecycle: tokio::sync::Mutex<()>,
}

#[logged]
impl MailHub {
    /// The desktop's tray line (`/api/desktop/status`).
    pub fn status(&self) -> Value {
        let s = self.state.load();
        let mut v = json!({ "running": s.running, "healthy": s.healthy, "port": s.port, "exposed": s.exposed });
        if let Some(e) = &s.error {
            v["error"] = json!(e);
        }
        v
    }

    /// The saved hosting settings.
    pub fn hosting_config(&self) -> Arc<Value> {
        self.config.load_full()
    }

    fn set(&self, f: impl Fn(&mut HubState)) {
        self.state.rcu(|cur| {
            let mut s = HubState::clone(cur);
            f(&mut s);
            s
        });
    }
}

/// The copied data of a scratch run holds real identities and a real hub
/// store: it never hosts the hub (or reaches any hub).
#[logged]
pub fn safe_start() -> bool {
    std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() == Ok("1")
}

/// Whether this run hosts the hub: never in a safe start, except a rig run
/// that asked for its own loopback hub (`rig::hub`).
#[logged]
pub fn hosts() -> bool {
    !safe_start() || crate::rig::hub()
}

/// Before the hub's first start: its login role and its own database in the
/// engine's cluster, made once (the engine holds the cluster's admin role),
/// the role's password kept with the cluster's other secrets. Any other
/// login role is kept out of the engine's database. A failure is shown in
/// the hub's settings, never stops the engine.
#[nolog]
pub async fn prepare_database(engine: &Engine, cluster: &crate::pg::Cluster) {
    if !hosts() {
        return;
    }
    match ensure_database(cluster).await {
        Ok(db) => engine.hub.db.store(Some(Arc::new(db))),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "the mail hub's database could not be prepared");
            engine.hub.db_error.store(Some(Arc::new(format!("the mail hub's database could not be prepared: {e:#}"))));
        }
    }
}

#[nolog]
async fn ensure_database(cluster: &crate::pg::Cluster) -> anyhow::Result<HubDb> {
    let creds_file = cluster.cluster_dir.join("secrets").join("credentials.json");
    let mut creds: Value =
        std::fs::read_to_string(&creds_file).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let stored = creds.get(HUB_ROLE).and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string);
    let (client, conn) = cluster.connect_config("postgres").connect(tokio_postgres::NoTls).await?;
    let task = tokio::spawn(conn);
    let made = async {
        let role = client.query_opt("SELECT 1 FROM pg_roles WHERE rolname = $1", &[&HUB_ROLE]).await?.is_some();
        let password = match (stored, role) {
            (Some(p), true) => p,
            _ => {
                let p = crate::util::random_hex(32);
                // kept before the role takes it: a start cut short in between
                // sets it again next time
                creds[HUB_ROLE] = json!(p);
                let tmp = creds_file.with_extension("tmp");
                std::fs::write(&tmp, serde_json::to_vec_pretty(&creds)?)?;
                std::fs::rename(&tmp, &creds_file)?;
                // hex, so no quoting is needed (PASSWORD takes no parameter)
                let verb = if role { "ALTER" } else { "CREATE" };
                client.batch_execute(&format!("{verb} ROLE {HUB_ROLE} LOGIN PASSWORD '{p}'")).await?;
                p
            }
        };
        if client.query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&HUB_DB]).await?.is_none() {
            client
                .batch_execute(&format!(
                    "CREATE DATABASE {HUB_DB} OWNER {HUB_ROLE} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
                ))
                .await?;
        }
        client.batch_execute(&format!("REVOKE CONNECT ON DATABASE {} FROM PUBLIC", crate::pg::ENGINE_DB)).await?;
        anyhow::Ok(HubDb { url: format!("postgres://{HUB_ROLE}@127.0.0.1:{}/{HUB_DB}", cluster.port), password })
    }
    .await;
    drop(client);
    task.abort();
    made
}

fn default_config() -> Value {
    json!({ "version": 2, "port": DEFAULT_PORT, "bind": "127.0.0.1", "name": "", "retention_days": null,
            "org_retention_days": 45, "public_listener": false, "public_scope": "all", "max_attachment_bytes": DEFAULT_ATTACHMENT_MAX })
}

/// The hosting settings on the hub's own model: port, bind, name, retention.
#[logged]
pub fn validate(raw: &Value) -> Result<Value, String> {
    let Some(o) = raw.as_object() else { return Err("hub hosting configuration must be an object".into()) };
    if o.get("version").map(|v| v != &json!(2)).unwrap_or(false) {
        return Err("unsupported hub hosting configuration version".into());
    }
    let port = match o.get("port") {
        None => DEFAULT_PORT as i64,
        Some(v) => v.as_i64().filter(|p| (1..=65535).contains(p)).ok_or("port must be an integer between 1 and 65535")?,
    };
    let bind = o.get("bind").and_then(Value::as_str).unwrap_or("127.0.0.1");
    if bind != "127.0.0.1" && bind != "0.0.0.0" {
        return Err("bind must be 127.0.0.1 or 0.0.0.0".into());
    }
    let name = o.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name.contains(['\r', '\n', '\0']) {
        return Err("name must be a single line".into());
    }
    let retention = match o.get("retention_days") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => json!(v
            .as_i64()
            .filter(|d| (1..=KEEP_FOREVER_DAYS).contains(d))
            .ok_or("retention_days must be null (keep forever) or an integer number of days")?),
    };
    let org_retention = match o.get("org_retention_days") {
        None => 45,
        Some(v) => v.as_i64().filter(|d| (1..=3650).contains(d)).ok_or("org_retention_days must be an integer number of days")?,
    };
    let public = match o.get("public_listener") {
        None => false,
        Some(v) => v.as_bool().ok_or("public_listener must be a boolean")?,
    };
    // who may reach the door: "tailnet" (bound to this PC's Tailscale
    // address), "lan" (every address, the firewall rule limited to the local
    // subnet) or "all" (every address; what the switch did before 4.1)
    let scope = match o.get("public_scope") {
        None | Some(Value::Null) => "all",
        Some(v) => v.as_str().filter(|s| PUBLIC_SCOPES.contains(s)).ok_or("public_scope must be tailnet, lan or all")?,
    };
    let attachment_max = match o.get("max_attachment_bytes") {
        None => DEFAULT_ATTACHMENT_MAX,
        Some(v) => v.as_u64().filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
            .ok_or("max_attachment_bytes must be a positive safe integer number of bytes")?,
    };
    let mut out = json!({ "version": 2, "port": port, "bind": bind, "name": name, "retention_days": retention,
                          "org_retention_days": org_retention, "public_listener": public, "public_scope": scope,
                          "max_attachment_bytes": attachment_max });
    if let Some(m) = o.get("migrated").filter(|m| m.is_object()) {
        out["migrated"] = m.clone();
    }
    Ok(out)
}

fn config_path(engine: &Engine) -> PathBuf {
    engine.cfg.path("mailhub-hosting.json")
}

fn data_dir(engine: &Engine) -> PathBuf {
    engine.cfg.path("mailhub")
}

#[logged]
fn load_config(engine: &Engine) -> Value {
    let path = config_path(engine);
    match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(v) => validate(&v).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "mailhub-hosting.json is invalid; using the defaults until it is saved again");
            default_config()
        }),
        None => {
            let d = default_config();
            let _ = save_config(engine, &d);
            d
        }
    }
}

#[logged]
fn save_config(engine: &Engine, config: &Value) -> std::io::Result<()> {
    let path = config_path(engine);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(config).unwrap_or_default() + "\n")?;
    std::fs::rename(&tmp, &path)
}

/// Shared with the child through a path, never a remotely writable admin route.
#[logged]
fn save_upload_limit(engine: &Engine, config: &Value) -> std::io::Result<()> {
    let path = engine.cfg.path("mailhub-upload-limit.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json!({"max_attachment_bytes":config["max_attachment_bytes"]}).to_string())?;
    std::fs::rename(tmp, path)
}

/// The hub's binary: `ORGTREE_HUB_BIN`, beside the engine in a package
/// (`resources/engine/orgtree-mailhub.exe`), or the pinned submodule's own
/// release build in development (`engine/mailhub/target/release`).
#[logged]
fn hub_binary() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let up = |d: &PathBuf| d.join("..").join("..").join("..");
    std::env::var_os("ORGTREE_HUB_BIN")
        .map(PathBuf::from)
        .into_iter()
        .chain(exe_dir.iter().map(|d| d.join(crate::util::exe_name("orgtree-mailhub"))))
        .chain(exe_dir.iter().map(|d| up(d).join("mailhub").join("target").join("release").join(crate::util::exe_name("orgtree-mailhub"))))
        .find(|p| p.is_file())
        .ok_or_else(|| format!("the mail hub ({}) was not found beside the engine", crate::util::exe_name("orgtree-mailhub")))
}

#[logged]
pub async fn healthz(address: &str, timeout: Duration) -> Option<Value> {
    let client = reqwest::Client::builder().timeout(timeout).no_proxy().build().ok()?;
    let r = client.get(format!("{address}/healthz")).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().await.ok().filter(Value::is_object)
}

/// Host the hub in the background (never delays the engine's start).
#[logged]
pub async fn start(engine: &Arc<Engine>) {
    engine.hub.config.store(Arc::new(load_config(engine)));
    let eng = engine.clone();
    tokio::spawn(async move {
        start_now(&eng).await;
    });
}

#[logged]
async fn start_now(engine: &Arc<Engine>) {
    let hub = &engine.hub;
    if hub.run.load().is_some() {
        return;
    }
    let cfg = hub.config.load_full();
    let port = cfg["port"].as_u64().unwrap_or(DEFAULT_PORT as u64) as u16;
    let bind = cfg["bind"].as_str().unwrap_or("127.0.0.1").to_string();
    hub.set(|s| {
        *s = HubState { running: false, healthy: false, port, exposed: bind == "0.0.0.0", ..Default::default() };
    });
    if !hosts() {
        hub.set(|s| s.error = Some("the mail hub is not hosted while the engine runs in safe start".into()));
        return;
    }
    if let Err(e) = save_upload_limit(engine, &cfg) {
        hub.set(|s| s.error = Some(format!("could not save the hub upload limit: {e}")));
        return;
    }
    let bin = match hub_binary() {
        Ok(p) => p,
        Err(e) => {
            hub.set(|s| s.error = Some(e.clone()));
            return;
        }
    };
    let Some(db) = hub.db.load_full() else {
        let why = hub.db_error.load_full().map(|e| e.as_str().to_string()).unwrap_or_else(|| "the mail hub's database is not ready".into());
        hub.set(|s| s.error = Some(why.clone()));
        return;
    };
    let data = data_dir(engine);
    if let Err(e) = std::fs::create_dir_all(&data) {
        hub.set(|s| s.error = Some(format!("could not create the hub's data folder: {e}")));
        return;
    }
    let log_path = data.join("hub.log");
    if std::fs::metadata(&log_path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&log_path, data.join("hub.log.1"));
    }
    let log = match std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(f) => f,
        Err(e) => {
            hub.set(|s| s.error = Some(format!("could not open mailhub/hub.log: {e}")));
            return;
        }
    };
    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .current_dir(&data)
        .env("HUB_DATA", &data)
        .env("HUB_PORT", port.to_string())
        .env("HUB_BIND", &bind)
        .env("HUB_NAME", cfg["name"].as_str().unwrap_or(""))
        .env("HUB_MAX_FILE_BYTES", cfg["max_attachment_bytes"].to_string())
        .env("HUB_RUNTIME_CONFIG_FILE", engine.cfg.path("mailhub-upload-limit.json"))
        .env("HUB_DATABASE_URL", &db.url)
        .env("HUB_DATABASE_PASSWORD", &db.password)
        .env("HUB_DB_POOL", HUB_DB_POOL)
        // mail is kept until its owners delete it unless the user chose a
        // number of days, and an idle address stays listed (rulings 8 October)
        .env_remove("HUB_RETENTION_DAYS")
        .env_remove("HUB_ORG_RETENTION_DAYS")
        .env_remove("ORGTREE_V2_TOKEN")
        .env_remove("ORGTREE_DATA")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    match log.try_clone() {
        Ok(out) => {
            cmd.stdout(out).stderr(log);
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    if let Some(days) = cfg["retention_days"].as_i64() {
        cmd.env("HUB_RETENTION_DAYS", days.to_string());
    }
    match door_bind(engine, &cfg).await {
        Some(at) => {
            cmd.env("HUB_PUBLIC", "1").env("HUB_PUBLIC_BIND", &at);
            hub.set(|s| s.door = Some(at.clone()));
        }
        None => {
            cmd.env_remove("HUB_PUBLIC").env_remove("HUB_PUBLIC_BIND");
            let waiting = cfg["public_listener"].as_bool().unwrap_or(false);
            hub.set(|s| s.door_waiting = waiting);
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            hub.set(|s| s.error = Some(format!("could not start the hub process: {e}")));
            return;
        }
    };
    let run = Arc::new(Run { stop: CancellationToken::new(), exited: CancellationToken::new() });
    hub.run.store(Some(run.clone()));
    hub.set(|s| s.running = true);
    let pid = child.id().unwrap_or(0);
    tracing::info!(pid, port, bin = %bin.display(), "mail hub started");
    // the watcher owns the child: it ends it on stop, and notices an exit
    let eng = engine.clone();
    let watch = run.clone();
    tokio::spawn(async move {
        let code = tokio::select! {
            r = child.wait() => r.ok().and_then(|s| s.code()),
            _ = watch.stop.cancelled() => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                None
            }
        };
        let asked = watch.stop.is_cancelled();
        eng.hub.address.store(None);
        eng.hub.set(|s| {
            s.running = false;
            s.healthy = false;
            if !asked {
                s.error = Some(format!(
                    "the hub process exited (code {}) — see mailhub/hub.log; another service may already hold port {}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                    s.port
                ));
            }
        });
        if eng.hub.run.load().as_ref().map(|r| Arc::ptr_eq(r, &watch)).unwrap_or(false) {
            eng.hub.run.store(None);
        }
        watch.exited.cancel();
        if !asked {
            tracing::warn!(code, "mail hub exited");
        }
    });
    let address = format!("http://127.0.0.1:{port}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if run.exited.is_cancelled() {
            return;
        }
        if healthz(&address, Duration::from_secs(1)).await.is_some() {
            hub.set(|s| s.healthy = true);
            hub.address.store(Some(Arc::new(address.clone())));
            crate::net::kick(engine);
            tracing::info!(%address, "mail hub healthy");
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            hub.set(|s| s.error = Some("the hub did not answer /healthz within 20s — see mailhub/hub.log".into()));
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Where the relay-only door listens: None when it is off, or when it is
/// for the Tailscale network only and this PC has no Tailscale address (the
/// hub then starts without it, rather than failing to bind).
#[logged]
pub async fn door_bind(engine: &Engine, cfg: &Value) -> Option<String> {
    if !cfg["public_listener"].as_bool().unwrap_or(false) {
        return None;
    }
    match cfg["public_scope"].as_str().unwrap_or("all") {
        "tailnet" => crate::phone::tailscale(engine).await.ipv4,
        // "Use my home Wi-Fi instead": this PC's LAN address only
        "lan" => crate::phone::lan_bind(),
        // a rig run's hub never listens beyond loopback
        _ if crate::rig::active() => Some("127.0.0.1".into()),
        _ => Some("0.0.0.0".into()),
    }
}

/// The phone door's address moved (`phone::reconcile_door`, two readings
/// agreeing): restart on it, re-checked under the lifecycle lock so a
/// settings save in between, or a second caller, does not restart twice.
#[logged]
pub async fn restart_door(engine: &Arc<Engine>, scope: &str, want: Option<String>) {
    let _one = engine.hub.lifecycle.lock().await;
    let cfg = engine.hub.config.load_full();
    let st = engine.hub.state.load_full();
    if !cfg["public_listener"].as_bool().unwrap_or(false) || cfg["public_scope"].as_str() != Some(scope) || !st.running || st.door == want {
        return;
    }
    stop(engine).await;
    start_now(engine).await;
}

#[logged]
pub async fn stop(engine: &Arc<Engine>) {
    if let Some(run) = engine.hub.run.swap(None) {
        run.stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(15), run.exited.cancelled()).await;
    }
    engine.hub.address.store(None);
}

/// `GET /api/desktop/hub`: the hosting settings and the hub's live status.
#[logged]
pub async fn hosting(engine: &Arc<Engine>) -> Value {
    let cfg = engine.hub.config.load_full();
    let st = engine.hub.state.load_full();
    let port = cfg["port"].as_u64().unwrap_or(DEFAULT_PORT as u64);
    let address = format!("http://127.0.0.1:{port}");
    let health = if st.running { healthz(&address, Duration::from_secs(2)).await } else { None };
    let h = health.clone().unwrap_or(Value::Null);
    let mut out = json!({
        "version": 2, "port": port, "bind": cfg["bind"], "name": cfg["name"], "retention_days": cfg["retention_days"],
        "org_retention_days": cfg["org_retention_days"], "public_listener": cfg["public_listener"],
        "public_scope": cfg["public_scope"], "max_attachment_bytes": cfg["max_attachment_bytes"],
        "public_listener_port": PUBLIC_LISTENER_PORT,
        "status": {
            "running": st.running, "healthy": health.is_some(), "address": address,
            "exposed": cfg["bind"] == json!("0.0.0.0"),
            "hub_name": h["name"], "hub_version": h["version"], "orgs": h["orgs"], "queued": h["queued"],
            "door": st.door, "door_waiting": st.door_waiting,
        },
    });
    if let Some(e) = &st.error {
        out["error"] = json!(e);
    }
    if let Some(m) = cfg.get("migrated").filter(|m| m.is_object()) {
        out["migrated"] = m.clone();
    }
    if let Some(r) = std::fs::read_to_string(data_dir(engine).join("migration-report.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        out["data_migration"] = r;
    }
    // v2's first start imported the earlier hub's store (kept untouched)
    if let Some(r) = std::fs::read_to_string(data_dir(engine).join("v2-import-report.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        out["v2_import"] = r;
    }
    out
}

/// `PUT /api/desktop/hub`: save and restart on the new settings; a hub that
/// will not start on them is put back as it was.
#[logged]
pub async fn configure(engine: &Arc<Engine>, raw: &Value) -> Result<Value, String> {
    let Some(patch) = raw.as_object() else { return Err("hub hosting configuration must be an object".into()) };
    let _one = engine.hub.lifecycle.lock().await;
    let previous = engine.hub.config.load_full();
    let mut merged: Map<String, Value> = previous.as_object().cloned().unwrap_or_default();
    for (k, v) in patch {
        if !["status", "error", "data_migration", "v2_import", "public_listener_port"].contains(&k.as_str()) {
            merged.insert(k.clone(), v.clone());
        }
    }
    let config = validate(&Value::Object(merged))?;
    let mut before = previous.as_object().cloned().unwrap_or_default();
    let mut after = config.as_object().cloned().unwrap_or_default();
    before.remove("max_attachment_bytes");
    after.remove("max_attachment_bytes");
    if before == after {
        save_upload_limit(engine, &config).map_err(|e| format!("could not apply the hub upload limit: {e}"))?;
        if let Err(e) = save_config(engine, &config) {
            let _ = save_upload_limit(engine, &previous);
            return Err(format!("could not save the hub settings: {e}"));
        }
        engine.hub.config.store(Arc::new(config));
        return Ok(hosting(engine).await);
    }
    stop(engine).await;
    engine.hub.config.store(Arc::new(config.clone()));
    save_config(engine, &config).map_err(|e| format!("could not save the hub settings: {e}"))?;
    start_now(engine).await;
    let failed = engine.hub.state.load().error.clone();
    if let Some(err) = failed {
        if hosts() {
            stop(engine).await;
            engine.hub.config.store(previous.clone());
            let _ = save_config(engine, &previous);
            start_now(engine).await;
            return Err(err);
        }
    }
    Ok(hosting(engine).await)
}
