//! The "Scheduled" stage (v6 MAIL-STAGES): a bounded MPSC queue of volatile
//! delivery hints. Enqueue does no database work and never waits for
//! receiver capacity: a full or absent queue DROPS the hint and counts it.
//! A lost hint changes nothing durable; the recovery sweep finds the pending
//! intent (v6: "Queue full/loss leaves durable source work eligible for
//! recovery; it never changes Sent into Received").
//!
//! The queue is process-global: the store service installs it at start.
//! Hints are emitted only as post-commit effects ([`crate::Tx::after_commit`]),
//! so a failed attempt never hints (v6 I04).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hint {
    /// A committed `mail.deliver` or `mail.retract` intent for this mailbox.
    Deliver { org: Uuid, mailbox: Uuid, message: Uuid },
    /// A committed transport intent for an outside party.
    Transport { org: Uuid, message: Uuid },
    /// A committed wake or kickoff intent for this seat.
    Runtime { org: Uuid, principal: Uuid },
}

static QUEUE: RwLock<Option<mpsc::Sender<Hint>>> = RwLock::new(None);
static EMITTED: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// Install a bounded queue and return its single consumer end. Replaces any
/// earlier queue (its receiver then sees the channel close).
pub fn install(capacity: usize) -> mpsc::Receiver<Hint> {
    let (tx, rx) = mpsc::channel(capacity.max(1));
    *QUEUE.write().unwrap() = Some(tx);
    rx
}

/// Remove the queue: every later hint is dropped (and counted).
pub fn uninstall() {
    *QUEUE.write().unwrap() = None;
}

/// Offer a hint. Never blocks and never fails the caller.
pub fn emit(h: Hint) {
    let sent = match QUEUE.read().unwrap().as_ref() {
        Some(q) => q.try_send(h).is_ok(),
        None => false,
    };
    if sent {
        EMITTED.fetch_add(1, Ordering::Relaxed);
    } else {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

/// `(emitted, dropped)` since process start: the counters a run reports so
/// a "lost hint" schedule can prove the loss actually happened.
pub fn counters() -> (u64, u64) {
    (EMITTED.load(Ordering::Relaxed), DROPPED.load(Ordering::Relaxed))
}
