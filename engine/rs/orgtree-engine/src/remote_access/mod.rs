//! A desktop that lets other computers open some of its organizations
//! (docs/rust-engine/remote-org.md, "A desktop as host").
//!
//! - `door`: the second listener, apart from the loopback one the app uses.
//! - `registry`: `<data>/remote-access.json`, everything the owner decided:
//!   the switch of each organization, the port, the computers that were let
//!   in and the one-time codes.
//! - `member`: the route table of a computer that was let in.
//! - `limiter`: refused tokens, counted per address.
//! - `lifecycle`: where the door stands and when.
//! - `api`: the owner's routes, for this desktop's own app alone.
//! - `admit` (here): the door's guard. Every request that came in through the
//!   door passes it before anything else of the engine sees the request.
//!
//! What holds, and where it is held:
//!
//! - The app's own token means nothing at the door, and a door token means
//!   nothing on the app's listener. `admit` never compares with the desktop
//!   token; the app's listener never reads `Authorization` (`http::guarded`).
//! - A member's API calls reach the organizations it was given, while their
//!   switch is on, and no app-wide write (`member::verdict`, fail-closed).
//!   That is workspace scoping: a member is trusted with the hosting computer
//!   as an SSH sign-in is (user rulings 2026-11-14).
//! - The door serves `/api/` and nothing else: no page, no language-server
//!   proxy, no credential bridge.
//! - A request from the door is never carried on to another engine
//!   (`http::guarded` asks the relay for nothing when the connection is the
//!   door's): a hosting desktop is no way into the engines it is connected to.

pub mod api;
pub mod door;
pub mod firewall;
pub mod lifecycle;
pub mod limiter;
pub mod member;
pub mod registry;
pub mod shown;
pub mod text;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::caller::Origin;
use crate::client_tokens::transport::Connection;
use crate::client_tokens::Scope;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use member::{Standing, Verdict};
use registry::{Admitted, Registry};

/// What a hosting desktop knows about who may come in.
pub struct RemoteAccess {
    pub registry: Registry,
    /// Refused tokens, counted per address (`limiter.rs`).
    pub limiter: limiter::Limiter,
    /// Where the door stands now (`lifecycle.rs`).
    pub doors: lifecycle::Doors,
    /// The door's Windows Firewall rules, as they were last read (`firewall.rs`).
    pub firewall: firewall::Firewall,
}

#[nolog]
impl RemoteAccess {
    pub fn open(root: &Path) -> RemoteAccess {
        RemoteAccess { registry: Registry::open(root), limiter: limiter::Limiter::default(), doors: lifecycle::Doors::default(),
                       firewall: firewall::Firewall::default() }
    }

    /// May other computers open this organization now?
    pub fn is_open(&self, org_uuid: &str) -> bool {
        self.registry.is_open(org_uuid)
    }

    /// Is any organization's switch on?
    pub fn any_open(&self) -> bool {
        !self.registry.open_orgs().is_empty()
    }

    /// The switch of one organization (`Registry::set_open`). Turning it off ends every
    /// connection of the computers that have it, at once; their records stay.
    pub fn set_open(&self, org_uuid: &str, on: bool) -> ApiResult<()> {
        self.registry.set_open(org_uuid, on).map(|_| ())
    }
}

/// Write down, in an organization's own history, something that happened to who may open it
/// from another computer: `what` is `on`, `off`, `code`, `code_withdrawn`, `computer_added`,
/// `computer_given` or `computer_revoked`. `via` is who did it (the owner's own desktop, or the
/// computer itself). The record is written beside the change, not with it: the registry is a
/// file, and a database that is away for a moment must not keep the owner from switching
/// remote access off.
#[nolog]
pub fn record(engine: &Arc<Engine>, org_uuid: &str, what: &str, computer: Option<&Value>, via: Option<Value>) {
    let Some(org) = engine.orgs.all().into_iter().find(|org| org.uuid == org_uuid) else { return };
    let mut detail = json!({ "what": what });
    if let Some(computer) = computer {
        detail["computer"] = json!({ "id": computer["id"], "name": computer["name"], "label": computer["label"] });
    }
    let (engine, what) = (engine.clone(), what.to_string());
    tokio::spawn(async move {
        let written = async {
            let client = engine.db.get().await?;
            client.execute("INSERT INTO ot.events (org_id, op, actor, detail, via) VALUES ($1, 'remote_access', '@user', $2, $3)", &[&org.id, &detail, &via]).await?;
            anyhow::Ok(())
        }.await;
        if let Err(error) = written {
            tracing::warn!(org = %org.slug, what = %what, error = %format!("{error:#}"), "a remote access change could not be written into the organization's history");
        }
    });
}

/// An organization was deleted: it is shared with nobody from now on. The computers' records
/// stay as they are, so an organization that is restored is not shared until its owner says so
/// again.
#[nolog]
pub fn org_deleted(engine: &Engine, org_uuid: &str) {
    if let Err(error) = engine.access.registry.set_open(org_uuid, false) {
        tracing::warn!(error = %error.detail, "remote access of a deleted organization could not be switched off");
    }
}

/// The organizations a computer that was let in may open now: the ones it was given whose
/// switch is on. Nothing for a computer that is not known (any more).
#[nolog]
pub fn visible(engine: &Engine, client_id: &str) -> Vec<Arc<crate::orgs::OrgHandle>> {
    let Some(row) = engine.access.registry.row(client_id) else { return Vec::new() };
    let given: Vec<&str> = row["orgs"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    engine.orgs.all().into_iter().filter(|org| given.contains(&org.uuid.as_str()) && engine.access.is_open(&org.uuid)).collect()
}

/// The name a hosting desktop is called by in what it says to others: the computer's.
#[nolog]
pub fn host_name(engine: &Engine) -> String {
    engine.remotes.computer().to_string()
}

/// The token of a request at the door: `Authorization: Bearer`, and no other place.
#[nolog]
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values.next()?.to_str().ok()?;
    // two Authorization headers are nobody's honest request
    if values.next().is_some() {
        return None;
    }
    value.strip_prefix("Bearer ").filter(|token| !token.is_empty() && token.len() <= 512)
}

#[nolog]
fn refusal(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

#[nolog]
fn token_required() -> Response {
    refusal(StatusCode::FORBIDDEN, json!({ "detail": text::TOKEN_REQUIRED }))
}

/// The door's guard. `Ok` is a request that may go on, with who it came through (`None` for a
/// one-time code and for the app media route, which act as nobody); the request then carries its
/// `Scope`. `Err` is the answer to give instead.
///
/// In order: only the API; never a page; the app media route by its own ticket; then the token,
/// and what that token may do.
#[nolog]
pub fn admit(engine: &Engine, req: &mut Request, connection: &Arc<Connection>) -> Result<Option<Origin>, Response> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    // An address that was refused too often is answered nothing else for a minute, except to
    // a token the door knows (a computer's, or a one-time code). Behind a tunnel or a proxy
    // every caller has one address, 127.0.0.1, and behind a shared router too: somebody's
    // guessing must not lock out the computers that were let in. It costs nothing against a
    // guess: a token is 256 random bits and a code 130.
    let peer = connection.peer.ip();
    if engine.access.limiter.blocked(peer) {
        let known = req.headers().get(header::ORIGIN).is_none()
            && bearer(req.headers()).is_some_and(|token| engine.access.registry.authenticate(token, connection).is_some());
        if !known {
            return Err(refusal(StatusCode::TOO_MANY_REQUESTS, json!({ "detail": text::TOO_MANY_TRIES })));
        }
    }
    // A request that shows no token the door knows is counted by its address (`limiter.rs`).
    let token_required = || {
        if engine.access.limiter.strike(peer) {
            tracing::warn!(peer = %peer, "remote access: too many refused requests from one address; it is answered 429 for a while");
        }
        token_required()
    };
    // The app's own token and its windows' remote-engine header mean nothing here: neither is
    // read, and neither travels on to a handler.
    req.headers_mut().remove(crate::http::TOKEN_HEADER);
    req.headers_mut().remove(crate::remote::HEADER);
    if !path.starts_with("/api/") {
        return Err(refusal(StatusCode::NOT_FOUND, json!({ "detail": "not found" })));
    }
    let ticket = crate::http::app_files::ticket_route(&path, &method);
    // A page is never a caller. The engines that connect send no Origin; a browser always does
    // on a request a page makes across origins. The one exception is the sandboxed frame of an
    // app panel fetching media by its ticket, whose origin is the word `null`.
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        if !(ticket && origin.as_bytes() == b"null") {
            tracing::info!("{}", member::log_line("-", &method, &path, "refused (a page)"));
            return Err(token_required());
        }
    }
    let token = bearer(req.headers()).map(str::to_string);
    if ticket && token.is_none() {
        // The app media route carries its own ticket instead of a token (the relay sends it
        // none): the handler checks the ticket's grant on every request. Here only this much:
        // the organization must be one other computers may open at all.
        let open = crate::remote::routes::org_of(&path).and_then(|(slug, _)| engine.orgs.get(slug)).is_some_and(|org| engine.access.is_open(&org.uuid));
        return if open { Ok(None) } else { Err(token_required()) };
    }
    let Some(token) = token else {
        return Err(token_required());
    };
    match engine.access.registry.authenticate(&token, connection) {
        None => Err(token_required()),
        Some(Admitted::Invitation { org }) => {
            // a code for an organization that was switched off meanwhile opens nothing
            if !engine.access.is_open(&org) {
                return Err(token_required());
            }
            if !member::invitation_allows(&method, &path) {
                tracing::info!("{}", member::log_line("code", &method, &path, "refused"));
                return Err(refusal(StatusCode::FORBIDDEN, json!({ "detail": text::e17(&host_name(engine)), "code": text::E17 })));
            }
            req.extensions_mut().insert(Scope::Invitation { org });
            Ok(None)
        }
        Some(Admitted::Member { client_id, orgs, origin }) => {
            let standing = |slug: &str| match engine.orgs.get(slug) {
                Some(org) if orgs.contains(&org.uuid) => if engine.access.is_open(&org.uuid) { Standing::Open } else { Standing::Shut },
                _ => Standing::Foreign,
            };
            match member::verdict(&method, &path, &client_id, standing) {
                Verdict::Allow => {
                    tracing::debug!("{}", member::log_line(&client_id, &method, &path, "allowed"));
                    req.extensions_mut().insert(Scope::Member { orgs, client_id });
                    Ok(Some(origin))
                }
                Verdict::Shut => {
                    tracing::info!("{}", member::log_line(&client_id, &method, &path, "refused (switched off)"));
                    Err(refusal(StatusCode::FORBIDDEN, json!({ "detail": text::e16(&host_name(engine)), "code": text::E16 })))
                }
                Verdict::Refuse => {
                    tracing::info!("{}", member::log_line(&client_id, &method, &path, "refused"));
                    Err(refusal(StatusCode::FORBIDDEN, json!({ "detail": text::e17(&host_name(engine)), "code": text::E17 })))
                }
            }
        }
    }
}

/// A member's own client record as it reads it: its row, with the organizations it can open
/// now by the names it asks for them, and `you` (who it is to the people it works beside).
#[nolog]
pub fn own_list(engine: &Engine, client_id: &str) -> ApiResult<Value> {
    let row = own_row(engine, client_id)?;
    let mut listed = json!({ "clients": [row] });
    if let Some(origin) = crate::caller::current() {
        listed["you"] = origin.json();
    }
    Ok(listed)
}

/// One computer's row as that computer is shown it: `orgs` are the slugs of the organizations
/// it was given whose switch is on.
#[nolog]
fn own_row(engine: &Engine, client_id: &str) -> ApiResult<Value> {
    let row = engine.access.registry.row(client_id).ok_or_else(|| ApiError::forbidden(text::TOKEN_REQUIRED))?;
    Ok(shown_to_member(engine, row))
}

#[nolog]
fn shown_to_member(engine: &Engine, mut row: Value) -> Value {
    let given: Vec<String> = row["orgs"].as_array().map(|orgs| orgs.iter().filter_map(|org| org.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let slugs: Vec<String> = engine.orgs.all().into_iter()
        .filter(|org| given.contains(&org.uuid) && engine.access.is_open(&org.uuid)).map(|org| org.slug.clone()).collect();
    row["orgs"] = json!(slugs);
    row
}

/// `POST /api/standalone/clients` with a one-time code: the one computer the code is for.
/// The answer carries the computer's own token, shown once.
#[nolog]
pub fn redeem(engine: &Arc<Engine>, headers: &HeaderMap, name: &str) -> ApiResult<Value> {
    let code = bearer(headers).ok_or_else(|| ApiError::forbidden(text::TOKEN_REQUIRED))?;
    match engine.access.registry.redeem(code, name)? {
        Some(row) => {
            // the organization's history says who came in: the new computer itself
            let came = Origin::client(row["id"].as_str().unwrap_or_default(), row["name"].as_str().unwrap_or_default(), None);
            if let Some(org) = row["orgs"][0].as_str() {
                record(engine, org, "computer_added", Some(&row), Some(came.json()));
            }
            Ok(shown_to_member(engine, row))
        }
        // used a moment ago by another request, or run out since the guard looked
        None => Err(ApiError::forbidden(text::CODE_USED)),
    }
}

/// `PATCH /api/standalone/clients/{id}` by the member itself (the route table let only its
/// own id through).
#[nolog]
pub fn set_own_label(engine: &Engine, client_id: &str, label: Option<&str>) -> ApiResult<Value> {
    Ok(shown_to_member(engine, engine.access.registry.set_label(client_id, label)?))
}

/// `DELETE /api/standalone/clients/{id}` by the member itself: its record goes and its
/// connections end, this one too.
#[nolog]
pub fn remove_own(engine: &Arc<Engine>, client_id: &str) -> ApiResult<Value> {
    let row = engine.access.registry.revoke(client_id)?;
    for org in row["orgs"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        record(engine, org, "computer_revoked", Some(&row), crate::caller::via());
    }
    Ok(json!({ "revoked": client_id }))
}
