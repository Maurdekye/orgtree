//! One agent's subagents and background tasks, as its Claude CLI reports them
//! (parity P33 and P39; 3.x supervisor `bg_live`/`run_tasks` and
//! `background_notices.BackgroundNotices`).
//!
//! Two counts the desk shows (foreground `tasks`, background `bg_tasks`), and
//! the two events that must wake the agent because the CLI will not:
//! - a background task that ends without completing while the CLI lives
//!   (`task_notification` with a failed/stopped/cancelled/killed status);
//! - the CLI dying while background tasks are still live (orphans).
//!
//! Owned by the agent's actor; nothing here is shared or locked.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// A background task that ended without completing, to be reported once.
#[derive(Debug)]
pub struct Stopped {
    pub task_id: String,
    pub description: String,
    pub summary: String,
    pub output_file: Option<String>,
}

/// A background task still live when its CLI died.
#[derive(Debug, Clone)]
pub struct Orphan {
    pub task_id: String,
    pub description: String,
    pub output_file: Option<String>,
}

#[derive(Default, Debug)]
pub struct Tasks {
    /// Task/Agent tool calls of the current message still running (foreground)
    running: HashSet<String>,
    /// task id → description: the CLI's own live background set (snapshot)
    live: HashMap<String, String>,
    /// task id → last known description (never cleared within a process)
    desc: HashMap<String, String>,
    /// task id → its `.output` file, when the CLI named it
    out: HashMap<String, String>,
    /// task ids already reported, so a late duplicate never mails twice
    reported: HashSet<String>,
    // BackgroundNotices: which notifications are news to the agent
    background: HashSet<String>,
    task_tools: HashMap<String, String>,
    returned: HashSet<String>,
    consumed: HashSet<String>,
    reads: HashMap<String, String>,
    explicit_background: HashSet<String>,
}

#[logged]
impl Tasks {
    /// (foreground, background) counts for the runtime overlay.
    #[nolog]
    pub fn counts(&self) -> (usize, usize) {
        (self.running.len(), self.live.len())
    }

    /// Every Claude stream line passes here. Returns a stopped background task
    /// the agent must be told about, if this line reports one.
    #[nolog]
    pub fn observe(&mut self, v: &Value) -> Option<Stopped> {
        if v.get("parent_tool_use_id").map(|p| !p.is_null()).unwrap_or(false) {
            return None;
        }
        match v["type"].as_str() {
            Some("system") => self.on_system(v),
            Some("assistant") => {
                self.on_blocks(v, true);
                None
            }
            Some("user") => {
                self.on_blocks(v, false);
                None
            }
            Some("result") => {
                // a message boundary: no foreground subagent survives it
                self.running.clear();
                None
            }
            _ => None,
        }
    }

    #[nolog]
    fn on_system(&mut self, v: &Value) -> Option<Stopped> {
        let sub = v["subtype"].as_str().unwrap_or("");
        if !matches!(sub, "background_tasks_changed" | "task_started" | "task_notification") {
            return None;
        }
        // BackgroundNotices.observe
        let rows: Vec<&Value> = if sub == "background_tasks_changed" {
            v["tasks"].as_array().map(|a| a.iter().collect()).unwrap_or_default()
        } else {
            vec![v]
        };
        for row in rows {
            let tid = row["task_id"].as_str().unwrap_or("").to_string();
            let tool = row["tool_use_id"].as_str().unwrap_or("").to_string();
            if tid.is_empty() {
                continue;
            }
            if !tool.is_empty() {
                self.task_tools.insert(tid.clone(), tool.clone());
            }
            if sub == "background_tasks_changed"
                || row["is_background"].as_bool() == Some(true)
                || self.explicit_background.contains(&tool)
            {
                self.background.insert(tid.clone());
            }
            if sub == "task_notification" {
                let code = exit_code(row);
                if row["status"] == "completed" || (row["status"] == "failed" && code.map(|c| c >= 0).unwrap_or(false)) {
                    self.consumed.insert(tid.clone());
                }
            }
        }
        // the live-child ledger: only the snapshot sets the live set
        if sub == "background_tasks_changed" {
            if let Some(snap) = v["tasks"].as_array() {
                let mut fresh: HashMap<String, String> = HashMap::new();
                for t in snap {
                    let tid = t["task_id"].as_str().unwrap_or("");
                    if tid.is_empty() {
                        continue;
                    }
                    let mut d = t["description"].as_str().or(t["task_type"].as_str()).unwrap_or("subagent").to_string();
                    if matches!(d.as_str(), "subagent" | "local_agent") {
                        if let Some(old) = self.live.get(tid) {
                            d = old.clone();
                        }
                    }
                    fresh.insert(tid.to_string(), d);
                }
                for (tid, d) in &fresh {
                    self.desc.entry(tid.clone()).or_insert_with(|| d.clone());
                }
                self.live = fresh;
            }
            return None;
        }
        let tid = v["task_id"].as_str().unwrap_or("").to_string();
        if tid.is_empty() {
            return None;
        }
        if self.live.contains_key(&tid) {
            if let Some(d) = v["description"].as_str().filter(|d| !d.is_empty()) {
                self.live.insert(tid.clone(), d.to_string());
                self.desc.insert(tid.clone(), d.to_string());
            }
        }
        if let Some(f) = v["output_file"].as_str().filter(|f| !f.is_empty()) {
            self.out.insert(tid.clone(), f.to_string());
        }
        if self.should_report(v) && !self.reported.contains(&tid) {
            self.reported.insert(tid.clone());
            self.live.remove(&tid);
            return Some(Stopped {
                description: self.desc.get(&tid).cloned().unwrap_or_else(|| "background task".into()),
                summary: stop_summary(v),
                output_file: v["output_file"].as_str().filter(|f| !f.is_empty()).map(str::to_string),
                task_id: tid,
            });
        }
        None
    }

    /// Assistant tool calls and user tool results (top level only).
    #[nolog]
    fn on_blocks(&mut self, v: &Value, assistant: bool) {
        let Some(content) = v.pointer("/message/content").and_then(Value::as_array) else { return };
        for b in content {
            if assistant && b["type"] == "tool_use" {
                let tool = b["id"].as_str().unwrap_or("").to_string();
                let name = b["name"].as_str().unwrap_or("");
                if matches!(name, "Task" | "Agent") && !tool.is_empty() {
                    self.running.insert(tool.clone());
                }
                let args = &b["input"];
                if !args.is_object() {
                    continue;
                }
                if args["run_in_background"].as_bool() == Some(true) {
                    self.explicit_background.insert(tool.clone());
                }
                let tid = args["task_id"].as_str().unwrap_or("");
                if !tid.is_empty() && name == "TaskOutput" {
                    self.reads.insert(tool, tid.to_string());
                } else if !tid.is_empty() && name == "TaskStop" {
                    self.consumed.insert(tid.to_string());
                }
            } else if !assistant && b["type"] == "tool_result" {
                let tool = b["tool_use_id"].as_str().unwrap_or("").to_string();
                self.running.remove(&tool);
                let text = match &b["content"] {
                    Value::String(s) => s.clone(),
                    Value::Array(a) => a.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str())
                        .collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                let pending = text.contains("Command running in background with ID:")
                    || text.contains("Async agent launched successfully")
                    || text.contains("<retrieval_status>timeout</retrieval_status>")
                    || text.contains("<status>running</status>");
                if !pending {
                    if let Some(tid) = self.reads.get(&tool).cloned() {
                        if !b["is_error"].as_bool().unwrap_or(false) {
                            self.consumed.insert(tid);
                        }
                    }
                    self.returned.insert(tool);
                }
            }
        }
    }

    /// A failed/stopped notification for a background task the agent has not
    /// already received the result of.
    #[nolog]
    fn should_report(&self, v: &Value) -> bool {
        let tid = v["task_id"].as_str().unwrap_or("");
        let tool = v["tool_use_id"].as_str().map(str::to_string)
            .or_else(|| self.task_tools.get(tid).cloned()).unwrap_or_default();
        v["subtype"] == "task_notification"
            && matches!(v["status"].as_str(), Some("failed" | "stopped" | "cancelled" | "killed"))
            && self.background.contains(tid)
            && !self.consumed.contains(tid)
            && (tool.is_empty() || !self.returned.contains(&tool))
    }

    /// The CLI died: every still-live background task is orphaned. Clears the
    /// process's state (a new CLI starts with none).
    pub fn orphaned(&mut self) -> Vec<Orphan> {
        let mut orphans: Vec<Orphan> = self.live.drain()
            .map(|(tid, d)| Orphan { output_file: self.out.get(&tid).cloned(), description: d, task_id: tid })
            .collect();
        orphans.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        *self = Tasks::default();
        orphans
    }
}

/// The exit code a task notification reports, if any (never invented).
#[logged]
fn exit_code(v: &Value) -> Option<i64> {
    if let Some(c) = v["exit_code"].as_i64() {
        return Some(c);
    }
    let summary = v["summary"].as_str().unwrap_or("").to_lowercase();
    let at = summary.find("exit")?;
    let rest = &summary[at + 4..];
    let rest = rest.trim_start_matches(|c: char| c == ' ' || c == '-' || c == ':' || c == '=');
    let rest = rest.strip_prefix("code").unwrap_or(rest);
    let rest = rest.trim_start_matches(|c: char| c == ' ' || c == ':' || c == '=');
    let digits: String = rest.chars().enumerate()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && *c == '-'))
        .map(|(_, c)| c).collect();
    digits.parse().ok()
}

/// "status: …; exit code: …; summary", keeping a zero exit code.
#[logged]
fn stop_summary(v: &Value) -> String {
    let summary = v["summary"].as_str().unwrap_or("");
    let code = exit_code(v).map(|c| c.to_string()).unwrap_or_else(|| "unavailable (not reported by CLI)".into());
    let status = v["status"].as_str().unwrap_or("");
    if summary.is_empty() {
        format!("status: {status}; exit code: {code}")
    } else {
        format!("status: {status}; exit code: {code}; {summary}")
    }
}

/// The Claude CLI's own `.output` file for a background task of `session`
/// (`<temp>/claude/*/<session>/tasks/<task>.output`), when it exists and is
/// non-empty. Blocking: call it on the blocking pool.
#[logged]
pub fn task_output(session: &str, task_id: &str) -> Option<String> {
    if session.is_empty() || task_id.is_empty() || session.contains(['/', '\\']) || task_id.contains(['/', '\\']) {
        return None;
    }
    let root = std::env::temp_dir().join("claude");
    let file = format!("{task_id}.output");
    for entry in std::fs::read_dir(&root).ok()?.flatten().take(512) {
        let p: PathBuf = entry.path().join(session).join("tasks").join(&file);
        if non_empty(&p) {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

#[logged]
fn non_empty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

/// Orphan rows for the `runtime.subagent_died` card, with output files
/// looked up for the first 20. Blocking: call it on the blocking pool.
#[logged]
pub fn orphan_rows(session: Option<&str>, orphans: &[Orphan]) -> Vec<Value> {
    orphans.iter().enumerate().map(|(i, o)| {
        let out = o.output_file.clone()
            .or_else(|| if i < 20 { session.and_then(|s| task_output(s, &o.task_id)) } else { None });
        json!({ "id": o.task_id, "description": o.description, "output_file": out })
    }).collect()
}
