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
#[derive(Clone, Debug)]
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
    presenter_in(engine, org, agent_id, &**client).await
}

/// The same folder authority within a caller's mutation transaction.
#[logged]
pub(crate) async fn presenter_in<C: tokio_postgres::GenericClient + Sync>(engine: &Engine, org: &OrgHandle, agent_id: i64, client: &C) -> Result<Presenter> {
    let r = client
        .query_one(
            "SELECT a.name, a.scratch_dir, a.scope, o.settings,
                    ot.superior_of(a.id) IS NULL OR EXISTS (SELECT 1 FROM ot.effective_audiences au WHERE au.org_id = a.org_id AND au.grantee = a.name
                         AND au.grantor = '@user' AND au.revoked_at IS NULL AND NOT au.paused)
               FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id = $1 AND a.org_id = $2",
            &[&agent_id, &org.id],
        )
        .await?;
    let name: String = r.get(0);
    let scratch = r
        .get::<_, Option<String>>(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| engine.cfg.scratch_root(&org.slug).join(&name));
    let settings = crate::feed::groups::effective_settings(&r.get::<_, Value>(3), &engine.settings.defaults());
    let chain = crate::domain::projects::scope_ancestor_rows(client, agent_id, org.id).await?;
    if chain.first().map(|r| r.get::<_, Option<i64>>(1).is_some()).unwrap_or(true) {
        refuse!(Forbidden, "cannot resolve your complete folder authority chain");
    }
    let mut effective = scope::org_ceiling(&settings["dirs"]);
    for ancestor in &chain {
        if ancestor.get::<_, &str>(3)!="project" { effective = scope::clamp(&ancestor.get::<_, Value>(0), &effective); }
    }
    let mut dirs: Vec<String> = Vec::new();
    for d in effective["add_dirs"].as_array().into_iter().flatten() {
        if let Some(p) = d["path"].as_str() {
            dirs.push(p.to_string());
        }
    }
    dirs.push(engine.cfg.workspace_dir(&org.slug).to_string_lossy().to_string());
    // every agent of the org holds its shared notes folder
    dirs.push(engine.cfg.org_notes_dir(&org.slug).to_string_lossy().to_string());
    // and the workspaces of the subtrees it is inside
    for ancestor in &chain {
        dirs.push(engine.cfg.teams_dir(&org.slug).join(ancestor.get::<_, i64>(4).to_string()).to_string_lossy().to_string());
    }
    // and the folders of the projects below it (docs/rust-engine/PROJECT-NODES.md)
    for (id, _) in crate::domain::projects::below(client, agent_id).await? {
        dirs.push(engine.cfg.teams_dir(&org.slug).join(id.to_string()).to_string_lossy().to_string());
    }
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

/// Room left on the outbox's drive beyond the copy itself.
pub(crate) const FREE_MARGIN: u64 = 64 * 1024 * 1024;

/// The two things a copy asks of the machine, so tests can inject both: bytes free
/// on the drive holding `path` (`None` = unknown, then no refusal) and the copy itself.
#[derive(Debug)]
pub(crate) struct CopyEnv {
    pub free_space: fn(&Path) -> Option<u64>,
    pub copy: fn(&Path, &Path) -> std::io::Result<u64>,
}
const REAL_ENV: CopyEnv = CopyEnv { free_space: free_bytes, copy: |from, to| std::fs::copy(from, to) };

#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}
#[cfg(windows)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut avail = 0u64;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(avail)
}
#[cfg(not(any(unix, windows)))]
fn free_bytes(_path: &Path) -> Option<u64> { None }

fn gb(bytes: u64) -> String { format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0)) }

/// Copy a checked file to a fresh outbox directory, even if the source is already in outbox.
/// BLOCKING: the copy of a large file takes minutes, so async callers run this on a blocking thread.
#[logged]
pub(crate) fn snapshot(p: &Presenter, raw: &str, network: Option<&crate::net::AttachmentLimit>) -> Result<Value> {
    snapshot_with(p, raw, network, &REAL_ENV)
}

#[logged]
pub(crate) fn snapshot_with(p: &Presenter, raw: &str, network: Option<&crate::net::AttachmentLimit>, env: &CopyEnv) -> Result<Value> {
    let src = readable(p, raw)?;
    if !src.is_file() { refuse!(BadRequest, "attachment is not a file"); }
    let size = std::fs::metadata(&src)?.len();
    if let Some(limit) = network {
        let scratch = crate::config::strip_verbatim(&std::fs::canonicalize(&p.scratch)?);
        if !scope::path_within(&src.to_string_lossy(), &scratch.to_string_lossy()) {
            refuse!(Forbidden, "network attachments must be inside your working folder");
        }
        limit.check(size)?;
    }
    let name = src.file_name().ok_or_else(|| anyhow::anyhow!("file has no name"))?.to_string_lossy().to_string();
    let outbox = p.scratch.join("outbox");
    std::fs::create_dir_all(&outbox)?;
    let scratch = crate::config::strip_verbatim(&std::fs::canonicalize(&p.scratch)?);
    let outbox = crate::config::strip_verbatim(&std::fs::canonicalize(outbox)?);
    if !scope::path_within(&outbox.to_string_lossy(), &scratch.to_string_lossy()) {
        refuse!(Forbidden, "outbox escapes your working folder");
    }
    // the copy needs `size` more bytes on the outbox's drive; refuse before writing any of it
    if let Some(available) = (env.free_space)(&outbox) {
        if available < size.saturating_add(FREE_MARGIN) {
            refuse!(BadRequest, "{name} needs {} free in your working folder's drive; {} available", gb(size), gb(available));
        }
    }
    let folder = outbox.join(uid("delivery"));
    std::fs::create_dir(&folder)?;
    let dest = folder.join(&name);
    // a copy or check that fails leaves neither a partial file nor its empty delivery folder
    let result = (|| -> Result<Value> {
        (env.copy)(&src, &dest)?;
        let bytes = std::fs::metadata(&dest)?.len();
        if let Some(limit) = network { limit.check(bytes)?; }
        Ok(json!({ "name": name, "path": dest.to_string_lossy(), "bytes": bytes }))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_dir(&folder);
    }
    result
}

/// A markdown file presented by `path`: its text is the body, under the
/// body's 64 KB limit. A leading byte-order mark is dropped.
#[logged]
fn markdown_file(f: &Path, raw: &str) -> Result<String> {
    use std::io::Read;
    if !f.is_file() {
        refuse!(BadRequest, "{raw} is not a file");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(f)?.take(MARKDOWN_MAX as u64 + 4).read_to_end(&mut bytes)?;
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    if text.len() > MARKDOWN_MAX {
        refuse!(BadRequest, "{raw} is over the 64 KB markdown limit; present a shorter document or split it across several cards");
    }
    let Ok(text) = std::str::from_utf8(text) else { refuse!(BadRequest, "{raw} is not UTF-8 text") };
    Ok(text.to_string())
}

/// A tool's optional `slug` (user 2026-10-27 mdcb7ce9a8103): text, trimmed, and
/// an empty one counts as none. One with no ASCII letter or digit is refused:
/// the database's cleanup (`ot.slug_base`) would leave nothing of it. The
/// database makes the slug from it, with -2, -3... when it is taken.
/// Argument parsing inside a logged tool call, so not logged again.
#[nolog]
pub(crate) fn requested_slug(args: &Value) -> Result<Option<&str>> {
    let slug = match &args["slug"] {
        Value::Null => None,
        Value::String(s) => Some(s.trim()).filter(|s| !s.is_empty()),
        _ => refuse!(BadRequest, "slug is text: a short English name such as weekly-status"),
    };
    if let Some(slug) = slug {
        if !slug.chars().any(|c| c.is_ascii_alphanumeric()) {
            refuse!(BadRequest, "slug {slug:?} has no ASCII letter or digit, so nothing is left after cleanup; pass a short English slug such as weekly-status");
        }
    }
    Ok(slug)
}

/// `orgtree_present`. Returns (text, chip card).
#[logged]
pub async fn present(engine: &Arc<Engine>, org: &Arc<OrgHandle>, p: &Presenter, args: &Value) -> Result<(String, Value)> {
    let project_name = args["project"].as_str().map(str::trim).filter(|s| !s.is_empty());
    if !p.may_present && project_name.is_none() {
        refuse!(Forbidden, "presenting to the user needs a user audience (top-level agents hold one); send it to your superior instead");
    }
    let title = args["title"].as_str().map(str::trim).filter(|t| !t.is_empty());
    let Some(title) = title else { refuse!(BadRequest, "a document needs a title") };
    let title: String = title.chars().take(TITLE_MAX).collect();
    let title = title.trim_end();
    // A new presentation may be named (user 2026-10-27 mdcb7ce9a8103), in
    // English when the title isn't (mea228250b31e); the database cleans it like
    // a title (migration 0074). A slug stays fixed once made.
    let slug = requested_slug(args)?;
    if slug.is_some() && args["replaces"].as_str().is_some_and(|s| !s.is_empty()) {
        refuse!(BadRequest, "slug names a new presentation only: a presentation keeps its slug once made, so leave slug out when you pass replaces");
    }
    let mut bundle_download: Option<Vec<u8>> = None;
    let mut bundle_preview: Option<String> = None;
    let (body, format) = match (args["body"].as_str(), args["path"].as_str()) {
        (Some(b), None) => {
            if b.len() > MARKDOWN_MAX {
                refuse!(BadRequest, "a markdown body is limited to 64 KB; present a shorter document or split it across several cards");
            }
            (b.to_string(), "markdown")
        }
        (None, Some(path)) => {
            let f = readable(p, path)?;
            let lower = f.to_string_lossy().to_lowercase();
            if lower.ends_with(".md") || lower.ends_with(".markdown") {
                (markdown_file(&f, path)?, "markdown")
            } else {
                if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
                    refuse!(BadRequest, "path presents a .md document or a .html/.htm presentation");
                }
                let size = std::fs::metadata(&f)?.len();
                if size > HTML_MAX {
                    refuse!(BadRequest, "an HTML presentation is limited to 4 MB");
                }
                let bundle = crate::domain::html_bundle::capture(&f)?;
                bundle_download = bundle.download;
                bundle_preview = Some(bundle.preview);
                (bundle.body, "html")
            }
        }
        _ => refuse!(BadRequest, "give exactly one of body (markdown) or path (a .md file or an .html presentation)"),
    };
    let client = engine.db.get().await?;
    // under the caller's own seat, or under a project it reaches (its own
    // presentations bucket, user 2026-10-16 16:09Z / 16:11Z)
    let (owner_id, owner_name, under) = match project_name {
        Some(name) => {
            let Some(pr) = crate::domain::projects::by_name(&**client, org.id, name).await? else {
                refuse!(NotFound, "no project named {name} in this organization");
            };
            if pr.state != "live" {
                refuse!(Conflict, "project {} is retired", pr.name);
            }
            crate::domain::projects::require_reach(&**client, p.id, &pr, "present under it").await?;
            if !p.may_present {
                // Project members may present to their own project, including
                // through nested projects. Reach also includes ancestors, so
                // it alone cannot replace the user-audience requirement.
                let ancestors = crate::domain::projects::scope_ancestor_rows(&**client, p.id, org.id).await?;
                let member = p.id != pr.id && ancestors.iter().any(|row| row.get::<_, i64>(4) == pr.id);
                if !member {
                    refuse!(Forbidden, "presenting outside your own project needs a user audience (top-level agents hold one); send it to your superior instead");
                }
            }
            (pr.id, pr.name.clone(), Some(pr.name))
        }
        None => (p.id, p.name.clone(), None),
    };
    let bytes = body.len() as i32;
    // A presentation's id is its slug (migration 0073, user 2026-10-27
    // m4efbc12ac94e); `replaces` also takes the old generic id it had before.
    let id: String = match args["replaces"].as_str().filter(|s| !s.is_empty()) {
        Some(old) => {
            let row = client
                .query_opt(
                    "UPDATE ot.documents SET title = $3, body = $4, format = $5, bytes = $6, at = now(), dismissed = false, download = $8, preview = $9,
                            presented_by = CASE WHEN $10::text IS NULL THEN presented_by ELSE $10 END
                      WHERE org_id = $1 AND id = ot.document_ref($1, $2) AND agent_id = $7 RETURNING slug",
                    &[&org.id, &old, &title, &body, &format, &bytes, &owner_id, &bundle_download, &bundle_preview,
                      &under.as_ref().map(|_| p.name.clone())],
                )
                .await?;
            let Some(row) = row else {
                match &under {
                    Some(pr) => refuse!(NotFound, "project {pr} has no presentation {old} to replace"),
                    None => refuse!(NotFound, "you have no presentation {old} to replace"),
                }
            };
            row.get(0)
        }
        // the database makes the slug from the requested one or the title
        // (ot.assign_document_slug); `uid` stays an internal key
        None => client
            .query_one(
                "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, download, preview, presented_by, slug)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING slug",
                &[&uid("d"), &org.id, &owner_id, &owner_name, &title, &body, &format, &bytes, &bundle_download, &bundle_preview,
                  &under.as_ref().map(|_| p.name.clone()), &slug],
            )
            .await?
            .get(0),
    };
    let reference = format!("@doc:{}/{id}", org.slug);
    let mut detail = json!({ "id": id, "title": title, "format": format, "bytes": bytes });
    if let Some(pr) = &under {
        detail["project"] = json!(pr);
        detail["by"] = json!(p.name);
    }
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'present', $2, $3, $4)",
            &[&org.id, &p.name, &owner_id, &detail],
        )
        .await?;
    drop(client);
    crate::runtime::watchdogs::events::emit(engine,crate::runtime::watchdogs::events::event(if args["replaces"].as_str().is_some(){"documents.updated"}else{"documents.created"},crate::runtime::watchdogs::events::Scope::Agent(org.id,owner_id),json!({"agent_id":owner_id,"document":id})));
    changes::notify(engine, org, vec![Change::Documents(owner_id), Change::Events]);
    // Presentation mention chips show the current title (user 2026-10-27
    // m7bb9eb904138) and read it again: a replace may retitle a presentation
    // the record feed does not carry.
    org.emit(json!({ "type": "documents_changed", "org": org.slug }));
    let mut card = json!({ "presentation": { "id": id, "title": title, "format": format, "ref": reference } });
    if let Some(pr) = &under {
        card["presentation"]["project"] = json!(pr);
        return Ok((format!("Presented \"{title}\" under project {pr} (id {id}, mention {reference}; pass the id as `replaces` with project={pr} to update this card)."), card));
    }
    Ok((format!("Presented \"{title}\" to the user (id {id}, mention {reference}; pass the id as `replaces` to update this card)."), card))
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
    // as in 3.x: an empty file is not delivered, and neither is one over the cap
    let src = readable(p, raw)?;
    if src.is_file() {
        let size = std::fs::metadata(&src)?.len();
        if size == 0 {
            refuse!(BadRequest, "{raw} is empty; nothing to send");
        }
        if size > SEND_MAX {
            refuse!(BadRequest, "{raw} is {}, over the {} cap", gb(size), gb(SEND_MAX));
        }
    }
    // minutes of copying must not hold an engine worker
    let copy = { let (p, raw) = (p.clone(), raw.to_string()); tokio::task::spawn_blocking(move || snapshot(&p, &raw, None)).await?? };
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

#[cfg(test)]
mod requested_slug_tests {
    use serde_json::json;

    /// User 2026-10-27 mdcb7ce9a8103: an optional slug, cleaned by the
    /// database; nothing left after the cleanup is refused, never a fallback.
    #[test]
    fn requested_slug_is_optional_text_with_an_ascii_letter_or_digit() {
        for (args, want) in [(json!({}), None), (json!({ "slug": null }), None), (json!({ "slug": "" }), None),
            (json!({ "slug": "   " }), None), (json!({ "slug": " Weekly Report! " }), Some("Weekly Report!")),
            (json!({ "slug": "q3" }), Some("q3")), (json!({ "slug": "דוח 2" }), Some("דוח 2"))] {
            assert_eq!(super::requested_slug(&args).unwrap(), want, "{args}");
        }
        for args in [json!({ "slug": "שלום" }), json!({ "slug": "—" }), json!({ "slug": "-- __ --" })] {
            let refused = super::requested_slug(&args).unwrap_err().to_string();
            assert!(refused.contains("no ASCII letter or digit") && refused.contains("English"), "{args}: {refused}");
        }
        for args in [json!({ "slug": 7 }), json!({ "slug": ["a"] }), json!({ "slug": true })] {
            assert!(super::requested_slug(&args).unwrap_err().to_string().starts_with("slug is text"), "{args}");
        }
    }
}

#[cfg(test)]
mod send_file_copy_tests {
    use super::*;

    /// A scratch folder with one file in it, deleted on drop.
    struct Fixture { root: PathBuf, presenter: Presenter }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    fn fixture(bytes: &[u8]) -> Fixture {
        let root = std::env::temp_dir().join(uid("sendcopy"));
        let scratch = root.join("agent");
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::write(scratch.join("big.bin"), bytes).unwrap();
        let presenter = Presenter { id: 1, name: "a".into(), may_present: true, scratch: scratch.clone(), dirs: vec![] };
        Fixture { root, presenter }
    }
    fn deliveries(f: &Fixture) -> Vec<PathBuf> {
        match std::fs::read_dir(f.presenter.scratch.join("outbox")) {
            Ok(rd) => rd.map(|e| e.unwrap().path()).collect(),
            Err(_) => vec![],
        }
    }
    const PLENTY: fn(&Path) -> Option<u64> = |_| Some(u64::MAX);

    #[test]
    fn a_normal_small_send_is_unchanged() {
        let f = fixture(b"hello");
        let v = snapshot(&f.presenter, "big.bin", None).unwrap();
        assert_eq!(v["name"], "big.bin");
        assert_eq!(v["bytes"], 5);
        assert_eq!(std::fs::read(v["path"].as_str().unwrap()).unwrap(), b"hello");
    }

    #[test]
    fn too_little_free_space_refuses_before_writing_anything() {
        let f = fixture(&vec![7u8; 2048]);
        let env = CopyEnv { free_space: |_| Some(FREE_MARGIN + 1024), copy: |_, _| panic!("must not copy") };
        let err = snapshot_with(&f.presenter, "big.bin", None, &env).unwrap_err().to_string();
        assert!(err.contains("big.bin needs") && err.contains("GB free in your working folder's drive") && err.contains("available"), "{err}");
        assert!(deliveries(&f).iter().all(|d| std::fs::read_dir(d).map(|mut r| r.next().is_none()).unwrap_or(true)) && deliveries(&f).is_empty(), "no delivery folder left");
    }

    #[test]
    fn exactly_enough_free_space_copies_and_unknown_free_space_is_not_a_refusal() {
        let f = fixture(&vec![1u8; 2048]);
        let ok = CopyEnv { free_space: |_| Some(2048 + FREE_MARGIN), copy: |a, b| std::fs::copy(a, b) };
        assert_eq!(snapshot_with(&f.presenter, "big.bin", None, &ok).unwrap()["bytes"], 2048);
        let unknown = CopyEnv { free_space: |_| None, copy: |a, b| std::fs::copy(a, b) };
        assert_eq!(snapshot_with(&f.presenter, "big.bin", None, &unknown).unwrap()["bytes"], 2048);
    }

    #[test]
    fn a_copy_that_fails_midway_removes_the_partial_file_and_its_folder() {
        let f = fixture(&vec![1u8; 2048]);
        let env = CopyEnv { free_space: PLENTY, copy: |_, to| { std::fs::write(to, b"partial")?; Err(std::io::Error::other("disk gone")) } };
        let err = snapshot_with(&f.presenter, "big.bin", None, &env).unwrap_err().to_string();
        assert!(err.contains("disk gone"), "{err}");
        let left = deliveries(&f);
        assert!(left.is_empty(), "a partial delivery was left: {left:?}");
    }

    #[test]
    fn the_cap_message_reads_in_gb() {
        assert_eq!(gb(32 * 1024 * 1024 * 1024), "32.0 GB");
        assert_eq!(gb(1536 * 1024 * 1024), "1.5 GB");
    }
}
