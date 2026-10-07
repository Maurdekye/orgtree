//! Claude Code driver: one long-lived `claude -p` process per active agent,
//! speaking stream-json both ways. The agent's `orgtree_*` tools are an
//! in-process MCP server on the CLI's own control channel (`mcp_message`),
//! and mid-turn mail arrives through a PostToolUse hook callback on the same
//! channel — no HTTP, no tokens, no helper processes.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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

#[derive(Clone)]
pub struct SpawnSpec {
    pub exe: PathBuf,
    pub cwd: PathBuf,
    pub model: String,
    pub permission_mode: String,
    pub effort: Option<String>,
    pub identity_file: PathBuf,
    pub settings_file: PathBuf,
    pub mcp_file: PathBuf,
    pub disallowed: Vec<String>,
    pub allowed: Vec<String>,
    pub add_dirs: Vec<String>,
    /// Some(id) to resume, None to start the session named `new_session`
    pub resume: Option<String>,
    pub new_session: String,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
}

impl std::fmt::Debug for SpawnSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<(String, String)> = self
            .env
            .iter()
            .map(|(k, v)| {
                let secret = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"].iter().any(|w| k.to_ascii_uppercase().contains(w));
                (k.clone(), if secret { "*****".to_string() } else { v.clone() })
            })
            .collect();
        f.debug_struct("SpawnSpec")
            .field("exe", &self.exe)
            .field("cwd", &self.cwd)
            .field("model", &self.model)
            .field("permission_mode", &self.permission_mode)
            .field("effort", &self.effort)
            .field("disallowed", &self.disallowed)
            .field("allowed", &self.allowed)
            .field("add_dirs", &self.add_dirs)
            .field("resume", &self.resume)
            .field("new_session", &self.new_session)
            .field("env", &env)
            .field("env_remove", &self.env_remove)
            .finish()
    }
}

/// A running Claude process. Dropping it ends the process tree.
pub struct ClaudeProc {
    pub pid: u32,
    pub process: uuid::Uuid,
    stdin: mpsc::UnboundedSender<String>,
    waiters: mpsc::UnboundedSender<(String, oneshot::Sender<Value>)>,
    child: Option<Child>,
    job: Option<winproc::ChildJob>,
    pub session_id: String,
}

static REQ: AtomicU64 = AtomicU64::new(1);

#[logged]
fn req_id(prefix: &str) -> String {
    format!("{prefix}_{}", REQ.fetch_add(1, Ordering::Relaxed))
}

#[logged]
impl ClaudeProc {
    #[nolog]
    pub async fn spawn(
        engine: Arc<Engine>,
        spec: SpawnSpec,
        caller: Caller,
        actor: AgentTx,
    ) -> Result<ClaudeProc> {
        let mut cmd = Command::new(&spec.exe);
        cmd.arg("-p")
            .args(["--input-format", "stream-json", "--output-format", "stream-json"])
            .arg("--include-partial-messages")
            .arg("--verbose")
            .args(["--model", &spec.model])
            .args(["--permission-mode", &spec.permission_mode])
            .arg("--append-system-prompt-file")
            .arg(&spec.identity_file)
            .arg("--settings")
            .arg(&spec.settings_file)
            .arg("--strict-mcp-config")
            .arg("--mcp-config")
            .arg(&spec.mcp_file);
        if let Some(e) = &spec.effort {
            cmd.args(["--effort", e]);
        }
        if !spec.disallowed.is_empty() {
            cmd.arg("--disallowed-tools").arg(spec.disallowed.join(","));
        }
        if !spec.allowed.is_empty() {
            cmd.arg("--allowedTools").arg(spec.allowed.join(","));
        }
        for d in &spec.add_dirs {
            cmd.arg("--add-dir").arg(d);
        }
        let session_id = match &spec.resume {
            Some(sid) => {
                cmd.args(["--resume", sid]);
                sid.clone()
            }
            None => {
                cmd.args(["--session-id", &spec.new_session]);
                spec.new_session.clone()
            }
        };
        cmd.current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Inherit no host Claude session or credential override. Authorized
        // account settings below are applied only after this cleanup (3.x clean_env).
        // Inspect names only; never log environment values.
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy().to_ascii_uppercase();
            if name.starts_with("CLAUDE_CODE_") || name == "CLAUDECODE" {
                cmd.env_remove(key);
            }
        }
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        winproc::no_window(&mut cmd);
        let mut child = cmd.spawn().with_context(|| format!("could not start {}", spec.exe.display()))?;
        let job = winproc::child_job(&child);
        let pid = child.id().unwrap_or(0);
        let process = uuid::Uuid::new_v4();
        tracing::info!(agent = caller.agent_id, pid, %process, provider = "Claude", "CLI started");
        let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if !line.ends_with('\n') && stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
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
                        tracing::info!("claude stderr (pid {pid}): {l}");
                    }
                }
            },
            proc_span.clone(),
        ));
        let (wtx, wrx) = mpsc::unbounded_channel();
        let writer = tx.clone();
        tokio::spawn(tracing::Instrument::instrument(read_stdout(engine, stdout, caller, actor, process, writer, wrx), proc_span));
        let proc = ClaudeProc { pid, process, stdin: tx, waiters: wtx, child: Some(child), job, session_id };
        // Register the in-process MCP server and the mail hook before any turn.
        let init = proc
            .request(
                json!({
                    "subtype": "initialize",
                    "hooks": { "PostToolUse": [{ "matcher": null, "hookCallbackIds": ["orgtree_mail"] }] },
                    "sdkMcpServers": ["orgtree"],
                }),
                Duration::from_secs(60),
            )
            .await;
        if let Err(e) = init {
            tracing::warn!(error = %e, "claude initialize did not answer");
        }
        Ok(proc)
    }

    #[nolog]
    fn write(&self, v: &Value) -> bool {
        self.stdin.send(v.to_string()).is_ok()
    }

    /// A control request and its response (or timeout).
    pub async fn request(&self, request: Value, timeout: Duration) -> Result<Value> {
        let id = req_id("ot");
        let (tx, rx) = oneshot::channel();
        if self.waiters.send((id.clone(), tx)).is_err() {
            return Err(anyhow!("the Claude process is gone"));
        }
        if !self.write(&json!({ "type": "control_request", "request_id": id, "request": request })) {
            return Err(anyhow!("the Claude process is gone"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err(anyhow!("the Claude process closed")),
            Err(_) => Err(anyhow!("no answer within {timeout:?}")),
        }
    }

    /// Start a turn (or queue a follow-up, if one is running) with this text
    /// and optional image blocks.
    pub fn send_user(&self, text: &str, images: Vec<Value>) -> bool {
        let mut content = vec![json!({ "type": "text", "text": text })];
        content.extend(images);
        self.write(&json!({
            "type": "user",
            "message": { "role": "user", "content": content },
            "parent_tool_use_id": null,
            "session_id": self.session_id,
        }))
    }

    pub fn interrupt(&self) -> bool {
        self.write(&json!({ "type": "control_request", "request_id": req_id("int"),
                            "request": { "subtype": "interrupt" } }))
    }

    /// The running turn's next model call uses this effort level.
    pub fn set_effort(&self, level: &str) -> bool {
        self.write(&json!({ "type": "control_request", "request_id": req_id("eff"),
                            "request": { "subtype": "apply_flag_settings", "settings": { "effortLevel": level } } }))
    }

    pub async fn mcp_status(&self) -> Option<Value> {
        self.request(json!({ "subtype": "mcp_status" }), Duration::from_secs(10)).await.ok()
    }

    pub async fn kill(&mut self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
        if let Some(mut c) = self.child.take() {
            let _ = c.start_kill();
            let _ = super::wait_exit(&mut c, self.pid, self.process, "termination requested", Duration::from_secs(5)).await;
        }
    }

    /// Ask the process to exit by closing its input; kill if it lingers.
    pub async fn close(&mut self) {
        let (tx, _) = mpsc::unbounded_channel();
        self.stdin = tx;
        if let Some(mut c) = self.child.take() {
            let status = super::wait_exit(&mut c, self.pid, self.process, "close requested", Duration::from_secs(5)).await;
            if status.starts_with("exit status unavailable") {
                if let Some(job) = &self.job {
                    job.terminate();
                }
                let _ = c.start_kill();
                let _ = super::wait_exit(&mut c, self.pid, self.process, "close required termination", Duration::from_secs(1)).await;
            }
        }
    }

    pub async fn exit_status(&mut self, reason: &str) -> String {
        super::exit_status(&mut self.child, self.pid, self.process, reason).await
    }

    pub fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

#[logged]
async fn read_stdout(
    engine: Arc<Engine>,
    stdout: tokio::process::ChildStdout,
    caller: Caller,
    actor: AgentTx,
    process: uuid::Uuid,
    writer: mpsc::UnboundedSender<String>,
    mut waiters_rx: mpsc::UnboundedReceiver<(String, oneshot::Sender<Value>)>,
) {
    let mut lines = BufReader::with_capacity(1 << 16, stdout).lines();
    // owned only by this task: request id -> its waiter
    let mut waiters: std::collections::HashMap<String, oneshot::Sender<Value>> = std::collections::HashMap::new();
    let mut waiters_open = true;
    let reason = loop {
        let line = tokio::select! {
            w = waiters_rx.recv(), if waiters_open => {
                if let Some((id, tx)) = w { waiters.insert(id, tx); } else { waiters_open = false; }
                continue;
            }
            l = lines.next_line() => match l {
                Ok(Some(l)) => l,
                Ok(None) => break "stdout EOF".to_string(),
                Err(e) => break format!("stdout read failed: {e}"),
            },
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            tracing::debug!(agent = %caller.name, "non-JSON claude output: {}", crate::util::gist(&line, 200));
            continue;
        };
        match v["type"].as_str() {
            Some("control_response") => {
                let resp = &v["response"];
                let id = resp["request_id"].as_str().unwrap_or("").to_string();
                // a registration may still be in flight: drain them first
                while let Ok((wid, tx)) = waiters_rx.try_recv() {
                    waiters.insert(wid, tx);
                }
                if let Some(tx) = waiters.remove(&id) {
                    let _ = tx.send(resp.clone());
                }
            }
            Some("control_request") => {
                let id = v["request_id"].as_str().unwrap_or("").to_string();
                let req = v["request"].clone();
                let writer = writer.clone();
                let engine = engine.clone();
                let caller = caller.clone();
                let actor = actor.clone();
                // every control request (tool call, hook) is its own request
                let span = crate::trace::request(&crate::trace::agent_client(caller.agent_id, &caller.name));
                tokio::spawn(tracing::Instrument::instrument(async move {
                    let response = answer_control(&engine, &caller, &actor, &req).await;
                    let line = match response {
                        Ok(r) => json!({ "type": "control_response",
                                         "response": { "subtype": "success", "request_id": id, "response": r } }),
                        Err(e) => json!({ "type": "control_response",
                                          "response": { "subtype": "error", "request_id": id, "error": e.to_string() } }),
                    };
                    let _ = writer.send(line.to_string());
                }, span));
            }
            Some("control_cancel_request") => {}
            _ => {
                if !actor.post(AgentMsg::Claude(process, v)) {
                    break "actor closed".to_string();
                }
            }
        }
    };
    let _ = actor.post(AgentMsg::ProcExited { process, reason });
}

#[logged]
async fn answer_control(
    engine: &Arc<Engine>,
    caller: &Caller,
    actor: &AgentTx,
    req: &Value,
) -> Result<Value> {
    match req["subtype"].as_str() {
        Some("mcp_message") => {
            let server = req["server_name"].as_str().unwrap_or("");
            if server != "orgtree" {
                return Err(anyhow!("unknown in-process MCP server {server}"));
            }
            let resp = crate::tools::handle_mcp(engine, caller, &req["message"]).await;
            Ok(json!({ "mcp_response": resp }))
        }
        Some("hook_callback") => {
            let (tx, rx) = oneshot::channel();
            let _ = actor.post(AgentMsg::Hook { input: req["input"].clone(), reply: tx });
            let out = tokio::time::timeout(Duration::from_secs(30), rx).await.ok().and_then(Result::ok);
            Ok(out.unwrap_or_else(|| json!({})))
        }
        Some("can_use_tool") => Ok(json!({ "behavior": "allow", "updatedInput": req["input"] })),
        other => Err(anyhow!("unsupported control request {other:?}")),
    }
}

/// Files a Claude process reads at start; rewritten before every spawn.
#[logged]
pub fn write_launch_files(
    scratch: &Path,
    identity: &str,
    settings: &Value,
    mcp: &Value,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    std::fs::create_dir_all(scratch)?;
    let id = scratch.join(".orgtree-identity.md");
    let st = scratch.join(".orgtree-settings.json");
    let mc = scratch.join(".orgtree-mcp.json");
    std::fs::write(&id, identity)?;
    std::fs::write(&st, serde_json::to_vec_pretty(settings)?)?;
    std::fs::write(&mc, serde_json::to_vec_pretty(mcp)?)?;
    Ok((id, st, mc))
}

/// Claude Code's folder name for a working directory under `projects/`.
#[logged]
pub fn project_dir(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The config folder a CLI without `CLAUDE_CONFIG_DIR` uses.
#[logged]
pub fn default_config_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

/// Make sure `--resume <session>` from `cwd` under `config_dir` finds its
/// transcript: if it is not where that CLI looks, copy it there from any
/// other project folder or account. False when it exists nowhere.
#[logged]
pub fn ensure_session(cwd: &Path, session: &str, config_dir: Option<&str>, others: &[String]) -> bool {
    let file = format!("{session}.jsonl");
    let root = config_dir.map(PathBuf::from).unwrap_or_else(default_config_dir);
    let target = root.join("projects").join(project_dir(cwd)).join(&file);
    if target.is_file() {
        return true;
    }
    let mut roots = vec![root.clone(), default_config_dir()];
    for o in others {
        let p = PathBuf::from(o);
        if !roots.contains(&p) {
            roots.push(p);
        }
    }
    for r in roots {
        let Ok(entries) = std::fs::read_dir(r.join("projects")) else { continue };
        for e in entries.flatten() {
            let candidate = e.path().join(&file);
            if candidate.is_file() && candidate != target {
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::copy(&candidate, &target).is_ok() {
                    tracing::info!(from = %candidate.display(), to = %target.display(), "carried a session transcript");
                    return true;
                }
            }
        }
    }
    false
}
