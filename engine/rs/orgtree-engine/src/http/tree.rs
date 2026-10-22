//! The full `TreePayload`, projected server-side from the feed's snapshot.
//! Used for the first tree read (it carries `capabilities.record_changes_v1`,
//! after which the renderer builds the tree from records itself) and for the
//! compatibility reads that ask for "everything".

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::feed::groups::GROUPS;

#[logged]
pub fn project(snapshot: &Value) -> Vec<u8> {
    let records = snapshot["records"].as_array().cloned().unwrap_or_default();
    let mut header = Map::new();
    let mut agents: HashMap<String, Map<String, Value>> = HashMap::new();
    for r in &records {
        let entity = r["entity"].as_str().unwrap_or("");
        let id = r["id"].as_str().unwrap_or("");
        if entity == "org" && GROUPS.contains(&id) {
            if let Some(o) = r["body"].as_object() {
                for (k, v) in o {
                    header.insert(k.clone(), v.clone());
                }
            }
        } else if entity == "agent" {
            if let Some(o) = r["body"].as_object() {
                agents.insert(id.to_string(), o.clone());
            }
        }
    }
    // runtime overlay
    if let Some(rt) = snapshot.pointer("/runtime/agents").and_then(Value::as_object) {
        for (id, v) in rt {
            if let (Some(a), Some(vals)) = (agents.get_mut(id), v.as_object()) {
                for (k, val) in vals {
                    if k != "epoch" && k != "seq" && k != "ask_linger_visible" {
                        a.insert(k.clone(), val.clone());
                    }
                }
            }
        }
    }
    // Retired agents held here (the feed's pile representatives) count once:
    // the rest of each parent's retired total stays a hidden count.
    let mut held: HashMap<Option<String>, i64> = HashMap::new();
    for a in agents.values() {
        if a.get("state").and_then(Value::as_str) == Some("archived") {
            *held.entry(a.get("parent_id").and_then(Value::as_str).map(str::to_string)).or_default() += 1;
        }
    }
    let mut children: HashMap<Option<String>, Vec<String>> = HashMap::new();
    for (id, a) in &agents {
        let parent = a.get("parent_id").and_then(Value::as_str).map(str::to_string);
        let parent = parent.filter(|p| agents.contains_key(p));
        children.entry(parent).or_default().push(id.clone());
    }
    for v in children.values_mut() {
        v.sort_by(|x, y| {
            let ax = &agents[x];
            let ay = &agents[y];
            let ox = ax.get("sibling_order").and_then(Value::as_f64).unwrap_or(0.0);
            let oy = ay.get("sibling_order").and_then(Value::as_f64).unwrap_or(0.0);
            ox.partial_cmp(&oy)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| ax.get("created").and_then(Value::as_str).cmp(&ay.get("created").and_then(Value::as_str)))
                .then_with(|| ax.get("ord").and_then(Value::as_i64).cmp(&ay.get("ord").and_then(Value::as_i64)))
        });
    }
    let rev = snapshot.pointer("/cursor/rev").cloned().unwrap_or(json!(0));
    let retired_total = header.remove("retired_total").unwrap_or(json!(0));
    let retired_roots = header.remove("retired_roots_total").and_then(|t| t.as_i64()).unwrap_or(0);
    let retired_roots = (retired_roots - held.get(&None).copied().unwrap_or(0)).max(0);
    header.remove("roots");
    header.insert("capabilities".into(), json!({ "record_changes_v1": true }));
    header.insert("sync_rev".into(), rev.clone());
    header.insert("org_rev".into(), rev);
    header.insert(
        "foreground".into(),
        json!({ "catalog_revision": "full", "present": agents.values().map(|a| a["id"].clone()).collect::<Vec<_>>(),
                "missing": [], "hidden_retired_roots": retired_roots, "retired_total": retired_total }),
    );
    // The compatibility transport is nested JSON, but building a nested Value
    // would recurse again when serializing AND when dropping it. Keep records
    // flat and write only the tree structure with an explicit heap stack.
    // serde_json still owns field/string escaping and each shallow record.
    let mut out = serde_json::to_vec(&header).expect("JSON header values serialize");
    out.pop(); // header's closing object brace; roots is its last field
    out.extend_from_slice(b",\"roots\":[");
    enum Part<'a> {
        Node(&'a str, Option<&'a str>),
        Bytes(&'static [u8]),
    }
    let mut pending = Vec::new();
    if let Some(roots) = children.get(&None) {
        for (i, id) in roots.iter().enumerate().rev() {
            pending.push(Part::Node(id, None));
            if i > 0 { pending.push(Part::Bytes(b",")); }
        }
    }
    while let Some(part) = pending.pop() {
        let Part::Node(id, parent) = part else {
            if let Part::Bytes(bytes) = part { out.extend_from_slice(bytes); }
            continue;
        };
        let mut node = agents[id].clone();
        node.remove("parent_id");
        node.remove("sibling_order");
        node.remove("children");
        if let Some(total) = node.remove("retired_children_total").and_then(|t| t.as_i64()) {
            let shown = held.get(&Some(id.to_string())).copied().unwrap_or(0);
            node.insert("hidden_retired_children".into(), json!((total - shown).max(0)));
        }
        node.insert("parent".into(), parent.and_then(|p| agents.get(p))
            .map(|p| p["id"].clone()).unwrap_or(Value::Null));
        let mut encoded = serde_json::to_vec(&node).expect("JSON node values serialize");
        encoded.pop();
        out.extend_from_slice(&encoded);
        out.extend_from_slice(b",\"children\":[");
        pending.push(Part::Bytes(b"]}"));
        if let Some(kids) = children.get(&Some(id.to_string())) {
            for (i, child) in kids.iter().enumerate().rev() {
                pending.push(Part::Node(child, Some(id)));
                if i > 0 { pending.push(Part::Bytes(b",")); }
            }
        }
    }
    out.extend_from_slice(b"]}");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[nolog]
    fn record(id: &str, body: Value) -> Value {
        json!({"entity":"agent","id":id,"body":body})
    }

    #[test]
    fn compatibility_fields_order_runtime_and_retired_counts_survive() {
        let snapshot = json!({"cursor":{"rev":17},"records":[
            {"entity":"org","id":"settings","body":{"name":"test","retired_total":5,"retired_roots_total":2}},
            record("2",json!({"id":"child","parent_id":"1","sibling_order":2,"state":"live","title":"quotes \" \\ 🦀"})),
            record("3",json!({"id":"old","parent_id":"1","sibling_order":1,"state":"archived"})),
            record("1",json!({"id":"boss","parent_id":null,"state":"live","retired_children_total":4})),
            record("4",json!({"id":"orphan","parent_id":"missing","state":"archived"}))
        ],"runtime":{"agents":{"2":{"busy":true,"seq":9,"epoch":"ignore","ask_linger_visible":true}}}});
        let actual: Value = serde_json::from_slice(&project(&snapshot)).unwrap();
        let roots = actual["roots"].as_array().unwrap();
        let boss = roots.iter().find(|n| n["id"] == "boss").unwrap();
        assert_eq!(boss["parent"], Value::Null);
        assert_eq!(boss["hidden_retired_children"], 3);
        assert_eq!(boss["children"][0]["id"], "old");
        assert_eq!(boss["children"][1]["parent"], "boss");
        assert_eq!(boss["children"][1]["busy"], true);
        assert_eq!(boss["children"][1]["title"], "quotes \" \\ 🦀");
        for key in ["parent_id", "sibling_order", "seq", "epoch", "ask_linger_visible"] {
            assert!(boss["children"][1].get(key).is_none(), "{key}");
        }
        assert_eq!(actual["sync_rev"], 17);
        assert_eq!(actual["org_rev"], 17);
        assert_eq!(actual["foreground"]["retired_total"], 5);
        // A missing physical parent is normalized only for placement; the
        // existing retired-root tally still groups by the stored parent link.
        assert_eq!(actual["foreground"]["hidden_retired_roots"], 2);
        assert_eq!(actual["capabilities"]["record_changes_v1"], true);
        assert_eq!(actual["foreground"]["present"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn deep_tree_bytes_do_not_build_serialize_or_drop_recursive_values() {
        let records: Vec<Value> = (0..=2049).map(|i| record(&i.to_string(), json!({
            "id":format!("node-{i}"),"parent_id":if i==0 {Value::Null} else {json!((i-1).to_string())},
            "state":"live","sibling_order":0
        }))).collect();
        let bytes = project(&json!({"cursor":{"rev":1},"records":records}));
        let text = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(text.matches("\"children\":[").count(), 2050);
        assert!(text.contains("\"id\":\"node-2049\""));
        assert!(text.contains("\"parent\":\"node-2048\",\"children\":[]"));
        assert_eq!(text.bytes().filter(|b| *b==b'{').count(), text.bytes().filter(|b| *b==b'}').count());
        assert_eq!(text.bytes().filter(|b| *b==b'[').count(), text.bytes().filter(|b| *b==b']').count());
    }
}
