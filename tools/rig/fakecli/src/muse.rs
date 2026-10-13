//! The Muse Code stand-in: `muse serve`, the Muse Session Protocol (MSP v1,
//! JSON-RPC 2.0, one object per stdio line) as the engine drives it
//! (src/runtime/muse.rs and src/providers/muse_models.rs): initialize (schema
//! v1, `sessionMcp` granted when requested), account/read, model/list,
//! usage/read, session/start | resume (a session id kept in the agent's state
//! file, so a resume finds it), session/setModel | setApprovalMode |
//! setPermissionProfile, turn/start (the turn id is the command id),
//! turn/steer (the exact running turn only), turn/interrupt, turn/cancel,
//! session/compact and subagent/stop. A turn plays the same scenario steps as
//! the other stand-ins: text and thinking become agentMessage and reasoning
//! items with their deltas, an `orgtree_*` tool a toolCall answered through
//! the session's own MCP server (the engine's `mcp-bridge`, started from
//! session/start's `config.mcpServers.orgtree`), any other tool a toolCall,
//! behind `approval/request` when the step asks.
//!
//! Extra steps for this stand-in:
//!   {"quota": {"resetsAtMs": 1900000000000}}   end the turn failed with a
//!       typed quota refusal (`error.kind` modelError, `error.quota`)
//!   {"fail": {"kind": "authRequired", "message": "...", "retryable": false}}
//!   {"usage": {"input": 1200, "cached": 900, "output": 80}}   one model request's tokens
//!   {"usage_changed": {"window": 40, "weekly": 12}}   a usage/changed notification
//!   {"subagent": {"role": "...", "objective": "...", "run_ms": 3000}}   a child run
//!   {"reminder": true}   a reminder child (Orgtree switches them off; the proof
//!       checks the engine records one that appears anyway)
//!   {"tool": "write_file", "args": {"path": "..."}, "native_write": true}   a
//!       write Muse's own root rules decide: inside one of the session's
//!       workspace roots it runs unasked, outside it asks (`approval/request`)
//! A catalog file `{"fail": "..."}` makes that login's model/list fail.
//! A login's account/read answer: its own `<XDG_CONFIG_HOME>/muse-account.json`
//! when present (`{"state": "loggedOut"}`, or `{"fail": "..."}` for a read that
//! fails), the user's own login's `<fakecli dir>/muse-account.json`, else signed in.
//! Workspace roots are sticky per session, as in MSP: session/start sets them,
//! a resume restores the stored set, turn/start's `workspaceRoots` replaces
//! it and its absence keeps it. The session log records each set, and the
//! servers' configuration as received (a proof's sentinel control).
//!   {"unsolicited": true}   a turn the engine did not start (as a cron fires one)
//!   {"poll_mail": {"every_ms": 500, "timeout_ms": 30000}}, {"sleep_ms": N},
//!   {"hang": true}, {"exit": N}
//! The catalog `model/list` answers is the login's own
//! `<XDG_CONFIG_HOME>/muse-catalog.json` when present (one login's
//! entitlement, as a fixture), else `<fakecli dir>/muse-catalog.json`, else
//! three account rows (Wonder, Spark 1.3, Spark 1.2) and a bundled Wonder
//! Full row (no profile: never an entitlement). The file's optional `delayMs`
//! holds the answer back that long (a turn that arrives while discovery is
//! still reading the catalog) and is not part of it.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{iso_now, load_json, now_ms, pick_for, save_json};

pub const VERSION: &str = "muse 9.9.9-R0 (Muse fake)";
/// The engine's verified stable-surface fingerprint (muse_models::VERIFIED_FINGERPRINTS).
const FINGERPRINT: &str = "sha256:eae467ab60cb9a5d5af4de616830f065e59375c987fd59269c8cc33ed2a1137f";

struct Srv {
    out: Mutex<std::io::Stdout>,
    log: Mutex<Option<std::fs::File>>,
    waiters: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
    /// approval id → the choice the engine decided (`approval/decide`)
    decisions: Mutex<HashMap<String, mpsc::Sender<String>>>,
    interrupted: AtomicBool,
    seq: AtomicU64,
    agent: String,
    dir: Option<PathBuf>,
    session: Mutex<Option<String>>,
    turn: Mutex<Option<String>>,
    model: Mutex<String>,
    steers: Mutex<VecDeque<String>>,
    /// the session's MCP servers as session/start or resume named them
    servers: Mutex<Value>,
    /// the session's workspace roots (sticky, as MSP keeps them)
    roots: Mutex<Vec<String>>,
    cancelled: Mutex<Vec<String>>,
    stopped: Mutex<Vec<String>>,
}

impl Srv {
    fn next(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// A UUIDv7-shaped id (time first), as Muse mints them.
    fn uid(&self) -> String {
        let n = self.next();
        let t = now_ms() as u64;
        let p = std::process::id() as u64;
        format!("{:08x}-{:04x}-7{:03x}-8{:03x}-{:012x}", (t >> 16) as u32, (t & 0xffff) as u16, (p ^ n) & 0xfff, n & 0xfff, (t << 8) ^ (p << 20) ^ n)
    }

    fn log(&self, kind: &str, mut v: Value) {
        if let Some(o) = v.as_object_mut() {
            o.insert("ts".into(), json!(iso_now()));
            o.insert("pid".into(), json!(std::process::id()));
            o.insert("kind".into(), json!(kind));
            o.insert("mode".into(), json!("muse"));
        }
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

    fn notify(&self, method: &str, mut params: Value) {
        if let Some(o) = params.as_object_mut() {
            o.insert("viewCursor".into(), json!(format!("v:{}", self.next())));
        }
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn respond(&self, id: &Value, result: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn fail(&self, id: &Value, code: i64, message: &str, kind: &str) {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": { "kind": kind } } }));
    }

    /// A request to the engine and its answer (an approval's receipt).
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Option<Value> {
        let id = 900_000 + self.next() as i64;
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let got = rx.recv_timeout(timeout).ok();
        self.waiters.lock().unwrap().remove(&id);
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

    fn sid(&self) -> String {
        self.session.lock().unwrap().clone().unwrap_or_default()
    }

    fn take_steers(&self) -> Vec<String> {
        self.steers.lock().unwrap().drain(..).collect()
    }

    fn state_file(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("state").join(format!("{}.json", self.agent)))
    }
}

fn text_of(input: &Value) -> String {
    input.as_array().map(|a| a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

/// The login's account/read answer: its own `<XDG_CONFIG_HOME>/muse-account.json`
/// (a fixture: `{"state": "loggedOut"}`, or `{"fail": "..."}` for a read that
/// fails), the user's own login's `<fakecli dir>/muse-account.json`, else signed in.
fn account_doc(dir: Option<&Path>) -> Value {
    let doc = match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
        Some(own) => load_json(&own.join("muse-account.json")),
        None => dir.and_then(|d| load_json(&d.join("muse-account.json"))),
    };
    doc.unwrap_or_else(|| json!({ "state": "accountLogin", "label": "rig@example.invalid", "credentialRequired": true }))
}

fn catalog(dir: Option<&Path>) -> Value {
    let own = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    if let Some(c) = own.as_deref().into_iter().chain(dir).find_map(|d| load_json(&d.join("muse-catalog.json"))) {
        return c;
    }
    let row = |id: &str, profile: Value, variants: &[&str], default: &str, is_default: bool| json!({
        "modelId": id, "profileId": profile, "isDefault": is_default, "variants": variants, "defaultReasoningEffort": default,
        "contextLimit": if profile.is_null() { Value::Null } else { json!(1_007_997) },
        "outputLimit": if profile.is_null() { Value::Null } else { json!(128_000) } });
    let all = ["minimal", "low", "medium", "high", "xhigh", "max"];
    json!({ "source": "providerCatalog", "models": [
        row("muse-wonder-1.0", json!("tbh"), &all, "high", true),
        row("muse-spark-1.3", json!("tbh"), &all, "max", false),
        row("muse-spark-1.2", json!("tbh"), &all[..5], "high", false),
        row("muse-wonder-full-1.0", Value::Null, &all[..5], "high", false),
    ] })
}

fn usage_doc(window: f64, weekly: f64) -> Value {
    let now = now_ms() as i64;
    json!({ "window": { "usedPercent": window, "windowDurationMins": 300, "resetsAtMs": now + 3_600_000 },
            "weekly": { "usedPercent": weekly, "resetsAtMs": now + 3 * 86_400_000 },
            "tier": "rig-tier", "observedAtMs": now })
}

/// A turn the server accepted, with the script it plays.
struct Job {
    turn: String,
    prompt: String,
    script: String,
    steps: Vec<Value>,
    effort: Option<String>,
}

fn known_sessions(srv: &Srv) -> Vec<String> {
    srv.state_file().and_then(|p| load_json(&p))
        .and_then(|s| s["muse_sessions"].as_array().cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// A path folded for comparison: no `\\?\` prefix, backslashes, lower case.
fn fold(p: &str) -> String {
    p.trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Whether `path` lies in one of the session's workspace roots.
fn in_roots(srv: &Srv, path: &str) -> bool {
    let p = fold(path);
    srv.roots.lock().unwrap().iter().map(|r| fold(r)).any(|r| p == r || p.starts_with(&format!("{r}\\")))
}

/// Keep `roots` as the session's stored set (a later resume restores it).
fn store_roots(srv: &Srv, sid: &str, roots: &[String]) {
    *srv.roots.lock().unwrap() = roots.to_vec();
    let Some(p) = srv.state_file() else { return };
    let mut s = load_json(&p).filter(Value::is_object).unwrap_or_else(|| json!({}));
    if !s["muse_roots"].is_object() {
        s["muse_roots"] = json!({});
    }
    s["muse_roots"][sid] = json!(roots);
    save_json(&p, &s);
}

fn stored_roots(srv: &Srv, sid: &str) -> Vec<String> {
    srv.state_file().and_then(|p| load_json(&p))
        .and_then(|s| s["muse_roots"][sid].as_array().cloned())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
}

fn remember_session(srv: &Srv, sid: &str) {
    let Some(p) = srv.state_file() else { return };
    let mut s = load_json(&p).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let mut list = s["muse_sessions"].as_array().cloned().unwrap_or_default();
    if !list.iter().any(|x| x == sid) {
        list.push(json!(sid));
    }
    s["muse_sessions"] = json!(list);
    save_json(&p, &s);
}

fn handle(srv: &Srv, id: &Value, method: &str, p: &Value, tx: &mpsc::Sender<Job>) {
    match method {
        "initialize" => {
            let wants_mcp = p.pointer("/capabilities/requestedCapabilities").and_then(Value::as_array)
                .is_some_and(|a| a.iter().any(|c| c == "sessionMcp"));
            srv.log("initialize", json!({ "client": p["clientInfo"], "experimental": p.pointer("/capabilities/experimentalApi"),
                                          "requested": p.pointer("/capabilities/requestedCapabilities") }));
            srv.respond(id, json!({ "serverInfo": { "name": "muse", "version": "9.9.9" }, "userAgent": VERSION,
                                    "schema": { "version": 1, "fingerprint": FINGERPRINT },
                                    "grantedCapabilities": if wants_mcp { json!(["sessionMcp"]) } else { json!([]) },
                                    "experimentalApi": true, "sessionDurability": "durable" }));
        }
        "account/read" => {
            let doc = account_doc(srv.dir.as_deref());
            match doc["fail"].as_str() {
                Some(msg) => srv.fail(id, -32603, msg, "internalError"),
                None => srv.respond(id, doc),
            }
        }
        "model/list" => {
            let mut c = catalog(srv.dir.as_deref());
            // a catalog file `{"fail": "..."}`: this login's catalog cannot be read
            if let Some(msg) = c["fail"].as_str().map(str::to_string) {
                srv.fail(id, -32603, &msg, "internalError");
                return;
            }
            if let Some(ms) = c.as_object_mut().and_then(|o| o.remove("delayMs")).and_then(|v| v.as_u64()) {
                std::thread::sleep(Duration::from_millis(ms));
            }
            srv.respond(id, c)
        }
        "usage/read" => srv.respond(id, json!({ "usage": usage_doc(10.0, 20.0) })),
        "session/start" => {
            let root = p["workspaceRoot"].as_str().unwrap_or("");
            // measured on Muse 1.4.6: a root that is not canonical is refused
            if cfg!(windows) && !root.starts_with(r"\\?\") {
                srv.log("session_refused", json!({ "root": root }));
                srv.fail(id, -32602, "workspaceRoot must be canonical", "invalidParams");
                return;
            }
            let sid = srv.uid();
            *srv.session.lock().unwrap() = Some(sid.clone());
            *srv.model.lock().unwrap() = p["modelId"].as_str().unwrap_or("muse-wonder-1.0").to_string();
            *srv.servers.lock().unwrap() = p.pointer("/config/mcpServers").cloned().unwrap_or(Value::Null);
            remember_session(srv, &sid);
            let roots = strings(&p["workspaceRoots"]).unwrap_or_else(|| vec![root.to_string()]);
            store_roots(srv, &sid, &roots);
            srv.log("session", json!({ "action": "start", "session": sid, "model": p["modelId"], "approval": p["approvalMode"],
                                       "profile": p["permissionProfile"], "roots": roots,
                                       "servers": p.pointer("/config/mcpServers").and_then(Value::as_object).map(|o| o.keys().cloned().collect::<Vec<_>>()),
                                       "server_config": p.pointer("/config/mcpServers") }));
            srv.respond(id, json!({ "session": { "sessionId": sid, "status": "idle", "modelId": p["modelId"] } }));
        }
        "session/resume" => {
            let sid = p["sessionId"].as_str().unwrap_or("").to_string();
            if known_sessions(srv).contains(&sid) {
                *srv.session.lock().unwrap() = Some(sid.clone());
                *srv.servers.lock().unwrap() = p.pointer("/config/mcpServers").cloned().unwrap_or(Value::Null);
                // resume admits no roots: the session keeps the set it last had
                let roots = stored_roots(srv, &sid);
                *srv.roots.lock().unwrap() = roots.clone();
                srv.log("session", json!({ "action": "resume", "session": sid, "exclude_items": p["excludeItems"],
                                           "roots": roots, "server_config": p.pointer("/config/mcpServers") }));
                srv.respond(id, json!({ "session": { "sessionId": sid, "status": "idle" } }));
            } else {
                srv.log("session", json!({ "action": "resume_failed", "session": sid }));
                srv.fail(id, -32001, &format!("no session {sid}"), "sessionNotFound");
            }
        }
        "session/setModel" => {
            *srv.model.lock().unwrap() = p.pointer("/model/modelId").and_then(Value::as_str).unwrap_or("").to_string();
            srv.log("posture", json!({ "set": "model", "value": p["model"] }));
            srv.respond(id, json!({ "status": "accepted" }));
        }
        "session/setApprovalMode" | "session/setPermissionProfile" => {
            srv.log("posture", json!({ "set": method, "value": p.get("mode").or(p.get("profileId")) }));
            srv.respond(id, json!({ "status": "accepted" }));
        }
        "turn/start" => {
            if srv.session.lock().unwrap().is_none() {
                srv.fail(id, -32600, "no session: start or resume one first", "invalidRequest");
                return;
            }
            let prompt = text_of(&p["input"]);
            let images = p["input"].as_array().map(|a| a.iter().filter(|x| x["type"] == "image").count()).unwrap_or(0);
            let (script, steps) = pick_for(srv.dir.as_deref(), &srv.agent, &prompt);
            if let Some(msg) = steps.first().and_then(|s| s["start_error"].as_str()) {
                srv.log("turn_refused", json!({ "script": script, "message": msg }));
                srv.fail(id, -32603, msg, "internalError");
                return;
            }
            // MSP: a fresh turn's id is its command id
            let turn = p["commandId"].as_str().map(str::to_string).unwrap_or_else(|| srv.uid());
            let busy = srv.turn.lock().unwrap().is_some();
            *srv.turn.lock().unwrap() = Some(turn.clone());
            srv.steers.lock().unwrap().clear();
            // a sticky replacement of the root set; absent, the set is unchanged
            let sent = strings(&p["workspaceRoots"]);
            if let (Some(roots), Some(sid)) = (&sent, srv.session.lock().unwrap().clone()) {
                store_roots(srv, &sid, roots);
            }
            let roots = srv.roots.lock().unwrap().clone();
            srv.log("turn_start", json!({ "turn": turn, "if_busy": p["ifBusy"], "effort": p["reasoningEffort"], "images": images,
                                          "roots_sent": sent.is_some(), "roots": roots }));
            srv.respond(id, json!({ "commandId": p["commandId"], "turnId": turn, "status": "accepted",
                                    "disposition": if busy { "queued" } else { "started" }, "startedNewTurn": !busy }));
            let _ = tx.send(Job { turn, prompt, script, steps, effort: p["reasoningEffort"].as_str().map(str::to_string) });
        }
        "turn/steer" => {
            let current = srv.turn.lock().unwrap().clone();
            match current {
                Some(t) if p["expectedTurnId"].as_str() == Some(t.as_str()) => {
                    let text = text_of(&p["input"]);
                    srv.steers.lock().unwrap().push_back(text.clone());
                    srv.log("steer", json!({ "turn": t, "text": text }));
                    srv.respond(id, json!({ "commandId": p["commandId"], "turnId": t, "status": "accepted" }));
                }
                _ => srv.fail(id, -32002, "the expected turn is not running", "turnMismatch"),
            }
        }
        "turn/interrupt" => {
            srv.interrupted.store(true, Ordering::SeqCst);
            srv.log("interrupt", json!({ "turn": p["turnId"] }));
            srv.respond(id, json!({ "commandId": p["commandId"], "turnId": p["turnId"], "status": "accepted" }));
        }
        "turn/cancel" => {
            let t = p["turnId"].as_str().unwrap_or("").to_string();
            srv.cancelled.lock().unwrap().push(t.clone());
            srv.log("cancel", json!({ "turn": t }));
            srv.respond(id, json!({ "commandId": p["commandId"], "turnId": t, "status": "accepted" }));
        }
        "subagent/stop" => {
            let s = p["subagentId"].as_str().unwrap_or("").to_string();
            srv.stopped.lock().unwrap().push(s.clone());
            srv.log("subagent_stop", json!({ "subagent": s, "reason": p["reason"] }));
            srv.respond(id, json!({ "status": "accepted" }));
        }
        "session/compact" => {
            srv.log("compact", json!({ "session": p["sessionId"] }));
            srv.respond(id, json!({ "commandId": p["commandId"], "status": "accepted" }));
            let item = srv.uid();
            srv.notify("item/started", json!({ "sessionId": srv.sid(), "item": { "itemId": item, "kind": "compaction", "turnId": null,
                                                                                  "revision": 1, "status": "inProgress", "trigger": "manual" } }));
            srv.notify("item/completed", json!({ "sessionId": srv.sid(), "item": { "itemId": item, "kind": "compaction", "turnId": null,
                                                                                    "revision": 2, "status": "completed", "trigger": "manual",
                                                                                    "outcome": "compacted", "tokensBefore": 9000, "tokensAfter": 1200 } }));
        }
        "approval/decide" => {
            let aid = p["approvalId"].as_str().unwrap_or("").to_string();
            let choice = p["choiceId"].as_str().unwrap_or("").to_string();
            srv.log("decide", json!({ "approval": aid, "choice": choice }));
            if let Some(w) = srv.decisions.lock().unwrap().remove(&aid) {
                let _ = w.send(choice);
            }
            srv.respond(id, json!({ "status": "accepted" }));
        }
        "userInput/cancel" => srv.respond(id, json!({ "status": "accepted" })),
        other => {
            srv.log("unknown_request", json!({ "method": other }));
            srv.fail(id, -32601, &format!("method not found: {other}"), "methodNotFound");
        }
    }
}

fn reader(srv: Arc<Srv>, tx: mpsc::Sender<Job>) {
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
            (false, Some("initialized")) => srv.log("initialized", json!({})),
            _ => {}
        }
    }
    // the host ends with its client, even mid-turn
    srv.log("exit", json!({ "code": 0, "why": "stdin closed" }));
    std::process::exit(0);
}

// ------------------------------------------------------------ the session's MCP servers

/// One session MCP server as session/start named it (stdio, line-delimited).
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Mcp {
    fn start(srv: &Srv, name: &str) -> Option<Mcp> {
        let cfg = srv.servers.lock().unwrap()[name].clone();
        let command = cfg["command"].as_str()?.to_string();
        let mut cmd = Command::new(&command);
        cmd.args(cfg["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default());
        if let Some(env) = cfg["env"].as_object() {
            for (k, v) in env {
                cmd.env(k, v.as_str().unwrap_or(""));
            }
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                srv.log("mcp_failed", json!({ "server": name, "command": command, "error": e.to_string() }));
                return None;
            }
        };
        let stdin = child.stdin.take()?;
        let stdout = BufReader::new(child.stdout.take()?);
        let mut mcp = Mcp { child, stdin, stdout, next: 0 };
        mcp.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": { "name": "muse-fake", "version": VERSION } }))?;
        let _ = writeln!(mcp.stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }));
        let _ = mcp.stdin.flush();
        let tools = mcp.request("tools/list", json!({}))?;
        srv.log("mcp_ready", json!({ "server": name, "tools": tools["result"]["tools"].as_array().map(|a| a.len()).unwrap_or(0) }));
        Some(mcp)
    }

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
            None => ("the MCP server did not answer".into(), true),
            Some(r) if !r["error"].is_null() => (r["error"]["message"].as_str().unwrap_or("error").to_string(), true),
            Some(r) => (
                r["result"]["content"].as_array()
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

// ------------------------------------------------------------ one turn

#[derive(Default, Clone, Copy)]
struct Tokens {
    input: i64,
    cached: i64,
    output: i64,
}

fn item(srv: &Srv, turn: &str, done: bool, mut it: Value) {
    if let Some(o) = it.as_object_mut() {
        o.insert("turnId".into(), json!(turn));
        o.insert("revision".into(), json!(if done { 2 } else { 1 }));
        o.entry("status").or_insert(json!(if done { "completed" } else { "inProgress" }));
    }
    srv.notify(if done { "item/completed" } else { "item/started" }, json!({ "sessionId": srv.sid(), "item": it }));
}

fn streamed(srv: &Srv, turn: &str, kind: &str, field: &str, text: &str, delay: u64) -> bool {
    let id = srv.uid();
    item(srv, turn, false, json!({ "itemId": id, "kind": kind }));
    let chars: Vec<char> = text.chars().collect();
    for piece in chars.chunks(24) {
        let s: String = piece.iter().collect();
        srv.notify("item/delta", json!({ "sessionId": srv.sid(), "itemId": id, "field": field, "delta": s }));
        if delay > 0 && !srv.pause(delay) {
            return false;
        }
    }
    let body = if kind == "reasoning" { json!({ "itemId": id, "kind": kind, "summary": [text] }) } else { json!({ "itemId": id, "kind": kind, "text": text }) };
    item(srv, turn, true, body);
    true
}

fn tool(srv: &Srv, turn: &str, step: &Value, mcp: &mut Option<Mcp>) {
    let raw = step["tool"].as_str().unwrap_or("");
    let orgtree = raw.starts_with("orgtree_") || raw.starts_with("mcp__orgtree__");
    let short = raw.trim_start_matches("mcp__orgtree__").to_string();
    let name = if orgtree { format!("mcp__orgtree__{short}") } else { raw.to_string() };
    let args = if step["args"].is_null() { json!({}) } else { step["args"].clone() };
    let id = srv.uid();
    let call = format!("call_{}", srv.next());
    let base = json!({ "itemId": id, "kind": "toolCall", "tool": name, "callId": call, "args": args.to_string() });
    item(srv, turn, false, base.clone());
    let finish = |status: &str, output: &str, reason: Option<&str>| {
        let mut done = base.clone();
        done["status"] = json!(status);
        done["visibleOutput"] = json!(output);
        if let Some(r) = reason {
            done["failureReason"] = json!(r);
        }
        item(srv, turn, true, done);
    };
    // Muse's own root rules: a write inside a workspace root runs unasked
    let native = step["native_write"].as_bool() == Some(true);
    let in_root = native && args["path"].as_str().is_some_and(|p| in_roots(srv, p));
    if native {
        srv.log("native_write", json!({ "path": args["path"], "in_root": in_root, "roots": srv.roots.lock().unwrap().clone() }));
    }
    if step["approval"].as_bool() == Some(true) || (native && !in_root) {
        let aid = srv.uid();
        let (dtx, drx) = mpsc::channel();
        srv.decisions.lock().unwrap().insert(aid.clone(), dtx);
        let subject = step.get("subject").cloned().unwrap_or_else(|| if native {
            json!({ "kind": "fileAccess", "access": "write", "path": args["path"] })
        } else {
            json!({ "kind": "shell", "command": args["command"] })
        });
        let receipt = srv.request("approval/request", json!({ "sessionId": srv.sid(), "approvalId": aid, "toolName": name,
            "subject": subject, "currentRequirementId": "req-1", "rawArgs": args.to_string(),
            "availableChoices": [
                { "choiceId": "allow-once", "decision": "approved", "scope": "once" },
                { "choiceId": "allow-session", "decision": "approved", "scope": "session" },
                { "choiceId": "deny-once", "decision": "denied", "scope": "once" } ] }), Duration::from_secs(30));
        let choice = drx.recv_timeout(Duration::from_secs(30)).unwrap_or_default();
        srv.log("approval", json!({ "approval": aid, "receipt": receipt.map(|r| r["result"].clone()), "choice": choice }));
        if choice != "allow-once" && choice != "allow-session" {
            finish("rejected", "", Some("the approval was denied"));
            srv.log("tool_result", json!({ "tool": name, "declined": true, "choice": choice }));
            return;
        }
    }
    let (text, failed) = if orgtree {
        if mcp.is_none() {
            *mcp = Mcp::start(srv, "orgtree");
        }
        match mcp.as_mut() {
            Some(m) => m.call(&short, &args),
            None => ("the orgtree MCP server could not be started".into(), true),
        }
    } else {
        if let Some(ms) = step["run_ms"].as_u64() {
            srv.pause(ms);
        }
        (step["result"].as_str().unwrap_or("ok").to_string(), step["is_error"].as_bool().unwrap_or(false))
    };
    finish(if failed { "failed" } else { "completed" }, &text, failed.then_some("the tool failed"));
    let mut check = json!({ "tool": name, "args": args, "is_error": failed, "text": text });
    if let Some(want) = step["expect"].as_str() {
        check["expect"] = json!(want);
        check["ok"] = json!(text.to_lowercase().contains(&want.to_lowercase()));
    }
    if let Some(want) = step["expect_error"].as_bool() {
        check["expect_error"] = json!(want);
        check["ok"] = json!(check["ok"].as_bool().unwrap_or(true) && want == failed);
    }
    srv.log("tool_result", check);
}

fn request_usage(srv: &Srv, turn: &str, t: &Tokens, totals: &mut Tokens) {
    totals.input += t.input;
    totals.cached += t.cached;
    totals.output += t.output;
    let model = srv.model.lock().unwrap().clone();
    srv.notify("session/tokenUsage", json!({ "sessionId": srv.sid(), "turnId": turn, "modelId": model,
        "usage": { "inputTokens": t.input, "outputTokens": t.output, "cachedTokens": t.cached, "cacheWriteTokens": 0,
                   "cacheReadTokens": t.cached, "reasoningTokens": 0 },
        "promptTokens": t.input, "totalTokens": t.input + t.output,
        "cumulative": { "promptTokens": totals.input, "outputTokens": totals.output, "totalTokens": totals.input + totals.output,
                        "cacheReadTokens": totals.cached } }));
}

fn run_turn(srv: &Srv, job: &Job, mcp: &mut Option<Mcp>, totals: &mut Tokens) {
    srv.interrupted.store(false, Ordering::SeqCst);
    let turn = job.turn.as_str();
    srv.log("turn", json!({ "script": job.script, "prompt": job.prompt, "steps": job.steps.len(), "turn": turn,
                            "effort": job.effort, "model": *srv.model.lock().unwrap() }));
    srv.notify("turn/started", json!({ "sessionId": srv.sid(), "turnId": turn, "commandId": turn }));
    item(srv, turn, true, json!({ "itemId": srv.uid(), "kind": "userMessage", "text": job.prompt }));
    let started = Instant::now();
    let mut used = Tokens { input: 1200, cached: 900, output: 0 };
    let mut error = Value::Null;
    for step in job.steps.iter() {
        if srv.interrupted.load(Ordering::SeqCst) {
            break;
        }
        srv.log("step", json!({ "step": step }));
        if let Some(t) = step["text"].as_str() {
            used.output += (t.len() as i64 / 4).max(1);
            if !streamed(srv, turn, "agentMessage", "text", t, step["delay_ms"].as_u64().unwrap_or(0)) {
                break;
            }
        } else if let Some(t) = step["thinking"].as_str() {
            if !streamed(srv, turn, "reasoning", "summary.0", t, step["delay_ms"].as_u64().unwrap_or(0)) {
                break;
            }
        } else if step["tool"].is_string() {
            // each tool call is one more model request
            request_usage(srv, turn, &used, totals);
            used.output = 0;
            tool(srv, turn, step, mcp);
        } else if let Some(u) = step.get("usage") {
            used.input = u["input"].as_i64().unwrap_or(used.input);
            used.cached = u["cached"].as_i64().unwrap_or(used.cached);
            used.output = u["output"].as_i64().unwrap_or(used.output);
        } else if let Some(u) = step.get("usage_changed") {
            srv.notify("usage/changed", usage_doc(u["window"].as_f64().unwrap_or(0.0), u["weekly"].as_f64().unwrap_or(0.0)));
        } else if let Some(q) = step.get("quota") {
            error = json!({ "kind": "modelError", "message": "You have reached your usage limit.", "retryable": false,
                            "quota": { "limitKind": "tierLimit", "resetsAtMs": q["resetsAtMs"].as_i64().unwrap_or(now_ms() as i64 + 3_600_000) } });
            break;
        } else if let Some(f) = step.get("fail") {
            error = json!({ "kind": f["kind"].as_str().unwrap_or("modelError"), "message": f["message"].as_str().unwrap_or("the turn failed"),
                            "retryable": f["retryable"].as_bool().unwrap_or(false) });
            break;
        } else if let Some(s) = step.get("subagent") {
            let id = srv.uid();
            let sub = format!("sub_{}", srv.next());
            let base = json!({ "itemId": id, "kind": "subagent", "subagentId": sub, "role": s["role"], "objective": s["objective"] });
            item(srv, turn, false, base.clone());
            let until = Instant::now() + Duration::from_millis(s["run_ms"].as_u64().unwrap_or(1500));
            let mut stopped = false;
            while Instant::now() < until && !stopped {
                std::thread::sleep(Duration::from_millis(50));
                stopped = srv.stopped.lock().unwrap().contains(&sub);
            }
            let mut done = base.clone();
            if stopped {
                done["status"] = json!("cancelled");
                done["controlStatus"] = json!("closed");
                done["failureReason"] = json!("stopped by the client");
            } else {
                done["result"] = json!({ "summary": s["result"].as_str().unwrap_or("child done"), "artifactRefs": [], "evidenceRefs": [] });
                done["usage"] = json!({ "inputTokens": 500, "outputTokens": 40, "cachedTokens": 0, "reasoningTokens": 0 });
            }
            item(srv, turn, true, done);
            srv.log("subagent", json!({ "subagent": sub, "stopped": stopped }));
        } else if step["reminder"].as_bool() == Some(true) {
            let id = srv.uid();
            item(srv, turn, false, json!({ "itemId": id, "kind": "reminderChild", "reminderAgentId": "verify-reminder", "blocking": false }));
            item(srv, turn, true, json!({ "itemId": id, "kind": "reminderChild", "reminderAgentId": "verify-reminder", "blocking": false,
                                         "fallbackText": "verify reminder checked the turn" }));
        } else if step["unsolicited"].as_bool() == Some(true) {
            let other = srv.uid();
            srv.notify("turn/started", json!({ "sessionId": srv.sid(), "turnId": other, "commandId": other }));
            let until = Instant::now() + Duration::from_millis(3000);
            while Instant::now() < until && !srv.cancelled.lock().unwrap().contains(&other) {
                std::thread::sleep(Duration::from_millis(50));
            }
            let cancelled = srv.cancelled.lock().unwrap().contains(&other);
            srv.notify("turn/completed", json!({ "sessionId": srv.sid(), "turnId": other, "terminal": if cancelled { "cancelled" } else { "completed" } }));
            srv.log("unsolicited", json!({ "turn": other, "cancelled": cancelled }));
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
            for t in &got {
                item(srv, turn, true, json!({ "itemId": srv.uid(), "kind": "userMessage", "text": t, "steered": true }));
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
        } else {
            srv.log("unknown_step", json!({ "step": step }));
        }
        let steered = srv.take_steers();
        if !steered.is_empty() {
            srv.log("steer_read", json!({ "texts": steered }));
        }
    }
    if error.is_null() {
        request_usage(srv, turn, &used, totals);
    }
    let terminal = if srv.interrupted.load(Ordering::SeqCst) { "cancelled" } else if error.is_null() { "completed" } else { "failed" };
    srv.notify("usage/changed", usage_doc(12.0, 21.0));
    let mut done = json!({ "sessionId": srv.sid(), "turnId": turn, "terminal": terminal, "durationMs": started.elapsed().as_millis() as u64 });
    if !error.is_null() {
        done["error"] = error;
    }
    srv.notify("turn/completed", done);
    *srv.turn.lock().unwrap() = None;
    srv.log("turn_end", json!({ "script": job.script, "terminal": terminal, "ms": started.elapsed().as_millis() as u64 }));
}

pub fn run(raw: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // the engine names the agent; its discovery probes run without one
    let agent = std::env::var("ORGTREE_AGENT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "probe".into());
    let dir = std::env::var("ORGTREE_FAKECLI_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from);
    let log = dir.as_ref().and_then(|d| {
        let p = d.join("log");
        let _ = std::fs::create_dir_all(&p);
        std::fs::OpenOptions::new().create(true).append(true).open(p.join(format!("{agent}.jsonl"))).ok()
    });
    let srv = Arc::new(Srv {
        out: Mutex::new(std::io::stdout()),
        log: Mutex::new(log),
        waiters: Mutex::new(HashMap::new()),
        decisions: Mutex::new(HashMap::new()),
        interrupted: AtomicBool::new(false),
        seq: AtomicU64::new(0),
        agent: agent.clone(),
        dir,
        session: Mutex::new(None),
        turn: Mutex::new(None),
        model: Mutex::new(String::new()),
        steers: Mutex::new(VecDeque::new()),
        servers: Mutex::new(Value::Null),
        roots: Mutex::new(Vec::new()),
        cancelled: Mutex::new(Vec::new()),
        stopped: Mutex::new(Vec::new()),
    });
    // what a proof checks about the launch: the per-process switches, the
    // developer prompt's arrival (its length and whether it names the agent),
    // and which credentials and roots the environment carries (names only)
    let configs: Vec<String> = raw.windows(2).filter(|w| w[0] == "-c").map(|w| w[1].clone()).collect();
    let prompt = configs.iter().find_map(|c| c.strip_prefix("run.developer_prompt=")).and_then(|v| serde_json::from_str::<String>(v).ok());
    let env_set = |k: &str| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false);
    srv.log("start", json!({ "args": raw.iter().filter(|a| !a.starts_with("run.developer_prompt=")).collect::<Vec<_>>(), "cwd": cwd,
        "contributor_off": raw.windows(2).any(|w| w[0] == "--contributor-mode" && w[1] == "off"),
        "config_keys": configs.iter().filter_map(|c| c.split('=').next()).collect::<Vec<_>>(),
        "developer_prompt_len": prompt.as_ref().map(|p| p.chars().count()),
        "developer_prompt_names_agent": prompt.as_ref().map(|p| p.contains(&agent)),
        "developer_prompt_by_file": prompt.as_ref().map(|p| p.contains(".orgtree-muse-identity.md")),
        "agents_md": std::fs::read_to_string(cwd.join("AGENTS.md")).ok().map(|s| s.chars().count()),
        "meta_api_key_set": env_set("META_API_KEY"), "xdg_config_set": env_set("XDG_CONFIG_HOME"),
        "xdg_data_set": env_set("XDG_DATA_HOME"), "no_auto_update": std::env::var("MUSE_NO_AUTO_UPDATE").ok(),
        // the login's roots (folders, not secrets): which sign-in and session store it uses
        "xdg_config": std::env::var("XDG_CONFIG_HOME").ok(), "xdg_data": std::env::var("XDG_DATA_HOME").ok(),
        "anthropic_key_set": env_set("ANTHROPIC_API_KEY"), "openai_key_set": env_set("OPENAI_API_KEY"),
        "org": std::env::var("ORGTREE_ORG").ok() }));
    let (tx, rx) = mpsc::channel();
    {
        let srv = srv.clone();
        std::thread::spawn(move || reader(srv, tx));
    }
    // turns run here, one at a time; the reader ends the process when stdin closes
    let mut mcp: Option<Mcp> = None;
    let mut totals = Tokens::default();
    for job in rx {
        run_turn(&srv, &job, &mut mcp, &mut totals);
    }
    0
}
