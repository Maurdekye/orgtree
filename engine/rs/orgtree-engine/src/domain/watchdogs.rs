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

/// A dog as a history row names it, for a chip drawn after the dog is
/// spent or removed (the desk's tables, user 2026-10-20 06:22Z): its handle,
/// owner, name, kind and mode, and `gone` once it is no longer armed or
/// paused. `name` is None when its row is gone too; the id stands in.
#[nolog]
pub fn identity(owner: &str, uid: &str, name: Option<&str>, kind: &str, once: Option<bool>, state: Option<&str>) -> Value {
    let live = matches!(state, Some("armed" | "paused"));
    json!({ "id": handle(owner, uid), "owner": owner, "name": name.unwrap_or(uid), "kind": kind,
            "once": once.unwrap_or(false), "state": state.unwrap_or("removed"), "gone": !live })
}

/// The keys a watchdog call takes only inside `credentials` (an mqtt or a
/// websocket dog's): refused at the top level of a create, blanked in
/// transcripts and refused in fire actions, whatever their case.
pub const CREDENTIAL_KEYS: &[&str] = &["headers", "bearer", "token", "authorization", "cookie", "query", "username", "password", "user", "pass", "passwd"];

/// Whether a watchdog's `credentials` value names a credentials file (no
/// secret) rather than being the credentials: a string with a folder in it
/// or a `.json` name. A bare word may be the secret itself.
#[nolog]
pub fn credentials_file(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.contains('/') || s.contains('\\') || s.to_ascii_lowercase().ends_with(".json"))
}

/// How an mqtt dog authenticates, as lists and cards show it: its
/// credentials file, or that inline credentials are stored encrypted;
/// never the credentials (docs/rust-engine/mqtt-watchdogs.md).
#[nolog]
pub fn credentials_label(memo: &Value) -> String {
    // an mqtt dog's or a websocket dog's (docs/rust-engine/websocket-watchdogs.md)
    let c = if memo.get("websocket").is_some_and(Value::is_object) { &memo["websocket"]["credentials"] } else { &memo["mqtt"]["credentials"] };
    match c["kind"].as_str() {
        Some("file") => format!("file: {}", c["path"].as_str().unwrap_or("")),
        Some("inline") => "inline credentials (stored encrypted)".into(),
        _ => "none".into(),
    }
}

/// A `watchdogs` row → the `Watchdog` the canvas and desk render.
pub fn view(w: &Value, owner: &str) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), json!(handle(owner, w["uid"].as_str().unwrap_or_default())));
    o.insert("owner".into(), json!(owner));
    o.insert("name".into(), w["name"].clone());
    o.insert("kind".into(), w["kind"].clone());
    if w["kind"] == "fair_queue" {
        o.insert("batch".into(), json!(crate::domain::projects::batch_size(&w["memo"])));
        // when its last job ended (acked or taken back): its next wait starts there
        if let Some(v) = w["memo"]["run"].get("freed_at").filter(|v| v.is_string()) {
            o.insert("freed_at".into(), ts(v));
        }
    }
    if w["kind"] == "slot" {
        o.insert("slots".into(), json!(crate::domain::slots::requested(&w["memo"])));
    }
    o.insert("fire_mode".into(), w["fire_mode"].clone());
    if let Some(q) = w.get("quiet_period_s").filter(|v| !v.is_null()) {
        o.insert("quiet_period_s".into(), q.clone());
    }
    if let Some(s) = w.get("silence_since").filter(|v| !v.is_null()) {
        o.insert("silence_since".into(), ts(s));
    }
    o.insert("target".into(), w["target"].clone());
    if let Some(config)=w["memo"]["usage"].as_object(){for (key,value) in config{o.insert(key.clone(),value.clone());}}
    for key in ["threshold","event_scope"] { if let Some(v)=w["memo"].get(key).filter(|v|!v.is_null()){o.insert(key.into(),v.clone());} }
    // a listener_watch's threshold and any dog's fire-time tool calls (bounded at create)
    for key in ["count","fire_actions"] { if let Some(v)=w["memo"].get(key).filter(|v|!v.is_null()){o.insert(key.into(),v.clone());} }
    if let Some(v)=w["memo"]["run"].get("last_output"){o.insert("last_output".into(),v.clone());}
    // an mqtt dog: how it authenticates (never with what) and its connection
    if w["kind"] == "mqtt" {
        o.insert("credentials".into(), json!(credentials_label(&w["memo"])));
        for key in ["payload_pattern", "retained"] {
            if let Some(v) = w["memo"]["mqtt"].get(key).filter(|v| !v.is_null()) { o.insert(key.into(), v.clone()); }
        }
        if let Some(v) = w["memo"]["run"].get("mqtt").filter(|v| v.is_object()) { o.insert("connection".into(), v.clone()); }
        if let Some(v) = w["memo"]["run"].get("dropped").filter(|v| !v.is_null()) { o.insert("dropped".into(), v.clone()); }
    }
    // a websocket dog: how it authenticates (never with what), what it says
    // on each connect, its connection and what it has sent
    if w["kind"] == "websocket" {
        o.insert("credentials".into(), json!(credentials_label(&w["memo"])));
        for key in ["hello", "protocols", "heartbeat"] {
            if let Some(v) = w["memo"]["websocket"].get(key).filter(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())) { o.insert(key.into(), v.clone()); }
        }
        if let Some(v) = w["memo"]["run"].get("websocket").filter(|v| v.is_object()) { o.insert("connection".into(), v.clone()); }
        for key in ["dropped", "sent", "last_sent_at", "binary"] {
            if let Some(v) = w["memo"]["run"].get(key).filter(|v| !v.is_null()) { o.insert(key.into(), v.clone()); }
        }
    }
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
        for key in ["lease"] { if let Some(v)=w["memo"].get(key).filter(|v|!v.is_null()){o.insert(key.into(),v.clone());} }
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
        assert_eq!(g["lease"],json!("sab"));
        assert!(g.get("slot").is_none(), "permit indexes stay internal");
        assert!(view(&json!({"uid":"x","kind":"command","memo":{"queued_at":1}}),"b").get("queued_at").is_none());
    }
    /// A fair-queue listener shows when its last job ended; a history row's
    /// dog keeps its identity after the dog is gone.
    #[test]
    fn a_mail_listener_view_carries_its_freed_time_and_a_kept_dog_its_identity() {
        let raw=json!({"uid":"q","kind":"fair_queue","state":"armed","created_at":"2026-01-01T00:00:00Z",
            "memo":{"target_id":7,"run":{"freed_at":"2026-01-01T00:05:00.123456+00:00"}}});
        assert_eq!(view(&raw,"qa")["freed_at"],json!("2026-01-01T00:05:00.123Z"));
        assert!(view(&json!({"uid":"q","kind":"fair_queue","memo":{}}),"qa").get("freed_at").is_none());
        let kept=identity("qa","q",Some("q"),"fair_queue",Some(false),Some("armed"));
        assert_eq!((kept["id"].clone(),kept["gone"].clone()),(json!("qa/q"),json!(false)));
        let gone=identity("sa","claim",None,"slot",None,None);
        assert_eq!((gone["name"].clone(),gone["state"].clone(),gone["gone"].clone()),(json!("claim"),json!("removed"),json!(true)));
        assert_eq!(identity("sa","claim",Some("claim"),"slot",Some(true),Some("spent"))["gone"],json!(true));
    }
    /// A listener_watch shows its count; fire-time tool calls ride along for the listeners tab.
    #[test]
    fn a_listener_watch_view_carries_its_count_and_fire_actions() {
        let raw=json!({"uid":"all-in","kind":"listener_watch","state":"armed","created_at":"2026-01-01T00:00:00Z",
            "memo":{"target_id":7,"count":3,"fire_actions":[{"tool":"orgtree_project","args":{"action":"fire_event"}}]}});
        let v=view(&raw,"boss");
        assert_eq!(v["count"],json!(3));
        assert_eq!(v["fire_actions"][0]["tool"],json!("orgtree_project"));
        let plain=view(&json!({"uid":"x","kind":"project_listener","memo":{"target_id":7}}),"b");
        assert!(plain.get("count").is_none() && plain.get("fire_actions").is_none());
    }
    /// An mqtt dog's card (docs/rust-engine/mqtt-watchdogs.md) says how it
    /// authenticates, never with what, and what state its connection is in.
    #[test]
    fn an_mqtt_view_names_its_credentials_without_them_and_shows_its_connection() {
        let raw=json!({"uid":"door","kind":"mqtt","state":"armed","target":"mqtts://broker.local:8883","pattern":"home/#",
            "created_at":"2026-01-01T00:00:00Z",
            "memo":{"mqtt":{"credentials":{"kind":"inline"},"retained":true,"payload_pattern":"open"},
                    "run":{"mqtt":{"state":"down","since":"2026-01-01T00:00:00Z","error":"the broker closed the connection",
                                   "retry_at":"2026-01-01T00:01:00Z"},"dropped":2}}});
        let v=view(&raw,"boss");
        assert_eq!(v["credentials"],json!("inline credentials (stored encrypted)"));
        assert_eq!((v["retained"].clone(),v["payload_pattern"].clone()),(json!(true),json!("open")));
        assert_eq!(v["connection"]["state"],json!("down"));
        assert_eq!(v["connection"]["error"],json!("the broker closed the connection"));
        assert_eq!(v["dropped"],json!(2));
        let file=json!({"uid":"d2","kind":"mqtt","memo":{"mqtt":{"credentials":{"kind":"file","path":"C:\\creds\\broker.json"}}}});
        assert_eq!(view(&file,"boss")["credentials"],json!("file: C:\\creds\\broker.json"));
        let anonymous=view(&json!({"uid":"d3","kind":"mqtt","memo":{"mqtt":{"credentials":null}}}),"boss");
        assert_eq!(anonymous["credentials"],json!("none"));
        assert!(view(&json!({"uid":"x","kind":"command"}),"boss").get("credentials").is_none());
    }
}
