//! Baseline-red contract tests, written before the short-429 fix.
use super::*;

fn good(usage: &Usage, key: &str) -> Instant {
    usage.claude_result(key, json!({"available":true,"observed_at":"2026-01-01T00:00:00Z",
        "limits":[{"kind":"session","percent":23}]}));
    usage.cache.pin().get(key).unwrap().at
}

#[test]
fn short429_recent_reading_is_quiet_and_keeps_its_age() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    let auth_at = usage.auth.pin().get(&key).unwrap().at;
    let out = usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(2));
    assert_eq!(out["available"], true);
    assert_eq!(out["limits"][0]["percent"], 23);
    assert_eq!(out["observed_at"], "2026-01-01T00:00:00Z");
    assert!(out["error"].is_null(), "routine wait must not render refresh failed");
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
    assert_eq!(usage.auth.pin().get(&key).unwrap().at, auth_at);
}

#[test]
fn short429_stale_reading_uses_existing_unavailable_presentation() {
    let usage = Usage::default();
    let key = claude_key(None);
    good(&usage, &key);
    let old = Instant::now() - PEEK_MAX;
    let data = usage.cached(&key).unwrap();
    usage.cache.pin().insert(key.clone(), Cached { at: old, data });
    let out = usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(2));
    assert_eq!(out["available"], false, "900s is stale, not another successful reading");
    assert_eq!(out["observed_at"], "2026-01-01T00:00:00Z");
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, old);
    assert!(out["error"].as_str().is_some_and(|s| !s.contains("failed")));
}

#[test]
fn short429_long_wait_uses_pause_text_and_unavailable_presentation() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    let out = usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(3600));
    assert_eq!(out["available"], false, "a long wait must not enter the available/error branch");
    assert!(out["error"].as_str().is_some_and(|s| s.contains("paused") && !s.contains("failed")));
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
}

#[test]
fn short429_without_last_good_is_unavailable_without_new_cache_or_auth() {
    let usage = Usage::default();
    let key = claude_key(None);
    let out = usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(2));
    assert_eq!(out["available"], false);
    assert!(out["error"].as_str().is_some_and(|s| !s.contains("failed")));
    assert!(usage.cached(&key).is_none());
    assert_eq!(usage.cached_reauth_required(&key), None);
}

#[test]
fn short429_does_not_change_real_auth_rejection_or_other_errors() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    let out = usage.claude_result(&key, json!({"available":false,"error":"sign in again",
        "reauth_required":true,"reauth_evidence":"measured_403"}));
    assert_eq!(out["error"], "sign in again");
    assert_eq!(out["reauth_required"], true);
    assert_eq!(usage.cached_reauth_required(&key), Some(true));
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
    let out = usage.claude_result(&key, json!({"available":false,"error":"HTTP 500"}));
    assert_eq!(out["error"], "HTTP 500");
    assert_eq!(usage.cached_reauth_required(&key), Some(true));
}

#[test]
fn short429_first_response_and_repeated_wait_never_redate_auth_or_bars() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    let auth_at = usage.auth.pin().get(&key).unwrap().at;
    let out = usage.claude_result(&key, json!({"available":false,"retry_after_seconds":2,"detail":"HTTP 429"}));
    assert!(out["error"].is_null());
    assert_eq!(out["available"], true);
    assert!(!usage.claude_attempt(&key, Instant::now()));
    let repeat = usage.claude_retained(&key);
    assert!(repeat["error"].is_null());
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
    assert_eq!(usage.auth.pin().get(&key).unwrap().at, auth_at);
}

#[test]
fn short429_floor_counts_sequential_forced_and_automatic_callers_per_account() {
    let usage = Usage::default();
    let key = claude_key(None);
    let other = claude_key(Some("synthetic-other"));
    let now = Instant::now();
    // These are the common admission calls used by HTTP force, normal
    // background reads and permitted tool reads; there is no force bypass.
    let calls = [0, 1, 2, 10, 20, 30, 45, 59, 60, 61, 119, 120];
    let probes = calls.into_iter().filter(|s|
        usage.claude_attempt(&key, now + Duration::from_secs(*s))).count();
    assert_eq!(probes, 3);
    assert!(usage.claude_attempt(&other, now));
    assert!(!usage.claude_attempt(&other, now + Duration::from_secs(59)));
    assert!(usage.claude_attempt(&other, now + Duration::from_secs(60)));
    println!("Claude synthetic floor: 12 mixed/sequential calls, 3 admitted at 0/60/120s; sibling 2/3 independently admitted");
}

#[test]
fn short429_expiry_retries_inside_floor_once_and_cache_reads_do_not_fetch() {
    let usage = Usage::default();
    let key = claude_key(None);
    let now = Instant::now();
    assert!(usage.claude_attempt(&key, now));
    usage.cooldown.pin().insert(key.clone(), now + Duration::from_secs(2));
    assert!(!usage.claude_retry_due(&key, now + Duration::from_secs(1)));
    assert!(!usage.claude_attempt(&key, now + Duration::from_secs(1)));
    let attempt = *usage.claude_attempts.pin().get(&key).unwrap();
    for _ in 0..100 {
        usage.snapshot(&key, Utc::now());
        usage.peek(&key, "claude");
    }
    assert_eq!(*usage.claude_attempts.pin().get(&key).unwrap(), attempt);
    assert!(usage.claude_retry_due(&key, now + Duration::from_secs(2)));
    assert!(usage.claude_attempt(&key, now + Duration::from_secs(2)));
    assert!(!usage.claude_retry_due(&key, now + Duration::from_secs(2)));
    assert!(!usage.claude_attempt(&key, now + Duration::from_secs(3)));
    assert!(usage.claude_attempt(&key, now + Duration::from_secs(62)));
    println!("Claude synthetic retry: 1 initial + 1 deadline retry; 100 board-style peek/snapshot pairs add 0 admissions");
}

#[test]
fn short429_long_cooldown_cannot_be_bypassed_by_force_floor_expiry() {
    let usage = Usage::default();
    let key = claude_key(None);
    let now = Instant::now();
    assert!(usage.claude_attempt(&key, now));
    usage.cooldown.pin().insert(key.clone(), now + Duration::from_secs(3600));
    for s in [1, 60, 120, 3599] {
        assert!(!usage.claude_attempt(&key, now + Duration::from_secs(s)));
        assert!(!usage.claude_retry_due(&key, now + Duration::from_secs(s)));
    }
    assert!(usage.claude_retry_due(&key, now + Duration::from_secs(3600)));
    assert!(usage.claude_attempt(&key, now + Duration::from_secs(3600)));
}

#[test]
fn short429_exact_short_boundary_and_other_account_cache_are_preserved() {
    let usage = Usage::default();
    let key = claude_key(None);
    let sibling = claude_key(Some("synthetic-sibling"));
    good(&usage, &key);
    let sibling_at = good(&usage, &sibling);
    assert!(usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(60))["error"].is_null());
    assert_eq!(usage.claude_cooldown(&key, Instant::now() + Duration::from_secs(61))["available"], false);
    usage.claude_result(&key, json!({"available":false,"retry_after_seconds":2}));
    assert!(usage.cooling(&sibling).is_none());
    assert_eq!(usage.cache.pin().get(&sibling).unwrap().at, sibling_at);
    assert_eq!(usage.cached(&sibling).unwrap()["available"], true);
}

#[test]
fn short429_manual_floor_returns_recent_reading_quietly_without_redating() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    assert!(!usage.claude_attempt(&key, Instant::now()));
    let out = usage.claude_retained(&key);
    assert_eq!(out["available"], true);
    assert!(out["error"].is_null());
    assert_eq!(usage.cache.pin().get(&key).unwrap().at, at);
}

#[test]
fn short429_success_after_retry_clears_pause_and_updates_reading_once() {
    let usage = Usage::default();
    let key = claude_key(None);
    let at = good(&usage, &key);
    usage.claude_result(&key, json!({"available":false,"retry_after_seconds":2}));
    usage.cooldown.pin().insert(key.clone(), Instant::now());
    assert!(usage.claude_attempt(&key, Instant::now()));
    let out = usage.claude_result(&key, json!({"available":true,"observed_at":"2026-01-01T00:01:00Z",
        "limits":[{"percent":24}]}));
    assert!(out["error"].is_null());
    assert_eq!(out["limits"][0]["percent"], 24);
    assert_eq!(out["observed_at"], "2026-01-01T00:01:00Z");
    assert!(usage.cache.pin().get(&key).unwrap().at > at);
    assert!(!usage.claude_retry_due(&key, Instant::now()));
}

#[tokio::test]
async fn short429_concurrent_callers_receive_one_inflight_result() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let usage = Arc::new(Usage::default());
    let count = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let key = claude_key(None);
    let leader = {
        let usage = usage.clone();
        let count = count.clone();
        let started = started.clone();
        let finish = finish.clone();
        let key = key.clone();
        tokio::spawn(async move {
            usage.claude_flight(&key, || async {
                count.fetch_add(1, Ordering::SeqCst);
                started.notify_one();
                finish.notified().await;
                json!({"available":false,"error":"sign in again","reauth_required":true})
            }).await
        })
    };
    started.notified().await;
    // Poll all followers until they actually await the existing reservation,
    // then finish the leader. No sleep/timing assumption makes the barrier.
    let mut followers: Vec<_> = (0..16).map(|_| Box::pin(usage.claude_flight(&key, || async {
        count.fetch_add(1, Ordering::SeqCst);
        json!({"unexpected":"second probe"})
    }))).collect();
    for follower in &mut followers {
        assert!(futures::poll!(follower.as_mut()).is_pending());
    }
    assert!(usage.reserve("claude:other-account").is_some(), "unrelated accounts do not wait");
    finish.notify_one();
    let expected = leader.await.unwrap();
    for follower in followers {
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), follower).await.unwrap(), expected);
    }
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(usage.probing.pin().get(&key).is_none());
    println!("Claude synthetic concurrency: 17 callers, 1 probe, 17 identical auth-error results; sibling reservation independent");
}

#[tokio::test]
async fn short429_cancelled_leader_wakes_follower_and_releases_reservation() {
    let usage = Usage::default();
    let key = claude_key(None);
    let mut leader = Box::pin(usage.claude_flight(&key, || std::future::pending()));
    assert!(futures::poll!(leader.as_mut()).is_pending());
    let mut follower = Box::pin(usage.claude_flight(&key, || async { json!({"available":true}) }));
    assert!(futures::poll!(follower.as_mut()).is_pending());
    drop(leader);
    assert_eq!(tokio::time::timeout(Duration::from_secs(2), follower).await.unwrap()["available"], true);
    assert!(usage.probing.pin().get(&key).is_none());
}

#[tokio::test]
async fn short429_cancelled_waiter_cannot_cancel_leader() {
    let usage = Usage::default();
    let key = claude_key(None);
    let mut leader = Box::pin(usage.claude_flight(&key, || async {
        tokio::task::yield_now().await;
        json!({"available":true,"limits":[]})
    }));
    assert!(futures::poll!(leader.as_mut()).is_pending());
    let mut waiter = Box::pin(usage.claude_flight(&key, || async { json!({"unexpected":true}) }));
    assert!(futures::poll!(waiter.as_mut()).is_pending());
    drop(waiter);
    assert!(usage.reserve(&key).is_none());
    assert_eq!(leader.await["available"], true);
    assert!(usage.probing.pin().get(&key).is_none());
}
