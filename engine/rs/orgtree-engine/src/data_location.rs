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
const MAX_MOVE_MARKER_AGE_MS: u64 = 6 * 60 * 60 * 1000;

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
    if cfg!(windows) || trimmed.starts_with(r"\\") {
        #[cfg(windows)]
        {
            use std::path::Prefix;
            match Path::new(trimmed).components().next() {
                Some(Component::Prefix(prefix)) => match prefix.kind() {
                    Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {}
                    Prefix::UNC(_, _)
                    | Prefix::VerbatimUNC(_, _)
                    | Prefix::DeviceNS(_)
                    | Prefix::Verbatim(_) => {
                        return Err(format!(
                            "data-location.json dataRoot must be a local drive-letter path, not a network or device path: {trimmed}"
                        ));
                    }
                },
                _ => {
                    return Err(format!(
                        "data-location.json dataRoot must be an absolute local drive-letter path: {trimmed}"
                    ));
                }
            }
        }
        #[cfg(not(windows))]
        {
            return Err(format!(
                "data-location.json dataRoot must be a local path, not a UNC or device path: {trimmed}"
            ));
        }
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
    if std::fs::symlink_metadata(&file).is_err() {
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

#[nolog]
fn is_drive_root(folder: &Path) -> bool {
    let text = folder.as_os_str().to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let mut chars = plain.chars();
    matches!(
        (chars.next(), chars.next(), chars.next(), chars.next()),
        (Some(letter), Some(':'), Some('\\' | '/'), None) if letter.is_ascii_alphabetic()
    )
}

#[nolog]
fn check_no_reparse_existing_ancestors(dir: &Path) -> Result<(), String> {
    let mut cur = Some(dir);
    while let Some(a) = cur {
        if let Ok(meta) = std::fs::symlink_metadata(a) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "refusing custom data folder because {} is a symbolic link",
                    a.display()
                ));
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if !is_drive_root(a) && (meta.file_attributes() & 0x400 != 0) {
                    return Err(format!(
                        "refusing custom data folder because {} is a junction or reparse point",
                        a.display()
                    ));
                }
            }
        }
        cur = a.parent();
    }
    Ok(())
}

#[nolog]
fn check_no_reparse_ancestors(dir: &Path) -> Result<(), String> {
    let mut cur = Some(dir);
    while let Some(a) = cur {
        let meta = std::fs::symlink_metadata(a)
            .map_err(|e| format!("could not stat {}: {e}", a.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "refusing custom data folder because {} is a symbolic link",
                a.display()
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if !is_drive_root(a) && (meta.file_attributes() & 0x400 != 0) {
                return Err(format!(
                    "refusing custom data folder because {} is a junction or reparse point",
                    a.display()
                ));
            }
        }
        cur = a.parent();
    }
    Ok(())
}

#[cfg(windows)]
mod win_trust {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetAce, GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SID_AND_ATTRIBUTES, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Matches `verifyDescriptorTrust` (`apps/desktop/main/policy.ts`),
    /// `credential_broker.rs`, and `Get-DescriptorDistrust` (`tools/installer-upgrade.ps1`).
    const WRITE_MASK: u32 = 0x116 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x1000_0000 | 0x4000_0000;
    const REPLACE_MASK: u32 = 0x10000 | 0x40 | 0x40000 | 0x80000 | 0x1000_0000;
    const ROOT_MASK: u32 = 0x40 | 0x40000 | 0x80000 | 0x1000_0000;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

    struct LocalMem(*mut c_void);
    impl Drop for LocalMem {
        #[nolog]
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0) };
            }
        }
    }

    struct Sid(PSID);
    impl Drop for Sid {
        #[nolog]
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    struct SidBuf(Vec<u8>);
    impl SidBuf {
        #[nolog]
        fn as_ptr(&self) -> *mut c_void {
            unsafe { (*(self.0.as_ptr() as *const SID_AND_ATTRIBUTES)).Sid }
        }
    }

    #[nolog]
    fn ancestor_mask(folder: &Path) -> u32 {
        if super::is_drive_root(folder) {
            ROOT_MASK
        } else {
            REPLACE_MASK
        }
    }

    #[nolog]
    pub fn verify_dir(dir: &Path) -> Result<(), &'static str> {
        unsafe {
            let me = current_sid().ok_or("this account's SID could not be read")?;
            let system = sid("S-1-5-18").ok_or("SID")?;
            let admins = sid("S-1-5-32-544").ok_or("SID")?;
            let creator = sid("S-1-3-0").ok_or("SID")?;
            let me_ptr = me.as_ptr() as PSID;
            let allowed = [me_ptr, system.0, admins.0, creator.0];

            let (owner, dacl, _sd) =
                security(dir).ok_or("the custom data folder's permissions could not be read")?;
            if owner.is_null()
                || !(EqualSid(owner, me_ptr) != 0
                    || EqualSid(owner, system.0) != 0
                    || EqualSid(owner, admins.0) != 0)
            {
                return Err("the custom data folder is not owned by this account");
            }
            if foreign_writer(dacl, &allowed, WRITE_MASK) {
                return Err("others can write the custom data folder");
            }

            let mut up = dir.parent();
            while let Some(a) = up {
                let (_, dacl, _sd) =
                    security(a).ok_or("a parent folder's permissions could not be read")?;
                if foreign_writer(dacl, &allowed, ancestor_mask(a)) {
                    return Err("others can replace a folder above the custom data folder");
                }
                up = a.parent();
            }
            Ok(())
        }
    }

    #[nolog]
    unsafe fn security(p: &Path) -> Option<(PSID, *mut ACL, LocalMem)> {
        let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let rc = GetNamedSecurityInfoW(
            w.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        );
        (rc == 0).then(|| (owner, dacl, LocalMem(sd)))
    }

    #[nolog]
    unsafe fn foreign_writer(dacl: *mut ACL, allowed: &[PSID], mask: u32) -> bool {
        if dacl.is_null() {
            return true;
        }
        for i in 0..(*dacl).AceCount as u32 {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if GetAce(dacl, i, &mut ace) == 0 {
                return true;
            }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE || header.AceFlags & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            let allow = &*(ace as *const ACCESS_ALLOWED_ACE);
            let who = &allow.SidStart as *const u32 as PSID;
            if allowed.iter().any(|a| EqualSid(who, *a) != 0) {
                continue;
            }
            if allow.Mask & mask != 0 {
                return true;
            }
        }
        false
    }

    #[nolog]
    unsafe fn sid(text: &str) -> Option<Sid> {
        let w: Vec<u16> = std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut p: PSID = std::ptr::null_mut();
        (ConvertStringSidToSidW(w.as_ptr(), &mut p) != 0).then_some(Sid(p))
    }

    #[nolog]
    unsafe fn current_sid() -> Option<SidBuf> {
        let mut t: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t) == 0 {
            return None;
        }
        let mut size = 0u32;
        GetTokenInformation(t, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut buf = vec![0u8; size.max(1) as usize];
        let ok = size != 0
            && GetTokenInformation(
                t,
                TokenUser,
                buf.as_mut_ptr() as *mut c_void,
                size,
                &mut size,
            ) != 0;
        CloseHandle(t);
        ok.then_some(SidBuf(buf))
    }
}

#[cfg(windows)]
#[nolog]
fn verify_single_dir_acl(dir: &Path) -> Result<(), String> {
    win_trust::verify_dir(dir).map_err(str::to_string)
}

#[cfg(unix)]
#[nolog]
fn verify_single_dir_acl(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::getuid() };
    let euid = unsafe { libc::geteuid() };
    if uid != euid {
        return Err("refusing custom data folder while running setuid".into());
    }
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|e| format!("could not stat {}: {e}", dir.display()))?;
    if meta.uid() != uid && meta.uid() != 0 {
        return Err(format!(
            "custom data folder {} is not owned by this account",
            dir.display()
        ));
    }
    if (meta.mode() & 0o022) != 0 {
        return Err(format!(
            "custom data folder {} is writable by group or others",
            dir.display()
        ));
    }
    let mut cur = dir.parent();
    while let Some(a) = cur {
        let am = std::fs::symlink_metadata(a)
            .map_err(|e| format!("could not stat {}: {e}", a.display()))?;
        if am.uid() != uid && am.uid() != 0 {
            return Err(format!(
                "parent folder {} is not owned by this account or root",
                a.display()
            ));
        }
        let mode = am.mode();
        if (mode & 0o022) != 0 && (mode & 0o1000) == 0 {
            return Err(format!(
                "parent folder {} allows others to replace entries",
                a.display()
            ));
        }
        cur = a.parent();
    }
    Ok(())
}

#[cfg(not(any(windows, unix)))]
#[nolog]
fn verify_single_dir_acl(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// Verifies that `dir` and every ancestor above it are free of symbolic links
/// and NTFS junctions/reparse points, and satisfy the owner + exclusive-write
/// DACL boundary on both the configured path and its canonicalized target.
#[nolog]
pub fn verify_directory_trust(dir: &Path) -> Result<(), String> {
    check_no_reparse_ancestors(dir)?;
    verify_single_dir_acl(dir)?;
    let real = std::fs::canonicalize(dir)
        .map_err(|e| format!("could not canonicalize {}: {e}", dir.display()))?;
    check_no_reparse_ancestors(&real)?;
    verify_single_dir_acl(&real)?;
    Ok(())
}

/// Whether an active desktop process is mid-way through copying/switching the
/// data folder. If the desktop process recorded in the marker has already died
/// or the marker is older than `MAX_MOVE_MARKER_AGE_MS`, it is treated as stale
/// so a hard crash never wedges recovery.
#[nolog]
pub fn is_move_in_progress(user_data: &Path) -> bool {
    let marker = user_data.join(MOVE_IN_PROGRESS_FILE);
    if std::fs::symlink_metadata(&marker).is_err() {
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

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    if let (Some(now), Some(started_ms)) = (now_ms, doc.get("startedAtMs").and_then(Value::as_u64))
    {
        if now.saturating_sub(started_ms) > MAX_MOVE_MARKER_AGE_MS {
            return false;
        }
    } else if let Ok(meta) = std::fs::symlink_metadata(&marker) {
        if let Ok(modified) = meta.modified() {
            if let Ok(elapsed) = modified.elapsed() {
                if elapsed > std::time::Duration::from_millis(MAX_MOVE_MARKER_AGE_MS) {
                    return false;
                }
            }
        }
    }

    #[cfg(windows)]
    {
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
    }
    #[cfg(unix)]
    {
        let Ok(raw_pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        if raw_pid <= 0 {
            return false;
        }
        let rc = unsafe { libc::kill(raw_pid, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
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
    if resolved.custom && !resolved.from_env {
        if let Err(e) = check_no_reparse_existing_ancestors(&resolved.path) {
            return HostDataRoot::Err(e);
        }
        if std::fs::symlink_metadata(&resolved.path).is_err() || !resolved.path.is_dir() {
            return HostDataRoot::Err(format!(
                "configured custom data folder is not available ({}); refusing to create an empty data folder",
                resolved.path.display()
            ));
        }
        if let Err(e) = verify_directory_trust(&resolved.path) {
            return HostDataRoot::Err(e);
        }
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
    if resolved.custom && !resolved.from_env {
        if check_no_reparse_existing_ancestors(&resolved.path).is_err() {
            return None;
        }
        if std::fs::symlink_metadata(&resolved.path).is_err() || !resolved.path.is_dir() {
            return None;
        }
        if verify_directory_trust(&resolved.path).is_err() {
            return None;
        }
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
