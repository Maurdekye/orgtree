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

    /// Make this process's stdin/stdout/stderr handles non-inheritable.
    ///
    /// `pg_ctl start` leaves a long-lived postmaster (via a `cmd.exe` shim)
    /// that inherits every inheritable handle in the chain. If our standard
    /// handles are pipes owned by a caller that captures our output, the
    /// postmaster would hold the pipe's write end open and the caller would
    /// never see end-of-file until the cluster stopped. Rust passes the
    /// handles it gives a child explicitly (duplicated as inheritable), so
    /// clearing the flag on our own copies changes nothing else.
    pub fn stop_std_handle_inheritance() {
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let h = unsafe { GetStdHandle(which) };
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) };
            }
        }
    }

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

    pub fn creation_time(pid: u32) -> Option<u64> {
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

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(h: HANDLE, class: u32, info: *mut core::ffi::c_void, len: u32, ret: *mut u32) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn CommandLineToArgvW(cmd: *const u16, argc: *mut i32) -> *mut *mut u16;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
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

        /// Creation time (FILETIME ticks) read through THIS handle, so it
        /// describes exactly the process the handle pins.
        pub fn creation_time(&self) -> Option<u64> {
            let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut c, mut x, mut k, mut u) = (z, z, z, z);
            if unsafe { GetProcessTimes(self.h, &mut c, &mut x, &mut k, &mut u) } == 0 {
                return None;
            }
            Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
        }

        /// The process's command line, split the way Windows splits it
        /// (CommandLineToArgvW). None when it cannot be read.
        pub fn argv(&self) -> Option<Vec<String>> {
            let mut buf: Vec<u64> = vec![0; 8192];
            let mut ret = 0u32;
            let query = |buf: &mut Vec<u64>, ret: &mut u32| unsafe {
                NtQueryInformationProcess(self.h, PROCESS_COMMAND_LINE_INFORMATION, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, ret)
            };
            let mut st = query(&mut buf, &mut ret);
            if st == STATUS_INFO_LENGTH_MISMATCH && ret as usize > buf.len() * 8 {
                buf = vec![0; (ret as usize).div_ceil(8)];
                st = query(&mut buf, &mut ret);
            }
            if st < 0 {
                return None;
            }
            let us = unsafe { &*(buf.as_ptr() as *const UnicodeString) };
            if us.buffer.is_null() || us.length == 0 {
                return None;
            }
            let mut wide = unsafe { std::slice::from_raw_parts(us.buffer, us.length as usize / 2) }.to_vec();
            wide.push(0);
            let mut argc = 0i32;
            let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut argc) };
            if argv.is_null() {
                return None;
            }
            let mut out = Vec::with_capacity(argc.max(0) as usize);
            for i in 0..argc.max(0) as usize {
                let p = unsafe { *argv.add(i) };
                let mut n = 0;
                while unsafe { *p.add(n) } != 0 {
                    n += 1;
                }
                out.push(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, n) }));
            }
            unsafe { LocalFree(argv.cast()) };
            Some(out)
        }
    }

    /// A handle closed on drop.
    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn os_err(code: &'static str, what: &str) -> CustodianError {
        CustodianError::new(code, format!("{what}: {}", std::io::Error::last_os_error()))
    }

    /// Our own token with the Administrators and Power Users groups made
    /// deny-only and every privilege but SeChangeNotify removed: the token
    /// PostgreSQL's own `pg_ctl` and `initdb` give the server on Windows
    /// (CreateRestrictedProcess). The current user is added to its default
    /// DACL, as PostgreSQL does, so the child can still open its own process
    /// and token when the only grant there was to Administrators (elevated).
    fn restricted_token() -> Result<Owned> {
        use windows_sys::Win32::Security::{
            AllocateAndInitializeSid, CreateRestrictedToken, FreeSid, DISABLE_MAX_PRIVILEGE, PSID, SID_AND_ATTRIBUTES,
            SID_IDENTIFIER_AUTHORITY, TOKEN_ALL_ACCESS,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut orig: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut orig) } == 0 {
            return Err(os_err("win.token", "could not open our process token"));
        }
        let orig = Owned(orig);
        let nt = SID_IDENTIFIER_AUTHORITY { Value: [0, 0, 0, 0, 0, 5] };
        // BUILTIN\Administrators (32-544) and BUILTIN\Power Users (32-547)
        let mut sids: [PSID; 2] = [std::ptr::null_mut(); 2];
        for (sid, rid) in sids.iter_mut().zip([544u32, 547]) {
            if unsafe { AllocateAndInitializeSid(&nt, 2, 32, rid, 0, 0, 0, 0, 0, 0, sid) } == 0 {
                for s in sids.iter().filter(|s| !s.is_null()) {
                    unsafe { FreeSid(*s) };
                }
                return Err(os_err("win.token", "could not build the Administrators SID"));
            }
        }
        let deny = sids.map(|s| SID_AND_ATTRIBUTES { Sid: s, Attributes: 0 });
        let mut new: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            CreateRestrictedToken(
                orig.0,
                DISABLE_MAX_PRIVILEGE,
                deny.len() as u32,
                deny.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut new,
            )
        };
        for s in sids {
            unsafe { FreeSid(s) };
        }
        if ok == 0 {
            return Err(os_err("win.token", "could not create a restricted token"));
        }
        let new = Owned(new);
        add_user_to_default_dacl(new.0)?;
        Ok(new)
    }

    fn token_info(token: HANDLE, class: i32) -> Result<Vec<u64>> {
        use windows_sys::Win32::Security::GetTokenInformation;
        let mut len = 0u32;
        unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut len) };
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        if unsafe { GetTokenInformation(token, class, buf.as_mut_ptr().cast(), len, &mut len) } == 0 {
            return Err(os_err("win.token", "could not read the token"));
        }
        Ok(buf)
    }

    fn add_user_to_default_dacl(token: HANDLE) -> Result<()> {
        use windows_sys::Win32::Foundation::GENERIC_ALL;
        use windows_sys::Win32::Security::{
            AclSizeInformation, AddAccessAllowedAce, AddAce, GetAce, GetAclInformation, GetLengthSid, InitializeAcl,
            SetTokenInformation, TokenDefaultDacl, TokenUser, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
            TOKEN_DEFAULT_DACL, TOKEN_USER,
        };
        let dacl_buf = token_info(token, TokenDefaultDacl)?;
        let old: *mut ACL = unsafe { (*(dacl_buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl };
        let user_buf = token_info(token, TokenUser)?;
        let sid = unsafe { (*(user_buf.as_ptr() as *const TOKEN_USER)).User.Sid };
        let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        if !old.is_null() {
            let n = std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32;
            if unsafe { GetAclInformation(old, (&mut info as *mut ACL_SIZE_INFORMATION).cast(), n, AclSizeInformation) } == 0 {
                return Err(os_err("win.token", "could not read the default DACL"));
            }
        }
        // PostgreSQL's AddUserToTokenDacl: old ACL + one ACCESS_ALLOWED_ACE
        // (whose SidStart DWORD the SID itself replaces).
        let size = info.AclBytesInUse.max(std::mem::size_of::<ACL>() as u32) + 8 + unsafe { GetLengthSid(sid) };
        let mut acl_buf = vec![0u64; (size as usize).div_ceil(8)];
        let acl = acl_buf.as_mut_ptr() as *mut ACL;
        if unsafe { InitializeAcl(acl, size, ACL_REVISION) } == 0 {
            return Err(os_err("win.token", "could not build the default DACL"));
        }
        for i in 0..info.AceCount {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            if unsafe { GetAce(old, i, &mut ace) } == 0 {
                return Err(os_err("win.token", "could not read a default DACL entry"));
            }
            let len = unsafe { (*(ace as *const ACE_HEADER)).AceSize } as u32;
            if unsafe { AddAce(acl, ACL_REVISION, u32::MAX, ace, len) } == 0 {
                return Err(os_err("win.token", "could not copy a default DACL entry"));
            }
        }
        if unsafe { AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, sid) } == 0 {
            return Err(os_err("win.token", "could not grant the user in the default DACL"));
        }
        let dd = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        let n = std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32;
        if unsafe { SetTokenInformation(token, TokenDefaultDacl, (&dd as *const TOKEN_DEFAULT_DACL).cast(), n) } == 0 {
            return Err(os_err("win.token", "could not set the default DACL"));
        }
        Ok(())
    }

    /// Append `arg` to a command line, quoted the way CommandLineToArgvW and
    /// the C runtime split it back.
    fn push_arg(out: &mut Vec<u16>, arg: &std::ffi::OsStr) {
        use std::os::windows::ffi::OsStrExt;
        let (bs, quote) = (b'\\' as u16, b'"' as u16);
        if !out.is_empty() {
            out.push(b' ' as u16);
        }
        let w: Vec<u16> = arg.encode_wide().collect();
        if !w.is_empty() && !w.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'\n' as u16 || c == quote) {
            out.extend(w);
            return;
        }
        out.push(quote);
        let mut run = 0usize;
        for c in w {
            if c == bs {
                run += 1;
                continue;
            }
            let n = if c == quote { run * 2 + 1 } else { run };
            out.extend(std::iter::repeat_n(bs, n));
            run = 0;
            out.push(c);
        }
        out.extend(std::iter::repeat_n(bs, run * 2));
        out.push(quote);
    }

    pub fn command_line(exe: &Path, args: &[&std::ffi::OsStr]) -> Vec<u16> {
        let mut cmd = Vec::new();
        push_arg(&mut cmd, exe.as_os_str());
        for a in args {
            push_arg(&mut cmd, a);
        }
        cmd
    }

    pub fn run_restricted(
        exe: &Path,
        args: &[&std::ffi::OsStr],
        env: &[(std::ffi::OsString, std::ffi::OsString)],
        stdin: &[u8],
        log: &Path,
    ) -> Result<u32> {
        use std::io::Write;
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::System::Pipes::CreatePipe;
        use windows_sys::Win32::System::Threading::{
            CreateProcessAsUserW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        };

        let token = restricted_token()?;
        let logf = std::fs::File::create(log).map_err(|e| CustodianError::io("win.spawn", log, e))?;
        let log_h = logf.as_raw_handle() as HANDLE;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let (mut r, mut w): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut r, &mut w, &sa, 0) } == 0 {
            return Err(os_err("win.spawn", "could not create the stdin pipe"));
        }
        let (r, w) = (Owned(r), Owned(w));
        // Only the child's two ends are inheritable, and the attribute list
        // below limits inheritance to exactly them.
        if unsafe { SetHandleInformation(w.0, HANDLE_FLAG_INHERIT, 0) } == 0
            || unsafe { SetHandleInformation(log_h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
        {
            return Err(os_err("win.spawn", "could not set handle inheritance"));
        }
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut attr_buf = vec![0u64; size.div_ceil(8).max(1)];
        let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if unsafe { InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) } == 0 {
            return Err(os_err("win.spawn", "could not build the attribute list"));
        }
        let inherit = [r.0, log_h];
        let ok = unsafe {
            UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherit.as_ptr().cast(),
                std::mem::size_of_val(&inherit),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ok == 0 {
            unsafe { DeleteProcThreadAttributeList(attrs) };
            return Err(os_err("win.spawn", "could not limit handle inheritance"));
        }
        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = r.0;
        si.StartupInfo.hStdOutput = log_h;
        si.StartupInfo.hStdError = log_h;
        si.lpAttributeList = attrs;

        let mut app: Vec<u16> = exe.as_os_str().encode_wide().collect();
        app.push(0);
        let mut cmd = command_line(exe, args);
        cmd.push(0);
        let mut vars: Vec<&(std::ffi::OsString, std::ffi::OsString)> = env.iter().collect();
        vars.sort_by_key(|(k, _)| k.to_string_lossy().to_uppercase());
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in vars {
            block.extend(k.encode_wide());
            block.push(b'=' as u16);
            block.extend(v.encode_wide());
            block.push(0);
        }
        block.push(0);

        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            CreateProcessAsUserW(
                token.0,
                app.as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                block.as_ptr().cast(),
                std::ptr::null(),
                &si.StartupInfo,
                &mut pi,
            )
        };
        let spawn_err = (ok == 0).then(|| os_err("win.spawn", &format!("could not start {}", exe.display())));
        unsafe { DeleteProcThreadAttributeList(attrs) };
        drop(r);
        drop(logf);
        if let Some(e) = spawn_err {
            return Err(e);
        }
        let process = Owned(pi.hProcess);
        drop(Owned(pi.hThread));

        // The child's end is closed above, so a child that dies early turns
        // this into a broken pipe instead of a hang; its exit code decides.
        let mut pipe = unsafe { std::fs::File::from_raw_handle(w.0 as _) };
        std::mem::forget(w);
        let wrote = pipe.write_all(stdin);
        drop(pipe);
        unsafe { WaitForSingleObject(process.0, INFINITE) };
        let mut code = 0u32;
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
            return Err(os_err("win.spawn", "could not read the exit code"));
        }
        if code == 0 {
            wrote.map_err(|e| CustodianError::new("win.spawn", format!("could not write the child's input: {e}")))?;
        }
        Ok(code)
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
    pub fn stop_std_handle_inheritance() {}
    pub fn creation_time(_pid: u32) -> Option<u64> {
        None
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
        pub fn creation_time(&self) -> Option<u64> {
            None
        }
        pub fn argv(&self) -> Option<Vec<String>> {
            None
        }
    }
    pub fn run_restricted(
        _exe: &Path,
        _args: &[&std::ffi::OsStr],
        _env: &[(std::ffi::OsString, std::ffi::OsString)],
        _stdin: &[u8],
        _log: &Path,
    ) -> Result<u32> {
        unsupported()
    }
}

/// Run `exe args` without administrator rights and wait for its exit code:
/// see `restricted_token` (Windows). Its standard input receives `stdin` and
/// its standard output and error go to `log` (truncated first); only those
/// two handles are inherited. `env` is the child's WHOLE environment.
/// `postgres` refuses to run with administrator rights, so an Orgtree started
/// as administrator could not bootstrap a cluster without this.
pub use imp::run_restricted;
#[cfg(windows)]
pub use imp::command_line;
pub use imp::{creation_time, free_commit_bytes, random_bytes, snapshot, stop_std_handle_inheritance, ProcessHandle};

/// PostgreSQL's words when it refuses to run with administrator rights.
pub fn refused_as_admin(log_text: &str) -> bool {
    log_text.contains("by a user with administrative permissions is not")
}

pub const ELEVATED_MESSAGE: &str = "Orgtree was started as administrator, and PostgreSQL refuses to run with \
    administrator rights. Close Orgtree and start it normally (not with \"Run as administrator\").";

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
