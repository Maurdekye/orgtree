//! The Claude usage backoff never schedules past two minutes, and a failed
//! probe names its cause in the log with closed values only.
use super::claude_failure::{error_failure, status_failure, take, ProbeFailure};
use super::*;

#[test]
fn backoff_grows_from_a_minute_and_never_passes_two() {
    let secs: Vec<u64> = (1..=12).map(|s| claude_backoff(s).as_secs()).collect();
    assert_eq!(secs, [60, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120]);
}

#[test]
fn a_long_run_of_429s_still_retries_within_two_minutes_and_recovers() {
    let usage = Usage::default();
    let key = claude_key(None);
    for _ in 0..8 {
        usage.claude_result(&key, json!({"available": false, "retry_after_seconds": 1}));
    }
    let wait = usage.claude_next_attempt(&key).expect("a next attempt").saturating_duration_since(Instant::now());
    assert!(wait <= Duration::from_secs(120), "next attempt in {wait:?}");
    // the floor is kept: not before a minute has gone by
    assert!(!usage.claude_attempt(&key, Instant::now() + Duration::from_secs(30)));
    assert!(usage.claude_attempt(&key, Instant::now() + Duration::from_secs(121)));
    // the first good read clears the streak
    usage.claude_result(&key, json!({"available": true, "limits": []}));
    assert!(usage.claude_throttles.pin().get(&key).is_none());
    assert!(usage.claude_next_attempt(&key).unwrap().saturating_duration_since(Instant::now()) <= Duration::from_secs(60));
}

#[test]
fn a_provider_wait_longer_than_two_minutes_is_still_honoured() {
    let usage = Usage::default();
    let key = claude_key(None);
    let before = Instant::now();
    usage.claude_result(&key, json!({"available": false, "retry_after_seconds": 600}));
    assert!(*usage.cooldown.pin().get(&key).unwrap() >= before + Duration::from_secs(600));
    assert!(usage.claude_next_attempt(&key).unwrap() >= before + Duration::from_secs(600));
}

#[test]
fn an_unexpected_answer_names_its_status_and_leaks_no_body() {
    let body = "<html>secret-token-abc123 someone@example.test</html>";
    let f = status_failure(503, body);
    assert_eq!((f["failure_kind"].as_str(), f["failure_http"].as_u64(), f["failure_1010"].as_bool()), (Some("http"), Some(503), Some(false)));
    let text = f.to_string();
    assert!(!text.contains("secret-token") && !text.contains("example.test"), "{text}");
    let blocked = status_failure(403, "error code: 1010");
    assert_eq!(blocked["failure_1010"].as_bool(), Some(true));
    assert_eq!(blocked["failure_http"].as_u64(), Some(403));
}

#[test]
fn the_failure_fields_are_taken_out_of_the_result() {
    let mut raw = json!({"available": false, "error": "usage unavailable", "detail": "HTTP 503: x"});
    for (k, v) in status_failure(503, "x").as_object().unwrap() { raw[k] = v.clone(); }
    assert_eq!(take(&mut raw), ProbeFailure { kind: "http", http: 503, cloudflare_1010: false });
    assert_eq!(raw, json!({"available": false, "error": "usage unavailable", "detail": "HTTP 503: x"}), "nothing of it is left to be cached or shown");
    assert_eq!(take(&mut raw), ProbeFailure { kind: "none", http: 0, cloudflare_1010: false }, "a result without them reads none");
}

#[tokio::test]
async fn transport_errors_have_a_closed_kind() {
    let client = reqwest::Client::builder().timeout(Duration::from_millis(150)).build().unwrap();
    let refused = client.get("http://127.0.0.1:1/usage").send().await.unwrap_err();
    assert_eq!(error_failure(&refused), "connect");
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/usage", l.local_addr().unwrap());
    let hold = tokio::spawn(async move { let (s, _) = l.accept().await.unwrap(); tokio::time::sleep(Duration::from_secs(2)).await; drop(s) });
    let slow = client.get(&url).send().await.unwrap_err();
    assert_eq!(error_failure(&slow), "timeout");
    hold.abort();
}
