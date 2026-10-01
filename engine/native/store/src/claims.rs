//! The r7 C5 output-claim registry (CONTRACT-M1 §6): in memory, one per
//! service incarnation. A protected answer is released only through
//! [`ClaimHandle::emit`], which refuses once a restriction has revoked the
//! claim; [`ClaimRegistry::restrict`] revokes matching claims that are not yet
//! emitting and waits for the emitting ones, after which the caller may
//! acknowledge its durable restriction obligation.
//!
//! Matching is by organization and principal. `narrow` records the route the
//! answer depended on; M1 does not use it to skip claims (the coarse, correct
//! behaviour r7 C5 allows); precision is a Q-C6 performance measurement.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Open,
    Emitting,
    Revoked,
}

#[derive(Debug)]
struct Claim {
    org: Uuid,
    principal: Uuid,
    #[allow(dead_code)]
    generation: i64,
    routes: Vec<String>,
    state: State,
}

#[derive(Default)]
struct Inner {
    next: u64,
    claims: HashMap<u64, Claim>,
}

#[derive(Default)]
pub struct ClaimRegistry {
    inner: Mutex<Inner>,
    released: Notify,
}

/// A restriction as a read service sees it.
#[derive(Clone, Debug)]
pub struct Restriction {
    pub id: Uuid,
    pub org: Uuid,
    /// None = every claim in the organization (the coarse fallback).
    pub principals: Option<HashSet<Uuid>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Withheld;

pub struct ClaimHandle {
    reg: Arc<ClaimRegistry>,
    id: u64,
    done: bool,
}

impl ClaimRegistry {
    pub fn new() -> Arc<ClaimRegistry> {
        Arc::new(ClaimRegistry::default())
    }

    /// Step 2: register BEFORE taking the snapshot.
    pub fn register(self: &Arc<Self>, org: Uuid, principal: Uuid, generation: i64) -> ClaimHandle {
        let mut g = self.inner.lock().unwrap();
        g.next += 1;
        let id = g.next;
        g.claims.insert(id, Claim { org, principal, generation, routes: Vec::new(), state: State::Open });
        ClaimHandle { reg: self.clone(), id, done: false }
    }

    /// Claims currently registered (for tests and reporting).
    pub fn live(&self) -> usize {
        self.inner.lock().unwrap().claims.len()
    }

    /// Revoke every matching claim that is not emitting, then wait until the
    /// matching emitting ones have finished. Returns how many were revoked.
    pub async fn restrict(&self, r: &Restriction) -> usize {
        let (revoked, waiting): (usize, Vec<u64>) = {
            let mut g = self.inner.lock().unwrap();
            let mut revoked = 0;
            let mut waiting = Vec::new();
            for (id, c) in g.claims.iter_mut() {
                let hit = c.org == r.org && r.principals.as_ref().map_or(true, |p| p.contains(&c.principal));
                if !hit {
                    continue;
                }
                match c.state {
                    State::Open => {
                        c.state = State::Revoked;
                        revoked += 1;
                    }
                    State::Emitting => waiting.push(*id),
                    State::Revoked => {}
                }
            }
            (revoked, waiting)
        };
        loop {
            let notified = self.released.notified();
            {
                let g = self.inner.lock().unwrap();
                if waiting.iter().all(|id| !g.claims.contains_key(id)) {
                    return revoked;
                }
            }
            notified.await;
        }
    }
}

impl ClaimHandle {
    /// After the snapshot: record the route the answer depends on. Only ever
    /// narrows matching (unused for matching at M1).
    pub fn narrow(&self, route: impl Into<String>) {
        let mut g = self.reg.inner.lock().unwrap();
        if let Some(c) = g.claims.get_mut(&self.id) {
            c.routes.push(route.into());
        }
    }

    pub fn is_revoked(&self) -> bool {
        let g = self.reg.inner.lock().unwrap();
        g.claims.get(&self.id).map_or(true, |c| c.state == State::Revoked)
    }

    /// Step 5: atomically refuse if revoked, else mark emitting, send, release.
    pub async fn emit<F, Fut, R>(mut self, send: F) -> Result<R, Withheld>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = R>,
    {
        {
            let mut g = self.reg.inner.lock().unwrap();
            match g.claims.get_mut(&self.id) {
                Some(c) if c.state == State::Open => c.state = State::Emitting,
                _ => return Err(Withheld),
            }
        }
        let r = send().await;
        self.release();
        Ok(r)
    }

    fn release(&mut self) {
        if !self.done {
            self.done = true;
            self.reg.inner.lock().unwrap().claims.remove(&self.id);
            self.reg.released.notify_waiters();
        }
    }
}

impl Drop for ClaimHandle {
    fn drop(&mut self) {
        self.release();
    }
}
