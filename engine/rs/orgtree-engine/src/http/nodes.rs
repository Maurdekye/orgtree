//! One agent's desk: its conversation, mail from the user, turn controls,
//! files, and its scope.

use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::domain::mail::{self, From, Outgoing};
use crate::domain::scope;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::orgs::OrgHandle;
use crate::runtime::{self, actor::LiveView, convo, freeze, AgentMsg};
use crate::util::{gist, iso, uid};

#[derive(Debug, serde::Serialize)]
pub struct Agent {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub parent_id: Option<i64>,
}

#[logged]
pub async fn agent(engine: &Engine, org: &OrgHandle, nid: &str) -> ApiResult<Agent> {
    let client = engine.db.get().await?;
    let r = client
        .query_opt(
            "SELECT id, name, state, parent_id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'",
            &[&org.id, &nid],
        )
        .await?;
    match r {
        Some(r) => Ok(Agent { id: r.get(0), name: r.get(1), state: r.get(2), parent_id: r.get(3) }),
        None => Err(ApiError::not_found(format!("no agent named {nid} in {}", org.slug))),
    }
}

/// Ask an agent's actor (started on demand) and wait for its answer.
#[logged]
async fn ask(engine: &Arc<Engine>, org_id: i64, agent_id: i64, make: impl FnOnce(oneshot::Sender<Value>) -> AgentMsg) -> ApiResult<Value> {
    let (tx, rx) = oneshot::channel();
    if !runtime::actor(engine, org_id, agent_id).send(make(tx)) {
        return Err(ApiError::unavailable("the agent's runtime is stopping"));
    }
    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(v)) => Ok(v),
        _ => Err(ApiError::unavailable("the agent did not answer in time")),
    }
}

// ------------------------------------------------------------ chat

#[derive(Deserialize, Debug)]
pub struct ChatQuery {
    last: Option<i64>,
    before: Option<String>,
    after: Option<String>,
}

#[logged]
pub async fn chat(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Query(q): Query<ChatQuery>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    // the live half only exists while an actor runs; never start one to read
    let live = match e.agents.get(a.id) {
        Some(h) => {
            let (tx, rx) = oneshot::channel();
            if h.send(AgentMsg::Live(tx)) {
                tokio::time::timeout(std::time::Duration::from_secs(3), rx).await.ok().and_then(Result::ok)
            } else {
                None
            }
        }
        None => None,
    };
    let live = live.unwrap_or_else(|| LiveView { draft_epoch: format!("{}.idle:0", e.boot.id), ..LiveView::default() });
    let client = e.db.get().await?;
    let before = q.before.as_deref().and_then(|b| b.parse::<i64>().ok());
    let after = q.after.as_deref().and_then(convo::parse_after);
    let page = convo::read(&client, a.id, q.last.unwrap_or(300), before, after).await?;
    let r = client
        .query_one(
            "SELECT occupancy, occupancy_est, last_error, session_id FROM ot.agents WHERE id = $1",
            &[&a.id],
        )
        .await?;
    let pending = client
        .query(
            "SELECT to_jsonb(m) FROM ot.mail m WHERE recipient_agent_id = $1 AND state = 'pending' ORDER BY id LIMIT 200",
            &[&a.id],
        )
        .await?;
    drop(client);
    let pending_mail: Vec<Value> = pending
        .iter()
        .map(|row| {
            let m: Value = row.get(0);
            let mut p = crate::feed::compute::mail_entry(&m);
            if live.busy {
                p["stage"] = json!("steer");
            } else if !m["notice"].as_bool().unwrap_or(false) && e.agents.get(a.id).is_some() {
                p["stage"] = json!("queued");
            }
            p
        })
        .collect();
    let last_error: Option<String> = live.last_error.clone().or_else(|| r.get(2));
    let mut out = json!({
        "after": page.after,
        "incremental": page.incremental,
        "windowed": true,
        "before": page.before,
        "has_older": page.has_older,
        "conversation_id": format!("a{}", a.id),
        "transient": live.transient,
        "busy": live.busy,
        "turn_activity": live.turn_activity,
        "queued": 0,
        "responding": live.busy,
        "mcp_readiness_waiting": live.mcp_waiting,
        "mcp_readiness_state": live.mcp_state,
        "mcp_readiness_reason": live.mcp_reason,
        "last_error": last_error,
        "occupancy": r.get::<_, Option<i32>>(0),
        "occupancy_estimated": r.get::<_, bool>(1),
        "messages": page.messages,
        "draft_epoch": live.draft_epoch,
        "live": [],
        "init": if live.init.is_null() { Value::Null } else { live.init.clone() },
        "mail_pending": pending_mail.len(),
        "mail_stranded": 0,
        "pending_mail": pending_mail,
    });
    if page.incremental {
        out["message_updates"] = json!(page.updates);
    }
    Ok(Json(out))
}

// ------------------------------------------------------------ mail from the user

#[derive(Deserialize, Default, Debug)]
pub struct MessageBody {
    #[serde(default)]
    text: String,
    #[serde(default)]
    attachments: Vec<String>,
    reply_to: Option<Value>,
    target: Option<Value>,
    client_op: Option<String>,
    #[serde(default)]
    notice: bool,
}

#[logged]
pub async fn message(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(b): Json<MessageBody>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let text = b.text.trim_end().to_string();
    // slash commands go to the CLI as typed
    if text.starts_with('/') && !text.contains('\n') && b.attachments.is_empty() {
        let cmd = text.clone();
        let r = ask(&e, org.id, a.id, move |tx| AgentMsg::Command(cmd, tx)).await?;
        if r["started"].as_bool().unwrap_or(false) {
            return Ok(Json(json!({ "accepted": true, "command": true, "compacting": text == "/compact" })));
        }
        return Err(ApiError::conflict(r["reason"].as_str().unwrap_or("the command could not start").to_string()));
    }
    let mut out = Outgoing::new(From::User, &a.name, &text);
    out.notice = b.notice;
    out.client_op = b.client_op.filter(|s| !s.is_empty() && s.len() <= 200);
    for p in b.attachments.iter().take(20) {
        let path = PathBuf::from(p);
        let Ok(meta) = std::fs::metadata(&path) else {
            return Err(ApiError::bad_request(format!("attachment {p} no longer exists; upload it again")));
        };
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
        let name = name.split_once('-').filter(|(pre, _)| pre.starts_with('u') && pre.len() == 13).map(|(_, n)| n.to_string()).unwrap_or(name);
        out.attachments.push(json!({ "name": name, "path": p, "bytes": meta.len() }));
    }
    out.reply_to = match (&b.target, &b.reply_to) {
        (Some(t), _) => resolve_target(&e, &org, t).await?,
        (None, Some(r)) if r.is_object() => Some(r.clone()),
        _ => None,
    };
    let sent = mail::send(&e, org.id, out).await?;
    let halted = sent.delivery.contains("is halted");
    Ok(Json(json!({
        "accepted": true, "id": sent.uid, "ref": format!("@mail:{}", sent.uid),
        "deferred": sent.deferred, "delivery": sent.delivery, "recipient_state": sent.recipient_state,
        "halted": halted, "notice": b.notice,
        "steering": e.agents.get(a.id).map(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false)).unwrap_or(false),
    })))
}

/// `{kind, org, box, node?, id}` (object identity only) → the reply snapshot.
#[logged]
async fn resolve_target(e: &Engine, org: &OrgHandle, t: &Value) -> ApiResult<Option<Value>> {
    let kind = t["kind"].as_str().unwrap_or("");
    let id = t["id"].as_str().unwrap_or("");
    let client = e.db.get().await?;
    match kind {
        "mail" => {
            let r = client
                .query_opt("SELECT uid, sender, created_at, body FROM ot.mail WHERE org_id = $1 AND uid = $2", &[&org.id, &id])
                .await?;
            let Some(r) = r else { return Err(ApiError::not_found("the message being answered no longer exists")) };
            let body: String = r.get(3);
            Ok(Some(json!({ "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "at": iso(r.get(2)),
                            "gist": gist(&body, 600), "kind": "mail" })))
        }
        "document" => {
            let r = client.query_opt("SELECT uid, node_name, at, title FROM ot.documents WHERE org_id = $1 AND uid = $2", &[&org.id, &id]).await?;
            let Some(r) = r else { return Err(ApiError::not_found("that document no longer exists")) };
            Ok(Some(json!({ "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "at": iso(r.get(2)),
                            "gist": format!("document: {}", r.get::<_, String>(3)), "kind": "document" })))
        }
        "work_item" => {
            let slug = t["slug"].as_str().unwrap_or("");
            let r = client.query_opt("SELECT slug, title, updated_at FROM ot.work_items WHERE org_id = $1 AND slug = $2", &[&org.id, &slug]).await?;
            let Some(r) = r else { return Err(ApiError::not_found("that docket item no longer exists")) };
            Ok(Some(json!({ "id": r.get::<_, String>(0), "from": "docket", "at": iso(r.get(2)),
                            "gist": format!("docket item {}: {}", r.get::<_, String>(0), r.get::<_, String>(1)), "kind": "work_item" })))
        }
        other => Err(ApiError::bad_request(format!("cannot reply to a {other}"))),
    }
}

#[logged]
pub async fn retract(
    State(e): State<Arc<Engine>>,
    Path((slug, nid, mid)): Path<(String, String, String)>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let client = e.db.get().await?;
    let n = client
        .execute(
            "UPDATE ot.mail SET state = 'retracted' WHERE uid = $1 AND recipient_agent_id = $2 AND sender = '@user' AND state = 'pending'",
            &[&mid, &a.id],
        )
        .await?;
    drop(client);
    if n == 0 {
        return Err(ApiError::conflict("that message was already delivered (or is not yours to retract)"));
    }
    changes::notify(&e, &org, vec![Change::Mailbox(a.id), Change::UserMail]);
    Ok(Json(json!({ "retracted": mid })))
}

// ------------------------------------------------------------ turn controls

#[logged]
pub async fn interrupt(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    if e.agents.get(a.id).is_none() {
        return Ok(Json(json!({ "interrupted": false, "reason": "no turn is running" })));
    }
    Ok(Json(ask(&e, org.id, a.id, AgentMsg::Interrupt).await?))
}

#[logged]
pub async fn halt(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    if a.state != "live" {
        return Err(ApiError::conflict(format!("{} is not live", a.name)));
    }
    Ok(Json(ask(&e, org.id, a.id, AgentMsg::Halt).await?))
}

#[logged]
pub async fn unhalt(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    Ok(Json(ask(&e, org.id, a.id, AgentMsg::Unhalt).await?))
}

#[logged]
pub async fn compact(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let r = ask(&e, org.id, a.id, |tx| AgentMsg::Command("/compact".into(), tx)).await?;
    Ok(Json(json!({ "started": r["started"].as_bool().unwrap_or(false), "reason": r["reason"] })))
}

#[derive(Deserialize, Debug)]
pub struct ProcessBody {
    action: String,
}

#[logged]
pub async fn process(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(b): Json<ProcessBody>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    if b.action != "start" && b.action != "stop" {
        return Err(ApiError::bad_request("action must be start or stop"));
    }
    if b.action == "stop" && e.agents.get(a.id).is_none() {
        return Ok(Json(json!({ "ok": true, "action": "stop", "already": true, "paused": false, "proc_warm": false, "proc_live": false })));
    }
    let action = b.action.clone();
    Ok(Json(ask(&e, org.id, a.id, move |tx| AgentMsg::Process { action, reply: tx }).await?))
}

#[logged]
pub async fn unstick(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let client = e.db.get().await?;
    let r = client.query_one("SELECT frozen IS NOT NULL, limit_locked FROM ot.agents WHERE id = $1", &[&a.id]).await?;
    drop(client);
    let mut released = Vec::new();
    if r.get::<_, bool>(0) {
        released.push("frozen");
    }
    if r.get::<_, bool>(1) {
        released.push("limit_locked");
    }
    let thawed = freeze::thaw(&e, org.id, a.id, false).await?;
    if !thawed && r.get::<_, bool>(1) {
        let client = e.db.get().await?;
        client.execute("UPDATE ot.agents SET limit_locked = false, row_version = row_version + 1 WHERE id = $1", &[&a.id]).await?;
        changes::notify(&e, &org, vec![Change::Agent(a.id)]);
        runtime::wake(&e, org.id, a.id);
    }
    Ok(Json(json!({ "released": released, "status": if released.is_empty() { "nothing to release" } else { "released" } })))
}

#[derive(Deserialize, Debug)]
pub struct ContinueBody {
    account: String,
}

#[logged]
pub async fn continue_on(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(b): Json<ContinueBody>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    Ok(Json(freeze::continue_on(&e, org.id, a.id, &b.account, "continue on another account (user)").await?))
}

#[logged]
pub async fn resume(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let resumed = freeze::resume_org(&e, org.id).await?;
    Ok(Json(json!({ "resumed": resumed })))
}

#[logged]
pub async fn remote_control(Path((_slug, _nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    Err(ApiError::unprocessable("remote control is not part of Orgtree 4"))
}

// ------------------------------------------------------------ scope

#[logged]
pub async fn set_scope(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(b): Json<Value>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let mut client = e.db.get().await?;
    let tx = client.transaction().await?;
    let row = tx
        .query_one("SELECT scope, charter, team_charter FROM ot.agents WHERE id = $1 FOR UPDATE", &[&a.id])
        .await?;
    let before: Value = row.get(0);
    let mut sc = scope::normalize(&before);
    let obj = sc.as_object_mut().unwrap();
    let mut effort_change: Option<String> = None;
    if let Some(d) = b.get("add_dirs").filter(|v| v.is_array()) {
        obj.insert("add_dirs".into(), scope::normalize(&json!({ "add_dirs": d }))["add_dirs"].clone());
    }
    if let Some(t) = b.get("tools").filter(|v| v.is_object()) {
        let mut cur = obj.get("tools").cloned().unwrap_or_else(scope::default_tools);
        crate::settings::deep_merge(&mut cur, t);
        obj.insert("tools".into(), scope::normalize_tools(&cur));
    }
    if let Some(v) = b.get("org_visibility").and_then(Value::as_str) {
        if !scope::VIS_LEVELS.contains(&v) {
            return Err(ApiError::bad_request(format!("unknown visibility {v}")));
        }
        obj.insert("org_visibility".into(), json!(v));
    }
    if let Some(v) = b.get("permission_mode").and_then(Value::as_str) {
        if !scope::PM_LEVELS.contains(&v) {
            return Err(ApiError::bad_request(format!("unknown permission mode {v}")));
        }
        obj.insert("permission_mode".into(), json!(v));
    }
    if let Some(v) = b.get("effort") {
        let level = v.as_str().unwrap_or("").to_string();
        if !level.is_empty() && !crate::providers::catalog::EFFORTS.contains(&level.as_str()) {
            return Err(ApiError::bad_request(format!("unknown effort {level}")));
        }
        let old = obj.get("effort").and_then(Value::as_str).unwrap_or("").to_string();
        if level.is_empty() {
            obj.remove("effort");
        } else {
            obj.insert("effort".into(), json!(level));
        }
        if old != level {
            effort_change = Some(level);
        }
    }
    if let Some(v) = b.get("model_version") {
        match v.as_str().filter(|s| !s.is_empty()) {
            Some(s) => obj.insert("model_version".into(), json!(s)),
            None => obj.remove("model_version"),
        };
    }
    if b.get("clear_account_fallback").and_then(Value::as_bool).unwrap_or(false) {
        obj.remove("account_fallback");
    } else if let Some(v) = b.get("account_fallback").and_then(Value::as_bool) {
        obj.insert("account_fallback".into(), json!(v));
    }
    if let Some(v) = b.get("auto_cheap_compact").filter(|v| v.is_object()) {
        if v.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            obj.remove("auto_cheap_compact");
        } else {
            obj.insert("auto_cheap_compact".into(), v.clone());
        }
    }
    let charter = b.get("charter").and_then(Value::as_str).map(str::to_string);
    let team_charter = b.get("team_charter").and_then(Value::as_str).map(str::to_string);
    tx.execute(
        "UPDATE ot.agents SET scope = $2, charter = coalesce($3, charter), team_charter = coalesce($4, team_charter),
                row_version = row_version + 1 WHERE id = $1",
        &[&a.id, &sc, &charter, &team_charter],
    )
    .await?;
    // a grant the chain above does not hold is raised on the way up (the
    // user grants it; every ancestor gets at least as much)
    let cascaded = cascade_up(&tx, a.parent_id, &sc).await?;
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'scope', '@user', $2, $3)",
        &[&org.id, &a.id, &json!({ "node": a.name, "change": b, "cascaded": cascaded })],
    )
    .await?;
    tx.commit().await?;
    // the subtree's effective scopes may have moved
    let subtree: Vec<i64> = client
        .query(
            "WITH RECURSIVE down(id, depth) AS (SELECT $1::bigint, 0 UNION ALL
               SELECT c.id, d.depth + 1 FROM ot.agents c JOIN down d ON c.parent_id = d.id WHERE d.depth < 1024 AND c.state = 'live')
             SELECT id FROM down",
            &[&a.id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    drop(client);
    let mut ch: Vec<Change> = subtree.iter().map(|id| Change::Agent(*id)).collect();
    ch.push(Change::Events);
    ch.push(Change::History(a.id));
    changes::notify(&e, &org, ch);
    let mut out = json!({ "ok": true, "cascaded": cascaded });
    let structural = b.as_object().map(|o| o.keys().any(|k| k != "effort")).unwrap_or(false);
    if structural {
        for id in &subtree {
            if let Some(h) = e.agents.get(*id) {
                h.send(AgentMsg::Reconfigured);
            }
        }
    }
    if let Some(level) = effort_change {
        let live = match e.agents.get(a.id) {
            Some(_) => {
                let lv = level.clone();
                ask(&e, org.id, a.id, move |tx| AgentMsg::Effort(lv, tx)).await.ok()
            }
            None => None,
        };
        out["effort_delivery"] = live
            .and_then(|v| v.get("effort_delivery").cloned())
            .unwrap_or_else(|| json!("next_turn"));
    }
    Ok(Json(out))
}

/// Raise each ancestor's configured scope to cover `child` (tools, MCP
/// servers, folders, permission mode, visibility). Returns who changed.
#[logged]
async fn cascade_up(tx: &tokio_postgres::Transaction<'_>, mut parent: Option<i64>, child: &Value) -> anyhow::Result<Vec<String>> {
    let mut changed = Vec::new();
    let mut depth = 0;
    while let Some(pid) = parent {
        depth += 1;
        if depth > 1024 {
            break;
        }
        let r = tx.query_one("SELECT name, scope, parent_id FROM ot.agents WHERE id = $1 FOR UPDATE", &[&pid]).await?;
        let name: String = r.get(0);
        let cur = scope::normalize(&r.get::<_, Value>(1));
        let mut next = cur.clone();
        let o = next.as_object_mut().unwrap();
        // tools
        let mut tools = o.get("tools").cloned().unwrap_or_else(scope::default_tools);
        for k in ["bash", "web", "edit", "subagents"] {
            if child["tools"][k].as_bool().unwrap_or(true) && !tools[k].as_bool().unwrap_or(true) {
                tools[k] = json!(true);
            }
        }
        let mut mcp: Vec<String> = tools["mcp"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if !mcp.iter().any(|m| m == "*") {
            for m in child["tools"]["mcp"].as_array().cloned().unwrap_or_default() {
                if let Some(s) = m.as_str() {
                    if !mcp.iter().any(|x| x == s) {
                        mcp.push(s.to_string());
                    }
                }
            }
        }
        mcp.sort();
        tools["mcp"] = json!(mcp);
        o.insert("tools".into(), tools);
        // folders: the child's must lie within the parent's
        let mut dirs = o.get("add_dirs").and_then(Value::as_array).cloned().unwrap_or_default();
        for d in child["add_dirs"].as_array().cloned().unwrap_or_default() {
            let Some(p) = d["path"].as_str() else { continue };
            let covered = dirs.iter().any(|x| {
                x["path"].as_str().map(|xp| scope::path_within(p, xp)).unwrap_or(false)
                    && (d["mode"] == "ro" || x["mode"] != "ro")
            });
            if !covered {
                dirs.retain(|x| !(x["path"].as_str().map(|xp| scope::path_within(xp, p)).unwrap_or(false)));
                dirs.push(json!({ "path": p, "mode": d["mode"].as_str().unwrap_or("rw") }));
            }
        }
        o.insert("add_dirs".into(), Value::Array(dirs));
        let cpm = child["permission_mode"].as_str().unwrap_or("acceptEdits");
        if scope::pm_rank(cpm) > scope::pm_rank(o["permission_mode"].as_str().unwrap_or("acceptEdits")) {
            o.insert("permission_mode".into(), json!(cpm));
        }
        let cv = child["org_visibility"].as_str().unwrap_or("subtree");
        if scope::vis_rank(cv) > scope::vis_rank(o["org_visibility"].as_str().unwrap_or("subtree")) {
            o.insert("org_visibility".into(), json!(cv));
        }
        if next != cur {
            tx.execute("UPDATE ot.agents SET scope = $2, row_version = row_version + 1 WHERE id = $1", &[&pid, &next]).await?;
            changed.push(name);
        }
        parent = r.get(2);
    }
    Ok(changed)
}

// ------------------------------------------------------------ files

#[derive(Deserialize, Debug)]
pub struct UploadQuery {
    name: String,
}

#[logged]
pub async fn upload(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let clean: String = q
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string();
    let clean = if clean.is_empty() { "file".to_string() } else { clean };
    let id = uid("u");
    let dir = e.cfg.path("uploads").join(&org.slug).join(&a.name);
    tokio::fs::create_dir_all(&dir).await.map_err(|err| ApiError::internal(err.to_string()))?;
    let path = dir.join(format!("{id}-{clean}"));
    tokio::fs::write(&path, &body).await.map_err(|err| ApiError::internal(err.to_string()))?;
    let p = path.to_string_lossy().to_string();
    let client = e.db.get().await?;
    client
        .execute(
            "INSERT INTO ot.uploads (id, org_id, agent_id, name, path, bytes) VALUES ($1, $2, $3, $4, $5, $6)",
            &[&id, &org.id, &a.id, &clean, &p, &(body.len() as i64)],
        )
        .await?;
    Ok(Json(json!({ "path": p, "bytes": body.len() })))
}

#[derive(Deserialize, Debug)]
pub struct FileQuery {
    path: String,
}

/// A file the desk links to: inside the org's scratch folders, the uploads,
/// the org's own folders, or a file this org's mail or deliveries name.
#[logged]
pub async fn file(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Query(q): Query<FileQuery>,
) -> ApiResult<Response> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let client = e.db.get().await?;
    let scratch: Option<String> = client.query_one("SELECT scratch_dir FROM ot.agents WHERE id = $1", &[&a.id]).await?.get(0);
    let scratch = scratch.map(PathBuf::from).unwrap_or_else(|| e.cfg.scratch_root(&org.slug).join(&a.name));
    let raw = PathBuf::from(&q.path);
    let path = if raw.is_absolute() { raw } else { scratch.join(&q.path) };
    let Ok(canon) = std::fs::canonicalize(&path) else {
        return Err(ApiError::not_found("that file does not exist"));
    };
    let canon = crate::config::strip_verbatim(&canon);
    let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org.id]).await?.get(0);
    let mut roots: Vec<PathBuf> = vec![e.cfg.scratch_root(&org.slug), e.cfg.path("uploads"), e.cfg.workspace_dir(&org.slug), scratch];
    for d in settings["dirs"].as_array().cloned().unwrap_or_default() {
        if let Some(p) = d["path"].as_str() {
            roots.push(PathBuf::from(p));
        }
    }
    let inside = |root: &FsPath| scope::path_within(&canon.to_string_lossy(), &root.to_string_lossy());
    let mut allowed = roots.iter().any(|r| inside(r));
    if !allowed {
        let p = q.path.clone();
        let named = client
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM ot.mail WHERE org_id = $1 AND attachments @> jsonb_build_array(jsonb_build_object('path', $2::text)))
                     OR EXISTS (SELECT 1 FROM ot.deliveries WHERE org_id = $1 AND path = $2)",
                &[&org.id, &p],
            )
            .await?;
        allowed = named.get(0);
    }
    drop(client);
    if !allowed {
        return Err(ApiError::forbidden("that file is outside this organization's folders"));
    }
    let bytes = tokio::fs::read(&canon).await.map_err(|_| ApiError::not_found("that file could not be read"))?;
    let mime = mime_guess::from_path(&canon).first_or_octet_stream();
    let name = canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CONTENT_DISPOSITION, format!("inline; filename=\"{}\"", name.replace('"', ""))),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Deserialize, Debug)]
pub struct ScratchQuery {
    #[serde(default)]
    path: String,
}

#[logged]
pub async fn scratch(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Query(q): Query<ScratchQuery>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let client = e.db.get().await?;
    let dir: Option<String> = client.query_one("SELECT scratch_dir FROM ot.agents WHERE id = $1", &[&a.id]).await?.get(0);
    drop(client);
    let root = dir.map(PathBuf::from).unwrap_or_else(|| e.cfg.scratch_root(&org.slug).join(&a.name));
    let target = root.join(q.path.trim_start_matches(['/', '\\']));
    if q.path.split(['/', '\\']).any(|s| s == "..") {
        return Err(ApiError::forbidden("that path leaves the folder"));
    }
    if target.is_dir() || !target.exists() && q.path.is_empty() {
        let mut entries: Vec<Value> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&target) {
            for ent in rd.flatten() {
                let md = ent.metadata().ok();
                let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                entries.push(json!({ "name": ent.file_name().to_string_lossy(), "dir": is_dir,
                                     "size": if is_dir { Value::Null } else { json!(md.map(|m| m.len()).unwrap_or(0)) } }));
            }
        }
        entries.sort_by(|x, y| {
            (!x["dir"].as_bool().unwrap_or(false), x["name"].as_str().unwrap_or(""))
                .cmp(&(!y["dir"].as_bool().unwrap_or(false), y["name"].as_str().unwrap_or("")))
        });
        return Ok(Json(json!({ "dir": q.path, "entries": entries })));
    }
    let bytes = std::fs::read(&target).map_err(|_| ApiError::not_found("no such file"))?;
    let text = String::from_utf8_lossy(&bytes);
    let (clipped, _) = convo::clip(&text, 400_000);
    Ok(Json(json!({ "file": q.path, "content": clipped })))
}

/// `GET /nodes/{nid}/inbox`: the agent's mailbox (pending, delivered, sent).
#[logged]
pub async fn inbox(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let a = agent(&e, &org, &nid).await?;
    let client = e.db.get().await?;
    let rows = crate::feed::compute::agent_mailbox(&client, a.id).await?;
    drop(client);
    let mut out = Map::new();
    for k in ["pending", "delivered", "sent"] {
        out.insert(k.into(), json!([]));
    }
    for (_, v) in rows {
        let folder = v["folder"].as_str().unwrap_or("").to_string();
        if let Some(arr) = out.get_mut(&folder).and_then(Value::as_array_mut) {
            arr.push(v["mail"].clone());
        }
    }
    Ok(Json(Value::Object(out)))
}
