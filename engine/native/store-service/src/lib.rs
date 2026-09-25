//! The P03 store service (CONTRACT-M1 §9): the Rust process the thin Python
//! doors call over an authenticated loopback channel (coordinator ruling Q3).
//!
//! * [`guard`]: refuses any root that is not a WS1-marked disposable
//!   prototype root, or that overlaps a live Orgtree location.
//! * [`proto`] / [`server`]: length-prefixed JSON frames; a per-boot token in
//!   the first frame; a handshake reporting verbs, points and controls.
//! * [`descriptor`]: the owner-only file the door reads (port + token).
//! * [`handler`]: verb routing onto the executor.

pub mod boot;
pub mod descriptor;
pub mod guard;
pub mod handler;
#[cfg(feature = "qualification")]
pub mod harness;
pub mod proto;
pub mod server;
