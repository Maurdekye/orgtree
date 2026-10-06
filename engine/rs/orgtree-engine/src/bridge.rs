//! The agent-tool bridge for CLIs that can only launch MCP servers as
//! processes (Antigravity). `orgtree-engine mcp-bridge --pipe <name>` is a
//! stdio MCP server that relays JSON-RPC lines to the engine over a named
//! pipe; the pipe is created per agent process with an unguessable name, and
//! that name is what identifies the agent. The engine side answers with the
//! same tools the in-process MCP server serves.
//!
//! Also `orgtree-engine agy-hook <deny.json>`: Antigravity's PreToolUse hook
//! for a narrowed seat — it reads the pending call on stdin and denies the
//! tools the seat's scope closed. It never guesses: a payload it cannot read
//! is denied, not allowed.

use std::process::ExitCode;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
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

#[cfg(windows)]
async fn relay(name: String) -> ExitCode {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    let pipe = loop {
        match ClientOptions::new().open(&name) {
            Ok(p) => break p,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 100 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(e) => {
                eprintln!("orgtree mcp-bridge: cannot reach the engine ({e})");
                return ExitCode::from(1);
            }
        }
    };
    let (mut from_engine, mut to_engine) = tokio::io::split(pipe);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        _ = tokio::io::copy(&mut stdin, &mut to_engine) => {}
        _ = tokio::io::copy(&mut from_engine, &mut stdout) => {}
    }
    ExitCode::SUCCESS
}

#[cfg(not(windows))]
async fn relay(_name: String) -> ExitCode {
    eprintln!("orgtree mcp-bridge: named pipes are Windows-only");
    ExitCode::from(1)
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

#[cfg(not(windows))]
pub fn serve(_engine: Arc<Engine>, _caller: Caller, _cancel: CancellationToken) -> Result<String> {
    anyhow::bail!("the tool bridge needs Windows named pipes")
}

/// One CLI-side MCP session: each request answered as its own request.
#[cfg(windows)]
async fn connection(engine: Arc<Engine>, caller: Caller, conn: tokio::net::windows::named_pipe::NamedPipeServer, cancel: CancellationToken) {
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
