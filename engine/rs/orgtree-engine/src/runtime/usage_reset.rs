//! Reset evidence from a refused turn. Raw refusal text never enters tracing.
use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub struct Reset {
    pub until: DateTime<Utc>,
    pub wall: Option<Value>,
    pub parsed: bool,
}

#[nolog]
fn timestamp(v: &Value) -> Option<DateTime<Utc>> {
    v.as_i64().and_then(|t| DateTime::from_timestamp(t, 0))
        .or_else(|| v.as_str().and_then(crate::util::parse_ts))
}

/// A clock-only refusal uses the CLI host's local zone. Unknown named zones
/// are not guessed; ambiguous local times choose the later instant.
#[nolog]
fn absolute(text: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    static ISO: OnceLock<regex::Regex> = OnceLock::new();
    static CLOCK: OnceLock<regex::Regex> = OnceLock::new();
    let iso = ISO.get_or_init(|| regex::Regex::new(
        r"(?i)reset(?:s|ting)?(?:\s+at)?\s+(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d|\s+UTC))").unwrap());
    if let Some(c) = iso.captures(text) {
        let raw = c[1].replace(" UTC", "Z").replace(" utc", "Z");
        return DateTime::parse_from_rfc3339(&raw.replace(' ', "T")).ok().map(|t| t.with_timezone(&Utc));
    }
    let clock = CLOCK.get_or_init(|| regex::Regex::new(
        r"(?i)reset(?:s|ting)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(UTC))?\s*(?:[).,;?]|$)").unwrap());
    let c = clock.captures(text)?;
    // A bare number is not a clock (nor a duration's leading number).
    if c.get(2).is_none() && c.get(3).is_none() { return None; }
    let mut hour: u32 = c[1].parse().ok()?;
    let minute: u32 = c.get(2).map(|m| m.as_str().parse()).transpose().ok()?.unwrap_or(0);
    if let Some(ap) = c.get(3) {
        if !(1..=12).contains(&hour) { return None; }
        hour = hour % 12 + if ap.as_str().eq_ignore_ascii_case("pm") { 12 } else { 0 };
    }
    let utc = c.get(4).is_some();
    let date = if utc { now.date_naive() } else { now.with_timezone(&Local).date_naive() };
    let at = date.and_hms_opt(hour, minute, 0)?;
    let resolve = |at| if utc { Some(Utc.from_utc_datetime(&at)) }
        else { Local.from_local_datetime(&at).latest().map(|t| t.with_timezone(&Utc)) };
    let candidate = resolve(at)?;
    if candidate > now { Some(candidate) } else { resolve(at.checked_add_signed(Duration::days(1))?) }
}

#[nolog]
pub fn reported(error: &str, info: Option<&Value>, prior: &Value, now: DateTime<Utc>) -> Option<Reset> {
    let lower = error.to_lowercase();
    let rejected = info.is_some_and(|r| r["status"] == "rejected" || !r["rateLimitReachedType"].is_null()
        || !r["quota"]["resetsAtMs"].is_null());
    let worded = lower.contains("usage limit") || lower.contains("hit your limit") || lower.contains("limit reached")
        || lower.contains("rate limit") || lower.contains("resets") || super::recovery::worded_limit(error);
    if !rejected && !worded { return None; }
    let mut deadlines = Vec::new();
    if let Some(r) = info {
        deadlines.extend(timestamp(&r["resetsAt"]));
        deadlines.extend(r["quota"]["resetsAtMs"].as_i64().and_then(DateTime::from_timestamp_millis));
        for w in ["primary", "secondary"] {
            if r[w]["usedPercent"].as_f64().is_some_and(|p| p.is_finite() && p >= 100.0) {
                deadlines.extend(timestamp(&r[w]["resetsAt"]));
            }
        }
    }
    let mut wall = None;
    if let Some(secs) = super::recovery::reset_in_seconds(error)
        .filter(|s| Duration::try_seconds(*s).and_then(|d| now.checked_add_signed(d)).is_some()) {
        let (_, until) = super::recovery::countdown_until(secs, prior, now);
        deadlines.push(until);
        wall = Some(json!({"secs":secs,"until":crate::util::iso(until)}));
    }
    deadlines.extend(absolute(error, now));
    deadlines.extend(error.split('|').nth(1).and_then(|s| s.trim().parse::<i64>().ok())
        .and_then(|t| DateTime::from_timestamp(t, 0)));
    let until = deadlines.into_iter().filter(|t| *t > now).max();
    Some(Reset { until: until.unwrap_or_else(|| now + Duration::hours(1)), wall, parsed: until.is_some() })
}

#[nolog]
fn window_kind(window: &str) -> &str {
    match window {
        "five_hour" | "primary" | "5h" => "session",
        "seven_day" | "secondary" | "weekly" | "7d" => "weekly_all",
        other => other,
    }
}

/// The refused window, if the harness names one. With no name only full,
/// applicable windows from a fresh reading may extend the hold.
#[nolog]
pub fn window(info: Option<&Value>) -> Option<&str> {
    let r = info?;
    r["rateLimitType"].as_str().or_else(|| {
        r["rateLimitReachedType"].as_str().filter(|w|
            matches!(window_kind(w), "session" | "weekly_all" | "weekly_scoped"))
    }).or_else(|| {
        let mut full = ["primary", "secondary"].into_iter()
            .filter(|w| r[*w]["usedPercent"].as_f64().is_some_and(|p| p >= 100.0));
        let first = full.next()?;
        full.next().is_none().then_some(first)
    })
}

#[nolog]
pub fn cached_reset(provider: &str, tier: &str, window: Option<&str>, reading: &Value,
    reported_at: DateTime<Utc>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if reading["available"] != true || !reading["error"].is_null() || reading["reauth_required"] == true { return None; }
    let observed = reading["observed_at"].as_str().and_then(crate::util::parse_ts)?;
    if observed < reported_at || observed > now { return None; }
    reading["limits"].as_array()?.iter()
        .filter(|w| crate::usage::spends(provider, tier, w))
        .filter(|w| window.is_none_or(|win| w["kind"].as_str().is_some_and(|k| window_kind(k) == window_kind(win))
            || w["group"] == win))
        .filter(|w| w["percent"].as_f64().is_some_and(|p| p.is_finite() && p >= 100.0) || w["is_active"] == true)
        .filter_map(|w| w["resets_at"].as_str().and_then(crate::util::parse_ts))
        .filter(|t| *t > now).max()
}

#[cfg(test)]
mod usage_reset_tests {
    use super::*;
    use chrono::{Duration, Timelike};
    fn now() -> DateTime<Utc> { DateTime::parse_from_rfc3339("2026-10-17T01:45:00Z").unwrap().with_timezone(&Utc) }

    #[test]
    fn stale_antigravity_anchor_cannot_shorten_a_fresh_four_hour_reset() {
        let n = now();
        let secs = super::super::recovery::reset_in_seconds("Usage limit reached; resets in 4 h 35 m").unwrap();
        assert_eq!(secs, 16_500);
        let prior = json!({"secs":secs,"until":"2026-10-16T20:00:00Z"});
        let reset = reported("Usage limit reached; resets in 4 h 35 m", None, &prior, n).unwrap();
        assert_eq!(reset.until, n + Duration::seconds(secs));
        let rec = json!({"until":crate::util::iso(reset.until),"limit":true});
        assert_eq!(super::super::freeze::wake_at(&rec), Some(n + Duration::seconds(secs + 60)));
    }

    #[test]
    fn relative_current_report_also_beats_a_shorter_unexpired_old_anchor() {
        let n = now();
        let prior = json!({"secs":16500,"until":crate::util::iso(n+Duration::minutes(5))});
        assert_eq!(reported("Usage limit reached; resets in 4 h 35 m", None, &prior, n).unwrap().until, n+Duration::seconds(16500));
        assert_eq!(reported("Usage limit reached; resets in 4h35m25s", None, &Value::Null, n).unwrap().until, n+Duration::seconds(16525));
    }

    #[test]
    fn absolute_iso_offset_and_legacy_epoch_are_understood() {
        let n = now();
        let expected = n + Duration::hours(5);
        assert_eq!(reported("usage limit reached; resets at 2026-10-17T09:45:00+03:00", None, &Value::Null, n).unwrap().until, expected);
        assert_eq!(reported("usage limit|1792219500", None, &Value::Null, n).unwrap().until.timestamp(), 1792219500);
    }

    #[test]
    fn a_later_text_reset_beats_an_earlier_structured_reset() {
        let n = now();
        let info = json!({"status":"rejected","resetsAt":(n+Duration::minutes(5)).timestamp()});
        assert_eq!(reported("usage limit; resets in 4 h 35 m", Some(&info), &Value::Null, n).unwrap().until, n+Duration::seconds(16500));
    }

    #[test]
    fn codex_fractional_percentage_and_muse_millisecond_resets_are_typed() {
        let n = now();
        let until = n+Duration::hours(6);
        let codex = json!({"secondary":{"usedPercent":100.0,"resetsAt":until.timestamp()}});
        assert_eq!(reported("usage limit", Some(&codex), &Value::Null, n).unwrap().until, until);
        let muse = json!({"quota":{"resetsAtMs":until.timestamp_millis()}});
        assert_eq!(reported("usage limit", Some(&muse), &Value::Null, n).unwrap().until, until);
    }

    #[test]
    fn missing_reset_and_non_limit_behavior_stay_unchanged() {
        let n = now();
        let r = reported("usage limit reached; reset unknown", None, &Value::Null, n).unwrap();
        assert_eq!(r.until, n+Duration::hours(1));
        assert!(!r.parsed);
        assert!(reported("connection lost", None, &Value::Null, n).is_none());
    }

    #[test]
    fn claude_local_clock_that_passed_rolls_to_tomorrow() {
        use chrono::{Local, TimeZone, Timelike};
        let n = now();
        let local = n.with_timezone(&Local);
        let hour = (local.hour()+23)%24;
        let next = (local.date_naive()+Duration::days(1)).and_hms_opt(hour, 0, 0).unwrap();
        let expected = Local.from_local_datetime(&next).earliest().unwrap().with_timezone(&Utc);
        let text = format!("You've hit your limit; resets {hour:02}:00");
        assert_eq!(reported(&text, None, &Value::Null, n).unwrap().until, expected);
    }

    #[test]
    fn cached_reset_must_be_fresh_authoritative_and_in_the_same_window() {
        let n = now();
        let until = n+Duration::hours(8);
        let mut reading = json!({"available":true,"observed_at":crate::util::iso(n+Duration::seconds(1)),"limits":[
            {"group":"3p-weekly","kind":"weekly_all","percent":100,"resets_at":crate::util::iso(until)},
            {"group":"gemini-weekly","kind":"weekly_all","percent":100,"resets_at":crate::util::iso(until+Duration::days(2))}]});
        assert_eq!(cached_reset("google", "agy-opus", Some("weekly_all"), &reading, n, n+Duration::seconds(2)), Some(until));
        assert_eq!(cached_reset("google", "agy-opus", Some("session"), &reading, n, n+Duration::seconds(2)), None);
        reading["observed_at"] = json!(crate::util::iso(n-Duration::seconds(1)));
        assert_eq!(cached_reset("google", "agy-opus", None, &reading, n, n), None);
        reading["available"] = json!(false);
        assert_eq!(cached_reset("google", "agy-opus", None, &reading, n, n), None);
    }
    #[test]
    fn malformed_and_named_zone_resets_keep_fallback_and_never_panic() {
        for text in ["usage limit; resets in 99999999999999999999999h", "usage limit; resets at 99:80",
            "usage limit; resets 7am America/New_York", "usage limit; resets in 9223372036854775807s"] {
            let r = reported(text, None, &Value::Null, now()).unwrap();
            assert_eq!(r.until, now()+Duration::hours(1), "{text}");
            assert!(!r.parsed, "{text}");
        }
    }

    #[test]
    fn clock_am_pm_and_structured_iso_choose_latest_without_early_wake() {
        let n = now();
        let r = reported("usage limit; resets 7am UTC", None, &Value::Null, n).unwrap();
        assert_eq!(r.until, n.date_naive().and_hms_opt(7,0,0).unwrap().and_utc());
        let info = json!({"status":"rejected","resetsAt":"2026-10-18T00:00:00Z"});
        assert_eq!(reported("usage limit; resets in 2h", Some(&info), &Value::Null, n).unwrap().until,
            crate::util::parse_ts("2026-10-18T00:00:00Z").unwrap());
        let r = reported("usage limit; resets 12:30pm UTC", None, &Value::Null, n).unwrap();
        assert_eq!(r.until.hour(), 12);
    }

    #[test]
    fn cache_rejects_failed_future_nonfull_and_unrelated_model_readings() {
        let n = now();
        let base = json!({"available":true,"observed_at":crate::util::iso(n),"limits":[
            {"kind":"weekly_all","percent":100,"resets_at":crate::util::iso(n+Duration::hours(9))}]});
        assert!(cached_reset("claude","sol",None,&base,n,n).is_some());
        for (field, value) in [("error",json!("unavailable")), ("reauth_required",json!(true)),
            ("observed_at", json!(crate::util::iso(n+Duration::seconds(1))))] {
            let mut r=base.clone();r[field]=value;
            assert_eq!(cached_reset("claude","sol",None,&r,n,n),None);
        }
        let mut r=base.clone();r["limits"][0]["percent"]=json!(99);
        assert_eq!(cached_reset("claude","sol",None,&r,n,n),None);
        let mut r=base;r["limits"][0]["kind"]=json!("weekly_scoped");r["limits"][0]["model"]=json!("fable");
        assert_eq!(cached_reset("claude","sol",None,&r,n,n),None);
    }

    #[test]
    fn generic_codex_rejection_does_not_hide_the_exhausted_window() {
        assert_eq!(window(Some(&json!({"rateLimitReachedType":"rate_limit",
            "secondary":{"usedPercent":100}}))),Some("secondary"));
        assert_eq!(window(Some(&json!({"primary":{"usedPercent":100},
            "secondary":{"usedPercent":100}}))),None);
    }

}
