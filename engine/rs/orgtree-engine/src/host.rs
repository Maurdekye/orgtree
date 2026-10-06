//! `orgtree-engine host`: the boot-time supervisor the "Orgtree Background
//! Engine" scheduled task runs (S4U logon, the operator's own account, at
//! boot). It starts the engine — without administrator rights unless "Run
//! Orgtree as administrator" is on — waits for its `ready` line, publishes
//! the attach descriptor the desktop adopts, probes liveness, ends and
//! replaces a hung engine, and removes the descriptor when the engine exits.
//!
//! The rules are the 3.x boot host's (`engine/service_host.py`), number for
//! number: the desktop judges an engine by the same ones.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// boot is contended; the desktop's 60 s is too tight
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// between two checkpoints of a long import or conversion step
const LONG_STEP_TIMEOUT: Duration = Duration::from_secs(3600);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(10);
const DESCRIPTOR: &str = "engine-attach.json";
/// another engine or host owns the data root
const EXIT_ROOT_OWNED: u8 = 75;
/// the engine hung and its tree was proven gone: start a fresh one
const EXIT_ENGINE_HUNG: u8 = 76;
const LIVENESS_INTERVAL: Duration = Duration::from_secs(30);
const LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const LIVENESS_DEADLINE: Duration = Duration::from_secs(300);
const LIVENESS_MIN_FAILURES: u32 = 3;
const HUNG_RELEASE_WAIT: Duration = Duration::from_secs(30);
const HUNG_RESTART_LIMIT: usize = 3;
const HUNG_RESTART_WINDOW: Duration = Duration::from_secs(3600);

static STOP: AtomicBool = AtomicBool::new(false);

pub fn run() -> ExitCode {
    install_stop_handler();
    let mut hangs: Vec<Instant> = Vec::new();
    loop {
        let code = once();
        if code != EXIT_ENGINE_HUNG {
            return ExitCode::from(code);
        }
        let now = Instant::now();
        hangs.retain(|t| now.duration_since(*t) < HUNG_RESTART_WINDOW);
        hangs.push(now);
        if hangs.len() > HUNG_RESTART_LIMIT {
            say(None, &format!("{} hung engines within an hour; not restarting again", hangs.len()));
            return ExitCode::from(code);
        }
        say(None, "starting a fresh engine after a hung one");
    }
}

/// A line for whoever reads the task's output, and the boot host's own log.
fn say(root: Option<&Path>, msg: &str) {
    eprintln!("boot host: {msg}");
    let root = root.map(Path::to_path_buf).or_else(|| data_root().ok());
    if let Some(r) = root {
        let dir = r.join("diagnostics");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("boot-host.log")) {
            let _ = writeln!(f, "{} pid {} {msg}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"), std::process::id());
        }
    }
}

/// The same default the desktop resolves, without Electron present.
#[logged]
fn data_root() -> Result<PathBuf, String> {
    if let Some(v) = std::env::var_os("ORGTREE_V2_DATA").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(v));
    }
    let appdata = std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| {
        // an S4U logon may start without profile variables
        std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()).map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
    });
    appdata.map(|a| a.join("Orgtree v2").join("data")).ok_or_else(|| "neither ORGTREE_V2_DATA, APPDATA nor USERPROFILE is set".into())
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

#[logged]
fn ui_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("ORGTREE_V2_UI_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| exe_dir().join("..").join("ui"));
    if dir.join("index.html").is_file() {
        Ok(dir)
    } else {
        Err(format!("UI directory has no index.html: {}", dir.display()))
    }
}

/// Comparable form of a path (`\\?\` and case dropped).
fn canon(p: &Path) -> String {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    c.to_string_lossy().trim_start_matches(r"\\?\").trim_end_matches('\\').to_lowercase()
}

/// What the packaged desktop gives its engine: the bundled PostgreSQL, and
/// permission to create the cluster on a fresh data folder. Only beside an
/// installed app (`resources/app.asar`).
#[logged]
fn packaged_postgres() -> Result<Vec<(String, String)>, String> {
    let dir = exe_dir();
    if !dir.join("..").join("app.asar").is_file() {
        return Ok(Vec::new());
    }
    let custodian = dir.join("pg-custodian.exe");
    let bin = dir.join("postgresql").join("bin");
    for f in [custodian.clone(), bin.join("postgres.exe"), bin.join("pg_ctl.exe"), bin.join("initdb.exe"), bin.join("psql.exe"), bin.join("pg_controldata.exe")] {
        if !f.is_file() {
            return Err(format!("packaged PostgreSQL executable is missing: {}", f.display()));
        }
    }
    Ok(vec![
        ("ORGTREE_PG_CUSTODIAN".into(), custodian.to_string_lossy().to_string()),
        ("ORGTREE_P03_PG_BIN".into(), bin.to_string_lossy().to_string()),
        ("ORGTREE_PG_BOOTSTRAP".into(), "1".into()),
    ])
}

// ------------------------------------------------------------ a tiny loopback HTTP client

struct Answer {
    status: u16,
    body: Value,
}

/// One request to the engine on 127.0.0.1 (the token never leaves this
/// machine; no proxy, no TLS).
fn http(port: u16, method: &str, path: &str, token: &str, timeout: Duration) -> Result<Answer, String> {
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, timeout.min(Duration::from_secs(5))).map_err(|e| format!("connect: {e}"))?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Orgtree-Desktop-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).map_err(|e| format!("read: {e}"))?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no response headers")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut body = raw[split + 4..].to_vec();
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("no status")?;
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = Vec::new();
        let mut rest = &body[..];
        while let Some(nl) = rest.windows(2).position(|w| w == b"\r\n") {
            let n = usize::from_str_radix(String::from_utf8_lossy(&rest[..nl]).trim(), 16).unwrap_or(0);
            if n == 0 || rest.len() < nl + 2 + n {
                break;
            }
            out.extend_from_slice(&rest[nl + 2..nl + 2 + n]);
            rest = &rest[(nl + 4 + n).min(rest.len())..];
        }
        body = out;
    }
    Ok(Answer { status, body: serde_json::from_slice(&body).unwrap_or(Value::Null) })
}

// ------------------------------------------------------------ the attach descriptor

fn read_descriptor(root: &Path) -> Option<Value> {
    std::fs::read_to_string(root.join(DESCRIPTOR)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

/// A leftover descriptor is stale — unless its engine still answers as this
/// root, in which case another host owns it and this one must not start.
#[logged]
fn clear_stale_descriptor(root: &Path) -> Result<(), String> {
    let path = root.join(DESCRIPTOR);
    if !path.exists() {
        return Ok(());
    }
    if let Some(d) = read_descriptor(root) {
        let port = d["port"].as_u64().filter(|p| (1..=65535).contains(p)).map(|p| p as u16);
        if let (Some(port), Some(token)) = (port, d["token"].as_str()) {
            if let Ok(a) = http(port, "GET", "/api/desktop/identity", token, Duration::from_secs(3)) {
                let same = a.status == 200
                    && a.body["protocol"] == json!(1)
                    && a.body["dataRootId"].as_str().map(|r| canon(Path::new(r)) == canon(root)).unwrap_or(false);
                if same {
                    return Err("another boot host already serves this data root".into());
                }
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Remove only OUR descriptor; a newer host's file must survive us.
#[logged]
fn remove_descriptor(root: &Path) {
    if read_descriptor(root).map(|d| d["hostPid"] == json!(std::process::id())).unwrap_or(false) {
        let _ = std::fs::remove_file(root.join(DESCRIPTOR));
    }
}

/// Publish the descriptor with its token never readable by anyone else at
/// any instant: the temporary is born with an owner-only DACL and no
/// sharing, the DACL is read back, and the publish is an atomic rename.
fn write_descriptor(root: &Path, port: u16, engine_pid: u32, token: &str) -> Result<(), String> {
    let sid = win::user_sid().ok_or("the operator's SID could not be read")?;
    let payload = json!({
        "type": "attach", "protocol": 1, "port": port, "enginePid": engine_pid, "hostPid": std::process::id(),
        "dataRootId": root.to_string_lossy(), "token": token,
        "startedAt": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    });
    let tmp = root.join(format!(".engine-attach-{}-{}.tmp", std::process::id(), crate::util::random_hex(8)));
    let done = (|| {
        let mut f = win::create_protected(&tmp, &sid)?;
        f.write_all((payload.to_string() + "\n").as_bytes()).map_err(|e| format!("write: {e}"))?;
        drop(f);
        if !win::verify_restricted(&tmp, &sid) {
            return Err("descriptor ACL unverified after protected creation; refusing to publish the token".to_string());
        }
        std::fs::rename(&tmp, root.join(DESCRIPTOR)).map_err(|e| format!("publish: {e}"))
    })();
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

// ------------------------------------------------------------ one engine

/// Has the root lock been released (the engine tree really gone)?
#[logged]
fn root_released(root: &Path, within: Duration) -> bool {
    let lock = root.join(".desktop-engine.lock");
    let deadline = Instant::now() + within;
    loop {
        let ok = std::fs::OpenOptions::new().read(true).write(true).open(&lock).and_then(|mut f| f.write_all(b"0")).is_ok();
        if ok || !lock.exists() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Kill a launch that failed (or hung) and prove its root is usable again. A
/// refusal (another owner) is never waited on.
#[logged]
fn end_engine(child: &win::Child, root: &Path, refused: bool, within: Duration) -> bool {
    if child.exit_code().is_none() {
        child.kill_tree();
    }
    if !child.wait(Duration::from_secs(10)) {
        return false;
    }
    refused || root_released(root, within)
}

fn record_liveness(root: &Path, event: Value) {
    let mut line = json!({ "at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string() });
    if let (Some(l), Some(e)) = (line.as_object_mut(), event.as_object()) {
        for (k, v) in e {
            l.insert(k.clone(), v.clone());
        }
    }
    let path = root.join("diagnostics").join("engine-liveness.jsonl");
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(root));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
    say(Some(root), &line.to_string());
}

/// Run ONE engine until it exits, is stopped, or hangs.
fn once() -> u8 {
    let root = match data_root() {
        Ok(r) => r,
        Err(e) => {
            say(None, &e);
            return 1;
        }
    };
    let _ = std::fs::create_dir_all(&root);
    let ui = match ui_dir() {
        Ok(u) => u,
        Err(e) => {
            say(Some(&root), &e);
            return 1;
        }
    };
    if let Err(e) = clear_stale_descriptor(&root) {
        say(Some(&root), &e);
        return EXIT_ROOT_OWNED;
    }
    let pg = match packaged_postgres() {
        Ok(v) => v,
        Err(e) => {
            say(Some(&root), &e);
            return 1;
        }
    };
    let token = crate::util::random_hex(32);
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| !["ORGTREE_PORT", "ORGTREE_BASE", "ORGTREE_PG_BOOTSTRAP", "ELECTRON_RUN_AS_NODE"].contains(&k.as_str()))
        .collect();
    // profile variables an S4U logon can leave unset (the provider CLIs read them)
    if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for (k, v) in [
            ("APPDATA", profile.join("AppData").join("Roaming")),
            ("LOCALAPPDATA", profile.join("AppData").join("Local")),
            ("HOME", profile.clone()),
        ] {
            if !env.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)) {
                env.push((k.into(), v.to_string_lossy().to_string()));
            }
        }
    }
    env.retain(|(k, _)| !["ORGTREE_DATA", "ORGTREE_V2_TOKEN", "ORGTREE_V2_UI_DIR", "ORGTREE_V2_PARENT_PID"].contains(&k.as_str()));
    env.push(("ORGTREE_DATA".into(), root.to_string_lossy().to_string()));
    env.push(("ORGTREE_V2_TOKEN".into(), token.clone()));
    env.push(("ORGTREE_V2_UI_DIR".into(), ui.to_string_lossy().to_string()));
    // the engine watches this host: if the task is ended, the engine stops
    env.push(("ORGTREE_V2_PARENT_PID".into(), std::process::id().to_string()));
    env.extend(pg);
    let elevated = win::is_elevated();
    let as_admin = win::run_as_administrator();
    if as_admin {
        say(Some(&root), "'Run Orgtree as administrator' is on; the engine keeps this host's rights");
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("orgtree-engine.exe"));
    let (child, reader) = match win::spawn(&exe, &["serve"], &env, &exe_dir(), elevated && !as_admin) {
        Ok(c) => c,
        Err(e) => {
            say(Some(&root), &format!("could not start the engine: {e}"));
            return 1;
        }
    };
    let pid = child.pid;
    // the ready handshake, on its own thread (the pipe must keep draining)
    let state = Arc::new(Handshake::default());
    {
        let state = state.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            let Some(out) = reader else { return };
            let mut lines = BufReader::new(out);
            let mut line = String::new();
            loop {
                line.clear();
                match lines.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if state.done.load(Ordering::SeqCst) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                match v["type"].as_str() {
                    Some("startup-progress") => {
                        let long = v["phase"].as_str().map(|p| p.starts_with("database-convert") || p.contains("import")).unwrap_or(false);
                        state.long.store(long, Ordering::SeqCst);
                        state.touch();
                    }
                    Some("refused") => {
                        let code = v["code"].as_str().unwrap_or("");
                        state.refused.store(code == "root-owned", Ordering::SeqCst);
                        let _ = state.failure.set(format!("refused: {code} {}", v["reason"].as_str().unwrap_or("")));
                        state.done.store(true, Ordering::SeqCst);
                    }
                    Some("ready") => {
                        let ok = v["protocol"] == json!(1)
                            && v["pid"] == json!(pid)
                            && v["dataRootId"].as_str().map(|r| canon(Path::new(r)) == canon(&root)).unwrap_or(false);
                        match v["port"].as_u64().filter(|p| ok && (1..=65535).contains(p)) {
                            Some(p) => state.port.store(p as u32, Ordering::SeqCst),
                            None => {
                                let _ = state.failure.set("invalid engine readiness".into());
                            }
                        }
                        state.done.store(true, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
        });
    }
    loop {
        if state.done.load(Ordering::SeqCst) || child.exit_code().is_some() {
            break;
        }
        if STOP.load(Ordering::SeqCst) {
            end_engine(&child, &root, false, Duration::from_secs(10));
            say(Some(&root), "stopped before readiness");
            return 0;
        }
        let window = if state.long.load(Ordering::SeqCst) { LONG_STEP_TIMEOUT } else { READY_TIMEOUT };
        if state.silent_for() > window {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let port = state.port.load(Ordering::SeqCst) as u16;
    if port == 0 {
        let refused = state.refused.load(Ordering::SeqCst);
        let reason = state.failure.get().cloned().unwrap_or_else(|| {
            if child.exit_code().is_some() { "engine exited before readiness".into() } else { "engine did not become ready in time".into() }
        });
        let released = end_engine(&child, &root, refused, Duration::from_secs(10));
        say(Some(&root), &format!("{reason}{}", if released { "" } else { "; engine tree release could not be verified" }));
        return if refused { EXIT_ROOT_OWNED } else { 1 };
    }
    if let Err(e) = write_descriptor(&root, port, pid, &token) {
        say(Some(&root), &format!("could not write the attach descriptor: {e}"));
        end_engine(&child, &root, false, Duration::from_secs(10));
        return 1;
    }
    say(Some(&root), &format!("engine ready on 127.0.0.1:{port} (pid {pid})"));
    let watch = Arc::new(Liveness::new());
    {
        let watch = watch.clone();
        let root = root.clone();
        let token = token.clone();
        std::thread::spawn(move || loop {
            if watch.stopped.load(Ordering::SeqCst) {
                break;
            }
            let ok = match http(port, "GET", "/api/desktop/alive", &token, LIVENESS_PROBE_TIMEOUT) {
                Ok(a) => {
                    a.status == 200
                        && a.body["pid"] == json!(pid)
                        && a.body["dataRootId"].as_str().map(|r| canon(Path::new(r)) == canon(&root)).unwrap_or(false)
                }
                Err(_) => false,
            };
            watch.note(ok);
            std::thread::sleep(LIVENESS_INTERVAL);
        });
    }
    let mut stopping = false;
    let code = loop {
        if let Some(c) = child.exit_code() {
            break Some(c);
        }
        if !stopping && STOP.load(Ordering::SeqCst) {
            stopping = true;
            let _ = http(port, "POST", "/api/desktop/shutdown", &token, Duration::from_secs(5));
            if !child.wait(SHUTDOWN_WAIT) {
                child.kill_tree();
                child.wait(Duration::from_secs(10));
            }
            break child.exit_code();
        }
        if watch.hung() {
            record_liveness(&root, json!({ "event": "hung", "enginePid": pid, "silentSeconds": watch.silent_for().as_secs(),
                                            "failedProbes": watch.failures.load(Ordering::SeqCst) }));
            let released = end_engine(&child, &root, false, HUNG_RELEASE_WAIT);
            record_liveness(&root, json!({ "event": "killed", "enginePid": pid, "released": released }));
            watch.stopped.store(true, Ordering::SeqCst);
            if child.exit_code().is_some() {
                remove_descriptor(&root);
            }
            return if released { EXIT_ENGINE_HUNG } else { 1 };
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    watch.stopped.store(true, Ordering::SeqCst);
    // removal MEANS the engine exited; an unconfirmed kill leaves it
    if child.exit_code().is_some() {
        remove_descriptor(&root);
    }
    if stopping {
        // a requested stop exits 0, so restart-on-failure does not resurrect it
        return 0;
    }
    match code {
        Some(0) | None => 0,
        Some(c) => u8::try_from(c).unwrap_or(1).max(1),
    }
}

/// The ready handshake's shared state (atomics; the failure text is set once).
#[derive(Default)]
struct Handshake {
    done: AtomicBool,
    refused: AtomicBool,
    long: AtomicBool,
    port: AtomicU32,
    /// milliseconds since the host started, at the last checkpoint
    last: AtomicU64,
    failure: std::sync::OnceLock<String>,
}

impl Handshake {
    fn touch(&self) {
        self.last.store(since_start().as_millis() as u64, Ordering::SeqCst);
    }
    fn silent_for(&self) -> Duration {
        since_start().saturating_sub(Duration::from_millis(self.last.load(Ordering::SeqCst)))
    }
}

fn since_start() -> Duration {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed()
}

/// HUNG needs both a long silence and several failed probes: one slow
/// answer is contention, not a hang.
struct Liveness {
    last_ok: AtomicU64,
    failures: AtomicU32,
    stopped: AtomicBool,
}

impl Liveness {
    fn new() -> Liveness {
        Liveness { last_ok: AtomicU64::new(since_start().as_millis() as u64), failures: AtomicU32::new(0), stopped: AtomicBool::new(false) }
    }
    fn note(&self, ok: bool) {
        if ok {
            self.last_ok.store(since_start().as_millis() as u64, Ordering::SeqCst);
            self.failures.store(0, Ordering::SeqCst);
        } else {
            self.failures.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn silent_for(&self) -> Duration {
        since_start().saturating_sub(Duration::from_millis(self.last_ok.load(Ordering::SeqCst)))
    }
    fn hung(&self) -> bool {
        self.failures.load(Ordering::SeqCst) >= LIVENESS_MIN_FAILURES && self.silent_for() >= LIVENESS_DEADLINE
    }
}

#[cfg(windows)]
fn install_stop_handler() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    unsafe extern "system" fn handler(_ctrl: u32) -> i32 {
        STOP.store(true, Ordering::SeqCst);
        1
    }
    unsafe {
        SetConsoleCtrlHandler(Some(handler), 1);
    }
}

#[cfg(not(windows))]
fn install_stop_handler() {}

// ------------------------------------------------------------ Windows

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        CheckTokenMembership, CreateRestrictedToken, GetSecurityDescriptorDacl, GetSidSubAuthority, GetSidSubAuthorityCount,
        GetTokenInformation, SetTokenInformation, TokenDefaultDacl, TokenIntegrityLevel, TokenUser, DISABLE_MAX_PRIVILEGE, PSID,
        SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, TOKEN_ALL_ACCESS, TOKEN_DEFAULT_DACL, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY};
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, TerminateProcess,
        WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    const SE_GROUP_INTEGRITY: u32 = 0x20;
    const HIGH_RID: u32 = 0x3000;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_path(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    unsafe fn token_info(token: HANDLE, class: i32) -> Option<Vec<u8>> {
        let mut size = 0u32;
        GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut size);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if GetTokenInformation(token, class, buf.as_mut_ptr() as *mut c_void, size, &mut size) == 0 {
            return None;
        }
        Some(buf)
    }

    unsafe fn own_token(access: u32) -> Option<Owned> {
        let mut t: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), access, &mut t) == 0 {
            return None;
        }
        Some(Owned(t))
    }

    unsafe fn sid_string(sid: PSID) -> Option<String> {
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut text) == 0 {
            return None;
        }
        let mut n = 0;
        while *text.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
        LocalFree(text as *mut c_void);
        Some(s)
    }

    unsafe fn string_sid(text: &str) -> Option<PSID> {
        let w = wide(text);
        let mut sid: PSID = std::ptr::null_mut();
        if ConvertStringSidToSidW(w.as_ptr(), &mut sid) == 0 {
            return None;
        }
        Some(sid)
    }

    /// This account's SID (`S-1-5-21-…`).
    pub fn user_sid() -> Option<String> {
        unsafe {
            let t = own_token(TOKEN_QUERY)?;
            let buf = token_info(t.0, TokenUser)?;
            let sa = &*(buf.as_ptr() as *const SID_AND_ATTRIBUTES);
            sid_string(sa.Sid)
        }
    }

    fn integrity_rid(token: HANDLE) -> u32 {
        unsafe {
            let Some(buf) = token_info(token, TokenIntegrityLevel) else { return 0 };
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let count = *GetSidSubAuthorityCount(label.Label.Sid) as u32;
            if count == 0 {
                return 0;
            }
            *GetSidSubAuthority(label.Label.Sid, count - 1)
        }
    }

    /// Administrators enabled, or a High label (TokenElevation alone is not
    /// the test: it still answers yes for the restricted child token).
    pub fn is_elevated() -> bool {
        unsafe {
            let Some(admins) = string_sid("S-1-5-32-544") else { return false };
            let mut member = 0i32;
            let ok = CheckTokenMembership(std::ptr::null_mut(), admins, &mut member);
            LocalFree(admins as *mut c_void);
            let high = own_token(TOKEN_QUERY).map(|t| integrity_rid(t.0) >= HIGH_RID).unwrap_or(false);
            (ok != 0 && member != 0) || high
        }
    }

    /// "Run Orgtree as administrator": HKLM (admin-writable only), exactly DWORD 1.
    pub fn run_as_administrator() -> bool {
        unsafe {
            let key = wide(r"SOFTWARE\Orgtree\Runtime");
            let name = wide("RunAsAdministrator");
            let mut value = 0u32;
            let mut size = 4u32;
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
                std::ptr::null_mut(),
                &mut value as *mut u32 as *mut c_void,
                &mut size,
            ) == 0
                && value == 1
        }
    }

    /// A restricted copy of this process's token for a normal-user child:
    /// Administrators and Power Users deny-only, Medium label, a default DACL
    /// for the user, SYSTEM and Administrators.
    unsafe fn restricted_medium_token() -> Result<Owned, String> {
        let own = own_token(TOKEN_ALL_ACCESS).ok_or("could not open this process's token")?;
        let user = {
            let buf = token_info(own.0, TokenUser).ok_or("could not read the token's user")?;
            sid_string((*(buf.as_ptr() as *const SID_AND_ATTRIBUTES)).Sid).ok_or("could not read the token's user")?
        };
        let admins = string_sid("S-1-5-32-544").ok_or("could not build a SID")?;
        let power = string_sid("S-1-5-32-547").ok_or("could not build a SID")?;
        let deny = [SID_AND_ATTRIBUTES { Sid: admins, Attributes: 0 }, SID_AND_ATTRIBUTES { Sid: power, Attributes: 0 }];
        let mut new: HANDLE = std::ptr::null_mut();
        let ok = CreateRestrictedToken(own.0, DISABLE_MAX_PRIVILEGE, 2, deny.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null(), &mut new);
        LocalFree(admins as *mut c_void);
        LocalFree(power as *mut c_void);
        if ok == 0 {
            return Err("could not create a restricted token".into());
        }
        let new = Owned(new);
        let medium = string_sid("S-1-16-8192").ok_or("could not build a SID")?;
        let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: medium, Attributes: SE_GROUP_INTEGRITY } };
        let ok = SetTokenInformation(new.0, TokenIntegrityLevel, &label as *const _ as *const c_void, std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32);
        LocalFree(medium as *mut c_void);
        if ok == 0 {
            return Err("could not lower the token to Medium integrity".into());
        }
        let sddl = wide(&format!("D:(A;;GA;;;{user})(A;;GA;;;SY)(A;;GA;;;BA)"));
        let mut sd: *mut c_void = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err("could not build the default DACL".into());
        }
        let mut present = 0i32;
        let mut defaulted = 0i32;
        let mut dacl = std::ptr::null_mut();
        let got = GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted);
        let dd = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
        let set = got != 0 && SetTokenInformation(new.0, TokenDefaultDacl, &dd as *const _ as *const c_void, std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32) != 0;
        LocalFree(sd);
        if !set {
            return Err("could not set the default DACL".into());
        }
        Ok(new)
    }

    pub struct Child {
        pub pid: u32,
        process: Owned,
    }
    unsafe impl Send for Child {}
    unsafe impl Sync for Child {}

    impl Child {
        pub fn exit_code(&self) -> Option<u32> {
            unsafe {
                if WaitForSingleObject(self.process.0, 0) != WAIT_OBJECT_0 {
                    return None;
                }
                let mut code = 0u32;
                GetExitCodeProcess(self.process.0, &mut code);
                Some(code)
            }
        }
        pub fn wait(&self, within: Duration) -> bool {
            unsafe { WaitForSingleObject(self.process.0, within.as_millis().min(u32::MAX as u128 - 1) as u32) == WAIT_OBJECT_0 }
        }
        /// End the engine and everything it started.
        pub fn kill_tree(&self) {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            unsafe {
                TerminateProcess(self.process.0, 1);
            }
        }
    }

    /// Start `exe args…` with this environment, stdout piped to us, stdin
    /// and stderr on NUL; `restricted` runs it without administrator rights.
    pub fn spawn(exe: &Path, args: &[&str], env: &[(String, String)], cwd: &Path, restricted: bool) -> Result<(Child, Option<File>), String> {
        unsafe {
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: std::ptr::null_mut(), bInheritHandle: 1 };
            let mut read: HANDLE = std::ptr::null_mut();
            let mut write: HANDLE = std::ptr::null_mut();
            if CreatePipe(&mut read, &mut write, &sa, 0) == 0 {
                return Err("could not create the readiness pipe".into());
            }
            let read = Owned(read);
            let write = Owned(write);
            SetHandleInformation(read.0, HANDLE_FLAG_INHERIT, 0);
            let nul_name = wide("NUL");
            let nul = Owned(CreateFileW(nul_name.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, std::ptr::null_mut()));
            if nul.0 == INVALID_HANDLE_VALUE {
                return Err("could not open NUL".into());
            }
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = nul.0;
            si.hStdOutput = write.0;
            si.hStdError = nul.0;
            let mut line = format!("\"{}\"", exe.display());
            for a in args {
                line.push(' ');
                line.push_str(a);
            }
            let mut cmd = wide(&line);
            let mut vars: Vec<&(String, String)> = env.iter().collect();
            vars.sort_by_key(|(k, _)| k.to_uppercase());
            let mut block: Vec<u16> = Vec::new();
            for (k, v) in vars {
                if k.is_empty() || k[1..].contains('=') || k.contains('\0') || v.contains('\0') {
                    continue;
                }
                block.extend(std::ffi::OsStr::new(&format!("{k}={v}")).encode_wide());
                block.push(0);
            }
            block.push(0);
            let cwd = wide_path(cwd);
            let flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = if restricted {
                let token = restricted_medium_token()?;
                CreateProcessAsUserW(
                    token.0,
                    std::ptr::null(),
                    cmd.as_mut_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                    flags,
                    block.as_ptr() as *const c_void,
                    cwd.as_ptr(),
                    &si,
                    &mut pi,
                )
            } else {
                CreateProcessW(
                    std::ptr::null(),
                    cmd.as_mut_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                    flags,
                    block.as_ptr() as *const c_void,
                    cwd.as_ptr(),
                    &si,
                    &mut pi,
                )
            };
            if ok == 0 {
                return Err(format!("CreateProcess failed (Windows error {})", std::io::Error::last_os_error()));
            }
            CloseHandle(pi.hThread);
            drop(write);
            drop(nul);
            let out = File::from_raw_handle(read.0 as _);
            std::mem::forget(read);
            Ok((Child { pid: pi.dwProcessId, process: Owned(pi.hProcess) }, Some(out)))
        }
    }

    /// A new file born with an owner-only DACL and no sharing (no instant
    /// exists in which anyone else could open it).
    pub fn create_protected(path: &Path, sid: &str) -> Result<File, String> {
        unsafe {
            let sddl = wide(&format!("O:{sid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})"));
            let mut sd: *mut c_void = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
                return Err("could not build the descriptor's security".into());
            }
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
            let p = wide_path(path);
            let h = CreateFileW(p.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut());
            LocalFree(sd);
            if h == INVALID_HANDLE_VALUE {
                return Err(format!("could not create {}: {}", path.display(), std::io::Error::last_os_error()));
            }
            Ok(File::from_raw_handle(h as _))
        }
    }

    /// Read back that the owner is the operator and the DACL is exactly
    /// operator + SYSTEM + Administrators with nothing inherited.
    pub fn verify_restricted(path: &Path, sid: &str) -> bool {
        let script = format!(
            "$acl=Get-Acl -LiteralPath '{}';$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);\
             Write-Output ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value+'|'+(@($rules | ForEach-Object {{ $_.IdentityReference.Value }}) -join ',')+'|'+@($rules | Where-Object {{ $_.IsInherited }}).Count)",
            path.display().to_string().replace('\'', "''")
        );
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let Ok(out) = cmd.output() else { return false };
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let parts: Vec<&str> = text.split('|').collect();
        if parts.len() != 3 {
            return false;
        }
        let sids: std::collections::BTreeSet<&str> = parts[1].split(',').collect();
        let want: std::collections::BTreeSet<&str> = [sid, "S-1-5-18", "S-1-5-32-544"].into_iter().collect();
        parts[0] == sid && parts[2] == "0" && sids == want
    }
}

#[cfg(not(windows))]
mod win {
    use std::fs::File;
    use std::path::Path;
    use std::time::Duration;
    pub struct Child {
        pub pid: u32,
    }
    impl Child {
        pub fn exit_code(&self) -> Option<u32> {
            Some(1)
        }
        pub fn wait(&self, _within: Duration) -> bool {
            true
        }
        pub fn kill_tree(&self) {}
    }
    pub fn user_sid() -> Option<String> {
        None
    }
    pub fn is_elevated() -> bool {
        false
    }
    pub fn run_as_administrator() -> bool {
        false
    }
    pub fn spawn(_exe: &Path, _args: &[&str], _env: &[(String, String)], _cwd: &Path, _restricted: bool) -> Result<(Child, Option<File>), String> {
        Err("the boot host runs on Windows only".into())
    }
    pub fn create_protected(_path: &Path, _sid: &str) -> Result<File, String> {
        Err("unsupported".into())
    }
    pub fn verify_restricted(_path: &Path, _sid: &str) -> bool {
        false
    }
}
