//! The P03 prototype-root guard (plan risk R11): the ONE shared definition of
//! which locations are live, how a path is canonicalized, and what makes a
//! folder an explicitly disposable prototype root. The WS1 custodian and the
//! WS2 store service both use it, so the two can never drift apart (lead
//! ruling 2026-09-25 09:02Z).
//!
//! A root is accepted only when ALL of these hold:
//!
//! 1. Shape: absolute, local (no UNC share, no `\\.\` device), at least two
//!    folders below a drive root.
//! 2. Distance: neither inside nor an ancestor of any protected location
//!    ([`protected_locations`]), checked on the path AS TYPED before anything
//!    touches the disk, and again on its [`canonical`] form.
//! 3. No reparse point: the root itself and everything under it contain no
//!    junction or symbolic link (this machine has a history of junctions
//!    pointing into real trees).
//! 4. Marker: `orgtree-p03-prototype-root.json` exists, parses strictly,
//!    declares the root disposable, and is BOUND to the root's canonical path
//!    and a root id. A marker copied or moved elsewhere names the wrong path.
//!    A marker inside a live location is never consulted: rule 2 refuses first.
//!
//! Canonicalization ([`canonical`]) resolves the real final path with
//! `std::fs::canonicalize`, which on Windows opens a handle and calls
//! `GetFinalPathNameByHandleW`: junctions, symbolic links and 8.3 short names
//! all come back as the real long path. A missing tail is re-appended
//! lexically. The result is case-folded, `\\?\` is stripped, and trailing dots
//! and spaces in a component are dropped (Windows ignores them).
//!
//! `ORGTREE_DATA` is protected UNLESS it is itself a valid prototype root
//! (marker bound to exactly its canonical path, outside every unconditional
//! location). That is the host mode in which a backend serves the prototype.
//! Every other location is protected unconditionally.

pub mod acl;
mod product;

pub use product::{bind_product_root, validate_product_root, ProductBinding, PRODUCT_DENY, PRODUCT_FILE, PRODUCT_SCHEMA};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Component, Path, PathBuf, Prefix};

pub const MARKER_FILE: &str = "orgtree-p03-prototype-root.json";
pub const MARKER_SCHEMA: &str = "orgtree.p03.prototype-root/v1";
/// Upper bound on entries the reparse-point scan visits under one root.
pub const SCAN_LIMIT: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardError {
    pub code: &'static str,
    pub message: String,
}

impl GuardError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for GuardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for GuardError {}

pub type Result<T> = std::result::Result<T, GuardError>;

/// The marker that makes a folder a disposable prototype root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RootMarker {
    pub schema: String,
    pub root_id: String,
    /// The canonical (case-folded) path the marker was written for.
    pub root_path: String,
    pub disposable: bool,
    pub created_at_unix: u64,
    pub created_by: String,
}

/// A root that passed every check. Only [`validate_root`] constructs one.
#[derive(Debug, Clone)]
pub struct PrototypeRoot {
    path: PathBuf,
    marker: RootMarker,
    /// A PRODUCT root (the engine's own data root after `bind-product`, see
    /// [`validate_product_root`]), not a disposable prototype.
    product: bool,
}

impl PrototypeRoot {
    /// The resolved path, in its real case.
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn root_id(&self) -> &str {
        &self.marker.root_id
    }
    pub fn marker(&self) -> &RootMarker {
        &self.marker
    }
    /// True for the engine's own data root ([`validate_product_root`]):
    /// nothing may delete or overwrite it (destroy, restore refuse).
    pub fn is_product(&self) -> bool {
        self.product
    }
}

/// Where the protected locations come from. Tests pass their own map, so no
/// test depends on (or touches) the real live data folder.
pub type Env = BTreeMap<String, String>;

pub fn process_env() -> Env {
    std::env::vars().collect()
}

pub(crate) fn var(env: &Env, k: &str) -> Option<PathBuf> {
    env.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The live-location list as DATA (`live-locations.json`, compiled in), so
/// the Python door hook reads exactly the same list (agreed with WS2).
pub const LIVE_LOCATIONS_JSON: &str = include_str!("../live-locations.json");
pub const LIVE_LOCATIONS_SCHEMA: &str = "orgtree.p03.live-locations/v1";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveLocation {
    pub label: String,
    /// The first non-empty of these environment variables is the base.
    pub base_env: Vec<String>,
    pub parts: Vec<String>,
    pub unconditional: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveLocations {
    pub schema: String,
    pub about: String,
    pub locations: Vec<LiveLocation>,
}

/// Parse the compiled-in list. A malformed file is a build defect, caught by
/// this crate's tests before anything ships.
pub fn live_locations() -> &'static LiveLocations {
    static SPEC: std::sync::OnceLock<LiveLocations> = std::sync::OnceLock::new();
    SPEC.get_or_init(|| {
        let spec: LiveLocations = serde_json::from_str(LIVE_LOCATIONS_JSON).expect("live-locations.json must parse");
        assert_eq!(spec.schema, LIVE_LOCATIONS_SCHEMA, "live-locations.json schema");
        spec
    })
}

pub(crate) fn resolve_location(env: &Env, loc: &LiveLocation) -> Option<PathBuf> {
    let base = loc.base_env.iter().find_map(|k| var(env, k))?;
    Some(loc.parts.iter().fold(base, |p, part| p.join(part)))
}

/// The locations protected no matter what: live and legacy Orgtree data,
/// the whole `Orgtree v2` app-data folder, and the installed app.
pub fn unconditional_locations(env: &Env) -> Vec<(String, PathBuf)> {
    live_locations()
        .locations
        .iter()
        .filter(|l| l.unconditional)
        .filter_map(|l| resolve_location(env, l).map(|p| (l.label.clone(), p)))
        .collect()
}

/// Every protected location: the unconditional ones, plus each conditional
/// one (`ORGTREE_DATA`) unless it is itself a valid prototype root.
pub fn protected_locations(env: &Env) -> Vec<(String, PathBuf)> {
    let mut out = unconditional_locations(env);
    let conditional: Vec<(String, PathBuf)> = live_locations()
        .locations
        .iter()
        .filter(|l| !l.unconditional)
        .filter_map(|l| resolve_location(env, l).map(|p| (l.label.clone(), p)))
        .collect();
    for (label, d) in conditional {
        if !orgtree_data_is_prototype(&d, &out) {
            out.insert(0, (label, d));
        }
    }
    out
}

/// True only when `d` is outside every unconditional location (typed AND
/// canonical), is not a reparse point, and carries a valid marker bound to
/// exactly its canonical path.
pub fn orgtree_data_is_prototype(d: &Path, unconditional: &[(String, PathBuf)]) -> bool {
    let (Ok(typed), Ok(canon)) = (lexical(d), canonical(d)) else { return false };
    if refuse_protected(&typed, unconditional, false).is_err() || refuse_protected(&canon, unconditional, true).is_err() {
        return false;
    }
    if is_reparse_point(d) {
        return false;
    }
    match read_marker(d) {
        Ok(m) => check_marker(&m, &canon).is_ok(),
        Err(_) => false,
    }
}

/// Lexical normal form used for every comparison: `\\?\` stripped, `/` as
/// `\`, `.` and `..` resolved without touching the disk, case-folded,
/// trailing dots/spaces dropped per component, no trailing separator.
/// Refuses UNC and device paths outright (resolving one would connect).
pub fn lexical(path: &Path) -> Result<String> {
    let raw = path.to_string_lossy().replace('/', "\\");
    if raw.starts_with("\\\\.\\") || raw.to_ascii_lowercase().starts_with("\\\\?\\unc\\") {
        return Err(GuardError::new("root.device_or_unc", format!("device or UNC path refused: {raw}")));
    }
    // Any other UNC form (`\\server\share`) parses to a non-disk prefix and
    // is refused in the match below.
    let stripped = raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string();
    let p = PathBuf::from(&stripped);
    let mut parts: Vec<String> = Vec::new();
    let mut prefix: Option<String> = None;
    let mut has_root = false;
    for c in p.components() {
        match c {
            Component::Prefix(pre) => match pre.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => prefix = Some(format!("{}:", (d as char).to_ascii_lowercase())),
                _ => return Err(GuardError::new("root.device_or_unc", format!("unsupported path prefix: {raw}"))),
            },
            Component::RootDir => has_root = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(s) => {
                let s = s.to_string_lossy();
                // Characters Windows forbids in a name (and ':' would name an
                // alternate data stream): such a path is never a real folder
                // we should be reasoning about.
                if s.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20) {
                    return Err(GuardError::new("root.bad_name", format!("path component {s:?} has a character Windows forbids: {raw}")));
                }
                // Windows ignores trailing dots and spaces in a component, so
                // `Orgtree v2.` names the same folder as `Orgtree v2`.
                let s = s.trim_end_matches(['.', ' ']).to_lowercase();
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
    }
    let Some(prefix) = prefix else {
        return Err(GuardError::new("root.not_absolute", format!("root must be an absolute drive path: {raw}")));
    };
    if !has_root {
        return Err(GuardError::new("root.not_absolute", format!("drive-relative path refused: {raw}")));
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
pub(crate) fn within(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let b_dir = if b.ends_with('\\') { b.to_string() } else { format!("{b}\\") };
    a.starts_with(&b_dir)
}

/// The real final path (see the module doc), in lexical form. The longest
/// existing prefix is resolved; a missing tail is re-appended lexically.
/// The path is checked lexically FIRST, so a UNC path is never opened.
pub fn canonical(path: &Path) -> Result<String> {
    lexical(path)?;
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
/// Returns the canonical form.
pub fn check_location(path: &Path, env: &Env) -> Result<String> {
    let typed = lexical(path)?;
    if typed.ends_with('\\') || typed.matches('\\').count() < 2 {
        return Err(GuardError::new(
            "root.too_shallow",
            format!("root must be at least two folders below a drive root: {typed}"),
        ));
    }
    let protected = protected_locations(env);
    refuse_protected(&typed, &protected, false)?;
    let real = canonical(path)?;
    refuse_protected(&real, &protected, true)?;
    if real.matches('\\').count() < 2 {
        return Err(GuardError::new("root.too_shallow", format!("root resolves too close to a drive root: {real}")));
    }
    Ok(real)
}

pub(crate) fn refuse_protected(candidate: &str, protected: &[(String, PathBuf)], canonicalize_protected: bool) -> Result<()> {
    for (label, p) in protected {
        // A malformed protected location fails CLOSED, and says which one.
        let bad = |e: GuardError| GuardError::new("guard.bad_protected_location", format!("{label} = {}: {}", p.display(), e.message));
        let mut forms = vec![lexical(p).map_err(bad)?];
        if canonicalize_protected {
            forms.push(canonical(p).map_err(bad)?);
        }
        for form in forms {
            if within(candidate, &form) {
                return Err(GuardError::new(
                    "root.protected",
                    format!("root {candidate} is inside protected location {label} ({form})"),
                ));
            }
            if within(&form, candidate) {
                return Err(GuardError::new(
                    "root.protected",
                    format!("root {candidate} contains protected location {label} ({form})"),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn entry_is_reparse_point(e: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    e.metadata().map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(true)
}

#[cfg(not(windows))]
fn entry_is_reparse_point(e: &std::fs::DirEntry) -> bool {
    e.file_type().map(|t| t.is_symlink()).unwrap_or(true)
}

#[cfg(not(windows))]
pub(crate) fn is_reparse_point(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Rule 3: no junction or symbolic link at or under `root`. Never follows
/// one (it would be refused anyway), so the scan cannot wander into live data.
pub fn refuse_reparse_points(root: &Path) -> Result<()> {
    if is_reparse_point(root) {
        return Err(GuardError::new("root.reparse_point", format!("{} is itself a junction or symbolic link", root.display())));
    }
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => return Err(GuardError::new("root.scan", format!("{}: {e}", dir.display()))),
        };
        for e in rd {
            let e = e.map_err(|e| GuardError::new("root.scan", format!("{}: {e}", dir.display())))?;
            seen += 1;
            if seen > SCAN_LIMIT {
                return Err(GuardError::new("root.scan", format!("more than {SCAN_LIMIT} entries under {}", root.display())));
            }
            let p = e.path();
            // DirEntry metadata comes from the directory listing itself and
            // does not follow links.
            if entry_is_reparse_point(&e) {
                return Err(GuardError::new(
                    "root.reparse_point",
                    format!("{} is a junction or symbolic link; a prototype root may contain none", p.display()),
                ));
            }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(p);
            }
        }
    }
    Ok(())
}

pub fn read_marker(dir: &Path) -> Result<RootMarker> {
    let marker_path = dir.join(MARKER_FILE);
    let text = std::fs::read_to_string(&marker_path).map_err(|_| {
        GuardError::new(
            "root.unmarked",
            format!("{} has no prototype-root marker ({MARKER_FILE}); run `pg-custodian init-root` on a new folder", dir.display()),
        )
    })?;
    serde_json::from_str(&text).map_err(|e| GuardError::new("root.bad_marker", format!("{}: {e}", marker_path.display())))
}

/// Rule 4 for an already-read marker against the root's canonical path.
pub fn check_marker(marker: &RootMarker, canonical_root: &str) -> Result<()> {
    if marker.schema != MARKER_SCHEMA {
        return Err(GuardError::new("root.bad_marker", format!("marker schema {:?} is not {MARKER_SCHEMA}", marker.schema)));
    }
    if !marker.disposable {
        return Err(GuardError::new("root.not_disposable", "marker does not declare the root disposable"));
    }
    if marker.root_id.len() != 32 || !marker.root_id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(GuardError::new("root.bad_marker", format!("root_id {:?} is not 32 lowercase hex digits", marker.root_id)));
    }
    if marker.root_path != canonical_root {
        return Err(GuardError::new(
            "root.moved_or_copied",
            format!("marker was written for {} but this root is {canonical_root}; a copied or moved root must be re-marked", marker.root_path),
        ));
    }
    Ok(())
}

/// Rules 1-4. The only way to obtain a [`PrototypeRoot`].
pub fn validate_root(path: &Path, env: &Env) -> Result<PrototypeRoot> {
    let real = check_location(path, env)?;
    if !path.is_dir() {
        return Err(GuardError::new("root.missing", format!("root does not exist: {}", path.display())));
    }
    refuse_reparse_points(path)?;
    let marker = read_marker(path)?;
    check_marker(&marker, &real)?;
    // Operate on the resolved path in its real case (not the case-folded
    // comparison form).
    let canon = std::fs::canonicalize(path).map_err(|e| GuardError::new("root.resolve", format!("{}: {e}", path.display())))?;
    let canon = canon.to_string_lossy().to_string();
    let canon = PathBuf::from(canon.strip_prefix("\\\\?\\").unwrap_or(&canon));
    if lexical(&canon)? != real {
        return Err(GuardError::new("root.moved_or_copied", format!("{} resolved inconsistently", path.display())));
    }
    Ok(PrototypeRoot { path: canon, marker, product: false })
}

/// Only [`product::validate_product_root`] builds a product root.
pub(crate) fn product_root(path: PathBuf, marker: RootMarker) -> PrototypeRoot {
    PrototypeRoot { path, marker, product: true }
}

/// The resolved path in its real case, checked against the comparison form.
pub(crate) fn real_case(path: &Path, real: &str) -> Result<PathBuf> {
    let canon = std::fs::canonicalize(path).map_err(|e| GuardError::new("root.resolve", format!("{}: {e}", path.display())))?;
    let canon = canon.to_string_lossy().to_string();
    let canon = PathBuf::from(canon.strip_prefix("\\\\?\\").unwrap_or(&canon));
    if lexical(&canon)? != real {
        return Err(GuardError::new("root.moved_or_copied", format!("{} resolved inconsistently", path.display())));
    }
    Ok(canon)
}
