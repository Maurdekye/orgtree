//! Turn admission: at most N model turns run at once machine-wide. Waiting
//! turns run first-come-first-served within an org and round-robin across
//! orgs. One task runs the queue; agents ask it for a slot over a channel and
//! give the slot back by dropping it. Lowering N never stops a running turn.
//! The same task keeps the machine-wide cap on idle ("parked") CLI processes:
//! past the cap, the one parked longest is asked to close.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::engine::Engine;

pub struct Scheduler {
    tx: mpsc::UnboundedSender<Msg>,
    pub limit: AtomicUsize,
    pub held: Arc<AtomicUsize>,
    pub waiting: Arc<AtomicUsize>,
}

/// The scheduler task's inbox, handed to `start` once.
pub struct SchedInbox(mpsc::UnboundedReceiver<Msg>);

enum Msg {
    Want { org: i64, agent: i64, reply: oneshot::Sender<Slot> },
    Cancel { agent: i64 },
    Released,
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
    tx: mpsc::UnboundedSender<Msg>,
    held: Arc<AtomicUsize>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.held.fetch_sub(1, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Released);
    }
}

impl Scheduler {
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

    /// Ask for a slot; resolves when one is granted.
    pub fn want(&self, org: i64, agent: i64) -> oneshot::Receiver<Slot> {
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Msg::Want { org, agent, reply });
        rx
    }

    pub fn cancel(&self, agent: i64) {
        let _ = self.tx.send(Msg::Cancel { agent });
    }

    /// This agent's CLI is idle and alive (a parked process).
    pub fn parked(&self, agent: i64) {
        let _ = self.tx.send(Msg::Parked(agent));
    }

    pub fn unparked(&self, agent: i64) {
        let _ = self.tx.send(Msg::Unparked(agent));
    }

    pub fn set_limit(&self, n: usize) {
        self.limit.store(n.max(1), Ordering::SeqCst);
        let _ = self.tx.send(Msg::Limit(n.max(1)));
    }

    pub async fn stats(&self) -> SchedStats {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Msg::Stats(tx)).is_err() {
            return SchedStats::default();
        }
        rx.await.unwrap_or_default()
    }
}

pub fn start(engine: &Arc<Engine>, inbox: SchedInbox) {
    let engine = engine.clone();
    let mut rx = inbox.0;
    tokio::spawn(async move {
        let mut queues: HashMap<i64, VecDeque<(i64, oneshot::Sender<Slot>)>> = HashMap::new();
        let mut rotation: VecDeque<i64> = VecDeque::new();
        let mut parked: VecDeque<i64> = VecDeque::new();
        let sched = &engine.sched;
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Want { org, agent, reply } => {
                    let q = queues.entry(org).or_default();
                    q.retain(|(a, _)| *a != agent);
                    q.push_back((agent, reply));
                    if !rotation.contains(&org) {
                        rotation.push_back(org);
                    }
                }
                Msg::Cancel { agent } => {
                    for q in queues.values_mut() {
                        q.retain(|(a, _)| *a != agent);
                    }
                }
                Msg::Released | Msg::Limit(_) => {}
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
                        for (i, (a, _)) in q.iter().enumerate() {
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
            // grant while there is room, round-robin across orgs
            loop {
                if sched.held.load(Ordering::SeqCst) >= sched.limit.load(Ordering::SeqCst) {
                    break;
                }
                let Some(org) = rotation.pop_front() else { break };
                let Some(q) = queues.get_mut(&org) else { continue };
                let Some((_agent, reply)) = q.pop_front() else {
                    continue;
                };
                if !q.is_empty() {
                    rotation.push_back(org);
                }
                if reply.is_closed() {
                    continue;
                }
                sched.held.fetch_add(1, Ordering::SeqCst);
                let slot = Slot { tx: sched.tx.clone(), held: sched.held.clone() };
                if let Err(slot) = reply.send(slot) {
                    drop(slot);
                }
            }
            let waiting: usize = queues.values().map(VecDeque::len).sum();
            sched.waiting.store(waiting, Ordering::SeqCst);
        }
    });
}
