//! HTTP: every `/api/*` route the renderer and the desktop call, the two
//! push sockets, and the renderer bundle.

pub mod asks;
pub mod desktop;
pub mod docs;
pub mod dogs;
pub mod docket;
pub mod orginbox;
pub mod reports;
pub mod error;
pub mod mailbox;
pub mod nodes;
pub mod orgops;
pub mod orgs;
pub mod settings;
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

#[logged]
pub fn router(engine: Arc<Engine>) -> Router {
    let api = Router::new()
        // desktop launcher / tray
        .route("/api/desktop/identity", get(desktop::identity))
        .route("/api/desktop/alive", get(desktop::alive))
        .route("/api/desktop/status", get(desktop::status))
        .route("/api/desktop/shutdown", post(desktop::shutdown))
        .route("/api/desktop/notifications", get(reports::notifications))
        .route("/api/crash-report", post(reports::crash_report))
        .route("/api/crash-reports", get(reports::crash_reports))
        .route("/api/host", get(desktop::host))
        .route("/api/diagnostics/engine-stats", get(desktop::engine_stats))
        // app feed
        .route("/api/app/records", get(orgs::app_records))
        .route("/api/app/ws", get(crate::appfeed::app_ws))
        // organizations
        .route("/api/orgs", get(orgs::list).post(orgops::create))
        .route("/api/orgs/{slug}", get(orgs::tree).delete(orgops::delete))
        .route("/api/orgs/{slug}/retry", post(orgops::retry))
        .route("/api/orgs/{slug}/settings", post(settings::save_org))
        .route("/api/orgs/{slug}/asks/{aid}/answer", post(asks::answer))
        .route("/api/orgs/{slug}/credit-requests", post(asks::credit))
        .route("/api/orgs/{slug}/nodes/{nid}/batch", post(asks::batch))
        .route("/api/orgs/{slug}/watchdogs", post(dogs::watchdog))
        .route("/api/orgs/{slug}/org_inbox", get(orginbox::list))
        .route("/api/orgs/{slug}/org_inbox/read", post(orginbox::read))
        .route("/api/orgs/{slug}/org_inbox/send", post(orginbox::send))
        .route("/api/orgs/{slug}/org_inbox/upload", post(orginbox::upload).layer(axum::extract::DefaultBodyLimit::max(26 * 1024 * 1024)))
        .route("/api/orgs/{slug}/audiences", get(dogs::audiences_get).post(dogs::audiences_post))
        .route("/api/orgs/{slug}/documents", get(docs::list))
        .route("/api/orgs/{slug}/documents/{did}", get(docs::get).delete(docs::dismiss))
        .route("/api/orgs/{slug}/documents/{did}/mockup", get(docs::mockup))
        .route("/api/orgs/{slug}/documents/{did}/download", get(docs::download))
        .route("/api/orgs/{slug}/inbox", get(mailbox::inbox))
        .route("/api/orgs/{slug}/inbox/read", post(mailbox::mark_read))
        .route("/api/orgs/{slug}/inbox/clear", post(mailbox::clear))
        .route("/api/orgs/{slug}/mail/{box}/{id}", get(mailbox::mail_by_id))
        .route("/api/orgs/{slug}/events", get(mailbox::events))
        .route("/api/orgs/{slug}/nodes/{nid}/history", get(mailbox::history))
        .route("/api/orgs/{slug}/nodes/{nid}/detail", get(mailbox::detail))
        .route("/api/orgs/{slug}/defaults", post(settings::save_org_defaults))
        .route("/api/orgs/{slug}/orgmd", get(settings::get_orgmd).put(settings::put_orgmd))
        .route("/api/defaults", get(settings::get_defaults).post(settings::save_defaults))
        .route("/api/app-settings/runtime", get(settings::get_runtime).put(settings::put_runtime))
        .route(
            "/api/app-settings/charter-template-dirs",
            get(settings::get_template_dirs).put(settings::put_template_dirs),
        )
        .route("/api/providers", get(settings::get_providers))
        .route("/api/providers/{provider}/enabled", axum::routing::put(settings::provider_enabled))
        .route("/api/providers/{provider}/apikey-fallback", axum::routing::put(settings::provider_apikey_fallback))
        .route(
            "/api/providers/{provider}/subscription-inference",
            axum::routing::put(settings::provider_subscription_inference),
        )
        .route("/api/mcp-servers", get(settings::mcp_servers))
        .route("/api/charters", get(settings::charters))
        .route("/api/charters/populate", post(settings::charters_populate))
        .route("/api/charters/open", post(settings::charters_open))
        .route("/api/fs", get(settings::fs))
        .route("/api/orgs/{slug}/ops", post(orgops::run_op))
        .route("/api/orgs/{slug}/dissolve-all", post(orgops::dissolve_all))
        .route("/api/orgs/{slug}/killswitch", post(orgops::killswitch))
        .route("/api/orgs/{slug}/killswitch/release", post(orgops::killswitch_release))
        .route("/api/orgs/{slug}/ws", get(crate::feed::socket::org_ws))
        .route("/api/orgs/{slug}/records", get(orgs::records))
        .route("/api/orgs/{slug}/changes", get(orgs::changes))
        .route("/api/orgs/{slug}/records/selection", get(orgs::selection))
        .route("/api/orgs/{slug}/foreground-tree", get(orgs::compatibility))
        .route("/api/orgs/{slug}/foreground-tree/{*rest}", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-items-foreground", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-items-archive-page", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-item-references", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-item-reference/{wid}", get(orgs::compatibility))
        .route("/api/orgs/{slug}/work-items-view", get(docket::view))
        .route("/api/orgs/{slug}/work-items", get(docket::view))
        .route("/api/orgs/{slug}/work-items/{wid}", get(docket::get))
        .route("/api/orgs/{slug}/work-items/{wid}/reply", post(docket::reply))
        .route("/api/orgs/{slug}/work-items/{wid}/quick-staff", get(docket::quick_preview).post(docket::quick_commit))
        .route("/api/orgs/{slug}/work-items/{wid}/dismiss-attention", post(docket::dismiss))
        .route(
            "/api/orgs/{slug}/work-items/{wid}/attachments",
            post(docket::attach).layer(axum::extract::DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route("/api/orgs/{slug}/work-items/{wid}/attachments/{aid}", get(docket::attachment).delete(docket::detach))
        .route("/api/orgs/{slug}/work-items/{wid}/artifacts/{aid}", get(docket::artifact))
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
        .route("/api/orgs/{slug}/nodes/{nid}/reorder", post(orgops::reorder))
        .route("/api/orgs/{slug}/nodes/{nid}/account", post(orgops::account))
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
#[logged]
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

#[logged]
async fn api_not_found(req: Request) -> Response {
    ApiError::not_found(format!("no route {} {}", req.method(), req.uri().path())).into_response()
}

/// Every API request carries the desktop's per-launch token; every response
/// carries this process's instance id (the renderer's restart detector) and
/// the request's id. Each request is logged as its own request (decision 34):
/// REQUEST, HEADERS and RESPONSE lines with masked bodies.
async fn guard(State(engine): State<Arc<Engine>>, req: Request, next: Next) -> Response {
    let client = if req.uri().path().starts_with("/api/desktop/") { "desktop" } else { "user" };
    tracing::Instrument::instrument(guarded(engine, req, next), crate::trace::request(client)).await
}

/// Bodies the log never holds: uploads, downloads, the UI bundle, sockets.
fn quiet_body(path: &str, headers: &axum::http::HeaderMap) -> bool {
    !path.starts_with("/api/")
        || path.ends_with("/upload")
        || path.ends_with("/file")
        || headers.contains_key(axum::http::header::UPGRADE)
        || headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.starts_with("multipart/") || ct.starts_with("application/octet-stream"))
            .unwrap_or(false)
}

fn body_text(bytes: &[u8]) -> Option<crate::trace::Shown> {
    if bytes.is_empty() {
        return None;
    }
    Some(match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(v) => crate::trace::Shown::json(&v),
        Err(_) => crate::trace::Shown::text(String::from_utf8_lossy(bytes).to_string()),
    })
}

async fn guarded(engine: Arc<Engine>, req: Request, next: Next) -> Response {
    use axum::extract::ConnectInfo;
    let peer = req
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0.to_string())
        .unwrap_or_else(|| "-".into());
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let target = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| path.clone());
    let info = format!("{peer} {method} {target}");
    let quiet = quiet_body(&path, req.headers());
    let headers: serde_json::Map<String, serde_json::Value> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), serde_json::Value::String(v.to_str().unwrap_or("<binary>").to_string())))
        .collect();
    let req = if quiet {
        tracing::info!(target: "wire", "REQUEST  {info} | [body omitted]");
        req
    } else {
        let (parts, body) = req.into_parts();
        let bytes = match axum::body::to_bytes(body, 64 << 20).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(target: "wire", "REQUEST  {info} | [unreadable body: {e}]");
                return ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response();
            }
        };
        match body_text(&bytes) {
            Some(shown) => tracing::info!(target: "wire", "{}", crate::trace::fit_value(&format!("REQUEST  {info} | "), shown)),
            None => tracing::info!(target: "wire", "REQUEST  {info}"),
        }
        Request::from_parts(parts, axum::body::Body::from(bytes))
    };
    tracing::info!(target: "wire", "{}",
        crate::trace::fit_value(&format!("HEADERS  {info} | "), crate::trace::Shown::json(&serde_json::Value::Object(headers))));
    let rq = crate::trace::current_rq();
    let mut res = if req.uri().path().starts_with("/api/") && !engine.cfg.desktop_token.is_empty() && !token_ok(&engine, &req) {
        (StatusCode::FORBIDDEN, axum::Json(serde_json::json!({ "detail": "desktop token required" }))).into_response()
    } else {
        next.run(req).await
    };
    if let Ok(v) = HeaderValue::from_str(&engine.boot.id) {
        res.headers_mut().insert("x-orgtree-instance", v);
    }
    if let Some(v) = rq.and_then(|r| HeaderValue::from_str(&r).ok()) {
        res.headers_mut().insert("x-orgtree-request", v);
    }
    let status = res.status();
    let phrase = status.canonical_reason().unwrap_or("");
    let json = res
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.starts_with("application/json"))
        .unwrap_or(false);
    if quiet || !json || status == StatusCode::SWITCHING_PROTOCOLS {
        tracing::info!(target: "wire", "RESPONSE {info} {} {phrase} | [body omitted]", status.as_u16());
        return res;
    }
    let (parts, body) = res.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
    let lead = format!("RESPONSE {info} {} {phrase} | ", status.as_u16());
    match body_text(&bytes) {
        Some(shown) => tracing::info!(target: "wire", "{}", crate::trace::fit_value(&lead, shown)),
        None => tracing::info!(target: "wire", "{}", lead.trim_end_matches(" | ")),
    }
    Response::from_parts(parts, axum::body::Body::from(bytes))
}

fn token_ok(engine: &Engine, req: &Request) -> bool {
    req.headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| constant_eq(v.as_bytes(), engine.cfg.desktop_token.as_bytes()))
        .unwrap_or(false)
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
