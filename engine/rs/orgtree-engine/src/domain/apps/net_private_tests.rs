//! Piece 2 (private sites; spec section 3, tests 8, 10, 11, 12): address classes, pinning, plain http and
//! redirects. Part of `net.rs`'s test build.
use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

#[test]
fn address_classes_follow_the_spec_table() {
    for (addr, want) in [
        ("8.8.8.8", Class::Public),
        ("2606:4700::1", Class::Public),
        ("10.0.0.5", Class::Private),
        ("172.16.0.1", Class::Private),
        ("172.31.0.1", Class::Private),
        ("192.168.1.1", Class::Private),
        ("100.64.0.1", Class::Private),
        ("100.127.255.254", Class::Private),
        ("fd7a:115c:a1e0::1", Class::Private),
        ("fc00::1", Class::Private),
        ("127.0.0.1", Class::Never),
        ("::1", Class::Never),
        ("169.254.169.254", Class::Never),
        ("fe80::1", Class::Never),
        ("0.0.0.0", Class::Never),
        ("::", Class::Never),
        ("224.0.0.1", Class::Never),
        ("255.255.255.255", Class::Never),
        ("::ffff:10.0.0.1", Class::Never),
        ("::ffff:127.0.0.1", Class::Never),
        ("192.0.2.1", Class::Never),
        ("198.18.0.1", Class::Never),
        ("2001:db8::1", Class::Never),
        ("100.128.0.1", Class::Public),
        ("172.32.0.1", Class::Public),
    ] {
        assert_eq!(classify(ip(addr)), want, "{addr}");
    }
}

#[test]
fn vetting_pins_private_addresses_and_refuses_everything_else() {
    let pin = [ip("100.101.102.103")];
    assert!(vet_addresses("nas", &[ip("100.101.102.103")], Some(&pin)).unwrap());
    let unpinned = vet_addresses("nas", &[ip("100.101.102.103")], None).unwrap_err().to_string();
    assert!(unpinned.contains("is on a private network") && unpinned.contains("allow it in the app's settings"), "{unpinned}");
    // A name that now resolves elsewhere (still private) is refused with the re-pin hint.
    let moved = vet_addresses("nas", &[ip("100.101.102.104")], Some(&pin)).unwrap_err().to_string();
    assert!(moved.contains("now resolves to a different address") && moved.contains("review it in the app's settings"), "{moved}");
    // EVERY resolved address must be in the set.
    assert!(vet_addresses("nas", &[ip("100.101.102.103"), ip("100.101.102.104")], Some(&pin)).is_err());
    // Public, mixed or Never never pass as private.
    assert!(!vet_addresses("example.com", &[ip("8.8.8.8")], None).unwrap());
    assert!(vet_addresses("nas", &[ip("8.8.8.8")], Some(&pin)).is_err(), "a pinned site that went public");
    assert!(vet_addresses("nas", &[ip("100.101.102.103"), ip("8.8.8.8")], Some(&pin)).is_err());
    for never in ["127.0.0.1", "169.254.169.254", "::ffff:10.0.0.1"] {
        let pins = [ip(never)];
        assert!(vet_addresses("x", &[ip(never)], Some(&pins)).is_err(), "{never} is never reachable, whatever is pinned");
    }
}

/// A plain http server reached only through the private test route, judged as the given address.
async fn plain_server(host: &str, judged: &str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    {
        let mut routes = TEST_PRIVATE_ROUTES.lock().unwrap();
        routes.retain(|(h, ..)| h != host);
        routes.push((host.to_string(), ip(judged), addr));
    }
    let heads = Arc::new(Mutex::new(Vec::new()));
    let seen = heads.clone();
    let host = host.to_string();
    let port = addr.port();
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { return };
            let (seen, host) = (seen.clone(), host.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tcp.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                seen.lock().unwrap().push(head.clone());
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let reply = |status: &str, extra: &str, body: &[u8]| {
                    let mut out = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", body.len()).into_bytes();
                    out.extend_from_slice(body);
                    out
                };
                let out = match path.as_str() {
                    "/ok" => reply("200 OK", "", b"hello"),
                    "/same" => reply("302 Found", &format!("Location: http://{host}:{port}/ok\r\n"), b""),
                    "/other-port" => reply("302 Found", &format!("Location: http://{host}:9999/ok\r\n"), b""),
                    "/other-host" => reply("302 Found", &format!("Location: http://elsewhere.test:{port}/ok\r\n"), b""),
                    "/to-https" => reply("302 Found", &format!("Location: https://{host}:{port}/ok\r\n"), b""),
                    _ => reply("404 Not Found", "", b""),
                };
                let _ = tcp.write_all(&out).await;
                let _ = tcp.shutdown().await;
            });
        }
    });
    (addr.port(), heads)
}

fn get(url: &str) -> Fetch {
    Fetch { url: url.parse().unwrap(), method: "GET".into(), headers: vec![], body: None }
}

#[tokio::test]
async fn plain_http_reaches_only_a_pinned_private_site_and_follows_only_same_site_redirects() {
    let (port, _heads) = plain_server("nas.test", "100.101.102.103").await;
    let pinned = vec![ip("100.101.102.103")];
    let allow = |h: &str, p: u16| h == "nas.test" && p == port;
    let private = |h: &str, p: u16| (h == "nas.test" && p == port).then(|| pinned.clone());
    let ok = Access { allow: &allow, private: &private };
    let got = fetch_with(get(&format!("http://nas.test:{port}/ok")), &ok).await.unwrap();
    assert_eq!((got.status, got.body.as_slice()), (200, b"hello".as_slice()));
    // Same-site redirect followed.
    let same = fetch_with(get(&format!("http://nas.test:{port}/same")), &ok).await.unwrap();
    assert_eq!((same.status, same.redirected), (200, true));
    // Any other target is refused: another port, another host, another scheme.
    for path in ["other-port", "other-host", "to-https"] {
        let e = fetch_with(get(&format!("http://nas.test:{port}/{path}")), &ok).await.unwrap_err().to_string();
        assert!(e.contains("redirects off a private site are not followed"), "{path}: {e}");
    }
    // Without the allow-private row the same request is refused (a plain Allow never opens it).
    let none = |_: &str, _: u16| None;
    let unpinned = Access { allow: &allow, private: &none };
    let e = fetch_with(get(&format!("http://nas.test:{port}/ok")), &unpinned).await.unwrap_err().to_string();
    assert!(e.contains("must use https"), "{e}");
    // A pin that no longer matches the resolved address is refused.
    let moved = vec![ip("100.101.102.200")];
    let private_moved = |h: &str, p: u16| (h == "nas.test" && p == port).then(|| moved.clone());
    let repinned = Access { allow: &allow, private: &private_moved };
    let e = fetch_with(get(&format!("http://nas.test:{port}/ok")), &repinned).await.unwrap_err().to_string();
    assert!(e.contains("now resolves to a different address"), "{e}");
}

#[tokio::test]
async fn plain_http_to_a_public_site_is_refused() {
    let allow = |_: &str, _: u16| true;
    let none = |_: &str, _: u16| None;
    let access = Access { allow: &allow, private: &none };
    let e = fetch_with(get("http://example.com/x"), &access).await.unwrap_err().to_string();
    assert!(e.contains("must use https"), "{e}");
}

#[test]
fn the_permissions_row_describes_where_a_site_resolves_and_what_is_pinned() {
    let row = serde_json::json!({"value":"allow-private","addresses":["100.101.102.103"]});
    let d = describe_site("nas:8642", Some(&[ip("100.101.102.103")]), &row);
    assert_eq!((d["class"].as_str(), d["tailscale"].as_bool(), d["moved"].as_bool()), (Some("private"), Some(true), Some(false)));
    let moved = describe_site("nas:8642", Some(&[ip("100.101.102.104")]), &row);
    assert_eq!(moved["moved"], true, "the name now resolves elsewhere");
    let lan = describe_site("nas:8642", Some(&[ip("192.168.1.5")]), &serde_json::json!("ask"));
    assert_eq!((lan["class"].as_str(), lan["tailscale"].as_bool(), lan["allowed"].as_bool()), (Some("private"), Some(false), Some(false)));
    assert_eq!(describe_site("x", Some(&[ip("127.0.0.1")]), &serde_json::json!(null))["class"], "never");
    assert_eq!(describe_site("x", Some(&[ip("8.8.8.8")]), &serde_json::json!(null))["class"], "public");
    assert_eq!(describe_site("x", None, &serde_json::json!(null))["class"], "unresolved");
    assert_eq!(describe_site("v6", Some(&[ip("fd7a:115c:a1e0::1")]), &serde_json::json!(null))["tailscale"], true);
}

// Spec 4.4 / test 13: the engine attaches the saved login to the exact site's requests, replacing an app header of
// the same name, and tells the app only whether one was attached.
#[tokio::test]
async fn a_saved_login_is_attached_to_its_own_site_only_and_replaces_the_apps_header() {
    let (port, heads) = plain_server("login.test", "100.64.0.20").await;
    let pinned = vec![ip("100.64.0.20")];
    let allow = |h: &str, p: u16| h == "login.test" && p == port;
    let private = |h: &str, p: u16| (h == "login.test" && p == port).then(|| pinned.clone());
    let access = Access { allow: &allow, private: &private };
    let login = |h: &str, p: u16| (h == "login.test" && p == port).then(|| ("Authorization".to_string(), "Bearer ENGINE-HELD".to_string()));
    let mut request = get(&format!("http://login.test:{port}/ok"));
    request.headers = vec![("authorization".into(), "Bearer APP-CHOSE".into()), ("Accept".into(), "text/plain".into())];
    let got = fetch_full(request, &access, &login).await.unwrap();
    assert!(got.login, "the app learns that a login was attached, nothing more");
    let head = heads.lock().unwrap().last().unwrap().to_ascii_lowercase();
    assert!(head.contains("authorization: bearer engine-held"), "{head}");
    assert!(!head.contains("app-chose"), "the app's own header is replaced: {head}");
    assert!(head.contains("accept: text/plain"), "{head}");
    // No login row: nothing is attached and the app's header is left alone.
    let none = |_: &str, _: u16| None;
    let mut request = get(&format!("http://login.test:{port}/ok"));
    request.headers = vec![("Authorization".into(), "Bearer APP-CHOSE".into())];
    let got = fetch_full(request, &access, &none).await.unwrap();
    assert!(!got.login);
    assert!(heads.lock().unwrap().last().unwrap().contains("APP-CHOSE") || heads.lock().unwrap().last().unwrap().to_ascii_lowercase().contains("app-chose"));
}
