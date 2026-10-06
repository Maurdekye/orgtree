//! Presented documents: the reader, the gallery, dismissing, downloading
//! and the sandboxed HTML mockup preview.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::util::iso;

#[logged]
pub async fn get(State(e): State<Arc<Engine>>, Path((slug, did)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let r = client
        .query_opt(
            "SELECT uid, node_name, title, coalesce(body, ''), at, format, bytes FROM ot.documents WHERE org_id = $1 AND uid = $2",
            &[&o.id, &did],
        )
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    Ok(Json(json!({
        "id": r.get::<_, String>(0), "node": r.get::<_, String>(1), "title": r.get::<_, String>(2),
        "body": r.get::<_, String>(3), "at": iso(r.get(4)), "format": r.get::<_, String>(5), "bytes": r.get::<_, i32>(6),
    })))
}

#[logged]
pub async fn dismiss(State(e): State<Arc<Engine>>, Path((slug, did)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let r = client
        .query_opt(
            "UPDATE ot.documents SET dismissed = true WHERE org_id = $1 AND uid = $2 RETURNING node_name, agent_id",
            &[&o.id, &did],
        )
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    drop(client);
    let node: String = r.get(0);
    if let Some(a) = r.get::<_, Option<i64>>(1) {
        changes::notify(&e, &o, vec![Change::Documents(a)]);
    }
    Ok(Json(json!({ "ok": true, "node": node })))
}

#[derive(Deserialize, Debug)]
pub struct ListQuery {
    #[serde(default)]
    offset: i64,
    #[serde(default)]
    node: String,
    #[serde(default)]
    limit: i64,
    #[serde(default)]
    locate: String,
}

/// The gallery: every card, newest first, metadata only.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let node = q.node.trim().to_string();
    let limit = if q.limit > 0 { q.limit.min(1000) } else { 60 };
    let mut offset = q.offset.max(0);
    let mut located = None;
    if !q.locate.is_empty() {
        // grow the window until it holds the located card
        let pos: Option<i64> = client
            .query_one(
                "SELECT (SELECT count(*) FROM ot.documents d2 WHERE d2.org_id = $1 AND d2.id > d.id AND ($3 = '' OR d2.node_name = $3))
                   FROM ot.documents d WHERE d.org_id = $1 AND d.uid = $2",
                &[&o.id, &q.locate, &node],
            )
            .await
            .ok()
            .map(|r| r.get(0));
        if let Some(p) = pos {
            located = Some(q.locate.clone());
            offset = 0;
            if p >= limit {
                return list_page(&client, &o, &node, 0, p + 1, located).await;
            }
        }
    }
    list_page(&client, &o, &node, offset, limit, located).await
}

async fn list_page(
    client: &tokio_postgres::Client,
    o: &crate::orgs::OrgHandle,
    node: &str,
    offset: i64,
    limit: i64,
    located: Option<String>,
) -> ApiResult<Json<Value>> {
    let rows = client
        .query(
            "SELECT d.uid, d.node_name, d.title, d.at, d.format, d.bytes, coalesce(a.state, 'deleted'), a.tier
               FROM ot.documents d LEFT JOIN ot.agents a ON a.id = d.agent_id
              WHERE d.org_id = $1 AND ($2 = '' OR d.node_name = $2)
              ORDER BY d.id DESC OFFSET $3 LIMIT $4",
            &[&o.id, &node, &offset, &limit],
        )
        .await?;
    let total: i64 = client
        .query_one("SELECT count(*) FROM ot.documents WHERE org_id = $1 AND ($2 = '' OR node_name = $2)", &[&o.id, &node])
        .await?
        .get(0);
    let docs: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "id": r.get::<_, String>(0), "node": r.get::<_, String>(1), "title": r.get::<_, String>(2),
                    "at": iso(r.get(3)), "format": r.get::<_, String>(4), "bytes": r.get::<_, i32>(5), "evicted": false,
                    "node_state": r.get::<_, String>(6), "tier": r.get::<_, Option<String>>(7) })
        })
        .collect();
    let next = if offset + (docs.len() as i64) < total { Some(offset + docs.len() as i64) } else { None };
    let mut out = json!({ "documents": docs, "total": total, "next_offset": next, "offset": offset });
    if let Some(l) = located {
        out["located"] = json!(l);
    }
    Ok(Json(out))
}

/// An HTML mockup, isolated: no network, no access to the app.
#[logged]
pub async fn mockup(State(e): State<Arc<Engine>>, Path((slug, did)): Path<(String, String)>) -> ApiResult<Response> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let r = client
        .query_opt("SELECT coalesce(body, ''), format FROM ot.documents WHERE org_id = $1 AND uid = $2", &[&o.id, &did])
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    let body: String = r.get(0);
    let format: String = r.get(1);
    if format != "html" {
        return Err(ApiError::bad_request("that document is not an HTML mockup"));
    }
    let csp = "sandbox allow-scripts; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; \
               style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
    Ok((
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
            (header::CONTENT_SECURITY_POLICY, csp.to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (header::REFERRER_POLICY, "no-referrer".to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response())
}

#[logged]
pub async fn download(State(e): State<Arc<Engine>>, Path((slug, did)): Path<(String, String)>) -> ApiResult<Response> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let r = client
        .query_opt("SELECT title, coalesce(body, ''), format FROM ot.documents WHERE org_id = $1 AND uid = $2", &[&o.id, &did])
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    let title: String = r.get(0);
    let format: String = r.get(2);
    let ext = if format == "html" { "html" } else { "md" };
    let safe: String = title.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' }).collect();
    Ok((
        [
            (header::CONTENT_TYPE, if ext == "html" { "text/html; charset=utf-8" } else { "text/markdown; charset=utf-8" }.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.{ext}\"", safe.trim())),
        ],
        r.get::<_, String>(1),
    )
        .into_response())
}
