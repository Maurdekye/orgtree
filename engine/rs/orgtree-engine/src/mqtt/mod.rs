//! MQTT client connections for `mqtt` watchdogs (docs/rust-engine/mqtt-watchdogs.md).
//!
//! The engine is only ever a CLIENT here: dogs subscribe to topics on a
//! broker the user runs (Orgtree runs no broker, DECISIONS 15). Dogs of one
//! org that name the same broker with the same credentials and client id
//! share ONE connection, held in the [`Hub`]. Each connection is one task
//! (`conn.rs`, actor style: it alone owns its subscribers). It subscribes
//! every filter its dogs hold on each CONNACK, routes each PUBLISH to the
//! matching dogs, and reconnects with backoff, never in a tight loop.
//!
//! Secrets: plaintext credentials live only in [`creds::Secret`] (its Debug
//! prints `*****` and it is never serialized) and in rumqttc's options,
//! inside `#[nolog]` functions. rumqttc's own `MqttOptions` Debug prints the
//! password, so it never reaches a logged function.

pub mod creds;
pub mod render;
pub mod seal;
pub mod topic;
mod conn;
#[cfg(test)]
pub(crate) mod testbroker;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

/// The largest packet a connection reads. rumqttc ends the connection on a
/// bigger one (its default is 10 KB); fires show at most 4 KB of a payload.
pub const MAX_PACKET: usize = 1 << 20;
/// Messages buffered for one dog; past it they are counted as dropped.
pub const DELIVERY_BUFFER: usize = 256;
const USAGE: &str = "target must be an MQTT broker URL: mqtt://host[:port] (default port 1883) or mqtts://host[:port] (TLS, default 8883)";

/// A broker as a dog names it, `mqtt://host:port` or `mqtts://host:port`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
pub struct Broker {
    pub tls: bool,
    pub host: String,
    pub port: u16,
}

#[logged]
impl Broker {
    /// The canonical target, with an explicit port; IPv6 in brackets.
    pub fn url(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        format!("{}://{host}:{}", if self.tls { "mqtts" } else { "mqtt" }, self.port)
    }

    /// Is the broker on this machine (plain mqtt:// then sends nothing over a network)?
    pub fn loopback(&self) -> bool {
        self.host == "localhost" || self.host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
    }
}

/// A dog's `target` as a broker, or why it is not one. Credentials, paths
/// and queries are refused: the target is shown in lists, cards and mail.
#[logged]
pub fn parse_target(raw: &str) -> Result<Broker, String> {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    let (tls, rest) = if lower.starts_with("mqtts://") {
        (true, &t[8..])
    } else if lower.starts_with("mqtt://") {
        (false, &t[7..])
    } else {
        return Err(USAGE.into());
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains('@') {
        return Err("the broker URL must not carry credentials (user:password@host): the target is shown in lists, cards and mail. \
                    Put them in `credentials` instead (a file path, or {username, password})".into());
    }
    if rest.contains(['/', '?', '#']) {
        return Err("the broker URL takes no path, query or fragment: mqtt://host[:port] or mqtts://host[:port]".into());
    }
    if rest.is_empty() || rest.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(USAGE.into());
    }
    let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
        let Some((h, after)) = v6.split_once(']') else { return Err(USAGE.into()) };
        if h.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(format!("{h} is not an IPv6 address"));
        }
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':').ok_or_else(|| USAGE.to_string())?),
        };
        (h.to_ascii_lowercase(), port)
    } else {
        match rest.split_once(':') {
            Some((_, p)) if p.contains(':') => return Err("an IPv6 broker address goes in brackets: mqtt://[::1]:1883".into()),
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (rest.to_ascii_lowercase(), None),
        }
    };
    if !host.contains(':') && host.parse::<std::net::Ipv4Addr>().is_err() && !dns_name(&host) {
        return Err(format!("{host} is not a host name or IP address"));
    }
    let port = match port {
        None => if tls { 8883 } else { 1883 },
        Some(p) => p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| format!("{p} is not a port (1-65535)"))?,
    };
    Ok(Broker { tls, host, port })
}

#[nolog]
fn dns_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// What makes two dogs share a connection: the same org (orgs never share),
/// broker, credentials and client id. `identity` is `none`, `file:<path>` or
/// `inline:<salted digest>` ([`Hub::identity`]), never the credentials.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConnKey {
    pub org_id: i64,
    pub broker: Broker,
    pub identity: String,
    pub client_id: Option<String>,
}

/// One message as it arrived.
#[derive(Clone, Debug)]
pub struct Message {
    pub topic: String,
    pub payload: bytes::Bytes,
    pub retained: bool,
    pub at: DateTime<Utc>,
}

/// What a connection hands one dog.
#[derive(Debug)]
pub enum Delivery {
    Message(Message),
    /// The broker granted the subscription to the dog's filter (a SUBACK
    /// after a CONNACK, or after the dog joined a live connection).
    Subscribed { filter: String },
    /// The broker refused the subscription to the dog's filter (SUBACK 0x80).
    Refused { filter: String },
}

/// A connection's state as its dogs see it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    /// The first attempt is under way.
    Connecting { since: DateTime<Utc> },
    Connected { since: DateTime<Utc> },
    /// The network or the broker's service failed; retrying with backoff.
    /// `since` is when the outage began, not the last attempt.
    Down { since: DateTime<Utc>, error: String, retry_at: DateTime<Utc> },
    /// The broker or TLS refused this client: credentials, certificates,
    /// client id or protocol. Retried slowly; resuming a dog retries now.
    Refused { since: DateTime<Utc>, error: String, retry_at: DateTime<Utc> },
}

#[logged]
impl State {
    /// `connecting`, `connected`, `down` or `refused`.
    pub fn name(&self) -> &'static str {
        match self {
            State::Connecting { .. } => "connecting",
            State::Connected { .. } => "connected",
            State::Down { .. } => "down",
            State::Refused { .. } => "refused",
        }
    }
}

/// The state with a counter that moves on every change of kind (and on a
/// refusal with a new reason), so a dog alerts once per transition.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub state: State,
    pub epoch: u64,
}

/// The clocks of a connection; [`Timing::default`] is production.
#[derive(Clone, Debug)]
pub struct Timing {
    /// Network backoff: the first wait, doubled per failure up to `net_max`.
    pub net_first: Duration,
    pub net_max: Duration,
    /// Waits after refusals (auth, TLS, client id, protocol), in order.
    pub refused: Vec<Duration>,
    /// Up this long before the network backoff starts over.
    pub stable: Duration,
    /// TCP + TLS + CONNACK must complete within this (whole seconds).
    pub connect_timeout: Duration,
    pub keep_alive: Duration,
    /// How long a connection stays open after its last dog left.
    pub linger: Duration,
    /// Immediate retries (resume, a new dog) at most this often.
    pub kick_gap: Duration,
    /// Spread waits by ±20 % so many dogs do not retry in step.
    pub jitter: bool,
    /// Identical copies of a message within this window are one message
    /// (a broker sends a copy per overlapping subscription).
    pub dedupe: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            net_first: Duration::from_secs(2),
            net_max: Duration::from_secs(300),
            refused: [60, 300, 900, 1800, 3600].iter().map(|s| Duration::from_secs(*s)).collect(),
            stable: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(10),
            keep_alive: Duration::from_secs(30),
            linger: Duration::from_secs(10),
            kick_gap: Duration::from_secs(5),
            jitter: true,
            dedupe: Duration::from_millis(200),
        }
    }
}

/// Who a subscription belongs to (alerts are claimed once per owner).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tag {
    pub row: i64,
    pub owner: i64,
}

/// The engine's MQTT connections, keyed by [`ConnKey`].
pub struct Hub {
    conns: Arc<papaya::HashMap<ConnKey, Arc<conn::Handle>>>,
    timing: Timing,
    salt: [u8; 16],
    key: OnceLock<Result<Arc<seal::Key>, String>>,
    next: AtomicU64,
    /// Attachments a dog's create opened for its smoke check, waiting for
    /// the dog's runner (keyed by the dog's row): the runner takes over the
    /// connection and any message that arrived in between.
    parked: papaya::HashMap<i64, Arc<std::sync::Mutex<Option<Parked>>>>,
}

/// A create's attachment and the deliveries its smoke check read.
pub struct Parked {
    pub attachment: Attachment,
    pub early: Vec<Delivery>,
}

impl Default for Hub {
    fn default() -> Self {
        Hub::with_timing(Timing::default())
    }
}

#[logged]
impl Hub {
    #[nolog]
    pub fn with_timing(timing: Timing) -> Hub {
        let mut salt = [0u8; 16];
        rand::Rng::fill(&mut rand::thread_rng(), &mut salt);
        Hub { conns: Arc::new(papaya::HashMap::new()), timing, salt, key: OnceLock::new(), next: AtomicU64::new(1),
              parked: papaya::HashMap::new() }
    }

    /// The key that seals this data root's inline credentials, made on
    /// first use in `secrets_dir` and kept for the life of the process.
    #[nolog]
    pub fn key(&self, secrets_dir: &Path) -> Result<Arc<seal::Key>, String> {
        self.key.get_or_init(|| seal::load_or_create(secrets_dir).map(Arc::new)).clone()
    }

    /// The identity part of a connection key: salted per process, so equal
    /// credentials share a connection but the key is no stable fingerprint.
    #[nolog]
    pub fn identity(&self, source: &creds::Source) -> String {
        creds::identity(source, &self.salt)
    }

    /// Join the connection `key` names (opening it when none is open) with
    /// one dog's subscription to `filter`. The connection lives until its
    /// last attachment is dropped (and `Timing::linger` after), or until
    /// `shutdown`: the ENGINE's token, never one dog's, because the
    /// connection outlives the dog that opened it. None only once
    /// `shutdown` has fired.
    pub async fn attach(&self, key: ConnKey, source: creds::Source, filter: &str, tag: Tag, shutdown: &CancellationToken) -> Option<Attachment> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(DELIVERY_BUFFER);
        let dropped = Arc::new(AtomicU64::new(0));
        let authorized = Arc::new(AtomicBool::new(true));
        while !shutdown.is_cancelled() {
            let handle = self.handle(&key, &source, shutdown);
            let (ack, acked) = oneshot::channel();
            let sub = conn::Sub { filter: filter.to_string(), tx: tx.clone(), dropped: dropped.clone(), authorized: authorized.clone(), tag };
            // a connection on its way out drops the command (or its ack):
            // forget it and open a fresh one
            if handle.send(conn::Cmd::Attach { id, sub, ack }) && acked.await.is_ok() {
                let state = handle.state();
                return Some(Attachment { id, key: key.clone(), rx, state, dropped, authorized, handle });
            }
            self.conns.pin().remove_if(&key, |_, h| Arc::ptr_eq(h, &handle)).ok();
            tokio::task::yield_now().await;
        }
        None
    }

    /// The open connection for `key`, or a new one started now. Only the
    /// caller whose handle went into the map starts a task.
    #[nolog]
    fn handle(&self, key: &ConnKey, source: &creds::Source, shutdown: &CancellationToken) -> Arc<conn::Handle> {
        let map = self.conns.pin();
        if let Some(h) = map.get(key).filter(|h| !h.closed()) {
            return h.clone();
        }
        let (fresh, parts) = conn::Handle::new(key.clone());
        let fresh = Arc::new(fresh);
        match map.compute(key.clone(), |entry| match entry {
            Some((_, h)) if !h.closed() => papaya::Operation::Abort(h.clone()),
            _ => papaya::Operation::Insert(fresh.clone()),
        }) {
            papaya::Compute::Aborted(h) => h,
            _ => {
                conn::spawn(fresh.clone(), parts, source.clone(), self.timing.clone(), self.conns.clone(), shutdown);
                fresh
            }
        }
    }

    /// Does another open connection to this broker use the same explicit
    /// client id? Two would end each other's sessions in turn, forever.
    pub fn client_id_taken(&self, key: &ConnKey) -> bool {
        let Some(id) = key.client_id.as_deref() else { return false };
        self.conns.pin().iter().any(|(k, h)| {
            !h.closed() && k != key && k.broker.host == key.broker.host && k.broker.port == key.broker.port
                && k.client_id.as_deref() == Some(id)
        })
    }

    /// Open connections (diagnostics and tests).
    pub fn connections(&self) -> usize {
        self.conns.pin().iter().filter(|(_, h)| !h.closed()).count()
    }

    /// Keep a create's attachment for the dog in row `row` until its runner
    /// takes it ([`Hub::unpark`]); a later park for the row replaces it.
    #[nolog]
    pub fn park(&self, row: i64, parked: Parked) {
        self.parked.pin().insert(row, Arc::new(std::sync::Mutex::new(Some(parked))));
    }

    /// The attachment parked for `row`, if any (taken once). Disarming a dog
    /// unparks too, so a dog removed before its runner starts holds nothing.
    #[nolog]
    pub fn unpark(&self, row: i64) -> Option<Parked> {
        let slot = self.parked.pin().remove(&row).cloned()?;
        let taken = slot.lock().ok()?.take();
        taken
    }
}

/// One dog's place on a connection: its deliveries, the connection's state,
/// and the flags it keeps for the connection. Dropping it unsubscribes.
pub struct Attachment {
    id: u64,
    /// The connection this attachment is on.
    pub key: ConnKey,
    pub rx: mpsc::Receiver<Delivery>,
    pub state: watch::Receiver<Snapshot>,
    /// Messages this dog lost because its buffer was full.
    pub dropped: Arc<AtomicU64>,
    /// Cleared when the dog's owner loses the authority the connection runs
    /// with; a connection none of whose dogs is authorized makes no attempt.
    pub authorized: Arc<AtomicBool>,
    handle: Arc<conn::Handle>,
}

#[logged]
impl Attachment {
    /// Retry now if the connection is waiting out a backoff (at most once
    /// per `Timing::kick_gap`): how a dog's resume retries after a fix.
    pub fn kick(&self) {
        self.handle.send(conn::Cmd::Kick);
    }

    /// Claim the alert `what` for `owner` on this connection: true for the
    /// first of the owner's dogs to ask, so an owner gets one mail per
    /// transition however many of its dogs share the connection.
    pub fn claim(&self, owner: i64, what: &str) -> bool {
        self.handle.claim(owner, what)
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.handle.send(conn::Cmd::Detach { id: self.id });
    }
}
