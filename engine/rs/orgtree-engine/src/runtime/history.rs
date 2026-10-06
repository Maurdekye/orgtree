//! The recent history of an agent imported from 3.x (ledger C5): the first
//! time its desk is read, its Claude sessions' own transcripts
//! (`<config>/projects/<cwd>/<session>.jsonl`) are turned into desk rows once.
//!
//! The rows go in below the actor's range (seq ≤ 0, ver 0): the actor stays
//! the only writer of seq ≥ 1, so the two never collide, and the imported
//! rows sort before everything this engine recorded. Only transcript entries
//! older than the agent's first turn here are taken (the same file can carry
//! those turns too). Codex and Antigravity agents keep an empty history.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::runtime::convo;

/// the newest rows kept from the old transcripts
const KEEP_ROWS: usize = 600;
/// only the tail of a huge transcript is read
const TAIL_BYTES: u64 = 64 * 1024 * 1024;

/// Fill an imported agent's history once (a no-op for every other agent and
/// every later call).
#[logged]
pub async fn ensure(engine: &Engine, agent_id: i64) -> Result<()> {
    let client = engine.db.get().await?;
    // claim it: only one reader ever imports, and never twice
    let Some(r) = client
        .query_opt(
            "UPDATE ot.agents SET extra = coalesce(extra, '{}'::jsonb) || '{\"history_imported\": true}'::jsonb
              WHERE id = $1 AND extra ? 'imported_from' AND NOT coalesce((extra->>'history_imported')::boolean, false)
             RETURNING session_id, provider, account, scratch_dir, name, org_id",
            &[&agent_id],
        )
        .await?
    else {
        return Ok(());
    };
    let provider: Option<String> = r.get(1);
    let account: Option<String> = r.get(2);
    let scratch: Option<String> = r.get(3);
    let name: String = r.get(4);
    let org_id: i64 = r.get(5);
    let mut sessions: Vec<String> = client
        .query(
            "SELECT session_id FROM ot.agent_sessions WHERE agent_id = $1 AND provider IN ('claude', 'openrouter') ORDER BY started_at, id",
            &[&agent_id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if let Some(s) = r.get::<_, Option<String>>(0) {
        if provider.as_deref().map(|p| p == "claude" || p == "openrouter").unwrap_or(true) && !sessions.contains(&s) {
            sessions.push(s);
        }
    }
    if sessions.is_empty() {
        return Ok(());
    }
    // what this engine already recorded is not taken again
    let cutoff: Option<DateTime<Utc>> =
        client.query_one("SELECT min(at) FROM ot.convo WHERE agent_id = $1 AND seq > 0", &[&agent_id]).await?.get(0);
    drop(client);
    let view = engine.accounts.view();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = account.as_deref().and_then(|a| view.get(a)).and_then(|a| a.config_dir.clone()) {
        roots.push(PathBuf::from(dir));
    }
    roots.push(crate::runtime::claude::default_config_dir());
    for a in view.all() {
        if let Some(d) = &a.config_dir {
            let p = PathBuf::from(d);
            if !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    let cwd = scratch.map(PathBuf::from).or_else(|| engine.orgs.by_id(org_id).map(|o| engine.cfg.scratch_root(&o.slug).join(&name)));
    let parsed = tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        for s in &sessions {
            if let Some(f) = find(cwd.as_deref(), s, &roots) {
                files.push(f);
            }
        }
        rows_of(&files, cutoff)
    })
    .await;
    let (rows, images) = match parsed {
        Ok(r) => r,
        Err(e) => {
            release(engine, agent_id).await;
            return Err(e.into());
        }
    };
    if rows.is_empty() {
        tracing::info!(agent = agent_id, "no earlier Claude transcript was found for this imported agent");
        return Ok(());
    }
    let n = rows.len() as i64;
    if let Err(e) = insert(engine, agent_id, rows).await {
        release(engine, agent_id).await;
        return Err(e);
    }
    // the pictures its tools returned, for the chips that show them
    if let Ok(client) = engine.db.get().await {
        for (tid, list) in images {
            if let Err(e) = convo::store_images(&client, agent_id, &tid, list).await {
                tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "an imported tool image could not be kept");
            }
        }
    }
    tracing::info!(agent = agent_id, rows = n, "imported the agent's earlier conversation");
    Ok(())
}

/// Give the once-only claim back (an import that failed may be tried again).
#[logged]
async fn release(engine: &Engine, agent_id: i64) {
    if let Ok(client) = engine.db.get().await {
        let _ = client.execute("UPDATE ot.agents SET extra = extra - 'history_imported' WHERE id = $1", &[&agent_id]).await;
    }
}

#[logged]
async fn insert(engine: &Engine, agent_id: i64, rows: Vec<Value>) -> Result<()> {
    let n = rows.len() as i64;
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    for (i, mut row) in rows.into_iter().enumerate() {
        let seq = i as i64 - n;
        if let Some(o) = row.as_object_mut() {
            o.insert("seq".into(), json!(seq));
            o.insert("row_id".into(), json!(format!("r{seq}")));
            o.entry("event_id".to_string()).or_insert(json!(format!("h{}", -seq)));
        }
        let at = row["ts"].as_str().and_then(crate::util::parse_ts).unwrap_or_else(Utc::now);
        tx.execute(
            "INSERT INTO ot.convo (agent_id, seq, ver, at, body) VALUES ($1, $2, 0, $3, $4) ON CONFLICT DO NOTHING",
            &[&agent_id, &seq, &at, &row],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Where a session's transcript is: under the agent's own project folder in
/// any config folder, else in any project folder at all.
#[logged]
fn find(cwd: Option<&Path>, session: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let file = format!("{session}.jsonl");
    if let Some(cwd) = cwd {
        let project = crate::runtime::claude::project_dir(cwd);
        for r in roots {
            let p = r.join("projects").join(&project).join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for r in roots {
        let Ok(entries) = std::fs::read_dir(r.join("projects")) else { continue };
        for e in entries.flatten() {
            let p = e.path().join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The transcript's lines (the tail of a huge file).
fn lines_of(path: &Path) -> Vec<Value> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let skip_first = len > TAIL_BYTES;
    if skip_first {
        let _ = f.seek(SeekFrom::Start(len - TAIL_BYTES));
    }
    let mut text = String::new();
    if f.read_to_string(&mut text).is_err() {
        let mut bytes = Vec::new();
        let _ = f.seek(SeekFrom::Start(if skip_first { len - TAIL_BYTES } else { 0 }));
        let _ = f.read_to_end(&mut bytes);
        text = String::from_utf8_lossy(&bytes).to_string();
    }
    text.lines()
        .skip(if skip_first { 1 } else { 0 })
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// the newest imported tool images kept (each tool result's images together)
const KEEP_IMAGE_RESULTS: usize = 100;

/// Desk rows from the transcripts, oldest first, the newest `KEEP_ROWS`;
/// and the images their tool results carried.
#[logged]
fn rows_of(files: &[PathBuf], cutoff: Option<DateTime<Utc>>) -> (Vec<Value>, Vec<(String, Vec<(String, Vec<u8>)>)>) {
    let mut images: Vec<(String, Vec<(String, Vec<u8>)>)> = Vec::new();
    let mut entries: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for f in files {
        for e in lines_of(f) {
            if let Some(u) = e["uuid"].as_str() {
                if !seen.insert(u.to_string()) {
                    continue;
                }
            }
            entries.push(e);
        }
    }
    let when = |e: &Value| e["timestamp"].as_str().and_then(crate::util::parse_ts);
    entries.retain(|e| match (cutoff, when(e)) {
        (Some(c), Some(t)) => t < c,
        _ => true,
    });
    entries.sort_by_key(|e| when(e));
    let mut rows: Vec<Value> = Vec::new();
    // assistant message id → row index; tool use id → row index
    let mut by_message: HashMap<String, usize> = HashMap::new();
    let mut by_tool: HashMap<String, usize> = HashMap::new();
    for e in entries {
        // subagent internals and the CLI's own meta lines are not the conversation
        if e["isSidechain"].as_bool().unwrap_or(false) || e["isMeta"].as_bool().unwrap_or(false) {
            continue;
        }
        let ts = e["timestamp"].as_str().unwrap_or("").to_string();
        match e["type"].as_str() {
            Some("assistant") => {
                let msg = &e["message"];
                let mid = msg["id"].as_str().unwrap_or("").to_string();
                let idx = match by_message.get(&mid) {
                    Some(i) if !mid.is_empty() => *i,
                    _ => {
                        rows.push(json!({ "role": "assistant", "text": "", "tools": [], "ts": ts, "assistant_id": mid,
                                          "native_event_id": e["uuid"] }));
                        by_message.insert(mid.clone(), rows.len() - 1);
                        rows.len() - 1
                    }
                };
                let row = &mut rows[idx];
                for block in msg["content"].as_array().cloned().unwrap_or_default() {
                    match block["type"].as_str() {
                        Some("text") => {
                            let cur = row["text"].as_str().unwrap_or("").to_string();
                            let add = block["text"].as_str().unwrap_or("");
                            row["text"] = json!(if cur.is_empty() { add.to_string() } else { format!("{cur}\n\n{add}") });
                        }
                        Some("thinking") => {
                            let add = block["thinking"].as_str().unwrap_or("");
                            if !add.is_empty() {
                                let cur = row.get("thinking").and_then(Value::as_str).unwrap_or("").to_string();
                                let joined = if cur.is_empty() { add.to_string() } else { format!("{cur}\n\n{add}") };
                                row["thinking"] = json!(convo::clip(&joined, 20_000).0);
                            } else {
                                row["thinking_sealed"] = json!(true);
                            }
                        }
                        Some("redacted_thinking") => row["thinking_sealed"] = json!(true),
                        Some("tool_use") | Some("server_tool_use") => {
                            let id = block["id"].as_str().unwrap_or("").to_string();
                            let name = block["name"].as_str().unwrap_or("tool").to_string();
                            let input = block["input"].clone();
                            let mut chip = json!({ "id": id, "name": name, "arg": convo::tool_arg(&name, &input) });
                            if name == "TodoWrite" {
                                chip["todos"] = input["todos"].clone();
                            }
                            if let Some(t) = row["tools"].as_array_mut() {
                                t.push(chip);
                            }
                            by_tool.insert(id, idx);
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                let content = &e["message"]["content"];
                if let Some(s) = content.as_str() {
                    if !s.trim().is_empty() {
                        rows.push(json!({ "role": "user", "text": s, "ts": ts }));
                    }
                    continue;
                }
                let blocks = content.as_array().cloned().unwrap_or_default();
                let mut text = String::new();
                for b in &blocks {
                    match b["type"].as_str() {
                        Some("tool_result") => {
                            let tid = b["tool_use_id"].as_str().unwrap_or("");
                            let Some(&idx) = by_tool.get(tid) else { continue };
                            let (out, n_images) = convo::tool_result_text(&b["content"]);
                            if n_images > 0 {
                                images.push((tid.to_string(), convo::image_blocks(&b["content"])));
                            }
                            let images = n_images;
                            let (clipped, truncated) = convo::clip(&out, 4000);
                            if let Some(chips) = rows[idx]["tools"].as_array_mut() {
                                for chip in chips.iter_mut().filter(|c| c["id"].as_str() == Some(tid)) {
                                    chip["result"] = json!(clipped);
                                    chip["result_lines"] = json!(out.lines().count());
                                    if truncated {
                                        chip["truncated"] = json!(true);
                                    }
                                    if images > 0 {
                                        chip["images"] = json!(images);
                                    }
                                    if b["is_error"].as_bool().unwrap_or(false) {
                                        chip["error"] = json!(crate::util::gist(&out, 500));
                                    }
                                }
                            }
                        }
                        Some("text") => {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(b["text"].as_str().unwrap_or(""));
                        }
                        Some("image") => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str("[image]");
                        }
                        _ => {}
                    }
                }
                if !text.trim().is_empty() {
                    rows.push(json!({ "role": "user", "text": text, "ts": ts }));
                }
            }
            _ => {}
        }
    }
    // an assistant line that carried only an empty block says nothing
    rows.retain(|r| {
        r["role"] != json!("assistant")
            || !r["text"].as_str().unwrap_or("").is_empty()
            || r["tools"].as_array().map(|t| !t.is_empty()).unwrap_or(false)
            || r.get("thinking").is_some()
    });
    let skip = rows.len().saturating_sub(KEEP_ROWS);
    let rows: Vec<Value> = rows.into_iter().skip(skip).collect();
    // only images whose chip is still shown
    let shown: std::collections::HashSet<String> = rows
        .iter()
        .flat_map(|r| r["tools"].as_array().cloned().unwrap_or_default())
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect();
    images.retain(|(tid, _)| shown.contains(tid));
    let drop_n = images.len().saturating_sub(KEEP_IMAGE_RESULTS);
    (rows, images.into_iter().skip(drop_n).collect())
}
