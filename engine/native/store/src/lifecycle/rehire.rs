//! Rehire (`lifecycle.rehire`; the staff rehire mode calls [`rehire_in`]).
//!
//! S3 §4.8 "rehire in staff mode" row and r7 C2a: an island writer
//! (SERIALIZABLE). This file is the rehire transaction **without a name**,
//! which is path A's T when the target is archived and path L's T (step 4)
//! afterwards. The rename legs (path A's rename-together, path L's R,
//! completion and undo) are `rename.rs` (stage 1b).
//!
//! Lock order (C4), one attempt:
//! 1. caller anchor (`anchor`, C3);
//! 2. `island.snapshot`: a plain read of the target's epoch row (the first
//!    statement of the transaction's own work; its snapshot was fixed at
//!    `exec.timeouts`, lead ruling 5). Pause `island.rehire.after_snapshot`;
//! 3. authority: the target's chain, each edge row `FOR SHARE` (C3), unless
//!    the caller is the seat whose knowledge bearer this is;
//! 4. `island.lock_epoch`: the target's epoch row `FOR NO KEY UPDATE`, then
//!    every archived ancestor's, top-most first (the archived chain is
//!    rehired first: "a live agent under an archived one is an invalid tree
//!    state");
//! 5. P6: the org control rows it reads `FOR SHARE` (caps, defaults,
//!    directories, kiosk);
//! 6. P3: the scope rows of the parent's whole ancestor chain `FOR SHARE`,
//!    top-down (hire's rule applied to a rehire, S3 §4.8);
//! 7. the children cap (live children of the parent) and, per revived node,
//!    P2: its payer's capacity row `FOR NO KEY UPDATE`, updated;
//! 8. `island.revive` per node (lifecycle live, generation + 1, version + 1);
//! 9. P8: each restored seat's mailbox head `FOR SHARE`, then its pending
//!    waking mail driven once (WS5 `drive_pending`).
//!
//! Audience grants survive retire and come back live with the node (user
//! ruling 2026-07-31): nothing to restore.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::island::{self, Caller, Lock};
use crate::lifecycle::{move_obligation, obligation, require_authority, ISLAND};
use crate::mail::mailbox;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const REVIVE_SQL: &str = "UPDATE authority_epoch SET lifecycle = 'live', generation = generation + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const REPARENT_SQL: &str = "UPDATE topology_edges SET parent_id = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RehireOut {
    /// Nodes made live, top-most first (the archived chain, then the target).
    pub rehired: Vec<Uuid>,
    /// Messages driven (one wake intent each), across every restored seat.
    pub drive: Vec<Uuid>,
    /// The live-target no-op (E-D10: "already live — nothing to do").
    pub noop: bool,
    pub warnings: Vec<String>,
}

/// `lifecycle.rehire` without a name (the T transaction).
#[derive(Clone, Debug)]
pub struct Rehire {
    pub node: Uuid,
    /// A tier override (legacy №16); schedule-grade: recorded on the seat's
    /// configuration head only when given.
    pub tier: Option<String>,
}

impl Command for Rehire {
    type Output = RehireOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        "rehire"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &RehireOut) -> Result<bool, CmdError> {
        // the replay goes to the same immutable principal (E7 namespace)
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RehireOut>, CmdError> {
        match rehire_in(tx, b.op.org, &island::caller_of(b), self.node, self.tier.as_deref()).await {
            Ok(o) => Ok(Decided::Applied(o)),
            Err(CmdError::Refused(r)) => Ok(Decided::Refused(r)),
            Err(e) => Err(e),
        }
    }
}

pub const TIER_SQL: &str = "UPDATE seat_config SET tier = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";

/// The rehire's body, for composition inside another island transaction
/// (WS3a's staff rehire mode; path L's T). A refusal is `CmdError::Refused`
/// and the caller rolls back (E-D5).
pub async fn rehire_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, tier: Option<&str>) -> Result<RehireOut, CmdError> {
    // 2. the transaction's first own read (stand-in label kept)
    let seen = island::lock_epoch(tx, "island.snapshot", org, node, Lock::Read).await?;
    tx.pause("after_snapshot").await?;
    if seen.is_none() {
        return island::refuse("unknown_node", "no such node");
    }
    // 3. authority, or the seat rehiring its own knowledge bearer (joins as
    //    the seat's own report)
    let bearer = island::bearer_of(tx, org, node).await?;
    let own_bearer = matches!((&bearer, caller.agent()), (Some((seat, _, _)), Some(a)) if *seat == a);
    let chain = if own_bearer { island::chain_up(tx, org, node, true).await? } else { require_authority(tx, org, caller, node, false).await? };
    if let Some((_, _, state)) = &bearer {
        if state == "lost" {
            return island::refuse(
                "lost_generation",
                "that is a LOST generation — its transcript is gone, so there is nothing to consult or resume; its successor carries the role forward",
            );
        }
    }
    // 4. the target's epoch row, then the archived chain above it
    let Some(ep) = island::lock_epoch(tx, "island.lock_epoch", org, node, Lock::Update).await? else {
        return island::refuse("unknown_node", "no such node");
    };
    if ep.live() {
        return Ok(RehireOut { rehired: vec![], drive: vec![], noop: true, warnings: vec!["already live — nothing to do".into()] });
    }
    if ep.lifecycle == "unrecoverable" {
        // legacy: rehire of an unrecoverable node becomes a re-seed
        let r = crate::lifecycle::split::reseed_in(tx, org, caller, node).await?;
        return Ok(RehireOut { rehired: vec![node], drive: r.drive, noop: false, warnings: vec!["re-seed keeps the node's own grant and tier".into()] });
    }
    let mut revive: Vec<Uuid> = Vec::new();
    for p in chain.iter().skip(1) {
        let e = island::lock_epoch(tx, "island.lock_epoch", org, *p, Lock::Update).await?.ok_or_else(|| island::defect("ancestor without an epoch row"))?;
        if e.live() {
            break;
        }
        if e.lifecycle == "unrecoverable" {
            return island::refuse(
                "unrecoverable_ancestor",
                "a superior above this node is UNRECOVERABLE — re-seed or retire it first, then rehire",
            );
        }
        revive.push(*p);
    }
    revive.reverse(); // top-most first
    let mut warnings: Vec<String> = revive.iter().map(|_| "an archived superior was rehired first, so the chain of command is whole".to_string()).collect();
    revive.push(node);
    // 5. P6
    let controls = island::share_controls(tx, org, &["caps", "defaults", "directories", "kiosk"]).await?;
    // 6. P3: the parent's whole chain, top-down
    let parent = if own_bearer { caller.agent() } else { chain.get(1).copied() };
    if let Some(p) = parent {
        let mut up = island::chain_up(tx, org, p, false).await?;
        up.reverse();
        island::lock_scope_rows(tx, "island.scope_chain", org, &up, Lock::Share).await?;
    }
    // 7. no children cap: legacy's rehire checks none (an archived child is
    //    already counted by `org_children`); the rehire only re-funds (P2)
    let _ = &controls;
    for k in &revive {
        if let Some((payer, t, grant)) = obligation(tx, org, *k).await? {
            move_obligation(tx, org, payer, &t, grant, 1).await?;
        }
        tx.exec("island.revive", REVIVE_SQL, &[Val::Uuid(org), Val::Uuid(*k)]).await?;
    }
    if own_bearer {
        if let (Some(me), Some(cur)) = (caller.agent(), chain.get(1).copied()) {
            if cur != me {
                tx.exec("island.reparent", REPARENT_SQL, &[Val::Uuid(org), Val::Uuid(node), Val::Uuid(me)]).await?;
                warnings.push("joins as YOUR subordinate (you woke your own predecessor) — you command it and pay its seat".into());
            }
        }
    }
    if let Some(t) = tier {
        tx.exec("island.config_update", TIER_SQL, &[Val::Uuid(org), Val::Uuid(node), Val::text(t)]).await?;
    }
    // 9. P8, per restored seat
    let mut drive = Vec::new();
    for k in &revive {
        drive.extend(mailbox::drive_pending(tx, org, *k).await?);
    }
    Ok(RehireOut { rehired: revive, drive, noop: false, warnings })
}
