//! Shared scope vocabulary for Orgtree tools. Missing switches preserve the
//! historical grant; explicit denial is inherited through the scope chain.
use serde_json::{json, Map, Value};

pub const GROUPS: &[&str] = &["docket", "team", "messaging", "inspection", "watchdogs", "runtime", "user"];

#[nolog]
pub fn enabled(tools: &Value, group: &str) -> bool {
    tools.get("orgtree").and_then(|g| g.get(group)).and_then(Value::as_bool).unwrap_or(true)
}

/// Reject misspelled or non-boolean grants at mutation boundaries. A missing
/// group remains compatible with existing scopes; invalid input is not a grant.
#[logged]
pub fn validate(tools: &Value) -> anyhow::Result<()> {
    if let Some(groups) = tools.get("orgtree") {
        let Some(groups) = groups.as_object() else {
            crate::refuse!(BadRequest, "tools.orgtree must be an object of group switches");
        };
        for (name, value) in groups {
            if !GROUPS.contains(&name.as_str()) {
                crate::refuse!(BadRequest, "unknown Orgtree tool group {name}");
            }
            if !value.is_boolean() {
                crate::refuse!(BadRequest, "tools.orgtree.{name} must be true or false");
            }
        }
    }
    Ok(())
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
        "hire" | "rehire" | "retire" | "dissolve" | "move" | "reorder" | "rename" | "reallocate"
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

/// Group requests reuse scope cards' existing `kind: tool` identity.
#[nolog]
pub fn request_group(name: &str) -> Option<&str> {
    name.strip_prefix("orgtree.").filter(|g| GROUPS.contains(g))
}

#[logged]
pub fn grant_requested(tools: &mut Value, name: &str) {
    if let Some(group) = request_group(name) {
        if !tools["orgtree"].is_object() { tools["orgtree"] = json!({}); }
        tools["orgtree"][group] = json!(true);
    } else {
        tools[name] = json!(true);
    }
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
    fn invalid_group_grants_are_refused() {
        for bad in [json!({"orgtree":null}), json!({"orgtree":{"docket":"false"}}), json!({"orgtree":{"typo":false}})] {
            assert!(validate(&bad).is_err());
        }
        assert!(validate(&json!({})).is_ok());
        assert!(validate(&json!({"orgtree":{"docket":false}})).is_ok());
    }

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
