//! The move family (r7 §6.4 `move` row, C2a P1/P2/P3/P5/P6; S3 §3.1 lineage
//! stacks): move (and promote/demote, its two directions), swap,
//! subjugation and `insert_parent` re-parent through [`move_in`].
//!
//! One attempt of a move of `node` under `new_parent` (C4 order):
//! 1. caller anchor (C3);
//! 2. `island.snapshot` (plain read of the node's epoch). Pause
//!    `island.move.after_snapshot`;
//! 3. authority: the node's chain and the new parent's chain, edge rows
//!    `FOR SHARE` (C3); a lineage bearer never moves on its own;
//! 4. the new parent's epoch row `FOR SHARE` (live, not archived);
//! 5. the moved set = the node plus its lineage stack (`island.stack`, the
//!    read a lineage split's insert conflicts with: Q-E2). Pause
//!    `island.move.after_stack_read`. The re-anchored set = the moved set and
//!    all their descendants; the new parent must not be in it (cycle guard);
//! 6. P6: `caps`, `directories`, `kiosk` control rows `FOR SHARE`; the depth
//!    cap (new parent's depth + 1 + the subtree's height) and the children
//!    cap (the new parent's live children);
//! 7. P3: the scope rows of the new parent's WHOLE chain `FOR SHARE`,
//!    top-down, then the moved subtree's scope rows `FOR NO KEY UPDATE`
//!    top-down, each clamped to its (new) parent (with permission mode: a
//!    move sweeps it) and its depth rewritten;
//! 8. P1: the authority-epoch row of every node in the RE-ANCHORED set
//!    `FOR SHARE` before reading its grants; a grant whose anchor is no
//!    longer an ancestor of its grantee is swept and the grantee bumped;
//! 9. P2: when the node is live, its old payer's and new payer's capacity
//!    rows `FOR NO KEY UPDATE`, updated (the re-seat), and its funding edge;
//! 10. the node's edge row and its bearers' edge rows re-parented;
//! 11. a restriction obligation (C5: every node whose parent changed and
//!     their former ancestors/siblings; recorded coarse).
//!
//! Unsafe controls (armed only by their schedule):
//! * `Q-C7.sweep_moved_set_only` (r7 Q-C7 (d)): step 8 limited to legacy's
//!   moved set (the node and its lineage stack);
//! * `Q-C11.mover_parent_scope_only` (r7 Q-C11 (a)/(b)): step 7 share-locks
//!   only the new parent's scope row;
//! * `Q-C2.move_read_committed` (r7 Q-C2): [`MoveRc`], the same writer run at
//!   READ COMMITTED outside the island.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::hooks::controls;
use crate::island::{self, clamp, Caller, Lock};
use crate::lifecycle::{move_obligation, obligation, require_authority, ISLAND, UNSAFE_RC};
use crate::restrict;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const GRANTS_OF_SQL: &str = "SELECT target_kind, target_id, anchor_id FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 ORDER BY target_kind, target_id";
pub const SWEEP_SQL: &str = "DELETE FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = $3 AND target_id = $4";
pub const REPARENT_SQL: &str = "UPDATE topology_edges SET parent_id = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const SCOPE_WRITE_SQL: &str = "UPDATE scope_rows SET depth = $3, tools = $4, folders = $5, visibility = $6, permission_mode = $7, version = version + 1 \
    WHERE org_id = $1 AND principal_id = $2";
pub const RESEAT_SQL: &str = "UPDATE funding_edges SET issuer_id = $3, version = version + 1 WHERE org_id = $1 AND child_id = $2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveOut {
    /// Nodes whose edge row changed (the node and its bearers).
    pub moved: Vec<Uuid>,
    /// Audience grants swept (P1).
    pub swept: i64,
    /// Scope rows clamped (P3).
    pub clamped: i64,
    pub noop: bool,
}

#[derive(Clone, Debug)]
pub struct Move {
    pub node: Uuid,
    pub new_parent: Option<Uuid>,
}

impl Command for Move {
    type Output = MoveOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        "move"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &MoveOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<MoveOut>, CmdError> {
        decided(move_in(tx, b.op.org, &island::caller_of(b), self.node, self.new_parent).await)
    }
}

/// r7 Q-C2's unsafe control: the move run at READ COMMITTED outside the
/// island. Only ever run with `Q-C2.move_read_committed` armed (it refuses
/// to run otherwise, so it can never stand in for the real writer).
#[derive(Clone, Debug)]
pub struct MoveRc(pub Move);

impl Command for MoveRc {
    type Output = MoveOut;
    fn family(&self) -> &'static Family {
        &UNSAFE_RC
    }
    fn verb(&self) -> &'static str {
        "move"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &MoveOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<MoveOut>, CmdError> {
        if !controls::fire(&tx.scope(), "Q-C2.move_read_committed") {
            return Err(CmdError::Defect("MoveRc runs only under its armed unsafe control".into()));
        }
        decided(move_in(tx, b.op.org, &island::caller_of(b), self.0.node, self.0.new_parent).await)
    }
}

pub(crate) fn decided<T>(r: Result<T, CmdError>) -> Result<Decided<T>, CmdError> {
    match r {
        Ok(o) => Ok(Decided::Applied(o)),
        Err(CmdError::Refused(r)) => Ok(Decided::Refused(r)),
        Err(e) => Err(e),
    }
}

/// The move's body (also the re-parent leg of swap, subjugation and
/// `insert_parent`).
pub async fn move_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, new_parent: Option<Uuid>) -> Result<MoveOut, CmdError> {
    // 2
    let seen = island::lock_epoch(tx, "island.snapshot", org, node, Lock::Read).await?;
    tx.pause("after_snapshot").await?;
    let Some(seen) = seen else { return island::refuse("unknown_node", "no such node") };
    // 3
    if island::bearer_of(tx, org, node).await?.is_some() {
        return island::refuse("lineage_bearer", "that is a lineage generation — move its live agent and the whole stack follows");
    }
    let old_chain = require_authority(tx, org, caller, node, true).await?;
    let old_parent = old_chain.get(1).copied();
    if old_parent == new_parent {
        return Ok(MoveOut { moved: vec![], swept: 0, clamped: 0, noop: true });
    }
    let new_chain = match new_parent {
        Some(p) => require_authority(tx, org, caller, p, true).await?,
        None if caller.is_user_level() => vec![],
        None => return island::refuse("forbidden", "only the user may move a node to the top level"),
    };
    // 4
    if let Some(p) = new_parent {
        let e = island::lock_epoch(tx, "island.share_epoch", org, p, Lock::Share).await?;
        if !e.is_some_and(|e| e.live()) {
            return island::refuse("parent_not_live", "the new parent is not live");
        }
    }
    // 5
    let bearers: Vec<Uuid> = island::stack(tx, org, node).await?.into_iter().map(|b| b.id).collect();
    tx.pause("after_stack_read").await?;
    let mut moved_set = vec![node];
    moved_set.extend(bearers.iter().copied());
    let reanchored = island::subtree(tx, org, &moved_set).await?;
    if let Some(p) = new_parent {
        if reanchored.iter().any(|(x, _)| *x == p) {
            return island::refuse("cycle", "that would put the node under its own subtree");
        }
    }
    // 6
    let controls = island::share_controls(tx, org, &["caps", "directories", "kiosk"]).await?;
    let new_depth = new_chain.len() as i64; // the moved node's new depth (top level = 0)
    if let Some(max) = island::cap(&controls, "max_depth") {
        let height = reanchored.iter().map(|(_, d)| *d as i64).max().unwrap_or(0);
        if new_depth + height >= max {
            return island::refuse("depth_cap", format!("the move would exceed the maximum depth of {max}"));
        }
    }
    if let Some(max) = island::cap(&controls, "max_children") {
        if island::org_children(tx, org, new_parent).await? >= max {
            return island::refuse("children_cap", format!("the new parent already has {max} reports (cap)"));
        }
    }
    // 7: P3
    let mut chain_top_down = new_chain.clone();
    chain_top_down.reverse();
    let share: Vec<Uuid> = if controls::fire(&tx.scope(), "Q-C11.mover_parent_scope_only") { new_parent.into_iter().collect() } else { chain_top_down.clone() };
    let locked = island::lock_scope_rows(tx, "island.scope_chain", org, &share, Lock::Share).await?;
    let parent_scope = new_parent.and_then(|p| locked.iter().find(|(x, _)| *x == p).and_then(|(_, s)| s.clone()));
    let subtree_nodes: Vec<Uuid> = reanchored.iter().map(|(x, _)| *x).collect();
    let rows = island::lock_scope_rows(tx, "island.scope_subtree", org, &subtree_nodes, Lock::Update).await?;
    let mut clamped = 0i64;
    // top-down: each node clamps against its own parent's NEW row
    let mut new_rows: Vec<(Uuid, island::Scope)> = Vec::new();
    for ((x, rel), (_, row)) in reanchored.iter().zip(rows.iter()) {
        let Some(row) = row else { continue };
        let parent = if moved_set.contains(x) { new_parent } else { island::parent_of(tx, org, *x).await? };
        let pscope = match parent {
            Some(p) if moved_set.contains(x) => parent_scope.clone(),
            Some(p) => new_rows.iter().find(|(y, _)| *y == p).map(|(_, s)| s.clone()),
            None => None,
        };
        let mut next = match &pscope {
            Some(ps) => clamp::clamp(row, ps, true)?.scope,
            None => row.clone(),
        };
        next.depth = new_depth + *rel as i64;
        if next != *row {
            tx.exec(
                "island.scope_clamp",
                SCOPE_WRITE_SQL,
                &[Val::Uuid(org), Val::Uuid(*x), Val::Int(next.depth), Val::Json(next.tools.clone()), Val::Json(next.folders.clone()), Val::text(next.visibility.clone()), Val::text(next.permission_mode.clone())],
            )
            .await?;
            clamped += 1;
        }
        new_rows.push((*x, next));
    }
    // 8: P1 over the re-anchored set (or, under Q-C7 (d)'s control, only
    // legacy's moved set)
    let grantees: Vec<Uuid> = if controls::fire(&tx.scope(), "Q-C7.sweep_moved_set_only") { moved_set.clone() } else { subtree_nodes.clone() };
    let mut swept = 0i64;
    for g in &grantees {
        island::lock_epoch(tx, "island.share_epoch", org, *g, Lock::Share).await?;
        // g's ancestors after the move: its path up to the moved node, then the new chain
        let mut after: Vec<Uuid> = Vec::new();
        let mut cur = *g;
        while !moved_set.contains(&cur) {
            match island::parent_of(tx, org, cur).await? {
                Some(p) => {
                    after.push(p);
                    cur = p;
                }
                None => break,
            }
        }
        after.extend(new_chain.iter().copied());
        let grants = tx.exec("island.grants", GRANTS_OF_SQL, &[Val::Uuid(org), Val::Uuid(*g)]).await?;
        let mut bumped = false;
        for r in &grants.0 {
            let (Some(kind), Some(target)) = (r.first().and_then(Val::as_text), r.get(1).and_then(Val::as_uuid)) else { continue };
            let Some(anchor) = r.get(2).and_then(Val::as_uuid) else { continue };
            if kind != "agent" || after.contains(&anchor) {
                continue;
            }
            tx.exec("island.sweep", SWEEP_SQL, &[Val::Uuid(org), Val::Uuid(*g), Val::text(kind), Val::Uuid(target)]).await?;
            swept += 1;
            if !bumped {
                island::bump_audience(tx, org, *g).await?;
                bumped = true;
            }
        }
    }
    // 9: P2 re-seat
    if seen.live() {
        if let Some((payer, tier, grant)) = obligation(tx, org, node).await? {
            if payer == old_parent {
                move_obligation(tx, org, old_parent, &tier, grant, -1).await?;
                move_obligation(tx, org, new_parent, &tier, grant, 1).await?;
                tx.exec("island.funding_edge", RESEAT_SQL, &[Val::Uuid(org), Val::Uuid(node), Val::opt_uuid(new_parent)]).await?;
            }
        }
    }
    // 10
    for x in &moved_set {
        tx.exec("island.reparent", REPARENT_SQL, &[Val::Uuid(org), Val::Uuid(*x), Val::opt_uuid(new_parent)]).await?;
    }
    // 11
    restrict::record(tx, org, "move").await?;
    Ok(MoveOut { moved: moved_set, swept, clamped, noop: false })
}
