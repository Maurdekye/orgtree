//! Settings: per-org settings and hire defaults, app-wide defaults, org.md,
//! runtime settings, provider switches, charters and the folder browser.

use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::domain::scope;
use crate::engine::Engine;
use crate::feed::groups::{effective_settings, setting_defaults};
use crate::changes::{self, Change};
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::runtime::AgentMsg;

/// Keys an org's settings document may hold (others are refused or inert).
const ORG_KEYS: &[&str] = &[
    "max_top_grant", "default_top_grant", "compact_at", "default_tools", "default_visibility", "default_account",
    "permission_mode", "default_effort", "auto_resume", "auto_resume_compact", "auto_cheap_compact", "cascade_hire",
    "cascade_alloc", "org_inbox_multi_holder", "account_fallback_default", "headless",
];

/// Settings of removed features: accepted and ignored (the UI no longer shows them).
const INERT_KEYS: &[&str] = &[
    "fable_limit_policy", "fable_filter_policy", "fable_filter_model", "clear_fable_lock", "prefer_reserve",
    "clear_prefer_reserve",
];

#[logged]
fn dirs_of(v: &Value) -> (Vec<Value>, Vec<String>) {
    let mut warnings = Vec::new();
    let dirs = scope::normalize(&json!({ "add_dirs": v }))["add_dirs"].as_array().cloned().unwrap_or_default();
    for d in &dirs {
        if let Some(p) = d["path"].as_str() {
            if !FsPath::new(p).is_dir() {
                warnings.push(format!("{p} does not exist (yet); agents cannot use it until it does"));
            }
        }
    }
    (dirs, warnings)
}

/// 3.x's org_dirs edit (native storage, `_org_settings_apply`): a folder
/// taken off the org is revoked from every top-level grant, and one turned
/// read-only is downgraded there; descendants follow their parent chain.
/// Adding a folder back, or making it read/write again, reaches only future
/// hires (an upgrade is granted per agent), never a grant the edit took
/// away. The workspace is not one of these folders. Returns 3.x's warnings.
#[logged]
async fn sweep_top_grants(
    client: &impl tokio_postgres::GenericClient,
    org_id: i64,
    workspace: &str,
    old: &Value,
    new: &[Value],
) -> anyhow::Result<Vec<String>> {
    let ws = scope::norm_path(workspace);
    let held = |dirs: &[Value]| -> Vec<(String, String, String)> {
        dirs.iter()
            .filter_map(|d| {
                let p = d["path"].as_str()?;
                let k = scope::norm_path(p);
                (k != ws).then(|| (k, p.to_string(), d["mode"].as_str().unwrap_or("rw").to_string()))
            })
            .collect()
    };
    let old = held(old.as_array().map(Vec::as_slice).unwrap_or_default());
    let new = held(new);
    let gone: Vec<&(String, String, String)> = old.iter().filter(|(k, ..)| !new.iter().any(|(n, ..)| n == k)).collect();
    let down: Vec<&(String, String, String)> = new
        .iter()
        .filter(|(k, _, m)| m == "ro" && old.iter().any(|(o, _, om)| o == k && om == "rw"))
        .collect();
    if gone.is_empty() && down.is_empty() {
        return Ok(Vec::new());
    }
    let rows = client
        .query(
            "SELECT id, name, scope FROM ot.agents WHERE org_id = $1 AND parent_id IS NULL AND state <> 'deleted'
              ORDER BY sibling_order, id FOR UPDATE",
            &[&org_id],
        )
        .await?;
    let mut warnings = Vec::new();
    let mut downgraded = vec![0usize; down.len()];
    for r in &rows {
        let (id, name, mut sc): (i64, String, Value) = (r.get(0), r.get(1), r.get(2));
        let Some(dirs) = sc.get_mut("add_dirs").and_then(Value::as_array_mut) else { continue };
        let mut changed = false;
        for (k, path, _) in &gone {
            let n = dirs.len();
            dirs.retain(|d| d["path"].as_str().map(|p| scope::norm_path(p) != *k).unwrap_or(true));
            if dirs.len() != n {
                warnings.push(format!("revoked {path} from {name}"));
                changed = true;
            }
        }
        for d in dirs.iter_mut() {
            let Some(k) = d["path"].as_str().map(scope::norm_path) else { continue };
            if let Some(i) = down.iter().position(|(dk, ..)| *dk == k) {
                if d["mode"].as_str() != Some("ro") {
                    d["mode"] = json!("ro");
                    downgraded[i] += 1;
                    changed = true;
                }
            }
        }
        if changed {
            client.execute("UPDATE ot.agents SET scope = $2, row_version = row_version + 1 WHERE id = $1", &[&id, &sc]).await?;
        }
    }
    for ((_, path, _), n) in down.iter().zip(downgraded) {
        if n > 0 {
            warnings.push(format!(
                "downgraded {path} to read-only on {n} top-level grants; descendant permissions follow their current parent chain"
            ));
        }
    }
    Ok(warnings)
}

/// 3.x's value checks on an org setting (the Settings body,
/// set_hire_defaults): a bad value is refused (422) rather than stored,
/// where it would reach every later hire, or the CLI. `org` is the org whose
/// legacy org keys may be named (None: the app-wide defaults).
#[logged]
fn checked(e: &Engine, org: Option<&str>, key: &str, v: &Value) -> ApiResult<Value> {
    let bad = |why: String| Err(ApiError::unprocessable(why));
    match key {
        "permission_mode" => match v.as_str() {
            Some(m) if scope::PM_LEVELS.contains(&m) => Ok(v.clone()),
            _ => bad(format!("permission_mode must be one of {}", scope::levels_text(scope::PM_LEVELS))),
        },
        "default_visibility" => match v.as_str() {
            Some(m) if scope::VIS_LEVELS.contains(&m) => Ok(v.clone()),
            _ => bad(format!("default_visibility must be one of {}", scope::levels_text(scope::VIS_LEVELS))),
        },
        "default_effort" => match v.as_str() {
            Some(x) if x.is_empty() || crate::providers::catalog::EFFORTS.contains(&x) => Ok(v.clone()),
            _ => bad(format!(
                "default_effort must be '' (the CLI's own default) or one of {}",
                scope::levels_text(crate::providers::catalog::EFFORTS)
            )),
        },
        "default_account" => match v.as_str().map(str::trim) {
            None => bad("default_account must be an account id ('' for none)".into()),
            Some(a) if a.is_empty() || ["primary", "default", "claude/primary", "openai/primary", "google/primary"].contains(&a) => {
                Ok(json!(a))
            }
            Some(a) => match e.accounts.view().get(a) {
                None => bad(format!("no account '{a}' is registered")),
                Some(acc) if !acc.available_to(org) => bad(format!(
                    "account {a} is an org key restricted to its origin organization '{}'",
                    acc.origin_org.clone().unwrap_or_default()
                )),
                Some(_) => Ok(json!(a)),
            },
        },
        "default_tools" if v.is_object() => Ok(scope::normalize_tools(v)),
        "default_tools" => bad("default_tools is an object of tool switches".into()),
        "auto_resume" | "auto_resume_compact" | "cascade_hire" | "cascade_alloc" | "org_inbox_multi_holder"
        | "account_fallback_default" | "headless" => {
            if v.is_boolean() {
                Ok(v.clone())
            } else {
                bad(format!("{key} must be true or false"))
            }
        }
        "max_top_grant" | "default_top_grant" | "compact_at" if !v.is_number() => bad(format!("{key} must be a number")),
        _ => Ok(v.clone()),
    }
}

/// Every running agent of the org restarts its CLI before its next turn.
#[logged]
pub async fn reconfigure_org(engine: &Engine, org_id: i64) -> anyhow::Result<()> {
    let client = engine.db.get().await?;
    let ids: Vec<i64> = client
        .query("SELECT id FROM ot.agents WHERE org_id = $1 AND state = 'live'", &[&org_id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    drop(client);
    for id in ids {
        if let Some(h) = engine.agents.get(id) {
            h.send(AgentMsg::Reconfigured);
        }
    }
    Ok(())
}

#[logged]
pub async fn save_org(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let mut patch = Map::new();
    let mut warnings = Vec::new();
    for (k, v) in &b {
        if v.is_null() {
            continue;
        }
        match k.as_str() {
            "org_dirs" => {
                // 3.x: a malformed entry is refused, never read as "no folders"
                let entries = v.as_array().ok_or_else(|| ApiError::unprocessable("org_dirs is a list of folders"))?;
                if let Some(bad) = entries.iter().find(|d| !(d.is_string() || d.get("path").is_some_and(Value::is_string))) {
                    return Err(ApiError::unprocessable(format!("org_dirs entries must be a path string or {{path, mode}} — got {bad}")));
                }
                let (dirs, w) = dirs_of(v);
                warnings.extend(w);
                patch.insert("dirs".into(), Value::Array(dirs));
            }
            // a negative cap or default grant is ignored, as 3.x did (a cap of 0 is
            // stored: uncapped, D-014)
            "max_top_grant" | "default_top_grant" if v.as_f64().is_some_and(|c| c < 0.0) => {}
            "net_autoconnect" | "net_hubs" | "net_hub_address" => {}
            key if ORG_KEYS.contains(&key) => {
                patch.insert(key.into(), checked(&e, Some(&o.slug), key, v)?);
            }
            key if INERT_KEYS.contains(&key) => {}
            other => return Err(ApiError::bad_request(format!("unknown setting {other}"))),
        }
    }
    if let Some(acc) = patch.get("auto_cheap_compact") {
        // checked whole here; merged with the stored value below
        crate::settings::cheap_compact(acc, &Value::Null, true).map_err(ApiError::unprocessable)?;
    }
    if let Some(c) = patch.get("compact_at").and_then(Value::as_f64) {
        if !(50.0..=95.0).contains(&c) {
            return Err(ApiError::bad_request("compact_at is a percentage between 50 and 95"));
        }
    }
    let mut conn = e.db.get().await?;
    let client = conn.transaction().await?;
    let old: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR UPDATE", &[&o.id]).await?.get(0);
    if let Some(acc) = patch.remove("auto_cheap_compact") {
        // 3.x: a partial write keeps the other current value; occ stays within 5–95%
        let current = effective_settings(&old, &e.settings.defaults())["auto_cheap_compact"].clone();
        if let Some(v) = crate::settings::cheap_compact(&acc, &current, true).map_err(ApiError::unprocessable)? {
            patch.insert("auto_cheap_compact".into(), v);
        }
    }
    if patch.get("org_inbox_multi_holder").and_then(Value::as_bool) == Some(false) {
        let holders = crate::domain::orginbox::live_holders(&*client, o.id, true).await?;
        if holders.len() > 1 { return Err(ApiError::bad_request("revoke extra org-inbox holders before disabling multi-holder mode")); }
    }
    let row = client
        .query_one(
            "UPDATE ot.orgs SET settings = settings || $2, row_version = row_version + 1 WHERE id = $1 RETURNING settings",
            &[&o.id, &Value::Object(patch.clone())],
        )
        .await?;
    let stored: Value = row.get(0);
    if let Some(Value::Array(dirs)) = patch.get("dirs") {
        let workspace = e.cfg.workspace_dir(&o.slug).to_string_lossy().to_string();
        warnings.extend(sweep_top_grants(&*client, o.id, &workspace, &old["dirs"], dirs).await?);
    }
    if let Some(cap) = patch.get("max_top_grant").and_then(Value::as_f64).filter(|c| *c > 0.0) {
        // D-014: existing grants above a lowered cap are kept (the cap binds
        // increases), and the user is told which (3.x)
        let over: Vec<String> = client
            .query(
                "SELECT name, grant_credits::float8 FROM ot.agents
                  WHERE org_id = $1 AND parent_id IS NULL AND state = 'live' AND grant_credits > $2::float8
                  ORDER BY sibling_order, id",
                &[&o.id, &cap],
            )
            .await?
            .iter()
            .map(|r| format!("{} (grant {})", r.get::<_, String>(0), crate::util::round2(r.get::<_, f64>(1))))
            .collect();
        if !over.is_empty() {
            warnings.push(format!("top-level grants already above the new cap (kept as-is; the cap binds increases): {}", over.join(", ")));
        }
    }
    // the network settings live beside the settings document
    if b.contains_key("net_autoconnect") || b.contains_key("net_hubs") {
        let mut net = Map::new();
        if let Some(h) = b.get("net_hubs").filter(|v| v.is_array()) {
            net.insert("hubs".into(), h.clone());
        }
        // 3.x: auto-connect on adds this computer's hub to the org's list
        // (first), off takes it out
        if let Some(a) = b.get("net_autoconnect").and_then(Value::as_bool) {
            net.insert("autoconnect".into(), json!(a));
            let stored: Option<Value> = client.query_one("SELECT net->'hubs' FROM ot.orgs WHERE id = $1", &[&o.id]).await?.get(0);
            let mut hubs: Vec<Value> = net.get("hubs").or(stored.as_ref()).and_then(Value::as_array).cloned().unwrap_or_default();
            let local = json!(crate::net::LOCAL_HUB_ID);
            let has_local = hubs.iter().any(|h| h["id"] == local);
            if a && !has_local {
                hubs.insert(0, json!({ "id": crate::net::LOCAL_HUB_ID, "address": crate::net::local_address(&e), "enabled": true }));
            } else if !a && has_local {
                hubs.retain(|h| h["id"] != local);
                warnings.push("local hub entry removed — the org no longer auto-connects".to_string());
            }
            net.insert("hubs".into(), Value::Array(hubs));
        }
        client
            .execute("UPDATE ot.orgs SET net = net || $2 WHERE id = $1", &[&o.id, &Value::Object(net)])
            .await?;
        crate::net::kick(&e);
    }
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'settings', '@user', $2)",
            &[&o.id, &Value::Object(patch.clone())],
        )
        .await?;
    client.commit().await?;
    drop(conn);
    changes::notify(&e, &o, vec![Change::Org, Change::Events]);
    if patch.contains_key("dirs") || patch.contains_key("permission_mode") {
        reconfigure_org(&e, o.id).await?;
    }
    let eff = effective_settings(&stored, &e.settings.defaults());
    Ok(Json(json!({ "dirs": eff["dirs"], "warnings": warnings })))
}

/// The org's hire defaults (tools, visibility, effort, account).
#[logged]
pub async fn save_org_defaults(
    State(e): State<Arc<Engine>>,
    Path(slug): Path<String>,
    Json(b): Json<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    let mut keep = Map::new();
    for k in ["default_tools", "default_visibility", "default_effort", "default_account"] {
        if let Some(v) = b.get(k) {
            keep.insert(k.into(), v.clone());
        }
    }
    let Json(_) = save_org(State(e), Path(slug), Json(keep)).await?;
    Ok(Json(json!({})))
}

#[logged]
fn defaults_payload(engine: &Engine) -> Value {
    let mut out = setting_defaults();
    if let Some(o) = out.as_object_mut() {
        for (k, v) in engine.settings.defaults() {
            o.insert(k, v);
        }
        // the defaults form reads the threshold as a fraction
        let frac = crate::feed::groups::compact_frac(&o.get("compact_at").cloned().unwrap_or(Value::Null));
        o.insert("compact_at".into(), json!(frac));
    }
    out
}

#[logged]
pub async fn get_defaults(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(defaults_payload(&e)))
}

#[logged]
pub async fn save_defaults(State(e): State<Arc<Engine>>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut defaults = Map::new();
    let mut top = Map::new();
    for (k, v) in &b {
        match k.as_str() {
            "org_dirs" => {
                defaults.insert("dirs".into(), Value::Array(dirs_of(v).0));
            }
            "net_hub_address" => {
                top.insert("net_hub_address".into(), v.clone());
            }
            "auto_cheap_compact" if !v.is_null() => {
                let current = effective_settings(&Value::Null, &e.settings.defaults())["auto_cheap_compact"].clone();
                if let Some(acc) = crate::settings::cheap_compact(v, &current, true).map_err(ApiError::unprocessable)? {
                    defaults.insert("auto_cheap_compact".into(), acc);
                }
            }
            key if ORG_KEYS.contains(&key) && !v.is_null() => {
                defaults.insert(key.into(), checked(&e, None, key, v)?);
            }
            key if ORG_KEYS.contains(&key) => {
                defaults.insert(key.into(), v.clone());
            }
            key if INERT_KEYS.contains(&key) || key == "net_autoconnect" || key == "net_hubs" => {}
            other => return Err(ApiError::bad_request(format!("unknown setting {other}"))),
        }
    }
    top.insert("defaults".into(), Value::Object(defaults));
    let mut client = e.db.get().await?;
    e.settings.merge(&mut client, Value::Object(top)).await?;
    drop(client);
    for o in e.orgs.all() {
        changes::notify(&e, &o, vec![Change::Org]);
    }
    Ok(Json(defaults_payload(&e)))
}

// ------------------------------------------------------------ org.md

const ORGMD_EDIT_MAX: usize = 200_000;
pub const ORGMD_PROMPT_MAX: usize = 16_000;

#[logged]
pub async fn get_orgmd(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let path = e.cfg.workspace_dir(&o.slug).join("org.md");
    // 3.x orgmd_get: no file is an empty charter, but a file that exists and
    // cannot be read is an error — an empty editor would let a save erase it.
    // Undecodable bytes are replaced, as 3.x read with errors="replace".
    let content = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(ApiError::internal(format!("org.md could not be read: {err}"))),
    };
    let chars = content.chars().count();
    let truncated = chars > ORGMD_EDIT_MAX;
    let shown: String = if truncated { content.chars().take(ORGMD_EDIT_MAX).collect() } else { content };
    Ok(Json(json!({
        "path": path.to_string_lossy(), "content": shown, "chars": chars, "read_truncated": truncated,
        "edit_max": ORGMD_EDIT_MAX, "prompt_max": ORGMD_PROMPT_MAX,
    })))
}

#[derive(Deserialize, Debug)]
pub struct OrgMdBody {
    content: String,
}

#[logged]
pub async fn put_orgmd(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<OrgMdBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let chars = b.content.chars().count();
    if chars > ORGMD_EDIT_MAX {
        return Err(ApiError::bad_request(format!("org.md is limited to {ORGMD_EDIT_MAX} characters")));
    }
    let dir = e.cfg.workspace_dir(&o.slug);
    std::fs::create_dir_all(&dir).map_err(|x| ApiError::internal(x.to_string()))?;
    let path = dir.join("org.md");
    std::fs::write(&path, &b.content).map_err(|x| ApiError::internal(x.to_string()))?;
    let mut warnings = Vec::new();
    if chars > ORGMD_PROMPT_MAX {
        warnings.push(format!("only the first {ORGMD_PROMPT_MAX} characters reach agents' instructions"));
    }
    // the system prompt changed: running CLIs restart before their next turn
    reconfigure_org(&e, o.id).await?;
    Ok(Json(json!({ "path": path.to_string_lossy(), "bytes": b.content.len(), "chars": chars,
                    "prompt_max": ORGMD_PROMPT_MAX, "prompt_truncated": chars > ORGMD_PROMPT_MAX, "warnings": warnings })))
}

// ------------------------------------------------------------ runtime settings

#[logged]
async fn runtime_payload(engine: &Engine) -> Value {
    let sw = crate::runtime::reminders::switches(engine);
    let stats = engine.sched.stats().await;
    let by_org: Map<String, Value> = stats
        .waiting_by_org
        .iter()
        .filter_map(|(id, n)| engine.orgs.by_id(*id).map(|o| (o.slug.clone(), json!(n))))
        .collect();
    json!({
        "enter_key_behavior": engine.settings.enter_key_behavior(),
        "quick_staff_behavior": engine.settings.quick_staff_behavior(),
        "quick_staff_request_accounts": false,
        "git_periodic_fetch_enabled": false,
        "warming_enabled": engine.settings.keep_warm(),
        "antigravity_claude_enabled": engine.settings.antigravity_claude_enabled(),
        "working_checkups_enabled": sw.checkups,
        "wait_for_mcp_tools_enabled": engine.settings.wait_for_mcp_tools(),
        "idle_docket_reminders_enabled": sw.idle,
        "blocked_docket_reminders_enabled": sw.blocked,
        "max_concurrent_turns": engine.settings.max_concurrent_turns(),
        "turn_timeout_s": engine.settings.turn_timeout_s(),
        "turn_idle_s": engine.settings.turn_idle_s(),
        "verbose_logging": crate::trace::verbose(),
        "verbose_logging_pinned": crate::trace::pinned().is_some(),
        "turn_slots": { "limit": stats.limit, "held": stats.held, "waiting": stats.waiting, "waiting_by_org": by_org },
    })
}

#[logged]
pub async fn get_runtime(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(runtime_payload(&e).await))
}

#[logged]
pub async fn put_runtime(State(e): State<Arc<Engine>>, Json(b): Json<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let mut rt = Map::new();
    let mut verbose = None;
    let mut warming = None;
    for (k, v) in &b {
        match k.as_str() {
            "antigravity_claude_enabled" => {
                let on = v.as_bool().ok_or_else(|| ApiError::bad_request("antigravity_claude_enabled is true or false"))?;
                rt.insert(k.clone(), json!(on));
            }
            "enter_key_behavior" => {
                let mode = v.as_str().filter(|s| ["send", "newline"].contains(s))
                    .ok_or_else(|| ApiError::bad_request("enter_key_behavior is send or newline"))?;
                rt.insert(k.clone(), json!(mode));
            }
            "verbose_logging" => {
                let on = v.as_bool().ok_or_else(|| ApiError::bad_request("verbose_logging is true or false"))?;
                rt.insert(k.clone(), json!(on));
                verbose = Some(on);
            }
            "enabled" | "warming_enabled" => {
                let on = v.as_bool().unwrap_or(true);
                rt.insert("warming_enabled".into(), json!(on));
                warming = Some(on);
            }
            "wait_for_mcp_tools_enabled" => {
                rt.insert(k.clone(), json!(v.as_bool().unwrap_or(false)));
            }
            "max_concurrent_turns" => {
                let n = v.as_u64().filter(|n| (1..=1024).contains(n)).ok_or_else(|| {
                    ApiError::bad_request("max_concurrent_turns is a number from 1 to 1024")
                })?;
                rt.insert(k.clone(), json!(n));
                e.sched.set_limit(n as usize);
            }
            "turn_timeout_s" | "turn_idle_s" => {
                let n = v.as_u64().ok_or_else(|| ApiError::bad_request(format!("{k} is a number of seconds (0 = off)")))?;
                rt.insert(k.clone(), json!(n));
            }
            "quick_staff_behavior" => {
                let s = v.as_str().unwrap_or("request");
                if !["request", "under_assignee", "top_level"].contains(&s) {
                    return Err(ApiError::bad_request("quick_staff_behavior is request, under_assignee or top_level"));
                }
                rt.insert(k.clone(), json!(s));
            }
            // stored under the 3.x keys, so an imported app-settings.json keeps the user's choice
            "working_checkups_enabled" | "idle_docket_reminders_enabled" | "blocked_docket_reminders_enabled" => {
                let on = v.as_bool().ok_or_else(|| ApiError::bad_request(format!("{k} is true or false")))?;
                let key = match k.as_str() {
                    "working_checkups_enabled" => crate::runtime::reminders::KEY_CHECKUPS,
                    "idle_docket_reminders_enabled" => crate::runtime::reminders::KEY_IDLE,
                    _ => crate::runtime::reminders::KEY_BLOCKED,
                };
                rt.insert(key.into(), json!(on));
            }
            // the settings of removed features are accepted and ignored
            "git_periodic_fetch_enabled" | "quick_staff_request_accounts" => {}
            other => return Err(ApiError::bad_request(format!("unknown runtime setting {other}"))),
        }
    }
    let mut client = e.db.get().await?;
    e.settings.merge(&mut client, json!({ "runtime": rt })).await?;
    drop(client);
    if b.contains_key("antigravity_claude_enabled") {
        crate::providers::publish(&e);
        for org in e.orgs.all() {
            changes::notify(&e, &org, vec![Change::Tiers]);
        }
        if e.settings.antigravity_claude_enabled() {
            crate::accounts::wake_waiting(&e, crate::accounts::Waiting::Native("google".into())).await;
            if e.settings.keep_warm() { crate::runtime::warm_all(&e); }
        }
    }
    if b.contains_key("enter_key_behavior") {
        e.app.set_value("enter_key_behavior", json!(e.settings.enter_key_behavior()));
    }
    if let Some(on) = verbose {
        crate::trace::apply_verbose(on);
    }
    match warming {
        Some(true) => crate::runtime::warm_all(&e),
        Some(false) => crate::runtime::cool_all(&e),
        None => {}
    }
    Ok(Json(runtime_payload(&e).await))
}

// ------------------------------------------------------------ providers

#[logged]
pub async fn get_providers(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(crate::providers::payload(&e)))
}

#[derive(Deserialize, Debug)]
pub struct Enabled {
    enabled: bool,
}

#[logged]
async fn provider_switch(e: Arc<Engine>, provider: String, key: &'static str, enabled: bool) -> ApiResult<Json<Value>> {
    let known = [
        crate::providers::catalog::CLAUDE,
        crate::providers::catalog::OPENAI,
        crate::providers::catalog::GOOGLE,
        crate::providers::catalog::OPENROUTER,
    ];
    if !known.contains(&provider.as_str()) {
        return Err(ApiError::not_found(format!("no provider {provider}")));
    }
    let mut inner = Map::new();
    inner.insert(provider.clone(), json!(enabled));
    let mut outer = Map::new();
    outer.insert(key.to_string(), Value::Object(inner));
    let mut client = e.db.get().await?;
    e.settings.merge(&mut client, Value::Object(outer)).await?;
    drop(client);
    crate::providers::publish(&e);
    for o in e.orgs.all() {
        changes::notify(&e, &o, vec![Change::Tiers]);
    }
    if enabled {
        match key {
            "providers" => crate::accounts::wake_waiting(&e, crate::accounts::Waiting::Provider(provider.clone())).await,
            "subscription_inference" => crate::accounts::wake_waiting(&e, crate::accounts::Waiting::Native(provider.clone())).await,
            _ => {}
        }
    }
    Ok(Json(crate::providers::payload(&e)))
}

#[logged]
pub async fn provider_enabled(State(e): State<Arc<Engine>>, Path(p): Path<String>, Json(b): Json<Enabled>) -> ApiResult<Json<Value>> {
    provider_switch(e, p, "providers", b.enabled).await
}

#[logged]
pub async fn provider_apikey_fallback(State(e): State<Arc<Engine>>, Path(p): Path<String>, Json(b): Json<Enabled>) -> ApiResult<Json<Value>> {
    provider_switch(e, p, "apikey_fallback", b.enabled).await
}

#[logged]
pub async fn provider_subscription_inference(
    State(e): State<Arc<Engine>>,
    Path(p): Path<String>,
    Json(b): Json<Enabled>,
) -> ApiResult<Json<Value>> {
    provider_switch(e, p, "subscription_inference", b.enabled).await
}

#[logged]
pub async fn mcp_servers(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    let reg = e.providers.mcp_registry();
    let mut names: Vec<String> = reg.servers.iter().map(|(n, _)| n.clone()).filter(|n| n != "orgtree").collect();
    names.sort();
    Ok(Json(json!({ "servers": names })))
}

// ------------------------------------------------------------ charters

const BUNDLED: &[(&str, &str)] = &[
    ("business.md", include_str!("../../../../docs/charters/business.md")),
    ("coordinator.md", include_str!("../../../../docs/charters/coordinator.md")),
    ("curator.md", include_str!("../../../../docs/charters/curator.md")),
    ("implementer.md", include_str!("../../../../docs/charters/implementer.md")),
    ("redteam.md", include_str!("../../../../docs/charters/redteam.md")),
];
const PRESET_MAX: usize = 100_000;
const CHARTER_LONG: usize = 12_000;

fn user_charter_dir() -> PathBuf {
    crate::rig::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".orgtree").join("charters")
}

fn title_of(file: &str) -> String {
    file.trim_end_matches(".md").replace(['-', '_'], " ")
}

#[logged]
fn template_dirs(engine: &Engine) -> Vec<String> {
    engine
        .settings
        .get()
        .get("charter_template_dirs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[logged]
fn scan_dir(dir: &FsPath) -> (Value, Vec<(String, PathBuf)>) {
    let mut files = Vec::new();
    let status = if !dir.exists() {
        "missing"
    } else if !dir.is_dir() {
        "not_directory"
    } else {
        match std::fs::read_dir(dir) {
            Ok(rd) => {
                for ent in rd.flatten() {
                    let p = ent.path();
                    if p.extension().map(|x| x == "md").unwrap_or(false) && p.is_file() {
                        files.push((ent.file_name().to_string_lossy().to_string(), p));
                    }
                }
                "ok"
            }
            Err(_) => "unreadable",
        }
    };
    files.sort();
    (json!({ "path": dir.to_string_lossy(), "status": status, "count": files.len() }), files)
}

#[logged]
pub async fn charters(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    let mut out = Vec::new();
    let user = user_charter_dir();
    let (_, user_files) = scan_dir(&user);
    let shadowed: Vec<String> = user_files.iter().map(|(f, _)| f.clone()).collect();
    let entry = |file: &str, path: &FsPath, content: &str, source: &str, dir: Option<&FsPath>| {
        let chars = content.chars().count();
        let shown: String = content.chars().take(PRESET_MAX).collect();
        let mut v = json!({ "name": title_of(file), "file": file, "path": path.to_string_lossy(), "content": shown,
                            "chars": chars, "truncated": chars > PRESET_MAX, "source": source });
        if let Some(d) = dir {
            v["dir"] = json!(d.to_string_lossy());
        }
        v
    };
    for (f, p) in &user_files {
        if let Ok(c) = std::fs::read_to_string(p) {
            out.push(entry(f, p, &c, "user", None));
        }
    }
    for (f, c) in BUNDLED {
        if !shadowed.iter().any(|s| s == f) {
            out.push(entry(f, &PathBuf::from(format!("bundled/{f}")), c, "bundled", None));
        }
    }
    let mut states = Vec::new();
    for d in template_dirs(&e) {
        let dir = PathBuf::from(&d);
        let (state, files) = scan_dir(&dir);
        states.push(state);
        for (f, p) in files {
            if let Ok(c) = std::fs::read_to_string(&p) {
                out.push(entry(&f, &p, &c, "external", Some(&dir)));
            }
        }
    }
    let mut payload = json!({ "charters": out, "preset_max": PRESET_MAX, "user_dir": user.to_string_lossy(),
                              "charter_long": CHARTER_LONG });
    if !states.is_empty() {
        payload["template_dirs"] = Value::Array(states);
    }
    Ok(Json(payload))
}

#[logged]
pub async fn charters_populate() -> ApiResult<Json<Value>> {
    let dir = user_charter_dir();
    std::fs::create_dir_all(&dir).map_err(|x| ApiError::internal(x.to_string()))?;
    let mut created = Vec::new();
    let mut existing = Vec::new();
    for (f, c) in BUNDLED {
        let p = dir.join(f);
        if p.exists() {
            existing.push(f.to_string());
        } else if std::fs::write(&p, c).is_ok() {
            created.push(f.to_string());
        }
    }
    Ok(Json(json!({ "dir": dir.to_string_lossy(), "created": created, "existing": existing })))
}

/// 3.x `CHARTER_NAME`: `[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,118}[A-Za-z0-9])?`.
#[logged]
fn charter_name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 120
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'_' | b'-'))
}

/// 3.x `desktop_import._plain`: refuse when the path or any existing ancestor
/// is a link or reparse point (a junction planted at the charters folder
/// would receive every write).
#[logged]
fn plain_path(path: &FsPath) -> Result<(), String> {
    for part in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let Ok(md) = std::fs::symlink_metadata(part) else { continue };
        #[cfg(windows)]
        let reparse = std::os::windows::fs::MetadataExt::file_attributes(&md) & 0x400 != 0;
        #[cfg(not(windows))]
        let reparse = false;
        if md.file_type().is_symlink() || reparse {
            return Err(format!("Links and reparse points are not imported: {}", part.display()));
        }
    }
    Ok(())
}

#[derive(Deserialize, Debug)]
pub struct CharterDoc {
    content: String,
}

/// `PUT /api/charters/{name}` (3.x `charters_save`): save one charter
/// document as `~/.orgtree/charters/<name>.md`; the next `/api/charters`
/// read serves it. Bundled presets and per-agent charters are untouched.
#[logged]
pub async fn charters_save(Path(name): Path<String>, Json(body): Json<CharterDoc>) -> ApiResult<Json<Value>> {
    if !charter_name_ok(&name) {
        return Err(ApiError::unprocessable("charter names are plain words, digits, spaces, - and _"));
    }
    if body.content.chars().count() > PRESET_MAX {
        return Err(ApiError::unprocessable(format!("charter documents are bounded at {PRESET_MAX} characters")));
    }
    let dir = user_charter_dir();
    plain_path(&dir).map_err(ApiError::conflict)?;
    std::fs::create_dir_all(&dir).map_err(|x| ApiError::internal(format!("Could not create charter directory: {x}")))?;
    let target = dir.join(format!("{name}.md"));
    // writing FOLLOWS a link and truncates its target: refuse the link itself
    plain_path(&target).map_err(ApiError::conflict)?;
    std::fs::write(&target, body.content.as_bytes())
        .map_err(|x| ApiError::unavailable(format!("Could not save the charter document: {x}")))?;
    let abs = std::path::absolute(&target).unwrap_or(target);
    Ok(Json(json!({ "saved": format!("{name}.md"), "path": abs.to_string_lossy() })))
}

#[logged]
pub async fn charters_open() -> ApiResult<Json<Value>> {
    let dir = user_charter_dir();
    let _ = std::fs::create_dir_all(&dir);
    let ok = std::process::Command::new("explorer.exe").arg(&dir).spawn().is_ok();
    Ok(Json(json!({ "ok": ok, "path": dir.to_string_lossy() })))
}

#[logged]
fn template_dirs_payload(engine: &Engine) -> Value {
    let dirs = template_dirs(engine);
    let mut states = Vec::new();
    let mut seen: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    for d in &dirs {
        let (state, files) = scan_dir(FsPath::new(d));
        states.push(state);
        for (f, p) in files {
            seen.entry(title_of(&f)).or_default().push(json!({ "source": "external", "path": p.to_string_lossy() }));
        }
    }
    let duplicates: Vec<Value> = seen
        .into_iter()
        .filter(|(_, l)| l.len() > 1)
        .map(|(name, locations)| json!({ "name": name, "locations": locations }))
        .collect();
    json!({ "dirs": dirs, "max_dirs": 16, "directories": states, "duplicates": duplicates })
}

#[logged]
pub async fn get_template_dirs(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(template_dirs_payload(&e)))
}

#[derive(Deserialize, Debug)]
pub struct TemplateDirs {
    dirs: Vec<String>,
}

#[logged]
pub async fn put_template_dirs(State(e): State<Arc<Engine>>, Json(b): Json<TemplateDirs>) -> ApiResult<Json<Value>> {
    let dirs: Vec<String> = b.dirs.into_iter().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).take(16).collect();
    let mut client = e.db.get().await?;
    e.settings.merge(&mut client, json!({ "charter_template_dirs": null })).await?;
    e.settings.merge(&mut client, json!({ "charter_template_dirs": dirs })).await?;
    drop(client);
    Ok(Json(template_dirs_payload(&e)))
}

// ------------------------------------------------------------ folders

#[derive(Deserialize, Debug)]
pub struct FsQuery {
    #[serde(default)]
    path: String,
}

/// The folder picker: subfolders of `path`, or the drives and home.
#[logged]
pub async fn fs(Query(q): Query<FsQuery>) -> ApiResult<Json<Value>> {
    let home = crate::rig::home_dir().map(|h| h.to_string_lossy().to_string());
    if q.path.trim().is_empty() {
        let mut roots = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if FsPath::new(&root).exists() {
                roots.push(json!({ "name": root.clone(), "path": root }));
            }
        }
        return Ok(Json(json!({ "path": "", "parent": null, "dirs": roots, "home": home })));
    }
    let path = PathBuf::from(q.path.trim());
    let rd = std::fs::read_dir(&path).map_err(|x| ApiError::not_found(format!("{}: {x}", path.display())))?;
    let mut dirs: Vec<Value> = rd
        .flatten()
        .filter(|ent| ent.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|ent| !ent.file_name().to_string_lossy().starts_with('.') && !ent.file_name().to_string_lossy().starts_with('$'))
        .map(|ent| json!({ "name": ent.file_name().to_string_lossy(), "path": ent.path().to_string_lossy() }))
        .collect();
    dirs.sort_by(|a, b| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()));
    let parent = path.parent().map(|p| p.to_string_lossy().to_string()).filter(|p| !p.is_empty());
    Ok(Json(json!({ "path": path.to_string_lossy(), "parent": parent, "dirs": dirs, "home": home })))
}
