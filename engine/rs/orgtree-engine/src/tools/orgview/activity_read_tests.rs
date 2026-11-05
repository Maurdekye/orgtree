//! Red tests for `orgtree_state_inspect activity=true` (spec rev 1.0, @item:orgtree/agents-can-read-other-agents-activity-state-hist;
//! USER 2026-11-05 maac5e83fa61e "agents should be able to inspect the activity history of other agents"):
//! the argument rules (AH6), the visibility / archived / project rules (AH3, AH4, AH5, AH7) through the pure projection,
//! and that the parameters live on this one tool (AH9). The database-backed pages are proven on a real rig engine.
use super::*;

fn names(list: &[&str]) -> Vec<String> { list.iter().map(|s| s.to_string()).collect() }
fn refusal(args: Value, list: &[&str]) -> String { parse_activity_args(&args, &names(list)).unwrap_err().to_string() }

#[test]
fn ah6_activity_is_off_by_default_and_a_valid_request_parses_with_defaults() {
    assert_eq!(parse_activity_args(&json!({"node": "a"}), &names(&["a"])).unwrap(), None);
    assert_eq!(parse_activity_args(&json!({"activity": false, "node": "a"}), &names(&["a"])).unwrap(), None);
    assert_eq!(parse_activity_args(&json!({"activity": true, "node": "a"}), &names(&["a"])).unwrap(),
        Some(ActivityArgs { limit: 20, before: None }));
    assert_eq!(parse_activity_args(&json!({"activity": true, "activity_limit": 100, "activity_cursor": "48213"}), &names(&["a"])).unwrap(),
        Some(ActivityArgs { limit: 100, before: Some(48213) }));
    assert_eq!(parse_activity_args(&json!({"activity": true, "activity_limit": 1}), &names(&["a"])).unwrap().unwrap().limit, 1);
}

#[test]
fn ah6_every_bad_activity_request_is_refused_with_its_own_text() {
    let one = "activity reads one agent at a time; pass a single node";
    assert_eq!(refusal(json!({"activity": true, "nodes": ["a", "b"]}), &["a", "b"]), one, "two names");
    assert_eq!(refusal(json!({"activity": true}), &[]), one, "no name");
    // spec rev 1.0a: DISTINCT trimmed names count, so node=a plus nodes=[a] is one agent
    assert_eq!(parse_activity_args(&json!({"activity": true, "node": "a", "nodes": ["a"]}), &names(&["a", "a"])).unwrap(),
        Some(ActivityArgs { limit: 20, before: None }), "the same agent named twice is one agent");
    let need = "activity_limit and activity_cursor need activity=true";
    assert_eq!(refusal(json!({"activity_limit": 5, "node": "a"}), &["a"]), need);
    assert_eq!(refusal(json!({"activity_cursor": "7", "node": "a"}), &["a"]), need);
    assert_eq!(refusal(json!({"activity": false, "activity_limit": 5}), &["a"]), need);
    let limit = "activity_limit must be an integer from 1 to 100";
    for bad in [json!(0), json!(101), json!(-3), json!(1.5), json!("5")] {
        assert_eq!(refusal(json!({"activity": true, "activity_limit": bad}), &["a"]), limit);
    }
    let cursor = "activity_cursor must be a returned activity cursor";
    for bad in [json!("abc"), json!("0"), json!("-4"), json!(""), json!(7)] {
        assert_eq!(refusal(json!({"activity": true, "activity_cursor": bad}), &["a"]), cursor);
    }
    assert_eq!(refusal(json!({"activity": "yes"}), &["a"]), "activity must be true or false");
}

/// Caller n1 (self visibility: itself and its reports), n2 its report, n3 an unrelated top-level agent, n4 an archived report,
/// n5 a project under n1.
fn fixture() -> (HashMap<i64, (Option<i64>, Value)>, HashMap<i64, Option<i64>>, Vec<(i64, Value)>, Value) {
    let ceiling = json!({"org_visibility": "full", "tools": {}, "add_dirs": []});
    let scopes = HashMap::from([
        (1, (None, json!({"org_visibility": "self"}))), (2, (Some(1), json!({}))), (3, (None, json!({}))),
        (4, (Some(1), json!({}))), (5, (Some(1), json!({"transparent": true}))),
    ]);
    let reporting = HashMap::from([(1, None), (2, Some(1)), (3, None), (4, Some(1))]);
    let rec = |id: i64, state: &str| (id, json!({"name": format!("n{id}"), "state": state, "tier": "sol"}));
    let mut project = rec(5, "live");
    project.1["kind"] = json!("project");
    let records = vec![rec(1, "live"), rec(2, "live"), rec(3, "live"), rec(4, "archived"), project];
    (scopes, reporting, records, ceiling)
}
fn project(who: &[&str], archived: bool, activity: bool) -> Result<Value> {
    let (scopes, reporting, records, ceiling) = fixture();
    inspection_projection(1, "n1".into(), archived, names(who), scopes, reporting, records, ceiling, activity)
        .map(|d| serde_json::from_str(&d.text).unwrap())
}
const OUTSIDE: &str = "state inspection is outside your visible scope";

#[test]
fn ah3_an_out_of_scope_unknown_or_archived_target_is_refused_with_the_existing_text() {
    for who in ["n3", "nobody"] {
        let e = project(&[who], false, true).unwrap_err().to_string();
        assert_eq!(e, format!("{OUTSIDE}: {who}"));
    }
    assert_eq!(project(&["n4"], false, true).unwrap_err().to_string(), format!("{OUTSIDE}: n4"), "archived without include_archived");
}

#[test]
fn ah4_an_archived_visible_target_is_returned_with_include_archived() {
    let v = project(&["n4"], true, true).unwrap();
    assert_eq!(v["nodes"][0]["name"], "n4");
}

#[test]
fn ah5_a_visible_project_is_refused_for_activity_but_still_inspectable_without_it() {
    assert_eq!(project(&["n5"], false, true).unwrap_err().to_string(), "activity history lists an agent's states; a project has none");
    assert_eq!(project(&["n5"], false, false).unwrap()["nodes"][0]["name"], "n5");
}

#[test]
fn ah7_the_caller_can_read_its_own_activity_and_a_visible_report() {
    assert_eq!(project(&["n1"], false, true).unwrap()["nodes"][0]["name"], "n1");
    assert_eq!(project(&["n2"], false, true).unwrap()["nodes"][0]["name"], "n2");
}

#[test]
fn ah9_the_activity_parameters_exist_only_on_orgtree_state_inspect() {
    let cards: Value = serde_json::from_slice(&serde_json::to_vec(&crate::tools::defs::list()).unwrap()).unwrap();
    let mut with = Vec::new();
    for card in cards.as_array().unwrap() {
        let props = &card["inputSchema"]["properties"];
        if props.get("activity").is_some() || props.get("activity_limit").is_some() || props.get("activity_cursor").is_some() {
            with.push(card["name"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(with, vec!["orgtree_state_inspect"]);
    let p = &cards.as_array().unwrap().iter().find(|c| c["name"] == "orgtree_state_inspect").unwrap()["inputSchema"]["properties"];
    assert_eq!(p["activity"]["type"], "boolean");
    assert_eq!(p["activity_limit"]["type"], "integer");
    assert_eq!(p["activity_limit"]["minimum"], 1);
    assert_eq!(p["activity_limit"]["maximum"], 100);
    assert!(p["activity_limit"]["description"].as_str().unwrap().contains("default 20"));
    assert_eq!(p["activity_cursor"]["type"], "string");
    assert_eq!(crate::domain::tool_groups::required("orgtree_state_inspect"), Some(&["inspection"][..]), "the inspection gate is unchanged");
}
