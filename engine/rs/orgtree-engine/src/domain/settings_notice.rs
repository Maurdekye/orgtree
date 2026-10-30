//! What a settings change did, for its change notice (`access.scope_changed`):
//! folders, tools, settings and instruction diffs read from the stored before
//! and after, never from the request (USER 2026-10-30 mc5d2672d3cc9 "should
//! show inline what exactly chsnged", meeff02af965d; @coordinator-opus
//! macb41248ab05). Only the keys named here can enter an event.
use serde_json::{json, Map, Value};

/// Parts that make a notice "Permissions changed"; any other part alone
/// reads "Settings changed" (@coordinator-opus macb41248ab05).
pub const PERMISSION_PARTS: &[&str] = &["folders", "tools", "org_visibility", "permission_mode", "charter"];

/// The settings a notice names, in the order its line reads them.
pub const VALUE_KEYS: &[&str] = &["org_visibility", "permission_mode", "effort", "fast_mode", "model_version", "account",
    "account_fallback", "harness", "session", "peer_mail", "auto_cheap_compact"];

/// One side of a change: the stored scope and the two instruction texts.
#[derive(Debug, Clone, Copy)]
pub struct Side<'a> {
    pub scope: &'a Value,
    pub charter: Option<&'a str>,
    pub team_charter: Option<&'a str>,
}

/// The tools one scope grants that the other does not: `{added, removed}`.
#[logged]
pub fn tools_diff(_before: &Value, _after: &Value) -> Value {
    json!({ "added": [], "removed": [] })
}

/// A line diff in the tool-call diff's shape `{plus, minus, lines,
/// truncated?}`, or None when the texts are the same.
#[logged]
pub fn text_diff(_before: &str, _after: &str) -> Option<Value> {
    None
}

/// Every part that differs between the two sides.
#[logged]
pub fn parts(_before: Side<'_>, _after: Side<'_>) -> Map<String, Value> {
    Map::new()
}

/// Add a setting the scope does not hold (effort, account, harness).
#[logged]
pub fn add_value(_parts: &mut Map<String, Value>, _key: &str, _from: Option<&str>, _to: Option<&str>) {}

/// The categories a notice's `changed` lists for these parts.
#[logged]
pub fn changed(_parts: &Map<String, Value>) -> Vec<String> {
    Vec::new()
}

/// The agent's one line for an `access.scope_changed` event's parts.
#[logged]
pub fn agent_line(_ev: &Value) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::scope;

    fn tools(t: Value) -> Value { scope::normalize_tools(&t) }

    #[test]
    fn red_tools_diff_names_tools_mcp_servers_and_orgtree_groups() {
        let before = tools(json!({ "web": true, "mcp": ["github"], "orgtree": { "docket": true } }));
        let after = tools(json!({ "web": false, "mcp": ["github", "jira"], "orgtree": { "docket": false }, "orgtree_disabled": true }));
        assert_eq!(tools_diff(&before, &after), json!({ "added": ["mcp:jira", "orgtree_disabled"], "removed": ["orgtree:docket", "web"] }));
        assert_eq!(tools_diff(&after, &after), json!({ "added": [], "removed": [] }));
    }

    #[test]
    fn red_text_diff_counts_lines_and_draws_hunks() {
        let d = text_diff("keep\nold rule\ntail\n", "keep\nnew rule\ntail\nmore\n").expect("the texts differ");
        assert_eq!(d["plus"], 2);
        assert_eq!(d["minus"], 1);
        assert_eq!(d["lines"], json!(["@@ -1,3 +1,4 @@", " keep", "-old rule", "+new rule", " tail", "+more"]));
        assert!(d.get("truncated").is_none());
        // a long text keeps the first 200 lines, as an Edit tool call's diff does
        let long: String = (0..300).map(|i| format!("line {i}\n")).collect();
        let d = text_diff("", &long).unwrap();
        assert_eq!(d["plus"], 300);
        assert_eq!(d["lines"].as_array().unwrap().len(), 200);
        assert_eq!(d["truncated"], true);
    }

    #[test]
    fn text_diff_is_none_for_the_same_text() {
        assert_eq!(text_diff("same\ntext\n", "same\ntext\n"), None);
        assert_eq!(text_diff("", ""), None);
    }

    fn scope_of(dirs: Value, extra: Value) -> Value {
        let mut s = json!({ "add_dirs": dirs, "tools": { "web": true }, "org_visibility": "team", "permission_mode": "acceptEdits" });
        for (k, v) in extra.as_object().unwrap() { s[k] = v.clone(); }
        scope::normalize(&s)
    }

    #[test]
    fn red_parts_name_folders_tools_settings_and_both_instructions() {
        let before = scope_of(json!([{ "path": "D:\\docs", "mode": "rw" }, { "path": "E:\\old", "mode": "rw" }]),
            json!({ "fast_mode": false, "peer_mail": true }));
        let mut after = scope_of(json!([{ "path": "D:\\docs", "mode": "ro" }, { "path": "D:\\work", "mode": "rw" }]),
            json!({ "fast_mode": true, "peer_mail": true, "org_visibility": "subtree", "auto_cheap_compact": { "enabled": true, "occ": 0.25 } }));
        after["tools"]["web"] = json!(false);
        let p = parts(Side { scope: &before, charter: Some("keep\nold\n"), team_charter: None },
                      Side { scope: &after, charter: Some("keep\nnew\n"), team_charter: Some("team rule\n") });
        assert_eq!(p["folders"], json!({ "added": [{ "path": "D:\\work", "mode": "rw" }],
            "changed": [{ "path": "D:\\docs", "from": "rw", "to": "ro" }], "removed": [{ "path": "E:\\old", "mode": "rw" }] }));
        assert_eq!(p["tools"], json!({ "added": [], "removed": ["web"] }));
        assert_eq!(p["values"], json!([
            { "key": "org_visibility", "from": "team", "to": "subtree" },
            { "key": "fast_mode", "from": "off", "to": "on" },
            { "key": "auto_cheap_compact", "from": null, "to": "on at 25%" }]));
        assert_eq!(p["charter"]["plus"], 1);
        assert_eq!(p["team_charter"]["plus"], 1);
        assert_eq!(changed(&p), ["folders", "tools", "org_visibility", "fast_mode", "auto_cheap_compact", "charter", "team_charter"]);
    }

    #[test]
    fn an_unchanged_save_has_no_parts() {
        // the settings dialog sends its whole form, the unchanged instructions included
        let s = scope_of(json!([{ "path": "D:\\docs", "mode": "rw" }]), json!({}));
        let p = parts(Side { scope: &s, charter: Some("same"), team_charter: Some("team") },
                      Side { scope: &s.clone(), charter: Some("same"), team_charter: Some("team") });
        assert!(p.is_empty(), "{p:?}");
        assert!(changed(&p).is_empty());
    }

    #[test]
    fn red_add_value_keeps_the_settings_order_and_skips_no_change() {
        let mut p = Map::new();
        add_value(&mut p, "account", Some("claude-5"), Some("claude/primary"));
        add_value(&mut p, "effort", Some("high"), Some("max"));
        add_value(&mut p, "harness", None, None);
        add_value(&mut p, "session", Some("session0"), Some("session0"));
        assert_eq!(p["values"], json!([{ "key": "effort", "from": "high", "to": "max" },
            { "key": "account", "from": "claude-5", "to": "claude/primary" }]));
    }

    #[test]
    fn red_a_dialog_save_naming_an_unchanged_charter_writes_no_notice() {
        // today's bug: every dialog save sends the charter text, so its key alone wrote "Permissions changed"
        let legacy = json!({ "change": { "charter": "the same text", "team_charter": "", "effort": "high" } });
        assert_eq!(crate::domain::lifecycle::settings_fields("@user", &legacy), None);
        assert_eq!(crate::domain::lifecycle::settings_fields("@user", &json!({ "notice": {} })), None);
    }

    #[test]
    fn red_a_notice_carries_its_parts_and_whose_change_it_follows() {
        let notice = json!({ "folders": { "added": [], "changed": [], "removed": [{ "path": "D:\\shared", "mode": "rw" }] } });
        let f = crate::domain::lifecycle::settings_fields("boss", &json!({ "notice": notice, "cascade_for": "lead" })).expect("a notice");
        assert_eq!(f, json!({ "by": "boss", "changed": ["folders"], "folders": notice["folders"], "cascade_for": "lead" }));
    }

    fn scope_event(fields: Value) -> Value {
        crate::events::typed("access.scope_changed", "boss", crate::events::node_ref("acme", "worker", 1), fields)
    }

    #[test]
    fn red_the_agent_reads_what_changed() {
        let ev = scope_event(json!({ "by": "boss", "changed": ["folders", "tools", "org_visibility", "charter"],
            "folders": { "added": [{ "path": "D:\\work", "mode": "rw" }], "changed": [], "removed": [{ "path": "E:\\old", "mode": "ro" }] },
            "tools": { "added": ["mcp:github"], "removed": ["web"] },
            "values": [{ "key": "org_visibility", "from": "team", "to": "subtree" }],
            "charter": { "plus": 3, "minus": 1, "lines": ["@@ -1 +1,3 @@"] } }));
        assert_eq!(crate::runtime::event_text::render_agent(&ev).unwrap(),
            "Your superior \"boss\" changed your configuration: folders + D:\\work (rw), − E:\\old; tools + mcp:github, − web; \
org_visibility team → subtree; charter edited (+3 −1 lines). Your current scope is stated in your system prompt each turn.");
    }

    #[test]
    fn red_a_settings_change_reads_settings_changed() {
        let ev = crate::events::typed("access.scope_changed", "@user", crate::events::node_ref("acme", "worker", 1),
            json!({ "by": "@user", "changed": ["effort", "account"], "values": [{ "key": "effort", "from": "high", "to": "max" },
                { "key": "account", "from": null, "to": "claude/primary" }] }));
        assert_eq!(crate::runtime::event_text::render_agent(&ev).unwrap(),
            "The user changed your settings: effort high → max; account default → claude/primary.");
        let queued = scope_event(json!({ "by": "boss", "changed": ["account"], "pending": "queued",
            "values": [{ "key": "account", "from": "claude-5", "to": "claude/primary" }] }));
        assert_eq!(crate::runtime::event_text::render_agent(&queued).unwrap(),
            "Your superior \"boss\" changed your settings: account claude-5 → claude/primary when your current turn ends.");
    }

    #[test]
    fn red_the_team_instructions_from_above_read_as_that_superior_s() {
        let ev = scope_event(json!({ "by": "lead", "changed": ["team_charter"], "cascade_for": "lead",
            "team_charter": { "plus": 1, "minus": 1, "lines": ["@@ -1 +1 @@", "-old", "+new"] } }));
        assert_eq!(crate::runtime::event_text::render_agent(&ev).unwrap(),
            "\"lead\" changed the standing charter it gives its team (+1 −1 lines). The new text is in your system prompt each turn.");
        let clamped = scope_event(json!({ "by": "boss", "changed": ["folders"], "cascade_for": "lead",
            "folders": { "added": [], "changed": [], "removed": [{ "path": "D:\\shared", "mode": "rw" }] } }));
        assert_eq!(crate::runtime::event_text::render_agent(&clamped).unwrap(),
            "Your scope changed with \"lead\"'s (by your superior \"boss\"): folders − D:\\shared. Your current scope is stated in your system prompt each turn.");
    }
}
