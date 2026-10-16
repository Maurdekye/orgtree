//! Phase 2 of the sign-in credential broker (docket
//! windows-sign-in-credential-helper-so-git-gh-work, design approved
//! 2026-10-10 09:24Z): the broker starts the boot engine's agent CLIs in this
//! signed-in session (interactive token), where they get the user's desktop
//! and apps and their own OS sandboxes work (openai/codex#46412 breaks Codex's
//! in Session 0). First sandboxed Codex seats; since 2026-10-16 every
//! harness's CLI (docket option-to-run-the-background-engine-in-the-user-s,
//! the user: "agents always start at boot, and then automatically get
//! upgraded when signed in").
//!
//! A launcher, not a relay: the engine creates the child's three stdio pipes,
//! this process opens them as a client, starts the child suspended with them
//! as its only inherited handles, puts it in a kill-on-close job held here,
//! and resumes it. Data then flows between the engine and the CLI directly.
//! Only an absolute path to one of the harness CLIs (`hostable`) is started.
//! The request carries the child's whole environment (API key, credential
//! capability), so nothing here is logged but pids.
use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, FILETIME, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE, STILL_ACTIVE,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList,
    OpenProcess, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

/// The engine this broker serves (its pid from the trusted descriptor); 0
/// while unattached. A spawn's pipes must be served by this process.
pub static ENGINE_PID: AtomicU32 = AtomicU32::new(0);

/// A started child: its job (kill-on-close), process handle and creation time.
struct Hosted {
    job: usize,
    process: usize,
    created: u64,
    engine: u32,
    /// the engine's creation time: a reused pid is not the engine
    engine_created: u64,
    /// when the sweep first found its engine gone: the child gets
    /// `ENGINE_GONE_GRACE` to exit by itself on its broken stdin first
    gone_at: Option<std::time::Instant>,
}
static HOSTED: Mutex<Option<HashMap<u32, Hosted>>> = Mutex::new(None);

/// How long a hosted Codex may take to exit by itself before it is forced
/// down: forcing codex.exe down with an RPC call in flight to lsass crashes
/// lsass (RPCRT4 10.0.26100.9444) and reboots Windows (docket
/// urgent-orgtree-s-hard-killing-of-codex-processes).
const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
const ENGINE_GONE_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Forced ends and natural exits, for the broker's tick to write to its
/// log (`codex-force-kill` / `codex-graceful-exit` lines, flushed to disk).
pub static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[nolog]
fn event(line: String) {
    EVENTS.lock().unwrap_or_else(|p| p.into_inner()).push(line);
}

struct Owned(HANDLE);
impl Drop for Owned {
    #[nolog]
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[nolog]
fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

#[nolog]
fn stamp(process: HANDLE) -> u64 {
    let mut c: FILETIME = unsafe { std::mem::zeroed() };
    let (mut e, mut k, mut u) = (c, c, c);
    if unsafe { GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u) } == 0 {
        return 0;
    }
    ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64
}

/// The creation time of `pid` while it runs (the engine's liveness, checked
/// each tick together with the time recorded at spawn).
#[nolog]
fn started(pid: u32) -> Option<u64> {
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        return None;
    }
    let h = Owned(h);
    let mut code = 0;
    let running = unsafe { GetExitCodeProcess(h.0, &mut code) != 0 && code == STILL_ACTIVE as u32 };
    running.then(|| stamp(h.0)).filter(|&t| t != 0)
}

/// The engine's prefix (`hosted_pipes::PREFIX`, `\\.\pipe\orgtree-cli-`), then
/// 1 to 80 ASCII letters, digits or dashes.
#[nolog]
fn pipe_name_ok(name: &str) -> bool {
    name.strip_prefix(crate::hosted_pipes::PREFIX)
        .map(|s| !s.is_empty() && s.len() <= 80 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        .unwrap_or(false)
}

/// A pipe the engine named (`pipe_name_ok`), served by the attached engine.
#[nolog]
fn open_pipe(name: &str, access: u32, engine: u32) -> Result<Owned, &'static str> {
    if !pipe_name_ok(name) {
        return Err("spawn-invalid");
    }
    let w = wide(name);
    let h = unsafe { CreateFileW(w.as_ptr(), access, 0, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut()) };
    if h == INVALID_HANDLE_VALUE || h.is_null() {
        return Err("spawn-pipe");
    }
    let h = Owned(h);
    let mut server = 0;
    if unsafe { GetNamedPipeServerProcessId(h.0, &mut server) } == 0 || server != engine {
        return Err("spawn-pipe");
    }
    if unsafe { SetHandleInformation(h.0, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err("spawn-pipe");
    }
    Ok(h)
}

/// One quoted command-line argument (the CommandLineToArgvW rules).
#[nolog]
fn quote(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat('\\').take(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat('\\').take(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat('\\').take(slashes * 2));
    out.push('"');
}

/// The CLIs this helper starts for the engine: the five harnesses' own
/// executables by file name (the engine's `session_host`; the rig's fake CLI
/// carries the same names), at an absolute path. Muse's is versioned
/// (`muse-bin-<version>.exe`, `providers::muse_models::bin_in`).
#[nolog]
pub fn hostable(exe: &str) -> bool {
    let path = Path::new(exe);
    if !path.is_absolute() || exe.contains('"') {
        return false;
    }
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()) else { return false };
    matches!(name.as_str(), "claude.exe" | "codex.exe" | "agy.exe" | "opencode.exe")
        || (name.starts_with("muse-bin-") && name.ends_with(".exe") && name.len() > "muse-bin-.exe".len())
}

/// `{kind:"spawn", exe, args, cwd, env, pipes:{stdin,stdout,stderr}}` →
/// `{"pid":N,"created":T}`. Fixed failure codes only.
#[nolog]
pub fn spawn(value: &Value) -> Result<String, String> {
    let engine = ENGINE_PID.load(Ordering::SeqCst);
    if engine == 0 {
        return Err("spawn-unattached".into());
    }
    let engine_created = started(engine).ok_or("spawn-unattached")?;
    let exe = value["exe"].as_str().ok_or("spawn-invalid")?;
    let exe_path = Path::new(exe);
    if !hostable(exe) {
        return Err("spawn-refused".into());
    }
    if !exe_path.is_file() {
        return Err("spawn-missing".into());
    }
    let cwd = value["cwd"].as_str().filter(|c| Path::new(c).is_absolute() && Path::new(c).is_dir()).ok_or("spawn-invalid")?;
    let args: Vec<&str> = value["args"].as_array().ok_or("spawn-invalid")?.iter().map(|a| a.as_str().ok_or("spawn-invalid")).collect::<Result<_, _>>()?;
    let env = value["env"].as_object().ok_or("spawn-invalid")?;
    let pipes = &value["pipes"];
    let stdin = open_pipe(pipes["stdin"].as_str().ok_or("spawn-invalid")?, GENERIC_READ, engine)?;
    let stdout = open_pipe(pipes["stdout"].as_str().ok_or("spawn-invalid")?, GENERIC_WRITE, engine)?;
    let stderr = open_pipe(pipes["stderr"].as_str().ok_or("spawn-invalid")?, GENERIC_WRITE, engine)?;

    let mut line = String::new();
    quote(exe, &mut line);
    for a in &args {
        line.push(' ');
        quote(a, &mut line);
    }
    let mut cmd: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    // The environment block: NAME=value\0 ... \0\0, sorted as Windows expects.
    let mut pairs: Vec<(String, String)> = Vec::with_capacity(env.len());
    for (k, v) in env {
        let v = v.as_str().ok_or("spawn-invalid")?;
        if k.is_empty() || k.contains(['=', '\0']) || v.contains('\0') {
            return Err("spawn-invalid".into());
        }
        pairs.push((k.clone(), v.to_string()));
    }
    pairs.sort_by(|a, b| a.0.to_uppercase().cmp(&b.0.to_uppercase()));
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in &pairs {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    if pairs.is_empty() {
        block.push(0);
    }
    let cwd_w = wide(cwd);
    let exe_w = wide(exe);

    unsafe {
        // Only the three stdio handles are inherited, whatever else is open.
        let handles = [stdin.0, stdout.0, stderr.0];
        let mut size = 0usize;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        let mut attr_buf = vec![0u8; size];
        let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
            return Err("spawn-failed".into());
        }
        let ok = UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr() as *const c_void,
            std::mem::size_of_val(&handles),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if ok == 0 {
            DeleteProcThreadAttributeList(attrs);
            return Err("spawn-failed".into());
        }
        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = stdin.0;
        si.StartupInfo.hStdOutput = stdout.0;
        si.StartupInfo.hStdError = stderr.0;
        si.lpAttributeList = attrs;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let created = CreateProcessW(
            exe_w.as_ptr(),
            cmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
            block.as_ptr() as *const c_void,
            cwd_w.as_ptr(),
            &si.StartupInfo,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attrs);
        block.fill(0);
        if created == 0 {
            let _ = GetLastError();
            return Err("spawn-failed".into());
        }
        let process = pi.hProcess;
        let thread = Owned(pi.hThread);
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let jobbed = !job.is_null()
            && SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
            && AssignProcessToJobObject(job, process) != 0;
        if !jobbed {
            // never run a child this broker cannot take down with it
            windows_sys::Win32::System::Threading::TerminateProcess(process, 1);
            CloseHandle(process);
            if !job.is_null() {
                CloseHandle(job);
            }
            return Err("spawn-failed".into());
        }
        ResumeThread(thread.0);
        let pid = pi.dwProcessId;
        let created = stamp(process);
        HOSTED.lock().unwrap().get_or_insert_with(HashMap::new).insert(pid, Hosted { job: job as usize, process: process as usize, created, engine, engine_created, gone_at: None });
        // When the child exits, close its job: anything it left running ends too.
        let waited = process as usize;
        std::thread::spawn(move || {
            WaitForSingleObject(waited as HANDLE, u32::MAX);
            finish(pid);
        });
        Ok(format!("{{\"pid\":{pid},\"created\":{created}}}"))
    }
}

/// End one hosted child and its whole tree (`{kind:"kill", pid, created}`):
/// the engine has closed its stdin; it gets `KILL_GRACE` to exit by itself
/// (watched on a thread, so the answer is immediate), then its job is
/// terminated.
#[nolog]
pub fn kill(value: &Value) -> Result<String, String> {
    let pid = value["pid"].as_u64().ok_or("spawn-invalid")? as u32;
    let created = value["created"].as_u64().ok_or("spawn-invalid")?;
    {
        let guard = HOSTED.lock().unwrap();
        guard.as_ref().and_then(|m| m.get(&pid)).filter(|h| h.created == created).ok_or("spawn-unknown")?;
    }
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            let guard = HOSTED.lock().unwrap();
            // `finish` removes it once it has exited
            let Some(h) = guard.as_ref().and_then(|m| m.get(&pid)).filter(|h| h.created == created) else {
                drop(guard);
                event(format!("codex-graceful-exit pid={pid} who=\"engine kill request\" waited_ms={}", started.elapsed().as_millis()));
                return;
            };
            if started.elapsed() >= KILL_GRACE {
                event(format!("codex-force-kill pid={pid} tree=true who=\"engine kill request\" reason=\"did not exit after its input closed\" graceful_tried=true waited_ms={}",
                    started.elapsed().as_millis()));
                flush_events();
                unsafe { TerminateJobObject(h.job as HANDLE, 1) };
                return;
            }
            drop(guard);
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    });
    Ok("killed".into())
}

/// Hook for the broker to write pending events to disk at once (set by the
/// broker at start; a no-op until then).
pub static FLUSH: std::sync::OnceLock<fn()> = std::sync::OnceLock::new();

#[nolog]
fn flush_events() {
    if let Some(f) = FLUSH.get() {
        f();
    }
}

#[nolog]
fn finish(pid: u32) {
    let entry = HOSTED.lock().unwrap().as_mut().and_then(|m| m.remove(&pid));
    if let Some(h) = entry {
        unsafe {
            TerminateJobObject(h.job as HANDLE, 1);
            CloseHandle(h.job as HANDLE);
            CloseHandle(h.process as HANDLE);
        }
    }
}

/// Each tick: a hosted child whose engine has gone (crash, restart, a new
/// engine) is ended with its tree. Returns how many children are hosted.
#[nolog]
pub fn sweep() -> usize {
    let gone: Vec<u32> = {
        let guard = HOSTED.lock().unwrap();
        let Some(m) = guard.as_ref() else { return 0 };
        let mut engines: HashMap<u32, Option<u64>> = HashMap::new();
        m.iter()
            .filter(|(_, h)| *engines.entry(h.engine).or_insert_with(|| started(h.engine)) != Some(h.engine_created))
            .map(|(p, _)| *p)
            .collect()
    };
    // its stdin broke with the engine: it normally exits by itself first
    for pid in &gone {
        let mut guard = HOSTED.lock().unwrap();
        if let Some(h) = guard.as_mut().and_then(|m| m.get_mut(pid)) {
            let since = *h.gone_at.get_or_insert_with(std::time::Instant::now);
            if since.elapsed() >= ENGINE_GONE_GRACE {
                event(format!("codex-force-kill pid={pid} tree=true who=\"sign-in helper sweep\" reason=\"its engine is gone\" graceful_tried=true waited_ms={}",
                    since.elapsed().as_millis()));
                flush_events();
                unsafe { TerminateJobObject(h.job as HANDLE, 1) };
            }
        }
    }
    HOSTED.lock().unwrap().as_ref().map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{hostable, pipe_name_ok};

    /// The helper opens exactly the pipes the engine serves. Since decision 84
    /// the engine named them `orgtree-cli-` while this check still wanted
    /// `orgtree-codex-`, so every hosted launch was refused `spawn-invalid`
    /// (rig-sol-b's session-upgrade proof at de565da).
    #[test]
    fn the_helper_opens_the_pipes_the_engine_serves() {
        for name in crate::hosted_pipes::names(&"0123456789abcdef".repeat(2)) {
            assert!(pipe_name_ok(&name), "{name}");
        }
    }

    /// And nothing else: another machine's pipe, a lookalike or missing
    /// prefix, a file path, an empty or overlong id, or a character other than
    /// an ASCII letter, digit or dash.
    #[test]
    fn no_other_pipe_is_opened() {
        let [stdin, ..] = crate::hosted_pipes::names("0123456789abcdef");
        let prefix = stdin.strip_suffix("0123456789abcdef-in").unwrap();
        let leaf = stdin.rsplit_once('\\').unwrap().1;
        for no in [
            stdin.replacen(r"\\.\", r"\\server\", 1),
            stdin.replacen(r"\\.\pipe\", r"\\.\pipe\x", 1),
            stdin.replacen(r"\\.\pipe\", r"\\?\pipe\", 1),
            format!(r"C:\pipe\{leaf}"),
            leaf.to_string(),
            prefix.to_string(),
            format!("{prefix}{}", "a".repeat(81)),
            format!("{prefix}abc/def"),
            format!(r"{prefix}abc\def"),
            format!("{prefix}abc def"),
            format!("{prefix}abc.def"),
            format!("{prefix}abc\u{e9}"),
            format!("{prefix}abc\0"),
        ] {
            assert!(!pipe_name_ok(&no), "{no}");
        }
    }

    #[test]
    fn the_five_harness_clis_by_absolute_path_and_nothing_else() {
        for ok in [
            r"C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe",
            r"C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\vendor\codex\codex.exe",
            r"C:\Users\u\AppData\Local\agy\bin\AGY.EXE",
            r"C:\tools\opencode.exe",
            r"C:\Users\u\AppData\Local\Programs\muse\muse-bin-1.4.6-R0.exe",
        ] {
            assert!(hostable(ok), "{ok}");
        }
        for no in [
            "codex.exe",
            r"bin\claude.exe",
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Users\u\AppData\Roaming\npm\claude.cmd",
            r"C:\x\muse.exe",
            r"C:\x\muse-bin-.exe",
            r"C:\x\codex.exe.bat",
            r#"C:\x\co"dex.exe"#,
        ] {
            assert!(!hostable(no), "{no}");
        }
    }
}
