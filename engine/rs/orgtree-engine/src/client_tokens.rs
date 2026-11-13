//! Standalone user clients. The bootstrap key is independent; named keys are
//! random, shown once, persisted as hashes and revoked with their TCP sockets.

pub mod transport;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::caller::{self, Origin};
use crate::http::error::ApiError;
use transport::Connection;

const FILE: &str = "standalone-clients.json";
const MAX_CLIENTS: usize = 128;
const MAX_FILE: u64 = 128 * 1024;

const FILE_VERSION: u8 = 2;
/// The version of a file in which some client has a label. A file without
/// labels is still written as version 2, which older engines read.
const LABEL_VERSION: u8 = 3;

/// What a named client token may do. `Viewer` is read-only for one org
/// (`http/viewer.rs` lists its routes). The bootstrap key is always `Full`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Full,
    Viewer { org: String, client_id: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    name: String,
    created_at: String,
    hash: String,
    /// `"full"` (version 1 files have none) or `"viewer"`.
    #[serde(default = "full_scope")]
    scope: String,
    /// The org slug of a viewer token; absent for a full one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    org: Option<String>,
    /// What other people see for this client (`caller::label`); absent until
    /// someone chooses one, and the client then goes by `caller::default_label`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[nolog]
fn full_scope() -> String { "full".into() }

#[nolog]
impl Record {
    fn scope(&self) -> Scope {
        match &self.org {
            Some(org) if self.scope == "viewer" => Scope::Viewer { org: org.clone(), client_id: self.id.clone() },
            _ => Scope::Full,
        }
    }
    /// `full` carries no org; `viewer` carries a plain org slug.
    fn scope_valid(&self) -> bool {
        match (self.scope.as_str(), &self.org) {
            ("full", None) => true,
            ("viewer", Some(org)) => valid_org(org),
            _ => false,
        }
    }
    /// Where a request made with this client's token came through.
    fn origin(&self) -> Origin {
        Origin::client(&self.id, &self.name, self.label.as_deref())
    }
}

#[nolog]
fn valid_org(org: &str) -> bool {
    !org.is_empty() && org.chars().count() <= 100 && !org.chars().any(|c| c.is_control() || c == '/')
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    clients: Vec<Record>,
}

struct Client {
    record: Record,
    connections: Vec<Weak<Connection>>,
    /// When the first of its open connections authenticated. Meaningful only
    /// while one is open (`connected`).
    since: Option<DateTime<Utc>>,
    /// Its last authenticated request since this engine started.
    seen: Option<DateTime<Utc>>,
}

#[nolog]
impl Client {
    fn new(record: Record) -> Client {
        Client { record, connections: Vec::new(), since: None, seen: None }
    }
    /// Does a connection that used this client's token stay open?
    fn connected(&self) -> bool {
        self.connections.iter().any(|weak| weak.upgrade().is_some_and(|connection| !connection.closed()))
    }
    /// The list row: the record, and whether its computer is connected now.
    fn row(&self) -> Value {
        let mut row = public(&self.record);
        let connected = self.connected();
        row["connected"] = json!(connected);
        row["connected_since"] = json!(self.since.filter(|_| connected).map(crate::util::iso));
        row["last_seen_at"] = json!(self.seen.map(crate::util::iso));
        row
    }
}

pub struct Registry {
    path: PathBuf,
    clients: Mutex<Vec<Client>>,
}

#[nolog]
impl Registry {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join(FILE);
        let records = match std::fs::File::open(&path) {
            Ok(file) => {
                if file.metadata()?.len() > MAX_FILE { bail!("standalone client registry is too large"); }
                let saved: Saved = serde_json::from_reader(file).context("invalid standalone client registry")?;
                if !(saved.version == 1 || saved.version == FILE_VERSION || saved.version == LABEL_VERSION) || saved.clients.len() > MAX_CLIENTS {
                    bail!("unsupported or oversized standalone client registry");
                }
                for (index, row) in saved.clients.iter().enumerate() {
                    if uuid::Uuid::parse_str(&row.id).is_err() || !valid_name(&row.name)
                        || chrono::DateTime::parse_from_rfc3339(&row.created_at).is_err()
                        || !row.scope_valid() || (saved.version == 1 && row.scope != "full")
                        || row.label.as_deref().is_some_and(|label| saved.version != LABEL_VERSION || caller::label(label).as_deref() != Some(label))
                        || row.hash.len() != 64 || !row.hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        || saved.clients[..index].iter().any(|old| old.id == row.id || old.hash == row.hash) {
                        bail!("invalid standalone client registry entry");
                    }
                }
                saved.clients
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("cannot read standalone client registry"),
        };
        Ok(Self { path, clients: Mutex::new(records.into_iter().map(Client::new).collect()) })
    }

    /// The same lock admits authentication and commits revocation. A socket
    /// cannot be registered after its credential has been removed. Answers
    /// what the token may do and whose it is.
    pub fn authenticate(&self, token: &str, connection: &Arc<Connection>) -> Option<(Scope, Origin)> {
        if connection.closed() { return None; }
        let hash = hash(token);
        let Ok(mut clients) = self.clients.lock() else { return None; };
        let client = clients.iter_mut().find(|client| constant_eq(client.record.hash.as_bytes(), hash.as_bytes()))?;
        if connection.closed() { return None; }
        client.connections.retain(|weak| weak.strong_count() != 0);
        let now = Utc::now();
        // the first open connection after none starts "connected since"
        if !client.connected() { client.since = Some(now); }
        client.seen = Some(now);
        if !client.connections.iter().any(|weak| weak.upgrade().is_some_and(|old| Arc::ptr_eq(&old, connection))) {
            client.connections.push(Arc::downgrade(connection));
        }
        Some((client.record.scope(), client.record.origin()))
    }

    /// Set or clear (`None`) what other people see for one client. Not part of
    /// `manage`: the user's MCP tool does not offer it.
    pub fn set_label(&self, id: &str, label: Option<&str>) -> Result<Value, ApiError> {
        let label = match label.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => Some(caller::label(text).ok_or_else(|| ApiError::bad_request("label must have 1 to 40 characters, without control characters"))?),
            None => None,
        };
        let mut clients = self.clients.lock().map_err(|_| ApiError::unavailable("client registry unavailable"))?;
        let Some(index) = clients.iter().position(|client| client.record.id == id) else {
            return Err(ApiError::not_found("active client token not found"));
        };
        if clients[index].record.label != label {
            let mut records: Vec<_> = clients.iter().map(|client| client.record.clone()).collect();
            records[index].label = label.clone();
            self.persist(records).map_err(|_| ApiError::internal("could not persist client registry"))?;
            clients[index].record.label = label;
            tracing::info!(client_id = %id, "standalone client label changed");
        }
        Ok(clients[index].row())
    }

    pub fn manage(&self, args: &Value) -> Result<Value, ApiError> {
        let action = match args.get("action") {
            None => "list",
            Some(Value::String(action)) => action.as_str(),
            _ => return Err(ApiError::bad_request("action must be a string")),
        };
        let allowed: &[&str] = match action {
            "list" => &["action"], "create" => &["action", "name", "scope", "org"], "revoke" => &["action", "id"],
            _ => return Err(ApiError::bad_request("action must be list, create or revoke")),
        };
        let object = args.as_object().ok_or_else(|| ApiError::bad_request("arguments must be an object"))?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(ApiError::bad_request("unsupported client-token option for this action"));
        }
        let mut clients = self.clients.lock().map_err(|_| ApiError::unavailable("client registry unavailable"))?;
        if action == "list" {
            return Ok(json!({"clients": clients.iter().map(Client::row).collect::<Vec<_>>()}));
        }
        if action == "create" {
            let name = args["name"].as_str().unwrap_or("").trim();
            if !valid_name(name) { return Err(ApiError::bad_request("name must contain 1-100 characters, without control characters")); }
            let (scope, org) = match (args.get("scope"), args.get("org")) {
                (None | Some(Value::String(_)), None | Some(Value::String(_))) => {
                    let scope = args.get("scope").and_then(Value::as_str).unwrap_or("full");
                    let org = args.get("org").and_then(Value::as_str);
                    match (scope, org) {
                        ("full", None) => ("full", None),
                        ("full", Some(_)) => return Err(ApiError::bad_request("a full client token takes no org")),
                        ("viewer", Some(org)) if valid_org(org) => ("viewer", Some(org.to_string())),
                        ("viewer", _) => return Err(ApiError::bad_request("a viewer client token needs the org's slug")),
                        _ => return Err(ApiError::bad_request("scope must be full or viewer")),
                    }
                }
                _ => return Err(ApiError::bad_request("scope and org must be strings")),
            };
            if clients.len() >= MAX_CLIENTS { return Err(ApiError::conflict("at most 128 active client tokens are allowed")); }
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let token = hex::encode(bytes);
            let record = Record { id: uuid::Uuid::new_v4().to_string(), name: name.into(),
                created_at: chrono::Utc::now().to_rfc3339(), hash: hash(&token), scope: scope.into(), org, label: None };
            let mut records: Vec<_> = clients.iter().map(|client| client.record.clone()).collect();
            records.push(record.clone());
            self.persist(records).map_err(|_| ApiError::internal("could not persist client registry"))?;
            let mut result = public(&record);
            result["token"] = json!(token);
            tracing::info!(client_id = %record.id, "standalone client created");
            clients.push(Client::new(record));
            return Ok(result);
        }
        let id = args["id"].as_str().unwrap_or("");
        let Some(index) = clients.iter().position(|client| client.record.id == id) else {
            return Err(ApiError::not_found("active client token not found (the bootstrap key cannot be revoked)"));
        };
        let records = clients.iter().enumerate().filter(|(i, _)| *i != index).map(|(_, client)| client.record.clone()).collect();
        self.persist(records).map_err(|_| ApiError::internal("could not persist client revocation"))?;
        let removed = clients.remove(index);
        // Includes this call's socket on self-revoke. There is intentionally
        // no promise of an HTTP/MCP acknowledgement after the key is revoked.
        for connection in removed.connections.into_iter().filter_map(|weak| weak.upgrade()) {
            connection.close();
        }
        tracing::info!(client_id = %removed.record.id, "standalone client revoked; connections dropped");
        Ok(json!({"revoked": removed.record.id}))
    }

    fn persist(&self, records: Vec<Record>) -> std::io::Result<()> {
        let version = if records.iter().any(|record| record.label.is_some()) { LABEL_VERSION } else { FILE_VERSION };
        let bytes = serde_json::to_vec(&Saved { version, clients: records })?;
        let tmp = self.path.with_file_name(format!(".standalone-clients-{}.tmp", uuid::Uuid::new_v4().simple()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)] {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            replace(&tmp, &self.path)?;
            #[cfg(unix)]
            if let Some(parent) = self.path.parent() {
                if std::fs::File::open(parent).and_then(|file| file.sync_all()).is_err() {
                    tracing::warn!("client registry replaced, but directory fsync is unavailable");
                }
            }
            Ok(())
        })();
        if result.is_err() { let _ = std::fs::remove_file(tmp); }
        result
    }
}

#[nolog]
fn public(record: &Record) -> Value {
    let mut row = json!({"id":record.id,"name":record.name,"created_at":record.created_at,"scope":record.scope,
        "label":record.origin().name});
    if let Some(org) = &record.org { row["org"] = json!(org); }
    row
}

#[nolog]
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 100 && !name.chars().any(char::is_control)
}

#[nolog]
fn hash(token: &str) -> String { hex::encode(Sha256::digest(token.as_bytes())) }

#[nolog]
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |n, (a, b)| n | (a ^ b)) == 0
}

/// Put `from` in the place of `to` in one step: a reader sees the old file or the new one.
///
/// On Windows a scanner or an indexer opens a file that was just written and holds it for a
/// moment, and the replace is refused while it does. That passes, so the replace is asked again a
/// few times (about a quarter of a second in all) before the change is given up. Every registry
/// kept in a file goes through here (`client_tokens`, `live_feed/tokens`, `remote/store`,
/// `remote_access/registry`).
#[cfg(windows)]
#[nolog]
pub(crate) fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let name = to.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut tried = 0;
    loop {
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if tried >= REPLACE_TRIES {
            return Err(error);
        }
        tried += 1;
        tracing::info!(file = %name, error = %error, tried, "a file could not be replaced yet");
        std::thread::sleep(std::time::Duration::from_millis(15 * tried));
    }
}

/// How often a refused replace is asked again (after 15, 30, 45, 60 and 75 ms).
#[cfg(windows)]
const REPLACE_TRIES: u64 = 5;

#[cfg(not(windows))]
#[nolog]
pub(crate) fn replace(from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }

#[cfg(test)]
mod tests;
