//! The user answering: question cards, credit decisions, request batches.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::domain::asks;
use crate::engine::Engine;
use crate::http::error::ApiResult;
use crate::http::orgs::org;

#[nolog] // Elicitation responses may contain private user input.
pub async fn answer(State(e): State<Arc<Engine>>, Path((slug, aid)): Path<(String, String)>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    if aid.starts_with("elicitation-") {
        let result=e.elicitations.resolve(o.id,&aid,&b)
            .map_err(|_|crate::http::error::ApiError::bad_request("MCP permission request expired, already answered, or has invalid fields"))?;
        crate::changes::notify(&e,&o,vec![crate::changes::Change::Asks]);
        return Ok(Json(result));
    }
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
