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

use std::sync::OnceLock;

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

/// Words a usage wall uses and a request rate does not. Any of them in the failure's text keeps it
/// a usage limit, as it was.
const USAGE_WORDS: &[&str] = &[
    "usage limit", "usage_limit", "hit your limit", "quota", "weekly", "resets", "reset at",
    "try again at", "billing", "credits", "upgrade", "subscription",
];

/// The tag name (lower case, no `_` or `-`) and HTTP status of a `codexErrorInfo`: a plain string
/// (`"usageLimitExceeded"`) or an object naming its variant (`{"responseTooManyFailedAttempts":
/// {"httpStatusCode": 429}}`).
#[nolog]
fn tag_of(info: &Value) -> (String, Option<i64>) {
    let norm = |s: &str| s.chars().filter(|c| *c != '_' && *c != '-').collect::<String>().to_lowercase();
    match info {
        Value::String(s) => (norm(s), None),
        Value::Object(o) if o.len() == 1 => {
            let (name, body) = o.iter().next().expect("one entry");
            (norm(name), body["httpStatusCode"].as_i64())
        }
        _ => (String::new(), None),
    }
}

/// A 429 stated in the text: the reason phrase, or the number beside a word that makes it a status
/// (`last status: 429`, `HTTP 429`, `error 429`). A bare 429 (a count, a byte size) is not one.
#[nolog]
fn states_429(lower: &str) -> bool {
    static STATUS: OnceLock<regex::Regex> = OnceLock::new();
    lower.contains("too many requests")
        || STATUS.get_or_init(|| regex::Regex::new(r"\b(?:status|http|code|error|response)\W{0,3}429\b").unwrap()).is_match(lower)
}

/// Is this Codex failure a request-rate 429 rather than a usage wall? `codex_error` is the turn's
/// `{"info": codexErrorInfo, "details": additionalDetails}` (or null); `window_full` says a usage
/// window of the account is known to be exhausted, in which case a 429 is the wall.
///
/// Rate limit: the app-server's `rateLimitExceeded` tag, a retry limit or connection failure whose
/// status is 429, or a text that states a 429. Never a rate limit: the `usageLimitExceeded` tag, a
/// text with a usage wall's words (`USAGE_WORDS`), or an exhausted window.
#[logged]
pub fn rate_limited(error: &str, codex_error: &Value, window_full: bool) -> Option<RateLimited> {
    if window_full {
        return None;
    }
    let text = format!("{error}\n{}", codex_error["details"].as_str().unwrap_or(""));
    let lower = text.to_lowercase();
    let (kind, status) = tag_of(&codex_error["info"]);
    if kind == "usagelimitexceeded" || USAGE_WORDS.iter().any(|w| lower.contains(w)) {
        return None;
    }
    let typed = kind == "ratelimitexceeded"
        || (status == Some(429) && matches!(kind.as_str(),
            "responsetoomanyfailedattempts" | "httpconnectionfailed" | "responsestreamconnectionfailed" | "responsestreamdisconnected"));
    (typed || states_429(&lower)).then(|| RateLimited { retry_after: retry_after_seconds(&text) })
}

/// `2 minutes and 5 seconds` / `1m30s` / `30` (bare seconds, first segment only) -> seconds.
#[nolog]
fn wait_seconds(mut rest: &str) -> Option<i64> {
    let mut total = 0_i64;
    let mut first = true;
    loop {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            break;
        }
        let n: i64 = rest[..digits].parse().ok()?;
        let after = rest[digits..].trim_start();
        let unit_len = after.chars().take_while(char::is_ascii_alphabetic).count();
        let secs = match &after[..unit_len] {
            "d" | "day" | "days" => 86_400,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3_600,
            "m" | "min" | "mins" | "minute" | "minutes" => 60,
            "s" | "sec" | "secs" | "second" | "seconds" => 1,
            "" if first => 1,
            _ => break,
        };
        total = total.checked_add(n.checked_mul(secs)?)?;
        first = false;
        rest = after[unit_len..].trim_start();
        rest = rest.strip_prefix(',').unwrap_or(rest).trim_start();
        rest = rest.strip_prefix("and ").unwrap_or(rest);
    }
    (total > 0).then_some(total)
}

/// The provider's own wait in a failure's text (`Retry-After: 30`, `retry after 2 minutes`,
/// `try again in 1m30s`), in seconds. The Codex app-server relays no headers, so the measured
/// 10:04Z error has none; this reads it should a CLI version put one in the message or details.
#[logged]
pub fn retry_after_seconds(text: &str) -> Option<i64> {
    static AFTER: OnceLock<regex::Regex> = OnceLock::new();
    let lower = text.to_lowercase();
    let at = AFTER
        .get_or_init(|| regex::Regex::new(r"(?:retry[- ]after|(?:try|retry)\s+again\s+in|retry\s+in)\s*[:=]?\s*").unwrap())
        .find(&lower)?;
    wait_seconds(&lower[at.end()..])
}

/// Seconds to wait before retry number `run` (1-based): the provider's wait within bounds, else
/// 60 s doubling to 300 s. `seed` (the agent's id) spreads the agents that were refused together
/// over the next fifth of the wait, never earlier than it.
#[logged]
pub fn delay(run: i64, retry_after: Option<i64>, seed: i64) -> i64 {
    let base = match retry_after {
        Some(s) => s.clamp(RETRY_AFTER_MIN_S, RETRY_AFTER_MAX_S),
        None => (RATE_RETRY_FIRST_S << (run - 1).clamp(0, 10)).min(RATE_RETRY_CAP_S),
    };
    base + base * seed.rem_euclid(21) / 100
}

/// What the retried turn is told: the refusal was the request rate, not its usage, and nothing it
/// had already done was undone.
#[nolog]
fn banner(run: i64) -> String {
    format!(
        "The provider rate-limited your previous turn (HTTP 429 Too Many Requests: a limit on how fast requests \
         are sent, not your usage limit) and orgtree is retrying it — attempt {run} of {RATE_RETRY_MAX}. \
         Whatever that turn had ALREADY done was not undone: check your real state (files on disk, `git status`, \
         mail you may have already sent, processes you may have already started) before redoing any of it. \
         Continue where you left off."
    )
}

/// The freeze record for retry `run`: a pure retry (`connection: true, limit: false`), so the
/// engine's freeze timer wakes it at `until` with no clock-skew grace and whatever the org's
/// auto-resume setting is, and `cause: "rate_limit"`, so every surface says what it is. `replay`
/// is the request the refused turn was given, kept when the turn had done nothing before the
/// refusal (a Codex thread already holds it, as for a usage limit).
#[logged]
pub fn freeze(run: i64, r: &RateLimited, error: &str, account: Option<&str>, seed: i64, replay: Option<&str>) -> Value {
    let wait = delay(run, r.retry_after, seed);
    let until = Utc::now() + chrono::Duration::seconds(wait);
    let mut rec = json!({
        "at": now_iso(), "until": iso(until), "error": gist(error, 300), "connection": true, "limit": false,
        "cause": "rate_limit", "provenance": "observed", "account": account, "attempt": run, "retry_in_s": wait,
        "label": format!("{RATE_KIND} — attempt {run}/{RATE_RETRY_MAX}"),
        "wake_text": banner(run),
    });
    if let Some(text) = replay.filter(|t| !t.trim().is_empty()) {
        rec["resume_texts"] = json!([text]);
    }
    rec
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
