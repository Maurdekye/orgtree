//! First-start import of 2.x data (2.1.14 and later) into the new schema.
//!
//! 2.x keeps one SQLite file per org, `<data>/orgs/<slug>.db`:
//!   doc(key, val)                   top-level org values, one JSON value per key
//!   nodes(id, ord, val)             one JSON document per agent (live and archived)
//!   log_d(sect, owner, at, val)     per-agent logs (mail_log, ...)
//!   log_l(sect, at, val)            org-wide logs (events, documents, org_inbox, ...)
//! An org from before the SQLite store is one `<slug>.json` document holding
//! the same sections inline. App-wide data is `accounts-registry.json` and
//! `app-settings.json` (the latter is read by the 3.x importer's helper).
//!
//! The source files are opened read-only and immutable (a file with an
//! unmerged write-ahead log is read from a private staging copy), so nothing
//! in the 2.x data folder changes and going back to 2.x keeps working.
//! `pre-postgres/` (2.x files a 3.x conversion left behind) is never read. One PostgreSQL
//! transaction per org; a failed org leaves nothing behind and is retried on
//! the next start. Imported orgs are matched by a uuid derived from the org's
//! slug and creation time, so a retry skips what already landed.
//!
//! Dropped on purpose (features 4.0 removed, or runtime state a restart
//! invalidates): steered_log, steer_attempts, turn_error_log, reservations,
//! op_receipts, lifecycle, net_spool, notices/notice_log, desktop_import,
//! fable policies, docket acceptance/review/artifact/finding records.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::Transaction;

use crate::config::Config;
use crate::domain::asks::{compose, Parts};
use crate::providers::catalog;
use crate::util::{parse_ts, uid};

/// Newest rows kept per log section (None = all).
const LOGS: &[(&str, Option<i64>)] = &[
    ("events", Some(5000)),
    ("org_inbox", Some(2000)),
    ("user_mail_log", Some(500)),
    ("user_outbox", Some(500)),
    ("documents", None),
    ("work_items_archive", None),
];
const MAIL_LOG_PER_AGENT: usize = 100;
const TURNS_PER_AGENT: usize = 8;
const RESOLVED_ASKS: usize = 40;
const HISTORY_PER_ITEM: usize = 200;

/// One org's 2.x data, read into memory. It holds the org's network
/// identity secret, so it derives nothing (no Debug, no Serialize).
pub(crate) struct Source {
    slug: String,
    doc: Map<String, Value>,
    nodes: Vec<(String, Value)>,
    mail_log: Vec<(String, Value)>,
    logs: HashMap<String, Vec<Value>>,
}

/// Import every 2.x org found under `<data>/orgs` plus the account registry.
/// Returns the number of orgs that failed (they are retried next start).
#[logged]
pub async fn run(cfg: &Config, dst: &mut deadpool_postgres::Object, progress: &dyn Fn(&str)) -> Result<usize> {
    let sources = find_orgs(&cfg.path("orgs"));
    if sources.is_empty() {
        return Ok(0);
    }
    progress("database-import");
    let staging = cfg.path("import-2x-staging");
    let mut failed = 0;
    for (slug, path) in &sources {
        progress(&format!("database-import {slug}"));
        match import_org(cfg, dst, slug, path, &staging).await {
            Ok(Some(n)) => tracing::info!(org = %slug, agents = n, "imported 2.x organization"),
            Ok(None) => {}
            Err(e) => {
                failed += 1;
                tracing::error!(org = %slug, error = %format!("{e:#}"), "2.x organization import failed")
            }
        }
    }
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = import_accounts(&cfg.path("accounts-registry.json"), dst).await {
        tracing::error!(error = %format!("{e:#}"), "2.x account import failed");
    }
    Ok(failed)
}

/// The watchdog records of the 2.x orgs whose import uuid is in `wanted`,
/// read exactly as the import read them (for the watchdog memo catch-up).
#[logged]
pub(crate) fn legacy_watchdogs(dir: &Path, staging: &Path, wanted: &HashSet<String>) -> Vec<(String, Vec<Value>)> {
    let mut out = Vec::new();
    for (slug, path) in find_orgs(dir) {
        let src = match load(&slug, &path, staging) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(org = %slug, error = %format!("{e:#}"), "2.x organization unreadable for the watchdog catch-up");
                continue;
            }
        };
        let created = src.doc.get("created").and_then(Value::as_str).unwrap_or("");
        let uuid = org_uuid(&format!("orgtree-2x:{slug}:{created}"));
        if wanted.contains(&uuid) {
            out.push((uuid, src.doc.get("watchdogs").and_then(Value::as_array).cloned().unwrap_or_default()));
        }
    }
    let _ = std::fs::remove_dir_all(staging);
    out
}

/// `(slug, file)` for each org: `<slug>.db`, or `<slug>.json` with no `.db`.
#[logged]
fn find_orgs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    let set: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    for n in &names {
        let slug = if let Some(s) = n.strip_suffix(".db") {
            s
        } else if let Some(s) = n.strip_suffix(".json") {
            if set.contains(format!("{s}.db").as_str()) {
                continue;
            }
            s
        } else {
            continue;
        };
        if slug.is_empty() || slug.contains('@') || slug.contains('.') || slug.starts_with('_') {
            continue;
        }
        out.push((slug.to_string(), dir.join(n)));
    }
    out.sort();
    out
}

/// A stable import uuid from the org's identifying text: the same source org
/// always maps to the same row, so a retry skips what already landed.
#[logged]
pub(crate) fn org_uuid(key: &str) -> String {
    let h = Sha256::digest(key.as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&h[..16]);
    b[6] = (b[6] & 0x0f) | 0x50; // name-based (version 5 layout)
    b[8] = (b[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(b).to_string()
}

#[logged]
async fn import_org(
    cfg: &Config,
    dst: &mut deadpool_postgres::Object,
    slug: &str,
    path: &Path,
    staging: &Path,
) -> Result<Option<usize>> {
    let (p, st, sl) = (path.to_path_buf(), staging.to_path_buf(), slug.to_string());
    let src = tokio::task::spawn_blocking(move || load(&sl, &p, &st)).await??;
    let created = src.doc.get("created").and_then(Value::as_str).unwrap_or("").to_string();
    let uuid = org_uuid(&format!("orgtree-2x:{slug}:{created}"));
    copy_source(cfg, dst, &src, &uuid).await
}

/// Copy one read org in its own transaction, unless its uuid already landed.
#[logged]
pub(crate) async fn copy_source(
    cfg: &Config,
    dst: &mut deadpool_postgres::Object,
    src: &Source,
    uuid: &str,
) -> Result<Option<usize>> {
    if dst.query_opt("SELECT 1 FROM ot.orgs WHERE uuid = $1::text::uuid", &[&uuid]).await?.is_some() {
        return Ok(None);
    }
    let tx = dst.transaction().await?;
    let n = copy_org(cfg, src, &tx, uuid).await?;
    tx.commit().await?;
    Ok(Some(n))
}

/// Read one org from a private copy of its files. Not logged: the result
/// carries the org's network identity secret.
fn load(slug: &str, path: &Path, staging: &Path) -> Result<Source> {
    if path.extension().and_then(|e| e.to_str()) == Some("json") {
        let text = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let Value::Object(doc) = serde_json::from_str::<Value>(&text)? else { anyhow::bail!("{} is not an org document", path.display()) };
        return Ok(from_document(slug, doc));
    }
    // A clean 2.x file is read in place, read-only and immutable. A file
    // with an unmerged write-ahead log is read from a private staging copy,
    // because an immutable open would not see the log; nothing in the 2.x
    // folder is ever written.
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    if std::fs::metadata(&wal).map(|m| m.len() == 0).unwrap_or(true) {
        let uri = format!("file:{}?immutable=1", path.to_string_lossy().replace('\\', "/").replace('?', "%3f").replace('#', "%23"));
        let c = rusqlite::Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .with_context(|| format!("open {}", path.display()))?;
        return read_sqlite(slug, &c);
    }
    std::fs::create_dir_all(staging)?;
    let copy = staging.join(format!("{slug}.db"));
    for ext in ["", "-wal"] {
        let from = PathBuf::from(format!("{}{ext}", path.display()));
        let to = PathBuf::from(format!("{}{ext}", copy.display()));
        let _ = std::fs::remove_file(&to);
        std::fs::copy(&from, &to).with_context(|| format!("copy {}", from.display()))?;
    }
    let src = rusqlite::Connection::open(&copy)
        .with_context(|| format!("open {}", copy.display()))
        .and_then(|c| read_sqlite(slug, &c));
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}{ext}", copy.display())));
    }
    src
}

fn read_sqlite(slug: &str, c: &rusqlite::Connection) -> Result<Source> {
    let version: Option<String> = c
        .query_row("SELECT val FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
        .ok();
    if version.as_deref().map(|v| v.trim() != "1").unwrap_or(false) {
        anyhow::bail!("{slug}: unsupported 2.x store schema {version:?}");
    }
    let rows = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<Vec<(String, String)>> {
        let mut q = c.prepare(sql)?;
        let out = q
            .query_map(p, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    };
    let doc = rows("SELECT key, val FROM doc", &[])?;
    let nodes = rows("SELECT id, val FROM nodes ORDER BY ord", &[])?;
    let mail_log = rows(
        "SELECT owner, val FROM (SELECT seq, owner, val, row_number() OVER (PARTITION BY owner ORDER BY seq DESC) AS rn
                                   FROM log_d WHERE sect = 'mail_log') WHERE rn <= ?1 ORDER BY seq",
        &[&(MAIL_LOG_PER_AGENT as i64)],
    )?;
    let mut logs = HashMap::new();
    for (sect, limit) in LOGS {
        let got = rows(
            "SELECT '', val FROM (SELECT seq, val FROM log_l WHERE sect = ?1 ORDER BY seq DESC LIMIT ?2) ORDER BY seq",
            &[sect, &limit.unwrap_or(-1)],
        )?;
        logs.insert(sect.to_string(), got.into_iter().map(|(_, v)| v).collect());
    }
    Ok(build(slug, doc, nodes, mail_log, logs))
}

/// A `Source` from the store's raw rows (the 2.x SQLite file and a 3.0/3.1
/// `org_<n>` schema hold the same five tables). Not logged: secret inside.
pub(crate) fn build(
    slug: &str,
    doc_rows: Vec<(String, String)>,
    nodes: Vec<(String, String)>,
    mail_log: Vec<(String, String)>,
    logs: HashMap<String, Vec<String>>,
) -> Source {
    let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
    let mut doc: Map<String, Value> = doc_rows.iter().map(|(k, v)| (k.clone(), parse(v))).collect();
    fold_split(&mut doc);
    Source {
        slug: slug.to_string(),
        doc,
        nodes: nodes.iter().map(|(k, v)| (k.clone(), parse(v))).collect(),
        mail_log: mail_log.iter().map(|(k, v)| (k.clone(), parse(v))).collect(),
        logs: logs.into_iter().map(|(k, v)| (k, v.iter().map(|x| parse(x)).collect())).collect(),
    }
}

/// Later stores keep some sections as one `doc` row per owner or item, keyed
/// `<section>\x1f<owner|slug>`: the mail, delivering and notices queues, and
/// the docket (a `work_items` header listing the slugs in order). Put them
/// back into the whole-section shape the copy reads.
fn fold_split(doc: &mut Map<String, Value>) {
    const SEP: char = '\u{1f}';
    let split: Vec<String> = doc.keys().filter(|k| k.contains(SEP)).cloned().collect();
    let mut owners: HashMap<String, Map<String, Value>> = HashMap::new();
    let mut items: HashMap<String, Value> = HashMap::new();
    for k in split {
        let v = doc.remove(&k).unwrap_or(Value::Null);
        let Some((sect, rest)) = k.split_once(SEP) else { continue };
        match sect {
            "work_items" => {
                items.insert(rest.to_string(), v);
            }
            "mail" | "delivering" | "notices" => {
                owners.entry(sect.to_string()).or_default().insert(rest.to_string(), v);
            }
            _ => {}
        }
    }
    for (sect, m) in owners {
        match doc.get_mut(&sect) {
            Some(Value::Object(base)) => base.extend(m),
            _ => {
                doc.insert(sect, Value::Object(m));
            }
        }
    }
    let header = doc
        .get("work_items")
        .filter(|h| h.get("format").and_then(Value::as_str) == Some("orgtree.work-items/v1"))
        .cloned();
    if let Some(h) = header {
        let list: Vec<Value> = strs(&h, "ids").iter().filter_map(|id| items.remove(id)).collect();
        doc.insert("work_items".into(), Value::Array(list));
    }
}

/// A pre-SQLite org document: the same sections, inline.
fn from_document(slug: &str, mut doc: Map<String, Value>) -> Source {
    let nodes = match doc.remove("nodes") {
        Some(Value::Object(m)) => m.into_iter().collect(),
        _ => Vec::new(),
    };
    let mut mail_log = Vec::new();
    if let Some(Value::Object(m)) = doc.remove("mail_log") {
        for (owner, list) in m {
            let list = list.as_array().cloned().unwrap_or_default();
            let skip = list.len().saturating_sub(MAIL_LOG_PER_AGENT);
            mail_log.extend(list.into_iter().skip(skip).map(|v| (owner.clone(), v)));
        }
    }
    let mut logs = HashMap::new();
    for (sect, limit) in LOGS {
        let list = doc.remove(*sect).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let skip = limit.map(|l| list.len().saturating_sub(l as usize)).unwrap_or(0);
        logs.insert(sect.to_string(), list.into_iter().skip(skip).collect());
    }
    Source { slug: slug.to_string(), doc, nodes, mail_log, logs }
}

// ---- small readers over JSON values ----

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}
fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
fn b(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(Value::as_bool)
}
fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}
fn t(v: &Value, k: &str) -> Option<DateTime<Utc>> {
    match v.get(k)? {
        Value::String(x) => parse_ts(x),
        Value::Number(n) => n.as_f64().and_then(|e| DateTime::from_timestamp(e as i64, (e.fract() * 1e9) as u32)),
        _ => None,
    }
}
fn obj(v: &Value, k: &str) -> Option<Value> {
    v.get(k).filter(|x| x.is_object()).cloned()
}
fn strs(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}
fn last<T: Clone>(v: &[T], n: usize) -> &[T] {
    &v[v.len().saturating_sub(n)..]
}

#[logged]
async fn copy_org(cfg: &Config, src: &Source, tx: &Transaction<'_>, uuid: &str) -> Result<usize> {
    let slug = src.slug.as_str();
    let doc = Value::Object(src.doc.clone());
    let org_id = insert_org(src, tx, uuid).await?;
    let ids = insert_agents(cfg, src, tx, org_id).await?;
    let n = ids.len();
    insert_mail_all(src, tx, org_id, &ids).await?;
    insert_asks(&doc, tx, org_id, &ids).await?;
    insert_docket(src, tx, org_id, &ids).await?;
    insert_rest(src, tx, org_id, &ids).await?;
    tracing::info!(org = %slug, agents = n, "organization copied");
    Ok(n)
}

/// The org row. Not logged: it reads the network identity secret.
async fn insert_org(src: &Source, tx: &Transaction<'_>, uuid: &str) -> Result<i64> {
    let d = Value::Object(src.doc.clone());
    let mut settings = Map::new();
    let mut put = |k: &str, v: Value| {
        if !v.is_null() {
            settings.insert(k.into(), v);
        }
    };
    let dirs: Vec<Value> = d["dirs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::String(p) => Some(json!({ "path": p, "mode": "rw" })),
                    Value::Object(_) => Some(json!({ "path": x["path"], "mode": x.get("mode").cloned().unwrap_or(json!("rw")) })),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    put("dirs", json!(dirs));
    for k in ["permission_mode", "default_visibility", "default_effort", "default_account"] {
        put(k, json!(s(&d, k)));
    }
    for k in ["max_top_grant", "default_top_grant", "compact_at"] {
        put(k, json!(f(&d, k)));
    }
    for k in ["cascade_hire", "cascade_alloc", "auto_resume", "auto_resume_compact", "org_inbox_multi_holder", "headless"] {
        put(k, json!(b(&d, k)));
    }
    let afd = d.get("account_fallback_default").cloned().unwrap_or(Value::Null);
    put("account_fallback_default", if afd.is_boolean() { afd } else { Value::Null });
    put("auto_cheap_compact", d.get("auto_cheap_compact").cloned().unwrap_or(Value::Null));
    put("default_tools", d.get("default_tools").cloned().unwrap_or(Value::Null));
    let name = s(&d, "name").unwrap_or_else(|| src.slug.clone());
    let created = t(&d, "created").unwrap_or_else(Utc::now);
    let hubs: Vec<Value> = d["net_hubs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|h| json!({ "id": s(h, "id").unwrap_or_else(|| uid("h")), "address": h.get("address"),
                                  "enabled": b(h, "enabled").unwrap_or(true), "name": h.get("name") }))
                .collect()
        })
        .unwrap_or_default();
    let net = json!({
        "autoconnect": b(&d, "net_autoconnect").unwrap_or(true),
        "identity": d.get("net_identity").cloned().unwrap_or(Value::Null),
        "hubs": hubs,
    });
    let killswitch = obj(&d, "killswitch");
    let org_id: i64 = tx
        .query_one(
            "INSERT INTO ot.orgs (uuid, slug, name, created_at, settings, killswitch, net)
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7) RETURNING id",
            &[&uuid, &src.slug, &name, &created, &Value::Object(settings), &killswitch, &net],
        )
        .await?
        .get(0);
    tx.execute("INSERT INTO ot.docket_versions (org_id, version) VALUES ($1, 1)", &[&org_id]).await?;
    Ok(org_id)
}

/// Agents (live and archived), their sessions and their recent turns.
/// Returns name -> new id.
#[logged]
async fn insert_agents(
    cfg: &Config,
    src: &Source,
    tx: &Transaction<'_>,
    org_id: i64,
) -> Result<HashMap<String, i64>> {
    let tiers = src.doc.get("tiers").cloned().unwrap_or(Value::Null);
    let scratch_root = cfg.scratch_root(&src.slug);
    let mut ids: HashMap<String, i64> = HashMap::new();
    let mut parents: Vec<(i64, String)> = Vec::new();
    for (name, n) in &src.nodes {
        let state = s(n, "state").unwrap_or_else(|| "archived".into());
        if !matches!(state.as_str(), "live" | "archived" | "unrecoverable") {
            continue;
        }
        let tier = s(n, "model").unwrap_or_else(|| "sonnet".into());
        let provider = catalog::provider_of(&tier);
        let (session, account) = match provider {
            catalog::OPENAI => (s(n, "codex_thread"), s(n, "codex_account").or_else(|| s(n, "account"))),
            catalog::GOOGLE => (s(n, "antigravity_conversation"), s(n, "antigravity_account").or_else(|| s(n, "account"))),
            _ => (s(n, "session_id"), if b(n, "account_primary") == Some(true) { None } else { s(n, "account") }),
        };
        let seat = f(&tiers, &tier).unwrap_or_else(|| catalog::seat_price(&tier));
        let scope = normalize_scope(n.get("scope"));
        let status = |k: &str| -> Option<Value> {
            let st = n.get(k).filter(|v| v.is_object())?;
            Some(json!({ "status": st.get("status"), "summary": st.get("summary"), "at": st.get("at") }))
        };
        let generation = i(n, "generation").unwrap_or(1);
        let born = s(n, "seat_id").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let scratch = scratch_root.join(name).to_string_lossy().to_string();
        let extra = json!({ "imported_from": { "store": "2.x", "org": src.slug, "id": name } });
        let created = t(n, "created").unwrap_or_else(Utc::now);
        let id: i64 = tx
            .query_one(
                "INSERT INTO ot.agents (org_id, name, sibling_order, state, title, charter, team_charter, tier, account,
                                        seat, grant_credits, scope, generation, born, provider, session_id,
                                        cost_usd, cost_unknown, context_window, occupancy, occupancy_est,
                                        compacted_unrun, last_status, prev_status, frozen, halt, pending_switch,
                                        limit_locked, created_at, archived_at, scratch_dir, extra)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::float8::numeric, $11::float8::numeric, $12, $13, $14, $15, $16,
                         $17::float8::numeric, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
                 RETURNING id",
                &[
                    &org_id,
                    name,
                    &f(n, "ui_order").unwrap_or(0.0),
                    &state,
                    &s(n, "title").unwrap_or_default(),
                    &s(n, "charter"),
                    &s(n, "team_charter"),
                    &tier,
                    &account,
                    &seat,
                    &f(n, "grant").unwrap_or(0.0),
                    &scope,
                    &(generation as i32),
                    &born,
                    &provider,
                    &session,
                    &f(n, "cost_usd").unwrap_or(0.0),
                    &b(n, "cost_usd_unknown").unwrap_or(false),
                    &i(n, "context_window").map(|v| v as i32),
                    &i(n, "occupancy").map(|v| v as i32),
                    &b(n, "occupancy_est").unwrap_or(false),
                    &b(n, "compacted_unrun").unwrap_or(false),
                    &status("last_status"),
                    &status("prev_status"),
                    &obj(n, "frozen").map(crate::runtime::freeze::normalize),
                    &obj(n, "halt"),
                    &obj(n, "pending_switch"),
                    &b(n, "limit_locked").unwrap_or(false),
                    &created,
                    &t(n, "archived_at"),
                    &scratch,
                    &extra,
                ],
            )
            .await
            .with_context(|| format!("agent {name}"))?
            .get(0);
        ids.insert(name.clone(), id);
        if let Some(p) = s(n, "parent") {
            parents.push((id, p));
        }
        if let Some(sid) = &session {
            tx.execute(
                "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id, started_at)
                 VALUES ($1, $2, $3, $4, $5)",
                &[&id, &(generation as i32), &provider, sid, &created],
            )
            .await?;
        }
        let turns = n.get("turns").and_then(Value::as_array).cloned().unwrap_or_default();
        for tr in last(&turns, TURNS_PER_AGENT) {
            tx.execute(
                "INSERT INTO ot.turns (agent_id, started_at, ended_at, cost_usd, ms, toks, denials, approvals, killed, estimated, cost_source)
                 VALUES ($1, $2, $2, $3::float8::numeric, $4, $5, $6, $7, $8, $9, $10)",
                &[
                    &id,
                    &t(tr, "at").unwrap_or_else(Utc::now),
                    &f(tr, "cost").unwrap_or(0.0),
                    &i(tr, "ms"),
                    &i(tr, "toks"),
                    &(i(tr, "denials").unwrap_or(0) as i32),
                    &i(tr, "approvals").map(|v| v as i32),
                    &b(tr, "killed").unwrap_or(false),
                    &b(tr, "estimated").unwrap_or(false),
                    &s(tr, "cost_source"),
                ],
            )
            .await?;
        }
    }
    for (child, parent) in &parents {
        if let Some(p) = ids.get(parent) {
            tx.execute("UPDATE ot.agents SET parent_id = $2 WHERE id = $1", &[child, p]).await?;
        }
    }
    Ok(ids)
}

/// 2.x scope with the defaults the 3.x importer fills in.
#[logged]
fn normalize_scope(raw: Option<&Value>) -> Value {
    let mut sc = raw.and_then(Value::as_object).cloned().unwrap_or_default();
    sc.remove("prefer_reserve");
    sc.entry("permission_mode").or_insert(json!("acceptEdits"));
    sc.entry("org_visibility").or_insert(json!("subtree"));
    let dirs: Vec<Value> = sc
        .get("add_dirs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::String(p) => Some(json!({ "path": p, "mode": "rw" })),
                    Value::Object(_) => Some(x.clone()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    sc.insert("add_dirs".into(), json!(dirs));
    let mut tools = sc.get("tools").and_then(Value::as_object).cloned().unwrap_or_default();
    for k in ["bash", "web", "edit", "subagents"] {
        tools.entry(k).or_insert(json!(true));
    }
    if !tools.get("mcp").map(Value::is_array).unwrap_or(false) {
        tools.insert("mcp".into(), json!([]));
    }
    sc.insert("tools".into(), Value::Object(tools));
    Value::Object(sc)
}

/// Pending, in-delivery and recent delivered agent mail; the user's inbox,
/// read log and sent mail.
#[logged]
async fn insert_mail_all(src: &Source, tx: &Transaction<'_>, org_id: i64, ids: &HashMap<String, i64>) -> Result<()> {
    // mail drained into a turn that never confirmed it goes back to pending
    if let Some(Value::Object(m)) = src.doc.get("delivering") {
        for (agent, batches) in m {
            for batch in batches.as_array().into_iter().flatten() {
                for msg in batch["mail"].as_array().into_iter().flatten() {
                    put_mail(tx, org_id, msg, "agent", ids.get(agent).copied(), agent, "pending", ids).await?;
                }
            }
        }
    }
    if let Some(Value::Object(m)) = src.doc.get("mail") {
        for (agent, list) in m {
            for msg in list.as_array().into_iter().flatten() {
                put_mail(tx, org_id, msg, "agent", ids.get(agent).copied(), agent, "pending", ids).await?;
            }
        }
    }
    for (agent, msg) in &src.mail_log {
        put_mail(tx, org_id, msg, "agent", ids.get(agent).copied(), agent, "delivered", ids).await?;
    }
    for msg in src.doc.get("user_inbox").and_then(Value::as_array).into_iter().flatten() {
        put_mail(tx, org_id, msg, "user", None, "@user", "pending", ids).await?;
    }
    for msg in src.logs.get("user_mail_log").into_iter().flatten() {
        put_mail(tx, org_id, msg, "user", None, "@user", "read", ids).await?;
    }
    for msg in src.logs.get("user_outbox").into_iter().flatten() {
        let to = s(msg, "to").unwrap_or_default();
        put_mail(tx, org_id, msg, "agent", ids.get(&to).copied(), &to, "delivered", ids).await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[logged]
async fn put_mail(
    tx: &Transaction<'_>,
    org_id: i64,
    m: &Value,
    recipient_kind: &str,
    recipient_agent: Option<i64>,
    recipient_name: &str,
    state: &str,
    ids: &HashMap<String, i64>,
) -> Result<()> {
    let sender = s(m, "from").unwrap_or_else(|| "@system".into());
    let kind = s(m, "kind").unwrap_or_else(|| "message".into());
    let body = s(m, "body").unwrap_or_default();
    // the old engine's restart notices are stale the moment it is replaced
    if state == "pending" && (body.starts_with("[ORGTREE RESTART NOTICE]") || b(m, "restart_notice") == Some(true)) {
        return Ok(());
    }
    if recipient_kind == "agent" && recipient_agent.is_none() {
        return Ok(());
    }
    let notice = matches!(kind.as_str(), "notice" | "status");
    let sender = if sender == "user" { "@user".to_string() } else { sender };
    let sender_agent = ids.get(&sender).copied();
    let created = t(m, "at").unwrap_or_else(Utc::now);
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, recipient_kind, recipient_agent_id, recipient_name,
                              kind, body, created_at, relationship, ev, state, delivered_at, urgent, urgent_reason, notice)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13::text,
                 CASE WHEN $13::text IN ('delivered', 'read') THEN $10::timestamptz END, $14, $15, $16)
         ON CONFLICT (uid) DO NOTHING",
        &[
            &s(m, "id").unwrap_or_else(|| uid("m")),
            &org_id,
            &sender,
            &sender_agent,
            &recipient_kind,
            &recipient_agent,
            &recipient_name,
            &kind,
            &crate::util::pg_text(&body).as_ref(),
            &created,
            &s(m, "relationship"),
            &crate::util::pg_json_option(&obj(m, "ev")).as_ref(),
            &state,
            &b(m, "urgent").unwrap_or(false),
            &crate::util::pg_text_option(&s(m, "urgent_reason")).as_ref(),
            &notice,
        ],
    )
    .await?;
    Ok(())
}

/// Questions, credit requests and scope requests. 4.0 keeps at most one
/// open request per agent, so an agent's open parts merge into one card.
#[logged]
async fn insert_asks(doc: &Value, tx: &Transaction<'_>, org_id: i64, ids: &HashMap<String, i64>) -> Result<()> {
    let open = |x: &Value| matches!(s(x, "status").as_deref(), None | Some("open") | Some("pending"));
    let questions_of = |x: &Value| -> Vec<Value> {
        match x.get("questions").and_then(Value::as_array) {
            Some(q) if !q.is_empty() => q.clone(),
            _ => {
                let mut q = Map::new();
                for k in ["question", "header", "options", "multi"] {
                    if let Some(v) = x.get(k) {
                        q.insert(k.into(), v.clone());
                    }
                }
                if q.is_empty() { Vec::new() } else { vec![Value::Object(q)] }
            }
        }
    };
    // open parts per agent, in order
    let mut order: Vec<String> = Vec::new();
    let mut parts: HashMap<String, OpenAsk> = HashMap::new();
    let asks = doc["asks"].as_array().cloned().unwrap_or_default();
    for a in asks.iter().filter(|a| open(a)) {
        let Some(node) = s(a, "node") else { continue };
        let e = slot(&mut order, &mut parts, &node, s(a, "id"), t(a, "at"));
        e.1.questions.extend(questions_of(a));
        e.3.extend(strs(a, "work_items"));
    }
    for c in doc["credit_requests"].as_array().into_iter().flatten().filter(|c| open(c)) {
        let Some(node) = s(c, "node") else { continue };
        let e = slot(&mut order, &mut parts, &node, s(c, "id"), t(c, "at"));
        e.1.credit = Some(json!({ "old": c.get("old"), "new": c.get("new"), "reason": c.get("reason") }));
    }
    for r in doc["scope_requests"].as_array().into_iter().flatten().filter(|r| open(r)) {
        let Some(node) = s(r, "node") else { continue };
        let e = slot(&mut order, &mut parts, &node, s(r, "id"), t(r, "at"));
        e.1.scope = Some(json!({ "items": r.get("items").cloned().unwrap_or(json!([])), "reason": r.get("reason") }));
    }
    for node in &order {
        let Some(agent) = ids.get(node).copied() else { continue };
        let (id, p, at, work) = &parts[node];
        let (kind, body) = compose(id, 1, p);
        put_ask(tx, org_id, agent, id, &kind, "open", &body, *at, None, None, None, None, work).await?;
    }
    // the newest resolved questions, for the record
    let resolved: Vec<&Value> = asks.iter().filter(|a| !open(a)).collect();
    for a in last(&resolved, RESOLVED_ASKS) {
        let Some(agent) = s(a, "node").and_then(|n| ids.get(&n).copied()) else { continue };
        let id = s(a, "id").unwrap_or_else(|| uid("a"));
        let p = Parts { questions: questions_of(a), credit: None, scope: None };
        let (kind, body) = compose(&id, i(a, "rev").unwrap_or(1) as i32, &p);
        put_ask(
            tx,
            org_id,
            agent,
            &id,
            &kind,
            &s(a, "status").unwrap_or_else(|| "answered".into()),
            &body,
            t(a, "at").unwrap_or_else(Utc::now),
            t(a, "resolved_at"),
            s(a, "reason"),
            a.get("answer").cloned(),
            s(a, "answer_mail"),
            &strs(a, "work_items"),
        )
        .await?;
    }
    Ok(())
}

/// One agent's open request being assembled: (uid, parts, asked at, work items).
type OpenAsk = (String, Parts, DateTime<Utc>, Vec<String>);

fn slot<'a>(
    order: &mut Vec<String>,
    parts: &'a mut HashMap<String, OpenAsk>,
    node: &str,
    id: Option<String>,
    at: Option<DateTime<Utc>>,
) -> &'a mut OpenAsk {
    if !parts.contains_key(node) {
        order.push(node.to_string());
    }
    parts
        .entry(node.to_string())
        .or_insert_with(|| (id.unwrap_or_else(|| uid("a")), Parts::default(), at.unwrap_or_else(Utc::now), Vec::new()))
}

#[allow(clippy::too_many_arguments)]
#[logged]
async fn put_ask(
    tx: &Transaction<'_>,
    org_id: i64,
    agent: i64,
    id: &str,
    kind: &str,
    status: &str,
    body: &Value,
    at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
    reason: Option<String>,
    answer: Option<Value>,
    answer_mail: Option<String>,
    work: &[String],
) -> Result<()> {
    tx.execute(
        "INSERT INTO ot.asks (uid, org_id, agent_id, kind, status, body, rev, created_at, resolved_at, reason, answer, answer_mail, work_items)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12) ON CONFLICT (uid) DO NOTHING",
        &[&id, &org_id, &agent, &kind, &status, body, &at, &resolved_at, &reason, &answer, &answer_mail, &work],
    )
    .await?;
    Ok(())
}

fn actor(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(n)) if n == "@user" || n == "user" => json!("user"),
        Some(Value::String(n)) => json!({ "node": n, "generation": 1 }),
        Some(Value::Object(o)) if o.contains_key("node") => Value::Object(o.clone()),
        _ => Value::Null,
    }
}

/// The docket: active items with their history, then archived items.
#[logged]
async fn insert_docket(src: &Source, tx: &Transaction<'_>, org_id: i64, ids: &HashMap<String, i64>) -> Result<()> {
    let active = src.doc.get("work_items").and_then(Value::as_array).cloned().unwrap_or_default();
    let archived = src.logs.get("work_items_archive").cloned().unwrap_or_default();
    for w in active.iter().chain(archived.iter()) {
        let Some(slug_w) = s(w, "slug") else { continue };
        let mut status = s(w, "status").unwrap_or_else(|| "open".into());
        let mut blocked = s(w, "blocked_reason");
        if status == "waiting" {
            status = "blocked".into();
            blocked = blocked.or_else(|| s(w, "waiting_reason"));
        }
        let owner = actor(w.get("owner"));
        let reviewer = actor(w.get("reviewer"));
        let created_by = match actor(w.get("created_by")) {
            Value::Null => json!("user"),
            a => a,
        };
        let last_updater = actor(w.get("last_updater"));
        let owner_id = owner.get("node").and_then(Value::as_str).and_then(|n| ids.get(n)).copied();
        let reviewer_id = reviewer.get("node").and_then(Value::as_str).and_then(|n| ids.get(n)).copied();
        let manual = obj(w, "manual_attention");
        let accepted = obj(w, "accepted");
        let created_at = t(w, "at").unwrap_or_else(Utc::now);
        let updated_at = t(w, "updated_at").unwrap_or(created_at);
        let docket_at = t(w, "docket_at");
        let mut archived_at = t(w, "archived_at");
        if archived_at.is_none()
            && manual.is_none()
            && (status == "dropped"
                || (matches!(status.as_str(), "done" | "superseded")
                    && docket_at.unwrap_or(updated_at) < Utc::now() - chrono::Duration::hours(1)))
        {
            archived_at = Some(docket_at.unwrap_or(updated_at));
        }
        // evidence becomes simple notes (ledger F3)
        let evidence: Vec<Value> = w["evidence"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| json!({ "at": e.get("at"), "by": e.get("by"), "kind": e.get("kind"), "ref": e.get("ref"), "note": e.get("note") }))
            .collect();
        let dismissals = w.get("dismissals").filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
        let as_list = |k: &str| w.get(k).filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
        let new_item: i64 = tx
            .query_opt(
                "INSERT INTO ot.work_items (org_id, slug, rev, kind, title, objective, status, blocked_reason, dropped_reason,
                                            owner, owner_agent_id, reviewer, reviewer_agent_id, created_by, last_updater,
                                            participants, parent, dependencies, superseded_by, done_so_far, working_on_next,
                                            manual_attention, dismissals, evidence, accepted, created_at, updated_at, docket_at,
                                            status_at, archived_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
                 ON CONFLICT (org_id, slug) DO NOTHING RETURNING id",
                &[
                    &org_id,
                    &slug_w,
                    &i(w, "rev").unwrap_or(1),
                    &s(w, "kind").unwrap_or_else(|| "code".into()),
                    &s(w, "title").unwrap_or_else(|| slug_w.clone()),
                    &s(w, "objective").unwrap_or_default(),
                    &status,
                    &blocked,
                    &s(w, "dropped_reason"),
                    &(Some(owner.clone()).filter(|v| !v.is_null())),
                    &owner_id,
                    &(Some(reviewer.clone()).filter(|v| !v.is_null())),
                    &reviewer_id,
                    &created_by,
                    &(Some(last_updater).filter(|v| !v.is_null())),
                    &strs(w, "participants"),
                    &s(w, "parent"),
                    &strs(w, "dependencies"),
                    &s(w, "superseded_by"),
                    &as_list("done_so_far"),
                    &as_list("working_on_next"),
                    &manual,
                    &dismissals,
                    &json!(evidence),
                    &accepted,
                    &created_at,
                    &updated_at,
                    &docket_at,
                    &t(w, "status_at"),
                    &archived_at,
                ],
            )
            .await
            .with_context(|| format!("work item {slug_w}"))?
            .map(|r| r.get::<_, i64>(0))
            .unwrap_or(0);
        if new_item == 0 || archived_at.is_some() {
            continue;
        }
        let mut events: Vec<(DateTime<Utc>, Value, String, Value)> = Vec::new();
        for h in w["history"].as_array().into_iter().flatten() {
            let mut detail = h.as_object().cloned().unwrap_or_default();
            detail.remove("at");
            let by = actor(detail.remove("by").as_ref());
            let op = detail.remove("op").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "update".into());
            events.push((t(h, "at").unwrap_or(created_at), by, op, Value::Object(detail)));
        }
        // rulings recorded on the item survive as history rows
        for d in w["scope"].as_array().into_iter().flatten().filter(|d| s(d, "kind").as_deref() == Some("decision")) {
            events.push((
                t(d, "at").unwrap_or(created_at),
                actor(d.get("by")),
                "decision".into(),
                json!({ "text": d.get("text"), "seq": d.get("seq"), "supersedes": d.get("supersedes") }),
            ));
        }
        events.sort_by_key(|e| e.0);
        for (at, by, op, detail) in last(&events, HISTORY_PER_ITEM) {
            tx.execute(
                "INSERT INTO ot.work_events (work_id, at, by, op, detail) VALUES ($1, $2, $3, $4, $5)",
                &[&new_item, at, &(if by.is_null() { json!("user") } else { by.clone() }), op, detail],
            )
            .await?;
        }
    }
    Ok(())
}

/// Documents, watchdogs, audiences, events and the org inbox.
#[logged]
async fn insert_rest(src: &Source, tx: &Transaction<'_>, org_id: i64, ids: &HashMap<String, i64>) -> Result<()> {
    for d in src.logs.get("documents").into_iter().flatten() {
        let node = s(d, "node").unwrap_or_default();
        let body = s(d, "body");
        let bytes = i(d, "bytes").unwrap_or_else(|| body.as_ref().map(|b| b.len() as i64).unwrap_or(0));
        tx.execute(
            "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (uid) DO NOTHING",
            &[
                &s(d, "id").unwrap_or_else(|| uid("d")),
                &org_id,
                &ids.get(&node).copied(),
                &node,
                &s(d, "title").unwrap_or_default(),
                &body,
                &s(d, "format").unwrap_or_else(|| "markdown".into()),
                &(bytes as i32),
                &t(d, "at").unwrap_or_else(Utc::now),
            ],
        )
        .await?;
    }
    for w in src.doc.get("watchdogs").and_then(Value::as_array).into_iter().flatten() {
        let state = s(w, "state").unwrap_or_else(|| "armed".into());
        if !matches!(state.as_str(), "armed" | "paused") {
            continue;
        }
        let Some(owner_id) = s(w, "owner").and_then(|o| ids.get(&o).copied()) else { continue };
        tx.execute(
            "INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, pattern, shell, interval_s,
                                       fire_mode, quiet_period_s, once, state, fired, created_at, last_check, last_fired, silence_since, memo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (uid) DO NOTHING",
            &[
                &s(w, "id").unwrap_or_else(|| uid("w")),
                &org_id,
                &owner_id,
                &s(w, "name").unwrap_or_default(),
                &s(w, "kind").unwrap_or_else(|| "file".into()),
                &s(w, "target").unwrap_or_default(),
                &s(w, "pattern"),
                &s(w, "shell"),
                &(i(w, "interval_s").unwrap_or(60) as i32),
                &s(w, "fire_mode").unwrap_or_else(|| "event".into()),
                &i(w, "quiet_period_s").map(|v| v as i32),
                &b(w, "once").unwrap_or(false),
                &state,
                &(i(w, "fired").unwrap_or(0) as i32),
                &t(w, "at").unwrap_or_else(Utc::now),
                &t(w, "last_check"),
                &t(w, "last_fired"),
                &t(w, "silence_since"),
                &crate::runtime::watchdogs::import_memo(w, &ids),
            ],
        )
        .await?;
    }
    for g in src.doc.get("audiences").and_then(Value::as_array).into_iter().flatten() {
        tx.execute(
            "INSERT INTO ot.audiences (org_id, grantee, grantor, granted_at, reason) VALUES ($1, $2, $3, $4, $5)",
            &[
                &org_id,
                &s(g, "grantee").unwrap_or_default(),
                &s(g, "grantor").unwrap_or_default(),
                &t(g, "granted_at").unwrap_or_else(Utc::now),
                &s(g, "reason").unwrap_or_default(),
            ],
        )
        .await?;
    }
    for q in src.doc.get("audience_requests").and_then(Value::as_array).into_iter().flatten() {
        if !matches!(s(q, "status").as_deref(), None | Some("pending")) {
            continue;
        }
        tx.execute(
            "INSERT INTO ot.audience_requests (org_id, requester, target, reason, at) VALUES ($1, $2, $3, $4, $5)",
            &[
                &org_id,
                &s(q, "node").unwrap_or_default(),
                &s(q, "target").unwrap_or_default(),
                &s(q, "reason").unwrap_or_default(),
                &t(q, "at").unwrap_or_else(Utc::now),
            ],
        )
        .await?;
    }
    for e in src.logs.get("events").into_iter().flatten() {
        let detail = e.get("detail").cloned().filter(|d| d.is_object()).unwrap_or(json!({}));
        let subject = detail
            .get("node")
            .or_else(|| detail.get("nid"))
            .and_then(Value::as_str)
            .and_then(|n| ids.get(n))
            .copied();
        tx.execute(
            "INSERT INTO ot.events (org_id, at, op, actor, subject_agent_id, detail) VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &org_id,
                &t(e, "at").unwrap_or_else(Utc::now),
                &s(e, "op").unwrap_or_default(),
                &s(e, "actor").unwrap_or_default(),
                &subject,
                &detail,
            ],
        )
        .await?;
    }
    for m in src.logs.get("org_inbox").into_iter().flatten() {
        tx.execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, at, by_name, state, state_at, net_id, read)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true) ON CONFLICT (uid) DO NOTHING",
            &[
                &s(m, "id").unwrap_or_else(|| uid("x")),
                &org_id,
                &s(m, "dir").unwrap_or_else(|| "in".into()),
                &s(m, "peer").unwrap_or_default(),
                &s(m, "body").unwrap_or_default(),
                &t(m, "at").unwrap_or_else(Utc::now),
                &s(m, "by"),
                &s(m, "state"),
                &t(m, "state_at"),
                &s(m, "net_id"),
            ],
        )
        .await?;
    }
    Ok(())
}

/// `accounts-registry.json` rows and their unexpired limit marks. API keys
/// live in the machine token store, not in this file.
#[logged]
pub(crate) async fn import_accounts(path: &Path, dst: &deadpool_postgres::Object) -> Result<usize> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(0) };
    let reg: Value = serde_json::from_str(&text).context("accounts-registry.json")?;
    let rows = reg["accounts"].as_array().cloned().unwrap_or_default();
    for (ord, r) in rows.iter().enumerate() {
        let Some(id) = s(r, "id") else { continue };
        let kind = if s(r, "mode").as_deref() == Some("apikey") {
            "apikey".to_string()
        } else {
            r["credential"].get("kind").and_then(Value::as_str).unwrap_or("managed").to_string()
        };
        let extra = json!({ "harness": r.get("harness"), "created_at": r.get("created_at"),
                            "registered_from": r.get("registered_from"), "origin_org": r.get("origin_org") });
        // a legacy org key keeps its org boundary (3.x registry.validate_binding)
        let origin_org = s(r, "origin_org").filter(|o| !o.is_empty());
        dst.execute(
            "INSERT INTO ot.accounts (id, provider, kind, label, config_dir, identity, auth, tint_ordinal, enabled, ord, extra, origin_org)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING",
            &[
                &id,
                &s(r, "provider").unwrap_or_else(|| "claude".into()),
                &kind,
                &s(r, "label").unwrap_or_default(),
                &r["credential"].get("path").and_then(Value::as_str),
                &obj(r, "identity").unwrap_or(json!({})),
                &s(r, "auth").unwrap_or_else(|| "unobserved".into()),
                &(i(r, "tint_ordinal").unwrap_or(0) as i32),
                &b(r, "enabled").unwrap_or(true),
                &(ord as i32),
                &extra,
                &origin_org,
            ],
        )
        .await?;
        for (pool, m) in r["marks"].as_object().into_iter().flatten() {
            let Some(until) = t(m, "until") else { continue };
            if until < Utc::now() {
                continue;
            }
            dst.execute(
                "INSERT INTO ot.account_marks (account, pool, until, win, provenance) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (account, pool) DO NOTHING",
                &[&id, pool, &until, &s(m, "window"), &s(m, "provenance").unwrap_or_else(|| "observed".into())],
            )
            .await?;
        }
    }
    Ok(rows.len())
}
