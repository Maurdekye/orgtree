//! Turn admission: at most N model turns run at once machine-wide. Waiting
//! turns run first-come-first-served within an org and round-robin across
//! orgs. One task runs the queue; agents ask it for a slot over a channel and
//! give the slot back by dropping it. Lowering N never stops a running turn.
//! The same task keeps the machine-wide cap on idle ("parked") CLI processes:
//! past the cap, the one parked longest is asked to close.
//! A turn on one of the user's language servers also counts against that
//! server's own agents-at-once cap (one GPU serves only a few agents): while
//! the server is full the turn waits, and the turns queued behind it that
//! the cap does not hold back go first.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;

pub struct Scheduler {
    tx: mpsc::UnboundedSender<(Msg, tracing::Span)>,
    pub limit: AtomicUsize,
    pub held: Arc<AtomicUsize>,
    pub waiting: Arc<AtomicUsize>,
}

/// The scheduler task's inbox, handed to `start` once.
pub struct SchedInbox(mpsc::UnboundedReceiver<(Msg, tracing::Span)>);

/// A per-resource cap a turn also needs room under: (key, cap).
pub type Lane = Option<(String, usize)>;

enum Msg {
    Want { org: i64, agent: i64, lane: Lane, reply: oneshot::Sender<Slot> },
    Cancel { agent: i64 },
    Released { lane: Option<String> },
    Limit(usize),
    Stats(oneshot::Sender<SchedStats>),
    Parked(i64),
    Unparked(i64),
}

/// Idle CLI processes kept alive at most, machine-wide.
pub const MAX_PARKED: usize = 64;

#[derive(Clone, Debug, Default)]
pub struct SchedStats {
    pub limit: usize,
    pub held: usize,
    pub waiting: usize,
    pub waiting_by_org: HashMap<i64, usize>,
    /// agent → (position, waiting when it queued)
    pub queue: Vec<(i64, i64)>,
}

/// A held turn slot; dropping it frees the slot.
pub struct Slot {
    span: tracing::Span,
    tx: mpsc::UnboundedSender<(Msg, tracing::Span)>,
    held: Arc<AtomicUsize>,
    org: i64,
    agent: i64,
    /// the language server this turn holds a place on
    lane: Option<String>,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Slot")
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let _entered = self.span.enter();
        let held = self.held.fetch_sub(1, Ordering::SeqCst) - 1;
        tracing::info!(org = self.org, agent = self.agent, held, lane = ?self.lane, "turn slot released");
        let _ = self.tx.send((Msg::Released { lane: self.lane.take() }, self.span.clone()));
    }
}

#[logged]
impl Scheduler {
    fn post(&self, msg: Msg) {
        let _ = self.tx.send((msg, tracing::Span::current()));
    }

    pub fn new(limit: usize) -> (Self, SchedInbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Scheduler {
                tx,
                limit: AtomicUsize::new(limit.max(1)),
                held: Arc::new(AtomicUsize::new(0)),
                waiting: Arc::new(AtomicUsize::new(0)),
            },
            SchedInbox(rx),
        )
    }

    /// Ask for a slot; resolves when one is granted. `lane`: a language
    /// server's (id, agents-at-once cap) the turn also needs room on.
    pub fn want(&self, org: i64, agent: i64, lane: Lane) -> oneshot::Receiver<Slot> {
        let (reply, rx) = oneshot::channel();
        self.post(Msg::Want { org, agent, lane, reply });
        rx
    }

    pub fn cancel(&self, agent: i64) {
        self.post(Msg::Cancel { agent });
    }

    /// This agent's CLI is idle and alive (a parked process).
    pub fn parked(&self, agent: i64) {
        self.post(Msg::Parked(agent));
    }

    pub fn unparked(&self, agent: i64) {
        self.post(Msg::Unparked(agent));
    }

    pub fn set_limit(&self, n: usize) {
        self.limit.store(n.max(1), Ordering::SeqCst);
        self.post(Msg::Limit(n.max(1)));
    }

    pub async fn stats(&self) -> SchedStats {
        let (tx, rx) = oneshot::channel();
        if self.tx.send((Msg::Stats(tx), tracing::Span::current())).is_err() {
            return SchedStats::default();
        }
        rx.await.unwrap_or_default()
    }
}

#[logged]
pub fn start(engine: &Arc<Engine>, inbox: SchedInbox) {
    let engine = engine.clone();
    let mut rx = inbox.0;
    tokio::spawn(async move {
        let mut queues: HashMap<i64, VecDeque<(i64, Lane, oneshot::Sender<Slot>, tracing::Span)>> = HashMap::new();
        let mut rotation: VecDeque<i64> = VecDeque::new();
        let mut parked: VecDeque<i64> = VecDeque::new();
        // turns running per language server
        let mut lanes: HashMap<String, usize> = HashMap::new();
        let sched = &engine.sched;
        while let Some((msg, span)) = rx.recv().await {
            let _g = span.enter();
            match msg {
                Msg::Want { org, agent, lane, reply } => {
                    let q = queues.entry(org).or_default();
                    q.retain(|(a, _, _, _)| *a != agent);
                    q.push_back((agent, lane, reply, span.clone()));
                    if !rotation.contains(&org) {
                        rotation.push_back(org);
                    }
                }
                Msg::Cancel { agent } => {
                    for q in queues.values_mut() {
                        q.retain(|(a, _, _, _)| *a != agent);
                    }
                }
                Msg::Released { lane } => {
                    if let Some(k) = lane {
                        if let Some(n) = lanes.get_mut(&k) {
                            *n = n.saturating_sub(1);
                            if *n == 0 {
                                lanes.remove(&k);
                            }
                        }
                    }
                }
                Msg::Limit(_) => {}
                Msg::Parked(agent) => {
                    parked.retain(|a| *a != agent);
                    parked.push_back(agent);
                    while parked.len() > MAX_PARKED {
                        let Some(oldest) = parked.pop_front() else { break };
                        if let Some(h) = engine.agents.get(oldest) {
                            h.send(crate::runtime::AgentMsg::CloseIdle);
                        }
                    }
                    continue;
                }
                Msg::Unparked(agent) => {
                    parked.retain(|a| *a != agent);
                    continue;
                }
                Msg::Stats(reply) => {
                    let waiting_by_org: HashMap<i64, usize> =
                        queues.iter().map(|(o, q)| (*o, q.len())).filter(|(_, n)| *n > 0).collect();
                    let mut queue = Vec::new();
                    for q in queues.values() {
                        for (i, (a, _, _, _)) in q.iter().enumerate() {
                            queue.push((*a, i as i64));
                        }
                    }
                    let _ = reply.send(SchedStats {
                        limit: sched.limit.load(Ordering::SeqCst),
                        held: sched.held.load(Ordering::SeqCst),
                        waiting: waiting_by_org.values().sum(),
                        waiting_by_org,
                        queue,
                    });
                    continue;
                }
            }
            // grant while there is room, round-robin across orgs; within an
            // org first come first served, except that a turn whose language
            // server is at its cap waits without holding up the ones behind it
            loop {
                if sched.held.load(Ordering::SeqCst) >= sched.limit.load(Ordering::SeqCst) {
                    break;
                }
                // one look at each org in the rotation for a turn that may start
                let mut picked = None;
                for _ in 0..rotation.len() {
                    let Some(org) = rotation.pop_front() else { break };
                    let Some(q) = queues.get_mut(&org) else { continue };
                    q.retain(|(_, _, reply, _)| !reply.is_closed());
                    let pos = q.iter().position(|(_, lane, _, _)| match lane {
                        Some((k, cap)) => lanes.get(k).copied().unwrap_or(0) < (*cap).max(1),
                        None => true,
                    });
                    let entry = pos.and_then(|i| q.remove(i));
                    if !q.is_empty() {
                        rotation.push_back(org);
                    }
                    if let Some(e) = entry {
                        picked = Some((org, e));
                        break;
                    }
                }
                let Some((org, (agent, lane, reply, owner_span))) = picked else { break };
                let held = sched.held.fetch_add(1, Ordering::SeqCst) + 1;
                let lane = lane.map(|(k, _)| k);
                if let Some(k) = &lane {
                    *lanes.entry(k.clone()).or_insert(0) += 1;
                }
                owner_span.in_scope(|| {
                    tracing::info!(org, agent, held, limit = sched.limit.load(Ordering::SeqCst), lane = ?lane, "turn slot granted");
                });
                let slot = Slot { span: owner_span, tx: sched.tx.clone(), held: sched.held.clone(), org, agent, lane };
                if let Err(slot) = reply.send(slot) {
                    drop(slot);
                }
            }
            let waiting: usize = queues.values().map(VecDeque::len).sum();
            sched.waiting.store(waiting, Ordering::SeqCst);
        }
    });
}
