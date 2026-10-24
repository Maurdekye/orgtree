use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use std::time::Duration;

const BOOTSTRAP: &str = "synthetic-bootstrap-key-0123456789abcdef";

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("orgtree-client-tokens-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("orgtree-client-tokens-"));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Server {
    address: std::net::SocketAddr,
    engine: Arc<crate::engine::Engine>,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn start(root: &Root) -> Self {
        let mut engine = crate::engine::Engine::for_tests(root.0.clone());
        let e = Arc::get_mut(&mut engine).unwrap();
        e.cfg.standalone = true;
        e.cfg.desktop_token = BOOTSTRAP.into();
        e.clients = Some(Arc::new(Registry::open(&root.0).unwrap()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::http::router(engine.clone());
        let stop = engine.shutdown.clone();
        let task = tokio::spawn(async move {
            axum::serve(transport::ClientListener(listener), app.into_make_service_with_connect_info::<transport::ClientInfo>())
                .with_graceful_shutdown(stop.cancelled_owned()).await.unwrap();
        });
        Self { address, engine, task }
    }
    async fn request(&self, method: &str, path: &str, token: &str, value: Option<Value>) -> (u16, Value) {
        let mut stream = TcpStream::connect(self.address).await.unwrap();
        send(&mut stream, method, path, token, value).await;
        let (status, body) = response(&mut stream).await;
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
    async fn alive(&self, token: &str) -> u16 { self.request("GET", "/api/desktop/alive", token, None).await.0 }
    async fn create(&self, name: &str) -> Value {
        let (status, value) = self.request("POST", "/api/standalone/clients", BOOTSTRAP, Some(json!({"name":name}))).await;
        assert_eq!(status, 200);
        value
    }
}
impl Drop for Server {
    fn drop(&mut self) { self.engine.shutdown.cancel(); self.task.abort(); }
}

async fn send(stream: &mut TcpStream, method: &str, path: &str, token: &str, value: Option<Value>) {
    let body = value.map(|v| v.to_string()).unwrap_or_default();
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

async fn response(stream: &mut TcpStream) -> (u16, Vec<u8>) {
    let mut headers = Vec::new();
    loop {
        headers.push(tokio::time::timeout(Duration::from_secs(3), stream.read_u8()).await.unwrap().unwrap());
        assert!(headers.len() < 32 * 1024);
        if headers.ends_with(b"\r\n\r\n") { break; }
    }
    let headers = String::from_utf8(headers).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    let length = headers.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:")
        .map(|n| n.trim().parse::<usize>().unwrap())).unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    (status, body)
}

async fn disconnected(stream: &mut TcpStream) -> bool {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut bytes = [0; 1024];
        loop {
            match stream.read(&mut bytes).await { Ok(0) | Err(_) => return true, Ok(_) => {} }
        }
    }).await.unwrap_or(false)
}

#[tokio::test]
async fn revoke_drops_idle_http_websocket_inflight_mcp_and_shared_socket_only() {
    let root = Root::new();
    let server = Server::start(&root).await;
    let a = server.create("client A").await;
    let b = server.create("client B").await;
    let a_token = a["token"].as_str().unwrap();
    let b_token = b["token"].as_str().unwrap();
    let mut idle = TcpStream::connect(server.address).await.unwrap();
    send(&mut idle, "GET", "/api/desktop/alive", a_token, None).await;
    assert_eq!(response(&mut idle).await.0, 200);
    let mut shared = TcpStream::connect(server.address).await.unwrap();
    for token in [a_token, b_token] {
        send(&mut shared, "GET", "/api/desktop/alive", token, None).await;
        assert_eq!(response(&mut shared).await.0, 200);
    }
    let mut unrelated = TcpStream::connect(server.address).await.unwrap();
    send(&mut unrelated, "GET", "/api/desktop/alive", b_token, None).await;
    assert_eq!(response(&mut unrelated).await.0, 200);
    let mut websocket = TcpStream::connect(server.address).await.unwrap();
    websocket.write_all(format!("GET /api/app/ws HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {a_token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: SGVsbG9Xb3JsZDEyMzQ1Ng==\r\n\r\n").as_bytes()).await.unwrap();
    assert_eq!(response(&mut websocket).await.0, 101);
    let mut inflight = TcpStream::connect(server.address).await.unwrap();
    inflight.write_all(format!("POST /api/mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {a_token}\r\nContent-Type: application/json\r\nContent-Length: 9999\r\n\r\n{{").as_bytes()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let admitted = server.engine.clients.as_ref().unwrap().clients.lock().unwrap().iter()
                .find(|c| c.record.id == a["id"]).unwrap().connections.iter().filter(|weak| weak.strong_count() != 0).count();
            if admitted == 4 { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let (status, _) = server.request("DELETE", &format!("/api/standalone/clients/{}", a["id"].as_str().unwrap()), BOOTSTRAP, None).await;
    assert_eq!(status, 200);
    let dropped = (disconnected(&mut idle).await, disconnected(&mut websocket).await,
        disconnected(&mut inflight).await, disconnected(&mut shared).await);
    assert!(dropped.0 && dropped.1 && dropped.2 && dropped.3,
        "revocation drop states (idle HTTP, WebSocket, inflight MCP, shared socket): {dropped:?}");
    send(&mut unrelated, "GET", "/api/desktop/alive", b_token, None).await;
    assert_eq!(response(&mut unrelated).await.0, 200);
    assert_eq!(server.alive(a_token).await, 403);
    assert_eq!(server.alive(b_token).await, 200);
    assert_eq!(server.alive(BOOTSTRAP).await, 200);
    let restarted = Server::start(&root).await;
    assert_eq!(restarted.alive(a_token).await, 403);
    assert_eq!(restarted.alive(b_token).await, 200);
    assert_eq!(restarted.alive(BOOTSTRAP).await, 200);
}

#[tokio::test]
async fn self_revoke_drops_calling_socket_and_mcp_can_manage_clients() {
    let root = Root::new();
    let server = Server::start(&root).await;
    let a = server.create("self").await;
    let token = a["token"].as_str().unwrap();
    let mut stream = TcpStream::connect(server.address).await.unwrap();
    send(&mut stream, "DELETE", &format!("/api/standalone/clients/{}", a["id"].as_str().unwrap()), token, None).await;
    assert!(disconnected(&mut stream).await);
    assert_eq!(server.alive(token).await, 403);
    let rpc = |id, args| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"orgtree_client_tokens","arguments":args}});
    let (status, created) = server.request("POST", "/api/mcp", BOOTSTRAP, Some(rpc(1, json!({"action":"create","name":"MCP"})))).await;
    assert_eq!(status, 200);
    let value: Value = serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let token = value["token"].as_str().unwrap();
    assert_eq!(server.alive(token).await, 200);
    let (_, listed) = server.request("POST", "/api/mcp", token, Some(rpc(2, json!({"action":"list"})))).await;
    let listing: Value = serde_json::from_str(listed["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listing["clients"].as_array().unwrap().len(), 1);
    assert_eq!(listing["clients"][0].as_object().unwrap().len(), 3);
    assert!(!listing.to_string().contains(token));
    assert!(!std::fs::read_to_string(root.0.join(FILE)).unwrap().contains(token));
    let (_, revoked) = server.request("POST", "/api/mcp", BOOTSTRAP, Some(rpc(3, json!({"action":"revoke","id":value["id"]})))).await;
    assert!(!revoked["result"]["isError"].as_bool().unwrap_or(false));
    assert_eq!(server.alive(token).await, 403);
    assert_eq!(server.request("DELETE", "/api/standalone/clients/bootstrap", BOOTSTRAP, None).await.0, 404);
}

#[test]
fn registry_is_hash_only_bounded_and_refuses_malformed_state() {
    let root = Root::new();
    let registry = Registry::open(&root.0).unwrap();
    assert!(registry.manage(&json!({"action":"create","name":" "})).is_err());
    assert!(registry.manage(&json!({"action":"create","name":"x".repeat(101)})).is_err());
    assert!(registry.manage(&json!({"action":"list","id":"unsupported"})).is_err());
    for index in 0..MAX_CLIENTS { registry.manage(&json!({"action":"create","name":format!("fixture {index}")})).unwrap(); }
    assert_eq!(registry.manage(&json!({"action":"create","name":"overflow"})).unwrap_err().status, axum::http::StatusCode::CONFLICT);
    let saved = std::fs::read(root.0.join(FILE)).unwrap();
    assert!(Registry::open(&root.0).is_ok());
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(root.0.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Invalid persisted input, not an injected runtime failure.
    let mut bad: Value = serde_json::from_slice(&saved).unwrap();
    bad["clients"][0]["hash"] = json!("invalid");
    std::fs::write(root.0.join(FILE), bad.to_string()).unwrap();
    assert!(Registry::open(&root.0).is_err());
}
