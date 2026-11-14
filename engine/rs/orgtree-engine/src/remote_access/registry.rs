//! What a hosting desktop decided about remote access, and who it let in:
//! `<data>/remote-access.json` (docs/rust-engine/remote-org.md, "A desktop as host").
//!
//! Everything about remote access is in this one file, and nothing of it is
//! in a database: which organizations other computers may open (the switch of
//! each), the door's port and where it listens (Tailscale, the private network,
//! this computer itself),
//! the computers, and the one-time codes. So the door knows all of it before
//! any database is read, and an organization that is restored, copied or made
//! from a template never comes up shared.
//!
//! A **computer** holds its own token for the organizations it was given. An
//! **invitation** is a one-time code for one organization: it makes one
//! computer and is gone. Tokens and codes are kept as SHA-256 hashes only, so
//! what was shown once cannot be read back from the file.
//!
//! One lock admits a token and commits every change, so a connection is never
//! registered after its record was removed (the standalone registry's rule,
//! `client_tokens.rs`). Organizations are named by their uuid: renaming one
//! moves nobody's access.

use std::collections::HashMap;
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

use super::lifecycle::Listen;
use super::text;

pub const FILE: &str = "remote-access.json";
const FILE_VERSION: u8 = 1;
const MAX_FILE: u64 = 1024 * 1024;

/// The door's port unless the owner chose another (the standalone engine's is
/// 7430, the phone door's 7371).
pub const DEFAULT_PORT: u16 = 7431;
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
    fn has(&self, org: &str) -> bool {
        self.orgs.iter().any(|o| o == org)
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

/// The file.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    #[serde(default = "default_port")]
    port: u16,
    /// Does the door listen on this private network?
    #[serde(default)]
    lan: bool,
    /// Does it listen on Tailscale? Written only when the owner chose not to: a file from
    /// before the choice existed reads as yes, and an engine from before it can still read
    /// a file that says nothing new.
    #[serde(default = "yes", skip_serializing_if = "is_yes")]
    tailscale: bool,
    /// Does it listen on this computer itself (127.0.0.1), for a tunnel or a local proxy?
    #[serde(default, skip_serializing_if = "is_no")]
    local: bool,
    /// The organizations other computers may open: the switch of each, by uuid.
    #[serde(default)]
    open: Vec<String>,
    clients: Vec<Computer>,
    invitations: Vec<Invitation>,
}

#[nolog]
fn default_port() -> u16 {
    DEFAULT_PORT
}

#[nolog]
fn yes() -> bool {
    true
}

#[nolog]
fn is_yes(value: &bool) -> bool {
    *value
}

#[nolog]
fn is_no(value: &bool) -> bool {
    !*value
}

impl Default for Saved {
    fn default() -> Saved {
        Saved { version: FILE_VERSION, port: DEFAULT_PORT, lan: false, tailscale: true, local: false, open: Vec::new(), clients: Vec::new(), invitations: Vec::new() }
    }
}

/// What this engine knows of a computer since it started.
#[derive(Default)]
struct Presence {
    connections: Vec<Weak<Connection>>,
    /// When the first of its open connections came in; meaningful while one is open.
    since: Option<DateTime<Utc>>,
    /// Its last admitted request.
    seen: Option<DateTime<Utc>>,
}

#[nolog]
impl Presence {
    fn connected(&self) -> bool {
        self.connections.iter().any(|weak| weak.upgrade().is_some_and(|connection| !connection.closed()))
    }
    fn close(&self) {
        for connection in self.connections.iter().filter_map(Weak::upgrade) {
            connection.close();
        }
    }
}

#[derive(Default)]
struct State {
    saved: Saved,
    live: HashMap<String, Presence>,
}

#[nolog]
impl State {
    /// The row the owner's list and the computer itself are shown.
    fn row(&self, record: &Computer) -> Value {
        let presence = self.live.get(&record.id);
        let connected = presence.is_some_and(Presence::connected);
        json!({
            "id": record.id, "name": record.name, "label": record.origin().name, "scope": "member",
            "orgs": record.orgs, "created_at": record.created_at, "connected": connected,
            "connected_since": presence.and_then(|p| p.since).filter(|_| connected).map(crate::util::iso),
            "last_seen_at": presence.and_then(|p| p.seen).map(crate::util::iso).or_else(|| record.last_seen_at.clone()),
        })
    }
    fn computers_of(&self, org: &str) -> usize {
        self.saved.clients.iter().filter(|record| record.has(org)).count()
    }
    /// End every connection of the computers that have `org`.
    fn close_org(&self, org: &str) -> usize {
        let mut closed = 0;
        for record in self.saved.clients.iter().filter(|record| record.has(org)) {
            if let Some(presence) = self.live.get(&record.id) {
                presence.close();
            }
            closed += 1;
        }
        closed
    }
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
    /// Read the file. One that cannot be read as a registry lets nobody in and shares nothing:
    /// it is moved aside (kept for whoever looks into it) and the registry starts empty.
    pub fn open(root: &Path) -> Registry {
        let path = root.join(FILE);
        let saved = match read(&path) {
            Ok(saved) => saved,
            Err(reason) => {
                let aside = root.join(format!("remote-access.broken-{}.json", Utc::now().format("%Y%m%dT%H%M%S")));
                let moved = std::fs::rename(&path, &aside).is_ok();
                tracing::error!(reason = %reason, kept = moved, "the remote access registry could not be read; nothing is shared and no computer is let in until it is set up again");
                Saved::default()
            }
        };
        Registry { path, state: Mutex::new(State { saved, live: HashMap::new() }) }
    }

    // ------------------------------------------------------------ the switches and where the door listens

    /// May other computers open this organization now?
    pub fn is_open(&self, org: &str) -> bool {
        self.state.lock().map(|state| state.saved.open.iter().any(|o| o == org)).unwrap_or(false)
    }

    /// The organizations whose switch is on.
    pub fn open_orgs(&self) -> Vec<String> {
        self.state.lock().map(|state| state.saved.open.clone()).unwrap_or_default()
    }

    /// The switch of one organization; answers whether it changed. Turning it off ends every
    /// connection of the computers that have the organization, at once, and takes back the codes
    /// that are open for it. The computers' records stay, so turning it on again restores them.
    pub fn set_open(&self, org: &str, on: bool) -> Result<bool, ApiError> {
        if !valid_org(org) {
            return Err(ApiError::bad_request("remote access is switched for one organization"));
        }
        let mut state = self.lock()?;
        if state.saved.open.iter().any(|o| o == org) == on {
            return Ok(false);
        }
        let mut next = state.saved.clone();
        if on {
            next.open.push(org.to_string());
        } else {
            next.open.retain(|o| o != org);
            next.invitations.retain(|invitation| invitation.org != org);
        }
        self.commit(&mut state, next)?;
        if !on {
            let closed = state.close_org(org);
            tracing::info!(computers = closed, "remote access: an organization was closed to other computers");
        }
        Ok(true)
    }

    /// Every switch off: nothing is shared any more and every connection ends. The computers'
    /// records stay. Answers the organizations that were open.
    pub fn stop_all(&self) -> Result<Vec<String>, ApiError> {
        let mut state = self.lock()?;
        let were = state.saved.open.clone();
        if were.is_empty() && state.saved.invitations.is_empty() {
            return Ok(were);
        }
        let mut next = state.saved.clone();
        next.open.clear();
        next.invitations.clear();
        self.commit(&mut state, next)?;
        for presence in state.live.values() {
            presence.close();
        }
        tracing::info!(organizations = were.len(), "remote access: all of it was stopped");
        Ok(were)
    }

    /// End every connection every computer has open. Their records and the switches stay: for
    /// when the door moved, so everyone comes back through where it stands now.
    pub fn close_all(&self) {
        if let Ok(state) = self.state.lock() {
            for presence in state.live.values() {
                presence.close();
            }
        }
    }

    /// The door's port, and whether it also listens on this private network.
    pub fn listening(&self) -> (u16, bool) {
        self.state.lock().map(|state| (state.saved.port, state.saved.lan)).unwrap_or((DEFAULT_PORT, false))
    }

    /// Where the owner lets the door listen.
    pub fn listen(&self) -> Listen {
        self.state.lock().map(|state| Listen { tailscale: state.saved.tailscale, lan: state.saved.lan, local: state.saved.local }).unwrap_or_default()
    }

    /// Change where the door listens; answers whether anything changed. A choice of nowhere
    /// is refused.
    pub fn set_listen(&self, tailscale: Option<bool>, lan: Option<bool>, local: Option<bool>) -> Result<bool, ApiError> {
        let mut state = self.lock()?;
        let mut next = state.saved.clone();
        next.tailscale = tailscale.unwrap_or(next.tailscale);
        next.lan = lan.unwrap_or(next.lan);
        next.local = local.unwrap_or(next.local);
        if !(next.tailscale || next.lan || next.local) {
            return Err(ApiError::bad_request(text::NOWHERE_CHOSEN));
        }
        if (next.tailscale, next.lan, next.local) == (state.saved.tailscale, state.saved.lan, state.saved.local) {
            return Ok(false);
        }
        self.commit(&mut state, next)?;
        Ok(true)
    }

    /// Change the port, the private-network choice, or both; answers whether anything changed.
    pub fn set_listening(&self, port: Option<u16>, lan: Option<bool>) -> Result<bool, ApiError> {
        if port.is_some_and(|port| port < 1024) {
            return Err(ApiError::bad_request(text::PORT_RANGE));
        }
        let mut state = self.lock()?;
        let mut next = state.saved.clone();
        next.port = port.unwrap_or(next.port);
        next.lan = lan.unwrap_or(next.lan);
        if (next.port, next.lan) == (state.saved.port, state.saved.lan) {
            return Ok(false);
        }
        self.commit(&mut state, next)?;
        Ok(true)
    }

    // ------------------------------------------------------------ tokens at the door

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
        if let Some(record) = state.saved.clients.iter().find(|record| constant_eq(record.hash.as_bytes(), hash.as_bytes())).cloned() {
            if connection.closed() {
                return None;
            }
            let presence = state.live.entry(record.id.clone()).or_default();
            presence.connections.retain(|weak| weak.strong_count() != 0);
            // the first open connection after none starts "connected since"
            if !presence.connected() {
                presence.since = Some(now);
            }
            presence.seen = Some(now);
            if !presence.connections.iter().any(|weak| weak.upgrade().is_some_and(|old| Arc::ptr_eq(&old, connection))) {
                presence.connections.push(Arc::downgrade(connection));
            }
            return Some(Admitted::Member { origin: record.origin(), client_id: record.id, orgs: record.orgs });
        }
        let invitation = state.saved.invitations.iter().find(|invitation| constant_eq(invitation.hash.as_bytes(), hash.as_bytes()))?;
        (!invitation.expired(now)).then(|| Admitted::Invitation { org: invitation.org.clone() })
    }

    // ------------------------------------------------------------ codes

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
        let mut next = state.saved.clone();
        next.invitations.retain(|invitation| !invitation.expired(now));
        if next.invitations.iter().filter(|invitation| invitation.org == org).count() >= MAX_INVITATIONS {
            return Err(ApiError::conflict(text::TOO_MANY_CODES));
        }
        if state.computers_of(org) >= MAX_COMPUTERS {
            return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
        }
        let code = new_code();
        let invitation = Invitation { id: uuid::Uuid::new_v4().to_string(), hash: hash(&code), org: org.to_string(),
            created_at: now.to_rfc3339(), expires_at: (now + Duration::minutes(INVITATION_MINUTES)).to_rfc3339() };
        next.invitations.push(invitation.clone());
        self.commit(&mut state, next)?;
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
        let Some(invitation) = state.saved.invitations.iter().find(|invitation| constant_eq(invitation.hash.as_bytes(), hash_of_code.as_bytes())).cloned() else {
            return Ok(None);
        };
        if invitation.expired(now) {
            return Ok(None);
        }
        if state.computers_of(&invitation.org) >= MAX_COMPUTERS {
            return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
        }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let record = Computer { id: uuid::Uuid::new_v4().to_string(), name: name.to_string(), label: None, orgs: vec![invitation.org.clone()],
            hash: hash(&token), created_at: now.to_rfc3339(), last_seen_at: None };
        // the code goes with the same write that makes the computer: it never makes a second one
        let mut next = state.saved.clone();
        next.invitations.retain(|other| other.id != invitation.id && !other.expired(now));
        next.clients.push(record.clone());
        self.commit(&mut state, next)?;
        let mut row = state.row(&record);
        row["token"] = json!(token);
        tracing::info!(client_id = %record.id, "remote access computer added");
        Ok(Some(row))
    }

    /// Take a code back before it was used; answers the organization it was for.
    pub fn withdraw(&self, invitation_id: &str) -> Result<Option<String>, ApiError> {
        let mut state = self.lock()?;
        let Some(org) = state.saved.invitations.iter().find(|invitation| invitation.id == invitation_id).map(|invitation| invitation.org.clone()) else {
            return Ok(None);
        };
        let mut next = state.saved.clone();
        next.invitations.retain(|invitation| invitation.id != invitation_id);
        self.commit(&mut state, next)?;
        Ok(Some(org))
    }

    /// The codes still open for `org`: `{"id", "created_at", "expires_at"}`, never the code.
    pub fn invitations(&self, org: &str) -> Vec<Value> {
        let now = Utc::now();
        let Ok(state) = self.state.lock() else { return Vec::new() };
        state.saved.invitations.iter().filter(|invitation| invitation.org == org && !invitation.expired(now))
            .map(|invitation| json!({ "id": invitation.id, "created_at": invitation.created_at, "expires_at": invitation.expires_at })).collect()
    }

    // ------------------------------------------------------------ computers

    /// Give a computer that is already let in another organization. No code is needed: the
    /// owner picks it from the computers it knows.
    pub fn give(&self, client_id: &str, org: &str) -> Result<Value, ApiError> {
        if !valid_org(org) {
            return Err(ApiError::bad_request("a computer is given one organization"));
        }
        let mut state = self.lock()?;
        let Some(at) = state.saved.clients.iter().position(|record| record.id == client_id) else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        if !state.saved.clients[at].has(org) {
            if state.computers_of(org) >= MAX_COMPUTERS {
                return Err(ApiError::conflict(text::TOO_MANY_COMPUTERS));
            }
            let mut next = state.saved.clone();
            next.clients[at].orgs.push(org.to_string());
            self.commit(&mut state, next)?;
            tracing::info!(client_id = %client_id, "remote access computer given another organization");
        }
        Ok(state.row(&state.saved.clients[at]))
    }

    /// Take a computer's access away: its record goes and every connection it has open ends
    /// at once, the one that asked too. Answers the row it had.
    pub fn revoke(&self, client_id: &str) -> Result<Value, ApiError> {
        let mut state = self.lock()?;
        let Some(record) = state.saved.clients.iter().find(|record| record.id == client_id).cloned() else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        let row = state.row(&record);
        let mut next = state.saved.clone();
        next.clients.retain(|other| other.id != client_id);
        self.commit(&mut state, next)?;
        if let Some(presence) = state.live.remove(client_id) {
            presence.close();
        }
        tracing::info!(client_id = %client_id, "remote access computer revoked; connections dropped");
        Ok(row)
    }

    /// The organization is gone: nobody has it any more, no code is for it and its switch is
    /// off. A computer that has nothing left is removed.
    pub fn forget_org(&self, org: &str) -> Result<(), ApiError> {
        let mut state = self.lock()?;
        let touched = state.saved.clients.iter().any(|record| record.has(org))
            || state.saved.invitations.iter().any(|invitation| invitation.org == org) || state.saved.open.iter().any(|o| o == org);
        if !touched {
            return Ok(());
        }
        let mut next = state.saved.clone();
        next.open.retain(|o| o != org);
        next.invitations.retain(|invitation| invitation.org != org);
        for record in next.clients.iter_mut() {
            record.orgs.retain(|o| o != org);
        }
        next.clients.retain(|record| !record.orgs.is_empty());
        // the connections of whoever had it end with the write, by what was true before it
        let had: Vec<String> = state.saved.clients.iter().filter(|record| record.has(org)).map(|record| record.id.clone()).collect();
        self.commit(&mut state, next)?;
        for id in &had {
            if let Some(presence) = state.live.get(id) {
                presence.close();
            }
        }
        let kept: Vec<String> = state.saved.clients.iter().map(|record| record.id.clone()).collect();
        state.live.retain(|id, _| kept.contains(id));
        Ok(())
    }

    /// Set or clear (`None`) what other people see for one computer.
    pub fn set_label(&self, client_id: &str, label: Option<&str>) -> Result<Value, ApiError> {
        let label = match label.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => Some(caller::label(text).ok_or_else(|| ApiError::bad_request("label must have 1 to 40 characters, without control characters"))?),
            None => None,
        };
        let mut state = self.lock()?;
        let Some(at) = state.saved.clients.iter().position(|record| record.id == client_id) else {
            return Err(ApiError::not_found(text::NO_COMPUTER));
        };
        if state.saved.clients[at].label != label {
            let mut next = state.saved.clone();
            next.clients[at].label = label;
            self.commit(&mut state, next)?;
        }
        Ok(state.row(&state.saved.clients[at]))
    }

    /// One computer's row.
    pub fn row(&self, client_id: &str) -> Option<Value> {
        let state = self.state.lock().ok()?;
        state.saved.clients.iter().find(|record| record.id == client_id).map(|record| state.row(record))
    }

    /// The computers that have `org`, or all of them.
    pub fn rows(&self, org: Option<&str>) -> Vec<Value> {
        let Ok(state) = self.state.lock() else { return Vec::new() };
        state.saved.clients.iter().filter(|record| org.is_none_or(|org| record.has(org))).map(|record| state.row(record)).collect()
    }

    /// Is there no computer, no code and no switch that is on?
    pub fn is_empty(&self) -> bool {
        self.state.lock().map(|state| state.saved.clients.is_empty() && state.saved.invitations.is_empty() && state.saved.open.is_empty()).unwrap_or(true)
    }

    /// Write "last seen" when it moved on by more than a few minutes, and drop codes whose time
    /// is over. Called from the door's own tick, never per request.
    pub fn tidy(&self) {
        let now = Utc::now();
        let Ok(mut state) = self.state.lock() else { return };
        let stale = state.saved.clients.iter().any(|record| {
            let seen = state.live.get(&record.id).and_then(|presence| presence.seen);
            let written = record.last_seen_at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).map(|at| at.with_timezone(&Utc));
            match (seen, written) {
                (Some(seen), Some(written)) => seen - written >= Duration::minutes(SEEN_FLUSH_MINUTES),
                (Some(_), None) => true,
                (None, _) => false,
            }
        });
        if !stale && !state.saved.invitations.iter().any(|invitation| invitation.expired(now)) {
            return;
        }
        let mut next = state.saved.clone();
        next.invitations.retain(|invitation| !invitation.expired(now));
        let _ = self.commit(&mut state, next);
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, ApiError> {
        self.state.lock().map_err(|_| ApiError::unavailable("the remote access registry is unavailable"))
    }

    /// Write `next` and make it what holds. Nothing changes when the write fails: the file and
    /// what the door goes by never differ. Every write carries the newest "last seen".
    fn commit(&self, state: &mut State, mut next: Saved) -> Result<(), ApiError> {
        for record in next.clients.iter_mut() {
            if let Some(seen) = state.live.get(&record.id).and_then(|presence| presence.seen) {
                record.last_seen_at = Some(crate::util::iso(seen));
            }
        }
        self.write(&next)?;
        state.saved = next;
        Ok(())
    }

    /// Replace the file in one step: a reader sees the old registry or the new one.
    fn write(&self, saved: &Saved) -> Result<(), ApiError> {
        let failed = |error: std::io::Error| {
            tracing::warn!(error = %error, "the remote access registry could not be written");
            ApiError::internal("could not save the remote access registry")
        };
        let bytes = serde_json::to_vec(saved).map_err(|error| failed(std::io::Error::other(error)))?;
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

/// The registry in the file at `path`; an absent file is an empty registry. The file is taken
/// as a whole or not at all.
#[nolog]
fn read(path: &Path) -> Result<Saved, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Saved::default()),
        Err(error) => return Err(format!("cannot read it: {error}")),
    };
    if file.metadata().map_err(|error| format!("cannot read it: {error}"))?.len() > MAX_FILE {
        return Err("it is too large".into());
    }
    let mut saved: Saved = serde_json::from_reader(file).map_err(|error| format!("it is not a registry: {error}"))?;
    if saved.version != FILE_VERSION {
        return Err(format!("version {} is not one this engine reads", saved.version));
    }
    if saved.port < 1024 {
        return Err("its port is not one the door may use".into());
    }
    if !saved.open.iter().enumerate().all(|(at, org)| valid_org(org) && !saved.open[..at].contains(org)) {
        return Err("its list of shared organizations is not valid".into());
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
    saved.invitations.retain(|invitation| !invitation.expired(now));
    Ok(saved)
}
