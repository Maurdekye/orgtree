//! `orgtree-installer-relaunch`: the post-Setup relaunch helper for an
//! accepted Windows upgrade. It replaces `tools/installer-relaunch.py`, which
//! ran under the bundled `pythonw.exe` (Python removal, phase 2, 4.6.1).
//!
//! WHY A SEPARATE GUI-SUBSYSTEM EXECUTABLE IN THE INSTALL TREE. Three
//! constraints decide the host, and each one was learned in the field.
//!
//! 1. IT MUST BE GUI-SUBSYSTEM. The installer dispatches this helper with
//!    StdUtils.ExecShellAsUser, a ShellExecute, which cannot pass
//!    CREATE_NO_WINDOW. Windows allocates a console for any console-subsystem
//!    target, and on Windows 11 with Windows Terminal as the default that is a
//!    visible WindowsTerminal.exe + OpenConsole.exe pair (the original
//!    installer-relaunch.ps1 incident). `windows_subsystem = "windows"` below
//!    sets the PE subsystem byte; tests/installer-upgrade.test.mjs reads it.
//! 2. IT MUST NOT DEPEND ON A COMPONENT THAT POLICY CAN SWITCH OFF. JScript
//!    under wscript.exe was GUI-subsystem too, but Windows Script Host is
//!    disabled by policy on many managed machines and then cannot report that
//!    it did not run. This image ships with the application, and the installer
//!    checks that the FILE exists before it commits to skipping Finish.
//! 3. IT RUNS FROM $INSTDIR, NOT FROM %TEMP%. AppLocker's default executable
//!    rules allow Program Files and Windows and refuse %TEMP%. pythonw.exe
//!    lived in $INSTDIR for the same reason; only its script was in %TEMP%.
//!
//! It reaches the real Win32 process APIs, so the wait is OpenProcess +
//! WaitForSingleObject on a handle. Nothing turns an unanswerable question
//! into an answer: an unreadable state is reported and nothing is launched.
//!
//! Behaviour contract (unchanged from the Python helper): run under the
//! original user token (the installer's job, via ExecShellAsUser), start only
//! after the installer process has exited, and launch exactly once.
//!
//! Arguments are positional:
//!     <installer-pid> <executable-path> [<ready-marker> [<launch-claim>]]
//!
//! THE ORDER OF THE FIRST THREE STEPS IS THE PROTOCOL; each is a promise this
//! helper must already be able to keep before it makes it.
//! 1. ACQUIRE the installer's process handle. Without it there is no wait.
//! 2. CLAIM the launch atomically (CREATE_NEW), against the same file the
//!    installer's Finish page Run action claims. The loser starts nothing.
//! 3. ACKNOWLEDGE by writing the ready marker. The installer reads it as
//!    permission to close its own Finish page, so it is written only once this
//!    helper holds both the handle and the ownership.
//!
//! The claim is RELEASED on every path that ends without a launch: a claim
//! left by a helper that gave up is a reservation with no live owner.
//!
//! Exit codes, all of them also written to the log:
//!   0  the installer's exit was observed and the application was launched once
//!   2  the arguments were unusable
//!   3  the installer's state could not be read, so nothing was launched
//!   4  the installer had not exited within the timeout, so nothing was launched
//!   5  the application could not be started
//!   6  another party already owned the launch, so nothing was started here
//!   7  launch ownership could not be established at all, so nothing was started
//!
//! CLEANUP. The installer creates a per-run `OrgtreeInstallerRelaunch-<pid>`
//! directory under %TEMP% for the ready marker. The Python helper lived in that
//! directory and removed it as it exited; this helper lives in $INSTDIR and so
//! removes the ready marker's directory instead, and only when that directory
//! carries the installer's `OrgtreeInstallerRelaunch-` prefix.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const LOG_NAME: &str = "orgtree-installer-relaunch.log";
const DEFAULT_TIMEOUT_MS: u32 = 120_000;
const STAGING_PREFIX: &str = "orgtreeinstallerrelaunch-";

pub const EXIT_OK: i32 = 0;
pub const EXIT_BAD_ARGUMENTS: i32 = 2;
pub const EXIT_UNREADABLE: i32 = 3;
pub const EXIT_STILL_RUNNING: i32 = 4;
pub const EXIT_LAUNCH_FAILED: i32 = 5;
pub const EXIT_OWNED_ELSEWHERE: i32 = 6;
pub const EXIT_UNCLAIMABLE: i32 = 7;

#[derive(Debug, PartialEq, Eq)]
enum Ownership {
    Owned,
    OwnedElsewhere,
    Unclaimable,
}

fn temp_dir() -> PathBuf {
    for name in ["TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn log_path() -> PathBuf {
    match std::env::var_os("ORGTREE_RELAUNCH_LOG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(LOG_NAME),
        _ => temp_dir().join(LOG_NAME),
    }
}

/// Append one diagnostic line. Best effort by design: losing a line must never
/// stop the relaunch. With no console this file is the only account there is.
fn record(message: &str) {
    let line = format!("[{}] [installer-relaunch] {}\n", sys::local_stamp(), message);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// "<detail> (Windows error N)", the shape the Python helper logged.
fn describe(error: &io::Error) -> String {
    let text = error.to_string();
    let detail = match text.rfind(" (os error ") {
        Some(at) => text[..at].trim().to_string(),
        None => text.trim().to_string(),
    };
    match error.raw_os_error() {
        Some(code) => format!("{} (Windows error {})", if detail.is_empty() { "no detail" } else { &detail }, code),
        None if detail.is_empty() => "an error with no readable detail".to_string(),
        None => detail,
    }
}

/// Write the installer's acceptance handshake. Not fatal: without it the
/// installer simply keeps its Finish page.
fn announce_ready(marker: &str) {
    if marker.is_empty() {
        return;
    }
    if let Err(error) = fs::write(marker, format!("started {}\n", std::process::id())) {
        record(&format!("could not write the ready marker {}: {}", marker, describe(&error)));
    }
}

/// Take exclusive ownership of the launch, or answer who has it.
///
/// ⚠ AN ATOMIC CLAIM, NOT A CHECK-THEN-ACT. `create_new` is CreateFileW with
/// CREATE_NEW, the same NTFS operation the installer's Finish action uses.
/// UNCLAIMABLE IS A FAILURE, NOT A PERMISSION: not knowing means not launching.
fn claim_launch(claim: &str) -> Ownership {
    if claim.is_empty() {
        record("no launch-ownership path was supplied; not launching, because ownership cannot be established");
        return Ownership::Unclaimable;
    }
    match OpenOptions::new().write(true).create_new(true).open(claim) {
        Ok(mut file) => {
            // The create is what owns the claim; the note is for a person.
            let _ = file.write_all(format!("helper {}\r\n", std::process::id()).as_bytes());
            Ownership::Owned
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            record(&format!("the launch is already owned by another party ({} exists); not launching", claim));
            Ownership::OwnedElsewhere
        }
        Err(error) => {
            record(&format!(
                "could not establish launch ownership at {}: {}; not launching, because \
                 an unestablished claim is not permission to start a second copy",
                claim,
                describe(&error)
            ));
            Ownership::Unclaimable
        }
    }
}

/// Give back a claim this helper created when it is not going to launch.
/// Only ever this helper's own claim: releasing another party's is how two
/// launches happen.
fn release_claim(claim: &str) {
    if claim.is_empty() {
        return;
    }
    match fs::remove_file(claim) {
        Ok(()) => record(&format!("released the launch claim {} without launching, so it is not left reserved", claim)),
        Err(error) => record(&format!("could not release the launch claim {}: {}", claim, describe(&error))),
    }
}

/// Start the upgraded application exactly once, detached, with no console.
fn launch(executable: &str) -> io::Result<()> {
    let mut command = std::process::Command::new(executable);
    if let Some(directory) = Path::new(executable).parent().filter(|d| !d.as_os_str().is_empty()) {
        command.current_dir(directory);
    }
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    sys::detach(&mut command);
    command.spawn().map(|_| ())
}

/// The ready marker's directory, when it is the installer's staging directory.
fn staging_dir(marker: &str) -> Option<PathBuf> {
    if marker.is_empty() {
        return None;
    }
    let directory = Path::new(marker).parent()?;
    let name = directory.file_name()?.to_string_lossy().to_lowercase();
    if !name.starts_with(STAGING_PREFIX) {
        return None;
    }
    // Never the directory this image runs from.
    if let Ok(exe) = std::env::current_exe() {
        if exe.parent().map(|own| own == directory).unwrap_or(false) {
            return None;
        }
    }
    Some(directory.to_path_buf())
}

/// Remove the installer's per-run staging directory. Best effort.
fn clean_up(marker: &str) {
    if let Some(directory) = staging_dir(marker) {
        let _ = std::env::set_current_dir(temp_dir());
        let _ = fs::remove_dir_all(directory);
    }
}

fn parse_pid(raw: &str) -> Result<u32, String> {
    let trimmed = raw.trim();
    let digits = trimmed.strip_prefix('+').unwrap_or(trimmed);
    let value: i64 = match digits.strip_prefix('-') {
        Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) => -1,
        _ if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => digits.parse().unwrap_or(i64::MAX),
        _ => return Err(format!("the installer process id {:?} is not a number", raw)),
    };
    if value <= 0 || value > u32::MAX as i64 {
        return Err(format!("the installer process id {:?} is invalid", raw));
    }
    Ok(value as u32)
}

fn timeout_ms() -> u32 {
    std::env::var("ORGTREE_RELAUNCH_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
}

/// What OpenProcess answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Acquired {
    /// A handle this helper can wait on.
    Handle,
    /// The process id is already gone (ERROR_INVALID_PARAMETER).
    Exited,
    /// Anything else, access denied above all. NOT evidence of exit.
    Unreadable,
}

/// What the wait answered. Only `Exited` may lead to a launch.
#[derive(Debug, PartialEq, Eq)]
pub enum Waited {
    Exited,
    StillRunning,
    Unreadable,
}

fn run(args: &[String]) -> i32 {
    if args.len() < 2 {
        record("expected an installer process id and an executable path");
        return EXIT_BAD_ARGUMENTS;
    }
    let (raw_pid, executable) = (&args[0], &args[1]);
    let marker = args.get(2).map(String::as_str).unwrap_or("");
    let claim = args.get(3).map(String::as_str).unwrap_or("");

    let pid = match parse_pid(raw_pid) {
        Ok(pid) => pid,
        Err(message) => {
            record(&message);
            return EXIT_BAD_ARGUMENTS;
        }
    };
    if executable.is_empty() {
        record("the upgraded executable path is empty");
        return EXIT_BAD_ARGUMENTS;
    }
    let timeout = timeout_ms();

    // HANDLE, THEN OWNERSHIP, THEN ACKNOWLEDGEMENT.
    let mut waiter = sys::Waiter::default();
    let status = waiter.acquire(pid);
    if status == Acquired::Unreadable {
        // No marker is written, so the installer keeps its Finish page.
        return EXIT_UNREADABLE;
    }

    // Losing the claim means the other party launches; failing to make one
    // means nobody may. Either way: no launch and no acknowledgement. The
    // waiter's handle closes when it drops.
    let ownership = claim_launch(claim);
    if ownership != Ownership::Owned {
        return if ownership == Ownership::OwnedElsewhere { EXIT_OWNED_ELSEWHERE } else { EXIT_UNCLAIMABLE };
    }

    announce_ready(marker);

    if status == Acquired::Handle {
        record(&format!("waiting for installer process {} before starting {}", pid, executable));
        let outcome = waiter.wait(pid, timeout);
        if outcome == Waited::StillRunning {
            release_claim(claim);
            return EXIT_STILL_RUNNING;
        }
        if outcome != Waited::Exited {
            // "I could not tell" must never become "it had exited".
            release_claim(claim);
            return EXIT_UNREADABLE;
        }
    }

    // No second check before launching: ownership was settled atomically
    // before the acknowledgement, and a check here would be the race the claim
    // exists to remove.
    if let Err(error) = launch(executable) {
        record(&format!("could not start \"{}\": {}", executable, describe(&error)));
        release_claim(claim);
        return EXIT_LAUNCH_FAILED;
    }
    record(&format!("started {} once, after installer process {} exited", executable, pid));
    EXIT_OK
}

fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let code = run(&args);
    clean_up(args.get(2).map(String::as_str).unwrap_or(""));
    std::process::exit(code);
}

#[cfg(windows)]
mod sys {
    use super::{record, Acquired, Waited};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    // DETACHED_PROCESS, not CREATE_NO_WINDOW: the launched process gets no
    // console at all and does not inherit one.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub fn local_stamp() -> String {
        // SAFETY: SYSTEMTIME is plain data; GetLocalTime only writes it.
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut t) };
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
    }

    pub fn detach(command: &mut std::process::Command) {
        use std::os::windows::process::CommandExt;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    #[derive(Default)]
    pub struct Waiter {
        handle: Option<HANDLE>,
    }

    impl Waiter {
        /// ⚠ RUNS BEFORE THE ACKNOWLEDGEMENT, AND THAT ORDER IS THE POINT.
        pub fn acquire(&mut self, pid: u32) -> Acquired {
            // SAFETY: plain Win32 call; a non-null result is owned by self.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            if !handle.is_null() {
                self.handle = Some(handle);
                return Acquired::Handle;
            }
            // SAFETY: reads this thread's last-error value.
            let error = unsafe { GetLastError() };
            if error == ERROR_INVALID_PARAMETER {
                record(&format!("installer process {} had already exited", pid));
                return Acquired::Exited;
            }
            record(&format!(
                "could not open installer process {} to wait on it: Windows error {}; \
                 not launching and NOT acknowledging, because an unreadable state is \
                 neither an observed exit nor a wait this helper can promise to keep",
                pid, error
            ));
            Acquired::Unreadable
        }

        /// The three answers are kept apart; only an observed exit launches.
        pub fn wait(&mut self, pid: u32, timeout_ms: u32) -> Waited {
            let Some(handle) = self.handle.take() else { return Waited::Unreadable };
            // SAFETY: handle came from OpenProcess and is closed exactly once.
            let (result, error) = unsafe {
                let result = WaitForSingleObject(handle, timeout_ms);
                let error = GetLastError();
                CloseHandle(handle);
                (result, error)
            };
            if result == WAIT_OBJECT_0 {
                return Waited::Exited;
            }
            if result == WAIT_TIMEOUT {
                record(&format!(
                    "installer process {} had not exited after {} ms; not launching, because \
                     starting the application over a live installer is the failure this wait exists to prevent",
                    pid, timeout_ms
                ));
                return Waited::StillRunning;
            }
            record(&format!(
                "waiting on installer process {} failed (result 0x{:08X}, Windows error {}); not launching",
                pid, result, error
            ));
            Waited::Unreadable
        }
    }

    impl Drop for Waiter {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                // SAFETY: handle came from OpenProcess and is still open.
                unsafe { CloseHandle(handle) };
            }
        }
    }
}

/// Builds everywhere the workspace builds; the helper itself is Windows-only.
#[cfg(not(windows))]
mod sys {
    use super::{record, Acquired, Waited};

    pub fn local_stamp() -> String {
        String::from("unknown-time")
    }

    pub fn detach(_command: &mut std::process::Command) {}

    #[derive(Default)]
    pub struct Waiter;

    impl Waiter {
        pub fn acquire(&mut self, _pid: u32) -> Acquired {
            record("the relaunch helper runs only on Windows");
            Acquired::Unreadable
        }

        pub fn wait(&mut self, _pid: u32, _timeout_ms: u32) -> Waited {
            Waited::Unreadable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orgtree-relaunch-unit-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pid_parsing_matches_the_python_helper() {
        assert_eq!(parse_pid("42"), Ok(42));
        assert_eq!(parse_pid(" +42 "), Ok(42));
        assert!(parse_pid("abc").unwrap_err().contains("is not a number"));
        assert!(parse_pid("").unwrap_err().contains("is not a number"));
        assert!(parse_pid("0").unwrap_err().contains("is invalid"));
        assert!(parse_pid("-5").unwrap_err().contains("is invalid"));
        assert!(parse_pid("99999999999").unwrap_err().contains("is invalid"));
    }

    #[test]
    fn missing_arguments_are_refused() {
        assert_eq!(run(&[]), EXIT_BAD_ARGUMENTS);
        assert_eq!(run(&["12".into()]), EXIT_BAD_ARGUMENTS);
        assert_eq!(run(&["x".into(), "app.exe".into()]), EXIT_BAD_ARGUMENTS);
        assert_eq!(run(&["12".into(), "".into()]), EXIT_BAD_ARGUMENTS);
    }

    #[test]
    fn the_claim_is_atomic_and_has_three_answers() {
        let dir = scratch("claim");
        let claim = dir.join("x.launch-claim");
        let claim = claim.to_str().unwrap();
        assert_eq!(claim_launch(claim), Ownership::Owned);
        assert!(fs::read_to_string(claim).unwrap().starts_with("helper "));
        assert_eq!(claim_launch(claim), Ownership::OwnedElsewhere);
        assert_eq!(claim_launch(""), Ownership::Unclaimable);
        let unmakeable = dir.join("no-such-dir").join("y.launch-claim");
        assert_eq!(claim_launch(unmakeable.to_str().unwrap()), Ownership::Unclaimable);
        release_claim(claim);
        assert!(!Path::new(claim).exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_only_touches_the_installer_staging_directory() {
        let dir = scratch("cleanup");
        let staged = dir.join("OrgtreeInstallerRelaunch-4242");
        fs::create_dir_all(&staged).unwrap();
        let marker = staged.join("relaunch-started.txt");
        fs::write(&marker, "started 1\n").unwrap();
        let other = dir.join("ready.txt");
        assert_eq!(staging_dir(other.to_str().unwrap()), None);
        assert_eq!(staging_dir(""), None);
        clean_up(other.to_str().unwrap());
        assert!(dir.exists());
        clean_up(marker.to_str().unwrap());
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn describe_keeps_the_windows_error_number() {
        let error = io::Error::from_raw_os_error(5);
        let text = describe(&error);
        assert!(text.ends_with("(Windows error 5)"), "{text}");
        assert!(!text.contains("os error"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn an_owned_claim_is_released_when_the_installer_never_exits() {
        let dir = scratch("timeout");
        let claim = dir.join("t.launch-claim");
        let ready = dir.join("ready.txt");
        std::env::set_var("ORGTREE_RELAUNCH_LOG_DIR", &dir);
        std::env::set_var("ORGTREE_RELAUNCH_TIMEOUT_MS", "100");
        // This process never exits during the wait, so the wait times out.
        let code = run(&[
            std::process::id().to_string(),
            dir.join("never-started.exe").to_string_lossy().into_owned(),
            ready.to_string_lossy().into_owned(),
            claim.to_string_lossy().into_owned(),
        ]);
        assert_eq!(code, EXIT_STILL_RUNNING);
        assert!(ready.exists(), "the helper acknowledged after holding the handle and the claim");
        assert!(!claim.exists(), "a helper that gave up must release its claim");
        let log = fs::read_to_string(dir.join(LOG_NAME)).unwrap();
        assert!(log.contains("[installer-relaunch] waiting for installer process"), "{log}");
        assert!(log.contains("had not exited after 100 ms"), "{log}");
        let _ = fs::remove_dir_all(dir);
    }
}
