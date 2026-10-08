//! The Codex stand-in: `codex app-server`, JSON-RPC 2.0 over stdio, as the
//! engine drives it (src/runtime/codex.rs): initialize, thread/start or
//! thread/resume (a rollout file under CODEX_HOME/sessions, so a resume finds
//! it), turn/start, turn/steer (mid-turn mail), turn/interrupt, model/list and
//! the account reads. A turn plays the same scenario steps as the Claude
//! stand-in: text and thinking become agentMessage and reasoning items with
//! their deltas, an `orgtree_*` tool becomes a dynamicToolCall answered by the
//! engine (`item/tool/call`), any other tool a commandExecution (optionally
//! behind an approval request), and the turn ends with thread/tokenUsage/updated
//! and turn/completed.
//!
//! Extra steps for this stand-in:
//!   {"error": {"message": "...", "codexErrorInfo": ...}, "will_retry": false}
//!       an `error` notification; without will_retry the turn fails with it
//!   {"result": {"status": "failed" | "interrupted" | "completed", "error": {...}}}
//!       end the turn with that status
//!   {"tool": "shell", "args": {"command": "..."}, "result": "...", "exit_code": 0,
//!    "approval": true}   a command, asking the engine's approval first
//!   {"usage": {"input": 1200, "cached": 900, "output": 80}}   this turn's tokens
//!   {"rate_limit": {...}}   an account/rateLimits/updated notification
//!   {"poll_mail": {"every_ms": 500, "timeout_ms": 30000}}   wait for turn/steer

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{iso_now, load_json, now_ms, pick_for, save_json};

pub const VERSION: &str = "codex-cli 0.999.0 (Codex fake)";

/// What `model/list` offers: the engine's Codex tiers' models, every effort.
const MODELS: &[&str] = &["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-reserve"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

struct Thread {
    id: String,
    path: PathBuf,
}

struct Srv {
    out: Mutex<std::io::Stdout>,
    log: Mutex<Option<std::fs::File>>,
    waiters: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
    interrupted: AtomicBool,
    seq: AtomicU64,
    agent: String,
    dir: Option<PathBuf>,
    home: PathBuf,
    cwd: PathBuf,
    thread: Mutex<Option<Thread>>,
    turn: Mutex<Option<String>>,
    steers: Mutex<VecDeque<String>>,
}

impl Srv {
    fn next(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn uid(&self) -> String {
        let n = self.next();
        let t = now_ms() as u64;
        let p = std::process::id() as u64;
        format!("{:08x}-{:04x}-7{:03x}-8{:03x}-{:012x}", (t & 0xffff_ffff) as u32, (p & 0xffff) as u16, (n >> 12) & 0xfff, n & 0xfff, (t >> 8) ^ (p << 20) ^ n)
    }

    fn log(&self, kind: &str, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.insert("ts".into(), json!(iso_now()));
            o.insert("pid".into(), json!(std::process::id()));
            o.insert("kind".into(), json!(kind));
            o.insert("mode".into(), json!("codex"));
        }
        // one write per line: the engine's probes share a log and are killed mid-run
        if let Ok(mut g) = self.log.lock() {
            if let Some(f) = g.as_mut() {
                let _ = f.write_all(format!("{v}\n").as_bytes());
            }
        }
    }

    fn send(&self, v: &Value) {
        if let Ok(mut out) = self.out.lock() {
            let _ = writeln!(out, "{v}");
            let _ = out.flush();
        }
        self.log("send", json!({ "line": v }));
    }

    fn notify(&self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn respond(&self, id: &Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn fail(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }));
    }

    /// A request to the engine (a tool call, an approval) and its answer.
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Option<Value> {
        let id = 900_000 + self.next() as i64;
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let got = rx.recv_timeout(timeout).ok();
        self.waiters.lock().unwrap().remove(&id);
        if got.is_none() {
            self.log("timeout", json!({ "method": method, "id": id }));
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

    fn thread_id(&self) -> String {
        self.thread.lock().unwrap().as_ref().map(|t| t.id.clone()).unwrap_or_default()
    }

    /// One record in the thread's rollout file (what a resume looks for).
    fn rollout(&self, kind: &str, payload: Value) {
        let path = self.thread.lock().unwrap().as_ref().map(|t| t.path.clone());
        if let Some(p) = path {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "{}", json!({ "timestamp": iso_now(), "type": kind, "payload": payload }));
            }
        }
    }

    /// Mid-turn input the engine steered in, taken (the model "reads" it).
    fn take_steers(&self) -> Vec<String> {
        self.steers.lock().unwrap().drain(..).collect()
    }
}

/// `<home>/sessions/YYYY/MM/DD/rollout-<stamp>-<thread>.jsonl`, or the existing one.
fn find_rollout(home: &Path, thread: &str) -> Option<PathBuf> {
    let suffix = format!("{thread}.jsonl");
    let mut stack = vec![(home.join("sessions"), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 4 {
                    stack.push((p, depth + 1));
                }
            } else if p.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(&suffix)).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

fn new_rollout(home: &Path, thread: &str) -> PathBuf {
    let now = iso_now();
    let dir = home.join("sessions").join(&now[0..4]).join(&now[5..7]).join(&now[8..10]);
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("rollout-{}-{thread}.jsonl", now[..19].replace(':', "-")))
}

fn handle(srv: &Srv, id: &Value, method: &str, p: &Value, tx: &mpsc::Sender<(String, String)>) {
    match method {
        "initialize" => srv.respond(id, json!({ "userAgent": VERSION, "codexHome": srv.home })),
        "thread/start" => {
            let tid = srv.uid();
            let path = new_rollout(&srv.home, &tid);
            *srv.thread.lock().unwrap() = Some(Thread { id: tid.clone(), path: path.clone() });
            srv.rollout("session_meta", json!({ "id": tid, "cwd": p["cwd"], "originator": "orgtree-fakecli", "cli_version": VERSION }));
            srv.log("thread", json!({ "action": "start", "thread": tid, "model": p["model"], "sandbox": p["sandbox"],
                                      "tools": p["dynamicTools"].as_array().map(|a| a.len()).unwrap_or(0) }));
            srv.respond(id, json!({ "thread": { "id": tid, "path": path, "preview": "", "modelProvider": "openai", "createdAt": now_ms() / 1000 },
                                    "model": p["model"], "cwd": p["cwd"] }));
        }
        "thread/resume" => {
            let tid = p["threadId"].as_str().unwrap_or("").to_string();
            match find_rollout(&srv.home, &tid) {
                Some(path) => {
                    *srv.thread.lock().unwrap() = Some(Thread { id: tid.clone(), path: path.clone() });
                    srv.log("thread", json!({ "action": "resume", "thread": tid, "model": p["model"] }));
                    srv.respond(id, json!({ "thread": { "id": tid, "path": path, "preview": "", "modelProvider": "openai" }, "model": p["model"] }));
                }
                None => {
                    srv.log("thread", json!({ "action": "resume_failed", "thread": tid }));
                    srv.fail(id, -32600, &format!("no rollout found for thread id {tid}"));
                }
            }
        }
        "turn/start" => {
            if srv.thread.lock().unwrap().is_none() {
                srv.fail(id, -32600, "no thread: start or resume one first");
                return;
            }
            let turn = format!("turn-{}", srv.next());
            *srv.turn.lock().unwrap() = Some(turn.clone());
            srv.steers.lock().unwrap().clear();
            let text = p["input"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            srv.respond(id, json!({ "turn": { "id": turn, "status": "inProgress", "items": [], "error": null } }));
            let _ = tx.send((turn, text));
        }
        "turn/steer" => {
            let current = srv.turn.lock().unwrap().clone();
            match current {
                Some(t) if p["expectedTurnId"].as_str().map(|e| e == t).unwrap_or(true) => {
                    let text = p["input"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"))
                        .unwrap_or_default();
                    srv.steers.lock().unwrap().push_back(text.clone());
                    srv.log("steer", json!({ "turn": t, "text": text }));
                    srv.respond(id, json!({ "turnId": t }));
                }
                _ => srv.fail(id, -32600, "no active turn to steer"),
            }
        }
        "turn/interrupt" => {
            srv.interrupted.store(true, Ordering::SeqCst);
            srv.log("interrupt", json!({ "turn": p["turnId"] }));
            srv.respond(id, json!({}));
        }
        "model/list" => {
            let data: Vec<Value> = MODELS
                .iter()
                .enumerate()
                .map(|(i, m)| {
                    json!({ "id": m, "model": m, "displayName": m, "hidden": false, "isDefault": i == 0, "defaultReasoningEffort": "high",
                            "supportedReasoningEfforts": EFFORTS.iter().map(|e| json!({ "reasoningEffort": e, "description": "" })).collect::<Vec<_>>() })
                })
                .collect();
            srv.respond(id, json!({ "data": data, "nextCursor": null }));
        }
        "account/read" => srv.respond(id, json!({ "account": { "type": "chatgpt", "email": "rig@example.invalid", "planType": "pro" },
                                                  "requiresOpenaiAuth": false })),
        "account/rateLimits/read" => {
            let now = (now_ms() / 1000) as i64;
            srv.respond(id, json!({ "rateLimits": {
                "primary": { "usedPercent": 10, "windowDurationMins": 300, "resetsAt": now + 3600 },
                "secondary": { "usedPercent": 20, "windowDurationMins": 10080, "resetsAt": now + 3 * 86_400 } } }));
        }
        other => {
            srv.log("unknown_request", json!({ "method": other }));
            srv.fail(id, -32601, &format!("method not found: {other}"));
        }
    }
}

fn reader(srv: Arc<Srv>, tx: mpsc::Sender<(String, String)>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            srv.log("recv_raw", json!({ "line": line }));
            continue;
        };
        srv.log("recv", json!({ "line": v }));
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        match (has_id, v["method"].as_str()) {
            (true, Some(m)) => handle(&srv, &v["id"], m, &v["params"], &tx),
            (true, None) => {
                if let Some(w) = v["id"].as_i64().and_then(|id| srv.waiters.lock().unwrap().remove(&id)) {
                    let _ = w.send(v);
                }
            }
            _ => {}
        }
    }
    // the app-server ends with its client, even mid-turn (waiting on a tool call)
    srv.log("exit", json!({ "code": 0, "why": "stdin closed" }));
    std::process::exit(0);
}

// ------------------------------------------------------------ one turn

#[derive(Default, Clone, Copy)]
struct Tokens {
    input: i64,
    cached: i64,
    output: i64,
}

fn agent_message(srv: &Srv, turn: &str, text: &str, chunk: usize, delay: u64) -> bool {
    let id = format!("msg_{}", srv.next());
    let th = srv.thread_id();
    srv.notify("item/started", json!({ "threadId": th, "turnId": turn, "item": { "type": "agentMessage", "id": id, "text": "" } }));
    let chars: Vec<char> = text.chars().collect();
    for piece in chars.chunks(chunk.max(1)) {
        let s: String = piece.iter().collect();
        srv.notify("item/agentMessage/delta", json!({ "threadId": th, "turnId": turn, "itemId": id, "delta": s }));
        if delay > 0 && !srv.pause(delay) {
            return false;
        }
    }
    srv.notify("item/completed", json!({ "threadId": th, "turnId": turn, "item": { "type": "agentMessage", "id": id, "text": text } }));
    srv.rollout("response_item", json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] }));
    true
}

fn reasoning(srv: &Srv, turn: &str, text: &str, delay: u64) -> bool {
    let id = format!("rs_{}", srv.next());
    let th = srv.thread_id();
    srv.notify("item/started", json!({ "threadId": th, "turnId": turn, "item": { "type": "reasoning", "id": id, "summary": [], "content": [] } }));
    let chars: Vec<char> = text.chars().collect();
    for piece in chars.chunks(32) {
        let s: String = piece.iter().collect();
        srv.notify("item/reasoning/summaryTextDelta", json!({ "threadId": th, "turnId": turn, "itemId": id, "delta": s, "summaryIndex": 0 }));
        if delay > 0 && !srv.pause(delay) {
            return false;
        }
    }
    srv.notify("item/completed", json!({ "threadId": th, "turnId": turn, "item": { "type": "reasoning", "id": id, "summary": [text], "content": [] } }));
    true
}

/// An `orgtree_*` tool: a dynamic tool call the engine answers.
fn dynamic_tool(srv: &Srv, turn: &str, step: &Value) {
    let name = step["tool"].as_str().unwrap_or("").trim_start_matches("mcp__orgtree__").to_string();
    let args = if step["args"].is_null() { json!({}) } else { step["args"].clone() };
    let call = step["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("call_{}", srv.next()));
    let th = srv.thread_id();
    srv.notify("item/started", json!({ "threadId": th, "turnId": turn, "item": { "type": "dynamicToolCall", "id": call, "tool": name,
                                                                               "arguments": args, "status": "inProgress",
                                                                               "contentItems": null, "success": null } }));
    srv.rollout("response_item", json!({ "type": "function_call", "name": name, "arguments": args.to_string(), "call_id": call }));
    let resp = srv.request("item/tool/call", json!({ "threadId": th, "turnId": turn, "callId": call, "tool": name, "arguments": args }),
                           Duration::from_secs(300));
    let (items, ok) = match &resp {
        None => (json!([{ "type": "inputText", "text": "the engine did not answer the tool call" }]), false),
        Some(r) if !r["error"].is_null() => (json!([{ "type": "inputText", "text": r["error"]["message"].as_str().unwrap_or("error") }]), false),
        Some(r) => (r["result"]["contentItems"].clone(), r["result"]["success"].as_bool().unwrap_or(false)),
    };
    let text = items
        .as_array()
        .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    srv.notify("item/completed", json!({ "threadId": th, "turnId": turn, "item": { "type": "dynamicToolCall", "id": call, "tool": name,
                                                                                 "arguments": args, "status": if ok { "completed" } else { "failed" },
                                                                                 "contentItems": items, "success": ok } }));
    srv.rollout("response_item", json!({ "type": "function_call_output", "call_id": call, "output": text }));
    let mut check = json!({ "tool": name, "args": args, "is_error": !ok, "text": text });
    if let Some(want) = step["expect"].as_str() {
        check["expect"] = json!(want);
        check["ok"] = json!(text.to_lowercase().contains(&want.to_lowercase()));
    }
    if let Some(want) = step["expect_error"].as_bool() {
        check["expect_error"] = json!(want);
        check["ok"] = json!(check["ok"].as_bool().unwrap_or(true) && want == !ok);
    }
    srv.log("tool_result", check);
}

/// Any other tool: a command, optionally behind the engine's approval.
fn command(srv: &Srv, turn: &str, step: &Value) {
    let id = format!("cmd_{}", srv.next());
    let th = srv.thread_id();
    let cmd = step["args"]["command"].as_str().or(step["command"].as_str()).unwrap_or("echo fake").to_string();
    let base = json!({ "type": "commandExecution", "id": id, "command": cmd, "cwd": srv.cwd, "commandActions": [] });
    let with = |extra: Value| {
        let mut v = base.clone();
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, x) in e {
                o.insert(k.clone(), x.clone());
            }
        }
        v
    };
    srv.notify("item/started", json!({ "threadId": th, "turnId": turn, "item": with(json!({ "status": "inProgress", "aggregatedOutput": null, "exitCode": null })) }));
    if step["approval"].as_bool() == Some(true) {
        let resp = srv.request("item/commandExecution/requestApproval",
                               json!({ "threadId": th, "turnId": turn, "itemId": id, "command": cmd, "cwd": srv.cwd,
                                       "reason": step["reason"].as_str().unwrap_or("the scenario asks") }),
                               Duration::from_secs(120));
        let decision = resp.as_ref().and_then(|r| r["result"]["decision"].as_str()).unwrap_or("none").to_string();
        srv.log("approval", json!({ "item": id, "command": cmd, "decision": decision }));
        if decision != "accept" && decision != "acceptForSession" {
            srv.notify("item/completed", json!({ "threadId": th, "turnId": turn, "item": with(json!({ "status": "declined", "aggregatedOutput": null, "exitCode": null })) }));
            srv.log("tool_result", json!({ "tool": "shell", "command": cmd, "declined": true }));
            return;
        }
    }
    if let Some(ms) = step["run_ms"].as_u64() {
        srv.pause(ms);
    }
    let out = step["result"].as_str().unwrap_or("").to_string();
    let code = step["exit_code"].as_i64().unwrap_or(0);
    srv.notify("item/completed", json!({ "threadId": th, "turnId": turn,
                                         "item": with(json!({ "status": if code == 0 { "completed" } else { "failed" }, "aggregatedOutput": out,
                                                              "exitCode": code, "durationMs": step["run_ms"].as_u64().unwrap_or(5) })) }));
    srv.log("tool_result", json!({ "tool": "shell", "command": cmd, "exit_code": code, "text": out }));
}

fn run_turn(srv: &Srv, turn: &str, prompt: &str, totals: &mut Tokens) {
    srv.interrupted.store(false, Ordering::SeqCst);
    let (script, steps) = pick_for(srv.dir.as_deref(), &srv.agent, prompt);
    let th = srv.thread_id();
    srv.log("turn", json!({ "script": script, "prompt": prompt, "steps": steps.len(), "turn": turn, "thread": th }));
    srv.rollout("response_item", json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": prompt }] }));
    srv.notify("turn/started", json!({ "threadId": th, "turn": { "id": turn, "status": "inProgress", "items": [], "error": null } }));
    let started = Instant::now();
    let mut used = Tokens { input: 1200, cached: 900, output: 0 };
    let mut status = "completed".to_string();
    let mut error = Value::Null;
    for step in &steps {
        if srv.interrupted.load(Ordering::SeqCst) {
            break;
        }
        srv.log("step", json!({ "step": step }));
        if let Some(t) = step["text"].as_str() {
            used.output += (t.len() as i64 / 4).max(1);
            if !agent_message(srv, turn, t, step["chunk"].as_u64().unwrap_or(24) as usize, step["delay_ms"].as_u64().unwrap_or(0)) {
                break;
            }
        } else if let Some(t) = step["thinking"].as_str() {
            if !reasoning(srv, turn, t, step["delay_ms"].as_u64().unwrap_or(0)) {
                break;
            }
        } else if let Some(name) = step["tool"].as_str() {
            if name.starts_with("orgtree_") || name.starts_with("mcp__orgtree__") {
                dynamic_tool(srv, turn, step);
            } else {
                command(srv, turn, step);
            }
        } else if let Some(p) = step.get("poll_mail") {
            let every = p["every_ms"].as_u64().unwrap_or(500);
            let until = Instant::now() + Duration::from_millis(p["timeout_ms"].as_u64().unwrap_or(30_000));
            let mut got = Vec::new();
            while Instant::now() < until && got.is_empty() {
                if !srv.pause(every) {
                    break;
                }
                got = srv.take_steers();
            }
            srv.log("poll_mail", json!({ "delivered": !got.is_empty(), "texts": got }));
        } else if let Some(ms) = step["sleep_ms"].as_u64() {
            if !srv.pause(ms) {
                break;
            }
        } else if let Some(code) = step.get("exit") {
            let code = code.as_i64().unwrap_or(1) as i32;
            srv.log("exit", json!({ "code": code, "why": "scripted" }));
            std::process::exit(code);
        } else if step["hang"].as_bool() == Some(true) {
            srv.log("hang", json!({}));
            while srv.pause(1000) {}
        } else if let Some(u) = step.get("usage") {
            used.input = u["input"].as_i64().unwrap_or(used.input);
            used.cached = u["cached"].as_i64().unwrap_or(used.cached);
            used.output = u["output"].as_i64().unwrap_or(used.output);
        } else if let Some(e) = step.get("error") {
            let retry = step["will_retry"].as_bool().unwrap_or(false);
            srv.notify("error", json!({ "threadId": th, "turnId": turn, "error": e, "willRetry": retry }));
            if !retry {
                status = "failed".into();
                error = e.clone();
                break;
            }
        } else if let Some(r) = step.get("result") {
            status = r["status"].as_str().unwrap_or("completed").to_string();
            error = r["error"].clone();
            break;
        } else if let Some(info) = step.get("rate_limit") {
            srv.notify("account/rateLimits/updated", json!({ "rateLimits": info }));
        } else if let Some(raw) = step.get("raw") {
            srv.send(raw);
        } else {
            srv.log("unknown_step", json!({ "step": step }));
        }
        let steered = srv.take_steers();
        if !steered.is_empty() {
            srv.log("steer_read", json!({ "texts": steered }));
        }
    }
    if srv.interrupted.load(Ordering::SeqCst) {
        status = "interrupted".into();
        srv.log("interrupted", json!({}));
    }
    totals.input += used.input;
    totals.cached += used.cached;
    totals.output += used.output;
    let tokens = |t: &Tokens| json!({ "inputTokens": t.input, "cachedInputTokens": t.cached, "outputTokens": t.output,
                                     "reasoningOutputTokens": 0, "totalTokens": t.input + t.output });
    srv.notify("thread/tokenUsage/updated", json!({ "threadId": th, "turnId": turn,
                                                    "tokenUsage": { "total": tokens(totals), "last": tokens(&used), "modelContextWindow": 272_000 } }));
    srv.notify("turn/completed", json!({ "threadId": th, "turn": { "id": turn, "status": status, "items": [], "error": error } }));
    *srv.turn.lock().unwrap() = None;
    srv.log("turn_end", json!({ "script": script, "status": status, "ms": started.elapsed().as_millis() as u64 }));
}

pub fn run(raw: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // the engine names the agent; its account and model probes run without one
    let agent = std::env::var("ORGTREE_AGENT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "probe".into());
    let dir = std::env::var("ORGTREE_FAKECLI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let home = std::env::var("CODEX_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("ORGTREE_FAKECLI_HOME").ok().filter(|s| !s.is_empty()).map(|h| PathBuf::from(h).join(".codex")))
        .unwrap_or_else(|| cwd.join(".codex"));
    let log = dir.as_ref().and_then(|d| {
        let p = d.join("log");
        let _ = std::fs::create_dir_all(&p);
        std::fs::OpenOptions::new().create(true).append(true).open(p.join(format!("{agent}.jsonl"))).ok()
    });
    let srv = Arc::new(Srv {
        out: Mutex::new(std::io::stdout()),
        log: Mutex::new(log),
        waiters: Mutex::new(HashMap::new()),
        interrupted: AtomicBool::new(false),
        seq: AtomicU64::new(0),
        agent: agent.clone(),
        dir,
        home: home.clone(),
        cwd: cwd.clone(),
        thread: Mutex::new(None),
        turn: Mutex::new(None),
        steers: Mutex::new(VecDeque::new()),
    });
    srv.log("start", json!({ "args": raw, "cwd": cwd, "codex_home": home, "codex_home_set": std::env::var("CODEX_HOME").is_ok(),
                             "api_key_set": std::env::var("OPENAI_API_KEY").is_ok(), "org": std::env::var("ORGTREE_ORG").ok() }));
    let (tx, rx) = mpsc::channel();
    {
        let srv = srv.clone();
        std::thread::spawn(move || reader(srv, tx));
    }
    // thread token totals carry over a resume, as Codex keeps them per thread
    let state_file = srv.dir.as_ref().map(|d| d.join("state").join(format!("{agent}.json")));
    // turns run here, one at a time; the reader ends the process when stdin closes
    for (turn, text) in rx {
        let th = srv.thread_id();
        let saved = state_file.as_ref().and_then(|p| load_json(p)).unwrap_or_else(|| json!({}));
        let t = &saved["codex_tokens"][&th];
        let mut totals = Tokens {
            input: t["input"].as_i64().unwrap_or(0),
            cached: t["cached"].as_i64().unwrap_or(0),
            output: t["output"].as_i64().unwrap_or(0),
        };
        run_turn(&srv, &turn, &text, &mut totals);
        if let Some(p) = &state_file {
            let mut s = load_json(p).filter(Value::is_object).unwrap_or_else(|| json!({}));
            if !s["codex_tokens"].is_object() {
                s["codex_tokens"] = json!({});
            }
            s["codex_tokens"][&th] = json!({ "input": totals.input, "cached": totals.cached, "output": totals.output });
            save_json(p, &s);
        }
    }
    0
}
