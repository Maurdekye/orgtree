//! A bounded, private first-level view of Claude helper events. Never feed
//! these rows back to the model or mix their usage into the parent's turn.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MAX_CALLS: usize = 16;
const MAX_ROWS: usize = 64;
const MAX_BYTES: usize = 64 * 1024;
const MAX_BLOCKS: usize = 64;
const MAX_INPUT: usize = 8192;
const INPUT_PENDING: &str = "Arguments withheld until complete JSON can be redacted.";

struct InputDraft {
    name: String,
    text: String,
    overflow: bool,
}

#[derive(Default)]
pub struct Transcript {
    messages: Vec<Value>,
    current: String,
    blocks: BTreeMap<i64, (String, String, usize)>,
    // Partial JSON can split a secret key/value or a wrapper's tool name at
    // any byte. Keep it only in bounded, unlogged memory, never in a snapshot.
    inputs: BTreeMap<i64, InputDraft>,
    truncated: bool,
    pub dirty: bool,
}

#[nolog]
impl Transcript {
    /// All events must already have been attributed to a known root call by
    /// the actor. A helper's own Agent/Task calls stay ordinary tool rows.
    pub fn observe(&mut self, event: &Value) {
        match event["type"].as_str().unwrap_or("") {
            "stream_event" => self.stream(&event["event"]),
            "assistant" => {
                let message = &event["message"];
                let id = message["id"].as_str().unwrap_or("");
                if id.is_empty() { return; }
                let mut row = new_message(id);
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str().unwrap_or("") {
                        "text" => { content(&mut row, "text", block["text"].as_str().unwrap_or(""), &mut self.truncated); }
                        "thinking" => { content(&mut row, "thinking", block["thinking"].as_str().unwrap_or(""), &mut self.truncated); }
                        "tool_use" | "server_tool_use" => {
                            content_tool(&mut row, block, &mut self.truncated);
                        }
                        _ => {}
                    }
                }
                // The completed message replaces its streamed draft; never
                // duplicate text when both stream and assistant frames arrive.
                self.replace(id, row);
                if id == self.current { self.inputs.clear(); }
            }
            "user" => {
                for block in event.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                    if block["type"] != "tool_result" { continue; }
                    let id = block["tool_use_id"].as_str().unwrap_or("");
                    let output = text_content(&block["content"]);
                    for row in &mut self.messages {
                        for chip in row["tools"].as_array_mut().into_iter().flatten() {
                            if chip["id"] == id {
                                chip["result"] = json!(bounded(&output, 8192, &mut self.truncated));
                                chip["error"] = json!(block["is_error"] == true);
                            }
                        }
                    }
                }
            }
            _ => return,
        }
        while self.messages.len() > MAX_ROWS || (self.messages.len() > 1 && serde_json::to_vec(&self.messages).map_or(0, |v| v.len()) > MAX_BYTES) {
            self.messages.remove(0);
            self.truncated = true;
        }
        while serde_json::to_vec(&self.messages).map_or(0, |v| v.len()) > MAX_BYTES {
            let Some(tools) = self.messages.first_mut().and_then(|r| r["tools"].as_array_mut()) else { break };
            if tools.is_empty() { break; }
            tools.remove(0); self.truncated = true;
        }
        // JSON escaping can multiply the encoded size of a single row, and
        // native identifiers are not subject to the text-field limits. If
        // trimming its tools was insufficient, omit the row as well. Include
        // the snapshot envelope and reserve room for the API's live flag.
        while !self.messages.is_empty() && serde_json::to_vec(&self.snapshot()).map_or(0, |v| v.len()) > MAX_BYTES - 32 {
            self.messages.remove(0);
            self.truncated = true;
        }
        if self.messages.is_empty() {
            self.current.clear();
            self.blocks.clear();
            self.inputs.clear();
        }
        self.dirty = true;
    }

    fn stream(&mut self, event: &Value) {
        let index = event["index"].as_i64().unwrap_or(-1);
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                let id = event.pointer("/message/id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() { return; }
                self.current = id.to_string(); self.blocks.clear(); self.inputs.clear();
                if !self.messages.iter().any(|r| r["id"] == id) {
                    self.messages.push(new_message(id));
                }
            }
            "content_block_start" => {
                let block = &event["content_block"];
                let kind = block["type"].as_str().unwrap_or("").to_string();
                let id = block["id"].as_str().unwrap_or("").to_string();
                if self.blocks.len() >= MAX_BLOCKS { self.truncated = true; return; }
                if self.blocks.contains_key(&index) { return; }
                if let Some(row) = self.messages.iter_mut().find(|r| r["id"] == self.current) {
                    let order = match kind.as_str() {
                        "tool_use" | "server_tool_use" => content_tool(row, block, &mut self.truncated),
                        "text" => content(row, "text", block["text"].as_str().unwrap_or(""), &mut self.truncated),
                        "thinking" => content(row, "thinking", block["thinking"].as_str().unwrap_or(""), &mut self.truncated),
                        _ => None,
                    };
                    if let Some(order) = order {
                        if matches!(kind.as_str(), "tool_use" | "server_tool_use") {
                            self.inputs.insert(index, InputDraft { name: block["name"].as_str().unwrap_or("").to_string(), text: String::new(), overflow: false });
                        }
                        self.blocks.insert(index, (kind, id, order));
                    }
                }
            }
            "content_block_delta" => {
                let Some((kind, id, order)) = self.blocks.get(&index) else { return };
                let Some(row) = self.messages.iter_mut().find(|r| r["id"] == self.current) else { return };
                let delta = &event["delta"];
                match kind.as_str() {
                    "text" | "thinking" => {
                        append(&mut row[kind.as_str()], delta[kind.as_str()].as_str().unwrap_or(""), &mut self.truncated);
                        row["content_blocks"][*order]["end"] = json!(utf16_len(&row[kind.as_str()]));
                    }
                    "tool_use" | "server_tool_use" => {
                        if let Some(chip) = row["tools"].as_array_mut().unwrap().iter_mut().find(|t| t["id"] == *id) {
                            let Some(draft) = self.inputs.get_mut(&index) else { return };
                            let Some(text) = delta["partial_json"].as_str() else { return };
                            let mut end = text.len().min(MAX_INPUT.saturating_sub(draft.text.len()));
                            while !text.is_char_boundary(end) { end -= 1; }
                            draft.text.push_str(&text[..end]);
                            draft.overflow |= end < text.len();
                            self.truncated |= draft.overflow;
                            chip["input_text"] = json!(INPUT_PENDING);
                            if !draft.overflow {
                                if let Ok(input) = serde_json::from_str::<Value>(&draft.text) {
                                    let (name, input) = redacted_input(&draft.name, &input);
                                    chip["name"] = json!(name);
                                    chip["input_text"] = json!(bounded(&input.to_string(), MAX_INPUT, &mut self.truncated));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => { self.inputs.remove(&index); }
            "message_stop" => { self.inputs.clear(); }
            _ => {}
        }
    }

    fn replace(&mut self, id: &str, row: Value) {
        if let Some(existing) = self.messages.iter_mut().find(|r| r["id"] == id) { *existing = row; }
        else { self.messages.push(row); }
    }

    pub fn snapshot(&self) -> Value {
        let mut snapshot = json!({"messages":self.messages,"truncated":self.truncated});
        if self.messages.is_empty() && self.truncated {
            snapshot["note"] = json!("The observed helper messages exceeded the retained transcript size limit and could not be kept.");
        }
        snapshot
    }
}

#[nolog]
fn new_message(id: &str) -> Value {
    json!({"id":id,"role":"assistant","text":"","thinking":"","tools":[],"content_blocks":[]})
}

#[nolog]
fn utf16_len(value: &Value) -> usize {
    // Msg slices strings in JavaScript, so offsets count UTF-16 code units.
    value.as_str().unwrap_or("").encode_utf16().count()
}

#[nolog]
fn content(row: &mut Value, kind: &str, text: &str, truncated: &mut bool) -> Option<usize> {
    let order = row["content_blocks"].as_array().unwrap().len();
    if order >= MAX_BLOCKS { *truncated = true; return None; }
    let start = utf16_len(&row[kind]);
    append(&mut row[kind], text, truncated);
    let end = utf16_len(&row[kind]);
    row["content_blocks"].as_array_mut().unwrap().push(json!({"kind":kind,"start":start,"end":end}));
    Some(order)
}

#[nolog]
fn content_tool(row: &mut Value, block: &Value, truncated: &mut bool) -> Option<usize> {
    let order = row["content_blocks"].as_array().unwrap().len();
    if order >= MAX_BLOCKS || row["tools"].as_array().unwrap().len() >= 8 { *truncated = true; return None; }
    row["content_blocks"].as_array_mut().unwrap().push(json!({"kind":"tool","id":block["id"]}));
    row["tools"].as_array_mut().unwrap().push(tool(block, truncated));
    Some(order)
}

#[nolog]
fn tool(block: &Value, truncated: &mut bool) -> Value {
    let input = block.get("input").cloned().unwrap_or(Value::Null);
    let (name, input) = redacted_input(block["name"].as_str().unwrap_or(""), &input);
    let input = serde_json::to_string(&input).unwrap_or_default();
    json!({"id":block["id"],"name":name,"input_text":bounded(&input,2048,truncated)})
}

#[nolog]
fn redacted_input(name: &str, input: &Value) -> (String, Value) {
    let (name, mut input) = super::convo::unwrap_tool_call(name, input);
    // A wrapper without enough identity to unwrap (or non-object arguments)
    // is not a completed native tool input. Do not expose an opaque JSON string.
    if name.rsplit("__").next().unwrap_or(&name).eq_ignore_ascii_case("call_mcp_tool")
        || (!input.is_object() && !input.is_null()) {
        return (name, json!(INPUT_PENDING));
    }
    super::convo::redact_tool_input(&name, &mut input);
    (name, input)
}

/// Old private rows may predate capture redaction. Sanitize on the read path
/// as well; incomplete/clipped JSON cannot be safely shown verbatim.
#[nolog]
pub fn redact_snapshot(snapshot: &mut Value) {
    let mut truncated = false;
    for row in snapshot["messages"].as_array_mut().into_iter().flatten() {
        for chip in row["tools"].as_array_mut().into_iter().flatten() {
            let input = chip.get("input").cloned().or_else(|| chip["input_text"].as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok()));
            if let Some(input) = input {
                let (name, input) = redacted_input(chip["name"].as_str().unwrap_or(""), &input);
                chip["name"] = json!(name);
                if chip.get("input").is_some() { chip["input"] = input.clone(); }
                chip["input_text"] = json!(bounded(&input.to_string(), MAX_INPUT, &mut truncated));
            } else if chip.get("input_text").is_some() {
                chip["input_text"] = json!(INPUT_PENDING);
            }
        }
    }
    if truncated { snapshot["truncated"] = json!(true); }
}

#[nolog]
fn append(value: &mut Value, text: &str, truncated: &mut bool) {
    let old = value.as_str().unwrap_or("");
    let mut joined = old.to_string(); joined.push_str(text);
    *value = json!(bounded(&joined, 8192, truncated));
}

#[nolog]
fn bounded(value: &str, max: usize, truncated: &mut bool) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) { end -= 1; }
    *truncated |= end < value.len();
    value[..end].replace('\0', "")
}

#[nolog]
fn text_content(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| value.as_array().into_iter().flatten()
        .filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn completed_tool(name: &str, input: Value) -> Transcript {
        let mut t = Transcript::default();
        t.observe(&json!({"type":"assistant","message":{"id":"redaction","content":[
            {"type":"tool_use","id":"call","name":name,"input":input}]}}));
        t
    }
    fn input_of(t: &Transcript) -> Value {
        serde_json::from_str(t.snapshot()["messages"][0]["tools"][0]["input_text"].as_str().unwrap()).unwrap()
    }
    fn private_args(kind: &str) -> Value {
        json!({"action":"create","kind":kind,"target":"wss://helper-user:helper-canary-url@example.test/feed?token=helper-canary-query&room=safe",
            "credentials":{"password":"helper-canary-password","bearer":"helper-canary-bearer"},
            "fire_actions":[{"tool":"orgtree_watchdog","args":{"kind":"mqtt","credentials":{"password":"helper-canary-nested"}}}]})
    }
    #[test]
    fn completed_watchdog_helper_inputs_redact_credentials_and_secret_urls() {
        for kind in ["mqtt","websocket"] {
            let t=completed_tool("mcp__orgtree__orgtree_watchdog",private_args(kind));
            assert!(!t.snapshot().to_string().contains("helper-canary-"),"helper snapshot exposed a synthetic credential");
            let kept=input_of(&t);
            assert_eq!(kept["action"],"create");
            assert_eq!(kept["kind"],kind);
            assert!(kept["target"].as_str().unwrap().contains("room=safe"));
        }
    }
    #[test]
    fn wrapped_helper_watchdog_inputs_are_normalized_then_redacted() {
        for args in [private_args("websocket"),json!(private_args("mqtt").to_string())] {
            let t=completed_tool("default_api:call_mcp_tool",json!({"ServerName":"orgtree","ToolName":"orgtree_watchdog","Arguments":args}));
            assert!(!t.snapshot().to_string().contains("helper-canary-"),"wrapped helper snapshot exposed a synthetic credential");
            assert_eq!(input_of(&t)["action"],"create");
            assert_eq!(t.snapshot()["messages"][0]["tools"][0]["name"],"mcp__orgtree__orgtree_watchdog");
        }
    }
    #[test]
    fn partial_helper_inputs_never_publish_secret_fragments() {
        for (name,args) in [("mcp__orgtree__orgtree_watchdog",private_args("mqtt")),
            ("default_api:call_mcp_tool",json!({"ServerName":"orgtree","ToolName":"orgtree_watchdog","Arguments":private_args("websocket").to_string()}))] {
            let mut t=Transcript::default();
            let stream=|event|json!({"type":"stream_event","event":event});
            t.observe(&stream(json!({"type":"message_start","message":{"id":"stream"}})));
            t.observe(&stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":name,"input":{}}})));
            for ch in args.to_string().chars() {
                t.observe(&stream(json!({"type":"content_block_delta","index":0,"delta":{"partial_json":ch.to_string()}})));
                assert!(!t.snapshot().to_string().contains("helper-canary-"),"stream snapshot exposed a synthetic credential fragment");
            }
            assert_eq!(input_of(&t)["action"],"create");
            assert!(!t.snapshot().to_string().contains("helper-canary-"));
        }
    }
    #[test]
    fn helper_redaction_preserves_ordinary_arguments_and_credentials_files() {
        assert_eq!(input_of(&completed_tool("Read",json!({"file_path":"safe.txt","offset":7}))),json!({"file_path":"safe.txt","offset":7}));
        for name in ["orgtree_watchdog","mcp__orgtree__orgtree_watchdog"] {
            let args=json!({"action":"create","kind":"mqtt","target":"mqtt://localhost","pattern":"safe/#","credentials":"config/broker.json"});
            assert_eq!(input_of(&completed_tool(name,args.clone())),args);
        }
    }
    #[test]
    fn older_helper_snapshots_are_redacted_before_publication() {
        let mut snapshot=json!({"live":false,"messages":[{"tools":[
            {"id":"direct","name":"orgtree_watchdog","input_text":private_args("mqtt").to_string()},
            {"id":"wrapped","name":"default_api:call_mcp_tool","input":{"ToolName":"orgtree_watchdog","Arguments":private_args("websocket").to_string()}},
            {"id":"partial","name":"orgtree_watchdog","input_text":"{\"credentials\":{\"password\":\"helper-canary-unfinished"},
            {"id":"read","name":"Read","input_text":"{\"file_path\":\"safe.txt\"}"},
            {"id":"file","name":"orgtree_watchdog","input_text":"{\"credentials\":\"config/broker.json\"}"}]}]});
        redact_snapshot(&mut snapshot);
        assert!(!snapshot.to_string().contains("helper-canary-"));
        let tools=snapshot["messages"][0]["tools"].as_array().unwrap();
        assert_eq!(tools[2]["input_text"],INPUT_PENDING);
        assert!(tools[3]["input_text"].as_str().unwrap().contains("safe.txt"));
        assert!(tools[4]["input_text"].as_str().unwrap().contains("config/broker.json"));
        let once=snapshot.clone();redact_snapshot(&mut snapshot);assert_eq!(snapshot,once);
    }
    #[test]
    fn helper_draft_bounds_cleanup_and_unidentified_wrappers_fail_closed() {
        for input in [json!("helper-canary-opaque"),json!({"Arguments":private_args("mqtt")})] {
            let t=completed_tool("default_api:call_mcp_tool",input);
            assert!(!t.snapshot().to_string().contains("helper-canary-"));
        }
        let mut t=Transcript::default();let stream=|event|json!({"type":"stream_event","event":event});
        t.observe(&stream(json!({"type":"message_start","message":{"id":"bounded"}})));
        t.observe(&stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"large","name":"orgtree_watchdog","input":{}}})));
        t.observe(&stream(json!({"type":"content_block_delta","index":0,"delta":{"partial_json":format!("{{\"credentials\":\"{}", "界".repeat(MAX_INPUT))}})));
        assert!(t.inputs[&0].text.len()<=MAX_INPUT);
        assert_eq!(t.snapshot()["messages"][0]["tools"][0]["input_text"],INPUT_PENDING);
        assert_eq!(t.snapshot()["truncated"],true);
        t.observe(&stream(json!({"type":"content_block_stop","index":0})));assert!(t.inputs.is_empty());
        t.observe(&stream(json!({"type":"message_start","message":{"id":"next"}})));assert!(t.inputs.is_empty());
    }
    #[test]
    fn ordered_fragments_remain_bounded_and_report_omitted_activity() {
        let mut t = Transcript::default();
        let content: Vec<_> = (0..100).map(|_| json!({"type":"text","text":"x"})).collect();
        t.observe(&json!({"type":"assistant","message":{"id":"many","content":content}}));
        let value = t.snapshot();
        assert_eq!(value["messages"][0]["content_blocks"].as_array().unwrap().len(), MAX_BLOCKS);
        assert_eq!(value["truncated"], true);
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_BYTES);
    }
    #[test]
    fn completed_helper_preserves_native_block_order_and_utf16_offsets() {
        let mut t = Transcript::default();
        t.observe(&json!({"type":"assistant","message":{"id":"ordered","content":[
            {"type":"text","text":"Hi 😀"},
            {"type":"tool_use","id":"read","name":"Read","input":{}},
            {"type":"thinking","thinking":"Check"},
            {"type":"text","text":"Done"}]}}));
        let snapshot = t.snapshot();
        assert_eq!(snapshot["messages"][0]["content_blocks"], json!([
            {"kind":"text","start":0,"end":5}, {"kind":"tool","id":"read"},
            {"kind":"thinking","start":0,"end":5}, {"kind":"text","start":5,"end":9}]));
    }
    #[test]
    fn live_helper_order_matches_completed_message_without_duplicate_prose() {
        let mut t = Transcript::default();
        let stream = |event| json!({"type":"stream_event","event":event});
        t.observe(&stream(json!({"type":"message_start","message":{"id":"ordered"}})));
        t.observe(&stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})));
        t.observe(&stream(json!({"type":"content_block_delta","index":0,"delta":{"text":"Before"}})));
        t.observe(&stream(json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"read","name":"Read","input":{}}})));
        t.observe(&stream(json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":"After"}})));
        let before = t.snapshot();
        assert_eq!(before["messages"][0]["content_blocks"], json!([
            {"kind":"text","start":0,"end":6}, {"kind":"tool","id":"read"},
            {"kind":"text","start":6,"end":11}]));
        t.observe(&json!({"type":"assistant","message":{"id":"ordered","content":[
            {"type":"text","text":"Before"}, {"type":"tool_use","id":"read","name":"Read","input":{}},
            {"type":"text","text":"After"}]}}));
        let after = t.snapshot();
        assert_eq!(before["messages"], after["messages"]);
        assert_eq!(after["messages"][0]["text"], "BeforeAfter");
    }
    #[test]
    fn streams_then_replaces_draft_and_keeps_nested_tools_as_data() {
        let mut t = Transcript::default();
        let stream = |event| json!({"type":"stream_event","event":event});
        t.observe(&stream(json!({"type":"message_start","message":{"id":"m"}})));
        t.observe(&stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})));
        t.observe(&stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"working"}})));
        assert_eq!(t.snapshot()["messages"][0]["text"], "working");
        t.observe(&json!({"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"working"},
            {"type":"tool_use","id":"nested","name":"Agent","input":{"prompt":"nested"}}]}}));
        t.observe(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"nested","content":"done","is_error":true}]}}));
        let snapshot = t.snapshot();
        assert_eq!(snapshot["messages"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["messages"][0]["text"], "working");
        assert_eq!(snapshot["messages"][0]["tools"][0]["result"], "done");
        assert_eq!(snapshot["messages"][0]["tools"][0]["error"], true);
    }
    #[test]
    fn snapshot_is_bounded_utf8_safe_and_strips_nul() {
        let mut t = Transcript::default();
        for i in 0..100 {
            t.observe(&json!({"type":"assistant","message":{"id":format!("m{i}"),"content":[{"type":"text","text":"é\0".repeat(10000)}]}}));
        }
        let value = t.snapshot();
        assert_eq!(value["truncated"], true);
        assert!(serde_json::to_vec(&value).unwrap().len() < MAX_BYTES + 128);
        assert!(!value.to_string().contains("\\u0000"));
    }
    #[test]
    fn escaped_text_and_oversized_identifiers_cannot_exceed_snapshot_cap() {
        let mut t = Transcript::default();
        t.observe(&json!({"type":"assistant","message":{"id":"escaped","content":[
            {"type":"text","text":"\u{1}".repeat(8192)},
            {"type":"thinking","thinking":"\u{2}".repeat(8192)}]}}));
        assert!(serde_json::to_vec(&t.snapshot()).unwrap().len() <= MAX_BYTES);
        t.observe(&json!({"type":"assistant","message":{"id":"x".repeat(MAX_BYTES * 2),"content":[]}}));
        assert!(serde_json::to_vec(&t.snapshot()).unwrap().len() <= MAX_BYTES);
        assert_eq!(t.snapshot()["truncated"], true);
    }
}
