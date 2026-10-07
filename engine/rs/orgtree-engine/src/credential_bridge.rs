//! In-memory, local-only bridge to the signed-in desktop. Secret paths never trace.
use crate::engine::Engine;
use arc_swap::ArcSwapOption;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const NO_DESKTOP: &str = "Orgtree credential bridge: the Orgtree desktop app isn't open in a signed-in Windows session: ask the user to sign in to Windows and open the Orgtree app [no-desktop].";
pub const UNAVAILABLE: &str = "Open Orgtree in your signed-in Windows session to restore git/GitHub access. Agents keep running; no engine restart is needed.";
const MAX: usize = 65536;
const PIPE_WAIT: Duration = Duration::from_secs(1);
const SLOT_WAIT: Duration = Duration::from_secs(2);
#[derive(Clone, PartialEq)]
enum ExchangeError {
    Busy,
    Unavailable,
    /// Fixed, secret-free code from the desktop (for example `gh-exit-1`).
    Lookup(String),
}
/// Why a bridge request failed. Every variant is safe to show and log.
enum Fail {
    Denied,
    Busy,
    Unavailable,
    Lookup(String),
}
impl From<()> for Fail {
    #[nolog]
    fn from(_: ()) -> Self {
        Fail::Denied
    }
}
/// Last real desktop lookup, for the app. Never holds credential data.
pub struct LookupStatus {
    pub ok: bool,
    pub kind: &'static str,
    pub reason: Option<String>,
    pub at_ms: i64,
}
const REGISTER: &str = "/api/desktop/credential-bridge";
const REQUEST: &str = "/api/agent-credential";

struct Broker {
    pipe: String,
    secret: String,
    pid: u32,
    expires: Instant,
}
struct Grant {
    secret: String,
    org: i64,
    generation: i32,
    pid: AtomicU32,
    created: AtomicU64,
}
pub struct Bridge {
    broker: ArcSwapOption<Broker>,
    grants: papaya::HashMap<i64, Arc<Grant>>,
    slots: tokio::sync::Semaphore,
    reported_ready: AtomicBool,
    last_lookup: ArcSwapOption<LookupStatus>,
}
#[nolog]
impl Bridge {
    pub fn new() -> Self {
        Self {
            broker: ArcSwapOption::empty(),
            grants: papaya::HashMap::new(),
            slots: tokio::sync::Semaphore::new(16),
            reported_ready: AtomicBool::new(false),
            last_lookup: ArcSwapOption::empty(),
        }
    }
    /// `untested` until a real git/gh lookup has gone through the desktop;
    /// a successful ping or registration is not a lookup.
    pub fn lookup_view(&self) -> Value {
        match self.last_lookup.load_full() {
            None => json!({"status": "untested"}),
            Some(l) => json!({
                "status": if l.ok { "succeeded" } else { "failed" },
                "kind": l.kind,
                "reason": l.reason,
                "message": l.reason.as_deref().map(describe),
                "at_ms": l.at_ms,
            }),
        }
    }
    fn record(&self, kind: &'static str, host: &str, reason: Option<&str>) {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let previous = self.last_lookup.swap(Some(Arc::new(LookupStatus {
            ok: reason.is_none(),
            kind,
            reason: reason.map(str::to_string),
            at_ms,
        })));
        match reason {
            Some(reason) => tracing::warn!(
                kind,
                host,
                reason,
                "Credential bridge lookup failed: {}",
                describe(reason)
            ),
            // Log the first success and every recovery, not every lookup.
            None if previous.map(|p| !p.ok).unwrap_or(true) => {
                tracing::info!(kind, host, "Credential bridge lookup succeeded")
            }
            None => {}
        }
    }
    pub fn ready(&self) -> bool {
        self.broker
            .load()
            .as_ref()
            .map(|b| b.expires > Instant::now())
            .unwrap_or(false)
    }
    pub fn revoke(&self, agent: i64) {
        self.grants.pin().remove(&agent);
    }
    pub fn bind(&self, agent: i64, pid: u32) {
        if let Some(g) = self.grants.pin().get(&agent) {
            g.created
                .store(process_stamp(pid).unwrap_or(0), Ordering::SeqCst);
            g.pid.store(pid, Ordering::SeqCst);
        }
    }
    pub fn environment(
        &self,
        engine: &Engine,
        agent: i64,
        org: i64,
        generation: i32,
    ) -> Vec<(String, String)> {
        if !needs_adapter(
            cfg!(windows),
            engine.credentials.state.load().warning.is_some(),
        ) {
            return vec![];
        }
        let Ok(exe) = std::env::current_exe() else {
            return vec![];
        };
        // Per-boot static adapters contain no secrets. Startup reclaims stale
        // boot folders; locked binaries are retained until a later startup.
        let dir = engine.cfg.path("credential-adapters").join(&engine.boot.id);
        if std::fs::create_dir_all(&dir).is_err() {
            return vec![];
        }
        let shim = dir.join("gh.exe");
        if !shim.exists() && std::fs::hard_link(&exe, &shim).is_err() && !shim.exists() {
            // Cross-volume installs: publish only a complete copy. Concurrent
            // agents may race the rename, but never observe a partial binary.
            let tmp = dir.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            if std::fs::copy(&exe, &tmp).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return vec![];
            }
            let result = std::fs::rename(&tmp, &shim);
            let _ = std::fs::remove_file(&tmp);
            if result.is_err() && !shim.exists() {
                return vec![];
            }
        }
        let secret = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.grants.pin().insert(
            agent,
            Arc::new(Grant {
                secret: secret.clone(),
                org,
                generation,
                pid: AtomicU32::new(0),
                created: AtomicU64::new(0),
            }),
        );
        adapter_environment(&exe, dir, agent, engine.boot.port, secret)
    }
}

#[nolog]
fn adapter_environment(
    exe: &std::path::Path,
    dir: std::path::PathBuf,
    agent: i64,
    port: u16,
    secret: String,
) -> Vec<(String, String)> {
    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let real_gh = std::env::split_paths(&old_path)
        .map(|p| p.join("gh.exe"))
        .find(|p| p.is_file() && !adapter_path(p));
    let path = std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&old_path)))
        .unwrap_or(old_path);
    let n = git_config_slot(std::env::var("GIT_CONFIG_COUNT").ok().as_deref());
    let quoted = exe
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''");
    let mut env = vec![
        ("ORGTREE_CREDENTIAL_AUTH".into(), secret),
        (
            "ORGTREE_CREDENTIAL_URL".into(),
            format!("http://127.0.0.1:{}{REQUEST}", port),
        ),
        ("ORGTREE_CREDENTIAL_AGENT".into(), agent.to_string()),
    ];
    // Never replace malformed/oversized inherited configuration with slot zero.
    // Git retains its native behavior; gh bridging remains independently usable.
    if let Some(n) = n {
        env.extend([
            ("GIT_CONFIG_COUNT".into(), (n + 1).to_string()),
            (format!("GIT_CONFIG_KEY_{n}"), "credential.helper".into()),
            (
                format!("GIT_CONFIG_VALUE_{n}"),
                format!("!'{}' credential-helper", quoted),
            ),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ]);
    }
    if let Some(real) = real_gh {
        env.push(("PATH".into(), path.to_string_lossy().into_owned()));
        env.push((
            "ORGTREE_REAL_GH".into(),
            real.to_string_lossy().into_owned(),
        ));
    }
    env
}

/// All registration, failed-ping and lease-expiry availability notifications
/// pass here. Payload is a boolean; never publish broker or grant contents.
#[nolog]
pub fn publish_availability(engine: &Engine) {
    let ready = engine.credential_bridge.ready();
    if engine
        .credential_bridge
        .reported_ready
        .swap(ready, Ordering::SeqCst)
        == ready
    {
        return;
    }
    crate::runtime::watchdogs::events::condition(engine,
        if ready {"credentials.bridge.available"} else {"credentials.bridge.unavailable"},
        if ready {"credentials.bridge.unavailable"} else {"credentials.bridge.available"},
        serde_json::json!({"reason":if ready {"signed-in broker registered"} else {"broker disconnected or lease expired"}}));
    if ready {
        tracing::info!("Signed-in desktop git/GitHub credential bridge ready; general Windows vault remains isolated");
    } else {
        tracing::warn!("{UNAVAILABLE}");
    }
}

/// Preserve Git's nonsecret config KEY names on Codex versions that apply
/// the *KEY* shell filter. The opaque capability uses AUTH (not *TOKEN*) and
/// remains environment-only; never put it in -c argv or config files.
#[nolog]
pub fn codex_overrides(env: &[(String, String)]) -> Vec<String> {
    if !env.iter().any(|(k, _)| k == "ORGTREE_CREDENTIAL_AUTH") {
        return vec![];
    }
    let mut entries: std::collections::BTreeMap<String, String> = std::env::vars()
        .filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_"))
        .collect();
    entries.extend(
        env.iter()
            .filter(|(k, _)| k.starts_with("GIT_CONFIG_KEY_"))
            .cloned(),
    );
    let mut args = Vec::new();
    for (key, value) in entries {
        if key
            .strip_prefix("GIT_CONFIG_KEY_")
            .map(|n| n.parse::<u8>().is_ok())
            .unwrap_or(false)
        {
            args.push("-c".into());
            args.push(format!(
                "shell_environment_policy.set.{}={}",
                key,
                toml::Value::String(value)
            ));
        }
    }
    args
}

#[nolog]
pub fn route(path: &str) -> bool {
    path == REGISTER || path == REQUEST
}

/// Entire route, including auth failures, bypasses generic body/header tracing.
#[nolog]
pub async fn dispatch(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let result = tokio::time::timeout(Duration::from_secs(10), handle(&engine, req))
        .await
        .unwrap_or(Err(Fail::Busy));
    match result {
        Ok(bytes) => (
            StatusCode::OK,
            [
                ("content-type", "application/octet-stream"),
                ("cache-control", "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(fail) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("cache-control", "no-store")],
            match fail {
                Fail::Denied => "Orgtree credential bridge: this process's credential capability is no longer valid; a new turn or CLI process gets a fresh one [denied].".to_string(),
                Fail::Busy => "Orgtree credential bridge: busy or timed out; retry in a moment [busy].".to_string(),
                Fail::Unavailable => NO_DESKTOP.to_string(),
                Fail::Lookup(reason) => describe(&reason),
            },
        )
            .into_response(),
    }
}
#[nolog]
async fn handle(engine: &Engine, req: Request) -> Result<Vec<u8>, Fail> {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .ok_or(())?;
    if !peer.0.ip().is_loopback() || req.method() != axum::http::Method::POST {
        return Err(Fail::Denied);
    }
    let register = req.uri().path() == REGISTER;
    let token = req
        .headers()
        .get(if register {
            crate::http::TOKEN_HEADER
        } else {
            "x-orgtree-credential-token"
        })
        .and_then(|v| v.to_str().ok())
        .ok_or(())?
        .to_string();
    if register
        && (engine.cfg.desktop_token.is_empty() || !equal(&token, &engine.cfg.desktop_token))
    {
        return Err(Fail::Denied);
    }
    let header_agent = req
        .headers()
        .get("x-orgtree-credential-agent")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    if !register {
        let agent = header_agent.ok_or(())?;
        let grants = engine.credential_bridge.grants.pin();
        if !grants
            .get(&agent)
            .map(|g| equal(&token, &g.secret))
            .unwrap_or(false)
        {
            return Err(Fail::Denied);
        }
    }
    let _slot = tokio::time::timeout(SLOT_WAIT, engine.credential_bridge.slots.acquire())
        .await
        .map_err(|_| Fail::Busy)?
        .map_err(|_| Fail::Busy)?;
    let bytes = axum::body::to_bytes(req.into_body(), MAX)
        .await
        .map_err(|_| ())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if register {
        let pipe = value["pipe"].as_str().ok_or(())?;
        let secret = value["secret"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or(())?;
        if !pipe
            .strip_prefix(r"\\.\pipe\orgtree-credentials-")
            .map(|s| {
                !s.is_empty()
                    && s.len() < 100
                    && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
            .unwrap_or(false)
        {
            return Err(Fail::Denied);
        }
        let pid = u32::try_from(value["pid"].as_u64().ok_or(())?).map_err(|_| ())?;
        let broker = Broker {
            pipe: pipe.into(),
            secret: secret.into(),
            pid,
            expires: Instant::now() + Duration::from_secs(20),
        };
        if exchange(&broker, json!({"kind":"ping"}))
            .await
            .map_err(|_| Fail::Unavailable)?
            != b"ready"
        {
            return Err(Fail::Denied);
        }
        engine
            .credential_bridge
            .broker
            .store(Some(Arc::new(broker)));
        publish_availability(engine);
        return Ok(b"ready".to_vec());
    }
    let agent = value["agent"].as_i64().ok_or(())?;
    if header_agent != Some(agent) {
        return Err(Fail::Denied);
    }
    let grant = engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .cloned()
        .ok_or(())?;
    if !equal(&token, &grant.secret) {
        return Err(Fail::Denied);
    }
    let pid = grant.pid.load(Ordering::SeqCst);
    let stamp = grant.created.load(Ordering::SeqCst);
    if stamp == 0 || process_stamp(pid) != Some(stamp) {
        return Err(Fail::Denied);
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    let exists=db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_some();
    drop(db);
    if !exists {
        return Err(Fail::Denied);
    }
    let kind: &'static str = match value["kind"].as_str() {
        Some("git") => "git",
        Some("gh") => "gh",
        _ => return Err(Fail::Denied),
    };
    let host = value["host"].as_str().filter(|h| valid_host(h)).ok_or(())?;
    let path = value["path"].as_str().unwrap_or("");
    let username = value["username"].as_str().unwrap_or("");
    if !safe_field(path) || !safe_field(username) {
        return Err(Fail::Denied);
    }
    let broker = engine
        .credential_bridge
        .broker
        .load_full()
        .filter(|b| b.expires > Instant::now())
        .ok_or(Fail::Unavailable)?;
    let answer = match exchange(
        &broker,
        json!({"kind":kind,"host":host,"path":path,"username":username,"diagnostics":1}),
    )
    .await
    {
        Ok(answer) => {
            engine.credential_bridge.record(kind, host, None);
            answer
        }
        Err(ExchangeError::Busy) => return Err(Fail::Busy),
        Err(ExchangeError::Lookup(reason)) => {
            engine.credential_bridge.record(kind, host, Some(&reason));
            return Err(Fail::Lookup(reason));
        }
        Err(ExchangeError::Unavailable) => {
            // A missing credential is not a dead broker. Probe the channel
            // without reading a secret before withdrawing availability.
            if exchange(&broker, json!({"kind":"ping"})).await == Err(ExchangeError::Unavailable) {
                let previous = engine
                    .credential_bridge
                    .broker
                    .compare_and_swap(&Some(broker.clone()), None);
                if previous
                    .as_ref()
                    .map(|b| Arc::ptr_eq(b, &broker))
                    .unwrap_or(false)
                {
                    publish_availability(engine);
                }
                engine.credential_bridge.record(kind, host, Some("broker-gone"));
                return Err(Fail::Unavailable);
            }
            // Older desktops close the pipe without a reason.
            engine.credential_bridge.record(kind, host, Some("broker-failed"));
            return Err(Fail::Lookup("broker-failed".into()));
        }
    };
    // Re-check revocation after the asynchronous desktop lookup.
    if !engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .map(|g| Arc::ptr_eq(g, &grant))
        .unwrap_or(false)
    {
        return Err(Fail::Denied);
    }
    if process_stamp(pid) != Some(stamp) {
        return Err(Fail::Denied);
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    if db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_none() {return Err(Fail::Denied);}
    if !engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .map(|g| Arc::ptr_eq(g, &grant))
        .unwrap_or(false)
    {
        return Err(Fail::Denied);
    }
    Ok(answer)
}
#[nolog]
fn needs_adapter(windows: bool, isolated: bool) -> bool {
    windows && isolated
}
#[nolog]
fn adapter_path(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("credential-adapters")
    })
}
#[nolog]
fn find_gh() -> Option<std::path::PathBuf> {
    let cached = std::env::var_os("ORGTREE_REAL_GH")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file() && !adapter_path(p));
    cached.or_else(|| {
        std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("gh.exe"))
                .find(|p| p.is_absolute() && p.is_file() && !adapter_path(p))
        })
    })
}
#[nolog]
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (x, y)| n | (x ^ y)) == 0
}
#[nolog]
fn safe_field(s: &str) -> bool {
    s.len() <= 4096 && !s.chars().any(|c| c.is_control())
}
#[nolog]
fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c))
        && !s.starts_with(['-', '.'])
}

/// One actionable line an agent can relay to the user. Codes are fixed
/// strings from the desktop broker and never contain tool output.
#[nolog]
fn describe(code: &str) -> String {
    let tool = code.split('-').next().unwrap_or("");
    let what = match code {
        "gh-empty" => "GitHub sign-in missing on the desktop: ask the user to run `gh auth login` in their Windows session".to_string(),
        "git-empty" => "no saved git login for this host on the desktop: ask the user to sign in there once (for github.com: `gh auth login`)".to_string(),
        "gh-missing" | "git-missing" => format!("{tool}.exe is not on the desktop's PATH: ask the user to install {tool} and reopen the Orgtree app"),
        "gh-timeout" | "git-timeout" => format!("{tool} timed out on the desktop: ask the user to check that `{tool}` works in their own terminal"),
        "broker-gone" | "broker-failed" => "the Orgtree desktop app stopped answering: ask the user to reopen the Orgtree app".to_string(),
        "invalid-request" => "the desktop rejected this request (unsupported host or field)".to_string(),
        c => match c.split_once("-exit-") {
            Some(("gh", n)) => format!("gh failed on the desktop (exit {n}), usually because GitHub sign-in is missing: ask the user to run `gh auth status` and `gh auth login` in their Windows session"),
            Some((tool, n)) => format!("{tool} failed on the desktop (exit {n}), usually because no login is saved for this host: ask the user to sign in there once (for github.com: `gh auth login`)"),
            None => "the desktop lookup failed: ask the user to reopen the Orgtree app".to_string(),
        },
    };
    format!("Orgtree credential bridge: {what} [{code}].")
}

#[cfg(windows)]
#[nolog]
async fn exchange(broker: &Broker, mut request: Value) -> Result<Vec<u8>, ExchangeError> {
    use std::os::windows::io::AsRawHandle;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::ClientOptions,
    };
    let started = Instant::now();
    let mut pipe = loop {
        match ClientOptions::new().open(&broker.pipe) {
            Ok(pipe) => break pipe,
            Err(error) if pipe_busy(error.raw_os_error()) => {
                if started.elapsed() >= PIPE_WAIT {
                    return Err(ExchangeError::Busy);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(_) => return Err(ExchangeError::Unavailable),
        }
    };
    let mut pid = 0;
    if unsafe {
        windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId(
            pipe.as_raw_handle() as _,
            &mut pid,
        )
    } == 0
        || pid != broker.pid
        || !interactive_same_user(pid)
    {
        return Err(ExchangeError::Unavailable);
    }
    request["secret"] = Value::String(broker.secret.clone());
    let mut raw = serde_json::to_vec(&request).map_err(|_| ExchangeError::Unavailable)?;
    raw.push(b'\n');
    pipe.write_all(&raw)
        .await
        .map_err(|_| ExchangeError::Unavailable)?;
    let mut result = Vec::new();
    pipe.take((MAX + 1) as u64)
        .read_to_end(&mut result)
        .await
        .map_err(|_| ExchangeError::Unavailable)?;
    if result == b"orgtree-credential-busy\n" {
        Err(ExchangeError::Busy)
    } else if let Some(code) = result
        .strip_prefix(b"orgtree-credential-error ")
        .and_then(|c| c.strip_suffix(b"\n"))
    {
        let code = std::str::from_utf8(code).unwrap_or("");
        let valid = !code.is_empty()
            && code.len() <= 40
            && code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-');
        Err(ExchangeError::Lookup(
            if valid { code } else { "broker-failed" }.into(),
        ))
    } else if result.len() > MAX || result.is_empty() {
        Err(ExchangeError::Unavailable)
    } else {
        Ok(result)
    }
}
#[cfg(not(windows))]
#[nolog]
async fn exchange(_: &Broker, _: Value) -> Result<Vec<u8>, ExchangeError> {
    Err(ExchangeError::Unavailable)
}

#[cfg(windows)]
#[nolog]
fn process_stamp(pid: u32) -> Option<u64> {
    use windows_sys::Win32::{Foundation::*, System::Threading::*};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut code = 0;
        let mut c: FILETIME = std::mem::zeroed();
        let mut e = c;
        let mut k = c;
        let mut u = c;
        let ok = GetExitCodeProcess(h, &mut code) != 0
            && code == STILL_ACTIVE as u32
            && GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
        CloseHandle(h);
        ok.then_some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }
}
#[cfg(not(windows))]
#[nolog]
fn process_stamp(_: u32) -> Option<u64> {
    None
}

#[cfg(windows)]
#[nolog]
fn interactive_same_user(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::*, Security::*, System::RemoteDesktop::*, System::Threading::*,
    };
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(pid, &mut session) == 0 || session == 0 {
            return false;
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut token = std::ptr::null_mut();
        let ok = OpenProcessToken(h, TOKEN_QUERY, &mut token);
        CloseHandle(h);
        if ok == 0 {
            return false;
        }
        let mut ours = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut ours) == 0 {
            CloseHandle(token);
            return false;
        }
        let a = token_sid(token);
        let b = token_sid(ours);
        let interactive = token_interactive(token);
        CloseHandle(token);
        CloseHandle(ours);
        interactive && a.is_some() && a == b
    }
}
#[cfg(windows)]
#[nolog]
unsafe fn token_interactive(token: windows_sys::Win32::Foundation::HANDLE) -> bool {
    use windows_sys::Win32::Security::*;
    let mut len = 0;
    GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut len);
    if len == 0 || len > 65536 {
        return false;
    }
    let mut buffer = vec![0u64; (len as usize + 7) / 8];
    if GetTokenInformation(
        token,
        TokenGroups,
        buffer.as_mut_ptr().cast(),
        len,
        &mut len,
    ) == 0
    {
        return false;
    }
    const SE_GROUP_ENABLED: u32 = 0x00000004; // winnt.h
    let groups = &*(buffer.as_ptr() as *const TOKEN_GROUPS);
    let offset = groups.Groups.as_ptr() as usize - buffer.as_ptr() as usize;
    if offset + groups.GroupCount as usize * std::mem::size_of::<SID_AND_ATTRIBUTES>()
        > len as usize
    {
        return false;
    }
    let mut sid = [0u64; 9];
    let mut size = std::mem::size_of_val(&sid) as u32;
    if CreateWellKnownSid(
        WinInteractiveSid,
        std::ptr::null_mut(),
        sid.as_mut_ptr().cast(),
        &mut size,
    ) == 0
    {
        return false;
    }
    // INTERACTIVE is stamped into a genuine interactive logon token (also RDP).
    // Querying TokenGroups needs TOKEN_QUERY, not cross-logon LSA privileges.
    std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        .iter()
        .any(|g| {
            g.Attributes & SE_GROUP_ENABLED != 0 && EqualSid(g.Sid, sid.as_mut_ptr().cast()) != 0
        })
}
#[cfg(windows)]
#[nolog]
unsafe fn token_sid(token: windows_sys::Win32::Foundation::HANDLE) -> Option<Vec<u8>> {
    use windows_sys::Win32::Security::*;
    let mut len = 0;
    GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
    if len == 0 || len > 65536 {
        return None;
    }
    let mut buf = vec![0u64; (len as usize + 7) / 8];
    if GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len) == 0 {
        return None;
    }
    let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
    if IsValidSid(sid) == 0 {
        return None;
    }
    let n = GetLengthSid(sid) as usize;
    Some(std::slice::from_raw_parts(sid as *const u8, n).to_vec())
}

// CLI adapters run before engine tracing initializes. Never echo credential failures.
#[nolog]
pub fn cli(kind: &str, args: &[String]) -> std::process::ExitCode {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(rt) = rt else {
        return std::process::ExitCode::FAILURE;
    };
    match rt.block_on(cli_async(kind, args)) {
        Ok(code) => std::process::ExitCode::from(code),
        Err(_) if kind == "git" => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("{UNAVAILABLE}");
            std::process::ExitCode::FAILURE
        }
    }
}
#[nolog]
async fn cli_async(kind: &str, args: &[String]) -> Result<u8, ()> {
    let real = if kind == "gh" {
        let Some(real) = find_gh() else {
            eprintln!("GitHub CLI (gh.exe) is not on this process's PATH. Install it and reopen the agent process to refresh PATH.");
            return Ok(127);
        };
        Some(real)
    } else {
        None
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut host = std::env::var("GH_HOST").unwrap_or_else(|_| "github.com".into());
    let mut path = String::new();
    let mut username = String::new();
    let mut bridge_target = true;
    if kind == "git" {
        if args.first().map(|s| s.as_str()) != Some("get") {
            return Ok(0);
        }
        let mut raw = String::new();
        tokio::io::stdin()
            .take(MAX as u64)
            .read_to_string(&mut raw)
            .await
            .map_err(|_| ())?;
        let fields: std::collections::HashMap<&str, &str> =
            raw.lines().filter_map(|l| l.split_once('=')).collect();
        if fields.get("protocol") != Some(&"https") {
            return Err(());
        }
        host = fields.get("host").ok_or(())?.to_string();
        path = fields.get("path").unwrap_or(&"").to_string();
        username = fields.get("username").unwrap_or(&"").to_string();
    } else {
        if std::env::var("GH_HOST").is_err() {
            let mut git = tokio::process::Command::new("git");
            git.args(["remote", "get-url", "origin"]);
            #[cfg(windows)]
            {
                git.creation_flags(crate::winproc::CREATE_NO_WINDOW);
            }
            git.kill_on_drop(true);
            if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(2), git.output()).await {
                if out.status.success() {
                    let remote = String::from_utf8_lossy(&out.stdout);
                    if let Ok(url) = reqwest::Url::parse(remote.trim()) {
                        if let Some(h) = url.host_str() {
                            host = h.into();
                        }
                    } else if let Some((userhost, _)) = remote.trim().split_once(':') {
                        if let Some((_, h)) = userhost.split_once('@') {
                            host = h.into();
                        }
                    }
                }
            }
        }
        match gh_bridge_host(host.clone(), args) {
            Some(target) => host = target,
            None => bridge_target = false,
        }
    }
    if !valid_host(&host)
        || host.matches(':').count() > 1
        || !safe_field(&path)
        || !safe_field(&username)
    {
        if kind == "git" {
            return Err(());
        }
        bridge_target = false;
    }
    let enterprise = host != "github.com" && !host.ends_with(".ghe.com");
    let token_env = if enterprise {
        "GH_ENTERPRISE_TOKEN"
    } else {
        "GH_TOKEN"
    };
    let fallback_env = if enterprise {
        "GITHUB_ENTERPRISE_TOKEN"
    } else {
        "GITHUB_TOKEN"
    };
    let explicit = kind == "gh"
        && [token_env, fallback_env]
            .iter()
            .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
    let answer = if explicit || !bridge_target {
        vec![]
    } else {
        // Broker absence never disables the native credential path. An empty
        // Git helper answer allows the configured chain to continue; gh runs
        // its real executable below without an injected token.
        // Every failure prints one secret-free line to stderr; the native
        // credential path still runs afterwards.
        const MISCONFIGURED: &str = "Orgtree credential bridge: this process's bridge settings are missing or invalid; a new turn or CLI process gets fresh ones [misconfigured].";
        let lookup = async {
            let endpoint = std::env::var("ORGTREE_CREDENTIAL_URL").map_err(|_| MISCONFIGURED.to_string())?;
            let url = reqwest::Url::parse(&endpoint).map_err(|_| MISCONFIGURED.to_string())?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.path() != REQUEST
                || !url.username().is_empty()
                || url.query().is_some()
            {
                return Err(MISCONFIGURED.to_string());
            }
            let agent = std::env::var("ORGTREE_CREDENTIAL_AGENT")
                .ok()
                .and_then(|a| a.parse::<i64>().ok())
                .ok_or_else(|| MISCONFIGURED.to_string())?;
            let token = std::env::var("ORGTREE_CREDENTIAL_AUTH").map_err(|_| MISCONFIGURED.to_string())?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| MISCONFIGURED.to_string())?;
            let response = client
                .post(url)
                .header("x-orgtree-credential-token", token)
                .header("x-orgtree-credential-agent", agent.to_string())
                .json(&json!({"agent":agent,"kind":kind,"host":host,"path":path,"username":username}))
                .send()
                .await
                .map_err(|_| "Orgtree credential bridge: the Orgtree engine did not answer; retry in a moment [no-engine].".to_string())?;
            if !response.status().is_success() {
                // The engine's 503 body is a fixed, secret-free sentence.
                let body = response.bytes().await.unwrap_or_default();
                let line: String = String::from_utf8_lossy(&body[..body.len().min(600)])
                    .chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect();
                return Err(if line.trim().is_empty() {
                    "Orgtree credential bridge: the request failed [failed].".to_string()
                } else {
                    line.trim().to_string()
                });
            }
            let result = response
                .bytes()
                .await
                .map_err(|_| "Orgtree credential bridge: the answer was cut off; retry [truncated].".to_string())?;
            if result.is_empty() || result.len() > MAX {
                return Err("Orgtree credential bridge: the answer was empty; retry [empty].".to_string());
            }
            Ok::<Vec<u8>, String>(result.to_vec())
        }
        .await;
        match lookup {
            Ok(answer) => answer,
            Err(line) => {
                if kind == "gh" {
                    eprintln!("{line} Running gh with its own sign-in only.");
                } else {
                    eprintln!("{line}");
                }
                vec![]
            }
        }
    };
    if kind == "git" {
        tokio::io::stdout()
            .write_all(&answer)
            .await
            .map_err(|_| ())?;
        return Ok(0);
    }
    let native = gh_command(&real.ok_or(())?, args, token_env, &answer, explicit)?;
    let mut cmd = tokio::process::Command::from(native);
    #[cfg(windows)]
    {
        cmd.creation_flags(crate::winproc::CREATE_NO_WINDOW);
    }
    let status = cmd.status().await.map_err(|_| ())?;
    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}

/// Keep native gh unchanged when the broker is absent or an explicit token wins.
#[nolog]
fn gh_command(
    real: &std::path::Path,
    args: &[String],
    token_env: &str,
    answer: &[u8],
    explicit: bool,
) -> Result<std::process::Command, ()> {
    let mut cmd = std::process::Command::new(real);
    cmd.args(args);
    if !explicit && !answer.is_empty() {
        let token = std::str::from_utf8(answer).map_err(|_| ())?;
        if !safe_field(token.trim()) {
            return Err(());
        }
        cmd.env(token_env, token.trim());
    }
    Ok(cmd)
}

#[nolog]
fn pipe_busy(code: Option<i32>) -> bool {
    code == Some(231)
} // ERROR_PIPE_BUSY

#[nolog]
fn git_config_slot(value: Option<&str>) -> Option<usize> {
    match value {
        None => Some(0),
        Some(value) => value.parse::<usize>().ok().filter(|n| *n < 128),
    }
}

/// Only delete known static files in UUID boot folders, without following links.
/// An in-use Windows executable is left for the next startup; never recurse.
#[logged]
pub fn cleanup_adapters(engine: &Engine) {
    let root = engine.cfg.path("credential-adapters");
    if root
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(true)
    {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.take(256).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == engine.boot.id || uuid::Uuid::parse_str(&name).is_err() {
            continue;
        }
        if !entry
            .file_type()
            .map(|t| t.is_dir() && !t.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        let dir = entry.path();
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.take(256).flatten() {
            let name = file.file_name().to_string_lossy().into_owned();
            let known = name == "gh.exe"
                || name
                    .strip_suffix(".tmp")
                    .map(|s| uuid::Uuid::parse_str(s).is_ok())
                    .unwrap_or(false);
            if known
                && file
                    .file_type()
                    .map(|t| t.is_file() && !t.is_symlink())
                    .unwrap_or(false)
            {
                let _ = std::fs::remove_file(file.path());
            }
        }
        let _ = std::fs::remove_dir(dir);
    }
}

#[nolog]
fn gh_bridge_host(mut host: String, args: &[String]) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--hostname" | "--repo" | "-R") {
            let Some(value) = args
                .get(i + 1)
                .filter(|v| !v.is_empty() && !v.starts_with('-'))
            else {
                return None;
            };
            if arg == "--hostname" {
                host = value.clone();
            } else if value.split('/').count() == 3 {
                host = value.split('/').next().unwrap().to_string();
            }
        } else if let Some(h) = arg.strip_prefix("--hostname=") {
            host = h.into();
        } else if let Some(repo) = arg.strip_prefix("--repo=") {
            if repo.split('/').count() == 3 {
                host = repo.split('/').next().unwrap().to_string();
            }
        }
    }
    (valid_host(&host) && host.matches(':').count() <= 1).then_some(host)
}
