//! Whether a Windows token holds administrator rights, as the engine, its boot
//! host and the sign-in helper measure them: for the boot host's choice of the
//! engine's token, the both-or-neither check between the engine and its
//! helper (decision 94, invariant 7) and the restart notice.
//!
//! Shared by the engine and the sign-in helper's own binary
//! (`credential_broker.rs` includes it by name), so only `#[nolog]` here.

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{
    EqualSid, GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation, TokenGroups, TokenIntegrityLevel,
    PSID, SID_AND_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_GROUPS, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const SE_GROUP_ENABLED: u32 = 0x4;
const SE_GROUP_USE_FOR_DENY_ONLY: u32 = 0x10;
/// The High integrity label's RID (Medium is 0x2000).
pub const HIGH_RID: u32 = 0x3000;

/// One token's readings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    /// Windows' own reading, `TokenElevation`: what Task Manager's "Elevated"
    /// column shows
    pub windows: bool,
    /// BUILTIN\Administrators is an enabled group (not deny-only)
    pub administrators: bool,
    /// the integrity label's RID (0x2000 Medium, `HIGH_RID` High)
    pub label: u32,
}

#[nolog]
impl Reading {
    /// Administrator rights: Administrators enabled, or a High label or above.
    pub fn elevated(&self) -> bool {
        self.administrators || self.label >= HIGH_RID
    }
}

unsafe fn info(token: HANDLE, class: i32) -> Option<Vec<u64>> {
    let mut size = 0u32;
    GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut size);
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    if GetTokenInformation(token, class, buf.as_mut_ptr().cast(), size, &mut size) == 0 {
        return None;
    }
    Some(buf)
}

/// `token`'s readings (it needs TOKEN_QUERY); a part that cannot be read
/// counts as not elevated.
#[nolog]
pub fn read(token: HANDLE) -> Reading {
    unsafe {
        let windows = info(token, TokenElevation).is_some_and(|b| (*(b.as_ptr() as *const TOKEN_ELEVATION)).TokenIsElevated != 0);
        let label = info(token, TokenIntegrityLevel)
            .map(|b| {
                let sid = (*(b.as_ptr() as *const TOKEN_MANDATORY_LABEL)).Label.Sid;
                let count = *GetSidSubAuthorityCount(sid) as u32;
                if count == 0 { 0 } else { *GetSidSubAuthority(sid, count - 1) }
            })
            .unwrap_or(0);
        let mut admins: PSID = std::ptr::null_mut();
        let text: Vec<u16> = "S-1-5-32-544".encode_utf16().chain(std::iter::once(0)).collect();
        let administrators = ConvertStringSidToSidW(text.as_ptr(), &mut admins) != 0 && {
            let enabled = info(token, TokenGroups).is_some_and(|b| {
                let list = b.as_ptr() as *const TOKEN_GROUPS;
                let first = std::ptr::addr_of!((*list).Groups) as *const SID_AND_ATTRIBUTES;
                (0..(*list).GroupCount as usize).any(|i| {
                    let g = &*first.add(i);
                    EqualSid(g.Sid, admins) != 0 && g.Attributes & SE_GROUP_ENABLED != 0 && g.Attributes & SE_GROUP_USE_FOR_DENY_ONLY == 0
                })
            });
            LocalFree(admins as _);
            enabled
        };
        Reading { windows, administrators, label }
    }
}

/// This process's readings (None: its token could not be opened).
#[nolog]
pub fn own() -> Option<Reading> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let reading = read(token);
        CloseHandle(token);
        Some(reading)
    }
}

/// Whether this process holds administrator rights (`Reading::elevated`).
#[nolog]
pub fn own_elevated() -> bool {
    own().is_some_and(|r| r.elevated())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows' own reading counts on its own: alpha.33's engine had
    /// Administrators deny-only and a Medium label, yet Windows (and Task
    /// Manager) called it elevated, and the engine and its helper must agree
    /// with what the user sees (the user 2026-10-22 11:22Z).
    #[test]
    fn any_one_reading_is_elevated() {
        let medium = 0x2000;
        assert!(Reading { windows: true, administrators: false, label: medium }.elevated(), "Windows' own reading");
        assert!(Reading { windows: false, administrators: true, label: medium }.elevated(), "Administrators enabled");
        assert!(Reading { windows: false, administrators: false, label: HIGH_RID }.elevated(), "a High label");
        assert!(!Reading { windows: false, administrators: false, label: medium }.elevated(), "none of them");
    }
}
