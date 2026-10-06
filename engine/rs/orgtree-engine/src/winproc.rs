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

#[cfg(not(windows))]
mod imp_other {
    pub const CREATE_NO_WINDOW: u32 = 0;
    pub fn install_root_job() -> bool {
        false
    }
    pub struct ChildJob;
    impl ChildJob {
        pub fn terminate(&self) {}
    }
    pub fn process_alive(_pid: u32) -> bool {
        true
    }
    pub fn watch_parent(_pid: u32, _on_exit: impl FnOnce() + Send + 'static) {}
}
#[cfg(not(windows))]
pub use imp_other::*;

/// Configure a tokio command so it never opens a console window.
#[logged]
pub fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
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

#[cfg(not(windows))]
#[logged]
pub fn child_job(_child: &tokio::process::Child) -> Option<ChildJob> {
    None
}
