//! The remote-engine behaviour, end to end on loopback: this engine (`Near`)
//! with a desktop token, and a stand-in standalone engine (`Far`) or a real
//! one. Numbers T1..T15 are the tests of docs/rust-engine/remote-org.md;
//! T1, T2 and T5 live beside their code (`address`, `store`, `routes`).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::testkit::*;
use super::{relay, store, text, Timing};
use crate::engine::Engine;
use crate::mqtt::backoff::{Backoff, Waits};

/// A near engine, a far one with `acme` and `beta`, connected. Answers the
/// connection's id and the token this desktop made on the far engine.
async fn connected(near: &Near, far: &Far) -> (String, String) {
    let id = near.add(far).await["id"].as_str().unwrap().to_string();
    near.state(&id, "connected", 8000).await;
    let minted = far.state.clients.lock().unwrap()[0].2.clone();
    (id, minted)
}

fn local_org(near: &Near, id: i64, slug: &str) {
    near.engine.orgs.insert(crate::orgs::provisional(id, format!("u-local-{slug}"), slug.into(), slug.into()));
}

fn stamp(headers: &HeaderMap) -> String {
    headers["x-orgtree-instance"].to_str().unwrap().to_string()
}

// ------------------------------------------------------------------ T3

#[tokio::test]
async fn t3_adding_checks_the_address_the_token_the_engine_and_its_version_before_anything_is_saved() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let far = Far::start().await;
    let add = |url: String, token: &'static str| {
        let near = &near;
        async move {
            let (status, _, body) = near.call("POST", "/api/remotes", None, Some(json!({ "url": url, "token": token, "name": "Galaxy" }))).await;
            (status, body["code"].as_str().unwrap_or("").to_string(), body["detail"].as_str().unwrap_or("").to_string())
        }
    };
    // E1: not an http(s) address
    assert_eq!(add("ftp://engine.example".into(), BOOTSTRAP).await, (400, "E1".into(), text::E1.into()));
    // E2: plain http to a public address is refused before anything is dialed
    assert_eq!(add("http://203.0.113.9:7430".into(), BOOTSTRAP).await, (422, "E2".into(), text::E2.into()));
    assert_eq!(add(far.url(), "   ").await, (400, "".into(), text::TOKEN_MISSING.into()));
    // E3: nothing answers there
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    assert_eq!(add(format!("http://{closed}"), BOOTSTRAP).await, (502, "E3".into(), text::e3(&format!("http://{closed}"))));
    // E4: the engine does not take the token
    assert_eq!(add(far.url(), "wrong-token").await, (403, "E4".into(), text::E4.into()));
    // E6: a watch-only token
    far.state.viewer_tokens.lock().unwrap().push("viewer-token".into());
    assert_eq!(add(far.url(), "viewer-token").await, (422, "E6".into(), text::E6.into()));
    // E5: a desktop's own engine
    far.state.standalone.store(false, Ordering::SeqCst);
    assert_eq!(add(far.url(), BOOTSTRAP).await, (422, "E5".into(), text::E5.into()));
    far.state.standalone.store(true, Ordering::SeqCst);
    // E7: too old
    *far.state.version.lock().unwrap() = "4.5.10".into();
    assert_eq!(add(far.url(), BOOTSTRAP).await, (422, "E7".into(), text::e7("Galaxy", "4.5.10", "4.5.11")));
    *far.state.version.lock().unwrap() = env!("CARGO_PKG_VERSION").into();
    // E5b: what answers is this computer's own engine
    *far.state.data_root_id.lock().unwrap() = "near-root".into();
    assert_eq!(add(far.url(), BOOTSTRAP).await, (400, "E5b".into(), text::E5B.into()));
    *far.state.data_root_id.lock().unwrap() = "far-root".into();
    // none of that saved a connection or made a client token
    assert!(far.state.clients.lock().unwrap().is_empty());
    assert!(!root.0.join(store::FILE).exists());

    // success: this desktop makes its own named client token and keeps only that
    let view = near.add(&far).await;
    assert_eq!((view["name"].as_str(), view["tag"].as_str(), view["url"].as_str()), (Some("Galaxy"), Some("galaxy"), Some(far.url().as_str())));
    assert_eq!(view["own_token"], true);
    let (client_name, minted) = { let c = far.state.clients.lock().unwrap(); assert_eq!(c.len(), 1); (c[0].1.clone(), c[0].2.clone()) };
    assert!(client_name.starts_with("Orgtree desktop (") && client_name.ends_with(')'), "{client_name}");
    assert_eq!(view["client_name"], client_name);
    let file = std::fs::read_to_string(root.0.join(store::FILE)).unwrap();
    for secret in [BOOTSTRAP, minted.as_str()] {
        assert!(!file.contains(secret) && !view.to_string().contains(secret), "a token is in the file or the answer");
    }
    // the link speaks with its own token, never the pasted one
    let id = view["id"].as_str().unwrap().to_string();
    let view = near.state(&id, "connected", 8000).await;
    assert_eq!(far.state.last("/api/app/ws").unwrap().headers["authorization"], format!("Bearer {minted}"));
    assert_eq!((view["version"].as_str(), view["version_differs"].as_bool(), view["transport"].as_str()), (Some(env!("CARGO_PKG_VERSION")), Some(false), Some("loopback")));
    // E5c: the same engine a second time
    assert_eq!(add(far.url(), BOOTSTRAP).await, (400, "E5c".into(), text::e5c("Galaxy")));
    assert_eq!(far.state.clients.lock().unwrap().len(), 1, "a refused add leaves no client token behind");
}

#[tokio::test]
async fn t3_a_real_standalone_engine_takes_the_handshake_and_this_desktops_own_token() {
    let (near_root, far_root) = (Root::new(), Root::new());
    let near = Near::start(&near_root).await;
    // a real engine in standalone mode, served as client_tokens' tests serve it
    let mut far = Engine::for_tests(far_root.0.clone());
    let e = Arc::get_mut(&mut far).unwrap();
    e.cfg.standalone = true;
    e.cfg.desktop_token = BOOTSTRAP.into();
    e.cfg.data_root_id = "real-far-root".into();
    e.clients = Some(Arc::new(crate::client_tokens::Registry::open(&far_root.0).unwrap()));
    let (app, inbox) = crate::appfeed::AppFeed::new();
    e.app = app;
    crate::appfeed::start(&far, inbox);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::http::router(far.clone());
    let stop = far.shutdown.clone();
    let task = tokio::spawn(async move {
        axum::serve(crate::client_tokens::transport::ClientListener(listener),
            router.into_make_service_with_connect_info::<crate::client_tokens::transport::ClientInfo>())
            .with_graceful_shutdown(stop.cancelled_owned()).await.unwrap();
    });
    let url = format!("http://{address}");
    // the real engine's own refusal of a wrong token
    let (status, _, body) = near.call("POST", "/api/remotes", None, Some(json!({ "url": url, "token": "wrong" }))).await;
    assert_eq!((status, body["code"].as_str()), (403, Some("E4")), "{body}");
    let (status, _, view) = near.call("POST", "/api/remotes", None, Some(json!({ "url": url, "token": BOOTSTRAP }))).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!((view["own_token"].as_bool(), view["name"].as_str()), (Some(true), Some("127.0.0.1")));
    let clients = || far.clients.as_ref().unwrap().manage(&json!({ "action": "list" })).unwrap()["clients"].as_array().unwrap().clone();
    assert_eq!(clients().len(), 1);
    assert!(clients()[0]["name"].as_str().unwrap().starts_with("Orgtree desktop ("));
    // the link connects over the real app socket (this engine has no organizations)
    let id = view["id"].as_str().unwrap().to_string();
    let view = near.state(&id, "connected", 8000).await;
    assert_eq!((view["version"].as_str(), view["transport"].as_str(), view["orgs"].as_array().map(Vec::len)), (Some(env!("CARGO_PKG_VERSION")), Some("loopback"), Some(0)));
    // an engine route is answered by the real engine through the relay
    let (status, headers, body) = near.call("GET", "/api/standalone/clients", Some(&id), None).await;
    assert_eq!((status, body["clients"].as_array().map(Vec::len)), (200, Some(1)), "{body}");
    assert_eq!(stamp(&headers), "test~test", "both test engines call their process `test`");
    // removing the connection revokes this desktop's token on the real engine
    let (status, _, body) = near.call("DELETE", &format!("/api/remotes/{id}"), None, None).await;
    assert_eq!((status, body["revoked"].as_bool()), (200, Some(true)), "{body}");
    assert!(clients().is_empty());
    far.shutdown.cancel();
    task.abort();
}

// ------------------------------------------------------------------ T4

#[tokio::test]
async fn t4_an_organization_keeps_its_slug_when_free_takes_a_suffix_when_held_and_never_changes_it() {
    let root = Root::new();
    let near = Near::start(&root).await;
    local_org(&near, 7, "acme");
    let far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    let org = |view: &Value, slug: &str| view["orgs"].as_array().unwrap().iter().find(|o| o["remote_slug"] == slug)
        .map(|o| (o["alias"].as_str().unwrap().to_string(), o["local_id"].as_i64().unwrap(), o["gone"].as_bool().unwrap()));
    let view = near.view(&id).await;
    let (acme, beta) = (org(&view, "acme").unwrap(), org(&view, "beta").unwrap());
    assert_eq!((acme.0.as_str(), beta.0.as_str()), ("acme-galaxy", "beta"), "a held slug takes the connection's tag");
    assert!(acme.1 < 0 && beta.1 < 0 && acme.1 != beta.1, "local ids are negative and distinct: {acme:?} {beta:?}");
    // a local organization cannot take a name an alias holds
    let (status, _, body) = near.call("POST", "/api/orgs", None, Some(json!({ "name": "Beta" }))).await;
    assert_eq!((status, body["detail"].as_str()), (400, Some(text::alias_taken("beta", "Galaxy").as_str())));
    // deleted on the remote: it is marked gone and its alias stays reserved
    far.state.orgs.lock().unwrap().retain(|o| o.1 != "beta");
    far.state.push_registry();
    let mut view = Value::Null;
    for _ in 0..300 {
        view = near.view(&id).await;
        if org(&view, "beta").is_some_and(|o| o.2) { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(org(&view, "beta"), Some(("beta".into(), beta.1, true)));
    assert_eq!(near.engine.remotes.alias_holder("beta").as_deref(), Some("Galaxy"));
    // back on the remote, it is the same organization here: same alias, same id
    far.state.orgs.lock().unwrap().push((3, "beta".into(), "u-beta-again".into(), "Beta".into()));
    far.state.push_registry();
    for _ in 0..300 {
        view = near.view(&id).await;
        if org(&view, "beta").is_some_and(|o| !o.2) { break; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(org(&view, "beta"), Some(("beta".into(), beta.1, false)));
    // the file gives the next start the same names, ids and the token this desktop made
    let again = super::Remotes::open(&root.0);
    let saved = again.directory().remotes[0].saved();
    let names: Vec<(String, i64)> = saved.orgs.iter().map(|o| (o.alias.clone(), o.local_id)).collect();
    assert!(names.contains(&("acme-galaxy".into(), acme.1)) && names.contains(&("beta".into(), beta.1)), "{names:?}");
    assert_eq!(again.directory().remotes[0].token().expose(), minted);
}

// ------------------------------------------------------------------ T6

#[tokio::test]
async fn t6_a_request_goes_to_the_engine_it_belongs_to() {
    let root = Root::new();
    let near = Near::start(&root).await;
    local_org(&near, 7, "acme");
    local_org(&near, 8, "zeta");
    let far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    let carried = |needle: &str| far.state.seen.lock().unwrap().iter().filter(|s| s.target.starts_with(needle)).count();
    // an alias is carried under the organization's slug there, with the header or without
    let (status, headers, body) = near.call("GET", "/api/orgs/acme-galaxy", None, None).await;
    assert_eq!((status, body["far_slug"].as_str()), (200, Some("acme")));
    assert_eq!(stamp(&headers), "test", "the stamp follows the window (the header), not the path");
    let (status, _, body) = near.call("GET", "/api/orgs/beta", Some(&id), None).await;
    assert_eq!((status, body["far_slug"].as_str()), (200, Some("beta")));
    // with the header the organization's own slug there is its name: remote content names it so
    let (status, _, body) = near.call("GET", "/api/orgs/acme", Some(&id), None).await;
    assert_eq!((status, body["far_slug"].as_str()), (200, Some("acme")));
    // a remote window is never served a local organization
    let (status, _, body) = near.call("GET", "/api/orgs/zeta", Some(&id), None).await;
    assert_eq!((status, body["detail"].as_str()), (404, Some("no organization named zeta")));
    assert_eq!(carried("/api/orgs/zeta"), 0);
    // without the header a local organization is served here, whatever a remote calls its own
    let before = carried("/api/orgs/acme");
    let (status, _, body) = near.call("GET", "/api/orgs/acme", None, None).await;
    assert!(status != 200 && body["far_slug"].is_null(), "the local acme (no feed in this test) answered {status} {body}");
    assert_eq!(carried("/api/orgs/acme"), before);
    // an engine route goes to the remote from its window only
    let (status, _, body) = near.call("GET", "/api/accounts", Some(&id), None).await;
    assert_eq!((status, body[0]["id"].as_str()), (200, Some("far-account")));
    let before = carried("/api/accounts");
    let (_, _, body) = near.call("GET", "/api/accounts", None, None).await;
    assert!(body[0]["id"] != "far-account" && carried("/api/accounts") == before, "{body}");
    // this computer's routes never leave it
    let (status, _, body) = near.call("GET", "/api/desktop/alive", Some(&id), None).await;
    assert_eq!((status, body["dataRootId"].as_str()), (200, Some("near-root")));
    let (status, _, body) = near.call("GET", "/api/remotes", Some(&id), None).await;
    assert_eq!((status, body["remotes"][0]["id"].as_str()), (200, Some(id.as_str())));
    // an unknown connection is refused
    let (status, _, body) = near.call("GET", "/api/orgs/beta", Some("00000000-0000-0000-0000-000000000000"), None).await;
    assert_eq!((status, body["detail"].as_str()), (400, Some("unknown remote engine")));
    // without this desktop's token nothing is carried
    let before = far.state.seen.lock().unwrap().len();
    for token in [None, Some("wrong")] {
        let mut request = near.http.get(format!("http://{}/api/orgs/beta", near.address)).header(super::HEADER, &id);
        if let Some(token) = token {
            request = request.header(crate::http::TOKEN_HEADER, token);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status().as_u16(), 403);
        assert_eq!(stamp(response.headers()), "test", "an unauthenticated answer names this process only");
    }
    assert_eq!(far.state.seen.lock().unwrap().len(), before);
}

#[tokio::test]
async fn t6_a_standalone_engine_ignores_the_header_and_has_no_remote_engines() {
    let root = Root::new();
    let near = Near::start_with(&root, |e| e.cfg.standalone = true).await;
    for (method, path) in [("GET", "/api/remotes"), ("POST", "/api/remotes"), ("DELETE", "/api/remotes/x")] {
        let (status, _, body) = near.call(method, path, None, Some(json!({ "url": "http://127.0.0.1:1", "token": "t" }))).await;
        assert_eq!((status, body["detail"].as_str()), (404, Some(text::STANDALONE)), "{method} {path}");
    }
    let (status, headers, body) = near.call("GET", "/api/desktop/alive", Some("anything"), None).await;
    assert_eq!((status, body["dataRootId"].as_str(), stamp(&headers).as_str()), (200, Some("near-root"), "test"));
    let mut headers = HeaderMap::new();
    headers.insert(super::HEADER, HeaderValue::from_static("anything"));
    assert!(matches!(relay::decide(&near.engine, "/api/orgs/acme/ws", &headers), relay::Decision::Local));
    assert!(matches!(relay::decide(&near.engine, "/api/accounts", &headers), relay::Decision::Local));
}

// ------------------------------------------------------------------ T7

async fn raw_response(stream: &mut TcpStream) -> (u16, Vec<u8>) {
    let mut head = Vec::new();
    loop {
        head.push(tokio::time::timeout(Duration::from_secs(20), stream.read_u8()).await.unwrap().unwrap());
        assert!(head.len() < 64 * 1024);
        if head.ends_with(b"\r\n\r\n") { break; }
    }
    let head = String::from_utf8(head).unwrap();
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|n| n.trim().parse::<usize>().unwrap()))
        .expect("a relayed answer keeps its content-length");
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await.unwrap();
    (status, body)
}

#[tokio::test]
async fn t7_a_relayed_request_streams_both_ways_and_carries_the_remotes_token_only() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    // the query goes along, and conditional reads keep working
    let (status, headers, body) = near.call("GET", "/api/orgs/beta?view=delta&x=1", Some(&id), None).await;
    assert_eq!((status, body["far_slug"].as_str()), (200, Some("beta")));
    assert_eq!((headers["etag"].to_str().unwrap(), headers["x-orgtree-sync-rev"].to_str().unwrap()), ("\"far-e1\"", "7"));
    assert_eq!(far.state.last("/api/orgs/beta?").unwrap().target, "/api/orgs/beta?view=delta&x=1");
    let (status, headers, _) = near.call_with("GET", "/api/orgs/beta", Some(&id), None, &[("if-none-match", "\"far-e1\"")]).await;
    assert_eq!((status, headers["etag"].to_str().unwrap()), (304, "\"far-e1\""));
    // a change carries its body; the remote's own answer comes back
    let (status, _, body) = near.call_with("POST", "/api/orgs/beta/nodes/7/message", Some(&id), Some(json!({ "text": "hello" })),
        &[("cookie", "a=b"), ("origin", "http://127.0.0.1:1"), ("referer", "http://127.0.0.1:1/o/beta")]).await;
    assert_eq!((status, &body), (200, &json!({ "ok": true, "far_slug": "beta", "node": "7", "echo": { "text": "hello" } })));
    let seen = far.state.last("/nodes/7/message").unwrap();
    assert_eq!(seen.headers["authorization"], format!("Bearer {minted}"));
    for gone in ["x-orgtree-desktop-token", "cookie", "origin", "referer", "x-orgtree-remote"] {
        assert!(!seen.headers.contains_key(gone), "{gone} reached the remote");
    }
    assert!(!format!("{:?}", seen.headers).contains(DESKTOP_TOKEN));
    // a redirect is refused, never followed
    let (status, headers, body) = near.call("GET", "/api/orgs/beta/redirect", Some(&id), None).await;
    assert_eq!(status, 502, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("redirect") && headers.get("location").is_none());
    assert!(far.state.last("/landed").is_none());
    // the app media route carries its own ticket: no token goes along, and the remote sets no cookie here
    let media = near.http.get(format!("http://{}/api/orgs/beta/apps/media?ticket=t1", near.address)).header("origin", "null").send().await.unwrap();
    assert_eq!(media.status().as_u16(), 200);
    assert_eq!(media.headers()["access-control-allow-origin"], "null");
    assert!(media.headers().get("set-cookie").is_none());
    assert_eq!(media.text().await.unwrap(), "media");
    let seen = far.state.last("/apps/media").unwrap();
    assert!(!seen.headers.contains_key("authorization") && seen.headers["origin"] == "null");
    // an upload is carried as it arrives: the remote has the first part while this side still holds the rest
    const PART: usize = 1 << 20;
    const PARTS: usize = 64;
    let mut stream = TcpStream::connect(near.address).await.unwrap();
    stream.write_all(format!("POST /api/orgs/beta/nodes/7/upload HTTP/1.1\r\nHost: localhost\r\nX-Orgtree-Desktop-Token: {DESKTOP_TOKEN}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n", PART * PARTS).as_bytes()).await.unwrap();
    let part = vec![7u8; PART];
    for _ in 0..PARTS / 2 {
        stream.write_all(&part).await.unwrap();
    }
    assert!(until(10_000, || far.state.upload_bytes.load(Ordering::SeqCst) >= (8 * PART) as u64).await,
        "the remote saw {} bytes before the upload ended: the body was held, not streamed", far.state.upload_bytes.load(Ordering::SeqCst));
    for _ in 0..PARTS / 2 {
        stream.write_all(&part).await.unwrap();
    }
    let (status, body) = raw_response(&mut stream).await;
    assert_eq!((status, serde_json::from_slice::<Value>(&body).unwrap()), (200, json!({ "bytes": PART * PARTS })));
}

// ------------------------------------------------------------------ T8

#[tokio::test]
async fn t8_a_remote_window_is_stamped_with_both_processes() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    // one of this engine's own windows: this process alone
    assert_eq!(stamp(&near.call("GET", "/api/desktop/alive", None, None).await.1), "test");
    // a remote window: the same pair on what is carried and on what is answered here
    assert_eq!(stamp(&near.call("GET", "/api/orgs/beta", Some(&id), None).await.1), "test~far-boot-1");
    assert_eq!(stamp(&near.call("GET", "/api/desktop/alive", Some(&id), None).await.1), "test~far-boot-1");
    // an outage changes nothing: the window does not reload
    far.stop().await;
    near.state(&id, "offline", 5000).await;
    let (status, headers, _) = near.call("GET", "/api/orgs/beta", Some(&id), None).await;
    assert_eq!((status, stamp(&headers).as_str()), (503, "test~far-boot-1"));
    // the remote process was replaced: the stamp follows, so the window reloads
    *far.state.boot.lock().unwrap() = "far-boot-2".into();
    far.restart().await;
    near.state(&id, "connected", 8000).await;
    assert_eq!(stamp(&near.call("GET", "/api/desktop/alive", Some(&id), None).await.1), "test~far-boot-2");
    // and the next start of this engine knows it before its link is up
    assert!(until(3000, || std::fs::read_to_string(root.0.join(store::FILE)).unwrap().contains("far-boot-2")).await);
    assert_eq!(*super::Remotes::open(&root.0).directory().remotes[0].boot(), "far-boot-2");
}

// ------------------------------------------------------------------ T9

#[tokio::test]
async fn t9_the_org_socket_is_relayed_frame_for_frame() {
    let root = Root::new();
    let near = Near::start(&root).await;
    local_org(&near, 7, "acme");
    let far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    let mut socket = near.socket("/api/orgs/acme-galaxy/ws?win=w1", Some(&id)).await.unwrap();
    // the remote gets its own slug, the window's query and its own token
    let seen = far.state.last("/ws?win=w1").unwrap();
    assert_eq!((seen.target.as_str(), seen.headers["authorization"].as_str()), ("/api/orgs/acme/ws?win=w1", format!("Bearer {minted}").as_str()));
    for gone in ["x-orgtree-desktop-token", "origin", "x-orgtree-remote", "cookie"] {
        assert!(!seen.headers.contains_key(gone), "{gone} reached the remote");
    }
    // window -> remote, unchanged and in order
    say(&mut socket, r#"{"type":"watch","agents":["worker"]}"#).await;
    say(&mut socket, "ping").await;
    assert!(until(5000, || far.state.org_heard.lock().unwrap().len() == 2).await);
    assert_eq!(*far.state.org_heard.lock().unwrap(), [r#"{"type":"watch","agents":["worker"]}"#, "ping"]);
    // remote -> window, unchanged and in order
    for n in 0..50 {
        far.state.push_org(Some(&format!(r#"{{"type":"chat","node":"worker","n":{n}}}"#)));
    }
    for n in 0..50 {
        assert_eq!(next_text(&mut socket).await, Ok(format!(r#"{{"type":"chat","node":"worker","n":{n}}}"#)));
    }
    // the remote side closes: the window is told to try again
    far.state.push_org(None);
    assert_eq!(next_text(&mut socket).await, Err(Some(1013)));
    // only the org socket is relayed
    assert_eq!(near.socket("/api/orgs/acme-galaxy/apps/ws", Some(&id)).await.err(), Some(404));
    // an open socket ends when the user disconnects, and a new one is refused at once
    let mut open = near.socket("/api/orgs/beta/ws", Some(&id)).await.unwrap();
    let (status, _, _) = near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": false }))).await;
    assert_eq!(status, 200);
    assert_eq!(next_text(&mut open).await, Err(Some(1013)));
    near.state(&id, "paused", 5000).await;
    assert_eq!(near.socket("/api/orgs/beta/ws", Some(&id)).await.err(), Some(503));
}

#[tokio::test]
async fn t9_a_window_that_falls_behind_is_told_to_try_again() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let far = Far::start().await;
    // a queue of 8 frames here, 8192 in the product: the rule is the same
    near.engine.remotes.set_timing(Timing { socket_queue: 8, ..fast() });
    let (id, _) = connected(&near, &far).await;
    let mut socket = near.socket("/api/orgs/beta/ws", Some(&id)).await.unwrap();
    // the window reads nothing while the remote sends far more than a socket buffers
    let big = "x".repeat(256 * 1024);
    for _ in 0..400 {
        far.state.push_org(Some(&big));
    }
    assert!(until(20_000, || far.state.org_closed.load(Ordering::SeqCst) >= 1).await, "the relay never gave up on the slow window");
    // then it reads: what was already on its way, and the close that says "try again"
    let mut frames = 0;
    let end = loop {
        match next_text(&mut socket).await {
            Ok(_) => frames += 1,
            Err(code) => break code,
        }
    };
    assert_eq!(end, Some(1013));
    assert!(frames < 400, "all {frames} frames arrived: the queue never overflowed");
}

// ------------------------------------------------------------------ T10

#[test]
fn t10_the_retry_schedule_is_1_2_4_8_16_then_30_seconds() {
    let t = Timing::default();
    let waits = Waits { net_first: t.net_first, net_max: t.net_max, refused: &[t.auth_retry], stable: t.stable, jitter: false };
    let mut backoff = Backoff::default();
    let got: Vec<u64> = (0..8).map(|_| backoff.failed(false, &waits).as_secs()).collect();
    assert_eq!(got, [1, 2, 4, 8, 16, 30, 30, 30]);
    assert_eq!(backoff.failed(true, &waits).as_secs(), 300, "a refused token is tried again after five minutes");
    // spread by a fifth
    let spread = Waits { jitter: true, ..waits };
    for _ in 0..100 {
        let ms = Backoff::default().failed(false, &spread).as_millis();
        assert!((800..=1200).contains(&ms), "{ms}");
    }
    assert_eq!((t.ping.as_secs(), t.dead.as_secs(), t.request.as_secs(), t.socket_queue), (15, 45, 10, 8192));
}

#[tokio::test]
async fn t10_the_link_goes_offline_and_comes_back_by_itself() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    let stopped = tokio::time::Instant::now();
    far.stop().await;
    let view = near.state(&id, "offline", 2000).await;
    assert!(stopped.elapsed() < Duration::from_secs(2), "offline is known within two seconds of the socket closing");
    assert_eq!((view["last_error"].as_str(), view["error_code"].as_str()), (Some(text::e9("Galaxy").as_str()), Some("E9")));
    assert!(view["next_attempt_at"].is_string() && view["since"].is_string());
    // it stays "offline" while it retries, and its organizations stay known
    tokio::time::sleep(Duration::from_millis(300)).await;
    let view = near.view(&id).await;
    assert_eq!((view["state"].as_str(), view["orgs"].as_array().map(Vec::len)), (Some("offline"), Some(2)));
    far.restart().await;
    let view = near.state(&id, "connected", 8000).await;
    assert!(view["last_error"].is_null() && view["next_attempt_at"].is_null());
}

#[tokio::test]
async fn t10_a_revoked_token_a_pause_and_another_engine_each_have_their_state() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    let change = || near.call("POST", "/api/orgs/beta/nodes/7/message", Some(&id), Some(json!({ "text": "x" })));
    let refused = |answer: (u16, HeaderMap, Value)| (answer.0, answer.2["detail"].as_str().unwrap_or("").to_string(), answer.2["remote"]["state"].as_str().unwrap_or("").to_string());
    // the remote revokes this desktop's token: its sockets drop and the next try is refused
    far.state.revoke_all_clients();
    let view = near.state(&id, "auth_failed", 8000).await;
    assert_eq!((view["last_error"].as_str(), view["error_code"].as_str()), (Some(text::e10("Galaxy").as_str()), Some("E10")));
    assert_eq!(refused(change().await), (503, text::e10("Galaxy"), "auth_failed".into()));
    // a new token brings it back, and this desktop makes its own again
    let (status, _, body) = near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "token": BOOTSTRAP }))).await;
    assert_eq!(status, 200, "{body}");
    near.state(&id, "connected", 8000).await;
    assert_eq!(far.state.clients.lock().unwrap().len(), 1);
    assert_eq!(change().await.0, 200);
    // disconnect and connect
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": false }))).await;
    near.state(&id, "paused", 5000).await;
    assert_eq!(refused(change().await), (503, text::e11("Galaxy"), "paused".into()));
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": true }))).await;
    near.state(&id, "connected", 8000).await;
    // a rename shows at once and changes no alias
    let (_, _, view) = near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "name": "Andromeda" }))).await;
    assert_eq!((view["name"].as_str(), view["tag"].as_str()), (Some("Andromeda"), Some("galaxy")));
    // another engine answers at the address: refused, and not retried by itself
    far.stop().await;
    *far.state.data_root_id.lock().unwrap() = "another-root".into();
    far.restart().await;
    let view = near.state(&id, "refused", 8000).await;
    assert_eq!((view["last_error"].as_str(), view["error_code"].as_str()), (Some(text::e8(&far.url()).as_str()), Some("E8")));
    assert!(view["next_attempt_at"].is_null());
    assert_eq!(refused(change().await), (503, text::e11("Andromeda"), "refused".into()));
    // the user fixes it and presses Retry
    *far.state.data_root_id.lock().unwrap() = "far-root".into();
    let (status, _, _) = near.call("POST", &format!("/api/remotes/{id}/retry"), None, None).await;
    assert_eq!(status, 200);
    near.state(&id, "connected", 8000).await;
}

// ------------------------------------------------------------------ T11

#[tokio::test]
async fn t11_while_not_connected_a_request_is_answered_at_once_and_nothing_is_dialed() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": false }))).await;
    near.state(&id, "paused", 5000).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = (far.state.connections.load(Ordering::SeqCst), far.state.seen.lock().unwrap().len());
    let started = tokio::time::Instant::now();
    for (method, path) in [("GET", "/api/orgs/beta"), ("POST", "/api/orgs/beta/nodes/7/message"), ("GET", "/api/accounts"), ("DELETE", "/api/orgs/beta")] {
        let (status, _, body) = near.call(method, path, Some(&id), Some(json!({ "text": "x" }))).await;
        assert_eq!((status, body["detail"].as_str()), (503, Some(text::e11("Galaxy").as_str())), "{method} {path}");
        assert_eq!(body["remote"], json!({ "id": id, "state": "paused" }));
    }
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!((far.state.connections.load(Ordering::SeqCst), far.state.seen.lock().unwrap().len()), before, "the remote was dialed");
    // offline, in its own words
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": true }))).await;
    near.state(&id, "connected", 8000).await;
    far.stop().await;
    near.state(&id, "offline", 5000).await;
    let started = tokio::time::Instant::now();
    let (status, _, body) = near.call("POST", "/api/orgs/beta/nodes/7/message", Some(&id), Some(json!({ "text": "x" }))).await;
    assert_eq!((status, body["detail"].as_str(), body["remote"]["state"].as_str()), (503, Some(text::e9("Galaxy").as_str()), Some("offline")));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn t11_the_connection_says_beforehand_what_a_change_would_get() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, _) = connected(&near, &far).await;
    let change = || near.call("POST", "/api/orgs/beta/nodes/7/message", Some(&id), Some(json!({ "text": "x" })));
    // connected: a change goes through and the connection promises nothing else
    assert!(near.view(&id).await.get("refusal").is_some_and(Value::is_null), "a connected engine refuses nothing");
    assert_eq!(change().await.0, 200);
    // not connected: the connection carries the very sentence the relay answers with, so a window can
    // refuse a send before anything leaves its composer, in the engine's own words
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": false }))).await;
    let view = near.state(&id, "paused", 5000).await;
    assert_eq!(view["refusal"].as_str(), Some(text::e11("Galaxy").as_str()));
    assert_eq!(change().await.2["detail"], view["refusal"]);
    near.call("PATCH", &format!("/api/remotes/{id}"), None, Some(json!({ "enabled": true }))).await;
    near.state(&id, "connected", 8000).await;
    far.stop().await;
    let view = near.state(&id, "offline", 5000).await;
    assert_eq!(view["refusal"].as_str(), Some(text::e9("Galaxy").as_str()));
    assert_eq!(change().await.2["detail"], view["refusal"]);
}

// ------------------------------------------------------------------ T12

async fn frame_where(socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>, what: &str, mut holds: impl FnMut(&Value) -> bool) -> Value {
    for _ in 0..500 {
        let frame: Value = serde_json::from_str(&next_text(socket).await.unwrap_or_else(|code| panic!("the app socket closed ({code:?}) before {what}"))).unwrap();
        if holds(&frame) {
            return frame;
        }
    }
    panic!("no frame where {what}");
}

#[tokio::test]
async fn t12_remote_organizations_are_in_the_list_marked_and_stay_while_offline() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    let mut app = near.socket("/api/app/ws", None).await.unwrap();
    let text = next_text(&mut app).await.unwrap();
    assert!(!text.contains(&minted) && !text.contains(BOOTSTRAP), "a token is in the app feed");
    let snapshot: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(snapshot["type"], "app_snapshot");
    let row = |frame: &Value, slug: &str| frame["records"].as_array().and_then(|r| r.iter().find(|r| r["body"]["slug"] == slug).map(|r| r["body"].clone()));
    let beta = row(&snapshot["registry"], "beta").unwrap();
    let beta_id = beta["org_id"].as_i64().unwrap();
    assert!(beta_id < 0);
    assert_eq!(beta["remote"], json!({ "id": id, "name": "Galaxy", "tag": "galaxy", "slug": "beta", "state": "connected" }));
    assert_eq!((beta["state"].as_str(), beta["org_uuid"].as_str()), (Some("active"), Some("u-beta")));
    let summary = &snapshot["summaries"][beta_id.to_string()];
    assert_eq!((summary["org_uuid"].as_str(), summary["body"]["name"].as_str(), summary["body"]["nodes"].as_i64(), summary["body"]["attention"].as_i64()),
        (Some("u-beta"), Some("Beta"), Some(3), Some(1)));
    // the connections themselves are a pushed value
    assert_eq!(snapshot["runtime"]["values"]["remotes"]["value"][0]["id"], id);
    // what GET /api/orgs adds for them
    let listed = near.engine.remotes.list_rows();
    let listed = listed.iter().find(|r| r["slug"] == "beta").unwrap();
    assert_eq!((listed["name"].as_str(), listed["nodes"].as_i64(), listed["working"].as_i64(), listed["remote"]["state"].as_str()), (Some("Beta"), Some(3), Some(0), Some("connected")));
    // a working count arrives as the frame a local organization's would
    far.state.push_app(json!({ "type": "app_runtime", "orgs": { "2": { "working": 2 } } }));
    frame_where(&mut app, "beta works", |f| f["type"] == "app_runtime" && f["orgs"][beta_id.to_string()]["working"] == 2).await;
    // offline: the rows stay, say so, and claim no activity
    far.stop().await;
    frame_where(&mut app, "beta is marked offline", |f| f["type"] == "registry_snapshot" && row(f, "beta").is_some_and(|b| b["remote"]["state"] == "offline")).await;
    frame_where(&mut app, "beta stops working", |f| f["type"] == "app_runtime" && f["orgs"][beta_id.to_string()]["working"] == 0).await;
    let listed = near.engine.remotes.list_rows();
    let listed = listed.iter().find(|r| r["slug"] == "beta").unwrap();
    assert_eq!((listed["name"].as_str(), listed["nodes"].as_i64(), listed["working"].as_i64(), listed["remote"]["state"].as_str()), (Some("Beta"), Some(3), Some(0), Some("offline")));
    // removed: they leave the list
    near.call("DELETE", &format!("/api/remotes/{id}"), None, None).await;
    frame_where(&mut app, "beta left the list", |f| f["type"] == "registry_snapshot" && row(f, "beta").is_none()).await;
    assert!(near.engine.remotes.list_rows().is_empty());
}

// ------------------------------------------------------------------ T13

fn pushed<'a>(frame: &'a Value, key: &str) -> Option<&'a Value> {
    let entry = frame["type"].as_str().filter(|t| *t == "app_runtime").and(frame["values"].get(key))?;
    Some(&entry["value"])
}

#[tokio::test]
async fn t13_a_remote_window_gets_the_remote_engines_values_and_this_computers_list() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let mut far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    near.engine.app.set_value("accounts", json!([{ "id": "near-account" }]));
    near.engine.app.set_value("providers", json!([{ "id": "near-provider" }]));
    let mut local = near.socket("/api/app/ws", None).await.unwrap();
    let mut window = near.socket("/api/app/ws", Some(&id)).await.unwrap();
    let text = next_text(&mut window).await.unwrap();
    assert!(!text.contains(&minted) && !text.contains(BOOTSTRAP), "a token is in a remote window's app feed");
    let composed: Value = serde_json::from_str(&text).unwrap();
    let values = &composed["runtime"]["values"];
    // the remote engine's values, none of this computer's
    assert_eq!(values["accounts"]["value"], json!([{ "id": "far-account" }]));
    assert!(values.get("providers").is_none(), "this computer's providers are in a remote window's feed: {values}");
    // this computer's list of organizations and of connections, and this window's connection
    let has = |frame: &Value, slug: &str| frame["registry"]["records"].as_array().is_some_and(|r| r.iter().any(|r| r["body"]["slug"] == slug));
    assert!(has(&composed, "beta"));
    assert_eq!(values["remotes"]["value"][0]["id"], id);
    assert_eq!((values["remote_link"]["value"]["id"].as_str(), values["remote_link"]["value"]["state"].as_str()), (Some(id.as_str()), Some("connected")));
    assert!(values["remote_link"]["seq"].is_u64() && values["accounts"]["epoch"] == composed["epoch"], "an entry is stamped by this engine: {values}");
    // a local window is as before
    let plain: Value = serde_json::from_str(&next_text(&mut local).await.unwrap()).unwrap();
    assert_eq!(plain["runtime"]["values"]["accounts"]["value"], json!([{ "id": "near-account" }]));
    assert!(plain["runtime"]["values"].get("remote_link").is_none());
    assert!(has(&plain, "beta"));
    // the snapshot route answers the same way
    let (status, _, body) = near.call("GET", "/api/app/records", Some(&id), None).await;
    assert_eq!((status, &body["runtime"]["values"]["accounts"]["value"], body["runtime"]["values"]["remote_link"]["value"]["state"].as_str()),
        (200, &json!([{ "id": "far-account" }]), Some("connected")));
    let (_, _, body) = near.call("GET", "/api/app/records", None, None).await;
    assert_eq!(body["runtime"]["values"]["accounts"]["value"], json!([{ "id": "near-account" }]));
    // a value changes here, then there: each window hears its own engine's
    near.engine.app.set_value("providers", json!([{ "id": "near-provider-2" }]));
    far.state.push_app(json!({ "type": "app_runtime", "values": { "accounts": { "value": [{ "id": "far-account-2" }] } } }));
    let heard = frame_where(&mut window, "the remote window hears a value", |f| {
        assert!(pushed(f, "providers").is_none(), "a remote window heard this computer's providers");
        pushed(f, "accounts").is_some()
    }).await;
    assert_eq!(pushed(&heard, "accounts"), Some(&json!([{ "id": "far-account-2" }])));
    let heard = frame_where(&mut local, "the local window hears a value", |f| {
        assert!(pushed(f, "accounts").is_none(), "a local window heard the remote engine's accounts");
        pushed(f, "providers").is_some()
    }).await;
    assert_eq!(pushed(&heard, "providers"), Some(&json!([{ "id": "near-provider-2" }])));
    // offline: the window is told, and keeps the last values it had
    far.stop().await;
    frame_where(&mut window, "the remote window hears that its engine is offline", |f| pushed(f, "remote_link").is_some_and(|v| v["state"] == "offline")).await;
    let (_, _, body) = near.call("GET", "/api/app/records", Some(&id), None).await;
    assert_eq!((&body["runtime"]["values"]["accounts"]["value"], body["runtime"]["values"]["remote_link"]["value"]["state"].as_str()),
        (&json!([{ "id": "far-account-2" }]), Some("offline")));
    // an unknown connection has no feed
    assert_eq!(near.socket("/api/app/ws", Some("no-such-connection")).await.err(), Some(400));
}

// ------------------------------------------------------------------ T14

#[tokio::test]
async fn t14_removing_a_connection_revokes_this_desktops_token_and_frees_its_names() {
    let root = Root::new();
    let near = Near::start(&root).await;
    let far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    let (status, _, body) = near.call("DELETE", &format!("/api/remotes/{id}"), None, None).await;
    assert_eq!((status, &body), (200, &json!({ "removed": id, "revoked": true })));
    assert!(far.state.clients.lock().unwrap().is_empty() && !far.state.tokens.lock().unwrap().contains(&minted));
    let (_, _, list) = near.call("GET", "/api/remotes", None, None).await;
    assert_eq!(list["remotes"], json!([]));
    assert!(!std::fs::read_to_string(root.0.join(store::FILE)).unwrap().contains("galaxy"));
    // its windows' requests are refused and its names are free
    let (status, _, body) = near.call("GET", "/api/orgs/beta", Some(&id), None).await;
    assert_eq!((status, body["detail"].as_str()), (400, Some("unknown remote engine")));
    assert!(near.engine.remotes.alias_holder("beta").is_none());
    // nothing on the remote engine was deleted, and it can be added again
    assert_eq!(far.state.orgs.lock().unwrap().len(), 2);
    let (status, _, body) = near.call("DELETE", &format!("/api/remotes/{id}"), None, None).await;
    assert_eq!(status, 404, "{body}");
    near.add(&far).await;
}

// ------------------------------------------------------------------ T15

#[tokio::test(flavor = "current_thread")]
async fn t15_the_log_names_a_relayed_request_and_never_its_body_or_a_token() {
    let capture = crate::trace::LogCapture::start().await;
    let root = Root::new();
    let near = Near::start(&root).await;
    let far = Far::start().await;
    let (id, minted) = connected(&near, &far).await;
    let (status, _, body) = near.call("POST", "/api/orgs/beta/nodes/7/message", Some(&id), Some(json!({ "text": "PRIVATE-RELAYED-BODY-CANARY-5521" }))).await;
    assert_eq!((status, body["echo"]["text"].as_str()), (200, Some("PRIVATE-RELAYED-BODY-CANARY-5521")));
    tracing::info!("ordinary positive control 7731");
    let log = capture.finish().await;
    assert!(log.contains("ordinary positive control 7731"));
    assert!(log.contains("RELAY galaxy POST /api/orgs/beta/nodes/7/message 200"), "no RELAY line: {log}");
    assert!(log.lines().any(|l| l.contains("REQUEST ") && l.contains("/api/orgs/beta/nodes/7/message")), "no REQUEST line");
    for secret in ["PRIVATE-RELAYED-BODY-CANARY-5521", BOOTSTRAP, minted.as_str(), DESKTOP_TOKEN] {
        assert!(!log.contains(secret), "{secret} reached the log");
    }
}
