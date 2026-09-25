//! Lineage splits and the other writers of a seat's lineage (S3 §3.1, §3.2
//! P8 leg (c); r7 C2a island membership), all SERIALIZABLE island members:
//!
//! | writer | bearer minted | generation bump | moots asks | folds notices | config |
//! |---|---|---|---|---|---|
//! | `cheap_compact` | knowledge | yes | no (seat and batch survive) | yes | — |
//! | cross-provider `switch_model` | knowledge | yes | yes | yes | tier |
//! | `assign_account` split | knowledge | yes | yes | yes | account |
//! | the compaction split (`compact_split`) | knowledge | yes | no | **no** (`ledger.py:4446`) | — |
//! | `record_cli_compaction` | knowledge or lost | yes | no | no | — |
//! | `reseed` (of an unrecoverable node) | lost | yes | no | yes | — |
//!
//! Plus `mark_unrecoverable` (runtime-internal, no P01 contract; lead ruling
//! 2026-09-25), `recover_lost_generation` (`lifecycle.lineage-recover`) and
//! `drop_phantom_generation` (`lifecycle.lineage-drop-phantom`).
//!
//! One split attempt (S3 §3.1 "as an island member"):
//! 1. `island.snapshot`: the seat's epoch (plain read);
//! 2. `island.parent`: the seat's parent (plain read) — the read a
//!    concurrent move changes, which serializable tracking pairs with the
//!    move's read of the stack (Q-E2). Pause `island.split.after_parent_read`;
//! 3. `island.lock_epoch`: the seat's epoch row `FOR NO KEY UPDATE` (the
//!    generation bump; P7 mooting for switch and account splits);
//! 4. for a configuration change: the seat's configuration head
//!    `FOR NO KEY UPDATE`;
//! 5. the bearer inserted: a node under the seat's parent (agents, name
//!    `<seat>@<generation>`, epoch archived, edge, its own empty mailbox) and
//!    its `lineage_bearers` link;
//! 6. the generation bumped; asks mooted where the writer moots them; the
//!    configuration written;
//! 7. P8 leg (c): WS5's `fold_notices` (head `FOR UPDATE`, then the box).
//!
//! Q-E2's unsafe control is [`SplitRc`]: the same writer at READ COMMITTED
//! outside the island (`Q-E2.split_read_committed`).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::hooks::controls;
use crate::island::{self, Caller, Lock};
use crate::lifecycle::topo::decided;
use crate::lifecycle::{require_authority, ISLAND, MOOT_SQL, UNSAFE_RC};
use crate::mail::mailbox;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub const BEARER_AGENT_SQL: &str = "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) \
    SELECT org_id, $3, $4, gen_random_uuid(), tier, clock_timestamp() FROM agents WHERE org_id = $1 AND principal_id = $2";
pub const BEARER_NAME_SQL: &str = "INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ($1, $3, $2, 'active')";
pub const BEARER_EPOCH_SQL: &str = "INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ($1, $2, 'archived', $3)";
pub const BEARER_EDGE_SQL: &str = "INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ($1, $2, $3)";
pub const BEARER_LINK_SQL: &str = "INSERT INTO lineage_bearers (org_id, bearer_id, seat_id, generation, bearer_state, created_at) \
    VALUES ($1, $2, $3, $4, $5, clock_timestamp())";
pub const GENERATION_SQL: &str = "UPDATE authority_epoch SET generation = generation + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const CONFIG_LOCK_SQL: &str = "SELECT tier, account_id, version FROM seat_config WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
pub const CONFIG_TIER_SQL: &str = "UPDATE seat_config SET tier = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const CONFIG_ACCOUNT_SQL: &str = "UPDATE seat_config SET account_id = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const LIFECYCLE_SQL: &str = "UPDATE authority_epoch SET lifecycle = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
pub const BEARER_STATE_SQL: &str = "UPDATE lineage_bearers SET bearer_state = $3 WHERE org_id = $1 AND bearer_id = $2";
pub const DROP_LINK_SQL: &str = "DELETE FROM lineage_bearers WHERE org_id = $1 AND bearer_id = $2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SplitKind {
    CheapCompact,
    /// Cross-provider `switch_model`: the new tier.
    SwitchModel { tier: String },
    /// `assign_account` on a lane that needs a session boundary.
    AccountSplit { account: String },
    /// The runtime's §8 compaction split.
    CompactSplit,
    /// The CLI compacted the session by itself: the bearer is `knowledge`, or
    /// `lost` when the transcript is gone.
    CliCompaction { lost: bool },
}

impl SplitKind {
    fn verb(&self) -> &'static str {
        match self {
            SplitKind::CheapCompact => "cheap_compact",
            SplitKind::SwitchModel { .. } => "switch_model",
            SplitKind::AccountSplit { .. } => "account_split",
            SplitKind::CompactSplit => "compact_split",
            SplitKind::CliCompaction { .. } => "cli_compaction",
        }
    }
    fn folds(&self) -> bool {
        matches!(self, SplitKind::CheapCompact | SplitKind::SwitchModel { .. } | SplitKind::AccountSplit { .. })
    }
    fn moots(&self) -> bool {
        matches!(self, SplitKind::SwitchModel { .. } | SplitKind::AccountSplit { .. })
    }
    fn bearer_state(&self) -> &'static str {
        match self {
            SplitKind::CliCompaction { lost: true } => "lost",
            _ => "knowledge",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SplitOut {
    pub bearer: Uuid,
    pub generation: i64,
    /// Notices folded into the digest (P8 leg (c)); 0 when the writer does not fold.
    pub folded: i64,
    pub mooted: i64,
    /// Reseed only: messages driven.
    pub drive: Vec<Uuid>,
}

#[derive(Clone, Debug)]
pub struct Split {
    pub seat: Uuid,
    pub kind: SplitKind,
}

impl Command for Split {
    type Output = SplitOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        self.kind.verb()
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &SplitOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<SplitOut>, CmdError> {
        decided(split_in(tx, b.op.org, &island::caller_of(b), self.seat, &self.kind).await)
    }
}

/// S3 Q-E2's unsafe control: the split run READ COMMITTED outside the island.
/// Refuses to run unless `Q-E2.split_read_committed` is armed.
#[derive(Clone, Debug)]
pub struct SplitRc(pub Split);

impl Command for SplitRc {
    type Output = SplitOut;
    fn family(&self) -> &'static Family {
        &UNSAFE_RC
    }
    fn verb(&self) -> &'static str {
        self.0.kind.verb()
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &SplitOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<SplitOut>, CmdError> {
        if !controls::fire(&tx.scope(), "Q-E2.split_read_committed") {
            return Err(CmdError::Defect("SplitRc runs only under its armed unsafe control".into()));
        }
        decided(split_in(tx, b.op.org, &island::caller_of(b), self.0.seat, &self.0.kind).await)
    }
}

async fn authority_for_split<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, seat: Uuid) -> Result<(), CmdError> {
    // cheap_compact: the seat itself or a superior; the runtime (System)
    // for the compaction records; switch/account: a strict ancestor.
    require_authority(tx, org, caller, seat, true).await.map(|_| ())
}

/// Mint a bearer of `seat` at its current generation under `parent`.
async fn mint_bearer<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, seat: Uuid, parent: Option<Uuid>, generation: i64, state: &str) -> Result<Uuid, CmdError> {
    let bearer = Uuid::new_v4();
    let seat_name = island::name_of(tx, org, seat).await?.ok_or_else(|| island::defect("seat without an active name"))?;
    let name = format!("{seat_name}@{generation}");
    tx.exec("island.split_bearer", BEARER_AGENT_SQL, &[Val::Uuid(org), Val::Uuid(seat), Val::Uuid(bearer), Val::text(name.clone())]).await?;
    tx.exec("island.split_bearer_name", BEARER_NAME_SQL, &[Val::Uuid(org), Val::Uuid(bearer), Val::text(name)]).await?;
    tx.exec("island.split_bearer_epoch", BEARER_EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(bearer), Val::Int(generation)]).await?;
    tx.exec("island.split_bearer_edge", BEARER_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(bearer), Val::opt_uuid(parent)]).await?;
    mailbox::create_mailbox(tx, org, bearer).await?;
    tx.exec("island.split_link", BEARER_LINK_SQL, &[Val::Uuid(org), Val::Uuid(bearer), Val::Uuid(seat), Val::Int(generation), Val::text(state)]).await?;
    Ok(bearer)
}

/// One lineage split of a live seat.
pub async fn split_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, seat: Uuid, kind: &SplitKind) -> Result<SplitOut, CmdError> {
    let seen = island::lock_epoch(tx, "island.snapshot", org, seat, Lock::Read).await?;
    let Some(seen) = seen else { return island::refuse("unknown_node", "no such node") };
    if island::bearer_of(tx, org, seat).await?.is_some() {
        return island::refuse("lineage_bearer", "that is a lineage generation, not a seat");
    }
    let parent = island::parent_of(tx, org, seat).await?;
    tx.pause("after_parent_read").await?;
    authority_for_split(tx, org, caller, seat).await?;
    let ep = island::lock_epoch(tx, "island.lock_epoch", org, seat, Lock::Update).await?.ok_or_else(|| island::defect("seat vanished"))?;
    if !ep.live() || !seen.live() {
        return island::refuse("not_live", "the seat is not live");
    }
    if matches!(kind, SplitKind::SwitchModel { .. } | SplitKind::AccountSplit { .. }) {
        tx.exec("island.config_lock", CONFIG_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
    }
    let bearer = mint_bearer(tx, org, seat, parent, ep.generation, kind.bearer_state()).await?;
    tx.exec("island.split_generation", GENERATION_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
    let mut mooted = 0i64;
    if kind.moots() {
        mooted = tx.exec("island.moot", MOOT_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?.len() as i64;
    }
    match kind {
        SplitKind::SwitchModel { tier } => {
            tx.exec("island.config_update", CONFIG_TIER_SQL, &[Val::Uuid(org), Val::Uuid(seat), Val::text(tier.clone())]).await?;
        }
        SplitKind::AccountSplit { account } => {
            tx.exec("island.config_update", CONFIG_ACCOUNT_SQL, &[Val::Uuid(org), Val::Uuid(seat), Val::text(account.clone())]).await?;
        }
        _ => {}
    }
    let folded = if kind.folds() { mailbox::fold_notices(tx, org, seat).await?.folded as i64 } else { 0 };
    Ok(SplitOut { bearer, generation: ep.generation, folded, mooted, drive: vec![] })
}

// ---------------------------------------------------------------- reseed and friends

/// `reseed` (`operator.reseed`; also rehire of an unrecoverable node): the
/// dead session is archived as a LOST generation, the seat gets a fresh
/// session (generation + 1) and is live again, its notices are folded, and
/// its waiting mail is driven (P8 legs (c) and (a)).
#[derive(Clone, Debug)]
pub struct Reseed {
    pub seat: Uuid,
}

impl Command for Reseed {
    type Output = SplitOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        "reseed"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &SplitOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<SplitOut>, CmdError> {
        decided(reseed_in(tx, b.op.org, &island::caller_of(b), self.seat).await)
    }
}

pub async fn reseed_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, seat: Uuid) -> Result<SplitOut, CmdError> {
    let parent = island::parent_of(tx, org, seat).await?;
    tx.pause("after_parent_read").await?;
    require_authority(tx, org, caller, seat, false).await?;
    let ep = island::lock_epoch(tx, "island.lock_epoch", org, seat, Lock::Update).await?.ok_or_else(|| island::defect("seat vanished"))?;
    if ep.lifecycle != "unrecoverable" {
        return island::refuse("not_unrecoverable", "only an unrecoverable agent can be re-seeded");
    }
    let bearer = mint_bearer(tx, org, seat, parent, ep.generation, "lost").await?;
    tx.exec("island.split_generation", GENERATION_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
    tx.exec("island.revive", LIFECYCLE_SQL, &[Val::Uuid(org), Val::Uuid(seat), Val::text("live")]).await?;
    let folded = mailbox::fold_notices(tx, org, seat).await?.folded as i64;
    let drive = mailbox::drive_pending(tx, org, seat).await?;
    Ok(SplitOut { bearer, generation: ep.generation, folded, mooted: 0, drive })
}

/// `mark_unrecoverable` (runtime-internal: no P01 contract; lead ruling
/// 2026-09-25): the seat's lifecycle becomes `unrecoverable`.
/// `recover_lost_generation` (`lifecycle.lineage-recover`): a `lost` bearer
/// becomes `knowledge`. `drop_phantom_generation`
/// (`lifecycle.lineage-drop-phantom`): a `lost` bearer's link and node are
/// removed (the evidence check on disk is the runtime's, outside).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lineage {
    MarkUnrecoverable { seat: Uuid },
    RecoverLost { bearer: Uuid },
    DropPhantom { bearer: Uuid },
}

impl Command for Lineage {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        match self {
            Lineage::MarkUnrecoverable { .. } => "mark_unrecoverable",
            Lineage::RecoverLost { .. } => "recover_lost_generation",
            Lineage::DropPhantom { .. } => "drop_phantom_generation",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        let c = island::anchor_caller(tx, b).await?;
        if !c.is_user_level() {
            return island::refuse("forbidden", "only the runtime or the operator repairs a lineage");
        }
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        decided(async {
            match self {
                Lineage::MarkUnrecoverable { seat } => {
                    let ep = island::lock_epoch(tx, "island.lock_epoch", org, *seat, Lock::Update).await?;
                    if !ep.is_some_and(|e| e.live()) {
                        return island::refuse("not_live", "only a live agent can be marked unrecoverable");
                    }
                    tx.exec("island.archive", LIFECYCLE_SQL, &[Val::Uuid(org), Val::Uuid(*seat), Val::text("unrecoverable")]).await?;
                    Ok(1)
                }
                Lineage::RecoverLost { bearer } | Lineage::DropPhantom { bearer } => {
                    let Some((seat, _, state)) = island::bearer_of(tx, org, *bearer).await? else {
                        return island::refuse("not_a_generation", "not a lineage generation");
                    };
                    // the stack's seat anchors the stack (a move re-parents it)
                    island::lock_epoch(tx, "island.lock_epoch", org, seat, Lock::Update).await?;
                    island::lock_epoch(tx, "island.lock_epoch", org, *bearer, Lock::Update).await?;
                    if state != "lost" {
                        return island::refuse("not_lost", "not a lost generation");
                    }
                    if matches!(self, Lineage::RecoverLost { .. }) {
                        tx.exec("island.split_link", BEARER_STATE_SQL, &[Val::Uuid(org), Val::Uuid(*bearer), Val::text("knowledge")]).await?;
                    } else {
                        tx.exec("island.split_link", DROP_LINK_SQL, &[Val::Uuid(org), Val::Uuid(*bearer)]).await?;
                        tx.exec("island.sweep", crate::lifecycle::remove::GRANTS_HELD_SQL, &[Val::Uuid(org), Val::Uuid(*bearer)]).await?;
                        tx.exec("island.free_name", crate::lifecycle::remove::FREE_NAME_SQL, &[Val::Uuid(org), Val::Uuid(*bearer)]).await?;
                        tx.exec("island.drop_edge", crate::lifecycle::remove::DROP_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(*bearer)]).await?;
                        tx.exec("island.drop_epoch", crate::lifecycle::remove::DROP_EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(*bearer)]).await?;
                    }
                    Ok(1)
                }
            }
        }
        .await)
    }
}
