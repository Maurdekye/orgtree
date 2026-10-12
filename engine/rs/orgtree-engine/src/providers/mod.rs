//! Providers: the CLIs this machine has (Claude Code, Codex, Antigravity,
//! Muse Code), the OpenRouter lane, their sign-in state, and the tiers each
//! offers. Discovery runs in the background and publishes the `providers` value.

pub mod catalog;
mod codex_models;
pub mod muse_models;

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::winproc;

#[derive(Clone, Debug, Default)]
pub struct CliStatus {
    pub installed: bool,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub source: String,
    pub connected: bool,
    pub email: Option<String>,
    pub kind: Option<String>,
}

#[derive(Clone, Default)]
pub struct State {
    pub claude: CliStatus,
    pub codex: CliStatus,
    pub agy: CliStatus,
    /// OpenRouter favorites: (tier, seat, model id, label, color)
    pub openrouter: Vec<(String, f64, String, String, String, String)>,
    /// models the Antigravity account lists (conditional tiers)
    pub agy_models: Vec<String>,
    pub codex_efforts: std::collections::BTreeMap<String, Vec<String>>,
    pub codex_efforts_error: Option<String>,
    pub muse: CliStatus,
    /// what the last Muse metadata host reported (schema, sign-in, catalog)
    pub muse_probe: Option<MuseDiscovery>,
    pub muse_error: Option<String>,
    /// the first sign-in check (`discover`) has landed. Until it does, a
    /// provider that reads as signed out has not been checked yet: staffing
    /// surfaces say "checking sign-ins" rather than "not signed in".
    pub probed: bool,
}

/// The last Muse metadata read and when it was taken.
#[derive(Clone, Debug)]
pub struct MuseDiscovery {
    pub at: chrono::DateTime<chrono::Utc>,
    pub probe: muse_models::MuseProbe,
}

#[derive(Default)]
pub struct Providers {
    pub state: ArcSwap<State>,
    /// `~/.claude.json` mcpServers, re-read when the file changes
    mcp: ArcSwap<McpRegistry>,
    /// each registered Muse login's last own metadata read (account id →
    /// read): what it offers, as the login itself said (the user's own login
    /// is `State::muse_probe`)
    muse_logins: ArcSwap<std::collections::HashMap<String, MuseLoginRead>>,
}

/// One registered Muse login's catalog as its own metadata read last saw it.
#[derive(Clone, Debug)]
pub struct MuseLoginRead {
    pub at: chrono::DateTime<chrono::Utc>,
    pub catalog: Option<muse_models::MuseCatalog>,
    pub signed_in: Option<bool>,
    /// why the read failed (the catalog is then the previous read's, if any)
    pub error: Option<String>,
}

/// What a Muse login offers for one model, by its own catalog.
#[derive(Clone, Debug)]
pub enum MuseOffer {
    Offered(muse_models::MuseModel),
    NotOffered(String),
    /// never read, or its last read failed: entitlement is not inferred
    Unknown(String),
}

#[derive(Default)]
pub struct McpRegistry {
    pub stamp: Option<(std::time::SystemTime, u64)>,
    pub servers: Vec<(String, Value)>,
}

#[logged]
impl Providers {
    pub fn openrouter_tiers(&self) -> Vec<(String, f64, String)> {
        self.state.load().openrouter.iter().map(|(t, s, m, _, _, _)| (t.clone(), *s, m.clone())).collect()
    }
    pub fn claude_path(&self) -> Option<PathBuf> {
        self.state.load().claude.path.clone()
    }
    pub fn codex_path(&self) -> Option<PathBuf> {
        self.state.load().codex.path.clone()
    }
    pub fn agy_path(&self) -> Option<PathBuf> {
        self.state.load().agy.path.clone()
    }
    pub fn muse_path(&self) -> Option<PathBuf> {
        self.state.load().muse.path.clone()
    }

    /// The signed-in Muse account's catalog row for `model`, when its
    /// authenticated catalog offers it (never a bundled row).
    pub fn muse_model(&self, model: &str) -> Option<muse_models::MuseModel> {
        self.state.load().muse_probe.as_ref()?.probe.catalog.as_ref()?.offered(model).cloned()
    }

    /// The user's MCP server registry (`mcpServers` in `~/.claude.json`):
    /// what an agent's `tools.mcp` grants name. Cached until the file changes.
    pub fn mcp_registry(&self) -> Arc<McpRegistry> {
        let path = home().join(".claude.json");
        let stamp = std::fs::metadata(&path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
        let cur = self.mcp.load_full();
        if cur.stamp.is_some() && cur.stamp == stamp {
            return cur;
        }
        let servers = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
            .map(|m| m.into_iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let next = Arc::new(McpRegistry { stamp, servers });
        self.mcp.store(next.clone());
        next
    }
}

fn home() -> PathBuf {
    crate::rig::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[logged]
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in ["exe", "cmd", "bat", ""] {
            let p = if ext.is_empty() { dir.join(name) } else { dir.join(format!("{name}.{ext}")) };
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Prefer the real executable behind npm's `claude.cmd` shim.
#[logged]
pub fn locate_claude() -> Option<(PathBuf, String)> {
    if crate::rig::active() {
        return crate::rig::cli_bin("ORGTREE_CLAUDE_BIN");
    }
    if let Ok(p) = std::env::var("ORGTREE_CLAUDE_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some((p, "env".into()));
        }
    }
    if let Some(appdata) = dirs::data_dir() {
        let exe = appdata.join("npm").join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe");
        if exe.is_file() {
            return Some((exe, "path".into()));
        }
    }
    let local = home().join(".local").join("bin").join(crate::util::exe_name("claude"));
    if local.is_file() {
        return Some((local, "path".into()));
    }
    which("claude").map(|p| (p, "path".into()))
}

#[logged]
pub fn locate_codex() -> Option<(PathBuf, String)> {
    if crate::rig::active() {
        return crate::rig::cli_bin("ORGTREE_CODEX_BIN");
    }
    if let Ok(p) = std::env::var("ORGTREE_CODEX_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some((p, "env".into()));
        }
    }
    if let Some(appdata) = dirs::data_dir() {
        let base = appdata.join("npm").join("node_modules").join("@openai").join("codex");
        for cand in [
            base.join("node_modules").join("@openai").join("codex-win32-x64").join("vendor").join("x86_64-pc-windows-msvc").join("codex").join("codex.exe"),
            base.join("vendor").join("x86_64-pc-windows-msvc").join("codex").join("codex.exe"),
        ] {
            if cand.is_file() {
                return Some((cand, "path".into()));
            }
        }
    }
    which("codex").map(|p| (p, "path".into()))
}

#[logged]
pub fn locate_agy() -> Option<(PathBuf, String)> {
    if crate::rig::active() {
        return crate::rig::cli_bin("ORGTREE_AGY_BIN");
    }
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("agy").join("bin").join("agy.exe");
        if p.is_file() {
            return Some((p, "path".into()));
        }
    }
    which("agy").map(|p| (p, "path".into()))
}

/// The Muse Code binary (never its updater launcher): the folder its
/// installer uses (`%LOCALAPPDATA%\Programs\muse`), else the folder of a
/// `muse` launcher on PATH. `ORGTREE_MUSE_BIN` names one explicitly.
#[logged]
pub fn locate_muse() -> Option<(PathBuf, String)> {
    if crate::rig::active() {
        return crate::rig::cli_bin("ORGTREE_MUSE_BIN");
    }
    if let Ok(p) = std::env::var("ORGTREE_MUSE_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some((p, "env".into()));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        if let Some(p) = muse_models::bin_in(&local.join("Programs").join("muse")) {
            return Some((p, "path".into()));
        }
    }
    let launcher = which("muse")?;
    muse_models::bin_in(launcher.parent()?).map(|p| (p, "path".into()))
}

#[logged]
async fn version_of(path: &PathBuf) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    winproc::no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let v = s.split_whitespace().find(|w| w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))?;
    Some(v.to_string())
}

#[logged]
pub(crate) fn claude_identity(config_dir: Option<&PathBuf>) -> (bool, Option<String>) {
    let dir = config_dir.cloned().unwrap_or_else(|| home().join(".claude"));
    let creds = dir.join(".credentials.json");
    let connected = creds.is_file();
    let cfg = match config_dir {
        Some(d) => d.join(".claude.json"),
        None => home().join(".claude.json"),
    };
    let email = std::fs::read_to_string(cfg)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.pointer("/oauthAccount/emailAddress").and_then(Value::as_str).map(str::to_string));
    (connected || email.is_some(), email)
}

/// The machine's own Codex home (`~/.codex`).
#[logged]
pub(crate) fn codex_default_home() -> PathBuf {
    home().join(".codex")
}

#[logged]
pub(crate) fn codex_identity(home_dir: Option<&PathBuf>) -> (bool, Option<String>, Option<String>) {
    let dir = home_dir.cloned().unwrap_or_else(|| home().join(".codex"));
    let auth = std::fs::read_to_string(dir.join("auth.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    match auth {
        Some(a) => {
            let kind = if a.get("tokens").map(|t| !t.is_null()).unwrap_or(false) { "chatgpt" } else { "api-key" };
            let email = a
                .pointer("/tokens/id_token")
                .and_then(Value::as_str)
                .and_then(jwt_email);
            (true, email, Some(kind.to_string()))
        }
        None => (false, None, None),
    }
}

fn jwt_email(token: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email").and_then(Value::as_str).map(str::to_string)
}

#[logged]
pub async fn discover(engine: &Engine) {
    let mut st = State::default();
    if let Some((p, src)) = locate_claude() {
        let (connected, email) = claude_identity(None);
        st.claude = CliStatus {
            installed: true,
            version: version_of(&p).await,
            path: Some(p),
            source: src,
            connected,
            email,
            kind: Some("subscription".into()),
        };
    }
    if let Some((p, src)) = locate_codex() {
        let (connected, email, kind) = codex_identity(None);
        if connected {
            match codex_models::probe(&p).await {
                Ok(efforts) => st.codex_efforts = efforts,
                Err(e) => st.codex_efforts_error = Some(format!("Codex model capabilities unavailable: {e}")),
            }
        } else {
            st.codex_efforts_error = Some("Codex model capabilities unavailable: primary login is signed out".into());
        }
        st.codex =
            CliStatus { installed: true, version: version_of(&p).await, path: Some(p), source: src, connected, email, kind };
    }
    if let Some((p, src)) = locate_agy() {
        // the email comes from the usage probe's own CLI log (set_agy_email)
        let prev = engine.providers.state.load().agy.clone();
        st.agy = CliStatus {
            installed: true,
            version: version_of(&p).await,
            path: Some(p),
            source: src,
            connected: true,
            email: prev.email,
            kind: prev.kind,
        };
    }
    if let Some((status, found, error)) = discover_muse(engine).await {
        st.muse = status;
        st.muse_probe = found;
        st.muse_error = error;
    }
    st.openrouter = openrouter_favorites(engine);
    let prev_models = engine.providers.state.load().agy_models.clone();
    st.agy_models = prev_models;
    st.probed = true;
    engine.providers.state.store(Arc::new(st));
    publish(engine);
}

/// The Muse part of discovery: the binary, then one metadata read of the
/// user's own login (catalog, sign-in and cached usage observation). A
/// failed read keeps the last good one, dated, with the failure beside it.
/// Not logged: the status carries the account label.
#[nolog]
async fn discover_muse(engine: &Engine) -> Option<(CliStatus, Option<MuseDiscovery>, Option<String>)> {
    let (p, src) = locate_muse()?;
    let version = muse_models::installed_version(&p).or(version_of(&p).await);
    match muse_probe_with(engine, &p, None).await {
        Ok(probe) => {
            let catalog = probe.catalog.as_ref();
            tracing::info!(
                version = ?probe.server_version, fingerprint = ?probe.fingerprint,
                verified = muse_models::verified(probe.fingerprint.as_deref()), account = ?probe.account_state,
                catalog = ?catalog.map(|c| &c.source),
                offered = ?catalog.map(|c| c.models.iter().filter(|m| m.account_row).map(|m| m.id.clone()).collect::<Vec<_>>()),
                "Muse discovery"
            );
            // an unknown sign-in (the read was refused) is not "signed out"
            let connected = match probe.account_state.as_deref() {
                Some("loggedOut") => false,
                Some(_) => true,
                None => catalog.is_some_and(|c| c.source == "providerCatalog"),
            };
            let kind = match probe.account_state.as_deref() {
                Some("apiKey") => Some("api-key".to_string()),
                Some("accountLogin") => Some("subscription".to_string()),
                other => other.map(str::to_string),
            };
            crate::usage::muse_probed(engine, None, &probe).await;
            let status = CliStatus { installed: true, version, path: Some(p), source: src, connected, email: probe.label.clone(), kind };
            Some((status, Some(MuseDiscovery { at: chrono::Utc::now(), probe }), None))
        }
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "Muse discovery failed");
            let prev = engine.providers.state.load_full();
            let status = CliStatus { installed: true, version, path: Some(p), source: src, ..prev.muse.clone() };
            Some((status, prev.muse_probe.clone(), Some(format!("Muse capabilities unavailable: {e:#}"))))
        }
    }
}

/// One metadata read of a Muse login: the user's own (`root` None) or a
/// managed one whose config and data roots live under `root`.
#[nolog] // its answer carries the account label
pub async fn muse_probe_login(engine: &Engine, root: Option<&str>) -> anyhow::Result<muse_models::MuseProbe> {
    let exe = match engine.providers.muse_path() {
        Some(p) => p,
        None => tokio::task::spawn_blocking(locate_muse)
            .await
            .ok()
            .flatten()
            .map(|(p, _)| p)
            .ok_or_else(|| anyhow::anyhow!("Muse Code is not installed"))?,
    };
    muse_probe_with(engine, &exe, root).await
}

#[nolog]
async fn muse_probe_with(engine: &Engine, exe: &std::path::Path, root: Option<&str>) -> anyhow::Result<muse_models::MuseProbe> {
    let dir = engine.cfg.path("profiles").join("muse-discovery");
    std::fs::create_dir_all(&dir)?;
    let env = muse_models::clean_env(&muse_models::login_env(root.map(std::path::Path::new)));
    muse_models::probe(exe, &env, &dir).await
}

/// An API-key Muse login's own roots (`config`, `data`): never the user's own
/// Muse roots, where the subscription sign-in and its sessions live, so a key
/// seat neither sees that sign-in nor resumes its sessions (Codex keys get
/// their own home the same way).
#[nolog]
pub fn muse_key_root(engine: &Engine, account: &str) -> std::path::PathBuf {
    engine.cfg.path("profiles").join(format!("muse-key-{account}"))
}

/// The environment a registered Muse login runs with: a profile's own roots,
/// or an API key in its own roots. Not logged: it carries the key.
#[nolog]
pub fn muse_account_env(engine: &Engine, a: &crate::accounts::AccountInfo, key: Option<&str>) -> anyhow::Result<Vec<(String, String)>> {
    if a.is_apikey() {
        let key = key.ok_or_else(|| anyhow::anyhow!("the API-key account has no key stored"))?;
        let root = muse_key_root(engine, &a.id);
        for sub in ["config", "data"] {
            std::fs::create_dir_all(root.join(sub))?;
        }
        let mut env = muse_models::login_env(Some(&root));
        env.push(("META_API_KEY".into(), key.to_string()));
        Ok(env)
    } else {
        Ok(muse_models::login_env(a.config_dir.as_deref().map(std::path::Path::new)))
    }
}

/// A Muse API-key login's stored key, by the rule a seat's own launch reads
/// it with (the account's key, unrestricted or this org's). Not logged: it is
/// the key.
#[nolog]
pub async fn muse_stored_key(engine: &Engine, account: &str, org_slug: &str) -> Option<String> {
    let client = engine.db.get().await.ok()?;
    let row = client
        .query_opt(
            "SELECT s.secret FROM ot.account_secrets s JOIN ot.accounts ac ON ac.id = s.account_id
              WHERE ac.id = $1 AND ac.provider = 'muse' AND ac.kind = 'apikey' AND coalesce(ac.origin_org, '') IN ('', $2)",
            &[&account, &org_slug],
        )
        .await
        .ok()??;
    row.get(0)
}

/// The catalog row a Muse seat on `account` may run (None: the user's own
/// login, as discovery read it). A registered login is asked with its own
/// metadata read, a profile in its roots and a key with itself: entitlement
/// is never borrowed from another login (user 2026-10-12 19:57Z), so an API
/// key is not assumed to offer what the subscription offers.
#[nolog] // the key
pub async fn muse_model_for(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, key: Option<&str>, model: &str)
    -> anyhow::Result<Option<muse_models::MuseModel>> {
    let Some(a) = account else { return Ok(engine.providers.muse_model(model)) };
    let probe = muse_login_probe(engine, a, key).await?;
    if probe.account_state.as_deref() == Some("loggedOut") {
        anyhow::bail!("the Muse account {} is not signed in", a.id);
    }
    Ok(probe.catalog.as_ref().and_then(|c| c.offered(model)).cloned())
}

/// One metadata read of a registered Muse login (a profile in its roots, a
/// key with itself), kept as that login's catalog for placement checks.
/// Not logged: it handles the key.
#[nolog]
async fn muse_login_probe(engine: &Engine, a: &crate::accounts::AccountInfo, key: Option<&str>) -> anyhow::Result<muse_models::MuseProbe> {
    let read = async {
        let exe = engine.providers.muse_path().ok_or_else(|| anyhow::anyhow!("Muse Code is not installed"))?;
        let dir = engine.cfg.path("profiles").join("muse-discovery");
        std::fs::create_dir_all(&dir)?;
        let env = muse_models::clean_env(&muse_account_env(engine, a, key)?);
        muse_models::probe(&exe, &env, &dir).await
    }
    .await;
    muse_login_seen(engine, &a.id, read.as_ref().map_err(|e| format!("{e:#}")));
    read
}

/// Keep what one registered Muse login's own read said: its catalog and
/// sign-in, or why the read failed (an earlier catalog stays, dated).
#[nolog]
pub fn muse_login_seen(engine: &Engine, account: &str, read: Result<&muse_models::MuseProbe, String>) {
    let now = chrono::Utc::now();
    let offer = |e: &Engine| e.providers.muse_logins.load().get(account).map(|r| (r.catalog.clone(), r.signed_in, r.error.is_some()));
    let before = offer(engine);
    engine.providers.muse_logins.rcu(|cur| {
        let mut next = (**cur).clone();
        let entry = match &read {
            Ok(p) => MuseLoginRead {
                at: now,
                catalog: p.catalog.clone(),
                signed_in: p.account_state.as_deref().map(|s| s != "loggedOut"),
                error: None,
            },
            Err(e) => {
                let prev = cur.get(account);
                MuseLoginRead {
                    at: prev.map(|r| r.at).unwrap_or(now),
                    catalog: prev.and_then(|r| r.catalog.clone()),
                    signed_in: prev.and_then(|r| r.signed_in),
                    error: Some(e.clone()),
                }
            }
        };
        next.insert(account.to_string(), entry);
        next
    });
    // the hire and settings surfaces read every login's offer from the
    // providers payload: a changed one is pushed to the windows at once
    if offer(engine) != before {
        publish(engine);
    }
}

/// How long a registered login's read stands for a placement check before
/// it is read again (as often as its usage is probed).
pub const MUSE_LOGIN_FRESH: Duration = Duration::from_secs(300);

/// Read a registered Muse login again unless its last good read is recent;
/// at most `FALLBACK`-style bounded (10 s). Run before a transaction that
/// will judge a placement on it, never inside one. Not logged: the key.
#[nolog]
pub async fn muse_login_refresh(engine: &Engine, a: &crate::accounts::AccountInfo, org_slug: &str) {
    if a.provider != catalog::MUSE {
        return;
    }
    let fresh = engine.providers.muse_logins.load().get(&a.id).is_some_and(|r| {
        r.error.is_none() && (chrono::Utc::now() - r.at).to_std().is_ok_and(|age| age < MUSE_LOGIN_FRESH)
    });
    if fresh {
        return;
    }
    let key = if a.is_apikey() {
        match muse_stored_key(engine, &a.id, org_slug).await {
            Some(k) => Some(k),
            None => {
                muse_login_seen(engine, &a.id, Err("its API key is not stored for this organization".into()));
                return;
            }
        }
    } else {
        None
    };
    if tokio::time::timeout(Duration::from_secs(10), muse_login_probe(engine, a, key.as_deref())).await.is_err() {
        muse_login_seen(engine, &a.id, Err("its metadata read took longer than 10 s".into()));
    }
}

/// Read every registered Muse login `org_slug` may use whose last read is
/// not recent (before staffing answers or an op's transaction).
#[logged]
pub async fn muse_logins_refresh(engine: &Engine, org_slug: &str) {
    let view = engine.accounts.view();
    let logins: Vec<crate::accounts::AccountInfo> = view.all().into_iter()
        .filter(|a| a.provider == catalog::MUSE && a.enabled && a.available_to(Some(org_slug)))
        .cloned()
        .collect();
    for a in &logins {
        muse_login_refresh(engine, a, org_slug).await;
    }
}

/// What the Muse login a seat runs on offers for `model`, by its own catalog
/// as last read (None: the user's own login, read by discovery). Never a
/// provider request: placement checks run inside transactions.
#[logged]
pub fn muse_offer(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, model: &str) -> MuseOffer {
    muse_catalogs(engine).offer(account, model)
}

/// Every Muse login's catalog as last read, taken at once (the user's own
/// login's discovery and each registered login's own read): what a builder
/// with no engine at hand asks (`MuseCatalogs::offer`, as `muse_offer`).
pub struct MuseCatalogs {
    state: Arc<State>,
    logins: Arc<std::collections::HashMap<String, MuseLoginRead>>,
}

#[logged]
pub fn muse_catalogs(engine: &Engine) -> MuseCatalogs {
    MuseCatalogs { state: engine.providers.state.load_full(), logins: engine.providers.muse_logins.load_full() }
}

#[logged]
impl MuseCatalogs {
    /// What `account` (None: the user's own login) offers for `model`, by
    /// that login's own catalog: never another login's, never inferred.
    pub fn offer(&self, account: Option<&crate::accounts::AccountInfo>, model: &str) -> MuseOffer {
        let Some(a) = account else {
            let st = &self.state;
            if st.muse_probe.as_ref().and_then(|d| d.probe.account_state.as_deref()) == Some("loggedOut") {
                return MuseOffer::NotOffered("the signed-in Muse login is signed out".into());
            }
            return match st.muse_probe.as_ref().and_then(|d| d.probe.catalog.as_ref()) {
                Some(c) => match c.offered(model) {
                    Some(m) => MuseOffer::Offered(m.clone()),
                    None => MuseOffer::NotOffered(format!("the signed-in Muse account does not offer {model}")),
                },
                None => MuseOffer::Unknown(st.muse_error.clone().unwrap_or_else(|| "the signed-in Muse account has not been read yet".into())),
            };
        };
        let Some(r) = self.logins.get(&a.id) else {
            return MuseOffer::Unknown(format!("what the Muse account {} offers has not been read yet", a.id));
        };
        if r.signed_in == Some(false) {
            return MuseOffer::NotOffered(format!("the Muse account {} is not signed in", a.id));
        }
        match (&r.catalog, &r.error) {
            (Some(c), None) => match c.offered(model) {
                Some(m) => MuseOffer::Offered(m.clone()),
                None => MuseOffer::NotOffered(format!("the Muse account {} does not offer {model}", a.id)),
            },
            (_, Some(e)) => MuseOffer::Unknown(format!("what the Muse account {} offers could not be read ({e})", a.id)),
            (None, None) => MuseOffer::Unknown(format!("the Muse account {} returned no catalog", a.id)),
        }
    }
}

/// Before a transaction that will judge a Muse placement on the user's own
/// login: read it once (bounded) when discovery holds no catalog for it, as
/// a turn's launch does. A failed or slow read is the check's to report.
#[logged]
pub async fn muse_own_refresh(engine: &Engine) {
    if engine.providers.state.load().muse_probe.as_ref().is_none_or(|d| d.probe.catalog.is_none())
        && tokio::time::timeout(Duration::from_secs(10), refresh_muse(engine)).await.is_err()
    {
        tracing::info!("Muse's own login: its metadata read took longer than 10 s");
    }
}

/// The effort names the seat's own login and model expose (`effort_names`
/// for every provider but Muse, whose names are the row of the exact model,
/// its pinned version included, in the catalog of the login it runs on).
#[logged]
pub fn effort_names_on(engine: &Engine, tier: &str, version: Option<&str>, account: Option<&crate::accounts::AccountInfo>) -> Option<Vec<String>> {
    if !catalog::is_muse(tier) {
        return effort_names(&engine.providers.state.load(), tier);
    }
    match muse_offer(engine, account.filter(|a| a.provider == catalog::MUSE), &catalog::model_for(tier, version)) {
        MuseOffer::Offered(row) => Some(catalog::MUSE_EFFORTS.iter().filter(|e| row.variants.iter().any(|v| v == *e)).map(|e| e.to_string()).collect()),
        _ => None,
    }
}

/// `check_effort` for the seat's own login and exact model (see
/// `effort_names_on`); while those are not known, any harness name is
/// taken (the launch maps it to one the model lists).
#[logged]
pub fn check_effort_on(engine: &Engine, tier: &str, version: Option<&str>, account: Option<&crate::accounts::AccountInfo>, level: &str)
    -> anyhow::Result<()> {
    if level.is_empty() {
        return Ok(());
    }
    match effort_names_on(engine, tier, version, account) {
        Some(names) if names.iter().any(|n| n == level) => Ok(()),
        Some(names) if names.is_empty() => crate::refuse!(BadRequest, "{tier} has no effort setting"),
        Some(names) => crate::refuse!(BadRequest, "{} takes the effort levels {}; {level} is not one of them",
            catalog::model_for(tier, version), names.join(", ")),
        None if catalog::effort_rank(level).is_some() => Ok(()),
        None => crate::refuse!(BadRequest, "unknown effort {level}"),
    }
}

/// Read the user's own Muse login again now (a manual refresh) and publish
/// what changed: its catalog, sign-in and usage.
#[logged]
pub async fn refresh_muse(engine: &Engine) {
    let Some((status, found, error)) = discover_muse(engine).await else { return };
    let mut st = (*engine.providers.state.load_full()).clone();
    st.muse = status;
    st.muse_probe = found;
    st.muse_error = error;
    engine.providers.state.store(Arc::new(st));
    publish(engine);
}

/// Whether an OpenRouter key is stored (the lane shows on the usage board).
#[nolog]
pub fn openrouter_key_set(engine: &Engine) -> bool {
    engine.settings.get().pointer("/openrouter/key_set").and_then(Value::as_bool).unwrap_or(false)
}

/// The Antigravity sign-in's email, as its usage probe's log names it.
#[logged]
pub fn set_agy_email(engine: &Engine, email: &str) {
    let cur = engine.providers.state.load_full();
    if cur.agy.email.as_deref() == Some(email) {
        return;
    }
    let mut st = (*cur).clone();
    st.agy.email = Some(email.to_string());
    st.agy.kind = Some("oauth".into());
    engine.providers.state.store(Arc::new(st));
    publish(engine);
}

/// The OpenRouter favorites as offered tiers: (tier, seat, model, label, color).
#[logged]
fn openrouter_favorites(engine: &Engine) -> Vec<(String, f64, String, String, String, String)> {
    engine
        .settings
        .get()
        .get("openrouter")
        .and_then(|o| o.get("favorites"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    Some((
                        f.get("tier")?.as_str()?.to_string(),
                        f.get("seat").and_then(Value::as_f64).unwrap_or(1.0),
                        f.get("model")?.as_str()?.to_string(),
                        f.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                        f.get("color").and_then(Value::as_str).unwrap_or("#888888").to_string(),
                        // the favourite's own letter (first letter of its label), never the provider's
                        f.get("letter")
                            .and_then(Value::as_str)
                            .filter(|l| !l.is_empty())
                            .map(str::to_string)
                            .or_else(|| {
                                f.get("label").and_then(Value::as_str).and_then(|l| l.chars().find(|c| c.is_alphanumeric()))
                                    .map(|c| c.to_ascii_uppercase().to_string())
                            })
                            .unwrap_or_else(|| "R".to_string()),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Re-read the favorites into the provider state without probing the CLIs.
#[logged]
pub fn refresh_openrouter(engine: &Engine) {
    let tiers = openrouter_favorites(engine);
    engine.providers.state.rcu(|cur| {
        let mut st = State::clone(cur);
        st.openrouter = tiers.clone();
        st
    });
}

#[logged]
fn tier_rows(provider: &str, legacy_ok: bool) -> Vec<Value> {
    catalog::TIERS
        .iter()
        .filter(|t| t.provider == provider && (legacy_ok || !t.legacy))
        .map(|t| json!({ "tier": t.tier, "provider": t.provider, "seat": t.seat, "model": t.model, "letter": t.letter }))
        .collect()
}

#[logged]
pub fn payload(engine: &Engine) -> Value {
    let st = engine.providers.state.load();
    let settings = engine.settings.get();
    let entry = |id: &str, label: &str, cli: &str, s: &CliStatus, tiers: Vec<Value>| {
        let enabled = engine.settings.provider_enabled(id);
        let hire = s.installed && s.connected && enabled;
        let reason = if !s.installed {
            Some(format!("{label} is not installed on this machine"))
        } else if !s.connected {
            Some(format!("{label} is installed but not signed in"))
        } else if !enabled {
            Some(format!("{label} is turned off in App settings"))
        } else {
            None
        };
        json!({
            "id": id, "label": label, "cli": cli, "tiers": tiers,
            "status": {
                "installed": s.installed, "version": s.version, "path": s.path.as_ref().map(|p| p.to_string_lossy()),
                "source": s.source, "connected": s.connected, "email": s.email, "kind": s.kind,
            },
            "hire_enabled": hire, "reason": reason, "user_enabled": enabled,
        })
    };
    let mut providers = vec![];
    if st.claude.installed {
        providers.push(entry(catalog::CLAUDE, "Claude", "claude", &st.claude, tier_rows(catalog::CLAUDE, false)));
    }
    if st.codex.installed {
        providers.push(entry(catalog::OPENAI, "Codex", "codex", &st.codex, tier_rows(catalog::OPENAI, false)));
    }
    if st.agy.installed {
        let mut tiers = tier_rows(catalog::GOOGLE, false);
        tiers.retain(|t| {
            let tier = t["tier"].as_str().unwrap_or("");
            if catalog::antigravity_claude(tier) && !engine.settings.antigravity_claude_enabled() {
                return false;
            }
            agy_offers(tier, &st.agy_models)
        });
        providers.push(entry(catalog::GOOGLE, "Antigravity", "agy", &st.agy, tiers));
    }
    if st.muse.installed {
        let found = st.muse_probe.as_ref();
        // every registered Muse login switched on, by its own catalog as last
        // read: a tier one of them offers is offered too, and says where
        // (independent review 2026-10-13: the user's own login's entitlement
        // is no prerequisite for another login's)
        let view = engine.accounts.view();
        let registered: Vec<&crate::accounts::AccountInfo> = view.all().into_iter()
            .filter(|a| a.provider == catalog::MUSE && crate::accounts::active(engine, catalog::MUSE, Some(a)))
            .collect();
        // a tier the own login's catalog lists stays listed while it is signed
        // out (disabled, with the reason, unless another login offers models)
        let own_out = found.and_then(|d| d.probe.account_state.as_deref()) == Some("loggedOut");
        let tiers: Vec<Value> = catalog::TIERS
            .iter()
            .filter(|t| t.provider == catalog::MUSE && !t.legacy)
            .filter_map(|t| {
                let listed = muse_offers(t.tier, found);
                let own = listed && !own_out;
                let on: Vec<&&crate::accounts::AccountInfo> = registered.iter().filter(|a| muse_tier_on(engine, Some(a), t)).collect();
                if !listed && on.is_empty() {
                    return None;
                }
                let row = if listed {
                    found.and_then(|d| d.probe.catalog.as_ref()).and_then(|c| c.offered(t.model)).cloned()
                } else {
                    on.iter().find_map(|a| match muse_offer(engine, Some(a), t.model) { MuseOffer::Offered(m) => Some(m), _ => None })
                };
                Some(json!({ "tier": t.tier, "provider": t.provider, "seat": t.seat, "model": t.model, "letter": t.letter,
                        "efforts": row.as_ref().map(|r| r.variants.clone()), "default_effort": row.as_ref().and_then(|r| r.default_effort.clone()),
                        "context": row.as_ref().and_then(|r| r.context),
                        "own": own, "logins": on.iter().map(|a| a.id.clone()).collect::<Vec<_>>() }))
            })
            .collect();
        let any = !tiers.is_empty();
        let elsewhere = tiers.iter().any(|t| t["logins"].as_array().is_some_and(|l| !l.is_empty()));
        let mut e = entry(catalog::MUSE, "Muse", "muse", &st.muse, tiers);
        e["muse"] = muse_detail(found, st.muse_error.as_deref());
        e["muse"]["logins"] = json!(std::iter::once(muse_login_doc(engine, None))
            .chain(registered.iter().map(|a| muse_login_doc(engine, Some(a)))).collect::<Vec<_>>());
        // a registered login that offers a model makes Muse hirable with the
        // user's own login signed out (a hire is placed on a login that offers it)
        if !st.muse.connected && elsewhere && engine.settings.provider_enabled(catalog::MUSE) {
            e["hire_enabled"] = json!(true);
            e["reason"] = Value::Null;
        }
        if st.muse.connected && !any && e["reason"].is_null() {
            e["reason"] = json!(match found.and_then(|d| d.probe.catalog.as_ref()).map(|c| c.source.as_str()) {
                Some("providerCatalog") => "the signed-in Muse account's catalog offers no model this Orgtree knows",
                _ => "Muse has not fetched this sign-in's model catalog yet (run Muse Code once); no Muse model is offered until it has",
            });
        }
        providers.push(e);
    }
    let key_set = settings.pointer("/openrouter/key_set").and_then(Value::as_bool).unwrap_or(false);
    if key_set || !st.openrouter.is_empty() {
        let tiers: Vec<Value> = st
            .openrouter
            .iter()
            .map(|(t, s, m, label, color, letter)| {
                json!({ "tier": t, "provider": catalog::OPENROUTER, "seat": s, "model": m, "letter": letter,
                        "label": label, "color": color })
            })
            .collect();
        let s = CliStatus { installed: key_set, connected: key_set, ..Default::default() };
        let mut e = entry(catalog::OPENROUTER, "OpenRouter", "openrouter", &s, tiers);
        if !key_set {
            e["reason"] = json!("no OpenRouter API key is set (App settings › Providers › OpenRouter)");
        }
        providers.push(e);
    }
    // the user's own model servers: one entry for the lane, its tiers the
    // offered models of every enabled server (shown once a server exists)
    let servers = crate::langserver::servers(engine);
    if !servers.is_empty() {
        let tiers: Vec<Value> = crate::langserver::tiers(engine)
            .into_iter()
            .map(|(t, s, m, label, server)| {
                json!({ "tier": t, "provider": catalog::LANGSERVER, "seat": s, "model": m, "letter": catalog::monogram(&label),
                        "label": label, "name": format!("{label} · {server}") })
            })
            .collect();
        let any = !tiers.is_empty();
        let s = CliStatus { installed: true, connected: any, ..Default::default() };
        let mut e = entry(catalog::LANGSERVER, "Language servers", "language server", &s, tiers);
        if !any {
            e["reason"] = json!("no language server offers a model yet (App settings › Providers › Language servers)");
        }
        providers.push(e);
    }
    let map = |key: &str, default: bool| {
        let mut m = serde_json::Map::new();
        for p in [catalog::CLAUDE, catalog::OPENAI, catalog::GOOGLE, catalog::MUSE] {
            let v = settings.get(key).and_then(|x| x.get(p)).and_then(Value::as_bool).unwrap_or(default);
            m.insert(p.to_string(), json!(v));
        }
        Value::Object(m)
    };
    json!({
        "providers": providers,
        // the first sign-in check has not landed: an absent or signed-out
        // provider is not known to be either yet
        "checking": !st.probed,
        "apikey_fallback": map("apikey_fallback", false),
        "subscription_inference": map("subscription_inference", true),
    })
}

/// Whether a Muse tier is offered: its model (or one of its versions) is a
/// row of the signed-in account's authenticated catalog. A bundled row, a
/// failed discovery or no discovery yet offers nothing.
#[nolog]
fn muse_offers(tier: &str, found: Option<&MuseDiscovery>) -> bool {
    let (Some(t), Some(c)) = (catalog::tier(tier), found.and_then(|d| d.probe.catalog.as_ref())) else { return false };
    std::iter::once(t.model).chain(t.versions.iter().map(|(_, m)| *m)).any(|m| c.offered(m).is_some())
}

/// Whether one Muse login offers `t` (its latest model or one of its
/// versions) by its own catalog as last read (`muse_offer`).
#[nolog]
fn muse_tier_on(engine: &Engine, account: Option<&crate::accounts::AccountInfo>, t: &catalog::Tier) -> bool {
    std::iter::once(t.model).chain(t.versions.iter().map(|(_, m)| *m))
        .any(|m| matches!(muse_offer(engine, account, m), MuseOffer::Offered(_)))
}

/// One Muse login as the hire and agent settings surfaces read it
/// (`/api/providers` › `muse.logins`; `account` None: the user's own login):
/// whether its catalog is known, and per Muse tier it offers the exact
/// model's levels and default, for the tier's latest model and for each
/// version it offers, as `effort_names_on` names them. In memory only.
#[logged]
fn muse_login_doc(engine: &Engine, account: Option<&crate::accounts::AccountInfo>) -> Value {
    let (state, reason) = match account {
        None => {
            let st = engine.providers.state.load();
            match st.muse_probe.as_ref() {
                Some(d) if d.probe.account_state.as_deref() == Some("loggedOut") => ("signed_out", None),
                Some(d) if d.probe.catalog.is_some() => ("ready", None),
                _ => ("unknown", Some(st.muse_error.clone().unwrap_or_else(|| "the signed-in Muse account has not been read yet".into()))),
            }
        }
        Some(a) => match engine.providers.muse_logins.load().get(&a.id) {
            None => ("unknown", Some("not read yet".to_string())),
            Some(r) if r.signed_in == Some(false) => ("signed_out", None),
            Some(r) => match (&r.catalog, &r.error) {
                (Some(_), None) => ("ready", None),
                (_, Some(e)) => ("unknown", Some(e.clone())),
                (None, None) => ("unknown", Some("no catalog was returned".to_string())),
            },
        },
    };
    let row = |model: &str| match muse_offer(engine, account, model) {
        MuseOffer::Offered(m) => Some(json!({
            "model": model,
            "efforts": catalog::MUSE_EFFORTS.iter().filter(|e| m.variants.iter().any(|v| v == *e)).collect::<Vec<_>>(),
            "default_effort": m.default_effort })),
        _ => None,
    };
    let mut tiers = serde_json::Map::new();
    for t in catalog::TIERS.iter().filter(|t| t.provider == catalog::MUSE && !t.legacy) {
        let latest = row(t.model);
        let versions: serde_json::Map<String, Value> = t.versions.iter().filter_map(|(v, m)| row(m).map(|r| (v.to_string(), r))).collect();
        if latest.is_some() || !versions.is_empty() {
            tiers.insert(t.tier.to_string(), json!({ "latest": latest, "versions": versions }));
        }
    }
    json!({
        "account": account.map(|a| a.id.clone()),
        "kind": account.map(|a| if a.is_apikey() { "apikey" } else { "subscription" }).unwrap_or("subscription"),
        "state": state, "reason": reason, "tiers": tiers,
    })
}

/// Whether the account offers a Muse tier now (hire, rehire and switch
/// refuse one it does not).
#[logged]
pub fn muse_offered(engine: &Engine, tier: &str) -> bool {
    muse_offers(tier, engine.providers.state.load().muse_probe.as_ref())
}

/// The effort level names `tier`'s harness and model expose, lowest first,
/// in that harness's own words (user 2026-10-12): Claude Code's `--effort`
/// levels for a Claude seat (an OpenRouter one included), the Codex model's
/// `model/list` levels, the Muse catalog row's `variants`, Antigravity's
/// verified ones. `Some([])`: the model has no effort setting; None: not
/// known yet (its catalog has not been read).
#[logged]
pub fn effort_names(st: &State, tier: &str) -> Option<Vec<String>> {
    let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    if catalog::is_langserver(tier) {
        return Some(Vec::new());
    }
    if catalog::is_openrouter(tier) {
        return Some(names(catalog::EFFORTS));
    }
    let t = catalog::tier(tier)?;
    match t.provider {
        catalog::CLAUDE => Some(names(catalog::EFFORTS)),
        catalog::OPENAI => st.codex_efforts.get(t.model).cloned(),
        catalog::GOOGLE => Some(catalog::EFFORTS.iter().filter(|e| catalog::antigravity_effort(t.tier, e) == **e).map(|e| e.to_string()).collect()),
        catalog::MUSE => {
            let row = st.muse_probe.as_ref().and_then(|d| d.probe.catalog.as_ref()).and_then(|c| c.offered(t.model))?;
            Some(catalog::MUSE_EFFORTS.iter().filter(|e| row.variants.iter().any(|v| v == *e)).map(|e| e.to_string()).collect())
        }
        _ => None,
    }
}

/// Refuse an agent's own effort level that its tier's harness and model do
/// not name. While the tier's levels are not known yet, any level some
/// harness names is taken (the launch maps it, `catalog::launch_effort`).
#[logged]
pub fn check_effort(engine: &Engine, tier: &str, level: &str) -> anyhow::Result<()> {
    if level.is_empty() {
        return Ok(());
    }
    match effort_names(&engine.providers.state.load(), tier) {
        Some(names) if names.iter().any(|n| n == level) => Ok(()),
        Some(names) if names.is_empty() => crate::refuse!(BadRequest, "{tier} has no effort setting"),
        Some(names) => crate::refuse!(BadRequest, "{tier} takes the effort levels {}; {level} is not one of them", names.join(", ")),
        None if catalog::effort_rank(level).is_some() => Ok(()),
        None => crate::refuse!(BadRequest, "unknown effort {level}"),
    }
}

/// The level name a turn on `tier` is sent for the saved `level`
/// (`catalog::launch_effort` over the tier's own names), and whether it was
/// mapped. Unknown names for the tier: the level goes unchanged.
#[logged]
pub fn launch_effort(engine: &Engine, tier: &str, level: &str) -> (String, bool) {
    match effort_names(&engine.providers.state.load(), tier) {
        Some(names) => catalog::launch_effort(level, &names),
        None => (level.to_string(), false),
    }
}

/// The provider card's Muse facts: the MSP schema and whether this build was
/// verified, the sign-in state as Muse reports it, and the catalog with its
/// provenance (bundled rows are listed but never offered).
#[logged]
fn muse_detail(found: Option<&MuseDiscovery>, error: Option<&str>) -> Value {
    let Some(d) = found else { return json!({ "error": error }) };
    let p = &d.probe;
    json!({
        "observed_at": crate::util::iso(d.at),
        "server_version": p.server_version,
        "schema": { "version": p.schema_version, "fingerprint": p.fingerprint,
                    "verified": muse_models::verified(p.fingerprint.as_deref()) },
        "account_state": p.account_state,
        "catalog": p.catalog.as_ref().map(|c| json!({
            "source": c.source,
            "models": c.models.iter().map(|m| json!({
                "id": m.id, "account_row": m.account_row, "default": m.is_default, "efforts": m.variants,
                "default_effort": m.default_effort, "context": m.context, "output": m.output })).collect::<Vec<_>>(),
        })),
        "error": error,
    })
}

/// Whether an Antigravity tier is offered: always, unless it is CONDITIONAL
/// (Argon, Barium, Carbon), which is offered only while the account's
/// `agy models` lists its model (a listed variant such as `-high` counts).
#[nolog]
fn agy_offers(tier: &str, listed: &[String]) -> bool {
    match catalog::tier(tier) {
        Some(t) if t.conditional => listed.iter().any(|m| m.starts_with(t.model)),
        _ => true,
    }
}

#[logged]
pub fn publish(engine: &Engine) {
    engine.app.set_value("providers", payload(engine));
}

#[logged]
pub fn start(engine: &Arc<Engine>) {
    let engine = engine.clone();
    tokio::spawn(async move {
        loop {
            discover(&engine).await;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(300)) => {}
                _ = engine.shutdown.cancelled() => break,
            }
        }
    });
}

#[cfg(test)]
mod conditional_tests {
    use super::agy_offers;

    #[test]
    fn carbon_is_offered_only_while_agy_lists_it() {
        let without: Vec<String> = ["gemini-3.8-flash", "gemini-4-argon", "gemini-4-barium-high"].map(String::from).to_vec();
        assert!(!agy_offers("carbon", &without));
        assert!(!agy_offers("carbon", &[]));
        for listed in ["gemini-4-carbon", "gemini-4-carbon-high", "gemini-4-carbon-low"] {
            assert!(agy_offers("carbon", &[listed.to_string()]), "{listed}");
        }
        // the three conditional tiers are judged independently; flash is never conditional
        assert!(agy_offers("argon", &without) && agy_offers("barium", &without));
        assert!(agy_offers("flash", &[]));
        let row = super::catalog::tier("carbon").unwrap();
        assert_eq!((row.provider, row.model, row.letter, row.seat, row.conditional), (super::catalog::GOOGLE, "gemini-4-carbon", "C", 2.0, true));
    }
}

#[cfg(test)]
mod muse_offer_tests {
    use super::*;

    fn login(id: &str) -> crate::accounts::AccountInfo {
        crate::accounts::AccountInfo {
            id: id.into(), provider: catalog::MUSE.into(), kind: "managed".into(), label: String::new(), email: None,
            tint_ordinal: 0, auth: "authenticated".into(), config_dir: None, enabled: true, origin_org: None,
            marks: Default::default(), ord: 0, ambient: false, credential: 0,
        }
    }

    fn catalog_of(models: &[&str]) -> muse_models::MuseCatalog {
        muse_models::parse_catalog(&serde_json::json!({ "source": "providerCatalog", "models": models.iter()
            .map(|m| serde_json::json!({ "modelId": m, "profileId": "tbh", "variants": ["low", "high"] })).collect::<Vec<_>>() }))
    }

    fn read(models: &[&str], signed_in: Option<bool>, error: Option<&str>) -> MuseLoginRead {
        MuseLoginRead { at: chrono::Utc::now(), catalog: Some(catalog_of(models)), signed_in, error: error.map(String::from) }
    }

    /// Each login is judged by its own read (the own login by discovery, a
    /// registered one by its own catalog), never by another login's; a login
    /// never read, or whose last read failed, is unknown (its older catalog is
    /// not trusted); a signed-out one offers nothing.
    #[test]
    fn muse_offer_is_each_logins_own_catalog() {
        let own = MuseDiscovery { at: chrono::Utc::now(), probe: muse_models::MuseProbe {
            account_state: Some("accountLogin".into()), catalog: Some(catalog_of(&["muse-wonder-1.0"])), ..Default::default() } };
        let logins = std::collections::HashMap::from([
            ("muse-2".to_string(), read(&["muse-wonder-full-1.0"], Some(true), None)),
            ("muse-3".to_string(), read(&["muse-wonder-full-1.0"], Some(true), Some("its metadata read took longer than 10 s"))),
            ("muse-4".to_string(), read(&["muse-wonder-full-1.0"], Some(false), None)),
        ]);
        let c = MuseCatalogs { state: Arc::new(State { muse_probe: Some(own), ..Default::default() }), logins: Arc::new(logins) };
        let (full, wonder) = ("muse-wonder-full-1.0", "muse-wonder-1.0");
        assert!(matches!(c.offer(None, full), MuseOffer::NotOffered(_)), "the own login lacks Full");
        assert!(matches!(c.offer(None, wonder), MuseOffer::Offered(_)));
        assert!(matches!(c.offer(Some(&login("muse-2")), full), MuseOffer::Offered(_)), "its own catalog offers Full");
        assert!(matches!(c.offer(Some(&login("muse-2")), wonder), MuseOffer::NotOffered(_)), "the own login's Wonder is not borrowed");
        assert!(matches!(c.offer(Some(&login("muse-3")), full), MuseOffer::Unknown(_)), "a failed read is unknown");
        assert!(matches!(c.offer(Some(&login("muse-4")), full), MuseOffer::NotOffered(_)), "a signed-out login offers nothing");
        assert!(matches!(c.offer(Some(&login("muse-9")), full), MuseOffer::Unknown(_)), "a login never read is unknown");
        let out = MuseCatalogs { state: Arc::new(State { muse_probe: Some(MuseDiscovery { at: chrono::Utc::now(),
            probe: muse_models::MuseProbe { account_state: Some("loggedOut".into()), catalog: Some(catalog_of(&[wonder])), ..Default::default() } }),
            ..Default::default() }), logins: Arc::new(Default::default()) };
        assert!(matches!(out.offer(None, wonder), MuseOffer::NotOffered(_)), "the own login signed out offers nothing");
    }
}
