//! The docket panel: the list (ETag'd), one item, replies, the attention
//! dismissal and item attachments. (The bounded "foreground" transports answer
//! 409 compatibility from `orgs::compatibility`: the renderer then reads the list.)

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::docket;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;

#[derive(Deserialize, Debug, Default)]
pub struct ViewQuery {
    #[serde(default)]
    archived: i64,
    #[serde(default)]
    backlogged: i64,
}

/// The whole docket list; 304 while nothing in the org moved.
#[logged]
pub async fn view(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<ViewQuery>, headers: HeaderMap) -> ApiResult<Response> {
    let o = org(&e, &slug)?;
    let tag = format!("\"{}-{}-{}{}\"", e.boot.id, o.docket.load(Ordering::Relaxed), q.archived.min(1), q.backlogged.min(1));
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, tag), (header::CACHE_CONTROL, "private, no-cache".to_string())]).into_response());
    }
    let body = docket::user_list(&e, &o, q.archived > 0, q.backlogged > 0, tag.trim_matches('"')).await?;
    Ok(([(header::ETAG, tag), (header::CACHE_CONTROL, "private, no-cache".to_string())], Json(body)).into_response())
}

#[logged]
pub async fn get(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(json!({ "item": docket::user_get(&e, &o, &wid).await? })))
}

#[derive(Deserialize, Debug)]
pub struct ReplyBody {
    #[serde(default)]
    body: String,
    to: Option<String>,
    #[serde(default)]
    attachments: Vec<String>,
    #[serde(default)]
    notice: bool,
}

/// The user's reply on an item (to its owner, or a participant it names).
#[logged]
pub async fn reply(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>, Json(b): Json<ReplyBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let mut atts = Vec::new();
    let mut warnings = Vec::new();
    for p in b.attachments.iter().take(20) {
        let path = PathBuf::from(p);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
                let name = name
                    .split_once('-')
                    .filter(|(pre, _)| pre.starts_with('u') && pre.len() == 13)
                    .map(|(_, n)| n.to_string())
                    .unwrap_or(name);
                atts.push(json!({ "name": name, "path": p, "bytes": meta.len() }));
            }
            _ => warnings.push(format!("{p} — no such file (never uploaded, or the upload failed)")),
        }
    }
    let mut r = docket::reply(&e, &o, &wid, &b.body, b.to.as_deref(), atts, b.notice).await?;
    if !warnings.is_empty() {
        r["warnings"] = json!(warnings);
    }
    Ok(Json(r))
}

#[derive(Deserialize, Debug)]
pub struct DismissBody {
    set_rev: i64,
}

#[logged]
pub async fn dismiss(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>, Json(b): Json<DismissBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(json!({ "item": docket::dismiss(&e, &o, &wid, b.set_rev).await? })))
}

#[derive(Deserialize, Debug)]
pub struct NameQuery {
    #[serde(default)]
    name: String,
}

#[logged]
pub async fn attach(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>, Query(q): Query<NameQuery>, body: Bytes) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(docket::attach(&e, &o, &wid, &q.name, &body).await?))
}

#[logged]
pub async fn attachment(State(e): State<Arc<Engine>>, Path((slug, wid, aid)): Path<(String, String, String)>) -> ApiResult<Response> {
    let o = org(&e, &slug)?;
    let (name, path) = docket::attachment(&e, &o, &wid, &aid).await?;
    let bytes = tokio::fs::read(&path).await.map_err(|_| ApiError::not_found("that attachment's file is gone"))?;
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
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

#[logged]
pub async fn detach(State(e): State<Arc<Engine>>, Path((slug, wid, aid)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(docket::detach(&e, &o, &wid, &aid).await?))
}

/// W08 artifacts are not kept by this engine.
#[logged]
pub async fn artifact(Path((_slug, _wid, _aid)): Path<(String, String, String)>) -> ApiResult<Response> {
    Err(ApiError::not_found("evidence artifacts are not kept in Orgtree 4; evidence is notes and references"))
}

/// Quick staff: where the seat would go and which models can take it.
#[logged]
pub async fn quick_preview(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::domain::staffing::quick_preview(&e, &o, &wid).await?))
}

#[logged]
pub async fn quick_commit(State(e): State<Arc<Engine>>, Path((slug, wid)): Path<(String, String)>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::domain::staffing::quick_commit(&e, &o, &wid, &b).await?))
}

/// `GET /api/orgs/{slug}/staffing-options` (and its `refresh`): what every
/// staffing surface can offer, computed from in-memory state at once.
#[logged]
pub async fn staffing_options(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let _ = org(&e, &slug)?;
    Ok(Json(crate::domain::staffing::options(&e)))
}
