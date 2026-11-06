//! RED tests for the built-in live engine feed (spec `stream-plan-opus/spec.md` section 7, tests 1-19).
//!
//! Synthetic PG fixture like `runtime/watchdogs/onbehalf_tests.rs`: run one at a time
//! (`--test-threads=1`) against a throwaway database and role named `projdogs_fixture`
//! (`ORGTREE_PROJDOGS_TEST_URL`, `ORGTREE_PROJDOGS_TEST_ROOT`). No provider runs: agents are fake
//! handles in `engine.agents`, and a turn is a flip of the handle's `busy` view through
//! `events::runtime`, the real publication seam.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::Json;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::net::TcpStream;
use tokio_postgres::NoTls;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use super::TestOpts;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::runtime::watchdogs::events::{self, Scope};
use crate::runtime::AgentHandle;

type Ws = tokio_tungstenite::WebSocketStream<TcpStream>;

/// org1 "feedone": T (top, full) > A (visibility set per test) > A2, A > project PA; T > B > project PB; T > M1..M8 (flippers).
/// org2 "feedtwo": C.
struct W {
    e: Arc<Engine>,
    org1: Arc<OrgHandle>,
    org2: Arc<OrgHandle>,
    t: i64,
    a: i64,
    a2: i64,
    b: i64,
    c: i64,
    pa: i64,
    pb: i64,
    m: Vec<i64>,
    _rx: Vec<tokio::sync::mpsc::UnboundedReceiver<crate::runtime::Envelope>>,
}

#[nolog]
async fn world(opts: TestOpts) -> W {
    let url = std::env::var("ORGTREE_PROJDOGS_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("projdogs_fixture"));
    assert_eq!(cfg.get_user(), Some("projdogs_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let mut org = |slug: &'static str| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),$1,$1) RETURNING id", &[&slug]).await.unwrap().get::<_, i64>(0)
        }
    };
    let o1 = org("feedone").await;
    let o2 = org("feedtwo").await;
    let agent = |org: i64, name: String, parent: Option<i64>, kind: &'static str| {
        let client = &client;
        async move {
            client.query_one("INSERT INTO ot.agents(org_id,name,parent_id,kind,tier,state,scope,born) VALUES($1,$2,$3,$4,$5,'live',$6,'2026-11-06') RETURNING id",
                &[&org, &name, &parent, &kind, &if kind == "project" { "project" } else { "sol" }, &json!({"org_visibility":"full","transparent": kind == "project"})]).await.unwrap().get::<_, i64>(0)
        }
    };
    let t = agent(o1, "T".into(), None, "agent").await;
    let a = agent(o1, "A".into(), Some(t), "agent").await;
    let a2 = agent(o1, "A2".into(), Some(a), "agent").await;
    let b = agent(o1, "B".into(), Some(t), "agent").await;
    let pa = agent(o1, "PA".into(), Some(a), "project").await;
    let pb = agent(o1, "PB".into(), Some(b), "project").await;
    let mut m = Vec::new();
    for i in 1..=8 { m.push(agent(o1, format!("M{i}"), Some(t), "agent").await); }
    let c = agent(o2, "C".into(), None, "agent").await;
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_PROJDOGS_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(8).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org1 = crate::orgs::provisional(o1, "feedone".into(), "feedone".into(), "feedone".into());
    let org2 = crate::orgs::provisional(o2, "feedtwo".into(), "feedtwo".into(), "feedtwo".into());
    engine.orgs.insert(org1.clone());
    engine.orgs.insert(org2.clone());
    engine.live_feed.set_test_opts(opts);
    let mut rx = Vec::new();
    let mut all = vec![(o1, t), (o1, a), (o1, a2), (o1, b), (o2, c)];
    all.extend(m.iter().map(|id| (o1, *id)));
    for (org_id, id) in all {
        let (tx, r) = tokio::sync::mpsc::unbounded_channel();
        rx.push(r);
        engine.agents.map.pin().insert(id, Arc::new(AgentHandle { id, org_id, tx, view: arc_swap::ArcSwap::from_pointee(json!({})), helpers: arc_swap::ArcSwap::from_pointee(json!({"count":0,"items":[],"truncated":false})) }));
    }
    W { e: engine, org1, org2, t, a, a2, b, c, pa, pb, m, _rx: rx }
}

fn opts() -> TestOpts {
    TestOpts { port: Some(0), heartbeat: Duration::from_secs(3600), retry: Duration::from_millis(200), pause: Duration::ZERO }
}

impl W {
    fn org_of(&self, id: i64) -> i64 { if id == self.c { self.org2.id } else { self.org1.id } }
    /// The real publication seam: the handle's view changes, then `events::runtime` sees old and next.
    fn set_busy(&self, id: i64, busy: bool) {
        let h = self.e.agents.get(id).unwrap();
        let old = h.view.load_full();
        let next = Arc::new(json!({"busy": busy}));
        h.view.store(next.clone());
        events::runtime(&self.e, self.org_of(id), id, &old, &next);
    }
    /// A busy flip with no event (the map moves, nothing is published).
    fn set_busy_silently(&self, id: i64, busy: bool) {
        self.e.agents.get(id).unwrap().view.store(Arc::new(json!({"busy": busy})));
    }
    async fn sql(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.e.db.get().await.unwrap().execute(text, params).await.unwrap();
    }
    async fn visibility(&self, id: i64, level: &str) {
        self.sql("UPDATE ot.agents SET scope=jsonb_set(scope,'{org_visibility}',to_jsonb($2::text)) WHERE id=$1", &[&id, &level]).await;
    }
    async fn apply(&self) -> SocketAddr {
        self.e.live_feed.apply(&self.e).await;
        self.e.live_feed.local_addr().expect("the feed is listening")
    }
    async fn token(&self, org: &str, agent: &str) -> (String, String) {
        self.e.live_feed.create_token(&self.e, "test", org, agent).await.unwrap()
    }
    async fn bodies(&self, agent: i64) -> Vec<String> {
        self.e.db.get().await.unwrap().query("SELECT body FROM ot.mail WHERE recipient_agent_id=$1 ORDER BY id", &[&agent]).await.unwrap().iter().map(|r| r.get(0)).collect()
    }
    async fn event_dog(&self, owner: i64, target: &str, name: &str) {
        crate::runtime::watchdogs::create(&self.e, self.org_of(owner), owner, &json!({"kind":"event","target":target,"name":name,"interval_s":5})).await.unwrap();
    }
}

/// A test client.
struct Cl { ws: Ws }

#[nolog]
async fn dial(addr: SocketAddr, path: &str, headers: &[(&str, &str)]) -> Result<Cl, u16> {
    let tcp = TcpStream::connect(addr).await.expect("tcp connect");
    let mut req = format!("ws://{addr}{path}").into_client_request().unwrap();
    for (k, v) in headers {
        req.headers_mut().insert(http::header::HeaderName::from_bytes(k.as_bytes()).unwrap(), http::HeaderValue::from_str(v).unwrap());
    }
    match tokio_tungstenite::client_async(req, tcp).await {
        Ok((ws, _)) => Ok(Cl { ws }),
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("handshake failed: {e}"),
    }
}

impl Cl {
    async fn next(&mut self, ms: u64) -> Option<Value> {
        loop {
            match tokio::time::timeout(Duration::from_millis(ms), self.ws.next()).await {
                Ok(Some(Ok(Message::Text(t)))) => return Some(serde_json::from_str(t.as_str()).unwrap()),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
                _ => return None,
            }
        }
    }
    async fn send(&mut self, v: Value) { self.ws.send(Message::Text(v.to_string().into())).await.unwrap(); }
    /// Everything that arrives until the line has been quiet for `quiet_ms`.
    async fn drain(&mut self, quiet_ms: u64) -> Vec<Value> {
        let mut out = Vec::new();
        while let Some(v) = self.next(quiet_ms).await { out.push(v); }
        out
    }
    /// The close code the server ends with, within `ms`.
    async fn close_code(&mut self, ms: u64) -> Option<u16> {
        let end = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let left = end.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, self.ws.next()).await {
                Ok(Some(Ok(Message::Close(Some(f))))) => return Some(u16::from(f.code)),
                Ok(Some(Ok(Message::Close(None)))) => return Some(1005),
                Ok(Some(Ok(_))) => continue,
                _ => return None,
            }
        }
    }
}

fn counts(msgs: &[Value], name: &str) -> Vec<i64> {
    msgs.iter().filter(|m| m["name"] == name).map(|m| m["payload"]["count"].as_i64().unwrap()).collect()
}
fn strictly_increasing(msgs: &[Value]) -> bool {
    msgs.windows(2).all(|w| w[1]["seq"].as_u64() > w[0]["seq"].as_u64()) && msgs.first().map(|m| m["seq"] == 1).unwrap_or(true)
}

const IGNORE: &str = "requires isolated projdogs_fixture database";

/// 1: the public count follows turns across orgs, in order, with strictly increasing seq.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn public_count_follows_turns() {
    let _ = IGNORE;
    let w = world(opts()).await;
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    let hello = cl.next(2000).await.unwrap();
    assert_eq!((hello["type"].clone(), hello["subject"].clone()), (json!("hello"), json!("public")), "{hello}");
    let first = cl.next(2000).await.unwrap();
    assert_eq!((first["type"].clone(), first["payload"]["count"].clone()), (json!("state"), json!(0)), "{first}");
    for (id, busy) in [(w.a, true), (w.b, true), (w.c, true), (w.b, false)] { w.set_busy(id, busy); }
    let msgs = cl.drain(500).await;
    assert_eq!(counts(&msgs, "agents.active"), vec![1, 2, 3, 2], "{msgs:?}");
    assert!(strictly_increasing(&msgs), "{msgs:?}");
    assert!(msgs.iter().all(|m| m["v"] == 1 && m["ts"].is_string() && m["boot"] == "test"), "{msgs:?}");
}

/// 2: the current state follows hello on connect.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn current_state_on_connect() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    w.set_busy(w.a, true);
    w.set_busy(w.c, true);
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    let hello = cl.next(1000).await.unwrap();
    assert_eq!(hello["type"], "hello", "{hello}");
    let st = cl.next(1000).await.unwrap();
    assert_eq!((st["type"].clone(), st["name"].clone(), st["payload"]["count"].clone(), st["reason"].clone()), (json!("state"), json!("agents.active"), json!(2), json!("connect")), "{st}");
}

/// 3: a reconnect gets the new value first.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn reconnect_gets_current_state() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    w.set_busy(w.a, true);
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.next(1000).await.unwrap();
    assert_eq!(cl.next(1000).await.unwrap()["payload"]["count"], 1);
    drop(cl);
    w.set_busy(w.b, true);
    w.set_busy(w.c, true);
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.next(1000).await.unwrap();
    let st = cl.next(1000).await.unwrap();
    assert_eq!((st["reason"].clone(), st["payload"]["count"].clone()), (json!("connect"), json!(3)), "{st}");
}

/// 4: concurrent emits never leave a stale last count.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn no_stale_count_under_concurrent_emits() {
    let w = Arc::new(world(opts()).await);
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    let mut tasks = Vec::new();
    for id in w.m.clone() {
        let w = w.clone();
        tasks.push(tokio::spawn(async move { for i in 0..200 { w.set_busy(id, i % 2 == 0); tokio::task::yield_now().await; } }));
    }
    for t in tasks { t.await.unwrap(); }
    w.set_busy(w.a, true);
    let truth = w.m.iter().chain([w.a].iter()).filter(|id| w.e.agents.get(**id).unwrap().view.load()["busy"] == true).count() as i64;
    let msgs = cl.drain(800).await;
    assert!(strictly_increasing(&msgs), "seq must strictly increase");
    let last = msgs.iter().rev().find(|m| m["name"] == "agents.active").expect("a count arrived");
    assert_eq!(last["payload"]["count"], truth, "the last count is the truth: {last}");
}

/// 5: the public tier counts every agent, dog owners included.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn public_counts_every_agent_including_dog_owners() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    w.event_dog(w.a, "agents.active", "cnt").await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.next(1000).await.unwrap();
    cl.next(1000).await.unwrap();
    w.set_busy(w.a, true);
    let msgs = cl.drain(500).await;
    assert_eq!(counts(&msgs, "agents.active"), vec![1], "the dog owner A is counted: {msgs:?}");
}

/// 6: the public tier refuses everything but the two counts.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn public_refuses_non_count_kinds() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.drain(300).await;
    cl.send(json!({"op":"subscribe","kinds":["turn.*","agents.active"]})).await;
    let msgs = cl.drain(400).await;
    assert!(msgs.iter().any(|m| m["type"] == "error" && m["code"] == "needs_token"), "{msgs:?}");
    w.set_busy(w.a, true);
    let after = cl.drain(500).await;
    assert!(after.iter().all(|m| m["name"] != "turn.started"), "no turn event reaches the public tier: {after:?}");
    for m in after.iter().filter(|m| m["name"] == "agents.active") {
        let keys: Vec<&str> = m["payload"].as_object().unwrap().keys().map(String::as_str).collect();
        assert!(keys.iter().all(|k| ["count", "previous", "scope"].contains(k)), "name-free payload: {m}");
    }
    assert_eq!(counts(&after, "agents.active"), vec![1]);
}

/// 7: `?org=` limits the count; an unknown slug is 404.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn org_filter() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events?org=feedone", &[]).await.unwrap();
    assert_eq!(cl.next(1000).await.unwrap()["event_scope"], "org");
    cl.next(1000).await.unwrap();
    w.set_busy(w.c, true);
    w.set_busy(w.a, true);
    let msgs = cl.drain(500).await;
    assert_eq!(counts(&msgs, "agents.active"), vec![1], "only org1 counts: {msgs:?}");
    assert_eq!(dial(addr, "/v1/events?org=nosuch", &[]).await.err(), Some(404));
}

/// 8: parity. For one event of every catalogue family, an event dog owned by A and a feed connection bound to A
/// see the same name and payload.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn parity_across_kinds() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    w.sql("INSERT INTO ot.work_items(org_id,slug,title,status,owner,created_by) VALUES($1,'feed-item','t','open',jsonb_build_object('node','A2'),jsonb_build_object('node','A2'))", &[&w.org1.id]).await;
    let (_, token) = w.token("feedone", "A").await;
    let mut cl = dial(addr, "/v1/events", &[("authorization", &format!("Bearer {token}"))]).await.unwrap();
    let hello = cl.next(1000).await.unwrap();
    assert_eq!(hello["subject"], "agent", "{hello}");
    cl.send(json!({"op":"subscribe","kinds":["*"]})).await;
    let kinds = ["agent.hired", "agent.changed", "turn.started", "cli.ready", "mail.waiting", "docket.status.changed", "account.signed_in", "credits.changed",
        "documents.created", "audience.granted", "project.event", "engine.started", "agents.active"];
    for k in kinds { w.event_dog(w.a, k, &format!("p-{k}").replace('.', "-")).await; }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    cl.drain(300).await;
    let (o, a2, pa) = (w.org1.id, w.a2, w.pa);
    for e in events::operation(o, "hire", Some(a2), &json!({})) { events::emit(&w.e, e); }
    events::change(&w.e, o, &crate::changes::Change::Agent(a2));
    w.set_busy(a2, true);
    events::runtime(&w.e, o, a2, &json!({}), &json!({"proc_warm": true}));
    events::emit(&w.e, events::event("mail.waiting", Scope::Agent(o, a2), json!({"agent_id": a2})));
    events::emit(&w.e, events::event("docket.status.changed", Scope::Docket(o, "feed-item".into()), json!({"slug":"feed-item","status":"review"})));
    events::emit(&w.e, events::event("account.signed_in", Scope::Account(None), json!({"account":"acct-x","state":"authenticated"})));
    events::emit(&w.e, events::event("credits.changed", Scope::Agent(o, a2), json!({"agent_id": a2})));
    events::emit(&w.e, events::event("documents.created", Scope::Agent(o, a2), json!({"agent_id": a2, "id": "d1"})));
    events::emit(&w.e, events::event("audience.granted", Scope::Agent(o, a2), json!({"agent_id": a2})));
    events::emit(&w.e, events::event("project.event", Scope::Agent(o, pa), json!({"project": "PA"})));
    events::machine(&w.e, "engine.started", json!({"commit": "x", "pid": 1}));
    let msgs = cl.drain(1500).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mail = w.bodies(w.a).await.join("\n");
    for k in kinds {
        let m = msgs.iter().find(|m| m["type"] == "event" && m["name"] == k).unwrap_or_else(|| panic!("the feed lacks {k}: {msgs:?}"));
        let line = format!("{} {}", m["name"].as_str().unwrap(), m["payload"]);
        assert!(mail.contains(&line), "the dog's fire lacks the feed's line for {k}: {line}\n{mail}");
    }
}

/// 9: the visibility cap. A bound connection gets nothing its owner's own event dog would not.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn visibility_cap() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    w.visibility(w.a, "self").await;
    w.sql("INSERT INTO ot.work_items(org_id,slug,title,status,owner,created_by) VALUES($1,'hidden-item','t','open',jsonb_build_object('node','B'),jsonb_build_object('node','B'))", &[&w.org1.id]).await;
    let (_, token) = w.token("feedone", "A").await;
    let mut cl = dial(addr, "/v1/events", &[("authorization", &format!("Bearer {token}"))]).await.unwrap();
    cl.next(1000).await.unwrap();
    cl.send(json!({"op":"subscribe","kinds":["*"],"event_scope":"org"})).await;
    let first = cl.drain(500).await;
    assert!(first.iter().any(|m| m["type"] == "error" && m["code"] == "needs_full_visibility"), "{first:?}");
    cl.send(json!({"op":"subscribe","kinds":["*"]})).await;
    cl.drain(300).await;
    let o = w.org1.id;
    events::emit(&w.e, events::event("turn.started", Scope::Agent(o, w.b), json!({"agent_id": w.b})));
    events::emit(&w.e, events::event("turn.started", Scope::Agent(w.org2.id, w.c), json!({"agent_id": w.c})));
    events::emit(&w.e, events::event("docket.status.changed", Scope::Docket(o, "hidden-item".into()), json!({"slug":"hidden-item"})));
    events::emit(&w.e, events::event("project.event", Scope::Agent(o, w.pb), json!({"project":"PB"})));
    events::emit(&w.e, events::event("org.settings.changed", Scope::Org(o), json!({})));
    w.set_busy(w.b, true);
    events::emit(&w.e, events::event("turn.started", Scope::Agent(o, w.a2), json!({"agent_id": w.a2})));
    let msgs = cl.drain(800).await;
    let names: Vec<(&str, String)> = msgs.iter().filter(|m| m["type"] == "event").map(|m| (m["name"].as_str().unwrap(), m["payload"].to_string())).collect();
    assert_eq!(names.iter().filter(|(n, _)| *n == "turn.started").count(), 1, "only A2's turn (a report of A) reaches A: {names:?}");
    assert!(names.iter().all(|(n, _)| !matches!(*n, "docket.status.changed" | "project.event" | "org.settings.changed")), "{names:?}");
    assert!(counts(&msgs, "agents.active").is_empty(), "B's turn is invisible to A and does not move A's count: {msgs:?}");
}

/// 10: the alert-turn and own-cli suppression match the event dog's.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn alert_turn_and_own_cli_suppressed() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    let (_, ta) = w.token("feedone", "A").await;
    let (_, tb) = w.token("feedone", "B").await;
    let mut ca = dial(addr, "/v1/events", &[("authorization", &format!("Bearer {ta}"))]).await.unwrap();
    let mut cb = dial(addr, "/v1/events", &[("authorization", &format!("Bearer {tb}"))]).await.unwrap();
    for c in [&mut ca, &mut cb] { c.next(1000).await.unwrap(); c.send(json!({"op":"subscribe","kinds":["turn.*","cli.*"]})).await; c.drain(300).await; }
    let o = w.org1.id;
    let guard = events::alert_turn(&w.e, o, w.a, "wd", &[json!({"kind":"watchdog"})]).expect("an alert turn");
    events::emit(&w.e, events::event("turn.started", Scope::Agent(o, w.a), json!({"agent_id": w.a})));
    drop(guard);
    events::emit(&w.e, events::event("cli.ready", Scope::Agent(o, w.a), json!({"agent_id": w.a})));
    let (ma, mb) = (ca.drain(600).await, cb.drain(600).await);
    assert!(ma.iter().all(|m| m["type"] != "event"), "A sees neither its alert turn nor its own cli: {ma:?}");
    assert_eq!(mb.iter().filter(|m| m["type"] == "event").count(), 2, "B sees both: {mb:?}");
}

/// 11: loopback only, Host/Origin checks, connection cap.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn loopback_host_origin() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    assert_eq!(addr.ip(), IpAddr::from([127, 0, 0, 1]));
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| s.connect("192.0.2.1:9").map(|_| s)) {
        if let Ok(local) = s.local_addr() {
            if !local.ip().is_loopback() && local.ip().is_ipv4() {
                assert!(TcpStream::connect(SocketAddr::new(local.ip(), addr.port())).await.is_err(), "a non-loopback address must be refused");
            }
        }
    }
    assert_eq!(dial(addr, "/v1/events", &[("host", "evil.example:80")]).await.err(), Some(403));
    assert_eq!(dial(addr, "/v1/events", &[("origin", "https://example.com")]).await.err(), Some(403));
    assert!(dial(addr, "/v1/events", &[]).await.is_ok());
    assert!(dial(addr, "/v1/events", &[("origin", "null")]).await.is_ok());
    assert!(dial(addr, "/v1/events", &[("origin", "http://localhost:5173")]).await.is_ok());
    assert_eq!(dial(addr, "/other", &[]).await.err(), Some(404));
    let mut held = Vec::new();
    for _ in 0..32 { held.push(dial(addr, "/v1/events", &[]).await.expect("within the cap")); }
    assert_eq!(dial(addr, "/v1/events", &[]).await.err(), Some(503), "the 33rd connection");
}

/// 12: the setting turns the feed off and on, and a port change rebinds.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn setting_off_on() {
    let w = world(opts()).await;
    assert!(w.e.settings.live_feed_enabled(), "default ON");
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.next(1000).await.unwrap();
    let put = |k: &str, v: Value| {
        let mut m = Map::new();
        m.insert(k.into(), v);
        crate::http::settings::put_runtime(State(w.e.clone()), Json(m))
    };
    put("live_feed_enabled", json!(false)).await.unwrap();
    assert_eq!(cl.close_code(2000).await, Some(1001));
    assert!(w.e.live_feed.local_addr().is_none());
    assert_eq!(w.e.live_feed.status()["state"], "off");
    assert!(TcpStream::connect(addr).await.is_err(), "the port is closed");
    put("live_feed_enabled", json!(true)).await.unwrap();
    assert_eq!(w.e.live_feed.status()["state"], "listening");
    let addr = w.e.live_feed.local_addr().unwrap();
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.next(1000).await.unwrap();
    put("live_feed_port", json!(50123)).await.unwrap();
    assert_eq!(cl.close_code(2000).await, Some(1012));
    let again = w.e.live_feed.local_addr().expect("rebound");
    assert!(dial(again, "/v1/events", &[]).await.is_ok());
    assert!(put("live_feed_port", json!(80)).await.is_err());
    assert!(put("live_feed_enabled", json!("yes")).await.is_err());
}

/// 13: a port in use is an error status; the engine retries.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn port_in_use() {
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let mut o = opts();
    o.port = Some(port);
    let w = world(o).await;
    w.e.live_feed.apply(&w.e).await;
    let s = w.e.live_feed.status();
    assert_eq!(s["state"], "error", "{s}");
    assert_eq!(s["error"], format!("port {port} is in use"), "{s}");
    drop(taken);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(w.e.live_feed.status()["state"], "listening");
    assert_eq!(w.e.live_feed.local_addr().unwrap().port(), port);
}

/// 14: heartbeats carry the recomputed state, or a bare heartbeat with no stateful kind.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn heartbeat() {
    let mut o = opts();
    o.heartbeat = Duration::from_millis(100);
    let w = world(o).await;
    let addr = w.apply().await;
    w.set_busy(w.a, true);
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    let msgs = {
        tokio::time::sleep(Duration::from_millis(450)).await;
        cl.drain(150).await
    };
    let hb: Vec<&Value> = msgs.iter().filter(|m| m["type"] == "state" && m["reason"] == "heartbeat").collect();
    assert!(hb.len() >= 2 && hb.iter().all(|m| m["payload"]["count"] == 1), "{msgs:?}");
    assert!(strictly_increasing(&msgs));
    cl.send(json!({"op":"subscribe","kinds":[]})).await;
    cl.drain(50).await;
    let bare = cl.drain(300).await;
    assert!(bare.iter().any(|m| m["type"] == "heartbeat"), "{bare:?}");
}

/// 15: token lifecycle.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn token_lifecycle() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    let (id, token) = w.token("feedone", "A").await;
    assert!(token.starts_with("otf_") && token.len() == 47, "{token}");
    let file = std::fs::read_to_string(w.e.cfg.data_root.join("live-feed-tokens.json")).unwrap();
    assert!(!file.contains(&token) && file.contains(&id), "only the hash is stored");
    let mut h = dial(addr, "/v1/events", &[("authorization", &format!("Bearer {token}"))]).await.unwrap();
    let mut q = dial(addr, &format!("/v1/events?token={token}"), &[]).await.unwrap();
    for c in [&mut h, &mut q] { assert_eq!(c.next(1000).await.unwrap()["subject"], "agent"); }
    assert!(w.e.live_feed.revoke_token(&id));
    for c in [&mut h, &mut q] { assert_eq!(c.close_code(1500).await, Some(4401)); }
    assert_eq!(dial(addr, "/v1/events", &[("authorization", &format!("Bearer {token}"))]).await.err(), Some(401));
    let (_, tb) = w.token("feedone", "B").await;
    w.sql("UPDATE ot.agents SET state='archived' WHERE id=$1", &[&w.b]).await;
    assert_eq!(dial(addr, "/v1/events", &[("authorization", &format!("Bearer {tb}"))]).await.err(), Some(401), "a retired agent's token");
}

/// 16: a websocket dog on the feed URL is bound to its owner without credentials.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn websocket_dog_auto_identity() {
    let capture = crate::trace::LogCapture::start().await;
    let w = world(opts()).await;
    let addr = w.apply().await;
    let url = format!("ws://127.0.0.1:{}/v1/events", addr.port());
    let make = |owner: i64, name: &str, url: &str, project: Option<&str>| {
        let mut args = json!({"kind":"websocket","target":url,"name":name,"hello":[{"op":"subscribe","kinds":["turn.*"]}],"interval_s":5});
        if let Some(p) = project { args["project"] = json!(p); }
        crate::runtime::watchdogs::create(&w.e, w.org_of(owner), owner, &args)
    };
    make(w.a, "bound", &url, None).await.unwrap();
    // a project's dog: created by A (above PA), owned by the project, so the public tier
    make(w.a, "public", &url, Some("PA")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let o = w.org1.id;
    events::emit(&w.e, events::event("turn.started", Scope::Agent(o, w.a2), json!({"agent_id": w.a2})));
    tokio::time::sleep(Duration::from_secs(7)).await;
    let mail = w.bodies(w.a).await.join("\n");
    assert!(mail.contains("turn.started"), "A's dog receives A-scoped turn events with no credentials: {mail}");
    let gen: i64 = w.e.db.get().await.unwrap().query_one("SELECT generation FROM ot.agents WHERE id=$1", &[&w.a]).await.unwrap().get(0);
    let header = w.e.live_feed.agent_header(o, w.a, gen);
    assert!(!header.is_empty());
    let c = w.e.db.get().await.unwrap();
    for (what, sql) in [("watchdog rows", "SELECT coalesce(string_agg(to_jsonb(w)::text,' '),'') FROM ot.watchdogs w"), ("mail", "SELECT coalesce(string_agg(body,' '),'') FROM ot.mail")] {
        let all: String = c.query_one(sql, &[]).await.unwrap().get(0);
        assert!(!all.contains(&header), "the header value leaked into {what}");
    }
    assert!(!capture.finish().await.contains(&header), "the header value leaked into the log");
    let proj: String = c.query_one("SELECT coalesce(string_agg(body,' '),'') FROM ot.mail WHERE body LIKE '%needs_token%'", &[]).await.unwrap().get(0);
    assert!(proj.contains("needs_token"), "a project-owned dog is the public tier");
    // forged, and an old generation
    assert_eq!(dial(addr, "/v1/events", &[("x-orgtree-feed-agent", &format!("{}.{}", w.a, "0".repeat(64)))]).await.err(), Some(401));
    assert_eq!(dial(addr, "/v1/events", &[("x-orgtree-feed-agent", &w.e.live_feed.agent_header(o, w.a, gen - 1))]).await.err(), Some(401));
    assert!(dial(addr, "/v1/events", &[("x-orgtree-feed-agent", &header)]).await.is_ok());
    // a dog on another port sends no header
    let server = crate::ws::testserver::TestServer::start(Default::default()).await;
    make(w.a, "elsewhere", &server.url("/"), None).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(server.seen().iter().all(|s| s.headers.iter().all(|(k, _)| !k.eq_ignore_ascii_case("x-orgtree-feed-agent"))));
}

/// 17: a full queue is announced with gap + resync.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn overflow_gap_resync() {
    let mut o = opts();
    o.pause = Duration::from_millis(1500);
    let w = world(o).await;
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    for i in 0..400 { w.set_busy(w.m[i % 8], i % 16 < 8); }
    w.set_busy(w.a, true);
    let msgs = cl.drain(2500).await;
    let gap = msgs.iter().position(|m| m["type"] == "gap").unwrap_or_else(|| panic!("no gap: {} messages", msgs.len()));
    let resync = &msgs[gap + 1];
    assert_eq!((resync["type"].clone(), resync["reason"].clone()), (json!("state"), json!("resync")), "{resync}");
    let truth = w.m.iter().chain([w.a].iter()).filter(|id| w.e.agents.get(**id).unwrap().view.load()["busy"] == true).count();
    assert_eq!(resync["payload"]["count"], truth);
}

/// 18: subscribe validation.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn subscribe_validation() {
    let w = world(opts()).await;
    let addr = w.apply().await;
    let mut cl = dial(addr, "/v1/events", &[]).await.unwrap();
    cl.drain(300).await;
    cl.send(json!({"op":"subscribe","kinds":["Bad Name","agents.active","turn..x"]})).await;
    let m = cl.drain(400).await;
    assert_eq!(m.iter().filter(|x| x["type"] == "error" && x["code"] == "bad_kind").count(), 2, "{m:?}");
    assert!(m.iter().any(|x| x["type"] == "hello" && x["kinds"] == json!(["agents.active"])), "the valid rest applies: {m:?}");
    let many: Vec<String> = (0..65).map(|i| format!("a.b{}", "x".repeat(i % 3 + 1))).collect();
    cl.send(json!({"op":"subscribe","kinds":many})).await;
    assert!(cl.drain(400).await.iter().any(|x| x["code"] == "bad_kind"));
    cl.send(json!({"op":"dance"})).await;
    assert!(cl.drain(300).await.iter().any(|x| x["code"] == "bad_message"));
    cl.ws.send(Message::Text("not json".into())).await.unwrap();
    assert!(cl.drain(300).await.iter().any(|x| x["code"] == "bad_message"));
    cl.send(json!({"op":"subscribe","kinds":["agents.live"]})).await;
    assert!(cl.drain(300).await.iter().any(|x| x["type"] == "hello"), "the connection stayed open");
}

/// 19: an event dog's count is recomputed when it is authorized, not taken from the publication-time snapshot.
#[tokio::test]
#[ignore = "requires isolated projdogs_fixture database"]
#[nolog]
async fn event_dog_count_recomputed_at_authorization() {
    let w = world(opts()).await;
    w.event_dog(w.t, "agents.active", "act").await;
    w.event_dog(w.t, "agents.live", "liv").await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let o = w.org1.id;
    // the snapshot at publication says {A}; by authorization B is busy too
    w.set_busy(w.a, true);
    w.set_busy_silently(w.b, true);
    events::emit(&w.e, events::live_count(o, vec![w.a]));
    tokio::time::sleep(Duration::from_secs(7)).await;
    let mail = w.bodies(w.t).await.join("\n");
    assert!(mail.contains(r#"agents.active {"count":2,"previous":0,"scope":"subtree"}"#), "the map says A and B: {mail}");
    let live: i64 = w.e.db.get().await.unwrap().query_one("SELECT count(*) FROM ot.agents WHERE org_id=$1 AND state='live' AND kind='agent' AND id<>$2", &[&o, &w.t]).await.unwrap().get(0);
    assert!(mail.contains(&format!(r#"agents.live {{"count":{live},"previous":"#)), "the live count comes from the database at authorization, not the forged members: {mail}");
}
