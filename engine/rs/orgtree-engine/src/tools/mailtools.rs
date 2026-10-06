//! orgtree_message / orgtree_send_notice / orgtree_status / orgtree_inbox.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{arg_str, me, need_str, Done};
use crate::domain::mail::{self, From, Outgoing};
use crate::engine::Engine;
use crate::feed::Key;
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
    let scratch = scratch_of(engine, &client, caller, me.id).await?;
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
    for a in args["attachments"].as_array().cloned().unwrap_or_default().iter().take(10) {
        let Some(p) = a.as_str() else { continue };
        let path = if std::path::Path::new(p).is_absolute() { PathBuf::from(p) } else { scratch.join(p) };
        let Ok(meta) = std::fs::metadata(&path) else {
            crate::refuse!(BadRequest, "attachment {p} does not exist (paths are relative to your working folder {})", scratch.display());
        };
        if !meta.is_file() {
            crate::refuse!(BadRequest, "attachment {p} is not a file");
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string());
        out.attachments.push(json!({ "name": name, "path": path.to_string_lossy(), "bytes": meta.len() }));
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
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    let rec = json!({ "status": status, "summary": summary, "at": iso(chrono::Utc::now()) });
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
    let superior: Option<String> = match me.parent_id {
        Some(p) => client.query_opt("SELECT name FROM ot.agents WHERE id = $1", &[&p]).await?.map(|r| r.get(0)),
        None => Some("user".into()),
    };
    drop(client);
    if let Some(org) = engine.orgs.by_id(me.org_id) {
        org.invalidate([Key::Agent(me.id), Key::Events]);
    }
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
            if mail::send(engine, me.org_id, out).await.is_ok() {
                told = if sup == "user" {
                    " The user gets it in their inbox.".to_string()
                } else {
                    format!(" {sup} gets it as a notice at its next turn.")
                };
            }
        }
    }
    Done::text(format!("Status recorded: {status}.{told}"))
}

#[logged]
pub async fn inbox(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let action = need_str(args, "action")?;
    let client = engine.db.get().await?;
    let me = me(&client, caller).await?;
    match action {
        "list" => {
            let limit = args["limit"].as_i64().unwrap_or(30).clamp(1, 200);
            let rows = client
                .query(
                    "SELECT uid, sender, kind, state, created_at, body, notice FROM ot.mail
                      WHERE recipient_agent_id = $1 ORDER BY (state IN ('pending','delivering')) DESC, id DESC LIMIT $2",
                    &[&me.id, &limit],
                )
                .await?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let body: String = r.get(5);
                    json!({
                        "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "kind": r.get::<_, String>(2),
                        "state": r.get::<_, String>(3), "at": iso(r.get(4)), "notice": r.get::<_, bool>(6),
                        "preview": gist(&body, 160),
                    })
                })
                .collect();
            Done::json(&json!({ "messages": items }))
        }
        "fetch" => {
            let ids: Vec<String> = args["message_ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(20).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                crate::refuse!(BadRequest, "fetch needs message_ids");
            }
            let rows = client
                .query(
                    "SELECT uid, sender, recipient_name, kind, state, created_at, body, attachments FROM ot.mail
                      WHERE uid = ANY($2) AND (recipient_agent_id = $1 OR sender_agent_id = $1)",
                    &[&me.id, &ids],
                )
                .await?;
            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get::<_, String>(0), "from": r.get::<_, String>(1), "to": r.get::<_, String>(2),
                        "kind": r.get::<_, String>(3), "state": r.get::<_, String>(4), "at": iso(r.get(5)),
                        "body": r.get::<_, String>(6), "attachments": r.get::<_, Value>(7),
                    })
                })
                .collect();
            let found: Vec<&str> = items.iter().filter_map(|i| i["id"].as_str()).collect();
            let missing: Vec<&String> = ids.iter().filter(|i| !found.contains(&i.as_str())).collect();
            Done::json(&json!({ "messages": items, "not_found": missing }))
        }
        other => crate::refuse!(BadRequest, "unknown action {other} (list or fetch)"),
    }
}
