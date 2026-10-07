//! Watchdogs: agent-armed monitors that wake their owner with mail when a
//! file, command, process, log stream or the agent's own silence says so.

use serde_json::{json, Map, Value};

use crate::domain::tree::ts;

/// A `watchdogs` row → the `Watchdog` the canvas and desk render.
pub fn view(w: &Value, owner: &str) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), w["uid"].clone());
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
    o.insert("spent".into(), json!(spent));
    if let Some(v) = w.get("last_check").filter(|v| !v.is_null()) {
        o.insert("last_check".into(), ts(v));
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
    Value::Object(o)
}
