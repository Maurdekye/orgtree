//! The org mailbox: the organization's one face to the outside world (other
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

/// The user's "Outside communication" value (USER 2026-11-25 14:10:26Z m16ef9bb35e25): `org` (Org decides,
/// the default: the org mailbox holders choose open or closed), or an explicit `normal`, `dnd` or `closed` that
/// overrides the org's choice. A stored legacy `false` without a mode is the user's `closed`.
#[nolog]
pub fn user_mode(settings: &Value) -> &'static str {
    match settings["org_inbox_mode"].as_str() {
        Some("normal") => "normal",
        Some("dnd") => "dnd",
        Some("closed") => "closed",
        Some("org") => "org",
        _ if settings["org_inbox_enabled"] == json!(false) => "closed",
        _ => "org",
    }
}

/// The org's own choice under Org decides: `normal` (open, the default) or `closed`.
#[nolog]
pub fn org_choice(settings: &Value) -> &'static str {
    if settings["org_inbox_org_mode"] == "closed" { "closed" } else { "normal" }
}

/// After `normalize_patch`, with the stored settings read under the writer's row lock: Org decides takes the
/// effective gate from the org's choice (stored, or set in the same patch).
#[nolog]
pub fn resolve_patch(patch: &mut Map<String, Value>, stored: &Value) {
    let user = patch.get("org_inbox_mode").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| user_mode(stored).to_owned());
    if user == "org" && (patch.contains_key("org_inbox_mode") || patch.contains_key("org_inbox_org_mode")) {
        let choice = patch.get("org_inbox_org_mode").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| org_choice(stored).to_owned());
        patch.insert("org_inbox_enabled".into(), json!(choice != "closed"));
    }
}

/// All policy writers keep the new enum and legacy isolation boolean in step.
#[logged]
pub fn normalize_patch(patch: &mut Map<String, Value>) -> Result<()> {
    if let Some(value) = patch.get("org_inbox_org_mode") {
        if !value.as_str().is_some_and(|m| matches!(m, "normal" | "closed")) {
            crate::refuse!(BadRequest,"org_inbox_org_mode must be normal or closed");
        }
    }
    if let Some(value) = patch.get("org_inbox_mode") {
        let Some(mode) = value.as_str().filter(|m| matches!(*m,"org"|"normal"|"dnd"|"closed")) else {
            crate::refuse!(BadRequest,"org_inbox_mode must be org, normal, dnd or closed");
        };
        if mode == "org" {
            // the gate follows the org's choice: `resolve_patch` sets it once the stored settings are read
            if patch.get("org_inbox_enabled").is_some_and(|v| !v.is_boolean()) {
                crate::refuse!(BadRequest,"org_inbox_enabled must be true or false");
            }
            patch.insert("org_inbox_enabled".into(), json!(org_choice(&Value::Object(patch.clone())) != "closed"));
            return Ok(());
        }
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

/// An org mailbox holder (primary or weak link) chooses open (`normal`) or `closed` for the org under Org decides
/// (USER 2026-11-25 14:10:26Z m16ef9bb35e25). The user's explicit value wins: then agents can't change it.
/// The holder's link and the user's value are checked under the settings writer's row lock.
#[logged]
pub async fn set_org_choice(engine: &Arc<Engine>, org_id: i64, agent: &str, choice: &str) -> Result<Value> {
    if !matches!(choice, "normal" | "closed") {
        crate::refuse!(BadRequest, "mode must be normal (open) or closed");
    }
    let pause = engine.net.isolation.pause(org_id).await;
    let mut conn = engine.db.get().await?;
    let tx = conn.transaction().await?;
    let stored: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR NO KEY UPDATE", &[&org_id]).await?.get(0);
    if mailbox_link(&*tx, org_id, agent).await?.is_none() {
        crate::refuse!(Forbidden, "only an agent holding the org mailbox (primary or weak link) may open or close it");
    }
    let user = user_mode(&stored);
    if user != "org" {
        crate::refuse!(Forbidden, "the user set outside communication to {user}; only the user can change it (set it to Org decides to hand it back)");
    }
    let mut patch = Map::new();
    patch.insert("org_inbox_org_mode".into(), json!(choice));
    resolve_patch(&mut patch, &stored);
    let changed = stored["org_inbox_enabled"].as_bool().unwrap_or(true) != patch["org_inbox_enabled"].as_bool().unwrap_or(true);
    tx.execute("UPDATE ot.orgs SET settings = settings || $2, row_version = row_version + 1 WHERE id = $1", &[&org_id, &Value::Object(patch.clone())]).await?;
    tx.execute("INSERT INTO ot.events (org_id, op, actor, detail, via) VALUES ($1, 'settings', $2, $3, $4)",
        &[&org_id, &agent, &Value::Object(patch), &crate::caller::via()]).await?;
    tx.commit().await?;
    drop(conn);
    drop(pause);
    if changed {
        crate::net::kick(engine);
        changes::notify_id(engine, org_id, vec![Change::OrgInbox, Change::Net, Change::Org]);
        resume_pending(engine, org_id).await;
    } else {
        changes::notify_id(engine, org_id, vec![Change::Org]);
    }
    Ok(json!({ "setting": "org", "org_choice": choice, "actual": choice }))
}

/// Lockdown (USER 2026-11-25 13:37Z Q5): keep an unlisted sender's letter out of delivery. Only its envelope and
/// inline body are kept: a long body or files are not downloaded (the hub's retention may remove them before
/// anyone reads it). Nothing routes it: no copies, jobs, promotion, grants, phone setup or notices.
#[logged]
pub async fn set_aside_inbound(engine: &Engine, org_id: i64, hub: &str, m: &Value) -> Result<()> {
    let Some(net_id) = m["id"].as_str().filter(|s| !s.is_empty()) else { return Ok(()) };
    let from = m["from"].as_str().unwrap_or("unknown");
    let mut body = m["body"].as_str().unwrap_or("").to_owned();
    if m["body_bytes"].is_number() {
        body.push_str("\n\n[set aside by the lockdown: the rest of this long message was not downloaded]");
    }
    let files: Vec<Value> = m["attachments"].as_array().into_iter().flatten()
        .map(|a| json!({ "name": a["name"], "bytes": a["bytes"], "not_downloaded": true })).collect();
    if !files.is_empty() {
        body.push_str(&format!("\n\n[set aside by the lockdown: {} file(s) were not downloaded]", files.len()));
    }
    engine.db.get().await?.execute(
        "INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, net_id, hub, set_aside_at, set_aside_meta)
         SELECT $1, $2, 'in', $3, $4, $5, $6, now(), $7
          WHERE NOT EXISTS (SELECT 1 FROM ot.org_inbox WHERE org_id = $2 AND dir = 'in' AND net_id = $5)",
        &[&uid("m"), &org_id, &format!("@net:{from}"), &crate::util::pg_text(&body).as_ref(), &net_id, &hub,
          &crate::util::pg_json(&json!({ "files": files, "body_bytes": m["body_bytes"], "reply_to": m["reply_to"], "sent_at": m["sent_at"] })).as_ref()],
    ).await?;
    changes::notify_id(engine, org_id, vec![Change::OrgInbox]);
    Ok(())
}

#[nolog]
pub fn check(settings: &Value) -> Result<()> {
    if !enabled(settings) {
        crate::refuse!(Forbidden, "the organization's inbox is disabled; outside communication and its history are unavailable");
    }
    Ok(())
}

/// The most a file sent to another organization on this computer holds: what an export holds
/// (USER 2026-11-23 20:30Z, question 13).
pub const ORG_ATTACHMENT_MAX: u64 = crate::portable::SIZE_MAX;

/// Before a file is copied for mail to `@org:` on this computer: the refusals of the send that
/// cost nothing to know (both mailboxes open, the other organization there, the sender allowed
/// to write outside), and the folder of that organization's mailbox the copies go to. Nothing is
/// granted or changed here; the send itself decides again.
#[logged]
pub(crate) async fn attachment_room(engine: &Engine, org_id: i64, sender: (i64, &str), to: &str) -> Result<std::path::PathBuf> {
    require_enabled(engine, org_id).await?;
    let slug = to.trim().trim_start_matches('@').strip_prefix("org:").unwrap_or("").trim();
    let Some(dst) = engine.orgs.get(slug) else {
        crate::refuse!(NotFound, "no organization @org:{slug} on this machine (orgtree_list_orgs lists them)");
    };
    if dst.id == org_id {
        crate::refuse!(BadRequest, "@org:{slug} is this organization; write to the agent directly");
    }
    require_enabled(engine, dst.id).await?;
    let client = engine.db.get().await?;
    let raw: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    if !holder_agents(&**client, org_id, multi).await?.iter().any(|holder| holder == sender.1) {
        let top = client
            .query_opt("SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.outside_top_level(id)", &[&sender.0, &org_id])
            .await?
            .is_some();
        if !top {
            crate::refuse!(Forbidden, "outside mail needs the org-mailbox audience; ask your superior");
        }
    }
    // where what arrives over the mail hub is kept too (`net::incoming`)
    Ok(engine.cfg.path("uploads").join(&dst.slug).join("@org-inbox").join(uid("orgmail")))
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

/// THE LOCAL COPIES OF AN INBOUND ROW, for a mail link's "View in @agent's inbox" at that agent's own copy (docket
/// mail-link-context-menus-open-in-recipient-s-inbo; @coordinator-opus me123cd3dfa03): each holder's ot.mail row, an
/// agent's copy by `extra.org_inbox_source`, a project's job by `extra.org_inbox.uid`, in delivery order. Only the
/// holders the row names are searched. A copy made before the stamp is not found, so it gets no entry.
#[logged]
pub(crate) async fn row_copies(client: &impl tokio_postgres::GenericClient, org_id: i64, row: &Value) -> Result<Value> {
    let uid = row["uid"].as_str().unwrap_or("");
    let names = row["delivered_to"].clone();
    if row["dir"] != "in" || !names.as_array().is_some_and(|a| !a.is_empty()) { return Ok(json!([])); }
    let rows = client.query(
        "SELECT m.recipient_name, m.uid FROM ot.mail m
          WHERE m.org_id = $1 AND (m.extra->>'org_inbox_source' = $2 OR m.extra->'org_inbox'->>'uid' = $2)
            AND m.recipient_agent_id IN (SELECT a.id FROM ot.agents a WHERE a.org_id = $1
                                          AND a.name IN (SELECT jsonb_array_elements_text($3::jsonb)))
          ORDER BY m.id",
        &[&org_id, &uid, &names]).await?;
    Ok(Value::Array(rows.iter().map(|r| json!({ "agent": r.get::<_, String>(0), "id": r.get::<_, String>(1) })).collect()))
}

/// The columns a reply's quote is made from (`inbox_quote`).
const QUOTE_COLS: &str = "uid, dir, peer, by_name, at, body, net_id";

/// What a reply quotes of an org-mailbox row: who wrote it, when and a gist
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

/// An outside message an agent sent from the org mailbox (the id
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
async fn net_quote(client: &tokio_postgres::Client, org_id: i64, net_id: &str, peer:&str) -> Result<Option<(Value, String)>> {
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
    Ok(r.as_ref().map(|r| (inbox_quote(r), r.get::<_, String>(5))))
}

/// Hubchat starts a reply with one `> ` line quoting the message it answers (that message's first line, at most
/// 120 characters: Hubchat's docs/question-cards.md), for clients that don't read `reply_to`. Orgtree shows the
/// answered message in the reply block, so the body drops the line, but only when it is exactly the quote Hubchat
/// writes for `original`: a deliberate quote of anything else stays, and so does a body that would be left empty.
/// A stale-arrival note in front stays first (USER 2026-11-05 15:59:52Z mb1883a706391: "this hubchat reply includes
/// the context twice"). `None`: keep the body as it came.
#[nolog]
pub(crate) fn without_reply_quote(body: &str, original: &str) -> Option<String> {
    let first: String = original.lines().next().unwrap_or("").chars().take(HUBCHAT_QUOTE_CHARS).collect();
    let quote = format!("> {first}\n");
    let (note, rest) = match body.starts_with(STALE_NOTE).then(|| body.find("]\n\n")).flatten() {
        Some(end) => body.split_at(end + 3),
        None => ("", body),
    };
    let text = rest.strip_prefix(quote.as_str())?;
    if text.trim().is_empty() {
        return None;
    }
    Some(format!("{note}{text}"))
}

/// Hubchat's quote length (`QUOTE_CHARS` in its questions.rs).
const HUBCHAT_QUOTE_CHARS: usize = 120;
/// How net.rs `publish_inbound` starts a late arrival's note.
const STALE_NOTE: &str = "[arrived via the mail hub — sent ";

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
    let mut via_weak = false;
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
        // a send over a weak link (not a job's reply): its replies come back only while the link stands
        if via_job.is_none() {
            let c = engine.db.get().await?;
            via_weak = mailbox_link(&**c, org_id, name).await? == Some("weak");
        }
    }
    if let Some(peer) = to.strip_prefix("net:") {
        // lockdown: the org may still write to an unlisted address, warned; a question to one is refused (Q4, I8)
        let lockdown_warning = { let c = engine.db.get().await?; crate::net::lockdown::outbound(&**c, org_id, peer, &out.kind).await? };
        let sender = match &out.from { From::Agent { id,generation,.. } => Some((*id,*generation)), _ => None };
        // D10: the reply remembers its job (written in the queueing transaction itself, after the right is re-checked
        // there), so the peer's answer can route back into the worker's thread (D13)
        let job_reply = match (&via_job, &out.from) { (Some(job), From::Agent { id, .. }) => Some(JobReply { agent: *id, job: job.as_str(), out }), _ => None };
        let (uid, to, transfer_ids) = crate::net::queue(engine, org_id, peer, &out.body, &by, sender, &out.kind, &out.attachments, out.reply_to.as_ref(), &out.replies, job_reply.as_ref(), via_weak).await?;
        changes::notify(engine, &src, vec![Change::OrgInbox, Change::Spark { from: out.from.spark(), to: "org_inbox".into() }]);
        return Ok(Sent { dnd_held: false,
            transfer_ids,
            uid,
            to,
            recipient_state: "remote".into(),
            delivery: {
                let queued = "Queued for the mail hub. The message waits until all files are uploaded; inspect transfer_ids with orgtree_transfers (the org mailbox also shows progress).";
                match lockdown_warning { Some(w) => format!("{queued} {w}"), None => queued.to_string() }
            },
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
        recheck_job_reply(&*tx, org_id, &JobReply { agent: *id, job: job.as_str(), out }).await?;
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
            "WITH o AS (INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, by_name, state, state_at, attachments, reply_to, replies, net_id, sender_agent_id, sender_generation, via_job, via_weak)
                        VALUES ($1, $2, 'out', $3, $4, $5, 'delivered', now(), $6, $10, $12, $14, $15, $16, $17, $18))
             INSERT INTO ot.org_inbox (uid, org_id, dir, peer, body, attachments, reply_to, replies, net_id) VALUES ($7, $8, 'in', $9, $4, $6, $11, $13, $14)",
            &[&out_uid, &org_id, &dst_peer, &out.body, &by, &attachments, &in_uid, &dst.id, &src_peer, &reply_here, &reply_there, &json!(replies_here), &json!(replies_there),
              &msg_id, &sender_agent, &sender_gen, &via_job, &via_weak],
        )
        .await?;
    tx.execute("UPDATE ot.org_inbox SET kind=$2 WHERE uid=$1", &[&in_uid,&out.kind]).await?;
    // delivered here and now: a weak link's send moves the org's last seen (USER meb7815aff52d)
    if via_weak { weak_sent(&*tx, org_id).await?; }
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
    if via_weak { crate::net::kick(engine); }
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
        format!("Stored in {}'s org mailbox under Do not disturb or its ordered release queue; no agent copy or wake. An extern-audience holder can pull it.",dst.slug)
    } else if everyone.is_empty() {
        format!("Stored in {}'s org mailbox; it has no live agent to read it yet.", dst.slug)
    } else if route.waiting {
        format!("Delivered to {}'s org mailbox; no agent there can run now (halted or frozen), so it waits for them.", dst.slug)
    } else {
        // who in the receiving org got it stays inside that org (failover, multi-reply; review A10)
        format!("Delivered to {}'s org mailbox.", dst.slug)
    };
    resume_pending(engine,dst.id).await;
    Ok(Sent { dnd_held: held, transfer_ids: Vec::new(), uid: out_uid, to: dst_peer, recipient_state: "live".into(), delivery, deferred: held || everyone.is_empty() || route.waiting })
}

/// Effective live audience holders, agents AND projects (USER 2026-11-03 mdf5da6c51202: a project
/// holds the org mailbox "like an agent node"); newest grant wins in single-holder mode.
/// Each is `(name, kind)`, kind `agent` or `project`.
#[logged]
pub async fn holder_rows<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<(String, String)>> {
    let rows = client.query(
        "SELECT au.grantee, a.kind FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live'
         GROUP BY au.grantee, a.kind ORDER BY max(au.id) DESC LIMIT $2", &[&org_id, &(if multi { 10000i64 } else { 1i64 })]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// The live agents holding a weak link to the org mailbox (`@extern-weak`), newest first: they may send as the org;
/// nothing routes inbound mail to them except replies to their own (`jobs::threaded`, D13).
#[logged]
pub async fn weak_agents<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64) -> Result<Vec<String>> {
    let rows = client.query(
        "SELECT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantor = '@extern-weak' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live' AND a.kind = 'agent'
         GROUP BY au.grantee ORDER BY max(au.id) DESC", &[&org_id]).await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Which link to the org mailbox this live node holds: `primary` (`@extern`), `weak` (`@extern-weak`) or none.
/// The one check for "may act as a mailbox holder" (blocking: USER 2026-11-24 m61f5367a61e7). A primary in
/// single-holder mode is any live grant: the grant itself revokes the others.
#[logged]
pub async fn mailbox_link<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, name: &str) -> Result<Option<&'static str>> {
    let row = client.query_opt(
        "SELECT bool_or(au.grantor = '@extern') FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
         WHERE au.org_id = $1 AND au.grantee = $2 AND au.grantor IN ('@extern', '@extern-weak') AND au.revoked_at IS NULL AND NOT au.paused
           AND a.state = 'live'", &[&org_id, &name]).await?;
    Ok(match row.and_then(|r| r.get::<_, Option<bool>>(0)) {
        Some(true) => Some("primary"),
        Some(false) => Some("weak"),
        None => None,
    })
}

/// Whether every holder of the org mailbox is unable to receive (the failover trigger): no live agent holder can run a
/// turn (halted, frozen, retired or none), and no project holder has a worker: an armed or paused fair_queue listener
/// of a live agent, or a live agent holding one of its jobs not yet acked (`in_charge`'s arms; @coordinator-opus,
/// review item 1: a worker busy on a job is not unable).
#[logged]
async fn holders_unable<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<bool> {
    let all = holder_rows(client, org_id, multi).await?;
    let agents: Vec<String> = all.iter().filter(|r| r.1 == "agent").map(|r| r.0.clone()).collect();
    if !runnable(client, org_id, &agents).await?.is_empty() {
        return Ok(false);
    }
    let projects: Vec<String> = all.iter().filter(|r| r.1 == "project").map(|r| r.0.clone()).collect();
    if projects.is_empty() {
        return Ok(true);
    }
    Ok(client.query_opt(
        "SELECT 1 FROM ot.watchdogs w
           JOIN ot.agents a ON a.id = w.owner_agent_id AND a.state = 'live' AND a.kind = 'agent'
           JOIN ot.agents p ON p.org_id = $1 AND p.name = ANY($2) AND p.id = (w.memo->>'target_id')::bigint
          WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state IN ('armed', 'paused')
         UNION ALL
         SELECT 1 FROM ot.mail m
           JOIN ot.agents p ON p.org_id = $1 AND p.name = ANY($2) AND p.id = m.recipient_agent_id
           JOIN ot.agents a ON a.id = (m.extra->'claimed'->>'by_id')::bigint AND a.state = 'live' AND a.kind = 'agent'
          WHERE m.state = 'read' AND m.extra->'claimed'->>'ack' = 'true' AND m.extra->'claimed'->>'acked_at' IS NULL
            AND NOT (m.extra ? 'dead_letter')
         LIMIT 1",
        &[&org_id, &projects]).await?.is_none())
}

/// Busy's own holder rule (unchanged): no agent holder can run, and no project holder has an armed fair_queue listener
/// of an agent that can run.
#[logged]
async fn holders_busy<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<bool> {
    let all = holder_rows(client, org_id, multi).await?;
    let agents: Vec<String> = all.iter().filter(|r| r.1 == "agent").map(|r| r.0.clone()).collect();
    if !runnable(client, org_id, &agents).await?.is_empty() {
        return Ok(false);
    }
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

/// Failover (USER 2026-11-25 09:49:41Z m872c7d4f0973 and refinements; @coordinator-opus m22e544059017): while every
/// holder is unable to receive (`holders_unable`, the same rule as busy), the weak-link agent that can run and whose
/// weak link was granted earliest ACTS as the holder for online status, last seen and UNTHREADED new mail only. It is
/// computed each time, so it hands back the moment a holder can receive; nothing is granted or stored as a link.
#[logged]
pub async fn acting_weak<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Option<String>> {
    if !holders_unable(client, org_id, multi).await? {
        return Ok(None);
    }
    Ok(client.query_opt(
        "SELECT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
          WHERE au.org_id = $1 AND au.grantor = '@extern-weak' AND au.revoked_at IS NULL AND NOT au.paused
            AND a.state = 'live' AND a.kind = 'agent' AND a.halt IS NULL AND a.frozen IS NULL
          GROUP BY au.grantee, a.id ORDER BY ot.agent_dnd(a.id), min(au.id) LIMIT 1", &[&org_id]).await?.map(|r| r.get(0)))
}

/// The acting holder kept as state (`ot.orgs.net.acting_holder`; @coordinator-opus Q3, so a restart doesn't repeat
/// the start notice): `Some((before, now))` when it changed, `None` when it is as stored.
#[logged]
pub async fn note_acting<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, acting: Option<&str>) -> Result<Option<(Option<String>, Option<String>)>> {
    let row = client.query_one(
        "WITH old AS (SELECT net->>'acting_holder' AS a FROM ot.orgs WHERE id = $1),
              up AS (UPDATE ot.orgs SET net = CASE WHEN $2::text IS NULL THEN coalesce(net, '{}'::jsonb) - 'acting_holder' - 'acting_since'
                                                   ELSE coalesce(net, '{}'::jsonb) || jsonb_build_object('acting_holder', $2::text, 'acting_since', now()) END
                      WHERE id = $1 AND (net->>'acting_holder') IS DISTINCT FROM $2::text RETURNING 1)
         SELECT (SELECT a FROM old), EXISTS (SELECT 1 FROM up)", &[&org_id, &acting]).await?;
    let changed: bool = row.get(1);
    Ok(changed.then(|| (row.get(0), acting.map(str::to_string))))
}

/// The start of failover (or a change of acting link), told when the first mail is actually diverted (review items 9,
/// 10, 12): in that delivery's transaction, the acting name is kept as state and the notices are queued: the user (one
/// line on a change), and the acting agent.
#[logged]
async fn failover_started(tx: &tokio_postgres::Transaction<'_>, org_id: i64, acting: &str) -> Result<()> {
    let Some((before, _)) = note_acting(&*tx, org_id, Some(acting)).await? else { return Ok(()) };
    let slug: String = tx.query_one("SELECT slug FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let user = match &before {
        None => format!("@{acting} is now the acting holder of {slug}'s org mailbox: no holder can receive mail (halted, frozen or retired). Until one can, new outside mail with no reply reference goes to @{acting}, and the org shows online. Replies still go to whoever their thread belongs to; the link stays a weak link."),
        Some(a) => format!("The acting holder of {slug}'s org mailbox changed from @{a} to @{acting}."),
    };
    tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state) VALUES($1,$2,'@system','user','@user','message',$3,'pending')",
        &[&crate::util::uid("m"), &org_id, &user]).await?;
    let to_agent = "You are now the acting holder of the org mailbox: no holder can receive mail (halted, frozen or retired). Until one can, new outside mail with no reply reference comes to you, and your turns keep the org online and its last seen moving. Your link stays a weak link, and replies in a holder's threads still wait for that holder.";
    tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,state)
                SELECT $1, $2, '@system', 'agent', id, name, 'system', $4, 'pending' FROM ot.agents WHERE org_id=$2 AND name=$3 AND state='live'",
        &[&crate::util::uid("m"), &org_id, &acting, &to_agent]).await?;
    Ok(())
}

/// Each network pass: for every org with a stored acting holder whether failover ENDED (a holder can receive again,
/// or no weak link can act): the user, the acting agent and the returning holders are told once, the holders with
/// the contacts the acting link handled. The start is told by the first diverted mail (`failover_started`).
#[logged]
pub async fn watch_failover(engine: &Arc<Engine>) -> Result<()> {
    let client = engine.db.get().await?;
    // the org mailbox's "acting holder" mark follows the live state: redraw it when it changes (a freeze or a thaw
    // changes it without any mail)
    static SHOWN: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<i64, Option<String>>>> = std::sync::LazyLock::new(Default::default);
    for o in client.query(
        "SELECT o.id, o.settings FROM ot.orgs o WHERE o.state = 'active' AND (o.net ? 'acting_holder' OR EXISTS (SELECT 1 FROM ot.audiences au
           WHERE au.org_id = o.id AND au.grantor = '@extern-weak' AND au.revoked_at IS NULL))", &[]).await? {
        let (org_id, raw): (i64, Value) = (o.get(0), o.get(1));
        let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
        let now = acting_weak(&**client, org_id, multi).await?;
        let changed = SHOWN.lock().map(|mut m| m.insert(org_id, now.clone()) != Some(now)).unwrap_or(false);
        if changed { changes::notify_id(engine, org_id, vec![Change::OrgInbox]); }
    }
    let orgs = client.query(
        "SELECT o.id, o.slug, o.settings, (o.net->>'acting_since')::timestamptz FROM ot.orgs o WHERE o.state = 'active' AND o.net ? 'acting_holder'", &[]).await?;
    for o in orgs {
        let (org_id, slug, raw, since): (i64, String, Value, Option<chrono::DateTime<chrono::Utc>>) = (o.get(0), o.get(1), o.get(2), o.get(3));
        let multi = crate::feed::groups::effective_settings(&raw, &engine.settings.defaults())["org_inbox_multi_holder"].as_bool().unwrap_or(false);
        let acting = if enabled(&raw) { acting_weak(&**client, org_id, multi).await? } else { None };
        if acting.is_some() {
            continue; // still failing over: a change of acting link is told by the next diverted mail
        }
        let mut c = engine.db.get().await?;
        let tx = c.transaction().await?;
        let Some((Some(was), None)) = note_acting(&*tx, org_id, None).await? else { continue };
        let contacts: Vec<String> = tx.query(
            "SELECT DISTINCT peer FROM ot.org_inbox WHERE org_id=$1 AND dir='in' AND set_aside_at IS NULL AND delivered_to ? $2 AND at >= coalesce($3, '-infinity'::timestamptz) ORDER BY peer",
            &[&org_id, &was, &since]).await?.iter().map(|r| r.get(0)).collect();
        let handled = if contacts.is_empty() { "no new outside mail".to_string() } else { format!("new outside mail from {}", contacts.join(", ")) };
        let user = format!("A holder of {slug}'s org mailbox can receive mail again: @{was} is no longer acting holder, and new outside mail goes to the holder. @{was} handled {handled}.");
        tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state) VALUES($1,$2,'@system','user','@user','message',$3,'pending')",
            &[&crate::util::uid("m"), &org_id, &user]).await?;
        // the state and every notice commit together: a restart in between neither loses nor repeats them (review A9)
        let to_acting = format!("You are no longer the acting holder of the org mailbox: a holder can receive mail again, so new outside mail goes to it. Replies to mail you sent or received still come to you. You handled {handled}.");
        let to_holder = format!("While no holder of the org mailbox could receive mail, @{was} was the acting holder and handled {handled}. New outside mail comes to you again; replies to those messages stay with @{was}.");
        let mut told: Vec<(String, String)> = vec![(was.clone(), to_acting)];
        for holder in runnable(&*tx, org_id, &holder_agents(&*tx, org_id, multi).await?).await? {
            told.push((holder, to_holder.clone()));
        }
        let mut woken: Vec<i64> = Vec::new();
        for (name, text) in &told {
            if let Some(r) = tx.query_opt("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,state)
                        SELECT $1, $2, '@system', 'agent', id, name, 'system', $4, 'pending' FROM ot.agents WHERE org_id=$2 AND name=$3 AND state='live'
                        RETURNING recipient_agent_id",
                &[&crate::util::uid("m"), &org_id, name, text]).await? {
                woken.push(r.get(0));
            }
        }
        tx.commit().await?;
        let mut ch = vec![Change::UserMail, Change::OrgInbox];
        for id in woken {
            ch.push(Change::Mailbox(id));
            crate::runtime::wake(engine, org_id, id);
        }
        changes::notify_id(engine, org_id, ch);
    }
    Ok(())
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
/// its hubs while none of its org-mailbox holders can start a turn: no live
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
    // failover: an acting weak link keeps the org online (USER 2026-11-25 m872c7d4f0973)
    Ok(holders_busy(client, org_id, multi).await? && acting_weak(client, org_id, multi).await?.is_none())
}

/// The agents in charge of the org mailbox (last active, Mail hub 2.6.0;
/// docket hubchat-last-seen-time-for-orgs-people-and-indep): the live agent
/// holders, and for a project holder the live agents whose fair_queue
/// listener targets it, armed or paused, and those holding one of its jobs
/// not yet acked (a listener may be spent or paused while its owner works
/// the job: the owner stays in charge exactly then). Halted or frozen ones
/// count too. While a weak link acts as the holder (failover, `acting_weak`), it is in charge too. Agent ids, in id order.
#[logged]
pub async fn in_charge<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, multi: bool) -> Result<Vec<i64>> {
    let all = holder_rows(client, org_id, multi).await?;
    let mut agents: Vec<String> = all.iter().filter(|r| r.1 == "agent").map(|r| r.0.clone()).collect();
    if let Some(acting) = acting_weak(client, org_id, multi).await? {
        agents.push(acting);
    }
    let projects: Vec<String> = all.iter().filter(|r| r.1 == "project").map(|r| r.0.clone()).collect();
    let rows = client.query(
        "SELECT a.id FROM ot.agents a WHERE a.org_id = $1 AND a.name = ANY($2) AND a.state = 'live' AND a.kind = 'agent'
         UNION
         SELECT a.id FROM ot.watchdogs w
           JOIN ot.agents a ON a.id = w.owner_agent_id AND a.state = 'live' AND a.kind = 'agent'
           JOIN ot.agents p ON p.org_id = $1 AND p.name = ANY($3) AND p.id = (w.memo->>'target_id')::bigint
          WHERE w.org_id = $1 AND w.kind = 'fair_queue' AND w.state IN ('armed', 'paused')
         UNION
         SELECT a.id FROM ot.mail m
           JOIN ot.agents p ON p.org_id = $1 AND p.name = ANY($3) AND p.id = m.recipient_agent_id
           JOIN ot.agents a ON a.id = (m.extra->'claimed'->>'by_id')::bigint AND a.state = 'live' AND a.kind = 'agent'
          WHERE m.state = 'read' AND m.extra->'claimed'->>'ack' = 'true' AND m.extra->'claimed'->>'acked_at' IS NULL
            AND NOT (m.extra ? 'dead_letter')
         ORDER BY 1",
        &[&org_id, &agents, &projects]).await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// When each of these agents' last finished turn ended (None: it never
/// finished one). A turn the engine's start-up recovery closed (`runtime::
/// recover`: killed, with its error "the engine stopped during this turn")
/// is no turn end: the engine stopped, the agent didn't finish anything
/// (@last-seen-review-fable G2).
#[logged]
pub async fn last_turn_ends<C: tokio_postgres::GenericClient + Sync>(client: &C, ids: &[i64]) -> Result<Vec<(i64, Option<chrono::DateTime<chrono::Utc>>)>> {
    let rows = client.query(
        "SELECT a.id, (SELECT t.ended_at FROM ot.turns t
                         WHERE t.agent_id = a.id AND t.ended_at IS NOT NULL
                           AND NOT (t.killed AND t.error IS NOT DISTINCT FROM 'the engine stopped during this turn')
                         ORDER BY t.id DESC LIMIT 1)
           FROM unnest($1::bigint[]) AS a(id) ORDER BY a.id",
        &[&ids]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// The org's last-active mark (`ot.orgs.net.last_active_at`): raised to
/// `newest` when that is later, never lowered or cleared; the mark after.
/// A sent time is never unsent (@coordinator-opus 2026-11-24 13:27Z).
#[logged]
pub async fn raise_last_active<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64, newest: Option<chrono::DateTime<chrono::Utc>>) -> Result<Option<chrono::DateTime<chrono::Utc>>> {
    let row = client.query_one(
        "WITH up AS (
           UPDATE ot.orgs SET net = jsonb_set(net, '{last_active_at}', to_jsonb($2::timestamptz))
            WHERE id = $1 AND $2::timestamptz IS NOT NULL
              AND (net->>'last_active_at' IS NULL OR (net->>'last_active_at')::timestamptz < $2::timestamptz)
           RETURNING net)
         SELECT (coalesce((SELECT net FROM up), (SELECT net FROM ot.orgs WHERE id = $1))->>'last_active_at')::timestamptz",
        &[&org_id, &newest]).await?;
    Ok(row.get(0))
}

/// A mail a weak link sent as the org has left (the hub took it, or a local org got it): the org was seen now
/// (USER 2026-11-25 09:48Z meb7815aff52d "a mail send from a weak link should update the last seen time, but it
/// shouldnt count as active now while a weak link holder is active"). It raises the same never-lowered mark the
/// turn ends of the agents in charge raise (`raise_last_active`); "active now" and busy still come from those
/// agents only (`in_charge` holds no weak link). The caller kicks the network pass once committed, so hubs with
/// `last_active` hear it at once.
#[logged]
pub async fn weak_sent<C: tokio_postgres::GenericClient + Sync>(client: &C, org_id: i64) -> Result<()> {
    raise_last_active(client, org_id, Some(chrono::Utc::now())).await?;
    Ok(())
}

#[cfg(test)]
#[path = "orginbox_busy_tests.rs"]
mod busy_tests;

#[cfg(test)]
#[path = "orginbox_queue_tests.rs"]
mod queue_tests;

#[cfg(test)]
#[path = "orginbox_relay_tests.rs"]
mod relay_tests;

#[cfg(test)]
#[path = "orginbox_weak_tests.rs"]
mod weak_tests;

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
/// changing nothing: the org mailbox is enabled, and the agent holds its
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
    if weak_agents(client, org_id).await?.iter().any(|h| h == name) {
        return Ok(true);
    }
    Ok(client
        .query_opt("SELECT 1 FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.outside_top_level(id)", &[&agent_id, &org_id])
        .await?
        .is_some())
}

/// What kind of mail `route_tx` routes: new mail (unthreaded, or a send), or a reply whose references resolved but
/// whose owners are all cut off (it waits for the holders; never the acting weak link).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Arrival { New, Thread }

/// Serialize only this org's short audience update; never hold the transaction over sending or IO.
#[logged]
async fn ensure_holders(engine: &Arc<Engine>, org_id: i64, sender: Option<(i64, &str)>) -> Result<Route> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let raw: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1 FOR UPDATE", &[&org_id]).await?.get(0);
    check(&raw)?;
    let (route, changed) = route_tx(&tx, org_id, sender, &raw, &engine.settings.defaults(), Arrival::New).await?;
    tx.commit().await?;
    if changed { changes::notify_id(engine, org_id, vec![Change::Audiences, Change::OrgInbox, Change::Events]); }
    Ok(route)
}

/// Resolve routing under the publication/policy lock, never from a stale mode.
#[logged]
async fn route_tx(tx: &tokio_postgres::Transaction<'_>, org_id:i64, sender:Option<(i64,&str)>, raw:&Value,
    defaults:&Map<String,Value>, arrival:Arrival) -> Result<(Route,bool)> {
    let settings = crate::feed::groups::effective_settings(raw, defaults);
    let multi = settings["org_inbox_multi_holder"].as_bool().unwrap_or(false);
    // a release of held or waiting mail (`release_after`) keeps today's routing: the backlog stays with the holders
    // (review item 8; the user's U3 is open)
    let releasing: bool = tx.query_one("SELECT coalesce(current_setting('orgtree.releasing', true), '') = 'on'", &[]).await?.get(0);
    // failover (USER 2026-11-25 m872c7d4f0973): while every holder is unable to receive, new UNTHREADED mail goes to
    // the acting weak link alone (one copy, no job, no waiting copies; review item 2), before the top-level fallback
    // and the auto-grant below; nothing is granted. The first diverted mail tells it (`failover_started`).
    // promotion (USER 2026-11-25 mff1aa564451b; @coordinator-opus m423778515c90): with NO primary grant at all, new mail
    // promotes a weak link to a real, persisted primary (its weak link drops): the earliest-granted that can run, else
    // the earliest-granted; with no weak link, today's auto-grant below. A retired holder whose grant stands keeps it.
    let mut promoted = false;
    if sender.is_none() && arrival == Arrival::New && !releasing && tx.query_opt(
        "SELECT 1 FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
          WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND a.state IN ('live', 'archived') LIMIT 1",
        &[&org_id]).await?.is_none() {
        if let Some(r) = tx.query_opt(
            "SELECT au.grantee, a.id FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
              WHERE au.org_id = $1 AND au.grantor = '@extern-weak' AND au.revoked_at IS NULL AND NOT au.paused AND a.state = 'live' AND a.kind = 'agent'
              GROUP BY au.grantee, a.id, a.halt, a.frozen ORDER BY (a.halt IS NULL AND a.frozen IS NULL) DESC, min(au.id) LIMIT 1", &[&org_id]).await? {
            let (name, id): (String, i64) = (r.get(0), r.get(1));
            let reason = "promoted: the org mailbox had no holder, so its earliest weak link became the holder";
            tx.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantee = $2 AND grantor = '@extern-weak' AND revoked_at IS NULL", &[&org_id, &name]).await?;
            tx.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, '@extern', $3)", &[&org_id, &name, &reason]).await?;
            tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', '@system', $2, $3)",
                &[&org_id, &id, &json!({"grantee": name, "grantor": super::audiences::EXTERN, "reason": reason})]).await?;
            let slug: String = tx.query_one("SELECT slug FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
            let user = format!("{slug}'s org mailbox had no holder when new outside mail arrived, so @{name} was promoted from its weak link and is now the holder.");
            tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state) VALUES($1,$2,'@system','user','@user','message',$3,'pending')",
                &[&crate::util::uid("m"), &org_id, &user]).await?;
            let to_agent = "You are now the holder of the org mailbox: it had no holder, so new outside mail promoted you from your weak link. New outside mail comes to you; you may read and pull the org mailbox.";
            tx.execute("INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,state) VALUES($1,$2,'@system','agent',$3,$4,'system',$5,'pending')",
                &[&crate::util::uid("m"), &org_id, &id, &name, &to_agent]).await?;
            promoted = true;
        }
    }
    // C (USER mff1aa564451b): mail waiting before the takeover (a release) goes to the stand-in too
    if sender.is_none() && arrival == Arrival::New && !promoted {
        if let Some(acting) = acting_weak(&*tx, org_id, multi).await? {
            failover_started(tx, org_id, &acting).await?;
            return Ok((Route { to: vec![acting], waiting: false, projects: Vec::new() }, false));
        }
    }
    // a reply whose thread owners are all cut off (a removed or retired weak sender, a recipient without a link)
    // goes to the holders and waits for them, retired ones included (review items 3, 5, 6)
    if sender.is_none() && arrival == Arrival::Thread {
        let holders = tx.query(
            "SELECT au.grantee FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
              WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND NOT au.paused
                AND a.state IN ('live', 'archived') AND a.kind = 'agent'
              GROUP BY au.grantee ORDER BY max(au.id) DESC LIMIT $2", &[&org_id, &(if multi { 10000i64 } else { 1i64 })]).await?;
        let holders: Vec<String> = holders.iter().map(|r| r.get(0)).collect();
        let projects = holder_projects(&*tx, org_id, multi).await?;
        if !holders.is_empty() || !projects.is_empty() {
            return Ok((Route { to: holders, waiting: false, projects }, false));
        }
        // G (USER mff1aa564451b): no real holder at all: it waits (no copy, no grant) for whoever next becomes holder,
        // and a later release hands it over
        return Ok((Route { to: Vec::new(), waiting: true, projects: Vec::new() }, false));
    }
    let mut holders = holder_agents(&*tx, org_id, multi).await?;
    let projects = holder_projects(&*tx, org_id, multi).await?;
    let mut weak = false;
    let target = if let Some((id, name)) = sender {
        if holders.iter().any(|h| h == name) || weak_agents(&*tx, org_id).await?.iter().any(|h| h == name) { None } else {
            let top = tx.query_opt("SELECT id FROM ot.agents WHERE id = $1 AND org_id = $2 AND state = 'live' AND kind = 'agent' AND ot.outside_top_level(id)", &[&id, &org_id]).await?.is_some();
            if !top { crate::refuse!(Forbidden, "outside mail needs the org-mailbox audience (or a weak link to it); ask your superior"); }
            // Q1 (USER 2026-11-24 19:06:02Z m61f5367a61e7): while the mailbox has a holder, the sender takes a weak
            // link, never the primary; with none it becomes the holder, as before
            // an unrevoked primary grant to a retired holder still counts (review item 7): no auto-grant during failover
            weak = !holder_rows(&*tx, org_id, multi).await?.is_empty() || tx.query_opt(
                "SELECT 1 FROM ot.audiences au JOIN ot.agents a ON a.org_id = au.org_id AND a.name = au.grantee
                  WHERE au.org_id = $1 AND au.grantor = '@extern' AND au.revoked_at IS NULL AND a.state = 'archived' LIMIT 1",
                &[&org_id]).await?.is_some();
            Some((id, name.to_string(), if weak { "auto-granted: top-level agent messaged an outside party while the org mailbox has a holder" }
                else { "auto-granted: top-level agent messaged an outside party" }))
        }
    } else if holders.is_empty() && projects.is_empty() {
        // the first top-level agent who can run; when none can, the first live one
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND ot.outside_top_level(id) AND state = 'live' AND kind = 'agent'
                       ORDER BY (halt IS NULL AND frozen IS NULL) DESC, sibling_order, id LIMIT 1", &[&org_id]).await?
            .map(|r| (r.get(0), r.get(1), "auto-granted: outside mail arrived with no live org-mailbox holder"))
    } else { None };
    let mut changed = promoted;
    if let Some((id, name, reason)) = target {
        let grantor = if weak { super::audiences::EXTERN_WEAK } else { super::audiences::EXTERN };
        if !multi && !weak {
            tx.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantor = '@extern' AND revoked_at IS NULL", &[&org_id]).await?;
            holders.clear();
        }
        if !weak {
            tx.execute("UPDATE ot.audiences SET revoked_at = now() WHERE org_id = $1 AND grantee = $2 AND grantor = '@extern-weak' AND revoked_at IS NULL", &[&org_id, &name]).await?;
        }
        tx.execute("INSERT INTO ot.audiences (org_id, grantee, grantor, reason) VALUES ($1, $2, $3, $4)", &[&org_id, &name, &grantor, &reason]).await?;
        tx.execute("INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'audience_grant', '@system', $2, $3)",
            &[&org_id, &id, &json!({"grantee": name, "grantor": grantor, "reason": reason})]).await?;
        if !weak { holders.push(name); }
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
    let mut answered=None;
    for id in references.iter().take(super::replies::MAX_REPLIES) {
        match net_quote(&client,org_id,id,peer).await? {
            Some((q,original)) => { if quotes.is_empty() { answered=Some(original); } quotes.push(q); }
            None => quotes.push(json!({"net_id":id,"gist":"Original message unavailable"})),
        }
    }
    // One answered message we hold: Hubchat's quote of it is the reply block's job (a multi-reply's quote lines,
    // with their Answer/Skipped lines, stay as they came).
    let shown=if quotes.len()==1 { answered.as_deref().and_then(|o| without_reply_quote(body,o)) } else { None };
    let body=shown.as_deref().unwrap_or(body);
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
pub(crate) mod jobs;

#[logged]
async fn publish_row(tx:&tokio_postgres::Transaction<'_>,org:i64,holders:&[String],row:&Value)
    -> Result<Vec<(i64,String,String,bool)>> {
    let quotes=super::replies::snapshots(row.get("reply_to"),row.get("replies"));
    let copies=publish_copies(tx,org,holders,row["peer"].as_str().unwrap_or(""),row["body"].as_str().unwrap_or(""),
        row["kind"].as_str().unwrap_or("message"),&row["attachments"],&quotes,
        row["net_id"].as_str(),row["hub"].as_str(),row["uid"].as_str().unwrap_or("")).await?;
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

/// The rows a release pass hands out: held by Do not disturb, or WAITING. Waiting mail is an unread
/// inbound row nobody got a copy of (`delivered_to` empty) and no one pulled: it arrived while no
/// org-mailbox holder existed (USER 2026-11-09 m01535356a9d7; docket
/// `org-mail-that-arrives-before-any-mailbox-holder-e`). The partial indexes `org_inbox_dnd_held` and
/// `org_inbox_waiting` serve the two halves, so an idle org costs two index probes.
const RELEASABLE: &str = "(set_aside_at IS NULL AND (dnd_held OR (dir='in' AND NOT read AND pulled_by IS NULL AND delivered_to='[]'::jsonb)))";

/// One bounded transaction. Retained inactive history is never scanned.
#[logged]
pub async fn release_page(engine:&Arc<Engine>,org:i64) -> Result<usize> {
    Ok(release_after(engine,org,0).await?.0)
}

/// `release_page` for the rows after `after` (their id): how many it handled, and the last id seen.
/// Waiting mail goes only to a holder that already exists: this pass never grants the audience
/// (only a Do not disturb backlog keeps the auto-grant it always had).
#[logged]
async fn release_after(engine:&Arc<Engine>,org:i64,after:i64) -> Result<(usize,i64)> {
    let mut c=engine.db.get().await?;
    // Cheap indexed negative probe before taking the policy lock.
    if c.query_opt(&format!("SELECT 1 FROM ot.org_inbox WHERE org_id=$1 AND id>$2 AND {RELEASABLE} LIMIT 1"),&[&org,&after]).await?.is_none() {return Ok((0,after));}
    let tx=c.transaction().await?;
    // the backlog keeps today's routing, never the acting weak link (`route_tx`)
    tx.execute("SET LOCAL orgtree.releasing = 'on'",&[]).await?;
    let raw:Value=tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR UPDATE",&[&org]).await?.get(0);
    if mode(&raw)!="normal" {return Ok((0,after));}
    let rows=tx.query(&format!("SELECT to_jsonb(i) FROM ot.org_inbox i WHERE org_id=$1 AND id>$2 AND {RELEASABLE} ORDER BY id LIMIT 100 FOR UPDATE"),&[&org,&after]).await?;
    if rows.is_empty() {return Ok((0,after));}
    let rows:Vec<Value>=rows.iter().map(|r|r.get(0)).collect();
    if !rows.iter().any(|r|r["dnd_held"]==true) {
        let settings=crate::feed::groups::effective_settings(&raw,&engine.settings.defaults());
        let multi=settings["org_inbox_multi_holder"].as_bool().unwrap_or(false);
        if holder_rows(&*tx,org,multi).await?.is_empty() {return Ok((0,after));}
    }
    // no pre-routing here: it could write a grant before any row's own thread is known (review A6); each row's
    // thread resolves first in jobs::publish, and only unthreaded rows reach the router
    let mut copies=Vec::new();
    let mut queued=Vec::new();
    let mut changed=false;
    let mut last=after;
    for row in &rows {
        let p=jobs::publish(engine,&tx,org,&raw,row).await?;
        changed|=p.changed;
        copies.extend(p.copies);
        queued.extend(p.jobs);
        tx.execute("UPDATE ot.org_inbox SET dnd_held=false WHERE uid=$1",&[&row["uid"].as_str().unwrap()]).await?;
        last=row["id"].as_i64().unwrap_or(last);
    }
    tx.commit().await?;
    drop(c);
    if changed {changes::notify_id(engine,org,vec![Change::Audiences,Change::Events]);}
    wake_copies(engine,org,copies);
    jobs::wake_jobs(engine,org,queued);
    Ok((rows.len(),last))
}

/// Save and inbound paths start the drain now. The normal runtime tick retries
/// after a restart/failure; committed publication never gets reported as failed.
#[logged]
pub async fn resume_pending(engine:&Arc<Engine>,org:i64) {
    let mut after=0;
    loop {
        match release_after(engine,org,after).await {
            Ok((100,last))=>{after=last;tokio::task::yield_now().await}
            Ok(_)=>break,
            Err(error)=>{tracing::warn!(org_id=org,%error,"org mailbox release deferred to runtime recovery");break;}
        }
    }
}

/// Both local and hub delivery publish the retained row and holder copies in
/// the same transaction; a setting change cannot split a fanout.
#[allow(clippy::too_many_arguments)]
#[logged]
pub(crate) async fn publish_copies(tx: &tokio_postgres::Transaction<'_>, org_id: i64, holders: &[String],
    peer: &str, body: &str, kind: &str, attachments: &Value, quotes: &[Value],
    net_id: Option<&str>, hub: Option<&str>, org_row: &str) -> Result<Vec<(i64, String, String, bool)>> {
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
            // `org_inbox_source`: the org mailbox row this copy came from, so the two can open each other (docket
            // mail-link-context-menus-open-in-recipient-s-inbo; the same key a pulled copy already carried)
            "INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,body,attachments,reply_to,ev,state,net_id,net_hub,replies,extra)
             VALUES($1,$2,$3,'agent',$4,$5,$12,$6,$7,$8,$9,'pending',$10,$11,$13,jsonb_build_object('org_inbox_source',$14::text))",
            &[&mail_uid,&org_id,&peer,&target_id,h,&crate::util::pg_text(body).as_ref(),
              &crate::util::pg_json(attachments).as_ref(),
              &crate::util::pg_json_option(&reply).as_ref(),&crate::util::pg_json(&ev).as_ref(),&net_id,&hub,&kind,&json!(replies),&org_row],
        ).await?;
        if state == "live" && !halted {
            // Keep the transactional outside-mail reset identical to recovery::forget_hard_fail.
            tx.execute("UPDATE ot.agents SET extra = extra - 'hard_fail_run' WHERE id = $1 AND extra ? 'hard_fail_run'", &[&target_id]).await?;
        }
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
        // USER 2026-11-25 14:10:26Z: the setting shows the user's value (Org decides by default) and what is in force
        assert_eq!(effective["org_inbox_mode"],"org");assert_eq!(effective["org_inbox_actual"],"normal");assert_eq!(effective["org_inbox_enabled"],true);
    }
}

#[cfg(test)]
mod reply_quote_tests {
    use super::*;
    /// The message Orgtree sent, shaped like the user's report: a first line longer than Hubchat's 120 characters.
    const SENT: &str = "Here's what the fix does now. When a panel is resized from its bottom-right corner, the frame follows the pointer and the content keeps its scroll position.\n\nSecond paragraph.";
    fn hubchat_reply(original: &str, text: &str) -> String {
        let first: String = original.lines().next().unwrap_or("").chars().take(120).collect();
        format!("> {first}\n{text}")
    }
    #[test] fn a_hubchat_reply_drops_its_quote_of_the_message_it_answers() {
        let body = hubchat_reply(SENT, "Looks good, ship it.");
        assert_eq!(without_reply_quote(&body, SENT).as_deref(), Some("Looks good, ship it."));
    }
    #[test] fn a_multi_line_reply_keeps_every_line_after_the_quote() {
        let body = hubchat_reply(SENT, "One thing:\n\n> my own quote of something else\nstill mine");
        assert_eq!(without_reply_quote(&body, SENT).as_deref(), Some("One thing:\n\n> my own quote of something else\nstill mine"));
    }
    #[test] fn a_short_original_and_crlf_and_unicode_quote_exactly() {
        let sent = "שלום, done ✓\nmore";
        assert_eq!(without_reply_quote(&hubchat_reply(sent, "תודה"), sent).as_deref(), Some("תודה"));
        let long: String = "é".repeat(130);
        assert_eq!(without_reply_quote(&hubchat_reply(&long, "ok"), &long).as_deref(), Some("ok"), "120 characters, not bytes");
    }
    #[test] fn a_stale_arrival_note_stays_in_front() {
        let body = format!("[arrived via the mail hub — sent 2026-11-05T10:00:00Z, 5.0 hours ago; the sender may have moved on]\n\n{}", hubchat_reply(SENT, "late answer"));
        assert_eq!(without_reply_quote(&body, SENT).as_deref(),
            Some("[arrived via the mail hub — sent 2026-11-05T10:00:00Z, 5.0 hours ago; the sender may have moved on]\n\nlate answer"));
    }
    #[test] fn a_deliberate_quote_that_does_not_match_stays() {
        for body in ["> Here's what the fix does now.\nnot Hubchat's exact quote", "> something else entirely\nmine",
                     "Looks good.\n> Here's what the fix does now.", ">Here's what the fix does now. When a panel\nno space"] {
            assert_eq!(without_reply_quote(body, SENT), None, "{body:?}");
        }
    }
    #[test] fn a_quote_with_nothing_after_it_stays() {
        assert_eq!(without_reply_quote(&hubchat_reply(SENT, ""), SENT), None);
        assert_eq!(without_reply_quote(&hubchat_reply(SENT, "  \n"), SENT), None);
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
        // the release pass walks `&rows`, so each held row is already a reference (1bdabae)
        assert!(source.contains("jobs::publish(engine,&tx,org,&raw,row)"), "the release of held mail routes through it");
        assert!(source.contains("jobs::publish(engine,tx,org,&raw,&row)"), "so does a new arrival");
        let jobs = include_str!("orginbox_jobs.rs");
        assert!(jobs.contains("publish_row(tx, org, &route.to, row)"), "and the routing publishes the agent copies with it");
        let pull = include_str!("../tools/org_inbox.rs");
        assert!(pull.contains("delivered_to=$3") && pull.contains("orginbox::delivered_with(&row,&[who.name.as_str()])"),
            "a Do not disturb pull adds the pulling agent");
    }
}

#[cfg(test)]
mod set_aside_tests {
    /// Set-aside letters stay out of the acting link's handover summary (lockdown review B4; the other paths are
    /// checked in net/lockdown_tests.rs).
    #[test] fn the_acting_handover_summary_leaves_set_aside_letters_out() {
        // the code only, before the test modules (this test's own text would match itself)
        let src = include_str!("orginbox.rs");
        let flat = src[..src.find("mod set_aside_tests").unwrap()].split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(flat.contains("dir='in' AND set_aside_at IS NULL AND delivered_to ? $2"));
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
        let allowed: BTreeSet<String> = ["domain/orginbox.rs", "domain/orginbox_jobs.rs", "domain/orginbox_queue_tests.rs", "domain/orginbox_weak_tests.rs", "migrate.rs", "tools/org_inbox.rs", "tools/treetools.rs"]
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
