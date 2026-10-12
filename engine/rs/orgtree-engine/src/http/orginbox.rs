//! The org inbox viewer: retained log, read mark, network and transfer inspection.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::domain::orginbox;
use crate::engine::Engine;
use crate::http::error::ApiResult;
use crate::http::orgs::org;
/// The newest 100 rows (oldest first), with the log's real size and unread count.
#[logged]
pub async fn list(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    orginbox::require_enabled(&e, o.id).await?;
    let client = e.db.get().await?;
    let rows = client
        .query("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id = $1 ORDER BY id DESC LIMIT 100", &[&o.id])
        .await?;
    let counts = client
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE dir = 'in' AND NOT read) FROM ot.org_inbox WHERE org_id = $1",
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
