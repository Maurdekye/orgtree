//! PRODUCT roots (PYPG PG-1/PG-2, plan decisions 18.1 and 18.5): the engine's
//! OWN data root, served by its private PostgreSQL once the operator has cut
//! it over. It is not disposable, so it never passes [`crate::validate_root`];
//! it has its own, narrower door.
//!
//! A root is a product root only when ALL of these hold:
//!
//! 1. Shape: as for a prototype root (absolute, local, two folders deep).
//! 2. It IS the engine's own `ORGTREE_DATA`: the same canonical path. The
//!    custodian serves nothing else in this mode.
//! 3. It lies neither inside nor around any location in [`PRODUCT_DENY`]:
//!    the two agent-environment variables (so no agent session, whose
//!    environment names the live data there, can ever drive this mode) and
//!    the installed app. A label missing from the shared list fails CLOSED.
//! 4. The root itself is not a junction or symbolic link, and neither is
//!    anything under its `pg/` folder (the cluster). The rest of a real data
//!    root is not scanned: it is the user's, large, and not ours to judge.
//! 5. A binding file [`PRODUCT_FILE`] parses strictly and is BOUND to the
//!    root's canonical path, with a root id. `bind-product` writes it
//!    ([`bind_product_root`]); a copied or moved root no longer matches.
//!
//! A product root is marked `is_product()`: the custodian refuses to destroy
//! or restore over it, and runs only its lifecycle commands on it.

use crate::{
    canonical, lexical, product_root, real_case, refuse_protected, resolve_location, var, Env, GuardError, Result, RootMarker,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PRODUCT_FILE: &str = "orgtree-product-root.json";
pub const PRODUCT_SCHEMA: &str = "orgtree.product-root/v1";

/// The live-location labels a product root must stay clear of.
pub const PRODUCT_DENY: [&str; 4] =
    ["ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA", "%ProgramFiles%\\Orgtree", "%LOCALAPPDATA%\\Programs\\Orgtree"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProductBinding {
    pub schema: String,
    pub root_id: String,
    /// The canonical (case-folded) path the binding was written for.
    pub root_path: String,
    pub created_at_unix: u64,
    pub created_by: String,
}

fn deny_locations(env: &Env) -> Result<Vec<(String, PathBuf)>> {
    let spec = crate::live_locations();
    let mut out = Vec::new();
    for label in PRODUCT_DENY {
        let loc = spec
            .locations
            .iter()
            .find(|l| l.label == label)
            .ok_or_else(|| GuardError::new("product.bad_list", format!("the shared live-location list has no {label:?}")))?;
        if let Some(p) = resolve_location(env, loc) {
            out.push((loc.label.clone(), p));
        }
    }
    Ok(out)
}

/// Rules 1-4. Returns the canonical form.
fn check_product_location(path: &Path, env: &Env) -> Result<String> {
    let typed = lexical(path)?;
    if typed.ends_with('\\') || typed.matches('\\').count() < 2 {
        return Err(GuardError::new("root.too_shallow", format!("root must be at least two folders below a drive root: {typed}")));
    }
    let deny = deny_locations(env)?;
    refuse_protected(&typed, &deny, false)?;
    let data = var(env, "ORGTREE_DATA")
        .ok_or_else(|| GuardError::new("product.not_engine_root", "a product root must be the engine's own ORGTREE_DATA, which is unset"))?;
    let real = canonical(path)?;
    refuse_protected(&real, &deny, true)?;
    if real != canonical(&data)? {
        return Err(GuardError::new(
            "product.not_engine_root",
            format!("{real} is not the engine's own data root (ORGTREE_DATA = {})", data.display()),
        ));
    }
    if !path.is_dir() {
        return Err(GuardError::new("root.missing", format!("root does not exist: {}", path.display())));
    }
    if crate::is_reparse_point(path) {
        return Err(GuardError::new("root.reparse_point", format!("{} is itself a junction or symbolic link", path.display())));
    }
    let pg = path.join("pg");
    if pg.exists() {
        crate::refuse_reparse_points(&pg)?;
    }
    Ok(real)
}

fn read_binding(dir: &Path) -> Result<ProductBinding> {
    let p = dir.join(PRODUCT_FILE);
    let text = std::fs::read_to_string(&p).map_err(|_| {
        GuardError::new("product.unbound", format!("{} has no product binding ({PRODUCT_FILE}); run `pg-custodian bind-product`", dir.display()))
    })?;
    serde_json::from_str(&text).map_err(|e| GuardError::new("product.bad_binding", format!("{}: {e}", p.display())))
}

fn check_binding(b: &ProductBinding, real: &str) -> Result<()> {
    if b.schema != PRODUCT_SCHEMA {
        return Err(GuardError::new("product.bad_binding", format!("binding schema {:?} is not {PRODUCT_SCHEMA}", b.schema)));
    }
    if b.root_id.len() != 32 || !b.root_id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return Err(GuardError::new("product.bad_binding", format!("root_id {:?} is not 32 lowercase hex digits", b.root_id)));
    }
    if b.root_path != real {
        return Err(GuardError::new(
            "root.moved_or_copied",
            format!("the product binding was written for {} but this root is {real}", b.root_path),
        ));
    }
    Ok(())
}

fn as_root(path: &Path, real: &str, b: ProductBinding) -> Result<crate::PrototypeRoot> {
    let canon = real_case(path, real)?;
    let marker = RootMarker {
        schema: b.schema,
        root_id: b.root_id,
        root_path: b.root_path,
        // never disposable: `check_marker` refuses it as a prototype marker
        disposable: false,
        created_at_unix: b.created_at_unix,
        created_by: b.created_by,
    };
    Ok(product_root(canon, marker))
}

/// Rules 1-5. The only way to obtain a product root.
pub fn validate_product_root(path: &Path, env: &Env) -> Result<crate::PrototypeRoot> {
    let real = check_product_location(path, env)?;
    let b = read_binding(path)?;
    check_binding(&b, &real)?;
    as_root(path, &real, b)
}

/// Write the binding (rules 1-4 first). Idempotent: an existing binding for
/// this very path is kept as it is; one for another path refuses.
/// `new_id` supplies a fresh 32-hex root id; `now` the creation time.
pub fn bind_product_root(
    path: &Path,
    env: &Env,
    new_id: impl FnOnce() -> std::result::Result<String, GuardError>,
    now: u64,
    created_by: &str,
) -> Result<crate::PrototypeRoot> {
    let real = check_product_location(path, env)?;
    if path.join(PRODUCT_FILE).exists() {
        return validate_product_root(path, env);
    }
    let b = ProductBinding {
        schema: PRODUCT_SCHEMA.into(),
        root_id: new_id()?,
        root_path: real.clone(),
        created_at_unix: now,
        created_by: created_by.into(),
    };
    check_binding(&b, &real)?;
    let target = path.join(PRODUCT_FILE);
    let tmp = path.join(format!("{PRODUCT_FILE}.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&b).map_err(|e| GuardError::new("product.write", e.to_string()))?;
    std::fs::write(&tmp, text).map_err(|e| GuardError::new("product.write", format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, &target).map_err(|e| GuardError::new("product.write", format!("{}: {e}", target.display())))?;
    validate_product_root(path, env)
}
