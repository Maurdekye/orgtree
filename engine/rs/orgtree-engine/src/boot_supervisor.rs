//! The boot host's placement decisions (docket
//! after-an-update-or-engine-restart-while-the-user; coordinator rulings
//! 2026-10-21 15:29Z and 16:27Z). The boot task's host runs in Session 0 and
//! stays there for the whole boot:
//!
//! - signed out (or no console sign-in, or no user-session task): it runs the
//!   engine itself, in Session 0, as before;
//! - while the operator is signed in at the console, it never starts a Session 0
//!   engine of its own: it runs the "Orgtree User Session Engine" task, which
//!   Windows starts in the operator's session, and waits while that engine holds
//!   the data root;
//! - at a confirmed sign-out it starts the Session 0 engine again;
//! - when a replacement fails after the old engine stopped, it makes the one
//!   rollback: its own Session 0 engine. A failed rollback stays stopped for
//!   that sign-in (the tray offers Start engine).
//!
//! `decide` is pure; `run` (Windows) is its I/O shell.
use crate::session_handover::Record;

/// How long a lost engine is left to the desktop's own recovery before the
/// boot host runs the task itself, and how long a delegation may take.
pub const BACKSTOP_MS: i64 = 120_000;
/// Consecutive empty WTS readings, 2 s apart, that make a sign-out.
pub const SIGNED_OUT_MISSES: u32 = 3;

/// The engine that served the root is gone while the operator stays signed in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lost {
    pub at: i64,
    /// Its generation, the key of the one recovery claim.
    pub generation: Option<String>,
    /// The boot host itself ended it (a hung engine): it recovers at once.
    pub ours: bool,
}

/// One reading of everything the boot host decides on.
#[derive(Clone, Debug, Default)]
pub struct Seen {
    /// The installer's stop request (newer than this host) or a console stop.
    pub stop: bool,
    /// Manual Quit or a stopped cohort for the current sign-in.
    pub blocked: bool,
    /// Another process holds the handover lock: an attempt runs.
    pub attempt: bool,
    /// Another engine tree holds the data root.
    pub root_held: bool,
    /// Debounced: Some(false) only after `SIGNED_OUT_MISSES` empty readings.
    pub signed_in: Option<bool>,
    /// The operator owns the active console session.
    pub console: bool,
    /// The user-session engine task is installed beside this host.
    pub task: bool,
    pub record: Option<Record>,
    /// The record's sign-ins overlap the current ones.
    pub epoch_matches: bool,
    pub lost: Option<Lost>,
    /// When this host last ran the task.
    pub delegated_at: Option<i64>,
    pub now: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// End the host (exit 0: the task does not restart it).
    Exit,
    /// Look again in 2 s.
    Wait,
    /// Run the user-session task; `claim` names the lost generation whose one
    /// recovery the host must claim first (None: nothing was lost).
    Delegate { claim: Option<String> },
    /// Run the engine here, in Session 0; `rollback` records it as the one rollback.
    Supervise { rollback: bool },
}

#[nolog]
pub fn decide(seen: &Seen) -> Step {
    use crate::session_handover::{Phase, Rollback};
    if seen.stop || seen.blocked { return Step::Exit; }
    if seen.attempt || seen.root_held { return Step::Wait; }
    if let Some(record) = &seen.record {
        if record.owes_rollback() { return Step::Supervise { rollback: true }; }
        if record.rollback == Some(Rollback::Failed) && seen.epoch_matches { return Step::Exit; }
    }
    // Unknown WTS starts the engine as before: no delegation on a guess.
    if seen.signed_in != Some(true) || !seen.console || !seen.task { return Step::Supervise { rollback: false }; }
    if let Some(at) = seen.delegated_at {
        let answered = seen.record.as_ref().is_some_and(|r| r.phase == Phase::Failed && r.at_ms >= at);
        if answered || seen.now.saturating_sub(at) >= BACKSTOP_MS { return Step::Supervise { rollback: true }; }
        return Step::Wait;
    }
    match &seen.lost {
        None => Step::Delegate { claim: None },
        Some(lost) if lost.ours => Step::Delegate { claim: lost.generation.clone() },
        Some(lost) if seen.now.saturating_sub(lost.at) >= 2 * BACKSTOP_MS => Step::Supervise { rollback: true },
        Some(lost) if seen.now.saturating_sub(lost.at) >= BACKSTOP_MS => Step::Delegate { claim: lost.generation.clone() },
        Some(_) => Step::Wait,
    }
}

/// Sign-out needs `SIGNED_OUT_MISSES` empty readings in a row; any sign-in
/// resets it, and an unreadable WTS keeps the last answer.
#[derive(Clone, Debug, Default)]
pub struct Debounce { misses: u32, last: Option<bool> }

#[nolog]
impl Debounce {
    pub fn note(&mut self, reading: Option<bool>) -> Option<bool> {
        match reading {
            Some(true) => { self.misses = 0; self.last = Some(true); }
            Some(false) => {
                self.misses = self.misses.saturating_add(1);
                if self.misses >= SIGNED_OUT_MISSES { self.last = Some(false); }
            }
            None => {}
        }
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_process::Identity;
    use crate::session_handover::{Phase, Rollback};

    fn signed_in() -> Seen {
        Seen { signed_in: Some(true), console: true, task: true, now: 1_000_000, ..Seen::default() }
    }
    fn record(phase: Phase, stopped_old: bool, at_ms: i64) -> Record {
        Record { id: "e".repeat(32), phase, by: "desktop".into(), owner: Identity { pid: 7, created: "70".into() },
            session: 1, admin: false, stopped_old, at_ms, epoch: vec![], error: None, rollback: None, reported: None }
    }

    #[test]
    fn stop_requests_and_quit_end_the_host_whatever_else_holds() {
        for s in [Seen { stop: true, ..signed_in() }, Seen { blocked: true, ..signed_in() },
                  Seen { stop: true, attempt: true, root_held: true, ..signed_in() }] {
            assert_eq!(decide(&s), Step::Exit);
        }
    }

    #[test]
    fn a_running_attempt_or_another_engine_is_waited_for() {
        assert_eq!(decide(&Seen { attempt: true, ..signed_in() }), Step::Wait);
        assert_eq!(decide(&Seen { root_held: true, ..signed_in() }), Step::Wait);
        // even signed out: the user-session engine still holds the root until Windows ends it
        assert_eq!(decide(&Seen { root_held: true, signed_in: Some(false), ..signed_in() }), Step::Wait);
    }

    #[test]
    fn signed_out_or_unknown_runs_the_engine_in_session_0() {
        assert_eq!(decide(&Seen { signed_in: Some(false), ..signed_in() }), Step::Supervise { rollback: false });
        assert_eq!(decide(&Seen { signed_in: None, ..signed_in() }), Step::Supervise { rollback: false },
            "an unreadable WTS starts the engine as before, never a delegation on a guess");
    }

    #[test]
    fn signed_in_elsewhere_or_without_the_task_keeps_decision_84() {
        assert_eq!(decide(&Seen { console: false, ..signed_in() }), Step::Supervise { rollback: false });
        assert_eq!(decide(&Seen { task: false, ..signed_in() }), Step::Supervise { rollback: false });
    }

    #[test]
    fn at_the_console_the_host_delegates_instead_of_starting_in_session_0() {
        assert_eq!(decide(&signed_in()), Step::Delegate { claim: None }, "an install or a fresh host");
        let ours = Lost { at: 999_990, generation: Some("g".repeat(32)), ours: true };
        assert_eq!(decide(&Seen { lost: Some(ours), ..signed_in() }), Step::Delegate { claim: Some("g".repeat(32)) },
            "a hung engine the host ended is its own to replace, at once");
    }

    #[test]
    fn a_lost_engine_is_left_to_the_desktop_for_the_backstop_then_claimed() {
        let lost = |at| Some(Lost { at, generation: Some("h".repeat(32)), ours: false });
        let now = signed_in().now;
        assert_eq!(decide(&Seen { lost: lost(now - BACKSTOP_MS + 1), ..signed_in() }), Step::Wait);
        assert_eq!(decide(&Seen { lost: lost(now - BACKSTOP_MS), ..signed_in() }), Step::Delegate { claim: Some("h".repeat(32)) });
        assert_eq!(decide(&Seen { lost: lost(now - 2 * BACKSTOP_MS), ..signed_in() }), Step::Supervise { rollback: true },
            "a claimed recovery that brought nothing ends in the one rollback");
    }

    #[test]
    fn a_delegation_that_brings_no_engine_ends_in_the_one_rollback() {
        let now = signed_in().now;
        assert_eq!(decide(&Seen { delegated_at: Some(now - 1000), ..signed_in() }), Step::Wait);
        assert_eq!(decide(&Seen { delegated_at: Some(now - BACKSTOP_MS), ..signed_in() }), Step::Supervise { rollback: true });
        let failed = record(Phase::Failed, false, now - 500);
        assert_eq!(decide(&Seen { delegated_at: Some(now - 1000), record: Some(failed), ..signed_in() }), Step::Supervise { rollback: true },
            "its launcher said it failed: no need to wait out the backstop");
        let older = record(Phase::Failed, false, now - 5000);
        assert_eq!(decide(&Seen { delegated_at: Some(now - 1000), record: Some(older), ..signed_in() }), Step::Wait,
            "a failure from before this delegation is not its answer");
    }

    #[test]
    fn a_replacement_that_failed_after_the_stop_gets_exactly_one_rollback() {
        let owed = record(Phase::Failed, true, 10);
        assert_eq!(decide(&Seen { record: Some(owed.clone()), ..signed_in() }), Step::Supervise { rollback: true });
        assert_eq!(decide(&Seen { record: Some(owed.clone()), signed_in: Some(false), ..signed_in() }), Step::Supervise { rollback: true });
        let mut done = owed.clone(); done.rollback = Some(Rollback::Done);
        assert_eq!(decide(&Seen { record: Some(done), ..signed_in() }), Step::Delegate { claim: None },
            "after the rollback the host behaves as usual");
        let mut failed = owed; failed.rollback = Some(Rollback::Failed);
        assert_eq!(decide(&Seen { record: Some(failed.clone()), epoch_matches: true, ..signed_in() }), Step::Exit,
            "a failed rollback stays stopped for this sign-in: Start engine is the user's");
        assert_eq!(decide(&Seen { record: Some(failed), epoch_matches: false, signed_in: Some(false), ..signed_in() }),
            Step::Supervise { rollback: false }, "a later sign-in or boot starts as usual");
    }

    #[test]
    fn sign_out_needs_three_misses_in_a_row() {
        let mut d = Debounce::default();
        assert_eq!(d.note(Some(true)), Some(true));
        assert_eq!(d.note(Some(false)), Some(true));
        assert_eq!(d.note(Some(false)), Some(true));
        assert_eq!(d.note(None), Some(true), "an unreadable WTS keeps the last answer and does not count");
        assert_eq!(d.note(Some(false)), Some(false), "the third miss");
        assert_eq!(d.note(Some(true)), Some(true));
        assert_eq!(d.note(Some(false)), Some(true), "a new sign-in starts the count again");
        let mut fresh = Debounce::default();
        assert_eq!(fresh.note(None), None);
        assert_eq!(fresh.note(Some(false)), None);
        assert_eq!(fresh.note(Some(false)), None);
        assert_eq!(fresh.note(Some(false)), Some(false));
    }
}
