use super::*;

#[test]
fn lsrefresh_shared_context_fixtures_and_legacy_upgrade_plan() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("../../../../../tests/fixtures/langserver-context.json")).unwrap();
    for row in rows { assert_eq!(start_window(&row), row["expected"].as_i64().unwrap(), "{}", row["id"]); }
    let saved = json!({"models":{
        "wide":{"context":65536}, "variant":{"context":65536},
        "hand":{"context":70000}, "absent":{"context":65536}, "unknown":{"context":65536}
    }});
    let result = json!({"reachable":true,"models":[
        {"id":"wide","max_context":262144},
        {"id":"variant","configured_context":65536,"max_context":262144},
        {"id":"hand","max_context":262144}, {"id":"unknown"}, {"id":"new","max_context":262144}
    ]});
    assert_eq!(upgrades(&saved,&result),vec![("wide".to_string(),262144),("unknown".to_string(),1_000_000)]);
    assert!(upgrades(&saved,&json!({"reachable":false,"models":result["models"]})).is_empty());
}

#[test]
fn lsrefresh_atomic_guard_keeps_newer_context_and_deleted_or_changed_server() {
    let saved = json!({"address":"http://synthetic.invalid","preset":"ollama","base_path":"","models":{"m":{"context":65536}}});
    let expected = upgrade_guard("demo", &saved, "m");
    let mut doc = json!({"language_servers":{"servers":{"demo":saved}}});
    assert!(crate::settings::matches_expected(&doc,&expected));
    doc["language_servers"]["servers"]["demo"]["models"]["m"]["context"] = json!(70000);
    assert!(!crate::settings::matches_expected(&doc,&expected));
    doc["language_servers"]["servers"]["demo"] = Value::Null;
    assert!(!crate::settings::matches_expected(&doc,&expected));
    let mut changed = saved.clone(); changed["address"] = json!("http://changed.invalid");
    assert!(!same_endpoint(&saved,&changed));
    assert!(!same_endpoint(&saved,&Value::Null));
}

#[tokio::test(flavor = "current_thread")]
async fn lsrefresh_failure_keeps_cache_and_warns_once_without_secret() {
    let capture = crate::trace::LogCapture::start().await;
    let cache = ProbeCache::default();
    assert!(cache.record("demo",&json!({"reachable":true,"models":[{"id":"m"}]}),0));
    let previous = cache.get("demo");
    assert!(!cache.record("demo",&json!({"reachable":false,"error":"PRIVATE_KEY_CANARY","models":[]}),0));
    assert_eq!(cache.get("demo"),previous);
    let log = capture.finish().await;
    assert_eq!(log.lines().filter(|line| line.contains("model-list refresh failed")).count(),1);
    assert!(!log.contains("PRIVATE_KEY_CANARY"));
}

#[tokio::test]
async fn lsrefresh_background_pass_probes_enabled_only_and_caches_success() {
    let (address, task) = super::super::refresh_tests::mock_models(json!({"data":[{"id":"new","max_model_len":262144}]})).await;
    let mut engine = Engine::for_tests(std::env::temp_dir().join("lsrefresh-no-io"));
    Arc::get_mut(&mut engine).unwrap().settings = crate::settings::AppSettings::new(json!({
        "language_servers":{"servers":{
            "enabled":{"id":"enabled","preset":"vllm","address":address,"enabled":true,"models":{}},
            "disabled":{"id":"disabled","preset":"vllm","address":address,"enabled":false,"models":{}}
        }}
    }));
    refresh_enabled(&engine).await;
    task.abort(); let _ = task.await;
    assert_eq!(engine.langserver_probes.get("enabled").unwrap()["models"][0]["id"],"new");
    assert!(engine.langserver_probes.get("disabled").is_none());
    assert_eq!(server(&engine,"enabled").unwrap()["models"],json!({}));
}

#[test]
fn lsrefresh_add_context_validation_preserves_zero_and_refuses_invalid_explicit_sizes() {
    let mut models = Map::new();
    assert!(add_model("demo",&mut models,"zero",0,true).is_ok());
    assert!(models["zero"]["context"].is_null());
    assert!(add_model("demo",&mut models,"negative",-1,true).is_err());
    assert!(add_model("demo",&mut models,"huge",10_000_001,true).is_err());
    assert!(add_model("demo",&mut models,"max",10_000_000,true).is_ok());
}

#[tokio::test(flavor = "current_thread")]
async fn lsrefresh_empty_success_keeps_nonempty_cache_and_eviction_rejects_old_results() {
    let capture = crate::trace::LogCapture::start().await;
    let cache = ProbeCache::default();
    let good = json!({"reachable":true,"models":[{"id":"m"}]});
    assert!(cache.record("demo",&good,0));
    let previous = cache.get("demo");
    assert!(!cache.record("demo",&json!({"reachable":true,"models":[]}),0));
    assert_eq!(cache.get("demo"),previous);
    let log = capture.finish().await;
    assert_eq!(log.lines().filter(|line|line.contains("empty language model server refresh")).count(),1);
    cache.evict("demo");
    assert!(cache.get("demo").is_none());
    assert!(!cache.record("demo",&good,0),"a late old-key response cannot refill the cache");
    assert!(cache.record("demo",&good,cache.epoch("demo")));
}

#[tokio::test(flavor = "current_thread")]
async fn lsrefresh_success_stays_cached_when_legacy_write_fails() {
    let capture = crate::trace::LogCapture::start().await;
    let saved = json!({"id":"demo","address":"http://synthetic.invalid","preset":"custom","base_path":"v1",
        "models":{"m":{"id":"m","context":65536}}});
    let mut engine = Engine::for_tests(std::env::temp_dir().join("lsrefresh-no-io"));
    Arc::get_mut(&mut engine).unwrap().settings = crate::settings::AppSettings::new(json!({
        "language_servers":{"servers":{"demo":saved}}
    }));
    // The test pool is deliberately unconfigured: no real database is used.
    accept(&engine,&saved,&json!({"reachable":true,"models":[{"id":"m","max_context":262144}]}),0).await;
    assert_eq!(engine.langserver_probes.get("demo").unwrap()["models"][0]["max_context"],262144);
    assert_eq!(server(&engine,"demo").unwrap()["models"]["m"]["context"],65536);
    let log = capture.finish().await;
    assert_eq!(log.lines().filter(|line|line.contains("context upgrade failed")).count(),1);
}

#[tokio::test]
async fn lsrefresh_other_presets_filter_invalid_reported_windows() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}",listener.local_addr().unwrap());
    let app = axum::Router::new().fallback(|uri: axum::http::Uri| async move {
        axum::Json(match uri.path() {
            "/api/version" => json!({"version":"synthetic"}),
            "/api/tags" => json!({"models":[{"name":"m"}]}),
            "/api/ps" => json!({"models":[{"name":"m","context_length":10000001}]}),
            "/api/show" => json!({"model_info":{"test.context_length":-1},"parameters":"num_ctx 10000001"}),
            "/api/v1/models" => json!({"models":[{"id":"m","max_context_length":1.5,
                "loaded_instances":[{"config":{"context_length":0},"context_length":131072}]}]}),
            "/v1/models" => json!({"data":[{"id":"m","meta":{"n_ctx_train":10000001}}]}),
            "/props" => json!({"default_generation_settings":{"n_ctx":-1},"n_ctx":262144}),
            _ => Value::Null,
        })
    });
    let task = tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
    let ollama = probe("ollama",&address,None,"codex-cli",None,&[]).await;
    let lmstudio = probe("lmstudio",&address,None,"codex-cli",None,&[]).await;
    let llama = probe("llamacpp",&address,None,"codex-cli",None,&[]).await;
    task.abort(); let _ = task.await;
    for result in [&ollama,&lmstudio,&llama] {
        assert_eq!(result["reachable"],true);
        assert!(result["models"][0]["max_context"].is_null());
    }
    assert!(ollama["models"][0]["loaded_context"].is_null());
    assert!(ollama["models"][0]["configured_context"].is_null());
    assert_eq!(lmstudio["models"][0]["loaded_context"],131072);
    assert_eq!(llama["models"][0]["loaded_context"],262144);
}
