//! The owner's routes: what this desktop lets other computers open
//! (docs/rust-engine/remote-org.md, "The owner's routes").
//!
//! They are for the desktop's own app and nobody else. That holds three ways:
//! they are below `/api/remote-access`, which is this computer's
//! (`remote/routes.rs` `LOCAL`), so a window of a remote organization is never
//! served another engine's; at the door they are in `member::REFUSED`; and
//! each handler asks `owner` first, which refuses a request that carries any
//! token scope at all (on a desktop's own listener none does).
//!
//! An organization is named by its slug here and must be one of this
//! computer's own: a remote organization cannot be shared on (no chains).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{firewall, lifecycle, record, registry, text};
use crate::client_tokens::Scope;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::orgs::OrgHandle;

/// Only this desktop itself: not a standalone engine (it has client tokens for this), and
/// never a request that came with a token scope (the door's requests all do).
#[nolog]
fn owner(engine: &Engine, scope: &Option<Extension<Scope>>) -> ApiResult<()> {
    if engine.cfg.standalone {
        return Err(ApiError::not_found(text::NOT_A_DESKTOP));
    }
    if scope.is_some() {
        return Err(ApiError::forbidden(text::OWNER_ONLY));
    }
    Ok(())
}

#[nolog]
fn local_org(engine: &Engine, slug: &str) -> ApiResult<Arc<OrgHandle>> {
    engine.orgs.get(slug).ok_or_else(|| ApiError::not_found(format!("no organization {slug} on this computer")))
}

#[nolog]
fn has(row: &Value, org_uuid: &str) -> bool {
    row["orgs"].as_array().is_some_and(|orgs| orgs.iter().any(|org| org == org_uuid))
}

/// A computer's row as the owner's app is shown it: its organizations by their names here.
#[nolog]
fn shown(engine: &Engine, row: &Value) -> Value {
    let mut row = row.clone();
    let slugs: Vec<String> = engine.orgs.all().into_iter().filter(|org| has(&row, &org.uuid)).map(|org| org.slug.clone()).collect();
    row["orgs"] = json!(slugs);
    row
}

/// `GET /api/remote-access`: the port, where the door listens, and every organization of this
/// computer with its switch and how many computers have it.
/// It is also the app value `remote_access` this desktop's own windows are pushed
/// (`lifecycle::publish`): `door` says where the door stands, and each organization who is
/// connected to it now.
#[nolog]
pub(super) fn overview_of(engine: &Engine) -> Value {
    let (port, lan) = engine.access.registry.listening();
    let all = engine.access.registry.rows(None);
    let orgs: Vec<Value> = engine.orgs.all().iter().map(|org| {
        let mine: Vec<&Value> = all.iter().filter(|row| has(row, &org.uuid)).collect();
        let connected: Vec<Value> = mine.iter().filter(|row| row["connected"] == true)
            .map(|row| json!({ "id": row["id"], "label": row["label"], "name": row["name"], "since": row["connected_since"] })).collect();
        json!({ "slug": org.slug, "name": org.name.load_full().as_str(), "on": engine.access.is_open(&org.uuid),
                "computers": mine.len(), "connected": connected.len(), "connected_now": connected })
    }).collect();
    json!({ "computer": super::host_name(engine), "port": port, "default_port": registry::DEFAULT_PORT, "lan": lan, "orgs": orgs,
            "door": lifecycle::status(engine) })
}

/// After a change of the owner's: the door goes where it should stand now, and this desktop's
/// windows are told.
#[nolog]
async fn settled(engine: &Arc<Engine>) {
    lifecycle::refresh(engine).await;
    lifecycle::publish(engine);
    // and the loop looks from now on: who is connected is not a minute old when a switch has just gone on
    engine.access.doors.wake();
}

/// `GET /api/remote-access/orgs/{slug}`: the switch, the computers that have this organization,
/// the computers that are known from another one (they can be given this one without a code),
/// and the codes that are open (never a code itself).
#[nolog]
fn org_view(engine: &Engine, org: &OrgHandle) -> Value {
    let all = engine.access.registry.rows(None);
    let (computers, known): (Vec<&Value>, Vec<&Value>) = all.iter().partition(|row| has(row, &org.uuid));
    json!({
        "slug": org.slug, "on": engine.access.is_open(&org.uuid), "door": lifecycle::status(engine),
        "computers": computers.into_iter().map(|row| shown(engine, row)).collect::<Vec<_>>(),
        "known": known.into_iter().map(|row| shown(engine, row)).collect::<Vec<_>>(),
        "invitations": engine.access.registry.invitations(&org.uuid),
        "limits": { "computers": registry::MAX_COMPUTERS, "invitations": registry::MAX_INVITATIONS, "minutes": registry::INVITATION_MINUTES },
    })
}

/// `?fresh=1` on the two reads: the owner's app has just let the door in (or taken its rules
/// away) and asks what Windows Firewall says now.
#[derive(Deserialize)]
pub struct Look {
    fresh: Option<String>,
}

/// The owner is looking. What is known of the firewall is read again: now, with the answer
/// waiting for it, when the app asks for that; else behind the answer, when it is old.
#[nolog]
async fn looked(engine: &Arc<Engine>, look: &Look) {
    if look.fresh.as_deref() == Some("1") {
        if firewall::read_now(engine).await {
            lifecycle::publish(engine);
        }
    } else {
        firewall::look(engine);
    }
}

#[nolog]
pub async fn overview(State(engine): State<Arc<Engine>>, scope: Option<Extension<Scope>>, Query(look): Query<Look>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    looked(&engine, &look).await;
    Ok(Json(overview_of(&engine)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listening {
    port: Option<u32>,
    lan: Option<bool>,
}

/// `PUT /api/remote-access {"port"?, "lan"?}`: the door's port, and whether it also listens on
/// this private network.
#[nolog]
pub async fn listening(State(engine): State<Arc<Engine>>, scope: Option<Extension<Scope>>, Json(body): Json<Listening>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let port = match body.port {
        Some(port) => Some(u16::try_from(port).ok().filter(|port| *port >= 1024).ok_or_else(|| ApiError::bad_request(text::PORT_RANGE))?),
        None => None,
    };
    if engine.access.registry.set_listening(port, body.lan)? {
        settled(&engine).await;
    }
    Ok(Json(overview_of(&engine)))
}

/// `POST /api/remote-access/stop`: every switch off, every connection ended, every open code
/// taken back. The computers' records stay.
#[nolog]
pub async fn stop(State(engine): State<Arc<Engine>>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    for org in engine.access.registry.stop_all()? {
        record(&engine, &org, "off", None, crate::caller::via());
    }
    settled(&engine).await;
    Ok(Json(overview_of(&engine)))
}

#[nolog]
pub async fn org(State(engine): State<Arc<Engine>>, Path(slug): Path<String>, scope: Option<Extension<Scope>>, Query(look): Query<Look>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let org = local_org(&engine, &slug)?;
    looked(&engine, &look).await;
    let mut view = org_view(&engine, &org);
    if look.fresh.as_deref() == Some("1") {
        // What turning the switch on would be refused with now, or null: the app asks before it
        // asks Windows for anything, so nobody is shown an administrator prompt for nothing.
        let (_, lan) = engine.access.registry.listening();
        view["refusal"] = json!(lifecycle::way_in(&lifecycle::read(&engine).await, lan).err());
    }
    Ok(Json(view))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Switch {
    on: bool,
}

/// `PUT /api/remote-access/orgs/{slug} {"on"}`: let other computers open this organization, or
/// stop letting them.
#[nolog]
pub async fn switch(State(engine): State<Arc<Engine>>, Path(slug): Path<String>, scope: Option<Extension<Scope>>, Json(body): Json<Switch>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let org = local_org(&engine, &slug)?;
    if body.on && !engine.access.is_open(&org.uuid) {
        // a switch that could let nobody in is not turned on: it says why instead
        let (_, lan) = engine.access.registry.listening();
        lifecycle::way_in(&lifecycle::read(&engine).await, lan).map_err(ApiError::conflict)?;
    }
    if engine.access.registry.set_open(&org.uuid, body.on)? {
        record(&engine, &org.uuid, if body.on { "on" } else { "off" }, None, crate::caller::via());
        if body.on {
            // the desktop lets the door in just before it asks for this (one prompt): what the
            // windows are told now is what Windows Firewall says after it
            firewall::read_now(&engine).await;
        }
        settled(&engine).await;
    }
    Ok(Json(org_view(&engine, &org)))
}

/// `POST /api/remote-access/orgs/{slug}/invitations`: a one-time code for one computer. The
/// code is in this answer and nowhere else.
#[nolog]
pub async fn invite(State(engine): State<Arc<Engine>>, Path(slug): Path<String>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let org = local_org(&engine, &slug)?;
    if !engine.access.is_open(&org.uuid) {
        return Err(ApiError::conflict(text::TURN_ON_FIRST));
    }
    let made = engine.access.registry.invite(&org.uuid)?;
    record(&engine, &org.uuid, "code", None, crate::caller::via());
    Ok(Json(json!({ "id": made["id"], "code": made["code"], "created_at": made["created_at"], "expires_at": made["expires_at"],
                    "minutes": registry::INVITATION_MINUTES, "door": lifecycle::status(&engine) })))
}

/// `DELETE /api/remote-access/orgs/{slug}/invitations/{id}`: take a code back before it was used.
#[nolog]
pub async fn withdraw(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let org = local_org(&engine, &slug)?;
    if !engine.access.registry.invitations(&org.uuid).iter().any(|invitation| invitation["id"] == id.as_str()) {
        return Err(ApiError::not_found(text::NO_CODE));
    }
    if engine.access.registry.withdraw(&id)?.is_some() {
        record(&engine, &org.uuid, "code_withdrawn", None, crate::caller::via());
    }
    Ok(Json(org_view(&engine, &org)))
}

/// `PUT /api/remote-access/orgs/{slug}/computers/{id}`: give a computer that is already known
/// this organization too. No code.
#[nolog]
pub async fn give(State(engine): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let org = local_org(&engine, &slug)?;
    if !engine.access.is_open(&org.uuid) {
        return Err(ApiError::conflict(text::TURN_ON_FIRST));
    }
    let had = engine.access.registry.row(&id).is_some_and(|row| has(&row, &org.uuid));
    let row = engine.access.registry.give(&id, &org.uuid)?;
    if !had {
        record(&engine, &org.uuid, "computer_given", Some(&row), crate::caller::via());
        lifecycle::publish(&engine);
    }
    Ok(Json(org_view(&engine, &org)))
}

/// `DELETE /api/remote-access/computers/{id}`: take a computer's access away, to every
/// organization it had. Its connections end at once.
#[nolog]
pub async fn revoke(State(engine): State<Arc<Engine>>, Path(id): Path<String>, scope: Option<Extension<Scope>>) -> ApiResult<Json<Value>> {
    owner(&engine, &scope)?;
    let row = engine.access.registry.revoke(&id)?;
    for org in row["orgs"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        record(&engine, org, "computer_revoked", Some(&row), crate::caller::via());
    }
    lifecycle::publish(&engine);
    Ok(Json(json!({ "revoked": id })))
}
