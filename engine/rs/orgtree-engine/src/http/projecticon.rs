//! A project's uploaded icon (@item:orgtree/project-themes-colour-the-whole-
//! project-node-by-i; USER 2026-11-03 09:22:44Z mc4fd305e1c09 "2 shouls be
//! able to uplosd a cuwtom icon"). The desktop's project settings send the
//! file here (an SVG already rasterised to PNG by the desktop); the engine
//! decodes it with the Logo's bounded decoder, normalises it to a 256 PNG and
//! stores it through the `set_theme` op, whose arguments carry only its hash.
//! There is no agent tool (the theme stays the user's, as set_theme).
use std::sync::Arc;
use axum::{Json,extract::{Path,Query,State}};
use serde::Deserialize;
use serde_json::{json,Value};
use crate::{domain::{ops::{self,Actor},projects},engine::Engine,profile_pictures::{self as p,wire}};
use super::{error::{ApiResult,ApiError},orgs::org};

#[derive(Deserialize)]
pub struct Which { node:String }
#[derive(Deserialize)]
pub struct Upload { node:String, data:Option<String> }

/// The project's uploaded icon, verified against its stored hash; `null`
/// when it has none (the desktop then draws its built-in icon).
#[nolog]
pub async fn get(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Query(q):Query<Which>)->ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let c=e.db.get().await?;
    let name=q.node.trim().trim_start_matches('@');
    let row=c.query_opt("SELECT id,scope FROM ot.agents WHERE org_id=$1 AND name=$2 AND state<>'deleted'",&[&o.id,&name]).await?;
    let Some(row)=row else { return Ok(Json(json!({"picture":Value::Null}))) };
    let (id,scope):(i64,Option<Value>)=(row.get(0),row.get(1));
    let scope=scope.unwrap_or(Value::Null);
    let Some(sha)=projects::theme_icon_custom(&scope) else { return Ok(Json(json!({"picture":Value::Null}))) };
    let stored=c.query_opt("SELECT value FROM ot.meta WHERE key=$1",&[&projects::icon_key(o.id,id)]).await?;
    let record:Option<wire::PictureRecord>=stored.and_then(|r|serde_json::from_value(r.get(0)).ok());
    let picture=record.filter(|r|r.meta.sha256.as_deref()==Some(sha.as_str()) && r.decoded().is_ok_and(|b|b.is_some()));
    Ok(Json(json!({"picture":picture})))
}

/// `{node, data}`: base64 of a PNG, JPEG or WebP up to 2 MB, or `null` to
/// remove the upload (back to the built-in icon).
#[nolog]
pub async fn set(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Upload>)->ApiResult<Json<Value>> {
    let o=org(&e,&slug)?;
    let Some(data)=input.data else {
        return Ok(Json(ops::run(&e,&o,Actor::User,&json!({"op":"set_theme","node":input.node,"theme_icon_custom":Value::Null})).await?));
    };
    let bytes=p::image::decode_icon_input(&data).map_err(|err|ApiError::unprocessable(err.to_string()))?;
    let permit=p::image::DECODE.acquire().await.map_err(|_|ApiError::unavailable("picture decoder unavailable"))?;
    let record=tokio::task::spawn_blocking(move || {
        // blocking decoding outlives a cancelled HTTP handler; keep its slot
        let _permit=permit;
        let png=p::image::normalize_icon(&bytes)?;
        wire::from_png(wire::next_revision(None)?,png,p::image::ICON_SIZE)
    }).await.map_err(|_|ApiError::unprocessable("image decoding failed"))?
        .map_err(|err|ApiError::unprocessable(err.to_string()))?;
    let sha=record.meta.sha256.clone().ok_or_else(||ApiError::unprocessable("image decoding failed"))?;
    projects::STAGED_ICONS.lock().unwrap_or_else(|p|p.into_inner()).insert(sha.clone(),record);
    let out=ops::run(&e,&o,Actor::User,&json!({"op":"set_theme","node":input.node,"theme_icon_custom":sha})).await;
    projects::STAGED_ICONS.lock().unwrap_or_else(|p|p.into_inner()).remove(&sha);
    Ok(Json(out?))
}
