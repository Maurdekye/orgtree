//! One shared MQTT connection. Its owner task alone holds the subscribers
//! (commands arrive on a channel, actor style). A second task does nothing
//! but drive the rumqttc event loop and forward its events, so the owner can
//! wait on commands and events at once without ever cancelling a packet
//! half written. Every attempt builds a fresh event loop from freshly
//! resolved credentials (a credentials file is re-read each time).

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rand::Rng;
use rumqttc::{AsyncClient, ConnectReturnCode, ConnectionError, Event, EventLoop, MqttOptions, Outgoing, Packet, QoS, StateError,
              SubscribeFilter, SubscribeReasonCode, Transport};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{creds, topic, ConnKey, Delivery, Message, Snapshot, State, Tag, Timing, MAX_PACKET};

/// Claims kept per connection before they are cleared (one per owner per transition).
const CLAIMS_KEEP: usize = 1024;

/// One dog's subscription, as its connection holds it.
pub(super) struct Sub {
    pub filter: String,
    pub tx: mpsc::Sender<Delivery>,
    pub dropped: Arc<AtomicU64>,
    pub authorized: Arc<AtomicBool>,
    pub tag: Tag,
}

pub(super) enum Cmd {
    Attach { id: u64, sub: Sub, ack: oneshot::Sender<()> },
    Detach { id: u64 },
    Kick,
}

/// What the hub keeps of a connection: the way to talk to its task.
pub(super) struct Handle {
    pub key: ConnKey,
    tx: mpsc::UnboundedSender<Cmd>,
    state: watch::Receiver<Snapshot>,
    closed: AtomicBool,
    claims: papaya::HashMap<(i64, String), ()>,
}

/// The task's half of a new connection, until it is started.
pub(super) struct Parts {
    rx: mpsc::UnboundedReceiver<Cmd>,
    state: watch::Sender<Snapshot>,
}

#[logged]
impl Handle {
    #[nolog]
    pub fn new(key: ConnKey) -> (Handle, Parts) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (state_tx, state) = watch::channel(Snapshot { state: State::Connecting { since: Utc::now() }, epoch: 0 });
        (Handle { key, tx, state, closed: AtomicBool::new(false), claims: papaya::HashMap::new() }, Parts { rx, state: state_tx })
    }

    /// Hand the task a command; false once the task has gone.
    #[nolog]
    pub fn send(&self, cmd: Cmd) -> bool {
        !self.closed() && self.tx.send(cmd).is_ok()
    }

    #[nolog]
    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    #[nolog]
    pub fn state(&self) -> watch::Receiver<Snapshot> {
        self.state.clone()
    }

    pub fn claim(&self, owner: i64, what: &str) -> bool {
        let claims = self.claims.pin();
        if claims.len() > CLAIMS_KEEP {
            claims.clear();
        }
        claims.insert((owner, what.to_string()), ()).is_none()
    }
}

/// Start the task of a connection the hub just registered.
#[logged]
pub(super) fn spawn(handle: Arc<Handle>, parts: Parts, source: creds::Source, timing: Timing,
                    conns: Arc<papaya::HashMap<ConnKey, Arc<Handle>>>, cancel: &CancellationToken) {
    let cancel = cancel.child_token();
    let span = crate::trace::request(&format!("mqtt:{}", handle.key.broker.url()));
    let mut task = Task {
        handle,
        rx: parts.rx,
        state: parts.state,
        source,
        timing,
        subs: HashMap::new(),
        backoff: Backoff::default(),
        last_kick: None,
        recent: VecDeque::new(),
        client_id: format!("orgtree-{}", crate::util::random_hex(6)),
    };
    tokio::spawn(tracing::Instrument::instrument(
        async move {
            task.run(&cancel).await;
            task.close(&conns);
        },
        span,
    ));
}

struct Task {
    handle: Arc<Handle>,
    rx: mpsc::UnboundedReceiver<Cmd>,
    state: watch::Sender<Snapshot>,
    source: creds::Source,
    timing: Timing,
    subs: HashMap<u64, Sub>,
    backoff: Backoff,
    last_kick: Option<Instant>,
    /// Digests of messages just routed, to fold a broker's per-subscription copies.
    recent: VecDeque<(u64, Instant)>,
    /// Ours unless the credentials name one.
    client_id: String,
}

/// How a session ended.
enum End {
    Cancelled,
    /// Its last dog left, or none may connect now: closed cleanly.
    Idle,
    Failed { refused: bool, error: String },
}

/// What a session knows about its live connection.
struct Live {
    client: AsyncClient,
    connected: bool,
    /// Filters asked of the broker this session (and not refused).
    subscribed: HashSet<String>,
    /// SUBSCRIBE batches sent, in order, until rumqttc names their packet id.
    queued: VecDeque<Vec<String>>,
    inflight: HashMap<u16, Vec<String>>,
}

#[logged]
impl Live {
    /// Ask for `filters` in one SUBSCRIBE (QoS 0). `again` asks even for a
    /// filter already held: the broker then replays its retained messages.
    #[nolog]
    fn subscribe(&mut self, filters: Vec<String>, again: bool) {
        let fresh: Vec<String> = filters.into_iter().filter(|f| again || !self.subscribed.contains(f)).collect();
        if fresh.is_empty() || !self.connected {
            return;
        }
        let packet = fresh.iter().map(|f| SubscribeFilter::new(f.clone(), QoS::AtMostOnce));
        match self.client.try_subscribe_many(packet) {
            Ok(()) => {
                self.subscribed.extend(fresh.iter().cloned());
                self.queued.push_back(fresh);
            }
            // the next CONNACK subscribes everything again
            Err(e) => tracing::warn!(error = %e, "mqtt subscribe could not be queued"),
        }
    }

    #[nolog]
    fn unsubscribe(&mut self, filter: &str) {
        if self.subscribed.remove(filter) && self.connected {
            if let Err(e) = self.client.try_unsubscribe(filter.to_string()) {
                tracing::warn!(error = %e, "mqtt unsubscribe could not be queued");
            }
        }
    }
}

#[logged]
impl Task {
    async fn run(&mut self, cancel: &CancellationToken) {
        loop {
            if cancel.is_cancelled() {
                return;
            }
            if self.subs.is_empty() && !self.linger(cancel).await {
                return;
            }
            if !self.authorized() {
                // none of its dogs may connect now: wait for one that may
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    cmd = self.rx.recv() => match cmd { Some(c) => self.command(c, None), None => return },
                }
                continue;
            }
            match self.session(cancel).await {
                End::Cancelled => return,
                // its last dog left and none came back within the linger,
                // or the connection failed while it waited: nobody to tell
                End::Idle | End::Failed { .. } if self.subs.is_empty() => return,
                End::Idle => {}
                End::Failed { refused, error } => {
                    let wait = self.backoff.failed(refused, &self.timing);
                    self.failed(refused, error, wait);
                    if !self.wait(wait, cancel).await {
                        return;
                    }
                }
            }
        }
    }

    /// No dog and no session (a fresh handle before its first attach, or
    /// every dog left during a backoff): keep the handle `linger` for one
    /// that may come. False when nobody came (the handle closes) or on
    /// cancel. A connected session lingers in [`Task::session`] instead.
    async fn linger(&mut self, cancel: &CancellationToken) -> bool {
        let until = Instant::now() + self.timing.linger;
        while self.subs.is_empty() {
            tokio::select! {
                _ = cancel.cancelled() => return false,
                _ = tokio::time::sleep_until(until) => return false,
                cmd = self.rx.recv() => match cmd { Some(c) => self.command(c, None), None => return false },
            }
        }
        true
    }

    /// Wait out a backoff. True to try again (time is up, a kick, or a new
    /// dog arrived at most once per `kick_gap`), false on cancel.
    async fn wait(&mut self, dur: Duration, cancel: &CancellationToken) -> bool {
        let until = Instant::now() + dur;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return false,
                _ = tokio::time::sleep_until(until) => return true,
                cmd = self.rx.recv() => {
                    let Some(cmd) = cmd else { return false };
                    let kick = matches!(cmd, Cmd::Kick | Cmd::Attach { .. });
                    self.command(cmd, None);
                    if self.subs.is_empty() || (kick && self.kick_allowed()) {
                        return true;
                    }
                }
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

    #[nolog]
    fn authorized(&self) -> bool {
        self.subs.values().any(|s| s.authorized.load(Ordering::Acquire))
    }

    /// Apply a command; `live` is the connected session, if any.
    #[nolog]
    fn command(&mut self, cmd: Cmd, live: Option<&mut Live>) {
        match cmd {
            Cmd::Attach { id, sub, ack } => {
                let filter = sub.filter.clone();
                self.subs.insert(id, sub);
                let _ = ack.send(());
                if let Some(live) = live {
                    // a second dog on a held filter subscribes again, so the
                    // broker replays the retained messages it would see
                    live.subscribe(vec![filter], true);
                }
            }
            Cmd::Detach { id } => {
                if let Some(sub) = self.subs.remove(&id) {
                    if let Some(live) = live {
                        if !self.subs.values().any(|s| s.filter == sub.filter) {
                            live.unsubscribe(&sub.filter);
                        }
                    }
                }
            }
            Cmd::Kick => {}
        }
    }

    /// One connection attempt and, when it is accepted, the session it starts.
    async fn session(&mut self, cancel: &CancellationToken) -> End {
        let resolved = match creds::resolve(&self.source, &self.handle.key.broker) {
            Ok(r) => r,
            Err(e) => return End::Failed { refused: true, error: e },
        };
        let (client, eventloop) = connect_parts(&self.handle.key, &resolved, &self.client_id, &self.timing);
        drop(resolved);
        let (ev_tx, mut ev_rx) = mpsc::channel(64);
        let pumping = tokio::spawn(tracing::Instrument::instrument(pump(eventloop, ev_tx), tracing::Span::current()));
        let mut live = Live { client, connected: false, subscribed: HashSet::new(), queued: VecDeque::new(), inflight: HashMap::new() };
        // set while no dog is left: the session stays open `linger` for one
        // that may come back, then ends
        let mut idle: Option<Instant> = None;
        let end = loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break End::Cancelled,
                cmd = self.rx.recv() => {
                    let Some(cmd) = cmd else { break End::Cancelled };
                    let connected = live.connected;
                    self.command(cmd, if connected { Some(&mut live) } else { None });
                    if self.subs.is_empty() {
                        idle.get_or_insert_with(|| Instant::now() + self.timing.linger);
                    } else if !self.authorized() {
                        break End::Idle;
                    } else {
                        idle = None;
                    }
                }
                _ = tokio::time::sleep_until(idle.unwrap_or_else(Instant::now)), if idle.is_some() => break End::Idle,
                ev = ev_rx.recv() => match ev {
                    None => break End::Failed { refused: false, error: "the connection's event loop stopped".into() },
                    Some(Ok(event)) => self.event(event, &mut live),
                    Some(Err(e)) => {
                        let (refused, error) = classify(&e);
                        break End::Failed { refused, error };
                    }
                },
            }
        };
        if !matches!(end, End::Failed { .. }) && live.connected {
            // a clean goodbye when we chose to leave
            let _ = live.client.try_disconnect();
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                while let Some(Ok(e)) = ev_rx.recv().await {
                    if matches!(e, Event::Outgoing(Outgoing::Disconnect)) {
                        break;
                    }
                }
            })
            .await;
        }
        pumping.abort();
        end
    }

    #[nolog]
    fn event(&mut self, event: Event, live: &mut Live) {
        match event {
            Event::Incoming(Packet::ConnAck(_)) => {
                live.connected = true;
                self.backoff.connected();
                self.set(State::Connected { since: Utc::now() });
                let mut filters: Vec<String> = self.subs.values().map(|s| s.filter.clone()).collect::<HashSet<_>>().into_iter().collect();
                filters.sort();
                live.subscribed.clear();
                live.subscribe(filters, false);
            }
            Event::Outgoing(Outgoing::Subscribe(pkid)) => {
                if let Some(batch) = live.queued.pop_front() {
                    live.inflight.insert(pkid, batch);
                }
            }
            Event::Incoming(Packet::SubAck(ack)) => {
                let Some(batch) = live.inflight.remove(&ack.pkid) else { return };
                for (filter, code) in batch.iter().zip(ack.return_codes.iter()) {
                    let refused = matches!(code, SubscribeReasonCode::Failure);
                    if refused {
                        live.subscribed.remove(filter);
                        tracing::warn!(filter = %filter, "mqtt subscription refused by the broker");
                    }
                    for s in self.subs.values().filter(|s| &s.filter == filter) {
                        let d = if refused { Delivery::Refused { filter: filter.clone() } } else { Delivery::Subscribed { filter: filter.clone() } };
                        let _ = s.tx.try_send(d);
                    }
                }
            }
            Event::Incoming(Packet::Publish(p)) => self.route(p, live),
            _ => {}
        }
    }

    /// Hand a PUBLISH to every dog whose filter matches it. A broker sends
    /// one copy per matching subscription, so when two different filters
    /// match, identical copies within `dedupe` are one message.
    #[nolog]
    fn route(&mut self, p: rumqttc::Publish, live: &Live) {
        let matching: Vec<u64> = self.subs.iter().filter(|(_, s)| topic::matches(&s.filter, &p.topic)).map(|(id, _)| *id).collect();
        if matching.is_empty() {
            return;
        }
        let filters: HashSet<&str> = matching.iter().map(|id| self.subs[id].filter.as_str()).filter(|f| live.subscribed.contains(*f)).collect();
        if filters.len() > 1 {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            (&p.topic, p.retain, p.payload.as_ref()).hash(&mut h);
            let digest = h.finish();
            let now = Instant::now();
            while self.recent.front().is_some_and(|(_, t)| now.duration_since(*t) >= self.timing.dedupe) {
                self.recent.pop_front();
            }
            if self.recent.iter().any(|(d, _)| *d == digest) {
                return;
            }
            self.recent.push_back((digest, now));
            if self.recent.len() > 64 {
                self.recent.pop_front();
            }
        }
        let msg = Message { topic: p.topic, payload: p.payload, retained: p.retain, at: Utc::now() };
        for id in matching {
            let s = &self.subs[&id];
            if s.tx.try_send(Delivery::Message(msg.clone())).is_err() {
                s.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Record a failed attempt: an outage keeps the time it began.
    #[nolog]
    fn failed(&mut self, refused: bool, error: String, wait: Duration) {
        let now = Utc::now();
        let retry_at = now + chrono::Duration::from_std(wait).unwrap_or_default();
        let since = match &self.state.borrow().state {
            State::Down { since, .. } | State::Refused { since, .. } => *since,
            _ => now,
        };
        tracing::info!(broker = %self.handle.key.broker.url(), refused, error = %error, retry_s = wait.as_secs(), "mqtt connection failed");
        self.set(if refused { State::Refused { since, error, retry_at } } else { State::Down { since, error, retry_at } });
    }

    #[nolog]
    fn set(&self, next: State) {
        self.state.send_modify(|snap| {
            let refusal_changed = matches!((&snap.state, &next), (State::Refused { error: a, .. }, State::Refused { error: b, .. }) if a != b);
            if std::mem::discriminant(&snap.state) != std::mem::discriminant(&next) || refusal_changed {
                snap.epoch += 1;
                if let State::Connected { .. } = next {
                    tracing::info!(broker = %self.handle.key.broker.url(), "mqtt connected");
                }
            }
            snap.state = next;
        });
    }

    /// The connection is going: mark it closed, leave the hub, and refuse
    /// commands that raced in (their senders retry on a fresh connection).
    #[nolog]
    fn close(&mut self, conns: &papaya::HashMap<ConnKey, Arc<Handle>>) {
        self.handle.closed.store(true, Ordering::Release);
        let me = self.handle.clone();
        let _ = conns.pin().remove_if(&me.key, |_, h| Arc::ptr_eq(h, &me));
        self.rx.close();
        while let Ok(cmd) = self.rx.try_recv() {
            drop(cmd);
        }
        self.subs.clear();
    }
}

/// Network and refusal backoff: a network failure doubles the wait up to
/// `net_max` and starts over only after a connection stayed up `stable`;
/// a refusal walks `refused` and starts over on the next accepted connect.
#[derive(Default)]
struct Backoff {
    net: u32,
    refused: u32,
    connected_at: Option<Instant>,
}

#[logged]
impl Backoff {
    #[nolog]
    fn connected(&mut self) {
        self.connected_at = Some(Instant::now());
        self.refused = 0;
    }

    #[nolog]
    fn failed(&mut self, refused: bool, t: &Timing) -> Duration {
        if let Some(at) = self.connected_at.take() {
            if at.elapsed() >= t.stable {
                self.net = 0;
            }
        }
        let base = if refused {
            let d = t.refused.get(self.refused as usize).or(t.refused.last()).copied().unwrap_or(Duration::from_secs(60));
            self.refused = self.refused.saturating_add(1);
            d
        } else {
            let d = t.net_first.saturating_mul(1u32 << self.net.min(16)).min(t.net_max);
            self.net = self.net.saturating_add(1);
            d
        };
        if t.jitter { base.mul_f64(rand::thread_rng().gen_range(0.8..1.2)) } else { base }
    }
}

/// rumqttc's client and event loop for one attempt. `#[nolog]`: the options
/// hold the password and rumqttc's Debug prints it.
#[nolog]
fn connect_parts(key: &ConnKey, r: &creds::Resolved, own_id: &str, t: &Timing) -> (AsyncClient, EventLoop) {
    let id = r.client_id.clone().or_else(|| key.client_id.clone()).unwrap_or_else(|| own_id.to_string());
    let mut o = MqttOptions::new(id, key.broker.host.clone(), key.broker.port);
    o.set_keep_alive(t.keep_alive.max(Duration::from_secs(1)));
    o.set_clean_session(true);
    o.set_max_packet_size(MAX_PACKET, 64 * 1024);
    o.set_request_channel_capacity(64);
    if let Some((user, pass)) = &r.login {
        o.set_credentials(user.expose(), pass.expose());
    }
    if let Some(tls) = &r.tls {
        o.set_transport(Transport::tls_with_config(rumqttc::TlsConfiguration::Rustls(tls.clone())));
    }
    let (client, mut ev) = AsyncClient::new(o, 64);
    let mut net = rumqttc::NetworkOptions::new();
    net.set_connection_timeout(t.connect_timeout.as_secs().max(1));
    ev.set_network_options(net);
    (client, ev)
}

/// Drive the event loop and forward what it yields, up to its first error.
#[nolog]
async fn pump(mut ev: EventLoop, tx: mpsc::Sender<Result<Event, ConnectionError>>) {
    loop {
        let e = ev.poll().await;
        let stop = e.is_err();
        if tx.send(e).await.is_err() || stop {
            return;
        }
    }
}

/// Whether a failure is a refusal (wrong credentials, certificates, client
/// id or protocol: slow retries) and what to tell the dog's owner. Never
/// rumqttc's Display of a packet: that would carry payload bytes.
#[nolog]
pub(super) fn classify(e: &ConnectionError) -> (bool, String) {
    match e {
        ConnectionError::ConnectionRefused(code) => match code {
            ConnectReturnCode::BadUserNamePassword => (true, "the broker refused the username or password (CONNACK 4)".into()),
            ConnectReturnCode::NotAuthorized => (true, "the broker refused this client: not authorized (CONNACK 5)".into()),
            ConnectReturnCode::BadClientId => (true, "the broker rejected the client id (CONNACK 2)".into()),
            ConnectReturnCode::RefusedProtocolVersion => (true, "the broker does not accept MQTT 3.1.1 (CONNACK 1)".into()),
            ConnectReturnCode::ServiceUnavailable => (false, "the broker's MQTT service is unavailable (CONNACK 3)".into()),
            ConnectReturnCode::Success => (false, "the broker accepted the connection, then ended it".into()),
        },
        ConnectionError::Tls(rumqttc::TlsError::Io(io)) => io_failure(io),
        ConnectionError::Tls(other) => (true, format!("TLS: {other}")),
        ConnectionError::Io(io) => io_failure(io),
        ConnectionError::NetworkTimeout => (false, "no answer from the broker within the connect timeout".into()),
        ConnectionError::FlushTimeout => (false, "writing to the broker timed out".into()),
        // in TLS 1.3 a broker refuses a missing client certificate after the
        // handshake: the alert arrives on the first read, which rumqttc's
        // codec wraps as a deserialization error (framed.rs)
        ConnectionError::MqttState(StateError::Deserialization(rumqttc::mqttbytes::Error::Io(io))) => io_failure(io),
        ConnectionError::MqttState(StateError::Io(io)) => io_failure(io),
        ConnectionError::MqttState(s) => (false, state_text(s)),
        ConnectionError::NotConnAck(_) => (false, "the broker answered CONNECT with something other than CONNACK".into()),
        ConnectionError::RequestsDone => (false, "the connection's request channel closed".into()),
        #[allow(unreachable_patterns)]
        _ => (false, "the connection failed".into()),
    }
}

/// An I/O failure; a rustls error inside one (a certificate the client
/// does not trust, a name mismatch) is a refusal, not an outage.
#[nolog]
fn io_failure(io: &std::io::Error) -> (bool, String) {
    if let Some(tls) = io.get_ref().and_then(|e| e.downcast_ref::<rustls::Error>()) {
        return (true, format!("TLS: {tls}"));
    }
    (false, io_text(io))
}

#[nolog]
fn io_text(io: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    match io.kind() {
        K::ConnectionRefused => "the broker host refused the TCP connection (is the broker listening on that port?)".into(),
        K::TimedOut => "the connection to the broker timed out".into(),
        K::ConnectionReset | K::ConnectionAborted | K::UnexpectedEof | K::BrokenPipe => "the broker closed the connection".into(),
        _ => format!("network error: {io}"),
    }
}

#[nolog]
fn state_text(s: &StateError) -> String {
    match s {
        StateError::Io(io) => io_text(io),
        StateError::AwaitPingResp => "the broker stopped answering keepalive pings".into(),
        StateError::ConnectionAborted => "the broker closed the connection".into(),
        StateError::Deserialization(rumqttc::mqttbytes::Error::PayloadSizeLimitExceeded(n)) => {
            format!("a message of {n} bytes is over the {} KiB packet limit; the connection was reset", MAX_PACKET / 1024)
        }
        StateError::Deserialization(e) => format!("the broker sent a malformed packet ({e})"),
        other => format!("MQTT protocol error: {other}"),
    }
}
