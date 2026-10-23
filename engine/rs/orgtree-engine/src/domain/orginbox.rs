//! The org inbox: the organization's one face to the outside world (other
//! orgs on this machine, and hosts reached through the mail hub).

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};

use crate::domain::mail::{From, Outgoing, Sent};
use crate::domain::tree::ts;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::util::uid;

/// Missing settings retain the historical enabled behavior. This policy is
/// deliberately org-local, not inherited from app-wide hire defaults.
#[nolog]
pub fn enabled(settings: &Value) -> bool {
    settings["org_inbox_enabled"].as_bool().unwrap_or(true)
}

/// Legacy off remains authoritative for every existing SQL visibility gate.
#[nolog]
pub fn mode(settings: &Value) -> &'static str {
    if !enabled(settings) { "closed" }
    else if settings["org_inbox_mode"] == "dnd" { "dnd" }
    else { "normal" }
}

/// All policy writers keep the new enum and legacy isolation boolean in step.
#[logged]
pub fn normalize_patch(patch: &mut Map<String, Value>) -> Result<()> {
    if let Some(value) = patch.get("org_inbox_mode") {
        let Some(mode) = value.as_str().filter(|m| matches!(*m,"normal"|"dnd"|"closed")) else {
            crate::refuse!(BadRequest,"org_inbox_mode must be normal, dnd or closed");
        };
        let on = mode != "closed";
        if patch.get("org_inbox_enabled").is_some_and(|v| v.as_bool() != Some(on)) {
            crate::refuse!(BadRequest,"org_inbox_mode conflicts with org_inbox_enabled");
        }
        patch.insert("org_inbox_enabled".into(), json!(on));
    } else if let Some(value) = patch.get("org_inbox_enabled") {
        let Some(on) = value.as_bool() else { crate::refuse!(BadRequest,"org_inbox_enabled must be true or false"); };
        patch.insert("org_inbox_mode".into(), json!(if on {"normal"} else {"closed"}));
    }
    Ok(())
}

#[nolog]
pub fn check(settings: &Value) -> Result<()> {
    if !enabled(settings) {
        crate::refuse!(Forbidden, "the organization's inbox is disabled; outside communication and its history are unavailable");
    }
    Ok(())
}

/// Recheck persisted policy at every entry boundary (including human callers).
#[logged]
pub async fn require_enabled(engine: &Engine, org_id: i64) -> Result<()> {
    let c = engine.db.get().await?;
    let row = c.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&org_id]).await?;
    check(&row.get::<_, Value>(0))
}

/// Admission and publication share the setting writer's row lock. Call only
/// inside a short transaction, never while performing filesystem/network I/O.
#[logged]
pub async fn admit(tx: &tokio_postgres::Transaction<'_>, org_ids: &[i64]) -> Result<()> {
    let mut ids = org_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        let row = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR UPDATE", &[&id]).await?;
        check(&row.get::<_, Value>(0))?;
    }
    Ok(())
}

/// An `org_inbox` row → `OrgInboxEntry`.
pub fn entry(r: &Value) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), r["uid"].clone());
    o.insert("dir".into(), r["dir"].clone());
    o.insert("peer".into(), r["peer"].clone());
    o.insert("body".into(), r["body"].clone());
    o.insert("at".into(), ts(&r["at"]));
    if let Some(b) = r.get("by_name").filter(|v| !v.is_null()) {
        o.insert("by".into(), b.clone());
    }
    if let Some(s) = r.get("state").filter(|v| !v.is_null()) {
        o.insert("state".into(), s.clone());
    }
    if let Some(s) = r.get("state_at").filter(|v| !v.is_null()) {
        o.insert("state_at".into(), ts(s));
    }
    if let Some(n) = r.get("net_id").filter(|v| !v.is_null()) {
        o.insert("net_id".into(), n.clone());
    }
    let tries = r["tries"].as_i64().unwrap_or(0);
    if tries > 0 {
        o.insert("tries".into(), json!(tries));
    }
    if let Some(e) = r.get("last_err").filter(|v| !v.is_null()) {
        o.insert("last_err".into(), e.clone());
    }
    let att = Value::Array(r["attachments"].as_array().into_iter().flatten()
        .filter(|a| a["transfer_removed"] != true).cloned().collect());
    if att.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        o.insert("attachments".into(), att);
    }
    if let Some(q) = r.get("reply_to").filter(|v| v.is_object()) {
        o.insert("reply_to".into(), q.clone());
    }
    let all = super::replies::value(r.get("reply_to"),r.get("replies"));
    if all.as_array().is_some_and(|a| !a.is_empty()) { o.insert("replies".into(),all); }
    Value::Object(o)
}

/// The columns a reply's quote is made from (`inbox_quote`).
const QUOTE_COLS: &str = "uid, dir, peer, by_name, at, body, net_id";

/// What a reply quotes of an org-inbox row: who wrote it, when and a gist
/// (the recipient's `↩ IN REPLY TO`), the row (the desk's link) and its hub
/// id (`net_id`: the reference a reply over the mail hub carries).
#[logged]
fn inbox_quote(r: &tokio_postgres::Row) -> Value {
    let from = if r.get::<_, String>(1) == "in" {
        r.get::<_, String>(2)
    } else {
        match r.get::<_, Option<String>>(3) {
            Some(by) if !by.is_empty() && by != "user" => by,
            _ => "the user".to_string(),
        }
    };
    let mut q = json!({ "kind": "mail", "box": "org", "id": r.get::<_, String>(0), "from": from,
                        "peer": r.get::<_, String>(2),
                        "at": crate::util::iso(r.get(4)), "gist": crate::util::gist(&r.get::<_, String>(5), 600) });
    if let Some(n) = r.get::<_, Option<String>>(6) {
        q["net_id"] = json!(n);
    }
    q
}

/// An outside message an agent sent from the org inbox (the id
/// orgtree_message reported), for that agent's reply.
#[logged]
pub async fn sent_quote(client: &tokio_postgres::Client, org_id: i64, uid: &str, by: &str) -> Result<Option<Value>> {
    let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id=$1", &[&org_id]).await?.get(0);
    check(&settings)?;
    let r = client
        .query_opt(&format!("SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE org_id = $1 AND uid = $2 AND dir = 'out' AND by_name = $3"), &[&org_id, &uid, &by])
        .await?;
    Ok(r.as_ref().map(inbox_quote))
}

/// This org's own record of the message a hub reply names (one it sent or
/// received), quoted; `None` when the org never saw it.
#[logged]
async fn net_quote(client: &tokio_postgres::Client, org_id: i64, net_id: &str, peer:&str) -> Result<Option<Value>> {
    let r = client
        .query_opt(
            &format!(
                "(SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE dir = 'out' AND net_id = $2 AND org_id = $1 AND peer=$3 LIMIT 1)
                 UNION ALL
                 (SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE dir = 'in' AND org_id = $1 AND net_id = $2 AND peer=$3 LIMIT 1)
                 LIMIT 1"
            ),
            &[&org_id, &net_id, &peer],
        )
        .await?;
    Ok(r.as_ref().map(inbox_quote))
}

/// Mail to the outside: `@org:<slug>` (another org on this machine: one
/// transaction into both inboxes, then the receiving org's holders are
/// woken) or `@net:<slug>` (the mail hub).
#[logged]
pub async fn send_extern(engine: &Arc<Engine>, org_id: i64, out: &Outgoing) -> Result<Sent> {
    require_enabled(engine, org_id).await?;
    let to = out.to.trim().trim_start_matches('@');
    let Some(src) = engine.orgs.by_id(org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let by = match &out.from { From::User => "user".to_string(), f => f.name() };
    if let From::Agent { id, name, .. } = &out.from {
        ensure_holders(engine, org_id, Some((*id, name.as_str()))).await?;
    }
    if let Some(peer) = to.strip_prefix("net:") {
        let sender = match &out.from { From::Agent { id,generation,.. } => Some((*id,*generation)), _ => None };
        let (uid, to, transfer_ids) = crate::net::queue(engine, org_id, peer, &out.body, &by, sender, &out.kind, &out.attachments, out.reply_to.as_ref(), &out.replies).await?;
        changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
        return Ok(Sent { dnd_held: false,
            transfer_ids,
            uid,
            to,
            recipient_state: "remote".into(),
            delivery: "Queued for the mail hub. The message waits until all files are uploaded; inspect transfer_ids with orgtree_transfers (the org inbox also shows progress).".into(),
            deferred: false,
        });
    }
    let slug = to.strip_prefix("org:").unwrap_or(to).trim();
    let Some(dst) = engine.orgs.get(slug) else {
        crate::refuse!(NotFound, "no organization @org:{slug} on this machine (orgtree_list_orgs lists them)");
    };
    if dst.id == org_id {
        crate::refuse!(BadRequest, "@org:{slug} is this organization; write to the agent directly");
    }
    require_enabled(engine, dst.id).await?;
    let mut client = engine.db.get().await?;
    let attachments = Value::Array(out.attachments.clone());
    let out_uid = uid("x");
    let in_uid = uid("x");
    let src_peer = format!("@org:{}", src.slug);
    let dst_peer = format!("@org:{}", dst.slug);
    // a reply's quote travels with it (the receiving org has no ids of ours)
    let reply_here = crate::util::pg_json_option(&out.reply_to).into_owned();
    let reply_there = reply_here
        .as_ref()
        .map(|q| Value::Object(["from", "at", "gist"].iter().filter_map(|k| q.get(*k).filter(|v| !v.is_null()).map(|v| (k.to_string(), v.clone()))).collect()))
        .filter(|q| q.get("gist").is_some());
    let replies_here = super::replies::snapshots(out.reply_to.as_ref(),Some(&Value::Array(out.replies.clone())));
    let replies_there: Vec<Value> = replies_here.iter().map(|q| {
        let mut q=q.clone();
        if let Some(o)=q.as_object_mut() { o.entry("org").or_insert_with(|| json!(src.slug)); }
        q
    }).collect();
    let tx = client.transaction().await?;
    admit(&tx, &[org_id, dst.id]).await?;
    // Preserve the canonical kind for a later pull or Normal-mode release.
    tx
        .execute(
            "WITH o AS (INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, attachments, reply_to, replies)
                        VALUES ($1, $2, 'out', $3, $4, $5, 'delivered', now(), $6, $10, $12))
             INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, reply_to, replies) VALUES ($7, $8, 'in', $9, $4, $6, $11, $13)",
            &[&out_uid, &org_id, &dst_peer, &out.body, &by, &attachments, &in_uid, &dst.id, &src_peer, &reply_here, &reply_there, &json!(replies_here), &json!(replies_there)],
        )
        .await?;
    tx.execute("UPDATE ot.org_inbox SET kind=$2 WHERE uid=$1", &[&in_uid,&out.kind]).await?;
    let (route, delivered, held, audience_changed) = publish_new(engine,&tx,dst.id,&in_uid).await?;
    let holders = &route.to;
    let mut mention_rows=[(org_id,out_uid.as_str()),(dst.id,in_uid.as_str())];
    mention_rows.sort_by_key(|row|row.0);
    for (org,id) in mention_rows {
        super::mention_navigation::record_org_mail(&*tx,org,id,&out.body).await?;
    }
    tx.commit().await?;
    drop(client);
    // the spark rides from the sender to the mailbox here, and from the mailbox to each holder there
    changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
    changes::notify(engine, &dst, vec![Change::OrgInbox]);
    if audience_changed { changes::notify(engine,&dst,vec![Change::Audiences,Change::Events]); }
    wake_copies(engine, dst.id, delivered);
    if !held && (holders.is_empty() || route.waiting) {
        if let Err(error) = super::runtime_notices::external_unroutable(engine,dst.id,&dst.slug,&src_peer,&out.body,holders).await {
            tracing::warn!(org_id = dst.id, %error, "outside mail committed; fallback notice failed");
        }
    }
    let delivery = if held {
        format!("Stored in {}'s org inbox under Do not disturb or its ordered release queue; no agent copy or wake. An extern-audience holder can pull it.",dst.slug)
    } else if holders.is_empty() {
        format!("Stored in {}'s org inbox; it has no live agent to read it yet.", dst.slug)
    } else if route.waiting {
        format!("Delivered to {}'s org inbox and to {}; none of them can run now (halted or frozen), so it waits for them.", dst.slug, holders.join(", "))
    } else {
        format!("Delivered to {}'s org inbox and to {}.", dst.slug, holders.join(", "))
    };
    resume_pending(engine,dst.id).await;
    Ok(Sent { dnd_held: held, transfer_ids: Vec::new(), uid: out_uid, to: dst_peer, recipient_state: "live".into(), delivery, deferred: held || holders.is_empty() || route.waiting })
}

/// Effective live audience holders; newest grant wins in single-holder mode.
#[logged]
pub async fn live_holders<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<String>> {
    let rows = client.query(
        "SELECT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live'
         GROUP BY au.grantee ORDER BY max(au.id) DESC LIMIT $2", &[&org_id, &(if multi { 10000i64 } else { 1i64 })]).await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Of these agents, the ones that can run a turn now (not halted, not frozen), in the same order.
#[logged]
async fn runnable<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, names: &[String]) -> Result<Vec<String>> {
    let rows = client.query(
        "SELECT name FROM ot.agents WHERE org_id = $1 AND name = ANY($2) AND state = 'live' AND kind = 'agent' AND halt IS NULL AND frozen IS NULL",
        &[&org_id, &names]).await?;
    let ready: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    Ok(names.iter().filter(|n| ready.contains(n)).cloned().collect())
}

/// Who gets inbound outside mail (decision 59): the holders who can run;
/// while none can, the first top-level agent who can (no grant: the
/// audience stays with the holders). With nobody able to run it goes to the
/// holders and waits (`waiting`).
#[derive(Debug)]
struct Route {
    to: Vec<String>,
    waiting: bool,
}

/// Whether `ensure_holders` would let this agent send outside mail now,
/// changing nothing: the org inbox is enabled, and the agent holds its
/// audience or is a live top-level agent (whom a send auto-grants). Typing
/// in Hubchat (2026-10-13) checks the send's own gate, and must never grant.
#[logged]
pub(crate) async fn may_send_extern(engine: &Arc<Engine>, org_id: i64, agent_id: i64, name: &str) -> Result<bool> {
    let c = engine.db.get().await?;
    let client: &tokio_postgres::Client = &c;
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    if check(&raw).is_err() {
        return Ok(false);
    }
    let settings = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults());
    let multi = settings["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    if live_holders(client, org_id, multi).await?.iter().any(|h| h == name) {
        return Ok(true);
    }
    Ok(client
        .query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.superior_of(id) IS NULL", &[&agent_id, &org_id])
        .await?
        .is_some())
}

/// Serialize only this org's short audience update; never hold the transaction over sending or IO.
#[logged]
async fn ensure_holders(engine: &Arc<Engine>, org_id: i64, sender: Option<(i64, &str)>) -> Result<Route> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let raw: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR UPDATE", &[&org_id]).await?.get(0);
    check(&raw)?;
    let (route, changed) = route_tx(&tx, org_id, sender, &raw, &engine.settings.defaults()).await?;
    tx.commit().await?;
    if changed { changes::notify_id(engine, org_id, vec![Change::Audiences, Change::OrgInbox, Change::Events]); }
    Ok(route)
}

/// Resolve routing under the publication/policy lock, never from a stale mode.
#[logged]
async fn route_tx(tx: &tokio_postgres::Transaction<'_>, org_id:i64, sender:Option<(i64,&str)>, raw:&Value,
    defaults:&Map<String,Value>) -> Result<(Route,bool)> {
    let settings = crate::feed::groups::effective_settings(raw, defaults);
    let multi = settings["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    let mut holders = live_holders(&*tx, org_id, multi).await?;
    let target = if let Some((id, name)) = sender {
        if holders.iter().any(|h| h == name) { None } else {
            let top = tx.query_opt("SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.superior_of(id) IS NULL", &[&id, &org_id]).await?.is_some();
            if !top { crate::refuse!(Forbidden, "outside mail needs the org-inbox audience; ask your superior"); }
            Some((id, name.to_string(), "auto-granted: top-level agent messaged an outside party"))
        }
    } else if holders.is_empty() {
        // the first top-level agent who can run; when none can, the first live one
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND ot.superior_of(id) IS NULL AND state = 'live' AND kind = 'agent'
                       ORDER BY (halt IS NULL AND frozen IS NULL) DESC, sibling_order, id LIMIT 1", &[&org_id]).await?
            .map(|r| (r.get(0), r.get(1), "auto-granted: outside mail arrived with no live org-inbox holder"))
    } else { None };
    let mut changed = false;
    if let Some((id, name, reason)) = target {
        if !multi {
            tx.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern' AND revoked_at IS NULL", &[&org_id]).await?;
            holders.clear();
        }
        tx.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, '@extern', $3)", &[&org_id, &name, &reason]).await?;
        tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', '@system', $2, $3)",
            &[&org_id, &id, &json!({"grantee": name, "grantor": "@extern", "reason": reason})]).await?;
        holders.push(name);
        changed = true;
    }
    let mut route = Route { to: holders.clone(), waiting: false };
    if sender.is_none() && !holders.is_empty() {
        let ready = runnable(&*tx, org_id, &holders).await?;
        if !ready.is_empty() {
            route.to = ready;
        } else if let Some(r) = tx.query_opt(
            "SELECT name FROM ot.agents WHERE org_id = $1 AND ot.superior_of(id) IS NULL AND state = 'live' AND kind = 'agent' AND halt IS NULL AND frozen IS NULL
              ORDER BY sibling_order, id LIMIT 1", &[&org_id]).await? {
            route.to = vec![r.get(0)];
        } else {
            route.waiting = true;
        }
    }
    Ok((route,changed))
}

/// Mail that arrived over the mail hub: stored once (keyed by its hub id),
/// then handed to the org's outside-mail holders. Answers whether it was new.
/// `reply_to` is the hub id of the message it answers: quoted when this org
/// has that message, kept as the bare reference otherwise.
#[allow(clippy::too_many_arguments)]
#[logged]
pub async fn deliver_inbound(
    engine: &Arc<Engine>,
    org_id: i64,
    peer: &str,
    body: &str,
    attachments: Vec<Value>,
    net_id: &str,
    hub: &str,
    reply_to: Option<&str>,
) -> Result<bool> {
    let refs = reply_to.map(|r| vec![r.to_string()]).unwrap_or_default();
    deliver_inbound_replies(engine,org_id,peer,body,attachments,net_id,hub,&refs).await
}

#[allow(clippy::too_many_arguments)]
#[logged]
pub async fn deliver_inbound_replies(engine: &Arc<Engine>, org_id:i64, peer:&str, body:&str,
    attachments:Vec<Value>, net_id:&str, hub:&str, references:&[String]) -> Result<bool> {
    let Some(org) = engine.orgs.by_id(org_id) else { return Ok(false) };
    // The org row serializes mode changes, extraction and publication.
    let mut client = engine.db.get().await?;
    let mut quotes=Vec::new();
    for id in references.iter().take(super::replies::MAX_REPLIES) {
        quotes.push(net_quote(&client,org_id,id,peer).await?.unwrap_or_else(|| json!({"net_id":id,"gist":"Original message unavailable"})));
    }
    let stored=quotes.first().cloned();
    let tx = client.transaction().await?;
    // Serialize only this org's publication boundary, including the duplicate
    // check; different hubs may concurrently deliver to the same org.
    admit(&tx, &[org_id]).await?;
    let mention_mail_uid=uid("x");
    let n = tx.execute(
        "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, net_id, hub, reply_to, replies)
         SELECT $1, $2, 'in', $3, $4, $5, $6, $7, $8, $9
          WHERE NOT EXISTS (SELECT 1 FROM ot.org_inbox WHERE org_id=$2 AND dir='in' AND net_id=$6)",
        &[&mention_mail_uid, &org_id, &peer, &crate::util::pg_text(body).as_ref(),
          &crate::util::pg_json(&Value::Array(attachments.clone())).as_ref(), &net_id, &hub,
          &crate::util::pg_json_option(&stored).as_ref(), &json!(quotes)],
    ).await?;
    if n == 0 { return Ok(false); }
    let (route, delivered, held, audience_changed) = publish_new(engine,&tx,org_id,&mention_mail_uid).await?;
    let holders = &route.to;
    super::mention_navigation::record_org_mail(&*tx,org_id,&mention_mail_uid,body).await?;
    tx.commit().await?;
    drop(client);
    wake_copies(engine, org_id, delivered);
    if audience_changed { changes::notify(engine,&org,vec![Change::Audiences,Change::Events]); }
    if !held && (holders.is_empty() || route.waiting) {
        if let Err(error) = super::runtime_notices::external_unroutable(engine,org_id,&org.slug,peer,body,holders).await {
            tracing::warn!(org_id, %error, "outside mail committed; fallback notice failed");
        }
    }
    resume_pending(engine,org_id).await;
    Ok(true)
}

/// A held backlog also queues new Normal-mode arrivals, so none overtake it.
#[logged]
async fn publish_new(engine:&Engine,tx:&tokio_postgres::Transaction<'_>,org:i64,uid:&str)
    -> Result<(Route,Vec<(i64,String,String,bool)>,bool,bool)> {
    let raw:Value=tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org]).await?.get(0);
    let backlog=tx.query_opt("SELECT 1 FROM ot.org_inbox WHERE org_id=$1 AND dnd_held LIMIT 1",&[&org]).await?.is_some();
    if mode(&raw)=="dnd" || backlog {
        tx.execute("UPDATE ot.org_inbox SET dnd_held=true WHERE uid=$1",&[&uid]).await?;
        return Ok((Route{to:Vec::new(),waiting:false},Vec::new(),true,false));
    }
    let (route,changed)=route_tx(tx,org,None,&raw,&engine.settings.defaults()).await?;
    let row:Value=tx.query_one("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE uid=$1",&[&uid]).await?.get(0);
    let copies=publish_row(tx,org,&route.to,&row).await?;
    Ok((route,copies,false,changed))
}

#[logged]
async fn publish_row(tx:&tokio_postgres::Transaction<'_>,org:i64,holders:&[String],row:&Value)
    -> Result<Vec<(i64,String,String,bool)>> {
    let quotes=super::replies::snapshots(row.get("reply_to"),row.get("replies"));
    publish_copies(tx,org,holders,row["peer"].as_str().unwrap_or(""),row["body"].as_str().unwrap_or(""),
        row["kind"].as_str().unwrap_or("message"),&row["attachments"],&quotes,
        row["net_id"].as_str(),row["hub"].as_str()).await
}

/// One bounded transaction. Retained inactive history is never scanned.
#[logged]
pub async fn release_page(engine:&Arc<Engine>,org:i64) -> Result<usize> {
    let mut c=engine.db.get().await?;
    // Cheap indexed negative probe before taking the policy lock.
    if c.query_opt("SELECT 1 FROM ot.org_inbox WHERE org_id=$1 AND dnd_held LIMIT 1",&[&org]).await?.is_none() {return Ok(0);}
    let tx=c.transaction().await?;
    let raw:Value=tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR UPDATE",&[&org]).await?.get(0);
    if mode(&raw)!="normal" {return Ok(0);}
    let rows=tx.query("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id=$1 AND dnd_held ORDER BY id LIMIT 100 FOR UPDATE",&[&org]).await?;
    if rows.is_empty() {return Ok(0);}
    let (route,changed)=route_tx(&tx,org,None,&raw,&engine.settings.defaults()).await?;
    if route.to.is_empty() {return Ok(0);}
    let mut copies=Vec::new();
    for row in &rows {
        let row:Value=row.get(0);
        copies.extend(publish_row(&tx,org,&route.to,&row).await?);
        tx.execute("UPDATE ot.org_inbox SET dnd_held=false WHERE uid=$1",&[&row["uid"].as_str().unwrap()]).await?;
    }
    tx.commit().await?;
    drop(c);
    if changed {changes::notify_id(engine,org,vec![Change::Audiences,Change::Events]);}
    wake_copies(engine,org,copies);
    Ok(rows.len())
}

/// Save and inbound paths start the drain now. The normal runtime tick retries
/// after a restart/failure; committed publication never gets reported as failed.
#[logged]
pub async fn resume_pending(engine:&Arc<Engine>,org:i64) {
    loop {
        match release_page(engine,org).await {
            Ok(100)=>tokio::task::yield_now().await,
            Ok(_)=>break,
            Err(error)=>{tracing::warn!(org_id=org,%error,"org inbox release deferred to runtime recovery");break;}
        }
    }
}

/// Both local and hub delivery publish the retained row and holder copies in
/// the same transaction; a setting change cannot split a fanout.
#[allow(clippy::too_many_arguments)]
#[logged]
pub(crate) async fn publish_copies(tx: &tokio_postgres::Transaction<'_>, org_id: i64, holders: &[String],
    peer: &str, body: &str, kind: &str, attachments: &Value, quotes: &[Value],
    net_id: Option<&str>, hub: Option<&str>) -> Result<Vec<(i64, String, String, bool)>> {
    let mut delivered = Vec::new();
    for h in holders {
        let target = tx.query_opt(
            "SELECT id,state,halt IS NOT NULL FROM ot.agents WHERE org_id=$1 AND name=$2 AND state<>'deleted' FOR SHARE",
            &[&org_id,h],
        ).await?.ok_or_else(|| anyhow::anyhow!("outside-mail holder no longer exists"))?;
        let target_id: i64 = target.get(0);
        let state: String = target.get(1);
        anyhow::ensure!(state != "unrecoverable", "outside-mail holder cannot currently receive mail");
        let halted: bool = target.get(2);
        let mail_uid = uid("m");
        let replies:Vec<Value> = quotes.iter().cloned().map(|mut q| {
            if q["from"].as_str() == Some(h.as_str()) {
                if let Some(o) = q.as_object_mut() { o.remove("from"); }
            }
            q
        }).collect();
        let reply=replies.first().cloned();
        let ev = crate::events::ordinary(peer, kind, false, body);
        tx.execute(
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,attachments,reply_to,ev,state,net_id,net_hub,replies)
             VALUES($1,$2,$3,'agent',$4,$5,$12,$6,$7,$8,$9,'pending',$10,$11,$13)",
            &[&mail_uid,&org_id,&peer,&target_id,h,&crate::util::pg_text(body).as_ref(),
              &crate::util::pg_json(attachments).as_ref(),
              &crate::util::pg_json_option(&reply).as_ref(),&crate::util::pg_json(&ev).as_ref(),&net_id,&hub,&kind,&json!(replies)],
        ).await?;
        delivered.push((target_id,h.clone(),mail_uid,state == "live" && !halted));
    }
    Ok(delivered)
}

#[logged]
fn wake_copies(engine: &Arc<Engine>, org_id: i64, delivered: Vec<(i64, String, String, bool)>) {
    let mut ch = vec![Change::OrgInbox];
    for (id,name,mail_uid,wake) in delivered {
        ch.push(Change::Mailbox(id));
        ch.push(Change::Spark { from: "org_inbox".into(), to: name });
        ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event(
            "mail.waiting",crate::runtime::watchdogs::events::Scope::Agent(org_id,id),json!({"agent_id":id,"mail_id":mail_uid}),
        )));
        if wake { crate::runtime::wake(engine,org_id,id); }
        if let Some(h) = engine.agents.get(id) { h.send(crate::runtime::AgentMsg::Wake); }
    }
    changes::notify_id(engine, org_id, ch);
 }

#[cfg(test)]
mod org_dnd_tests {
    use super::*;
    #[test] fn org_dnd_legacy_and_enum_modes_preserve_closed_isolation() {
        assert_eq!(mode(&json!({})),"normal");
        assert_eq!(mode(&json!({"org_inbox_enabled":false})),"closed");
        assert_eq!(mode(&json!({"org_inbox_enabled":false,"org_inbox_mode":"dnd"})),"closed");
        assert_eq!(mode(&json!({"org_inbox_enabled":true,"org_inbox_mode":"dnd"})),"dnd");
        for (selected,on) in [("normal",true),("dnd",true),("closed",false)] {
            let mut patch=json!({"org_inbox_mode":selected}).as_object().unwrap().clone();
            normalize_patch(&mut patch).unwrap();
            assert_eq!(patch["org_inbox_enabled"],on);
            assert_eq!(mode(&Value::Object(patch)),selected);
        }
    }
    #[test] fn org_dnd_legacy_writes_do_not_leave_a_stale_hold() {
        for (on,want) in [(true,"normal"),(false,"closed")] {
            let mut patch=json!({"org_inbox_enabled":on}).as_object().unwrap().clone();
            normalize_patch(&mut patch).unwrap();assert_eq!(patch["org_inbox_mode"],want);
        }
        for v in [json!("quiet"),json!(false),Value::Null] {
            assert!(normalize_patch(json!({"org_inbox_mode":v}).as_object_mut().unwrap()).is_err());
        }
        assert!(normalize_patch(json!({"org_inbox_mode":"dnd","org_inbox_enabled":false}).as_object_mut().unwrap()).is_err());
        let app=json!({"org_inbox_mode":"dnd","org_inbox_enabled":false}).as_object().unwrap().clone();
        let effective=crate::feed::groups::effective_settings(&json!({}),&app);
        assert_eq!(effective["org_inbox_mode"],"normal");assert_eq!(effective["org_inbox_enabled"],true);
    }
}
