//! The agents' tools for exporting, importing and duplicating nodes
//! (docs/rust-engine/agent-export.md, "Tools").
//!
//! USER 2026-11-23 10:32Z mb05f4fda0d92: "an agent tool for creating and
//! applying these exports autonomously on their own subtrees (allowing them
//! to send full agents over to other orgs or the mailhub), and include a
//! dedicated agent duplication tool on top of that. imports by agents are
//! always restricted by credits". An agent exports itself or a node below
//! it, and imports or duplicates under itself or a node below it
//! (10:43Z: "only into their own subtree yes"). Its export follows the app's
//! strip setting and says what it detected (20:30Z, question 3), and never
//! carries sealed watchdog credentials (question 2). No strategy named, and
//! grants that do not fit: refused (20:44Z, S3).
//!
//! Each tool starts a job and waits a short while for it. A job that takes
//! longer answers with its id, and the same tool called with `job` reads it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, is_descendant, me, need_str, target, Done, Me, Target};
use crate::domain::ops::Actor;
use crate::engine::Engine;
use crate::portable::credits::{Shrink, SHRINKS};
use crate::portable::format::Include;
use crate::portable::jobs::{self, Job};
use crate::portable::service::{self, DuplicateAsk, ExportAsk, ImportAsk};
use crate::runtime::Caller;

/// How long a call waits for its job before it answers with the job's id.
const WAIT: Duration = Duration::from_secs(25);
/// The folder in an agent's own folder its exports go to when it names no path. No export
/// takes it along (`export::engine_owned`).
pub const EXPORTS_DIR: &str = ".orgtree-exports";

/// What the job has come to once it has ended, or how far it is when the wait is over.
#[nolog]
async fn settle(job: &Arc<Job>) -> Result<Done> {
    job.wait(WAIT).await;
    let mut status = job.status();
    if status["state"] == "running" {
        status["next"] = json!(format!("still running: call this tool again with job \"{}\" to read it", job.id));
    }
    if status["state"] == "failed" && status["refused"] == true {
        crate::refuse!(Conflict, "{}", status["error"].as_str().unwrap_or("refused"));
    }
    Done::json(&status)
}

/// A job this agent started, by the id a call gave it.
#[nolog]
fn started(caller: &Caller, me: &Me, id: &str) -> Result<Arc<Job>> {
    match jobs::get(caller.org_id, id).filter(|job| job.by == me.name) {
        Some(job) => Ok(job),
        None => crate::refuse!(NotFound, "no job {id} of yours is known here: it ended more than a day ago, or the engine was restarted"),
    }
}

/// Refuse unless `t` is the caller or below it.
#[nolog]
async fn own(client: &deadpool_postgres::Object, me: &Me, t: &Target, verb: &str) -> Result<()> {
    if t.id != me.id && !is_descendant(client, me.id, t.id).await? {
        crate::refuse!(Forbidden, "you can only {verb} yourself and the nodes below you; {} is not below you", t.name);
    }
    Ok(())
}

#[nolog]
fn strategy(args: &Value) -> Result<Option<Shrink>> {
    match arg_str(args, "strategy") {
        None => Ok(None),
        Some(name) => match Shrink::parse(name) {
            Some(strategy) => Ok(Some(strategy)),
            None => crate::refuse!(BadRequest, "strategy is {SHRINKS}"),
        },
    }
}

/// Where an agent's export is written: the path it names, in a folder it holds, or a file
/// of its own exports folder named after the node and the time.
#[nolog]
fn destination(presenter: &crate::domain::docs::Presenter, raw: Option<&str>, node: &str, subtree: bool) -> Result<PathBuf> {
    let dest = match raw {
        Some(raw) => {
            let path = Path::new(raw);
            let Some(file) = path.file_name().and_then(|f| f.to_str()).filter(|f| crate::http::scratch_files::upload_name(f) && f.to_ascii_lowercase().ends_with(".zip")) else {
                crate::refuse!(BadRequest, "path names the zip file to write (a plain file name ending in .zip)");
            };
            let folder = match path.parent().filter(|p| !p.as_os_str().is_empty()) {
                Some(folder) => crate::domain::docs::readable(presenter, &folder.to_string_lossy())?,
                None => presenter.scratch.clone(),
            };
            folder.join(file)
        }
        None => presenter.scratch.join(EXPORTS_DIR).join(format!("{node}{}-{}.orgtree.zip", if subtree { "-team" } else { "" }, chrono::Utc::now().format("%Y%m%d-%H%M%S"))),
    };
    if dest.exists() {
        crate::refuse!(Conflict, "{} is already there; name another path", dest.display());
    }
    Ok(dest)
}

/// The export an agent names: a file in a folder it holds, or one that was sent to it. An
/// attachment of mail it received, or a file the user gave it, lies in the organization's own
/// folders, which no agent holds; it is the agent's to read by having been addressed to it
/// (USER 2026-11-23 10:32Z: "allowing them to send full agents over to other orgs or the
/// mailhub"), by exactly the path its mail names.
#[nolog]
async fn import_file(engine: &Engine, me: &Me, presenter: &crate::domain::docs::Presenter, raw: &str) -> Result<PathBuf> {
    let refused = match crate::domain::docs::readable(presenter, raw) {
        Ok(path) => return Ok(path),
        Err(refused) => refused,
    };
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(refused);
    }
    let client = engine.db.get().await?;
    let received: bool = client
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM ot.mail m, jsonb_array_elements(m.attachments) a
                             WHERE m.recipient_agent_id = $1 AND jsonb_typeof(m.attachments) = 'array' AND a->>'path' = $2)
                 OR EXISTS (SELECT 1 FROM ot.uploads u WHERE u.agent_id = $1 AND u.path = $2)",
            &[&me.id, &raw],
        )
        .await?
        .get(0);
    if received && path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err(refused)
    }
}

/// `orgtree_export`.
#[nolog]
pub async fn export(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    if let Some(id) = arg_str(args, "job") {
        return settle(&started(caller, &me, id)?).await;
    }
    let t = target(&client, me.org_id, arg_str(args, "node").unwrap_or(&me.name)).await?;
    own(&client, &me, &t, "export").await?;
    drop(client);
    let Some(org) = engine.orgs.by_id(caller.org_id) else { crate::refuse!(NotFound, "organization not open") };
    let subtree = args["subtree"].as_bool().unwrap_or(false);
    let include: Include = match args.get("include").filter(|v| !v.is_null()) {
        Some(value) => match serde_json::from_value(value.clone()) {
            Ok(include) => include,
            Err(_) => crate::refuse!(BadRequest, "include is {{scratch, team, transcript, native_sessions, retired}}, each true or false"),
        },
        None => Include::default(),
    };
    let presenter = crate::domain::docs::presenter(engine, &org, caller.agent_id).await?;
    let dest = destination(&presenter, arg_str(args, "path"), &t.name, subtree)?;
    let job = service::start_export(engine, &org, ExportAsk { root: t.id, root_name: t.name.clone(), subtree, include, strip: None, manual: false, by: me.name.clone(),
                                                              dest: Some(dest) })?;
    settle(&job).await
}

/// `orgtree_import`.
#[nolog]
pub async fn import(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    drop(client);
    if let Some(id) = arg_str(args, "job") {
        return settle(&started(caller, &me, id)?).await;
    }
    let Some(org) = engine.orgs.by_id(caller.org_id) else { crate::refuse!(NotFound, "organization not open") };
    let presenter = crate::domain::docs::presenter(engine, &org, caller.agent_id).await?;
    let file = import_file(engine, &me, &presenter, need_str(args, "file")?).await?;
    let ask = ImportAsk {
        actor: Actor::Agent { id: me.id, name: me.name.clone() },
        file,
        // under itself unless it names a node below it; where it may go is the import's own rule
        dest: Some(arg_str(args, "dest").unwrap_or(&me.name).to_string()),
        index: args["index"].as_u64().map(|i| i as usize),
        strategy: strategy(args)?,
        expect: arg_str(args, "expect").map(str::to_string),
        resume_watchdogs: args["resume_watchdogs"].as_bool().unwrap_or(false),
    };
    if args["preview"].as_bool().unwrap_or(false) {
        return Done::json(&service::preview_import(engine, &org, ask).await?);
    }
    let job = service::start_import(engine, &org, None, &me.name, ask)?;
    settle(&job).await
}

/// `orgtree_duplicate`.
#[nolog]
pub async fn duplicate(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    if let Some(id) = arg_str(args, "job") {
        return settle(&started(caller, &me, id)?).await;
    }
    let t = target(&client, me.org_id, need_str(args, "node")?).await?;
    own(&client, &me, &t, "duplicate").await?;
    // beside the original unless it says where; where it may go is the import's own rule
    let beside = service::beside(&client, t.parent_id).await?;
    drop(client);
    let Some(org) = engine.orgs.by_id(caller.org_id) else { crate::refuse!(NotFound, "organization not open") };
    let ask = DuplicateAsk {
        actor: Actor::Agent { id: me.id, name: me.name.clone() },
        root: t.id,
        root_name: t.name.clone(),
        subtree: args["subtree"].as_bool().unwrap_or(false),
        dest: arg_str(args, "dest").map(str::to_string).or(beside),
        index: args["index"].as_u64().map(|i| i as usize),
        strategy: strategy(args)?,
        expect: arg_str(args, "expect").map(str::to_string),
    };
    if args["preview"].as_bool().unwrap_or(false) {
        return Done::json(&service::preview_duplicate(engine, &org, ask).await?);
    }
    let job = service::start_duplicate(engine, &org, &me.name, ask)?;
    settle(&job).await
}
