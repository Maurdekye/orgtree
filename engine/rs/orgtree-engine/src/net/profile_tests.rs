//! A rename reaches the mail hubs: one `POST /api/profile` per differing
//! roster row, the first 48 characters, never twice for a refused name.
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

#[test]
#[nolog]
fn the_name_is_cut_to_48_characters_not_bytes() {
    assert_eq!(wanted("New"), "New");
    let long = "é".repeat(60);
    assert_eq!(wanted(&long).chars().count(), 48);
    assert_eq!(wanted(&long), "é".repeat(48));
}

#[test]
#[nolog]
fn the_hub_strips_whitespace_so_the_wanted_name_is_already_stripped() {
    assert_eq!(wanted("  Acme  "), "Acme");
    // 47 characters, a space as the 48th, then more: the cut must not end in a space
    let cut = format!("{} {}", "x".repeat(47), "yy");
    assert_eq!(cut.chars().count(), 50);
    assert_eq!(wanted(&cut), "x".repeat(47));
}

#[test]
#[nolog]
fn it_is_due_only_when_the_row_is_known_and_differs() {
    assert!(due(Some("Old"), "New", None), "differs: send");
    assert!(!due(Some("New"), "New", None), "same: nothing");
    assert!(!due(None, "New", None), "our row is not on the roster yet: nothing this pass");
    assert!(!due(Some("Old"), "New", Some("New")), "this name was refused: not again");
    assert!(due(Some("Old"), "Newer", Some("New")), "a different name is tried");
    assert!(!due(Some("Old"), "", None), "an empty name is never sent");
}

/// A hub that records each request it gets and answers `status`.
async fn hub(status: &'static str) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            // headers and body can arrive in separate reads: read until the body is complete
            let mut got = Vec::new();
            loop {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                let Some((head, body)) = text.split_once("

") else {
                    if n == 0 { break } else { continue }
                };
                let want = head.to_ascii_lowercase().split("content-length:").nth(1).and_then(|v| v.trim().split_whitespace().next().and_then(|v| v.parse::<usize>().ok())).unwrap_or(0);
                if body.len() >= want || n == 0 { break }
            }
            let _ = tx.send(String::from_utf8_lossy(&got).to_string());
            let body = "{\"ok\":true}";
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(resp.as_bytes()).await;
        }
    });
    (address, rx)
}

fn part(name: &str, addr: &str) -> Part {
    Part {
        org_id: 7,
        slug: "acme".into(),
        name: name.into(),
        net_slug: "acme.user.abc123".into(),
        secret: "s3cret".into(),
        hubs: vec![("h1".into(), addr.into())],
        registered: HashSet::from(["h1".to_string()]),
    }
}

fn set_row(engine: &Engine, addr: &str, name: &str) {
    set_roster(engine, addr, None, None, vec![json!({ "slug": "acme.user.abc123", "org_name": name }), json!({ "slug": "other", "org_name": "Other" })]);
}

fn roster_name(engine: &Engine, addr: &str) -> String {
    engine.net.rosters.pin().get(addr).unwrap().iter().find(|r| r["slug"] == "acme.user.abc123").unwrap()["org_name"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_renamed_org_sends_one_profile_post_and_then_nothing() {
    let engine = Engine::for_tests(std::env::temp_dir().join("orgtree-profile-unused"));
    let (addr, mut rx) = hub("200 OK").await;
    set_row(&engine, &addr, "Old");
    let parts = vec![part("New", &addr)];
    run(&engine, &parts, false).await;
    let req = rx.try_recv().expect("one POST");
    assert!(req.starts_with("POST /api/profile"), "{req}");
    assert!(req.to_ascii_lowercase().contains("x-org-auth: acme.user.abc123:s3cret"), "{req}");
    let body: Value = serde_json::from_str(req.rsplit("\r\n\r\n").next().unwrap()).unwrap();
    assert_eq!(body, json!({ "slug": "acme.user.abc123", "name": "New" }), "only slug and name are sent");
    assert_eq!(roster_name(&engine, &addr), "New", "the cached row follows");
    run(&engine, &parts, false).await;
    assert!(rx.try_recv().is_err(), "the second pass sends nothing");
}

#[tokio::test]
async fn a_long_name_sends_its_first_48_characters() {
    let engine = Engine::for_tests(std::env::temp_dir().join("orgtree-profile-unused"));
    let (addr, mut rx) = hub("200 OK").await;
    set_row(&engine, &addr, "Old");
    let long = "x".repeat(60);
    run(&engine, &[part(&long, &addr)], false).await;
    let req = rx.try_recv().expect("one POST");
    let body: Value = serde_json::from_str(req.rsplit("\r\n\r\n").next().unwrap()).unwrap();
    assert_eq!(body["name"], "x".repeat(48));
    assert_eq!(roster_name(&engine, &addr), "x".repeat(48));
}

#[tokio::test]
async fn a_refused_name_is_not_retried_in_the_same_run() {
    let engine = Engine::for_tests(std::env::temp_dir().join("orgtree-profile-unused"));
    let (addr, mut rx) = hub("404 Not Found").await;
    set_row(&engine, &addr, "Old");
    let parts = vec![part("New", &addr)];
    run(&engine, &parts, false).await;
    run(&engine, &parts, false).await;
    assert!(rx.try_recv().is_ok(), "tried once");
    assert!(rx.try_recv().is_err(), "not again");
    assert_eq!(roster_name(&engine, &addr), "Old", "the cache is not changed on a refusal");
}

#[tokio::test]
async fn nothing_is_sent_without_our_roster_row_or_an_unregistered_hub() {
    let engine = Engine::for_tests(std::env::temp_dir().join("orgtree-profile-unused"));
    let (addr, mut rx) = hub("200 OK").await;
    run(&engine, &[part("New", &addr)], false).await;
    assert!(rx.try_recv().is_err(), "roster not loaded");
    set_roster(&engine, &addr, None, None, vec![json!({ "slug": "other", "org_name": "Other" })]);
    run(&engine, &[part("New", &addr)], false).await;
    assert!(rx.try_recv().is_err(), "own row missing");
    set_row(&engine, &addr, "Old");
    let mut p = part("New", &addr);
    p.registered.clear();
    run(&engine, &[p], false).await;
    assert!(rx.try_recv().is_err(), "not registered there: register sends the name");
}

#[tokio::test]
async fn a_name_the_hub_strips_is_sent_once_even_when_the_roster_comes_back_stripped() {
    let engine = Engine::for_tests(std::env::temp_dir().join("orgtree-profile-unused"));
    let (addr, mut rx) = hub("200 OK").await;
    set_row(&engine, &addr, "Old");
    let spaced = format!("  {} {}  ", "x".repeat(46), "yyy");
    let parts = vec![part(&spaced, &addr)];
    run(&engine, &parts, false).await;
    let req = rx.try_recv().expect("one POST");
    let body: Value = serde_json::from_str(req.rsplit("

").next().unwrap()).unwrap();
    let sent = body["name"].as_str().unwrap().to_string();
    assert_eq!(sent, sent.trim(), "the sent name has no surrounding whitespace");
    // a roster refresh brings back what the hub stored (stripped)
    set_row(&engine, &addr, sent.trim());
    run(&engine, &parts, false).await;
    assert!(rx.try_recv().is_err(), "nothing again");
    let cut = format!("{} {}", "x".repeat(47), "yy");
    let parts = vec![part(&cut, &addr)];
    run(&engine, &parts, false).await;
    let req = rx.try_recv().expect("one POST for the cut name");
    let body: Value = serde_json::from_str(req.rsplit("

").next().unwrap()).unwrap();
    assert_eq!(body["name"], "x".repeat(47));
    set_row(&engine, &addr, &"x".repeat(47));
    run(&engine, &parts, false).await;
    assert!(rx.try_recv().is_err(), "nothing again after the stripped roster");
}
