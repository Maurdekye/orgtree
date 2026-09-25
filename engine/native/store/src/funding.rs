//! Funding (WS4): `reallocate` (r7 §6.4, C2a P2), the credit request with
//! its one-pending rule (S3 §4.13, r7 P7) and the credit decision with its
//! compare-and-set before the amount (S3 §4.13, E-D14), including deep
//! bubbling through a finite manager and the kiosk pool (S3 E8, E-D15).
//! Every command here runs READ COMMITTED outside the island.
//!
//! **Decide and apply (r7 C6).** The decision is the reviewed pure planner
//! `orgtree-funding-core` (legacy `Org.reallocate` / `_chain_acquire` rules,
//! refusal texts, whole-credit snap and carry, stranding), evaluated over a
//! synthetic [`Snapshot`] of exactly the declared read set, read UNDER the
//! locks below. Apply writes the grants it changed and the capacity rows of
//! their payers. Preview (WS4, r7 §6) reads the same set in a snapshot and
//! runs the same decide function.
//!
//! **Lock order (C4), one attempt:**
//! 1. the caller or acting anchor (C3);
//! 2. the target's topology chain `FOR SHARE`, leaf upward to the top level
//!    (the authority and `_chain_acquire` path facts);
//! 3. the catalog's current-version row `FOR SHARE` (P2, RN4) and the org
//!    control rows read (`caps`, `cascade`) `FOR SHARE` (P6);
//! 4. the operation's own mutable rows in primary-key order: the funding
//!    edges of the target and its chain, then the capacity rows of the
//!    target and its chain, all `FOR NO KEY UPDATE` (S3 §8 M1: nothing
//!    references them by a key they change);
//! 5. the kiosk pool row `FOR NO KEY UPDATE`, LAST, only in an organization
//!    that has one and only when the top-level holdings change (E8).
//!
//! **P2.** Every payer whose child obligations change has its capacity row
//! UPDATED (aggregate and version), never only locked, so a SERIALIZABLE
//! island writer whose snapshot predates this commit gets `40001` on it
//! (C2a rule 3). Children are read after the capacity rows are locked, so a
//! READ COMMITTED writer sees every committed obligation of its payers.
//!
//! **Not byte-exact (disclosed):** the grant-changed and stranding notices
//! are System notices whose body is a plain rendering, not legacy's typed
//! event rendering, and the credit answer's body likewise; wire parity of
//! those texts is the wire owner's (P05).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

use orgtree_funding_core::ledger::Fail;
use orgtree_funding_core::pynum::{q, PyNum};
use orgtree_funding_core::snapshot::{Node, Setting, Snapshot};
use orgtree_funding_core::{Rules, USER};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Principal, Refusal};
use crate::hooks::controls;
use crate::mail::doors::anchor_agent_caller;
use crate::sent::{self, Destination, MailSource, RecipientLock, SendError, SendRequest};
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub static FUNDING: Family = Family {
    name: "funding",
    isolation: Isolation::ReadCommitted,
    // S3 §4.13: two filings by one agent collide on the one-pending index and
    // the loser amends; two new requests by different agents can mint one
    // `cr<n>` and the loser takes the next number.
    retry_unique: &["request_batches_one_pending", "request_batches_legacy_id"],
};

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &[
    "Q-C8.lock_not_update",
    "Q-FD1.no_cas_prelock_delta",
    "Q-FD1.no_cas_postlock_delta",
    "Q-FD2.lookup_before_bump",
    "Q-FD3.no_anchor_no_cas",
    "Q-FD3.moot_unconditional",
    "Q-FD3.liveness_once",
    "Q-FD4.skip_one_hop_update",
    "Q-FD5.no_kiosk_pool_row",
];

/// Family-specific pause points.
pub const POINTS: &[&str] = &[
    "funding.reallocate.after_locks",
    "funding.decide.after_liveness",
    "funding.decide.after_cas",
    "funding.decide.after_locks",
    "funding.request.after_lookup",
];

/// Statement labels.
pub const LABELS: &[&str] = &[
    "mail.anchor_caller",
    "mail.anchor_killswitch",
    "funding.acting_anchor",
    "funding.chain_edge",
    "funding.catalog",
    "funding.prices",
    "funding.controls",
    "funding.lock_edge",
    "funding.lock_capacity",
    "funding.node",
    "funding.children",
    "funding.update_edge",
    "funding.update_capacity",
    "funding.kiosk_lock",
    "funding.kiosk_update",
    "funding.kiosk_unlocked_sum",
    "funding.notice_mailbox",
    "funding.request_bump",
    "funding.request_pending",
    "funding.request_pending_unlocked",
    "funding.request_withdraw",
    "funding.request_amend",
    "funding.request_count",
    "funding.request_insert",
    "funding.request_defaults",
    "funding.request_audience",
    "funding.request_grant",
    "funding.headroom_node",
    "funding.headroom_capacity",
    "funding.headroom_kiosk",
    "funding.decide_find",
    "funding.decide_liveness",
    "funding.decide_liveness_unlocked",
    "funding.decide_moot",
    "funding.decide_cas",
    "funding.decide_unconditional",
    "funding.decide_prelock_grant",
    "funding.decide_result",
    "exec.now",
];

// ---------------------------------------------------------------- SQL

pub const CHAIN_EDGE_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const CATALOG_SQL: &str = "SELECT catalog_version FROM catalog_current WHERE org_id = $1 FOR SHARE";
pub const PRICES_SQL: &str = "SELECT tier, seat_centi FROM price_catalog WHERE org_id = $1 AND catalog_version = $2 ORDER BY tier";
pub const CONTROLS_SQL: &str = "SELECT family, value FROM org_controls WHERE org_id = $1 AND family IN ('caps', 'cascade') ORDER BY family FOR SHARE";
pub const LOCK_EDGE_SQL: &str = "SELECT grant_centi FROM funding_edges WHERE org_id = $1 AND child_id = $2 FOR NO KEY UPDATE";
pub const LOCK_CAPACITY_SQL: &str = "SELECT child_grants_centi FROM issuer_capacity WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
/// One node's funding facts: name, parent, lifecycle, tier, grant, created.
pub const NODE_SQL: &str = "SELECT a.principal_id, a.name, t.parent_id, e.lifecycle, a.tier, coalesce(f.grant_centi, 0), a.created_at \
    FROM agents a JOIN topology_edges t ON t.org_id = a.org_id AND t.principal_id = a.principal_id \
    JOIN authority_epoch e ON e.org_id = a.org_id AND e.principal_id = a.principal_id \
    LEFT JOIN funding_edges f ON f.org_id = a.org_id AND f.child_id = a.principal_id \
    WHERE a.org_id = $1 AND a.principal_id = $2";
/// Every child (live and archived) of one node, by the children index.
pub const CHILDREN_SQL: &str = "SELECT a.principal_id, a.name, t.parent_id, e.lifecycle, a.tier, coalesce(f.grant_centi, 0), a.created_at \
    FROM topology_edges t JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    LEFT JOIN funding_edges f ON f.org_id = t.org_id AND f.child_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2";
pub const UPDATE_EDGE_SQL: &str = "UPDATE funding_edges SET grant_centi = $3, version = version + 1 WHERE org_id = $1 AND child_id = $2";
pub const UPDATE_CAPACITY_SQL: &str = "UPDATE issuer_capacity SET child_grants_centi = child_grants_centi + $3, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";
pub const KIOSK_LOCK_SQL: &str = "SELECT pool_centi, top_grants_centi, top_seats FROM kiosk_pool WHERE org_id = $1 FOR NO KEY UPDATE";
pub const KIOSK_UPDATE_SQL: &str = "UPDATE kiosk_pool SET top_grants_centi = top_grants_centi + $2, version = version + 1 WHERE org_id = $1";
/// Q-FD5's unsafe control: the cap computed by an unlocked sum over the
/// top-level holdings (legacy's whole-document audit), no pool row lock.
pub const KIOSK_UNLOCKED_SUM_SQL: &str = "SELECT k.pool_centi, coalesce(sum(f.grant_centi + p.seat_centi), 0)::bigint \
    FROM kiosk_pool k LEFT JOIN topology_edges t ON t.org_id = k.org_id AND t.parent_id IS NULL \
    LEFT JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id AND e.lifecycle <> 'archived' \
    LEFT JOIN funding_edges f ON f.org_id = e.org_id AND f.child_id = e.principal_id \
    LEFT JOIN agents a ON a.org_id = f.org_id AND a.principal_id = f.child_id \
    LEFT JOIN catalog_current c ON c.org_id = k.org_id \
    LEFT JOIN price_catalog p ON p.org_id = a.org_id AND p.catalog_version = c.catalog_version AND p.tier = a.tier \
    WHERE k.org_id = $1 GROUP BY k.pool_centi";
pub const ACTING_ANCHOR_SQL: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";

// ---------------------------------------------------------------- numbers

/// Hundredths to the Python value legacy would hold: whole → int, else float.
pub fn centi_to_py(c: i64) -> PyNum {
    if c % 100 == 0 {
        PyNum::Int(i128::from(c / 100))
    } else {
        PyNum::Float(c as f64 / 100.0)
    }
}

pub fn py_to_centi(p: PyNum) -> Result<i64, CmdError> {
    match p {
        PyNum::Int(i) => i64::try_from(i.checked_mul(100).ok_or_else(|| CmdError::Defect("credit amount overflow".into()))?)
            .map_err(|_| CmdError::Defect("credit amount overflow".into())),
        PyNum::Float(f) if f.is_finite() => Ok((f * 100.0).round() as i64),
        PyNum::Float(_) => Err(CmdError::Defect("non-finite credit amount".into())),
    }
}

pub fn py_json(p: PyNum) -> Value {
    match p {
        PyNum::Int(i) => json!(i64::try_from(i).unwrap_or(i64::MAX)),
        PyNum::Float(f) => json!(f),
    }
}

/// A JSON number as the Python value `json.loads` makes of it.
pub fn json_py(v: &Value) -> Option<PyNum> {
    if let Some(i) = v.as_i64() {
        return Some(PyNum::Int(i128::from(i)));
    }
    v.as_f64().map(PyNum::Float)
}

fn g(p: PyNum) -> String {
    orgtree_funding_core::fmt::py_g(p, true)
}

fn outside(e: impl std::fmt::Debug) -> CmdError {
    CmdError::Defect(format!("funding decide outside its parity domain: {e:?}"))
}

fn refusal_of(f: Fail) -> Result<Refusal, CmdError> {
    match f {
        Fail::Refused(r) => Ok(Refusal::new(format!("funding.{:?}", r.kind).to_lowercase(), r.message)),
        Fail::Outside(o) => Err(outside(o)),
    }
}

// ---------------------------------------------------------------- the read set under the locks

/// Who is acting (E5): an agent (its authority applies, downward only) or
/// the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor {
    User,
    Agent(Uuid),
}

#[derive(Clone, Debug)]
struct NodeRow {
    id: Uuid,
    name: String,
    parent: Option<Uuid>,
    lifecycle: String,
    tier: String,
    grant: i64,
    created: i64,
}

fn node_rows(rows: &crate::value::Rows) -> Result<Vec<NodeRow>, CmdError> {
    rows.0
        .iter()
        .map(|r| {
            Some(NodeRow {
                id: r.first()?.as_uuid()?,
                name: r.get(1)?.as_text()?.to_string(),
                parent: r.get(2)?.as_uuid(),
                lifecycle: r.get(3)?.as_text()?.to_string(),
                tier: r.get(4)?.as_text()?.to_string(),
                grant: r.get(5)?.as_int()?,
                created: r.get(6)?.as_ts()?,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| CmdError::Defect("undecodable funding node row".into()))
}

/// The declared read set of one funding step, read under its locks.
pub struct Loaded {
    pub snap: Snapshot,
    pub target: Uuid,
    /// target first, then its ancestors up to the top level.
    pub chain: Vec<Uuid>,
    names: HashMap<Uuid, String>,
    ids: HashMap<String, Uuid>,
    parents: HashMap<Uuid, Option<Uuid>>,
    grants: HashMap<Uuid, i64>,
    lifecycles: HashMap<Uuid, String>,
    pub prices: BTreeMap<String, i64>,
}

impl Loaded {
    pub fn name(&self, id: Uuid) -> Option<&str> {
        self.names.get(&id).map(String::as_str)
    }
    pub fn id(&self, name: &str) -> Option<Uuid> {
        self.ids.get(name).copied()
    }
    pub fn grant(&self, id: Uuid) -> Option<i64> {
        self.grants.get(&id).copied()
    }
    pub fn lifecycle(&self, id: Uuid) -> Option<&str> {
        self.lifecycles.get(&id).map(String::as_str)
    }
    pub fn actor_str(&self, a: Actor) -> String {
        match a {
            Actor::User => USER.to_string(),
            Actor::Agent(id) => self.names.get(&id).cloned().unwrap_or_else(|| format!("@unknown:{id}")),
        }
    }
}

/// How to read: `lock` = the real command (anchors and row locks, C4);
/// false = preview inside a protected-read snapshot (no locks, r7 C5/C6).
#[derive(Clone, Copy, Debug)]
pub struct ReadMode {
    pub lock: bool,
}

async fn one_node<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, id: Uuid) -> Result<Option<NodeRow>, CmdError> {
    let rows = tx.exec("funding.node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
    Ok(node_rows(&rows)?.into_iter().next())
}

/// The step's fixed frame: the target's chain to the top level (leaf
/// upward), the catalog prices and the controls read.
pub struct Frame {
    pub chain: Vec<Uuid>,
    pub prices: BTreeMap<String, i64>,
    pub settings: Vec<(String, Setting)>,
}

/// Steps 2-3 of the lock order: the chain `FOR SHARE` leaf upward (C3: lock,
/// read parent, lock parent…), the catalog version `FOR SHARE`, the controls
/// `FOR SHARE`. Without `lock` (preview) the same reads take no locks.
pub async fn open_frame<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, target: Uuid, mode: ReadMode) -> Result<Option<Frame>, CmdError> {
    let mut chain = vec![target];
    let mut cur = target;
    loop {
        let rows = if mode.lock {
            tx.exec("funding.chain_edge", CHAIN_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        } else {
            tx.exec("funding.chain_edge", sent::EDGE_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?
        };
        let Some(r) = rows.first() else {
            if cur == target {
                return Ok(None);
            }
            return Err(CmdError::Defect(format!("dangling parent {cur}")));
        };
        match r.first().and_then(Val::as_uuid) {
            Some(p) if !chain.contains(&p) => {
                chain.push(p);
                cur = p;
            }
            _ => break,
        }
    }
    let cat_sql = if mode.lock { CATALOG_SQL } else { "SELECT catalog_version FROM catalog_current WHERE org_id = $1" };
    let version = tx
        .exec("funding.catalog", cat_sql, &[Val::Uuid(org)])
        .await?
        .first()
        .and_then(|r| r.first())
        .and_then(Val::as_int)
        .ok_or_else(|| CmdError::Defect("no catalog_current row".into()))?;
    let mut prices = BTreeMap::new();
    for r in tx.exec("funding.prices", PRICES_SQL, &[Val::Uuid(org), Val::Int(version)]).await?.0 {
        if let (Some(t), Some(c)) = (r.first().and_then(Val::as_text), r.get(1).and_then(Val::as_int)) {
            prices.insert(t.to_string(), c);
        }
    }
    let ctl_sql = if mode.lock {
        CONTROLS_SQL
    } else {
        "SELECT family, value FROM org_controls WHERE org_id = $1 AND family IN ('caps', 'cascade') ORDER BY family"
    };
    let mut settings: Vec<(String, Setting)> = Vec::new();
    for r in tx.exec("funding.controls", ctl_sql, &[Val::Uuid(org)]).await?.0 {
        let fam = r.first().and_then(Val::as_text).unwrap_or("");
        let Some(Value::Object(v)) = r.get(1).and_then(Val::as_json) else { continue };
        let keys: &[&str] = match fam {
            "caps" => &["max_top_grant"],
            "cascade" => &["cascade_alloc", "cascade_hire"],
            _ => &[],
        };
        for k in keys {
            if let Some(x) = v.get(*k) {
                let s = match x {
                    Value::Null => Setting::Null,
                    Value::Bool(b) => Setting::Bool(*b),
                    Value::Number(_) => Setting::Num(json_py(x).unwrap_or(PyNum::Int(0))),
                    Value::String(s) => Setting::Str(s.clone()),
                    _ => continue,
                };
                settings.push((k.to_string(), s));
            }
        }
    }
    Ok(Some(Frame { chain, prices, settings }))
}

/// Step 4: the operation's own mutable rows, primary-key order within this
/// call: the funding edges, then the capacity rows, `FOR NO KEY UPDATE`.
async fn lock_rows<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, ids: &BTreeSet<Uuid>) -> Result<(), CmdError> {
    for id in ids {
        tx.exec("funding.lock_edge", LOCK_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?;
    }
    for id in ids {
        tx.exec("funding.lock_capacity", LOCK_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?;
    }
    Ok(())
}

/// The facts the planner consults, read now (after whatever is locked;
/// READ COMMITTED sees the newest committed rows): every chain node, and the
/// children of every chain node whose `free` the planner may compute.
async fn read_facts<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, target: Uuid, f: &Frame) -> Result<Loaded, CmdError> {
    let mut rows: BTreeMap<Uuid, NodeRow> = BTreeMap::new();
    for id in &f.chain {
        if let Some(n) = one_node(tx, org, *id).await? {
            rows.insert(n.id, n);
        }
    }
    for id in &f.chain {
        let kids = node_rows(&tx.exec("funding.children", CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?)?;
        for k in kids {
            rows.entry(k.id).or_insert(k);
        }
    }
    let names: HashMap<Uuid, String> = rows.values().map(|n| (n.id, n.name.clone())).collect();
    let mut ordered: Vec<&NodeRow> = rows.values().collect();
    ordered.sort_by_key(|n| (n.created, n.id));
    let snap = Snapshot {
        nodes: ordered
            .iter()
            .map(|n| Node {
                id: n.name.clone(),
                parent: n.parent.and_then(|p| names.get(&p).cloned()),
                state: n.lifecycle.clone(),
                model: n.tier.clone(),
                grant: centi_to_py(n.grant),
                ui_order: None,
                created: format!("{:020}", n.created),
                bearer_state: None,
            })
            .collect(),
        tiers: f.prices.iter().map(|(t, c)| (t.clone(), centi_to_py(*c))).collect(),
        settings: f.settings.clone(),
    };
    Ok(Loaded {
        snap,
        target,
        chain: f.chain.clone(),
        ids: names.iter().map(|(k, v)| (v.clone(), *k)).collect(),
        names,
        parents: rows.values().map(|n| (n.id, n.parent)).collect(),
        grants: rows.values().map(|n| (n.id, n.grant)).collect(),
        lifecycles: rows.values().map(|n| (n.id, n.lifecycle.clone())).collect(),
        prices: f.prices.clone(),
    })
}

/// Read everything a funding step on `target` consults WITHOUT locks
/// (preview's protected-read snapshot, r7 C6).
pub async fn load<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, target: Uuid, mode: ReadMode) -> Result<Option<Loaded>, CmdError> {
    let Some(f) = open_frame(tx, org, target, mode).await? else { return Ok(None) };
    Ok(Some(read_facts(tx, org, target, &f).await?))
}

// ---------------------------------------------------------------- decide + apply

/// What `reallocate` decided, before apply.
pub struct Plan {
    pub new_grant: PyNum,
    pub warnings: Vec<String>,
    /// (node, old grant, new grant), hundredths.
    pub changes: Vec<(Uuid, i64, i64)>,
    pub notices: Vec<(Vec<Uuid>, String, &'static str)>,
}

/// Run the pure decide function (C6) over a loaded read set.
pub fn decide_reallocate(l: &Loaded, actor: Actor, delta: PyNum) -> Result<Result<Plan, Refusal>, CmdError> {
    let target = l.name(l.target).ok_or_else(|| CmdError::Defect("target not loaded".into()))?.to_string();
    let out = orgtree_funding_core::reallocate(&l.snap, &l.actor_str(actor), &target, delta, &Rules::LEGACY);
    let (new_grant, warnings) = match out.result {
        Ok(v) => v,
        Err(f) => return Ok(Err(refusal_of(f)?)),
    };
    let mut changes = Vec::new();
    for (name, v) in &out.grants_changed {
        let id = l.id(name).ok_or_else(|| CmdError::Defect(format!("planner changed unknown node {name}")))?;
        let old = l.grant(id).unwrap_or(0);
        let new = py_to_centi(*v)?;
        if new != old {
            changes.push((id, old, new));
        }
    }
    let mut notices = Vec::new();
    for ev in &out.events {
        let to: Vec<Uuid> = ev.to.iter().flatten().filter_map(|n| l.id(n)).collect();
        if to.is_empty() {
            continue;
        }
        let body = format!(
            "{} changed the grant of {} by {} ({}): now {}, free {}",
            ev.by,
            ev.node,
            g(PyNum::Float(ev.delta)),
            ev.relation,
            g(PyNum::Float(ev.now)),
            g(PyNum::Float(ev.free))
        );
        notices.push((to, body, "access.grant_changed"));
    }
    for (to, text) in &out.notices {
        let to: Vec<Uuid> = to.iter().filter_map(|n| l.id(n)).collect();
        if !to.is_empty() {
            notices.push((to, text.clone(), "funding.stranding"));
        }
    }
    Ok(Ok(Plan { new_grant, warnings, changes, notices }))
}

/// Legacy's kiosk refusal (`api.py` `_kiosk_cap_check`).
fn kiosk_refusal(pool_centi: i64, held_centi: i64) -> Refusal {
    Refusal::new(
        "kiosk_cap",
        format!("kiosk credit cap: the org may hold at most {} credits (this would make it {})", pool_centi / 100, g(centi_to_py(held_centi))),
    )
}

fn priced(seats: &Value, prices: &BTreeMap<String, i64>) -> i64 {
    seats.as_object().map_or(0, |m| m.iter().map(|(t, n)| n.as_i64().unwrap_or(0) * prices.get(t).copied().unwrap_or(0)).sum())
}

/// Apply a plan: the changed grants, their payers' capacity rows (P2), the
/// kiosk pool last (E8), then the notices. Refuses (nothing written, the
/// transaction rolls back) only on the kiosk cap.
pub async fn apply<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, l: &Loaded, plan: &Plan) -> Result<Result<(), Refusal>, CmdError> {
    let mut payer_delta: BTreeMap<Uuid, i64> = BTreeMap::new();
    let mut top_delta = 0i64;
    for (id, old, new) in &plan.changes {
        tx.exec("funding.update_edge", UPDATE_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(*id), Val::Int(*new)]).await?;
        match l.parents.get(id).copied().flatten() {
            Some(p) => *payer_delta.entry(p).or_default() += new - old,
            None => top_delta += new - old,
        }
    }
    // P2: every payer whose obligations changed is UPDATED.
    let lock_only = controls::fire(&tx.scope(), "Q-C8.lock_not_update");
    // Q-FD4's control skips the update on ONE hop: the payer nearest the target.
    let skip_hop = if controls::fire(&tx.scope(), "Q-FD4.skip_one_hop_update") {
        l.chain.iter().skip(1).find(|p| payer_delta.contains_key(p)).copied()
    } else {
        None
    };
    for (p, d) in &payer_delta {
        if *d == 0 || lock_only || Some(*p) == skip_hop {
            continue;
        }
        tx.exec("funding.update_capacity", UPDATE_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(*p), Val::Int(*d)]).await?;
    }
    // E8: the kiosk pool, last, only when top-level holdings change.
    if top_delta != 0 {
        if controls::fire(&tx.scope(), "Q-FD5.no_kiosk_pool_row") {
            let rows = tx.exec("funding.kiosk_unlocked_sum", KIOSK_UNLOCKED_SUM_SQL, &[Val::Uuid(org)]).await?;
            if let Some(r) = rows.first() {
                let (pool, held) = (r.first().and_then(Val::as_int).unwrap_or(0), r.get(1).and_then(Val::as_int).unwrap_or(0));
                if held > pool {
                    return Ok(Err(kiosk_refusal(pool, held)));
                }
            }
        } else {
            let rows = tx.exec("funding.kiosk_lock", KIOSK_LOCK_SQL, &[Val::Uuid(org)]).await?;
            if let Some(r) = rows.first() {
                let pool = r.first().and_then(Val::as_int).unwrap_or(0);
                let grants = r.get(1).and_then(Val::as_int).unwrap_or(0) + top_delta;
                let seats = r.get(2).and_then(Val::as_json).cloned().unwrap_or(Value::Null);
                let held = grants + priced(&seats, &l.prices);
                if pool > 0 && held > pool {
                    return Ok(Err(kiosk_refusal(pool, held)));
                }
                tx.exec("funding.kiosk_update", KIOSK_UPDATE_SQL, &[Val::Uuid(org), Val::Int(top_delta)]).await?;
            }
        }
    }
    for (to, body, kind) in &plan.notices {
        for r in to {
            notify(tx, org, *r, kind, body).await?;
        }
    }
    Ok(Ok(()))
}

/// A System notice into `to`'s notice box (Sent, E1; no pair, no wake).
async fn notify<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, to: Uuid, kind: &str, body: &str) -> Result<(), CmdError> {
    let mb = tx.exec("funding.notice_mailbox", sent::RECIPIENT_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(to)]).await?;
    let Some(row) = mb.first() else { return Ok(()) };
    let Some(mailbox) = row.first().and_then(Val::as_uuid) else { return Ok(()) };
    let incarnation = row.get(1).and_then(Val::as_int).unwrap_or(1);
    let id = Uuid::new_v4();
    let req = SendRequest::notice(
        MailSource::System,
        Destination::Resolved { principal: to, mailbox, mailbox_incarnation: incarnation },
        id,
        kind.to_string(),
        body.to_string(),
        format!("{kind}:{id}"),
    );
    match sent::record_sent(tx, &req).await {
        Ok(_) => Ok(()),
        Err(SendError::Refused(_)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// The real funding step's lock set, decided by the plan it protects.
///
/// It starts with the rows the step certainly relies on — the target and its
/// payer (for a user actor, whose `_chain_acquire` takes from the payer's own
/// free first), or the whole chain from the target up to an acting agent
/// (every one of them may contribute) — locks them (step 4), reads the facts
/// and decides. If the plan changes a grant or a payer's obligations outside
/// the locked set, the set is extended to cover them and the step reads and
/// decides again; a refusal is trusted only once the whole path it read is
/// locked. So two reallocations that change disjoint payers never wait on
/// each other, even under one top-level ancestor (Q-OP2), while every row a
/// plan writes, and every `free` it spends, was read under its lock.
/// Extending after earlier locks can deadlock with another writer; C1
/// retries a detected deadlock (C4).
///
/// `delta_of` computes the step's delta from the facts read under the
/// locks (the credit decision's `give − grant`); `skip_zero` makes a zero
/// delta a no-op (legacy `credit_request_action` calls `reallocate` only for
/// a nonzero delta). `stale_state` overrides the target's lifecycle in the
/// planner's input (Q-FD3's controls: liveness read once, never re-read).
#[allow(clippy::too_many_arguments)]
pub async fn plan_locked<S: Session>(
    tx: &mut Tx<'_, S>,
    org: Uuid,
    actor: Actor,
    target: Uuid,
    stale_state: Option<&str>,
    skip_zero: bool,
    delta_of: &(dyn Fn(&Loaded) -> Result<PyNum, CmdError> + Send + Sync),
) -> Result<Result<(Loaded, Option<Plan>), Refusal>, CmdError> {
    let Some(f) = open_frame(tx, org, target, ReadMode { lock: true }).await? else {
        return Ok(Err(Refusal::new("funding.nosuchnode", format!("no such node {target}"))));
    };
    // the path the planner can read `free` on: up to the acting agent, or the top
    let path: BTreeSet<Uuid> = match actor {
        Actor::Agent(a) => match f.chain.iter().position(|x| *x == a) {
            Some(i) => f.chain[..=i].iter().copied().collect(),
            None => f.chain.iter().copied().collect(),
        },
        Actor::User => f.chain.iter().copied().collect(),
    };
    let mut want: BTreeSet<Uuid> = match actor {
        Actor::Agent(_) => path.clone(),
        Actor::User => f.chain.iter().take(2).copied().collect(),
    };
    let mut locked: BTreeSet<Uuid> = BTreeSet::new();
    for round in 0..(f.chain.len() + 2) {
        let new: BTreeSet<Uuid> = want.difference(&locked).copied().collect();
        lock_rows(tx, org, &new).await?;
        locked.extend(new);
        let mut l = read_facts(tx, org, target, &f).await?;
        if let Some(s) = stale_state {
            let name = l.name(target).map(str::to_string);
            for n in &mut l.snap.nodes {
                if Some(&n.id) == name.as_ref() {
                    n.state = s.to_string();
                }
            }
        }
        if round == 0 {
            tx.pause("after_locks").await?;
        }
        let delta = delta_of(&l)?;
        if skip_zero && delta.eq_py(PyNum::Int(0)) {
            return Ok(Ok((l, None)));
        }
        match decide_reallocate(&l, actor, delta)? {
            Err(r) => {
                if path.is_subset(&locked) {
                    return Ok(Err(r));
                }
                want = locked.union(&path).copied().collect();
            }
            Ok(plan) => {
                let mut need: BTreeSet<Uuid> = BTreeSet::from([target]);
                for (id, _, _) in &plan.changes {
                    need.insert(*id);
                    if let Some(p) = l.parents.get(id).copied().flatten() {
                        need.insert(p);
                    }
                }
                if need.is_subset(&locked) {
                    return Ok(Ok((l, Some(plan))));
                }
                want = locked.union(&need).copied().collect();
            }
        }
    }
    Err(CmdError::Defect("funding lock set did not converge".into()))
}

/// The whole real `reallocate` step inside a command transaction: lock,
/// read, decide, apply.
pub async fn reallocate_in<S: Session>(
    tx: &mut Tx<'_, S>,
    org: Uuid,
    actor: Actor,
    target: Uuid,
    delta: PyNum,
    stale_state: Option<&str>,
) -> Result<Result<(PyNum, Vec<String>), Refusal>, CmdError> {
    let (l, plan) = match plan_locked(tx, org, actor, target, stale_state, false, &move |_| Ok(delta)).await? {
        Ok((l, Some(p))) => (l, p),
        Ok((_, None)) => return Err(CmdError::Defect("reallocate planned nothing".into())),
        Err(r) => return Ok(Err(r)),
    };
    if let Err(r) = apply(tx, org, &l, &plan).await? {
        return Ok(Err(r));
    }
    Ok(Ok((plan.new_grant, plan.warnings)))
}

// ---------------------------------------------------------------- reallocate

/// The answer of `reallocate` (legacy `{grant, warnings}`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reallocated {
    pub grant: Value,
    pub warnings: Vec<String>,
}

/// `credits.reallocate` (agent door: the caller acts) and
/// `operator.reallocate` (the user acts, or an agent named as actor, E5).
pub struct Reallocate {
    pub node: Uuid,
    pub delta: PyNum,
}

fn actor_of(b: &Binding) -> Actor {
    match (&b.principal, b.acting) {
        (_, Some(a)) => Actor::Agent(a),
        (Principal::Agent { id, .. }, None) => Actor::Agent(*id),
        _ => Actor::User,
    }
}

/// C3/E5 anchors: an agent caller's epoch and the killswitch; an acting
/// identity's epoch `FOR SHARE` (no generation or halt check, legacy).
async fn anchor_actor<S: Session>(tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
    let org = b.op.org;
    if let Principal::Agent { id, generation } = b.principal {
        if let Some(r) = anchor_agent_caller(tx, org, id, generation).await? {
            return Err(CmdError::Refused(r));
        }
    }
    if let Some(a) = b.acting {
        let rows = tx.exec("funding.acting_anchor", ACTING_ANCHOR_SQL, &[Val::Uuid(org), Val::Uuid(a)]).await?;
        if rows.is_empty() {
            return Err(CmdError::Refused(Refusal::new("unknown_actor", format!("unknown actor: {a}"))));
        }
    }
    Ok(())
}

impl Command for Reallocate {
    type Output = Reallocated;
    fn family(&self) -> &'static Family {
        &FUNDING
    }
    fn verb(&self) -> &'static str {
        "reallocate"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        anchor_actor(tx, b).await
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Reallocated) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Reallocated>, CmdError> {
        match reallocate_in(tx, b.op.org, actor_of(b), self.node, self.delta, None).await? {
            Ok((grant, warnings)) => Ok(Decided::Applied(Reallocated { grant: py_json(grant), warnings })),
            Err(r) => Ok(Decided::Refused(r)),
        }
    }
}

// ---------------------------------------------------------------- credit request (filing)

pub const REQUEST_BUMP_SQL: &str = "UPDATE authority_epoch SET requests_version = requests_version + 1, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2 AND lifecycle = 'live' AND generation = $3 AND NOT halted RETURNING requests_version";
pub const PENDING_SQL: &str = "SELECT batch_id, rev, legacy_id FROM request_batches \
    WHERE org_id = $1 AND asker_id = $2 AND kind = 'credit' AND state = 'pending' FOR NO KEY UPDATE";
pub const PENDING_UNLOCKED_SQL: &str = "SELECT batch_id, rev, legacy_id FROM request_batches \
    WHERE org_id = $1 AND asker_id = $2 AND kind = 'credit' AND state = 'pending'";
pub const WITHDRAW_SQL: &str = "UPDATE request_batches SET state = 'withdrawn', decided_at = $3 WHERE org_id = $1 AND batch_id = $2";
pub const AMEND_SQL: &str = "UPDATE request_batches SET payload = $3, rev = rev + 1 WHERE org_id = $1 AND batch_id = $2 RETURNING rev";
pub const REQUEST_COUNT_SQL: &str = "SELECT count(*) FROM request_batches WHERE org_id = $1 AND kind = 'credit'";
pub const REQUEST_INSERT_SQL: &str = "INSERT INTO request_batches (org_id, batch_id, asker_id, kind, state, rev, payload, created_at, legacy_id) \
    VALUES ($1, $2, $3, 'credit', 'pending', 1, $4, $5, $6)";
pub const DEFAULTS_SQL: &str = "SELECT coalesce((value->>'headless')::boolean, false) FROM org_controls \
    WHERE org_id = $1 AND family = 'defaults' FOR SHARE";
pub const USER_AUDIENCE_SQL: &str = "SELECT 1 FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = 'user' FOR SHARE";
pub const GRANT_SQL: &str = "SELECT grant_centi FROM funding_edges WHERE org_id = $1 AND child_id = $2";
pub const HEADROOM_NODE_SQL: &str = "SELECT t.parent_id, coalesce(f.grant_centi, 0) FROM topology_edges t \
    LEFT JOIN funding_edges f ON f.org_id = t.org_id AND f.child_id = t.principal_id WHERE t.org_id = $1 AND t.principal_id = $2";
pub const HEADROOM_CAPACITY_SQL: &str = "SELECT child_grants_centi, child_seats FROM issuer_capacity WHERE org_id = $1 AND principal_id = $2";
pub const HEADROOM_KIOSK_SQL: &str = "SELECT pool_centi, top_grants_centi, top_seats FROM kiosk_pool WHERE org_id = $1";

/// `orgtree_request_credits {new_limit, reason}` as the bound agent.
pub struct CreditRequest {
    pub new_limit: Value,
    pub reason: String,
    /// Q-FD2's unsafe control carries the early lookup from the anchor.
    early: Mutex<Option<Option<(Uuid, i64)>>>,
}

impl CreditRequest {
    pub fn new(new_limit: Value, reason: impl Into<String>) -> CreditRequest {
        CreditRequest { new_limit, reason: reason.into(), early: Mutex::new(None) }
    }
}

fn caller(b: &Binding) -> Result<(Uuid, i64), CmdError> {
    match b.principal {
        Principal::Agent { id, generation } => Ok((id, generation)),
        _ => Err(CmdError::Defect("a credit request is filed by an agent".into())),
    }
}

fn pending_of(rows: &crate::value::Rows) -> Option<(Uuid, i64)> {
    rows.first().and_then(|r| Some((r.first()?.as_uuid()?, r.get(1)?.as_int()?)))
}

async fn headroom<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid, l_prices: &BTreeMap<String, i64>, settings: (i64, bool)) -> Result<(Option<i64>, String), CmdError> {
    // Unlocked on purpose (S3 §4.13, legacy "conservative"): whole credits.
    let (cap, cascade_alloc) = settings;
    let kiosk = tx.exec("funding.headroom_kiosk", HEADROOM_KIOSK_SQL, &[Val::Uuid(org)]).await?;
    let pool: Option<(i64, i64)> = kiosk.first().map(|r| {
        let pool = r.first().and_then(Val::as_int).unwrap_or(0);
        let held = r.get(1).and_then(Val::as_int).unwrap_or(0) + r.get(2).and_then(Val::as_json).map_or(0, |s| priced(s, l_prices));
        (pool, pool / 100 - (held + 99).div_euclid(100))
    });
    let node_row = tx.exec("funding.headroom_node", HEADROOM_NODE_SQL, &[Val::Uuid(org), Val::Uuid(node)]).await?;
    let parent = node_row.first().and_then(|r| r.first()).and_then(Val::as_uuid);
    let grant = node_row.first().and_then(|r| r.get(1)).and_then(Val::as_int).unwrap_or(0);
    let ceil_c = |c: i64| (c + 99).div_euclid(100);
    let floor_c = |c: i64| c.div_euclid(100);
    let Some(parent) = parent else {
        let mut rooms: Vec<(i64, String)> = Vec::new();
        if cap != 0 {
            rooms.push((cap - ceil_c(grant), format!("your grant {} is at the org's top-level cap of {cap}", g(centi_to_py(grant)))));
        }
        if let Some((kc, p)) = pool {
            rooms.push((p, format!("the kiosk credit pool ({}) is fully held", g(centi_to_py(kc)))));
        }
        return Ok(rooms.into_iter().min_by_key(|r| r.0).map_or((None, String::new()), |(r, w)| (Some(r), w)));
    };
    let free_of = |grant: i64, cap_row: Option<&Vec<Val>>| -> i64 {
        let child = cap_row.and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        let seats = cap_row.and_then(|r| r.get(1)).and_then(Val::as_json).map_or(0, |s| priced(s, l_prices));
        grant - child - seats
    };
    let name_of_parent = tx.exec("funding.headroom_node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(parent)]).await?;
    let pname = name_of_parent.first().and_then(|r| r.get(1)).and_then(Val::as_text).unwrap_or("").to_string();
    if !cascade_alloc {
        let pg = tx.exec("funding.headroom_node", HEADROOM_NODE_SQL, &[Val::Uuid(org), Val::Uuid(parent)]).await?;
        let pgrant = pg.first().and_then(|r| r.get(1)).and_then(Val::as_int).unwrap_or(0);
        let capr = tx.exec("funding.headroom_capacity", HEADROOM_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(parent)]).await?;
        let room = floor_c(free_of(pgrant, capr.first()));
        return Ok((Some(room), format!("your superior \"{pname}\" has no free credits (allocation bubbling is off)")));
    }
    let mut free_sum = 0i64;
    let mut cur = Some(parent);
    let mut top_grant = 0i64;
    let mut seen = BTreeSet::new();
    while let Some(c) = cur {
        if !seen.insert(c) {
            break;
        }
        let r = tx.exec("funding.headroom_node", HEADROOM_NODE_SQL, &[Val::Uuid(org), Val::Uuid(c)]).await?;
        let cgrant = r.first().and_then(|r| r.get(1)).and_then(Val::as_int).unwrap_or(0);
        let capr = tx.exec("funding.headroom_capacity", HEADROOM_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(c)]).await?;
        free_sum += floor_c(free_of(cgrant, capr.first()).max(0));
        top_grant = cgrant;
        cur = r.first().and_then(|r| r.first()).and_then(Val::as_uuid);
    }
    let slack: Vec<i64> = [if cap != 0 { Some(cap - ceil_c(top_grant)) } else { None }, pool.map(|p| p.1)].into_iter().flatten().collect();
    if slack.is_empty() {
        return Ok((None, String::new()));
    }
    Ok((
        Some(free_sum + slack.iter().min().copied().unwrap_or(0).max(0)),
        "nothing is free along your superior chain and the org has no growth headroom (top-level cap / kiosk pool exhausted)".into(),
    ))
}

impl Command for CreditRequest {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &FUNDING
    }
    fn verb(&self) -> &'static str {
        "request"
    }
    /// The P7 bump IS the anchor: a conditional update of the asker's
    /// authority-epoch row (live, current generation, not halted). It waits
    /// for a retire, then sees it and refuses; a retire that comes second
    /// gets `40001` (it is SERIALIZABLE) and its retry moots the request.
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let (id, generation) = caller(b)?;
        let org = b.op.org;
        if controls::fire(&tx.scope(), "Q-FD2.lookup_before_bump") {
            let rows = tx.exec("funding.request_pending_unlocked", PENDING_UNLOCKED_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
            *self.early.lock().unwrap() = Some(pending_of(&rows));
            tx.pause("after_lookup").await?;
        }
        let ks = tx.exec("mail.anchor_killswitch", crate::mail::doors::KILLSWITCH_SQL, &[Val::Uuid(org)]).await?;
        if ks.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
            return Err(CmdError::Refused(Refusal::new("killswitch", "the organization's killswitch is engaged")));
        }
        let bumped = tx.exec("funding.request_bump", REQUEST_BUMP_SQL, &[Val::Uuid(org), Val::Uuid(id), Val::Int(generation)]).await?;
        if bumped.is_empty() {
            return Err(CmdError::Refused(Refusal::new("not_live", format!("{} is not live", id))));
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let (nid, _) = caller(b)?;
        let headless = tx.exec("funding.request_defaults", DEFAULTS_SQL, &[Val::Uuid(org)]).await?;
        if headless.first().and_then(|r| r.first()) == Some(&Val::Bool(true)) {
            return Ok(Decided::Refused(Refusal::new(
                "headless",
                "this org runs HEADLESS: no user is present and credit requests are auto-denied. Work within the grant you hold, or record the blocker with orgtree_status(blocked, …) — a human reads statuses later",
            )));
        }
        let edge = tx.exec("funding.chain_edge", CHAIN_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(nid)]).await?;
        let parent = edge.first().and_then(|r| r.first()).and_then(Val::as_uuid);
        if parent.is_some() && tx.exec("funding.request_audience", USER_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(nid)]).await?.is_empty() {
            return Ok(Decided::Refused(Refusal::new(
                "not_addressable",
                "only top-level agents (or holders of a user audience) may ask the user for credits directly — ask your superior to reallocate instead",
            )));
        }
        let Some(asked) = json_py(&self.new_limit).and_then(|p| q(p).ok()).and_then(|p| p.ceil().ok()) else {
            return Ok(Decided::Refused(Refusal::new("bad_request", "new_limit must be a number (the requested TOTAL grant)")));
        };
        let new_limit = py_to_centi(asked)?;
        let old = tx.exec("funding.request_grant", GRANT_SQL, &[Val::Uuid(org), Val::Uuid(nid)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        let early = self.early.lock().unwrap().take();
        let pending = match early {
            Some(p) => p,
            None => pending_of(&tx.exec("funding.request_pending", PENDING_SQL, &[Val::Uuid(org), Val::Uuid(nid)]).await?),
        };
        let now = tx.now().await?;
        let oldg = g(centi_to_py(old));
        if new_limit <= old {
            if let Some((batch, _)) = pending {
                tx.exec("funding.request_withdraw", WITHDRAW_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Ts(now)]).await?;
                return Ok(Decided::Applied(json!({"status": format!("your grant is already {oldg} — the pending request was withdrawn")})));
            }
            return Ok(Decided::Applied(json!({"status": format!("your grant is already {oldg} — nothing to request")})));
        }
        if self.reason.trim().is_empty() {
            return Ok(Decided::Refused(Refusal::new("bad_request", "a reason is required")));
        }
        // headroom: read without locks (legacy "conservative on purpose")
        let mut prices = BTreeMap::new();
        let ver = tx.exec("funding.catalog", "SELECT catalog_version FROM catalog_current WHERE org_id = $1", &[Val::Uuid(org)]).await?;
        let ver = ver.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(1);
        for r in tx.exec("funding.prices", PRICES_SQL, &[Val::Uuid(org), Val::Int(ver)]).await?.0 {
            if let (Some(t), Some(c)) = (r.first().and_then(Val::as_text), r.get(1).and_then(Val::as_int)) {
                prices.insert(t.to_string(), c);
            }
        }
        let ctl = tx
            .exec("funding.controls", "SELECT family, value FROM org_controls WHERE org_id = $1 AND family IN ('caps', 'cascade') ORDER BY family", &[Val::Uuid(org)])
            .await?;
        let mut cap = 0i64;
        let mut cascade_alloc = true;
        for r in &ctl.0 {
            let v = r.get(1).and_then(Val::as_json).cloned().unwrap_or(Value::Null);
            match r.first().and_then(Val::as_text) {
                Some("caps") => cap = v.get("max_top_grant").and_then(Value::as_f64).map_or(0, |x| x.trunc() as i64),
                Some("cascade") => cascade_alloc = v.get("cascade_alloc").map_or(true, |x| x.as_bool().unwrap_or(!x.is_null())),
                _ => {}
            }
        }
        let (room, why) = headroom(tx, org, nid, &prices, (cap, cascade_alloc)).await?;
        let asked_j = py_json(asked);
        if room.is_some_and(|r| r <= 0) {
            return Ok(Decided::Applied(json!({
                "refused": true,
                "status": format!("refused outright — there are ZERO credits available to grant ({why}). No request was made. Free credits (retire a sibling, hand back unused grant) or ask the user to raise the cap."),
            })));
        }
        let payload = json!({"old": py_json(centi_to_py(old)), "new": asked_j, "reason": self.reason.trim(), "at": now});
        let increase = py_json(centi_to_py(new_limit - old));
        if let Some((batch, _)) = pending {
            tx.exec("funding.request_amend", AMEND_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Json(payload)]).await?;
            return Ok(Decided::Applied(json!({
                "requested": asked_j, "increase": increase,
                "status": "pending (amended your earlier request) — the user will approve or deny",
            })));
        }
        let n = tx.exec("funding.request_count", REQUEST_COUNT_SQL, &[Val::Uuid(org)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        let legacy_id = format!("cr{}", n + 1);
        tx.exec(
            "funding.request_insert",
            REQUEST_INSERT_SQL,
            &[Val::Uuid(org), Val::Uuid(Uuid::new_v4()), Val::Uuid(nid), Val::Json(payload), Val::Ts(now), Val::text(legacy_id.clone())],
        )
        .await?;
        Ok(Decided::Applied(json!({
            "id": legacy_id, "requested": asked_j, "increase": increase,
            "status": "pending — the user will approve or deny",
        })))
    }
}

// ---------------------------------------------------------------- credit decision

pub const DECIDE_FIND_SQL: &str = "SELECT batch_id, asker_id, state, rev, payload FROM request_batches \
    WHERE org_id = $1 AND kind = 'credit' AND legacy_id = $2";
pub const DECIDE_LIVENESS_SQL: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const DECIDE_LIVENESS_UNLOCKED_SQL: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const DECIDE_MOOT_SQL: &str = "UPDATE request_batches SET state = 'moot', decided_at = $3, result = $4 \
    WHERE org_id = $1 AND batch_id = $2 AND state = 'pending' RETURNING rev";
pub const DECIDE_MOOT_UNCONDITIONAL_SQL: &str = "UPDATE request_batches SET state = 'moot', decided_at = $3, result = $4 \
    WHERE org_id = $1 AND batch_id = $2 RETURNING rev";
/// §4.13 step 2: the compare-and-set, BEFORE any amount is computed. `$4`
/// is the optional expected revision (E-D14: NULL on the decision route).
pub const DECIDE_CAS_SQL: &str = "UPDATE request_batches SET state = $3, decided_at = $5 \
    WHERE org_id = $1 AND batch_id = $2 AND state = 'pending' AND ($4::bigint IS NULL OR rev = $4::bigint) RETURNING payload, rev";
pub const DECIDE_UNCONDITIONAL_SQL: &str = "UPDATE request_batches SET state = $3, decided_at = $4 WHERE org_id = $1 AND batch_id = $2 RETURNING payload, rev";
pub const DECIDE_RESULT_SQL: &str = "UPDATE request_batches SET result = $3 WHERE org_id = $1 AND batch_id = $2";

/// `POST /credit-requests {id, action, granted?}` (the user decides), and
/// the batch door's variant carrying the revision it showed (E-D14).
pub struct CreditDecide {
    pub request: String,
    pub action: String,
    pub granted: Option<Value>,
    pub expected_rev: Option<i64>,
}

fn no_pending(rid: &str) -> Refusal {
    Refusal::new("no_pending", format!("no pending credit request '{rid}'"))
}

impl Command for CreditDecide {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &FUNDING
    }
    fn verb(&self) -> &'static str {
        "decide"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        // The user decides: nothing in the organization narrows the operator
        // (S3 E2). The agent's anchor is taken in execute, once the request
        // row names the agent (step 1).
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let found = tx.exec("funding.decide_find", DECIDE_FIND_SQL, &[Val::Uuid(org), Val::text(self.request.clone())]).await?;
        let Some(row) = found.first() else { return Ok(Decided::Refused(no_pending(&self.request))) };
        let batch = row.first().and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("bad request row".into()))?;
        let agent = row.get(1).and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("bad request row".into()))?;
        let read_state = row.get(2).and_then(Val::as_text).unwrap_or("").to_string();
        if self.action != "approve" && self.action != "deny" {
            if read_state != "pending" {
                return Ok(Decided::Refused(no_pending(&self.request)));
            }
            return Ok(Decided::Refused(Refusal::new("bad_request", "action must be approve|deny")));
        }
        // Controls (each removes BOTH protections its schedule names):
        let fd1_i = controls::fire(&tx.scope(), "Q-FD1.no_cas_prelock_delta");
        let fd1_ii = !fd1_i && controls::fire(&tx.scope(), "Q-FD1.no_cas_postlock_delta");
        let fd3_a = controls::fire(&tx.scope(), "Q-FD3.no_anchor_no_cas");
        let fd3_c = !fd3_a && controls::fire(&tx.scope(), "Q-FD3.liveness_once");
        let no_cas = fd1_i || fd1_ii || fd3_a;

        // Step 1: the agent anchor (FOR SHARE), or its unlocked read under a control.
        let live_rows = if fd3_a || fd3_c {
            tx.exec("funding.decide_liveness_unlocked", DECIDE_LIVENESS_UNLOCKED_SQL, &[Val::Uuid(org), Val::Uuid(agent)]).await?
        } else {
            tx.exec("funding.decide_liveness", DECIDE_LIVENESS_SQL, &[Val::Uuid(org), Val::Uuid(agent)]).await?
        };
        let lifecycle = live_rows.first().and_then(|r| r.first()).and_then(Val::as_text).map(str::to_string);
        tx.pause("after_liveness").await?;
        // Q-FD1 (i): the grant read BEFORE the funding locks.
        let prelock_grant = if fd1_i {
            Some(tx.exec("funding.decide_prelock_grant", GRANT_SQL, &[Val::Uuid(org), Val::Uuid(agent)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0))
        } else {
            None
        };
        let now = tx.now().await?;
        let live = lifecycle.as_deref() == Some("live");
        let rid = self.request.clone();

        if self.action == "approve" && !live {
            // The moot is itself a compare-and-set (never overwrites an answer).
            let note = json!({"note": format!("{} is no longer live — dropped as moot", rid)});
            let sql = if controls::fire(&tx.scope(), "Q-FD3.moot_unconditional") { DECIDE_MOOT_UNCONDITIONAL_SQL } else { DECIDE_MOOT_SQL };
            let r = tx.exec("funding.decide_moot", sql, &[Val::Uuid(org), Val::Uuid(batch), Val::Ts(now), Val::Json(note.clone())]).await?;
            if r.is_empty() {
                return Ok(Decided::Refused(no_pending(&rid)));
            }
            return Ok(Decided::Applied(json!({"id": rid, "status": "moot", "note": note["note"]})));
        }

        // Step 2: the compare-and-set before any amount (or, under a
        // control, the pending status read unlocked and written unconditionally).
        let new_state = if self.action == "approve" { "answered" } else { "denied" };
        let payload = if no_cas {
            if read_state != "pending" {
                return Ok(Decided::Refused(no_pending(&rid)));
            }
            let r = tx.exec("funding.decide_unconditional", DECIDE_UNCONDITIONAL_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::text(new_state), Val::Ts(now)]).await?;
            r.first().and_then(|r| r.first()).and_then(Val::as_json).cloned()
        } else {
            let r = tx
                .exec(
                    "funding.decide_cas",
                    DECIDE_CAS_SQL,
                    &[Val::Uuid(org), Val::Uuid(batch), Val::text(new_state), Val::opt_int(self.expected_rev), Val::Ts(now)],
                )
                .await?;
            match r.first() {
                None if self.expected_rev.is_some() && read_state == "pending" => {
                    return Ok(Decided::Refused(Refusal::new("stale_card", "the card changed after it rendered — reopen it and decide again")));
                }
                None => return Ok(Decided::Refused(no_pending(&rid))),
                Some(r) => r.first().and_then(Val::as_json).cloned(),
            }
        };
        let payload = payload.unwrap_or(Value::Null);
        tx.pause("after_cas").await?;
        let old = payload.get("old").cloned().unwrap_or(json!(0));
        let asked = payload.get("new").cloned().unwrap_or(json!(0));

        if self.action == "deny" {
            let notice = format!("Your credit request {rid} (asked {}) was denied.", g(json_py(&asked).unwrap_or(PyNum::Int(0))));
            let result = json!({"notice": notice});
            tx.exec("funding.decide_result", DECIDE_RESULT_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Json(result)]).await?;
            answer_mail(tx, org, agent, &notice).await?;
            return Ok(Decided::Applied(json!({"id": rid, "status": "denied", "old": old, "new": asked, "notice": notice})));
        }

        // Step 3-4: the funding locks, then the amount from the locked figure
        // and the grant read after the locks.
        let give_py = match &self.granted {
            Some(v) => json_py(v),
            None => json_py(&asked),
        }
        .and_then(|p| q(p).ok())
        .and_then(|p| p.ceil().ok())
        .ok_or_else(|| CmdError::Defect("undecodable credit figure".into()))?;
        let give = py_to_centi(give_py)?;
        let stale = if fd3_a || fd3_c { lifecycle.as_deref() } else { None };
        // Q-FD1 (i) computes the delta from the grant read before the locks
        // and applies it as an increment under them; otherwise the grant is
        // read after the locks.
        let delta_of = move |l: &Loaded| -> Result<PyNum, CmdError> {
            let base = match prelock_grant {
                Some(g) => g,
                None => l.grant(agent).unwrap_or(0),
            };
            Ok(centi_to_py(give - base))
        };
        let mut warnings = Vec::new();
        match plan_locked(tx, org, Actor::User, agent, stale, true, &delta_of).await? {
            Err(r) => return Ok(Decided::Refused(r)),
            Ok((_, None)) => {}
            Ok((l, Some(plan))) => {
                if let Err(r) = apply(tx, org, &l, &plan).await? {
                    return Ok(Decided::Refused(r));
                }
                warnings = plan.warnings;
            }
        }
        let now_grant = tx.exec("funding.request_grant", GRANT_SQL, &[Val::Uuid(org), Val::Uuid(agent)]).await?.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        let old_c = json_py(&old).map(py_to_centi).transpose()?.unwrap_or(0);
        let asked_c = json_py(&asked).map(py_to_centi).transpose()?.unwrap_or(0);
        let outcome = if give == asked_c {
            "approved"
        } else if give > old_c {
            "counter"
        } else if give == old_c {
            "declined"
        } else {
            "reduced"
        };
        let notice = format!(
            "Your credit request {rid}: asked {}, granted {} ({outcome}); your grant is now {}. You may ask again if you need more.",
            g(centi_to_py(asked_c)),
            g(give_py),
            g(centi_to_py(now_grant))
        );
        let result = json!({"granted": py_json(give_py), "notice": notice, "outcome": outcome});
        tx.exec("funding.decide_result", DECIDE_RESULT_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Json(result)]).await?;
        answer_mail(tx, org, agent, &notice).await?;
        Ok(Decided::Applied(json!({
            "id": rid, "status": "answered", "old": old, "new": asked, "granted": py_json(give_py),
            "notice": notice, "warnings": warnings,
        })))
    }
}

/// The answer as user mail to the agent (E1; the agent's mailbox owns its
/// receipt and wake). User→agent keeps pair order.
async fn answer_mail<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, agent: Uuid, body: &str) -> Result<(), CmdError> {
    let r = match sent::resolve_recipient(tx, org, agent, RecipientLock::Share).await {
        Ok(r) => r,
        Err(SendError::Refused(_)) => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let id = Uuid::new_v4();
    let req = SendRequest::message(MailSource::User, r.dest, id, "decision.credit", body.to_string(), format!("decision.credit:{id}"));
    match sent::record_sent(tx, &req).await {
        Ok(_) | Err(SendError::Refused(_)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// DECLARED-CONTACTS for the funding verbs.
pub fn declared() -> Value {
    let funding_rows = json!({
        "topology_edges": {"modes": ["read", "for_share"], "required": true},
        "catalog_current": {"modes": ["read", "for_share"], "required": true},
        "price_catalog": {"modes": ["read"], "required": true},
        "org_controls": {"modes": ["read", "for_share"], "required": true},
        "funding_edges": {"modes": ["read", "for_no_key_update", "write"], "required": true},
        "issuer_capacity": {"modes": ["read", "for_no_key_update", "write"], "required": true},
        "agents": {"modes": ["read"], "required": true},
        "authority_epoch": {"modes": ["read", "for_share"], "required": true},
        "kiosk_pool": {"modes": ["read", "for_no_key_update", "write"], "required": false},
        "mailboxes": {"modes": ["read"], "required": false},
        "mail_sent": {"modes": ["read", "write"], "required": false},
        "outgoing_intents": {"modes": ["write"], "required": false},
        "operation_receipts": {"modes": ["read", "write"], "required": true}
    });
    let mut decide = funding_rows.clone();
    decide["request_batches"] = json!({"modes": ["read", "write"], "required": true});
    json!({
        "funding.reallocate": {
            "relations": funding_rows,
            "p01_contract": "credits.reallocate",
            "source": "r7 §6.4 reallocate row, C2a P2, C4; S3 E8 (kiosk pool last)"
        },
        "funding.decide": {
            "relations": decide,
            "p01_contract": "credits.decide",
            "source": "S3 §4.13 steps 1-5, E-D14"
        },
        "funding.request": {
            "relations": {
                "authority_epoch": {"modes": ["read", "write"], "required": true},
                "org_controls": {"modes": ["read", "for_share"], "required": true},
                "topology_edges": {"modes": ["read", "for_share"], "required": true},
                "audience_grants": {"modes": ["read", "for_share"], "required": false},
                "funding_edges": {"modes": ["read"], "required": true},
                "request_batches": {"modes": ["read", "for_no_key_update", "write"], "required": true},
                "catalog_current": {"modes": ["read"], "required": false},
                "price_catalog": {"modes": ["read"], "required": false},
                "issuer_capacity": {"modes": ["read"], "required": false},
                "kiosk_pool": {"modes": ["read"], "required": false},
                "agents": {"modes": ["read"], "required": false},
                "operation_receipts": {"modes": ["read", "write"], "required": true}
            },
            "p01_contract": "credits.request",
            "source": "S3 §4.13 filing rule, r7 C2a P7"
        }
    })
}
