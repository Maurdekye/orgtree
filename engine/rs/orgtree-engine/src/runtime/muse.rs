//! The Muse Code driver: `muse serve`, the Muse Session Protocol (MSP:
//! JSON-RPC 2.0, one JSON object per stdio line), one process per active
//! agent holding one session (the agent's session). Measured against Muse
//! 1.4.6 (docs/rust-engine/muse-code.md):
//!
//! - The agent's identity is the host's developer prompt
//!   (`-c run.developer_prompt`); the session workspace's own AGENTS.md loads
//!   natively as a trusted project rule (`--trust-workspace`).
//! - Its `orgtree_*` tools are a session MCP server (`sessionMcp`):
//!   `orgtree-engine mcp-bridge` over a private named pipe, so the caller is
//!   the process the pipe was made for, never a tool argument.
//! - Muse's background observer agents (reminders) are switched off per host
//!   (`runtime_capabilities[…].enabled = false`), workflows off, and
//!   contributor mode off (user 2026-10-12: Orgtree agents never use it; the
//!   user's saved Muse setting is untouched).
//! - Shell and file writes the scope closes are closed at the host
//!   (`--disable-shell`, `--disable-write`); what remains is bounded by the
//!   session's permission profile, and approval requests are decided here
//!   from the scope, once at a time (never a persistent or session-wide
//!   approval, never the LLM judge).
//! - Mid-turn mail goes in with `turn/steer` on the exact running turn;
//!   interrupt is `turn/interrupt`; every notification goes to the actor as
//!   `AgentMsg::Muse`.
//! - A tool call that outlives the turn's silence limit is ended by itself
//!   (`task/stop`, after a `turn/steer` note naming the limit); the turn
//!   goes on (user 2026-10-13).
//! - A shell command Muse moves to the background (still running after
//!   about 10 s) can finish after its turn. Muse hands the result to the
//!   session itself, once, and starts a turn of its own to deliver it, which
//!   is cancelled here like any turn Orgtree did not start. The actor writes
//!   the result onto the call's chip, wakes an idle agent through its
//!   mailbox, and reports commands that ended with their host (measured on
//!   1.4.6, 2026-10-13).
//! - While the engine runs in Windows Session 0 (the boot task) Muse's OS
//!   sandbox cannot start a command, so a write seat's host runs without it
//!   (`--disable-sandbox`: then Muse asks about no command and its file tools
//!   can write outside the folders, measured) and a read-only seat has no
//!   shell (user 2026-10-13 18:53Z; kept knowing that, 20:16Z).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;
use crate::runtime::{AgentMsg, AgentTx, Caller, Post};
use crate::winproc;

/// Muse's background observer agents (its bundled settings contract names the
/// key `runtime_capabilities["plugin:tbh-reminders:reminder:<name>"].enabled`).
/// They start child runs Orgtree did not admit, whose usage Muse leaves out
/// of the session's totals, and two of them can hold a turn open.
pub const OBSERVERS: &[&str] = &["memory", "skill-reminder", "todo-reminder", "goal-reminder", "verify-reminder", "scope-reminder"];
/// A Windows command line holds 32,767 characters; the developer prompt is
/// one argument of it. Beyond this budget it travels by file (`MuseSpec`).
pub const PROMPT_ARG_BUDGET: usize = 26_000;

/// The permission profile a seat's session runs with (Muse's own catalog):
/// read-only seats read only; write seats edit their roots and ask (this
/// driver answers) for anything else; bypass seats run unrestricted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seat {
    pub profile: &'static str,
    pub approval: &'static str,
}

/// Whether a seat's host keeps Muse's OS sandbox for shell commands. In
/// Windows Session 0 (the engine's boot task, `codex::session0`) the
/// `windows_elevated` sandbox cannot start a command: measured on Muse 1.4.6,
/// a sandboxed call fails at once ("failed to send runner spawn_request ...
/// The pipe has been ended. (os error 109)") or, in the installed app, never
/// starts and produces nothing until the turn's silence limit, while the
/// same call without the sandbox returns in about half a second. There a
/// write seat runs without the sandbox, and that is more than the shell
/// (measured 2026-10-13): Muse then asks Orgtree about no command, and its
/// file tools also write outside the workspace roots without asking (with
/// the sandbox, Muse refuses that write itself). The user chose this over no
/// shell, knowing it (2026-10-13 20:16Z). A read-only seat has no shell
/// anyway (`may_shell` needs a write seat); a bypassPermissions seat is
/// unchanged (its `:unrestricted` profile runs without the sandbox already).
/// Outside Session 0 the sandbox stays on.
#[logged]
pub fn os_sandbox(session0: bool, may_write: bool, permission_mode: &str) -> bool {
    !(session0 && may_write && permission_mode != "bypassPermissions")
}

/// The session posture for a scope.
#[logged]
pub fn seat(may_write: bool, permission_mode: &str) -> Seat {
    if !may_write {
        Seat { profile: ":read-only", approval: "denyUnmatched" }
    } else if permission_mode == "bypassPermissions" {
        Seat { profile: ":unrestricted", approval: "allowAll" }
    } else {
        Seat { profile: ":ask-me", approval: "onRequest" }
    }
}

/// What one Muse process is launched with.
#[derive(Clone)]
pub struct MuseSpec {
    pub exe: PathBuf,
    /// the agent's folder: the session's primary workspace root and cwd
    pub cwd: PathBuf,
    /// further read/write workspace roots (granted read/write folders)
    pub roots: Vec<PathBuf>,
    /// read-only granted folders: never a workspace root (Muse gives every
    /// root the same write access); reads there are approved on request
    pub read_only: Vec<PathBuf>,
    pub model: String,
    /// the level each turn is sent (already one the model's catalog lists)
    pub effort: Option<String>,
    /// the agent's identity (the developer prompt)
    pub developer_prompt: String,
    pub seat: Seat,
    pub may_write: bool,
    pub may_shell: bool,
    /// Muse's OS sandbox for shell commands (off only in Session 0, `os_sandbox`)
    pub sandbox: bool,
    pub may_web: bool,
    pub may_subagents: bool,
    /// granted external MCP servers (registry entries), besides orgtree's own
    pub servers: Map<String, Value>,
    pub resume: Option<String>,
    /// extra environment (a registered login's roots, Orgtree's agent names)
    pub env: Vec<(String, String)>,
}

impl std::fmt::Debug for MuseSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MuseSpec")
            .field("exe", &self.exe)
            .field("cwd", &self.cwd)
            .field("roots", &self.roots)
            .field("read_only", &self.read_only)
            .field("model", &self.model)
            .field("effort", &self.effort)
            .field("developer_prompt", &self.developer_prompt.len())
            .field("seat", &self.seat)
            .field("may_write", &self.may_write)
            .field("may_shell", &self.may_shell)
            .field("sandbox", &self.sandbox)
            .field("may_web", &self.may_web)
            .field("may_subagents", &self.may_subagents)
            .field("servers", &self.servers.keys().collect::<Vec<_>>())
            .field("resume", &self.resume)
            // values may hold a key: names only
            .field("env", &self.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>())
            .finish()
    }
}

/// A running `muse serve`. Ending it closes its input first (`close`, `kill`).
pub struct MuseProc {
    pub pid: u32,
    pub process: uuid::Uuid,
    out: mpsc::UnboundedSender<String>,
    who: String,
    stdin_close: Option<oneshot::Sender<()>>,
    waiters: mpsc::UnboundedSender<(i64, oneshot::Sender<Value>)>,
    next: AtomicI64,
    child: Option<Child>,
    job: Option<winproc::ChildJob>,
    /// the agent's tool bridge (its pipe closes with this process)
    pipe: CancellationToken,
    /// the agent's Muse session
    pub session_id: String,
    pub model: String,
    pub effort: Option<String>,
    /// the developer prompt went by file (the command line could not hold it)
    pub prompt_by_file: bool,
    pub schema_fingerprint: Option<String>,
    /// the login it runs on, for its usage observations: None is the user's
    /// own; a managed login's root; `metered` an API key (no usage windows)
    pub login_root: Option<String>,
    pub metered: bool,
    /// the session's workspace roots, canonical, the agent's folder first,
    /// as this host was opened with them: every turn sends them (MSP's
    /// sticky replacement), so a resumed session runs on the current grants
    /// and never keeps a root that was revoked or made read-only since
    pub roots: Vec<String>,
}

/// A JSON-RPC error answered by the host, with its MSP kind.
#[derive(Debug)]
pub struct MspError {
    pub method: String,
    pub code: i64,
    pub kind: Option<String>,
    pub message: String,
}

impl std::fmt::Display for MspError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.method, self.message)?;
        if let Some(k) = &self.kind {
            write!(f, " ({k})")?;
        }
        Ok(())
    }
}

impl std::error::Error for MspError {}

/// A UUIDv7 (MSP command ids are UUIDv7: time-ordered).
#[nolog]
pub fn uuid7() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    let ms = chrono::Utc::now().timestamp_millis() as u64;
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(b).to_string()
}

/// A folder as MSP wants a workspace root: the canonical absolute path (on
/// Windows the verbatim `\\?\` form, measured on 1.4.6: anything else is
/// refused as non-canonical).
#[logged]
pub fn canonical(p: &Path) -> Option<String> {
    std::fs::canonicalize(p).ok().map(|c| c.to_string_lossy().to_string())
}

/// The host's command line, the developer prompt included when it fits.
#[logged]
pub fn host_args(spec: &MuseSpec, prompt_file: Option<&Path>) -> Vec<String> {
    let mut a: Vec<String> = vec!["serve".into(), "--provider".into(), "meta".into(), "--contributor-mode".into(), "off".into()];
    if !spec.may_shell {
        a.push("--disable-shell".into());
    }
    if !spec.may_write {
        a.push("--disable-write".into());
    }
    if !spec.sandbox {
        a.push("--disable-sandbox".into());
    }
    // the agent's own folder: its AGENTS.md (standing notes) and skills load as Muse's project rules
    a.push("--trust-workspace".into());
    let prompt = match prompt_file {
        Some(file) => file_prompt(file),
        None => spec.developer_prompt.clone(),
    };
    let mut set = |k: &str, v: Value| {
        a.push("-c".into());
        a.push(format!("{k}={v}"));
    };
    set("run.developer_prompt", json!(prompt));
    set("runtime_capabilities", observers_off());
    set("run.workflow_trigger_mode", json!("off"));
    if !spec.may_web {
        set("tools.web_search.mode", json!("off"));
        set("tools.web_fetch.enabled", json!(false));
    }
    a
}

/// Every observer agent switched off, in Muse's own settings shape.
#[logged]
pub fn observers_off() -> Value {
    let mut m = Map::new();
    for o in OBSERVERS {
        m.insert(format!("plugin:tbh-reminders:reminder:{o}"), json!({ "enabled": false }));
    }
    Value::Object(m)
}

/// The developer prompt when the identity is too long for the command line:
/// it names the file that holds it.
#[logged]
fn file_prompt(file: &Path) -> String {
    format!(
        "You are an Orgtree agent. Your complete Orgtree instructions (who you are, whom you answer to, your charter and \
         the organization's rules) are in the file {}. Read that whole file with read_file before you act on anything, at \
         the start of every session and again after any context compaction, and follow it as your system instructions.",
        file.display()
    )
}

/// The session MCP servers: Orgtree's own bridge, then each granted server.
/// Not logged: a registry entry's env or headers can hold its credentials.
#[nolog]
pub fn session_servers(bridge_pipe: &str, servers: &Map<String, Value>) -> Result<Map<String, Value>> {
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let mut out = Map::new();
    out.insert(
        "orgtree".into(),
        json!({ "transport": "stdio", "command": exe, "args": ["mcp-bridge", "--pipe", bridge_pipe],
                "framing": "lineDelimitedJson", "mode": "required" }),
    );
    for (name, srv) in servers {
        if name == "orgtree" {
            continue;
        }
        if let Some(command) = srv.get("command").and_then(Value::as_str) {
            let args: Vec<String> = srv
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect())
                .unwrap_or_default();
            let mut entry = json!({ "transport": "stdio", "command": command, "args": args, "mode": "optional" });
            if let Some(env) = srv.get("env").and_then(Value::as_object) {
                let env: Map<String, Value> = env
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))))
                    .collect();
                entry["env"] = Value::Object(env);
            }
            out.insert(name.clone(), entry);
        } else if let Some(url) = srv.get("url").and_then(Value::as_str) {
            let mut entry = json!({ "transport": "streamableHttp", "url": url, "mode": "optional" });
            if let Some(h) = srv.get("headers").filter(|h| h.is_object()) {
                entry["headers"] = h.clone();
            }
            out.insert(name.clone(), entry);
        }
    }
    Ok(out)
}

/// What the agent's scope lets Muse do on its own: the approval policy.
#[derive(Clone, Debug)]
struct Policy {
    may_write: bool,
    may_shell: bool,
    /// read/write roots (lower-cased, separators normalised)
    write: Vec<String>,
    /// every granted folder plus the agent's own
    read: Vec<String>,
    /// MCP servers the agent may call
    servers: Vec<String>,
}

#[nolog]
fn norm(p: &str) -> String {
    let s = p.trim_start_matches(r"\\?\").replace('\\', "/").to_lowercase();
    s.trim_end_matches('/').to_string()
}

#[nolog]
fn under(path: &str, roots: &[String]) -> bool {
    let p = norm(path);
    roots.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
}

/// Whether the scope allows an approval subject (and why not). Unknown
/// subjects are refused: an approval this driver cannot read is never given.
#[logged]
fn allowed(policy: &Policy, subject: &Value, tool: &str) -> std::result::Result<(), String> {
    let kind = subject["kind"].as_str().unwrap_or("");
    let path = subject["path"].as_str().unwrap_or("");
    match kind {
        "shell" | "process" | "unixSocket" | "network" => {
            if policy.may_shell && policy.may_write {
                Ok(())
            } else {
                Err("this agent's scope does not allow terminal commands".into())
            }
        }
        "fileAccess" => {
            let write = subject["access"].as_str().is_some_and(|a| a.to_lowercase().contains("write"));
            if write {
                if policy.may_write && under(path, &policy.write) {
                    Ok(())
                } else {
                    Err(format!("this agent may not write {path}"))
                }
            } else if under(path, &policy.read) {
                Ok(())
            } else {
                Err(format!("{path} is outside this agent's folders"))
            }
        }
        "tool" => {
            let name = subject["toolName"].as_str().unwrap_or(tool);
            let server = name.strip_prefix("mcp__").and_then(|r| r.split("__").next()).unwrap_or("");
            if !server.is_empty() && policy.servers.iter().any(|s| s == server) {
                Ok(())
            } else {
                Err(format!("{name} is not among this agent's tools"))
            }
        }
        other => Err(format!("an approval of kind {other:?} is never given to an Orgtree agent")),
    }
}

/// The choice that answers an approval: approve or refuse ONCE. A choice that
/// would persist (a session or local rule, a policy amendment) is never made.
/// A refusal is MSP's `denied` when offered, else `abort`: real Muse 1.4.6
/// offers only `allow_once`, `allow_local_prefix` and `abort` ("Reject",
/// scope once), and an `abort` rejects that one call while the turn goes on
/// (measured 2026-10-13).
#[logged]
fn choice(choices: &Value, approve: bool) -> Option<String> {
    let once = |want: &str| {
        choices.as_array()?.iter().find(|c| c["decision"].as_str() == Some(want) && c["scope"].as_str() == Some("once"))
            .and_then(|c| c["choiceId"].as_str().map(str::to_string))
    };
    if approve { once("approved") } else { once("denied").or_else(|| once("abort")) }
}

#[logged]
impl MuseProc {
    #[nolog]
    pub async fn spawn(engine: Arc<Engine>, spec: MuseSpec, caller: Caller, actor: AgentTx) -> Result<MuseProc> {
        let pipe = CancellationToken::new();
        let pipe_name = crate::bridge::serve(engine.clone(), caller.clone(), pipe.clone(), crate::tools::defs::MailShape::Split)?;
        // the identity by file when the command line cannot hold it
        let (prompt_file, prompt_by_file) = if spec.developer_prompt.chars().count() > PROMPT_ARG_BUDGET {
            let file = spec.cwd.join(".orgtree-muse-identity.md");
            std::fs::write(&file, &spec.developer_prompt).with_context(|| format!("could not write {}", file.display()))?;
            (Some(file), true)
        } else {
            (None, false)
        };
        let env = crate::providers::muse_models::clean_env(&spec.env);
        let mut cmd = Command::new(&spec.exe);
        cmd.args(host_args(&spec, prompt_file.as_deref()))
            .current_dir(&spec.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
        winproc::no_window(&mut cmd);
        winproc::own_group(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                pipe.cancel();
                return Err(anyhow!(e).context(format!("could not start {}", spec.exe.display())));
            }
        };
        let job = winproc::child_job(&child);
        let pid = child.id().unwrap_or(0);
        let process = uuid::Uuid::new_v4();
        tracing::info!(agent = caller.agent_id, pid, %process, provider = "Muse", prompt_by_file, profile = spec.seat.profile,
            shell = spec.may_shell, write = spec.may_write, sandbox = spec.sandbox, "CLI started");
        let (Some(mut stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            pipe.cancel();
            let who = format!("agent {} (#{})", caller.name, caller.agent_id);
            super::stop_gracefully(&mut child, job.as_ref(), &who, "no stdio", Duration::from_secs(3)).await;
            return Err(anyhow!("the Muse host has no stdio"));
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
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
                        tracing::info!("muse stderr (pid {pid}): {}", crate::util::gist(&l, 600));
                    }
                }
            },
            proc_span.clone(),
        ));
        let who = format!("agent {} (#{})", caller.name, caller.agent_id);
        let (wtx, wrx) = mpsc::unbounded_channel();
        let canon_all = |dirs: &[PathBuf]| dirs.iter().filter_map(|d| canonical(d)).map(|c| norm(&c)).collect::<Vec<_>>();
        let mut write = canon_all(&spec.roots);
        write.extend(canonical(&spec.cwd).map(|c| norm(&c)));
        let mut read = write.clone();
        read.extend(canon_all(&spec.read_only));
        let mut servers: Vec<String> = spec.servers.keys().cloned().collect();
        servers.push("orgtree".into());
        let policy = Policy { may_write: spec.may_write, may_shell: spec.may_shell, write, read, servers };
        tokio::spawn(tracing::Instrument::instrument(read_stdout(stdout, actor, process, tx.clone(), wrx, policy), proc_span));
        let mut proc = MuseProc {
            pid,
            process,
            out: tx,
            who,
            stdin_close: Some(stdin_close),
            waiters: wtx,
            next: AtomicI64::new(1),
            child: Some(child),
            job,
            pipe,
            session_id: String::new(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            prompt_by_file,
            schema_fingerprint: None,
            login_root: None,
            metered: false,
            roots: Vec::new(),
        };
        // a host that fails to open still ends gracefully, not by drop
        if let Err(e) = proc.open(&spec, &pipe_name).await {
            proc.close().await;
            return Err(e);
        }
        Ok(proc)
    }

    async fn open(&mut self, spec: &MuseSpec, pipe_name: &str) -> Result<()> {
        let init = self
            .request(
                "initialize",
                json!({ "clientInfo": { "name": "orgtree", "title": "Orgtree", "version": env!("CARGO_PKG_VERSION") },
                        "capabilities": { "experimentalApi": true, "userInputDialogs": false,
                                          "requestedCapabilities": ["sessionMcp"] } }),
                Duration::from_secs(60),
            )
            .await
            .context("the Muse host did not initialize")?;
        let version = init.pointer("/schema/version").and_then(Value::as_i64);
        if version != Some(crate::providers::muse_models::SCHEMA_VERSION) {
            return Err(anyhow!("this Muse build speaks MSP schema {version:?}; Orgtree speaks {}",
                crate::providers::muse_models::SCHEMA_VERSION));
        }
        if !init["grantedCapabilities"].as_array().is_some_and(|a| a.iter().any(|c| c == "sessionMcp")) {
            return Err(anyhow!("the Muse host refused session MCP servers, so the agent's Orgtree tools cannot reach it"));
        }
        self.schema_fingerprint = init.pointer("/schema/fingerprint").and_then(Value::as_str).map(str::to_string);
        if !crate::providers::muse_models::verified(self.schema_fingerprint.as_deref()) {
            tracing::warn!(fingerprint = ?self.schema_fingerprint, "this Muse build's MSP schema is not one Orgtree was verified against");
        }
        self.notify("initialized", Value::Null);
        let servers = session_servers(pipe_name, &spec.servers)?;
        let primary = canonical(&spec.cwd).ok_or_else(|| anyhow!("the agent's folder {} is missing", spec.cwd.display()))?;
        let mut roots = vec![primary.clone()];
        for r in &spec.roots {
            if let Some(c) = canonical(r) {
                if !roots.iter().any(|x| norm(x) == norm(&c)) {
                    roots.push(c);
                }
            }
        }
        // session/resume admits no roots: the stored session keeps the set it
        // last had until a turn replaces it, which every turn now does
        self.roots = roots.clone();
        let mut session: Option<String> = None;
        if let Some(sid) = &spec.resume {
            match self
                .request(
                    "session/resume",
                    json!({ "commandId": uuid7(), "sessionId": sid, "excludeItems": true,
                            "config": { "mcpServers": servers.clone() } }),
                    Duration::from_secs(120),
                )
                .await
            {
                Ok(r) => {
                    let got = r.pointer("/session/sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                    if got == *sid {
                        // a resumed session keeps its stored posture: set this seat's now, or
                        // give the session up rather than run it wider than the scope
                        match self.posture(sid, spec).await {
                            Ok(()) => session = Some(got),
                            Err(e) => tracing::warn!(session = %sid, error = %format!("{e:#}"),
                                "the resumed Muse session could not take this seat's permissions; starting a new one"),
                        }
                    }
                }
                Err(e) => tracing::warn!(session = %sid, error = %format!("{e:#}"), "the Muse session could not be resumed; starting a new one"),
            }
        }
        let session = match session {
            Some(s) => s,
            None => {
                let r = self
                    .request(
                        "session/start",
                        json!({ "commandId": uuid7(), "workspaceRoot": primary, "workspaceRoots": roots,
                                "approvalMode": spec.seat.approval, "permissionProfile": spec.seat.profile,
                                "modelId": spec.model, "config": { "mcpServers": servers } }),
                        Duration::from_secs(120),
                    )
                    .await
                    .context("session/start")?;
                r.pointer("/session/sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| anyhow!("session/start returned no session id"))?
            }
        };
        self.session_id = session;
        Ok(())
    }

    /// A resumed session takes this seat's model, approval mode and
    /// permission profile (resume admits none of them).
    async fn posture(&self, sid: &str, spec: &MuseSpec) -> Result<()> {
        self.request("session/setModel", json!({ "commandId": uuid7(), "sessionId": sid, "model": { "modelId": spec.model } }), Duration::from_secs(30))
            .await?;
        self.request("session/setApprovalMode", json!({ "commandId": uuid7(), "sessionId": sid, "mode": spec.seat.approval }), Duration::from_secs(30))
            .await?;
        self.request(
            "session/setPermissionProfile",
            json!({ "commandId": uuid7(), "sessionId": sid, "profileId": spec.seat.profile }),
            Duration::from_secs(30),
        )
        .await?;
        Ok(())
    }

    #[nolog]
    fn send(&self, v: &Value) -> bool {
        self.out.send(v.to_string()).is_ok()
    }

    #[nolog]
    pub fn notify(&self, method: &str, params: Value) -> bool {
        let mut f = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            f["params"] = params;
        }
        self.send(&f)
    }

    /// A request and its result, or the host's error (as `MspError`), or a
    /// timeout. Not logged: its params carry the session's configuration,
    /// granted MCP servers' environment, headers and arguments included, and
    /// its result the host's own data. One line names the method, how long it
    /// took and how it ended (its MSP error kind), never a value.
    #[nolog]
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let t0 = Instant::now();
        let r = self.exchange(method, params, timeout).await;
        let outcome = match &r {
            Ok(_) => "ok",
            Err(e) => e.downcast_ref::<MspError>().and_then(|m| m.kind.as_deref()).unwrap_or("failed"),
        };
        tracing::info!(method, ms = t0.elapsed().as_millis() as u64, outcome, "MSP request");
        r
    }

    #[nolog]
    async fn exchange(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if self.waiters.send((id, tx)).is_err() {
            return Err(anyhow!("the Muse host is gone"));
        }
        let mut f = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if !params.is_null() {
            f["params"] = params;
        }
        if !self.send(&f) {
            return Err(anyhow!("the Muse host is gone"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => match resp.get("error").filter(|e| !e.is_null()) {
                Some(e) => Err(MspError {
                    method: method.to_string(),
                    code: e["code"].as_i64().unwrap_or(0),
                    kind: e.pointer("/data/kind").and_then(Value::as_str).map(str::to_string),
                    message: e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string()),
                }
                .into()),
                None => Ok(resp.get("result").cloned().unwrap_or(Value::Null)),
            },
            Ok(Err(_)) => Err(anyhow!("the Muse host closed")),
            Err(_) => Err(anyhow!("{method}: no answer within {timeout:?}")),
        }
    }

    /// Start a turn on the session: (turn id, disposition). A host that is
    /// busy with work Orgtree did not start queues it (`ifBusy: queue`, set
    /// explicitly); the turn is the one the ack names. Every turn carries the
    /// workspace roots (see `roots`). Not logged: the prompt and image bytes;
    /// one line counts them.
    #[nolog]
    pub async fn start_turn(&self, text: &str, images: Vec<Value>) -> Result<(String, String)> {
        tracing::info!(chars = text.chars().count(), images = images.len(), roots = self.roots.len(), "MSP turn start");
        let mut input = vec![json!({ "type": "text", "text": text })];
        input.extend(images);
        let mut params = json!({ "commandId": uuid7(), "sessionId": self.session_id, "input": input, "ifBusy": "queue",
                                 "workspaceRoots": self.roots });
        if let Some(e) = &self.effort {
            params["reasoningEffort"] = json!(e);
        }
        let r = self.request("turn/start", params, Duration::from_secs(120)).await?;
        let turn = r["turnId"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("turn/start named no turn"))?;
        Ok((turn.to_string(), r["disposition"].as_str().unwrap_or("started").to_string()))
    }

    /// Mid-turn input into the exact running turn; an error means it did not
    /// reach that turn (it ended or was replaced).
    pub async fn steer(&self, turn_id: &str, text: &str) -> Result<()> {
        self.steer_within(turn_id, text, Duration::from_secs(30)).await
    }

    /// `steer`, waiting at most `timeout` for the host's acknowledgement.
    pub async fn steer_within(&self, turn_id: &str, text: &str, timeout: Duration) -> Result<()> {
        self.request(
            "turn/steer",
            json!({ "commandId": uuid7(), "sessionId": self.session_id, "expectedTurnId": turn_id,
                    "input": [{ "type": "text", "text": text }] }),
            timeout,
        )
        .await
        .map(|_| ())
    }

    /// End one tool call of the running turn by itself (MSP `task/stop`; a
    /// tool call's task id is its item id). Measured on Muse 1.4.6, for a call
    /// in the foreground too: the item settles `cancelled` ("cancelled by
    /// runtime client"), the model receives that result and the turn goes on.
    /// The acknowledgement only; the item reports the end.
    pub async fn stop_task(&self, task_id: &str) -> Result<()> {
        self.request("task/stop", json!({ "commandId": uuid7(), "sessionId": self.session_id, "taskId": task_id }),
            Duration::from_secs(10))
            .await
            .map(|_| ())
    }

    /// Ask the host to stop the turn (its `turn/completed` ends it).
    pub fn interrupt(&self, turn_id: &str) -> bool {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": "turn/interrupt",
                           "params": { "commandId": uuid7(), "sessionId": self.session_id, "turnId": turn_id } }))
    }

    /// Stop one child the session started that the agent's scope does not
    /// allow (its outcome folds onto the subagent item).
    pub fn stop_subagent(&self, subagent_id: &str, reason: &str) -> bool {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": "subagent/stop",
                           "params": { "commandId": uuid7(), "sessionId": self.session_id, "subagentId": subagent_id, "reason": reason } }))
    }

    /// Cancel a turn Orgtree did not start (a scheduled or automatic one).
    pub fn cancel_turn(&self, turn_id: &str) -> bool {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": "turn/cancel",
                           "params": { "commandId": uuid7(), "sessionId": self.session_id, "turnId": turn_id } }))
    }

    /// Compact the session (the `/compact` command): admission only, the
    /// compaction item reports its end. Not logged: the host's raw answer
    /// (`request` names the method and how it ended).
    #[nolog]
    pub async fn compact(&self) -> Result<Value> {
        self.request("session/compact", json!({ "commandId": uuid7(), "sessionId": self.session_id }), Duration::from_secs(60)).await
    }

    /// Stop it now (halt, stop): graceful first, with a short wait.
    pub async fn kill(&mut self) {
        self.end(Duration::from_secs(3), "termination requested").await;
    }

    /// Close its input and let it exit by itself; terminate only if it lingers.
    pub async fn close(&mut self) {
        self.end(Duration::from_secs(5), "close requested").await;
    }

    async fn end(&mut self, grace: Duration, reason: &str) {
        let (tx, _) = mpsc::unbounded_channel();
        self.out = tx;
        if let Some(close) = self.stdin_close.take() {
            let _ = close.send(());
        }
        if let Some(mut c) = self.child.take() {
            let status = super::stop_gracefully(&mut c, self.job.as_ref(), &self.who, reason, grace).await;
            tracing::info!(pid = self.pid, process = %self.process, reason, %status, "CLI exit observation");
        }
        self.pipe.cancel();
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

impl Drop for MuseProc {
    fn drop(&mut self) {
        self.pipe.cancel();
    }
}

#[logged]
async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    actor: AgentTx,
    process: uuid::Uuid,
    writer: mpsc::UnboundedSender<String>,
    mut waiters_rx: mpsc::UnboundedReceiver<(i64, oneshot::Sender<Value>)>,
    policy: Policy,
) {
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let mut buf: Vec<u8> = Vec::new();
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
                // a must-answer request: the answer is only a presentation
                // receipt; the decision travels as its own command after it
                let _ = writer.send(json!({ "jsonrpc": "2.0", "id": v["id"], "result": {} }).to_string());
                answer(method, &v["params"], &policy, &writer, &actor, process);
            }
            (false, Some(_)) => {
                if !actor.post(AgentMsg::Muse(process, v)) {
                    break "actor closed".to_string();
                }
            }
            _ => {}
        }
    };
    let _ = actor.post(AgentMsg::ProcExited { process, reason });
}

/// Decide a server request from the scope: an approval once, a user-input
/// prompt declined (agents ask the user with orgtree_ask).
#[logged]
fn answer(method: &str, p: &Value, policy: &Policy, writer: &mpsc::UnboundedSender<String>, actor: &AgentTx, process: uuid::Uuid) {
    let session = p["sessionId"].clone();
    let send = |m: &str, params: Value| {
        let _ = writer.send(json!({ "jsonrpc": "2.0", "id": format!("d-{}", uuid7()), "method": m, "params": params }).to_string());
    };
    match method {
        "approval/request" => {
            let tool = p["toolName"].as_str().unwrap_or("");
            let verdict = allowed(policy, &p["subject"], tool);
            let Some(choice_id) = choice(&p["availableChoices"], verdict.is_ok()) else {
                // nothing to answer with: Muse keeps the call waiting (no host
                // timeout was seen) until the silence limit stops it. The
                // choices' shapes only: a label can quote the command.
                let offered: Vec<String> = p["availableChoices"].as_array().map(|a| a.iter()
                    .map(|c| format!("{}:{}:{}", c["choiceId"].as_str().unwrap_or("?"), c["decision"].as_str().unwrap_or("?"), c["scope"].as_str().unwrap_or("?")))
                    .collect()).unwrap_or_default();
                tracing::warn!(approval = %p["approvalId"], approve = verdict.is_ok(), offered = ?offered,
                    "no once-only choice for this approval; the call waits until the silence limit stops it");
                return;
            };
            if let Err(why) = &verdict {
                let arg = crate::util::gist(p["subject"]["command"].as_str().or(p["subject"]["path"].as_str()).unwrap_or(p["rawArgs"].as_str().unwrap_or("")), 90);
                let _ = actor.post(AgentMsg::Muse(process, json!({ "method": "orgtree/denied", "params": { "tool": tool, "arg": arg, "why": why } })));
            }
            send("approval/decide", json!({ "commandId": uuid7(), "sessionId": session, "approvalId": p["approvalId"],
                                            "choiceId": choice_id, "requirementId": p["currentRequirementId"] }));
        }
        "userInput/request" => {
            send("userInput/cancel", json!({ "commandId": uuid7(), "sessionId": session, "userInputId": p["userInputId"],
                                             "reason": "Orgtree agents ask the user with orgtree_ask" }));
        }
        other => tracing::warn!(method = other, "unexpected Muse server request; answered with a receipt only"),
    }
}

/// Image attachments as MSP image parts (base64), capped like the Claude lane.
#[nolog] // bulk image bytes
pub fn images(paths: &[String]) -> Vec<Value> {
    use base64::Engine as _;
    let mut out = Vec::new();
    for path in paths {
        let lower = path.to_lowercase();
        let media = if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else {
            continue;
        };
        if let Ok(bytes) = std::fs::read(path) {
            if !bytes.is_empty() && bytes.len() < 5 * 1024 * 1024 {
                out.push(json!({ "type": "image", "mediaType": media, "base64Data": base64::engine::general_purpose::STANDARD.encode(bytes) }));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> MuseSpec {
        MuseSpec {
            exe: PathBuf::from("muse"),
            cwd: PathBuf::from("."),
            roots: vec![],
            read_only: vec![],
            model: "muse-wonder-1.0".into(),
            effort: Some("high".into()),
            developer_prompt: "be useful".into(),
            seat: seat(true, "acceptEdits"),
            may_write: true,
            may_shell: true,
            sandbox: true,
            may_web: false,
            may_subagents: false,
            servers: Map::new(),
            resume: None,
            env: vec![],
        }
    }

    #[test]
    fn host_line_closes_what_the_scope_closes() {
        let mut s = spec();
        let a = host_args(&s, None);
        assert!(a.windows(2).any(|w| w[0] == "--contributor-mode" && w[1] == "off"));
        assert!(a.contains(&"--trust-workspace".to_string()));
        assert!(!a.contains(&"--disable-shell".to_string()) && !a.contains(&"--disable-write".to_string()));
        assert!(a.iter().any(|x| x == r#"tools.web_search.mode="off""#));
        assert!(a.iter().any(|x| x.starts_with("runtime_capabilities=") && x.contains("verify-reminder")));
        assert!(a.iter().any(|x| x == r#"run.developer_prompt="be useful""#));
        s.may_shell = false;
        s.may_write = false;
        s.may_web = true;
        let a = host_args(&s, None);
        assert!(a.contains(&"--disable-shell".to_string()) && a.contains(&"--disable-write".to_string()));
        assert!(!a.iter().any(|x| x.starts_with("tools.web_search")));
    }

    #[test]
    fn session0_turns_the_sandbox_off_for_write_seats_only() {
        // outside Session 0: the sandbox stays on for every seat
        for pm in ["acceptEdits", "default", "bypassPermissions"] {
            assert!(os_sandbox(false, true, pm) && os_sandbox(false, false, pm));
        }
        // in Session 0: off for write seats; read-only and bypass seats unchanged
        assert!(!os_sandbox(true, true, "acceptEdits") && !os_sandbox(true, true, "default"));
        assert!(os_sandbox(true, false, "acceptEdits"));
        assert!(os_sandbox(true, true, "bypassPermissions"));
        let mut s = spec();
        assert!(!host_args(&s, None).contains(&"--disable-sandbox".to_string()));
        s.sandbox = false;
        assert!(host_args(&s, None).contains(&"--disable-sandbox".to_string()));
    }

    #[test]
    fn seats_never_ask_the_judge() {
        assert_eq!(seat(false, "bypassPermissions"), Seat { profile: ":read-only", approval: "denyUnmatched" });
        assert_eq!(seat(true, "bypassPermissions"), Seat { profile: ":unrestricted", approval: "allowAll" });
        assert_eq!(seat(true, "acceptEdits").profile, ":ask-me");
    }

    #[test]
    fn approvals_follow_the_scope_and_are_once_only() {
        let p = Policy {
            may_write: true,
            may_shell: false,
            write: vec![norm(r"\\?\D:\work\agent")],
            read: vec![norm(r"\\?\D:\work\agent"), norm(r"D:\shared")],
            servers: vec!["orgtree".into()],
        };
        assert!(allowed(&p, &json!({ "kind": "fileAccess", "access": "write", "path": r"D:\work\agent\a.txt" }), "").is_ok());
        assert!(allowed(&p, &json!({ "kind": "fileAccess", "access": "write", "path": r"D:\shared\a.txt" }), "").is_err());
        assert!(allowed(&p, &json!({ "kind": "fileAccess", "access": "read", "path": r"D:\Shared\b.txt" }), "").is_ok());
        assert!(allowed(&p, &json!({ "kind": "fileAccess", "access": "read", "path": r"D:\other" }), "").is_err());
        assert!(allowed(&p, &json!({ "kind": "shell", "command": "dir" }), "").is_err());
        assert!(allowed(&p, &json!({ "kind": "tool", "toolName": "mcp__orgtree__orgtree_status" }), "").is_ok());
        assert!(allowed(&p, &json!({ "kind": "tool", "toolName": "mcp__other__x" }), "").is_err());
        assert!(allowed(&p, &json!({ "kind": "somethingNew" }), "").is_err());
        let choices = json!([
            { "choiceId": "a", "decision": "approvedForSession", "scope": "session" },
            { "choiceId": "b", "decision": "approved", "scope": "once" },
            { "choiceId": "c", "decision": "approvedPolicyAmendment", "scope": "localPersistent" },
            { "choiceId": "d", "decision": "denied", "scope": "once" } ]);
        assert_eq!(choice(&choices, true).as_deref(), Some("b"));
        assert_eq!(choice(&choices, false).as_deref(), Some("d"));
        assert_eq!(choice(&json!([{ "choiceId": "x", "decision": "approved", "scope": "session" }]), true), None);
    }

    #[test]
    fn a_refusal_is_real_muses_once_only_abort() {
        // what Muse 1.4.6 offers for a shell approval (measured 2026-10-13)
        let real = json!([
            { "choiceId": "allow_once", "label": "Allow once", "decision": "approved", "scope": "once" },
            { "choiceId": "allow_local_prefix", "label": "Always allow in this workspace: Set-Content ...",
              "decision": "approvedPolicyAmendment", "scope": "localPersistent", "rulePreview": "Always allow in this workspace: Set-Content ..." },
            { "choiceId": "abort", "label": "Reject", "decision": "abort", "scope": "once", "acceptsFeedback": true } ]);
        assert_eq!(choice(&real, true).as_deref(), Some("allow_once"), "never the persistent prefix rule");
        assert_eq!(choice(&real, false).as_deref(), Some("abort"));
        // MSP's own denial wins when both are offered; an abort that would persist is never taken
        let both = json!([{ "choiceId": "abort", "decision": "abort", "scope": "once" }, { "choiceId": "no", "decision": "denied", "scope": "once" }]);
        assert_eq!(choice(&both, false).as_deref(), Some("no"));
        assert_eq!(choice(&json!([{ "choiceId": "abort", "decision": "abort", "scope": "session" }]), false), None);
        assert_eq!(choice(&json!([{ "choiceId": "abort", "decision": "abort", "scope": "once" }]), true), None, "an abort never approves");
    }

    #[test]
    fn uuid7_is_version_7() {
        let u = uuid::Uuid::parse_str(&uuid7()).unwrap();
        assert_eq!(u.get_version_num(), 7);
    }
}
