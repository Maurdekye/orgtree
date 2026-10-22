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

/// The failed sign-in readings of one stretch, so `Sessions::read` logs the
/// failing Windows call once per stretch rather than at every check.
#[cfg(windows)]
#[derive(Debug, Default)]
pub(crate) struct FailureLog {
    failing: bool,
}

// hot: called with every sign-in reading, as `Sessions` is
#[cfg(windows)]
#[nolog]
impl FailureLog {
    /// Whether this reading is news for the log: the first failure of a
    /// stretch, or the first good reading after one.
    pub(crate) fn note(&mut self, failed: bool) -> bool {
        let news = failed != self.failing;
        self.failing = failed;
        news
    }
}

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

    /// Whether Windows lists a session in `state` as being torn down: a
    /// sign-out in progress (WTSDown) or a reset (WTSReset). Nobody is signed
    /// in there any more, and its queries may fail until it is gone.
    #[nolog]
    pub(super) fn torn_down(state: WTS_CONNECTSTATE_CLASS) -> bool {
        state == WTSDown || state == WTSReset
    }

    /// The Windows call a sign-in reading failed on, for its log line: which
    /// call, the session it asked about (0: the enumeration), that session's
    /// state and the error the call left.
    #[derive(Clone, Copy, Debug)]
    struct Failure {
        call: &'static str,
        session: u32,
        state: WTS_CONNECTSTATE_CLASS,
        os: u32,
    }

    /// Cache SID resolution per WTS logon, not per tick: avoid repeated account
    /// lookup/LSASS traffic. Locks and RDP disconnects leave the logon present.
    pub struct Sessions {
        own_sid: Vec<u8>,
        owners: HashMap<(u32, i64), bool>,
        failures: super::FailureLog,
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
                Some(Self { own_sid, owners: HashMap::new(), failures: super::FailureLog::default() })
            }
        }

        /// None = inspection failed. Some(empty) = operator has actually signed
        /// out. Never use the active-console session alone: it excludes RDP and
        /// disconnected but still signed-in sessions. A session being torn down
        /// (`torn_down`) is nobody's, and its queries may fail until it is gone:
        /// on alpha.34 every reading failed for the 77 s a sign-out took
        /// (2026-10-22), most likely so. Any other failed call still fails the
        /// reading, and the first one of a stretch of failed readings is
        /// logged, as is the reading that ends it.
        pub fn read(&mut self) -> Option<Vec<Session>> {
            let (found, failure) = self.scan();
            if self.failures.note(failure.is_some()) {
                match failure {
                    Some(f) => tracing::warn!(call = f.call, session = f.session, state = f.state, os = f.os,
                        "Windows could not say whether the user is signed in; the sign-in state stays unknown until it can"),
                    None => tracing::info!("Windows can say again whether the user is signed in"),
                }
            }
            if failure.is_some() { None } else { Some(found) }
        }

        /// The operator's sessions, and the first call that failed (a failed
        /// call skips its session; the others are still read).
        fn scan(&mut self) -> (Vec<Session>, Option<Failure>) {
            // the error is read at once, before another call can replace it
            let fail = |first: &mut Option<Failure>, call: &'static str, session: u32, state: WTS_CONNECTSTATE_CLASS| {
                let os = unsafe { GetLastError() };
                if first.is_none() {
                    *first = Some(Failure { call, session, state, os });
                }
            };
            let mut first = None;
            unsafe {
                let mut rows = ptr::null_mut(); let mut count = 0;
                if WTSEnumerateSessionsW(ptr::null_mut(), 0, 1, &mut rows, &mut count) == 0 {
                    fail(&mut first, "enumerate", 0, 0);
                    return (Vec::new(), first);
                }
                let mut found = Vec::new(); let mut seen = Vec::new();
                let rows_slice = if count == 0 { &[][..] } else if rows.is_null() {
                    fail(&mut first, "enumerate", 0, 0);
                    return (Vec::new(), first);
                } else { std::slice::from_raw_parts(rows, count as usize) };
                for row in rows_slice {
                    if row.SessionId == 0 || torn_down(row.State) { continue; }
                    let (id, state) = (row.SessionId, row.State);
                    let mut bytes = ptr::null_mut(); let mut n = 0;
                    if WTSQuerySessionInformationW(ptr::null_mut(), id, WTSSessionInfo, &mut bytes, &mut n) == 0 {
                        fail(&mut first, "session info", id, state); continue;
                    }
                    if n < std::mem::size_of::<WTSINFOW>() as u32 || bytes.is_null() {
                        fail(&mut first, "session info size", id, state);
                        if !bytes.is_null() { WTSFreeMemory(bytes.cast()); }
                        continue;
                    }
                    let info = *(bytes as *const WTSINFOW);
                    WTSFreeMemory(bytes.cast());
                    let Some(user) = session_text(id, WTSUserName) else { fail(&mut first, "user name", id, state); continue };
                    if user.is_empty() || info.LogonTime <= 0 { continue; }
                    let key = (id, info.LogonTime);
                    seen.push(key);
                    let owns = match self.owners.get(&key) {
                        Some(owns) => Some(*owns),
                        None => {
                            let Some(domain) = session_text(id, WTSDomainName) else { fail(&mut first, "domain name", id, state); continue };
                            let account = if domain.is_empty() { user } else { format!("{domain}\\{user}") };
                            let answer = account_sid(&account).map(|sid| sid == self.own_sid);
                            if let Some(answer) = answer { self.owners.insert(key, answer); }
                            answer
                        }
                    };
                    match owns {
                        Some(true) => found.push(Session { id, logon: info.LogonTime.to_string() }),
                        Some(false) => {},
                        None => fail(&mut first, "account", id, state),
                    }
                }
                if !rows.is_null() { WTSFreeMemory(rows.cast()); }
                self.owners.retain(|key, _| seen.contains(key));
                found.sort_by_key(|s| s.id);
                (found, first)
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
    fn only_a_session_being_torn_down_is_passed_over() {
        use windows_sys::Win32::System::RemoteDesktop::*;
        assert!(win::torn_down(WTSDown), "a sign-out in progress");
        assert!(win::torn_down(WTSReset), "a reset");
        for state in [WTSActive, WTSConnected, WTSConnectQuery, WTSShadow, WTSDisconnected, WTSIdle, WTSListen, WTSInit] {
            assert!(!win::torn_down(state), "WTS state {state} is no teardown");
        }
    }
    #[test]
    fn a_failed_sign_in_reading_is_logged_once_per_stretch() {
        let mut log = FailureLog::default();
        assert!(!log.note(false), "a good reading is no news");
        assert!(log.note(true), "the first failure of a stretch is");
        assert!(!log.note(true), "the next failures of that stretch are not");
        assert!(log.note(false), "the first good reading after it is");
        assert!(!log.note(false), "and the next ones are not");
        assert!(log.note(true), "a new stretch is news again");
    }
    #[test]
    fn operator_session_probe_is_readable_and_stable() {
        let mut sessions = Sessions::new().unwrap();
        let first = sessions.read().expect("WTS operator sessions should be queryable");
        assert_eq!(sessions.read(), Some(first));
    }
}
