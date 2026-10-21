//! Windows process plumbing: the kill-on-close job that ties every child to
//! this process, per-child jobs for killing one subtree, the parent watch,
//! and children started without administrator rights.

#[cfg(windows)]
mod imp {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::process::ExitStatus;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, LocalFree, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, GetSecurityDescriptorDacl, GetTokenInformation, SetTokenInformation, TokenDefaultDacl,
        TokenIntegrityLevel, TokenUser, DISABLE_MAX_PRIVILEGE, PSID, SID_AND_ATTRIBUTES, TOKEN_ALL_ACCESS, TOKEN_DEFAULT_DACL,
        TOKEN_MANDATORY_LABEL,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken, TerminateProcess, UpdateProcThreadAttribute,
        WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    struct SendHandle(HANDLE);
    unsafe impl Send for SendHandle {}
    unsafe impl Sync for SendHandle {}

    static ROOT_JOB: OnceLock<SendHandle> = OnceLock::new();

    fn kill_on_close_job() -> Option<HANDLE> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job)
        }
    }

    /// Put THIS process in a kill-on-close job. Every child we start joins
    /// it automatically, and when this process dies (however it dies) the
    /// last handle closes and Windows terminates every descendant.
    pub fn install_root_job() -> bool {
        if ROOT_JOB.get().is_some() {
            return true;
        }
        let Some(job) = kill_on_close_job() else { return false };
        unsafe {
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                CloseHandle(job);
                return false;
            }
        }
        let _ = ROOT_JOB.set(SendHandle(job));
        true
    }

    /// A job for one child's whole subtree (nested inside the root job), so
    /// one agent's CLI and everything it started can be ended together.
    pub struct ChildJob(HANDLE);
    unsafe impl Send for ChildJob {}
    unsafe impl Sync for ChildJob {}

    impl ChildJob {
        pub fn for_process(handle: HANDLE) -> Option<ChildJob> {
            let job = kill_on_close_job()?;
            unsafe {
                if AssignProcessToJobObject(job, handle) == 0 {
                    CloseHandle(job);
                    return None;
                }
            }
            Some(ChildJob(job))
        }
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for ChildJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn process_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let r = WaitForSingleObject(h, 0);
            CloseHandle(h);
            r != WAIT_OBJECT_0
        }
    }

    /// Is `pid` running: Some(true) running, Some(false) decisively gone
    /// (no such pid, or exited), None when the probe could not see (access
    /// denied or any other failure), as 3.x `liveness.observe`.
    #[logged]
    pub fn process_state(pid: u32) -> Option<bool> {
        const ERROR_INVALID_PARAMETER: i32 = 87;
        const WAIT_TIMEOUT: u32 = 258;
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                let code = std::io::Error::last_os_error().raw_os_error();
                return (code == Some(ERROR_INVALID_PARAMETER)).then_some(false);
            }
            let r = WaitForSingleObject(h, 0);
            CloseHandle(h);
            match r {
                WAIT_OBJECT_0 => Some(false),
                WAIT_TIMEOUT => Some(true),
                _ => None,
            }
        }
    }

    /// Block a dedicated thread until `pid` exits, then call `on_exit`.
    pub fn watch_parent(pid: u32, on_exit: impl FnOnce() + Send + 'static) {
        std::thread::Builder::new()
            .name("parent-watch".into())
            .spawn(move || unsafe {
                let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
                if h.is_null() {
                    on_exit();
                    return;
                }
                WaitForSingleObject(h, INFINITE);
                CloseHandle(h);
                on_exit();
            })
            .ok();
    }

    // -------------------------------------------- without administrator rights

    const SE_GROUP_INTEGRITY: u32 = 0x20;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe fn token_info(token: HANDLE, class: i32) -> Option<Vec<u64>> {
        let mut size = 0u32;
        GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut size);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        if GetTokenInformation(token, class, buf.as_mut_ptr() as *mut c_void, size, &mut size) == 0 {
            return None;
        }
        Some(buf)
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

    /// A restricted copy of this process's token for a child that must not
    /// have administrator rights: Administrators and Power Users deny-only,
    /// every privilege but SeChangeNotify removed, a Medium label, and a
    /// default DACL for the user, SYSTEM and Administrators (an elevated
    /// token's names only Administrators and SYSTEM, which such a child could
    /// not use for its own objects). The boot host's engine without "Run as
    /// admin" and every postmaster start with it.
    #[logged]
    pub fn restricted_medium_token() -> Result<OwnedHandle, String> {
        unsafe {
            let mut own: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut own) == 0 {
                return Err("could not open this process's token".into());
            }
            let own = OwnedHandle::from_raw_handle(own as RawHandle);
            let user = {
                let buf = token_info(own.as_raw_handle() as HANDLE, TokenUser).ok_or("could not read the token's user")?;
                sid_string((*(buf.as_ptr() as *const SID_AND_ATTRIBUTES)).Sid).ok_or("could not read the token's user")?
            };
            let admins = string_sid("S-1-5-32-544").ok_or("could not build a SID")?;
            let power = string_sid("S-1-5-32-547").ok_or("could not build a SID")?;
            let deny = [SID_AND_ATTRIBUTES { Sid: admins, Attributes: 0 }, SID_AND_ATTRIBUTES { Sid: power, Attributes: 0 }];
            let mut new: HANDLE = std::ptr::null_mut();
            let ok = CreateRestrictedToken(
                own.as_raw_handle() as HANDLE,
                DISABLE_MAX_PRIVILEGE,
                2,
                deny.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut new,
            );
            LocalFree(admins);
            LocalFree(power);
            if ok == 0 {
                return Err("could not create a restricted token".into());
            }
            let new = OwnedHandle::from_raw_handle(new as RawHandle);
            let medium = string_sid("S-1-16-8192").ok_or("could not build a SID")?;
            let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: medium, Attributes: SE_GROUP_INTEGRITY } };
            let ok = SetTokenInformation(
                new.as_raw_handle() as HANDLE,
                TokenIntegrityLevel,
                &label as *const _ as *const c_void,
                std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
            );
            LocalFree(medium);
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
            let set = got != 0
                && SetTokenInformation(
                    new.as_raw_handle() as HANDLE,
                    TokenDefaultDacl,
                    &dd as *const _ as *const c_void,
                    std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
                ) != 0;
            LocalFree(sd);
            if !set {
                return Err("could not set the default DACL".into());
            }
            Ok(new)
        }
    }

    /// A child `spawn_restricted` started: the calls the engine makes on a
    /// tokio child, on its own process handle (std offers no child built
    /// from one).
    #[derive(Debug)]
    pub struct RestrictedChild {
        pid: u32,
        process: OwnedHandle,
    }

    #[logged]
    impl RestrictedChild {
        #[nolog]
        pub fn id(&self) -> Option<u32> {
            Some(self.pid)
        }

        /// Its exit status once it has exited (polled while it starts up).
        #[nolog]
        pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            let h = self.process.as_raw_handle() as HANDLE;
            unsafe {
                if WaitForSingleObject(h, 0) != WAIT_OBJECT_0 {
                    return Ok(None);
                }
                let mut code = 0u32;
                if GetExitCodeProcess(h, &mut code) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
        }

        /// TerminateProcess, exit code 1, as tokio's.
        pub fn start_kill(&mut self) -> std::io::Result<()> {
            if unsafe { TerminateProcess(self.process.as_raw_handle() as HANDLE, 1) } != 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            // one that has exited already cannot be ended again: not an error
            if self.try_wait()?.is_some() {
                return Ok(());
            }
            Err(error)
        }

        /// Until it exits; cancelling the future (a timeout) leaves it running.
        pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
            loop {
                if let Some(status) = self.try_wait()? {
                    return Ok(status);
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }

    /// `program` and `args` as one command line, quoted as std quotes a
    /// tokio or std spawn's, so the child reads the same argv: the program
    /// in quotes, an argument in quotes when it is empty or holds a space or
    /// tab, backslashes doubled before a quote they precede.
    #[nolog]
    pub fn command_line(program: &OsStr, args: &[&OsStr]) -> std::io::Result<Vec<u16>> {
        let (quote, backslash) = (b'"' as u16, b'\\' as u16);
        let has_nul = |s: &OsStr| s.encode_wide().any(|c| c == 0);
        if has_nul(program) || args.iter().any(|a| has_nul(a)) {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte found in provided data"));
        }
        let mut line = vec![quote];
        line.extend(program.encode_wide());
        line.push(quote);
        for arg in args {
            line.push(b' ' as u16);
            let units: Vec<u16> = arg.encode_wide().collect();
            let quoted = units.is_empty() || units.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16);
            if quoted {
                line.push(quote);
            }
            let mut run = 0usize;
            for c in units {
                if c == backslash {
                    run += 1;
                } else {
                    if c == quote {
                        line.extend(std::iter::repeat_n(backslash, run + 1));
                    }
                    run = 0;
                }
                line.push(c);
            }
            if quoted {
                line.extend(std::iter::repeat_n(backslash, run));
                line.push(quote);
            }
        }
        Ok(line)
    }

    /// An inheritable copy of `file`'s handle, closed with the result.
    fn inheritable(file: &std::fs::File) -> std::io::Result<OwnedHandle> {
        let me = unsafe { GetCurrentProcess() };
        let mut copy: HANDLE = std::ptr::null_mut();
        if unsafe { DuplicateHandle(me, file.as_raw_handle() as HANDLE, me, &mut copy, 0, 1, DUPLICATE_SAME_ACCESS) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(copy as RawHandle) })
    }

    /// Start `cmd`'s program (an absolute path) and arguments with
    /// `restricted_medium_token`, without a window: stdin on NUL, stdout and
    /// stderr appending to `log`, those two its only inherited handles. It
    /// keeps this process's environment, working folder (or `cmd`'s) and
    /// job, and its pid is its own (no launcher in between). `cmd`'s stdio
    /// and flags are not read; an environment change is refused, as a
    /// Command cannot tell whether it was cleared.
    #[logged]
    pub fn spawn_restricted(cmd: &std::process::Command, log: &std::fs::File) -> std::io::Result<RestrictedChild> {
        use std::io::{Error, ErrorKind};
        if cmd.get_envs().next().is_some() {
            return Err(Error::new(ErrorKind::InvalidInput, "a restricted child keeps this process's environment"));
        }
        let program = cmd.get_program();
        let args: Vec<&OsStr> = cmd.get_args().collect();
        let mut line = command_line(program, &args)?;
        line.push(0);
        let app: Vec<u16> = program.encode_wide().chain(std::iter::once(0)).collect();
        let cwd: Option<Vec<u16>> = cmd.get_current_dir().map(|d| d.as_os_str().encode_wide().chain(std::iter::once(0)).collect());
        let token = restricted_medium_token().map_err(Error::other)?;
        let nul = std::fs::OpenOptions::new().read(true).write(true).open("NUL")?;
        // inheritable only for this call, and the list below limits the
        // child's inheritance to exactly these two
        let stdin = inheritable(&nul)?;
        let output = inheritable(log)?;
        let handles = [stdin.as_raw_handle() as HANDLE, output.as_raw_handle() as HANDLE];
        unsafe {
            let mut size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
            let mut buf = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)];
            let attrs = buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) == 0 {
                return Err(Error::last_os_error());
            }
            let listed = UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr() as *const c_void,
                std::mem::size_of_val(&handles),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            if listed == 0 {
                let error = Error::last_os_error();
                DeleteProcThreadAttributeList(attrs);
                return Err(error);
            }
            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = handles[0];
            si.StartupInfo.hStdOutput = handles[1];
            si.StartupInfo.hStdError = handles[1];
            si.lpAttributeList = attrs;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessAsUserW(
                token.as_raw_handle() as HANDLE,
                app.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                std::ptr::null(),
                cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                &si.StartupInfo,
                &mut pi,
            );
            let error = Error::last_os_error();
            DeleteProcThreadAttributeList(attrs);
            if ok == 0 {
                return Err(error);
            }
            CloseHandle(pi.hThread);
            Ok(RestrictedChild { pid: pi.dwProcessId, process: OwnedHandle::from_raw_handle(pi.hProcess as RawHandle) })
        }
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(all(test, windows))]
pub(crate) mod token_probe;

#[cfg(all(test, windows))]
mod restricted_tests {
    use std::ffi::OsStr;
    use std::path::PathBuf;

    fn system32(exe: &str) -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join(exe)
    }

    fn scratch_log(tag: &str) -> (PathBuf, std::fs::File) {
        let path = std::env::temp_dir().join(format!("orgtree-restricted-{tag}-{}-{}.log", std::process::id(), crate::util::random_hex(4)));
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        (path, file)
    }

    /// The command line reads back, through Windows' own parser, as the
    /// argv it was built from: spaces, empty arguments, quotes, backslashes.
    #[test]
    fn the_command_line_reads_back_as_its_arguments() {
        use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
        let program = r"C:\Program Files\Orgtree\resources\engine\postgresql\bin\postgres.exe";
        let args = [
            r"C:\Users\someone\AppData\Roaming\Orgtree v2\data\pg\cluster\data",
            "-c",
            "listen_addresses=127.0.0.1",
            "",
            "a\"b",
            r"ends in a backslash\",
            r"spaced and ends in one\",
            r#"slash then quote\"x"#,
            "tab\there",
            r"\\server\share\x",
        ];
        let os: Vec<&OsStr> = args.iter().map(OsStr::new).collect();
        let mut line = super::command_line(OsStr::new(program), &os).unwrap();
        line.push(0);
        let mut n = 0i32;
        let argv = unsafe { CommandLineToArgvW(line.as_ptr(), &mut n) };
        assert!(!argv.is_null());
        let parsed: Vec<String> = (0..n as usize)
            .map(|i| unsafe {
                let p = *argv.add(i);
                let mut len = 0;
                while *p.add(len) != 0 {
                    len += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
            })
            .collect();
        unsafe { windows_sys::Win32::Foundation::LocalFree(argv as *mut std::ffi::c_void) };
        assert_eq!(parsed[0], program);
        assert_eq!(&parsed[1..], &args[..]);
        assert!(super::command_line(OsStr::new(program), &[OsStr::new("a\0b")]).is_err(), "a nul is refused");
    }

    /// The child's own view of its token: no privilege but SeChangeNotify,
    /// Medium integrity or lower; and its stdout reaches the log.
    #[tokio::test]
    async fn a_restricted_child_holds_no_administrator_rights() {
        let (path, log) = scratch_log("whoami");
        let mut cmd = std::process::Command::new(system32("whoami.exe"));
        cmd.args(["/groups", "/priv", "/fo", "csv"]);
        let mut child = super::spawn_restricted(&cmd, &log).expect("whoami starts");
        let status = child.wait().await.unwrap();
        drop(log);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        std::fs::remove_file(&path).ok();
        assert!(status.success(), "{status}: {text}");
        let privileges: Vec<&str> = text
            .lines()
            .filter_map(|l| l.split(',').next())
            .map(|f| f.trim_matches('"'))
            .filter(|f| f.starts_with("Se") && f.ends_with("Privilege"))
            .collect();
        assert_eq!(privileges, ["SeChangeNotifyPrivilege"], "{text}");
        assert!(text.contains("\"S-1-16-"), "no integrity label listed: {text}");
        assert!(!text.contains("\"S-1-16-12288\"") && !text.contains("\"S-1-16-16384\""), "above Medium: {text}");
    }

    /// A failing child's exit code comes back, and its stderr reaches the log.
    #[tokio::test]
    async fn a_restricted_child_reports_its_exit_code_and_stderr() {
        let (path, log) = scratch_log("fails");
        let mut cmd = std::process::Command::new(system32("whoami.exe"));
        cmd.arg("/no-such-option");
        let mut child = super::spawn_restricted(&cmd, &log).expect("whoami starts");
        let status = child.wait().await.unwrap();
        drop(log);
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        std::fs::remove_file(&path).ok();
        assert!(!status.success() && status.code().is_some(), "{status}");
        assert!(!text.trim().is_empty(), "stderr did not reach the log");
    }

    /// A running child is this process's own: it stays in our job (when we
    /// are in one), try_wait sees it running, start_kill ends it with code 1.
    #[tokio::test]
    async fn a_restricted_child_can_be_watched_and_killed() {
        use crate::winproc::token_probe as probe;
        let (path, log) = scratch_log("ping");
        let mut cmd = std::process::Command::new(system32("PING.EXE"));
        cmd.args(["-n", "30", "127.0.0.1"]);
        let mut child = super::spawn_restricted(&cmd, &log).expect("ping starts");
        let pid = child.id().unwrap();
        let jobs = (probe::in_job(&probe::process(std::process::id())), probe::in_job(&probe::process(pid)));
        let running = child.try_wait().unwrap().is_none();
        child.start_kill().unwrap();
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await.expect("ended").unwrap();
        child.start_kill().expect("ending an exited child again is not an error");
        drop(log);
        std::fs::remove_file(&path).ok();
        assert!(running, "the child was not running");
        assert!(!jobs.0 || jobs.1, "the child left this process's job");
        assert_eq!(status.code(), Some(1));
        assert!(!crate::winproc::process_alive(pid));
    }

    #[test]
    fn an_environment_change_is_refused() {
        let (path, log) = scratch_log("env");
        let mut cmd = std::process::Command::new(system32("whoami.exe"));
        cmd.env("ORGTREE_X", "1");
        let refused = super::spawn_restricted(&cmd, &log).is_err();
        drop(log);
        std::fs::remove_file(&path).ok();
        assert!(refused);
    }
}

// Unix: no job objects yet (children are not killed if the engine crashes);
// liveness and the parent watch use kill(pid, 0) and getppid().
#[cfg(unix)]
mod imp_unix {
    pub const CREATE_NO_WINDOW: u32 = 0;
    #[logged]
    pub fn install_root_job() -> bool {
        false
    }
    /// An agent CLI's process group (it was started with `own_group`): the
    /// Unix stand-in for its subtree job, so ending the CLI also ends the MCP
    /// servers and commands it started.
    pub struct ChildJob {
        pub(super) pgid: libc::pid_t,
    }
    impl ChildJob {
        /// SIGTERM to the whole group now, SIGKILL to whatever is left a few
        /// seconds later. The group outlives its leader, so the CLI's own exit
        /// (or the SIGKILL its caller sends it next) does not end this.
        pub fn terminate(&self) {
            let pgid = self.pgid;
            unsafe { libc::killpg(pgid, libc::SIGTERM) };
            let _ = std::thread::Builder::new().name("group-kill".into()).spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
            });
        }
    }
    /// As dropping the Windows job (KILL_ON_JOB_CLOSE): whatever the CLI left
    /// in its group ends with it, also when the CLI exited by itself after
    /// its input closed (idle stop, idle eviction, a replaced process). The
    /// pgid cannot be reused while any member of the group still lives.
    impl Drop for ChildJob {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    #[logged]
    pub fn process_alive(pid: u32) -> bool {
        process_state(pid) != Some(false)
    }

    /// Some(true) running, Some(false) no such process, None when the probe
    /// could not tell. A zombie still counts as running until it is reaped.
    #[logged]
    pub fn process_state(pid: u32) -> Option<bool> {
        probe(pid)
    }

    /// The unlogged liveness probe behind process_state; the parent watch
    /// polls it every second.
    #[nolog]
    fn probe(pid: u32) -> Option<bool> {
        let Ok(pid) = libc::pid_t::try_from(pid) else { return Some(false) };
        if pid <= 0 {
            return Some(false);
        }
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Some(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Some(false),
            Some(libc::EPERM) => Some(true),
            _ => None,
        }
    }

    /// Poll until `pid` exits, then call `on_exit`. When `pid` is our parent,
    /// being reparented is the exit signal (a dead parent may linger as a zombie).
    #[logged]
    pub fn watch_parent(pid: u32, on_exit: impl FnOnce() + Send + 'static) {
        let was_child = unsafe { libc::getppid() } as u32 == pid;
        std::thread::Builder::new()
            .name("parent-watch".into())
            .spawn(move || {
                loop {
                    let gone = if was_child {
                        (unsafe { libc::getppid() }) as u32 != pid
                    } else {
                        probe(pid) == Some(false)
                    };
                    if gone {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
                on_exit();
            })
            .ok();
    }
}
#[cfg(unix)]
pub use imp_unix::*;

/// Bytes the machine can still commit (Windows: what `GlobalMemoryStatusEx`
/// reports as available page file); None where it cannot be read.
#[logged]
pub fn free_commit_bytes() -> Option<u64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut st: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut st) } != 0 {
            return Some(st.ullAvailPageFile);
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Configure a tokio command so it never opens a console window.
#[logged]
pub fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// Linux: the child gets SIGINT when the engine dies (PR_SET_PDEATHSIG; for
/// postgres that is a fast shutdown, which ends any lingering sessions), the
/// stand-in for the Windows kill-on-close root job, so a crashed engine does
/// not leave postgres holding the cluster and refusing every later start.
///
/// ⚠ The signal fires when the THREAD that spawned the child exits, not the
/// process. Call this only for a spawn made on the main thread (the future
/// main() drives with `block_on`, which lives as long as the process). A spawn
/// from a tokio blocking-pool thread would be killed seconds later.
#[logged]
pub fn die_with_engine(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGINT as libc::c_ulong) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let _ = cmd;
}

/// Wrap a freshly spawned child in its own subtree job.
#[cfg(windows)]
#[logged]
pub fn child_job(child: &tokio::process::Child) -> Option<ChildJob> {
    let h = child.raw_handle()?;
    ChildJob::for_process(h as _)
}

/// Unix: the child's process group, when it leads one of its own (started
/// with `own_group`). Never another group: killpg on the engine's own group
/// would end the engine.
#[cfg(not(windows))]
#[logged]
pub fn child_job(child: &tokio::process::Child) -> Option<ChildJob> {
    let pid = libc::pid_t::try_from(child.id()?).ok()?;
    (pid > 0 && unsafe { libc::getpgid(pid) } == pid).then_some(ChildJob { pgid: pid })
}

/// Unix: start an agent CLI in a process group of its own, so `child_job`
/// can end everything it starts (MCP servers, long shell commands) on kill,
/// interrupt or retire. Windows: the subtree job does that; nothing to set.
#[logged]
pub fn own_group(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let _ = cmd;
}

/// The volume's 8.3 alias for `path`: None when there is none, or when it
/// does not open the same file (8dot3 creation is per volume and often off).
#[cfg(windows)]
pub fn short_path(path: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 4096];
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return None;
    }
    let short = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
    if short == path {
        return None;
    }
    let a = std::fs::canonicalize(&short).ok()?;
    let b = std::fs::canonicalize(path).ok()?;
    (a == b).then_some(short)
}

#[cfg(not(windows))]
pub fn short_path(_path: &std::path::Path) -> Option<std::path::PathBuf> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    /// An agent CLI's group ends with it: the shell's background child (the
    /// stand-in for an MCP server or a long Bash command) is gone after
    /// terminate, not orphaned.
    #[tokio::test]
    async fn terminate_ends_the_whole_group() {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 60 & echo $!; wait").stdout(std::process::Stdio::piped());
        super::own_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let job = super::child_job(&child).expect("the child leads its own group");
        let mut out = child.stdout.take().unwrap();
        let mut line = String::new();
        {
            use tokio::io::AsyncBufReadExt;
            tokio::io::BufReader::new(&mut out).read_line(&mut line).await.unwrap();
        }
        let grandchild: u32 = line.trim().parse().expect("the background pid");
        assert!(super::process_alive(grandchild));
        job.terminate();
        let _ = child.wait().await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while super::process_alive(grandchild) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!super::process_alive(grandchild), "the group's other member outlived terminate");
    }

    /// A CLI that exits by itself (its input closed) leaves its background
    /// child behind; dropping its job ends that child, as on Windows.
    #[tokio::test]
    async fn dropping_the_job_ends_what_an_exited_cli_left() {
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 60 >/dev/null 2>&1 & echo $!").stdout(std::process::Stdio::piped());
        super::own_group(&mut cmd);
        let child = cmd.spawn().expect("spawn sh");
        let job = super::child_job(&child).expect("the child leads its own group");
        let out = child.wait_with_output().await.expect("the CLI exits by itself");
        let grandchild: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("the background pid");
        assert!(super::process_alive(grandchild), "the leftover outlived its CLI");
        drop(job);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while super::process_alive(grandchild) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(!super::process_alive(grandchild), "dropping the job left the CLI's child running");
    }

    #[test]
    fn no_job_for_a_child_in_the_engine_group() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let mut child = tokio::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
            assert!(super::child_job(&child).is_none(), "killpg would hit the engine's own group");
            let _ = child.kill().await;
        });
    }
}
