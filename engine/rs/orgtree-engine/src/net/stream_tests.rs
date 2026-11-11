//! The poller's hub stream (spec-hub-websocket.md 14 and 15.3, E1 to E5):
//! one `Carrier` per poller carries each poll over `GET /api/stream` when
//! the hub lists `stream`, and tells the poller to use HTTP otherwise. The
//! fake hub speaks HTTP (`/healthz`) and the WebSocket side on one port and
//! records what it was asked. `Carrier::with_time_div(600)` makes a minute
//! of back-off 100 ms.

use super::stream::{Carrier, Polled};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Debug, PartialEq)]
enum Plan {
    Normal,
    /// drop the socket when the first request arrives
    DropOnRequest,
    /// close with this code instead of welcoming
    CloseAtHello(u16),
}

#[derive(Default)]
struct State {
    features: Vec<String>,
    version: String,
    /// 0: accept the upgrade; else answer it with this status (empty body)
    upgrade_status: u16,
    /// a refused upgrade turns the hub into a 2.4.0 one
    downgrade_on_refusal: bool,
    plans: Vec<Plan>,
    /// what every poll answers
    messages: Vec<Value>,
    /// every upgrade request: (uri, headers)
    seen: Vec<(String, Vec<(String, String)>)>,
    /// every poll frame: (connection, id, wait)
    frames: Vec<(usize, u64, u64)>,
    /// close codes clients sent
    closes: Vec<u16>,
}

struct Fake {
    addr: String,
    state: Arc<Mutex<State>>,
    upgrades: Arc<AtomicUsize>,
    connections: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fake(features: &[&str]) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(State { features: features.iter().map(|f| f.to_string()).collect(), version: "2.5.0".into(), ..Default::default() }));
    let (upgrades, connections) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (s2, u2, c2) = (state.clone(), upgrades.clone(), connections.clone());
    let task = tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let (s, u, c) = (s2.clone(), u2.clone(), c2.clone());
            tokio::spawn(async move { serve(sock, s, u, c).await });
        }
    });
    Fake { addr, state, upgrades, connections, task }
}

async fn serve(mut sock: TcpStream, state: Arc<Mutex<State>>, upgrades: Arc<AtomicUsize>, connections: Arc<AtomicUsize>) {
    let mut buf = vec![0u8; 8192];
    let mut n;
    loop {
        n = sock.peek(&mut buf).await.unwrap_or(0);
        if n == 0 {
            return;
        }
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    let first = head.lines().next().unwrap_or("").to_string();
    if head.to_ascii_lowercase().contains("upgrade: websocket") {
        upgrades.fetch_add(1, Ordering::SeqCst);
        let status = state.lock().unwrap().upgrade_status;
        if status != 0 {
            {
                let mut st = state.lock().unwrap();
                if st.downgrade_on_refusal {
                    st.features = vec!["poll".into()];
                    st.version = "2.4.0".into();
                }
            }
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(format!("HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).await;
            return;
        }
        let conn = connections.fetch_add(1, Ordering::SeqCst) + 1;
        let plan = state.lock().unwrap().plans.get(conn - 1).cloned().unwrap_or(Plan::Normal);
        let st2 = state.clone();
        let cb = move |req: &Request, mut resp: Response| {
            let headers = req.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
            st2.lock().unwrap().seen.push((req.uri().to_string(), headers));
            resp.headers_mut().insert("sec-websocket-protocol", "orgtree-hub-stream.1".parse().unwrap());
            Ok(resp)
        };
        let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(sock, cb).await else { return };
        session(&mut ws, state, conn, plan).await;
        return;
    }
    // plain HTTP: only /healthz
    let mut total = 0;
    while total < n {
        let k = sock.read(&mut buf[total..n]).await.unwrap_or(0);
        if k == 0 {
            break;
        }
        total += k;
    }
    let (status, body) = {
        let st = state.lock().unwrap();
        if first.contains("/healthz") {
            (200, json!({ "ok": true, "name": "fake", "orgs": 1, "version": st.version, "features": st.features }))
        } else {
            (404, json!({ "detail": "Not Found" }))
        }
    };
    let body = body.to_string();
    let _ = sock.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
}

type Ws = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn session(ws: &mut Ws, state: Arc<Mutex<State>>, conn: usize, plan: Plan) {
    let Some(Ok(Message::Text(_hello))) = ws.next().await else { return };
    if let Plan::CloseAtHello(code) = plan {
        let _ = ws.send(Message::Close(Some(CloseFrame { code: code.into(), reason: "no".into() }))).await;
        return;
    }
    let _ = ws.send(Message::Text(json!({ "type": "welcome", "v": 1, "slugs": ["ann.fake"], "ping_s": 25, "max_request": 55 }).to_string().into())).await;
    while let Some(Ok(m)) = ws.next().await {
        match m {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["type"] != "poll" {
                    continue;
                }
                let id = v["id"].as_u64().unwrap();
                let wait = v["body"]["wait"].as_u64().unwrap_or(0);
                state.lock().unwrap().frames.push((conn, id, wait));
                if plan == Plan::DropOnRequest {
                    return;
                }
                let msgs = state.lock().unwrap().messages.clone();
                let body = json!({ "name": "fake", "version": "2.5.0", "roster": [], "messages": msgs, "receipts": [] });
                let _ = ws.send(Message::Text(json!({ "type": "answer", "id": id, "status": 200, "body": body }).to_string().into())).await;
            }
            Message::Close(f) => {
                state.lock().unwrap().closes.push(f.map(|f| u16::from(f.code)).unwrap_or(1005));
                let _ = ws.close(None).await;
                return;
            }
            _ => {}
        }
    }
}

fn msg(n: usize) -> Value {
    json!({ "id": format!("m{n}"), "from": "bob.fake", "to": "ann.fake", "body": format!("body {n}") })
}

async fn poll(c: &mut Carrier, f: &Fake, wait: u64) -> Polled {
    tokio::time::timeout(Duration::from_secs(5), c.poll(&f.addr, "ann.fake:secret", wait)).await.expect("poll finished")
}

fn answer(p: Polled) -> (u16, Value) {
    match p {
        Polled::Answer(s, b) => (s, b),
        other => panic!("expected the stream's answer, got {other:?}"),
    }
}

// E1: a hub that lists `stream` carries polls over one stream, reused between polls
#[tokio::test]
async fn e1_feature_present_polls_go_over_one_stream() {
    let f = fake(&["poll", "stream"]).await;
    f.state.lock().unwrap().messages.push(msg(1));
    let mut c = Carrier::with_time_div(600);
    let (s, b) = answer(poll(&mut c, &f, 0).await);
    assert_eq!(s, 200);
    assert_eq!(b["messages"][0]["id"], "m1");
    let (s, _) = answer(poll(&mut c, &f, 55).await);
    assert_eq!(s, 200);
    assert_eq!((f.upgrades.load(Ordering::SeqCst), f.connections.load(Ordering::SeqCst)), (1, 1), "one upgrade for both polls");
    let frames = f.state.lock().unwrap().frames.clone();
    assert_eq!(frames.iter().map(|(_, id, wait)| (*id, *wait)).collect::<Vec<_>>(), [(1, 0), (2, 55)], "ids rise, the wait is carried: {frames:?}");
}

// E1: a dropped stream is reconnected and the same poll is asked again
#[tokio::test]
async fn e1_a_dropped_stream_is_asked_again_on_a_new_one() {
    let f = fake(&["poll", "stream"]).await;
    f.state.lock().unwrap().plans = vec![Plan::DropOnRequest];
    f.state.lock().unwrap().messages.push(msg(1));
    let mut c = Carrier::with_time_div(600);
    let (s, b) = answer(poll(&mut c, &f, 55).await);
    assert_eq!((s, b["messages"][0]["id"].as_str()), (200, Some("m1")));
    let frames = f.state.lock().unwrap().frames.clone();
    assert_eq!(frames.iter().map(|(conn, _, wait)| (*conn, *wait)).collect::<Vec<_>>(), [(1, 55), (2, 55)], "{frames:?}");
}

// E2: no feature, or a 403-empty handshake (a downgrade): HTTP, with no further upgrade attempt
#[tokio::test]
async fn e2_an_old_hub_gets_the_http_poller() {
    let f = fake(&["poll"]).await;
    let mut c = Carrier::with_time_div(600);
    assert!(matches!(poll(&mut c, &f, 0).await, Polled::Http));
    assert!(matches!(poll(&mut c, &f, 55).await, Polled::Http));
    assert_eq!(f.upgrades.load(Ordering::SeqCst), 0, "no upgrade is attempted against a hub without the feature");

    let g = fake(&["poll", "stream"]).await;
    {
        let mut st = g.state.lock().unwrap();
        st.upgrade_status = 403;
        st.downgrade_on_refusal = true;
    }
    let mut c = Carrier::with_time_div(600);
    assert!(matches!(poll(&mut c, &g, 0).await, Polled::Http), "403-empty: look again, find no feature");
    assert!(matches!(poll(&mut c, &g, 55).await, Polled::Http));
    assert_eq!(g.upgrades.load(Ordering::SeqCst), 1, "the one refused attempt");
}

// 9.3: a refused handshake with the feature listed falls back and retries on a schedule
#[tokio::test]
async fn e2_a_refused_handshake_falls_back_and_retries_after_a_minute() {
    let f = fake(&["poll", "stream"]).await;
    f.state.lock().unwrap().upgrade_status = 426;
    let mut c = Carrier::with_time_div(600);
    assert!(matches!(poll(&mut c, &f, 0).await, Polled::Http));
    assert!(matches!(poll(&mut c, &f, 0).await, Polled::Http));
    assert_eq!(f.upgrades.load(Ordering::SeqCst), 1, "not again before the first minute is up");
    tokio::time::sleep(Duration::from_millis(130)).await; // a "minute" is 100 ms
    f.state.lock().unwrap().upgrade_status = 0;
    let (s, _) = answer(poll(&mut c, &f, 0).await);
    assert_eq!(s, 200, "the retry found a working stream");
    assert_eq!(f.connections.load(Ordering::SeqCst), 1);
}

// E3: a carrier that goes away (the members changed, the poller restarted) closes its stream with 1000
#[tokio::test]
async fn e3_dropping_the_carrier_closes_the_stream_normally() {
    let f = fake(&["poll", "stream"]).await;
    let mut c = Carrier::with_time_div(600);
    answer(poll(&mut c, &f, 0).await);
    drop(c);
    for _ in 0..100 {
        if !f.state.lock().unwrap().closes.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(f.state.lock().unwrap().closes, [1000]);
    // a new carrier (the new poller) opens its own stream with its own header
    let mut c2 = Carrier::with_time_div(600);
    assert_eq!(answer(poll(&mut c2, &f, 0).await).0, 200);
    assert_eq!(f.connections.load(Ordering::SeqCst), 2);
}

// E4: 4401 reaches the poller as a 401 once; a second in a row means HTTP
#[tokio::test]
async fn e4_4401_is_a_401_once_then_the_long_poll() {
    let f = fake(&["poll", "stream"]).await;
    f.state.lock().unwrap().plans = vec![Plan::CloseAtHello(4401), Plan::CloseAtHello(4401)];
    let mut c = Carrier::with_time_div(600);
    assert_eq!(answer(poll(&mut c, &f, 0).await).0, 401);
    assert!(matches!(poll(&mut c, &f, 0).await, Polled::Http), "a second 401 in a row: HTTP runs today's 401 handling");
}

// E5: no Origin, no secret in the URL, the subprotocol offered, the secret in X-Org-Auth
#[tokio::test]
async fn e5_the_handshake_has_no_origin_and_no_secret_in_the_url() {
    let f = fake(&["poll", "stream"]).await;
    let mut c = Carrier::with_time_div(600);
    answer(poll(&mut c, &f, 0).await);
    let seen = f.state.lock().unwrap().seen.clone();
    assert_eq!(seen.len(), 1);
    let (uri, headers) = &seen[0];
    assert_eq!(uri, "/api/stream", "the path only, no query");
    let get = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(get("x-org-auth").as_deref(), Some("ann.fake:secret"));
    assert_eq!(get("origin"), None);
    assert!(get("sec-websocket-protocol").is_some_and(|p| p.contains("orgtree-hub-stream.1")));
    assert!(!uri.contains("secret"));
}
