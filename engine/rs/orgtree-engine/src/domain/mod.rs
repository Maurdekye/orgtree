//! Business rules: everything that decides what an action means, kept free
//! of HTTP and of provider specifics.

pub mod asks;
pub mod docs;
pub mod mail;
pub mod notices;
pub mod ops;
pub mod orginbox;
pub mod scope;
pub mod tree;
pub mod watchdogs;

use axum::http::StatusCode;

/// A refusal the caller should see verbatim, with its HTTP status.
#[derive(Debug, thiserror::Error)]
pub enum UserError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Unprocessable(String),
}

#[logged]
impl UserError {
    pub fn status(&self) -> StatusCode {
        match self {
            UserError::BadRequest(_) => StatusCode::BAD_REQUEST,
            UserError::NotFound(_) => StatusCode::NOT_FOUND,
            UserError::Conflict(_) => StatusCode::CONFLICT,
            UserError::Forbidden(_) => StatusCode::FORBIDDEN,
            UserError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }
}

/// `refuse!(BadRequest, "...", args)` → early-return an `anyhow` error
/// carrying a `UserError`.
#[macro_export]
macro_rules! refuse {
    ($kind:ident, $($arg:tt)*) => {
        return Err(anyhow::Error::new($crate::domain::UserError::$kind(format!($($arg)*))))
    };
}

#[logged]
pub fn user_err(kind: fn(String) -> UserError, msg: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(kind(msg.into()))
}
