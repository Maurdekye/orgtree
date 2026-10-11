//! On-demand usage: authorized cached lanes, with one explicit refresh.
use std::collections::BTreeMap;
use std::sync::Arc;
use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};
use crate::accounts::AccountInfo;
use crate::engine::Engine;
use crate::runtime::Caller;
use crate::usage::{query::Selection, RefreshGate};
use super::Done;

struct Lane {
    id: String,
    provider: String,
    key: String,
    account: Option<AccountInfo>,
    enabled: bool,
    local_cap: Option<i64>,
}

#[nolog]
fn lanes(engine: &Engine, org: &str) -> BTreeMap<String, Lane> {
    let mut out = BTreeMap::new();
    let view = engine.accounts.view();
    for p in ["claude", "openai", "google"] {
        let id = crate::org_accounts::primary(p);
        let key = match p { "claude" => crate::usage::claude_key(None), "openai" => crate::usage::codex_key(None), _ => "agy".into() };
        out.insert(id.clone(), Lane { id, provider: p.into(), key, account: None,
            enabled: crate::accounts::active(engine, p, None), local_cap: None });
    }
    if crate::providers::openrouter_key_set(engine) {
        out.insert("openrouter".into(), Lane {id:"openrouter".into(),provider:"openrouter".into(),
            key:"openrouter".into(),account:None,enabled:true,local_cap:None});
    }
    for a in view.all().into_iter().filter(|a| a.available_origin(org)) {
        let id = crate::org_accounts::lane_of(a);
        let key = if a.provider == "openrouter" { id.clone() }
            else if a.is_apikey() { format!("apikey:{}", a.id) }
            else { match a.provider.as_str() {
                "claude" => crate::usage::claude_key(a.config_dir.as_deref()),
                "openai" => crate::usage::codex_key(a.config_dir.as_deref()),
                "google" => "agy".into(), _ => format!("unsupported:{}", a.id),
            }};
        out.insert(id.clone(), Lane {id,provider:a.provider.clone(),key,
            enabled:crate::accounts::active(engine, &a.provider, Some(a)),account:Some(a.clone()),local_cap:None});
    }
    for srv in crate::langserver::servers(engine) {
        let Some(id) = srv["id"].as_str() else { continue };
        let id = format!("langserver:{id}");
        out.insert(id.clone(), Lane {id,provider:"langserver".into(),key:String::new(),account:None,
            enabled:srv["enabled"] != false,local_cap:Some(srv["max_agents"].as_i64().unwrap_or(1))});
    }
    out.retain(|id, _| crate::org_accounts::allowed(Some(org), id));
    out
}

#[logged]
fn selectors(args: &Value, key: &str) -> Result<Option<Vec<String>>> {
    let Some(v) = args.get(key) else { return Ok(None) };
    let Some(values) = v.as_array().filter(|v| !v.is_empty() && v.len() <= 32) else {
        crate::refuse!(BadRequest, "{key} must contain 1 through 32 exact identifiers");
    };
    let mut out = Vec::new();
    for v in values {
        let Some(s) = v.as_str().filter(|s| !s.is_empty() && s.len() <= 256) else {
            crate::refuse!(BadRequest, "{key} must contain nonempty identifier strings (at most 256 bytes)");
        };
        if !out.iter().any(|v| v == s) { out.push(s.to_string()); }
    }
    Ok(Some(out))
}

#[nolog]
fn row(engine: &Engine, lane: &Lane, own: &str, selection: &Selection) -> Value {
    let now = Utc::now();
    let mut v = if let Some(cap) = lane.local_cap {
        json!({"available":false,"reason":"unsupported","freshness":"unknown","observed_at":null,
            "age_seconds":null,"quota":"unsupported","concurrency_cap":cap,"windows":[]})
    } else { engine.usage.snapshot(&lane.key, now) };
    v["account"] = json!(lane.id);
    v["provider"] = json!(lane.provider);
    v["enabled"] = json!(lane.enabled);
    v["own_account"] = json!(lane.id == own);
    if lane.provider != "openrouter" && lane.account.as_ref().is_some_and(AccountInfo::is_apikey) {
        v["quota"] = json!("unsupported");
        v["source"] = json!("local_metering");
    }
    if v.get("source").is_none() { v["source"] = json!(if lane.local_cap.is_some() { "local_configuration" } else { "provider_cache" }); }
    if let Some(windows) = v["windows"].as_array_mut() {
        windows.retain(|w| selection.window(w));
        for w in windows {
            let marked = lane.account.as_ref().is_some_and(|a| {
                match (lane.provider.as_str(), w["group"].as_str().unwrap_or("")) {
                    ("google", "3p-5h" | "3p-weekly") => a.limited_for("agy-sonnet", now).is_some(),
                    ("google", "gemini-5h" | "gemini-weekly") => a.limited_for("flash", now).is_some(),
                    _ => a.limited(now).is_some(),
                }
            });
            w["marked"] = json!(marked);
            w["state"] = json!(if w["limited"] == true { "limited" } else if marked { "marked" }
                else if w["limited"] == false { "ok" } else { "unknown" });
        }
    }
    v
}

#[logged]
pub async fn usage(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let Some(object) = args.as_object() else { crate::refuse!(BadRequest, "usage arguments must be an object"); };
    if object.keys().any(|k| !["accounts","providers","windows","refresh","limit","cursor"].contains(&k.as_str())) {
        crate::refuse!(BadRequest, "unknown usage query argument");
    }
    let selection = Selection {accounts:selectors(args,"accounts")?, providers:selectors(args,"providers")?, windows:selectors(args,"windows")?};
    if selection.providers.as_ref().is_some_and(|v| v.iter().any(|p| !["claude","openai","google","openrouter","langserver"].contains(&p.as_str()))) {
        crate::refuse!(BadRequest, "unknown usage provider identifier");
    }
    let refresh = match args.get("refresh") { None => false, Some(Value::Bool(b)) => *b,
        _ => crate::refuse!(BadRequest, "refresh must be true or false") };
    let limit = match args.get("limit") { None => 20, Some(v) => v.as_u64().filter(|n| (1..=100).contains(n))
        .ok_or_else(|| crate::domain::UserError::BadRequest("limit must be an integer from 1 through 100".into()))? as usize };
    let cursor = match args.get("cursor") { None => None, Some(v) => Some(v.as_str().filter(|s| s.len() <= 256)
        .ok_or_else(|| crate::domain::UserError::BadRequest("cursor must be an account identifier".into()))?) };
    if refresh && (selection.accounts.as_ref().map(Vec::len) != Some(1) || cursor.is_some()) {
        crate::refuse!(BadRequest, "refresh requires exactly one explicit account and no cursor");
    }
    if refresh && !crate::domain::tool_groups::enabled(&super::caller_tools(engine, caller).await?, "runtime") {
        crate::refuse!(Forbidden, "fresh usage needs inherited runtime permission");
    }
    let available = lanes(engine, &caller.org_slug);
    if selection.accounts.as_ref().is_some_and(|ids| ids.iter().any(|id| !available.contains_key(id))) {
        crate::refuse!(Forbidden, "requested usage account is unavailable to this organization");
    }
    if cursor.is_some_and(|c| !available.contains_key(c)) {
        crate::refuse!(BadRequest, "usage cursor is unavailable in this scope");
    }
    let mut candidates: Vec<_> = available.values().filter(|l| selection.lane(&l.id,&l.provider)
        && cursor.is_none_or(|c| l.id.as_str() > c)).collect();
    let next = (candidates.len() > limit).then(|| candidates[limit - 1].id.clone());
    candidates.truncate(limit);
    if refresh && candidates.len() != 1 { crate::refuse!(BadRequest, "refresh filters must select the explicit account"); }
    // Turn admission captures account in ot.turns. A queued next account is
    // never substituted for it; an idle rig call uses the current agent row.
    let client = engine.db.get().await?;
    let a = client.query_one("SELECT provider,tier,account FROM ot.agents WHERE id=$1 AND org_id=$2", &[&caller.agent_id,&caller.org_id]).await?;
    let turn = client.query_opt("SELECT account FROM ot.turns WHERE agent_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", &[&caller.agent_id]).await?;
    let bound: Option<String> = turn.map(|r| r.get(0)).unwrap_or_else(|| a.get(2));
    let provider: String = a.get(0);
    let tier: String = a.get(1);
    drop(client);
    let own = bound.as_deref().and_then(|id| engine.accounts.view().get(id).map(crate::org_accounts::lane_of))
        .or_else(|| crate::org_accounts::tier_lane(engine,&tier)).unwrap_or_else(|| crate::org_accounts::primary(&provider));
    let mut refreshed = None;
    if refresh {
        let lane = candidates[0];
        if !lane.enabled { crate::refuse!(Forbidden, "inactive accounts can be inspected but cannot be refreshed"); }
        refreshed = Some(if lane.local_cap.is_some() { json!({"status":"unsupported"}) } else {
            match engine.usage.refresh_gate(&lane.key,&lane.provider) {
                RefreshGate::Skip(status,retry) => json!({"status":status,"retry_after_seconds":retry}),
                RefreshGate::Ready(_permit) => {
                    let succeeded = crate::usage::refresh_permitted(engine,&lane.provider,
                        lane.account.as_ref().map_or(lane.id.as_str(),|a| a.id.as_str()),
                        lane.account.as_ref().and_then(|a| a.config_dir.as_deref()),
                        lane.provider != "openrouter" && lane.account.as_ref().is_some_and(AccountInfo::is_apikey)).await;
                    json!({"status":if succeeded { "attempted" } else { "failed" }})
                }
            }
        });
        // Permissions and account allowlists can change while a provider is
        // slow. No saved request retains a removed grant or account scope.
        let tools = super::caller_tools(engine,caller).await?;
        if !crate::domain::tool_groups::enabled(&tools,"inspection") || !crate::domain::tool_groups::enabled(&tools,"runtime") {
            crate::refuse!(Forbidden, "usage permissions changed during refresh");
        }
        let current = lanes(engine,&caller.org_slug);
        if !current.get(&lane.id).is_some_and(|l| l.enabled) {
            crate::refuse!(Forbidden, "usage account changed or became unavailable during refresh");
        }
    }
    let rows: Vec<_> = candidates.iter().map(|lane| row(engine,lane,&own,&selection)).collect();
    Done::json(&json!({"as_of":crate::util::iso(Utc::now()),"cache_only":!refresh,
        "accounts":rows,"next_cursor":next,"refresh":refreshed}))
}
