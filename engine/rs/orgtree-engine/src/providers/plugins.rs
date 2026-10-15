//! Read-only installed Claude plugin inventory, shared by skills and MCP.
//! Never enumerate marketplaces/cache: only recorded, applicable installs count.
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Plugin {
    pub root: PathBuf,
    pub manifest: Value,
}

#[nolog]
pub fn json(path: &Path) -> Option<Value> {
    if std::fs::metadata(path).ok()?.len() > 4 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[nolog]
pub fn installed(home: &Path, folders: &[PathBuf]) -> Vec<Plugin> {
    let Some(registry) = json(&home.join(".claude/plugins/installed_plugins.json")) else {
        return Vec::new();
    };
    let Some(plugins) = registry["plugins"].as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for rows in plugins.values().filter_map(Value::as_array) {
        for row in rows {
            let applicable = match row["scope"].as_str() {
                Some("user" | "managed") => true,
                Some("project" | "local") => row["projectPath"].as_str().is_some_and(|project| {
                    let Ok(project) = std::fs::canonicalize(project) else {
                        return false;
                    };
                    folders
                        .iter()
                        .any(|p| std::fs::canonicalize(p).is_ok_and(|p| p.starts_with(&project)))
                }),
                _ => false,
            };
            if !applicable {
                continue;
            }
            let Some(root) = row["installPath"]
                .as_str()
                .and_then(|p| std::fs::canonicalize(p).ok())
            else {
                continue;
            };
            if crate::rig::active()
                && !std::fs::canonicalize(home).is_ok_and(|h| root.starts_with(h))
            {
                continue;
            }
            if out.iter().any(|p: &Plugin| p.root == root) {
                continue;
            }
            let Some(manifest) = json(&root.join(".claude-plugin/plugin.json")) else {
                continue;
            };
            out.push(Plugin { root, manifest });
        }
    }
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}

/// A manifest path may only reference its own installed package.
#[nolog]
pub fn within(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = relative.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy());
    let path = std::fs::canonicalize(root.join(relative)).ok()?;
    path.starts_with(root).then_some(path)
}

#[nolog]
pub fn expand_root(value: &mut Value, root: &Path) {
    match value {
        Value::String(s) => *s = s.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy()),
        Value::Array(a) => a.iter_mut().for_each(|v| expand_root(v, root)),
        Value::Object(m) => m.values_mut().for_each(|v| expand_root(v, root)),
        _ => {}
    }
}

#[nolog]
pub fn mcp(plugin: &Plugin) -> Vec<(String, Value)> {
    let mut docs = Vec::new();
    if let Some(doc) = within(&plugin.root, ".mcp.json").and_then(|p| json(&p)) {
        docs.push(doc);
    }
    let declared = &plugin.manifest["mcpServers"];
    match declared {
        Value::Object(_) => docs.push(serde_json::json!({"mcpServers":declared})),
        Value::String(file) => {
            if let Some(doc) = within(&plugin.root, file).and_then(|p| json(&p)) {
                docs.push(doc);
            }
        }
        Value::Array(files) => {
            for file in files.iter().filter_map(Value::as_str) {
                if let Some(doc) = within(&plugin.root, file).and_then(|p| json(&p)) {
                    docs.push(doc);
                }
            }
        }
        _ => {}
    }
    let mut entries = Vec::new();
    for mut doc in docs {
        expand_root(&mut doc, &plugin.root);
        if let Some(m) = doc.get("mcpServers").unwrap_or(&doc).as_object() {
            entries.extend(m.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
    entries
}
