//! Mail: storing a message, deciding who may write to whom, waking the
//! recipient. One short transaction per send; the recipient's actor is told
//! after the commit and claims the mail itself.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::domain::UserError;
use crate::engine::Engine;
use crate::feed::Key;
use crate::refuse;
use crate::util::{gist, uid};

#[derive(Clone, Debug)]
pub enum From {
    User,
    System,
    Agent { id: i64, name: String, generation: i32 },
    Extern(String),
}

impl From {
    pub fn name(&self) -> String {
        match self {
            From::User => "@user".into(),
            From::System => "@system".into(),
            From::Agent { name, .. } => name.clone(),
            From::Extern(a) => a.clone(),
        }
    }
}

pub struct Outgoing {
    pub from: From,
    pub to: String,
    pub body: String,
    pub kind: String,
    pub notice: bool,
    pub urgent: bool,
    pub urgent_reason: Option<String>,
    pub attachments: Vec<Value>,
    pub reply_to: Option<Value>,
    pub client_op: Option<String>,
    pub ev: Option<Value>,
}

impl Outgoing {
    pub fn new(from: From, to: &str, body: &str) -> Self {
        Outgoing {
            from,
            to: to.to_string(),
            body: body.to_string(),
            kind: "message".into(),
            notice: false,
            urgent: false,
            urgent_reason: None,
            attachments: Vec::new(),
            reply_to: None,
            client_op: None,
            ev: None,
        }
    }
}

pub struct Sent {
    pub uid: String,
    pub to: String,
    pub recipient_state: String,
    pub delivery: String,
    pub deferred: bool,
}

/// Store one message and wake its recipient.
pub async fn send(engine: &Arc<Engine>, org_id: i64, out: Outgoing) -> Result<Sent> {
    let org = engine.orgs.by_id(org_id).ok_or_else(|| anyhow::Error::new(UserError::NotFound("organization".into())))?;
    let to = out.to.trim().trim_start_matches('@').to_string();
    if out.body.trim().is_empty() && out.attachments.is_empty() {
        refuse!(BadRequest, "a message needs a body");
    }
    if to.starts_with("org:") || to.starts_with("net:") || out.to.starts_with("@org:") || out.to.starts_with("@net:") {
        return Box::pin(crate::domain::orginbox::send_extern(engine, org_id, &out)).await;
    }
    let client = engine.db.get().await?;
    let mail_uid = uid("m");
    let sender_name = out.from.name();
    let (sender_agent, sender_gen) = match &out.from {
        From::Agent { id, generation, .. } => (Some(*id), Some(*generation)),
        _ => (None, None),
    };
    if to == "user" {
        if let From::Agent { id, name, .. } = &out.from {
            let row = client.query_one("SELECT parent_id FROM ot.agents WHERE id = $1", &[id]).await?;
            let top: bool = row.get::<_, Option<i64>>(0).is_none();
            if !top {
                let aud = client
                    .query_opt(
                        "SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = '@user'
                           AND revoked_at IS NULL AND NOT paused",
                        &[&org_id, name],
                    )
                    .await?;
                if aud.is_none() {
                    refuse!(
                        Forbidden,
                        "only top-level agents and agents holding a user audience may write to the user; send it to your superior"
                    );
                }
            }
        }
        client
            .execute(
                "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_name,
                                      kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state)
                 VALUES ($1, $2, $3, $4, $5, 'user', '@user', $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending')",
                &[
                    &mail_uid, &org_id, &sender_name, &sender_agent, &sender_gen, &out.kind, &out.notice, &out.body,
                    &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent, &out.urgent_reason,
                    &out.client_op,
                ],
            )
            .await?;
        let mut keys = vec![Key::UserMail];
        if let Some(a) = sender_agent {
            keys.push(Key::Mailbox(a));
        }
        org.invalidate(keys);
        org.emit(json!({ "type": "mail", "from": sender_name, "to": "@user" }));
        engine.app.org_changed(org_id);
        return Ok(Sent { uid: mail_uid, to: "user".into(), recipient_state: "live".into(), delivery: "delivered to your inbox".into(), deferred: false });
    }
    // an agent
    let target = client
        .query_opt(
            "SELECT id, state, parent_id, halt IS NOT NULL FROM ot.agents
              WHERE org_id = $1 AND name = $2 AND state <> 'deleted'",
            &[&org_id, &to],
        )
        .await?;
    let Some(target) = target else {
        refuse!(NotFound, "no agent named {to} in this organization; nothing was sent");
    };
    let target_id: i64 = target.get(0);
    let state: String = target.get(1);
    let halted: bool = target.get(3);
    if state == "unrecoverable" {
        refuse!(Conflict, "{to} cannot be reached (its session is lost); nothing was sent");
    }
    if let From::Agent { id, name, .. } = &out.from {
        authorize(&client, org_id, *id, name, target_id, &to).await?;
    }
    client
        .execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state)
             VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending')",
            &[
                &mail_uid, &org_id, &sender_name, &sender_agent, &sender_gen, &target_id, &to, &out.kind, &out.notice,
                &out.body, &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent,
                &out.urgent_reason, &out.client_op,
            ],
        )
        .await?;
    let mut keys = vec![Key::Agent(target_id), Key::Mailbox(target_id)];
    if let Some(a) = sender_agent {
        keys.push(Key::Mailbox(a));
    }
    if matches!(out.from, From::User) {
        keys.push(Key::UserMail);
    }
    org.invalidate(keys);
    org.emit(json!({ "type": "mail", "from": sender_name, "to": to }));
    let (delivery, deferred) = if state != "live" {
        (
            format!("{to} is retired: the message is stored and is delivered if and when {to} is rehired. Nothing schedules a rehire, so send it to a live agent if it matters now."),
            true,
        )
    } else if halted {
        (format!("{to} is halted: the message is queued and nothing will read it until {to} is unhalted."), true)
    } else if out.notice {
        (format!("Stored as a notice: {to} reads it at its next turn, which this notice does not start."), false)
    } else {
        crate::runtime::wake(engine, org_id, target_id);
        (format!("Delivered to {to}'s mailbox; it starts or joins {to}'s turn."), false)
    };
    if !out.notice || state == "live" {
        // a running agent also receives notices at its next tool boundary
        if let Some(h) = engine.agents.get(target_id) {
            h.send(crate::runtime::AgentMsg::Wake);
        }
    }
    Ok(Sent { uid: mail_uid, to, recipient_state: state, delivery, deferred })
}

/// May agent `from` write to agent `to`? Superior, any descendant, peers,
/// and anyone who granted it an audience. Writing to a non-child descendant
/// grants that descendant an audience to reply.
async fn authorize(
    client: &tokio_postgres::Client,
    org_id: i64,
    from_id: i64,
    from_name: &str,
    to_id: i64,
    to_name: &str,
) -> Result<()> {
    if from_id == to_id {
        refuse!(BadRequest, "you cannot write to yourself");
    }
    let rel = client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
                SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
                UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id WHERE up.depth < 1024)
             SELECT
               (SELECT parent_id FROM ot.agents WHERE id = $1) AS from_parent,
               (SELECT parent_id FROM ot.agents WHERE id = $2) AS to_parent,
               EXISTS (SELECT 1 FROM up WHERE id = $1 AND depth > 0) AS from_is_ancestor,
               (SELECT depth FROM up WHERE id = $1) AS depth",
            &[&from_id, &to_id],
        )
        .await?;
    let from_parent: Option<i64> = rel.get(0);
    let to_parent: Option<i64> = rel.get(1);
    let from_is_ancestor: bool = rel.get(2);
    let depth: Option<i32> = rel.get(3);
    if from_is_ancestor {
        if depth.unwrap_or(1) > 1 {
            client
                .execute(
                    "INSERT INTO ot.audiences (org_id, grantee, grantor, reason)
                     SELECT $1, $2, $3, 'reply to a message from a distant superior'
                      WHERE NOT EXISTS (SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL)",
                    &[&org_id, &to_name, &from_name],
                )
                .await?;
        }
        return Ok(());
    }
    if from_parent == Some(to_id) || (from_parent == to_parent) {
        return Ok(());
    }
    let aud = client
        .query_opt(
            "SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL AND NOT paused",
            &[&org_id, &from_name, &to_name],
        )
        .await?;
    if aud.is_some() {
        return Ok(());
    }
    refuse!(
        Forbidden,
        "you may write to your superior, your reports and their reports, your peers, and agents that granted you an audience; {to_name} is none of these (ask for an audience with orgtree_audience)"
    )
}

/// A wake-up from the engine itself (crash recovery, watchdogs, freezes ending).
pub async fn system_wake(engine: &Arc<Engine>, org_id: i64, agent_id: i64, text: &str) -> Result<()> {
    let client = engine.db.get().await?;
    let name: String = client.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&agent_id]).await?.get(0);
    drop(client);
    let mut out = Outgoing::new(From::System, &name, text);
    out.kind = "system".into();
    send(engine, org_id, out).await?;
    Ok(())
}

/// The one-line summary a mail spark or notification carries.
pub fn summary(body: &str) -> String {
    gist(body, 160)
}
