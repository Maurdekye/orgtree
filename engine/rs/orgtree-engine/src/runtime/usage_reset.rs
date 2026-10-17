//! Reset evidence from a refused turn. Raw refusal text never enters tracing.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub struct Reset {
    pub until: DateTime<Utc>,
    pub wall: Option<Value>,
    pub parsed: bool,
}

#[nolog]
pub fn reported(error: &str, info: Option<&Value>, prior: &Value, now: DateTime<Utc>) -> Option<Reset> {
    let lower = error.to_lowercase();
    let rejected = info.map(|r| r["status"] == "rejected" || !r["rateLimitReachedType"].is_null()).unwrap_or(false);
    let worded = lower.contains("usage limit") || lower.contains("hit your limit") || lower.contains("limit reached")
        || lower.contains("rate limit") || lower.contains("resets") || super::recovery::worded_limit(error);
    if !rejected && !worded { return None; }
    let from_info = info.and_then(|r| r["resetsAt"].as_i64().or_else(|| {
        ["primary", "secondary"].iter()
            .filter(|w| r[**w]["usedPercent"].as_i64().unwrap_or(0) >= 100)
            .filter_map(|w| r[*w]["resetsAt"].as_i64()).max()
    })).and_then(|t| DateTime::from_timestamp(t, 0)).filter(|t| *t > now);
    if let Some(until) = from_info { return Some(Reset { until, wall: None, parsed: true }); }
    if let Some(secs) = super::recovery::reset_in_seconds(error) {
        let (_, until) = super::recovery::countdown_until(secs, prior, now);
        return Some(Reset { until, wall: Some(json!({"secs": secs, "until": crate::util::iso(until)})), parsed: true });
    }
    let from_text = error.split('|').nth(1).and_then(|s| s.trim().parse::<i64>().ok()).and_then(|t| DateTime::from_timestamp(t, 0));
    Some(Reset { until: from_text.unwrap_or_else(|| now + chrono::Duration::hours(1)), wall: None, parsed: from_text.is_some() })
}

#[nolog]
pub fn cached_reset(_provider: &str, _tier: &str, _window: Option<&str>, _reading: &Value,
    _reported_at: DateTime<Utc>, _now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    None
}

#[cfg(test)]
mod usage_reset_tests {
    use super::*;
    use chrono::Duration;
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
}
