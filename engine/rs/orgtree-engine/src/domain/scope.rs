//! Agent scope: folders, tools, visibility, permission mode — and the one
//! containment rule: a child's effective scope always lies within its
//! parent's (the top level within the org's own folders).

use serde_json::{json, Map, Value};

pub const PM_LEVELS: &[&str] = &["plan", "default", "acceptEdits", "bypassPermissions"];
pub const VIS_LEVELS: &[&str] = &["self", "team", "subtree", "full"];

fn rank(levels: &[&str], v: &str) -> usize {
    levels.iter().position(|l| *l == v).unwrap_or(0)
}

pub fn pm_rank(v: &str) -> usize {
    rank(PM_LEVELS, v)
}

pub fn vis_rank(v: &str) -> usize {
    rank(VIS_LEVELS, v)
}

pub fn default_tools() -> Value {
    json!({ "bash": true, "web": true, "edit": true, "subagents": true, "mcp": [] })
}

/// Fill every key a NodeScope has, keeping any extra per-node knobs.
pub fn normalize(scope: &Value) -> Value {
    let mut out = scope.as_object().cloned().unwrap_or_default();
    if !out.get("permission_mode").map(Value::is_string).unwrap_or(false) {
        out.insert("permission_mode".into(), json!("acceptEdits"));
    }
    let dirs = out.get("add_dirs").and_then(Value::as_array).cloned().unwrap_or_default();
    let dirs: Vec<Value> = dirs
        .into_iter()
        .filter_map(|d| match d {
            Value::String(p) => Some(json!({ "path": p, "mode": "rw" })),
            Value::Object(o) => {
                let path = o.get("path").and_then(Value::as_str)?.to_string();
                let mode = if o.get("mode").and_then(Value::as_str) == Some("ro") { "ro" } else { "rw" };
                Some(json!({ "path": path, "mode": mode }))
            }
            _ => None,
        })
        .collect();
    out.insert("add_dirs".into(), Value::Array(dirs));
    let tools = out.get("tools").cloned().unwrap_or_else(default_tools);
    out.insert("tools".into(), normalize_tools(&tools));
    if !out.get("org_visibility").map(Value::is_string).unwrap_or(false) {
        out.insert("org_visibility".into(), json!("subtree"));
    }
    Value::Object(out)
}

pub fn normalize_tools(t: &Value) -> Value {
    let b = |k: &str| t.get(k).and_then(Value::as_bool).unwrap_or(true);
    let mut mcp: Vec<String> = t
        .get("mcp")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    mcp.sort();
    mcp.dedup();
    json!({ "bash": b("bash"), "web": b("web"), "edit": b("edit"), "subagents": b("subagents"), "mcp": mcp })
}

fn norm_path(p: &str) -> String {
    let mut s = p.replace('/', "\\");
    while s.ends_with('\\') && s.len() > 3 {
        s.pop();
    }
    s.to_lowercase()
}

/// Is `child` the same as or inside `parent` (Windows, case-insensitive)?
pub fn path_within(child: &str, parent: &str) -> bool {
    let c = norm_path(child);
    let p = norm_path(parent);
    c == p || (c.starts_with(&p) && (p.ends_with('\\') || c.as_bytes().get(p.len()) == Some(&b'\\')))
}

/// Clamp `dirs` to `ceiling`: a dir survives only inside a ceiling dir, with
/// the stricter of the two modes.
pub fn clamp_dirs(dirs: &[Value], ceiling: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for d in dirs {
        let Some(path) = d.get("path").and_then(Value::as_str) else { continue };
        let mode = d.get("mode").and_then(Value::as_str).unwrap_or("rw");
        let mut best: Option<&str> = None;
        for c in ceiling {
            let Some(cp) = c.get("path").and_then(Value::as_str) else { continue };
            if path_within(path, cp) {
                let cm = c.get("mode").and_then(Value::as_str).unwrap_or("rw");
                best = Some(match best {
                    Some("rw") => "rw",
                    _ => cm,
                });
            }
        }
        if let Some(cm) = best {
            let eff = if mode == "ro" || cm == "ro" { "ro" } else { "rw" };
            out.push(json!({ "path": path, "mode": eff }));
        }
    }
    out
}

pub fn clamp_tools(child: &Value, parent: &Value) -> Value {
    let both = |k: &str| {
        child.get(k).and_then(Value::as_bool).unwrap_or(true) && parent.get(k).and_then(Value::as_bool).unwrap_or(true)
    };
    let list = |v: &Value| -> Vec<String> {
        v.get("mcp")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let c = list(child);
    let p = list(parent);
    let mcp: Vec<String> = if p.iter().any(|s| s == "*") {
        c
    } else if c.iter().any(|s| s == "*") {
        p
    } else {
        c.into_iter().filter(|s| p.contains(s)).collect()
    };
    json!({ "bash": both("bash"), "web": both("web"), "edit": both("edit"), "subagents": both("subagents"), "mcp": mcp })
}

/// The effective scope of a node whose configured scope is `child`, under a
/// parent whose EFFECTIVE scope is `parent`.
pub fn clamp(child: &Value, parent: &Value) -> Value {
    let child = normalize(child);
    let parent = normalize(parent);
    let mut out: Map<String, Value> = child.as_object().cloned().unwrap_or_default();
    let cpm = child["permission_mode"].as_str().unwrap_or("acceptEdits");
    let ppm = parent["permission_mode"].as_str().unwrap_or("bypassPermissions");
    out.insert("permission_mode".into(), json!(if pm_rank(cpm) <= pm_rank(ppm) { cpm } else { ppm }));
    let cv = child["org_visibility"].as_str().unwrap_or("subtree");
    let pv = parent["org_visibility"].as_str().unwrap_or("full");
    out.insert("org_visibility".into(), json!(if vis_rank(cv) <= vis_rank(pv) { cv } else { pv }));
    let cdirs = child["add_dirs"].as_array().cloned().unwrap_or_default();
    let pdirs = parent["add_dirs"].as_array().cloned().unwrap_or_default();
    out.insert("add_dirs".into(), Value::Array(clamp_dirs(&cdirs, &pdirs)));
    out.insert("tools".into(), clamp_tools(&child["tools"], &parent["tools"]));
    Value::Object(out)
}

/// The ceiling every top-level agent sits under: the org's folders, every
/// tool, every MCP server, the highest permission mode, full visibility.
pub fn org_ceiling(org_dirs: &Value) -> Value {
    json!({
        "permission_mode": "bypassPermissions",
        "add_dirs": org_dirs.as_array().cloned().unwrap_or_default(),
        "tools": { "bash": true, "web": true, "edit": true, "subagents": true, "mcp": ["*"] },
        "org_visibility": "full",
    })
}
