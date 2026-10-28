//! A request-rate 429 is not a usage limit.
//!
//! Measured 2026-10-28 10:04Z: about 34 Codex seats ran on one account and two of them ended a
//! turn with `exceeded retry limit, last status: 429 Too Many Requests`. The account's weekly
//! window was at 8-10 %. `recovery::worded_limit` read "limit" beside "exceeded" as a usage wall,
//! `usage_reset::reported` found no reset time and gave the fallback hour (`parsed=false`), and
//! both agents were frozen as a usage limit for an hour.
//!
//! User 2026-10-28 10:07:18Z mb1ca1568502c: "pretty sure 429 errors should only wait another few
//! minutes before retrying, noit several hours". A request-rate 429 that is not tied to an
//! exhausted usage window is retried behind a short freeze (`connection: true`, `limit: false`,
//! `cause: "rate_limit"`): the provider's `Retry-After` when the CLI relays one, otherwise 60 s
//! doubling to 300 s, at most `RATE_RETRY_MAX` times. A real usage limit still freezes as before.
//! Codex lane only: see docs/rust-engine/rate-limit-retry.md for what the other lanes do.

use chrono::Utc;
use serde_json::{json, Value};

use crate::util::{gist, iso, now_iso};

/// Attempts before the failure is reported instead of retried.
pub const RATE_RETRY_MAX: i64 = 5;
/// The first wait without a `Retry-After`; each further attempt doubles it.
pub const RATE_RETRY_FIRST_S: i64 = 60;
/// The longest wait without a `Retry-After`: a few minutes, never hours.
pub const RATE_RETRY_CAP_S: i64 = 300;
/// A `Retry-After` is honoured between these bounds.
pub const RETRY_AFTER_MIN_S: i64 = 15;
pub const RETRY_AFTER_MAX_S: i64 = 600;
/// What the freeze, the exhausted-retries card and the status text call it.
pub const RATE_KIND: &str = "provider rate limit (HTTP 429)";

/// A turn the provider refused for the request rate; `retry_after` is the provider's own wait in
/// seconds, when the CLI relayed one.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimited {
    pub retry_after: Option<i64>,
}

/// Is this Codex failure a request-rate 429 rather than a usage wall? `info` is the turn's
/// `codex_error` (`{"info": codexErrorInfo, "details": additionalDetails}`, or null);
/// `window_full` says a usage window of the account is known to be exhausted, in which case a 429
/// is the wall.
#[logged]
pub fn rate_limited(_error: &str, _info: &Value, _window_full: bool) -> Option<RateLimited> {
    None
}

/// The provider's own wait in a failure's text (`Retry-After: 30`, `retry after 2 minutes`,
/// `try again in 1m30s`), in seconds.
#[logged]
pub fn retry_after_seconds(_text: &str) -> Option<i64> {
    None
}

/// Seconds to wait before retry number `run` (1-based). `seed` (the agent's id) spreads the agents
/// that were refused together over the next fifth of the wait, never earlier than it.
#[logged]
pub fn delay(_run: i64, _retry_after: Option<i64>, _seed: i64) -> i64 {
    0
}

/// The freeze record for retry `run`. `replay` is the request the refused turn was given, kept
/// when the turn did nothing before the refusal (a Codex thread already holds it).
#[logged]
pub fn freeze(_run: i64, _r: &RateLimited, _error: &str, _account: Option<&str>, _seed: i64,
              _replay: Option<&str>) -> Value {
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const MEASURED: &str = "exceeded retry limit, last status: 429 Too Many Requests";

    fn tag(name: &str, status: i64) -> Value {
        json!({"info": {name: {"httpStatusCode": status}}, "details": null})
    }

    #[test]
    fn the_measured_10_04z_error_is_a_rate_limit_not_a_usage_wall() {
        let some = Some(RateLimited { retry_after: None });
        // as the engine saw it: the message only
        assert_eq!(rate_limited(MEASURED, &Value::Null, false), some);
        // with the app-server's typed tag (the shape tools/rig/proofs/codex-lane.mjs sends)
        assert_eq!(rate_limited(MEASURED, &tag("responseTooManyFailedAttempts", 429), false), some);
        // with the request id Codex appends
        assert_eq!(rate_limited("exceeded retry limit, last status: 429 Too Many Requests, request id: req_8f1",
                                &Value::Null, false), some);
    }

    #[test]
    fn a_typed_rate_limit_tag_is_enough_and_other_statuses_are_not() {
        let some = Some(RateLimited { retry_after: None });
        assert_eq!(rate_limited("Rate limit exceeded", &json!({"info": "rateLimitExceeded"}), false), some);
        assert_eq!(rate_limited("http connection failed", &tag("httpConnectionFailed", 429), false), some);
        assert_eq!(rate_limited("stream connection failed", &tag("responseStreamConnectionFailed", 429), false), some);
        assert_eq!(rate_limited("exceeded retry limit, last status: 500 Internal Server Error",
                                &tag("responseTooManyFailedAttempts", 500), false), None);
        assert_eq!(rate_limited("http connection failed", &tag("httpConnectionFailed", 503), false), None);
    }

    #[test]
    fn a_usage_wall_is_never_a_rate_limit() {
        let wall = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later.";
        // the provider's own tag, with and without words
        assert_eq!(rate_limited(wall, &json!({"info": "usageLimitExceeded"}), false), None);
        assert_eq!(rate_limited("something new", &json!({"info": "usageLimitExceeded"}), false), None);
        assert_eq!(rate_limited(wall, &Value::Null, false), None);
        // a 429 that says what it is
        for text in [
            "unexpected status 429 Too Many Requests: You've hit your usage limit, try again at 3:45 PM",
            "unexpected status 429 Too Many Requests: {\"error\":{\"type\":\"insufficient_quota\",\"message\":\"You exceeded your current quota\"}}",
            "exceeded retry limit, last status: 429 Too Many Requests; usage_limit_reached",
            "429 Too Many Requests: weekly limit reached, resets in 4h 35m",
            "HTTP 429: your plan's credits are used up, upgrade to continue",
        ] {
            assert_eq!(rate_limited(text, &Value::Null, false), None, "{text}");
        }
    }

    #[test]
    fn a_known_exhausted_window_makes_the_429_the_wall() {
        assert_eq!(rate_limited(MEASURED, &Value::Null, true), None);
        assert_eq!(rate_limited(MEASURED, &tag("responseTooManyFailedAttempts", 429), true), None);
    }

    #[test]
    fn other_failures_and_stray_429s_are_not_rate_limits() {
        for text in [
            "the Codex turn failed",
            "stream disconnected before completion: error sending request",
            "network error: ECONNRESET",
            "Input exceeds maximum length: opening input 429 UTF-8 bytes / 429 characters",
            "the process exited with code 4290",
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        ] {
            assert_eq!(rate_limited(text, &Value::Null, false), None, "{text}");
        }
    }

    #[test]
    fn the_providers_own_wait_is_read_when_the_cli_relays_it() {
        for (text, secs) in [
            ("429 Too Many Requests, Retry-After: 30", 30),
            ("last status: 429 (retry-after=45)", 45),
            ("429: Please retry after 2 minutes.", 120),
            ("Rate limit reached ... Please try again in 20s.", 20),
            ("429 Too Many Requests. Try again in 1m30s", 90),
            ("429 Too Many Requests. Try again in 2 minutes and 5 seconds", 125),
        ] {
            assert_eq!(retry_after_seconds(text), Some(secs), "{text}");
        }
        for text in [MEASURED, "429 Too Many Requests, Retry-After: soon", "retry after the weekend", "try again in 0s"] {
            assert_eq!(retry_after_seconds(text), None, "{text}");
        }
        // and it rides on the verdict
        assert_eq!(rate_limited("429 Too Many Requests, Retry-After: 30", &Value::Null, false),
                   Some(RateLimited { retry_after: Some(30) }));
        // the CLI's extra details are read too
        assert_eq!(rate_limited(MEASURED, &json!({"info": "rateLimitExceeded", "details": "retry after 40 seconds"}), false),
                   Some(RateLimited { retry_after: Some(40) }));
    }

    #[test]
    fn the_wait_is_a_few_minutes_doubles_and_never_reaches_hours() {
        let waits: Vec<i64> = (1..=RATE_RETRY_MAX).map(|run| delay(run, None, 0)).collect();
        assert_eq!(waits, vec![60, 120, 240, 300, 300]);
        // even a runaway counter stays at the cap
        assert_eq!(delay(40, None, 0), RATE_RETRY_CAP_S);
        // the provider's wait is honoured within bounds: not busier than 15 s, not longer than 10 min
        assert_eq!(delay(1, Some(30), 0), 30);
        assert_eq!(delay(3, Some(5), 0), RETRY_AFTER_MIN_S);
        assert_eq!(delay(1, Some(1032), 0), RETRY_AFTER_MAX_S);
        assert_eq!(delay(1, Some(i64::MAX), 0), RETRY_AFTER_MAX_S);
    }

    #[test]
    fn agents_refused_together_do_not_come_back_together() {
        let spread: std::collections::BTreeSet<i64> = (1776..1800).map(|id| delay(1, None, id)).collect();
        assert!(spread.len() >= 10, "{spread:?}");
        assert!(spread.iter().all(|s| (60..=72).contains(s)), "never earlier than the base, at most a fifth later: {spread:?}");
        // a provider's wait is never undercut
        assert!((1776..1800).all(|id| delay(1, Some(100), id) >= 100));
        // a negative or huge id still lands in range
        assert!((60..=72).contains(&delay(1, None, -7)));
        assert!((60..=72).contains(&delay(1, None, i64::MAX)));
    }

    #[test]
    fn the_freeze_is_a_short_retry_and_says_so() {
        let r = RateLimited { retry_after: None };
        let before = Utc::now();
        let rec = freeze(2, &r, MEASURED, Some("acct-1"), 1776, Some("please review PROOF-1"));
        assert_eq!(rec["connection"], json!(true), "the engine's retry timer wakes it with no grace and without auto-resume");
        assert_eq!(rec["limit"], json!(false), "not a usage limit");
        assert_eq!(rec["cause"], json!("rate_limit"));
        assert_eq!(rec["attempt"], json!(2));
        assert_eq!(rec["account"], json!("acct-1"));
        assert_eq!(rec["provenance"], json!("observed"));
        let until = crate::util::parse_ts(rec["until"].as_str().unwrap()).unwrap();
        let wait = (until - before).num_seconds();
        assert!((120..=145).contains(&wait), "attempt 2 waits two minutes plus up to a fifth: {wait}");
        assert_eq!(crate::runtime::freeze::wake_at(&rec), Some(until), "no clock-skew grace on a retry");
        assert_eq!(rec["retry_in_s"], json!(delay(2, None, 1776)));
        let label = rec["label"].as_str().unwrap();
        assert!(label.contains("rate limit") && label.contains("429") && label.contains("2/5"), "{label}");
        assert!(!label.to_lowercase().contains("usage"), "{label}");
        let wake = rec["wake_text"].as_str().unwrap();
        assert!(wake.contains("429") && wake.contains("not your usage limit") && wake.contains("attempt 2 of 5"), "{wake}");
        assert!(wake.contains("Whatever that turn had ALREADY done was not undone"), "{wake}");
        assert_eq!(rec["resume_texts"], json!(["please review PROOF-1"]));
        assert!(rec["error"].as_str().unwrap().contains("429"));
    }

    #[test]
    fn a_freeze_without_a_replay_or_with_the_providers_wait() {
        let rec = freeze(1, &RateLimited { retry_after: Some(200) }, MEASURED, None, 0, None);
        assert!(rec.get("resume_texts").is_none(), "nothing to give again: the turn had already done work");
        assert_eq!(rec["retry_in_s"], json!(200));
        let until = crate::util::parse_ts(rec["until"].as_str().unwrap()).unwrap();
        assert!(((until - Utc::now()) - Duration::seconds(200)).num_seconds().abs() <= 3);
        assert_eq!(rec["account"], Value::Null);
        // an empty replay is no replay
        assert!(freeze(1, &RateLimited { retry_after: None }, MEASURED, None, 0, Some("  ")).get("resume_texts").is_none());
    }
}
