//! Standalone user clients. The bootstrap key is independent; named keys are
//! random, shown once, persisted as hashes and revoked with their TCP sockets.

pub mod transport;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use anyhow::{bail, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::error::ApiError;
use transport::Connection;

const FILE: &str = "standalone-clients.json";
const MAX_CLIENTS: usize = 128;
const MAX_FILE: u64 = 128 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    name: String,
    created_at: String,
    hash: String,
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
                if saved.version != 1 || saved.clients.len() > MAX_CLIENTS {
                    bail!("unsupported or oversized standalone client registry");
                }
                for (index, row) in saved.clients.iter().enumerate() {
                    if uuid::Uuid::parse_str(&row.id).is_err() || !valid_name(&row.name)
                        || chrono::DateTime::parse_from_rfc3339(&row.created_at).is_err()
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
        Ok(Self { path, clients: Mutex::new(records.into_iter().map(|record| Client { record, connections: Vec::new() }).collect()) })
    }

    /// The same lock admits authentication and commits revocation. A socket
    /// cannot be registered after its credential has been removed.
    pub fn authenticate(&self, token: &str, connection: &Arc<Connection>) -> bool {
        if connection.closed() { return false; }
        let hash = hash(token);
        let Ok(mut clients) = self.clients.lock() else { return false; };
        let Some(client) = clients.iter_mut().find(|client| constant_eq(client.record.hash.as_bytes(), hash.as_bytes())) else { return false; };
        if connection.closed() { return false; }
        client.connections.retain(|weak| weak.strong_count() != 0);
        if !client.connections.iter().any(|weak| weak.upgrade().is_some_and(|old| Arc::ptr_eq(&old, connection))) {
            client.connections.push(Arc::downgrade(connection));
        }
        true
    }

    pub fn manage(&self, args: &Value) -> Result<Value, ApiError> {
        let action = match args.get("action") {
            None => "list",
            Some(Value::String(action)) => action.as_str(),
            _ => return Err(ApiError::bad_request("action must be a string")),
        };
        let allowed: &[&str] = match action {
            "list" => &["action"], "create" => &["action", "name"], "revoke" => &["action", "id"],
            _ => return Err(ApiError::bad_request("action must be list, create or revoke")),
        };
        let object = args.as_object().ok_or_else(|| ApiError::bad_request("arguments must be an object"))?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(ApiError::bad_request("unsupported client-token option for this action"));
        }
        let mut clients = self.clients.lock().map_err(|_| ApiError::unavailable("client registry unavailable"))?;
        if action == "list" {
            return Ok(json!({"clients": clients.iter().map(|client| public(&client.record)).collect::<Vec<_>>()}));
        }
        if action == "create" {
            let name = args["name"].as_str().unwrap_or("").trim();
            if !valid_name(name) { return Err(ApiError::bad_request("name must contain 1-100 characters, without control characters")); }
            if clients.len() >= MAX_CLIENTS { return Err(ApiError::conflict("at most 128 active client tokens are allowed")); }
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let token = hex::encode(bytes);
            let record = Record { id: uuid::Uuid::new_v4().to_string(), name: name.into(),
                created_at: chrono::Utc::now().to_rfc3339(), hash: hash(&token) };
            let mut records: Vec<_> = clients.iter().map(|client| client.record.clone()).collect();
            records.push(record.clone());
            self.persist(records).map_err(|_| ApiError::internal("could not persist client registry"))?;
            let mut result = public(&record);
            result["token"] = json!(token);
            tracing::info!(client_id = %record.id, "standalone client created");
            clients.push(Client { record, connections: Vec::new() });
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
        let bytes = serde_json::to_vec(&Saved { version: 1, clients: records })?;
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
    json!({"id":record.id,"name":record.name,"created_at":record.created_at})
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

#[cfg(windows)]
#[nolog]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}

#[cfg(not(windows))]
#[nolog]
fn replace(from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }

#[cfg(test)]
mod tests;
