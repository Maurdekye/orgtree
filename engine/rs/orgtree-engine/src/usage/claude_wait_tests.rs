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
