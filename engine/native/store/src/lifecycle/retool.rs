//! Retool / set_scope (`lifecycle.retool`, `lifecycle.operator-scope`):
//! READ COMMITTED **outside** the island (r7 C2a, §6.4; lead ruling
//! 2026-09-25 14:21Z). Only the account branch that splits the session is
//! an island member ([`crate::lifecycle::split`], S3 §3.1).
//!
//! r7 §6.4 P3, the outside writer's order:
//! * **narrowing** (rule 2): `FOR NO KEY UPDATE` the narrowed node's scope
//!   row FIRST and write it; only then, in a later statement, list its
//!   descendants, lock them top-down and clamp them. Permission mode is
//!   clamped only when the mode itself is lowered (D-101). A restriction
//!   obligation is recorded (`restriction_epoch FOR SHARE` first, required).
//! * **widening** (D-106, rule 3): `FOR SHARE` the GRANTER's scope row (the
//!   capability is validated against the granter, not the target's parent),
//!   then `FOR NO KEY UPDATE` the raised chain top-down (every node between
//!   the granter and the target), then the target; each raised row gains
//!   what was granted.
//! * **pure charter** (`charter` / `team_charter` only, Q-CR1): a new
//!   immutable charter version and its head; NO scope or epoch version bump.
//!
//! Unsafe controls: `Q-C11.widen_no_granter_anchor` (r7 Q-C11 (c): no anchor
//! on the granter's scope row) and `Q-C11.perm_mode_swept_every_edit` (r7
//! Q-C11 (d): permission mode swept on every scope edit).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::hooks::controls;
use crate::island::{self, clamp, Caller, Lock, Scope};
use crate::lifecycle::topo::decided;
use crate::lifecycle::{require_authority, OUTSIDE};
use crate::restrict;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const SCOPE_WRITE_SQL: &str = "UPDATE scope_rows SET tools = $3, folders = $4, visibility = $5, permission_mode = $6, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";
pub const CHARTER_HEAD_SQL: &str = "SELECT current_version FROM charter_heads WHERE org_id = $1 AND principal_id = $2 AND charter_kind = $3 FOR NO KEY UPDATE";
pub const CHARTER_VERSION_SQL: &str = "INSERT INTO charter_versions (org_id, principal_id, charter_kind, version, body, body_sha256, saved_at) \
    VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())";
pub const CHARTER_HEAD_INSERT_SQL: &str = "INSERT INTO charter_heads (org_id, principal_id, charter_kind, current_version) VALUES ($1, $2, $3, $4)";
pub const CHARTER_HEAD_UPDATE_SQL: &str = "UPDATE charter_heads SET current_version = $4 WHERE org_id = $1 AND principal_id = $2 AND charter_kind = $3";

/// What a retool changes. `None` fields are untouched.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScopeChange {
    pub folders: Option<Value>,
    pub tools: Option<Value>,
    pub visibility: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RetoolKind {
    /// Set the target's scope to `change` (a narrowing when it removes
    /// something; the subtree is clamped).
    Set(ScopeChange),
    /// D-106: `granter` grants `change` to the target (a descendant); every
    /// node between them is raised to hold it.
    Widen { granter: Uuid, change: ScopeChange },
    /// Q-CR1: a pure charter edit (`role` or `team`).
    Charter { kind: String, body: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetoolOut {
    pub clamped: i64,
    pub raised: i64,
    pub charter_version: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Retool {
    pub target: Uuid,
    pub kind: RetoolKind,
}

impl Command for Retool {
    type Output = RetoolOut;
    fn family(&self) -> &'static Family {
        &OUTSIDE
    }
    fn verb(&self) -> &'static str {
        match self.kind {
            RetoolKind::Set(_) => "retool",
            RetoolKind::Widen { .. } => "widen",
            RetoolKind::Charter { .. } => "charter",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &RetoolOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RetoolOut>, CmdError> {
        let org = b.op.org;
        let caller = island::caller_of(b);
        decided(match &self.kind {
            RetoolKind::Set(c) => set_in(tx, org, &caller, self.target, c).await,
            RetoolKind::Widen { granter, change } => widen_in(tx, org, &caller, *granter, self.target, change).await,
            RetoolKind::Charter { kind, body } => charter_in(tx, org, &caller, self.target, kind, body).await,
        })
    }
}

fn apply(s: &Scope, c: &ScopeChange) -> Scope {
    Scope {
        depth: s.depth,
        tools: c.tools.clone().unwrap_or_else(|| s.tools.clone()),
        folders: c.folders.clone().unwrap_or_else(|| s.folders.clone()),
        visibility: c.visibility.clone().unwrap_or_else(|| s.visibility.clone()),
        permission_mode: c.permission_mode.clone().unwrap_or_else(|| s.permission_mode.clone()),
        version: s.version,
    }
}

async fn write_scope<S: Session>(tx: &mut Tx<'_, S>, label: &str, org: Uuid, p: Uuid, s: &Scope) -> Result<(), CmdError> {
    tx.exec(label, SCOPE_WRITE_SQL, &[Val::Uuid(org), Val::Uuid(p), Val::Json(s.tools.clone()), Val::Json(s.folders.clone()), Val::text(s.visibility.clone()), Val::text(s.permission_mode.clone())])
        .await?;
    Ok(())
}

async fn target_live<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, target: Uuid, allow_self: bool) -> Result<(), CmdError> {
    require_authority(tx, org, caller, target, allow_self).await?;
    let e = island::lock_epoch(tx, "island.share_epoch", org, target, Lock::Share).await?;
    if !e.is_some_and(|e| e.live()) {
        return island::refuse("not_live", "the target is not live");
    }
    Ok(())
}

/// A retool of the target's scope. Rule 2: the target's row locked and
/// written FIRST; then its descendants listed, locked top-down, clamped.
pub async fn set_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, target: Uuid, c: &ScopeChange) -> Result<RetoolOut, CmdError> {
    target_live(tx, org, caller, target, false).await?;
    let own = island::lock_scope_rows(tx, "retool.scope_lock", org, &[target], Lock::Update).await?;
    let Some(Some(cur)) = own.into_iter().next().map(|x| x.1) else { return island::refuse("unknown_node", "the target has no scope row") };
    let next = apply(&cur, c);
    write_scope(tx, "island.narrow", org, target, &next).await?;
    // the mode is clamped below only when the mode itself was lowered (D-101)
    let pm_level = |m: &str| orgtree_scope_clamp::clamp::PM_LEVELS.iter().position(|x| *x == m);
    let mode_lowered = matches!((pm_level(&cur.permission_mode), pm_level(&next.permission_mode)), (Some(a), Some(b)) if b < a);
    let with_mode = mode_lowered || controls::fire(&tx.scope(), "Q-C11.perm_mode_swept_every_edit");
    // list AFTER the lock (a later statement), then lock and clamp top-down
    let sub = island::subtree(tx, org, &[target]).await?;
    let below: Vec<Uuid> = sub.iter().filter(|(_, d)| *d > 0).map(|(x, _)| *x).collect();
    let rows = island::lock_scope_rows(tx, "retool.scope_subtree", org, &below, Lock::Update).await?;
    let mut done: Vec<(Uuid, Scope)> = vec![(target, next)];
    let mut clamped = 0i64;
    for (x, row) in rows {
        let Some(row) = row else { continue };
        let Some(p) = island::parent_of(tx, org, x).await? else { continue };
        let Some(ps) = done.iter().find(|(y, _)| *y == p).map(|(_, s)| s.clone()) else { continue };
        let c = clamp::clamp(&row, &ps, with_mode)?;
        if c.changed {
            write_scope(tx, "island.scope_clamp", org, x, &c.scope).await?;
            clamped += 1;
        }
        done.push((x, c.scope));
    }
    restrict::record(tx, org, "retool").await?;
    Ok(RetoolOut { clamped, raised: 0, charter_version: None })
}

/// D-106 widening: validate against the GRANTER's own row (share-locked),
/// raise the chain between granter and target top-down, then the target.
pub async fn widen_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, granter: Uuid, target: Uuid, c: &ScopeChange) -> Result<RetoolOut, CmdError> {
    let chain = require_authority(tx, org, caller, target, false).await?;
    let Some(gi) = chain.iter().position(|x| *x == granter) else {
        return island::refuse("forbidden", "the granter is not an ancestor of the target");
    };
    let e = island::lock_epoch(tx, "island.share_epoch", org, target, Lock::Share).await?;
    if !e.is_some_and(|e| e.live()) {
        return island::refuse("not_live", "the target is not live");
    }
    // rule 3: the granter's row FOR SHARE (unless the Q-C11 (c) control)
    let granter_lock = if controls::fire(&tx.scope(), "Q-C11.widen_no_granter_anchor") { Lock::Read } else { Lock::Share };
    let g = island::lock_scope_rows(tx, "retool.granter_share", org, &[granter], granter_lock).await?;
    let Some(Some(gs)) = g.into_iter().next().map(|x| x.1) else { return island::refuse("unknown_node", "the granter has no scope row") };
    // validate: what is granted must be within the granter's own capability
    let probe = Scope {
        depth: 0,
        tools: c.tools.clone().unwrap_or(Value::Object(Default::default())),
        folders: c.folders.clone().unwrap_or(Value::Array(vec![])),
        visibility: c.visibility.clone().unwrap_or_else(|| gs.visibility.clone()),
        permission_mode: c.permission_mode.clone().unwrap_or_else(|| gs.permission_mode.clone()),
        version: 0,
    };
    if clamp::clamp(&probe, &gs, true)?.changed {
        return island::refuse("exceeds_granter", "the granter does not hold what it is granting");
    }
    // the raised chain: strictly between granter and target, top-down, then the target
    let mut raised_nodes: Vec<Uuid> = chain[1..gi].to_vec();
    raised_nodes.reverse();
    raised_nodes.push(target);
    let rows = island::lock_scope_rows(tx, "retool.raise_lock", org, &raised_nodes, Lock::Update).await?;
    let mut raised = 0i64;
    for (x, row) in rows {
        let Some(row) = row else { continue };
        let next = union(&row, c);
        if next != row {
            write_scope(tx, "retool.raise", org, x, &next).await?;
            raised += 1;
        }
    }
    Ok(RetoolOut { clamped: 0, raised, charter_version: None })
}

/// Raise `s` to hold `c` (folders and tools unioned; visibility and mode set
/// when wider).
fn union(s: &Scope, c: &ScopeChange) -> Scope {
    let mut out = s.clone();
    if let Some(Value::Array(add)) = &c.folders {
        let mut have = match &s.folders {
            Value::Array(a) => a.clone(),
            _ => vec![],
        };
        for f in add {
            let path = f.get("path");
            match have.iter_mut().find(|h| h.get("path") == path) {
                Some(h) => {
                    if f.get("mode") == Some(&Value::from("rw")) {
                        *h = f.clone();
                    }
                }
                None => have.push(f.clone()),
            }
        }
        out.folders = Value::Array(have);
    }
    if let Some(Value::Object(add)) = &c.tools {
        let mut t = match &s.tools {
            Value::Object(o) => o.clone(),
            _ => Default::default(),
        };
        for (k, v) in add {
            t.insert(k.clone(), v.clone());
        }
        out.tools = Value::Object(t);
    }
    let lv = |levels: &[&str], m: &str| levels.iter().position(|x| *x == m);
    if let Some(v) = &c.visibility {
        if lv(&orgtree_scope_clamp::clamp::VIS_LEVELS, v) > lv(&orgtree_scope_clamp::clamp::VIS_LEVELS, &s.visibility) {
            out.visibility = v.clone();
        }
    }
    if let Some(m) = &c.permission_mode {
        if lv(&orgtree_scope_clamp::clamp::PM_LEVELS, m) > lv(&orgtree_scope_clamp::clamp::PM_LEVELS, &s.permission_mode) {
            out.permission_mode = m.clone();
        }
    }
    out
}

/// Q-CR1: a pure `charter` / `team_charter` edit. Writes ONLY the immutable
/// version and its head: no scope row, no epoch row, no version bump.
pub async fn charter_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, target: Uuid, kind: &str, body: &str) -> Result<RetoolOut, CmdError> {
    // self only for team_charter (r7 §6.4 retool row)
    target_live(tx, org, caller, target, kind == "team").await?;
    let head = tx.exec("retool.charter_head", CHARTER_HEAD_SQL, &[Val::Uuid(org), Val::Uuid(target), Val::text(kind)]).await?;
    let cur = head.first().and_then(|r| r.first()).and_then(Val::as_int);
    let next = cur.unwrap_or(0) + 1;
    let sha = orgtree_op_receipt_codec::sha256::hex(&orgtree_op_receipt_codec::sha256::sha256(body.as_bytes()));
    tx.exec("retool.charter_version", CHARTER_VERSION_SQL, &[Val::Uuid(org), Val::Uuid(target), Val::text(kind), Val::Int(next), Val::text(body), Val::text(sha)]).await?;
    if cur.is_some() {
        tx.exec("retool.charter_head_update", CHARTER_HEAD_UPDATE_SQL, &[Val::Uuid(org), Val::Uuid(target), Val::text(kind), Val::Int(next)]).await?;
    } else {
        tx.exec("retool.charter_head_insert", CHARTER_HEAD_INSERT_SQL, &[Val::Uuid(org), Val::Uuid(target), Val::text(kind), Val::Int(next)]).await?;
    }
    Ok(RetoolOut { clamped: 0, raised: 0, charter_version: Some(next) })
}
