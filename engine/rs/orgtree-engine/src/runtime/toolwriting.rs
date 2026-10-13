//! Observed call generation, separate from execution. Never retain arguments.
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
}
#[nolog]
impl ToolWriting {
    pub fn start(&mut self, block: u64, id: &str, name: &str, order: u64) {
        if id.is_empty() { return; }
        self.blocks.insert(block, id.to_string());
        self.calls.entry(id.to_string()).or_insert_with(|| Writing {
            name: name.to_string(), started: Instant::now(),
            at: crate::util::now_iso(), order, secs: None,
        });
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
        let mut rows: Vec<Value> = self.calls.iter().filter(|(_, c)| c.secs.is_none()).map(|(id, c)| json!({
            "event_id": format!("tool-writing-{turn}-{id}"), "role": "assistant", "kind": "tool_writing",
            "text": c.name, "tool_id": id, "started_at": c.at, "stream_order": c.order,
        })).collect();
        rows.sort_by_key(|r| r["stream_order"].as_u64());
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
