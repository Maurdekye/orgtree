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
    /// Materialized registry files for this actor's selected skills.
    skill_files: std::collections::BTreeMap<String, std::path::PathBuf>,
}

#[cfg(test)]
mod agy_thinking_pg_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    struct VerboseReset(bool);
    impl Drop for VerboseReset {
        fn drop(&mut self) { crate::trace::set_verbose(self.0); }
    }

    /// The author runner supplies a newly initialized disposable cluster. This
    /// test never falls back to the application's DB or an ambient PG URL.
    #[tokio::test]
    #[ignore = "requires the isolated AGY thinking author fixture"]
    async fn agy_thinking_receipts_survive_reload_and_rollback_atomically() {
        let url=std::env::var("ORGTREE_AGY_THINKING_TEST_URL").expect("synthetic fixture URL required");
        let cfg: tokio_postgres::Config=url.parse().unwrap();
        assert_eq!(cfg.get_dbname(),Some("agy_thinking_fixture"));
        assert_eq!(cfg.get_user(),Some("agy_thinking_fixture"));
        let capture = Capture(Arc::new(Mutex::new(Vec::new())));
        let (dispatch, log_guard) = crate::trace::test_sink(capture.clone());
        let subscriber = tracing::dispatcher::set_default(&dispatch);
        let _verbose = VerboseReset(crate::trace::set_verbose(true));
        // Positive control: verbose instrumentation and the real EngineLayer
        // must both run, otherwise an empty capture would give a vacuous pass.
        assert_eq!(parse_after("1:1"), Some((1,1)));
        let (mut client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
        let connection=tokio::spawn(async move { connection.await.unwrap(); });
        client.batch_execute("CREATE SCHEMA ot;
            CREATE TABLE ot.agents(id bigint PRIMARY KEY);
            INSERT INTO ot.agents VALUES (1);
            CREATE TABLE ot.convo(agent_id bigint,seq bigint,ver bigint,body jsonb CHECK(NOT body ? 'synthetic_reject'),tool_inputs jsonb,PRIMARY KEY(agent_id,seq));").await.unwrap();
        client.batch_execute(include_str!("../../migrations/0028_agy_thinking.sql")).await.unwrap();
        let session="12345678-1234-4321-8765-123456789abc";
        const THOUGHT: &str = "AGYTHINK_CANARY_6fc2";
        const RESPONSE: &str = "AGYRESP_CANARY_3c17";
        let rows=||crate::runtime::agy_thinking::rows(session,6,Some(THOUGHT),RESPONSE,"now");
        let mut writer=ConvoWriter::load(&client,1).await.unwrap();
        let (saved,response)=writer.append_agy_step(&mut client,session,6,rows()).await.unwrap();
        assert!(response);
        let saved=saved.unwrap();
        assert_eq!(saved.len(),2); assert_eq!(saved[0].1["thinking"],THOUGHT);
        assert_eq!(saved[1].1["text"],RESPONSE); assert!(saved[0].0<saved[1].0);
        let (saved,response)=writer.append_agy_step(&mut client,session,6,rows()).await.unwrap();
        assert!(saved.is_none() && response);
        let mut writer=ConvoWriter::load(&client,1).await.unwrap(); // actor/engine restart
        let (saved,response)=writer.append_agy_step(&mut client,session,6,Vec::new()).await.unwrap();
        assert!(saved.is_none() && response); // no replayed delta is needed
        assert_eq!((writer.seq,writer.ver),(2,2));
        let mut failed=rows(); failed[1]["synthetic_reject"]=json!(true);
        let failed=writer.append_agy_step(&mut client,session,7,failed).await.unwrap_err();
        assert!(!format!("{failed:?}").contains(THOUGHT));
        assert!(!format!("{failed:?}").contains(RESPONSE));
        assert_eq!((writer.seq,writer.ver),(2,2));
        let receipt:i64=client.query_one("SELECT count(*) FROM ot.agy_step_receipts WHERE step_index=7",&[]).await.unwrap().get(0);
        assert_eq!(receipt,0);
        let count:i64=client.query_one("SELECT count(*) FROM ot.convo",&[]).await.unwrap().get(0); assert_eq!(count,2);
        assert!(writer.append_agy_step(&mut client,session,7,rows()).await.unwrap().0.is_some());
        let other="abcdefab-1234-4321-8765-123456789abc";
        assert!(writer.append_agy_step(&mut client,other,6,rows()).await.unwrap().0.is_some());
        assert_eq!((writer.seq,writer.ver),(6,6));
        // stamp is also called by ordinary append/update. Their content stays
        // private, while identity stamping and persisted updates stay intact.
        let mut ordinary = rows().remove(0);
        let seq = writer.append(&client, ordinary.clone()).await.unwrap();
        let before_update = (writer.ver, writer.seq);
        ordinary["text"] = json!(RESPONSE);
        writer.update(&client, seq, ordinary).await.unwrap();
        let body: Value = client.query_one("SELECT body FROM ot.convo WHERE agent_id=1 AND seq=$1", &[&seq])
            .await.unwrap().get(0);
        assert_eq!(body["thinking"], THOUGHT);
        assert_eq!(body["text"], RESPONSE);
        assert_eq!(body["seq"], seq);
        assert_eq!(body["row_id"], format!("r{seq}"));
        assert_eq!(body["event_id"], format!("e{seq}"));
        // Opening and refreshing a desk must not re-serialize the persisted
        // thought into verbose logs via read/restore helper arguments/returns.
        let page = read(&client, 1, 300, None, None).await.unwrap();
        assert_eq!(page.messages.len(), 7);
        assert!(page.messages.iter().any(|row| row["thinking"] == THOUGHT));
        assert!(page.messages.iter().any(|row| row["text"] == RESPONSE));
        assert_eq!(page.after, format!("{}:{}", writer.ver, writer.seq));
        let updates = read(&client, 1, 300, None, Some(before_update)).await.unwrap();
        assert!(updates.incremental && updates.messages.is_empty());
        assert_eq!(updates.updates.len(), 1);
        assert_eq!(updates.updates[0]["thinking"], THOUGHT);
        assert_eq!(updates.updates[0]["text"], RESPONSE);
        drop(client); connection.await.unwrap();
        drop(subscriber);
        drop(dispatch);
        drop(log_guard); // drain the actual non-blocking engine log writer
        let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        if let Ok(path) = std::env::var("ORGTREE_AGY_THINKING_TRACE_PATH") {
            std::fs::write(path, &log).unwrap();
        }
        assert!(log.contains("runtime.convo.parse_after("), "verbose log positive control did not run");
        assert!(!log.contains(THOUGHT), "thinking canary leaked through the real transcript write/read chain");
        assert!(!log.contains(RESPONSE), "response canary leaked through the real transcript write/read chain");
    }
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
        Ok(ConvoWriter { agent_id, seq: r.get(0), ver: r.get(1), pending: Default::default(), skill_files: Default::default() })
    }

    #[nolog]
    pub fn set_skill_registry(&mut self, registry: &crate::providers::skills::Registry, data_root: &std::path::Path) {
        let root = registry.snapshot_path(data_root);
        self.skill_files = registry.names().into_iter().filter_map(|name| {
            registry.materialized_skill_file(&root, &name).map(|path| (name, path))
        }).collect();
    }

    /// Append a row; returns its seq. `body` gets its identity fields filled.
    #[nolog]
    pub async fn append(&mut self, client: &Client, mut body: Value) -> Result<i64> {
        self.seq += 1;
        self.ver += 1;
        let seq = self.seq;
        stamp(&mut body, seq);
        body["convo_revision"] = json!(self.ver);
        let inputs = take_tool_inputs_with_skill_files(&mut body, seq, &self.skill_files);
        client
            .execute(
                "INSERT INTO ot.convo (agent_id, seq, ver, body, tool_inputs) VALUES ($1, $2, $3, $4, $5)",
                &[&self.agent_id, &seq, &self.ver, &body, &inputs],
            )
            .await?;
        self.remember(seq, body);
        Ok(seq)
    }

    /// Commit a completed AGY step exactly once, including after actor/engine
    /// restart. A rollback leaves both the receipt and all rows absent.
    #[nolog]
    pub async fn append_agy_step(&mut self, client: &mut Client, session: &str, index: i64, rows: Vec<Value>) -> Result<(Option<Vec<(i64, Value)>>, bool)> {
        // PG errors can carry a failing row in their detail. Do not propagate
        // that diagnostic through the actor's ordinary error logging.
        let redact = |_| anyhow::anyhow!("AGY transcript transaction failed");
        let tx = client.transaction().await.map_err(redact)?;
        let response=rows.iter().any(|r|r["text"].as_str().is_some_and(|s|!s.trim().is_empty()));
        let inserted = tx.execute(
            "INSERT INTO ot.agy_step_receipts (agent_id,session_id,step_index,has_response) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            &[&self.agent_id,&session,&index,&response],
        ).await.map_err(redact)?;
        if inserted==0 {
            let response:bool=tx.query_one("SELECT has_response FROM ot.agy_step_receipts WHERE agent_id=$1 AND session_id=$2 AND step_index=$3",
                &[&self.agent_id,&session,&index]).await.map_err(redact)?.get(0);
            return Ok((None,response));
        }
        let (mut seq,mut ver)=(self.seq,self.ver);
        let mut saved=Vec::with_capacity(rows.len());
        for mut body in rows {
            seq+=1; ver+=1;
            stamp(&mut body,seq);
            body["convo_revision"]=json!(ver);
            let inputs=take_tool_inputs_with_skill_files(&mut body,seq,&self.skill_files);
            tx.execute("INSERT INTO ot.convo (agent_id,seq,ver,body,tool_inputs) VALUES ($1,$2,$3,$4,$5)",
                &[&self.agent_id,&seq,&ver,&body,&inputs]).await.map_err(redact)?;
            saved.push((seq,body));
        }
        tx.commit().await.map_err(redact)?;
        self.seq=seq; self.ver=ver;
        for (seq,body) in &saved { self.remember(*seq,body.clone()); }
        Ok((Some(saved),response))
    }

    #[nolog]
    pub async fn update(&mut self, client: &Client, seq: i64, mut body: Value) -> Result<()> {
        self.ver += 1;
        stamp(&mut body, seq);
        body["convo_revision"] = json!(self.ver);
        let inputs = take_tool_inputs_with_skill_files(&mut body, seq, &self.skill_files);
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

    /// Detect the first `@user` mention in pending assistant rows for this turn,
    /// or a refined blurb for the same `seq` row as streaming text arrives.
    #[nolog]
    pub fn pending_user_mention(&self, already: Option<&(i64, String)>) -> Option<(i64, String)> {
        if let Some((seq, prev_blurb)) = already {
            let body = self.pending.get(seq)?;
            if body["role"].as_str() != Some("assistant") {
                return None;
            }
            let blurb = user_mention_blurb(body["text"].as_str().unwrap_or(""))?;
            return (blurb != *prev_blurb).then_some((*seq, blurb));
        }
        for (seq, body) in &self.pending {
            if body["role"].as_str() != Some("assistant") {
                continue;
            }
            if let Some(blurb) = user_mention_blurb(body["text"].as_str().unwrap_or("")) {
                return Some((*seq, blurb));
            }
        }
        None
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

/// Extract a centered cut-out blurb around the first standalone `@user` token.
#[nolog]
pub fn user_mention_blurb(text: &str) -> Option<String> {
    let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    let token = "@user";
    let mut search_from = 0;
    let mut found_idx = None;
    while let Some(rel) = clean[search_from..].find(token) {
        let idx = search_from + rel;
        let prev_ok = if idx == 0 {
            true
        } else {
            let prev = clean[..idx].chars().next_back().unwrap_or(' ');
            !prev.is_ascii_alphanumeric() && !matches!(prev, '_' | '@' | '.' | '/' | ':' | '-')
        };
        let after_idx = idx + token.len();
        let next_ok = if after_idx >= clean.len() {
            true
        } else {
            let next = clean[after_idx..].chars().next().unwrap_or(' ');
            !next.is_ascii_alphanumeric() && !matches!(next, '_' | '-')
        };
        if prev_ok && next_ok {
            found_idx = Some(idx);
            break;
        }
        search_from = idx + 1;
    }
    let idx = found_idx?;
    const SIDE_CHARS: usize = 48;
    let before_chars: Vec<char> = clean[..idx].chars().collect();
    let after_chars: Vec<char> = clean[idx + token.len()..].chars().collect();
    let before_start = before_chars.len().saturating_sub(SIDE_CHARS);
    let after_end = after_chars.len().min(SIDE_CHARS);
    let mut out = String::new();
    if before_start > 0 {
        out.push('…');
    }
    out.extend(&before_chars[before_start..]);
    out.push_str(token);
    out.extend(&after_chars[..after_end]);
    if after_end < after_chars.len() {
        out.push('…');
    }
    Some(out)
}

#[cfg(test)]
mod user_mention_tests {
    use super::*;

    #[test]
    fn extracts_first_standalone_user_mention_blurb() {
        assert_eq!(user_mention_blurb("no mention here"), None);
        assert_eq!(user_mention_blurb("email@user.com and @username"), None);
        assert_eq!(
            user_mention_blurb("Heads up @user: the migration finished cleanly."),
            Some("Heads up @user: the migration finished cleanly.".to_string())
        );
        let long_before = "a".repeat(60);
        let long_after = "b".repeat(60);
        let blurb = user_mention_blurb(&format!("{long_before} @user {long_after}")).unwrap();
        assert!(blurb.starts_with('…'));
        assert!(blurb.ends_with('…'));
        assert!(blurb.contains(" @user "));
    }

    #[test]
    fn pending_user_mention_fires_once_per_turn_and_updates_same_seq() {
        let mut w = ConvoWriter {
            agent_id: 1,
            seq: 0,
            ver: 0,
            pending: Default::default(),
            skill_files: Default::default(),
        };
        w.remember(1, json!({"role": "user", "text": "ping @user"}));
        assert_eq!(w.pending_user_mention(None), None);

        w.remember(2, json!({"role": "assistant", "text": "Hello @user"}));
        w.remember(3, json!({"role": "assistant", "text": "Second @user in turn"}));
        let first = w.pending_user_mention(None).unwrap();
        assert_eq!(first.0, 2);
        assert_eq!(first.1, "Hello @user");

        // Same seq without change returns None; later seq 3 is ignored.
        assert_eq!(w.pending_user_mention(Some(&first)), None);

        // Streaming update to seq 2 refines the blurb.
        w.remember(2, json!({"role": "assistant", "text": "Hello @user, build is green."}));
        let updated = w.pending_user_mention(Some(&first)).unwrap();
        assert_eq!(updated, (2, "Hello @user, build is green.".to_string()));
    }
}

/// Atomically retained with the row, but never included in `/chat` or feeds.
#[nolog]
pub fn take_tool_inputs(body: &mut Value, seq: i64) -> Value {
    take_tool_inputs_with_skill_files(body, seq, &std::collections::BTreeMap::new())
}

#[nolog]
fn take_tool_inputs_with_skill_files(
    body: &mut Value,
    seq: i64,
    skill_files: &std::collections::BTreeMap<String, std::path::PathBuf>,
) -> Value {
    crate::util::pg_json_mut(body);
    let mut inputs = serde_json::Map::new();
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for chip in tools {
            let Some(id) = chip["id"].as_str().map(str::to_string) else { continue };
            let Some(chip) = chip.as_object_mut() else { continue };
            let mut kept = serde_json::Map::new();
            let paths = chip.get("input").and_then(|input| {
                tool_file_paths_with_skill_files(chip.get("name").and_then(Value::as_str).unwrap_or(""), input, skill_files)
            });
            if let Some(paths) = paths { chip.insert("file_paths".into(), paths); }
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

/// Extract only explicit file arguments from known file tools. Shell command
/// strings are deliberately never inspected. This metadata stays on the public
/// transcript chip while the full input remains in the private tool-input row.
#[nolog]
pub fn tool_file_paths(name: &str, input: &Value) -> Option<Value> {
    let tool = name.rsplit("__").next().unwrap_or(name).to_ascii_lowercase();
    if !matches!(tool.as_str(), "read" | "write" | "edit" | "multiedit" | "multi_edit" | "notebookedit" | "notebook_edit" | "apply_patch"
        | "read_file" | "write_file" | "edit_file" | "view_file" | "replace_file_content" | "create_file"
        | "readfile" | "writefile" | "editfile" | "viewfile" | "skill" | "read_skill") {
        return None;
    }

    fn collect(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for key in ["file_path", "filePath", "filepath", "path", "notebook_path", "notebookPath", "target_file", "targetFile"] {
                    if let Some(path) = map.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        if !out.iter().any(|old| old == path) { out.push(path.to_owned()); }
                    }
                }
                // Codex's structured patch carries every changed path here.
                if let Some(changes) = map.get("changes").and_then(Value::as_array) {
                    for change in changes { collect(change, out); }
                }
            }
            Value::Array(items) => for item in items { collect(item, out); },
            _ => {}
        }
    }

    let mut paths = Vec::new();
    collect(input, &mut paths);
    // Skill tools often identify the skill by its directory or SKILL.md path.
    // Do not guess from a display name alone; ordinary Read calls that carry
    // the resolved SKILL.md path are handled by the normal explicit path fields.
    if matches!(tool.as_str(), "skill" | "read_skill") {
        paths.retain(|path| path.ends_with("SKILL.md"));
        for key in ["skill_path", "skillPath", "path", "file_path", "filePath"] {
            if let Some(path) = input.get(key).and_then(Value::as_str) {
                if path.ends_with("SKILL.md") && !paths.iter().any(|old| old == path) {
                    paths.push(path.to_owned());
                }
            }
        }
    }
    if paths.is_empty() { return None; }
    let cwd = ["cwd", "working_directory", "workingDirectory"]
        .iter().find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(std::path::PathBuf::from).filter(|p| p.is_absolute());
    let result: Vec<Value> = paths.into_iter().map(|raw| {
        let path = std::path::Path::new(&raw);
        let resolved = if path.is_absolute() { Some(path.to_path_buf()) }
            else { cwd.as_ref().map(|cwd| cwd.join(path)) };
        let shown = resolved.as_ref().map(|p| {
            let path = p.to_string_lossy().into_owned();
            if cfg!(windows) { path.replace('/', "\\") } else { path }
        }).unwrap_or(raw);
        let link = resolved.as_ref().is_some_and(|p| p.is_absolute());
        json!({"path":shown,"link":link})
    }).collect();
    Some(json!(result))
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

#[cfg(test)]
mod tool_file_path_tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn extracts_explicit_paths_only_from_file_tools_and_uses_event_cwd() {
        let files = tool_file_paths("Read", &json!({"file_path":"notes/todo.md", "cwd":"C:/agent"})).unwrap();
        assert_eq!(files[0]["path"], "C:\\agent\\notes\\todo.md");
        assert_eq!(files[0]["link"], true);
        let relative = tool_file_paths("Read", &json!({"file_path":"notes/todo.md"})).unwrap();
        assert_eq!(relative[0]["path"], "notes/todo.md");
        assert_eq!(relative[0]["link"], false);
        assert!(tool_file_paths("Bash", &json!({"command":"cat C:/private.txt"})).is_none());
    }

    #[test]
    fn apply_patch_links_each_changed_file_and_skill_links_only_an_explicit_skill_path() {
        let patched = tool_file_paths("apply_patch", &json!({"changes":[{"path":"C:/repo/a.rs"},{"path":"C:/repo/b.rs"}]})).unwrap();
        assert_eq!(patched.as_array().unwrap().len(), 2);
        assert_eq!(patched[1]["path"], "C:\\repo\\b.rs");
        let skill = tool_file_paths("Skill", &json!({"skill":"orgtree-working"}));
        assert!(skill.is_none(), "a name alone is ambiguous and must not become a guessed link");
        assert!(tool_file_paths("Skill", &json!({"path":"C:/shared/orgtree-working"})).is_none(),
            "a skill directory is not the requested SKILL.md file");
        let explicit = tool_file_paths("Skill", &json!({"skill_path":"C:/shared/orgtree-working/SKILL.md"})).unwrap();
        assert_eq!(explicit[0]["path"], "C:\\shared\\orgtree-working\\SKILL.md");
    }

    #[test]
    fn name_only_skill_calls_link_the_unique_materialized_registry_file() {
        let files = BTreeMap::from([(
            "orgtree-working".to_string(),
            std::path::PathBuf::from("C:/data/shared-skills/digest/skills/orgtree-working/SKILL.md"),
        )]);
        let mut row = json!({"tools":[{"id":"call","name":"Skill","input":{"skill":"orgtree-working"}}]});
        take_tool_inputs_with_skill_files(&mut row, 1, &files);
        assert_eq!(row["tools"][0]["file_paths"][0]["path"], "C:\\data\\shared-skills\\digest\\skills\\orgtree-working\\SKILL.md");
        assert_eq!(row["tools"][0]["file_paths"][0]["link"], true);

        let mut missing = json!({"tools":[{"id":"call","name":"Skill","input":{"skill":"orgtree-working"}}]});
        take_tool_inputs_with_skill_files(&mut missing, 1, &BTreeMap::new());
        assert!(missing["tools"][0].get("file_paths").is_none());
        let mut other = json!({"tools":[{"id":"call","name":"Skill","input":{"skill":"other"}}]});
        take_tool_inputs_with_skill_files(&mut other, 1, &files);
        assert!(other["tools"][0].get("file_paths").is_none());
    }
}

#[nolog]
fn tool_file_paths_with_skill_files(
    name: &str,
    input: &Value,
    skill_files: &std::collections::BTreeMap<String, std::path::PathBuf>,
) -> Option<Value> {
    if let Some(paths) = tool_file_paths(name, input) { return Some(paths); }
    let tool = name.rsplit("__").next().unwrap_or(name).to_ascii_lowercase();
    if !matches!(tool.as_str(), "skill" | "read_skill") { return None; }
    let skill_name = ["skill", "skill_name", "skillName", "name"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str).filter(|value| !value.trim().is_empty()))?;
    let path = skill_files.get(skill_name)?;
    tool_file_paths(name, &json!({"skill_path": path.to_string_lossy()}))
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

// All callers pass private transcript content (including recovered thoughts).
// Identity stamping must never serialize its body into verbose engine logs.
#[nolog]
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
// The returned Page contains private transcript text and thinking.
#[nolog]
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
// The mutable rows can contain thoughts even when no mail notice needs repair.
#[nolog]
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

    #[test]
    fn batched_mail_rows_keep_each_sender_in_recovery_views() {
        let body = json!({
            "role": "user",
            "ts": "batch-time",
            "text": "agent notice\n\nuser reply",
            "segments": [{ "kind": "mail", "rows": [
                { "from": "coordinator-opus", "body": "agent notice", "at": "notice-time", "notice": true },
                { "from": "@user", "body": "user reply", "at": "reply-time" }
            ]}]
        });
        let entries = recovery_user_entries(&body);
        assert_eq!(entries, vec![
            ("coordinator-opus".to_string(), "notice-time".to_string(), "agent notice".to_string()),
            ("user".to_string(), "reply-time".to_string(), "user reply".to_string()),
        ]);
        assert_eq!(
            recovery_user_entries(&json!({
                "role": "user",
                "ts": "legacy-time",
                "text": "legacy body"
            })),
            vec![(
                "mail".to_string(),
                "legacy-time".to_string(),
                "legacy body".to_string()
            )]
        );
    }
}

/// Split a batched user turn into its individually authored recovery entries.
/// Legacy rows without usable segments retain the previous whole-row view.
#[nolog]
fn recovery_user_entries(body: &Value) -> Vec<(String, String, String)> {
    let message_ts = body["ts"].as_str().unwrap_or("");
    let mut entries = Vec::new();
    if let Some(segments) = body["segments"].as_array() {
        for segment in segments {
            match segment["kind"].as_str().unwrap_or("") {
                "mail" => {
                    if let Some(rows) = segment["rows"].as_array() {
                        for row in rows {
                            let Some(text) = row["body"].as_str() else {
                                continue;
                            };
                            let from = row["from"].as_str().unwrap_or("mail");
                            let from = match from {
                                "@user" | "user" => "user",
                                "@system" | "system" => "system",
                                other => other,
                            };
                            let ts = row["at"].as_str().unwrap_or(message_ts);
                            entries.push((from.to_string(), ts.to_string(), text.to_string()));
                        }
                    }
                }
                "text" => {
                    if let Some(text) = segment["text"].as_str() {
                        entries.push(("user".to_string(), message_ts.to_string(), text.to_string()));
                    }
                }
                "notices" => {
                    if let Some(rows) = segment["rows"].as_array() {
                        for row in rows {
                            let Some(text) = row["text"].as_str().or_else(|| row["body"].as_str()) else {
                                continue;
                            };
                            let from = row["from"].as_str().unwrap_or("system");
                            let from = match from {
                                "@user" | "user" => "user",
                                "@system" | "system" => "system",
                                other => other,
                            };
                            let ts = row["at"].as_str().unwrap_or(message_ts);
                            entries.push((from.to_string(), ts.to_string(), text.to_string()));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if entries.is_empty() {
        let from = body
            .pointer("/segments/0/rows/0/from")
            .and_then(Value::as_str)
            .unwrap_or("mail");
        let from = if from == "@user" { "user" } else { from };
        entries.push((
            from.to_string(),
            message_ts.to_string(),
            body["text"].as_str().unwrap_or("").to_string(),
        ));
    }
    entries
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
        match role {
            "user" => {
                for (from, _, text) in recovery_user_entries(&b) {
                    parts.push(format!("[{from}] {}", crate::util::gist(&text, 1200)));
                }
            }
            "assistant" => {
                let text = crate::util::gist(b["text"].as_str().unwrap_or(""), 1200);
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
                for (from, entry_ts, entry_text) in recovery_user_entries(&b) {
                    let entry_ts = if entry_ts.is_empty() { ts } else { &entry_ts };
                    out.push_str(&format!("## From {from} · {entry_ts}\n\n{entry_text}\n\n"));
                }
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
            if a.starts_with("@net:") || a.starts_with("@org:") {
                if !refs.iter().any(|r| r["kind"] == "hub" && r["id"] == a) {
                    refs.push(json!({ "kind": "hub", "id": a }));
                }
            } else if !a.is_empty() && a != "user" && !a.starts_with('@') && !refs.iter().any(|r| r["kind"] == "agent" && r["id"] == a) {
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
        | "orgtree_reallocate" | "orgtree_halt" | "orgtree_unhalt" => args(&["node", "nodes"], &mut agent),
        "orgtree_reorder" => args(&["node", "nodes", "before", "after"], &mut agent),
        "orgtree_rehire" => args(&["node", "nodes", "parent", "target"], &mut agent),
        "orgtree_project" => args(&["name", "parent"], &mut agent),
        "orgtree_present" | "orgtree_inbox" => args(&["project"], &mut agent),
        "orgtree_move" => {
            args(&["node", "new_parent"], &mut agent);
            for m in input["moves"].as_array().into_iter().flatten() {
                args_of(m, &["node", "new_parent"], &mut agent);
            }
        }
        "orgtree_swap" => args(&["a", "b"], &mut agent),
        "orgtree_hire" => args(&["name", "node", "parent", "target"], &mut agent),
        "orgtree_staff" => args(&["name", "node"], &mut agent),
        "orgtree_audience" => args(&["from", "grantee"], &mut agent),
        "orgtree_work" => {
            match input["action"].as_str() {
                Some("assign") | Some("create") | Some("update") => args(&["owner"], &mut agent),
                Some("handoff") => args(&["target"], &mut agent),
                _ => {}
            }
            args(&["project"], &mut agent);
        }
        "orgtree_watchdog" => {
            if input["kind"] == "activity" || input["kind"] == "fair_queue" {
                args(&["target", "project"], &mut agent);
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
    // The result records the applied model under the mutation's lock. Older
    // results know only the new tier; neither input nor today's tree proves
    // their previous model. Keep this before result clipping for every lane.
    if matches!(base, "orgtree_retool" | "orgtree_switch_model") {
        if let Some(v) = result.and_then(|r| serde_json::from_str::<Value>(r.trim()).ok()) {
            let node = v["node"].as_str().map(str::trim).filter(|s| !s.is_empty() && *s != "user" && !s.starts_with('@'));
            let to = v["tier"].as_str().map(str::trim).filter(|s| !s.is_empty());
            let from = v["previous_tier"].as_str().map(str::trim).filter(|s| !s.is_empty());
            if let (Some(node), Some(to)) = (node, to) {
                if v["isError"] != true && v["error"].is_null() && v["queued"] != true
                    && v["unchanged"] != true && from != Some(to) {
                    let change = json!({ "from": from, "to": to });
                    if let Some(r) = refs.iter_mut().find(|r| r["kind"] == "agent" && r["id"] == node) {
                        r["model_change"] = change;
                    } else {
                        refs.push(json!({ "kind": "agent", "id": node, "model_change": change }));
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

#[cfg(test)]
#[path = "convo_model_tests.rs"]
mod model_change_tests;

#[cfg(test)]
#[path = "convo_work_ref_tests.rs"]
mod timed_work_ref_tests;

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
    fn message_names_agents_and_hub_addresses_not_the_user() {
        let r = tool_refs("mcp__orgtree__orgtree_message", &json!({ "to": "alice", "body": "x" }), None);
        assert_eq!(r, json!([{ "kind": "agent", "id": "alice" }]));
        assert_eq!(tool_refs("orgtree_message", &json!({ "to": "user" }), None), json!([]));
        assert_eq!(
            tool_refs("orgtree_message", &json!({ "to": "@org:other" }), None),
            json!([{ "kind": "hub", "id": "@org:other" }])
        );
    }

    #[test]
    fn the_split_message_shape_names_its_agents_and_hub_addresses_too() {
        let input = json!({ "metadata": { "to": ["bob", "user", "@net:x.y"], "kind": "message" }, "body": "x" });
        assert_eq!(
            tool_refs("mcp__orgtree__orgtree_message", &input, None),
            json!([{ "kind": "agent", "id": "bob" }, { "kind": "hub", "id": "@net:x.y" }])
        );
        let notice = json!({ "metadata": { "to": "carol" }, "body": "x" });
        assert_eq!(tool_refs("orgtree_send_notice", &notice, None), json!([{ "kind": "agent", "id": "carol" }]));
    }

    #[test]
    fn project_tools_name_their_project_nodes() {
        assert_eq!(
            tool_refs("orgtree_project", &json!({ "action": "create", "name": "proj-a", "parent": "coord" }), None),
            json!([{ "kind": "agent", "id": "proj-a" }, { "kind": "agent", "id": "coord" }])
        );
        assert_eq!(
            tool_refs("orgtree_reorder", &json!({ "node": "proj-a", "before": "proj-b" }), None),
            json!([{ "kind": "agent", "id": "proj-a" }, { "kind": "agent", "id": "proj-b" }])
        );
        assert_eq!(
            tool_refs("orgtree_present", &json!({ "action": "send", "project": "proj-a" }), None),
            json!([{ "kind": "agent", "id": "proj-a" }])
        );
        assert_eq!(
            tool_refs("orgtree_inbox", &json!({ "project": "proj-a" }), None),
            json!([{ "kind": "agent", "id": "proj-a" }])
        );
        assert_eq!(
            tool_refs("orgtree_watchdog", &json!({ "action": "create", "name": "q-dog", "kind": "fair_queue", "project": "proj-a" }), Some(r#"{"id":"q-dog","status":"armed"}"#)),
            json!([{ "kind": "agent", "id": "proj-a" }, { "kind": "watchdog", "id": "q-dog" }])
        );
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
        let r = tool_refs("mcp__orgtree__orgtree_work", &json!({ "action": "update", "slug": "fix-x", "owner": "bob", "project": "proj-a" }), None);
        assert_eq!(r, json!([{ "kind": "agent", "id": "bob" }, { "kind": "agent", "id": "proj-a" }, { "kind": "ticket", "id": "fix-x" }]));
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
