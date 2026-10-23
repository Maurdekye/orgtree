use std::sync::Arc;
use axum::{extract::{Path, Query, State}, Json};
use serde::Deserialize;
use serde_json::Value;
use crate::{engine::Engine, domain::mention_navigation};
use super::{error::ApiResult, orgs::org};

#[derive(Deserialize)]
pub struct Page { before: Option<String>, latest: Option<String> }

#[nolog]
pub async fn next(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Query(q):Query<Page>) -> ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    if q.before.as_ref().is_some_and(|s|s.len()>100 || mention_navigation::cursor(s).is_none()) {
        return Err(crate::domain::user_err(crate::domain::UserError::BadRequest,"invalid mention cursor").into());
    }
    let client=e.db.get().await?;
    Ok(Json(mention_navigation::next(&**client,o.id,q.before.as_deref(),q.latest.as_deref()).await?))
}
