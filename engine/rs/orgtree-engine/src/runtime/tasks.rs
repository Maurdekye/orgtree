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

    /// The task ran in the background (the CLI listed it as such, or its
    /// call asked for it), not a foreground call the CLI also numbers.
    #[nolog]
    pub fn is_background(&self, task_id: &str) -> bool {
        self.background.contains(task_id)
    }

    /// The tool call asked to run in the background (`run_in_background`).
    #[nolog]
    pub fn asked_background(&self, tool_use_id: &str) -> bool {
        self.explicit_background.contains(tool_use_id)
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

/// The exit code a task notification reports, read for the agent's wake
/// note: its `exit_code`, else the last "exit code N" its summary names
/// (Claude Code 2.1.292: `… completed (exit code 0)`, `… failed with exit
/// code 3`; the summary quotes the command, which may say "exit" itself),
/// else what `exit_code` finds. Never invented.
#[logged]
pub fn reported_exit_code(v: &Value) -> Option<i64> {
    if let Some(c) = v["exit_code"].as_i64() {
        return Some(c);
    }
    let summary = v["summary"].as_str().unwrap_or("").to_lowercase();
    if let Some(at) = summary.rfind("exit code") {
        let digits: String = summary[at + "exit code".len()..].trim_start().chars().enumerate()
            .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && *c == '-'))
            .map(|(_, c)| c).collect();
        if let Ok(c) = digits.parse() {
            return Some(c);
        }
    }
    exit_code(v)
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

/// What a background command printed, from the `.output` file its
/// notification names (Claude Code 2.1.292 hands the model only the file's
/// path, never the output): at most `COMMAND_OUTPUT_MAX` bytes, and whether
/// there was more. Only a `<task>.output` file inside the CLI's own folder in
/// the temp directory is read. Blocking: call it on the blocking pool.
#[nolog] // returns the command's output
pub fn command_output(file: &str, task_id: &str) -> Option<(String, bool)> {
    output_under(&std::env::temp_dir().join("claude"), file, task_id)
}

/// `command_output` with the CLI's folder given.
#[nolog] // returns the command's output
fn output_under(folder: &Path, file: &str, task_id: &str) -> Option<(String, bool)> {
    use std::io::Read;
    if task_id.is_empty() || Path::new(file).file_name()?.to_str()? != format!("{task_id}.output") {
        return None;
    }
    let root = std::fs::canonicalize(folder).ok()?;
    let real = std::fs::canonicalize(file).ok()?;
    if !real.starts_with(&root) {
        tracing::warn!(task = task_id, "a background task's output file is outside the CLI's folder; not read");
        return None;
    }
    let mut buf = Vec::new();
    std::fs::File::open(&real).ok()?.take(COMMAND_OUTPUT_MAX + 1).read_to_end(&mut buf).ok()?;
    let more = buf.len() as u64 > COMMAND_OUTPUT_MAX;
    buf.truncate(COMMAND_OUTPUT_MAX as usize);
    tracing::info!(task = task_id, bytes = buf.len(), more, "read a background command's output");
    Some((String::from_utf8_lossy(&buf).into_owned(), more))
}

/// The most of a background command's output read for its chip (the most a
/// failed shell call keeps for reading on demand, `convo::retain_failed_shell_output`).
pub const COMMAND_OUTPUT_MAX: u64 = 1024 * 1024;

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

#[cfg(test)]
mod background_tests {
    use super::*;

    #[test]
    fn a_snapshot_or_the_call_makes_a_task_background_and_a_foreground_call_never() {
        let mut t = Tasks::default();
        t.observe(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_bg","name":"Bash",
            "input":{"command":"sleep 20","run_in_background":true}}]}}));
        // measured on Claude Code 2.1.292: the snapshot comes before task_started
        t.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"sleep 20"}]}));
        t.observe(&json!({"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_bg","is_backgrounded":true,"task_type":"local_bash"}));
        // a foreground call gets a task id too, and is in no snapshot
        t.observe(&json!({"type":"system","subtype":"task_started","task_id":"f1","tool_use_id":"toolu_fg","is_backgrounded":false,"task_type":"local_bash"}));
        assert!(t.is_background("b1") && t.asked_background("toolu_bg"));
        assert!(!t.is_background("f1") && !t.asked_background("toolu_fg"));
        assert_eq!(t.counts().1, 1);
        // its end: the notification, then an empty snapshot
        let stopped = t.observe(&json!({"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"toolu_bg",
            "status":"completed","summary":"Background command \"sleep 20\" completed (exit code 0)"}));
        assert!(stopped.is_none(), "a completed task is the CLI's to deliver");
        t.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        assert_eq!(t.counts().1, 0);
        assert!(t.is_background("b1"), "still known as background once it ended");
    }

    #[test]
    fn the_reported_exit_code_is_the_last_the_summary_names() {
        let v = |s: &str| json!({ "summary": s });
        assert_eq!(reported_exit_code(&v("Background command \"npm test\" completed (exit code 0)")), Some(0));
        assert_eq!(reported_exit_code(&v("Background command \"node exit.js\" failed with exit code 3")), Some(3));
        assert_eq!(reported_exit_code(&json!({ "exit_code": 2, "summary": "failed with exit code 9" })), Some(2));
        assert_eq!(reported_exit_code(&v("Background command \"npm test\" was killed")), None);
    }

    #[test]
    fn a_command_output_is_read_only_from_the_clis_folder_and_bounded() {
        let base = std::env::temp_dir().join(format!("orgtree-tasks-test-{}", std::process::id()));
        let folder = base.join("claude");
        let dir = folder.join("proj").join("session").join("tasks");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t1.output");
        std::fs::write(&file, "line one\nline two\n").unwrap();
        let path = file.to_string_lossy().to_string();
        assert_eq!(output_under(&folder, &path, "t1"), Some(("line one\nline two\n".to_string(), false)));
        // another task's name, or a file outside the CLI's folder, is never read
        assert_eq!(output_under(&folder, &path, "t2"), None);
        let outside = base.join("t1.output");
        std::fs::write(&outside, "not the CLI's").unwrap();
        assert_eq!(output_under(&folder, &outside.to_string_lossy(), "t1"), None);
        // more than the cap: its first COMMAND_OUTPUT_MAX bytes, and more
        let big = dir.join("t3.output");
        std::fs::write(&big, vec![b'x'; COMMAND_OUTPUT_MAX as usize + 10]).unwrap();
        let (text, more) = output_under(&folder, &big.to_string_lossy(), "t3").unwrap();
        assert!(more && text.len() == COMMAND_OUTPUT_MAX as usize);
        let _ = std::fs::remove_dir_all(&base);
    }
}
