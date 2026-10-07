//! First-start import of 3.x data (the 3.2 per-org databases and the app
//! database) into the new schema. The old databases are opened read-only
//! and never changed, so going back to the old build always works.
//!
//! One transaction per org: a failed org leaves nothing behind and is
//! retried on the next start; imported orgs are skipped (matched by uuid).

use std::collections::HashMap;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde_json::{json, Map, Value};
use tokio_postgres::{Client, NoTls, Transaction};

use crate::config::Config;
use crate::pg::Cluster;
use crate::providers::catalog;
use crate::util::{iso, uid};

const MARKER: &str = "import_v1";

#[logged]
pub async fn run_if_needed(cfg: &Config, cluster: &Cluster, pool: &Pool, progress: &dyn Fn(&str)) -> Result<()> {
    let mut dst = pool.get().await?;
    if dst.query_opt("SELECT 1 FROM ot.meta WHERE key = $1", &[&MARKER]).await?.is_some() {
        return Ok(());
    }
    let (has_app, has_v30) = {
        let (c, conn) = cluster.connect_config("postgres").connect(NoTls).await?;
        let t = tokio::spawn(conn);
        let r = c.query_opt("SELECT 1 FROM pg_database WHERE datname = 'orgtree_app'", &[]).await?.is_some();
        let v30 = c.query_opt("SELECT 1 FROM pg_database WHERE datname = 'orgtree'", &[]).await?.is_some();
        drop(c);
        t.abort();
        (r, v30)
    };
    // 3.0/3.1 (one `orgtree` database) when there is no 3.2 data; a 2.x data
    // folder (SQLite) only when no 3.x database exists at all
    if !has_app {
        let failed = if has_v30 {
            crate::import30::run(cfg, cluster, &mut dst, progress).await?
        } else {
            crate::import2x::run(cfg, &mut dst, progress).await?
        };
        if failed > 0 {
            // leave the marker unset: the next start retries the failed orgs
            import_app_settings(cfg, &dst).await?;
            return Ok(());
        }
    }
    if has_app {
        progress("database-import");
        let (app, conn) = cluster.connect_config("orgtree_app").connect(NoTls).await?;
        let task = tokio::spawn(conn);
        app.batch_execute("SET default_transaction_read_only = on").await?;
        let orgs = app
            .query(
                "SELECT org_id, slug, org_uuid::text, database, created_at FROM orgtree.orgs
                  WHERE state = 'active' ORDER BY org_id",
                &[],
            )
            .await?;
        let mut failed = 0;
        for o in &orgs {
            let slug: String = o.get(1);
            let uuid: String = o.get(2);
            let db: String = o.get(3);
            let already = dst
                .query_opt("SELECT 1 FROM ot.orgs WHERE uuid = $1::text::uuid", &[&uuid])
                .await?
                .is_some();
            if already {
                continue;
            }
            progress(&format!("database-import {slug}"));
            match import_org(cfg, cluster, &mut dst, &slug, &uuid, &db).await {
                Ok(n) => tracing::info!(org = %slug, agents = n, "imported organization"),
                Err(e) => {
                    failed += 1;
                    tracing::error!(org = %slug, error = %format!("{e:#}"), "organization import failed")
                }
            }
        }
        if let Err(e) = import_accounts(&app, &dst).await {
            tracing::error!(error = %format!("{e:#}"), "account import failed");
        }
        drop(app);
        task.abort();
        if failed > 0 {
            // leave the marker unset: the next start retries the failed orgs
            import_app_settings(cfg, &dst).await?;
            return Ok(());
        }
    }
    import_app_settings(cfg, &dst).await?;
    dst.execute(
        "INSERT INTO ot.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        &[&MARKER, &json!({ "at": iso(Utc::now()) })],
    )
    .await?;
    Ok(())
}

fn opt_s(row: &tokio_postgres::Row, i: &str) -> Option<String> {
    row.try_get::<_, Option<String>>(i).ok().flatten()
}
fn opt_b(row: &tokio_postgres::Row, i: &str) -> Option<bool> {
    row.try_get::<_, Option<bool>>(i).ok().flatten()
}
fn opt_f(row: &tokio_postgres::Row, i: &str) -> Option<f64> {
    row.try_get::<_, Option<f64>>(i).ok().flatten()
}
fn opt_i(row: &tokio_postgres::Row, i: &str) -> Option<i64> {
    row.try_get::<_, Option<i64>>(i).ok().flatten()
}
fn opt_t(row: &tokio_postgres::Row, i: &str) -> Option<DateTime<Utc>> {
    row.try_get::<_, Option<DateTime<Utc>>>(i).ok().flatten()
}
fn opt_j(row: &tokio_postgres::Row, i: &str) -> Value {
    row.try_get::<_, Option<Value>>(i).ok().flatten().unwrap_or(Value::Null)
}

#[logged]
async fn import_org(
    cfg: &Config,
    cluster: &Cluster,
    dst: &mut deadpool_postgres::Object,
    slug: &str,
    uuid: &str,
    db: &str,
) -> Result<usize> {
    let (src, conn) = cluster.connect_config(db).connect(NoTls).await.with_context(|| format!("open {db}"))?;
    let task = tokio::spawn(conn);
    src.batch_execute("SET default_transaction_read_only = on").await?;
    let result = async {
        let tx = dst.transaction().await?;
        let n = copy_org(cfg, &src, &tx, slug, uuid, db).await?;
        import_org_accounts(&src, &tx, slug).await?;
        tx.commit().await?;
        Ok::<usize, anyhow::Error>(n)
    }
    .await;
    drop(src);
    task.abort();
    result
}

#[logged]
async fn copy_org(cfg: &Config, src: &Client, tx: &Transaction<'_>, slug: &str, uuid: &str, db: &str) -> Result<usize> {
    // ---- org row ----
    let s = src
        .query_one(
            "SELECT name, created, permission_mode, default_visibility, default_effort,
                    max_top_grant::float8 AS max_top_grant, default_top_grant::float8 AS default_top_grant,
                    compact_at::float8 AS compact_at, cascade_hire, cascade_alloc, auto_resume, auto_resume_compact,
                    auto_cheap_compact, default_tools, default_account, account_fallback_default,
                    org_inbox_multi_holder, fable_limit_policy, fable_filter_policy, fable_filter_model,
                    killswitch, net_autoconnect, net_identity, headless, workspace
               FROM orgtree.org_settings LIMIT 1",
            &[],
        )
        .await
        .context("org_settings")?;
    let dirs: Vec<Value> = src
        .query("SELECT path, mode FROM orgtree.org_dirs ORDER BY ord", &[])
        .await?
        .iter()
        .map(|r| json!({ "path": r.get::<_, String>(0), "mode": r.get::<_, Option<String>>(1).unwrap_or_else(|| "rw".into()) }))
        .collect();
    let mut settings = Map::new();
    let mut put = |k: &str, v: Value| {
        if !v.is_null() {
            settings.insert(k.into(), v);
        }
    };
    put("dirs", json!(dirs));
    put("permission_mode", json!(opt_s(&s, "permission_mode")));
    put("default_visibility", json!(opt_s(&s, "default_visibility")));
    put("default_effort", json!(opt_s(&s, "default_effort")));
    put("max_top_grant", json!(opt_f(&s, "max_top_grant")));
    put("default_top_grant", json!(opt_f(&s, "default_top_grant")));
    put("compact_at", json!(opt_f(&s, "compact_at")));
    put("cascade_hire", json!(opt_b(&s, "cascade_hire")));
    put("cascade_alloc", json!(opt_b(&s, "cascade_alloc")));
    put("auto_resume", json!(opt_b(&s, "auto_resume")));
    put("auto_resume_compact", json!(opt_b(&s, "auto_resume_compact")));
    put("auto_cheap_compact", opt_j(&s, "auto_cheap_compact"));
    put("default_tools", opt_j(&s, "default_tools"));
    put("default_account", json!(opt_s(&s, "default_account")));
    let afd = opt_j(&s, "account_fallback_default");
    put("account_fallback_default", if afd.is_boolean() { afd } else { Value::Null });
    put("org_inbox_multi_holder", json!(opt_b(&s, "org_inbox_multi_holder")));
    let headless = opt_j(&s, "headless");
    put("headless", if headless.is_boolean() { headless } else { Value::Null });
    let name = opt_s(&s, "name").unwrap_or_else(|| slug.to_string());
    let created = opt_t(&s, "created").unwrap_or_else(Utc::now);
    let hubs: Vec<Value> = src
        .query("SELECT public_id, address, enabled, name FROM orgtree.net_hubs ORDER BY ord", &[])
        .await
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    json!({ "id": r.get::<_, Option<String>>(0).unwrap_or_else(|| uid("h")),
                            "address": r.get::<_, Option<String>>(1),
                            "enabled": r.get::<_, Option<bool>>(2).unwrap_or(true),
                            "name": r.get::<_, Option<String>>(3) })
                })
                .collect()
        })
        .unwrap_or_default();
    let net = json!({
        "autoconnect": opt_b(&s, "net_autoconnect").unwrap_or(true),
        "identity": opt_j(&s, "net_identity"),
        "hubs": hubs,
    });
    let killswitch = opt_j(&s, "killswitch");
    let org_id: i64 = tx
        .query_one(
            "INSERT INTO ot.orgs (uuid, slug, name, created_at, settings, killswitch, net)
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7) RETURNING id",
            &[&uuid, &slug, &name, &created, &Value::Object(settings), &(if killswitch.is_object() { Some(killswitch) } else { None }), &net],
        )
        .await?
        .get(0);
    tx.execute("INSERT INTO ot.docket_versions (org_id, version) VALUES ($1, 1)", &[&org_id]).await?;

    // ---- tier prices (OpenRouter tiers carry their own) ----
    let prices: HashMap<String, f64> = src
        .query("SELECT key, value::float8 FROM orgtree.org_tier_prices", &[])
        .await
        .map(|rows| rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, Option<f64>>(1).unwrap_or(1.0))).collect())
        .unwrap_or_default();

    // ---- agents ----
    let rows = src
        .query(
            "SELECT a.id, a.name, a.parent_id, a.state, a.title, a.model, a.credit_grant::float8 AS grant,
                    a.generation, a.lineage_born, a.session_id, a.codex_thread, a.antigravity_conversation,
                    a.account, a.cost_usd::float8 AS cost_usd, a.cost_usd_unknown, a.context_window, a.occupancy,
                    a.occupancy_est, a.compacted_unrun, a.limit_locked,
                    a.scope_permission_mode, a.scope_org_visibility, a.scope_effort, a.scope_model_version,
                    a.scope_prefer_reserve, a.scope_account_fallback,
                    a.scope_tools_bash, a.scope_tools_web, a.scope_tools_edit, a.scope_tools_subagents,
                    a.last_status_status, a.last_status_summary, a.last_status_at,
                    a.prev_status_status, a.prev_status_summary, a.prev_status_at,
                    a.created, a.archived_at, a.ui_order::float8 AS ui_order,
                    t.charter, t.team_charter, r.frozen, r.halt, r.pending_switch,
                    (SELECT coalesce(json_agg(json_build_object('path', g.path, 'mode', g.mode) ORDER BY g.pos), '[]'::json)
                       FROM orgtree.agent_dir_grants g WHERE g.agent_id = a.id) AS dirs,
                    (SELECT coalesce(json_agg(m.value ORDER BY m.pos), '[]'::json)
                       FROM orgtree.agent_mcp_servers m WHERE m.agent_id = a.id) AS mcp
               FROM orgtree.agents a
               LEFT JOIN orgtree.agent_texts t ON t.agent_id = a.id
               LEFT JOIN orgtree.agent_runtime r ON r.agent_id = a.id
              WHERE NOT a.tombstone AND a.state IN ('live', 'archived', 'unrecoverable')
              ORDER BY a.id",
            &[],
        )
        .await
        .context("agents")?;
    let scratch_root = cfg.scratch_root(slug);
    let mut map: HashMap<i64, i64> = HashMap::new();
    let mut names: HashMap<i64, String> = HashMap::new();
    let mut parents: Vec<(i64, i64)> = Vec::new();
    for r in &rows {
        let old_id: i64 = r.get("id");
        let name: String = r.get("name");
        let tier = opt_s(r, "model").unwrap_or_else(|| "sonnet".into());
        let provider = catalog::provider_of(&tier);
        let session = match provider {
            catalog::OPENAI => opt_s(r, "codex_thread"),
            catalog::GOOGLE => opt_s(r, "antigravity_conversation"),
            _ => opt_s(r, "session_id"),
        };
        let seat = prices.get(&tier).copied().unwrap_or_else(|| catalog::seat_price(&tier));
        let mut tools = json!({
            "bash": opt_b(r, "scope_tools_bash").unwrap_or(true),
            "web": opt_b(r, "scope_tools_web").unwrap_or(true),
            "edit": opt_b(r, "scope_tools_edit").unwrap_or(true),
            "subagents": opt_b(r, "scope_tools_subagents").unwrap_or(true),
            "mcp": opt_j(r, "mcp"),
        });
        if !tools["mcp"].is_array() {
            tools["mcp"] = json!([]);
        }
        let mut scope = Map::new();
        scope.insert("permission_mode".into(), json!(opt_s(r, "scope_permission_mode").unwrap_or_else(|| "acceptEdits".into())));
        scope.insert("org_visibility".into(), json!(opt_s(r, "scope_org_visibility").unwrap_or_else(|| "subtree".into())));
        scope.insert("add_dirs".into(), opt_j(r, "dirs"));
        scope.insert("tools".into(), tools);
        if let Some(e) = opt_s(r, "scope_effort") {
            scope.insert("effort".into(), json!(e));
        }
        if let Some(v) = opt_s(r, "scope_model_version") {
            scope.insert("model_version".into(), json!(v));
        }
        if let Some(v) = opt_b(r, "scope_account_fallback") {
            scope.insert("account_fallback".into(), json!(v));
        }
        let status = |kind: &str| -> Value {
            match opt_s(r, &format!("{kind}_status_status")) {
                Some(st) => json!({
                    "status": st,
                    "summary": opt_s(r, &format!("{kind}_status_summary")),
                    "at": opt_t(r, &format!("{kind}_status_at")).map(iso),
                }),
                None => Value::Null,
            }
        };
        let frozen = crate::runtime::freeze::normalize(opt_j(r, "frozen"));
        let halt = opt_j(r, "halt");
        let pending_switch = opt_j(r, "pending_switch");
        let state: String = r.get("state");
        let born = opt_s(r, "lineage_born").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let scratch = scratch_root.join(&name).to_string_lossy().to_string();
        let extra = json!({ "imported_from": { "database": db, "id": old_id } });
        let created = opt_t(r, "created").unwrap_or_else(Utc::now);
        let new_id: i64 = tx
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
                    &name,
                    &opt_f(r, "ui_order").unwrap_or(0.0),
                    &state,
                    &opt_s(r, "title").unwrap_or_default(),
                    &opt_s(r, "charter"),
                    &opt_s(r, "team_charter"),
                    &tier,
                    &opt_s(r, "account"),
                    &seat,
                    &opt_f(r, "grant").unwrap_or(0.0),
                    &Value::Object(scope),
                    &(opt_i(r, "generation").unwrap_or(1) as i32),
                    &born,
                    &provider,
                    &session,
                    &opt_f(r, "cost_usd").unwrap_or(0.0),
                    &opt_b(r, "cost_usd_unknown").unwrap_or(false),
                    &opt_i(r, "context_window").map(|v| v as i32),
                    &opt_i(r, "occupancy").map(|v| v as i32),
                    &opt_b(r, "occupancy_est").unwrap_or(false),
                    &opt_b(r, "compacted_unrun").unwrap_or(false),
                    &(Some(status("last")).filter(|v| !v.is_null())),
                    &(Some(status("prev")).filter(|v| !v.is_null())),
                    &(Some(frozen).filter(|v| v.is_object())),
                    &(Some(halt).filter(|v| v.is_object())),
                    &(Some(pending_switch).filter(|v| v.is_object())),
                    &opt_b(r, "limit_locked").unwrap_or(false),
                    &created,
                    &opt_t(r, "archived_at"),
                    &scratch,
                    &extra,
                ],
            )
            .await
            .with_context(|| format!("agent {name}"))?
            .get(0);
        map.insert(old_id, new_id);
        names.insert(old_id, name);
        if let Some(p) = opt_i(r, "parent_id") {
            parents.push((new_id, p));
        }
        if let Some(sid) = &session {
            tx.execute(
                "INSERT INTO ot.agent_sessions (agent_id, generation, provider, session_id, started_at)
                 VALUES ($1, $2, $3, $4, $5)",
                &[&new_id, &(opt_i(r, "generation").unwrap_or(1) as i32), &provider, sid, &created],
            )
            .await?;
        }
    }
    for (child, old_parent) in &parents {
        if let Some(p) = map.get(old_parent) {
            tx.execute("UPDATE ot.agents SET parent_id = $2 WHERE id = $1", &[child, p]).await?;
        }
    }
    let agent_of = |old: Option<i64>| old.and_then(|o| map.get(&o).copied());
    let id_by_name: HashMap<String, i64> = names.iter().filter_map(|(old, n)| map.get(old).map(|id| (n.clone(), *id))).collect();

    // ---- recent turns (what the cards show) ----
    let turns = src
        .query(
            "SELECT agent_id, at, cost, ms, toks, denials, approvals, killed, estimated, cost_source FROM (
               SELECT t.*, row_number() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn FROM orgtree.agent_turns t) x
              WHERE rn <= 8 ORDER BY id",
            &[],
        )
        .await
        .unwrap_or_default();
    for t in &turns {
        let Some(agent) = agent_of(t.get::<_, Option<i64>>(0)) else { continue };
        tx.execute(
            "INSERT INTO ot.turns (agent_id, started_at, ended_at, cost_usd, ms, toks, denials, approvals, killed, estimated, cost_source)
             VALUES ($1, $2, $2, $3::float8::numeric, $4, $5, $6, $7, $8, $9, $10)",
            &[
                &agent,
                &t.get::<_, Option<DateTime<Utc>>>(1).unwrap_or_else(Utc::now),
                &t.get::<_, Option<f64>>(2).unwrap_or(0.0),
                &t.get::<_, Option<i64>>(3),
                &t.get::<_, Option<i64>>(4),
                &(t.get::<_, Option<i64>>(5).unwrap_or(0) as i32),
                &t.get::<_, Option<i64>>(6).map(|v| v as i32),
                &t.get::<_, Option<bool>>(7).unwrap_or(false),
                &t.get::<_, Option<bool>>(8).unwrap_or(false),
                &t.get::<_, Option<String>>(9),
            ],
        )
        .await?;
    }

    // ---- mail: pending per agent, recent delivered history ----
    let pending = src
        .query(
            r#"SELECT agent_id, public_id, "from", kind, body, at, relationship, ev FROM orgtree.mail ORDER BY agent_id, idx"#,
            &[],
        )
        .await
        .unwrap_or_default();
    for m in &pending {
        let Some(agent) = agent_of(m.get::<_, Option<i64>>(0)) else { continue };
        let to = names.iter().find(|(o, _)| map.get(o) == Some(&agent)).map(|(_, n)| n.clone()).unwrap_or_default();
        insert_mail(tx, org_id, &m, "agent", Some(agent), &to, "pending", &id_by_name).await?;
    }
    let delivered = src
        .query(
            r#"SELECT agent_id, public_id, "from", kind, body, at, relationship, ev FROM (
                 SELECT l.*, row_number() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn FROM orgtree.mail_log l) x
                WHERE rn <= 100 ORDER BY id"#,
            &[],
        )
        .await
        .unwrap_or_default();
    for m in &delivered {
        let Some(agent) = agent_of(m.get::<_, Option<i64>>(0)) else { continue };
        let to = names.iter().find(|(o, _)| map.get(o) == Some(&agent)).map(|(_, n)| n.clone()).unwrap_or_default();
        insert_mail(tx, org_id, &m, "agent", Some(agent), &to, "delivered", &id_by_name).await?;
    }
    // the user's inbox (unread), read log and sent mail
    let unread = src
        .query(
            r#"SELECT NULL::bigint, public_id, "from", kind, body, at, NULL::text, ev FROM orgtree.user_inbox ORDER BY ord"#,
            &[],
        )
        .await
        .unwrap_or_default();
    for m in &unread {
        insert_mail(tx, org_id, m, "user", None, "@user", "pending", &id_by_name).await?;
    }
    let read = src
        .query(
            r#"SELECT NULL::bigint, public_id, "from", kind, body, at, NULL::text, ev, urgent, urgent_reason
                 FROM orgtree.user_mail_log ORDER BY ord DESC LIMIT 500"#,
            &[],
        )
        .await
        .unwrap_or_default();
    for m in read.iter().rev() {
        insert_mail(tx, org_id, m, "user", None, "@user", "read", &id_by_name).await?;
    }
    let sent = src
        .query(
            r#"SELECT NULL::bigint, public_id, "from", kind, body, at, relationship, ev, "to"
                 FROM orgtree.user_outbox ORDER BY ord DESC LIMIT 500"#,
            &[],
        )
        .await
        .unwrap_or_default();
    for m in sent.iter().rev() {
        let to: Option<String> = m.get(8);
        let to = to.unwrap_or_default();
        let agent = id_by_name.get(&to).copied();
        insert_mail(tx, org_id, m, "agent", agent, &to, "delivered", &id_by_name).await?;
    }

    // ---- asks: open, and the newest resolved ones ----
    let asks = src
        .query(
            "SELECT public_id, node, kind, question, questions, at, header, rev, status, reason, answer, resolved_at,
                    answer_mail, extra,
                    (SELECT coalesce(json_agg(json_build_object('label', o.label, 'description', o.description) ORDER BY o.pos), '[]'::json)
                       FROM orgtree.ask_options o WHERE o.asks_id = k.id) AS options,
                    (SELECT coalesce(array_agg(w.value ORDER BY w.pos), '{}') FROM orgtree.ask_work_items w WHERE w.asks_id = k.id) AS work
               FROM orgtree.asks k
              WHERE status IN ('open', 'pending') OR k.id IN (SELECT id FROM orgtree.asks ORDER BY id DESC LIMIT 40)
              ORDER BY id",
            &[],
        )
        .await
        .unwrap_or_default();
    for k in &asks {
        let node: Option<String> = k.get(1);
        let Some(agent) = node.as_ref().and_then(|n| id_by_name.get(n)).copied() else { continue };
        let mut body = Map::new();
        if let Some(q) = k.get::<_, Option<String>>(3) {
            body.insert("question".into(), json!(q));
        }
        let qs: Option<Value> = k.get(4);
        if let Some(qs) = qs.filter(|v| v.is_array()) {
            body.insert("questions".into(), qs);
        }
        if let Some(h) = k.get::<_, Option<String>>(6) {
            body.insert("header".into(), json!(h));
        }
        let opts: Value = k.get(14);
        if opts.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body.insert("options".into(), opts);
        }
        let extra: Option<Value> = k.get(13);
        if let Some(Value::Object(e)) = extra {
            for (key, v) in e {
                body.entry(key).or_insert(v);
            }
        }
        let status: String = k.get::<_, Option<String>>(8).unwrap_or_else(|| "open".into());
        let status = if status == "pending" { "open".to_string() } else { status };
        let work: Vec<String> = k.get(15);
        tx.execute(
            "INSERT INTO ot.asks (uid, org_id, agent_id, kind, status, body, rev, created_at, resolved_at, reason, answer, answer_mail, work_items)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (uid) DO NOTHING",
            &[
                &k.get::<_, Option<String>>(0).unwrap_or_else(|| uid("a")),
                &org_id,
                &agent,
                &k.get::<_, Option<String>>(2).unwrap_or_else(|| "question".into()),
                &status,
                &Value::Object(body),
                &(k.get::<_, Option<i64>>(7).unwrap_or(1) as i32),
                &k.get::<_, Option<DateTime<Utc>>>(5).unwrap_or_else(Utc::now),
                &k.get::<_, Option<DateTime<Utc>>>(11),
                &k.get::<_, Option<String>>(9),
                &k.get::<_, Option<Value>>(10),
                &k.get::<_, Option<String>>(12),
                &work,
            ],
        )
        .await?;
    }

    // ---- docket ----
    let items = src
        .query(
            "SELECT w.id, w.slug, w.rev, w.kind, w.title, w.objective, w.status, w.blocked_reason, w.dropped_reason,
                    w.waiting_reason, w.owner_node, w.owner_generation, w.owner_born, w.reviewer_node, w.reviewer_generation,
                    w.reviewer_born, w.created_by_node, w.created_by_generation, w.last_updater_node,
                    w.last_updater_generation, w.at, w.updated_at, w.docket_at, w.status_at, w.archived_at, w.parent,
                    w.superseded_by, w.attention_reason, w.attention_at, w.attention_by_name, w.attention_by_generation,
                    w.attention_set_rev, w.accepted_at, w.accepted_by_name, w.accepted_note, w.created_by_is,
                    (SELECT coalesce(json_agg(d.value ORDER BY d.pos), '[]'::json) FROM orgtree.work_item_done d WHERE d.item_id = w.id) AS done,
                    (SELECT coalesce(json_agg(n.value ORDER BY n.pos), '[]'::json) FROM orgtree.work_item_next n WHERE n.item_id = w.id) AS next,
                    (SELECT coalesce(array_agg(p.value ORDER BY p.pos), '{}') FROM orgtree.work_item_participants p WHERE p.item_id = w.id) AS participants,
                    (SELECT coalesce(array_agg(x.value ORDER BY x.pos), '{}') FROM orgtree.work_item_dependencies x WHERE x.item_id = w.id) AS deps
               FROM orgtree.work_items w WHERE w.slug IS NOT NULL ORDER BY w.id",
            &[],
        )
        .await
        .context("work_items")?;
    let actor = |node: Option<String>, gen: Option<i64>, born: Option<String>| -> Value {
        match node {
            Some(n) if n == "@user" || n == "user" => json!("user"),
            Some(n) => {
                let mut o = json!({ "node": n, "generation": gen.unwrap_or(1) });
                if let Some(b) = born {
                    o["born"] = json!(b);
                }
                o
            }
            None => Value::Null,
        }
    };
    for w in &items {
        let old_item: i64 = w.get(0);
        let slug_w: String = w.get(1);
        let mut status: String = w.get::<_, Option<String>>(6).unwrap_or_else(|| "open".into());
        let mut blocked = w.get::<_, Option<String>>(7);
        if status == "waiting" {
            status = "blocked".into();
            blocked = blocked.or(w.get::<_, Option<String>>(9));
        }
        let owner = actor(w.get(10), w.get(11), w.get(12));
        let reviewer = actor(w.get(13), w.get(14), w.get(15));
        let created_by = {
            let a = actor(w.get(16), w.get(17), None);
            if a.is_null() {
                json!("user")
            } else {
                a
            }
        };
        let last_updater = actor(w.get(18), w.get(19), None);
        let owner_id = owner.get("node").and_then(Value::as_str).and_then(|n| id_by_name.get(n)).copied();
        let reviewer_id = reviewer.get("node").and_then(Value::as_str).and_then(|n| id_by_name.get(n)).copied();
        let manual = match w.get::<_, Option<String>>(27) {
            Some(reason) => json!({
                "reason": reason,
                "at": w.get::<_, Option<DateTime<Utc>>>(28).map(iso),
                "by": json!({ "node": w.get::<_, Option<String>>(29).unwrap_or_default(), "generation": w.get::<_, Option<i64>>(30).unwrap_or(1) }),
                "set_rev": w.get::<_, Option<i64>>(31).unwrap_or(1),
            }),
            None => Value::Null,
        };
        let accepted = match w.get::<_, Option<DateTime<Utc>>>(32) {
            Some(at) => json!({ "at": iso(at), "by": w.get::<_, Option<String>>(33).unwrap_or_default(), "note": w.get::<_, Option<String>>(34) }),
            None => Value::Null,
        };
        let created_at = w.get::<_, Option<DateTime<Utc>>>(20).unwrap_or_else(Utc::now);
        let updated_at = w.get::<_, Option<DateTime<Utc>>>(21).unwrap_or(created_at);
        let docket_at: Option<DateTime<Utc>> = w.get(22);
        let mut archived_at: Option<DateTime<Utc>> = w.get(24);
        if archived_at.is_none()
            && manual.is_null()
            && (status == "dropped"
                || (matches!(status.as_str(), "done" | "superseded")
                    && docket_at.unwrap_or(updated_at) < Utc::now() - chrono::Duration::hours(1)))
        {
            archived_at = Some(docket_at.unwrap_or(updated_at));
        }
        let new_item: i64 = tx
            .query_opt(
                "INSERT INTO ot.work_items (org_id, slug, rev, kind, title, objective, status, blocked_reason, dropped_reason,
                                            owner, owner_agent_id, reviewer, reviewer_agent_id, created_by, last_updater,
                                            participants, parent, dependencies, superseded_by, done_so_far, working_on_next,
                                            manual_attention, accepted, created_at, updated_at, docket_at, status_at, archived_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
                 ON CONFLICT (org_id, slug) DO NOTHING RETURNING id",
                &[
                    &org_id,
                    &slug_w,
                    &w.get::<_, Option<i64>>(2).unwrap_or(1),
                    &w.get::<_, Option<String>>(3).unwrap_or_else(|| "code".into()),
                    &w.get::<_, Option<String>>(4).unwrap_or_else(|| slug_w.clone()),
                    &w.get::<_, Option<String>>(5).unwrap_or_default(),
                    &status,
                    &blocked,
                    &w.get::<_, Option<String>>(8),
                    &(Some(owner.clone()).filter(|v| !v.is_null())),
                    &owner_id,
                    &(Some(reviewer.clone()).filter(|v| !v.is_null())),
                    &reviewer_id,
                    &created_by,
                    &(Some(last_updater).filter(|v| !v.is_null())),
                    &w.get::<_, Vec<String>>(38),
                    &w.get::<_, Option<String>>(25),
                    &w.get::<_, Vec<String>>(39),
                    &w.get::<_, Option<String>>(26),
                    &w.get::<_, Value>(36),
                    &w.get::<_, Value>(37),
                    &(Some(manual).filter(|v| !v.is_null())),
                    &(Some(accepted).filter(|v| !v.is_null())),
                    &created_at,
                    &updated_at,
                    &docket_at,
                    &w.get::<_, Option<DateTime<Utc>>>(23),
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
        // history of active items (bounded)
        let events = src
            .query(
                "SELECT at, by_node, by_generation, kind, content, history_op, history_status_from, history_status_to,
                        history_note, history_why
                   FROM orgtree.work_item_events WHERE item_id = $1 ORDER BY seq DESC LIMIT 200",
                &[&old_item],
            )
            .await
            .unwrap_or_default();
        for e in events.iter().rev() {
            let by = actor(e.get(1), e.get(2), None);
            let op = e.get::<_, Option<String>>(5).or(e.get::<_, Option<String>>(3)).unwrap_or_else(|| "update".into());
            let detail = json!({
                "content": e.get::<_, Option<String>>(4),
                "from": e.get::<_, Option<String>>(6),
                "to": e.get::<_, Option<String>>(7),
                "note": e.get::<_, Option<String>>(8).or(e.get::<_, Option<String>>(9)),
            });
            tx.execute(
                "INSERT INTO ot.work_events (work_id, at, by, op, detail) VALUES ($1, $2, $3, $4, $5)",
                &[&new_item, &e.get::<_, Option<DateTime<Utc>>>(0).unwrap_or_else(Utc::now), &(if by.is_null() { json!("user") } else { by }), &op, &detail],
            )
            .await?;
        }
    }

    // ---- documents ----
    let docs = src
        .query(
            "SELECT public_id, node, title, body, at, format, bytes FROM orgtree.documents ORDER BY ord",
            &[],
        )
        .await
        .unwrap_or_default();
    for d in &docs {
        let node: String = d.get::<_, Option<String>>(1).unwrap_or_default();
        let body: Option<String> = d.get(3);
        let bytes = body.as_ref().map(|b| b.len() as i32).unwrap_or(0);
        tx.execute(
            "INSERT INTO ot.documents (uid, org_id, agent_id, node_name, title, body, format, bytes, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (uid) DO NOTHING",
            &[
                &d.get::<_, Option<String>>(0).unwrap_or_else(|| uid("d")),
                &org_id,
                &id_by_name.get(&node).copied(),
                &node,
                &d.get::<_, Option<String>>(2).unwrap_or_default(),
                &body,
                &d.get::<_, Option<String>>(5).unwrap_or_else(|| "markdown".into()),
                &d.get::<_, Option<i64>>(6).map(|b| b as i32).unwrap_or(bytes),
                &d.get::<_, Option<DateTime<Utc>>>(4).unwrap_or_else(Utc::now),
            ],
        )
        .await?;
    }

    // ---- watchdogs ----
    const DOG_SQL: &str = "SELECT public_id, owner, name, kind, target, pattern, interval_s, state, at, fired, last_check, last_fired,
                    once, shell, fire_mode, quiet_period_s, silence_since";
    const DOG_FROM: &str = " FROM orgtree.watchdogs WHERE state IN ('armed', 'paused') ORDER BY ord";
    // the progress columns too; a store without them still imports the dogs
    let full = src
        .query(
            &format!("{DOG_SQL}, notice, high_water::jsonb, checks_run, last_output, paused_why, last_exit{DOG_FROM}"),
            &[],
        )
        .await;
    let has_memo = full.is_ok();
    let dogs = match full {
        Ok(rows) => rows,
        Err(_) => src.query(&format!("{DOG_SQL}{DOG_FROM}"), &[]).await.unwrap_or_default(),
    };
    for w in &dogs {
        let owner: String = w.get::<_, Option<String>>(1).unwrap_or_default();
        let Some(owner_id) = id_by_name.get(&owner).copied() else { continue };
        let mut legacy = json!({
            "kind": w.get::<_, Option<String>>(3),
            "target": w.get::<_, Option<String>>(4),
        });
        if has_memo {
            legacy["notice"] = json!(w.get::<_, Option<bool>>(17));
            legacy["high_water"] = w.get::<_, Option<Value>>(18).unwrap_or(Value::Null);
            legacy["checks_run"] = json!(w.get::<_, Option<i64>>(19));
            legacy["last_output"] = json!(w.get::<_, Option<String>>(20));
            legacy["paused_why"] = json!(w.get::<_, Option<String>>(21));
            legacy["last_exit"] = json!(w.get::<_, Option<i64>>(22));
        }
        tx.execute(
            "INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, pattern, shell, interval_s,
                                       fire_mode, quiet_period_s, once, state, fired, created_at, last_check, last_fired, silence_since, memo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (uid) DO NOTHING",
            &[
                &w.get::<_, Option<String>>(0).unwrap_or_else(|| uid("w")),
                &org_id,
                &owner_id,
                &w.get::<_, Option<String>>(2).unwrap_or_default(),
                &w.get::<_, Option<String>>(3).unwrap_or_else(|| "file".into()),
                &w.get::<_, Option<String>>(4).unwrap_or_default(),
                &w.get::<_, Option<String>>(5),
                &w.get::<_, Option<String>>(13),
                &(w.get::<_, Option<i64>>(6).unwrap_or(60) as i32),
                &w.get::<_, Option<String>>(14).unwrap_or_else(|| "event".into()),
                &w.get::<_, Option<i64>>(15).map(|v| v as i32),
                &w.get::<_, Option<bool>>(12).unwrap_or(false),
                &w.get::<_, Option<String>>(7).unwrap_or_else(|| "armed".into()),
                &(w.get::<_, Option<i64>>(9).unwrap_or(0) as i32),
                &w.get::<_, Option<DateTime<Utc>>>(8).unwrap_or_else(Utc::now),
                &w.get::<_, Option<DateTime<Utc>>>(10),
                &w.get::<_, Option<DateTime<Utc>>>(11),
                &w.get::<_, Option<DateTime<Utc>>>(16),
                &crate::runtime::watchdogs::import_memo(&legacy, &id_by_name),
            ],
        )
        .await?;
    }

    // ---- audiences ----
    let grants = src
        .query("SELECT grantee, grantor, granted_at, reason FROM orgtree.audience_grants ORDER BY ord", &[])
        .await
        .unwrap_or_default();
    for g in &grants {
        tx.execute(
            "INSERT INTO ot.audiences (org_id, grantee, grantor, granted_at, reason) VALUES ($1, $2, $3, $4, $5)",
            &[
                &org_id,
                &g.get::<_, Option<String>>(0).unwrap_or_default(),
                &g.get::<_, Option<String>>(1).unwrap_or_default(),
                &g.get::<_, Option<DateTime<Utc>>>(2).unwrap_or_else(Utc::now),
                &g.get::<_, Option<String>>(3).unwrap_or_default(),
            ],
        )
        .await?;
    }
    let reqs = src
        .query("SELECT node, target, reason, at FROM orgtree.audience_requests WHERE status = 'pending' OR status IS NULL", &[])
        .await
        .unwrap_or_default();
    for q in &reqs {
        tx.execute(
            "INSERT INTO ot.audience_requests (org_id, requester, target, reason, at) VALUES ($1, $2, $3, $4, $5)",
            &[
                &org_id,
                &q.get::<_, Option<String>>(0).unwrap_or_default(),
                &q.get::<_, Option<String>>(1).unwrap_or_default(),
                &q.get::<_, Option<String>>(2).unwrap_or_default(),
                &q.get::<_, Option<DateTime<Utc>>>(3).unwrap_or_else(Utc::now),
            ],
        )
        .await?;
    }

    // ---- events (the newest 5000) ----
    let events = src
        .query("SELECT op, actor, at, detail FROM orgtree.events ORDER BY ord DESC LIMIT 5000", &[])
        .await
        .unwrap_or_default();
    for e in events.iter().rev() {
        let detail: Value = e.get::<_, Option<Value>>(3).unwrap_or(json!({}));
        let subject = detail
            .get("node")
            .or_else(|| detail.get("nid"))
            .and_then(Value::as_str)
            .and_then(|n| id_by_name.get(n))
            .copied();
        tx.execute(
            "INSERT INTO ot.events (org_id, at, op, actor, subject_agent_id, detail) VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &org_id,
                &e.get::<_, Option<DateTime<Utc>>>(2).unwrap_or_else(Utc::now),
                &e.get::<_, Option<String>>(0).unwrap_or_default(),
                &e.get::<_, Option<String>>(1).unwrap_or_default(),
                &subject,
                &detail,
            ],
        )
        .await?;
    }

    // ---- org inbox ----
    let inbox = src
        .query(
            "SELECT public_id, dir, peer, body, at, by, state, state_at, net_id FROM orgtree.org_inbox ORDER BY ord DESC LIMIT 2000",
            &[],
        )
        .await
        .unwrap_or_default();
    for m in inbox.iter().rev() {
        tx.execute(
            "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, at, by_name, state, state_at, net_id, read)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true) ON CONFLICT (uid) DO NOTHING",
            &[
                &m.get::<_, Option<String>>(0).unwrap_or_else(|| uid("x")),
                &org_id,
                &m.get::<_, Option<String>>(1).unwrap_or_else(|| "in".into()),
                &m.get::<_, Option<String>>(2).unwrap_or_default(),
                &m.get::<_, Option<String>>(3).unwrap_or_default(),
                &m.get::<_, Option<DateTime<Utc>>>(4).unwrap_or_else(Utc::now),
                &m.get::<_, Option<String>>(5),
                &m.get::<_, Option<String>>(6),
                &m.get::<_, Option<DateTime<Utc>>>(7),
                &m.get::<_, Option<String>>(8),
            ],
        )
        .await?;
    }
    Ok(rows.len())
}

#[allow(clippy::too_many_arguments)]
async fn insert_mail(
    tx: &Transaction<'_>,
    org_id: i64,
    m: &tokio_postgres::Row,
    recipient_kind: &str,
    recipient_agent: Option<i64>,
    recipient_name: &str,
    state: &str,
    id_by_name: &HashMap<String, i64>,
) -> Result<()> {
    let sender: String = m.get::<_, Option<String>>(2).unwrap_or_else(|| "@system".into());
    let kind: String = m.get::<_, Option<String>>(3).unwrap_or_else(|| "message".into());
    let body: String = m.get::<_, Option<String>>(4).unwrap_or_default();
    // the old engine's restart notices are stale the moment it is replaced
    if state == "pending" && body.starts_with("[ORGTREE RESTART NOTICE]") {
        return Ok(());
    }
    let notice = matches!(kind.as_str(), "notice" | "status");
    let sender_norm = if sender == "user" { "@user".to_string() } else { sender.clone() };
    let sender_agent = id_by_name.get(&sender_norm).copied();
    let urgent = m.try_get::<_, Option<bool>>(8).ok().flatten().unwrap_or(false);
    let urgent_reason = m.try_get::<_, Option<String>>(9).ok().flatten();
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, recipient_kind, recipient_agent_id, recipient_name,
                              kind, body, created_at, relationship, ev, state, delivered_at, urgent, urgent_reason, notice)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13::text,
                 CASE WHEN $13::text IN ('delivered', 'read') THEN $10::timestamptz END, $14, $15, $16)
         ON CONFLICT (uid) DO NOTHING",
        &[
            &m.get::<_, Option<String>>(1).unwrap_or_else(|| uid("m")),
            &org_id,
            &sender_norm,
            &sender_agent,
            &recipient_kind,
            &recipient_agent,
            &recipient_name,
            &kind,
            &crate::util::pg_text(&body).as_ref(),
            &m.get::<_, Option<DateTime<Utc>>>(5).unwrap_or_else(Utc::now),
            &m.get::<_, Option<String>>(6),
            &crate::util::pg_json_option(&m.get::<_, Option<Value>>(7).filter(|v| !v.is_null())).as_ref(),
            &state,
            &urgent,
            &crate::util::pg_text_option(&urgent_reason).as_ref(),
            &notice,
        ],
    )
    .await?;
    Ok(())
}

/// The legacy org keys restricted to this org: 3.x kept them in the org's own
/// database (org_accounts), never in the app database. They keep their
/// origin_org so no other org can list, bind or spend them.
#[logged]
async fn import_org_accounts(src: &Client, tx: &Transaction<'_>, slug: &str) -> Result<()> {
    let present: bool = src
        .query_one("SELECT to_regclass('orgtree.org_accounts') IS NOT NULL AND to_regclass('orgtree.org_account_marks') IS NOT NULL", &[])
        .await?
        .get(0);
    if !present {
        return Ok(());
    }
    let rows = src
        .query(
            "SELECT id, ord, provider, label, credential_kind, credential_path, identity::jsonb, auth, mode, enabled,
                    tint_ordinal, extra::jsonb, origin_org
               FROM orgtree.org_accounts WHERE NOT coalesce(removing, false) ORDER BY ord",
            &[],
        )
        .await?;
    for r in &rows {
        let mode: Option<String> = r.get(8);
        let kind = if mode.as_deref() == Some("apikey") {
            "apikey".to_string()
        } else {
            r.get::<_, Option<String>>(4).unwrap_or_else(|| "managed".into())
        };
        let origin = r.get::<_, Option<String>>(12).filter(|o| !o.is_empty()).unwrap_or_else(|| slug.to_string());
        tx.execute(
            "INSERT INTO ot.accounts (id, provider, kind, label, config_dir, identity, auth, tint_ordinal, enabled, ord, extra, origin_org)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING",
            &[
                &r.get::<_, String>(0),
                &r.get::<_, Option<String>>(2).unwrap_or_else(|| "claude".into()),
                &kind,
                &r.get::<_, Option<String>>(3).unwrap_or_default(),
                &r.get::<_, Option<String>>(5),
                &r.get::<_, Option<Value>>(6).unwrap_or(json!({})),
                &r.get::<_, Option<String>>(7).unwrap_or_else(|| "unobserved".into()),
                &(r.get::<_, Option<i64>>(10).unwrap_or(0) as i32),
                &r.get::<_, Option<bool>>(9).unwrap_or(true),
                &r.get::<_, i32>(1),
                &r.get::<_, Option<Value>>(11).unwrap_or(json!({})),
                &origin,
            ],
        )
        .await?;
    }
    let marks = src
        .query("SELECT account_id, pool, until, \"window\", provenance FROM orgtree.org_account_marks", &[])
        .await?;
    for m in &marks {
        let until: Option<f64> = m.get(2);
        let Some(until) = until.and_then(|u| DateTime::from_timestamp(u as i64, 0)) else { continue };
        if until < Utc::now() {
            continue;
        }
        tx.execute(
            "INSERT INTO ot.account_marks (account, pool, until, win, provenance) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (account, pool) DO NOTHING",
            &[
                &m.get::<_, String>(0),
                &m.get::<_, String>(1),
                &until,
                &m.get::<_, Option<String>>(3),
                &m.get::<_, Option<String>>(4).unwrap_or_else(|| "observed".into()),
            ],
        )
        .await?;
    }
    if !rows.is_empty() {
        tracing::info!(org = %slug, accounts = rows.len(), "imported org-restricted accounts");
    }
    Ok(())
}

#[logged]
async fn import_accounts(app: &Client, dst: &Client) -> Result<()> {
    let rows = app
        .query(
            "SELECT id, ord, provider, harness, label, credential_kind, credential_path, identity, auth, mode, enabled,
                    tint_ordinal, extra
               FROM orgtree.accounts WHERE NOT coalesce(removing, false) ORDER BY ord",
            &[],
        )
        .await?;
    for r in &rows {
        let mode: Option<String> = r.get(9);
        let kind = if mode.as_deref() == Some("apikey") {
            "apikey".to_string()
        } else {
            r.get::<_, Option<String>>(5).unwrap_or_else(|| "managed".into())
        };
        dst.execute(
            "INSERT INTO ot.accounts (id, provider, kind, label, config_dir, identity, auth, tint_ordinal, enabled, ord, extra)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING",
            &[
                &r.get::<_, String>(0),
                &r.get::<_, Option<String>>(2).unwrap_or_else(|| "claude".into()),
                &kind,
                &r.get::<_, Option<String>>(4).unwrap_or_default(),
                &r.get::<_, Option<String>>(6),
                &r.get::<_, Option<Value>>(7).unwrap_or(json!({})),
                &r.get::<_, Option<String>>(8).unwrap_or_else(|| "unobserved".into()),
                &(r.get::<_, Option<i64>>(11).unwrap_or(0) as i32),
                &r.get::<_, Option<bool>>(10).unwrap_or(true),
                &r.get::<_, Option<i32>>(1).unwrap_or(0),
                &r.get::<_, Option<Value>>(12).unwrap_or(json!({})),
            ],
        )
        .await?;
    }
    let marks = app
        .query("SELECT account_id, pool, until, \"window\", provenance FROM orgtree.account_marks", &[])
        .await
        .unwrap_or_default();
    for m in &marks {
        let until: Option<f64> = m.get(2);
        let Some(until) = until.and_then(|u| DateTime::from_timestamp(u as i64, 0)) else { continue };
        if until < Utc::now() {
            continue;
        }
        dst.execute(
            "INSERT INTO ot.account_marks (account, pool, until, win, provenance) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (account, pool) DO NOTHING",
            &[
                &m.get::<_, String>(0),
                &m.get::<_, Option<String>>(1).unwrap_or_else(|| "default".into()),
                &until,
                &m.get::<_, Option<String>>(3),
                &m.get::<_, Option<String>>(4).unwrap_or_else(|| "observed".into()),
            ],
        )
        .await?;
    }
    Ok(())
}

/// `app-settings.json` → `ot.kv/app_settings` (first start only).
#[logged]
async fn import_app_settings(cfg: &Config, dst: &Client) -> Result<()> {
    let have = dst.query_opt("SELECT 1 FROM ot.kv WHERE key = 'app_settings'", &[]).await?.is_some();
    if have {
        return Ok(());
    }
    let doc = std::fs::read_to_string(cfg.path("app-settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    dst.execute("INSERT INTO ot.kv (key, value) VALUES ('app_settings', $1) ON CONFLICT DO NOTHING", &[&doc]).await?;
    Ok(())
}
