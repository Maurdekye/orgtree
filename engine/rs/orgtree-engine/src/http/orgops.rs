//! Organization-level actions: create, delete, the canvas's tree ops, the
//! killswitch and dissolve-all.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::ops::{self, Actor};
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::http::error::{ApiError, ApiResult};
use crate::http::orgs::org;
use crate::runtime::AgentMsg;
use crate::util::{now_iso, slugify};

#[derive(Deserialize, Debug)]
pub struct CreateOrg {
    name: String,
    #[serde(default)]
    dirs: Vec<String>,
    net_autoconnect: Option<bool>,
    #[serde(default)]
    net_hubs: Vec<String>,
}

#[logged]
pub async fn create(State(e): State<Arc<Engine>>, Json(b): Json<CreateOrg>) -> ApiResult<Json<Value>> {
    let name = b.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("an organization needs a name"));
    }
    let base = slugify(&name, 40);
    let client = e.db.get().await?;
    let mut slug = base.clone();
    let mut n = 1;
    while client
        .query_opt("SELECT 1 FROM ot.orgs WHERE slug = $1 AND state = 'active'", &[&slug])
        .await?
        .is_some()
    {
        n += 1;
        slug = format!("{base}-{n}");
    }
    let dirs: Vec<Value> = b
        .dirs
        .iter()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .map(|d| json!({ "path": d, "mode": "rw" }))
        .collect();
    let settings = json!({ "dirs": dirs });
    let auto = b.net_autoconnect.unwrap_or(true);
    let net = json!({ "autoconnect": auto, "hubs": crate::net::hub_entries(&e, auto, &b.net_hubs) });
    let uuid = uuid::Uuid::new_v4();
    let id: i64 = client
        .query_one(
            "INSERT INTO ot.orgs (uuid, slug, name, settings, net) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            &[&uuid, &slug, &name, &settings, &net],
        )
        .await?
        .get(0);
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'org_created', '@user', $2)",
            &[&id, &json!({ "name": name, "slug": slug })],
        )
        .await?;
    drop(client);
    let _ = std::fs::create_dir_all(e.cfg.workspace_dir(&slug));
    let _ = std::fs::create_dir_all(e.cfg.scratch_root(&slug));
    if let Err(err) = crate::net::ensure_identity(&e, id, &slug).await {
        tracing::warn!(error = %format!("{err:#}"), "the new organization's network identity could not be minted yet");
    }
    crate::net::kick(&e);
    let o = crate::orgs::open(&e, id, uuid.to_string(), slug.clone(), name);
    changes::notify(&e, &o, vec![Change::Registry, Change::Org]);
    Ok(Json(json!({ "slug": slug })))
}

/// Delete moves the organization to the trash (no purge).
#[logged]
pub async fn delete(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let net: Value = client
        .query_one("UPDATE ot.orgs SET state = 'trashed', trashed_at = now() WHERE id = $1 RETURNING net", &[&o.id])
        .await?
        .get(0);
    crate::net::unregister(&e, net);
    let live: Vec<i64> = client
        .query("SELECT id FROM ot.agents WHERE org_id = $1 AND state = 'live'", &[&o.id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let dogs = client.query("SELECT uid FROM ot.watchdogs WHERE org_id = $1 AND state = 'armed'", &[&o.id]).await?;
    drop(client);
    for d in &dogs {
        crate::runtime::watchdogs::disarm(&e, &d.get::<_, String>(0));
    }
    for id in live {
        if let Some(h) = e.agents.get(id) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            if h.send(AgentMsg::Stop(tx)) {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), rx).await;
            }
        }
    }
    e.orgs.remove(&slug);
    changes::notify(&e, &o, vec![Change::Registry]);
    Ok(Json(json!({ "ok": true })))
}

/// Orgs are never "unavailable" on this engine: retry just answers the entry.
#[logged]
pub async fn retry(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(json!({ "slug": o.slug, "name": o.name.load().as_str(), "state": "active", "state_reason": null })))
}

#[logged]
pub async fn run_op(State(e): State<Arc<Engine>>, Path(slug): Path<String>, Json(b): Json<Value>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    Ok(Json(ops::run(&e, &o, Actor::User, &b).await?))
}

#[logged]
pub async fn reorder(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(mut b): Json<Value>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    b["op"] = json!("reorder");
    b["node"] = json!(nid);
    Ok(Json(ops::run(&e, &o, Actor::User, &b).await?))
}

#[logged]
pub async fn account(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(mut b): Json<Value>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    b["op"] = json!("account");
    b["node"] = json!(nid);
    Ok(Json(ops::run(&e, &o, Actor::User, &b).await?))
}

/// Retire every top-level agent with its team.
#[logged]
pub async fn dissolve_all(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let tops: Vec<String> = client
        .query("SELECT name FROM ot.agents WHERE org_id = $1 AND parent_id IS NULL AND state = 'live' ORDER BY id", &[&o.id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    drop(client);
    let mut freed = 0.0;
    let mut nodes = 0;
    for t in tops {
        let r = ops::run(&e, &o, Actor::User, &json!({ "op": "dissolve", "node": t })).await?;
        freed += r["freed"].as_f64().unwrap_or(0.0);
        nodes += r["nodes"].as_i64().unwrap_or(0);
    }
    Ok(Json(json!({ "freed": freed, "nodes": nodes })))
}

/// Why Stop All paused a watchdog (3.x wording); release leaves it paused.
const KILLSWITCH_PAUSE: &str =
    "⏹ STOP ALL paused every watchdog. Nothing un-pauses it automatically — resume this dog deliberately when you want it back.";

/// Stop everything: running turns are interrupted, watchdogs paused, and
/// nothing starts a turn until the latch is released.
#[logged]
pub async fn killswitch(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let latched = client
        .execute(
            "UPDATE ot.orgs SET killswitch = $2, row_version = row_version + 1 WHERE id = $1 AND killswitch IS NULL",
            &[&o.id, &json!({ "at": now_iso(), "by": "@user" })],
        )
        .await?;
    let paused = client
        .query(
            "UPDATE ot.watchdogs w SET state = 'paused',
                    memo = memo || jsonb_build_object('paused_why', $2::text)
               FROM ot.agents a WHERE a.id = w.owner_agent_id AND w.org_id = $1 AND w.state = 'armed'
             RETURNING w.uid, w.name, a.name",
            &[&o.id, &KILLSWITCH_PAUSE],
        )
        .await?;
    let live: Vec<(i64, String)> = client
        .query("SELECT id, name FROM ot.agents WHERE org_id = $1 AND state = 'live'", &[&o.id])
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    drop(client);
    let mut interrupted = Vec::new();
    for (id, name) in live {
        let Some(h) = e.agents.get(id) else { continue };
        if !h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        if h.send(AgentMsg::Interrupt(tx)) {
            if let Ok(Ok(v)) = tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
                if v["interrupted"].as_bool().unwrap_or(false) {
                    interrupted.push(name);
                }
            }
        }
    }
    for r in &paused {
        crate::runtime::watchdogs::disarm(&e, &r.get::<_, String>(0));
    }
    changes::notify(&e, &o, vec![Change::Org, Change::Watchdogs]);
    let watchdogs: Vec<Value> = paused
        .iter()
        .map(|r| json!({ "id": r.get::<_, String>(0), "name": r.get::<_, String>(1), "owner": r.get::<_, String>(2) }))
        .collect();
    Ok(Json(json!({ "latched": latched > 0, "already_latched": latched == 0, "interrupted": interrupted,
                    "watchdogs_paused": watchdogs })))
}

/// Release the latch, and only the latch (as 3.x): no turn is started or
/// resumed, and the watchdogs Stop All paused stay paused until each is
/// resumed by hand. Agents merely become eligible again for whatever
/// legitimately drives them next.
#[logged]
pub async fn killswitch_release(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let released = client
        .execute("UPDATE ot.orgs SET killswitch = NULL, row_version = row_version + 1 WHERE id = $1 AND killswitch IS NOT NULL", &[&o.id])
        .await?;
    drop(client);
    changes::notify(&e, &o, vec![Change::Org]);
    Ok(Json(json!({ "released": released > 0, "status": if released > 0 { "released" } else { "the killswitch is not latched" } })))
}
