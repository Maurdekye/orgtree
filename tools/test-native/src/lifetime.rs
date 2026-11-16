//! The synthetic engine's process lifetime: a port of the retired
//! engine/process_lifetime.py (RootLock + WindowsTree + watch) and of the
//! fixtures' `launch.py` preamble, for the desktop supervisor tests.
//!
//! `engine-stub` is what the tests hand the desktop as its engine `binary`.
//! It reads `engine-stub.json` beside its own image:
//!   { "node": "<node.exe>", "script": "<fixture .cjs>", "guardian": true }
//! With `guardian`, it first proves exclusive ownership of the data root and
//! its process tree, exactly as arm_process_lifetime did: a guardian process
//! (this image, `guardian` subcommand) takes the root lock, opens handles on
//! the engine and the desktop parent, and assigns the engine to a
//! kill-on-close Job. Then the fixture's JavaScript runs as a CHILD of the
//! stub, inside that Job, with the stub's own stdout. It reports the stub's
//! pid (ORGTREE_STUB_PID) and the guardian's (ORGTREE_STUB_GUARDIAN), because
//! the stub is the process the desktop spawned. The stub exits with the
//! fixture's exit code.
//!
//! The guardian outlives a dying engine on purpose: when the engine or the
//! parent ends, it terminates the Job, waits until Windows reports no active
//! process, and only then releases the root lock.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::LockFile;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, WaitForMultipleObjects, WaitForSingleObject, INFINITE, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const LOCK_NAME: &str = ".desktop-engine.lock";
const STATUS_NAME: &str = ".desktop-engine-status.json";

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The exclusive one-byte lock on `.desktop-engine.lock`, as RootLock did
/// with msvcrt.locking(LK_NBLCK, 1) at offset 0.
pub struct RootLock {
    _file: File,
}

impl RootLock {
    pub fn acquire(root: &Path) -> Result<RootLock, String> {
        let path = root.join(LOCK_NAME);
        if fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err("engine lock cannot be a symlink".into());
        }
        let refused = || "another engine owns this data root; inspect .desktop-engine-status.json for pending cleanup".to_string();
        let mut file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path).map_err(|_| refused())?;
        let mut byte = [0u8; 1];
        let empty = file.seek(SeekFrom::Start(0)).and_then(|_| file.read(&mut byte)).map_err(|_| refused())? == 0;
        if empty {
            file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(b"0")).and_then(|_| file.flush()).map_err(|_| refused())?;
        }
        use std::os::windows::io::AsRawHandle;
        // SAFETY: the handle belongs to `file`, which this lock keeps open.
        if unsafe { LockFile(file.as_raw_handle() as HANDLE, 0, 0, 1, 0) } == 0 {
            return Err(refused());
        }
        Ok(RootLock { _file: file })
    }
}

/// `hold-lock ROOT [SECONDS]`: hold the root lock, print "held", release
/// after SECONDS (default 120), print "released".
pub fn hold_lock(args: &[String]) -> i32 {
    let Some(root) = args.first() else { return 2 };
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(120);
    let lock = match RootLock::acquire(Path::new(root)) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    println!("held");
    let _ = std::io::stdout().flush();
    std::thread::sleep(Duration::from_secs(seconds));
    drop(lock);
    println!("released");
    0
}

/// `alive PID`: "alive" while PID's process has not exited, else "gone".
pub fn alive(args: &[String]) -> i32 {
    let Some(pid) = args.first().and_then(|p| p.parse::<u32>().ok()) else { return 2 };
    // SAFETY: plain Win32 calls; the handle is closed at once.
    let answer = unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            "gone"
        } else {
            let state = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            if state == WAIT_TIMEOUT { "alive" } else { "gone" }
        }
    };
    println!("{answer}");
    0
}

struct Tree {
    job: HANDLE,
    handles: Vec<HANDLE>,
    armed: bool,
}

impl Tree {
    /// Open process handles first, pinning identities rather than polling
    /// reusable pids; then a kill-on-close Job.
    fn new(engine: u32, parent: u32) -> Result<Tree, String> {
        let mut tree = Tree { job: std::ptr::null_mut(), handles: Vec::new(), armed: false };
        // SAFETY: plain Win32 calls; every handle is owned by `tree`.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, engine);
            if handle.is_null() {
                return Err(format!("could not open the engine process (Windows error {})", GetLastError()));
            }
            tree.handles.push(handle);
            if parent != 0 {
                let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, parent);
                if handle.is_null() {
                    return Err(format!("could not open the desktop parent (Windows error {})", GetLastError()));
                }
                tree.handles.push(handle);
            }
            tree.job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if tree.job.is_null() {
                return Err(format!("could not create the Job (Windows error {})", GetLastError()));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                tree.job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(format!("could not limit the Job (Windows error {})", GetLastError()));
            }
        }
        Ok(tree)
    }

    fn arm(&mut self) -> Result<(), String> {
        // SAFETY: both handles are live.
        if unsafe { AssignProcessToJobObject(self.job, self.handles[0]) } == 0 {
            return Err(format!("could not assign the engine to the Job (Windows error {})", unsafe { GetLastError() }));
        }
        self.armed = true;
        Ok(())
    }

    fn wait(&self) -> Result<(), String> {
        // SAFETY: the handles are live for the duration of the wait.
        let result = unsafe { WaitForMultipleObjects(self.handles.len() as u32, self.handles.as_ptr(), 0, INFINITE) };
        if result == WAIT_FAILED {
            return Err(format!("wait failed (Windows error {})", unsafe { GetLastError() }));
        }
        let _ = WAIT_OBJECT_0;
        Ok(())
    }

    /// Keep root ownership while Windows completes descendant termination.
    fn terminate(&self, code: u32, stalled: &dyn Fn(u32)) -> Result<(), String> {
        // SAFETY: the Job handle is live.
        if unsafe { TerminateJobObject(self.job, code) } == 0 {
            return Err(format!("could not terminate the Job (Windows error {})", unsafe { GetLastError() }));
        }
        let mut deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // SAFETY: plain query into a zeroed struct of the right size.
            let active = unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.job,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(format!("could not query the Job (Windows error {})", GetLastError()));
                }
                info.ActiveProcesses
            };
            if active == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                stalled(active);
                deadline = Instant::now() + Duration::from_secs(10);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: each handle is closed exactly once.
        unsafe {
            if !self.job.is_null() {
                CloseHandle(self.job);
            }
            for handle in self.handles.drain(..) {
                CloseHandle(handle);
            }
        }
    }
}

fn unix_seconds() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `guardian ROOT ENGINE_PID PARENT_PID`: the private guardian entry point.
pub fn guardian(args: &[String]) -> i32 {
    if args.len() != 3 {
        eprintln!("private guardian entrypoint");
        return 2;
    }
    let root = PathBuf::from(&args[0]);
    let (Ok(engine), Ok(parent)) = (args[1].parse::<u32>(), args[2].parse::<u32>()) else { return 2 };
    let me = std::process::id();
    let mut out = std::io::stdout();
    let mut ready = false;
    let mut tree: Option<Tree> = None;
    let mut lock: Option<RootLock> = None;
    let result = (|| -> Result<(), String> {
        lock = Some(RootLock::acquire(&root)?);
        let diagnostic = root.join(STATUS_NAME);
        let _ = fs::remove_file(&diagnostic);
        tree = Some(Tree::new(engine, parent)?);
        let _ = writeln!(out, "{{\"prepared\":true,\"guardian\":{me}}}");
        let _ = out.flush();
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
        if line.trim() != "arm" {
            return Err("engine did not acknowledge guardian preparation".into());
        }
        tree.as_mut().unwrap().arm()?;
        let _ = writeln!(out, "{{\"ready\":true,\"guardian\":{me}}}");
        let _ = out.flush();
        ready = true;
        let armed = tree.as_ref().unwrap();
        armed.wait()?;
        let status = diagnostic.clone();
        armed.terminate(0, &|active| {
            let _ = fs::write(
                &status,
                format!(
                    "{{\"state\":\"termination_pending\",\"active\":{active},\"guardian\":{me},\"message\":\"Windows has not completed process termination; root lock remains held\",\"at\":{}}}",
                    unix_seconds()
                ),
            );
        })?;
        let _ = fs::remove_file(&diagnostic);
        Ok(())
    })();
    // The root lock is released only after the tree is gone.
    let code = match result {
        Ok(()) => 0,
        Err(message) => {
            if let Some(tree) = tree.as_ref().filter(|t| t.armed) {
                let _ = tree.terminate(70, &|_| {});
            }
            if !ready {
                let _ = writeln!(out, "{{\"error\":{}}}", json_string(&message));
                let _ = out.flush();
            }
            eprintln!("{message}");
            1
        }
    };
    drop(tree);
    drop(lock);
    code
}

/// Start the guardian and return its pid once it owns the root and the tree,
/// as arm_process_lifetime did (15 s per phase).
fn arm_process_lifetime(root: &Path, parent: u32) -> Result<u32, String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("lifetime requires an existing absolute data root".into());
    }
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    // Only platform plumbing is inherited, never desktop/provider credentials.
    let allowed = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "SYSTEMDRIVE", "COMSPEC"];
    let mut command = Command::new(me);
    command
        .args(["guardian", &root.to_string_lossy(), &std::process::id().to_string(), &parent.to_string()])
        .env_clear()
        .envs(std::env::vars().filter(|(k, _)| allowed.contains(&k.to_uppercase().as_str())))
        .env("ORGTREE_DATA", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|e| format!("could not start the guardian: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let (send, receive) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => {
                    let _ = send.send(String::new());
                    return;
                }
                Ok(_) => {
                    if send.send(line).is_err() {
                        return;
                    }
                }
            }
        }
    });
    let response = |phase: &str| -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = receive.recv_timeout(left).map_err(|_| format!("guardian {phase} timed out after 15s"))?;
            if line.is_empty() {
                return Err("guardian closed its startup channel".into());
            }
            if line.contains(&format!("\"guardian\":{pid}")) || line.contains("\"error\"") {
                return Ok(line);
            }
        }
    };
    let reply = match response("preparation") {
        Ok(reply) => reply,
        Err(error) => {
            // Until the acknowledgment the Job does not contain the engine,
            // so a failed preparation can be cancelled without killing us.
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if !reply.contains("\"prepared\":true") {
        let _ = child.wait();
        return Err(reply.trim().to_string());
    }
    // After this the guardian may own us: never kill it to report an error.
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"arm\n").map_err(|e| e.to_string())?;
    drop(stdin);
    let reply = response("assignment acknowledgment")?;
    if !reply.contains("\"ready\":true") {
        return Err(reply.trim().to_string());
    }
    std::mem::forget(child);
    Ok(pid)
}

/// Without a guardian, the stub still takes its fixture with it when it is
/// killed, as the single-process fixture did: a kill-on-close Job of its own,
/// whose only handle dies with this process.
fn contain_self() -> Result<(), String> {
    // SAFETY: plain Win32 calls; the Job handle is deliberately kept open
    // until this process exits.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(format!("could not create the Job (Windows error {})", GetLastError()));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            return Err(format!("could not contain the stub (Windows error {})", GetLastError()));
        }
    }
    Ok(())
}

/// `engine-stub [ARGS...]`: the synthetic engine the desktop spawns (`serve`
/// and any other arguments are ignored).
pub fn engine_stub() -> i32 {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) else { return 2 };
    let config = match fs::read_to_string(dir.join("engine-stub.json")) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("engine-stub.json is missing beside the stub: {e}");
            return 2;
        }
    };
    let field = |name: &str| -> Option<String> {
        // The config is written by tests/engine-stub.mjs with JSON.stringify:
        // string values with only JSON escapes.
        let key = format!("\"{name}\":");
        let at = config.find(&key)? + key.len();
        let rest = config[at..].trim_start();
        if let Some(body) = rest.strip_prefix('"') {
            let mut value = String::new();
            let mut chars = body.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => return Some(value),
                    '\\' => match chars.next()? {
                        'n' => value.push('\n'),
                        't' => value.push('\t'),
                        other => value.push(other),
                    },
                    c => value.push(c),
                }
            }
            None
        } else {
            Some(rest.split(|c| c == ',' || c == '}').next()?.trim().to_string())
        }
    };
    let (Some(node), Some(script)) = (field("node"), field("script")) else {
        eprintln!("engine-stub.json needs node and script");
        return 2;
    };
    let with_guardian = field("guardian").as_deref() == Some("true");
    let mut command = Command::new(node);
    command.arg(script).env_remove("NODE_OPTIONS").env("ORGTREE_STUB_PID", std::process::id().to_string());
    if !with_guardian {
        if let Err(message) = contain_self() {
            eprintln!("{message}");
            return 1;
        }
    } else {
        let root = std::env::var("ORGTREE_DATA").unwrap_or_default();
        let parent = std::env::var("ORGTREE_V2_PARENT_PID").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
        match arm_process_lifetime(Path::new(&root), parent) {
            Ok(guardian) => {
                command.env("ORGTREE_STUB_GUARDIAN", guardian.to_string());
            }
            Err(message) => {
                eprintln!("engine lifetime unavailable: {message}");
                return 1;
            }
        }
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("could not start the fixture: {e}");
            1
        }
    }
}
