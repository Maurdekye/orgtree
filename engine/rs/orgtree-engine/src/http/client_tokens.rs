use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::Engine;
use super::error::{ApiError, ApiResult};

#[nolog]
pub fn manage(engine: &Engine, args: &Value) -> ApiResult<Value> {
    engine.clients.as_ref().filter(|_| engine.cfg.standalone)
        .ok_or_else(|| ApiError::not_found("client tokens are available in standalone mode only"))?.manage(args)
}

#[nolog]
pub async fn list(State(engine): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(manage(&engine, &json!({"action":"list"}))?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create { name: String }

#[nolog]
pub async fn create(State(engine): State<Arc<Engine>>, Json(body): Json<Create>) -> ApiResult<Json<Value>> {
    Ok(Json(manage(&engine, &json!({"action":"create","name":body.name}))?))
}

#[nolog]
pub async fn revoke(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(manage(&engine, &json!({"action":"revoke","id":id}))?))
}
