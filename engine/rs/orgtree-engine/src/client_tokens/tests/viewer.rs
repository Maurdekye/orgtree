//! Viewer tokens (docs/standalone-engine.md): scope on the record, the read-only route list,
//! the listen-only org socket.
use super::*;

const READ_ONLY: &str = "this client token is read-only";

fn add_org(server: &Server, slug: &str) {
    server.engine.orgs.insert(crate::orgs::provisional(7, uuid::Uuid::new_v4().to_string(), slug.into(), slug.into()));
}

async fn create_viewer(server: &Server, name: &str, org: &str) -> Value {
    let (status, value) = server.request("POST", "/api/standalone/clients", BOOTSTRAP,
        Some(json!({"name":name,"scope":"viewer","org":org}))).await;
    assert_eq!(status, 200, "{value}");
    value
}

/// A request that presents two tokens at once: the header one and the Bearer one.
async fn request_two(server: &Server, path: &str, header_token: &str, bearer: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect(server.address).await.unwrap();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nX-Orgtree-Desktop-Token: {header_token}\r\nAuthorization: Bearer {bearer}\r\nContent-Length: 0\r\n\r\n").as_bytes()).await.unwrap();
    let (status, body) = response(&mut stream).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[test]
fn v1_file_loads_as_full_and_v2_round_trips_scope_and_org() {
    let root = Root::new();
    let created = chrono::Utc::now().to_rfc3339();
    let v1 = json!({"version":1,"clients":[{"id":uuid::Uuid::new_v4().to_string(),"name":"old","created_at":created,"hash":hash("old-token")}]});
    std::fs::write(root.0.join(FILE), v1.to_string()).unwrap();
    let registry = Registry::open(&root.0).unwrap();
    let listed = registry.manage(&json!({"action":"list"})).unwrap();
    assert_eq!(listed["clients"][0]["scope"], "full");
    assert!(listed["clients"][0].get("org").is_none());
    let viewer = registry.manage(&json!({"action":"create","name":"v","scope":"viewer","org":"galaxy"})).unwrap();
    assert_eq!(viewer["scope"], "viewer");
    assert_eq!(viewer["org"], "galaxy");
    let saved: Value = serde_json::from_slice(&std::fs::read(root.0.join(FILE)).unwrap()).unwrap();
    assert_eq!(saved["version"], 2, "the next change writes version 2");
    assert_eq!(saved["clients"][0]["scope"], "full");
    assert_eq!(saved["clients"][1]["scope"], "viewer");
    assert_eq!(saved["clients"][1]["org"], "galaxy");
    let reopened = Registry::open(&root.0).unwrap().manage(&json!({"action":"list"})).unwrap();
    assert_eq!(reopened["clients"][1]["scope"], "viewer");
    assert_eq!(reopened["clients"][1]["org"], "galaxy");
    assert!(!reopened.to_string().contains(viewer["token"].as_str().unwrap()));
}

#[test]
fn invalid_scope_combinations_fail_to_load() {
    let root = Root::new();
    let created = chrono::Utc::now().to_rfc3339();
    let file = |extra: Value| {
        let mut row = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"x","created_at":created,"hash":hash("t")});
        for (k, v) in extra.as_object().unwrap() { row[k] = v.clone(); }
        json!({"version":2,"clients":[row]})
    };
    for bad in [json!({"scope":"admin"}), json!({"scope":"viewer"}), json!({"scope":"viewer","org":""}),
                json!({"scope":"full","org":"galaxy"}), json!({"org":"galaxy"})] {
        std::fs::write(root.0.join(FILE), file(bad.clone()).to_string()).unwrap();
        assert!(Registry::open(&root.0).is_err(), "must not load: {bad}");
    }
    std::fs::write(root.0.join(FILE), file(json!({"scope":"viewer","org":"galaxy"})).to_string()).unwrap();
    assert!(Registry::open(&root.0).is_ok());
}

#[test]
fn registry_create_validates_scope_arguments() {
    let root = Root::new();
    let registry = Registry::open(&root.0).unwrap();
    assert!(registry.manage(&json!({"action":"create","name":"a","scope":"viewer"})).is_err(), "viewer needs an org");
    assert!(registry.manage(&json!({"action":"create","name":"a","scope":"full","org":"galaxy"})).is_err(), "full takes no org");
    assert!(registry.manage(&json!({"action":"create","name":"a","org":"galaxy"})).is_err(), "default scope is full");
    assert!(registry.manage(&json!({"action":"create","name":"a","scope":"root"})).is_err());
    assert!(registry.manage(&json!({"action":"list","scope":"viewer"})).is_err(), "scope belongs to create only");
    let full = registry.manage(&json!({"action":"create","name":"a","scope":"full"})).unwrap();
    assert_eq!(full["scope"], "full");
}

#[tokio::test]
async fn http_create_needs_an_existing_org_and_lists_scope_and_org() {
    let root = Root::new();
    let server = Server::start(&root).await;
    let post = |body: Value| server.request("POST", "/api/standalone/clients", BOOTSTRAP, Some(body));
    assert_eq!(post(json!({"name":"v","scope":"viewer","org":"galaxy"})).await.0, 404, "no such org");
    add_org(&server, "galaxy");
    assert_eq!(post(json!({"name":"v","scope":"viewer"})).await.0, 400);
    assert_eq!(post(json!({"name":"v","scope":"full","org":"galaxy"})).await.0, 400);
    let viewer = create_viewer(&server, "Desk viewer", "galaxy").await;
    assert_eq!(viewer["scope"], "viewer");
    assert_eq!(viewer["org"], "galaxy");
    let (_, listed) = server.request("GET", "/api/standalone/clients", BOOTSTRAP, None).await;
    assert_eq!(listed["clients"][0]["scope"], "viewer");
    assert_eq!(listed["clients"][0]["org"], "galaxy");
    let rpc = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"orgtree_client_tokens",
        "arguments":{"action":"create","name":"MCP viewer","scope":"viewer","org":"galaxy"}}});
    let (status, created) = server.request("POST", "/api/mcp", BOOTSTRAP, Some(rpc)).await;
    assert_eq!(status, 200);
    let value: Value = serde_json::from_str(created["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(value["scope"], "viewer");
}

#[tokio::test]
async fn a_viewer_reaches_its_read_routes_and_nothing_else() {
    let root = Root::new();
    let server = Server::start(&root).await;
    add_org(&server, "galaxy");
    add_org(&server, "other");
    let token = create_viewer(&server, "Desk viewer", "galaxy").await["token"].as_str().unwrap().to_string();
    for (method, path) in [("GET", "/api/orgs/galaxy/records"), ("GET", "/api/orgs/galaxy/documents"),
                           ("POST", "/api/orgs/galaxy/inbox/read"), ("POST", "/api/orgs/galaxy/documents/viewed")] {
        let (status, body) = server.request(method, path, &token, Some(json!({}))).await;
        assert_ne!(status, 403, "{method} {path} must reach its handler: {body}");
    }
    for (method, path) in [("POST", "/api/orgs/galaxy/inbox/clear"), ("DELETE", "/api/orgs/galaxy/documents/1"),
                           ("POST", "/api/orgs/galaxy/nodes/1/message"), ("GET", "/api/orgs/galaxy/nodes/1/chat"),
                           ("GET", "/api/orgs/other/records"), ("GET", "/api/orgs"), ("GET", "/api/app/ws"),
                           ("POST", "/api/mcp"), ("POST", "/api/orgs/galaxy/mcp"),
                           ("POST", "/api/desktop/credential-bridge"), ("POST", "/api/agent-credential"),
                           ("GET", "/ls/anything"), ("GET", "/")] {
        let (status, body) = server.request(method, path, &token, Some(json!({}))).await;
        assert_eq!(status, 403, "{method} {path}");
        assert_eq!(body["detail"], READ_ONLY, "{method} {path}");
    }
    // the bootstrap key is unaffected
    assert_ne!(server.request("GET", "/api/orgs/other/records", BOOTSTRAP, None).await.0, 403);
}

#[tokio::test]
async fn a_viewer_cannot_manage_tokens_by_http_or_mcp() {
    let root = Root::new();
    let server = Server::start(&root).await;
    add_org(&server, "galaxy");
    let viewer = create_viewer(&server, "Desk viewer", "galaxy").await;
    let token = viewer["token"].as_str().unwrap();
    let (status, body) = server.request("POST", "/api/standalone/clients", token, Some(json!({"name":"escalate"}))).await;
    assert_eq!((status, body["detail"].as_str()), (403, Some(READ_ONLY)));
    assert_eq!(server.request("GET", "/api/standalone/clients", token, None).await.0, 403);
    let revoke = format!("/api/standalone/clients/{}", viewer["id"].as_str().unwrap());
    assert_eq!(server.request("DELETE", &revoke, token, None).await.0, 403);
    assert_eq!(server.alive(BOOTSTRAP).await, 200);
    let (_, listed) = server.request("GET", "/api/standalone/clients", BOOTSTRAP, None).await;
    assert_eq!(listed["clients"].as_array().unwrap().len(), 1, "nothing was created or revoked");
}

#[tokio::test]
async fn the_narrower_scope_wins_when_two_tokens_are_presented() {
    let root = Root::new();
    let server = Server::start(&root).await;
    add_org(&server, "galaxy");
    let viewer = create_viewer(&server, "Desk viewer", "galaxy").await;
    let token = viewer["token"].as_str().unwrap();
    let full = server.create("Full").await;
    let full = full["token"].as_str().unwrap();
    for (header, bearer) in [(token, full), (full, token), (BOOTSTRAP, token), (token, BOOTSTRAP)] {
        let (status, body) = request_two(&server, "/api/standalone/clients", header, bearer).await;
        assert_eq!((status, body["detail"].as_str()), (403, Some(READ_ONLY)), "header {header:.4} bearer {bearer:.4}");
    }
    assert_eq!(request_two(&server, "/api/standalone/clients", full, BOOTSTRAP).await.0, 200);
}

#[tokio::test]
async fn a_viewer_of_a_deleted_org_is_refused_but_listed_and_revocable() {
    let root = Root::new();
    let server = Server::start(&root).await;
    add_org(&server, "galaxy");
    let viewer = create_viewer(&server, "Desk viewer", "galaxy").await;
    let token = viewer["token"].as_str().unwrap();
    assert!(server.engine.orgs.remove("galaxy").is_some());
    let (status, body) = server.request("GET", "/api/orgs/galaxy/records", token, None).await;
    assert_eq!(status, 403);
    assert_eq!(body["detail"], "this viewer token's org no longer exists");
    let (_, listed) = server.request("GET", "/api/standalone/clients", BOOTSTRAP, None).await;
    assert_eq!(listed["clients"][0]["org"], "galaxy");
    let revoke = format!("/api/standalone/clients/{}", viewer["id"].as_str().unwrap());
    assert_eq!(server.request("DELETE", &revoke, BOOTSTRAP, None).await.0, 200);
}

fn masked_text_frame(text: &str) -> Vec<u8> {
    let payload = text.as_bytes();
    assert!(payload.len() < 126);
    let mut frame = vec![0x81, 0x80 | payload.len() as u8, 1, 2, 3, 4];
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ [1, 2, 3, 4][i % 4]));
    frame
}

#[tokio::test]
async fn a_viewer_socket_is_listen_only_closes_with_1008_and_dies_on_revoke() {
    let root = Root::new();
    let server = Server::start(&root).await;
    add_org(&server, "galaxy");
    add_org(&server, "other");
    let viewer = create_viewer(&server, "Desk viewer", "galaxy").await;
    let token = viewer["token"].as_str().unwrap();
    let upgrade = |path: &str| format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: SGVsbG9Xb3JsZDEyMzQ1Ng==\r\n\r\n");
    let mut other = TcpStream::connect(server.address).await.unwrap();
    other.write_all(upgrade("/api/orgs/other/ws").as_bytes()).await.unwrap();
    assert_eq!(response(&mut other).await.0, 403, "another org's socket");
    let mut app_ws = TcpStream::connect(server.address).await.unwrap();
    app_ws.write_all(upgrade("/api/app/ws").as_bytes()).await.unwrap();
    assert_eq!(response(&mut app_ws).await.0, 403, "the app-wide feed");
    let mut socket = TcpStream::connect(server.address).await.unwrap();
    socket.write_all(upgrade("/api/orgs/galaxy/ws").as_bytes()).await.unwrap();
    assert_eq!(response(&mut socket).await.0, 101);
    for _ in 0..20 {
        socket.write_all(&masked_text_frame(r#"{"type":"attract","running":true}"#)).await.unwrap();
    }
    // 20 ignored messages: the engine sends a Close frame with code 1008 (0x03F0), then drops the socket
    let mut seen = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = [0; 256];
        loop {
            match socket.read(&mut bytes).await { Ok(0) | Err(_) => return, Ok(n) => seen.extend_from_slice(&bytes[..n]) }
        }
    }).await;
    assert!(closed.is_ok(), "the socket must be closed after 20 ignored messages");
    assert!(seen.windows(4).any(|w| w[0] == 0x88 && w[2] == 0x03 && w[3] == 0xF0),
        "expected a Close frame with code 1008, got {seen:?}");
    let mut live = TcpStream::connect(server.address).await.unwrap();
    live.write_all(upgrade("/api/orgs/galaxy/ws").as_bytes()).await.unwrap();
    assert_eq!(response(&mut live).await.0, 101);
    let revoke = format!("/api/standalone/clients/{}", viewer["id"].as_str().unwrap());
    assert_eq!(server.request("DELETE", &revoke, BOOTSTRAP, None).await.0, 200);
    assert!(disconnected(&mut live).await, "revoking the viewer token closes its socket at once");
}

#[test]
fn a_viewers_scope_carries_its_client_id_and_org() {
    let root = Root::new();
    let registry = Registry::open(&root.0).unwrap();
    let viewer = registry.manage(&json!({"action":"create","name":"v","scope":"viewer","org":"galaxy"})).unwrap();
    let full = registry.manage(&json!({"action":"create","name":"f"})).unwrap();
    let clients = registry.clients.lock().unwrap();
    let scope_of = |id: &Value| clients.iter().find(|c| c.record.id == id.as_str().unwrap()).unwrap().record.scope();
    assert_eq!(scope_of(&viewer["id"]), Scope::Viewer { org: "galaxy".into(), client_id: viewer["id"].as_str().unwrap().into() });
    assert_eq!(scope_of(&full["id"]), Scope::Full);
}

#[test]
fn org_slugs_with_slashes_or_control_characters_are_refused_with_400() {
    let root = Root::new();
    let registry = Registry::open(&root.0).unwrap();
    for org in ["a/b", "a\u{7}b", ""] {
        let error = registry.manage(&json!({"action":"create","name":"v","scope":"viewer","org":org})).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST, "{org:?}");
    }
}

#[tokio::test]
async fn requests_without_a_token_or_with_the_bootstrap_key_are_unchanged_on_the_credential_and_language_server_paths() {
    let root = Root::new();
    let server = Server::start(&root).await;
    let body = json!({"pipe":r"\\.\pipe\orgtree-credentials-synthetic-viewer","secret":"1".repeat(64),"pid":std::process::id(),"release":true});
    for path in ["/api/desktop/credential-bridge", "/ls/anything"] {
        for token in [BOOTSTRAP, "no-such-token"] {
            let (status, value) = server.request("POST", path, token, Some(body.clone())).await;
            assert_ne!(value["detail"], READ_ONLY, "{path} with {token}");
            let _ = status;
        }
    }
    // the bridge reads the X-Orgtree-Desktop-Token header only (not Bearer)
    let bridge = |key: &'static str| {
        let body = body.to_string();
        let address = server.address;
        async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("POST /api/desktop/credential-bridge HTTP/1.1
Host: localhost
X-Orgtree-Desktop-Token: {key}
Content-Type: application/json
Content-Length: {}

{body}", body.len()).as_bytes()).await.unwrap();
            response(&mut stream).await.0
        }
    };
    assert_eq!(bridge(BOOTSTRAP).await, 200, "the bootstrap key still releases an absent broker");
    assert_eq!(bridge("no-such-token").await, 503, "a wrong token is still refused by the bridge's own check");
}
