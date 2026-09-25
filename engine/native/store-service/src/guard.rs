//! The store service's root guard (plan R11; CONTRACT-M1 §9).
//!
//! The service runs ONLY on a disposable prototype root: the folder must
//! carry WS1's marker (`orgtree-p03-prototype-root.json`, schema
//! `orgtree.p03.prototype-root/v1`, `disposable: true`, a 32-hex `root_id`,
//! and a `root_path` equal to the folder's resolved, lower-cased path), and it
//! must be neither inside nor above any live Orgtree location. Unlike WS1's
//! custodian guard, `ORGTREE_DATA` is NOT on the protected list here: when a
//! backend serves the prototype, `ORGTREE_DATA` IS the prototype root.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const MARKER_FILE: &str = "orgtree-p03-prototype-root.json";
pub const MARKER_SCHEMA: &str = "orgtree.p03.prototype-root/v1";

pub type Env = BTreeMap<String, String>;

#[derive(Debug, Deserialize)]
struct Marker {
    schema: String,
    root_id: String,
    root_path: String,
    disposable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub path: PathBuf,
    pub root_id: String,
}

/// Every live location derivable from the environment.
pub fn live_locations(env: &Env) -> Vec<(String, PathBuf)> {
    let var = |k: &str| env.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut out = Vec::new();
    if let Some(a) = var("APPDATA") {
        out.push(("%APPDATA%\\Orgtree v2".to_string(), a.join("Orgtree v2")));
    }
    let home = var("USERPROFILE").or_else(|| var("HOME"));
    if let Some(h) = &home {
        out.push(("%USERPROFILE%\\AppData\\Roaming\\Orgtree v2".into(), h.join("AppData").join("Roaming").join("Orgtree v2")));
        out.push(("~/orgtree".into(), h.join("orgtree")));
    }
    if let Some(p) = var("ProgramFiles") {
        out.push(("%ProgramFiles%\\Orgtree".into(), p.join("Orgtree")));
    }
    if let Some(p) = var("LOCALAPPDATA") {
        out.push(("%LOCALAPPDATA%\\Programs\\Orgtree".into(), p.join("Programs").join("Orgtree")));
    }
    out
}

/// Lower-cased, `\`-separated, `\\?\` stripped, trailing dots/spaces of each
/// component dropped (Windows ignores them), `.`/`..` resolved lexically.
pub fn norm(p: &Path) -> String {
    let raw = p.to_string_lossy().replace('/', "\\");
    let raw = raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string();
    let mut parts: Vec<String> = Vec::new();
    for (i, c) in raw.split('\\').enumerate() {
        let c = c.trim_end_matches(['.', ' ']).to_lowercase();
        match c.as_str() {
            "" if i > 0 => {}
            "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            _ => parts.push(c),
        }
    }
    parts.join("\\")
}

fn within(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}\\"))
}

fn resolve(p: &Path) -> String {
    match std::fs::canonicalize(p) {
        Ok(c) => norm(&c),
        Err(_) => norm(p),
    }
}

/// Refuse a path that is inside, equal to, or above a live location — typed
/// and resolved.
pub fn refuse_live(path: &Path, env: &Env) -> Result<(), String> {
    let forms = [norm(path), resolve(path)];
    for (label, live) in live_locations(env) {
        for live_form in [norm(&live), resolve(&live)] {
            for f in &forms {
                if within(f, &live_form) || within(&live_form, f) {
                    return Err(format!("refused: {f} overlaps live location {label}"));
                }
            }
        }
    }
    Ok(())
}

/// The only way to obtain a [`Root`].
pub fn validate(path: &Path, env: &Env) -> Result<Root, String> {
    refuse_live(path, env)?;
    let real = resolve(path);
    let text = std::fs::read_to_string(path.join(MARKER_FILE)).map_err(|_| format!("{} has no prototype-root marker", path.display()))?;
    let m: Marker = serde_json::from_str(&text).map_err(|e| format!("bad prototype-root marker: {e}"))?;
    if m.schema != MARKER_SCHEMA {
        return Err(format!("marker schema {:?} is not {MARKER_SCHEMA}", m.schema));
    }
    if !m.disposable {
        return Err("marker does not declare the root disposable".into());
    }
    if m.root_id.len() != 32 || !m.root_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("marker root_id is not 32 lowercase hex digits".into());
    }
    if m.root_path != real {
        return Err(format!("marker was written for {} but this root is {real}", m.root_path));
    }
    Ok(Root { path: std::fs::canonicalize(path).map_err(|e| e.to_string())?, root_id: m.root_id })
}
