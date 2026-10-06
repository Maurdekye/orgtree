//! The full `TreePayload`, projected server-side from the feed's snapshot.
//! Used for the first tree read (it carries `capabilities.record_changes_v1`,
//! after which the renderer builds the tree from records itself) and for the
//! compatibility reads that ask for "everything".

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::feed::groups::GROUPS;

pub fn project(snapshot: &Value) -> Value {
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
    fn build(
        id: &str,
        parent: Option<&str>,
        agents: &HashMap<String, Map<String, Value>>,
        children: &HashMap<Option<String>, Vec<String>>,
        depth: usize,
    ) -> Value {
        let mut node = agents[id].clone();
        node.remove("parent_id");
        node.remove("sibling_order");
        node.remove("retired_children_total");
        let kids: Vec<Value> = if depth < 1024 {
            children
                .get(&Some(id.to_string()))
                .map(|ks| ks.iter().map(|k| build(k, Some(id), agents, children, depth + 1)).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        node.insert(
            "parent".into(),
            parent.and_then(|p| agents.get(p)).map(|p| p["id"].clone()).unwrap_or(Value::Null),
        );
        node.insert("children".into(), Value::Array(kids));
        Value::Object(node)
    }
    let roots: Vec<Value> = children
        .get(&None)
        .map(|ks| ks.iter().map(|k| build(k, None, &agents, &children, 0)).collect())
        .unwrap_or_default();
    let rev = snapshot.pointer("/cursor/rev").cloned().unwrap_or(json!(0));
    let retired_total = header.remove("retired_total").unwrap_or(json!(0));
    let retired_roots = header.remove("retired_roots_total").unwrap_or(json!(0));
    header.insert("roots".into(), Value::Array(roots));
    header.insert("capabilities".into(), json!({ "record_changes_v1": true }));
    header.insert("sync_rev".into(), rev.clone());
    header.insert("org_rev".into(), rev);
    header.insert(
        "foreground".into(),
        json!({ "catalog_revision": "full", "present": agents.values().map(|a| a["id"].clone()).collect::<Vec<_>>(),
                "missing": [], "hidden_retired_roots": retired_roots, "retired_total": retired_total }),
    );
    Value::Object(header)
}
