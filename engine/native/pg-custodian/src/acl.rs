//! Owner-only files and folders: the rule and the Win32 calls live in the
//! shared `orgtree-prototype-guard` crate (`acl` module), so the custodian and
//! WS2's store service apply ONE definition. These wrappers convert errors.

use crate::error::Result;
use std::path::Path;

pub use orgtree_prototype_guard::acl::{is_owner_only, parse_sddl, AclReport, ADMINISTRATORS_SID, SYSTEM_SID};
use orgtree_prototype_guard::acl as shared;

pub fn current_user_sid() -> Result<String> {
    Ok(shared::current_user_sid()?)
}
pub fn create_owner_only_dir(path: &Path) -> Result<()> {
    Ok(shared::create_owner_only_dir(path)?)
}
pub fn write_owner_only_file(path: &Path, bytes: &[u8]) -> Result<()> {
    Ok(shared::write_owner_only_file(path, bytes)?)
}
pub fn read_acl(path: &Path) -> Result<AclReport> {
    Ok(shared::read_acl(path)?)
}
/// Fail closed unless `path` is verifiably owner-only.
pub fn require_owner_only(path: &Path) -> Result<AclReport> {
    Ok(shared::require_owner_only(path)?)
}
/// Replace `target` atomically with a new owner-only file holding `bytes`.
pub fn replace_owner_only(target: &Path, bytes: &[u8]) -> Result<()> {
    Ok(shared::replace_owner_only(target, bytes)?)
}
