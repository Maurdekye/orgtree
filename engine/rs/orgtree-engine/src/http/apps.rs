//! Authenticated user entry point. HTML never receives this route's credential.
use std::sync::Arc;
use axum::{Json, extract::{Path, State}};
use serde_json::Value;
use crate::engine::Engine;
use super::{error::ApiResult, orgs::org};
#[nolog]
pub async fn request(State(engine):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Value>)->ApiResult<Json<Value>> {
    let org=org(&engine,&slug)?;
    Ok(Json(crate::domain::apps::run(&engine,&org,None,&input).await?))
}
