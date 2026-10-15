//! The Antigravity driver: `agy -p= --input-format stream-json
//! --output-format stream-json`, kept running with its input open so one
//! process serves many turns (`--conversation <id>` resumes after a
//! restart). The agent's tools reach it as a workspace MCP plugin pointing
//! at `orgtree-engine mcp-bridge` over a private named pipe (a Unix socket
//! on macOS and Linux; see bridge.rs); a narrowed
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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
#[derive(Clone)]
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

impl std::fmt::Debug for AgySpec {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgySpec").field("exe", &self.exe).field("cwd", &self.cwd)
            .field("model", &self.model).field("effort", &self.effort)
            .field("env", &"<redacted>").field("servers", &self.servers.len()).finish()
    }
}

/// A running `agy` process. Dropping it ends the process tree and its tool pipe.
pub struct AgyProc {
    pub pid: u32,
    pub process: uuid::Uuid,
    stdin: mpsc::UnboundedSender<String>,
    child: Option<Child>,
    job: Option<Arc<winproc::ChildJob>>,
    pipe: CancellationToken,
    pub model: String,
    pub auth_stamp: crate::providers::agy_auth::Stamp,
}

impl Drop for AgyProc {
    fn drop(&mut self) {
        self.pipe.cancel();
    }
}

#[logged]
impl AgyProc {
    #[nolog]
    pub async fn spawn(engine: Arc<Engine>, spec: AgySpec, caller: Caller, actor: AgentTx) -> Result<AgyProc> {
        let auth_stamp = crate::providers::agy_auth::preflight(&engine, &spec.exe).await?;
        let pipe = CancellationToken::new();
        // the mail tools in their flat shape: the nested one is unchecked on
        // this CLI (coordinator 2026-10-13 21:36Z, tools::defs::MailShape)
        let pipe_name = crate::bridge::serve(engine.clone(), caller.clone(), pipe.clone(), crate::tools::defs::MailShape::Flat)?;
        write_workspace(&spec, &pipe_name, &engine.cfg.data_root)?;
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
        crate::providers::agy_auth::configure(&mut cmd);
        if let Some(failure) = crate::providers::agy_auth::blocked(&engine) { return Err(failure.into()); }
        winproc::own_group(&mut cmd);
        let mut child = cmd.spawn().with_context(|| format!("could not start {}", spec.exe.display()))?;
        let job = winproc::child_job(&child).map(Arc::new);
        let pid = child.id().unwrap_or(0);
        let process = uuid::Uuid::new_v4();
        tracing::info!(agent = caller.agent_id, pid, %process, provider = "Agy", "CLI started");
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
        let auth = RuntimeAuth { engine, stamp: auth_stamp, job: job.clone(), actor: actor.clone(), process,
            rejected: CancellationToken::new() };
        let stderr_auth = auth.clone();
        tokio::spawn(tracing::Instrument::instrument(
            async move {
                guarded_lines(stderr, &stderr_auth, |line| {
                    let l = String::from_utf8_lossy(line);
                    if !l.trim().is_empty() {
                        tracing::info!("agy stderr (pid {pid}): {}", crate::util::gist(&l, 600));
                    }
                    true
                }).await;
            },
            proc_span.clone(),
        ));
        tokio::spawn(tracing::Instrument::instrument(
            async move {
                guarded_lines(stdout, &auth, |line| {
                    let Ok(v) = serde_json::from_slice::<Value>(line) else { return true };
                    !v.is_object() || actor.post(AgentMsg::Agy(process, v))
                }).await;
                let _ = actor.post(AgentMsg::ProcExited { process, reason: "stdout closed".into() });
            },
            proc_span,
        ));
        Ok(AgyProc { pid, process, stdin: tx, child: Some(child), job, pipe, model: spec.model, auth_stamp })
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
            let _ = super::wait_exit(&mut c, self.pid, self.process, "termination requested", Duration::from_secs(5)).await;
        }
    }

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

#[derive(Clone)]
struct RuntimeAuth {
    engine: Arc<Engine>,
    stamp: crate::providers::agy_auth::Stamp,
    job: Option<Arc<winproc::ChildJob>>,
    actor: AgentTx,
    process: uuid::Uuid,
    rejected: CancellationToken,
}

impl RuntimeAuth {
    #[nolog]
    fn inspect(&self, bytes: &[u8]) -> bool {
        if self.rejected.is_cancelled() { return false; }
        if !crate::providers::agy_auth::auth_prompt(bytes) { return true; }
        self.rejected.cancel();
        crate::providers::agy_auth::refuse(&self.engine, self.stamp, crate::providers::agy_auth::Refusal::Untrusted);
        let _ = self.actor.post(AgentMsg::Agy(self.process, json!({"event":"result","result":{
            "status":"ERROR","error":"Antigravity sign-in required; background authentication stopped"}})));
        // Queue the specific refusal before killing: otherwise the other pipe
        // can report EOF first and classify this as a transient network death.
        if let Some(job) = &self.job { job.terminate(); }
        false
    }
}

/// Read chunks so a prompt without a trailing newline is stopped too. Prompt
/// bytes are inspected before either the trace or the model transcript sees them.
#[nolog]
async fn guarded_lines(mut stream: impl tokio::io::AsyncRead + Unpin, auth: &RuntimeAuth,
    mut line: impl FnMut(&[u8]) -> bool) {
    let mut pending = Vec::new();
    let mut chunk = vec![0u8; 4096];
    loop {
        let n = match stream.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(n) => n };
        pending.extend_from_slice(&chunk[..n]);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            if !auth.inspect(&pending[..end]) || !line(&pending[..end]) { return; }
            pending.drain(..=end);
        }
        if !auth.inspect(&pending) { return; }
        if pending.len() > 4 * 1024 * 1024 { return; }
    }
    if !pending.is_empty() && auth.inspect(&pending) { line(&pending); }
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
/// Elsewhere see `sh_command`.
fn hook_command(path: &Path, data_root: &Path) -> Result<String> {
    if !cfg!(windows) {
        return sh_command(path, data_root);
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

/// The hooks.json command for the wrapper at `path` on macOS and Linux, where
/// the CLI runs it through a shell as it does through cmd on Windows
/// (inferred): the path itself when a shell takes it as one word, else a copy
/// in a private folder of this engine's whose path it does (a wrapper names
/// every path it uses, so it runs from anywhere), else the turn must not run
/// unenforced. Data folders have spaces there ("Orgtree v2").
#[cfg(unix)]
#[logged]
fn sh_command(path: &Path, data_root: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let plain = path.to_string_lossy().to_string();
    if crate::bridge::shell_safe(&plain) {
        return Ok(plain);
    }
    let Some(dir) = crate::bridge::shell_safe_dir(data_root) else {
        return Err(anyhow!(
            "cannot install the orgtree hooks for this agent: a shell would split {plain} (a space or another character it treats \
             specially), and no private folder under $XDG_RUNTIME_DIR, $TMPDIR or /tmp is free of them. Refusing to start the turn \
             — a narrowed seat whose hook does not run would get full tool access."
        ));
    };
    let copy = dir.join(format!("orgtree-hook-{}.sh", hex::encode(&Sha256::digest(plain.as_bytes())[..8])));
    std::fs::copy(path, &copy)?;
    std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o700))?;
    Ok(copy.to_string_lossy().to_string())
}

#[cfg(not(unix))]
#[logged]
fn sh_command(path: &Path, _data_root: &Path) -> Result<String> {
    Ok(path.to_string_lossy().to_string())
}

/// `s` as one POSIX shell word: single-quoted, any `'` closed, escaped and reopened.
#[logged]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub const IDENTITY_RULE_PREFIX: &str = "orgtree-identity-";
const IDENTITY_RULE_HEADER: &str = "---\ntrigger: always_on\ndescription: Orgtree generated agent identity; read all numbered parts together\n---\n<!-- orgtree:generated-identity:v1 -->\n";
// Native rules are truncated at 24,000 bytes, including expanded includes.
const IDENTITY_PART_BYTES: usize = 23_000;

/// Reject redirected identity output before creating directories or inspecting
/// owned parts or migrating a legacy identity. Native read manifests are separate.
#[nolog]
fn validate_identity_output(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() { continue; }
        let meta = match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = meta.file_type().is_symlink();
        anyhow::ensure!(!linked, "identity rule output contains a link");
    }
    Ok(())
}

#[nolog] // contains private identity text
fn write_identity_rules(cwd: &Path, identity: &str) -> Result<()> {
    let rules = cwd.join(".agents/rules");
    validate_identity_output(&rules)?;
    std::fs::create_dir_all(&rules)?;
    validate_identity_output(&rules)?;
    let mut old = Vec::new();
    for entry in std::fs::read_dir(&rules)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(IDENTITY_RULE_PREFIX) || !name.ends_with(".md") { continue; }
        validate_identity_output(&entry.path())?;
        let meta = std::fs::symlink_metadata(entry.path())?;
        if !meta.is_file() || meta.file_type().is_symlink()
            || !std::fs::read_to_string(entry.path())?.starts_with(IDENTITY_RULE_HEADER) {
            return Err(anyhow!("identity rule path is not engine-owned: {}", entry.path().display()));
        }
        old.push(entry.path());
    }
    let mut rest = identity;
    let mut part = 0;
    loop {
        let mut end = rest.len().min(IDENTITY_PART_BYTES);
        while !rest.is_char_boundary(end) { end -= 1; }
        let path = rules.join(format!("{IDENTITY_RULE_PREFIX}{part:04}.md"));
        validate_identity_output(&path)?;
        let content = format!("{IDENTITY_RULE_HEADER}{}", &rest[..end]);
        if std::fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
            std::fs::write(&path, content)?;
        }
        old.retain(|p| p != &path);
        rest = &rest[end..];
        if rest.is_empty() { break; }
        part += 1;
    }
    for path in old {
        validate_identity_output(&path)?;
        std::fs::remove_file(path)?;
    }
    Ok(())
}

const LEGACY_CLOSINGS: &[&str] = &[
    "Your scratch folder is your own: keep a CLAUDE.md there as standing notes — it is loaded automatically every turn and survives compaction. ",
    "Your scratch folder is your own: keep a CLAUDE.md there as standing notes. It is delivered to you at the start of every session and survives compaction; editing it restarts your process, so the notes you add apply from your next turn. ",
    "Your scratch folder is your own: keep a CLAUDE.md there as standing notes. It is delivered to you at the start of every session and survives compaction; notes you add apply from your next session. ",
];

/// Coordinator's 2026-10-15 ruling: an exact generated envelope may be backed
/// up even though authored text INSIDE it cannot be distinguished. No trimming:
/// any extra bytes before/after the envelope exclude the file from migration.
#[nolog]
fn legacy_identity_envelope(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("You are \"") else { return false; };
    let Some((name, rest)) = rest.split_once("\", an agent in the organization \"") else { return false; };
    let Some((org, _)) = rest.split_once("\" (orgtree). ") else { return false; };
    if [name, org].iter().any(|s| s.is_empty() || s.contains(['\"', '\r', '\n'])) { return false; }
    LEGACY_CLOSINGS.iter().any(|ending| text.ends_with(ending))
        || (text.contains("\n\n[TEAM NOTES - ") && text.ends_with("[END TEAM NOTES]"))
        || (text.contains("\n\n[ORG SHARED NOTES - ") && text.ends_with("[END ORG SHARED NOTES]"))
}

/// Called only after the old CLI has stopped, never during a turn. Ambiguous
/// nonmatching notes stay native; all migrated bytes survive in a unique backup.
#[logged]
pub fn migrate_generated_identity(cwd: &Path) -> Result<bool> {
    validate_identity_output(cwd)?;
    let path = cwd.join("AGENTS.md");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() { return Ok(false); }
    // Native leaf symlinks remain native; only regular migration candidates
    // undergo output validation. The scratch ancestors were checked above.
    validate_identity_output(&path)?;
    let bytes = std::fs::read(&path)?;
    if !std::str::from_utf8(&bytes).is_ok_and(legacy_identity_envelope) { return Ok(false); }
    let backup = cwd.join(format!("AGENTS.generated-identity-{}.bak", uuid::Uuid::new_v4()));
    move_generated_identity(&path, &backup, bytes.len())?;
    Ok(true)
}

#[logged] // paths only, never the identity or notes
fn move_generated_identity(source: &Path, backup: &Path, bytes: usize) -> Result<()> {
    validate_identity_output(source)?;
    validate_identity_output(backup)?;
    std::fs::rename(source, backup)?;
    tracing::info!(source = %source.display(), backup = %backup.display(), bytes,
        reason = "exact generated preamble and closing envelope", "preserved legacy generated agy identity outside native notes");
    Ok(())
}

/// Everything the CLI discovers in the agent's folder: the identity
/// (always_on rules), the tools (a workspace plugin), and — for a narrowed seat —
/// the rights hook; a full-rights seat gets the hook files removed.
#[logged]
fn write_workspace(spec: &AgySpec, pipe: &str, data_root: &Path) -> Result<()> {
    let cwd = &spec.cwd;
    std::fs::create_dir_all(cwd)?;
    write_identity_rules(cwd, &spec.identity)?;
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
            // the deny file by its full path: the wrapper may run from a copy elsewhere (sh_command)
            std::fs::write(&wrapper, format!("#!/bin/sh\nexec {} agy-hook {}\n", sh_quote(&exe), sh_quote(&deny_file.to_string_lossy())))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755));
            }
        }
        // resolved before hooks.json is written, so a refusal never leaves an unenforced seat behind
        let command = hook_command(
            &std::fs::canonicalize(&wrapper).map(|p| crate::config::strip_verbatim(&p)).unwrap_or(wrapper.clone()),
            data_root,
        )?;
        doc.insert(
            "orgtree-rights".into(),
            json!({ "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": 20 }] }] }),
        );
    }
    // mid-turn mail: the invocation hooks hand a waiting message to the CLI
    match steering_hooks(&agents, &exe, data_root) {
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
fn steering_hooks(agents: &Path, exe: &str, data_root: &Path) -> Result<Value> {
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
            std::fs::write(&wrapper, format!("#!/bin/sh\nexec {} agy-steer {stage}\n", sh_quote(exe)))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755));
            }
        }
        let command = hook_command(
            &std::fs::canonicalize(&wrapper).map(|p| crate::config::strip_verbatim(&p)).unwrap_or(wrapper.clone()),
            data_root,
        )?;
        events.insert(event.into(), json!([{ "type": "command", "command": command, "timeout": 20 }]));
    }
    Ok(Value::Object(events))
}

/// Dollars for one model request (Google bills prompt tokens above 200K at
/// the long-context rate on its pro-class models).
#[logged]
pub fn request_cost(model: &str, input: i64, cached: i64, output: i64) -> f64 {
    // Antigravity publishes quota fractions, not Claude token prices. Zero is
    // represented as unknown by the existing cost UI; never use Gemini prices.
    if model.starts_with("claude-") {
        return 0.0;
    }
    let pro = ["gemini-3.1-pro", "gemini-4-argon", "gemini-4-barium", "gemini-4-carbon"].contains(&model);
    let (pi, pc, po) = if model.contains("flash") {
        (0.75, 0.075, 3.75)
    } else if pro && input + cached > 200_000 {
        (4.00, 0.40, 18.00)
    } else {
        (2.00, 0.20, 12.00)
    };
    (input as f64 * pi + cached as f64 * pc + output as f64 * po) / 1e6
}

#[cfg(test)]
mod workspace_notes_tests {
    use super::*;

    fn fixture() -> (PathBuf, AgySpec) {
        let root = std::env::temp_dir().join(format!("orgtree-agy-notes-{}", crate::util::random_hex(8)));
        std::fs::create_dir_all(&root).unwrap();
        let spec = AgySpec {
            exe: PathBuf::from("unused-fake-agy"), cwd: root.join("agent"), model: "fake".into(),
            effort: None, conversation: None, identity: "Synthetic generated identity".into(),
            servers: Map::new(), bash: true, edit: true, web: true, subagents: true,
            env: vec![], turn_timeout_s: 60,
        };
        (root, spec)
    }

    #[cfg(any(unix, windows))]
    fn linked_rule_output(component: &str) {
        let (root, spec) = fixture();
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = spec.cwd.join(component);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        let redirected_rules = if component == ".agents" { outside.join("rules") } else { outside.clone() };
        std::fs::create_dir_all(&redirected_rules).unwrap();
        let old_path = redirected_rules.join("orgtree-identity-9999.md");
        let old_bytes = format!("{IDENTITY_RULE_HEADER}outside old rule");
        std::fs::write(&old_path, &old_bytes).unwrap();
        std::fs::write(outside.join("canary"), "untouched").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            let link_arg = crate::config::strip_verbatim(&link).to_string_lossy().replace('/', "\\");
            let target_arg = crate::config::strip_verbatim(&outside).to_string_lossy().replace('/', "\\");
            let result = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"]).arg(&link_arg).arg(&target_arg).output().unwrap();
            assert!(result.status.success(), "fixture junction creation failed: status={:?}, stdout={}, stderr={}",
                result.status.code(), String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        }
        let refused = write_identity_rules(&spec.cwd, &spec.identity).is_err();
        let preserved = std::fs::read(&old_path).ok().as_deref() == Some(old_bytes.as_bytes());
        let wrote = redirected_rules.join("orgtree-identity-0000.md").exists();
        let canary = std::fs::read_to_string(outside.join("canary")).unwrap();
        // Unlink explicitly before recursive fixture cleanup, including red runs.
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(refused, "linked output ancestor must be refused");
        assert!(preserved, "marked external rules must not be deleted");
        assert!(!wrote, "identity must not be written outside scratch");
        assert_eq!(canary, "untouched");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn agy_rule_output_rejects_linked_agents_directory() {
        linked_rule_output(".agents");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn agy_rule_output_rejects_linked_rules_directory() {
        linked_rule_output(".agents/rules");
    }

    #[test]
    fn agy_workspace_preserves_standing_notes_across_starts() {
        let (root, spec) = fixture();
        std::fs::create_dir_all(&spec.cwd).unwrap();
        let notes = "# Standing memories\r\nKeep this user-authored note.\r\n";
        std::fs::write(spec.cwd.join("AGENTS.md"), notes).unwrap();
        write_workspace(&spec, "fake-pipe", &root).unwrap();
        write_workspace(&spec, "fake-pipe", &root).unwrap();
        let actual = std::fs::read_to_string(spec.cwd.join("AGENTS.md")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(actual, notes, "launch must never replace standing memories with identity");
    }

    #[test]
    fn agy_workspace_identity_is_a_rule_not_own_notes() {
        let (root, spec) = fixture();
        write_workspace(&spec, "fake-pipe", &root).unwrap();
        let own_exists = spec.cwd.join("AGENTS.md").exists();
        let rule = std::fs::read_to_string(spec.cwd.join(".agents/rules/orgtree-identity-0000.md")).unwrap_or_default();
        let (own, _) = crate::runtime::startup::standing_notes(
            &crate::runtime::startup::Inputs::None, &spec.cwd, &[]);
        std::fs::remove_dir_all(root).unwrap();
        assert!(!own_exists && own.is_empty(), "generated identity must not feed back as own notes");
        assert!(rule.starts_with("---\ntrigger: always_on\n"));
        assert_eq!(rule.matches(&spec.identity).count(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn agy_legacy_migration_rejects_linked_scratch_ancestor() {
        let (root, spec) = fixture();
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let legacy = format!("You are \"ann\", an agent in the organization \"Proof\" (orgtree). {}", LEGACY_CLOSINGS[0]);
        let source = outside.join("AGENTS.md");
        std::fs::write(&source, &legacy).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &spec.cwd).unwrap();
        #[cfg(windows)]
        {
            let link = crate::config::strip_verbatim(&spec.cwd).to_string_lossy().replace('/', "\\");
            let target = crate::config::strip_verbatim(&outside).to_string_lossy().replace('/', "\\");
            let result = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&target).output().unwrap();
            assert!(result.status.success(), "fixture junction creation failed: status={:?}, stdout={}, stderr={}",
                result.status.code(), String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        }
        let refused = migrate_generated_identity(&spec.cwd).is_err();
        let preserved = std::fs::read(&source).ok().as_deref() == Some(legacy.as_bytes());
        let backup = std::fs::read_dir(&outside).unwrap().flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".bak"));
        #[cfg(windows)]
        std::fs::remove_dir(&spec.cwd).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&spec.cwd).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(refused, "migration must reject redirected scratch before reading or renaming");
        assert!(preserved, "external envelope bytes must remain in AGENTS.md");
        assert!(!backup, "no backup may be created outside scratch");
    }

    #[cfg(unix)]
    #[test]
    fn agy_native_notes_leaf_symlink_is_not_migrated_or_refused() {
        let (root, spec) = fixture();
        std::fs::create_dir_all(&spec.cwd).unwrap();
        let source = root.join("native-notes.md");
        let legacy = format!("You are \"ann\", an agent in the organization \"Proof\" (orgtree). {}", LEGACY_CLOSINGS[0]);
        std::fs::write(&source, &legacy).unwrap();
        let link = spec.cwd.join("AGENTS.md");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        let outcome = migrate_generated_identity(&spec.cwd);
        let preserved = std::fs::read(&source).unwrap() == legacy.as_bytes();
        let link_preserved = std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink();
        let backup = std::fs::read_dir(&spec.cwd).unwrap().flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".bak"));
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(matches!(outcome, Ok(false)), "native leaf symlink must be skipped without launch error");
        assert!(preserved && link_preserved, "native notes and their link must remain untouched");
        assert!(!backup, "native leaf symlink must not be backed up");
    }

    #[test]
    fn agy_legacy_envelope_is_backed_up_once_and_other_notes_are_untouched() {
        let (root, spec) = fixture();
        std::fs::create_dir_all(&spec.cwd).unwrap();
        let preamble = "You are \"ann\", an agent in the organization \"Proof\" (orgtree). ";
        let legacy = format!("{preamble}Old charter, including any interior edits.{}", LEGACY_CLOSINGS[0]);
        let path = spec.cwd.join("AGENTS.md");
        std::fs::write(&path, &legacy).unwrap();
        assert!(migrate_generated_identity(&spec.cwd).unwrap());
        assert!(!path.exists());
        assert!(!migrate_generated_identity(&spec.cwd).unwrap());
        let backups: Vec<_> = std::fs::read_dir(&spec.cwd).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".bak")).collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), legacy);
        for notes in [format!("my notes\n{legacy}"), format!("{legacy}\nmy notes"),
            format!("{legacy}\n"), format!("{preamble}unrecognized ending"), "# Own memories\nkeep me".into()] {
            std::fs::write(&path, &notes).unwrap();
            assert!(!migrate_generated_identity(&spec.cwd).unwrap());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), notes);
        }
        for ending in LEGACY_CLOSINGS {
            assert!(legacy_identity_envelope(&format!("{preamble}{ending}")));
        }
        assert!(legacy_identity_envelope(&format!("{preamble}\n\n[TEAM NOTES - path]\ntext\n[END TEAM NOTES]")));
        assert!(legacy_identity_envelope(&format!("{preamble}\n\n[ORG SHARED NOTES - path]\ntext\n[END ORG SHARED NOTES]")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agy_largest_observed_identity_has_complete_bounded_parts_without_native_legacy_duplicate() {
        let (root, mut spec) = fixture();
        std::fs::create_dir_all(&spec.cwd).unwrap();
        let prefix = "You are \"ann\", an agent in the organization \"Proof\" (orgtree). ";
        let closing = LEGACY_CLOSINGS[0];
        // Largest read-only snapshot was 56,918 bytes. This exercises byte
        // preservation, NOT the proprietary native tokenizer/aggregate budget.
        spec.identity = format!("{prefix}{}{closing}", "x".repeat(56_918 - prefix.len() - closing.len()));
        std::fs::write(spec.cwd.join("AGENTS.md"), &spec.identity).unwrap();
        assert!(migrate_generated_identity(&spec.cwd).unwrap());
        write_identity_rules(&spec.cwd, &spec.identity).unwrap();
        let rules = spec.cwd.join(".agents/rules");
        let mut paths: Vec<_> = std::fs::read_dir(&rules).unwrap().flatten().map(|e| e.path()).collect();
        paths.sort();
        assert_eq!(paths.len(), 3);
        let parts: Vec<_> = paths.iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();
        assert!(parts.iter().all(|s| s.len() < 24_000));
        assert_eq!(parts.iter().map(|s| s.strip_prefix(IDENTITY_RULE_HEADER).unwrap()).collect::<String>(), spec.identity);
        assert!(crate::runtime::startup::agy_project(&spec.cwd).is_empty());
        write_identity_rules(&spec.cwd, &spec.identity).unwrap();
        assert_eq!(paths.iter().map(|p| std::fs::read_to_string(p).unwrap()).collect::<Vec<_>>(), parts);
        // UTF-8 boundaries and stale part cleanup after an identity shrinks.
        let unicode = "🦀".repeat(12_000);
        write_identity_rules(&spec.cwd, &unicode).unwrap();
        write_identity_rules(&spec.cwd, "short identity").unwrap();
        assert_eq!(std::fs::read_dir(&rules).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agy_rule_name_collision_preserves_nonengine_content() {
        let (root, spec) = fixture();
        let rules = spec.cwd.join(".agents/rules");
        std::fs::create_dir_all(&rules).unwrap();
        let path = rules.join("orgtree-identity-0000.md");
        std::fs::write(&path, "my own unrelated rule").unwrap();
        assert!(write_identity_rules(&spec.cwd, &spec.identity).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "my own unrelated rule");
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orgtree-agy-{tag}-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A shell runs a hook wrapper whose own path it would split (the data
    /// folder is "Orgtree v2") through its shell-safe private copy; a path it
    /// takes whole is used as it is.
    #[test]
    fn a_hook_under_a_spaced_folder_runs_through_a_shell() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("hook");
        let data = root.join("Orgtree v2").join("data");
        let agents = data.join("scratch").join("org").join("ann").join(".agents");
        std::fs::create_dir_all(&agents).unwrap();
        let ran = root.join("ran.txt");
        let wrapper = agents.join("orgtree-rights.sh");
        std::fs::write(&wrapper, format!("#!/bin/sh\necho ran > {}\n", sh_quote(&ran.to_string_lossy()))).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let command = sh_command(&wrapper, &data).expect("a command");
        assert!(crate::bridge::shell_safe(&command) && command != wrapper.to_string_lossy(), "{command}");
        assert_eq!(std::fs::metadata(&command).unwrap().permissions().mode() & 0o777, 0o700);
        assert!(std::process::Command::new("sh").args(["-c", &command]).status().unwrap().success());
        assert_eq!(std::fs::read_to_string(&ran).unwrap().trim(), "ran");
        let plain = root.join("plain.sh");
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();
        assert_eq!(sh_command(&plain, &data).unwrap(), plain.to_string_lossy());
        let _ = std::fs::remove_file(&command);
        let _ = std::fs::remove_dir(Path::new(&command).parent().unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A quoted word reaches the command whole, quotes and `$` inside it too.
    #[test]
    fn sh_quote_keeps_one_word() {
        let s = "it's a folder/with $HOME and `x`";
        let out = std::process::Command::new("sh").args(["-c", &format!("printf %s {}", sh_quote(s))]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), s);
    }
}
