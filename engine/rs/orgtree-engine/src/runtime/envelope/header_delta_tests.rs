use super::*;

fn fixture(reports: usize, small_report: bool) -> (Facts, DateTime<Utc>) {
    let now = crate::util::parse_ts("2030-01-01T00:00:00Z").unwrap();
    let rows = (1..=reports + 1).map(|id| Row {
        id: id as i64, name: if id == 1 { "coordinator".into() } else { format!("worker-{id:02}") },
        parent: (id > 1).then_some(1), tier: if id == 1 { "opus".into() } else { "sol".into() },
        state: "live".into(), halted: false, frozen: false,
        status: Some(json!({"status":"working","summary":format!("Implementing synthetic work item {id}"),"at":iso(now - chrono::Duration::minutes(5))})),
        inflight_at: None, last_turn: None,
    }).collect();
    (Facts { agent_id: if small_report { 2 } else { 1 }, my_name: if small_report { "worker-02".into() } else { "coordinator".into() },
        parent: small_report.then_some(1), vis: if small_report { "self".into() } else { "full".into() },
        seat: 2.0, grant: (reports * 4) as f64, hold: (reports * 2) as f64,
        sid: Some("synthetic-session".into()), prior: None, peer_policy: "Peers may message each other.".into(),
        superior: small_report.then(|| "coordinator".into()), user_audience: false, rows, ask: None }, now)
}

#[test]
fn header_measurement_org_baseline() {
    for (name, reports, small, busy_changes) in [("coordinator-quiet",32,false,false), ("coordinator-busy",32,false,true), ("small-report",1,true,false)] {
        let (mut facts, now) = fixture(reports, small);
        let mut live = HashMap::new();
        let (mut full, mut delta, mut reference, mut total, mut first) = (0, 0, 0, 0, 0);
        for turn in 0..40 {
            if busy_changes { live.insert(2, Live { busy: turn % 2 == 1, waiting: false }); }
            let output = render(&facts, &live, now + chrono::Duration::minutes(turn));
            let bytes = output.text.len();
            if turn == 0 { first = bytes; }
            total += bytes;
            if output.text.contains("unchanged since") { reference += 1; } else if output.text.contains("DELTA") { delta += 1; } else { full += 1; }
            facts.prior = output.record;
        }
        assert_eq!(full + delta + reference, 40);
        assert_eq!(full, 1, "no periodic full refresh");
        println!("HEADER_MEASURE {}", json!({"block":"org","fixture":name,"turns":40,"first_bytes":first,"total_bytes":total,
            "full":full,"delta":delta,"reference":reference,"inferred_tokens_bytes_div2":total as f64 / 2.0}));
    }
}

#[test]
fn header_org_unchanged_is_one_line() {
    let (mut facts, now) = fixture(32, false);
    facts.prior = render(&facts, &HashMap::new(), now).record;
    let output = render(&facts, &HashMap::new(), now + chrono::Duration::seconds(1));
    assert_eq!(output.text.lines().count(), 1, "all unchanged org facts should use one reference line");
    assert!(output.text.contains("unchanged since #1"));
}

#[test]
fn header_org_age_only_change_is_one_line() {
    let (mut facts, now) = fixture(32, false);
    facts.prior = render(&facts, &HashMap::new(), now).record;
    let output = render(&facts, &HashMap::new(), now + chrono::Duration::minutes(11));
    assert_eq!(output.text.lines().count(), 1, "age ticks do not resend the chart or guidance");
}

#[test]
fn header_org_status_change_sends_only_changed_agent() {
    let (mut facts, now) = fixture(32, false);
    facts.prior = render(&facts, &HashMap::new(), now).record;
    facts.rows[1].status = Some(json!({"status":"done","summary":"Synthetic completed change","at":iso(now)}));
    let output = render(&facts, &HashMap::new(), now);
    assert!(output.text.contains("DELTA"));
    assert!(output.text.contains("worker-02") && output.text.contains("Synthetic completed change"));
    assert!(!output.text.contains("worker-03"), "unmodified agents are not re-emitted");
}

#[test]
fn header_org_fresh_session_is_full_and_small_reports_get_references() {
    let (mut facts, now) = fixture(1, true);
    facts.prior = render(&facts, &HashMap::new(), now).record;
    let unchanged = render(&facts, &HashMap::new(), now);
    assert_eq!(unchanged.text.lines().count(), 1, "small reports also need snapshot reuse");
    facts.sid = Some("synthetic-compacted-session".into());
    let fresh = render(&facts, &HashMap::new(), now);
    assert!(!fresh.text.contains("DELTA") && !fresh.text.contains("unchanged since"));
    assert!(fresh.text.contains("Credits:") && fresh.text.contains("Your reports:"));
}

#[test]
fn header_org_relationship_credits_freeze_and_visibility_changes() {
    let (mut f, now) = fixture(3, false);
    let live = HashMap::new();
    f.prior = render(&f, &live, now).record;
    f.rows[1].parent = Some(3);
    f.rows[1].halted = true;
    f.rows[1].frozen = true;
    f.grant = 50.0;
    let moved = render(&f, &live, now);
    assert!(moved.text.contains("DELTA") && moved.text.contains("parent worker-03"));
    assert!(moved.text.contains("halted") && moved.text.contains("frozen") && moved.text.contains("grant 50"));
    f.prior = moved.record;
    f.rows.pop();
    let removed = render(&f, &live, now);
    assert!(removed.text.contains("Removed: worker-04"));
    f.prior = removed.record;
    f.vis = "self".into();
    let restricted = render(&f, &live, now);
    assert!(restricted.text.contains("Removed: worker-02"));
    f.prior = restricted.record;
    f.rows[1].status = Some(json!({"status":"done","summary":"hidden status must stay hidden"}));
    assert!(!render(&f, &live, now).text.contains("hidden status"));
}

#[test]
fn header_org_self_safety_and_policy_changes_without_age_refreshes() {
    let (mut f, now) = fixture(1, true);
    f.prior = render(&f, &HashMap::new(), now).record;
    f.rows[1].frozen = true;
    f.peer_policy = "Peers require an audience".into();
    let safety = render(&f, &HashMap::new(), now);
    assert!(safety.text.contains("frozen") && safety.text.contains("Peers require an audience"));
    f.prior = safety.record;
    let aged = render(&f, &HashMap::new(), now + chrono::Duration::days(1));
    assert_eq!(aged.text.lines().count(), 1);
    f.rows[1].status.as_mut().unwrap()["at"] = json!(iso(now));
    assert!(render(&f, &HashMap::new(), now).text.contains("DELTA"), "a new report is material even with the same summary");
}
