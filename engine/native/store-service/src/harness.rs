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

/// `(op_tag, point, attempt)`; `attempt: None` = every attempt (protocol v1
/// amendment by WS7: a hold may name the attempt it applies to).
type HoldKey = (String, String, Option<u32>);

#[derive(Default)]
struct Plan {
    holds: HashMap<HoldKey, Hold>,
    controls: HashSet<String>,
    released: HashSet<HoldKey>,
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
            let attempt = match h.get("attempt") {
                None | Some(Value::Null) => None,
                Some(a) => match a.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n >= 1) {
                    Some(n) => Some(n),
                    None => {
                        errors.push(format!("hold attempt must be an integer >= 1: {h}"));
                        continue;
                    }
                },
            };
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
            if holds.insert((op_tag.clone(), point.clone(), attempt), hold).is_some() {
                errors.push(format!("two holds for ({op_tag}, {point}, {attempt:?})"));
            }
        }
        // an every-attempt hold beside an attempt-specific one is ambiguous
        for (tag, point, att) in holds.keys() {
            if att.is_some() && holds.contains_key(&(tag.clone(), point.clone(), None)) {
                errors.push(format!("ambiguous holds for ({tag}, {point}): one without an attempt and one for attempt {att:?}"));
            }
        }
        let controls: HashSet<String> =
            frame.get("controls").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if errors.is_empty() {
            *self.plan.lock().unwrap() = Plan { holds, controls, released: HashSet::new() };
        }
        errors
    }

    /// `attempt: None` releases whichever attempt of `(op_tag, point)` is
    /// waiting or arrives next.
    fn release(&self, op_tag: &str, point: &str, attempt: Option<u32>) {
        self.plan.lock().unwrap().released.insert((op_tag.to_string(), point.to_string(), attempt));
        self.release.notify_waiters();
    }

    fn take_release(&self, tag: &str, point: &str, attempt: u32) -> bool {
        let mut g = self.plan.lock().unwrap();
        g.released.remove(&(tag.to_string(), point.to_string(), Some(attempt))) || g.released.remove(&(tag.to_string(), point.to_string(), None))
    }
}

fn operation_id(op: &OpIdentity) -> String {
    format!("{}:{}:{}:{}", op.org, op.ns.kind(), op.ns.id(), op.key)
}

impl PauseHook for HarnessState {
    fn at<'a>(&'a self, p: &'a PausePoint<'a>) -> BoxFuture<'a, HookAction> {
        Box::pin(async move {
            let Some(tag) = p.op_tag else { return HookAction::Continue };
            let hold = {
                let g = self.plan.lock().unwrap();
                g.holds
                    .get(&(tag.to_string(), p.name.to_string(), Some(p.attempt)))
                    .or_else(|| g.holds.get(&(tag.to_string(), p.name.to_string(), None)))
                    .cloned()
            };
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
                        if self.take_release(tag, p.name, p.attempt) {
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
                    let attempt = frame.get("attempt").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                    state.release(tag, point, attempt);
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
