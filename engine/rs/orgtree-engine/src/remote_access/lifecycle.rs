//! Where the door stands, and when.
//!
//! NOT BUILT: this is the shape the tests in `tests.rs` are written against.
//! Nothing binds a door, a switch is never refused, and the door is always
//! said to be closed.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::engine::Engine;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Tailscale,
    Lan,
    Rig,
}

/// One address the door should be bound to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Want {
    pub kind: Kind,
    pub at: SocketAddr,
}

/// This computer's addresses, as read at one moment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reading {
    pub tailscale: Option<Option<Ipv4Addr>>,
    pub dns: Option<String>,
    pub lan: Option<Ipv4Addr>,
    pub rig: Option<IpAddr>,
}

#[derive(Default)]
pub struct Doors {
    fixed: Mutex<Option<Reading>>,
}

#[nolog]
impl Doors {
    #[cfg(any(test, debug_assertions))]
    pub fn fix(&self, reading: Reading) {
        if let Ok(mut fixed) = self.fixed.lock() {
            *fixed = Some(reading);
        }
    }

    pub fn standing(&self) -> Vec<Want> {
        Vec::new()
    }
}

#[nolog]
pub async fn refresh(_engine: &Arc<Engine>) {}

#[nolog]
pub fn status(_engine: &Engine) -> Value {
    json!({ "state": "closed", "addresses": [] })
}
