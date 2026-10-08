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
/// The largest file `orgtree_send_file` delivers (3.x `_SENDFILE_MAX`).
pub const SEND_MAX: u64 = 256 * 1024 * 1024;
/// A presentation's title is at most this many characters (3.x).
const TITLE_MAX: usize = 120;

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
    let chain = client.query(
        "WITH RECURSIVE chain AS (
           SELECT id, parent_id, scope, 0 AS depth FROM ot.agents WHERE id = $1 AND org_id = $2
           UNION ALL SELECT a.id, a.parent_id, a.scope, c.depth + 1
           FROM ot.agents a JOIN chain c ON a.id = c.parent_id WHERE a.org_id = $2 AND c.depth < 1024)
         SELECT scope, parent_id FROM chain ORDER BY depth DESC LIMIT 1025",
        &[&agent_id, &org.id]).await?;
    if chain.first().map(|r| r.get::<_, Option<i64>>(1).is_some()).unwrap_or(true) {
        refuse!(Forbidden, "cannot resolve your complete folder authority chain");
    }
    let mut effective = scope::org_ceiling(&settings["dirs"]);
    for ancestor in chain { effective = scope::clamp(&ancestor.get::<_, Value>(0), &effective); }
    let mut dirs: Vec<String> = Vec::new();
    for d in effective["add_dirs"].as_array().into_iter().flatten() {
        if let Some(p) = d["path"].as_str() {
            dirs.push(p.to_string());
        }
    }
    dirs.push(engine.cfg.workspace_dir(&org.slug).to_string_lossy().to_string());
    Ok(Presenter { id: agent_id, name, may_present: r.get(4), scratch, dirs })
}

/// A path the agent may read: inside its folder, the workspace or a folder it holds.
#[logged]
pub(crate) fn readable(p: &Presenter, raw: &str) -> Result<PathBuf> {
    let path = if Path::new(raw).is_absolute() { PathBuf::from(raw) } else { p.scratch.join(raw) };
    let Ok(canon) = std::fs::canonicalize(&path) else {
        refuse!(NotFound, "{raw} does not exist (relative paths start in your working folder {})", p.scratch.display());
    };
    let canon = crate::config::strip_verbatim(&canon);
    let c = canon.to_string_lossy().to_string();
    let inside = std::iter::once(p.scratch.clone()).chain(p.dirs.iter().map(PathBuf::from)).any(|root| {
        std::fs::canonicalize(root).ok().map(|r| scope::path_within(&c, &crate::config::strip_verbatim(&r).to_string_lossy())).unwrap_or(false)
    });
    if !inside {
        refuse!(Forbidden, "{raw} is outside your working folder and the folders you hold");
    }
    Ok(canon)
}

/// Copy a checked file to a fresh outbox directory, even if the source is already in outbox.
#[logged]
pub(crate) fn snapshot(p: &Presenter, raw: &str, network: bool) -> Result<Value> {
    let src = readable(p, raw)?;
    if !src.is_file() { refuse!(BadRequest, "attachment is not a file"); }
    let size = std::fs::metadata(&src)?.len();
    if network {
        let scratch = crate::config::strip_verbatim(&std::fs::canonicalize(&p.scratch)?);
        if !scope::path_within(&src.to_string_lossy(), &scratch.to_string_lossy()) {
            refuse!(Forbidden, "network attachments must be inside your working folder");
        }
        if size > 25 * 1024 * 1024 { refuse!(BadRequest, "attachment over 25 MB"); }
    }
    let name = src.file_name().ok_or_else(|| anyhow::anyhow!("file has no name"))?.to_string_lossy().to_string();
    let outbox = p.scratch.join("outbox");
    std::fs::create_dir_all(&outbox)?;
    let scratch = crate::config::strip_verbatim(&std::fs::canonicalize(&p.scratch)?);
    let outbox = crate::config::strip_verbatim(&std::fs::canonicalize(outbox)?);
    if !scope::path_within(&outbox.to_string_lossy(), &scratch.to_string_lossy()) {
        refuse!(Forbidden, "outbox escapes your working folder");
    }
    let folder = outbox.join(uid("delivery"));
    std::fs::create_dir(&folder)?;
    let dest = folder.join(&name);
    std::fs::copy(&src, &dest)?;
    let bytes = std::fs::metadata(&dest)?.len();
    if network && bytes > 25 * 1024 * 1024 {
        std::fs::remove_file(&dest)?;
        refuse!(BadRequest, "attachment over 25 MB");
    }
    Ok(json!({ "name": name, "path": dest.to_string_lossy(), "bytes": bytes }))
}

/// `orgtree_present`. Returns (text, chip card).
#[logged]
pub async fn present(engine: &Arc<Engine>, org: &Arc<OrgHandle>, p: &Presenter, args: &Value) -> Result<(String, Value)> {
    if !p.may_present {
        refuse!(Forbidden, "presenting to the user needs a user audience (top-level agents hold one); send it to your superior instead");
    }
    let title = args["title"].as_str().map(str::trim).filter(|t| !t.is_empty());
    let Some(title) = title else { refuse!(BadRequest, "a document needs a title") };
    let title: String = title.chars().take(TITLE_MAX).collect();
    let title = title.trim_end();
    let mut bundle_download: Option<Vec<u8>> = None;
    let mut bundle_preview: Option<String> = None;
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
            let bundle = crate::domain::html_bundle::capture(&f)?;
            bundle_download = bundle.download;
            bundle_preview = Some(bundle.preview);
            (bundle.body, "html")
        }
        _ => refuse!(BadRequest, "give exactly one of body (markdown) or path (an .html mockup)"),
    };
    let client = engine.db.get().await?;
    let bytes = body.len() as i32;
    let id = match args["replaces"].as_str().filter(|s| !s.is_empty()) {
        Some(old) => {
            let n = client
                .execute(
                    "UPDATE ot.documents SET title = $3, body = $4, format = $5, bytes = $6, at = now(), dismissed = false, download = $8, preview = $9
                      WHERE org_id = $1 AND uid = $2 AND agent_id = $7",
                    &[&org.id, &old, &title, &body, &format, &bytes, &p.id, &bundle_download, &bundle_preview],
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
                    "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, download, preview) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                    &[&id, &org.id, &p.id, &p.name, &title, &body, &format, &bytes, &bundle_download, &bundle_preview],
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
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event(if args["replaces"].as_str().is_some(){"documents.updated"}else{"documents.created"},crate::runtime::watchdogs::events::Scope::Agent(org.id,p.id),json!({"agent_id":p.id,"document":id})));
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
    if let Some(did) = args["delivery_id"].as_str() {
        if did.len() > 200 { refuse!(BadRequest, "delivery_id is limited to 200 bytes"); }
    }
    let note = args["note"].as_str().map(|n| crate::util::gist(n, 300));
    let client = engine.db.get().await?;
    if let Some(did) = args["delivery_id"].as_str().filter(|s| !s.is_empty()) {
        if let Some(r) = client
            .query_opt("SELECT name, path, bytes, note FROM ot.deliveries WHERE org_id = $1 AND uid = $2 AND agent_id = $3", &[&org.id, &did, &p.id])
            .await?
        {
            let card = json!({ "file": { "name": r.get::<_, String>(0), "path": r.get::<_, String>(1),
                                         "bytes": r.get::<_, i64>(2), "note": r.get::<_, Option<String>>(3), "delivery_id": did } });
            return Ok((format!("Already delivered ({did})."), card));
        }
    }
    drop(client);
    // as in 3.x: an empty file is not delivered, and neither is one over 256 MB
    let src = readable(p, raw)?;
    if src.is_file() {
        let size = std::fs::metadata(&src)?.len();
        if size == 0 {
            refuse!(BadRequest, "{raw} is empty; nothing to send");
        }
        if size > SEND_MAX {
            refuse!(BadRequest, "{raw} is {} MB, over the {} MB cap", size / (1024 * 1024), SEND_MAX / (1024 * 1024));
        }
    }
    let copy = snapshot(p, raw, false)?;
    let name = copy["name"].as_str().unwrap().to_string();
    let path = copy["path"].as_str().unwrap().to_string();
    let bytes = copy["bytes"].as_u64().unwrap() as i64;
    let did = args["delivery_id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| uid("f"));
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let inserted = tx.execute(
        "INSERT INTO ot.deliveries (uid, org_id, agent_id, name, path, bytes, note) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (uid) DO NOTHING",
        &[&did, &org.id, &p.id, &name, &path, &bytes, &note]).await?;
    let row = tx.query_opt("SELECT name, path, bytes, note FROM ot.deliveries WHERE uid = $1 AND org_id = $2 AND agent_id = $3", &[&did, &org.id, &p.id]).await?;
    let Some(row) = row else { refuse!(Conflict, "delivery_id is already in use; choose another ID"); };
    if inserted > 0 {
        tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'send_file', $2, $3, $4)",
            &[&org.id, &p.name, &p.id, &json!({ "name": name, "bytes": bytes, "delivery_id": did })]).await?;
    }
    tx.commit().await?;
    let name: String = row.get(0); let bytes: i64 = row.get(2);
    let card = json!({ "file": { "name": name, "path": row.get::<_,String>(1), "bytes": bytes, "note": row.get::<_,Option<String>>(3), "delivery_id": did } });
    if inserted > 0 { changes::notify(engine, org, vec![Change::Events, Change::History(p.id)]); }
    Ok((format!("Delivered {name} ({bytes} bytes) to the user as a download card (delivery {did})."), card))
}
