//! The Sent interface (S3 E1.1; CONTRACT-M1 §8). **This is the M1 STUB.**
//! WS5 replaces the body behind the same signatures. It supports only
//! [`GrantEffect::None`] and [`GrantEffect::ReplyGrant`]; every trace event it
//! emits carries `stub: true`, and no schedule may be reported as passing
//! against it.
//!
//! It writes only SOURCE rows: `mail_sent`, one `outgoing_intents` row, and
//! the reply grant with its authority-epoch bump. Never a receiver row
//! (v6 I07), and never a lock on the destination's mailbox head.

use uuid::Uuid;

use crate::exec::{CmdError, Refusal};
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailSource {
    Agent { principal: Uuid },
    /// One principal per organization; paired (E1.2 "Sources").
    User,
    /// Exempt from the pair sequence.
    System,
}

impl MailSource {
    fn kind(&self) -> &'static str {
        match self {
            MailSource::Agent { .. } => "agent",
            MailSource::User => "user",
            MailSource::System => "system",
        }
    }
    fn id(&self) -> Uuid {
        match self {
            MailSource::Agent { principal } => *principal,
            MailSource::User | MailSource::System => Uuid::nil(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    /// A captured identity: principal + mailbox + incarnation, never a name.
    Resolved { principal: Uuid, mailbox: Uuid, mailbox_incarnation: i64 },
    UserMailbox { mailbox: Uuid },
    External { handle: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GrantEffect {
    None,
    /// §7.3 reply grant (grantee may now address target). The caller must
    /// have called [`lock_grantee_for_grant`] at C4 step 3.
    ReplyGrant { grantee: Uuid, target: Uuid },
    FirstContactUser { node: Uuid },
    Extern,
}

#[derive(Clone, Debug)]
pub struct SendRequest {
    pub source: MailSource,
    pub dest: Destination,
    /// Stable across retries: part of the operation's identity.
    pub original_message_id: Uuid,
    pub kind: String,
    pub body: String,
    pub urgent: bool,
    pub fingerprint: String,
    pub grant: GrantEffect,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentRecord {
    pub message_id: Uuid,
    pub pair_seq: Option<i64>,
    pub outgoing_intent: Uuid,
    pub grant_inserted: bool,
}

pub const PAIR_SEQ_SQL: &str = "SELECT coalesce(max(pair_seq), 0) + 1 FROM mail_sent \
    WHERE org_id = $1 AND source_kind = $2 AND source_id = $3 AND dest_mailbox_id = $4 AND pair_seq IS NOT NULL";

pub const INSERT_SENT_SQL: &str = "INSERT INTO mail_sent \
    (org_id, message_id, source_kind, source_id, dest_kind, dest_mailbox_id, dest_principal_id, \
     dest_mailbox_incarnation, dest_external, pair_seq, kind, urgent, body, fingerprint, sent_at) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, to_timestamp($15::double precision / 1000000))";

pub const INSERT_INTENT_SQL: &str = "INSERT INTO outgoing_intents \
    (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'mail.deliver', $3, $4, to_timestamp($5::double precision / 1000000), to_timestamp($5::double precision / 1000000))";

pub const LOCK_GRANTEE_SQL: &str = "SELECT lifecycle FROM authority_epoch \
    WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";

pub const INSERT_GRANT_SQL: &str = "INSERT INTO audience_grants \
    (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) \
    VALUES ($1, $2, 'agent', $3, NULL, to_timestamp($4::double precision / 1000000)) \
    ON CONFLICT ON CONSTRAINT audience_grants_key DO NOTHING RETURNING grantee_id";

pub const BUMP_AUDIENCE_SQL: &str = "UPDATE authority_epoch \
    SET audience_version = audience_version + 1, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";

/// Lock-order helper for grant-bearing sends (E1.1 step 5, N4): the grantee's
/// authority-epoch row `FOR NO KEY UPDATE` at C4 step 3, before any lock the
/// caller takes after it.
pub async fn lock_grantee_for_grant<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, grantee: Uuid) -> Result<(), CmdError> {
    tx.set_stub(true);
    let r = tx.exec("sent.lock_grantee", LOCK_GRANTEE_SQL, &[Val::Uuid(org), Val::Uuid(grantee)]).await;
    tx.set_stub(false);
    r.map(|_| ()).map_err(CmdError::Db)
}

/// Why a send did not produce a Sent row. `Db` must be propagated (the
/// executor classifies it for retry); `Refused` rolls the caller back.
#[derive(Debug)]
pub enum SendError {
    Refused(Refusal),
    Db(DbError),
}

impl From<DbError> for SendError {
    fn from(e: DbError) -> SendError {
        SendError::Db(e)
    }
}

impl From<SendError> for CmdError {
    fn from(e: SendError) -> CmdError {
        match e {
            SendError::Db(e) => CmdError::Db(e),
            SendError::Refused(r) => CmdError::Defect(format!("send refused inside a command that did not handle it: {}", r.code)),
        }
    }
}

/// Called INSIDE the caller's command transaction. The organization is the
/// transaction's own (`tx.op().org`).
pub async fn record_sent<S: Session>(tx: &mut Tx<'_, S>, req: &SendRequest) -> Result<SentRecord, SendError> {
    tx.set_stub(true);
    let org = tx.op().org;
    let r = record_sent_inner(tx, org, req).await;
    tx.set_stub(false);
    r
}

async fn record_sent_inner<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, req: &SendRequest) -> Result<SentRecord, SendError> {
    match req.grant {
        GrantEffect::None | GrantEffect::ReplyGrant { .. } => {}
        _ => return Err(SendError::Refused(Refusal::new("unimplemented", "the M1 Sent stub supports only no grant and the reply grant"))),
    }
    let now = tx.now().await?;
    let (dest_kind, dest_mailbox, dest_principal, dest_incarnation, dest_external) = match &req.dest {
        Destination::Resolved { principal, mailbox, mailbox_incarnation } => ("mailbox", Some(*mailbox), Some(*principal), Some(*mailbox_incarnation), None),
        Destination::UserMailbox { mailbox } => ("mailbox", Some(*mailbox), None, None, None),
        Destination::External { handle } => ("external", None, None, None, Some(handle.clone())),
    };
    let paired = !matches!(req.source, MailSource::System) && dest_mailbox.is_some();
    let pair_seq = if paired {
        let rows = tx
            .exec("sent.pair_seq", PAIR_SEQ_SQL, &[Val::Uuid(org), Val::text(req.source.kind()), Val::Uuid(req.source.id()), Val::opt_uuid(dest_mailbox)])
            .await?;
        let n = rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(|| DbError::Sql {
            code: "XX000".into(),
            constraint: None,
            message: "pair_seq query returned no value".into(),
        })?;
        Some(n)
    } else {
        None
    };
    tx.exec(
        "sent.insert",
        INSERT_SENT_SQL,
        &[
            Val::Uuid(org),
            Val::Uuid(req.original_message_id),
            Val::text(req.source.kind()),
            Val::Uuid(req.source.id()),
            Val::text(dest_kind),
            Val::opt_uuid(dest_mailbox),
            Val::opt_uuid(dest_principal),
            Val::opt_int(dest_incarnation),
            dest_external.map(Val::Text).unwrap_or(Val::Null),
            Val::opt_int(pair_seq),
            Val::text(req.kind.clone()),
            Val::Bool(req.urgent),
            Val::text(req.body.clone()),
            Val::text(req.fingerprint.clone()),
            Val::Int(now),
        ],
    )
    .await?;
    let intent = Uuid::new_v4();
    tx.exec(
        "sent.intent",
        INSERT_INTENT_SQL,
        &[Val::Uuid(org), Val::Uuid(intent), Val::Uuid(req.original_message_id), Val::opt_uuid(dest_mailbox), Val::Int(now)],
    )
    .await?;
    let mut grant_inserted = false;
    if let GrantEffect::ReplyGrant { grantee, target } = req.grant {
        let rows = tx.exec("sent.grant", INSERT_GRANT_SQL, &[Val::Uuid(org), Val::Uuid(grantee), Val::Uuid(target), Val::Int(now)]).await?;
        grant_inserted = !rows.is_empty();
        if grant_inserted {
            // r7 C2a P1: every audience insert bumps the grantee's epoch row.
            tx.exec("sent.bump_audience", BUMP_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(grantee)]).await?;
        }
    }
    Ok(SentRecord { message_id: req.original_message_id, pair_seq, outgoing_intent: intent, grant_inserted })
}
