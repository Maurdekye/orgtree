//! Observed generation and a bounded, ephemeral input preview; never persisted.
use std::collections::HashMap;
use std::time::Instant;
use serde_json::{json, Value};

#[derive(Default)]
pub struct ToolWriting {
    calls: HashMap<String, Writing>,
    blocks: HashMap<u64, String>,
}
struct Writing {
    name: String,
    started: Instant,
    at: String,
    order: u64,
    secs: Option<f64>,
    input: String,
    seed: Value,
}
#[nolog]
impl ToolWriting {
    pub fn start(&mut self, block: u64, id: &str, name: &str, order: u64) {
        if id.is_empty() { return; }
        self.blocks.insert(block, id.to_string());
        self.calls.entry(id.to_string()).or_insert_with(|| Writing {
            name: name.to_string(), started: Instant::now(),
            at: crate::util::now_iso(), order, secs: None, input: String::new(), seed: json!({}),
        });
    }
    pub fn seed(&mut self, block: u64, input: &Value) {
        if let Some(call) = self.blocks.get(&block).and_then(|id| self.calls.get_mut(id)) {
            if input.is_object() && input.to_string().len() <= 64_000 { call.seed = input.clone(); }
        }
    }
    pub fn delta(&mut self, block: u64, text: &str) -> bool {
        let Some(call) = self.blocks.get(&block).and_then(|id| self.calls.get_mut(id)) else { return false };
        let mut len = text.len().min(64_000usize.saturating_sub(call.input.len()));
        while !text.is_char_boundary(len) { len -= 1; }
        if len == 0 || call.secs.is_some() { return false; }
        call.input.push_str(&text[..len]);
        true
    }
    pub fn stop(&mut self, block: u64) {
        if let Some(id) = self.blocks.remove(&block) {
            if let Some(call) = self.calls.get_mut(&id) {
                if call.secs.is_none() { call.secs = Some(call.started.elapsed().as_secs_f64()); }
            }
        }
    }
    /// A complete admitted call is also a generation boundary if stop was omitted.
    pub fn take(&mut self, id: &str) -> Option<f64> {
        self.blocks.retain(|_, value| value != id);
        self.calls.remove(id).map(|c| c.secs.unwrap_or_else(|| c.started.elapsed().as_secs_f64()))
    }
    pub fn active(&self, turn: i64) -> Vec<Value> {
        let mut rows: Vec<Value> = self.calls.iter().filter(|(_, c)| c.secs.is_none()).map(|(id, c)| {
            let mut input = c.seed.clone();
            if let Some(partial) = partial_input(&c.input).as_object() {
                if let Some(base) = input.as_object_mut() { base.extend(partial.clone()); }
            }
            json!({
            "event_id": format!("tool-writing-{turn}-{id}"), "role": "assistant", "kind": "tool_writing",
            "text": c.name, "tool_id": id, "started_at": c.at, "stream_order": c.order,
            "tool": { "id": id, "name": c.name, "arg": super::convo::tool_arg(&c.name, &input),
                "preview_input": input, "writing_started_at": c.at,
                "refs": super::convo::tool_refs(&c.name, &input, None) },
        }) }).collect();
        rows.sort_by_key(|r| r["stream_order"].as_u64());
        rows
    }
}

/// Close only syntax already observed. Incomplete keys/values fall back to the
/// latest complete member boundary; an unfinished string contributes its known
/// characters. No missing value is invented. Work and memory are bounded.
#[nolog]
fn partial_input(text: &str) -> Value {
    let mut stack = Vec::new();
    let mut boundaries = Vec::new();
    let (mut string, mut escape) = (false, false);
    for (i, c) in text.char_indices() {
        if string {
            if escape { escape = false; }
            else if c == '\\' { escape = true; }
            else if c == '"' { string = false; }
            continue;
        }
        match c {
            '"' => string = true,
            '{' | '[' => {
                if stack.len() >= 64 { return json!({}); }
                stack.push(if c == '{' { '}' } else { ']' });
                boundaries.push((i + 1, stack.clone()));
            }
            '}' | ']' => { if stack.pop() != Some(c) { return json!({}); } }
            ',' => boundaries.push((i, stack.clone())),
            _ => {}
        }
    }
    for trim in 0..=if string { 6.min(text.len()) } else { 0 } {
        let end = text.len() - trim;
        if !text.is_char_boundary(end) { continue; }
        let mut candidate = text[..end].to_string();
        if string { candidate.push('"'); }
        candidate.extend(stack.iter().rev());
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) { return value; }
    }
    for (end, closers) in boundaries.into_iter().rev().take(128) {
        let mut candidate = text[..end].to_string();
        candidate.extend(closers.iter().rev());
        if let Ok(value) = serde_json::from_str::<Value>(&candidate) { return value; }
    }
    json!({})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_inputs_update_the_same_call_without_inventing_unknown_fields() {
        let mut w = ToolWriting::default();
        w.start(0, "a", "Bash", 1);
        w.delta(0, r#"{"command":"echo hel"#);
        assert_eq!(w.active(1)[0]["tool"]["arg"], "echo hel");
        assert!(w.active(1)[0]["tool"]["preview_input"].get("description").is_none());
        let at = w.active(1)[0]["started_at"].clone();
        w.delta(0, r#"lo","description":"Say hello","unknown":"#);
        let row = &w.active(1)[0];
        assert_eq!(row["tool"]["arg"], "Say hello");
        assert_eq!(row["tool"]["preview_input"]["command"], "echo hello");
        assert!(row["tool"]["preview_input"].get("unknown").is_none());
        assert_eq!(row["started_at"], at);
        w.start(1, "b", "Read", 2); w.seed(1, &json!({"file_path":"other.txt"}));
        assert_eq!(w.active(1)[1]["tool"]["arg"], "other.txt");
        w.stop(0);
        assert!(!w.delta(0, "ignored"));
        assert_eq!(w.active(1).len(), 1);
        assert!(w.take("a").is_some());
    }
    #[test]
    fn previews_handle_nested_metadata_escapes_and_bounded_utf8() {
        assert_eq!(partial_input(r#"{"metadata":{"to":"worker"},"body":"a\nb"#)["body"], "a\nb");
        assert_eq!(partial_input(r#"{"command":"abc\u12"#)["command"], "abc");
        assert!(partial_input(r#"{"command":"echo","descrip"#).get("descrip").is_none());
        let mut w = ToolWriting::default(); w.start(0, "a", "Bash", 1);
        w.delta(0, &format!("{{\"command\":\"{}", "界".repeat(30_000)));
        assert!(w.calls["a"].input.len() <= 64_000);
        assert!(!w.active(1)[0]["tool"]["arg"].as_str().unwrap().is_empty());
        assert!(!w.delta(99, "ignored"));
    }
    #[test]
    fn interleaved_blocks_and_duplicate_starts_keep_independent_clocks() {
        let mut w = ToolWriting::default();
        w.start(0, "a", "first", 1);
        let at = w.active(1)[0]["started_at"].clone();
        w.start(0, "a", "first", 9);
        w.start(1, "b", "second", 2);
        assert_eq!(w.active(1)[0]["started_at"], at);
        assert_eq!(w.active(1)[0]["stream_order"], 1);
        w.stop(0);
        assert_eq!(w.active(1).len(), 1);
        let written = w.calls["a"].secs.unwrap();
        assert_eq!(w.take("a"), Some(written));
        assert!(w.take("b").is_some());
        assert!(w.active(1).is_empty());
        assert_eq!(w.take("historical-or-unsupported"), None);
        assert_eq!(w.take("a"), None);
    }
    #[test]
    fn reused_block_index_never_consumes_another_call_and_stop_is_idempotent() {
        let mut w = ToolWriting::default();
        w.start(0, "a", "one", 1); w.stop(0);
        let written = w.calls["a"].secs;
        w.stop(0);
        w.start(0, "b", "two", 2);
        assert_eq!(w.take("a"), written);
        w.stop(0);
        assert!(w.active(2).is_empty());
        assert!(w.take("b").is_some());
        w.start(0, "", "unknown", 3);
        assert!(w.active(2).is_empty());
    }
}
