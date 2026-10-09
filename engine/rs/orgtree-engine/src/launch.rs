//! The launcher protocol: structured stdout lines the desktop (and the boot
//! host) parse, the data-root lock, and the persisted port.
//!
//! stdout carries ONLY these JSON lines; all logging goes to the log file.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{bail, Context, Result};
use rand::Rng;
use serde_json::json;

static SEQUENCE: AtomicI64 = AtomicI64::new(0);

#[logged]
fn emit(line: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", line);
    let _ = out.flush();
}

/// One startup checkpoint: resets the launcher's silence deadline.
#[logged]
pub fn progress(phase: &str, data_root_id: &str) {
    let seq = SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    emit(json!({
        "type": "startup-progress", "protocol": 1, "pid": std::process::id(),
        "sequence": seq, "phase": phase, "dataRootId": data_root_id,
    }));
}

#[logged]
pub fn ready(port: u16, data_root_id: &str) {
    emit(json!({
        "type": "ready", "protocol": 1, "port": port,
        "pid": std::process::id(), "dataRootId": data_root_id,
    }));
}

/// Another engine owns this data root: the desktop retries attachment.
#[logged]
pub fn refused_root_owned(reason: &str) {
    emit(json!({ "type": "refused", "code": "root-owned", "reason": reason }));
}

/// The exclusive byte-range lock on `.desktop-engine.lock`, held for the
/// whole life of this process (Windows drops it when the process dies). The
/// desktop proves release by writing byte 0 of the file.
pub struct RootLock {
    _file: File,
}

#[logged]
impl RootLock {
    pub fn acquire(root: &Path) -> Result<Option<RootLock>> {
        let path = root.join(".desktop-engine.lock");
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                bail!("engine lock cannot be a symlink");
            }
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("could not open {}", path.display()))?;
        if !lock_byte(&file)? {
            return Ok(None);
        }
        // The file always holds one byte, so the desktop's write probe has
        // something to overwrite in place.
        let mut buf = [0u8; 1];
        file.seek(SeekFrom::Start(0))?;
        if file.read(&mut buf)? == 0 {
            file.seek(SeekFrom::Start(0))?;
            file.write_all(b"0")?;
            file.flush()?;
        }
        Ok(Some(RootLock { _file: file }))
    }
}

#[cfg(windows)]
#[logged]
fn lock_byte(file: &File) -> Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_LOCK_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
    use windows_sys::Win32::System::IO::OVERLAPPED;
    unsafe {
        let mut ov: OVERLAPPED = std::mem::zeroed();
        let ok = LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut ov,
        );
        if ok != 0 {
            return Ok(true);
        }
        let err = GetLastError();
        if err == ERROR_LOCK_VIOLATION || err == 33 {
            return Ok(false);
        }
        bail!("could not lock the data root (error {err})")
    }
}

/// Unix: an exclusive advisory lock on the whole lock file (flock), released
/// when the file closes, so a crashed engine never leaves the root locked.
#[cfg(not(windows))]
#[logged]
fn lock_byte(file: &File) -> Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(e)) => bail!("could not lock the data root ({e})"),
    }
}

/// Bind the persisted port when it is free, else a fresh one in 20000–49151,
/// and persist the choice: moving the origin strands the renderer's storage.
#[logged]
pub fn bind_port(root: &Path) -> Result<TcpListener> {
    let file = root.join("engine-port.json");
    let preferred = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .filter(|p| (1024..=65535).contains(p))
        .map(|p| p as u16);
    let try_bind = |port: u16| TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)));
    let listener = match preferred.map(try_bind) {
        Some(Ok(l)) => l,
        _ => {
            let mut rng = rand::thread_rng();
            let mut found = None;
            for _ in 0..64 {
                let port = rng.gen_range(20000..=49151);
                if let Ok(l) = try_bind(port) {
                    found = Some(l);
                    break;
                }
            }
            found.context("no free port in 20000-49151")?
        }
    };
    let port = listener.local_addr()?.port();
    if preferred != Some(port) {
        let tmp = root.join("engine-port.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&json!({ "port": port }))?)?;
        std::fs::rename(&tmp, &file)?;
    }
    let _ = std::fs::write(root.join(".port"), port.to_string());
    listener.set_nonblocking(true)?;
    Ok(listener)
}
