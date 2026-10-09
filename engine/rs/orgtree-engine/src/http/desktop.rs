//! `/api/desktop/*`: the launcher's identity proof, liveness, the tray's
//! status line, graceful shutdown; plus `/api/host` and engine stats.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::http::error::ApiResult;

#[logged]
pub async fn identity(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(json!({ "protocol": 1, "pid": e.boot.pid, "dataRootId": e.cfg.data_root_id,
        "credentialContext": e.credentials.view(&e.credential_bridge) }))
}

#[logged]
pub async fn alive(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(json!({ "pid": e.boot.pid, "dataRootId": e.cfg.data_root_id, "alive": true }))
}

#[logged]
pub async fn status(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    let total: i64 = client.query_one("SELECT count(*) FROM ot.agents WHERE state = 'live'", &[]).await?.get(0);
    let active = e.sched.held.load(Ordering::SeqCst) as i64;
    let waiting = e.sched.waiting.load(Ordering::SeqCst) as i64;
    let active = active.min(total);
    let mut v = json!({
        "activeAgents": active,
        "totalAgents": total,
        "idle": active == 0 && waiting == 0,
        "mailhub": e.hub.status(),
        "credentialWarning": e.credentials.view(&e.credential_bridge)["warning"],
    });
    if let Some(m) = crate::http::orgs::maintenance_request(&e) {
        v["maintenance"] = m;
    }
    Ok(Json(v))
}

#[logged]
pub async fn shutdown(State(e): State<Arc<Engine>>) -> Json<Value> {
    tracing::info!("shutdown requested by the desktop");
    let eng = e.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        eng.request_shutdown();
    });
    Json(json!({ "ok": true }))
}

#[logged]
pub async fn host(State(e): State<Arc<Engine>>) -> Json<Value> {
    let st = e.providers.state.load();
    Json(json!({
        "build": {
            "commit": option_env!("ORGTREE_BUILD_COMMIT").unwrap_or("rust-engine"),
            "branch": option_env!("ORGTREE_BUILD_BRANCH"),
            "started_at": crate::util::iso(e.boot.started_at),
        },
        "cli_version": st.claude.version.clone().unwrap_or_default(),
        "engine": format!("orgtree-engine {}", env!("CARGO_PKG_VERSION")),
    }))
}

#[logged]
pub async fn engine_stats(State(e): State<Arc<Engine>>) -> Json<Value> {
    let mut sockets = Vec::new();
    for org in e.orgs.all() {
        sockets.push(json!({ "org": org.slug, "window": "", "pending": 0, "pending_bytes": 0, "sent": 0,
                             "sent_bytes": 0, "age_s": 0, "window_connects": org.rooms.socket_count(),
                             "window_drops": 0 }));
    }
    Json(json!({
        "at": chrono::Utc::now().timestamp(),
        "pid": e.boot.pid,
        "memory": { "private_bytes": crate::http::orgs::private_bytes(), "rss_bytes": Value::Null },
        "websockets": { "queue_max": 8192, "send_timeout_s": 0, "drops": {}, "sockets": sockets },
        "work_list": { "full_200": 0, "not_modified_304": 0, "bytes_200": 0, "window_s": 0,
                       "cached_bodies": 0, "cached_bytes": 0, "cache_idle_s": 0 },
        "agents": { "actors": e.agents.count(), "turns_running": e.sched.held.load(Ordering::SeqCst),
                    "turns_waiting": e.sched.waiting.load(Ordering::SeqCst) },
    }))
}

/// `GET /api/desktop/hub`: this machine's hub, its hosting settings and status.
#[logged]
pub async fn hub_get(State(e): State<Arc<Engine>>) -> Json<Value> {
    Json(crate::mailhub::hosting(&e).await)
}

/// `PUT /api/desktop/hub`: new hosting settings (the hub restarts on them).
#[logged]
pub async fn hub_put(State(e): State<Arc<Engine>>, Json(b): Json<Value>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::mailhub::configure(&e, &b).await.map(Json).map_err(crate::http::error::ApiError::unprocessable)
}

/// This engine issues no maintenance requests (the agent relaunch tools are
/// gone): an acknowledgment finds nothing to accept.
#[logged]
pub async fn maintenance_ack(Json(_b): Json<Value>) -> Json<Value> {
    Json(json!({ "accepted": false }))
}

/// A maintenance failure an older build left behind is released.
#[logged]
pub async fn maintenance_failure(Json(_b): Json<Value>) -> Json<Value> {
    Json(json!({ "released": true }))
}

#[derive(serde::Deserialize, Debug, Default)]
pub struct ProbeQuery {
    #[serde(default)]
    address: String,
}

/// `GET /api/net/probe`: does a hub answer at this address right now?
#[logged]
pub async fn net_probe(State(e): State<Arc<Engine>>, axum::extract::Query(q): axum::extract::Query<ProbeQuery>) -> Json<Value> {
    Json(crate::net::probe(&e, &q.address).await)
}

/// `GET /api/desktop/phone`: the "Chat from your phone" panel's state.
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_get(State(e): State<Arc<Engine>>, axum::extract::Query(q): axum::extract::Query<PhoneQuery>) -> Json<Value> {
    Json(crate::phone::state(&e, q.org.as_deref()).await)
}

/// `GET /api/desktop/phone/card[?org=slug]`: the cards' cheap read.
#[logged]
pub async fn phone_card(State(e): State<Arc<Engine>>, axum::extract::Query(q): axum::extract::Query<PhoneQuery>) -> Json<Value> {
    Json(crate::phone::card_state(&e, q.org.as_deref()).await)
}

#[derive(serde::Deserialize, Debug, Default)]
pub struct PhoneQuery {
    /// the org the panel was opened from
    #[serde(default)]
    org: Option<String>,
}

/// `POST /api/desktop/phone/access` `{scope: tailnet|lan, keep_awake?}`:
/// "Turn on phone access" (one administrator prompt for the firewall rule).
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_access(State(e): State<Arc<Engine>>, Json(b): Json<Value>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::turn_on(&e, b["scope"].as_str().unwrap_or(""), b["keep_awake"].as_bool()).await.map(Json)
}

/// `POST /api/desktop/phone/code` `{org}`: a new setup code for that org
/// (the previous one stops working).
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_code(State(e): State<Arc<Engine>>, Json(b): Json<Value>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::mint(&e, b["org"].as_str().unwrap_or("")).await.map(Json)
}

/// `POST /api/desktop/phone/link` `{org, address}`: "Yes, that's me".
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_link(State(e): State<Arc<Engine>>, Json(b): Json<Value>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::link_known(&e, b["org"].as_str().unwrap_or(""), b["address"].as_str().unwrap_or("")).await.map(Json)
}

/// `POST /api/desktop/phone/unlink`: Undo / Unlink.
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_unlink(State(e): State<Arc<Engine>>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::unlink(&e).await.map(Json)
}

/// `POST /api/desktop/phone/dismiss`: the card's × (org windows and Home alike).
#[logged]
pub async fn phone_dismiss(State(e): State<Arc<Engine>>) -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::dismiss(&e).map_err(|x| crate::http::error::ApiError::internal(format!("could not save phone.json: {x}")))?;
    Ok(Json(crate::phone::card_state(&e, None).await))
}

/// `POST /api/desktop/phone/tailscale-login`: T1's "Sign in" (the address to open).
#[logged]
pub async fn phone_tailscale_login() -> crate::http::error::ApiResult<Json<Value>> {
    crate::phone::tailscale_login().await.map(Json)
}

/// `POST /api/desktop/phone/settings` `{keep_awake}`: the panel's checkbox
/// and the sleep warning's "Keep awake while plugged in".
// the panel's state carries the live setup code: never logged
#[nolog]
pub async fn phone_settings(State(e): State<Arc<Engine>>, Json(b): Json<Value>) -> crate::http::error::ApiResult<Json<Value>> {
    let Some(k) = b["keep_awake"].as_bool() else { return Err(crate::http::error::ApiError::bad_request("keep_awake must be true or false")) };
    crate::phone::update_settings(&e, |v| v["keep_awake"] = serde_json::json!(k))
        .map_err(|x| crate::http::error::ApiError::internal(format!("could not save phone.json: {x}")))?;
    Ok(Json(crate::phone::state(&e, None).await))
}
