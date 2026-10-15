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
    /// (org, agent, name, mail uid): a released freeze's held request, queued
    /// as the agent's wake in the removal's own transaction
    replayed: Vec<(i64, i64, String, String)>,
}

/// The same boundary as 3.x, using 4.0's same-seat session/handoff model.
/// A Muse session lives in its login's own data root, so a seat moved off a
/// Muse login starts a new one too.
#[logged]
fn session_boundary(removed_provider: &str, tier: &str, session_provider: Option<&str>) -> bool {
    matches!(removed_provider, "openai" | "google" | "muse")
        || matches!(catalog::provider_of(tier), "openai" | "google" | "muse")
        || matches!(session_provider, Some("openai" | "muse"))
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

/// A queued intent that named the removed login, naming `to` instead, or no
/// account at all.
#[logged]
fn requeue(queue: &Value, to: Option<String>) -> Value {
    let mut next = queue.clone();
    match (to, next.as_object_mut()) {
        (Some(a), Some(_)) => next["account"] = json!(a),
        (None, Some(o)) => {
            o.remove("account");
        }
        _ => {}
    }
    next
}

/// Where a Muse seat of `org_slug` running `tier` (pinned `version`) goes
/// when the login it names, `removed`, is removed (independent review R3
/// 2026-10-13, under the coordinator's reassign-or-freeze ruling): the user's
/// own login first, as every provider's removal rebinds to it, then the other
/// registered subscriptions in registry order. Each only where it passes
/// every continuation gate (the org's account list, provider and login
/// activation, sign-in, re-authentication, marks, a full window) and its own
/// catalog offers the exact model. Never an API key: a removal makes no paid
/// move. Ok(None) is the own login; Err says why no login can take it.
/// Published snapshots and catalog reads only (read before the transaction).
#[logged]
fn muse_target(engine: &Engine, org_slug: &str, tier: &str, version: Option<&str>, removed: &str)
    -> std::result::Result<Option<String>, String> {
    let own = match crate::runtime::freeze::admits(engine, org_slug, tier, version, &crate::org_accounts::primary(catalog::MUSE)) {
        Ok(()) => return Ok(None),
        Err(e) => e.to_string(),
    };
    let view = engine.accounts.view();
    for to in view.continue_candidates(tier, Some(removed), org_slug) {
        if view.get(&to).is_some_and(|a| !a.is_apikey())
            && crate::runtime::freeze::admits(engine, org_slug, tier, version, &to).is_ok()
        {
            return Ok(Some(to));
        }
    }
    Err(format!(
        "no Muse login this org may use can run {} now: the user's own login cannot ({}), no other subscription login \
         offers it and passes every check, and a removal never moves an agent onto an API key",
        catalog::model_for(tier, version),
        own.trim_end_matches("; nothing changed")
    ))
}

/// Before a Muse login's removal: every other registered Muse subscription
/// login whose last read is not recent, and the user's own login when
/// discovery holds no catalog, are read at once (each bounded to 10 s), so
/// the transaction judges current catalogs and waits on no provider.
#[logged]
async fn muse_read_logins(engine: &Arc<Engine>, removed: &str) {
    let logins: Vec<crate::accounts::AccountInfo> = engine.accounts.view().all().into_iter()
        .filter(|a| a.provider == catalog::MUSE && a.id != removed && a.enabled && !a.is_apikey())
        .cloned()
        .collect();
    // a profile is read in its own roots: no org is needed (only a key's is)
    let reads = futures::future::join_all(logins.iter().map(|a| crate::providers::muse_login_refresh(engine, a, "")));
    tokio::join!(reads, crate::providers::muse_own_refresh(engine));
}

#[logged]
fn retryable(error: &anyhow::Error) -> bool {
    error.chain().any(|e| e.downcast_ref::<tokio_postgres::Error>().and_then(|e| e.code())
        .map(|c| matches!(c.code(), "40001" | "40P01" | "55P03")).unwrap_or(false))
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
    // every OpenRouter key is alike: its own reassignment-or-freeze path
    if provider == catalog::OPENROUTER {
        return remove_key(engine, id).await;
    }
    if id.ends_with("/primary") || crate::accounts::ambient_dir(&provider, config_dir.as_deref()) {
        refuse!(Conflict, "{id} is a primary account and cannot be removed");
    }
    // a Muse login's agents move to a login whose own catalog offers their
    // model (`muse_target`); every other provider's to its own login
    if !matches!(provider.as_str(), "claude" | "openai" | "google" | "muse") {
        refuse!(Conflict, "{id} has no provider primary to move its bindings to");
    }
    if provider == catalog::MUSE {
        muse_read_logins(engine, id).await;
    }
    let mut out = None;
    for attempt in 0..4 {
        match remove_once(engine, id, &provider, &config_dir).await {
            Ok(v) => { out = Some(v); break; }
            Err(e) if attempt < 3 && retryable(&e) => {
                tracing::warn!(account = id, attempt, "account removal conflicted; retrying entire transaction");
                // remove_once has rolled back and released account/agent locks.
                // Let an org-first folder/settings writer complete before the
                // next bounded attempt; never sleep while holding those rows.
                tokio::time::sleep(std::time::Duration::from_millis(25 << attempt)).await;
            }
            Err(e) => return Err(e),
        }
    }
    let out = out.expect("successful removal or early error");
    if provider == catalog::MUSE {
        crate::usage::forget_muse(engine, config_dir.as_deref());
    }
    announce(engine, &out).await;
    Ok(json!({ "removed": id, "rebound": out.rebound,
        "orgs": out.orgs, "app_default_rebound": out.app_default }))
}

/// After a committed removal: the registry snapshot, defaults and every
/// touched org and agent follow. Committed already: notification failures
/// never pretend the deletion rolled back.
#[logged]
async fn announce(engine: &Arc<Engine>, out: &Outcome) {
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
        let mut ch = vec![Change::Events, Change::Asks, Change::Docket];
        ch.extend(ids.iter().flat_map(|id| [Change::Agent(*id), Change::History(*id)]));
        changes::notify_id(engine, *org_id, ch);
    }
    for org_id in &out.defaults { changes::notify_id(engine, *org_id, vec![Change::Org, Change::Events]); }
    if out.app_default {
        for org in engine.orgs.all() { changes::notify(engine, &org, vec![Change::Org]); }
    }
    // a held request given back is committed mail: published as continue-on's
    for (org_id, aid, name, uid) in &out.replayed {
        changes::notify_id(engine, *org_id, vec![Change::Mailbox(*aid), Change::Spark { from: "@system".into(), to: name.clone() },
            Change::EngineEvent(crate::runtime::watchdogs::events::event("mail.waiting",
                crate::runtime::watchdogs::events::Scope::Agent(*org_id, *aid), json!({"agent_id": aid, "mail_id": uid})))]);
    }
    for (org_id, id) in &out.live {
        if let Some(h) = engine.agents.get(*id) { h.send(AgentMsg::Reconfigured); }
        crate::runtime::wake(engine, *org_id, *id);
    }
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
    // per (org, tier, pinned version): where a removed Muse login's seat goes
    let mut muse_targets: BTreeMap<(String, String, Option<String>), std::result::Result<Option<String>, String>> = BTreeMap::new();
    let mut after = 0i64;
    loop {
        let rows = tx.query(
            "SELECT a.id, a.org_id, a.name, a.state, a.tier, a.account, a.pending_account, a.pending_switch, a.frozen,
                    a.inflight_at IS NOT NULL, a.session_id,
                    (SELECT provider FROM ot.agent_sessions s WHERE s.agent_id = a.id AND s.session_id = a.session_id ORDER BY s.id DESC LIMIT 1), o.slug,
                    a.scope
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
            // every provider's references go to its own login; a Muse login's
            // to a login whose own catalog offers the model each one runs
            let (binding, next_pa, next_ps, stranded) = if provider == catalog::MUSE {
                let pin = crate::domain::scope::normalize(&r.get::<_, Value>(13)).get("model_version").and_then(Value::as_str)
                    .filter(|v| !v.is_empty()).map(str::to_string);
                let mut to = |t: &str| muse_targets.entry((slug.clone(), t.to_string(), pin.clone()))
                    .or_insert_with(|| muse_target(engine, &slug, t, pin.as_deref(), id)).clone();
                // a live seat's binding: the first login that can take it, else
                // none and it waits frozen, saying why; a seat that is not live
                // goes to the own login as for every provider, and is judged
                // on the login it lands on when it is rehired
                let (binding, stranded) = match live && bound {
                    true => match to(&tier) {
                        Ok(login) => (login, None),
                        Err(why) => (None, Some(why)),
                    },
                    false => (None, None),
                };
                // a queued account move runs the tier the seat will run when
                // it lands (a queued switch's, as the account op judges it);
                // with no login to take it, it is dropped
                let lands = ps["tier"].as_str().filter(|t| catalog::is_muse(t)).unwrap_or(&tier).to_string();
                let next_pa = match pa["account"].as_str() == Some(id) {
                    true => match to(&lands) {
                        Ok(login) => requeue(&pa, Some(login.unwrap_or_else(|| primary.clone()))),
                        Err(_) => Value::Null,
                    },
                    false => pa.clone(),
                };
                // a queued switch naming it names the first login that offers
                // its model, else none: it lands where the seat is, judged
                // there as any switch is
                let next_ps = match (ps["account"].as_str() == Some(id), ps["tier"].as_str().filter(|t| catalog::is_muse(t))) {
                    (true, Some(t)) => requeue(&ps, to(t).ok().map(|login| login.unwrap_or_else(|| primary.clone()))),
                    _ => rebound_queue(&ps, id, &primary, true),
                };
                (binding, next_pa, next_ps, stranded)
            } else {
                (None, rebound_queue(&pa, id, &primary, false), rebound_queue(&ps, id, &primary, true), None)
            };
            // no login can run a live seat: its freeze says why and replaces
            // any it had (keeping the request that one held), since waiting
            // for a reset or a list change could not make it run
            let wait = stranded.as_ref().map(|why| {
                let mut rec = json!({
                    "at": crate::util::now_iso(), "until": null, "limit": false, "cause": "account", "account": primary,
                    "error": format!("the Muse account {id} was removed and {why}; continue the agent on a Muse login that offers it \
                                      (App settings › Providers › Muse lists what each login offers)"),
                    "wake_text": "You now run on a Muse login that offers your model. Continue where you left off." });
                if let Some(held) = frozen.get("resume_texts").filter(|t| t.is_array()) {
                    rec["resume_texts"] = held.clone();
                }
                rec
            });
            let thaw = live && bound && thaw_on_rebind(&frozen) && wait.is_none();
            let lands_on = binding.clone().unwrap_or_else(|| primary.clone());
            let handoff = match (provider == catalog::MUSE, &binding, wait.is_some()) {
                (true, _, true) => format!("your Muse account {id} was removed; you continue on a Muse login that offers your model"),
                (true, Some(login), false) => format!("your Muse account {id} was removed; you continue on the Muse account {login}"),
                (true, None, false) => format!("your Muse account {id} was removed; you continue on the user's own Muse login"),
                _ => "your provider account was removed; continue on its primary account".to_string(),
            };
            tx.execute(
                "UPDATE ot.agents SET account = CASE WHEN $2 THEN $8 ELSE account END,
                  pending_account = $3, pending_switch = $4,
                  frozen = CASE WHEN $7::jsonb IS NOT NULL THEN $7::jsonb WHEN $5 THEN NULL ELSE frozen END,
                  limit_locked = CASE WHEN $5 THEN false ELSE limit_locked END,
                  session_id = CASE WHEN $6 THEN NULL ELSE session_id END,
                  occupancy = CASE WHEN $6 THEN NULL ELSE occupancy END,
                  occupancy_est = CASE WHEN $6 THEN true ELSE occupancy_est END,
                  extra = CASE WHEN $6 THEN jsonb_set(extra - 'cache_receipt', '{handoff_due}', to_jsonb($9::text)) ELSE extra END,
                  row_version = row_version + 1 WHERE id = $1",
                &[&aid, &bound, &Some(next_pa.clone()).filter(|v| !v.is_null()), &Some(next_ps.clone()).filter(|v| !v.is_null()),
                  &thaw, &boundary, &wait, &binding, &handoff]).await?;
            if boundary {
                tx.execute("UPDATE ot.agent_sessions SET ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'account removed') WHERE agent_id = $1 AND ended_at IS NULL", &[&aid]).await?;
                crate::domain::asks::moot_for_fresh_session(&tx, aid,
                    "the asking session was replaced when its account was removed; the fresh session never posed it").await?;
            }
            // a Muse seat's freeze released by this move gives back the request
            // it held (a removal freeze keeps a refused turn's request), as its
            // wake mail in this same transaction, as continue-on does: never
            // lost, never queued twice by a rolled-back and retried attempt
            // (independent review R4, 2026-10-13)
            let replayed = if provider == catalog::MUSE && thaw && crate::runtime::freeze::holds_request(&frozen) {
                let wake = format!("Your Muse account {id} was removed; you now run on the account {lands_on}. Continue where you left off.");
                Some(crate::runtime::freeze::queue_replay(&tx, org_id, aid, &name, &wake, &frozen).await?)
            } else {
                None
            };
            let detail = json!({"node": name, "removed_account": id, "account": lands_on,
                "binding_rebound": bound, "session_boundary": boundary, "thawed": thaw, "frozen": wait.is_some(),
                "replayed": replayed.is_some(),
                "pending_account_rebound": pa["account"].as_str() == Some(id),
                "pending_switch_rebound": ps["account"].as_str() == Some(id),
                "pending_account": next_pa["account"], "pending_switch_account": next_ps["account"]});
            tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'account_removed', '@user', $2, $3)", &[&org_id, &aid, &detail]).await?;
            out.agents.entry(org_id).or_default().push(aid);
            out.orgs.insert(slug.clone());
            if bound {
                out.rebound.push(json!({"org": slug, "node": name, "state": state, "account": lands_on,
                    "session_boundary": boundary, "in_flight_turn": live && r.get::<_, bool>(9),
                    "frozen": wait.is_some(), "replayed": replayed.is_some(), "reason": stranded}));
            }
            if let Some(uid) = replayed {
                out.replayed.push((org_id, aid, name.clone(), uid));
            }
            if live { out.live.push((org_id, aid)); }
        }
    }
    let mut after = 0i64;
    loop {
        // Account reference protection deliberately starts at the account row,
        // then bound agents. Do not wait here for an org-first folder/settings
        // writer that may own this org and await one of those agents. NOWAIT
        // aborts this whole attempt (55P03), releasing all provisional changes
        // and locks before remove() retries it. No new global lock/order pin.
        let rows = match tx.query("SELECT id, slug FROM ot.orgs WHERE id > $2 AND settings->>'default_account' = $1 ORDER BY id LIMIT 128 FOR UPDATE NOWAIT", &[&id, &after]).await {
            Ok(rows) => rows,
            Err(error) => {
                // Confirm lock release before the retry backoff, rather than
                // relying on Transaction::drop to enqueue a later rollback.
                tx.rollback().await?;
                return Err(error.into());
            }
        };
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
    if provider == catalog::MUSE {
        tx.execute("DELETE FROM ot.kv WHERE key = $1", &[&crate::usage::muse_cache::key(id)]).await?;
    }
    tx.execute("INSERT INTO ot.removed_accounts (id, provider) VALUES ($1, $2)", &[&id, &provider]).await?;
    tx.execute("DELETE FROM ot.accounts WHERE id = $1", &[&id]).await?;
    tx.commit().await?;
    Ok(out)
}

// ------------------------------------------------------------ an OpenRouter key

/// Remove an OpenRouter key, any key alike (user 2026-10-14 18:00Z: no key
/// is special), through the reassignment-or-freeze path (ruling
/// 2026-10-11): every seat it bills (one bound to it, an unbound one when
/// it is the first key, and queued intents naming it) moves to another
/// stored key it may run on, in key order, checked as a continuation is; a
/// live seat with none freezes, saying so, until it is continued on a key.
/// An org or app default naming it is cleared (no key is a provider's own
/// login). The id is retired: no later key gets it. One short transaction;
/// nothing waits on a provider.
#[logged]
pub async fn remove_key(engine: &Arc<Engine>, id: &str) -> Result<Value> {
    let mut out = None;
    for attempt in 0..4 {
        match remove_key_once(engine, id).await {
            Ok(v) => { out = Some(v); break; }
            Err(e) if attempt < 3 && retryable(&e) => {
                tracing::warn!(attempt, key = id, "OpenRouter key removal conflicted; retrying entire transaction");
                // the attempt has rolled back and released its key/seat locks
                // (as `remove`): let an org-first writer finish first
                tokio::time::sleep(std::time::Duration::from_millis(25 << attempt)).await;
            }
            Err(e) => return Err(e),
        }
    }
    let (out, frozen) = out.expect("successful removal or early error");
    announce(engine, &out).await;
    Ok(json!({ "removed": id, "rebound": out.rebound, "frozen": frozen,
        "orgs": out.orgs, "app_default_rebound": out.app_default }))
}

/// The freeze a seat gets when its OpenRouter key went and no other key may
/// take it.
#[logged]
fn no_key_left(org_slug: &str, id: &str) -> Value {
    json!({ "at": crate::util::now_iso(), "until": null, "limit": false, "cause": "account",
            "account": id,
            "error": format!("the OpenRouter key {id} was removed and the org {org_slug} has no other OpenRouter key \
                              this agent could run on; add or switch on a key (App settings › Providers, Org settings › Accounts), \
                              then continue the agent on it") })
}

#[logged]
async fn remove_key_once(engine: &Arc<Engine>, id: &str) -> Result<(Outcome, Vec<Value>)> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    // reference triggers take KEY SHARE on this row: binders drain first
    if tx.query_opt("SELECT 1 FROM ot.accounts WHERE id = $1 AND provider = 'openrouter' FOR UPDATE", &[&id]).await?.is_none() {
        refuse!(NotFound, "no OpenRouter key {id}");
    }
    // unbound seats bill the first key: only its removal moves them
    let first = crate::openrouter::first_key(engine).as_deref() == Some(id);
    let mut out = Outcome::default();
    let mut frozen_out = Vec::new();
    // per (org, tier): the first other key a continuation would accept
    let mut targets: BTreeMap<(String, String), Option<String>> = BTreeMap::new();
    let mut after = 0i64;
    loop {
        let rows = tx.query(
            "SELECT a.id, a.org_id, a.name, a.state, a.tier, a.account, a.pending_account, a.pending_switch, a.frozen,
                    a.inflight_at IS NOT NULL, a.session_id,
                    (SELECT provider FROM ot.agent_sessions s WHERE s.agent_id = a.id AND s.session_id = a.session_id ORDER BY s.id DESC LIMIT 1), o.slug
             FROM ot.agents a JOIN ot.orgs o ON o.id = a.org_id WHERE a.id > $1 AND
                ((a.tier LIKE 'or-%' AND (a.account = $2
                   OR ($3 AND (a.account IS NULL OR a.account IN ('', 'primary', 'default', 'openrouter/primary')))))
                 OR a.pending_account->>'account' = $2 OR a.pending_switch->>'account' = $2)
             ORDER BY a.id LIMIT 128 FOR UPDATE OF a", &[&after, &id, &first]).await?;
        if rows.is_empty() { break; }
        for r in rows {
            let aid: i64 = r.get(0);
            after = aid;
            let org_id: i64 = r.get(1);
            let name: String = r.get(2);
            let state: String = r.get(3);
            let tier: String = r.get(4);
            let account: Option<String> = r.get(5);
            let pa = r.get::<_, Option<Value>>(6).unwrap_or(Value::Null);
            let ps = r.get::<_, Option<Value>>(7).unwrap_or(Value::Null);
            let frozen = r.get::<_, Option<Value>>(8).unwrap_or(Value::Null);
            let slug: String = r.get(12);
            let live = state == "live";
            let names_original = |v: &Value| v["account"].as_str() == Some(id);
            // the seat bills this key now (bound to it, or unbound on the first key)
            let billed = catalog::is_openrouter(&tier) && crate::openrouter::seat_key(engine, account.as_deref()) == id;
            let target = if billed || names_original(&pa) || names_original(&ps) {
                targets.entry((slug.clone(), tier.clone())).or_insert_with(|| {
                    engine.accounts.view().continue_candidates(&tier, Some(id), &slug).into_iter()
                        .find(|id| crate::runtime::freeze::eligible(engine, &slug, &tier, id))
                }).clone()
            } else {
                None
            };
            let boundary = live && billed && target.is_some()
                && session_boundary(catalog::OPENROUTER, &tier, r.get::<_, Option<String>>(11).as_deref());
            if boundary {
                let busy = r.get::<_, bool>(9)
                    || engine.agents.get(aid).map(|h| h.view.load()["busy"].as_bool() == Some(true)).unwrap_or(false)
                    || tx.query_one("SELECT EXISTS(SELECT 1 FROM ot.turns WHERE agent_id = $1 AND ended_at IS NULL)", &[&aid]).await?.get::<_, bool>(0);
                if busy {
                    refuse!(Conflict, "{name} is running a turn and requires a session boundary; removal succeeds once that turn ends");
                }
            }
            // a queued intent naming the key names the target, or no
            // key at all (a queued switch then bills whatever key is stored)
            let requeue = |q: &Value| -> Option<Value> {
                if q.is_null() { return None; }
                if !names_original(q) { return Some(q.clone()); }
                let mut next = q.clone();
                match (&target, next.as_object_mut()) {
                    (Some(t), Some(_)) => next["account"] = json!(t),
                    (None, Some(o)) => { o.remove("account"); }
                    _ => {}
                }
                Some(next)
            };
            let next_pa = if names_original(&pa) && target.is_none() { None } else { requeue(&pa) };
            let next_ps = requeue(&ps);
            // the binding: the target, or none (an explicit binding to the
            // key goes with it; a seat left without a key freezes)
            let rebind = billed && (target.is_some() || account.is_some());
            let next_account = if billed { target.clone() } else { account.clone() };
            let thaw = live && billed && target.is_some() && thaw_on_rebind(&frozen);
            let freeze = live && billed && target.is_none() && frozen.is_null();
            let freeze_rec = freeze.then(|| no_key_left(&slug, id));
            tx.execute(
                "UPDATE ot.agents SET account = CASE WHEN $2 THEN $3 ELSE account END,
                  pending_account = $4, pending_switch = $5,
                  frozen = CASE WHEN $6 THEN NULL WHEN $7::jsonb IS NOT NULL THEN $7::jsonb ELSE frozen END,
                  limit_locked = CASE WHEN $6 THEN false ELSE limit_locked END,
                  session_id = CASE WHEN $8 THEN NULL ELSE session_id END,
                  occupancy = CASE WHEN $8 THEN NULL ELSE occupancy END,
                  occupancy_est = CASE WHEN $8 THEN true ELSE occupancy_est END,
                  extra = CASE WHEN $8 THEN jsonb_set(extra - 'cache_receipt', '{handoff_due}', to_jsonb('your OpenRouter key was removed; continue on another key'::text)) ELSE extra END,
                  row_version = row_version + 1 WHERE id = $1",
                &[&aid, &rebind, &next_account, &next_pa, &next_ps, &thaw, &freeze_rec, &boundary]).await?;
            if boundary {
                tx.execute("UPDATE ot.agent_sessions SET ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'account removed') WHERE agent_id = $1 AND ended_at IS NULL", &[&aid]).await?;
                crate::domain::asks::moot_for_fresh_session(&tx, aid,
                    "the asking session was replaced when its account was removed; the fresh session never posed it").await?;
            }
            let detail = json!({"node": name, "removed_account": id, "account": target,
                "binding_rebound": rebind, "session_boundary": boundary, "thawed": thaw, "frozen": freeze,
                "pending_account_rebound": names_original(&pa), "pending_switch_rebound": names_original(&ps)});
            tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'account_removed', '@user', $2, $3)", &[&org_id, &aid, &detail]).await?;
            out.agents.entry(org_id).or_default().push(aid);
            out.orgs.insert(slug.clone());
            if billed && target.is_some() {
                out.rebound.push(json!({"org": slug, "node": name, "state": state, "account": target,
                    "session_boundary": boundary, "in_flight_turn": live && r.get::<_, bool>(9)}));
            }
            if freeze { frozen_out.push(json!({"org": slug, "node": name})); }
            if live { out.live.push((org_id, aid)); }
        }
    }
    let mut after = 0i64;
    loop {
        // As `remove_once`: the key row, then its seats, are locked already, so
        // never wait here for an org-first writer that may await one of those
        // seats. NOWAIT aborts the whole attempt (55P03); roll back now, so
        // every lock is released before `remove_key` backs off and retries.
        let rows = match tx.query("SELECT id, slug FROM ot.orgs WHERE id > $1 AND settings->>'default_account' = $2 ORDER BY id LIMIT 128 FOR UPDATE NOWAIT",
            &[&after, &id]).await {
            Ok(rows) => rows,
            Err(error) => {
                tx.rollback().await?;
                return Err(error.into());
            }
        };
        if rows.is_empty() { break; }
        for row in rows {
            let org_id: i64 = row.get(0);
            after = org_id;
            tx.execute("UPDATE ot.orgs SET settings = settings - 'default_account', row_version = row_version + 1 WHERE id = $1", &[&org_id]).await?;
            tx.execute("INSERT INTO ot.events (org_id, op, actor, detail) VALUES ($1, 'account_default_rebound', '@user', $2)",
                &[&org_id, &json!({"removed_account": id, "account": null})]).await?;
            out.defaults.insert(org_id);
            out.orgs.insert(row.get(1));
        }
    }
    out.app_default = tx.execute(
        "UPDATE ot.kv SET value = value #- '{defaults,default_account}', updated_at = now()
         WHERE key = 'app_settings' AND value #>> '{defaults,default_account}' = $1", &[&id]).await? > 0;
    tx.execute("DELETE FROM ot.account_marks WHERE account = $1", &[&id]).await?;
    tx.execute("INSERT INTO ot.removed_accounts (id, provider) VALUES ($1, 'openrouter') ON CONFLICT (id) DO NOTHING", &[&id]).await?;
    tx.execute("DELETE FROM ot.accounts WHERE id = $1", &[&id]).await?;
    tx.commit().await?;
    Ok((out, frozen_out))
}

#[cfg(test)]
mod tests {
    use super::{rebound_queue, requeue};
    use serde_json::json;

    /// A queued intent naming a removed Muse login names the login chosen for
    /// it, or no account (a queued switch then lands where the seat is); every
    /// other provider's names its own login, as before.
    #[test]
    fn account_removal_requeues_intents_naming_the_login() {
        let switch = json!({ "tier": "wonder-full", "account": "muse-7", "seq": 4, "by": "@user" });
        assert_eq!(requeue(&switch, Some("muse-2".into())), json!({ "tier": "wonder-full", "account": "muse-2", "seq": 4, "by": "@user" }));
        assert_eq!(requeue(&switch, None), json!({ "tier": "wonder-full", "seq": 4, "by": "@user" }));
        let moved = json!({ "account": "muse-7", "from": "muse-1" });
        assert_eq!(requeue(&moved, Some("muse/primary".into()))["account"], "muse/primary");
        assert_eq!(rebound_queue(&json!({ "account": "claude-2" }), "claude-2", "claude/primary", false), json!({ "account": "claude/primary" }));
        assert_eq!(rebound_queue(&json!({ "account": "claude-3" }), "claude-2", "claude/primary", false), json!({ "account": "claude-3" }));
    }

    /// A freeze a removal releases gives back the request it held: only a
    /// non-blank held request counts, and the wake carries it after the
    /// removal's own words.
    #[test]
    fn account_removal_gives_back_a_held_request() {
        use crate::runtime::freeze::{holds_request, with_replay};
        let held = json!({ "cause": "account", "limit": false, "resume_texts": ["PROOF-WALL: please do the thing."] });
        assert!(holds_request(&held));
        for none in [json!({ "cause": "account" }), json!({ "resume_texts": [] }), json!({ "resume_texts": ["  "] }), json!(null)] {
            assert!(!holds_request(&none), "{none}");
        }
        let wake = with_replay("Your Muse account muse-7 was removed; you now run on the account muse-2. Continue where you left off.", Some(&held));
        assert!(wake.starts_with("Your Muse account muse-7 was removed"));
        assert!(wake.ends_with("It was given:\n\nPROOF-WALL: please do the thing."), "{wake}");
    }
}
