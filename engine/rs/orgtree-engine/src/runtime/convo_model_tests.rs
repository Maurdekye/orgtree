use super::tool_refs;
use serde_json::{json, Value};

#[test]
fn model_change_keeps_recorded_old_and_new_models_after_serialization() {
    for name in ["orgtree_switch_model", "mcp__orgtree__orgtree_switch_model", "orgtree_retool"] {
        let out = json!({"node":"worker","previous_tier":"haiku","tier":"sol"});
        let refs = tool_refs(name, &json!({"node":"worker","tier":"astra","previous_tier":"sonnet"}), Some(&out.to_string()));
        let stored: Value = serde_json::from_str(&refs.to_string()).unwrap();
        assert_eq!(stored, json!([{"kind":"agent","id":"worker","model_change":{"from":"haiku","to":"sol"}}]));
    }
}

#[test]
fn model_change_legacy_success_keeps_new_model_without_inventing_old() {
    let out = r#"{"node":"worker","tier":"sol"}"#;
    assert_eq!(tool_refs("orgtree_switch_model", &json!({"node":"worker","previous_tier":"haiku"}), Some(out)),
        json!([{"kind":"agent","id":"worker","model_change":{"from":null,"to":"sol"}}]));
}

#[test]
fn model_change_does_not_treat_requests_queues_errors_or_noops_as_applied() {
    let input = json!({"node":"worker","tier":"sol","previous_tier":"haiku"});
    for out in [None, Some("refused"), Some("{}"), Some(r#"{"node":"worker","pending_switch":"sol","queued":true}"#),
        Some(r#"{"node":"worker","tier":"sol","previous_tier":"haiku","queued":true}"#),
        Some(r#"{"node":"worker","tier":"sol","previous_tier":"sol"}"#),
        Some(r#"{"node":"worker","tier":"sol","unchanged":true}"#),
        Some(r#"{"node":"worker","tier":"sol","isError":true}"#),
        Some(r#"{"node":"worker","tier":"sol","error":"denied"}"#),
        Some(r#"{"node":"worker","tier":""}"#)] {
        assert_eq!(tool_refs("orgtree_switch_model", &input, out), json!([{"kind":"agent","id":"worker"}]));
    }
    let out = r#"{"node":"worker","tier":"sol","previous_tier":"haiku"}"#;
    for name in ["orgtree_hire", "orgtree_rehire", "orgtree_staff", "orgtree_read_transcript"] {
        assert!(tool_refs(name, &input, Some(out)).as_array().unwrap().iter().all(|r| r.get("model_change").is_none()));
    }
}
