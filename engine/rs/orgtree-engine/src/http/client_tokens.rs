use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::engine::Engine;
use super::error::{ApiError, ApiResult};

#[nolog]
pub fn manage(engine: &Engine, args: &Value) -> ApiResult<Value> {
    let registry = engine.clients.as_ref().filter(|_| engine.cfg.standalone)
        .ok_or_else(|| ApiError::not_found("client tokens are available in standalone mode only"))?;
    // A viewer token is bound to an org that exists now (the registry checks the argument shapes).
    if args["action"] == "create" && args["scope"] == "viewer" {
        if let Some(org) = args["org"].as_str() {
            if engine.orgs.get(org).is_none() { return Err(ApiError::not_found(format!("no organization {org}"))); }
        }
    }
    registry.manage(args)
}

#[nolog]
pub async fn list(State(engine): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(manage(&engine, &json!({"action":"list"}))?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create { name: String, scope: Option<String>, org: Option<String> }

#[nolog]
pub async fn create(State(engine): State<Arc<Engine>>, Json(body): Json<Create>) -> ApiResult<Json<Value>> {
    let mut args = json!({"action":"create","name":body.name});
    if let Some(scope) = body.scope { args["scope"] = json!(scope); }
    if let Some(org) = body.org { args["org"] = json!(org); }
    Ok(Json(manage(&engine, &args)?))
}

#[nolog]
pub async fn revoke(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(manage(&engine, &json!({"action":"revoke","id":id}))?))
}
