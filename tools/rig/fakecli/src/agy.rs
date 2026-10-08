//! The Antigravity stand-in: `agy -p= --input-format stream-json
//! --output-format stream-json`, as the engine drives it (src/runtime/agy.rs).
//! One process serves many turns: every `{"event":"user"}` line on stdin is a
//! turn, answered with `init` (first turn), `step_update`s and a `result`.
//! Like the real CLI it works from the agent's folder: `orgtree_*` tools go
//! to the workspace plugin's MCP server (`orgtree-engine mcp-bridge --pipe`,
//! read from `.agents/plugins/orgtree/mcp_config.json`), every tool call
//! passes the PreToolUse hooks and every model invocation ends with the
//! PostInvocation hooks from `.agents/hooks.json` (the rights hook and the
//! mid-turn mail hook), run as commands with their JSON on stdin.
//!
//! Steps, besides the shared ones (text, tool, poll_mail, sleep_ms, hang,
//! exit, raw):
//!   {"error": "..."}                         the turn ends with status ERROR
//!   {"result": {"status": "...", "error": "..."}}   end the turn with that result
//!   {"usage": {"input": 1200, "cached": 900, "output": 80}}   the next responses' tokens
//!   {"init_model": "..."}                    as a first step: init names this model

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{iso_now, now_ms, pick_for};

pub const VERSION: &str = "1.99.0 (Antigravity fake)";

struct Agy {
    out: Mutex<std::io::Stdout>,
    log: Mutex<Option<std::fs::File>>,
    agent: String,
    dir: Option<PathBuf>,
    cwd: PathBuf,
    model: String,
    conversation: String,
    resumed: bool,
}

impl Agy {
    fn log(&self, kind: &str, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.insert("ts".into(), json!(iso_now()));
            o.insert("pid".into(), json!(std::process::id()));
            o.insert("kind".into(), json!(kind));
            o.insert("mode".into(), json!("agy"));
        }
        if let Ok(mut g) = self.log.lock() {
            if let Some(f) = g.as_mut() {
                let _ = f.write_all(format!("{v}\n").as_bytes());
            }
        }
    }

    fn emit(&self, v: Value) {
        if let Ok(mut out) = self.out.lock() {
            let _ = writeln!(out, "{v}");
            let _ = out.flush();
        }
        self.log("send", json!({ "line": v }));
    }

    fn step(&self, step: Value) {
        self.emit(json!({ "event": "step_update", "step_update": step }));
    }
}

// ------------------------------------------------------------ the workspace

/// The orgtree tools through the workspace plugin's MCP server, as the CLI
/// launches it.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
    tools: Vec<String>,
}

impl Mcp {
    fn start(agy: &Agy) -> Option<Mcp> {
        let cfg_path = agy.cwd.join(".agents").join("plugins").join("orgtree").join("mcp_config.json");
        let cfg: Value = serde_json::from_slice(&std::fs::read(&cfg_path).ok()?).ok()?;
        let srv = &cfg["mcpServers"]["orgtree"];
        let command = srv["command"].as_str()?;
        let mut cmd = Command::new(command);
        cmd.args(srv["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default());
        if let Some(env) = srv["env"].as_object() {
            for (k, v) in env {
                cmd.env(k, v.as_str().unwrap_or(""));
            }
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                agy.log("mcp_failed", json!({ "command": command, "error": e.to_string() }));
                return None;
            }
        };
        let stdin = child.stdin.take()?;
        let stdout = BufReader::new(child.stdout.take()?);
        let mut mcp = Mcp { child, stdin, stdout, next: 0, tools: Vec::new() };
        mcp.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": { "name": "antigravity-fake", "version": VERSION } }))?;
        mcp.notify("notifications/initialized");
        let list = mcp.request("tools/list", json!({}))?;
        mcp.tools = list["result"]["tools"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t["name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        agy.log("mcp_ready", json!({ "command": command, "tools": mcp.tools.len() }));
        Some(mcp)
    }

    fn notify(&mut self, method: &str) {
        let _ = writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "method": method, "params": {} }));
        let _ = self.stdin.flush();
    }

    /// One request and its response (notifications in between are skipped).
    fn request(&mut self, method: &str, params: Value) -> Option<Value> {
        self.next += 1;
        let id = self.next;
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).ok()?;
        self.stdin.flush().ok()?;
        let mut line = String::new();
        loop {
            line.clear();
            if self.stdout.read_line(&mut line).ok()? == 0 {
                return None;
            }
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
            if v["id"].as_u64() == Some(id) {
                return Some(v);
            }
        }
    }

    fn call(&mut self, name: &str, args: &Value) -> (String, bool) {
        match self.request("tools/call", json!({ "name": name, "arguments": args })) {
            None => ("the orgtree MCP server did not answer".into(), true),
            Some(r) if !r["error"].is_null() => (r["error"]["message"].as_str().unwrap_or("error").to_string(), true),
            Some(r) => (
                r["result"]["content"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default(),
                r["result"]["isError"].as_bool().unwrap_or(false),
            ),
        }
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// One hook command from `.agents/hooks.json`.
struct Hook {
    event: String,
    matcher: String,
    command: String,
}

fn load_hooks(cwd: &Path) -> Vec<Hook> {
    let Some(doc) = std::fs::read(cwd.join(".agents").join("hooks.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for group in doc.as_object().map(|o| o.values().collect::<Vec<_>>()).unwrap_or_default() {
        for (event, entries) in group.as_object().into_iter().flatten() {
            for entry in entries.as_array().into_iter().flatten() {
                // {matcher, hooks: [...]} or a hook itself
                let matcher = entry["matcher"].as_str().unwrap_or("*").to_string();
                let hooks = entry["hooks"].as_array().cloned().unwrap_or_else(|| vec![entry.clone()]);
                for h in hooks {
                    if let Some(c) = h["command"].as_str() {
                        out.push(Hook { event: event.clone(), matcher: matcher.clone(), command: c.to_string() });
                    }
                }
            }
        }
    }
    out
}

/// Run one hook with `payload` on stdin; its stdout as JSON.
fn run_hook(h: &Hook, payload: &Value) -> Option<Value> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/D", "/C", &h.command]);
        c
    } else {
        Command::new(&h.command)
    };
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.to_string().as_bytes());
    }
    let out = child.wait_with_output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
}

// ------------------------------------------------------------ one turn

struct Turn<'a> {
    agy: &'a Agy,
    hooks: &'a [Hook],
    index: i64,
    text: String,
    usage: (i64, i64, i64),
}

impl Turn<'_> {
    fn next_index(&mut self) -> i64 {
        self.index += 1;
        self.index
    }

    /// The end of a model invocation: the PostInvocation hooks may hand the
    /// running turn a message (mid-turn mail). True when one did.
    fn invocation_end(&mut self) -> bool {
        let mut got = false;
        for h in self.hooks.iter().filter(|h| h.event == "PostInvocation") {
            let Some(r) = run_hook(h, &json!({ "event": "PostInvocation" })) else { continue };
            for inj in r["injectSteps"].as_array().into_iter().flatten() {
                if let Some(text) = inj["userMessage"].as_str() {
                    self.agy.log("hook_mail", json!({ "text": text, "termination": r["terminationBehavior"] }));
                    let i = self.next_index();
                    self.agy.step(json!({ "step_index": i, "step_type": "user_input", "state": "DONE", "user_input": { "text": text } }));
                    got = true;
                }
            }
        }
        got
    }

    fn respond(&mut self, text: &str, chunk: usize, delay: u64) {
        let i = self.next_index();
        let chars: Vec<char> = text.chars().collect();
        for piece in chars.chunks(chunk.max(1)) {
            let s: String = piece.iter().collect();
            self.agy.step(json!({ "step_index": i, "step_type": "agent_response", "state": "ACTIVE", "text_delta": s }));
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }
        let (inp, cached, out) = self.usage;
        let out = if out > 0 { out } else { (text.len() as i64 / 4).max(1) };
        self.agy.step(json!({ "step_index": i, "step_type": "agent_response", "state": "DONE",
                              "usage": { "input_tokens": inp, "cache_read_tokens": cached, "output_tokens": out, "thinking_tokens": 0 } }));
        self.text.push_str(text);
        self.invocation_end();
    }

    fn tool(&mut self, step: &Value, mcp: &mut Option<Mcp>) {
        let name = step["tool"].as_str().unwrap_or("").trim_start_matches("mcp__orgtree__").to_string();
        let args = if step["args"].is_null() { json!({}) } else { step["args"].clone() };
        let i = self.next_index();
        self.agy.step(json!({ "step_index": i, "step_type": "tool", "state": "ACTIVE", "tool_name": name, "tool_info": { "parameters": args } }));
        // the PreToolUse hooks decide first, as in the CLI
        let mut denied: Option<String> = None;
        for h in self.hooks.iter().filter(|h| h.event == "PreToolUse" && (h.matcher == "*" || h.matcher == name)) {
            let r = run_hook(h, &json!({ "toolCall": { "name": name, "args": args } }));
            let decision = r.as_ref().and_then(|r| r["decision"].as_str()).unwrap_or("allow").to_string();
            self.agy.log("hook", json!({ "event": "PreToolUse", "tool": name, "decision": decision, "reason": r.as_ref().map(|r| r["reason"].clone()) }));
            if decision == "deny" {
                denied = Some(r.as_ref().and_then(|r| r["reason"].as_str()).unwrap_or("denied").to_string());
                break;
            }
        }
        let (text, is_error) = if let Some(reason) = &denied {
            (format!("tool call denied by pre-tool hook: {reason}"), true)
        } else if name.starts_with("orgtree_") {
            if mcp.is_none() {
                *mcp = Mcp::start(self.agy);
            }
            match mcp.as_mut() {
                Some(m) => m.call(&name, &args),
                None => ("the orgtree MCP server could not be started".into(), true),
            }
        } else {
            if let Some(ms) = step["run_ms"].as_u64() {
                std::thread::sleep(Duration::from_millis(ms));
            }
            (step["result"].as_str().unwrap_or("ok").to_string(), step["is_error"].as_bool().unwrap_or(false))
        };
        let info = if is_error {
            json!({ "parameters": args, "error": { "message": text } })
        } else {
            json!({ "parameters": args, "result": text })
        };
        self.agy.step(json!({ "step_index": i, "step_type": "tool", "state": if is_error { "ERROR" } else { "DONE" },
                              "tool_name": name, "tool_info": info }));
        let mut check = json!({ "tool": name, "args": args, "is_error": is_error, "text": text, "denied": denied.is_some() });
        if let Some(want) = step["expect"].as_str() {
            check["expect"] = json!(want);
            check["ok"] = json!(text.to_lowercase().contains(&want.to_lowercase()));
        }
        if let Some(want) = step["expect_error"].as_bool() {
            check["expect_error"] = json!(want);
            check["ok"] = json!(check["ok"].as_bool().unwrap_or(true) && want == is_error);
        }
        self.agy.log("tool_result", check);
        self.invocation_end();
    }
}

fn run_turn(agy: &Agy, hooks: &[Hook], mcp: &mut Option<Mcp>, prompt: &str, first: &mut bool) {
    let (script, steps) = pick_for(agy.dir.as_deref(), &agy.agent, prompt);
    agy.log("turn", json!({ "script": script, "prompt": prompt, "steps": steps.len(), "conversation": agy.conversation }));
    let started = Instant::now();
    if *first {
        *first = false;
        let model = steps.first().and_then(|s| s["init_model"].as_str()).unwrap_or(&agy.model).to_string();
        let tools: Vec<&str> = vec!["run_command", "view_file", "write_to_file", "grep_search", "list_dir"];
        agy.emit(json!({ "event": "init", "conversation_id": agy.conversation,
                         "init": { "model": model, "cwd": agy.cwd, "tools": tools, "resumed": agy.resumed } }));
    }
    let mut turn = Turn { agy, hooks, index: 0, text: String::new(), usage: (1200, 900, 0) };
    turn.agy.step(json!({ "step_index": 0, "step_type": "user_input", "state": "DONE", "user_input": { "text": prompt } }));
    let mut result = json!({ "status": "SUCCESS" });
    for step in &steps {
        agy.log("step", json!({ "step": step }));
        if step.get("init_model").is_some() {
            continue;
        }
        if let Some(t) = step["text"].as_str() {
            turn.respond(t, step["chunk"].as_u64().unwrap_or(24) as usize, step["delay_ms"].as_u64().unwrap_or(0));
        } else if step["tool"].is_string() {
            turn.tool(step, mcp);
        } else if let Some(p) = step.get("poll_mail") {
            let every = p["every_ms"].as_u64().unwrap_or(500);
            let until = Instant::now() + Duration::from_millis(p["timeout_ms"].as_u64().unwrap_or(30_000));
            let mut got = false;
            while Instant::now() < until && !got {
                std::thread::sleep(Duration::from_millis(every));
                got = turn.invocation_end();
            }
            agy.log("poll_mail", json!({ "delivered": got }));
        } else if let Some(ms) = step["sleep_ms"].as_u64() {
            std::thread::sleep(Duration::from_millis(ms));
        } else if let Some(code) = step.get("exit") {
            let code = code.as_i64().unwrap_or(1) as i32;
            agy.log("exit", json!({ "code": code, "why": "scripted" }));
            std::process::exit(code);
        } else if step["hang"].as_bool() == Some(true) {
            agy.log("hang", json!({}));
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        } else if let Some(u) = step.get("usage") {
            turn.usage = (u["input"].as_i64().unwrap_or(1200), u["cached"].as_i64().unwrap_or(900), u["output"].as_i64().unwrap_or(0));
        } else if let Some(e) = step.get("error") {
            result = json!({ "status": "ERROR", "error": e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()) });
            break;
        } else if let Some(r) = step.get("result") {
            result = r.clone();
            break;
        } else if let Some(raw) = step.get("raw") {
            agy.emit(raw.clone());
        } else {
            agy.log("unknown_step", json!({ "step": step }));
        }
    }
    if result["response"].is_null() {
        result["response"] = json!(turn.text);
    }
    result["conversation_id"] = json!(agy.conversation);
    agy.emit(json!({ "event": "result", "result": result }));
    agy.log("turn_end", json!({ "script": script, "status": result["status"], "ms": started.elapsed().as_millis() as u64 }));
}

pub fn run(raw: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let agent = std::env::var("ORGTREE_AGENT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "probe".into());
    let dir = std::env::var("ORGTREE_FAKECLI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let arg = |name: &str| raw.iter().position(|a| a == name).and_then(|i| raw.get(i + 1)).cloned();
    let log = dir.as_ref().and_then(|d| {
        let p = d.join("log");
        let _ = std::fs::create_dir_all(&p);
        std::fs::OpenOptions::new().create(true).append(true).open(p.join(format!("{agent}.jsonl"))).ok()
    });
    let given = arg("--conversation");
    let agy = Agy {
        out: Mutex::new(std::io::stdout()),
        log: Mutex::new(log),
        agent,
        dir,
        cwd: cwd.clone(),
        model: arg("--model").unwrap_or_else(|| "gemini-3.8-flash".into()),
        conversation: given.clone().unwrap_or_else(|| format!("conv-{:x}-{:x}", now_ms(), std::process::id())),
        resumed: given.is_some(),
    };
    agy.log("start", json!({ "args": raw, "cwd": cwd, "model": agy.model, "conversation": agy.conversation, "resumed": agy.resumed,
                             "steer_dir": std::env::var("ORGTREE_AGY_STEER_DIR").ok(), "org": std::env::var("ORGTREE_ORG").ok() }));
    let hooks = load_hooks(&cwd);
    agy.log("hooks", json!({ "hooks": hooks.iter().map(|h| json!({ "event": h.event, "matcher": h.matcher })).collect::<Vec<_>>() }));
    let mut mcp: Option<Mcp> = None;
    let mut first = true;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            agy.log("recv_raw", json!({ "line": line }));
            continue;
        };
        agy.log("recv", json!({ "line": v }));
        if v["event"] == "user" {
            let text = v["message"]["content"].as_str().map(str::to_string).unwrap_or_else(|| v["message"]["content"].to_string());
            run_turn(&agy, &hooks, &mut mcp, &text, &mut first);
        }
    }
    agy.log("exit", json!({ "code": 0, "why": "stdin closed" }));
    0
}
