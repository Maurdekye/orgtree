//! Organization-level actions: create, delete, the canvas's tree ops, the
//! killswitch and dissolve-all.

use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
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
    let mut client = e.db.get().await?;
    let tx = client.transaction().await?;
    let mut slug = base.clone();
    let mut n = 1;
    while tx
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
    let id: i64 = tx
        .query_one(
            "INSERT INTO ot.orgs (uuid, slug, name, settings, net) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            &[&uuid, &slug, &name, &settings, &net],
        )
        .await?
        .get(0);
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'org_created', '@user', $2)",
        &[&id, &json!({ "name": name, "slug": slug })],
    )
    .await?;
    // the new row holds the name until this commits: folders a deleted org
    // of the name left behind go to the trash first, so the new org starts
    // clean (a refusal rolls the org back)
    sweep_leftovers(&e, &*tx, &slug).await?;
    let _ = std::fs::create_dir_all(e.cfg.workspace_dir(&slug));
    let _ = std::fs::create_dir_all(e.cfg.scratch_root(&slug));
    tx.commit().await?;
    drop(client);
    if let Err(err) = crate::net::ensure_identity(&e, id, &slug).await {
        tracing::warn!(error = %format!("{err:#}"), "the new organization's network identity could not be minted yet");
    }
    crate::net::kick(&e);
    let o = crate::orgs::open(&e, id, uuid.to_string(), slug.clone(), name);
    changes::notify(&e, &o, vec![Change::Registry, Change::Org]);
    Ok(Json(json!({ "slug": slug })))
}

/// The folders that belong to one org, under the names its trash keeps
/// them by: 3.x's two (workspace, scratch), and the uploads and docket
/// files this engine also keeps per org.
#[logged]
fn org_folders(e: &Engine, slug: &str) -> [(&'static str, PathBuf); 4] {
    [
        ("workspace", e.cfg.workspace_dir(slug)),
        ("scratch", e.cfg.scratch_root(slug)),
        ("uploads", e.cfg.path("uploads").join(slug)),
        ("docket", e.cfg.path("docket").join(slug)),
    ]
}

/// Where a trashed org's folders are kept (3.x `trash_folder`): named by
/// its slug, the time it was trashed and its id.
#[logged]
fn trash_dir(e: &Engine, slug: &str, at: DateTime<Utc>, id: &str) -> PathBuf {
    e.cfg.path("deleted").join(format!("{slug}-{}-{id}", at.format("%Y%m%dt%H%M%S")))
}

/// Move what exists of an org's folders into `keep`, each under its label
/// (a label already there gains -2, -3…). `tries` attempts each, 250 ms
/// apart: a folder a stopped CLI held open is let go within moments on
/// Windows. Returns the folders that would not move, with why.
#[logged]
async fn move_folders(e: &Engine, slug: &str, keep: &FsPath, tries: u32) -> Vec<Value> {
    let mut kept = Vec::new();
    for (label, path) in org_folders(e, slug) {
        if !path.exists() {
            continue;
        }
        let mut dest = keep.join(label);
        let mut n = 1;
        while dest.exists() {
            n += 1;
            dest = keep.join(format!("{label}-{n}"));
        }
        let mut failed = None;
        for i in 0..tries.max(1) {
            if i > 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            match std::fs::create_dir_all(keep).and_then(|_| std::fs::rename(&path, &dest)) {
                Ok(()) => {
                    failed = None;
                    break;
                }
                Err(err) => failed = Some(err),
            }
        }
        if let Some(err) = failed {
            tracing::warn!(folder = %path.display(), error = %err, "an organization's folder could not be moved to the trash");
            kept.push(json!({ "folder": path.to_string_lossy(), "error": err.to_string() }));
        }
    }
    kept
}

/// Folders still under a name no active org holds were left by a deleted
/// org of that name: one deleted before the trash took its folders, or one
/// whose folder was held open then. They go to the trash with that org
/// (the last one of the name trashed) before a new org takes the name;
/// one that will not move refuses the new org rather than hand it the old
/// one's files.
#[logged]
async fn sweep_leftovers(e: &Engine, client: &impl tokio_postgres::GenericClient, slug: &str) -> ApiResult<()> {
    if org_folders(e, slug).iter().all(|(_, p)| !p.exists()) {
        return Ok(());
    }
    let last = client
        .query_opt(
            "SELECT id, trashed_at FROM ot.orgs WHERE slug = $1 AND state = 'trashed' ORDER BY trashed_at DESC NULLS LAST, id DESC LIMIT 1",
            &[&slug],
        )
        .await?;
    let keep = match last {
        Some(r) => trash_dir(e, slug, r.get::<_, Option<DateTime<Utc>>>(1).unwrap_or_else(Utc::now), &r.get::<_, i64>(0).to_string()),
        None => trash_dir(e, slug, Utc::now(), "leftover"),
    };
    let kept = move_folders(e, slug, &keep, 1).await;
    if let Some(k) = kept.first() {
        return Err(ApiError::conflict(format!(
            "a deleted organization's folder is still in use and could not be moved to the trash ({}: {}); close what holds it and try again",
            k["folder"].as_str().unwrap_or_default(),
            k["error"].as_str().unwrap_or_default()
        )));
    }
    Ok(())
}

/// Delete moves the organization to the trash (no purge): its row, and
/// (3.x §2.13) its folders, once its agents have stopped.
#[logged]
pub async fn delete(State(e): State<Arc<Engine>>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    let client = e.db.get().await?;
    let row = client
        .query_one("UPDATE ot.orgs SET state = 'trashed', trashed_at = now() WHERE id = $1 RETURNING net, trashed_at", &[&o.id])
        .await?;
    let net: Value = row.get(0);
    let at: DateTime<Utc> = row.get::<_, Option<DateTime<Utc>>>(1).unwrap_or_else(Utc::now);
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
    // the folders go last, with nothing left running in them; one still
    // held open stays, reported, and the next org of the name sweeps it
    let trash = trash_dir(&e, &slug, at, &o.id.to_string());
    let kept = move_folders(&e, &slug, &trash, 20).await;
    changes::notify(&e, &o, vec![Change::Registry]);
    Ok(Json(json!({ "ok": true, "trash": trash.to_string_lossy(), "folders_kept": kept })))
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
    if matches!(b["op"].as_str(), Some("halt" | "unhalt")) {
        return Ok(Json(super::nodes::halt_batch(&e, &o, &b, b["op"] == "halt").await?));
    }
    Ok(Json(ops::run(&e, &o, Actor::User, &b).await?))
}

#[logged]
pub async fn reorder(
    State(e): State<Arc<Engine>>,
    Path((slug, nid)): Path<(String, String)>,
    Json(mut b): Json<Value>,
) -> ApiResult<Json<Value>> {
    let o = org(&e, &slug)?;
    if !b.is_object() {
        return Err(ApiError::bad_request("the body must be a JSON object"));
    }
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
    if !b.is_object() {
        return Err(ApiError::bad_request("the body must be a JSON object"));
    }
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
