//! First-start import of 3.0/3.1 data into the new schema.
//!
//! 3.0 and 3.1 keep every org in ONE PostgreSQL database, `orgtree`:
//! `public.orgs` (org_id, slug, created_at, deleted_at) names the orgs and
//! each org's rows live in schema `org_<org_id>`, in the same five tables as
//! the 2.x SQLite store (doc, nodes, log_d, log_l, meta). An org is active
//! when its row is not deleted and its marker `<data>/orgs/<slug>.pg` names
//! that org_id (the 3.x start-up rule; trashed and orphaned orgs stay out).
//!
//! The database is opened read-only and each org is read in one REPEATABLE
//! READ snapshot; nothing in it changes, so going back to 3.1 keeps working.
//! The copy itself is the 2.x importer's: one transaction per org, matched
//! by a uuid derived from the org's id, slug and creation time.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use tokio_postgres::{Client, NoTls};

use crate::config::Config;
use crate::import2x;
use crate::pg::Cluster;

/// Newest rows kept per log section (None = all); the same bounds as 2.x.
const LOGS: &[(&str, Option<i64>)] = &[
    ("events", Some(5000)),
    ("org_inbox", Some(2000)),
    ("user_mail_log", Some(500)),
    ("user_outbox", Some(500)),
    ("documents", None),
    ("work_items_archive", None),
];
const MAIL_LOG_PER_AGENT: i64 = 100;

/// Import every active 3.0/3.1 org plus the account registry. Returns the
/// number of orgs that failed (they are retried next start).
#[logged]
pub async fn run(
    cfg: &Config,
    cluster: &Cluster,
    dst: &mut deadpool_postgres::Object,
    progress: &dyn Fn(&str),
) -> Result<usize> {
    progress("database-import");
    let (src, conn) = cluster.connect_config("orgtree").connect(NoTls).await.context("open orgtree")?;
    let task = tokio::spawn(conn);
    let result = async {
        src.batch_execute("SET default_transaction_read_only = on").await?;
        let orgs = src
            .query(
                "SELECT org_id, slug, created_at FROM public.orgs WHERE deleted_at IS NULL ORDER BY org_id",
                &[],
            )
            .await?;
        let mut failed = 0;
        for o in &orgs {
            let org_id: i64 = o.get(0);
            let slug: String = o.get(1);
            let created: DateTime<Utc> = o.get(2);
            if slug.contains('@') || !marked(&cfg.path("orgs"), &slug, org_id) {
                tracing::info!(org = %slug, org_id, "3.0/3.1 organization skipped: no active marker");
                continue;
            }
            progress(&format!("database-import {slug}"));
            let uuid = import2x::org_uuid(&format!("orgtree-3.0:{org_id}:{slug}:{}", created.timestamp_micros()));
            let outcome = async {
                let source = read_org(&src, org_id, &slug).await?;
                import2x::copy_source(cfg, dst, &source, &uuid).await
            }
            .await;
            match outcome {
                Ok(Some(n)) => tracing::info!(org = %slug, agents = n, "imported 3.0/3.1 organization"),
                Ok(None) => {}
                Err(e) => {
                    failed += 1;
                    tracing::error!(org = %slug, error = %format!("{e:#}"), "3.0/3.1 organization import failed")
                }
            }
        }
        Ok::<usize, anyhow::Error>(failed)
    }
    .await;
    drop(src);
    task.abort();
    let failed = result?;
    if let Err(e) = import2x::import_accounts(&cfg.path("accounts-registry.json"), dst).await {
        tracing::error!(error = %format!("{e:#}"), "3.0/3.1 account import failed");
    }
    Ok(failed)
}

/// Does `<orgs>/<slug>.pg` name this org_id? (3.x's marker rule.)
#[logged]
fn marked(orgs: &Path, slug: &str, org_id: i64) -> bool {
    std::fs::read_to_string(orgs.join(format!("{slug}.pg")))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("org_id").and_then(serde_json::Value::as_i64))
        == Some(org_id)
}

/// One org's five tables, read in one read-only snapshot. Not logged: the
/// result carries the org's network identity secret.
async fn read_org(src: &Client, org_id: i64, slug: &str) -> Result<import2x::Source> {
    let s = format!("org_{org_id}");
    src.batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY").await?;
    let read = async {
        let pairs = |rows: Vec<tokio_postgres::Row>| -> Vec<(String, String)> {
            rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, String>(1))).collect()
        };
        let doc = pairs(src.query(&format!("SELECT key, val FROM {s}.doc"), &[]).await.context("doc")?);
        let nodes = pairs(src.query(&format!("SELECT id, val FROM {s}.nodes ORDER BY ord"), &[]).await.context("nodes")?);
        let mail_log = pairs(
            src.query(
                &format!(
                    "SELECT owner, val FROM (SELECT seq, owner, val,
                            row_number() OVER (PARTITION BY owner ORDER BY seq DESC) AS rn
                       FROM {s}.log_d WHERE sect = 'mail_log') x WHERE rn <= $1 ORDER BY seq"
                ),
                &[&MAIL_LOG_PER_AGENT],
            )
            .await
            .context("mail_log")?,
        );
        let mut logs: HashMap<String, Vec<String>> = HashMap::new();
        for (sect, limit) in LOGS {
            let rows = src
                .query(
                    &format!(
                        "SELECT val FROM (SELECT seq, val FROM {s}.log_l WHERE sect = $1 ORDER BY seq DESC LIMIT $2) x ORDER BY seq"
                    ),
                    &[sect, &limit.unwrap_or(i64::MAX)],
                )
                .await
                .with_context(|| format!("log {sect}"))?;
            logs.insert(sect.to_string(), rows.iter().map(|r| r.get::<_, String>(0)).collect());
        }
        Ok::<_, anyhow::Error>(import2x::build(slug, doc, nodes, mail_log, logs))
    }
    .await;
    let _ = src.batch_execute("ROLLBACK").await;
    read
}
