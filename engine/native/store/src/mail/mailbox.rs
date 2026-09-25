//! Mailbox lifecycle helpers for the island families (S3 §3.2, pair P8).
//!
//! Every receive into an agent mailbox updates its HEAD row (E1.3). The island
//! writers that rely on what a receive writes take that head row BEFORE they
//! read the pending set or the notice box:
//!
//! * (a) rehire: [`drive_pending`] takes it `FOR SHARE`;
//! * (b) delete: [`close_mailbox`] takes it `FOR UPDATE`;
//! * (c) the notice fold ([`fold_notices`]), called by `cheap_compact`,
//!   `reseed` and the session splits of a cross-provider `switch_model` /
//!   `finish_switch_binding` / `assign_account`, takes it `FOR UPDATE`.
//!
//! In a SERIALIZABLE (island) transaction a head row updated after the
//! snapshot makes that lock raise `40001`, and C1 retries on a fresh snapshot
//! (S3 §3.2 "Both orders"). [`create_mailbox`] is for hire.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::hooks::controls;
use crate::mail::hints::{self, Hint};
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

pub const CONTROLS: &[&str] = &["Q-E1.rehire_no_head_lock", "Q-E1.delete_no_head_lock", "Q-E1.fold_whole_box_no_lock"];

pub const CREATE_MAILBOX_SQL: &str = "INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) \
    SELECT $1, $2, 'agent', $3, coalesce(max(incarnation), 0) + 1, 'open' FROM mailboxes \
    WHERE org_id = $1 AND owner_kind = 'agent' AND owner_id = $3 RETURNING incarnation";
pub const CREATE_USER_MAILBOX_SQL: &str = "INSERT INTO mailboxes (org_id, mailbox_id, owner_kind, owner_id, incarnation, state) \
    VALUES ($1, $2, 'user', NULL, 1, 'open')";
pub const OPEN_MAILBOX_SQL: &str = "SELECT mailbox_id FROM mailboxes \
    WHERE org_id = $1 AND owner_kind = 'agent' AND owner_id = $2 AND state = 'open' ORDER BY incarnation DESC LIMIT 1";
pub const HEAD_SHARE_SQL: &str = "SELECT recv_seq, state FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2 FOR SHARE";
pub const HEAD_UPDATE_SQL: &str = "SELECT recv_seq, state FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2 FOR UPDATE";
pub const HEAD_BUMP_SQL: &str = "UPDATE mailboxes SET version = version + 1 WHERE org_id = $1 AND mailbox_id = $2";
pub const HEAD_CLOSE_SQL: &str = "UPDATE mailboxes SET state = 'closed', version = version + 1 WHERE org_id = $1 AND mailbox_id = $2";
pub const PENDING_WAKING_SQL: &str = "SELECT original_message_id FROM mailbox_messages \
    WHERE org_id = $1 AND mailbox_id = $2 AND state = 'pending' AND class = 'message' ORDER BY recv_ord";
pub const WAKE_INTENT_SQL: &str = "INSERT INTO outgoing_intents (org_id, intent_id, kind, source_ref, dest_ref, due_at, created_at) \
    VALUES ($1, $2, 'wake', $3, $4, $5, $5) ON CONFLICT ON CONSTRAINT outgoing_intents_unique_effect DO NOTHING RETURNING intent_id";
pub const ERASE_SQL: &str = "DELETE FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND state <> 'refused'";
pub const LIST_BOX_SQL: &str = "SELECT original_message_id FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND state <> 'refused'";
pub const ERASE_ONE_SQL: &str = "DELETE FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3";
pub const NOTICE_BOX_SQL: &str = "SELECT m.original_message_id, m.recv_ord, m.kind, coalesce(s.body, ''), m.sent_at, m.fingerprint, m.received_at, m.source_kind, m.source_id \
    FROM mailbox_messages m LEFT JOIN mail_sent s ON s.org_id = m.org_id AND s.message_id = m.original_message_id \
    WHERE m.org_id = $1 AND m.mailbox_id = $2 AND m.class = 'notice' AND m.state = 'pending' ORDER BY m.recv_ord";
pub const UNORDER_SQL: &str = "UPDATE mailbox_messages SET recv_ord = NULL WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3";
pub const FOLD_ROW_SQL: &str = "UPDATE mailbox_messages SET state = 'folded', folded_into = $4 WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3";
pub const REORDER_SQL: &str = "UPDATE mailbox_messages SET recv_ord = $4 WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3";
pub const INSERT_DIGEST_SQL: &str = "INSERT INTO mailbox_messages \
    (org_id, mailbox_id, original_message_id, recv_ord, fingerprint, state, is_notice, received_at, class, kind, source_kind, source_id, sent_at, digest) \
    VALUES ($1, $2, $3, $4, 'digest', 'pending', true, $5, 'notice', 'context.notice_digest', 'system', $6, $5, $7)";
/// Q-E1 (c) control: the whole-box replacement deletes every pending notice
/// of the box, including one received after the fold's read.
pub const DELETE_BOX_SQL: &str = "DELETE FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND class = 'notice' AND state = 'pending'";
pub const REINSERT_SQL: &str = "INSERT INTO mailbox_messages \
    (org_id, mailbox_id, original_message_id, recv_ord, fingerprint, state, is_notice, received_at, class, kind, source_kind, source_id, sent_at) \
    VALUES ($1, $2, $3, $4, $5, 'pending', true, $6, 'notice', $7, $8, $9, $10)";

fn defect(msg: &str) -> DbError {
    DbError::Sql { code: "XX000".into(), constraint: None, message: msg.into() }
}

/// Hire: create the seat's mailbox (a new incarnation of it if one existed).
/// Returns `(mailbox_id, incarnation)`.
pub async fn create_mailbox<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<(Uuid, i64), DbError> {
    let id = Uuid::new_v4();
    let rows = tx.exec("mailbox.create", CREATE_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Uuid(principal)]).await?;
    let inc = rows.first().and_then(|r| r.first()).and_then(Val::as_int).ok_or_else(|| defect("mailbox insert returned no incarnation"))?;
    Ok((id, inc))
}

/// Organization setup: the one user mailbox (no head ordering, E1.4).
pub async fn create_user_mailbox<S: Session>(tx: &mut Tx<'_, S>, org: Uuid) -> Result<Uuid, DbError> {
    let id = Uuid::new_v4();
    tx.exec("mailbox.create_user", CREATE_USER_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
    Ok(id)
}

async fn open_mailbox<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<Option<Uuid>, DbError> {
    let rows = tx.exec("mailbox.open", OPEN_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(principal)]).await?;
    Ok(rows.first().and_then(|r| r.first()).and_then(Val::as_uuid))
}

/// P8 leg (a), rehire: take the seat's head row `FOR SHARE`, THEN read its
/// pending waking mail and record one wake intent per message (unique per
/// message, so a message is driven exactly once however many drivers race).
/// Returns the driven message ids. Call it inside the rehire's island
/// transaction, after the seat is live again.
pub async fn drive_pending<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<Vec<Uuid>, DbError> {
    let Some(mailbox) = open_mailbox(tx, org, principal).await? else { return Ok(Vec::new()) };
    if !controls::fire(&tx.scope(), "Q-E1.rehire_no_head_lock") {
        tx.exec("mailbox.head_share", HEAD_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    }
    let rows = tx.exec("mailbox.pending_waking", PENDING_WAKING_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    let ids: Vec<Uuid> = rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
    if ids.is_empty() {
        return Ok(ids);
    }
    let now = tx.now().await?;
    let mut driven = Vec::new();
    for id in &ids {
        let r = tx.exec("mailbox.wake", WAKE_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(Uuid::new_v4()), Val::Uuid(*id), Val::Uuid(principal), Val::Ts(now)]).await?;
        if !r.is_empty() {
            driven.push(*id);
        }
    }
    if !driven.is_empty() {
        let h = Hint::Runtime { org, principal };
        tx.after_commit(move || hints::emit(h));
    }
    Ok(driven)
}

/// P8 leg (b), delete: take the head row `FOR UPDATE`, erase the mailbox's
/// messages (legacy erases `mail`, `mail_log` and `notices`), close the
/// incarnation and bump the head. A receive that waited behind this finds the
/// mailbox closed and records a terminal refusal fence (never a message in a
/// closed mailbox). Refusal fences already recorded are kept. Returns the
/// number of rows erased.
pub async fn close_mailbox<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<u64, DbError> {
    let Some(mailbox) = open_mailbox(tx, org, principal).await? else { return Ok(0) };
    if controls::fire(&tx.scope(), "Q-E1.delete_no_head_lock") {
        // Unsafe: no head lock and no head update; erase only the rows this
        // snapshot shows, by id.
        let rows = tx.exec("mailbox.list_box", LIST_BOX_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let mut n = 0;
        for r in &rows.0 {
            if let Some(id) = r.first().and_then(Val::as_uuid) {
                tx.exec("mailbox.erase_one", ERASE_ONE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(id)]).await?;
                n += 1;
            }
        }
        // and the head row is neither locked nor updated (no close): at
        // SERIALIZABLE an update of a head changed after the snapshot would
        // raise 40001 and hide the defect this control must show
        return Ok(n);
    }
    tx.exec("mailbox.head_update", HEAD_UPDATE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    let erased = tx.exec("mailbox.erase", "WITH d AS (DELETE FROM mailbox_messages WHERE org_id = $1 AND mailbox_id = $2 AND state <> 'refused' RETURNING 1) SELECT count(*) FROM d", &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    tx.exec("mailbox.close", HEAD_CLOSE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    Ok(erased.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0) as u64)
}

/// The fold's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folded {
    /// Typed notices folded into the digest (0: nothing to fold).
    pub folded: usize,
    pub digest: Option<Uuid>,
}

struct BoxRow {
    id: Uuid,
    ord: Option<i64>,
    kind: String,
    body: String,
    sent_at: Val,
    fingerprint: String,
    received_at: Val,
    source_kind: Val,
    source_id: Val,
}

/// P8 leg (c), the notice fold (`_fold_notices`, `ledger.py:4429`), inside a
/// session-replacing island transaction: take the head row `FOR UPDATE`,
/// THEN read the pending notice box; with at least two typed notices (kind
/// other than the untyped `notice`), group them by kind into ONE
/// `context.notice_digest` row that keeps every member, placed first, then
/// the untyped rows in their original order. Folded rows become `folded`
/// tombstones (their dedupe key keeps fencing a late redelivery). Rows the
/// fold did not read are not touched. The head row is bumped.
pub async fn fold_notices<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, principal: Uuid) -> Result<Folded, DbError> {
    let Some(mailbox) = open_mailbox(tx, org, principal).await? else { return Ok(Folded { folded: 0, digest: None }) };
    let unsafe_whole_box = controls::fire(&tx.scope(), "Q-E1.fold_whole_box_no_lock");
    if !unsafe_whole_box {
        tx.exec("mailbox.head_update", HEAD_UPDATE_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    }
    let rows = tx.exec("mailbox.notice_box", NOTICE_BOX_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    let boxed: Vec<BoxRow> = rows
        .0
        .iter()
        .filter_map(|r| {
            Some(BoxRow {
                id: r.first()?.as_uuid()?,
                ord: r.get(1)?.as_int(),
                kind: r.get(2)?.as_text().unwrap_or("notice").to_string(),
                body: r.get(3)?.as_text().unwrap_or("").to_string(),
                sent_at: r.get(4)?.clone(),
                fingerprint: r.get(5)?.as_text().unwrap_or("").to_string(),
                received_at: r.get(6)?.clone(),
                source_kind: r.get(7)?.clone(),
                source_id: r.get(8)?.clone(),
            })
        })
        .collect();
    let typed: Vec<&BoxRow> = boxed.iter().filter(|b| b.kind != "notice").collect();
    if typed.len() < 2 {
        return Ok(Folded { folded: 0, digest: None });
    }
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for b in &typed {
        let member = json!({"id": b.id.to_string(), "kind": b.kind, "body": b.body, "at": b.sent_at.as_ts()});
        match groups.iter_mut().find(|g| g.0 == b.kind) {
            Some(g) => g.1.push(member),
            None => groups.push((b.kind.clone(), vec![member])),
        }
    }
    let digest_body = json!({"groups": groups.iter().map(|(k, m)| json!({"variant": k, "members": m})).collect::<Vec<_>>()});
    let untyped: Vec<&BoxRow> = boxed.iter().filter(|b| b.kind == "notice").collect();
    let mut ords: Vec<i64> = boxed.iter().filter_map(|b| b.ord).collect();
    ords.sort_unstable();
    let now = tx.now().await?;
    let digest = Uuid::new_v4();
    if unsafe_whole_box {
        // Unsafe control: delete every row of the box, then insert the list
        // computed from the earlier read (loses a notice received between).
        tx.exec("mailbox.delete_box", DELETE_BOX_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        tx.exec("mailbox.digest", INSERT_DIGEST_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(digest), Val::opt_int(ords.first().copied()), Val::Ts(now), Val::Uuid(Uuid::nil()), Val::Json(digest_body)]).await?;
        for (i, u) in untyped.iter().enumerate() {
            tx.exec(
                "mailbox.reinsert",
                REINSERT_SQL,
                &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(u.id), Val::opt_int(ords.get(i + 1).copied()), Val::text(u.fingerprint.clone()), u.received_at.clone(), Val::text(u.kind.clone()), u.source_kind.clone(), u.source_id.clone(), u.sent_at.clone()],
            )
            .await?;
        }
        return Ok(Folded { folded: typed.len(), digest: Some(digest) });
    }
    // free every ordinal the fold read, then write the new order into them:
    // digest first, then the untyped rows in their original order
    for b in &boxed {
        tx.exec("mailbox.unorder", UNORDER_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(b.id)]).await?;
    }
    for b in &typed {
        tx.exec("mailbox.fold_row", FOLD_ROW_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(b.id), Val::Uuid(digest)]).await?;
    }
    tx.exec("mailbox.digest", INSERT_DIGEST_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(digest), Val::opt_int(ords.first().copied()), Val::Ts(now), Val::Uuid(Uuid::nil()), Val::Json(digest_body)]).await?;
    for (i, u) in untyped.iter().enumerate() {
        tx.exec("mailbox.reorder", REORDER_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(u.id), Val::opt_int(ords.get(i + 1).copied())]).await?;
    }
    tx.exec("mailbox.head_bump", HEAD_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
    Ok(Folded { folded: typed.len(), digest: Some(digest) })
}
