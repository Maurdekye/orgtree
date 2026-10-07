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
        let network = to.trim().trim_start_matches('@').starts_with("net:");
        if !to_user && !network {
            crate::refuse!(BadRequest, "attachments ride mail to the user or @net: peers; for local recipients use paths");
        }
        let org = engine.orgs.by_id(me.org_id).ok_or_else(|| anyhow::anyhow!("organization not open"))?;
        let presenter = crate::domain::docs::presenter(engine, &org, me.id).await?;
        if to_user && !presenter.may_present { crate::refuse!(Forbidden, "mail to the user needs a user audience"); }
        for a in attachments {
            let Some(path) = a.as_str() else { crate::refuse!(BadRequest, "attachment paths must be strings"); };
            out.attachments.push(crate::domain::docs::snapshot(&presenter, path, network)?);
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
    let superior: Option<String> = match me.parent_id {
        Some(p) => client.query_opt("SELECT name FROM ot.agents WHERE id = $1", &[&p]).await?.map(|r| r.get(0)),
        None => Some("user".into()),
    };
    drop(client);
    changes::notify_id(engine, me.org_id, vec![Change::Agent(me.id), Change::Events, Change::History(me.id)]);
    let mut told = String::new();
    if status == "done" || status == "blocked" {
        if let Some(sup) = superior {
            let mut out = Outgoing::new(
                From::Agent { id: me.id, name: me.name.clone(), generation: me.generation },
                &sup,
                &format!("Status: {status} â€” {summary}"),
            );
            out.kind = "status".into();
            out.notice = true;
            out.ev = Some(crate::events::status_report(&caller.org_slug, &me.name, me.generation as i64, status, &summary));
            if mail::send(engine, me.org_id, out).await.is_ok() {
                told = if sup == "user" {
                    " The user gets it in their inbox.".to_string()
                } else {
                    format!(" {sup} gets it as a notice at its next turn.")
                };
            }
        }
    }
    let shown = if status == "done" { "done (you are idle now)" } else { status };
    Done::text(format!("Status recorded: {shown}.{told}"))
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
