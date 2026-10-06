//! The user's hand on watchdogs and audiences.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::domain::audiences;
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;

#[derive(Deserialize, Debug)]
pub struct DogAction {
    id: String,
    action: String,
    #[serde(default)]
    reason: String,
}

/// pause / resume / remove / supersede any watchdog.
#[logged]
pub async fn watchdog(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<DogAction>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::runtime::watchdogs::act(&e, o.id, None, &b.id, &b.action, Some(&b.reason)).await?))
}

#[logged]
pub async fn audiences_get(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(audiences::snapshot(&e, o.id).await?))
}

#[derive(Deserialize, Debug)]
pub struct AudienceAction {
    action: String,
    node: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    reason: String,
}

/// grant / deny / revoke, as the user.
#[logged]
pub async fn audiences_post(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<AudienceAction>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let target = b.target.as_deref();
    let r = match b.action.as_str() {
        "grant" => audiences::grant(&e, &o, &Actor::User, &b.node, target, &b.reason).await?,
        "deny" => audiences::deny(&e, &o, &Actor::User, &b.node, target).await?,
        "revoke" => audiences::revoke(&e, &o, &Actor::User, &b.node, target).await?,
        other => return Err(ApiError::bad_request(format!("unknown audience action {other}"))),
    };
    Ok(Json(r))
}
