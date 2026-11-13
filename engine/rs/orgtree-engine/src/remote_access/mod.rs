//! A desktop that lets other computers open some of its organizations
//! (docs/rust-engine/remote-org.md, "A desktop as host").
//!
//! NOT BUILT: this is the shape the tests in `tests.rs` are written against.
//! Nothing here lets anyone in, and the request guard does not know the door.

pub mod door;
pub mod member;
pub mod registry;
pub mod text;
#[cfg(test)]
mod tests;

use std::path::Path;

use registry::Registry;

/// What a hosting desktop knows about who may come in.
pub struct RemoteAccess {
    pub registry: Registry,
}

#[nolog]
impl RemoteAccess {
    pub fn open(root: &Path) -> RemoteAccess {
        RemoteAccess { registry: Registry::open(root) }
    }

    /// The switch of one organization. Not built: it switches nothing.
    pub fn set_open(&self, _org_uuid: &str, _on: bool) {}
}
