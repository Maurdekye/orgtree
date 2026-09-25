//! WS3b: the island's topology and lifecycle writers (r7 C2a, §6.4; S3 §3.1,
//! §3.2, §4.8; errata A1/A2).
//!
//! **Schedule-grade** (plan decision 1, Q4): each writer here is the
//! conflict-relevant transaction of its legacy verb, built with real SQL and
//! the design's exact lock set, driven from the test harness. Only
//! `lifecycle.rehire` becomes a real door (stage 2). Every result that
//! depends on one of these writers says "schedule-grade writer".
//!
//! Families:
//! * [`ISLAND`] (SERIALIZABLE): rehire, retire, rescind, dissolve, delete,
//!   reseed, move/swap/subjugate/insert_parent, rename, the lineage splits,
//!   `mark_unrecoverable`, `recover_lost_generation`,
//!   `drop_phantom_generation`, the namesake hire (a minimal hire kept only
//!   for WS5's schedules; WS3a's staffing hire is the real one).
//! * [`OUTSIDE`] (READ COMMITTED): retool/set_scope narrowing and widening,
//!   the pure charter edit, halt/unhalt, the org settings folder downgrade,
//!   kiosk disable and token rotation (lead ruling 2026-09-25 14:21Z: r7 §6.4
//!   places them outside the island; only the account branch that splits
//!   the session is an island member, S3 §3.1).
//!
//! **Q-CR rule for WS3** (Q-CR-DEFINITIONS r2): no writer here reads
//! `runtime_claims`. Effects on admitted claims go only through restriction
//! obligations ([`crate::restrict::record`]).

use uuid::Uuid;

use crate::exec::{Family, Isolation};
use crate::island::{self, ISLAND_RETRY_UNIQUE};
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

pub mod declared;
pub mod harness;
pub mod outside;
pub mod rehire;
pub mod remove;
pub mod rename;
pub mod requests;
pub mod retool;
pub mod split;
pub mod topo;

/// The island's topology and lifecycle family (r7 C2a).
pub static ISLAND: Family = Family { name: "island", isolation: Isolation::Serializable, retry_unique: ISLAND_RETRY_UNIQUE };

/// The READ COMMITTED writers r7 §6.4 places outside the island.
pub static OUTSIDE: Family = Family { name: "lifecycle", isolation: Isolation::ReadCommitted, retry_unique: ISLAND_RETRY_UNIQUE };

/// Unsafe-control twins: the same writer run at READ COMMITTED, outside the
/// island, ONLY when its schedule's control is armed (Q-C2, Q-E2). Kept as
/// a separate family so no armed flag can change a real writer's isolation.
pub static UNSAFE_RC: Family = Family { name: "island.unsafe_rc", isolation: Isolation::ReadCommitted, retry_unique: ISLAND_RETRY_UNIQUE };

/// Every unsafe control this module can fire (`<schedule>.<variant>`),
/// reported by the harness handshake. Each is written exactly as its
/// schedule's "unsafe control" column words it.
pub const CONTROLS: &[&str] = &[
    // r7 Q-C2: one topology writer run at READ COMMITTED.
    "Q-C2.move_read_committed",
    // r7 Q-C7 (d): sweep and P1 locks limited to legacy's moved set.
    "Q-C7.sweep_moved_set_only",
    // r7 Q-C11 (a)/(b): the mover locks only its new parent's scope row.
    "Q-C11.mover_parent_scope_only",
    // r7 Q-C11 (c): no anchor on the granter's scope row.
    "Q-C11.widen_no_granter_anchor",
    // r7 Q-C11 (d): permission mode swept on every scope edit.
    "Q-C11.perm_mode_swept_every_edit",
    // r7 Q-C11 (e): the settings door lists nodes without first updating the
    // directory control row.
    "Q-C11.settings_no_control_update",
    // r7 Q-C11 (e), hire side: the hire skips its share lock on the
    // directory control row (fired in the namesake hire; WS3a's hire carries
    // the same id if it runs (e)).
    "Q-C11.hire_no_directories_share",
    // S3 Q-E2: the split runs READ COMMITTED outside the island.
    "Q-E2.split_read_committed",
    // r7 Q-C12: the filing skips its update of the asker's epoch row
    // (asks and scope requests here; the credit request is WS4's).
    "Q-C12.filing_skips_epoch_bump",
    // S3 Q-E1 (a)/(b): WS5's controls, fired inside WS5's helpers (listed
    // in mail::mailbox::CONTROLS; not repeated here).
];

/// Named pause points beyond the generic ones (`admitted`, `begin`,
/// `after_anchor`, `after_claim`, `before_commit`, `after_commit`,
/// `before_effects`, `stmt.<label>.before/after`).
pub const POINTS: &[&str] = &[
    // errata A1: "after delete's snapshot, before its first lock"
    "island.delete.after_snapshot",
    "island.rehire.after_snapshot",
    "island.move.after_snapshot",
    "island.move.after_stack_read",
    "island.split.after_snapshot",
];

/// Statement labels every island writer may emit (the stand-in's labels are
/// kept for the same statements so WS5's reruns hold at the same points).
pub const LABELS: &[&str] = &[
    "island.snapshot",
    "island.lock_epoch",
    "island.share_epoch",
    "island.revive",
    "island.archive",
    "island.chain_edge",
    "island.parent",
    "island.children",
    "island.live_children",
    "island.stack",
    "island.bearer_of",
    "island.grants",
    "island.grants_to",
    "island.sweep",
    "island.sweep_to",
    "island.bump",
    "island.reparent",
    "island.control_share",
    "island.scope_chain",
    "island.scope_subtree",
    "island.scope_clamp",
    "island.runtime_share",
    "island.intent_check",
    "island.free_name",
    "island.drop_epoch",
    "island.drop_edge",
    "island.drop_scope",
    "island.capacity_lock",
    "island.capacity_update",
    "island.funding_edge",
    "island.hire_agent",
    "island.hire_name",
    "island.hire_epoch",
    "island.hire_edge",
    "island.hire_runtime",
    "island.hire_scope",
    "island.moot",
    "island.split_bearer",
    "island.split_bearer_name",
    "island.split_bearer_epoch",
    "island.split_bearer_edge",
    "island.split_link",
    "island.split_generation",
    "island.config_lock",
    "island.config_update",
    "island.narrow",
];

// ---------------------------------------------------------------- shared SQL

/// C2a P4: the seat's runtime row `FOR SHARE` (busy / open background work).
pub const RUNTIME_SHARE_SQL: &str = "SELECT busy, bg_open FROM runtime_state WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
/// Errata A1/A2: a pending folder-move intent of this stack.
pub const PENDING_INTENT_SQL: &str = "SELECT intent_id FROM folder_move_intents WHERE org_id = $1 AND stack_root_id = $2 AND state = 'pending'";
/// A node's funding edge: its payer and its grant (plain read; the payer's
/// capacity row is what is locked, P2).
pub const FUNDING_EDGE_SQL: &str = "SELECT issuer_id, tier, grant_centi FROM funding_edges WHERE org_id = $1 AND child_id = $2";
/// C2a P2: the payer's capacity row, `FOR NO KEY UPDATE` (WS4's statement).
pub use crate::funding::LOCK_CAPACITY_SQL;
/// C2a P2 rule 1: every obligation writer UPDATES the payer's capacity row:
/// the child-grant sum and the per-tier child-seat count (unpriced, RN4).
pub const CAPACITY_OBLIGATION_SQL: &str = "UPDATE issuer_capacity SET child_grants_centi = child_grants_centi + $3, \
    child_seats = jsonb_set(child_seats, ARRAY[$4::text], to_jsonb(coalesce((child_seats->>$4::text)::bigint, 0) + $5)), \
    version = version + 1 WHERE org_id = $1 AND principal_id = $2";
/// C2a P7: the node's open asks, credit requests and scope requests mooted
/// (`_moot_asks`), read after its epoch row is `FOR NO KEY UPDATE`.
pub const MOOT_SQL: &str = "UPDATE request_batches SET state = 'moot', rev = rev + 1, decided_at = clock_timestamp() \
    WHERE org_id = $1 AND asker_id = $2 AND state = 'pending' RETURNING batch_id";

/// Does this stack have a pending folder-move intent? (errata A2: a writer
/// that finds one must END its transaction and be re-run with a fresh
/// snapshot once it closes; see [`PENDING_INTENT`].)
pub async fn pending_intent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, stack_root: Uuid) -> Result<Option<Uuid>, DbError> {
    let rows = tx.exec("island.intent_check", PENDING_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(stack_root)]).await?;
    Ok(rows.first().and_then(|r| r.first()).and_then(Val::as_uuid))
}

/// The refusal code for "a folder move of this stack is pending": the
/// command wrote nothing (E-D5), and the caller re-runs it with a fresh
/// snapshot after the intent closes (errata A2). Retryable.
pub const PENDING_INTENT: &str = "rename_in_progress";

/// P4: read the seat's runtime row `FOR SHARE`; `(busy, bg_open)`.
pub async fn share_runtime<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, p: Uuid) -> Result<(bool, i64), DbError> {
    let rows = tx.exec("island.runtime_share", RUNTIME_SHARE_SQL, &[Val::Uuid(org), Val::Uuid(p)]).await?;
    let r = rows.first();
    Ok((r.and_then(|r| r.first()) == Some(&Val::Bool(true)), r.and_then(|r| r.get(1)).and_then(Val::as_int).unwrap_or(0)))
}

/// A node's obligation on its payer (P2): `(payer, tier, grant_centi)`.
pub async fn obligation<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid) -> Result<Option<(Option<Uuid>, String, i64)>, DbError> {
    let rows = tx.exec("island.funding_edge", FUNDING_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(node)]).await?;
    Ok(rows.first().and_then(|r| Some((r.first()?.as_uuid(), r.get(1)?.as_text()?.to_string(), r.get(2)?.as_int()?))))
}

/// C2a P2, island side: take the payer's capacity row `FOR NO KEY UPDATE`
/// and UPDATE its aggregate by `sign` × (one `tier` seat + `grant`). A payer
/// with no capacity row (the user root, or a fixture without funding) has
/// nothing to lock. Returns whether a row was changed.
///
/// Schedule-grade: the free-credit CHECK (`_chain_acquire`'s shortfall
/// bubbling, funding-core) is WS4's decision and is not repeated here; this
/// is the lock and the update C2a P2 requires of every obligation writer.
pub async fn move_obligation<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, payer: Option<Uuid>, tier: &str, grant: i64, sign: i64) -> Result<bool, DbError> {
    let Some(payer) = payer else { return Ok(false) };
    let rows = tx.exec("island.capacity_lock", LOCK_CAPACITY_SQL, &[Val::Uuid(org), Val::Uuid(payer)]).await?;
    if rows.is_empty() {
        return Ok(false);
    }
    tx.exec(
        "island.capacity_update",
        CAPACITY_OBLIGATION_SQL,
        &[Val::Uuid(org), Val::Uuid(payer), Val::Int(sign * grant), Val::text(tier), Val::Int(sign)],
    )
    .await?;
    Ok(true)
}

/// C3 authority: `actor` may act on `node` when it is the user level, or a
/// strict ancestor (or the node itself with `allow_self`). The chain is
/// walked with each edge row `FOR SHARE`.
pub async fn require_authority<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &island::Caller, node: Uuid, allow_self: bool) -> Result<Vec<Uuid>, crate::exec::CmdError> {
    let chain = island::chain_up(tx, org, node, true).await?;
    match caller.agent() {
        None => Ok(chain),
        Some(a) if a == node && allow_self => Ok(chain),
        Some(a) if chain.iter().skip(1).any(|x| *x == a) => Ok(chain),
        Some(_) => island::refuse("forbidden", "you have no authority over that node (it is not in your subtree)"),
    }
}
