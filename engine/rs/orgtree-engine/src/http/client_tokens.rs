use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::client_tokens::Scope;
use crate::engine::Engine;
use super::error::{ApiError, ApiResult};

#[nolog]
pub fn manage(engine: &Engine, args: &Value) -> ApiResult<Value> {
    let registry = engine.clients.as_ref().filter(|_| engine.cfg.standalone)
        .ok_or_else(|| ApiError::not_found("client tokens are available in standalone mode only"))?;
    // A viewer token is bound to an org that exists now (the registry checks the argument shapes).
    if args["action"] == "create" && args["scope"] == "viewer" {
        if let Some(org) = args["org"].as_str() {
            if engine.orgs.get(org).is_none() { return Err(ApiError::not_found(format!("no organization {org}"))); }
        }
    }
    registry.manage(args)
}

/// The clients, and `you`: whose token asked (`caller::Origin`), so a
/// connected desktop learns which of the rows is its own.
///
/// At a hosting desktop's remote door a member reads its own record and no other
/// (`remote_access::own_list`).
#[nolog]
pub async fn list(State(engine): State<Arc<Engine>>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    if let Some(Extension(Scope::Member { client_id, .. })) = &scope {
        return Ok(Json(crate::remote_access::own_list(&engine, client_id)?));
    }
    let mut listed = manage(&engine, &json!({"action":"list"}))?;
    if let Some(origin) = crate::caller::current() { listed["you"] = origin.json(); }
    Ok(Json(listed))
}

/// `PATCH /api/standalone/clients/{id} {"label": text | null}`: what other
/// people see for one client; `null` or blank goes back to its own name. A
/// full token may set anyone's (every full token is the user); a viewer token
/// never reaches this route (`http/viewer.rs`).
///
/// A member of a hosting desktop sets its own (the door's route table lets no other id through).
#[nolog]
pub async fn label(State(engine): State<Arc<Engine>>, Path(id): Path<String>, scope: Option<Extension<Scope>>,
                   Json(body): Json<serde_json::Map<String, Value>>) -> ApiResult<Json<Value>> {
    if body.len() != 1 { return Err(ApiError::bad_request("the body is {\"label\": text or null}")); }
    let label = match body.get("label") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.as_str()),
        _ => return Err(ApiError::bad_request("the body is {\"label\": text or null}")),
    };
    if let Some(Extension(Scope::Member { client_id, .. })) = &scope {
        if *client_id != id { return Err(ApiError::forbidden(crate::remote_access::text::TOKEN_REQUIRED)); }
        return Ok(Json(crate::remote_access::set_own_label(&engine, client_id, label)?));
    }
    let registry = engine.clients.as_ref().filter(|_| engine.cfg.standalone)
        .ok_or_else(|| ApiError::not_found("client tokens are available in standalone mode only"))?;
    Ok(Json(registry.set_label(&id, label)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create { name: String, scope: Option<String>, org: Option<String> }

/// With a one-time code at a hosting desktop's remote door this makes the one computer the code
/// is for (`remote_access::redeem`): a name and nothing else.
#[nolog]
pub async fn create(State(engine): State<Arc<Engine>>, scope: Option<Extension<Scope>>, headers: HeaderMap, Json(body): Json<Create>) -> ApiResult<Json<Value>> {
    if let Some(Extension(Scope::Invitation { .. })) = &scope {
        if body.scope.is_some() || body.org.is_some() { return Err(ApiError::bad_request("a code makes one computer: the body is {\"name\": text}")); }
        return Ok(Json(crate::remote_access::redeem(&engine, &headers, &body.name)?));
    }
    let mut args = json!({"action":"create","name":body.name});
    if let Some(scope) = body.scope { args["scope"] = json!(scope); }
    if let Some(org) = body.org { args["org"] = json!(org); }
    Ok(Json(manage(&engine, &args)?))
}

#[nolog]
pub async fn revoke(State(engine): State<Arc<Engine>>, Path(id): Path<String>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    if let Some(Extension(Scope::Member { client_id, .. })) = &scope {
        if *client_id != id { return Err(ApiError::forbidden(crate::remote_access::text::TOKEN_REQUIRED)); }
        return Ok(Json(crate::remote_access::remove_own(&engine, client_id)?));
    }
    Ok(Json(manage(&engine, &json!({"action":"revoke","id":id}))?))
}
