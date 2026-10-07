//! The Antigravity driver: `agy -p= --input-format stream-json
//! --output-format stream-json`, kept running with its input open so one
//! process serves many turns (`--conversation <id>` resumes after a
//! restart). The agent's tools reach it as a workspace MCP plugin pointing
//! at `orgtree-engine mcp-bridge` over a private named pipe; a narrowed
//! seat's scope is enforced by a PreToolUse hook (the CLI runs with
//! `--dangerously-skip-permissions`, because print mode cannot prompt).
//! Mid-turn mail reaches a running turn through the CLI's invocation hooks
//! (`orgtree-engine agy-steer`, as in 3.x); interrupt ends the process tree.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;
use crate::runtime::{AgentMsg, AgentTx, Caller, Post};
use crate::winproc;

const TOOLS_BASH: &[&str] = &["run_command", "send_command_input", "notebook_execution"];
const TOOLS_EDIT: &[&str] = &["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"];
const TOOLS_WEB: &[&str] = &[
    "search_web", "read_url_content", "open_browser_url", "read_browser_page", "list_browser_pages", "click_browser_pixel",
    "capture_browser_screenshot", "capture_browser_console_logs", "execute_browser_javascript", "browser_input",
    "browser_press_key", "browser_get_dom", "browser_click_element", "browser_select_option", "browser_refresh_page",
    "browser_resize_window", "browser_scroll", "browser_scroll_down", "browser_scroll_up", "browser_mouse_wheel",
    "browser_mouse_down", "browser_mouse_up", "browser_move_mouse", "browser_drag_pixel_to_pixel",
    "browser_list_network_requests", "browser_get_network_request", "browser_subagent",
];
const TOOLS_SUBAGENT: &[&str] = &["invoke_subagent", "manage_subagents", "browser_subagent"];
/// how a denial by our hook reads in a tool step's error
pub const HOOK_DENIED: &str = "tool call denied by pre-tool hook: orgtree:";

/// What one Antigravity process is launched with.
#[derive(Clone, Debug)]
pub struct AgySpec {
    pub exe: PathBuf,
    pub cwd: PathBuf,
    pub model: String,
    pub effort: Option<String>,
    pub conversation: Option<String>,
    pub identity: String,
    /// granted MCP servers (registry entries), besides orgtree's own
    pub servers: Map<String, Value>,
    /// tool switches and write rights from the agent's scope
    pub bash: bool,
    pub edit: bool,
    pub web: bool,
    pub subagents: bool,
    pub env: Vec<(String, String)>,
    pub turn_timeout_s: u64,
}

/// A running `agy` process. Dropping it ends the process tree and its tool pipe.
pub struct AgyProc {
    pub pid: u32,
    stdin: mpsc::UnboundedSender<String>,
    child: Option<Child>,
    job: Option<winproc::ChildJob>,
    pipe: CancellationToken,
    pub model: String,
}

impl Drop for AgyProc {
    fn drop(&mut self) {
        self.pipe.cancel();
    }
}

#[logged]
impl AgyProc {
    pub async fn spawn(engine: Arc<Engine>, spec: AgySpec, caller: Caller, actor: AgentTx) -> Result<AgyProc> {
        let pipe = CancellationToken::new();
        let pipe_name = crate::bridge::serve(engine.clone(), caller.clone(), pipe.clone())?;
        write_workspace(&spec, &pipe_name)?;
        let mut cmd = Command::new(&spec.exe);
        cmd.arg("-p=")
            .args(["--input-format", "stream-json", "--output-format", "stream-json"])
            .arg("--add-dir")
            .arg(&spec.cwd)
            .args(["--model", &spec.model]);
        if let Some(e) = &spec.effort {
            cmd.args(["--effort", e]);
        }
        if let Some(c) = &spec.conversation {
            cmd.args(["--conversation", c]);
        }
        cmd.arg("--dangerously-skip-permissions");
        if spec.turn_timeout_s > 0 {
            cmd.arg("--print-timeout").arg(format!("{}s", spec.turn_timeout_s));
        }
        cmd.current_dir(&spec.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // one credential per spawn: the CLI signs in from the OS keyring, and
        // its MCP children inherit whatever is not scrubbed here
        for (k, _) in std::env::vars() {
            if k.starts_with("ANTHROPIC_")
                || k.starts_with("CLAUDE_CODE_")
                || ["CLAUDECODE", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH",
                    "ORGTREE_V2_TOKEN", "ORGTREE_DATA", "ELECTRON_RUN_AS_NODE", "CODEX_HOME"]
                    .contains(&k.as_str())
            {
                cmd.env_remove(&k);
            }
        }
        cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(dir) = engine.settings.agent_build_cache_dir(&caller.org_slug, &caller.name) {
            cmd.env("CARGO_TARGET_DIR", dir);
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
                        tracing::info!("agy stderr (pid {pid}): {}", crate::util::gist(&l, 600));
                    }
                }
            },
            proc_span.clone(),
        ));
        tokio::spawn(tracing::Instrument::instrument(
            async move {
                let mut reader = BufReader::with_capacity(1 << 16, stdout);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let Ok(v) = serde_json::from_slice::<Value>(&buf) else { continue };
                    if !v.is_object() {
                        continue;
                    }
                    if !actor.post(AgentMsg::Agy(v)) {
                        break;
                    }
                }
                let _ = actor.post(AgentMsg::ProcExited);
            },
            proc_span,
        ));
        Ok(AgyProc { pid, stdin: tx, child: Some(child), job, pipe, model: spec.model })
    }

    /// One prompt; the process answers with a `result` and waits for the next.
    pub fn send_user(&self, text: &str) -> bool {
        self.stdin.send(json!({ "event": "user", "message": { "role": "user", "content": text } }).to_string()).is_ok()
    }

    /// Interrupt: there is no gentler way than ending the process tree.
    pub fn interrupt(&self) -> bool {
        match &self.job {
            Some(j) => {
                j.terminate();
                true
            }
            None => false,
        }
    }

    pub async fn kill(&mut self) {
        self.pipe.cancel();
        if let Some(job) = &self.job {
            job.terminate();
        }
        if let Some(mut c) = self.child.take() {
            let _ = c.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(5), c.wait()).await;
        }
    }

    pub async fn close(&mut self) {
        let (tx, _) = mpsc::unbounded_channel();
        self.stdin = tx;
        if let Some(mut c) = self.child.take() {
            if tokio::time::timeout(Duration::from_secs(5), c.wait()).await.is_err() {
                if let Some(job) = &self.job {
                    job.terminate();
                }
                let _ = c.start_kill();
            }
        }
        self.pipe.cancel();
    }

    pub fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

/// The tools a narrowed seat may not call, each with the reason the model is shown.
#[logged]
fn denied(spec: &AgySpec) -> BTreeMap<String, String> {
    let mut deny = BTreeMap::new();
    let rules: [(bool, &[&str], &str); 5] = [
        (spec.bash, TOOLS_BASH, "this agent has no shell rights (bash is off in its orgtree scope) — do not retry the command"),
        (spec.edit, TOOLS_EDIT, "this agent has no file-editing rights (edit is off in its orgtree scope, or it is on a plan-mode seat) — do not retry the write"),
        (spec.web, TOOLS_WEB, "this agent has no web rights (web access is off in its orgtree scope) — do not retry the fetch"),
        (spec.subagents, TOOLS_SUBAGENT, "this agent may not run subagents (subagents are off in its orgtree scope) — do the work in this turn instead"),
        (spec.edit, TOOLS_BASH, "this agent may not change files (edit is off in its orgtree scope, or it is on a plan-mode seat), and this CLI has no verified read-only shell — so the terminal is closed too. Read with view_file, grep_search, list_dir and find_by_name"),
    ];
    for (allowed, names, reason) in rules {
        if !allowed {
            for n in names {
                deny.entry(n.to_string()).or_insert_with(|| reason.to_string());
            }
        }
    }
    deny
}

/// `path` as one unquoted cmd token (carets for `& ^ ( )`), or None.
fn cmd_token(path: &str) -> Option<String> {
    if path.is_empty() || path.chars().any(|c| " \t\",;=%!".contains(c)) {
        return None;
    }
    Some(path.chars().map(|c| if "&^()".contains(c) { format!("^{c}") } else { c.to_string() }).collect())
}

/// The hooks.json command for the wrapper at `path`. The CLI hands it to cmd
/// through Go's argument escaping, so it may hold no quote and no space: the
/// path itself or its 8.3 alias, else the turn must not run unenforced.
fn hook_command(path: &Path) -> Result<String> {
    if !cfg!(windows) {
        return Ok(path.to_string_lossy().to_string());
    }
    let plain = path.to_string_lossy().to_string();
    if let Some(t) = cmd_token(&plain) {
        return Ok(t);
    }
    if let Some(t) = winproc::short_path(path).and_then(|s| cmd_token(&s.to_string_lossy())) {
        return Ok(t);
    }
    Err(anyhow!(
        "cannot install the orgtree rights hook for this agent: no cmd command line reaches {plain} (a space or one of , ; = % ! \
         and no 8.3 alias without it). Refusing to start the turn — a narrowed seat whose hook does not run would get full tool \
         access. Put Orgtree's data on a path without those characters, or enable 8.3 names on that volume."
    ))
}

/// Everything the CLI discovers in the agent's folder: the identity
/// (AGENTS.md), the tools (a workspace plugin), and — for a narrowed seat —
/// the rights hook; a full-rights seat gets the hook files removed.
#[logged]
fn write_workspace(spec: &AgySpec, pipe: &str) -> Result<()> {
    let cwd = &spec.cwd;
    std::fs::create_dir_all(cwd)?;
    std::fs::write(cwd.join("AGENTS.md"), &spec.identity)?;
    let agents = cwd.join(".agents");
    let plugin = agents.join("plugins").join("orgtree");
    std::fs::create_dir_all(&plugin)?;
    std::fs::write(plugin.join("plugin.json"), json!({ "name": "orgtree" }).to_string())?;
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let mut servers = Map::new();
    servers.insert(
        "orgtree".into(),
        json!({ "command": exe, "args": ["mcp-bridge", "--pipe", pipe], "env": { "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "" } }),
    );
    for (name, srv) in &spec.servers {
        if let Some(command) = srv.get("command").and_then(Value::as_str) {
            let mut env = json!({ "GEMINI_API_KEY": "", "GOOGLE_API_KEY": "" });
            if let Some(e) = srv.get("env").and_then(Value::as_object) {
                for (k, v) in e {
                    env[k] = json!(v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
                }
            }
            let args: Vec<String> = srv
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect())
                .unwrap_or_default();
            servers.insert(name.clone(), json!({ "command": command, "args": args, "env": env }));
        } else if let Some(url) = srv.get("url").and_then(Value::as_str) {
            let mut entry = json!({ "serverUrl": url });
            if let Some(h) = srv.get("headers").filter(|h| h.is_object()) {
                entry["headers"] = h.clone();
            }
            servers.insert(name.clone(), entry);
        }
    }
    std::fs::write(plugin.join("mcp_config.json"), serde_json::to_vec_pretty(&json!({ "mcpServers": servers }))?)?;
    let deny = denied(spec);
    let hooks = agents.join("hooks.json");
    let deny_file = agents.join("orgtree-rights.json");
    let wrapper = agents.join(if cfg!(windows) { "orgtree-rights.cmd" } else { "orgtree-rights.sh" });
    let mut doc = Map::new();
    if deny.is_empty() {
        for p in [&deny_file, &wrapper] {
            let _ = std::fs::remove_file(p);
        }
    } else {
        std::fs::write(&deny_file, serde_json::to_vec_pretty(&deny)?)?;
        if cfg!(windows) {
            std::fs::write(&wrapper, format!("@echo off\r\n\"{exe}\" agy-hook \"%~dp0orgtree-rights.json\"\r\n"))?;
        } else {
            std::fs::write(&wrapper, format!("#!/bin/sh\nexec \"{exe}\" agy-hook \"$(dirname \"$0\")/orgtree-rights.json\"\n"))?;
        }
        // resolved before hooks.json is written, so a refusal never leaves an unenforced seat behind
        let command =
            hook_command(&std::fs::canonicalize(&wrapper).map(|p| crate::config::strip_verbatim(&p)).unwrap_or(wrapper.clone()))?;
        doc.insert(
            "orgtree-rights".into(),
            json!({ "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": 20 }] }] }),
        );
    }
    // mid-turn mail: the invocation hooks hand a waiting message to the CLI
    match steering_hooks(&agents, &exe) {
        Ok(steer) => {
            doc.insert("orgtree-steering".into(), steer);
        }
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "mid-turn mail for this agent waits for its next turn"),
    }
    if doc.is_empty() {
        let _ = std::fs::remove_file(&hooks);
    } else {
        std::fs::write(&hooks, serde_json::to_vec_pretty(&Value::Object(doc))?)?;
    }
    Ok(())
}

/// The agent's private steer folder (the engine's handoff to the hook).
#[logged]
pub fn steer_dir(cwd: &Path) -> PathBuf {
    cwd.join(".agents").join("steer")
}

/// PreInvocation and PostInvocation hooks running `orgtree-engine agy-steer`,
/// with the steer folder cleared of any earlier process's handoff.
#[logged]
fn steering_hooks(agents: &Path, exe: &str) -> Result<Value> {
    let dir = agents.join("steer");
    std::fs::create_dir_all(&dir)?;
    for f in ["pending.json", "claimed.json", "emitted.json", "emitted.tmp", "pending.tmp"] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    let mut events = Map::new();
    for (stage, event) in [("pre", "PreInvocation"), ("post", "PostInvocation")] {
        let wrapper = agents.join(format!("orgtree-steer-{stage}{}", if cfg!(windows) { ".cmd" } else { ".sh" }));
        if cfg!(windows) {
            std::fs::write(&wrapper, format!("@echo off\r\n\"{exe}\" agy-steer {stage}\r\n"))?;
        } else {
            std::fs::write(&wrapper, format!("#!/bin/sh\nexec \"{exe}\" agy-steer {stage}\n"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755));
            }
        }
        let command =
            hook_command(&std::fs::canonicalize(&wrapper).map(|p| crate::config::strip_verbatim(&p)).unwrap_or(wrapper.clone()))?;
        events.insert(event.into(), json!([{ "type": "command", "command": command, "timeout": 20 }]));
    }
    Ok(Value::Object(events))
}

/// Dollars for one model request (Google bills prompt tokens above 200K at
/// the long-context rate on its pro-class models).
#[logged]
pub fn request_cost(model: &str, input: i64, cached: i64, output: i64) -> f64 {
    let pro = ["gemini-3.1-pro", "gemini-4-argon", "gemini-4-barium"].contains(&model);
    let (pi, pc, po) = if model.contains("flash") {
        (0.75, 0.075, 3.75)
    } else if pro && input + cached > 200_000 {
        (4.00, 0.40, 18.00)
    } else {
        (2.00, 0.20, 12.00)
    };
    (input as f64 * pi + cached as f64 * pc + output as f64 * po) / 1e6
}
