//! Test kit for the remote-engine tests: a scripted stand-in for a standalone
//! engine (`Far`), and this engine served on loopback with a desktop token
//! (`Near`). Synthetic data roots under the temp folder; nothing but loopback.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;

use super::Timing;
use crate::engine::Engine;

pub const DESKTOP_TOKEN: &str = "near-desktop-token-0123456789abcdef";
pub const BOOTSTRAP: &str = "far-bootstrap-key-0123456789abcdef";

/// Clocks short enough for a test, with the production shape.
pub fn fast() -> Timing {
    Timing {
        request: Duration::from_secs(3), connect: Duration::from_secs(3), net_first: Duration::from_millis(40), net_max: Duration::from_millis(160),
        stable: Duration::from_secs(60), auth_retry: Duration::from_millis(250), ping: Duration::from_millis(150), dead: Duration::from_millis(600),
        jitter: false, inflight_wait: Duration::from_millis(300), failure_window: Duration::from_secs(10), socket_queue: 8192,
    }
}

pub struct Root(pub PathBuf);
impl Root {
    pub fn new() -> Root {
        let root = std::env::temp_dir().join(format!("orgtree-remote-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Root(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("orgtree-remote-test-"));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Poll `check` until it holds or `ms` pass.
pub async fn until(ms: u64, mut check: impl FnMut() -> bool) -> bool {
    let end = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        if check() {
            return true;
        }
        if tokio::time::Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// ---------------------------------------------------------------- Far

/// One request the stand-in engine received.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub headers: HashMap<String, String>,
}

pub struct FarState {
    pub tokens: Mutex<Vec<String>>,
    pub viewer_tokens: Mutex<Vec<String>>,
    pub clients: Mutex<Vec<(String, String, String)>>,
    pub standalone: AtomicBool,
    pub data_root_id: Mutex<String>,
    pub boot: Mutex<String>,
    pub version: Mutex<String>,
    /// (id, slug, uuid, name)
    pub orgs: Mutex<Vec<(i64, String, String, String)>>,
    pub seen: Mutex<Vec<Seen>>,
    pub connections: AtomicUsize,
    pub upload_bytes: AtomicU64,
    app_sockets: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    /// frames the relay sent into org sockets, and a way to speak on them
    pub org_heard: Mutex<Vec<String>>,
    /// org sockets that ended
    pub org_closed: AtomicUsize,
    org_sockets: Mutex<Vec<mpsc::UnboundedSender<Option<String>>>>,
    stop: Mutex<CancellationToken>,
}

impl FarState {
    pub fn seen_paths(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|s| format!("{} {}", s.method, s.target)).collect()
    }
    pub fn last(&self, needle: &str) -> Option<Seen> {
        self.seen.lock().unwrap().iter().rev().find(|s| s.target.contains(needle)).cloned()
    }
    fn registry(&self) -> Value {
        json!({ "type": "registry_snapshot", "epoch": *self.boot.lock().unwrap(),
            "cursor": { "app_uuid": "far", "incarnation": *self.boot.lock().unwrap(), "rev": 1 },
            "records": self.orgs.lock().unwrap().iter().map(|(id, slug, uuid, _)| json!({ "entity": "registry_org", "id": id.to_string(),
                "body": { "org_id": id, "slug": slug, "org_uuid": uuid, "state": "active", "unavailable_step": null, "state_reason": null,
                          "attempts": 0, "report_path": null } })).collect::<Vec<_>>() })
    }
    fn snapshot(&self) -> Value {
        let boot = self.boot.lock().unwrap().clone();
        let summaries: serde_json::Map<String, Value> = self.orgs.lock().unwrap().iter().map(|(id, _, uuid, name)| (id.to_string(), json!({
            "type": "org_summary", "epoch": boot, "seq": 1, "org_id": id, "org_uuid": uuid, "incarnation": boot, "rev": 1,
            "body": { "name": name, "created": null, "net_slug": null, "nodes": 3, "live": 2, "cost_usd_total": 1.5, "attention": 1 } }))).collect();
        json!({ "type": "app_snapshot", "epoch": boot, "seq": 2, "registry": self.registry(), "summaries": summaries, "notices": {},
            "runtime": { "values": { "accounts": { "epoch": boot, "seq": 1, "value": [{ "id": "far-account" }] } }, "orgs": {} } })
    }
    /// Push a frame to every open app socket (the link's).
    pub fn push_app(&self, frame: Value) {
        self.app_sockets.lock().unwrap().retain(|tx| tx.send(frame.to_string()).is_ok());
    }
    /// The org list changed on the remote: tell the app sockets.
    pub fn push_registry(&self) {
        let frame = self.registry();
        self.push_app(frame);
    }
    /// Say this on every open org socket; `None` closes them.
    pub fn push_org(&self, text: Option<&str>) {
        self.org_sockets.lock().unwrap().retain(|tx| tx.send(text.map(str::to_string)).is_ok());
    }
    /// Revoke a client: its token stops working and every socket drops.
    pub fn revoke_all_clients(&self) {
        let gone: Vec<String> = self.clients.lock().unwrap().drain(..).map(|(_, _, token)| token).collect();
        self.tokens.lock().unwrap().retain(|t| !gone.contains(t));
        self.app_sockets.lock().unwrap().clear();
        self.push_org(None);
    }
}

pub struct Far {
    pub address: SocketAddr,
    pub state: Arc<FarState>,
    task: Option<tokio::task::JoinHandle<()>>,
}

struct Counting(TcpListener, Arc<FarState>);
impl axum::serve::Listener for Counting {
    type Io = TcpStream;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        loop {
            if let Ok(pair) = self.0.accept().await {
                self.1.connections.fetch_add(1, Ordering::SeqCst);
                return pair;
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.0.local_addr()
    }
}

impl Far {
    pub async fn start() -> Far {
        let state = Arc::new(FarState {
            tokens: Mutex::new(vec![BOOTSTRAP.into()]), viewer_tokens: Mutex::new(Vec::new()), clients: Mutex::new(Vec::new()),
            standalone: AtomicBool::new(true), data_root_id: Mutex::new("far-root".into()), boot: Mutex::new("far-boot-1".into()),
            version: Mutex::new(env!("CARGO_PKG_VERSION").into()),
            orgs: Mutex::new(vec![(1, "acme".into(), "u-acme".into(), "Acme".into()), (2, "beta".into(), "u-beta".into(), "Beta".into())]),
            seen: Mutex::new(Vec::new()), connections: AtomicUsize::new(0), upload_bytes: AtomicU64::new(0), app_sockets: Mutex::new(Vec::new()),
            org_heard: Mutex::new(Vec::new()), org_closed: AtomicUsize::new(0), org_sockets: Mutex::new(Vec::new()), stop: Mutex::new(CancellationToken::new()),
        });
        let (address, task) = Far::serve(state.clone(), "127.0.0.1:0".parse().unwrap()).await;
        Far { address, state, task: Some(task) }
    }

    async fn serve(state: Arc<FarState>, bind: SocketAddr) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(bind).await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        *state.stop.lock().unwrap() = stop.clone();
        let app = Router::new()
            .route("/api/desktop/alive", get(alive))
            .route("/api/host", get(host))
            .route("/api/standalone/clients", get(clients).post(mint))
            .route("/api/standalone/clients/{id}", axum::routing::delete(revoke))
            .route("/api/app/ws", get(app_ws))
            .route("/api/accounts", get(|| async { Json(json!([{ "id": "far-account" }])) }))
            .route("/api/orgs/{slug}", get(tree))
            .route("/api/orgs/{slug}/ws", get(org_ws))
            .route("/api/orgs/{slug}/redirect", get(|| async { (StatusCode::FOUND, [("location", "/api/orgs/acme/landed")]).into_response() }))
            .route("/api/orgs/{slug}/landed", get(|| async { Json(json!({ "landed": true })) }))
            .route("/api/orgs/{slug}/nodes/{nid}/message", post(message))
            .route("/api/orgs/{slug}/nodes/{nid}/upload", post(upload).layer(axum::extract::DefaultBodyLimit::disable()))
            .route("/api/orgs/{slug}/apps/media", get(|| async { ([("access-control-allow-origin", "null"), ("set-cookie", "s=1")], "media").into_response() }))
            .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({ "detail": "no route" }))).into_response() })
            .layer(axum::middleware::from_fn_with_state(state.clone(), far_guard))
            .with_state(state.clone());
        let counting = Counting(listener, state.clone());
        let task = tokio::spawn(async move {
            axum::serve(counting, app).with_graceful_shutdown(stop.cancelled_owned()).await.unwrap();
        });
        (address, task)
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// The engine goes away: no listener, every socket closed.
    pub async fn stop(&mut self) {
        self.state.stop.lock().unwrap().cancel();
        self.state.app_sockets.lock().unwrap().clear();
        self.state.push_org(None);
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
    }

    /// The same engine (or what answers at its address) comes back.
    pub async fn restart(&mut self) {
        let (_, task) = Far::serve(self.state.clone(), self.address).await;
        self.task = Some(task);
    }
}

impl Drop for Far {
    fn drop(&mut self) {
        self.state.stop.lock().unwrap().cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn far_guard(State(state): State<Arc<FarState>>, req: Request, next: axum::middleware::Next) -> Response {
    let headers: HashMap<String, String> = req.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let target = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_default();
    state.seen.lock().unwrap().push(Seen { method: req.method().to_string(), target, headers: headers.clone() });
    let token = headers.get("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("").to_string();
    let ticket = req.uri().path().ends_with("/apps/media");
    let mut response = if ticket {
        next.run(req).await
    } else if !state.standalone.load(Ordering::SeqCst) {
        (StatusCode::FORBIDDEN, Json(json!({ "detail": "desktop token required" }))).into_response()
    } else if state.viewer_tokens.lock().unwrap().contains(&token) {
        (StatusCode::FORBIDDEN, Json(json!({ "detail": "this client token is read-only" }))).into_response()
    } else if !state.tokens.lock().unwrap().contains(&token) {
        (StatusCode::FORBIDDEN, Json(json!({ "detail": "standalone token required" }))).into_response()
    } else {
        next.run(req).await
    };
    let boot = state.boot.lock().unwrap().clone();
    response.headers_mut().insert("x-orgtree-instance", boot.parse().unwrap());
    response
}

async fn alive(State(state): State<Arc<FarState>>) -> Json<Value> {
    Json(json!({ "pid": 1, "dataRootId": *state.data_root_id.lock().unwrap(), "alive": true }))
}

async fn host(State(state): State<Arc<FarState>>) -> Json<Value> {
    Json(json!({ "build": {}, "cli_version": "", "engine": format!("orgtree-engine {}", state.version.lock().unwrap()) }))
}

async fn clients(State(state): State<Arc<FarState>>) -> Json<Value> {
    Json(json!({ "clients": state.clients.lock().unwrap().iter().map(|(id, name, _)| json!({ "id": id, "name": name })).collect::<Vec<_>>() }))
}

async fn mint(State(state): State<Arc<FarState>>, Json(body): Json<Value>) -> Json<Value> {
    let (id, token) = (uuid::Uuid::new_v4().to_string(), format!("far-client-{}", crate::util::random_hex(16)));
    let name = body["name"].as_str().unwrap_or("").to_string();
    state.clients.lock().unwrap().push((id.clone(), name.clone(), token.clone()));
    state.tokens.lock().unwrap().push(token.clone());
    Json(json!({ "id": id, "name": name, "created_at": crate::util::now_iso(), "token": token }))
}

async fn revoke(State(state): State<Arc<FarState>>, Path(id): Path<String>) -> Response {
    let mut clients = state.clients.lock().unwrap();
    let Some(at) = clients.iter().position(|(cid, _, _)| *cid == id) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "detail": "active client token not found" }))).into_response();
    };
    let (_, _, token) = clients.remove(at);
    state.tokens.lock().unwrap().retain(|t| *t != token);
    Json(json!({ "revoked": id })).into_response()
}

async fn app_ws(State(state): State<Arc<FarState>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let _ = tx.send(state.snapshot().to_string());
        state.app_sockets.lock().unwrap().push(tx);
        let stop = state.stop.lock().unwrap().clone();
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Some(text) => if socket.send(Message::Text(text.into())).await.is_err() { break },
                    None => break,
                },
                incoming = socket.recv() => if !matches!(incoming, Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_) | Message::Binary(_)))) { break },
                _ = stop.cancelled() => break,
            }
        }
    })
}

async fn org_ws(State(state): State<Arc<FarState>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<String>>();
        state.org_sockets.lock().unwrap().push(tx);
        let stop = state.stop.lock().unwrap().clone();
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Some(Some(text)) => if socket.send(Message::Text(text.into())).await.is_err() { break },
                    _ => break,
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Text(text))) => state.org_heard.lock().unwrap().push(text.to_string()),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                },
                _ = stop.cancelled() => break,
            }
        }
        state.org_closed.fetch_add(1, Ordering::SeqCst);
    })
}

async fn tree(Path(slug): Path<String>, headers: HeaderMap) -> Response {
    if headers.get("if-none-match").and_then(|v| v.to_str().ok()) == Some("\"far-e1\"") {
        return (StatusCode::NOT_MODIFIED, [("etag", "\"far-e1\"")]).into_response();
    }
    ([("etag", "\"far-e1\""), ("x-orgtree-sync-rev", "7")], Json(json!({ "far_slug": slug }))).into_response()
}

async fn message(Path((slug, nid)): Path<(String, String)>, Json(body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true, "far_slug": slug, "node": nid, "echo": body }))
}

async fn upload(State(state): State<Arc<FarState>>, req: Request) -> Json<Value> {
    let mut body = req.into_body().into_data_stream();
    let mut total = 0u64;
    while let Some(Ok(chunk)) = body.next().await {
        total += chunk.len() as u64;
        state.upload_bytes.store(total, Ordering::SeqCst);
    }
    Json(json!({ "bytes": total }))
}

// ---------------------------------------------------------------- Near

/// This engine on loopback: a desktop token, a synthetic data root, the app
/// feed running (it reads no database: the local org list stays empty).
pub struct Near {
    pub address: SocketAddr,
    pub engine: Arc<Engine>,
    pub http: reqwest::Client,
    task: tokio::task::JoinHandle<()>,
}

impl Near {
    pub async fn start(root: &Root) -> Near {
        Near::start_with(root, |_| {}).await
    }

    pub async fn start_with(root: &Root, change: impl FnOnce(&mut Engine)) -> Near {
        let mut engine = Engine::for_tests(root.0.clone());
        let e = Arc::get_mut(&mut engine).unwrap();
        e.cfg.desktop_token = DESKTOP_TOKEN.into();
        e.cfg.data_root_id = "near-root".into();
        let (app, inbox) = crate::appfeed::AppFeed::new();
        e.app = app;
        change(e);
        engine.remotes.set_timing(fast());
        crate::appfeed::start(&engine, inbox);
        crate::remote::start(&engine);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::http::router(engine.clone());
        let stop = engine.shutdown.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(stop.cancelled_owned()).await.unwrap();
        });
        Near { address, engine, http: reqwest::Client::builder().no_proxy().build().unwrap(), task }
    }

    /// One request as the desktop makes it: its token, and for a window of a
    /// remote organization the remote engine's id.
    pub async fn call(&self, method: &str, path: &str, remote: Option<&str>, body: Option<Value>) -> (u16, HeaderMap, Value) {
        self.call_with(method, path, remote, body, &[]).await
    }

    pub async fn call_with(&self, method: &str, path: &str, remote: Option<&str>, body: Option<Value>, extra: &[(&str, &str)]) -> (u16, HeaderMap, Value) {
        let mut request = self.http.request(method.parse().unwrap(), format!("http://{}{path}", self.address)).header(crate::http::TOKEN_HEADER, DESKTOP_TOKEN);
        if let Some(remote) = remote {
            request = request.header(super::HEADER, remote);
        }
        for (k, v) in extra {
            request = request.header(*k, *v);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = tokio::time::timeout(Duration::from_secs(10), request.send()).await.expect("the engine answered in time").unwrap();
        let (status, headers) = (response.status().as_u16(), response.headers().clone());
        let bytes = response.bytes().await.unwrap_or_default();
        (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Add `far` with its bootstrap key; answers the connection's view.
    pub async fn add(&self, far: &Far) -> Value {
        let (status, _, view) = self.call("POST", "/api/remotes", None, Some(json!({ "url": far.url(), "token": BOOTSTRAP, "name": "Galaxy" }))).await;
        assert_eq!(status, 200, "{view}");
        view
    }

    pub async fn view(&self, id: &str) -> Value {
        let (_, _, list) = self.call("GET", "/api/remotes", None, None).await;
        list["remotes"].as_array().and_then(|all| all.iter().find(|r| r["id"] == id).cloned()).unwrap_or(Value::Null)
    }

    /// Wait until the connection's state is `state`.
    pub async fn state(&self, id: &str, state: &str, ms: u64) -> Value {
        let end = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let view = self.view(id).await;
            if view["state"] == state {
                return view;
            }
            assert!(tokio::time::Instant::now() < end, "the connection never became {state}: {view}");
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    /// A WebSocket to this engine as a window opens it.
    pub async fn socket(&self, path: &str, remote: Option<&str>) -> Result<WebSocketStream<TcpStream>, u16> {
        let tcp = TcpStream::connect(self.address).await.unwrap();
        let uri: http::Uri = format!("ws://{}{path}", self.address).parse().unwrap();
        let mut request = ClientRequestBuilder::new(uri).with_header(crate::http::TOKEN_HEADER, DESKTOP_TOKEN);
        if let Some(remote) = remote {
            request = request.with_header(super::HEADER, remote);
        }
        match tokio_tungstenite::client_async_with_config(request, tcp, None).await {
            Ok((socket, _)) => Ok(socket),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(response.status().as_u16()),
            Err(other) => panic!("socket: {other}"),
        }
    }
}

impl Drop for Near {
    fn drop(&mut self) {
        self.engine.shutdown.cancel();
        self.task.abort();
    }
}

/// The next text frame of a test socket, or the close code that ended it.
pub async fn next_text(socket: &mut WebSocketStream<TcpStream>) -> Result<String, Option<u16>> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), socket.next()).await.expect("a frame in time") {
            Some(Ok(Frame::Text(text))) => return Ok(text.to_string()),
            Some(Ok(Frame::Close(frame))) => return Err(frame.map(|f| u16::from(f.code))),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(None),
        }
    }
}

pub async fn say(socket: &mut WebSocketStream<TcpStream>, text: &str) {
    socket.send(Frame::Text(text.into())).await.unwrap();
}
