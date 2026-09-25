//! The few Win32 calls the custodian needs: free commit, random bytes, a
//! process snapshot, and handles that let us WAIT for a process to exit.
//! Holding a handle opened before `pg_ctl stop` also pins the PID, so a
//! reused PID can never be mistaken for a survivor (or for an exit).

use crate::error::{CustodianError, Result};
use std::path::{Path, PathBuf};

/// Refuse to start PostgreSQL work below this much free commit (charter:
/// "refuse to start below 4 GB free"). A caller may raise it, never lower it.
pub const COMMIT_FLOOR_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent_pid: u32,
    pub exe_name: String,
    /// Creation time (FILETIME ticks), when the process could be opened.
    /// Windows never updates a child's recorded parent PID, so a process
    /// whose parent died can name a PID that now belongs to someone else;
    /// only a child created AFTER that PID's current owner is really its child.
    pub created: Option<u64>,
}

/// The owned process family of `postmaster`: itself; the `cmd.exe` shim
/// pg_ctl wraps it in, if its parent is one; and every descendant of either.
/// Parent links count only when the child was created no earlier than the
/// parent (see [`ProcessInfo::created`]); an unknown creation time never links.
pub fn family_pids(procs: &[ProcessInfo], postmaster: u32) -> Vec<u32> {
    let find = |pid: u32| procs.iter().find(|p| p.pid == pid);
    let links = |child: &ProcessInfo, parent: &ProcessInfo| match (child.created, parent.created) {
        (Some(c), Some(p)) => child.parent_pid == parent.pid && c >= p && child.pid != parent.pid,
        _ => false,
    };
    let Some(pm) = find(postmaster) else { return vec![] };
    let mut set = vec![postmaster];
    if let Some(parent) = find(pm.parent_pid) {
        if parent.exe_name.eq_ignore_ascii_case("cmd.exe") && links(pm, parent) {
            set.push(parent.pid);
        }
    }
    loop {
        let before = set.len();
        for p in procs {
            if p.pid == 0 || set.contains(&p.pid) {
                continue;
            }
            if let Some(parent) = find(p.parent_pid) {
                if set.contains(&parent.pid) && links(p, parent) {
                    set.push(p.pid);
                }
            }
        }
        if set.len() == before {
            break;
        }
    }
    set
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub fn free_commit_bytes() -> Result<u64> {
        let mut st: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut st) } == 0 {
            return Err(CustodianError::new("win.memory_status", std::io::Error::last_os_error().to_string()));
        }
        Ok(st.ullAvailPageFile)
    }

    pub fn random_bytes(buf: &mut [u8]) -> Result<()> {
        let status = unsafe {
            BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
        };
        if status != 0 {
            return Err(CustodianError::new("win.random", format!("BCryptGenRandom NTSTATUS {status:#x}")));
        }
        Ok(())
    }

    pub fn snapshot() -> Result<Vec<ProcessInfo>> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return Err(CustodianError::new("win.snapshot", std::io::Error::last_os_error().to_string()));
        }
        let mut out = Vec::new();
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = unsafe { Process32FirstW(snap, &mut e) };
        while ok != 0 {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.push(ProcessInfo {
                pid: e.th32ProcessID,
                parent_pid: e.th32ParentProcessID,
                exe_name: String::from_utf16_lossy(&e.szExeFile[..len]),
                created: creation_time(e.th32ProcessID),
            });
            ok = unsafe { Process32NextW(snap, &mut e) };
        }
        unsafe { CloseHandle(snap) };
        Ok(out)
    }

    fn creation_time(pid: u32) -> Option<u64> {
        if pid == 0 {
            return None;
        }
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut x, mut k, mut u) = (z, z, z, z);
        let ok = unsafe { GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u) };
        unsafe { CloseHandle(h) };
        if ok == 0 {
            return None;
        }
        Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }

    /// An open handle on a process: while we hold it the PID cannot be reused.
    pub struct ProcessHandle {
        pub pid: u32,
        h: HANDLE,
    }

    unsafe impl Send for ProcessHandle {}

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.h) };
        }
    }

    impl ProcessHandle {
        pub fn open(pid: u32) -> Option<Self> {
            let h = unsafe {
                OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid)
            };
            if h.is_null() {
                let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
                if h.is_null() {
                    return None;
                }
                return Some(Self { pid, h });
            }
            Some(Self { pid, h })
        }

        pub fn image_path(&self) -> Option<PathBuf> {
            let mut buf = vec![0u16; 32768];
            let mut len = buf.len() as u32;
            let ok = unsafe { QueryFullProcessImageNameW(self.h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) };
            if ok == 0 {
                return None;
            }
            Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
        }

        /// True once the process has exited (or within `timeout_ms`).
        pub fn wait_exit(&self, timeout_ms: u32) -> bool {
            match unsafe { WaitForSingleObject(self.h, timeout_ms) } {
                WAIT_OBJECT_0 => true,
                WAIT_TIMEOUT => false,
                _ => false,
            }
        }

        pub fn exit_code(&self) -> Option<u32> {
            let mut code = 0u32;
            if unsafe { GetExitCodeProcess(self.h, &mut code) } == 0 {
                return None;
            }
            Some(code)
        }

        pub fn terminate(&self) -> bool {
            unsafe { TerminateProcess(self.h, 1) != 0 }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    fn unsupported<T>() -> Result<T> {
        Err(CustodianError::new("win.unsupported", "pg-custodian runs on Windows only in P03"))
    }
    pub fn free_commit_bytes() -> Result<u64> {
        unsupported()
    }
    pub fn random_bytes(_buf: &mut [u8]) -> Result<()> {
        unsupported()
    }
    pub fn snapshot() -> Result<Vec<ProcessInfo>> {
        unsupported()
    }
    pub struct ProcessHandle {
        pub pid: u32,
    }
    impl ProcessHandle {
        pub fn open(_pid: u32) -> Option<Self> {
            None
        }
        pub fn image_path(&self) -> Option<PathBuf> {
            None
        }
        pub fn wait_exit(&self, _t: u32) -> bool {
            false
        }
        pub fn exit_code(&self) -> Option<u32> {
            None
        }
        pub fn terminate(&self) -> bool {
            false
        }
    }
}

pub use imp::{free_commit_bytes, random_bytes, snapshot, ProcessHandle};

pub fn random_hex(n_bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; n_bytes];
    random_bytes(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Refuse when free commit is below `floor` (never below the hard floor).
pub fn require_commit(floor: u64, what: &str) -> Result<u64> {
    let floor = floor.max(COMMIT_FLOOR_BYTES);
    let free = free_commit_bytes()?;
    if free < floor {
        return Err(CustodianError::new(
            "memory.below_floor",
            format!(
                "{what} refused: {:.2} GB commit free, floor is {:.2} GB",
                free as f64 / 1e9,
                floor as f64 / 1e9
            ),
        ));
    }
    Ok(free)
}

/// Case-insensitive comparison of two image paths after canonicalizing.
pub fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let c = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        crate::guard::lexical(&c).unwrap_or_else(|_| c.to_string_lossy().to_lowercase())
    };
    norm(a) == norm(b)
}
