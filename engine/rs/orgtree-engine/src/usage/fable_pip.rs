//! The Fable pip, in the engine (USER 2026-11-10 18:11:26Z ma76204ba37d2, formula 18:15:42Z m9c19aae87fb3 "r = 1/2";
//! usage-watchdog mode: USER 2026-11-11 09:36:56Z m701db26da99c).
//!
//! A Claude account can carry a separate Fable weekly limit beside its all-models weekly limit; Fable use counts
//! against both. With f the Fable weekly fraction used, the rest of the Fable allowance can no longer be used up
//! before the weekly limit once weekly usage passes `(1 + f) / 2` of the weekly bar: that is the pip.
//!
//! Pure, no I/O. The renderer's twin is `apps/desktop/renderer/src/canvas/fablepip.ts`: keep the two in step.
use chrono::{DateTime, Utc};
use serde_json::Value;

/// One known reading: both percentages are of their own bar, `pip` is a percentage of the weekly (all models) bar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PipReading {
    pub weekly: f64,
    pub fable: f64,
    pub pip: f64,
}

/// A Claude `weekly_scoped` window whose model names Fable (the renderer's `/\bfable\b/i`: a whole word, any case).
#[nolog]
pub fn is_fable_weekly(provider: &str, w: &Value) -> bool {
    provider == "claude"
        && w["kind"] == "weekly_scoped"
        && w["model"].as_str().is_some_and(|m| {
            m.to_lowercase().split(|c: char| !(c.is_alphanumeric() || c == '_')).any(|token| token == "fable")
        })
}

/// The pip of one usage row, or `None` when it is not known: no weekly window, no Fable window, a row that is not
/// available and fresh, a missing/negative/non-finite percent, an expired window, or Fable at 100% (no pip left).
/// Unknown is never zero.
#[nolog]
pub fn pip_percent(row: &Value, now: DateTime<Utc>) -> Option<PipReading> {
    let provider = row["provider"].as_str().unwrap_or("");
    if provider != "claude" || row["available"] != true || row["freshness"] != "fresh" {
        return None;
    }
    let windows = row["windows"].as_array()?;
    let weekly = windows.iter().find(|w| w["kind"] == "weekly_all")?;
    let fable = windows.iter().find(|w| is_fable_weekly(provider, w))?;
    let known = |w: &Value| -> Option<f64> {
        let expired = w["resets_at"].as_str().and_then(crate::util::parse_ts).is_some_and(|t| t <= now);
        w["used_percent"].as_f64().filter(|p| p.is_finite() && *p >= 0.0).filter(|_| !expired)
    };
    let (weekly, fable) = (known(weekly)?, known(fable)?.min(100.0));
    if fable >= 100.0 {
        return None;
    }
    // written as 50 + f/2 so an integer f gives an exact pip (f = 52 gives exactly 76)
    Some(PipReading { weekly, fable, pip: 50.0 + fable / 2.0 })
}
