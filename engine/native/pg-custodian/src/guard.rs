//! The custodian's side of the prototype-root guard (P03 risk R11).
//!
//! Every rule lives in the shared crate `orgtree-prototype-guard`
//! (`engine/native/prototype-guard`), which the WS2 store service uses too, so
//! the live-location list and the canonicalization have ONE definition. This
//! module adds only what the custodian alone does: [`init_root`], which writes
//! a marker into a new or empty folder. The wrappers convert errors into the
//! custodian's error type.

use crate::error::{CustodianError, Result};
use std::path::Path;

pub use orgtree_prototype_guard::{
    process_env, protected_locations, unconditional_locations, Env, PrototypeRoot, RootMarker, MARKER_FILE, MARKER_SCHEMA,
};
use orgtree_prototype_guard as shared;

impl From<shared::GuardError> for CustodianError {
    fn from(e: shared::GuardError) -> Self {
        CustodianError::new(e.code, e.message)
    }
}

pub fn lexical(path: &Path) -> Result<String> {
    Ok(shared::lexical(path)?)
}

pub fn canonical(path: &Path) -> Result<String> {
    Ok(shared::canonical(path)?)
}

/// Kept for callers written before the shared crate; same as [`canonical`].
pub fn resolved(path: &Path) -> Result<String> {
    canonical(path)
}

pub fn check_location(path: &Path, env: &Env) -> Result<String> {
    Ok(shared::check_location(path, env)?)
}

pub fn validate_root(path: &Path, env: &Env) -> Result<PrototypeRoot> {
    Ok(shared::validate_root(path, env)?)
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
    // Check again now that the folder exists (a junction created in the
    // meantime is caught here, by location and by the reparse-point rule).
    let real = check_location(path, env)?;
    shared::refuse_reparse_points(path)?;
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
