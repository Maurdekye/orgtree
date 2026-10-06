//! Providers: the CLIs this machine has (Claude Code, Codex, Antigravity),
//! the OpenRouter lane, their sign-in state, and the tiers each offers.
//! Discovery runs in the background and publishes the `providers` value.

pub mod catalog;

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

#[derive(Default)]
pub struct State {
    pub claude: CliStatus,
    pub codex: CliStatus,
    pub agy: CliStatus,
    /// OpenRouter favorites: (tier, seat, model id, label, color)
    pub openrouter: Vec<(String, f64, String, String, String)>,
    /// models the Antigravity account lists (conditional tiers)
    pub agy_models: Vec<String>,
}

#[derive(Default)]
pub struct Providers {
    pub state: ArcSwap<State>,
}

impl Providers {
    pub fn openrouter_tiers(&self) -> Vec<(String, f64, String)> {
        self.state.load().openrouter.iter().map(|(t, s, m, _, _)| (t.clone(), *s, m.clone())).collect()
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
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn which(name: &str) -> Option<PathBuf> {
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
pub fn locate_claude() -> Option<(PathBuf, String)> {
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
    let local = home().join(".local").join("bin").join("claude.exe");
    if local.is_file() {
        return Some((local, "path".into()));
    }
    which("claude").map(|p| (p, "path".into()))
}

pub fn locate_codex() -> Option<(PathBuf, String)> {
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

pub fn locate_agy() -> Option<(PathBuf, String)> {
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("agy").join("bin").join("agy.exe");
        if p.is_file() {
            return Some((p, "path".into()));
        }
    }
    which("agy").map(|p| (p, "path".into()))
}

async fn version_of(path: &PathBuf) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    winproc::no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let v = s.split_whitespace().find(|w| w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))?;
    Some(v.to_string())
}

fn claude_identity(config_dir: Option<&PathBuf>) -> (bool, Option<String>) {
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

fn codex_identity(home_dir: Option<&PathBuf>) -> (bool, Option<String>, Option<String>) {
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
        st.codex =
            CliStatus { installed: true, version: version_of(&p).await, path: Some(p), source: src, connected, email, kind };
    }
    if let Some((p, src)) = locate_agy() {
        st.agy = CliStatus {
            installed: true,
            version: version_of(&p).await,
            path: Some(p),
            source: src,
            connected: true,
            email: None,
            kind: None,
        };
    }
    st.openrouter = engine
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
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let prev_models = engine.providers.state.load().agy_models.clone();
    st.agy_models = prev_models;
    engine.providers.state.store(Arc::new(st));
    publish(engine);
}

fn tier_rows(provider: &str, legacy_ok: bool) -> Vec<Value> {
    catalog::TIERS
        .iter()
        .filter(|t| t.provider == provider && (legacy_ok || !t.legacy))
        .map(|t| json!({ "tier": t.tier, "provider": t.provider, "seat": t.seat, "model": t.model, "letter": t.letter }))
        .collect()
}

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
            let cond = catalog::tier(tier).map(|x| x.conditional).unwrap_or(false);
            !cond || st.agy_models.iter().any(|m| m.starts_with(t["model"].as_str().unwrap_or("?")))
        });
        providers.push(entry(catalog::GOOGLE, "Antigravity", "agy", &st.agy, tiers));
    }
    let key_set = settings.pointer("/openrouter/key_set").and_then(Value::as_bool).unwrap_or(false);
    if key_set || !st.openrouter.is_empty() {
        let tiers: Vec<Value> = st
            .openrouter
            .iter()
            .map(|(t, s, m, label, color)| {
                json!({ "tier": t, "provider": catalog::OPENROUTER, "seat": s, "model": m, "letter": "R",
                        "label": label, "color": color })
            })
            .collect();
        let s = CliStatus { installed: key_set, connected: key_set, ..Default::default() };
        providers.push(entry(catalog::OPENROUTER, "OpenRouter", "openrouter", &s, tiers));
    }
    let map = |key: &str, default: bool| {
        let mut m = serde_json::Map::new();
        for p in [catalog::CLAUDE, catalog::OPENAI] {
            let v = settings.get(key).and_then(|x| x.get(p)).and_then(Value::as_bool).unwrap_or(default);
            m.insert(p.to_string(), json!(v));
        }
        Value::Object(m)
    };
    json!({
        "providers": providers,
        "apikey_fallback": map("apikey_fallback", false),
        "subscription_inference": map("subscription_inference", true),
    })
}

pub fn publish(engine: &Engine) {
    engine.app.set_value("providers", payload(engine));
}

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
