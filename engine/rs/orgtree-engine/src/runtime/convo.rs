//! The conversation an agent's desk shows: rows already shaped like the
//! renderer's `ChatMessage`, appended (and amended, e.g. when a tool result
//! arrives) by the agent's actor only, read by index for `/chat`.

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

/// Per-agent row counters; owned by the actor (the only writer).
#[derive(Debug)]
pub struct ConvoWriter {
    pub agent_id: i64,
    pub seq: i64,
    pub ver: i64,
}

#[logged]
impl ConvoWriter {
    pub async fn load(client: &Client, agent_id: i64) -> Result<Self> {
        let r = client
            .query_one(
                "SELECT coalesce(max(seq), 0), coalesce(max(ver), 0) FROM ot.convo WHERE agent_id = $1",
                &[&agent_id],
            )
            .await?;
        Ok(ConvoWriter { agent_id, seq: r.get(0), ver: r.get(1) })
    }

    /// Append a row; returns its seq. `body` gets its identity fields filled.
    pub async fn append(&mut self, client: &Client, mut body: Value) -> Result<i64> {
        self.seq += 1;
        self.ver += 1;
        let seq = self.seq;
        stamp(&mut body, seq);
        client
            .execute(
                "INSERT INTO ot.convo (agent_id, seq, ver, body) VALUES ($1, $2, $3, $4)",
                &[&self.agent_id, &seq, &self.ver, &body],
            )
            .await?;
        Ok(seq)
    }

    pub async fn update(&mut self, client: &Client, seq: i64, mut body: Value) -> Result<()> {
        self.ver += 1;
        stamp(&mut body, seq);
        client
            .execute(
                "UPDATE ot.convo SET body = $3, ver = $4 WHERE agent_id = $1 AND seq = $2",
                &[&self.agent_id, &seq, &body, &self.ver],
            )
            .await?;
        Ok(())
    }
}

#[logged]
fn stamp(body: &mut Value, seq: i64) {
    if let Some(o) = body.as_object_mut() {
        o.insert("seq".into(), json!(seq));
        o.insert("row_id".into(), json!(format!("r{seq}")));
        o.entry("event_id".to_string()).or_insert(json!(format!("e{seq}")));
    }
}

/// `after` cursors are `"<ver>:<max seq>"`.
#[logged]
pub fn parse_after(after: &str) -> Option<(i64, i64)> {
    let (v, s) = after.split_once(':')?;
    Some((v.parse().ok()?, s.parse().ok()?))
}

#[derive(Debug, serde::Serialize)]
pub struct Page {
    pub messages: Vec<Value>,
    pub updates: Vec<Value>,
    pub incremental: bool,
    pub has_older: bool,
    pub before: Option<String>,
    pub after: String,
}

/// The newest `last` rows (or older than `before`), or what changed after a cursor.
#[logged]
pub async fn read(client: &Client, agent_id: i64, last: i64, before: Option<i64>, after: Option<(i64, i64)>) -> Result<Page> {
    let top = client
        .query_one("SELECT coalesce(max(seq), 0), coalesce(max(ver), 0) FROM ot.convo WHERE agent_id = $1", &[&agent_id])
        .await?;
    let (max_seq, max_ver): (i64, i64) = (top.get(0), top.get(1));
    let cursor = format!("{max_ver}:{max_seq}");
    if let Some((ver, seen_seq)) = after {
        if ver <= max_ver {
            let rows = client
                .query(
                    "SELECT seq, body FROM ot.convo WHERE agent_id = $1 AND ver > $2 ORDER BY seq LIMIT 1000",
                    &[&agent_id, &ver],
                )
                .await?;
            if rows.len() < 1000 {
                let mut messages = Vec::new();
                let mut updates = Vec::new();
                for r in rows {
                    let seq: i64 = r.get(0);
                    let body: Value = r.get(1);
                    if seq > seen_seq {
                        messages.push(body);
                    } else {
                        updates.push(body);
                    }
                }
                return Ok(Page { messages, updates, incremental: true, has_older: false, before: None, after: cursor });
            }
        }
    }
    let last = last.clamp(1, 2000);
    let rows = match before {
        Some(b) => {
            client
                .query(
                    "SELECT seq, body FROM ot.convo WHERE agent_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3",
                    &[&agent_id, &b, &(last + 1)],
                )
                .await?
        }
        None => {
            client
                .query(
                    "SELECT seq, body FROM ot.convo WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2",
                    &[&agent_id, &(last + 1)],
                )
                .await?
        }
    };
    let has_older = rows.len() as i64 > last;
    let mut rows: Vec<(i64, Value)> = rows.into_iter().take(last as usize).map(|r| (r.get(0), r.get(1))).collect();
    rows.reverse();
    let before = if has_older { rows.first().map(|(s, _)| s.to_string()) } else { None };
    Ok(Page {
        messages: rows.into_iter().map(|(_, b)| b).collect(),
        updates: Vec::new(),
        incremental: false,
        has_older,
        before,
        after: cursor,
    })
}

/// A plain-text digest of an agent's recent conversation (what it was asked,
/// what it said, the tools it used): seeds a fresh session.
#[logged]
pub async fn digest(client: &impl tokio_postgres::GenericClient, agent_id: i64, last: i64) -> Result<String> {
    let rows = client
        .query("SELECT body FROM ot.convo WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2", &[&agent_id, &last])
        .await?;
    let mut parts: Vec<String> = Vec::new();
    for r in rows.iter().rev() {
        let b: Value = r.get(0);
        let role = b["role"].as_str().unwrap_or("");
        let text = crate::util::gist(b["text"].as_str().unwrap_or(""), 1200);
        match role {
            "user" => {
                let from = b
                    .pointer("/segments/0/rows/0/from")
                    .and_then(Value::as_str)
                    .unwrap_or("mail");
                parts.push(format!("[{from}] {text}"));
            }
            "assistant" => {
                let tools: Vec<String> = b["tools"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|t| format!("{} {}", t["name"].as_str().unwrap_or(""), t["arg"].as_str().unwrap_or("")))
                            .collect()
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    parts.push(format!("[you] {text}"));
                }
                if !tools.is_empty() {
                    parts.push(format!("[your tools] {}", crate::util::gist(&tools.join("; "), 600)));
                }
            }
            _ => {}
        }
    }
    let mut out = String::from("Recent conversation (oldest first):\n");
    for p in parts {
        out.push_str(&p);
        out.push('\n');
    }
    Ok(out)
}

/// Shorten a tool result for display; the agent saw it whole.
#[logged]
pub fn clip(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_string(), false);
    }
    let s: String = text.chars().take(max).collect();
    (s, true)
}

/// The short argument a tool chip shows beside the tool name.
#[logged]
pub fn tool_arg(_name: &str, input: &Value) -> String {
    // the most identifying argument IS the line (`Bash ls /e/…`): the first
    // of these that is a non-empty string, else any string, whitespace
    // collapsed and at most 90 characters — never the input dumped as JSON
    let Some(o) = input.as_object() else { return String::new() };
    let flat = |s: &str| -> String { s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(90).collect() };
    for k in ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt", "name", "text", "to", "body"] {
        match o.get(k) {
            Some(Value::String(s)) if !s.trim().is_empty() => return flat(s),
            // Codex passes a command as its argument list
            Some(Value::Array(a)) if k == "command" => {
                let joined = a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
                if !joined.trim().is_empty() {
                    return flat(&joined);
                }
            }
            _ => {}
        }
    }
    o.values().filter_map(Value::as_str).find(|s| !s.trim().is_empty()).map(flat).unwrap_or_default()
}

/// Text of a tool_result's content (string, or text blocks); counts images.
#[logged]
pub fn tool_result_text(content: &Value) -> (String, usize) {
    match content {
        Value::String(s) => (s.clone(), 0),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut images = 0;
            for b in blocks {
                match b["type"].as_str() {
                    Some("text") => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(b["text"].as_str().unwrap_or(""));
                    }
                    Some("image") => images += 1,
                    _ => {}
                }
            }
            (text, images)
        }
        _ => (String::new(), 0),
    }
}

/// the newest tool images kept per agent
const IMAGES_KEPT: i64 = 300;
/// a single image larger than this is not kept
const IMAGE_MAX: usize = 8 * 1024 * 1024;

/// The images in a tool result's content: (media type, bytes), in order.
#[logged]
pub fn image_blocks(content: &Value) -> Vec<(String, Vec<u8>)> {
    use base64::Engine as _;
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "image")
                .filter_map(|b| {
                    let src = &b["source"];
                    let media = src["media_type"].as_str().unwrap_or("image/png").to_string();
                    let data = base64::engine::general_purpose::STANDARD.decode(src["data"].as_str()?).ok()?;
                    (data.len() <= IMAGE_MAX).then_some((media, data))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Keep a tool's images for its chip (`/toolimg/{tool}?idx=N`).
#[logged]
pub async fn store_images(client: &Client, agent_id: i64, tool_id: &str, images: Vec<(String, Vec<u8>)>) -> Result<()> {
    if images.is_empty() || tool_id.is_empty() {
        return Ok(());
    }
    for (i, (media, data)) in images.into_iter().enumerate() {
        client
            .execute(
                "INSERT INTO ot.tool_images (agent_id, tool_id, idx, media, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
                &[&agent_id, &tool_id, &(i as i32), &media, &data],
            )
            .await?;
    }
    client
        .execute(
            "DELETE FROM ot.tool_images WHERE agent_id = $1 AND at < (
                SELECT at FROM ot.tool_images WHERE agent_id = $1 ORDER BY at DESC OFFSET $2 LIMIT 1)",
            &[&agent_id, &IMAGES_KEPT],
        )
        .await?;
    Ok(())
}
