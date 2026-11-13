//! Who a hosting desktop let in: `<data>/remote-access.json`.
//!
//! NOT BUILT: every change is refused and nobody is known.

use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::caller::Origin;
use crate::client_tokens::transport::Connection;
use crate::http::error::ApiError;

pub const FILE: &str = "remote-access.json";
/// Computers one organization may have.
pub const MAX_COMPUTERS: usize = 32;
/// Codes one organization may have open at a time.
pub const MAX_INVITATIONS: usize = 5;
/// How long a code is valid, in minutes.
pub const INVITATION_MINUTES: i64 = 15;
/// The length of a code, in characters.
pub const CODE_LENGTH: usize = 26;

/// What a token presented at the door is.
pub enum Admitted {
    Member { client_id: String, orgs: Vec<String>, origin: Origin },
    Invitation { org: String },
}

pub struct Registry;

#[nolog]
fn not_built<T>() -> Result<T, ApiError> {
    Err(ApiError::not_implemented("remote access is not built"))
}

#[nolog]
impl Registry {
    pub fn open(_root: &Path) -> Registry { Registry }
    pub fn authenticate(&self, _token: &str, _connection: &Arc<Connection>) -> Option<Admitted> { None }
    pub(crate) fn authenticate_at(&self, _token: &str, _connection: &Arc<Connection>, _now: DateTime<Utc>) -> Option<Admitted> { None }
    pub fn invite(&self, _org: &str) -> Result<Value, ApiError> { not_built() }
    pub(crate) fn invite_at(&self, _org: &str, _now: DateTime<Utc>) -> Result<Value, ApiError> { not_built() }
    pub fn redeem(&self, _code: &str, _name: &str) -> Result<Option<Value>, ApiError> { not_built() }
    pub(crate) fn redeem_at(&self, _code: &str, _name: &str, _now: DateTime<Utc>) -> Result<Option<Value>, ApiError> { not_built() }
    pub fn give(&self, _client_id: &str, _org: &str) -> Result<Value, ApiError> { not_built() }
    pub fn revoke(&self, _client_id: &str) -> Result<Value, ApiError> { not_built() }
    pub fn forget_org(&self, _org: &str) -> Result<(), ApiError> { not_built() }
    pub fn set_label(&self, _client_id: &str, _label: Option<&str>) -> Result<Value, ApiError> { not_built() }
    pub fn row(&self, _client_id: &str) -> Option<Value> { None }
    pub fn rows(&self, _org: Option<&str>) -> Vec<Value> { Vec::new() }
    pub fn invitations(&self, _org: &str) -> Vec<Value> { Vec::new() }
    pub fn is_empty(&self) -> bool { true }
}
