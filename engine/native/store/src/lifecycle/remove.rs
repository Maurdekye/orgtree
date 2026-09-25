//! Retire, dissolve, rescind and delete: the island writers that take a node
//! (or a subtree) out of service (r7 §6.4 rows; S3 §3.2 P8 leg (b); errata
//! A1/A2). All SERIALIZABLE.
//!
//! **Retire / dissolve** (r7 C2a island side): `FOR NO KEY UPDATE` each
//! member's authority-epoch row BEFORE reading its open requests (P7), then
//! moot them; `FOR SHARE` each member's runtime row (P4: open background
//! work refuses); `FOR NO KEY UPDATE` the payer's capacity row and update it
//! (P2: archiving frees seat and grant). A restriction obligation is
//! recorded (C5: the retiree's in-flight protected reads). Audience grants
//! are KEPT (retire is paging; user ruling 2026-07-31).
//!
//! **Delete** (USER ONLY; the whole subtree and every lineage stack): each
//! member's epoch row `FOR NO KEY UPDATE`; a pending folder-move intent of
//! any stack refuses as [`PENDING_INTENT`] (errata A2: the caller re-runs it
//! with a fresh snapshot once the intent closes; errata A1: delete and every
//! intent writer are SERIALIZABLE, option (i), so serializable tracking
//! orders a delete whose snapshot predates R's commit); P4; P8 leg (b):
//! WS5's `close_mailbox` (head `FOR UPDATE`, erase, close); every audience
//! grant held by or naming a member deleted (the other grantees' epoch rows
//! bumped, P1); open requests mooted; the names freed; the epoch, edge,
//! scope and lineage rows removed. The `agents` row stays (immutable
//! principal; receipts and history reference it).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::island::{self, Caller, Lock};
use crate::lifecycle::{move_obligation, obligation, pending_intent, require_authority, share_runtime, ISLAND, MOOT_SQL, PENDING_INTENT};
use crate::mail::mailbox;
use crate::restrict;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const ARCHIVE_SQL: &str = "UPDATE authority_epoch SET lifecycle = 'archived', version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const GRANTS_HELD_SQL: &str = "DELETE FROM audience_grants WHERE org_id = $1 AND grantee_id = $2";
pub const GRANTS_TO_SQL: &str = "SELECT grantee_id FROM audience_grants WHERE org_id = $1 AND target_kind = 'agent' AND target_id = $2";
pub const SWEEP_TO_SQL: &str = "DELETE FROM audience_grants WHERE org_id = $1 AND target_kind = 'agent' AND target_id = $2";
pub const FREE_NAME_SQL: &str = "DELETE FROM agent_names WHERE org_id = $1 AND principal_id = $2";
pub const DROP_EPOCH_SQL: &str = "DELETE FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const DROP_EDGE_SQL: &str = "DELETE FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const DROP_SCOPE_SQL: &str = "DELETE FROM scope_rows WHERE org_id = $1 AND principal_id = $2";
pub const DROP_STACK_SQL: &str = "DELETE FROM lineage_bearers WHERE org_id = $1 AND (seat_id = $2 OR bearer_id = $2)";
pub const DROP_CONFIG_SQL: &str = "DELETE FROM seat_config WHERE org_id = $1 AND principal_id = $2";
pub const RESCINDED_SQL: &str = "UPDATE funding_edges SET grant_centi = 0, version = version + 1 WHERE org_id = $1 AND child_id = $2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveOut {
    /// Nodes archived (retire/dissolve/rescind) or removed (delete), top-down.
    pub nodes: Vec<Uuid>,
    /// Delete: mailbox rows erased (WS5 `close_mailbox`).
    pub erased: u64,
    /// Requests mooted (P7).
    pub mooted: u64,
    pub noop: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RemoveKind {
    Retire,
    Dissolve,
    Rescind,
    Delete,
}

#[derive(Clone, Debug)]
pub struct Remove {
    pub kind: RemoveKind,
    pub node: Uuid,
}

impl Command for Remove {
    type Output = RemoveOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        match self.kind {
            RemoveKind::Retire => "retire",
            RemoveKind::Dissolve => "dissolve",
            RemoveKind::Rescind => "rescind",
            RemoveKind::Delete => "delete",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let c = island::anchor_caller(tx, b).await?;
        if matches!(self.kind, RemoveKind::Delete | RemoveKind::Rescind) && !c.is_user_level() {
            return island::refuse(
                "forbidden",
                match self.kind {
                    RemoveKind::Delete => "only the user may delete agents — retire instead, and ask the user if permanent removal is truly warranted",
                    _ => "only the user may rescind — it permanently claws back the superior's grant",
                },
            );
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &RemoveOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RemoveOut>, CmdError> {
        let caller = island::caller_of(b);
        let r = match self.kind {
            RemoveKind::Delete => delete_in(tx, b.op.org, self.node).await,
            k => archive_in(tx, b.op.org, &caller, self.node, k).await,
        };
        match r {
            Ok(o) => Ok(Decided::Applied(o)),
            Err(CmdError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e),
        }
    }
}

/// Retire / dissolve / rescind (a retire of a node with live reports by a
/// superior becomes a dissolve, legacy's motto bridge).
pub async fn archive_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, kind: RemoveKind) -> Result<RemoveOut, CmdError> {
    let seen = island::lock_epoch(tx, "island.snapshot", org, node, Lock::Read).await?;
    tx.pause("after_snapshot").await?;
    if seen.is_none() {
        return island::refuse("unknown_node", "no such node");
    }
    let allow_self = kind == RemoveKind::Retire;
    let chain = require_authority(tx, org, caller, node, allow_self).await?;
    let ep = island::lock_epoch(tx, "island.lock_epoch", org, node, Lock::Update).await?.ok_or_else(|| island::defect("node vanished"))?;
    let mut warnings = Vec::new();
    if ep.archived() && kind != RemoveKind::Rescind {
        return Ok(RemoveOut { nodes: vec![], erased: 0, mooted: 0, noop: true, warnings: vec!["already archived — nothing to do".into()] });
    }
    // the members, top-down: the node alone, or (dissolve, or a superior's
    // retire of a node with live reports) the whole subtree
    let sub = island::subtree(tx, org, &[node]).await?;
    let mut members: Vec<Uuid> = vec![node];
    let live_kids = {
        let mut n = 0;
        for (x, d) in &sub {
            if *d == 1 {
                if let Some(e) = island::lock_epoch(tx, "island.lock_epoch", org, *x, Lock::Update).await? {
                    if e.live() {
                        n += 1;
                    }
                }
            }
        }
        n
    };
    let dissolve = kind == RemoveKind::Dissolve || (live_kids > 0 && kind != RemoveKind::Retire) || (live_kids > 0 && kind == RemoveKind::Retire && caller.agent() != Some(node));
    if kind == RemoveKind::Retire && live_kids > 0 && caller.agent() == Some(node) {
        return island::refuse("has_reports", "you have live reports; retire them first, or ask your superior to dissolve your subtree");
    }
    if kind == RemoveKind::Dissolve && caller.agent() == Some(node) {
        return island::refuse("forbidden", "an agent has no dissolve authority over itself");
    }
    if dissolve {
        if kind == RemoveKind::Retire {
            warnings.push("had live reports — retire became dissolve (the whole subtree is archived)".into());
        }
        members = sub.iter().map(|(x, _)| *x).collect();
    }
    let mut archived = Vec::new();
    let mut mooted = 0u64;
    for m in &members {
        // P7 / P5: the member's epoch row FOR NO KEY UPDATE before its requests
        let e = island::lock_epoch(tx, "island.lock_epoch", org, *m, Lock::Update).await?;
        let Some(e) = e else { continue };
        // P4: open background work refuses
        let (_, bg) = share_runtime(tx, org, *m).await?;
        if bg > 0 {
            return island::refuse("background_open", "still owns open background tasks — wait for their terminal notification before retiring it");
        }
        if !e.live() {
            continue;
        }
        mooted += tx.exec("island.moot", MOOT_SQL, &[Val::Uuid(org), Val::Uuid(*m)]).await?.len() as u64;
        if let Some((payer, tier, grant)) = crate::lifecycle::obligation(tx, org, *m).await? {
            // P2: archiving frees seat and grant from the payer, unless the
            // payer is archived in this same transaction
            if payer.map_or(true, |p| !members.contains(&p) || p == *m) {
                move_obligation(tx, org, payer, &tier, grant, -1).await?;
            }
        }
        tx.exec("island.archive", ARCHIVE_SQL, &[Val::Uuid(org), Val::Uuid(*m)]).await?;
        archived.push(*m);
    }
    if kind == RemoveKind::Rescind {
        // the claw-back: the node's stake is removed from its edge (legacy
        // reduces the parent's grant by the stake; natively the child's
        // funding edge carries it). Schedule-grade.
        if chain.len() > 1 {
            tx.exec("island.funding_edge", RESCINDED_SQL, &[Val::Uuid(org), Val::Uuid(node)]).await?;
        } else {
            warnings.push("was top-level — there is no superior grant to claw back; the rescind is the archive alone".into());
        }
    }
    if !archived.is_empty() {
        restrict::record(tx, org, "retire").await?;
    }
    Ok(RemoveOut { nodes: archived, erased: 0, mooted, noop: false, warnings })
}

/// Delete: the whole subtree and every lineage stack in it (legacy
/// `_taken_with`). USER ONLY (checked in `anchor`).
pub async fn delete_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid) -> Result<RemoveOut, CmdError> {
    let seen = island::lock_epoch(tx, "island.snapshot", org, node, Lock::Read).await?;
    // errata A1: "after delete's snapshot, before its first lock"
    tx.pause("after_snapshot").await?;
    if seen.is_none() {
        return island::refuse("unknown_node", "no such node");
    }
    let mut doomed: Vec<Uuid> = island::subtree(tx, org, &[node]).await?.into_iter().map(|x| x.0).collect();
    let seats = doomed.clone();
    for s in &seats {
        for bearer in island::stack(tx, org, *s).await? {
            if !doomed.contains(&bearer.id) {
                doomed.push(bearer.id);
            }
        }
    }
    // locks first, in the listed (top-down) order
    for x in &doomed {
        island::lock_epoch(tx, "island.lock_epoch", org, *x, Lock::Update).await?;
    }
    // errata A2: a pending folder move of any stack: end and re-run later
    for s in &seats {
        if pending_intent(tx, org, *s).await?.is_some() {
            return island::refuse(PENDING_INTENT, "a folder move of this agent is still pending — the delete runs once it completes");
        }
    }
    for x in &doomed {
        let (_, bg) = share_runtime(tx, org, *x).await?;
        if bg > 0 {
            return island::refuse("background_open", "cannot delete while background tasks are open");
        }
    }
    // P2: the root's payer (outside the doomed set) gets its obligation back
    if let Some((payer, tier, grant)) = obligation(tx, org, node).await? {
        if seen.as_ref().is_some_and(|e| e.live()) && payer.is_some_and(|p| !doomed.contains(&p)) {
            move_obligation(tx, org, payer, &tier, grant, -1).await?;
        }
    }
    let mut erased = 0u64;
    let mut mooted = 0u64;
    for x in &doomed {
        // P8 leg (b): WS5's helper takes the head FOR UPDATE, erases, closes
        erased += mailbox::close_mailbox(tx, org, *x).await?;
        // P1: grants naming the member as target; each other grantee bumped
        let to = tx.exec("island.grants_to", GRANTS_TO_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        let grantees: Vec<Uuid> = to.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).filter(|g| !doomed.contains(g)).collect();
        tx.exec("island.sweep_to", SWEEP_TO_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        for g in grantees {
            island::bump_audience(tx, org, g).await?;
        }
        tx.exec("island.sweep", GRANTS_HELD_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        mooted += tx.exec("island.moot", MOOT_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?.len() as u64;
        tx.exec("island.free_name", FREE_NAME_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
    }
    for x in doomed.iter().rev() {
        tx.exec("island.drop_stack", DROP_STACK_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        tx.exec("island.drop_config", DROP_CONFIG_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        tx.exec("island.drop_scope", DROP_SCOPE_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        tx.exec("island.drop_edge", DROP_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
        tx.exec("island.drop_epoch", DROP_EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
    }
    restrict::record(tx, org, "delete").await?;
    Ok(RemoveOut { nodes: doomed, erased, mooted, noop: false, warnings: vec![] })
}
