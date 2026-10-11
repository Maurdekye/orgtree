//! Pure cached-reading projection and exact selection. This module makes no
//! account-access decisions or provider requests. The caller supplies only
//! authorized lanes; tool grants/refresh semantics are a separate boundary.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

/// Exact selectors, constructed after the tool boundary validates arguments.
/// Omitted dimensions match everything; an explicitly empty dimension matches
/// nothing. This core never widens a supplied filter or interprets email/path.
#[derive(Default)]
pub struct Selection {
    pub accounts: Option<Vec<String>>,
    pub providers: Option<Vec<String>>,
    pub windows: Option<Vec<String>>,
}

#[logged]
impl Selection {
    #[nolog]
    pub fn lane(&self, account: &str, provider: &str) -> bool {
        selected(self.accounts.as_deref(), account) && selected(self.providers.as_deref(), provider)
    }

    #[nolog]
    pub fn window(&self, window: &Value) -> bool {
        self.windows.as_ref().is_none_or(|values| {
            values.iter().any(|v| {
                window["kind"].as_str() == Some(v.as_str())
                    || window["group"].as_str() == Some(v.as_str())
            })
        })
    }
}

#[nolog]
fn selected(values: Option<&[String]>, value: &str) -> bool {
    values.is_none_or(|values| values.iter().any(|v| v == value))
}

#[nolog]
fn number(v: &Value) -> Value {
    v.as_f64()
        .filter(|v| v.is_finite())
        .map_or(Value::Null, |v| json!(v))
}

#[nolog]
fn text(v: &Value) -> Value {
    // Drop objects/arrays and bound only display strings; never stringify a
    // provider document in a field that is supposed to contain text.
    v.as_str().map_or(Value::Null, |s| {
        json!(s.chars().take(256).collect::<String>())
    })
}

/// Raw cached provider documents can contain untrusted metadata. Do not log
/// inputs here: only the allowlisted projection is safe to return/log.
#[nolog]
pub fn window(raw: &Value, now: DateTime<Utc>) -> Value {
    let reset = raw["resets_at"].as_str().and_then(crate::util::parse_ts);
    let percent = number(&raw["percent"]);
    let limited = if raw["is_active"] == true {
        Some(true)
    } else {
        percent
            .as_f64()
            .map(|p| p >= 100.0)
            .or_else(|| raw["is_active"].as_bool())
    };
    json!({
        "kind": text(&raw["kind"]), "group": text(&raw["group"]),
        "model": text(&raw["model"]), "label": text(&raw["label"]),
        "used_percent": percent, "amount": number(&raw["amount"]),
        "unit": text(&raw["unit"]), "limited": limited,
        "resets_at": reset.map(crate::util::iso),
        "reset_in_seconds": reset.map(|t| (t - now).num_seconds()),
    })
}

/// No cache, failed reading, unknown timestamp and stale measurement remain
/// distinct. Keep historical windows on stale successful readings, dated.
/// Valid provider observation time takes precedence over cache insertion:
/// reinserting old bars during cooldown must not make their observation new.
/// Raw input is intentionally not invocation-logged (secret safety).
#[nolog]
pub fn reading(raw: Option<&Value>, cached_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Value {
    reading_selected(raw, cached_at, now, &Selection::default())
}

#[nolog]
pub fn reading_selected(
    raw: Option<&Value>,
    cached_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    selection: &Selection,
) -> Value {
    let Some(raw) = raw else {
        return json!({ "available": false, "reason": "no_cache", "freshness": "unknown",
            "observed_at": null, "age_seconds": null, "windows": [] });
    };
    let observed = match raw.get("observed_at") {
        // An explicitly invalid/future observation is unknown, not a reason
        // to manufacture an observation from a later cache insertion.
        Some(v) => v
            .as_str()
            .and_then(crate::util::parse_ts)
            .filter(|t| *t <= now),
        None => cached_at.filter(|t| *t <= now),
    };
    let age = observed.map(|t| now - t);
    let freshness = match age {
        Some(age) if age < chrono::Duration::seconds(900) => "fresh",
        Some(_) => "stale",
        None => "unknown",
    };
    let successful = raw["available"].as_bool() == Some(true);
    let reason = if !successful {
        Some(if raw["reason"] == "no_recorded_spend" {
            "no_recorded_spend"
        } else if raw["reauth_required"] == true {
            "signed_out"
        } else {
            "failed"
        })
    } else if freshness == "stale" {
        Some("stale")
    } else if freshness == "unknown" {
        Some("unknown_observation")
    } else {
        None
    };
    let window_count = if successful {
        raw["limits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w.is_object() && selection.window(w))
            .count()
    } else {
        0
    };
    let windows: Vec<Value> = if successful {
        raw["limits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w.is_object())
            .filter(|w| selection.window(w))
            .take(64)
            .map(|w| window(w, now))
            .collect()
    } else {
        Vec::new()
    };
    let mut out = json!({ "available": successful && freshness == "fresh", "reason": reason,
        "freshness": freshness, "observed_at": observed.map(crate::util::iso),
        "age_seconds": age.map(|a| a.num_seconds()), "windows": windows,
        "window_count": window_count, "windows_truncated": window_count > 64 });
    if raw["mode"] == "apikey" {
        out["quota"] = json!("unsupported");
        out["source"] = json!("local_metering");
        out["spend"] = if successful && raw["spend"].is_object() {
            json!({"usd_total":number(&raw["spend"]["usd_total"]),
                "turns":raw["spend"]["turns"].as_u64(),
                "since":raw["spend"]["since"].as_i64(),
                "updated_at":raw["spend"]["updated_at"].as_i64(),"unit":"USD"})
        } else {
            Value::Null
        };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp(1_900_000_000, 0).unwrap()
    }

    #[test]
    fn exact_filters_or_within_and_across_dimensions() {
        let s = Selection {
            accounts: Some(vec!["openai-1".into(), "openai-2".into()]),
            providers: Some(vec!["openai".into()]),
            windows: Some(vec!["weekly_all".into(), "3p-5h".into()]),
        };
        assert!(s.lane("openai-2", "openai"));
        assert!(!s.lane("openai-2", "claude"));
        assert!(!s.lane("OPENAI-2", "openai"));
        assert!(!s.lane("openai", "openai"));
        assert!(s.window(&json!({"kind":"weekly_all"})));
        assert!(s.window(&json!({"kind":"session","group":"3p-5h"})));
        assert!(!s.window(&json!({"kind":"session","label":"weekly_all"})));
        assert!(!s.window(&json!({"group":["3p-5h"]})));
        assert!(Selection::default().lane("any", "any"));
        assert!(!Selection {
            accounts: Some(vec![]),
            ..Selection::default()
        }
        .lane("any", "any"));
    }

    #[test]
    fn no_cache_and_failed_cache_never_become_zero_usage() {
        let absent = reading(None, None, now());
        assert_eq!(absent["reason"], "no_cache");
        assert_eq!(absent["age_seconds"], Value::Null);
        let failed = reading(
            Some(&json!({"available":false,"limits":[{"percent":0}],
            "error":"secret-provider-error","detail":{"access_token":"sentinel"}})),
            Some(now()),
            now(),
        );
        assert_eq!(failed["reason"], "failed");
        assert_eq!(failed["windows"], json!([]));
        assert!(!failed.to_string().contains("secret"));
        assert!(!failed.to_string().contains("sentinel"));
    }

    #[test]
    fn stale_boundary_and_old_observation_survive_reinsertion() {
        let n = now();
        let raw = json!({"available":true,"observed_at":crate::util::iso(n - chrono::Duration::seconds(900)),
            "limits":[{"kind":"session","percent":91}]});
        let stale = reading(Some(&raw), Some(n), n);
        assert_eq!(stale["freshness"], "stale");
        assert_eq!(stale["reason"], "stale");
        assert_eq!(stale["age_seconds"], 900);
        assert_eq!(stale["windows"][0]["used_percent"], 91.0);
        assert_eq!(stale["available"], false);
        let fresh = reading(
            Some(&json!({"available":true})),
            Some(n - chrono::Duration::seconds(899)),
            n,
        );
        assert_eq!(fresh["freshness"], "fresh");
        assert_eq!(fresh["windows"], json!([]));
    }

    #[test]
    fn invalid_explicit_observation_does_not_claim_freshness() {
        for at in [
            json!("bad"),
            json!(17),
            json!(crate::util::iso(now() + chrono::Duration::seconds(1))),
        ] {
            let v = reading(
                Some(&json!({"available":true,"observed_at":at})),
                Some(now()),
                now(),
            );
            assert_eq!(v["freshness"], "unknown");
            assert_eq!(v["reason"], "unknown_observation");
            assert_eq!(v["age_seconds"], Value::Null);
        }
    }

    #[test]
    fn projection_whitelists_typed_fields_and_does_not_invent_reset_or_percent() {
        let w = window(
            &json!({"kind":"usage","group":"credits","percent":null,"amount":8.5,"unit":"USD",
            "label":{"access_token":"sentinel"},"resets_at":"invalid","secret":"sentinel",
            "detail":"sentinel","config_dir":"sentinel","is_active":false}),
            now(),
        );
        assert_eq!(w["used_percent"], Value::Null);
        assert_eq!(w["amount"], 8.5);
        assert_eq!(w["limited"], false);
        assert_eq!(w["label"], Value::Null);
        assert_eq!(w["resets_at"], Value::Null);
        assert_eq!(w["reset_in_seconds"], Value::Null);
        assert!(!w.to_string().contains("sentinel"));
        let unknown = window(&json!({}), now());
        assert_eq!(unknown["limited"], Value::Null);
        let passed = window(
            &json!({"percent":100,"resets_at":crate::util::iso(now() - chrono::Duration::seconds(4))}),
            now(),
        );
        assert_eq!(passed["limited"], true);
        assert_eq!(passed["reset_in_seconds"], -4);
    }
}
