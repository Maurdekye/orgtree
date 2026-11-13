//! What a computer a hosting desktop let in may call.
//!
//! NOT BUILT: the lists are empty and everything is refused.

use axum::http::Method;

pub const ORG: &[&str] = &[];
pub const READ: &[&str] = &[];
pub const OWN: &[(&str, &str)] = &[];
pub const INVITATION: &[(&str, &str)] = &[];
pub const REFUSED: &[&str] = &[];

/// In how many lists a route of the router is.
#[nolog]
pub fn listed(_route: &str) -> usize { 0 }

/// How the organization a path names stands to the member that asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    Open,
    Shut,
    Foreign,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Refuse,
    Shut,
}

#[nolog]
pub fn verdict(_method: &Method, _path: &str, _client_id: &str, _standing: impl FnOnce(&str) -> Standing) -> Verdict { Verdict::Refuse }

#[nolog]
pub fn invitation_allows(_method: &Method, _path: &str) -> bool { false }

#[nolog]
pub fn log_line(_who: &str, _method: &Method, _path: &str, _outcome: &str) -> String { String::new() }
