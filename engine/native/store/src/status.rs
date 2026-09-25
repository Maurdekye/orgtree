//! `status.report` (S3 §4.1, WS4): the caller's status row and, for exactly
//! `done` or `blocked` with a parent, one status message to the parent
//! through the Sent interface (E1). One source transaction, READ COMMITTED.
//!
//! * Anchors: the caller's authority-epoch row `FOR SHARE` (live, current
//!   generation, not halted) and the killswitch row `FOR SHARE`
//!   ([`crate::mail::doors::anchor_agent_caller`]). A refused caller commits
//!   nothing (E-D5).
//! * The status row ([`status_rows`], migration 0200): a narrow per-seat row
//!   that is neither the anchor nor the runtime row. Locked first, then the
//!   attempt clock is read (C7), then updated. Stored values follow legacy
//!   (`api.py` `orgtree_status`): `done` is stored as `idle` and answered as
//!   `done`; `working` sets `working_activity_at`; every other value clears
//!   it; nothing is validated or capped.
//! * The report: the caller's edge row `FOR SHARE` gives the parent, so a
//!   move of the caller either commits first (the report goes to the new
//!   parent) or waits for the report. The parent's mailbox row is only read
//!   (the source never locks a receiver head, F3). The Sent row is an agent
//!   `message` from the caller with its pair sequence and no grant (the parent
//!   is the caller's superior). A top-level caller sends nothing.
//!
//! Reports to different parents share no row; to one parent they queue only
//! at the receiver's head (WS5's receive transaction).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Principal, Refusal};
use crate::hooks::controls;
use crate::mail::doors::{anchor_agent_caller, CALLER_ANCHOR_SQL, KILLSWITCH_SQL};
use crate::sent::{self, Destination, MailSource, SendError, SendRequest};
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub static STATUS: Family = Family { name: "status", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Unsafe controls compiled into this family (static list for the handshake).
pub const CONTROLS: &[&str] = &["Q-S1.org_wide_mail_row", "Q-S2.parent_without_share", "Q-S3.no_anchor"];

/// Statement labels (each gives `status.report.stmt.<label>.before/.after`).
pub const LABELS: &[&str] = &[
    "mail.anchor_caller",
    "mail.anchor_killswitch",
    "status.anchor_unlocked",
    "status.lock_row",
    "status.insert_row",
    "exec.now",
    "status.update_row",
    "status.parent",
    "status.parent_unlocked",
    "status.parent_name",
    "status.parent_mailbox",
    "status.q_s1_org_row",
];

/// Family-specific pause points (beyond the generic ones and the statements).
pub const POINTS: &[&str] = &["status.report.after_parent_read"];

pub const LOCK_ROW_SQL: &str = "SELECT version FROM status_rows WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
pub const INSERT_ROW_SQL: &str = "INSERT INTO status_rows (org_id, principal_id) VALUES ($1, $2) \
    ON CONFLICT ON CONSTRAINT status_rows_pk DO NOTHING";
/// `at` is the attempt clock rendered as legacy's ISO-8601 UTC string.
pub const UPDATE_ROW_SQL: &str = "UPDATE status_rows SET \
    last_status = jsonb_build_object('status', $3::text, 'summary', $4::text, \
        'at', to_char($5::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"')), \
    working_activity_at = CASE WHEN $3::text = 'working' THEN $5::timestamptz ELSE NULL END, \
    version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";
pub const PARENT_SHARE_SQL: &str = sent::EDGE_SHARE_SQL;
pub const PARENT_SQL: &str = sent::EDGE_SQL;
pub const NAME_SQL: &str = "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2";
pub const UNLOCKED_ANCHOR_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
/// Q-S1's unsafe control: every report writes one organization-wide row, as
/// legacy's whole-document mail sections do.
pub const ORG_ROW_WRITE_SQL: &str = "UPDATE organizations SET kiosk = kiosk WHERE org_id = $1";

/// Legacy's answer for a top-level caller (`api.py` `orgtree_status`).
pub const TOP_LEVEL_REPORTED_TO: &str = "status chip only — report your actual results to the user via orgtree_message";

/// The door's answer. Legacy result keys: `recorded` always; for done/blocked
/// with a parent `reported_to`, `delivered`, `id`, `warnings`; for a
/// top-level caller only `reported_to` (the chip text).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusResult {
    pub recorded: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

/// `orgtree_status {status, summary}` as the bound agent. `message_id` is
/// minted once per request by the door, so every attempt reuses it.
pub struct StatusReport {
    pub status: String,
    pub summary: String,
    pub message_id: Uuid,
}

impl StatusReport {
    fn caller(b: &Binding) -> Result<(Uuid, i64), CmdError> {
        match b.principal {
            Principal::Agent { id, generation } => Ok((id, generation)),
            _ => Err(CmdError::Defect("status.report needs an agent principal".into())),
        }
    }

    /// Exactly `done` or `blocked`, case-sensitive (legacy).
    pub fn reports(&self) -> bool {
        self.status == "done" || self.status == "blocked"
    }

    /// Legacy's stored value: `done` is stored as `idle`.
    pub fn stored(&self) -> &str {
        if self.status == "done" {
            "idle"
        } else {
            &self.status
        }
    }

    /// The report body is the event's rendering, `[DONE] summary`.
    pub fn body(&self) -> String {
        format!("[{}] {}", self.status.to_uppercase(), self.summary)
    }
}

fn refused(e: SendError) -> Result<Decided<StatusResult>, CmdError> {
    match e {
        SendError::Refused(r) => Ok(Decided::Refused(r)),
        e => Err(e.into()),
    }
}

impl Command for StatusReport {
    type Output = StatusResult;
    fn family(&self) -> &'static Family {
        &STATUS
    }
    fn verb(&self) -> &'static str {
        "report"
    }

    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let (id, generation) = Self::caller(b)?;
        let org = b.op.org;
        // Q-S3 unsafe control: the caller's liveness read WITHOUT the anchor, so
        // a retire or halt committed after this read does not wait for us.
        if controls::fire(&tx.scope(), "Q-S3.no_anchor") {
            let rows = tx.exec("status.anchor_unlocked", UNLOCKED_ANCHOR_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
            let ok = rows.first().is_some_and(|r| {
                r.first().and_then(Val::as_text) == Some("live") && r.get(1).and_then(Val::as_int) == Some(generation) && r.get(2) != Some(&Val::Bool(true))
            });
            if !ok {
                return Err(CmdError::Refused(Refusal::new("not_live", "the caller is not live")));
            }
            let ks = tx.exec("mail.anchor_killswitch", KILLSWITCH_SQL, &[Val::Uuid(org)]).await?;
            if ks.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
                return Err(CmdError::Refused(Refusal::new("killswitch", "the organization's killswitch is engaged")));
            }
            return Ok(());
        }
        let _ = CALLER_ANCHOR_SQL;
        if let Some(r) = anchor_agent_caller(tx, org, id, generation).await? {
            return Err(CmdError::Refused(r));
        }
        Ok(())
    }

    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &StatusResult) -> Result<bool, CmdError> {
        // A replay goes to the same immutable principal (E7 namespace).
        Ok(true)
    }

    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<StatusResult>, CmdError> {
        let org = b.op.org;
        let (caller, _) = Self::caller(b)?;
        let key = [Val::Uuid(org), Val::Uuid(caller)];

        // The caller's own mutable row first, then the attempt clock (C7).
        if tx.exec("status.lock_row", LOCK_ROW_SQL, &key).await?.is_empty() {
            tx.exec("status.insert_row", INSERT_ROW_SQL, &key).await?;
            tx.exec("status.lock_row", LOCK_ROW_SQL, &key).await?;
        }
        let now = tx.now().await?;
        tx.exec(
            "status.update_row",
            UPDATE_ROW_SQL,
            &[Val::Uuid(org), Val::Uuid(caller), Val::text(self.stored()), Val::text(self.summary.clone()), Val::Ts(now)],
        )
        .await?;

        let mut result = StatusResult { recorded: self.status.clone(), reported_to: None, delivered: None, id: None, warnings: None };
        if !self.reports() {
            return Ok(Decided::Applied(result));
        }

        // Q-S1 unsafe control: the report writes one organization-wide row,
        // as legacy's document-wide mail sections do.
        if controls::fire(&tx.scope(), "Q-S1.org_wide_mail_row") {
            tx.exec("status.q_s1_org_row", ORG_ROW_WRITE_SQL, &[Val::Uuid(org)]).await?;
        }

        // The parent, from the caller's edge row FOR SHARE (Q-S2's control
        // reads it without the lock).
        let rows = if controls::fire(&tx.scope(), "Q-S2.parent_without_share") {
            tx.exec("status.parent_unlocked", PARENT_SQL, &key).await?
        } else {
            tx.exec("status.parent", PARENT_SHARE_SQL, &key).await?
        };
        tx.pause("after_parent_read").await?;
        let parent = rows.first().and_then(|r| r.first()).and_then(Val::as_uuid);
        let Some(parent) = parent else {
            result.reported_to = Some(TOP_LEVEL_REPORTED_TO.to_string());
            return Ok(Decided::Applied(result));
        };

        let name = tx
            .exec("status.parent_name", NAME_SQL, &[Val::Uuid(org), Val::Uuid(parent)])
            .await?
            .first()
            .and_then(|r| r.first())
            .and_then(|v| v.as_text().map(str::to_string))
            .ok_or_else(|| CmdError::Defect("the parent has no agents row".into()))?;
        let mb = tx.exec("status.parent_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(parent)]).await?;
        let row = mb.first().ok_or_else(|| CmdError::Defect("the parent has no open mailbox".into()))?;
        let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("undecodable mailbox row".into()))?;
        let incarnation = row.get(1).and_then(Val::as_int).unwrap_or(1);
        let dest = Destination::Resolved { principal: parent, mailbox, mailbox_incarnation: incarnation };
        let req = SendRequest::message(
            MailSource::Agent { principal: caller },
            dest,
            self.message_id,
            "status",
            self.body(),
            format!("status.report:{}", self.message_id),
        );
        let rec = match sent::record_sent(tx, &req).await {
            Ok(r) => r,
            Err(e) => return refused(e),
        };
        result.reported_to = Some(name.clone());
        result.delivered = Some(name);
        result.id = Some(rec.message_id);
        result.warnings = Some(Vec::new());
        Ok(Decided::Applied(result))
    }
}

/// DECLARED-CONTACTS for `status.report` (CONTRACT-M1 §5 r4 shape).
pub fn declared() -> Value {
    json!({
        "status.report": {
            "relations": {
                "authority_epoch": {"modes": ["read", "for_share"], "required": true},
                "org_controls": {"modes": ["read", "for_share"], "required": true},
                "status_rows": {"modes": ["read", "for_no_key_update", "write"], "required": true},
                "operation_receipts": {"modes": ["read", "write"], "required": true},
                "topology_edges": {"modes": ["read", "for_share"], "required": false},
                "agents": {"modes": ["read"], "required": false},
                "mailboxes": {"modes": ["read"], "required": false},
                "mail_sent": {"modes": ["read", "write"], "required": false},
                "outgoing_intents": {"modes": ["write"], "required": false}
            },
            "p01_contract": "status.report",
            "source": "S3 §4.1 and E1.1-E1.2; migration 0200 status_rows"
        }
    })
}
