//! SCHEDULE-GRADE STAND-INS for WS3's island writers, used only to race WS5's
//! mail against (decision 1 Q4: real SQL and the real lock set, driven from
//! the harness, not a real door). WS3 builds the real ones; every result that
//! depends on these says so. Each is SERIALIZABLE (r7 C2a island) and takes
//! exactly the P1/P8 locks the design gives it:
//!
//! * `Rehire` (P8 leg a): a plain read (its snapshot), the seat's epoch row
//!   `FOR NO KEY UPDATE` → live + generation, then WS5's `drive_pending`
//!   (head `FOR SHARE`, then the pending set).
//! * `Delete` (P8 leg b): epoch `FOR NO KEY UPDATE`, WS5's `close_mailbox`
//!   (head `FOR UPDATE`), the name freed, the epoch row removed.
//! * `Move` (P1): the re-anchored set's epoch rows `FOR SHARE` before reading
//!   their grants, the grants whose anchor stops being an ancestor swept (with
//!   the grantee's epoch bump), the moved node's edge row updated.
//! * `NamesakeHire`: a new principal under a freed name, with its mailbox.

use orgtree_store::mail::mailbox;
use orgtree_store::{Binding, CmdError, Command, Decided, Family, Isolation, Session, Tx, Uuid, Val};

static ISLAND: Family = Family { name: "island", isolation: Isolation::Serializable, retry_unique: &[] };

const READ_NODE: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
const LOCK_EPOCH: &str = "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR NO KEY UPDATE";
const SHARE_EPOCH: &str = "SELECT 1 FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
const REVIVE: &str = "UPDATE authority_epoch SET lifecycle = 'live', generation = generation + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
const FREE_NAME: &str = "DELETE FROM agent_names WHERE org_id = $1 AND principal_id = $2";
const DROP_EPOCH: &str = "DELETE FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
const CHILDREN: &str = "SELECT principal_id FROM topology_edges WHERE org_id = $1 AND parent_id = $2";
const PARENT: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
const GRANTS_OF: &str = "SELECT target_id, anchor_id FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = 'agent'";
const SWEEP: &str = "DELETE FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = 'agent' AND target_id = $3";
const BUMP: &str = "UPDATE authority_epoch SET audience_version = audience_version + 1, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
const REPARENT: &str = "UPDATE topology_edges SET parent_id = $3, version = version + 1 WHERE org_id = $1 AND principal_id = $2";
const HIRE_AGENT: &str = "INSERT INTO agents (org_id, principal_id, name, seat_id, tier, created_at) VALUES ($1, $2, $3, gen_random_uuid(), 'opus', now())";
const HIRE_NAME: &str = "INSERT INTO agent_names (org_id, name, principal_id, kind) VALUES ($1, $3, $2, 'active')";
const HIRE_EPOCH: &str = "INSERT INTO authority_epoch (org_id, principal_id, lifecycle, generation) VALUES ($1, $2, 'live', 1)";
const HIRE_EDGE: &str = "INSERT INTO topology_edges (org_id, principal_id, parent_id) VALUES ($1, $2, $3)";
const HIRE_RUNTIME: &str = "INSERT INTO runtime_state (org_id, principal_id, updated_at) VALUES ($1, $2, now())";

pub enum Island {
    Rehire(Uuid),
    Delete(Uuid),
    Move { node: Uuid, new_parent: Option<Uuid> },
    NamesakeHire { principal: Uuid, name: &'static str, parent: Option<Uuid> },
    /// The notice fold leg of a session-replacing writer (cheap_compact,
    /// reseed, a cross-provider switch or account split): WS5's helper.
    Fold(Uuid),
    /// A narrowing retool of a node: its scope row updated (version bump),
    /// schedule-grade (Q-CR2 writer (ii)).
    Narrow(Uuid),
}

async fn ancestors<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, mut n: Option<Uuid>) -> Result<Vec<Uuid>, CmdError> {
    let mut out = Vec::new();
    while let Some(x) = n {
        out.push(x);
        let r = tx.exec("island.parent", PARENT, &[Val::Uuid(org), Val::Uuid(x)]).await?;
        n = r.first().and_then(|r| r.first()).and_then(Val::as_uuid);
        if out.len() > 64 {
            break;
        }
    }
    Ok(out)
}

impl Command for Island {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        match self {
            Island::Rehire(_) => "rehire",
            Island::Delete(_) => "delete",
            Island::Move { .. } => "move",
            Island::NamesakeHire { .. } => "hire",
            Island::Fold(_) => "fold",
            Island::Narrow(_) => "narrow",
        }
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        let org = b.op.org;
        match self {
            Island::Rehire(x) => {
                tx.exec("island.snapshot", READ_NODE, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                tx.exec("island.lock_epoch", LOCK_EPOCH, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                tx.exec("island.revive", REVIVE, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                Ok(Decided::Applied(mailbox::drive_pending(tx, org, *x).await?.len() as i64))
            }
            Island::Delete(x) => {
                tx.exec("island.snapshot", READ_NODE, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                tx.exec("island.lock_epoch", LOCK_EPOCH, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                let erased = mailbox::close_mailbox(tx, org, *x).await? as i64;
                tx.exec("island.free_name", FREE_NAME, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                tx.exec("island.drop_epoch", DROP_EPOCH, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                Ok(Decided::Applied(erased))
            }
            Island::Move { node, new_parent } => {
                // re-anchored set: the node and all its descendants
                let mut set = vec![*node];
                let mut i = 0;
                while i < set.len() {
                    let kids = tx.exec("island.children", CHILDREN, &[Val::Uuid(org), Val::Uuid(set[i])]).await?;
                    set.extend(kids.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)));
                    i += 1;
                }
                let above = ancestors(tx, org, *new_parent).await?;
                let mut swept = 0;
                for g in &set {
                    // P1: the grantee's epoch row FOR SHARE before its grants
                    tx.exec("island.share_epoch", SHARE_EPOCH, &[Val::Uuid(org), Val::Uuid(*g)]).await?;
                    // g's ancestors after the move: the path g..node, then above
                    let mut path = Vec::new();
                    let mut cur = Some(*g);
                    while let Some(x) = cur {
                        if x == *node {
                            break;
                        }
                        let r = tx.exec("island.parent", PARENT, &[Val::Uuid(org), Val::Uuid(x)]).await?;
                        cur = r.first().and_then(|r| r.first()).and_then(Val::as_uuid);
                        if let Some(p) = cur {
                            path.push(p);
                        }
                    }
                    let grants = tx.exec("island.grants", GRANTS_OF, &[Val::Uuid(org), Val::Uuid(*g)]).await?;
                    for row in &grants.0 {
                        let (Some(target), anchor) = (row.first().and_then(Val::as_uuid), row.get(1).and_then(Val::as_uuid)) else { continue };
                        let Some(anchor) = anchor else { continue };
                        let still = path.contains(&anchor) || above.contains(&anchor);
                        if !still {
                            tx.exec("island.sweep", SWEEP, &[Val::Uuid(org), Val::Uuid(*g), Val::Uuid(target)]).await?;
                            tx.exec("island.bump", BUMP, &[Val::Uuid(org), Val::Uuid(*g)]).await?;
                            swept += 1;
                        }
                    }
                }
                tx.exec("island.reparent", REPARENT, &[Val::Uuid(org), Val::Uuid(*node), Val::opt_uuid(*new_parent)]).await?;
                Ok(Decided::Applied(swept))
            }
            Island::Narrow(x) => {
                tx.exec("island.narrow", "UPDATE scope_rows SET version = version + 1 WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                Ok(Decided::Applied(1))
            }
            Island::Fold(x) => {
                tx.exec("island.snapshot", READ_NODE, &[Val::Uuid(org), Val::Uuid(*x)]).await?;
                Ok(Decided::Applied(mailbox::fold_notices(tx, org, *x).await?.folded as i64))
            }
            Island::NamesakeHire { principal, name, parent } => {
                let p = [Val::Uuid(org), Val::Uuid(*principal), Val::text(*name), Val::opt_uuid(*parent)];
                tx.exec("island.hire_agent", HIRE_AGENT, &p[..3]).await?;
                tx.exec("island.hire_name", HIRE_NAME, &p[..3]).await?;
                tx.exec("island.hire_epoch", HIRE_EPOCH, &p[..2]).await?;
                tx.exec("island.hire_edge", HIRE_EDGE, &[Val::Uuid(org), Val::Uuid(*principal), Val::opt_uuid(*parent)]).await?;
                tx.exec("island.hire_runtime", HIRE_RUNTIME, &p[..2]).await?;
                mailbox::create_mailbox(tx, org, *principal).await?;
                Ok(Decided::Applied(1))
            }
        }
    }
}

static OUTSIDE: Family = Family { name: "outside", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Q-E1 (c)'s unsafe control shape: the fold run READ COMMITTED (outside the
/// island). Only ever run with `Q-E1.fold_whole_box_no_lock` armed.
pub struct FoldRc(pub Uuid);

impl Command for FoldRc {
    type Output = i64;
    fn family(&self) -> &'static Family {
        &OUTSIDE
    }
    fn verb(&self) -> &'static str {
        "fold"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &i64) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<i64>, CmdError> {
        Ok(Decided::Applied(mailbox::fold_notices(tx, b.op.org, self.0).await?.folded as i64))
    }
}
