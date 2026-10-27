//! Human desktop profile editor. No arbitrary file/URL reads on HTTP; the
//! scoped agent Logo tool shares the native normalization and storage helpers.
use std::sync::Arc;
use axum::{Json,extract::{Path,Query,State}};
use serde::Deserialize;
use crate::{engine::Engine,profile_pictures::{self as p,wire}};
use super::{error::{ApiResult,ApiError},orgs::org};

#[derive(Deserialize)]
pub struct Edit { owner:i64, data:Option<String>, crop:Option<p::image::Crop> }
#[derive(Deserialize)]
pub struct Input { data:String }
#[derive(Deserialize)]
pub struct Mention { address:String }

#[nolog]
pub async fn get(State(e):State<Arc<Engine>>,Path(slug):Path<String>)->ApiResult<Json<serde_json::Value>> {
    let o=org(&e,&slug)?;
    Ok(Json(serde_json::json!({"owner":o.id,"picture":p::load(&e,o.id).await?})))
}
/// The picture a mention of `@org:<slug>` or `@net:<address>` shows in this
/// org's views; `null` keeps the chip's fallback icon.
#[nolog]
pub async fn mention(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Query(q):Query<Mention>)->ApiResult<Json<serde_json::Value>> {
    let o=org(&e,&slug)?;
    Ok(Json(serde_json::json!({"picture":crate::net::pictures::peer(&e,o.id,&q.address).await?})))
}
#[nolog]
pub async fn preview(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Input>)->ApiResult<Json<p::image::Preview>> {
    org(&e,&slug)?;
    let _permit=p::image::DECODE.acquire().await.map_err(|_|ApiError::unavailable("picture decoder unavailable"))?;
    let result=tokio::task::spawn_blocking(move || {
        // Blocking decoding outlives a cancelled HTTP handler; retain its slot.
        let _permit=_permit;
        p::image::decode_input(&input.data).and_then(|bytes|p::image::preview(&bytes))
    }).await
        .map_err(|_|ApiError::unprocessable("image decoding failed"))?.map_err(|err|ApiError::unprocessable(err.to_string()))?;
    Ok(Json(result))
}
#[nolog]
pub async fn set(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Edit>)->ApiResult<Json<wire::PictureRecord>> {
    let o=org(&e,&slug)?;
    if o.id!=input.owner { return Err(ApiError::conflict("organization identity changed")); }
    let bytes=input.data.map(|data|p::image::decode_input(&data)).transpose()
        .map_err(|err|ApiError::unprocessable(err.to_string()))?;
    let record=p::image::prepare(bytes,input.crop.unwrap_or_default()).await
        .map_err(|err|ApiError::unprocessable(err.to_string()))?;
    Ok(Json(p::save(&e,o.id,record,true).await?))
}
