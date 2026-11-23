//! The windows' way to export, import and duplicate nodes
//! (docs/rust-engine/agent-export.md, "Routes"). Every one acts for the user.
//!
//! An export and an import are jobs (`portable::jobs`): a request starts one
//! and answers at once with its state; the window reads the state until the
//! job has ended. An export's file is handed out when the job is done, and
//! when the user has confirmed what it found, if it found secrets and took
//! none out. An import's file is sent up first, then planned, then applied.
//!
//! Nothing here logs a body: an export file and a plan hold the agents' own
//! text (`http::log_omitted` leaves `/file` and `/upload` out of the wire log).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use super::error::{ApiError, ApiResult};
use super::orgs::org;
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::portable::credits::Shrink;
use crate::portable::format::Include;
use crate::portable::jobs::{self, Job};
use crate::portable::service::{self, DuplicateAsk, ExportAsk, ImportAsk};

/// A node of the organization by its name: its id, its name as stored, the name of the node above it.
#[nolog]
async fn node(engine: &Engine, org: &OrgHandle, name: &str) -> ApiResult<(i64, String, Option<String>)> {
    let client = engine.db.get().await?;
    let row = client
        .query_opt("SELECT a.id, a.name, p.name FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.org_id = $1 AND a.name = $2 AND a.state <> 'deleted'",
                   &[&org.id, &name.trim_start_matches('@')])
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no node named {name} in this organization")))?;
    Ok((row.get(0), row.get(1), row.get(2)))
}

#[nolog]
fn job(org: &OrgHandle, id: &str, kinds: &[&str]) -> ApiResult<Arc<Job>> {
    jobs::get(org.id, id).filter(|job| kinds.contains(&job.kind)).ok_or_else(|| ApiError::not_found("That is no longer there: it ended more than a day ago, or the engine was restarted."))
}

#[nolog]
fn strategy(raw: &Option<String>) -> ApiResult<Option<Shrink>> {
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(name) => Shrink::parse(name).map(Some).ok_or_else(|| ApiError::bad_request(format!("strategy is {}", crate::portable::credits::SHRINKS))),
    }
}

#[derive(Deserialize)]
pub struct EstimateQuery {
    #[serde(default)]
    subtree: bool,
    #[serde(default)]
    retired: bool,
}

/// `GET /api/orgs/{slug}/nodes/{nid}/export-estimate?subtree=&retired=`: how much an export
/// would hold, before anything is written.
#[nolog]
pub async fn estimate(State(engine): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Query(q): Query<EstimateQuery>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let (id, _, _) = node(&engine, &org, &nid).await?;
    let mut out = crate::portable::export::estimate(engine.clone(), org, id, q.subtree, q.retired).await?;
    out["strip_secrets"] = json!(engine.settings.export_strip_secrets());
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ExportBody {
    #[serde(default)]
    subtree: bool,
    #[serde(default)]
    include: Include,
    /// Take detected secrets out, whatever the app's setting says.
    strip: Option<bool>,
}

/// `POST /api/orgs/{slug}/nodes/{nid}/export`: start an export of the node, alone or with
/// everything under it. Answers with the job.
#[nolog]
pub async fn export(State(engine): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Json(body): Json<ExportBody>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let (root, root_name, _) = node(&engine, &org, &nid).await?;
    let job = service::start_export(&engine, &org, ExportAsk { root, root_name, subtree: body.subtree, include: body.include, strip: body.strip, manual: true,
                                                               by: "user".to_string(), dest: None })?;
    Ok(Json(job.status()))
}

/// `GET /api/orgs/{slug}/exports/{id}`.
#[nolog]
pub async fn export_status(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    Ok(Json(job(&org, &id, &["export"])?.status()))
}

/// `POST /api/orgs/{slug}/exports/{id}/confirm`: the user has seen what the export found and
/// keeps the file as it is.
#[nolog]
pub async fn export_confirm(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let job = job(&org, &id, &["export"])?;
    job.confirm();
    Ok(Json(job.status()))
}

/// `GET /api/orgs/{slug}/exports/{id}/file`: the export, once it is done and confirmed.
#[nolog]
pub async fn export_file(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Response> {
    let org = org(&engine, &slug)?;
    let job = job(&org, &id, &["export"])?;
    if !job.ready() {
        return Err(ApiError::conflict("The export is not ready to be saved yet."));
    }
    let path = job.file.clone().ok_or_else(|| ApiError::not_found("That export has no file here."))?;
    let file = tokio::fs::File::open(&path).await.map_err(|_| ApiError::not_found("That export's file is gone."))?;
    let length = file.metadata().await.map_err(|error| ApiError::internal(error.to_string()))?.len();
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (header::CONTENT_LENGTH, length.to_string()),
            (header::CONTENT_DISPOSITION, super::scratch_files::disposition(&job.name)),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024)),
    )
        .into_response())
}

/// `DELETE /api/orgs/{slug}/exports/{id}` and `…/imports/{id}`: stop it if it runs, forget it,
/// and take its file away. What an import has already created stays.
#[nolog]
pub async fn forget(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let job = job(&org, &id, &["export", "import", "duplicate"])?;
    if job.kind != "export" && job.running() && job.import.total.load(std::sync::atomic::Ordering::Relaxed) > 0 {
        return Err(ApiError::conflict("The import is under way and cannot be stopped; it ends by itself."));
    }
    jobs::remove(&engine, &job);
    Ok(Json(json!({ "removed": true })))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    #[serde(default)]
    name: String,
}

/// `PUT /api/orgs/{slug}/imports/upload?name=`: the body is an export file. It is kept in the
/// engine's own folder for the plan and the import that follow. Answers with the job's id.
#[nolog]
pub async fn upload(State(engine): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<UploadQuery>, headers: HeaderMap, body: Body) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let announced = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if announced.is_some_and(|length| length > crate::portable::SIZE_MAX) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "An export holds at most 256 GiB."));
    }
    let name: String = q.name.chars().filter(|c| !c.is_control()).take(200).collect();
    let job = jobs::start(&engine, org.id, "import", "user", &name, true).map_err(|error| ApiError::internal(error.to_string()))?;
    let path = job.file.clone().expect("a staged job has a file");
    let written = async {
        let mut file = tokio::fs::File::create(&path).await.map_err(|error| ApiError::internal(error.to_string()))?;
        let mut total = 0u64;
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ApiError::bad_request("The file did not arrive whole."))?;
            total += chunk.len() as u64;
            if total > crate::portable::SIZE_MAX {
                return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "An export holds at most 256 GiB."));
            }
            file.write_all(&chunk).await.map_err(super::scratch_files::write_failed)?;
        }
        if announced.is_some_and(|length| length != total) {
            return Err(ApiError::bad_request("The file did not arrive whole."));
        }
        file.flush().await.map_err(super::scratch_files::write_failed)?;
        Ok(total)
    }
    .await;
    match written {
        Ok(total) => Ok(Json(json!({ "id": job.id, "bytes": total }))),
        Err(error) => {
            jobs::remove(&engine, &job);
            Err(error)
        }
    }
}

#[derive(Deserialize)]
pub struct ImportBody {
    /// The node it goes under; none is the top level.
    dest: Option<String>,
    index: Option<usize>,
    strategy: Option<String>,
    expect: Option<String>,
    #[serde(default)]
    resume_watchdogs: bool,
}

#[nolog]
fn import_ask(job: &Job, body: &ImportBody) -> ApiResult<ImportAsk> {
    let file = job.file.clone().ok_or_else(|| ApiError::not_found("That import has no file here."))?;
    Ok(ImportAsk { actor: Actor::User, file, dest: body.dest.clone().filter(|d| !d.trim().is_empty()), index: body.index, strategy: strategy(&body.strategy)?,
                   expect: body.expect.clone(), resume_watchdogs: body.resume_watchdogs })
}

/// `POST /api/orgs/{slug}/imports/{id}/plan`: what importing the uploaded file under `dest`
/// would do. Nothing is created.
#[nolog]
pub async fn import_plan(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>, Json(body): Json<ImportBody>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let job = job(&org, &id, &["import"])?;
    Ok(Json(service::preview_import(&engine, &org, import_ask(&job, &body)?).await?))
}

/// `POST /api/orgs/{slug}/imports/{id}/apply`: import it. Answers with the job.
#[nolog]
pub async fn import_apply(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>, Json(body): Json<ImportBody>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let job = job(&org, &id, &["import"])?;
    if job.import.total.load(std::sync::atomic::Ordering::Relaxed) > 0 || !job.running() {
        return Err(ApiError::conflict("That file was already imported; choose it again to import it once more."));
    }
    let ask = import_ask(&job, &body)?;
    let job = service::start_import(&engine, &org, Some(job), "user", ask)?;
    Ok(Json(job.status()))
}

/// `GET /api/orgs/{slug}/imports/{id}`.
#[nolog]
pub async fn import_status(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    Ok(Json(job(&org, &id, &["import", "duplicate"])?.status()))
}

#[derive(Deserialize)]
pub struct DuplicateBody {
    #[serde(default)]
    subtree: bool,
    /// The node the copy goes under; left out, it goes beside the original.
    dest: Option<String>,
    index: Option<usize>,
    strategy: Option<String>,
    expect: Option<String>,
    /// Only say what it would do.
    #[serde(default)]
    preview: bool,
}

/// `POST /api/orgs/{slug}/nodes/{nid}/duplicate`: copy the node, alone or with everything
/// under it, inside this organization. With `preview`, the plan; else the job, which is read
/// as an import is (`…/imports/{id}`).
#[nolog]
pub async fn duplicate(State(engine): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Json(body): Json<DuplicateBody>) -> ApiResult<Json<Value>> {
    let org = org(&engine, &slug)?;
    let (root, root_name, above) = node(&engine, &org, &nid).await?;
    let dest = body.dest.clone().filter(|d| !d.trim().is_empty()).or(above);
    let ask = DuplicateAsk { actor: Actor::User, root, root_name, subtree: body.subtree, dest, index: body.index, strategy: strategy(&body.strategy)?, expect: body.expect.clone() };
    if body.preview {
        return Ok(Json(service::preview_duplicate(&engine, &org, ask).await?));
    }
    Ok(Json(service::start_duplicate(&engine, &org, "user", ask)?.status()))
}
