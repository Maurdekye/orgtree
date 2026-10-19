//! A small in-process MQTT 3.1.1 broker for tests, on 127.0.0.1 only. It
//! speaks through rumqttc's own packet codec and can refuse logins, refuse
//! single subscriptions, keep retained messages, count connections, drop
//! every client, stop and restart listening on the same port, and serve TLS
//! (optionally requiring a client certificate). Tests only: its locks are
//! std mutexes held for a moment.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use rumqttc::{ConnAck, ConnectReturnCode, Packet, Publish, QoS, SubAck, SubscribeReasonCode, UnsubAck};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MAX: usize = 4 << 20;

#[derive(Clone, Default)]
pub struct Opts {
    /// Credentials every client must present; None lets anyone in.
    pub login: Option<(String, String)>,
    /// Refuse every CONNECT with this code.
    pub refuse: Option<ConnectReturnCode>,
    /// Answer SUBSCRIBE for these filters with a failure (0x80).
    pub refuse_filters: Vec<String>,
    /// Send one copy of a message per matching subscription, as Mosquitto
    /// does for overlapping filters.
    pub copy_per_subscription: bool,
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

/// What a client sent in its CONNECT.
#[derive(Clone, Debug)]
pub struct Login {
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

struct Session {
    tx: mpsc::UnboundedSender<Packet>,
    subs: Vec<String>,
    kill: CancellationToken,
}

#[derive(Default)]
struct Inner {
    opts: Mutex<Opts>,
    sessions: Mutex<HashMap<u64, Session>>,
    retained: Mutex<BTreeMap<String, Bytes>>,
    logins: Mutex<Vec<Login>>,
    connects: AtomicU64,
    accepted: AtomicU64,
    subscribes: AtomicU64,
    next: AtomicU64,
    listener: Mutex<Option<CancellationToken>>,
}

#[derive(Clone)]
pub struct TestBroker {
    pub addr: SocketAddr,
    inner: Arc<Inner>,
}

impl TestBroker {
    pub async fn start(opts: Opts) -> TestBroker {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a test port");
        let addr = listener.local_addr().unwrap();
        let inner = Arc::new(Inner { opts: Mutex::new(opts), ..Default::default() });
        let b = TestBroker { addr, inner };
        b.listen(listener);
        b
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
                let inner = inner.clone();
                let tls = inner.opts.lock().unwrap().tls.clone();
                tokio::spawn(async move {
                    match tls {
                        None => serve(inner, tcp).await,
                        Some(cfg) => {
                            let acceptor = rumqttc::tokio_rustls::TlsAcceptor::from(cfg);
                            if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(5), acceptor.accept(tcp)).await {
                                serve(inner, stream).await;
                            }
                        }
                    }
                });
            }
        });
    }

    /// Stop listening and drop every client: the broker is down.
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

    /// Close every client's connection (the broker stays up).
    pub fn drop_all(&self) {
        for (_, s) in self.inner.sessions.lock().unwrap().drain() {
            s.kill.cancel();
        }
    }

    pub fn set_opts(&self, f: impl FnOnce(&mut Opts)) {
        f(&mut self.inner.opts.lock().unwrap());
    }

    /// Publish as another client would: kept when `retain` (an empty
    /// payload clears), and sent at once to every matching subscriber.
    pub fn publish(&self, topic: &str, payload: impl Into<Bytes>, retain: bool) {
        let payload = payload.into();
        if retain {
            let mut r = self.inner.retained.lock().unwrap();
            if payload.is_empty() {
                r.remove(topic);
            } else {
                r.insert(topic.to_string(), payload.clone());
            }
        }
        let copies = self.inner.opts.lock().unwrap().copy_per_subscription;
        for s in self.inner.sessions.lock().unwrap().values() {
            let n = s.subs.iter().filter(|f| super::topic::matches(f, topic)).count();
            let n = if copies { n } else { n.min(1) };
            for _ in 0..n {
                let _ = s.tx.send(Packet::Publish(Publish::from_bytes(topic, QoS::AtMostOnce, payload.clone())));
            }
        }
    }

    /// CONNECT packets seen, whatever the answer.
    pub fn connects(&self) -> u64 {
        self.inner.connects.load(Ordering::SeqCst)
    }

    /// Connections accepted (CONNACK 0).
    pub fn accepted(&self) -> u64 {
        self.inner.accepted.load(Ordering::SeqCst)
    }

    /// SUBSCRIBE packets seen.
    pub fn subscribes(&self) -> u64 {
        self.inner.subscribes.load(Ordering::SeqCst)
    }

    /// Clients connected now.
    pub fn live(&self) -> usize {
        self.inner.sessions.lock().unwrap().len()
    }

    /// Every filter held now, across clients.
    pub fn filters(&self) -> Vec<String> {
        let mut f: Vec<String> = self.inner.sessions.lock().unwrap().values().flat_map(|s| s.subs.clone()).collect();
        f.sort();
        f
    }

    pub fn logins(&self) -> Vec<Login> {
        self.inner.logins.lock().unwrap().clone()
    }

    /// Wait (at most `secs`) until `cond` holds; false on timeout.
    pub async fn until(&self, secs: u64, cond: impl Fn(&TestBroker) -> bool) -> bool {
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

async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(inner: Arc<Inner>, stream: S) {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let mut buf = BytesMut::new();
    let Some(Packet::Connect(connect)) = next(&mut rd, &mut buf).await else { return };
    inner.connects.fetch_add(1, Ordering::SeqCst);
    let (user, pass) = match &connect.login {
        Some(l) => (Some(l.username.clone()), Some(l.password.clone())),
        None => (None, None),
    };
    inner.logins.lock().unwrap().push(Login { client_id: connect.client_id.clone(), username: user.clone(), password: pass.clone() });
    let opts = inner.opts.lock().unwrap().clone();
    let code = match (opts.refuse, &opts.login) {
        (Some(code), _) => code,
        (None, Some((u, p))) if user.as_deref() != Some(u.as_str()) || pass.as_deref() != Some(p.as_str()) => ConnectReturnCode::BadUserNamePassword,
        _ => ConnectReturnCode::Success,
    };
    if write(&mut wr, &Packet::ConnAck(ConnAck::new(code, false))).await.is_err() || code != ConnectReturnCode::Success {
        return;
    }
    inner.accepted.fetch_add(1, Ordering::SeqCst);
    let id = inner.next.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::unbounded_channel::<Packet>();
    let kill = CancellationToken::new();
    inner.sessions.lock().unwrap().insert(id, Session { tx: tx.clone(), subs: Vec::new(), kill: kill.clone() });
    let writer = tokio::spawn({
        let kill = kill.clone();
        async move {
            loop {
                tokio::select! {
                    _ = kill.cancelled() => break,
                    p = rx.recv() => match p {
                        Some(p) => if write(&mut wr, &p).await.is_err() { break },
                        None => break,
                    },
                }
            }
            let _ = wr.shutdown().await;
        }
    });
    loop {
        let packet = tokio::select! {
            _ = kill.cancelled() => break,
            p = next(&mut rd, &mut buf) => p,
        };
        match packet {
            Some(Packet::Subscribe(s)) => {
                inner.subscribes.fetch_add(1, Ordering::SeqCst);
                let refuse = inner.opts.lock().unwrap().refuse_filters.clone();
                let mut codes = Vec::new();
                let mut fresh = Vec::new();
                for f in &s.filters {
                    if refuse.contains(&f.path) {
                        codes.push(SubscribeReasonCode::Failure);
                    } else {
                        codes.push(SubscribeReasonCode::Success(QoS::AtMostOnce));
                        fresh.push(f.path.clone());
                    }
                }
                if let Some(sess) = inner.sessions.lock().unwrap().get_mut(&id) {
                    for f in &fresh {
                        if !sess.subs.contains(f) {
                            sess.subs.push(f.clone());
                        }
                    }
                }
                let _ = tx.send(Packet::SubAck(SubAck::new(s.pkid, codes)));
                // retained messages for each filter just subscribed, RETAIN set
                for (topic, payload) in inner.retained.lock().unwrap().iter() {
                    if fresh.iter().any(|f| super::topic::matches(f, topic)) {
                        let mut p = Publish::from_bytes(topic.clone(), QoS::AtMostOnce, payload.clone());
                        p.retain = true;
                        let _ = tx.send(Packet::Publish(p));
                    }
                }
            }
            Some(Packet::Unsubscribe(u)) => {
                if let Some(sess) = inner.sessions.lock().unwrap().get_mut(&id) {
                    sess.subs.retain(|f| !u.topics.contains(f));
                }
                let _ = tx.send(Packet::UnsubAck(UnsubAck::new(u.pkid)));
            }
            Some(Packet::PingReq) => {
                let _ = tx.send(Packet::PingResp);
            }
            Some(Packet::Disconnect) | None => break,
            Some(_) => {}
        }
    }
    inner.sessions.lock().unwrap().remove(&id);
    kill.cancel();
    let _ = writer.await;
}

async fn next<R: AsyncRead + Unpin>(rd: &mut R, buf: &mut BytesMut) -> Option<Packet> {
    loop {
        match Packet::read(buf, MAX) {
            Ok(p) => return Some(p),
            Err(rumqttc::mqttbytes::Error::InsufficientBytes(_)) => {}
            Err(_) => return None,
        }
        let mut chunk = [0u8; 4096];
        match rd.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

async fn write<W: AsyncWrite + Unpin>(wr: &mut W, p: &Packet) -> std::io::Result<()> {
    let mut out = BytesMut::new();
    p.write(&mut out, MAX).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    wr.write_all(&out).await?;
    wr.flush().await
}

/// A test CA with a server certificate for 127.0.0.1/localhost and a client
/// certificate, all PEM.
pub struct Certs {
    pub ca_pem: String,
    pub server: Arc<rustls::ServerConfig>,
    pub server_requiring_client: Arc<rustls::ServerConfig>,
    pub client_cert_pem: String,
    pub client_key_pem: String,
    /// A server certificate for another name, signed by the same CA.
    pub wrong_name: Arc<rustls::ServerConfig>,
}

pub fn certs() -> Certs {
    use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    let ca = CertifiedIssuer::self_signed(ca_params, KeyPair::generate().unwrap()).unwrap();
    let leaf = |names: Vec<String>, usage: ExtendedKeyUsagePurpose| {
        let key = KeyPair::generate().unwrap();
        let mut p = CertificateParams::new(names).unwrap();
        p.extended_key_usages = vec![usage];
        let cert = p.signed_by(&key, &ca).unwrap();
        (cert, key)
    };
    let (server_cert, server_key) = leaf(vec!["localhost".into(), "127.0.0.1".into()], ExtendedKeyUsagePurpose::ServerAuth);
    let (other_cert, other_key) = leaf(vec!["broker.elsewhere.test".into()], ExtendedKeyUsagePurpose::ServerAuth);
    let (client_cert, client_key) = leaf(vec!["orgtree-test-client".into()], ExtendedKeyUsagePurpose::ClientAuth);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let key_der = |k: &KeyPair| PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(k.serialize_der()));
    let builder = || rustls::ServerConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap();
    let server = builder().with_no_client_auth().with_single_cert(vec![server_cert.der().clone()], key_der(&server_key)).unwrap();
    let wrong_name = builder().with_no_client_auth().with_single_cert(vec![other_cert.der().clone()], key_der(&other_key)).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(ca.der().to_vec())).unwrap();
    let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().unwrap();
    let requiring = builder().with_client_cert_verifier(verifier).with_single_cert(vec![server_cert.der().clone()], key_der(&server_key)).unwrap();
    Certs {
        ca_pem: ca.pem(),
        server: Arc::new(server),
        server_requiring_client: Arc::new(requiring),
        client_cert_pem: client_cert.pem(),
        client_key_pem: client_key.serialize_pem(),
        wrong_name: Arc::new(wrong_name),
    }
}
