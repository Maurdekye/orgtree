//! WebSocket client connections for `websocket` watchdogs
//! (docs/rust-engine/websocket-watchdogs.md; user 2026-10-19 21:00Z/21:01:59Z).
//!
//! The engine is only ever a CLIENT here: a dog dials a ws:// or wss://
//! server the user names, sends its hello messages after every connect, and
//! fires with the text messages that match its pattern; its owner can also
//! write on the live connection (`orgtree_watchdog action=send`). Unlike an
//! MQTT subscription, a WebSocket session is stateful (hello and subscribe
//! ids, the messages an agent sends), so every dog has its OWN connection
//! (coordinator 2026-10-19 21:14Z): one task per dog (`conn.rs`, actor
//! style), which redials with mqtt's backoff, never in a tight loop.
//!
//! Secrets: the credentials (headers, bearer, Basic login, query, secret
//! hellos) live only in mqtt's [`crate::mqtt::creds::Secret`] inside the
//! `#[nolog]` functions of `creds.rs` and `conn.rs`. The URL a connection
//! dials (with the credential query) and its upgrade request never reach a
//! logged function, and tungstenite's own `log` lines (it traces the whole
//! upgrade request) are off in the default log filter (trace.rs).

pub mod creds;
pub mod render;
mod conn;
#[cfg(test)]
pub(crate) mod testserver;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

pub use crate::mqtt::{Snapshot, State};

/// The largest message (and frame) a connection reads: a bigger one resets
/// the connection, as mqtt's packet cap does (coordinator 21:14Z).
pub const MAX_MESSAGE: usize = 1 << 20;
/// The largest message `send` writes.
pub const SEND_MAX: usize = 64 * 1024;
/// Matching messages buffered for the dog; past it they are counted as dropped.
pub const DELIVERY_BUFFER: usize = 256;
/// Hello messages a dog sends after each connect (and its credentials' own),
/// and the bytes they may take together.
pub const HELLO_MAX: usize = 16;
pub const HELLO_BYTES: usize = 64 * 1024;
/// Subprotocols a dog may offer.
pub const PROTOCOLS_MAX: usize = 8;
/// The shortest heartbeat period.
pub const HEARTBEAT_FLOOR_S: u64 = 5;
/// The most of a message's text a connection keeps for its dog's fire (a
/// fire shows at most this much of one message): the regex has already run
/// on all of it.
pub const KEEP_TEXT: usize = crate::mqtt::render::PER_MESSAGE;
/// The longest target URL.
const URL_MAX: usize = 2048;
const USAGE: &str = "target must be a WebSocket URL: ws://host[:port][/path][?query] (default port 80) or wss://host[:port][/path][?query] (TLS, default 443)";
/// Query parameters that look like secrets: the target is shown everywhere,
/// so these go under `credentials.query` instead.
const SECRET_PARAMS: &[&str] = &["key", "auth", "authorization", "sig", "jwt", "session", "sessionid", "session_id", "ticket", "pass", "pwd",
                                 "credential", "credentials"];
const SECRET_SUFFIXES: &[&str] = &["token", "secret", "password", "passwd", "apikey", "api_key", "api-key", "_key", "-key", "signature"];

/// A dog's target as it dials it: `ws(s)://host[:port]` and the path and
/// query (`resource`, at least "/").
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Endpoint {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    pub resource: String,
}

#[logged]
impl Endpoint {
    /// The canonical target: scheme and host in lower case, the port only
    /// when it is not the default, IPv6 in brackets.
    pub fn url(&self) -> String {
        format!("{}://{}{}", if self.tls { "wss" } else { "ws" }, self.authority(), self.resource)
    }

    /// `host[:port]` as the Host header and the URL carry it.
    pub fn authority(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == if self.tls { 443 } else { 80 } { host } else { format!("{host}:{}", self.port) }
    }

    /// The URL without its query: what alerts and the send log name.
    pub fn base(&self) -> String {
        let path = self.resource.split('?').next().unwrap_or("/");
        format!("{}://{}{path}", if self.tls { "wss" } else { "ws" }, self.authority())
    }

    /// Is the server on this machine (plain ws:// then sends nothing over a network)?
    pub fn loopback(&self) -> bool {
        self.host == "localhost" || self.host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
    }
}

/// A dog's `target` as an endpoint, or why it is not one. Credentials,
/// fragments and query parameters named like secrets are refused: the
/// target is shown in lists, cards and mail.
#[logged]
pub fn parse_target(raw: &str) -> Result<Endpoint, String> {
    let t = raw.trim();
    if t.len() > URL_MAX {
        return Err(format!("the URL is over {URL_MAX} characters"));
    }
    let lower = t.to_ascii_lowercase();
    let (tls, rest) = if lower.starts_with("wss://") {
        (true, &t[6..])
    } else if lower.starts_with("ws://") {
        (false, &t[5..])
    } else {
        return Err(USAGE.into());
    };
    if rest.contains('#') {
        return Err("the URL takes no fragment (#…): a WebSocket server never sees it".into());
    }
    let cut = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, resource) = rest.split_at(cut);
    if authority.contains('@') {
        return Err("the URL must not carry credentials (user:password@host): the target is shown in lists, cards and mail. \
                    Put them in `credentials` instead: {username, password} (HTTP Basic), bearer, headers or query".into());
    }
    let (host, port) = crate::mqtt::host_port(authority, if tls { 443 } else { 80 }, USAGE, "an IPv6 server address goes in brackets: ws://[::1]:8080/")?;
    let resource = match resource {
        "" => "/".to_string(),
        r if r.starts_with('?') => format!("/{r}"),
        r => r.to_string(),
    };
    if resource.chars().any(|c| !c.is_ascii() || c.is_ascii_control() || c == ' ') {
        return Err("the URL's path and query must be printable ASCII without spaces: percent-encode anything else".into());
    }
    if let Some((_, query)) = resource.split_once('?') {
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            let name = pair.split('=').next().unwrap_or("");
            if secret_param(name) {
                // a name is quoted only when it looks like one, never a pasted token
                let decoded = percent_encoding::percent_decode_str(name).decode_utf8_lossy().to_string();
                let shown = if decoded.len() <= 32 && decoded.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b)) { decoded } else { "…".into() };
                return Err(format!("the URL's query parameter {shown:?} looks like a secret, and the target is shown in lists, cards and mail: \
                                    put it under credentials instead, credentials={{\"query\": {{\"{shown}\": …}}}} (appended when the dog dials, never shown)"));
            }
        }
    }
    Ok(Endpoint { tls, host, port, resource })
}

/// Is a URL query parameter `name` (as written, maybe percent-encoded) one
/// that holds a secret? Such values are refused in a target and masked in
/// logs and transcripts ([`crate::util::mask_url_secrets`]).
#[nolog]
pub(crate) fn secret_param(name: &str) -> bool {
    let name = percent_encoding::percent_decode_str(name).decode_utf8_lossy().to_ascii_lowercase();
    SECRET_PARAMS.contains(&name.as_str()) || SECRET_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// One message as it arrived: its text (cut to [`KEEP_TEXT`]; None for a
/// binary message) and its true size.
#[derive(Clone, Debug)]
pub struct Message {
    pub at: DateTime<Utc>,
    pub text: Option<String>,
    pub size: usize,
}

#[logged]
impl Message {
    /// Did the connection keep only part of the text?
    #[nolog]
    pub fn partial(&self) -> bool {
        self.text.as_ref().is_some_and(|t| t.len() < self.size)
    }
}

/// What one dog's connection sends and says, as the dog sees it.
pub struct Spec {
    pub endpoint: Endpoint,
    pub protocols: Vec<String>,
    /// The dog's own hello messages (its credentials' go first).
    pub hello: Vec<String>,
    /// A fixed message and its period, sent while connected.
    pub heartbeat: Option<(String, Duration)>,
    /// The dog's regex: only matching text messages are passed on (None:
    /// every message, binary ones as their size).
    pub pattern: Option<fancy_regex::Regex>,
    pub source: creds::Source,
}

/// The counters a connection keeps for its dog (lists, cards, alerts).
#[derive(Default)]
pub struct Stats {
    /// Dials attempted (a credentials file that fails to read counts too).
    pub dials: AtomicU64,
    /// Messages received, matching or not, text or binary.
    pub received: AtomicU64,
    pub binary: AtomicU64,
    /// Matching messages lost because the dog's buffer was full.
    pub dropped: AtomicU64,
    /// Messages written by `send`.
    pub sent: AtomicU64,
    /// The last message received (for the dog's `last_output`), cut short.
    pub last: Mutex<Option<Message>>,
    pub last_sent: Mutex<Option<DateTime<Utc>>>,
    /// The subprotocol the server chose on the last upgrade.
    pub protocol: Mutex<Option<String>>,
}

#[logged]
impl Stats {
    #[nolog]
    pub fn get(&self, n: &AtomicU64) -> u64 {
        n.load(Ordering::Relaxed)
    }
}

/// A message `send` wrote.
#[derive(Clone, Debug)]
pub struct Sent {
    pub bytes: usize,
    pub at: DateTime<Utc>,
}

/// The clocks of a connection; [`Timing::default`] is production.
#[derive(Clone, Debug)]
pub struct Timing {
    /// Network backoff: the first wait, doubled per failure up to `net_max`.
    pub net_first: Duration,
    pub net_max: Duration,
    /// Waits after refusals (HTTP 401/403 and other 4xx, TLS, bad credentials), in order.
    pub refused: Vec<Duration>,
    /// Up this long before the network backoff starts over, and before an
    /// outage counts as over.
    pub stable: Duration,
    /// TCP + TLS + the HTTP upgrade must complete within this.
    pub connect_timeout: Duration,
    /// A ping goes out after this long without a frame from the server…
    pub ping_after: Duration,
    /// …and this long without one ends the connection as dead.
    pub dead_after: Duration,
    /// A write (hello, heartbeat, send) must complete within this.
    pub write_timeout: Duration,
    /// Immediate retries (resume) at most this often.
    pub kick_gap: Duration,
    /// The longest Retry-After honoured.
    pub retry_after_max: Duration,
    pub jitter: bool,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            net_first: Duration::from_secs(2),
            net_max: Duration::from_secs(300),
            refused: [60, 300, 900, 1800, 3600].iter().map(|s| Duration::from_secs(*s)).collect(),
            stable: Duration::from_secs(60),
            connect_timeout: Duration::from_secs(10),
            ping_after: Duration::from_secs(30),
            dead_after: Duration::from_secs(75),
            write_timeout: Duration::from_secs(10),
            kick_gap: Duration::from_secs(5),
            retry_after_max: Duration::from_secs(3600),
            jitter: true,
        }
    }
}

#[logged]
impl Timing {
    #[nolog]
    pub(crate) fn waits(&self) -> crate::mqtt::backoff::Waits<'_> {
        crate::mqtt::backoff::Waits { net_first: self.net_first, net_max: self.net_max, refused: &self.refused, stable: self.stable, jitter: self.jitter }
    }
}

/// The engine's websocket connections: the ones a create opened for its
/// smoke check, waiting for the dog's runner, and the ones runners hold
/// (for `send`), both keyed by the dog's row.
pub struct Hub {
    timing: Timing,
    parked: papaya::HashMap<i64, Arc<Mutex<Option<Conn>>>>,
    live: papaya::HashMap<i64, (u64, Link)>,
    next: AtomicU64,
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
        Hub { timing, parked: papaya::HashMap::new(), live: papaya::HashMap::new(), next: AtomicU64::new(1) }
    }

    /// Start one dog's connection. It lives until the [`Conn`] is dropped or
    /// `shutdown` (the ENGINE's token) fires; dropping it closes the socket.
    #[nolog]
    pub fn open(&self, spec: Spec, shutdown: &CancellationToken) -> Conn {
        conn::spawn(spec, self.timing.clone(), shutdown.child_token())
    }

    /// Keep a create's connection for the dog in row `row` until its runner
    /// takes it ([`Hub::unpark`]); a later park for the row replaces it.
    #[nolog]
    pub fn park(&self, row: i64, conn: Conn) {
        self.parked.pin().insert(row, Arc::new(Mutex::new(Some(conn))));
    }

    /// The connection parked for `row`, if any (taken once). Disarming a dog
    /// unparks too, so a dog removed before its runner starts holds nothing.
    #[nolog]
    pub fn unpark(&self, row: i64) -> Option<Conn> {
        let slot = self.parked.pin().remove(&row).cloned()?;
        let taken = slot.lock().ok()?.take();
        taken
    }

    /// Make `conn` the one `send` reaches for the dog in row `row`, while the
    /// returned guard lives.
    #[nolog]
    pub fn register<'a>(&'a self, row: i64, conn: &Conn) -> Registered<'a> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.live.pin().insert(row, (id, conn.link.clone()));
        Registered { hub: self, row, id }
    }

    /// The live connection of the dog in row `row`, if its runner holds one.
    #[nolog]
    pub fn link(&self, row: i64) -> Option<Link> {
        self.live.pin().get(&row).map(|(_, l)| l.clone())
    }
}

/// While it lives, `send` reaches its dog's connection.
pub struct Registered<'a> {
    hub: &'a Hub,
    row: i64,
    id: u64,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        let _ = self.hub.live.pin().remove_if(&self.row, |_, (id, _)| *id == self.id);
    }
}

/// One dog's connection: its matching messages, its state and counters.
/// Dropping it closes the connection.
pub struct Conn {
    pub rx: mpsc::Receiver<Message>,
    pub state: watch::Receiver<Snapshot>,
    pub stats: Arc<Stats>,
    link: Link,
    cancel: CancellationToken,
}

#[logged]
impl Conn {
    /// Retry now if the connection is waiting out a backoff (at most once
    /// per `Timing::kick_gap`): how a dog's resume retries after a fix.
    #[nolog]
    pub fn kick(&self) {
        let _ = self.link.cmd.send(conn::Cmd::Kick);
    }

    #[nolog]
    pub fn link(&self) -> Link {
        self.link.clone()
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// The way `send` writes on a dog's connection.
#[derive(Clone)]
pub struct Link {
    cmd: mpsc::UnboundedSender<conn::Cmd>,
    pub state: watch::Receiver<Snapshot>,
    pub stats: Arc<Stats>,
}

#[logged]
impl Link {
    /// Write `text` as one text frame on the live connection, after its
    /// hellos: Ok once it is flushed to the socket. Refused, with nothing
    /// written, while the connection is not up.
    #[nolog]
    pub async fn send(&self, text: String, wait: Duration) -> Result<Sent, String> {
        let (ack, acked) = oneshot::channel();
        if self.cmd.send(conn::Cmd::Send { text, ack }).is_err() {
            return Err("its connection has closed".into());
        }
        match tokio::time::timeout(wait, acked).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("its connection closed before the message was written".into()),
            Err(_) => Err(format!("its connection did not write the message within {} s", wait.as_secs())),
        }
    }
}
