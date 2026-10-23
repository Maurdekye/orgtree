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

/// Keep unrelated live observations and the separately refreshed model registry.
/// Not logged: the state contains account labels and identity metadata.
#[nolog]
pub(super) fn merge_status(current: &super::State, checked: &super::State, scope: Scope) -> super::State {
    let mut next = current.clone();
    if scope.includes(Scope::Claude) { next.claude = checked.claude.clone(); }
    if scope.includes(Scope::Codex) {
        next.codex = checked.codex.clone();
        next.codex_efforts = checked.codex_efforts.clone();
        next.codex_fast_modes = checked.codex_fast_modes.clone();
        next.codex_efforts_error = checked.codex_efforts_error.clone();
    }
    if scope.includes(Scope::Google) { next.agy = checked.agy.clone(); next.agy_signed_out = checked.agy_signed_out; }
    if scope.includes(Scope::Muse) {
        next.muse = checked.muse.clone(); next.muse_probe = checked.muse_probe.clone(); next.muse_error = checked.muse_error.clone();
    }
    if scope == Scope::All { next.opencode = checked.opencode.clone(); next.openrouter = checked.openrouter.clone(); next.probed = true; }
    next
}

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

    #[test]
    fn provider_status_refresh_preserves_unrelated_live_observations() {
        let mut current = super::super::State::default();
        current.agy.email = Some("new@example.invalid".into());
        current.agy_models = vec!["new-model".into()];
        current.muse.connected = true;
        current.probed = true;
        let mut checked = super::super::State::default();
        checked.codex.connected = true;
        let next = merge_status(&current, &checked, Scope::Codex);
        assert!(next.codex.connected);
        assert!(next.muse.connected);
        assert_eq!(next.agy.email, current.agy.email);
        assert_eq!(next.agy_models, current.agy_models);
        assert!(next.probed);
        let full = merge_status(&current, &checked, Scope::All);
        assert!(!full.muse.connected, "full discovery still replaces checked provider state");
        assert_eq!(full.agy_models, current.agy_models, "separate registry never regresses");
    }

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
