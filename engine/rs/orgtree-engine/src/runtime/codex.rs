//! The Codex driver: `codex app-server`, JSON-RPC over stdio, one process
//! per active agent holding one thread (the agent's session). The agent's
//! `orgtree_*` tools are dynamic tools answered here, its approvals are
//! decided from its scope, mid-turn mail goes in with `turn/steer`, and every
//! notification is forwarded to the agent's actor as `AgentMsg::Codex`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;
use crate::runtime::{AgentMsg, AgentTx, Caller, Post};
use crate::winproc;

/// What one Codex process is launched with.
#[derive(Clone)]
pub struct CodexSpec {
    pub exe: PathBuf,
    pub cwd: PathBuf,
    pub codex_home: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    pub sandbox: String,
    pub instructions: String,
    pub dynamic_tools: Vec<Value>,
    /// `-c` overrides (granted MCP servers)
    pub config: Vec<String>,
    pub resume: Option<String>,
    pub may_write: bool,
    pub may_shell: bool,
    pub env: Vec<(String, String)>,
}

impl std::fmt::Debug for CodexSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexSpec")
            .field("exe", &self.exe)
            .field("cwd", &self.cwd)
            .field("codex_home", &self.codex_home)
            .field("api_key", &self.api_key.as_ref().map(|_| "*****"))
            .field("model", &self.model)
            .field("effort", &self.effort)
            .field("sandbox", &self.sandbox)
            .field("dynamic_tools", &self.dynamic_tools.len())
            .field("config", &self.config)
            .field("resume", &self.resume)
            .field("may_write", &self.may_write)
            .field("may_shell", &self.may_shell)
            .finish()
    }
}

/// A running `codex app-server`. Dropping it ends the process tree.
pub struct CodexProc {
    pub pid: u32,
    out: mpsc::UnboundedSender<String>,
    waiters: mpsc::UnboundedSender<(i64, oneshot::Sender<Value>)>,
    next: AtomicI64,
    child: Option<Child>,
    job: Option<winproc::ChildJob>,
    /// the thread: this agent's Codex session
    pub session_id: String,
    pub model: String,
    pub effort: Option<String>,
    cwd: String,
}

/// Our effort words → Codex's (`max` has no Codex level above `xhigh`).
#[logged]
pub fn codex_effort(level: &str) -> String {
    match level {
        "max" => "xhigh".into(),
        other => other.into(),
    }
}

#[logged]
impl CodexProc {
    pub async fn spawn(engine: Arc<Engine>, spec: CodexSpec, caller: Caller, actor: AgentTx) -> Result<CodexProc> {
        let mut cmd = Command::new(&spec.exe);
        // `-c` overrides are global options: they precede the subcommand
        cmd.args(&spec.config).arg("app-server");
        cmd.current_dir(&spec.cwd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // one credential per spawn: never an inherited key, home or the engine's own secrets
        for (k, _) in std::env::vars() {
            if k.starts_with("ANTHROPIC_")
                || k.starts_with("CLAUDE_CODE_")
                || ["CLAUDECODE", "OPENAI_API_KEY", "CODEX_HOME", "ORGTREE_ACCOUNT_ID", "ORGTREE_V2_TOKEN", "ORGTREE_DATA",
                    "ELECTRON_RUN_AS_NODE"]
                    .contains(&k.as_str())
            {
                cmd.env_remove(&k);
            }
        }
        if let Some(h) = &spec.codex_home {
            cmd.env("CODEX_HOME", h);
        }
        if let Some(k) = &spec.api_key {
            cmd.env("OPENAI_API_KEY", k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        winproc::no_window(&mut cmd);
        let mut child = cmd.spawn().with_context(|| format!("could not start {}", spec.exe.display()))?;
        let job = winproc::child_job(&child);
        let pid = child.id().unwrap_or(0);
        let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let client = crate::trace::agent_client(caller.agent_id, &caller.name);
        let proc_span = crate::trace::request(&client);
        tokio::spawn(tracing::Instrument::instrument(
            async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() {
                        tracing::info!("codex stderr (pid {pid}): {}", crate::util::gist(&l, 600));
                    }
                }
            },
            proc_span.clone(),
        ));
        let (wtx, wrx) = mpsc::unbounded_channel();
        let policy = Policy { may_write: spec.may_write, may_shell: spec.may_shell };
        tokio::spawn(tracing::Instrument::instrument(read_stdout(engine, stdout, caller, actor, tx.clone(), wrx, policy), proc_span));
        let mut proc = CodexProc {
            pid,
            out: tx,
            waiters: wtx,
            next: AtomicI64::new(1),
            child: Some(child),
            job,
            session_id: String::new(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            cwd: spec.cwd.to_string_lossy().to_string(),
        };
        proc.request(
            "initialize",
            json!({ "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true } }),
            Duration::from_secs(60),
        )
        .await
        .context("the Codex app-server did not initialize")?;
        proc.notify("initialized", json!({}));
        // the agent's thread: resumed when it has one, else a new one
        let mut thread: Option<String> = None;
        if let Some(tid) = &spec.resume {
            match proc
                .request(
                    "thread/resume",
                    json!({ "threadId": tid, "model": spec.model, "sandbox": spec.sandbox, "approvalPolicy": "on-request",
                            "developerInstructions": spec.instructions, "dynamicTools": spec.dynamic_tools }),
                    Duration::from_secs(120),
                )
                .await
            {
                Ok(r) => thread = thread_id_of(&r),
                Err(e) => tracing::warn!(thread = %tid, error = %format!("{e:#}"), "the Codex thread could not be resumed; starting a new one"),
            }
        }
        let thread = match thread {
            Some(t) => t,
            None => {
                let r = proc
                    .request(
                        "thread/start",
                        json!({ "model": spec.model, "cwd": proc.cwd, "sandbox": spec.sandbox, "approvalPolicy": "on-request",
                                "developerInstructions": spec.instructions, "dynamicTools": spec.dynamic_tools }),
                        Duration::from_secs(120),
                    )
                    .await
                    .context("thread/start")?;
                thread_id_of(&r).ok_or_else(|| anyhow!("thread/start returned no thread id"))?
            }
        };
        proc.session_id = thread;
        Ok(proc)
    }

    #[nolog]
    fn send(&self, v: &Value) -> bool {
        self.out.send(v.to_string()).is_ok()
    }

    #[nolog]
    pub fn notify(&self, method: &str, params: Value) -> bool {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// A request and its result (or the server's error, or a timeout).
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if self.waiters.send((id, tx)).is_err() {
            return Err(anyhow!("the Codex process is gone"));
        }
        if !self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
            return Err(anyhow!("the Codex process is gone"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => match resp.get("error").filter(|e| !e.is_null()) {
                Some(e) => Err(anyhow!("{method}: {}", e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string()))),
                None => Ok(resp.get("result").cloned().unwrap_or(Value::Null)),
            },
            Ok(Err(_)) => Err(anyhow!("the Codex process closed")),
            Err(_) => Err(anyhow!("{method}: no answer within {timeout:?}")),
        }
    }

    /// Start a turn on the thread; returns the turn id.
    pub async fn start_turn(&self, text: &str, images: Vec<Value>) -> Result<String> {
        let mut input = vec![json!({ "type": "text", "text": text })];
        input.extend(images);
        let r = self
            .request(
                "turn/start",
                json!({ "threadId": self.session_id, "input": input, "model": self.model, "effort": self.effort,
                        "cwd": self.cwd, "summary": "auto" }),
                Duration::from_secs(120),
            )
            .await?;
        Ok(r.pointer("/turn/id").or_else(|| r.get("turnId")).and_then(Value::as_str).unwrap_or("").to_string())
    }

    /// Mid-turn input; an error means it did not reach the turn.
    pub async fn steer(&self, turn_id: &str, text: &str) -> Result<()> {
        self.request(
            "turn/steer",
            json!({ "threadId": self.session_id, "expectedTurnId": turn_id, "input": [{ "type": "text", "text": text }] }),
            Duration::from_secs(30),
        )
        .await
        .map(|_| ())
    }

    /// Ask the server to stop the turn (the answer arrives as `turn/completed`).
    pub fn interrupt(&self, turn_id: &str) -> bool {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": "turn/interrupt",
                           "params": { "threadId": self.session_id, "turnId": turn_id } }))
    }

    pub async fn kill(&mut self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
        if let Some(mut c) = self.child.take() {
            let _ = c.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), c.wait()).await;
        }
    }

    /// Close its input and give it a moment; kill if it lingers.
    pub async fn close(&mut self) {
        let (tx, _) = mpsc::unbounded_channel();
        self.out = tx;
        if let Some(mut c) = self.child.take() {
            if tokio::time::timeout(Duration::from_secs(5), c.wait()).await.is_err() {
                if let Some(job) = &self.job {
                    job.terminate();
                }
                let _ = c.start_kill();
            }
        }
    }

    pub fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

fn thread_id_of(r: &Value) -> Option<String> {
    r.pointer("/thread/id").or_else(|| r.get("threadId")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// What the agent's scope lets Codex do on its own.
#[derive(Clone, Copy, Debug)]
struct Policy {
    may_write: bool,
    may_shell: bool,
}

#[logged]
async fn read_stdout(
    engine: Arc<Engine>,
    stdout: tokio::process::ChildStdout,
    caller: Caller,
    actor: AgentTx,
    writer: mpsc::UnboundedSender<String>,
    mut waiters_rx: mpsc::UnboundedReceiver<(i64, oneshot::Sender<Value>)>,
    policy: Policy,
) {
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let mut buf: Vec<u8> = Vec::new();
    // owned only by this task: request id → its waiter
    let mut waiters: HashMap<i64, oneshot::Sender<Value>> = HashMap::new();
    loop {
        let got = tokio::select! {
            w = waiters_rx.recv() => {
                if let Some((id, tx)) = w { waiters.insert(id, tx); }
                continue;
            }
            n = reader.read_until(b'\n', &mut buf) => n,
        };
        match got {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let parsed = serde_json::from_slice::<Value>(&buf);
        buf.clear();
        let Ok(v) = parsed else { continue };
        let has_id = v.get("id").map(|i| !i.is_null()).unwrap_or(false);
        match (has_id, v.get("method").and_then(Value::as_str)) {
            (true, None) => {
                while let Ok((wid, tx)) = waiters_rx.try_recv() {
                    waiters.insert(wid, tx);
                }
                if let Some(tx) = v["id"].as_i64().and_then(|id| waiters.remove(&id)) {
                    let _ = tx.send(v);
                }
            }
            (true, Some(method)) => {
                let method = method.to_string();
                let id = v["id"].clone();
                let params = v["params"].clone();
                let (engine, caller, writer, actor) = (engine.clone(), caller.clone(), writer.clone(), actor.clone());
                // every server request (a tool call, an approval) is its own request
                let span = crate::trace::request(&crate::trace::agent_client(caller.agent_id, &caller.name));
                tokio::spawn(tracing::Instrument::instrument(
                    async move {
                        let reply = match answer(&engine, &caller, &actor, &method, &params, policy).await {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": e.to_string() } }),
                        };
                        let _ = writer.send(reply.to_string());
                    },
                    span,
                ));
            }
            (false, Some(_)) => {
                if !actor.post(AgentMsg::Codex(v)) {
                    break;
                }
            }
            _ => {}
        }
    }
    let _ = actor.post(AgentMsg::ProcExited);
}

/// A request from the app-server: an `orgtree_*` tool call, or an approval.
#[logged]
async fn answer(engine: &Arc<Engine>, caller: &Caller, actor: &AgentTx, method: &str, params: &Value, policy: Policy) -> Result<Value> {
    match method {
        "item/tool/call" => {
            let tool = params["tool"].as_str().unwrap_or("");
            let call_id = params["callId"].as_str().map(str::to_string);
            let args = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
            let (ok, text) = crate::tools::call_tool(engine, caller, tool, &args, call_id.as_deref()).await;
            Ok(json!({ "success": ok, "contentItems": [{ "type": "inputText", "text": text }] }))
        }
        m if m.ends_with("requestApproval") || m == "applyPatchApproval" || m == "execCommandApproval" => {
            let file = m.contains("fileChange") || m == "applyPatchApproval";
            let allow = if file { policy.may_write } else { policy.may_shell && policy.may_write };
            if !allow {
                // the actor books what was declined on its turn
                let what = if file {
                    json!({ "tool": "apply_patch", "arg": params["grantRoot"].as_str().or(params["itemId"].as_str()).unwrap_or("") })
                } else {
                    json!({ "tool": "exec_command", "arg": crate::util::gist(params["command"].as_str().unwrap_or(""), 90) })
                };
                let _ = actor.post(AgentMsg::Codex(json!({ "method": "orgtree/denied", "params": what })));
            }
            if m == "item/permissions/requestApproval" {
                return Ok(json!({ "permissions": {}, "scope": "turn" }));
            }
            Ok(json!({ "decision": if allow { "accept" } else { "decline" } }))
        }
        "item/tool/requestUserInput" => Err(anyhow!("orgtree agents ask the user with orgtree_ask")),
        other => Err(anyhow!("orgtree declines {other}")),
    }
}

/// The agent's `orgtree_*` tools as Codex dynamic tools.
#[logged]
pub fn dynamic_tools() -> Vec<Value> {
    crate::tools::defs::list()
        .into_iter()
        .map(|t| json!({ "type": "function", "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] }))
        .collect()
}

/// `-c` overrides attaching granted MCP servers (bare-key names, command or url).
#[logged]
pub fn mcp_overrides(servers: &serde_json::Map<String, Value>) -> (Vec<String>, Vec<String>) {
    let bare = |s: &str| !s.is_empty() && s.chars().next().map(|c| c.is_ascii_alphanumeric() || c == '_').unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let toml = |v: &Value| serde_json::to_string(&v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    let mut out = Vec::new();
    let mut attached = Vec::new();
    for (name, srv) in servers {
        if !bare(name) || !(srv.get("command").is_some() || srv.get("url").is_some()) {
            continue;
        }
        for field in ["command", "args", "env", "url"] {
            let Some(val) = srv.get(field) else { continue };
            let rendered = match field {
                "args" => match val.as_array() {
                    Some(a) => format!("[{}]", a.iter().map(toml).collect::<Vec<_>>().join(", ")),
                    None => continue,
                },
                "env" => match val.as_object() {
                    Some(o) => format!(
                        "{{{}}}",
                        o.iter().filter(|(k, _)| bare(k)).map(|(k, v)| format!("{k} = {}", toml(v))).collect::<Vec<_>>().join(", ")
                    ),
                    None => continue,
                },
                _ => toml(val),
            };
            out.push("-c".to_string());
            out.push(format!("mcp_servers.{name}.{field}={rendered}"));
        }
        // headless: a prompt would read as a rejection, so this server's tools are pre-approved
        out.push("-c".to_string());
        out.push(format!("mcp_servers.{name}.default_tools_approval_mode=\"approve\""));
        attached.push(name.clone());
    }
    (out, attached)
}

/// A short-lived app-server's read of one login: (account, rate limits).
#[logged]
pub async fn probe(exe: &std::path::Path, home: Option<&str>) -> Result<(Value, Value)> {
    let mut cmd = Command::new(exe);
    cmd.arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (k, _) in std::env::vars() {
        if k.starts_with("ANTHROPIC_")
            || k.starts_with("CLAUDE_CODE_")
            || ["CLAUDECODE", "OPENAI_API_KEY", "CODEX_HOME", "ORGTREE_V2_TOKEN", "ORGTREE_DATA", "ELECTRON_RUN_AS_NODE"].contains(&k.as_str())
        {
            cmd.env_remove(&k);
        }
    }
    if let Some(h) = home {
        cmd.env("CODEX_HOME", h);
    }
    winproc::no_window(&mut cmd);
    let mut child = cmd.spawn().with_context(|| format!("could not start {}", exe.display()))?;
    let job = winproc::child_job(&child);
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let frames = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                            "capabilities": { "experimentalApi": true } } }),
        json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "account/read", "params": { "refreshToken": false } }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "account/rateLimits/read", "params": null }),
    ];
    for f in frames {
        stdin.write_all(format!("{f}\n").as_bytes()).await?;
    }
    stdin.flush().await?;
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let (mut account, mut limits): (Option<Value>, Option<Result<Value>>) = (None, None);
        while let Ok(Some(l)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
            match v["id"].as_i64() {
                Some(2) => account = Some(v["result"]["account"].clone()),
                Some(3) => {
                    limits = Some(match v.get("error").filter(|e| !e.is_null()) {
                        Some(e) => Err(anyhow!("{}", e["message"].as_str().unwrap_or("account/rateLimits/read failed"))),
                        None => Ok(v["result"].clone()),
                    })
                }
                _ => {}
            }
            if account.is_some() && limits.is_some() {
                break;
            }
        }
        (account, limits)
    };
    let got = tokio::time::timeout(Duration::from_secs(25), read).await;
    if let Some(j) = &job {
        j.terminate();
    }
    let _ = child.start_kill();
    let (account, limits) = got.map_err(|_| anyhow!("the Codex app-server did not answer in time"))?;
    let limits = limits.ok_or_else(|| anyhow!("the Codex app-server closed without answering"))??;
    Ok((account.unwrap_or(Value::Null), limits))
}
