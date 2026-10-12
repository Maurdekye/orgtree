//! Small local lifecycle journal shared by the engine, boot host and helper.
//! Contains process identities and transition intent only, never credentials.
//! The engine owns the snapshot. Any survivor may atomically latch a stop for
//! that exact generation. An old observer cannot stop or revive a new one.
use crate::core_process::{self, Identity, Life, Session};
use serde::{Deserialize, Serialize};
use std::{io::{Read, Write}, path::{Path, PathBuf}};

const FILE: &str = "core-lifecycle.json";
const MAX: u64 = 16 * 1024;

/// WTS in production. The debug rig can model normal sign-out without logging
/// the real operator out; its marker is accepted only in a non-live rig root.
#[cfg(windows)]
#[nolog]
pub fn sessions(root: &Path, source: &mut Option<core_process::Sessions>) -> Option<Vec<Session>> {
    #[cfg(debug_assertions)]
    if std::env::var("ORGTREE_ENGINE_RIG").as_deref() == Ok("1")
        && std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() == Ok("1")
        && root.join(".orgtree-rig-root").is_file()
    {
        let resolved = root.canonicalize().ok()?;
        let live = dirs::data_dir()?.join("Orgtree v2").canonicalize().ok()?;
        if !resolved.to_string_lossy().to_lowercase().starts_with(&live.to_string_lossy().to_lowercase())
            && root.join("core-rig-signed-out").is_file() { return Some(vec![]); }
    }
    #[cfg(not(debug_assertions))] let _ = root;
    source.as_mut().and_then(|s| s.read())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub generation: String,
    pub engine: Identity,
    pub host: Option<Identity>,
    pub desktop: Option<Identity>,
    pub helper: Option<Identity>,
    pub sessions: Vec<Session>,
    pub transition_until: i64,
    pub transition_desktop: Option<Identity>,
    #[serde(default)]
    pub installing: bool,
    #[serde(default)]
    pub completion_requested: bool,
}

#[nolog]
pub fn now() -> i64 { chrono::Utc::now().timestamp_millis() }

#[nolog]
pub fn read(root: &Path) -> Option<Snapshot> {
    let mut bytes = Vec::new();
    std::fs::File::open(root.join(FILE)).ok()?.take(MAX + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX { return None; }
    let value: Snapshot = serde_json::from_slice(&bytes).ok()?;
    (valid_generation(&value.generation) && value.sessions.len() <= 32).then_some(value)
}

#[nolog]
fn valid_generation(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[nolog]
fn stop_path(root: &Path, generation: &str) -> Option<PathBuf> {
    valid_generation(generation).then(|| root.join(format!("core-stop-{generation}.json")))
}

#[nolog]
pub fn stopped(root: &Path, state: &Snapshot) -> bool {
    stop_path(root, &state.generation).is_some_and(|p| p.is_file()) || manual_quit_matches(root, &state.sessions)
}

#[nolog]
fn manual_quit_matches(root: &Path, active: &[Session]) -> bool {
    let mut bytes = Vec::new();
    let Ok(f) = std::fs::File::open(root.join("core-manual-quit.json")) else { return false; };
    if f.take(MAX + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX { return true; }
    let Ok(sessions) = serde_json::from_slice::<Vec<Session>>(&bytes) else { return true; };
    sessions.iter().any(|s| active.contains(s))
}

/// Root-wide for this operator logon: closes the old/new-generation race when
/// manual Quit overlaps a replacement engine publishing its own snapshot.
#[nolog]
pub fn manual_quit(root: &Path, state: &Snapshot) -> std::io::Result<()> {
    manual_quit_sessions(root, &state.sessions)?;
    stop(root, state, "manual quit")
}

#[nolog]
pub fn manual_quit_sessions(root: &Path, sessions: &[Session]) -> std::io::Result<()> {
    if sessions.is_empty() { return Err(std::io::ErrorKind::InvalidInput.into()); }
    let tmp = root.join(format!(".core-quit-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(&serde_json::to_vec(sessions)?)?; f.sync_all()?; drop(f);
    replace(&tmp, &root.join("core-manual-quit.json"))
}

#[nolog]
pub fn stop(root: &Path, state: &Snapshot, reason: &str) -> std::io::Result<()> {
    // A stale observer is harmless even if a new snapshot is committed between
    // this check and create_new: the filename binds its action to the old epoch.
    if read(root).is_none_or(|s| s.generation != state.generation) { return Ok(()); }
    let path = stop_path(root, &state.generation).ok_or(std::io::ErrorKind::InvalidInput)?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            f.write_all(serde_json::json!({"generation":state.generation,"reason":reason,"at_ms":now()}).to_string().as_bytes())?;
            f.sync_all()
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[nolog]
pub fn write(root: &Path, state: &Snapshot) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(state)?;
    if bytes.len() as u64 > MAX { return Err(std::io::ErrorKind::InvalidData.into()); }
    let tmp = root.join(format!(".core-lifecycle-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    let result = replace(&tmp, &root.join(FILE));
    if result.is_err() { let _ = std::fs::remove_file(tmp); }
    result
}

#[cfg(windows)]
#[nolog]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}
#[cfg(not(windows))]
#[nolog]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }

#[nolog]
pub fn recovery_deferred(state: &Snapshot) -> bool {
    // Intent has an absolute, nonextendable deadline. An expired operation
    // can be reported unavailable but cannot suppress recovery forever.
    state.transition_until > now()
}

#[nolog]
pub fn transition(state: &Snapshot) -> bool {
    let remaining = state.transition_until.saturating_sub(now());
    remaining > 0 && remaining <= 180_000
        && (state.installing || state.transition_desktop.as_ref().is_some_and(|d| core_process::life(d) == Life::Alive))
}

/// Called by survivors and automatic launch paths. A task retry must not bring
/// the stopped epoch back while the same operator logon is still present.
#[nolog]
pub fn blocked(root: &Path, sessions: &[Session]) -> bool {
    if manual_quit_matches(root, sessions) { return true; }
    let Some(state) = read(root) else { return false };
    stopped(root, &state) && state.sessions.iter().any(|s| sessions.contains(s))
}

/// Only an explicit application stop is terminal. Unexpected engine loss
/// leaves the desktop and helper alive for independent recovery (user 2026-10-12).
#[nolog]
pub fn observe_engine(root: &Path, state: &Snapshot, sessions: &[Session]) -> bool {
    if !state.sessions.iter().any(|s| sessions.contains(s)) { return false; }
    if stopped(root, state) { return true; }
    false
}

/// Only a new desktop launch calls this (never its retry/recovery loop). It
/// cannot clear a stop while any member of the previous cohort still runs.
#[nolog]
pub fn begin(root: &Path) -> Result<(), &'static str> {
    let Some(state) = read(root) else {
        // A Quit before the first engine journal still has a barrier. An
        // explicit desktop launch can clear it; automatic launches never do.
        return match std::fs::remove_file(root.join("core-manual-quit.json")) {
            Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not release the previous manual Quit."),
        };
    };
    if !stopped(root, &state) { return Ok(()); }
    if [&Some(state.engine.clone()), &state.host, &state.desktop, &state.helper]
        .iter().filter_map(|m| m.as_ref()).any(|m| core_process::life(m) != Life::Gone) {
        return Err("The previous Orgtree session is still stopping. Wait for it to finish, then reopen Orgtree.");
    }
    // Removing the old snapshot releases automatic-start suppression. Its
    // immutable stop record remains as small durable shutdown evidence.
    std::fs::remove_file(root.join(FILE)).map_err(|_| "Could not release the previous Orgtree session.")?;
    match std::fs::remove_file(root.join("core-manual-quit.json")) {
        Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not release the previous manual Quit."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_observer_cannot_stop_new_generation() {
        let dir = std::env::temp_dir().join(format!("orgtree-core-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = Snapshot { generation: "a".repeat(32), engine: Identity { pid: 99, created: "1".into() },
            host: None, desktop: None, helper: None, sessions: vec![Session { id: 1, logon: "2".into() }],
            transition_until: 0, transition_desktop: None, installing: false, completion_requested: false };
        write(&dir, &a).unwrap();
        stop(&dir, &a, "first").unwrap();
        assert!(blocked(&dir, &a.sessions));
        assert!(!blocked(&dir, &[Session { id: 1, logon: "3".into() }]));
        let old = a.clone(); a.generation = "b".repeat(32);
        write(&dir, &a).unwrap(); stop(&dir, &old, "late").unwrap();
        assert!(!stopped(&dir, &a));
        assert!(!blocked(&dir, &a.sessions));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manual_quit_before_snapshot_blocks_start_and_survives_generation_race() {
        let dir = std::env::temp_dir().join(format!("orgtree-core-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sessions = vec![Session { id: 1, logon: "test-logon".into() }];
        manual_quit_sessions(&dir, &sessions).unwrap();
        assert!(blocked(&dir, &sessions));
        assert!(!blocked(&dir, &[Session { id: 1, logon: "later-logon".into() }]));
        let state = Snapshot { generation: "b".repeat(32), engine: Identity { pid: u32::MAX, created: "0".into() },
            desktop: None, host: None, helper: None, sessions: sessions.clone(), transition_until: 0,
            transition_desktop: None, installing: false, completion_requested: false };
        write(&dir, &state).unwrap();
        assert!(stopped(&dir, &state));
        begin(&dir).unwrap();
        assert!(!blocked(&dir, &sessions));
        std::fs::remove_dir_all(dir).unwrap();
    }

}
