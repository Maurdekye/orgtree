//! Private, read-only exact source windows for selection capture/navigation.
use std::sync::Arc;
use axum::{extract::{Path, State}, Json};
use serde::Deserialize;
use serde_json::Value;
use crate::{engine::Engine, http::{error::{ApiError, ApiResult}, orgs::org}};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBody {
    target: Value,
    part: Value,
    #[serde(default)]
    offset: usize,
    expected_sha256: Option<String>,
    /// Previously delivered snapshot: used only for a verified location result,
    /// never as source prose or permission to read a different object.
    selection: Option<Value>,
}

#[nolog]
pub async fn read(State(engine): State<Arc<Engine>>, Path(slug): Path<String>, Json(body): Json<SourceBody>) -> ApiResult<Json<Value>> {
    let org = org(&engine,&slug)?;
    crate::domain::replies::targets(Some(&body.target),None)?;
    if body.target.get("selection").is_some() { return Err(ApiError::bad_request("target must be the source identity")); }
    let part = crate::domain::selections::Part::parse(&body.part)?;
    let source = crate::domain::reply_sources::load(&engine,&org,&crate::domain::reply_sources::Reader::User,&body.target,&part).await?;
    let mut out = crate::domain::selections::window(&source.text,&part,&source.revision,body.offset,body.expected_sha256.as_deref())?;
    if let Some(snapshot) = &body.selection {
        let selector = crate::domain::selections::Selector::parse(&snapshot["selector"])?;
        if selector.part() != part { return Err(ApiError::bad_request("selection belongs to a different source part")); }
        out["location"] = crate::domain::selections::locate(Some(&source.text),snapshot);
    }
    Ok(Json(out))
}
