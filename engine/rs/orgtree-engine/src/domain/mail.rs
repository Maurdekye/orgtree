//! Mail: storing a message, deciding who may write to whom, waking the
//! recipient. One short transaction per send; the recipient's actor is told
//! after the commit and claims the mail itself.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use crate::domain::UserError;
use crate::engine::Engine;
use crate::changes::{self, Change};
use crate::refuse;
use crate::util::{gist, uid};

/// Agent unread means queued or claimed but not yet acknowledged by the CLI.
/// Human inbox read state is deliberately separate.
pub const UNREAD_STATES: &str = "('pending','delivering')";

/// A positive provider/hook acknowledgement settles only this exact delivery.
#[logged]
pub async fn acknowledge(client: &tokio_postgres::Client, agent: i64, turn: i64, ids: &[i64]) -> Result<u64> {
    Ok(client.execute(
        "UPDATE ot.mail SET state = 'delivered', delivered_at = coalesce(delivered_at, now())
          WHERE recipient_agent_id = $1 AND turn_id = $2 AND id = ANY($3) AND state = 'delivering'",
        &[&agent, &turn, &ids],
    ).await?)
}

/// Startup-only repair of old unsettled deliveries. A turn timestamp alone
/// cannot prove a later hook handoff was consumed: require this message in a
/// durable conversation receipt from that turn. Unproven rows go back to mail.
#[logged]
pub async fn recover_deliveries(client: &tokio_postgres::Client) -> Result<()> {
    loop {
        let ids: Vec<i64> = client.query(
            "SELECT id FROM ot.mail WHERE state = 'delivering' ORDER BY id LIMIT 256", &[],
        ).await?.into_iter().map(|r| r.get(0)).collect();
        if ids.is_empty() { return Ok(()) }
        client.execute(
            "UPDATE ot.mail m SET state = 'delivered', delivered_at = coalesce(m.delivered_at, now())
              FROM ot.turns t WHERE m.id = ANY($1) AND m.turn_id = t.id AND m.state = 'delivering'
                AND t.agent_id = m.recipient_agent_id AND t.sent_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM ot.convo c WHERE c.agent_id = m.recipient_agent_id
                  AND c.at >= t.started_at AND c.body->>'role' = 'user'
                  AND jsonb_typeof(c.body->'mail_ids') = 'array'
                  AND (c.body->'mail_ids') ? m.uid)", &[&ids],
        ).await?;
        client.execute(
            "UPDATE ot.mail SET state = 'pending', turn_id = NULL
              WHERE id = ANY($1) AND state = 'delivering'", &[&ids],
        ).await?;
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub enum From {
    User,
    System,
    Agent { id: i64, name: String, generation: i32 },
    Extern(String),
    /// a watchdog mailing its owner (the mail is from the dog's name)
    Watchdog { uid: String, name: String },
}

#[logged]
impl From {
    pub fn name(&self) -> String {
        match self {
            From::User => "@user".into(),
            From::System => "@system".into(),
            From::Agent { name, .. } => name.clone(),
            From::Extern(a) => a.clone(),
            From::Watchdog { name, .. } => name.clone(),
        }
    }

    /// Where a mail spark starts on the canvas.
    pub fn spark(&self) -> String {
        match self {
            From::Watchdog { uid, .. } => format!("dog:{uid}"),
            From::Extern(_) => "org_inbox".into(),
            other => other.name(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
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
    /// Automatic notices use existing rights without granting a reply audience.
    pub grant_reply_audience: bool,
}

#[logged]
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
            grant_reply_audience: true,
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Sent {
    pub uid: String,
    pub to: String,
    pub recipient_state: String,
    pub delivery: String,
    pub deferred: bool,
}

/// Store one message and wake its recipient.
#[logged]
pub async fn send(engine: &Arc<Engine>, org_id: i64, mut out: Outgoing) -> Result<Sent> {
    let org = engine.orgs.by_id(org_id).ok_or_else(|| anyhow::Error::new(UserError::NotFound("organization".into())))?;
    let explicit_event = out.ev.is_some();
    if !explicit_event {
        out.ev = Some(crate::events::ordinary(&out.from.name(), &out.kind, out.notice, &out.body));
    }
    let to = out.to.trim().trim_start_matches('@').to_string();
    if out.body.trim().is_empty() && out.attachments.is_empty() {
        refuse!(BadRequest, "a message needs a body");
    }
    if to.starts_with("org:") || to.starts_with("net:") || out.to.starts_with("@org:") || out.to.starts_with("@net:") {
        return Box::pin(crate::domain::orginbox::send_extern(engine, org_id, &out)).await;
    }
    let client = engine.db.get().await?;
    if !explicit_event {
        if let Some(reply) = &out.reply_to {
            if let Some(ev) = reply_event(&client, org_id, &org.slug, &out.from.name(), &out.body, reply).await? {
                out.ev = Some(ev);
            }
        }
    }
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
        let mut ch = vec![Change::UserMail, Change::Spark { from: sender_name.clone(), to: "@user".into() }];
        if let Some(a) = sender_agent {
            ch.push(Change::Mailbox(a));
        }
        changes::notify(engine, &org, ch);
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
        authorize(&**client, org_id, *id, name, target_id, &to, out.grant_reply_audience).await?;
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
    let mut ch = vec![Change::Mailbox(target_id), Change::Spark { from: out.from.spark(), to: to.clone() }];
    if let Some(a) = sender_agent {
        ch.push(Change::Mailbox(a));
    }
    if matches!(out.from, From::User) {
        ch.push(Change::UserMail);
        let variant=out.ev.as_ref().and_then(|e|e["variant"].as_str()).unwrap_or("");
        if variant.starts_with("ordinary.") || variant.starts_with("reply.") {
            if let Err(e)=super::runtime_notices::deep_reach(engine,org_id,target_id,&out.body,false).await {
                tracing::warn!(agent=target_id,error=%format!("{e:#}"),"direct-contact notice could not be sent");
            }
        }
    }
    changes::notify(engine, &org, ch);
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

/// Linked replies use stored identity/metadata, never body-prefix recognition.
#[logged]
async fn reply_event(client: &tokio_postgres::Client, org_id: i64, org: &str, who: &str, body: &str, reply: &Value) -> Result<Option<Value>> {
    let id = reply["id"].as_str().unwrap_or("");
    match reply["kind"].as_str().unwrap_or("") {
        "document" => {
            let r = client.query_opt("SELECT node_name, title FROM ot.documents WHERE org_id=$1 AND uid=$2", &[&org_id, &id]).await?;
            Ok(r.map(|r| crate::events::typed("reply.document", who,
                json!({ "kind":"document", "org":org, "id":id, "node":r.get::<_, String>(0), "title":r.get::<_, String>(1) }),
                json!({ "body":body }))))
        }
        "mail" => {
            let r = client.query_opt("SELECT sender, created_at, body, recipient_kind, recipient_name FROM ot.mail WHERE org_id=$1 AND uid=$2", &[&org_id,&id]).await?;
            Ok(r.map(|r| {
                let sender: String = r.get(0);
                let at = crate::util::iso(r.get(1));
                let kind: String = r.get(3);
                let target: String = r.get(4);
                crate::events::typed("reply.mail", who,
                    json!({ "kind":"mail", "org":org, "id":id, "sender":sender, "at":at,
                            "box":if kind == "agent" { "node" } else { "user" }, "node":if kind == "agent" { Some(target) } else { None } }),
                    json!({ "body":body, "quote":{ "from":sender, "at":at, "gist":gist(&r.get::<_,String>(2),600) } }))
            }))
        }
        _ => Ok(None),
    }
}

/// May agent `from` write to agent `to`? Superior, any descendant, peers,
/// and anyone who granted it an audience. Writing to a non-child descendant
/// grants that descendant an audience to reply.
#[logged]
pub(crate) async fn authorize(
    client: &impl tokio_postgres::GenericClient,
    org_id: i64,
    from_id: i64,
    from_name: &str,
    to_id: i64,
    to_name: &str,
    grant_reply_audience: bool,
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
        if grant_reply_audience && depth.unwrap_or(1) > 1 {
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
#[logged]
pub async fn system_wake(engine: &Arc<Engine>, org_id: i64, agent_id: i64, text: &str) -> Result<()> {
    system_event(engine, org_id, agent_id, text, false, None).await
}

/// A typed engine message; passive notices never independently admit a turn.
#[logged]
pub async fn system_event(engine: &Arc<Engine>, org_id: i64, agent_id: i64, text: &str, notice: bool, ev: Option<Value>) -> Result<()> {
    let client = engine.db.get().await?;
    let name: String = client.query_one("SELECT name FROM ot.agents WHERE id = $1", &[&agent_id]).await?.get(0);
    drop(client);
    let mut out = Outgoing::new(From::System, &name, text);
    out.kind = "system".into();
    out.notice = notice;
    out.ev = ev;
    send(engine, org_id, out).await?;
    Ok(())
}

/// The one-line summary a mail spark or notification carries.
#[logged]
pub fn summary(body: &str) -> String {
    gist(body, 160)
}

/// First-task messages have their own handoff card, including the actual seat.
#[logged]
pub async fn kickoff_event(engine: &Engine, org_id: i64, org: &str, node: &str, by: &str, reason: &str, body: &str) -> Result<Value> {
    let client=engine.db.get().await?;
    let row=client.query_one("SELECT generation,tier,grant_credits::float8 FROM ot.agents WHERE org_id=$1 AND name=$2", &[&org_id,&node]).await?;
    Ok(crate::events::typed("lifecycle.kickoff",by,crate::events::node_ref(org,node,row.get::<_,i32>(0) as i64),
        json!({"body":body,"hired_by":by,"reason":reason,"tier":row.get::<_,String>(1),"grant":row.get::<_,f64>(2)})))
}
