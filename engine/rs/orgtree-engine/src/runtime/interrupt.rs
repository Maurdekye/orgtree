//! Per-turn completion tracking. Notifications are evidence of completion,
//! never a pause; only a hook callback holds its provider at the boundary.
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    Claude,
    Agy,
    Async,
}
#[nolog]
impl Boundary {
    pub fn description(self) -> &'static str {
        match self {
            Self::Claude => "at the next held post-tool hook, after active tools finish",
            Self::Agy => "at the next held post-invocation hook, after active tools finish",
            Self::Async => "on the next observed tool/thought/response completion, after active tools finish; the next step may already have started and be cut off early",
        }
    }
}

#[derive(Default)]
pub struct Progress {
    active: HashSet<String>,
    completed: HashSet<String>,
}
#[nolog]
impl Progress {
    pub fn start(&mut self, id: &str) {
        if !id.is_empty() && !self.completed.contains(id) {
            self.active.insert(id.into());
        }
    }
    pub fn finish(&mut self, id: &str) -> bool {
        if id.is_empty() || !self.completed.insert(id.into()) {
            return false;
        }
        self.active.remove(id);
        self.active.is_empty()
    }
    pub fn quiet(&self) -> bool {
        self.active.is_empty()
    }
}

/// Only root items attributed to the running provider turn count. Child tools
/// and prior turns cannot resolve a queued request.
#[nolog]
pub fn codex<'a>(v: &'a Value, turn: Option<&str>) -> Option<(&'a str, bool)> {
    let p = &v["params"];
    if p["turnId"].as_str() != turn || turn.is_none() {
        return None;
    }
    let completed = match v["method"].as_str()? {
        "item/started" => false,
        "item/completed" => true,
        _ => return None,
    };
    let item = &p["item"];
    if !matches!(
        item["type"].as_str()?,
        "commandExecution"
            | "fileChange"
            | "mcpToolCall"
            | "dynamicToolCall"
            | "webSearch"
            | "imageView"
            | "reasoning"
            | "agentMessage"
    ) {
        return None;
    }
    Some((item["id"].as_str()?, completed))
}

#[nolog]
pub fn muse<'a>(v: &'a Value, turn: Option<&str>) -> Option<(&'a str, bool)> {
    if !matches!(
        v["method"].as_str()?,
        "item/started" | "item/updated" | "item/completed"
    ) {
        return None;
    }
    let i = &v["params"]["item"];
    if i["turnId"].as_str() != turn || turn.is_none() {
        return None;
    }
    if !matches!(
        i["kind"].as_str()?,
        "toolCall" | "reasoning" | "agentMessage"
    ) {
        return None;
    }
    let done = v["method"] == "item/completed"
        || matches!(
            i["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        );
    Some((i["itemId"].as_str()?, done))
}

/// Claude stream lines: a root tool_use starts work and its tool_result ends
/// it. A failed call gets no PostToolUse hook, so its result is the only end
/// it ever has; without it, a queued interrupt waited for the turn to end
/// (USER 2026-10-27, proposal H). Sub-agent lines never count.
#[nolog]
pub fn claude(v: &Value) -> Vec<(&str, bool)> {
    if !v["parent_tool_use_id"].is_null() {
        return Vec::new();
    }
    let done = match v["type"].as_str() {
        Some("assistant") => false,
        Some("user") => true,
        _ => return Vec::new(),
    };
    v.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|b| match (done, b["type"].as_str()?) {
            (false, "tool_use") => Some((b["id"].as_str()?, false)),
            (true, "tool_result") => Some((b["tool_use_id"].as_str()?, true)),
            _ => None,
        })
        .collect()
}

#[nolog]
pub fn acp<'a>(v: &'a Value, turn: Option<&str>) -> Option<(&'a str, bool)> {
    if v["turn"].as_str() != turn || turn.is_none() {
        return None;
    }
    let u = &v["update"];
    if !matches!(
        u["sessionUpdate"].as_str()?,
        "tool_call" | "tool_call_update"
    ) {
        return None;
    }
    Some((
        u["toolCallId"].as_str()?,
        matches!(u["status"].as_str(), Some("completed" | "failed")),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn parallel_calls_and_replays_do_not_supply_a_false_boundary() {
        let mut p = Progress::default();
        p.start("long");
        p.start("short");
        assert!(!p.finish("short"));
        assert!(!p.finish("short"));
        assert!(!p.quiet());
        assert!(p.finish("long"));
        p.start("long"); // stale replay cannot reopen the call
        assert!(p.quiet());
        assert!(!p.finish("long"));
    }
    #[test]
    fn newly_started_parallel_work_is_not_cut_midway() {
        let mut p = Progress::default();
        p.start("old");
        p.start("new");
        assert!(!p.finish("old"));
        assert!(p.finish("new"));
    }
    #[test]
    fn claude_failed_calls_end_on_their_result() {
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__orgtree__orgtree_work"}]}});
        let failed = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"refused"}]}});
        let helper = json!({"type":"user","parent_tool_use_id":"agent-1","message":{"content":[{"type":"tool_result","tool_use_id":"t9"}]}});
        assert_eq!(claude(&call), vec![("t1", false)]);
        assert_eq!(claude(&failed), vec![("t1", true)]);
        assert!(claude(&helper).is_empty());
        let mut p = Progress::default();
        let mut feed = |v: &Value| for (id, done) in claude(v) { if done { p.finish(id); } else { p.start(id); } };
        feed(&call);
        feed(&failed);
        assert!(p.quiet(), "a failed call no longer holds a queued interrupt off for the rest of the turn");
    }
    #[test]
    fn completion_only_notices_count_once() {
        let mut p = Progress::default();
        assert!(p.finish("completed-without-start"));
        assert!(!p.finish("completed-without-start"));
    }
    #[test]
    fn stale_turns_chunks_and_nonwork_items_are_not_boundaries() {
        let x = json!({"method":"item/completed","params":{"turnId":"old","item":{"id":"x","type":"commandExecution"}}});
        assert!(codex(&x, Some("new")).is_none());
        assert_eq!(codex(&x, Some("old")), Some(("x", true)));
        assert!(codex(&x, None).is_none());
        let m = json!({"method":"item/completed","params":{"item":{"turnId":"old","itemId":"m","kind":"toolCall"}}});
        assert!(muse(&m, Some("new")).is_none());
        assert_eq!(muse(&m, Some("old")), Some(("m", true)));
        let a = json!({"turn":"one","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"partial"}}});
        assert!(acp(&a, Some("one")).is_none());
        let a = json!({"turn":"one","update":{"sessionUpdate":"tool_call_update","toolCallId":"a","status":"failed"}});
        assert_eq!(acp(&a, Some("one")), Some(("a", true)));
    }
}
