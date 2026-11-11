//! Every sentence the remote-engine feature shows (docs/rust-engine/remote-org.md,
//! "Every text"). One home, so the engine, the tests and the documentation
//! quote the same words. `<name>` is the connection's display name.

pub const E1: &str = "Enter the engine's address, like http://100.x.y.z:7430.";
pub const E2: &str = "This address isn't on a private network, so the token would travel unencrypted. Use https, Tailscale or an SSH-forwarded port.";
pub const E4: &str = "That engine didn't accept the token.";
pub const E5: &str = "That address is an Orgtree desktop's own engine. Only a standalone (headless) engine can be added.";
pub const E5B: &str = "That is this computer's own Orgtree.";
pub const E6: &str = "This is a watch-only token. The desktop needs a full client token; watch-only tokens are for the viewer app.";
pub const TOKEN_MISSING: &str = "Paste the engine's startup token or a client token.";
pub const TOO_MANY: &str = "At most 32 remote engines can be added.";
pub const STANDALONE: &str = "remote engines are added from the desktop app, not from a standalone engine";

#[nolog]
pub fn e3(address: &str) -> String {
    format!("Couldn't reach an Orgtree engine at {address}. Check the address and that the engine is running.")
}

#[nolog]
pub fn e5c(name: &str) -> String {
    format!("This engine is already added as {name}.")
}

#[nolog]
pub fn e7(name: &str, version: &str, min: &str) -> String {
    format!("{name} runs Orgtree {version}. This app needs {min} or later on the remote engine.")
}

#[nolog]
pub fn e8(address: &str) -> String {
    format!("The engine at {address} is not the one you added. Remove this connection and add it again if that is intended.")
}

#[nolog]
pub fn e9(name: &str) -> String {
    format!("{name} is offline. Nothing was sent.")
}

#[nolog]
pub fn e10(name: &str) -> String {
    format!("{name} no longer accepts this computer's token. Nothing was sent.")
}

#[nolog]
pub fn e11(name: &str) -> String {
    format!("Not connected to {name}. Nothing was sent.")
}

#[nolog]
pub fn e12(name: &str) -> String {
    format!("Too many requests to {name} at once. Try again.")
}

#[nolog]
pub fn e13(name: &str) -> String {
    format!("The connection to {name} dropped before it answered. This may or may not have been applied; the view will show the result once reconnected.")
}

#[nolog]
pub fn e15(reason: &str) -> String {
    format!("Couldn't save the token on this computer: {reason}.")
}

/// A local organization cannot take a name that an organization of a remote
/// engine already holds in this list (its alias is the window's identity).
#[nolog]
pub fn alias_taken(slug: &str, name: &str) -> String {
    format!("org '{slug}' already exists in this list, on the remote engine {name}")
}
