//! Human desktop profile editor. No agent tool and no arbitrary file/URL reads.
use std::sync::Arc;
use axum::{Json,extract::{Path,State}};
use serde::Deserialize;
use crate::{engine::Engine,profile_pictures::{self as p,wire}};
use super::{error::{ApiResult,ApiError},orgs::org};
static DECODE:tokio::sync::Semaphore=tokio::sync::Semaphore::const_new(1);

#[derive(Deserialize)]
pub struct Edit { owner:i64, data:Option<String>, crop:Option<p::image::Crop> }
#[derive(Deserialize)]
pub struct Input { data:String }

#[nolog]
pub async fn get(State(e):State<Arc<Engine>>,Path(slug):Path<String>)->ApiResult<Json<serde_json::Value>> {
    let o=org(&e,&slug)?;
    Ok(Json(serde_json::json!({"owner":o.id,"picture":p::load(&e,o.id).await?})))
}
#[nolog]
pub async fn preview(State(e):State<Arc<Engine>>,Path(slug):Path<String>,Json(input):Json<Input>)->ApiResult<Json<p::image::Preview>> {
    org(&e,&slug)?;
    let _permit=DECODE.acquire().await.map_err(|_|ApiError::unavailable("picture decoder unavailable"))?;
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
    let _permit=DECODE.acquire().await.map_err(|_|ApiError::unavailable("picture decoder unavailable"))?;
    let record=tokio::task::spawn_blocking(move || -> p::Result<_> {
        let _permit=_permit;
        let revision=wire::next_revision(None)?;
        match input.data {
            None=>Ok(wire::PictureRecord::removed(revision)),
            Some(data)=>{
                let bytes=p::image::decode_input(&data)?;
                let (png,size)=p::image::normalize(&bytes,input.crop.unwrap_or_default())?;
                wire::from_png(revision,png,size)
            }
        }
    }).await.map_err(|_|ApiError::unprocessable("image decoding failed"))?.map_err(|err|ApiError::unprocessable(err.to_string()))?;
    Ok(Json(p::save(&e,o.id,record,true).await?))
}
