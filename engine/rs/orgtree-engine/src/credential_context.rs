//! Warn-only Windows boot context diagnostics. No secrets, writes, shell
//! probes, admission gates or automatic restarts. Session changes cannot
//! upgrade the token of an already running S4U process.

use std::sync::Arc;
use arc_swap::ArcSwap;
use serde::Serialize;

const BOOT_WARNING: &str = "Agents started before Windows sign-in can't use your saved git/GitHub credentials. Sign in and open Orgtree to restore git/GitHub access. Agents keep running; no engine restart is needed.";
const VAULT_WARNING: &str = "Orgtree can't access Windows Credential Manager in this engine session. Agents may not be able to use your saved git/GitHub credentials. Sign in and open Orgtree to restore git/GitHub access. Agents keep running; no engine restart is needed.";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Status {
    pub process_session: Option<u32>,
    pub console_session: Option<u32>,
    pub process_user_signed_in: Option<bool>,
    pub console_user_signed_in: Option<bool>,
    pub logon_type: Option<u32>,
    pub vault: &'static str,
    pub vault_error: Option<u32>,
    pub warning: Option<&'static str>,
}

pub struct CredentialContext {
    pub state: ArcSwap<Status>,
    probing: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl CredentialContext {
    /// No probe: a test never looks at the machine's sessions or credential vault.
    pub fn for_tests() -> Self {
        let status = Status { process_session: None, console_session: None, process_user_signed_in: None,
            console_user_signed_in: None, logon_type: None, vault: "not_applicable", vault_error: None, warning: None };
        Self { state: ArcSwap::from_pointee(status), probing: std::sync::atomic::AtomicBool::new(false) }
    }
}

#[logged]
impl CredentialContext {
    pub fn new() -> Self {
        let status = probe();
        report(&status);
        Self { state: ArcSwap::from_pointee(status), probing: std::sync::atomic::AtomicBool::new(false) }
    }

    /// Session-change refresh only (start probes in `new`). CLI launches read
    /// the cached state: per-spawn LSA/CredMan probing put dozens of concurrent
    /// calls on LSASS at every restart (LSASS crash 2026-10-07 19:26Z).
    /// `bridge_lookup.status` is untested|succeeded|failed: only a real git/gh
    /// lookup through the desktop counts, never a ping. Diagnostic only (user
    /// ruling 2026-10-07 16:12Z: no credential UI).
    pub fn view(&self, bridge: &crate::credential_bridge::Bridge) -> serde_json::Value {
        let ready = bridge.ready();
        let mut value = serde_json::to_value(&**self.state.load()).unwrap_or_default();
        value["bridge_ready"] = serde_json::json!(ready);
        value["general_vault_isolated"] = serde_json::json!(value["warning"].is_string());
        if ready { value["warning"] = serde_json::Value::Null; }
        value["bridge_lookup"] = bridge.lookup_view();
        value
    }

    pub fn refresh(&self, engine: &crate::engine::Engine) {
        use std::sync::atomic::Ordering;
        // One probe in flight; a concurrent caller keeps the cached state.
        if self.probing.swap(true, Ordering::AcqRel) { return; }
        let next = probe();
        self.probing.store(false, Ordering::Release);
        if **self.state.load() != next {
            report(&next);
            let isolated=next.warning.is_some();
            let changed=self.state.load().warning.is_some()!=isolated;
            self.state.store(Arc::new(next));
            if changed {
            crate::runtime::watchdogs::events::condition(engine,if isolated{"credentials.isolated"}else{"credentials.ready"},if isolated{"credentials.ready"}else{"credentials.isolated"},serde_json::json!({"reason":if isolated{"boot credential warning"}else{"boot credential warning cleared"}}));
            }
        }
    }
}

#[logged]
fn report(status: &Status) {
    if let Some(warning) = status.warning {
        tracing::warn!(process_session = ?status.process_session, console_session = ?status.console_session,
            process_user_signed_in = ?status.process_user_signed_in, console_user_signed_in = ?status.console_user_signed_in,
            logon_type = ?status.logon_type, vault = status.vault, vault_error = ?status.vault_error,
            "{warning}");
    } else {
        tracing::info!(process_session = ?status.process_session, logon_type = ?status.logon_type,
            vault = status.vault, "Windows credential context has no detected warning (not a credential-validity check)");
    }
}

#[logged]
pub fn start(engine: &Arc<crate::engine::Engine>) {
    crate::credential_bridge::cleanup_adapters(engine);
    let engine = engine.clone();
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(30));
        timer.tick().await;
        loop {
            tokio::select! {
                _ = engine.shutdown.cancelled() => break,
                _ = timer.tick() => {
                    crate::credential_bridge::publish_availability(&engine);
                    // WTS facts are cheap; no vault enumeration on unchanged ticks.
                    let old = engine.credentials.state.load_full();
                    let (process, console, own_user, console_user) = sessions();
                    if (process, console, own_user, console_user) !=
                        (old.process_session, old.console_session, old.process_user_signed_in, old.console_user_signed_in) {
                        engine.credentials.refresh(&engine);
                    }
                }
            }
        }
    });
}

#[logged]
fn warning(process: Option<u32>, own_user: Option<bool>, logon: Option<u32>, vault: &str) -> Option<&'static str> {
    // Batch/service/network tokens stay isolated after somebody signs in.
    if process == Some(0) || own_user == Some(false) || matches!(logon, Some(3 | 4 | 5 | 8)) {
        Some(BOOT_WARNING)
    } else if process.is_none() || own_user.is_none() || vault != "available" {
        Some(VAULT_WARNING)
    } else { None }
}

#[cfg(windows)]
#[logged]
fn probe() -> Status {
    let (process_session, console_session, process_user_signed_in, console_user_signed_in) = sessions();
    let logon_type = logon_type();
    let (vault, vault_error) = vault();
    Status { process_session, console_session, process_user_signed_in, console_user_signed_in, logon_type,
        vault, vault_error, warning: warning(process_session, process_user_signed_in, logon_type, vault) }
}

#[cfg(not(windows))]
#[logged]
fn probe() -> Status {
    Status { process_session: None, console_session: None, process_user_signed_in: None,
        console_user_signed_in: None, logon_type: None, vault: "not_applicable", vault_error: None, warning: None }
}

#[cfg(windows)]
#[logged]
fn sessions() -> (Option<u32>, Option<u32>, Option<bool>, Option<bool>) {
    use windows_sys::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
    let mut id = 0;
    let process = (unsafe { ProcessIdToSessionId(std::process::id(), &mut id) } != 0).then_some(id);
    let console = unsafe { WTSGetActiveConsoleSessionId() };
    let console = (console != u32::MAX).then_some(console);
    (process, console, process.and_then(signed_in), console.and_then(signed_in))
}

#[cfg(not(windows))]
#[logged]
fn sessions() -> (Option<u32>, Option<u32>, Option<bool>, Option<bool>) { (None, None, None, None) }

#[cfg(windows)]
#[nolog] // WTS allocates an identity string; only its presence leaves this function.
fn signed_in(session: u32) -> Option<bool> {
    use windows_sys::Win32::System::RemoteDesktop::*;
    let mut value = std::ptr::null_mut();
    let mut bytes = 0;
    unsafe {
        if WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, WTSUserName, &mut value, &mut bytes) == 0 {
            return None;
        }
        let present = !value.is_null() && bytes >= 2 && *value != 0;
        if !value.is_null() { WTSFreeMemory(value.cast()); }
        Some(present)
    }
}

#[cfg(windows)]
#[nolog] // Never trace a token or the LSA structure with user/domain metadata.
fn logon_type() -> Option<u32> {
    use windows_sys::Win32::{Foundation::CloseHandle, Security::*, Security::Authentication::Identity::*, System::Threading::*};
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return None; }
        let mut stats: TOKEN_STATISTICS = std::mem::zeroed();
        let mut len = 0;
        let ok = GetTokenInformation(token, TokenStatistics, (&mut stats as *mut TOKEN_STATISTICS).cast(),
            std::mem::size_of::<TOKEN_STATISTICS>() as u32, &mut len);
        CloseHandle(token);
        if ok == 0 { return None; }
        let mut data = std::ptr::null_mut();
        if LsaGetLogonSessionData(&stats.AuthenticationId, &mut data) != 0 || data.is_null() { return None; }
        let kind = (*data).LogonType;
        LsaFreeReturnBuffer(data.cast());
        Some(kind)
    }
}

#[cfg(windows)]
#[nolog] // Never inspect/log credential names, usernames or secret bytes.
fn vault() -> (&'static str, Option<u32>) {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    // Query an intentionally nonexistent namespace, not the user's credentials.
    // NOT_FOUND means the vault was reachable, NOT that existing secrets decrypt.
    let filter: Vec<u16> = "Orgtree-readiness-no-credential-9b0e60b7-*\0".encode_utf16().collect();
    let mut count = 0;
    let mut values = std::ptr::null_mut();
    unsafe {
        if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut values) != 0 {
            if !values.is_null() { CredFree(values.cast()); }
            ("available", None)
        } else {
            let error = GetLastError();
            if error == ERROR_NOT_FOUND { ("available", None) }
            else { ("unavailable", Some(error)) }
        }
    }
}
