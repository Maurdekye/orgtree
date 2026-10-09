//! The agent-tool bridge for CLIs that can only launch MCP servers as
//! processes (Antigravity). `orgtree-engine mcp-bridge --pipe <name>` is a
//! stdio MCP server that relays JSON-RPC lines to the engine over a named
//! pipe (Windows) or a Unix domain socket (macOS, Linux; `<name>` is then the
//! socket's path); either is created per agent process with an unguessable
//! name, and that name is what identifies the agent. The engine side answers
//! with the same tools the in-process MCP server serves.
//!
//! A socket lives in a private folder of this engine's (0700, the socket
//! 0600, only this user's processes are answered): `<data>/bridge` when the
//! path fits a socket address, else one named after the data folder under
//! `$XDG_RUNTIME_DIR` or `$TMPDIR`. It goes when its agent process does or
//! the engine stops; the engine clears what a killed run left at its start.
//!
//! Also `orgtree-engine agy-hook <deny.json>`: Antigravity's PreToolUse hook
//! for a narrowed seat — it reads the pending call on stdin and denies the
//! tools the seat's scope closed. It never guesses: a payload it cannot read
//! is denied, not allowed.

use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;
use crate::runtime::Caller;

/// `mcp-bridge --pipe <name>`: relay stdio to the engine's pipe.
pub fn run(args: &[String]) -> ExitCode {
    let pipe = args.windows(2).find(|w| w[0] == "--pipe").map(|w| w[1].clone());
    let Some(pipe) = pipe else {
        eprintln!("usage: orgtree-engine mcp-bridge --pipe <name>");
        return ExitCode::from(2);
    };
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("orgtree mcp-bridge: {e}");
            return ExitCode::from(1);
        }
    };
    rt.block_on(relay(pipe))
}

async fn relay(name: String) -> ExitCode {
    match relay_io(&name, tokio::io::stdin(), tokio::io::stdout()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("orgtree mcp-bridge: cannot reach the engine ({e})");
            ExitCode::from(1)
        }
    }
}

/// Reach the engine at `name`, then copy `input` to it and its answers to
/// `output` until either side closes.
#[logged]
async fn relay_io<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(name: &str, input: R, output: W) -> std::io::Result<()> {
    let conn = connect(name).await?;
    let (mut from_engine, mut to_engine) = tokio::io::split(conn);
    let (mut input, mut output) = (input, output);
    tokio::select! {
        _ = tokio::io::copy(&mut input, &mut to_engine) => {}
        _ = tokio::io::copy(&mut from_engine, &mut output) => {}
    }
    Ok(())
}

/// Open the engine's named pipe, waiting briefly while every instance is busy.
#[cfg(windows)]
#[logged]
async fn connect(name: &str) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    loop {
        match ClientOptions::new().open(name) {
            Ok(p) => return Ok(p),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 100 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Connect to the engine's socket, waiting briefly while its backlog is full
/// (EAGAIN on Linux, ECONNREFUSED on macOS), as on PIPE_BUSY on Windows.
#[cfg(unix)]
#[logged]
async fn connect(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    use std::io::ErrorKind;
    let mut tries = 0;
    loop {
        match tokio::net::UnixStream::connect(path).await {
            Ok(s) => return Ok(s),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::ConnectionRefused) && tries < 100 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Serve this agent's tools on a fresh named pipe until `cancel`; returns its name.
#[cfg(windows)]
#[logged]
pub fn serve(engine: Arc<Engine>, caller: Caller, cancel: CancellationToken) -> Result<String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\orgtree-mcp-{}", crate::util::random_hex(16));
    let first = ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&name)?;
    let pipe_name = name.clone();
    tokio::spawn(async move {
        let mut server = first;
        loop {
            tokio::select! {
                r = server.connect() => if r.is_err() { break },
                _ = cancel.cancelled() => break,
            }
            let conn = server;
            server = match ServerOptions::new().reject_remote_clients(true).create(&pipe_name) {
                Ok(s) => s,
                Err(_) => break,
            };
            tokio::spawn(connection(engine.clone(), caller.clone(), conn, cancel.clone()));
        }
    });
    Ok(name)
}

/// Serve this agent's tools on a fresh Unix socket until `cancel` (or the
/// engine stops); returns its path.
#[cfg(unix)]
#[logged]
pub fn serve(engine: Arc<Engine>, caller: Caller, cancel: CancellationToken) -> Result<String> {
    let name = format!("orgtree-mcp-{}", crate::util::random_hex(8));
    let mut refused = Vec::new();
    for dir in socket_dirs(&engine.cfg.data_root) {
        let path = dir.join(&name);
        match listen(&dir, &path) {
            Ok((listener, text)) => {
                tokio::spawn(accept(engine, caller, listener, path, cancel));
                return Ok(text);
            }
            Err(e) => refused.push(format!("{}: {e:#}", dir.display())),
        }
    }
    anyhow::bail!("no folder can hold the tool bridge's socket ({})", refused.join("; "))
}

/// A socket address holds a path of fewer bytes than this (its NUL ends it).
#[cfg(unix)]
const SUN_PATH: usize = if cfg!(any(target_os = "linux", target_os = "android")) { 108 } else { 104 };

/// The folders a socket of this engine's may live in, best first: its data
/// folder, then the user's runtime and temp folders (named after the data
/// folder, so engines with different data folders never share one).
#[cfg(unix)]
#[logged]
fn socket_dirs(data_root: &std::path::Path) -> Vec<std::path::PathBuf> {
    use sha2::{Digest, Sha256};
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;
    let tag = hex::encode(&Sha256::digest(data_root.as_os_str().as_bytes())[..4]);
    let mut dirs = vec![data_root.join("bridge")];
    if let Some(run) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        dirs.push(PathBuf::from(run).join(format!("orgtree-{tag}")));
    }
    let tmp = std::env::var_os("TMPDIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    dirs.push(tmp.join(format!("orgtree-{}-{tag}", unsafe { libc::geteuid() })));
    dirs
}

/// Whether a POSIX shell takes `s` as one word: nothing it splits on, quotes,
/// expands or globs.
#[cfg(unix)]
#[logged]
pub(crate) fn shell_safe(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+,:@%".contains(c))
}

/// The first of this engine's private folders (`socket_dirs`) whose path a
/// shell takes as one word, for the CLI hooks that run through one.
#[cfg(unix)]
#[logged]
pub(crate) fn shell_safe_dir(data_root: &std::path::Path) -> Option<std::path::PathBuf> {
    socket_dirs(data_root).into_iter().find(|d| d.to_str().is_some_and(shell_safe) && private_dir(d).is_ok())
}

/// `dir` as a private folder of this user's: created 0700 when missing (its
/// parent must exist); an existing one must be a real folder this user owns,
/// and loses any group or other access.
#[cfg(unix)]
#[logged]
fn private_dir(dir: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let meta = std::fs::symlink_metadata(dir)?;
    anyhow::ensure!(meta.is_dir(), "it is not a folder");
    anyhow::ensure!(meta.uid() == unsafe { libc::geteuid() }, "another user owns it");
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Bind the socket `path` in the private folder `dir`, the socket 0600;
/// returns the listener and the path as the text the CLI is given.
#[cfg(unix)]
#[logged]
fn listen(dir: &std::path::Path, path: &std::path::Path) -> Result<(tokio::net::UnixListener, String)> {
    use std::os::unix::fs::PermissionsExt;
    let text = path.to_str().ok_or_else(|| anyhow::anyhow!("the path is not UTF-8"))?.to_string();
    anyhow::ensure!(text.len() < SUN_PATH, "the path is {} bytes; a socket address holds {}", text.len(), SUN_PATH - 1);
    private_dir(dir)?;
    let listener = tokio::net::UnixListener::bind(path)?;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(path);
        return Err(e.into());
    }
    Ok((listener, text))
}

/// Answer this agent's connections until `cancel` or the engine stops; the
/// socket file goes with the listener.
#[cfg(unix)]
#[logged]
async fn accept(engine: Arc<Engine>, caller: Caller, listener: tokio::net::UnixListener, path: std::path::PathBuf, cancel: CancellationToken) {
    struct Unlink(std::path::PathBuf);
    impl Drop for Unlink {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _unlink = Unlink(path);
    let me = unsafe { libc::geteuid() };
    loop {
        let r = tokio::select! {
            r = listener.accept() => r,
            _ = cancel.cancelled() => break,
            _ = engine.shutdown.cancelled() => break,
        };
        match r {
            // the folder admits only this user; any other peer is refused all the same
            Ok((conn, _)) if conn.peer_cred().map(|c| c.uid()).ok() == Some(me) => {
                tokio::spawn(connection(engine.clone(), caller.clone(), conn, cancel.clone()));
            }
            Ok(_) => {}
            // a peer that left before it was accepted, or no file handles to spare: keep serving
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
}

/// At the engine's start: remove the sockets a killed earlier run of it left
/// in its folders (only this user's private ones), and the hook copies its
/// agents had there (`runtime::agy::sh_command` writes them again).
#[cfg(unix)]
#[logged]
pub fn clear_stale(data_root: &std::path::Path) {
    use std::os::unix::fs::MetadataExt;
    let me = unsafe { libc::geteuid() };
    for dir in socket_dirs(data_root) {
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
        if !meta.is_dir() || meta.uid() != me {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("orgtree-mcp-") || name.starts_with("orgtree-hook-") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// One CLI-side MCP session: each request answered as its own request.
async fn connection<S>(engine: Arc<Engine>, caller: Caller, conn: S, cancel: CancellationToken)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(conn);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write.write_all(line.as_bytes()).await.is_err() || write.write_all(b"\n").await.is_err() || write.flush().await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(read).lines();
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l,
            _ = cancel.cancelled() => break,
        };
        let Ok(Some(line)) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        // notifications (initialized, cancelled) need no answer
        if msg.get("id").map(Value::is_null).unwrap_or(true) {
            continue;
        }
        let (engine, caller, tx) = (engine.clone(), caller.clone(), tx.clone());
        let span = crate::trace::request(&crate::trace::agent_client(caller.agent_id, &caller.name));
        tokio::spawn(tracing::Instrument::instrument(
            async move {
                let resp = crate::tools::handle_mcp(&engine, &caller, &msg).await;
                let _ = tx.send(resp.to_string());
            },
            span,
        ));
    }
}

/// `agy-steer pre|post`: Antigravity's invocation hook for mid-turn mail (as
/// in 3.x). It claims the handoff the engine left in this agent's private
/// steer folder (`ORGTREE_AGY_STEER_DIR`), hands it to the CLI as a user
/// step (after an invocation also forcing the run to continue), and leaves a
/// receipt the engine commits the delivery on.
pub fn steer(args: &[String]) -> ExitCode {
    use std::io::{Read, Write};
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    let nothing = || {
        println!("{{}}");
        ExitCode::SUCCESS
    };
    let Some(dir) = std::env::var_os("ORGTREE_AGY_STEER_DIR").map(std::path::PathBuf::from) else { return nothing() };
    let (pending, claimed) = (dir.join("pending.json"), dir.join("claimed.json"));
    if std::fs::rename(&pending, &claimed).is_err() {
        return nothing();
    }
    let msg: Value = std::fs::read(&claimed).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let (Some(id), Some(text)) = (msg["id"].as_str(), msg["text"].as_str()) else {
        let _ = std::fs::remove_file(&claimed);
        return nothing();
    };
    let mut out = json!({ "injectSteps": [{ "userMessage": text }] });
    if args.first().map(String::as_str) == Some("post") {
        out["terminationBehavior"] = json!("force_continue");
    }
    println!("{out}");
    let _ = std::io::stdout().flush();
    let tmp = dir.join("emitted.tmp");
    if std::fs::write(&tmp, json!({ "id": id }).to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("emitted.json"));
    }
    let _ = std::fs::remove_file(&claimed);
    ExitCode::SUCCESS
}

/// `agy-hook <deny.json>`: allow or deny the pending tool call on stdin.
pub fn hook(args: &[String]) -> ExitCode {
    use std::io::Read;
    const REFUSING: &str = " - refusing the call rather than guessing";
    let deny: serde_json::Map<String, Value> = args
        .first()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut raw = Vec::new();
    let decision = match std::io::stdin().read_to_end(&mut raw).ok().and_then(|_| serde_json::from_slice::<Value>(&raw).ok()) {
        None => Err(format!("this agent's permission hook could not read the pending tool call, so it cannot tell whether this tool is allowed{REFUSING}")),
        Some(payload) => {
            let name = payload
                .pointer("/toolCall/name")
                .or_else(|| payload.get("tool_name"))
                .or_else(|| payload.get("toolName"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            match name {
                None => Err(format!("this agent's permission hook found no tool name in the call it was given{REFUSING}")),
                Some(n) => match deny.get(n).and_then(Value::as_str) {
                    Some(reason) => Err(reason.to_string()),
                    None => Ok(()),
                },
            }
        }
    };
    let out = match decision {
        Ok(()) => json!({ "decision": "allow" }),
        Err(reason) => json!({ "decision": "deny", "reason": format!("orgtree: {reason}") }),
    };
    println!("{out}");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::path::Path;
    use std::time::Duration;
    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};

    fn data_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("orgtree-bridge-{tag}-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn caller() -> Caller {
        Caller { org_id: 1, org_slug: "bridge-test".into(), agent_id: 7, name: "tester".into() }
    }

    /// One request line in, its answer line out (10 s at most).
    async fn ask<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin>(to: &mut W, from: &mut Lines<R>, msg: Value) -> Value {
        to.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
        to.flush().await.unwrap();
        let line = tokio::time::timeout(Duration::from_secs(10), from.next_line()).await.expect("an answer within 10 s");
        serde_json::from_str(&line.unwrap().expect("an answer, not the end")).unwrap()
    }

    /// What an Antigravity agent's MCP client does through `mcp-bridge`:
    /// initialize, list the tools and call one, through `serve` and the relay
    /// (a named pipe on Windows, a Unix socket elsewhere).
    #[tokio::test]
    async fn tools_list_and_a_tool_call_round_trip() {
        let root = data_root("rt");
        let cancel = CancellationToken::new();
        let name = serve(Engine::for_tests(root.clone()), caller(), cancel.clone()).expect("serve");
        let (cli, stdio) = tokio::io::duplex(1 << 20);
        let (stdin, stdout) = tokio::io::split(stdio);
        let relay = tokio::spawn(async move { relay_io(&name, stdin, stdout).await });
        let (from_bridge, mut to_bridge) = tokio::io::split(cli);
        let mut lines = BufReader::new(from_bridge).lines();

        let init = ask(&mut to_bridge, &mut lines, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" } })).await;
        assert_eq!(init["result"]["serverInfo"]["name"], "orgtree", "{init}");
        // a notification gets no answer, so the next line answers the next request
        to_bridge.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await.unwrap();
        let list = ask(&mut to_bridge, &mut lines, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
        let tools: Vec<&str> = list["result"]["tools"].as_array().expect("a tool list").iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(tools.contains(&"orgtree_message") && tools.contains(&"orgtree_list_tiers"), "{tools:?}");
        let call = ask(&mut to_bridge, &mut lines, json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "orgtree_list_tiers", "arguments": {} } })).await;
        assert_eq!(call["id"], 3, "{call}");
        assert!(call["result"]["isError"].is_null(), "{call}");
        let text = call["result"]["content"][0]["text"].as_str().expect("the tool's text");
        assert!(serde_json::from_str::<Value>(text).expect("JSON")["tiers"].is_array(), "{text}");

        // the CLI closing its side ends the relay
        to_bridge.shutdown().await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(10), relay).await.expect("the relay ends").unwrap();
        assert!(ended.is_ok(), "{ended:?}");
        cancel.cancel();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Waits up to 5 s for `path` to go.
    #[cfg(unix)]
    async fn gone(path: &Path) -> bool {
        for _ in 0..100 {
            if !path.exists() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    /// The socket's folder is this user's alone (0700), the socket 0600, and
    /// the socket goes when its agent process does.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_socket_is_private_and_goes_with_its_agent() {
        use std::os::unix::fs::PermissionsExt;
        let root = data_root("perm");
        let cancel = CancellationToken::new();
        let path = PathBuf::from(serve(Engine::for_tests(root.clone()), caller(), cancel.clone()).expect("serve"));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(path.parent().unwrap()), 0o700, "{}", path.display());
        assert_eq!(mode(&path), 0o600, "{}", path.display());
        assert!(path.as_os_str().len() < SUN_PATH);
        cancel.cancel();
        assert!(gone(&path).await, "the socket outlived its agent: {}", path.display());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A data folder too deep for a socket address: the socket goes to a
    /// fallback folder that fits, and works.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_deep_data_folder_falls_back_to_a_short_path() {
        let top = data_root("deep");
        let root = top.join("d".repeat(120));
        std::fs::create_dir_all(&root).unwrap();
        let cancel = CancellationToken::new();
        let path = serve(Engine::for_tests(root.clone()), caller(), cancel.clone()).expect("serve");
        assert!(!path.starts_with(root.to_str().unwrap()) && path.len() < SUN_PATH, "{path}");
        let mut conn = connect(&path).await.expect("the fallback socket answers");
        conn.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n").await.unwrap();
        let mut lines = BufReader::new(conn).lines();
        let pong = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap().unwrap();
        assert!(pong.contains("\"id\":1"), "{pong}");
        cancel.cancel();
        let path = PathBuf::from(path);
        assert!(gone(&path).await);
        let _ = std::fs::remove_dir(path.parent().unwrap());
        let _ = std::fs::remove_dir_all(&top);
    }

    /// At the engine's start, sockets a killed run left go; nothing else does.
    #[cfg(unix)]
    #[test]
    fn stale_sockets_are_cleared_at_start() {
        let root = data_root("stale");
        let dir = root.join("bridge");
        private_dir(&dir).unwrap();
        std::fs::write(dir.join("orgtree-mcp-0123456789abcdef"), b"").unwrap();
        std::fs::write(dir.join("keep.txt"), b"").unwrap();
        clear_stale(&root);
        assert!(!dir.join("orgtree-mcp-0123456789abcdef").exists());
        assert!(dir.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
