//! Approval policy for direct OpenCode tools. Paths are canonicalized through
//! their nearest existing ancestor, including junctions/symlinks. Shell is an
//! explicit capability, not path containment. Bypass is unrestricted by the
//! user's ruling; all approvals are still once-only. Code Mode is denied in
//! other modes because ACP does not expose every nested permission faithfully.

use std::path::{Component, Path, PathBuf};
use anyhow::{anyhow, Result};
use serde_json::Value;

#[derive(Clone)]
pub struct Policy {
    pub cwd: PathBuf,
    pub read: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
    pub may_write: bool,
    pub may_shell: bool,
    pub may_web: bool,
    pub bypass: bool,
    /// Exact direct tool names discovered from granted MCP servers. Do not
    /// authorize an arbitrary prefix supplied in the harness's request.
    pub mcp_tools: Vec<String>,
    /// Reserved aliases derived by the launcher from explicitly granted servers.
    /// A grant is to the whole external MCP server, not an argument interpreter.
    pub mcp_prefixes: Vec<String>,
}

#[nolog]
impl Policy {
    pub fn answer(&self, method: &str, params: &Value) -> Result<Value> {
        if method != "session/request_permission" { return Err(anyhow!("unsupported ACP client method")); }
        Ok(super::acp::permission_result(params, self.allowed(&params["toolCall"])))
    }

    pub fn allowed(&self, tool: &Value) -> bool {
        // Bypass is the user's explicit unrestricted policy, including Code
        // Mode's own fetch and nested tools. It is not a scope sandbox.
        if self.bypass { return true; }
        let Some(name) = tool["name"].as_str() else { return false; };
        if name == "execute" { return false; }
        if self.mcp_tools.iter().any(|n| n == name) { return true; }
        if self.mcp_prefixes.iter().any(|p| name.starts_with(p) && name.len() > p.len()) { return true; }
        match name {
            "shell" => self.may_shell,
            "read" | "glob" | "grep" => self.paths(tool, false),
            "write" | "edit" | "patch" => self.may_write && self.paths(tool, true),
            "webfetch" | "websearch" => self.may_web,
            // Includes external_directory, new built-ins, subagents, skills
            // and configuration/session mutation. Missing detail fails closed.
            _ => false,
        }
    }

    fn paths(&self, tool: &Value, write: bool) -> bool {
        let roots = if write { &self.write } else { &self.read };
        let Some(locations) = tool["locations"].as_array().filter(|x| !x.is_empty()) else { return false; };
        if locations.len() > 256 { return false; }
        // Also check every raw path and diff path, not just the display row.
        let mut paths: Vec<&str> = Vec::new();
        for location in locations {
            let Some(path) = location["path"].as_str() else { return false; };
            paths.push(path);
        }
        for field in ["path", "filePath", "file_path", "filepath", "movePath"] {
            if let Some(path) = tool["rawInput"].get(field) {
                let Some(path) = path.as_str() else { return false; };
                paths.push(path);
            }
        }
        if let Some(contents) = tool["content"].as_array() {
            for content in contents.iter().filter(|c| c["type"] == "diff") {
                let Some(path) = content["path"].as_str() else { return false; };
                paths.push(path);
            }
        }
        paths.into_iter().all(|path| within(path, &self.cwd, roots))
    }
}

#[nolog]
fn resolved(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) { return None; }
    // Resolve an existing ancestor before appending nonexistent components.
    // Never authorize by a lexical prefix before following a junction.
    let mut parent = path;
    let mut suffix = Vec::new();
    loop {
        match std::fs::symlink_metadata(parent) {
            Ok(_) => break, // A broken symlink must fail canonicalization.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(parent.file_name()?.to_owned());
                parent = parent.parent()?;
            }
            Err(_) => return None,
        }
    }
    let mut canonical = std::fs::canonicalize(parent).ok()?;
    for part in suffix.into_iter().rev() { canonical.push(part); }
    Some(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(root: &Path, bypass: bool) -> Policy {
        Policy { cwd: root.to_owned(), read: vec![root.to_owned()], write: vec![root.to_owned()],
            may_write: true, may_shell: false, may_web: false, bypass, mcp_tools: vec!["orgtree_orgtree_status".into()],
            mcp_prefixes: vec!["orgtree_ext_deadbeef_".into()] }
    }

    #[test]
    fn acp_execute_is_denied_except_explicit_bypass_and_never_persistent() {
        let root = std::env::temp_dir();
        let request = json!({"toolCall":{"name":"execute","rawInput":{"code":"await fetch('https://example.test'); await tools.shell({command:'anything'})"}},
            "options":[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"},
            {"kind":"reject_once","optionId":"reject"}]});
        let restricted = policy(&root, false);
        assert_eq!(restricted.answer("session/request_permission", &request).unwrap()["outcome"]["optionId"], "reject");
        assert_eq!(policy(&root, true).answer("session/request_permission", &request).unwrap()["outcome"]["optionId"], "once");
        let only_always = json!({"toolCall":{"name":"execute"},"options":[{"kind":"allow_always","optionId":"always"}]});
        assert_eq!(policy(&root, true).answer("session/request_permission", &only_always).unwrap()["outcome"]["outcome"], "cancelled");
        assert!(restricted.answer("fs/write_text_file", &request).is_err());
    }

    #[test]
    fn acp_native_paths_check_all_locations_and_read_only_roots() {
        let dir = std::env::temp_dir().join(format!("acp-scope-{}", uuid::Uuid::new_v4()));
        let write = dir.join("write");
        let read = dir.join("read");
        std::fs::create_dir_all(&write).unwrap(); std::fs::create_dir(&read).unwrap();
        let mut p = policy(&write, false); p.read.push(read.clone());
        let tool = |name: &str, path: PathBuf| json!({"name":name,"locations":[{"path":path}],"rawInput":{"path":path}});
        assert!(p.allowed(&tool("write", write.join("new.txt"))));
        assert!(p.allowed(&tool("read", read.join("readme.txt"))));
        assert!(!p.allowed(&tool("write", read.join("readme.txt"))));
        assert!(!p.allowed(&tool("read", dir.join("outside.txt"))));
        assert!(!p.allowed(&tool("read", write.join("..").join("outside.txt"))));
        let mut mixed = tool("write", write.join("new.txt"));
        mixed["rawInput"]["path"] = json!(read.join("other.txt"));
        assert!(!p.allowed(&mixed));
        assert!(!p.allowed(&json!({"name":"write","rawInput":{"path":write.join("new.txt")}})));
        assert!(!p.allowed(&json!({"name":"subagent"})));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn acp_shell_capability_and_exact_mcp_names() {
        let mut p = policy(&std::env::temp_dir(), false);
        assert!(!p.allowed(&json!({"name":"shell"})));
        p.may_shell = true;
        assert!(p.allowed(&json!({"name":"shell","rawInput":{"command":"arbitrary command"}})));
        assert!(p.allowed(&json!({"name":"orgtree_orgtree_status"})));
        assert!(!p.allowed(&json!({"name":"orgtree_ungranted_tool"})));
        assert!(p.allowed(&json!({"name":"orgtree_ext_deadbeef_echo"})));
        assert!(!p.allowed(&json!({"name":"orgtree_ext_other_echo"})));
        assert!(!p.allowed(&json!({"name":"webfetch"})));
    }
}

#[nolog]
fn within(path: &str, cwd: &Path, roots: &[PathBuf]) -> bool {
    if path.is_empty() || path.contains('\0') { return false; }
    #[cfg(windows)]
    {
        // Refuse alternate data streams and device namespace aliases.
        let clean = path.strip_prefix(r"\\?\").unwrap_or(path);
        if clean.starts_with(r"\\.\") || clean.get(2..).is_some_and(|s| s.contains(':')) { return false; }
    }
    let path = Path::new(path);
    let joined = if path.is_absolute() { path.to_owned() } else { cwd.join(path) };
    let Some(target) = resolved(&joined) else { return false; };
    roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).any(|root| {
        #[cfg(windows)]
        { Path::new(&target.to_string_lossy().to_lowercase()).starts_with(root.to_string_lossy().to_lowercase()) }
        #[cfg(not(windows))]
        { target.starts_with(root) }
    })
}
