//! The one error shape every route answers with: `{"detail": "..."}` and a
//! status code — what the renderer's `failure()` reads.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: String,
    pub extra: Option<serde_json::Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

#[logged]
impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        ApiError { status, detail: detail.into(), extra: None }
    }
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }
    pub fn conflict(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }
    pub fn forbidden(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, detail)
    }
    pub fn unprocessable(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, detail)
    }
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, detail)
    }
    pub fn not_implemented(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_IMPLEMENTED, detail)
    }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, detail)
    }
    /// A 409 the renderer's foreground readers treat as "use the full read".
    pub fn compatibility() -> Self {
        ApiError {
            status: StatusCode::CONFLICT,
            detail: "this engine serves the full read".into(),
            extra: Some(json!({ "kind": "compatibility" })),
        }
    }
    pub fn with(mut self, extra: serde_json::Value) -> Self {
        self.extra = Some(extra);
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "detail": self.detail });
        if let Some(serde_json::Value::Object(extra)) = self.extra {
            if let serde_json::Value::Object(map) = &mut body {
                for (k, v) in extra {
                    map.insert(k, v);
                }
            }
        }
        (self.status, Json(body)).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        // A domain error raised as `UserError` keeps its status; anything else is a 500.
        if let Some(u) = e.downcast_ref::<crate::domain::UserError>() {
            return ApiError::new(u.status(), u.to_string());
        }
        tracing::error!(error = %format!("{e:#}"), "request failed");
        ApiError::internal(format!("{e:#}"))
    }
}

impl From<tokio_postgres::Error> for ApiError {
    fn from(e: tokio_postgres::Error) -> Self {
        tracing::error!(error = %e, "database error");
        ApiError::internal(format!("database: {e}"))
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        tracing::error!(error = %e, "database pool");
        ApiError::unavailable(format!("database unavailable: {e}"))
    }
}

impl From<crate::domain::UserError> for ApiError {
    fn from(e: crate::domain::UserError) -> Self {
        ApiError::new(e.status(), e.to_string())
    }
}
