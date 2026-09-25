//! The REAL island writers in the shape of WS5's schedule-grade stand-ins
//! (`tests/common_pg/stand_ins.rs::Island`), so WS4 and WS5 can rerun their
//! dependent schedules against them by changing one import (brief §4):
//! the same variants, the same `Output = i64`, and the same statement labels
//! for the same statements (`island.snapshot`, `island.lock_epoch`,
//! `island.children`, …).
//!
//! | variant | real writer | output |
//! |---|---|---|
//! | `Rehire(x)` | [`rehire::rehire_in`] | messages driven |
//! | `Delete(x)` | [`remove::delete_in`] (the whole subtree, as legacy) | mailbox rows erased |
//! | `Move { node, new_parent }` | [`topo::move_in`] | grants swept |
//! | `NamesakeHire { principal, name, parent }` | [`namesake_hire_in`] (minimal; WS3a's `staffing.hire` is the real hire) | 1 |
//! | `Fold(x)` | [`split::split_in`] `cheap_compact` (split + P8 fold) | notices folded |
//! | `Narrow(x)` | [`retool::set_in`] narrowing `x`'s visibility to `team` (READ COMMITTED, lead ruling) | rows clamped + 1 |
//!
//! Lock sets are supersets of the stand-ins' (each takes at least the
//! stand-in's P1/P8 locks). Differences the lead must see before the rerun
//! are listed in `LOCKSET-DIFF.md` in WS3b's scratch folder.

use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family};
use crate::island::{self, Caller, Lock};
use crate::lifecycle::retool::{self, ScopeChange};
use crate::lifecycle::split::{self, SplitKind};
use crate::lifecycle::topo::decided;
use crate::lifecycle::{rehire, remove, topo, ISLAND, OUTSIDE};
use crate::mail::mailbox;
use crate::session::Session;
use crate::value::Val;
use crate::Tx;

pub enum Island {
    Rehire(Uuid),
    Delete(Uuid),
    Move { node: Uuid, new_parent: Option<Uuid> },
    NamesakeHire { principal: Uuid, name: &'static str, parent: Option<Uuid> },
    /// The notice fold leg of a session-replacing writer: the real
    /// `cheap_compact` (lineage split, then WS5's fold).
    Fold(Uuid),
    /// A narrowing retool of a node (READ COMMITTED, outside the island).
    Narrow(Uuid),
}

impl Command for Island {
    type Output = i64;
    fn family(&self) -> &'static Family {
        match self {
            Island::Narrow(_) => &OUTSIDE,
            _ => &ISLAND,
        }
    }
    fn verb(&self) -> &'static str {
        match self {
            Island::Rehire(_) => "rehire",
            Island::Delete(_) => "delete",
            Island::Move { .. } => "move",
            Island::NamesakeHire { .. } => "hire",
            Island::Fold(_) => "cheap_compact",
            Island::Narrow(_) => "retool",
        }
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        let caller = island::caller_of(b);
        decided(match self {
            Island::Rehire(x) => rehire::rehire_in(tx, org, &caller, *x, None).await.map(|o| o.drive.len() as i64),
            Island::Delete(x) => remove::delete_in(tx, org, *x).await.map(|o| o.erased as i64),
            Island::Move { node, new_parent } => topo::move_in(tx, org, &caller, *node, *new_parent).await.map(|o| o.swept),
            Island::NamesakeHire { principal, name, parent } => namesake_hire_in(tx, org, &caller, *principal, name, *parent).await,
            Island::Fold(x) => split::split_in(tx, org, &caller, *x, &SplitKind::CheapCompact).await.map(|o| o.folded),
            Island::Narrow(x) => retool::set_in(tx, org, &caller, *x, &ScopeChange { visibility: Some("team".into()), ..Default::default() }).await.map(|o| o.clamped + 1),
        })
    }
}

pub const HIRE_AGENT_SQL: &str = "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ($1, $2, $3, gen_random_uuid(), 'opus', clock_timestamp())";
pub const HIRE_NAME_SQL: &str = "INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ($1, $3, $2, 'active')";
pub const HIRE_EPOCH_SQL: &str = "INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ($1, $2, 'live', 1)";
pub const HIRE_EDGE_SQL: &str = "INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ($1, $2, $3)";
pub const HIRE_RUNTIME_SQL: &str = "INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ($1, $2, clock_timestamp())";
pub const HIRE_SCOPE_SQL: &str = "INSERT INTO scope_rows (org_id, principal_id, depth, tools, folders, visibility, permission_mode) VALUES ($1, $2, $3, $4, $5, $6, $7)";

/// A minimal hire of a new principal under an exact (freed) name, with its
/// mailbox: the stand-in's `NamesakeHire`, kept for WS5's Q-AM schedules.
/// It takes hire's island side for the facts it reads (the parent's epoch
/// `FOR SHARE`, its scope chain `FOR SHARE` top-down, the caps control) and
/// uses the unique name namespace as the conflict detector. WS3a's
/// `staffing.hire` is the real hire (funding, suffix rule, item, kickoff).
pub async fn namesake_hire_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, principal: Uuid, name: &str, parent: Option<Uuid>) -> Result<i64, CmdError> {
    let mut chain = Vec::new();
    if let Some(p) = parent {
        chain = crate::lifecycle::require_authority(tx, org, caller, p, true).await?;
        let e = island::lock_epoch(tx, "island.share_epoch", org, p, Lock::Share).await?;
        if !e.is_some_and(|e| e.live()) {
            return island::refuse("parent_not_live", "the destination is not live");
        }
    } else if !caller.is_user_level() {
        return island::refuse("forbidden", "only the user hires at the top level");
    }
    let controls = island::share_controls(tx, org, &["caps", "defaults", "directories", "kiosk"]).await?;
    if let Some(max) = island::cap(&controls, "max_children") {
        if island::org_children(tx, org, parent).await? >= max {
            return island::refuse("children_cap", format!("the destination already has the maximum of {max} live reports"));
        }
    }
    let mut top_down = chain.clone();
    top_down.reverse();
    let rows = island::lock_scope_rows(tx, "island.scope_chain", org, &top_down, Lock::Share).await?;
    let inherited = parent.and_then(|p| rows.iter().find(|(x, _)| *x == p).and_then(|(_, s)| s.clone()));
    let p = [Val::Uuid(org), Val::Uuid(principal), Val::text(name)];
    tx.exec("island.hire_agent", HIRE_AGENT_SQL, &p).await?;
    tx.exec("island.hire_name", HIRE_NAME_SQL, &p).await?;
    tx.exec("island.hire_epoch", HIRE_EPOCH_SQL, &p[..2]).await?;
    tx.exec("island.hire_edge", HIRE_EDGE_SQL, &[Val::Uuid(org), Val::Uuid(principal), Val::opt_uuid(parent)]).await?;
    tx.exec("island.hire_runtime", HIRE_RUNTIME_SQL, &p[..2]).await?;
    let (tools, folders, vis, pm) = match &inherited {
        Some(s) => (s.tools.clone(), s.folders.clone(), s.visibility.clone(), s.permission_mode.clone()),
        None => (serde_json::json!({}), serde_json::json!([]), "full".to_string(), "default".to_string()),
    };
    tx.exec(
        "island.hire_scope",
        HIRE_SCOPE_SQL,
        &[Val::Uuid(org), Val::Uuid(principal), Val::Int(chain.len() as i64), Val::Json(tools), Val::Json(folders), Val::text(vis), Val::text(pm)],
    )
    .await?;
    mailbox::create_mailbox(tx, org, principal).await?;
    Ok(1)
}
