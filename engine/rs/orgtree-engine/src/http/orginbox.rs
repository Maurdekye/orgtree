//! The org mailbox viewer: retained log, read mark, network and transfer inspection.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::orginbox;
use crate::engine::Engine;
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
/// The newest 100 rows (oldest first), with the log's real size and unread count.
// Retained outside mail bodies must not enter handler return diagnostics.
#[nolog]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    orginbox::require_enabled(&e, o.id).await?;
    let client = e.db.get().await?;
    let rows = client
        .query("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id = $1 ORDER BY id DESC LIMIT 100", &[&o.id])
        .await?;
    let counts = client
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE dir = 'in' AND NOT read AND set_aside_at IS NULL) FROM ot.org_inbox WHERE org_id = $1",
            &[&o.id],
        )
        .await?;
    let mut entries: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut v = orginbox::entry(&r.get::<_, Value>(0));
            if let Some(id) = v["id"].as_str().map(str::to_string) {
                v["ref"] = json!(format!("@mail:{}/org/{id}", o.slug));
            }
            v
        })
        .collect();
    entries.reverse();
    Ok(Json(json!({ "entries": entries, "total": counts.get::<_, i64>(0), "unread": counts.get::<_, i64>(1) })))
}

/// The user opened the panel: everything that came in is read.
#[logged]
pub async fn read(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    orginbox::require_enabled(&e, o.id).await?;
    let client = e.db.get().await?;
    let changed = client
        .execute("UPDATE ot.org_inbox SET read = true WHERE org_id = $1 AND dir = 'in' AND NOT read", &[&o.id])
        .await?;
    drop(client);
    if changed > 0 {
        changes::notify(&e, &o, vec![Change::OrgInbox]);
    }
    Ok(Json(json!({ "ok": true })))
}

/// `GET /api/orgs/{slug}/net`: the org's network identity and hubs — the
/// one route that returns the secret (the settings panel's reveal/export).
#[logged]
pub async fn net(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::reveal(&e, o.id, &o.slug).await?))
}

/// `GET /api/orgs/{slug}/net/recent`: the newest mail this org exchanged with
/// each address its hubs list (bare slug → time), the Connections tab's order
/// (USER 2026-10-29 m3e3829f0bf18).
#[logged]
pub async fn net_recent(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::recent::org_recent(&e, o.id).await?))
}

/// `GET /api/orgs/{slug}/net/blocks`: the org's blocks (who set each, why)
/// and the contacts that block it (Mail hub 2.6.0).
#[logged]
pub async fn blocks_get(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::blocks::list(&e, o.id).await?))
}

#[derive(Deserialize, Debug)]
pub struct BlockBody {
    address: String,
    blocked: bool,
}

/// `POST /api/orgs/{slug}/net/blocks {address, blocked}`: the user blocks or
/// unblocks a contact for the org (the mailservers tab).
#[logged]
pub async fn blocks_post(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<BlockBody>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::blocks::set(&e, o.id, &b.address, b.blocked, crate::net::blocks::BY_USER, None).await?))
}

/// `GET /api/orgs/{slug}/net/lockdown`: the org mailbox lockdown (setting, list, hubs).
#[logged]
pub async fn lockdown_get(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::lockdown::status(&e, o.id).await?))
}

/// One allow entry from the app: `{hub, address}`, or an address the engine places (`net::lockdown::entries`).
#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum LockdownEntry {
    On { hub: String, address: String },
    Address(String),
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct LockdownBody {
    /// the user's setting: org (Org decides), on, off
    setting: Option<String>,
    on: Option<bool>,
    allow: Option<Vec<LockdownEntry>>,
    #[serde(default)]
    add: Vec<LockdownEntry>,
    #[serde(default)]
    remove: Vec<LockdownEntry>,
    set_aside: Option<bool>,
    rev: Option<i64>,
}

#[logged]
async fn lockdown_entries(e: &Engine, org_id: i64, list: &[LockdownEntry]) -> anyhow::Result<Vec<crate::net::lockdown::Entry>> {
    let mut out = Vec::new();
    for x in list {
        match x {
            LockdownEntry::On { hub, address } => out.extend(crate::net::lockdown::entries(e, org_id, address, Some(hub)).await?),
            LockdownEntry::Address(a) => out.extend(crate::net::lockdown::entries(e, org_id, a, None).await?),
        }
    }
    Ok(out)
}

/// `POST /api/orgs/{slug}/net/lockdown`: the user changes the lockdown (USER 2026-11-25 14:10:49Z: On / Off /
/// Org decides; the user may always change it).
#[logged]
pub async fn lockdown_post(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<LockdownBody>) -> ApiResult<Json<Value>> {
    use crate::net::lockdown::{Edit, UserMode, Who};
    let o = org(&e, &slug)?;
    let user_mode = match b.setting.as_deref() {
        None => None,
        Some(s) => Some(UserMode::parse(s).ok_or_else(|| ApiError::bad_request("setting must be org, on or off"))?),
    };
    let allow = match &b.allow {
        Some(l) => Some(lockdown_entries(&e, o.id, l).await?),
        None => None,
    };
    let edit = Edit {
        user_mode, on: b.on, allow, add: lockdown_entries(&e, o.id, &b.add).await?, remove: lockdown_entries(&e, o.id, &b.remove).await?,
        set_aside: b.set_aside, expect_rev: b.rev,
    };
    Ok(Json(crate::net::lockdown::change(&e, o.id, Who::User, edit).await?))
}

#[derive(Deserialize, Debug)]
pub struct SetAsideQuery {
    limit: Option<i64>,
    before: Option<String>,
}

/// `GET /api/orgs/{slug}/net/lockdown/set-aside`: set-aside letters (envelopes), newest first.
#[logged]
pub async fn set_aside_list(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<SetAsideQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(crate::net::lockdown::set_aside_list(&e, o.id, None, q.limit.unwrap_or(50), q.before.as_deref()).await?))
}

/// `GET /api/orgs/{slug}/net/lockdown/set-aside/{id}`: the user reads one set-aside letter.
#[nolog]
pub async fn set_aside_read(State(e): State<Arc<Engine>>, Path((slug, id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let v = crate::net::lockdown::set_aside_read(&e, o.id, None, &id).await?;
    changes::notify(&e, &o, vec![Change::OrgInbox]);
    Ok(Json(v))
}

#[derive(Deserialize,Debug)]
pub struct TransferQuery { agent: Option<String>, cursor: Option<String> }

#[logged]
pub async fn transfers(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Query(q): Query<TransferQuery>) -> ApiResult<Json<Value>> {
    let o = org(&e,&slug)?;
    let actor = if let Some(name) = q.agent {
        let c = e.db.get().await?;
        let row = c.query_opt("SELECT id FROM ot.agents WHERE org_id=$1 AND name=$2 AND state='live'", &[&o.id,&name]).await?;
        match row { Some(row) => Some(row.get::<_,i64>(0)), None => return Ok(Json(json!({"transfers":[]}))) }
    } else { None };
    Ok(Json(crate::net::control::page(&e,o.id,actor,None,q.cursor.as_deref()).await?))
}

#[logged]
pub async fn transfer_change(State(e): State<Arc<Engine>>, Path((slug,id)): Path<(String,String)>, Json(args): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e,&slug)?;
    let action = args["action"].as_str().unwrap_or("");
    Ok(Json(crate::net::control::change(&e,o.id,None,&id,action).await?))
}
