//! The conversation an agent's desk shows: rows already shaped like the
//! renderer's `ChatMessage`, appended (and amended, e.g. when a tool result
//! arrives) by the agent's actor only, read by index for `/chat`.

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

/// Per-agent row counters; owned by the actor (the only writer).
pub struct ConvoWriter {
    pub agent_id: i64,
    pub seq: i64,
    pub ver: i64,
    /// Sanitized, committed replacements awaiting the actor's next stream frame.
    pending: std::collections::BTreeMap<i64, Value>,
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
        Ok(ConvoWriter { agent_id, seq: r.get(0), ver: r.get(1), pending: Default::default() })
    }

    /// Append a row; returns its seq. `body` gets its identity fields filled.
    #[nolog]
    pub async fn append(&mut self, client: &Client, mut body: Value) -> Result<i64> {
        self.seq += 1;
        self.ver += 1;
        let seq = self.seq;
        stamp(&mut body, seq);
        body["convo_revision"] = json!(self.ver);
        let inputs = take_tool_inputs(&mut body, seq);
        client
            .execute(
                "INSERT INTO ot.convo (agent_id, seq, ver, body, tool_inputs) VALUES ($1, $2, $3, $4, $5)",
                &[&self.agent_id, &seq, &self.ver, &body, &inputs],
            )
            .await?;
        self.remember(seq, body);
        Ok(seq)
    }

    #[nolog]
    pub async fn update(&mut self, client: &Client, seq: i64, mut body: Value) -> Result<()> {
        self.ver += 1;
        stamp(&mut body, seq);
        body["convo_revision"] = json!(self.ver);
        let inputs = take_tool_inputs(&mut body, seq);
        client
            .execute(
                "UPDATE ot.convo SET body = $3, ver = $4, tool_inputs = tool_inputs || coalesce((SELECT jsonb_object_agg(k, coalesce(tool_inputs -> k, '{}'::jsonb) || v) FROM jsonb_each($5::jsonb) AS incoming(k, v)), '{}'::jsonb) WHERE agent_id = $1 AND seq = $2",
                &[&self.agent_id, &seq, &body, &self.ver, &inputs],
            )
            .await?;
        self.remember(seq, body);
        Ok(())
    }

    #[nolog]
    fn remember(&mut self, seq: i64, body: Value) {
        self.pending.insert(seq, body);
        // The transcript remains authoritative if an exceptional batch exceeds
        // this bound; the ordinary refresh still retrieves every saved row.
        while self.pending.len() > 128 {
            self.pending.pop_first();
        }
    }

    #[nolog]
    pub fn take_pending(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending).into_values().collect()
    }

    /// Each live amendment commits independently; a bad row cannot drop later results.
    #[nolog]
    pub async fn update_batch(&mut self, client: &Client, updates: Vec<(i64, Value)>) -> usize {
        let mut failed = 0;
        for (seq, row) in updates {
            if seq > 0 {
                if let Err(e) = self.update(client, seq, row).await {
                    failed += 1;
                    tracing::warn!(agent=self.agent_id, seq, error=%format!("{e:#}"), "tool transcript row failed; continuing batch");
                }
            }
        }
        failed
    }
}

/// Atomically retained with the row, but never included in `/chat` or feeds.
#[nolog]
pub fn take_tool_inputs(body: &mut Value, seq: i64) -> Value {
    crate::util::pg_json_mut(body);
    let mut inputs = serde_json::Map::new();
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for chip in tools {
            let Some(id) = chip["id"].as_str().map(str::to_string) else { continue };
            let Some(chip) = chip.as_object_mut() else { continue };
            let mut kept = serde_json::Map::new();
            if let Some(input) = chip.remove("input") {
                let source = chip.remove("input_source");
                kept.insert("input".into(), input);
                kept.insert("codex".into(), json!(source));
                chip.insert("input_seq".into(), json!(seq));
            }
            if let Some(output) = chip.remove("failed_shell_output") {
                kept.insert("failed_shell_output".into(), output);
                chip.insert("output_seq".into(), json!(seq));
            }
            if !kept.is_empty() { inputs.insert(id, Value::Object(kept)); }
        }
    }
    Value::Object(inputs)
}

/// Provider-reported failed shell output only. Kept separately from chat/feed.
#[nolog]
pub fn retain_failed_shell_output(chip: &mut Value, text: &str, failed: bool, provider_truncated: bool) {
    let name = chip["name"].as_str().unwrap_or("").rsplit("__").next().unwrap_or("").to_ascii_lowercase();
    if !failed || !["bash", "powershell", "exec_command", "run_command", "run_shell_command", "shell"].contains(&name.as_str()) { return; }
    const MAX_BYTES: usize = 1024 * 1024;
    let mut end = text.len().min(MAX_BYTES);
    while !text.is_char_boundary(end) { end -= 1; }
    let mut kept = json!({ "truncated": end < text.len(), "provider_truncated": provider_truncated });
    // PostgreSQL JSON cannot contain NUL. Encode this exceptional output so
    // the shared JSON sanitizer cannot silently remove its returned bytes.
    if text[..end].contains('\0') {
        use base64::Engine as _;
        kept["output_base64"] = json!(base64::engine::general_purpose::STANDARD.encode(&text.as_bytes()[..end]));
    } else { kept["output"] = json!(&text[..end]); }
    chip["failed_shell_output"] = kept;
    // Empty provider output is still a reported failure, never a success.
    if chip["error"].is_null() { chip["error"] = json!(crate::util::gist(text, 500)); }
}

#[cfg(test)]
mod failed_shell_output_tests {
    use super::*;
    #[test]
    fn output_is_kept_off_feed_and_input_survives_extraction() {
        let mut chip = json!({"id":"call", "name":"PowerShell", "input":{"command":"synthetic"}, "result":"clipped"});
        retain_failed_shell_output(&mut chip, &"LONG".repeat(2000), true, false);
        let mut row = json!({"tools":[chip]});
        let retained = take_tool_inputs(&mut row, 7);
        assert!(row["tools"][0].get("failed_shell_output").is_none());
        assert_eq!(row["tools"][0]["output_seq"], 7);
        assert_eq!(retained["call"]["input"]["command"], "synthetic");
        assert_eq!(retained["call"]["failed_shell_output"]["output"].as_str().unwrap().len(), 8000);
        for (name, failed) in [("Bash", false), ("Read", true), ("apply_patch", true)] {
            let mut other = json!({"name":name});
            retain_failed_shell_output(&mut other, "output", failed, false);
            assert!(other.get("failed_shell_output").is_none());
        }
    }
    #[test]
    fn byte_cap_is_utf8_safe_and_provider_truncation_is_explicit() {
        let mut chip = json!({"name":"exec_command"});
        let text = format!("{}éTAIL", "x".repeat(1024 * 1024 - 1));
        retain_failed_shell_output(&mut chip, &text, true, true);
        assert_eq!(chip["failed_shell_output"]["output"].as_str().unwrap().len(), 1024 * 1024 - 1);
        assert_eq!(chip["failed_shell_output"]["truncated"], true);
        assert_eq!(chip["failed_shell_output"]["provider_truncated"], true);
        let mut empty = json!({"name":"Bash"});
        retain_failed_shell_output(&mut empty, "", true, false);
        assert!(empty["error"].is_string());
        assert_eq!(empty["failed_shell_output"]["truncated"], false);
        let mut nul = json!({"id":"nul", "name":"Bash"});
        retain_failed_shell_output(&mut nul, "before\0after", true, false);
        let mut row = json!({"tools":[nul]});
        let retained = take_tool_inputs(&mut row, 8);
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD.decode(retained["nul"]["failed_shell_output"]["output_base64"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, b"before\0after");
    }
}

/// Consecutive prose blocks keep their existing paragraph/fold grouping;
/// a tool between them is a boundary that must remain visible in that order.
#[nolog]
pub fn append_display_block(row: &mut Value, block: Value) {
    let Some(blocks) = row["content_blocks"].as_array_mut() else { return };
    if let Some(last) = blocks.last_mut() {
        if last["kind"] == block["kind"] && block["kind"] != "tool" && last["sealed"] == block["sealed"] {
            last["end"] = block["end"].clone();
            return;
        }
    }
    blocks.push(block);
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
                restore_mail_notices(client, agent_id, &mut messages).await?;
                restore_mail_notices(client, agent_id, &mut updates).await?;
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
    let mut messages: Vec<Value> = rows.into_iter().map(|(_, b)| b).collect();
    restore_mail_notices(client, agent_id, &mut messages).await?;
    Ok(Page {
        messages,
        updates: Vec::new(),
        incremental: false,
        has_older,
        before,
        after: cursor,
    })
}

/// Older transcript rows dropped `notice`. Recover only missing flags from
/// their original mail, scoped to this recipient and this already bounded page.
/// No transcript rewrite, event-kind inference, or query per message.
#[logged]
async fn restore_mail_notices(client: &Client, agent_id: i64, messages: &mut [Value]) -> Result<()> {
    let mut ids = std::collections::BTreeSet::new();
    for message in messages.iter() {
        for segment in message["segments"].as_array().into_iter().flatten() {
            if segment["kind"] != "mail" { continue; }
            for row in segment["rows"].as_array().into_iter().flatten() {
                if row["notice"].as_bool().is_none() {
                    if let Some(id) = row["id"].as_str() { ids.insert(id.to_owned()); }
                }
            }
        }
    }
    let ids: Vec<String> = ids.into_iter().collect();
    let mut notices = std::collections::HashMap::<String, bool>::new();
    for chunk in ids.chunks(1000) {
        let chunk = chunk.to_vec();
        for row in client.query(
            "SELECT uid, notice FROM ot.mail WHERE recipient_agent_id = $1 AND uid = ANY($2::text[])",
            &[&agent_id, &chunk],
        ).await? {
            notices.insert(row.get(0), row.get(1));
        }
    }
    for message in messages {
        let Some(segments) = message.get_mut("segments").and_then(Value::as_array_mut) else { continue };
        for segment in segments {
            if segment["kind"] != "mail" { continue; }
            let Some(rows) = segment.get_mut("rows").and_then(Value::as_array_mut) else { continue };
            for row in rows {
                if row["notice"].as_bool().is_some() { continue; }
                if let Some(notice) = row["id"].as_str().and_then(|id| notices.get(id)) {
                    row["notice"] = json!(notice);
                }
            }
        }
    }
    Ok(())
}

/// Only shell inputs belong in recovery exports; other tools keep summaries.
#[nolog]
fn is_recovery_shell(t: &Value) -> bool {
    matches!(t["name"].as_str().unwrap_or("").rsplit("__").next().unwrap_or("").to_ascii_lowercase().as_str(),
        "bash" | "powershell" | "exec_command" | "run_command" | "run_shell_command" | "shell")
}

#[nolog]
fn recovery_command(input: &Value) -> Option<String> {
    let command = input.as_str().map(str::to_string).or_else(|| {
        ["command", "cmd", "CommandLine", "command_line", "script"].iter().find_map(|key| match &input[*key] {
            Value::String(s) => Some(s.clone()),
            Value::Array(args) if args.iter().all(Value::is_string) => Some(Value::Array(args.clone()).to_string()),
            _ => None,
        })
    })?;
    if command.is_empty() { None } else { Some(command) }
}

#[nolog]
fn recovery_input<'a>(t: &Value, inputs: &'a Value, native: &'a Value) -> &'a Value {
    let id = t["id"].as_str().unwrap_or("");
    native.get(id).filter(|v| recovery_command(v).is_some()).unwrap_or(&inputs[id]["input"])
}

#[nolog]
fn recovery_label(text: &str) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(1024).collect();
    if chars.next().is_some() { out.push_str(" [truncated]"); }
    out
}

#[nolog]
fn recovery_tool(t: &Value, inputs: &Value, native: &Value) -> String {
    let mut out = format!("{} {}", t["name"].as_str().unwrap_or(""), t["arg"].as_str().unwrap_or(""));
    if !is_recovery_shell(t) { return out; }
    let input = recovery_input(t, inputs, native);
    let Some(command) = recovery_command(input) else {
        out.push_str(" [command input not retained]");
        return out;
    };
    const COMMAND_BYTES: usize = 8192;
    let mut end = command.len().min(COMMAND_BYTES);
    while !command.is_char_boundary(end) { end -= 1; }
    out.push_str("\n[command input]\n");
    out.push_str(&command[..end]);
    if end < command.len() { out.push_str("\n[command truncated at 8192 UTF-8 bytes]"); }
    out.push_str("\n[end command input]");
    for key in ["workdir", "cwd", "shell"] {
        let id = t["id"].as_str().unwrap_or("");
        if let Some(value) = input.get(key).or_else(|| inputs[id]["input"].get(key)).and_then(Value::as_str) {
            out.push_str(&format!("\n{key}: {}", recovery_label(value)));
        }
    }
    out
}

/// Project only shell inputs, excluding unrelated patches, arguments and full
/// failed output from these history reads. Keep the existing bounded row scan.
#[nolog]
async fn recovery_rows(client: &impl tokio_postgres::GenericClient, agent_id: i64, last: i64) -> Result<Vec<tokio_postgres::Row>> {
    Ok(client.query(
        "SELECT c.body, coalesce(shell.inputs, '{}'::jsonb), coalesce(shell.native, '{}'::jsonb)
         FROM (SELECT seq, body, tool_inputs, tool_native_inputs FROM ot.convo
               WHERE agent_id = $1 ORDER BY seq DESC LIMIT $2) c
         LEFT JOIN LATERAL (
           SELECT jsonb_object_agg(t->>'id', jsonb_build_object('input', c.tool_inputs->(t->>'id')->'input')) AS inputs,
                  jsonb_object_agg(t->>'id', c.tool_native_inputs->(t->>'id'))
                    FILTER (WHERE c.tool_native_inputs ? (t->>'id')) AS native
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.body->'tools') = 'array'
                                     THEN c.body->'tools' ELSE '[]'::jsonb END) t
           WHERE t->>'id' IS NOT NULL AND lower(regexp_replace(t->>'name', '^.*__', ''))
             IN ('bash', 'powershell', 'exec_command', 'run_command', 'run_shell_command', 'shell')
         ) shell ON true ORDER BY c.seq DESC", &[&agent_id, &last.clamp(1, 5000)],
    ).await?)
}

#[cfg(test)]
mod recovery_command_tests {
    use super::*;

    #[test]
    fn description_does_not_replace_multiline_shell_input() {
        let t = json!({"id":"c", "name":"PowerShell", "arg":"Run focused checks"});
        let command = "cargo test -j2 --locked\nWrite-Output 'exact tail'";
        let inputs = json!({"c":{"input":{"command":command,"workdir":"D:/synthetic/source  worktree"}}});
        let out = recovery_tool(&t, &inputs, &json!({}));
        assert!(out.contains(command));
        assert!(out.contains("D:/synthetic/source  worktree"));
        assert!(out.contains("Run focused checks"));
    }

    #[test]
    fn native_command_and_utf8_limit_are_preserved() {
        let t = json!({"id":"c", "name":"exec_command", "arg":"check"});
        let command = format!("{}éTAIL", "x".repeat(8191));
        let inputs = json!({"c":{"input":{"command":"provider fallback"}}});
        let native = json!({"c":{"cmd":command,"workdir":"D:/synthetic/native"}});
        let out = recovery_tool(&t, &inputs, &native);
        assert!(out.contains(&"x".repeat(8191)));
        assert!(!out.contains("éTAIL"));
        assert!(out.contains("[command truncated at 8192 UTF-8 bytes]"));
        assert!(out.contains("D:/synthetic/native"));
        assert!(!out.contains("provider fallback"));
    }

    #[test]
    fn other_inputs_stay_private_and_argv_stays_unambiguous() {
        let inputs = json!({"c":{"input":{"command":["pwsh","-Command","Write-Output 'a b'"]}}});
        let shell = recovery_tool(&json!({"id":"c","name":"shell"}), &inputs, &json!({}));
        assert!(shell.contains("[\"pwsh\",\"-Command\",\"Write-Output 'a b'\"]"));
        let read = recovery_tool(&json!({"id":"c","name":"Read","arg":"public summary"}), &inputs, &json!({}));
        assert_eq!(read, "Read public summary");
        let legacy = recovery_tool(&json!({"id":"old","name":"Bash","arg":"old clipped summary"}), &json!({}), &json!({}));
        assert!(legacy.contains("command input not retained"));
    }

    #[test]
    fn oversized_handoff_keeps_live_scope_before_old_history() {
        let note = format!("Your live docket items: CURRENT-SCOPE\nSource/worktree evidence: D:/synthetic/source\nLast messages from your current superior: NEW-DIRECTION\n\nOlder context follows.\n{}\nYour whole earlier conversation is saved at D:/synthetic/history.md; read it when needed.\n", "STALE-HISTORY ".repeat(1000));
        let out = crate::runtime::prompt::handoff_reference(&note, 1024);
        assert!(out.contains("CURRENT-SCOPE"));
        assert!(out.contains("NEW-DIRECTION"));
        assert!(out.contains("D:/synthetic/history.md"));
        assert!(!out.contains("STALE-HISTORY"));
        assert!(out.len() <= 1024);
    }

    #[test]
    fn exact_byte_limit_is_not_marked_truncated_and_native_null_falls_back() {
        let t = json!({"id":"c","name":"mcp__terminal__PowerShell"});
        let command = format!("{}é", "x".repeat(8190));
        let inputs = json!({"c":{"input":{"command":command}}});
        let out = recovery_tool(&t, &inputs, &json!({"c":null}));
        assert!(out.contains(&command));
        assert!(!out.contains("truncated"));
    }
}

/// A plain-text digest of the recent conversation, including bounded commands.
#[nolog] // command bodies must not enter tracing arguments or return values
pub async fn digest(client: &impl tokio_postgres::GenericClient, agent_id: i64, last: i64) -> Result<String> {
    let rows = recovery_rows(client, agent_id, last.clamp(1, 60)).await?;
    let mut parts: Vec<String> = Vec::new();
    for r in rows.iter().rev() {
        let b: Value = r.get(0);
        let inputs: Value = r.get(1);
        let native: Value = r.get(2);
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
                            .map(|t| recovery_tool(t, &inputs, &native))
                            .collect()
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    parts.push(format!("[you] {text}"));
                }
                if !tools.is_empty() {
                    parts.push(format!("[your tools]\n{}", tools.join("\n")));
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

/// Save the agent's desk history (its newest rows, oldest first) as Markdown
/// in `dir`, for a session that could not carry the conversation over.
#[nolog] // history now includes command bodies
pub async fn save_history(client: &Client, agent_id: i64, dir: &std::path::Path) -> Result<std::path::PathBuf> {
    let rows = recovery_rows(client, agent_id, 5000).await?;
    let mut out = String::from("# Earlier conversation\n\nYour desk history before you moved to a fresh session, oldest first.\n\n");
    for r in rows.iter().rev() {
        let b: Value = r.get(0);
        let inputs: Value = r.get(1);
        let native: Value = r.get(2);
        let ts = b["ts"].as_str().unwrap_or("");
        let text = b["text"].as_str().unwrap_or("");
        match b["role"].as_str().unwrap_or("") {
            "user" => {
                let from = b.pointer("/segments/0/rows/0/from").and_then(Value::as_str).unwrap_or("mail");
                out.push_str(&format!("## From {from} · {ts}\n\n{text}\n\n"));
            }
            "assistant" => {
                out.push_str(&format!("## You · {ts}\n\n"));
                if !text.is_empty() {
                    out.push_str(text);
                    out.push_str("\n\n");
                }
                for t in b["tools"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                    out.push_str(&format!("- tool: {}\n", recovery_tool(t, &inputs, &native)));
                }
                if b["tools"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    out.push('\n');
                }
            }
            _ if !text.is_empty() => out.push_str(&format!("_{text}_ ({ts})\n\n")),
            _ => {}
        }
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("earlier-conversation-{}.md", chrono::Utc::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, out)?;
    Ok(path)
}

/// The request the agent posed to the user and still has open, told to a
/// fresh session that does not remember posing it (3.x told the session a
/// cheap compact started; the request survives it), or the one closed as
/// moot when this fresh session replaced the one that posed it (a provider
/// switch, a removed Codex or Antigravity account). Empty when neither.
#[logged]
async fn standing_request(client: &Client, agent_id: i64) -> Result<String> {
    let open = client
        .query_opt("SELECT body FROM ot.asks WHERE agent_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1", &[&agent_id])
        .await?
        .and_then(|r| crate::domain::asks::describe(&crate::domain::asks::Parts::of(&r.get::<_, Value>(0))));
    if let Some(what) = open {
        return Ok(format!(
            "You still have a request open with the user from your earlier conversation ({what}). It is still on the user's \
             screen, and the answer will arrive as mail addressed to you. Read your earlier conversation for what it was asked \
             for before you act on it, and do not withdraw or replace it merely because you do not remember posing it.\n\n"
        ));
    }
    let mooted: Option<String> = client.query_one("SELECT extra->>'mooted_ask' FROM ot.agents WHERE id = $1", &[&agent_id]).await?.get(0);
    Ok(mooted
        .map(|what| {
            format!(
                "The request you had open with the user ({what}) was closed when this fresh session replaced the one that \
                 posed it, so no answer will come. Pose it again if it still matters.\n\n"
            )
        })
        .unwrap_or_default())
}

/// Point a fresh session at conversation recall and name whom it wrote with
/// last (the user asked that compacted agents be told). A failed read only
/// leaves the names out.
#[logged]
async fn recall_hint(client: &Client, agent_id: i64) -> String {
    let mut s = String::from(
        "To recover what you were discussing with someone, use orgtree_inbox action=conversation peer=<name> before \
         you reply to them (peer: an agent's name, user, @org:<slug> or @net:<address>): it lists the mail you and \
         they exchanged, both directions, newest first.",
    );
    match crate::domain::correspondence::recent_peers(client, agent_id, 6).await {
        Ok(peers) if !peers.is_empty() => {
            let names: Vec<String> = peers.iter().map(|(p, at)| format!("{p} ({})", at.format("%Y-%m-%d %H:%MZ"))).collect();
            s.push_str(&format!(" You exchanged mail most recently with: {}.", names.join(", ")));
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "recent correspondents could not be read"),
    }
    s.push_str("\n\n");
    s
}

/// The live docket items a fresh session holds, so no work is dropped (user
/// 2026-10-09; decision 64): the items it owns that are not done, dropped or
/// archived (backlogged ones apart), and those waiting for its review, newest
/// updated first and at most DOCKET_HINT_MAX. A snapshot in this note only:
/// never in the identity or a fingerprint, so docket changes respawn nothing.
/// A failed read only leaves the list out.
#[logged]
async fn docket_hint(client: &Client, agent_id: i64) -> String {
    match docket_items(client, agent_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(agent = agent_id, error = %format!("{e:#}"), "the docket items could not be read");
            String::new()
        }
    }
}

const DOCKET_HINT_MAX: usize = 30;

#[logged]
async fn docket_items(client: &Client, agent_id: i64) -> Result<String> {
    // owned (the owner index) and reviewing (status review, in the agent's org)
    const ITEMS: &str = "
        SELECT slug, title, status, working_on_next->>0 AS next, false AS reviewing, NULL::text AS owner, updated_at, id,
               left(objective, 1024) AS objective, left(blocked_reason, 1000) AS blocked_reason, dependencies[1:10] AS dependencies
          FROM ot.work_items
         WHERE owner_agent_id = $1 AND archived_at IS NULL AND NOT coalesce((extra->>'deleted')::boolean, false)
           AND status IN ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved', 'deploy_ready')
        UNION ALL
        SELECT w.slug, w.title, w.status, w.working_on_next->>0, true, coalesce(a.name, w.owner->>'node', 'unknown'), w.updated_at, w.id,
               left(w.objective, 1024), left(w.blocked_reason, 1000), w.dependencies[1:10]
          FROM ot.work_items w LEFT JOIN ot.agents a ON a.id = w.owner_agent_id
         WHERE w.org_id = (SELECT org_id FROM ot.agents WHERE id = $1) AND w.reviewer_agent_id = $1
           AND w.owner_agent_id IS DISTINCT FROM $1 AND w.status = 'review'
           AND w.archived_at IS NULL AND NOT coalesce((w.extra->>'deleted')::boolean, false)";
    let rows = client
        .query(&format!("SELECT * FROM ({ITEMS}) t ORDER BY (status = 'backlogged'), updated_at DESC, id DESC LIMIT {}", DOCKET_HINT_MAX + 1), &[&agent_id])
        .await?;
    if rows.is_empty() {
        return Ok("You hold no live docket items.\n\n".into());
    }
    let more = if rows.len() > DOCKET_HINT_MAX {
        let all: i64 = client.query_one(&format!("SELECT count(*) FROM ({ITEMS}) t"), &[&agent_id]).await?.get(0);
        all as usize - DOCKET_HINT_MAX
    } else {
        0
    };
    let short = |s: &str| -> String {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > 200 { format!("{}…", s.chars().take(200).collect::<String>()) } else { s }
    };
    let (mut live, mut backlog, mut review) = (Vec::new(), Vec::new(), Vec::new());
    for r in rows.iter().take(DOCKET_HINT_MAX) {
        let (slug, title, status): (String, String, String) = (r.get(0), r.get(1), r.get(2));
        let next = r.get::<_, Option<String>>(3).filter(|n| !n.trim().is_empty()).map(|n| format!(" — next: {}", short(&n))).unwrap_or_default();
        let details = recovery_scope(&r.get::<_, String>(8), r.get::<_, Option<String>>(9).as_deref(), &r.get::<_, Vec<String>>(10));
        if r.get::<_, bool>(4) {
            let owner: String = r.get(5);
            review.push(format!("- {slug} · {} (owner {owner}){next}{details}", short(&title)));
        } else if status == "backlogged" {
            backlog.push(format!("- {slug} · {}{next}{details}", short(&title)));
        } else {
            live.push(format!("- {slug} · {status} · {}{next}{details}", short(&title)));
        }
    }
    let mut s = String::from(
        "Your live docket items, as this session starts (newest updated first; the docket is the record, and \
         scope/blocker/dependency excerpts below are bounded; orgtree_work action=get slug=<slug> reads one in full):\n",
    );
    for (head, lines) in [("", &live), ("Waiting for your review:\n", &review), ("Backlogged, not started yet:\n", &backlog)] {
        if !lines.is_empty() {
            s.push_str(head);
            s.push_str(&lines.join("\n"));
            s.push('\n');
        }
    }
    if more > 0 {
        s.push_str(&format!(
            "…and {more} more not shown: orgtree_work action=list include_backlogged=true lists every item you can read.\n"
        ));
    }
    s.push('\n');
    Ok(s)
}

#[nolog]
fn recovery_scope(scope: &str, blocked: Option<&str>, dependencies: &[String]) -> String {
    let mut out = format!("\n  Current scope (excerpt): {}", scope.replace('\n', "\n  "));
    if let Some(blocked) = blocked.filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n  Blocked: {blocked}"));
    }
    if !dependencies.is_empty() {
        out.push_str(&format!("\n  Declared dependencies (first 10; check current status): {}", dependencies.join(", ")));
    }
    out
}

/// The last recorded shell directory is evidence, not a guessed checkout or SHA.
#[nolog]
async fn source_hint(client: &Client, agent_id: i64) -> Result<String> {
    let rows = recovery_rows(client, agent_id, 60).await?;
    for row in rows {
        let body: Value = row.get(0);
        let inputs: Value = row.get(1);
        let native: Value = row.get(2);
        for tool in body["tools"].as_array().into_iter().flatten().rev() {
            if !is_recovery_shell(tool) { continue; }
            let input = recovery_input(tool, &inputs, &native);
            let id = tool["id"].as_str().unwrap_or("");
            let retained = &inputs[id]["input"];
            if let Some(dir) = input.get("workdir").or_else(|| input.get("cwd"))
                .or_else(|| retained.get("workdir")).or_else(|| retained.get("cwd"))
                .and_then(Value::as_str).filter(|s| !s.is_empty()) {
                return Ok(format!("Source/worktree evidence: last recorded shell directory: {}. This is recorded input, not a verified current checkout; verify its source SHA before continuing.\n\n", recovery_label(dir)));
            }
        }
    }
    Ok("Source/worktree evidence: no shell directory or source SHA was retained in the recent rows. Recover the exact checkout/SHA from the live docket, breadcrumbs or saved commands before changing source.\n\n".into())
}

#[nolog]
async fn superior_hint(client: &Client, agent_id: i64) -> Result<String> {
    let rows = client.query(
        "SELECT m.uid, m.sender, m.created_at::text, left(m.body, 2000) FROM ot.mail m
         JOIN ot.agents a ON a.id = $1
         WHERE m.recipient_agent_id = a.id AND m.org_id = a.org_id AND m.state <> 'retracted'
           AND ((a.parent_id IS NOT NULL AND m.sender_agent_id = a.parent_id)
             OR (a.parent_id IS NULL AND m.sender = '@user'))
         ORDER BY m.id DESC LIMIT 3", &[&agent_id],
    ).await?;
    let mut out = String::from("Last messages from your current superior (newest first; excerpts, fetch by id for full context):\n");
    for row in rows {
        let (uid, sender, at, body): (String, String, String, String) = (row.get(0), row.get(1), row.get(2), row.get(3));
        out.push_str(&format!("- {uid} · {sender} · {at}: {body}\n"));
    }
    out.push('\n');
    Ok(out)
}

/// What a fresh session starts with when the agent's earlier session could
/// not be carried over: its last status, whom it corresponded with, its
/// recent conversation, and where the whole earlier conversation is saved.
#[nolog] // contains raw command and correspondence excerpts
pub async fn handoff_note(client: &Client, agent_id: i64, why: &str, saved: Option<&std::path::Path>) -> Result<String> {
    let mut note = format!(
        "[Orgtree] You now run on a fresh session ({why}), so your earlier conversation is not in your context. \
         Here is what you were working on.\n\n"
    );
    note.push_str(&docket_hint(client, agent_id).await);
    note.push_str(&source_hint(client, agent_id).await?);
    note.push_str(&superior_hint(client, agent_id).await?);
    note.push_str("Older context follows. Current live docket scope and the superior's latest directions above take precedence over stale tasks in this history.\n\n");
    note.push_str(
        "Read breadcrumbs.md in your working folder first, if you kept one: it is your own log of what was decided, \
         what is in flight and where things are.\n\n",
    );
    note.push_str(&recall_hint(client, agent_id).await);
    let status: Option<Value> = client
        .query_opt("SELECT last_status FROM ot.agents WHERE id = $1", &[&agent_id])
        .await?
        .and_then(|r| r.get(0));
    if let Some(s) = status.as_ref().and_then(|s| s.get("summary")).and_then(Value::as_str) {
        note.push_str(&format!("Your last status: {s}\n\n"));
    }
    note.push_str(&standing_request(client, agent_id).await?);
    note.push_str(&digest(client, agent_id, 60).await?);
    if let Some(p) = saved {
        note.push_str(&format!(
            "\nYour whole earlier conversation is saved at {}; read it when you need more than this summary.\n",
            p.display()
        ));
    }
    Ok(note)
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
#[nolog]
pub fn tool_arg(_name: &str, input: &Value) -> String {
    // a call's own human-readable `description` is the line when it has one
    // (user 2026-10-08); otherwise the most identifying argument IS the line
    // (`Bash ls /e/…`): the first of these that is a non-empty string, else
    // any string, whitespace collapsed and at most 90 characters — never the
    // input dumped as JSON
    let Some(o) = input.as_object() else { return String::new() };
    let flat = |s: &str| -> String { s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(90).collect() };
    for k in ["description", "command", "file_path", "path", "pattern", "query", "url", "prompt", "name", "text", "to", "body"] {
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

/// The agents and the watchdog an Orgtree tool call concerns, for the links the
/// transcript draws beside the call: `[{"kind":"agent","id":..}, {"kind":
/// "watchdog","id":..}]`, in call order, no duplicates. Names come from the
/// call's own arguments (the new agent of a hire too); a watchdog's id from the
/// `id` argument, else from the result a `create` returns. `user`, `@org:` and
/// `@net:` addresses are not agents and are left out. Docket tickets come as
/// `{"kind":"ticket","id":slug}`: the `slug` argument of orgtree_work and
/// orgtree_staff (not a list call), else the slug a create returned; the
/// `work_item` of orgtree_ask (also per question tab), orgtree_hire, orgtree_rehire.
/// Empty for any other tool.
#[nolog]
pub fn tool_refs(name: &str, input: &Value, result: Option<&str>) -> Value {
    let base = name.rsplit("__").next().unwrap_or(name);
    let mut refs: Vec<Value> = Vec::new();
    let mut agent = |v: &Value| {
        if let Some(a) = v.as_str().map(str::trim) {
            if !a.is_empty() && a != "user" && !a.starts_with('@') && !refs.iter().any(|r| r["kind"] == "agent" && r["id"] == a) {
                refs.push(json!({ "kind": "agent", "id": a }));
            }
        }
    };
    let args = |keys: &[&str], agent: &mut dyn FnMut(&Value)| {
        for k in keys {
            match &input[*k] {
                Value::Array(a) => a.iter().for_each(|v| agent(v)),
                v => agent(v),
            }
        }
    };
    match base {
        "orgtree_message" | "orgtree_send_notice" => {
            args(&["to"], &mut agent);
            // the split shape (2026-10-13): `to` inside `metadata`
            match &input["metadata"]["to"] {
                Value::Array(a) => a.iter().for_each(&mut agent),
                v => agent(v),
            }
        }
        "orgtree_retool" | "orgtree_retire" | "orgtree_dissolve" | "orgtree_interrupt" | "orgtree_unstick" | "orgtree_continue_on"
        | "orgtree_cheap_compact" | "orgtree_switch_model" | "orgtree_read_transcript" | "orgtree_read_scratch" | "orgtree_rename"
        | "orgtree_reallocate" | "orgtree_rehire" | "orgtree_halt" | "orgtree_unhalt" => args(&["node", "nodes"], &mut agent),
        "orgtree_move" => {
            args(&["node", "new_parent"], &mut agent);
            for m in input["moves"].as_array().into_iter().flatten() {
                args_of(m, &["node", "new_parent"], &mut agent);
            }
        }
        "orgtree_swap" => args(&["a", "b"], &mut agent),
        "orgtree_hire" | "orgtree_staff" => args(&["name", "node"], &mut agent),
        "orgtree_audience" => args(&["from", "grantee"], &mut agent),
        "orgtree_work" => match input["action"].as_str() {
            Some("assign") | Some("create") => args(&["owner"], &mut agent),
            Some("handoff") => args(&["target"], &mut agent),
            _ => {}
        },
        "orgtree_watchdog" => {
            if input["kind"] == "activity" {
                args(&["target"], &mut agent);
            }
            let id = input["id"].as_str().map(str::to_string).or_else(|| {
                if input["action"] != "create" { return None; }
                let v: Value = serde_json::from_str(result?.trim()).ok()?;
                v["id"].as_str().map(str::to_string)
            });
            if let Some(id) = id.filter(|i| !i.trim().is_empty()) {
                refs.push(json!({ "kind": "watchdog", "id": id.trim() }));
            }
        }
        _ => {}
    }
    // the docket tickets the call names: `slug` (orgtree_work, orgtree_staff), `work_item` (orgtree_ask, also per
    // question tab; orgtree_hire), else the slug a create returned. A list call names none.
    let mut ticket = |v: &Value| {
        if let Some(t) = v.as_str().map(str::trim) {
            if !t.is_empty() && !refs.iter().any(|r| r["kind"] == "ticket" && r["id"] == t) {
                refs.push(json!({ "kind": "ticket", "id": t }));
            }
        }
    };
    match base {
        "orgtree_work" | "orgtree_staff" if input["action"] != "list" => {
            ticket(&input["slug"]);
            if input["slug"].as_str().map_or(true, |s| s.trim().is_empty()) && input["action"] != "get" {
                if let Some(v) = result.and_then(|r| serde_json::from_str::<Value>(r.trim()).ok()) {
                    for k in ["slug", "created", "work_item"] {
                        if v[k].is_string() { ticket(&v[k]); break; }
                    }
                }
            }
        }
        "orgtree_ask" | "orgtree_hire" | "orgtree_rehire" => {
            ticket(&input["work_item"]);
            for q in input["questions"].as_array().into_iter().flatten() {
                ticket(&q["work_item"]);
            }
        }
        _ => {}
    }
    // A successful docket mutation records its actual locked before-state.
    // Every provider already calls this with the uncut result before storing
    // the row, so the small transition survives clipping and chat reloads.
    if base == "orgtree_work" && !matches!(input["action"].as_str(), Some("get" | "list")) {
        if let Some(v) = result.and_then(|r| serde_json::from_str::<Value>(r.trim()).ok()) {
            let slug = ["updated", "superseded", "assigned"].iter().find_map(|k| v[*k].as_str());
            if let (Some(slug), Some(from), Some(to)) = (slug, v["previous_status"].as_str(), v["status"].as_str()) {
                let statuses = crate::domain::docket::STATUSES;
                if v["isError"] != true && v["error"].is_null() && from != to && statuses.contains(&from) && statuses.contains(&to) {
                    // Use the result's identity, never a later docket lookup.
                    if let Some(r) = refs.iter_mut().find(|r| r["kind"] == "ticket" && r["id"] == slug) {
                        r["status_change"] = json!({ "from": from, "to": to });
                    } else if !slug.is_empty() {
                        refs.push(json!({ "kind": "ticket", "id": slug, "status_change": { "from": from, "to": to } }));
                    }
                }
            }
        }
    }
    Value::Array(refs)
}

#[nolog]
fn args_of(v: &Value, keys: &[&str], agent: &mut dyn FnMut(&Value)) {
    for k in keys {
        agent(&v[*k]);
    }
}

/// A chip argument written by alpha.0/alpha.1 (the input dumped as JSON, cut
/// at 300 characters) as the one-line argument `tool_arg` gives today; None
/// when the argument is not such a dump.
#[logged]
pub fn repair_arg(name: &str, arg: &str) -> Option<String> {
    let t = arg.trim();
    if !t.starts_with('{') {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(tool_arg(name, &v));
    }
    // cut short: the string pairs that survived, in order
    static PAIR: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#""([A-Za-z_][A-Za-z0-9_]*)":"((?:[^"\\]|\\.)*)""#).unwrap());
    let mut o = serde_json::Map::new();
    for c in PAIR.captures_iter(t) {
        let v: String = serde_json::from_str(&format!("\"{}\"", &c[2])).unwrap_or_else(|_| c[2].to_string());
        o.entry(c[1].to_string()).or_insert(Value::String(v));
    }
    Some(tool_arg(name, &Value::Object(o)))
}

/// Once, in the background: rewrite the chip arguments alpha.0/alpha.1 wrote
/// as JSON dumps (desk rows keep their text; only the argument changes).
#[logged]
pub async fn repair_old_args(engine: std::sync::Arc<crate::engine::Engine>) {
    const MARK: &str = "convo_tool_args_v1";
    let run = async {
        let client = engine.db.get().await?;
        if client.query_opt("SELECT 1 FROM ot.meta WHERE key = $1", &[&MARK]).await?.is_some() {
            return anyhow::Ok(0usize);
        }
        let rows = client
            .query(
                r#"SELECT agent_id, seq, body FROM ot.convo
                    WHERE body @? '$.tools[*].arg ? (@ starts with "{")'"#,
                &[],
            )
            .await?;
        let mut fixed = 0usize;
        let mut failed = false;
        for r in &rows {
            let (agent_id, seq): (i64, i64) = (r.get(0), r.get(1));
            let mut body: Value = r.get(2);
            let mut changed = false;
            if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
                for t in tools.iter_mut() {
                    let name = t["name"].as_str().unwrap_or("").to_string();
                    let Some(arg) = t["arg"].as_str().map(str::to_string) else { continue };
                    if let Some(new) = repair_arg(&name, &arg) {
                        t["arg"] = Value::String(new);
                        changed = true;
                    }
                }
            }
            if changed {
                crate::util::pg_json_mut(&mut body);
                match client.execute("UPDATE ot.convo SET body = $3 WHERE agent_id = $1 AND seq = $2", &[&agent_id, &seq, &body]).await {
                    Ok(_) => fixed += 1,
                    Err(e) => { failed = true; tracing::warn!(agent=agent_id, seq, error=%e, "tool-chip repair row failed; continuing batch"); }
                }
            }
        }
        if failed { anyhow::bail!("one or more tool-chip repairs failed; retried next start"); }
        client
            .execute(
                "INSERT INTO ot.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
                &[&MARK, &json!({ "rows": fixed })],
            )
            .await?;
        Ok(fixed)
    };
    match run.await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "old tool-chip arguments rewritten as one line"),
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "old tool-chip arguments could not be rewritten (retried next start)"),
    }
}

/// At start, before any harness runs: a compaction row the engine left
/// `running` (it crashed or was killed mid-compaction) becomes `interrupted`,
/// with no end time, so no desk row ticks for a compaction nobody is running.
#[logged]
pub async fn close_open_compactions(engine: &std::sync::Arc<crate::engine::Engine>) {
    let run = async {
        let client = engine.db.get().await?;
        let n = client
            .execute(
                r#"UPDATE ot.convo SET body = body || '{"text":"Context compaction interrupted","compact_state":"interrupted"}'::jsonb
                    WHERE body @> '{"kind":"compact","compact_state":"running"}'"#,
                &[],
            )
            .await?;
        anyhow::Ok(n)
    };
    match run.await {
        Ok(0) => {}
        Ok(n) => tracing::info!(rows = n, "compaction rows left running by the last engine closed as interrupted"),
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "open compaction rows could not be closed"),
    }
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
    let tool_id = crate::util::pg_text(tool_id);
    for (i, (media, data)) in images.into_iter().enumerate() {
        let media = crate::util::pg_text(&media);
        if let Err(e) = client.execute(
            "INSERT INTO ot.tool_images (agent_id, tool_id, idx, media, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            &[&agent_id, &tool_id.as_ref(), &(i as i32), &media.as_ref(), &data],
        ).await {
            tracing::warn!(agent=agent_id, index=i, error=%e, "tool image failed; continuing batch");
        }
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

#[cfg(test)]
mod tool_refs_tests {
    use super::tool_refs;
    use serde_json::json;

    #[test]
    fn message_names_agents_not_the_user_or_addresses() {
        let r = tool_refs("mcp__orgtree__orgtree_message", &json!({ "to": "alice", "body": "x" }), None);
        assert_eq!(r, json!([{ "kind": "agent", "id": "alice" }]));
        assert_eq!(tool_refs("orgtree_message", &json!({ "to": "user" }), None), json!([]));
        assert_eq!(tool_refs("orgtree_message", &json!({ "to": "@org:other" }), None), json!([]));
    }

    #[test]
    fn the_split_message_shape_names_its_agents_too() {
        let input = json!({ "metadata": { "to": ["bob", "user", "@net:x.y"], "kind": "message" }, "body": "x" });
        assert_eq!(tool_refs("mcp__orgtree__orgtree_message", &input, None), json!([{ "kind": "agent", "id": "bob" }]));
        let notice = json!({ "metadata": { "to": "carol" }, "body": "x" });
        assert_eq!(tool_refs("orgtree_send_notice", &notice, None), json!([{ "kind": "agent", "id": "carol" }]));
    }

    #[test]
    fn several_agents_and_no_duplicates() {
        let r = tool_refs("orgtree_halt", &json!({ "node": "a", "nodes": ["b", "a", "c"] }), None);
        assert_eq!(r, json!([{ "kind": "agent", "id": "a" }, { "kind": "agent", "id": "b" }, { "kind": "agent", "id": "c" }]));
    }

    #[test]
    fn watchdog_id_from_the_argument_or_the_create_result() {
        let r = tool_refs("orgtree_watchdog", &json!({ "action": "pause", "id": "build-watch" }), None);
        assert_eq!(r, json!([{ "kind": "watchdog", "id": "build-watch" }]));
        let created = tool_refs("orgtree_watchdog", &json!({ "action": "create", "name": "x" }), Some(r#"{"id":"x","status":"armed"}"#));
        assert_eq!(created, json!([{ "kind": "watchdog", "id": "x" }]));
        assert_eq!(tool_refs("orgtree_watchdog", &json!({ "action": "create" }), None), json!([]));
        assert_eq!(tool_refs("orgtree_watchdog", &json!({ "action": "list" }), None), json!([]));
    }

    #[test]
    fn tickets_from_the_slug_the_work_item_or_the_create_result() {
        let r = tool_refs("mcp__orgtree__orgtree_work", &json!({ "action": "update", "slug": "fix-x", "owner": "bob" }), None);
        assert_eq!(r, json!([{ "kind": "ticket", "id": "fix-x" }]));
        let c = tool_refs("orgtree_work", &json!({ "action": "create", "title": "T" }), Some(r#"{"created":"t-1","slug":"t-1","rev":1}"#));
        assert_eq!(c, json!([{ "kind": "ticket", "id": "t-1" }]));
        assert_eq!(tool_refs("orgtree_work", &json!({ "action": "list" }), Some(r#"{"slug":"zz"}"#)), json!([]));
        assert_eq!(tool_refs("orgtree_staff", &json!({ "action": "update", "slug": "s-1", "name": "n" }), None),
            json!([{ "kind": "agent", "id": "n" }, { "kind": "ticket", "id": "s-1" }]));
        assert_eq!(tool_refs("orgtree_ask", &json!({ "work_item": "a", "questions": [{ "work_item": "b" }, { "work_item": "a" }] }), None),
            json!([{ "kind": "ticket", "id": "a" }, { "kind": "ticket", "id": "b" }]));
    }

    #[test]
    fn other_tools_have_no_refs() {
        assert_eq!(tool_refs("Bash", &json!({ "command": "ls" }), None), json!([]));
        assert_eq!(tool_refs("orgtree_work", &json!({ "action": "update" }), None), json!([]));
    }

    #[test]
    fn work_status_change_uses_the_successful_result_and_survives_serialization() {
        for (action, key, from, to) in [
            ("update", "updated", "in_progress", "blocked"),
            ("accept", "updated", "blocked", "done"),
            ("update", "updated", "done", "in_progress"),
            ("update", "updated", "in_progress", "dropped"),
            ("supersede", "superseded", "open", "superseded"),
        ] {
            let mut out = json!({ "previous_status": from, "status": to });
            out[key] = json!("fix-x");
            let refs = tool_refs("mcp__orgtree__orgtree_work", &json!({ "action": action, "slug": "fix-x" }), Some(&out.to_string()));
            let stored: serde_json::Value = serde_json::from_str(&refs.to_string()).unwrap();
            assert_eq!(stored, json!([{ "kind": "ticket", "id": "fix-x", "status_change": { "from": from, "to": to } }]));
        }
    }

    #[test]
    fn work_status_change_excludes_unproven_noop_malformed_and_refused_results() {
        let input = json!({ "action": "update", "slug": "fix-x", "status": "done", "previous_status": "blocked" });
        for out in [
            None, Some("orgtree_work: refused"), Some("{}"),
            Some(r#"{"updated":"fix-x","status":"done"}"#),
            Some(r#"{"updated":"fix-x","previous_status":"done","status":"done"}"#),
            Some(r#"{"updated":"fix-x","previous_status":"bogus","status":"done"}"#),
            Some(r#"{"updated":"fix-x","previous_status":"blocked","status":"bogus"}"#),
            Some(r#"{"updated":"fix-x","previous_status":"blocked","status":"done","isError":true}"#),
            Some(r#"{"updated":"fix-x","previous_status":"blocked","status":"done","error":"refused"}"#),
            Some(r#"{"archived":"fix-x"}"#),
        ] {
            assert_eq!(tool_refs("orgtree_work", &input, out), json!([{ "kind": "ticket", "id": "fix-x" }]));
        }
    }

    #[test]
    fn work_status_change_does_not_leak_to_reads_or_other_tools() {
        let out = r#"{"updated":"fix-x","previous_status":"blocked","status":"done"}"#;
        assert_eq!(tool_refs("orgtree_work", &json!({ "action": "get", "slug": "fix-x" }), Some(out)), json!([{ "kind": "ticket", "id": "fix-x" }]));
        assert_eq!(tool_refs("orgtree_work", &json!({ "action": "list" }), Some(out)), json!([]));
        assert_eq!(tool_refs("orgtree_staff", &json!({ "action": "update", "slug": "fix-x" }), Some(out)), json!([{ "kind": "ticket", "id": "fix-x" }]));
    }
}
