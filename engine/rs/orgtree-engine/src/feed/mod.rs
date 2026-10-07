//! The per-org record feed: one task per org owns the org's pushed state and
//! is the only thing that assigns its revisions. Writers never wait on it:
//! after a commit they drop "these keys changed" on its channel; it re-reads
//! those rows (batched; one read in flight at a time, so results apply in
//! order), diffs, bumps the revision and sends each socket its frame.
//!
//! Protocol (renderer `recordfeed.ts`): `record_snapshot` / `record_changes`
//! / `record_subscribed` / `agent_runtime` frames, cursor
//! `(org_uuid, incarnation, rev)`; incarnation = this engine process.

pub mod compute;
pub mod groups;
pub mod rooms;
pub mod socket;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

use crate::domain::scope;
use crate::domain::tree::{agent_body, TreeCtx};
use crate::engine::Engine;
use rooms::{Out, SocketId};

/// What changed. Writers name the rows they touched; the feed re-reads them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// one header group by name
    Group(&'static str),
    /// org row + every group + every live agent (settings, dirs, killswitch)
    Org,
    /// one agent's record (live or retired)
    Agent(i64),
    /// the user's inbox, read log and sent windows (+ inbox summary group)
    UserMail,
    /// the org event window (+ count)
    Events,
    /// one agent's mailbox window
    Mailbox(i64),
    /// one agent's history window
    History(i64),
    /// audiences held (agent bodies carry them)
    Audiences,
}

/// A feed message and the request that sent it.
type Env = (Msg, Option<String>);

#[derive(Clone)]
pub struct OrgFeed {
    tx: mpsc::UnboundedSender<Env>,
}

enum Msg {
    Invalidate(Vec<Key>),
    Runtime { agent: i64, value: Value },
    Snapshot(oneshot::Sender<Value>),
    Changes { after: u64, org_uuid: String, incarnation: String, reply: oneshot::Sender<Value> },
    Select { req: Value, reply: oneshot::Sender<Value> },
    SocketOpen { id: SocketId, out: Out },
    SocketClose { id: SocketId },
    SocketMsg { id: SocketId, msg: Value },
    Computed(Box<Computed>),
    SubComputed { sock: SocketId, sub: u64, records: Vec<(String, String, Value)>, error: Option<String> },
    FlushRuntime,
    LiveAgents(oneshot::Sender<Vec<(i64, String, Option<i64>)>>),
}

#[logged]
impl OrgFeed {
    pub fn invalidate(&self, keys: impl IntoIterator<Item = Key>) {
        let keys: Vec<Key> = keys.into_iter().collect();
        if !keys.is_empty() {
            let _ = self.tx.send((Msg::Invalidate(keys), crate::trace::current_rq()));
        }
    }
    #[nolog]
    pub fn runtime(&self, agent: i64, value: Value) {
        let _ = self.tx.send((Msg::Runtime { agent, value }, None));
    }
    pub async fn snapshot(&self) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx.send((Msg::Snapshot(tx), crate::trace::current_rq())).ok()?;
        rx.await.ok()
    }
    pub async fn changes(&self, after: u64, org_uuid: String, incarnation: String) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx.send((Msg::Changes { after, org_uuid, incarnation, reply: tx }, crate::trace::current_rq())).ok()?;
        rx.await.ok()
    }
    pub async fn select(&self, req: Value) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx.send((Msg::Select { req, reply: tx }, crate::trace::current_rq())).ok()?;
        rx.await.ok()
    }
    pub fn socket_open(&self, id: SocketId, out: Out) {
        let _ = self.tx.send((Msg::SocketOpen { id, out }, crate::trace::current_rq()));
    }
    pub fn socket_close(&self, id: SocketId) {
        let _ = self.tx.send((Msg::SocketClose { id }, crate::trace::current_rq()));
    }
    pub fn socket_msg(&self, id: SocketId, msg: Value) {
        let _ = self.tx.send((Msg::SocketMsg { id, msg }, crate::trace::current_rq()));
    }
    /// (id, name, parent) of every live agent, from the feed's own model.
    pub async fn live_agents(&self) -> Vec<(i64, String, Option<i64>)> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send((Msg::LiveAgents(tx), crate::trace::current_rq())).is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }
}

#[derive(Default)]
struct Computed {
    org_row: Option<Value>,
    audiences: Option<HashMap<String, Vec<String>>>,
    agents: HashMap<i64, Option<Value>>,
    groups: HashMap<String, Value>,
    user_mail: Option<(Vec<(i64, Value)>, Vec<(i64, Value)>, Vec<(i64, Value)>)>,
    events: Option<(Vec<(i64, Value)>, i64)>,
    mailboxes: HashMap<i64, Vec<(String, Value)>>,
    histories: HashMap<i64, Vec<(String, Value)>>,
    failed: Option<String>,
}

#[derive(Clone, Debug)]
enum Window {
    ArchivedAll,
    ArchivedUnder(Option<i64>),
    Mailbox(i64),
    History(i64),
}

struct Sub {
    set: String,
    agents: HashSet<i64>,
    windows: Vec<Window>,
    /// (entity, id) → body
    records: HashMap<(String, String), Arc<Value>>,
    ready: bool,
    dirty: bool,
}

struct Sock {
    out: Out,
    last_rev: u64,
    subs: HashMap<u64, Sub>,
}

struct Batch {
    rev: u64,
    upserts: Vec<(String, String, Arc<Value>)>,
    tombstones: Vec<(String, String)>,
}

const RING: usize = 512;

#[logged]
pub fn spawn(engine: Arc<Engine>, org_id: i64, org_uuid: String) -> OrgFeed {
    let (tx, rx) = mpsc::unbounded_channel();
    let feed = OrgFeed { tx: tx.clone() };
    let actor = Actor {
        engine: engine.clone(),
        org_id,
        org_uuid,
        incarnation: engine.boot.id.clone(),
        rev: 0,
        org_row: Value::Null,
        audiences_held: HashMap::new(),
        live_raw: HashMap::new(),
        live_body: HashMap::new(),
        eff_scope: HashMap::new(),
        shared: BTreeMap::new(),
        ring: VecDeque::new(),
        runtime: HashMap::new(),
        rt_seq: 0,
        rt_dirty: HashSet::new(),
        rt_flush_scheduled: false,
        sockets: HashMap::new(),
        pending: HashSet::new(),
        inflight: false,
        loaded: false,
        waiting_load: Vec::new(),
        tx,
    };
    tokio::spawn(actor.run(rx));
    feed.invalidate([Key::Org, Key::UserMail, Key::Events, Key::Audiences]);
    feed
}

struct Actor {
    engine: Arc<Engine>,
    org_id: i64,
    org_uuid: String,
    incarnation: String,
    rev: u64,
    org_row: Value,
    audiences_held: HashMap<String, Vec<String>>,
    live_raw: HashMap<i64, Value>,
    live_body: HashMap<i64, Arc<Value>>,
    eff_scope: HashMap<i64, Value>,
    /// every shared-set record except agents: (entity, id) → body
    shared: BTreeMap<(String, String), Arc<Value>>,
    ring: VecDeque<Batch>,
    runtime: HashMap<i64, Value>,
    rt_seq: u64,
    rt_dirty: HashSet<i64>,
    rt_flush_scheduled: bool,
    sockets: HashMap<SocketId, Sock>,
    pending: HashSet<Key>,
    inflight: bool,
    loaded: bool,
    waiting_load: Vec<Env>,
    tx: mpsc::UnboundedSender<Env>,
}

fn rec(entity: &str, id: &str, body: &Value, set: Option<&str>) -> Value {
    let mut o = Map::new();
    o.insert("entity".into(), json!(entity));
    o.insert("id".into(), json!(id));
    o.insert("body".into(), body.clone());
    if let Some(s) = set {
        o.insert("set".into(), json!(s));
    }
    Value::Object(o)
}

#[logged]
impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Env>) {
        while let Some((msg, cause)) = rx.recv().await {
            // Reads that need the first load wait for it; writes queue anyway.
            if !self.loaded {
                match msg {
                    Msg::Snapshot(_) | Msg::Changes { .. } | Msg::Select { .. } | Msg::SocketOpen { .. }
                    | Msg::SocketMsg { .. } | Msg::LiveAgents(_) => {
                        self.waiting_load.push((msg, cause));
                        continue;
                    }
                    _ => {}
                }
            }
            self.handle_env(msg, cause);
            if self.loaded && !self.waiting_load.is_empty() {
                for (m, c) in std::mem::take(&mut self.waiting_load) {
                    self.handle_env(m, c);
                }
            }
        }
    }

    /// Each message is its own request (the runtime overlay's stream excepted).
    #[nolog]
    fn handle_env(&mut self, msg: Msg, cause: Option<String>) {
        if matches!(msg, Msg::Runtime { .. } | Msg::FlushRuntime) {
            return self.handle(msg);
        }
        let span = crate::trace::request_from("engine", cause.as_deref());
        let _g = span.enter();
        self.handle(msg);
    }

    #[nolog]
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Invalidate(keys) => {
                for k in keys {
                    self.mark_subs_dirty(&k);
                    self.pending.insert(k);
                }
                self.kick();
            }
            Msg::Computed(c) => {
                self.inflight = false;
                self.apply(*c);
                self.loaded = true;
                self.kick();
            }
            Msg::Runtime { agent, value } => {
                self.runtime.insert(agent, value);
                self.rt_dirty.insert(agent);
                if !self.rt_flush_scheduled {
                    self.rt_flush_scheduled = true;
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        let _ = tx.send((Msg::FlushRuntime, None));
                    });
                }
            }
            Msg::FlushRuntime => {
                self.rt_flush_scheduled = false;
                self.flush_runtime();
            }
            Msg::Snapshot(reply) => {
                let _ = reply.send(self.snapshot());
            }
            Msg::Changes { after, org_uuid, incarnation, reply } => {
                let _ = reply.send(self.changes(after, &org_uuid, &incarnation));
            }
            Msg::Select { req, reply } => self.select(req, reply),
            Msg::SocketOpen { id, out } => {
                // The first frame on a socket must be a FULL runtime copy: it
                // establishes this engine's epoch in the renderer's overlay.
                let frame = self.runtime_frame(true, None);
                let _ = out.try_send(Arc::from(frame.to_string()));
                self.sockets.insert(id, Sock { out, last_rev: self.rev, subs: HashMap::new() });
            }
            Msg::SocketClose { id } => {
                self.sockets.remove(&id);
            }
            Msg::SocketMsg { id, msg } => self.socket_msg(id, msg),
            Msg::SubComputed { sock, sub, records, error } => self.sub_computed(sock, sub, records, error),
            Msg::LiveAgents(reply) => {
                let v = self
                    .live_raw
                    .iter()
                    .map(|(id, r)| (*id, r["name"].as_str().unwrap_or("").to_string(), r["parent_id"].as_i64()))
                    .collect();
                let _ = reply.send(v);
            }
        }
    }

    #[nolog]
    fn mark_subs_dirty(&mut self, k: &Key) {
        for s in self.sockets.values_mut() {
            for sub in s.subs.values_mut() {
                if sub.ready {
                    continue;
                }
                let hit = match k {
                    Key::Agent(a) => sub.agents.contains(a)
                        || sub.windows.iter().any(|w| matches!(w, Window::ArchivedAll | Window::ArchivedUnder(_))),
                    Key::Mailbox(a) => sub.windows.iter().any(|w| matches!(w, Window::Mailbox(x) if x == a)),
                    Key::History(a) => sub.windows.iter().any(|w| matches!(w, Window::History(x) if x == a)),
                    Key::Org => true,
                    _ => false,
                };
                if hit {
                    sub.dirty = true;
                }
            }
        }
    }

    /// Start one batched read if none is in flight.
    fn kick(&mut self) {
        if self.inflight || self.pending.is_empty() {
            return;
        }
        self.inflight = true;
        let keys: Vec<Key> = self.pending.drain().collect();
        let engine = self.engine.clone();
        let org_id = self.org_id;
        let tx = self.tx.clone();
        let live_ids: Vec<i64> = self.live_raw.keys().copied().collect();
        let org_row = self.org_row.clone();
        crate::trace::spawn(async move {
            let computed = match read(&engine, org_id, keys, live_ids, org_row).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(org_id, error = %format!("{e:#}"), "feed read failed");
                    Computed { failed: Some(e.to_string()), ..Default::default() }
                }
            };
            let _ = tx.send((Msg::Computed(Box::new(computed)), crate::trace::current_rq()));
        });
    }

    fn ctx_bodies(&self) -> (Value, crate::accounts::AccountsView) {
        let settings = groups::effective_settings(&self.org_row["settings"], &self.engine.settings.defaults());
        (settings, self.engine.accounts.view())
    }

    /// Effective scopes and bodies for `ids` (and everything beneath them),
    /// top-down so a parent's effective scope is ready before its children.
    fn rebuild_agents(&mut self, roots: &HashSet<i64>) -> Vec<i64> {
        let mut children: HashMap<Option<i64>, Vec<i64>> = HashMap::new();
        for (id, r) in &self.live_raw {
            children.entry(r["parent_id"].as_i64()).or_default().push(*id);
        }
        // expand to descendants
        let mut todo: Vec<i64> = roots.iter().copied().filter(|i| self.live_raw.contains_key(i)).collect();
        let mut all: HashSet<i64> = HashSet::new();
        while let Some(i) = todo.pop() {
            if all.insert(i) {
                if let Some(c) = children.get(&Some(i)) {
                    todo.extend(c.iter().copied());
                }
            }
        }
        // order by depth
        let depth = |mut id: i64, live: &HashMap<i64, Value>| {
            let mut d = 0;
            while let Some(p) = live.get(&id).and_then(|r| r["parent_id"].as_i64()) {
                d += 1;
                id = p;
                if d > 2048 {
                    break;
                }
            }
            d
        };
        let mut ordered: Vec<(usize, i64)> = all.iter().map(|i| (depth(*i, &self.live_raw), *i)).collect();
        ordered.sort();
        let (settings, accounts) = self.ctx_bodies();
        let ceiling = scope::org_ceiling(&settings["dirs"]);
        let now = chrono::Utc::now();
        let slug = self.org_row["slug"].as_str().unwrap_or("");
        let ctx = TreeCtx { org_settings: &settings, now, accounts: &accounts, audiences_held: &self.audiences_held, org_slug: slug };
        let mut changed = Vec::new();
        for (_, id) in ordered {
            let raw = &self.live_raw[&id];
            let parent = raw["parent_id"].as_i64();
            let parent_eff = parent.and_then(|p| self.eff_scope.get(&p)).unwrap_or(&ceiling);
            let eff = scope::clamp(&raw["scope"], parent_eff);
            let body = Arc::new(agent_body(raw, &eff, parent, &ctx));
            self.eff_scope.insert(id, eff);
            let same = self.live_body.get(&id).map(|b| **b == *body).unwrap_or(false);
            if !same {
                self.live_body.insert(id, body);
                changed.push(id);
            }
        }
        changed
    }

    fn apply(&mut self, c: Computed) {
        if c.failed.is_some() {
            return;
        }
        let mut upserts: Vec<(String, String, Arc<Value>)> = Vec::new();
        let mut tombstones: Vec<(String, String)> = Vec::new();
        let mut rebuild: HashSet<i64> = HashSet::new();
        let mut sub_changes: HashMap<(SocketId, u64), (Vec<(String, String, Arc<Value>)>, Vec<(String, String)>)> =
            HashMap::new();

        if let Some(row) = c.org_row {
            self.org_row = row;
            rebuild.extend(self.live_raw.keys().copied());
        }
        if let Some(a) = c.audiences {
            self.audiences_held = a;
            rebuild.extend(self.live_raw.keys().copied());
        }
        // agents
        let mut retired_now: Vec<(i64, Value)> = Vec::new();
        for (id, raw) in c.agents {
            match raw {
                Some(r) if r["state"] == "live" => {
                    let old_parent = self.live_raw.get(&id).map(|o| o["parent_id"].clone());
                    let moved = old_parent.map(|p| p != r["parent_id"]).unwrap_or(true);
                    let scope_changed = self.live_raw.get(&id).map(|o| o["scope"] != r["scope"]).unwrap_or(true);
                    self.live_raw.insert(id, r);
                    rebuild.insert(id);
                    let _ = (moved, scope_changed);
                }
                other => {
                    if self.live_raw.remove(&id).is_some() {
                        self.live_body.remove(&id);
                        self.eff_scope.remove(&id);
                        tombstones.push(("agent".into(), id.to_string()));
                    }
                    if let Some(r) = other {
                        retired_now.push((id, r));
                    } else {
                        // deleted: drop from every subscription holding it
                        for (sid, s) in self.sockets.iter_mut() {
                            for (n, sub) in s.subs.iter_mut() {
                                let key = ("agent".to_string(), id.to_string());
                                if sub.records.remove(&key).is_some() {
                                    sub_changes.entry((*sid, *n)).or_default().1.push(key);
                                }
                            }
                        }
                    }
                }
            }
        }
        for id in self.rebuild_agents(&rebuild) {
            upserts.push(("agent".into(), id.to_string(), self.live_body[&id].clone()));
        }
        // a live agent can also sit in a subscription (explicit agent ids): keep it current there
        for (id, body) in upserts.iter().filter(|(e, _, _)| e == "agent").map(|(_, id, b)| (id.clone(), b.clone())) {
            let aid: i64 = id.parse().unwrap_or(0);
            for (sid, s) in self.sockets.iter_mut() {
                for (n, sub) in s.subs.iter_mut() {
                    if sub.ready && sub.agents.contains(&aid) {
                        sub.records.insert(("agent".into(), id.clone()), body.clone());
                        sub_changes.entry((*sid, *n)).or_default().0.push(("agent".into(), id.clone(), body.clone()));
                    }
                }
            }
        }
        // retired agents → windows that include them
        if !retired_now.is_empty() {
            let (settings, accounts) = self.ctx_bodies();
            let ceiling = scope::org_ceiling(&settings["dirs"]);
            let ctx = TreeCtx {
                org_settings: &settings,
                now: chrono::Utc::now(),
                accounts: &accounts,
                audiences_held: &self.audiences_held,
                org_slug: self.org_row["slug"].as_str().unwrap_or(""),
            };
            for (id, raw) in retired_now {
                let parent = raw["parent_id"].as_i64();
                let eff = scope::clamp(&raw["scope"], &ceiling);
                let body = Arc::new(agent_body(&raw, &eff, parent, &ctx));
                for (sid, s) in self.sockets.iter_mut() {
                    for (n, sub) in s.subs.iter_mut() {
                        if !sub.ready {
                            continue;
                        }
                        let wants = sub.agents.contains(&id)
                            || sub.windows.iter().any(|w| match w {
                                Window::ArchivedAll => true,
                                Window::ArchivedUnder(p) => *p == parent,
                                _ => false,
                            });
                        let key = ("agent".to_string(), id.to_string());
                        if wants {
                            sub.records.insert(key.clone(), body.clone());
                            sub_changes.entry((*sid, *n)).or_default().0.push((key.0, key.1, body.clone()));
                        } else if sub.records.remove(&key).is_some() {
                            sub_changes.entry((*sid, *n)).or_default().1.push(key);
                        }
                    }
                }
            }
        }
        // groups
        for (name, body) in c.groups {
            self.put_shared("org", &name, body, &mut upserts);
        }
        // user mail windows
        if let Some((pending, log, sent)) = c.user_mail {
            self.replace_window("user_inbox", pending, &mut upserts, &mut tombstones);
            self.replace_window("user_mail_log:shared", log, &mut upserts, &mut tombstones);
            self.replace_window("user_outbox:shared", sent, &mut upserts, &mut tombstones);
        }
        if let Some((rows, count)) = c.events {
            self.replace_window("event:shared", rows, &mut upserts, &mut tombstones);
            self.put_shared("org", "events_count", json!({ "events_count": count }), &mut upserts);
        }
        // per-agent windows
        for (agent, rows) in c.mailboxes {
            self.replace_sub_window(&format!("agent_mail:{agent}"), &Window::Mailbox(agent), rows, &mut sub_changes);
        }
        for (agent, rows) in c.histories {
            self.replace_sub_window(&format!("agent_history:{agent}"), &Window::History(agent), rows, &mut sub_changes);
        }
        if upserts.is_empty() && tombstones.is_empty() && sub_changes.is_empty() {
            return;
        }
        self.publish(upserts, tombstones, sub_changes);
    }

    #[nolog]
    fn put_shared(&mut self, entity: &str, id: &str, body: Value, upserts: &mut Vec<(String, String, Arc<Value>)>) {
        let key = (entity.to_string(), id.to_string());
        if self.shared.get(&key).map(|b| **b == body).unwrap_or(false) {
            return;
        }
        let body = Arc::new(body);
        self.shared.insert(key.clone(), body.clone());
        upserts.push((key.0, key.1, body));
    }

    fn replace_window(
        &mut self,
        entity: &str,
        rows: Vec<(i64, Value)>,
        upserts: &mut Vec<(String, String, Arc<Value>)>,
        tombstones: &mut Vec<(String, String)>,
    ) {
        let fresh: HashSet<String> = rows.iter().map(|(id, _)| id.to_string()).collect();
        let stale: Vec<(String, String)> = self
            .shared
            .keys()
            .filter(|(e, id)| e == entity && !fresh.contains(id))
            .cloned()
            .collect();
        for k in stale {
            self.shared.remove(&k);
            tombstones.push(k);
        }
        for (id, body) in rows {
            self.put_shared(entity, &id.to_string(), body, upserts);
        }
    }

    fn replace_sub_window(
        &mut self,
        entity: &str,
        window: &Window,
        rows: Vec<(String, Value)>,
        sub_changes: &mut HashMap<(SocketId, u64), (Vec<(String, String, Arc<Value>)>, Vec<(String, String)>)>,
    ) {
        for (sid, s) in self.sockets.iter_mut() {
            for (n, sub) in s.subs.iter_mut() {
                if !sub.ready || !sub.windows.iter().any(|w| same_window(w, window)) {
                    continue;
                }
                let fresh: HashSet<&String> = rows.iter().map(|(id, _)| id).collect();
                let stale: Vec<(String, String)> = sub
                    .records
                    .keys()
                    .filter(|(e, id)| e == entity && !fresh.contains(id))
                    .cloned()
                    .collect();
                let entry = sub_changes.entry((*sid, *n)).or_default();
                for k in stale {
                    sub.records.remove(&k);
                    entry.1.push(k);
                }
                for (id, body) in &rows {
                    let key = (entity.to_string(), id.clone());
                    if sub.records.get(&key).map(|b| **b == *body).unwrap_or(false) {
                        continue;
                    }
                    let b = Arc::new(body.clone());
                    sub.records.insert(key.clone(), b.clone());
                    entry.0.push((key.0, key.1, b));
                }
            }
        }
    }

    fn publish(
        &mut self,
        upserts: Vec<(String, String, Arc<Value>)>,
        tombstones: Vec<(String, String)>,
        sub_changes: HashMap<(SocketId, u64), (Vec<(String, String, Arc<Value>)>, Vec<(String, String)>)>,
    ) {
        self.rev += 1;
        let rev = self.rev;
        let shared_up: Vec<Value> = upserts.iter().map(|(e, id, b)| rec(e, id, b, None)).collect();
        let shared_tomb: Vec<Value> = tombstones.iter().map(|(e, id)| json!({ "entity": e, "id": id })).collect();
        self.ring.push_back(Batch { rev, upserts, tombstones });
        while self.ring.len() > RING {
            self.ring.pop_front();
        }
        let mut dead = Vec::new();
        for (sid, sock) in self.sockets.iter_mut() {
            let mut ups = shared_up.clone();
            let mut tombs = shared_tomb.clone();
            for (n, sub) in sock.subs.iter() {
                if let Some((u, t)) = sub_changes.get(&(*sid, *n)) {
                    let _ = sub;
                    let set = format!("sub:{n}");
                    ups.extend(u.iter().map(|(e, id, b)| rec(e, id, b, Some(&set))));
                    tombs.extend(t.iter().map(|(e, id)| json!({ "entity": e, "id": id, "set": set })));
                }
            }
            let frame = json!({
                "type": "record_changes", "org_uuid": self.org_uuid, "incarnation": self.incarnation,
                "from": sock.last_rev, "to": rev, "upserts": ups, "tombstones": tombs,
            });
            if sock.out.try_send(Arc::from(frame.to_string())).is_err() {
                if sock.out.is_closed() {
                    dead.push(*sid);
                }
                // a full queue: the renderer sees the gap on the next frame and catches up
            }
            sock.last_rev = rev;
        }
        for d in dead {
            self.sockets.remove(&d);
        }
    }

    fn shared_records(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self
            .shared
            .iter()
            .filter(|((e, id), _)| !(e == "org" && id == "events_count") || true)
            .map(|((e, id), b)| rec(e, id, b, None))
            .collect();
        out.extend(self.live_body.iter().map(|(id, b)| rec("agent", &id.to_string(), b, None)));
        out
    }

    fn snapshot(&self) -> Value {
        json!({
            "type": "record_snapshot",
            "cursor": { "org_uuid": self.org_uuid, "incarnation": self.incarnation, "rev": self.rev },
            "records": self.shared_records(),
            "runtime": self.runtime_frame(true, None),
        })
    }

    fn changes(&self, after: u64, org_uuid: &str, incarnation: &str) -> Value {
        if org_uuid != self.org_uuid || incarnation != self.incarnation || after > self.rev {
            return self.snapshot();
        }
        if after == self.rev {
            return json!({ "type": "record_changes", "org_uuid": self.org_uuid, "incarnation": self.incarnation,
                           "from": after, "to": after, "upserts": [], "tombstones": [] });
        }
        let oldest = self.ring.front().map(|b| b.rev).unwrap_or(self.rev + 1);
        if after + 1 < oldest {
            return self.snapshot();
        }
        let mut latest: HashMap<(String, String), Option<Arc<Value>>> = HashMap::new();
        for b in self.ring.iter().filter(|b| b.rev > after) {
            for (e, id, body) in &b.upserts {
                latest.insert((e.clone(), id.clone()), Some(body.clone()));
            }
            for (e, id) in &b.tombstones {
                latest.insert((e.clone(), id.clone()), None);
            }
        }
        let mut ups = Vec::new();
        let mut tombs = Vec::new();
        for ((e, id), b) in latest {
            match b {
                Some(body) => ups.push(rec(&e, &id, &body, None)),
                None => tombs.push(json!({ "entity": e, "id": id })),
            }
        }
        json!({ "type": "record_changes", "org_uuid": self.org_uuid, "incarnation": self.incarnation,
                "from": after, "to": self.rev, "upserts": ups, "tombstones": tombs })
    }

    #[nolog]
    fn runtime_frame(&self, full: bool, only: Option<&HashSet<i64>>) -> Value {
        let mut agents = Map::new();
        let seq = self.rt_seq.max(1);
        for (id, v) in &self.runtime {
            if let Some(o) = only {
                if !o.contains(id) {
                    continue;
                }
            }
            let mut val = v.as_object().cloned().unwrap_or_default();
            val.insert("epoch".into(), json!(self.incarnation));
            val.insert("seq".into(), json!(seq));
            agents.insert(id.to_string(), Value::Object(val));
        }
        json!({
            "type": "agent_runtime", "org_uuid": self.org_uuid, "incarnation": self.incarnation,
            "epoch": self.incarnation, "seq": seq, "full": full, "agents": agents,
        })
    }

    #[nolog]
    fn flush_runtime(&mut self) {
        if self.rt_dirty.is_empty() {
            return;
        }
        self.rt_seq += 1;
        let dirty = std::mem::take(&mut self.rt_dirty);
        let frame = self.runtime_frame(false, Some(&dirty));
        let text: Arc<str> = Arc::from(frame.to_string());
        for s in self.sockets.values() {
            let _ = s.out.try_send(text.clone());
        }
    }

    fn socket_msg(&mut self, id: SocketId, msg: Value) {
        match msg["type"].as_str() {
            Some("subscribe") => {
                let Some(n) = msg["sub"].as_u64() else { return };
                let agents: HashSet<i64> = msg["agents"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().and_then(|s| s.parse().ok())).collect())
                    .unwrap_or_default();
                let windows: Vec<Window> = msg["windows"]
                    .as_array()
                    .map(|a| a.iter().filter_map(parse_window).collect())
                    .unwrap_or_default();
                let Some(sock) = self.sockets.get_mut(&id) else { return };
                sock.subs.insert(
                    n,
                    Sub {
                        set: format!("sub:{n}"),
                        agents: agents.clone(),
                        windows: windows.clone(),
                        records: HashMap::new(),
                        ready: false,
                        dirty: false,
                    },
                );
                let engine = self.engine.clone();
                let org_id = self.org_id;
                let tx = self.tx.clone();
                let org_row = self.org_row.clone();
                let audiences = self.audiences_held.clone();
                let live: HashMap<i64, Value> = agents
                    .iter()
                    .filter_map(|a| self.live_body.get(a).map(|b| (*a, (**b).clone())))
                    .collect();
                crate::trace::spawn(async move {
                    let res = read_sub(&engine, org_id, &org_row, &audiences, agents, windows, live).await;
                    let (records, error) = match res {
                        Ok(r) => (r, None),
                        Err(e) => (Vec::new(), Some(e.to_string())),
                    };
                    let _ = tx.send((Msg::SubComputed { sock: id, sub: n, records, error }, crate::trace::current_rq()));
                });
            }
            Some("unsubscribe") => {
                if let (Some(n), Some(sock)) = (msg["sub"].as_u64(), self.sockets.get_mut(&id)) {
                    sock.subs.remove(&n);
                }
            }
            _ => {}
        }
    }

    fn sub_computed(&mut self, sock_id: SocketId, n: u64, records: Vec<(String, String, Value)>, error: Option<String>) {
        let rev = self.rev;
        let (org_uuid, inc) = (self.org_uuid.clone(), self.incarnation.clone());
        let Some(sock) = self.sockets.get_mut(&sock_id) else { return };
        let Some(sub) = sock.subs.get_mut(&n) else { return };
        if let Some(e) = error {
            tracing::warn!(error = %e, "subscription read failed");
        }
        sub.records = records.iter().map(|(e, id, b)| ((e.clone(), id.clone()), Arc::new(b.clone()))).collect();
        sub.ready = true;
        let dirty = std::mem::take(&mut sub.dirty);
        let set = sub.set.clone();
        let all: Vec<Value> = records.iter().map(|(e, id, b)| rec(e, id, b, Some(&set))).collect();
        const PAGE: usize = 250;
        if all.len() <= PAGE {
            let frame = json!({ "type": "record_subscribed", "sub": n, "org_uuid": org_uuid,
                                "incarnation": inc, "rev": rev, "records": all });
            let _ = sock.out.try_send(Arc::from(frame.to_string()));
        } else {
            let pages: Vec<&[Value]> = all.chunks(PAGE).collect();
            let last = pages.len() - 1;
            for (i, page) in pages.into_iter().enumerate() {
                let frame = json!({ "type": "record_subscribed", "sub": n, "org_uuid": org_uuid,
                                    "incarnation": inc, "rev": rev, "records": page,
                                    "page": i, "final": i == last });
                let _ = sock.out.try_send(Arc::from(frame.to_string()));
            }
        }
        sock.last_rev = rev;
        if dirty {
            // something it covers changed while it was being read: refresh it
            let windows = sub.windows.clone();
            let agents: Vec<i64> = sub.agents.iter().copied().collect();
            let mut keys: Vec<Key> = agents.into_iter().map(Key::Agent).collect();
            for w in windows {
                match w {
                    Window::Mailbox(a) => keys.push(Key::Mailbox(a)),
                    Window::History(a) => keys.push(Key::History(a)),
                    _ => {}
                }
            }
            for k in keys {
                self.pending.insert(k);
            }
            self.kick();
        }
    }

    fn select(&self, req: Value, reply: oneshot::Sender<Value>) {
        let names: Vec<String> = req["names"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut found: Map<String, Value> = Map::new();
        let mut unresolved = Vec::new();
        let by_name: HashMap<&str, i64> =
            self.live_raw.iter().map(|(id, r)| (r["name"].as_str().unwrap_or(""), *id)).collect();
        for n in &names {
            match by_name.get(n.as_str()) {
                Some(id) => {
                    found.insert(n.clone(), json!(id.to_string()));
                }
                None => unresolved.push(n.clone()),
            }
        }
        let cursor = json!({ "org_uuid": self.org_uuid, "incarnation": self.incarnation, "rev": self.rev });
        let search = req.get("search").cloned().filter(|s| s.is_object());
        let engine = self.engine.clone();
        let org_id = self.org_id;
        crate::trace::spawn(async move {
            let mut missing = Vec::new();
            let mut matches = Vec::new();
            if let Ok(client) = engine.db.get().await {
                if !unresolved.is_empty() {
                    if let Ok(rows) = client
                        .query(
                            "SELECT name, id FROM ot.agents WHERE org_id = $1 AND name = ANY($2) AND state <> 'deleted'",
                            &[&org_id, &unresolved],
                        )
                        .await
                    {
                        let got: HashMap<String, i64> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
                        for n in &unresolved {
                            match got.get(n) {
                                Some(id) => {
                                    found.insert(n.clone(), json!(id.to_string()));
                                }
                                None => missing.push(n.clone()),
                            }
                        }
                    } else {
                        missing.extend(unresolved.clone());
                    }
                }
                if let Some(s) = search {
                    let q = format!("%{}%", s["query"].as_str().unwrap_or("").replace('%', "\\%"));
                    let state = s.get("state").and_then(Value::as_str).map(str::to_string);
                    let rows = client
                        .query(
                            "SELECT id FROM ot.agents WHERE org_id = $1 AND state <> 'deleted'
                               AND ($3::text IS NULL OR state = $3)
                               AND (name ILIKE $2 OR title ILIKE $2) ORDER BY id DESC LIMIT 200",
                            &[&org_id, &q, &state],
                        )
                        .await
                        .unwrap_or_default();
                    matches = rows.iter().map(|r| json!(r.get::<_, i64>(0).to_string())).collect();
                }
            } else {
                missing.extend(unresolved);
            }
            let _ = reply.send(json!({ "cursor": cursor, "names": found, "missing": missing, "matches": matches }));
        });
    }
}

fn same_window(a: &Window, b: &Window) -> bool {
    match (a, b) {
        (Window::Mailbox(x), Window::Mailbox(y)) => x == y,
        (Window::History(x), Window::History(y)) => x == y,
        _ => false,
    }
}

#[logged]
fn parse_window(w: &Value) -> Option<Window> {
    match w["kind"].as_str()? {
        "archived_all" => Some(Window::ArchivedAll),
        "archived_under" => {
            let p = w["parent"].as_str().unwrap_or("0");
            let p: i64 = p.parse().ok()?;
            Some(Window::ArchivedUnder(if p == 0 { None } else { Some(p) }))
        }
        "agent_mail" => w["agent"].as_str()?.parse().ok().map(Window::Mailbox),
        "agent_history" => w["agent"].as_str()?.parse().ok().map(Window::History),
        _ => None,
    }
}

/// The batched read behind one round of invalidations.
#[logged]
async fn read(engine: &Engine, org_id: i64, keys: Vec<Key>, live_ids: Vec<i64>, org_row: Value) -> Result<Computed> {
    let client = engine.db.get().await?;
    let mut c = Computed::default();
    let mut agent_ids: HashSet<i64> = HashSet::new();
    let mut group_names: HashSet<&'static str> = HashSet::new();
    let mut org_row = org_row;
    for k in &keys {
        match k {
            Key::Org => {
                let row = compute::org_row(&client, org_id).await?;
                org_row = row.clone();
                c.org_row = Some(row);
                group_names.extend(groups::GROUPS.iter().copied());
            }
            Key::Group(g) => {
                group_names.insert(g);
            }
            Key::Agent(id) => {
                agent_ids.insert(*id);
            }
            Key::UserMail => {
                c.user_mail = Some(compute::user_mail(&client, org_id).await?);
                group_names.insert("inbox_summary");
            }
            Key::Events => {
                c.events = Some(compute::events_window(&client, org_id).await?);
            }
            Key::Mailbox(a) => {
                c.mailboxes.insert(*a, compute::agent_mailbox(&client, *a).await?);
            }
            Key::History(a) => {
                c.histories.insert(*a, compute::agent_history(&client, *a).await?);
            }
            Key::Audiences => {
                c.audiences = Some(compute::audiences_held(&client, org_id).await?);
                group_names.insert("audiences");
                group_names.insert("org_inbox");
            }
        }
    }
    if c.org_row.is_some() {
        // the first load (and settings changes) read every live agent
        let all = compute::live_agents(&client, org_id).await?;
        for id in live_ids {
            if !all.contains_key(&id) {
                agent_ids.insert(id);
            }
        }
        for (id, raw) in all {
            c.agents.insert(id, Some(raw));
        }
    }
    let wanted: Vec<i64> = agent_ids.into_iter().filter(|id| !c.agents.contains_key(id)).collect();
    if !wanted.is_empty() {
        let got = compute::agents(&client, org_id, &wanted).await?;
        for id in wanted {
            c.agents.insert(id, got.get(&id).cloned());
        }
    }
    if !org_row.is_null() {
        for g in group_names {
            c.groups.insert(g.to_string(), groups::group(engine, &client, &org_row, g).await?);
        }
    }
    Ok(c)
}

/// A subscription's first answer.
#[logged]
async fn read_sub(
    engine: &Engine,
    org_id: i64,
    org_row: &Value,
    audiences: &HashMap<String, Vec<String>>,
    agents: HashSet<i64>,
    windows: Vec<Window>,
    live: HashMap<i64, Value>,
) -> Result<Vec<(String, String, Value)>> {
    let client = engine.db.get().await?;
    let mut out: Vec<(String, String, Value)> = Vec::new();
    let mut raws: HashMap<i64, Value> = HashMap::new();
    let explicit: Vec<i64> = agents.iter().copied().filter(|a| !live.contains_key(a)).collect();
    if !explicit.is_empty() {
        raws.extend(compute::agents(&client, org_id, &explicit).await?);
    }
    for w in &windows {
        match w {
            Window::ArchivedAll => raws.extend(compute::retired_agents(&client, org_id, None).await?),
            Window::ArchivedUnder(p) => raws.extend(compute::retired_agents(&client, org_id, Some(*p)).await?),
            Window::Mailbox(a) => {
                for (id, body) in compute::agent_mailbox(&client, *a).await? {
                    out.push((format!("agent_mail:{a}"), id, body));
                }
            }
            Window::History(a) => {
                for (id, body) in compute::agent_history(&client, *a).await? {
                    out.push((format!("agent_history:{a}"), id, body));
                }
            }
        }
    }
    let settings = groups::effective_settings(&org_row["settings"], &engine.settings.defaults());
    let ceiling = scope::org_ceiling(&settings["dirs"]);
    let accounts = engine.accounts.view();
    let ctx = TreeCtx {
        org_settings: &settings,
        now: chrono::Utc::now(),
        accounts: &accounts,
        audiences_held: audiences,
        org_slug: org_row["slug"].as_str().unwrap_or(""),
    };
    for (id, raw) in raws {
        let eff = scope::clamp(&raw["scope"], &ceiling);
        let body = agent_body(&raw, &eff, raw["parent_id"].as_i64(), &ctx);
        out.push(("agent".into(), id.to_string(), body));
    }
    for (id, body) in live {
        out.push(("agent".into(), id.to_string(), body));
    }
    Ok(out)
}
