//! `@net:` — the mail hub client (F-06), native.
//!
//! Identity: each org mints a permanent network identity once — a secret, its
//! sha256 fingerprint (all a hub ever stores), and the address
//! `<org slug>.<user>.<fingerprint[:6]>` — kept in `ot.orgs.net`. The secret
//! rides only the `X-Org-Auth` header and the one reveal route; it never
//! enters a payload, a log line or a URL.
//!
//! Transport: an outgoing message is an `org_inbox` row in state `queued`
//! (written by the send itself); the sender pass ships queued rows with
//! retries forever ("no hub yet" is a status, not an error). One long-poll
//! task per hub address carries every registered org's inbound mail,
//! the receipts owed to its senders, and the roster. Inbound mail is
//! delivered first (deduplicated on its hub id), then acknowledged: a crash
//! between the two repeats a delivery check, never loses a message.
//! Receipts are best-effort and never hold up correspondence.
//!
//! Nothing here holds a lock: status, rosters, backoff and owed receipts are
//! lock-free maps; the database rows carry the rest.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use arc_swap::ArcSwap;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use futures::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::changes::{self, Change};
use crate::engine::Engine;

pub const LOCAL_HUB_ID: &str = "local";
pub const DEFAULT_HUB_ADDRESS: &str = "http://127.0.0.1:7370";
const DEFAULT_HUB_PORT: u16 = 7370;
const POLL_WAIT_S: u64 = 25;
const BACKOFF_MAX_S: f64 = 30.0;
/// inbound older than this gets the "sent N hours ago" note
const STALE_AFTER_S: i64 = 3600;
const STATES: [&str; 4] = ["queued", "sent", "delivered", "read"];
pub const LEGACY_ATTACHMENT_MAX: u64 = 25 * 1024 * 1024;
const FILE_TIMEOUT: Duration = Duration::from_secs(3600);

#[derive(Clone, Copy, Debug)]
pub struct AttachmentLimit {
    pub bytes: u64,
    pub legacy: bool,
    /// a v2 hub's limit bounds a whole message, its text and files together
    /// (`max_message_bytes`); a v1 hub's bounds each file
    pub per_message: bool,
}

#[logged]
impl AttachmentLimit {
    pub fn from_health(health: &Value) -> Self {
        let per_message = health["max_message_bytes"].as_u64().filter(|n| *n > 0 && *n <= 9_007_199_254_740_991);
        match per_message.or_else(|| health["max_attachment_bytes"].as_u64().filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)) {
            Some(bytes) => Self { bytes, legacy: false, per_message: per_message.is_some() },
            None => Self { bytes: LEGACY_ATTACHMENT_MAX, legacy: true, per_message: false },
        }
    }
    /// A whole message against a per-message limit (a v2 hub): its text and
    /// its files together.
    pub fn check_message(&self, body_bytes: u64, file_bytes: u64) -> Result<()> {
        let total = body_bytes + file_bytes;
        if self.per_message && total > self.bytes {
            crate::refuse!(
                BadRequest,
                "this message is {total} bytes with its files; the hub takes at most {} bytes per message (text and files together)",
                self.bytes
            );
        }
        Ok(())
    }
    pub fn message(&self) -> String {
        if self.legacy { "attachment exceeds 25 MB (this hub doesn't state its limit; using 25 MB)".into() }
        else { format!("attachment exceeds hub limit of {} bytes", self.bytes) }
    }
    pub fn check(&self, bytes: u64) -> Result<()> {
        if bytes > self.bytes { crate::refuse!(BadRequest, "{}", self.message()); }
        Ok(())
    }
}

#[logged]
async fn attachment_limit_at(address: &str) -> AttachmentLimit {
    let health = async {
        HTTP.get(format!("{address}/healthz")).timeout(Duration::from_secs(5)).send().await?
            .error_for_status()?.json::<Value>().await
    }.await.unwrap_or(Value::Null);
    AttachmentLimit::from_health(&health)
}

#[logged]
pub async fn attachment_limit(engine: &Engine, org_id: i64, peer: &str) -> Result<AttachmentLimit> {
    // Debug rig uses canned health documents, never a real hub or identity
    // (unless it hosts its own loopback hub).
    #[cfg(debug_assertions)]
    if crate::rig::active() && !crate::rig::hub() {
        let health = std::fs::read(engine.cfg.path("rig-hub-limits.json"))
            .ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
        return Ok(AttachmentLimit::from_health(&health[peer]));
    }
    if offline() { return Ok(AttachmentLimit::from_health(&Value::Null)); }
    let parts = participants(engine).await?;
    let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { crate::refuse!(BadRequest, "no mail hub is configured for this organization"); };
    let Some((_, address)) = pick_hub(engine, p, peer.trim().trim_start_matches("@net:")) else {
        crate::refuse!(BadRequest, "no mail hub is enabled for this organization");
    };
    Ok(attachment_limit_at(&address).await)
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("orgtree-engine/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
});

#[derive(Clone, Debug, Default, PartialEq)]
struct Status {
    connected: bool,
    last_ok: Option<String>,
    error: Option<String>,
}

/// One org taking part, as one pass saw it.
#[derive(Clone)]
pub struct Part {
    org_id: i64,
    slug: String,
    name: String,
    net_slug: String,
    secret: String,
    /// enabled hubs: (id, address)
    hubs: Vec<(String, String)>,
    /// hub ids this org is registered on (at their current address)
    registered: HashSet<String>,
}

impl std::fmt::Debug for Part {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Part")
            .field("org_id", &self.org_id)
            .field("slug", &self.slug)
            .field("net_slug", &self.net_slug)
            .field("secret", &"*****")
            .field("hubs", &self.hubs)
            .field("registered", &self.registered)
            .finish()
    }
}

impl Part {
    fn auth(&self) -> String {
        format!("{}:{}", self.net_slug, self.secret)
    }
}

#[derive(Default)]
pub struct Net {
    /// (org id, hub id) → connection status
    status: papaya::HashMap<(i64, String), Status>,
    /// hub address → its roster
    rosters: papaya::HashMap<String, Arc<Vec<Value>>>,
    /// hub address → the name it gave itself
    names: papaya::HashMap<String, String>,
    /// hub address → the version it reports (a v1 hub reports none)
    versions: papaya::HashMap<String, String>,
    /// hub address → (not before, consecutive failures)
    backoff: papaya::HashMap<String, (Instant, u32)>,
    /// receipts owed: (org id, hub message id, state) → hub address
    owed: papaya::HashMap<(i64, String, &'static str), String>,
    /// Confirmed consumption may arrive before participants load at startup.
    /// Keep the hub id until a sender pass can resolve its address.
    read_owed: papaya::HashMap<(i64, String), String>,
    /// running long polls: hub address → (its registered members, stop token)
    pollers: papaya::HashMap<String, (String, CancellationToken)>,
    /// the participants of the last pass
    parts: ArcSwap<Vec<Part>>,
    kick: tokio::sync::Notify,
}

/// Network mail is paused for this run (a scratch copy holds real
/// identities: it must never reach a real hub as them).
#[logged]
pub fn offline() -> bool {
    (crate::mailhub::safe_start() && !crate::rig::hub()) || std::env::var("ORGTREE_NET_OFFLINE").as_deref() == Ok("1")
}

/// Wake the sender now (a send queued a row, settings changed, the hub came up).
#[logged]
pub fn kick(engine: &Engine) {
    engine.net.kick.notify_one();
}

fn now_iso() -> String {
    crate::util::now_iso()
}

/// A bare host is a valid hub address: no scheme means http, no port means 7370.
#[logged]
pub fn normalize_address(addr: &str) -> String {
    let a = addr.trim().trim_end_matches('/');
    if a.is_empty() {
        return String::new();
    }
    let a = if a.contains("://") { a.to_string() } else { format!("http://{a}") };
    match reqwest::Url::parse(&a) {
        Ok(u) if u.scheme() == "http" && u.port().is_none() && u.host_str().is_some() => {
            let mut v = u.clone();
            let _ = v.set_port(Some(DEFAULT_HUB_PORT));
            v.to_string().trim_end_matches('/').to_string()
        }
        _ => a,
    }
}

fn sanitize_user(user: &str) -> String {
    let s: String = user.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_lowercase();
    if s.is_empty() { "user".into() } else { s }
}

fn username() -> String {
    sanitize_user(&std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default())
}

/// Where this machine's own hub answers: the hosted hub, else a configured
/// default, else the standard address.
#[logged]
pub fn local_address(engine: &Engine) -> String {
    if let Some(a) = engine.hub.address.load_full() {
        return a.as_str().to_string();
    }
    engine
        .settings
        .defaults()
        .get("net_hub_address")
        .and_then(Value::as_str)
        .map(normalize_address)
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| DEFAULT_HUB_ADDRESS.to_string())
}

/// A new org's hub list: this machine's hub when it auto-connects, then the
/// typed remote hubs, each with its own id (per-hub state survives an
/// address edit; hub names are learned on connect).
#[logged]
pub fn hub_entries(engine: &Engine, autoconnect: bool, remote: &[String]) -> Vec<Value> {
    let mut hubs = Vec::new();
    if autoconnect {
        hubs.push(json!({ "id": LOCAL_HUB_ID, "address": local_address(engine), "enabled": true }));
    }
    for a in remote.iter().map(|a| a.trim()).filter(|a| !a.is_empty()) {
        hubs.push(json!({ "id": crate::util::random_hex(4), "address": a, "enabled": true }));
    }
    hubs
}

/// Mint the org's identity and hub list when it has none (idempotent: an
/// existing identity is never touched — the address is permanent).
#[logged]
pub async fn ensure_identity(engine: &Engine, org_id: i64, org_slug: &str) -> Result<Value> {
    let client = engine.db.get().await?;
    let net: Value = client.query_one("SELECT net FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let has_identity = net.pointer("/identity/secret").and_then(Value::as_str).map(|s| !s.is_empty()).unwrap_or(false);
    let mut patch = Map::new();
    if !has_identity {
        let secret = crate::util::random_hex(16);
        let fp = hex::encode(Sha256::digest(secret.as_bytes()));
        patch.insert(
            "identity".into(),
            json!({ "secret": secret, "fingerprint": fp, "slug": format!("{org_slug}.{}.{}", username(), &fp[..6]),
                    "minted_at": now_iso() }),
        );
    }
    if net.get("hubs").map(|h| !h.is_array()).unwrap_or(true) {
        let auto = net.get("autoconnect").and_then(Value::as_bool).unwrap_or(true);
        patch.insert("autoconnect".into(), json!(auto));
        let hubs = if auto { json!([{ "id": LOCAL_HUB_ID, "address": local_address(engine), "enabled": true }]) } else { json!([]) };
        patch.insert("hubs".into(), hubs);
    }
    if patch.is_empty() {
        return Ok(net);
    }
    // never overwrite an identity another writer minted first
    let row = client
        .query_one(
            "UPDATE ot.orgs SET net = CASE WHEN coalesce(net->'identity'->>'secret', '') <> '' THEN net || ($2::jsonb - 'identity')
                                       ELSE net || $2::jsonb END
              WHERE id = $1 RETURNING net",
            &[&org_id, &Value::Object(patch)],
        )
        .await?;
    Ok(row.get(0))
}

/// Every org taking part, its identity backfilled, the local hub entry
/// pointed at the hub this engine hosts, and stale registrations dropped.
#[logged]
async fn participants(engine: &Engine) -> Result<Vec<Part>> {
    let rows = {
        let client = engine.db.get().await?;
        client.query("SELECT id, slug, name, net FROM ot.orgs WHERE state = 'active' ORDER BY id", &[]).await?
    };
    let hosted = engine.hub.address.load_full().map(|a| a.as_str().to_string());
    let mut out = Vec::new();
    for r in rows {
        let org_id: i64 = r.get(0);
        let slug: String = r.get(1);
        let name: String = r.get(2);
        let mut net: Value = r.get(3);
        if net.pointer("/identity/secret").is_none() || !net["hubs"].is_array() {
            net = match ensure_identity(engine, org_id, &slug).await {
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!(org = %slug, error = %format!("{e:#}"), "network identity could not be minted");
                    continue;
                }
            };
        }
        // the hosted hub's address wins for the implicit local entry
        if let Some(addr) = &hosted {
            let stale = net["hubs"].as_array().map(|hs| {
                hs.iter().any(|h| h["id"] == json!(LOCAL_HUB_ID) && h["address"].as_str().map(|a| a.trim_end_matches('/')) != Some(addr))
            });
            if stale == Some(true) {
                let mut hubs = net["hubs"].clone();
                for h in hubs.as_array_mut().into_iter().flatten() {
                    if h["id"] == json!(LOCAL_HUB_ID) {
                        h["address"] = json!(addr);
                    }
                }
                let client = engine.db.get().await?;
                client
                    .execute("UPDATE ot.orgs SET net = jsonb_set(net, '{hubs}', $2) WHERE id = $1", &[&org_id, &hubs])
                    .await?;
                net["hubs"] = hubs;
            }
        }
        let mut hubs: Vec<(String, String)> = net["hubs"]
            .as_array()
            .map(|hs| {
                hs.iter()
                    .filter(|h| h["enabled"].as_bool().unwrap_or(true))
                    .filter_map(|h| {
                        let id = h["id"].as_str()?.to_string();
                        let a = normalize_address(h["address"].as_str()?);
                        (!a.is_empty()).then_some((id, a))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // a rig run reaches the hub it hosts, never another
        if crate::rig::hub() {
            hubs.retain(|(_, a)| hosted.as_deref() == Some(a.as_str()));
        }
        // a registration counts only for the address it was earned against
        let state = net["state"].as_object().cloned().unwrap_or_default();
        let current: std::collections::HashMap<&str, &str> = hubs.iter().map(|(i, a)| (i.as_str(), a.as_str())).collect();
        let stale: Vec<String> = state
            .iter()
            .filter(|(k, v)| current.get(k.as_str()).map(|a| v["address"].as_str() != Some(*a)).unwrap_or(true))
            .map(|(k, _)| k.clone())
            .collect();
        if !stale.is_empty() {
            let client = engine.db.get().await?;
            client
                .execute("UPDATE ot.orgs SET net = jsonb_set(net, '{state}', (net->'state') - $2::text[]) WHERE id = $1", &[&org_id, &stale])
                .await?;
        }
        let registered: HashSet<String> = hubs
            .iter()
            .filter(|(id, addr)| {
                let cell = &state.get(id.as_str()).cloned().unwrap_or(Value::Null);
                cell["registered_at"].is_string() && cell["address"].as_str() == Some(addr.as_str())
            })
            .map(|(id, _)| id.clone())
            .collect();
        let (Some(net_slug), Some(secret)) = (net.pointer("/identity/slug").and_then(Value::as_str), net.pointer("/identity/secret").and_then(Value::as_str))
        else {
            continue;
        };
        out.push(Part { org_id, slug, name, net_slug: net_slug.to_string(), secret: secret.to_string(), hubs, registered });
    }
    Ok(out)
}

// ------------------------------------------------------------ status

#[logged]
fn backed_off(engine: &Engine, addr: &str) -> bool {
    engine.net.backoff.pin().get(addr).map(|(t, _)| Instant::now() < *t).unwrap_or(false)
}

#[logged]
fn failed(engine: &Engine, addr: &str) {
    let map = engine.net.backoff.pin();
    let n = map.get(addr).map(|(_, n)| n + 1).unwrap_or(1);
    let wait = BACKOFF_MAX_S.min(2f64.powi(n as i32));
    map.insert(addr.to_string(), (Instant::now() + Duration::from_secs_f64(wait), n));
}

#[logged]
fn succeeded(engine: &Engine, addr: &str) {
    engine.net.backoff.pin().remove(addr);
}

/// Record a connection status; the org's network panel updates on a change.
#[logged]
fn set_status(engine: &Engine, org_id: i64, hub_id: &str, connected: bool, error: Option<String>) {
    let key = (org_id, hub_id.to_string());
    let map = engine.net.status.pin();
    let prev = map.get(&key).cloned().unwrap_or_default();
    let next = Status {
        connected,
        last_ok: if connected { Some(now_iso()) } else { prev.last_ok.clone() },
        error: if connected { None } else { error },
    };
    let changed = prev.connected != next.connected || prev.error != next.error;
    map.insert(key, next);
    if prev.connected != connected {crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event(if connected{"hub.up"}else{"hub.down"},crate::runtime::watchdogs::events::Scope::Org(org_id),json!({"hub":hub_id})));}
    if changed {
        if let Some(o) = engine.orgs.by_id(org_id) {
            changes::notify(engine, &o, vec![Change::Net]);
        }
    }
}

/// Adopt a roster (and the hub's name and version); every org on that hub
/// sees it.
#[logged]
fn set_roster(engine: &Engine, addr: &str, name: Option<&str>, version: Option<&str>, roster: Vec<Value>) {
    let mut changed = false;
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        let names = engine.net.names.pin();
        if names.get(addr).map(String::as_str) != Some(n) {
            names.insert(addr.to_string(), n.to_string());
            changed = true;
        }
    }
    // every answer that names a v2 hub gives its version: one that names
    // itself without one is a v1 hub
    if name.is_some() {
        let versions = engine.net.versions.pin();
        match version.filter(|v| !v.is_empty()) {
            Some(v) if versions.get(addr).map(String::as_str) != Some(v) => {
                versions.insert(addr.to_string(), v.to_string());
                changed = true;
            }
            None if versions.remove(addr).is_some() => changed = true,
            _ => {}
        }
    }
    let rosters = engine.net.rosters.pin();
    if rosters.get(addr).map(|r| r.as_slice() != roster.as_slice()).unwrap_or(true) {
        rosters.insert(addr.to_string(), Arc::new(roster));
        changed = true;
    }
    if changed {
        for p in engine.net.parts.load().iter() {
            if p.hubs.iter().any(|(_, a)| a == addr) {
                if let Some(o) = engine.orgs.by_id(p.org_id) {
                    changes::notify(engine, &o, vec![Change::Net]);
                }
            }
        }
    }
}

#[logged]
async fn set_registered(engine: &Engine, org_id: i64, hub_id: &str, addr: Option<&str>) -> Result<()> {
    let client = engine.db.get().await?;
    let cell = match addr {
        Some(a) => json!({ "registered_at": now_iso(), "address": a }),
        None => Value::Null,
    };
    client
        .execute(
            "UPDATE ot.orgs SET net = jsonb_set(CASE WHEN jsonb_typeof(net->'state') = 'object' THEN net ELSE net || '{\"state\":{}}' END,
                                                ARRAY['state', $2], $3, true)
              WHERE id = $1",
            &[&org_id, &hub_id, &cell],
        )
        .await?;
    Ok(())
}

// ------------------------------------------------------------ the loops

/// Start the client (not in a paused run).
#[logged]
pub fn start(engine: &Arc<Engine>) {
    if offline() {
        tracing::info!("network mail is paused for this run (safe start)");
        return;
    }
    let eng = engine.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = eng.net.kick.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                _ = eng.shutdown.cancelled() => break,
            }
            if let Err(e) = pass(&eng).await {
                tracing::warn!(error = %format!("{e:#}"), "network mail pass failed");
            }
        }
        for (_, (_, t)) in eng.net.pollers.pin().iter() {
            t.cancel();
        }
    });
}

#[logged]
async fn pass(engine: &Arc<Engine>) -> Result<()> {
    let parts = participants(engine).await?;
    engine.net.parts.store(Arc::new(parts.clone()));
    register_pending(engine, &parts).await;
    let parts = participants(engine).await?;
    engine.net.parts.store(Arc::new(parts.clone()));
    reconcile_pollers(engine, &parts);
    drain(engine, &parts).await?;
    flush_receipts(engine, &parts).await;
    Ok(())
}

#[logged]
async fn register_pending(engine: &Arc<Engine>, parts: &[Part]) {
    for p in parts {
        for (hid, addr) in &p.hubs {
            if p.registered.contains(hid) || backed_off(engine, addr) {
                continue;
            }
            let res = HTTP
                .post(format!("{addr}/api/register"))
                .timeout(Duration::from_secs(10))
                .header("X-Org-Auth", p.auth())
                .json(&json!({ "slug": p.net_slug, "org_name": p.name, "username": username() }))
                .send()
                .await;
            match res {
                Ok(r) if r.status().is_success() => {
                    let data: Value = r.json().await.unwrap_or(Value::Null);
                    set_roster(engine, addr, data["name"].as_str(), data["version"].as_str(), data["roster"].as_array().cloned().unwrap_or_default());
                    if let Err(e) = set_registered(engine, p.org_id, hid, Some(addr)).await {
                        tracing::warn!(error = %format!("{e:#}"), "registration could not be recorded");
                        continue;
                    }
                    set_status(engine, p.org_id, hid, true, None);
                    succeeded(engine, addr);
                }
                Ok(r) => set_status(engine, p.org_id, hid, false, Some(format!("register: HTTP {}", r.status().as_u16()))),
                Err(e) => {
                    failed(engine, addr);
                    set_status(engine, p.org_id, hid, false, Some(short_error(&e)));
                }
            }
        }
    }
}

fn short_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "unreachable".into()
    } else if e.is_timeout() {
        "timed out".into()
    } else {
        "connection failed".into()
    }
}

/// One long poll per hub address that has a registered member; a change in
/// the members restarts it at once (a parked poll covers only the members it
/// was opened with).
#[logged]
fn reconcile_pollers(engine: &Arc<Engine>, parts: &[Part]) {
    let mut wanted: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for p in parts {
        for (hid, addr) in &p.hubs {
            if p.registered.contains(hid) {
                wanted.entry(addr.clone()).or_default().push(format!("{}:{hid}", p.org_id));
            }
        }
    }
    let wanted: std::collections::BTreeMap<String, String> = wanted.into_iter().map(|(a, mut m)| (a, { m.sort(); m.join(",") })).collect();
    let pollers = engine.net.pollers.pin();
    for (addr, (members, t)) in pollers.iter() {
        if wanted.get(addr) != Some(members) {
            t.cancel();
        }
    }
    pollers.retain(|addr, (members, _)| wanted.get(addr) == Some(members));
    for (addr, members) in wanted {
        if pollers.get(&addr).is_some() {
            continue;
        }
        let stop = engine.shutdown.child_token();
        pollers.insert(addr.clone(), (members, stop.clone()));
        let eng = engine.clone();
        tokio::spawn(async move { poller(eng, addr, stop).await });
    }
}

#[logged]
async fn poller(engine: Arc<Engine>, addr: String, stop: CancellationToken) {
    // the first poll returns at once: the connection shows up without
    // waiting out a long poll
    let mut wait = 0;
    while !stop.is_cancelled() {
        let parts = engine.net.parts.load_full();
        let members: Vec<(Part, String)> = parts
            .iter()
            .filter_map(|p| p.hubs.iter().find(|(id, a)| a == &addr && p.registered.contains(id)).map(|(id, _)| (p.clone(), id.clone())))
            .collect();
        if members.is_empty() || backed_off(&engine, &addr) {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = stop.cancelled() => break,
            }
            continue;
        }
        let auth = members.iter().map(|(p, _)| p.auth()).collect::<Vec<_>>().join(" ");
        let req = HTTP
            .post(format!("{addr}/api/poll?wait={wait}"))
            .timeout(Duration::from_secs(POLL_WAIT_S + 15))
            .header("X-Org-Auth", auth)
            .send();
        let res = tokio::select! {
            r = req => r,
            _ = stop.cancelled() => break,
        };
        let r = match res {
            Ok(r) => r,
            Err(e) => {
                failed(&engine, &addr);
                for (p, hid) in &members {
                    set_status(&engine, p.org_id, hid, false, Some(short_error(&e)));
                }
                continue;
            }
        };
        let code = r.status().as_u16();
        if code != 200 {
            failed(&engine, &addr);
            for (p, hid) in &members {
                set_status(&engine, p.org_id, hid, false, Some(format!("HTTP {code}")));
                if code == 401 {
                    // the hub does not know us (a pruned roster, a rebuilt
                    // hub): register again; the same secret keeps the address
                    let _ = set_registered(&engine, p.org_id, hid, None).await;
                }
            }
            kick(&engine);
            continue;
        }
        succeeded(&engine, &addr);
        wait = POLL_WAIT_S;
        let data: Value = match r.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        set_roster(&engine, &addr, data["name"].as_str(), data["version"].as_str(), data["roster"].as_array().cloned().unwrap_or_default());
        // a member the hub no longer lists was forgotten (an operator's
        // remove-address, a rebuilt hub): it registers again, as a 401 makes
        // a poll of its own do (a poll shared by several members answers 401
        // only when the hub knows none of them)
        let mut forgotten = Vec::new();
        if let Some(roster) = data["roster"].as_array().filter(|r| !r.is_empty()) {
            for (p, hid) in &members {
                if !roster.iter().any(|x| x["slug"].as_str() == Some(p.net_slug.as_str())) {
                    forgotten.push(p.org_id);
                    let _ = set_registered(&engine, p.org_id, hid, None).await;
                }
            }
        }
        if !forgotten.is_empty() {
            kick(&engine);
        }
        for (p, hid) in &members {
            if !forgotten.contains(&p.org_id) {
                set_status(&engine, p.org_id, hid, true, None);
            }
        }
        // inbound: deliver first, then acknowledge custody
        for (p, hid) in &members {
            let mine: Vec<&Value> =
                data["messages"].as_array().map(|ms| ms.iter().filter(|m| m["to"].as_str() == Some(p.net_slug.as_str())).collect()).unwrap_or_default();
            if mine.is_empty() {
                continue;
            }
            let mut ack = Vec::new();
            for m in mine {
                match deliver_inbound(&engine, p, hid, &addr, m).await {
                    Ok(Some(id)) => ack.push(id),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(org = %p.slug, error = %format!("{e:#}"), "inbound network mail could not be stored"),
                }
            }
            if !ack.is_empty() {
                let _ = HTTP
                    .post(format!("{addr}/api/ack"))
                    .timeout(Duration::from_secs(10))
                    .header("X-Org-Auth", p.auth())
                    .json(&json!({ "ids": ack }))
                    .send()
                    .await;
            }
        }
        // receipts belong to whichever member sent the message
        if let Some(recs) = data["receipts"].as_array().filter(|r| !r.is_empty()) {
            let ids: Vec<i64> = members.iter().map(|(p, _)| p.org_id).collect();
            if let Err(e) = apply_receipts(&engine, &ids, recs).await {
                tracing::warn!(error = %format!("{e:#}"), "hub receipts could not be applied");
            }
        }
    }
}

/// Store one inbound message (once) and wake the org's outside-mail holders.
/// Returns the id to acknowledge.
#[logged]
async fn deliver_inbound(engine: &Arc<Engine>, p: &Part, hub_id: &str, addr: &str, m: &Value) -> Result<Option<String>> {
    let Some(mid) = m["id"].as_str().filter(|s| !s.is_empty()) else { return Ok(None) };
    let seen = {
        let client = engine.db.get().await?;
        client
            .query_opt("SELECT 1 FROM ot.org_inbox WHERE org_id = $1 AND dir = 'in' AND net_id = $2 LIMIT 1", &[&p.org_id, &mid])
            .await?
            .is_some()
    };
    if seen {
        return Ok(Some(mid.to_string()));
    }
    let from = m["from"].as_str().unwrap_or("unknown");
    let mut body = m["body"].as_str().unwrap_or("").to_string();
    let dir = engine.cfg.path("uploads").join(&p.slug).join("@org-inbox");
    let mut attachments = Vec::new();
    // a long body (a v2 hub sends its first 20,000 characters and the whole
    // size) comes down whole: in the message up to 64 KiB, beside it as a
    // text file above that; a failed fetch is noted, never a lost message
    if let Some(total) = m["body_bytes"].as_u64() {
        let _ = std::fs::create_dir_all(&dir);
        let long: String = mid.chars().filter(|c| c.is_ascii_alphanumeric()).take(32).collect();
        match whole_body(p, addr, mid, &dir.join(format!("netbody-{long}.txt"))).await {
            Ok(WholeBody::Text(text)) => body = text,
            Ok(WholeBody::File(file)) => {
                let preview = body.rfind(CONTINUES).map_or(body.as_str(), |i| &body[..i]).to_string();
                body = format!("{preview}\n\n[this message is {total} bytes long: the whole of it is attached as message.txt]");
                attachments.push(file);
            }
            Err(e) => {
                let detail = e.downcast_ref::<reqwest::Error>().map(short_error).unwrap_or_else(|| e.to_string());
                body.push_str(&format!("\n[the rest of this message could not be fetched from the hub: {detail}]"));
            }
        }
    }
    // attachments come down into the org inbox's folder; a failed fetch is
    // noted in the body, never a lost message
    if let Some(atts) = m["attachments"].as_array().filter(|a| !a.is_empty()) {
        let _ = std::fs::create_dir_all(&dir);
        for a in atts {
            let name = a["name"].as_str().unwrap_or("file");
            let safe: String = std::path::Path::new(name).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
            let short: String = mid.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
            let path = dir.join(format!("net-{short}-{safe}"));
            let fetched: Result<u64> = async {
                let r = HTTP
                    .get(format!("{addr}/api/attachments/{}", a["id"].as_str().unwrap_or("")))
                    .timeout(FILE_TIMEOUT)
                    .header("X-Org-Auth", p.auth())
                    .send()
                    .await?
                    .error_for_status()?;
                let mut file = tokio::fs::File::create(&path).await?;
                let mut chunks = r.bytes_stream();
                let mut size = 0;
                while let Some(chunk) = chunks.next().await {
                    let chunk = chunk?;
                    file.write_all(&chunk).await?;
                    size += chunk.len() as u64;
                }
                file.flush().await?;
                Ok(size)
            }
            .await;
            match fetched {
                Ok(bytes) => {
                    attachments.push(json!({ "name": safe, "path": path.to_string_lossy(), "bytes": bytes }));
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&path).await;
                    let detail = e.downcast_ref::<reqwest::Error>().map(short_error).unwrap_or_else(|| e.to_string());
                    body.push_str(&format!("\n[attachment {name:?} could not be fetched from the hub: {detail}]"));
                }
            }
        }
    }
    if let Some(sent) = m["sent_at"].as_str().and_then(crate::util::parse_ts) {
        let age = (chrono::Utc::now() - sent).num_seconds();
        if age > STALE_AFTER_S {
            let unit = if age >= 86400 { format!("{:.1} days", age as f64 / 86400.0) } else { format!("{:.1} hours", age as f64 / 3600.0) };
            body = format!("[arrived via the mail hub — sent {}, {unit} ago; the sender may have moved on]\n\n{body}", m["sent_at"].as_str().unwrap_or(""));
        }
    }
    let reply_to = m["reply_to"].as_str().filter(|r| !r.is_empty());
    // "Chat from your phone": a setup code links the sender before the
    // agents read the message (and their charter already names it)
    crate::phone::on_inbound(engine, p.org_id, from, &body, mid).await;
    let fresh = crate::domain::orginbox::deliver_inbound(engine, p.org_id, &format!("@net:{from}"), &body, attachments, mid, hub_id, reply_to).await?;
    if fresh {
        engine.net.owed.pin().insert((p.org_id, mid.to_string(), "delivered"), addr.to_string());
    }
    Ok(Some(mid.to_string()))
}

/// Where a v1 route's long-body preview ends: the hub's own line saying how
/// long the whole message is.
const CONTINUES: &str = "\n\n[message continues: ";
/// The whole of a long body arrives in the message up to this size, and as
/// a file beside it above (an agent reads it from there).
const WHOLE_BODY_INLINE: u64 = 64 * 1024;

/// A long hub message's whole body.
#[derive(Debug)]
enum WholeBody {
    Text(String),
    File(Value),
}

/// Fetch a long message's whole body (`GET /api/messages/{id}/body`) into
/// `path`; kept there as a file when it is longer than the inline size.
#[logged]
async fn whole_body(p: &Part, addr: &str, mid: &str, path: &std::path::Path) -> Result<WholeBody> {
    // the id is the sender's: a path segment of its own, encoded
    let mut url = reqwest::Url::parse(addr)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("the hub address cannot carry a path"))?
        .pop_if_empty()
        .extend(["api", "messages", mid, "body"]);
    let r = HTTP.get(url).timeout(FILE_TIMEOUT).header("X-Org-Auth", p.auth()).send().await?.error_for_status()?;
    let mut size = 0u64;
    let written: Result<()> = async {
        let mut file = tokio::fs::File::create(path).await?;
        let mut chunks = r.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            size += chunk.len() as u64;
        }
        file.flush().await?;
        Ok(())
    }
    .await;
    if let Err(e) = written {
        let _ = tokio::fs::remove_file(path).await;
        return Err(e);
    }
    if size <= WHOLE_BODY_INLINE {
        let bytes = tokio::fs::read(path).await?;
        let _ = tokio::fs::remove_file(path).await;
        return Ok(WholeBody::Text(String::from_utf8_lossy(&bytes).into_owned()));
    }
    Ok(WholeBody::File(json!({ "name": "message.txt", "path": path.to_string_lossy(), "bytes": size })))
}

/// The hub's receipts advance our outgoing rows (never backwards).
#[logged]
async fn apply_receipts(engine: &Engine, org_ids: &[i64], recs: &[Value]) -> Result<()> {
    let client = engine.db.get().await?;
    let mut touched: HashSet<i64> = HashSet::new();
    for r in recs {
        let Some(id) = r["id"].as_str() else { continue };
        let state = match r["state"].as_str().unwrap_or("") {
            "fetched" | "received" | "sent" => "sent",
            "delivered" => "delivered",
            "read" => "read",
            _ => continue,
        };
        let rows = client
            .query(
                "UPDATE ot.org_inbox SET state = $3, state_at = now(), last_err = NULL, tries = 0
                  WHERE org_id = ANY($1) AND dir = 'out' AND net_id = $2
                    AND array_position($4::text[], coalesce(state, 'queued')) < array_position($4::text[], $3)
                 RETURNING org_id",
                &[&org_ids, &id, &state, &&STATES[..]],
            )
            .await?;
        touched.extend(rows.iter().map(|r| r.get::<_, i64>(0)));
    }
    drop(client);
    for id in touched {
        if let Some(o) = engine.orgs.by_id(id) {
            changes::notify(engine, &o, vec![Change::OrgInbox]);
        }
    }
    Ok(())
}

/// Which hub carries a message: one whose roster holds the peer, else one
/// that is connected, else the first.
#[logged]
fn pick_hub(engine: &Engine, p: &Part, peer: &str) -> Option<(String, String)> {
    let rosters = engine.net.rosters.pin();
    let holds = |addr: &str| rosters.get(addr).map(|r| r.iter().any(|x| x["slug"].as_str() == Some(peer))).unwrap_or(false);
    let status = engine.net.status.pin();
    let connected = |hid: &str| status.get(&(p.org_id, hid.to_string())).map(|s| s.connected).unwrap_or(false);
    p.hubs
        .iter()
        .find(|(_, a)| holds(a))
        .or_else(|| p.hubs.iter().find(|(id, _)| connected(id)))
        .or_else(|| p.hubs.first())
        .cloned()
}

/// Ship the queued outgoing rows.
#[logged]
async fn drain(engine: &Arc<Engine>, parts: &[Part]) -> Result<()> {
    if parts.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = parts.iter().map(|p| p.org_id).collect();
    let rows = {
        let client = engine.db.get().await?;
        client
            .query(
                "SELECT id, org_id, peer, body, at, attachments, net_id, last_err, kind, reply_to FROM ot.org_inbox
                  WHERE dir = 'out' AND state = 'queued' AND org_id = ANY($1) ORDER BY id LIMIT 100",
                &[&ids],
            )
            .await?
    };
    for r in rows {
        let row_id: i64 = r.get(0);
        let org_id: i64 = r.get(1);
        let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { continue };
        let peer = r.get::<_, String>(2).trim_start_matches("@net:").to_string();
        let last_err: Option<String> = r.get(7);
        let net_id: String = r.get::<_, Option<String>>(6).unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let Some((hid, addr)) = pick_hub(engine, p, &peer) else {
            stamp(engine, org_id, row_id, last_err.as_deref(), "no mail hub is enabled for this organization", false).await?;
            continue;
        };
        if !p.registered.contains(&hid) || backed_off(engine, &addr) {
            let why = engine
                .net
                .status
                .pin()
                .get(&(org_id, hid.clone()))
                .and_then(|s| s.error.clone())
                .unwrap_or_else(|| "connecting".into());
            stamp(engine, org_id, row_id, last_err.as_deref(), &format!("hub not reachable yet — {why}; retrying"), false).await?;
            continue;
        }
        // attachments go up first, resumably: an uploaded id is kept on the row
        let mut atts: Vec<Value> = r.get::<_, Value>(5).as_array().cloned().unwrap_or_default();
        let mut att_ids = Vec::new();
        let mut broken = None;
        let mut vanished = Vec::new();
        for a in atts.iter_mut() {
            if let Some(id) = a["hub_id"].as_str() {
                att_ids.push(id.to_string());
                continue;
            }
            let Some(path) = a["path"].as_str() else { continue };
            let file = match tokio::fs::File::open(path).await {
                Ok(d) => d,
                Err(_) => {
                    vanished.push(a["name"].as_str().unwrap_or("?").to_string());
                    *a = Value::Null;
                    continue;
                }
            };
            let bytes = file.metadata().await?.len();
            let limit = attachment_limit_at(&addr).await;
            if bytes > limit.bytes {
                broken = Some(limit.message());
                break;
            }
            let up = HTTP
                .post(format!("{addr}/api/attachments"))
                .timeout(FILE_TIMEOUT)
                .query(&[("name", a["name"].as_str().unwrap_or("file"))])
                .header("X-Org-Auth", p.auth())
                .header(reqwest::header::CONTENT_LENGTH, bytes)
                .body(reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file.take(bytes))))
                .send()
                .await;
            match up {
                Ok(resp) if resp.status().is_success() => {
                    let v: Value = resp.json().await.unwrap_or(Value::Null);
                    if let Some(id) = v["id"].as_str() {
                        a["hub_id"] = json!(id);
                        att_ids.push(id.to_string());
                    }
                }
                Ok(resp) => {
                    broken = Some(format!("attachment upload HTTP {}", resp.status().as_u16()));
                    break;
                }
                Err(e) => {
                    failed(engine, &addr);
                    broken = Some(short_error(&e));
                    break;
                }
            }
        }
        atts.retain(|a| !a.is_null());
        let client = engine.db.get().await?;
        if !vanished.is_empty() {
            client.execute("INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'net_attachment_missing', '@system', $2)",
                &[&org_id, &json!({"message": net_id, "files": vanished, "note": "Unreadable staged attachments were dropped; the message and remaining files will still be sent."})]).await?;
            client.execute("UPDATE ot.org_inbox SET last_err = $2 WHERE id = $1", &[&row_id, &format!("attachment vanished before upload: {}", vanished.join(", "))]).await?;
            changes::notify_id(engine, org_id, vec![Change::Events, Change::OrgInbox]);
        }
        client
            .execute("UPDATE ot.org_inbox SET attachments = $2, net_id = $3 WHERE id = $1", &[&row_id, &Value::Array(atts.clone()), &net_id])
            .await?;
        drop(client);
        if let Some(err) = broken {
            stamp(engine, org_id, row_id, last_err.as_deref(), &err, true).await?;
            continue;
        }
        let res = HTTP
            .post(format!("{addr}/api/send"))
            .timeout(Duration::from_secs(30))
            .header("X-Org-Auth", p.auth())
            .json(&outgoing_payload(&r, &net_id, &p.net_slug, att_ids))
            .send()
            .await;
        match res {
            Ok(resp) if resp.status().is_success() => {
                let client = engine.db.get().await?;
                client
                    .execute(
                        "UPDATE ot.org_inbox SET state = 'sent', state_at = now(), hub = $2, last_err = NULL, tries = 0 WHERE id = $1",
                        &[&row_id, &hid],
                    )
                    .await?;
                drop(client);
                set_status(engine, org_id, &hid, true, None);
                succeeded(engine, &addr);
                if let Some(o) = engine.orgs.by_id(org_id) {
                    changes::notify(engine, &o, vec![Change::OrgInbox]);
                }
            }
            Ok(resp) if resp.status().as_u16() == 401 => {
                set_registered(engine, org_id, &hid, None).await?;
                stamp(engine, org_id, row_id, last_err.as_deref(), "the hub did not recognize this organization — registering again, will retry", true).await?;
            }
            Ok(resp) if resp.status().as_u16() == 422 => {
                let detail = resp.json::<Value>().await.ok().and_then(|v| v["detail"].as_str().map(str::to_string)).unwrap_or_else(|| "unknown recipient".into());
                stamp(engine, org_id, row_id, last_err.as_deref(), &detail, true).await?;
            }
            Ok(resp) => {
                stamp(engine, org_id, row_id, last_err.as_deref(), &format!("HTTP {}", resp.status().as_u16()), true).await?;
            }
            Err(e) => {
                failed(engine, &addr);
                set_status(engine, org_id, &hid, false, Some(short_error(&e)));
                stamp(engine, org_id, row_id, last_err.as_deref(), &short_error(&e), true).await?;
            }
        }
    }
    Ok(())
}

/// The exact hub wire payload, shared with the isolated engine proof.
#[logged]
fn outgoing_payload(row: &tokio_postgres::Row, net_id: &str, from: &str, attachments: Vec<String>) -> Value {
    let at: chrono::DateTime<chrono::Utc> = row.get(4);
    let mut payload = json!({ "id": net_id, "to": row.get::<_, String>(2).trim_start_matches("@net:"),
        "body": row.get::<_, String>(3), "kind": row.get::<_, String>(8),
        "sent_at": crate::util::iso(at), "from": from, "attachments": attachments });
    // a reply names the hub id of the message it answers (when that came
    // over a hub); the hub carries it to the recipient
    if let Some(answers) = row.get::<_, Option<Value>>(9).as_ref().and_then(|q| q["net_id"].as_str()) {
        payload["reply_to"] = json!(answers);
    }
    payload
}

/// Note why an outgoing row is still queued (a `try` counts an attempt;
/// a skip only says why). Written only when the reason changes or a try ran.
#[logged]
async fn stamp(engine: &Engine, org_id: i64, row_id: i64, prev: Option<&str>, err: &str, tried: bool) -> Result<()> {
    let err = crate::util::gist(err, 200);
    if !tried && prev == Some(err.as_str()) {
        return Ok(());
    }
    let client = engine.db.get().await?;
    client
        .execute(
            "UPDATE ot.org_inbox SET last_err = $2, tries = tries + CASE WHEN $3 THEN 1 ELSE 0 END WHERE id = $1",
            &[&row_id, &err, &tried],
        )
        .await?;
    drop(client);
    if let Some(o) = engine.orgs.by_id(org_id) {
        changes::notify(engine, &o, vec![Change::OrgInbox]);
    }
    Ok(())
}

/// Send the delivered/read receipts we owe (best effort: a failure keeps them).
#[logged]
async fn flush_receipts(engine: &Engine, parts: &[Part]) {
    {
        let pending = engine.net.read_owed.pin();
        let owed = engine.net.owed.pin();
        for ((org, mid), hub) in pending.iter() {
            if let Some(addr) = parts.iter().find(|p| p.org_id == *org)
                .and_then(|p| p.hubs.iter().find(|(id, _)| id == hub).map(|(_, addr)| addr)) {
                owed.insert((*org, mid.clone(), "read"), addr.clone());
                pending.remove(&(*org, mid.clone()));
            }
        }
    }
    let owed: Vec<((i64, String, &'static str), String)> = engine.net.owed.pin().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    if owed.is_empty() {
        return;
    }
    let mut by_dest: std::collections::HashMap<(i64, String), Vec<(String, &'static str)>> = std::collections::HashMap::new();
    for ((org, mid, state), addr) in owed {
        by_dest.entry((org, addr)).or_default().push((mid, state));
    }
    for ((org, addr), recs) in by_dest {
        let Some(p) = parts.iter().find(|p| p.org_id == org) else {
            for (mid, st) in recs {
                engine.net.owed.pin().remove(&(org, mid, st));
            }
            continue;
        };
        let body: Vec<Value> = recs.iter().map(|(mid, st)| json!({ "id": mid, "state": st, "at": now_iso() })).collect();
        let ok = HTTP
            .post(format!("{addr}/api/receipts"))
            .timeout(Duration::from_secs(10))
            .header("X-Org-Auth", p.auth())
            .json(&json!({ "receipts": body }))
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().as_u16() == 401)
            .unwrap_or(false);
        if ok {
            let map = engine.net.owed.pin();
            for (mid, st) in recs {
                map.remove(&(org, mid, st));
            }
        }
    }
}

/// An agent delivery was positively acknowledged: tell the originating hub.
/// Human inbox read state never calls this. Startup repair can queue before
/// the hub participants exist; the sender resolves those hub ids later.
#[logged]
pub fn note_read(engine: &Engine, org_id: i64, read: &[(String, String)]) {
    let owed = engine.net.read_owed.pin();
    for (mid, hub) in read {
        owed.insert((org_id, mid.clone()), hub.clone());
    }
    drop(owed);
    kick(engine);
}

// ------------------------------------------------------------ sending

/// Queue one `@net:` message from the org inbox (the send itself is the
/// sender's job). Refuses when no hub is enabled or no hub knows the peer.
/// `reply_to` is the quote of the message it answers (its `net_id` rides
/// the payload).
#[allow(clippy::too_many_arguments)]
#[logged]
pub async fn queue(
    engine: &Arc<Engine>,
    org_id: i64,
    peer: &str,
    body: &str,
    by: &str,
    kind: &str,
    attachments: &[Value],
    reply_to: Option<&Value>,
) -> Result<(String, String)> {
    if offline() {
        crate::refuse!(Unprocessable, "network mail (@net:) is paused for this run (the engine started in safe start)");
    }
    let peer = peer.trim().trim_start_matches("@net:").trim();
    if peer.is_empty() {
        crate::refuse!(BadRequest, "@net: needs the recipient's network address (orgtree_list_orgs lists the known ones)");
    }
    let Some(org) = engine.orgs.by_id(org_id) else { crate::refuse!(NotFound, "organization not open") };
    let net = ensure_identity(engine, org_id, &org.slug).await?;
    let enabled = net["hubs"].as_array().map(|hs| hs.iter().any(|h| h["enabled"].as_bool().unwrap_or(true))).unwrap_or(false);
    if !enabled {
        crate::refuse!(
            Unprocessable,
            "no mail hub is enabled for this organization — enable one in its settings (Connections) before writing to @net: addresses"
        );
    }
    if !knows_peer(engine, org_id, peer).await {
        crate::refuse!(
            Unprocessable,
            "no organization @net:{peer} is registered on any hub this organization uses (a new registration appears within a minute; orgtree_list_orgs lists the known ones)"
        );
    }
    if !attachments.is_empty() {
        let limit = attachment_limit(engine, org_id, peer).await?;
        for a in attachments { limit.check(a["bytes"].as_u64().unwrap_or(0))?; }
        limit.check_message(body.len() as u64, attachments.iter().map(|a| a["bytes"].as_u64().unwrap_or(0)).sum())?;
    }
    queue_row(engine, org_id, peer, body, by, kind, attachments, reply_to).await
}

/// Persist only; callers perform the transport/audience checks first.
#[allow(clippy::too_many_arguments)]
#[logged]
async fn queue_row(
    engine: &Engine,
    org_id: i64,
    peer: &str,
    body: &str,
    by: &str,
    kind: &str,
    attachments: &[Value],
    reply_to: Option<&Value>,
) -> Result<(String, String)> {
    let uid = crate::util::uid("x");
    let net_id = uuid::Uuid::new_v4().simple().to_string();
    let to = format!("@net:{peer}");
    let reply = reply_to.map(|r| crate::util::pg_json(r).into_owned());
    let client = engine.db.get().await?;
    client
        .execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, net_id, attachments, kind, reply_to)
             VALUES ($1, $2, 'out', $3, $4, $5, 'queued', now(), $6, $7, $8, $9)",
            &[&uid, &org_id, &to, &crate::util::pg_text(body).as_ref(), &by, &net_id, &crate::util::pg_json(&Value::Array(attachments.to_vec())).as_ref(), &kind, &reply],
        )
        .await?;
    drop(client);
    kick(engine);
    Ok((uid, to))
}

/// Focused rig check: no identity registration, listener or network request.
#[cfg(debug_assertions)]
#[logged]
pub async fn rig_outgoing(engine: &Engine, org_id: i64, kind: &str) -> Result<Value> {
    anyhow::ensure!(crate::rig::active(), "rig mode required");
    let (uid, _) = queue_row(engine, org_id, "peer.rig", "payload proof", "agent", kind, &[], None).await?;
    let client = engine.db.get().await?;
    let row = client.query_one(
        "SELECT id,org_id,peer,body,at,attachments,net_id,last_err,kind,reply_to FROM ot.org_inbox WHERE uid=$1", &[&uid],
    ).await?;
    Ok(outgoing_payload(&row, &row.get::<_, String>(6), "sender.rig", vec![]))
}

#[cfg(debug_assertions)]
#[logged]
pub fn rig_read_receipts(engine: &Engine, org_id: i64) -> Value {
    let pending = engine.net.read_owed.pin();
    json!(pending.iter().filter(|((org, _), _)| *org == org_id)
        .map(|((_, mid), hub)| json!({"id":mid,"hub":hub,"state":"read"})).collect::<Vec<_>>())
}

/// Is `peer` on a roster this org can reach? The cache answers first; a
/// miss asks each of the org's hubs once.
#[logged]
async fn knows_peer(engine: &Engine, org_id: i64, peer: &str) -> bool {
    if engine.net.rosters.pin().iter().any(|(_, r)| r.iter().any(|x| x["slug"].as_str() == Some(peer))) {
        return true;
    }
    let parts = engine.net.parts.load_full();
    let Some(p) = parts.iter().find(|p| p.org_id == org_id) else { return false };
    for (hid, addr) in &p.hubs {
        if !p.registered.contains(hid) {
            continue;
        }
        let Ok(r) = HTTP.get(format!("{addr}/api/roster")).timeout(Duration::from_secs(5)).header("X-Org-Auth", p.auth()).send().await else {
            continue;
        };
        let Ok(v) = r.json::<Value>().await else { continue };
        let roster = v["roster"].as_array().cloned().unwrap_or_default();
        let found = roster.iter().any(|x| x["slug"].as_str() == Some(peer));
        set_roster(engine, addr, v["name"].as_str(), v["version"].as_str(), roster);
        if found {
            return true;
        }
    }
    false
}

/// This machine's own hub's roster, read now as `org_id` (registered there),
/// with the hub's name: the phone panel's "Is this you?" and the name of a
/// person who links. None when the org is not on the local hub.
#[logged]
pub async fn local_roster(engine: &Engine, org_id: i64) -> Option<(Vec<Value>, Option<String>)> {
    let local = engine.hub.address.load_full()?;
    let parts = engine.net.parts.load_full();
    let p = parts.iter().find(|p| p.org_id == org_id)?;
    let (_, addr) = p.hubs.iter().find(|(hid, addr)| p.registered.contains(hid) && normalize_address(addr) == normalize_address(&local))?;
    let r = HTTP.get(format!("{addr}/api/roster")).timeout(Duration::from_secs(5)).header("X-Org-Auth", p.auth()).send().await.ok()?;
    let v = r.json::<Value>().await.ok()?;
    let roster = v["roster"].as_array().cloned().unwrap_or_default();
    set_roster(engine, addr, v["name"].as_str(), v["version"].as_str(), roster.clone());
    Some((roster, v["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string)))
}

/// Every remote org the rosters know (for `orgtree_list_orgs`), with the
/// hubs it is reached through: each hub's address, name and version
/// ("unknown" for a hub that reports none).
#[logged]
pub fn remote_peers(engine: &Engine) -> Vec<Value> {
    let names = engine.net.names.pin();
    let versions = engine.net.versions.pin();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut out: Vec<Value> = Vec::new();
    for (addr, roster) in engine.net.rosters.pin().iter() {
        let hub = json!({ "address": addr, "name": names.get(addr), "version": versions.get(addr).map_or("unknown", String::as_str) });
        for r in roster.iter() {
            let Some(s) = r["slug"].as_str() else { continue };
            if s.is_empty() {
                continue;
            }
            if let Some(&i) = seen.get(s) {
                if let Some(hubs) = out[i]["hubs"].as_array_mut() {
                    hubs.push(hub.clone());
                }
                continue;
            }
            seen.insert(s.to_string(), out.len());
            out.push(json!({ "slug": format!("@net:{s}"), "address": format!("@net:{s}"), "name": r["org_name"].as_str().filter(|n| !n.is_empty()).unwrap_or(s),
                             "online": r["online"].as_bool().unwrap_or(false), "last_seen": r["last_seen"],
                             "kind": r["kind"].as_str().unwrap_or("org"), "blurb": r["blurb"].as_str().unwrap_or(""),
                             "hubs": [hub.clone()] }));
        }
    }
    out
}

/// Called only after an internal agent failed to match. Local exact slugs
/// outrank hub full slugs or leading name segments, as in 3.x.
#[logged]
pub fn resolve_bare(name: &str, local: bool, peers: &[Value]) -> Result<Option<String>> {
    if name.is_empty() || name.starts_with('@') { return Ok(None); }
    if local { return Ok(Some(format!("@org:{name}"))); }
    let mut candidates = std::collections::BTreeSet::new();
    for peer in peers {
        let slug = peer["slug"].as_str().unwrap_or("").trim_start_matches("@net:");
        if !slug.is_empty() && (slug == name || slug.split('.').next() == Some(name)) {
            candidates.insert(format!("@net:{slug}"));
        }
    }
    if candidates.len() > 1 {
        crate::refuse!(BadRequest, "'{name}' is ambiguous — it could be any of: {}. Address the full form to pick one.", candidates.into_iter().collect::<Vec<_>>().join(", "));
    }
    Ok(candidates.into_iter().next())
}

/// The same public local identities and cached roster used by bare-name sends.
/// Keep `remote` as a 4.0 alias, while restoring 3.x's combined `orgs` list.
#[logged]
pub fn discovery_rows(current: &str, locals: &[(String, String, Option<String>)], mut peers: Vec<Value>) -> Value {
    let roster: HashSet<String> = peers.iter().filter_map(|p| p["slug"].as_str()).map(|s| s.trim_start_matches("@net:").to_string()).collect();
    let local_net: HashSet<&str> = locals.iter().filter_map(|(_, _, net)| net.as_deref()).collect();
    for peer in &mut peers {
        let slug = peer["slug"].as_str().unwrap_or("").trim_start_matches("@net:");
        peer["transports"] = if local_net.contains(slug) { json!(["org", "net"]) } else { json!(["net"]) };
    }
    let mut orgs: Vec<Value> = locals.iter().map(|(slug, name, net)| {
        let transports = if net.as_ref().map(|n| roster.contains(n)).unwrap_or(false) { json!(["org", "net"]) } else { json!(["org"]) };
        json!({"slug":slug,"name":name,"you":slug == current,"address":format!("@org:{slug}"),"transports":transports})
    }).collect();
    orgs.extend(peers.iter().cloned());
    json!({"orgs":orgs,"remote":peers})
}

// ------------------------------------------------------------ what the UI reads

/// The org's `net` record: configuration and live status — never the secret.
#[logged]
pub async fn block(engine: &Engine, client: &tokio_postgres::Client, org: &Value) -> Result<Value> {
    let net = &org["net"];
    let hubs = net["hubs"].as_array().cloned().unwrap_or_default();
    if hubs.is_empty() && net.get("identity").map(|i| i.is_null()).unwrap_or(true) {
        return Ok(Value::Null);
    }
    let org_id = org["id"].as_i64().unwrap_or(0);
    let own = net.pointer("/identity/slug").and_then(Value::as_str).unwrap_or("").to_string();
    let q = client
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE last_err IS NOT NULL),
                    (array_agg(last_err ORDER BY tries DESC) FILTER (WHERE last_err IS NOT NULL))[1]
               FROM ot.org_inbox WHERE org_id = $1 AND dir = 'out' AND state = 'queued'",
            &[&org_id],
        )
        .await?;
    let (queued, stuck, stuck_err): (i64, i64, Option<String>) = (q.get(0), q.get(1), q.get(2));
    let state = net["state"].clone();
    let status = engine.net.status.pin();
    let rosters = engine.net.rosters.pin();
    let names = engine.net.names.pin();
    let versions = engine.net.versions.pin();
    let first_enabled = hubs.iter().position(|h| h["enabled"].as_bool().unwrap_or(true));
    let out: Vec<Value> = hubs
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let id = h["id"].as_str().unwrap_or("").to_string();
            let addr = normalize_address(h["address"].as_str().unwrap_or(""));
            let st = status.get(&(org_id, id.clone())).cloned().unwrap_or_default();
            let registered = state[&id]["registered_at"].is_string() && state[&id]["address"].as_str() == Some(addr.as_str());
            let roster: Vec<Value> = rosters
                .get(&addr)
                .map(|r| r.iter().filter(|x| x["slug"].as_str() != Some(own.as_str())).cloned().collect())
                .unwrap_or_default();
            let mine = Some(i) == first_enabled;
            let mut v = json!({
                "id": id, "address": h["address"], "enabled": h["enabled"].as_bool().unwrap_or(true),
                "name": h["name"].as_str().map(str::to_string).or_else(|| names.get(&addr).cloned()),
                // the version the hub reports; none from a v1 hub
                "version": versions.get(&addr).cloned(),
                "connected": st.connected,
                // the implicit local hub stays out of sight until it has answered once
                "hidden": id == LOCAL_HUB_ID && !(st.connected || registered),
                "last_ok": st.last_ok, "error": st.error,
                "queued": if mine { queued } else { 0 },
                "roster": roster,
            });
            if mine && stuck > 0 {
                v["stuck"] = json!(stuck);
                v["stuck_err"] = json!(stuck_err);
            }
            v
        })
        .collect();
    Ok(json!({ "slug": if own.is_empty() { Value::Null } else { json!(own) }, "hubs": out }))
}

/// `GET /api/orgs/{slug}/net`: the identity, secret included (the settings
/// panel's reveal/export: the one place the secret is returned).
#[logged]
pub async fn reveal(engine: &Engine, org_id: i64, org_slug: &str) -> Result<Value> {
    let net = ensure_identity(engine, org_id, org_slug).await?;
    Ok(json!({ "identity": net["identity"], "hubs": net["hubs"].as_array().cloned().unwrap_or_default(),
               "autoconnect": net["autoconnect"].as_bool().unwrap_or(true) }))
}

/// `GET /api/net/probe`: does a hub answer at this address right now? (a hint)
#[logged]
pub async fn probe(engine: &Engine, address: &str) -> Value {
    let addr = if address.trim().is_empty() { DEFAULT_HUB_ADDRESS.to_string() } else { normalize_address(address) };
    // a rig run asks no hub but the one it hosts
    if crate::rig::active() && !(crate::rig::hub() && engine.hub.address.load_full().as_deref() == Some(&addr)) {
        return json!({ "ok": false });
    }
    match crate::mailhub::healthz(&addr, Duration::from_secs(2)).await {
        Some(h) => json!({ "ok": true, "name": h["name"], "version": h["version"] }),
        None => json!({ "ok": false }),
    }
}

/// A deleted org leaves every hub it was on (best effort; a hub that is down
/// forgets it after its own retention).
#[logged]
pub fn unregister(engine: &Engine, net: Value) {
    if offline() {
        return;
    }
    let (Some(slug), Some(secret)) = (net.pointer("/identity/slug").and_then(Value::as_str), net.pointer("/identity/secret").and_then(Value::as_str))
    else {
        return;
    };
    let auth = format!("{slug}:{secret}");
    let mut addrs: Vec<String> = net["hubs"]
        .as_array()
        .map(|hs| hs.iter().filter(|h| h["enabled"].as_bool().unwrap_or(true)).filter_map(|h| h["address"].as_str().map(normalize_address)).collect())
        .unwrap_or_default();
    // a rig run reaches the hub it hosts, never another
    if crate::rig::hub() {
        let hosted = engine.hub.address.load_full();
        addrs.retain(|a| hosted.as_deref() == Some(a));
    }
    tokio::spawn(async move {
        for addr in addrs {
            let _ = HTTP.post(format!("{addr}/api/unregister")).timeout(Duration::from_secs(4)).header("X-Org-Auth", auth.clone()).json(&json!({})).send().await;
        }
    });
}
