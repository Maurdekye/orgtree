//! `quick-staff.select` and its compensating undo (S3 §4.10, E6, E7,
//! E-D12).
//!
//! **The commit** is one command transaction whose operation key is the
//! request id under `(item, request_id)` (`KeyNamespace::QuickStaff`),
//! claimed FIRST by the executor (E7): a duplicate commit waits on the
//! uncommitted claim and then replays the same selection, or is refused as a
//! conflict for a different one. The isolation follows the selection's mode,
//! which the client states and the commit re-checks: **request** mode runs
//! READ COMMITTED (an item update and a request mail), the **immediate**
//! modes run the staff transaction of §4.8 in the SERIALIZABLE island. A
//! selection whose mode no longer matches the item's context is refused
//! with legacy's words whatever the isolation.
//!
//! Inside the transaction: the item's head row `FOR NO KEY UPDATE`
//! (backlogged, not archived); the owner's authority-epoch row `FOR SHARE`,
//! because its liveness decides the fallback to top level; then the mode's
//! writes. The app settings that choose the mode (`quick_staff_behavior`,
//! `quick_staff_request_accounts`) are external observations made before the
//! transaction and passed in (recorded in the contact trace as arguments).
//!
//! **The undo** ([`QuickUndo`]) is E6's compensating command, READ
//! COMMITTED: a compare-and-set on the item's revision AND the forward
//! receipt still being `applied`; a DIRECT restore of the captured status and
//! owner (not through the user-facing progress update, so an empty progress
//! list is restored rather than refused, E-D12); the forward receipt marked
//! `compensated`, never deleted; and a retraction intent for the request
//! mail (WS5's `record_retraction`). Any later writer wins: the undo then
//! writes nothing.
//!
//! **P03 narrowings (disclosed):** the options / options-refresh / preview
//! reads and the staffing-options snapshot (machine state) are not here; the
//! tier/effort/account CHOICE checks against that snapshot
//! (`quickstaff.check_choice`) are the adapter's (external observation); the
//! progress lists are not in the P03 docket encoding, so the "Staff the
//! ticket." next-step line and the lists' capture are recorded as empty; the
//! item is addressed by its id (the key namespace needs it before the
//! transaction; the adapter maps the route's item to its immutable id); the
//! previous assignee's notice is a System notice (legacy: a notice from the
//! user); a selected effort is not written (the P03 hire does not take the
//! `set_scope` fields yet).

use std::collections::BTreeSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::hire::{stable_id, system_notice, HireSpec};
use super::staff::{staff_in, ItemSpec, StaffSpec};
use super::STAFFING;
use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Refusal};
use crate::hooks::controls;
use crate::island::{self, Lock};
use crate::sent::{self, Destination, MailSource, SendError, SendRequest};
use crate::session::Session;
use crate::value::Val;
use crate::work;
use crate::Tx;

/// Request mode (and the undo): READ COMMITTED outside the island.
pub static QUICK_STAFF: Family = Family { name: "quick_staff", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const ITEM_HEAD_SQL: &str = "SELECT rev, status, owner_id, archived_at, name, title FROM work_items WHERE org_id = $1 AND item_id = $2 FOR NO KEY UPDATE";
pub const OWNER_SCOPE_SQL: &str = "SELECT tools, folders, visibility FROM scope_rows WHERE org_id = $1 AND principal_id = $2";
pub const FORWARD_RECEIPT_SQL: &str = "SELECT state, result FROM operation_receipts WHERE org_id = $1 AND ns_kind = 'quick_staff' AND ns_id = $2 AND op_key = $3 FOR NO KEY UPDATE";
pub const COMPENSATE_SQL: &str = "UPDATE operation_receipts SET state = 'compensated', decided_at = $4 \
    WHERE org_id = $1 AND ns_kind = 'quick_staff' AND ns_id = $2 AND op_key = $3 AND state = 'applied'";
pub const RESTORE_HEAD_SQL: &str = "UPDATE work_items SET rev = rev + 1, status = $4, owner_id = $5, updated_at = $6 \
    WHERE org_id = $1 AND item_id = $2 AND rev = $3 RETURNING rev";

/// What the client selected (legacy `QuickStaffSelection` minus the id).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selection {
    pub mode: String,
    pub configured_mode: String,
    /// The owner's NAME as the menu showed it (`None` = no owner).
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
}

/// The external observations the adapter makes before the transaction.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    /// `quick_staff_behavior`: request | under_assignee | top_level.
    pub behavior: String,
    /// `quick_staff_request_accounts`.
    #[serde(default)]
    pub request_accounts: bool,
    /// The org's `default_top_grant` (legacy default 50).
    #[serde(default = "default_top_grant")]
    pub default_top_grant: i64,
}

fn default_top_grant() -> i64 {
    50
}

/// Everything the undo needs, captured before the first mutation and
/// retained in the forward receipt (S3 §4.10).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoRecord {
    pub status: String,
    pub owner: Option<Uuid>,
    pub done: Vec<String>,
    pub next: Vec<String>,
    /// The revision the forward commit produced: the only one the undo may rewrite.
    pub rev: i64,
    pub mail: Uuid,
    pub mailbox: Uuid,
    pub node: Uuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuickResult {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mail: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_notified: Option<String>,
    /// Request mode only: what the compensating undo restores.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo: Option<UndoRecord>,
}

fn refuse<T>(msg: &str) -> Result<Result<T, Refusal>, CmdError> {
    Ok(Err(Refusal::new("invalid", msg)))
}

/// `quick-staff.select` (the commit).
pub struct QuickSelect {
    pub item: Uuid,
    pub selection: Selection,
    pub settings: Settings,
    hint: Mutex<BTreeSet<Uuid>>,
}

impl QuickSelect {
    pub fn new(item: Uuid, selection: Selection, settings: Settings) -> QuickSelect {
        QuickSelect { item, selection, settings, hint: Mutex::new(BTreeSet::new()) }
    }
    /// The canonical fingerprint of a selection (E7: same key + same
    /// fingerprint replays; a different one conflicts).
    pub fn fingerprint(s: &Selection) -> String {
        serde_json::to_string(s).unwrap_or_default()
    }
}

impl Command for QuickSelect {
    type Output = QuickResult;
    fn family(&self) -> &'static Family {
        if self.selection.mode == "request" {
            &QUICK_STAFF
        } else {
            &STAFFING
        }
    }
    fn verb(&self) -> &'static str {
        "select"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &QuickResult) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<QuickResult>, CmdError> {
        match select_in(tx, b, self).await {
            Ok(Ok(r)) => Ok(Decided::Applied(r)),
            Ok(Err(r)) | Err(CmdError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e),
        }
    }
}

async fn select_in<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, q: &QuickSelect) -> Result<Result<QuickResult, Refusal>, CmdError> {
    let org = b.op.org;
    // Q-QS1's control: the context read BEFORE the item head is locked
    // (legacy's order before its DOC_LOCK), and then trusted.
    let early = controls::fire(&tx.scope(), "Q-QS1.context_before_lock");
    let ctx_sql = if early { "SELECT rev, status, owner_id, archived_at, name, title FROM work_items WHERE org_id = $1 AND item_id = $2" } else { ITEM_HEAD_SQL };
    let rows = tx.exec("quick_staff.item_head", ctx_sql, &[Val::Uuid(org), Val::Uuid(q.item)]).await?;
    let Some(r) = rows.first() else { return Ok(Err(Refusal::new("no_such_item", "no such work item"))) };
    let rev = r.first().and_then(Val::as_int).unwrap_or(0);
    let status = r.get(1).and_then(Val::as_text).unwrap_or("").to_string();
    let owner = r.get(2).and_then(Val::as_uuid);
    let archived = r.get(3).is_some_and(|v| !v.is_null());
    let item_name = r.get(4).and_then(Val::as_text).unwrap_or("").to_string();
    let title = r.get(5).and_then(Val::as_text).unwrap_or("").to_string();
    if early {
        tx.pause("context_read").await?;
        tx.exec("quick_staff.item_head_late", ITEM_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(q.item)]).await?;
    }
    if archived || status != "backlogged" {
        return refuse("Quick staff is available only for backlogged tickets. Reopen the menu.");
    }
    // the owner's liveness decides the fallback (its epoch row FOR SHARE)
    let (owner_live, owner_name) = match owner {
        Some(o) => {
            let ep = island::lock_epoch(tx, "quick_staff.owner_epoch", org, o, Lock::Share).await?;
            (ep.is_some_and(|e| e.live()), island::name_of(tx, org, o).await?)
        }
        None => (false, None),
    };
    let configured = q.settings.behavior.clone();
    let fallback = configured != "top_level" && !owner_live;
    let mode = if fallback { "top_level".to_string() } else { configured.clone() };
    let s = &q.selection;
    if s.mode != mode || s.configured_mode != configured || s.owner != owner_name {
        return refuse("The staffing behavior or assignee changed. Reopen the ticket menu to see where staffing will happen.");
    }
    if s.effort.is_some() && s.tier.is_none() {
        return refuse("Select a model before choosing an effort.");
    }
    if mode != "request" && s.tier.is_none() {
        return refuse("Immediate staffing requires a model. Reopen Staff… and select one.");
    }
    if s.account.is_some() && s.tier.is_none() {
        return refuse("Select a model before choosing an account.");
    }
    if s.account.is_some() && mode == "request" && !q.settings.request_accounts {
        return refuse("Request staffing cannot pin an account — the assignee makes that choice when it hires.");
    }
    if mode == "request" {
        let Some(o) = owner else { return refuse("The staffing behavior or assignee changed. Reopen the ticket menu to see where staffing will happen.") };
        let oname = owner_name.clone().unwrap_or_default();
        let mut text = format!("Please staff the docket ticket {item_name} ({title}).");
        if let Some(t) = &s.tier {
            text.push_str(&format!(" Suggested model: {t}."));
        }
        if let Some(e) = &s.effort {
            text.push_str(&format!(" Suggested effort: {e}."));
        }
        if let Some(a) = &s.account {
            text.push_str(&format!(" Suggested account: {a}."));
        }
        let now = tx.now().await?;
        let new_rev = tx
            .exec("work.update_head", work::UPDATE_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(q.item), Val::text("open"), Val::Uuid(o), Val::Null, Val::Ts(now)])
            .await?
            .first()
            .and_then(|r| r.first())
            .and_then(Val::as_int)
            .ok_or_else(|| CmdError::Defect("head update returned no rev".into()))?;
        let body = json!({"rev": new_rev, "status": "open", "owner": o, "owner_name": oname, "archived": false, "quick_staff": "request"});
        tx.exec("work.insert_version", work::INSERT_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(q.item), Val::Int(new_rev), Val::text("update"), Val::Json(body), Val::Null, Val::Ts(now)]).await?;
        let mb = tx.exec("quick_staff.owner_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(o)]).await?;
        let row = mb.first().ok_or_else(|| CmdError::Defect("owner without an open mailbox".into()))?;
        let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("mailbox id".into()))?;
        let inc = row.get(1).and_then(Val::as_int).unwrap_or(1);
        let mid = stable_id(&format!("quick|{}|{}|{}", org, q.item, b.op.key));
        let req = SendRequest::message(MailSource::User, Destination::Resolved { principal: o, mailbox, mailbox_incarnation: inc }, mid, "request", text, format!("quick:{mid}"));
        match sent::record_sent(tx, &req).await {
            Ok(_) => {}
            Err(SendError::Refused(r)) => return Ok(Err(r)),
            Err(e) => return Err(e.into()),
        }
        let msg = format!(
            "Staffing requested from {oname}{}; ticket moved to Open.",
            s.account.as_ref().map(|a| format!(" (suggested account {a})")).unwrap_or_default()
        );
        return Ok(Ok(QuickResult {
            message: msg,
            requested_from: Some(oname),
            mail: Some(mid),
            node: None,
            item: Some(item_name),
            assignee_notified: None,
            undo: Some(UndoRecord { status, owner: Some(o), done: Vec::new(), next: Vec::new(), rev: new_rev, mail: mid, mailbox, node: o }),
        }));
    }
    // ---- immediate modes: the staff transaction of §4.8
    let top = mode == "top_level";
    let mut seat = HireSpec {
        target: if top { None } else { owner_name.clone() },
        name: island::slugify(&title).map(|x| x.chars().take(80).collect::<String>().trim_end_matches('-').to_string()).unwrap_or_else(|_| "agent".into()),
        tier: s.tier.clone(),
        grant: Some(json!(if top { q.settings.default_top_grant } else { 0 })),
        charter: Some(format!("Own the docket item {item_name}: {title}. Read its full description and complete its requirements. Keep the docket current.")),
        ..HireSpec::default()
    };
    if s.account.is_some() {
        seat.account.display = s.account.clone();
    }
    if !top {
        if let Some(o) = owner {
            if let Some(r) = tx.exec("quick_staff.owner_scope", OWNER_SCOPE_SQL, &[Val::Uuid(org), Val::Uuid(o)]).await?.first() {
                seat.tools = r.first().and_then(Val::as_json).cloned();
                seat.add_dirs = r.get(1).and_then(Val::as_json).cloned();
                seat.org_visibility = r.get(2).and_then(Val::as_text).map(str::to_string);
            }
        }
    }
    let spec = StaffSpec { seat, item: ItemSpec { action: Some("update".into()), slug: Some(item_name.clone()), status: Some("open".into()), ..ItemSpec::default() }, ..StaffSpec::default() };
    let staffed = match staff_in(tx, b, &spec, &q.hint).await? {
        Ok(x) => x,
        Err(r) => return Ok(Err(r)),
    };
    let mut assignee_notified = None;
    if mode == "under_assignee" {
        if let (Some(o), Some(on)) = (owner, owner_name.clone()) {
            let mut notice = format!(
                "[QUICK STAFFING · {item_name} \"{}\"]\nThe user initiated immediate staffing beneath you, and {} is now staffed under you. Selected model: {}.",
                title.chars().take(80).collect::<String>(),
                staffed.node,
                s.tier.clone().unwrap_or_default()
            );
            if let Some(e) = &s.effort {
                notice.push_str(&format!(" Selected effort: {e}."));
            }
            if let Some(a) = &s.account {
                notice.push_str(&format!(" Selected account: {a}."));
            }
            system_notice(tx, org, o, "quick_staff.notice", &notice).await?;
            assignee_notified = Some(on);
        }
    }
    let message = format!(
        "Staffed {} {}{}; ticket moved to Open.",
        staffed.node,
        if top { "at top level".to_string() } else { format!("under {}", owner_name.clone().unwrap_or_default()) },
        s.account.as_ref().map(|a| format!(" on {a}")).unwrap_or_default()
    );
    let _ = rev;
    Ok(Ok(QuickResult { message, requested_from: None, mail: None, node: Some(staffed.node), item: Some(staffed.item), assignee_notified, undo: None }))
}

/// The compensating undo (E6): request mode, after the kickoff was refused.
pub struct QuickUndo {
    pub item: Uuid,
    /// The FORWARD commit's request id (its receipt key).
    pub request_id: String,
}

/// `restored`: the item was put back; false = a later writer won (legacy's
/// no-clobber rule), nothing written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Undone {
    pub restored: bool,
}

impl Command for QuickUndo {
    type Output = Undone;
    fn family(&self) -> &'static Family {
        &QUICK_STAFF
    }
    fn verb(&self) -> &'static str {
        "undo"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Undone) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Undone>, CmdError> {
        let org = b.op.org;
        let no_cas = controls::fire(&tx.scope(), "Q-QS3.undo_without_cas");
        // the item head first (C3), then the forward receipt
        let head = tx.exec("quick_staff.item_head", ITEM_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(self.item)]).await?;
        let Some(h) = head.first() else { return Ok(Decided::Applied(Undone { restored: false })) };
        let cur_rev = h.first().and_then(Val::as_int).unwrap_or(0);
        let rc = tx.exec("quick_staff.forward_receipt", FORWARD_RECEIPT_SQL, &[Val::Uuid(org), Val::Uuid(self.item), Val::text(self.request_id.clone())]).await?;
        let Some(r) = rc.first() else { return Ok(Decided::Applied(Undone { restored: false })) };
        let state = r.first().and_then(Val::as_text).unwrap_or("").to_string();
        let Some(undo) = r.get(1).and_then(Val::as_json).and_then(|v| v.get("undo")).and_then(|u| serde_json::from_value::<UndoRecord>(u.clone()).ok()) else {
            return Ok(Decided::Applied(Undone { restored: false }));
        };
        if !no_cas && (state != "applied" || cur_rev != undo.rev) {
            return Ok(Decided::Applied(Undone { restored: false }));
        }
        tx.pause("after_cas_read").await?;
        if controls::fire(&tx.scope(), "Q-QS4.undo_via_progress_update") {
            // Q-QS4's control: the undo goes through the user-facing progress
            // update (legacy `work_update`), whose "both lists empty" refusal
            // escapes as a defect (legacy's 500) and nothing is undone.
            if undo.done.is_empty() && undo.next.is_empty() {
                return Err(CmdError::Defect("work_update refused: both progress lists empty (the legacy 500)".into()));
            }
        }
        let now = tx.now().await?;
        let expected = if no_cas { cur_rev } else { undo.rev };
        let Some(new_rev) = tx
            .exec("quick_staff.restore_head", RESTORE_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(self.item), Val::Int(expected), Val::text(undo.status.clone()), Val::opt_uuid(undo.owner), Val::Ts(now)])
            .await?
            .first()
            .and_then(|r| r.first())
            .and_then(Val::as_int)
        else {
            return Ok(Decided::Applied(Undone { restored: false }));
        };
        let body = json!({"rev": new_rev, "status": undo.status, "owner": undo.owner, "restored_from": undo.rev, "done_so_far": undo.done, "working_on_next": undo.next, "quick_staff": "undo"});
        tx.exec("work.insert_version", work::INSERT_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(self.item), Val::Int(new_rev), Val::text("restore"), Val::Json(body), Val::Null, Val::Ts(now)]).await?;
        tx.exec("quick_staff.compensate", COMPENSATE_SQL, &[Val::Uuid(org), Val::Uuid(self.item), Val::text(self.request_id.clone()), Val::Ts(now)]).await?;
        match sent::record_retraction(tx, undo.mailbox, undo.mail).await {
            Ok(_) => {}
            Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
            Err(e) => return Err(e.into()),
        }
        Ok(Decided::Applied(Undone { restored: true }))
    }
}

/// DECLARED-CONTACTS for the quick-staff verbs.
pub fn declared() -> Value {
    use crate::island::declared::{entry, receipts, rel, R, RW, SHARE, W};
    let request = entry(
        vec![
            receipts(),
            ("work_items", rel(&["read", "for_no_key_update", "write"], true)),
            ("work_item_versions", rel(W, true)),
            ("authority_epoch", rel(SHARE, false)),
            ("agent_names", rel(R, false)),
            ("mailboxes", rel(R, true)),
            ("mail_sent", rel(RW, true)),
            ("outgoing_intents", rel(W, true)),
            ("mail_pair_highwater", rel(R, false)),
        ],
        Some("quick-staff.select"),
        "engine/native/store/src/staffing/quick.rs select_in (S3 §4.10, E7)",
    );
    let undo = entry(
        vec![
            receipts(),
            ("work_items", rel(&["read", "for_no_key_update", "write"], true)),
            ("work_item_versions", rel(W, false)),
            ("outgoing_intents", rel(W, false)),
            ("mailbox_messages", rel(R, false)),
        ],
        Some("quick-staff.select"),
        "engine/native/store/src/staffing/quick.rs QuickUndo (S3 §4.10, E6, E-D12)",
    );
    let mut m = serde_json::Map::new();
    m.insert("quick_staff.select".into(), request);
    m.insert("quick_staff.undo".into(), undo);
    Value::Object(m)
}
