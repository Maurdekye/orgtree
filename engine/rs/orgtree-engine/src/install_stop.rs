//! The installer's stop request (docket installer-s-end-task-fallback-no-longer-stops-th,
//! coordinator 2026-10-15 11:54Z).
//!
//! The installer stops the background engine by asking it through its attach descriptor
//! (`POST /api/desktop/shutdown`, tools/boot-engine-task.ps1). An installer that cannot read the
//! descriptor (another administrator: it is the operator's alone) used to end the engine's task
//! instead. That ends only the host, and since the core-lifecycle recovery (2026-10-12) an engine
//! outlives its host ("boot host exited" keeps it running), so the installer's boot step timed
//! out. Such an installer now first records `StopRequested` (REG_QWORD, Unix milliseconds) in its
//! own protected record, HKLM\SOFTWARE\Orgtree\BootEngine, which only administrators can write.
//! An engine a task's host started (core mode "boot", either start mode) reads it every 2 s and
//! stops the graceful way, as on the desktop's request, once a request is newer than its own
//! start. A stale value never stops anything, and nothing here deletes it: the installer
//! overwrites it next time. A host exit without a request still leaves the engine running, and so
//! does a manual End on the task.
//!
//! A rig run, and only a rig run (`crate::rig::active`), reads the value from
//! HKCU\<ORGTREE_RIG_STOP_KEY> instead, so a proof can stand in for the installer without
//! administrator rights. Every other engine ignores that variable.

use std::sync::Arc;
use std::time::Duration;

use crate::engine::Engine;

const VALUE: &str = "StopRequested";
const RECORD: &str = r"SOFTWARE\Orgtree\BootEngine";
const POLL: Duration = Duration::from_secs(2);

/// Where the request is read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Location {
    /// The installer's record under HKLM, writable by administrators only.
    Record,
    /// A rig run's own key under HKCU.
    Rig(String),
}

/// The installer's record, unless this is a rig run that named a key of its own.
#[nolog]
pub fn location(rig: bool, rig_key: Option<String>) -> Location {
    match rig_key.filter(|key| rig && !key.trim().is_empty()) {
        Some(key) => Location::Rig(key),
        None => Location::Record,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// From before this engine started (a previous install): never stops anything.
    Stale,
    /// Newer than this engine's start: stop. `future` when it is dated after now (a clock
    /// that moved); it still stops, and the log says so.
    Stop { future: bool },
}

/// What a request means to this engine. Only a NEW value is decided (and so logged), never each
/// tick of the poll.
#[logged]
pub fn decide(requested_ms: i64, started_ms: i64, now_ms: i64) -> Decision {
    if requested_ms <= started_ms {
        return Decision::Stale;
    }
    Decision::Stop { future: requested_ms > now_ms }
}

/// Watch for the installer's request while this engine runs; only an engine a task's host
/// started (core mode "boot") is ever stopped this way.
#[nolog]
pub fn start(engine: &Arc<Engine>) {
    if std::env::var("ORGTREE_CORE_MODE").as_deref() != Ok("boot") {
        return;
    }
    let location = location(crate::rig::active(), std::env::var("ORGTREE_RIG_STOP_KEY").ok());
    let engine = engine.clone();
    tokio::spawn(async move { watch(engine, location).await });
}

#[nolog]
async fn watch(engine: Arc<Engine>, location: Location) {
    let started_ms = engine.boot.started_at.timestamp_millis();
    let shutdown = engine.shutdown.clone();
    let mut seen: Option<Option<u64>> = None;
    loop {
        let value = read(&location);
        if seen != Some(value) {
            seen = Some(value);
            if let Some(raw) = value {
                let requested_ms = i64::try_from(raw).unwrap_or(i64::MAX);
                let now_ms = chrono::Utc::now().timestamp_millis();
                match decide(requested_ms, started_ms, now_ms) {
                    Decision::Stale => tracing::info!(requested_ms, started_ms, ?location,
                        "a stop request from before this engine started is ignored"),
                    Decision::Stop { future } => {
                        tracing::warn!(requested_ms, started_ms, now_ms, future, ?location,
                            reason = "the installer could not ask the engine through its attach descriptor",
                            "stop requested by the installer's record; stopping the engine");
                        engine.request_shutdown();
                        return;
                    }
                }
            }
        }
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(POLL) => {}
        }
    }
}

/// The request's time, or None when there is none (or it cannot be read).
#[cfg(windows)]
#[nolog]
fn read(location: &Location) -> Option<u64> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_QWORD, RRF_SUBKEY_WOW6464KEY,
    };
    let wide = |s: &str| -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect() };
    let (hive, key) = match location {
        Location::Record => (HKEY_LOCAL_MACHINE, wide(RECORD)),
        Location::Rig(key) => (HKEY_CURRENT_USER, wide(key)),
    };
    let name = wide(VALUE);
    let mut value = 0u64;
    let mut size = std::mem::size_of::<u64>() as u32;
    let status = unsafe {
        RegGetValueW(hive, key.as_ptr(), name.as_ptr(), RRF_RT_REG_QWORD | RRF_SUBKEY_WOW6464KEY, std::ptr::null_mut(),
            &mut value as *mut u64 as *mut c_void, &mut size)
    };
    (status == 0).then_some(value)
}

#[cfg(not(windows))]
#[nolog]
fn read(_location: &Location) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Condition 1 (coordinator 11:54Z): only a rig run reads anywhere but the installer's
    /// administrator-only record; an ordinary engine ignores the rig's variable entirely.
    #[test]
    fn only_a_rig_run_reads_its_own_key() {
        let key = Some(r"Software\OrgtreeRigStop-1".to_string());
        assert_eq!(location(false, key.clone()), Location::Record, "a non-rig engine must ignore the HKCU key");
        assert_eq!(location(true, key), Location::Rig(r"Software\OrgtreeRigStop-1".into()));
        assert_eq!(location(true, None), Location::Record);
        assert_eq!(location(true, Some("  ".into())), Location::Record);
        assert_eq!(location(false, None), Location::Record);
    }

    /// Condition 2: a stale value never stops anything; a newer one does, also when it is
    /// dated in the future.
    #[test]
    fn only_a_request_newer_than_the_engine_stops_it() {
        let started = 1_000_000;
        assert_eq!(decide(started - 1, started, started + 10), Decision::Stale, "a previous install's request");
        assert_eq!(decide(started, started, started + 10), Decision::Stale, "the same millisecond is not newer");
        assert_eq!(decide(0, started, started + 10), Decision::Stale);
        assert_eq!(decide(started + 5, started, started + 10), Decision::Stop { future: false });
        assert_eq!(decide(started + 60_000, started, started + 10), Decision::Stop { future: true }, "a clock that moved still stops it, and says so");
        assert_eq!(decide(i64::MAX, started, started + 10), Decision::Stop { future: true });
    }
}
