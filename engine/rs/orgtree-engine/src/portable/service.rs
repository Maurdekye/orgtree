//! Starting an export, an import or a duplicate as a job: the one way in for
//! the windows (`http::portable`) and for the agents' tools (`tools::portable`).
//!
//! Who may do what is decided before a job starts, by the caller: the routes
//! act for the user, the tools for an agent inside its own subtree
//! (USER 2026-11-23 10:43Z: "only into their own subtree yes").

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::credits::Shrink;
use super::format::Include;
use super::jobs::{self, Job};
use super::{export, import};
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::orgs::OrgHandle;

/// An export to start.
pub struct ExportAsk {
    pub root: i64,
    pub root_name: String,
    pub subtree: bool,
    pub include: Include,
    /// `None`: as the app's setting says.
    pub strip: Option<bool>,
    /// The user's own export from a window.
    pub manual: bool,
    /// `user`, or the exporting agent's name.
    pub by: String,
    /// Where an agent's export is written; a window's goes to the job's own file.
    pub dest: Option<PathBuf>,
}

#[nolog]
fn label(by: &str) -> String {
    if by == "user" { "@user".to_string() } else { by.to_string() }
}

/// The export as a result: what it holds, what was found in it, where it is.
#[nolog]
fn exported(outcome: &export::Outcome, path: Option<&PathBuf>) -> Value {
    let m = &outcome.manifest;
    let mut out = json!({
        "root": m.root, "subtree": m.subtree, "counts": m.counts, "unpacked_bytes": m.bytes.unpacked, "file_bytes": outcome.file_bytes,
        "include": m.include, "secrets": outcome.report, "not_included": outcome.not_included, "orgtree_version": m.orgtree_version,
    });
    if let Some(path) = path {
        out["path"] = json!(path.to_string_lossy());
    }
    out
}

/// Start an export. The job ends `confirm` when the user's own export found secrets and took
/// none out: its file waits for the user to have seen them (USER 2026-11-23 10:43Z).
#[nolog]
pub fn start_export(engine: &Arc<Engine>, org: &Arc<OrgHandle>, ask: ExportAsk) -> Result<Arc<Job>> {
    let strip = ask.strip.unwrap_or_else(|| engine.settings.export_strip_secrets());
    let name = format!("{}{}.orgtree.zip", ask.root_name, if ask.subtree { "-team" } else { "" });
    let job = jobs::start(engine, org.id, "export", &ask.by, &name, ask.dest.is_none())?;
    let dest = ask.dest.clone().or_else(|| job.file.clone()).expect("a job without a path of its own has a file");
    let request = export::Request { org: org.clone(), root: ask.root, subtree: ask.subtree, include: ask.include, strip, manual: ask.manual, by: ask.by.clone(),
                                    dest: dest.clone(), duplicate: false };
    let (engine, org, running) = (engine.clone(), org.clone(), job.clone());
    tokio::spawn(async move {
        let result = export::run(engine.clone(), request, running.export.clone()).await;
        let confirm = ask.manual && !strip && result.as_ref().is_ok_and(|outcome| outcome.manifest.secrets.detected > 0 || outcome.manifest.secrets.watchdog_credentials > 0);
        if let Ok(outcome) = &result {
            // an export is an event of the organization, whoever made it (question 3)
            let m = &outcome.manifest;
            let detail = json!({ "node": m.root, "subtree": m.subtree, "nodes": m.counts.agents + m.counts.projects + m.counts.retired, "bytes": outcome.file_bytes,
                                 "stripped": m.secrets.stripped, "secrets_detected": m.secrets.detected, "watchdog_credentials": m.secrets.watchdog_credentials,
                                 "path": ask.dest.as_ref().map(|p| p.to_string_lossy().to_string()) });
            if let Ok(client) = engine.db.get().await {
                let actor = label(&ask.by);
                let _ = client.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail, via) VALUES ($1, 'export', $2, $3, $4, $5)",
                                       &[&org.id, &actor, &ask.root, &detail, &crate::caller::via_of(&actor)]).await;
                crate::changes::notify(&engine, &org, vec![crate::changes::Change::Events]);
            }
        }
        running.end(result.map(|outcome| exported(&outcome, ask.dest.as_ref())), confirm);
    });
    Ok(job)
}

/// An import to start, of a file that is already where the engine can read it.
pub struct ImportAsk {
    pub actor: Actor,
    pub file: PathBuf,
    pub dest: Option<String>,
    pub index: Option<usize>,
    /// For the user, `None` is the app's default strategy; for an agent, none at all.
    pub strategy: Option<Shrink>,
    pub expect: Option<String>,
    pub resume_watchdogs: bool,
}

#[nolog]
fn request(engine: &Engine, org: &Arc<OrgHandle>, ask: ImportAsk, duplicate: bool) -> import::Request {
    let user = matches!(ask.actor, Actor::User);
    import::Request {
        org: org.clone(),
        // the user's own import clamps by the app's default strategy (20:30Z); an agent names one or is refused (S3)
        strategy: ask.strategy.or_else(|| user.then(|| engine.settings.import_shrink_strategy())),
        record: user,
        actor: ask.actor, file: ask.file, dest: ask.dest, index: ask.index, expect: ask.expect, resume_watchdogs: ask.resume_watchdogs, duplicate,
    }
}

/// What an import would do, for the user or for an agent. The user's plan also says which
/// strategy the app would use.
#[nolog]
pub async fn preview_import(engine: &Arc<Engine>, org: &Arc<OrgHandle>, ask: ImportAsk) -> Result<Value> {
    let req = request(engine, org, ask, false);
    let mut out = import::preview(engine, &req).await?;
    out["strategy"] = json!(req.strategy.map(Shrink::as_str));
    out["default_strategy"] = json!(engine.settings.import_shrink_strategy().as_str());
    Ok(out)
}

/// Start the import of `ask.file` on `job` (the job a window's upload made, or a new one).
#[nolog]
pub fn start_import(engine: &Arc<Engine>, org: &Arc<OrgHandle>, job: Option<Arc<Job>>, by: &str, ask: ImportAsk) -> Result<Arc<Job>> {
    let job = match job {
        Some(job) => job,
        None => jobs::start(engine, org.id, "import", by, "", false)?,
    };
    let req = request(engine, org, ask, false);
    let (engine, running) = (engine.clone(), job.clone());
    tokio::spawn(async move {
        let result = import::run(engine, req, running.import.clone()).await;
        running.end(result, false);
    });
    Ok(job)
}

/// A duplicate to make: the nodes are copied inside this engine, with no file of the user's.
pub struct DuplicateAsk {
    pub actor: Actor,
    pub root: i64,
    pub root_name: String,
    pub subtree: bool,
    pub dest: Option<String>,
    pub index: Option<usize>,
    pub strategy: Option<Shrink>,
    pub expect: Option<String>,
}

/// What a duplicate would do: the plan of an import of the same nodes, read from the database.
#[nolog]
pub async fn preview_duplicate(engine: &Arc<Engine>, org: &Arc<OrgHandle>, ask: DuplicateAsk) -> Result<Value> {
    let user = matches!(ask.actor, Actor::User);
    let strategy = ask.strategy.or_else(|| user.then(|| engine.settings.import_shrink_strategy()));
    let (nodes, audiences) = export::outline(engine.clone(), org.clone(), ask.root, ask.subtree).await?;
    let request = crate::domain::ops::import::Request { nodes: &nodes, audiences: &audiences, dest: ask.dest.clone(), index: ask.index, strategy, origin: Value::Null,
                                                        expect: None, duplicate: true, record: false };
    let plan = crate::domain::ops::import::preview(engine, org, &ask.actor, &request).await?;
    let mut out = plan.json();
    out["strategy"] = json!(strategy.map(Shrink::as_str));
    out["default_strategy"] = json!(engine.settings.import_shrink_strategy().as_str());
    Ok(out)
}

/// Start a duplicate: the nodes are written to the job's own file as an export that leaves
/// nothing out and strips nothing, and imported from it beside or under where they are.
#[nolog]
pub fn start_duplicate(engine: &Arc<Engine>, org: &Arc<OrgHandle>, by: &str, ask: DuplicateAsk) -> Result<Arc<Job>> {
    let job = jobs::start(engine, org.id, "duplicate", by, &ask.root_name, true)?;
    let file = job.file.clone().expect("a staged job has a file");
    let copy = export::Request { org: org.clone(), root: ask.root, subtree: ask.subtree, include: Include::default(), strip: false, manual: false, by: by.to_string(),
                                 dest: file.clone(), duplicate: true };
    let import = ImportAsk { actor: ask.actor, file: file.clone(), dest: ask.dest, index: ask.index, strategy: ask.strategy, expect: ask.expect, resume_watchdogs: false };
    let req = request(engine, org, import, true);
    let (engine, running) = (engine.clone(), job.clone());
    tokio::spawn(async move {
        running.import.step.store(Arc::new("copying".to_string()));
        let result = match export::run(engine.clone(), copy, running.export.clone()).await {
            Ok(_) => import::run(engine.clone(), req, running.import.clone()).await,
            Err(error) => Err(error),
        };
        // the copy was only ever the way from one to the other
        let _ = std::fs::remove_file(&file);
        running.end(result, false);
    });
    Ok(job)
}
