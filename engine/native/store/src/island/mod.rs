//! The SERIALIZABLE island's shared helpers (r7 C2a, C3, C4; S3 §3.1, §3.2).
//!
//! **Owner: WS3b (p03-ws3b-topology).** WS3a (staffing, operator hire,
//! quick staff) and WS3b's lifecycle writers both build on this module; WS3a
//! asks for changes by mail. Every helper takes any [`Tx`] (island or not):
//! a schedule's unsafe control may run one of them outside the island (Q-ST4
//! runs the name probe in a separate READ COMMITTED read), so none of them
//! assumes the transaction's isolation.
//!
//! What lives here:
//! * the island's retry allowlist ([`ISLAND_RETRY_UNIQUE`]);
//! * the caller anchor ([`anchor_caller`], C3 / C4 step 1);
//! * authority-epoch locks and version bumps ([`lock_epoch`], [`bump_audience`],
//!   [`bump_requests`]; C2a P1, P5, P7);
//! * the C3 ancestor walk ([`chain_up`]), children and subtree listings;
//! * scope rows locked top-down ([`lock_scope_rows`], C2a P3, C4 step 4);
//! * org control rows `FOR SHARE` ([`share_controls`], C2a P6);
//! * the in-transaction name resolver and the legacy suffix probe
//!   ([`resolve_name`], [`free_name_suffix`]; plan decision 8);
//! * DECLARED-CONTACTS builders ([`declared`]).
//!
//! The P8 mailbox head locks are WS5's (`mail::mailbox`), and the P2
//! capacity SQL is WS4's (`funding`): island writers call those, never copies.

use std::collections::BTreeMap;

use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Principal, Refusal};
use crate::mail::doors::anchor_agent_caller;
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

pub mod declared;

/// `23505` constraints an island family retries on, in addition to the
/// executor's global allowlist (C1, C4 conflict detectors):
/// * `agent_names_active`: two writers of one name (hire, rename, the
///   namesake hire) collide on the unique name namespace (S3 §4.8);
/// * `folder_move_intents_one_pending`: two renames of one stack (S3 §4.8
///   "ordered by a unique index that allows one pending intent per stack");
/// * `lineage_bearers_generation`: two splits of one seat minting the same
///   generation.
pub const ISLAND_RETRY_UNIQUE: &[&str] = &["agent_names_active", "folder_move_intents_one_pending", "lineage_bearers_generation"];

/// Depth bound on any walk (a cycle is a defect, never an infinite loop).
pub const MAX_WALK: usize = 256;

// ---------------------------------------------------------------- SQL

pub const EPOCH_READ_SQL: &str = "SELECT lifecycle, generation, halted, version FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const EPOCH_SHARE_SQL: &str = "SELECT lifecycle, generation, halted, version FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const EPOCH_LOCK_SQL: &str = "SELECT lifecycle, generation, halted, version FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
pub const BUMP_AUDIENCE_SQL: &str = "UPDATE authority_epoch SET audience_version = audience_version + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const BUMP_REQUESTS_SQL: &str = "UPDATE authority_epoch SET requests_version = requests_version + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const EDGE_SHARE_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const EDGE_READ_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const EDGE_LOCK_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
/// Every child (live, archived, bearers) by the children index.
pub const CHILDREN_SQL: &str = "SELECT principal_id FROM topology_edges WHERE org_id = $1 AND parent_id = $2 ORDER BY principal_id";
/// Live children only (the children cap): a range predicate on the children index.
pub const LIVE_CHILDREN_SQL: &str = "SELECT count(*)::bigint FROM topology_edges t JOIN authority_epoch e \
    ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2 AND e.lifecycle = 'live'";
pub const TOP_LIVE_SQL: &str = "SELECT count(*)::bigint FROM topology_edges t JOIN authority_epoch e \
    ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id IS NULL AND e.lifecycle = 'live'";
pub const SCOPE_SHARE_SQL: &str = "SELECT depth, tools, folders, visibility, permission_mode, version FROM scope_rows \
    WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const SCOPE_LOCK_SQL: &str = "SELECT depth, tools, folders, visibility, permission_mode, version FROM scope_rows \
    WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
pub const SCOPE_READ_SQL: &str = "SELECT depth, tools, folders, visibility, permission_mode, version FROM scope_rows \
    WHERE org_id = $1 AND principal_id = $2";
pub const CONTROL_SHARE_SQL: &str = "SELECT version, value FROM org_controls WHERE org_id = $1 AND family = $2 FOR SHARE";
pub const CONTROL_LOCK_SQL: &str = "SELECT version, value FROM org_controls WHERE org_id = $1 AND family = $2 FOR NO KEY UPDATE";
/// The in-transaction resolver: an active (not reserved) name.
pub const RESOLVE_NAME_SQL: &str = "SELECT principal_id FROM agent_names WHERE org_id = $1 AND name = $2 AND kind = 'active'";
/// The suffix probe: is this key taken (active or reserved; archived agents
/// keep their names, deleted ones free them)?
pub const NAME_TAKEN_SQL: &str = "SELECT 1 FROM agent_names WHERE org_id = $1 AND name = $2";
pub const NAME_OF_SQL: &str = "SELECT name FROM agent_names WHERE org_id = $1 AND principal_id = $2 AND kind = 'active'";
pub const STACK_SQL: &str = "SELECT bearer_id, generation, bearer_state FROM lineage_bearers WHERE org_id = $1 AND seat_id = $2 ORDER BY generation";
pub const BEARER_OF_SQL: &str = "SELECT seat_id, generation, bearer_state FROM lineage_bearers WHERE org_id = $1 AND bearer_id = $2";

// ---------------------------------------------------------------- errors

pub fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T, CmdError> {
    Err(CmdError::Refused(Refusal::new(code, message)))
}

pub fn defect(msg: impl Into<String>) -> CmdError {
    CmdError::Defect(msg.into())
}

fn first_uuid(rows: &crate::value::Rows) -> Option<Uuid> {
    rows.first().and_then(|r| r.first()).and_then(Val::as_uuid)
}

// ---------------------------------------------------------------- caller anchor

/// Who is acting, after the C3 caller anchor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    /// A live, current, unhalted agent (its epoch row is now share-locked).
    Agent { id: Uuid, generation: i64 },
    /// The operator, acting under its own identity (E5 acting is `acting`).
    Operator { id: Uuid, acting: Option<Uuid> },
    User,
    System,
}

impl Caller {
    pub fn agent(&self) -> Option<Uuid> {
        match self {
            Caller::Agent { id, .. } => Some(*id),
            _ => None,
        }
    }
    /// The user, the operator and the system act with the user's reach.
    pub fn is_user_level(&self) -> bool {
        !matches!(self, Caller::Agent { .. })
    }
}

/// C3 / C4 step 1: the caller's authority-epoch row `FOR SHARE` (live,
/// current generation, not halted) and the killswitch row `FOR SHARE`, via
/// WS5's shared anchor. A refusal is `CmdError::Refused` (the executor
/// records it and applies it only after the claim finds no committed
/// receipt: freeze amendment 2). Non-agent principals were authenticated by
/// their door and anchor nothing here.
pub async fn anchor_caller<S: Session>(tx: &mut Tx<'_, S>, b: &Binding) -> Result<Caller, CmdError> {
    match &b.principal {
        Principal::Agent { id, generation } => {
            if let Some(r) = anchor_agent_caller(tx, b.op.org, *id, *generation).await? {
                return Err(CmdError::Refused(r));
            }
            Ok(Caller::Agent { id: *id, generation: *generation })
        }
        Principal::Operator { id } => Ok(Caller::Operator { id: *id, acting: b.acting }),
        Principal::User => Ok(Caller::User),
        Principal::System => Ok(Caller::System),
        Principal::KioskVisitor { .. } => refuse("forbidden", "a kiosk visitor cannot change the organization's structure"),
    }
}

/// Re-derive the caller without anchoring (inside `execute`, after `anchor`).
pub fn caller_of(b: &Binding) -> Caller {
    match &b.principal {
        Principal::Agent { id, generation } => Caller::Agent { id: *id, generation: *generation },
        Principal::Operator { id } => Caller::Operator { id: *id, acting: b.acting },
        Principal::User | Principal::KioskVisitor { .. } => Caller::User,
        Principal::System => Caller::System,
    }
}

// ---------------------------------------------------------------- authority epoch

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub lifecycle: String,
    pub generation: i64,
    pub halted: bool,
    pub version: i64,
}

impl Epoch {
    pub fn live(&self) -> bool {
        self.lifecycle == "live"
    }
    pub fn archived(&self) -> bool {
        self.lifecycle == "archived"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    /// A plain read (in the island: a predicate/SIREAD lock only).
    Read,
    /// `FOR SHARE`: an anchor (C3) or the island side of a pair (C2a rule 3).
    Share,
    /// `FOR NO KEY UPDATE`: the row is about to be updated in place (S3 §8 M1).
    Update,
}

fn epoch_of(rows: &crate::value::Rows) -> Option<Epoch> {
    let r = rows.first()?;
    Some(Epoch {
        lifecycle: r.first()?.as_text()?.to_string(),
        generation: r.get(1)?.as_int()?,
        halted: r.get(2) == Some(&Val::Bool(true)),
        version: r.get(3)?.as_int()?,
    })
}

/// A node's authority-epoch row, read or locked under `label` (the label is
/// the trace and pause identity: `stmt.<label>.before/after`).
pub async fn lock_epoch<S: Session>(tx: &mut Tx<'_, S>, label: &str, org: Uuid, p: Uuid, lock: Lock) -> Result<Option<Epoch>, DbError> {
    let sql = match lock {
        Lock::Read => EPOCH_READ_SQL,
        Lock::Share => EPOCH_SHARE_SQL,
        Lock::Update => EPOCH_LOCK_SQL,
    };
    let rows = tx.exec(label, sql, &[Val::Uuid(org), Val::Uuid(p)]).await?;
    Ok(epoch_of(&rows))
}

/// C2a P1 rule 1: every audience insert or delete bumps the grantee's
/// audience version (and the row's version).
pub async fn bump_audience<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, grantee: Uuid) -> Result<(), DbError> {
    tx.exec("island.bump", BUMP_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(grantee)]).await.map(|_| ())
}

/// C2a P7: every request filing bumps the asker's requests version.
pub async fn bump_requests<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, asker: Uuid) -> Result<(), DbError> {
    tx.exec("island.bump_requests", BUMP_REQUESTS_SQL, &[Val::Uuid(org), Val::Uuid(asker)]).await.map(|_| ())
}

// ---------------------------------------------------------------- topology

/// C3 ancestor walk from `from` to the top: `[from, parent, grandparent, …]`.
/// With `lock`, each edge row is taken `FOR SHARE` in the same statement
/// that reads its parent (lock the target's edge row, read its parent, lock
/// the parent's edge row, and so on), so the chain that is locked is the
/// chain that was read. Without `lock` it is a plain read (the island's own
/// snapshot, or a probe outside it). A node with no edge row ends the walk.
pub async fn chain_up<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, from: Uuid, lock: bool) -> Result<Vec<Uuid>, CmdError> {
    let mut out = Vec::new();
    let mut cur = Some(from);
    while let Some(x) = cur {
        if out.contains(&x) || out.len() > MAX_WALK {
            return Err(defect(format!("topology cycle or unbounded chain at {x}")));
        }
        out.push(x);
        let rows = if lock {
            tx.exec("island.chain_edge", EDGE_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(x)]).await?
        } else {
            tx.exec("island.parent", EDGE_READ_SQL, &[Val::Uuid(org), Val::Uuid(x)]).await?
        };
        cur = first_uuid(&rows);
    }
    Ok(out)
}

/// A node's parent (plain read), `None` at the top level or for no edge.
pub async fn parent_of<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, x: Uuid) -> Result<Option<Uuid>, DbError> {
    let rows = tx.exec("island.parent", EDGE_READ_SQL, &[Val::Uuid(org), Val::Uuid(x)]).await?;
    Ok(first_uuid(&rows))
}

/// Direct children (every lifecycle state), sorted by key.
pub async fn children<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, parent: Uuid) -> Result<Vec<Uuid>, DbError> {
    let rows = tx.exec("island.children", CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(parent)]).await?;
    Ok(rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect())
}

/// `roots` and every node beneath them, level by level (top-down: each level
/// sorted by key, C4 step 4's scope-row order), with each node's depth
/// relative to its root (roots are 0).
pub async fn subtree<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, roots: &[Uuid]) -> Result<Vec<(Uuid, usize)>, CmdError> {
    let mut out: Vec<(Uuid, usize)> = Vec::new();
    let mut level: Vec<Uuid> = roots.to_vec();
    level.sort();
    level.dedup();
    let mut d = 0usize;
    while !level.is_empty() {
        let mut next = Vec::new();
        for x in &level {
            if out.iter().any(|(y, _)| y == x) {
                return Err(defect(format!("topology cycle at {x}")));
            }
            out.push((*x, d));
            next.extend(children(tx, org, *x).await?);
        }
        next.sort();
        next.dedup();
        level = next;
        d += 1;
        if d > MAX_WALK {
            return Err(defect("unbounded subtree"));
        }
    }
    Ok(out)
}

/// The children cap's predicate: live children of `parent` (the top level when `None`).
pub async fn live_children<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, parent: Option<Uuid>) -> Result<i64, DbError> {
    let rows = match parent {
        Some(p) => tx.exec("island.live_children", LIVE_CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(p)]).await?,
        None => tx.exec("island.top_live", TOP_LIVE_SQL, &[Val::Uuid(org)]).await?,
    };
    Ok(rows.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0))
}

/// A lineage stack: the seat's bearers, oldest generation first. The move
/// re-parents `{seat} ∪ stack` as one unit (legacy `_move`, S3 §3.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bearer {
    pub id: Uuid,
    pub generation: i64,
    pub state: String,
}

pub async fn stack<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, seat: Uuid) -> Result<Vec<Bearer>, DbError> {
    let rows = tx.exec("island.stack", STACK_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
    Ok(rows
        .0
        .iter()
        .filter_map(|r| Some(Bearer { id: r.first()?.as_uuid()?, generation: r.get(1)?.as_int()?, state: r.get(2)?.as_text()?.to_string() }))
        .collect())
}

/// If `x` is a lineage bearer: `(seat, generation, state)`.
pub async fn bearer_of<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, x: Uuid) -> Result<Option<(Uuid, i64, String)>, DbError> {
    let rows = tx.exec("island.bearer_of", BEARER_OF_SQL, &[Val::Uuid(org), Val::Uuid(x)]).await?;
    Ok(rows.first().and_then(|r| Some((r.first()?.as_uuid()?, r.get(1)?.as_int()?, r.get(2)?.as_text()?.to_string()))))
}

// ---------------------------------------------------------------- scope rows (P3)

#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub depth: i64,
    pub tools: Value,
    pub folders: Value,
    pub visibility: String,
    pub permission_mode: String,
    pub version: i64,
}

fn scope_of(rows: &crate::value::Rows) -> Option<Scope> {
    let r = rows.first()?;
    Some(Scope {
        depth: r.first()?.as_int()?,
        tools: r.get(1)?.as_json()?.clone(),
        folders: r.get(2)?.as_json()?.clone(),
        visibility: r.get(3)?.as_text()?.to_string(),
        permission_mode: r.get(4)?.as_text()?.to_string(),
        version: r.get(5)?.as_int()?,
    })
}

/// Lock the scope rows of `nodes` in the order given, which the caller must
/// already have made top-down (by depth, then key; C4 step 4): a chain from
/// [`chain_up`] reversed, or a [`subtree`] listing. `label` distinguishes the
/// chain's share locks from the subtree's update locks in the trace.
pub async fn lock_scope_rows<S: Session>(tx: &mut Tx<'_, S>, label: &str, org: Uuid, nodes: &[Uuid], lock: Lock) -> Result<Vec<(Uuid, Option<Scope>)>, DbError> {
    let sql = match lock {
        Lock::Read => SCOPE_READ_SQL,
        Lock::Share => SCOPE_SHARE_SQL,
        Lock::Update => SCOPE_LOCK_SQL,
    };
    let mut out = Vec::with_capacity(nodes.len());
    for x in nodes {
        let rows = tx.exec(label, sql, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        out.push((*x, scope_of(&rows)));
    }
    Ok(out)
}

// ---------------------------------------------------------------- org controls (P6)

/// C2a P6: `FOR SHARE` every org control row the writer reads, in primary-key
/// (family) order. A family with no row is simply absent from the map.
pub async fn share_controls<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, families: &[&str]) -> Result<BTreeMap<String, (i64, Value)>, DbError> {
    let mut fams: Vec<&str> = families.to_vec();
    fams.sort();
    fams.dedup();
    let mut out = BTreeMap::new();
    for f in fams {
        let rows = tx.exec("island.control_share", CONTROL_SHARE_SQL, &[Val::Uuid(org), Val::text(f)]).await?;
        if let Some(r) = rows.first() {
            let v = r.first().and_then(Val::as_int).unwrap_or(0);
            let j = r.get(1).and_then(Val::as_json).cloned().unwrap_or(Value::Null);
            out.insert(f.to_string(), (v, j));
        }
    }
    Ok(out)
}

/// A numeric cap from the `caps` control (`None` = no cap set).
pub fn cap(controls: &BTreeMap<String, (i64, Value)>, key: &str) -> Option<i64> {
    controls.get("caps").and_then(|(_, v)| v.get(key)).and_then(Value::as_i64)
}

// ---------------------------------------------------------------- names (decision 8)

/// Legacy `slugify` (`ledger.py:678`): lowercase, every run of characters
/// outside `[a-z0-9]` becomes one `-`, trimmed of `-`. Empty refuses.
pub fn slugify(name: &str) -> Result<String, Refusal> {
    let mut s = String::new();
    let mut dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            s.push(c);
            dash = false;
        } else if !dash {
            s.push('-');
            dash = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        return Err(Refusal::new("invalid", "name is mandatory and must contain letters or digits (§4.7)"));
    }
    Ok(s)
}

/// The in-transaction resolver (plan decision 8): an ACTIVE name to its
/// principal, read inside the command's own transaction. **To be replaced
/// by WS2's `resolve(&mut Tx)` when it lands** (one copy, here; WS3a uses it).
pub async fn resolve_name<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, name: &str) -> Result<Option<Uuid>, DbError> {
    let rows = tx.exec("island.resolve_name", RESOLVE_NAME_SQL, &[Val::Uuid(org), Val::text(name)]).await?;
    Ok(first_uuid(&rows))
}

/// A principal's active name.
pub async fn name_of<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, p: Uuid) -> Result<Option<String>, DbError> {
    let rows = tx.exec("island.name_of", NAME_OF_SQL, &[Val::Uuid(org), Val::Uuid(p)]).await?;
    Ok(rows.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)))
}

/// Is this exact key taken (active or reserved)?
pub async fn name_taken<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, key: &str) -> Result<bool, DbError> {
    Ok(!tx.exec("island.name_probe", NAME_TAKEN_SQL, &[Val::Uuid(org), Val::text(key)]).await?.is_empty())
}

/// Legacy's lowest free suffix (`_new_node`, `ledger.py:4838-4842`): `base`,
/// then `base-2`, `base-3`, … against every key in the unique name
/// namespace, archived and reserved included (S3 §4.8: a reserved key counts
/// as taken). The unique index is the real conflict detector: two concurrent
/// probes may pick the same key, and the loser retries on `23505`
/// `agent_names_active` (or `40001` first, inside the island).
pub async fn free_name_suffix<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, base: &str) -> Result<String, DbError> {
    let mut key = base.to_string();
    let mut i = 2u64;
    while name_taken(tx, org, &key).await? {
        key = format!("{base}-{i}");
        i += 1;
    }
    Ok(key)
}
