//! The app feed (`/api/app/ws`, `/api/app/records`): the org registry, each
//! org's summary and desktop notices, the machine-wide pushed values
//! (providers, accounts, usage peeks...) and per-org "working" counts.
//! One task owns it; producers send to it and never wait.

use std::collections::{HashMap, HashSet};
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
    tx: mpsc::UnboundedSender<Msg>,
}

/// The feed task's inbox, handed to `start` once.
pub struct AppFeedInbox(mpsc::UnboundedReceiver<Msg>);

enum Msg {
    Registry,
    Org(i64),
    Value(String, Value),
    Working(i64, i64),
    Snapshot(oneshot::Sender<Value>),
    Open(SocketId, Out),
    Close(SocketId),
    RegistryRead(Vec<Value>),
    OrgRead(i64, Option<(Value, Value, Value)>),
    Flush,
}

impl AppFeed {
    pub fn new() -> (Self, AppFeedInbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        (AppFeed { tx }, AppFeedInbox(rx))
    }
    /// The org list changed (create, delete, rename).
    pub fn registry_changed(&self) {
        let _ = self.tx.send(Msg::Registry);
    }
    /// One org's summary or notices may have changed.
    pub fn org_changed(&self, org_id: i64) {
        let _ = self.tx.send(Msg::Org(org_id));
    }
    pub fn set_value(&self, key: &str, value: Value) {
        let _ = self.tx.send(Msg::Value(key.to_string(), value));
    }
    pub fn working(&self, org_id: i64, n: i64) {
        let _ = self.tx.send(Msg::Working(org_id, n));
    }
    pub async fn snapshot(&self) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Msg::Snapshot(tx)).ok()?;
        rx.await.ok()
    }
}

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
        flush_scheduled: false,
        tx: engine.app.tx.clone(),
    };
    tokio::spawn(actor.run(rx));
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
    sockets: HashMap<SocketId, Out>,
    dirty_orgs: HashSet<i64>,
    reading: HashSet<i64>,
    flush_scheduled: bool,
    tx: mpsc::UnboundedSender<Msg>,
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        self.app_uuid = app_uuid(&self.engine).await.unwrap_or_else(|_| "00000000-0000-0000-0000-000000000000".into());
        while let Some(msg) = rx.recv().await {
            self.handle(msg);
        }
    }

    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn broadcast(&mut self, frame: &Value) {
        let text: Arc<str> = Arc::from(frame.to_string());
        self.sockets.retain(|_, out| !out.is_closed());
        for out in self.sockets.values() {
            let _ = out.try_send(text.clone());
        }
    }

    fn registry_frame(&self) -> Value {
        json!({
            "type": "registry_snapshot", "epoch": self.epoch,
            "cursor": { "app_uuid": self.app_uuid, "incarnation": self.epoch, "rev": self.rev },
            "records": self.registry.iter().map(|body| json!({
                "entity": "registry_org", "id": body["org_id"].to_string(), "body": body,
            })).collect::<Vec<_>>(),
        })
    }

    fn snapshot(&mut self) -> Value {
        let seq = self.next();
        let summaries: Map<String, Value> =
            self.summaries.iter().map(|(id, e)| (id.to_string(), e.frame.clone())).collect();
        let notices: Map<String, Value> =
            self.notices.iter().map(|(id, e)| (id.to_string(), e.frame.clone())).collect();
        let values: Map<String, Value> = self
            .values
            .iter()
            .map(|(k, (s, v))| (k.clone(), json!({ "epoch": self.epoch, "seq": s, "value": v })))
            .collect();
        let orgs: Map<String, Value> = self
            .working
            .iter()
            .map(|(id, (s, n))| (id.to_string(), json!({ "epoch": self.epoch, "seq": s, "working": n })))
            .collect();
        json!({
            "type": "app_snapshot", "epoch": self.epoch, "seq": seq,
            "registry": self.registry_frame(),
            "summaries": summaries, "notices": notices,
            "runtime": { "values": values, "orgs": orgs },
        })
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Registry => {
                let engine = self.engine.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    if let Ok(rows) = read_registry(&engine).await {
                        let _ = tx.send(Msg::RegistryRead(rows));
                    }
                });
            }
            Msg::RegistryRead(rows) => {
                if rows != self.registry {
                    self.registry = rows;
                    self.rev += 1;
                    let frame = self.registry_frame();
                    self.broadcast(&frame);
                }
            }
            Msg::Org(id) => {
                self.dirty_orgs.insert(id);
                if !self.flush_scheduled {
                    self.flush_scheduled = true;
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = tx.send(Msg::Flush);
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
                    tokio::spawn(async move {
                        let got = read_org(&engine, id).await.ok().flatten();
                        let _ = tx.send(Msg::OrgRead(id, got));
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
                        }
                        if n_changed {
                            self.notices.insert(id, Entry { seq, frame: nframe.clone() });
                            self.broadcast(&nframe);
                        }
                    }
                    None => {
                        self.summaries.remove(&id);
                        self.notices.remove(&id);
                    }
                }
                if self.dirty_orgs.contains(&id) && !self.flush_scheduled {
                    self.flush_scheduled = true;
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        let _ = tx.send(Msg::Flush);
                    });
                }
            }
            Msg::Value(key, value) => {
                if self.values.get(&key).map(|(_, v)| *v == value).unwrap_or(false) {
                    return;
                }
                let seq = self.next();
                self.values.insert(key.clone(), (seq, value.clone()));
                let frame = json!({ "type": "app_runtime", "epoch": self.epoch, "seq": seq,
                                    "values": { key: { "epoch": self.epoch, "seq": seq, "value": value } } });
                self.broadcast(&frame);
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
            }
            Msg::Snapshot(reply) => {
                let s = self.snapshot();
                let _ = reply.send(s);
            }
            Msg::Open(id, out) => {
                let s = self.snapshot();
                let _ = out.try_send(Arc::from(s.to_string()));
                self.sockets.insert(id, out);
            }
            Msg::Close(id) => {
                self.sockets.remove(&id);
            }
        }
    }
}

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
async fn read_org(engine: &Engine, org_id: i64) -> anyhow::Result<Option<(Value, Value, Value)>> {
    let client = engine.db.get().await?;
    let Some(org) = client
        .query_opt(
            "SELECT id, uuid::text, slug, name, created_at, net FROM ot.orgs WHERE id = $1 AND state = 'active'",
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
        "created": iso_opt(org.get(4)),
        "net_slug": net.get("identity").and_then(|i| i.get("slug")).cloned().unwrap_or(Value::Null),
        "nodes": counts.get::<_, i64>(0),
        "live": counts.get::<_, i64>(1),
        "cost_usd_total": counts.get::<_, f64>(2),
    });
    let notices = crate::domain::notices::for_org(&client, org_id, &slug).await?;
    let orgv = json!({ "id": org_id, "uuid": org.get::<_, String>(1), "slug": slug });
    Ok(Some((orgv, summary, Value::Array(notices))))
}

pub async fn app_ws(State(engine): State<Arc<Engine>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| run_socket(engine, socket))
}

async fn run_socket(engine: Arc<Engine>, socket: WebSocket) {
    let id = next_socket_id();
    let (out, mut rx) = mpsc::channel::<Arc<str>>(2048);
    let _ = engine.app.tx.send(Msg::Open(id, out));
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
    let _ = engine.app.tx.send(Msg::Close(id));
}
