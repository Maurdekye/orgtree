//! The tree's record bodies: one agent (a `TreeNode` without children, plus
//! its parent link) and the twelve org header groups, built from database
//! facts. Pure functions: no I/O.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

use crate::domain::scope;
use crate::providers::catalog;
use crate::util::{iso, parse_ts};

/// Facts the builder needs beyond the agent's own row.
pub struct TreeCtx<'a> {
    pub org_settings: &'a Value,
    pub now: DateTime<Utc>,
    pub accounts: &'a crate::accounts::AccountsView,
    pub audiences_held: &'a HashMap<String, Vec<String>>,
}

/// Re-emit a timestamp column (`to_jsonb` spells it `...+00:00`) in the
/// engine's one wire format.
pub fn ts(v: &Value) -> Value {
    match v.as_str().and_then(parse_ts) {
        Some(t) => Value::String(iso(t)),
        None => Value::Null,
    }
}

fn f(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// One turn-ledger row → the card's `TurnStat`.
fn turn_stat(t: &Value) -> Value {
    let mut o = Map::new();
    o.insert("at".into(), ts(&t["started_at"]));
    o.insert("cost".into(), json!(f(&t["cost_usd"])));
    o.insert("ms".into(), t.get("ms").cloned().unwrap_or(Value::Null));
    o.insert("denials".into(), json!(t["denials"].as_i64().unwrap_or(0)));
    if let Some(a) = t.get("approvals").filter(|v| !v.is_null()) {
        o.insert("approvals".into(), a.clone());
    }
    if let Some(toks) = t.get("toks").filter(|v| !v.is_null()) {
        o.insert("toks".into(), toks.clone());
    }
    if t["killed"].as_bool().unwrap_or(false) {
        o.insert("killed".into(), json!(true));
    }
    if t["estimated"].as_bool().unwrap_or(false) {
        o.insert("estimated".into(), json!(true));
    }
    if let Some(src) = t.get("cost_source").and_then(Value::as_str) {
        o.insert("cost_source".into(), json!(src));
    }
    Value::Object(o)
}

/// The ask card a desk shows: the open request batch, or one resolved within
/// the linger window.
pub fn ask_info(raw: &Value, node_name: &str, now: DateTime<Utc>) -> Value {
    if raw.is_null() {
        return Value::Null;
    }
    let status = raw["status"].as_str().unwrap_or("open");
    if status != "open" {
        let resolved = raw.get("resolved_at").and_then(Value::as_str).and_then(parse_ts);
        match resolved {
            Some(t) if (now - t).num_seconds() < 600 => {}
            _ => return Value::Null,
        }
    }
    ask_card(raw, node_name)
}

/// An `asks` row → `AskInfo`.
pub fn ask_card(raw: &Value, node_name: &str) -> Value {
    let mut o = raw["body"].as_object().cloned().unwrap_or_default();
    o.insert("id".into(), raw["uid"].clone());
    o.insert("node".into(), json!(node_name));
    o.insert("kind".into(), raw["kind"].clone());
    o.insert("status".into(), raw["status"].clone());
    o.insert("at".into(), ts(&raw["created_at"]));
    o.insert("rev".into(), raw["rev"].clone());
    if let Some(r) = raw.get("resolved_at").filter(|v| !v.is_null()) {
        o.insert("resolved_at".into(), ts(r));
    }
    if let Some(r) = raw.get("reason").filter(|v| !v.is_null()) {
        o.insert("reason".into(), r.clone());
    }
    if let Some(m) = raw.get("answer_mail").filter(|v| !v.is_null()) {
        o.insert("answer_mail".into(), m.clone());
    }
    if let Some(a) = raw.get("answer").filter(|v| !v.is_null()) {
        o.insert("answer".into(), a.clone());
    }
    let wi = raw.get("work_items").and_then(Value::as_array).cloned().unwrap_or_default();
    if !wi.is_empty() {
        o.insert("work_items".into(), Value::Array(wi));
    }
    Value::Object(o)
}

/// Effective cheap-compact setting for a node: its own override, else the org's.
pub(crate) fn cheap_compact(scope: &Value, org: &Value) -> (bool, Option<f64>) {
    let node = scope.get("auto_cheap_compact").filter(|v| v.is_object() && !v.as_object().unwrap().is_empty());
    let cfg = node.or_else(|| org.get("auto_cheap_compact")).cloned().unwrap_or(Value::Null);
    let on = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let occ = cfg.get("occ").and_then(Value::as_f64).unwrap_or(0.5);
    (on, if on { Some(occ) } else { None })
}

/// The record body of one agent. `raw` is the `to_jsonb(agents)` row plus
/// the `x_*` aggregates; `effective` is its clamped scope.
pub fn agent_body(raw: &Value, effective: &Value, parent_key: Option<i64>, ctx: &TreeCtx) -> Value {
    let name = raw["name"].as_str().unwrap_or("");
    let tier = raw["tier"].as_str().unwrap_or("sonnet");
    let configured = scope::normalize(&raw["scope"]);
    let state = raw["state"].as_str().unwrap_or("live");
    let seat = f(&raw["seat"]);
    let grant = f(&raw["grant_credits"]);
    let hold = f(&raw["x_children_hold"]);
    let model_version = configured.get("model_version").and_then(Value::as_str);
    let account = raw.get("account").and_then(Value::as_str);
    let frozen = raw.get("frozen").cloned().unwrap_or(Value::Null);
    let halt = raw.get("halt").cloned().unwrap_or(Value::Null);
    let halted = halt.get("phase").and_then(Value::as_str) == Some("halted");
    let (cc_on, cc_occ) = cheap_compact(&configured, ctx.org_settings);
    let extra = raw.get("x_extra").cloned().unwrap_or(Value::Null);

    let mut o = Map::new();
    o.insert("id".into(), json!(name));
    o.insert("parent_id".into(), parent_key.map(|p| json!(p.to_string())).unwrap_or(Value::Null));
    o.insert("sibling_order".into(), json!(f(&raw["sibling_order"])));
    o.insert("ui_order".into(), json!(f(&raw["sibling_order"])));
    o.insert("created".into(), ts(&raw["created_at"]));
    o.insert("ord".into(), raw["id"].clone());
    o.insert("title".into(), raw["title"].clone());
    o.insert("tier".into(), json!(tier));
    o.insert("model_id".into(), json!(catalog::model_for(tier, model_version)));
    if let Some(acc) = account {
        o.insert("account".into(), json!(acc));
        if let Some(info) = ctx.accounts.get(acc) {
            o.insert("account_tint_ordinal".into(), json!(info.tint_ordinal));
            o.insert("account_label".into(), json!(info.display()));
        }
    }
    o.insert("state".into(), json!(state));
    o.insert("seat".into(), json!(seat));
    o.insert("grant".into(), json!(grant));
    o.insert("free".into(), json!(round2(grant - hold)));
    if let Some(s) = raw.get("session_id").filter(|v| !v.is_null()) {
        o.insert("session_id".into(), s.clone());
    }
    o.insert("scope".into(), effective.clone());
    o.insert("configured_scope".into(), configured.clone());
    o.insert("cost_usd".into(), json!(f(&raw["cost_usd"])));
    if raw["cost_unknown"].as_bool().unwrap_or(false) {
        o.insert("cost_usd_unknown".into(), json!(true));
    }
    o.insert("occupancy".into(), raw.get("occupancy").cloned().unwrap_or(Value::Null));
    if raw["occupancy_est"].as_bool().unwrap_or(false) {
        o.insert("occupancy_est".into(), json!(true));
    }
    if raw["compacted_unrun"].as_bool().unwrap_or(false) {
        o.insert("compacted_unrun".into(), json!(true));
    }
    let ctxw = raw
        .get("context_window")
        .filter(|v| !v.is_null())
        .cloned()
        .or_else(|| catalog::tier(tier).and_then(|t| t.context).map(|c| json!(c)))
        .unwrap_or(Value::Null);
    o.insert("context_window".into(), ctxw);
    o.insert("charter".into(), raw.get("charter").cloned().unwrap_or(Value::Null));
    o.insert("team_charter".into(), raw.get("team_charter").cloned().unwrap_or(Value::Null));
    let mail_pending = raw["x_mail_pending"].as_i64().unwrap_or(0);
    o.insert("mail_pending".into(), json!(mail_pending));
    o.insert("limit_locked".into(), json!(raw["limit_locked"].as_bool().unwrap_or(false)));
    let resumable = state == "live" && !frozen.is_null() && !halted;
    o.insert("resumable".into(), json!(resumable));
    let continue_accounts: Vec<String> = if resumable && frozen.get("limit").and_then(Value::as_bool).unwrap_or(true) {
        ctx.accounts.continue_candidates(catalog::provider_of(tier), account)
    } else {
        Vec::new()
    };
    o.insert("continue_accounts".into(), json!(continue_accounts));
    o.insert("last_status".into(), raw.get("last_status").cloned().unwrap_or(Value::Null));
    o.insert("prev_status".into(), raw.get("prev_status").cloned().unwrap_or(Value::Null));
    o.insert("inflight_at".into(), ts(&raw["inflight_at"]));
    o.insert("pending_switch".into(), raw.get("pending_switch").cloned().unwrap_or(Value::Null));
    o.insert("pending_account".into(), raw.get("pending_account").cloned().unwrap_or(Value::Null));
    o.insert("last_denials".into(), raw.get("last_denials").cloned().filter(Value::is_array).unwrap_or(json!([])));
    if let Some(a) = raw.get("last_approvals").filter(|v| v.is_array()) {
        o.insert("last_approvals".into(), a.clone());
    }
    let turns: Vec<Value> = raw["x_turns"].as_array().map(|a| a.iter().map(turn_stat).collect()).unwrap_or_default();
    o.insert("turns".into(), Value::Array(turns));
    o.insert("frozen".into(), frozen_view(&frozen));
    o.insert("halt".into(), halt.clone());
    if halted {
        o.insert("halt_queued".into(), json!(mail_pending));
    }
    let held = ctx.audiences_held.get(name).cloned().unwrap_or_default();
    o.insert("audiences_held".into(), json!(held));
    o.insert("bearer_state".into(), Value::Null);
    o.insert("generation".into(), raw["generation"].clone());
    o.insert("lineage".into(), json!([]));
    o.insert("lineage_count".into(), json!(0));
    o.insert("ask".into(), ask_info(&raw["x_ask"], name, ctx.now));
    o.insert("documents_count".into(), raw["x_docs_count"].clone());
    let docs: Vec<Value> = raw["x_docs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|d| {
                    let mut d = d.clone();
                    if let Some(obj) = d.as_object_mut() {
                        let at = ts(&obj.get("at").cloned().unwrap_or(Value::Null));
                        obj.insert("at".into(), at);
                    }
                    d
                })
                .collect()
        })
        .unwrap_or_default();
    o.insert("documents".into(), Value::Array(docs));
    o.insert("remote_controlled".into(), Value::Null);
    o.insert("cheap_compact_on".into(), json!(cc_on));
    o.insert("cheap_compact_occ".into(), cc_occ.map(|x| json!(x)).unwrap_or(Value::Null));
    o.insert("retired_children_total".into(), raw["x_retired_children"].clone());
    o.insert("successor".into(), Value::Null);
    if let Some(e) = raw.get("last_error").filter(|v| !v.is_null()) {
        o.insert("last_error".into(), e.clone());
    } else {
        o.insert("last_error".into(), Value::Null);
    }
    // a secondary account wears its card whether or not a turn is running
    o.insert(
        "serving_account".into(),
        crate::accounts::serving_card(ctx.accounts, raw.get("account").and_then(Value::as_str), ctx.now).unwrap_or(Value::Null),
    );
    // runtime defaults: the overlay replaces these while an actor runs
    for (k, v) in idle_runtime() {
        o.entry(k).or_insert(v);
    }
    if let Some(imp) = extra.get("imported_from") {
        o.insert("imported_from".into(), imp.clone());
    }
    Value::Object(o)
}

/// What the overlay fields read while no actor is running for the agent.
pub fn idle_runtime() -> Vec<(String, Value)> {
    vec![
        ("busy".into(), json!(false)),
        ("waiting".into(), json!(false)),
        ("queued_for_slot".into(), Value::Null),
        ("responding".into(), json!(false)),
        ("phase".into(), Value::Null),
        ("ran_as".into(), Value::Null),
        ("codex_route".into(), Value::Null),
        ("queued".into(), json!(0)),
        ("proc_warm".into(), json!(false)),
        ("proc_live".into(), json!(false)),
        ("proc_relaunch".into(), json!(false)),
        ("proc_relaunch_reason".into(), Value::Null),
        ("proc_paused".into(), json!(false)),
        ("proc_control_enabled".into(), json!(true)),
        ("proc_control_action".into(), json!("start")),
        ("proc_control_reason".into(), Value::Null),
        ("mcp_tool_count".into(), Value::Null),
        ("last_turn_mcp_tool_count".into(), Value::Null),
        ("mcp_tool_count_provider".into(), json!("")),
        ("mcp_tool_count_source".into(), Value::Null),
        ("mcp_tool_count_reason".into(), Value::Null),
        ("mcp_readiness_waiting".into(), json!(false)),
        ("mcp_readiness_state".into(), Value::Null),
        ("mcp_readiness_reason".into(), Value::Null),
        ("tasks".into(), json!(0)),
        ("bg_tasks".into(), json!(0)),
        ("activity".into(), json!({ "phase": "idle" })),
        ("cache_forecast".into(), Value::Null),
        ("ran_as_label".into(), Value::Null),
    ]
}

/// `TreeFrozen` with its countdown stamps derived from the stored record.
pub fn frozen_view(frozen: &Value) -> Value {
    if frozen.is_null() {
        return Value::Null;
    }
    let mut o = frozen.as_object().cloned().unwrap_or_default();
    let until = o.get("until").and_then(Value::as_str).and_then(parse_ts);
    o.entry("at".to_string()).or_insert(Value::Null);
    o.entry("error".to_string()).or_insert(Value::Null);
    if let Some(u) = until {
        o.insert("until".into(), json!(iso(u)));
        o.insert("until_ts".into(), json!(u.timestamp()));
        let connection = o.get("connection").and_then(Value::as_bool).unwrap_or(false);
        let grace = if connection { 0 } else { 60 };
        o.insert("wake_ts".into(), json!(u.timestamp() + grace));
    } else {
        o.entry("until".to_string()).or_insert(Value::Null);
        o.entry("until_ts".to_string()).or_insert(Value::Null);
    }
    Value::Object(o)
}
