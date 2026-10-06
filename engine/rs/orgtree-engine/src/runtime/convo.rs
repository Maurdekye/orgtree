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
pub fn tool_arg(name: &str, input: &Value) -> String {
    let pick = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let s = match name {
        "Bash" | "PowerShell" => pick("command"),
        "Read" | "Edit" | "Write" | "NotebookEdit" => pick("file_path").or_else(|| pick("notebook_path")),
        "Glob" | "Grep" => pick("pattern"),
        "WebFetch" => pick("url"),
        "WebSearch" => pick("query"),
        "Task" | "Agent" => pick("description"),
        "TodoWrite" => Some("todos".into()),
        _ => None,
    };
    let s = s.unwrap_or_else(|| {
        let mut v = input.to_string();
        if v.len() > 300 {
            v.truncate(300);
        }
        v
    });
    crate::util::gist(&s, 300)
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
