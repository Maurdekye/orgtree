//! Windows process plumbing: the kill-on-close job that ties every child to
//! this process, per-child jobs for killing one subtree, and the parent watch.

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
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
}

#[cfg(windows)]
pub use imp::*;

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
