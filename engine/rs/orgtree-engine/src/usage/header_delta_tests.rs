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
        let (mut full, mut reference, mut total, mut first) = (0, 0, 0, 0);
        let mut prior = String::new();
        let mut sequence = 0;
        for turn in 0..40 {
            if changing {
                let pin = engine.usage.cache.pin();
                let mut reading = pin.get(&codex_key(None)).unwrap().data.clone();
                reading["limits"][0]["percent"] = json!(12 + turn);
                engine.usage.put(&codex_key(None), &reading);
            }
            let (text, key) = turn_board(&engine, "openai", None, "sol", "synthetic-header-fixture");
            // Existing actor::usage_block's exact decision and reference wording.
            let output = if key == prior {
                reference += 1;
                format!("[PROVIDER USAGE #{sequence} — unchanged since #{sequence} earlier in this conversation; read the numbers there]")
            } else {
                full += 1; sequence += 1; prior = key;
                text.replacen("[PROVIDER USAGE", &format!("[PROVIDER USAGE #{sequence}"), 1)
            };
            if turn == 0 { first = output.len(); }
            total += output.len();
        }
        println!("HEADER_MEASURE {}",json!({"block":"usage","fixture":name,"turns":40,"first_bytes":first,"total_bytes":total,
            "full":full,"reference":reference,"inferred_tokens_bytes_div4":total as f64 / 4.0,
            "count_method":"existing actor key/reference decision with product turn_board formatter"}));
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
