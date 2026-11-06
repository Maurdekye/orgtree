//! Built-in live engine feed (spec: docket `built-in-live-org-state-feed-for-outside-program`).
//! RED SKELETON: the API the tests use, with no behaviour yet.
pub mod tokens;
#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine::Engine;

/// Test-only knobs: a random port instead of the setting's, and short intervals.
#[derive(Clone)]
pub struct TestOpts {
    /// `Some(0)`: a random port; `Some(p)`: exactly p; `None`: the setting's port.
    pub port: Option<u16>,
    pub heartbeat: Duration,
    pub retry: Duration,
    /// After the first state, wait this long before draining the queue (so a test can overfill it).
    pub pause: Duration,
}

#[derive(Default)]
pub struct LiveFeed {}

#[nolog]
impl LiveFeed {
    pub fn set_test_opts(&self, _o: TestOpts) {}
    /// Read the settings and (re)bind or stop the listener to match.
    pub async fn apply(&self, _engine: &Arc<Engine>) {}
    pub fn local_addr(&self) -> Option<SocketAddr> { None }
    pub fn status(&self) -> Value { json!({"state":"off"}) }
    /// A new access token for `agent` of `org`: (id, token). The token is shown once.
    pub async fn create_token(&self, _engine: &Arc<Engine>, _label: &str, _org: &str, _agent: &str) -> anyhow::Result<(String, String)> { anyhow::bail!("not built") }
    pub fn revoke_token(&self, _id: &str) -> bool { false }
    /// The `X-Orgtree-Feed-Agent` value for a live agent owner of a websocket dog on the feed URL.
    pub fn agent_header(&self, _org: i64, _agent: i64, _generation: i64) -> String { String::new() }
}
