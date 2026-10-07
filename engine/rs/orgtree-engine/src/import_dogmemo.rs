//! One-time catch-up for watchdogs imported before the importers carried
//! the 3.x watchdog memo (notice flag, progress, pause reason, activity
//! target). Those rows have no `notice` key, so passive dogs woke their
//! owners. At engine start, once, the legacy store is re-read read-only and
//! only those rows are patched; keys the 4.0 runner already wrote win.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde_json::{json, Value};
use tokio_postgres::NoTls;

use crate::config::Config;
use crate::pg::Cluster;
use crate::util::iso;

const MARKER: &str = "import_dog_memo_v1";

/// An imported dog still missing its memo: (org uuid, dog uid).
type Missing = HashSet<(String, String)>;
/// Legacy dog records by org uuid.
type Legacy = HashMap<String, Vec<Value>>;

/// Run the catch-up unless it already ran. Never fails the start: a problem
/// is logged and the catch-up is tried again next start.
#[logged]
pub async fn run_once(cfg: &Config, cluster: &Cluster, pool: &Pool) {
    if let Err(e) = run(cfg, cluster, pool).await {
        tracing::warn!(error = %format!("{e:#}"), "watchdog memo catch-up failed; retrying next start");
    }
}

#[logged]
async fn run(cfg: &Config, cluster: &Cluster, pool: &Pool) -> Result<()> {
    let dst = pool.get().await?;
    if dst.query_opt("SELECT 1 FROM ot.meta WHERE key = $1", &[&MARKER]).await?.is_some() {
        return Ok(());
    }
    let rows = dst
        .query(
            "SELECT o.uuid::text, w.uid FROM ot.watchdogs w JOIN ot.orgs o ON o.id = w.org_id
              WHERE NOT (w.memo ? 'notice') AND w.state IN ('armed', 'paused', 'exited')",
            &[],
        )
        .await?;
    let missing: Missing = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    let mut patched = 0;
    if !missing.is_empty() {
        let orgs: HashSet<String> = missing.iter().map(|(o, _)| o.clone()).collect();
        let legacy = read_legacy(cfg, cluster, &orgs).await?;
        for (org, dogs) in &legacy {
            let ids = agent_ids(&dst, org).await?;
            for w in dogs {
                let Some(uid) = w["id"].as_str() else { continue };
                if !missing.contains(&(org.clone(), uid.to_string())) {
                    continue;
                }
                let memo = crate::runtime::watchdogs::import_memo(w, &ids);
                // fill only what is missing: the row's own keys (and its run
                // progress) win, a pause reason only lands on a paused row, and
                // the `notice` guard makes a rerun a no-op
                patched += dst
                    .execute(
                        "UPDATE ot.watchdogs SET memo = (($2::jsonb - CASE WHEN state = 'paused' THEN '' ELSE 'paused_why' END) || memo)
                                || jsonb_build_object('run', coalesce($2::jsonb->'run', '{}'::jsonb) || coalesce(memo->'run', '{}'::jsonb))
                          WHERE uid = $1 AND org_id = (SELECT id FROM ot.orgs WHERE uuid = $3::text::uuid) AND NOT (memo ? 'notice')",
                        &[&uid, &memo, &org],
                    )
                    .await?;
            }
        }
    }
    tracing::info!(patched, missing = missing.len(), "watchdog memo catch-up done");
    dst.execute(
        "INSERT INTO ot.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        &[&MARKER, &json!({ "at": iso(Utc::now()), "patched": patched })],
    )
    .await?;
    Ok(())
}

/// Imported agent names to ids in one org (for activity targets).
#[logged]
async fn agent_ids(dst: &deadpool_postgres::Object, org_uuid: &str) -> Result<HashMap<String, i64>> {
    let rows = dst
        .query(
            "SELECT a.name, a.id FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE o.uuid = $1::text::uuid",
            &[&org_uuid],
        )
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// The legacy dog records of the orgs in `wanted`, from whichever store the
/// import used (3.2, 3.0/3.1, or 2.x), all opened read-only.
#[logged]
async fn read_legacy(cfg: &Config, cluster: &Cluster, wanted: &HashSet<String>) -> Result<Legacy> {
    let (has_app, has_v30) = {
        let (c, conn) = cluster.connect_config("postgres").connect(NoTls).await?;
        let t = tokio::spawn(conn);
        let app = c.query_opt("SELECT 1 FROM pg_database WHERE datname = 'orgtree_app'", &[]).await?.is_some();
        let v30 = c.query_opt("SELECT 1 FROM pg_database WHERE datname = 'orgtree'", &[]).await?.is_some();
        drop(c);
        t.abort();
        (app, v30)
    };
    let mut out = Legacy::new();
    if has_app {
        read_v32(cluster, wanted, &mut out).await?;
    }
    if has_v30 {
        read_v30(cluster, wanted, &mut out).await?;
    }
    if !has_app && !has_v30 {
        read_v2x(cfg, wanted, &mut out).await?;
    }
    Ok(out)
}

/// 3.2: `orgtree_app` lists the orgs; each has its own database.
#[logged]
async fn read_v32(cluster: &Cluster, wanted: &HashSet<String>, out: &mut Legacy) -> Result<()> {
    let (app, conn) = cluster.connect_config("orgtree_app").connect(NoTls).await?;
    let task = tokio::spawn(conn);
    app.batch_execute("SET default_transaction_read_only = on").await?;
    let orgs = app.query("SELECT org_uuid::text, database FROM orgtree.orgs", &[]).await;
    drop(app);
    task.abort();
    for o in &orgs? {
        let uuid: String = o.get(0);
        let db: String = o.get(1);
        if !wanted.contains(&uuid) {
            continue;
        }
        let read = async {
            let (src, conn) = cluster.connect_config(&db).connect(NoTls).await.with_context(|| format!("open {db}"))?;
            let task = tokio::spawn(conn);
            let rows = async {
                src.batch_execute("SET default_transaction_read_only = on").await?;
                src.query(
                    "SELECT public_id, kind, target, notice, high_water::jsonb, checks_run, last_output, paused_why, last_exit
                       FROM orgtree.watchdogs",
                    &[],
                )
                .await
            }
            .await;
            drop(src);
            task.abort();
            Ok::<_, anyhow::Error>(rows?)
        }
        .await;
        // one unreadable org (gone, or a store without these columns) is skipped
        let rows = match read {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(database = %db, error = %format!("{e:#}"), "3.2 organization unreadable for the watchdog catch-up");
                continue;
            }
        };
        let dogs = rows
            .iter()
            .map(|w| {
                json!({
                    "id": w.get::<_, Option<String>>(0),
                    "kind": w.get::<_, Option<String>>(1),
                    "target": w.get::<_, Option<String>>(2),
                    "notice": w.get::<_, Option<bool>>(3),
                    "high_water": w.get::<_, Option<Value>>(4),
                    "checks_run": w.get::<_, Option<i64>>(5),
                    "last_output": w.get::<_, Option<String>>(6),
                    "paused_why": w.get::<_, Option<String>>(7),
                    "last_exit": w.get::<_, Option<i64>>(8),
                })
            })
            .collect();
        out.insert(uuid, dogs);
    }
    Ok(())
}

/// 3.0/3.1: one `orgtree` database, a schema per org; the dogs are the
/// `watchdogs` row of its document.
#[logged]
async fn read_v30(cluster: &Cluster, wanted: &HashSet<String>, out: &mut Legacy) -> Result<()> {
    let (src, conn) = cluster.connect_config("orgtree").connect(NoTls).await.context("open orgtree")?;
    let task = tokio::spawn(conn);
    let read = async {
        src.batch_execute("SET default_transaction_read_only = on").await?;
        let orgs = src.query("SELECT org_id, slug, created_at FROM public.orgs", &[]).await?;
        let mut found = Vec::new();
        for o in &orgs {
            let org_id: i64 = o.get(0);
            let slug: String = o.get(1);
            let created: DateTime<Utc> = o.get(2);
            // the uuid import30 gave this org
            let uuid = crate::import2x::org_uuid(&format!("orgtree-3.0:{org_id}:{slug}:{}", created.timestamp_micros()));
            if !wanted.contains(&uuid) {
                continue;
            }
            let row = match src.query_opt(&format!("SELECT val FROM org_{org_id}.doc WHERE key = 'watchdogs'"), &[]).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(org = %slug, error = %format!("{e:#}"), "3.0/3.1 organization unreadable for the watchdog catch-up");
                    continue;
                }
            };
            let dogs = row
                .and_then(|r| serde_json::from_str::<Value>(&r.get::<_, String>(0)).ok())
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            found.push((uuid, dogs));
        }
        Ok::<_, anyhow::Error>(found)
    }
    .await;
    drop(src);
    task.abort();
    out.extend(read?);
    Ok(())
}

/// 2.x: the SQLite (or JSON) org files under `<data>/orgs`, read the way the
/// 2.x import read them.
#[logged]
async fn read_v2x(cfg: &Config, wanted: &HashSet<String>, out: &mut Legacy) -> Result<()> {
    let (orgs, staging) = (cfg.path("orgs"), cfg.path("import-2x-staging"));
    let wanted = wanted.clone();
    let found = tokio::task::spawn_blocking(move || crate::import2x::legacy_watchdogs(&orgs, &staging, &wanted)).await?;
    out.extend(found);
    Ok(())
}
