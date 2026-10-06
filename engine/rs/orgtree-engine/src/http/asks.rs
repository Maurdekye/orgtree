//! The user answering: question cards, credit decisions, request batches.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::domain::asks;
use crate::engine::Engine;
use crate::http::error::ApiResult;
use crate::http::orgs::org;

#[logged]
pub async fn answer(State(e): State<Arc<Engine>>, Path((slug, aid)): Path<(String, String)>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(asks::answer(&e, &o, &aid, &b).await?))
}

#[logged]
pub async fn batch(State(e): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(asks::resolve_batch(&e, &o, &nid, &b).await?))
}

#[logged]
pub async fn credit(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(asks::credit_decide(&e, &o, &b).await?))
}
