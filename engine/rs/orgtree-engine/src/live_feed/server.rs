//! The feed's listener, upgrade checks and per-connection loop (spec 1, 3 and 5).
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::{Close, Ctl, Inner, AGENT_HEADER, MAX_CONNECTIONS, PATH};
use crate::engine::Engine;
use crate::runtime::watchdogs::events::{self, Access, AuthState, Event, Scope};

const MAX_FRAME: usize = 4096;
const MAX_KINDS: usize = 64;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const LIVENESS: Duration = Duration::from_secs(60);
const STATEFUL: [&str; 2] = ["agents.active", "agents.live"];

#[derive(Clone)]
struct Ctx {
    engine: Arc<Engine>,
    inner: Arc<Inner>,
    port: u16,
}

/// Bind `127.0.0.1:port` and serve. False when the port could not be taken (the status says why).
#[nolog]
pub(super) async fn try_bind(inner: &Arc<Inner>, engine: &Arc<Engine>, port: u16, generation: u64) -> bool {
    let listener = match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
        Ok(l) => l,
        Err(e) => {
            let why = if matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied) { format!("port {port} is in use") } else { format!("{e}") };
            if let Ok(mut st) = inner.state.lock() { if st.generation == generation { st.status = super::Status::Error(why); st.addr = None; } }
            return false;
        }
    };
    let Ok(addr) = listener.local_addr() else { return false };
    let cancel = engine.shutdown.child_token();
    {
        let Ok(mut st) = inner.state.lock() else { return false };
        if st.generation != generation { return true; }
        st.status = super::Status::Listening;
        st.addr = Some(addr);
        st.cancel = Some(cancel.clone());
    }
    let ctx = Ctx { engine: engine.clone(), inner: inner.clone(), port: addr.port() };
    let app = Router::new().route(PATH, get(handler)).fallback(|| async { StatusCode::NOT_FOUND }).with_state(ctx);
    let inner2 = inner.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.clone().cancelled_owned()).await;
        // the server ended (disabled, rebound or shutdown): whoever is left is told
        inner2.close(1001, "feed stopped", None);
    });
    true
}

/// One of the 32 connection places; given back when the connection ends.
struct Place(Arc<Inner>);
impl Drop for Place {
    fn drop(&mut self) { self.0.open.fetch_sub(1, Ordering::SeqCst); }
}

#[derive(Clone)]
enum Subject {
    Public { org: Option<(i64, String)> },
    Agent { org_id: i64, agent_id: i64, token: Option<String> },
}

#[nolog]
fn host_ok(headers: &HeaderMap, port: u16) -> bool {
    let Some(h) = headers.get("host").and_then(|v| v.to_str().ok()) else { return false };
    let h = h.to_ascii_lowercase();
    h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")
}

#[nolog]
fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(o) = headers.get("origin") else { return true };
    let Ok(o) = o.to_str() else { return false };
    if o == "null" || o.starts_with("file://") { return true; }
    let Some(rest) = o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")) else { return false };
    let (host, port) = match rest.split_once(':') { Some((h, p)) => (h, Some(p)), None => (rest, None) };
    matches!(host, "127.0.0.1" | "localhost") && port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

#[nolog]
fn bearer(headers: &HeaderMap, q: &HashMap<String, String>) -> Option<String> {
    if let Some(v) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(t) = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")) { return Some(t.trim().to_string()); }
    }
    q.get("token").cloned()
}

fn unavailable<E>(_: E) -> StatusCode { StatusCode::SERVICE_UNAVAILABLE }

/// Who is connecting: the dog header, a token, or nobody (the public tier).
#[nolog]
async fn authenticate(ctx: &Ctx, headers: &HeaderMap, q: &HashMap<String, String>) -> Result<Subject, StatusCode> {
    if let Some(h) = headers.get(AGENT_HEADER) {
        let h = h.to_str().map_err(|_| StatusCode::UNAUTHORIZED)?;
        let (id, mac) = h.split_once('.').ok_or(StatusCode::UNAUTHORIZED)?;
        let id: i64 = id.parse().map_err(|_| StatusCode::UNAUTHORIZED)?;
        let c = ctx.engine.db.get().await.map_err(unavailable)?;
        let row = c.query_opt("SELECT org_id, generation FROM ot.agents WHERE id=$1 AND state='live' AND kind='agent'", &[&id]).await.map_err(unavailable)?
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let (org, generation): (i64, i64) = (row.get(0), i64::from(row.get::<_, i32>(1)));
        if !super::tokens::constant_eq(mac.as_bytes(), ctx.inner.mac(org, id, generation).as_bytes()) { return Err(StatusCode::UNAUTHORIZED); }
        return Ok(Subject::Agent { org_id: org, agent_id: id, token: None });
    }
    if let Some(token) = bearer(headers, q) {
        let tokens = ctx.inner.tokens(&ctx.engine).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let r = tokens.authenticate(&token).ok_or(StatusCode::UNAUTHORIZED)?;
        let c = ctx.engine.db.get().await.map_err(unavailable)?;
        let live = c.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND org_id=$2 AND state='live' AND kind='agent'", &[&r.agent_id, &r.org_id]).await.map_err(unavailable)?;
        if live.is_none() { return Err(StatusCode::UNAUTHORIZED); }
        return Ok(Subject::Agent { org_id: r.org_id, agent_id: r.agent_id, token: Some(r.id) });
    }
    let org = match q.get("org") {
        Some(slug) => Some(ctx.engine.orgs.get(slug).map(|o| (o.id, o.slug.clone())).ok_or(StatusCode::NOT_FOUND)?),
        None => None,
    };
    Ok(Subject::Public { org })
}

#[nolog]
async fn handler(State(ctx): State<Ctx>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>, ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>) -> Response {
    if !host_ok(&headers, ctx.port) || !origin_ok(&headers) { return StatusCode::FORBIDDEN.into_response(); }
    let Ok(ws) = ws else { return StatusCode::UPGRADE_REQUIRED.into_response() };
    // a place first, so a flood of failed logins cannot hold places for long
    let taken = ctx.inner.open.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_CONNECTIONS).then_some(n + 1));
    if taken.is_err() { return StatusCode::SERVICE_UNAVAILABLE.into_response(); }
    let place = Place(ctx.inner.clone());
    let subject = match authenticate(&ctx, &headers, &q).await {
        Ok(s) => s,
        Err(code) => return code.into_response(),
    };
    ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |socket| run(ctx, subject, socket, place))
}

#[nolog]
async fn run(ctx: Ctx, subject: Subject, mut socket: WebSocket, _place: Place) {
    let id = ctx.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<Close>();
    let token = match &subject { Subject::Agent { token, .. } => token.clone(), _ => None };
    if let Ok(mut c) = ctx.inner.conns.lock() { c.insert(id, Ctl { tx: ctl_tx, token, agent: match &subject { Subject::Agent { agent_id, .. } => Some(*agent_id), _ => None } }); }
    let key = -(id as i64);
    let (sub, mut rx) = events::subscribe(&ctx.engine, key);
    let mut conn = Conn { engine: ctx.engine.clone(), inner: ctx.inner.clone(), scope: match &subject { Subject::Public { org: Some(_) } => "org", Subject::Public { .. } => "all", _ => "subtree" }.into(),
        subject, kinds: vec!["agents.active".into()], seq: 0, auth: AuthState::default() };
    let end = conn.main(&mut socket, &mut rx, &sub, &mut ctl_rx).await;
    events::unsubscribe(&ctx.engine, key, &sub);
    if let Ok(mut c) = ctx.inner.conns.lock() { c.remove(&id); }
    if let Err((code, reason)) = end {
        let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(Some(CloseFrame { code, reason: reason.into() })))).await;
    }
}

struct Conn {
    engine: Arc<Engine>,
    inner: Arc<Inner>,
    subject: Subject,
    /// public: `all` or `org`; agent: `subtree` or `org`
    scope: String,
    kinds: Vec<String>,
    seq: u64,
    /// the last count sent per `agents.*` kind, and the credit payloads (the shared authorizer's memory)
    auth: AuthState,
}

type R<T> = std::result::Result<T, Close>;

#[nolog]
impl Conn {
    fn wants(&self, name: &str) -> bool { self.kinds.iter().any(|k| events::accepts(k, name)) }
    fn stateful(&self) -> Vec<&'static str> { STATEFUL.into_iter().filter(|n| self.wants(n)).collect() }
    fn is_agent(&self) -> bool { matches!(self.subject, Subject::Agent { .. }) }

    async fn send(&mut self, socket: &mut WebSocket, mut v: Value) -> R<()> {
        self.seq += 1;
        v["v"] = json!(1);
        v["seq"] = json!(self.seq);
        v["ts"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        v["boot"] = json!(self.engine.boot.id);
        match tokio::time::timeout(WRITE_TIMEOUT, socket.send(Message::Text(v.to_string().into()))).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err((1006, "closed")),
            Err(_) => Err((1013, "slow consumer")),
        }
    }
    async fn error(&mut self, socket: &mut WebSocket, code: &str, message: &str) -> R<()> {
        self.send(socket, json!({"type": "error", "code": code, "message": message})).await
    }
    async fn hello(&mut self, socket: &mut WebSocket) -> R<()> {
        let subject = if self.is_agent() { "agent" } else { "public" };
        let v = json!({"type": "hello", "subject": subject, "kinds": self.kinds, "event_scope": self.scope});
        self.send(socket, v).await
    }

    /// Why a live agent's access failed: not live any more (revoked) or a storage error.
    async fn gone(&self) -> Close {
        if let Subject::Agent { agent_id, .. } = &self.subject {
            if let Ok(c) = self.engine.db.get().await {
                if c.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND state='live' AND kind='agent'", &[agent_id]).await.ok().flatten().is_none() { return (4401, "agent is not live"); }
            }
        }
        (1011, "storage error")
    }

    /// The count of one stateful kind, computed now.
    async fn count_now(&mut self, name: &str) -> R<i64> {
        match self.subject.clone() {
            Subject::Public { org } => {
                if let Some((_, slug)) = &org { if self.engine.orgs.get(slug).is_none() { return Err((4404, "organization is gone")); } }
                let org_id = org.map(|o| o.0);
                if name == "agents.active" {
                    return Ok(self.engine.agents.map.pin().iter().filter(|(_, h)| org_id.is_none_or(|o| h.org_id == o) && h.view.load()["busy"] == true).count() as i64);
                }
                let c = self.engine.db.get().await.map_err(|_| (1011, "storage error"))?;
                let n: i64 = c.query_one("SELECT count(*) FROM ot.agents WHERE state='live' AND kind='agent' AND ($1::bigint IS NULL OR org_id=$1)", &[&org_id]).await.map_err(|_| (1011, "storage error"))?.get(0);
                Ok(n)
            }
            Subject::Agent { agent_id, .. } => {
                let access = match Access::for_owner(&self.engine, agent_id, &[]).await { Ok(a) => a, Err(_) => return Err(self.gone().await) };
                Ok(access.count(&self.engine, name == "agents.active", &self.scope))
            }
        }
    }

    async fn state(&mut self, socket: &mut WebSocket, name: &str, reason: &str) -> R<()> {
        let n = self.count_now(name).await?;
        self.auth.counts.insert(name.to_string(), n);
        self.send(socket, json!({"type": "state", "name": name, "payload": {"count": n, "scope": self.scope}, "reason": reason})).await
    }
    async fn states(&mut self, socket: &mut WebSocket, reason: &str) -> R<()> {
        for name in self.stateful() { self.state(socket, name, reason).await?; }
        Ok(())
    }

    async fn main(&mut self, socket: &mut WebSocket, rx: &mut mpsc::Receiver<Event>, sub: &events::Subscription, ctl: &mut mpsc::UnboundedReceiver<Close>) -> R<()> {
        self.hello(socket).await?;
        if let Subject::Agent { agent_id, .. } = self.subject.clone() {
            let access = Access::for_owner(&self.engine, agent_id, &[]).await.map_err(|_| (4401, "agent is not live"))?;
            let scope = self.scope.clone();
            self.auth.baseline(&self.engine, &access, &scope);
        }
        self.states(socket, "connect").await?;
        let pause = self.inner.pause();
        if !pause.is_zero() { tokio::time::sleep(pause).await; }
        let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + self.inner.heartbeat(), self.inner.heartbeat());
        let mut alive = tokio::time::interval_at(tokio::time::Instant::now() + LIVENESS, LIVENESS);
        let shutdown = self.engine.shutdown.clone();
        loop {
            tokio::select! {
                got = rx.recv() => {
                    let Some(first) = got else { return Err((1001, "feed stopped")) };
                    let mut batch = vec![first];
                    while batch.len() < 256 { match rx.try_recv() { Ok(e) => batch.push(e), Err(_) => break } }
                    let sample = sub.overflow.swap(None);
                    self.batch(socket, batch).await?;
                    if let Some(sample) = sample { self.overflowed(socket, (*sample).clone()).await?; }
                }
                msg = socket.recv() => {
                    match msg {
                        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return Ok(()),
                        Some(Ok(Message::Text(t))) => {
                            if t.len() > MAX_FRAME { return Err((1009, "message too big")); }
                            self.control(socket, t.as_str()).await?;
                        }
                        Some(Ok(Message::Binary(_))) => return Err((1003, "text only")),
                        Some(Ok(_)) => {}
                    }
                }
                _ = beat.tick() => {
                    if self.stateful().is_empty() { self.send(socket, json!({"type": "heartbeat"})).await?; }
                    else { self.states(socket, "heartbeat").await?; }
                }
                _ = alive.tick() => self.liveness().await?,
                c = ctl.recv() => { return Err(c.unwrap_or((1001, "feed stopped"))); }
                _ = shutdown.cancelled() => return Err((1001, "engine stopping")),
            }
        }
    }

    /// The events are lost (the queue overflowed): say so, deliver the newest lost event if it is authorized, then give the true state.
    async fn overflowed(&mut self, socket: &mut WebSocket, sample: Event) -> R<()> {
        self.send(socket, json!({"type": "gap", "reason": "overflow"})).await?;
        self.batch(socket, vec![sample]).await?;
        self.states(socket, "resync").await
    }

    async fn liveness(&mut self) -> R<()> {
        match self.subject.clone() {
            Subject::Agent { agent_id, token, .. } => {
                if let Some(t) = token {
                    if !self.inner.tokens(&self.engine).map(|x| x.exists(&t)).unwrap_or(false) { return Err((4401, "token revoked")); }
                }
                let c = self.engine.db.get().await.map_err(|_| (1011, "storage error"))?;
                if c.query_opt("SELECT 1 FROM ot.agents WHERE id=$1 AND state='live' AND kind='agent'", &[&agent_id]).await.map_err(|_| (1011, "storage error"))?.is_none() { return Err((4401, "agent is not live")); }
            }
            Subject::Public { org: Some((_, slug)) } => { if self.engine.orgs.get(&slug).is_none() { return Err((4404, "organization is gone")); } }
            _ => {}
        }
        Ok(())
    }

    /// One drained batch of engine events.
    async fn batch(&mut self, socket: &mut WebSocket, batch: Vec<Event>) -> R<()> {
        if let Subject::Agent { agent_id, .. } = self.subject {
            if batch.iter().any(|e| matches!(e.name.as_str(), "agent.retired" | "agent.halted") && matches!(e.scope, Scope::Agent(_, id) if id == agent_id)) {
                return Err((4401, "agent retired or halted"));
            }
        }
        let batch: Vec<Event> = batch.into_iter().filter(|e| self.wants(&e.name)).collect();
        if batch.is_empty() { return Ok(()); }
        let private = batch.iter().any(Event::is_private);
        match self.subject.clone() {
            Subject::Public { org } => {
                for name in STATEFUL {
                    if !batch.iter().any(|e| e.name == name && match (&e.scope, &org) { (Scope::Org(o), Some((id, _))) => o == id, _ => true }) { continue; }
                    let n = self.count_now(name).await?;
                    let old = self.auth.counts.insert(name.to_string(), n);
                    if old != Some(n) {
                        self.send(socket, json!({"type": "event", "name": name, "payload": {"count": n, "previous": old, "scope": self.scope}})).await?;
                    }
                }
            }
            Subject::Agent { agent_id, .. } => {
                let out = events::app_event_scope(private, async {
                    let access = Access::for_owner(&self.engine, agent_id, &batch).await?;
                    let scope = if self.scope == "org" && access.visibility() != "full" { "subtree".to_string() } else { self.scope.clone() };
                    anyhow::Ok((events::authorize(&self.engine, &access, &mut self.auth, &scope, &batch), scope))
                }).await;
                let (out, scope) = match out { Ok(x) => x, Err(_) => return Err(self.gone().await) };
                self.scope = scope;
                for e in out { self.send(socket, json!({"type": "event", "name": e.name, "payload": e.payload})).await?; }
            }
        }
        Ok(())
    }

    /// A client control message: `{"op":"subscribe","kinds":[...],"event_scope":"subtree"|"org"}`.
    async fn control(&mut self, socket: &mut WebSocket, text: &str) -> R<()> {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return self.error(socket, "bad_message", "not JSON").await };
        if v["op"] != "subscribe" { return self.error(socket, "bad_message", "op must be subscribe").await; }
        let Some(list) = v["kinds"].as_array() else { return self.error(socket, "bad_message", "kinds is a list of names").await };
        let mut errors: Vec<(&str, String)> = Vec::new();
        let mut kinds: Vec<String> = Vec::new();
        if list.len() > MAX_KINDS { errors.push(("bad_kind", format!("at most {MAX_KINDS} kinds; the first {MAX_KINDS} apply"))); }
        for k in list.iter().take(MAX_KINDS) {
            let Some(k) = k.as_str() else { errors.push(("bad_kind", "a kind is a string".into())); continue };
            if !self.is_agent() && (k == "agents.*" || k == "*") {
                for n in STATEFUL { if !kinds.iter().any(|x| x == n) { kinds.push(n.to_string()); } }
                continue;
            }
            if k != "*" && !events::valid_target(k) { errors.push(("bad_kind", format!("{k:?} is not a dotted event name, a dotted prefix ending in .*, or *"))); continue; }
            if !self.is_agent() && !STATEFUL.contains(&k) { errors.push(("needs_token", format!("{k} needs an access token; without one only agents.active and agents.live are served"))); continue; }
            if !kinds.iter().any(|x| x == k) { kinds.push(k.to_string()); }
        }
        if let (Some(s), Subject::Agent { agent_id, .. }) = (v["event_scope"].as_str(), self.subject.clone()) {
            match s {
                "subtree" => self.scope = "subtree".into(),
                "org" => {
                    let full = Access::for_owner(&self.engine, agent_id, &[]).await.map(|a| a.visibility() == "full").unwrap_or(false);
                    if full { self.scope = "org".into(); } else { errors.push(("needs_full_visibility", "org counts need full organization visibility; staying on subtree".into())); self.scope = "subtree".into(); }
                }
                _ => errors.push(("bad_message", "event_scope is subtree or org".into())),
            }
        }
        for (code, message) in errors { self.error(socket, code, &message).await?; }
        let before = self.stateful();
        self.kinds = kinds;
        self.hello(socket).await?;
        for name in self.stateful().into_iter().filter(|n| !before.contains(n)) { self.state(socket, name, "subscribe").await?; }
        Ok(())
    }
}
