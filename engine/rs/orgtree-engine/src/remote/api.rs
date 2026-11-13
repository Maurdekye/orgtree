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
    available(&engine)?;
    // `me`: who this desktop's own windows are in the records of its own organizations (`caller::LOCAL`)
    Ok(Json(json!({ "remotes": engine.remotes.views(), "me": crate::http::local_origin(&engine).json() })))
}

/// `PUT /api/remotes/shown-as {"label": text | null}`: what this desktop is
/// called where other people see its actions; `null` or blank is the
/// computer's name again. Every connection gives it to its engine.
#[nolog]
pub async fn shown_as(State(engine): State<Arc<Engine>>, Json(body): Json<serde_json::Map<String, Value>>) -> ApiResult<Json<Value>> {
    available(&engine)?;
    let label = match (body.len(), body.get("label")) {
        (1, Some(Value::Null)) => None,
        (1, Some(Value::String(text))) => Some(text.clone()),
        _ => return Err(ApiError::bad_request("the body is {\"label\": text or null}")),
    };
    engine.remotes.set_shown_as(&engine, label).await.map_err(refused)?;
    Ok(Json(json!({ "shown_as": engine.remotes.chosen_name(), "me": crate::http::local_origin(&engine).json() })))
}

/// `GET /api/remotes/{id}/people`: who is connected to that engine right now.
#[nolog]
pub async fn people(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    available(&engine)?;
    let remote = engine.remotes.get(&id).ok_or_else(|| ApiError::not_found("no such remote engine"))?;
    Ok(Json(engine.remotes.people(&remote).await.map_err(refused)?))
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
    available(&engine)?;
    let input = AddInput { url: body.url, token: Token::new(body.token.trim()), name: body.name };
    let remote = engine.remotes.add(&engine, input).await.map_err(refused)?;
    Ok(Json(remote.view()))
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
    available(&engine)?;
    let patch = Patch { name: body.name, enabled: body.enabled, token: body.token.map(|t| Token::new(t.trim())), url: body.url };
    let remote = engine.remotes.update(&engine, &id, patch).await.map_err(refused)?;
    Ok(Json(remote.view()))
}

/// `DELETE /api/remotes/{id}`: remove the connection. Nothing on the remote
/// engine is deleted; `revoked` says whether this desktop's client token there
/// was taken back.
#[nolog]
pub async fn remove(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    available(&engine)?;
    let revoked = engine.remotes.remove(&engine, &id).await.map_err(refused)?;
    Ok(Json(json!({ "removed": id, "revoked": revoked })))
}

/// `POST /api/remotes/{id}/retry`: try to connect now.
#[nolog]
pub async fn retry(State(engine): State<Arc<Engine>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    available(&engine)?;
    let remote = engine.remotes.get(&id).ok_or_else(|| ApiError::not_found("no such remote engine"))?;
    remote.wake.notify_one();
    Ok(Json(remote.view()))
}
