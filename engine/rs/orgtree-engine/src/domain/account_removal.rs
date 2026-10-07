//! Remove a secondary account only after every stored reference is rebound.
//! One short database transaction; provider and filesystem effects stay outside it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::changes::{self, Change};
use crate::engine::Engine;
use crate::providers::catalog;
use crate::refuse;
use crate::runtime::AgentMsg;

#[derive(Debug, Default)]
struct Outcome {
    rebound: Vec<Value>,
    agents: BTreeMap<i64, Vec<i64>>,
    live: Vec<(i64, i64)>,
    defaults: BTreeSet<i64>,
    orgs: BTreeSet<String>,
    app_default: bool,
}

/// The same boundary as 3.x, using 4.0's same-seat session/handoff model.
#[logged]
fn session_boundary(removed_provider: &str, tier: &str, session_provider: Option<&str>) -> bool {
    matches!(removed_provider, "openai" | "google")
        || matches!(catalog::provider_of(tier), "openai" | "google")
        || session_provider == Some("openai")
}

#[logged]
fn thaw_on_rebind(frozen: &Value) -> bool {
    matches!(frozen["cause"].as_str(), Some("account" | "auth" | "balance"))
        || frozen["untrusted"].as_bool() == Some(true)
}

#[logged]
fn rebound_queue(queue: &Value, id: &str, primary: &str, model_switch: bool) -> Value {
    let mut next = queue.clone();
    if next["account"].as_str() != Some(id) { return next; }
    if model_switch {
        let provider = catalog::provider_of(next["tier"].as_str().unwrap_or(""));
        if provider == catalog::OPENROUTER {
            if let Some(o) = next.as_object_mut() { o.remove("account"); }
        } else {
            next["account"] = json!(format!("{provider}/primary"));
        }
    } else {
        next["account"] = json!(primary);
    }
    next
}

#[logged]
fn retryable(error: &anyhow::Error) -> bool {
    error.chain().any(|e| e.downcast_ref::<tokio_postgres::Error>().and_then(|e| e.code())
        .map(|c| matches!(c.code(), "40001" | "40P01")).unwrap_or(false))
}

#[logged]
pub async fn remove(engine: &Arc<Engine>, id: &str) -> Result<Value> {
    // Metadata only. Filesystem canonicalization for primary protection is off-lock.
    let client = engine.db.get().await?;
    let row = client.query_opt("SELECT provider, config_dir FROM ot.accounts WHERE id = $1", &[&id]).await?;
    drop(client);
    let Some(row) = row else { refuse!(NotFound, "no account {id}"); };
    let provider: String = row.get(0);
    let config_dir: Option<String> = row.get(1);
    if id == crate::openrouter::ACCOUNT_ID || id.ends_with("/primary")
        || crate::accounts::ambient_dir(&provider, config_dir.as_deref()) {
        refuse!(Conflict, "{id} is a primary account and cannot be removed");
    }
    if !matches!(provider.as_str(), "claude" | "openai" | "google") {
        refuse!(Conflict, "{id} has no provider primary to move its bindings to");
    }
    let mut out = None;
    for attempt in 0..4 {
        match remove_once(engine, id, &provider, &config_dir).await {
            Ok(v) => { out = Some(v); break; }
            Err(e) if attempt < 3 && retryable(&e) => {
                tracing::warn!(account = id, attempt, "account removal conflicted; retrying entire transaction");
            }
            Err(e) => return Err(e),
        }
    }
    let out = out.expect("successful removal or early error");
    // Committed already: notification failures never pretend the deletion rolled back.
    if let Err(e) = engine.accounts.reload(engine).await {
        tracing::warn!(error = %e, "account removal committed; account snapshot refresh failed");
    }
    crate::accounts::publish(engine);
    if out.app_default {
        if let Err(e) = engine.settings.reload(&engine.db).await {
            tracing::warn!(error = %e, "account removal committed; defaults refresh failed");
        }
    }
    for (org_id, ids) in &out.agents {
        let mut ch = vec![Change::Events];
        ch.extend(ids.iter().flat_map(|id| [Change::Agent(*id), Change::History(*id)]));
        changes::notify_id(engine, *org_id, ch);
    }
    for org_id in &out.defaults { changes::notify_id(engine, *org_id, vec![Change::Org, Change::Events]); }
    if out.app_default {
        for org in engine.orgs.all() { changes::notify(engine, &org, vec![Change::Org]); }
    }
    for (org_id, id) in &out.live {
        if let Some(h) = engine.agents.get(*id) { h.send(AgentMsg::Reconfigured); }
        crate::runtime::wake(engine, *org_id, *id);
    }
    Ok(json!({ "removed": id, "rebound": out.rebound,
        "orgs": out.orgs, "app_default_rebound": out.app_default }))
}

#[logged]
async fn remove_once(engine: &Arc<Engine>, id: &str, provider: &str, config_dir: &Option<String>) -> Result<Outcome> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    // Reference triggers take KEY SHARE on this row. Exclusive lock drains
    // earlier binders and makes later stale choices wait, then fail after deletion.
    let row = tx.query_opt("SELECT provider, config_dir FROM ot.accounts WHERE id = $1 FOR UPDATE", &[&id]).await?;
    let Some(row) = row else { refuse!(NotFound, "no account {id}"); };
    if row.get::<_, String>(0) != provider || row.get::<_, Option<String>>(1) != *config_dir {
        refuse!(Conflict, "{id} changed while planning removal; retry");
    }
    let primary = format!("{provider}/primary");
    let mut out = Outcome::default();
    let mut after = 0i64;
    loop {
        let rows = tx.query(
            "SELECT a.id, a.org_id, a.name, a.state, a.tier, a.account, a.pending_account, a.pending_switch, a.frozen,
                    a.inflight_at IS NOT NULL, a.session_id,
                    (SELECT provider FROM ot.agent_sessions s WHERE s.agent_id = a.id AND s.session_id = a.session_id ORDER BY s.id DESC LIMIT 1), o.slug
             FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id > $2 AND
                (a.account = $1 OR a.pending_account->>'account' = $1 OR a.pending_switch->>'account' = $1)
             ORDER BY a.id LIMIT 128 FOR UPDATE OF a", &[&id, &after]).await?;
        if rows.is_empty() { break; }
        for r in rows {
            let aid: i64 = r.get(0);
            after = aid;
            let org_id: i64 = r.get(1);
            let slug: String = r.get(12);
            let name: String = r.get(2);
            let state: String = r.get(3);
            let tier: String = r.get(4);
            let bound = r.get::<_, Option<String>>(5).as_deref() == Some(id);
            let pa = r.get::<_, Option<Value>>(6).unwrap_or(Value::Null);
            let ps = r.get::<_, Option<Value>>(7).unwrap_or(Value::Null);
            let frozen = r.get::<_, Option<Value>>(8).unwrap_or(Value::Null);
            let live = state == "live";
            let boundary = live && bound && session_boundary(provider, &tier, r.get::<_, Option<String>>(11).as_deref());
            if live && bound {
                if catalog::provider_of(&tier) != provider {
                    refuse!(Conflict, "{name} cannot move to {primary}: its tier belongs to another provider");
                }
                let busy = r.get::<_, bool>(9)
                    || engine.agents.get(aid).map(|h| h.view.load()["busy"].as_bool() == Some(true)).unwrap_or(false)
                    || tx.query_one("SELECT EXISTS(SELECT 1 FROM ot.turns WHERE agent_id = $1 AND ended_at IS NULL)", &[&aid]).await?.get::<_, bool>(0);
                if busy && boundary {
                    refuse!(Conflict, "{name} is running a turn and requires a session boundary; removal succeeds once that turn ends");
                }
            }
            let next_pa = rebound_queue(&pa, id, &primary, false);
            let next_ps = rebound_queue(&ps, id, &primary, true);
            let thaw = live && bound && thaw_on_rebind(&frozen);
            tx.execute(
                "UPDATE ot.agents SET account = CASE WHEN $2 THEN NULL ELSE account END,
                  pending_account = $3, pending_switch = $4,
                  frozen = CASE WHEN $5 THEN NULL ELSE frozen END,
                  limit_locked = CASE WHEN $5 THEN false ELSE limit_locked END,
                  session_id = CASE WHEN $6 THEN NULL ELSE session_id END,
                  occupancy = CASE WHEN $6 THEN NULL ELSE occupancy END,
                  occupancy_est = CASE WHEN $6 THEN true ELSE occupancy_est END,
                  extra = CASE WHEN $6 THEN jsonb_set(extra - 'cache_receipt', '{handoff_due}', to_jsonb('your provider account was removed; continue on its primary account'::text)) ELSE extra END,
                  row_version = row_version + 1 WHERE id = $1",
                &[&aid, &bound, &Some(next_pa).filter(|v| !v.is_null()), &Some(next_ps).filter(|v| !v.is_null()), &thaw, &boundary]).await?;
            if boundary {
                tx.execute("UPDATE ot.agent_sessions SET ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'account removed') WHERE agent_id = $1 AND ended_at IS NULL", &[&aid]).await?;
            }
            let detail = json!({"node": name, "removed_account": id, "account": primary,
                "binding_rebound": bound, "session_boundary": boundary, "thawed": thaw,
                "pending_account_rebound": pa["account"].as_str() == Some(id),
                "pending_switch_rebound": ps["account"].as_str() == Some(id)});
            tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'account_removed', '@user', $2, $3)", &[&org_id, &aid, &detail]).await?;
            out.agents.entry(org_id).or_default().push(aid);
            out.orgs.insert(slug.clone());
            if bound {
                out.rebound.push(json!({"org": slug, "node": name, "state": state,
                    "session_boundary": boundary, "in_flight_turn": live && r.get::<_, bool>(9)}));
            }
            if live { out.live.push((org_id, aid)); }
        }
    }
    let mut after = 0i64;
    loop {
        let rows = tx.query("SELECT id, slug FROM ot.orgs WHERE id > $2 AND settings->>'default_account' = $1 ORDER BY id LIMIT 128 FOR UPDATE", &[&id, &after]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            let org_id: i64 = row.get(0);
            after = org_id;
            tx.execute("UPDATE ot.orgs SET settings = jsonb_set(settings, '{default_account}', to_jsonb($2::text)), row_version = row_version + 1 WHERE id = $1", &[&org_id, &primary]).await?;
            tx.execute("INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'account_default_rebound', '@user', $2)", &[&org_id, &json!({"removed_account":id,"account":primary})]).await?;
            out.defaults.insert(org_id);
            out.orgs.insert(row.get(1));
        }
    }
    out.app_default = tx.execute(
        "UPDATE ot.kv SET value = jsonb_set(value, '{defaults,default_account}', to_jsonb($2::text)), updated_at = now()
         WHERE key = 'app_settings' AND value #>> '{defaults,default_account}' = $1", &[&id, &primary]).await? > 0;
    tx.execute("DELETE FROM ot.account_marks WHERE account = $1", &[&id]).await?;
    tx.execute("INSERT INTO ot.removed_accounts (id, provider) VALUES ($1, $2)", &[&id, &provider]).await?;
    tx.execute("DELETE FROM ot.accounts WHERE id = $1", &[&id]).await?;
    tx.commit().await?;
    Ok(out)
}
