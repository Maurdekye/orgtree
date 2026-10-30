//! A seat's own harness (user 2026-10-29 14:26Z, the agent settings Model
//! tab's Harness row, for OpenRouter and language model server seats): where
//! the pin lives, which harness a seat should run on, what a server seat may
//! choose, how its launch reaches the server, and how undo records the
//! change. In-memory only: no database, CLI, process or network.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::accounts::{AccountInfo, Accounts};
use crate::engine::Engine;

fn key(id: &str, harness: &str) -> AccountInfo {
    AccountInfo { id: id.into(), provider: "openrouter".into(), kind: "apikey".into(), label: "fixture".into(),
        email: None, tint_ordinal: 0, auth: "signed_out".into(), config_dir: None, enabled: true,
        origin_org: None, marks: Default::default(), ord: 0, ambient: false, credential: 0,
        harness: Some(harness.into()) }
}

fn engine_with(keys: Vec<AccountInfo>, settings: Value) -> Arc<Engine> {
    let mut e = Engine::for_tests("synthetic-unused-harness-pin".into());
    let engine = Arc::get_mut(&mut e).unwrap();
    engine.accounts = Accounts::for_tests(keys);
    engine.settings = crate::settings::AppSettings::new(settings);
    e
}

fn server(preset: &str, harness: &str, base_path: &str) -> Value {
    json!({ "id": preset, "preset": preset, "label": "Fixture server", "address": "http://127.0.0.1:9931",
            "harness": harness, "base_path": base_path, "enabled": true, "max_agents": 1,
            "models": { "m": { "id": "m", "tier": format!("ls-{preset}-m"), "label": "m", "offered": true } } })
}

#[test]
fn a_pin_is_its_target_else_the_stamp_of_a_hire_time_pin() {
    use crate::harnesses::seat_pin;
    assert_eq!(seat_pin(&json!({})), None, "no pin: the seat follows its key or server");
    assert_eq!(seat_pin(&json!({ "harness": "opencode" })), None, "a stamp alone is no pin");
    // a hire's explicit harness: the stamp is the pin (stored before targets existed)
    assert_eq!(seat_pin(&json!({ "harness": "opencode", "harness_pin": true })).as_deref(), Some("opencode"));
    // a pin set later in the Model tab: the session still runs on the stamp
    // until its next turn boundary moves it to the target
    assert_eq!(seat_pin(&json!({ "harness": "claude-code", "harness_pin": true, "harness_pin_to": "opencode" })).as_deref(),
        Some("opencode"));
    assert_eq!(seat_pin(&json!({ "harness": "opencode", "harness_pin": false, "harness_pin_to": "codex-cli" })), None,
        "an unpinned seat ignores a stale target");
}

#[test]
fn an_openrouter_seat_runs_its_pin_else_its_keys_harness() {
    let e = engine_with(vec![key("openrouter-1", "codex-cli"), key("openrouter-2", "opencode")], json!({}));
    assert_eq!(crate::openrouter::seat_harness(&e, Some("openrouter-2"), None), "opencode", "its key's harness");
    assert_eq!(crate::openrouter::seat_harness(&e, None, None), "codex-cli", "no key bound: the first key's");
    assert_eq!(crate::openrouter::seat_harness(&e, Some("openrouter-2"), Some("claude-code")), "claude-code",
        "a pin wins over its key (user ruling 2026-10-13, \"Agent's choice wins\")");
}

#[test]
fn a_server_seat_runs_its_pin_else_its_servers_harness() {
    let s = server("ollama", "claude-code", "");
    assert_eq!(crate::langserver::seat_harness(&s, None), "claude-code");
    assert_eq!(crate::langserver::seat_harness(&s, Some("codex-cli")), "codex-cli");
    assert_eq!(crate::langserver::seat_harness(&json!({ "id": "x" }), None), "claude-code", "a server stored without one");
}

#[test]
fn a_seat_harness_reaches_the_server_on_its_own_api_path() {
    use crate::langserver::{base_url, base_url_for};
    let ollama = server("ollama", "claude-code", "");
    assert_eq!(base_url_for(&ollama, "claude-code"), "http://127.0.0.1:9931", "Claude Code appends /v1/messages itself");
    assert_eq!(base_url_for(&ollama, "codex-cli"), "http://127.0.0.1:9931/v1", "Codex appends /responses to a /v1 base");
    assert_eq!(base_url_for(&ollama, "opencode"), "http://127.0.0.1:9931/v1");
    assert_eq!(base_url(&ollama), base_url_for(&ollama, "claude-code"), "the server's own harness, as before");
    let custom = server("custom", "codex-cli", "v1");
    assert_eq!(base_url_for(&custom, "opencode"), "http://127.0.0.1:9931/v1", "a custom server keeps its base path");
}

#[test]
fn a_server_seat_may_choose_the_installed_harnesses_its_server_can_carry() {
    use crate::langserver::seat_choices;
    let pick = |v: &[Value], id: &str| v.iter().find(|o| o["id"] == id).cloned().unwrap_or(Value::Null);
    let all = |_: &str| true;
    let ollama = seat_choices(&server("ollama", "claude-code", ""), &all);
    assert_eq!(ollama.iter().map(|o| o["id"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["claude-code", "codex-cli", "opencode"],
        "every selectable harness, in registry order");
    assert!(ollama.iter().all(|o| o["available"] == true), "a preset carries every harness: {ollama:?}");
    assert_eq!(pick(&ollama, "opencode")["label"], "OpenCode (ACP)");
    let no_codex = seat_choices(&server("ollama", "claude-code", ""), &|h: &str| h != "codex-cli");
    let codex = pick(&no_codex, "codex-cli");
    assert_eq!((codex["installed"].clone(), codex["available"].clone()), (json!(false), json!(false)));
    assert_eq!(codex["why"], "Codex is not installed on this computer");
    // a custom server's one base path is set for its own harness's API:
    // the other API family would reach a wrong path, so it is not offered
    let custom = seat_choices(&server("custom", "codex-cli", "v1"), &all);
    assert_eq!(pick(&custom, "opencode")["available"], true, "Codex and OpenCode share an OpenAI-style base");
    let claude = pick(&custom, "claude-code");
    assert_eq!(claude["available"], false);
    assert!(claude["why"].as_str().unwrap_or("").contains("base path"), "{claude}");
    let custom_claude = seat_choices(&server("custom", "claude-code", ""), &all);
    assert_eq!(pick(&custom_claude, "codex-cli")["available"], false);
    assert_eq!(pick(&custom_claude, "opencode")["available"], false);
}

#[test]
fn a_server_seat_launch_names_its_harness_in_the_pass_through_path() {
    let e = engine_with(vec![], json!({}));
    let base = crate::lsproxy::base(&e, "ollama-2", "codex-cli");
    assert!(base.ends_with("/ls/ollama-2~codex-cli"), "{base}");
    assert_eq!(crate::lsproxy::split_server("ollama-2~codex-cli"), ("ollama-2", Some("codex-cli")));
    assert_eq!(crate::lsproxy::split_server("ollama-2"), ("ollama-2", None), "a path without one: the server's own harness");
}

#[test]
fn a_harness_switch_says_why_it_happened() {
    use crate::harnesses::switch_why;
    use crate::providers::catalog::{LANGSERVER, OPENROUTER};
    assert_eq!(switch_why(OPENROUTER, false, "codex-cli", "claude-code"), "its OpenRouter key now runs on Codex (it ran on Claude Code)");
    assert_eq!(switch_why(OPENROUTER, true, "opencode", "claude-code"),
        "its harness was set to OpenCode (ACP) in its settings (it ran on Claude Code)");
    assert_eq!(switch_why(LANGSERVER, false, "codex-cli", "claude-code"),
        "its language model server now runs on Codex (it ran on Claude Code)");
    assert_eq!(switch_why(LANGSERVER, true, "claude-code", "opencode"),
        "its harness was set to Claude Code in its settings (it ran on OpenCode (ACP))");
}

#[test]
fn a_server_seats_harness_reads_its_stamp_first() {
    let e = engine_with(vec![], json!({ "language_servers": { "servers": { "ollama": server("ollama", "claude-code", "") } } }));
    let h = |extra: Value| crate::domain::compaction::node_harness(&e, "ls-ollama-m", None, &extra);
    assert_eq!(h(json!({})).as_deref(), Some("claude-code"), "never stamped: its server's");
    assert_eq!(h(json!({ "harness": "opencode", "harness_pin": true, "harness_pin_to": "opencode" })).as_deref(), Some("opencode"),
        "what its session runs on");
}

#[test]
fn a_harness_change_is_a_recorded_undoable_settings_step() {
    use crate::domain::undo::{kind_of, RECORDED_OPS};
    let steps = |ops: &[&str]| ops.iter().map(|op| json!({ "op": op, "node": "a" })).collect::<Vec<_>>();
    assert_eq!(kind_of(&steps(&["harness"])).unwrap(), "retool");
    assert_eq!(kind_of(&steps(&["switch_model", "harness", "scope"])).unwrap(), "retool", "one settings save");
    assert!(RECORDED_OPS.contains(&"harness"), "a single harness op from the user is recorded too");
}

#[test]
fn a_server_patch_writes_its_new_harness_and_api() {
    use crate::langserver::{patch_server_with, ServerPatch};
    let e = engine_with(vec![], json!({ "language_servers": { "servers": { "ollama": server("ollama", "claude-code", "") } } }));
    let all = |_: &str| true;
    let p = patch_server_with(&e, "ollama", ServerPatch { harness: Some("codex-cli".into()), ..Default::default() }, &all).unwrap();
    assert_eq!(p.get("harness"), Some(&json!("codex-cli")));
    assert_eq!(p.get("api"), Some(&json!("responses")));
    let p_oc = patch_server_with(&e, "ollama", ServerPatch { harness: Some("opencode".into()), ..Default::default() }, &all).unwrap();
    assert_eq!(p_oc.get("harness"), Some(&json!("opencode")));
    assert_eq!(p_oc.get("api"), Some(&json!("chat_completions")));
    let p_cc = patch_server_with(&e, "ollama", ServerPatch { harness: Some("claude-code".into()), ..Default::default() }, &all).unwrap();
    assert_eq!(p_cc.get("harness"), Some(&json!("claude-code")));
    assert_eq!(p_cc.get("api"), Some(&json!("anthropic")));
}

#[test]
fn a_server_patch_refuses_an_unknown_or_uninstalled_harness() {
    use crate::langserver::{patch_server_with, ServerPatch};
    let e = engine_with(vec![], json!({ "language_servers": { "servers": { "ollama": server("ollama", "claude-code", "") } } }));
    let bad = patch_server_with(&e, "ollama", ServerPatch { harness: Some("bogus".into()), ..Default::default() }, &|_: &str| true);
    assert!(bad.is_err(), "unknown harness must be refused");
    assert!(format!("{bad:?}").contains("claude-code, codex-cli or opencode"), "{bad:?}");
    let missing = patch_server_with(&e, "ollama", ServerPatch { harness: Some("opencode".into()), ..Default::default() }, &|h: &str| h != "opencode");
    assert!(missing.is_err(), "uninstalled harness must be refused");
    assert!(format!("{missing:?}").contains("OpenCode (ACP) is not installed"), "{missing:?}");
}

#[test]
fn a_custom_server_api_family_change_requires_a_base_path() {
    use crate::langserver::{patch_server_with, ServerPatch};
    let e = engine_with(vec![], json!({
        "language_servers": {
            "servers": {
                "custom-cc": server("custom", "claude-code", "api/anthropic"),
                "custom-cx": server("custom", "codex-cli", "v1"),
            }
        }
    }));
    let all = |_: &str| true;
    let no_path = patch_server_with(&e, "custom-cc", ServerPatch { harness: Some("codex-cli".into()), ..Default::default() }, &all);
    assert!(no_path.is_err(), "switching API family on a custom server without a base path must be refused");
    let blank_path = patch_server_with(&e, "custom-cc", ServerPatch {
        harness: Some("codex-cli".into()), base_path: Some("   ".into()), ..Default::default()
    }, &all);
    assert!(blank_path.is_err(), "blank base path on API family switch must be refused");
    let with_path = patch_server_with(&e, "custom-cc", ServerPatch {
        harness: Some("codex-cli".into()), base_path: Some("v1".into()), ..Default::default()
    }, &all).unwrap();
    assert_eq!(with_path.get("harness"), Some(&json!("codex-cli")));
    assert_eq!(with_path.get("api"), Some(&json!("responses")));
    assert_eq!(with_path.get("base_path"), Some(&json!("v1")));
    let same_family = patch_server_with(&e, "custom-cx", ServerPatch {
        harness: Some("opencode".into()), ..Default::default()
    }, &all).unwrap();
    assert_eq!(same_family.get("harness"), Some(&json!("opencode")));
    assert_eq!(same_family.get("api"), Some(&json!("chat_completions")));
}

#[test]
fn a_server_counts_its_following_and_pinned_seats_by_harness() {
    use crate::langserver::seat_counts_of;
    let e = engine_with(vec![], json!({
        "language_servers": {
            "servers": {
                "ollama": server("ollama", "claude-code", ""),
                "custom": server("custom", "claude-code", "api/anthropic"),
            }
        }
    }));
    let rows = vec![
        ("ls-ollama-m".to_string(), json!({})),
        ("ls-ollama-m".to_string(), json!({ "harness": "claude-code" })),
        ("ls-ollama-m".to_string(), json!({ "harness": "opencode", "harness_pin": false, "harness_pin_to": "codex-cli" })),
        ("ls-ollama-m".to_string(), json!({ "harness": "opencode", "harness_pin": true })),
        ("ls-ollama-m".to_string(), json!({ "harness": "claude-code", "harness_pin": true, "harness_pin_to": "codex-cli" })),
        ("ls-custom-m".to_string(), json!({ "harness": "claude-code", "harness_pin": true })),
    ];
    let counts = seat_counts_of(&e, &rows);
    let ollama = counts.get("ollama").expect("ollama seat counts");
    assert_eq!(ollama.following, 3, "three unpinned seats follow the server");
    assert_eq!(ollama.pinned, 2, "two pinned seats keep their harness");
    assert_eq!(ollama.pinned_harnesses.get("opencode"), Some(&1));
    assert_eq!(ollama.pinned_harnesses.get("codex-cli"), Some(&1));
    let custom = counts.get("custom").expect("custom seat counts");
    assert_eq!(custom.following, 0);
    assert_eq!(custom.pinned, 1);
    assert_eq!(custom.pinned_harnesses.get("claude-code"), Some(&1));
}

// Harness everywhere (user 2026-10-30 07:36:24Z m5611018df279, "fix both
// yes"): the hire dialog, the hire tool and orgtree_retool offer what the
// Model tab offers, under one rule.

#[test]
fn one_rule_says_which_harness_a_seat_may_run() {
    use crate::harnesses::seat_refusal;
    let all = |_: &str| true;
    let no_opencode = |h: &str| h != "opencode";
    // an OpenRouter seat: any selectable harness installed here
    assert_eq!(seat_refusal("or-x", None, "codex-cli", &all), None);
    assert_eq!(seat_refusal("or-x", None, "opencode", &no_opencode).as_deref(),
        Some("OpenCode (ACP) is not installed on this computer; install it, or choose an installed harness"));
    let why = seat_refusal("or-x", None, "antigravity", &all).unwrap_or_default();
    assert!(why.contains("claude-code, codex-cli, opencode"), "names the choices: {why}");
    // a language model server seat: one its server can carry
    let ollama = server("ollama", "claude-code", "");
    assert_eq!(seat_refusal("ls-ollama-m", Some(&ollama), "codex-cli", &all), None, "a preset carries every harness");
    assert_eq!(seat_refusal("ls-ollama-m", Some(&ollama), "opencode", &no_opencode).as_deref(),
        Some("OpenCode (ACP) is not installed on this computer"));
    let custom = server("custom", "claude-code", "api/anthropic");
    let why = seat_refusal("ls-custom-m", Some(&custom), "codex-cli", &all).unwrap_or_default();
    assert!(why.contains("base path"), "the other API family needs its own server entry: {why}");
    let why = seat_refusal("ls-ollama-m", Some(&ollama), "bogus", &all).unwrap_or_default();
    assert!(why.contains("claude-code, codex-cli, opencode"), "{why}");
    let why = seat_refusal("ls-gone-m", None, "claude-code", &all).unwrap_or_default();
    assert!(why.contains("not a model of any language model server"), "{why}");
    // any other tier runs on its own CLI: no choice
    let why = seat_refusal("sol", None, "codex-cli", &all).unwrap_or_default();
    assert!(why.contains("only for OpenRouter and language model server agents"), "{why}");
}

#[test]
fn a_retool_harness_pins_one_follows_or_leaves_it() {
    use crate::harnesses::retool_choice;
    assert_eq!(retool_choice(None), Ok(None), "absent: unchanged");
    assert_eq!(retool_choice(Some(&Value::Null)), Ok(None), "null: unchanged, like the other retool fields");
    assert_eq!(retool_choice(Some(&json!("follow"))), Ok(Some(None)), "follow clears its own harness");
    assert_eq!(retool_choice(Some(&json!("codex-cli"))), Ok(Some(Some("codex-cli".to_string()))), "a harness id pins it");
    let empty = retool_choice(Some(&json!("")));
    assert!(empty.as_ref().is_err_and(|w| w.contains("\"follow\"")), "an empty value says what to send: {empty:?}");
    assert!(retool_choice(Some(&json!(true))).is_err());
}

#[test]
fn the_hire_dialog_row_follows_the_drafts_key_or_its_server() {
    use crate::harnesses::hire_row;
    let e = engine_with(vec![key("openrouter-1", "codex-cli"), key("openrouter-2", "opencode")],
        json!({ "language_servers": { "servers": { "ollama": server("ollama", "claude-code", "") } } }));
    let ids = |r: &Value| r["options"].as_array().map(|o| o.iter().map(|x| x["id"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    let or2 = hire_row(&e, "or-x", Some("openrouter-2"));
    assert_eq!((or2["lane"].clone(), or2["follow"]["id"].clone(), or2["follow"]["source"].clone()),
        (json!("openrouter"), json!("opencode"), json!("key")), "the key the draft names: {or2}");
    assert_eq!((or2["pin"].clone(), or2["current"].clone(), or2["moves"].clone()), (Value::Null, Value::Null, json!(false)),
        "a seat not hired yet has no pin, no session and no move");
    assert_eq!(ids(&or2), ["claude-code", "codex-cli", "opencode"], "the key dialog's list");
    assert_eq!(hire_row(&e, "or-x", None)["follow"]["id"], "codex-cli", "no key named: the first key's");
    let ls = hire_row(&e, "ls-ollama-m", None);
    assert_eq!((ls["lane"].clone(), ls["follow"]["id"].clone(), ls["follow"]["source"].clone(), ls["follow"]["name"].clone()),
        (json!("langserver"), json!("claude-code"), json!("server"), json!("Fixture server")), "{ls}");
    assert_eq!(ids(&ls), ["claude-code", "codex-cli", "opencode"]);
    let other = hire_row(&e, "sol", None);
    assert_eq!((other["lane"].clone(), ids(&other).len()), (Value::Null, 0), "no harness choice on other tiers: {other}");
}

#[test]
fn the_seat_tools_offer_a_harness_on_both_lanes() {
    let cards = crate::tools::defs::list();
    let field = |name: &str| cards.iter().find(|c| c["name"] == name).map(|c| c["inputSchema"]["properties"]["harness"].clone())
        .unwrap_or(Value::Null);
    let retool = field("orgtree_retool");
    assert_eq!(retool["type"], "string", "orgtree_retool changes a report's harness: {retool}");
    assert_eq!(retool["enum"], json!(["claude-code", "codex-cli", "opencode", "follow"]));
    for name in ["orgtree_hire", "orgtree_staff"] {
        let d = field(name)["description"].as_str().unwrap_or("").to_string();
        assert!(d.contains("language model server"), "{name} pins server seats too: {d}");
    }
}
