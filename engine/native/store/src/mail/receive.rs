//! The RECEIVER half of two-stage mail (S3 E1.3-E1.5; v6 MAIL-STAGES
//! "Received"), the source-side acknowledgement, and the delivery driver.
//!
//! * [`Receive`]: the receiving mailbox's transaction (READ COMMITTED). For an
//!   agent mailbox: the HEAD row `FOR UPDATE` first (P8), then dedupe on
//!   `(mailbox, original message id)` with the fingerprint, the pair gate
//!   (E-D1: the pair's high-water row `FOR UPDATE`; an early `n` is PARKED,
//!   committing nothing), the owner's authority-epoch row `FOR SHARE` read
//!   AFTER the head lock (skipped for a system notice), then the message with
//!   the next dense ordinal, the head update, the high-water advance and the
//!   wake intent. The human mailbox (E1.4) has no head and no ordinal. A
//!   closed mailbox, a stale incarnation or an unrecoverable owner records a
//!   terminal refusal FENCE on the key, never a message. It reads the captured
//!   Sent row, locks no source row and no grant row, and re-checks nothing of
//!   the sender's authority (v6).
//! * [`Retract`] (E1.5): not yet received → a `cancelled` fence; pending →
//!   `retracted`; already delivering/confirmed → too late.
//! * [`Ack`]: the SOURCE settles its delivery intent from the receiver's
//!   outcome, idempotently, in its own transaction (the receiver never writes
//!   a source row, v6 I07).
//! * [`deliver`]: run the receive, then the ack; a parked or failed receive
//!   leaves the intent pending for recovery.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, ExecError, Executor, Family, Isolation, OpIdentity, Outcome, Principal, Refusal};
use crate::hooks::controls;
use crate::mail::hints::{self, Hint};
use crate::session::{Connector, DbError, Session};
use crate::value::{Rows, Val};
use crate::Tx;

pub static RECEIVE: Family = Family { name: "mail.receive", isolation: Isolation::ReadCommitted, retry_unique: &["mailbox_messages_original"] };
pub static ACK: Family = Family { name: "mail.ack", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const CONTROLS: &[&str] = &["Q-AM2.no_pair_gate", "Q-AM3.no_dedupe_key", "Q-AM5.resolve_by_name"];

pub const SENT_SQL: &str = "SELECT source_kind, source_id, dest_mailbox_id, dest_principal_id, dest_mailbox_incarnation, \
    pair_seq, kind, class, urgent, fingerprint, sent_at FROM mail_sent WHERE org_id = $1 AND message_id = $2";
pub const MAILBOX_SQL: &str = "SELECT owner_kind, owner_id, incarnation FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2";
pub const HEAD_LOCK_SQL: &str = "SELECT recv_seq, state, incarnation FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2 FOR UPDATE";
pub const HEAD_ADVANCE_SQL: &str = "UPDATE mailboxes SET recv_seq = recv_seq + 1, version = version + 1 \
    WHERE org_id = $1 AND mailbox_id = $2 RETURNING recv_seq";
pub const HEAD_BUMP_SQL: &str = "UPDATE mailboxes SET version = version + 1 WHERE org_id = $1 AND mailbox_id = $2";
pub const USER_STATE_SQL: &str = "SELECT state FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2";
pub const EXISTING_SQL: &str = "SELECT fingerprint, state FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3";
pub const HW_ENSURE_SQL: &str = "INSERT INTO mail_pair_highwater (org_id, mailbox_id, source_kind, source_id, high_seq) \
    VALUES ($1, $2, $3, $4, 0) ON CONFLICT ON CONSTRAINT mail_pair_highwater_pk DO NOTHING";
pub const HW_LOCK_SQL: &str = "SELECT high_seq FROM mail_pair_highwater \
    WHERE org_id = $1 AND mailbox_id = $2 AND source_kind = $3 AND source_id = $4 FOR NO KEY UPDATE";
pub const HW_ADVANCE_SQL: &str = "UPDATE mail_pair_highwater SET high_seq = $5 \
    WHERE org_id = $1 AND mailbox_id = $2 AND source_kind = $3 AND source_id = $4";
pub const OWNER_SQL: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const INSERT_MSG_SQL: &str = "INSERT INTO mailbox_messages \
    (org_id, mailbox_id, original_message_id, recv_ord, fingerprint, state, is_notice, received_at, read_at, \
     class, kind, source_kind, source_id, pair_seq, sent_at, urgent) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)";
pub const INSERT_FENCE_SQL: &str = "INSERT INTO mailbox_messages \
    (org_id, mailbox_id, original_message_id, fingerprint, state, is_notice, received_at, class, kind, source_kind, source_id, pair_seq, sent_at) \
    VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11, $12)";
pub const WAKE_SQL: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'wake', $3, $4, $5, $5) ON CONFLICT ON CONSTRAINT outgoing_intents_unique_effect DO NOTHING RETURNING intent_id";
pub const NEXT_PARKED_SQL: &str = "SELECT s.message_id FROM mail_sent s \
    WHERE s.org_id = $1 AND s.source_kind = $2 AND s.source_id = $3 AND s.dest_mailbox_id = $4 AND s.pair_seq = $5";
/// Q-AM5 unsafe control: the destination resolved BY NAME at receive time,
/// through the captured display label, to whoever holds that name now.
pub const BY_NAME_SQL: &str = "SELECT m.mailbox_id FROM mail_sent s \
    JOIN agent_names n ON n.org_id = s.org_id AND n.name = s.dest_label AND n.kind = 'active' \
    JOIN mailboxes m ON m.org_id = n.org_id AND m.owner_kind = 'agent' AND m.owner_id = n.principal_id AND m.state = 'open' \
    WHERE s.org_id = $1 AND s.message_id = $2 ORDER BY m.incarnation DESC LIMIT 1";
pub const RETRACT_ROW_SQL: &str = "UPDATE mailbox_messages SET state = 'retracted' \
    WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3 AND state = 'pending' RETURNING 1";
pub const ACK_SQL: &str = "UPDATE outgoing_intents SET stage = $5, settled_at = $6 \
    WHERE org_id = $1 AND kind = $2 AND source_ref = $3 AND dest_ref = $4 AND stage IN ('pending', 'dormant') RETURNING intent_id";

fn defect(m: impl Into<String>) -> DbError {
    DbError::Sql { code: "XX000".into(), constraint: None, message: m.into() }
}

/// What the receiver committed for one original message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Received {
    /// The message is in the mailbox. `recv_ord` is `None` in the human
    /// mailbox (E-D3). `woke`: a wake intent was recorded; `deferred`: the
    /// owner is archived (legacy: saved, not woken).
    Received { recv_ord: Option<i64>, woke: bool, deferred: bool },
    /// The same original with the same fingerprint was already received
    /// (idempotent success; a lost acknowledgement is regenerated).
    Duplicate,
    /// A terminal refusal under a proven fence: `closed` mailbox, `stale`
    /// incarnation, `unrecoverable` owner, or an earlier `cancelled` fence.
    Refused { reason: String },
}

impl Received {
    /// The source's settlement for this outcome.
    pub fn ack_stage(&self) -> &'static str {
        match self {
            Received::Received { .. } | Received::Duplicate => "settled",
            Received::Refused { .. } => "refused",
        }
    }
}

struct SentRow {
    source_kind: String,
    source_id: Uuid,
    dest_mailbox: Option<Uuid>,
    dest_incarnation: Option<i64>,
    pair_seq: Option<i64>,
    kind: String,
    class: String,
    urgent: bool,
    fingerprint: String,
    sent_at: Val,
}

async fn read_sent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, message: Uuid) -> Result<SentRow, CmdError> {
    let rows = tx.exec("receive.sent", SENT_SQL, &[Val::Uuid(org), Val::Uuid(message)]).await?;
    let r = rows.first().ok_or_else(|| CmdError::Defect("no Sent row for this original message".into()))?;
    let text = |i: usize| r.get(i).and_then(Val::as_text).unwrap_or("").to_string();
    Ok(SentRow {
        source_kind: text(0),
        source_id: r.get(1).and_then(Val::as_uuid).unwrap_or_else(Uuid::nil),
        dest_mailbox: r.get(2).and_then(Val::as_uuid),
        dest_incarnation: r.get(4).and_then(Val::as_int),
        pair_seq: r.get(5).and_then(Val::as_int),
        kind: text(6),
        class: text(7),
        urgent: r.get(8) == Some(&Val::Bool(true)),
        fingerprint: text(9),
        sent_at: r.get(10).cloned().unwrap_or(Val::Null),
    })
}

/// Receive one original message into one mailbox. `human` names the
/// mailbox kind (it decides the op kind: `deliver_agent` locks and writes the
/// head, `deliver_human` never does, E1.4); execution refuses a mismatch.
pub struct Receive {
    pub org: Uuid,
    pub mailbox: Uuid,
    pub message: Uuid,
    pub human: bool,
}

impl Receive {
    pub fn binding(&self) -> Binding {
        receiver_binding(self.org, &format!("receive:{}:{}", self.mailbox, self.message))
    }
}

/// Receiver and ack transactions run under minted keys (their receipt row is
/// the transaction's group identity, CONTRACT-M1 §3.7) as `System`.
pub fn receiver_binding(org: Uuid, fingerprint: &str) -> Binding {
    Binding {
        principal: Principal::System,
        acting: None,
        op: OpIdentity::minted(org, fingerprint, "ws5-receiver-1"),
        db_incarnation: Uuid::nil(),
        op_tag: None,
    }
}

impl Command for Receive {
    type Output = Received;
    fn family(&self) -> &'static Family {
        &RECEIVE
    }
    fn verb(&self) -> &'static str {
        if self.human {
            "deliver_human"
        } else {
            "deliver_agent"
        }
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        // A receiver executor has no caller: it acts on a captured delegation.
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Received) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<Received>, CmdError> {
        let org = self.org;
        let sent = read_sent(tx, org, self.message).await?;
        let mut mailbox = self.mailbox;
        if sent.dest_mailbox != Some(mailbox) {
            return Err(CmdError::Defect("the delivery names a mailbox other than the captured destination".into()));
        }
        // Q-AM5 control: re-resolve the destination by NAME at receive time.
        if controls::fire(&tx.scope(), "Q-AM5.resolve_by_name") {
            let rows = tx.exec("receive.unsafe_by_name", BY_NAME_SQL, &[Val::Uuid(org), Val::Uuid(self.message)]).await?;
            if let Some(m) = rows.first().and_then(|r| r.first()).and_then(Val::as_uuid) {
                mailbox = m;
            }
        }
        let mb = tx.exec("receive.mailbox", MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let mrow = mb.first().ok_or_else(|| CmdError::Defect("the captured mailbox does not exist".into()))?;
        let owner_kind = mrow.first().and_then(Val::as_text).unwrap_or("").to_string();
        let owner = mrow.get(1).and_then(Val::as_uuid);
        if (owner_kind == "user") != self.human {
            return Err(CmdError::Defect("the delivery named the wrong mailbox kind".into()));
        }
        if owner_kind == "user" {
            return receive_user(tx, org, mailbox, self.message, &sent).await;
        }
        receive_agent(tx, org, mailbox, owner.unwrap_or_else(Uuid::nil), self.message, &sent).await
    }
}

/// Dedupe (E1.3 step 2): `Some(outcome)` when a row for the key exists.
async fn dedupe<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, message: Uuid, fp: &str) -> Result<Option<Decided<Received>>, CmdError> {
    if controls::fire(&tx.scope(), "Q-AM3.no_dedupe_key") {
        // Unsafe control: no dedupe read (the harness also drops the key).
        return Ok(None);
    }
    let rows = tx.exec("receive.existing", EXISTING_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(message)]).await?;
    let Some(r) = rows.first() else { return Ok(None) };
    let stored_fp = r.first().and_then(Val::as_text).unwrap_or("");
    let state = r.get(1).and_then(Val::as_text).unwrap_or("");
    if state == "cancelled" || state == "refused" {
        return Ok(Some(Decided::Applied(Received::Refused { reason: if state == "cancelled" { "cancelled".into() } else { "fenced".into() } })));
    }
    if stored_fp != fp {
        return Ok(Some(Decided::Refused(Refusal::new("conflict", "the same original message with a different fingerprint"))));
    }
    Ok(Some(Decided::Applied(Received::Duplicate)))
}

/// The pair gate (E1.2): `Ok(true)` = admitted, `Ok(false)` = parked.
async fn pair_gate<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, sent: &SentRow) -> Result<bool, CmdError> {
    let Some(n) = sent.pair_seq else { return Ok(true) };
    if controls::fire(&tx.scope(), "Q-AM2.no_pair_gate") {
        return Ok(true);
    }
    let key = [Val::Uuid(org), Val::Uuid(mailbox), Val::text(sent.source_kind.clone()), Val::Uuid(sent.source_id)];
    tx.exec("receive.hw_ensure", HW_ENSURE_SQL, &key).await?;
    let rows = tx.exec("receive.hw_lock", HW_LOCK_SQL, &key).await?;
    let high = rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(|| defect("no high-water row"))?;
    Ok(high >= n - 1)
}

async fn advance_pair<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, sent: &SentRow) -> Result<(), CmdError> {
    let Some(n) = sent.pair_seq else { return Ok(()) };
    let key = [Val::Uuid(org), Val::Uuid(mailbox), Val::text(sent.source_kind.clone()), Val::Uuid(sent.source_id), Val::Int(n)];
    tx.exec("receive.hw_advance", HW_ADVANCE_SQL, &key).await?;
    // a parked n+1 of the same pair is hinted straight after this commit
    let rows = tx.exec("receive.next_parked", NEXT_PARKED_SQL, &[Val::Uuid(org), Val::text(sent.source_kind.clone()), Val::Uuid(sent.source_id), Val::Uuid(mailbox), Val::Int(n + 1)]).await?;
    if let Some(next) = rows.first().and_then(|r| r.first()).and_then(Val::as_uuid) {
        let h = Hint::Deliver { org, mailbox, message: next };
        tx.after_commit(move || hints::emit(h));
    }
    Ok(())
}

async fn fence<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, message: Uuid, sent: &SentRow, reason: &str) -> Result<Decided<Received>, CmdError> {
    let now = tx.now().await?;
    tx.exec(
        "receive.fence",
        INSERT_FENCE_SQL,
        &[
            Val::Uuid(org),
            Val::Uuid(mailbox),
            Val::Uuid(message),
            Val::text(sent.fingerprint.clone()),
            Val::text("refused"),
            Val::Ts(now),
            Val::text(sent.class.clone()),
            Val::text(sent.kind.clone()),
            Val::text(sent.source_kind.clone()),
            Val::Uuid(sent.source_id),
            Val::opt_int(sent.pair_seq),
            sent.sent_at.clone(),
        ],
    )
    .await?;
    // a refusal under a proven fence is terminal for the pair too (E1.2)
    advance_pair(tx, org, mailbox, sent).await?;
    Ok(Decided::Applied(Received::Refused { reason: reason.into() }))
}

async fn receive_agent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, owner: Uuid, message: Uuid, sent: &SentRow) -> Result<Decided<Received>, CmdError> {
    // 1. the HEAD row FOR UPDATE (P8), before anything else about the box
    let head = tx.exec("receive.head", HEAD_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    let h = head.first().ok_or_else(|| defect("head row vanished"))?;
    let state = h.get(1).and_then(Val::as_text).unwrap_or("").to_string();
    let incarnation = h.get(2).and_then(Val::as_int);
    // 2. dedupe
    if let Some(d) = dedupe(tx, org, mailbox, message, &sent.fingerprint).await? {
        return Ok(d);
    }
    // 3. pair gate (not for notices or SYSTEM: they carry no pair_seq)
    if !pair_gate(tx, org, mailbox, sent).await? {
        return Ok(Decided::Refused(Refusal::new("parked", "an earlier message of this pair has no terminal outcome yet")));
    }
    // closed mailbox or stale incarnation: a terminal refusal fence
    if state != "open" {
        tx.exec("receive.head_bump", HEAD_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        return fence(tx, org, mailbox, message, sent, "closed").await;
    }
    if sent.dest_incarnation.is_some() && sent.dest_incarnation != incarnation {
        tx.exec("receive.head_bump", HEAD_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        return fence(tx, org, mailbox, message, sent, "stale_incarnation").await;
    }
    // 4. receiver state, read AFTER the head lock; a system notice skips it
    let notice = sent.class == "notice";
    let mut lifecycle = "live".to_string();
    if !notice {
        let rows = tx.exec("receive.owner", OWNER_SQL, &[Val::Uuid(org), Val::Uuid(owner)]).await?;
        lifecycle = rows.first().and_then(|r| r.first()).and_then(Val::as_text).unwrap_or("absent").to_string();
        if lifecycle == "unrecoverable" || lifecycle == "absent" {
            tx.exec("receive.head_bump", HEAD_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
            return fence(tx, org, mailbox, message, sent, "unrecoverable").await;
        }
    }
    // 5. writes: the message with the next dense ordinal, head, high-water, wake
    let now = tx.now().await?;
    let adv = tx.exec("receive.head_advance", HEAD_ADVANCE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    let ord = adv.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(|| defect("head advance returned nothing"))?;
    tx.exec(
        "receive.insert",
        INSERT_MSG_SQL,
        &[
            Val::Uuid(org),
            Val::Uuid(mailbox),
            Val::Uuid(message),
            Val::Int(ord),
            Val::text(sent.fingerprint.clone()),
            Val::text("pending"),
            Val::Bool(notice),
            Val::Ts(now),
            Val::Null,
            Val::text(sent.class.clone()),
            Val::text(sent.kind.clone()),
            Val::text(sent.source_kind.clone()),
            Val::Uuid(sent.source_id),
            Val::opt_int(sent.pair_seq),
            sent.sent_at.clone(),
            Val::Bool(sent.urgent),
        ],
    )
    .await?;
    advance_pair(tx, org, mailbox, sent).await?;
    let deferred = lifecycle == "archived";
    let mut woke = false;
    if sent.class == "message" && !deferred {
        let rows = tx.exec("receive.wake", WAKE_SQL, &[Val::Uuid(org), Val::Uuid(Uuid::new_v4()), Val::Uuid(message), Val::Uuid(owner), Val::Ts(now)]).await?;
        woke = !rows.is_empty();
        if woke {
            let h = Hint::Runtime { org, principal: owner };
            tx.after_commit(move || hints::emit(h));
        }
    }
    Ok(Decided::Applied(Received::Received { recv_ord: Some(ord), woke, deferred }))
}

async fn receive_user<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mailbox: Uuid, message: Uuid, sent: &SentRow) -> Result<Decided<Received>, CmdError> {
    // E1.4: no head row. Dedupe on the key; the pair gate takes the pair's
    // high-water row itself (N5), which orders two quick sends of one pair.
    if let Some(d) = dedupe(tx, org, mailbox, message, &sent.fingerprint).await? {
        return Ok(d);
    }
    if !pair_gate(tx, org, mailbox, sent).await? {
        return Ok(Decided::Refused(Refusal::new("parked", "an earlier message of this pair has no terminal outcome yet")));
    }
    let st = tx.exec("receive.user_state", USER_STATE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    if st.first().and_then(|r| r.first()).and_then(Val::as_text) != Some("open") {
        return fence(tx, org, mailbox, message, sent, "closed").await;
    }
    let now = tx.now().await?;
    // an ordinary message arrives unread; a notice arrives already read
    let notice = sent.class == "notice";
    tx.exec(
        "receive.insert",
        INSERT_MSG_SQL,
        &[
            Val::Uuid(org),
            Val::Uuid(mailbox),
            Val::Uuid(message),
            Val::Null,
            Val::text(sent.fingerprint.clone()),
            Val::text(if notice { "read" } else { "pending" }),
            Val::Bool(notice),
            Val::Ts(now),
            if notice { Val::Ts(now) } else { Val::Null },
            Val::text(sent.class.clone()),
            Val::text(sent.kind.clone()),
            Val::text(sent.source_kind.clone()),
            Val::Uuid(sent.source_id),
            Val::opt_int(sent.pair_seq),
            sent.sent_at.clone(),
            Val::Bool(sent.urgent && !notice),
        ],
    )
    .await?;
    advance_pair(tx, org, mailbox, sent).await?;
    Ok(Decided::Applied(Received::Received { recv_ord: None, woke: false, deferred: false }))
}

/// E1.5: the receiver applies a retraction intent.
pub struct Retract {
    pub org: Uuid,
    pub mailbox: Uuid,
    pub message: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Retracted {
    /// Not yet received: a terminal `cancelled` fence on the key.
    Cancelled,
    /// Received and still pending: now `retracted`.
    Retracted,
    /// Already claimed as input, confirmed or read: too late.
    TooLate,
}

impl Command for Retract {
    type Output = Retracted;
    fn family(&self) -> &'static Family {
        &RECEIVE
    }
    fn verb(&self) -> &'static str {
        "retract"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Retracted) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<Retracted>, CmdError> {
        let (org, mailbox, message) = (self.org, self.mailbox, self.message);
        let mb = tx.exec("receive.mailbox", MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let agent_box = mb.first().and_then(|r| r.first()).and_then(Val::as_text) == Some("agent");
        if agent_box {
            tx.exec("receive.head", HEAD_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        }
        let rows = tx.exec("receive.existing", EXISTING_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(message)]).await?;
        let out = match rows.first().and_then(|r| r.get(1)).and_then(Val::as_text) {
            None => {
                let sent = read_sent(tx, org, message).await?;
                let now = tx.now().await?;
                tx.exec(
                    "receive.fence",
                    INSERT_FENCE_SQL,
                    &[
                        Val::Uuid(org),
                        Val::Uuid(mailbox),
                        Val::Uuid(message),
                        Val::text(sent.fingerprint.clone()),
                        Val::text("cancelled"),
                        Val::Ts(now),
                        Val::text(sent.class.clone()),
                        Val::text(sent.kind.clone()),
                        Val::text(sent.source_kind.clone()),
                        Val::Uuid(sent.source_id),
                        Val::opt_int(sent.pair_seq),
                        sent.sent_at.clone(),
                    ],
                )
                .await?;
                // a cancelled original is terminal for its pair (E1.2)
                if sent.pair_seq.is_some() {
                    pair_gate(tx, org, mailbox, &sent).await?;
                    advance_pair(tx, org, mailbox, &sent).await?;
                }
                Retracted::Cancelled
            }
            Some("pending") => {
                tx.exec("receive.retract_row", RETRACT_ROW_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(message)]).await?;
                Retracted::Retracted
            }
            Some(_) => Retracted::TooLate,
        };
        if agent_box && out != Retracted::TooLate {
            tx.exec("receive.head_bump", HEAD_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        }
        Ok(Decided::Applied(out))
    }
}

/// The source settles one delivery (or retraction) intent from the
/// receiver's outcome. Idempotent: a second ack matches nothing.
pub struct Ack {
    pub org: Uuid,
    /// `mail.deliver` or `mail.retract`.
    pub kind: &'static str,
    pub mailbox: Uuid,
    pub message: Uuid,
    /// `settled` or `refused`.
    pub stage: &'static str,
}

impl Command for Ack {
    type Output = bool;
    fn family(&self) -> &'static Family {
        &ACK
    }
    fn verb(&self) -> &'static str {
        "ack"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &bool) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, _b: &Binding) -> Result<Decided<bool>, CmdError> {
        let now = tx.now().await?;
        let rows: Rows = tx
            .exec("ack.settle", ACK_SQL, &[Val::Uuid(self.org), Val::text(self.kind), Val::Uuid(self.message), Val::Uuid(self.mailbox), Val::text(self.stage), Val::Ts(now)])
            .await?;
        Ok(Decided::Applied(!rows.is_empty()))
    }
}

/// What one delivery attempt did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Received (or duplicate, or fenced) and the source intent settled.
    Done(Received),
    /// Parked behind an earlier message of its pair; the intent stays pending.
    Parked,
    /// The receive did not commit (conflict, retries exhausted, unknown): the
    /// intent stays pending for recovery.
    NotDone(String),
}

/// Scheduled → Received → acknowledged, for one original message. No
/// transaction spans the two steps; a crash between them leaves the intent
/// pending, and the redelivery is a duplicate that regenerates the ack.
pub async fn deliver<C: Connector>(exec: &Executor<C>, org: Uuid, mailbox: Uuid, message: Uuid) -> Result<Delivery, ExecError> {
    let human = exec.read(&Route { org, mailbox }, org, None).await?;
    let r = Receive { org, mailbox, message, human };
    let received = match exec.run(&r, &r.binding()).await? {
        Outcome::Applied(x) | Outcome::Replayed(x) => x,
        Outcome::Refused(rf) if rf.code == "parked" => return Ok(Delivery::Parked),
        other => return Ok(Delivery::NotDone(other.name().to_string())),
    };
    let ack = Ack { org, kind: "mail.deliver", mailbox, message, stage: received.ack_stage() };
    match exec.run(&ack, &receiver_binding(org, &format!("ack:{mailbox}:{message}"))).await? {
        Outcome::Applied(_) | Outcome::Replayed(_) => Ok(Delivery::Done(received)),
        other => Ok(Delivery::NotDone(format!("ack {}", other.name()))),
    }
}

/// Which kind of mailbox a delivery targets (a short read before the receive,
/// so the receive runs as the right op kind).
pub struct Route {
    pub org: Uuid,
    pub mailbox: Uuid,
}

impl crate::read::Read for Route {
    type Output = bool;
    fn family(&self) -> &'static str {
        "mail.receive"
    }
    fn verb(&self) -> &'static str {
        "route"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<bool, CmdError> {
        let rows = tx.exec("receive.route", MAILBOX_SQL, &[Val::Uuid(self.org), Val::Uuid(self.mailbox)]).await?;
        Ok(rows.first().and_then(|r| r.first()).and_then(Val::as_text) == Some("user"))
    }
}

/// Apply one retraction intent and settle it.
pub async fn retract<C: Connector>(exec: &Executor<C>, org: Uuid, mailbox: Uuid, message: Uuid) -> Result<Option<Retracted>, ExecError> {
    let r = Retract { org, mailbox, message };
    let out = match exec.run(&r, &receiver_binding(org, &format!("retract:{mailbox}:{message}"))).await? {
        Outcome::Applied(x) | Outcome::Replayed(x) => x,
        _ => return Ok(None),
    };
    let ack = Ack { org, kind: "mail.retract", mailbox, message, stage: "settled" };
    exec.run(&ack, &receiver_binding(org, &format!("ack-retract:{mailbox}:{message}"))).await?;
    Ok(Some(out))
}
