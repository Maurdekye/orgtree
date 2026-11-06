//! The built-in live engine feed (docs/rust-engine/live-feed.md; spec: docket
//! `built-in-live-org-state-feed-for-outside-program`).
//!
//! A local WebSocket on `127.0.0.1:<live_feed_port>` (default 47830) that publishes the engine's event catalogue to programs on this
//! computer. The public tier sees name-free counts only; an agent-bound connection sees what that agent's own event watchdog would,
//! because both pass through the ONE shared authorizer `runtime::watchdogs::events::authorize` (invariants I1 PARITY and I2
//! VISIBILITY CAP). Everything here is `#[nolog]`: frames and credentials never reach the call log.
pub mod tokens;
mod server;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;

/// The header a websocket dog on the feed URL carries (spec 3.2): `<agent_id>.<hex HMAC>`.
pub const AGENT_HEADER: &str = "x-orgtree-feed-agent";
pub const PATH: &str = "/v1/events";
/// Machine-wide cap on open feed connections.
pub const MAX_CONNECTIONS: usize = 32;

/// Test-only knobs: a chosen port instead of the setting's, and short intervals.
#[derive(Clone)]
pub struct TestOpts {
    /// `Some(0)`: a random port; `Some(p)`: exactly p; `None`: the setting's port.
    pub port: Option<u16>,
    pub heartbeat: Duration,
    pub retry: Duration,
    /// After the first state, wait this long before draining the queue (so a test can overfill it).
    pub pause: Duration,
}

/// How to end one connection: a WebSocket close code and a short reason.
pub(crate) type Close = (u16, &'static str);

pub(crate) struct Ctl {
    pub tx: mpsc::UnboundedSender<Close>,
    pub token: Option<String>,
    /// the bound agent (None: the public tier)
    pub agent: Option<i64>,
}

#[derive(Clone)]
enum Status {
    Off,
    Listening,
    Error(String),
}

struct State {
    status: Status,
    addr: Option<SocketAddr>,
    cancel: Option<CancellationToken>,
    /// bumped by every `apply`; a retry task of an older one stops
    generation: u64,
}

pub(crate) struct Inner {
    test: Mutex<Option<TestOpts>>,
    state: Mutex<State>,
    pub(crate) conns: Mutex<HashMap<u64, Ctl>>,
    pub(crate) open: AtomicUsize,
    pub(crate) next_id: AtomicU64,
    secret: [u8; 32],
    tokens: Mutex<Option<Arc<tokens::Tokens>>>,
}

pub struct LiveFeed {
    pub(crate) inner: Arc<Inner>,
}

impl Default for LiveFeed {
    fn default() -> Self {
        let mut secret = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut secret);
        Self { inner: Arc::new(Inner {
            test: Mutex::new(None),
            state: Mutex::new(State { status: Status::Off, addr: None, cancel: None, generation: 0 }),
            conns: Mutex::new(HashMap::new()),
            open: AtomicUsize::new(0),
            next_id: AtomicU64::new(0),
            secret,
            tokens: Mutex::new(None),
        }) }
    }
}

#[nolog]
impl Inner {
    pub(crate) fn heartbeat(&self) -> Duration {
        self.test.lock().ok().and_then(|t| t.as_ref().map(|t| t.heartbeat)).unwrap_or(Duration::from_secs(30))
    }
    pub(crate) fn pause(&self) -> Duration {
        self.test.lock().ok().and_then(|t| t.as_ref().map(|t| t.pause)).unwrap_or_default()
    }
    fn retry(&self) -> Duration {
        self.test.lock().ok().and_then(|t| t.as_ref().map(|t| t.retry)).unwrap_or(Duration::from_secs(30))
    }
    fn port(&self, engine: &Engine) -> u16 {
        self.test.lock().ok().and_then(|t| t.as_ref().and_then(|t| t.port)).unwrap_or_else(|| engine.settings.live_feed_port())
    }
    pub(crate) fn tokens(&self, engine: &Engine) -> Result<Arc<tokens::Tokens>> {
        let mut slot = self.tokens.lock().map_err(|_| anyhow!("token store unavailable"))?;
        if let Some(t) = slot.as_ref() { return Ok(t.clone()); }
        let t = Arc::new(tokens::Tokens::open(&engine.cfg.data_root)?);
        *slot = Some(t.clone());
        Ok(t)
    }
    /// End every open connection (or, with `only_token`, those of one token).
    pub(crate) fn close(&self, code: u16, reason: &'static str, only_token: Option<&str>) {
        if let Ok(conns) = self.conns.lock() {
            for c in conns.values().filter(|c| only_token.is_none_or(|t| c.token.as_deref() == Some(t))) {
                let _ = c.tx.send((code, reason));
            }
        }
    }
    fn set(&self, status: Status, addr: Option<SocketAddr>) {
        if let Ok(mut st) = self.state.lock() { st.status = status; st.addr = addr; }
    }
    /// The port the listener actually holds.
    pub(crate) fn bound_port(&self) -> Option<u16> {
        self.state.lock().ok().and_then(|s| s.addr.map(|a| a.port()))
    }
    /// HMAC-SHA256 of `<org>:<agent>:<generation>` under this process's boot secret, hex.
    pub(crate) fn mac(&self, org: i64, agent: i64, generation: i64) -> String {
        hex::encode(hmac(&self.secret, format!("{org}:{agent}:{generation}").as_bytes()))
    }
}

#[nolog]
fn hmac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 { k[..32].copy_from_slice(&Sha256::digest(key)); } else { k[..key.len()].copy_from_slice(key); }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

#[nolog]
impl LiveFeed {
    pub fn set_test_opts(&self, o: TestOpts) {
        if let Ok(mut t) = self.inner.test.lock() { *t = Some(o); }
    }

    /// Read the settings and (re)bind or stop the listener to match. Open connections end first (1001 when the feed is off, 1012
    /// when it rebinds). The first bind attempt happens before this returns; a busy port is retried in the background.
    pub async fn apply(&self, engine: &Arc<Engine>) {
        let inner = &self.inner;
        let enabled = engine.settings.live_feed_enabled();
        let generation = {
            let Ok(mut st) = inner.state.lock() else { return };
            st.generation += 1;
            if let Some(c) = st.cancel.take() { c.cancel(); }
            st.addr = None;
            st.status = Status::Off;
            st.generation
        };
        if enabled { inner.close(1012, "feed rebinding", None); } else { inner.close(1001, "feed disabled", None); }
        if !enabled { return; }
        let port = inner.port(engine);
        if server::try_bind(inner, engine, port, generation).await { return; }
        let (inner, engine) = (inner.clone(), engine.clone());
        tokio::spawn(async move {
            loop {
                tokio::select! { _ = tokio::time::sleep(inner.retry()) => {}, _ = engine.shutdown.cancelled() => return }
                if inner.state.lock().map(|s| s.generation != generation).unwrap_or(true) { return; }
                if server::try_bind(&inner, &engine, port, generation).await { return; }
            }
        });
    }

    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.inner.state.lock().ok().and_then(|s| s.addr)
    }

    /// `{state: off|listening|error, url?, error?}` for the settings payload.
    pub fn status(&self) -> Value {
        let Ok(st) = self.inner.state.lock() else { return json!({"state": "off"}) };
        match (&st.status, st.addr) {
            (Status::Listening, Some(a)) => json!({"state": "listening", "url": format!("ws://{a}{PATH}")}),
            (Status::Error(e), _) => json!({"state": "error", "error": e}),
            _ => json!({"state": "off"}),
        }
    }

    /// A new access token for a live agent: (id, token). The token is shown once.
    pub async fn create_token(&self, engine: &Arc<Engine>, label: &str, org: &str, agent: &str) -> Result<(String, String)> {
        let Some(org) = engine.orgs.get(org) else { bail!("no organization {org}") };
        let client = engine.db.get().await?;
        let Some(row) = client.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live' AND kind='agent'", &[&org.id, &agent]).await? else {
            bail!("no live agent named {agent} in {}", org.slug);
        };
        let (record, token) = self.inner.tokens(engine)?.create(label, org.id, row.get(0))?;
        Ok((record.id, token))
    }

    /// The live agents of an org, sorted by name (the Settings picker for a new token).
    pub async fn live_agents(&self, engine: &Arc<Engine>, org: &str) -> Result<Vec<String>> {
        let Some(org) = engine.orgs.get(org) else { bail!("no organization {org}") };
        let client = engine.db.get().await?;
        let rows = client.query("SELECT name FROM ot.agents WHERE org_id=$1 AND state='live' AND kind='agent' ORDER BY lower(name), name", &[&org.id]).await?;
        Ok(rows.iter().map(|r| r.get(0)).collect())
    }

    /// Revoke a token; its connections end with 4401 within a second.
    pub fn revoke_token(&self, id: &str) -> bool {
        let Some(t) = self.inner.tokens.lock().ok().and_then(|t| t.clone()) else { return false };
        match t.revoke(id) {
            Ok(true) => { self.inner.close(4401, "token revoked", Some(id)); true }
            _ => false,
        }
    }

    /// The token rows for Settings, with the agent and org names and the last use.
    pub async fn list_tokens(&self, engine: &Arc<Engine>) -> Result<Vec<Value>> {
        let tokens = self.inner.tokens(engine)?;
        let client = engine.db.get().await?;
        let mut out = Vec::new();
        for r in tokens.list() {
            let name: Option<String> = client.query_opt("SELECT name FROM ot.agents WHERE id=$1", &[&r.agent_id]).await?.map(|x| x.get(0));
            let live: bool = client.query_opt("SELECT state='live' FROM ot.agents WHERE id=$1", &[&r.agent_id]).await?.map(|x| x.get(0)).unwrap_or(false);
            let slug = engine.orgs.by_id(r.org_id).map(|o| o.slug.clone()).unwrap_or_default();
            let mut row = tokens::public(&r, name.as_deref().unwrap_or("(deleted)"), &slug, tokens.last_used(&r.id));
            row["agent_live"] = json!(live);
            out.push(row);
        }
        Ok(out)
    }

    /// The `X-Orgtree-Feed-Agent` value for a live agent at this generation.
    pub fn agent_header(&self, org: i64, agent: i64, generation: i64) -> String {
        format!("{agent}.{}", self.inner.mac(org, agent, generation))
    }

    /// The header for a websocket dog dialing the feed: only when `endpoint` is exactly this feed's URL and `owner` is a live
    /// agent (a project owner gets none: the public tier).
    pub async fn dog_header(&self, engine: &Engine, endpoint: &crate::ws::Endpoint, owner: i64) -> Option<String> {
        if endpoint.tls || !matches!(endpoint.host.as_str(), "127.0.0.1" | "localhost") { return None; }
        let path = endpoint.resource.split('?').next().unwrap_or("");
        if path != PATH { return None; }
        let ours = self.inner.bound_port().is_some_and(|p| p == endpoint.port) || endpoint.port == engine.settings.live_feed_port();
        if !ours { return None; }
        let client = engine.db.get().await.ok()?;
        let row = client.query_opt("SELECT org_id, generation FROM ot.agents WHERE id=$1 AND state='live' AND kind='agent'", &[&owner]).await.ok()??;
        Some(self.agent_header(row.get(0), owner, i64::from(row.get::<_, i32>(1))))
    }
}
