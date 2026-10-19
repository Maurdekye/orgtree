//! One websocket dog's connection: a task that dials (TCP, TLS on the
//! engine's own rustls + ring, the HTTP upgrade), sends the hellos, then
//! reads frames, writes what `send` and the heartbeat hand it, and pings a
//! quiet server, until the connection fails or the dog goes. Then it waits
//! out mqtt's backoff and dials again. It alone owns the socket: commands
//! arrive on a channel (actor style). Every attempt resolves the
//! credentials afresh (a credentials file is re-read each time); the URL it
//! dials and the upgrade request stay in `#[nolog]` functions.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use futures::{SinkExt, StreamExt};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{self, Message as Frame};
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;

use super::{creds, Conn, Endpoint, Link, Message, Sent, Snapshot, Spec, State, Stats, Timing, DELIVERY_BUFFER, KEEP_TEXT, MAX_MESSAGE};
use crate::mqtt::backoff::Backoff;
use crate::mqtt::creds::Secret;
use crate::mqtt::render::{cap, clean};

/// What a dog's `last_output` keeps of the last message.
const LAST_KEEP: usize = 1024;
/// A close reason is at most 123 bytes (RFC 6455); it is shown escaped.
const REASON_SHOWN: usize = 123;
/// Characters a credential query keeps unencoded (RFC 3986 unreserved).
const QUERY_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub(super) enum Cmd {
    Send { text: String, ack: oneshot::Sender<Result<Sent, String>> },
    Kick,
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
type Ws = WebSocketStream<Box<dyn Io>>;

/// Start one dog's connection task; it ends when `cancel` fires (the
/// [`Conn`] dropped, or the engine stopping).
#[nolog]
pub(super) fn spawn(spec: Spec, timing: Timing, cancel: CancellationToken) -> Conn {
    let (tx, rx) = mpsc::channel(DELIVERY_BUFFER);
    let (cmd, cmds) = mpsc::unbounded_channel();
    let (state_tx, state) = watch::channel(Snapshot { state: State::Connecting { since: Utc::now() }, epoch: 0 });
    let stats = Arc::new(Stats::default());
    let span = crate::trace::request(&format!("ws:{}", spec.endpoint.base()));
    let mut task = Task { spec, timing, tx, rx: cmds, state: state_tx, stats: stats.clone(), backoff: Backoff::default(), last_kick: None, outage: None };
    let token = cancel.clone();
    tokio::spawn(tracing::Instrument::instrument(async move { task.run(&token).await }, span));
    let link = Link { cmd, state: state.clone(), stats: stats.clone() };
    Conn { rx, state, stats, link, cancel }
}

struct Task {
    spec: Spec,
    timing: Timing,
    tx: mpsc::Sender<Message>,
    rx: mpsc::UnboundedReceiver<Cmd>,
    state: watch::Sender<Snapshot>,
    stats: Arc<Stats>,
    backoff: Backoff,
    last_kick: Option<Instant>,
    /// When the current outage began: a server that accepts the client and
    /// drops it within `Timing::stable` does not end it.
    outage: Option<chrono::DateTime<Utc>>,
}

/// How a session ended.
enum End {
    Cancelled,
    Failed { refused: bool, error: String, retry_after: Option<Duration> },
}

#[nolog]
fn failed(refused: bool, error: impl Into<String>) -> End {
    End::Failed { refused, error: error.into(), retry_after: None }
}

#[logged]
impl Task {
    async fn run(&mut self, cancel: &CancellationToken) {
        loop {
            if cancel.is_cancelled() {
                return;
            }
            match self.session(cancel).await {
                End::Cancelled => return,
                End::Failed { refused, error, retry_after } => {
                    let flapping = self.backoff.flapping(self.timing.stable);
                    let mut wait = self.backoff.failed(refused, &self.timing.waits());
                    if let Some(ra) = retry_after {
                        wait = wait.max(ra.min(self.timing.retry_after_max));
                    }
                    self.failed(refused, error, wait, flapping);
                    if !self.wait(wait, cancel).await {
                        return;
                    }
                }
            }
        }
    }

    /// Wait out a backoff. True to dial again (time is up, or a kick at most
    /// once per `kick_gap`), false on cancel. A send meanwhile is refused.
    async fn wait(&mut self, dur: Duration, cancel: &CancellationToken) -> bool {
        let until = Instant::now() + dur;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return false,
                _ = tokio::time::sleep_until(until) => return true,
                cmd = self.rx.recv() => match cmd {
                    None => return false,
                    Some(Cmd::Kick) => if self.kick_allowed() { return true },
                    Some(Cmd::Send { ack, .. }) => { let _ = ack.send(Err(self.not_connected())); }
                },
            }
        }
    }

    #[nolog]
    fn kick_allowed(&mut self) -> bool {
        let now = Instant::now();
        if self.last_kick.is_some_and(|t| now.duration_since(t) < self.timing.kick_gap) {
            return false;
        }
        self.last_kick = Some(now);
        true
    }

    /// Why a send is refused now.
    #[nolog]
    fn not_connected(&self) -> String {
        match &self.state.borrow().state {
            State::Down { since, error, retry_at } | State::Refused { since, error, retry_at } => {
                format!("not connected: down since {} ({error}); next try {}", crate::util::iso(*since), crate::util::iso(*retry_at))
            }
            State::Connecting { .. } => "not connected yet: still connecting".into(),
            State::Connected { .. } => "not connected: the connection just ended".into(),
        }
    }

    /// One dial and, when the server upgrades, the session it starts.
    #[nolog]
    async fn session(&mut self, cancel: &CancellationToken) -> End {
        self.stats.dials.fetch_add(1, Ordering::Relaxed);
        let resolved = match creds::resolve(&self.spec.source, &self.spec.endpoint) {
            Ok(r) => r,
            Err(e) => return failed(true, e),
        };
        let dialed = tokio::select! {
            _ = cancel.cancelled() => return End::Cancelled,
            r = tokio::time::timeout(self.timing.connect_timeout, dial(&self.spec, &resolved)) => r,
        };
        let (mut ws, protocol) = match dialed {
            Err(_) => return failed(false, format!("no answer from the server within the {} s connect timeout", self.timing.connect_timeout.as_secs())),
            Ok(Err(end)) => return end,
            Ok(Ok(x)) => x,
        };
        *lock(&self.stats.protocol) = protocol;
        // the credentials' hellos (a login) go first, then the dog's own
        let mut hellos: Vec<Secret> = resolved.hello.clone();
        hellos.extend(self.spec.hello.iter().map(Secret::new));
        drop(resolved);
        for h in hellos {
            if let Err(end) = self.write(&mut ws, Frame::Text(h.expose().into())).await {
                return end;
            }
        }
        self.backoff.connected();
        self.set(State::Connected { since: Utc::now() });
        tracing::info!(url = %self.spec.endpoint.base(), "websocket connected");
        let mut heard = Instant::now();
        let mut pinged = false;
        let mut beat_at = self.spec.heartbeat.as_ref().map(|(_, every)| Instant::now() + *every);
        loop {
            let ping_at = heard + self.timing.ping_after;
            let dead_at = heard + self.timing.dead_after;
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    goodbye(&mut ws).await;
                    return End::Cancelled;
                }
                cmd = self.rx.recv() => match cmd {
                    None => {
                        goodbye(&mut ws).await;
                        return End::Cancelled;
                    }
                    Some(Cmd::Kick) => {}
                    Some(Cmd::Send { text, ack }) => {
                        let bytes = text.len();
                        match self.write(&mut ws, Frame::Text(text.into())).await {
                            Ok(()) => {
                                let at = Utc::now();
                                self.stats.sent.fetch_add(1, Ordering::Relaxed);
                                *lock(&self.stats.last_sent) = Some(at);
                                let _ = ack.send(Ok(Sent { bytes, at }));
                            }
                            Err(end) => {
                                let why = match &end { End::Failed { error, .. } => error.clone(), End::Cancelled => "the dog stopped".into() };
                                let _ = ack.send(Err(format!("the connection failed while writing it: {why}")));
                                return end;
                            }
                        }
                    }
                },
                frame = ws.next() => {
                    heard = Instant::now();
                    pinged = false;
                    match frame {
                        None => return failed(false, "the server closed the connection"),
                        Some(Err(e)) => return classify(e, false),
                        Some(Ok(Frame::Text(t))) => self.text(t.as_str()),
                        Some(Ok(Frame::Binary(b))) => self.binary(b.len()),
                        Some(Ok(Frame::Close(f))) => return failed(false, close_text(f.as_ref())),
                        // a ping (tungstenite answers it), a pong, a raw frame
                        Some(Ok(_)) => {}
                    }
                }
                _ = tokio::time::sleep_until(ping_at), if !pinged => {
                    pinged = true;
                    if let Err(end) = self.write(&mut ws, Frame::Ping(Default::default())).await {
                        return end;
                    }
                }
                _ = tokio::time::sleep_until(dead_at) => {
                    return failed(false, format!("the server went silent: no frame for {} s, and it did not answer a ping", self.timing.dead_after.as_secs()));
                }
                _ = tokio::time::sleep_until(beat_at.unwrap_or_else(Instant::now)), if beat_at.is_some() => {
                    if let Some((beat, every)) = &self.spec.heartbeat {
                        beat_at = Some(Instant::now() + *every);
                        let beat = beat.clone();
                        if let Err(end) = self.write(&mut ws, Frame::Text(beat.into())).await {
                            return end;
                        }
                    }
                }
            }
        }
    }

    /// Write one frame within `Timing::write_timeout`.
    #[nolog]
    async fn write(&self, ws: &mut Ws, frame: Frame) -> Result<(), End> {
        match tokio::time::timeout(self.timing.write_timeout, ws.send(frame)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(classify(e, false)),
            Err(_) => Err(failed(false, format!("writing to the server timed out ({} s)", self.timing.write_timeout.as_secs()))),
        }
    }

    /// A text message: counted, kept as the last one, and passed on when it
    /// matches the dog's pattern (on all of it; the dog gets what a fire shows).
    #[nolog]
    fn text(&mut self, t: &str) {
        let at = Utc::now();
        self.stats.received.fetch_add(1, Ordering::Relaxed);
        *lock(&self.stats.last) = Some(Message { at, text: Some(cap(t, LAST_KEEP).to_string()), size: t.len() });
        let hit = match &self.spec.pattern {
            None => true,
            // a pattern that gives up backtracking matches nothing
            Some(re) => re.is_match(t).unwrap_or(false),
        };
        if hit {
            self.deliver(Message { at, text: Some(cap(t, KEEP_TEXT).to_string()), size: t.len() });
        }
    }

    /// A binary message: counted; with no pattern it is passed on as its size.
    #[nolog]
    fn binary(&mut self, n: usize) {
        let at = Utc::now();
        self.stats.received.fetch_add(1, Ordering::Relaxed);
        self.stats.binary.fetch_add(1, Ordering::Relaxed);
        *lock(&self.stats.last) = Some(Message { at, text: None, size: n });
        if self.spec.pattern.is_none() {
            self.deliver(Message { at, text: None, size: n });
        }
    }

    #[nolog]
    fn deliver(&self, m: Message) {
        if self.tx.try_send(m).is_err() {
            self.stats.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Record a failed attempt: an outage keeps the time it began, also
    /// across a connection the server dropped again within `stable`.
    #[nolog]
    fn failed(&mut self, refused: bool, error: String, wait: Duration, flapping: bool) {
        let now = Utc::now();
        let retry_at = now + chrono::Duration::from_std(wait).unwrap_or_default();
        let since = match &self.state.borrow().state {
            State::Down { since, .. } | State::Refused { since, .. } => *since,
            State::Connected { .. } if flapping => self.outage.unwrap_or(now),
            _ => now,
        };
        self.outage = Some(since);
        tracing::info!(url = %self.spec.endpoint.base(), refused, error = %error, retry_s = wait.as_secs(), "websocket connection failed");
        self.set(if refused { State::Refused { since, error, retry_at } } else { State::Down { since, error, retry_at } });
    }

    #[nolog]
    fn set(&self, next: State) {
        self.state.send_modify(|snap| {
            let refusal_changed = matches!((&snap.state, &next), (State::Refused { error: a, .. }, State::Refused { error: b, .. }) if a != b);
            if std::mem::discriminant(&snap.state) != std::mem::discriminant(&next) || refusal_changed {
                snap.epoch += 1;
            }
            snap.state = next;
        });
    }
}

#[nolog]
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A clean goodbye when the dog leaves: Close 1001, within a second.
#[nolog]
async fn goodbye(ws: &mut Ws) {
    let frame = CloseFrame { code: CloseCode::Away, reason: "".into() };
    let _ = tokio::time::timeout(Duration::from_secs(1), ws.close(Some(frame))).await;
}

/// TCP, TLS and the upgrade: the socket and the subprotocol the server chose.
/// `#[nolog]`: the URL it dials carries the credential query, the request
/// the credential headers.
#[nolog]
async fn dial(spec: &Spec, r: &creds::Resolved) -> Result<(Ws, Option<String>), End> {
    let ep = &spec.endpoint;
    let tcp = TcpStream::connect((ep.host.as_str(), ep.port)).await.map_err(|e| io_end(&e))?;
    let _ = tcp.set_nodelay(true);
    let io: Box<dyn Io> = match &r.tls {
        None => Box::new(tcp),
        Some(cfg) => {
            let name = rustls::pki_types::ServerName::try_from(ep.host.clone())
                .map_err(|_| failed(true, format!("TLS: {} is not a host name TLS can check", ep.host)))?;
            let tls = tokio_rustls::TlsConnector::from(cfg.clone()).connect(name, tcp).await.map_err(|e| io_end(&e))?;
            Box::new(tls)
        }
    };
    let uri: http::Uri = dial_uri(ep, &r.query).parse().map_err(|_| failed(true, "the URL with its credential query is not a valid URI"))?;
    let mut req = ClientRequestBuilder::new(uri);
    for (k, v) in &r.headers {
        req = req.with_header(k.clone(), v.expose().to_string());
    }
    for p in &spec.protocols {
        req = req.with_sub_protocol(p.clone());
    }
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_MESSAGE);
    cfg.max_frame_size = Some(MAX_MESSAGE);
    match tokio_tungstenite::client_async_with_config(req, io, Some(cfg)).await {
        Ok((ws, resp)) => {
            let protocol = resp.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok()).map(str::to_string);
            Ok((ws, protocol))
        }
        Err(e) => Err(classify(e, true)),
    }
}

/// The URL a dial uses: the target and the credential query, encoded.
#[nolog]
fn dial_uri(ep: &Endpoint, query: &[(String, Secret)]) -> String {
    let mut url = format!("{}://{}{}", if ep.tls { "wss" } else { "ws" }, ep.authority(), ep.resource);
    if !query.is_empty() {
        url.push(if ep.resource.contains('?') { '&' } else { '?' });
        let enc = |s: &str| percent_encoding::utf8_percent_encode(s, QUERY_SET).to_string();
        let pairs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v.expose()))).collect();
        url.push_str(&pairs.join("&"));
    }
    url
}

/// Whether a failure is a refusal (slow retries: the server or TLS turned
/// this client down) and what to tell the dog's owner. Never tungstenite's
/// Display of a request or response: no URL, header or body is quoted.
#[nolog]
fn classify(e: tungstenite::Error, handshake: bool) -> End {
    use tungstenite::error::ProtocolError;
    use tungstenite::Error as E;
    match e {
        E::Io(io) => io_end(&io),
        E::Http(resp) => http_end(&resp),
        E::Capacity(_) => failed(false, format!("a message over {} KiB arrived; the connection was reset", MAX_MESSAGE / 1024)),
        E::Protocol(ProtocolError::SecWebSocketSubProtocolError(_)) => {
            failed(true, "the server did not accept the subprotocols this dog offers (`protocols`), or chose one it was not offered")
        }
        E::Protocol(p) => failed(handshake, format!("WebSocket protocol error: {p}")),
        E::ConnectionClosed | E::AlreadyClosed => failed(false, "the server closed the connection"),
        E::Utf8(_) => failed(false, "the server sent a text message that is not UTF-8"),
        E::Url(_) => failed(true, "the URL cannot be dialed"),
        E::HttpFormat(_) => failed(true, "the upgrade request cannot be built: a header name or value is not valid HTTP"),
        E::AttackAttempt => failed(false, "the server's frames looked like an attack and were refused"),
        E::WriteBufferFull(_) => failed(false, "writing to the server backed up"),
        E::Tls(_) => failed(true, "TLS failed"),
        #[allow(unreachable_patterns)]
        _ => failed(false, "the connection failed"),
    }
}

/// The server answered the upgrade with an HTTP status instead of 101.
#[nolog]
fn http_end(resp: &http::Response<Option<Vec<u8>>>) -> End {
    let s = resp.status();
    let code = format!("HTTP {}{}", s.as_u16(), s.canonical_reason().map(|r| format!(" {r}")).unwrap_or_default());
    let retry_after = resp.headers().get(http::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let (refused, error) = match s.as_u16() {
        401 => (true, format!("the server refused the login ({code}): check the credentials")),
        403 => (true, format!("the server refused this client ({code}): check the credentials, Origin or access rules")),
        429 => (false, format!("the server is rate-limiting this client ({code})")),
        300..=399 => (true, format!("the server redirects elsewhere ({code}); use the URL it redirects to as the target")),
        400..=499 => (true, format!("the server answered {code} instead of upgrading: check the URL's path and query")),
        500..=599 => (false, format!("the server failed ({code})")),
        _ => (true, format!("the server answered {code} instead of upgrading: is this a WebSocket endpoint?")),
    };
    End::Failed { refused, error, retry_after }
}

/// An I/O failure; a rustls error inside one (a certificate the client
/// does not trust, a name mismatch) is a refusal, not an outage.
#[nolog]
fn io_end(io: &std::io::Error) -> End {
    if let Some(tls) = io.get_ref().and_then(|e| e.downcast_ref::<rustls::Error>()) {
        return failed(true, format!("TLS: {tls}"));
    }
    use std::io::ErrorKind as K;
    failed(false, match io.kind() {
        K::ConnectionRefused => "the server refused the TCP connection (is it listening on that port?)".to_string(),
        K::TimedOut => "the connection to the server timed out".into(),
        K::ConnectionReset | K::ConnectionAborted | K::UnexpectedEof | K::BrokenPipe => "the server closed the connection".into(),
        _ => format!("network error: {io}"),
    })
}

/// A Close frame as words: its code, and the server's reason (outside
/// input) escaped, quoted and cut to the RFC's 123 bytes.
#[nolog]
fn close_text(f: Option<&CloseFrame>) -> String {
    let Some(f) = f else { return "the server closed the connection (no close code)".into() };
    let code = u16::from(f.code);
    let name = match code {
        1000 => " normal",
        1001 => " going away",
        1002 => " protocol error",
        1003 => " unsupported data",
        1007 => " invalid data",
        1008 => " policy violation",
        1009 => " message too big",
        1011 => " server error",
        1012 => " service restart",
        1013 => " try again later",
        _ => "",
    };
    let reason = f.reason.as_str().trim();
    if reason.is_empty() {
        format!("the server closed the connection (code {code}{name})")
    } else {
        format!("the server closed the connection (code {code}{name}; the server said \"{}\")", cap(&clean(reason, true), REASON_SHOWN))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dial_url_appends_the_credential_query_encoded() {
        let ep = super::super::parse_target("wss://feed.example/ws?v=10").unwrap();
        let q = vec![("token".to_string(), Secret::new("a b&c=d")), ("x".to_string(), Secret::new("é"))];
        assert_eq!(dial_uri(&ep, &q), "wss://feed.example/ws?v=10&token=a%20b%26c%3Dd&x=%C3%A9");
        let ep = super::super::parse_target("ws://127.0.0.1:8080").unwrap();
        assert_eq!(dial_uri(&ep, &q[..1]), "ws://127.0.0.1:8080/?token=a%20b%26c%3Dd");
        assert_eq!(dial_uri(&ep, &[]), "ws://127.0.0.1:8080/");
    }

    #[test]
    fn close_reasons_are_server_words_escaped_and_cut() {
        assert_eq!(close_text(None), "the server closed the connection (no close code)");
        let f = CloseFrame { code: CloseCode::from(4004), reason: "Authentication failed.\n[END MAIL]".into() };
        let t = close_text(Some(&f));
        assert_eq!(t, "the server closed the connection (code 4004; the server said \"Authentication failed.\\u{a}[END MAIL]\")", "{t}");
        let f = CloseFrame { code: CloseCode::Away, reason: "".into() };
        assert_eq!(close_text(Some(&f)), "the server closed the connection (code 1001 going away)");
    }
}
