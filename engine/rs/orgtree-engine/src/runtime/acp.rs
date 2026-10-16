//! Agent Client Protocol v1 over newline-delimited JSON-RPC. Harness-specific
//! configuration belongs in its launcher, not in this transport. The connection
//! task owns the pending calls; all queues, frames and waits are bounded.
//!
//! A loaded session may replay its transcript before answering session/load.
//! Suppress that replay here, before it can become new actor transcript rows.
//! No ACP steering is assumed: mail arriving during a prompt waits for the next
//! turn. Client requests fail closed unless the supplied approval policy handles
//! them explicitly. This is an approval boundary, not an operating-system sandbox.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::sync::CancellationToken;

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_PENDING: usize = 32;
const QUEUE: usize = 64;

/// A policy returns an ACP result, not a JSON-RPC envelope. It must reject
/// unknown methods, sessions, tools and missing permission information.
pub type Approval = Arc<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;

pub struct Spec {
    pub exe: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub who: String,
    pub approval: Approval,
    /// the engine and agent when the sign-in helper starts it in the
    /// operator's signed-in session (`session_host::wanted`); None: here
    pub host: Option<(Arc<crate::engine::Engine>, i64)>,
}

/// Neither raw frames nor stderr are logged: provider errors and tool arguments
/// may contain credentials. Actor consumers apply their normal transcript policy.
pub enum Event {
    Notification(Value),
    Ended(String),
}

enum Control {
    Call { id: String, method: String, params: Value, reply: oneshot::Sender<Result<Value>> },
    Notify { method: String, params: Value },
    Forget(String),
}

struct Pending {
    method: String,
    session: Option<String>,
    reply: oneshot::Sender<Result<Value>>,
}

#[derive(Clone)]
pub struct Client {
    tx: mpsc::Sender<Control>,
    next: Arc<AtomicU64>,
}

#[nolog] // request payloads, including MCP credentials, are never diagnostic data
impl Client {
    pub async fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value> {
        let id = format!("orgtree-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (reply, rx) = oneshot::channel();
        self.tx.try_send(Control::Call { id: id.clone(), method: method.into(), params, reply })
            .map_err(|_| anyhow!("ACP connection is closed or its request queue is full"))?;
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(anyhow!("ACP connection closed before answering {method}")),
            Err(_) => {
                // Expired requests cannot consume unbounded pending slots.
                let _ = self.tx.try_send(Control::Forget(id));
                Err(anyhow!("ACP {method} did not answer within {} seconds", wait.as_secs()))
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.tx.try_send(Control::Notify { method: method.into(), params })
            .map_err(|_| anyhow!("ACP connection is closed or its request queue is full"))
    }
}

pub struct Process {
    pub pid: u32,
    pub process: uuid::Uuid,
    pub client: Client,
    child: Option<super::session_host::Launched>,
    job: Option<crate::winproc::ChildJob>,
    stop: CancellationToken,
    io: Option<tokio::task::JoinHandle<()>>,
    stderr: Option<tokio::task::JoinHandle<()>>,
    who: String,
}

#[nolog]
impl Process {
    pub async fn spawn(spec: Spec) -> Result<(Self, mpsc::Receiver<Event>)> {
        let build = |_| {
            let mut command = Command::new(&spec.exe);
            command.args(&spec.args).current_dir(&spec.cwd).env_clear()
                .envs(spec.env.iter().map(|(k, v)| (k, v)))
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()).kill_on_drop(true);
            crate::winproc::no_window(&mut command);
            crate::winproc::own_group(&mut command);
            Ok(command)
        };
        let started = match &spec.host {
            Some((engine, agent)) => super::session_host::spawn(engine, true, true, *agent, "ACP harness", build).await.map(|(s, _)| s),
            None => build(false).and_then(super::session_host::spawn_local),
        };
        let super::session_host::Started { io, launched, job, pid } = started.context("could not start ACP harness")?;
        let process = uuid::Uuid::new_v4();
        let super::session_host::Io { stdin, stdout, stderr } = io;
        let child = launched;
        let stop = CancellationToken::new();
        let (client, events, io) = connection(stdout, stdin, spec.approval, stop.clone());
        // Drain, never retain or log arbitrary stderr. A bounded line decoder
        // terminates an overlong line instead of growing with a broken harness.
        let stderr_stop = stop.clone();
        let stderr = tokio::spawn(async move {
            let mut lines = FramedRead::new(stderr, LinesCodec::new_with_max_length(64 * 1024));
            loop {
                tokio::select! {
                    _ = stderr_stop.cancelled() => break,
                    line = lines.next() => if !matches!(line, Some(Ok(_))) { break; },
                }
            }
        });
        Ok((Self { pid, process, client, child: Some(child), job, stop,
            io: Some(io), stderr: Some(stderr), who: spec.who }, events))
    }

    pub fn alive(&mut self) -> bool {
        self.child.as_mut().is_some_and(|c| c.alive())
    }

    /// Started by the sign-in helper in the user's session.
    pub fn hosted(&self) -> bool {
        self.child.as_ref().is_some_and(|c| c.hosted())
    }

    pub async fn exit_status(&mut self, reason: &str) -> String {
        super::session_host::exit_status(&mut self.child, self.pid, self.process, reason).await
    }

    pub async fn close(&mut self) {
        // Cancelling the connection drops stdin BEFORE the graceful child wait.
        self.stop.cancel();
        if let Some(io) = self.io.take() { let _ = io.await; }
        if let Some(mut child) = self.child.take() {
            child.stop_gracefully(self.job.as_ref(), &self.who, "ACP close requested", Duration::from_secs(5)).await;
        }
        if let Some(stderr) = self.stderr.take() { let _ = stderr.await; }
    }
}

impl Drop for Process {
    fn drop(&mut self) { self.stop.cancel(); }
}

#[nolog]
fn connection<R, W>(read: R, write: W, approval: Approval, stop: CancellationToken)
    -> (Client, mpsc::Receiver<Event>, tokio::task::JoinHandle<()>)
where R: AsyncRead + Unpin + Send + 'static, W: AsyncWrite + Unpin + Send + 'static {
    let (tx, rx) = mpsc::channel(QUEUE);
    let (events, receiver) = mpsc::channel(QUEUE);
    let io = tokio::spawn(async move {
        let reason = pump(read, write, rx, &events, approval, stop).await;
        let _ = events.try_send(Event::Ended(reason));
    });
    (Client { tx, next: Arc::new(AtomicU64::new(1)) }, receiver, io)
}

#[nolog]
async fn frame<W: AsyncWrite + Unpin>(write: &mut W, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    if bytes.len() > MAX_FRAME { return Err(anyhow!("ACP outgoing frame too large")); }
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), async {
        write.write_all(&bytes).await?;
        write.flush().await
    }).await.context("ACP input stalled")??;
    Ok(())
}

#[nolog]
async fn pump<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    read: R, mut write: W, mut commands: mpsc::Receiver<Control>, events: &mpsc::Sender<Event>,
    approval: Approval, stop: CancellationToken,
) -> String {
    let mut lines = FramedRead::new(read, LinesCodec::new_with_max_length(MAX_FRAME));
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut replay = false;
    let mut session: Option<String> = None;
    loop {
        if pending.values().any(|p| p.method.starts_with("session/") && p.reply.is_closed()) {
            return "ACP session request abandoned".into();
        }
        pending.retain(|_, p| !p.reply.is_closed());
        tokio::select! {
            biased;
            _ = stop.cancelled() => return "ACP stopped".into(),
            command = commands.recv() => match command {
                None => return "ACP client closed".into(),
                Some(Control::Forget(id)) => {
                    if pending.remove(&id).is_some_and(|p| p.method.starts_with("session/")) {
                        // A timed-out prompt or load can still emit later; never
                        // reuse that ambiguous connection for a fresh turn.
                        return "ACP session request timed out".into();
                    }
                },
                Some(Control::Notify { method, params }) => {
                    if frame(&mut write, json!({"jsonrpc":"2.0","method":method,"params":params})).await.is_err() {
                        return "ACP write failed".into();
                    }
                },
                Some(Control::Call { id, method, params, reply }) => {
                    if reply.is_closed() { continue; }
                    if pending.len() >= MAX_PENDING || replay || (method == "session/load" && !pending.is_empty()) {
                        let _ = reply.send(Err(anyhow!("ACP pending request limit or conflicting load")));
                        continue;
                    }
                    if method == "session/load" { replay = true; }
                    let requested_session = params["sessionId"].as_str().map(str::to_owned);
                    let value = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
                    pending.insert(id, Pending { method, session: requested_session, reply });
                    if frame(&mut write, value).await.is_err() { return "ACP write failed".into(); }
                },
            },
            line = lines.next() => {
                let line = match line { Some(Ok(line)) => line, None => return "ACP stdout closed".into(),
                    Some(Err(_)) => return "ACP invalid or oversized frame".into() };
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v, Err(_) => return "ACP malformed JSON".into(),
                };
                if value["jsonrpc"] != "2.0" || !value.is_object() { return "ACP invalid JSON-RPC frame".into(); }
                if let Some(method) = value["method"].as_str() {
                    if let Some(id) = value.get("id") {
                        if !(id.is_string() || id.is_number()) { return "ACP invalid request id".into(); }
                        let result = if replay || session.as_deref().is_none()
                            || value["params"]["sessionId"].as_str() != session.as_deref() {
                            Err(anyhow!("permissions unavailable for this session")) }
                            else { approval(method, &value["params"]) };
                        let response = match result {
                            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                            // Deliberately omit raw error details from the wire/log.
                            Err(_) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Orgtree declines this client request"}}),
                        };
                        if frame(&mut write, response).await.is_err() { return "ACP response failed".into(); }
                    } else if !replay && method == "session/update" && session.is_some()
                        && value["params"]["sessionId"].as_str() == session.as_deref()
                        && events.try_send(Event::Notification(value)).is_err() {
                        return "ACP event consumer stalled".into();
                    }
                } else if let Some(id) = value["id"].as_str() {
                    if let Some(call) = pending.remove(id) {
                        if call.method == "session/load" { replay = false; }
                        if value.get("error").is_none() {
                            if call.method == "session/new" {
                                session = value["result"]["sessionId"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
                            } else if call.method == "session/load" { session = call.session; }
                        }
                        let result = if value.get("error").is_some() {
                            // Keep classification numeric; provider text can contain keys.
                            Err(anyhow!("ACP {} failed (JSON-RPC code {})", call.method,
                                value["error"]["code"].as_i64().unwrap_or(-32603)))
                        } else if let Some(result) = value.get("result") { Ok(result.clone()) }
                        else { Err(anyhow!("ACP response has no result")) };
                        let _ = call.reply.send(result);
                    }
                } else { return "ACP unsolicited invalid response".into(); }
            }
        }
    }
}

/// ACP result tokens are per prompt; context usage updates are cumulative.
/// Custom provider zero cost has no pricing provenance and stays unknown.
#[nolog]
pub fn usage(result: &Value) -> Value {
    let u = &result["usage"];
    json!({"input_tokens":u["inputTokens"].as_u64(), "output_tokens":u["outputTokens"].as_u64(),
        "cache_read_input_tokens":u["cachedReadTokens"].as_u64(),
        "cache_creation_input_tokens":u["cachedWriteTokens"].as_u64(), "cost_usd":Value::Null})
}

/// Only the explicit allow_once/reject_once options can be selected.
#[nolog]
pub fn permission_result(params: &Value, allow: bool) -> Value {
    let kind = if allow { "allow_once" } else { "reject_once" };
    match params["options"].as_array().and_then(|options| options.iter()
        .find(|o| o["kind"] == kind).and_then(|o| o["optionId"].as_str())) {
        Some(id) => json!({"outcome":{"outcome":"selected","optionId":id}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    struct Fake {
        client: Client,
        events: mpsc::Receiver<Event>,
        read: BufReader<ReadHalf<DuplexStream>>,
        write: WriteHalf<DuplexStream>,
        stop: CancellationToken,
        task: tokio::task::JoinHandle<()>,
    }
    impl Fake {
        fn new() -> Self {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let (read, write) = tokio::io::split(ours);
            let stop = CancellationToken::new();
            let policy: Approval = Arc::new(|method, p| {
                if method != "session/request_permission" { return Err(anyhow!("unsupported")); }
                Ok(permission_result(p, true))
            });
            let (client, events, task) = connection(read, write, policy, stop.clone());
            let (read, write) = tokio::io::split(theirs);
            Self { client, events, read: BufReader::new(read), write, stop, task }
        }
        async fn read(&mut self) -> Value {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(2), self.read.read_line(&mut line)).await.unwrap().unwrap();
            serde_json::from_str(&line).unwrap()
        }
        async fn send(&mut self, v: Value) { frame(&mut self.write, v).await.unwrap(); }
        async fn opened(&mut self) {
            let c = self.client.clone();
            let request = tokio::spawn(async move { c.request("session/new", json!({}), Duration::from_secs(2)).await });
            let call = self.read().await;
            self.send(json!({"jsonrpc":"2.0","id":call["id"],"result":{"sessionId":"s"}})).await;
            request.await.unwrap().unwrap();
        }
        async fn close(self) { self.stop.cancel(); self.task.await.unwrap(); }
    }

    #[tokio::test]
    async fn acp_routes_only_current_session_and_rejects_unknown_methods() {
        let mut f = Fake::new(); f.opened().await;
        f.send(json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"wrong","options":[]}})).await;
        assert!(f.read().await.get("error").is_some());
        f.send(json!({"jsonrpc":"2.0","id":8,"method":"fs/write_text_file","params":{"sessionId":"s"}})).await;
        assert!(f.read().await.get("error").is_some());
        f.send(json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s",
            "options":[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"}]}})).await;
        assert_eq!(f.read().await["result"]["outcome"]["optionId"], "once");
        f.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"wrong","update":{"text":"old"}}})).await;
        f.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"text":"new"}}})).await;
        let Event::Notification(v) = f.events.recv().await.unwrap() else { panic!("expected update") };
        assert_eq!(v["params"]["update"]["text"], "new");
        f.close().await;
    }

    #[tokio::test]
    async fn acp_load_suppresses_replay_but_delivers_next_turn() {
        let mut f = Fake::new(); f.opened().await;
        let c = f.client.clone();
        let request = tokio::spawn(async move { c.request("session/load", json!({"sessionId":"s"}), Duration::from_secs(2)).await });
        let call = f.read().await;
        f.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"text":"replay"}}})).await;
        f.send(json!({"jsonrpc":"2.0","id":call["id"],"result":{}})).await;
        request.await.unwrap().unwrap();
        f.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"text":"new"}}})).await;
        let Event::Notification(v) = f.events.recv().await.unwrap() else { panic!("expected update") };
        assert_eq!(v["params"]["update"]["text"], "new");
        f.close().await;
    }

    #[tokio::test]
    async fn acp_cancel_does_not_wait_for_prompt_response_and_close_fails_waiter() {
        let mut f = Fake::new(); f.opened().await;
        let c = f.client.clone();
        let request = tokio::spawn(async move { c.request("session/prompt", json!({"sessionId":"s"}), Duration::from_secs(2)).await });
        assert_eq!(f.read().await["method"], "session/prompt");
        f.client.notify("session/cancel", json!({"sessionId":"s"})).unwrap();
        assert_eq!(f.read().await["method"], "session/cancel");
        f.close().await;
        assert!(request.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn acp_abandoned_load_closes_connection_instead_of_accepting_late_replay() {
        let mut f = Fake::new();
        let c = f.client.clone();
        let request = tokio::spawn(async move { c.request("session/load", json!({"sessionId":"s"}), Duration::from_millis(50)).await });
        f.read().await;
        assert!(request.await.unwrap().is_err());
        let ended = tokio::time::timeout(Duration::from_secs(2), f.events.recv()).await.unwrap().unwrap();
        assert!(matches!(ended, Event::Ended(_)));
        f.close().await;
    }

    #[tokio::test]
    async fn acp_malformed_oversize_and_eof_are_bounded_terminal_failures() {
        for bytes in [b"{broken}\n".to_vec(), vec![b'x'; MAX_FRAME + 2], vec![]] {
            let mut f = Fake::new();
            if bytes.is_empty() { f.write.shutdown().await.unwrap(); }
            else { let _ = f.write.write_all(&bytes).await; }
            let ended = tokio::time::timeout(Duration::from_secs(2), f.events.recv()).await.unwrap().unwrap();
            assert!(matches!(ended, Event::Ended(_)));
            f.close().await;
        }
    }

    #[test]
    fn acp_custom_cost_remains_unknown_and_cache_tokens_are_not_input_again() {
        let result = usage(&json!({"usage":{"inputTokens":12,"outputTokens":3,"cachedReadTokens":40,"totalTokens":55,"cost":0}}));
        assert_eq!(result["input_tokens"], 12);
        assert_eq!(result["cache_read_input_tokens"], 40);
        assert!(result["cost_usd"].is_null());
        assert!(usage(&json!({}))["input_tokens"].is_null());
    }
}
