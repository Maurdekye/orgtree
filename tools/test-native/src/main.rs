//! `orgtree-test-native`: Windows helpers for the root tests. TEST-ONLY; it is
//! never packaged. It replaces the `python -c` ctypes snippets the tests used
//! before Python was removed (4.6.1 phase 2). Build it once with
//! `cargo build --manifest-path tools/test-native/Cargo.toml`; the tests find
//! it through tools/native-test-bins.mjs.
//!
//! Subcommands (exit codes >= 10 are this helper's own setup failures):
//!   lockdown               give this process an empty protected DACL, print
//!                          "locked", then sleep 120 s (an unreadable process)
//!   without-debug EXE ...  disable SeDebugPrivilege in this token, run EXE with
//!                          the remaining arguments, exit with its exit code
//!   can-open PID           print "opened" or "refused <error>" for
//!                          OpenProcess(SYNCHRONIZE) on PID (instrument control)
//!   alive PID              print "alive" while PID has not exited, else "gone"
//!   hold-lock ROOT [SECS]  hold ROOT\.desktop-engine.lock, print "held", release
//!                          after SECS (default 120), print "released"
//!   guardian ...           private: the synthetic engine's Job guardian
//!
//! Copied or named `orgtree-engine-stub.exe`, the image IS the synthetic engine
//! the desktop supervisor tests spawn (see lifetime.rs and tests/engine-stub.mjs).

#[cfg(windows)]
mod lifetime;

fn usage() -> ! {
    eprintln!("usage: orgtree-test-native <lockdown|without-debug EXE ARGS...|can-open PID|alive PID|hold-lock ROOT [SECS]>");
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    {
        if args.first().map(String::as_str) == Some("guardian") {
            std::process::exit(lifetime::guardian(&args[1..]));
        }
        let stem = std::env::current_exe().ok().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()));
        if stem.as_deref() == Some("orgtree-engine-stub") {
            std::process::exit(lifetime::engine_stub());
        }
    }
    let Some(command) = args.first() else { usage() };
    let rest = &args[1..];
    let code = match command.as_str() {
        "lockdown" => win::lockdown(),
        "without-debug" => win::without_debug(rest),
        "can-open" => win::can_open(rest),
        #[cfg(windows)]
        "alive" => lifetime::alive(rest),
        #[cfg(windows)]
        "hold-lock" => lifetime::hold_lock(rest),
        _ => usage(),
    };
    std::process::exit(code);
}

#[cfg(windows)]
mod win {
    use std::io::Write;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LUID};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, SetKernelObjectSecurity, DACL_SECURITY_INFORMATION, LUID_AND_ATTRIBUTES,
        PSECURITY_DESCRIPTOR, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_SYNCHRONIZE};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// An empty, protected DACL: OpenProcess(SYNCHRONIZE) is refused to every
    /// caller without an enabled SeDebugPrivilege, administrators included.
    pub fn lockdown() -> i32 {
        let sddl = wide("D:P");
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: plain Win32 calls on this process; sd is leaked on purpose
        // (the process sleeps and exits).
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
                return 10;
            }
            if SetKernelObjectSecurity(GetCurrentProcess(), DACL_SECURITY_INFORMATION, sd) == 0 {
                return 11;
            }
        }
        let mut out = std::io::stdout();
        let _ = writeln!(out, "locked");
        let _ = out.flush();
        std::thread::sleep(std::time::Duration::from_secs(120));
        0
    }

    /// The installer runs the relaunch helper WITHOUT an enabled
    /// SeDebugPrivilege; a test runner can inherit it enabled, which makes every
    /// process readable. A child gets a copy of this token, privilege states
    /// included.
    pub fn without_debug(args: &[String]) -> i32 {
        let Some((exe, rest)) = args.split_first() else { return 2 };
        // SAFETY: token handle is ours and closed below.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token) == 0 {
                return 12;
            }
            let mut luid = LUID { LowPart: 0, HighPart: 0 };
            let name = wide("SeDebugPrivilege");
            if LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) == 0 {
                CloseHandle(token);
                return 13;
            }
            let privileges = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: 0 }] };
            let adjusted = AdjustTokenPrivileges(token, 0, &privileges, 0, std::ptr::null_mut(), std::ptr::null_mut());
            CloseHandle(token);
            if adjusted == 0 {
                return 14;
            }
        }
        match std::process::Command::new(exe).args(rest).status() {
            Ok(status) => status.code().unwrap_or(15),
            Err(_) => 16,
        }
    }

    pub fn can_open(args: &[String]) -> i32 {
        let Some(pid) = args.first().and_then(|p| p.parse::<u32>().ok()) else { return 2 };
        // SAFETY: plain Win32 calls; the handle is closed at once.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                println!("refused {}", GetLastError());
            } else {
                CloseHandle(handle);
                println!("opened");
            }
        }
        0
    }
}

#[cfg(not(windows))]
mod win {
    pub fn lockdown() -> i32 {
        eprintln!("Windows only");
        2
    }
    pub fn without_debug(_args: &[String]) -> i32 {
        lockdown()
    }
    pub fn can_open(_args: &[String]) -> i32 {
        lockdown()
    }
}
