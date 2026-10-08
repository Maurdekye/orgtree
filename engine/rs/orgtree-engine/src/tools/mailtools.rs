//! orgtree_message / orgtree_send_notice / orgtree_status / orgtree_inbox.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, me, need_str, Done};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::runtime::Caller;
use crate::util::{gist, iso};

const KINDS: &[&str] = &["message", "question", "request", "decision", "status"];

/// The agent's working folder.
#[logged]
pub async fn scratch_of(engine: &Engine, client: &tokio_postgres::Client, caller: &Caller, agent_id: i64) -> Result<PathBuf> {
    let r = client.query_one("SELECT name, scratch_dir FROM ot.agents WHERE id = $1", &[&agent_id]).await?;
    let name: String = r.get(0);
    Ok(r.get::<_, Option<String>>(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| engine.cfg.scratch_root(&caller.org_slug).join(name)))
}

#[logged]
pub async fn message(engine: &Arc<Engine>, caller: &Caller, args: &Value, force_notice: bool) -> Result<Done> {
    let to = need_str(args, "to")?.to_string();
    let body = args.get("body").and_then(Value::as_str).unwrap_or("").to_string();
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    drop(client);
    let kind = arg_str(args, "kind").unwrap_or("message");
    if !KINDS.contains(&kind) {
        crate::refuse!(BadRequest, "kind must be one of {}", KINDS.join(", "));
    }
    let mut out = Outgoing::new(From::Agent { id: me.id, name: me.name.clone(), generation: me.generation }, &to, &body);
    out.kind = kind.to_string();
    out.notice = force_notice || args["notice"].as_bool().unwrap_or(false);
    let to_user = matches!(to.trim_start_matches('@'), "user");
    if args["urgent"].as_bool().unwrap_or(false) {
        if !to_user {
            crate::refuse!(BadRequest, "urgent is only for mail to the user");
        }
        let Some(reason) = arg_str(args, "urgent_reason") else {
            crate::refuse!(BadRequest, "urgent needs urgent_reason: one line telling the user why this interrupts them now");
        };
        out.urgent = true;
        out.urgent_reason = Some(gist(reason, 300));
    }
    let attachments = args["attachments"].as_array().cloned().unwrap_or_default();
    if attachments.len() > 10 { crate::refuse!(BadRequest, "at most 10 attachments"); }
    if !attachments.is_empty() {
        out.to = mail::attachment_recipient(engine, me.org_id, &to).await?;
        let network = out.to.trim().trim_start_matches('@').starts_with("net:");
        if !to_user && !network {
            crate::refuse!(BadRequest, "attachments ride mail to the user or @net: peers; for local recipients use paths");
        }
        let org = engine.orgs.by_id(me.org_id).ok_or_else(|| anyhow::anyhow!("organization not open"))?;
        let presenter = crate::domain::docs::presenter(engine, &org, me.id).await?;
        if to_user && !presenter.may_present { crate::refuse!(Forbidden, "mail to the user needs a user audience"); }
        let limit = if network { Some(crate::net::attachment_limit(engine, me.org_id, &out.to).await?) } else { None };
        for a in attachments {
            let Some(path) = a.as_str() else { crate::refuse!(BadRequest, "attachment paths must be strings"); };
            out.attachments.push(crate::domain::docs::snapshot(&presenter, path, limit.as_ref())?);
        }
    }
    let sent = mail::send(engine, me.org_id, out).await?;
    let box_name = if to_user { "user_inbox".to_string() } else { sent.to.clone() };
    let text = format!("Sent to {} (id {}). {}", sent.to, sent.uid, sent.delivery);
    Ok(Done { text, card: Some(json!({ "mail": { "id": sent.uid, "to": box_name } })) })
}

#[logged]
pub async fn status(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let status = need_str(args, "status")?;
    if !["working", "done", "blocked", "idle"].contains(&status) {
        crate::refuse!(BadRequest, "status must be working, done, blocked or idle");
    }
    let summary = gist(arg_str(args, "summary").unwrap_or(""), 600);
    // "done" is a report, not a state: the agent is idle afterwards
    let state = if status == "done" { "idle" } else { status };
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let rec = json!({ "status": state, "summary": summary, "at": iso(chrono::Utc::now()) });
    client
        .execute(
            "UPDATE ot.agents SET prev_status = last_status, last_status = $2, row_version = row_version + 1 WHERE id = $1",
            &[&me.id, &rec],
        )
        .await?;
    client
        .execute(
            "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, 'status', $2, $3, $4)",
            &[&me.org_id, &me.name, &me.id, &json!({ "status": status, "summary": summary })],
        )
        .await?;
    // 3.x: a top-level agent's report goes nowhere — the user already gets
    // its own reply mail, and a second [DONE] digest was pure duplication
    // (user ruling); its status chip is the record
    let superior: Option<String> = match me.parent_id {
        Some(p) => client.query_opt("SELECT name FROM ot.agents WHERE id = $1", &[&p]).await?.map(|r| r.get(0)),
        None => None,
    };
    let top_level = me.parent_id.is_none();
    drop(client);
    changes::notify_id(engine, me.org_id, vec![Change::Agent(me.id), Change::Events, Change::History(me.id)]);
    let mut told = String::new();
    if status == "done" || status == "blocked" {
        if let Some(sup) = superior {
            let mut out = Outgoing::new(
                From::Agent { id: me.id, name: me.name.clone(), generation: me.generation },
                &sup,
                &format!("Status: {status} — {summary}"),
            );
            out.kind = "status".into();
            out.notice = true;
            out.ev = Some(crate::events::status_report(&caller.org_slug, &me.name, me.generation as i64, status, &summary));
            if mail::send(engine, me.org_id, out).await.is_ok() {
                told = format!(" {sup} gets it as a notice at its next turn.");
            }
        } else if top_level {
            told = " Status chip only — report your actual results to the user via orgtree_message.".to_string();
        }
    }
    let shown = if status == "done" { "done (you are idle now)" } else { status };
    Done::text(format!("Status recorded: {shown}.{told}"))
}


/// UTF-8 chunks concatenate exactly; the handle binds reads to an immutable body digest.
#[logged]
fn mail_chunk(body: &str, index: usize) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let mut spans = Vec::new();
    let mut start = 0;
    loop {
        let mut end = (start + 64 * 1024).min(body.len());
        while !body.is_char_boundary(end) { end -= 1; }
        spans.push((start, end));
        if end == body.len() { break; }
        start = end;
    }
    let Some(&(start, end)) = spans.get(index) else { crate::refuse!(BadRequest, "chunk_index is outside this message"); };
    let content = &body[start..end];
    Ok(json!({"body_bytes": body.len(), "body_sha256": hex::encode(Sha256::digest(body.as_bytes())),
        "chunk_index": index, "chunk_total": spans.len(), "chunk_sha256": hex::encode(Sha256::digest(content.as_bytes())),
        "content": content, "content_state": "present", "complete": spans.len() == 1}))
}

#[logged]
pub async fn inbox(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let action = need_str(args, "action")?;
    let allowed = match action {
        "list" => vec!["action", "cursor", "limit"], "fetch" => vec!["action", "message_ids"],
        "chunk" => vec!["action", "delivery_id", "message_id", "chunk_index"],
        _ => crate::refuse!(BadRequest, "action must be list, fetch or chunk"),
    };
    if args.as_object().map(|a| a.keys().any(|k| !allowed.contains(&k.as_str()))).unwrap_or(true) {
        crate::refuse!(BadRequest, "the manual inbox reads only your own mailbox; it takes no agent, node, org or mailbox argument");
    }
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    if action == "list" {
        let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200);
        let after = match args["cursor"].as_str() {
            None => 0,
            Some(c) => {
                let values: Vec<&str> = c.split(':').collect();
                if values.len() != 2 || values[0] != me.id.to_string() { crate::refuse!(BadRequest, "invalid inbox cursor"); }
                values[1].parse::<i64>().ok().filter(|x| *x >= 0).ok_or_else(|| anyhow::Error::new(crate::domain::UserError::BadRequest("invalid inbox cursor".into())))?
            }
        };
        let rows = client.query("SELECT id, uid, sender, kind, state, created_at, body, notice FROM ot.mail
            WHERE recipient_agent_id = $1 AND state IN ('pending','delivering') AND id > $2 ORDER BY id LIMIT $3",
            &[&me.id, &after, &(limit + 1)]).await?;
        let has_more = rows.len() > limit as usize;
        let rows = &rows[..rows.len().min(limit as usize)];
        let items: Vec<Value> = rows.iter().map(|r| json!({"id":r.get::<_,String>(1), "message_id":r.get::<_,String>(1),
            "from":r.get::<_,String>(2), "kind":r.get::<_,String>(3), "state":r.get::<_,String>(4),
            "at":iso(r.get(5)), "preview":gist(&r.get::<_,String>(6),200), "notice":r.get::<_,bool>(7)})).collect();
        let cursor = if has_more { rows.last().map(|r| format!("{}:{}", me.id, r.get::<_,i64>(0))) } else { None };
        return Done::json(&json!({"messages":items, "next_cursor":cursor, "has_more":has_more}));
    }
    let ids: Vec<String> = if action == "chunk" { vec![need_str(args,"message_id")?.to_string()] } else {
        let a = args["message_ids"].as_array().ok_or_else(|| anyhow::anyhow!("fetch needs message_ids"))?;
        if a.is_empty() || a.len() > 20 || a.iter().any(|v| !v.is_string()) { crate::refuse!(BadRequest,"fetch needs 1 to 20 message IDs"); }
        let mut ids = Vec::new();
        for id in a.iter().filter_map(Value::as_str) { if !ids.iter().any(|i| i == id) { ids.push(id.to_string()); } }
        ids
    };
    let rows = client.query("SELECT uid, sender, kind, state, created_at, body, attachments FROM ot.mail WHERE recipient_agent_id = $1 AND uid = ANY($2) LIMIT 20", &[&me.id,&ids]).await?;
    let mut items = Vec::new();
    let mut missing = Vec::new();
    let mut deferred = Vec::new();
    let mut budget = 256 * 1024usize;
    for id in ids {
        let Some(r) = rows.iter().find(|r| r.get::<_,String>(0) == id) else { missing.push(id); continue; };
        let body: String = r.get(5);
        let index = if action == "chunk" { args["chunk_index"].as_u64().ok_or_else(|| anyhow::anyhow!("chunk needs a nonnegative chunk_index"))? as usize } else { 0 };
        let mut item = mail_chunk(&body,index)?;
        let did = format!("inbox:{}:{}:{}", me.id, id, item["body_sha256"].as_str().unwrap());
        if action == "chunk" && args["delivery_id"].as_str() != Some(&did) { crate::refuse!(BadRequest,"delivery_id does not match this message and body"); }
        let bytes = item["content"].as_str().unwrap().len();
        if bytes > budget { deferred.push(id); continue; }
        budget -= bytes;
        item["id"] = json!(id); item["message_id"] = json!(id); item["delivery_id"] = json!(did);
        item["from"] = json!(r.get::<_,String>(1)); item["kind"] = json!(r.get::<_,String>(2));
        let state: String = r.get(3);
        item["state"] = json!(state); item["at"] = json!(iso(r.get(4)));
        item["attachments"] = r.get::<_,Value>(6);
        item["will_redeliver"] = json!(state == "pending" || state == "delivering");
        item["will_redeliver_reason"] = json!("Manual reads leave delivery state unchanged; waiting mail still follows normal automatic delivery.");
        items.push(item);
    }
    if action == "chunk" {
        if items.is_empty() { crate::refuse!(NotFound,"message not found in your mailbox"); }
        return Done::json(&items[0]);
    }
    Done::json(&json!({"messages":items, "not_found":missing, "deferred_ids":deferred}))
}
