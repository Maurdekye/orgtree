use super::*;

#[test]
fn lsrefresh_default_context_is_one_million() {
    assert_eq!(context_of(&json!({})), 1_000_000);
    assert_eq!(context_of(&json!({"context": 70_000})), 70_000);
}

pub(super) async fn mock_models(data: Value) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new().route("/v1/models", axum::routing::get(move || {
        let data = data.clone();
        async move { axum::Json(data) }
    }));
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, task)
}

#[tokio::test]
async fn lsrefresh_generic_invalid_max_falls_back_to_valid_context_length() {
    let (address, task) = mock_models(json!({"data": [
        {"id":"zero", "max_model_len":0, "context_length":262144},
        {"id":"negative", "max_model_len":-1, "context_length":131072},
        {"id":"huge", "max_model_len":10000001},
        {"id":"fraction", "context_length":1.5}
    ]})).await;
    let result = probe("vllm", &address, None, "codex-cli", None, &[]).await;
    task.abort(); let _ = task.await;
    assert_eq!(result["reachable"], true);
    assert_eq!(result["models"][0]["max_context"], 262144);
    assert_eq!(result["models"][1]["max_context"], 131072);
    assert!(result["models"][2]["max_context"].is_null());
    assert!(result["models"][3]["max_context"].is_null());
}

#[tokio::test]
async fn lsrefresh_http_stored_probe_is_exposed_in_doc() {
    let (address, task) = mock_models(json!({"data":[{"id":"new", "context_length":262144}]})).await;
    let mut engine = Engine::for_tests(std::env::temp_dir().join("lsrefresh-no-io"));
    std::sync::Arc::get_mut(&mut engine).unwrap().settings = crate::settings::AppSettings::new(json!({
        "language_servers":{"servers":{"demo":{"id":"demo","preset":"vllm","address":address,
            "harness":"codex-cli","enabled":true,"models":{}}}}
    }));
    let body = serde_json::from_value(json!({"server":"demo"})).unwrap();
    let answer = crate::http::langserver::probe(axum::extract::State(engine.clone()), axum::Json(body)).await;
    task.abort(); let _ = task.await;
    assert!(answer.is_ok());
    let doc = doc(&engine).await;
    assert_eq!(doc["servers"][0]["last_probe"]["models"][0]["id"], "new");
    assert_eq!(doc["servers"][0]["models"], json!({}), "discovery never offers new models");
}
