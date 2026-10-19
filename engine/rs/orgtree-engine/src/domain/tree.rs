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
    /// Native continuations eligible in the published settings/auth/usage snapshots.
    pub continue_primaries: &'a std::collections::HashSet<String>,
    /// every Muse login's catalog as last read: a frozen Muse seat's choices
    pub muse: &'a crate::providers::MuseCatalogs,
    pub audiences_held: &'a crate::domain::audiences::EffectiveAudiences,
    /// the org these bodies are for: legacy org keys stay inside their org
    pub org_slug: &'a str,
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
    // The idle clock measures completion, including killed turns. Open or
    // legacy rows without an end retain their existing admission fallback.
    let at = t.get("ended_at").filter(|v| !v.is_null()).unwrap_or(&t["started_at"]);
    o.insert("at".into(), ts(at));
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
#[logged]
pub fn ask_card(raw: &Value, node_name: &str) -> Value {
    let mut o = raw["body"].as_object().cloned().unwrap_or_default();
    let mut kind = raw["kind"].clone();
    if raw["status"] == "open" {
        // Recompose at read time too: already-open cards from earlier Rust
        // builds and questions imported from 3.x must recover batch
        // navigation (and the batch submit) without being asked again.
        let parts = crate::domain::asks::Parts::of(&raw["body"]);
        let (_, body) = crate::domain::asks::compose(
            raw["uid"].as_str().unwrap_or(""), raw["rev"].as_i64().unwrap_or(1) as i32, &parts,
        );
        if body["tabs"].as_array().is_some_and(|tabs| !tabs.is_empty()) {
            o.extend(body.as_object().cloned().unwrap_or_default());
            kind = json!("batch");
        }
    }
    o.insert("id".into(), raw["uid"].clone());
    o.insert("node".into(), json!(node_name));
    o.insert("kind".into(), kind);
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

/// Effective cheap-compact setting for a node (3.x `_auto_cheap_cfg`): its own
/// override merged key by key over the org's (`org` = the org's effective
/// settings), so an override naming only `enabled` keeps the org's occupancy.
/// The occupancy is kept within 5–95%.
pub(crate) fn cheap_compact(scope: &Value, org: &Value) -> (bool, Option<f64>) {
    let node = scope.get("auto_cheap_compact").filter(|v| v.is_object());
    let base = org.get("auto_cheap_compact").filter(|v| v.is_object());
    let pick = |k: &str| node.and_then(|n| n.get(k)).filter(|v| !v.is_null()).or_else(|| base.and_then(|b| b.get(k)));
    let on = pick("enabled").and_then(Value::as_bool).unwrap_or(false);
    let occ = pick("occ").and_then(Value::as_f64).unwrap_or(crate::settings::CHEAP_COMPACT_OCC).clamp(0.05, 0.95);
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
    o.insert("peer_mail".into(), json!(super::peer_mail::enabled(&configured)));
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
    // a project's open dead letters (domain/dead_letters.rs); 0 for an agent
    o.insert("dead_letters".into(), json!(raw["x_dead_letters"].as_i64().unwrap_or(0)));
    // a project's handed-but-unacked queue jobs (ack mode in flight); 0 for an agent
    o.insert("mail_held".into(), json!(raw["x_mail_held"].as_i64().unwrap_or(0)));
    o.insert("limit_locked".into(), json!(raw["limit_locked"].as_bool().unwrap_or(false)));
    let resumable = state == "live" && !frozen.is_null() && !halted;
    o.insert("resumable".into(), json!(resumable));
    let continue_accounts: Vec<String> = if resumable && frozen.get("limit").and_then(Value::as_bool).unwrap_or(true) {
        let mut choices = ctx.accounts.continue_candidates(tier, account, ctx.org_slug);
        let already_native = account.is_none() || account.and_then(|a| ctx.accounts.get(a)).is_some_and(|a| a.ambient);
        if !already_native && ctx.continue_primaries.contains(tier) {
            choices.push(crate::org_accounts::primary(catalog::provider_of(tier)));
        }
        // a Muse seat is offered no login whose own catalog lacks its exact
        // model, pinned version included (never another login's entitlement;
        // one not read yet stays a choice: continue-on reads it, then decides)
        if catalog::is_muse(tier) {
            let model = catalog::model_for(tier, model_version);
            choices.retain(|id| {
                let login = match crate::accounts::choice(Some(id)) {
                    crate::accounts::Choice::Account(a) => ctx.accounts.get(&a),
                    _ => None,
                };
                !matches!(ctx.muse.offer(login, &model), crate::providers::MuseOffer::NotOffered(_))
            });
        }
        choices
    } else {
        Vec::new()
    };
    o.insert("continue_accounts".into(), json!(continue_accounts));
    o.insert("dnd".into(),json!(raw["x_dnd"].as_bool().unwrap_or(false)));
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
    super::audiences::project_fields(&mut o, &held);
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
                        let viewed = ts(&obj.get("viewed_at").cloned().unwrap_or(Value::Null));
                        obj.insert("viewed_at".into(), viewed);
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
    // an idle agent (no actor running) forecasts from its last cache receipt
    if let Some(f) = stored_forecast(raw, ctx.now, cc_occ) {
        o.insert("cache_forecast".into(), f);
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
    if let Some(um) = extra.get("user_mention").filter(|v| !v.is_null()) {
        o.insert("user_mention".into(), um.clone());
    }
    if raw["kind"].as_str() == Some(crate::domain::projects::KIND) {
        project_fields(&mut o);
    }
    Value::Object(o)
}

/// A project node's record (docs/rust-engine/PROJECT-NODES.md): the agent
/// fields every reader expects, emptied of what a project never has (model,
/// session, process, cache, account, credits of its own), and `kind`, which
/// the canvas draws as a project card. `mail_pending` is the mail waiting in
/// its mailbox for the fair queue.
#[nolog]
fn project_fields(o: &mut Map<String, Value>) {
    o.insert("kind".into(), json!(crate::domain::projects::KIND));
    o.insert("model_id".into(), json!(""));
    o.insert("context_window".into(), Value::Null);
    o.insert("seat".into(), json!(0.0));
    o.insert("free".into(), json!(0.0));
    o.insert("cache_forecast".into(), Value::Null);
    o.insert("serving_account".into(), Value::Null);
    o.insert("cheap_compact_on".into(), json!(false));
    o.insert("cheap_compact_occ".into(), Value::Null);
    o.insert("proc_control_enabled".into(), json!(false));
    o.insert("proc_control_reason".into(), json!("a project runs no turns"));
}

/// The prompt-cache forecast of an agent with no actor running, from the
/// receipt its last turn left: ready until the entry's lifetime ends (the
/// desk decays it on time itself), expired after. The prompt-prefix check
/// needs the agent's actor and is made when one runs.
#[logged]
pub fn stored_forecast(raw: &Value, now: DateTime<Utc>, threshold: Option<f64>) -> Option<Value> {
    let action = cold_turn_action(
        threshold,
        raw["occupancy"].as_i64(),
        raw["context_window"].as_i64().or_else(|| catalog::tier(raw["tier"].as_str().unwrap_or("")).and_then(|t| t.context).map(i64::from)),
        !raw["occupancy_est"].as_bool().unwrap_or(true) && !raw["compacted_unrun"].as_bool().unwrap_or(false),
        raw["state"] == "live" && raw["frozen"].is_null() && raw["halt"].is_null()
            && !raw["limit_locked"].as_bool().unwrap_or(false),
        raw["session_id"].as_str().is_some(),
    );
    // a language server keeps its own prompt cache and says nothing about it
    if catalog::is_langserver(raw["tier"].as_str().unwrap_or("")) {
        let codex = raw.pointer("/x_extra/harness").and_then(Value::as_str) == Some("codex-cli");
        return Some(json!({ "generation": raw["generation"].as_i64().unwrap_or(0).to_string(), "state": "uncertain",
                            "readiness": "unknown", "readiness_cause": "unsupported_capability",
                            "reason": "a language server publishes no cache data", "source": "unsupported_capability",
                            "lane": if codex { "codex" } else { "claude" }, "last_receipt_at": null,
                            "ttl_seconds": null, "expires_at": null }));
    }
    let rec = raw.pointer("/x_extra/cache_receipt")?;
    let at = rec["at"].as_str().and_then(parse_ts)?;
    let ttl = rec["ttl"].as_i64()?;
    let provider = raw["provider"].as_str().unwrap_or("claude");
    let codex_harness = raw.pointer("/x_extra/harness").and_then(Value::as_str) == Some("codex-cli");
    let lane = match provider {
        "openai" => "codex",
        "openrouter" | "langserver" if codex_harness => "codex",
        "google" => "antigravity",
        _ => "claude",
    };
    let generation = raw["generation"].as_i64().unwrap_or(0).to_string();
    let expires = at + chrono::Duration::seconds(ttl);
    Some(if now >= expires {
        json!({ "generation": generation, "state": "expired_known_entry", "readiness": "not_ready",
                "readiness_cause": "receipt_expired", "reason": "the cache entry has expired",
                "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at),
                "ttl_seconds": ttl, "expires_at": iso(expires), "precompact_action": action })
    } else {
        json!({ "generation": generation, "state": "compatible_observed", "readiness": "ready",
                "readiness_cause": "receipt_valid", "reason": "the cache entry was observed and has not expired",
                "source": "authoritative_receipt", "lane": lane, "last_receipt_at": iso(at), "ttl_seconds": ttl,
                "expires_at": iso(expires), "precompact_action": "not_applicable", "precompact_on_expiry": action })
    })
}

/// Shared by next-turn admission and both forecast sources. Estimated or
/// already-reset context cannot justify another reset (3.x parity).
#[logged]
pub fn cold_turn_action(
    threshold: Option<f64>, used: Option<i64>, window: Option<i64>,
    measured: bool, eligible: bool, has_session: bool,
) -> &'static str {
    let (Some(used), Some(window)) = (used, window) else { return "not_applicable" };
    if !measured || !has_session || used <= 0 || window <= 0 {
        return "not_applicable";
    }
    let ratio = used as f64 / window as f64;
    match threshold {
        Some(limit) if eligible && ratio >= limit => "will_compact",
        None if ratio > 0.25 => "miss_expected",
        _ => "not_applicable",
    }
}

/// What the overlay fields read while no actor is running for the agent.
pub fn idle_runtime() -> Vec<(String, Value)> {
    vec![
        ("busy".into(), json!(false)),
        ("turn_started_at".into(), Value::Null),
        ("effort_current".into(), Value::Null),
        ("pending_effort".into(), Value::Null),
        ("fast_mode_current".into(), Value::Null),
        ("waiting".into(), json!(false)),
        ("queued_for_slot".into(), Value::Null),
        ("loading_model".into(), Value::Null),
        ("responding".into(), json!(false)),
        ("phase".into(), Value::Null),
        ("ran_as".into(), Value::Null),
        ("codex_route".into(), Value::Null),
        ("queued".into(), json!(0)),
        ("proc_warm".into(), json!(false)),
        ("proc_live".into(), json!(false)),
        ("proc_held".into(), json!(false)),
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
    let until = crate::runtime::freeze::deadline(frozen);
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

#[cfg(test)]
mod project_body_tests {
    use super::*;

    #[test]
    fn a_project_record_is_marked_and_has_no_agent_machinery() {
        let mut o = Map::new();
        o.insert("model_id".into(), json!("claude-sonnet-5-5"));
        o.insert("free".into(), json!(12.0));
        o.insert("mail_pending".into(), json!(3));
        project_fields(&mut o);
        assert_eq!(o["kind"], "project");
        assert_eq!(o["model_id"], "");
        assert_eq!(o["free"], json!(0.0), "a project never has credits of its own");
        assert_eq!(o["proc_control_enabled"], false);
        assert_eq!(o["mail_pending"], 3, "its waiting mail stays visible");
    }
}

#[cfg(test)]
mod turn_clock_tests {
    use super::*;

    const START: &str = "2026-10-17T15:00:00+00:00";
    const END: &str = "2026-10-17T15:12:30+00:00";

    // Every harness finishes through Actor::end_turn, which writes the same
    // ledger timestamps. Exercise the actual shared wire projection with each
    // lane's accounting shape: no harness or UI may substitute the start time.
    fn completed(lane: &str, extra: Value) {
        let mut row = json!({"started_at":START,"ended_at":END,"ms":750000,
            "cost_usd":"0.125","toks":321,"denials":0,"model":lane});
        row.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let projected = turn_stat(&row);
        assert_eq!(projected["at"], ts(&json!(END)), "{lane} idle age must start at completion, not admission");
        assert_eq!(projected["ms"], row["ms"]);
        assert_eq!(projected["cost"], json!(0.125));
        assert_eq!(projected["toks"], row["toks"]);
        assert_eq!(projected["cost_source"], row["cost_source"]);
    }

    #[test]
    fn antigravity_completed_turn_uses_end_time() {
        completed("gemini-4-argon", json!({"cost_source":"priced"}));
    }

    #[test]
    fn claude_completed_turn_uses_end_time() {
        completed("claude-sonnet-5-5", json!({"cost_source":"cli"}));
    }

    #[test]
    fn codex_completed_turn_uses_end_time() {
        completed("gpt-6", json!({"cost_source":"priced","approvals":2}));
    }

    #[test]
    fn muse_completed_turn_uses_end_time() {
        completed("wonder", json!({"cost_source":"unknown"}));
    }

    #[test]
    fn acp_completed_turn_uses_end_time() {
        completed("openrouter/synthetic", json!({"cost_source":"unknown"}));
    }

    #[test]
    fn killed_turn_uses_its_completion_without_losing_accounting() {
        let row = json!({"started_at":START,"ended_at":END,"cost_usd":0,
            "killed":true,"estimated":true,"approvals":3,"denials":2});
        let projected = turn_stat(&row);
        assert_eq!(projected["at"], ts(&json!(END)));
        assert_eq!(projected["killed"], true);
        assert_eq!(projected["estimated"], true);
        assert_eq!(projected["approvals"], 3);
        assert_eq!(projected["denials"], 2);
    }

    #[test]
    fn open_or_legacy_turn_without_completion_keeps_start_fallback() {
        for row in [json!({"started_at":START}), json!({"started_at":START,"ended_at":null})] {
            assert_eq!(turn_stat(&row)["at"], ts(&json!(START)));
        }
        assert_eq!(turn_stat(&json!({}))["at"], Value::Null, "no invented timestamp");
    }

    #[test]
    fn imported_turn_with_equal_timestamps_keeps_its_existing_age() {
        // Both importers write the old completion timestamp into both columns.
        // Those turns masked the wrong start-only projection.
        let row = json!({"started_at":END,"ended_at":END});
        assert_eq!(turn_stat(&row)["at"], ts(&json!(END)));
    }
}

#[cfg(test)]
mod idle_runtime_tests {
    use super::*;

    #[test]
    fn an_idle_agent_names_no_running_turn() {
        // the overlay a node gets when its actor stops: a turn start left
        // behind would let the desk time an earlier turn's open call as the
        // running turn's (docket tool-calls-left-open-by-an-earlier-turn-count-up)
        let idle: HashMap<String, Value> = idle_runtime().into_iter().collect();
        assert_eq!(idle.get("turn_started_at"), Some(&Value::Null));
        assert_eq!(idle.get("fast_mode_current"), Some(&Value::Null));
        assert_eq!(idle.get("busy"), Some(&json!(false)));
    }
}
