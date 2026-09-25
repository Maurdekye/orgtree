//! Work items (WS4): the strict item reads `work.item-list` and
//! `work.item-get` (S3 §4.11), and the **schedule-grade** item writers they
//! race (SLICE-VERBS C, ruling E1: the `orgtree_work` card is P05's family).
//!
//! **Reads.** An operator read (S3 E2): one `REPEATABLE READ READ ONLY`
//! snapshot per answer, no locks, no writes, no output claim. The list reads
//! every head it groups and derives archive and backlog with ONE timestamp
//! taken at snapshot start (r7 C7), so an item whose archive time passes
//! during the read is in the same group in every part of the answer and in
//! the counts. The item read reads the head, the participants and every
//! version row in that one snapshot, so it answers one committed revision.
//!
//! **Writers (schedule-grade).** Every writer of an item's owner, participant
//! set, status or archive state takes the item's HEAD row `FOR NO KEY UPDATE`,
//! bumps `rev` and appends one version row recording the revision and the
//! participant set it produced, in the same transaction (r7 C3). That is what
//! makes a torn read detectable: a head at rev n with the participants of
//! n+1 contradicts version n's body.
//!
//! **P03-only encoding (lead ruling d, 2026-09-25).** Checks, reviews,
//! findings, evidence and history are `work_item_versions` rows told apart by
//! `kind`. P04/P05 decide the real row families; no other workstream may
//! depend on this encoding.
//!
//! **Derived archive (P03 narrowing, disclosed).** An item is archived when
//! it is physically archived (`archived_at` set), when it is `dropped` (it
//! archives at once), or when it is `done` and its last update is STRICTLY
//! more than 3600 s older than the read's timestamp (legacy
//! `WORK_ARCHIVE_AFTER_S`, `_work_eligible`). Legacy's attention and open
//! question holds are not modelled here (no such columns in the P03 schema);
//! the wire parity of the docket card is P05's.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Executor, ExecError, Family, Isolation, OpIdentity, Principal, Refusal};
use crate::hooks::{controls, Scope};
use crate::mail::doors::anchor_agent_caller;
use crate::read::Read;
use crate::session::{Connector, Session};
use crate::value::{Rows, Val};
use crate::Tx;

/// Legacy `WORK_ARCHIVE_AFTER_S`: a `done` item archives when its last
/// update is strictly older than this.
pub const ARCHIVE_AFTER_US: i64 = 3_600_000_000;

pub static WORK_WRITE: Family = Family { name: "work", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &["Q-W1.per_statement_reads", "Q-W2.ts_per_item"];

/// Statement labels of the reads and writers.
pub const LABELS: &[&str] = &[
    "work.head",
    "work.participants",
    "work.versions",
    "work.list_heads",
    "work.list_clock",
    "work.q_w2_clock",
    "work.lock_head",
    "work.insert_head",
    "work.insert_name",
    "work.update_head",
    "work.delete_participant",
    "work.insert_participant",
    "work.read_participants",
    "work.insert_version",
    "exec.now",
    "mail.anchor_caller",
    "mail.anchor_killswitch",
];

/// Family-specific pause points.
pub const POINTS: &[&str] = &["work.list.after_counts"];

// ---------------------------------------------------------------- SQL

pub const HEAD_SQL: &str = "SELECT item_id, name, title, kind, status, owner_id, creator_id, reviewer_id, parent_item_id, rev, \
    created_at, updated_at, archived_at FROM work_items WHERE org_id = $1 AND item_id = $2";
pub const PARTICIPANTS_SQL: &str = "SELECT principal_id FROM work_participants WHERE org_id = $1 AND item_id = $2 ORDER BY principal_id";
pub const VERSIONS_SQL: &str = "SELECT seq, kind, body, by_principal, at FROM work_item_versions WHERE org_id = $1 AND item_id = $2 ORDER BY seq";
pub const LIST_HEADS_SQL: &str = "SELECT item_id, name, title, kind, status, owner_id, creator_id, reviewer_id, parent_item_id, rev, \
    created_at, updated_at, archived_at FROM work_items WHERE org_id = $1 ORDER BY updated_at DESC, item_id";
pub const CLOCK_SQL: &str = "SELECT clock_timestamp()";

pub const LOCK_HEAD_SQL: &str = "SELECT rev, status, owner_id, archived_at FROM work_items WHERE org_id = $1 AND item_id = $2 FOR NO KEY UPDATE";
pub const INSERT_HEAD_SQL: &str = "INSERT INTO work_items (org_id, item_id, name, title, kind, status, owner_id, creator_id, rev, created_at, updated_at) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)";
pub const INSERT_NAME_SQL: &str = "INSERT INTO active_work_names (org_id, name, item_id) VALUES ($1, $2, $3)";
pub const UPDATE_HEAD_SQL: &str = "UPDATE work_items SET rev = rev + 1, status = $3, owner_id = $4, archived_at = $5, updated_at = $6 \
    WHERE org_id = $1 AND item_id = $2 RETURNING rev";
pub const DELETE_PARTICIPANT_SQL: &str = "DELETE FROM work_participants WHERE org_id = $1 AND item_id = $2 AND principal_id = $3";
pub const INSERT_PARTICIPANT_SQL: &str = "INSERT INTO work_participants (org_id, item_id, principal_id) VALUES ($1, $2, $3) \
    ON CONFLICT ON CONSTRAINT work_participants_pk DO NOTHING";
pub const OWNER_NAME_SQL: &str = "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2";
pub const INSERT_VERSION_SQL: &str = "INSERT INTO work_item_versions (org_id, item_id, seq, kind, body, by_principal, at) \
    VALUES ($1, $2, $3, $4, $5, $6, $7)";

// ---------------------------------------------------------------- shapes

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Head {
    pub item_id: Uuid,
    pub name: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub owner: Option<Uuid>,
    pub creator: Option<Uuid>,
    pub reviewer: Option<Uuid>,
    pub parent_item: Option<Uuid>,
    pub rev: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

fn head_of(r: &[Val]) -> Option<Head> {
    Some(Head {
        item_id: r.first()?.as_uuid()?,
        name: r.get(1)?.as_text()?.to_string(),
        title: r.get(2)?.as_text()?.to_string(),
        kind: r.get(3)?.as_text()?.to_string(),
        status: r.get(4)?.as_text()?.to_string(),
        owner: r.get(5)?.as_uuid(),
        creator: r.get(6)?.as_uuid(),
        reviewer: r.get(7)?.as_uuid(),
        parent_item: r.get(8)?.as_uuid(),
        rev: r.get(9)?.as_int()?,
        created_at: r.get(10)?.as_ts()?,
        updated_at: r.get(11)?.as_ts()?,
        archived_at: r.get(12)?.as_ts(),
    })
}

fn heads(rows: &Rows) -> Result<Vec<Head>, CmdError> {
    rows.0.iter().map(|r| head_of(r).ok_or_else(|| CmdError::Defect("undecodable work_items row".into()))).collect()
}

/// The derived group of one item at one timestamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    Active,
    Backlogged,
    Archived,
}

/// The P03 derivation (module doc): physically archived, dropped, or done
/// for strictly more than an hour at `now`.
pub fn derive(h: &Head, now: i64) -> Group {
    let archived = h.archived_at.is_some() || h.status == "dropped" || (h.status == "done" && now - h.updated_at > ARCHIVE_AFTER_US);
    if archived {
        Group::Archived
    } else if h.status == "backlogged" {
        Group::Backlogged
    } else {
        Group::Active
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    pub active: i64,
    pub backlogged: i64,
    pub archived: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListAnswer {
    /// The one timestamp every derivation in this answer used.
    pub at: i64,
    pub items: Vec<Head>,
    pub backlogged: Option<Vec<Head>>,
    pub archived: Option<Vec<Head>>,
    pub counts: Counts,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub seq: i64,
    pub kind: String,
    pub body: Value,
    pub by: Option<Uuid>,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemAnswer {
    pub head: Head,
    pub participants: Vec<Uuid>,
    pub versions: Vec<Version>,
}

impl ItemAnswer {
    /// Q-W1's oracle: the answer is ONE committed revision iff the latest
    /// `update` version row records exactly this head's rev and this
    /// participant set (every writer appends that row with the head bump).
    pub fn coherent(&self) -> bool {
        let Some(v) = self.versions.iter().rev().find(|v| v.kind == "update" || v.kind == "create") else { return false };
        let rev_ok = v.body.get("rev").and_then(Value::as_i64) == Some(self.head.rev);
        let parts: Option<Vec<Uuid>> = v
            .body
            .get("participants")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().and_then(|s| s.parse().ok())).collect());
        rev_ok && parts.as_deref() == Some(&self.participants[..])
    }
}

// ---------------------------------------------------------------- reads

/// `work.item-get` inside one snapshot.
pub struct ItemGet {
    pub org: Uuid,
    pub item: Uuid,
}

async fn read_head<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, item: Uuid) -> Result<Option<Head>, CmdError> {
    let rows = tx.exec("work.head", HEAD_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?;
    Ok(heads(&rows)?.into_iter().next())
}

async fn read_participants<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, item: Uuid) -> Result<Vec<Uuid>, CmdError> {
    let rows = tx.exec("work.participants", PARTICIPANTS_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?;
    Ok(rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect())
}

async fn read_versions<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, item: Uuid) -> Result<Vec<Version>, CmdError> {
    let rows = tx.exec("work.versions", VERSIONS_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?;
    rows.0
        .iter()
        .map(|r| {
            Some(Version {
                seq: r.first()?.as_int()?,
                kind: r.get(1)?.as_text()?.to_string(),
                body: r.get(2)?.as_json()?.clone(),
                by: r.get(3)?.as_uuid(),
                at: r.get(4)?.as_ts()?,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| CmdError::Defect("undecodable work_item_versions row".into()))
}

impl Read for ItemGet {
    type Output = Option<ItemAnswer>;
    fn family(&self) -> &'static str {
        "work"
    }
    fn verb(&self) -> &'static str {
        "get"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let Some(head) = read_head(tx, self.org, self.item).await? else { return Ok(None) };
        let participants = read_participants(tx, self.org, self.item).await?;
        let versions = read_versions(tx, self.org, self.item).await?;
        Ok(Some(ItemAnswer { head, participants, versions }))
    }
}

/// One row family per snapshot: Q-W1's unsafe control reads each family in
/// its own statement at READ COMMITTED, which here means its own snapshot.
enum Part {
    Head,
    Participants,
    Versions,
}

struct PartRead {
    org: Uuid,
    item: Uuid,
    part: Part,
}

enum PartOut {
    Head(Option<Head>),
    Participants(Vec<Uuid>),
    Versions(Vec<Version>),
}

impl Read for PartRead {
    type Output = PartOut;
    fn family(&self) -> &'static str {
        "work"
    }
    fn verb(&self) -> &'static str {
        "get"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<PartOut, CmdError> {
        Ok(match self.part {
            Part::Head => PartOut::Head(read_head(tx, self.org, self.item).await?),
            Part::Participants => PartOut::Participants(read_participants(tx, self.org, self.item).await?),
            Part::Versions => PartOut::Versions(read_versions(tx, self.org, self.item).await?),
        })
    }
}

/// `work.item-get`: one snapshot (or, under `Q-W1.per_statement_reads`,
/// one snapshot per row family). `op_tag` routes harness plans.
pub async fn item_get<C: Connector>(ex: &Executor<C>, org: Uuid, item: Uuid, op_tag: Option<&str>) -> Result<Option<ItemAnswer>, ExecError> {
    let op = OpIdentity::minted(org, "", "none");
    let scope = Scope { hooks: ex.hooks(), family: "work", verb: "get", op: Some(&op), op_tag, attempt: 1 };
    if controls::fire(&scope, "Q-W1.per_statement_reads") {
        let PartOut::Head(head) = ex.read(&PartRead { org, item, part: Part::Head }, org, op_tag).await? else { unreachable!() };
        let Some(head) = head else { return Ok(None) };
        let PartOut::Participants(participants) = ex.read(&PartRead { org, item, part: Part::Participants }, org, op_tag).await? else { unreachable!() };
        let PartOut::Versions(versions) = ex.read(&PartRead { org, item, part: Part::Versions }, org, op_tag).await? else { unreachable!() };
        return Ok(Some(ItemAnswer { head, participants, versions }));
    }
    ex.read(&ItemGet { org, item }, org, op_tag).await
}

/// `work.item-list {archived, backlogged}`.
pub struct ItemList {
    pub org: Uuid,
    pub include_archived: bool,
    pub include_backlogged: bool,
}

impl Read for ItemList {
    type Output = ListAnswer;
    fn family(&self) -> &'static str {
        "work"
    }
    fn verb(&self) -> &'static str {
        "list"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<ListAnswer, CmdError> {
        // The one timestamp, at snapshot start (C7): the first statement
        // also fixes the REPEATABLE READ snapshot.
        let at = tx
            .exec("work.list_clock", CLOCK_SQL, &[])
            .await?
            .first()
            .and_then(|r| r.first())
            .and_then(Val::as_ts)
            .ok_or_else(|| CmdError::Defect("clock_timestamp returned nothing".into()))?;
        let all = heads(&tx.exec("work.list_heads", LIST_HEADS_SQL, &[Val::Uuid(self.org)]).await?)?;
        // Q-W2 unsafe control: the timestamp is re-read per item and per pass.
        let per_item = controls::fire(&tx.scope(), "Q-W2.ts_per_item");
        let mut counts = Counts::default();
        for h in &all {
            let t = if per_item { clock(tx).await? } else { at };
            match derive(h, t) {
                Group::Active => counts.active += 1,
                Group::Backlogged => counts.backlogged += 1,
                Group::Archived => counts.archived += 1,
            }
            counts.total += 1;
        }
        tx.pause("after_counts").await?;
        let (mut items, mut backlogged, mut archived) = (Vec::new(), Vec::new(), Vec::new());
        for h in all {
            let t = if per_item { clock(tx).await? } else { at };
            match derive(&h, t) {
                Group::Active => items.push(h),
                Group::Backlogged => backlogged.push(h),
                Group::Archived => archived.push(h),
            }
        }
        Ok(ListAnswer {
            at,
            items,
            backlogged: self.include_backlogged.then_some(backlogged),
            archived: self.include_archived.then_some(archived),
            counts,
        })
    }
}

async fn clock<S: Session>(tx: &mut Tx<'_, S>) -> Result<i64, CmdError> {
    tx.exec("work.q_w2_clock", CLOCK_SQL, &[])
        .await?
        .first()
        .and_then(|r| r.first())
        .and_then(Val::as_ts)
        .ok_or_else(|| CmdError::Defect("clock_timestamp returned nothing".into()))
}

// ---------------------------------------------------------------- writers (schedule-grade)

async fn anchor(tx: &mut Tx<'_, impl Session>, b: &Binding) -> Result<(), CmdError> {
    if let Principal::Agent { id, generation } = b.principal {
        if let Some(r) = anchor_agent_caller(tx, b.op.org, id, generation).await? {
            return Err(CmdError::Refused(r));
        }
    }
    Ok(())
}

fn by(b: &Binding) -> Option<Uuid> {
    b.principal.id()
}

/// Create an item (schedule-grade fixture writer; the real create is P05).
pub struct WorkCreate {
    pub item: Uuid,
    pub name: String,
    pub title: String,
    pub status: String,
    pub owner: Option<Uuid>,
    pub participants: Vec<Uuid>,
}

impl Command for WorkCreate {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &WORK_WRITE
    }
    fn verb(&self) -> &'static str {
        "create"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        create_in(tx, b.op.org, by(b), self).await
    }
}

/// How an item archives (r7 Q-M1 lists the three archivers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Archive {
    /// The timed archiver: a done item past its hour is swept.
    Timed,
    /// A drop: `dropped` archives at once.
    Drop,
    /// An explicit archive.
    Explicit,
}

/// One docket write (schedule-grade `orgtree_work update/assign/archive`):
/// head, participants and history together, under the head row lock.
#[derive(Clone, Debug, Default)]
pub struct WorkUpdate {
    pub item: Uuid,
    /// The revision the caller composed against (compare-and-set).
    pub expected_rev: Option<i64>,
    pub status: Option<String>,
    /// `Some(None)` clears the owner.
    pub owner: Option<Option<Uuid>>,
    pub add_participants: Vec<Uuid>,
    pub remove_participants: Vec<Uuid>,
    pub archive: Option<Archive>,
    /// Reopen an archived item (clears `archived_at`).
    pub reopen: bool,
    /// A free-form progress entry recorded with the version.
    pub note: Option<String>,
}

/// The writer's answer: the new revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Updated {
    pub rev: i64,
    pub status: String,
    pub archived: bool,
}

impl Command for WorkUpdate {
    type Output = Updated;
    fn family(&self) -> &'static Family {
        &WORK_WRITE
    }
    fn verb(&self) -> &'static str {
        match self.archive {
            Some(_) => "archive",
            None if self.reopen => "reopen",
            None => "update",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Updated) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Updated>, CmdError> {
        update_in(tx, b.op.org, by(b), self).await
    }
}

/// The owner's CURRENT name, recorded with each version (read only by
/// Q-M2's unsafe control: roster matching by name; D6 matches by identity).
async fn owner_name<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, owner: Option<Uuid>) -> Result<Option<String>, CmdError> {
    let Some(o) = owner else { return Ok(None) };
    Ok(tx.exec("work.owner_name", OWNER_NAME_SQL, &[Val::Uuid(org), Val::Uuid(o)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)))
}

/// The body of [`WorkCreate`], composable inside another command's
/// transaction (WS3a: the staff door writes its item with the seat).
pub async fn create_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, by_principal: Option<Uuid>, c: &WorkCreate) -> Result<Decided<i64>, CmdError> {
    let now = tx.now().await?;
    tx.exec(
        "work.insert_head",
        INSERT_HEAD_SQL,
        &[
            Val::Uuid(org),
            Val::Uuid(c.item),
            Val::text(c.name.clone()),
            Val::text(c.title.clone()),
            Val::text("code"),
            Val::text(c.status.clone()),
            Val::opt_uuid(c.owner),
            Val::opt_uuid(by_principal),
            Val::Ts(now),
        ],
    )
    .await?;
    tx.exec("work.insert_name", INSERT_NAME_SQL, &[Val::Uuid(org), Val::text(c.name.clone()), Val::Uuid(c.item)]).await?;
    let mut parts = c.participants.clone();
    parts.sort();
    parts.dedup();
    for p in &parts {
        tx.exec("work.insert_participant", INSERT_PARTICIPANT_SQL, &[Val::Uuid(org), Val::Uuid(c.item), Val::Uuid(*p)]).await?;
    }
    let owner_name = owner_name(tx, org, c.owner).await?;
    let body = json!({"rev": 1, "status": c.status, "owner": c.owner, "owner_name": owner_name, "participants": parts, "archived": false});
    tx.exec(
        "work.insert_version",
        INSERT_VERSION_SQL,
        &[Val::Uuid(org), Val::Uuid(c.item), Val::Int(1), Val::text("create"), Val::Json(body), Val::opt_uuid(by_principal), Val::Ts(now)],
    )
    .await?;
    Ok(Decided::Applied(1))
}

/// The body of [`WorkUpdate`] (head row FOR NO KEY UPDATE, CAS, participants,
/// restriction, version row), composable inside another command's
/// transaction (WS3a: S3 §4.8's staff docket write in the seat's transaction).
pub async fn update_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, by_principal: Option<Uuid>, u: &WorkUpdate) -> Result<Decided<Updated>, CmdError> {
    let key = [Val::Uuid(org), Val::Uuid(u.item)];
    // The head row first (C3: every writer of owner, participants, state
    // or archive), then the attempt clock (C7).
    let rows = tx.exec("work.lock_head", LOCK_HEAD_SQL, &key).await?;
    let Some(r) = rows.first() else { return Ok(Decided::Refused(Refusal::new("no_such_item", "no such work item"))) };
    let rev = r.first().and_then(Val::as_int).unwrap_or(0);
    let cur_status = r.get(1).and_then(Val::as_text).unwrap_or("").to_string();
    let cur_owner = r.get(2).and_then(Val::as_uuid);
    let cur_archived = r.get(3).and_then(Val::as_ts);
    if let Some(want) = u.expected_rev {
        if want != rev {
            return Ok(Decided::Refused(Refusal::new(
                "stale_rev",
                format!("the item changed: it is at revision {rev}, the update was composed against {want}"),
            )));
        }
    }
    let now = tx.now().await?;
    let mut status = u.status.clone().unwrap_or(cur_status);
    let owner = match u.owner {
        Some(o) => o,
        None => cur_owner,
    };
    let archived_at = match u.archive {
        Some(Archive::Drop) => {
            status = "dropped".into();
            Some(now)
        }
        Some(_) => Some(now),
        None if u.reopen => None,
        None => cur_archived,
    };
    let new_rev = tx
        .exec(
            "work.update_head",
            UPDATE_HEAD_SQL,
            &[Val::Uuid(org), Val::Uuid(u.item), Val::text(status.clone()), Val::opt_uuid(owner), archived_at.map(Val::Ts).unwrap_or(Val::Null), Val::Ts(now)],
        )
        .await?
        .first()
        .and_then(|r| r.first())
        .and_then(Val::as_int)
        .ok_or_else(|| CmdError::Defect("head update returned no rev".into()))?;
    for p in &u.remove_participants {
        tx.exec("work.delete_participant", DELETE_PARTICIPANT_SQL, &[Val::Uuid(org), Val::Uuid(u.item), Val::Uuid(*p)]).await?;
    }
    for p in &u.add_participants {
        tx.exec("work.insert_participant", INSERT_PARTICIPANT_SQL, &[Val::Uuid(org), Val::Uuid(u.item), Val::Uuid(*p)]).await?;
    }
    let parts: Vec<Uuid> = tx
        .exec("work.read_participants", PARTICIPANTS_SQL, &key)
        .await?
        .0
        .iter()
        .filter_map(|r| r.first().and_then(Val::as_uuid))
        .collect();
    // C5 step 6 (r7 §4.2 table): the item archiving, a reader unlisted,
    // or the holder changing narrows material access through the item;
    // the restriction is recorded in THIS transaction. Closing alone
    // (done) records nothing (D8).
    let narrows = (archived_at.is_some() && cur_archived.is_none()) || !u.remove_participants.is_empty() || owner != cur_owner;
    if narrows {
        crate::restrict::record(tx, org, "work.narrowed").await?;
    }
    let owner_name = owner_name(tx, org, owner).await?;
    let body = json!({
        "rev": new_rev,
        "status": status,
        "owner": owner,
        "owner_name": owner_name,
        "participants": parts,
        "archived": archived_at.is_some(),
        "archive": u.archive.map(|a| format!("{a:?}").to_lowercase()),
        "note": u.note,
    });
    tx.exec(
        "work.insert_version",
        INSERT_VERSION_SQL,
        &[Val::Uuid(org), Val::Uuid(u.item), Val::Int(new_rev), Val::text("update"), Val::Json(body), Val::opt_uuid(by_principal), Val::Ts(now)],
    )
    .await?;
    Ok(Decided::Applied(Updated { rev: new_rev, status, archived: archived_at.is_some() }))
}

/// DECLARED-CONTACTS for the work verbs.
pub fn declared() -> Value {
    json!({
        "work.item-get": {
            "relations": {
                "work_items": {"modes": ["read"], "required": true},
                "work_participants": {"modes": ["read"], "required": true},
                "work_item_versions": {"modes": ["read"], "required": true}
            },
            "p01_contract": "work.item-get",
            "source": "S3 §4.11: one REPEATABLE READ READ ONLY snapshot, no locks"
        },
        "work.item-list": {
            "relations": {"work_items": {"modes": ["read"], "required": true}},
            "p01_contract": "work.item-list",
            "source": "S3 §4.11: one snapshot, derived archive at snapshot start (r7 C7)"
        },
        "work.update": {
            "relations": {
                "authority_epoch": {"modes": ["read", "for_share"], "required": false},
                "org_controls": {"modes": ["read", "for_share"], "required": false},
                "work_items": {"modes": ["read", "for_no_key_update", "write"], "required": true},
                "work_participants": {"modes": ["read", "write"], "required": false},
                "work_item_versions": {"modes": ["write"], "required": true},
                "agents": {"modes": ["read"], "required": false},
                "restrictions": {"modes": ["write"], "required": false},
                "restriction_obligations": {"modes": ["write"], "required": false},
                "read_service_registrations": {"modes": ["read"], "required": false},
                "operation_receipts": {"modes": ["read", "write"], "required": true}
            },
            "p01_contract": null,
            "source": "schedule-grade docket writer (SLICE-VERBS C, ruling E1); r7 C3 head-row rule"
        },
        "work.create": {
            "relations": {
                "work_items": {"modes": ["write"], "required": true},
                "active_work_names": {"modes": ["write"], "required": true},
                "work_participants": {"modes": ["write"], "required": false},
                "work_item_versions": {"modes": ["write"], "required": true},
                "operation_receipts": {"modes": ["read", "write"], "required": true}
            },
            "p01_contract": null,
            "source": "schedule-grade fixture writer"
        }
    })
}
