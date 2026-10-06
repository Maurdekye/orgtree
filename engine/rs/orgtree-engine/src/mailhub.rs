//! The bundled mail hub (the separate orgtree-mailhub product): started as a
//! child process, reported in desktop status, and used for `@net:` mail.

use std::sync::Arc;

use arc_swap::ArcSwap;
use serde_json::{json, Value};

use crate::engine::Engine;

#[derive(Clone, Debug, Default)]
pub struct HubState {
    pub running: bool,
    pub healthy: bool,
    pub port: u16,
    pub exposed: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct MailHub {
    pub state: ArcSwap<HubState>,
}

impl MailHub {
    /// The tree's `net` block for one org, or null when it has no network config.
    pub fn net_block(&self, org: &Value) -> Value {
        let net = &org["net"];
        let hubs = net.get("hubs").and_then(Value::as_array).cloned().unwrap_or_default();
        if hubs.is_empty() && net.get("identity").is_none() {
            return Value::Null;
        }
        let st = self.state.load();
        json!({
            "slug": net.pointer("/identity/slug").cloned().unwrap_or(Value::Null),
            "hubs": hubs.iter().map(|h| json!({
                "id": h["id"], "address": h["address"], "enabled": h.get("enabled").cloned().unwrap_or(json!(true)),
                "name": h.get("name").cloned().unwrap_or(Value::Null),
                "connected": st.healthy, "last_ok": Value::Null, "error": st.error,
                "queued": 0, "roster": [],
            })).collect::<Vec<_>>(),
        })
    }

    pub fn status(&self) -> Value {
        let s = self.state.load();
        let mut v = json!({ "running": s.running, "healthy": s.healthy, "port": s.port, "exposed": s.exposed });
        if let Some(e) = &s.error {
            v["error"] = json!(e);
        }
        v
    }
}

pub async fn start(_engine: &Arc<Engine>) {}

pub async fn stop(_engine: &Arc<Engine>) {}
