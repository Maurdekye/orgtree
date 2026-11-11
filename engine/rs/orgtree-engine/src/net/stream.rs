//! The hub stream (Mail hub 2.5.0, `GET /api/stream`; docket
//! mail-hub-websocket-for-new-mail-clients-prefer-i, spec-hub-websocket.md
//! sections 9 and 14).
//!
//! One [`Carrier`] per poller owns the state machine of spec 9.1 to 9.4 for
//! one hub address: it reads `/healthz`, opens a stream when the hub lists
//! `stream`, and carries each poll over it. When the stream cannot be used it
//! answers [`Polled::Http`] and the poller makes today's HTTP long poll, so a
//! stream failure is never a hub failure. A switch happens only between
//! polls, so the poll queue never changes. The secret travels in `X-Org-Auth`
//! (never in the URL) and is never logged; every function that sees it is
//! `#[nolog]`.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{self, Message};

const PROTO: &str = "orgtree-hub-stream.1";
/// the largest answer read (spec 8: at least 64 MiB)
const MAX_ANSWER: usize = 64 * 1024 * 1024;
/// connect + TLS + 101, and the welcome after the hello
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// the health probe
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// an answer must come within the poll's wait plus this
const ANSWER_SLACK: Duration = Duration::from_secs(15);
/// a stream that ends sooner than this after its welcome, with no answer, is short-lived
const SHORT_SESSION: Duration = Duration::from_secs(30);
const SHORT_SESSIONS_UNUSABLE: u32 = 3;
/// minutes of long polling before the next stream attempt (spec 9.3); the last repeats
const PROBE_MINUTES: [u64; 4] = [1, 5, 15, 60];
/// seconds before a reconnect after a drop (spec 9.4); the last repeats
const RECONNECT_SECS: [f64; 6] = [1.0, 2.0, 4.0, 8.0, 16.0, 30.0];
/// a hub without the feature is looked at again this often
const REPROBE: Duration = Duration::from_secs(30 * 60);

/// What the poller does with one poll.
#[derive(Debug)]
pub(super) enum Polled {
    /// carry this poll over HTTP, as before
    Http,
    /// the hub's answer: its status and JSON body (a 401 included: the
    /// poller handles it as it handles an HTTP 401)
    Answer(u16, Value),
}

type Socket = tokio_tungstenite::WebSocketStream<Box<dyn Io>>;

trait Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Io for T {}

struct Conn {
    ws: Socket,
    opened: Instant,
    answered: bool,
}

pub(super) struct Carrier {
    /// the hub's /healthz has been read since the last reason to look again
    probed: bool,
    listed: bool,
    version: Option<String>,
    probed_at: Option<Instant>,
    conn: Option<Conn>,
    next_id: u64,
    /// no stream attempt before this while long polling
    next_attempt: Option<Instant>,
    probe_step: usize,
    reconnect_step: usize,
    short_sessions: u32,
    /// 1009 or 4400: a bug on one side; HTTP until the app restarts
    off_for_good: bool,
    /// a 401 on the stream was already handed to the poller once
    unauthorized_once: bool,
    /// the next retry is an ordinary reconnect: wait out the back-off first
    pause_next: bool,
    /// test knob: every back-off is divided by it
    div: u32,
}

impl Default for Carrier {
    fn default() -> Self {
        Carrier::new()
    }
}

impl Drop for Carrier {
    /// The poller ended (its members changed, or the engine is stopping):
    /// say goodbye with 1000 so the hub does not count a failure.
    fn drop(&mut self) {
        if let Some(mut c) = self.conn.take() {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    let frame = CloseFrame { code: CloseCode::Normal, reason: "".into() };
                    let _ = tokio::time::timeout(Duration::from_secs(1), c.ws.close(Some(frame))).await;
                });
            }
        }
    }
}

/// Why a stream could not be opened.
enum Opening {
    /// 401 at the handshake or the hello
    Unauthorized,
    /// 403 with an empty body: today's hub refusing every upgrade
    Downgraded,
    /// HTTP, and try again after this (None: the schedule's next step)
    Failed(Option<Duration>),
}

/// What one trip over the stream came to.
enum Trip {
    Answer(u16, Value),
    /// it ended: ask again (after the back-off if `pause_next`)
    Retry,
}

#[nolog]
fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `http://h/x` -> `ws://h/x/api/stream`; `https` -> `wss`.
#[nolog]
fn stream_url(address: &str) -> String {
    let base = address.trim_end_matches('/');
    let swapped = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{swapped}/api/stream")
}

#[nolog]
fn jitter(secs: f64) -> f64 {
    use rand::Rng;
    secs * rand::thread_rng().gen_range(0.8..1.2)
}

#[logged]
impl Carrier {
    pub(super) fn new() -> Self {
        Carrier {
            probed: false,
            listed: false,
            version: None,
            probed_at: None,
            conn: None,
            next_id: 0,
            next_attempt: None,
            probe_step: 0,
            reconnect_step: 0,
            short_sessions: 0,
            off_for_good: false,
            unauthorized_once: false,
            pause_next: false,
            div: 1,
        }
    }

    #[cfg(test)]
    pub(super) fn with_time_div(div: u32) -> Self {
        Carrier { div: div.max(1), ..Carrier::new() }
    }

    fn scaled(&self, d: Duration) -> Duration {
        d / self.div
    }

    /// Carry one poll (`wait` seconds) for the members whose joined
    /// `X-Org-Auth` is `auth`: over the stream when the hub offers it and the
    /// schedule allows, else tell the poller to use HTTP.
    #[nolog]
    pub(super) async fn poll(&mut self, addr: &str, auth: &str, wait: u64) -> Polled {
        let mut handshake_403 = false;
        loop {
            if !self.probed || (!self.listed && self.probed_at.is_some_and(|t| t.elapsed() >= self.scaled(REPROBE))) {
                if !self.probe(addr).await {
                    // the hub could not be read: today's HTTP handling owns the failure
                    return Polled::Http;
                }
            }
            if !self.use_stream() {
                return Polled::Http;
            }
            if self.conn.is_none() {
                match self.open(addr, auth).await {
                    Ok(()) => {}
                    Err(Opening::Unauthorized) => {
                        if self.unauthorized_once {
                            self.fall_back(PROBE_MINUTES[0]);
                            return Polled::Http;
                        }
                        self.unauthorized_once = true;
                        return Polled::Answer(401, json!({ "detail": "no valid org credentials" }));
                    }
                    Err(Opening::Downgraded) if !handshake_403 => {
                        // a 403 with no body is a hub that no longer has the stream: look again
                        handshake_403 = true;
                        self.probed = false;
                        continue;
                    }
                    Err(Opening::Downgraded) => {
                        self.fall_back(PROBE_MINUTES[0]);
                        self.probe_step = 1;
                        return Polled::Http;
                    }
                    Err(Opening::Failed(after)) => {
                        self.fall_back_for(after);
                        return Polled::Http;
                    }
                }
                continue;
            }
            match self.trip(wait).await {
                Trip::Answer(status, body) => {
                    // a new version in an answer: look at /healthz again after it (spec 9.3)
                    if body["version"].as_str().is_some() && body["version"].as_str() != self.version.as_deref() {
                        self.probed = false;
                    }
                    return Polled::Answer(status, body);
                }
                Trip::Retry => {
                    if std::mem::take(&mut self.pause_next) {
                        self.pause().await;
                    }
                    if !self.use_stream() {
                        return Polled::Http;
                    }
                }
            }
        }
    }

    fn use_stream(&self) -> bool {
        self.listed && !self.off_for_good && self.next_attempt.is_none_or(|t| Instant::now() >= t)
    }

    /// Read `/healthz`; false when the hub could not be read.
    async fn probe(&mut self, addr: &str) -> bool {
        let Some(health) = super::transport::healthz(addr, PROBE_TIMEOUT).await else { return false };
        self.probed = true;
        self.probed_at = Some(Instant::now());
        self.listed = health["features"].as_array().is_some_and(|f| f.iter().any(|x| x == "stream"));
        self.version = health["version"].as_str().map(str::to_string);
        if !self.listed {
            self.conn = None;
            self.next_attempt = None;
        }
        true
    }

    /// HTTP until the schedule's next step (spec 9.3).
    fn fall_back(&mut self, minutes: u64) {
        let wait = self.scaled(Duration::from_secs(minutes * 60));
        self.fall_back_for(Some(wait));
    }

    fn fall_back_for(&mut self, after: Option<Duration>) {
        let wait = match after {
            Some(d) => d,
            None => {
                let m = PROBE_MINUTES[self.probe_step.min(PROBE_MINUTES.len() - 1)];
                self.probe_step = (self.probe_step + 1).min(PROBE_MINUTES.len() - 1);
                self.scaled(Duration::from_secs(m * 60))
            }
        };
        self.conn = None;
        self.next_attempt = Some(Instant::now() + wait);
        tracing::info!(next_attempt_ms = unix_ms() + wait.as_millis() as u64, "hub stream unusable: long polling for now");
    }

    /// Wait out the reconnect back-off (spec 9.4).
    async fn pause(&mut self) {
        let secs = RECONNECT_SECS[self.reconnect_step.min(RECONNECT_SECS.len() - 1)];
        self.reconnect_step += 1;
        tokio::time::sleep(self.scaled(Duration::from_secs_f64(jitter(secs)))).await;
    }

    /// Connect, hello, welcome (spec 9.2).
    #[nolog]
    async fn open(&mut self, addr: &str, auth: &str) -> Result<(), Opening> {
        let ep = crate::ws::parse_target(&stream_url(addr)).map_err(|_| Opening::Failed(None))?;
        let attempt = async {
            let tcp = TcpStream::connect((ep.host.as_str(), ep.port)).await.map_err(|_| Opening::Failed(None))?;
            let _ = tcp.set_nodelay(true);
            let io: Box<dyn Io> = if ep.tls {
                let cfg = crate::ws::creds::default_tls(&ep).ok().flatten().ok_or(Opening::Failed(None))?;
                let name = rustls::pki_types::ServerName::try_from(ep.host.clone()).map_err(|_| Opening::Failed(None))?;
                Box::new(tokio_rustls::TlsConnector::from(cfg).connect(name, tcp).await.map_err(|_| Opening::Failed(None))?)
            } else {
                Box::new(tcp)
            };
            let uri: http::Uri = ep.url().parse().map_err(|_| Opening::Failed(None))?;
            let req = ClientRequestBuilder::new(uri).with_header("X-Org-Auth", auth.to_string()).with_sub_protocol(PROTO);
            let mut cfg = WebSocketConfig::default();
            cfg.max_message_size = Some(MAX_ANSWER);
            cfg.max_frame_size = Some(MAX_ANSWER);
            match tokio_tungstenite::client_async_with_config(req, io, Some(cfg)).await {
                Ok((ws, _)) => Ok(ws),
                Err(tungstenite::Error::Http(resp)) => {
                    let code = resp.status().as_u16();
                    let empty = resp.body().as_ref().is_none_or(|b| b.is_empty());
                    Err(match code {
                        403 if empty => Opening::Downgraded,
                        401 => Opening::Unauthorized,
                        503 => Opening::Failed(Some(self.scaled(Duration::from_secs(30)))),
                        _ => Opening::Failed(None),
                    })
                }
                Err(_) => Err(Opening::Failed(None)),
            }
        };
        let mut ws = tokio::time::timeout(OPEN_TIMEOUT, attempt).await.map_err(|_| Opening::Failed(None))??;
        let hello = json!({ "type": "hello", "v": 1, "client": format!("orgtree-engine/{}", env!("CARGO_PKG_VERSION")) });
        if ws.send(Message::Text(hello.to_string().into())).await.is_err() {
            return Err(Opening::Failed(None));
        }
        let welcome = tokio::time::timeout(OPEN_TIMEOUT, async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => return Ok(serde_json::from_str::<Value>(t.as_str()).ok()),
                    Some(Ok(Message::Close(f))) => return Err(f.map(|f| u16::from(f.code))),
                    Some(Ok(_)) => continue,
                    _ => return Err(None),
                }
            }
        })
        .await;
        match welcome {
            Ok(Ok(Some(w))) if w["type"] == "welcome" => {}
            Ok(Err(Some(4401))) => return Err(Opening::Unauthorized),
            Ok(Err(Some(4429))) => return Err(Opening::Failed(Some(self.scaled(Duration::from_secs(15 * 60))))),
            Ok(Err(Some(1009 | 4400))) => {
                self.off_for_good = true;
                tracing::warn!("hub stream refused as a protocol error; long polling until the engine restarts");
                return Err(Opening::Failed(Some(self.scaled(Duration::from_secs(60 * 60)))));
            }
            _ => return Err(Opening::Failed(None)),
        }
        self.conn = Some(Conn { ws, opened: Instant::now(), answered: false });
        self.unauthorized_once = false;
        self.probe_step = 0;
        self.next_attempt = None;
        Ok(())
    }

    /// One poll over the open stream and its answer (spec 5.1, 7.1).
    #[nolog]
    async fn trip(&mut self, wait: u64) -> Trip {
        self.next_id += 1;
        let id = self.next_id;
        let frame = json!({ "type": "poll", "id": id, "body": { "wait": wait } });
        let deadline = Duration::from_secs(wait) + ANSWER_SLACK;
        let outcome = {
            let conn = self.conn.as_mut().expect("an open stream");
            match conn.ws.send(Message::Text(frame.to_string().into())).await {
                Err(_) => Err(None),
                Ok(()) => tokio::time::timeout(deadline, async {
                    loop {
                        match conn.ws.next().await {
                            Some(Ok(Message::Text(t))) => {
                                let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                                if v["type"] == "answer" && v["id"].as_u64() == Some(id) {
                                    return Ok((v["status"].as_u64().unwrap_or(500) as u16, v["body"].clone()));
                                }
                            }
                            Some(Ok(Message::Close(f))) => return Err(f.map(|f| u16::from(f.code))),
                            Some(Ok(_)) => {}
                            _ => return Err(None),
                        }
                    }
                })
                .await
                .unwrap_or(Err(None)),
            }
        };
        match outcome {
            Ok((status, body)) => {
                if let Some(c) = self.conn.as_mut() {
                    c.answered = true;
                }
                self.reconnect_step = 0;
                self.short_sessions = 0;
                Trip::Answer(status, body)
            }
            Err(code) => self.dropped(code),
        }
    }

    /// The stream ended (spec 9.3, 9.4): decide what the poll does next.
    fn dropped(&mut self, code: Option<u16>) -> Trip {
        let conn = self.conn.take();
        match code {
            Some(4401) => {
                if self.unauthorized_once {
                    self.fall_back(PROBE_MINUTES[0]);
                    return Trip::Retry;
                }
                self.unauthorized_once = true;
                return Trip::Answer(401, json!({ "detail": "no valid org credentials" }));
            }
            Some(4429) => {
                self.fall_back(15);
                return Trip::Retry;
            }
            Some(1009 | 4400) => {
                self.off_for_good = true;
                tracing::warn!("hub stream closed as a protocol error; long polling until the engine restarts");
                self.fall_back(60);
                return Trip::Retry;
            }
            _ => {}
        }
        if let Some(c) = &conn {
            if !c.answered && c.opened.elapsed() < self.scaled(SHORT_SESSION) {
                self.short_sessions += 1;
                if self.short_sessions >= SHORT_SESSIONS_UNUSABLE {
                    self.short_sessions = 0;
                    self.fall_back_for(None);
                    return Trip::Retry;
                }
            }
        }
        // 1012: the hub is restarting, so start the back-off higher
        if code == Some(1012) && self.reconnect_step < 1 {
            self.reconnect_step = 1;
        }
        self.pause_next = true;
        Trip::Retry
    }
}
