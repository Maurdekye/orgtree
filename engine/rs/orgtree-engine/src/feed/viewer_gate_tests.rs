use super::viewer_gate::*;
use serde_json::{json, Value};

fn admit(gate: &mut ViewerGate, v: Value) -> Gate { gate.admit(&v.to_string()) }

#[test]
fn ping_passes_and_is_not_counted() {
    let mut gate = ViewerGate::default();
    for _ in 0..50 { assert_eq!(gate.admit("ping"), Gate::Ping); }
    assert_eq!(admit(&mut gate, json!({"type":"watch","agents":["a"]})), Gate::Ignored);
}

#[test]
fn watch_attract_and_unknown_types_are_ignored() {
    let mut gate = ViewerGate::default();
    assert_eq!(admit(&mut gate, json!({"type":"watch","agents":["a"]})), Gate::Ignored);
    assert_eq!(admit(&mut gate, json!({"type":"attract","running":true,"refuse":true})), Gate::Ignored);
    assert_eq!(admit(&mut gate, json!({"type":"anything"})), Gate::Ignored);
    assert_eq!(gate.admit("not json"), Gate::Ignored);
}

#[test]
fn subscribe_keeps_only_archive_windows() {
    let mut gate = ViewerGate::default();
    let sub = json!({"type":"subscribe","sub":3,"agents":["7"],"windows":[
        {"kind":"archived_all"},{"kind":"agent_mail","agent":"7"},{"kind":"archived_under","parent":"0"},
        {"kind":"agent_history","agent":"7"},{"kind":"something_else"}]});
    let Gate::Forward(out) = admit(&mut gate, sub) else { panic!("subscribe must be forwarded") };
    assert_eq!(out["sub"], 3);
    assert_eq!(out["agents"], json!(["7"]));
    assert_eq!(out["windows"], json!([{"kind":"archived_all"},{"kind":"archived_under","parent":"0"}]));
}

#[test]
fn unsubscribe_is_forwarded_untouched() {
    let mut gate = ViewerGate::default();
    let msg = json!({"type":"unsubscribe","sub":3});
    assert_eq!(admit(&mut gate, msg.clone()), Gate::Forward(msg));
}

#[test]
fn twenty_ignored_messages_close_the_connection() {
    let mut gate = ViewerGate::default();
    for n in 1..=IGNORED_LIMIT {
        let got = admit(&mut gate, json!({"type":"attract"}));
        if n < IGNORED_LIMIT { assert_eq!(got, Gate::Ignored, "message {n}"); } else { assert_eq!(got, Gate::Close, "message {n}"); }
    }
}
