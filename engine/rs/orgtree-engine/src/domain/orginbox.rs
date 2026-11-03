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
    // who got a copy: only a received row has one, and only when the engine recorded it
    if r["dir"] == "in" {
        if let Some(names) = r.get("delivered_to").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
            o.insert("delivered_to".into(), names.clone());
        }
    }
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

/// A worker's job-scoped outside reply (D10): the send's own transaction re-checks the right `FOR SHARE` and writes
/// `via_job` in the same insert, so a fast answer can always find its thread.
pub struct JobReply<'a> {
    pub agent: i64,
    pub job: &'a str,
    pub out: &'a Outgoing,
}

/// Inside the send's transaction: the right found by the early check must still hold (spec §5).
#[logged]
pub(crate) async fn recheck_job_reply(client: &impl tokio_postgres::GenericClient, org_id: i64, j: &JobReply<'_>) -> Result<()> {
    jobs::recheck(client, org_id, j.agent, j.out, j.job, j.out.to.trim().trim_start_matches('@')).await
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
    let mut via_job: Option<String> = None;
    if let From::Agent { id, name, .. } = &out.from {
        match jobs::reply_right(engine, org_id, *id, out).await? {
            jobs::Reply::Allowed(job) => via_job = Some(job),
            jobs::Reply::NotApplicable => { ensure_holders(engine, org_id, Some((*id, name.as_str()))).await?; }
            // a holder or top-level agent keeps its own right; anyone else gets the job-specific refusal
            jobs::Reply::Refused => {
                if ensure_holders(engine, org_id, Some((*id, name.as_str()))).await.is_err() {
                    return Err(jobs::reply_refusal(to));
                }
            }
        }
    }
    if let Some(peer) = to.strip_prefix("net:") {
        let sender = match &out.from { From::Agent { id,generation,.. } => Some((*id,*generation)), _ => None };
        // D10: the reply remembers its job (written in the queueing transaction itself, after the right is re-checked
        // there), so the peer's answer can route back into the worker's thread (D13)
        let job_reply = match (&via_job, &out.from) { (Some(job), From::Agent { id, .. }) => Some(JobReply { agent: *id, job: job.as_str(), out }), _ => None };
        let (uid, to, transfer_ids) = crate::net::queue(engine, org_id, peer, &out.body, &by, sender, &out.kind, &out.attachments, out.reply_to.as_ref(), &out.replies, job_reply.as_ref()).await?;
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
    let (sender_agent, sender_gen) = match &out.from { From::Agent { id, generation, .. } => (Some(*id), Some(*generation)), _ => (None, None) };
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
    let mut replies_there: Vec<Value> = replies_here.iter().map(|q| {
        let mut q=q.clone();
        if let Some(o)=q.as_object_mut() { o.entry("org").or_insert_with(|| json!(src.slug)); }
        q
    }).collect();
    // D19: both rows carry one message id (the hub's format), so the receiver can thread a reply
    let msg_id = uuid::Uuid::new_v4().simple().to_string();
    let tx = client.transaction().await?;
    admit(&tx, &[org_id, dst.id]).await?;
    if let (Some(job), From::Agent { id, .. }) = (&via_job, &out.from) {
        recheck_job_reply(&tx, org_id, &JobReply { agent: *id, job: job.as_str(), out }).await?;
    }
    // a quote that names a message by its id is re-pointed at the receiver's own row of it (ids are per org)
    let mut reply_there = reply_there;
    for q in replies_there.iter_mut() {
        if let Some(n) = q["net_id"].as_str().map(str::to_string) {
            if let Some(r) = tx.query_opt(&format!("SELECT {QUOTE_COLS} FROM ot.org_inbox WHERE org_id=$1 AND net_id=$2 AND peer=$3 LIMIT 1"),
                &[&dst.id, &n, &src_peer]).await? {
                *q = inbox_quote(&r);
            }
        }
    }
    if let Some(first) = replies_there.first() {
        if first.get("box").is_some() { reply_there = Some(first.clone()); }
    }
    // Preserve the canonical kind for a later pull or Normal-mode release.
    tx
        .execute(
            "WITH o AS (INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, attachments, reply_to, replies, net_id, sender_agent_id, sender_generation, via_job)
                        VALUES ($1, $2, 'out', $3, $4, $5, 'delivered', now(), $6, $10, $12, $14, $15, $16, $17))
             INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, reply_to, replies, net_id) VALUES ($7, $8, 'in', $9, $4, $6, $11, $13, $14)",
            &[&out_uid, &org_id, &dst_peer, &out.body, &by, &attachments, &in_uid, &dst.id, &src_peer, &reply_here, &reply_there, &json!(replies_here), &json!(replies_there),
              &msg_id, &sender_agent, &sender_gen, &via_job],
        )
        .await?;
    tx.execute("UPDATE ot.org_inbox SET kind=$2 WHERE uid=$1", &[&in_uid,&out.kind]).await?;
    let (published, held) = publish_new(engine,&tx,dst.id,&in_uid).await?;
    let jobs::Published { route, copies: delivered, jobs: queued, changed: audience_changed } = published;
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
    let to_projects = !route.projects.is_empty();
    jobs::wake_jobs(engine, dst.id, queued);
    if !held && !to_projects && (holders.is_empty() || route.waiting) {
        if let Err(error) = super::runtime_notices::external_unroutable(engine,dst.id,&dst.slug,&src_peer,&out.body,holders).await {
            tracing::warn!(org_id = dst.id, %error, "outside mail committed; fallback notice failed");
        }
    }
    let everyone: Vec<String> = holders.iter().chain(route.projects.iter()).cloned().collect();
    let delivery = if held {
        format!("Stored in {}'s org inbox under Do not disturb or its ordered release queue; no agent copy or wake. An extern-audience holder can pull it.",dst.slug)
    } else if everyone.is_empty() {
        format!("Stored in {}'s org inbox; it has no live agent to read it yet.", dst.slug)
    } else if route.waiting {
        format!("Delivered to {}'s org inbox and to {}; none of them can run now (halted or frozen), so it waits for them.", dst.slug, holders.join(", "))
    } else {
        format!("Delivered to {}'s org inbox and to {}.", dst.slug, everyone.join(", "))
    };
    resume_pending(engine,dst.id).await;
    Ok(Sent { dnd_held: held, transfer_ids: Vec::new(), uid: out_uid, to: dst_peer, recipient_state: "live".into(), delivery, deferred: held || everyone.is_empty() || route.waiting })
}

/// Effective live audience holders, agents AND projects (USER 2026-11-03 mdf5da6c51202: a project
/// holds the org inbox "like an agent node"); newest grant wins in single-holder mode.
/// Each is `(name, kind)`, kind `agent` or `project`.
#[logged]
pub async fn holder_rows<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<(String, String)>> {
    let rows = client.query(
        "SELECT au.grantee, a.kind FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live'
         GROUP BY au.grantee, a.kind ORDER BY max(au.id) DESC LIMIT $2", &[&org_id, &(if multi { 10000i64 } else { 1i64 })]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// Every live holder's name, agents and projects, newest first. For the holders list and
/// busy presence; anything that acts AS a holder (send, pull, read, notices) uses `holder_agents`.
#[logged]
pub async fn live_holders<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<String>> {
    Ok(holder_rows(client, org_id, multi).await?.into_iter().map(|r| r.0).collect())
}

/// The agent holders (the newest-wins cut in single-holder mode is made across both kinds first).
#[logged]
pub async fn holder_agents<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<String>> {
    Ok(holder_rows(client, org_id, multi).await?.into_iter().filter(|r| r.1 == "agent").map(|r| r.0).collect())
}

/// The project holders: each gets one queued job per outside message.
#[logged]
pub async fn holder_projects<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<String>> {
    Ok(holder_rows(client, org_id, multi).await?.into_iter().filter(|r| r.1 == "project").map(|r| r.0).collect())
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

/// Busy presence (Mail hub 2.3.0; user 2026-10-30 23:03Z, docket
/// org-presence-busy-orange-when-no-org-inbox-holde): the org shows busy on
/// its hubs while none of its org-inbox holders can start a turn: no live
/// holder, every one halted or frozen (`runnable`: any freeze, usage limit,
/// rate limit, auth, balance, account or lane), or the org's killswitch
/// latched. One that can run means online. Holders only, as the user put it:
/// outside mail still reaches a runnable top-level agent through `route_tx`'s
/// fallback while the org shows busy (coordinator 2026-10-30 23:18Z).
#[logged]
pub async fn busy<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<bool> {
    let killed: bool = client.query_one("SELECT killswitch IS NOT NULL FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    if killed {
        return Ok(true);
    }
    let all = holder_rows(client, org_id, multi).await?;
    let agents: Vec<String> = all.iter().filter(|r| r.1 == "agent").map(|r| r.0.clone()).collect();
    if !runnable(client, org_id, &agents).await?.is_empty() {
        return Ok(false);
    }
    // a project holder is online while one of its armed fair_queue listeners belongs to an agent that can run
    let projects: Vec<String> = all.iter().filter(|r| r.1 == "project").map(|r| r.0.clone()).collect();
    if projects.is_empty() {
        return Ok(true);
    }
    Ok(client.query_opt(
        "SELECT 1 FROM ot.watchdogs w
           JOIN ot.agents a ON a.id = w.owner_agent_id AND a.state = 'live' AND a.kind = 'agent' AND a.halt IS NULL AND a.frozen IS NULL
           JOIN ot.agents p ON p.org_id = $1 AND p.name = ANY($2) AND p.id = (w.memo->>'target_id')::bigint
          WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state = 'armed' LIMIT 1",
        &[&org_id, &projects]).await?.is_none())
}

#[cfg(test)]
#[path = "orginbox_busy_tests.rs"]
mod busy_tests;

#[cfg(test)]
#[path = "orginbox_queue_tests.rs"]
mod queue_tests;

/// Who gets inbound outside mail (decision 59): the holders who can run;
/// while none can, the first top-level agent who can (no grant: the
/// audience stays with the holders). With nobody able to run it goes to the
/// holders and waits (`waiting`).
#[derive(Debug)]
struct Route {
    to: Vec<String>,
    waiting: bool,
    /// project holders: each gets one queued job (D6); never auto-granted or fallen back past
    projects: Vec<String>,
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
    if holder_agents(client, org_id, multi).await?.iter().any(|h| h == name) {
        return Ok(true);
    }
    Ok(client
        .query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.outside_top_level(id)", &[&agent_id, &org_id])
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
    let mut holders = holder_agents(&*tx, org_id, multi).await?;
    let projects = holder_projects(&*tx, org_id, multi).await?;
    let target = if let Some((id, name)) = sender {
        if holders.iter().any(|h| h == name) { None } else {
            let top = tx.query_opt("SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.outside_top_level(id)", &[&id, &org_id]).await?.is_some();
            if !top { crate::refuse!(Forbidden, "outside mail needs the org-inbox audience; ask your superior"); }
            Some((id, name.to_string(), "auto-granted: top-level agent messaged an outside party"))
        }
    } else if holders.is_empty() && projects.is_empty() {
        // the first top-level agent who can run; when none can, the first live one
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND ot.outside_top_level(id) AND state = 'live' AND kind = 'agent'
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
    let mut route = Route { to: holders.clone(), waiting: false, projects };
    if sender.is_none() && !holders.is_empty() {
        let ready = runnable(&*tx, org_id, &holders).await?;
        if !ready.is_empty() {
            route.to = ready;
        } else if !route.projects.is_empty() {
            // a project holder is a durable receiver: the unrunnable agent holders keep waiting copies, no fallback
        } else if let Some(r) = tx.query_opt(
            "SELECT name FROM ot.agents WHERE org_id = $1 AND ot.outside_top_level(id) AND state = 'live' AND kind = 'agent' AND halt IS NULL AND frozen IS NULL
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
    let (published, held) = publish_new(engine,&tx,org_id,&mention_mail_uid).await?;
    let jobs::Published { route, copies: delivered, jobs: queued, changed: audience_changed } = published;
    let holders = &route.to;
    super::mention_navigation::record_org_mail(&*tx,org_id,&mention_mail_uid,body).await?;
    tx.commit().await?;
    drop(client);
    wake_copies(engine, org_id, delivered);
    let to_projects = !route.projects.is_empty();
    jobs::wake_jobs(engine, org_id, queued);
    if audience_changed { changes::notify(engine,&org,vec![Change::Audiences,Change::Events]); }
    if !held && !to_projects && (holders.is_empty() || route.waiting) {
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
    -> Result<(jobs::Published,bool)> {
    let raw:Value=tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org]).await?.get(0);
    let backlog=tx.query_opt("SELECT 1 FROM ot.org_inbox WHERE org_id=$1 AND dnd_held LIMIT 1",&[&org]).await?.is_some();
    if mode(&raw)=="dnd" || backlog {
        tx.execute("UPDATE ot.org_inbox SET dnd_held=true WHERE uid=$1",&[&uid]).await?;
        return Ok((jobs::Published{route:Route{to:Vec::new(),waiting:false,projects:Vec::new()},copies:Vec::new(),jobs:Vec::new(),changed:false},true));
    }
    let row:Value=tx.query_one("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE uid=$1",&[&uid]).await?.get(0);
    Ok((jobs::publish(engine,tx,org,&raw,&row).await?,false))
}

#[path = "orginbox_jobs.rs"]
mod jobs;

#[logged]
async fn publish_row(tx:&tokio_postgres::Transaction<'_>,org:i64,holders:&[String],row:&Value)
    -> Result<Vec<(i64,String,String,bool)>> {
    let quotes=super::replies::snapshots(row.get("reply_to"),row.get("replies"));
    let copies=publish_copies(tx,org,holders,row["peer"].as_str().unwrap_or(""),row["body"].as_str().unwrap_or(""),
        row["kind"].as_str().unwrap_or("message"),&row["attachments"],&quotes,
        row["net_id"].as_str(),row["hub"].as_str()).await?;
    let names:Vec<&str>=copies.iter().map(|c|c.1.as_str()).collect();
    record_delivered(tx,row,&names).await?;
    Ok(copies)
}

/// `delivered_to` after these agents got a copy: the row's own list (in delivery
/// order) and each new name once.
pub(crate) fn delivered_with(row:&Value,names:&[&str]) -> Value {
    let mut all:Vec<Value>=row["delivered_to"].as_array().cloned().unwrap_or_default();
    for n in names {
        if !all.iter().any(|v|v.as_str()==Some(*n)) { all.push(json!(n)); }
    }
    Value::Array(all)
}

/// The record of who got the row's copies, in the transaction that made them
/// (the row is locked by the caller: just inserted, or `FOR UPDATE`).
#[logged]
pub(crate) async fn record_delivered(tx:&tokio_postgres::Transaction<'_>,row:&Value,names:&[&str]) -> Result<()> {
    if names.is_empty() { return Ok(()); }
    tx.execute("UPDATE ot.org_inbox SET delivered_to=$2 WHERE uid=$1",
        &[&row["uid"].as_str().unwrap_or(""),&delivered_with(row,names)]).await?;
    Ok(())
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
    let (route,_)=route_tx(&tx,org,None,&raw,&engine.settings.defaults()).await?;
    if route.to.is_empty() && route.projects.is_empty() {return Ok(0);}
    let mut copies=Vec::new();
    let mut queued=Vec::new();
    let mut changed=false;
    for row in &rows {
        let row:Value=row.get(0);
        let p=jobs::publish(engine,&tx,org,&raw,&row).await?;
        changed|=p.changed;
        copies.extend(p.copies);
        queued.extend(p.jobs);
        tx.execute("UPDATE ot.org_inbox SET dnd_held=false WHERE uid=$1",&[&row["uid"].as_str().unwrap()]).await?;
    }
    tx.commit().await?;
    drop(c);
    if changed {changes::notify_id(engine,org,vec![Change::Audiences,Change::Events]);}
    wake_copies(engine,org,copies);
    jobs::wake_jobs(engine,org,queued);
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

/// The wire form of "who got this message" (`delivered_to`): the record the
/// engine kept at delivery, never a list worked out when the viewer opens.
#[cfg(test)]
mod delivered_to_tests {
    use super::*;
    fn row(dir: &str, delivered: Value) -> Value {
        json!({"uid":"x1","dir":dir,"peer":"@net:alice.aa","body":"hello","at":"2026-10-29T12:00:00Z",
            "attachments":[],"tries":0,"delivered_to":delivered})
    }
    #[test] fn an_incoming_message_names_every_agent_that_got_a_copy_in_delivery_order() {
        let wire = entry(&row("in", json!(["coordinator-opus","liaison-opus","retired-reviewer"])));
        assert_eq!(wire["delivered_to"], json!(["coordinator-opus","liaison-opus","retired-reviewer"]));
        assert_eq!(wire["id"], "x1");
        assert_eq!(wire["peer"], "@net:alice.aa");
    }
    #[test] fn a_message_nobody_got_a_copy_of_carries_no_field() {
        for none in [json!([]), Value::Null] {
            assert!(entry(&row("in", none)).get("delivered_to").is_none());
        }
        let mut old = row("in", json!([]));
        old.as_object_mut().unwrap().remove("delivered_to");
        assert!(entry(&old).get("delivered_to").is_none(), "a row read before the column existed");
    }
    #[test] fn a_sent_row_never_carries_the_list() {
        assert!(entry(&row("out", json!(["coordinator-opus"]))).get("delivered_to").is_none());
    }
    #[test] fn the_list_keeps_delivery_order_and_names_each_agent_once() {
        let r = json!({"delivered_to":["a","b"]});
        assert_eq!(delivered_with(&r, &["b","c"]), json!(["a","b","c"]), "a later copy appends; a repeat adds nothing");
        assert_eq!(delivered_with(&r, &[]), json!(["a","b"]));
        assert_eq!(delivered_with(&json!({}), &["x"]), json!(["x"]), "a row read without the column");
        assert_eq!(delivered_with(&json!({"delivered_to":[]}), &[]), json!([]));
    }
    #[test] fn the_migration_adds_the_column_and_fills_in_hub_mail_by_its_exact_key_only() {
        let sql = include_str!("../../migrations/0079_org_inbox_delivered_to.sql");
        let code: String = sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join(" ");
        assert!(code.contains("ADD COLUMN IF NOT EXISTS delivered_to jsonb NOT NULL DEFAULT '[]'"));
        assert!(code.contains("CHECK (jsonb_typeof(delivered_to) = 'array')"));
        assert!(code.contains("i.dir = 'in' AND i.org_id = c.org_id AND i.net_id = c.net_id"),
            "the backfill joins received rows to the copies on (org_id, net_id), the key the insert dedupes on");
        assert!(code.contains("recipient_kind = 'agent' AND net_id IS NOT NULL"), "only agent copies that carry the hub key");
        assert!(!code.contains("body"), "no message text is ever matched to guess a recipient");
    }
    #[test] fn publication_release_and_pull_each_write_the_list_with_the_copies() {
        // publication and the release of held mail both go through publish_row
        let source = include_str!("orginbox.rs");
        let source = &source[..source.find("mod org_dnd_tests").unwrap()]; // this file's code, not these assertions (the earlier test modules hold only paths)
        let publish_row = &source[source.find("async fn publish_row").unwrap()..];
        let publish_row = &publish_row[..publish_row.find("pub(crate) fn delivered_with").unwrap()];
        assert!(publish_row.contains("publish_copies(") && publish_row.contains("record_delivered(tx,row,&names)"),
            "the list is written by the call that made the copies, in its transaction");
        assert!(source.contains("jobs::publish(engine,&tx,org,&raw,&row)"), "the release of held mail routes through it");
        assert!(source.contains("jobs::publish(engine,tx,org,&raw,&row)"), "so does a new arrival");
        let jobs = include_str!("orginbox_jobs.rs");
        assert!(jobs.contains("publish_row(tx, org, &route.to, row)"), "and the routing publishes the agent copies with it");
        let pull = include_str!("../tools/org_inbox.rs");
        assert!(pull.contains("delivered_to=$3") && pull.contains("orginbox::delivered_with(&row,&[who.name.as_str()])"),
            "a Do not disturb pull adds the pulling agent");
    }
}

/// USER 2026-10-30 mc1739129bbfa: which agent an org mail was delivered to is opaque to outside listeners.
/// `delivered_to` (migration 0079) is read by the local desktop views and written at delivery, and goes
/// nowhere else: not in the hub wire payload, a receipt, an ack or a reply quote. The three builders that
/// make those take a Postgres row or a live request, so they are guarded at their source: the only files
/// that name the column are the ones that should, the quote is made from seven named columns, and the
/// payload, receipt and ack bodies carry exactly the keys they always did.
#[cfg(test)]
mod delivered_to_stays_inside_the_org {
    use super::*;
    use std::collections::BTreeSet;

    fn between<'a>(source: &'a str, from: &str, to: &str) -> &'a str {
        let start = source.find(from).unwrap_or_else(|| panic!("`{from}` not found"));
        let rest = &source[start..];
        &rest[..rest.find(to).unwrap_or_else(|| panic!("`{to}` not found after `{from}`"))]
    }
    /// every `.rs` file under src/ that names the column, as a src-relative path with forward slashes
    fn files_naming_the_column() -> (BTreeSet<String>, usize) {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() { walk(&p, out) } else if p.extension().is_some_and(|x| x == "rs") { out.push(p) }
            }
        }
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut all = vec![];
        walk(&src, &mut all);
        let named = all.iter()
            .filter(|p| std::fs::read_to_string(p).unwrap().contains("delivered_to"))
            .map(|p| p.strip_prefix(&src).unwrap().to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
            .collect();
        (named, all.len())
    }

    #[test] fn only_the_delivery_and_the_local_views_name_the_column() {
        let (named, scanned) = files_naming_the_column();
        assert!(scanned > 100, "an empty scan is not a pass ({scanned} files)");
        let allowed: BTreeSet<String> = ["domain/orginbox.rs", "domain/orginbox_jobs.rs", "domain/orginbox_queue_tests.rs", "migrate.rs", "tools/org_inbox.rs", "tools/treetools.rs"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(named, allowed, "a new file naming `delivered_to` needs checking against USER 2026-10-30 mc1739129bbfa (opaque to outside listeners); treetools.rs has a watchdog result of the same name");
        for f in &named {
            assert!(!f.starts_with("net") && !f.starts_with("mailhub"), "the hub transport ({f}) must not read the delivery record");
        }
    }
    #[test] fn the_hub_wire_payload_names_no_delivery_record_and_keeps_its_keys() {
        let net = include_str!("../net.rs");
        let payload = between(net, "fn outgoing_payload", "    Ok(payload)");
        assert!(!payload.contains("delivered_to") && !payload.contains("via_job"), "the job a worker replied from never rides the hub wire");
        for key in ["\"id\": net_id", "\"to\":", "\"body\":", "\"kind\":", "\"sent_at\":", "\"from\": from", "\"attachments\": attachments"] {
            assert!(payload.contains(key), "the payload keeps {key}");
        }
        let assigned: BTreeSet<&str> = payload.split("payload[\"").skip(1).filter_map(|s| s.split('"').next()).collect();
        assert_eq!(assigned, BTreeSet::from(["reply_to", "meta", "body"]), "the keys added after the literal");
        assert!(net.contains("&outgoing_payload(&r, &net_id, &p.net_slug, att_ids)?"), "`from` is the org's hub address, not an agent");
    }
    #[test] fn receipts_and_acks_carry_only_ids_states_and_times() {
        let net = include_str!("../net.rs");
        assert!(net.contains("json!({ \"id\": mid, \"state\": st, \"at\": now_iso() })"), "a receipt is id, state, at");
        assert!(net.contains(".json(&json!({ \"receipts\": body }))"));
        assert!(net.contains(".json(&json!({ \"ids\": ack }))"), "an ack is ids");
    }
    #[test] fn a_reply_quote_is_made_from_seven_named_columns_never_the_whole_row() {
        assert_eq!(QUOTE_COLS, "uid, dir, peer, by_name, at, body, net_id");
        assert!(!QUOTE_COLS.contains("via_job"));
        let source = include_str!("orginbox.rs");
        let source = &source[..source.find("#[cfg(test)]").unwrap()]; // this file's code, not these assertions
        let quote = between(source, "fn inbox_quote", "pub async fn sent_quote");
        assert!(!quote.contains("delivered_to") && !quote.contains("to_jsonb"), "the quote is built from its columns, not a row dump");
        assert_eq!(source.matches("SELECT {QUOTE_COLS} FROM ot.org_inbox").count(), 4, "every quote query selects only QUOTE_COLS (the fourth re-points an @org: reply at the receiver's own row, D19)");
    }
    #[test] fn the_local_wire_of_a_row_with_a_list_is_the_only_place_it_appears() {
        let row = json!({"uid":"x1","dir":"in","peer":"@net:alice.aa","body":"hello","at":"2026-10-29T12:00:00Z",
            "attachments":[],"tries":0,"delivered_to":["coordinator-opus","liaison-opus"],
            "reply_to":{"kind":"mail","box":"org","id":"q1","from":"@net:alice.aa","peer":"@net:alice.aa","at":"2026-10-29T11:00:00Z","gist":"earlier"}});
        let wire = entry(&row);
        assert_eq!(wire["delivered_to"], json!(["coordinator-opus","liaison-opus"]), "the local view has it");
        let quote = wire["reply_to"].to_string();
        assert!(!quote.contains("delivered_to") && !quote.contains("coordinator-opus") && !quote.contains("liaison-opus"), "the quote the row carries has no recipients");
    }
}
