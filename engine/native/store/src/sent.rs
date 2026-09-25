//! The Sent interface (S3 E1.1-E1.2; CONTRACT-M1 §8 r5, WS5, lead ack A1).
//!
//! The SOURCE half of two-stage mail. [`record_sent`] runs INSIDE the
//! caller's command transaction (a mail door, release-notify, a status
//! report, a credit answer, staffing) and writes only source rows:
//! `mail_sent`, one delivery intent (`outgoing_intents` for a mailbox,
//! `transport_intents` for an outside party), and the permission effect the
//! variant permits (reply grant, first-contact user audience, EXTERN
//! auto-grant and single-holder replacement). It never writes a receiver row
//! and never locks a destination's mailbox head (v6 I07; S3 E1.1 step 6).
//! After commit it hints the receiver's queue; the hint is volatile and a
//! lost one is recovered from the pending intent.
//!
//! Callers build requests ONLY through the constructors
//! ([`SendRequest::message`], [`SendRequest::passive`],
//! [`SendRequest::notice`]): the fields are private, so the pair rule and the
//! class cannot be set inconsistently (lead ack A1).
//!
//! The addressing half of the source transaction (S3 E1.1 steps 3-4) is
//! [`resolve_recipient`], [`plan_route`] / [`anchor_route`] and the
//! convenience [`address_agent`] / [`address_user`], which callers run
//! before [`record_sent`] in the canonical lock order (C4).

use uuid::Uuid;

use crate::exec::{CmdError, Refusal};
use crate::hooks::controls;
use crate::mail::hints::{self, Hint};
use crate::session::{DbError, Session};
use crate::value::{Rows, Val};
use crate::Tx;

// ---------------------------------------------------------------- shapes

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailSource {
    Agent { principal: Uuid },
    /// One principal per organization; paired (E1.2 "Sources").
    User,
    /// Exempt from the pair sequence (E-D1): many unrelated commands.
    System,
}

impl MailSource {
    pub fn kind(&self) -> &'static str {
        match self {
            MailSource::Agent { .. } => "agent",
            MailSource::User => "user",
            MailSource::System => "system",
        }
    }
    pub fn id(&self) -> Uuid {
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

impl Destination {
    pub fn mailbox(&self) -> Option<Uuid> {
        match self {
            Destination::Resolved { mailbox, .. } | Destination::UserMailbox { mailbox } => Some(*mailbox),
            Destination::External { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GrantEffect {
    None,
    /// §7.3 reply grant: `grantee` (the recipient) may now address `target`
    /// (the sender). The grant's anchor is the sender (P1 sweep, Q-C7). The
    /// caller must have locked the grantee's authority-epoch row with
    /// [`RecipientLock::Grant`] (or [`lock_grantee_for_grant`]) at C4 step 3.
    ReplyGrant { grantee: Uuid, target: Uuid },
    /// §7.4 first-contact user audience `(node, USER)` of the human send.
    FirstContactUser { node: Uuid },
    /// EXTERN authority for an outside send: the sender holds it, or a
    /// top-level sender is auto-granted it (single-holder mode replaces every
    /// other holder in this transaction).
    Extern,
}

/// CONTRACT-M1 §8 r5 (lead ack A1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailClass {
    /// Ordinary mail: wakes a live recipient.
    Message,
    /// An agent's explicit notice (`orgtree_send_notice`) or an automatic
    /// participation notice under the acting agent: mail, no wake.
    Passive,
    /// A system notice filed into the seat's notice box: no wake, no
    /// lifecycle read at the receiver (E1.3 step 4), foldable (P8 leg c);
    /// arrives already read in the human mailbox (E1.4).
    Notice,
}

impl MailClass {
    pub fn name(self) -> &'static str {
        match self {
            MailClass::Message => "message",
            MailClass::Passive => "passive",
            MailClass::Notice => "notice",
        }
    }
    pub fn parse(s: &str) -> Option<MailClass> {
        match s {
            "message" => Some(MailClass::Message),
            "passive" => Some(MailClass::Passive),
            "notice" => Some(MailClass::Notice),
            _ => None,
        }
    }
}

/// One send. Build it with a constructor; the fields are private so the
/// class and the pair rule stay consistent (lead ack A1 condition 1).
#[derive(Clone, Debug)]
pub struct SendRequest {
    source: MailSource,
    dest: Destination,
    original_message_id: Uuid,
    class: MailClass,
    kind: String,
    body: String,
    urgent_reason: Option<String>,
    fingerprint: String,
    grant: GrantEffect,
    attributed: bool,
}

impl SendRequest {
    fn new(class: MailClass, source: MailSource, dest: Destination, original_message_id: Uuid, kind: String, body: String, fingerprint: String) -> SendRequest {
        SendRequest { source, dest, original_message_id, class, kind, body, urgent_reason: None, fingerprint, grant: GrantEffect::None, attributed: false }
    }
    /// Ordinary mail. `original_message_id` must be stable across retries of
    /// the same operation (it is part of the delivery key).
    pub fn message(source: MailSource, dest: Destination, original_message_id: Uuid, kind: impl Into<String>, body: impl Into<String>, fingerprint: impl Into<String>) -> SendRequest {
        SendRequest::new(MailClass::Message, source, dest, original_message_id, kind.into(), body.into(), fingerprint.into())
    }
    /// Passive mail: an explicit notice, or an automatic participation notice
    /// sent as the acting agent (pair-ordered, grants nothing by default).
    pub fn passive(source: MailSource, dest: Destination, original_message_id: Uuid, kind: impl Into<String>, body: impl Into<String>, fingerprint: impl Into<String>) -> SendRequest {
        SendRequest::new(MailClass::Passive, source, dest, original_message_id, kind.into(), body.into(), fingerprint.into())
    }
    /// A system notice for the seat's notice box. `kind` is the notice's
    /// variant (e.g. `context.deep_reach`); the untyped legacy text notice is
    /// kind `notice`, which the fold never groups.
    pub fn notice(source: MailSource, dest: Destination, original_message_id: Uuid, kind: impl Into<String>, body: impl Into<String>, fingerprint: impl Into<String>) -> SendRequest {
        SendRequest::new(MailClass::Notice, source, dest, original_message_id, kind.into(), body.into(), fingerprint.into())
    }
    pub fn with_grant(mut self, grant: GrantEffect) -> SendRequest {
        self.grant = grant;
        self
    }
    /// D-169: urgent mail to the user, with its non-blank reason.
    pub fn with_urgent(mut self, reason: impl Into<String>) -> SendRequest {
        self.urgent_reason = Some(reason.into());
        self
    }
    /// A held-handle outside send (attributed to its sender, no EXTERN).
    pub fn attributed(mut self) -> SendRequest {
        self.attributed = true;
        self
    }

    pub fn source(&self) -> &MailSource {
        &self.source
    }
    pub fn dest(&self) -> &Destination {
        &self.dest
    }
    pub fn original_message_id(&self) -> Uuid {
        self.original_message_id
    }
    pub fn class(&self) -> MailClass {
        self.class
    }
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn body(&self) -> &str {
        &self.body
    }
    pub fn urgent(&self) -> bool {
        self.urgent_reason.is_some()
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    pub fn grant(&self) -> &GrantEffect {
        &self.grant
    }

    /// The derived pair rule (lead ack A1 condition 2; S3 E1.2, E1.3 step 3):
    /// a pair sequence iff the source is an agent or the user, the class is
    /// message or passive, and the destination is a mailbox.
    pub fn pair_gated(&self) -> bool {
        pair_gated(&self.source, self.class, &self.dest)
    }
}

pub fn pair_gated(source: &MailSource, class: MailClass, dest: &Destination) -> bool {
    matches!(source, MailSource::Agent { .. } | MailSource::User)
        && matches!(class, MailClass::Message | MailClass::Passive)
        && dest.mailbox().is_some()
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct SentRecord {
    pub message_id: Uuid,
    pub pair_seq: Option<i64>,
    /// The delivery intent: an `outgoing_intents` row for a mailbox, a
    /// `transport_intents` row for an outside party.
    pub outgoing_intent: Uuid,
    /// A grant row was inserted by this send (reply, first contact, EXTERN).
    pub grant_inserted: bool,
    /// Previous EXTERN holders replaced by this send (single-holder mode).
    pub extern_revoked: Vec<Uuid>,
}

/// Why a send did not produce a Sent row. `Db` must be propagated (the
/// executor classifies it for retry); `Refused` rolls the caller back
/// (E-D5); `Retry` asks the executor to re-run the attempt (a stale
/// prediction or a changed route, never a fake SQLSTATE).
#[derive(Debug)]
pub enum SendError {
    Refused(Refusal),
    Db(DbError),
    Retry(&'static str),
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
            SendError::Retry(cause) => CmdError::RetryAttempt { cause },
            SendError::Refused(r) => CmdError::Defect(format!("send refused inside a command that did not handle it: {}", r.code)),
        }
    }
}

fn refuse(code: &str, message: impl Into<String>) -> SendError {
    SendError::Refused(Refusal::new(code, message))
}

/// Every unsafe control compiled into the Sent path (static list for the
/// harness handshake). Each fires only when a qualification plan arms it.
pub const CONTROLS: &[&str] = &[
    "Q-AM1.source_writes_head",
    "Q-AM1.share_then_upgrade",
    "Q-R6.receiver_write_in_source",
    "Q-C7.skip_epoch_bump",
    "Q-HM1.no_lock_no_key",
    "Q-AM4.no_holder_lock",
];

// ---------------------------------------------------------------- SQL

pub const PAIR_SEQ_SQL: &str = "SELECT coalesce(max(pair_seq), 0) + 1 FROM mail_sent \
    WHERE org_id = $1 AND source_kind = $2 AND source_id = $3 AND dest_mailbox_id = $4 AND pair_seq IS NOT NULL";

pub const INSERT_SENT_SQL: &str = "INSERT INTO mail_sent \
    (org_id, message_id, source_kind, source_id, dest_kind, dest_mailbox_id, dest_principal_id, \
     dest_mailbox_incarnation, dest_external, pair_seq, kind, urgent, urgent_reason, body, fingerprint, \
     class, attributed, sent_at) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)";

pub const INSERT_INTENT_SQL: &str = "INSERT INTO outgoing_intents \
    (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'mail.deliver', $3, $4, $5, $5)";

pub const INSERT_TRANSPORT_SQL: &str = "INSERT INTO transport_intents \
    (org_id, intent_id, message_id, handle, due_at) VALUES ($1, $2, $3, $4, $5)";

pub const INSERT_RETRACT_SQL: &str = "INSERT INTO outgoing_intents \
    (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'mail.retract', $3, $4, $5, $5) \
    ON CONFLICT ON CONSTRAINT outgoing_intents_unique_effect DO NOTHING RETURNING intent_id";

pub const LOCK_GRANTEE_SQL: &str = "SELECT lifecycle FROM authority_epoch \
    WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";

pub const SHARE_EPOCH_SQL: &str = "SELECT lifecycle FROM authority_epoch \
    WHERE org_id = $1 AND principal_id = $2 FOR SHARE";

pub const RECIPIENT_MAILBOX_SQL: &str = "SELECT mailbox_id, incarnation FROM mailboxes \
    WHERE org_id = $1 AND owner_kind = 'agent' AND owner_id = $2 AND state = 'open' \
    ORDER BY incarnation DESC LIMIT 1";

pub const USER_MAILBOX_SQL: &str = "SELECT mailbox_id FROM mailboxes \
    WHERE org_id = $1 AND owner_kind = 'user' AND state = 'open'";

pub const EDGE_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const EDGE_SHARE_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR SHARE";

pub const GRANT_SQL: &str = "SELECT 1 FROM audience_grants \
    WHERE org_id = $1 AND grantee_id = $2 AND target_kind = $3 AND target_id = $4";
pub const GRANT_SHARE_SQL: &str = "SELECT 1 FROM audience_grants \
    WHERE org_id = $1 AND grantee_id = $2 AND target_kind = $3 AND target_id = $4 FOR SHARE";

pub const INSERT_GRANT_SQL: &str = "INSERT INTO audience_grants \
    (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6) \
    ON CONFLICT ON CONSTRAINT audience_grants_key DO NOTHING RETURNING grantee_id";

/// Q-HM1's unsafe control inserts WITHOUT the conflict clause; the harness
/// runs it against a schema whose `audience_grants_key` is dropped.
pub const INSERT_GRANT_PLAIN_SQL: &str = "INSERT INTO audience_grants \
    (org_id, grantee_id, target_kind, target_id, anchor_id, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING grantee_id";

pub const BUMP_AUDIENCE_SQL: &str = "UPDATE authority_epoch \
    SET audience_version = audience_version + 1, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";

pub const HOLDERS_LOCK_SQL: &str = "SELECT value FROM org_controls WHERE org_id = $1 AND family = 'extern_holders' FOR UPDATE";
pub const HOLDERS_READ_SQL: &str = "SELECT value FROM org_controls WHERE org_id = $1 AND family = 'extern_holders'";
pub const HOLDERS_BUMP_SQL: &str = "UPDATE org_controls SET version = version + 1 WHERE org_id = $1 AND family = 'extern_holders'";
pub const EXTERN_HOLDERS_SQL: &str = "SELECT grantee_id FROM audience_grants \
    WHERE org_id = $1 AND target_kind = 'extern' AND target_id = $2 AND grantee_id <> $3 ORDER BY grantee_id";
pub const DELETE_GRANT_SQL: &str = "DELETE FROM audience_grants \
    WHERE org_id = $1 AND grantee_id = $2 AND target_kind = $3 AND target_id = $4";
pub const LOCK_EPOCH_UPDATE_SQL: &str = "SELECT 1 FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";

pub const RESTRICTION_EPOCH_SHARE_SQL: &str = "SELECT version FROM org_controls \
    WHERE org_id = $1 AND family = 'restriction_epoch' FOR SHARE";
pub const REGISTRATIONS_SQL: &str = "SELECT service_incarnation FROM read_service_registrations WHERE org_id = $1";
pub const INSERT_RESTRICTION_SQL: &str = "INSERT INTO restrictions \
    (org_id, restriction_id, epoch, reason, principals, committed_at) VALUES ($1, $2, $3, $4, ARRAY[$5::uuid], $6)";
pub const INSERT_OBLIGATION_SQL: &str = "INSERT INTO restriction_obligations \
    (org_id, restriction_id, service_incarnation) VALUES ($1, $2, $3)";

pub const KIOSK_SQL: &str = "SELECT coalesce((value->>'sealed')::boolean, false) FROM org_controls \
    WHERE org_id = $1 AND family = 'kiosk' FOR SHARE";

/// Q-AM1 (i): the unsafe control writes the destination's HEAD from the
/// source transaction.
pub const UNSAFE_HEAD_WRITE_SQL: &str = "UPDATE mailboxes SET version = version + 1 WHERE org_id = $1 AND mailbox_id = $2";
/// Q-R6 (2): the unsafe control writes the receiver's inbox row from the
/// source transaction.
pub const UNSAFE_INBOX_WRITE_SQL: &str = "INSERT INTO mailbox_messages \
    (org_id, mailbox_id, original_message_id, fingerprint, state, received_at) \
    VALUES ($1, $2, $3, $4, 'pending', $5) ON CONFLICT DO NOTHING";

const MAX_DEPTH: usize = 64;

fn first_val(rows: &Rows) -> Option<&Val> {
    rows.first().and_then(|r| r.first())
}

fn opt_parent(rows: &Rows) -> Option<Option<Uuid>> {
    rows.first().map(|r| r.first().and_then(Val::as_uuid))
}

// ---------------------------------------------------------------- addressing (E1.1 steps 3-4)

/// How the recipient's authority-epoch row is locked at C4 step 3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipientLock {
    /// `FOR SHARE`: sends that insert no grant never wait on each other.
    Share,
    /// `FOR NO KEY UPDATE` up front: a send that may insert a grant (N4;
    /// M1 lock strength). Never a share lock upgraded later (Q-AM1 (ii)).
    Grant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    Live,
    /// Archived: the send is Sent and deferred; the receiver records no wake.
    Archived,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recipient {
    pub dest: Destination,
    pub lifecycle: Lifecycle,
}

/// Lock-order helper for grant-bearing sends (E1.1 step 5, N4): the
/// grantee's authority-epoch row `FOR NO KEY UPDATE` at C4 step 3, before any
/// lock the caller takes after it.
pub async fn lock_grantee_for_grant<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, grantee: Uuid) -> Result<(), CmdError> {
    tx.exec("sent.lock_grantee", LOCK_GRANTEE_SQL, &[Val::Uuid(org), Val::Uuid(grantee)]).await.map(|_| ()).map_err(CmdError::Db)
}

/// E1.1 step 3: the recipient's authority-epoch row (its lifecycle decides
/// refused / deferred / ordinary, legacy `ledger.py:3529-3581`) and its
/// current mailbox incarnation. The mailbox row is only READ: the source
/// never locks or references a receiver head (F3).
pub async fn resolve_recipient<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid, lock: RecipientLock) -> Result<Recipient, SendError> {
    let sql = match lock {
        RecipientLock::Share => SHARE_EPOCH_SQL,
        RecipientLock::Grant => LOCK_GRANTEE_SQL,
    };
    let rows = tx.exec("sent.recipient_epoch", sql, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    let lifecycle = match first_val(&rows).and_then(Val::as_text) {
        None => return Err(refuse("no_such_agent", "NOT DELIVERED — there is no such agent in this organization. NOTHING WAS QUEUED.")),
        Some("unrecoverable") => return Err(refuse("unrecoverable", "NOT DELIVERED — the recipient is unrecoverable, so it cannot receive mail and NOTHING WAS QUEUED.")),
        Some("archived") => Lifecycle::Archived,
        Some(_) => Lifecycle::Live,
    };
    let rows = tx.exec("sent.recipient_mailbox", RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    let row = rows.first().ok_or_else(|| refuse("no_mailbox", "the recipient has no open mailbox"))?;
    let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| refuse("no_mailbox", "undecodable mailbox row"))?;
    let incarnation = row.get(1).and_then(Val::as_int).unwrap_or(1);
    Ok(Recipient { dest: Destination::Resolved { principal, mailbox, mailbox_incarnation: incarnation }, lifecycle })
}

/// The organization's user mailbox (E1.4). Read only; it has no head lock.
pub async fn user_mailbox<S: Session>(tx: &mut Tx<'_, S>, org: Uuid) -> Result<Destination, SendError> {
    let rows = tx.exec("sent.user_mailbox", USER_MAILBOX_SQL, &[Val::Uuid(org)]).await?;
    let mailbox = first_val(&rows).and_then(Val::as_uuid).ok_or_else(|| refuse("no_user_mailbox", "the organization has no user mailbox"))?;
    Ok(Destination::UserMailbox { mailbox })
}

/// The §7.2 addressing route (legacy `post_mail`, `ledger.py:3582-3602`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    SelfSend,
    /// One hop up.
    Parent,
    Child,
    /// Downward, deeper than a child: an explicit send implies the §7.3 reply
    /// grant.
    DeepDescendant,
    Sibling,
    /// The sender holds an audience grant `(sender, recipient)`.
    HeldAudience,
    /// To the user from a top-level sender.
    UserTopLevel,
    /// To the user from a holder of `(sender, USER)`.
    UserAudience,
}

impl Route {
    pub fn reply_grant_possible(self) -> bool {
        matches!(self, Route::DeepDescendant)
    }
}

/// Who a route plan was made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum To {
    Agent(Uuid),
    User,
}

/// An addressing decision taken from UNLOCKED reads (the prediction), with
/// exactly the rows [`anchor_route`] must lock and re-verify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutePlan {
    pub sender: Uuid,
    pub to: To,
    pub route: Route,
    /// Edge rows to anchor, `(node, parent the plan saw)`, leaf upward.
    pub edges: Vec<(Uuid, Option<Uuid>)>,
    /// The grant row the route relies on, `(grantee, target_kind, target)`.
    pub grant_row: Option<(Uuid, &'static str, Uuid)>,
    /// Whether the reply grant `(recipient, sender)` already existed.
    pub reply_grant_exists: bool,
}

async fn edge<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid) -> Result<Option<Option<Uuid>>, SendError> {
    let rows = tx.exec("sent.plan_edge", EDGE_SQL, &[Val::Uuid(org), Val::Uuid(node)]).await?;
    Ok(opt_parent(&rows))
}

async fn grant_exists<S: Session>(tx: &mut Tx<'_, S>, label: &str, org: Uuid, grantee: Uuid, kind: &'static str, target: Uuid) -> Result<bool, SendError> {
    let rows = tx.exec(label, GRANT_SQL, &[Val::Uuid(org), Val::Uuid(grantee), Val::text(kind), Val::Uuid(target)]).await?;
    Ok(!rows.is_empty())
}

fn not_addressable(sender: Uuid, to: To) -> SendError {
    let what = match to {
        To::Agent(r) => r.to_string(),
        To::User => "the user".to_string(),
    };
    refuse(
        "not_addressable",
        format!("{sender} may not address {what} — reach down, one hop up, sideways, or via a held audience; route anything else through your superior (§7.2)"),
    )
}

/// Plan the route from unlocked reads (the prediction step). Refuses when no
/// route exists; a refusal commits nothing (E-D5).
pub async fn plan_route<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, sender: Uuid, to: To) -> Result<RoutePlan, SendError> {
    let sp = edge(tx, org, sender).await?.ok_or_else(|| refuse("no_such_agent", "the sender has no edge row"))?;
    let mut plan = RoutePlan { sender, to, route: Route::SelfSend, edges: Vec::new(), grant_row: None, reply_grant_exists: false };
    let r = match to {
        To::User => {
            if sp.is_none() {
                plan.route = Route::UserTopLevel;
                plan.edges.push((sender, None));
            } else if grant_exists(tx, "sent.plan_grant", org, sender, "user", Uuid::nil()).await? {
                plan.route = Route::UserAudience;
                plan.grant_row = Some((sender, "user", Uuid::nil()));
            } else {
                return Err(refuse(
                    "not_addressable",
                    "only top-level agents (or holders of a user audience) may write to the user — escalate to your superior instead (§7.5)",
                ));
            }
            return Ok(plan);
        }
        To::Agent(r) => r,
    };
    if r == sender {
        // D-165: self-send is allowed and relies on nothing.
        return Ok(plan);
    }
    if sp == Some(r) {
        plan.route = Route::Parent;
        plan.edges.push((sender, sp));
        return Ok(plan);
    }
    let rp = edge(tx, org, r).await?.ok_or_else(|| refuse("no_such_agent", "the recipient has no edge row"))?;
    // downward, any depth: walk the recipient's chain up to the sender
    let mut chain = vec![(r, rp)];
    let mut cur = rp;
    let mut found = false;
    while let Some(p) = cur {
        if p == sender {
            found = true;
            break;
        }
        if chain.len() >= MAX_DEPTH {
            break;
        }
        let pp = edge(tx, org, p).await?.ok_or_else(|| refuse("no_such_agent", "a chain node has no edge row"))?;
        chain.push((p, pp));
        cur = pp;
    }
    if found {
        plan.route = if rp == Some(sender) { Route::Child } else { Route::DeepDescendant };
        plan.edges = chain;
        if plan.route == Route::DeepDescendant {
            plan.reply_grant_exists = grant_exists(tx, "sent.plan_reply_grant", org, r, "agent", sender).await?;
        }
        return Ok(plan);
    }
    if sp == rp {
        plan.route = Route::Sibling;
        let mut e = vec![(sender, sp), (r, rp)];
        e.sort_by_key(|x| x.0);
        plan.edges = e;
        return Ok(plan);
    }
    if grant_exists(tx, "sent.plan_grant", org, sender, "agent", r).await? {
        plan.route = Route::HeldAudience;
        plan.grant_row = Some((sender, "agent", r));
        return Ok(plan);
    }
    Err(not_addressable(sender, to))
}

/// E1.1 step 4 (C3): lock every row the plan relies on, `FOR SHARE`, leaf
/// upward, re-checking that each locked edge still has the parent the plan
/// saw (chain continuity, r7 N20). A changed row asks the executor to re-run
/// the attempt, whose fresh plan decides again.
pub async fn anchor_route<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, plan: &RoutePlan) -> Result<(), SendError> {
    for (node, parent) in &plan.edges {
        let rows = tx.exec("sent.anchor_edge", EDGE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(*node)]).await?;
        if opt_parent(&rows) != Some(*parent) {
            return Err(SendError::Retry("sent.route_changed"));
        }
    }
    if let Some((grantee, kind, target)) = plan.grant_row {
        let rows = tx.exec("sent.anchor_grant", GRANT_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(grantee), Val::text(kind), Val::Uuid(target)]).await?;
        if rows.is_empty() {
            return Err(SendError::Retry("sent.route_changed"));
        }
    }
    Ok(())
}

/// The outcome of [`address_agent`]: the anchored route, the captured
/// recipient, and the grant effect to pass to [`record_sent`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Addressed {
    pub route: Route,
    pub recipient: Recipient,
    pub grant: GrantEffect,
}

/// E1.1 steps 3-4 for an in-org agent recipient, in the canonical order:
/// unlocked plan (prediction) → recipient epoch (`FOR SHARE`, or
/// `FOR NO KEY UPDATE` when the plan predicts a reply grant) and mailbox →
/// route anchors → grant re-check. If the anchored state needs a grant the
/// prediction did not lock for, the attempt is re-run (`sent.prediction_stale`);
/// a share lock is never upgraded (Q-AM1 (ii)).
///
/// `reply_grant` is false for sends that must grant nothing (the automatic
/// participation notice, v6 matrix); explicit messages and notices pass true.
pub async fn address_agent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, sender: Uuid, recipient: Uuid, reply_grant: bool) -> Result<Addressed, SendError> {
    let plan = plan_route(tx, org, sender, To::Agent(recipient)).await?;
    let predicted = reply_grant && plan.route.reply_grant_possible() && !plan.reply_grant_exists;
    let unsafe_upgrade = predicted && controls::fire(&tx.scope(), "Q-AM1.share_then_upgrade");
    let lock = if predicted && !unsafe_upgrade { RecipientLock::Grant } else { RecipientLock::Share };
    let rcpt = resolve_recipient(tx, org, recipient, lock).await?;
    anchor_route(tx, org, &plan).await?;
    let mut grant = GrantEffect::None;
    if reply_grant && plan.route.reply_grant_possible() {
        // re-read after the anchors: a revoke committed since the plan
        let exists = grant_exists(tx, "sent.recheck_reply_grant", org, recipient, "agent", sender).await?;
        if !exists {
            if lock != RecipientLock::Grant && !unsafe_upgrade {
                return Err(SendError::Retry("sent.prediction_stale"));
            }
            grant = GrantEffect::ReplyGrant { grantee: recipient, target: sender };
        }
    }
    Ok(Addressed { route: plan.route, recipient: rcpt, grant })
}

/// E1.1 steps 3-4 for mail to the user from an agent (v6 "Agent to human").
pub async fn address_user<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, sender: Uuid) -> Result<(Route, Destination), SendError> {
    let plan = plan_route(tx, org, sender, To::User).await?;
    anchor_route(tx, org, &plan).await?;
    let dest = user_mailbox(tx, org).await?;
    Ok((plan.route, dest))
}

// ---------------------------------------------------------------- record_sent

fn validate(req: &SendRequest) -> Result<(), SendError> {
    if let Some(reason) = &req.urgent_reason {
        if !matches!(req.dest, Destination::UserMailbox { .. }) {
            return Err(refuse("urgent_not_user", "only mail to the user can be urgent — urgency is about the USER's attention"));
        }
        if reason.trim().is_empty() {
            return Err(refuse("urgent_reason_blank", "urgent mail needs a reason: one line, written for the USER"));
        }
    }
    match (&req.grant, &req.dest, &req.source) {
        (GrantEffect::None, Destination::External { .. }, MailSource::Agent { .. }) if req.attributed => {}
        (GrantEffect::None, Destination::External { .. }, _) => {
            return Err(refuse("invalid_send", "an outside send needs EXTERN authority or a held handle"));
        }
        (GrantEffect::None, _, _) => {}
        (GrantEffect::ReplyGrant { grantee, target }, Destination::Resolved { principal, .. }, MailSource::Agent { principal: s })
            if grantee == principal && target == s => {}
        (GrantEffect::FirstContactUser { node }, Destination::Resolved { principal, .. }, MailSource::User) if node == principal => {}
        (GrantEffect::Extern, Destination::External { .. }, MailSource::Agent { .. }) if !req.attributed => {}
        _ => return Err(refuse("invalid_send", "the grant effect does not match the source and destination")),
    }
    if matches!(req.dest, Destination::External { .. }) && req.class == MailClass::Notice {
        return Err(refuse("invalid_send", "a system notice cannot go to an outside party"));
    }
    Ok(())
}

/// Insert one audience grant and, only when a row was inserted, bump the
/// grantee's authority-epoch row (r7 C2a P1).
async fn insert_grant<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, grantee: Uuid, kind: &'static str, target: Uuid, anchor: Option<Uuid>, now: i64) -> Result<bool, SendError> {
    let unsafe_hm1 = kind == "user" && controls::fire(&tx.scope(), "Q-HM1.no_lock_no_key");
    let inserted = if unsafe_hm1 {
        // Q-HM1 control: read the grant, then a plain insert (the harness drops
        // audience_grants_key for this run), and the bump a plain update.
        let exists = grant_exists(tx, "sent.grant_probe", org, grantee, kind, target).await?;
        if exists {
            false
        } else {
            let rows = tx
                .exec("sent.grant_plain", INSERT_GRANT_PLAIN_SQL, &[Val::Uuid(org), Val::Uuid(grantee), Val::text(kind), Val::Uuid(target), Val::opt_uuid(anchor), Val::Ts(now)])
                .await?;
            !rows.is_empty()
        }
    } else {
        let rows = tx.exec("sent.grant", INSERT_GRANT_SQL, &[Val::Uuid(org), Val::Uuid(grantee), Val::text(kind), Val::Uuid(target), Val::opt_uuid(anchor), Val::Ts(now)]).await?;
        !rows.is_empty()
    };
    if inserted && !controls::fire(&tx.scope(), "Q-C7.skip_epoch_bump") {
        tx.exec("sent.bump_audience", BUMP_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(grantee)]).await?;
    }
    Ok(inserted)
}

/// Record a restriction on `principal`'s broad authority with one obligation
/// per registered read service (r7 C5; CONTRACT-M1 §6 F1 lock order).
async fn record_restriction<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid, reason: &str, now: i64) -> Result<(), SendError> {
    let rows = tx.exec("sent.restriction_epoch", RESTRICTION_EPOCH_SHARE_SQL, &[Val::Uuid(org)]).await?;
    let epoch = first_val(&rows).and_then(Val::as_int).unwrap_or(0);
    let regs = tx.exec("sent.registrations", REGISTRATIONS_SQL, &[Val::Uuid(org)]).await?;
    let id = Uuid::new_v4();
    tx.exec("sent.restriction", INSERT_RESTRICTION_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Int(epoch), Val::text(reason), Val::Uuid(principal), Val::Ts(now)]).await?;
    for r in &regs.0 {
        if let Some(svc) = r.first().and_then(Val::as_uuid) {
            tx.exec("sent.obligation", INSERT_OBLIGATION_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Uuid(svc)]).await?;
        }
    }
    Ok(())
}

/// EXTERN authority for an outside send (E1.1 step 5; `ledger.py:3366-3435`).
/// Returns `(granted, revoked holders, notice sends to write)`.
async fn extern_effect<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, sender: Uuid, now: i64) -> Result<(bool, Vec<Uuid>), SendError> {
    let rows = tx.exec("sent.kiosk", KIOSK_SQL, &[Val::Uuid(org)]).await?;
    if first_val(&rows) == Some(&Val::Bool(true)) {
        return Err(refuse("sealed_kiosk", "this organization is a sealed kiosk — it has no contact with the outside world"));
    }
    let unlocked = controls::fire(&tx.scope(), "Q-AM4.no_holder_lock");
    let rows = if unlocked {
        tx.exec("sent.holders_read", HOLDERS_READ_SQL, &[Val::Uuid(org)]).await?
    } else {
        tx.exec("sent.holders_lock", HOLDERS_LOCK_SQL, &[Val::Uuid(org)]).await?
    };
    let value = first_val(&rows).and_then(Val::as_json).cloned().ok_or_else(|| refuse("extern_unconfigured", "the organization has no extern_holders control row"))?;
    let multi = value.get("multi_holder").and_then(|v| v.as_bool()).unwrap_or(false);
    if grant_exists(tx, "sent.extern_held", org, sender, "extern", Uuid::nil()).await? {
        return Ok((false, Vec::new()));
    }
    let top = tx.exec("sent.extern_top", EDGE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(sender)]).await?;
    if opt_parent(&top) != Some(None) {
        return Err(refuse(
            "not_extern_holder",
            "only ORG-INBOX audience holders speak for the org to the outside — ask your top-level superior for the audience, or escalate the message to your superior (§7.5)",
        ));
    }
    let mut revoked = Vec::new();
    if !multi {
        let rows = tx.exec("sent.extern_holders", EXTERN_HOLDERS_SQL, &[Val::Uuid(org), Val::Uuid(Uuid::nil()), Val::Uuid(sender)]).await?;
        let holders: Vec<Uuid> = rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
        for h in holders {
            // ascending principal order: two replacements lock the same rows in one order
            tx.exec("sent.extern_lock_old", LOCK_EPOCH_UPDATE_SQL, &[Val::Uuid(org), Val::Uuid(h)]).await?;
            tx.exec("sent.extern_revoke", DELETE_GRANT_SQL, &[Val::Uuid(org), Val::Uuid(h), Val::text("extern"), Val::Uuid(Uuid::nil())]).await?;
            if !controls::fire(&tx.scope(), "Q-C7.skip_epoch_bump") {
                tx.exec("sent.bump_audience", BUMP_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(h)]).await?;
            }
            record_restriction(tx, org, h, "extern_replaced", now).await?;
            revoked.push(h);
        }
    }
    tx.exec("sent.lock_self_epoch", LOCK_EPOCH_UPDATE_SQL, &[Val::Uuid(org), Val::Uuid(sender)]).await?;
    let granted = insert_grant(tx, org, sender, "extern", Uuid::nil(), None, now).await?;
    if !unlocked {
        tx.exec("sent.holders_bump", HOLDERS_BUMP_SQL, &[Val::Uuid(org)]).await?;
    }
    Ok((granted, revoked))
}

/// Write the source Sent row and its delivery intent, plus any permission
/// effect, INSIDE the caller's command transaction (org = `tx.op().org`).
///
/// Writes: `mail_sent` (with `pair_seq` = committed max + 1 for a pair-gated
/// send; a collision on `mail_sent_pair_seq` is an allowlisted retry), one
/// `outgoing_intents` row (`mail.deliver`) or `transport_intents` row, and the
/// grant rows with their epoch bumps. For each replaced EXTERN holder it also
/// sends a `Notice` to that holder's mailbox (its own Sent row and intent).
/// Never a receiver row. After commit: a hint to each receiver's queue.
pub async fn record_sent<S: Session>(tx: &mut Tx<'_, S>, req: &SendRequest) -> Result<SentRecord, SendError> {
    let org = tx.op().org;
    validate(req)?;
    let now = tx.now().await?;
    // step 5: permission effects
    let mut grant_inserted = false;
    let mut extern_revoked = Vec::new();
    match &req.grant {
        GrantEffect::None => {}
        GrantEffect::ReplyGrant { grantee, target } => {
            grant_inserted = insert_grant(tx, org, *grantee, "agent", *target, Some(*target), now).await?;
        }
        GrantEffect::FirstContactUser { node } => {
            grant_inserted = insert_grant(tx, org, *node, "user", Uuid::nil(), None, now).await?;
        }
        GrantEffect::Extern => {
            let (g, r) = extern_effect(tx, org, req.source.id(), now).await?;
            grant_inserted = g;
            extern_revoked = r;
        }
    }
    // step 6: the Sent row and its intent
    let rec = write_sent(tx, org, req, now).await?;
    for old in &extern_revoked {
        // the causal notification to each replaced holder: a system notice
        if let Ok(Recipient { dest, .. }) = resolve_mailbox_only(tx, org, *old).await {
            let n = SendRequest::notice(
                MailSource::System,
                dest,
                Uuid::new_v4(),
                "access.audience_changed",
                "the ORG-INBOX audience was rescinded: a top-level agent's first outside send took it over",
                "extern-replaced",
            );
            write_sent(tx, org, &n, now).await?;
        }
    }
    Ok(SentRecord { message_id: req.original_message_id, pair_seq: rec.0, outgoing_intent: rec.1, grant_inserted, extern_revoked })
}

/// The mailbox of a principal without any lock (the replaced EXTERN holder's
/// notice: its epoch row is already held FOR NO KEY UPDATE).
async fn resolve_mailbox_only<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<Recipient, SendError> {
    let rows = tx.exec("sent.recipient_mailbox", RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    let row = rows.first().ok_or_else(|| refuse("no_mailbox", "no open mailbox"))?;
    let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| refuse("no_mailbox", "undecodable mailbox row"))?;
    let incarnation = row.get(1).and_then(Val::as_int).unwrap_or(1);
    Ok(Recipient { dest: Destination::Resolved { principal, mailbox, mailbox_incarnation: incarnation }, lifecycle: Lifecycle::Live })
}

async fn write_sent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, req: &SendRequest, now: i64) -> Result<(Option<i64>, Uuid), SendError> {
    let (dest_kind, dest_mailbox, dest_principal, dest_incarnation, dest_external) = match &req.dest {
        Destination::Resolved { principal, mailbox, mailbox_incarnation } => ("mailbox", Some(*mailbox), Some(*principal), Some(*mailbox_incarnation), None),
        Destination::UserMailbox { mailbox } => ("mailbox", Some(*mailbox), None, None, None),
        Destination::External { handle } => ("external", None, None, None, Some(handle.clone())),
    };
    let pair_seq = if req.pair_gated() {
        let rows = tx
            .exec("sent.pair_seq", PAIR_SEQ_SQL, &[Val::Uuid(org), Val::text(req.source.kind()), Val::Uuid(req.source.id()), Val::opt_uuid(dest_mailbox)])
            .await?;
        let n = first_val(&rows).and_then(Val::as_int).ok_or_else(|| DbError::Sql {
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
            dest_external.clone().map(Val::Text).unwrap_or(Val::Null),
            Val::opt_int(pair_seq),
            Val::text(req.kind.clone()),
            Val::Bool(req.urgent()),
            req.urgent_reason.clone().map(|r| Val::Text(r.trim().to_string())).unwrap_or(Val::Null),
            Val::text(req.body.clone()),
            Val::text(req.fingerprint.clone()),
            Val::text(req.class.name()),
            Val::Bool(req.attributed),
            Val::Ts(now),
        ],
    )
    .await?;
    let intent = Uuid::new_v4();
    match (&dest_external, dest_mailbox) {
        (Some(handle), _) => {
            tx.exec("sent.transport", INSERT_TRANSPORT_SQL, &[Val::Uuid(org), Val::Uuid(intent), Val::Uuid(req.original_message_id), Val::text(handle.clone()), Val::Ts(now)])
                .await?;
            let h = Hint::Transport { org, message: req.original_message_id };
            tx.after_commit(move || hints::emit(h));
        }
        (None, Some(mailbox)) => {
            tx.exec("sent.intent", INSERT_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(intent), Val::Uuid(req.original_message_id), Val::Uuid(mailbox), Val::Ts(now)]).await?;
            if controls::fire(&tx.scope(), "Q-AM1.source_writes_head") {
                tx.exec("sent.unsafe_head_write", UNSAFE_HEAD_WRITE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
            }
            if controls::fire(&tx.scope(), "Q-R6.receiver_write_in_source") {
                tx.exec("sent.unsafe_inbox_write", UNSAFE_INBOX_WRITE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(req.original_message_id), Val::text(req.fingerprint.clone()), Val::Ts(now)])
                    .await?;
            }
            let h = Hint::Deliver { org, mailbox, message: req.original_message_id };
            tx.after_commit(move || hints::emit(h));
        }
        (None, None) => unreachable!("a destination is a mailbox or an outside handle"),
    }
    Ok((pair_seq, intent))
}

/// E1.5: take back a message this command's forward half sent (the
/// quick-staff undo). Records a retraction intent for `(mailbox, original
/// message id)`; never writes the mailbox. The receiver applies it: not yet
/// received → a terminal cancellation fence; pending → retracted; already
/// confirmed as input → reported too late. Idempotent per key.
pub async fn record_retraction<S: Session>(tx: &mut Tx<'_, S>, mailbox: Uuid, original_message_id: Uuid) -> Result<bool, SendError> {
    let org = tx.op().org;
    let now = tx.now().await?;
    let rows = tx
        .exec("sent.retract", INSERT_RETRACT_SQL, &[Val::Uuid(org), Val::Uuid(Uuid::new_v4()), Val::Uuid(original_message_id), Val::Uuid(mailbox), Val::Ts(now)])
        .await?;
    let inserted = !rows.is_empty();
    if inserted {
        let h = Hint::Deliver { org, mailbox, message: original_message_id };
        tx.after_commit(move || hints::emit(h));
    }
    Ok(inserted)
}
