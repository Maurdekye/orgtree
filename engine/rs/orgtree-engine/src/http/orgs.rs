//! Organization-level reads: the org list, the tree, and the record feed's
//! HTTP recovery routes.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::orgs::OrgHandle;
use crate::util::iso_opt;

pub fn org(engine: &Engine, slug: &str) -> Result<Arc<OrgHandle>, ApiError> {
    engine.orgs.get(slug).ok_or_else(|| ApiError::not_found(format!("no organization named {slug}")))
}

pub async fn list(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    let client = e.db.get().await?;
    let rows = client
        .query(
            "SELECT o.id, o.slug, o.name, o.created_at,
                    (SELECT count(*) FROM ot.agents a WHERE a.org_id = o.id AND a.state <> 'deleted'),
                    (SELECT count(*) FROM ot.agents a WHERE a.org_id = o.id AND a.state = 'live'),
                    (SELECT coalesce(sum(cost_usd),0)::float8 FROM ot.agents a WHERE a.org_id = o.id)
               FROM ot.orgs o WHERE o.state = 'active' ORDER BY o.slug",
            &[],
        )
        .await?;
    let working = crate::runtime::working_by_org(&e);
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                let id: i64 = r.get(0);
                json!({
                    "slug": r.get::<_, String>(1), "name": r.get::<_, String>(2),
                    "created": iso_opt(r.get(3)), "nodes": r.get::<_, i64>(4), "live": r.get::<_, i64>(5),
                    "cost_usd_total": r.get::<_, f64>(6),
                    "working": working.get(&id).copied().unwrap_or(0),
                    "state": "active", "state_reason": null, "unavailable_step": null,
                })
            })
            .collect(),
    )))
}

pub async fn tree(State(e): State<Arc<Engine>>, Path(slug): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let org = org(&e, &slug)?;
    let snap = org.feed.snapshot().await.ok_or_else(|| ApiError::unavailable("organization feed unavailable"))?;
    let rt_seq = snap.pointer("/runtime/seq").and_then(Value::as_u64).unwrap_or(0);
    let rev = snap.pointer("/cursor/rev").and_then(Value::as_u64).unwrap_or(0);
    let etag = format!("\"{}-{}-{}\"", e.boot.id, rev, rt_seq);
    if headers.get("if-none-match").and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        let mut r = StatusCode::NOT_MODIFIED.into_response();
        r.headers_mut().insert("etag", HeaderValue::from_str(&etag).unwrap());
        return Ok(r);
    }
    let body = crate::http::tree::project(&snap);
    let mut r = Json(body).into_response();
    r.headers_mut().insert("etag", HeaderValue::from_str(&etag).unwrap());
    r.headers_mut().insert("x-orgtree-sync-rev", HeaderValue::from(rev));
    r.headers_mut().insert("x-orgtree-org-rev", HeaderValue::from(rev));
    Ok(r)
}

pub async fn records(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    Ok(Json(org.feed.snapshot().await.ok_or_else(|| ApiError::unavailable("organization feed unavailable"))?))
}

pub async fn changes(
    State(e): State<Arc<Engine>>,
    Path(slug): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let after: u64 = q.get("after").and_then(|s| s.parse().ok()).unwrap_or(0);
    let uuid = q.get("org_uuid").cloned().unwrap_or_default();
    let inc = q.get("incarnation").cloned().unwrap_or_default();
    Ok(Json(
        org.feed.changes(after, uuid, inc).await.ok_or_else(|| ApiError::unavailable("organization feed unavailable"))?,
    ))
}

pub async fn selection(
    State(e): State<Arc<Engine>>,
    Path(slug): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let org = org(&e, &slug)?;
    let req: Value = q
        .get("args")
        .and_then(|a| serde_json::from_str(a).ok())
        .ok_or_else(|| ApiError::bad_request("selection args missing"))?;
    Ok(Json(org.feed.select(req).await.ok_or_else(|| ApiError::unavailable("organization feed unavailable"))?))
}

pub async fn compatibility() -> ApiError {
    ApiError::compatibility()
}

pub async fn app_records(State(e): State<Arc<Engine>>) -> ApiResult<Json<Value>> {
    Ok(Json(e.app.snapshot().await.ok_or_else(|| ApiError::unavailable("app feed unavailable"))?))
}

/// A pending updater maintenance request, if any (see `/api/desktop/maintenance/*`).
pub fn maintenance_request(_e: &Engine) -> Option<Value> {
    None
}

#[cfg(windows)]
pub fn private_bytes() -> Value {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut _, c.cb) != 0 {
            return json!(c.PrivateUsage);
        }
    }
    Value::Null
}

#[cfg(not(windows))]
pub fn private_bytes() -> Value {
    Value::Null
}
