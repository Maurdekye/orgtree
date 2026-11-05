//! Red tests for "agents can read other agents' activity history" (spec rev 1.0,
//! @item:orgtree/agents-can-read-other-agents-activity-state-hist; USER 2026-11-05
//! maac5e83fa61e): the shared page, its two JSON shapes (the Activity tab's HTTP
//! read must stay byte-identical, AH10; the tool's, AH1/AH2/AH11) and its paging.
//! The database read itself (`history_page`) is proven on a real rig engine; these
//! pin everything that does not need a database.
use super::*;

fn at(s: &str) -> DateTime<Utc> { DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc) }
fn mark(state: AgentState, t: &str) -> Mark { Mark { state, at: at(t) } }

/// Five marks, NEWEST FIRST, the newest still open.
fn five() -> Vec<Mark> {
    vec![
        mark(AgentState::Idle, "2026-11-05T10:00:00Z"),
        mark(AgentState::Active, "2026-11-05T09:30:00Z"),
        mark(AgentState::Blocked, "2026-11-05T09:00:00Z"),
        mark(AgentState::Frozen, "2026-11-05T08:00:00Z"),
        mark(AgentState::Halted, "2026-11-05T07:00:00Z"),
    ]
}
const NOW: &str = "2026-11-05T10:05:12Z";

#[test]
fn ah1_tool_json_lists_spans_newest_first_with_now_for_the_open_one_and_compact_durations() {
    let now = at(NOW);
    let page = HistoryPage {
        spans: spans(&five(), None, now), next_cursor: None,
        totals: Some([totals(&five(), now, 86_400), totals(&five(), now, 7 * 86_400)]),
    };
    let v = page.tool_json(now);
    assert_eq!(v["as_of"], "2026-11-05T10:05:12.000Z");
    let s = v["spans"].as_array().unwrap();
    assert_eq!(s.len(), 5);
    assert_eq!(s[0]["state"], "idle"); assert_eq!(s[0]["end"], "now");
    assert_eq!(s[0]["secs"], 312); assert_eq!(s[0]["dur"], fmt_duration(312));
    assert_eq!(s[1]["state"], "active"); assert_eq!(s[1]["end"], "2026-11-05T10:00:00.000Z");
    assert_eq!(s[1]["dur"], fmt_duration(1800));
    assert_eq!(s[4]["state"], "halted");
    assert!(v["next_cursor"].is_null());
    for window in ["h24", "d7"] {
        let t = &v["totals"][window];
        for state in ["active", "idle", "blocked", "halted", "frozen"] {
            assert!(t[state]["secs"].is_i64() && t[state]["dur"].is_string(), "{window}.{state} carries secs and dur");
        }
    }
    assert_eq!(v["totals"]["h24"]["idle"]["secs"], 312);
    assert_eq!(v["totals"]["h24"]["active"]["dur"], fmt_duration(1800));
}

/// A fake store of `n` state rows, seq 1..=n, newest = highest seq, one hour apart,
/// read the way `state_marks` does: newest first, `upto` inclusive.
fn store(n: i64) -> Vec<(i64, Mark)> {
    let base = at("2026-11-01T00:00:00Z");
    (1..=n).rev().map(|seq| (seq, Mark {
        state: AgentState::ALL[(seq as usize) % 5], at: base + chrono::Duration::hours(seq),
    })).collect()
}
fn fetch(all: &[(i64, Mark)], upto: Option<i64>, limit: i64) -> Vec<(i64, Mark)> {
    all.iter().filter(|(seq, _)| upto.map_or(true, |u| *seq <= u)).take(limit as usize).cloned().collect()
}

#[test]
fn ah2_pages_by_cursor_have_no_gaps_or_overlaps_and_the_last_cursor_is_null() {
    let all = store(45);
    let now = at("2026-11-05T00:00:00Z");
    let mut got: Vec<Span> = Vec::new();
    let mut before: Option<i64> = None;
    let mut sizes = Vec::new();
    for _ in 0..6 {
        let rows = fetch(&all, before, 20 + 1 + before.is_some() as i64);
        let (page_spans, next) = assemble(rows, before.is_some(), 20, now);
        sizes.push(page_spans.len());
        if let (Some(last), Some(first)) = (got.last(), page_spans.first()) {
            assert_eq!(first.end, Some(last.start), "each page's newest end is the previous page's oldest start");
        }
        got.extend(page_spans);
        match next { Some(c) => before = Some(c.parse().unwrap()), None => break }
    }
    assert_eq!(sizes, vec![20, 20, 5]);
    assert_eq!(got.len(), 45);
    for w in got.windows(2) { assert_eq!(w[1].end, Some(w[0].start), "contiguous, newest first"); }
    assert!(got[0].end.is_none(), "only the newest span is open");
    let (_, last_next) = assemble(fetch(&all, before, 20 + 1 + 1), true, 20, now);
    assert!(last_next.is_none());
}

#[test]
fn ah2_totals_are_on_the_first_page_only_in_the_tool_json_and_the_key_is_absent_after() {
    let now = at(NOW);
    let later = HistoryPage { spans: spans(&five()[1..], Some(at("2026-11-05T10:00:00Z")), now), next_cursor: Some("7".into()), totals: None };
    let v = later.tool_json(now);
    assert!(v.get("totals").is_none(), "absent, not null");
    assert_eq!(v["next_cursor"], "7");
}

#[test]
fn ah11_no_state_rows_give_empty_spans_a_null_cursor_and_zero_totals() {
    let now = at(NOW);
    let page = HistoryPage { spans: vec![], next_cursor: None, totals: Some([[0; 5]; 2]) };
    let v = page.tool_json(now);
    assert_eq!(v["spans"], json!([]));
    assert!(v["next_cursor"].is_null());
    assert_eq!(v["totals"]["d7"]["frozen"], json!({"secs": 0, "dur": "0s"}));
    assert_eq!(v["totals"]["h24"]["active"], json!({"secs": 0, "dur": "0s"}));
    let (spans_out, next) = assemble(vec![], false, 20, now);
    assert!(spans_out.is_empty() && next.is_none());
}

#[test]
fn ah10_the_http_json_is_the_activity_tabs_shape_unchanged() {
    // the shape `GET .../nodes/{nid}/states` returned before the shared read (page 1 with totals, then page 2 without)
    let now = at(NOW);
    let first = HistoryPage {
        spans: spans(&five()[..2], None, now), next_cursor: Some("41".into()),
        totals: Some([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]),
    };
    assert_eq!(first.http_json("worker"), json!({
        "node": "worker",
        "states": [
            { "state": "idle", "start": "2026-11-05T10:00:00.000Z", "end": null, "secs": 312 },
            { "state": "active", "start": "2026-11-05T09:30:00.000Z", "end": "2026-11-05T10:00:00.000Z", "secs": 1800 },
        ],
        "next_cursor": "41",
        "totals": {
            "h24": { "active": 1, "idle": 2, "blocked": 3, "halted": 4, "frozen": 5 },
            "d7": { "active": 6, "idle": 7, "blocked": 8, "halted": 9, "frozen": 10 },
        },
    }));
    let second = HistoryPage { spans: spans(&five()[2..], Some(at("2026-11-05T09:30:00Z")), now), next_cursor: None, totals: None };
    let v = second.http_json("worker");
    assert!(v.get("totals").is_none());
    assert!(v["next_cursor"].is_null());
    assert_eq!(v["states"].as_array().unwrap().len(), 3);
    assert_eq!(serde_json::to_string(&first.http_json("worker")).unwrap().find("\"totals\"").is_some(), true);
}
