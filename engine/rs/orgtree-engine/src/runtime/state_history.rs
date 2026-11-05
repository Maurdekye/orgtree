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
    /// every state, in the order the settings totals list them
    pub const ALL: [AgentState; 5] = [
        AgentState::Active, AgentState::Idle, AgentState::Blocked, AgentState::Halted, AgentState::Frozen,
    ];

    /// the stored word (`state` / `prev_state` in the row)
    #[nolog]
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Active => "active",
            AgentState::Idle => "idle",
            AgentState::Blocked => "blocked",
            AgentState::Halted => "halted",
            AgentState::Frozen => "frozen",
        }
    }

    /// the word the row opens with
    #[nolog]
    pub fn label(self) -> &'static str {
        match self {
            AgentState::Active => "Active",
            AgentState::Idle => "Idle",
            AgentState::Blocked => "Blocked",
            AgentState::Halted => "Halted",
            AgentState::Frozen => "Frozen",
        }
    }

    #[nolog]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "active" => Some(AgentState::Active),
            "idle" => Some(AgentState::Idle),
            "blocked" => Some(AgentState::Blocked),
            "halted" => Some(AgentState::Halted),
            "frozen" => Some(AgentState::Frozen),
            _ => None,
        }
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
    if limit_locked {
        return true;
    }
    let Some(rec) = rec.filter(|r| !r.is_null()) else { return false };
    let limit = rec["limit"].as_bool().unwrap_or(false);
    if rec["connection"].as_bool().unwrap_or(false) && !limit {
        return false;
    }
    if rec["cause"].as_str() == Some("rate_limit") && !limit {
        return false;
    }
    true
}

/// The one effective state of an agent, by the desk badges' precedence.
/// A non-live agent has no state to record.
#[logged]
pub fn effective(facts: &Facts) -> Option<AgentState> {
    if !facts.live {
        return None;
    }
    if facts.halted {
        return Some(AgentState::Halted);
    }
    if is_frozen(facts.frozen.as_ref(), facts.limit_locked) {
        return Some(AgentState::Frozen);
    }
    if facts.active {
        return Some(AgentState::Active);
    }
    if facts.reported.as_deref() == Some("blocked") {
        return Some(AgentState::Blocked);
    }
    Some(AgentState::Idle)
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
        Tracker { state: Some(state), since }
    }

    /// Record `next` beginning at `at`; returns the transition to write,
    /// or None when the effective state did not change. A clock reading
    /// before the current state's start clamps its duration to zero
    /// rather than recording a negative span.
    #[nolog]
    pub fn transition(&mut self, next: AgentState, at: DateTime<Utc>) -> Option<Transition> {
        if self.state == Some(next) {
            return None;
        }
        let t = Transition {
            state: next,
            prev: self.state,
            prev_secs: self.state.zip(self.since).map(|(_, since)| (at - since).num_seconds().max(0)),
            at,
        };
        self.state = Some(next);
        self.since = Some(at);
        Some(t)
    }
}

/// A span as the desk writes ages ("45s", "12m", "2h", "3d"): the same
/// buckets and rounding as the renderer's `fmtAge`, so a history row and
/// the badges above it never disagree about the words for a span.
#[logged]
pub fn fmt_duration(secs: i64) -> String {
    let s = secs.max(0) as f64;
    let n = |v: f64, unit: &str| format!("{}{unit}", v.round() as i64);
    if s < 90.0 {
        return n(s, "s");
    }
    if s < 90.0 * 60.0 {
        return n(s / 60.0, "m");
    }
    if s < 36.0 * 3600.0 {
        return n(s / 3600.0, "h");
    }
    let days = s / 86400.0;
    if days < 14.0 {
        return n(days, "d");
    }
    if days < 56.0 {
        return n(days / 7.0, "w");
    }
    let months = days / 30.4375;
    if months < 18.0 { n(months, "mo") } else { n(days / 365.25, "y") }
}

/// The row's one line: the new state, then what it ended and for how
/// long, when that is known. "Idle · was active 12m".
#[logged]
pub fn line(t: &Transition) -> String {
    match (t.prev, t.prev_secs) {
        (Some(prev), Some(secs)) => format!("{} · was {} {}", t.state.label(), prev.as_str(), fmt_duration(secs)),
        (Some(prev), None) => format!("{} · was {}", t.state.label(), prev.as_str()),
        (None, _) => t.state.label().to_string(),
    }
}

/// The conversation row for one transition, in the existing transcript
/// system-row shape the desk renders as a compact line.
#[logged]
pub fn row(t: &Transition) -> Value {
    json!({ "role": "system", "kind": "state", "ts": crate::util::iso(t.at),
            "state": t.state.as_str(), "prev_state": t.prev.map(AgentState::as_str),
            "prev_secs": t.prev_secs, "text": line(t),
            "tokens": crate::runtime::token_counts::not_counted(crate::runtime::token_counts::NOT_SENT) })
}

/// One recorded state row, read back: the state entered and its start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub state: AgentState,
    pub at: DateTime<Utc>,
}

/// One span of an agent's state history: `state` from `start` until `end`
/// (None = still the current state), `secs` long (an open span measures to
/// the reading instant).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub state: AgentState,
    pub start: DateTime<Utc>,
    pub end: Option<DateTime<Utc>>,
    pub secs: i64,
}

/// Spans from state marks given NEWEST FIRST. Each mark's span ends where
/// the next newer mark begins; the newest mark's span ends at `newest_end`
/// (None while it is the agent's current state, so it reads "now").
#[logged]
pub fn spans(marks: &[Mark], newest_end: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Vec<Span> {
    let mut end = newest_end;
    marks
        .iter()
        .map(|m| {
            let span = Span { state: m.state, start: m.at, end, secs: (end.unwrap_or(now) - m.at).num_seconds().max(0) };
            end = Some(m.at);
            span
        })
        .collect()
}

/// Seconds spent in each state (indexed like `AgentState::ALL`) inside the
/// `window_secs` ending at `now`, from marks NEWEST FIRST that reach back
/// to at least the window's start (plus the one mark before it). Time
/// before the first recorded mark is unknown and counts for no state.
#[logged]
pub fn totals(marks: &[Mark], now: DateTime<Utc>, window_secs: i64) -> [i64; 5] {
    let from = now - chrono::Duration::seconds(window_secs);
    let mut out = [0i64; 5];
    for span in spans(marks, None, now) {
        let start = span.start.max(from);
        let end = span.end.unwrap_or(now).min(now);
        if end > start {
            let i = AgentState::ALL.iter().position(|s| *s == span.state).unwrap_or(0);
            out[i] += (end - start).num_seconds();
        }
    }
    out
}

/// One bounded read of an agent's state rows, newest first, from the partial
/// index `convo_state_rows` (migration 0082): never a scan of the transcript.
/// `upto` includes the row with that seq.
#[logged]
pub async fn state_marks(client: &tokio_postgres::Client, agent_id: i64, upto: Option<i64>, limit: i64)
    -> anyhow::Result<Vec<(i64, Mark)>> {
    let rows = client
        .query(
            "SELECT seq, body->>'state', coalesce(body->>'ts', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))
               FROM ot.convo WHERE agent_id = $1 AND body->>'kind' = 'state' AND ($2::bigint IS NULL OR seq <= $2)
              ORDER BY seq DESC LIMIT $3",
            &[&agent_id, &upto, &limit],
        )
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let state = r.get::<_, Option<String>>(1).and_then(|s| AgentState::parse(&s))?;
            let at = r.get::<_, Option<String>>(2).and_then(|t| crate::util::parse_ts(&t))?;
            Some((r.get::<_, i64>(0), Mark { state, at }))
        })
        .collect())
}

/// The page's spans and cursor from the rows read (`limit + 1`, plus the neighbour row when a cursor was given), newest
/// first. With a cursor the first row is the neighbour the page below ends at; one row past `limit` means more history.
#[logged]
pub fn assemble(mut rows: Vec<(i64, Mark)>, has_cursor: bool, limit: i64, now: DateTime<Utc>) -> (Vec<Span>, Option<String>) {
    let newest_end = if has_cursor && !rows.is_empty() { Some(rows.remove(0).1.at) } else { None };
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit.max(0) as usize);
    let next_cursor = if has_more { rows.last().map(|(seq, _)| seq.to_string()) } else { None };
    let marks: Vec<_> = rows.iter().map(|(_, m)| *m).collect();
    (spans(&marks, newest_end, now), next_cursor)
}

/// One page of an agent's state history, newest first: its spans, the cursor
/// of the page below (None on the last page) and, on the FIRST page only, the
/// seconds per state over the last 24 hours and 7 days (`[h24, d7]`, indexed
/// like `AgentState::ALL`). Shared by the node-settings Activity tab's HTTP
/// read and `orgtree_state_inspect activity=true`, so the two never diverge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryPage {
    pub spans: Vec<Span>,
    pub next_cursor: Option<String>,
    pub totals: Option<[[i64; 5]; 2]>,
}

/// Read one page: `before` is the previous page's cursor (the seq of the
/// oldest row it showed), `limit` the page size. Every row read is one of the
/// agent's own `kind = "state"` rows, so the read never grows with inactive
/// history; the first page's totals read at most 25 pages of 200 rows back to
/// the 7 day cut. `now` is the one instant every computation uses.
#[logged]
pub async fn history_page(client: &tokio_postgres::Client, agent_id: i64, before: Option<i64>, limit: i64, now: DateTime<Utc>)
    -> anyhow::Result<HistoryPage> {
    let rows = state_marks(client, agent_id, before, limit + 1 + before.is_some() as i64).await?;
    let (spans, next_cursor) = assemble(rows, before.is_some(), limit, now);
    let totals = if before.is_none() {
        // newest rows back to the 7 day cut (plus the one row before it), in bounded pages
        let cut = now - chrono::Duration::days(7);
        let (mut all, mut upto) = (Vec::new(), None);
        'pages: for _ in 0..25 {
            let page = state_marks(client, agent_id, upto, 200).await?;
            let Some(last_seq) = page.last().map(|(seq, _)| *seq) else { break };
            let full = page.len() == 200;
            for (_, m) in page {
                all.push(m);
                if m.at < cut { break 'pages; }
            }
            if !full { break; }
            upto = Some(last_seq - 1);
        }
        Some([totals(&all, now, 86_400), totals(&all, now, 7 * 86_400)])
    } else { None };
    Ok(HistoryPage { spans, next_cursor, totals })
}

fn totals_map(t: [i64; 5], per: impl Fn(i64) -> Value) -> Value {
    let mut o = serde_json::Map::new();
    for (s, secs) in AgentState::ALL.iter().zip(t) { o.insert(s.as_str().into(), per(secs)); }
    Value::Object(o)
}

#[logged]
impl HistoryPage {
    /// The node-settings Activity tab's JSON (`GET .../nodes/{nid}/states`):
    /// byte-for-byte what that endpoint returned before the shared read.
    pub fn http_json(&self, node: &str) -> Value {
        let states: Vec<Value> = self.spans.iter()
            .map(|s| json!({ "state": s.state.as_str(), "start": crate::util::iso(s.start),
                             "end": s.end.map(crate::util::iso), "secs": s.secs }))
            .collect();
        let mut out = json!({ "node": node, "states": states, "next_cursor": self.next_cursor });
        if let Some([h24, d7]) = self.totals {
            out["totals"] = json!({ "h24": totals_map(h24, |secs| json!(secs)), "d7": totals_map(d7, |secs| json!(secs)) });
        }
        out
    }

    /// The agent tool's JSON (`orgtree_state_inspect activity=true`): spans
    /// carry a compact `dur` (the desk's age words) and `"end": "now"` for the
    /// open span; `totals` appear on the first page only (key absent after).
    pub fn tool_json(&self, as_of: DateTime<Utc>) -> Value {
        let spans: Vec<Value> = self.spans.iter()
            .map(|s| json!({ "state": s.state.as_str(), "start": crate::util::iso(s.start),
                             "end": s.end.map(|e| json!(crate::util::iso(e))).unwrap_or_else(|| json!("now")),
                             "secs": s.secs, "dur": fmt_duration(s.secs) }))
            .collect();
        let mut out = json!({ "as_of": crate::util::iso(as_of), "spans": spans, "next_cursor": self.next_cursor });
        if let Some([h24, d7]) = self.totals {
            let per = |secs: i64| json!({ "secs": secs, "dur": fmt_duration(secs) });
            out["totals"] = json!({ "h24": totals_map(h24, per), "d7": totals_map(d7, per) });
        }
        out
    }
}

#[cfg(test)]
mod activity_tests;

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
        assert_eq!(r["ts"], "2026-11-01T10:12:00.000Z");
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
    fn mark(state: AgentState, t: &str) -> Mark {
        Mark { state, at: at(t) }
    }

    #[test]
    fn spans_end_where_the_next_newer_mark_begins() {
        let marks = [
            mark(AgentState::Idle, "2026-11-01T12:00:00Z"),
            mark(AgentState::Active, "2026-11-01T11:48:00Z"),
            mark(AgentState::Frozen, "2026-11-01T10:00:00Z"),
        ];
        let now = at("2026-11-01T12:30:00Z");
        let out = spans(&marks, None, now);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], Span { state: AgentState::Idle, start: at("2026-11-01T12:00:00Z"), end: None, secs: 1800 },
            "the newest span is the current state: open, measured to now");
        assert_eq!(out[1], Span { state: AgentState::Active, start: at("2026-11-01T11:48:00Z"),
            end: Some(at("2026-11-01T12:00:00Z")), secs: 720 });
        assert_eq!(out[2].end, Some(at("2026-11-01T11:48:00Z")));
        assert_eq!(out[2].secs, 6480);
    }

    #[test]
    fn an_older_page_ends_its_newest_span_at_the_neighbour_mark() {
        let marks = [mark(AgentState::Active, "2026-11-01T11:48:00Z")];
        let out = spans(&marks, Some(at("2026-11-01T12:00:00Z")), at("2026-11-01T12:30:00Z"));
        assert_eq!(out[0].end, Some(at("2026-11-01T12:00:00Z")));
        assert_eq!(out[0].secs, 720, "a closed span never grows with the clock");
        assert!(spans(&[], None, at("2026-11-01T12:30:00Z")).is_empty());
    }

    #[test]
    fn a_backwards_clock_never_makes_a_negative_span() {
        let marks = [mark(AgentState::Idle, "2026-11-01T12:00:00Z"), mark(AgentState::Active, "2026-11-01T12:00:05Z")];
        let out = spans(&marks, None, at("2026-11-01T11:59:00Z"));
        assert_eq!(out[0].secs, 0);
        assert_eq!(out[1].secs, 0);
    }

    #[test]
    fn totals_sum_each_state_inside_the_window_only() {
        let now = at("2026-11-02T12:00:00Z");
        // newest first; the 24h window starts 2026-11-01T12:00
        let marks = [
            mark(AgentState::Idle, "2026-11-02T11:00:00Z"),    // 1h to now
            mark(AgentState::Active, "2026-11-02T10:00:00Z"),  // 1h
            mark(AgentState::Blocked, "2026-11-02T06:00:00Z"), // 4h
            mark(AgentState::Active, "2026-11-01T18:00:00Z"),  // 12h
            mark(AgentState::Frozen, "2026-11-01T06:00:00Z"),  // 6h of 12h falls inside the window
        ];
        let t = totals(&marks, now, 86_400);
        assert_eq!(t[0], 13 * 3600, "active: 1h + 12h");
        assert_eq!(t[1], 3600, "idle");
        assert_eq!(t[2], 4 * 3600, "blocked");
        assert_eq!(t[3], 0, "halted");
        assert_eq!(t[4], 6 * 3600, "frozen is clipped to the window start");
        let week = totals(&marks, now, 7 * 86_400);
        assert_eq!(week[4], 12 * 3600, "the same mark in full inside a 7 day window");
        assert_eq!(week.iter().sum::<i64>(), 30 * 3600,
            "unknown time before the first mark counts for nothing");
        assert_eq!(totals(&[], now, 86_400), [0; 5]);
    }

}
