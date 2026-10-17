//! Explicit agent-hire fields; shared by preflight and MCP schemas.
use serde_json::Value;

pub const BASE: &[&str] = &["name", "tier", "grant", "charter", "index"];
pub const SCOPE: &[&str] = &["add_dirs", "tools", "org_visibility"];
pub const TOOLS: &[&str] = &["bash", "web", "edit", "subagents", "mcp"];

#[nolog]
pub fn missing_hire(_req: &Value) -> Vec<&'static str> { Vec::new() }

#[nolog]
pub fn missing_staff(_req: &Value) -> Vec<&'static str> { Vec::new() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hire_contract_reports_all_missing_fields_together() {
        let missing = missing_hire(&json!({}));
        for field in ["name","tier","grant","charter","index","add_dirs","org_visibility",
            "tools.bash","tools.web","tools.edit","tools.subagents","tools.mcp"] {
            assert!(missing.contains(&field),"missing refusal omits {field}: {missing:?}");
        }
        let full = json!({"name":"worker","tier":"sol","grant":0,"charter":"Role","index":0,
            "add_dirs":[],"org_visibility":"team","tools":{"bash":false,"web":false,"edit":false,"subagents":false,"mcp":[]}});
        assert!(missing_hire(&full).is_empty());
        let mut partial = full.clone();
        partial["tools"].as_object_mut().unwrap().remove("mcp");
        assert_eq!(missing_hire(&partial),["tools.mcp"]);
        let superior = json!({"name":"manager","tier":"sol","grant":0,"charter":"Role","index":0,"hire_type":"superior"});
        assert!(missing_hire(&superior).is_empty(),"superior inherits and must omit scope");
    }

    #[test]
    fn hire_contract_staff_reports_docket_and_seat_omissions() {
        let missing = missing_staff(&json!({}));
        for field in ["title","objective","name","tier","grant","charter","index","add_dirs","org_visibility","tools.mcp"] {
            assert!(missing.contains(&field),"staff refusal omits {field}: {missing:?}");
        }
        assert!(missing_staff(&json!({"slug":"existing","node":"archived"})).is_empty(),"rehire needs no new-hire scope or index");
        assert_eq!(missing_staff(&json!({"action":"update","staff_mode":"rehire"})),["slug","node"]);
    }
}
