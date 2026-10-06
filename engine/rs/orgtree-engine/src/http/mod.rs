//! HTTP: every `/api/*` route the renderer and the desktop call, the two
//! push sockets, and the renderer bundle.

pub mod desktop;
pub mod error;
pub mod nodes;
pub mod orgs;
pub mod tree;

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;

use crate::engine::Engine;
use error::ApiError;

pub const TOKEN_HEADER: &str = "x-orgtree-desktop-token";

pub fn router(engine: Arc<Engine>) -> Router {
    let api = Router::new()
        // desktop launcher / tray
        .route("/api/desktop/identity", get(desktop::identity))
        .route("/api/desktop/alive", get(desktop::alive))
        .route("/api/desktop/status", get(desktop::status))
        .route("/api/desktop/shutdown", post(desktop::shutdown))
        .route("/api/host", get(desktop::host))
        .route("/api/diagnostics/engine-stats", get(desktop::engine_stats))
        // app feed
        .route("/api/app/records", get(orgs::app_records))
        .route("/api/app/ws", get(crate::appfeed::app_ws))
        // organizations
        .route("/api/orgs", get(orgs::list))
        .route("/api/orgs/{slug}", get(orgs::tree))
        .route("/api/orgs/{slug}/ws", get(crate::feed::socket::org_ws))
        .route("/api/orgs/{slug}/records", get(orgs::records))
        .route("/api/orgs/{slug}/changes", get(orgs::changes))
        .route("/api/orgs/{slug}/records/selection", get(orgs::selection))
        .route("/api/orgs/{slug}/foreground-tree", get(orgs::compatibility))
        .route("/api/orgs/{slug}/foreground-tree/{*rest}", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-items-foreground", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-items-archive-page", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-item-references", get(orgs::compatibility))
        .route("/api/orgs/{slug}/resume", post(nodes::resume))
        // one agent's desk
        .route("/api/orgs/{slug}/nodes/{nid}/chat", get(nodes::chat))
        .route("/api/orgs/{slug}/nodes/{nid}/message", post(nodes::message))
        .route("/api/orgs/{slug}/nodes/{nid}/mail/{mid}", delete(nodes::retract))
        .route("/api/orgs/{slug}/nodes/{nid}/inbox", get(nodes::inbox))
        .route("/api/orgs/{slug}/nodes/{nid}/interrupt", post(nodes::interrupt))
        .route("/api/orgs/{slug}/nodes/{nid}/halt", post(nodes::halt))
        .route("/api/orgs/{slug}/nodes/{nid}/unhalt", post(nodes::unhalt))
        .route("/api/orgs/{slug}/nodes/{nid}/compact", post(nodes::compact))
        .route("/api/orgs/{slug}/nodes/{nid}/process", post(nodes::process))
        .route("/api/orgs/{slug}/nodes/{nid}/unstick", post(nodes::unstick))
        .route("/api/orgs/{slug}/nodes/{nid}/continue-on", post(nodes::continue_on))
        .route("/api/orgs/{slug}/nodes/{nid}/remote-control", post(nodes::remote_control))
        .route("/api/orgs/{slug}/nodes/{nid}/scope", post(nodes::set_scope))
        .route(
            "/api/orgs/{slug}/nodes/{nid}/upload",
            post(nodes::upload).layer(axum::extract::DefaultBodyLimit::max(2 << 30)),
        )
        .route("/api/orgs/{slug}/nodes/{nid}/file", get(nodes::file))
        .route("/api/orgs/{slug}/nodes/{nid}/scratch", get(nodes::scratch))
        .fallback(api_not_found);

    Router::new()
        .merge(api)
        .fallback(ui)
        .layer(middleware::from_fn_with_state(engine.clone(), guard))
        .with_state(engine)
}

/// The renderer bundle: a file under the UI folder, else `index.html`
/// (never cached: it names the content-hashed assets).
async fn ui(State(engine): State<Arc<Engine>>, req: Request) -> Response {
    let Some(dir) = engine.cfg.ui_dir.clone() else {
        return (StatusCode::NOT_FOUND, "no UI bundle configured").into_response();
    };
    let rel = req.uri().path().trim_start_matches('/');
    if rel.starts_with("api/") {
        return api_not_found(req).await;
    }
    let safe = !rel.split(['/', '\\']).any(|seg| seg == ".." || seg.contains(':'));
    if safe && !rel.is_empty() {
        let full = dir.join(rel);
        if full.is_file() {
            if let Ok(bytes) = tokio::fs::read(&full).await {
                let mime = mime_guess::from_path(&full).first_or_octet_stream();
                let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
                return (
                    [(axum::http::header::CONTENT_TYPE, mime.to_string()), (axum::http::header::CACHE_CONTROL, cache.to_string())],
                    bytes,
                )
                    .into_response();
            }
        }
    }
    match tokio::fs::read(dir.join("index.html")).await {
        Ok(bytes) => (
            [
                (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "index.html missing").into_response(),
    }
}

async fn api_not_found(req: Request) -> Response {
    ApiError::not_found(format!("no route {} {}", req.method(), req.uri().path())).into_response()
}

/// Every API request carries the desktop's per-launch token; every response
/// carries this process's instance id (the renderer's restart detector).
async fn guard(State(engine): State<Arc<Engine>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path.starts_with("/api/") && !engine.cfg.desktop_token.is_empty() {
        let ok = req
            .headers()
            .get(TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(|v| constant_eq(v.as_bytes(), engine.cfg.desktop_token.as_bytes()))
            .unwrap_or(false);
        if !ok {
            return (StatusCode::FORBIDDEN, axum::Json(serde_json::json!({ "detail": "desktop token required" })))
                .into_response();
        }
    }
    let mut res = next.run(req).await;
    if let Ok(v) = HeaderValue::from_str(&engine.boot.id) {
        res.headers_mut().insert("x-orgtree-instance", v);
    }
    res
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
