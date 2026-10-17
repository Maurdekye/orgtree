//! Explicit agent-hire fields; shared by preflight and MCP schemas.
use serde_json::Value;

pub const BASE: &[&str] = &["name", "tier", "grant", "charter", "index"];
pub const SCOPE: &[&str] = &["add_dirs", "tools", "org_visibility"];
pub const TOOLS: &[&str] = &["bash", "web", "edit", "subagents", "mcp"];

#[nolog]
pub fn missing_hire(req: &Value) -> Vec<&'static str> {
    let mut missing = Vec::new();
    for field in ["name", "tier"] { if text(req,field).is_none() { missing.push(field); } }
    if req["grant"].as_f64().is_none() { missing.push("grant"); }
    if text(req,"charter").is_none() { missing.push("charter"); }
    if req["index"].as_u64().is_none() { missing.push("index"); }
    // Superior insertion copies the target's scope and forbids these fields.
    if text(req,"hire_type") != Some("superior") && text(req,"above").is_none() {
        if !req["add_dirs"].is_array() { missing.push("add_dirs"); }
        if text(req,"org_visibility").is_none() { missing.push("org_visibility"); }
        for (key,label) in TOOLS.iter().zip(["tools.bash","tools.web","tools.edit","tools.subagents","tools.mcp"]) {
            if req["tools"].get(*key).is_none() { missing.push(label); }
        }
    }
    missing
}

#[nolog]
pub fn missing_staff(req: &Value) -> Vec<&'static str> {
    let mut missing=Vec::new();
    let action=text(req,"action").unwrap_or(if text(req,"slug").is_some() { "update" } else { "create" });
    match action {
        "create" => for field in ["title","objective"] { if text(req,field).is_none() { missing.push(field); } },
        "update" => if text(req,"slug").is_none() { missing.push("slug"); },
        _ => return missing,
    }
    if text(req,"node").is_some() || text(req,"staff_mode")==Some("rehire") {
        if text(req,"node").is_none() { missing.push("node"); }
    } else { missing.extend(missing_hire(req)); }
    missing
}

#[nolog]
fn text<'a>(req: &'a Value,field: &str) -> Option<&'a str> {
    req[field].as_str().map(str::trim).filter(|s| !s.is_empty())
}

#[nolog]
pub fn require_hire(req: &Value) -> anyhow::Result<()> {
    let missing=missing_hire(req);
    if !missing.is_empty() { crate::refuse!(BadRequest,"agent hires have no defaults — missing required fields: {}",missing.join(", ")); }
    Ok(())
}

#[nolog]
pub fn require_staff(req: &Value) -> anyhow::Result<()> {
    let missing=missing_staff(req);
    if !missing.is_empty() { crate::refuse!(BadRequest,"staff is missing required fields: {}",missing.join(", ")); }
    Ok(())
}

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
