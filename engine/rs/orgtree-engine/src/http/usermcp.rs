//! The user MCP endpoint over HTTP (standalone mode only): stateless
//! Streamable HTTP — one JSON-RPC message per POST, one JSON answer.
//! `POST /api/mcp` finds or creates an org; `POST /api/orgs/{slug}/mcp`
//! manages it. The token guard in `http/mod.rs` has already authenticated
//! every request before a handler runs (standalone requires the token on
//! every path); outside standalone mode these routes answer 404. The tools
//! themselves live in `tools::usermcp`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::http::error::ApiError;
use crate::http::orgs::org;
use crate::orgs::OrgHandle;

#[logged]
pub async fn orgless(State(e): State<Arc<Engine>>, Json(body): Json<Value>) -> Response {
    run(e, None, body).await
}

#[logged]
pub async fn per_org(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(body): Json<Value>) -> Response {
    let o = match org(&e, &slug) {
        Ok(o) => o,
        Err(err) => return err.into_response(),
    };
    run(e, Some(&o), body).await
}

/// This endpoint is stateless: there is no server-opened stream to GET.
#[logged]
pub async fn no_stream(State(e): State<Arc<Engine>>) -> Response {
    if !e.cfg.standalone {
        return ApiError::not_found("the user MCP endpoint runs in standalone mode").into_response();
    }
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({ "detail": "the user MCP endpoint is stateless: POST one JSON-RPC message per request" }))).into_response()
}

#[logged]
async fn run(engine: Arc<Engine>, org: Option<&Arc<OrgHandle>>, body: Value) -> Response {
    if !engine.cfg.standalone {
        return ApiError::not_found("the user MCP endpoint runs in standalone mode").into_response();
    }
    match body {
        Value::Array(msgs) => {
            let mut out = Vec::new();
            for m in &msgs {
                let res = crate::tools::usermcp::handle(&engine, org, m).await;
                if m.get("id").is_some_and(|i| !i.is_null()) {
                    out.push(res);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        Value::Object(_) => {
            let has_id = body.get("id").is_some_and(|i| !i.is_null());
            let res = crate::tools::usermcp::handle(&engine, org, &body).await;
            if has_id {
                Json(res).into_response()
            } else {
                // a notification: handled, nothing to answer
                StatusCode::ACCEPTED.into_response()
            }
        }
        _ => (StatusCode::BAD_REQUEST, Json(json!({ "detail": "expected one JSON-RPC message object" }))).into_response(),
    }
}
