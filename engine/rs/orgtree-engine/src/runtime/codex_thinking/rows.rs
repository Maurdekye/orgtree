//! Codex reasoning rows: retain supplied text or a sealed marker, never ciphertext.
use serde_json::{json, Value};

#[nolog]
pub fn row(item: &Value, previous: Option<Value>, at: &str) -> Value {
    let parts = |field: &str| item[field].as_array().map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    let summary=parts("summary");
    let body=if summary.trim().is_empty() {parts("content")} else {summary};
    let mut row=previous.unwrap_or_else(||json!({"role":"assistant","text":"","tools":[],"ts":at,"assistant_id":item["id"]}));
    // A repeated empty receipt cannot hide a summary already supplied for this
    // native item. A later readable receipt can replace its sealed marker.
    if !body.trim().is_empty() {
        row["thinking"]=json!(body.chars().take(20_000).collect::<String>());
        row["thinking_sealed"]=json!(false);
    } else if row["thinking"].as_str().is_none_or(|s|s.trim().is_empty()) {
        row["thinking"]=json!("");row["thinking_sealed"]=json!(true);
    }
    // Keep the ordinary unordered row form: Codex tool chips may attach to
    // this same row later. No invented content block, elapsed time or tokens.
    row
}

