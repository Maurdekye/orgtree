//! The store service's root guard: a thin adapter over the ONE shared P03
//! guard, `orgtree-prototype-guard` (WS1; lead ruling 2026-09-25 09:02Z), so
//! the custodian, the store service and the Python door hook share a single
//! live-location list (`prototype-guard/live-locations.json`) and a single
//! canonicalization. The rules are the shared crate's: a WS1-marked
//! disposable root bound to its canonical path, outside and not containing any
//! protected location (checked typed and canonical), with no reparse point at
//! or under it. `ORGTREE_DATA` is protected unless it IS that marked root.

use std::path::{Path, PathBuf};

pub use orgtree_prototype_guard::{Env, MARKER_FILE, MARKER_SCHEMA};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    pub path: PathBuf,
    pub root_id: String,
}

fn msg(e: orgtree_prototype_guard::GuardError) -> String {
    e.to_string()
}

/// The only way to obtain a [`Root`].
pub fn validate(path: &Path, env: &Env) -> Result<Root, String> {
    let r = orgtree_prototype_guard::validate_root(path, env).map_err(msg)?;
    Ok(Root { path: r.path().to_path_buf(), root_id: r.root_id().to_string() })
}

/// Refuse a path that is, is inside, or contains a protected location.
pub fn refuse_live(path: &Path, env: &Env) -> Result<(), String> {
    orgtree_prototype_guard::check_location(path, env).map(|_| ()).map_err(msg)
}

/// The canonical form markers are bound to.
pub fn canonical(path: &Path) -> Result<String, String> {
    orgtree_prototype_guard::canonical(path).map_err(msg)
}
