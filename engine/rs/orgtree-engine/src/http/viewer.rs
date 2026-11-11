//! What a viewer-scoped client token may call (docs/standalone-engine.md, viewer tokens).
//! STUB for the red-test commit: nothing is allowed, no route is classified.

use axum::http::Method;

/// `(method, route literal as written in `router`)` pairs a viewer may call.
pub const ALLOWED: &[(&str, &str)] = &[];

/// Every other route of the router, explicitly.
pub const DENIED_FOR_VIEWER: &[&str] = &[];

pub fn is_allowed_route(_route: &str) -> bool { false }

pub fn viewer_allows(_method: &Method, _path: &str, _org: &str) -> bool { false }
