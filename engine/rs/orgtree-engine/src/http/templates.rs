//! Organization templates: the picker's list and preview, the templates
//! folder (generate the defaults, open it) and "Save as template".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::templates::{self, Choices, Include};
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;

#[logged]
pub async fn list() -> ApiResult<Json<Value>> {
    // read afresh on every call: a file dropped into the folder shows at once
    let (list, problem) = tokio::task::spawn_blocking(templates::listing).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let all: Vec<Value> = list.iter().map(|(t, src, path)| templates::summary(t, src, path)).collect();
    Ok(Json(json!({ "templates": all, "dir": templates::folder().to_string_lossy(), "folder_error": problem })))
}

#[logged]
pub async fn populate() -> ApiResult<Json<Value>> {
    templates::populate().map(Json).map_err(ApiError::internal)
}

#[logged]
pub async fn open() -> ApiResult<Json<Value>> {
    let dir = templates::folder();
    let _ = std::fs::create_dir_all(&dir);
    let opener = if cfg!(windows) { "explorer.exe" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let ok = std::process::Command::new(opener).arg(&dir).spawn().is_ok();
    Ok(Json(json!({ "ok": ok, "path": dir.to_string_lossy() })))
}

/// The picker's choice, as the preview and the create both read it.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct Pick {
    pub id: String,
    #[serde(flatten)]
    pub choices: Choices,
    /// send the top-level agents their first message (off unless asked)
    #[serde(default)]
    pub kickoff: bool,
    /// the tiers the preview showed, slot → tier: a create whose plan has
    /// moved since (a sign-in changed) is refused rather than hire otherwise
    #[serde(default)]
    pub expect: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Deserialize, Debug)]
pub struct ResolveBody {
    #[serde(flatten)]
    pick: Pick,
    /// the org name typed so far (accounts kept for one org follow it)
    #[serde(default)]
    name: String,
    #[serde(default)]
    dirs: Vec<String>,
}

/// The org's folders as the create stores them.
#[logged]
pub fn org_dirs(dirs: &[String]) -> Vec<Value> {
    dirs.iter().map(|d| d.trim()).filter(|d| !d.is_empty()).map(|d| json!({ "path": d, "mode": "rw" })).collect()
}

/// Plan a pick for an org of this slug: the template, its plan and the
/// slots nothing can run.
#[logged]
pub fn plan_pick(e: &Engine, pick: &Pick, slug: &str, dirs: &[Value])
    -> ApiResult<(templates::Template, Vec<templates::Planned>, Vec<String>)> {
    let t = templates::find(&pick.id).map_err(ApiError::unprocessable)?;
    let av = templates::avail(e, slug);
    let (planned, blocked) = templates::plan(&t, &pick.choices, &av, dirs).map_err(ApiError::unprocessable)?;
    Ok((t, planned, blocked))
}

#[logged]
pub async fn resolve(State(e): State<Arc<Engine>>, Json(b): Json<ResolveBody>) -> ApiResult<Json<Value>> {
    let slug = crate::util::slugify(&b.name, 200);
    let (t, planned, blocked) = plan_pick(&e, &b.pick, &slug, &org_dirs(&b.dirs))?;
    let mut out = templates::plan_json(&t, &planned, &blocked);
    let av = templates::avail(&e, &slug);
    out["offered"] = json!(av.tiers.iter()
        .map(|(k, o)| json!({ "tier": k, "seat": o.seat, "provider": o.provider })).collect::<Vec<_>>());
    // the first sign-in check has not landed: the picker asks again shortly
    out["loading"] = json!(av.checking);
    Ok(Json(out))
}

#[derive(Deserialize, Debug)]
pub struct SaveBody {
    name: String,
    /// optional: left out of the file when blank
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    include: Include,
    #[serde(default)]
    replace: bool,
    /// what Quick chat shows for this org now (the renderer keeps its memory)
    #[serde(default)]
    quick_chat: Option<Value>,
}

/// `POST /api/orgs/{slug}/template`: save the org's live layout as a template
/// file in the templates folder. Reads the org; changes nothing in it.
#[logged]
pub async fn save(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<SaveBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let name = b.name.trim().to_string();
    let id = crate::util::slugify(&name, 80);
    if id.is_empty() {
        return Err(ApiError::bad_request("a template needs a name with letters or digits"));
    }
    let client = e.db.get().await?;
    let rows = client
        .query(
            "SELECT id, parent_id, name, tier, account, seat::float8, grant_credits::float8, charter, team_charter, scope
               FROM ot.agents WHERE org_id = $1 AND state = 'live' ORDER BY sibling_order, id LIMIT 200",
            &[&o.id],
        )
        .await?;
    drop(client);
    if rows.is_empty() {
        return Err(ApiError::unprocessable("this organization has no live agents to save"));
    }
    let rows: Vec<templates::Row> = rows.iter().map(|r| templates::Row {
        id: r.get(0), parent: r.get(1), name: r.get(2), tier: r.get(3), account: r.get(4), seat: r.get(5), grant: r.get(6),
        charter: r.get(7), team_charter: r.get(8), scope: r.get(9),
    }).collect();
    let org_md = std::fs::read(e.cfg.workspace_dir(&o.slug).join("org.md")).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let t = templates::from_rows(&id, &name, b.description.as_deref(), &rows, org_md, b.quick_chat.as_ref(), &b.include);
    let parsed: templates::Template = serde_json::from_value(t.clone()).map_err(|x| ApiError::internal(x.to_string()))?;
    let problems = templates::validate(&parsed);
    let body = serde_json::to_string_pretty(&t).map_err(|x| ApiError::internal(x.to_string()))?;
    let path = templates::write(&id, &body, b.replace).map_err(|(code, msg)| {
        ApiError::new(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), msg)
    })?;
    Ok(Json(json!({ "id": id, "file": format!("{id}.json"), "path": path.to_string_lossy(), "content": body,
                    "agents": rows.len(), "problems": problems })))
}
