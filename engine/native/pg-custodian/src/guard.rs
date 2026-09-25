//! The prototype-root guard (P03 risk R11).
//!
//! The custodian may create, start, stop or identify a cluster only under a
//! root that is EXPLICITLY disposable. A root is accepted only when all of
//! these hold:
//!
//! 1. its path is absolute, local (no UNC share, no `\\.\` device) and not a
//!    drive root;
//! 2. it is neither inside nor an ancestor of any protected location — the
//!    live Orgtree data (`ORGTREE_DATA`, `ORGTREE_AGENT_PARENT_DATA`), the
//!    legacy data (`ORGTREE_AGENT_LEGACY_DATA`, `~/orgtree`), the whole
//!    `%APPDATA%\Orgtree v2` folder, and the installed app — checked on the
//!    path as typed BEFORE anything touches the disk, and again after
//!    resolving junctions and symlinks;
//! 3. it carries a prototype-root marker written by `init-root`, whose schema,
//!    `disposable` flag and recorded path all match. A marker copied into
//!    another folder names the wrong path and is refused.
//!
//! `init-root` itself only marks a folder that does not exist yet or is empty,
//! and applies rules 1-2 first.

use crate::error::{CustodianError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf, Prefix};

pub const MARKER_FILE: &str = "orgtree-p03-prototype-root.json";
pub const MARKER_SCHEMA: &str = "orgtree.p03.prototype-root/v1";

/// The marker that makes a folder a disposable prototype root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RootMarker {
    pub schema: String,
    pub root_id: String,
    /// The canonical path the marker was written for, lower-cased.
    pub root_path: String,
    pub disposable: bool,
    pub created_at_unix: u64,
    pub created_by: String,
}

/// A root that passed every check. Only the guard constructs one.
#[derive(Debug, Clone)]
pub struct PrototypeRoot {
    path: PathBuf,
    marker: RootMarker,
}

impl PrototypeRoot {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn root_id(&self) -> &str {
        &self.marker.root_id
    }
}

/// Where the protected locations come from. Tests pass their own map, so no
/// test ever depends on (or touches) the real live data folder.
pub type Env = BTreeMap<String, String>;

pub fn process_env() -> Env {
    std::env::vars().collect()
}

/// Every protected location derivable from the environment, as typed.
pub fn protected_locations(env: &Env) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut push = |label: &str, value: Option<PathBuf>| {
        if let Some(p) = value {
            if !p.as_os_str().is_empty() {
                out.push((label.to_string(), p));
            }
        }
    };
    let var = |k: &str| env.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(PathBuf::from);
    push("ORGTREE_DATA", var("ORGTREE_DATA"));
    push("ORGTREE_AGENT_PARENT_DATA", var("ORGTREE_AGENT_PARENT_DATA"));
    push("ORGTREE_AGENT_LEGACY_DATA", var("ORGTREE_AGENT_LEGACY_DATA"));
    push("%APPDATA%\\Orgtree v2", var("APPDATA").map(|a| a.join("Orgtree v2")));
    let home = var("USERPROFILE").or_else(|| var("HOME"));
    push("%USERPROFILE%\\AppData\\Roaming\\Orgtree v2", home.as_ref().map(|h| h.join("AppData").join("Roaming").join("Orgtree v2")));
    push("~/orgtree", home.as_ref().map(|h| h.join("orgtree")));
    push("%ProgramFiles%\\Orgtree", var("ProgramFiles").map(|p| p.join("Orgtree")));
    push("%LOCALAPPDATA%\\Programs\\Orgtree", var("LOCALAPPDATA").map(|p| p.join("Programs").join("Orgtree")));
    out
}

/// Lexical normal form used for every comparison: `\\?\` stripped, `/` as
/// `\`, `.` and `..` resolved without touching the disk, lower-cased,
/// no trailing separator. Refuses UNC and device paths outright.
pub fn lexical(path: &Path) -> Result<String> {
    let raw = path.to_string_lossy().replace('/', "\\");
    if raw.starts_with("\\\\.\\") || raw.to_ascii_lowercase().starts_with("\\\\?\\unc\\") {
        return Err(CustodianError::new("root.device_or_unc", format!("device or UNC path refused: {raw}")));
    }
    let stripped = raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string();
    if stripped.starts_with("\\\\") {
        return Err(CustodianError::new("root.device_or_unc", format!("UNC path refused: {raw}")));
    }
    let p = PathBuf::from(&stripped);
    let mut parts: Vec<String> = Vec::new();
    let mut prefix: Option<String> = None;
    let mut has_root = false;
    for c in p.components() {
        match c {
            Component::Prefix(pre) => match pre.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => prefix = Some(format!("{}:", (d as char).to_ascii_lowercase())),
                _ => return Err(CustodianError::new("root.device_or_unc", format!("unsupported path prefix: {raw}"))),
            },
            Component::RootDir => has_root = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => {
                // Windows ignores trailing dots and spaces in a component, so
                // `Orgtree v2.` names the same folder as `Orgtree v2`.
                let s = s.to_string_lossy().trim_end_matches(['.', ' ']).to_lowercase();
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
    }
    let Some(prefix) = prefix else {
        return Err(CustodianError::new("root.not_absolute", format!("root must be an absolute drive path: {raw}")));
    };
    if !has_root {
        return Err(CustodianError::new("root.not_absolute", format!("drive-relative path refused: {raw}")));
    }
    let mut s = prefix;
    for part in &parts {
        s.push('\\');
        s.push_str(part);
    }
    if parts.is_empty() {
        s.push('\\');
    }
    Ok(s)
}

/// True when `a` equals `b` or lies inside it (both in lexical form).
fn within(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let b_dir = if b.ends_with('\\') { b.to_string() } else { format!("{b}\\") };
    a.starts_with(&b_dir)
}

/// Resolve junctions/symlinks for the longest existing prefix of `path`,
/// then re-append the missing tail. Returns lexical form.
pub fn resolved(path: &Path) -> Result<String> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut canon) => {
                for t in tail.iter().rev() {
                    canon.push(t);
                }
                return lexical(&canon);
            }
            Err(_) => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                    return lexical(path);
                };
                tail.push(name);
                if !existing.pop() {
                    return lexical(path);
                }
            }
        }
    }
}

/// Rules 1-2: the path's shape and its distance from every protected place.
/// Called on the typed path before the disk is touched, then on the resolved
/// path.
pub fn check_location(path: &Path, env: &Env) -> Result<String> {
    let typed = lexical(path)?;
    if typed.ends_with('\\') || typed.matches('\\').count() < 2 {
        return Err(CustodianError::new(
            "root.too_shallow",
            format!("root must be at least two folders below a drive root: {typed}"),
        ));
    }
    let protected = protected_locations(env);
    refuse_protected(&typed, &protected, false)?;
    let real = resolved(path)?;
    refuse_protected(&real, &protected, true)?;
    if real.matches('\\').count() < 2 {
        return Err(CustodianError::new("root.too_shallow", format!("root resolves too close to a drive root: {real}")));
    }
    Ok(real)
}

fn refuse_protected(candidate: &str, protected: &[(String, PathBuf)], resolve_protected: bool) -> Result<()> {
    for (label, p) in protected {
        let mut forms = vec![lexical(p)?];
        if resolve_protected {
            forms.push(resolved(p)?);
        }
        for form in forms {
            if within(candidate, &form) {
                return Err(CustodianError::new(
                    "root.protected",
                    format!("root {candidate} is inside protected location {label} ({form})"),
                ));
            }
            if within(&form, candidate) {
                return Err(CustodianError::new(
                    "root.protected",
                    format!("root {candidate} contains protected location {label} ({form})"),
                ));
            }
        }
    }
    Ok(())
}

/// Mark a new, empty folder as a disposable prototype root.
pub fn init_root(path: &Path, env: &Env) -> Result<PrototypeRoot> {
    let _ = check_location(path, env)?;
    if path.exists() {
        if !path.is_dir() {
            return Err(CustodianError::new("root.not_a_directory", format!("{} is not a directory", path.display())));
        }
        let mut entries = std::fs::read_dir(path).map_err(|e| CustodianError::io("root.read", path, e))?;
        if entries.next().is_some() {
            return Err(CustodianError::new(
                "root.not_empty",
                format!("init-root only marks a folder that is new or empty: {}", path.display()),
            ));
        }
    } else {
        std::fs::create_dir_all(path).map_err(|e| CustodianError::io("root.create", path, e))?;
    }
    // Resolve again now that the folder exists (a junction created in the
    // meantime is caught here).
    let real = check_location(path, env)?;
    let marker = RootMarker {
        schema: MARKER_SCHEMA.to_string(),
        root_id: crate::win::random_hex(16)?,
        root_path: real,
        disposable: true,
        created_at_unix: crate::now_unix(),
        created_by: format!("pg-custodian {}", env!("CARGO_PKG_VERSION")),
    };
    crate::write_json_atomic(&path.join(MARKER_FILE), &marker)?;
    validate_root(path, env)
}

/// Rules 1-3. The only way to obtain a [`PrototypeRoot`].
pub fn validate_root(path: &Path, env: &Env) -> Result<PrototypeRoot> {
    let real = check_location(path, env)?;
    if !path.is_dir() {
        return Err(CustodianError::new("root.missing", format!("root does not exist: {}", path.display())));
    }
    let marker_path = path.join(MARKER_FILE);
    let text = std::fs::read_to_string(&marker_path).map_err(|_| {
        CustodianError::new(
            "root.unmarked",
            format!("{} has no prototype-root marker ({MARKER_FILE}); run `pg-custodian init-root` on a new folder", path.display()),
        )
    })?;
    let marker: RootMarker = serde_json::from_str(&text)
        .map_err(|e| CustodianError::new("root.bad_marker", format!("{}: {e}", marker_path.display())))?;
    if marker.schema != MARKER_SCHEMA {
        return Err(CustodianError::new("root.bad_marker", format!("marker schema {:?} is not {MARKER_SCHEMA}", marker.schema)));
    }
    if !marker.disposable {
        return Err(CustodianError::new("root.not_disposable", "marker does not declare the root disposable".to_string()));
    }
    if marker.root_id.len() != 32 || !marker.root_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(CustodianError::new("root.bad_marker", format!("root_id {:?} is not 32 lowercase hex digits", marker.root_id)));
    }
    if marker.root_path != real {
        return Err(CustodianError::new(
            "root.moved_or_copied",
            format!("marker was written for {} but this root is {real}; a copied or moved root must be re-marked", marker.root_path),
        ));
    }
    // Operate on the resolved path with its real case (not the lower-cased
    // comparison form), so a junction swapped in later cannot redirect us.
    let canon = std::fs::canonicalize(path).map_err(|e| CustodianError::io("root.resolve", path, e))?;
    let canon = canon.to_string_lossy().to_string();
    let canon = PathBuf::from(canon.strip_prefix("\\\\?\\").unwrap_or(&canon));
    if lexical(&canon)? != real {
        return Err(CustodianError::new("root.moved_or_copied", format!("{} resolved inconsistently", path.display())));
    }
    Ok(PrototypeRoot { path: canon, marker })
}
