//! Agent state history: the effective agent state (active / idle / blocked /
//! halted / frozen), its precedence, and the compact desk system row each
//! change leaves in the agent's transcript ("Idle · was active 12m").
//!
//! The precedence mirrors the desk's own state badges
//! (`deriveAgentVisualState` in the renderer): a durable halt wins over a
//! usage freeze, which wins over a running turn, which wins over the
//! agent's self-reported status; what is left is idle. "Blocked" is the
//! one self-reported state (orgtree_status); the rest are measured by the
//! engine. Pure logic lives here; the actor owns the tracker and is the
//! only writer of the rows (it owns the conversation's sequence).

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    Active,
    Idle,
    Blocked,
    Halted,
    Frozen,
}

#[logged]
impl AgentState {
    /// the stored word (`state` / `prev_state` in the row)
    #[nolog]
    pub fn as_str(self) -> &'static str {
        todo!()
    }

    /// the word the row opens with
    #[nolog]
    pub fn label(self) -> &'static str {
        todo!()
    }

    #[nolog]
    pub fn parse(s: &str) -> Option<Self> {
        todo!()
    }
}

/// The facts the effective state is derived from, as the agents row and
/// the actor know them at one instant.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub live: bool,
    pub halted: bool,
    pub frozen: Option<Value>,
    pub limit_locked: bool,
    /// a turn is running or admitted (the actor's turn, or inflight_at)
    pub active: bool,
    /// the agent's last self-reported status word, if any
    pub reported: Option<String>,
}

/// A freeze record the history counts as Frozen. The short automatic
/// retries — a pure connection freeze and a pure request-rate 429, the
/// records freeze release calls "neither a limit reset nor an unstick" —
/// are not a frozen span; every other record (limit, auth, balance) is,
/// and a limit-locked agent is frozen with or without a record.
#[logged]
pub fn is_frozen(rec: Option<&Value>, limit_locked: bool) -> bool {
    todo!()
}

/// The one effective state of an agent, by the desk badges' precedence.
/// A non-live agent has no state to record.
#[logged]
pub fn effective(facts: &Facts) -> Option<AgentState> {
    todo!()
}

/// One recorded change: entering `state` at `at`, ending `prev`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transition {
    pub state: AgentState,
    pub prev: Option<AgentState>,
    /// how long `prev` lasted, when its start is known
    pub prev_secs: Option<i64>,
    pub at: DateTime<Utc>,
}

/// The actor's memory of the state it last recorded and when that state
/// began (unknown when it began before recording did).
#[derive(Clone, Debug, Default)]
pub struct Tracker {
    pub state: Option<AgentState>,
    pub since: Option<DateTime<Utc>>,
}

#[logged]
impl Tracker {
    #[nolog]
    pub fn seeded(state: AgentState, since: Option<DateTime<Utc>>) -> Self {
        todo!()
    }

    /// Record `next` beginning at `at`; returns the transition to write,
    /// or None when the effective state did not change. A clock reading
    /// before the current state's start clamps its duration to zero
    /// rather than recording a negative span.
    #[nolog]
    pub fn transition(&mut self, next: AgentState, at: DateTime<Utc>) -> Option<Transition> {
        todo!()
    }
}

/// A span as the desk writes ages ("45s", "12m", "2h", "3d"): the same
/// buckets and rounding as the renderer's `fmtAge`, so a history row and
/// the badges above it never disagree about the words for a span.
#[logged]
pub fn fmt_duration(secs: i64) -> String {
    todo!()
}

/// The row's one line: the new state, then what it ended and for how
/// long, when that is known. "Idle · was active 12m".
#[logged]
pub fn line(t: &Transition) -> String {
    todo!()
}

/// The conversation row for one transition, in the existing transcript
/// system-row shape the desk renders as a compact line.
#[logged]
pub fn row(t: &Transition) -> Value {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn facts() -> Facts {
        Facts { live: true, ..Default::default() }
    }

    #[test]
    fn precedence_is_halt_frozen_active_blocked_idle() {
        let limit = json!({ "limit": true, "until": "2099-01-01T00:00:00Z" });
        let mut f = facts();
        assert_eq!(effective(&f), Some(AgentState::Idle));
        f.reported = Some("blocked".into());
        assert_eq!(effective(&f), Some(AgentState::Blocked));
        f.active = true;
        assert_eq!(effective(&f), Some(AgentState::Active), "a running turn outranks a blocked report");
        f.frozen = Some(limit.clone());
        assert_eq!(effective(&f), Some(AgentState::Frozen));
        f.halted = true;
        assert_eq!(effective(&f), Some(AgentState::Halted));
        // clearing facts one by one walks back down the same ladder
        f.halted = false;
        assert_eq!(effective(&f), Some(AgentState::Frozen), "unhalted but still frozen");
        f.frozen = None;
        f.active = false;
        assert_eq!(effective(&f), Some(AgentState::Blocked), "the blocked report still stands between turns");
        f.reported = Some("working".into());
        assert_eq!(effective(&f), Some(AgentState::Idle), "working is not one of the five states");
        f.reported = Some("idle".into());
        assert_eq!(effective(&f), Some(AgentState::Idle));
    }

    #[test]
    fn non_live_agents_have_no_state_to_record() {
        let mut f = facts();
        f.live = false;
        f.active = true;
        assert_eq!(effective(&f), None);
    }

    #[test]
    fn pure_retries_are_not_frozen_spans() {
        assert!(!is_frozen(None, false));
        assert!(is_frozen(None, true), "limit-locked is frozen even with no record");
        assert!(!is_frozen(Some(&json!({ "connection": true })), false));
        assert!(!is_frozen(Some(&json!({ "cause": "rate_limit" })), false));
        assert!(is_frozen(Some(&json!({ "connection": true, "limit": true })), false),
            "a record carrying both flags is a limit freeze, as the badges read it");
        assert!(is_frozen(Some(&json!({ "cause": "rate_limit", "limit": true })), false));
        assert!(is_frozen(Some(&json!({ "limit": true })), false));
        assert!(is_frozen(Some(&json!({ "cause": "auth" })), false));
        assert!(is_frozen(Some(&json!({ "cause": "balance" })), false));
        assert!(is_frozen(Some(&json!({})), false), "an unshaped record is still a freeze");
    }

    #[test]
    fn durations_read_like_the_desk_ages() {
        assert_eq!(fmt_duration(0), "0s");
        assert_eq!(fmt_duration(45), "45s");
        assert_eq!(fmt_duration(89), "89s");
        assert_eq!(fmt_duration(90), "2m");
        assert_eq!(fmt_duration(12 * 60), "12m");
        assert_eq!(fmt_duration(89 * 60), "89m");
        assert_eq!(fmt_duration(90 * 60), "2h");
        assert_eq!(fmt_duration(35 * 3600), "35h");
        assert_eq!(fmt_duration(36 * 3600), "2d");
        assert_eq!(fmt_duration(13 * 86400), "13d");
        assert_eq!(fmt_duration(14 * 86400), "2w");
        assert_eq!(fmt_duration(60 * 86400), "2mo");
        assert_eq!(fmt_duration(800 * 86400), "2y");
        assert_eq!(fmt_duration(-5), "0s", "a clamped span never reads negative");
    }

    #[test]
    fn tracker_records_each_change_once_with_the_ended_span() {
        let t0 = at("2026-11-01T10:00:00Z");
        let t1 = at("2026-11-01T10:12:00Z");
        let t2 = at("2026-11-01T12:12:00Z");
        let mut tr = Tracker::seeded(AgentState::Idle, Some(t0));
        assert_eq!(tr.transition(AgentState::Idle, t1), None, "no change, no row");
        let first = tr.transition(AgentState::Active, t1).unwrap();
        assert_eq!(first, Transition { state: AgentState::Active, prev: Some(AgentState::Idle), prev_secs: Some(720), at: t1 });
        assert_eq!(line(&first), "Active · was idle 12m");
        assert_eq!(tr.transition(AgentState::Active, t2), None, "re-notifying the same state records nothing");
        let second = tr.transition(AgentState::Idle, t2).unwrap();
        assert_eq!(second.prev_secs, Some(7200));
        assert_eq!(line(&second), "Idle · was active 2h");
    }

    #[test]
    fn unknown_beginnings_leave_the_span_out() {
        let t1 = at("2026-11-01T10:12:00Z");
        // the state at seeding began before recording did: its length is unknown
        let mut tr = Tracker::seeded(AgentState::Frozen, None);
        let first = tr.transition(AgentState::Idle, t1).unwrap();
        assert_eq!(first.prev, Some(AgentState::Frozen));
        assert_eq!(first.prev_secs, None);
        assert_eq!(line(&first), "Idle · was frozen");
        // nothing recorded before at all: the row names only the new state
        let mut fresh = Tracker::default();
        let first = fresh.transition(AgentState::Active, t1).unwrap();
        assert_eq!(first.prev, None);
        assert_eq!(line(&first), "Active");
        // a backwards clock clamps instead of going negative
        let mut clamped = Tracker::seeded(AgentState::Idle, Some(t1));
        let back = clamped.transition(AgentState::Halted, at("2026-11-01T10:00:00Z")).unwrap();
        assert_eq!(back.prev_secs, Some(0));
        assert_eq!(line(&back), "Halted · was idle 0s");
    }

    #[test]
    fn row_is_a_transcript_system_row() {
        let t = Transition {
            state: AgentState::Idle, prev: Some(AgentState::Active), prev_secs: Some(720),
            at: at("2026-11-01T10:12:00Z"),
        };
        let r = row(&t);
        assert_eq!(r["role"], "system");
        assert_eq!(r["kind"], "state");
        assert_eq!(r["state"], "idle");
        assert_eq!(r["prev_state"], "active");
        assert_eq!(r["prev_secs"], 720);
        assert_eq!(r["text"], "Idle · was active 12m");
        assert_eq!(r["ts"], "2026-11-01T10:12:00Z");
        assert!(r["tokens"].is_object(), "rows carry the not-counted token marker: {r}");
    }

    #[test]
    fn state_words_round_trip() {
        for s in [AgentState::Active, AgentState::Idle, AgentState::Blocked, AgentState::Halted, AgentState::Frozen] {
            assert_eq!(AgentState::parse(s.as_str()), Some(s));
        }
        assert_eq!(AgentState::Idle.label(), "Idle");
        assert_eq!(AgentState::Active.as_str(), "active");
        assert_eq!(AgentState::parse("working"), None);
    }
}
