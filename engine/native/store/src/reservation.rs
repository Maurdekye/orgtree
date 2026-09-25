//! Shared-resource reservations (WS4): the eleven `reservation.*` variants
//! of r7 §3 on the store core, with legacy's semantics
//! (`engine/backend/orgtree/reservations.py` and the agent-door adapter in
//! `api.py`) except where r7 §7 says otherwise (D1 active-only cap, D2
//! bounded output, D3 principal ownership, D12 finite thresholds).
//!
//! **Constraints that replace `DOC_LOCK` (r7 §3.2).** K1 (one HELD row per
//! `(org, resource)`) and K2 (one row per integration key) are unique
//! indexes and this family's allowlisted `23505` retries: the loser of a
//! collision re-runs and reads the winner. K3/K4 are CHECKs.
//!
//! **Writers** run READ COMMITTED. Id-bearing mutations lock the row
//! `FOR UPDATE`, read the attempt clock after that lock (C7) and evaluate
//! legacy's predicates in legacy order on the locked version. Visibility
//! that authorizes a mutation is anchored (C3): the item head row and the
//! owner's (or creator's) ancestry chain `FOR SHARE`. A holder's liveness is
//! its authority-epoch row `FOR SHARE`.
//!
//! **Reads** (`list`, `landing`, `overlap`) are protected reads (C5): one
//! `REPEATABLE READ READ ONLY` snapshot, no locks, and the answer is released
//! through the caller's output claim ([`crate::claims`]).
//!
//! **Not built here (disclosed):** a KEYED read's receipt (legacy commits
//! only its receipt, r7 §3.5.1; receipt classes are P06's): keyed reads run
//! as unkeyed reads. The wire rendering of ids, timestamps and the D2
//! truncation marker's exact shape belong to the wire owners; ids are the
//! native UUIDs, timestamps legacy's `_stamp` format.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Principal, Refusal};
use crate::hooks::controls;
use crate::mail::doors::anchor_agent_caller;
use crate::read::Read;
use crate::sent::{self, SendError, SendRequest};
use crate::session::Session;
use crate::value::{Rows, Val};
use crate::Tx;

pub static RESERVATION: Family = Family {
    name: "reservation",
    isolation: Isolation::ReadCommitted,
    retry_unique: &["resource_reservations_held_resource", "resource_reservations_integration_key"],
};

pub const MAX_ACTIVE: i64 = 512;
pub const MAX_ROWS_OUT: usize = 512;
pub const MAX_PATHS: usize = 128;
pub const MAX_PATH_LENGTH: usize = 512;
pub const MAX_RESOURCE_LENGTH: usize = 200;
pub const MAX_ITEM_LENGTH: usize = 96;
pub const MAX_LEASE_S: f64 = 86_400.0;
pub const DEFAULT_LEASE_S: f64 = 900.0;
pub const DEFAULT_STALE_S: f64 = 300.0;

/// Unsafe controls compiled into this family (static list for the handshake).
/// `Q-R1.no_k1` and `Q-R3.no_k2` record, at the insert, a run whose harness
/// dropped K1 / K2 (the unsafe condition is the missing index itself).
pub const CONTROLS: &[&str] = &[
    "Q-R1.no_k1",
    "Q-R3.no_k2",
    "Q-R4.no_row_lock",
    "Q-R5.no_recheck",
    "Q-R6.grant_after_release",
    "Q-R7.stale_mark_committed",
    "Q-R8.count_all_rows",
    "Q-R9.owner_by_name",
    "Q-R10.reads_lock_rows",
    "Q-R11.unbounded",
    "Q-R11.truncate_wrong_end",
    "Q-C3.no_item_anchor",
];

/// Family-specific pause points (beyond generic and statement points).
pub const POINTS: &[&str] = &[
    "reservation.acquire.after_count",
    "reservation.acquire.after_holder_lock",
    "reservation.list_scope.after_pass1",
    "reservation.release.after_row_lock",
    "reservation.list.after_snapshot",
];

// ---------------------------------------------------------------- time and text

/// Legacy `_stamp`: ISO-8601 UTC with milliseconds and a `Z`.
pub fn stamp(us: i64) -> String {
    let secs = us.div_euclid(1_000_000);
    let ms = us.rem_euclid(1_000_000) / 1000;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

fn refuse(msg: impl Into<String>) -> Refusal {
    Refusal::new("reservation", msg)
}

/// Legacy `_text`: required, trimmed, no NUL, bounded.
pub fn text_arg(v: Option<&Value>, name: &str, limit: usize) -> Result<String, Refusal> {
    let s = match v {
        None | Some(Value::Null) => return Err(refuse(format!("{name} is required"))),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(other) => other.to_string().trim().to_string(),
    };
    if s.is_empty() {
        return Err(refuse(format!("{name} is required")));
    }
    if s.contains('\0') {
        return Err(refuse(format!("{name} contains a NUL")));
    }
    if s.chars().count() > limit {
        return Err(refuse(format!("{name} is limited to {limit} characters")));
    }
    Ok(s)
}

/// Legacy `_paths`: a list, bounded, separators normalized for comparison
/// only, deduplicated in order. Never resolved or opened.
pub fn paths_arg(v: Option<&Value>) -> Result<Vec<String>, Refusal> {
    let items = match v {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(refuse("paths must be a list of declared path strings")),
    };
    if items.len() > MAX_PATHS {
        return Err(refuse(format!("paths is limited to {MAX_PATHS} entries")));
    }
    let mut out: Vec<String> = Vec::new();
    for (i, raw) in items.iter().enumerate() {
        let mut p = text_arg(Some(raw), &format!("paths[{i}]"), MAX_PATH_LENGTH)?.replace('\\', "/");
        while p.contains("//") {
            p = p.replace("//", "/");
        }
        let t = p.trim_end_matches('/');
        let p = if t.is_empty() { "/".to_string() } else { t.to_string() };
        if !out.contains(&p) {
            out.push(p);
        }
    }
    Ok(out)
}

/// Legacy `workevidence.validate_sha` (7-40 lowercase hex), with its fault
/// wording, wrapped as `_sha`'s "{name} must be a commit SHA: …".
pub fn sha_arg(v: Option<&Value>, name: &str) -> Result<String, Refusal> {
    let s = match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(other) => other.to_string().trim().to_string(),
    };
    let ok = (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if ok {
        return Ok(s);
    }
    let why = if s.is_empty() {
        "it is empty".to_string()
    } else if s.len() < 7 {
        format!("it is {} character(s) long; the shortest accepted abbreviation is 7", s.len())
    } else if s.len() > 40 {
        format!("it is {} characters long; a full sha is 40, so this is {} too many", s.len(), s.len() - 40)
    } else {
        let (i, c) = s.chars().enumerate().find(|(_, c)| !"0123456789abcdef".contains(*c)).unwrap_or((0, '?'));
        let upper = if "0123456789abcdef".contains(c.to_ascii_lowercase()) { " (it is the uppercase form — git prints shas in lowercase)" } else { "" };
        format!("character {} is {c:?}, which is not a lowercase hex digit{upper}", i + 1)
    };
    Err(refuse(format!(
        "{name} must be a commit SHA: a commit reference must be a lowercase hex sha of 7-40 characters (no branch names, no ranges, no ref expressions): {why}. You sent {s:?}"
    )))
}

fn num_arg(v: Option<&Value>, default: f64) -> f64 {
    match v {
        None | Some(Value::Null) => default,
        Some(x) => match x.as_f64() {
            Some(f) if f != 0.0 => f,
            Some(_) => default,
            None => x.as_str().and_then(|s| s.trim().parse::<f64>().ok()).filter(|f| *f != 0.0).unwrap_or(default),
        },
    }
}

// ---------------------------------------------------------------- the row

pub const COLS: &str = "reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label";

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: Uuid,
    pub owner: Uuid,
    pub item: Option<Uuid>,
    pub resource: String,
    pub candidate: String,
    pub base: String,
    pub paths: Vec<String>,
    pub state: String,
    pub created: i64,
    pub updated: i64,
    pub expires: i64,
    pub heartbeat: i64,
    pub lease_s: f64,
    pub stale_s: f64,
    pub integration_key: Option<String>,
    pub release_receipt: Option<String>,
    pub integration_receipt: Option<String>,
    pub successor: Option<Uuid>,
    pub recovered_reason: Option<String>,
    pub stale_reason: Option<String>,
    pub recovered_by: Option<Uuid>,
    pub landed_at: Option<i64>,
    pub owner_label: Option<String>,
}

fn row_of(r: &[Val]) -> Option<Row> {
    let s = |i: usize| r.get(i).and_then(|v| v.as_text().map(str::to_string));
    let js = |i: usize| r.get(i).and_then(Val::as_json).and_then(|j| j.as_str().map(str::to_string));
    Some(Row {
        id: r.first()?.as_uuid()?,
        owner: r.get(1)?.as_uuid()?,
        item: r.get(2)?.as_uuid(),
        resource: s(3)?,
        candidate: s(4).unwrap_or_default(),
        base: s(5).unwrap_or_default(),
        paths: r.get(6)?.as_json()?.as_array()?.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        state: s(7)?,
        created: r.get(8)?.as_ts()?,
        updated: r.get(9)?.as_ts()?,
        expires: r.get(10)?.as_ts()?,
        heartbeat: r.get(11)?.as_ts()?,
        lease_s: s(12)?.parse().ok()?,
        stale_s: s(13)?.parse().ok()?,
        integration_key: s(14),
        release_receipt: js(15),
        integration_receipt: js(16),
        successor: r.get(17)?.as_uuid(),
        recovered_reason: s(18),
        stale_reason: s(19),
        recovered_by: r.get(20)?.as_uuid(),
        landed_at: r.get(21)?.as_ts(),
        owner_label: s(22),
    })
}

fn rows_of(rows: &Rows) -> Result<Vec<Row>, CmdError> {
    rows.0.iter().map(|r| row_of(r).ok_or_else(|| CmdError::Defect("undecodable reservation row".into()))).collect()
}

impl Row {
    fn expired(&self, now: i64) -> bool {
        self.expires <= now
    }
    fn active_heartbeat(&self, now: i64, stale_s: f64) -> bool {
        (now - self.heartbeat) as f64 <= stale_s * 1e6
    }
    fn same_scope(&self, candidate: &str, base: &str) -> bool {
        self.candidate == candidate && self.base == base
    }
    fn terminal(&self) -> bool {
        self.state != "held"
    }
}

/// Names for rendering (the principal's CURRENT name, D3; the item's name).
#[derive(Default)]
pub struct Names {
    pub agents: std::collections::HashMap<Uuid, String>,
    pub items: std::collections::HashMap<Uuid, String>,
}

pub const AGENT_NAME_SQL: &str = "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2";
pub const ITEM_NAME_SQL: &str = "SELECT name FROM work_items WHERE org_id = $1 AND item_id = $2";

async fn names_for<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, rows: &[&Row]) -> Result<Names, CmdError> {
    let mut n = Names::default();
    let mut agents: BTreeSet<Uuid> = BTreeSet::new();
    let mut items: BTreeSet<Uuid> = BTreeSet::new();
    for r in rows {
        agents.insert(r.owner);
        agents.extend(r.successor);
        agents.extend(r.recovered_by);
        items.extend(r.item);
    }
    for a in agents {
        let v = tx.exec("reservation.name", AGENT_NAME_SQL, &[Val::Uuid(org), Val::Uuid(a)]).await?;
        if let Some(s) = v.first().and_then(|r| r.first()).and_then(Val::as_text) {
            n.agents.insert(a, s.to_string());
        }
    }
    for i in items {
        let v = tx.exec("reservation.item_name", ITEM_NAME_SQL, &[Val::Uuid(org), Val::Uuid(i)]).await?;
        if let Some(s) = v.first().and_then(|r| r.first()).and_then(Val::as_text) {
            n.items.insert(i, s.to_string());
        }
    }
    Ok(n)
}

/// Legacy `_safe`: reservation metadata only (never the integration key).
pub fn safe(r: &Row, n: &Names) -> Value {
    let name = |u: Uuid| n.agents.get(&u).cloned().unwrap_or_else(|| u.to_string());
    let mut m = Map::new();
    m.insert("id".into(), json!(r.id.to_string()));
    m.insert("owner".into(), json!(name(r.owner)));
    m.insert("item".into(), json!(r.item.map(|i| n.items.get(&i).cloned().unwrap_or_else(|| i.to_string())).unwrap_or_default()));
    m.insert("resource".into(), json!(r.resource));
    m.insert("candidate".into(), json!(r.candidate));
    m.insert("base".into(), json!(r.base));
    m.insert("paths".into(), json!(r.paths));
    m.insert("state".into(), json!(r.state));
    m.insert("created_at".into(), json!(stamp(r.created)));
    m.insert("updated_at".into(), json!(stamp(r.updated)));
    m.insert("expires_at".into(), json!(stamp(r.expires)));
    m.insert("heartbeat_at".into(), json!(stamp(r.heartbeat)));
    if let Some(x) = &r.release_receipt {
        m.insert("release_receipt".into(), json!(x));
        m.insert("successor".into(), r.successor.map(|s| json!(name(s))).unwrap_or(Value::Null));
    }
    if let Some(x) = &r.integration_receipt {
        m.insert("integration_receipt".into(), json!(x));
    }
    if let Some(t) = r.landed_at {
        m.insert("landed_at".into(), json!(stamp(t)));
    }
    if let Some(b) = r.recovered_by {
        m.insert("recovered_by".into(), json!(name(b)));
    }
    if let Some(x) = &r.recovered_reason {
        m.insert("recovered_reason".into(), json!(x));
    }
    if let Some(x) = &r.stale_reason {
        m.insert("stale_reason".into(), json!(x));
    }
    Value::Object(m)
}

/// Legacy `_contention`: the holder and lease facts a contender needs.
pub fn contention(r: &Row, n: &Names) -> Value {
    let v = safe(r, n);
    let mut m = Map::new();
    for k in ["id", "owner", "resource", "candidate", "base", "state", "created_at", "updated_at", "expires_at", "heartbeat_at"] {
        if let Some(x) = v.get(k) {
            m.insert(k.into(), x.clone());
        }
    }
    m.insert("view".into(), json!("contention"));
    Value::Object(m)
}

/// Legacy `_held_by`: the refusal a losing contender reads.
fn held_by(r: &Row, n: &Names, resource: &str, now: i64, suffix: &str) -> String {
    let holder = n.agents.get(&r.owner).cloned().unwrap_or_else(|| "?".into());
    let why = if !r.expired(now) {
        "is already reserved by an active operation"
    } else {
        "lease expired but its heartbeat is active, so it is still an active operation and recovery cannot steal it"
    };
    format!(
        "{resource} {why}{suffix}: held by {holder} since {} (reservation {}, base {}, candidate {}, lease expires {}, last heartbeat {}). Wait for {holder} to release it, or recover it once its lease has expired and its heartbeat is quiet.",
        stamp(r.created),
        r.id,
        r.base,
        r.candidate,
        stamp(r.expires),
        stamp(r.heartbeat)
    )
}

fn opaque_receipt(kind: &str, rid: Uuid) -> String {
    let h = Uuid::new_v4().simple().to_string();
    format!("{kind}:{rid}:{}", &h[..16])
}

// ---------------------------------------------------------------- visibility (r7 §3.3)

pub const ITEM_HEAD_SQL: &str = "SELECT owner_id, creator_id, reviewer_id FROM work_items WHERE org_id = $1 AND item_id = $2";
pub const ITEM_HEAD_SHARE_SQL: &str = "SELECT owner_id, creator_id, reviewer_id FROM work_items WHERE org_id = $1 AND item_id = $2 FOR SHARE";
pub const PARTICIPANT_SQL: &str = "SELECT 1 FROM work_participants WHERE org_id = $1 AND item_id = $2 AND principal_id = $3";
pub const ITEM_BY_NAME_SQL: &str = "SELECT item_id FROM work_items WHERE org_id = $1 AND name = $2";

/// Whether `who` may read `item` (legacy `_work_get_for`, the `actor` facet):
/// owner, creator or named reviewer; a participant; a strict ancestor of the
/// owner (or of the creator while unowned). Archived items still count.
/// `anchor` (a mutation relies on it, C3): the item head `FOR SHARE`, then the
/// owner's chain `FOR SHARE` leaf upward. Otherwise plain reads (a snapshot).
pub async fn item_readable<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, who: Uuid, item: Uuid, anchor: bool) -> Result<bool, CmdError> {
    let head = if anchor {
        tx.exec("reservation.item_head", ITEM_HEAD_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?
    } else {
        tx.exec("reservation.item_head_read", ITEM_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?
    };
    let Some(h) = head.first() else { return Ok(false) };
    let owner = h.first().and_then(Val::as_uuid);
    let creator = h.get(1).and_then(Val::as_uuid);
    let reviewer = h.get(2).and_then(Val::as_uuid);
    if [owner, creator, reviewer].contains(&Some(who)) {
        return Ok(true);
    }
    if !tx.exec("reservation.item_participant", PARTICIPANT_SQL, &[Val::Uuid(org), Val::Uuid(item), Val::Uuid(who)]).await?.is_empty() {
        return Ok(true);
    }
    let Some(base) = owner.or(creator) else { return Ok(false) };
    let mut cur = base;
    let mut seen = BTreeSet::from([base]);
    loop {
        let rows = if anchor {
            tx.exec("reservation.chain_edge", sent::EDGE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        } else {
            tx.exec("reservation.chain_edge_read", sent::EDGE_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        };
        match rows.first().and_then(|r| r.first()).and_then(Val::as_uuid) {
            Some(p) if p == who => return Ok(true),
            Some(p) if seen.insert(p) => cur = p,
            _ => return Ok(false),
        }
    }
}

async fn item_id_of<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, name: &str) -> Result<Option<Uuid>, CmdError> {
    Ok(tx.exec("reservation.item_by_name", ITEM_BY_NAME_SQL, &[Val::Uuid(org), Val::text(name)]).await?.first().and_then(|r| r.first()).and_then(Val::as_uuid))
}

/// Legacy `_visible(row, actor)`: the owner, or a reader of the row's item.
async fn visible<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, r: &Row, who: Uuid, anchor: bool) -> Result<bool, CmdError> {
    if r.owner == who {
        return Ok(true);
    }
    match r.item {
        Some(i) => item_readable(tx, org, who, i, anchor).await,
        None => Ok(false),
    }
}

pub const LIVE_SHARE_SQL: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";

/// The holder's membership `FOR SHARE` for liveness (r7 §3.5.4 step 5).
async fn owner_live<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, who: Uuid) -> Result<bool, CmdError> {
    Ok(tx.exec("reservation.holder_live", LIVE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(who)]).await?.first().and_then(|r| r.first()).and_then(Val::as_text) == Some("live"))
}

fn caller(b: &Binding) -> Result<(Uuid, i64), CmdError> {
    match b.principal {
        Principal::Agent { id, generation } => Ok((id, generation)),
        _ => Err(CmdError::Defect("reservations are an agent-door family".into())),
    }
}

async fn anchor_caller<S: Session>(tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
    let (id, generation) = caller(b)?;
    if let Some(r) = anchor_agent_caller(tx, b.op.org, id, generation).await? {
        return Err(CmdError::Refused(r));
    }
    Ok(())
}

// ---------------------------------------------------------------- SQL

pub const BY_KEY_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND integration_key = $2";
pub const COUNT_HELD_SQL: &str = "SELECT count(*) FROM resource_reservations WHERE org_id = $1 AND state = 'held'";
pub const COUNT_ALL_SQL: &str = "SELECT count(*) FROM resource_reservations WHERE org_id = $1";
pub const HOLDER_LOCK_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND resource = $2 AND state = 'held' FOR UPDATE";
pub const ROW_LOCK_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND reservation_id = $2 FOR UPDATE";
pub const ROW_READ_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND reservation_id = $2";
pub const MARK_STALE_SQL: &str = "UPDATE resource_reservations SET state = 'stale', stale_reason = 'candidate_or_base_changed', updated_at = $3 \
    WHERE org_id = $1 AND reservation_id = $2";
pub const MARK_RECOVERED_SQL: &str = "UPDATE resource_reservations SET state = 'recovered', recovered_by = $3, recovery_reason = $4, updated_at = $5 \
    WHERE org_id = $1 AND reservation_id = $2";
pub const INSERT_SQL: &str = "INSERT INTO resource_reservations (org_id, reservation_id, owner_id, item_id, resource, candidate, base, paths, state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s, stale_s, integration_key, owner_label) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, ARRAY(SELECT jsonb_array_elements_text($8::jsonb)), 'held', $9, $9, $10, $9, ($11::text)::double precision, \
    ($12::text)::double precision, $13, $14)";
pub const RENEW_SQL: &str = "UPDATE resource_reservations SET expires_at = $3, heartbeat_at = $4, updated_at = $4 WHERE org_id = $1 AND reservation_id = $2";
pub const RELEASE_SQL: &str = "UPDATE resource_reservations SET state = 'released', release_receipt = to_jsonb($3::text), successor_id = $4, updated_at = $5 \
    WHERE org_id = $1 AND reservation_id = $2";
pub const LAND_SQL: &str = "UPDATE resource_reservations SET state = 'landed', integration_receipt = to_jsonb($3::text), integration_key = $4, landed_at = $5, updated_at = $5 \
    WHERE org_id = $1 AND reservation_id = $2";
pub const OWNER_NAME_SQL: &str = "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2";

async fn lock_row<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, rid: Uuid) -> Result<Option<Row>, CmdError> {
    // Q-R4 unsafe control: the row is read WITHOUT its lock (a lost update or
    // a double transition follows under a racing writer).
    let rows = if controls::fire(&tx.scope(), "Q-R4.no_row_lock") {
        tx.exec("reservation.row_read", ROW_READ_SQL, &[Val::Uuid(org), Val::Uuid(rid)]).await?
    } else {
        tx.exec("reservation.row_lock", ROW_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(rid)]).await?
    };
    Ok(rows_of(&rows)?.into_iter().next())
}

fn rid_arg(v: Option<&Value>) -> Result<Uuid, Refusal> {
    let s = text_arg(v, "reservation", 80)?;
    s.parse::<Uuid>().map_err(|_| refuse("no such reservation"))
}

// ---------------------------------------------------------------- acquire

/// `reservation.acquire` (r7 §3.5.4), READ COMMITTED in C4 order.
pub struct Acquire {
    pub args: Value,
    /// The new row's id, minted once per request by the door.
    pub reservation_id: Uuid,
}

impl Command for Acquire {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &RESERVATION
    }
    fn verb(&self) -> &'static str {
        "acquire"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor_caller(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let (me, _) = caller(b)?;
        let a = &self.args;
        macro_rules! arg {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(r) => return Ok(Decided::Refused(r)),
                }
            };
        }
        let resource = arg!(text_arg(a.get("resource"), "resource", MAX_RESOURCE_LENGTH));
        let candidate = arg!(sha_arg(a.get("candidate"), "candidate"));
        let base = arg!(sha_arg(a.get("base"), "base"));
        let item_name = match a.get("item") {
            Some(v) if !(v.is_null() || v.as_str() == Some("")) => Some(arg!(text_arg(Some(v), "item", MAX_ITEM_LENGTH))),
            _ => None,
        };
        // 2. the caller's item-visibility anchors (C3)
        let mut item: Option<Uuid> = None;
        if let Some(n) = &item_name {
            let id = item_id_of(tx, org, n).await?;
            let anchored = !controls::fire(&tx.scope(), "Q-C3.no_item_anchor");
            let ok = match id {
                Some(i) => item_readable(tx, org, me, i, anchored).await?,
                None => false,
            };
            if !ok {
                return Ok(Decided::Refused(refuse("reservation is not visible to this collaborator")));
            }
            item = id;
        }
        let paths = arg!(paths_arg(a.get("paths")));
        let key = a.get("integration_key").and_then(|v| v.as_str().map(|s| s.trim().to_string()).or_else(|| (!v.is_null()).then(|| v.to_string()))).unwrap_or_default();
        if key.chars().count() > 200 {
            return Ok(Decided::Refused(refuse("integration_key is limited to 200 characters")));
        }
        let lease = num_arg(a.get("lease_s"), DEFAULT_LEASE_S);
        let stale_s = num_arg(a.get("stale_s"), DEFAULT_STALE_S);
        // D12: finite and bounded (NaN and inf refuse here)
        if !(lease > 0.0 && lease <= MAX_LEASE_S && stale_s > 0.0 && stale_s <= MAX_LEASE_S) {
            return Ok(Decided::Refused(refuse("lease_s and stale_s must be positive and bounded")));
        }
        // 3. integration key: point read by K2; replay or refuse
        if !key.is_empty() {
            let rows = rows_of(&tx.exec("reservation.by_key", BY_KEY_SQL, &[Val::Uuid(org), Val::text(key.clone())]).await?)?;
            if let Some(old) = rows.first() {
                if !(old.resource == resource && old.same_scope(&candidate, &base)) {
                    return Ok(Decided::Refused(refuse("integration_key already identifies a different reservation")));
                }
                if !visible(tx, org, old, me, true).await? {
                    return Ok(Decided::Refused(refuse("reservation is not visible to this collaborator")));
                }
                let n = names_for(tx, org, &[old]).await?;
                return Ok(Decided::Applied(json!({"reservation": safe(old, &n), "replayed": true})));
            }
        }
        // 4. the D1 cap: HELD claims only, counted without a lock
        let count_sql = if controls::fire(&tx.scope(), "Q-R8.count_all_rows") { COUNT_ALL_SQL } else { COUNT_HELD_SQL };
        let n_held = tx.exec("reservation.count", count_sql, &[Val::Uuid(org)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        tx.pause("after_count").await?;
        if n_held >= MAX_ACTIVE {
            return Ok(Decided::Refused(refuse(format!("reservation store is limited to {MAX_ACTIVE} records"))));
        }
        // 5. the current HELD row (K1 point lookup) FOR UPDATE, then the clock
        let holders = rows_of(&tx.exec("reservation.holder_lock", HOLDER_LOCK_SQL, &[Val::Uuid(org), Val::text(resource.clone())]).await?)?;
        tx.pause("after_holder_lock").await?;
        let now = tx.now().await?;
        for old in &holders {
            let same = old.same_scope(&candidate, &base);
            if same && !old.expired(now) && old.owner == me {
                let n = names_for(tx, org, &[old]).await?;
                return Ok(Decided::Applied(json!({"reservation": safe(old, &n), "replayed": true})));
            }
            let live = owner_live(tx, org, old.owner).await?;
            let old_stale = old.stale_s;
            let recoverable = !old.active_heartbeat(now, old_stale) && (old.expired(now) || !live);
            if !recoverable {
                let n = names_for(tx, org, &[old]).await?;
                let suffix = if same { "" } else { "; a changed candidate or base cannot steal it either" };
                return Ok(Decided::Refused(refuse(held_by(old, &n, &resource, now, suffix))));
            }
            if !same {
                tx.exec("reservation.mark_stale", MARK_STALE_SQL, &[Val::Uuid(org), Val::Uuid(old.id), Val::Ts(now)]).await?;
                continue;
            }
            let why = if old.expired(now) { "lease_expired" } else { "owner_not_live" };
            tx.exec("reservation.mark_recovered", MARK_RECOVERED_SQL, &[Val::Uuid(org), Val::Uuid(old.id), Val::Uuid(me), Val::text(why), Val::Ts(now)]).await?;
        }
        // 6. insert the new HELD row
        let label = tx.exec("reservation.owner_label", OWNER_NAME_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string));
        let _ = controls::fire(&tx.scope(), "Q-R1.no_k1");
        let _ = controls::fire(&tx.scope(), "Q-R3.no_k2");
        let expires = now + (lease * 1e6).round() as i64;
        tx.exec(
            "reservation.insert",
            INSERT_SQL,
            &[
                Val::Uuid(org),
                Val::Uuid(self.reservation_id),
                Val::Uuid(me),
                Val::opt_uuid(item),
                Val::text(resource),
                Val::text(candidate),
                Val::text(base),
                Val::Json(json!(paths)),
                Val::Ts(now),
                Val::Ts(expires),
                Val::text(format!("{lease}")),
                Val::text(format!("{stale_s}")),
                if key.is_empty() { Val::Null } else { Val::text(key) },
                label.map(Val::text).unwrap_or(Val::Null),
            ],
        )
        .await?;
        let row = rows_of(&tx.exec("reservation.row_read", ROW_READ_SQL, &[Val::Uuid(org), Val::Uuid(self.reservation_id)]).await?)?
            .into_iter()
            .next()
            .ok_or_else(|| CmdError::Defect("inserted reservation not visible".into()))?;
        let n = names_for(tx, org, &[&row]).await?;
        Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "replayed": false})))
    }
}

// ---------------------------------------------------------------- id-bearing writers

/// The id-bearing actions: renew, recover, release (with or without a
/// successor), land, invalidate (r7 §3.5.6-3.5.11).
pub struct RowAction {
    pub action: &'static str,
    pub args: Value,
    /// release-notify: the notice's message id, minted once per request.
    pub message_id: Uuid,
    /// release-notify: the successor, resolved by the door from its name.
    pub successor: Option<Uuid>,
}

impl RowAction {
    pub fn new(action: &'static str, args: Value) -> RowAction {
        RowAction { action, args, message_id: Uuid::new_v4(), successor: None }
    }
}

impl Command for RowAction {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &RESERVATION
    }
    fn verb(&self) -> &'static str {
        match (self.action, self.successor.is_some()) {
            ("release", true) => "release_notify",
            (a, _) => a,
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor_caller(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let (me, _) = caller(b)?;
        let a = &self.args;
        let rid = match rid_arg(a.get("reservation")) {
            Ok(r) => r,
            Err(r) => return Ok(Decided::Refused(r)),
        };
        let Some(row) = lock_row(tx, org, rid).await? else {
            return Ok(Decided::Refused(refuse("no such reservation")));
        };
        tx.pause("after_row_lock").await?;
        let seen = visible(tx, org, &row, me, true).await?;
        let owner_only = matches!(self.action, "renew" | "release" | "land");
        if !(self.action == "recover" && row.state == "held") {
            if owner_only {
                // D3: the owner is the principal. Q-R9's unsafe control compares
                // the caller's current NAME with the name recorded at acquire.
                let is_owner = if controls::fire(&tx.scope(), "Q-R9.owner_by_name") {
                    let mine = tx.exec("reservation.owner_label", OWNER_NAME_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string));
                    mine.is_some() && mine == row.owner_label
                } else {
                    row.owner == me
                };
                if !is_owner {
                    return Ok(Decided::Refused(refuse("only the reservation owner may perform this action")));
                }
            } else if !seen {
                return Ok(Decided::Refused(refuse("reservation is not visible to this collaborator")));
            }
        }
        let now = tx.now().await?;
        match self.action {
            "invalidate" => {
                let candidate = match sha_arg(a.get("candidate"), "candidate") {
                    Ok(v) => v,
                    Err(r) => return Ok(Decided::Refused(r)),
                };
                let base = match sha_arg(a.get("base"), "base") {
                    Ok(v) => v,
                    Err(r) => return Ok(Decided::Refused(r)),
                };
                if row.terminal() {
                    let n = names_for(tx, org, &[&row]).await?;
                    return Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "replayed": true})));
                }
                if row.same_scope(&candidate, &base) {
                    return Ok(Decided::Refused(refuse("candidate and base are unchanged")));
                }
                if !row.expired(now) || row.active_heartbeat(now, row.stale_s) {
                    return Ok(Decided::Refused(refuse("reservation is active; changed candidate or base cannot steal it")));
                }
                tx.exec("reservation.mark_stale", MARK_STALE_SQL, &[Val::Uuid(org), Val::Uuid(rid), Val::Ts(now)]).await?;
                let row = reread(tx, org, rid).await?;
                let n = names_for(tx, org, &[&row]).await?;
                Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "stale": true})))
            }
            "renew" => {
                if row.state != "held" {
                    return Ok(Decided::Refused(refuse("only a held reservation can be renewed")));
                }
                let lease = num_arg(a.get("lease_s"), DEFAULT_LEASE_S);
                if !(lease > 0.0 && lease <= MAX_LEASE_S) {
                    return Ok(Decided::Refused(refuse("lease_s must be positive and bounded")));
                }
                let expires = now + (lease * 1e6).round() as i64;
                tx.exec("reservation.renew", RENEW_SQL, &[Val::Uuid(org), Val::Uuid(rid), Val::Ts(expires), Val::Ts(now)]).await?;
                let row = reread(tx, org, rid).await?;
                let n = names_for(tx, org, &[&row]).await?;
                Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "renewed": true})))
            }
            "recover" => {
                if row.state != "held" {
                    return Ok(Decided::Refused(refuse("only a held reservation can be recovered")));
                }
                // Only the stored threshold counts (a shorter caller value is ignored).
                if row.active_heartbeat(now, row.stale_s) {
                    return Ok(Decided::Refused(refuse("reservation heartbeat is active; recovery cannot steal an active operation")));
                }
                let live = owner_live(tx, org, row.owner).await?;
                if !row.expired(now) && live {
                    return Ok(Decided::Refused(refuse("reservation is still leased; recovery cannot steal an active operation")));
                }
                let why = if row.expired(now) { "lease_expired" } else { "owner_not_live" };
                tx.exec("reservation.mark_recovered", MARK_RECOVERED_SQL, &[Val::Uuid(org), Val::Uuid(rid), Val::Uuid(me), Val::text(why), Val::Ts(now)]).await?;
                let row = reread(tx, org, rid).await?;
                let n = names_for(tx, org, &[&row]).await?;
                let proj = if seen { safe(&row, &n) } else { contention(&row, &n) };
                Ok(Decided::Applied(json!({"reservation": proj, "recovered": true})))
            }
            "release" => self.release(tx, org, me, row, now, b).await,
            "land" => {
                if row.state != "held" {
                    if row.state == "landed" {
                        let n = names_for(tx, org, &[&row]).await?;
                        return Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "replayed": true})));
                    }
                    return Ok(Decided::Refused(refuse("only a held reservation can record a landing")));
                }
                let cand_v = a.get("candidate").filter(|v| !v.is_null() && v.as_str() != Some("")).cloned().unwrap_or(json!(row.candidate));
                let base_v = a.get("base").filter(|v| !v.is_null() && v.as_str() != Some("")).cloned().unwrap_or(json!(row.base));
                let candidate = match sha_arg(Some(&cand_v), "candidate") {
                    Ok(v) => v,
                    Err(r) => return Ok(Decided::Refused(r)),
                };
                let base = match sha_arg(Some(&base_v), "base") {
                    Ok(v) => v,
                    Err(r) => return Ok(Decided::Refused(r)),
                };
                if !row.same_scope(&candidate, &base) {
                    // Legacy marks the in-memory row stale and then aborts, so the
                    // HELD row survives: native writes nothing. Q-R7's unsafe
                    // control commits the stale mark and answers the refusal text.
                    if controls::fire(&tx.scope(), "Q-R7.stale_mark_committed") {
                        tx.exec("reservation.mark_stale", MARK_STALE_SQL, &[Val::Uuid(org), Val::Uuid(rid), Val::Ts(now)]).await?;
                        return Ok(Decided::Applied(json!({"error": "candidate or base changed; reservation is stale"})));
                    }
                    return Ok(Decided::Refused(refuse("candidate or base changed; reservation is stale")));
                }
                let key = a
                    .get("integration_key")
                    .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .or_else(|| row.integration_key.clone())
                    .unwrap_or_default();
                if !key.is_empty() {
                    let others = rows_of(&tx.exec("reservation.by_key", BY_KEY_SQL, &[Val::Uuid(org), Val::text(key.clone())]).await?)?;
                    if let Some(old) = others.iter().find(|o| o.id != rid) {
                        if old.state == "landed" {
                            let n = names_for(tx, org, &[old]).await?;
                            return Ok(Decided::Applied(json!({"reservation": safe(old, &n), "replayed": true})));
                        }
                        return Ok(Decided::Refused(refuse("integration_key already identifies a different reservation")));
                    }
                }
                let receipt = opaque_receipt("land", rid);
                let _ = controls::fire(&tx.scope(), "Q-R3.no_k2");
                tx.exec(
                    "reservation.land",
                    LAND_SQL,
                    &[Val::Uuid(org), Val::Uuid(rid), Val::text(receipt.clone()), if key.is_empty() { Val::Null } else { Val::text(key) }, Val::Ts(now)],
                )
                .await?;
                let row = reread(tx, org, rid).await?;
                let n = names_for(tx, org, &[&row]).await?;
                Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "integration_receipt": receipt, "landed": true})))
            }
            other => Err(CmdError::Defect(format!("unknown reservation action {other}"))),
        }
    }
}

async fn reread<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, rid: Uuid) -> Result<Row, CmdError> {
    rows_of(&tx.exec("reservation.row_read", ROW_READ_SQL, &[Val::Uuid(org), Val::Uuid(rid)]).await?)?
        .into_iter()
        .next()
        .ok_or_else(|| CmdError::Defect("reservation vanished".into()))
}

impl RowAction {
    /// `release` (r7 §3.5.9) and `release-notify` (§3.5.10): one transaction
    /// holding the release, the Sent record to the successor, the reply
    /// grant when the route implies one, and the successor's epoch bump.
    async fn release<S: Session>(&self, tx: &mut Tx<'_, S>, org: Uuid, me: Uuid, row: Row, now: i64, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let rid = row.id;
        if row.state != "held" {
            if row.state == "released" {
                let n = names_for(tx, org, &[&row]).await?;
                return Ok(Decided::Applied(json!({"reservation": safe(&row, &n), "replayed": true, "notified": Value::Null})));
            }
            return Ok(Decided::Refused(refuse("only a held reservation can be released")));
        }
        let receipt = opaque_receipt("release", rid);
        let mut warnings: Vec<String> = Vec::new();
        let mut grant_pending = false;
        if let Some(succ) = self.successor {
            // 2-3: the successor's liveness and its readability of the item (C3
            // anchors); an empty item refuses (legacy adapter). The liveness
            // read here is unlocked, for legacy's refusal order only: the
            // successor's epoch row is locked ONCE, by the addressing below
            // (FOR SHARE, or FOR NO KEY UPDATE when a grant is predicted), and
            // liveness is confirmed from that locked read. A share lock here
            // would be upgraded there (Q-AM1 (ii)'s deadlock).
            let live_now = tx.exec("reservation.successor_live", "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(succ)]).await?;
            if live_now.first().and_then(|r| r.first()).and_then(Val::as_text) != Some("live") {
                return Ok(Decided::Refused(refuse("successor is not a live collaborator")));
            }
            let readable = match row.item {
                Some(i) => item_readable(tx, org, succ, i, true).await?,
                None => false,
            };
            if !readable {
                return Ok(Decided::Refused(refuse("successor is not a live collaborator")));
            }
            // 4-6: legacy post_mail addressing with C4-ordered anchors, the
            // grant (unique key) and the successor's epoch bump (WS5 Sent).
            // Q-R6 control (1): the grant is left to a SEPARATE later
            // transaction (the crash between is the schedule's).
            let grant_later = controls::fire(&tx.scope(), "Q-R6.grant_after_release");
            let addressed = match sent::address_agent(tx, org, me, succ, !grant_later).await {
                Ok(x) => x,
                Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
                Err(e) => return Err(e.into()),
            };
            if addressed.recipient.lifecycle != sent::Lifecycle::Live {
                return Ok(Decided::Refused(refuse("successor is not a live collaborator")));
            }
            grant_pending = grant_later && addressed.route.reply_grant_possible();
            let body = format!("Reservation {rid} was released; its release receipt is {receipt}.");
            let req = SendRequest::message(sent::MailSource::Agent { principal: me }, addressed.recipient.dest.clone(), self.message_id, "status", body, format!("reservation.release:{}:{}", b.op.key, succ))
                .with_grant(addressed.grant.clone());
            let rec = match sent::record_sent(tx, &req).await {
                Ok(r) => r,
                Err(SendError::Refused(r)) => return Ok(Decided::Refused(r)),
                Err(e) => return Err(e.into()),
            };
            if rec.grant_inserted {
                let sname = tx.exec("reservation.name", AGENT_NAME_SQL, &[Val::Uuid(org), Val::Uuid(succ)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)).unwrap_or_default();
                let mname = tx.exec("reservation.name", AGENT_NAME_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)).unwrap_or_default();
                warnings.push(format!("audience granted: {sname} may now reply to {mname} directly"));
            }
        }
        tx.exec("reservation.release", RELEASE_SQL, &[Val::Uuid(org), Val::Uuid(rid), Val::text(receipt.clone()), Val::opt_uuid(self.successor), Val::Ts(now)]).await?;
        let row = reread(tx, org, rid).await?;
        let n = names_for(tx, org, &[&row]).await?;
        let notified = row.successor.map(|s| json!(n.agents.get(&s).cloned().unwrap_or_else(|| s.to_string()))).unwrap_or(Value::Null);
        let mut out = json!({"reservation": safe(&row, &n), "released": true, "release_receipt": receipt, "notified": notified});
        if !warnings.is_empty() {
            out["warnings"] = json!(warnings);
        }
        if grant_pending {
            out["grant_pending"] = json!(true);
        }
        Ok(Decided::Applied(out))
    }
}

// ---------------------------------------------------------------- list-scope (conditional write)

pub const LIST_HELD_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND state = 'held' AND ($2::text IS NULL OR resource = $2::text) ORDER BY reservation_id";
pub const LIST_ALL_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND ($2::text IS NULL OR resource = $2::text) ORDER BY created_at, reservation_id";
pub const LIST_ALL_SHARE_SQL: &str = "SELECT reservation_id, owner_id, item_id, resource, candidate, base, to_jsonb(paths), state, \
    created_at, updated_at, expires_at, heartbeat_at, lease_s::text, stale_s::text, integration_key, \
    release_receipt, integration_receipt, successor_id, recovery_reason, stale_reason, recovered_by, landed_at, owner_label \
    FROM resource_reservations WHERE org_id = $1 AND ($2::text IS NULL OR resource = $2::text) ORDER BY created_at, reservation_id FOR SHARE";
pub const PROVISIONAL_CLOCK_SQL: &str = "SELECT clock_timestamp()";

/// `list` with `candidate`/`base` (r7 §3.5.2): two passes in one READ
/// COMMITTED transaction. Pass 1 (no locks) selects HELD rows whose scope
/// differs and that look eligible at a provisional time; pass 2 locks only
/// those, in id order, takes their visibility anchors, reads the attempt
/// clock and re-checks every predicate on the locked version.
pub struct ListScope {
    pub args: Value,
}

impl Command for ListScope {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &RESERVATION
    }
    fn verb(&self) -> &'static str {
        "list_scope"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor_caller(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let (me, _) = caller(b)?;
        let a = &self.args;
        let resource = a.get("resource").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        let candidate = match sha_arg(a.get("candidate"), "candidate") {
            Ok(v) => v,
            Err(r) => return Ok(Decided::Refused(r)),
        };
        let base = match sha_arg(a.get("base"), "base") {
            Ok(v) => v,
            Err(r) => return Ok(Decided::Refused(r)),
        };
        let res_v = resource.clone().map(Val::text).unwrap_or(Val::Null);
        // pass 1: provisional time, no locks
        let t0 = tx.exec("reservation.provisional_clock", PROVISIONAL_CLOCK_SQL, &[]).await?.first().and_then(|r| r.first()).and_then(Val::as_ts).unwrap_or(0);
        let held = rows_of(&tx.exec("reservation.list_held", LIST_HELD_SQL, &[Val::Uuid(org), res_v.clone()]).await?)?;
        let eligible: Vec<Uuid> = held
            .iter()
            .filter(|r| !r.same_scope(&candidate, &base) && r.expired(t0) && !r.active_heartbeat(t0, r.stale_s))
            .map(|r| r.id)
            .collect();
        tx.pause("after_pass1").await?;
        // pass 2: lock only those rows, anchor visibility, then the clock, re-check
        let mut locked = Vec::new();
        for id in &eligible {
            if let Some(r) = lock_row(tx, org, *id).await? {
                locked.push(r);
            }
        }
        let now = tx.now().await?;
        let no_recheck = controls::fire(&tx.scope(), "Q-R5.no_recheck");
        let mut stale: Vec<String> = Vec::new();
        for r in &locked {
            if !visible(tx, org, r, me, true).await? {
                continue;
            }
            let eligible_now = r.state == "held" && !r.same_scope(&candidate, &base) && r.expired(now) && !r.active_heartbeat(now, r.stale_s);
            if !(no_recheck || eligible_now) {
                continue;
            }
            tx.exec("reservation.mark_stale", MARK_STALE_SQL, &[Val::Uuid(org), Val::Uuid(r.id), Val::Ts(now)]).await?;
            stale.push(r.id.to_string());
        }
        // the projection: ONE statement, seeing this transaction's own changes
        let all = rows_of(&tx.exec("reservation.list_all", LIST_ALL_SQL, &[Val::Uuid(org), res_v]).await?)?;
        let (out, truncated) = project(tx, org, me, &all, resource.is_some(), false).await?;
        let mut v = json!({"reservations": out, "count": out.len(), "stale": stale});
        if truncated {
            v["truncated"] = json!(true);
        }
        Ok(Decided::Applied(v))
    }
}

/// Visible rows as `_safe`, invisible HELD rows as contention when a
/// resource was named; then D2's bound.
async fn project<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, me: Uuid, all: &[Row], named: bool, _read: bool) -> Result<(Vec<Value>, bool), CmdError> {
    let mut picked: Vec<(&Row, bool)> = Vec::new();
    for r in all {
        if visible(tx, org, r, me, false).await? {
            picked.push((r, true));
        } else if named && r.state == "held" {
            picked.push((r, false));
        }
    }
    let (kept, truncated) = bound(&tx.scope(), picked);
    let refs: Vec<&Row> = kept.iter().map(|(r, _)| *r).collect();
    let n = names_for(tx, org, &refs).await?;
    Ok((kept.iter().map(|(r, full)| if *full { safe(r, &n) } else { contention(r, &n) }).collect(), truncated))
}

/// D2 (approved): at most 512 rows in legacy insertion order; when rows must
/// go, the OLDEST TERMINAL rows go first; if HELD rows alone exceed 512, the
/// first 512 HELD in insertion order. Controls: `Q-R11.unbounded` returns
/// everything; `Q-R11.truncate_wrong_end` keeps the oldest 512.
fn bound<'a, T>(scope: &crate::hooks::Scope<'_>, rows: Vec<(&'a Row, T)>) -> (Vec<(&'a Row, T)>, bool) {
    if controls::fire(scope, "Q-R11.unbounded") || rows.len() <= MAX_ROWS_OUT {
        return (rows, false);
    }
    if controls::fire(scope, "Q-R11.truncate_wrong_end") {
        let mut rows = rows;
        rows.truncate(MAX_ROWS_OUT);
        return (rows, true);
    }
    let held = rows.iter().filter(|(r, _)| r.state == "held").count();
    let mut drop_terminal = rows.len() - MAX_ROWS_OUT;
    let mut held_kept = 0usize;
    let mut out = Vec::with_capacity(MAX_ROWS_OUT);
    for (r, t) in rows {
        if r.state == "held" {
            if held_kept < MAX_ROWS_OUT {
                held_kept += 1;
                out.push((r, t));
            }
        } else if drop_terminal > 0 {
            drop_terminal -= 1;
        } else if held <= MAX_ROWS_OUT {
            out.push((r, t));
        }
    }
    out.truncate(MAX_ROWS_OUT);
    (out, true)
}

// ---------------------------------------------------------------- reads (C5 protected reads)

/// `list` without a scope (`reservation.list-read`), `landing` and
/// `overlap`, each one snapshot for `me` (the claim is registered by the
/// caller of `Executor::read` before and emitted through after, C5).
pub struct ReservationRead {
    pub org: Uuid,
    pub me: Uuid,
    pub action: &'static str,
    pub args: Value,
}

impl Read for ReservationRead {
    type Output = Result<Value, Refusal>;
    fn family(&self) -> &'static str {
        "reservation"
    }
    fn verb(&self) -> &'static str {
        self.action
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let (org, me, a) = (self.org, self.me, &self.args);
        match self.action {
            "list" => {
                let resource = a.get("resource").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
                let all = rows_of(&tx.exec("reservation.list_all", LIST_ALL_SQL, &[Val::Uuid(org), resource.clone().map(Val::text).unwrap_or(Val::Null)]).await?)?;
                tx.pause("after_snapshot").await?;
                let (out, truncated) = project(tx, org, me, &all, resource.is_some(), true).await?;
                let mut v = json!({"reservations": out, "count": out.len(), "stale": []});
                if truncated {
                    v["truncated"] = json!(true);
                }
                Ok(Ok(v))
            }
            "landing" => {
                let name = match text_arg(a.get("item"), "item", MAX_ITEM_LENGTH) {
                    Ok(v) => v,
                    Err(r) => return Ok(Err(r)),
                };
                let item = item_id_of(tx, org, &name).await?;
                let all = rows_of(&tx.exec("reservation.list_all", LIST_ALL_SQL, &[Val::Uuid(org), Val::Null]).await?)?;
                let mut picked = Vec::new();
                for r in all.iter().filter(|r| item.is_some() && r.item == item && r.state == "landed") {
                    if visible(tx, org, r, me, false).await? {
                        picked.push((r, true));
                    }
                }
                let readable = match item {
                    Some(i) => item_readable(tx, org, me, i, false).await?,
                    None => false,
                };
                if picked.is_empty() && !readable {
                    return Ok(Err(refuse("reservation is not visible to this collaborator")));
                }
                let (kept, truncated) = bound(&tx.scope(), picked);
                let refs: Vec<&Row> = kept.iter().map(|(r, _)| *r).collect();
                let n = names_for(tx, org, &refs).await?;
                let out: Vec<Value> = kept.iter().map(|(r, _)| safe(r, &n)).collect();
                let mut v = json!({"landed": out, "count": out.len()});
                if truncated {
                    v["truncated"] = json!(true);
                }
                Ok(Ok(v))
            }
            "overlap" => {
                let paths = match paths_arg(a.get("paths")) {
                    Ok(v) => v,
                    Err(r) => return Ok(Err(r)),
                };
                let name = match text_arg(a.get("item"), "item", MAX_ITEM_LENGTH) {
                    Ok(v) => v,
                    Err(r) => return Ok(Err(r)),
                };
                let item = item_id_of(tx, org, &name).await?;
                let readable = match item {
                    Some(i) => item_readable(tx, org, me, i, false).await?,
                    None => false,
                };
                if !readable {
                    return Ok(Err(refuse("reservation is not visible to this collaborator")));
                }
                let resource = a.get("resource").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
                let all = rows_of(&tx.exec("reservation.list_all", LIST_ALL_SQL, &[Val::Uuid(org), resource.map(Val::text).unwrap_or(Val::Null)]).await?)?;
                let overlaps = |x: &str, y: &str| {
                    let (xx, yy) = (x.trim_end_matches('/'), y.trim_end_matches('/'));
                    xx == yy || xx.starts_with(&format!("{yy}/")) || yy.starts_with(&format!("{xx}/"))
                };
                let mut hits: Vec<(&Row, Vec<String>)> = Vec::new();
                for r in all.iter().filter(|r| r.item == item) {
                    if !visible(tx, org, r, me, false).await? {
                        continue;
                    }
                    let hit: Vec<String> = paths.iter().filter(|p| r.paths.iter().any(|q| overlaps(p, q))).cloned().collect();
                    if !hit.is_empty() {
                        hits.push((r, hit));
                    }
                }
                let refs: Vec<&Row> = hits.iter().map(|(r, _)| *r).collect();
                let n = names_for(tx, org, &refs).await?;
                let out: Vec<Value> = hits.iter().map(|(r, h)| json!({"reservation": safe(r, &n), "overlap": h})).collect();
                Ok(Ok(json!({"overlaps": out, "count": out.len()})))
            }
            other => Err(CmdError::Defect(format!("unknown reservation read {other}"))),
        }
    }
}

/// Q-R10's unsafe control: the same list read taking row locks, which a
/// read-only snapshot cannot, so it runs as a READ COMMITTED command with
/// `FOR SHARE` on every row it reads — writers then wait on readers.
pub struct LockingList {
    pub args: Value,
}

impl Command for LockingList {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &RESERVATION
    }
    fn verb(&self) -> &'static str {
        "list_locking"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor_caller(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let (me, _) = caller(b)?;
        let _ = controls::fire(&tx.scope(), "Q-R10.reads_lock_rows");
        let resource = self.args.get("resource").and_then(Value::as_str).map(str::to_string);
        let all = rows_of(&tx.exec("reservation.list_all_share", LIST_ALL_SHARE_SQL, &[Val::Uuid(org), resource.clone().map(Val::text).unwrap_or(Val::Null)]).await?)?;
        tx.pause("after_snapshot").await?;
        let (out, _) = project(tx, org, me, &all, resource.is_some(), true).await?;
        Ok(Decided::Applied(json!({"reservations": out, "count": out.len(), "stale": []})))
    }
}

/// DECLARED-CONTACTS for the reservation verbs.
pub fn declared() -> Value {
    let anchors = json!({
        "authority_epoch": {"modes": ["read", "for_share"], "required": true},
        "org_controls": {"modes": ["read", "for_share"], "required": true},
        "operation_receipts": {"modes": ["read", "write"], "required": true},
        "agents": {"modes": ["read"], "required": false},
        "work_items": {"modes": ["read", "for_share"], "required": false},
        "work_participants": {"modes": ["read"], "required": false},
        "topology_edges": {"modes": ["read", "for_share"], "required": false}
    });
    let with = |extra: Value| {
        let mut m = anchors.clone();
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        m
    };
    let row = json!({"resource_reservations": {"modes": ["read", "for_update", "write"], "required": true}});
    let reads = json!({
        "resource_reservations": {"modes": ["read"], "required": true},
        "agents": {"modes": ["read"], "required": false},
        "work_items": {"modes": ["read"], "required": false},
        "work_participants": {"modes": ["read"], "required": false},
        "topology_edges": {"modes": ["read"], "required": false}
    });
    let mut out = json!({});
    for v in ["acquire", "renew", "recover", "release", "land", "invalidate", "list_scope"] {
        out[format!("reservation.{v}")] = json!({"relations": with(row.clone()), "p01_contract": format!("reservation.{}", v.replace('_', "-")), "source": "r7 §3.5"});
    }
    out["reservation.release_notify"] = json!({
        "relations": with(json!({
            "resource_reservations": {"modes": ["read", "for_update", "write"], "required": true},
            "mailboxes": {"modes": ["read"], "required": true},
            "mail_sent": {"modes": ["read", "write"], "required": true},
            "outgoing_intents": {"modes": ["write"], "required": true},
            "audience_grants": {"modes": ["read", "for_share", "write"], "required": false}
        })),
        "p01_contract": "reservation.release-notify",
        "source": "r7 §3.5.10 (one transaction: release, Sent, grant, epoch bump)"
    });
    for v in ["list", "landing", "overlap"] {
        out[format!("reservation.{v}")] = json!({"relations": reads, "p01_contract": format!("reservation.{}", if v == "list" { "list-read" } else { v }), "source": "r7 §3.5.1/3.5.3/3.5.5: one snapshot"});
    }
    out
}
