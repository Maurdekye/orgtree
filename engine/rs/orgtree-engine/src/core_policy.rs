//! Decisions for the Windows core-process cohort. No process control or I/O.
//!
//! A process probe is tri-state: access/probe failures are not evidence of death.
//! The owner supplies monotonic elapsed milliseconds and authenticated transitions.

/// Missing-member allowance once control is ready and the operator is signed in
/// (implementation value, not a user-specified sign-in deadline).
pub const STARTUP_GRACE_MS: u64 = 120_000;
/// An explicitly requested replacement must finish; it cannot disable monitoring
/// permanently. The desktop's installer path may need to stop a busy engine.
pub const TRANSITION_MAX_MS: u64 = 180_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    Alive,
    Gone,
    Unknown,
    /// This role has not registered in this signed-in epoch yet.
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Keep,
    /// Normal sign-out is not a core fault. Clear interactive membership, leaving
    /// the pre-login/background engine and host running.
    SignedOut,
    Stop(&'static str),
    /// Recovery may be exhausted; healthy peers still remain alive.
    Unavailable(&'static str),
}

/// One owner updates this value. `stopped` is a latch; re-registration or a late
/// successful probe cannot revive the generation. A new explicit launch creates
/// a new policy only after the previous generation has stopped.
pub struct Policy {
    signed_in_since: Option<u64>,
    transition_until: Option<u64>,
    stopped: Option<&'static str>,
    boot_topology: bool,
}

#[logged]
impl Policy {
    pub fn new(boot_topology: bool) -> Self {
        Self { signed_in_since: None, transition_until: None, stopped: None, boot_topology }
    }

    /// The caller must authenticate the desktop and pin the old/new identities.
    /// Repeating a transition request never extends its deadline.
    pub fn transition(&mut self, now: u64) -> bool {
        if self.stopped.is_some() || self.transition_until.is_some() { return false; }
        self.transition_until = Some(now.saturating_add(TRANSITION_MAX_MS));
        true
    }

    pub fn transition_complete(&mut self) {
        self.transition_until = None;
    }

    pub fn stop(&mut self, reason: &'static str) -> Decision {
        Decision::Stop(*self.stopped.get_or_insert(reason))
    }

    /// Session state must refer to the engine operator, including a locked or
    /// disconnected session. None means inspection failed, not signed out.
    /// Engine/host death is handled by their surviving peers using the same latch.
    pub fn tick(&mut self, now: u64, signed_in: Option<bool>, desktop: Presence, helper: Presence) -> Decision {
        if let Some(reason) = self.stopped { return Decision::Stop(reason); }
        if signed_in == Some(false) {
            let was_signed_in = self.signed_in_since.take().is_some();
            self.transition_until = None;
            return if was_signed_in { Decision::SignedOut } else { Decision::Keep };
        }
        if signed_in != Some(true) { return Decision::Keep; }
        let since = *self.signed_in_since.get_or_insert(now);
        if let Some(until) = self.transition_until {
            if now < until { return Decision::Keep; }
            return Decision::Unavailable("intentional transition timed out");
        }
        if desktop == Presence::Gone { return Decision::Unavailable("desktop process exited"); }
        if self.boot_topology && helper == Presence::Gone { return Decision::Unavailable("sign-in helper exited"); }
        if now.saturating_sub(since) >= STARTUP_GRACE_MS {
            if desktop == Presence::Missing { return Decision::Unavailable("desktop did not start after sign-in"); }
            if self.boot_topology && helper == Presence::Missing { return Decision::Unavailable("sign-in helper did not start after sign-in"); }
        }
        Decision::Keep
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_component_is_reported_without_killing_or_latching_survivors() {
        let mut p = Policy::new(true);
        assert_eq!(p.tick(5, Some(true), Presence::Missing, Presence::Missing), Decision::Keep);
        assert_eq!(p.tick(STARTUP_GRACE_MS + 5, Some(true), Presence::Missing, Presence::Alive), Decision::Unavailable("desktop did not start after sign-in"));
        assert_eq!(p.tick(STARTUP_GRACE_MS + 6, Some(true), Presence::Alive, Presence::Alive), Decision::Keep);
        assert!(p.transition(STARTUP_GRACE_MS + 7));
    }

    #[test]
    fn sign_out_keeps_background_but_lock_and_probe_failure_do_not_fake_sign_out() {
        let mut p = Policy::new(true);
        p.tick(0, Some(true), Presence::Alive, Presence::Alive);
        assert_eq!(p.tick(1, None, Presence::Gone, Presence::Gone), Decision::Keep);
        assert_eq!(p.tick(2, Some(false), Presence::Gone, Presence::Gone), Decision::SignedOut);
        assert_eq!(p.tick(3, Some(false), Presence::Missing, Presence::Missing), Decision::Keep);
        assert_eq!(p.tick(200_000, Some(true), Presence::Missing, Presence::Missing), Decision::Keep);
        assert_eq!(p.tick(200_001, Some(true), Presence::Gone, Presence::Alive), Decision::Unavailable("desktop process exited"));
    }

    #[test]
    fn optional_boot_roles_are_not_required_for_manual_launch() {
        let mut p = Policy::new(false);
        p.tick(0, Some(true), Presence::Alive, Presence::Missing);
        assert_eq!(p.tick(200_000, Some(true), Presence::Alive, Presence::Missing), Decision::Keep);
        assert_eq!(p.tick(200_001, Some(true), Presence::Unknown, Presence::Gone), Decision::Keep);
    }

    #[test]
    fn transition_is_bounded_and_repeated_calls_do_not_extend_it() {
        let mut p = Policy::new(true);
        p.tick(0, Some(true), Presence::Alive, Presence::Alive);
        assert!(p.transition(10));
        assert!(!p.transition(100));
        assert_eq!(p.tick(TRANSITION_MAX_MS + 9, Some(true), Presence::Gone, Presence::Gone), Decision::Keep);
        assert_eq!(p.tick(TRANSITION_MAX_MS + 10, Some(true), Presence::Alive, Presence::Alive), Decision::Unavailable("intentional transition timed out"));
        let mut p = Policy::new(true);
        assert!(p.transition(1));
        p.transition_complete();
        assert_eq!(p.tick(2, Some(true), Presence::Gone, Presence::Alive), Decision::Unavailable("desktop process exited"));
    }
}
