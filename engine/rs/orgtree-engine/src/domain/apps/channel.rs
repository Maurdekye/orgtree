//! The live channel for apps (USER 2026-11-11 m27cc41f6b6d1; spec section 5): `orgtree.net.connect(url)` opens a
//! WebSocket that the ENGINE holds for the app and relays both ways through the panel bridge. The frame's
//! no-network policy never changes: no socket reaches the frame, the engine dials (with the app's address decision,
//! pinning and saved login), and messages come back by long poll (`net.recv`).
//!
//! Limits (spec 5.3): 4 channels per app, 2 per panel copy; 256 queued events or 4 MiB (past that the channel closes
//! with reason `overflow`); sends 64 KiB and 60 a minute per channel; one `net.recv` in flight per channel (25 s long
//! poll); a channel nobody polls for 60 s is abandoned. Binary frames are counted and dropped.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::bridge::{Action, Bound};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::ws;

pub const QUEUE_EVENTS: usize = 256;
pub const QUEUE_BYTES: usize = 4 * 1024 * 1024;
pub const SEND_MAX: usize = ws::SEND_MAX;
pub const SENDS_PER_MINUTE: usize = 60;
pub const RECV_WAIT: Duration = Duration::from_secs(25);
pub const ABANDON_AFTER: Duration = Duration::from_secs(60);
pub const PER_APP: usize = 4;
pub const PER_PANEL: usize = 2;
/// Panel History rows per channel per hour; further changes are counted into the next row.
pub const HISTORY_PER_HOUR: usize = 60;
/// How long a closed channel stays readable, so its last `net.recv` sees the closing state.
pub const TOMBSTONE: Duration = Duration::from_secs(10);

/// One thing the app reads: a text message, or a state change.
#[derive(Clone, Debug)]
pub enum Ev {
    Message(String),
    State { state: &'static str, reason: Option<String>, login: bool, reconnected: bool },
}
impl Ev {
    #[nolog]
    fn json(&self, seq: u64) -> Value {
        match self {
            Ev::Message(text) => json!({"seq":seq,"type":"message","text":text}),
            Ev::State { state, reason, login, reconnected } => {
                let mut v = json!({"seq":seq,"type":"state","state":state,"login":login});
                if let Some(r) = reason {
                    v["reason"] = json!(r);
                }
                if *reconnected {
                    v["reconnected"] = json!(true);
                }
                v
            }
        }
    }
    #[nolog]
    fn size(&self) -> usize {
        match self {
            Ev::Message(t) => t.len(),
            Ev::State { .. } => 0,
        }
    }
}

/// What the engine keeps for the app until it reads it: bounded, ordered, acknowledged by `after`.
#[derive(Default)]
pub struct Queue {
    events: VecDeque<(u64, Ev)>,
    bytes: usize,
    next: u64,
}
impl Queue {
    #[nolog]
    pub fn new() -> Queue {
        Queue::default()
    }
    /// Queue a message. False when the queue is now past its bounds: the caller closes the channel (`overflow`).
    #[nolog]
    pub fn push(&mut self, ev: Ev) -> bool {
        self.next += 1;
        self.bytes += ev.size();
        self.events.push_back((self.next, ev));
        self.events.len() <= QUEUE_EVENTS && self.bytes <= QUEUE_BYTES
    }
    /// Forget what the app has acknowledged, and return everything after it.
    #[nolog]
    pub fn take(&mut self, after: u64) -> Vec<Value> {
        while self.events.front().is_some_and(|(seq, _)| *seq <= after) {
            if let Some((_, ev)) = self.events.pop_front() {
                self.bytes -= ev.size();
            }
        }
        self.events.iter().map(|(seq, ev)| ev.json(*seq)).collect()
    }
    /// Drop everything unread (an overflow keeps none of it).
    #[nolog]
    pub fn clear(&mut self) {
        self.events.clear();
        self.bytes = 0;
    }
    #[nolog]
    pub fn len(&self) -> usize {
        self.events.len()
    }
}

/// One channel as the bridge and its task share it.
pub struct Shared {
    pub id: String,
    pub site: String,
    /// wss (true) or ws.
    pub secure: bool,
    /// Reaches a site allowed on the private network.
    pub private: bool,
    queue: Mutex<Queue>,
    notify: Notify,
    link: Mutex<Option<ws::Link>>,
    sends: Mutex<VecDeque<Instant>>,
    last_recv: Mutex<Instant>,
    recving: AtomicBool,
    reason: Mutex<Option<String>>,
    closed: AtomicBool,
    login: AtomicBool,
    pub received: AtomicU64,
    pub dropped_binary: AtomicU64,
    cancel: CancellationToken,
}
impl Shared {
    #[nolog]
    pub fn new(id: String, site: String, secure: bool, private: bool, cancel: CancellationToken) -> Arc<Shared> {
        Arc::new(Shared {
            id,
            site,
            secure,
            private,
            queue: Mutex::new(Queue::new()),
            notify: Notify::new(),
            link: Mutex::new(None),
            sends: Mutex::new(VecDeque::new()),
            last_recv: Mutex::new(Instant::now()),
            recving: AtomicBool::new(false),
            reason: Mutex::new(None),
            closed: AtomicBool::new(false),
            login: AtomicBool::new(false),
            received: AtomicU64::new(0),
            dropped_binary: AtomicU64::new(0),
            cancel,
        })
    }
    #[nolog]
    pub fn set_link(&self, link: ws::Link) {
        *self.link.lock().unwrap_or_else(|e| e.into_inner()) = Some(link);
    }
    #[nolog]
    pub fn set_login(&self, attached: bool) {
        self.login.store(attached, Ordering::Relaxed);
    }
    #[nolog]
    pub fn login(&self) -> bool {
        self.login.load(Ordering::Relaxed)
    }
    #[nolog]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    /// End the channel for `reason` (the first reason stands): its task says goodbye (Close 1001, within a second)
    /// and the app reads `{state:'closed', reason}` as its last event.
    #[nolog]
    pub fn end(&self, reason: &str) {
        self.reason.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(|| reason.to_owned());
        self.cancel.cancel();
        self.notify.notify_waiters();
    }
    #[nolog]
    pub fn reason(&self) -> String {
        self.reason.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| "closed".into())
    }
    /// Queue an event for the app. False on overflow, after which the queue holds nothing.
    #[nolog]
    pub fn push(&self, ev: Ev) -> bool {
        let ok = self.queue.lock().unwrap_or_else(|e| e.into_inner()).push(ev);
        self.notify.notify_waiters();
        ok
    }
    /// Overflow: drop what is queued, so the closing state is all the app reads.
    #[nolog]
    pub fn overflow(&self) {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    #[nolog]
    pub fn finish(&self, reason: &str) {
        self.closed.store(true, Ordering::SeqCst);
        self.push(Ev::State { state: "closed", reason: Some(reason.to_owned()), login: self.login(), reconnected: false });
        self.notify.notify_waiters();
    }
    /// `net.recv`: everything after `after` (also acknowledging up to it), at once if there is any, else the
    /// next event within `wait`. One call at a time per channel.
    #[nolog]
    pub async fn recv(&self, after: u64, wait: Duration) -> Result<Value> {
        if self.recving.swap(true, Ordering::SeqCst) {
            crate::refuse!(Conflict, "a channel has one net.recv in flight");
        }
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.recving);
        *self.last_recv.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Register for the next wake-up BEFORE looking, so a push in between is not missed.
            notified.as_mut().enable();
            let events = self.queue.lock().unwrap_or_else(|e| e.into_inner()).take(after);
            if !events.is_empty() || (self.is_closed() && events.is_empty()) {
                *self.last_recv.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                return Ok(json!({"events":events,"closed":self.is_closed()}));
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                *self.last_recv.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
                return Ok(json!({"events":[],"closed":false}));
            }
        }
    }
    #[nolog]
    pub fn since_recv(&self) -> Duration {
        self.last_recv.lock().unwrap_or_else(|e| e.into_inner()).elapsed()
    }
    /// 60 sends a minute per channel (spec 5.3).
    #[nolog]
    pub fn allow_send(&self, now: Instant) -> bool {
        let mut sends = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        while sends.front().is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60)) {
            sends.pop_front();
        }
        if sends.len() >= SENDS_PER_MINUTE {
            return false;
        }
        sends.push_back(now);
        true
    }
    /// `net.send`: one text frame, written by the engine's connection.
    #[nolog]
    pub async fn send(&self, text: String) -> Result<Value> {
        if text.len() > SEND_MAX {
            crate::refuse!(BadRequest, "a channel message is at most 64 KiB");
        }
        if self.is_closed() {
            crate::refuse!(Conflict, "the channel is closed");
        }
        let link = self.link.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(link) = link else {
            crate::refuse!(Conflict, "the channel is not connected yet");
        };
        if !self.allow_send(Instant::now()) {
            crate::refuse!(Conflict, "a channel may send 60 messages a minute");
        }
        let sent = link.send(text, Duration::from_secs(5)).await.map_err(crate::domain::UserError::Conflict)?;
        Ok(json!({"sent":sent.bytes}))
    }
}

/// Panel History rows for state changes: at most `HISTORY_PER_HOUR` per channel per hour; the changes a full hour
/// held back are counted into the next row (spec 6).
#[derive(Default)]
pub struct HistoryGate {
    window: Option<Instant>,
    rows: usize,
    held: usize,
}
impl HistoryGate {
    /// `Some(held)` when this change gets a row (with how many earlier changes it stands for), None when held back.
    #[nolog]
    pub fn admit(&mut self, now: Instant) -> Option<usize> {
        if self.window.is_none_or(|w| now.duration_since(w) >= Duration::from_secs(3600)) {
            self.window = Some(now);
            self.rows = 0;
        }
        if self.rows >= HISTORY_PER_HOUR {
            self.held += 1;
            return None;
        }
        self.rows += 1;
        Some(std::mem::take(&mut self.held))
    }
}

/// How the pump reports a state change to its owner (the History row and the engine log); never a message.
pub type OnState = Box<dyn FnMut(&Ev) + Send>;

/// Relay one connection into the channel until it ends: messages into the queue, state changes as events, abandonment
/// after `abandon` without a `net.recv`, and the closing state last. Dropping the connection is the goodbye.
#[nolog]
pub async fn pump(mut conn: ws::Conn, shared: Arc<Shared>, cancel: CancellationToken, abandon: Duration, mut on_state: OnState) {
    let mut state = conn.state.clone();
    let mut was_open = false;
    let mut last: Option<&'static str> = Some("connecting");
    let first = Ev::State { state: "connecting", reason: None, login: shared.login(), reconnected: false };
    on_state(&first);
    shared.push(first);
    let mut tick = tokio::time::interval(Duration::from_millis(200).min(abandon / 2 + Duration::from_millis(1)));
    let reason = 'outer: loop {
        let state_changed = tokio::select! {
            biased;
            _ = cancel.cancelled() => break shared.reason(),
            changed = state.changed() => changed.is_ok(),
            msg = conn.rx.recv() => {
                match msg {
                    Some(ws::Message { text: Some(text), .. }) => {
                        shared.received.fetch_add(1, Ordering::Relaxed);
                        if !shared.push(Ev::Message(text)) {
                            shared.overflow();
                            break 'outer "overflow".to_string();
                        }
                    }
                    Some(_) => {
                        shared.dropped_binary.fetch_add(1, Ordering::Relaxed);
                    }
                    None => break shared.reason(),
                }
                continue;
            }
            _ = tick.tick() => {
                if shared.since_recv() >= abandon {
                    break "abandoned".to_string();
                }
                continue;
            }
        };
        if !state_changed {
            break shared.reason();
        }
        // Messages that arrived before the change come first.
        while let Ok(msg) = conn.rx.try_recv() {
            match msg {
                ws::Message { text: Some(text), .. } => {
                    shared.received.fetch_add(1, Ordering::Relaxed);
                    if !shared.push(Ev::Message(text)) {
                        shared.overflow();
                        break 'outer "overflow".to_string();
                    }
                }
                _ => {
                    shared.dropped_binary.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        let snapshot = state.borrow_and_update().state.clone();
        let (name, why): (&'static str, Option<String>) = match snapshot {
            ws::State::Connecting { .. } => ("connecting", None),
            ws::State::Connected { .. } => ("open", None),
            ws::State::Down { error, .. } | ws::State::Refused { error, .. } => ("down", Some(error)),
        };
        if last == Some(name) && name != "down" {
            continue;
        }
        last = Some(name);
        let reconnected = name == "open" && was_open;
        if name == "open" {
            was_open = true;
        }
        let ev = Ev::State { state: name, reason: why, login: shared.login(), reconnected };
        on_state(&ev);
        if !shared.push(ev) {
            shared.overflow();
            break "overflow".to_string();
        }
    };
    drop(conn);
    shared.finish(&reason);
    on_state(&Ev::State { state: "closed", reason: Some(reason), login: shared.login(), reconnected: false });
}

/// One recorded state change as a Panel History row: the channel, the site, the state and why. Never a message, a path or
/// a query (spec 6).
#[nolog]
async fn record(engine: Arc<Engine>, org: Arc<OrgHandle>, panel: String, payload: Value) {
    let Ok(mut client) = engine.db.get().await else { return };
    let Ok(tx) = client.transaction().await else { return };
    if super::storage::event(&tx, org.id, &panel, "net.channel", &payload, "app").await.is_ok() && tx.commit().await.is_ok() {
        org.emit(json!({"type":"custom_apps_history","org":org.slug,"panel":panel}));
    }
}

/// Everything the engine decides for one dial attempt, anew each time (spec 5.4): the app is still running its
/// code, the site is still allowed (Allow, an Allow once for this run, or the private-network Allow), plain ws only
/// reaches a pinned private site, the resolved addresses are still the vetted ones, and the saved login is re-read.
#[nolog]
async fn attempt(engine: &Arc<Engine>, bound: &Bound, ep: &ws::Endpoint, shared: &Shared) -> Result<ws::Dial> {
    let value = super::bridge::snapshot(engine, bound).await?;
    let decision = super::policy::net_decision(&value, &ep.host, ep.port)?;
    let once = engine.custom_apps.net.once(bound.org, &bound.app, &bound.panel, bound.generation)?;
    if decision != "allow" && !once.contains(&super::policy::net_site(&value, &ep.host, ep.port)) {
        crate::refuse!(Forbidden, "the app is no longer allowed to reach this site");
    }
    let pins = super::policy::private_pins(&value, &ep.host, ep.port);
    if !ep.tls && pins.is_none() {
        crate::refuse!(Forbidden, "plain ws:// reaches only a private site allowed in the app's settings");
    }
    let addr = super::net::dial_target(&ep.host, ep.port, pins.as_deref()).await?;
    let login = super::bridge::site_login(engine, bound, &value, &ep.host, ep.port).await?;
    shared.set_login(login.is_some());
    Ok(ws::Dial { addr, headers: login.map(|l| vec![l.header]).unwrap_or_default() })
}

/// `net.connect`: the channel exists at once and dials in the background; its first events say how that goes.
#[nolog]
pub(super) async fn open(engine: &Arc<Engine>, org: &Arc<OrgHandle>, bound: &Bound, action: &Action) -> Result<Value> {
    let Action::NetConnect { url, protocols } = action else {
        crate::refuse!(BadRequest, "not a channel request");
    };
    let ep = ws::parse_target(url).map_err(crate::domain::UserError::BadRequest)?;
    let value = super::bridge::snapshot(engine, bound).await?;
    let pins = super::policy::private_pins(&value, &ep.host, ep.port);
    if !ep.tls && pins.is_none() {
        crate::refuse!(Forbidden, "plain ws:// reaches only a private site the user allowed in the app's settings; use wss:// for the internet");
    }
    let site = super::policy::net_site(&value, &ep.host, ep.port);
    let login = super::bridge::site_login(engine, bound, &value, &ep.host, ep.port).await?.is_some();
    let (shared, cancel) = engine.custom_apps.net.open_channel(org.id, &bound.app, &bound.panel, bound.generation, &site, ep.tls, pins.is_some())?;
    shared.set_login(login);
    let dialer: ws::Dialer = {
        let (engine, bound, ep, shared) = (engine.clone(), bound.clone(), ep.clone(), shared.clone());
        Arc::new(move || {
            let (engine, bound, ep, shared) = (engine.clone(), bound.clone(), ep.clone(), shared.clone());
            Box::pin(async move { attempt(&engine, &bound, &ep, &shared).await.map_err(|e| e.to_string()) })
        })
    };
    let spec = ws::Spec {
        endpoint: ep.clone(),
        protocols: protocols.clone(),
        hello: vec![],
        heartbeat: None,
        pattern: None,
        source: ws::creds::Source::None,
        extra_headers: vec![],
        dialer: Some(dialer),
        whole: true,
    };
    // Network errors retry after 2 s, doubling to 60 s; refusals after 60 s, then every 5 min (spec 5.4).
    let timing = ws::Timing { net_max: Duration::from_secs(60), ..ws::Timing::default() };
    let conn = engine.dogs.ws.open_with(spec, timing, &engine.shutdown);
    shared.set_link(conn.link());
    let (e, o, b, sh) = (engine.clone(), org.clone(), bound.clone(), shared.clone());
    let mut gate = HistoryGate::default();
    let on_state: OnState = Box::new(move |ev| {
        let Ev::State { state, reason, login, reconnected } = ev else { return };
        // The closing row is always kept; the rest follow the hourly limit.
        let held = gate.admit(Instant::now());
        if held.is_none() && *state != "closed" {
            return;
        }
        let mut payload = json!({"channel":sh.id,"site":sh.site,"state":state,"login":login,"secure":sh.secure});
        if let Some(r) = reason {
            payload["reason"] = json!(r);
        }
        if *reconnected {
            payload["reconnected"] = json!(true);
        }
        if let Some(n) = held.filter(|n| *n > 0) {
            payload["held_back"] = json!(n);
        }
        tokio::spawn(record(e.clone(), o.clone(), b.panel.clone(), payload));
    });
    let (engine, id, app, org_id) = (engine.clone(), shared.id.clone(), bound.app.clone(), org.id);
    let pumped = shared.clone();
    tokio::spawn(async move {
        pump(conn, pumped, cancel, ABANDON_AFTER, on_state).await;
        tokio::time::sleep(TOMBSTONE).await;
        engine.custom_apps.net.drop_channel(org_id, &app, &id);
    });
    Ok(json!({"channel":shared.id,"site":site,"secure":ep.tls,"private":pins.is_some(),"login":login}))
}

/// `net.recv`, `net.send`, `net.close` for a channel of this running copy.
#[nolog]
pub(super) async fn control(engine: &Arc<Engine>, bound: &Bound, action: &Action) -> Result<Value> {
    let find = |id: &str| engine.custom_apps.net.channel(bound.org, &bound.app, &bound.panel, bound.generation, id);
    match action {
        Action::NetRecv { channel, after } => find(channel)?.recv(*after, RECV_WAIT).await,
        Action::NetSend { channel, text } => find(channel)?.send(text.clone()).await,
        Action::NetClose { channel } => {
            find(channel)?.end("closed");
            Ok(json!({"closed":true}))
        }
        _ => crate::refuse!(BadRequest, "not a channel control"),
    }
}

#[cfg(test)]
#[path = "channel_tests.rs"]
mod tests;
