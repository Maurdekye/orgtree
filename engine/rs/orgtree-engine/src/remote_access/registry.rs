//! Who a hosting desktop let in: `<data>/remote-access.json`
//! (docs/rust-engine/remote-org.md, "A desktop as host").
//!
//! Two kinds of record. A **computer** holds its own token for the
//! organizations it was given. An **invitation** is a one-time code for one
//! organization: it makes one computer and is gone. Tokens and codes are kept
//! as SHA-256 hashes only, so what was shown once cannot be read back from the
//! file.
//!
//! One lock admits a token and commits every change, so a connection is never
//! registered after its record was removed (the standalone registry's rule,
//! `client_tokens.rs`). Organizations are named by their uuid: renaming one
//! moves nobody's access.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::caller::{self, Origin};
use crate::client_tokens::transport::Connection;
use crate::client_tokens::{constant_eq, hash, valid_name};
use crate::http::error::ApiError;

use super::text;

pub const FILE: &str = "remote-access.json";
pub const DEFAULT_PORT: u16 = 7431;
const FILE_VERSION: u8 = 1;
const MAX_FILE: u64 = 1024 * 1024;

/// Computers one organization may have.
pub const MAX_COMPUTERS: usize = 32;
/// Codes one organization may have open at a time.
pub const MAX_INVITATIONS: usize = 5;
/// How long a code is valid, in minutes.
pub const INVITATION_MINUTES: i64 = 15;
/// The length of a code, in characters.
pub const CODE_LENGTH: usize = 26;
/// Crockford's base 32: no I, L, O or U, so a code read aloud is not misheard.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// `last_seen_at` is written when it is this much newer than the file says.
const SEEN_FLUSH_MINUTES: i64 = 5;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Computer {
    id: String,
    /// What the computer called itself when it came in ("Orgtree desktop (PC2)").
    name: String,
    /// What other people see for it (`caller::label`); absent until someone chooses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    /// The organizations it was given, by uuid.
    orgs: Vec<String>,
    hash: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_seen_at: Option<String>,
}

#[nolog]
impl Computer {
    fn origin(&self) -> Origin {
        Origin::client(&self.id, &self.name, self.label.as_deref())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Invitation {
    id: String,
    hash: String,
    /// The organization it lets one computer into, by uuid.
    org: String,
    created_at: String,
    expires_at: String,
}

#[nolog]
impl Invitation {
    fn expired(&self, now: DateTime<Utc>) -> bool {
        DateTime::parse_from_rfc3339(&self.expires_at).map(|at| at.with_timezone(&Utc) <= now).unwrap_or(true)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    clients: Vec<Computer>,
    invitations: Vec<Invitation>,
}

struct Live {
    record: Computer,
    connections: Vec<Weak<Connection>>,
    /// When the first of its open connections came in; meaningful while one is open.
    since: Option<DateTime<Utc>>,
    /// Its last admitted request since this engine started.
    seen: Option<DateTime<Utc>>,
}

#[nolog]
impl Live {
    fn new(record: Computer) -> Live {
        Live { record, connections: Vec::new(), since: None, seen: None }
    }
    fn connected(&self) -> bool {
        self.connections.iter().any(|weak| weak.upgrade().is_some_and(|connection| !connection.closed()))
    }
    fn last_seen(&self) -> Option<String> {
        self.seen.map(crate::util::iso).or_else(|| self.record.last_seen_at.clone())
    }
    /// The row the owner's list and the computer itself are shown.
    fn row(&self) -> Value {
        let connected = self.connected();
        json!({
            "id": self.record.id, "name": self.record.name, "label": self.record.origin().name, "scope": "member",
            "orgs": self.record.orgs, "created_at": self.record.created_at, "connected": connected,
            "connected_since": self.since.filter(|_| connected).map(crate::util::iso), "last_seen_at": self.last_seen(),
        })
    }
    fn close(&self) {
        for connection in self.connections.iter().filter_map(Weak::upgrade) {
            connection.close();
        }
    }
}

#[derive(Default)]
struct State {
    computers: Vec<Live>,
    invitations: Vec<Invitation>,
}

/// What a token presented at the door is.
pub enum Admitted {
    Member { client_id: String, orgs: Vec<String>, origin: Origin },
    Invitation { org: String },
}

pub struct Registry {
    path: PathBuf,
    state: Mutex<State>,
}

#[nolog]
impl Registry {
    /// Read the file. One that cannot be read as a registry lets nobody in: it is moved aside
    /// (kept for whoever looks into it) and the registry starts empty.
    pub fn open(root: &Path) -> Registry {
        let path = root.join(FILE);
        let state = match read(&path) {
            Ok(state) => state,
            Err(reason) => {
                let aside = root.join(format!("remote-access.broken-{}.json", Utc::now().format("%Y%m%dT%H%M%S")));
                let moved = std::fs::rename(&path, &aside).is_ok();
                tracing::error!(reason = %reason, kept = moved, "the remote access registry could not be read; no computer is let in until one is added again");
                State::default()
            }
        };
        Registry { path, state: Mutex::new(state) }
    }

    /// What `token` is, at the door. A computer's connection is remembered so that revoking it
    /// can end it; a code's is not (a code makes one client and is gone).
    pub fn authenticate(&self, token: &str, connection: &Arc<Connection>) -> Option<Admitted> {
        self.authenticate_at(token, connection, Utc::now())
    }

    pub(crate) fn authenticate_at(&self, token: &str, connection: &Arc<Connection>, now: DateTime<Utc>) -> Option<Admitted> {
        if connection.closed() {
            return None;
        }
        let hash = hash(token);
        let mut state = self.state.lock().ok()?;
        if let Some(live) = state.computers.iter_mut().find(|live| constant_eq(live.record.hash.as_bytes(), hash.as_bytes())) {
            if connection.closed() {
                return None;
            }
            live.connections.retain(|weak| weak.strong_count() != 0);
            // the first open connection after none starts "connected since"
            if !live.connected() {
                live.since = Some(now);
            }
            live.seen = Some(now);
            if !live.connections.iter().any(|weak| weak.upgrade().is_some_and(|old| Arc::ptr_eq(&old, connection))) {
                live.connections.push(Arc::downgrade(connection));
            }
            return Some(Admitted::Member { client_id: live.record.id.clone(), orgs: live.record.orgs.clone(), origin: live.record.origin() });
        }
        let invitation = state.invitations.iter().find(|invitation| constant_eq(invitation.hash.as_bytes(), hash.as_bytes()))?;
        (!invitation.expired(now)).then(|| Admitted::Invitation { org: invitation.org.clone() })
    }

    /// A new one-time code for `org`: `{"id", "code", "org", "created_at", "expires_at"}`. The
    /// code is in this answer and nowhere else.
    pub fn invite(&self, org: &str) -> Result<Value, ApiError> {
        self.invite_at(org, Utc::now())
    }

    pub(crate) fn invite_at(&self, org: &str, now: DateTime<Utc>) -> Result<Value, ApiError> {
        if !valid_org(org) {
            return Err(ApiError::bad_request("an invitation names one organization"));
        }
        let mut state = self.lock()?;
        let mut invitations: Vec<Invitation> = state.invitations.iter().filter(|invitation| !invitation.expired(now)).cloned().collect();
        if invitations.iter().filter(|invitation| invitation.org == org).count() >= MAX_INVITATIONS {
            return Err(ApiError::conflict(text::TOO_MANY_CODES));
        }
        if state.computers.iter().filter(|live| live.record.orgs.iter().any(|o| o == org)).count() >= MAX_COMPUTERS {
            return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
        }
        let code = new_code();
        let invitation = Invitation { id: uuid::Uuid::new_v4().to_string(), hash: hash(&code), org: org.to_string(),
            created_at: now.to_rfc3339(), expires_at: (now + Duration::minutes(INVITATION_MINUTES)).to_rfc3339() };
        invitations.push(invitation.clone());
        self.persist(&state.computers, &invitations)?;
        state.invitations = invitations;
        tracing::info!(invitation = %invitation.id, "remote access code made");
        Ok(json!({ "id": invitation.id, "code": code, "org": invitation.org, "created_at": invitation.created_at, "expires_at": invitation.expires_at }))
    }

    /// Make the one computer a code is for: the code is used up, and the answer carries the
    /// computer's own token, shown once. `None` when the code is not (or no longer) one.
    pub fn redeem(&self, code: &str, name: &str) -> Result<Option<Value>, ApiError> {
        self.redeem_at(code, name, Utc::now())
    }

    pub(crate) fn redeem_at(&self, code: &str, name: &str, now: DateTime<Utc>) -> Result<Option<Value>, ApiError> {
        let name = name.trim();
        if !valid_name(name) {
            return Err(ApiError::bad_request("name must contain 1-100 characters, without control characters"));
        }
        let hash_of_code = hash(code);
        let mut state = self.lock()?;
        let Some(at) = state.invitations.iter().position(|invitation| constant_eq(invitation.hash.as_bytes(), hash_of_code.as_bytes())) else {
            return Ok(None);
        };
        if state.invitations[at].expired(now) {
            return Ok(None);
        }
        let org = state.invitations[at].org.clone();
        if state.computers.iter().filter(|live| live.record.orgs.iter().any(|o| *o == org)).count() >= MAX_COMPUTERS {
            return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let record = Computer { id: uuid::Uuid::new_v4().to_string(), name: name.to_string(), label: None, orgs: vec![org],
            hash: hash(&token), created_at: now.to_rfc3339(), last_seen_at: None };
        // the code goes with the same write that makes the computer: it never makes a second one
        let invitations: Vec<Invitation> = state.invitations.iter().enumerate()
            .filter(|(i, invitation)| *i != at && !invitation.expired(now)).map(|(_, invitation)| invitation.clone()).collect();
        let mut records: Vec<Computer> = state.computers.iter().map(Live::saved).collect();
        records.push(record.clone());
        self.write(&records, &invitations)?;
        state.invitations = invitations;
        let live = Live::new(record);
        let mut row = live.row();
        row["token"] = json!(token);
        tracing::info!(client_id = %live.record.id, "remote access computer added");
        state.computers.push(live);
        Ok(Some(row))
    }

    /// Give a computer that is already let in another organization. No code is needed: the
    /// owner picks it from the computers it knows.
    pub fn give(&self, client_id: &str, org: &str) -> Result<Value, ApiError> {
        if !valid_org(org) {
            return Err(ApiError::bad_request("a computer is given one organization"));
        }
        let mut state = self.lock()?;
        let Some(at) = state.computers.iter().position(|live| live.record.id == client_id) else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        if !state.computers[at].record.orgs.iter().any(|o| o == org) {
            if state.computers.iter().filter(|live| live.record.orgs.iter().any(|o| o == org)).count() >= MAX_COMPUTERS {
                return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
            }
            let mut records: Vec<Computer> = state.computers.iter().map(Live::saved).collect();
            records[at].orgs.push(org.to_string());
            self.write(&records, &state.invitations)?;
            state.computers[at].record.orgs.push(org.to_string());
            tracing::info!(client_id = %client_id, "remote access computer given another organization");
        }
        Ok(state.computers[at].row())
    }

    /// Take a computer's access away: its record goes and every connection it has open ends
    /// at once, the one that asked too. Answers the row it had.
    pub fn revoke(&self, client_id: &str) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        let Some(at) = state.computers.iter().position(|live| live.record.id == client_id) else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        let records: Vec<Computer> = state.computers.iter().enumerate().filter(|(i, _)| *i != at).map(|(_, live)| live.saved()).collect();
        self.write(&records, &state.invitations)?;
        let removed = state.computers.remove(at);
        let row = removed.row();
        removed.close();
        tracing::info!(client_id = %client_id, "remote access computer revoked; connections dropped");
        Ok(row)
    }

    /// The organization is closed to everyone (its switch went off): every connection of every
    /// computer that has it ends. The records stay, so switching it on again restores them.
    pub fn close_org(&self, org: &str) -> usize {
        let Ok(state) = self.state.lock() else { return 0 };
        let mut closed = 0;
        for live in state.computers.iter().filter(|live| live.record.orgs.iter().any(|o| o == org)) {
            live.close();
            closed += 1;
        }
        closed
    }

    /// The organization is gone: nobody has it any more and no code is for it. A computer that
    /// has nothing left is removed.
    pub fn forget_org(&self, org: &str) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        let touched = state.computers.iter().any(|live| live.record.orgs.iter().any(|o| o == org))
            || state.invitations.iter().any(|invitation| invitation.org == org);
        if !touched {
            return Ok(());
        }
        let records: Vec<Computer> = state.computers.iter().map(Live::saved)
            .map(|mut record| { record.orgs.retain(|o| o != org); record }).filter(|record| !record.orgs.is_empty()).collect();
        let invitations: Vec<Invitation> = state.invitations.iter().filter(|invitation| invitation.org != org).cloned().collect();
        self.write(&records, &invitations)?;
        for live in state.computers.iter().filter(|live| live.record.orgs.iter().any(|o| o == org)) {
            live.close();
        }
        for live in state.computers.iter_mut() {
            live.record.orgs.retain(|o| o != org);
        }
        state.computers.retain(|live| !live.record.orgs.is_empty());
        state.invitations = invitations;
        Ok(())
    }

    /// Set or clear (`None`) what other people see for one computer.
    pub fn set_label(&self, client_id: &str, label: Option<&str>) -> Result<Value, ApiError> {
        let label = match label.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => Some(caller::label(text).ok_or_else(|| ApiError::bad_request("label must have 1 to 40 characters, without control characters"))?),
            None => None,
        };
        let mut state = self.lock()?;
        let Some(at) = state.computers.iter().position(|live| live.record.id == client_id) else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        if state.computers[at].record.label != label {
            let mut records: Vec<Computer> = state.computers.iter().map(Live::saved).collect();
            records[at].label = label.clone();
            self.write(&records, &state.invitations)?;
            state.computers[at].record.label = label;
        }
        Ok(state.computers[at].row())
    }

    /// Take a code back before it was used.
    pub fn withdraw(&self, invitation_id: &str) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        let invitations: Vec<Invitation> = state.invitations.iter().filter(|invitation| invitation.id != invitation_id).cloned().collect();
        if invitations.len() != state.invitations.len() {
            self.persist(&state.computers, &invitations)?;
            state.invitations = invitations;
        }
        Ok(())
    }

    /// One computer's row.
    pub fn row(&self, client_id: &str) -> Option<Value> {
        let state = self.state.lock().ok()?;
        state.computers.iter().find(|live| live.record.id == client_id).map(Live::row)
    }

    /// The computers that have `org`, or all of them.
    pub fn rows(&self, org: Option<&str>) -> Vec<Value> {
        let Ok(state) = self.state.lock() else { return Vec::new() };
        state.computers.iter().filter(|live| org.is_none_or(|org| live.record.orgs.iter().any(|o| o == org))).map(Live::row).collect()
    }

    /// The codes still open for `org`: `{"id", "created_at", "expires_at"}`, never the code.
    pub fn invitations(&self, org: &str) -> Vec<Value> {
        let now = Utc::now();
        let Ok(state) = self.state.lock() else { return Vec::new() };
        state.invitations.iter().filter(|invitation| invitation.org == org && !invitation.expired(now))
            .map(|invitation| json!({ "id": invitation.id, "created_at": invitation.created_at, "expires_at": invitation.expires_at })).collect()
    }

    /// Does anyone have a record here at all?
    pub fn is_empty(&self) -> bool {
        self.state.lock().map(|state| state.computers.is_empty() && state.invitations.is_empty()).unwrap_or(true)
    }

    /// Write "last seen" when it moved on by more than a few minutes, and drop codes whose time
    /// is over. Called from the door's own tick, never per request.
    pub fn tidy(&self) {
        let now = Utc::now();
        let Ok(mut state) = self.state.lock() else { return };
        let stale = state.computers.iter().any(|live| match (live.seen, live.record.last_seen_at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok())) {
            (Some(seen), Some(written)) => seen - written.with_timezone(&Utc) >= Duration::minutes(SEEN_FLUSH_MINUTES),
            (Some(_), None) => true,
            (None, _) => false,
        });
        let expired = state.invitations.iter().any(|invitation| invitation.expired(now));
        if !stale && !expired {
            return;
        }
        let invitations: Vec<Invitation> = state.invitations.iter().filter(|invitation| !invitation.expired(now)).cloned().collect();
        if self.persist(&state.computers, &invitations).is_ok() {
            for live in state.computers.iter_mut() {
                live.record.last_seen_at = live.last_seen();
            }
            state.invitations = invitations;
        }
    }

    // NOT BUILT: the shape the tests are written against. The switch is not kept here yet.
    pub fn is_open(&self, _org: &str) -> bool { false }
    pub fn open_orgs(&self) -> Vec<String> { Vec::new() }
    pub fn set_open(&self, _org: &str, _on: bool) -> Result<bool, ApiError> { Err(ApiError::not_implemented("the switch is not kept in the registry")) }
    pub fn listening(&self) -> (u16, bool) { (0, false) }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, ApiError> {
        self.state.lock().map_err(|_| ApiError::unavailable("the remote access registry is unavailable"))
    }

    fn persist(&self, computers: &[Live], invitations: &[Invitation]) -> Result<(), ApiError> {
        let records: Vec<Computer> = computers.iter().map(Live::saved).collect();
        self.write(&records, invitations)
    }

    /// Replace the file in one step: a reader sees the old registry or the new one.
    fn write(&self, records: &[Computer], invitations: &[Invitation]) -> Result<(), ApiError> {
        let failed = |error: std::io::Error| {
            tracing::warn!(error = %error, "the remote access registry could not be written");
            ApiError::internal("could not save the remote access registry")
        };
        let bytes = serde_json::to_vec(&Saved { version: FILE_VERSION, clients: records.to_vec(), invitations: invitations.to_vec() })
            .map_err(|error| failed(std::io::Error::other(error)))?;
        let tmp = self.path.with_file_name(format!(".remote-access-{}.tmp", uuid::Uuid::new_v4().simple()));
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
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result.map_err(failed)
    }
}

#[nolog]
impl Live {
    /// The record as it is written: with the newest "last seen" this engine knows.
    fn saved(&self) -> Computer {
        let mut record = self.record.clone();
        record.last_seen_at = self.last_seen();
        record
    }
}

/// An organization's uuid as a record may hold it.
#[nolog]
fn valid_org(org: &str) -> bool {
    uuid::Uuid::parse_str(org).is_ok()
}

#[nolog]
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[nolog]
fn valid_time(at: &str) -> bool {
    DateTime::parse_from_rfc3339(at).is_ok()
}

/// A one-time code: 26 characters, 130 random bits.
#[nolog]
fn new_code() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| CODE_ALPHABET[(b & 31) as usize] as char).collect()
}

/// The registry in the file at `path`; an absent file is an empty registry.
#[nolog]
fn read(path: &Path) -> Result<State, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
        Err(error) => return Err(format!("cannot read it: {error}")),
    };
    if file.metadata().map_err(|error| format!("cannot read it: {error}"))?.len() > MAX_FILE {
        return Err("it is too large".into());
    }
    let saved: Saved = serde_json::from_reader(file).map_err(|error| format!("it is not a registry: {error}"))?;
    if saved.version != FILE_VERSION {
        return Err(format!("version {} is not one this engine reads", saved.version));
    }
    for (at, record) in saved.clients.iter().enumerate() {
        let known = uuid::Uuid::parse_str(&record.id).is_ok() && valid_name(&record.name) && valid_time(&record.created_at) && valid_hash(&record.hash)
            && record.label.as_deref().is_none_or(|label| caller::label(label).as_deref() == Some(label))
            && record.last_seen_at.as_deref().is_none_or(valid_time)
            && !record.orgs.is_empty() && record.orgs.iter().all(|org| valid_org(org))
            && record.orgs.iter().enumerate().all(|(i, org)| !record.orgs[..i].contains(org))
            && !saved.clients[..at].iter().any(|old| old.id == record.id || old.hash == record.hash);
        if !known {
            return Err("a computer's record is not valid".into());
        }
    }
    for (at, invitation) in saved.invitations.iter().enumerate() {
        let known = uuid::Uuid::parse_str(&invitation.id).is_ok() && valid_hash(&invitation.hash) && valid_org(&invitation.org)
            && valid_time(&invitation.created_at) && valid_time(&invitation.expires_at)
            && !saved.invitations[..at].iter().any(|old| old.id == invitation.id || old.hash == invitation.hash)
            && !saved.clients.iter().any(|record| record.hash == invitation.hash);
        if !known {
            return Err("a code's record is not valid".into());
        }
    }
    let now = Utc::now();
    Ok(State { computers: saved.clients.into_iter().map(Live::new).collect(),
        invitations: saved.invitations.into_iter().filter(|invitation| !invitation.expired(now)).collect() })
}
