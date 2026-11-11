//! Remote engines (docs/rust-engine/remote-org.md): this engine as the relay
//! between the desktop's windows and organizations that run on a standalone
//! (headless) engine elsewhere.
//!
//! - `store`: the saved connections and their sealed tokens.
//! - `handshake`: the checks before a token is trusted to an address.
//! - `link`: one task per connection; it keeps the remote's app feed open,
//!   mirrors its org list into this engine's list, and owns the state.
//! - `routes`, `relay`, `socket`: which requests belong to a remote engine,
//!   and how they and the org socket are carried there.
//! - `api`: `/api/remotes`, the desktop's management routes.
//!
//! The remote token never leaves this module: no route answers it, the
//! renderer and Electron main never hold it, and nothing here logs it.

pub mod address;
pub mod api;
pub mod handshake;
pub mod link;
pub mod relay;
pub mod routes;
pub mod socket;
pub mod store;
pub mod text;
mod wsdial;

#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use arc_swap::{ArcSwap, ArcSwapOption};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio::sync::{watch, Notify, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;
use crate::mqtt::seal;
use address::{Address, Transport};
use store::{SavedOrg, SavedRemote, Token};

/// The header Electron main adds to every request of a window that is bound
/// to an organization of a remote engine: that engine's local id.
pub const HEADER: &str = "x-orgtree-remote";
/// The oldest remote engine this app talks to: 4.5.11, the first release
/// with an official standalone build. Raise it in the release that breaks an
/// older engine's wire contract.
pub const REMOTE_MIN_ENGINE: (u64, u64, u64) = (4, 5, 11);
/// Relayed requests in flight per connection; the next one waits.
pub const INFLIGHT_MAX: usize = 64;

/// The clocks of a connection. Tests shorten them; nothing else changes them.
#[derive(Clone, Debug)]
pub struct Timing {
    /// One handshake request.
    pub request: Duration,
    /// TCP and TLS.
    pub connect: Duration,
    /// Reconnect waits: `net_first` doubled per failure up to `net_max`,
    /// starting over after `stable` connected.
    pub net_first: Duration,
    pub net_max: Duration,
    pub stable: Duration,
    /// The wait between tries while the remote refuses the token.
    pub auth_retry: Duration,
    /// A ping this often; nothing heard for `dead` means the link is gone.
    pub ping: Duration,
    pub dead: Duration,
    pub jitter: bool,
    /// How long a relayed request waits for a free slot.
    pub inflight_wait: Duration,
    /// Two relayed requests failing within this window end the link.
    pub failure_window: Duration,
    /// Frames that may wait for a window on a relayed org socket: the org
    /// socket's own bound (`feed/socket.rs`).
    pub socket_queue: usize,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            request: Duration::from_secs(10),
            connect: Duration::from_secs(10),
            net_first: Duration::from_secs(1),
            net_max: Duration::from_secs(30),
            stable: Duration::from_secs(60),
            auth_retry: Duration::from_secs(300),
            ping: Duration::from_secs(15),
            dead: Duration::from_secs(45),
            jitter: true,
            inflight_wait: Duration::from_secs(5),
            failure_window: Duration::from_secs(10),
            socket_queue: 8192,
        }
    }
}

/// Where a connection stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    Connected,
    Offline,
    AuthFailed,
    Refused,
    Paused,
}

#[logged]
impl Phase {
    #[nolog]
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Connecting => "connecting",
            Phase::Connected => "connected",
            Phase::Offline => "offline",
            Phase::AuthFailed => "auth_failed",
            Phase::Refused => "refused",
            Phase::Paused => "paused",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LinkState {
    pub phase: Phase,
    pub since: DateTime<Utc>,
    pub next_attempt_at: Option<DateTime<Utc>>,
    /// The sentence to show, and its id in the text table (`E7`...).
    pub error: Option<String>,
    pub code: Option<&'static str>,
    pub version: Option<String>,
    pub transport: Option<Transport>,
}

/// Why something about a remote engine was refused: the text to show, its id
/// in the text table, and what kind of failure it is.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub kind: Kind,
    pub code: &'static str,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// What the user typed cannot be used.
    Input,
    /// Not reachable: worth trying again.
    Offline,
    /// The remote does not accept the token.
    Auth,
    /// The remote is not one this app may connect to.
    Refused,
    /// This computer could not keep the connection.
    Storage,
    /// No such connection.
    Missing,
}

#[logged]
impl Refusal {
    #[nolog]
    pub fn new(kind: Kind, code: &'static str, text: impl Into<String>) -> Refusal {
        Refusal { kind, code, text: text.into() }
    }
    #[nolog]
    pub fn input(code: &'static str, text: impl Into<String>) -> Refusal {
        Refusal::new(Kind::Input, code, text)
    }
}

/// The live connection: where it dials and the client that does. The
/// addresses are the ones the address rule passed at this connect.
pub struct Conn {
    pub address: Address,
    pub addrs: Vec<SocketAddr>,
    pub http: reqwest::Client,
}

/// One organization of a remote engine as this engine's list shows it.
#[derive(Clone, PartialEq)]
pub struct Row {
    pub local_id: i64,
    pub org_uuid: String,
    /// The registry record: `slug` is the alias; `remote` says whose it is.
    pub registry: Value,
    pub summary: Value,
    pub working: i64,
}

/// One remote engine. It lives as long as its connection is saved; what the
/// user can change (`saved`) and what the link learns are swapped in whole.
pub struct Remote {
    pub id: String,
    saved: ArcSwap<SavedRemote>,
    token: ArcSwap<Token>,
    state: watch::Sender<LinkState>,
    conn: ArcSwapOption<Conn>,
    /// The remote process last seen (`X-Orgtree-Instance`), empty before any.
    boot: ArcSwap<String>,
    /// The rows last handed to the app feed.
    rows: ArcSwap<Vec<Row>>,
    pub inflight: Arc<Semaphore>,
    failures: Mutex<Vec<Instant>>,
    /// Try now: the user asked, or the saved connection changed.
    pub wake: Notify,
    /// Relayed requests say the link is gone.
    pub lost: Notify,
    /// The connection was removed: its link and its sockets end.
    pub stop: CancellationToken,
}

#[logged]
impl Remote {
    #[nolog]
    fn new(saved: SavedRemote, token: Token, phase: Phase) -> Arc<Remote> {
        let boot = saved.last_boot_id.clone().unwrap_or_default();
        let (state, _) = watch::channel(LinkState { phase, since: Utc::now(), next_attempt_at: None, error: None, code: None,
            version: saved.last_version.clone(), transport: None });
        Arc::new(Remote {
            id: saved.id.clone(),
            saved: ArcSwap::from_pointee(saved),
            token: ArcSwap::from_pointee(token),
            state,
            conn: ArcSwapOption::empty(),
            boot: ArcSwap::from_pointee(boot),
            rows: ArcSwap::from_pointee(Vec::new()),
            inflight: Arc::new(Semaphore::new(INFLIGHT_MAX)),
            failures: Mutex::new(Vec::new()),
            wake: Notify::new(),
            lost: Notify::new(),
            stop: CancellationToken::new(),
        })
    }

    #[nolog]
    pub fn saved(&self) -> Arc<SavedRemote> {
        self.saved.load_full()
    }
    #[nolog]
    pub fn name(&self) -> String {
        self.saved.load().name.clone()
    }
    #[nolog]
    pub fn tag(&self) -> String {
        self.saved.load().tag.clone()
    }
    #[nolog]
    pub fn token(&self) -> Arc<Token> {
        self.token.load_full()
    }
    #[nolog]
    pub fn state(&self) -> LinkState {
        self.state.borrow().clone()
    }
    #[nolog]
    pub fn phase(&self) -> Phase {
        self.state.borrow().phase
    }
    #[nolog]
    pub fn watch(&self) -> watch::Receiver<LinkState> {
        self.state.subscribe()
    }
    /// The live connection, only while the link is connected.
    #[nolog]
    pub fn conn(&self) -> Option<Arc<Conn>> {
        if self.phase() == Phase::Connected { self.conn.load_full() } else { None }
    }
    #[nolog]
    pub fn boot(&self) -> Arc<String> {
        self.boot.load_full()
    }
    /// The remote process answered: remember which one.
    #[nolog]
    pub fn note_boot(&self, id: &str) -> bool {
        if id.is_empty() || id.len() > 200 || **self.boot.load() == id {
            return false;
        }
        self.boot.store(Arc::new(id.to_string()));
        true
    }
    #[nolog]
    pub fn rows(&self) -> Arc<Vec<Row>> {
        self.rows.load_full()
    }
    /// The remote slug of an organization this desktop calls `alias`.
    #[nolog]
    pub fn remote_slug(&self, alias: &str) -> Option<String> {
        self.saved.load().orgs.iter().find(|o| o.alias == alias).map(|o| o.remote_slug.clone())
    }
    /// Is `slug` an organization on this remote engine, by its name there?
    #[nolog]
    pub fn has_remote_slug(&self, slug: &str) -> bool {
        self.saved.load().orgs.iter().any(|o| o.remote_slug == slug)
    }

    /// A relayed request could not be carried. Two within the window mean
    /// the link is gone, whatever its socket still believes.
    #[nolog]
    pub fn relay_failed(&self, window: Duration) {
        let now = Instant::now();
        let gone = {
            let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
            failures.retain(|at| now.duration_since(*at) < window);
            failures.push(now);
            if failures.len() >= 2 {
                failures.clear();
                true
            } else {
                false
            }
        };
        if gone {
            self.lost.notify_one();
        }
    }

    /// A new state; `since` moves only when the phase does.
    #[nolog]
    pub(crate) fn set_state(&self, mut next: LinkState) {
        self.state.send_modify(|current| {
            if current.phase == next.phase {
                next.since = current.since;
            }
            *current = next;
        });
    }

    /// What Connection details shows. Never the token.
    #[nolog]
    pub fn view(&self) -> Value {
        let saved = self.saved.load();
        let state = self.state.borrow().clone();
        let app = env!("CARGO_PKG_VERSION");
        json!({
            "id": saved.id, "name": saved.name, "tag": saved.tag, "url": saved.url, "enabled": saved.enabled,
            "state": state.phase.as_str(), "since": crate::util::iso(state.since),
            "next_attempt_at": state.next_attempt_at.map(crate::util::iso),
            "version": state.version, "app_version": app,
            "version_differs": state.version.as_deref().is_some_and(|v| v != app),
            "transport": state.transport.map(Transport::as_str),
            "client_name": saved.client_name, "own_token": saved.client_id.is_some(),
            "last_error": state.error, "error_code": state.code,
            "last_connected_at": saved.last_connected_at,
            "orgs": saved.orgs.iter().map(|o| json!({ "alias": o.alias, "remote_slug": o.remote_slug, "name": o.name,
                "local_id": o.local_id, "gone": o.gone_at.is_some() })).collect::<Vec<_>>(),
        })
    }
}

/// The connections as one immutable picture: what the request path reads.
#[derive(Default)]
pub struct Directory {
    /// In the order they were added.
    pub remotes: Vec<Arc<Remote>>,
    by_id: HashMap<String, Arc<Remote>>,
    /// alias -> (its remote engine, its slug there). Gone organizations stay:
    /// their alias is reserved while the connection exists.
    by_alias: HashMap<String, (Arc<Remote>, String)>,
    next_local_id: i64,
}

#[logged]
impl Directory {
    #[nolog]
    fn build(remotes: Vec<Arc<Remote>>, next_local_id: i64) -> Directory {
        let mut by_id = HashMap::new();
        let mut by_alias = HashMap::new();
        for remote in &remotes {
            by_id.insert(remote.id.clone(), remote.clone());
            for org in &remote.saved.load().orgs {
                by_alias.insert(org.alias.clone(), (remote.clone(), org.remote_slug.clone()));
            }
        }
        Directory { remotes, by_id, by_alias, next_local_id }
    }
    #[nolog]
    pub fn get(&self, id: &str) -> Option<Arc<Remote>> {
        self.by_id.get(id).cloned()
    }
    #[nolog]
    pub fn alias(&self, slug: &str) -> Option<(Arc<Remote>, String)> {
        self.by_alias.get(slug).cloned()
    }
    #[nolog]
    pub fn is_empty(&self) -> bool {
        self.remotes.is_empty()
    }
}

/// What the user typed into Add a remote engine.
pub struct AddInput {
    pub url: String,
    pub token: Token,
    pub name: Option<String>,
}

/// A change to a saved connection; absent fields stay.
#[derive(Default)]
pub struct Patch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub token: Option<Token>,
    pub url: Option<String>,
}

/// One organization as the remote's app feed lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct OrgSeen {
    pub remote_slug: String,
    pub org_uuid: String,
    pub name: String,
    pub summary: Option<Value>,
}

/// Every remote engine of this desktop. Reads are lock-free (`dir`); one
/// writer at a time changes the file and the directory together.
pub struct Remotes {
    path: PathBuf,
    secrets: PathBuf,
    /// Off for an engine with no data folder. A standalone engine has no
    /// remote engines either (no chained relays): callers ask `usable_on`.
    active: bool,
    /// Why the saved connections cannot be used; they are then left alone.
    broken: Option<String>,
    key: OnceLock<Result<Arc<seal::Key>, String>>,
    dir: ArcSwap<Directory>,
    write: tokio::sync::Mutex<()>,
    timing: ArcSwap<Timing>,
    /// This computer's name, for the client token it makes on a remote.
    computer: String,
}

#[logged]
impl Remotes {
    /// The saved connections of this data folder. A file that cannot be used
    /// leaves the list empty and refuses changes: it is never overwritten.
    #[nolog]
    pub fn open(data_root: &Path) -> Remotes {
        let active = !data_root.as_os_str().is_empty();
        let path = data_root.join(store::FILE);
        let secrets = data_root.join(store::SECRETS_DIR);
        let mut remotes = Remotes {
            path, secrets, active, broken: None, key: OnceLock::new(), dir: ArcSwap::from_pointee(Directory::default()),
            write: tokio::sync::Mutex::new(()), timing: ArcSwap::from_pointee(Timing::default()), computer: computer_name(),
        };
        if !active {
            return remotes;
        }
        match store::load(&remotes.path) {
            Ok((saved, next_local_id)) => {
                let live: Vec<Arc<Remote>> = saved
                    .into_iter()
                    .map(|row| {
                        let token = remotes.key().and_then(|key| store::open_token(&key, &row.id, &row.sealed_token));
                        let phase = if row.enabled { Phase::Connecting } else { Phase::Paused };
                        match token {
                            Ok(token) => Remote::new(row, token, phase),
                            Err(why) => {
                                tracing::warn!(remote = %row.id, error = %why, "a remote engine's saved token could not be opened");
                                Remote::new(row, Token::new(""), phase)
                            }
                        }
                    })
                    .collect();
                remotes.dir.store(Arc::new(Directory::build(live, next_local_id)));
            }
            Err(why) => {
                tracing::error!(error = %why, "the saved remote engines could not be read; they are left as they are");
                remotes.broken = Some(why);
            }
        }
        remotes
    }

    /// Does this engine relay to remote engines at all? Never a standalone one.
    #[nolog]
    pub fn active(&self, engine: &Engine) -> bool {
        self.active && !engine.cfg.standalone
    }
    #[nolog]
    pub fn directory(&self) -> Arc<Directory> {
        self.dir.load_full()
    }
    #[nolog]
    pub fn get(&self, id: &str) -> Option<Arc<Remote>> {
        self.dir.load().get(id)
    }
    #[nolog]
    pub fn timing(&self) -> Arc<Timing> {
        self.timing.load_full()
    }
    #[cfg(test)]
    #[nolog]
    pub fn set_timing(&self, timing: Timing) {
        self.timing.store(Arc::new(timing));
    }
    /// The remote engine whose organization holds `slug` as its alias here.
    #[nolog]
    pub fn alias_holder(&self, slug: &str) -> Option<String> {
        self.dir.load().alias(slug).map(|(remote, _)| remote.name())
    }

    #[nolog]
    fn key(&self) -> Result<Arc<seal::Key>, String> {
        self.key.get_or_init(|| seal::load_or_create(&self.secrets).map(Arc::new)).clone()
    }

    #[nolog]
    fn usable(&self) -> Result<(), Refusal> {
        if !self.active {
            return Err(Refusal::new(Kind::Missing, "", text::STANDALONE));
        }
        match &self.broken {
            Some(why) => Err(Refusal::new(Kind::Storage, "E15", text::e15(why))),
            None => Ok(()),
        }
    }

    /// Write the file for `next` and make it the directory. The caller holds `write`.
    #[nolog]
    fn commit(&self, next: Directory) -> Result<(), Refusal> {
        let rows: Vec<SavedRemote> = next.remotes.iter().map(|remote| (*remote.saved()).clone()).collect();
        store::save(&self.path, &rows, next.next_local_id).map_err(|e| Refusal::new(Kind::Storage, "E15", text::e15(&e.to_string())))?;
        self.dir.store(Arc::new(next));
        Ok(())
    }

    /// The list every app socket carries as the value `remotes`, and what
    /// `GET /api/remotes` answers. No secret is in it.
    #[nolog]
    pub fn views(&self) -> Value {
        Value::Array(self.dir.load().remotes.iter().map(|remote| remote.view()).collect())
    }

    /// Tell every window what the connections are now.
    #[nolog]
    pub fn publish(&self, engine: &Engine) {
        if self.active(engine) {
            engine.app.set_value("remotes", self.views());
        }
    }

    /// Add a remote engine: the handshake, this desktop's own client token,
    /// the sealed save, then the link starts.
    #[nolog]
    pub async fn add(&self, engine: &Arc<Engine>, input: AddInput) -> Result<Arc<Remote>, Refusal> {
        self.usable()?;
        let address = Address::parse(&input.url).map_err(|e| Refusal::input("E1", e))?;
        if input.token.is_empty() {
            return Err(Refusal::input("", text::TOKEN_MISSING));
        }
        let wanted = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
        if wanted.as_deref().is_some_and(|n| !store::valid_name(n)) {
            return Err(Refusal::input("", "The name can have up to 100 characters."));
        }
        let name = wanted.unwrap_or_else(|| address.host.clone());
        let timing = self.timing();
        let probe = handshake::probe(&address, &input.token, &timing, &name, true).await?;
        if probe.data_root_id == engine.cfg.data_root_id {
            return Err(Refusal::input("E5b", text::E5B));
        }
        let _write = self.write.lock().await;
        let dir = self.dir.load_full();
        if let Some(existing) = dir.remotes.iter().find(|r| r.saved().data_root_id == probe.data_root_id) {
            return Err(Refusal::input("E5c", text::e5c(&existing.name())));
        }
        if dir.remotes.len() >= store::MAX_REMOTES {
            return Err(Refusal::input("", text::TOO_MANY));
        }
        let key = self.key().map_err(|why| Refusal::new(Kind::Storage, "E15", text::e15(&why)))?;
        let id = uuid::Uuid::new_v4().to_string();
        let tags: Vec<String> = dir.remotes.iter().map(|r| r.tag()).collect();
        let tag = store::tag_for(&name, &tags.iter().map(String::as_str).collect::<Vec<_>>());
        // this desktop's own token, so it can be revoked alone and the pasted
        // one is not kept; an engine that cannot make one keeps the pasted token
        let client_name = format!("Orgtree desktop ({})", self.computer);
        let (token, client_id, client_name) = match handshake::mint(&probe, &input.token, &client_name, &timing).await {
            Ok((token, client_id)) => (token, Some(client_id), Some(client_name)),
            Err(why) => {
                tracing::warn!(remote = %tag, error = %why, "the remote engine made no client token; the pasted token is kept");
                (input.token.clone(), None, None)
            }
        };
        let sealed = match store::seal_token(&key, &id, &token) {
            Ok(sealed) => sealed,
            Err(why) => {
                undo_mint(&probe, &token, &client_id).await;
                return Err(Refusal::new(Kind::Storage, "E15", text::e15(&why)));
            }
        };
        let saved = SavedRemote {
            id, name, tag, url: address.base(), data_root_id: probe.data_root_id.clone(), client_id: client_id.clone(), client_name,
            sealed_token: sealed, enabled: true, created_at: crate::util::now_iso(), last_connected_at: None,
            last_version: Some(probe.version.clone()), last_boot_id: Some(probe.boot_id.clone()).filter(|b| !b.is_empty()), orgs: Vec::new(),
        };
        let remote = Remote::new(saved, token.clone(), Phase::Connecting);
        let mut all = dir.remotes.clone();
        all.push(remote.clone());
        if let Err(refusal) = self.commit(Directory::build(all, dir.next_local_id)) {
            undo_mint(&probe, &token, &client_id).await;
            return Err(refusal);
        }
        drop(_write);
        tracing::info!(remote = %remote.tag(), own_token = client_id.is_some(), "remote engine added");
        link::spawn(engine.clone(), remote.clone());
        self.publish(engine);
        Ok(remote)
    }

    /// Change a saved connection. A new token or address is checked against
    /// the engine that was added (its data root): another engine is E8.
    #[nolog]
    pub async fn update(&self, engine: &Arc<Engine>, id: &str, patch: Patch) -> Result<Arc<Remote>, Refusal> {
        self.usable()?;
        let missing = || Refusal::new(Kind::Missing, "", "no such remote engine");
        let remote = self.get(id).ok_or_else(missing)?;
        let timing = self.timing();
        let before = remote.saved();
        if patch.name.as_deref().is_some_and(|n| !store::valid_name(n.trim())) {
            return Err(Refusal::input("", "The name can have 1 to 100 characters."));
        }
        let address = match &patch.url {
            Some(url) => Address::parse(url).map_err(|e| Refusal::input("E1", e))?,
            None => Address::parse(&before.url).map_err(|e| Refusal::input("E1", e))?,
        };
        // a new token or address proves itself against the engine first
        let mut fresh: Option<(Token, Option<String>, Option<String>, handshake::Probe)> = None;
        if patch.token.is_some() || patch.url.is_some() {
            let pasted = patch.token.clone().unwrap_or_else(|| (*remote.token()).clone());
            if pasted.is_empty() {
                return Err(Refusal::input("", text::TOKEN_MISSING));
            }
            let probe = handshake::probe(&address, &pasted, &timing, &before.name, patch.token.is_some()).await?;
            if probe.data_root_id != before.data_root_id {
                return Err(Refusal::new(Kind::Refused, "E8", text::e8(&address.base())));
            }
            let (token, client_id, client_name) = if patch.token.is_some() {
                let client_name = format!("Orgtree desktop ({})", self.computer);
                match handshake::mint(&probe, &pasted, &client_name, &timing).await {
                    Ok((token, client_id)) => (token, Some(client_id), Some(client_name)),
                    Err(_) => (pasted, None, None),
                }
            } else {
                (pasted, before.client_id.clone(), before.client_name.clone())
            };
            fresh = Some((token, client_id, client_name, probe));
        }
        let _write = self.write.lock().await;
        let dir = self.dir.load_full();
        if dir.get(id).is_none() {
            return Err(missing());
        }
        let mut saved = (*remote.saved()).clone();
        if let Some(name) = &patch.name {
            saved.name = name.trim().to_string();
        }
        if let Some(enabled) = patch.enabled {
            saved.enabled = enabled;
        }
        let mut replaced: Option<(Token, Option<String>)> = None;
        if let Some((token, client_id, client_name, probe)) = fresh {
            saved.url = address.base();
            if patch.token.is_some() {
                let key = self.key().map_err(|why| Refusal::new(Kind::Storage, "E15", text::e15(&why)))?;
                saved.sealed_token = store::seal_token(&key, &saved.id, &token).map_err(|why| Refusal::new(Kind::Storage, "E15", text::e15(&why)))?;
                replaced = Some(((*remote.token()).clone(), saved.client_id.clone()));
                saved.client_id = client_id;
                saved.client_name = client_name;
                remote.token.store(Arc::new(token));
            }
            saved.last_version = Some(probe.version);
        }
        remote.saved.store(Arc::new(saved));
        let all = dir.remotes.clone();
        if let Err(refusal) = self.commit(Directory::build(all, dir.next_local_id)) {
            remote.saved.store(before);
            if let Some((old, _)) = replaced {
                remote.token.store(Arc::new(old));
            }
            return Err(refusal);
        }
        drop(_write);
        // the token this replaces is revoked where the remote still takes it
        if let (Some((old, Some(old_client))), Some(conn)) = (replaced, remote.conn.load_full()) {
            let _ = handshake::revoke(&conn.http, &conn.address.base(), &old, &old_client, Duration::from_secs(5)).await;
        }
        // the link shows the change: a new name in its rows, a pause, a new token
        remote.wake.notify_one();
        self.publish(engine);
        Ok(remote)
    }

    /// Remove a connection: its link and sockets end, its own client token is
    /// revoked on the remote when that can be reached, its organizations leave
    /// the list and their aliases are free again. Nothing on the remote engine
    /// is deleted. Answers whether the token was revoked.
    #[nolog]
    pub async fn remove(&self, engine: &Arc<Engine>, id: &str) -> Result<bool, Refusal> {
        self.usable()?;
        let _write = self.write.lock().await;
        let dir = self.dir.load_full();
        let Some(remote) = dir.get(id) else {
            return Err(Refusal::new(Kind::Missing, "", "no such remote engine"));
        };
        let all: Vec<Arc<Remote>> = dir.remotes.iter().filter(|r| r.id != id).cloned().collect();
        self.commit(Directory::build(all, dir.next_local_id))?;
        drop(_write);
        let saved = remote.saved();
        let conn = remote.conn.load_full();
        remote.stop.cancel();
        let mut revoked = false;
        if let (Some(client_id), false) = (&saved.client_id, remote.token().is_empty()) {
            let http = match &conn {
                Some(conn) => Some((conn.http.clone(), conn.address.base())),
                None => handshake::client_for_saved(&saved.url, &self.timing()).await.ok(),
            };
            if let Some((http, base)) = http {
                revoked = handshake::revoke(&http, &base, &remote.token(), client_id, Duration::from_secs(5)).await;
            }
        }
        engine.app.remote_rows(&remote.id, Vec::new());
        tracing::info!(remote = %saved.tag, revoked, "remote engine removed");
        self.publish(engine);
        Ok(revoked)
    }

    /// The remote's organizations as its app feed lists them now: new ones
    /// get their alias and local id, missing ones are marked gone (their
    /// alias stays reserved), names follow.
    #[nolog]
    pub async fn seen_orgs(&self, engine: &Engine, remote: &Arc<Remote>, seen: &[OrgSeen], keep_summaries: bool) {
        let _write = self.write.lock().await;
        let dir = self.dir.load_full();
        if dir.get(&remote.id).is_none() {
            return;
        }
        let mut saved = (*remote.saved()).clone();
        let mut next_local_id = dir.next_local_id;
        let mut changed = false;
        for org in seen {
            if !store::valid_slug(&org.remote_slug) {
                tracing::warn!(remote = %saved.tag, "a remote organization's slug is not one this desktop can show; it is left out");
                continue;
            }
            if let Some(known) = saved.orgs.iter_mut().find(|o| o.remote_slug == org.remote_slug) {
                if known.name != org.name || known.org_uuid != org.org_uuid || known.gone_at.is_some() {
                    known.name = org.name.clone();
                    known.org_uuid = org.org_uuid.clone();
                    known.gone_at = None;
                    changed = true;
                }
                if keep_summaries && org.summary.is_some() && known.last_summary != org.summary {
                    known.last_summary = org.summary.clone();
                    changed = true;
                }
                continue;
            }
            if saved.orgs.len() >= store::MAX_ORGS {
                tracing::warn!(remote = %saved.tag, "too many organizations on this remote engine; the rest are left out");
                break;
            }
            let held: Vec<String> = saved.orgs.iter().map(|o| o.alias.clone()).collect();
            let taken = |slug: &str| engine.orgs.get(slug).is_some() || dir.by_alias.contains_key(slug) || held.iter().any(|a| a == slug);
            let alias = store::alias_for(&org.remote_slug, &saved.tag, &taken);
            saved.orgs.push(SavedOrg { remote_slug: org.remote_slug.clone(), alias, local_id: next_local_id, org_uuid: org.org_uuid.clone(),
                name: org.name.clone(), last_summary: org.summary.clone(), first_seen: crate::util::now_iso(), gone_at: None });
            next_local_id -= 1;
            changed = true;
        }
        for known in saved.orgs.iter_mut() {
            if known.gone_at.is_none() && !seen.iter().any(|o| o.remote_slug == known.remote_slug) {
                known.gone_at = Some(crate::util::now_iso());
                changed = true;
            }
        }
        if !changed {
            return;
        }
        let before = remote.saved();
        remote.saved.store(Arc::new(saved));
        if let Err(refusal) = self.commit(Directory::build(dir.remotes.clone(), next_local_id)) {
            tracing::warn!(error = %refusal.text, "a remote engine's organizations could not be saved");
            remote.saved.store(before);
        }
    }

    /// The link connected: what it learned about the remote is kept.
    #[nolog]
    pub async fn connected(&self, remote: &Arc<Remote>, version: &str) {
        let _write = self.write.lock().await;
        let dir = self.dir.load_full();
        if dir.get(&remote.id).is_none() {
            return;
        }
        let before = remote.saved();
        let mut saved = (*before).clone();
        saved.last_connected_at = Some(crate::util::now_iso());
        saved.last_version = Some(version.to_string());
        saved.last_boot_id = Some((*remote.boot()).clone()).filter(|b| !b.is_empty());
        remote.saved.store(Arc::new(saved));
        if let Err(refusal) = self.commit(Directory::build(dir.remotes.clone(), dir.next_local_id)) {
            tracing::warn!(error = %refusal.text, "a remote engine's connection record could not be saved");
            remote.saved.store(before);
        }
    }

    /// The organizations of every remote engine as `GET /api/orgs` lists them.
    #[nolog]
    pub fn list_rows(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for remote in &self.dir.load().remotes {
            for row in remote.rows().iter() {
                let s = &row.summary;
                out.push(json!({
                    "attention": s["attention"].as_i64().unwrap_or(0),
                    "slug": row.registry["slug"], "name": s["name"], "created": s["created"],
                    "nodes": s["nodes"].as_i64().unwrap_or(0), "live": s["live"].as_i64().unwrap_or(0),
                    "cost_usd_total": s["cost_usd_total"].as_f64().unwrap_or(0.0),
                    "working": row.working,
                    "state": row.registry["state"], "state_reason": row.registry["state_reason"],
                    "unavailable_step": row.registry["unavailable_step"],
                    "remote": row.registry["remote"],
                }));
            }
        }
        out
    }
}

/// A client token made for a connection that could not be saved is taken back.
#[nolog]
async fn undo_mint(probe: &handshake::Probe, token: &Token, client_id: &Option<String>) {
    if let Some(client_id) = client_id {
        let _ = handshake::revoke(&probe.http, &probe.address.base(), token, client_id, Duration::from_secs(5)).await;
    }
}

/// Start the link of every saved, enabled connection. A remote that does not
/// answer never delays this engine: each link is its own task.
#[logged]
pub fn start(engine: &Arc<Engine>) {
    if !engine.remotes.active(engine) {
        return;
    }
    for remote in engine.remotes.directory().remotes.iter() {
        link::spawn(engine.clone(), remote.clone());
    }
    engine.remotes.publish(engine);
}

/// This computer's name as a client token's name carries it: printable, at
/// most 60 characters.
#[nolog]
fn computer_name() -> String {
    let raw = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let clean: String = raw.chars().filter(|c| !c.is_control()).take(60).collect();
    let clean = clean.trim().to_string();
    if clean.is_empty() { "this computer".to_string() } else { clean }
}
