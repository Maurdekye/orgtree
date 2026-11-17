//! The app feed (`/api/app/ws`, `/api/app/records`): the org registry, each
//! org's summary and desktop notices, the machine-wide pushed values
//! (providers, accounts, usage peeks...) and per-org "working" counts.
//! One task owns it; producers send to it and never wait.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;
use crate::feed::rooms::{next_socket_id, Out, SocketId};
use crate::util::iso_opt;

pub struct AppFeed {
    tx: mpsc::UnboundedSender<Env>,
}

/// A message and the request that sent it.
type Env = (Msg, Option<String>);

/// Tests only: what the feed would have read from the database.
#[cfg(test)]
impl AppFeed {
    /// The list of this engine's organizations (`read_registry`'s rows).
    pub fn test_registry(&self, rows: Vec<Value>) {
        let _ = self.tx.send((Msg::RegistryRead(rows), None));
    }
    /// One organization's row, summary and notices (`read_org`'s answer).
    pub fn test_org(&self, id: i64, org: Value, summary: Value, notices: Value) {
        let _ = self.tx.send((Msg::OrgRead(id, Some((org, summary, notices))), None));
    }
}

/// The feed task's inbox, handed to `start` once.
pub struct AppFeedInbox(mpsc::UnboundedReceiver<Env>);

/// Whose window a socket of the app feed is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Audience {
    /// One of this desktop's own windows.
    Local,
    /// A window of this desktop on an organization of the named remote engine.
    Remote(String),
    /// Another computer that this desktop let in (its client id, `remote_access/`): it is sent
    /// its organizations only, and of this computer's values only `MEMBER_VALUES`.
    Member(String),
}

#[nolog]
impl Audience {
    /// The remote engine a window of this desktop belongs to, if it is such a window.
    fn remote(&self) -> Option<&str> {
        match self {
            Audience::Remote(remote) => Some(remote),
            _ => None,
        }
    }
    fn member(&self) -> Option<&str> {
        match self {
            Audience::Member(client) => Some(client),
            _ => None,
        }
    }
    /// From what a request carries: a member's token scope, else the remote-engine header.
    pub fn of(engine: &Engine, headers: &axum::http::HeaderMap, scope: Option<&crate::client_tokens::Scope>) -> Audience {
        match scope {
            Some(crate::client_tokens::Scope::Member { client_id, .. }) => Audience::Member(client_id.clone()),
            _ => match crate::remote::relay::window(engine, headers) {
                Some(remote) => Audience::Remote(remote.id.clone()),
                None => Audience::Local,
            },
        }
    }
}

/// The values of this computer that a computer it let in is pushed: what a window of one of
/// its organizations needs to offer tiers and accounts, and the usage its Usage panel and badge
/// show (USER 2026-11-17 m1b95cceba206 "Show all members"; before, the panel waited forever for
/// a value that never came). Each passes `remote_access::shown::hide` first. Everything else of
/// this computer's stays here: model-server configuration (`langservers`), the OpenRouter
/// document, and every usage ROUTE, which reads the provider again (`remote_access/member.rs`).
const MEMBER_VALUES: &[&str] = &[
    "providers", "accounts",
    "usage", "usage_peek", "codex_usage", "codex_usage_peek", "antigravity_usage", "antigravity_usage_peek",
    "muse_usage", "muse_usage_peek", "openrouter_keys_usage", "openrouter_usage_peek", "registered_usage", "langserver_usage",
];

enum Msg {
    Registry,
    Org(i64),
    Value(String, Value),
    Working(i64, i64),
    /// For whose window it is.
    Snapshot(oneshot::Sender<Value>, Audience),
    Open(SocketId, Out, Audience),
    /// What some member may open changed (a switch, an organization given): each member's
    /// sockets are sent their registry and what they see of it again.
    Members,
    Close(SocketId),
    RegistryRead(Vec<Value>),
    OrgRead(i64, Option<(Value, Value, Value)>),
    Flush,
    /// One remote engine's organizations as they stand now (remote/link.rs);
    /// an empty list when the connection was removed.
    Remote(String, Vec<crate::remote::Row>),
    /// One remote engine's own pushed values as they stand now.
    RemoteValues(String, HashMap<String, Value>),
}

#[logged]
impl AppFeed {
    pub fn new() -> (Self, AppFeedInbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        (AppFeed { tx }, AppFeedInbox(rx))
    }
    /// What a computer that was let in may open changed.
    #[nolog]
    pub fn members_changed(&self) {
        let _ = self.tx.send((Msg::Members, crate::trace::current_rq()));
    }
    /// The org list changed (create, delete, rename).
    pub fn registry_changed(&self) {
        let _ = self.tx.send((Msg::Registry, crate::trace::current_rq()));
    }
    /// One org's summary or notices may have changed.
    pub fn org_changed(&self, org_id: i64) {
        let _ = self.tx.send((Msg::Org(org_id), crate::trace::current_rq()));
    }
    /// Not logged: a value can be a provider's raw reading (usage, error
    /// text); the key alone is logged.
    #[nolog]
    pub fn set_value(&self, key: &str, value: Value) {
        tracing::info!(key, "app value pushed");
        let _ = self.tx.send((Msg::Value(key.to_string(), value), crate::trace::current_rq()));
    }
    pub fn working(&self, org_id: i64, n: i64) {
        let _ = self.tx.send((Msg::Working(org_id, n), crate::trace::current_rq()));
    }
    /// The organizations of the remote engine `remote_id` for the list: all
    /// of them, each under its alias and its (negative) local id. Not logged:
    /// a row carries a summary; the count is.
    #[nolog]
    pub fn remote_rows(&self, remote_id: &str, rows: Vec<crate::remote::Row>) {
        tracing::info!(remote = remote_id, rows = rows.len(), "remote organizations pushed");
        let _ = self.tx.send((Msg::Remote(remote_id.to_string(), rows), crate::trace::current_rq()));
    }
    /// The engine-wide values of the remote engine `remote_id` (its accounts,
    /// providers, usage...), for the windows of its organizations. Not
    /// logged: see `set_value`; the count is.
    #[nolog]
    pub fn remote_values(&self, remote_id: &str, values: HashMap<String, Value>) {
        tracing::info!(remote = remote_id, values = values.len(), "remote values pushed");
        let _ = self.tx.send((Msg::RemoteValues(remote_id.to_string(), values), crate::trace::current_rq()));
    }
    /// Not logged: the snapshot carries every pushed value (see `set_value`).
    #[nolog]
    pub async fn snapshot(&self) -> Option<Value> {
        self.snapshot_for(Audience::Local).await
    }
    /// The snapshot a window gets: a local window's, the composed one of a window of a
    /// remote engine, or the scoped one of a computer that was let in
    /// (docs/rust-engine/remote-org.md).
    #[nolog]
    pub async fn snapshot_for(&self, audience: Audience) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx.send((Msg::Snapshot(tx, audience), crate::trace::current_rq())).ok()?;
        let got = rx.await.ok();
        tracing::info!(answered = got.is_some(), "app snapshot read");
        got
    }
}

#[logged]
pub fn start(engine: &Arc<Engine>, inbox: AppFeedInbox) {
    let rx = inbox.0;
    let actor = Actor {
        engine: engine.clone(),
        epoch: engine.boot.id.clone(),
        seq: 0,
        app_uuid: String::new(),
        rev: 0,
        registry: Vec::new(),
        summaries: HashMap::new(),
        notices: HashMap::new(),
        values: HashMap::new(),
        working: HashMap::new(),
        sockets: HashMap::new(),
        dirty_orgs: HashSet::new(),
        reading: HashSet::new(),
        remote_rows: std::collections::BTreeMap::new(),
        remote_values: HashMap::new(),
        flush_scheduled: false,
        local_orgs: None,
        tx: engine.app.tx.clone(),
    };
    tokio::spawn(actor.run(rx));
    engine.app.set_value("enter_key_behavior", json!(engine.settings.enter_key_behavior()));
    engine.app.set_value("wrap_object_mentions", json!(engine.settings.wrap_object_mentions()));
    engine.app.registry_changed();
    for org in engine.orgs.all() {
        engine.app.org_changed(org.id);
    }
}

struct Entry {
    seq: u64,
    frame: Value,
}

struct Actor {
    engine: Arc<Engine>,
    epoch: String,
    seq: u64,
    app_uuid: String,
    rev: u64,
    registry: Vec<Value>,
    summaries: HashMap<i64, Entry>,
    notices: HashMap<i64, Entry>,
    values: HashMap<String, (u64, Value)>,
    working: HashMap<i64, (u64, i64)>,
    /// Each window's socket, and whose window it is.
    sockets: HashMap<SocketId, (Out, Audience)>,
    dirty_orgs: HashSet<i64>,
    reading: HashSet<i64>,
    /// remote engine id -> its organizations in the list. They are not local
    /// orgs: no handle, no database row, never in local-orgs.json.
    remote_rows: std::collections::BTreeMap<String, Vec<crate::remote::Row>>,
    /// remote engine id -> its own pushed values (key -> (seq, value)), kept
    /// while it is offline: its windows show the last known state.
    remote_values: HashMap<String, HashMap<String, (u64, Value)>>,
    flush_scheduled: bool,
    /// The listing last written to local-orgs.json (local_orgs.rs).
    local_orgs: Option<Value>,
    tx: mpsc::UnboundedSender<Env>,
}

#[logged]
impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Env>) {
        self.app_uuid = app_uuid(&self.engine).await.unwrap_or_else(|_| "00000000-0000-0000-0000-000000000000".into());
        while let Some((msg, cause)) = rx.recv().await {
            // each message is its own request (the flush timer excepted)
            let span = if matches!(msg, Msg::Flush) {
                tracing::Span::none()
            } else {
                crate::trace::request_from("engine", cause.as_deref())
            };
            let _g = span.enter();
            self.handle(msg);
        }
    }

    #[nolog]
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Not logged: a frame carries pushed values (see `AppFeed::set_value`);
    /// its type, sequence and the window count are logged.
    #[nolog]
    fn broadcast(&mut self, frame: &Value) {
        self.send(frame, |_| true);
    }

    /// Send a frame to the windows of this desktop that `to` picks by the remote engine they
    /// are a window of (`None` = a local window). A computer that was let in is never among
    /// them: it is sent only what `to_members` and `member_frames` make for it.
    /// Not logged: see `broadcast`.
    #[nolog]
    fn send(&mut self, frame: &Value, to: impl Fn(Option<&str>) -> bool) {
        let text: Arc<str> = Arc::from(frame.to_string());
        self.sockets.retain(|_, (out, _)| !out.is_closed());
        let mut windows = 0;
        for (out, audience) in self.sockets.values() {
            if audience.member().is_none() && to(audience.remote()) {
                windows += 1;
                let _ = out.try_send(text.clone());
            }
        }
        tracing::info!(kind = frame["type"].as_str().unwrap_or(""), seq = frame["seq"].as_u64(), windows, "app frame broadcast");
    }

    /// The local ids of the organizations a computer that was let in may open now.
    #[nolog]
    fn member_orgs(&self, client: &str) -> HashSet<i64> {
        crate::remote_access::visible(&self.engine, client).into_iter().map(|org| org.id).collect()
    }

    /// Send a frame about one organization to the members that may open it.
    #[nolog]
    fn to_members(&mut self, org: i64, frame: &Value) {
        let clients: HashSet<String> = self.sockets.values().filter_map(|(_, audience)| audience.member().map(str::to_string)).collect();
        if clients.is_empty() {
            return;
        }
        let seeing: HashSet<String> = clients.into_iter().filter(|client| self.member_orgs(client).contains(&org)).collect();
        let text: Arc<str> = Arc::from(frame.to_string());
        for (out, audience) in self.sockets.values() {
            if audience.member().is_some_and(|client| seeing.contains(client)) {
                let _ = out.try_send(text.clone());
            }
        }
    }

    /// One of this computer's values as a member is pushed it, or nothing when it is not one
    /// a member gets.
    #[nolog]
    fn member_value(&self, key: &str, value: &Value) -> Option<Value> {
        if !MEMBER_VALUES.contains(&key) {
            return None;
        }
        let mut shown = value.clone();
        crate::remote_access::shown::hide(&mut shown, &crate::remote_access::shown::Owner::of(&self.engine), true);
        Some(shown)
    }

    /// The registry as one member sees it: its organizations and no other.
    #[nolog]
    fn member_registry(&self, orgs: &HashSet<i64>) -> Value {
        json!({
            "type": "registry_snapshot", "epoch": self.epoch,
            "cursor": { "app_uuid": self.app_uuid, "incarnation": self.epoch, "rev": self.rev },
            "records": self.registry.iter().filter(|body| body["org_id"].as_i64().is_some_and(|id| orgs.contains(&id))).map(|body| json!({
                "entity": "registry_org", "id": body["org_id"].to_string(), "body": body,
            })).collect::<Vec<_>>(),
        })
    }

    /// Send every member's sockets their registry again, and the summary and notices of each
    /// organization they see: after the registry changed, or what a member may open did.
    #[nolog]
    fn member_frames(&mut self) {
        let clients: HashSet<String> = self.sockets.values().filter_map(|(_, audience)| audience.member().map(str::to_string)).collect();
        for client in clients {
            let orgs = self.member_orgs(&client);
            let mut frames = vec![self.member_registry(&orgs)];
            for id in &orgs {
                frames.extend(self.summaries.get(id).map(|entry| entry.frame.clone()));
                frames.extend(self.notices.get(id).map(|entry| entry.frame.clone()));
            }
            for (out, audience) in self.sockets.values() {
                if audience.member() == Some(client.as_str()) {
                    for frame in &frames {
                        let _ = out.try_send(Arc::from(frame.to_string()));
                    }
                }
            }
        }
    }

    /// One pushed value as its frame.
    #[nolog]
    fn value_frame(&self, key: &str, seq: u64, value: &Value) -> Value {
        json!({ "type": "app_runtime", "epoch": self.epoch, "seq": seq,
                "values": { key: { "epoch": self.epoch, "seq": seq, "value": value } } })
    }

    /// The values a window of the remote engine `remote` gets: that engine's
    /// own, this computer's list of connections, and `remote_link`, its own
    /// connection. Nothing else of this computer's.
    #[nolog]
    fn composed_values(&self, remote: &str) -> Map<String, Value> {
        let entry = |seq: &u64, value: &Value| json!({ "epoch": self.epoch, "seq": seq, "value": value });
        let mut values: Map<String, Value> =
            self.remote_values.get(remote).into_iter().flatten().map(|(k, (s, v))| (k.clone(), entry(s, v))).collect();
        if let Some((seq, list)) = self.values.get(REMOTES_VALUE) {
            values.insert(REMOTES_VALUE.into(), entry(seq, list));
            if let Some(link) = link_of(list, remote) {
                values.insert(LINK_VALUE.into(), entry(seq, link));
            }
        }
        values
    }

    fn registry_frame(&self) -> Value {
        json!({
            "type": "registry_snapshot", "epoch": self.epoch,
            "cursor": { "app_uuid": self.app_uuid, "incarnation": self.epoch, "rev": self.rev },
            // this engine's organizations first, then each remote engine's
            "records": self.registry.iter().chain(self.remote_rows.values().flatten().map(|row| &row.registry)).map(|body| json!({
                "entity": "registry_org", "id": body["org_id"].to_string(), "body": body,
            })).collect::<Vec<_>>(),
        })
    }

    /// Not logged: it carries every pushed value; counts are logged.
    #[nolog]
    fn snapshot(&mut self, audience: &Audience) -> Value {
        tracing::info!(values = self.values.len(), orgs = self.summaries.len(), remote = audience.remote().is_some(),
            member = audience.member().is_some(), "app snapshot built");
        let seq = self.next();
        // a computer that was let in: its organizations, and of this computer's values the few it gets
        let only = audience.member().map(|client| self.member_orgs(client));
        let seen = |id: &i64| only.as_ref().is_none_or(|orgs| orgs.contains(id));
        let summaries: Map<String, Value> =
            self.summaries.iter().filter(|(id, _)| seen(*id)).map(|(id, e)| (id.to_string(), e.frame.clone())).collect();
        let notices: Map<String, Value> =
            self.notices.iter().filter(|(id, _)| seen(*id)).map(|(id, e)| (id.to_string(), e.frame.clone())).collect();
        let entry = |seq: &u64, value: &Value| json!({ "epoch": self.epoch, "seq": seq, "value": value });
        let values: Map<String, Value> = match audience {
            Audience::Remote(remote) => self.composed_values(remote),
            Audience::Local => self.values.iter().map(|(k, (s, v))| (k.clone(), entry(s, v))).collect(),
            Audience::Member(_) => self.values.iter().filter_map(|(k, (s, v))| self.member_value(k, v).map(|shown| (k.clone(), entry(s, &shown)))).collect(),
        };
        let orgs: Map<String, Value> = self
            .working
            .iter()
            .filter(|(id, _)| seen(*id))
            .map(|(id, (s, n))| (id.to_string(), json!({ "epoch": self.epoch, "seq": s, "working": n })))
            .collect();
        let registry = match &only {
            Some(orgs) => self.member_registry(orgs),
            None => self.registry_frame(),
        };
        json!({
            "type": "app_snapshot", "epoch": self.epoch, "seq": seq,
            "registry": registry,
            "summaries": summaries, "notices": notices,
            "runtime": { "values": values, "orgs": orgs },
        })
    }

    /// local-orgs.json follows the registry and the summaries' hub
    /// addresses (local_orgs.rs). `local_orgs` keeps the listing actually
    /// written, so a failed write is retried at the next change.
    /// Not logged: it runs on every org read; the write itself is logged.
    #[nolog]
    fn mirror_local_orgs(&mut self) {
        let loading = |id: i64| self.reading.contains(&id) || self.dirty_orgs.contains(&id);
        let summary = |id: i64| self.summaries.get(&id).map(|e| &e.frame["body"]);
        let Some(next) = crate::local_orgs::due(&self.registry, summary, loading, self.local_orgs.as_ref()) else {
            return;
        };
        match crate::local_orgs::write(&self.engine.cfg.data_root, &next) {
            Ok(()) => self.local_orgs = Some(next),
            Err(error) => tracing::warn!(error = %error, "local-orgs.json could not be written"),
        }
    }

    #[nolog]
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Registry => {
                let engine = self.engine.clone();
                let tx = self.tx.clone();
                crate::trace::spawn(async move {
                    if let Ok(rows) = read_registry(&engine).await {
                        let _ = tx.send((Msg::RegistryRead(rows), crate::trace::current_rq()));
                    }
                });
            }
            Msg::RegistryRead(rows) => {
                if rows != self.registry {
                    self.registry = rows;
                    self.rev += 1;
                    let frame = self.registry_frame();
                    self.broadcast(&frame);
                    self.member_frames();
                    self.mirror_local_orgs();
                }
            }
            Msg::Org(id) => {
                self.dirty_orgs.insert(id);
                if !self.flush_scheduled {
                    self.flush_scheduled = true;
                    let tx = self.tx.clone();
                    crate::trace::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = tx.send((Msg::Flush, None));
                    });
                }
            }
            Msg::Flush => {
                self.flush_scheduled = false;
                let ids: Vec<i64> = self.dirty_orgs.drain().filter(|id| !self.reading.contains(id)).collect();
                for id in ids {
                    self.reading.insert(id);
                    let engine = self.engine.clone();
                    let tx = self.tx.clone();
                    crate::trace::spawn(async move {
                        let got = read_org(&engine, id).await.ok().flatten();
                        let _ = tx.send((Msg::OrgRead(id, got), crate::trace::current_rq()));
                    });
                }
            }
            Msg::OrgRead(id, got) => {
                self.reading.remove(&id);
                let seq = self.next();
                match got {
                    Some((org, summary, notices)) => {
                        let stamp = |kind: &str, key: &str, v: Value| {
                            json!({ "type": kind, "epoch": self.epoch, "seq": seq, "org_id": id,
                                    "org_uuid": org["uuid"], "incarnation": self.epoch, "rev": seq, key: v })
                        };
                        let sframe = stamp("org_summary", "body", summary);
                        let nframe = stamp("org_notices", "notices", notices);
                        let s_changed = self.summaries.get(&id).map(|e| e.frame["body"] != sframe["body"]).unwrap_or(true);
                        let n_changed =
                            self.notices.get(&id).map(|e| e.frame["notices"] != nframe["notices"]).unwrap_or(true);
                        if s_changed {
                            self.summaries.insert(id, Entry { seq, frame: sframe.clone() });
                            self.broadcast(&sframe);
                            self.to_members(id, &sframe);
                        }
                        if n_changed {
                            self.notices.insert(id, Entry { seq, frame: nframe.clone() });
                            self.broadcast(&nframe);
                            self.to_members(id, &nframe);
                        }
                    }
                    None => {
                        self.summaries.remove(&id);
                        self.notices.remove(&id);
                    }
                }
                self.mirror_local_orgs();
                if self.dirty_orgs.contains(&id) && !self.flush_scheduled {
                    self.flush_scheduled = true;
                    let tx = self.tx.clone();
                    crate::trace::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = tx.send((Msg::Flush, None));
                    });
                }
            }
            Msg::Value(key, value) => {
                if self.values.get(&key).map(|(_, v)| *v == value).unwrap_or(false) {
                    return;
                }
                let seq = self.next();
                let before = self.values.insert(key.clone(), (seq, value.clone())).map(|(_, v)| v);
                let frame = self.value_frame(&key, seq, &value);
                // a computer that was let in is pushed the few values it gets, with the owner's addresses out
                if let Some(shown) = self.member_value(&key, &value) {
                    let text: Arc<str> = Arc::from(self.value_frame(&key, seq, &shown).to_string());
                    for (out, audience) in self.sockets.values() {
                        if audience.member().is_some() {
                            let _ = out.try_send(text.clone());
                        }
                    }
                }
                if key != REMOTES_VALUE {
                    // this computer's value: a remote engine's windows have that engine's
                    self.send(&frame, |remote| remote.is_none());
                    return;
                }
                // the connections: every window's, and each remote window is told of its own;
                // a removed connection's values go with it
                self.remote_values.retain(|remote, _| link_of(&value, remote).is_some());
                self.broadcast(&frame);
                let windows: HashSet<String> = self.sockets.values().filter_map(|(_, audience)| audience.remote().map(str::to_string)).collect();
                for remote in windows {
                    let link = link_of(&value, &remote).cloned().unwrap_or(Value::Null);
                    if before.as_ref().and_then(|list| link_of(list, &remote)).unwrap_or(&Value::Null) != &link {
                        let frame = self.value_frame(LINK_VALUE, seq, &link);
                        self.send(&frame, |to| to == Some(remote.as_str()));
                    }
                }
            }
            Msg::RemoteValues(remote, mut values) => {
                // its own connections to other engines are not its windows' here
                values.remove(REMOTES_VALUE);
                values.remove(LINK_VALUE);
                let known = self.remote_values.entry(remote.clone()).or_default();
                // a value the remote engine no longer has reads as null, like one never pushed
                let mut changed: Vec<(String, Value)> =
                    known.keys().filter(|k| !values.contains_key(*k)).map(|k| (k.clone(), Value::Null)).collect();
                changed.extend(values.into_iter().filter(|(k, v)| known.get(k).map(|(_, was)| was) != Some(v)));
                for (key, value) in changed {
                    let seq = self.next();
                    let known = self.remote_values.entry(remote.clone()).or_default();
                    if value.is_null() {
                        known.remove(&key);
                    } else {
                        known.insert(key.clone(), (seq, value.clone()));
                    }
                    let frame = self.value_frame(&key, seq, &value);
                    self.send(&frame, |to| to == Some(remote.as_str()));
                }
            }
            Msg::Working(org, n) => {
                if self.working.get(&org).map(|(_, v)| *v == n).unwrap_or(false) {
                    return;
                }
                let seq = self.next();
                self.working.insert(org, (seq, n));
                let frame = json!({ "type": "app_runtime", "epoch": self.epoch, "seq": seq,
                                    "orgs": { org.to_string(): { "epoch": self.epoch, "seq": seq, "working": n } } });
                self.broadcast(&frame);
                self.to_members(org, &frame);
            }
            Msg::Snapshot(reply, audience) => {
                let s = self.snapshot(&audience);
                let _ = reply.send(s);
            }
            Msg::Open(id, out, audience) => {
                let s = self.snapshot(&audience);
                let _ = out.try_send(Arc::from(s.to_string()));
                self.sockets.insert(id, (out, audience));
            }
            Msg::Members => self.member_frames(),
            Msg::Close(id) => {
                self.sockets.remove(&id);
            }
            Msg::Remote(remote, rows) => self.remote(remote, rows),
        }
    }
}

/// The pushed value that lists this computer's connections to remote engines.
const REMOTES_VALUE: &str = "remotes";
/// The value a remote engine's window gets beside it: its own connection.
const LINK_VALUE: &str = "remote_link";

/// The connection `remote` in the list of connections.
#[nolog]
fn link_of<'a>(list: &'a Value, remote: &str) -> Option<&'a Value> {
    list.as_array()?.iter().find(|view| view["id"].as_str() == Some(remote))
}

impl Actor {
    /// A remote engine's organizations changed: the registry frame when the
    /// set or a record did, then each changed summary and working count, in
    /// the frames a local organization's changes use.
    fn remote(&mut self, remote: String, rows: Vec<crate::remote::Row>) {
        let old = (if rows.is_empty() { self.remote_rows.remove(&remote) } else { self.remote_rows.insert(remote, rows.clone()) }).unwrap_or_default();
        if !old.iter().map(|r| &r.registry).eq(rows.iter().map(|r| &r.registry)) {
            self.rev += 1;
            let frame = self.registry_frame();
            self.broadcast(&frame);
        }
        for gone in old.iter().filter(|o| !rows.iter().any(|r| r.local_id == o.local_id)) {
            self.summaries.remove(&gone.local_id);
            self.notices.remove(&gone.local_id);
            self.working.remove(&gone.local_id);
        }
        for row in rows {
            let id = row.local_id;
            let was = old.iter().find(|o| o.local_id == id);
            if was.map(|o| (&o.summary, &o.org_uuid)) != Some((&row.summary, &row.org_uuid)) {
                let seq = self.next();
                let frame = json!({ "type": "org_summary", "epoch": self.epoch, "seq": seq, "org_id": id, "org_uuid": row.org_uuid,
                                    "incarnation": self.epoch, "rev": seq, "body": row.summary });
                self.summaries.insert(id, Entry { seq, frame: frame.clone() });
                self.broadcast(&frame);
            }
            // what waits there: the frame a local organization's notices use; `null` when this
            // engine cannot say (the link is not connected), which leaves the question open
            if was.map(|o| (&o.notices, &o.org_uuid)) != Some((&row.notices, &row.org_uuid)) && (row.notices.is_some() || self.notices.contains_key(&id)) {
                let seq = self.next();
                let frame = json!({ "type": "org_notices", "epoch": self.epoch, "seq": seq, "org_id": id, "org_uuid": row.org_uuid,
                                    "incarnation": self.epoch, "rev": seq, "notices": &row.notices });
                match &row.notices {
                    Some(_) => self.notices.insert(id, Entry { seq, frame: frame.clone() }),
                    None => self.notices.remove(&id),
                };
                self.broadcast(&frame);
            }
            if self.working.get(&id).map(|(_, n)| *n) != Some(row.working) {
                let seq = self.next();
                self.working.insert(id, (seq, row.working));
                let frame = json!({ "type": "app_runtime", "epoch": self.epoch, "seq": seq,
                                    "orgs": { id.to_string(): { "epoch": self.epoch, "seq": seq, "working": row.working } } });
                self.broadcast(&frame);
            }
        }
    }
}

#[logged]
async fn app_uuid(engine: &Engine) -> anyhow::Result<String> {
    let client = engine.db.get().await?;
    if let Some(r) = client.query_opt("SELECT value FROM ot.meta WHERE key = 'app_uuid'", &[]).await? {
        if let Some(s) = r.get::<_, Value>(0).as_str() {
            return Ok(s.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    client
        .execute(
            "INSERT INTO ot.meta (key, value) VALUES ('app_uuid', $1) ON CONFLICT (key) DO NOTHING",
            &[&json!(id)],
        )
        .await?;
    let r = client.query_one("SELECT value FROM ot.meta WHERE key = 'app_uuid'", &[]).await?;
    Ok(r.get::<_, Value>(0).as_str().unwrap_or(&id).to_string())
}

#[logged]
async fn read_registry(engine: &Engine) -> anyhow::Result<Vec<Value>> {
    let client = engine.db.get().await?;
    let rows = client
        .query("SELECT id, slug, uuid::text, state FROM ot.orgs WHERE state = 'active' ORDER BY slug", &[])
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "org_id": r.get::<_, i64>(0), "slug": r.get::<_, String>(1), "org_uuid": r.get::<_, String>(2),
                "state": r.get::<_, String>(3), "unavailable_step": null, "state_reason": null,
                "attempts": 0, "report_path": null,
            })
        })
        .collect())
}

/// (org row, summary body, notices) for one active org.
// Private notification bodies must not bypass the quiet app-feed wire route.
#[nolog]
async fn read_org(engine: &Engine, org_id: i64) -> anyhow::Result<Option<(Value, Value, Value)>> {
    let client = engine.db.get().await?;
    let Some(org) = client
        .query_opt(
            "SELECT id, uuid::text, slug, name, created_at, net,
                    (SELECT value->>'sha256' FROM ot.meta WHERE key = 'org.picture.' || ot.orgs.id::text)
             FROM ot.orgs WHERE id = $1 AND state = 'active'",
            &[&org_id],
        )
        .await?
    else {
        return Ok(None);
    };
    let slug: String = org.get(2);
    let counts = client
        .query_one(
            "SELECT count(*) FILTER (WHERE state <> 'deleted'), count(*) FILTER (WHERE state = 'live'),
                    coalesce(sum(cost_usd), 0)::float8
               FROM ot.agents WHERE org_id = $1",
            &[&org_id],
        )
        .await?;
    let net: Value = org.get(5);
    let summary = json!({
        "name": org.get::<_, String>(3),
        "logo_sha256": org.get::<_, Option<String>>(6),
        "created": iso_opt(org.get(4)),
        "net_slug": net.get("identity").and_then(|i| i.get("slug")).cloned().unwrap_or(Value::Null),
        "nodes": counts.get::<_, i64>(0),
        "live": counts.get::<_, i64>(1),
        "cost_usd_total": counts.get::<_, f64>(2),
        "attention": crate::domain::notices::attention_count(&client, org_id).await? + engine.elicitations.cards(org_id).len() as i64,
    });
    let notices = crate::domain::notices::for_org(&client, org_id, &slug).await?;
    let orgv = json!({ "id": org_id, "uuid": org.get::<_, String>(1), "slug": slug });
    Ok(Some((orgv, summary, Value::Array(notices))))
}

#[logged]
pub async fn app_ws(State(engine): State<Arc<Engine>>, headers: axum::http::HeaderMap,
                    scope: Option<axum::Extension<crate::client_tokens::Scope>>, ws: WebSocketUpgrade) -> Response {
    // a window of a remote engine gets the composed feed (the guard refused an unknown connection);
    // a computer that was let in gets the feed made for it
    let audience = Audience::of(&engine, &headers, scope.as_ref().map(|scope| &scope.0));
    ws.on_upgrade(move |socket| run_socket(engine, socket, audience))
}

/// How many windows hold the app feed open right now. The usage loop reads it:
/// with a window open, readings are kept a minute fresh (3.x's modal poll).
static WINDOWS: AtomicUsize = AtomicUsize::new(0);

#[nolog]
pub fn windows_open() -> usize {
    WINDOWS.load(Ordering::Relaxed)
}

#[logged]
async fn run_socket(engine: Arc<Engine>, socket: WebSocket, audience: Audience) {
    WINDOWS.fetch_add(1, Ordering::Relaxed);
    let id = next_socket_id();
    let (out, mut rx) = mpsc::channel::<Arc<str>>(2048);
    let _ = engine.app.tx.send((Msg::Open(id, out, audience), crate::trace::current_rq()));
    let (mut sink, mut stream) = socket.split();
    let shutdown = engine.shutdown.clone();
    loop {
        tokio::select! {
            m = rx.recv() => {
                let Some(text) = m else { break };
                if sink.send(Message::Text(text.to_string().into())).await.is_err() { break; }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            _ = shutdown.cancelled() => break,
        }
    }
    WINDOWS.fetch_sub(1, Ordering::Relaxed);
    let _ = engine.app.tx.send((Msg::Close(id), crate::trace::current_rq()));
}
