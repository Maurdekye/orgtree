//! Admission for the native user-session launcher. This is separate from the
//! desktop's registered membership: an automatic sign-in need not open a window.
//!
//! Also the durable record of each attempt to start the engine in the
//! signed-in session (docket after-an-update-or-engine-restart-while-the-user):
//! `core-handover.json`, written only by whoever holds `core-handover.lock`
//! (the launcher, or the boot host for its own fallback). The lock is an
//! exclusive open of a file in the data root, so it serializes processes in
//! different Windows sessions and Windows releases it when its holder dies.
use crate::{core_process::{Identity, Session}, core_state::Snapshot};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action { Begin, Cancel, Complete }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub generation: String,
    pub who: Identity,
    pub action: Action,
}

#[nolog]
pub fn admit(state: &mut Snapshot, request: &Admission, now: i64, stopped: bool, native_peer: bool) -> bool {
    if stopped || !native_peer || state.generation != request.generation { return false; }
    match request.action {
        Action::Begin => {
            // Neither a repeat nor another owner can renew this allowance.
            if state.transition_until != 0 { return false; }
            state.transition_until = now + crate::core_policy::TRANSITION_MAX_MS as i64;
            state.transition_desktop = Some(request.who.clone());
            state.installing = true;
            state.completion_requested = false;
        }
        Action::Cancel | Action::Complete => {
            let remaining = state.transition_until.saturating_sub(now);
            if remaining <= 0 || remaining > crate::core_policy::TRANSITION_MAX_MS as i64
                || state.transition_desktop.as_ref() != Some(&request.who)
                || (matches!(request.action, Action::Complete) && state.host.as_ref() != Some(&request.who)) { return false; }
            state.transition_until = 0;
            state.transition_desktop = None;
            state.installing = false;
            state.completion_requested = false;
        }
    }
    true
}

// ------------------------------------------------------------ the attempt record

pub const RECORD: &str = "core-handover.json";
pub const LOCK: &str = "core-handover.lock";
const MAX: u64 = 16 * 1024;

/// How far an attempt got. `Failed` with `stopped_old` is the case that owes
/// the one rollback: the engine that ran was stopped and none replaced it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase { Begun, Stopping, Starting, Ready, Failed }

/// The one rollback after a failed replacement: the boot task's engine in Session 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Rollback { Done, Failed }

/// Fixed words for why an attempt failed. No path, process text or OS message
/// ever goes into the record: it is shown in restart notices and the app.
pub mod why {
    pub const NOT_CONSOLE: &str = "the requesting operator is not in this signed-in console session";
    pub const REFUSED: &str = "the running engine refused the handover";
    pub const NOT_STOPPED: &str = "the running engine did not stop in time";
    pub const NOT_READY: &str = "the engine in the signed-in session did not become ready";
    pub const LAUNCHER_LOST: &str = "the launcher in the signed-in session ended before its engine was ready";
    pub const TASK_FAILED: &str = "the user-session engine task did not start";
    pub const NO_ENGINE: &str = "no engine started in the signed-in session in time";
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// 32 hex characters, fresh per attempt.
    pub id: String,
    pub phase: Phase,
    /// Who asked: "sign-in", "desktop", "boot-host" or "one-off" (fixed words).
    pub by: String,
    /// The process that runs the attempt (and then hosts its engine).
    pub owner: Identity,
    /// The Windows session the engine was to run in; 0 for the boot host's own record.
    pub session: u32,
    pub admin: bool,
    /// The engine that served the root was stopped for this attempt.
    pub stopped_old: bool,
    pub at_ms: i64,
    /// The operator's sign-ins when the attempt began: a failed rollback keeps
    /// the engine stopped only while one of them lasts.
    #[serde(default)]
    pub epoch: Vec<Session>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub rollback: Option<Rollback>,
    /// The engine generation whose restart notices reported the outcome.
    #[serde(default)]
    pub reported: Option<String>,
}

impl Record {
    #[nolog]
    pub fn owes_rollback(&self) -> bool {
        self.phase == Phase::Failed && self.stopped_old && self.rollback.is_none()
    }
}

#[nolog]
pub fn read(root: &Path) -> Option<Record> {
    let mut bytes = Vec::new();
    std::fs::File::open(root.join(RECORD)).ok()?.take(MAX + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX { return None; }
    serde_json::from_slice(&bytes).ok()
}

/// Atomic replace. Call only while holding the lock.
#[nolog]
pub fn write(root: &Path, record: &Record) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(record)?;
    if bytes.len() as u64 > MAX { return Err(std::io::ErrorKind::InvalidData.into()); }
    crate::core_state::write_file(root, RECORD, &bytes)
}

/// Held for the whole attempt; dropping it releases the lock.
pub struct Lock(#[allow(dead_code)] std::fs::File);

/// The lock if nobody holds it now.
#[nolog]
pub fn try_lock(root: &Path) -> Option<Lock> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
        options.open(root.join(LOCK)).ok().map(Lock)
    }
    #[cfg(not(windows))]
    {
        let file = options.open(root.join(LOCK)).ok()?;
        file.try_lock().ok().map(|_| Lock(file))
    }
}

/// Whether someone else holds the lock now (a probe that takes and drops it).
#[nolog]
pub fn held(root: &Path) -> bool {
    root.join(LOCK).exists() && try_lock(root).is_none()
}

/// Wait up to `within` for the lock.
#[nolog]
pub fn lock_within(root: &Path, within: std::time::Duration) -> Option<Lock> {
    let until = std::time::Instant::now() + within;
    loop {
        if let Some(lock) = try_lock(root) { return Some(lock); }
        if std::time::Instant::now() >= until { return None; }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// What the next engine's restart notices add about the last attempt, once:
/// a failed move and its rollback. None when nothing went wrong.
#[nolog]
pub fn notice_line(record: &Record) -> Option<String> {
    let _ = record;
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Snapshot, Admission) {
        let who = Identity { pid: 20, created: "200".into() };
        (Snapshot { generation:"a".repeat(32), engine:Identity {pid:10,created:"100".into()},
            host:None, desktop:None, helper:None, sessions:vec![], transition_until:0,
            transition_desktop:None, installing:false, completion_requested:false },
         Admission {generation:"a".repeat(32),who,action:Action::Begin})
    }
    #[test] fn native_signin_needs_no_desktop_membership() {
        let (mut s,r)=fixture(); assert!(admit(&mut s,&r,1000,false,true));
        assert_eq!(s.transition_until,181000); assert_eq!(s.transition_desktop,Some(r.who));
        assert!(s.installing); assert!(s.desktop.is_none());
    }
    #[test] fn stale_generation_cannot_interrupt_replacement() {
        let (mut s,mut r)=fixture();r.generation="b".repeat(32);
        assert!(!admit(&mut s,&r,1000,false,true)); assert_eq!(s.transition_until,0);
    }
    #[test] fn stop_or_foreign_image_refuses_without_mutation() {
        for (stopped,peer) in [(true,true),(false,false)] {
            let (mut s,r)=fixture();assert!(!admit(&mut s,&r,1000,stopped,peer));assert_eq!(s.transition_until,0);
        }
    }
    #[test] fn duplicate_or_competing_request_never_extends_deadline() {
        let (mut s,r)=fixture();assert!(admit(&mut s,&r,1000,false,true));let until=s.transition_until;
        assert!(!admit(&mut s,&r,1100,false,true));let mut other=r.clone();other.who.pid+=1;
        assert!(!admit(&mut s,&other,1200,false,true));assert_eq!(s.transition_until,until);
    }
    #[test] fn existing_desktop_transition_is_not_stolen() {
        let (mut s,r)=fixture();s.transition_until=2000;s.transition_desktop=Some(s.engine.clone());
        assert!(!admit(&mut s,&r,1000,false,true));assert_eq!(s.transition_until,2000);
    }
    #[test] fn cancellation_only_clears_its_own_live_admission() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));r.action=Action::Cancel;
        let mut wrong=r.clone();wrong.who.created="reused".into();assert!(!admit(&mut s,&wrong,1100,false,true));
        assert!(admit(&mut s,&r,1100,false,true));assert_eq!(s.transition_until,0);assert!(!s.installing);
    }
    #[test] fn completion_requires_the_replacement_host() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));r.action=Action::Complete;
        assert!(!admit(&mut s,&r,1100,false,true));s.host=Some(r.who.clone());
        assert!(admit(&mut s,&r,1100,false,true));assert_eq!(s.transition_until,0);assert!(s.transition_desktop.is_none());
    }
    #[test] fn expired_admission_cannot_be_completed_or_extended() {
        let (mut s,mut r)=fixture();assert!(admit(&mut s,&r,1000,false,true));s.host=Some(r.who.clone());
        for action in [Action::Complete,Action::Begin,Action::Cancel] {r.action=action;assert!(!admit(&mut s,&r,181001,false,true));}
        assert_eq!(s.transition_until,181000);
    }
    #[cfg(windows)]
    #[test] fn stamped_same_native_image_is_required() {
        let mut who=crate::core_process::identity(std::process::id()).unwrap();
        assert!(crate::core_process::native_peer(&who));
        who.created="0".into();assert!(!crate::core_process::native_peer(&who));
        who.pid=u32::MAX;assert!(!crate::core_process::native_peer(&who));
    }

    fn record(phase: Phase) -> Record {
        Record { id: "c".repeat(32), phase, by: "desktop".into(), owner: Identity { pid: 30, created: "300".into() },
            session: 1, admin: false, stopped_old: true, at_ms: 5_000, epoch: vec![Session { id: 1, logon: "9".into() }],
            error: None, rollback: None, reported: None }
    }

    #[test] fn record_round_trips_and_names_the_rollback_it_owes() {
        let dir = std::env::temp_dir().join(format!("orgtree-handover-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut r = record(Phase::Failed);
        r.error = Some(why::NOT_READY.into());
        write(&dir, &r).unwrap();
        assert_eq!(read(&dir), Some(r.clone()));
        assert!(r.owes_rollback(), "the old engine stopped and nothing replaced it");
        r.rollback = Some(Rollback::Done);
        assert!(!r.owes_rollback(), "exactly one rollback");
        let mut early = record(Phase::Failed); early.stopped_old = false;
        assert!(!early.owes_rollback(), "a refusal before the stop left the old engine running");
        assert!(!record(Phase::Ready).owes_rollback());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn the_lock_has_one_holder_at_a_time() {
        let dir = std::env::temp_dir().join(format!("orgtree-handover-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!held(&dir), "no lock file yet");
        let first = try_lock(&dir).expect("free");
        assert!(try_lock(&dir).is_none(), "a second holder is refused");
        assert!(held(&dir));
        drop(first);
        assert!(!held(&dir), "released with its holder");
        assert!(lock_within(&dir, std::time::Duration::from_millis(10)).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn notices_report_a_failed_move_and_its_rollback_once() {
        let mut r = record(Phase::Failed);
        r.error = Some(why::NOT_READY.into());
        r.rollback = Some(Rollback::Done);
        let line = notice_line(&r).expect("a rollback is reported");
        assert!(line.contains("could not start the engine in the signed-in session"), "{line}");
        assert!(line.contains(why::NOT_READY) && line.contains("Session 0 instead"), "{line}");
        r.rollback = Some(Rollback::Failed);
        let line = notice_line(&r).expect("a failed rollback is reported");
        assert!(line.contains("did not start in Session 0 either"), "{line}");
        r.reported = Some("d".repeat(32));
        assert_eq!(notice_line(&r), None, "said once, by the engine that reported it");
        assert_eq!(notice_line(&record(Phase::Ready)), None, "a move that worked adds nothing");
        let mut untouched = record(Phase::Failed); untouched.stopped_old = false; untouched.error = Some(why::REFUSED.into());
        assert_eq!(notice_line(&untouched), None, "the old engine kept running: no restart happened");
    }
}
