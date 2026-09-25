//! WS3a pure tests (no database): the staff door's mode/action rules, the
//! new seat's scope derivation over the scope-clamp crate, stable ids, and
//! the DECLARED-CONTACTS table's shape.

use orgtree_store::staffing::hire::{stable_id, RC_CONTROLS};
use orgtree_store::staffing::scope::{self, ParentScope, Request};
use orgtree_store::staffing::staff::{item_action, staff_mode, ItemSpec, StaffSpec};
use orgtree_store::staffing::{declared, CONTROLS};
use serde_json::{json, Value};

fn parent() -> ParentScope {
    ParentScope {
        tools: json!({"bash": true, "web": false, "edit": true, "subagents": true, "mcp": ["a", "b"]}),
        folders: json!([{"path": "C:\\work", "mode": "rw"}, {"path": "C:\\docs", "mode": "ro"}]),
        visibility: "team".into(),
        permission_mode: "acceptEdits".into(),
    }
}

fn req<'a>(user: bool, dirs: Option<&'a Value>, tools: Option<&'a Value>, vis: &'a str, explicit: bool) -> Request<'a> {
    Request { user_actor: user, add_dirs: dirs, tools, vis, vis_explicit: explicit, org_dirs: None, default_tools: None, org_permission_mode: "bypassPermissions", ceiling: None, raise_ceiling: false }
}

#[test]
fn an_agent_cannot_grant_what_the_parent_lacks() {
    let t = json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": []});
    let r = scope::clamp_before_funding(&req(false, Some(&json!([])), Some(&t), "team", true), Some(&parent())).unwrap();
    assert_eq!(r.unwrap_err().message, "parent does not hold 'web'; cannot grant it");
    let d = json!([{"path": "C:\\docs\\x", "mode": "rw"}]);
    let r = scope::clamp_before_funding(&req(false, Some(&d), Some(&json!({"bash": true, "web": false, "edit": true, "subagents": true, "mcp": []})), "team", true), Some(&parent())).unwrap();
    assert_eq!(r.unwrap_err().message, "parent holds 'C:\\\\docs\\\\x' read-only; cannot grant read/write (№30)");
    let r = scope::clamp_before_funding(&req(false, Some(&json!([])), Some(&json!({"bash": true, "web": false, "edit": true, "subagents": true, "mcp": []})), "full", true), Some(&parent())).unwrap();
    assert_eq!(r.unwrap_err().message, "org_visibility 'full' exceeds the parent's own 'team' — visibility is a capability and only shrinks downward");
}

#[test]
fn a_user_hire_is_clamped_leniently_with_warnings() {
    let t = json!({"bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["a", "z"]});
    let (dirs, tools, vis, warns) = scope::clamp_before_funding(&req(true, None, Some(&t), "full", true), Some(&parent())).unwrap().unwrap();
    assert_eq!(dirs.len(), 2, "no add_dirs: the parent's own list");
    assert_eq!(tools, json!({"bash": true, "web": false, "edit": true, "subagents": true, "mcp": ["a"]}));
    assert_eq!(vis, "team");
    assert_eq!(warns, vec!["org_visibility clamped to the parent's own (team)".to_string(), "tool grants clamped to the parent's own: ['web', 'mcp:z']".to_string()]);
    // the permission mode: the org default capped at the parent's
    assert_eq!(scope::clamp_pm_lenient("bypassPermissions", Some(&parent())), "acceptEdits");
    assert_eq!(scope::clamp_pm_lenient("plan", Some(&parent())), "plan");
    assert_eq!(scope::clamp_pm_lenient("bypassPermissions", None), "bypassPermissions");
}

#[test]
fn staff_mode_and_action_keep_legacy_words() {
    let s = |m: Option<&str>, n: Option<&str>| StaffSpec { staff_mode: m.map(str::to_string), node: n.map(str::to_string), ..StaffSpec::default() };
    assert_eq!(staff_mode(&s(None, None)), Ok("hire"));
    assert_eq!(staff_mode(&s(None, Some("x"))), Ok("rehire"));
    assert_eq!(staff_mode(&s(Some("rehire"), None)).unwrap_err().message, "staff_mode 'rehire' needs `node`: the archived agent to bring back");
    assert!(staff_mode(&s(Some("hire"), Some("x"))).unwrap_err().message.starts_with("staff_mode 'hire' does not take `node`"));
    assert!(staff_mode(&s(Some("fire"), None)).unwrap_err().message.starts_with("staff_mode must be hire or rehire"));
    let i = |a: Option<&str>, slug: Option<&str>| ItemSpec { action: a.map(str::to_string), slug: slug.map(str::to_string), ..ItemSpec::default() };
    assert_eq!(item_action(&i(None, None)), Ok("create"));
    assert_eq!(item_action(&i(None, Some("x"))), Ok("update"));
    assert_eq!(item_action(&i(Some("update"), None)).unwrap_err().message, "action 'update' needs `slug`: the item to update and hand to this agent");
    assert!(item_action(&i(Some("archive"), Some("x"))).unwrap_err().message.starts_with("orgtree_staff writes the docket with action 'create' or 'update'"));
}

#[test]
fn stable_ids_are_stable_and_distinct() {
    assert_eq!(stable_id("a|b"), stable_id("a|b"));
    assert_ne!(stable_id("a|b"), stable_id("a|c"));
}

#[test]
fn every_verb_declares_its_receipt_and_contract() {
    let d = declared();
    let m = d.as_object().expect("object");
    for verb in ["staffing.hire", "staffing.operator_hire", "staffing.staff", "staffing.select", "quick_staff.select", "quick_staff.undo"] {
        let e = m.get(verb).unwrap_or_else(|| panic!("{verb} not declared"));
        assert_eq!(e["relations"]["operation_receipts"]["required"], json!(true), "{verb}");
        assert!(e["p01_contract"].as_str().is_some(), "{verb}");
    }
    // the island anchors are required on every seat-writing verb
    for verb in ["staffing.hire", "staffing.operator_hire"] {
        for rel in ["authority_epoch", "org_controls", "topology_edges", "scope_rows", "catalog_current", "issuer_capacity", "agent_names"] {
            assert_eq!(m[verb]["relations"][rel]["required"], json!(true), "{verb}.{rel}");
        }
    }
    assert_eq!(m["staffing.staff"]["relations"]["work_items"]["required"], json!(true));
    for c in RC_CONTROLS {
        assert!(CONTROLS.contains(c), "{c} missing from CONTROLS");
    }
}
