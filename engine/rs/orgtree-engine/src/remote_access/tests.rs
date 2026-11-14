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
use super::lifecycle::{self, Reading};
use super::limiter::Limits;
use super::member::{self, Standing, Verdict};
use super::registry::{self, Admitted, Registry};
use super::text;
use super::RemoteAccess;
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
        // This computer is taken to have a Tailscale address, one that is not really its own: the owner's
        // routes then find a way in, and nothing is ever bound outside loopback by a test.
        engine.access.doors.fix(Reading { tailscale: Some("100.64.0.1".parse().ok()), ..Reading::default() });
        // these tests refuse on purpose, many times from one address: only the limiter's own test counts
        engine.access.limiter.set(Limits { strikes: usize::MAX, window: Duration::from_secs(60), block: Duration::from_secs(60) });
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
        self.engine.access.set_open(&uuid, true).unwrap();
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

    /// One request as this desktop's own app makes it: its token, on its own listener.
    async fn owner(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        self.call(self.app, method, path, &[(crate::http::TOKEN_HEADER, DESKTOP_TOKEN)], body).await
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
    let got = host.call(host.door, "GET", "/api/remotes", &[("authorization", bearer.as_str()), (crate::http::TOKEN_HEADER, DESKTOP_TOKEN)], None).await;
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
    host.engine.access.set_open(&galaxy, false).unwrap();
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
        ("GET", "/api/accounts/readout"), ("POST", "/api/accounts"), ("DELETE", "/api/accounts/claude-1"), ("GET", "/api/accounts/claude-1/identity"),
        ("PUT", "/api/accounts/claude-1/enabled"), ("POST", "/api/accounts/keys"), ("PUT", "/api/openrouter/key"),
        ("GET", "/api/app-settings/instructions"), ("PUT", "/api/app-settings/instructions"), ("PUT", "/api/app-settings/runtime"),
        ("PUT", "/api/defaults"), ("POST", "/api/defaults"), ("POST", "/api/langservers"), ("PUT", "/api/providers/claude/enabled"),
        ("PUT", "/api/charters/lead"), ("POST", "/api/charters/open"), ("POST", "/api/templates/open"), ("POST", "/api/fs"),
        ("GET", "/api/desktop/status"), ("POST", "/api/desktop/shutdown"), ("GET", "/api/desktop/phone"), ("POST", "/api/desktop/phone/code"),
        ("GET", "/api/desktop/identity"), ("GET", "/api/diagnostics/engine-stats"), ("GET", "/api/crash-reports"),
        ("GET", "/api/remotes"), ("POST", "/api/remotes"), ("DELETE", "/api/remotes/r1"), ("PUT", "/api/remotes/shown-as"),
        ("POST", "/api/mcp"), ("POST", "/api/app/records"), ("GET", "/api/usage"), ("GET", "/api/app-settings/live-feed/tokens"),
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
    host.engine.access.set_open(&galaxy, false).unwrap();
    for (method, path) in [("GET", "/api/orgs/galaxy/records"), ("GET", "/api/orgs/galaxy"), ("POST", "/api/orgs/galaxy/nodes/1/message"), ("GET", "/api/orgs/galaxy/no-such-route")] {
        let got = host.door(method, path, &token, Some(json!({}))).await;
        assert_eq!((got.0, got.1["code"].as_str()), (403, Some(text::E16)), "{method} {path}: {got:?}");
    }
    // the computer itself is still known, and its record is still there
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);
    assert_eq!(host.engine.access.registry.rows(Some(&galaxy)).len(), 1);
    // switched on again, it opens again: nothing had to be added a second time
    host.engine.access.set_open(&galaxy, true).unwrap();
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
    host.engine.access.set_open(&galaxy, false).unwrap();
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

// ------------------------------------------------------------ the owner's routes (the switch, codes, computers, the port)

const OWNER_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/remote-access"), ("PUT", "/api/remote-access"), ("POST", "/api/remote-access/stop"),
    ("GET", "/api/remote-access/orgs/galaxy"), ("PUT", "/api/remote-access/orgs/galaxy"),
    ("POST", "/api/remote-access/orgs/galaxy/invitations"), ("DELETE", "/api/remote-access/orgs/galaxy/invitations/{id}"),
    ("PUT", "/api/remote-access/orgs/galaxy/computers/{id}"), ("DELETE", "/api/remote-access/computers/{id}"),
];

/// A body each of the owner's routes would take, so a refusal is the guard's and not the body's.
fn owner_body(method: &str, path: &str) -> Option<Value> {
    match (method, path) {
        ("PUT", "/api/remote-access") => Some(json!({ "lan": true })),
        ("PUT", "/api/remote-access/orgs/galaxy") => Some(json!({ "on": false })),
        _ => None,
    }
}

#[tokio::test]
async fn the_owner_switches_an_organization_on_lets_a_computer_in_and_takes_it_out_again() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.org(7, "galaxy");
    let other = host.org(8, "other");
    let len = |view: &Value, list: &str| view[list].as_array().map(Vec::len);

    // off by default: nothing is shared and no code can be made
    let (status, view) = host.owner("GET", "/api/remote-access/orgs/galaxy", None).await;
    assert_eq!((status, view["on"].as_bool(), len(&view, "computers")), (200, Some(false), Some(0)), "{view}");
    let refused = host.owner("POST", "/api/remote-access/orgs/galaxy/invitations", None).await;
    assert_eq!((refused.0, refused.1["detail"].as_str()), (409, Some(text::TURN_ON_FIRST)));

    // the switch
    let (status, view) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await;
    assert_eq!((status, view["on"].as_bool()), (200, Some(true)), "{view}");
    assert!(host.engine.access.is_open(&galaxy) && !host.engine.access.is_open(&other));

    // a code: in the answer that made it, and nowhere else
    let (status, made) = host.owner("POST", "/api/remote-access/orgs/galaxy/invitations", None).await;
    assert_eq!(status, 200, "{made}");
    let code = made["code"].as_str().unwrap().to_string();
    assert_eq!((code.len(), made["minutes"].as_i64()), (registry::CODE_LENGTH, Some(registry::INVITATION_MINUTES)));
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/galaxy", None).await;
    assert_eq!((len(&view, "invitations"), &view["invitations"][0]["id"]), (Some(1), &made["id"]), "{view}");
    assert!(!view.to_string().contains(&code), "{view}");

    // the other computer comes in with it, and the owner sees it in the list
    let (status, computer) = host.door("POST", "/api/standalone/clients", &code, Some(json!({ "name": PC }))).await;
    assert_eq!(status, 200, "{computer}");
    let (id, token) = (computer["id"].as_str().unwrap().to_string(), computer["token"].as_str().unwrap().to_string());
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/galaxy", None).await;
    assert_eq!((len(&view, "invitations"), len(&view, "computers"), len(&view, "known")), (Some(0), Some(1), Some(0)), "{view}");
    let row = &view["computers"][0];
    assert_eq!((row["id"].as_str(), row["name"].as_str(), row["label"].as_str()), (Some(id.as_str()), Some(PC), Some("PC-DANA")), "{row}");
    assert_eq!(row["orgs"], json!(["galaxy"]), "{row}");
    assert!(row["last_seen_at"].is_string() && row["created_at"].is_string(), "{row}");
    assert!(!view.to_string().contains(&token) && !view.to_string().contains("hash"), "{view}");

    // a second organization is given to a computer that is known, with no code, once its switch is on
    let give = format!("/api/remote-access/orgs/other/computers/{id}");
    let refused = host.owner("PUT", &give, None).await;
    assert_eq!((refused.0, refused.1["detail"].as_str()), (409, Some(text::TURN_ON_FIRST)));
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/other", None).await;
    assert_eq!((len(&view, "computers"), len(&view, "known"), view["known"][0]["id"].as_str()), (Some(0), Some(1), Some(id.as_str())), "{view}");
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/other", Some(json!({ "on": true }))).await.0, 200);
    let (status, view) = host.owner("PUT", &give, None).await;
    assert_eq!((status, len(&view, "computers"), len(&view, "known")), (200, Some(1), Some(0)), "{view}");
    assert_eq!(view["computers"][0]["orgs"], json!(["galaxy", "other"]), "{view}");
    assert_ne!(host.door("GET", "/api/orgs/other/records", &token, None).await.0, 403);
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/other/computers/no-such-computer", None).await.0, 404);

    // everything at a glance
    let (status, all) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!((status, all["port"].as_u64(), all["lan"].as_bool()), (200, Some(7431), Some(false)), "{all}");
    assert!(all["computer"].as_str().is_some_and(|name| !name.is_empty()), "{all}");
    // (who is connected at this instant is its own test: a connection that just answered may not be gone yet)
    let orgs: Vec<(String, bool, u64)> = all["orgs"].as_array().unwrap().iter()
        .map(|org| (org["slug"].as_str().unwrap().to_string(), org["on"].as_bool().unwrap(), org["computers"].as_u64().unwrap())).collect();
    assert_eq!(orgs, vec![("galaxy".to_string(), true, 1), ("other".to_string(), true, 1)], "{all}");

    // a code can be taken back, through its own organization's route only
    let (_, made) = host.owner("POST", "/api/remote-access/orgs/other/invitations", None).await;
    let (taken, back) = (made["code"].as_str().unwrap().to_string(), format!("/api/remote-access/orgs/other/invitations/{}", made["id"].as_str().unwrap()));
    assert_eq!(host.owner("DELETE", &back.replace("/other/", "/galaxy/"), None).await.0, 404);
    let (status, view) = host.owner("DELETE", &back, None).await;
    assert_eq!((status, len(&view, "invitations")), (200, Some(0)), "{view}");
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &taken, None).await));
    let again = host.owner("DELETE", &back, None).await;
    assert_eq!((again.0, again.1["detail"].as_str()), (404, Some(text::NO_CODE)));

    // off: closed to the computer at once, the codes that were open for it are gone, its record stays
    let (_, made) = host.owner("POST", "/api/remote-access/orgs/galaxy/invitations", None).await;
    let open_code = made["code"].as_str().unwrap().to_string();
    let (status, view) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await;
    assert_eq!((status, view["on"].as_bool(), len(&view, "computers"), len(&view, "invitations")), (200, Some(false), Some(1), Some(0)), "{view}");
    let closed = host.door("GET", "/api/orgs/galaxy/records", &token, None).await;
    assert_eq!((closed.0, closed.1["code"].as_str()), (403, Some(text::E16)), "{closed:?}");
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &open_code, None).await));
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await.0, 200);
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &open_code, None).await), "switching on again brings no code back");
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await.0, 200);

    // what the owner chose is in the file: a restart shares what was shared and nothing else
    let restarted = RemoteAccess::open(&root.0);
    assert!(!restarted.is_open(&galaxy) && restarted.is_open(&other));
    assert_eq!(restarted.registry.rows(Some(&galaxy)).len(), 1);

    // revoke: gone from every organization it had, at once
    let revoke = format!("/api/remote-access/computers/{id}");
    let (status, gone) = host.owner("DELETE", &revoke, None).await;
    assert_eq!((status, gone["revoked"].as_str()), (200, Some(id.as_str())), "{gone}");
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &token, None).await));
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/other", None).await;
    assert_eq!((len(&view, "computers"), len(&view, "known")), (Some(0), Some(0)), "{view}");
    let again = host.owner("DELETE", &revoke, None).await;
    assert_eq!((again.0, again.1["detail"].as_str()), (404, Some(text::NO_COMPUTER)));
}

#[tokio::test]
async fn only_this_desktop_itself_reaches_the_owners_routes() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let (id, token) = host.let_in(&galaxy, PC).await;
    let code = host.code(&galaxy);

    for (method, route) in OWNER_ROUTES {
        let path = route.replace("{id}", &id);
        let body = owner_body(method, route);
        // a computer that was let in, a one-time code, and nobody at all, at the door
        let got = host.door(method, &path, &token, body.clone()).await;
        assert!(refused_as_not_yours(&got), "a member, {method} {path}: {got:?}");
        let got = host.door(method, &path, &code, body.clone()).await;
        assert!(refused_as_not_yours(&got), "a code, {method} {path}: {got:?}");
        let got = host.call(host.door, method, &path, &[], body.clone()).await;
        assert!(refused_for_its_token(&got), "nobody, {method} {path}: {got:?}");
        // the app's own listener without the app's own token, and with a door token in its place
        for headers in [vec![], vec![("authorization", format!("Bearer {token}"))], vec![(crate::http::TOKEN_HEADER, token.clone())]] {
            let headers: Vec<(&str, &str)> = headers.iter().map(|(name, value)| (*name, value.as_str())).collect();
            let got = host.call(host.app, method, &path, &headers, body.clone()).await;
            assert_eq!((got.0, got.1["detail"].as_str()), (403, Some("desktop token required")), "{method} {path} with {headers:?}");
        }
    }
    // nothing was changed by any of it
    assert!(host.engine.access.is_open(&galaxy));
    assert_eq!(host.engine.access.registry.listening(), (registry::DEFAULT_PORT, false));
    assert!(host.engine.access.registry.row(&id).is_some());
    assert_eq!(host.engine.access.registry.invitations(&galaxy).len(), 1);

    // an organization that is not this computer's own cannot be shared on
    for (method, path) in [("GET", "/api/remote-access/orgs/no-such-org"), ("PUT", "/api/remote-access/orgs/no-such-org"), ("POST", "/api/remote-access/orgs/no-such-org/invitations")] {
        assert_eq!(host.owner(method, path, Some(json!({ "on": true }))).await.0, 404, "{method} {path}");
    }

    // an engine that runs by itself has client tokens for this, and none of these routes
    let far_root = Root::new();
    let far = crate::remote::testkit::RealFar::start(&far_root).await;
    for (method, route) in OWNER_ROUTES {
        let path = route.replace("{id}", &id);
        let got = far.call(method, &path, crate::remote::testkit::BOOTSTRAP, owner_body(method, route), &[]).await;
        assert_eq!((got.0, got.1["detail"].as_str()), (404, Some(text::NOT_A_DESKTOP)), "{method} {path}");
    }
}

#[tokio::test]
async fn stopping_all_remote_access_closes_everything_and_keeps_the_computers() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let other = host.shared(8, "other");
    let (_, dana_token) = host.let_in(&galaxy, PC).await;
    let (_, sam_token) = host.let_in(&other, "Orgtree desktop (PC-SAM)").await;
    let code = host.code(&galaxy);
    let mut danas = kept(host.door, &dana_token).await;
    let mut sams = kept(host.door, &sam_token).await;

    let (status, all) = host.owner("POST", "/api/remote-access/stop", None).await;
    assert_eq!(status, 200, "{all}");
    assert!(all["orgs"].as_array().unwrap().iter().all(|org| org["on"] == false && org["computers"] == 1), "{all}");
    assert!(ended(&mut danas).await && ended(&mut sams).await, "every connection ends");
    assert!(!host.engine.access.is_open(&galaxy) && !host.engine.access.is_open(&other) && !host.engine.access.any_open());
    for (token, slug) in [(&dana_token, "galaxy"), (&sam_token, "other")] {
        let got = host.door("GET", &format!("/api/orgs/{slug}/records"), token, None).await;
        assert_eq!((got.0, got.1["code"].as_str()), (403, Some(text::E16)), "{slug}: {got:?}");
    }
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &code, None).await), "an open code is taken back");
    assert_eq!(host.engine.access.registry.rows(None).len(), 2, "the computers are still known");
    // stopping when nothing is shared is no error
    assert_eq!(host.owner("POST", "/api/remote-access/stop", None).await.0, 200);
}

#[tokio::test]
async fn the_doors_port_and_the_private_network_choice_are_the_owners_and_are_kept() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let (status, all) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!((status, all["port"].as_u64(), all["default_port"].as_u64(), all["lan"].as_bool()), (200, Some(7431), Some(7431), Some(false)), "{all}");
    for bad in [json!({ "port": 80 }), json!({ "port": 1023 }), json!({ "port": 65536 }), json!({ "port": "7431" }), json!({ "port": -1 }),
                json!({ "lan": "yes" }), json!({ "address": "0.0.0.0" })] {
        let got = host.owner("PUT", "/api/remote-access", Some(bad.clone())).await;
        assert!(got.0 == 400 || got.0 == 422, "{bad}: {got:?}");
    }
    assert_eq!(host.engine.access.registry.listening(), (7431, false));
    let (status, all) = host.owner("PUT", "/api/remote-access", Some(json!({ "port": 7440 }))).await;
    assert_eq!((status, all["port"].as_u64(), all["lan"].as_bool()), (200, Some(7440), Some(false)), "{all}");
    let (status, all) = host.owner("PUT", "/api/remote-access", Some(json!({ "lan": true }))).await;
    assert_eq!((status, all["port"].as_u64(), all["lan"].as_bool()), (200, Some(7440), Some(true)), "{all}");
    let saved: Value = serde_json::from_slice(&std::fs::read(root.0.join(registry::FILE)).unwrap()).unwrap();
    assert_eq!((saved["port"].as_u64(), saved["lan"].as_bool()), (Some(7440), Some(true)), "{saved}");
    assert_eq!(RemoteAccess::open(&root.0).registry.listening(), (7440, true));
}

#[tokio::test]
async fn an_address_that_is_refused_too_often_is_shut_to_guesses_and_never_to_a_token_the_door_knows() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let (_, token) = host.let_in(&galaxy, PC).await;
    host.engine.access.limiter.set(Limits { strikes: 3, window: Duration::from_secs(60), block: Duration::from_millis(500) });

    // what a computer that was let in is refused is not counted
    for _ in 0..6 {
        assert!(refused_as_not_yours(&host.door("GET", "/api/remotes", &token, None).await));
    }
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);

    // a token the door does not know is; the third closes the door to this address
    for n in 1..=3 {
        let got = host.door("GET", "/api/desktop/alive", "a-guess", None).await;
        assert!(refused_for_its_token(&got), "refusal {n}: {got:?}");
    }
    // every further guess is answered 429, and so is a request with no token and a page's
    let closed = |got: &(u16, Value)| (got.0, got.1["detail"].as_str()) == (429, Some(text::TOO_MANY_TRIES));
    assert!(closed(&host.door("GET", "/api/desktop/alive", "another-guess", None).await));
    assert!(closed(&host.call(host.door, "GET", "/api/desktop/alive", &[], None).await));
    let page = [("authorization", format!("Bearer {token}")), ("origin", "https://example.com".to_string())];
    let page: Vec<(&str, &str)> = page.iter().map(|(name, value)| (*name, value.as_str())).collect();
    assert!(closed(&host.call(host.door, "GET", "/api/desktop/alive", &page, None).await));
    // A computer that was let in is not shut out by somebody else's guessing: behind an SSH
    // tunnel, a local https proxy or a shared router every caller has this one address.
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200, "a known token is heard while the address is closed");
    assert!(refused_as_not_yours(&host.door("GET", "/api/remotes", &token, None).await), "and is held to what is its own, as ever");
    // a one-time code too: the next computer can still be let in
    assert_eq!(host.door("GET", "/api/desktop/alive", &host.code(&galaxy), None).await.0, 200);
    // and the address is still closed to guesses after that
    assert!(closed(&host.door("GET", "/api/desktop/alive", "a-third-guess", None).await));
    // the app's own listener is not the door
    assert_eq!(host.owner("GET", "/api/desktop/alive", None).await.0, 200);
    // and after its while the address is heard again
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(host.door("GET", "/api/desktop/alive", &token, None).await.0, 200);
}

#[tokio::test]
async fn a_registry_file_is_taken_as_a_whole_with_its_switches_and_its_port() {
    // a file without the newer members reads with what a fresh one has: nothing shared, the usual port
    let root = Root::new();
    std::fs::write(root.0.join(registry::FILE), r#"{"version":1,"clients":[],"invitations":[]}"#).unwrap();
    let registry = Registry::open(&root.0);
    assert_eq!((registry.listening(), registry.open_orgs().len()), ((registry::DEFAULT_PORT, false), 0));
    assert!(root.0.join(registry::FILE).exists());

    let org = org_id();
    for broken in [format!(r#"{{"version":1,"port":80,"clients":[],"invitations":[]}}"#),
                   format!(r#"{{"version":1,"open":["galaxy"],"clients":[],"invitations":[]}}"#),
                   format!(r#"{{"version":1,"open":["{org}","{org}"],"clients":[],"invitations":[]}}"#),
                   format!(r#"{{"version":1,"lan":"yes","clients":[],"invitations":[]}}"#)] {
        let root = Root::new();
        std::fs::write(root.0.join(registry::FILE), &broken).unwrap();
        let registry = Registry::open(&root.0);
        assert!(registry.is_empty() && registry.open_orgs().is_empty(), "{broken}");
        assert!(!root.0.join(registry::FILE).exists(), "set aside: {broken}");
    }

    // the switch is the registry's: on, off, and what going off takes with it
    let root = Root::new();
    let registry = Registry::open(&root.0);
    assert!(registry.set_open("galaxy", true).is_err(), "an organization is named by its uuid");
    assert_eq!(registry.set_open(&org, true).unwrap(), true);
    assert_eq!(registry.set_open(&org, true).unwrap(), false, "already on");
    let code = registry.invite(&org).unwrap()["code"].as_str().unwrap().to_string();
    let made = registry.redeem(&code, PC).unwrap().unwrap();
    registry.invite(&org).unwrap();
    assert_eq!(registry.set_open(&org, false).unwrap(), true);
    assert!(registry.invitations(&org).is_empty() && registry.rows(Some(&org)).len() == 1);
    let reopened = Registry::open(&root.0);
    assert!(!reopened.is_open(&org) && reopened.row(made["id"].as_str().unwrap()).is_some());
    // an organization that is gone is shared with nobody
    reopened.set_open(&org, true).unwrap();
    reopened.forget_org(&org).unwrap();
    assert!(reopened.is_empty() && !reopened.is_open(&org));
}

// ------------------------------------------------------------ F-T1: where the door stands, and when

/// A port nothing listens on now.
async fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port()
}

async fn listens(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// Wait until something does, or does no longer, listen at a port.
async fn until_listening(port: u16, wanted: bool) -> bool {
    for _ in 0..100 {
        if listens(port).await == wanted {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test]
async fn the_door_stands_only_while_something_is_shared_and_follows_what_the_owner_changes() {
    let root = Root::new();
    let engine = Engine::for_tests(root.0.clone());
    let access = &engine.access;
    let (first, second, taken) = (free_port().await, free_port().await, free_port().await);
    let here: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    // this computer itself stands in for its Tailscale address (the rig's rule; `plan` never names loopback)
    access.doors.fix(Reading { rig: Some(here), ..Reading::default() });
    access.registry.set_listening(Some(first), None).unwrap();
    let org = org_id();
    let standing = || access.doors.standing().iter().map(|want| want.at.port()).collect::<Vec<_>>();

    // nothing is shared: there is no door
    lifecycle::refresh(&engine).await;
    assert!(standing().is_empty() && !listens(first).await);
    assert_eq!(lifecycle::status(&engine)["state"], "closed");

    // an organization is shared: the door stands at once, and takes a code
    access.registry.set_open(&org, true).unwrap();
    lifecycle::refresh(&engine).await;
    assert_eq!(standing(), vec![first]);
    let status = lifecycle::status(&engine);
    assert_eq!((status["state"].as_str(), status["addresses"][0]["port"].as_u64(), status["addresses"][0]["kind"].as_str()), (Some("open"), Some(first as u64), Some("rig")), "{status}");
    let code = access.registry.invite(&org).unwrap()["code"].as_str().unwrap().to_string();
    let http = reqwest::Client::builder().no_proxy().pool_max_idle_per_host(0).build().unwrap();
    let alive = |port: u16, token: String| { let http = http.clone(); async move {
        http.get(format!("http://127.0.0.1:{port}/api/desktop/alive")).bearer_auth(token).send().await.map(|answer| answer.status().as_u16()).ok()
    } };
    assert_eq!(alive(first, code.clone()).await, Some(200), "it is the door: a code is a token there");
    assert_eq!(alive(first, "the desktop's own token is not".into()).await, Some(403));
    // the same step again changes nothing
    lifecycle::refresh(&engine).await;
    assert_eq!(standing(), vec![first]);

    // the owner changes the port: the door moves at once
    access.registry.set_listening(Some(second), None).unwrap();
    lifecycle::refresh(&engine).await;
    assert_eq!(standing(), vec![second]);
    assert!(until_listening(first, false).await, "nothing listens at the old port any more");
    assert_eq!(alive(second, code.clone()).await, Some(200));

    // a port something else has: the door says so, and stands there as soon as the port is free
    let holder = TcpListener::bind(("127.0.0.1", taken)).await.unwrap();
    access.registry.set_listening(Some(taken), None).unwrap();
    lifecycle::refresh(&engine).await;
    assert!(standing().is_empty());
    let status = lifecycle::status(&engine);
    assert_eq!((status["state"].as_str(), status["reason"].as_str()), (Some("blocked"), Some(text::port_taken(taken).as_str())), "{status}");
    drop(holder);
    lifecycle::refresh(&engine).await;
    assert_eq!(standing(), vec![taken]);
    assert_eq!(lifecycle::status(&engine)["state"], "open");

    // everything is switched off: the door is gone
    access.registry.stop_all().unwrap();
    lifecycle::refresh(&engine).await;
    assert!(standing().is_empty());
    assert!(until_listening(taken, false).await);
    assert_eq!(lifecycle::status(&engine)["state"], "closed");
    engine.shutdown.cancel();
}

#[tokio::test]
async fn a_door_with_nowhere_to_stand_waits_and_says_why() {
    let root = Root::new();
    let engine = Engine::for_tests(root.0.clone());
    let org = org_id();
    engine.access.registry.set_open(&org, true).unwrap();
    // no Tailscale address and the private network not chosen
    engine.access.doors.fix(Reading { tailscale: Some(None), lan: "192.168.1.20".parse().ok(), ..Reading::default() });
    lifecycle::refresh(&engine).await;
    let status = lifecycle::status(&engine);
    assert_eq!((status["state"].as_str(), status["reason"].as_str()), (Some("waiting"), Some(text::NO_WAY_IN)), "{status}");
    assert!(engine.access.doors.standing().is_empty());
    // an address that is public is never one the door stands at, chosen or not
    engine.access.registry.set_listening(None, Some(true)).unwrap();
    engine.access.doors.fix(Reading { tailscale: Some("8.8.8.8".parse().ok()), lan: "8.8.4.4".parse().ok(), ..Reading::default() });
    lifecycle::refresh(&engine).await;
    let status = lifecycle::status(&engine);
    assert_eq!((status["state"].as_str(), status["reason"].as_str()), (Some("waiting"), Some(text::NO_WAY_IN_LAN)), "{status}");
    assert!(engine.access.doors.standing().is_empty());
}

#[tokio::test]
async fn a_switch_that_could_let_nobody_in_is_not_turned_on_and_says_why() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.org(7, "galaxy");
    let on = || host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true })));

    // Tailscale is not running and the private network was not chosen
    host.engine.access.doors.fix(Reading { tailscale: Some(None), lan: "192.168.1.20".parse().ok(), ..Reading::default() });
    let refused = on().await;
    assert_eq!((refused.0, refused.1["detail"].as_str()), (409, Some(text::NO_WAY_IN)), "{refused:?}");
    assert!(!host.engine.access.is_open(&galaxy));
    // the app can ask first, before it asks Windows for anything: the same sentence, and nothing changed
    let (status, asked) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert_eq!((status, asked["refusal"].as_str(), asked["on"].as_bool()), (200, Some(text::NO_WAY_IN), Some(false)), "{asked}");
    // a plain look reads no address, and says nothing of it
    let (_, plain) = host.owner("GET", "/api/remote-access/orgs/galaxy", None).await;
    assert!(plain.get("refusal").is_none(), "{plain}");
    // Tailscale did not answer: nothing is known, so nothing is promised
    host.engine.access.doors.fix(Reading { tailscale: None, ..Reading::default() });
    assert_eq!(on().await.0, 409);
    // the private network is chosen, and this computer has an address on one: now it can be
    assert_eq!(host.owner("PUT", "/api/remote-access", Some(json!({ "lan": true }))).await.0, 200);
    host.engine.access.doors.fix(Reading { tailscale: Some(None), ..Reading::default() });
    let refused = on().await;
    assert_eq!((refused.0, refused.1["detail"].as_str()), (409, Some(text::NO_WAY_IN_LAN)), "{refused:?}");
    host.engine.access.doors.fix(Reading { tailscale: Some(None), lan: "10.254.253.252".parse().ok(), ..Reading::default() });
    let (_, asked) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert!(asked.as_object().is_some_and(|view| view.get("refusal") == Some(&Value::Null)), "it could be turned on now: {asked}");
    let (status, view) = on().await;
    assert_eq!((status, view["on"].as_bool()), (200, Some(true)), "{view}");
    // the answer says where the door stands: here it cannot be bound (the address is not this computer's)
    assert!(matches!(view["door"]["state"].as_str(), Some("blocked" | "open")), "{view}");
    // switching off is never refused
    host.engine.access.doors.fix(Reading::default());
    let (status, view) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await;
    assert_eq!((status, view["on"].as_bool(), view["door"]["state"].as_str()), (200, Some(false), Some("closed")), "{view}");
}

/// Found by the rig proof of a hosting desktop (tools/rig/proofs/remote-host.mjs): the loop
/// rests a minute at a time while nothing is shared, and a switch that went on did not wake it,
/// so the chip and the `connected` records could be a minute late.
#[tokio::test]
async fn an_owners_change_wakes_the_doors_loop_out_of_its_idle_minute() {
    let root = Root::new();
    let host = Host::start(&root).await;
    host.org(7, "galaxy");
    // a way in exists (an address on a private network, by the owner's choice), so the switch can go on
    host.engine.access.registry.set_listening(None, Some(true)).unwrap();
    host.engine.access.doors.fix(Reading { tailscale: Some(None), lan: "10.254.253.252".parse().ok(), ..Reading::default() });
    // nothing is shared: the loop rests its idle minute
    let engine = host.engine.clone();
    let resting = tokio::spawn(async move { lifecycle::rest(&engine, Duration::from_secs(60)).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!resting.is_finished(), "nothing happened yet: the loop rests");
    // the owner turns a switch on
    let (status, view) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await;
    assert_eq!((status, view["on"].as_bool()), (200, Some(true)), "{view}");
    let woken = tokio::time::timeout(Duration::from_secs(5), resting).await;
    assert!(matches!(woken, Ok(Ok(true))), "an owner's change wakes the door's loop at once, not after its idle minute: {woken:?}");
    // a change while the loop is busy is kept for its next rest
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await.0, 200);
    let next = tokio::time::timeout(Duration::from_secs(5), lifecycle::rest(&host.engine, Duration::from_secs(60))).await;
    assert_eq!(next.ok(), Some(true), "a wake that found the loop busy is kept");
    // and with nothing new, the rest is as long as it was asked to be
    let quiet = tokio::time::timeout(Duration::from_millis(300), lifecycle::rest(&host.engine, Duration::from_secs(60))).await;
    assert!(quiet.is_err(), "nothing woke it: it rests");
}

#[tokio::test]
async fn the_owner_is_shown_who_is_connected_now() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    host.org(8, "other");
    let (id, token) = host.let_in(&galaxy, PC).await;
    let stream = kept(host.door, &token).await;
    let (status, all) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!(status, 200, "{all}");
    let org = |all: &Value, slug: &str| all["orgs"].as_array().unwrap().iter().find(|org| org["slug"] == slug).cloned().unwrap();
    let shown = org(&all, "galaxy");
    assert_eq!((shown["connected"].as_u64(), shown["computers"].as_u64()), (Some(1), Some(1)), "{all}");
    let who = &shown["connected_now"][0];
    assert_eq!((who["id"].as_str(), who["label"].as_str(), who["name"].as_str()), (Some(id.as_str()), Some("PC-DANA"), Some(PC)), "{all}");
    assert!(who["since"].is_string(), "{all}");
    assert_eq!(org(&all, "other")["connected"], 0, "{all}");
    assert!(all["door"]["state"].is_string(), "{all}");
    // it disconnects: nobody is connected any more
    drop(stream);
    let mut gone = false;
    for _ in 0..100 {
        let (_, all) = host.owner("GET", "/api/remote-access", None).await;
        gone = org(&all, "galaxy")["connected"] == 0;
        if gone { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(gone, "a computer whose connections ended is not shown as connected");
}

// ------------------------------------------------------------ F-T9, the engine's side: the firewall rules, read back

/// One line of the firewall read: a rule of the door's for this test program itself, which is
/// "the engine" here.
fn firewall_rule(kind: &str, port: u16) -> String {
    use base64::Engine as _;
    let program = std::env::current_exe().unwrap().to_string_lossy().to_string();
    format!("rule\t{kind}\tTrue\tInbound\tAllow\t{port}\t{}", base64::engine::general_purpose::STANDARD.encode(program))
}

#[tokio::test]
async fn the_owner_is_told_whether_windows_firewall_lets_the_door_in() {
    let root = Root::new();
    let host = Host::start(&root).await;
    host.org(7, "galaxy");
    let port = registry::DEFAULT_PORT;
    let firewall = |all: &Value| all["door"]["firewall"].clone();
    // The owner looks for the first time. The answer does not wait for a reading: nothing is known yet,
    // and nothing is claimed.
    host.engine.access.firewall.fix(Some("read"));
    let (status, all) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!((status, firewall(&all)), (200, json!({ "state": "unknown", "present": false })), "{all}");
    // The reading is made behind that answer, and a later look is answered with it: no rule of the door's.
    let mut seen = Value::Null;
    for _ in 0..200 {
        seen = firewall(&host.owner("GET", "/api/remote-access", None).await.1);
        if seen["state"] != "unknown" { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(seen, json!({ "state": "missing", "present": false }));
    // The desktop adds Tailscale's rule (one prompt). What is known is a moment old, and is not read again
    // by every look...
    host.engine.access.firewall.fix(Some(&format!("{}\nread", firewall_rule("tailscale", port))));
    assert_eq!(firewall(&host.owner("GET", "/api/remote-access", None).await.1)["state"], "missing");
    // ...so the app asks for a reading now, and its answer waits for it
    let (status, all) = host.owner("GET", "/api/remote-access?fresh=1", None).await;
    assert_eq!((status, firewall(&all)), (200, json!({ "state": "ok", "present": true })), "{all}");
    // an organization's own view says the same, and can be asked the same
    let (status, one) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert_eq!((status, firewall(&one)), (200, json!({ "state": "ok", "present": true })), "{one}");
    // The owner chooses the private network too: its rule is wanted from that moment, with no new reading
    let (_, all) = host.owner("PUT", "/api/remote-access", Some(json!({ "lan": true }))).await;
    assert_eq!(firewall(&all), json!({ "state": "missing", "present": true }), "{all}");
    host.engine.access.firewall.fix(Some(&format!("{}\n{}\nread", firewall_rule("tailscale", port), firewall_rule("lan", port))));
    assert_eq!(firewall(&host.owner("GET", "/api/remote-access?fresh=1", None).await.1)["state"], "ok");
    // Another port: the rules are for the old one, and let nobody reach the new one
    let (_, all) = host.owner("PUT", "/api/remote-access", Some(json!({ "port": 7440 }))).await;
    assert_eq!(firewall(&all), json!({ "state": "missing", "present": true }), "{all}");
    // The firewall cannot be read: nothing is claimed
    host.engine.access.firewall.fix(None);
    assert_eq!(firewall(&host.owner("GET", "/api/remote-access?fresh=1", None).await.1), json!({ "state": "unknown", "present": false }));
    // None of this is another computer's to ask: it is refused, and no reading is made for it
    let open = host.shared(8, "open");
    let (_, token) = host.let_in(&open, PC).await;
    host.engine.access.firewall.fix(Some("read"));
    for path in ["/api/remote-access?fresh=1", "/api/remote-access/orgs/open?fresh=1"] {
        assert!(refused_as_not_yours(&host.door("GET", path, &token, None).await), "{path}");
    }
    assert_eq!(host.engine.access.firewall.shown(7440, lifecycle::Listen { tailscale: true, lan: true, local: false }), json!({ "state": "unknown", "present": false }));
}

#[tokio::test]
async fn turning_a_switch_on_asks_windows_firewall_again() {
    let root = Root::new();
    let host = Host::start(&root).await;
    host.org(7, "galaxy");
    // what was known before: no rule of the door's
    host.engine.access.firewall.fix(Some("read"));
    let (_, one) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert_eq!(one["door"]["firewall"], json!({ "state": "missing", "present": false }), "{one}");
    // The desktop lets the door in (one prompt) and then asks for the switch: the answer is what
    // Windows Firewall says after it, with no "blocking" in between
    host.engine.access.firewall.fix(Some(&format!("{}\nread", firewall_rule("tailscale", registry::DEFAULT_PORT))));
    let (status, one) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await;
    assert_eq!((status, one["on"].as_bool(), &one["door"]["firewall"]), (200, Some(true), &json!({ "state": "ok", "present": true })), "{one}");
    // switched off again: the rules are still there, which the App settings page offers to take away
    let (_, one) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await;
    assert_eq!((one["on"].as_bool(), one["door"]["firewall"]["present"].as_bool()), (Some(false), Some(true)), "{one}");
}

// ------------------------------------------------------------ F-T5: what a member is sent

/// A socket of the engine's as another computer opens one at the door.
async fn door_socket(host: &Host, path: &str, token: &str) -> tokio_tungstenite::WebSocketStream<TcpStream> {
    use tokio_tungstenite::tungstenite::client::ClientRequestBuilder;
    let tcp = TcpStream::connect(host.door).await.unwrap();
    let uri: http::Uri = format!("ws://{}{path}", host.door).parse().unwrap();
    let request = ClientRequestBuilder::new(uri).with_header("authorization", format!("Bearer {token}"));
    tokio_tungstenite::client_async_with_config(request, tcp, None).await.expect("the door takes a member's socket").0
}

/// The frames of a socket up to and with the first one `wanted` picks.
async fn frames_until(socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>, wanted: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let frame: Value = serde_json::from_str(&crate::remote::testkit::next_text(socket).await.expect("a frame")).unwrap();
        let found = wanted(&frame);
        seen.push(frame);
        if found {
            return seen;
        }
    }
}

fn slugs_of(registry: &Value) -> Vec<String> {
    registry["records"].as_array().unwrap().iter().map(|record| record["body"]["slug"].as_str().unwrap().to_string()).collect()
}

fn keys_of(map: &Value) -> Vec<String> {
    let mut keys: Vec<String> = map.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[tokio::test]
async fn a_member_is_sent_its_organizations_and_no_others_and_no_address_of_the_owners() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    let other = host.shared(8, "other");
    host.org(9, "hidden");
    let (id, token) = host.let_in(&galaxy, PC).await;
    let app = &host.engine.app;
    // what the feed would have read from the database: three organizations, each with a summary and a notice
    let row = |id: i64, slug: &str, uuid: &str| json!({ "org_id": id, "slug": slug, "org_uuid": uuid, "state": "active" });
    app.test_registry(vec![row(7, "galaxy", &galaxy), row(8, "other", &other), row(9, "hidden", "uuid-of-hidden")]);
    let summary = |name: &str| json!({ "name": name });
    for (n, uuid, name) in [(7, galaxy.as_str(), "The galaxy organization"), (8, other.as_str(), "The other organization"), (9, "uuid-of-hidden", "The hidden organization")] {
        app.test_org(n, json!({ "uuid": uuid }), summary(name), json!([{ "text": format!("a notice in {name}") }]));
    }
    // this computer's values: a sign-in and an account with the owner's address and where else it is used,
    // and two that are nobody else's business at all
    crate::providers::set_agy_email(&host.engine, "sam@example.com");
    app.set_value("accounts", json!({ "accounts": [{ "id": "claude-1", "label": "sam@example.com", "identity": { "email": "sam@example.com" },
        "origin_org": "uuid-of-hidden", "bound": [{ "org": "The hidden organization", "agent": "lead" }] },
        { "id": "claude-2", "label": "unknown.to.the.engine@example.com", "identity": { "email": "unknown.to.the.engine@example.com" } }] }));
    app.set_value("remotes", json!([{ "id": "r1", "name": "An engine somewhere else" }]));
    lifecycle::publish(&host.engine);
    app.working(7, 1);
    app.working(8, 3);

    // control: this desktop's own app is sent all of it
    let mut mine = Value::Null;
    for _ in 0..300 {
        mine = host.owner("GET", "/api/app/records", None).await.1;
        let values = &mine["runtime"]["values"];
        if slugs_of(&mine["registry"]).len() == 3 && keys_of(&mine["summaries"]).len() == 3 && mine["runtime"]["orgs"]["8"].is_object()
            && values["accounts"].is_object() && values["remote_access"].is_object() && values["providers"].is_object() && values["remotes"].is_object() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let text = mine.to_string();
    for present in ["sam@example.com", "unknown.to.the.engine@example.com", "The hidden organization", "The other organization", "An engine somewhere else", "origin_org", "\"remote_access\""] {
        assert!(text.contains(present), "the owner's own snapshot holds {present}: {text}");
    }

    // the member's: its one organization, two values, and none of the rest
    let (status, theirs) = host.door("GET", "/api/app/records", &token, None).await;
    assert_eq!(status, 200, "{theirs}");
    assert_eq!(slugs_of(&theirs["registry"]), vec!["galaxy"]);
    assert_eq!((keys_of(&theirs["summaries"]), keys_of(&theirs["notices"]), keys_of(&theirs["runtime"]["orgs"])), (vec!["7".to_string()], vec!["7".to_string()], vec!["7".to_string()]), "{theirs}");
    assert_eq!(keys_of(&theirs["runtime"]["values"]), vec!["accounts", "providers"], "{theirs}");
    let text = theirs.to_string();
    for absent in ["@example.com", "The hidden organization", "The other organization", "uuid-of-hidden", other.as_str(), "An engine somewhere else", "\"origin_org\"", "\"bound\"", "\"remote_access\"", "\"remotes\""] {
        assert!(!text.contains(absent), "a member's snapshot holds {absent}: {text}");
    }
    let accounts = &theirs["runtime"]["values"]["accounts"]["value"]["accounts"];
    assert_eq!(accounts[0]["identity"]["email"], Value::Null, "{accounts}");
    assert!(accounts[0]["label"].is_string() && accounts[1]["label"].is_string(), "a label stays a text: {accounts}");

    // its socket: the same snapshot first
    let mut socket = door_socket(&host, "/api/app/ws", &token).await;
    let first = frames_until(&mut socket, |_| true).await.remove(0);
    assert_eq!((first["type"].as_str(), slugs_of(&first["registry"])), (Some("app_snapshot"), vec!["galaxy".to_string()]), "{first}");

    // the owner gives it a second organization: its feed says so, on the connection it has
    assert_eq!(host.owner("PUT", &format!("/api/remote-access/orgs/other/computers/{id}"), None).await.0, 200);
    let frames = frames_until(&mut socket, |frame| frame["type"] == "org_summary" && frame["org_id"] == 8).await;
    let registry = frames.iter().find(|frame| frame["type"] == "registry_snapshot").expect("its registry, again");
    assert_eq!(slugs_of(registry), vec!["galaxy", "other"]);
    assert_eq!(frames.last().unwrap()["body"]["name"], "The other organization");

    // a change in an organization it may not open is not sent to it; one in its own is
    app.test_org(9, json!({ "uuid": "uuid-of-hidden" }), summary("The hidden organization, renamed"), json!([]));
    app.working(9, 5);
    app.test_org(7, json!({ "uuid": galaxy }), summary("The galaxy organization, renamed"), json!([]));
    let frames = frames_until(&mut socket, |frame| frame["type"] == "org_summary" && frame["body"]["name"] == "The galaxy organization, renamed").await;
    assert_eq!(frames.last().unwrap()["org_id"], 7);
    assert!(frames.iter().all(|frame| frame["org_id"] != 9 && !frame.to_string().contains("hidden") && frame["orgs"]["9"].is_null()), "{frames:?}");

    // a value that is nobody else's is not pushed to it; one it gets comes without the address
    app.set_value("remotes", json!([{ "id": "r1", "name": "An engine somewhere else, renamed" }]));
    app.set_value("accounts", json!({ "accounts": [{ "id": "claude-1", "label": "sam@example.com", "bound": [{ "org": "The hidden organization" }] }] }));
    let frames = frames_until(&mut socket, |frame| frame["type"] == "app_runtime" && frame["values"]["accounts"].is_object()).await;
    let text = frames.iter().map(Value::to_string).collect::<String>();
    assert!(!text.contains("@example.com") && !text.contains("somewhere else") && !text.contains("hidden") && !text.contains("\"remotes\""), "{text}");

    // its organization is switched off: the connection ends (a member that comes back sees what is open then)
    host.engine.access.set_open(&galaxy, false).unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(2), async { while crate::remote::testkit::next_text(&mut socket).await.is_ok() {} }).await.is_ok();
    assert!(ended, "the socket of a computer whose organization was switched off ends");
    let (status, theirs) = host.door("GET", "/api/app/records", &token, None).await;
    assert_eq!((status, slugs_of(&theirs["registry"])), (200, vec!["other".to_string()]), "{theirs}");
}

#[tokio::test]
async fn an_answer_to_a_member_holds_no_address_of_the_owners() {
    let root = Root::new();
    let host = Host::start(&root).await;
    let galaxy = host.shared(7, "galaxy");
    // A text that is an address, in an answer that is not an organization's: here the name a computer gave
    // itself (an engine without a database has no account to show). The owner's own app reads it as it is.
    let (id, token) = host.let_in(&galaxy, "dana@example.com").await;
    let (status, mine) = host.owner("GET", "/api/remote-access/orgs/galaxy", None).await;
    assert_eq!((status, mine["computers"][0]["name"].as_str()), (200, Some("dana@example.com")), "{mine}");
    // the same record, read through the door by a computer that was let in: every answer to it passes the filter
    let (status, theirs) = host.door("GET", "/api/standalone/clients", &token, None).await;
    assert_eq!(status, 200, "{theirs}");
    assert_eq!((theirs["clients"][0]["id"].as_str(), theirs["clients"][0]["name"].as_str()), (Some(id.as_str()), Some("account")), "{theirs}");
    assert!(!theirs.to_string().contains("@example.com"), "{theirs}");
    assert_eq!(theirs["clients"][0].as_object().map(|o| o.len()), host.engine.access.registry.row(&id).unwrap().as_object().map(|o| o.len()), "nothing else was taken out");
    // and the reads a window needs are reads: none of them takes a write
    for (method, path) in [("POST", "/api/providers"), ("PUT", "/api/providers/claude/enabled"), ("POST", "/api/accounts"), ("DELETE", "/api/accounts/claude-1"),
                           ("POST", "/api/skills/refresh"), ("PUT", "/api/charters/lead"), ("POST", "/api/templates/resolve"), ("POST", "/api/defaults"),
                           ("POST", "/api/mcp-servers/refresh"), ("POST", "/api/app/records"), ("GET", "/api/orgs")] {
        let got = host.door(method, path, &token, Some(json!({}))).await;
        assert!(refused_as_not_yours(&got), "{method} {path}: {got:?}");
    }
    for path in ["/api/harnesses", "/api/skills", "/api/mcp-servers", "/api/defaults", "/api/fs"] {
        assert_ne!(host.door("GET", path, &token, None).await.0, 403, "{path} is a read a window needs");
    }
}

// ------------------------------------------------------------ F-T7: the connecting side

fn registry_row(id: i64, slug: &str, uuid: &str) -> Value {
    json!({ "org_id": id, "slug": slug, "org_uuid": uuid, "state": "active" })
}

/// Did a relayed request reach a handler of the hosting desktop? The door refuses with 403, an
/// unknown organization is 404, and the relay's own answers (not connected, no answer) name the
/// connection in `remote`. A handler of an engine without a database answers what it can (503
/// "organization feed unavailable"): that it answered at all is the point.
fn reached_a_handler(status: u16, body: &Value) -> bool {
    status != 403 && status != 404 && body.get("remote").is_none()
}

#[tokio::test]
async fn a_desktop_adds_a_hosting_desktop_with_a_code_and_works_in_what_it_was_given() {
    use crate::remote::testkit::Near;
    let (host_root, near_root) = (Root::new(), Root::new());
    let host = Host::start(&host_root).await;
    let galaxy = host.shared(7, "galaxy");
    let other = host.shared(8, "other");
    // what the hosting desktop's feed would have read from its database
    host.engine.app.test_registry(vec![registry_row(7, "galaxy", &galaxy), registry_row(8, "other", &other)]);
    for (n, uuid, name) in [(7, galaxy.as_str(), "Galaxy"), (8, other.as_str(), "Other")] {
        host.engine.app.test_org(n, json!({ "uuid": uuid }), json!({ "name": name }), json!([]));
    }
    let near = Near::start(&near_root).await;
    let url = format!("http://{}", host.door);
    let add = |token: String| near.call("POST", "/api/remotes", None, Some(json!({ "url": url, "token": token })));
    let connections = || async { near.call("GET", "/api/remotes", None, None).await.2["remotes"].as_array().cloned().unwrap_or_default() };

    // What is not a code of that desktop makes nothing and is not kept: neither a guess, nor the token
    // of a computer that is already in (pasting someone else's token must not make two computers one).
    let (_, known_token) = host.let_in(&galaxy, "Orgtree desktop (PC-KNOWN)").await;
    let (status, _, refused) = add("NOT-A-CODE-OF-THIS-DESKTOP".into()).await;
    assert_eq!((status, refused["code"].as_str()), (403, Some("E4")), "{refused}");
    let (status, _, refused) = add(known_token.clone()).await;
    assert_eq!((status, refused["code"].as_str(), refused["detail"].as_str()), (422, Some("E18"), Some(crate::remote::text::E18)), "{refused}");
    assert!(connections().await.is_empty(), "nothing was saved");
    assert_eq!(host.engine.access.registry.rows(None).len(), 1, "and nothing was made on the hosting desktop");
    assert_eq!(host.door("GET", "/api/desktop/alive", &known_token, None).await.0, 200, "the computer that is in is untouched");

    // a code: this desktop holds its own token from then on, for what the code was for
    let code = host.code(&galaxy);
    let (status, _, view) = add(code.clone()).await;
    assert_eq!(status, 200, "{view}");
    let id = view["id"].as_str().unwrap().to_string();
    assert_eq!((view["mode"].as_str(), view["scope"].as_str(), view["own_token"].as_bool()), (Some("host"), Some("member"), Some(true)), "{view}");
    assert_eq!(view["name"].as_str(), Some(host.engine.remotes.computer()), "it is called by the hosting computer's name");
    assert!(refused_for_its_token(&host.door("GET", "/api/desktop/alive", &code, None).await), "the code is used up");
    let saved = std::fs::read_to_string(near_root.0.join("remote-engines.json")).unwrap();
    assert!(!saved.contains(&code), "what was pasted is not what this desktop kept: {saved}");
    assert_eq!(serde_json::from_str::<Value>(&saved).unwrap()["remotes"][0]["mode"], "host", "{saved}");
    // the hosting desktop has the computer in its list
    let computer = host.engine.access.registry.rows(Some(&galaxy)).into_iter().find(|row| row["name"] != "Orgtree desktop (PC-KNOWN)").expect("the new computer");
    let computer_id = computer["id"].as_str().unwrap().to_string();
    assert!(computer["name"].as_str().is_some_and(|name| name.starts_with("Orgtree desktop (")), "{computer}");
    // a second use of the same code makes nothing
    let (status, _, refused) = add(code.clone()).await;
    assert_ne!(status, 200, "{refused}");

    // the link comes up and lists what this desktop was given, and nothing else of that desktop's
    near.state(&id, "connected", 5000).await;
    let aliases = |view: &Value| -> Vec<String> { view["orgs"].as_array().unwrap().iter().filter(|org| org["gone"] != true).map(|org| org["alias"].as_str().unwrap().to_string()).collect() };
    let mut view = Value::Null;
    for _ in 0..300 {
        view = near.view(&id).await;
        if aliases(&view) == vec!["galaxy"] { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(aliases(&view), vec!["galaxy"], "{view}");

    // a request of a window of that organization reaches the hosting desktop, as this desktop
    let (status, _, got) = near.call("GET", "/api/orgs/galaxy/records", None, None).await;
    assert!(reached_a_handler(status, &got), "{status}: {got}");
    // the organization it was not given is nothing this desktop knows of
    assert_eq!(near.call("GET", "/api/orgs/other/records", None, None).await.0, 404);

    // the owner gives it the second organization: it is in this desktop's list on the connection it has
    assert_eq!(host.owner("PUT", &format!("/api/remote-access/orgs/other/computers/{computer_id}"), None).await.0, 200);
    for _ in 0..300 {
        view = near.view(&id).await;
        if aliases(&view).len() == 2 { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(aliases(&view), vec!["galaxy", "other"], "{view}");
    let (status, _, got) = near.call("GET", "/api/orgs/other/records", None, None).await;
    assert!(reached_a_handler(status, &got), "{status}: {got}");

    // the owner switches galaxy off: a window of it is told so by the hosting desktop
    assert_eq!(host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": false }))).await.0, 200);
    let mut said = (0, Value::Null);
    for _ in 0..300 {
        let (status, _, body) = near.call("GET", "/api/orgs/galaxy/records", None, None).await;
        said = (status, body);
        if said.0 == 403 { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!((said.0, said.1["code"].as_str()), (403, Some(text::E16)), "{said:?}");
    assert!(said.1["detail"].as_str().is_some_and(|detail| detail.ends_with("no longer shares this organization.")), "{said:?}");
    // the other organization is still this desktop's to work in
    let mut answer = (0, Value::Null);
    for _ in 0..300 {
        let (status, _, body) = near.call("GET", "/api/orgs/other/records", None, None).await;
        answer = (status, body);
        // while the link comes back the relay itself answers
        if answer.1.get("remote").is_none() { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(reached_a_handler(answer.0, &answer.1), "{answer:?}");

    // removing the connection takes this desktop's own record off the hosting desktop, and no other
    assert_eq!(near.call("DELETE", &format!("/api/remotes/{id}"), None, None).await.0, 200);
    let mut gone = false;
    for _ in 0..300 {
        gone = host.engine.access.registry.row(&computer_id).is_none();
        if gone { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(gone, "this desktop's own computer record is removed there");
    assert_eq!(host.engine.access.registry.rows(None).len(), 1, "the other computer is still in");
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
    assert_eq!((member::READ.len(), member::OWN.len(), member::INVITATION.len()), (15, 3, 3));
    assert!(member::ORG.len() >= 100 && member::REFUSED.len() >= 90, "{} and {}", member::ORG.len(), member::REFUSED.len());
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

    // reads that are reads only: the organization itself, and what a window needs of the app
    for path in member::READ.iter().map(|route| fill(route, "galaxy")) {
        let path = path.as_str();
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
    // each listener of the running door takes the peers of its own place only
    use lifecycle::Kind;
    for (kind, takes) in [(Kind::Tailscale, "100.64.0.9"), (Kind::Lan, "192.168.1.30"), (Kind::Local, "127.0.0.1")] {
        for peer in ["100.64.0.9", "192.168.1.30", "127.0.0.1", "8.8.8.8"] {
            assert_eq!(PeerRule::only(kind).admits(ip(peer)), peer == takes, "{kind:?} and {peer}");
        }
    }
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

/// The address the owner's app is shown for the door, by kind.
fn door_addresses(shown: &Value) -> Vec<(String, String)> {
    shown["door"]["addresses"].as_array().map(|all| all.iter()
        .map(|a| (a["kind"].as_str().unwrap_or_default().to_string(), a["url"].as_str().unwrap_or_default().to_string())).collect()).unwrap_or_default()
}

// User ruling 2026-11-14: remote access is not limited to Tailscale. The door can listen on
// this computer itself, where an SSH tunnel or a local https proxy hands connections on.
#[tokio::test]
async fn the_door_listens_on_this_computer_itself_when_the_owner_chose_that() {
    let root = Root::new();
    let host = Host::start(&root).await;
    // a computer with no Tailscale and no network at all
    host.engine.access.doors.fix(Reading { tailscale: Some(None), ..Reading::default() });
    let galaxy = host.org(7, "galaxy");
    let port = free_port().await;

    // as it was: with Tailscale as the only place there is no way in
    let (status, refused) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await;
    assert_eq!(status, 409, "{refused}");

    let (status, shown) = host.owner("PUT", "/api/remote-access", Some(json!({ "port": port, "tailscale": false, "local": true }))).await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!((&shown["tailscale"], &shown["lan"], &shown["local"]), (&json!(false), &json!(false), &json!(true)));
    let (status, on) = host.owner("PUT", "/api/remote-access/orgs/galaxy", Some(json!({ "on": true }))).await;
    assert_eq!(status, 200, "{on}");
    let (_, shown) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!(shown["door"]["state"], "open", "{shown}");
    assert_eq!(door_addresses(&shown), vec![("local".to_string(), format!("http://127.0.0.1:{port}"))]);
    assert_eq!(shown["door"]["addresses"][0]["encrypted"], false);

    // a computer that was let in comes in there, and nobody without a token
    let (_, token) = host.let_in(&galaxy, PC).await;
    let at: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let bearer = format!("Bearer {token}");
    assert_eq!(host.call(at, "GET", "/api/desktop/alive", &[("authorization", &bearer)], None).await.0, 200);
    assert!(refused_for_its_token(&host.call(at, "GET", "/api/desktop/alive", &[], None).await));
    // the app's own token means nothing there: it is the door, not the app's listener
    assert!(refused_for_its_token(&host.call(at, "GET", "/api/desktop/alive", &[(crate::http::TOKEN_HEADER, DESKTOP_TOKEN)], None).await));

    // a choice of nowhere is refused, and the door stays
    let (status, refused) = host.owner("PUT", "/api/remote-access", Some(json!({ "local": false }))).await;
    assert_eq!((status, refused["detail"].as_str()), (400, Some("Choose at least one place for remote access to listen.")));
    assert!(listens(port).await);
    // the choice is kept in the file
    assert_eq!(RemoteAccess::open(&root.0).registry.listening(), (port, false));
    let (_, again) = host.owner("GET", "/api/remote-access", None).await;
    assert_eq!((&again["tailscale"], &again["local"]), (&json!(false), &json!(true)));
}

// The private network is a place of its own: it needs no Tailscale.
#[tokio::test]
async fn the_private_network_is_chosen_without_tailscale() {
    let root = Root::new();
    let host = Host::start(&root).await;
    host.org(7, "galaxy");
    host.engine.access.doors.fix(Reading { tailscale: Some(None), lan: "192.168.1.20".parse().ok(), ..Reading::default() });
    let refusal = |view: &Value| view["refusal"].as_str().map(str::to_string);

    // Tailscale is the place chosen and it is not running: the switch says so
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert!(refusal(&view).is_some_and(|why| why.starts_with("Tailscale is not running on this computer")), "{view}");

    let (status, shown) = host.owner("PUT", "/api/remote-access", Some(json!({ "tailscale": false, "lan": true }))).await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!((&shown["tailscale"], &shown["lan"], &shown["local"]), (&json!(false), &json!(true), &json!(false)));
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert_eq!(refusal(&view), None, "the private network is a way in by itself");

    // and without a network the sentence is about the network, not about Tailscale
    host.engine.access.doors.fix(Reading { tailscale: Some("100.64.0.1".parse().ok()), ..Reading::default() });
    let (_, view) = host.owner("GET", "/api/remote-access/orgs/galaxy?fresh=1", None).await;
    assert!(refusal(&view).is_some_and(|why| why.starts_with("This computer has no private network address")), "{view}");
}
