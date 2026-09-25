//! `staffing.staff-create` / `staffing.staff-update` (`orgtree_staff`): the
//! seat and the docket item that ties it to its work, in ONE SERIALIZABLE
//! island transaction (S3 §4.8 "staff docket write" row; v6 "atomic
//! staffing").
//!
//! **The seat first, then the item with that seat as owner** (legacy
//! `_staff_call`), so the item's history holds ONE assignment. The seat is
//! [`super::hire::hire_in`] (hire mode) or WS3b's `lifecycle::rehire::rehire_in`
//! (rehire mode; a live target is legacy's no-op, E-D10 KEEP, and the item
//! is still written). A refusal anywhere — seat or item — rolls back both,
//! and no kickoff or assignment mail becomes visible.
//!
//! **The item (RN7).** Staffing takes the item's head row
//! `FOR NO KEY UPDATE` and bumps its revision, as every docket writer of the
//! item does (C3). A docket write committed after staffing's snapshot makes
//! that lock raise `40001` and the retry continues from it; one that comes
//! second waits and continues from staffing's committed row.
//!
//! **Schedule-grade docket (SLICE-VERBS ruling E1).** The `orgtree_work`
//! card is P05's family; the item half here writes WS4's P03 encoding (the
//! head, the participants, one version row per revision) with WS4's SQL.
//! Not modelled (each a stage-2 D-row): acceptance, dependencies, the
//! progress lists and the generated `staffing_boundary` line, attention,
//! the item's readable-slug derivation (a P03 slug of the title, suffixed
//! `-2`, `-3` on collision). A rehire WITH a `name` (paths A and L) is WS3b's
//! rename work and refuses here with `p03.not_in_slice` until it lands.
//!
//! **Q-ST3's unsafe control** (`Q-ST3.split_transactions`) is
//! [`staff_split`]: the seat and the item in separate transactions.

use std::collections::BTreeSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::hire::{self, stable_id, system_notice, Door, HireSpec};
use super::STAFFING;
use crate::exec::{Binding, CmdError, Command, Decided, ExecError, Executor, Family, Outcome, Refusal};
use crate::hooks::controls;
use crate::island;
use crate::lifecycle::rehire::rehire_in;
use crate::sent::{self, Destination, MailSource, SendError, SendRequest};
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::work;
use crate::Tx;

pub const ITEM_BY_NAME_SQL: &str = "SELECT item_id FROM active_work_names WHERE org_id = $1 AND name = $2";
pub const WORK_NAME_TAKEN_SQL: &str = "SELECT 1 FROM active_work_names WHERE org_id = $1 AND name = $2";

/// The docket half's arguments (legacy names).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ItemSpec {
    /// `create` | `update`; `None` = inferred (update when `slug` is given).
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// Participant NAMES, resolved inside the transaction (decision 8).
    #[serde(default)]
    pub participants: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StaffSpec {
    /// `hire` | `rehire`; `None` = inferred from `node`.
    #[serde(default)]
    pub staff_mode: Option<String>,
    /// Rehire mode: the agent's NAME.
    #[serde(default)]
    pub node: Option<String>,
    /// Hire mode: the seat's arguments; rehire mode: `tier`, `kickoff`.
    #[serde(default)]
    pub seat: HireSpec,
    #[serde(default)]
    pub item: ItemSpec,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Staffed {
    pub node: String,
    pub principal: Uuid,
    pub item: String,
    pub assigned_to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    pub started: bool,
    pub next_step: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Rehire mode: the live-target no-op (E-D10).
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub already_live: bool,
}

fn refuse<T>(code: &str, msg: impl Into<String>) -> Result<Result<T, Refusal>, CmdError> {
    Ok(Err(Refusal::new(code, msg)))
}

/// Legacy `_staff_mode`.
pub fn staff_mode(s: &StaffSpec) -> Result<&'static str, Refusal> {
    let m = s.staff_mode.as_deref().unwrap_or("").trim().to_lowercase();
    let has_node = s.node.as_deref().is_some_and(|n| !n.trim().is_empty());
    if m.is_empty() {
        return Ok(if has_node { "rehire" } else { "hire" });
    }
    match m.as_str() {
        "rehire" if !has_node => Err(Refusal::new("invalid", "staff_mode 'rehire' needs `node`: the archived agent to bring back")),
        "hire" if has_node => Err(Refusal::new(
            "invalid",
            "staff_mode 'hire' does not take `node` — that names an agent that already exists. Use 'rehire' to bring it back, or drop `node` to seat somebody new",
        )),
        "rehire" => Ok("rehire"),
        "hire" => Ok("hire"),
        _ => Err(Refusal::new("invalid", "staff_mode must be hire or rehire — to assign an item to an agent that is already live, use orgtree_work with action 'assign'")),
    }
}

/// Legacy's action inference and its two refusals.
pub fn item_action(i: &ItemSpec) -> Result<&'static str, Refusal> {
    let has_slug = i.slug.as_deref().is_some_and(|s| !s.trim().is_empty());
    let a = i.action.as_deref().unwrap_or("").trim().to_lowercase();
    let a = if a.is_empty() { if has_slug { "update".to_string() } else { "create".to_string() } } else { a };
    match a.as_str() {
        "create" => Ok("create"),
        "update" if !has_slug => Err(Refusal::new("invalid", "action 'update' needs `slug`: the item to update and hand to this agent")),
        "update" => Ok("update"),
        _ => Err(Refusal::new("invalid", "orgtree_staff writes the docket with action 'create' or 'update' — every other docket action is orgtree_work's")),
    }
}

/// The seat half. Returns (principal, key, warnings, kickoff-started, account, already_live).
async fn seat<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, mode: &str, spec: &StaffSpec, hint: &Mutex<BTreeSet<Uuid>>) -> Result<Result<(Uuid, String, Vec<String>, bool, Option<String>, bool), Refusal>, CmdError> {
    let org = b.op.org;
    if mode == "hire" {
        return Ok(match hire::hire_in(tx, b, Door::Agent, &spec.seat, hint, None).await? {
            Ok(h) => Ok((h.principal, h.node, h.warnings, h.started, h.account, false)),
            Err(r) => Err(r),
        });
    }
    if !spec.seat.name.trim().is_empty() {
        return refuse("p03.not_in_slice", "a rehire with a `name` (paths A and L) is not accepted by the P03 staff door yet");
    }
    let name = spec.node.clone().unwrap_or_default();
    let Some(node) = island::resolve_name(tx, org, name.trim()).await? else {
        return refuse("no_such_node", format!("no such node: '{}'", name.trim()));
    };
    let caller = island::caller_of(b);
    let out = match rehire_in(tx, org, &caller, node, spec.seat.tier.as_deref()).await {
        Ok(o) => o,
        Err(CmdError::Refused(r)) => return Ok(Err(r)),
        Err(e) => return Err(e),
    };
    let mut started = !out.drive.is_empty();
    if let Some(k) = spec.seat.kickoff.as_deref().filter(|k| !k.trim().is_empty()) {
        kickoff(tx, b, node, k, spec.seat.kickoff_kind.as_deref()).await?;
        started = true;
    }
    Ok(Ok((node, name.trim().to_string(), out.warnings, started, None, out.noop)))
}

async fn kickoff<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, to: Uuid, body: &str, kind: Option<&str>) -> Result<(), CmdError> {
    let org = b.op.org;
    let kkind = kind.unwrap_or("request");
    if kkind == "notice" {
        return Err(CmdError::Refused(Refusal::new("invalid", "kickoff_kind 'notice' contradicts a kickoff — a notice is mail that deliberately never wakes anyone, and the whole point of kickoff is to start the hire's first turn. Use 'request' (the default), or drop kickoff and send an orgtree_send_notice afterwards")));
    }
    let mb = tx.exec("staffing.kickoff_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(to)]).await?;
    let row = mb.first().ok_or_else(|| CmdError::Defect("seat without an open mailbox".into()))?;
    let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("mailbox id".into()))?;
    let inc = row.get(1).and_then(Val::as_int).unwrap_or(1);
    let id = stable_id(&format!("kickoff|{}|{}|{}|{}|{to}", org, b.op.ns.kind(), b.op.ns.id(), b.op.key));
    let req = SendRequest::message(source_of(b), Destination::Resolved { principal: to, mailbox, mailbox_incarnation: inc }, id, kkind, body.to_string(), format!("kickoff:{id}"));
    match sent::record_sent(tx, &req).await {
        Ok(_) => Ok(()),
        Err(SendError::Refused(r)) => Err(CmdError::Refused(r)),
        Err(e) => Err(e.into()),
    }
}

fn source_of(b: &Binding) -> MailSource {
    match hire::actor_of(&island::caller_of(b)) {
        crate::funding::Actor::Agent(a) => MailSource::Agent { principal: a },
        crate::funding::Actor::User => MailSource::User,
    }
}

/// The docket half: create or update the item with `seat` as its owner,
/// under the item head's lock (RN7), then the assignment mail to the seat
/// and, for a moved item, the previous owner's `@system` notice.
pub async fn item_in<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, action: &str, spec: &ItemSpec, seat: Uuid, seat_name: &str) -> Result<Result<String, Refusal>, CmdError> {
    let org = b.op.org;
    let by = b.acting.or(b.principal.id());
    let (item_id, item_name, prev_owner) = if action == "create" {
        let title = spec.title.clone().unwrap_or_default();
        if title.trim().is_empty() {
            return refuse("invalid", "a work item needs a title");
        }
        let base = island::slugify(&title).map(|s| s.chars().take(60).collect::<String>()).unwrap_or_else(|_| "item".into());
        let base = base.trim_end_matches('-').to_string();
        let mut name = base.clone();
        let mut i = 2;
        while !tx.exec("staffing.work_name_probe", WORK_NAME_TAKEN_SQL, &[Val::Uuid(org), Val::text(name.clone())]).await?.is_empty() {
            name = format!("{base}-{i}");
            i += 1;
        }
        let item = stable_id(&format!("item|{}|{}|{}|{}", org, b.op.ns.kind(), b.op.ns.id(), b.op.key));
        let status = spec.status.clone().unwrap_or_else(|| "open".into());
        let now = tx.now().await?;
        tx.exec(
            "work.insert_head",
            work::INSERT_HEAD_SQL,
            &[Val::Uuid(org), Val::Uuid(item), Val::text(name.clone()), Val::text(title.trim()), Val::text(spec.kind.clone().unwrap_or_else(|| "code".into())), Val::text(status.clone()), Val::Uuid(seat), Val::opt_uuid(by), Val::Ts(now)],
        )
        .await?;
        tx.exec("work.insert_name", work::INSERT_NAME_SQL, &[Val::Uuid(org), Val::text(name.clone()), Val::Uuid(item)]).await?;
        let mut parts = Vec::new();
        for p in &spec.participants {
            match island::resolve_name(tx, org, p).await? {
                Some(u) => parts.push(u),
                None => return refuse("no_such_node", format!("no such node: '{p}'")),
            }
        }
        parts.sort();
        parts.dedup();
        for p in &parts {
            tx.exec("work.insert_participant", work::INSERT_PARTICIPANT_SQL, &[Val::Uuid(org), Val::Uuid(item), Val::Uuid(*p)]).await?;
        }
        let body = json!({"rev": 1, "status": status, "owner": seat, "owner_name": seat_name, "participants": parts, "archived": false, "staffed_to": seat});
        tx.exec("work.insert_version", work::INSERT_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(item), Val::Int(1), Val::text("create"), Val::Json(body), Val::opt_uuid(by), Val::Ts(now)]).await?;
        (item, name, None)
    } else {
        let slug = spec.slug.clone().unwrap_or_default();
        let Some(item) = tx.exec("staffing.item_by_name", ITEM_BY_NAME_SQL, &[Val::Uuid(org), Val::text(slug.trim())]).await?.first().and_then(|r| r.first()).and_then(Val::as_uuid) else {
            return refuse("no_such_item", format!("no such work item: {}", slug.trim()));
        };
        // RN7 / C3: the head row, then the attempt clock (C7).
        let rows = tx.exec("work.lock_head", work::LOCK_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?;
        let r = rows.first().ok_or_else(|| CmdError::Defect("named item without a head".into()))?;
        let cur_status = r.get(1).and_then(Val::as_text).unwrap_or("").to_string();
        let prev = r.get(2).and_then(Val::as_uuid);
        if r.get(3).is_some_and(|v| !v.is_null()) {
            return refuse("archived", format!("work item {} is archived — reopen it first", slug.trim()));
        }
        tx.pause("item_locked").await?;
        let now = tx.now().await?;
        // the staffing transition (legacy _work_start_if_backlogged)
        let status = spec.status.clone().unwrap_or_else(|| if cur_status == "backlogged" { "open".into() } else { cur_status.clone() });
        let rev = tx
            .exec("work.update_head", work::UPDATE_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(item), Val::text(status.clone()), Val::Uuid(seat), Val::Null, Val::Ts(now)])
            .await?
            .first()
            .and_then(|r| r.first())
            .and_then(Val::as_int)
            .ok_or_else(|| CmdError::Defect("head update returned no rev".into()))?;
        let parts: Vec<Uuid> = tx.exec("work.read_participants", work::PARTICIPANTS_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
        if prev != Some(seat) {
            // the holder changed: material access through the item narrows (C5 step 6)
            crate::restrict::record(tx, org, "work.narrowed").await?;
        }
        let body = json!({"rev": rev, "status": status, "owner": seat, "owner_name": seat_name, "participants": parts, "archived": false, "staffed_to": seat});
        tx.exec("work.insert_version", work::INSERT_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(item), Val::Int(rev), Val::text("update"), Val::Json(body), Val::opt_uuid(by), Val::Ts(now)]).await?;
        (item, slug.trim().to_string(), prev.filter(|p| *p != seat))
    };
    // the assignment mail: a request to the seat (it starts the seat)
    let mb = tx.exec("staffing.assign_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
    if let Some(row) = mb.first() {
        let mailbox = row.first().and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("mailbox id".into()))?;
        let inc = row.get(1).and_then(Val::as_int).unwrap_or(1);
        let id = stable_id(&format!("assign|{}|{}|{}|{}|{item_id}", org, b.op.ns.kind(), b.op.ns.id(), b.op.key));
        let body = json!({"event": "work.assigned", "item": item_name, "to": seat_name}).to_string();
        let req = SendRequest::message(source_of(b), Destination::Resolved { principal: seat, mailbox, mailbox_incarnation: inc }, id, "request", body, format!("assign:{id}"));
        match sent::record_sent(tx, &req).await {
            Ok(_) => {}
            Err(SendError::Refused(r)) => return Ok(Err(r)),
            Err(e) => return Err(e.into()),
        }
    }
    if let Some(p) = prev_owner {
        let body = json!({"event": "work.reassigned", "item": item_name, "to": seat_name}).to_string();
        system_notice(tx, org, p, "work.reassigned", &body).await?;
    }
    Ok(Ok(item_name))
}

/// The whole staff call inside one island transaction.
pub async fn staff_in<S: Session>(tx: &mut Tx<'_, S>, b: &Binding, spec: &StaffSpec, hint: &Mutex<BTreeSet<Uuid>>) -> Result<Result<Staffed, Refusal>, CmdError> {
    let mode = match staff_mode(spec) {
        Ok(m) => m,
        Err(r) => return Ok(Err(r)),
    };
    let action = match item_action(&spec.item) {
        Ok(a) => a,
        Err(r) => return Ok(Err(r)),
    };
    let mut seat_spec = spec.clone();
    seat_spec.seat.unsupported.retain(|f| f != "work_item");
    let (principal, key, mut warnings, kicked, account, noop) = match seat(tx, b, mode, &seat_spec, hint).await? {
        Ok(x) => x,
        Err(r) => return Ok(Err(r)),
    };
    let item = match item_in(tx, b, action, &spec.item, principal, &key).await? {
        Ok(i) => i,
        Err(r) => return Ok(Err(r)),
    };
    if noop {
        warnings.push("already live — nothing to do".into());
        warnings.dedup();
    }
    // the assignment mail starts the seat (legacy: `nid in drive`)
    let started = true;
    let _ = kicked;
    Ok(Ok(Staffed {
        next_step: format!("\"{key}\" holds {item} and is RUNNING — its first turn starts on the assignment (and your kickoff, if you sent one). Nothing further needed."),
        node: key.clone(),
        principal,
        created: (action == "create").then(|| item.clone()),
        updated: (action == "update").then(|| item.clone()),
        item,
        assigned_to: key,
        started,
        warnings,
        account,
        already_live: noop,
    }))
}

/// `orgtree_staff`.
pub struct Staff {
    pub spec: StaffSpec,
    hint: Mutex<BTreeSet<Uuid>>,
}

impl Staff {
    pub fn new(spec: StaffSpec) -> Staff {
        Staff { spec, hint: Mutex::new(BTreeSet::new()) }
    }
}

impl Command for Staff {
    type Output = Staffed;
    fn family(&self) -> &'static Family {
        &STAFFING
    }
    fn verb(&self) -> &'static str {
        "staff"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await?;
        hire::anchor_acting(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Staffed) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Staffed>, CmdError> {
        match staff_in(tx, b, &self.spec, &self.hint).await {
            Ok(Ok(s)) => Ok(Decided::Applied(s)),
            Ok(Err(r)) | Err(CmdError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e),
        }
    }
}

/// The item half as its own command (only for [`staff_split`]).
struct ItemOnly {
    action: &'static str,
    spec: ItemSpec,
    seat: Uuid,
    seat_name: String,
}

impl Command for ItemOnly {
    type Output = String;
    fn family(&self) -> &'static Family {
        &STAFFING
    }
    fn verb(&self) -> &'static str {
        "staff_item"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &String) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<String>, CmdError> {
        Ok(match item_in(tx, b, self.action, &self.spec, self.seat, &self.seat_name).await? {
            Ok(i) => Decided::Applied(i),
            Err(r) => Decided::Refused(r),
        })
    }
}

/// Q-ST3's UNSAFE control: the seat (hire mode) and the item in SEPARATE
/// transactions (the second under its own minted key). Refuses to run
/// unless `Q-ST3.split_transactions` is armed; the control records that it
/// executed. Returns the two outcomes.
pub async fn staff_split<C: Connector>(ex: &Executor<C>, spec: &StaffSpec, b: &Binding) -> Result<(Outcome<hire::Hired>, Option<Outcome<String>>), ExecError> {
    let scope = crate::hooks::Scope { hooks: ex.hooks(), family: STAFFING.name, verb: "staff", op: Some(&b.op), op_tag: b.op_tag.as_deref(), attempt: 0 };
    if !controls::fire(&scope, "Q-ST3.split_transactions") {
        return Err(ExecError::Defect("staff_split ran without Q-ST3.split_transactions armed".into()));
    }
    let action = item_action(&spec.item).map_err(|r| ExecError::Defect(r.message))?;
    let h = ex.run(&hire::Hire::new(Door::Agent, spec.seat.clone()), b).await?;
    let Outcome::Applied(ref seat) = h else { return Ok((h, None)) };
    let mut b2 = b.clone();
    b2.op = crate::exec::OpIdentity::minted(b.op.org, "staff-item", "none");
    let i = ex.run(&ItemOnly { action, spec: spec.item.clone(), seat: seat.principal, seat_name: seat.node.clone() }, &b2).await?;
    Ok((h, Some(i)))
}
