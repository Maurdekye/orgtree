//! Shared `data-location.json` reader for the boot host (`host.rs`) and the
//! Windows sign-in credential broker (`credential_broker.rs`).
//!
//! Precedence matches `apps/desktop/main/policy.ts` (`resolveDataRoot`):
//!   1. `ORGTREE_V2_DATA` environment variable (non-empty)
//!   2. `<userData>/data-location.json` (`{ "version": 1, "dataRoot": "..." }`)
//!   3. `<userData>/data` (`%APPDATA%\Orgtree v2\data` on Windows)
//!
//! Every function here is `#[nolog]` because `credential_broker` compiles this
//! module directly with no tracing subscriber.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::core_process::{self, Identity, Life};

pub const APP_DIR_NAME: &str = "Orgtree v2";
pub const CONFIG_FILE: &str = "data-location.json";
pub const MOVE_IN_PROGRESS_FILE: &str = ".data-move-in-progress.json";
const MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedDataRoot {
    pub path: PathBuf,
    pub custom: bool,
    pub from_env: bool,
    pub move_in_progress: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub enum HostDataRoot {
    Ready(PathBuf),
    MoveInProgress,
    Err(String),
}

/// Comparable spelling of a path (`\\?\`, trailing slashes, and Windows case
/// stripped after canonicalizing when the path exists on disk).
#[nolog]
pub fn comparable_path(p: &Path) -> String {
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let text = resolved.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text).trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        plain.to_lowercase()
    } else {
        plain.to_string()
    }
}

#[nolog]
pub fn user_data_dir_from(appdata: Option<&OsStr>, userprofile: Option<&OsStr>) -> Option<PathBuf> {
    appdata
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            userprofile
                .filter(|v| !v.is_empty())
                .map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
        })
        .map(|roaming| roaming.join(APP_DIR_NAME))
}

#[nolog]
pub fn user_data_dir_env() -> Option<PathBuf> {
    user_data_dir_from(
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
    )
}

#[nolog]
fn read_bounded_json(path: &Path) -> Result<Value, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("could not stat {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing symlinked config {}", path.display()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(format!("refusing reparse-point config {}", path.display()));
        }
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("{} exceeds {} bytes", path.display(), MAX_BYTES));
    }
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let mut raw = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if raw.len() as u64 > MAX_BYTES {
        return Err(format!("{} exceeds {} bytes", path.display(), MAX_BYTES));
    }
    serde_json::from_slice(&raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

#[nolog]
fn validate_configured_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("data-location.json has an empty dataRoot".into());
    }
    let plain = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    let path = PathBuf::from(plain);
    if !path.is_absolute() {
        return Err(format!("data-location.json dataRoot must be an absolute path: {plain}"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("data-location.json dataRoot must not contain '..': {plain}"));
    }
    Ok(path)
}

#[nolog]
pub fn read_configured_root(user_data: &Path) -> Result<Option<PathBuf>, String> {
    let file = user_data.join(CONFIG_FILE);
    if !file.exists() {
        return Ok(None);
    }
    let doc = read_bounded_json(&file)?;
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(format!(
            "{} has unsupported version (expected 1)",
            file.display()
        ));
    }
    let raw = doc
        .get("dataRoot")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} is missing string field dataRoot", file.display()))?;
    Ok(Some(validate_configured_path(raw)?))
}

/// Whether an active desktop process is mid-way through copying/switching the
/// data folder. If the desktop process recorded in the marker has already died,
/// the marker is treated as stale so a hard crash never wedges recovery.
#[nolog]
pub fn is_move_in_progress(user_data: &Path) -> bool {
    let marker = user_data.join(MOVE_IN_PROGRESS_FILE);
    if !marker.exists() {
        return false;
    }
    let Ok(doc) = read_bounded_json(&marker) else {
        return false;
    };
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        return false;
    }
    let Some(pid_u64) = doc.get("pid").and_then(Value::as_u64) else {
        return false;
    };
    let Ok(pid) = u32::try_from(pid_u64) else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    if cfg!(windows) {
        if let Some(created) = doc.get("created").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return core_process::life(&Identity {
                pid,
                created: created.to_string(),
            }) != Life::Gone;
        }
        core_process::identity(pid).is_some()
            || matches!(
                core_process::diagnose(&Identity {
                    pid,
                    created: String::new(),
                })
                .0,
                Life::Unknown
            )
    } else {
        true
    }
}

#[nolog]
pub fn resolve_from(
    env_override: Option<&OsStr>,
    appdata: Option<&OsStr>,
    userprofile: Option<&OsStr>,
    windows_platform: bool,
) -> Result<ResolvedDataRoot, String> {
    if let Some(v) = env_override.filter(|v| !v.is_empty()) {
        return Ok(ResolvedDataRoot {
            path: PathBuf::from(v),
            custom: false,
            from_env: true,
            move_in_progress: false,
        });
    }
    if !windows_platform {
        return Err("ORGTREE_V2_DATA is not set (the desktop's registration names the data folder)".into());
    }
    let user_data = user_data_dir_from(appdata, userprofile)
        .ok_or_else(|| "neither ORGTREE_V2_DATA, APPDATA nor USERPROFILE is set".to_string())?;
    let default_root = user_data.join("data");
    let moving = is_move_in_progress(&user_data);
    match read_configured_root(&user_data)? {
        Some(configured) => {
            let custom = comparable_path(&configured) != comparable_path(&default_root);
            Ok(ResolvedDataRoot {
                path: configured,
                custom,
                from_env: false,
                move_in_progress: moving,
            })
        }
        None => Ok(ResolvedDataRoot {
            path: default_root,
            custom: false,
            from_env: false,
            move_in_progress: moving,
        }),
    }
}

#[nolog]
pub fn resolve_for_host_from(
    env_override: Option<&OsStr>,
    appdata: Option<&OsStr>,
    userprofile: Option<&OsStr>,
    windows_platform: bool,
) -> HostDataRoot {
    let resolved = match resolve_from(env_override, appdata, userprofile, windows_platform) {
        Ok(r) => r,
        Err(e) => return HostDataRoot::Err(e),
    };
    if !resolved.from_env && resolved.move_in_progress {
        return HostDataRoot::MoveInProgress;
    }
    if resolved.custom && !resolved.from_env && !resolved.path.is_dir() {
        return HostDataRoot::Err(format!(
            "configured custom data folder is not available ({}); refusing to create an empty data folder",
            resolved.path.display()
        ));
    }
    HostDataRoot::Ready(resolved.path)
}

#[nolog]
pub fn resolve_for_host() -> HostDataRoot {
    resolve_for_host_from(
        std::env::var_os("ORGTREE_V2_DATA").as_deref(),
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
        cfg!(windows),
    )
}

#[nolog]
pub fn resolve_for_broker_from(
    env_override: Option<&OsStr>,
    appdata: Option<&OsStr>,
    userprofile: Option<&OsStr>,
) -> Option<PathBuf> {
    let resolved = resolve_from(env_override, appdata, userprofile, true).ok()?;
    if !resolved.from_env && resolved.move_in_progress {
        return None;
    }
    if resolved.custom && !resolved.from_env && !resolved.path.is_dir() {
        return None;
    }
    Some(resolved.path)
}

#[nolog]
pub fn resolve_for_broker() -> Option<PathBuf> {
    resolve_for_broker_from(
        std::env::var_os("ORGTREE_V2_DATA").as_deref(),
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
    )
}

/// True when an idle, unattached credential broker should exit because a data
/// move began or `data-location.json` now points at a different folder.
#[nolog]
pub fn broker_should_exit_from(
    current_root: &Path,
    env_override: Option<&OsStr>,
    appdata: Option<&OsStr>,
    userprofile: Option<&OsStr>,
) -> bool {
    if env_override.filter(|v| !v.is_empty()).is_some() {
        return false;
    }
    match resolve_from(None, appdata, userprofile, true) {
        Ok(resolved) => {
            if resolved.move_in_progress {
                return true;
            }
            comparable_path(&resolved.path) != comparable_path(current_root)
        }
        Err(_) => false,
    }
}

#[nolog]
pub fn broker_should_exit(current_root: &Path) -> bool {
    broker_should_exit_from(
        current_root,
        std::env::var_os("ORGTREE_V2_DATA").as_deref(),
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("USERPROFILE").as_deref(),
    )
}
