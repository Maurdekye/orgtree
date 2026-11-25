//! Blocking contacts on the mail hub (Mail hub 2.6.0 feature `blocking`;
//! Orgtree docket blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr, user
//! 2026-11-24 18:56Z m020bbd1926c3 and 19:06Z m61f5367a61e7). The hubs keep
//! and enforce blocks, both ways, for the org's one hub identity, so a block
//! covers every agent that writes as the org (primary and weak links).
//!
//! - **Intent** is `ot.net_blocks`: what the org wants blocked, who set it
//!   (`@user` or an agent's name) and why. `set` writes it; each pass
//!   (`reconcile`) makes every registered 2.6.0 hub's list match it, so an
//!   unreachable hub catches up when it is back.
//! - **Heard**: every poll answer from a 2.6.0 hub carries `blocking` for
//!   each member that blocks anyone or is blocked (left out = none). The last
//!   word per (hub, org) is kept in memory; a contact that starts or stops
//!   blocking the org is told to the user and the org mailbox holders.
//! - **Refused**: a send the hub refuses because of a block (403 with
//!   `blocked_by` or `blocking`) ends `failed`, not retried, and its sender is
//!   told in the user's words.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use super::{kick, request, Part, HTTP};
use crate::changes::{self, Change};
use crate::engine::Engine;

/// The org's word for a contact: blocked by the user, or by this agent.
pub const BY_USER: &str = "@user";

/// How long a hub's `/healthz` word on `blocking` is kept before it is read again.
pub(super) const FEATURE_TTL: Duration = Duration::from_secs(600);

/// Does the hub at `addr` keep blocks? A hub that lists the `blocking`
/// feature does, whatever its version says: a hub built before its release
/// still names the old version (the integrated 2.6.0 line said "2.5.1",
/// measured by the net-blocks rig proof 2026-11-25). A 2.6.0-or-later
/// version is taken at once; otherwise its `/healthz` is read (cached
/// `FEATURE_TTL`; an unreachable hub keeps the last word, else no).
async fn supports(engine: &Engine, addr: &str) -> bool {
    if engine.net.versions.pin().get(addr).is_some_and(|v| keeps_blocks(v)) {
        return true;
    }
    let cached = engine.net.blocking_feature.pin().get(addr).copied();
    if let Some((yes, at)) = cached {
        if at.elapsed() < FEATURE_TTL {
            return yes;
        }
    }
    match super::transport::healthz(addr, Duration::from_secs(5)).await {
        Some(health) => {
            let yes = lists_blocking(&health);
            engine.net.blocking_feature.pin().insert(addr.to_string(), (yes, std::time::Instant::now()));
            yes
        }
        None => cached.is_some_and(|c| c.0),
    }
}

/// A hub's `/healthz` answer lists the `blocking` feature.
pub(super) fn lists_blocking(health: &Value) -> bool {
    health["features"].as_array().is_some_and(|f| f.iter().any(|x| x == "blocking"))
}

/// A hub version that keeps blocks: 2.6.0 and later (pre-releases of 2.6 too).
pub(super) fn keeps_blocks(version: &str) -> bool {
    let mut n = version.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).map(|s| s.parse::<u64>().unwrap_or(0));
    let (a, b) = (n.next().unwrap_or(0), n.next().unwrap_or(0));
    (a, b) >= (2, 6)
}

/// The address a tool or the app names, bare; None when it is not one.
pub(super) fn bare_address(address: &str) -> Option<String> {
    let a = address.trim().trim_start_matches("@net:").trim_start_matches('@');
    (!a.is_empty() && a.len() <= 128 && a.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')))
        .then(|| a.to_string())
}

/// May `by` lift a block set by `set_by`? Only the user lifts the user's
/// (user 2026-11-24 19:06Z, Q1b).
pub(super) fn may_lift(set_by: Option<&str>, by: &str) -> bool {
    set_by != Some(BY_USER) || by == BY_USER
}

fn strings(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    out.sort();
    out.dedup();
    out
}

/// One poll answer's word on each member (`blocking`; none = empty).
#[logged]
pub(super) async fn heard(engine: &Arc<Engine>, addr: &str, members: &[(Part, String)], data: &Value) {
    if !supports(engine, addr).await {
        return;
    }
    for (p, _) in members {
        let e = &data["blocking"][p.net_slug.as_str()];
        let (mine, by) = (strings(&e["blocks"]), strings(&e["blocked_by"]));
        let key = (addr.to_string(), p.net_slug.clone());
        let before = engine.net.blocks.pin().insert(key, (mine.clone(), by.clone())).cloned();
        let changed = before.as_ref().is_none_or(|(m, b)| *m != mine || *b != by);
        if changed {
            if let Some(o) = engine.orgs.by_id(p.org_id) {
                changes::notify(engine, &o, vec![Change::Net, Change::OrgInbox]);
            }
        }
        // the first word since start is no news: only a change is told
        let Some((_, was)) = before else { continue };
        let was: BTreeSet<&String> = was.iter().collect();
        let now: BTreeSet<&String> = by.iter().collect();
        let hub = engine.net.names.pin().get(addr).cloned().unwrap_or_else(|| addr.to_string());
        for a in now.difference(&was) {
            let body = format!("@net:{a} has blocked this org on mail hub {hub}: the org can't message them, and they can't message the org, until they unblock it.");
            if let Err(e) = tell(engine, p.org_id, None, &body, json!({"blocked_by": a, "hub": addr})).await {
                tracing::warn!(error = %format!("{e:#}"), "could not tell the org it was blocked");
            }
        }
        for a in was.difference(&now) {
            let body = format!("@net:{a} has unblocked this org on mail hub {hub}: messages can go both ways again.");
            if let Err(e) = tell(engine, p.org_id, None, &body, json!({"unblocked_by": a, "hub": addr})).await {
                tracing::warn!(error = %format!("{e:#}"), "could not tell the org it was unblocked");
            }
        }
    }
}

/// A notice from `@system` to the user and to `agent` (the sender of a refused
/// message), or to the org mailbox holders when `agent` is None.
#[logged]
async fn tell(engine: &Arc<Engine>, org_id: i64, agent: Option<(i64, i32)>, body: &str, extra: Value) -> Result<()> {
    let mut c = engine.db.get().await?;
    let tx = c.transaction().await?;
    tx.execute(
        "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,notice,body,extra,state) VALUES($1,$2,'@system','user','@user','status',true,$3,$4,'pending')",
        &[&crate::util::uid("m"), &org_id, &body, &extra],
    )
    .await?;
    let agents: Vec<i64> = match agent {
        Some((id, generation)) => tx
            .query("SELECT id FROM ot.agents WHERE org_id=$1 AND id=$2 AND generation=$3 AND state='live'", &[&org_id, &id, &generation])
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect(),
        None => {
            let raw: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&org_id]).await?.get(0);
            let settings = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults());
            let names = crate::domain::orginbox::holder_agents(&*tx, org_id, settings["org_inbox_multi_holder"].as_bool().unwrap_or(false)).await?;
            tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state='live' AND name=ANY($2) ORDER BY id LIMIT 10000", &[&org_id, &names])
                .await?
                .iter()
                .map(|r| r.get(0))
                .collect()
        }
    };
    for a in &agents {
        tx.execute(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,extra,state) SELECT $1,$2,'@system','agent',id,name,'status',true,$4,$5,'pending' FROM ot.agents WHERE id=$3 AND org_id=$2",
            &[&crate::util::uid("m"), &org_id, a, &body, &extra],
        )
        .await?;
    }
    tx.commit().await?;
    drop(c);
    let mut ch = vec![Change::UserMail];
    ch.extend(agents.iter().map(|a| Change::Mailbox(*a)));
    changes::notify_id(engine, org_id, ch);
    Ok(())
}

/// The hub refused an outgoing message because of a block: it ends `failed`
/// (never retried: the hub would refuse it again) and its sender is told.
#[logged]
pub(super) async fn refused(engine: &Arc<Engine>, org_id: i64, row_id: i64, peer: &str, answer: &Value) -> Result<()> {
    let why = if answer["blocked_by"].is_string() {
        format!("you have been blocked by @net:{peer} and cannot message them")
    } else {
        format!("this org blocks @net:{peer}; unblock them (orgtree_block) to message them")
    };
    let row = engine
        .db
        .get()
        .await?
        .query_opt(
            "UPDATE ot.org_inbox SET state='failed', state_at=now(), last_err=$2, tries=tries+1 WHERE id=$1 AND state='queued' RETURNING sender_agent_id, sender_generation",
            &[&row_id, &why],
        )
        .await?;
    if let Some(o) = engine.orgs.by_id(org_id) {
        changes::notify(engine, &o, vec![Change::OrgInbox]);
    }
    let Some(row) = row else { return Ok(()) };
    let sender: Option<(i64, i32)> = match (row.get::<_, Option<i64>>(0), row.get::<_, Option<i32>>(1)) {
        (Some(a), Some(g)) => Some((a, g)),
        _ => None,
    };
    let body = format!("Not delivered to @net:{peer}: {why}.");
    // without a known sender, only the user hears it (never every holder)
    match sender {
        Some(s) => tell(engine, org_id, Some(s), &body, json!({"blocked_message": row_id, "peer": peer})).await,
        None => tell(engine, org_id, Some((0, 0)), &body, json!({"blocked_message": row_id, "peer": peer})).await,
    }
}

/// Make each registered 2.6.0 hub's list match the org's intent (each pass).
#[logged]
pub(super) async fn reconcile(engine: &Arc<Engine>, parts: &[Part]) {
    for p in parts {
        let want: BTreeSet<String> = match engine.db.get().await {
            Ok(c) => match c.query("SELECT address FROM ot.net_blocks WHERE org_id=$1", &[&p.org_id]).await {
                Ok(rows) => rows.iter().map(|r| r.get(0)).collect(),
                Err(_) => continue,
            },
            Err(_) => return,
        };
        for (hid, addr) in &p.hubs {
            if !p.registered.contains(hid) || !supports(engine, addr).await {
                continue;
            }
            let key = (addr.clone(), p.net_slug.clone());
            // not heard from since start: its list is not known yet
            let Some((have, _)) = engine.net.blocks.pin().get(&key).cloned() else { continue };
            let have: BTreeSet<String> = have.into_iter().collect();
            let changes: Vec<(String, bool)> = want
                .difference(&have)
                .map(|a| (a.clone(), true))
                .chain(have.difference(&want).map(|a| (a.clone(), false)))
                .filter(|(a, on)| !engine.net.block_refused.pin().contains(&(addr.clone(), p.net_slug.clone(), a.clone(), *on)))
                .collect();
            for (address, on) in changes {
                let res = request(
                    engine,
                    &[p.org_id],
                    HTTP.post(format!("{addr}/api/blocks"))
                        .timeout(Duration::from_secs(10))
                        .header("X-Org-Auth", p.auth())
                        .json(&json!({ "address": address, "blocked": on, "slug": p.net_slug })),
                )
                .await;
                match res {
                    Ok(r) if r.status().is_success() => {
                        let list = r.json::<Value>().await.map(|v| strings(&v["blocked"])).unwrap_or_default();
                        engine.net.blocks.pin().update(key.clone(), |(_, by)| (list.clone(), by.clone()));
                        if let Some(o) = engine.orgs.by_id(p.org_id) {
                            changes::notify(engine, &o, vec![Change::Net, Change::OrgInbox]);
                        }
                    }
                    // a refusal would come again: not asked again this run
                    Ok(r) if r.status().is_client_error() && r.status().as_u16() != 401 => {
                        engine.net.block_refused.pin().insert((addr.clone(), p.net_slug.clone(), address.clone(), on));
                    }
                    _ => break,
                }
            }
        }
    }
}

/// The org's blocks: address, who set it, why and when; and, per hub, whom
/// it blocks there and who blocks the org there (the hubs' last word).
#[logged]
pub async fn list(engine: &Engine, org_id: i64) -> Result<Value> {
    let rows = engine
        .db
        .get()
        .await?
        .query("SELECT address, set_by, reason, at FROM ot.net_blocks WHERE org_id=$1 ORDER BY at, address", &[&org_id])
        .await?;
    let blocked: Vec<Value> = rows
        .iter()
        .map(|r| {
            let at: chrono::DateTime<chrono::Utc> = r.get(3);
            json!({ "address": r.get::<_, String>(0), "set_by": r.get::<_, String>(1), "reason": r.get::<_, Option<String>>(2), "at": at.to_rfc3339() })
        })
        .collect();
    let parts = engine.net.parts.load_full();
    let mut blocked_by: BTreeSet<String> = BTreeSet::new();
    if let Some(p) = parts.iter().find(|p| p.org_id == org_id) {
        for (_, addr) in &p.hubs {
            if let Some((_, by)) = engine.net.blocks.pin().get(&(addr.clone(), p.net_slug.clone())) {
                blocked_by.extend(by.iter().cloned());
            }
        }
    }
    Ok(json!({ "blocked": blocked, "blocked_by": blocked_by }))
}

/// Block or unblock an address for the org. `by` is `BY_USER` or the acting
/// agent's name (the caller checked it may); an agent can't lift a block the
/// user set (user 19:06Z, Q1b). Returns the org's list.
#[logged]
pub async fn set(engine: &Arc<Engine>, org_id: i64, address: &str, on: bool, by: &str, reason: Option<&str>) -> Result<Value> {
    let Some(address) = bare_address(address) else {
        crate::refuse!(BadRequest, "address must be a mail hub address (@net:<address>)");
    };
    let own = engine.net.parts.load_full().iter().any(|p| p.org_id == org_id && p.net_slug == address);
    if own {
        crate::refuse!(BadRequest, "the org can't block its own address");
    }
    if let Some(r) = reason {
        if r.chars().count() > 500 {
            crate::refuse!(BadRequest, "reason is longer than 500 characters");
        }
    }
    let c = engine.db.get().await?;
    if on {
        c.execute(
            "INSERT INTO ot.net_blocks (org_id, address, set_by, reason) VALUES ($1,$2,$3,$4)
             ON CONFLICT (org_id, address) DO UPDATE SET set_by=EXCLUDED.set_by, reason=EXCLUDED.reason, at=now()
             WHERE ot.net_blocks.set_by <> '@user' OR EXCLUDED.set_by = '@user'",
            &[&org_id, &address, &by, &reason],
        )
        .await?;
    } else {
        let set_by: Option<String> = c.query_opt("SELECT set_by FROM ot.net_blocks WHERE org_id=$1 AND address=$2", &[&org_id, &address]).await?.map(|r| r.get(0));
        if !may_lift(set_by.as_deref(), by) {
            crate::refuse!(Forbidden, "the user blocked @net:{address}; only the user can unblock it");
        }
        c.execute("DELETE FROM ot.net_blocks WHERE org_id=$1 AND address=$2", &[&org_id, &address]).await?;
    }
    drop(c);
    engine.net.block_refused.pin().retain(|(_, _, a, _)| *a != address);
    if let Some(o) = engine.orgs.by_id(org_id) {
        changes::notify(engine, &o, vec![Change::OrgInbox]);
    }
    kick(engine);
    list(engine, org_id).await
}
