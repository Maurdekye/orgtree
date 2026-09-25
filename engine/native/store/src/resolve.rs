//! In-transaction name resolution (lead request 2026-09-25 11:49Z; S3 E1.1
//! step 3).
//!
//! Agent names, org slugs, work-item names and message addresses map to ids
//! HERE, and only here. Every function takes the command's own `&mut Tx`, so
//! a name is resolved inside the transaction that acts on it: in the snapshot
//! of a `REPEATABLE READ READ ONLY` read, or under the anchor of a READ
//! COMMITTED or SERIALIZABLE write. There is no store-service verb for it and
//! there must never be one: a name probed in its own transaction and used in
//! another is S3's Q-ST4 unsafe control (`S3:2214`, "the name probe run
//! outside the transaction"). `Tx` cannot be built outside this crate, so
//! the only way to reach these functions is from a command or a read the
//! executor is running.
//!
//! **Locking.** In a write, the name rows that bind a name to an id
//! (`agent_names`, `active_work_names`) are read `FOR KEY SHARE`: a rename or
//! delete of that binding (which deletes or re-keys the row) waits for this
//! transaction, so the id acted on still carries the name the caller used
//! when it commits. A read takes no lock (PostgreSQL refuses row locks in a
//! read-only transaction, and the snapshot is already stable). Rows that are
//! never re-keyed by live commands are read plainly in both: `organizations`
//! (a key-share lock there would put every command on the one org row, the
//! fan-in r3 F2 removed) and the fixed `legacy_work_names` corpus.
//!
//! **Not here.** Hub peers (`@net:`) have no table in the store yet: an
//! `@net:` address is returned as [`Resolved::External`] with its handle, and
//! a bare name that is neither an agent nor a local org is
//! [`Resolved::NotANode`], for the transport layer to match against hub
//! peers (legacy `api._external_candidates`). `@mcp:` is refused: legacy
//! retired that tier on 2026-09-25.

use uuid::Uuid;

use crate::exec::Isolation;
use crate::session::{DbError, Session};
use crate::value::Val;
use crate::Tx;

/// Legacy `ledger.USER`: the org root (the human operator).
pub const USER: &str = "@user";
/// Longest name the schema admits (`agents_name_len`, `organizations_slug_len`).
pub const MAX_NAME: usize = 200;

pub const AGENT_LABEL: &str = "resolve.agent";
pub const AGENT_LOCKED_LABEL: &str = "resolve.agent.key_share";
pub const AGENT_SQL: &str = "SELECT principal_id FROM agent_names \
    WHERE org_id = $1 AND name = $2 AND kind = 'active'";
pub const AGENT_LOCKED_SQL: &str = "SELECT principal_id FROM agent_names \
    WHERE org_id = $1 AND name = $2 AND kind = 'active' FOR KEY SHARE";

pub const ORG_LABEL: &str = "resolve.org";
/// Kiosk orgs answer like orgs that do not exist (legacy
/// `_external_candidates`, `interorg_send`).
pub const ORG_SQL: &str = "SELECT org_id FROM organizations WHERE slug = $1 AND NOT kiosk";

pub const WORK_LABEL: &str = "resolve.work";
pub const WORK_LOCKED_LABEL: &str = "resolve.work.key_share";
pub const WORK_SQL: &str = "SELECT item_id FROM active_work_names WHERE org_id = $1 AND name = $2";
pub const WORK_LOCKED_SQL: &str = "SELECT item_id FROM active_work_names WHERE org_id = $1 AND name = $2 FOR KEY SHARE";
pub const LEGACY_WORK_LABEL: &str = "resolve.work.legacy";
pub const LEGACY_WORK_SQL: &str = "SELECT item_id, live FROM legacy_work_names WHERE org_id = $1 AND name = $2";

/// What a message address names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// An in-org agent, by its immutable principal.
    Agent { principal: Uuid },
    /// The org's human operator (`@user`).
    User,
    /// A local organization (`@org:<slug>`, or a bare name that is one).
    LocalOrg { org: Uuid },
    /// An outside party the store has no directory for (`@net:<peer>`).
    External { handle: String },
    /// A bare name that is no agent here. `local_org` is the local org of
    /// that slug, if any; hub peers are the transport layer's to add.
    NotANode { local_org: Option<Uuid> },
    /// Refused before any lookup (`reason` is a stable code).
    Refused { reason: &'static str },
}

/// What a work-item name names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkTarget {
    Active { item: Uuid },
    /// The fixed legacy corpus: an imported name, possibly of no item.
    Legacy { item: Option<Uuid>, live: bool },
}

fn locking<S: Session>(tx: &Tx<'_, S>) -> Result<bool, DbError> {
    match tx.isolation() {
        Some(Isolation::RepeatableReadReadOnly) => Ok(false),
        Some(Isolation::ReadCommitted | Isolation::Serializable) => Ok(true),
        None => Err(DbError::Sql {
            code: "25P01".into(),
            constraint: None,
            message: "name resolution outside a transaction (it runs only inside the command's own)".into(),
        }),
    }
}

fn admissible(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME
}

fn first_uuid(rows: &crate::Rows) -> Option<Uuid> {
    rows.first().and_then(|r| r.first()).and_then(Val::as_uuid)
}

/// The active agent called `name` in `org`.
pub async fn agent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, name: &str) -> Result<Option<Uuid>, DbError> {
    let lock = locking(tx)?;
    if !admissible(name) {
        return Ok(None);
    }
    let (label, sql) = if lock { (AGENT_LOCKED_LABEL, AGENT_LOCKED_SQL) } else { (AGENT_LABEL, AGENT_SQL) };
    Ok(first_uuid(&tx.exec(label, sql, &[Val::Uuid(org), Val::text(name)]).await?))
}

/// The local, non-kiosk organization whose slug is `slug`.
pub async fn org_by_slug<S: Session>(tx: &mut Tx<'_, S>, slug: &str) -> Result<Option<Uuid>, DbError> {
    locking(tx)?;
    if !admissible(slug) {
        return Ok(None);
    }
    Ok(first_uuid(&tx.exec(ORG_LABEL, ORG_SQL, &[Val::text(slug)]).await?))
}

/// The work item called `name` in `org`: an active name first, then the
/// legacy corpus.
pub async fn work_item<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, name: &str) -> Result<Option<WorkTarget>, DbError> {
    let lock = locking(tx)?;
    if !admissible(name) {
        return Ok(None);
    }
    let params = [Val::Uuid(org), Val::text(name)];
    let (label, sql) = if lock { (WORK_LOCKED_LABEL, WORK_LOCKED_SQL) } else { (WORK_LABEL, WORK_SQL) };
    if let Some(item) = first_uuid(&tx.exec(label, sql, &params).await?) {
        return Ok(Some(WorkTarget::Active { item }));
    }
    let rows = tx.exec(LEGACY_WORK_LABEL, LEGACY_WORK_SQL, &params).await?;
    Ok(rows.first().map(|r| WorkTarget::Legacy {
        item: r.first().and_then(Val::as_uuid),
        live: matches!(r.get(1), Some(Val::Bool(true))),
    }))
}

/// A message destination as legacy spells it: `@user`, `@org:<slug>`,
/// `@net:<peer>`, or a bare agent name.
pub async fn address<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, to: &str) -> Result<Resolved, DbError> {
    locking(tx)?;
    if to == USER {
        return Ok(Resolved::User);
    }
    if let Some(slug) = to.strip_prefix("@org:") {
        if !admissible(slug) {
            return Ok(Resolved::Refused { reason: "malformed_address" });
        }
        return Ok(match org_by_slug(tx, slug).await? {
            Some(org) => Resolved::LocalOrg { org },
            None => Resolved::NotANode { local_org: None },
        });
    }
    if let Some(peer) = to.strip_prefix("@net:") {
        return Ok(if admissible(peer) { Resolved::External { handle: to.to_string() } } else { Resolved::Refused { reason: "malformed_address" } });
    }
    if to.starts_with("@mcp:") {
        return Ok(Resolved::Refused { reason: "retired_transport" });
    }
    if to.starts_with('@') || !admissible(to) {
        return Ok(Resolved::Refused { reason: "malformed_address" });
    }
    if let Some(principal) = agent(tx, org, to).await? {
        return Ok(Resolved::Agent { principal });
    }
    Ok(Resolved::NotANode { local_org: org_by_slug(tx, to).await? })
}
