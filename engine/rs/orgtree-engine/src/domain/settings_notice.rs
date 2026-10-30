//! What a settings change did, for its change notice (`access.scope_changed`):
//! folders, tools, settings and instruction diffs read from the stored before
//! and after, never from the request (USER 2026-10-30 mc5d2672d3cc9 "should
//! show inline what exactly chsnged", meeff02af965d; @coordinator-opus
//! macb41248ab05). Only the keys named here can enter an event.
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use super::{scope, tool_groups};
use tokio_postgres::Transaction;

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

/// The settings the scope itself stores; effort, account and harness come
/// from their callers (`add_value`).
const SCOPE_VALUES: &[&str] = &["org_visibility", "permission_mode", "fast_mode", "model_version", "account_fallback",
    "session", "peer_mail", "auto_cheap_compact"];
/// Lines of context around a change, and the cap an Edit tool call's diff
/// has too (runtime/actor.rs `patch_of`).
const CONTEXT: usize = 3;
const MAX_LINES: usize = 200;
/// Past this many cells a change is drawn as a whole replacement.
const MAX_CELLS: usize = 4_000_000;

/// What a tools object grants: the four native tools, `orgtree_disabled`,
/// `mcp:<server>` and `orgtree:<group>` (`logo` is the old name of `orgmod`).
#[nolog]
fn tool_names(t: &Value) -> BTreeSet<String> {
    let t = scope::normalize_tools(t);
    let mut out = BTreeSet::new();
    for k in ["bash", "web", "edit", "subagents", "orgtree_disabled"] {
        if t[k] == true { out.insert(k.to_string()); }
    }
    for m in t["mcp"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        out.insert(format!("mcp:{m}"));
    }
    for g in tool_groups::GROUPS.iter().filter(|g| **g != "logo") {
        if tool_groups::enabled(&t, g) { out.insert(format!("orgtree:{g}")); }
    }
    out
}

/// A side that is only a scope (an ancestor raised, a descendant clamped).
#[nolog]
pub fn scope_only(scope: &Value) -> Side<'_> {
    Side { scope, charter: None, team_charter: None }
}

/// The tools one scope grants that the other does not: `{added, removed}`.
#[logged]
pub fn tools_diff(before: &Value, after: &Value) -> Value {
    let (b, a) = (tool_names(before), tool_names(after));
    json!({ "added": a.difference(&b).collect::<Vec<_>>(), "removed": b.difference(&a).collect::<Vec<_>>() })
}

/// The longest-common-subsequence edit script: (' ', line) kept, ('-', line)
/// only before, ('+', line) only after.
#[nolog]
fn edit_script<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(char, &'a str)> {
    let (n, m) = (a.len(), b.len());
    let mut pre = 0;
    while pre < n && pre < m && a[pre] == b[pre] { pre += 1; }
    let mut suf = 0;
    while suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf] { suf += 1; }
    let (x, y) = (&a[pre..n - suf], &b[pre..m - suf]);
    let mut out: Vec<(char, &str)> = a[..pre].iter().map(|l| (' ', *l)).collect();
    let (p, q) = (x.len(), y.len());
    if p.saturating_mul(q) > MAX_CELLS {
        out.extend(x.iter().map(|l| ('-', *l)));
        out.extend(y.iter().map(|l| ('+', *l)));
    } else {
        let w = q + 1;
        let mut t = vec![0u32; (p + 1) * w];
        for i in (0..p).rev() {
            for j in (0..q).rev() {
                t[i * w + j] = if x[i] == y[j] { t[(i + 1) * w + j + 1] + 1 } else { t[(i + 1) * w + j].max(t[i * w + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < p && j < q {
            if x[i] == y[j] { out.push((' ', x[i])); i += 1; j += 1; }
            else if t[(i + 1) * w + j] >= t[i * w + j + 1] { out.push(('-', x[i])); i += 1; }
            else { out.push(('+', y[j])); j += 1; }
        }
        out.extend(x[i..].iter().map(|l| ('-', *l)));
        out.extend(y[j..].iter().map(|l| ('+', *l)));
    }
    out.extend(a[n - suf..].iter().map(|l| (' ', *l)));
    out
}

/// A line diff in the tool-call diff's shape `{plus, minus, lines,
/// truncated?}`, or None when the texts are the same.
#[logged]
pub fn text_diff(before: &str, after: &str) -> Option<Value> {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    if a == b { return None; }
    let ops = edit_script(&a, &b);
    // where each op sits in the old and the new text
    let (mut olds, mut news) = (Vec::with_capacity(ops.len()), Vec::with_capacity(ops.len()));
    let (mut o, mut n) = (0usize, 0usize);
    for (c, _) in &ops {
        olds.push(o);
        news.push(n);
        if *c != '+' { o += 1; }
        if *c != '-' { n += 1; }
    }
    let mut hunks: Vec<(usize, usize)> = Vec::new();
    for (i, _) in ops.iter().enumerate().filter(|(_, (c, _))| *c != ' ') {
        let (s, e) = (i.saturating_sub(CONTEXT), (i + 1 + CONTEXT).min(ops.len()));
        match hunks.last_mut() {
            Some(h) if s <= h.1 => h.1 = h.1.max(e),
            _ => hunks.push((s, e)),
        }
    }
    let (mut plus, mut minus, mut lines, mut truncated) = (0, 0, Vec::new(), false);
    let mut keep = |line: String, lines: &mut Vec<Value>| {
        if lines.len() < MAX_LINES { lines.push(json!(line)) } else { truncated = true }
    };
    for (s, e) in hunks {
        let span = &ops[s..e];
        let ol = span.iter().filter(|(c, _)| *c != '+').count();
        let nl = span.iter().filter(|(c, _)| *c != '-').count();
        // an empty side names the line before it, as `diff -u` does
        let start = |at: usize, len: usize| if len == 0 { at } else { at + 1 };
        keep(format!("@@ -{},{ol} +{},{nl} @@", start(olds[s], ol), start(news[s], nl)), &mut lines);
        for (c, l) in span {
            if *c == '+' { plus += 1; } else if *c == '-' { minus += 1; }
            keep(format!("{c}{l}"), &mut lines);
        }
    }
    let mut d = json!({ "plus": plus, "minus": minus, "lines": lines });
    if truncated { d["truncated"] = json!(true); }
    Some(d)
}

/// A stored setting as the notice shows it: on/off, a level, a list, or
/// None for the default.
#[nolog]
pub fn shown(key: &str, v: Option<&Value>) -> Option<String> {
    match (key, v?) {
        (_, Value::Null) => None,
        ("auto_cheap_compact", Value::Object(o)) if o.is_empty() => None,
        ("auto_cheap_compact", o) => Some(match o["enabled"].as_bool() {
            Some(false) => "off".into(),
            _ => format!("on at {}%", (o["occ"].as_f64().unwrap_or(0.25) * 100.0).round() as i64),
        }),
        (_, Value::Bool(b)) => Some(if *b { "on" } else { "off" }.into()),
        (_, Value::String(s)) => Some(s.clone()).filter(|s| !s.is_empty()),
        (_, Value::Array(a)) => Some(a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).filter(|s| !s.is_empty()),
        (_, other) => Some(other.to_string()),
    }
}

/// Every part that differs between the two sides.
#[logged]
pub fn parts(before: Side<'_>, after: Side<'_>) -> Map<String, Value> {
    let (b, a) = (scope::normalize(before.scope), scope::normalize(after.scope));
    let mut out = Map::new();
    let dirs = |s: &Value| s["add_dirs"].as_array().cloned().unwrap_or_default();
    let folders = scope::dirs_diff(&dirs(&b), &dirs(&a));
    if scope::dirs_changed(&folders) { out.insert("folders".into(), folders); }
    let tools = tools_diff(&b["tools"], &a["tools"]);
    if ["added", "removed"].iter().any(|k| tools[*k].as_array().is_some_and(|l| !l.is_empty())) {
        out.insert("tools".into(), tools);
    }
    for key in SCOPE_VALUES {
        add_value(&mut out, key, shown(key, b.get(*key)).as_deref(), shown(key, a.get(*key)).as_deref());
    }
    for (key, x, y) in [("charter", before.charter, after.charter), ("team_charter", before.team_charter, after.team_charter)] {
        if let Some(d) = text_diff(x.unwrap_or(""), y.unwrap_or("")) { out.insert(key.into(), d); }
    }
    out
}

/// Add a setting the scope does not hold (effort, account, harness): kept in
/// `VALUE_KEYS` order, and nothing when it did not change.
#[nolog]
pub fn add_value(parts: &mut Map<String, Value>, key: &str, from: Option<&str>, to: Option<&str>) {
    let (from, to) = (from.filter(|s| !s.is_empty()), to.filter(|s| !s.is_empty()));
    if from == to || !VALUE_KEYS.contains(&key) { return; }
    let list = parts.entry("values").or_insert_with(|| json!([]));
    let Some(list) = list.as_array_mut() else { return };
    list.retain(|v| v["key"] != key);
    list.push(json!({ "key": key, "from": from, "to": to }));
    list.sort_by_key(|v| VALUE_KEYS.iter().position(|k| v["key"] == *k).unwrap_or(usize::MAX));
}

/// An account change's parts; `pending` is queued, cancelled or dropped
/// (with its reason) for a change that waits on the current turn.
#[logged]
pub fn account_parts(from: Option<&str>, to: Option<&str>, pending: Option<&str>, reason: Option<&str>) -> Map<String, Value> {
    // `primary`, `default` and `<provider>/primary` all mean the provider's own login
    let login = |a: Option<&str>| match crate::accounts::choice(a) {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
    let (from, to) = (login(from), login(to));
    let mut out = Map::new();
    add_value(&mut out, "account", from.as_deref(), to.as_deref());
    if out.is_empty() { return out; }
    if let Some(p) = pending { out.insert("pending".into(), json!(p)); }
    if let Some(r) = reason { out.insert("reason".into(), json!(r)); }
    out
}

/// The categories a notice's `changed` lists for these parts.
#[logged]
pub fn changed(parts: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = ["folders", "tools"].iter().filter(|k| parts.contains_key(**k)).map(|k| k.to_string()).collect();
    out.extend(parts.get("values").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v["key"].as_str().map(str::to_string)));
    out.extend(["charter", "team_charter"].iter().filter(|k| parts.contains_key(**k)).map(|k| k.to_string()));
    out
}

/// The agent's one line for an `access.scope_changed` event's parts, in the
/// tools' own words (`rw`, `org_visibility`, `mcp:github`).
#[logged]
pub fn agent_line(ev: &Value) -> String {
    let str_of = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut out: Vec<String> = Vec::new();
    let f = &ev["folders"];
    let list = |k: &str| f[k].as_array().cloned().unwrap_or_default();
    let mut folders: Vec<String> = list("added").iter().map(|d| format!("+ {} ({})", str_of(&d["path"]), str_of(&d["mode"]))).collect();
    folders.extend(list("removed").iter().map(|d| format!("− {}", str_of(&d["path"]))));
    folders.extend(list("changed").iter().map(|d| format!("{} {} → {}", str_of(&d["path"]), str_of(&d["from"]), str_of(&d["to"]))));
    if !folders.is_empty() { out.push(format!("folders {}", folders.join(", "))); }
    let t = &ev["tools"];
    let mut tools: Vec<String> = t["added"].as_array().into_iter().flatten().map(|x| format!("+ {}", str_of(x))).collect();
    tools.extend(t["removed"].as_array().into_iter().flatten().map(|x| format!("− {}", str_of(x))));
    if !tools.is_empty() { out.push(format!("tools {}", tools.join(", "))); }
    let or_default = |v: &Value| v.as_str().map(str::to_string).unwrap_or_else(|| "default".into());
    for v in ev["values"].as_array().into_iter().flatten() {
        let (key, from, to) = (str_of(&v["key"]), or_default(&v["from"]), or_default(&v["to"]));
        out.push(match (key.as_str(), ev["pending"].as_str()) {
            ("account", Some("queued")) => format!("account {from} → {to} when your current turn ends"),
            ("account", Some("cancelled")) => format!("queued account change to {to} cancelled; you stay on {from}"),
            ("account", Some("dropped")) => format!("queued account change to {to} dropped ({}); you stay on {from}", str_of(&ev["reason"])),
            _ => format!("{key} {from} → {to}"),
        });
    }
    for key in ["charter", "team_charter"] {
        let d = &ev[key];
        if d.is_object() {
            out.push(format!("{key} edited (+{} −{} lines)", d["plus"].as_i64().unwrap_or(0), d["minus"].as_i64().unwrap_or(0)));
        }
    }
    out.join("; ")
}

/// The effective scope over `parent` (the org's ceiling at the top): every
/// agent ancestor's configured scope clamped in turn, root first, as
/// `ops::capability` reads it, but without its row locks.
#[logged]
pub(crate) async fn ceiling_of(tx: &Transaction<'_>, parent: Option<i64>, settings: &Value) -> anyhow::Result<Value> {
    let mut sc = scope::org_ceiling(&settings["dirs"]);
    let Some(p) = parent else { return Ok(sc) };
    let rows = tx.query(
        "WITH RECURSIVE up(id, depth) AS (SELECT $1::bigint, 0 UNION ALL
           SELECT a.parent_id, u.depth + 1 FROM ot.agents a JOIN up u ON a.id = u.id WHERE a.parent_id IS NOT NULL AND u.depth < 1024)
         SELECT a.scope, a.kind FROM up u JOIN ot.agents a ON a.id = u.id ORDER BY u.depth DESC", &[&p]).await?;
    for r in rows {
        if r.get::<_, String>(1) != crate::domain::projects::KIND { sc = scope::clamp(&r.get::<_, Value>(0), &sc); }
    }
    Ok(sc)
}

/// `root` (configured as `root_scope`) and every live node below it, each
/// with whether it is an agent and its effective scope under `ceiling`.
#[logged]
pub(crate) async fn effective_below(tx: &Transaction<'_>, root: i64, root_scope: &Value, ceiling: &Value)
    -> anyhow::Result<Vec<(i64, bool, Value)>> {
    let rows = tx.query(
        "WITH RECURSIVE down(id, depth) AS (SELECT $1::bigint, 0 UNION ALL
           SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id WHERE a.state = 'live' AND d.depth < 1024)
         SELECT a.id, a.parent_id, a.scope, a.kind FROM down d JOIN ot.agents a ON a.id = d.id ORDER BY d.depth, a.id", &[&root]).await?;
    let mut eff: std::collections::HashMap<i64, Value> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for r in rows {
        let id: i64 = r.get(0);
        let (configured, over) = if id == root { (root_scope.clone(), ceiling.clone()) } else {
            match r.get::<_, Option<i64>>(1).and_then(|p| eff.get(&p)) { Some(v) => (r.get(2), v.clone()), None => continue }
        };
        let effective = scope::clamp(&configured, &over);
        out.push((id, r.get::<_, String>(3) != crate::domain::projects::KIND, effective.clone()));
        eff.insert(id, effective);
    }
    Ok(out)
}

/// Tell every live agent below `root` what `root`'s change did to it: its
/// effective scope before and after (a narrowing it lost, a grant it regained),
/// and `root`'s new team instructions when they changed, as one notice each
/// that follows `root_name`'s change. Nothing when nothing changed for it.
#[logged]
pub(crate) async fn notify_below(tx: &Transaction<'_>, org: i64, by: &str, root: i64, root_name: &str,
    before: &[(i64, bool, Value)], after: &[(i64, bool, Value)], team: Option<&Value>) -> anyhow::Result<Vec<i64>> {
    let mut ids = Vec::new();
    for (id, _, now) in after.iter().filter(|(id, agent, _)| *id != root && *agent) {
        let Some((_, _, was)) = before.iter().find(|(x, _, _)| x == id) else { continue };
        let mut p = parts(scope_only(was), scope_only(now));
        if let Some(d) = team { p.insert("team_charter".into(), d.clone()); }
        ids.extend(super::lifecycle::record(tx, org, "retool", by, Some(*id), &json!({ "notice": p, "cascade_for": root_name })).await?);
    }
    Ok(ids)
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
