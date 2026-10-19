//! An in-process WebSocket server for the websocket tests: 127.0.0.1 only,
//! with switches for the ways a real server behaves (refusing the upgrade
//! with a status, requiring headers, choosing a subprotocol, echoing,
//! closing with a code, going silent, TLS with or without client
//! certificates). It records what each client sent.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct Opts {
    pub tls: Option<Arc<rustls::ServerConfig>>,
    /// Answer every upgrade with this HTTP status (and Retry-After seconds).
    pub refuse: Option<(u16, Option<u64>)>,
    /// Headers every client must send with these values; else HTTP 401.
    pub require: Vec<(String, String)>,
    /// The subprotocol chosen when the client offers it.
    pub protocol: Option<String>,
    /// Choose a subprotocol the client did not offer (a broken server).
    pub wrong_protocol: bool,
    /// Answer every text message with "echo:" and the message.
    pub echo: bool,
    /// After the upgrade, never read again (so never answer a ping).
    pub mute: bool,
    /// Close every connection right after the upgrade, with this code and reason.
    pub close_with: Option<(u16, String)>,
}

/// One accepted upgrade request.
#[derive(Clone, Debug)]
pub struct Seen {
    /// Path and query.
    pub uri: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Default)]
struct Inner {
    opts: Mutex<Opts>,
    sessions: Mutex<HashMap<u64, CancellationToken>>,
    seen: Mutex<Vec<Seen>>,
    /// Text messages received: (connection number, text).
    got: Mutex<Vec<(u64, String)>>,
    /// Close codes clients sent.
    closes: Mutex<Vec<u16>>,
    dials: AtomicU64,
    upgrades: AtomicU64,
    next: AtomicU64,
    listener: Mutex<Option<CancellationToken>>,
    push: Mutex<Option<broadcast::Sender<Frame>>>,
}

#[derive(Clone)]
pub struct TestServer {
    pub addr: SocketAddr,
    inner: Arc<Inner>,
}

impl TestServer {
    pub async fn start(opts: Opts) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a test port");
        let addr = listener.local_addr().unwrap();
        let (push, _) = broadcast::channel(1024);
        let inner = Arc::new(Inner { opts: Mutex::new(opts), push: Mutex::new(Some(push)), ..Default::default() });
        let s = TestServer { addr, inner };
        s.listen(listener);
        s
    }

    /// `ws://127.0.0.1:<port><path>` (wss with TLS).
    pub fn url(&self, path: &str) -> String {
        let tls = self.inner.opts.lock().unwrap().tls.is_some();
        format!("{}://127.0.0.1:{}{path}", if tls { "wss" } else { "ws" }, self.addr.port())
    }

    fn listen(&self, listener: TcpListener) {
        let stop = CancellationToken::new();
        *self.inner.listener.lock().unwrap() = Some(stop.clone());
        let inner = self.inner.clone();
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stop.cancelled() => return,
                    a = listener.accept() => a,
                };
                let Ok((tcp, _)) = accepted else { continue };
                inner.dials.fetch_add(1, Ordering::SeqCst);
                let inner = inner.clone();
                let tls = inner.opts.lock().unwrap().tls.clone();
                tokio::spawn(async move {
                    match tls {
                        None => serve(inner, tcp).await,
                        Some(cfg) => {
                            let acceptor = tokio_rustls::TlsAcceptor::from(cfg);
                            if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(tcp)).await {
                                serve(inner, stream).await;
                            }
                        }
                    }
                });
            }
        });
    }

    /// Stop listening and drop every client: the server is down.
    pub fn stop(&self) {
        if let Some(t) = self.inner.listener.lock().unwrap().take() {
            t.cancel();
        }
        self.drop_all();
    }

    /// Listen again on the same port.
    pub async fn restart(&self) {
        let mut tries = 0;
        let listener = loop {
            match TcpListener::bind(self.addr).await {
                Ok(l) => break l,
                Err(_) if tries < 50 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => panic!("the test port came back busy: {e}"),
            }
        };
        self.listen(listener);
    }

    /// Close every client's connection (the server stays up).
    pub fn drop_all(&self) {
        for (_, kill) in self.inner.sessions.lock().unwrap().drain() {
            kill.cancel();
        }
    }

    pub fn set_opts(&self, f: impl FnOnce(&mut Opts)) {
        f(&mut self.inner.opts.lock().unwrap());
    }

    /// Send a frame to every connected client.
    pub fn push(&self, frame: Frame) {
        if let Some(p) = self.inner.push.lock().unwrap().as_ref() {
            let _ = p.send(frame);
        }
    }

    /// TCP connections accepted, upgraded or not.
    pub fn dials(&self) -> u64 {
        self.inner.dials.load(Ordering::SeqCst)
    }

    /// Upgrades accepted.
    pub fn upgrades(&self) -> u64 {
        self.inner.upgrades.load(Ordering::SeqCst)
    }

    /// Clients connected now.
    pub fn live(&self) -> usize {
        self.inner.sessions.lock().unwrap().len()
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.inner.seen.lock().unwrap().clone()
    }

    /// Text messages received, in order, with their connection's number.
    pub fn got(&self) -> Vec<(u64, String)> {
        self.inner.got.lock().unwrap().clone()
    }

    pub fn closes(&self) -> Vec<u16> {
        self.inner.closes.lock().unwrap().clone()
    }

    /// Wait (at most `secs`) until `cond` holds; false on timeout.
    pub async fn until(&self, secs: u64, cond: impl Fn(&TestServer) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        while tokio::time::Instant::now() < deadline {
            if cond(self) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cond(self)
    }
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(inner: Arc<Inner>, stream: S) {
    let opts = inner.opts.lock().unwrap().clone();
    let record = inner.clone();
    let callback = move |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        let headers: Vec<(String, String)> = req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let uri = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_default();
        record.seen.lock().unwrap().push(Seen { uri, headers: headers.clone() });
        let status = |code: u16, retry: Option<u64>| {
            let mut r = http::Response::builder().status(code);
            if let Some(s) = retry {
                r = r.header("Retry-After", s.to_string());
            }
            r.body(None).unwrap()
        };
        if let Some((code, retry)) = opts.refuse {
            return Err(status(code, retry));
        }
        let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        for (k, v) in &opts.require {
            if header(k).as_deref() != Some(v.as_str()) {
                return Err(status(401, None));
            }
        }
        let offered = header("sec-websocket-protocol").unwrap_or_default();
        if opts.wrong_protocol {
            resp.headers_mut().insert("sec-websocket-protocol", "never-offered".parse().unwrap());
        } else if let Some(p) = &opts.protocol {
            if offered.split(',').any(|o| o.trim() == p) {
                resp.headers_mut().insert("sec-websocket-protocol", p.parse().unwrap());
            }
        }
        Ok(resp)
    };
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
    inner.upgrades.fetch_add(1, Ordering::SeqCst);
    let n = inner.next.fetch_add(1, Ordering::SeqCst);
    let kill = CancellationToken::new();
    inner.sessions.lock().unwrap().insert(n, kill.clone());
    let mut push = inner.push.lock().unwrap().as_ref().map(|p| p.subscribe());
    if let Some((code, reason)) = &opts.close_with {
        let _ = ws.close(Some(CloseFrame { code: CloseCode::from(*code), reason: reason.as_str().into() })).await;
        inner.sessions.lock().unwrap().remove(&n);
        return;
    }
    if opts.mute {
        kill.cancelled().await;
        inner.sessions.lock().unwrap().remove(&n);
        return;
    }
    loop {
        tokio::select! {
            _ = kill.cancelled() => break,
            frame = ws.next() => match frame {
                Some(Ok(Frame::Text(t))) => {
                    inner.got.lock().unwrap().push((n, t.as_str().to_string()));
                    if opts.echo && ws.send(Frame::Text(format!("echo:{}", t.as_str()).into())).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Frame::Close(f))) => {
                    inner.closes.lock().unwrap().push(f.map(|f| u16::from(f.code)).unwrap_or(1005));
                    break;
                }
                Some(Ok(_)) => {}
                _ => break,
            },
            frame = async { match push.as_mut() { Some(p) => p.recv().await.ok(), None => std::future::pending().await } } => {
                if let Some(frame) = frame {
                    if ws.send(frame).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    inner.sessions.lock().unwrap().remove(&n);
}
