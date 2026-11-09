//! A model server without a usage feature says nothing about usage in the
//! turn's [PROVIDER USAGE] board: "no usage limit" would read as "unlimited"
//! (liaison spec on `opencode-go-show-usage-limits-5h-weekly-monthly-i`).
use super::*;

fn engine_with_server() -> Arc<Engine> {
    let mut e = Engine::for_tests(PathBuf::from("synthetic-unused-langserver-board"));
    Arc::get_mut(&mut e).unwrap().settings = crate::settings::AppSettings::new(json!({
        "language_servers": {"servers": {"demo": {
            "id": "demo", "label": "Demo server", "preset": "ollama", "address": "http://127.0.0.1:9", "harness": "claude-code",
            "enabled": true, "max_agents": 2, "created_at": "2026-11-09T00:00:00Z",
            "models": {"m": {"id": "m", "tier": "ls-demo-m", "offered": true}}}}}
    }));
    e
}

#[tokio::test]
async fn a_server_without_a_usage_feature_shows_no_usage_wording_on_the_board() {
    let engine = engine_with_server();
    let (text, _) = turn_board(&engine, "langserver", None, "ls-demo-m", "synthetic-org");
    let row = text.lines().find(|l| l.contains("langserver:demo")).unwrap_or_else(|| panic!("a row for the server in: {text}"));
    assert!(row.contains("local") && row.contains("2 agent(s) at once"), "{row}");
    assert!(!row.to_lowercase().contains("limit"), "no limit wording: {row}");
    assert!(!text.to_lowercase().contains("no usage limit"), "{text}");
    assert!(text.contains("runs a set number of agents at once"), "the route line stays: {text}");
}

#[tokio::test]
async fn a_server_that_reports_windows_keeps_its_windows() {
    let engine = engine_with_server();
    engine.usage.put("langserver:demo", &json!({"available": true, "limits": [
        {"kind": "weekly_all", "group": "weekly_all", "percent": 40, "label": "weekly", "resets_at": iso(Utc::now() + chrono::Duration::days(3))}]}));
    let (text, _) = turn_board(&engine, "langserver", None, "ls-demo-m", "synthetic-org");
    assert!(text.contains("weekly") && text.contains("40%"), "{text}");
    assert!(!text.contains("agent(s) at once"), "the windows replace the local row: {text}");
}
