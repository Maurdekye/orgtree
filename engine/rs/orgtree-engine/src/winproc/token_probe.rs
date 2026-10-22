//! Test-only: what a process's token holds (groups, privileges, integrity,
//! user, session, default DACL) and whether the process is in a job, read
//! from outside it, as a reviewer would with Process Explorer.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows_sys::Win32::Security::{
    CheckTokenMembership, CreateRestrictedToken, DuplicateTokenEx, GetAce, GetSidSubAuthority, GetSidSubAuthorityCount,
    GetTokenInformation, LookupPrivilegeNameW, SecurityIdentification, SetTokenInformation, TokenDefaultDacl, TokenElevation,
    TokenGroups, TokenImpersonation, TokenIntegrityLevel, TokenLinkedToken, TokenPrivileges, TokenSessionId, TokenUser,
    ACCESS_ALLOWED_ACE, ACE_HEADER, DISABLE_MAX_PRIVILEGE, PSID, SID_AND_ATTRIBUTES, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE,
    TOKEN_GROUPS, TOKEN_LINKED_TOKEN, TOKEN_MANDATORY_LABEL, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

/// TOKEN_GROUPS attribute bits (winnt.h).
pub const SE_GROUP_ENABLED: u32 = 0x4;
pub const SE_GROUP_USE_FOR_DENY_ONLY: u32 = 0x10;
/// Integrity RIDs (winnt.h).
pub const MEDIUM_RID: u32 = 0x2000;

pub struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

impl Handle {
    /// A handle the test now owns (closed on drop).
    pub fn owned(handle: std::os::windows::io::OwnedHandle) -> Handle {
        use std::os::windows::io::IntoRawHandle;
        Handle(handle.into_raw_handle() as HANDLE)
    }
    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

/// Process `pid`, opened for queries.
pub fn process(pid: u32) -> Handle {
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    assert!(!h.is_null(), "could not open process {pid}: {}", std::io::Error::last_os_error());
    Handle(h)
}

/// The process's primary token, for queries and an identification copy.
pub fn token(process: &Handle) -> Handle {
    let mut t: HANDLE = std::ptr::null_mut();
    let ok = unsafe { OpenProcessToken(process.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut t) };
    assert!(ok != 0, "could not open the process token: {}", std::io::Error::last_os_error());
    Handle(t)
}

fn info(token: &Handle, class: i32) -> Vec<u64> {
    let mut size = 0u32;
    unsafe { GetTokenInformation(token.0, class, std::ptr::null_mut(), 0, &mut size) };
    let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
    let ok = unsafe { GetTokenInformation(token.0, class, buf.as_mut_ptr() as *mut c_void, size, &mut size) };
    assert!(ok != 0, "could not read token class {class}: {}", std::io::Error::last_os_error());
    buf
}

fn sid_text(sid: PSID) -> String {
    let mut text: *mut u16 = std::ptr::null_mut();
    assert!(unsafe { ConvertSidToStringSidW(sid, &mut text) } != 0, "an unreadable SID");
    let mut n = 0;
    while unsafe { *text.add(n) } != 0 {
        n += 1;
    }
    let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, n) });
    unsafe { LocalFree(text as *mut c_void) };
    s
}

/// Every group's SID and attribute bits.
pub fn groups(token: &Handle) -> Vec<(String, u32)> {
    let buf = info(token, TokenGroups);
    let list = buf.as_ptr() as *const TOKEN_GROUPS;
    let count = unsafe { (*list).GroupCount } as usize;
    let first = unsafe { std::ptr::addr_of!((*list).Groups) } as *const windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
    (0..count).map(|i| unsafe { (sid_text((*first.add(i)).Sid), (*first.add(i)).Attributes) }).collect()
}

/// The names of the privileges it holds, enabled or not.
pub fn privileges(token: &Handle) -> Vec<String> {
    let buf = info(token, TokenPrivileges);
    let list = buf.as_ptr() as *const TOKEN_PRIVILEGES;
    let count = unsafe { (*list).PrivilegeCount } as usize;
    let first = unsafe { std::ptr::addr_of!((*list).Privileges) } as *const windows_sys::Win32::Security::LUID_AND_ATTRIBUTES;
    (0..count)
        .map(|i| {
            let luid = unsafe { (*first.add(i)).Luid };
            let mut name = [0u16; 128];
            let mut len = name.len() as u32;
            let ok = unsafe { LookupPrivilegeNameW(std::ptr::null(), &luid, name.as_mut_ptr(), &mut len) };
            assert!(ok != 0, "an unnamed privilege");
            String::from_utf16_lossy(&name[..len as usize])
        })
        .collect()
}

/// Its integrity level's RID (`MEDIUM_RID`, 0x3000 High).
pub fn integrity(token: &Handle) -> u32 {
    let buf = info(token, TokenIntegrityLevel);
    let sid = unsafe { (*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL)).Label.Sid };
    unsafe {
        let count = *GetSidSubAuthorityCount(sid) as u32;
        *GetSidSubAuthority(sid, count - 1)
    }
}

pub fn user(token: &Handle) -> String {
    let buf = info(token, TokenUser);
    sid_text(unsafe { (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid })
}

pub fn session(token: &Handle) -> u32 {
    info(token, TokenSessionId)[0] as u32
}

/// The SIDs its default DACL allows: what objects it creates grant.
pub fn default_dacl(token: &Handle) -> Vec<String> {
    let buf = info(token, TokenDefaultDacl);
    let acl = unsafe { (*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl };
    if acl.is_null() {
        return Vec::new();
    }
    let mut sids = Vec::new();
    for i in 0..unsafe { (*acl).AceCount } as u32 {
        let mut ace: *mut c_void = std::ptr::null_mut();
        assert!(unsafe { GetAce(acl, i, &mut ace) } != 0, "an unreadable ACE");
        // ACCESS_ALLOWED_ACE_TYPE
        if unsafe { (*(ace as *const ACE_HEADER)).AceType } == 0 {
            sids.push(sid_text(unsafe { std::ptr::addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart) } as PSID));
        }
    }
    sids
}

/// Whether `sid` is an ENABLED group of the token: PostgreSQL's own test
/// (`pgwin32_is_admin`: CheckTokenMembership for Administrators and Power
/// Users) before it refuses to run.
pub fn member(token: &Handle, sid: &str) -> bool {
    let mut copy: HANDLE = std::ptr::null_mut();
    let ok = unsafe { DuplicateTokenEx(token.0, TOKEN_QUERY, std::ptr::null(), SecurityIdentification, TokenImpersonation, &mut copy) };
    assert!(ok != 0, "could not copy the token: {}", std::io::Error::last_os_error());
    let copy = Handle(copy);
    let wide: Vec<u16> = sid.encode_utf16().chain(std::iter::once(0)).collect();
    let mut psid: PSID = std::ptr::null_mut();
    assert!(unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut psid) } != 0, "a malformed SID");
    let mut is = 0i32;
    let ok = unsafe { CheckTokenMembership(copy.0, psid, &mut is) };
    unsafe { LocalFree(psid) };
    assert!(ok != 0, "CheckTokenMembership failed: {}", std::io::Error::last_os_error());
    is != 0
}

/// Windows' own reading: `TokenElevation`, what Task Manager's "Elevated"
/// column shows.
pub fn windows_elevated(token: &Handle) -> bool {
    info(token, TokenElevation)[0] as u32 != 0
}

/// An elevated token this test may query but never start anything with: its
/// own when it runs elevated (an administrator's CI runner), else the linked
/// full token of its UAC-filtered session (an administrator at a normal
/// prompt); None for a standard user.
pub fn elevated_source() -> Option<Handle> {
    let own = token(&process(std::process::id()));
    if windows_elevated(&own) {
        return Some(own);
    }
    let mut linked = TOKEN_LINKED_TOKEN { LinkedToken: std::ptr::null_mut() };
    let mut size = 0u32;
    let ok = unsafe {
        GetTokenInformation(own.0, TokenLinkedToken, &mut linked as *mut _ as *mut c_void, std::mem::size_of::<TOKEN_LINKED_TOKEN>() as u32, &mut size)
    };
    if ok == 0 || linked.LinkedToken.is_null() {
        return None;
    }
    let linked = Handle(linked.LinkedToken);
    windows_elevated(&linked).then_some(linked)
}

/// alpha.33's engine token made from `source`: Administrators and Power Users
/// deny-only, every privilege but SeChangeNotify removed, a Medium label, and
/// no other filtering.
pub fn alpha33_copy(source: &Handle) -> Handle {
    let sid = |text: &str| {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let mut psid: PSID = std::ptr::null_mut();
        assert!(unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut psid) } != 0, "a malformed SID");
        psid
    };
    let deny = [SID_AND_ATTRIBUTES { Sid: sid("S-1-5-32-544"), Attributes: 0 }, SID_AND_ATTRIBUTES { Sid: sid("S-1-5-32-547"), Attributes: 0 }];
    let mut copy: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        CreateRestrictedToken(source.0, DISABLE_MAX_PRIVILEGE, 2, deny.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null(), &mut copy)
    };
    for d in deny {
        unsafe { LocalFree(d.Sid) };
    }
    assert!(ok != 0, "could not restrict the token: {}", std::io::Error::last_os_error());
    let copy = Handle(copy);
    let medium = sid("S-1-16-8192");
    // SE_GROUP_INTEGRITY
    let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: medium, Attributes: 0x20 } };
    let ok = unsafe {
        SetTokenInformation(copy.0, TokenIntegrityLevel, &label as *const _ as *const c_void, std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32)
    };
    unsafe { LocalFree(medium) };
    assert!(ok != 0, "could not set a Medium label: {}", std::io::Error::last_os_error());
    copy
}

pub fn in_job(process: &Handle) -> bool {
    let mut is = 0i32;
    assert!(unsafe { IsProcessInJob(process.0, std::ptr::null_mut(), &mut is) } != 0, "IsProcessInJob failed");
    is != 0
}
