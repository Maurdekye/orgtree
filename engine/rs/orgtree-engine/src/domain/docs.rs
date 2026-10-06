//! Documents agents present to the user (a reader card beside the agent)
//! and files they deliver (a download card in their chat).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::scope;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::refuse;
use crate::util::uid;

pub const MARKDOWN_MAX: usize = 64 * 1024;
pub const HTML_MAX: u64 = 4 * 1024 * 1024;

/// The presenting agent, with the folders it may read files from.
#[derive(Debug)]
pub struct Presenter {
    pub id: i64,
    pub name: String,
    pub may_present: bool,
    pub scratch: PathBuf,
    pub dirs: Vec<String>,
}

#[logged]
pub async fn presenter(engine: &Engine, org: &OrgHandle, agent_id: i64) -> Result<Presenter> {
    let client = engine.db.get().await?;
    let r = client
        .query_one(
            "SELECT a.name, a.scratch_dir, a.scope, o.settings,
                    a.parent_id IS NULL OR EXISTS (SELECT 1 FROM ot.audiences au WHERE au.org_id = a.org_id AND au.grantee = a.name
                         AND au.grantor = '@user' AND au.revoked_at IS NULL AND NOT au.paused)
               FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id = $1",
            &[&agent_id],
        )
        .await?;
    let name: String = r.get(0);
    let scratch = r
        .get::<_, Option<String>>(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| engine.cfg.scratch_root(&org.slug).join(&name));
    let settings = crate::feed::groups::effective_settings(&r.get::<_, Value>(3), &engine.settings.defaults());
    let configured = scope::normalize(&r.get::<_, Value>(2));
    let mut dirs: Vec<String> = Vec::new();
    for d in scope::clamp_dirs(
        configured["add_dirs"].as_array().map(|a| a.as_slice()).unwrap_or(&[]),
        settings["dirs"].as_array().map(|a| a.as_slice()).unwrap_or(&[]),
    ) {
        if let Some(p) = d["path"].as_str() {
            dirs.push(p.to_string());
        }
    }
    dirs.push(engine.cfg.workspace_dir(&org.slug).to_string_lossy().to_string());
    Ok(Presenter { id: agent_id, name, may_present: r.get(4), scratch, dirs })
}

/// A path the agent may read: inside its folder, the workspace or a folder it holds.
#[logged]
fn readable(p: &Presenter, raw: &str) -> Result<PathBuf> {
    let path = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { p.scratch.join(raw) };
    let Ok(canon) = std::fs::canonicalize(&path) else {
        refuse!(NotFound, "{raw} does not exist (relative paths start in your working folder {})", p.scratch.display());
    };
    let canon = crate::config::strip_verbatim(&canon);
    let c = canon.to_string_lossy().to_string();
    let inside = scope::path_within(&c, &p.scratch.to_string_lossy()) || p.dirs.iter().any(|d| scope::path_within(&c, d));
    if !inside {
        refuse!(Forbidden, "{raw} is outside your working folder and the folders you hold");
    }
    Ok(canon)
}

/// `orgtree_present`. Returns (text, chip card).
#[logged]
pub async fn present(engine: &Arc<Engine>, org: &Arc<OrgHandle>, p: &Presenter, args: &Value) -> Result<(String, Value)> {
    if !p.may_present {
        refuse!(Forbidden, "presenting to the user needs a user audience (top-level agents hold one); send it to your superior instead");
    }
    let title = args["title"].as_str().map(str::trim).filter(|t| !t.is_empty());
    let Some(title) = title else { refuse!(BadRequest, "a document needs a title") };
    let (body, format) = match (args["body"].as_str(), args["path"].as_str()) {
        (Some(b), None) => {
            if b.len() > MARKDOWN_MAX {
                refuse!(BadRequest, "a markdown body is limited to 64 KB; present a shorter document or send it as a file");
            }
            (b.to_string(), "markdown")
        }
        (None, Some(path)) => {
            let f = readable(p, path)?;
            let lower = f.to_string_lossy().to_lowercase();
            if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
                refuse!(BadRequest, "path presents a .html/.htm mockup; use body for markdown");
            }
            let size = std::fs::metadata(&f)?.len();
            if size > HTML_MAX {
                refuse!(BadRequest, "an HTML mockup is limited to 4 MB");
            }
            (std::fs::read_to_string(&f)?, "html")
        }
        _ => refuse!(BadRequest, "give exactly one of body (markdown) or path (an .html mockup)"),
    };
    let client = engine.db.get().await?;
    let bytes = body.len() as i32;
    let id = match args["replaces"].as_str().filter(|s| !s.is_empty()) {
        Some(old) => {
            let n = client
                .execute(
                    "UPDATE ot.documents SET title = $3, body = $4, format = $5, bytes = $6, at = now(), dismissed = false
                      WHERE org_id = $1 AND uid = $2 AND agent_id = $7",
                    &[&org.id, &old, &title, &body, &format, &bytes, &p.id],
                )
                .await?;
            if n == 0 {
                refuse!(NotFound, "you have no presentation {old} to replace");
            }
            old.to_string()
        }
        None => {
            let id = uid("d");
            client
                .execute(
                    "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    &[&id, &org.id, &p.id, &p.name, &title, &body, &format, &bytes],
                )
                .await?;
            id
        }
    };
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'present', $2, $3, $4)",
            &[&org.id, &p.name, &p.id, &json!({ "id": id, "title": title, "format": format, "bytes": bytes })],
        )
        .await?;
    drop(client);
    changes::notify(engine, org, vec![Change::Documents(p.id), Change::Events]);
    let card = json!({ "presentation": { "id": id, "title": title, "format": format } });
    Ok((format!("Presented \"{title}\" to the user (id {id}; pass it as `replaces` to update this card)."), card))
}

/// `orgtree_send_file`. Returns (text, chip card).
#[logged]
pub async fn send_file(engine: &Arc<Engine>, org: &Arc<OrgHandle>, p: &Presenter, args: &Value) -> Result<(String, Value)> {
    let Some(raw) = args["path"].as_str().filter(|s| !s.trim().is_empty()) else {
        refuse!(BadRequest, "name the file to send (path)");
    };
    let note = args["note"].as_str().map(|n| crate::util::gist(n, 300));
    let client = engine.db.get().await?;
    if let Some(did) = args["delivery_id"].as_str().filter(|s| !s.is_empty()) {
        if let Some(r) = client
            .query_opt("SELECT name, path, bytes, note FROM ot.deliveries WHERE org_id = $1 AND uid = $2", &[&org.id, &did])
            .await?
        {
            let card = json!({ "file": { "name": r.get::<_, String>(0), "path": r.get::<_, String>(1),
                                         "bytes": r.get::<_, i64>(2), "note": r.get::<_, Option<String>>(3), "delivery_id": did } });
            return Ok((format!("Already delivered ({did})."), card));
        }
    }
    let src = readable(p, raw)?;
    if !src.is_file() {
        refuse!(BadRequest, "{raw} is not a file");
    }
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    // the delivered copy lives in the agent's outbox, so later edits never change it
    let outbox = p.scratch.join("outbox");
    std::fs::create_dir_all(&outbox)?;
    let did = args["delivery_id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| uid("f"));
    let mut dest = outbox.join(&name);
    if dest != src && dest.exists() {
        let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = Path::new(&name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest = outbox.join(format!("{stem}-{}{ext}", &did[did.len().saturating_sub(6)..]));
    }
    if dest != src {
        std::fs::copy(&src, &dest)?;
    }
    let bytes = std::fs::metadata(&dest).map(|m| m.len() as i64).unwrap_or(0);
    let path = dest.to_string_lossy().to_string();
    client
        .execute(
            "INSERT INTO ot.deliveries (uid, org_id, agent_id, name, path, bytes, note) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[&did, &org.id, &p.id, &name, &path, &bytes, &note],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'send_file', $2, $3, $4)",
            &[&org.id, &p.name, &p.id, &json!({ "name": name, "bytes": bytes, "delivery_id": did })],
        )
        .await?;
    drop(client);
    changes::notify(engine, org, vec![Change::Events, Change::History(p.id)]);
    let card = json!({ "file": { "name": name, "path": path, "bytes": bytes, "note": note, "delivery_id": did } });
    Ok((format!("Delivered {name} ({bytes} bytes) to the user as a download card (delivery {did})."), card))
}
