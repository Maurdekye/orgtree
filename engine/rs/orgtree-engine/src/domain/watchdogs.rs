//! Watchdogs: agent-armed monitors that wake their owner with mail when a
//! file, command, process, log stream or the agent's own silence says so.

use serde_json::{json, Map, Value};

use crate::domain::tree::ts;

/// The desktop's handle for a dog: `owner/id`. A dog's id is unique only
/// among its owner's dogs (D67), so the canvas, sparks and the user's
/// pause/resume/remove need the owner too; `act` takes this form back.
#[nolog]
pub fn handle(owner: &str, uid: &str) -> String {
    format!("{owner}/{uid}")
}

/// A `watchdogs` row → the `Watchdog` the canvas and desk render.
pub fn view(w: &Value, owner: &str) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(handle(owner, w["uid"].as_str().unwrap_or_default())));
    o.insert("owner".into(), json!(owner));
    o.insert("name".into(), w["name"].clone());
    o.insert("kind".into(), w["kind"].clone());
    o.insert("fire_mode".into(), w["fire_mode"].clone());
    if let Some(q) = w.get("quiet_period_s").filter(|v| !v.is_null()) {
        o.insert("quiet_period_s".into(), q.clone());
    }
    if let Some(s) = w.get("silence_since").filter(|v| !v.is_null()) {
        o.insert("silence_since".into(), ts(s));
    }
    o.insert("target".into(), w["target"].clone());
    for key in ["threshold","event_scope"] { if let Some(v)=w["memo"].get(key).filter(|v|!v.is_null()){o.insert(key.into(),v.clone());} }
    if let Some(v)=w["memo"]["run"].get("last_output"){o.insert("last_output".into(),v.clone());}
    if let Some(p) = w.get("pattern").filter(|v| !v.is_null()) {
        o.insert("pattern".into(), p.clone());
    }
    o.insert("interval_s".into(), w["interval_s"].clone());
    let spent = w.get("spent_at").map(|v| !v.is_null()).unwrap_or(false);
    o.insert("state".into(), if spent { json!("spent") } else { w["state"].clone() });
    o.insert("at".into(), ts(&w["created_at"]));
    o.insert("fired".into(), w["fired"].clone());
    o.insert("once".into(), json!(w["once"].as_bool().unwrap_or(false)));
    o.insert("notice".into(), json!(w["memo"]["notice"].as_bool().unwrap_or(false)));
    o.insert("spent".into(), json!(spent));
    if let Some(v) = w.get("last_check").filter(|v| !v.is_null()) {
        o.insert("last_check".into(), ts(v));
    }
    for key in ["next_check_at","next_silence_at"] {
        if let Some(v)=w.get(key).filter(|v|!v.is_null()){o.insert(key.into(),ts(v));}
    }
    if let Some(v) = w.get("last_fired").filter(|v| !v.is_null()) {
        o.insert("last_fired".into(), ts(v));
    }
    let events = w.get("events").cloned().unwrap_or(json!([]));
    if events.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        o.insert("events".into(), events);
    }
    if let Some(e) = w.get("exit").filter(|v| !v.is_null()) {
        o.insert("exit".into(), e.clone());
    }
    // a slot claim: when it joined the line (its order), and its lease once granted
    if w["kind"] == "slot" {
        if let Some(q) = w["memo"]["queued_at"].as_i64().and_then(chrono::DateTime::from_timestamp_millis) {
            o.insert("queued_at".into(), json!(crate::util::iso(q)));
        }
        for key in ["lease", "slot"] { if let Some(v)=w["memo"].get(key).filter(|v|!v.is_null()){o.insert(key.into(),v.clone());} }
    }
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watchdog_card_projection_preserves_passive_delivery_and_legacy_default() {
        for notice in [false, true] {
            let raw = json!({"uid":"mail", "memo":{"notice":notice}});
            assert_eq!(view(&raw,"worker")["notice"],json!(notice));
        }
        assert_eq!(view(&json!({"uid":"legacy"}),"worker")["notice"],json!(false));
    }
    #[test]
    fn watchdog_view_keeps_durable_deadlines_separate_from_actual_progress() {
        let raw=json!({"uid":"clock","kind":"command","state":"armed","created_at":"2026-01-01T00:00:00Z",
            "last_check":"2026-01-01T07:00:00Z","next_check_at":"2026-01-01T12:00:00Z",
            "last_fired":"2026-01-01T07:00:00Z","next_silence_at":"2026-01-01T12:00:00Z"});
        let projected=view(&raw,"boss");
        assert_eq!(projected["next_check_at"],ts(&raw["next_check_at"]));
        assert_eq!(projected["next_silence_at"],ts(&raw["next_silence_at"]));
        assert_eq!(projected["last_check"],ts(&raw["last_check"]));
        assert_ne!(projected["next_check_at"],projected["last_check"]);
        assert!(view(&json!({"uid":"legacy"}),"boss").get("next_check_at").is_none());
    }
    /// A slot claim shows when it joined the line, and its lease once granted.
    #[test]
    fn a_slot_claim_view_carries_its_place_and_lease() {
        let raw=json!({"uid":"w1","kind":"slot","state":"armed","created_at":"2026-01-01T00:00:00Z",
            "memo":{"target_id":7,"queued_at":1767225600000_i64}});
        let v=view(&raw,"builder");
        assert_eq!(v["queued_at"],json!("2026-01-01T00:00:00.000Z"));
        assert!(v.get("lease").is_none());
        let granted=json!({"uid":"w1","kind":"slot","memo":{"queued_at":1767225600000_i64,"lease":"sab","slot":1}});
        let g=view(&granted,"builder");
        assert_eq!((g["lease"].clone(),g["slot"].clone()),(json!("sab"),json!(1)));
        assert!(view(&json!({"uid":"x","kind":"command","memo":{"queued_at":1}}),"b").get("queued_at").is_none());
    }
}
