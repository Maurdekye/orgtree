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
pub async fn acknowledge(engine: &Engine, client: &tokio_postgres::Client, agent: i64, turn: i64, ids: &[i64]) -> Result<Vec<(String,String)>> {
    let rows = client.query(
        "UPDATE ot.mail SET state = 'delivered', delivered_at = coalesce(delivered_at, now())
          WHERE recipient_agent_id = $1 AND turn_id = $2 AND id = ANY($3) AND state = 'delivering'
          RETURNING uid,kind,org_id,net_id,net_hub",
        &[&agent, &turn, &ids],
    ).await?;
    Ok(consumed(engine, &rows))
}

/// A successful turn completion settles all remaining claimed mail.
#[logged]
pub async fn acknowledge_turn(engine: &Engine, client: &tokio_postgres::Client, turn: i64) -> Result<Vec<(String,String)>> {
    let rows = client.query(
        "UPDATE ot.mail SET state = 'delivered', delivered_at = coalesce(delivered_at, now())
          WHERE turn_id = $1 AND state = 'delivering' RETURNING uid,kind,org_id,net_id,net_hub", &[&turn],
    ).await?;
    Ok(consumed(engine, &rows))
}

/// Only rows returned by a committed positive delivery transition get receipts.
#[logged]
fn consumed(engine: &Engine, rows: &[tokio_postgres::Row]) -> Vec<(String,String)> {
    for row in rows {
        if let (Some(mid), Some(hub)) = (row.get::<_, Option<String>>(3), row.get::<_, Option<String>>(4)) {
            crate::net::note_read(engine, row.get(2), &[(mid, hub)]);
        }
    }
    rows.iter().map(|r| (r.get(0), r.get(1))).collect()
}

/// Startup-only repair of old unsettled deliveries. A turn timestamp alone
/// cannot prove a later hook handoff was consumed: require this message in a
/// durable conversation receipt from that turn. Unproven rows go back to mail.
#[logged]
pub async fn recover_deliveries(engine: &Engine, client: &tokio_postgres::Client) -> Result<()> {
    loop {
        let ids: Vec<i64> = client.query(
            "SELECT id FROM ot.mail WHERE state = 'delivering' ORDER BY id LIMIT 256", &[],
        ).await?.into_iter().map(|r| r.get(0)).collect();
        if ids.is_empty() { return Ok(()) }
        settle_claimed(engine, client, &ids).await?;
    }
}

/// The same repair for the turns of one agent that were cut while the
/// engine ran on (a retire mid-turn, a turn on record that no running turn
/// owns; decision 62): the mail they claimed is settled as a restart would.
#[logged]
pub async fn recover_turns(engine: &Engine, client: &tokio_postgres::Client, turns: &[i64]) -> Result<()> {
    if turns.is_empty() { return Ok(()) }
    loop {
        let ids: Vec<i64> = client.query(
            "SELECT id FROM ot.mail WHERE turn_id = ANY($1) AND state = 'delivering' ORDER BY id LIMIT 256", &[&turns],
        ).await?.into_iter().map(|r| r.get(0)).collect();
        if ids.is_empty() { return Ok(()) }
        settle_claimed(engine, client, &ids).await?;
    }
}

/// Claimed mail a durable conversation receipt proves consumed is delivered;
/// the rest goes back to the mailbox.
#[logged]
async fn settle_claimed(engine: &Engine, client: &tokio_postgres::Client, ids: &[i64]) -> Result<()> {
    let proven = client.query(
        "UPDATE ot.mail m SET state = 'delivered', delivered_at = coalesce(m.delivered_at, now())
          FROM ot.turns t WHERE m.id = ANY($1) AND m.turn_id = t.id AND m.state = 'delivering'
            AND t.agent_id = m.recipient_agent_id AND t.sent_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM ot.convo c WHERE c.agent_id = m.recipient_agent_id
              AND c.at >= t.started_at AND c.body->>'role' = 'user'
              AND jsonb_typeof(c.body->'mail_ids') = 'array'
              AND (c.body->'mail_ids') ? m.uid)
          RETURNING m.uid,m.kind,m.org_id,m.net_id,m.net_hub", &[&ids],
    ).await?;
    consumed(engine, &proven);
    client.execute(
        "UPDATE ot.mail SET state = 'pending', turn_id = NULL
          WHERE id = ANY($1) AND state = 'delivering'", &[&ids],
    ).await?;
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
pub enum From {
    User,
    System,
    Agent { id: i64, name: String, generation: i32 },
    Extern(String),
    /// a watchdog mailing its owner (the mail is from the dog's name); `key`
    /// is the desktop's handle for the dog, where the mail's spark starts
    Watchdog { key: String, name: String },
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
            From::Watchdog { key, .. } => format!("dog:{key}"),
            From::Extern(_) => "org_inbox".into(),
            other => other.name(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Outgoing {
    pub tags: Vec<String>,
    pub from: From,
    pub to: String,
    pub body: String,
    pub kind: String,
    pub notice: bool,
    pub urgent: bool,
    pub urgent_reason: Option<String>,
    pub attachments: Vec<Value>,
    pub reply_to: Option<Value>,
    pub replies: Vec<Value>,
    pub client_op: Option<String>,
    pub ev: Option<Value>,
    /// Receipt identity supplied only by the inbound hub transport.
    pub net_id: Option<String>,
    pub net_hub: Option<String>,
    /// Automatic notices use existing rights without granting a reply audience.
    pub grant_reply_audience: bool,
    /// false: store the mail and leave the recipient's wake to the caller
    /// (an automatic reminder wakes an idle agent only, `runtime::wake_idle`)
    pub wake: bool,
}

#[logged]
impl Outgoing {
    pub fn new(from: From, to: &str, body: &str) -> Self {
        Outgoing {
            tags: Vec::new(),
            from,
            to: to.to_string(),
            body: body.to_string(),
            kind: "message".into(),
            notice: false,
            urgent: false,
            urgent_reason: None,
            attachments: Vec::new(),
            reply_to: None,
            replies: Vec::new(),
            client_op: None,
            ev: None,
            net_id: None,
            net_hub: None,
            grant_reply_audience: true,
            wake: true,
        }
    }
}

/// How a stored kind is shown (envelope headers, inbox lists): the kinds
/// retired by the user ruling of 2026-10-15 (`decision`, `status`) read as
/// `message`. `request` remains distinct in display and behaves as a message.
/// Stored rows are never rewritten; this is
/// display only, and no behaviour keys on it.
pub fn shown_kind(kind: &str) -> &str {
    match kind {
        "decision" | "status" => "message",
        k => k,
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Sent {
    pub transfer_ids: Vec<String>,
    pub uid: String,
    pub to: String,
    pub recipient_state: String,
    pub delivery: String,
    pub deferred: bool,
}

/// Store one message and wake its recipient.
#[logged]
pub async fn send(engine: &Arc<Engine>, org_id: i64, out: Outgoing) -> Result<Sent> {
    send_with_notices(engine,org_id,out,&mut super::runtime_notices::ForwardedUserNotices::default()).await
}

/// Fan-out callers share one request-local batch. Recipient authority and
/// delivery transactions remain independent; no global or historical dedup.
#[logged]
pub(crate) async fn send_with_notices(engine: &Arc<Engine>, org_id: i64, mut out: Outgoing,
    notices: &mut super::runtime_notices::ForwardedUserNotices) -> Result<Sent> {
    out.tags=super::mail_tags::normalize(Some(&json!(out.tags)))?;
    super::mail_tags::recipient(&out.to,&out.tags)?;
    if matches!(out.from, From::Extern(_)) {
        crate::refuse!(Forbidden, "outside mail must publish through the org inbox");
    }
    let org = engine.orgs.by_id(org_id).ok_or_else(|| anyhow::Error::new(UserError::NotFound("organization".into())))?;
    if out.body.contains('\0') { out.body.retain(|c| c != '\0'); }
    if let Some(text) = &mut out.urgent_reason { if text.contains('\0') { text.retain(|c| c != '\0'); } }
    for v in &mut out.attachments { crate::util::pg_json_mut(v); }
    for v in &mut out.replies { crate::util::pg_json_mut(v); }
    if !out.replies.is_empty() {
        if out.replies.len() > super::replies::MAX_REPLIES || out.replies.iter().any(|q| !q.is_object()) { refuse!(BadRequest, "a reply needs at most 50 qualified targets"); }
        super::replies::dedupe(&mut out.replies);
        out.reply_to = out.replies.first().cloned();
    }
    for v in [&mut out.reply_to, &mut out.ev].into_iter().flatten() { crate::util::pg_json_mut(v); }
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
    let mut client = engine.db.get().await?;
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
            // a project is transparent for reporting: an agent with no AGENT
            // above it (one under a top-level project too) is top-level
            let row = client.query_one("SELECT ot.superior_of($1)", &[id]).await?;
            let top: bool = row.get::<_, Option<i64>>(0).is_none();
            if !top {
                let aud = client
                    .query_opt(
                        "SELECT 1 FROM ot.effective_audiences WHERE org_id = $1 AND grantee = $2 AND grantor = '@user'
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
        let tx=client.transaction().await?;
        let inserted=tx
            .query_one(
                "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_name,
                                      kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state, replies)
                 VALUES ($1, $2, $3, $4, $5, 'user', '@user', $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', $15) RETURNING id",
                &[
                    &mail_uid, &org_id, &sender_name, &sender_agent, &sender_gen, &out.kind, &out.notice, &out.body,
                    &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent, &out.urgent_reason,
                    &out.client_op, &Value::Array(out.replies.clone()),
                ],
            )
            .await?;
        super::mail_tags::attach(&tx,org_id,inserted.get(0),&out.tags).await?;
        tx.commit().await?;
        let mut ch = vec![Change::UserMail, Change::Spark { from: sender_name.clone(), to: "@user".into() }];
        if let Some(a) = sender_agent {
            ch.push(Change::Mailbox(a));
        }
        changes::notify(engine, &org, ch);
        return Ok(Sent { transfer_ids: Vec::new(), uid: mail_uid, to: "user".into(), recipient_state: "live".into(), delivery: "delivered to your inbox".into(), deferred: false });
    }
    // an agent
    let target = client
        .query_opt(
            "SELECT id, state, parent_id, halt IS NOT NULL, kind FROM ot.agents
              WHERE org_id = $1 AND name = $2 AND state <> 'deleted'",
            &[&org_id, &to],
        )
        .await?;
    let Some(target) = target else {
        if let Some(address) = bare_external(engine, out.to.trim())? {
            drop(client);
            out.to = address;
            return Box::pin(crate::domain::orginbox::send_extern(engine, org_id, &out)).await;
        }
        refuse!(NotFound, "no agent named {to} in this organization; nothing was sent");
    };
    let target_id: i64 = target.get(0);
    let state: String = target.get(1);
    let halted: bool = target.get(3);
    if target.get::<_, String>(4) == crate::domain::projects::KIND {
        let project = crate::domain::projects::Project { id: target_id, name: to.clone(), state };
        // heap-owned, as send_extern: every caller of `send` keeps its future small
        return Box::pin(send_project(engine, &org, client, out, project, mail_uid, notices)).await;
    }
    if state == "unrecoverable" {
        refuse!(Conflict, "{to} cannot be reached (its session is lost); nothing was sent");
    }
    if let From::Agent { id, name, .. } = &out.from {
        authorize(&**client, org_id, *id, name, target_id, &to, out.grant_reply_audience).await?;
    }
    let tx = client.transaction().await?;
    let (contact_changes,forwarded) = if direct_user_contact(&out.from, out.ev.as_ref()) {
        super::runtime_notices::deep_reach_batch_tx(&*tx,org_id,target_id,&out.body,false,notices).await?
    } else { (Vec::new(),Vec::new()) };
    tx
        .execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state, net_id, net_hub, replies)
             VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17, $18, $19)",
            &[
                &mail_uid, &org_id, &sender_name, &sender_agent, &sender_gen, &target_id, &to, &out.kind, &out.notice,
                &out.body, &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent,
                &out.urgent_reason, &out.client_op, &out.net_id, &out.net_hub, &Value::Array(out.replies.clone()),
            ],
        )
        .await?;
    tx.commit().await?;
    notices.committed(forwarded);
    drop(client);
    let mut ch = vec![Change::Mailbox(target_id), Change::Spark { from: out.from.spark(), to: to.clone() }];
    if !matches!(out.from,From::Watchdog{..}) {ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event("mail.waiting",crate::runtime::watchdogs::events::Scope::Agent(org_id,target_id),json!({"agent_id":target_id,"mail_id":mail_uid}))));}
    if let Some(a) = sender_agent {
        ch.push(Change::Mailbox(a));
    }
    if matches!(out.from, From::User) {
        ch.push(Change::UserMail);

    }
    ch.extend(contact_changes);
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
        if out.wake {
            crate::runtime::wake(engine, org_id, target_id);
        }
        (format!("Delivered to {to}'s mailbox; it starts or joins {to}'s turn."), false)
    };
    if out.wake && (!out.notice || state == "live") {
        // a running agent also receives notices at its next tool boundary
        if let Some(h) = engine.agents.get(target_id) {
            h.send(crate::runtime::AgentMsg::Wake);
        }
    }
    Ok(Sent { transfer_ids: Vec::new(), uid: mail_uid, to, recipient_state: state, delivery, deferred })
}

/// Mail to a project node (docs/rust-engine/PROJECT-NODES.md): it waits in
/// the project's mailbox, wakes nobody, and the fair project mail queue hands
/// it to one watcher (`projects::dispatch`). Agents write to it only when they
/// reach it (above or below it, user 2026-10-16 16:11Z); the user always.
#[logged]
async fn send_project(engine: &Arc<Engine>, org: &crate::orgs::OrgHandle, mut client: deadpool_postgres::Object,
                      out: Outgoing, project: crate::domain::projects::Project, mail_uid: String,
                      notices: &mut super::runtime_notices::ForwardedUserNotices) -> Result<Sent> {
    let (sender_agent, sender_gen) = match &out.from {
        From::Agent { id, generation, name } => {
            if !crate::domain::projects::reaches(&**client, *id, project.id).await?
                && !super::audiences::effective_holds(&**client, org.id, name, &project.name).await? {
                refuse!(Forbidden, "you need project reach or an audience with {} to write to its mailbox", project.name);
            }
            (Some(*id), Some(*generation))
        }
        From::User => (None, None),
        _ => refuse!(Forbidden, "project {} takes mail only from the user and the agents above or below it", project.name),
    };
    if project.state != "live" {
        refuse!(Conflict, "project {} is retired: nothing was sent", project.name);
    }
    let tx = client.transaction().await?;
    // ack mode: an agent's reply to mail the project handed it is its ack
    // (user 2026-10-18 08:01Z), kept as a read record and never queued
    let replied = out.reply_to.as_ref().and_then(|q| q["id"].as_str())
        .or_else(|| out.replies.first().and_then(|q| q["id"].as_str())).map(str::to_string);
    let acked = match (sender_agent, &replied) {
        (Some(a), Some(r)) => crate::domain::projects::ack_of(&*tx, project.id, a, r).await?,
        _ => None,
    };
    if let Some((orig_row, orig_uid)) = &acked {
        tx.execute(
            "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                                  recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op,
                                  state, read_at, delivered_at, replies, extra)
             VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'read', now(), now(), $17,
                     jsonb_build_object('ack_of', $18::text))",
            &[
                &mail_uid, &org.id, &out.from.name(), &sender_agent, &sender_gen, &project.id, &project.name, &out.kind, &out.notice,
                &out.body, &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent, &out.urgent_reason,
                &out.client_op, &Value::Array(out.replies.clone()), orig_uid,
            ],
        )
        .await?;
        tx.execute(
            "UPDATE ot.mail SET extra = jsonb_set(jsonb_set(extra, '{claimed,acked_at}', to_jsonb(now())), '{claimed,ack_mail}', to_jsonb($2::text))
              WHERE id = $1",
            &[orig_row, &mail_uid],
        )
        .await?;
        tx.commit().await?;
        drop(client);
        let me = match &out.from { From::Agent { name, .. } => name.clone(), _ => String::new() };
        changes::notify(engine, org, vec![Change::Mailbox(project.id), Change::Mailbox(sender_agent.unwrap_or_default()),
            Change::Spark { from: out.from.spark(), to: project.name.clone() }]);
        let handed = crate::domain::projects::dispatch(engine, org.id, project.id).await?;
        let next = handed.iter().find(|h| h.watcher == me).map(|h| h.copy.clone());
        let delivery = match next {
            Some(c) => format!("Ack recorded for {} in project {}'s mailbox; it handed you the next mail, {c}.", replied.unwrap_or_default(), project.name),
            None => format!("Ack recorded for {} in project {}'s mailbox; no mail is waiting for you now.", replied.unwrap_or_default(), project.name),
        };
        return Ok(Sent { transfer_ids: Vec::new(), uid: mail_uid, to: project.name, recipient_state: "live".into(), delivery, deferred: false });
    }
    let (contact_changes,forwarded) = if direct_user_contact(&out.from, out.ev.as_ref()) {
        super::runtime_notices::deep_reach_batch_tx(&*tx,org.id,project.id,&out.body,false,notices).await?
    } else { (Vec::new(),Vec::new()) };
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id,
                              recipient_name, kind, notice, body, attachments, reply_to, ev, urgent, urgent_reason, client_op, state, replies)
         VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17)",
        &[
            &mail_uid, &org.id, &out.from.name(), &sender_agent, &sender_gen, &project.id, &project.name, &out.kind, &out.notice,
            &out.body, &Value::Array(out.attachments.clone()), &out.reply_to, &out.ev, &out.urgent, &out.urgent_reason,
            &out.client_op, &Value::Array(out.replies.clone()),
        ],
    )
    .await?;
    tx.commit().await?;
    notices.committed(forwarded);
    drop(client);
    let mut ch = vec![
        Change::Mailbox(project.id),
        Change::Spark { from: out.from.spark(), to: project.name.clone() },
        Change::EngineEvent(crate::runtime::watchdogs::events::event("mail.waiting",
            crate::runtime::watchdogs::events::Scope::Agent(org.id, project.id), json!({"agent_id": project.id, "mail_id": mail_uid}))),
    ];
    if let Some(a) = sender_agent {
        ch.push(Change::Mailbox(a));
    }
    if matches!(out.from, From::User) {
        ch.push(Change::UserMail);
    }
    ch.extend(contact_changes);
    changes::notify(engine, org, ch);
    let handed = crate::domain::projects::dispatch(engine, org.id, project.id).await?;
    let delivery = match handed.iter().find(|h| h.mail == mail_uid) {
        Some(h) => format!(
            "Delivered to project {}'s mailbox; its fair queue handed it to {} (fair_queue watchdog {}), who now has it as ordinary mail from you.",
            project.name, h.watcher, h.dog),
        None if matches!(out.from, From::User) => Box::pin(nudge_project(engine, org.id, &project)).await?,
        None => format!(
            "Queued in project {}'s mailbox. No agent watches the project with a fair_queue watchdog right now, so it waits there until one does; agents above or below the project can see it with orgtree_inbox project={}.",
            project.name, project.name),
    };
    Ok(Sent { transfer_ids: Vec::new(), uid: mail_uid, to: project.name, recipient_state: "live".into(), delivery, deferred: false })
}

/// The user wrote to a project and no watcher took it (user 2026-10-18
/// 07:46Z): when nobody watches the project at all, wake one agent directly
/// under it (`projects::nudge_target`) and ask it to arm a fair_queue dog,
/// unless Runtime settings turn that off (07:47Z);
/// with nobody to ask, say that nobody can pick the mail up. Returns the
/// send's delivery note.
#[logged]
async fn nudge_project(engine: &Arc<Engine>, org_id: i64, project: &crate::domain::projects::Project) -> Result<String> {
    let client = engine.db.get().await?;
    if crate::domain::projects::watched(&**client, org_id, project.id).await? {
        return Ok(format!(
            "Queued in project {}'s mailbox; it goes to the next of its fair_queue watchers to become eligible.", project.name));
    }
    if !engine.settings.project_listener_wake() {
        return Ok(format!(
            "Queued in project {p}'s mailbox. No agent watches project {p} with a fair_queue watchdog, so it waits there until one does (waking an agent to arm one is off in Runtime settings).",
            p = project.name));
    }
    let Some((_, name)) = crate::domain::projects::nudge_target(engine, &**client, project.id).await? else {
        return Ok(format!(
            "Queued in project {}'s mailbox, but no live, unhalted agent works directly under it, so nobody can pick it up until one is hired or unhalted.",
            project.name));
    };
    drop(client);
    let body = format!(
        "The user wrote to project {p}'s mailbox, and no agent watches project {p} with a fair_queue watchdog, so nobody will receive it. \
         Arm one now: orgtree_watchdog action=create kind=fair_queue target={p}. Arming it hands you the waiting mail.",
        p = project.name);
    let mut nudge = Outgoing::new(From::System, &name, &body);
    nudge.grant_reply_audience = false;
    Box::pin(send(engine, org_id, nudge)).await?;
    Ok(format!(
        "Queued in project {p}'s mailbox. No agent watches project {p} with a fair_queue watchdog, so {name} was woken and asked to arm one; the mail goes to whoever arms first.",
        p = project.name))
}

/// A bare recipient is resolved only when no internal agent has that name.
#[logged]
fn bare_external(engine: &Engine, to: &str) -> Result<Option<String>> {
    if to.starts_with('@') || to.is_empty() { return Ok(None); }
    crate::net::resolve_bare(to, engine.orgs.get(to).is_some(), &crate::net::remote_peers(engine))
}

/// Attachment staging needs the transport before choosing its file policy.
/// Resolve once to an explicit address, then send through the ordinary gate.
#[logged]
pub async fn attachment_recipient(engine: &Engine, org_id: i64, to: &str) -> Result<String> {
    let to = to.trim();
    if to.starts_with('@') || to == "user" || to.starts_with("org:") || to.starts_with("net:") { return Ok(to.into()); }
    let client = engine.db.get().await?;
    let internal = client.query_opt("SELECT 1 FROM ot.agents WHERE org_id=$1 AND name=$2 AND state <> 'deleted'", &[&org_id, &to]).await?.is_some();
    drop(client);
    if internal { return Ok(to.into()); }
    Ok(bare_external(engine, to)?.unwrap_or_else(|| to.into()))
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
            let r = client.query_opt("SELECT sender, created_at, body, recipient_kind, recipient_name FROM ot.mail WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id=$1 AND uid=$2", &[&org_id,&id]).await?;
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

/// The message an agent answers (`orgtree_message` `reply_to`): mail it
/// received or sent (the id that ends its FROM line; orgtree_inbox lists
/// them), or an outside message it sent from the org inbox (the id
/// orgtree_message reported). The quote is what the recipient sees above the
/// reply; `net_id` is what a reply over the mail hub carries.
#[logged]
pub async fn agent_reply_quote(engine: &Engine, org_id: i64, agent_id: i64, agent: &str, reference: &str) -> Result<Value> {
    let id = reference.trim().trim_start_matches("@mail:").trim();
    if id.is_empty() {
        refuse!(BadRequest, "reply_to needs the id of the message you are answering");
    }
    let client = engine.db.get().await?;
    let r = client
        .query_opt(
            "SELECT uid, sender, created_at, body, recipient_kind, recipient_name, net_id FROM ot.mail
              WHERE ((ot.mail.sender NOT LIKE '@org:%' AND ot.mail.sender NOT LIKE '@net:%' AND COALESCE(ot.mail.ev->>'variant','') <> 'runtime.external_unroutable' AND ot.mail.extra->>'transfer_failure' IS NULL) OR NOT EXISTS (SELECT 1 FROM ot.orgs inbox_org WHERE inbox_org.id=ot.mail.org_id AND inbox_org.settings->'org_inbox_enabled'='false'::jsonb)) AND org_id = $1 AND uid = $2 AND (recipient_agent_id = $3 OR sender_agent_id = $3)",
            &[&org_id, &id, &agent_id],
        )
        .await?;
    if let Some(r) = r {
        let mut q = json!({ "kind": "mail", "id": r.get::<_, String>(0), "from": r.get::<_, String>(1),
                            "at": crate::util::iso(r.get(2)), "gist": gist(&r.get::<_, String>(3), 600) });
        if r.get::<_, String>(4) == "user" {
            q["box"] = json!("user");
        } else {
            q["box"] = json!("node");
            q["node"] = json!(r.get::<_, String>(5));
        }
        if let Some(n) = r.get::<_, Option<String>>(6) {
            q["net_id"] = json!(n);
        }
        return Ok(q);
    }
    if let Some(q) = crate::domain::orginbox::sent_quote(&client, org_id, id, agent).await? {
        return Ok(q);
    }
    refuse!(NotFound, "reply_to: no message {id} among the mail you received or sent (the id ends its FROM line; orgtree_inbox lists them)");
}

/// Mail reach, including the direct parent's optional sibling gate.
#[logged]
pub(crate) async fn authorize(
    client: &impl tokio_postgres::GenericClient, org_id: i64,
    from_id: i64, from_name: &str, to_id: i64, to_name: &str, grant_reply_audience: bool,
) -> Result<()> {
    if from_id == to_id { refuse!(BadRequest, "you cannot write to yourself"); }
    let rel = client.query_one(
        "WITH RECURSIVE up(id,parent_id,depth) AS (
           SELECT id,parent_id,0 FROM ot.agents WHERE id=$2
           UNION ALL SELECT a.id,a.parent_id,up.depth+1 FROM ot.agents a JOIN up ON a.id=up.parent_id WHERE up.depth<1024)
         SELECT ot.superior_of($1),ot.superior_of($2),
           EXISTS(SELECT 1 FROM up WHERE id=$1 AND depth>0), f.parent_id,t.parent_id,p.name,p.scope
         FROM ot.agents f JOIN ot.agents t ON t.id=$2
         LEFT JOIN ot.agents p ON p.id=f.parent_id WHERE f.id=$1", &[&from_id,&to_id]).await?;
    let from_superior: Option<i64> = rel.get(0);
    let to_superior: Option<i64> = rel.get(1);
    let ancestor: bool = rel.get(2);
    if ancestor {
        if grant_reply_audience && to_superior != Some(from_id) {
            client.execute(
                "INSERT INTO ot.audiences(org_id,grantee,grantor,reason)
                 SELECT $1,$2,$3,'reply to a message from a distant superior'
                 WHERE NOT EXISTS(SELECT 1 FROM ot.audiences WHERE org_id=$1 AND grantee=$2 AND grantor=$3 AND revoked_at IS NULL)",
                &[&org_id,&to_name,&from_name]).await?;
        }
        return Ok(());
    }
    let parent_name: Option<String> = rel.get(5);
    let parent_scope: Option<Value> = rel.get(6);
    let relation = super::peer_mail::Relation { from:from_id,to:to_id,from_parent:rel.get(3),to_parent:rel.get(4),
        from_superior,to_superior,ancestor:false,
        enabled:super::peer_mail::enabled(parent_scope.as_ref().unwrap_or(&Value::Null)) };
    let parent_name = parent_name.as_deref().unwrap_or("your parent");
    if super::peer_mail::check(relation,false,parent_name).is_ok() { return Ok(()); }
    let audience = client.query_opt(
        "SELECT 1 FROM ot.effective_audiences WHERE org_id=$1 AND grantee=$2 AND grantor=$3 AND revoked_at IS NULL AND NOT paused",
        &[&org_id,&from_name,&to_name]).await?.is_some();
    super::peer_mail::check(relation,audience,parent_name)
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

// Classification only: do not separately log an event's private body.
#[nolog]
fn direct_user_contact(from: &From, event: Option<&Value>) -> bool {
    let variant = event.and_then(|e| e["variant"].as_str()).unwrap_or("");
    matches!(from, From::User) && (variant.starts_with("ordinary.") || variant.starts_with("reply."))
}

#[cfg(test)]
mod direct_contact_tests {
    use super::*;

    // Admission wiring checks supplement the pure batching-policy tests without a live DB.
    #[test]
    fn project_user_mail_uses_the_same_forwarding_transaction() {
        let source = include_str!("mail.rs");
        let project = source.split("async fn send_project(").nth(1).unwrap()
            .split("async fn nudge_project(").next().unwrap();
        assert!(project.contains("deep_reach_batch_tx"), "project admission must forward the user message atomically");
        assert!(project.contains("notices.committed"), "project forwarding must record only committed ancestors");
    }

    #[test]
    fn user_broadcast_shares_forwarding_state_across_recipients() {
        let source = include_str!("../http/nodes.rs");
        let broadcast = source.split("pub async fn broadcast(").nth(1).unwrap()
            .split("async fn project_audience(").next().unwrap();
        assert!(broadcast.contains("ForwardedUserNotices::default()"), "broadcast needs one forwarding batch");
        assert!(broadcast.contains("send_with_notices"), "broadcast recipients must share committed forwarding state");
    }

    #[test]
    fn user_message_and_reply_are_contacts() {
        for variant in ["ordinary.message", "ordinary.notice", "reply.mail", "reply.document"] {
            assert!(direct_user_contact(&From::User, Some(&json!({"variant":variant}))));
        }
    }

    #[test]
    fn automatic_and_external_senders_cannot_create_user_access() {
        for from in [From::System, From::Extern("@org:elsewhere".into()),
            From::Agent{id:1,name:"sender".into(),generation:1}] {
            assert!(!direct_user_contact(&from, Some(&json!({"variant":"ordinary.message"}))));
        }
    }

    #[test]
    fn user_typed_lifecycle_is_not_direct_contact() {
        assert!(!direct_user_contact(&From::User, Some(&json!({"variant":"lifecycle.hired"}))));
        assert!(!direct_user_contact(&From::User, None));
    }
}
