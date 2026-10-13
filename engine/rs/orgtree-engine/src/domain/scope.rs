//! Agent scope: folders, tools, visibility, permission mode — and the one
//! containment rule: a child's effective scope always lies within its
//! parent's (the top level within the org's own folders).

use serde_json::{json, Map, Value};

pub const PM_LEVELS: &[&str] = &["plan", "default", "acceptEdits", "bypassPermissions"];
pub const VIS_LEVELS: &[&str] = &["self", "team", "subtree", "full"];

fn rank(levels: &[&str], v: &str) -> usize {
    levels.iter().position(|l| *l == v).unwrap_or(0)
}

/// The narrowest visibility along a chain, from the org's ceiling (full):
/// what `clamp` makes of it, an unset or unknown value counting as subtree.
#[logged]
pub fn narrowest_visibility<'a>(chain: impl IntoIterator<Item = Option<&'a str>>) -> &'static str {
    let mut eff: &'static str = "full";
    for v in chain {
        let v = v.and_then(|s| VIS_LEVELS.iter().find(|l| **l == s).copied()).unwrap_or("subtree");
        if vis_rank(v) < vis_rank(eff) {
            eff = v;
        }
    }
    eff
}

/// The levels as 3.x's refusals name them: `('plan', 'default', …)`.
#[logged]
pub fn levels_text(levels: &[&str]) -> String {
    format!("({})", levels.iter().map(|l| format!("'{l}'")).collect::<Vec<_>>().join(", "))
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
    json!({ "bash": b("bash"), "web": b("web"), "edit": b("edit"), "subagents": b("subagents"), "mcp": mcp,
        "orgtree": super::tool_groups::normalize(t) })
}

#[logged]
pub(crate) fn norm_path(p: &str) -> String {
    // Match 3.x normpath before containment: work/../outside is not inside work.
    // Case folds only on Windows; other filesystems are case-sensitive.
    let s = p.replace('/', "\\");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    let unc = s.starts_with("\\\\");
    let rooted = s.starts_with('\\') || s.as_bytes().get(1..3) == Some(b":\\");
    let mut parts: Vec<&str> = Vec::new();
    for part in s.split('\\').filter(|p| !p.is_empty() && *p != ".") {
        if part == ".." {
            let can_pop = parts.last().is_some_and(|p| *p != ".." && !p.ends_with(':')) && (!unc || parts.len() > 2);
            if can_pop { parts.pop(); } else if !rooted { parts.push(part); }
        } else { parts.push(part); }
    }
    let prefix = if unc { "\\\\" } else if s.starts_with('\\') { "\\" } else { "" };
    let mut out = format!("{prefix}{}", parts.join("\\"));
    if rooted && out.ends_with(':') { out.push('\\'); }
    out
}

/// Is `child` the same as or inside `parent` (case-insensitive on Windows)?
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

/// What changed from one folder list to another, matched by normalized path:
/// `{added: [{path, mode}], changed: [{path, from, to}], removed: [{path, mode}]}`.
#[logged]
pub fn dirs_diff(before: &[Value], after: &[Value]) -> Value {
    let key = |d: &Value| norm_path(d["path"].as_str().unwrap_or(""));
    let mode = |d: &Value| if d["mode"] == "ro" { "ro" } else { "rw" };
    let (mut added, mut changed, mut removed) = (Vec::new(), Vec::new(), Vec::new());
    for a in after {
        match before.iter().find(|b| key(*b) == key(a)) {
            None => added.push(json!({ "path": a["path"], "mode": mode(a) })),
            Some(b) if mode(b) != mode(a) => changed.push(json!({ "path": a["path"], "from": mode(b), "to": mode(a) })),
            Some(_) => {}
        }
    }
    for b in before {
        if !after.iter().any(|a| key(a) == key(b)) {
            removed.push(json!({ "path": b["path"], "mode": mode(b) }));
        }
    }
    json!({ "added": added, "changed": changed, "removed": removed })
}

/// Does a `dirs_diff` record any change?
#[logged]
pub fn dirs_changed(diff: &Value) -> bool {
    ["added", "changed", "removed"].iter().any(|k| diff[*k].as_array().is_some_and(|a| !a.is_empty()))
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
    json!({ "bash": both("bash"), "web": both("web"), "edit": both("edit"), "subagents": both("subagents"), "mcp": mcp,
        "orgtree": super::tool_groups::intersect(child, parent) })
}

/// The effective scope of a node whose configured scope is `child`, under a
/// parent whose EFFECTIVE scope is `parent`.
pub fn clamp(child: &Value, parent: &Value) -> Value {
    let child = normalize(child);
    let parent = normalize(parent);
    let mut out: Map<String, Value> = child.as_object().cloned().unwrap_or_default();
    // a stored value that is not one of the levels counts as unset: it never
    // reaches the CLI as given (3.x D-030)
    let level = |v: &Value, levels: &[&'static str], unset: &'static str| -> &'static str {
        v.as_str().and_then(|s| levels.iter().find(|l| **l == s).copied()).unwrap_or(unset)
    };
    let cpm = level(&child["permission_mode"], PM_LEVELS, "acceptEdits");
    let ppm = level(&parent["permission_mode"], PM_LEVELS, "bypassPermissions");
    out.insert("permission_mode".into(), json!(if pm_rank(cpm) <= pm_rank(ppm) { cpm } else { ppm }));
    let cv = level(&child["org_visibility"], VIS_LEVELS, "subtree");
    let pv = level(&parent["org_visibility"], VIS_LEVELS, "full");
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

/// `effective` plus the org's shared notes folder (`Config::org_notes_dir`),
/// as a launch runs with it and never stored: read-write when the seat may
/// write its own folder, else read-only. It replaces a stored grant of the
/// same folder and is marked, so the prompt names it apart from the folders
/// the agent was granted (user 2026-10-13 18:10Z).
#[logged]
pub fn with_org_notes(effective: &Value, dir: &str) -> Value {
    let mut out = effective.clone();
    let pm = out["permission_mode"].as_str().unwrap_or("acceptEdits");
    let may_write = out["tools"].get("edit").and_then(Value::as_bool).unwrap_or(true) && pm != "plan";
    let mut dirs = out["add_dirs"].as_array().cloned().unwrap_or_default();
    dirs.retain(|d| !d["path"].as_str().is_some_and(|p| norm_path(p) == norm_path(dir)));
    dirs.push(json!({ "path": dir, "mode": if may_write { "rw" } else { "ro" }, "org_notes": true }));
    out["add_dirs"] = Value::Array(dirs);
    out
}

/// Is this folder entry the org's shared notes folder (`with_org_notes`)?
#[logged]
pub fn is_org_notes(dir: &Value) -> bool {
    dir["org_notes"].as_bool() == Some(true)
}

/// Refuse a capability grant above the caller, rather than storing a dormant
/// privilege that could become effective after a move. Only supplied axes count.
#[logged]
pub fn require_grant(wanted: &Value, ceiling: &Value) -> anyhow::Result<()> {
    let normal = normalize(wanted);
    let bounded = clamp(&normal, ceiling);
    for key in ["add_dirs", "tools", "org_visibility", "permission_mode"] {
        if wanted.get(key).is_some() && normal[key] != bounded[key] {
            crate::refuse!(Forbidden, "{key} exceeds your own capability; nobody grants above themselves");
        }
    }
    Ok(())
}

/// Raise only explicitly granted axes, retaining unrelated existing grants.
#[logged]
pub fn raise(current: &Value, wanted: &Value) -> Value {
    let mut out = normalize(current);
    let want = normalize(wanted);
    if wanted.get("tools").is_some() {
        for k in ["bash", "web", "edit", "subagents"] {
            if want["tools"][k] == true { out["tools"][k] = json!(true); }
        }
        for g in super::tool_groups::GROUPS {
            if wanted["tools"]["orgtree"][*g] == true {
                out["tools"]["orgtree"][*g] = json!(true);
            }
        }
        let mut mcp = out["tools"]["mcp"].as_array().cloned().unwrap_or_default();
        for m in want["tools"]["mcp"].as_array().into_iter().flatten() {
            if !mcp.contains(m) { mcp.push(m.clone()); }
        }
        if mcp.contains(&json!("*")) { mcp = vec![json!("*")]; }
        out["tools"]["mcp"] = json!(mcp);
        out["tools"] = normalize_tools(&out["tools"]);
    }
    if wanted.get("add_dirs").is_some() {
        let mut dirs = out["add_dirs"].as_array().cloned().unwrap_or_default();
        for d in want["add_dirs"].as_array().into_iter().flatten() {
            let p = d["path"].as_str().unwrap_or("");
            let covered = dirs.iter().any(|x| path_within(p, x["path"].as_str().unwrap_or("")) && (d["mode"] == "ro" || x["mode"] == "rw"));
            if !covered {
                dirs.retain(|x| !(path_within(x["path"].as_str().unwrap_or(""), p) && (x["mode"] == "ro" || d["mode"] == "rw")));
                dirs.push(d.clone());
            }
        }
        out["add_dirs"] = json!(dirs);
    }
    if wanted.get("permission_mode").is_some() && pm_rank(want["permission_mode"].as_str().unwrap_or("")) > pm_rank(out["permission_mode"].as_str().unwrap_or("")) {
        out["permission_mode"] = want["permission_mode"].clone();
    }
    if wanted.get("org_visibility").is_some() && vis_rank(want["org_visibility"].as_str().unwrap_or("")) > vis_rank(out["org_visibility"].as_str().unwrap_or("")) {
        out["org_visibility"] = want["org_visibility"].clone();
    }
    out
}

/// Positive intent in a whole-list user edit. Unchanged dormant folders and
/// removals/downgrades are not new authorization to expand the org ceiling.
#[logged]
pub fn folder_additions(before: &Value, after: &Value) -> Vec<Value> {
    let old = before.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut added: Vec<Value> = Vec::new();
    for d in after.as_array().into_iter().flatten() {
        let key = norm_path(d["path"].as_str().unwrap_or(""));
        // Normalization retains historical aliases. Any equivalent RW row
        // already covers an unchanged RW intent, regardless of row order.
        if old.iter().any(|o| norm_path(o["path"].as_str().unwrap_or("")) == key
            && (o["mode"] == "rw" || d["mode"] == "ro")) {
            continue;
        }
        // Aggregate the newly supplied intent only, without rewriting stored
        // scope. A new mixed RO/RW list contributes one adequate RW grant.
        if let Some(existing) = added.iter_mut().find(|o| norm_path(o["path"].as_str().unwrap_or("")) == key) {
            if d["mode"] == "rw" { *existing = d.clone(); }
        } else { added.push(d.clone()); }
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_list_folder_intent_excludes_unchanged_latent_and_negative_edits() {
        let before = json!([{ "path": "E:\\latent", "mode": "rw" }, { "path": "E:\\upgrade", "mode": "ro" },
            { "path": "E:\\narrow", "mode": "rw" }, { "path": "E:\\remove", "mode": "rw" }]);
        let after = json!([{ "path": "E:/latent", "mode": "rw" }, { "path": "E:/upgrade", "mode": "rw" },
            { "path": "E:/narrow", "mode": "ro" }, { "path": "E:\\new-ro", "mode": "ro" }]);
        assert_eq!(folder_additions(&before, &after), json!([
            { "path": "E:/upgrade", "mode": "rw" }, { "path": "E:\\new-ro", "mode": "ro" }
        ]).as_array().unwrap().clone());
    }

    #[test]
    fn whole_list_folder_intent_aggregates_equivalent_modes_in_either_order() {
        let aliases = ["E:/latent/child/../.", "E:\\latent"];
        for modes in [["ro", "rw"], ["rw", "ro"]] {
            let before = json!([{ "path": aliases[0], "mode": modes[0] }, { "path": aliases[1], "mode": modes[1] }]);
            assert!(folder_additions(&before, &before).is_empty());
            let spelling = if cfg!(windows) { "e:/LATENT" } else { "E:/latent" };
            assert!(folder_additions(&before, &json!([{ "path": spelling, "mode": "rw" }])).is_empty());
        }
        let before = json!([{ "path": aliases[0], "mode": "ro" }, { "path": aliases[1], "mode": "ro" }]);
        let after = json!([{ "path": aliases[0], "mode": "ro" }, { "path": aliases[1], "mode": "rw" }]);
        assert_eq!(folder_additions(&before, &after), vec![after[1].clone()]);
        assert_eq!(folder_additions(&json!([]), &after), vec![after[1].clone()]);
    }

    #[test]
    fn group_denials_survive_normalization_and_parent_intersection() {
        let parent = json!({"tools":{"orgtree":{"team":false,"docket":false}}});
        let child = json!({"tools":{"orgtree":{"messaging":false}}});
        let effective = clamp(&child, &parent);
        assert_eq!(effective["tools"]["orgtree"]["team"], false);
        assert_eq!(effective["tools"]["orgtree"]["docket"], false);
        assert_eq!(effective["tools"]["orgtree"]["messaging"], false);
        assert_eq!(effective["tools"]["orgtree"]["watchdogs"], true);
        assert!(require_grant(&json!({"tools":{"orgtree":{"team":true}}}), &parent).is_err());
        let raised = raise(&effective, &json!({"tools":{"orgtree":{"messaging":true}}}));
        assert_eq!(raised["tools"]["orgtree"]["messaging"], true);
        assert_eq!(raised["tools"]["orgtree"]["team"], false);
    }

    #[test]
    fn org_notes_folder_joins_a_launch_scope_marked_with_the_seat_write_right() {
        let notes = "D:\\data\\scratch\\proof\\_shared";
        let stored = json!({ "permission_mode": "acceptEdits", "tools": { "edit": true },
            "add_dirs": [{ "path": "E:\\repo", "mode": "ro" }, { "path": "D:/data/scratch/proof/_shared/.", "mode": "ro" }] });
        let eff = with_org_notes(&stored, notes);
        // a stored grant of the same folder gives way; every other folder stays as it was
        assert_eq!(eff["add_dirs"], json!([{ "path": "E:\\repo", "mode": "ro" }, { "path": notes, "mode": "rw", "org_notes": true }]));
        assert!(is_org_notes(&eff["add_dirs"][1]) && !is_org_notes(&eff["add_dirs"][0]));
        assert_eq!(eff["permission_mode"], "acceptEdits");
        // a seat that may not write its own folder only reads the notes
        for seat in [json!({ "permission_mode": "plan" }), json!({ "tools": { "edit": false } })] {
            assert_eq!(with_org_notes(&seat, notes)["add_dirs"], json!([{ "path": notes, "mode": "ro", "org_notes": true }]));
        }
    }

    #[test]
    fn dirs_diff_matches_paths_and_reports_modes() {
        let before = vec![json!({ "path": "E:\\A", "mode": "rw" }), json!({ "path": "E:\\B", "mode": "rw" })];
        let after = vec![json!({ "path": "E:/B", "mode": "ro" }), json!({ "path": "E:\\C" })];
        let d = dirs_diff(&before, &after);
        assert_eq!(d["added"], json!([{ "path": "E:\\C", "mode": "rw" }]));
        assert_eq!(d["changed"], json!([{ "path": "E:/B", "from": "rw", "to": "ro" }]));
        assert_eq!(d["removed"], json!([{ "path": "E:\\A", "mode": "rw" }]));
        assert!(dirs_changed(&d));
        assert!(!dirs_changed(&dirs_diff(&before, &before)));
    }
}
