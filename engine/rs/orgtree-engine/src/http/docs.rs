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
use crate::util::{iso, iso_opt};

#[logged]
pub async fn get(State(e): State<Arc<Engine>>, Path((slug, did)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let r = client
        .query_opt(
            "SELECT uid, node_name, title, coalesce(body, ''), at, format, bytes, viewed_at FROM ot.documents WHERE org_id = $1 AND uid = $2",
            &[&o.id, &did],
        )
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    Ok(Json(json!({
        "id": r.get::<_, String>(0), "node": r.get::<_, String>(1), "title": r.get::<_, String>(2),
        "body": r.get::<_, String>(3), "at": iso(r.get(4)), "format": r.get::<_, String>(5), "bytes": r.get::<_, i32>(6),
        "viewed_at": iso_opt(r.get(7)),
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
pub struct ViewedMark {
    id: String,
    at: String,
}

#[derive(Deserialize, Debug)]
pub struct ViewedBody {
    marks: Vec<ViewedMark>,
}

/// The user opened these documents; each mark is the `at` the card had then.
/// Only ever moves a mark forward, so a stale window or the one-time push of
/// an old localStorage record cannot un-read a card.
#[logged]
pub async fn viewed(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(body): Json<ViewedBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    if body.marks.len() > 5000 {
        return Err(ApiError::bad_request("at most 5000 marks at a time"));
    }
    let mut agents: Vec<i64> = Vec::new();
    let client = e.db.get().await?;
    for m in &body.marks {
        let Some(at) = crate::util::parse_ts(&m.at) else { continue };
        let rows = client
            .query(
                "UPDATE ot.documents SET viewed_at = $3 WHERE org_id = $1 AND uid = $2 AND (viewed_at IS NULL OR viewed_at < $3)
                 RETURNING agent_id",
                &[&o.id, &m.id, &at],
            )
            .await?;
        for r in rows {
            if let Some(a) = r.get::<_, Option<i64>>(0) {
                if !agents.contains(&a) {
                    agents.push(a);
                }
            }
        }
    }
    drop(client);
    if !agents.is_empty() {
        changes::notify(&e, &o, agents.into_iter().map(Change::Documents).collect());
    }
    Ok(Json(json!({ "ok": true })))
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
    /// the TEAM gallery (user 2026-10-17 22:47Z): the node and everyone under it
    #[serde(default)]
    team: Option<String>,
}

/// The gallery: every card, newest first, metadata only.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let node = q.node.trim().to_string();
    let team = matches!(q.team.as_deref(), Some("1" | "true"));
    let members = subtree_members(&client, &o, &node, team).await?;
    let limit = if q.limit > 0 { q.limit.min(1000) } else { 60 };
    let mut offset = q.offset.max(0);
    let mut located = None;
    if !q.locate.is_empty() {
        // grow the window until it holds the located card
        let pos: Option<i64> = client
            .query_one(
                "SELECT (SELECT count(*) FROM ot.documents d2 WHERE d2.org_id = $1 AND d2.id > d.id
                          AND CASE WHEN $4::bigint[] IS NULL THEN ($3 = '' OR d2.node_name = $3) ELSE d2.agent_id = ANY($4) END)
                   FROM ot.documents d WHERE d.org_id = $1 AND d.uid = $2",
                &[&o.id, &q.locate, &node, &members],
            )
            .await
            .ok()
            .map(|r| r.get(0));
        if let Some(p) = pos {
            located = Some(q.locate.clone());
            offset = 0;
            if p >= limit {
                return list_page(&client, &o, &node, members.as_deref(), 0, p + 1, located).await;
            }
        }
    }
    list_page(&client, &o, &node, members.as_deref(), offset, limit, located).await
}

/// The nodes whose documents a gallery lists, or `None` for the plain
/// `node_name` filter. A PROJECT's gallery always holds the documents presented
/// under it and those of every node below it (user 2026-10-17 20:07:52Z, docket
/// point 8); `team` asks the same of any node: an agent and everyone under it,
/// passing through projects (point 25, user 22:47Z), as the team docket does.
/// Nested projects included, whatever their state. One recursive read per
/// request; the page query itself stays bounded by LIMIT.
#[logged]
async fn subtree_members(client: &tokio_postgres::Client, o: &crate::orgs::OrgHandle, node: &str, team: bool) -> ApiResult<Option<Vec<i64>>> {
    if node.is_empty() {
        return Ok(None);
    }
    let root: Option<i64> = client
        .query_opt(
            "SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted' AND ($3 OR kind = 'project')
              ORDER BY (state = 'live') DESC, id DESC LIMIT 1",
            &[&o.id, &node, &team],
        )
        .await?
        .map(|r| r.get(0));
    let Some(root) = root else { return Ok(None) };
    let rows = client
        .query(
            "WITH RECURSIVE below(id, depth) AS (
               SELECT $1::bigint, 0
               UNION ALL SELECT a.id, b.depth + 1 FROM ot.agents a JOIN below b ON a.parent_id = b.id
                WHERE b.depth < 1024)
             SELECT id FROM below",
            &[&root],
        )
        .await?;
    Ok(Some(rows.iter().map(|r| r.get(0)).collect()))
}

async fn list_page(
    client: &tokio_postgres::Client,
    o: &crate::orgs::OrgHandle,
    node: &str,
    members: Option<&[i64]>,
    offset: i64,
    limit: i64,
    located: Option<String>,
) -> ApiResult<Json<Value>> {
    let members: Option<Vec<i64>> = members.map(<[i64]>::to_vec);
    let rows = client
        .query(
            "SELECT d.uid, d.node_name, d.title, d.at, d.format, d.bytes, coalesce(a.state, 'deleted'), a.tier, d.viewed_at,
                    coalesce(d.presented_by, d.node_name),
                    (SELECT p.tier FROM ot.agents p WHERE p.org_id = d.org_id AND p.name = coalesce(d.presented_by, d.node_name)
                      AND p.state <> 'deleted' ORDER BY (p.state = 'live') DESC, p.id DESC LIMIT 1)
               FROM ot.documents d LEFT JOIN ot.agents a ON a.id = d.agent_id
              WHERE d.org_id = $1
                AND CASE WHEN $5::bigint[] IS NULL THEN ($2 = '' OR d.node_name = $2) ELSE d.agent_id = ANY($5) END
              ORDER BY d.id DESC OFFSET $3 LIMIT $4",
            &[&o.id, &node, &offset, &limit, &members],
        )
        .await?;
    let total: i64 = client
        .query_one(
            "SELECT count(*) FROM ot.documents
              WHERE org_id = $1 AND CASE WHEN $3::bigint[] IS NULL THEN ($2 = '' OR node_name = $2) ELSE agent_id = ANY($3) END",
            &[&o.id, &node, &members],
        )
        .await?
        .get(0);
    let docs: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "id": r.get::<_, String>(0), "node": r.get::<_, String>(1), "title": r.get::<_, String>(2),
                    "at": iso(r.get(3)), "format": r.get::<_, String>(4), "bytes": r.get::<_, i32>(5), "evicted": false,
                    "node_state": r.get::<_, String>(6), "tier": r.get::<_, Option<String>>(7),
                    "viewed_at": iso_opt(r.get(8)),
                    // the agent that presented it, also for a document presented
                    // under a project (whose `node` is the project)
                    "presented_by": r.get::<_, String>(9), "presenter_tier": r.get::<_, Option<String>>(10) })
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
        .query_opt("SELECT coalesce(preview, body, ''), format FROM ot.documents WHERE org_id = $1 AND uid = $2", &[&o.id, &did])
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    let body: String = r.get(0);
    let format: String = r.get(1);
    if format != "html" {
        return Err(ApiError::bad_request("that document is not an HTML mockup"));
    }
    let csp = "sandbox allow-scripts; default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; \
               style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
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
        .query_opt("SELECT title, coalesce(body, ''), format, download FROM ot.documents WHERE org_id = $1 AND uid = $2", &[&o.id, &did])
        .await?
        .ok_or_else(|| ApiError::not_found("that document no longer exists"))?;
    let title: String = r.get(0);
    let format: String = r.get(2);
    let bundle: Option<Vec<u8>> = r.get(3);
    let ext = if bundle.is_some() { "zip" } else if format == "html" { "html" } else { "md" };
    let body = bundle.unwrap_or_else(|| r.get::<_,String>(1).into_bytes());
    let safe: String = title.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' }).collect();
    Ok((
        [
            (header::CONTENT_TYPE, if ext == "zip" { "application/zip" } else if ext == "html" { "text/html; charset=utf-8" } else { "text/markdown; charset=utf-8" }.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.{ext}\"", safe.trim())),
        ],
        body,
    )
        .into_response())
}
