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

#![allow(unused_imports, dead_code)]

use std::io::{Read, Write};
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

// ------------------------------------------------------------------ not built yet
//
// The red state: the routes exist and refuse, and nothing below does its work.

#[nolog]
fn upload_name(_name: &str) -> bool {
    false
}

#[nolog]
fn confine(_root: &FsPath, _path: &str) -> Refused<PathBuf> {
    Err((StatusCode::NOT_IMPLEMENTED, MISSING))
}

#[nolog]
fn confine_folder(_root: &FsPath, _path: &str) -> Refused<PathBuf> {
    Err((StatusCode::NOT_IMPLEMENTED, NOT_A_FOLDER))
}

#[nolog]
fn listing(_folder: &FsPath, _offset: usize, _limit: usize) -> Refused<Value> {
    Err((StatusCode::NOT_IMPLEMENTED, MISSING))
}

#[nolog]
fn dos_time(_modified: Option<std::time::SystemTime>) -> (u16, u16) {
    (0, 0)
}

#[nolog]
fn zip_tree(_folder: &FsPath, _prefix: &str, _sink: &mut dyn FnMut(Vec<u8>) -> bool) -> std::io::Result<()> {
    Ok(())
}

#[nolog]
fn disposition(_name: &str) -> String {
    String::new()
}

#[nolog]
fn folder_label(_nid: &str, _scope: ScratchFolderScope) -> String {
    String::new()
}

struct Part(Option<PathBuf>);

#[nolog]
fn numbered(_name: &str, _n: u32) -> String {
    String::new()
}

#[nolog]
fn in_the_way(_folder: &FsPath, _name: &str, _conflict: Conflict) -> Refused<()> {
    Err((StatusCode::NOT_IMPLEMENTED, BAD_NAME))
}

#[nolog]
fn place(_folder: &FsPath, _part: &FsPath, _name: &str, _conflict: Conflict) -> Refused<String> {
    Err((StatusCode::NOT_IMPLEMENTED, BAD_NAME))
}

#[nolog]
pub async fn list(State(_engine): State<Arc<Engine>>, Path(_at): Path<(String, String)>, Query(_q): Query<FilesQuery>) -> ApiResult<Json<Value>> {
    Err(ApiError::not_implemented(BAD_PATH))
}

#[nolog]
pub async fn download(State(_engine): State<Arc<Engine>>, Path(_at): Path<(String, String)>, Query(_q): Query<FilesQuery>) -> ApiResult<Response> {
    Err(ApiError::not_implemented(LINK))
}

#[nolog]
pub async fn upload(State(_engine): State<Arc<Engine>>, Path(_at): Path<(String, String)>, Query(_q): Query<FilesQuery>, _headers: HeaderMap, _body: Body) -> ApiResult<Json<Value>> {
    Err(ApiError::not_implemented(BAD_NAME))
}

#[cfg(test)]
#[path = "scratch_files_tests.rs"]
mod tests;
