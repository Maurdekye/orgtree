//! The org inbox panel: the log, the read mark, and the user's own outside
//! mail (attachments are staged first, then ride the same transport agents use).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::mail::{From, Outgoing};
use crate::domain::orginbox;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::util::uid;

pub const ATTACHMENT_MAX: usize = 25 * 1024 * 1024;

/// The newest 100 rows (oldest first), with the log's real size and unread count.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let rows = client
        .query("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id = $1 ORDER BY id DESC LIMIT 100", &[&o.id])
        .await?;
    let counts = client
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE dir = 'in' AND NOT read) FROM ot.org_inbox WHERE org_id = $1",
            &[&o.id],
        )
        .await?;
    let mut entries: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = orginbox::entry(&r.get::<_, Value>(0));
            if let Some(id) = v["id"].as_str().map(str::to_string) {
                v["ref"] = json!(format!("@mail:{}/org/{id}", o.slug));
            }
            v
        })
        .collect();
    entries.reverse();
    Ok(Json(json!({ "entries": entries, "total": counts.get::<_, i64>(0), "unread": counts.get::<_, i64>(1) })))
}

/// The user opened the panel: everything that came in is read.
#[logged]
pub async fn read(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let rows = client
        .query("UPDATE ot.org_inbox SET read = true WHERE org_id = $1 AND dir = 'in' AND NOT read RETURNING net_id, hub", &[&o.id])
        .await?;
    drop(client);
    if !rows.is_empty() {
        changes::notify(&e, &o, vec![Change::OrgInbox]);
        let read: Vec<(String, String)> = rows
            .iter()
            .filter_map(|r| Some((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))
            .collect();
        if !read.is_empty() {
            crate::net::note_read(&e, o.id, &read).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Debug)]
pub struct UploadQuery {
    #[serde(default)]
    name: String,
}

/// Stage an attachment for the user's next outside message.
#[logged]
pub async fn upload(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<UploadQuery>, body: Bytes) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    if body.len() > ATTACHMENT_MAX {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "attachment exceeds 25 MB"));
    }
    let base = std::path::Path::new(&q.name).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let clean: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ()+".contains(c) { c } else { '_' })
        .take(120)
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();
    let clean = if clean.is_empty() { "file.bin".to_string() } else { clean };
    let id = uid("u");
    let dir = e.cfg.path("uploads").join(&o.slug).join("@org-inbox");
    tokio::fs::create_dir_all(&dir).await.map_err(|err| ApiError::internal(err.to_string()))?;
    let path = dir.join(format!("{id}-{clean}"));
    tokio::fs::write(&path, &body).await.map_err(|err| ApiError::internal(err.to_string()))?;
    let p = path.to_string_lossy().to_string();
    let client = e.db.get().await?;
    client
        .execute(
            "INSERT INTO ot.uploads (id, org_id, agent_id, name, path, bytes) VALUES ($1, $2, NULL, $3, $4, $5)",
            &[&id, &o.id, &clean, &p, &(body.len() as i64)],
        )
        .await?;
    Ok(Json(json!({ "id": id, "name": clean, "bytes": body.len() })))
}

#[derive(Deserialize, Debug)]
pub struct SendBody {
    to: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    attachments: Vec<String>,
}

/// The user writes outside as the organization (no audience needed).
#[logged]
pub async fn send(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<SendBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let to = b.to.trim();
    if to.starts_with("@ext:") {
        return Err(ApiError::unprocessable("the @ext: address form is retired — reach chats through the mail hub (@net:<slug>)"));
    }
    if to.starts_with("@mcp:") {
        return Err(ApiError::unprocessable("the external-chat MCP server is retired"));
    }
    if !(to.starts_with("@org:") || to.starts_with("@net:")) {
        return Err(ApiError::unprocessable("recipient must be an outside address (@org:/@net:)"));
    }
    if b.body.trim().is_empty() && b.attachments.is_empty() {
        return Err(ApiError::bad_request("a message needs a body"));
    }
    let client = e.db.get().await?;
    let mut atts = Vec::new();
    for id in b.attachments.iter().take(10) {
        let r = client
            .query_opt("SELECT name, path, bytes FROM ot.uploads WHERE id = $1 AND org_id = $2", &[&id, &o.id])
            .await?;
        let Some(r) = r else {
            return Err(ApiError::unprocessable(format!("staged attachment {id} not found — re-upload and retry")));
        };
        let path: String = r.get(1);
        if !std::path::Path::new(&path).is_file() {
            return Err(ApiError::unprocessable(format!("staged attachment {id} not found — re-upload and retry")));
        }
        atts.push(json!({ "name": r.get::<_, String>(0), "path": path, "bytes": r.get::<_, i64>(2) }));
    }
    drop(client);
    let mut out = Outgoing::new(From::User, to, &b.body);
    out.attachments = atts;
    let sent = orginbox::send_extern(&e, o.id, &out).await?;
    Ok(Json(json!({ "id": sent.uid, "warnings": [], "delivery": sent.delivery })))
}

/// `GET /api/orgs/{slug}/net`: the org's network identity and hubs — the
/// one route that returns the secret (the settings panel's reveal/export).
#[logged]
pub async fn net(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::reveal(&e, o.id, &o.slug).await?))
}
