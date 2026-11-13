//! Every sentence a hosting desktop says to the computers it lets in, and to
//! its own user about them (docs/rust-engine/remote-org.md, "A desktop as host").

/// What the door answers a request with no token it knows. The connecting
/// side reads any 403 without a word it knows as "this computer's token is no
/// longer accepted" (`remote/handshake.rs` `refusal_403`), which is what a
/// revoked computer must be told.
pub const TOKEN_REQUIRED: &str = "remote access token required";

/// The code a refusal carries when the organization is one the computer was
/// given and its owner switched remote access off.
pub const E16: &str = "E16";
/// The code a refusal carries when the request is for something that is not
/// the computer's: another organization, or anything app-wide.
pub const E17: &str = "E17";

/// E16, as the host says it. The connecting side shows its own sentence with
/// the names it knows the host and the organization by.
#[nolog]
pub fn e16(host: &str) -> String {
    format!("{host} no longer shares this organization.")
}

/// E17.
#[nolog]
pub fn e17(host: &str) -> String {
    format!("This belongs to {host}.")
}

pub const TOO_MANY_CODES: &str = "Five codes are already open for this organization. Wait for one to run out.";
pub const TOO_MANY_COMPUTERS: &str = "This organization already has 32 computers. Revoke one first.";
pub const NO_COMPUTER: &str = "That computer is not in the list any more.";
/// A code that was used, has run out, or never was one.
pub const CODE_USED: &str = "That code was already used or has run out. Ask for a new one.";
