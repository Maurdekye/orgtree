//! The language-model server usage probe: the recognised shape, odd shapes,
//! the candidate routes, and what a connection learns over time. A local
//! mock server stands in for every route; nothing leaves the machine.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode, Uri};
use serde_json::{json, Value};

use super::langserver_usage::{candidate_urls, parse_windows, probe, read_server, Answer};
use super::Usage;

const GOOD: &str = r#"{"usage":{
  "rolling":{"status":"ok","percent":12.5,"resetsAt":"2026-11-09T12:00:00Z"},
  "weekly":{"status":"rate-limited","percent":100,"resetsAt":1795000000},
  "monthly":{"status":"ok","percent":3,"resetsAt":1795000000000}}}"#;

fn rows(raw: &str) -> Vec<Value> { parse_windows(&serde_json::from_str(raw).unwrap()).expect("recognised") }

#[test]
fn a_recognised_response_gives_the_three_windows() {
    let r = rows(GOOD);
    assert_eq!(r.len(), 3);
    assert_eq!((r[0]["label"].as_str(), r[0]["kind"].as_str(), r[0]["percent"].as_f64()), (Some("5 h"), Some("session"), Some(12.5)));
    assert_eq!(r[0]["resets_at"].as_str(), Some("2026-11-09T12:00:00Z"));
    assert_eq!((r[1]["label"].as_str(), r[1]["kind"].as_str(), r[1]["percent"].as_f64()), (Some("weekly"), Some("weekly_all"), Some(100.0)));
    assert_eq!(r[1]["is_active"], json!(true), "rate-limited reads as spent");
    assert_eq!((r[2]["label"].as_str(), r[2]["kind"].as_str(), r[2]["percent"].as_f64()), (Some("monthly"), Some("monthly"), Some(3.0)));
    // epoch seconds and epoch milliseconds name the same instant
    assert_eq!(r[1]["resets_at"], r[2]["resets_at"]);
    assert!(r[1]["resets_at"].as_str().is_some_and(|s| s.starts_with("20")), "{}", r[1]["resets_at"]);
    assert_eq!(r[0]["is_active"], json!(false));
}

#[test]
fn a_response_that_is_not_a_usage_response_is_not_recognised() {
    for raw in ["{}", "[]", "5", "\"text\"", r#"{"usage":5}"#, r#"{"usage":{}}"#, r#"{"usage":{"other":{"percent":1}}}"#,
                r#"{"object":"list","data":[{"id":"m"}]}"#, r#"{"error":"nope"}"#] {
        assert!(parse_windows(&serde_json::from_str(raw).unwrap()).is_none(), "{raw}");
    }
}

#[test]
fn a_bad_field_is_unknown_never_zero() {
    for bad in ["\"high\"", "null", "-1", "150", "true"] {
        let r = rows(&format!(r#"{{"usage":{{"weekly":{{"status":"ok","percent":{bad},"resetsAt":"2026-11-09T12:00:00Z"}}}}}}"#));
        assert_eq!(r.len(), 1, "{bad}");
        assert!(r[0]["percent"].is_null(), "percent {bad} must read unknown, not {}", r[0]["percent"]);
    }
    let missing = rows(r#"{"usage":{"weekly":{"status":"ok"}}}"#);
    assert!(missing[0]["percent"].is_null() && missing[0]["resets_at"].is_null());
    // an unreadable reset leaves the percent standing
    for bad in ["\"someday\"", "[]", "-5", "0"] {
        let r = rows(&format!(r#"{{"usage":{{"rolling":{{"status":"ok","percent":40,"resetsAt":{bad}}}}}}}"#));
        assert_eq!((r[0]["percent"].as_f64(), r[0]["resets_at"].is_null()), (Some(40.0), true), "{bad}");
    }
    // a window that is absent is not invented
    assert_eq!(rows(r#"{"usage":{"monthly":{"status":"ok","percent":9}}}"#).len(), 1);
}

#[test]
fn only_the_go_preset_has_a_second_route() {
    let go = json!({"preset":"opencodego","address":"https://opencode.ai/inference/go","harness":"opencode"});
    assert_eq!(candidate_urls(&go), ["https://opencode.ai/inference/go/openai/v1/usage", "https://opencode.ai/zen/go/v1/usage"]);
    for preset in ["ollama", "lmstudio", "llamacpp", "vllm"] {
        let s = json!({"preset":preset,"address":"http://127.0.0.1:9931","harness":"codex-cli"});
        assert_eq!(candidate_urls(&s), ["http://127.0.0.1:9931/v1/usage"], "{preset}");
    }
    // Claude Code's base is the bare address
    let c = json!({"preset":"ollama","address":"http://127.0.0.1:11434/","harness":"claude-code"});
    assert_eq!(candidate_urls(&c), ["http://127.0.0.1:11434/usage"]);
    // a custom server never tries any preset's route, whatever else its record says
    let custom = json!({"preset":"custom","address":"http://localhost:1234","base_path":"api/v1","harness":"opencode","usage_url":"https://opencode.ai/zen/go/v1/usage"});
    assert_eq!(candidate_urls(&custom), ["http://localhost:1234/api/v1/usage"]);
}

// ---- a mock server --------------------------------------------------------------

type Routes = Arc<Mutex<HashMap<String, (u16, String)>>>;
struct Mock { base: String, routes: Routes, hits: Arc<Mutex<Vec<(String, bool)>>> }

impl Mock {
    async fn start(routes: &[(&str, u16, &str)]) -> Mock {
        let table: Routes = Arc::new(Mutex::new(routes.iter().map(|(p, s, b)| (p.to_string(), (*s, b.to_string()))).collect()));
        let hits: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
        let (t, h) = (table.clone(), hits.clone());
        let app = axum::Router::new().fallback(move |uri: Uri, headers: HeaderMap| {
            let (t, h) = (t.clone(), h.clone());
            async move {
                h.lock().unwrap().push((uri.path().to_string(), headers.get("authorization").is_some_and(|v| v == "Bearer sk-test")));
                match t.lock().unwrap().get(uri.path()) {
                    Some((s, b)) => (StatusCode::from_u16(*s).unwrap(), b.clone()),
                    None => (StatusCode::NOT_FOUND, String::new()),
                }
            }
        });
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        Mock { base, routes: table, hits }
    }
    fn set(&self, path: &str, status: u16, body: &str) { self.routes.lock().unwrap().insert(path.into(), (status, body.into())); }
    fn hits(&self) -> usize { self.hits.lock().unwrap().len() }
    fn server(&self) -> Value { json!({"id":"srv","preset":"custom","address":self.base,"harness":"opencode","label":"Mock"}) }
}

#[tokio::test]
async fn any_connection_with_the_route_shows_windows_and_the_key_is_only_a_bearer_header() {
    let m = Mock::start(&[("/v1/usage", 200, GOOD)]).await;
    let urls = vec![format!("{}/v1/usage", m.base)];
    match probe(&urls, Some("sk-test")).await {
        Answer::Windows(url, rows) => { assert_eq!(url, urls[0]); assert_eq!(rows.len(), 3); }
        other => panic!("{other:?}"),
    }
    assert_eq!(m.hits.lock().unwrap().as_slice(), [("/v1/usage".to_string(), true)], "the key went as a Bearer header");
    // no key, no header
    let _ = probe(&urls, None).await;
    assert_eq!(m.hits.lock().unwrap()[1], ("/v1/usage".to_string(), false));
}

#[tokio::test]
async fn the_second_route_is_tried_when_the_first_is_not_there() {
    let m = Mock::start(&[("/zen/go/v1/usage", 200, GOOD)]).await;
    let urls = vec![format!("{}/inference/go/openai/v1/usage", m.base), format!("{}/zen/go/v1/usage", m.base)];
    match probe(&urls, Some("sk-test")).await {
        Answer::Windows(url, _) => assert_eq!(url, urls[1]),
        other => panic!("{other:?}"),
    }
    assert_eq!(m.hits(), 2);
}

#[tokio::test]
async fn not_there_answers_are_no_feature_and_a_broken_one_is_a_failure() {
    for (status, body) in [(404, ""), (405, ""), (501, ""), (200, r#"{"object":"list","data":[]}"#), (200, "<html>hi</html>")] {
        let m = Mock::start(&[("/v1/usage", status, body)]).await;
        assert_eq!(probe(&[format!("{}/v1/usage", m.base)], None).await, Answer::NoFeature, "{status} {body}");
    }
    for status in [401, 403, 429, 500, 503] {
        let m = Mock::start(&[("/v1/usage", status, "")]).await;
        assert!(matches!(probe(&[format!("{}/v1/usage", m.base)], None).await, Answer::Failed(_)), "{status}");
    }
    assert!(matches!(probe(&["http://127.0.0.1:1/usage".into()], None).await, Answer::Failed(_)), "nothing listening");
}

#[tokio::test]
async fn a_connection_without_the_route_shows_nothing_and_is_not_probed_again() {
    let m = Mock::start(&[]).await;
    let usage = Usage::default();
    assert!(read_server(&usage, &m.server(), Some("sk-test")).await.is_none());
    assert_eq!(m.hits(), 1);
    for _ in 0..3 { assert!(read_server(&usage, &m.server(), Some("sk-test")).await.is_none()); }
    assert_eq!(m.hits(), 1, "no second probe within the session");
    // a new key is a settings change: it is asked again, once
    assert!(read_server(&usage, &m.server(), Some("sk-other")).await.is_none());
    assert_eq!(m.hits(), 2);
    assert!(read_server(&usage, &m.server(), Some("sk-other")).await.is_none());
    assert_eq!(m.hits(), 2);
    // so is a new address
    let mut moved = m.server();
    moved["base_path"] = json!("v2");
    assert!(read_server(&usage, &moved, Some("sk-other")).await.is_none());
    assert_eq!(m.hits(), 3);
}

#[tokio::test]
async fn a_connection_that_worked_and_then_fails_reads_unknown_never_zero() {
    let m = Mock::start(&[("/v1/usage", 200, GOOD)]).await;
    let usage = Usage::default();
    let ok = read_server(&usage, &m.server(), Some("sk-test")).await.expect("a reading");
    assert_eq!(ok["available"], json!(true));
    assert_eq!(ok["limits"].as_array().map(Vec::len), Some(3));
    for (status, body) in [(500, ""), (401, ""), (404, ""), (200, "not json"), (200, r#"{"data":[]}"#)] {
        m.set("/v1/usage", status, body);
        let bad = read_server(&usage, &m.server(), Some("sk-test")).await.expect("a reading, not silence");
        assert_eq!(bad["available"], json!(false), "{status} {body}");
        assert!(bad["limits"].as_array().is_none_or(|l| l.is_empty()), "no window survives to read as 0%: {bad}");
        assert!(bad["error"].as_str().is_some_and(|e| !e.contains("sk-test")), "{bad}");
    }
    // and it recovers
    m.set("/v1/usage", 200, GOOD);
    assert_eq!(read_server(&usage, &m.server(), Some("sk-test")).await.unwrap()["available"], json!(true));
}

#[tokio::test]
async fn a_failure_before_any_success_shows_nothing_and_asks_again_next_time() {
    let m = Mock::start(&[("/v1/usage", 500, "")]).await;
    let usage = Usage::default();
    assert!(read_server(&usage, &m.server(), None).await.is_none());
    assert!(read_server(&usage, &m.server(), None).await.is_none());
    assert_eq!(m.hits(), 2, "a failure is not 'no feature': it is asked again");
}
