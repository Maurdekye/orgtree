//! The files of a scratch folder, for a window that is not on this computer
//! (docs/rust-engine/remote-org.md, "The Files panel").
//!
//! A window of a remote organization cannot open the other computer's file
//! manager, so the scratch-folder entries open a panel that lists the folder,
//! downloads from it and uploads into it. Three routes serve it:
//!
//! - `GET  .../nodes/{nid}/scratch-files`         one folder's entries, a page at a time
//! - `GET  .../nodes/{nid}/scratch-files/file`    one file, or a folder as a zip, streamed
//! - `PUT  .../nodes/{nid}/scratch-files/upload`  one file, streamed to a temporary name and renamed
//!
//! `scope` chooses the folder exactly as `nodes::scratch_folder` does (the
//! agent's own, its team's, the organization's shared one) and `path` is a
//! path inside it, with `/` between its parts.
//!
//! WHAT KEEPS A REQUEST INSIDE THE FOLDER (`confine`): the folder is resolved
//! first; every part of `path` must be a plain name (no `..`, no drive, no
//! separator); every folder on the way and the target itself is looked at
//! without following it, and a symbolic link, a junction or any other reparse
//! point is refused; and the target, resolved, must still be inside the
//! resolved folder. A listing shows a link as a link and offers nothing for
//! it; a zip leaves links out.
//!
//! Who may call: the owner and a member (`remote_access::member::ORG`). A
//! viewer reaches none of the three (`http::viewer::DENIED_FOR_VIEWER`).

#[cfg(test)]
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::nodes::ScratchFolderScope;
#[cfg(test)]
use crate::zipfile::dos_time;
use crate::zipfile::{name_fits as zip_name_fits, ZipOut};

/// The most one uploaded file may hold (user ruling 2026-11-14: 2 GiB a file).
pub const UPLOAD_MAX: u64 = 2 * 1024 * 1024 * 1024;
/// Entries of a folder in one answer, when the window names no number, and at most.
const PAGE: usize = 200;
const PAGE_MAX: usize = 500;
/// How an upload that has not finished is named: `.<id>.orgtree-part`, beside its target.
const PART: &str = ".orgtree-part";
/// Bytes read from a file at a time, for a download and for a zip.
const CHUNK: usize = 64 * 1024;

const BAD_PATH: &str = "That path is not inside the folder.";
const MISSING: &str = "That file or folder is not there.";
const LINK: &str = "That is a link to somewhere else, which is not followed.";
const NO_FOLDER: &str = "That folder does not exist yet.";
const NOT_A_FOLDER: &str = "That is a file, not a folder.";
const BAD_NAME: &str = "That name cannot be used for a file.";
const EXISTS: &str = "A file of that name is already there.";
const FOLDER_IN_THE_WAY: &str = "A folder of that name is already there.";
const TOO_LARGE: &str = "That file is larger than 2 GiB, the most one upload may hold.";
const CUT: &str = "The upload stopped before the whole file arrived.";

/// Why a request is refused: the status and the sentence.
type Refused<T> = Result<T, (StatusCode, &'static str)>;

#[nolog]
fn api(refusal: (StatusCode, &'static str)) -> ApiError {
    ApiError::new(refusal.0, refusal.1)
}

#[derive(Clone, Copy, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Conflict {
    /// Refuse when a file of that name is there: the window asks its user.
    #[default]
    Ask,
    Replace,
    KeepBoth,
}

#[derive(Deserialize, Debug, Default)]
pub struct FilesQuery {
    #[serde(default)]
    scope: ScratchFolderScope,
    #[serde(default)]
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    name: Option<String>,
    #[serde(default)]
    conflict: Conflict,
}

// ------------------------------------------------------------------ inside the folder

/// A plain name: one part of a path, which names nothing but an entry of its folder.
#[nolog]
pub(crate) fn plain(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name.len() <= 255
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// A name a file may be uploaded under: plain, with nothing Windows would change or reserve,
/// and not the name of an upload in progress.
#[nolog]
pub(crate) fn upload_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    plain(name) && !reserved && !name.ends_with('.') && !name.ends_with(' ') && !name.starts_with(' ') && !name.ends_with(PART)
}

/// A symbolic link, a junction, or any other reparse point: something that is not what is
/// stored in its folder. `metadata` must be the entry's own (`symlink_metadata`).
#[nolog]
pub(crate) fn is_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// The entry `path` names inside `root` (resolved already), resolved. See the module's head.
#[nolog]
fn confine(root: &FsPath, path: &str) -> Refused<PathBuf> {
    let mut at = root.to_path_buf();
    for part in path.split(['/', '\\']).filter(|part| !part.is_empty()) {
        if !plain(part) {
            return Err((StatusCode::BAD_REQUEST, BAD_PATH));
        }
        at.push(part);
        let metadata = std::fs::symlink_metadata(&at).map_err(|_| (StatusCode::NOT_FOUND, MISSING))?;
        if is_link(&metadata) {
            return Err((StatusCode::FORBIDDEN, LINK));
        }
    }
    let resolved = std::fs::canonicalize(&at).map_err(|_| (StatusCode::NOT_FOUND, MISSING))?;
    if !resolved.starts_with(root) {
        return Err((StatusCode::FORBIDDEN, LINK));
    }
    Ok(resolved)
}

/// The folder `path` names inside `root`.
#[nolog]
fn confine_folder(root: &FsPath, path: &str) -> Refused<PathBuf> {
    let folder = confine(root, path)?;
    if !folder.is_dir() {
        return Err((StatusCode::BAD_REQUEST, NOT_A_FOLDER));
    }
    Ok(folder)
}

/// `folder`, resolved, when it is a folder of the organization's own: it lies in `within` (the
/// organization's scratch folders, themselves in `data_root`) as it is written, and neither it
/// nor anything above it down from the data folder is a link. Nothing is made: a folder that is
/// not there is not there. (Review F-1, 2026-11-14: an agent's folder is a path stored with the
/// agent; resolving it alone would have followed a junction standing in its place. The team's
/// and the shared folder had this walk from `shared_notes::ensure` already.)
#[nolog]
pub(crate) fn unlinked_root(data_root: &FsPath, within: &FsPath, folder: &FsPath) -> Refused<PathBuf> {
    use std::path::Component;
    let (data, within, folder) = (crate::config::strip_verbatim(data_root), crate::config::strip_verbatim(within), crate::config::strip_verbatim(folder));
    let inside = |child: &FsPath, parent: &FsPath| crate::domain::scope::path_within(&child.to_string_lossy(), &parent.to_string_lossy());
    let stepping = folder.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir));
    if stepping || !inside(&within, &data) || !inside(&folder, &within) {
        return Err((StatusCode::FORBIDDEN, OUTSIDE));
    }
    let mut at = std::fs::canonicalize(&data).map_err(|_| (StatusCode::NOT_FOUND, NO_FOLDER))?;
    for part in folder.components().skip(data.components().count()) {
        let Component::Normal(name) = part else { return Err((StatusCode::FORBIDDEN, OUTSIDE)) };
        at.push(name);
        let metadata = std::fs::symlink_metadata(&at).map_err(|_| (StatusCode::NOT_FOUND, NO_FOLDER))?;
        if is_link(&metadata) {
            return Err((StatusCode::FORBIDDEN, LINK));
        }
        if !metadata.is_dir() {
            return Err((StatusCode::NOT_FOUND, NO_FOLDER));
        }
    }
    // no link on the way, so this is the same place, written as the system writes it
    std::fs::canonicalize(&at).map_err(|_| (StatusCode::NOT_FOUND, NO_FOLDER))
}

/// Remove the parts of uploads that never ended, under `scratch` (every organization's scratch
/// folders), when they are older than `older_than`: an engine stopped hard in the middle of an
/// upload cannot remove its own (review F-5, 2026-11-14). Only a file named as an upload names
/// its part goes; no link is followed. The answer is how many went.
#[nolog]
pub fn sweep_stale_parts(scratch: &FsPath, older_than: std::time::Duration, now: std::time::SystemTime) -> usize {
    let mut gone = 0;
    let mut todo = vec![scratch.to_path_buf()];
    while let Some(folder) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&folder) else { continue };
        for entry in read.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else { continue };
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                todo.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let old = metadata.modified().ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age > older_than);
            if name.starts_with(".up") && name.ends_with(PART) && old && std::fs::remove_file(&path).is_ok() {
                gone += 1;
            }
        }
    }
    gone
}

/// How old a part must be to be swept at the engine's start.
pub const STALE_PART: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

const OUTSIDE: &str = "That folder is not among this organization's scratch folders.";
const UNREADABLE: &str = "That folder could not be read just now.";

/// The scratch folder the request is about, resolved. A personal scratch folder that was
/// never made is not made here (as `nodes::scratch_folder` makes none). Whatever the scope,
/// the folder is one of the organization's own and no link stands in its place or above it
/// (`unlinked_root`).
#[nolog]
async fn root(engine: &Arc<Engine>, slug: &str, nid: &str, scope: ScratchFolderScope) -> ApiResult<PathBuf> {
    let folder = super::nodes::scratch_root(engine, slug, nid, scope).await?;
    let within = engine.cfg.scratch_root(&crate::http::orgs::org(engine, slug)?.slug);
    unlinked_root(&engine.cfg.data_root, &within, &folder).map_err(api)
}

// ------------------------------------------------------------------ a folder's entries

#[nolog]
fn hidden(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(PART)
}

#[nolog]
fn millis(metadata: &std::fs::Metadata) -> Option<u64> {
    let since = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// One page of `folder`: its folders first, then its files, each by name. An upload in
/// progress is not listed. `kind` is `folder`, `file` or `link`; a link has no size.
#[nolog]
fn listing(folder: &FsPath, offset: usize, limit: usize) -> Refused<Value> {
    let read = std::fs::read_dir(folder).map_err(|_| (StatusCode::NOT_FOUND, MISSING))?;
    let mut entries: Vec<(u8, String, String, Value)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if hidden(&name) {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else { continue };
        let (rank, kind) = if is_link(&metadata) { (1, "link") } else if metadata.is_dir() { (0, "folder") } else { (1, "file") };
        let bytes = if kind == "file" { json!(metadata.len()) } else { Value::Null };
        entries.push((rank, name.to_lowercase(), name.clone(), json!({ "name": name, "kind": kind, "bytes": bytes, "modified": millis(&metadata) })));
    }
    entries.sort_by(|a, b| (a.0, &a.1, &a.2).cmp(&(b.0, &b.1, &b.2)));
    let total = entries.len();
    let page: Vec<Value> = entries.into_iter().skip(offset).take(limit).map(|entry| entry.3).collect();
    let next = offset + page.len();
    Ok(json!({ "entries": page, "total": total, "next": if next < total { json!(next) } else { Value::Null } }))
}

/// `GET /api/orgs/{slug}/nodes/{nid}/scratch-files?scope=&path=&offset=&limit=`
#[nolog]
pub async fn list(State(engine): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Query(q): Query<FilesQuery>) -> ApiResult<Json<Value>> {
    let root = root(&engine, &slug, &nid, q.scope).await?;
    let (offset, limit) = (q.offset.unwrap_or(0), q.limit.unwrap_or(PAGE).clamp(1, PAGE_MAX));
    let path = q.path;
    let page = tokio::task::spawn_blocking(move || confine_folder(&root, &path).and_then(|folder| listing(&folder, offset, limit)))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(api)?;
    Ok(Json(page))
}

// ------------------------------------------------------------------ a folder as a zip

/// `folder` and everything stored in it as a zip, written to `sink` as it is made. Entries
/// are named from `prefix` (the folder's own name; empty for none), by name, a folder before
/// what is in it. A link is left out and so is an upload in progress. A file that cannot be
/// opened is left out and named in `_not-included.txt` at the end of the zip.
#[nolog]
fn zip_tree(folder: &FsPath, prefix: &str, sink: &mut dyn FnMut(Vec<u8>) -> bool) -> std::io::Result<()> {
    let mut zip = ZipOut::new(sink);
    let mut left_out: Vec<String> = Vec::new();
    let mut todo: Vec<(PathBuf, String)> = vec![(folder.to_path_buf(), prefix.to_string())];
    if !prefix.is_empty() && !zip.folder(prefix, std::fs::metadata(folder).ok().and_then(|m| m.modified().ok())) {
        return Ok(());
    }
    while let Some((at, named)) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&at) else {
            left_out.push(format!("{named}/ (the folder could not be read)"));
            continue;
        };
        let mut entries: Vec<(String, PathBuf, std::fs::Metadata)> = read
            .flatten()
            .filter_map(|entry| Some((entry.file_name().to_string_lossy().to_string(), entry.path(), std::fs::symlink_metadata(entry.path()).ok()?)))
            .filter(|(name, _, metadata)| !hidden(name) && !is_link(metadata))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut folders = Vec::new();
        for (name, path, metadata) in entries {
            let named = if named.is_empty() { name } else { format!("{named}/{name}") };
            let modified = metadata.modified().ok();
            if !zip_name_fits(&named, metadata.is_dir()) {
                // nothing below a folder of such a name could be named either
                let shown: String = named.chars().take(200).collect();
                left_out.push(format!("{shown}... (its path is too long for a zip)"));
                continue;
            }
            if metadata.is_dir() {
                if !zip.folder(&named, modified) {
                    return Ok(());
                }
                folders.push((path, named));
            } else {
                match std::fs::File::open(&path) {
                    Ok(mut file) => {
                        if !zip.file(&named, modified, &mut file)? {
                            return Ok(());
                        }
                    }
                    Err(_) => left_out.push(named),
                }
            }
        }
        // the stack is taken from its end: push in reverse, so folders come by name
        todo.extend(folders.into_iter().rev());
    }
    if !left_out.is_empty() {
        let note = format!("These could not be read when the zip was made, and are not in it:\r\n\r\n{}\r\n", left_out.join("\r\n"));
        if !zip.file("_not-included.txt", Some(std::time::SystemTime::now()), &mut note.as_bytes())? {
            return Ok(());
        }
    }
    zip.finish();
    Ok(())
}

// ------------------------------------------------------------------ downloading

/// `Content-Disposition` for a download named `name`: a plain-ASCII form and the real one.
#[nolog]
pub(crate) fn disposition(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' { c } else { '_' }).collect();
    let exact = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{exact}")
}

/// The name a download of the folder itself gets (a zip is named after what it holds).
#[nolog]
fn folder_label(nid: &str, scope: ScratchFolderScope) -> String {
    match scope {
        ScratchFolderScope::Shared => "shared".to_string(),
        ScratchFolderScope::Team => format!("{nid}-team"),
        ScratchFolderScope::Agent => nid.to_string(),
    }
}

/// `GET /api/orgs/{slug}/nodes/{nid}/scratch-files/file?scope=&path=`: a file as it is, with
/// its length; a folder as a zip, whose length nobody knows before it ends.
#[nolog]
pub async fn download(State(engine): State<Arc<Engine>>, Path((slug, nid)): Path<(String, String)>, Query(q): Query<FilesQuery>) -> ApiResult<Response> {
    let root = root(&engine, &slug, &nid, q.scope).await?;
    let path = q.path.clone();
    let target = tokio::task::spawn_blocking(move || confine(&root, &path)).await.map_err(|error| ApiError::internal(error.to_string()))?.map_err(api)?;
    let inner = q.path.split(['/', '\\']).filter(|part| !part.is_empty()).next_back().map(str::to_string);
    if target.is_dir() {
        let name = format!("{}.zip", inner.clone().unwrap_or_else(|| folder_label(&nid, q.scope)));
        let prefix = inner.unwrap_or_default();
        let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(8);
        tokio::task::spawn_blocking(move || {
            let mut sink = |bytes: Vec<u8>| tx.blocking_send(Ok(Bytes::from(bytes))).is_ok();
            if let Err(error) = zip_tree(&target, &prefix, &mut sink) {
                let _ = tx.blocking_send(Err(error));
            }
        });
        let body = Body::from_stream(futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }));
        return Ok((
            [
                (header::CONTENT_TYPE, "application/zip".to_string()),
                (header::CONTENT_DISPOSITION, disposition(&name)),
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
            body,
        )
            .into_response());
    }
    let file = tokio::fs::File::open(&target).await.map_err(|_| ApiError::conflict("That file cannot be read right now."))?;
    let length = file.metadata().await.map_err(|error| ApiError::internal(error.to_string()))?.len();
    let name = inner.unwrap_or_else(|| "file".to_string());
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, length.to_string()),
            (header::CONTENT_DISPOSITION, disposition(&name)),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::with_capacity(file, CHUNK)),
    )
        .into_response())
}

// ------------------------------------------------------------------ uploading

/// The temporary file of an upload: taken away when the upload does not end well.
struct Part(Option<PathBuf>);

impl Drop for Part {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// `name` with ` (n)` before its extension: `notes (2).txt`.
#[nolog]
fn numbered(name: &str, n: u32) -> String {
    match name.rfind('.').filter(|dot| *dot > 0) {
        Some(dot) => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        None => format!("{name} ({n})"),
    }
}

/// What is in the way of a file named `name` in `folder`: nothing, or why it cannot go there.
/// Keep both is never in anybody's way: it takes another name (`place`). A folder that cannot
/// be looked at is not taken for an empty one.
#[nolog]
fn in_the_way(folder: &FsPath, name: &str, conflict: Conflict) -> Refused<()> {
    if conflict == Conflict::KeepBoth {
        return Ok(());
    }
    let metadata = match std::fs::symlink_metadata(folder.join(name)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err((StatusCode::CONFLICT, UNREADABLE)),
    };
    if is_link(&metadata) {
        return Err((StatusCode::FORBIDDEN, LINK));
    }
    if metadata.is_dir() {
        return Err((StatusCode::CONFLICT, FOLDER_IN_THE_WAY));
    }
    match conflict {
        Conflict::Ask => Err((StatusCode::CONFLICT, EXISTS)),
        Conflict::Replace | Conflict::KeepBoth => Ok(()),
    }
}

/// Whether `dest` could not be taken because something has that name.
#[nolog]
fn taken(error: &std::io::Error, dest: &FsPath) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists || std::fs::symlink_metadata(dest).is_ok()
}

/// Give `part` the name `dest` only if nothing has that name: never in the place of a file,
/// also when another upload takes the name at the same moment. A second name for the same
/// file is made, which the system refuses when the name is taken, and the part's own name is
/// removed. Where the disk knows no second names, the name is first taken with an empty file
/// (made only if it is not there), and the part then moves onto its own placeholder.
#[nolog]
fn put_new(part: &FsPath, dest: &FsPath) -> std::io::Result<()> {
    match std::fs::hard_link(part, dest) {
        Ok(()) => {
            // the caller's guard removes the part if this does not
            let _ = std::fs::remove_file(part);
            Ok(())
        }
        Err(error) if taken(&error, dest) => Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, error)),
        Err(_) => {
            std::fs::OpenOptions::new().write(true).create_new(true).open(dest)?;
            std::fs::rename(part, dest).inspect_err(|_| {
                let _ = std::fs::remove_file(dest);
            })
        }
    }
}

/// Give the finished upload `part` its name in `folder`, and say which name that was. Only
/// Replace takes the place of a file. Asked, a name that is taken is refused, also one taken
/// since the upload began. Keep both takes the first name nothing has: `name`, then `name (2)`
/// and so on, past files, folders and links alike (review F-2, 2026-11-14).
#[nolog]
fn place(folder: &FsPath, part: &FsPath, name: &str, conflict: Conflict) -> Refused<String> {
    const FAILED: (StatusCode, &str) = (StatusCode::INTERNAL_SERVER_ERROR, "The file could not be given its name.");
    match conflict {
        Conflict::Replace => {
            in_the_way(folder, name, conflict)?;
            std::fs::rename(part, folder.join(name)).map_err(|_| (StatusCode::CONFLICT, "The file that is there is in use and could not be replaced."))?;
            Ok(name.to_string())
        }
        Conflict::Ask => {
            in_the_way(folder, name, conflict)?;
            let dest = folder.join(name);
            match put_new(part, &dest) {
                Ok(()) => Ok(name.to_string()),
                // taken between the look and the move
                Err(error) if taken(&error, &dest) => Err(in_the_way(folder, name, conflict).err().unwrap_or((StatusCode::CONFLICT, EXISTS))),
                Err(_) => Err(FAILED),
            }
        }
        Conflict::KeepBoth => {
            for n in 1..=9999u32 {
                let named = if n == 1 { name.to_string() } else { numbered(name, n) };
                let dest = folder.join(&named);
                match put_new(part, &dest) {
                    Ok(()) => return Ok(named),
                    Err(error) if taken(&error, &dest) => continue,
                    Err(_) => return Err(FAILED),
                }
            }
            Err((StatusCode::CONFLICT, EXISTS))
        }
    }
}

/// `PUT /api/orgs/{slug}/nodes/{nid}/scratch-files/upload?scope=&path=&name=&conflict=`: the
/// body is the file. It is written beside its target under a temporary name as it arrives
/// and renamed at the end, so an upload that breaks leaves what was there whole. `conflict`:
/// `ask` (the default) refuses with 409 when a file of that name is there, `replace` takes
/// its place, `keep_both` adds a number to the new one. The answer names the file.
#[nolog]
pub async fn upload(
    State(engine): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Query(q): Query<FilesQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    let name = q.name.clone().filter(|name| upload_name(name)).ok_or_else(|| ApiError::bad_request(BAD_NAME))?;
    let announced = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if announced.is_some_and(|length| length > UPLOAD_MAX) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, TOO_LARGE));
    }
    let root = root(&engine, &slug, &nid, q.scope).await?;
    let (path, conflict) = (q.path.clone(), q.conflict);
    let folder = {
        let name = name.clone();
        tokio::task::spawn_blocking(move || {
            let folder = confine_folder(&root, &path)?;
            // before a byte is taken: the window need not send a file that has nowhere to go
            in_the_way(&folder, &name, conflict)?;
            Ok(folder)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(api)?
    };
    let part = folder.join(format!(".{}{PART}", crate::util::uid("up")));
    // declared before the file, so the file is closed before the guard removes it
    let mut guard = Part(Some(part.clone()));
    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await.map_err(|error| ApiError::internal(error.to_string()))?;
    let mut total = 0u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ApiError::bad_request(CUT))?;
        total += chunk.len() as u64;
        if total > UPLOAD_MAX {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, TOO_LARGE));
        }
        file.write_all(&chunk).await.map_err(write_failed)?;
    }
    if announced.is_some_and(|length| length != total) {
        return Err(ApiError::bad_request(CUT));
    }
    file.flush().await.map_err(write_failed)?;
    drop(file);
    let named = tokio::task::spawn_blocking(move || place(&folder, &part, &name, conflict))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(api)?;
    guard.0 = None;
    Ok(Json(json!({ "name": named, "bytes": total })))
}

#[nolog]
pub(crate) fn write_failed(error: std::io::Error) -> ApiError {
    // 112: ERROR_DISK_FULL; 28: ENOSPC
    if matches!(error.raw_os_error(), Some(112) | Some(28)) {
        ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "The disk of that computer is full.")
    } else {
        ApiError::internal(error.to_string())
    }
}

#[cfg(test)]
#[path = "scratch_files_tests.rs"]
mod tests;
