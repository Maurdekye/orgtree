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
    for (name, changing) in [("quiet",false),("one-window-progress",true)] {
        let engine = synthetic_engine();
        let (mut full, mut delta, mut reference, mut total, mut first) = (0, 0, 0, 0, 0);
        let mut prior = Value::Null;
        for turn in 0..40 {
            if changing {
                let pin = engine.usage.cache.pin();
                let mut reading = pin.get(&codex_key(None)).unwrap().data.clone();
                reading["limits"][0]["percent"] = json!(12 + turn);
                engine.usage.put(&codex_key(None), &reading);
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
    assert!(take("session", &prior).text.contains("DELTA"), "known-to-unknown is material");
}
