//! Read-only Windows identities for core lifecycle enforcement. A failed probe
//! never means a dead process or a signed-out operator. No credential enumeration.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub pid: u32,
    // Decimal string: FILETIME is larger than JavaScript's exact integer range.
    pub created: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: u32,
    pub logon: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Life { Alive, Gone, Unknown }

/// Which call left a member Unknown (`open`, `wait` or `times`) and the
/// Windows error it returned: diagnostics only, never a verdict of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failed { pub stage: &'static str, pub os: u32 }

#[cfg(windows)]
pub use win::{diagnose, identity, life, Sessions};

#[cfg(not(windows))]
#[nolog]
pub fn identity(_: u32) -> Option<Identity> { None }
#[cfg(not(windows))]
#[nolog]
pub fn life(_: &Identity) -> Life { Life::Unknown }
#[cfg(not(windows))]
#[nolog]
pub fn diagnose(_: &Identity) -> (Life, Option<Failed>) { (Life::Unknown, None) }

#[cfg(windows)]
mod win {
    use super::*;
    use std::{collections::HashMap, ptr};
    use windows_sys::Win32::{Foundation::*, Security::*, System::{RemoteDesktop::*, Threading::*}};

    /// Handles are opened for query/wait only. Creation time is checked on that
    /// same handle, so a reused PID cannot masquerade as the registered member.
    #[nolog]
    fn inspect(pid: u32) -> Result<Option<u64>, Failed> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                let os = GetLastError();
                return if os == ERROR_INVALID_PARAMETER { Ok(None) } else { Err(Failed { stage: "open", os }) };
            }
            // each failure's error is read before CloseHandle can replace it
            let answer = match WaitForSingleObject(h, 0) {
                WAIT_OBJECT_0 => Ok(None),
                WAIT_TIMEOUT => {
                    let mut c: FILETIME = std::mem::zeroed();
                    let mut e = c; let mut k = c; let mut u = c;
                    if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
                        Ok(Some(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64))
                    } else { Err(Failed { stage: "times", os: GetLastError() }) }
                }
                _ => Err(Failed { stage: "wait", os: GetLastError() }),
            };
            CloseHandle(h);
            answer
        }
    }

    #[nolog]
    pub fn identity(pid: u32) -> Option<Identity> {
        inspect(pid).ok().flatten().map(|created| Identity { pid, created: created.to_string() })
    }

    #[nolog]
    pub fn life(who: &Identity) -> Life {
        diagnose(who).0
    }

    /// `life`, with what left an Unknown member unknown.
    #[nolog]
    pub fn diagnose(who: &Identity) -> (Life, Option<Failed>) {
        match inspect(who.pid) {
            Ok(Some(stamp)) if stamp.to_string() == who.created => (Life::Alive, None),
            Ok(_) => (Life::Gone, None),
            Err(failed) => (Life::Unknown, Some(failed)),
        }
    }

    /// Cache SID resolution per WTS logon, not per tick: avoid repeated account
    /// lookup/LSASS traffic. Locks and RDP disconnects leave the logon present.
    pub struct Sessions {
        own_sid: Vec<u8>,
        owners: HashMap<(u32, i64), bool>,
    }

    #[nolog]
    impl Sessions {
        pub fn new() -> Option<Self> {
            unsafe {
                let mut token = ptr::null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return None; }
                let mut n = 0;
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut n);
                let mut data = vec![0u8; n as usize];
                let ok = GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), n, &mut n);
                CloseHandle(token);
                if ok == 0 { return None; }
                let sid = (*(data.as_ptr() as *const TOKEN_USER)).User.Sid;
                let own_sid = std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec();
                Some(Self { own_sid, owners: HashMap::new() })
            }
        }

        /// None = inspection failed. Some(empty) = operator has actually signed
        /// out. Never use the active-console session alone: it excludes RDP and
        /// disconnected but still signed-in sessions.
        pub fn read(&mut self) -> Option<Vec<Session>> {
            unsafe {
                let mut rows = ptr::null_mut(); let mut count = 0;
                if WTSEnumerateSessionsW(ptr::null_mut(), 0, 1, &mut rows, &mut count) == 0 { return None; }
                let mut found = Vec::new(); let mut seen = Vec::new(); let mut failed = false;
                let rows_slice = if count == 0 { &[][..] } else if rows.is_null() { return None } else { std::slice::from_raw_parts(rows, count as usize) };
                for row in rows_slice {
                    if row.SessionId == 0 { continue; }
                    let mut bytes = ptr::null_mut(); let mut n = 0;
                    if WTSQuerySessionInformationW(ptr::null_mut(), row.SessionId, WTSSessionInfo, &mut bytes, &mut n) == 0 {
                        failed = true; continue;
                    }
                    if n < std::mem::size_of::<WTSINFOW>() as u32 || bytes.is_null() {
                        if !bytes.is_null() { WTSFreeMemory(bytes.cast()); }
                        failed = true; continue;
                    }
                    let info = *(bytes as *const WTSINFOW);
                    WTSFreeMemory(bytes.cast());
                    let Some(user) = session_text(row.SessionId, WTSUserName) else { failed = true; continue };
                    if user.is_empty() || info.LogonTime <= 0 { continue; }
                    let key = (row.SessionId, info.LogonTime);
                    seen.push(key);
                    let owns = match self.owners.get(&key) {
                        Some(owns) => Some(*owns),
                        None => {
                            let Some(domain) = session_text(row.SessionId, WTSDomainName) else { failed = true; continue };
                            let account = if domain.is_empty() { user } else { format!("{domain}\\{user}") };
                            let answer = account_sid(&account).map(|sid| sid == self.own_sid);
                            if let Some(answer) = answer { self.owners.insert(key, answer); }
                            answer
                        }
                    };
                    match owns {
                        Some(true) => found.push(Session { id: row.SessionId, logon: info.LogonTime.to_string() }),
                        Some(false) => {},
                        None => failed = true,
                    }
                }
                if !rows.is_null() { WTSFreeMemory(rows.cast()); }
                self.owners.retain(|key, _| seen.contains(key));
                found.sort_by_key(|s| s.id);
                if failed { None } else { Some(found) }
            }
        }
    }

    #[nolog]
    fn text(value: &[u16]) -> String {
        String::from_utf16_lossy(&value[..value.iter().position(|v| *v == 0).unwrap_or(value.len())])
    }

    // WTSINFOW's fixed username/domain arrays truncate long names. Use the
    // full strings for SID resolution, retaining its logon time as epoch.
    #[nolog]
    fn session_text(session: u32, class: WTS_INFO_CLASS) -> Option<String> {
        unsafe {
            let mut bytes = ptr::null_mut(); let mut len = 0;
            if WTSQuerySessionInformationW(ptr::null_mut(), session, class, &mut bytes, &mut len) == 0 { return None; }
            let answer = if bytes.is_null() || len > 65536 { None }
                else { Some(text(std::slice::from_raw_parts(bytes, len as usize / 2))) };
            if !bytes.is_null() { WTSFreeMemory(bytes.cast()); }
            answer
        }
    }

    #[nolog]
    fn account_sid(account: &str) -> Option<Vec<u8>> {
        let wide: Vec<u16> = account.encode_utf16().chain(Some(0)).collect();
        unsafe {
            let mut sid_len = 0; let mut domain_len = 0; let mut kind = 0;
            LookupAccountNameW(ptr::null(), wide.as_ptr(), ptr::null_mut(), &mut sid_len, ptr::null_mut(), &mut domain_len, &mut kind);
            if sid_len == 0 || sid_len > 65536 || domain_len > 65536 { return None; }
            let mut sid = vec![0u8; sid_len as usize]; let mut domain = vec![0u16; domain_len as usize];
            if LookupAccountNameW(ptr::null(), wide.as_ptr(), sid.as_mut_ptr().cast(), &mut sid_len,
                domain.as_mut_ptr(), &mut domain_len, &mut kind) == 0 { return None; }
            sid.truncate(sid_len as usize);
            Some(sid)
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn creation_stamp_distinguishes_reused_pid_and_missing_pid() {
        let mut current = identity(std::process::id()).unwrap();
        assert_eq!(life(&current), Life::Alive);
        current.created = "0".into();
        assert_eq!(life(&current), Life::Gone);
        assert_eq!(life(&Identity { pid: u32::MAX, created: "0".into() }), Life::Gone);
    }
    #[test]
    fn operator_session_probe_is_readable_and_stable() {
        let mut sessions = Sessions::new().unwrap();
        let first = sessions.read().expect("WTS operator sessions should be queryable");
        assert_eq!(sessions.read(), Some(first));
    }
}
