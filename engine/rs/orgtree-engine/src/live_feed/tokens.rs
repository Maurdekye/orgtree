//! Access tokens for outside programs (spec 3.2). A token binds a connection to one live agent of one org. Mirrors
//! `client_tokens.rs`: random, shown once, persisted as a SHA-256 hash only, revoked at once.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FILE: &str = "live-feed-tokens.json";
const MAX_TOKENS: usize = 128;
const MAX_FILE: u64 = 256 * 1024;
pub const PREFIX: &str = "otf_";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub label: String,
    pub org_id: i64,
    pub agent_id: i64,
    pub created_at: String,
    hash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    tokens: Vec<Record>,
}

pub struct Tokens {
    path: PathBuf,
    rows: Mutex<Vec<Record>>,
    /// token id -> last use (UTC ISO), in memory only
    used: Mutex<HashMap<String, String>>,
}

#[nolog]
impl Tokens {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join(FILE);
        let rows = match std::fs::File::open(&path) {
            Ok(file) => {
                if file.metadata()?.len() > MAX_FILE { bail!("live feed token file is too large"); }
                let saved: Saved = serde_json::from_reader(file).context("invalid live feed token file")?;
                if saved.version != 1 || saved.tokens.len() > MAX_TOKENS { bail!("unsupported or oversized live feed token file"); }
                for (i, r) in saved.tokens.iter().enumerate() {
                    if uuid::Uuid::parse_str(&r.id).is_err() || !valid_label(&r.label) || r.hash.len() != 64
                        || !r.hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        || chrono::DateTime::parse_from_rfc3339(&r.created_at).is_err()
                        || saved.tokens[..i].iter().any(|o| o.id == r.id || o.hash == r.hash) {
                        bail!("invalid live feed token entry");
                    }
                }
                saved.tokens
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).context("cannot read live feed token file"),
        };
        Ok(Self { path, rows: Mutex::new(rows), used: Mutex::new(HashMap::new()) })
    }

    /// The record a token belongs to, noting the use.
    pub fn authenticate(&self, token: &str) -> Option<Record> {
        if !token.starts_with(PREFIX) { return None; }
        let h = hash(token);
        let rows = self.rows.lock().ok()?;
        let r = rows.iter().find(|r| constant_eq(r.hash.as_bytes(), h.as_bytes()))?.clone();
        if let Ok(mut u) = self.used.lock() { u.insert(r.id.clone(), chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)); }
        Some(r)
    }

    /// Does this token id still exist?
    pub fn exists(&self, id: &str) -> bool {
        self.rows.lock().map(|r| r.iter().any(|r| r.id == id)).unwrap_or(false)
    }

    pub fn create(&self, label: &str, org_id: i64, agent_id: i64) -> Result<(Record, String)> {
        let label = label.trim();
        if !valid_label(label) { bail!("label must contain 1-100 characters, without control characters"); }
        let mut rows = self.rows.lock().map_err(|_| anyhow::anyhow!("token list unavailable"))?;
        if rows.len() >= MAX_TOKENS { bail!("at most 128 live feed tokens are allowed"); }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = format!("{PREFIX}{}", base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes));
        let record = Record { id: uuid::Uuid::new_v4().to_string(), label: label.into(), org_id, agent_id,
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true), hash: hash(&token) };
        let mut next = rows.clone();
        next.push(record.clone());
        self.persist(&next).context("could not save the token")?;
        *rows = next;
        Ok((record, token))
    }

    /// Remove a token; true if it existed.
    pub fn revoke(&self, id: &str) -> Result<bool> {
        let mut rows = self.rows.lock().map_err(|_| anyhow::anyhow!("token list unavailable"))?;
        let Some(i) = rows.iter().position(|r| r.id == id) else { return Ok(false) };
        let mut next = rows.clone();
        next.remove(i);
        self.persist(&next).context("could not save the revocation")?;
        *rows = next;
        Ok(true)
    }

    /// Public rows (never the hash); agent names are filled in by the caller.
    pub fn list(&self) -> Vec<Record> {
        self.rows.lock().map(|r| r.clone()).unwrap_or_default()
    }

    pub fn last_used(&self, id: &str) -> Option<String> {
        self.used.lock().ok().and_then(|u| u.get(id).cloned())
    }

    fn persist(&self, rows: &[Record]) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&json!({"version": 1, "tokens": rows}))?;
        let tmp = self.path.with_file_name(format!(".live-feed-tokens-{}.tmp", uuid::Uuid::new_v4().simple()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            crate::client_tokens::replace(&tmp, &self.path)
        })();
        if result.is_err() { let _ = std::fs::remove_file(&tmp); }
        result
    }
}

#[nolog]
pub fn public(r: &Record, agent_name: &str, org_slug: &str, last_used: Option<String>) -> Value {
    json!({"id": r.id, "label": r.label, "org": org_slug, "agent": agent_name, "created_at": r.created_at, "last_used": last_used})
}

#[nolog]
fn valid_label(s: &str) -> bool {
    !s.trim().is_empty() && s.chars().count() <= 100 && !s.chars().any(char::is_control)
}
#[nolog]
fn hash(token: &str) -> String { hex::encode(Sha256::digest(token.as_bytes())) }
#[nolog]
pub fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |n, (a, b)| n | (a ^ b)) == 0
}
