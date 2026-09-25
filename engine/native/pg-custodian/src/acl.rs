//! Owner-only files and folders for secrets and the attach descriptor, on the
//! same model as `engine/service_host.py`'s engine descriptor: the protected
//! DACL (operator + SYSTEM + Administrators, inheritance OFF) is attached AT
//! CREATION, so no instant exists in which inherited profile ACLs could grant
//! another account read; files are created with share mode 0 and CREATE_NEW;
//! and the result is verified by reading the security descriptor back.

use crate::error::{CustodianError, Result};
use std::path::Path;

pub const SYSTEM_SID: &str = "S-1-5-18";
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// What a verified owner-only object looks like, from its SDDL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclReport {
    pub sddl: String,
    pub owner: String,
    pub protected: bool,
    pub trustees: Vec<String>,
    pub all_full_access_allow: bool,
    pub any_inherited: bool,
}

/// Parse the parts of an SDDL string we check. Pure, so it is unit-tested.
pub fn parse_sddl(sddl: &str) -> AclReport {
    let owner = sddl
        .strip_prefix("O:")
        .map(|r| r.split(|c| c == 'G' || c == 'D').next().unwrap_or("").trim_end_matches(':').to_string())
        .unwrap_or_default();
    let dacl = sddl.split_once("D:").map(|(_, d)| d).unwrap_or("");
    let dacl = dacl.split("S:").next().unwrap_or("");
    let flags_end = dacl.find('(').unwrap_or(dacl.len());
    let protected = dacl[..flags_end].contains('P');
    let mut trustees = Vec::new();
    let mut all_fa = true;
    let mut inherited = false;
    for ace in dacl[flags_end..].split(')').filter(|a| a.starts_with('(')) {
        let f: Vec<&str> = ace.trim_start_matches('(').split(';').collect();
        if f.len() < 6 {
            all_fa = false;
            continue;
        }
        if f[0] != "A" || f[2] != "FA" {
            all_fa = false;
        }
        if f[1].contains("ID") {
            inherited = true;
        }
        let t = match f[5] {
            "SY" => SYSTEM_SID.to_string(),
            "BA" => ADMINISTRATORS_SID.to_string(),
            other => other.to_string(),
        };
        trustees.push(t);
    }
    trustees.sort();
    trustees.dedup();
    AclReport { sddl: sddl.to_string(), owner, protected, trustees, all_full_access_allow: all_fa, any_inherited: inherited }
}

/// The owner-only rule: owner is the operator, DACL protected, nothing
/// inherited, exactly {operator, SYSTEM, Administrators}, all full-access allow.
pub fn is_owner_only(r: &AclReport, operator_sid: &str) -> bool {
    let mut want = vec![operator_sid.to_string(), SYSTEM_SID.to_string(), ADMINISTRATORS_SID.to_string()];
    want.sort();
    r.owner == operator_sid && r.protected && !r.any_inherited && r.all_full_access_allow && r.trustees == want
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, FlushFileBuffers, WriteFile, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wstr(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last(code: &'static str, what: &str) -> CustodianError {
        CustodianError::new(code, format!("{what}: {}", std::io::Error::last_os_error()))
    }

    unsafe fn pwstr_to_string(p: *const u16) -> String {
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
    }

    pub fn current_user_sid() -> Result<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(last("acl.token", "OpenProcessToken"));
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(last("acl.token", "GetTokenInformation"));
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut s: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut s) == 0 {
                return Err(last("acl.token", "ConvertSidToStringSidW"));
            }
            let out = pwstr_to_string(s);
            LocalFree(s.cast());
            Ok(out)
        }
    }

    /// A security descriptor for "owner-only", as the SECURITY_ATTRIBUTES a
    /// create call takes. `inherit` adds OI/CI so children of a folder get it.
    struct Sd(PSECURITY_DESCRIPTOR);
    impl Drop for Sd {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    fn owner_only_sd(sid: &str, inherit: bool) -> Result<Sd> {
        let f = if inherit { "OICI" } else { "" };
        let sddl = format!("O:{sid}D:P(A;{f};FA;;;SY)(A;{f};FA;;;BA)(A;{f};FA;;;{sid})");
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let w = wstr(&sddl);
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(w.as_ptr(), 1, &mut sd, std::ptr::null_mut()) } == 0 {
            return Err(last("acl.sddl", &sddl));
        }
        Ok(Sd(sd))
    }

    fn attrs(sd: &Sd) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: 0 }
    }

    /// Create a NEW folder whose DACL is owner-only from birth (and passes to
    /// everything created inside it).
    pub fn create_owner_only_dir(path: &Path) -> Result<()> {
        let sid = current_user_sid()?;
        let sd = owner_only_sd(&sid, true)?;
        let sa = attrs(&sd);
        let w = wide(path);
        if unsafe { CreateDirectoryW(w.as_ptr(), &sa) } == 0 {
            return Err(last("acl.mkdir", &path.display().to_string()));
        }
        Ok(())
    }

    /// Create a NEW file (CREATE_NEW, share mode 0) with an owner-only DACL
    /// from birth, and write `bytes` through the only handle there is.
    pub fn write_owner_only_file(path: &Path, bytes: &[u8]) -> Result<()> {
        let sid = current_user_sid()?;
        let sd = owner_only_sd(&sid, false)?;
        let sa = attrs(&sd);
        let w = wide(path);
        unsafe {
            let h = CreateFileW(w.as_ptr(), 0x4000_0000 /* GENERIC_WRITE */, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut());
            if h == INVALID_HANDLE_VALUE || h.is_null() {
                return Err(last("acl.create", &path.display().to_string()));
            }
            let mut written = 0u32;
            let ok = WriteFile(h, bytes.as_ptr(), bytes.len() as u32, &mut written, std::ptr::null_mut()) != 0
                && written as usize == bytes.len()
                && FlushFileBuffers(h) != 0;
            CloseHandle(h);
            if !ok {
                let _ = std::fs::remove_file(path);
                return Err(last("acl.write", &path.display().to_string()));
            }
        }
        Ok(())
    }

    pub fn read_acl(path: &Path) -> Result<AclReport> {
        let w = wide(path);
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let rc = unsafe {
            GetNamedSecurityInfoW(
                w.as_ptr(),
                SE_FILE_OBJECT,
                info,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        if rc != 0 {
            return Err(CustodianError::new("acl.read", format!("{}: GetNamedSecurityInfoW error {rc}", path.display())));
        }
        let mut s: *mut u16 = std::ptr::null_mut();
        let ok = unsafe { ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, info, &mut s, std::ptr::null_mut()) };
        let out = if ok != 0 { Some(unsafe { pwstr_to_string(s) }) } else { None };
        unsafe {
            if !s.is_null() {
                LocalFree(s.cast());
            }
            LocalFree(sd);
        }
        let sddl = out.ok_or_else(|| last("acl.read", "ConvertSecurityDescriptorToStringSecurityDescriptorW"))?;
        Ok(parse_sddl(&sddl))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    fn no<T>() -> Result<T> {
        Err(CustodianError::new("acl.unsupported", "owner-only ACLs are Windows-only in P03"))
    }
    pub fn current_user_sid() -> Result<String> {
        no()
    }
    pub fn create_owner_only_dir(_p: &Path) -> Result<()> {
        no()
    }
    pub fn write_owner_only_file(_p: &Path, _b: &[u8]) -> Result<()> {
        no()
    }
    pub fn read_acl(_p: &Path) -> Result<AclReport> {
        no()
    }
}

pub use imp::{create_owner_only_dir, current_user_sid, read_acl, write_owner_only_file};

/// Fail closed unless `path` is verifiably owner-only.
pub fn require_owner_only(path: &Path) -> Result<AclReport> {
    let sid = current_user_sid()?;
    let r = read_acl(path)?;
    if !is_owner_only(&r, &sid) {
        return Err(CustodianError::new("acl.not_owner_only", format!("{} has DACL {}", path.display(), r.sddl)));
    }
    Ok(r)
}

/// Replace `target` atomically with a new owner-only file holding `bytes`.
pub fn replace_owner_only(target: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = target.with_extension(format!("tmp-{}", crate::win::random_hex(4)?));
    write_owner_only_file(&tmp, bytes)?;
    require_owner_only(&tmp)?;
    std::fs::rename(&tmp, target).map_err(|e| CustodianError::io("acl.rename", target, e))?;
    require_owner_only(target)?;
    Ok(())
}
