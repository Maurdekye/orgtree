//! Serialize explicit and periodic discovery; reuse only overlapping/rapid checks.
use std::future::Future;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope { All, Claude, Codex, Google, Muse }

#[logged]
impl Scope {
    pub fn from_provider(provider: Option<&str>) -> Option<Self> {
        Some(match provider {
            None => Self::All,
            Some("claude") => Self::Claude,
            Some("codex" | "openai") => Self::Codex,
            Some("antigravity" | "google") => Self::Google,
            Some("muse") => Self::Muse,
            _ => return None,
        })
    }
    pub fn includes(self, other: Self) -> bool { self == Self::All || self == other }
}

#[derive(Default)]
pub struct Gate(Mutex<Option<(Instant, Scope)>>);

#[logged]
impl Gate {
    pub async fn run<F: Future<Output = ()>>(&self, scope: Scope, check: impl FnOnce() -> F) {
        let requested = Instant::now();
        let mut last = self.0.lock().await;
        if last.is_some_and(|(at, checked)| checked.includes(scope)
            && (at >= requested || at.elapsed() < Duration::from_secs(2))) { return; }
        check().await;
        *last = Some((Instant::now(), scope));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn provider_status_refresh_coalesces_and_expires_without_live_probes() {
        let gate = Gate::default();
        let calls = AtomicUsize::new(0);
        let check = || async { calls.fetch_add(1, Ordering::SeqCst); tokio::task::yield_now().await; };
        tokio::join!(gate.run(Scope::All, check), gate.run(Scope::Codex, check), gate.run(Scope::All, check));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        gate.run(Scope::All, check).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "rapid clicks reuse the completed check");
        *gate.0.lock().await = Some((Instant::now() - Duration::from_secs(3), Scope::All));
        gate.run(Scope::Codex, check).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "a new explicit check bypasses the five-minute cache");
        gate.run(Scope::All, check).await;
        assert_eq!(calls.load(Ordering::SeqCst), 3, "a scoped check cannot stand in for all providers");
    }
}
