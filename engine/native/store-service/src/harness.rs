//! The qualification-only harness endpoint (CONTRACT-M1 §5): the server side
//! of WS7's `orgtree.p03-harness/v1` (`tools/p03/harness/protocol.py`).
//! Compiled only with the `qualification` feature.
//!
//! One harness connection at a time. A `plan` installs holds keyed by
//! `(op_tag, point)` and arms unsafe controls for this run; the executor's
//! pause hook reports `arrived` for every planned point it reaches and applies
//! the planned action (`hold` waits for `release`, bounded by the hold's
//! `timeout_ms`); unplanned points emit nothing and never block. Only
//! operations carrying an `op_tag` can match a hold.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Notify};

use orgtree_store::hooks::{BoxFuture, ControlPlan, HookAction, PauseHook, PausePoint};
use orgtree_store::OpIdentity;

use crate::proto::{read_frame, write_frame};
use crate::server::token_eq;

pub const PROTOCOL: &str = "orgtree.p03-harness/v1";

#[derive(Clone, Debug)]
struct Hold {
    action: String,
    timeout_ms: u64,
    sqlstate: Option<String>,
    ms: Option<u64>,
}

#[derive(Default)]
struct Plan {
    holds: HashMap<(String, String), Hold>,
    controls: HashSet<String>,
    released: HashSet<(String, String)>,
}

/// Shared by the executor's hooks and the harness connection.
#[derive(Default)]
pub struct HarnessState {
    plan: Mutex<Plan>,
    out: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    release: Notify,
    seq: AtomicU64,
}

impl HarnessState {
    pub fn new() -> Arc<HarnessState> {
        Arc::new(HarnessState::default())
    }

    fn send(&self, v: Value) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            let _ = tx.send(v);
        }
    }

    /// Install a plan frame. Returns the validation errors (empty = installed).
    pub fn install_plan(&self, frame: &Value) -> Vec<String> {
        let mut errors = Vec::new();
        let mut holds = HashMap::new();
        for h in frame.get("holds").and_then(Value::as_array).cloned().unwrap_or_default() {
            let op_tag = h.get("op_tag").and_then(Value::as_str).unwrap_or("").to_string();
            let point = h.get("point").and_then(Value::as_str).unwrap_or("").to_string();
            let action = h.get("action").and_then(Value::as_str).unwrap_or("").to_string();
            let timeout_ms = h.get("timeout_ms").and_then(Value::as_u64).unwrap_or(0);
            if op_tag.is_empty() || point.is_empty() || timeout_ms == 0 {
                errors.push(format!("hold needs op_tag, point and a positive timeout_ms: {h}"));
                continue;
            }
            if !["hold", "fail_next", "drop_conn", "sleep"].contains(&action.as_str()) {
                errors.push(format!("unknown action {action:?}"));
                continue;
            }
            let hold = Hold {
                action,
                timeout_ms,
                sqlstate: h.get("sqlstate").and_then(Value::as_str).map(str::to_string),
                ms: h.get("ms").and_then(Value::as_u64),
            };
            if holds.insert((op_tag.clone(), point.clone()), hold).is_some() {
                errors.push(format!("two holds for ({op_tag}, {point})"));
            }
        }
        let controls: HashSet<String> =
            frame.get("controls").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if errors.is_empty() {
            *self.plan.lock().unwrap() = Plan { holds, controls, released: HashSet::new() };
        }
        errors
    }

    fn release(&self, op_tag: &str, point: &str) {
        self.plan.lock().unwrap().released.insert((op_tag.to_string(), point.to_string()));
        self.release.notify_waiters();
    }
}

fn operation_id(op: &OpIdentity) -> String {
    format!("{}:{}:{}:{}", op.org, op.ns.kind(), op.ns.id(), op.key)
}

impl PauseHook for HarnessState {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction> {
        Box::pin(async move {
            let Some(tag) = p.op_tag else { return HookAction::Continue };
            let key = (tag.to_string(), p.name.to_string());
            let hold = self.plan.lock().unwrap().holds.get(&key).cloned();
            let Some(hold) = hold else { return HookAction::Continue };
            self.send(json!({
                "type": "arrived", "point": p.name, "op_tag": tag, "operation_id": operation_id(p.op),
                "attempt": p.attempt, "backend_pid": p.backend_pid.unwrap_or(0), "txid_if_assigned": null,
                "seq": self.seq.fetch_add(1, Ordering::SeqCst),
            }));
            match hold.action.as_str() {
                "hold" => {
                    let deadline = tokio::time::Instant::now() + Duration::from_millis(hold.timeout_ms);
                    loop {
                        let notified = self.release.notified();
                        if self.plan.lock().unwrap().released.remove(&key) {
                            return HookAction::Continue;
                        }
                        if tokio::time::timeout_at(deadline, notified).await.is_err() {
                            self.send(json!({"type": "error", "detail": format!("hold at {} for {} was never released within {} ms", p.name, tag, hold.timeout_ms)}));
                            return HookAction::Continue;
                        }
                    }
                }
                "fail_next" => HookAction::FailNext(hold.sqlstate.unwrap_or_else(|| "40001".into())),
                "drop_conn" => HookAction::DropConn,
                "sleep" => HookAction::Sleep(hold.ms.unwrap_or(0)),
                _ => HookAction::Continue,
            }
        })
    }
}

impl ControlPlan for HarnessState {
    fn armed(&self, id: &str, _op: &OpIdentity, _op_tag: Option<&str>) -> bool {
        self.plan.lock().unwrap().controls.contains(id)
    }
}

/// Serve the harness endpoint. `handshake` is the full handshake frame.
pub async fn serve(listener: TcpListener, token: Arc<String>, state: Arc<HarnessState>, handshake: Value) -> std::io::Result<()> {
    loop {
        let (mut sock, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let Some(hello) = read_frame(&mut sock).await? else { continue };
        let ok = hello.get("type").and_then(Value::as_str) == Some("hello")
            && hello.get("protocol").and_then(Value::as_str) == Some(PROTOCOL)
            && token_eq(hello.get("token").and_then(Value::as_str).unwrap_or(""), &token);
        if !ok {
            continue;
        }
        write_frame(&mut sock, &handshake).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        *state.out.lock().unwrap() = Some(tx);
        let (mut rd, mut wr) = sock.into_split();
        let writer = tokio::spawn(async move {
            while let Some(v) = rx.recv().await {
                if write_frame(&mut wr, &v).await.is_err() {
                    break;
                }
            }
        });
        while let Ok(Some(frame)) = read_frame(&mut rd).await {
            match frame.get("type").and_then(Value::as_str) {
                Some("plan") => {
                    let errors = state.install_plan(&frame);
                    if !errors.is_empty() {
                        state.send(json!({"type": "error", "detail": errors.join("; ")}));
                    }
                }
                Some("release") => {
                    let tag = frame.get("op_tag").and_then(Value::as_str).unwrap_or("");
                    let point = frame.get("point").and_then(Value::as_str).unwrap_or("");
                    state.release(tag, point);
                }
                Some("finish") => state.send(json!({"type": "finished", "streams": [], "records": []})),
                other => state.send(json!({"type": "error", "detail": format!("unexpected frame {other:?}")})),
            }
        }
        *state.out.lock().unwrap() = None;
        *state.plan.lock().unwrap() = Plan::default();
        writer.abort();
    }
}
