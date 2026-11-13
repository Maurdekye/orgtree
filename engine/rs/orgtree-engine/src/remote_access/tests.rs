//! The remote door, through the real router and guard: a desktop engine with
//! the listener its own app uses and, beside it, the door (on loopback here;
//! `door.rs` never binds it there outside a test). No database: organizations
//! are provisional handles, so a request that passes the guard ends in a
//! handler that has nothing to read. What is asserted is the guard's answer.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::Method;
use chrono::Utc;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::door::{self, PeerRule};
use super::member::{self, Standing, Verdict};
use super::registry::{self, Admitted, Registry};
use super::text;
use crate::client_tokens::transport::Connection;
use crate::engine::Engine;
use crate::remote::testkit::{Root, DESKTOP_TOKEN};

const PC: &str = "Orgtree desktop (PC-DANA)";

struct Host {
    engine: Arc<Engine>,
    /// the listener the app itself uses
    app: SocketAddr,
    /// the remote door
    door: SocketAddr,
    http: reqwest::Client,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Host {
    async fn start(root: &Root) -> Host {
        let mut engine = Engine::for_tests(root.0.clone());
        let e = Arc::get_mut(&mut engine).unwrap();
        e.cfg.desktop_token = DESKTOP_TOKEN.into();
        e.cfg.data_root_id = "host-root".into();
        let (feed, inbox) = crate::appfeed::AppFeed::new();
        e.app = feed;
        crate::appfeed::start(&engine, inbox);
        // the app's own listener, served as `main` serves a desktop's
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let app = listener.local_addr().unwrap();
        let router = crate::http::router(engine.clone());
        let stop = engine.shutdown.clone();
        let app_task = tokio::spawn(async move {
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(stop.cancelled_owned()).await.unwrap();
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let door = listener.local_addr().unwrap();
        let door_task = door::serve(engine.clone(), listener, PeerRule::with_loopback(false), engine.shutdown.clone());
        let http = reqwest::Client::builder().no_proxy().pool_max_idle_per_host(0).build().unwrap();
        Host { engine, app, door, http, tasks: vec![app_task, door_task] }
    }

    /// An organization of this desktop; answers its uuid.
    fn org(&self, id: i64, slug: &str) -> String {
        let uuid = uuid::Uuid::new_v4().to_string();
        self.engine.orgs.insert(crate::orgs::provisional(id, uuid.clone(), slug.into(), slug.into()));
        uuid
    }

    /// An organization other computers may open.
    fn shared(&self, id: i64, slug: &str) -> String {
        let uuid = self.org(id, slug);
        self.engine.access.set_open(&uuid, true);
        uuid
    }

    async fn call(&self, to: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> (u16, Value) {
        let mut request = self.http.request(method.parse().unwrap(), format!("http://{to}{path}"));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = tokio::time::timeout(Duration::from_secs(10), request.send()).await.expect("an answer in time").unwrap();
        let status = response.status().as_u16();
        let bytes = response.bytes().await.unwrap_or_default();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// One request at the door with `token` as another computer sends it.
    async fn door(&self, method: &str, path: &str, token: &str, body: Option<Value>) -> (u16, Value) {
        self.call(self.door, method, path, &[("authorization", &format!("Bearer {token}"))], body).await
    }

    /// A one-time code for `org`, as the owner's settings make one.
    fn code(&self, org: &str) -> String {
        self.engine.access.registry.invite(org).unwrap()["code"].as_str().unwrap().to_string()
    }

    /// A computer let into `org` with a code: its id and its own token.
    async fn let_in(&self, org: &str, name: &str) -> (String, String) {
        let (status, made) = self.door("POST", "/api/standalone/clients", &self.code(org), Some(json!({ "name": name }))).await;
        assert_eq!(status, 200, "{made}");
        (made["id"].as_str().unwrap().to_string(), made["token"].as_str().unwrap().to_string())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.engine.shutdown.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}

fn refused_as_not_yours(answer: &(u16, Value)) -> bool {
    answer.0 == 403 && answer.1["code"] == text::E17 && answer.1["detail"].as_str().is_some_and(|d| d.starts_with("This belongs to "))
}

fn refused_for_its_token(answer: &(u16, Value)) -> bool {
    answer.0 == 403 && answer.1["detail"] == text::TOKEN_REQUIRED && answer.1.get("code").is_none()
}

/// The status and body of one HTTP/1.1 answer on a raw connection.
async fn answer(stream: &mut TcpStream) -> (u16, Vec<u8>) {
    let mut head = Vec::new();
    loop {
        head.push(tokio::time::timeout(Duration::from_secs(5), stream.read_u8()).await.expect("an answer in time").unwrap());
        assert!(head.len() < 32 * 1024);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8(head).unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let length = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|n| n.trim().parse::<usize>().unwrap())).unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    (status, body)
}

/// A connection another computer keeps open at the door after one answered request.
async fn kept(door: SocketAddr, token: &str) -> TcpStream {
    let mut stream = TcpStream::connect(door).await.unwrap();
    stream.write_all(format!("GET /api/desktop/alive HTTP/1.1\r\nHost: door\r\nAuthorization: Bearer {token}\r\n\r\n").as_bytes()).await.unwrap();
    assert_eq!(answer(&mut stream).await.0, 200);
    stream
}

/// Did the other side end this connection within a second?
async fn ended(stream: &mut TcpStream) -> bool {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut bytes = [0; 1024];
        loop {
            match stream.read(&mut bytes).await {
                Ok(0) | Err(_) => return true,
                Ok(_) => {}
            }
        }
    }).await.unwrap_or(false)
}

/// A connection as the door accepts one, and the far end that keeps it open.
async fn connection() -> (Arc<Connection>, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let far = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
    let (stream, peer) = listener.accept().await.unwrap();
    let io = Connection::accept(stream, peer, true).unwrap();
    (io.connection().clone(), far)
}

fn org_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ------------------------------------------------------------ F-T2: two listeners, two kinds of token

#[tokio::test]
async fn the_door_and_the_apps_own_listener_each_take_only_their_own_tokens() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let (_, token) = host.let_in(&galaxy, PC).await;
    let bearer = format!("Bearer {token}");

    // control: each token works where it belongs
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);
    assert_eq!(host.call(host.app, "GET", "/api/desktop/alive", &[(crate::http::TOKEN_HEADER, DESKTOP_TOKEN)], None).await.0, 200);

    // the app's own token is nobody's at the door, wherever a token can stand
    let desktop_bearer = format!("Bearer {DESKTOP_TOKEN}");
    for headers in [vec![("authorization", desktop_bearer.as_str())], vec![(crate::http::TOKEN_HEADER, DESKTOP_TOKEN)],
                    vec![(crate::http::TOKEN_HEADER, DESKTOP_TOKEN), ("authorization", desktop_bearer.as_str())]] {
        for path in ["/api/desktop/alive", "/api/host", "/api/orgs/galaxy/records", "/api/orgs", "/api/accounts"] {
            let got = host.call(host.door, "GET", path, &headers, None).await;
            assert!(refused_for_its_token(&got), "{path} with {headers:?}: {got:?}");
        }
    }
    // no token, an empty one, a wrong one, one in the wrong scheme, two at once
    for headers in [vec![], vec![("authorization", "Bearer ")], vec![("authorization", "Bearer 0000")], vec![("authorization", token.as_str())],
                    vec![("authorization", "Basic dXNlcjpwYXNz")], vec![("authorization", bearer.as_str()), ("authorization", bearer.as_str())]] {
        let got = host.call(host.door, "GET", "/api/desktop/alive", &headers, None).await;
        assert!(refused_for_its_token(&got), "{headers:?}: {got:?}");
    }

    // a door token is not read on the app's listener, in either place
    for headers in [vec![("authorization", bearer.as_str())], vec![(crate::http::TOKEN_HEADER, token.as_str())]] {
        for path in ["/api/desktop/alive", "/api/orgs/galaxy/records", "/api/host"] {
            let got = host.call(host.app, "GET", path, &headers, None).await;
            assert_eq!((got.0, got.1["detail"].as_str()), (403, Some("desktop token required")), "{path} with {headers:?}");
        }
    }

    // the app's token beside a member's own widens nothing: the member is still only a member
    let got = host.call(host.door, "GET", "/api/accounts", &[("authorization", bearer.as_str()), (crate::http::TOKEN_HEADER, DESKTOP_TOKEN)], None).await;
    assert!(refused_as_not_yours(&got), "{got:?}");
}

#[tokio::test]
async fn the_door_serves_the_api_and_nothing_else() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let (_, token) = host.let_in(&galaxy, PC).await;
    let bearer = format!("Bearer {token}");

    // no page, no file, no language-server proxy: with a good token and without one
    for path in ["/", "/index.html", "/assets/app.js", "/o/galaxy", "/ls/1/v1/models", "/ls/anything", "/api", "/apix/desktop/alive"] {
        for headers in [vec![("authorization", bearer.as_str())], vec![]] {
            let got = host.call(host.door, "GET", path, &headers, None).await;
            assert_eq!((got.0, got.1["detail"].as_str()), (404, Some("not found")), "{path} with {headers:?}");
        }
    }
    // the credential bridge is the hosting computer's own
    for path in ["/api/desktop/credential-bridge", "/api/agent-credential"] {
        let got = host.door("POST", path, &token, Some(json!({}))).await;
        assert!(refused_as_not_yours(&got), "{path}: {got:?}");
        let got = host.call(host.door, "POST", path, &[], Some(json!({}))).await;
        assert!(refused_for_its_token(&got), "{path}: {got:?}");
    }
    // a page is never a caller: a request that names an origin is refused, good token or not
    for origin in ["http://127.0.0.1:47800", "https://evil.example", "null"] {
        let got = host.call(host.door, "GET", "/api/desktop/alive", &[("authorization", bearer.as_str()), ("origin", origin)], None).await;
        assert!(refused_for_its_token(&got), "origin {origin}: {got:?}");
    }
    // the header a remote organization's window carries on this desktop means nothing here:
    // the request is answered by this engine (an unknown connection would be a 400 otherwise)
    let got = host.call(host.door, "GET", "/api/host", &[("authorization", bearer.as_str()), (crate::remote::HEADER, "some-connection")], None).await;
    assert_eq!((got.0, got.1["mode"].as_str()), (200, Some("host")), "{got:?}");
}

// ------------------------------------------------------------ F-T3: one-time codes

#[tokio::test]
async fn a_code_makes_exactly_one_computer_and_opens_no_organization() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let code = host.code(&galaxy);
    assert_eq!(code.len(), registry::CODE_LENGTH);
    assert!(code.bytes().all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b)), "{code}");

    // what a code may do: see that an engine answers and what it is
    assert_eq!(host.door("GET", "/api/desktop/alive", &code, None).await.0, 200);
    let (status, what) = host.door("GET", "/api/host", &code, None).await;
    assert_eq!((status, what["mode"].as_str()), (200, Some("host")), "{what}");
    assert!(what["computer"].as_str().is_some_and(|name| !name.is_empty()), "{what}");
    assert!(what["engine"].as_str().is_some_and(|engine| engine.starts_with("orgtree-engine ")), "{what}");

    // and nothing else: not the organization it is for, not a list, not a socket
    for (method, path) in [("GET", "/api/orgs/galaxy"), ("GET", "/api/orgs/galaxy/records"), ("GET", "/api/orgs/galaxy/ws"),
                           ("POST", "/api/orgs/galaxy/nodes/1/message"), ("GET", "/api/orgs"), ("GET", "/api/standalone/clients"),
                           ("DELETE", "/api/standalone/clients/x"), ("GET", "/api/app/ws"), ("GET", "/api/app/records"),
                           ("GET", "/api/accounts"), ("POST", "/api/desktop/alive"), ("GET", "/api/host/"), ("POST", "/api/standalone/clients/")] {
        let got = host.door(method, path, &code, Some(json!({}))).await;
        assert!(refused_as_not_yours(&got), "{method} {path}: {got:?}");
    }
    // a body that asks for more than a name is refused and uses nothing up
    for body in [json!({ "name": "PC", "scope": "full" }), json!({ "name": "PC", "org": "galaxy" }), json!({ "name": "" })] {
        assert_eq!(host.door("POST", "/api/standalone/clients", &code, Some(body.clone())).await.0, 400, "{body}");
    }
    assert!(host.engine.access.registry.rows(None).is_empty());

    // it makes one computer, which holds its own token for that one organization
    let (status, made) = host.door("POST", "/api/standalone/clients", &code, Some(json!({ "name": PC }))).await;
    assert_eq!(status, 200, "{made}");
    let (id, token) = (made["id"].as_str().unwrap(), made["token"].as_str().unwrap());
    assert_eq!((made["scope"].as_str(), made["name"].as_str(), made["label"].as_str()), (Some("member"), Some(PC), Some("PC-DANA")), "{made}");
    assert_eq!(made["orgs"], json!(["galaxy"]), "{made}");
    assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) && uuid::Uuid::parse_str(id).is_ok(), "{made}");
    assert_eq!(host.door("GET", "/api/desktop/alive", token, None).await.0, 200);

    // and the code is gone: it is nobody's token now
    for (method, path) in [("GET", "/api/desktop/alive"), ("GET", "/api/host"), ("POST", "/api/standalone/clients")] {
        let got = host.door(method, path, &code, Some(json!({ "name": "a second computer" }))).await;
        assert!(refused_for_its_token(&got), "{method} {path} after use: {got:?}");
    }
    assert_eq!(host.engine.access.registry.rows(None).len(), 1);

    // neither the code nor the token can be read back from the file
    let file = std::fs::read_to_string(root.0.join(registry::FILE)).unwrap();
    assert!(!file.contains(&code) && !file.contains(token), "{file}");
    assert!(file.contains(&crate::client_tokens::hash(token)) && file.contains(id), "{file}");
}

#[tokio::test]
async fn a_code_for_an_organization_that_was_switched_off_opens_nothing() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let code = host.code(&galaxy);
    host.engine.access.set_open(&galaxy, false);
    for (method, path) in [("GET", "/api/desktop/alive"), ("POST", "/api/standalone/clients")] {
        let got = host.door(method, path, &code, Some(json!({ "name": PC }))).await;
        assert!(refused_for_its_token(&got), "{method} {path}: {got:?}");
    }
    assert!(host.engine.access.registry.rows(None).is_empty());
}

#[tokio::test]
async fn a_code_runs_out_after_fifteen_minutes() {
    let root = Root::new();
    let registry = Registry::open(&root.0);
    let org = org_id();
    let now = Utc::now();
    let code = registry.invite_at(&org, now).unwrap()["code"].as_str().unwrap().to_string();
    let (connection, _far) = connection().await;
    let just_before = now + chrono::Duration::minutes(registry::INVITATION_MINUTES) - chrono::Duration::seconds(1);
    let at_the_end = now + chrono::Duration::minutes(registry::INVITATION_MINUTES);
    assert!(matches!(registry.authenticate_at(&code, &connection, just_before), Some(Admitted::Invitation { org: of }) if of == org));
    assert!(registry.authenticate_at(&code, &connection, at_the_end).is_none(), "a code is valid for 15 minutes");
    assert!(registry.redeem_at(&code, PC, at_the_end).unwrap().is_none(), "and makes no computer after them");
    assert!(registry.rows(None).is_empty());
    let made = registry.redeem_at(&code, PC, just_before).unwrap().expect("in time it does");
    assert_eq!(made["scope"], "member");
    assert!(registry.redeem_at(&code, PC, just_before).unwrap().is_none(), "once");
}

#[tokio::test]
async fn codes_and_computers_of_one_organization_are_limited() {
    let root = Root::new();
    let registry = Registry::open(&root.0);
    let (org, other) = (org_id(), org_id());
    let now = Utc::now();
    let codes: Vec<String> = (0..registry::MAX_INVITATIONS).map(|_| registry.invite_at(&org, now).unwrap()["code"].as_str().unwrap().to_string()).collect();
    let refused = registry.invite_at(&org, now).err().expect("a sixth open code is refused");
    assert_eq!((refused.status.as_u16(), refused.detail.as_str()), (409, text::TOO_MANY_CODES));
    assert!(registry.invite_at(&other, now).is_ok(), "another organization has its own five");
    assert_eq!(registry.invitations(&org).len(), registry::MAX_INVITATIONS);
    // a code that was used or ran out is not counted
    assert!(registry.redeem_at(&codes[0], "PC 0", now).unwrap().is_some());
    assert!(registry.invite_at(&org, now).is_ok());
    assert!(registry.invite_at(&org, now + chrono::Duration::minutes(16)).is_ok(), "all five ran out");

    // 32 computers
    let later = now + chrono::Duration::hours(1);
    let mut last = String::new();
    for n in 1..registry::MAX_COMPUTERS {
        let code = registry.invite_at(&org, later).unwrap()["code"].as_str().unwrap().to_string();
        last = registry.redeem_at(&code, &format!("PC {n}"), later).unwrap().unwrap()["id"].as_str().unwrap().to_string();
    }
    assert_eq!(registry.rows(Some(&org)).len(), registry::MAX_COMPUTERS);
    let refused = registry.invite_at(&org, later).err().expect("no code for a full organization");
    assert_eq!((refused.status.as_u16(), refused.detail.as_str()), (409, text::TOO_MANY_COMPUTERS));
    // a computer of another organization cannot be given a full one either
    let code = registry.invite_at(&other, later).unwrap()["code"].as_str().unwrap().to_string();
    let stranger = registry.redeem_at(&code, "PC other", later).unwrap().unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(registry.give(&stranger, &org).err().map(|e| e.status.as_u16()), Some(409));
    // one is revoked: there is room again
    registry.revoke(&last).unwrap();
    assert_eq!(registry.give(&stranger, &org).unwrap()["orgs"].as_array().unwrap().len(), 2);
}

// ------------------------------------------------------------ F-T4: what a member may do

#[tokio::test]
async fn a_member_has_the_organization_it_was_given_and_nothing_else() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let other = host.shared(8, "other");
    let (id, token) = host.let_in(&galaxy, PC).await;

    // its organization: reads, writes, every mailbox, the socket
    for (method, path) in [("GET", "/api/orgs/galaxy/records"), ("GET", "/api/orgs/galaxy/documents"), ("POST", "/api/orgs/galaxy/inbox/read"),
                           ("POST", "/api/orgs/galaxy/documents/viewed"), ("GET", "/api/orgs/galaxy/ws")] {
        let got = host.door(method, path, &token, Some(json!({}))).await;
        assert_ne!(got.0, 403, "{method} {path} must reach its handler: {got:?}");
    }

    // another organization of this desktop and one that does not exist are refused alike:
    // a member cannot learn what else is here
    let foreign = host.door("GET", "/api/orgs/other/records", &token, None).await;
    assert!(refused_as_not_yours(&foreign), "{foreign:?}");
    assert_eq!(host.door("GET", "/api/orgs/no-such-org/records", &token, None).await, foreign);

    // what is the owner's alone inside the organization, everything app-wide, everything of this computer
    for (method, path) in [
        ("DELETE", "/api/orgs/galaxy"), ("POST", "/api/orgs/galaxy"), ("POST", "/api/orgs/galaxy/mcp"), ("POST", "/api/orgs/galaxy/template"),
        ("GET", "/api/orgs"), ("POST", "/api/orgs"),
        ("GET", "/api/accounts"), ("POST", "/api/accounts"), ("DELETE", "/api/accounts/claude-1"), ("GET", "/api/accounts/claude-1/identity"),
        ("PUT", "/api/accounts/claude-1/enabled"), ("POST", "/api/accounts/keys"), ("PUT", "/api/openrouter/key"),
        ("GET", "/api/app-settings/instructions"), ("PUT", "/api/app-settings/instructions"), ("PUT", "/api/app-settings/runtime"),
        ("GET", "/api/defaults"), ("POST", "/api/defaults"), ("POST", "/api/langservers"), ("PUT", "/api/providers/claude/enabled"),
        ("PUT", "/api/charters/lead"), ("POST", "/api/charters/open"), ("POST", "/api/templates/open"), ("GET", "/api/fs"),
        ("GET", "/api/desktop/status"), ("POST", "/api/desktop/shutdown"), ("GET", "/api/desktop/phone"), ("POST", "/api/desktop/phone/code"),
        ("GET", "/api/desktop/identity"), ("GET", "/api/diagnostics/engine-stats"), ("GET", "/api/crash-reports"),
        ("GET", "/api/remotes"), ("POST", "/api/remotes"), ("DELETE", "/api/remotes/r1"), ("PUT", "/api/remotes/shown-as"),
        ("POST", "/api/mcp"), ("GET", "/api/app/ws"), ("GET", "/api/app/records"), ("GET", "/api/app-settings/live-feed/tokens"),
        ("POST", "/api/standalone/clients"), ("POST", "/api/rig/tool"), ("GET", "/api/changelog"), ("GET", "/api/unknown"),
        // not a route as the router writes it
        ("GET", "/api/orgs/galaxy/records/"), ("GET", "/api/orgs/galaxy/no-such-route"), ("GET", "/api/orgs/galaxy/../other/records"),
        ("GET", "/api/orgs//records"), ("POST", "/api/desktop/alive"), ("PUT", "/api/host"),
    ] {
        let got = host.door(method, path, &token, Some(json!({}))).await;
        assert!(refused_as_not_yours(&got), "{method} {path}: {got:?}");
    }
    assert!(host.engine.orgs.get("galaxy").is_some(), "nothing was deleted");

    // the owner switches the organization off: it is closed, and the answer says so
    host.engine.access.set_open(&galaxy, false);
    for (method, path) in [("GET", "/api/orgs/galaxy/records"), ("GET", "/api/orgs/galaxy"), ("POST", "/api/orgs/galaxy/nodes/1/message"), ("GET", "/api/orgs/galaxy/no-such-route")] {
        let got = host.door(method, path, &token, Some(json!({}))).await;
        assert_eq!((got.0, got.1["code"].as_str()), (403, Some(text::E16)), "{method} {path}: {got:?}");
    }
    // the computer itself is still known, and its record is still there
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);
    assert_eq!(host.engine.access.registry.rows(Some(&galaxy)).len(), 1);
    // switched on again, it opens again: nothing had to be added a second time
    host.engine.access.set_open(&galaxy, true);
    assert_ne!(host.door("GET", "/api/orgs/galaxy/records", &token, None).await.0, 403);

    // a second organization is given to a computer that is already known, with no code
    host.engine.access.registry.give(&id, &other).unwrap();
    assert_ne!(host.door("GET", "/api/orgs/other/records", &token, None).await.0, 403);
}

#[tokio::test]
async fn a_member_reads_names_and_removes_its_own_record_and_no_other() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let hidden = host.org(8, "hidden");
    let (dana, dana_token) = host.let_in(&galaxy, PC).await;
    let (sam, sam_token) = host.let_in(&galaxy, "Orgtree desktop (PC-SAM)").await;
    // an organization it was given whose switch is off is not among the ones it can open
    host.engine.access.registry.give(&dana, &hidden).unwrap();

    let (status, listed) = host.door("GET", "/api/standalone/clients", &dana_token, None).await;
    assert_eq!(status, 200, "{listed}");
    let rows = listed["clients"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "its own record and no other: {listed}");
    assert_eq!((rows[0]["id"].as_str(), rows[0]["scope"].as_str(), rows[0]["label"].as_str()), (Some(dana.as_str()), Some("member"), Some("PC-DANA")), "{listed}");
    assert_eq!(rows[0]["orgs"], json!(["galaxy"]), "{listed}");
    assert_eq!(rows[0]["connected"], true, "{listed}");
    assert_eq!(listed["you"], json!({ "id": dana, "name": "PC-DANA", "on": PC }), "{listed}");
    let text = listed.to_string();
    assert!(!text.contains("hash") && !text.contains("token") && !text.contains(&sam) && !text.contains(&hidden), "{text}");

    // its own name
    let own = format!("/api/standalone/clients/{dana}");
    let (status, row) = host.door("PATCH", &own, &dana_token, Some(json!({ "label": "  Dana " }))).await;
    assert_eq!((status, row["label"].as_str()), (200, Some("Dana")), "{row}");
    assert_eq!(host.engine.access.registry.row(&dana).unwrap()["label"], "Dana");
    assert_eq!(host.door("PATCH", &own, &dana_token, Some(json!({ "label": "x".repeat(41) }))).await.0, 400);
    let (_, row) = host.door("PATCH", &own, &dana_token, Some(json!({ "label": null }))).await;
    assert_eq!(row["label"], "PC-DANA");

    // nobody else's
    let theirs = format!("/api/standalone/clients/{sam}");
    for (method, body) in [("PATCH", Some(json!({ "label": "Mallory" }))), ("DELETE", None)] {
        let got = host.door(method, &theirs, &dana_token, body).await;
        assert!(refused_as_not_yours(&got), "{method}: {got:?}");
    }
    assert_eq!(host.engine.access.registry.row(&sam).unwrap()["label"], "PC-SAM");

    // it removes itself: its token is nobody's from then on, and the other computer is untouched
    let mut stream = TcpStream::connect(host.door).await.unwrap();
    stream.write_all(format!("DELETE {own} HTTP/1.1\r\nHost: door\r\nAuthorization: Bearer {dana_token}\r\n\r\n").as_bytes()).await.unwrap();
    assert!(ended(&mut stream).await, "its connections end, the one that asked too");
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &dana_token, None).await));
    assert!(host.engine.access.registry.row(&dana).is_none());
    assert_eq!(host.door("GET", "/api/desktop/alive", &sam_token, None).await.0, 200);
}

// ------------------------------------------------------------ F-T6 (the registry's half): revoke and the switch end connections

#[tokio::test]
async fn revoking_a_computer_or_switching_its_organization_off_ends_its_connections_at_once() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let other = host.shared(8, "other");
    let (dana, dana_token) = host.let_in(&galaxy, PC).await;
    let (sam, sam_token) = host.let_in(&other, "Orgtree desktop (PC-SAM)").await;

    let mut danas = kept(host.door, &dana_token).await;
    let mut sams = kept(host.door, &sam_token).await;
    assert_eq!(host.engine.access.registry.row(&dana).unwrap()["connected"], true);

    // the switch of one organization: the computers that have it, and no other
    host.engine.access.set_open(&galaxy, false);
    assert!(ended(&mut danas).await, "its connection ends as the switch goes off");
    assert!(!ended(&mut sams).await, "a computer of another organization stays connected");
    let row = host.engine.access.registry.row(&dana).unwrap();
    assert_eq!((row["connected"].as_bool(), row["orgs"].as_array().map(Vec::len)), (Some(false), Some(1)), "the record stays: {row}");
    assert!(row["last_seen_at"].is_string(), "{row}");

    // revoke: the record goes and the connection with it
    let revoked = host.engine.access.registry.revoke(&sam).unwrap();
    assert_eq!(revoked["id"], sam.as_str());
    assert!(ended(&mut sams).await, "a revoked computer's connection ends");
    assert!(host.engine.access.registry.row(&sam).is_none());
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &sam_token, None).await));
    assert_eq!(host.engine.access.registry.revoke(&sam).err().map(|e| e.status.as_u16()), Some(404));
}

// ------------------------------------------------------------ the registry's file

#[tokio::test]
async fn the_registry_survives_a_restart_and_a_broken_file_lets_nobody_in() {
    let root = Root::new();
    let (org, other) = (org_id(), org_id());
    let (connection, _far) = connection().await;
    let (id, token) = {
        let registry = Registry::open(&root.0);
        let code = registry.invite(&org).unwrap()["code"].as_str().unwrap().to_string();
        let made = registry.redeem(&code, PC).unwrap().unwrap();
        registry.set_label(made["id"].as_str().unwrap(), Some("Dana")).unwrap();
        registry.give(made["id"].as_str().unwrap(), &other).unwrap();
        registry.invite(&other).unwrap();
        (made["id"].as_str().unwrap().to_string(), made["token"].as_str().unwrap().to_string())
    };
    let registry = Registry::open(&root.0);
    assert!(matches!(registry.authenticate(&token, &connection),
        Some(Admitted::Member { client_id, orgs, origin }) if client_id == id && orgs == vec![org.clone(), other.clone()] && origin.name == "Dana" && origin.on.as_deref() == Some(PC)));
    assert_eq!(registry.invitations(&other).len(), 1, "an open code is still open");
    let saved: Value = serde_json::from_slice(&std::fs::read(root.0.join(registry::FILE)).unwrap()).unwrap();
    assert_eq!(saved["version"], 1);
    assert!(saved["clients"][0]["hash"].as_str().is_some_and(|hash| hash.len() == 64) && saved["clients"][0].get("token").is_none(), "{saved}");

    // the organization is deleted: nobody has it any more; a computer with nothing left is removed
    registry.forget_org(&org).unwrap();
    assert_eq!(registry.row(&id).unwrap()["orgs"], json!([other]));
    registry.forget_org(&other).unwrap();
    assert!(registry.is_empty());
    assert!(registry.authenticate(&token, &connection).is_none());

    // a file that is not a registry lets nobody in, and is kept aside for whoever looks into it
    for broken in ["{", r#"{"version":9,"clients":[],"invitations":[]}"#, r#"{"version":1,"clients":[{"id":"x"}],"invitations":[]}"#,
                   r#"{"version":1,"clients":[],"invitations":[],"extra":true}"#] {
        let root = Root::new();
        std::fs::write(root.0.join(registry::FILE), broken).unwrap();
        let registry = Registry::open(&root.0);
        assert!(registry.is_empty(), "{broken}");
        assert!(!root.0.join(registry::FILE).exists(), "{broken}");
        let kept: Vec<_> = std::fs::read_dir(&root.0).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("remote-access.broken-")).collect();
        assert_eq!(kept.len(), 1, "{broken}: {kept:?}");
        // and the next change starts a clean file
        registry.invite(&org_id()).unwrap();
        assert!(root.0.join(registry::FILE).exists());
    }
}

// ------------------------------------------------------------ the route table by itself

fn verdict_of(method: &str, path: &str) -> Verdict {
    member::verdict(&method.parse::<Method>().unwrap(), path, "me", |slug| match slug {
        "galaxy" => Standing::Open,
        "shut" => Standing::Shut,
        _ => Standing::Foreign,
    })
}

#[test]
fn every_route_is_classified_for_members() {
    let routes = crate::http::viewer_tests::route_literals();
    assert!(routes.len() > 200, "the route table parse found only {} routes", routes.len());
    let wrong: Vec<_> = routes.iter().filter(|route| member::listed(route) != 1).collect();
    assert!(wrong.is_empty(), "routes that are not in exactly one list of remote_access/member.rs (an organization's route goes in ORG \
        unless it reaches beyond the organization; anything else in REFUSED unless a computer that was let in must read it): {wrong:#?}");
}

#[test]
fn the_lists_name_routes_of_the_router_and_nothing_else() {
    let routes = crate::http::viewer_tests::route_literals();
    let is_route = |route: &str| routes.iter().any(|r| r == route);
    // What a member may read beyond its organization, what it may do with its own record and what a
    // code may do are short lists on purpose: making one longer is a change to this line too.
    assert_eq!((member::READ.len(), member::OWN.len(), member::INVITATION.len()), (3, 3, 3));
    assert!(member::ORG.len() >= 100 && member::REFUSED.len() >= 100, "{} and {}", member::ORG.len(), member::REFUSED.len());
    for route in member::ORG.iter().chain(member::READ).chain(member::REFUSED) {
        assert!(is_route(route), "{route} is listed but is not a route");
    }
    for (_, route) in member::OWN.iter().chain(member::INVITATION) {
        assert!(is_route(route), "{route} is listed but is not a route");
    }
    for route in member::ORG {
        assert!(route.starts_with("/api/orgs/{slug}/"), "{route}: ORG is for routes below an organization");
    }
    // a one-time code may do nothing a member may not, except make the one client
    for (method, route) in member::INVITATION {
        assert!((*method == "GET" && member::READ.contains(route)) || (*method, *route) == ("POST", "/api/standalone/clients"), "{method} {route}");
    }
}

#[test]
fn the_table_gives_a_member_its_organization_and_refuses_the_rest() {
    use Verdict::*;
    // every route of an organization, for the organization it was given only
    let routes = crate::http::viewer_tests::route_literals();
    let fill = |route: &str, slug: &str| route.replace("{slug}", slug).replace("{*rest}", "a/b").split('/')
        .map(|part| if part.starts_with('{') { "x1" } else { part }).collect::<Vec<_>>().join("/");
    for route in member::ORG {
        for method in ["GET", "POST", "PUT", "DELETE", "PATCH"] {
            assert_eq!(verdict_of(method, &fill(route, "galaxy")), Allow, "{method} {route}");
            assert_eq!(verdict_of(method, &fill(route, "other")), Refuse, "{method} {route} of another organization");
            assert_eq!(verdict_of(method, &fill(route, "galaxy2")), Refuse, "{method} {route} of a longer name");
            assert_eq!(verdict_of(method, &fill(route, "shut")), Shut, "{method} {route} of one that is switched off");
        }
    }
    // every refused route, with every method, also when the path names the member's organization
    for route in member::REFUSED {
        for method in ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
            assert_eq!(verdict_of(method, &fill(route, "galaxy")), Refuse, "{method} {route}");
        }
    }
    assert!(routes.iter().filter(|route| route.starts_with("/api/orgs/{slug}")).count() == member::ORG.len() + 3, "ORG, the organization itself, mcp and template");

    // reads that are reads only
    for path in ["/api/orgs/galaxy", "/api/desktop/alive", "/api/host"] {
        assert_eq!(verdict_of("GET", path), Allow, "{path}");
        assert_eq!(verdict_of("HEAD", path), Allow, "{path}");
        for method in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
            assert_eq!(verdict_of(method, path), Refuse, "{method} {path}");
        }
    }
    // any mailbox of its organization, not only the user's
    for mailbox in ["user", "node", "org"] {
        assert_eq!(verdict_of("GET", &format!("/api/orgs/galaxy/mail/{mailbox}/5")), Allow);
    }
    // its own record, by its own id
    assert_eq!(verdict_of("GET", "/api/standalone/clients"), Allow);
    assert_eq!(verdict_of("PATCH", "/api/standalone/clients/me"), Allow);
    assert_eq!(verdict_of("DELETE", "/api/standalone/clients/me"), Allow);
    for (method, path) in [("POST", "/api/standalone/clients"), ("PATCH", "/api/standalone/clients/you"), ("DELETE", "/api/standalone/clients/you"),
                           ("GET", "/api/standalone/clients/me"), ("DELETE", "/api/standalone/clients"), ("DELETE", "/api/standalone/clients/me/"),
                           ("PATCH", "/api/standalone/clients/"), ("DELETE", "/api/standalone/clients/me/x")] {
        assert_eq!(verdict_of(method, path), Refuse, "{method} {path}");
    }
    // paths that are not a route as written
    for path in ["/api/orgs/galaxy/", "/api/orgs/galaxy/records/", "/api/orgs/galaxy/records/extra", "/api/orgs/galaxy/nodes//chat",
                 "/api/orgs/galaxy/nodes/../chat", "/api/orgs/galaxy/foreground-tree/", "/api/orgs/galaxy/foreground-tree/a/../b",
                 "/api/orgs/galaxy/foreground-tree/a//b", "api/orgs/galaxy/records", "/api/orgs/galaxy/records?x", "/API/orgs/galaxy/records",
                 "/api/host/", "/api/desktop/alive/x", "/", ""] {
        assert_eq!(verdict_of("GET", path), Refuse, "{path}");
    }
    // a member with no id (it cannot happen) has no record route
    assert_eq!(member::verdict(&Method::DELETE, "/api/standalone/clients/", "", |_| Standing::Foreign), Refuse);

    // a one-time code: three exact requests
    for (method, path) in [("GET", "/api/desktop/alive"), ("GET", "/api/host"), ("POST", "/api/standalone/clients")] {
        assert!(member::invitation_allows(&method.parse().unwrap(), path), "{method} {path}");
    }
    for (method, path) in [("HEAD", "/api/host"), ("POST", "/api/host"), ("GET", "/api/standalone/clients"), ("POST", "/api/standalone/clients/"),
                           ("GET", "/api/orgs/galaxy"), ("GET", "/api/desktop/alive/"), ("DELETE", "/api/standalone/clients/me")] {
        assert!(!member::invitation_allows(&method.parse().unwrap(), path), "{method} {path}");
    }
}

#[test]
fn the_audit_line_holds_no_id_and_no_value() {
    let line = member::log_line("c-1", &Method::GET, "/api/orgs/galaxy/documents/42/download", "allowed");
    assert_eq!(line, "remote access c-1 GET /api/orgs/galaxy/documents allowed");
    let line = member::log_line("code", &Method::DELETE, "/api/standalone/clients/some-id", "refused");
    assert_eq!(line, "remote access code DELETE /api/standalone/clients refused");
}

// ------------------------------------------------------------ F-T1 (the peer's half): who the door takes

#[test]
fn the_door_takes_tailscale_peers_private_ones_by_choice_and_never_a_public_one() {
    let ip = |text: &str| text.parse::<std::net::IpAddr>().unwrap();
    let (tailscale_only, with_lan) = (PeerRule::new(false), PeerRule::new(true));
    for peer in ["100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1"] {
        assert!(tailscale_only.admits(ip(peer)) && with_lan.admits(ip(peer)), "{peer}");
    }
    for peer in ["192.168.1.20", "10.0.0.5", "172.16.4.4", "fc00::1", "fd00::1"] {
        assert!(!tailscale_only.admits(ip(peer)), "{peer}: Tailscale only");
        assert!(with_lan.admits(ip(peer)), "{peer}: and this private network");
    }
    for peer in ["8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "192.169.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "169.254.1.1", "0.0.0.0"] {
        assert!(!tailscale_only.admits(ip(peer)) && !with_lan.admits(ip(peer)) && !PeerRule::with_loopback(true).admits(ip(peer)), "{peer} is public");
    }
    // this computer itself: only the test rig's rule takes it
    for peer in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
        assert!(!tailscale_only.admits(ip(peer)) && !with_lan.admits(ip(peer)), "{peer}");
        assert!(PeerRule::with_loopback(false).admits(ip(peer)), "{peer}");
    }
    assert!(with_lan.admits(ip("::ffff:192.168.1.20")) && tailscale_only.admits(ip("::ffff:100.64.0.1")), "an IPv4 peer on a dual-stack socket");
}

#[tokio::test]
async fn a_peer_the_door_does_not_take_is_dropped_before_anything_is_read() {
    let root = Root::new();
    let engine = Engine::for_tests(root.0.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let at = listener.local_addr().unwrap();
    // the production rule: this test's own peer (loopback) is not one the door takes
    let task = door::serve(engine.clone(), listener, PeerRule::new(true), engine.shutdown.clone());
    let mut stream = TcpStream::connect(at).await.unwrap();
    // nothing is sent: a door that waited for a request would keep this connection open
    assert!(ended(&mut stream).await, "the connection is ended unread");
    engine.shutdown.cancel();
    task.abort();
}
