//! The Changelog panel's reads (docket
//! changelog-window-one-row-per-version-pinnable-po; data in `crate::changelog`).
//! The list is one small row per release, newest first; a version's notes are
//! read when its row is opened, so no read carries every release's notes.

use axum::extract::Path;
use axum::Json;
use serde_json::{json, Value};

use super::error::{ApiError, ApiResult};
use crate::changelog::{self, TimeSource};

/// `GET /api/changelog`: `{running, time_source, releases: [{version,
/// released_at, notes}]}`, newest first: the published releases, and a release
/// build itself until its list has it. `running` is this build's version, which
/// a local alpha's rows do not include.
#[logged]
pub async fn list() -> Json<Value> {
    Json(json!({
        "running": env!("CARGO_PKG_VERSION"),
        "time_source": match changelog::TIME_SOURCE {
            TimeSource::Published => "published",
            TimeSource::Tagged => "tagged",
        },
        "releases": changelog::releases().iter().map(changelog::row_json).collect::<Vec<_>>(),
    }))
}

/// `GET /api/changelog/{version}`: one row with its notes (Markdown, or null
/// when it has none). A version with no row is a 404.
#[logged]
pub async fn one(Path(version): Path<String>) -> ApiResult<Json<Value>> {
    let row = changelog::releases()
        .iter()
        .find(|r| r.version == version)
        .ok_or_else(|| ApiError::not_found(format!("no Changelog row for version {version}")))?;
    let mut body = changelog::row_json(row);
    body["notes"] = json!(row.has_notes.then(|| changelog::notes(&row.version)).flatten());
    Ok(Json(body))
}
