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
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const UNAVAILABLE: &str = "Open Orgtree in your signed-in Windows session to restore git/GitHub access. Agents keep running; no engine restart is needed.";
const MAX: usize = 65536;
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
}
#[nolog]
impl Bridge {
    pub fn new() -> Self {
        Self {
            broker: ArcSwapOption::empty(),
            grants: papaya::HashMap::new(),
            slots: tokio::sync::Semaphore::new(16),
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
        if !cfg!(windows) {
            return vec![];
        }
        let Ok(exe) = std::env::current_exe() else {
            return vec![];
        };
        // Installed version directory: no secret in these adapter files.
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
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let real_gh = std::env::split_paths(&old_path)
            .map(|p| p.join("gh.exe"))
            .find(|p| p.is_file());
        let path =
            std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&old_path)))
                .unwrap_or(old_path);
        let n = std::env::var("GIT_CONFIG_COUNT")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v < 128)
            .unwrap_or(0);
        let quoted = exe
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        let mut env = vec![
            ("ORGTREE_CREDENTIAL_TOKEN".into(), secret),
            (
                "ORGTREE_CREDENTIAL_URL".into(),
                format!("http://127.0.0.1:{}{REQUEST}", engine.boot.port),
            ),
            ("ORGTREE_CREDENTIAL_AGENT".into(), agent.to_string()),
            ("PATH".into(), path.to_string_lossy().into_owned()),
            ("GIT_CONFIG_COUNT".into(), (n + 2).to_string()),
            (format!("GIT_CONFIG_KEY_{n}"), "credential.helper".into()),
            (format!("GIT_CONFIG_VALUE_{n}"), String::new()),
            (
                format!("GIT_CONFIG_KEY_{}", n + 1),
                "credential.helper".into(),
            ),
            (
                format!("GIT_CONFIG_VALUE_{}", n + 1),
                format!("!'{}' credential-helper", quoted),
            ),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ];
        if let Some(real) = real_gh {
            env.push((
                "ORGTREE_REAL_GH".into(),
                real.to_string_lossy().into_owned(),
            ));
        }
        env
    }
}

#[nolog]
pub fn route(path: &str) -> bool {
    path == REGISTER || path == REQUEST
}

/// Entire route, including auth failures, bypasses generic body/header tracing.
#[nolog]
pub async fn dispatch(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let result = tokio::time::timeout(Duration::from_secs(10), handle(&engine, req)).await;
    match result {
        Ok(Ok(bytes)) => (
            StatusCode::OK,
            [
                ("content-type", "application/octet-stream"),
                ("cache-control", "no-store"),
            ],
            bytes,
        )
            .into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("cache-control", "no-store")],
            UNAVAILABLE,
        )
            .into_response(),
    }
}
#[nolog]
async fn handle(engine: &Engine, req: Request) -> Result<Vec<u8>, ()> {
    let _slot = engine
        .credential_bridge
        .slots
        .try_acquire()
        .map_err(|_| ())?;
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .ok_or(())?;
    if !peer.0.ip().is_loopback() || req.method() != axum::http::Method::POST {
        return Err(());
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
        return Err(());
    }
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
            return Err(());
        }
        let pid = u32::try_from(value["pid"].as_u64().ok_or(())?).map_err(|_| ())?;
        let broker = Broker {
            pipe: pipe.into(),
            secret: secret.into(),
            pid,
            expires: Instant::now() + Duration::from_secs(20),
        };
        if exchange(&broker, json!({"kind":"ping"})).await? != b"ready" {
            return Err(());
        }
        let was = engine.credential_bridge.ready();
        engine
            .credential_bridge
            .broker
            .store(Some(Arc::new(broker)));
        if !was {
            tracing::info!("Signed-in desktop git/GitHub credential bridge ready; general Windows vault remains isolated");
        }
        return Ok(b"ready".to_vec());
    }
    let agent = value["agent"].as_i64().ok_or(())?;
    let grant = engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .cloned()
        .ok_or(())?;
    if !equal(&token, &grant.secret) {
        return Err(());
    }
    let pid = grant.pid.load(Ordering::SeqCst);
    let stamp = grant.created.load(Ordering::SeqCst);
    if stamp == 0 || process_stamp(pid) != Some(stamp) {
        return Err(());
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    let exists=db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_some();
    drop(db);
    if !exists {
        return Err(());
    }
    let kind = value["kind"].as_str().ok_or(())?;
    if kind != "git" && kind != "gh" {
        return Err(());
    }
    let host = value["host"].as_str().filter(|h| valid_host(h)).ok_or(())?;
    let path = value["path"].as_str().unwrap_or("");
    let username = value["username"].as_str().unwrap_or("");
    if !safe_field(path) || !safe_field(username) {
        return Err(());
    }
    let broker = engine
        .credential_bridge
        .broker
        .load_full()
        .filter(|b| b.expires > Instant::now())
        .ok_or(())?;
    let answer = match exchange(
        &broker,
        json!({"kind":kind,"host":host,"path":path,"username":username}),
    )
    .await
    {
        Ok(answer) => answer,
        Err(()) => {
            // A missing credential is not a dead broker. Probe the channel
            // without reading a secret before withdrawing availability.
            if exchange(&broker, json!({"kind":"ping"})).await.is_err() {
                let previous = engine
                    .credential_bridge
                    .broker
                    .compare_and_swap(&Some(broker.clone()), None);
                if previous
                    .as_ref()
                    .map(|b| Arc::ptr_eq(b, &broker))
                    .unwrap_or(false)
                {
                    tracing::warn!("{UNAVAILABLE}");
                }
            }
            return Err(());
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
        return Err(());
    }
    if process_stamp(pid) != Some(stamp) {
        return Err(());
    }
    let db = engine.db.get().await.map_err(|_| ())?;
    if db.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND generation=$3 AND state='live' AND halt IS NULL", &[&agent,&grant.org,&grant.generation]).await.map_err(|_|())?.is_none() {return Err(());}
    if !engine
        .credential_bridge
        .grants
        .pin()
        .get(&agent)
        .map(|g| Arc::ptr_eq(g, &grant))
        .unwrap_or(false)
    {
        return Err(());
    }
    Ok(answer)
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

#[cfg(windows)]
#[nolog]
async fn exchange(broker: &Broker, mut request: Value) -> Result<Vec<u8>, ()> {
    use std::os::windows::io::AsRawHandle;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::ClientOptions,
    };
    let mut pipe = ClientOptions::new().open(&broker.pipe).map_err(|_| ())?;
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
        return Err(());
    }
    request["secret"] = Value::String(broker.secret.clone());
    let mut raw = serde_json::to_vec(&request).map_err(|_| ())?;
    raw.push(b'\n');
    pipe.write_all(&raw).await.map_err(|_| ())?;
    let mut result = Vec::new();
    pipe.take((MAX + 1) as u64)
        .read_to_end(&mut result)
        .await
        .map_err(|_| ())?;
    if result.len() > MAX || result.is_empty() {
        Err(())
    } else {
        Ok(result)
    }
}
#[cfg(not(windows))]
#[nolog]
async fn exchange(_: &Broker, _: Value) -> Result<Vec<u8>, ()> {
    Err(())
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
        Foundation::*, Security::Authentication::Identity::*, Security::*,
        System::RemoteDesktop::*, System::Threading::*,
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
        let mut stats: TOKEN_STATISTICS = std::mem::zeroed();
        let mut len = 0;
        let mut interactive = false;
        if GetTokenInformation(
            token,
            TokenStatistics,
            (&mut stats as *mut TOKEN_STATISTICS).cast(),
            std::mem::size_of_val(&stats) as u32,
            &mut len,
        ) != 0
        {
            let mut data = std::ptr::null_mut();
            if LsaGetLogonSessionData(&stats.AuthenticationId, &mut data) == 0 && !data.is_null() {
                interactive = matches!((*data).LogonType, 2 | 10 | 11 | 12);
                LsaFreeReturnBuffer(data.cast());
            }
        }
        CloseHandle(token);
        CloseHandle(ours);
        interactive && a.is_some() && a == b
    }
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
        Err(_) => {
            eprintln!("{UNAVAILABLE}");
            std::process::ExitCode::FAILURE
        }
    }
}
#[nolog]
async fn cli_async(kind: &str, args: &[String]) -> Result<u8, ()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut host = std::env::var("GH_HOST").unwrap_or_else(|_| "github.com".into());
    let mut path = String::new();
    let mut username = String::new();
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
        for (i, arg) in args.iter().enumerate() {
            if matches!(arg.as_str(), "--hostname" | "--repo" | "-R") {
                let value = args.get(i + 1).ok_or(())?;
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
    }
    if !valid_host(&host) || !safe_field(&path) || !safe_field(&username) {
        return Err(());
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
    let answer = if explicit {
        vec![]
    } else {
        let endpoint = std::env::var("ORGTREE_CREDENTIAL_URL").map_err(|_| ())?;
        let url = reqwest::Url::parse(&endpoint).map_err(|_| ())?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != REQUEST
            || !url.username().is_empty()
            || url.query().is_some()
        {
            return Err(());
        }
        let agent = std::env::var("ORGTREE_CREDENTIAL_AGENT")
            .map_err(|_| ())?
            .parse::<i64>()
            .map_err(|_| ())?;
        let token = std::env::var("ORGTREE_CREDENTIAL_TOKEN").map_err(|_| ())?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| ())?;
        let response = client
            .post(url)
            .header("x-orgtree-credential-token", token)
            .json(&json!({"agent":agent,"kind":kind,"host":host,"path":path,"username":username}))
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let result = response.bytes().await.map_err(|_| ())?;
        if result.is_empty() || result.len() > MAX {
            return Err(());
        }
        result.to_vec()
    };
    if kind == "git" {
        tokio::io::stdout()
            .write_all(&answer)
            .await
            .map_err(|_| ())?;
        return Ok(0);
    }
    let real = std::env::var_os("ORGTREE_REAL_GH").ok_or(())?;
    if !std::path::Path::new(&real).is_absolute() {
        return Err(());
    }
    let mut cmd = tokio::process::Command::new(real);
    cmd.args(args);
    if !explicit {
        let token = String::from_utf8(answer).map_err(|_| ())?;
        if !safe_field(token.trim()) {
            return Err(());
        }
        cmd.env(token_env, token.trim());
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(crate::winproc::CREATE_NO_WINDOW);
    }
    let status = cmd.status().await.map_err(|_| ())?;
    Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
}
