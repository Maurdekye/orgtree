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

/// The boot task's host on Windows: `decide` in a loop, every 2 s while it
/// waits, around the existing one-engine host (`host::once`).
#[cfg(windows)]
#[nolog]
pub fn run() -> std::process::ExitCode {
    use std::process::ExitCode;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    use crate::{core_process, core_state, host, session_handover as handover, session_launch};
    host::install_stop_handler();
    let root = match host::data_root() { Ok(r) => r, Err(e) => { host::say(None, &e); return ExitCode::from(1); } };
    let _ = std::fs::create_dir_all(&root);
    // One boot host per data root, across sessions: a second one (the task
    // run again while this one waits) leaves at once.
    let Some(_single) = handover::exclusive(&root.join(SINGLE)) else {
        host::say(Some(&root), "another boot host already runs for this data root; leaving");
        return ExitCode::SUCCESS;
    };
    let started = core_state::now();
    let rig = core_state::rig_root(&root);
    let task = session_launch::task_installed(&root, session_launch::USER_SESSION_TASK, USER_TASK_RIG);
    let mut wts = core_process::Sessions::new();
    let mut debounce = Debounce::default();
    let mut lost: Option<Lost> = None;
    let mut delegated_at: Option<i64> = None;
    let mut served = false;
    let mut hangs: Vec<Instant> = Vec::new();
    let mut last: Option<Step> = None;
    // Whether the operator owns the console, from the last reading that saw a
    // sign-in: an empty or failed reading keeps it until the debounced
    // sign-out, so a WTS blip never reads as "signed in elsewhere".
    let mut console = false;
    loop {
        let active = core_state::sessions(&root, &mut wts);
        let signed_in = debounce.note(active.as_ref().map(|a| !a.is_empty()));
        if let Some(a) = active.as_ref().filter(|a| !a.is_empty()) {
            console = session_launch::console_session().is_some_and(|c| a.iter().any(|s| s.id == c));
        } else if signed_in == Some(false) { console = false; }
        let record = handover::read(&root);
        let attempt = handover::held(&root);
        let root_held = !host::root_released(&root, Duration::ZERO);
        let now = core_state::now();
        if root_held {
            served = true; lost = None; delegated_at = None;
        } else if served && !attempt {
            served = false;
            if lost.is_none() { lost = Some(Lost { at: now, generation: core_state::read(&root).map(|s| s.generation), ours: false }); }
        }
        let epoch_matches = record.as_ref().is_some_and(|r| active.as_ref().is_some_and(|a| r.epoch.iter().any(|s| a.contains(s))));
        let seen = Seen {
            stop: host::STOP.load(Ordering::SeqCst) || crate::install_stop::requested_since(started, rig),
            blocked: active.as_ref().is_some_and(|a| core_state::blocked(&root, a)),
            attempt, root_held, signed_in, console, task, record: record.clone(), epoch_matches,
            lost: lost.clone(), delegated_at, now,
        };
        let step = decide(&seen);
        if last.as_ref() != Some(&step) { host::say(Some(&root), &describe(&step, &seen)); last = Some(step.clone()); }
        match step {
            Step::Exit => return ExitCode::SUCCESS,
            Step::Wait => std::thread::sleep(Duration::from_secs(2)),
            Step::Delegate { claim } => {
                if let Some(generation) = &claim {
                    if !crate::core_recovery::claim_engine(&root, generation) {
                        // the desktop claimed this recovery: its outcome, or the
                        // backstop after it, decides (one owner per attempt)
                        host::say(Some(&root), "the desktop recovers the lost engine; waiting for its outcome");
                        delegated_at = Some(now);
                        continue;
                    }
                }
                session_launch::write_ask(&root, "boot-host", false);
                delegated_at = Some(now);
                if !session_launch::run_task(&root, session_launch::USER_SESSION_TASK, USER_TASK_RIG) {
                    failed_delegation(&root, active.as_deref().unwrap_or_default());
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            Step::Supervise { rollback } => {
                let id = if rollback { begin_rollback(&root, active.as_deref().unwrap_or_default()) } else { None };
                let mut became_ready = false;
                let code = host::once(None, &mut |_| { became_ready = true; });
                if let (Some(id), false) = (&id, became_ready) { end_rollback(&root, id); }
                served = false;
                if code == host::EXIT_ENGINE_HUNG {
                    let at = Instant::now();
                    hangs.retain(|t| at.duration_since(*t) < host::HUNG_RESTART_WINDOW);
                    hangs.push(at);
                    if hangs.len() > host::HUNG_RESTART_LIMIT {
                        host::say(Some(&root), &format!("{} hung engines within an hour; not restarting again", hangs.len()));
                        return ExitCode::from(code);
                    }
                    // the host ended it: its own to replace, at once
                    lost = Some(Lost { at: core_state::now(), generation: core_state::read(&root).map(|s| s.generation), ours: true });
                    continue;
                }
                if code == host::EXIT_ROOT_OWNED { continue; }
                // a start that failed: as before, the task's restart-on-failure retries
                if !became_ready && code != 0 { return ExitCode::from(code); }
                if host::STOP.load(Ordering::SeqCst) || crate::install_stop::requested_since(started, rig) { return ExitCode::SUCCESS; }
                // Handed over, or lost while the operator is at the console: the
                // loop waits, then recovers or falls back. Otherwise as before.
                let now_active = core_state::sessions(&root, &mut wts);
                let at_console = match (&now_active, session_launch::console_session()) {
                    (Some(a), Some(c)) => a.iter().any(|s| s.id == c), _ => false };
                if handover::held(&root) || (task && at_console) { served = true; continue; }
                return ExitCode::from(code);
            }
        }
    }
}

/// The boot host's single-instance lock file.
#[cfg(windows)]
const SINGLE: &str = "boot-host.lock";
/// The rig proof's stand-in for the user-session task (`rig-<name>.json`).
#[cfg(windows)]
const USER_TASK_RIG: &str = "user-session-task";

#[cfg(windows)]
#[nolog]
fn describe(step: &Step, seen: &Seen) -> String {
    match step {
        Step::Exit if seen.stop => "stop requested; the boot host ends".into(),
        Step::Exit if seen.blocked => "core session stopped; waiting for a new desktop launch".into(),
        Step::Exit => "the start in Session 0 failed after a failed move for this sign-in; the engine stays stopped until it is started again".into(),
        Step::Wait if seen.attempt => "waiting: a start in the signed-in session is running".into(),
        Step::Wait if seen.root_held => "waiting: another engine holds the data root".into(),
        Step::Wait if seen.delegated_at.is_some() => "waiting for the engine in the signed-in session".into(),
        Step::Wait => "waiting: the desktop may recover the lost engine first".into(),
        Step::Delegate { claim: None } => "the operator is signed in at the console: running the user-session engine task".into(),
        Step::Delegate { claim: Some(_) } => "the engine was lost while the operator is signed in: running the user-session engine task".into(),
        Step::Supervise { rollback: true } => "the move into the signed-in session failed: starting the engine in Session 0 (the one rollback)".into(),
        Step::Supervise { rollback: false } => "starting the engine in Session 0".into(),
    }
}

/// The task could not be run: recorded, so `decide` makes the one rollback at once.
#[cfg(windows)]
#[nolog]
fn failed_delegation(root: &std::path::Path, active: &[crate::core_process::Session]) {
    use crate::session_handover::{self as handover, why, Phase, Record};
    let Some(_lock) = handover::lock_within(root, std::time::Duration::from_secs(5)) else { return };
    let Some(owner) = crate::core_process::identity(std::process::id()) else { return };
    let record = Record { id: crate::util::random_hex(16), phase: Phase::Failed, by: "boot-host".into(), owner,
        session: 0, admin: false, stopped_old: false, at_ms: crate::core_state::now(), epoch: active.to_vec(),
        error: Some(why::TASK_FAILED.into()), rollback: None, reported: None };
    let _ = handover::write(root, &record);
    crate::host::say(Some(root), why::TASK_FAILED);
}

/// Mark the rollback before the engine starts, so its own restart notices
/// report it; `end_rollback` turns it into a failed one if it never got ready.
#[cfg(windows)]
#[nolog]
fn begin_rollback(root: &std::path::Path, active: &[crate::core_process::Session]) -> Option<String> {
    use crate::session_handover::{self as handover, why, Phase, Record, Rollback};
    let _lock = handover::lock_within(root, std::time::Duration::from_secs(10))?;
    let mut record = match handover::read(root) {
        Some(r) if r.phase == Phase::Failed && r.rollback.is_none() => r,
        _ => Record { id: crate::util::random_hex(16), phase: Phase::Failed, by: "boot-host".into(),
            owner: crate::core_process::identity(std::process::id())?, session: 0, admin: false, stopped_old: false,
            at_ms: crate::core_state::now(), epoch: active.to_vec(), error: Some(why::NO_ENGINE.into()), rollback: None, reported: None },
    };
    record.rollback = Some(Rollback::Done);
    record.reported = None;
    handover::write(root, &record).ok()?;
    Some(record.id)
}

#[cfg(windows)]
#[nolog]
fn end_rollback(root: &std::path::Path, id: &str) {
    use crate::session_handover::{self as handover, Rollback};
    let Some(_lock) = handover::lock_within(root, std::time::Duration::from_secs(10)) else { return };
    if let Some(mut record) = handover::read(root).filter(|r| r.id == id) {
        record.rollback = Some(Rollback::Failed);
        record.reported = None;
        let _ = handover::write(root, &record);
        crate::host::say(Some(root), "the engine did not start in Session 0 either; it stays stopped until it is started again");
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
