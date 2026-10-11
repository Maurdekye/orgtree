//! Shared scope vocabulary for Orgtree tools. Missing switches preserve the
//! historical grant; explicit denial is inherited through the scope chain.
use serde_json::{json, Map, Value};

pub const GROUPS: &[&str] = &["docket", "team", "messaging", "inspection", "watchdogs", "runtime", "user"];

#[nolog]
pub fn enabled(tools: &Value, group: &str) -> bool {
    tools.get("orgtree").and_then(|g| g.get(group)).and_then(Value::as_bool).unwrap_or(true)
}

#[logged]
pub fn normalize(tools: &Value) -> Value {
    Value::Object(GROUPS.iter().map(|g| ((*g).to_owned(), json!(enabled(tools, g)))).collect())
}

#[logged]
pub fn intersect(child: &Value, parent: &Value) -> Value {
    Value::Object(GROUPS.iter().map(|g| ((*g).to_owned(), json!(enabled(child, g) && enabled(parent, g)))).collect())
}

/// None means an unknown tool, not an unrestricted tool. Status is the sole
/// empty prerequisite list: every agent must be able to report done/blocked.
#[nolog]
pub fn required(name: &str) -> Option<&'static [&'static str]> {
    Some(match name.strip_prefix("orgtree_")? {
        "status" => &[],
        "work" => &["docket"],
        "staff" => &["docket", "team"],
        "hire" | "rehire" | "retire" | "dissolve" | "move" | "rename" | "reallocate"
        | "switch_model" | "cheap_compact" | "retool" | "swap" | "self_subjugate" => &["team"],
        "message" | "send_notice" | "inbox" | "audience" | "transfers" => &["messaging"],
        "chart" | "state_inspect" | "list_tiers" | "list_orgs" | "read_transcript" | "read_scratch" => &["inspection"],
        "watchdog" => &["watchdogs"],
        "interrupt" | "halt" | "unhalt" | "unstick" | "continue_on" | "account_mark" => &["runtime"],
        "ask" | "withdraw_ask" | "present" | "send_file" | "request_credits" | "request_scope" => &["user"],
        _ => return None,
    })
}

#[nolog]
pub fn allows(tools: &Value, name: &str) -> bool {
    required(name).is_some_and(|groups| groups.iter().all(|g| enabled(tools, g)))
}

#[logged]
pub fn schema() -> Value {
    let properties: Map<String, Value> = GROUPS.iter().map(|g| ((*g).to_owned(), json!({"type": "boolean"}))).collect();
    json!({"type": "object", "properties": properties, "additionalProperties": false,
        "description": "Orgtree tool groups (omitted groups stay on); status reporting is always available. staff needs docket and team."})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_served_tool_has_a_group_and_status_survives_all_off() {
        let off = json!({"orgtree": GROUPS.iter().map(|g| ((*g).to_owned(), json!(false))).collect::<Map<_,_>>()});
        for tool in crate::tools::defs::implemented() {
            assert!(required(tool).is_some(), "unclassified tool: {tool}");
            assert!(allows(&json!({}), tool), "default lost {tool}");
            assert_eq!(allows(&off, tool), *tool == "orgtree_status", "all off: {tool}");
        }
        assert!(!allows(&json!({}), "orgtree_unknown"));
        assert!(!allows(&json!({"orgtree":{"docket":false}}), "orgtree_staff"));
        assert!(!allows(&json!({"orgtree":{"team":false}}), "orgtree_staff"));
    }
}
