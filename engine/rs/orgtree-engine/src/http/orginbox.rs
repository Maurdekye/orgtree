//! The org inbox panel: the log, the read mark, and the user's own outside
//! mail (attachments are staged first, then ride the same transport agents use).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use futures::StreamExt;
use tokio::io::AsyncWriteExt;

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
    let changed = client
        .execute("UPDATE ot.org_inbox SET read = true WHERE org_id = $1 AND dir = 'in' AND NOT read", &[&o.id])
        .await?;
    drop(client);
    if changed > 0 {
        changes::notify(&e, &o, vec![Change::OrgInbox]);
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Debug)]
pub struct UploadQuery {
    #[serde(default)]
    name: String,
    #[serde(default)]
    to: String,
}

#[logged]
async fn target_limit(e: &Engine, org_id: i64, to: &str) -> anyhow::Result<crate::net::AttachmentLimit> {
    if to.starts_with("@net:") { crate::net::attachment_limit(e, org_id, to).await }
    else { Ok(crate::net::AttachmentLimit { bytes: ATTACHMENT_MAX as u64, legacy: false, per_message: false }) }
}

#[logged]
pub async fn upload_limit(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<UploadQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let limit = target_limit(&e, o.id, &q.to).await?;
    Ok(Json(json!({"max_attachment_bytes":limit.bytes,"legacy":limit.legacy,"per_message":limit.per_message,"too_large":limit.message()})))
}

/// Stage an attachment for the user's next outside message.
#[logged]
pub async fn upload(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<UploadQuery>, body: Body) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let limit = target_limit(&e, o.id, &q.to).await?;
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
    let written: ApiResult<u64> = async {
        let mut file = tokio::fs::File::create(&path).await.map_err(|err| ApiError::internal(err.to_string()))?;
        let mut chunks = body.into_data_stream();
        let mut size = 0;
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|err| ApiError::bad_request(err.to_string()))?;
            size += chunk.len() as u64;
            if size > limit.bytes { return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, limit.message())); }
            file.write_all(&chunk).await.map_err(|err| ApiError::internal(err.to_string()))?;
        }
        file.flush().await.map_err(|err| ApiError::internal(err.to_string()))?;
        Ok(size)
    }.await;
    let size = match written {
        Ok(size) => size,
        Err(err) => { let _ = tokio::fs::remove_file(&path).await; return Err(err); }
    };
    let p = path.to_string_lossy().to_string();
    let client = e.db.get().await?;
    client
        .execute(
            "INSERT INTO ot.uploads (id, org_id, agent_id, name, path, bytes) VALUES ($1, $2, NULL, $3, $4, $5)",
            &[&id, &o.id, &clean, &p, &(size as i64)],
        )
        .await?;
    Ok(Json(json!({ "id": id, "name": clean, "bytes": size })))
}

#[derive(Deserialize, Debug)]
pub struct SendBody {
    to: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    attachments: Vec<String>,
    /// the org-inbox row this answers (the panel's Reply)
    #[serde(default)]
    reply_to: Option<String>,
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
    if let Some(r) = b.reply_to.as_deref().filter(|r| !r.is_empty()) {
        out.reply_to = Some(orginbox::quote_of(&e, o.id, r).await?);
    }
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
