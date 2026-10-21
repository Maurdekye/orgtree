//! Private, bounded timing metadata for native Claude stream blocks. No thought text.
use std::collections::BTreeMap;
use std::time::Instant;
use serde_json::Value;

#[derive(Default)]
pub struct Timing {
    message: Option<String>,
    blocks: BTreeMap<u64, Block>,
}
struct Block { start: Instant, secs: Option<f64> }

#[nolog]
impl Timing {
    pub fn observe(&mut self, event: &Value, now: Instant) {
        match event["type"].as_str() {
            Some("message_start") => {
                let id=event["message"]["id"].as_str().filter(|id| !id.is_empty());
                if id != self.message.as_deref() {
                    self.blocks.clear();
                    self.message=id.map(str::to_string);
                }
            }
            Some("content_block_start") if self.message.is_some()
                && matches!(event["content_block"]["type"].as_str(),Some("thinking"|"redacted_thinking")) => {
                if let Some(index)=event["index"].as_u64() {
                    if self.blocks.len()<1024 {
                        self.blocks.entry(index).or_insert(Block {start:now,secs:None});
                    }
                }
            }
            Some("content_block_stop") => {
                if let Some(block)=event["index"].as_u64().and_then(|i| self.blocks.get_mut(&i)) {
                    block.secs.get_or_insert_with(|| now.saturating_duration_since(block.start).as_secs_f64());
                }
            }
            _ => {}
        }
    }

    /// Claude emits its complete thinking blocks in native block order, sometimes
    /// as separate assistant records sharing one message id. A final block is
    /// itself an observed end when the partial stream omitted content_block_stop.
    pub fn take(&mut self, message: &str, now: Instant) -> Option<f64> {
        if self.message.as_deref()!=Some(message) { return None; }
        let (_,block)=self.blocks.pop_first()?;
        Some(block.secs.unwrap_or_else(|| now.saturating_duration_since(block.start).as_secs_f64()))
    }
}
