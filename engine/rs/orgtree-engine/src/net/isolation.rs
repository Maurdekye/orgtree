//! Per-org cancellation at the external-I/O boundary. No database transaction
//! spans I/O and unrelated orgs never share a lock. A settings writer cancels
//! dispatched futures, waits for their guards to drop, then commits its policy.
use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use arc_swap::ArcSwap;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio_util::sync::CancellationToken;

use crate::engine::Engine;

pub struct Gate {
    lock: Arc<RwLock<()>>,
    epoch: ArcSwap<CancellationToken>,
}

impl Default for Gate {
    #[nolog]
    fn default() -> Self {
        Self { lock: Arc::new(RwLock::new(())), epoch: ArcSwap::from_pointee(CancellationToken::new()) }
    }
}

#[derive(Default)]
pub struct Gates(papaya::HashMap<i64, Arc<Gate>>);

impl Gates {
    #[nolog]
    fn get(&self, org: i64) -> Arc<Gate> {
        self.0.pin().get_or_insert_with(org, || Arc::new(Gate::default())).clone()
    }

    /// Held until the setting transaction commits or rolls back. In either
    /// case a fresh epoch lets subsequent admissions consult persisted policy.
    #[nolog]
    pub async fn pause(&self, org: i64) -> Paused {
        let gate = self.get(org);
        gate.epoch.load().cancel();
        let lock = gate.lock.clone().write_owned().await;
        Paused { gate, _lock: lock }
    }
}

pub struct Paused {
    gate: Arc<Gate>,
    _lock: OwnedRwLockWriteGuard<()>,
}

impl Drop for Paused {
    #[nolog]
    fn drop(&mut self) {
        self.gate.epoch.store(Arc::new(CancellationToken::new()));
    }
}

/// Short local side effects that cannot be safely cancelled halfway through.
/// Never hold this across network I/O or acquire another gate recursively.
#[nolog]
pub async fn local(engine: &Engine, org: i64) -> Result<OwnedRwLockReadGuard<()>> {
    let guard = engine.net.isolation.get(org).lock.clone().read_owned().await;
    crate::domain::orginbox::require_enabled(engine, org).await?;
    Ok(guard)
}

/// The future is not polled until every org admits this operation. Multi-org
/// polls are cancelled if any covered org changes policy; their next pass
/// rebuilds membership. Call at leaf I/O boundaries, never recursively.
#[nolog]
pub async fn run<T>(engine: &Engine, orgs: &[i64], io: impl Future<Output = Result<T>>) -> Result<T> {
    let mut ids = orgs.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let gates: Vec<_> = ids.iter().map(|id| engine.net.isolation.get(*id)).collect();
    let mut locks = Vec::with_capacity(gates.len());
    let mut epochs = Vec::with_capacity(gates.len());
    for gate in &gates {
        locks.push(gate.lock.clone().read_owned().await);
        epochs.push(gate.epoch.load_full());
    }
    let cancelled = async {
        let waits = epochs.iter().map(|epoch| Box::pin(epoch.cancelled()));
        futures::future::select_all(waits).await;
    };
    tokio::select! {
        biased;
        _ = cancelled, if !epochs.is_empty() => {
            crate::refuse!(Forbidden, "org inbox access changed; outside operation stopped");
        }
        result = async {
            for id in ids { crate::domain::orginbox::require_enabled(engine, id).await?; }
            io.await
        } => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::FutureExt;

    #[tokio::test]
    async fn pause_cancels_existing_epoch_and_waits_for_admitted_work() {
        let gates = Gates::default();
        let gate = gates.get(7);
        let epoch = gate.epoch.load_full();
        let active = gate.lock.clone().read_owned().await;
        let pause = gates.pause(7);
        tokio::pin!(pause);
        assert!(pause.as_mut().now_or_never().is_none());
        assert!(epoch.is_cancelled());
        drop(active);
        let paused = pause.await;
        let next = gate.lock.clone().read_owned();
        tokio::pin!(next);
        assert!(next.as_mut().now_or_never().is_none());
        drop(paused);
        let _next = next.await;
        assert!(!gate.epoch.load().is_cancelled());
        assert!(epoch.is_cancelled());
    }

    #[tokio::test]
    async fn changing_one_org_does_not_cancel_or_lock_another() {
        let gates = Gates::default();
        let other = gates.get(8);
        let _paused = gates.pause(7).await;
        assert!(!other.epoch.load().is_cancelled());
        assert!(other.lock.clone().read_owned().now_or_never().is_some());
    }
}
