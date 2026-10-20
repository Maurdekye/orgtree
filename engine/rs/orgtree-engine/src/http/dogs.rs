//! The user's hand on watchdogs and audiences.

use std::sync::Arc;

use axum::extract::{Path, State, Query};
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

#[derive(Deserialize, Debug)]
pub struct DogRead {
    owner:Option<String>, id:Option<String>, cursor:Option<i64>, limit:Option<i64>, kept:Option<bool>,
}

/// Full owner inventories are read only on expansion, at most 100 rows.
/// Any detail/menu outside the tree preview uses its exact owner/id handle.
#[logged]
pub async fn watchdogs_get(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Query(q):Query<DogRead>)->ApiResult<Json<Value>>{
    let o=org(&e,&slug)?;
    let client=e.db.get().await?;
    if let Some(id)=q.id {
        return Ok(Json(crate::domain::watchdog_inventory::exact(&**client,&e,o.id,&id).await?));
    }
    let owner=q.owner.as_deref().map(str::trim).filter(|s|!s.is_empty())
        .ok_or_else(||ApiError::bad_request("watchdog list needs owner"))?;
    let cursor=q.cursor.unwrap_or(0);
    if cursor<0{return Err(ApiError::bad_request("watchdog cursor must be nonnegative"));}
    Ok(Json(crate::domain::watchdog_inventory::page(&**client,&e,o.id,owner,cursor,q.limit.unwrap_or(50),q.kept.unwrap_or(false)).await?))
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
