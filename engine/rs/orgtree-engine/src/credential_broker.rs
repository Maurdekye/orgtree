//! `orgtree-credential-broker`: the sign-in credential broker (Windows only).
//!
//! The boot engine runs under an S4U logon and cannot read the user's signed-in
//! credentials. The desktop's Electron main brokers them over the credential
//! bridge (docs/rust-engine/credential-bridge.md) while it runs; this small,
//! windowless process does the same from Windows sign-in, so git HTTPS and gh
//! keep working after the user quits the app (DECISIONS 51, superseded in part
//! by the user 2026-10-10). The "Orgtree Credential Helper" scheduled task
//! starts it at the operator's logon with an interactive token.
//!
//! It speaks the desktop broker's exact pipe protocol and registers the same
//! 20-second lease with the same desktop token, and the engine checks it
//! exactly as it checks the desktop (pipe server PID, same SID, INTERACTIVE,
//! nonzero session). One broker holds the bridge at a time; the other is told
//! `held` and retries on its next poll.
//!
//! Every function here handles the broker secret, the desktop token or a
//! credential, or sits on that path, so all of them are `#[nolog]` and this
//! binary has no tracing. Its only log is a short, secret-free event file,
//! `credential-broker.log`, in the data root. Nothing secret is logged,
//! persisted, put in argv, or derived Serialize/Debug.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[macro_use]
extern crate orgtree_logged;

use std::process::ExitCode;

#[cfg(windows)]
#[path = "credential_broker_host.rs"]
mod codex_host;
#[cfg(windows)]
#[allow(dead_code, unused_imports)] // shared process probe API; broker needs only reads
mod core_process;
#[cfg(windows)]
#[allow(dead_code)] // journal mutations also used by the engine/native desktop probe
mod core_state;

#[cfg(not(windows))]
#[nolog]
fn main() -> ExitCode {
    eprintln!("orgtree-credential-broker runs on Windows only");
    ExitCode::from(2)
}

#[cfg(windows)]
#[nolog]
fn main() -> ExitCode {
    win::run()
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use rand::Rng;
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_AND_ATTRIBUTES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken, CREATE_NO_WINDOW};

    const MAX: usize = 65536;
    const DESCRIPTOR: &str = "engine-attach.json";
    const LOG: &str = "credential-broker.log";
    const LOG_CAP: u64 = 256 * 1024;
    const TICK: Duration = Duration::from_secs(5);
    const TOKEN_HEADER: &str = "X-Orgtree-Desktop-Token";
    /// The desktop's masks (apps/desktop/main/policy.ts verifyDescriptorTrust):
    /// the file and its folder must not be writable by anyone else; above
    /// that, nobody else may be able to replace a path component.
    const WRITE_MASK: u32 = 0x116 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x1000_0000 | 0x4000_0000;
    const REPLACE_MASK: u32 = 0x10000 | 0x40 | 0x40000 | 0x80000 | 0x1000_0000;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    #[nolog]
    pub fn run() -> ExitCode {
        let Some(root) = data_root() else { return ExitCode::from(2) };
        // One broker per session and data root: a second start (a re-run
        // task) just leaves; another data root (a test rig) has its own.
        let key = root.to_string_lossy().to_lowercase().bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3));
        let name = wide(&format!("Local\\OrgtreeCredentialBroker-{key:016x}"));
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if mutex.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return ExitCode::SUCCESS;
        }
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(r) => r,
            Err(_) => return ExitCode::from(1),
        };
        let code = runtime.block_on(serve(root));
        unsafe { CloseHandle(mutex) };
        code
    }

    /// The desktop's and the boot host's data root: ORGTREE_V2_DATA, else
    /// %APPDATA%\Orgtree v2\data.
    #[nolog]
    fn data_root() -> Option<PathBuf> {
        if let Some(v) = std::env::var_os("ORGTREE_V2_DATA").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(v));
        }
        std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()).map(|p| PathBuf::from(p).join("AppData").join("Roaming")))
            .map(|a| a.join("Orgtree v2").join("data"))
    }

    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

    /// The hosted-Codex kill record (`codex-force-kill` / `codex-graceful-exit`),
    /// flushed to disk at once: a forced Codex end can crash lsass and reboot
    /// Windows within seconds (docket urgent-orgtree-s-hard-killing-of-codex-processes).
    #[nolog]
    fn write_events() {
        let lines: Vec<String> = std::mem::take(&mut *crate::codex_host::EVENTS.lock().unwrap_or_else(|p| p.into_inner()));
        let Some(root) = ROOT.get() else { return };
        if lines.is_empty() {
            return;
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(root.join(LOG)) {
            for l in lines {
                let _ = writeln!(f, "{} pid {} {}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"), std::process::id(), l);
            }
            let _ = f.sync_data();
        }
    }

    /// Secret-free events only: never a token, secret, pipe name or credential.
    #[nolog]
    fn note(root: &Path, event: &str) {
        use std::io::Write;
        let path = root.join(LOG);
        if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{} pid {} {}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"), std::process::id(), event);
        }
    }

    #[nolog]
    async fn serve(root: PathBuf) -> ExitCode {
        let _ = ROOT.set(root.clone());
        let _ = crate::codex_host::FLUSH.set(write_events);
        let secret: Arc<str> = random_hex(32).into();
        let pipe = format!(r"\\.\pipe\orgtree-credentials-{}-{}", std::process::id(), random_hex(16));
        let first = match ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&pipe) {
            Ok(s) => s,
            Err(_) => {
                note(&root, "could not open its pipe; exiting");
                return ExitCode::from(1);
            }
        };
        note(&root, &format!("started (orgtree-credential-broker {})", env!("CARGO_PKG_VERSION")));
        tokio::spawn(accept(first, pipe.clone(), secret.clone()));
        let mut engine: Option<Attached> = None;
        let mut last = "";
        let mut hosted_before = 0usize;
        let mut last_host_status = None;
        let mut core_sessions = crate::core_process::Sessions::new();
        loop {
            if let Some(active) = crate::core_state::sessions(&root, &mut core_sessions) {
                if let Some(state) = crate::core_state::read(&root) {
                    crate::core_state::observe_engine(&root, &state, &active);
                }
                if crate::core_state::blocked(&root, &active) {
                    // The engine drains its hosted CLIs first. If it died, sweep
                    // gives broken stdin its existing grace and logs any force.
                    if crate::codex_host::sweep() == 0 {
                        write_events();
                        note(&root, "core session stopped; exiting");
                        return ExitCode::SUCCESS;
                    }
                    write_events();
                    tokio::time::sleep(TICK).await;
                    continue;
                }
            }
            if engine.is_none() {
                match attach(&root).await {
                    Ok(a) => {
                        if last != "attached" {
                            note(&root, &format!("attached to engine pid {}", a.engine_pid));
                            last = "attached";
                        }
                        crate::codex_host::ENGINE_PID.store(a.engine_pid as u32, Ordering::SeqCst);
                        engine = Some(a);
                    }
                    Err(why) => {
                        if last != why {
                            note(&root, &format!("no engine to serve: {why}"));
                            last = why;
                        }
                    }
                }
            }
            if let Some(a) = &engine {
                // Independent lease: keep hosting even while the desktop owns credentials.
                let host_status = register(a, &pipe, &secret, "host").await;
                if last_host_status != Some(host_status) {
                    match host_status {
                        Ok(200) => note(&root, "holding the Codex host slot"),
                        Ok(409) => note(&root, "standing by: another helper holds the Codex host slot"),
                        Ok(_) => note(&root, "Codex host registration refused; will retry"),
                        Err(_) => note(&root, "Codex host registration unavailable; will retry"),
                    }
                    last_host_status = Some(host_status);
                }
                let (state, detail) = match register(a, &pipe, &secret, "credentials").await {
                    Ok(200) => ("holding the bridge", String::new()),
                    Ok(409) => ("standing by: another broker holds the bridge", String::new()),
                    Ok(status) => ("the engine refused the registration; will re-attach", format!(" (HTTP {status})")),
                    Err(_) => ("engine stopped answering; will re-attach", String::new()),
                };
                if !matches!(state, "holding the bridge" | "standing by: another broker holds the bridge") {
                    engine = None;
                    crate::codex_host::ENGINE_PID.store(0, Ordering::SeqCst);
                }
                if last != state {
                    note(&root, &format!("{state}{detail}"));
                    last = state;
                }
            }
            let hosted = crate::codex_host::sweep();
            write_events();
            if hosted != hosted_before {
                note(&root, &format!("hosting {hosted} Codex process(es)"));
                hosted_before = hosted;
            }
            tokio::time::sleep(TICK).await;
        }
    }

    // ------------------------------------------------------------ the engine side

    struct Attached {
        port: u16,
        engine_pid: u64,
        /// The desktop token from the descriptor. Never logged or printed.
        token: String,
    }

    /// The desktop's attach rules (apps/desktop/main/engine.ts tryAttach):
    /// trust the descriptor's write boundary FIRST, then read it, then prove
    /// the endpoint echoes this boot's engine and root.
    #[nolog]
    async fn attach(root: &Path) -> Result<Attached, &'static str> {
        let real = std::fs::canonicalize(root).map_err(|_| "the data folder does not exist")?;
        let file = real.join(DESCRIPTOR);
        if !file.exists() {
            return Err("the background engine is not running (no descriptor)");
        }
        trusted(&file)?;
        let raw = std::fs::read_to_string(&file).map_err(|_| "the descriptor could not be read")?;
        let d: Value = serde_json::from_str(&raw).map_err(|_| "the descriptor is not valid")?;
        let port = d["port"].as_u64().filter(|p| (1..=65535).contains(p)).ok_or("the descriptor has no port")? as u16;
        let engine_pid = d["enginePid"].as_u64().ok_or("the descriptor has no engine pid")?;
        let token = d["token"].as_str().filter(|t| !t.is_empty() && t.len() <= 256 && t.bytes().all(|c| c.is_ascii_graphic())).ok_or("the descriptor has no token")?.to_string();
        if d["protocol"] != 1 || d["type"] != "attach" {
            return Err("the descriptor protocol is not supported");
        }
        let (status, body) = http(port, "GET", "/api/desktop/identity", &token, None).await.map_err(|_| "the engine did not answer")?;
        let identity: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        if status != 200 || identity["protocol"] != 1 {
            return Err("the engine's identity check failed");
        }
        if identity["pid"].as_u64() != Some(engine_pid) {
            return Err("the engine's process does not match the descriptor");
        }
        if identity["dataRootId"].as_str().map(|r| canonical(Path::new(r))) != Some(canonical(&real)) {
            return Err("the engine serves another data folder");
        }
        Ok(Attached { port, engine_pid, token })
    }

    #[nolog]
    fn canonical(p: &Path) -> String {
        let s = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().to_string();
        s.strip_prefix(r"\\?\").unwrap_or(&s).trim_end_matches(['\\', '/']).to_lowercase()
    }

    #[nolog]
    async fn register(a: &Attached, pipe: &str, secret: &str, role: &str) -> Result<u16, ()> {
        let body = serde_json::json!({"pipe": pipe, "secret": secret, "pid": std::process::id(), "caps": ["spawn"], "role": role}).to_string();
        http(a.port, "POST", "/api/desktop/credential-bridge", &a.token, Some(body)).await.map(|(s, _)| s)
    }

    /// One request to the engine on 127.0.0.1; the token never leaves this
    /// machine.
    #[nolog]
    async fn http(port: u16, method: &str, path: &str, token: &str, body: Option<String>) -> Result<(u16, Vec<u8>), ()> {
        let work = async {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.map_err(|_| ())?;
            let body = body.unwrap_or_default();
            let req = format!(
                "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{TOKEN_HEADER}: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(req.as_bytes()).await.map_err(|_| ())?;
            let mut raw = Vec::new();
            (&mut s).take((MAX * 2) as u64).read_to_end(&mut raw).await.map_err(|_| ())?;
            let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or(())?;
            let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
            let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or(())?;
            let mut body = raw[split + 4..].to_vec();
            if head.contains("transfer-encoding: chunked") {
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
            Ok((status, body))
        };
        tokio::time::timeout(Duration::from_secs(6), work).await.map_err(|_| ())?
    }

    // ------------------------------------------------------------ descriptor trust

    struct LocalMem(*mut c_void);
    impl Drop for LocalMem {
        #[nolog]
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0) };
            }
        }
    }

    /// Current-user (or SYSTEM/Administrators) ownership and an exclusive
    /// write boundary on the file, its folder and every ancestor: the same
    /// verdict as the desktop's verifyDescriptorTrust.
    #[nolog]
    fn trusted(file: &Path) -> Result<(), &'static str> {
        unsafe {
            let me = current_sid().ok_or("this account's SID could not be read")?;
            let system = sid("S-1-5-18").ok_or("SID")?;
            let admins = sid("S-1-5-32-544").ok_or("SID")?;
            let creator = sid("S-1-3-0").ok_or("SID")?;
            let me_ptr = me.as_ptr() as PSID;
            let allowed = [me_ptr, system.0, admins.0, creator.0];
            let (owner, dacl, _sd) = security(file).ok_or("the descriptor's permissions could not be read")?;
            if owner.is_null() || !(EqualSid(owner, me_ptr) != 0 || EqualSid(owner, system.0) != 0 || EqualSid(owner, admins.0) != 0) {
                return Err("the descriptor is not owned by this account");
            }
            if foreign_writer(dacl, &allowed, WRITE_MASK) {
                return Err("others can write the descriptor");
            }
            let dir = file.parent().ok_or("no folder")?;
            let (_, dacl, _sd) = security(dir).ok_or("the data folder's permissions could not be read")?;
            if foreign_writer(dacl, &allowed, WRITE_MASK) {
                return Err("others can write the data folder");
            }
            let mut up = dir.parent();
            while let Some(a) = up {
                let (_, dacl, _sd) = security(a).ok_or("a parent folder's permissions could not be read")?;
                if foreign_writer(dacl, &allowed, REPLACE_MASK) {
                    return Err("others can replace a folder above the data folder");
                }
                up = a.parent();
            }
            Ok(())
        }
    }

    /// (owner, dacl, the descriptor that owns both)
    #[nolog]
    unsafe fn security(p: &Path) -> Option<(PSID, *mut ACL, LocalMem)> {
        let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        (rc == 0).then(|| (owner, dacl, LocalMem(sd)))
    }

    /// Any allow ACE that applies to this object (not inherit-only), for a
    /// principal outside `allowed`, with a right in `mask`. A NULL DACL grants
    /// everyone everything.
    #[nolog]
    unsafe fn foreign_writer(dacl: *mut ACL, allowed: &[PSID], mask: u32) -> bool {
        if dacl.is_null() {
            return true;
        }
        for i in 0..(*dacl).AceCount as u32 {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if GetAce(dacl, i, &mut ace) == 0 {
                return true;
            }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE || header.AceFlags & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            let allow = &*(ace as *const ACCESS_ALLOWED_ACE);
            let who = &allow.SidStart as *const u32 as PSID;
            if allowed.iter().any(|a| EqualSid(who, *a) != 0) {
                continue;
            }
            if allow.Mask & mask != 0 {
                return true;
            }
        }
        false
    }

    struct Sid(PSID);
    impl Drop for Sid {
        #[nolog]
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }
    #[nolog]
    unsafe fn sid(text: &str) -> Option<Sid> {
        let w = wide(text);
        let mut p: PSID = std::ptr::null_mut();
        (ConvertStringSidToSidW(w.as_ptr(), &mut p) != 0).then_some(Sid(p))
    }
    /// The TOKEN_USER buffer; its SID pointer points inside it.
    #[nolog]
    unsafe fn current_sid() -> Option<SidBuf> {
        let mut t: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t) == 0 {
            return None;
        }
        let mut size = 0u32;
        GetTokenInformation(t, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut buf = vec![0u8; size.max(1) as usize];
        let ok = size != 0 && GetTokenInformation(t, TokenUser, buf.as_mut_ptr() as *mut c_void, size, &mut size) != 0;
        CloseHandle(t);
        ok.then_some(SidBuf(buf))
    }
    struct SidBuf(Vec<u8>);
    impl SidBuf {
        #[nolog]
        fn as_ptr(&self) -> *mut c_void {
            unsafe { (*(self.0.as_ptr() as *const SID_AND_ATTRIBUTES)).Sid }
        }
    }

    #[nolog]
    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }
    #[nolog]
    fn random_hex(bytes: usize) -> String {
        let mut buf = vec![0u8; bytes];
        rand::thread_rng().fill(&mut buf[..]);
        hex::encode(buf)
    }

    // ------------------------------------------------------------ the pipe (desktop broker protocol)

    static ACTIVE: AtomicUsize = AtomicUsize::new(0);

    #[nolog]
    async fn accept(mut server: NamedPipeServer, pipe: String, secret: Arc<str>) {
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let next = loop {
                match ServerOptions::new().reject_remote_clients(true).create(&pipe) {
                    Ok(s) => break s,
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            };
            let client = std::mem::replace(&mut server, next);
            tokio::spawn(answer(client, secret.clone()));
        }
    }

    /// One request per connection, the desktop broker's rules
    /// (apps/desktop/main/credential-bridge.ts).
    #[nolog]
    async fn answer(mut client: NamedPipeServer, secret: Arc<str>) {
        if ACTIVE.fetch_add(1, Ordering::SeqCst) >= 16 {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
            let _ = client.write_all(b"orgtree-credential-busy\n").await;
            return;
        }
        let work = async {
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            let end = loop {
                let n = client.read(&mut chunk).await.ok()?;
                if n == 0 {
                    return None;
                }
                raw.extend_from_slice(&chunk[..n]);
                chunk.fill(0);
                if raw.len() > MAX {
                    raw.fill(0);
                    return None;
                }
                if let Some(end) = raw.iter().position(|&b| b == b'\n') {
                    break end;
                }
            };
            let value: Option<Value> = serde_json::from_slice(&raw[..end]).ok();
            raw.fill(0);
            let value = value?;
            let given = value["secret"].as_str()?;
            if !equal(given, &secret) {
                return None;
            }
            let diagnostics = value["diagnostics"] == 1;
            Some(match lookup(&value).await {
                Ok(result) => result.into_bytes(),
                Err(code) if diagnostics => format!("orgtree-credential-error {code}\n").into_bytes(),
                Err(_) => return None,
            })
        };
        if let Ok(Some(mut out)) = tokio::time::timeout(Duration::from_secs(8), work).await {
            let _ = client.write_all(&out).await;
            let _ = client.flush().await;
            out.fill(0);
        }
        // Dropping closes our end; the reply stays readable. (DisconnectNamedPipe
        // would discard whatever the engine has not read yet.)
        drop(client);
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }

    #[nolog]
    fn equal(a: &str, b: &str) -> bool {
        a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }
    #[nolog]
    fn safe(s: &str) -> bool {
        s.len() <= 4096 && !s.bytes().any(|c| c < 0x20 || c == 0x7f)
    }
    #[nolog]
    fn host_ok(s: &str) -> bool {
        let b = s.as_bytes();
        !b.is_empty() && b.len() <= 253 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b':' | b'-'))
    }

    #[nolog]
    async fn lookup(value: &Value) -> Result<String, String> {
        // phase 2: Codex app-servers started in this session for the engine
        match value["kind"].as_str() {
            Some("spawn") => return crate::codex_host::spawn(value),
            Some("kill") => return crate::codex_host::kill(value),
            _ => {}
        }
        if value["kind"] == "ping" {
            return Ok("ready".into());
        }
        let host = value["host"].as_str().filter(|h| host_ok(h)).ok_or("invalid-request")?;
        let field = |k: &str| -> Result<&str, String> {
            match &value[k] {
                Value::Null => Ok(""),
                Value::String(s) if safe(s) => Ok(s.as_str()),
                _ => Err("invalid-request".into()),
            }
        };
        let (path, username) = (field("path")?, field("username")?);
        let env = lookup_env();
        match value["kind"].as_str() {
            Some("gh") => {
                let gh = executable("gh", &env).ok_or("gh-missing")?;
                let out = exec("gh", &gh, &["auth", "token", "--hostname", host], "", &env).await?;
                let token = String::from_utf8(out).map_err(|_| "gh-malformed")?.trim().to_string();
                if token.is_empty() {
                    return Err("gh-empty".into());
                }
                if !safe(&token) {
                    return Err("gh-malformed".into());
                }
                Ok(token)
            }
            Some("git") => {
                let git = executable("git", &env).ok_or("git-missing")?;
                let mut input = format!("protocol=https\nhost={host}\n");
                if !path.is_empty() {
                    input += &format!("path={path}\n");
                }
                if !username.is_empty() {
                    input += &format!("username={username}\n");
                }
                input.push('\n');
                let out = exec("git", &git, &["credential", "fill"], &input, &env).await?;
                let text = String::from_utf8(out).map_err(|_| "git-malformed")?;
                let mut user = None;
                let mut pass = None;
                for line in text.trim().lines() {
                    match line.split_once('=') {
                        Some(("username", v)) => user = Some(v.to_string()),
                        Some(("password", v)) => pass = Some(v.to_string()),
                        _ => {}
                    }
                }
                let pass = pass.filter(|p| !p.is_empty()).ok_or("git-empty")?;
                let user = user.filter(|u| safe(u)).ok_or("git-malformed")?;
                if !safe(&pass) {
                    return Err("git-malformed".into());
                }
                Ok(format!("username={user}\npassword={pass}\n\n"))
            }
            _ => Err("invalid-request".into()),
        }
    }

    /// The user's environment, minus anything that would loop a lookup back
    /// into the bridge, with every interactive prompt off.
    #[nolog]
    fn lookup_env() -> Vec<(String, String)> {
        let skip = |k: &str| {
            let k = k.to_ascii_uppercase();
            k.starts_with("ORGTREE_CREDENTIAL_")
                || k == "ORGTREE_ORIGINAL_GIT_ASKPASS"
                || k == "ORGTREE_ASKPASS_ACTIVE"
                || k == "ORGTREE_REAL_GH"
                || k == "ORGTREE_GH_LAUNCH_ACTIVE"
                || k == "GIT_CONFIG_COUNT"
                || k == "GIT_CONFIG_PARAMETERS"
                || k.starts_with("GIT_CONFIG_KEY_")
                || k.starts_with("GIT_CONFIG_VALUE_")
                || k == "GIT_ASKPASS"
                || k == "SSH_ASKPASS"
        };
        let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !skip(k)).collect();
        for (k, v) in env.iter_mut() {
            if k.eq_ignore_ascii_case("PATH") {
                *v = std::env::split_paths(v.as_str())
                    .filter(|d| !adapter_dir(d))
                    .map(|d| d.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(";");
            }
        }
        env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
        env.push(("GCM_INTERACTIVE".into(), "never".into()));
        env.push(("GH_PROMPT_DISABLED".into(), "1".into()));
        env
    }
    #[nolog]
    fn adapter_dir(d: &Path) -> bool {
        d.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("credential-adapters"))
    }
    #[nolog]
    fn executable(name: &str, env: &[(String, String)]) -> Option<PathBuf> {
        let path = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH"))?.1.clone();
        std::env::split_paths(&path)
            .filter(|d| !adapter_dir(d))
            .map(|d| d.join(format!("{name}.exe")))
            .find(|p| p.is_absolute() && p.is_file())
    }

    /// Run a lookup tool with no window, six seconds at most, 64 KiB of
    /// output at most. Failures are fixed codes; tool output never leaves.
    #[nolog]
    async fn exec(tool: &str, exe: &Path, args: &[&str], input: &str, env: &[(String, String)]) -> Result<Vec<u8>, String> {
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let mut child = tokio::process::Command::new(exe)
            .args(args)
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .current_dir(home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { format!("{tool}-missing") } else { format!("{tool}-failed") })?;
        let mut stdin = child.stdin.take();
        let mut stdout = child.stdout.take().ok_or(format!("{tool}-failed"))?;
        let work = async {
            if let Some(s) = stdin.as_mut() {
                let _ = s.write_all(input.as_bytes()).await;
            }
            drop(stdin.take());
            let mut out = Vec::new();
            (&mut stdout).take((MAX + 1) as u64).read_to_end(&mut out).await.map_err(|_| format!("{tool}-failed"))?;
            if out.len() > MAX {
                out.fill(0);
                return Err(format!("{tool}-too-large"));
            }
            let status = child.wait().await.map_err(|_| format!("{tool}-failed"))?;
            match status.code() {
                Some(0) => Ok(out),
                Some(n) => {
                    out.fill(0);
                    Err(format!("{tool}-exit-{}", n.clamp(-1, 255)))
                }
                None => Err(format!("{tool}-failed")),
            }
        };
        match tokio::time::timeout(Duration::from_secs(6), work).await {
            Ok(r) => r,
            Err(_) => Err(format!("{tool}-timeout")),
        }
    }
}
