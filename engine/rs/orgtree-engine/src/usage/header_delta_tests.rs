use super::*;

fn synthetic_engine() -> Arc<Engine> {
    let engine = Engine::for_tests(PathBuf::from("synthetic-unused-header-measurement"));
    for key in [claude_key(None), codex_key(None), "agy".into()] {
        engine.usage.put(&key, &json!({"available":true,"email":"fixture@example.invalid","limits":[
            {"kind":"session","percent":12,"resets_at":iso(Utc::now() + chrono::Duration::hours(5))},
            {"kind":"weekly_all","percent":42,"resets_at":iso(Utc::now() + chrono::Duration::days(5))}]}));
    }
    engine
}

#[tokio::test]
async fn header_measurement_usage_baseline() {
    for (name, changing, drifting) in [("quiet",false,false),("one-window-progress",true,false),("rolling-reset-drift",false,true)] {
        let engine = synthetic_engine();
        let (mut full, mut delta, mut reference, mut total, mut first) = (0, 0, 0, 0, 0);
        let mut prior = Value::Null;
        let start = fixed_start();
        for turn in 0..40 {
            if changing {
                let pin = engine.usage.cache.pin();
                let mut reading = pin.get(&codex_key(None)).unwrap().data.clone();
                reading["limits"][0]["percent"] = json!(12 + turn);
                engine.usage.put(&codex_key(None), &reading);
            }
            if drifting {
                // a turn a minute: every rolling window's reset moves one minute on
                rolling(&engine, start + chrono::Duration::minutes(turn));
            }
            let snapshot = turn_snapshot(&engine, "openai", None, "sol", "synthetic-header-fixture", "session", &prior);
            let output = snapshot.text;
            if output.contains("unchanged since") { reference += 1; } else if output.contains("DELTA") { delta += 1; } else { full += 1; }
            prior = snapshot.record.unwrap();
            if turn == 0 { first = output.len(); }
            total += output.len();
        }
        println!("HEADER_MEASURE {}",json!({"block":"usage","fixture":name,"turns":40,"first_bytes":first,"total_bytes":total,
            "full":full,"delta":delta,"reference":reference,"inferred_tokens_bytes_div2":total as f64 / 2.0,
            "count_method":"product turn_snapshot; proposed record accepted after each fixture turn"}));
        assert_eq!(full, 1);
    }
}

#[tokio::test]
async fn header_usage_staleness_transition_is_material_but_age_ticks_are_not() {
    let engine = synthetic_engine();
    let (_, first) = turn_board(&engine,"openai",None,"sol","synthetic-header-fixture");
    let key = codex_key(None);
    let mut cached = engine.usage.cache.pin().get(&key).unwrap().clone();
    cached.at = Instant::now() - Duration::from_secs(60);
    engine.usage.cache.pin().insert(key.clone(), cached.clone());
    assert_eq!(turn_board(&engine,"openai",None,"sol","synthetic-header-fixture").1, first);
    cached.at = Instant::now() - Duration::from_secs(901);
    engine.usage.cache.pin().insert(key, cached);
    assert_ne!(turn_board(&engine,"openai",None,"sol","synthetic-header-fixture").1, first, "fresh-to-stale must be surfaced");
}

#[tokio::test]
async fn header_usage_reaching_100_percent_is_always_material() {
    let engine = synthetic_engine();
    let key = codex_key(None);
    let mut cached = engine.usage.cache.pin().get(&key).unwrap().clone();
    cached.data["limits"][0]["percent"] = json!(99);
    engine.usage.cache.pin().insert(key.clone(), cached.clone());
    let (_, before) = turn_board(&engine,"openai",None,"sol","synthetic-header-fixture");
    cached.data["limits"][0]["percent"] = json!(100);
    engine.usage.cache.pin().insert(key, cached);
    let (text, after) = turn_board(&engine,"openai",None,"sol","synthetic-header-fixture");
    assert_ne!(before, after);
    assert!(text.contains("100%") && text.contains("limited"));
}

#[tokio::test]
async fn header_usage_delta_isolated_window_retry_and_fresh_session() {
    let engine = synthetic_engine();
    let take = |sid: &str, prior: &Value| turn_snapshot(&engine,"openai",None,"sol","synthetic-header-fixture",sid,prior);
    let rejected = take("session", &Value::Null);
    let accepted = take("session", &Value::Null);
    assert!(!rejected.text.contains("DELTA") && !accepted.text.contains("DELTA"));
    let mut prior = accepted.record.unwrap();
    let quiet = take("session", &prior);
    assert_eq!(quiet.text.lines().count(), 1);
    assert!(quiet.text.contains("turn account openai/primary"));
    let key = codex_key(None);
    let mut reading = engine.usage.cache.pin().get(&key).unwrap().data.clone();
    reading["limits"][0]["percent"] = json!(100);
    engine.usage.put(&key, &reading);
    let delta = take("session", &prior);
    assert!(delta.text.contains("DELTA") && delta.text.contains("100%") && delta.text.contains("limited"));
    assert!(!delta.text.contains("claude/primary") && !delta.text.contains("| weekly |"));
    assert!(delta.text.contains("last full #1"));
    prior = delta.record.unwrap();
    assert!(take("session", &prior).text.contains("unchanged since #2"));
    let fresh = take("compacted-session", &prior);
    assert!(!fresh.text.contains("DELTA") && fresh.text.contains("claude/primary"));
    reading["limits"][0]["percent"] = Value::Null;
    engine.usage.put(&key, &reading);
    let unknown = take("session", &prior);
    assert!(unknown.text.contains("DELTA") && unknown.text.contains("unknown"), "known-to-unknown is material");
}

#[tokio::test]
async fn header_usage_secondary_weekly_stop_and_turn_account_are_explicit() {
    let mut engine = synthetic_engine();
    Arc::get_mut(&mut engine).unwrap().accounts = crate::accounts::Accounts::for_tests(vec![crate::accounts::AccountInfo {
        id: "openai-1".into(), provider: "openai".into(), kind: "oauth".into(), label: "Synthetic secondary".into(),
        email: None, tint_ordinal: 0, auth: "ready".into(), config_dir: Some("synthetic-secondary".into()), enabled: true,
        origin_org: None, marks: Default::default(), ord: 0, ambient: false, credential: 0, harness: None,
    }]);
    let key = codex_key(Some("synthetic-secondary"));
    let mut data = json!({"available":true,"limits":[{"kind":"weekly_all","percent":79}]});
    engine.usage.put(&key,&data);
    let first = turn_snapshot(&engine,"openai",None,"sol","synthetic-header-fixture","s",&Value::Null);
    data["limits"][0]["percent"] = json!(80);
    engine.usage.put(&key,&data);
    let changed = turn_snapshot(&engine,"openai",Some("openai-1"),"sol","synthetic-header-fixture","s",first.record.as_ref().unwrap());
    assert!(changed.text.contains("openai-1 weekly >=80%: ineligible by policy"));
    assert!(changed.text.contains("turn account openai-1") && changed.text.contains("DELTA"));
    assert!(!changed.text.contains("claude/primary"));
    data["limits"][0]["resets_at"] = json!(iso(Utc::now()-chrono::Duration::minutes(1)));
    engine.usage.put(&key,&data);
    let reset = turn_snapshot(&engine,"openai",Some("openai-1"),"sol","synthetic-header-fixture","s",changed.record.as_ref().unwrap());
    assert!(reset.text.contains("reset passed, awaiting reading"));
}

#[tokio::test]
async fn header_usage_reset_jitter_and_drift_are_not_new_resets_but_a_rollover_is() {
    let engine = synthetic_engine();
    let key = codex_key(None);
    let mut data = engine.usage.cache.pin().get(&key).unwrap().data.clone();
    data["limits"][0]["resets_at"] = json!("2030-01-01T04:59:59.950Z");
    engine.usage.put(&key,&data);
    let first = turn_snapshot(&engine,"openai",None,"sol","synthetic-header-fixture","s",&Value::Null);
    let prior = first.record.as_ref().unwrap();
    for (reset, why) in [("2030-01-01T05:00:00.050Z", "subsecond deadline jitter"),
                         ("2030-01-01T06:00:00Z", "an hour of drift inside a five-hour window")] {
        data["limits"][0]["resets_at"] = json!(reset);
        engine.usage.put(&key,&data);
        let unchanged = turn_snapshot(&engine,"openai",None,"sol","synthetic-header-fixture","s",prior);
        assert_eq!(unchanged.text.lines().count(), 1, "{why} is not a new reset: {}", unchanged.text);
    }
    // the session window rolled over: its reset moved on by the window's length
    data["limits"][0]["resets_at"] = json!("2030-01-01T10:00:00Z");
    engine.usage.put(&key,&data);
    let rolled = turn_snapshot(&engine,"openai",None,"sol","synthetic-header-fixture","s",prior);
    assert!(rolled.text.contains("DELTA") && rolled.text.contains("2030-01-01T10:00:00"), "{}", rolled.text);
}

/// A fixed clock: 05:00Z is on the five-hour grid, so a five-hour reset at
/// start + 5 h sits mid-bucket and two hours of drift cannot cross into the next.
fn fixed_start() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2030-01-01T05:00:00Z").unwrap().with_timezone(&Utc)
}

/// Rolling windows as measured 2026-10-27 (google/primary Five Hour and Weekly,
/// openai-1 5 h and 7 d): each reset is a fixed span after `now`, so it moves
/// forward every minute while the used percent stays put.
fn rolling(engine: &Engine, now: DateTime<Utc>) {
    for key in [codex_key(None), "agy".into()] {
        let mut reading = engine.usage.cache.pin().get(&key).unwrap().data.clone();
        reading["limits"][0]["resets_at"] = json!(iso(now + chrono::Duration::hours(5)));
        reading["limits"][1]["resets_at"] = json!(iso(now + chrono::Duration::days(7)));
        engine.usage.put(&key, &reading);
    }
}

#[tokio::test]
async fn header_usage_rolling_reset_drift_is_not_resent() {
    // USER 2026-10-27 m2a9b4d2d29ae: "we should update provider usage to only
    // carry changes in usage in the mail framing"
    let engine = synthetic_engine();
    let start = fixed_start();
    rolling(&engine, start);
    let mut prior = turn_snapshot(&engine,"google",None,"flash","synthetic-header-fixture","s",&Value::Null).record.unwrap();
    for minutes in [1, 2, 7, 30, 61, 119] {
        rolling(&engine, start + chrono::Duration::minutes(minutes));
        let turn = turn_snapshot(&engine,"google",None,"flash","synthetic-header-fixture","s",&prior);
        assert_eq!(turn.text.lines().count(), 1, "{minutes} min of rolling drift alone resent rows: {}", turn.text);
        assert!(turn.text.contains("unchanged since"));
        prior = turn.record.unwrap();
    }
}

#[tokio::test]
async fn header_usage_change_in_use_or_a_rollover_is_still_resent() {
    let engine = synthetic_engine();
    let start = fixed_start();
    rolling(&engine, start);
    let prior = turn_snapshot(&engine,"google",None,"flash","synthetic-header-fixture","s",&Value::Null).record.unwrap();
    let mut reading = engine.usage.cache.pin().get("agy").unwrap().data.clone();
    reading["limits"][0]["percent"] = json!(17);
    engine.usage.put("agy", &reading);
    let used = turn_snapshot(&engine,"google",None,"flash","synthetic-header-fixture","s",&prior);
    assert!(used.text.contains("DELTA") && used.text.contains("17%"), "a used-percent step is material: {}", used.text);
    assert!(!used.text.contains("openai/primary"), "only the changed row: {}", used.text);
    reading["limits"][0]["percent"] = json!(12);
    reading["limits"][1]["resets_at"] = json!(iso(start + chrono::Duration::days(14)));
    engine.usage.put("agy", &reading);
    let rolled = turn_snapshot(&engine,"google",None,"flash","synthetic-header-fixture","s",&prior);
    assert!(rolled.text.contains("DELTA") && rolled.text.contains("| weekly |"), "a weekly rollover is material: {}", rolled.text);
}
