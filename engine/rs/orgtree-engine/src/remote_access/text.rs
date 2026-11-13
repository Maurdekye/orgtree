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
pub const NO_CODE: &str = "That code is not open any more.";
/// What the door answers an address it has refused too often (`limiter.rs`).
pub const TOO_MANY_TRIES: &str = "too many refused requests from this address; try again in a minute";
/// The owner's routes on an engine that runs by itself.
pub const NOT_A_DESKTOP: &str = "remote access is a desktop's; a standalone engine has client tokens";
/// The owner's routes are the hosting desktop's own.
pub const OWNER_ONLY: &str = "only this desktop itself changes its remote access";
pub const TURN_ON_FIRST: &str = "Turn remote access on for this organization first.";
/// Why the switch cannot be turned on: there is nowhere for the door to stand.
pub const NO_WAY_IN: &str = "Tailscale is not running on this computer, so no other computer could reach it. Start Tailscale, or let remote access also use this private network (App settings, Remote access).";
pub const NO_WAY_IN_LAN: &str = "This computer has no Tailscale address and no private network address, so no other computer could reach it.";

/// The door could not be bound: something else has the port.
#[nolog]
pub fn port_taken(port: u16) -> String {
    format!("Port {port} is in use on this computer. Choose another port in App settings, Remote access.")
}
pub const PORT_RANGE: &str = "The port is a number from 1024 to 65535.";
/// A code that was used, has run out, or never was one.
pub const CODE_USED: &str = "That code was already used or has run out. Ask for a new one.";
