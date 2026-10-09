//! orgtree-fakecli: a scripted stand-in for the Claude Code CLI, launched by
//! the engine exactly like the real one (`ORGTREE_CLAUDE_BIN`, set by
//! tools/rig). It speaks stream-json both ways and the control channel
//! (initialize, the in-process `orgtree` MCP server through `mcp_message`,
//! PostToolUse `hook_callback`s, interrupt), and plays a per-agent script.
//!
//! Environment (inherited from the rig's engine):
//!   ORGTREE_FAKECLI_DIR   scenario.json lives here; log/<agent>.jsonl and
//!                         state/<agent>.json are written here
//!   ORGTREE_FAKECLI_HOME  the rig's fake home (session transcripts go under
//!                         <home>/.claude/projects unless CLAUDE_CONFIG_DIR is set)
//!   ORGTREE_AGENT         set by the engine: which agent this process serves
//!
//! The scenario format is documented in docs/rust-engine/test-rig.md.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

mod agy;
mod codex;

const VERSION: &str = "2.1.999 (Claude Code fake)";

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// RFC 3339 UTC timestamp, millisecond precision.
fn iso_now() -> String {
    let ms = now_ms() as i64;
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", tod / 3600, (tod % 3600) / 60, tod % 60)
}

/// Claude Code's folder name for a working directory under `projects/`.
fn project_dir(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

#[derive(Default, Clone, Debug)]
struct Args {
    model: String,
    permission_mode: String,
    resume: Option<String>,
    session_id: Option<String>,
    /// `--fork-session` (with `--resume`): continue on a new session id
    fork: bool,
    max_turns: Option<u32>,
    effort: Option<String>,
    add_dirs: Vec<String>,
    /// `--disallowed-tools`: left out of the tool list, as the CLI does
    disallowed: Vec<String>,
    unknown: Vec<String>,
}

fn parse_args(raw: &[String]) -> Args {
    let mut a = Args { model: "claude-fake".into(), permission_mode: "default".into(), ..Default::default() };
    let mut i = 0;
    while i < raw.len() {
        let k = raw[i].as_str();
        let val = |i: usize| raw.get(i + 1).cloned().unwrap_or_default();
        match k {
            "--model" => { a.model = val(i); i += 1; }
            "--permission-mode" => { a.permission_mode = val(i); i += 1; }
            "--resume" => { a.resume = Some(val(i)); i += 1; }
            "--session-id" => { a.session_id = Some(val(i)); i += 1; }
            "--fork-session" => { a.fork = true; }
            "--max-turns" => { a.max_turns = val(i).parse().ok(); i += 1; }
            "--effort" => { a.effort = Some(val(i)); i += 1; }
            "--add-dir" => { a.add_dirs.push(val(i)); i += 1; }
            "--disallowed-tools" => {
                a.disallowed.extend(val(i).split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string));
                i += 1;
            }
            "--input-format" | "--output-format" | "--append-system-prompt-file" | "--settings" | "--mcp-config"
            | "--allowedTools" => { i += 1; }
            "-p" | "--print" | "--include-partial-messages" | "--verbose" | "--strict-mcp-config" => {}
            other => a.unknown.push(other.to_string()),
        }
        i += 1;
    }
    a
}

enum Msg {
    Init,
    Prompt(String),
    Eof,
}

/// Everything the reader thread and the turn runner share.
struct Cli {
    out: Mutex<std::io::Stdout>,
    log: Mutex<Option<std::fs::File>>,
    waiters: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    /// (hook event, callback id) as `initialize` registered them
    hook_ids: Mutex<Vec<(String, String)>>,
    interrupted: AtomicBool,
    seq: AtomicU64,
    agent: String,
    session: String,
    model: String,
    cwd: PathBuf,
    dir: Option<PathBuf>,
}

impl Cli {
    fn next(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn uuid(&self) -> String {
        let n = self.next();
        let t = now_ms() as u64;
        let p = std::process::id() as u64;
        format!("{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}", (t & 0xffff_ffff) as u32, (p & 0xffff) as u16, (n >> 12) & 0xfff, n & 0xfff, (t >> 8) ^ (p << 20) ^ n)
    }

    fn log(&self, kind: &str, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.insert("ts".into(), json!(iso_now()));
            o.insert("pid".into(), json!(std::process::id()));
            o.insert("kind".into(), json!(kind));
        }
        if let Ok(mut g) = self.log.lock() {
            if let Some(f) = g.as_mut() {
                let _ = writeln!(f, "{v}");
                let _ = f.flush();
            }
        }
    }

    /// One stream-json line to the engine.
    fn send(&self, v: &Value) {
        if let Ok(mut out) = self.out.lock() {
            let _ = writeln!(out, "{v}");
            let _ = out.flush();
        }
        self.log("send", json!({ "line": v }));
    }

    /// A stream line carrying the session id and a uuid.
    fn emit(&self, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.entry("session_id").or_insert(json!(self.session));
            o.entry("uuid").or_insert(json!(self.uuid()));
        }
        self.send(&v);
    }

    fn stream(&self, event: Value) {
        self.emit(json!({ "type": "stream_event", "event": event, "parent_tool_use_id": null }));
    }

    fn respond(&self, request_id: &str, response: Value) {
        self.send(&json!({ "type": "control_response",
                           "response": { "subtype": "success", "request_id": request_id, "response": response } }));
    }

    /// A control request to the engine and its response (None on timeout).
    fn request(&self, request: Value, timeout: Duration) -> Option<Value> {
        let id = format!("fake_{}", self.next());
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id.clone(), tx);
        self.send(&json!({ "type": "control_request", "request_id": id, "request": request }));
        let got = rx.recv_timeout(timeout).ok();
        self.waiters.lock().unwrap().remove(&id);
        if got.is_none() {
            self.log("timeout", json!({ "request_id": id }));
        }
        got
    }

    /// Sleep in small slices; false when an interrupt arrived meanwhile.
    fn pause(&self, ms: u64) -> bool {
        let until = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < until {
            if self.interrupted.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(ms.min(50)));
        }
        !self.interrupted.load(Ordering::SeqCst)
    }

    fn path(&self, sub: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(sub))
    }
}

// ------------------------------------------------------------ scenario

fn load_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn save_json(p: &Path, v: &Value) {
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

fn matches(rule: &Value, prompt: &str) -> bool {
    let low = prompt.to_lowercase();
    let all = |v: &Value| -> bool {
        match v {
            Value::Null => true,
            Value::String(s) => low.contains(&s.to_lowercase()),
            Value::Array(a) => a.iter().filter_map(Value::as_str).all(|s| low.contains(&s.to_lowercase())),
            _ => true,
        }
    };
    let none = |v: &Value| -> bool {
        match v {
            Value::Null => true,
            Value::String(s) => !low.contains(&s.to_lowercase()),
            Value::Array(a) => a.iter().filter_map(Value::as_str).all(|s| !low.contains(&s.to_lowercase())),
            _ => true,
        }
    };
    all(&rule["match"]) && none(&rule["unless"])
}

/// Pick this turn's script: the agent's turns first, then `default`'s, in
/// order; the first whose `match` fits the prompt and whose `times` is not
/// used up. Returns (where it came from, steps).
fn pick(cli: &Cli, prompt: &str) -> (String, Vec<Value>) {
    pick_for(cli.dir.as_deref(), &cli.agent, prompt)
}

/// `pick` for any process kind: the scenario folder and the agent's name.
fn pick_for(dir: Option<&Path>, agent: &str, prompt: &str) -> (String, Vec<Value>) {
    let fallback = || ("builtin".to_string(), vec![json!({ "text": "OK." })]);
    let Some(dir) = dir.map(Path::to_path_buf) else { return fallback() };
    let Some(scn) = load_json(&dir.join("scenario.json")) else { return fallback() };
    let state_file = dir.join("state").join(format!("{agent}.json"));
    let mut state = load_json(&state_file).unwrap_or_else(|| json!({}));
    let lists = [("agent", scn.pointer(&format!("/agents/{agent}/turns")).cloned()), ("default", scn.pointer("/default/turns").cloned())];
    for (whose, list) in lists {
        let Some(list) = list.and_then(|l| l.as_array().cloned()) else { continue };
        for (i, t) in list.iter().enumerate() {
            if !matches(t, prompt) {
                continue;
            }
            let key = format!("{whose}:{i}");
            let used = state["used"][&key].as_u64().unwrap_or(0);
            let times = t["times"].as_u64().or_else(|| t["once"].as_bool().filter(|b| *b).map(|_| 1));
            if times.map(|n| used >= n).unwrap_or(false) {
                continue;
            }
            state["used"][&key] = json!(used + 1);
            state["turns"] = json!(state["turns"].as_u64().unwrap_or(0) + 1);
            save_json(&state_file, &state);
            let label = t["name"].as_str().map(str::to_string).unwrap_or(key);
            return (label, t["steps"].as_array().cloned().unwrap_or_default());
        }
    }
    state["turns"] = json!(state["turns"].as_u64().unwrap_or(0) + 1);
    save_json(&state_file, &state);
    fallback()
}

// ------------------------------------------------------------ one turn

struct Turn {
    started: Instant,
    texts: Vec<String>,
    calls: u64,
    usage: Value,
    cost: f64,
    result: Option<Map<String, Value>>,
}

fn default_usage(first: bool, out_chars: usize) -> Value {
    let write = if first { 2400 } else { 0 };
    json!({
        "input_tokens": 120, "cache_creation_input_tokens": write, "cache_read_input_tokens": 18_000,
        "output_tokens": (out_chars / 4).max(1),
        "cache_creation": { "ephemeral_1h_input_tokens": write, "ephemeral_5m_input_tokens": 0 },
        "service_tier": "standard",
    })
}

fn message(cli: &Cli, id: &str, content: Value, usage: &Value) -> Value {
    json!({ "id": id, "type": "message", "role": "assistant", "model": cli.model, "content": content,
            "stop_reason": null, "stop_sequence": null, "usage": usage })
}

fn emit_text(cli: &Cli, turn: &mut Turn, kind: &str, text: &str, chunk: usize, delay: u64) -> bool {
    turn.calls += 1;
    let id = format!("msg_fake_{}", cli.next());
    let usage = turn.usage.clone();
    cli.stream(json!({ "type": "message_start", "message": message(cli, &id, json!([]), &usage) }));
    let (block, delta_type, field) = if kind == "thinking" {
        (json!({ "type": "thinking", "thinking": "", "signature": "" }), "thinking_delta", "thinking")
    } else {
        (json!({ "type": "text", "text": "" }), "text_delta", "text")
    };
    cli.stream(json!({ "type": "content_block_start", "index": 0, "content_block": block }));
    let chars: Vec<char> = text.chars().collect();
    for piece in chars.chunks(chunk.max(1)) {
        let s: String = piece.iter().collect();
        cli.stream(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": delta_type, field: s } }));
        if delay > 0 && !cli.pause(delay) {
            return false;
        }
    }
    cli.stream(json!({ "type": "content_block_stop", "index": 0 }));
    let content = if kind == "thinking" {
        json!([{ "type": "thinking", "thinking": text, "signature": "fake-signature" }])
    } else {
        json!([{ "type": "text", "text": text }])
    };
    cli.emit(json!({ "type": "assistant", "message": message(cli, &id, content, &usage), "parent_tool_use_id": null }));
    cli.stream(json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                       "usage": { "output_tokens": (text.len() / 4).max(1) } }));
    cli.stream(json!({ "type": "message_stop" }));
    if kind != "thinking" {
        turn.texts.push(text.to_string());
    }
    true
}

/// One tool use: announced, run (orgtree tools through the engine's MCP
/// server; any other tool answers from the script), hooked, answered.
/// Returns the hook's additional context (mid-turn mail), if any.
fn tool_use(cli: &Cli, turn: &mut Turn, step: &Value) -> Option<String> {
    turn.calls += 1;
    let name = step["tool"].as_str().unwrap_or("Bash").to_string();
    let orgtree = name.starts_with("orgtree_") || name.starts_with("mcp__orgtree__");
    let short = name.trim_start_matches("mcp__orgtree__").to_string();
    let full = if orgtree { format!("mcp__orgtree__{short}") } else { name.clone() };
    let args = if step["args"].is_null() { json!({}) } else { step["args"].clone() };
    let tid = step["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("toolu_fake_{}", cli.next()));
    let id = format!("msg_fake_{}", cli.next());
    let usage = turn.usage.clone();
    cli.stream(json!({ "type": "message_start", "message": message(cli, &id, json!([]), &usage) }));
    cli.stream(json!({ "type": "content_block_start", "index": 0,
                       "content_block": { "type": "tool_use", "id": tid, "name": full, "input": {} } }));
    cli.stream(json!({ "type": "content_block_delta", "index": 0,
                       "delta": { "type": "input_json_delta", "partial_json": args.to_string() } }));
    cli.stream(json!({ "type": "content_block_stop", "index": 0 }));
    cli.emit(json!({ "type": "assistant", "parent_tool_use_id": null,
                     "message": message(cli, &id, json!([{ "type": "tool_use", "id": tid, "name": full, "input": args }]), &usage) }));
    cli.stream(json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use", "stop_sequence": null },
                       "usage": { "output_tokens": 40 } }));
    cli.stream(json!({ "type": "message_stop" }));
    // PreToolUse: a hook may deny the tool before it runs (the engine's keepalive denies every one)
    let ids = cli.hook_ids.lock().unwrap().clone();
    for (_, cb) in ids.iter().filter(|(e, _)| e == "PreToolUse") {
        let input = json!({ "session_id": cli.session, "cwd": cli.cwd, "hook_event_name": "PreToolUse",
                            "tool_name": full, "tool_input": args });
        let resp = cli.request(json!({ "subtype": "hook_callback", "callback_id": cb, "input": input, "tool_use_id": tid }),
                               Duration::from_secs(60));
        let out = resp.as_ref().map(|r| r["response"]["hookSpecificOutput"].clone()).unwrap_or(Value::Null);
        if out["permissionDecision"].as_str() == Some("deny") {
            let why = out["permissionDecisionReason"].as_str().unwrap_or("denied by a PreToolUse hook").to_string();
            cli.log("tool_denied", json!({ "tool": short, "args": args, "reason": why }));
            cli.emit(json!({ "type": "user", "parent_tool_use_id": null,
                             "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": tid,
                                                                          "content": [{ "type": "text", "text": why }],
                                                                          "is_error": true }] } }));
            return None;
        }
    }
    let (text, is_error) = if orgtree {
        let rpc = json!({ "jsonrpc": "2.0", "id": cli.next(), "method": "tools/call",
                          "params": { "name": short, "arguments": args, "_meta": { "claudecode/toolUseId": tid } } });
        match cli.request(json!({ "subtype": "mcp_message", "server_name": "orgtree", "message": rpc }), Duration::from_secs(300)) {
            None => ("the orgtree MCP server did not answer".to_string(), true),
            Some(resp) if resp["subtype"] == "error" => (resp["error"].as_str().unwrap_or("error").to_string(), true),
            Some(resp) => {
                let r = &resp["response"]["mcp_response"];
                if !r["error"].is_null() {
                    (r["error"]["message"].as_str().unwrap_or("error").to_string(), true)
                } else {
                    let text = r["result"]["content"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
                        .unwrap_or_default();
                    (text, r["result"]["isError"].as_bool().unwrap_or(false))
                }
            }
        }
    } else {
        if let Some(ms) = step["run_ms"].as_u64() {
            cli.pause(ms);
        }
        (step["result"].as_str().unwrap_or("ok").to_string(), step["is_error"].as_bool().unwrap_or(false))
    };
    let mut check = json!({ "tool": short, "args": args, "is_error": is_error, "text": text });
    if let Some(want) = step["expect"].as_str() {
        check["expect"] = json!(want);
        check["ok"] = json!(text.to_lowercase().contains(&want.to_lowercase()));
    }
    if let Some(want) = step["expect_error"].as_bool() {
        check["expect_error"] = json!(want);
        check["ok"] = json!(check["ok"].as_bool().unwrap_or(true) && want == is_error);
    }
    cli.log("tool_result", check);
    // PostToolUse: the engine hands waiting mail over here
    let mut context = None;
    for (_, cb) in ids.into_iter().filter(|(e, _)| e != "PreToolUse") {
        let input = json!({ "session_id": cli.session, "cwd": cli.cwd, "hook_event_name": "PostToolUse",
                            "tool_name": full, "tool_input": args, "tool_response": { "text": text } });
        let resp = cli.request(json!({ "subtype": "hook_callback", "callback_id": cb, "input": input, "tool_use_id": tid }),
                               Duration::from_secs(60));
        let extra = resp
            .as_ref()
            .and_then(|r| r.pointer("/response/hookSpecificOutput/additionalContext"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(t) = extra.filter(|t| !t.is_empty()) {
            cli.log("hook_mail", json!({ "tool_use_id": tid, "text": t }));
            context = Some(t);
        }
    }
    cli.emit(json!({ "type": "user", "parent_tool_use_id": null,
                     "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": tid,
                                                                  "content": [{ "type": "text", "text": text }],
                                                                  "is_error": is_error }] },
                     "tool_use_result": { "text": text } }));
    context
}

fn finish(cli: &Cli, turn: &mut Turn, state_cost: &mut f64) {
    let ms = turn.started.elapsed().as_millis() as u64;
    *state_cost += turn.cost;
    let mut res = Map::new();
    res.insert("type".into(), json!("result"));
    res.insert("subtype".into(), json!("success"));
    res.insert("is_error".into(), json!(false));
    res.insert("duration_ms".into(), json!(ms));
    res.insert("duration_api_ms".into(), json!(ms));
    res.insert("num_turns".into(), json!(turn.calls.max(1)));
    res.insert("result".into(), json!(turn.texts.last().cloned().unwrap_or_default()));
    res.insert("stop_reason".into(), json!("end_turn"));
    res.insert("session_id".into(), json!(cli.session));
    res.insert("total_cost_usd".into(), json!(*state_cost));
    res.insert("usage".into(), turn.usage.clone());
    res.insert("permission_denials".into(), json!([]));
    if let Some(over) = turn.result.take() {
        for (k, v) in over {
            if k == "text" {
                res.insert("result".into(), v);
            } else {
                res.insert(k, v);
            }
        }
    }
    cli.emit(Value::Object(res));
}

/// The CLI's config folder: `CLAUDE_CONFIG_DIR`, else the fake home's `.claude`.
/// An environment switch as the CLI reads one: 1, true, yes or on.
fn env_on(name: &str) -> bool {
    std::env::var(name).map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(false)
}

/// The CLI's global config: `<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`.
fn global_config() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|s| !s.is_empty()) {
        Some(d) => Some(PathBuf::from(d).join(".claude.json")),
        None => std::env::var("ORGTREE_FAKECLI_HOME").ok().filter(|s| !s.is_empty()).map(|h| PathBuf::from(h).join(".claude.json")),
    }
}

/// The CLI's Windows PowerShell tool gate (2.1.292): CLAUDE_CODE_USE_POWERSHELL_TOOL
/// decides when set; otherwise (Git Bash installed) the server-side flag
/// `tengu_cobalt_ridge`, default off. Flags come from the flag service unless
/// telemetry is off (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY,
/// DO_NOT_TRACK); then only CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF lets
/// the CLI read the copy cached in its global config. The rig has no flag
/// service: that cached copy stands in for it.
fn powershell_tool() -> bool {
    if std::env::var("CLAUDE_CODE_USE_POWERSHELL_TOOL").is_ok() {
        return env_on("CLAUDE_CODE_USE_POWERSHELL_TOOL");
    }
    let telemetry_off = std::env::var("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").is_ok_and(|v| !v.is_empty())
        || std::env::var("DISABLE_TELEMETRY").is_ok_and(|v| !v.is_empty())
        || env_on("DO_NOT_TRACK");
    if telemetry_off && !env_on("CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF") {
        return false;
    }
    global_config()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["cachedGrowthBookFeatures"]["tengu_cobalt_ridge"].as_bool())
        .unwrap_or(false)
}

fn config_base() -> Option<PathBuf> {
    std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("ORGTREE_FAKECLI_HOME").ok().filter(|s| !s.is_empty()).map(|h| PathBuf::from(h).join(".claude")))
}

fn transcript(cli: &Cli, role: &str, text: &str) {
    let Some(base) = config_base() else { return };
    let dir = base.join("projects").join(project_dir(&cli.cwd));
    let _ = std::fs::create_dir_all(&dir);
    let line = if role == "user" {
        json!({ "type": "user", "message": { "role": "user", "content": text }, "sessionId": cli.session,
                "uuid": cli.uuid(), "timestamp": iso_now(), "cwd": cli.cwd })
    } else {
        json!({ "type": "assistant", "message": { "role": "assistant", "model": cli.model,
                                                  "content": [{ "type": "text", "text": text }] },
                "sessionId": cli.session, "uuid": cli.uuid(), "timestamp": iso_now(), "cwd": cli.cwd })
    };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.jsonl", cli.session))) {
        let _ = writeln!(f, "{line}");
    }
}

fn run_turn(cli: &Cli, prompt: &str, tools: &[String], native: &[String], first: &mut bool, cost: &mut f64) {
    cli.interrupted.store(false, Ordering::SeqCst);
    let (script, steps) = pick(cli, prompt);
    cli.log("turn", json!({ "script": script, "prompt": prompt, "steps": steps.len() }));
    transcript(cli, "user", prompt);
    let mut tool_names: Vec<Value> = native.iter().map(|t| json!(t)).collect();
    tool_names.extend(tools.iter().map(|t| json!(format!("mcp__orgtree__{t}"))));
    cli.emit(json!({ "type": "system", "subtype": "init", "cwd": cli.cwd, "tools": tool_names,
                     "mcp_servers": [{ "name": "orgtree", "status": "connected" }], "model": cli.model,
                     "permissionMode": "default", "slash_commands": ["compact"], "apiKeySource": "none",
                     "claude_code_version": VERSION, "output_style": "default", "agents": [], "skills": [], "plugins": [] }));
    let mut turn = Turn { started: Instant::now(), texts: vec![], calls: 0, usage: default_usage(*first, 200), cost: 0.0125, result: None };
    *first = false;
    for step in &steps {
        if cli.interrupted.load(Ordering::SeqCst) {
            break;
        }
        cli.log("step", json!({ "step": step }));
        if let Some(t) = step["text"].as_str() {
            let delay = step["delay_ms"].as_u64().unwrap_or(0);
            let chunk = step["chunk"].as_u64().unwrap_or(24) as usize;
            if !emit_text(cli, &mut turn, "text", t, chunk, delay) {
                break;
            }
        } else if let Some(t) = step["thinking"].as_str() {
            if !emit_text(cli, &mut turn, "thinking", t, 32, step["delay_ms"].as_u64().unwrap_or(0)) {
                break;
            }
        } else if step.get("tool").is_some() {
            tool_use(cli, &mut turn, step);
        } else if let Some(p) = step.get("poll_mail") {
            // tool boundaries until the engine hands mail over (or time runs out)
            let every = p["every_ms"].as_u64().unwrap_or(2000);
            let until = Instant::now() + Duration::from_millis(p["timeout_ms"].as_u64().unwrap_or(30_000));
            let mut got = false;
            while Instant::now() < until && !got {
                if !cli.pause(every) {
                    break;
                }
                let s = json!({ "tool": "Bash", "args": { "command": "sleep 1", "description": "fake poll" }, "result": "" });
                got = tool_use(cli, &mut turn, &s).is_some();
            }
            cli.log("poll_mail", json!({ "delivered": got }));
        } else if let Some(ms) = step["sleep_ms"].as_u64() {
            if !cli.pause(ms) {
                break;
            }
        } else if let Some(code) = step.get("exit") {
            let code = code.as_i64().unwrap_or(1) as i32;
            cli.log("exit", json!({ "code": code, "why": "scripted" }));
            std::process::exit(code);
        } else if step["hang"].as_bool() == Some(true) {
            cli.log("hang", json!({}));
            while cli.pause(1000) {}
        } else if let Some(u) = step.get("usage") {
            if let (Some(cur), Some(add)) = (turn.usage.as_object_mut(), u.as_object()) {
                for (k, v) in add {
                    cur.insert(k.clone(), v.clone());
                }
            }
            if let Some(c) = step["cost_usd"].as_f64() {
                turn.cost = c;
            }
        } else if let Some(r) = step.get("result") {
            turn.result = r.as_object().cloned();
            break;
        } else if let Some(sys) = step.get("system").and_then(Value::as_object) {
            let mut v = json!({ "type": "system" });
            for (k, val) in sys {
                v[k] = val.clone();
            }
            cli.emit(v);
        } else if let Some(info) = step.get("rate_limit") {
            cli.emit(json!({ "type": "rate_limit_event", "rate_limit_info": info }));
        } else if let Some(raw) = step.get("raw") {
            cli.emit(raw.clone());
        } else {
            cli.log("unknown_step", json!({ "step": step }));
        }
    }
    if cli.interrupted.load(Ordering::SeqCst) {
        turn.result = Some(
            json!({ "subtype": "error_during_execution", "is_error": true, "text": "", "stop_reason": null })
                .as_object()
                .cloned()
                .unwrap(),
        );
        cli.log("interrupted", json!({}));
    }
    if let Some(t) = turn.texts.last() {
        transcript(cli, "assistant", t);
    }
    finish(cli, &mut turn, cost);
    cli.log("turn_end", json!({ "script": script, "ms": turn.started.elapsed().as_millis() as u64 }));
}

// ------------------------------------------------------------ the process

fn prompt_text(v: &Value) -> String {
    match &v["message"]["content"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn reader(cli: Arc<Cli>, tx: mpsc::Sender<Msg>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            cli.log("recv_raw", json!({ "line": line }));
            continue;
        };
        cli.log("recv", json!({ "line": v }));
        match v["type"].as_str() {
            Some("control_response") => {
                let id = v["response"]["request_id"].as_str().unwrap_or("").to_string();
                if let Some(w) = cli.waiters.lock().unwrap().remove(&id) {
                    let _ = w.send(v["response"].clone());
                }
            }
            Some("control_request") => {
                let id = v["request_id"].as_str().unwrap_or("").to_string();
                let req = &v["request"];
                match req["subtype"].as_str() {
                    Some("initialize") => {
                        let mut ids = Vec::new();
                        if let Some(hooks) = req["hooks"].as_object() {
                            for (event, list) in hooks.iter().filter_map(|(e, l)| l.as_array().map(|l| (e, l))) {
                                for m in list {
                                    for cb in m["hookCallbackIds"].as_array().cloned().unwrap_or_default() {
                                        if let Some(s) = cb.as_str() {
                                            ids.push((event.clone(), s.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                        *cli.hook_ids.lock().unwrap() = ids;
                        cli.respond(&id, json!({ "commands": [], "output_style": "default",
                                                 "available_output_styles": ["default"], "models": [],
                                                 "account": { "subscriptionType": "fake" } }));
                        let _ = tx.send(Msg::Init);
                    }
                    Some("interrupt") => {
                        cli.interrupted.store(true, Ordering::SeqCst);
                        cli.respond(&id, json!({}));
                    }
                    Some("mcp_status") => {
                        cli.respond(&id, json!({ "mcpServers": [{ "name": "orgtree", "status": "connected" }] }));
                    }
                    _ => cli.respond(&id, json!({})),
                }
            }
            Some("user") => {
                let _ = tx.send(Msg::Prompt(prompt_text(&v)));
            }
            _ => {}
        }
    }
    let _ = tx.send(Msg::Eof);
}

fn claude(raw: &[String]) -> i32 {
    let args = parse_args(raw);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let agent = std::env::var("ORGTREE_AGENT")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| cwd.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "agent".into());
    let dir = std::env::var("ORGTREE_FAKECLI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let log = dir.as_ref().and_then(|d| {
        let p = d.join("log");
        let _ = std::fs::create_dir_all(&p);
        std::fs::OpenOptions::new().create(true).append(true).open(p.join(format!("{agent}.jsonl"))).ok()
    });
    let resumed = args.resume.clone().or(args.session_id.clone()).unwrap_or_else(|| format!("fake-{}", now_ms()));
    // --fork-session: like the real CLI, a copy of the resumed transcript under a new id
    let session = if args.fork && args.resume.is_some() { format!("fork-{}-{}", now_ms(), std::process::id()) } else { resumed.clone() };
    let cli = Arc::new(Cli {
        out: Mutex::new(std::io::stdout()),
        log: Mutex::new(log),
        waiters: Mutex::new(HashMap::new()),
        hook_ids: Mutex::new(Vec::new()),
        interrupted: AtomicBool::new(false),
        seq: AtomicU64::new(0),
        agent: agent.clone(),
        session: session.clone(),
        model: args.model.clone(),
        cwd: cwd.clone(),
        dir,
    });
    // the CLI's own tools, as its init event lists them
    let native: Vec<String> = ["Task", "Bash", "PowerShell", "Glob", "Grep", "Read", "Edit", "Write", "TodoWrite"]
        .iter()
        .filter(|t| **t != "PowerShell" || powershell_tool())
        .filter(|t| !args.disallowed.iter().any(|d| d == *t))
        .map(|t| t.to_string())
        .collect();
    let env_of = |k: &str| std::env::var(k).ok();
    cli.log("start", json!({ "args": raw, "cwd": cwd, "session": session, "resumed": args.resume.is_some(),
                              "tools": native,
                              // like the real CLI, the cwd's CLAUDE.md is read once, at process start
                              "claude_md": std::fs::read_to_string(cwd.join("CLAUDE.md")).ok(),
                              "env": { "CLAUDE_CODE_USE_POWERSHELL_TOOL": env_of("CLAUDE_CODE_USE_POWERSHELL_TOOL"),
                                       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": env_of("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"),
                                       "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": env_of("CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF"),
                                       "ORGTREE_NODE": env_of("ORGTREE_NODE") },
                              "forked_from": if args.fork { args.resume.clone() } else { None }, "max_turns": args.max_turns,
                              "model": args.model, "permission_mode": args.permission_mode, "effort": args.effort,
                              "add_dirs": args.add_dirs, "unknown_args": args.unknown,
                              "org": std::env::var("ORGTREE_ORG").ok(),
                              "config_dir_set": std::env::var("CLAUDE_CONFIG_DIR").is_ok(),
                              "config_dir": std::env::var("CLAUDE_CONFIG_DIR").ok(),
                              "api_key_set": std::env::var("ANTHROPIC_API_KEY").map(|k| !k.is_empty()).unwrap_or(false),
                              "oauth_token_set": std::env::var("CLAUDE_CODE_OAUTH_TOKEN").is_ok() }));
    // like the real CLI: --resume finds its transcript under this config folder or fails
    if let Some(sid) = &args.resume {
        if let Some(base) = config_base() {
            let file = base.join("projects").join(project_dir(&cwd)).join(format!("{sid}.jsonl"));
            if !file.is_file() {
                eprintln!("No conversation found with session ID: {sid}");
                cli.log("exit", json!({ "code": 1, "why": "no transcript for --resume", "looked": file }));
                return 1;
            }
            if session != *sid {
                let _ = std::fs::copy(&file, file.with_file_name(format!("{session}.jsonl")));
            }
        }
    }
    let (tx, rx) = mpsc::channel();
    {
        let cli = cli.clone();
        std::thread::spawn(move || reader(cli, tx));
    }
    let state_file = cli.path("state").map(|d| d.join(format!("{agent}.json")));
    let mut cost = state_file
        .as_ref()
        .and_then(|p| load_json(p))
        .and_then(|s| s["cost"][&session].as_f64())
        .unwrap_or(0.0);
    let mut first = args.resume.is_none();
    let mut tools: Vec<String> = Vec::new();
    for msg in rx {
        match msg {
            Msg::Init => {
                // the real CLI connects its SDK MCP servers right after initialize
                let rpc = |method: &str, id: Option<u64>| {
                    let mut m = json!({ "jsonrpc": "2.0", "method": method, "params": {} });
                    if let Some(i) = id {
                        m["id"] = json!(i);
                    }
                    if method == "initialize" {
                        m["params"] = json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                                              "clientInfo": { "name": "orgtree-fakecli", "version": "0.1.0" } });
                    }
                    json!({ "subtype": "mcp_message", "server_name": "orgtree", "message": m })
                };
                let _ = cli.request(rpc("initialize", Some(cli.next())), Duration::from_secs(30));
                let _ = cli.request(rpc("notifications/initialized", None), Duration::from_secs(30));
                if let Some(r) = cli.request(rpc("tools/list", Some(cli.next())), Duration::from_secs(30)) {
                    tools = r["response"]["mcp_response"]["result"]["tools"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|t| t["name"].as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                }
                cli.log("mcp_ready", json!({ "tools": tools.len() }));
            }
            Msg::Prompt(text) => {
                run_turn(&cli, &text, &tools, &native, &mut first, &mut cost);
                if let Some(p) = &state_file {
                    let mut s = load_json(p).unwrap_or_else(|| json!({}));
                    s["cost"][&session] = json!(cost);
                    save_json(p, &s);
                }
            }
            Msg::Eof => break,
        }
    }
    cli.log("exit", json!({ "code": 0, "why": "stdin closed" }));
    0
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    // started as codex.exe or agy.exe (the rig copies this binary to every
    // name), or with the app-server subcommand anywhere (`-c` overrides come first)
    let stem = std::env::args()
        .next()
        .and_then(|a0| Path::new(&a0).file_stem().map(|s| s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let version = matches!(raw.first().map(String::as_str), Some("--version") | Some("-v"));
    let code = if raw.iter().any(|a| a == "app-server") {
        codex::run(&raw)
    } else if version {
        println!("{}", match stem.as_str() { "codex" => codex::VERSION, "agy" => agy::VERSION, _ => VERSION });
        0
    } else if stem == "agy" {
        agy::run(&raw)
    } else {
        claude(&raw)
    };
    std::process::exit(code);
}
