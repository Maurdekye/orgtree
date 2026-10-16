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
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;
use crate::runtime::session_host::{self, Io};
use crate::runtime::{AgentMsg, AgentTx, Caller, Post};
use crate::winproc;

/// What one Codex process is launched with.
#[derive(Clone)]
pub struct CodexSpec {
    pub skills_root: PathBuf,
    pub exe: PathBuf,
    pub cwd: PathBuf,
    pub codex_home: Option<String>,
    pub api_key: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    pub sandbox: Sandbox,
    pub instructions: String,
    pub dynamic_tools: Vec<Value>,
    /// `-c` overrides (granted MCP servers)
    pub config: Vec<String>,
    pub resume: Option<String>,
    pub may_write: bool,
    pub may_shell: bool,
    pub may_subagents: bool,
    pub env: Vec<(String, String)>,
    /// Some: ask the sign-in helper to start this Codex in the user's
    /// session; if it cannot, start it here with this (Session 0) sandbox.
    pub host: Option<Sandbox>,
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
            .field("config_count", &self.config.len())
            .field("resume", &self.resume)
            .field("may_write", &self.may_write)
            .field("may_shell", &self.may_shell)
            .finish()
    }
}

/// A running `codex app-server`. Dropping it ends the process tree.
pub struct CodexProc {
    pub pid: u32,
    pub process: uuid::Uuid,
    out: mpsc::UnboundedSender<String>,
    /// the agent it serves, for the kill record
    who: String,
    /// fired (or dropped) to close the process's stdin: the app-server's
    /// signal to exit by itself
    stdin_close: Option<oneshot::Sender<()>>,
    waiters: mpsc::UnboundedSender<(i64, oneshot::Sender<Value>)>,
    next: AtomicI64,
    child: Option<Child>,
    /// started by the sign-in helper in the user's session (`child` is None)
    hosted: Option<session_host::Hosted>,
    job: Option<winproc::ChildJob>,
    /// the thread: this agent's Codex session
    pub session_id: String,
    pub model: String,
    pub effort: Option<String>,
    cwd: String,
    home: PathBuf,
    rollout_path: Option<PathBuf>,
}

/// The OS sandbox and approval policy one Codex seat runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sandbox {
    /// read-only | workspace-write | danger-full-access
    pub mode: &'static str,
    /// on-request, or untrusted for a read-only seat run without the sandbox
    pub approval: &'static str,
    /// the OS sandbox was turned off because the engine is in Session 0
    pub session0: bool,
}

/// The sandbox for a seat. In Session 0 Codex's Windows sandbox cannot start
/// its command runner (openai/codex#46412: 0xC0000142, "timed out connecting
/// runner pipe-in"), so every seat runs without it: a write-enabled seat as
/// plain danger-full-access, a read-only seat with approvalPolicy untrusted:
/// every command or patch is then an approval request (on Windows Codex runs
/// none unasked), which its policy declines, so the seat has no shell until
/// Codex runs in the user's session again (ruling 2026-10-10).
#[logged]
pub fn sandbox(may_write: bool, permission_mode: &str, session0: bool) -> Sandbox {
    let mode = if !may_write {
        "read-only"
    } else if permission_mode == "bypassPermissions" {
        "danger-full-access"
    } else {
        "workspace-write"
    };
    match (session0, mode) {
        (false, _) | (true, "danger-full-access") => Sandbox { mode, approval: "on-request", session0: false },
        (true, "read-only") => Sandbox { mode: "danger-full-access", approval: "untrusted", session0: true },
        (true, _) => Sandbox { mode: "danger-full-access", approval: "on-request", session0: true },
    }
}

/// A seat's sandbox, and whether its Codex is started by the sign-in helper
/// in the user's session, where Codex's sandbox works (docket
/// windows-sign-in-credential-helper-so-git-gh-work, phase 2; every harness
/// since 2026-10-16, `session_host`). A bypassPermissions seat moves too (the
/// user, 2026-10-16 09:43Z: "Yes, all agents", superseding ruling Q1, which
/// kept it in Session 0), with its own unsandboxed setting.
#[logged]
pub fn seat_sandbox(engine: &Engine, may_write: bool, permission_mode: &str) -> (Sandbox, bool) {
    let s0 = session0();
    let own = sandbox(may_write, permission_mode, false);
    let hosted = super::session_host::wanted(engine, own.mode == "danger-full-access");
    if hosted {
        (own, true)
    } else {
        (sandbox(may_write, permission_mode, s0), false)
    }
}

/// Whether the engine runs in Windows Session 0 (the boot task), where Codex's
/// sandbox cannot start (see `sandbox`). Read once; the session never changes.
/// A rig run may force it with `ORGTREE_RIG_SESSION0=1|0`.
#[logged]
pub fn session0() -> bool {
    if crate::rig::active() {
        match std::env::var("ORGTREE_RIG_SESSION0").as_deref() {
            Ok("1") => return true,
            Ok("0") => return false,
            _ => {}
        }
    }
    static SESSION0: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SESSION0.get_or_init(own_session_is_zero)
}

#[cfg(windows)]
#[logged]
fn own_session_is_zero() -> bool {
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    let mut id = u32::MAX;
    (unsafe { ProcessIdToSessionId(std::process::id(), &mut id) } != 0) && id == 0
}

#[cfg(not(windows))]
#[logged]
fn own_session_is_zero() -> bool {
    false
}

/// Preserve the selected level, as 3.x did; staffing filters by model/list.
#[logged]
pub fn codex_effort(level: &str) -> String {
    level.into()
}

#[logged]
impl CodexProc {
    #[nolog]
    pub async fn spawn(engine: Arc<Engine>, mut spec: CodexSpec, caller: Caller, actor: AgentTx) -> Result<CodexProc> {
        // one credential per spawn: never an inherited key, home or the engine's own secrets
        let mut env: Vec<(String, String)> = std::env::vars()
            .filter(|(k, _)| {
                !(k.starts_with("ANTHROPIC_")
                    || k.starts_with("CLAUDE_CODE_")
                    || ["CLAUDECODE", "OPENAI_API_KEY", "CODEX_HOME", "ORGTREE_ACCOUNT_ID", "ORGTREE_V2_TOKEN", "ORGTREE_DATA",
                        "ELECTRON_RUN_AS_NODE"]
                        .contains(&k.as_str()))
            })
            .collect();
        if let Some(h) = &spec.codex_home {
            env.push(("CODEX_HOME".into(), h.clone()));
        }
        if let Some(k) = &spec.api_key {
            env.push(("OPENAI_API_KEY".into(), k.clone()));
        }
        env.extend(spec.env.iter().cloned());
        if !spec.may_write || !spec.may_subagents {
            let scoped_config = super::tool_policy::codex_scoped_catalog(
                &spec.exe, &spec.cwd, &spec.config, &env, spec.may_write, spec.may_subagents,
            ).await?;
            spec.config.extend(scoped_config);
        }
        let mut started: Option<(Io, session_host::Hosted)> = None;
        if let Some(fallback) = spec.host {
            let mut args = spec.config.clone();
            args.push("app-server".into());
            let hosted = match (spec.exe.to_str(), spec.cwd.to_str()) {
                (Some(exe), Some(cwd)) => session_host::start_hosted(&engine, exe, &args, cwd, &env).await,
                _ => Err("host-invalid".to_string()),
            };
            match hosted {
                Ok(h) => started = Some(h),
                Err(code) => {
                    tracing::warn!(agent = caller.agent_id, reason = %code,
                        "the sign-in helper could not start Codex; starting it in Session 0 without the OS sandbox");
                    spec.sandbox = fallback;
                }
            }
        }
        let (io, child, hosted, job, pid) = match started {
            Some((io, h)) => {
                let job = h.job();
                let pid = h.pid;
                tracing::info!(agent = caller.agent_id, pid, sandbox = spec.sandbox.mode,
                    "Codex started by the sign-in helper in the user's session");
                (io, None, Some(h), job, pid)
            }
            None => {
                let mut cmd = Command::new(&spec.exe);
                // `-c` overrides are global options: they precede the subcommand
                cmd.args(&spec.config).arg("app-server");
                cmd.current_dir(&spec.cwd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
                winproc::no_window(&mut cmd);
                winproc::own_group(&mut cmd);
                let mut child = cmd.spawn().with_context(|| format!("could not start {}", spec.exe.display()))?;
                let job = winproc::child_job(&child);
                let pid = child.id().unwrap_or(0);
                let io = Io {
                    stdin: Box::new(child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?),
                    stdout: Box::new(child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?),
                    stderr: Box::new(child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?),
                };
                (io, Some(child), None, job, pid)
            }
        };
        env.iter_mut().for_each(|(_, v)| v.clear());
        let process = uuid::Uuid::new_v4();
        tracing::info!(agent = caller.agent_id, pid, %process, provider = "Codex", "CLI started");
        if spec.sandbox.session0 {
            tracing::info!(agent = caller.agent_id, pid, sandbox = spec.sandbox.mode, approval = spec.sandbox.approval,
                "Codex OS sandbox disabled: the engine runs in Session 0 (openai/codex#46412)");
        }
        let Io { mut stdin, stdout, stderr } = io;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        // the stdout reader keeps a sender too, so the channel never closes
        // while the process lives: closing stdin needs its own signal
        let (stdin_close, mut close_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                let line = tokio::select! {
                    biased;
                    _ = &mut close_rx => break,
                    line = rx.recv() => match line { Some(l) => l, None => break },
                };
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
            drop(stdin);
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
        let who = format!("agent {} (#{})", caller.name, caller.agent_id);
        let (wtx, wrx) = mpsc::unbounded_channel();
        let policy = Policy { may_write: spec.may_write, may_shell: spec.may_shell };
        tokio::spawn(tracing::Instrument::instrument(read_stdout(engine, stdout, caller, actor, process, tx.clone(), wrx, policy), proc_span));
        let mut proc = CodexProc {
            pid,
            process,
            out: tx,
            who,
            stdin_close: Some(stdin_close),
            waiters: wtx,
            next: AtomicI64::new(1),
            child,
            hosted,
            job,
            session_id: String::new(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            cwd: spec.cwd.to_string_lossy().to_string(),
            home: spec.codex_home.as_ref().map(PathBuf::from).unwrap_or_else(default_home),
            rollout_path: None,
        };
        // a Codex that fails to open still ends gracefully, not by drop
        if let Err(e) = proc.open(&spec).await {
            proc.close().await;
            return Err(e);
        }
        Ok(proc)
    }

    async fn open(&mut self, spec: &CodexSpec) -> Result<()> {
        self.request(
            "initialize",
            json!({ "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true } }),
            Duration::from_secs(60),
        )
        .await
        .context("the Codex app-server did not initialize")?;
        self.notify("initialized", json!({}));
        // Installed app-server 0.160.0 exposes this native roots API. Set it
        // before thread start/resume; never mutate a running turn's skill set.
        self.request("skills/extraRoots/set", json!({"extraRoots":[spec.skills_root]}), Duration::from_secs(30))
            .await.context("Codex could not load the shared skills directory")?;
        // the agent's thread: resumed when it has one, else a new one
        let mut thread: Option<String> = None;
        if let Some(tid) = &spec.resume {
            match self
                .request(
                    "thread/resume",
                    json!({ "threadId": tid, "model": spec.model, "sandbox": spec.sandbox.mode, "approvalPolicy": spec.sandbox.approval,
                            "developerInstructions": spec.instructions, "dynamicTools": spec.dynamic_tools }),
                    Duration::from_secs(120),
                )
                .await
            {
                Ok(r) => {
                    thread = thread_id_of(&r);
                    self.rollout_path = r.pointer("/thread/path").and_then(Value::as_str).map(PathBuf::from);
                }
                Err(e) => tracing::warn!(thread = %tid, error = %format!("{e:#}"), "the Codex thread could not be resumed; starting a new one"),
            }
        }
        let thread = match thread {
            Some(t) => t,
            None => {
                let r = self
                    .request(
                        "thread/start",
                        json!({ "model": spec.model, "cwd": self.cwd, "sandbox": spec.sandbox.mode, "approvalPolicy": spec.sandbox.approval,
                                "developerInstructions": spec.instructions, "dynamicTools": spec.dynamic_tools }),
                        Duration::from_secs(120),
                    )
                    .await
                .context("thread/start")?;
                self.rollout_path = r.pointer("/thread/path").and_then(Value::as_str).map(PathBuf::from);
                thread_id_of(&r).ok_or_else(|| anyhow!("thread/start returned no thread id"))?
            }
        };
        self.session_id = thread;
        Ok(())
    }

    /// Stored privately with a chip; lookup happens only when it is expanded.
    pub fn input_source(&self, tool: &str) -> Value {
        json!({ "home": self.home, "path": self.rollout_path, "thread": self.session_id, "call_id": tool })
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
    #[nolog] // thread/start and thread/resume carry private global instructions
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

    /// Stop it now (halt, stop, a cancelled keepalive): still graceful
    /// first, with a shorter wait than `close`.
    pub async fn kill(&mut self) {
        self.end(Duration::from_secs(3), "termination requested").await;
    }

    /// Close its input and give it a moment; kill if it lingers.
    pub async fn close(&mut self) {
        self.end(Duration::from_secs(5), "close requested").await;
    }

    /// Never a forced end first (docket
    /// urgent-orgtree-s-hard-killing-of-codex-processes): its stdin closes,
    /// it gets `grace` to exit by itself, and only then are its job and the
    /// process terminated, logged as a hard termination.
    async fn end(&mut self, grace: Duration, reason: &str) {
        let (tx, _) = mpsc::unbounded_channel();
        self.out = tx;
        if let Some(close) = self.stdin_close.take() {
            let _ = close.send(());
        }
        if let Some(h) = self.hosted.take() {
            let started = std::time::Instant::now();
            let status = h.wait_exit(self.process, reason, grace).await;
            let waited = started.elapsed().as_millis() as u64;
            if !status.starts_with("exit status unavailable") {
                crate::codex_kills::graceful(self.pid, &self.who, reason, waited);
            } else {
                crate::codex_kills::force(self.pid, true, &self.who, &format!("{reason} (hosted by the sign-in helper)"), true, waited);
                if let Some(job) = &self.job {
                    job.terminate();
                }
                h.kill().await;
                let _ = h.wait_exit(self.process, "close required termination", Duration::from_secs(1)).await;
            }
        }
        if let Some(mut c) = self.child.take() {
            let status = super::stop_gracefully(&mut c, self.job.as_ref(), &self.who, reason, grace).await;
            tracing::info!(pid = self.pid, process = %self.process, reason, %status, "CLI exit observation");
        }
    }

    pub async fn exit_status(&mut self, reason: &str) -> String {
        if let Some(h) = &self.hosted {
            return h.wait_exit(self.process, reason, Duration::from_secs(1)).await;
        }
        super::exit_status(&mut self.child, self.pid, self.process, reason).await
    }

    /// Started by the sign-in helper in the user's session.
    pub fn hosted(&self) -> bool {
        self.hosted.is_some()
    }

    pub fn alive(&mut self) -> bool {
        if let Some(h) = &self.hosted {
            return h.alive();
        }
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

fn thread_id_of(r: &Value) -> Option<String> {
    r.pointer("/thread/id").or_else(|| r.get("threadId")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Only the measured pre-shell runner failure, never arbitrary command stderr.
#[logged]
pub fn runner_startup_failed(item: &Value, completed: bool) -> bool {
    completed
        && item["type"].as_str() == Some("commandExecution")
        && item["status"].as_str() == Some("failed")
        && item["source"].as_str() == Some("unifiedExecStartup")
        && item.get("processId") == Some(&Value::Null)
        && item["durationMs"].as_u64() == Some(0)
        && item["aggregatedOutput"].as_str()
            == Some("Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in")
}

/// The actor reads effective authority afresh; these messages never run commands.
#[logged]
pub fn runner_startup_hint(can_retry: bool, authority_known: bool) -> &'static str {
    if can_retry {
        "Orgtree: Codex's Windows sandbox runner failed before the shell process started \
         (runner pipe-in timeout). Your current Orgtree scope permits shell commands and writes. \
         Retry the SAME failed command once, preserving its arguments and working directory, \
         with exec_command sandbox_permissions=\"require_escalated\" and a justification \
         identifying the runner startup failure. This uses the normal approval gate; your \
         permission mode has not changed. If that retry fails, report the error and stop \
         retrying. Orgtree has not replayed the command."
    } else if authority_known {
        "Orgtree: Codex's Windows sandbox runner failed before the shell process started \
         (runner pipe-in timeout). Your current Orgtree scope does not permit an outside-sandbox \
         command retry. Report this startup failure to your superior; do not retry outside the \
         sandbox. Orgtree has not replayed the command."
    } else {
        "Orgtree: Codex's Windows sandbox runner failed before the shell process started \
         (runner pipe-in timeout). Orgtree could not confirm your current shell and write \
         authority, so no outside-sandbox retry is authorized. Report this startup failure \
         to your superior. Orgtree has not replayed the command."
    }
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
    stdout: Box<dyn AsyncRead + Unpin + Send>,
    caller: Caller,
    actor: AgentTx,
    process: uuid::Uuid,
    writer: mpsc::UnboundedSender<String>,
    mut waiters_rx: mpsc::UnboundedReceiver<(i64, oneshot::Sender<Value>)>,
    policy: Policy,
) {
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let mut buf: Vec<u8> = Vec::new();
    // owned only by this task: request id â†’ its waiter
    let mut waiters: HashMap<i64, oneshot::Sender<Value>> = HashMap::new();
    let mut waiters_open = true;
    let reason = loop {
        let got = tokio::select! {
            w = waiters_rx.recv(), if waiters_open => {
                if let Some((id, tx)) = w { waiters.insert(id, tx); } else { waiters_open = false; }
                continue;
            }
            n = reader.read_until(b'\n', &mut buf) => n,
        };
        match got {
            Ok(0) => break "stdout EOF".to_string(),
            Err(e) => break format!("stdout read failed: {e}"),
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
                        let reply = match answer(&engine, &caller, &actor, &method, &params, policy, process).await {
                            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": e.to_string() } }),
                        };
                        let _ = writer.send(reply.to_string());
                    },
                    span,
                ));
            }
            (false, Some(_)) => {
                if !actor.post(AgentMsg::Codex(process, v)) {
                    break "actor closed".to_string();
                }
            }
            _ => {}
        }
    };
    let _ = actor.post(AgentMsg::ProcExited { process, reason });
}

/// A request from the app-server: an `orgtree_*` tool call, or an approval.
#[logged]
async fn answer(engine: &Arc<Engine>, caller: &Caller, actor: &AgentTx, method: &str, params: &Value, policy: Policy, process: uuid::Uuid) -> Result<Value> {
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
                let _ = actor.post(AgentMsg::Codex(process, json!({ "method": "orgtree/denied", "params": what })));
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
pub fn dynamic_tools(tools: &Value) -> Vec<Value> {
    crate::tools::defs::scoped(tools)
        .into_iter()
        .map(|t| json!({ "type": "function", "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] }))
        .collect()
}

/// The Codex home a launch without `CODEX_HOME` uses.
#[logged]
pub fn default_home() -> std::path::PathBuf {
    crate::rig::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(".codex")
}

/// A thread's rollout file under `home/sessions` (its path below `sessions`).
#[logged]
fn find_rollout(home: &std::path::Path, thread: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let root = home.join("sessions");
    let suffix = format!("{thread}.jsonl");
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                if depth < 4 {
                    stack.push((path, depth + 1));
                }
            } else if path.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(&suffix)).unwrap_or(false) {
                let rel = path.strip_prefix(&root).map(|p| p.to_path_buf()).unwrap_or_default();
                return Some((path, rel));
            }
        }
    }
    None
}

/// Read only the matching tool arguments from the provider's own transcript.
/// Never return other records (prompts, credentials or tool results).
#[logged]
pub fn original_tool_input(source: &Value) -> Option<Value> {
    use std::io::BufRead;
    let call_id = source["call_id"].as_str()?;
    let path = source["path"].as_str().map(PathBuf::from).filter(|p| p.is_file())
        .or_else(|| find_rollout(std::path::Path::new(source["home"].as_str()?), source["thread"].as_str()?).map(|p| p.0))?;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines() {
        let line = line.ok()?;
        // Avoid parsing the many unrelated transcript records.
        if !line.contains(call_id) { continue; }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        let item = &record["payload"];
        if record["type"] != "response_item" || item["call_id"].as_str() != Some(call_id) { continue; }
        match item["type"].as_str()? {
            "function_call" => return Some(item["arguments"].as_str()
                .and_then(|s| serde_json::from_str(s).ok()).unwrap_or_else(|| item["arguments"].clone())),
            "custom_tool_call" => return item.get("input").cloned(),
            "local_shell_call" => return item.get("action").cloned(),
            _ => {},
        }
    }
    None
}

/// Make sure `thread/resume` under `home` finds the thread: when its rollout
/// lives under another Codex home (the agent moved to another account),
/// copy it over. False when it exists nowhere.
#[logged]
pub fn ensure_rollout(thread: &str, home: Option<&str>, others: &[std::path::PathBuf]) -> bool {
    let target = home.map(std::path::PathBuf::from).unwrap_or_else(default_home);
    if find_rollout(&target, thread).is_some() {
        return true;
    }
    let mut homes = vec![default_home()];
    for o in others {
        if !homes.contains(o) {
            homes.push(o.clone());
        }
    }
    for h in homes.iter().filter(|h| **h != target) {
        if let Some((from, rel)) = find_rollout(h, thread) {
            let to = target.join("sessions").join(rel);
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::copy(&from, &to).is_ok() {
                tracing::info!(from = %from.display(), to = %to.display(), "carried a Codex thread to another account");
                return true;
            }
        }
    }
    false
}

/// `-c` overrides attaching granted MCP servers (quoted TOML names when needed).
#[nolog]
pub fn mcp_overrides(servers: &serde_json::Map<String, Value>) -> (Vec<String>, Vec<String>) {
    let bare = |s: &str| !s.is_empty() && s.chars().next().map(|c| c.is_ascii_alphanumeric() || c == '_').unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let toml = |v: &Value| serde_json::to_string(&v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    let mut out = Vec::new();
    let mut attached = Vec::new();
    for (name, srv) in servers {
        if name.is_empty() || !(srv.get("command").is_some() || srv.get("url").is_some()) {
            continue;
        }
        let key = if bare(name) { name.clone() } else { serde_json::to_string(name).unwrap_or_default() };
        for field in ["command", "args", "env", "url", "headers"] {
            let Some(val) = srv.get(field) else { continue };
            let rendered = match field {
                "args" => match val.as_array() {
                    Some(a) => format!("[{}]", a.iter().map(toml).collect::<Vec<_>>().join(", ")),
                    None => continue,
                },
                "env" | "headers" => match val.as_object() {
                    Some(o) => format!(
                        "{{{}}}",
                        o.iter().map(|(k, v)| format!("{} = {}", serde_json::to_string(k).unwrap_or_default(), toml(v))).collect::<Vec<_>>().join(", ")
                    ),
                    None => continue,
                },
                _ => toml(val),
            };
            out.push("-c".to_string());
            let field = if field == "headers" { "http_headers" } else { field };
            out.push(format!("mcp_servers.{key}.{field}={rendered}"));
        }
        // headless: a prompt would read as a rejection, so this server's tools are pre-approved
        out.push("-c".to_string());
        out.push(format!("mcp_servers.{key}.default_tools_approval_mode=\"approve\""));
        attached.push(name.clone());
    }
    (out, attached)
}

/// How long a short-lived app-server gets to exit by itself once its stdin
/// closes, before it is terminated (docket
/// urgent-orgtree-s-hard-killing-of-codex-processes: a codex killed with a
/// call in flight to lsass is the public trigger of lsass's RPCRT4 crash).
pub const PROBE_GRACE: Duration = Duration::from_secs(5);

/// A short-lived app-server's read of one login: (account, rate limits).
/// Only the fallback now: `usage::codex` reads the same limits over HTTPS.
#[nolog]
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
    winproc::own_group(&mut cmd);
    let mut child = cmd.spawn().with_context(|| format!("could not start {}", exe.display()))?;
    let job = winproc::child_job(&child);
    // from here on nothing returns before stop_gracefully: dropping the child
    // (kill_on_drop) or its job (kill-on-close) would be a hard kill
    let (mut stdin, stdout) = (child.stdin.take(), child.stdout.take());
    let frames = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                            "capabilities": { "experimentalApi": true } } }),
        json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "account/read", "params": { "refreshToken": false } }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "account/rateLimits/read", "params": null }),
    ];
    let work = async {
        let (Some(input), Some(stdout)) = (stdin.as_mut(), stdout) else { return Err(anyhow!("the Codex app-server has no stdio")) };
        for f in frames {
            input.write_all(format!("{f}\n").as_bytes()).await?;
        }
        input.flush().await?;
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
        Ok::<_, anyhow::Error>((account, limits))
    };
    let got = tokio::time::timeout(Duration::from_secs(25), work).await;
    drop(stdin);
    let reason = match &got {
        Ok(Ok(_)) => "probe answered",
        Ok(Err(_)) => "probe failed",
        Err(_) => "probe timed out",
    };
    let who = format!("usage probe ({})", home.unwrap_or("default login"));
    crate::runtime::stop_gracefully(&mut child, job.as_ref(), &who, reason, PROBE_GRACE).await;
    drop(job);
    let (account, limits) = got.unwrap_or_else(|_| Err(anyhow!("the Codex app-server did not answer in time")))?;
    let limits = limits.ok_or_else(|| anyhow!("the Codex app-server closed without answering"))??;
    Ok((account.unwrap_or(Value::Null), limits))
}

#[cfg(test)]
mod sandbox_tests {
    use super::sandbox;

    #[test]
    fn interactive_session_keeps_the_sandbox() {
        assert_eq!((sandbox(true, "acceptEdits", false).mode, sandbox(true, "acceptEdits", false).approval), ("workspace-write", "on-request"));
        assert_eq!(sandbox(false, "acceptEdits", false).mode, "read-only");
        assert_eq!(sandbox(true, "bypassPermissions", false).mode, "danger-full-access");
        assert!(!sandbox(true, "acceptEdits", false).session0);
    }

    #[test]
    fn session0_turns_the_sandbox_off() {
        let w = sandbox(true, "acceptEdits", true);
        assert_eq!((w.mode, w.approval, w.session0), ("danger-full-access", "on-request", true));
        let r = sandbox(false, "acceptEdits", true);
        assert_eq!((r.mode, r.approval, r.session0), ("danger-full-access", "untrusted", true));
        let p = sandbox(true, "plan", true);
        assert_eq!(p.mode, "danger-full-access");
        // bypass already ran unsandboxed: nothing changes, nothing to log
        let b = sandbox(true, "bypassPermissions", true);
        assert_eq!((b.approval, b.session0), ("on-request", false));
    }
}
