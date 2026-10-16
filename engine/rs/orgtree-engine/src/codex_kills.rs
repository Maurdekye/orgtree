//! The durable record of how every Codex process Orgtree ends actually ended
//! (docket urgent-orgtree-s-hard-killing-of-codex-processes): forcing
//! codex.exe down while it has an RPC call in flight to lsass crashes lsass
//! with RPCRT4 10.0.26100.9444, and Windows reboots within about 40 s. Each
//! line goes to `diagnostics\logs\codex-kills.log` and is flushed to disk
//! before the kill it announces, so it survives that crash (the engine log
//! sits in the OS cache, which a crash discards); it is mirrored in the
//! engine log. Grep markers: `codex-force-kill`, `codex-graceful-exit`, and
//! `codex-session-ended` for a CLI of any harness that the sign-in helper
//! started and Windows ended with the user's session.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
const NAME: &str = "codex-kills.log";
const CAP: u64 = 4 << 20;

/// Open the record next to the engine logs (at log start).
#[logged]
pub fn init(dir: &Path) {
    let path: PathBuf = dir.join(NAME);
    if std::fs::metadata(&path).map(|m| m.len() > CAP).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join(format!("{NAME}.old")));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
    let _ = FILE.set(Mutex::new(file));
}

/// A Codex process ended by itself after its input closed.
#[logged]
pub fn graceful(pid: u32, who: &str, reason: &str, waited_ms: u64) {
    write(&format!("codex-graceful-exit pid={pid} who={who:?} reason={reason:?} waited_ms={waited_ms}"));
    tracing::info!(pid, who, reason, waited_ms, "codex-graceful-exit");
}

/// About to force a Codex process (and, with `tree`, everything it started)
/// down: written and flushed BEFORE the kill.
#[logged]
pub fn force(pid: u32, tree: bool, who: &str, reason: &str, graceful_tried: bool, waited_ms: u64) {
    write(&format!(
        "codex-force-kill pid={pid} tree={tree} who={who:?} reason={reason:?} graceful_tried={graceful_tried} waited_ms={waited_ms}"
    ));
    tracing::warn!(pid, tree, who, reason, graceful_tried, waited_ms, "codex-force-kill");
}

/// A CLI the sign-in helper started in the user's session ended with that
/// session (sign-out, or the helper stopped) during a turn: Windows ended it,
/// not this engine, and `status` is how it exited.
#[logged]
pub fn session_ended(pid: u32, who: &str, status: &str) {
    write(&format!("codex-session-ended pid={pid} who={who:?} reason=\"the user's Windows session ended\" status={status:?}"));
    tracing::info!(pid, who, status, "codex-session-ended");
}

#[nolog]
fn write(line: &str) {
    let Some(lock) = FILE.get() else { return };
    let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(f) = guard.as_mut() {
        let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        let _ = writeln!(f, "{at} engine_pid={} {line}", std::process::id());
        let _ = f.sync_data();
    }
}
