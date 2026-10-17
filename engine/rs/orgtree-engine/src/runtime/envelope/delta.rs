//! Semantic snapshots for dynamic turn bodies. Rendered ages never form keys.
use std::collections::BTreeMap;
use serde_json::{json, Value};
use super::OrgState;

pub(crate) struct Entry {
    pub key: String,
    pub label: String,
    pub text: String,
}

impl Entry {
    #[nolog]
    pub(crate) fn new(label: &str, semantic: &Value, text: String) -> Self {
        Self { key: super::digest(&semantic.to_string()), label: label.into(), text }
    }
}

/// Return a proposed baseline; the caller installs it only after delivery.
/// Records contain hashes/labels, never rendered provider data or status bodies.
#[nolog]
pub(crate) fn snapshot(block: &str, sid: &str, prior: &Value, entries: BTreeMap<String, Entry>, full: String, always: &str) -> OrgState {
    let previous = prior.get("entries").and_then(Value::as_object);
    let same_session = !sid.is_empty() && prior["sid"].as_str() == Some(sid) && previous.is_some();
    let pseq = prior["seq"].as_i64().unwrap_or(0);
    let mut changes = Vec::new();
    if same_session {
        let old = previous.unwrap();
        for (id, entry) in &entries {
            if old.get(id).and_then(|v| v["key"].as_str()) != Some(entry.key.as_str()) {
                changes.push(entry.text.clone());
            }
        }
        for (id, entry) in old {
            if !entries.contains_key(id) {
                changes.push(format!("Removed: {}", entry["label"].as_str().unwrap_or(id)));
            }
        }
    }
    let changed = !same_session || !changes.is_empty();
    let seq = if changed { pseq + 1 } else { pseq };
    let full_seq = if same_session { prior["full_seq"].as_i64().unwrap_or(pseq) } else { seq };
    let suffix = if always.is_empty() { String::new() } else { format!("; {always}") };
    let text = if !same_session {
        full.replacen(&format!("[{block}"), &format!("[{block} #{seq}"), 1)
    } else if changes.is_empty() {
        format!("[{block} — unchanged since #{seq}; last full #{full_seq}{suffix}]")
    } else {
        format!("[{block} #{seq} DELTA — since #{pseq}; last full #{full_seq}{suffix}]\n{}\n[END {block}]", changes.join("\n"))
    };
    let keys: serde_json::Map<String, Value> = entries.into_iter().map(|(id, e)| (id, json!({"key":e.key,"label":e.label}))).collect();
    OrgState { text, record: Some(json!({"sid":sid,"seq":seq,"full_seq":full_seq,"entries":keys})) }
}
