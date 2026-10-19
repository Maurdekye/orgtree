//! The hub against the in-process test broker (`testbroker.rs`): no network
//! beyond 127.0.0.1, fast clocks ([`Timing::fast`]).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rumqttc::ConnectReturnCode;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::testbroker::{self, Opts, TestBroker};
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
            keep_alive: Duration::from_secs(5),
            linger: Duration::from_millis(100),
            kick_gap: Duration::from_millis(50),
            jitter: false,
            dedupe: Duration::from_millis(200),
        }
    }
}

const CANARY: &str = "PW-CANARY-48151623";

/// The test broker by IP (its certificate names 127.0.0.1 too), so no test
/// depends on how this machine resolves localhost.
fn broker_of(b: &TestBroker, tls: bool) -> Broker {
    Broker { tls, host: "127.0.0.1".into(), port: b.addr.port() }
}

fn key(hub: &Hub, org: i64, broker: Broker, source: &creds::Source, client_id: Option<&str>) -> ConnKey {
    ConnKey { org_id: org, broker, identity: hub.identity(source), client_id: client_id.map(str::to_string) }
}

fn inline(user: &str, pass: &str) -> creds::Source {
    creds::Source::Inline(Arc::new(creds::inline_from_args(&json!({"username": user, "password": pass})).unwrap()))
}

fn tag(row: i64) -> Tag {
    Tag { row, owner: 1 }
}

async fn attach(hub: &Hub, key: &ConnKey, source: &creds::Source, filter: &str, row: i64, cancel: &CancellationToken) -> Attachment {
    hub.attach(key.clone(), source.clone(), filter, tag(row), cancel).await.expect("attached")
}

/// Wait until the attachment's connection is in state `name`.
async fn state(a: &mut Attachment, name: &str, secs: u64) -> State {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let now = a.state.borrow_and_update().state.clone();
        if now.name() == name {
            return now;
        }
        if tokio::time::timeout_at(deadline, a.state.changed()).await.is_err() {
            panic!("connection did not reach {name} within {secs}s; it is {now:?}");
        }
    }
}

/// The next message (or refusal) within `ms`, if any; grants are skipped.
async fn next(a: &mut Attachment, ms: u64) -> Option<Delivery> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        match tokio::time::timeout_at(deadline, a.rx.recv()).await.ok().flatten() {
            Some(Delivery::Subscribed { .. }) => continue,
            other => return other,
        }
    }
}

#[tokio::test]
async fn a_granted_subscription_is_confirmed_to_its_dog() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut a = attach(&hub, &k, &src, "home/#", 1, &cancel).await;
    match tokio::time::timeout(Duration::from_secs(5), a.rx.recv()).await.ok().flatten() {
        Some(Delivery::Subscribed { filter }) => assert_eq!(filter, "home/#"),
        other => panic!("expected the grant, got {other:?}"),
    }
    assert_eq!(a.key, k, "an attachment knows its connection");
    cancel.cancel();
}

async fn message(a: &mut Attachment) -> Message {
    match next(a, 3000).await {
        Some(Delivery::Message(m)) => m,
        other => panic!("expected a message, got {other:?}"),
    }
}

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("orgtree-mqtt-hub-{}", crate::util::random_hex(6)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn dogs_with_equal_keys_share_one_connection_and_each_gets_its_messages() {
    let b = TestBroker::start(Opts { copy_per_subscription: true, ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut all = attach(&hub, &k, &src, "home/#", 1, &cancel).await;
    let mut temp = attach(&hub, &k, &src, "home/+/temperature", 2, &cancel).await;
    state(&mut all, "connected", 5).await;
    assert!(b.until(3, |b| b.filters() == vec!["home/#".to_string(), "home/+/temperature".to_string()]).await, "{:?}", b.filters());
    assert_eq!((b.accepted(), b.live(), hub.connections()), (1, 1, 1), "one connection for both dogs");
    // two overlapping subscriptions: the broker sends two copies, each dog gets one
    b.publish("home/kitchen/temperature", "21.5", false);
    assert_eq!(message(&mut all).await.payload, "21.5");
    assert_eq!(message(&mut temp).await.payload, "21.5");
    assert!(next(&mut all, 300).await.is_none() && next(&mut temp, 50).await.is_none(), "the second copy is folded away");
    b.publish("home/door", "open", false);
    let m = message(&mut all).await;
    assert_eq!((m.topic.as_str(), m.retained), ("home/door", false));
    assert!(next(&mut temp, 200).await.is_none(), "a filter that does not match gets nothing");
    // another org never shares
    let other = key(&hub, 2, broker_of(&b, false), &src, None);
    let mut third = attach(&hub, &other, &src, "home/#", 3, &cancel).await;
    state(&mut third, "connected", 5).await;
    assert_eq!((b.accepted(), hub.connections()), (2, 2));
    cancel.cancel();
}

#[tokio::test]
async fn a_dropped_connection_comes_back_and_subscribes_again() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut a = attach(&hub, &k, &src, "ci/+/status", 1, &cancel).await;
    state(&mut a, "connected", 5).await;
    b.drop_all();
    let down = state(&mut a, "down", 5).await;
    assert!(matches!(down, State::Down { ref error, .. } if error.contains("closed")), "{down:?}");
    state(&mut a, "connected", 5).await;
    assert!(b.until(3, |b| b.filters() == vec!["ci/+/status".to_string()]).await, "subscribed again after the reconnect");
    b.publish("ci/build/status", "green", false);
    assert_eq!(message(&mut a).await.payload, "green");
    assert_eq!(b.accepted(), 2);
    cancel.cancel();
}

#[tokio::test]
async fn an_unavailable_broker_is_retried_with_growing_waits_not_a_tight_loop() {
    let b = TestBroker::start(Opts { refuse: Some(ConnectReturnCode::ServiceUnavailable), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut a = attach(&hub, &k, &src, "x/#", 1, &cancel).await;
    let s = state(&mut a, "down", 5).await;
    assert!(matches!(s, State::Down { ref error, .. } if error.contains("CONNACK 3")), "{s:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // waits 50, 100, 200, 400, 400 ms: about six attempts in 1.5 s; a tight loop makes hundreds
    let n = b.connects();
    assert!((3..=9).contains(&n), "{n} attempts in 1.5 s");
    // it comes back on its own once the broker serves again
    b.set_opts(|o| o.refuse = None);
    state(&mut a, "connected", 5).await;
    cancel.cancel();
}

#[tokio::test]
async fn refused_logins_retry_slowly_and_a_fixed_credentials_file_is_read_on_the_next_try() {
    let b = TestBroker::start(Opts { login: Some(("ha".into(), CANARY.into())), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let d = dir();
    let file = d.join("broker.json");
    std::fs::write(&file, r#"{"username":"ha","password":"wrong"}"#).unwrap();
    let src = creds::Source::File(file.clone());
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut a = attach(&hub, &k, &src, "home/#", 1, &cancel).await;
    let s = state(&mut a, "refused", 5).await;
    assert!(matches!(s, State::Refused { ref error, .. } if error.contains("username or password")), "{s:?}");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let n = b.connects();
    assert!((2..=3).contains(&n), "refusals wait 300 then 600 ms: {n} attempts");
    std::fs::write(&file, format!(r#"{{"username":"ha","password":"{CANARY}"}}"#)).unwrap();
    a.kick();
    state(&mut a, "connected", 2).await;
    assert_eq!(b.logins().last().unwrap().password.as_deref(), Some(CANARY), "the file was read again for the retry");
    std::fs::remove_dir_all(&d).ok();
    cancel.cancel();
}

#[tokio::test]
async fn a_refused_subscription_reaches_only_its_own_dogs() {
    let b = TestBroker::start(Opts { refuse_filters: vec!["secret/#".into()], ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut secret = attach(&hub, &k, &src, "secret/#", 1, &cancel).await;
    let mut public = attach(&hub, &k, &src, "public/#", 2, &cancel).await;
    state(&mut secret, "connected", 5).await;
    match next(&mut secret, 3000).await {
        Some(Delivery::Refused { filter }) => assert_eq!(filter, "secret/#"),
        other => panic!("expected the refusal, got {other:?}"),
    }
    assert!(b.until(3, |b| b.filters() == vec!["public/#".to_string()]).await);
    b.publish("public/news", "hello", false);
    assert_eq!(message(&mut public).await.payload, "hello");
    assert!(next(&mut public, 100).await.is_none(), "no refusal for a filter the broker granted");
    cancel.cancel();
}

#[tokio::test]
async fn retained_messages_arrive_flagged_and_a_new_dog_gets_them_too() {
    let b = TestBroker::start(Opts::default()).await;
    b.publish("state/door", "open", true);
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut first = attach(&hub, &k, &src, "state/#", 1, &cancel).await;
    let m = message(&mut first).await;
    assert_eq!((m.topic.as_str(), m.payload.as_ref(), m.retained), ("state/door", &b"open"[..], true));
    b.publish("state/door", "closed", false);
    assert!(!message(&mut first).await.retained, "a live message is not retained");
    // a second dog on the held filter subscribes again, so it sees the retained state too
    let mut second = attach(&hub, &k, &src, "state/#", 2, &cancel).await;
    let m = message(&mut second).await;
    assert!(m.retained && m.payload == "open", "{m:?}");
    assert!(message(&mut first).await.retained, "the first dog sees the replay flagged as retained (its runner ignores or folds it)");
    cancel.cancel();
}

#[tokio::test]
async fn dollar_topics_reach_only_filters_that_name_them() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut sys = attach(&hub, &k, &src, "$SYS/#", 1, &cancel).await;
    let mut all = attach(&hub, &k, &src, "#", 2, &cancel).await;
    state(&mut sys, "connected", 5).await;
    assert!(b.until(3, |b| b.filters().len() == 2).await);
    b.publish("$SYS/broker/uptime", "42", false);
    assert_eq!(message(&mut sys).await.payload, "42");
    assert!(next(&mut all, 300).await.is_none(), "# does not match a $ topic");
    cancel.cancel();
}

#[tokio::test]
async fn the_last_dog_leaving_closes_the_connection_after_the_linger() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut one = attach(&hub, &k, &src, "a/#", 1, &cancel).await;
    let two = attach(&hub, &k, &src, "b/#", 2, &cancel).await;
    state(&mut one, "connected", 5).await;
    assert!(b.until(3, |b| b.filters().len() == 2).await);
    drop(two);
    assert!(b.until(3, |b| b.filters() == vec!["a/#".to_string()]).await, "the leaving dog's filter is unsubscribed: {:?}", b.filters());
    drop(one);
    assert!(b.until(3, |b| b.live() == 0).await, "closed once its last dog left");
    assert_eq!(hub.connections(), 0);
    // a dog arriving later opens a fresh one
    let mut again = attach(&hub, &k, &src, "a/#", 3, &cancel).await;
    state(&mut again, "connected", 5).await;
    assert_eq!(b.accepted(), 2);
    cancel.cancel();
}

#[tokio::test]
async fn an_oversized_message_resets_the_connection_which_then_recovers() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::None;
    let k = key(&hub, 1, broker_of(&b, false), &src, None);
    let mut a = attach(&hub, &k, &src, "cam/#", 1, &cancel).await;
    state(&mut a, "connected", 5).await;
    assert!(b.until(3, |b| b.filters().len() == 1).await);
    b.publish("cam/frame", vec![0u8; MAX_PACKET + 1024], false);
    let s = state(&mut a, "down", 5).await;
    assert!(matches!(s, State::Down { ref error, .. } if error.contains("packet limit")), "{s:?}");
    state(&mut a, "connected", 5).await;
    assert!(b.until(3, |b| b.filters().len() == 1).await);
    b.publish("cam/status", "ok", false);
    assert_eq!(message(&mut a).await.payload, "ok");
    cancel.cancel();
}

#[tokio::test]
async fn mqtts_trusts_the_given_ca_presents_the_client_certificate_and_refuses_a_wrong_name() {
    let certs = testbroker::certs();
    let b = TestBroker::start(Opts { tls: Some(certs.server_requiring_client.clone()), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let d = dir();
    std::fs::write(d.join("ca.pem"), &certs.ca_pem).unwrap();
    std::fs::write(d.join("client.pem"), &certs.client_cert_pem).unwrap();
    std::fs::write(d.join("client.key"), &certs.client_key_pem).unwrap();
    let file = d.join("broker.json");
    std::fs::write(&file, r#"{"ca_file":"ca.pem","cert_file":"client.pem","key_file":"client.key"}"#).unwrap();
    let src = creds::Source::File(file.clone());
    let k = key(&hub, 1, broker_of(&b, true), &src, None);
    let mut a = attach(&hub, &k, &src, "secure/#", 1, &cancel).await;
    state(&mut a, "connected", 5).await;
    assert!(b.until(3, |b| b.filters().len() == 1).await);
    b.publish("secure/x", "tls ok", false);
    assert_eq!(message(&mut a).await.payload, "tls ok");
    drop(a);
    // the same CA, but no client certificate: the broker's handshake refuses us
    let only_ca = d.join("only-ca.json");
    std::fs::write(&only_ca, r#"{"ca_file":"ca.pem"}"#).unwrap();
    let src2 = creds::Source::File(only_ca);
    let k2 = key(&hub, 1, broker_of(&b, true), &src2, None);
    let mut no_cert = attach(&hub, &k2, &src2, "secure/#", 2, &cancel).await;
    let s = state(&mut no_cert, "refused", 5).await;
    assert!(matches!(s, State::Refused { ref error, .. } if error.starts_with("TLS")), "{s:?}");
    drop(no_cert);
    // a server whose certificate names another host
    let wrong = TestBroker::start(Opts { tls: Some(certs.wrong_name.clone()), ..Default::default() }).await;
    let k3 = key(&hub, 1, broker_of(&wrong, true), &src2, None);
    let mut w = attach(&hub, &k3, &src2, "secure/#", 3, &cancel).await;
    let s = state(&mut w, "refused", 5).await;
    assert!(matches!(s, State::Refused { ref error, .. } if error.contains("TLS") && error.to_lowercase().contains("name")), "{s:?}");
    // without the custom CA (Mozilla roots only) our test CA is not trusted
    let k4 = key(&hub, 1, broker_of(&b, true), &creds::Source::None, None);
    let mut public = attach(&hub, &k4, &creds::Source::None, "secure/#", 4, &cancel).await;
    let s = state(&mut public, "refused", 5).await;
    assert!(matches!(s, State::Refused { ref error, .. } if error.starts_with("TLS")), "{s:?}");
    std::fs::remove_dir_all(&d).ok();
    cancel.cancel();
}

#[tokio::test]
async fn an_explicit_client_id_is_used_and_a_second_use_is_detected() {
    let b = TestBroker::start(Opts::default()).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let src = creds::Source::Inline(Arc::new(creds::inline_from_args(&json!({"username": "u", "client_id": "kitchen-dog"})).unwrap()));
    let k = key(&hub, 1, broker_of(&b, false), &src, Some("kitchen-dog"));
    let mut a = attach(&hub, &k, &src, "k/#", 1, &cancel).await;
    state(&mut a, "connected", 5).await;
    assert_eq!(b.logins().last().unwrap().client_id, "kitchen-dog");
    let other = inline("v", "w");
    let clash = key(&hub, 1, broker_of(&b, false), &other, Some("kitchen-dog"));
    assert!(hub.client_id_taken(&clash), "two credentials on one client id would take each other's session");
    assert!(!hub.client_id_taken(&k), "a dog joining the same connection is no clash");
    let none = key(&hub, 1, broker_of(&b, false), &other, None);
    assert!(!hub.client_id_taken(&none), "generated ids never clash");
    let default = attach(&hub, &none, &other, "k/#", 2, &cancel).await;
    assert!(b.until(3, |b| b.logins().len() == 2).await);
    assert!(b.logins()[1].client_id.starts_with("orgtree-"), "{:?}", b.logins()[1]);
    drop(default);
    cancel.cancel();
}

/// Verbose engine logging on, rumqttc's `log` records forwarded: neither a
/// password that connects nor one that is refused may reach the log.
#[tokio::test]
async fn no_password_reaches_the_engine_log() {
    use std::sync::Mutex;
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    struct VerboseReset(bool);
    impl Drop for VerboseReset {
        fn drop(&mut self) {
            crate::trace::set_verbose(self.0);
        }
    }
    let capture = Capture(Arc::new(Mutex::new(Vec::new())));
    let (dispatch, guard) = crate::trace::test_sink(capture.clone());
    let subscriber = tracing::dispatcher::set_default(&dispatch);
    let _ = tracing_log::LogTracer::init();
    let _verbose = VerboseReset(crate::trace::set_verbose(true));
    let b = TestBroker::start(Opts { login: Some(("ha".into(), CANARY.into())), ..Default::default() }).await;
    let hub = Hub::with_timing(Timing::fast());
    let cancel = CancellationToken::new();
    let good = inline("ha", CANARY);
    let k = key(&hub, 1, broker_of(&b, false), &good, None);
    let mut a = attach(&hub, &k, &good, "home/#", 1, &cancel).await;
    state(&mut a, "connected", 5).await;
    let wrong = format!("{CANARY}-WRONG");
    let bad = inline("ha", &wrong);
    let k2 = key(&hub, 1, broker_of(&b, false), &bad, None);
    let mut r = attach(&hub, &k2, &bad, "home/#", 2, &cancel).await;
    state(&mut r, "refused", 5).await;
    let d = dir();
    let file = d.join("broker.json");
    std::fs::write(&file, format!(r#"{{"username":"ha","password":"{CANARY}"}}"#)).unwrap();
    let file_src = creds::Source::File(file);
    let k3 = key(&hub, 1, broker_of(&b, false), &file_src, None);
    let mut f = attach(&hub, &k3, &file_src, "home/#", 3, &cancel).await;
    state(&mut f, "connected", 5).await;
    cancel.cancel();
    drop((a, r, f));
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(subscriber);
    drop(dispatch);
    drop(guard);
    let log = String::from_utf8_lossy(&capture.0.lock().unwrap()).to_string();
    assert!(log.contains("mqtt.Hub.attach(") || log.contains("Hub.attach("), "verbose positive control: the attach call line was logged");
    assert!(log.contains("mqtt connected"), "positive control: the connection's own lines were captured");
    assert!(!log.contains(CANARY), "a password reached the log:\n{}", log.lines().filter(|l| l.contains(CANARY)).collect::<Vec<_>>().join("\n"));
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn targets_are_broker_urls_without_credentials_paths_or_queries() {
    let ok = |s: &str| parse_target(s).map(|b| b.url());
    assert_eq!(ok("mqtt://broker.local").unwrap(), "mqtt://broker.local:1883");
    assert_eq!(ok("MQTTS://Broker.Local").unwrap(), "mqtts://broker.local:8883");
    assert_eq!(ok("mqtt://10.0.0.5:11883/").unwrap(), "mqtt://10.0.0.5:11883");
    assert_eq!(ok("mqtts://[::1]:8884").unwrap(), "mqtts://[::1]:8884");
    assert_eq!(ok(" mqtt://h_1.example ").unwrap(), "mqtt://h_1.example:1883");
    for (bad, why) in [
        ("mqtt://user:pass@broker", "credentials"),
        ("mqtt://broker/topic", "no path"),
        ("mqtt://broker?client_id=x", "no path"),
        ("http://broker", "mqtt://"),
        ("broker:1883", "mqtt://"),
        ("mqtt://", "mqtt://"),
        ("mqtt://broker:0", "port"),
        ("mqtt://broker:70000", "port"),
        ("mqtt://::1:1883", "brackets"),
        ("mqtt://bro ker", "mqtt://"),
        ("mqtt://-bad-.host", "host name"),
    ] {
        let e = parse_target(bad).err().unwrap_or_else(|| panic!("{bad} must be refused"));
        assert!(e.contains(why), "{bad}: {e}");
    }
    assert!(parse_target("mqtt://localhost").unwrap().loopback());
    assert!(parse_target("mqtt://127.0.0.1").unwrap().loopback());
    assert!(!parse_target("mqtt://broker.local").unwrap().loopback());
}
