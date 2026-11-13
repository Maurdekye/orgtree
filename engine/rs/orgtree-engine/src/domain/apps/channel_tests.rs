//! Piece 4 (live channel; spec section 5, tests 16 and 17): the queue and its limits, the long poll, sends,
//! abandonment, revoke, reconnect and the login header, against the in-process test WebSocket server.
use super::*;
use crate::ws::testserver::{Opts, TestServer};
use tokio_tungstenite::tungstenite::Message as Frame;

type Seen = Arc<Mutex<Vec<Ev>>>;

fn fast() -> ws::Timing {
    ws::Timing::fast()
}

/// A channel to the test server, dialed the way the engine's dialer does: a vetted address and the login header.
async fn open(server: &TestServer, headers: Vec<(String, String)>, abandon: Duration) -> (Arc<Shared>, tokio::task::JoinHandle<()>, Seen) {
    let endpoint = ws::parse_target(&server.url("/api/orgs/galaxy/ws")).unwrap();
    let addr = server.addr;
    let dialer: ws::Dialer = Arc::new(move || {
        let headers = headers.clone();
        Box::pin(async move { Ok(ws::Dial { addr, headers }) })
    });
    let spec = ws::Spec {
        endpoint,
        protocols: vec![],
        hello: vec![],
        heartbeat: None,
        pattern: None,
        source: ws::creds::Source::None,
        extra_headers: vec![],
        dialer: Some(dialer),
        whole: true,
    };
    let cancel = CancellationToken::new();
    let shared = Shared::new("c1".into(), "127.0.0.1".into(), false, true, cancel.clone());
    let conn = ws::Hub::with_timing(fast()).open_with(spec, fast(), &CancellationToken::new());
    shared.set_link(conn.link());
    let seen: Seen = Arc::default();
    let record = seen.clone();
    let task = tokio::spawn(pump(conn, shared.clone(), cancel, abandon, Box::new(move |e| record.lock().unwrap().push(e.clone()))));
    (shared, task, seen)
}

/// Read events until `done` says so (or 5 s pass).
async fn read(shared: &Shared, after: &mut u64, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let mut all: Vec<Value> = Vec::new();
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end && !done(&all) {
        let got = shared.recv(*after, Duration::from_millis(200)).await.unwrap();
        for e in got["events"].as_array().unwrap() {
            *after = e["seq"].as_u64().unwrap();
            all.push(e.clone());
        }
        if got["closed"] == true && got["events"].as_array().unwrap().is_empty() {
            break;
        }
    }
    all
}
fn texts(events: &[Value]) -> Vec<String> {
    events.iter().filter(|e| e["type"] == "message").map(|e| e["text"].as_str().unwrap().to_owned()).collect()
}
fn states(events: &[Value]) -> Vec<String> {
    events.iter().filter(|e| e["type"] == "state").map(|e| e["state"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn the_queue_holds_256_events_or_4_mib_and_forgets_what_the_app_acknowledged() {
    let mut q = Queue::new();
    for i in 0..QUEUE_EVENTS {
        assert!(q.push(Ev::Message(format!("m{i}"))), "{i}");
    }
    assert!(!q.push(Ev::Message("one too many".into())), "the 257th queued event overflows");
    let mut q = Queue::new();
    assert!(q.push(Ev::Message("a".repeat(QUEUE_BYTES))));
    assert!(!q.push(Ev::Message("b".into())), "past 4 MiB overflows");
    // Acknowledged events leave; the rest keep their order and numbers.
    let mut q = Queue::new();
    for i in 0..5 {
        q.push(Ev::Message(format!("m{i}")));
    }
    let all = q.take(0);
    assert_eq!(all.iter().map(|e| e["seq"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    let rest = q.take(3);
    assert_eq!(rest.iter().map(|e| e["text"].as_str().unwrap()).collect::<Vec<_>>(), vec!["m3", "m4"]);
    assert_eq!(q.len(), 2);
}

#[test]
fn sends_are_limited_to_sixty_a_minute_per_channel() {
    let shared = Shared::new("c".into(), "s".into(), false, true, CancellationToken::new());
    let t0 = Instant::now();
    for i in 0..SENDS_PER_MINUTE {
        assert!(shared.allow_send(t0), "{i}");
    }
    assert!(!shared.allow_send(t0), "the 61st send in a minute");
    assert!(shared.allow_send(t0 + Duration::from_secs(61)), "a minute later it is allowed again");
}

#[test]
fn history_rows_are_limited_to_sixty_an_hour_and_the_next_row_counts_what_was_held_back() {
    let mut gate = HistoryGate::default();
    let t0 = Instant::now();
    for _ in 0..HISTORY_PER_HOUR {
        assert_eq!(gate.admit(t0), Some(0));
    }
    assert_eq!(gate.admit(t0), None);
    assert_eq!(gate.admit(t0), None);
    assert_eq!(gate.admit(t0 + Duration::from_secs(3601)), Some(2), "the next hour's first row stands for the two held back");
}

#[tokio::test]
async fn a_channel_relays_messages_in_order_whole_and_drops_binary_frames() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![], Duration::from_secs(60)).await;
    assert!(server.until(5, |s| s.live() == 1).await);
    let big = "x".repeat(200_000);
    server.push(Frame::Text("one".into()));
    server.push(Frame::Binary(vec![1, 2, 3].into()));
    server.push(Frame::Text(big.clone().into()));
    server.push(Frame::Text("three".into()));
    let mut after = 0;
    let got = read(&shared, &mut after, |e| texts(e).len() >= 3).await;
    assert_eq!(texts(&got), vec!["one".to_string(), big, "three".to_string()], "in order, whole");
    assert_eq!(states(&got).first().map(String::as_str), Some("connecting"), "{got:?}");
    assert!(states(&got).contains(&"open".to_string()));
    assert_eq!(shared.dropped_binary.load(Ordering::Relaxed), 1, "binary frames are counted and dropped");
    shared.end("closed");
    task.await.unwrap();
}

#[tokio::test]
async fn an_app_that_does_not_read_overflows_and_the_channel_closes() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![], Duration::from_secs(60)).await;
    assert!(server.until(5, |s| s.live() == 1).await);
    for i in 0..300 {
        server.push(Frame::Text(format!("m{i}").into()));
    }
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("the channel ends").unwrap();
    assert!(shared.is_closed());
    let got = shared.recv(0, Duration::from_millis(100)).await.unwrap();
    let events = got["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "an overflow keeps none of the queue: {events:?}");
    assert_eq!((events[0]["state"].as_str(), events[0]["reason"].as_str()), (Some("closed"), Some("overflow")));
}

#[tokio::test]
async fn net_recv_is_one_call_at_a_time_and_a_quiet_poll_returns_empty() {
    let shared = Shared::new("c".into(), "s".into(), false, true, CancellationToken::new());
    let first = tokio::spawn({
        let shared = shared.clone();
        async move { shared.recv(0, Duration::from_millis(400)).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let second = shared.recv(0, Duration::from_millis(50)).await.unwrap_err().to_string();
    assert!(second.contains("one net.recv in flight"), "{second}");
    let quiet = first.await.unwrap().unwrap();
    assert_eq!(quiet, json!({"events":[],"closed":false}));
    // A push wakes a waiting poll at once.
    let waiting = tokio::spawn({
        let shared = shared.clone();
        async move { shared.recv(0, Duration::from_secs(5)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    shared.push(Ev::Message("hello".into()));
    let woke = tokio::time::timeout(Duration::from_secs(1), waiting).await.expect("woken by the push").unwrap().unwrap();
    assert_eq!(woke["events"][0]["text"], "hello");
}

#[tokio::test]
async fn send_writes_one_text_frame_and_refuses_oversize_and_the_sixty_first() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![], Duration::from_secs(60)).await;
    assert!(server.until(5, |s| s.live() == 1).await);
    shared.send("hello".into()).await.unwrap();
    assert!(server.until(5, |s| s.got().iter().any(|(_, t)| t == "hello")).await);
    let big = shared.send("y".repeat(SEND_MAX + 1)).await.unwrap_err().to_string();
    assert!(big.contains("at most 64 KiB"), "{big}");
    for _ in 1..SENDS_PER_MINUTE {
        shared.send("x".into()).await.unwrap();
    }
    let limited = shared.send("x".into()).await.unwrap_err().to_string();
    assert!(limited.contains("60 messages a minute"), "{limited}");
    shared.end("closed");
    task.await.unwrap();
    assert!(shared.send("late".into()).await.is_err(), "no send after the channel closed");
}

#[tokio::test]
async fn a_channel_nobody_polls_is_abandoned() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, seen) = open(&server, vec![], Duration::from_millis(400)).await;
    tokio::time::timeout(Duration::from_secs(5), task).await.expect("abandoned").unwrap();
    assert!(shared.is_closed());
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert!(matches!(last, Ev::State { state: "closed", reason: Some(ref r), .. } if r == "abandoned"), "{last:?}");
}

#[tokio::test]
async fn a_revoke_closes_with_a_goodbye_within_a_second() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![], Duration::from_secs(60)).await;
    assert!(server.until(5, |s| s.live() == 1).await);
    let started = Instant::now();
    shared.end("revoked");
    tokio::time::timeout(Duration::from_secs(1), task).await.expect("the task ends within a second").unwrap();
    assert!(server.until(1, |s| s.closes().contains(&1001)).await, "Close 1001 (going away) reached the server");
    assert!(started.elapsed() < Duration::from_secs(1));
    let got = shared.recv(0, Duration::from_millis(100)).await.unwrap();
    let last = got["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["state"].as_str(), last["reason"].as_str()), (Some("closed"), Some("revoked")));
    assert_eq!(got["closed"], true);
}

#[tokio::test]
async fn after_the_server_comes_back_the_first_state_says_reconnected() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![], Duration::from_secs(60)).await;
    assert!(server.until(5, |s| s.live() == 1).await);
    let mut after = 0;
    let first = read(&shared, &mut after, |e| states(e).contains(&"open".to_string())).await;
    assert!(first.iter().all(|e| e["reconnected"].is_null()), "the first open is not a reconnect: {first:?}");
    server.stop();
    let down = read(&shared, &mut after, |e| states(e).contains(&"down".to_string())).await;
    assert!(states(&down).contains(&"down".to_string()), "{down:?}");
    server.restart().await;
    let back = read(&shared, &mut after, |e| states(e).contains(&"open".to_string())).await;
    let open = back.iter().find(|e| e["state"] == "open").expect("open again");
    assert_eq!(open["reconnected"], true, "messages sent meanwhile were missed: {back:?}");
    shared.end("closed");
    task.await.unwrap();
}

#[tokio::test]
async fn the_dialers_login_header_goes_on_the_upgrade_and_the_state_says_so() {
    let server = TestServer::start(Opts::default()).await;
    let (shared, task, _) = open(&server, vec![("Authorization".into(), "Bearer ENGINE-HELD".into())], Duration::from_secs(60)).await;
    shared.set_login(true);
    assert!(server.until(5, |s| s.live() == 1).await);
    let seen = server.seen();
    assert!(seen.iter().any(|s| s.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("authorization") && v == "Bearer ENGINE-HELD")), "{seen:?}");
    let mut after = 0;
    let got = read(&shared, &mut after, |e| states(e).contains(&"open".to_string())).await;
    let open = got.iter().find(|e| e["state"] == "open").unwrap();
    assert_eq!(open["login"], true, "the app learns that a login is attached, nothing more");
    assert!(!got.iter().any(|e| e.to_string().contains("ENGINE-HELD")));
    shared.end("closed");
    task.await.unwrap();
}

#[test]
fn the_registry_limits_channels_closes_them_on_revoke_and_binds_them_to_their_copy() {
    let r = crate::domain::apps::net::Registry::default();
    let open = |panel: &str| r.open_channel(1, "viewer", panel, 7, "nas:8642", false, true);
    let (a, _) = open("p1").unwrap();
    let (b, _) = open("p1").unwrap();
    assert!(open("p1").is_err(), "a third channel on one panel copy");
    let (c, _) = open("p2").unwrap();
    let (d, _) = open("p2").unwrap();
    assert!(open("p3").is_err(), "a fifth channel for the app");
    // A copy's channels are found only by that copy and run.
    assert!(r.channel(1, "viewer", "p1", 7, &a.id).is_ok());
    assert!(r.channel(1, "viewer", "p2", 7, &a.id).is_err(), "another copy never finds it");
    assert!(r.channel(1, "viewer", "p1", 8, &a.id).is_err(), "nor another run");
    assert!(r.channel(2, "viewer", "p1", 7, &a.id).is_err(), "nor another org");
    // Hide ends that copy's channels; closed ones stop counting.
    r.forget_once(1, "p1");
    assert_eq!((a.reason(), b.reason()), ("hidden".to_string(), "hidden".to_string()));
    a.finish("hidden");
    b.finish("hidden");
    assert!(open("p3").is_ok(), "closed channels free their places");
    // A saved-login change closes the site's channels; a revoke closes the rest.
    r.close_site_channels(1, "viewer", "nas:8642", "login changed");
    assert_eq!(c.reason(), "login changed");
    let (e, _) = r.open_channel(1, "viewer", "p9", 7, "other:1", false, true).unwrap();
    r.revoke(1, Some("viewer"), None);
    assert_eq!(e.reason(), "revoked");
    assert_eq!(d.reason(), "login changed", "the first reason stands");
}
