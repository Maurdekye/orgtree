//! The agent runtime: one task (actor) per agent that is doing something.
//! It owns that agent's live state and its provider CLI, takes turns from the
//! scheduler, and publishes its runtime overlay to the org feed. Everything
//! reaches it through its channel; nothing outside reads its state except
//! through the snapshot it publishes.

pub mod actor;
pub mod claude;
pub mod codex;
pub mod convo;
pub mod freeze;
pub mod prompt;
pub mod sched;
pub mod watchdogs;

use std::collections::HashMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;

/// Who is calling an agent tool (implicit in the process the call came from).
#[derive(Clone, Debug)]
pub struct Caller {
    pub org_id: i64,
    pub org_slug: String,
    pub agent_id: i64,
    pub name: String,
}

#[derive(Debug)]
pub enum AgentMsg {
    /// waking mail (or anything else that may need a turn)
    Wake,
    /// the scheduler granted this agent a turn slot
    Slot(sched::Slot),
    Interrupt(oneshot::Sender<Value>),
    Halt(oneshot::Sender<Value>),
    Unhalt(oneshot::Sender<Value>),
    /// a slash command typed on the desk (`/compact`, ...), sent to the CLI as is
    Command(String, oneshot::Sender<Value>),
    /// effort changed: deliver to a running Claude turn
    Effort(String, oneshot::Sender<Value>),
    /// start/stop the parked CLI process
    Process { action: String, reply: oneshot::Sender<Value> },
    /// scope/model/account/charter changed: the next turn needs a fresh process
    Reconfigured,
    /// a line from the Claude CLI
    Claude(Value),
    /// a JSON-RPC notification/response from the Codex app-server
    Codex(Value),
    /// the PostToolUse hook: return waiting mail as additional context
    Hook { input: Value, reply: oneshot::Sender<Value> },
    ProcExited,
    /// the live tail and runtime for a chat read
    Live(oneshot::Sender<actor::LiveView>),
    /// retire/delete/shutdown: end everything and stop
    Stop(oneshot::Sender<()>),
    /// the machine-wide idle-process cap wants this agent's parked CLI closed
    CloseIdle,
    /// an `orgtree_*` tool's card (mail, file, document, docket item) for
    /// the chip of this tool_use id
    ToolCard(String, Value),
}

/// A message to an agent's actor and the request that sent it (the actor
/// handles it as a new request caused by that one).
pub struct Envelope {
    pub msg: AgentMsg,
    pub cause: Option<String>,
}

pub type AgentTx = mpsc::UnboundedSender<Envelope>;

pub trait Post {
    fn post(&self, msg: AgentMsg) -> bool;
}

impl Post for AgentTx {
    fn post(&self, msg: AgentMsg) -> bool {
        // the CLI's stream lines run under their turn's request
        let cause = if matches!(msg, AgentMsg::Claude(_)) { None } else { crate::trace::current_rq() };
        self.send(Envelope { msg, cause }).is_ok()
    }
}

pub struct AgentHandle {
    pub id: i64,
    pub org_id: i64,
    pub tx: AgentTx,
    /// the overlay values the actor last published (read lock-free)
    pub view: ArcSwap<Value>,
}

#[logged]
impl AgentHandle {
    pub fn send(&self, msg: AgentMsg) -> bool {
        self.tx.post(msg)
    }
}

#[derive(Default)]
pub struct AgentRegistry {
    pub map: papaya::HashMap<i64, Arc<AgentHandle>>,
}

#[logged]
impl AgentRegistry {
    pub fn get(&self, id: i64) -> Option<Arc<AgentHandle>> {
        self.map.pin().get(&id).cloned()
    }
    pub fn count(&self) -> usize {
        self.map.pin().len()
    }
    pub fn remove_if(&self, id: i64, handle: &Arc<AgentHandle>) {
        let map = self.map.pin();
        if map.get(&id).map(|h| Arc::ptr_eq(h, handle)).unwrap_or(false) {
            map.remove(&id);
        }
    }
}

/// The agent's actor, started on demand.
#[logged]
pub fn actor(engine: &Arc<Engine>, org_id: i64, agent_id: i64) -> Arc<AgentHandle> {
    if let Some(h) = engine.agents.get(agent_id) {
        if !h.tx.is_closed() {
            return h;
        }
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = Arc::new(AgentHandle { id: agent_id, org_id, tx, view: ArcSwap::from_pointee(Value::Null) });
    let map = engine.agents.map.pin();
    // another caller may have raced us: keep whichever is in the map
    let winner = map
        .compute(agent_id, |existing| match existing {
            Some((_, h)) if !h.tx.is_closed() => papaya::Operation::Abort(h.clone()),
            _ => papaya::Operation::Insert(handle.clone()),
        });
    match winner {
        papaya::Compute::Aborted(h) => h,
        _ => {
            actor::spawn(engine.clone(), handle.clone(), rx);
            handle
        }
    }
}

/// Wake an agent: start its actor if needed and tell it mail is waiting.
#[logged]
pub fn wake(engine: &Arc<Engine>, org_id: i64, agent_id: i64) {
    actor(engine, org_id, agent_id).send(AgentMsg::Wake);
}

/// Agents running a turn right now, per org.
#[logged]
pub fn working_by_org(engine: &Engine) -> HashMap<i64, i64> {
    engine.orgs.all().into_iter().map(|o| (o.id, o.working.load(std::sync::atomic::Ordering::SeqCst))).collect()
}

/// Resume agents that were mid-turn when the last engine stopped, and wake
/// agents with waiting mail.
#[logged]
pub async fn recover(engine: &Arc<Engine>) {
    if std::env::var("ORGTREE_ENGINE_SAFE_START").as_deref() == Ok("1") {
        tracing::warn!("safe start: no agent is woken automatically");
        return;
    }
    let Ok(client) = engine.db.get().await else { return };
    // turns the last stop cut off: mail the CLI was already handed is in its
    // session (delivered); mail that never reached it goes back to the queue
    let _ = client
        .execute(
            "UPDATE ot.mail m SET state = 'delivered', delivered_at = now() FROM ot.turns t
              WHERE m.turn_id = t.id AND m.state = 'delivering' AND t.sent_at IS NOT NULL",
            &[],
        )
        .await;
    let _ = client
        .execute("UPDATE ot.mail SET state = 'pending', turn_id = NULL WHERE state = 'delivering'", &[])
        .await;
    let _ = client
        .execute(
            "UPDATE ot.turns SET ended_at = now(), killed = true, error = coalesce(error, 'the engine stopped during this turn')
              WHERE ended_at IS NULL",
            &[],
        )
        .await;
    let interrupted = client
        .query(
            "UPDATE ot.agents SET inflight_at = NULL WHERE inflight_at IS NOT NULL AND state = 'live'
             RETURNING id, org_id",
            &[],
        )
        .await
        .unwrap_or_default();
    for r in &interrupted {
        let (id, org): (i64, i64) = (r.get(0), r.get(1));
        let _ = crate::domain::mail::system_wake(
            engine,
            org,
            id,
            "The engine restarted while you were working. Continue where you left off.",
        )
        .await;
    }
    freeze::recover(engine).await;
    let waiting = client
        .query(
            "SELECT DISTINCT m.recipient_agent_id, a.org_id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
              WHERE m.state = 'pending' AND NOT m.notice AND a.state = 'live' AND a.halt IS NULL",
            &[],
        )
        .await
        .unwrap_or_default();
    for r in &waiting {
        wake(engine, r.get(1), r.get(0));
    }
}

/// Stop admitting turns and end the running ones (their mail returns to the
/// queue; they resume on the next start).
#[logged]
pub async fn shutdown(engine: &Arc<Engine>) {
    let handles: Vec<Arc<AgentHandle>> = engine.agents.map.pin().values().cloned().collect();
    let mut waits = Vec::new();
    for h in handles {
        let (tx, rx) = oneshot::channel();
        if h.send(AgentMsg::Stop(tx)) {
            waits.push(rx);
        }
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), futures::future::join_all(waits)).await;
}
