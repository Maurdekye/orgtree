//! The user's undo history over HTTP (docs/rust-engine/undo-history.md):
//! the gesture route, the history read, undo and redo, and the recording
//! answer the single user routes give.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::domain::undo::{self, Coded, Dir};
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::orgs::OrgHandle;

/// A domain error, its code kept (`gesture_mixed`, `history_conflict`, …).
#[logged]
fn api(e: anyhow::Error) -> ApiError {
    if let Some(c) = e.downcast_ref::<Coded>() {
        let mut extra = c.extra.clone();
        if !extra.is_object() {
            extra = json!({});
        }
        extra["code"] = json!(c.code);
        return ApiError::new(StatusCode::from_u16(c.status).unwrap_or(StatusCode::BAD_REQUEST), c.detail.clone()).with(extra);
    }
    e.into()
}

/// One user operation, recorded as an entry of its own: its answer plus
/// `history_entry` (null when it changed nothing), or the duplicate answer.
#[logged]
pub async fn single(e: &Arc<Engine>, o: &Arc<OrgHandle>, step: Value) -> ApiResult<Value> {
    let (label, request) = undo::meta(&step)?;
    let mut out = undo::gesture(e, o, std::slice::from_ref(&step), label, request).await.map_err(api)?;
    if out["duplicate"] == true {
        return Ok(out);
    }
    let mut answer = out["results"][0].take();
    if !answer.is_object() {
        answer = json!({ "result": answer });
    }
    answer["history_entry"] = out["history_entry"].take();
    Ok(answer)
}

/// `POST /api/orgs/{slug}/gesture {label?, request_id?, steps}`.
#[logged]
pub async fn gesture(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let Some(steps) = b["steps"].as_array() else {
        return Err(ApiError::bad_request(format!("steps is a list of 1 to {} operations", undo::MAX_STEPS)));
    };
    let label = match b.get("label") {
        None | Some(Value::Null) => None,
        Some(l) => undo::meta(&json!({ "history_label": l }))?.0,
    };
    let (_, request) = undo::meta(&json!({ "request_id": b.get("request_id").cloned().unwrap_or(Value::Null) }))?;
    Ok(Json(undo::gesture(&e, &o, steps, label, request).await.map_err(api)?))
}

/// `GET /api/orgs/{slug}/undo-history`.
#[logged]
pub async fn history(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    Ok(Json(undo::history(&**client, o.id).await?))
}

#[logged]
async fn step(e: Arc<Engine>, slug: String, b: Value, dir: Dir) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let Some(id) = b["id"].as_i64() else {
        return Err(ApiError::bad_request("id is the entry the window shows"));
    };
    let confirm = b["confirm"].as_str();
    Ok(Json(undo::step(&e, &o, dir, id, confirm).await.map_err(api)?))
}

/// `POST /api/orgs/{slug}/undo-history/undo {id, confirm?}`.
#[logged]
pub async fn undo(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    step(e, slug, b, Dir::Undo).await
}

/// `POST /api/orgs/{slug}/undo-history/redo {id}`.
#[logged]
pub async fn redo(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    step(e, slug, b, Dir::Redo).await
}
