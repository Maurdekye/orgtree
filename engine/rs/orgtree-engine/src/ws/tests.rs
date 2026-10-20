//! Websocket connections against the in-process test server
//! (`testserver.rs`): no network beyond 127.0.0.1, fast clocks
//! ([`Timing::fast`]).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_util::sync::CancellationToken;

use super::testserver::{Opts, TestServer};
use super::*;

impl Timing {
    /// Test clocks: backoffs in tens of milliseconds, no jitter.
    pub fn fast() -> Timing {
        Timing {
            net_first: Duration::from_millis(50),
            net_max: Duration::from_millis(400),
            refused: vec![Duration::from_millis(300), Duration::from_millis(600)],
            stable: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(2),
            ping_after: Duration::from_secs(5),
            dead_after: Duration::from_secs(10),
            write_timeout: Duration::from_secs(2),
            kick_gap: Duration::from_millis(50),
            retry_after_max: Duration::from_secs(2),
            jitter: false,
        }
    }
}

const CANARY: &str = "WS-CANARY-27182818";

fn spec(url: &str) -> Spec {
    Spec { endpoint: parse_target(url).unwrap(), protocols: Vec::new(), hello: Vec::new(), heartbeat: None, pattern: None, source: creds::Source::None }
}

fn inline(v: Value) -> creds::Source {
    creds::Source::Inline(Arc::new(creds::inline_from_args(&v).unwrap()))
}

fn dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("orgtree-ws-test-{}", crate::util::random_hex(6)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Wait until the connection is in state `name`.
async fn state(rx: &mut watch::Receiver<Snapshot>, name: &str, secs: u64) -> State {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let s = rx.borrow_and_update().state.clone();
        if s.name() == name {
            return s;
        }
        match tokio::time::timeout_at(deadline, rx.changed()).await {
            Ok(Ok(())) => {}
            _ => panic!("state {name} not reached within {secs} s; last: {:?}", rx.borrow().state),
        }
    }
}

fn error(s: &State) -> String {
    match s {
        State::Down { error, .. } | State::Refused { error, .. } => error.clone(),
        other => panic!("no error in {other:?}"),
    }
}

async fn next(c: &mut Conn, secs: u64) -> Message {
    tokio::time::timeout(Duration::from_secs(secs), c.rx.recv()).await.expect("a message in time").expect("the connection is open")
}

fn texts(got: &[(u64, String)]) -> Vec<&str> {
    got.iter().map(|(_, t)| t.as_str()).collect()
}

#[tokio::test]
async fn hellos_go_out_in_order_after_every_connect() {
    let s = TestServer::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/api/websocket"));
    sp.source = inline(json!({"hello": [{"type": "auth", "access_token": CANARY}]}));
    sp.hello = vec![r#"{"id":1,"type":"subscribe_events"}"#.into(), "second".into()];
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    assert!(s.until(5, |s| s.got().len() == 3).await, "{:?}", s.got());
    let auth = format!(r#"{{"type":"auth","access_token":"{CANARY}"}}"#);
    let want = vec![auth.as_str(), r#"{"id":1,"type":"subscribe_events"}"#, "second"];
    assert_eq!(texts(&s.got()), want, "the credentials' hello (a login) goes first, then the dog's, in order");
    s.drop_all();
    assert!(s.until(5, |s| s.got().len() == 6).await, "the hellos go out again after a reconnect: {:?}", s.got());
    let got = s.got();
    assert_eq!(texts(&got[3..]), want);
    assert_ne!(got[0].0, got[3].0, "on a new connection");
    assert_eq!(s.seen()[0].uri, "/api/websocket");
}

#[tokio::test]
async fn headers_bearer_query_and_subprotocols_reach_the_server() {
    let s = TestServer::start(Opts {
        protocol: Some("graphql-transport-ws".into()),
        require: vec![("authorization".into(), format!("Bearer {CANARY}"))],
        ..Default::default()
    })
    .await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/v1?stream=all"));
    sp.source = inline(json!({"bearer": CANARY, "headers": {"X-Client": "orgtree", "Origin": "http://localhost:5173"}, "query": {"token": CANARY}}));
    sp.protocols = vec!["vite-hmr".into(), "graphql-transport-ws".into()];
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    let seen = s.seen().remove(0);
    assert_eq!(seen.uri, format!("/v1?stream=all&token={CANARY}"), "the credential query is appended when it dials");
    let h = |n: &str| seen.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone());
    assert_eq!(h("x-client").as_deref(), Some("orgtree"));
    assert_eq!(h("origin").as_deref(), Some("http://localhost:5173"));
    assert_eq!(h("sec-websocket-protocol").as_deref(), Some("vite-hmr, graphql-transport-ws"));
    assert_eq!(c.stats.protocol.lock().unwrap().as_deref(), Some("graphql-transport-ws"), "the protocol the server chose is kept");
    // the same server refuses a client without the header
    let mut bare = hub.open(spec(&s.url("/v1")), &cancel);
    let st = state(&mut bare.state, "refused", 5).await;
    assert!(error(&st).contains("HTTP 401") && error(&st).contains("refused the login"), "{st:?}");
}

#[tokio::test]
async fn a_server_choosing_a_protocol_it_was_not_offered_is_a_refusal() {
    let s = TestServer::start(Opts { wrong_protocol: true, ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/"));
    sp.protocols = vec!["vite-hmr".into()];
    let mut c = hub.open(sp, &cancel);
    let st = state(&mut c.state, "refused", 5).await;
    assert!(error(&st).contains("subprotocols"), "{st:?}");
}

#[tokio::test]
async fn a_send_goes_out_after_the_hellos_and_is_refused_while_down() {
    let s = TestServer::start(Opts { echo: true, ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/"));
    sp.hello = vec!["hello".into()];
    sp.pattern = Some(fancy_regex::Regex::new("^echo:send-").unwrap());
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    let link = c.link();
    let sent = link.send("send-1".into(), Duration::from_secs(5)).await.expect("written");
    assert_eq!(sent.bytes, 6);
    let m = next(&mut c, 5).await;
    assert_eq!(m.text.as_deref(), Some("echo:send-1"), "only the reply matching the pattern is passed on");
    assert_eq!(texts(&s.got()), vec!["hello", "send-1"], "the hello first, then the send");
    assert!(s.until(5, |_| c.stats.get(&c.stats.received) == 2).await, "both echoes were received");
    assert_eq!(c.stats.get(&c.stats.sent), 1);
    assert!(c.stats.last_sent.lock().unwrap().is_some());
    s.stop();
    state(&mut c.state, "down", 5).await;
    let e = link.send("send-2".into(), Duration::from_secs(5)).await.unwrap_err();
    assert!(e.contains("not connected") && e.contains("down since"), "{e}");
    assert_eq!(c.stats.get(&c.stats.sent), 1, "nothing was written");
}

#[tokio::test]
async fn refusals_and_outages_back_off_without_a_tight_loop() {
    let s = TestServer::start(Opts { refuse: Some((401, None)), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    let st = state(&mut c.state, "refused", 5).await;
    assert!(error(&st).contains("HTTP 401 Unauthorized"), "{st:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let n = s.dials();
    assert!((3..=4).contains(&n), "refusals back off 300 ms, then 600 ms: {n} dials in 1.5 s");
    // nothing listens on this port: the network backoff doubles from 50 ms
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut gone = hub.open(spec(&format!("ws://127.0.0.1:{port}/")), &cancel);
    let st = state(&mut gone.state, "down", 5).await;
    // Windows answers a closed loopback port only after its SYN retries (~2 s)
    assert!(error(&st).contains("refused the TCP connection") || error(&st).contains("connect timeout"), "{st:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let n = gone.stats.get(&gone.stats.dials);
    assert!((1..=8).contains(&n), "the network backoff doubles (50, 100, 200, 400, 400 ms…): {n} dials in 1.5 s");
}

#[tokio::test]
async fn retry_after_holds_the_next_dial() {
    let s = TestServer::start(Opts { refuse: Some((503, Some(1))), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    let st = state(&mut c.state, "down", 5).await;
    assert!(error(&st).contains("HTTP 503"), "{st:?}");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(s.dials(), 1, "Retry-After: 1 holds the next dial for a second, past the 50 ms backoff");
    assert!(s.until(3, |s| s.dials() == 2).await);
}

#[tokio::test]
async fn a_wrong_path_or_a_redirect_says_what_to_fix() {
    let s = TestServer::start(Opts { refuse: Some((404, None)), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/nope")), &cancel);
    let st = state(&mut c.state, "refused", 5).await;
    assert!(error(&st).contains("HTTP 404") && error(&st).contains("path and query"), "{st:?}");
    s.set_opts(|o| o.refuse = Some((301, None)));
    let mut r = hub.open(spec(&s.url("/old")), &cancel);
    let st = state(&mut r.state, "refused", 5).await;
    assert!(error(&st).contains("redirects"), "{st:?}");
}

#[tokio::test]
async fn a_silent_server_is_dead_after_its_pings_go_unanswered() {
    let s = TestServer::start(Opts { mute: true, ..Default::default() }).await;
    let hub = Hub::with_timing(Timing { ping_after: Duration::from_millis(100), dead_after: Duration::from_millis(400), ..Timing::fast() });
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    state(&mut c.state, "connected", 5).await;
    let st = state(&mut c.state, "down", 3).await;
    assert!(error(&st).contains("went silent"), "{st:?}");
    // a server that does answer stays up past the same clocks
    let live = TestServer::start(Opts::default()).await;
    let mut ok = hub.open(spec(&live.url("/")), &cancel);
    state(&mut ok.state, "connected", 5).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(ok.state.borrow().state.name(), "connected", "its pongs keep it alive");
    assert_eq!(live.upgrades(), 1);
}

#[tokio::test]
async fn a_server_that_drops_the_client_at_once_is_one_outage() {
    let s = TestServer::start(Opts { close_with: Some((4004, "Authentication failed".into())), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    let first = state(&mut c.state, "down", 5).await;
    assert!(error(&first).contains("code 4004") && error(&first).contains("the server said \"Authentication failed\""), "{first:?}");
    assert!(s.until(5, |s| s.upgrades() >= 3).await);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let later = state(&mut c.state, "down", 5).await;
    let since = |s: &State| match s { State::Down { since, .. } => *since, _ => unreachable!() };
    assert_eq!(since(&later), since(&first), "connections the server ends at once do not end the outage");
}

/// A server that takes the TCP connection and closes it before answering the
/// upgrade (one that is restarting, or a port forwarder whose backend is not
/// up yet) is an outage, not a refusal: tungstenite calls the early end of
/// stream a handshake protocol error, but nothing refused this client
/// (user 2026-10-20 09:13Z: retry until the connection is back).
#[tokio::test]
async fn a_server_closing_during_the_upgrade_is_an_outage_not_a_refusal() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = l.accept().await {
            // read the whole upgrade request, then close: a clean end of
            // stream, as a port forwarder gives, not a reset
            let mut req = Vec::new();
            let mut buf = [0u8; 1024];
            while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                match sock.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(k) => req.extend_from_slice(&buf[..k]),
                }
            }
            let _ = sock.shutdown().await;
        }
    });
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&format!("ws://127.0.0.1:{port}/ws")), &cancel);
    let st = state(&mut c.state, "down", 5).await;
    assert!(error(&st).contains("closed the connection before answering the upgrade"), "{st:?}");
    assert!(c.stats.get(&c.stats.dials) >= 1);
    cancel.cancel();
}

/// However long the server stays away, the dog keeps dialling (no attempt
/// is the last) and, once it is back, connects and sends its hellos again
/// (user 2026-10-20 09:13Z).
#[tokio::test]
async fn a_long_outage_is_redialled_without_end_and_the_hellos_go_out_again() {
    let s = TestServer::start(Opts { refuse: Some((503, None)), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing { net_max: Duration::from_millis(50), ..Timing::fast() });
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/"));
    sp.hello = vec!["subscribe door".into()];
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "down", 5).await;
    assert!(s.until(10, |s| s.dials() >= 40).await, "40 failed dials and still dialling: {}", s.dials());
    s.set_opts(|o| o.refuse = None);
    state(&mut c.state, "connected", 5).await;
    assert!(s.until(5, |s| texts(&s.got()).contains(&"subscribe door")).await, "the hello went out after the outage: {:?}", s.got());
    cancel.cancel();
}

#[tokio::test]
async fn binary_big_and_overflowing_messages() {
    let s = TestServer::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut any = hub.open(spec(&s.url("/")), &cancel);
    let mut sp = spec(&s.url("/"));
    sp.pattern = Some(fancy_regex::Regex::new("NEEDLE$").unwrap());
    let mut needle = hub.open(sp, &cancel);
    state(&mut any.state, "connected", 5).await;
    state(&mut needle.state, "connected", 5).await;
    s.push(Frame::Binary(vec![1u8, 2, 3].into()));
    let m = next(&mut any, 5).await;
    assert!(m.text.is_none() && m.size == 3, "with no pattern a binary message comes as its size");
    let big = format!("{}NEEDLE", "a".repeat(100_000));
    s.push(Frame::Text(big.clone().into()));
    let m = next(&mut needle, 5).await;
    assert_eq!(m.size, 100_006, "the pattern ran on the whole message");
    assert_eq!(m.text.as_ref().unwrap().len(), KEEP_TEXT, "the dog keeps what a fire shows");
    assert!(m.partial());
    assert_eq!(needle.stats.get(&needle.stats.binary), 1, "the binary message was counted but never matched");
    let _ = next(&mut any, 5).await;
    // 300 messages nobody reads: 256 wait, the rest are counted as dropped
    for i in 0..300 {
        s.push(Frame::Text(format!("m{i}").into()));
    }
    assert!(s.until(5, |_| any.stats.get(&any.stats.received) == 302).await, "{}", any.stats.get(&any.stats.received));
    assert_eq!(any.stats.get(&any.stats.dropped), 300 - DELIVERY_BUFFER as u64);
    // a message over 1 MiB resets the connection, which dials again
    s.push(Frame::Text("x".repeat(MAX_MESSAGE + 1).into()));
    let st = state(&mut needle.state, "down", 5).await;
    assert!(error(&st).contains("over 1024 KiB"), "{st:?}");
    state(&mut needle.state, "connected", 5).await;
}

#[tokio::test]
async fn the_heartbeat_goes_out_while_connected() {
    let s = TestServer::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/gateway"));
    sp.hello = vec!["identify".into()];
    sp.heartbeat = Some((r#"{"op":1,"d":null}"#.into(), Duration::from_millis(100)));
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    tokio::time::sleep(Duration::from_millis(550)).await;
    let got = s.got();
    let beats = got.iter().filter(|(_, t)| t == r#"{"op":1,"d":null}"#).count();
    assert_eq!(got[0].1, "identify");
    assert!((3..=6).contains(&beats), "a heartbeat every 100 ms: {beats} in 550 ms");
}

#[tokio::test]
async fn dropping_the_connection_says_goodbye() {
    let s = TestServer::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    state(&mut c.state, "connected", 5).await;
    assert!(s.until(5, |s| s.live() == 1).await);
    drop(c);
    assert!(s.until(5, |s| s.live() == 0).await, "the socket is closed");
    assert_eq!(s.closes(), vec![1001], "with Close 1001 going away");
    // a parked connection the runner never took closes on unpark too
    let c = hub.open(spec(&s.url("/")), &cancel);
    hub.park(7, c);
    assert!(s.until(5, |s| s.live() == 1).await);
    drop(hub.unpark(7));
    assert!(hub.unpark(7).is_none(), "taken once");
    assert!(s.until(5, |s| s.live() == 0).await);
}

#[tokio::test]
async fn send_reaches_the_registered_connection_only_while_registered() {
    let s = TestServer::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    state(&mut c.state, "connected", 5).await;
    assert!(hub.link(3).is_none());
    {
        let _held = hub.register(3, &c);
        let link = hub.link(3).expect("registered");
        link.send("via the hub".into(), Duration::from_secs(5)).await.unwrap();
        // a newer registration for the row wins, and the older guard's drop leaves it
        let _newer = hub.register(3, &c);
        drop(_held);
        assert!(hub.link(3).is_some());
    }
    assert!(hub.link(3).is_none(), "gone with its guard");
    assert!(s.until(5, |s| texts(&s.got()) == vec!["via the hub"]).await);
}

#[tokio::test]
async fn wss_with_a_pinned_ca_and_a_client_certificate() {
    let certs = crate::mqtt::testbroker::certs();
    let s = TestServer::start(Opts { tls: Some(certs.server_requiring_client.clone()), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let d = dir();
    let full = d.join("feed.json");
    std::fs::write(&full, json!({"ca_pem": certs.ca_pem, "cert_pem": certs.client_cert_pem, "key_pem": certs.client_key_pem}).to_string()).unwrap();
    let mut sp = spec(&s.url("/secure"));
    sp.source = creds::Source::File(full);
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    // the CA alone: the server wants a client certificate
    let ca_only = d.join("ca.json");
    std::fs::write(&ca_only, json!({"ca_pem": certs.ca_pem}).to_string()).unwrap();
    let mut sp = spec(&s.url("/secure"));
    sp.source = creds::Source::File(ca_only.clone());
    let mut no_cert = hub.open(sp, &cancel);
    let st = state(&mut no_cert.state, "refused", 5).await;
    assert!(error(&st).contains("TLS"), "{st:?}");
    // the Mozilla roots do not know the test CA
    let mut public = hub.open(spec(&s.url("/secure")), &cancel);
    let st = state(&mut public.state, "refused", 5).await;
    assert!(error(&st).contains("TLS"), "{st:?}");
    // a certificate for another name, from the pinned CA
    let other = TestServer::start(Opts { tls: Some(certs.wrong_name.clone()), ..Default::default() }).await;
    let mut sp = spec(&other.url("/"));
    sp.source = creds::Source::File(ca_only);
    let mut wrong = hub.open(sp, &cancel);
    let st = state(&mut wrong.state, "refused", 5).await;
    assert!(error(&st).contains("TLS"), "{st:?}");
    std::fs::remove_dir_all(&d).ok();
}

#[tokio::test]
async fn kick_retries_a_refused_connection_at_once() {
    let s = TestServer::start(Opts { refuse: Some((403, None)), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing { refused: vec![Duration::from_secs(60)], ..Timing::fast() });
    let cancel = CancellationToken::new();
    let mut c = hub.open(spec(&s.url("/")), &cancel);
    let st = state(&mut c.state, "refused", 5).await;
    assert!(error(&st).contains("HTTP 403"), "{st:?}");
    s.set_opts(|o| o.refuse = None);
    c.kick();
    state(&mut c.state, "connected", 5).await;
    assert_eq!(s.dials(), 2, "the kick dialed once, not the 60 s backoff");
}

/// Verbose call logging on, every credential kind used, and a refused
/// target with a secret query: none of it reaches the engine log.
#[tokio::test]
async fn secrets_never_reach_the_log() {
    let capture = crate::trace::LogCapture::start().await;
    let s = TestServer::start(Opts { require: vec![("authorization".into(), format!("Bearer {CANARY}"))], ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let mut sp = spec(&s.url("/feed"));
    sp.source = inline(json!({"bearer": CANARY, "headers": {"X-Api-Key": CANARY}, "query": {"auth": CANARY}, "hello": [CANARY]}));
    let mut c = hub.open(sp, &cancel);
    state(&mut c.state, "connected", 5).await;
    c.link().send("a plain message".into(), Duration::from_secs(5)).await.unwrap();
    let wrong = format!("{CANARY}-WRONG");
    let mut sp = spec(&s.url("/feed"));
    sp.source = inline(json!({"bearer": wrong}));
    let mut r = hub.open(sp, &cancel);
    state(&mut r.state, "refused", 5).await;
    let d = dir();
    let file = d.join("feed.json");
    std::fs::write(&file, json!({"bearer": CANARY}).to_string()).unwrap();
    let mut sp = spec(&s.url("/feed"));
    sp.source = creds::Source::File(file);
    let mut f = hub.open(sp, &cancel);
    state(&mut f.state, "connected", 5).await;
    assert!(parse_target(&format!("wss://feed.example/ws?api_key={CANARY}")).is_err());
    cancel.cancel();
    drop((c, r, f));
    tokio::time::sleep(Duration::from_millis(100)).await;
    let log = capture.finish().await;
    assert!(log.contains("websocket connected"), "positive control: the connection's own lines were captured");
    assert!(log.contains("parse_target("), "verbose positive control: a call line was logged");
    assert!(log.contains("api_key=*****"), "the refused target was logged masked");
    assert!(!log.contains(CANARY), "a credential reached the log:\n{}", log.lines().filter(|l| l.contains(CANARY)).collect::<Vec<_>>().join("\n"));
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn targets_are_ws_urls_without_credentials_fragments_or_secret_queries() {
    let ok = |s: &str| parse_target(s).map(|e| e.url());
    assert_eq!(ok("ws://Feed.Local").unwrap(), "ws://feed.local/");
    assert_eq!(ok("WSS://feed.local:443/api/websocket").unwrap(), "wss://feed.local/api/websocket");
    assert_eq!(ok("ws://127.0.0.1:9222/devtools/page/AB12").unwrap(), "ws://127.0.0.1:9222/devtools/page/AB12");
    assert_eq!(ok("wss://stream.binance.com:9443/ws/btcusdt@trade").unwrap(), "wss://stream.binance.com:9443/ws/btcusdt@trade",
               "an @ in the path is no credential");
    assert_eq!(ok("wss://gateway.discord.gg/?v=10&encoding=json").unwrap(), "wss://gateway.discord.gg/?v=10&encoding=json");
    assert_eq!(ok("ws://[::1]:8080?x=1").unwrap(), "ws://[::1]:8080/?x=1");
    assert_eq!(parse_target("wss://h.example/a?b=c").unwrap().base(), "wss://h.example/a");
    for (bad, why) in [
        ("ws://user:pass@feed", "credentials"),
        ("ws://feed/#frag", "fragment"),
        ("http://feed", "ws://"),
        ("feed:80", "ws://"),
        ("ws://", "ws://"),
        ("ws://feed:0/", "port"),
        ("ws://::1:80/", "brackets"),
        ("ws://feed/a b", "printable ASCII"),
        ("ws://feed/é", "printable ASCII"),
        ("wss://feed/ws?token=abc", "\"token\""),
        ("wss://feed/ws?x=1&access_token=abc", "\"access_token\""),
        ("wss://feed/ws?apiKey=abc", "\"apiKey\""),
        ("wss://feed/ws?X-API-KEY=abc", "credentials"),
        ("wss://feed/ws?auth=abc", "\"auth\""),
        ("wss://feed/ws?hub.verify_token=abc", "credentials"),
    ] {
        let e = parse_target(bad).err().unwrap_or_else(|| panic!("{bad} must be refused"));
        assert!(e.contains(why), "{bad}: {e}");
    }
    assert!(parse_target("ws://localhost:8080/").unwrap().loopback());
    assert!(parse_target("ws://127.0.0.1/").unwrap().loopback());
    assert!(!parse_target("ws://feed.local/").unwrap().loopback());
}

#[test]
fn secret_queries_are_masked_in_logged_text() {
    let m = |s: &str| crate::util::mask_url_secrets(s);
    assert_eq!(m("dial wss://feed/ws?v=1&token=abc&x=2 now").as_deref(), Some("dial wss://feed/ws?v=1&token=*****&x=2 now"));
    assert_eq!(m(r#"{"target":"ws://h/?apiKey=K1&mode=x"}"#).as_deref(), Some(r#"{"target":"ws://h/?apiKey=*****&mode=x"}"#));
    assert_eq!(m("ws://u:p@h/?session=s").as_deref(), Some("ws://*****@h/?session=*****"), "userinfo and query together");
    assert_eq!(m("ws://h/?v=10&encoding=json"), None, "nothing secret, nothing changed");
    assert_eq!(m("https://h/?token=abc"), None, "only websocket URLs' queries");
    assert_eq!(m("https://u:p@h/").as_deref(), Some("https://*****@h/"), "userinfo as before");
}
