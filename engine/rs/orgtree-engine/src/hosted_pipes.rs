//! The stdio pipes of a CLI that the sign-in helper starts for the engine.
//! The engine serves them (`runtime::session_host::start_hosted`) and the
//! helper opens them (`credential_broker_host::spawn`). The two are separate
//! binaries, so both include this file.

/// Every hosted CLI's pipe name starts with this, and the helper opens no
/// other pipe.
pub const PREFIX: &str = r"\\.\pipe\orgtree-cli-";

/// The stdin, stdout and stderr pipe names for one launch; `id` is a fresh
/// simple UUID.
#[nolog]
pub fn names(id: &str) -> [String; 3] {
    let base = format!("{PREFIX}{id}");
    [format!("{base}-in"), format!("{base}-out"), format!("{base}-err")]
}
