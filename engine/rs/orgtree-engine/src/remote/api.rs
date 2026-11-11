//! `/api/remotes`: the desktop's management of its remote engines
//! (docs/rust-engine/remote-org.md, "Local management routes"). They need the
//! desktop token like every route, are never carried to a remote engine, are
//! no agent tool, and answer 404 on a standalone engine (no chained relays).
//!
//! The bodies of `POST` and `PATCH` carry a token: the wire log omits them
//! (`http::quiet_body`), the body types print no token, and the handlers are
//! not logged.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::store::Token;
use super::{text, AddInput, Kind, Patch, Refusal};
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};

/// A refusal as the renderer reads it: `detail` is the sentence, `code` its
/// id in the text table when it has one.
#[nolog]
fn refused(refusal: Refusal) -> ApiError {
    let status = match refusal.kind {
        Kind::Input => StatusCode::BAD_REQUEST,
        Kind::Offline => StatusCode::BAD_GATEWAY,
        Kind::Auth => StatusCode::FORBIDDEN,
        Kind::Refused => StatusCode::UNPROCESSABLE_ENTITY,
        Kind::Storage => StatusCode::INTERNAL_SERVER_ERROR,
        Kind::Missing => StatusCode::NOT_FOUND,
    };
    let error = ApiError::new(status, refusal.text);
    if refusal.code.is_empty() { error } else { error.with(json!({ "code": refusal.code })) }
}

#[nolog]
fn available(engine: &Engine) -> ApiResult<()> {
    if engine.remotes.active(engine) { Ok(()) } else { Err(ApiError::not_found(text::STANDALONE)) }
}

/// `GET /api/remotes`: every connection, its state and its organizations.
#[nolog]
pub async fn list(State(engine): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_found("remote engines are not built yet"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddBody {
    url: String,
    token: String,
    #[serde(default)]
    name: Option<String>,
}

impl std::fmt::Debug for AddBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AddBody { token: ***** }")
    }
}

/// `POST /api/remotes {url, token, name?}`: add a remote engine. Everything
/// is checked before anything is saved.
#[nolog]
pub async fn add(State(engine): State<Arc<Engine>>, Json(body): Json<AddBody>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_found("remote engines are not built yet"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

impl std::fmt::Debug for PatchBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PatchBody { token: ***** }")
    }
}

/// `PATCH /api/remotes/{id} {name?, enabled?, token?, url?}`: rename,
/// disconnect or connect, replace the token, or move the address.
#[nolog]
pub async fn update(State(engine): State<Arc<Engine>>, Path(id): Path<String>, Json(body): Json<PatchBody>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_found("remote engines are not built yet"))
}

/// `DELETE /api/remotes/{id}`: remove the connection. Nothing on the remote
/// engine is deleted; `revoked` says whether this desktop's client token there
/// was taken back.
#[nolog]
pub async fn remove(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_found("remote engines are not built yet"))
}

/// `POST /api/remotes/{id}/retry`: try to connect now.
#[nolog]
pub async fn retry(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_found("remote engines are not built yet"))
}
