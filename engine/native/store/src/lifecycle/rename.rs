//! Rename (S3 §4.8 "The rename in a rehire", E-D11, E-D19 (c); errata A1,
//! A2): path A (an archived target: the rename's database half commits in
//! the rehire's transaction), path L (a live target: R, the folder move,
//! completion or undo, then T), and the standalone rename
//! (`lifecycle.rename`, `operator.rename`).
//!
//! **Every writer of a folder-move intent runs SERIALIZABLE** (errata A1
//! option (i); SLICE-VERBS §E2): [`RehireNamed`] (T0 / path A) and
//! [`RenameR`] are island commands. The completion and the undo are short
//! READ COMMITTED compare-and-sets (S3 §4.8 step 3).
//!
//! **Where the path is chosen** (re-review r7 §5 item 4): never from an
//! unlocked read. [`RehireNamed`] runs under the CALL's key and takes the
//! node's epoch row `FOR SHARE` before anything else: archived → it is the
//! whole path-A transaction; live → it refuses with the internal code
//! [`PATH_L`] (rollback: nothing written, not even the claim, E-D5) and the
//! driver runs [`RenameR`] under a minted key, which re-reads the node's
//! state under its own lock (a node archived in between makes R refuse
//! [`STATE_CHANGED`] and the driver starts again from T0). T (the rehire
//! without a name) then claims the call's key (E7).
//!
//! **Waiting for a pending intent** (errata A2): a rename or delete that
//! finds a pending intent of the stack refuses [`PENDING_INTENT`], writing
//! nothing; its caller re-runs it with a fresh snapshot once the intent
//! closes ([`run_waiting`]). It never blocks inside the old snapshot.

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Executor, ExecError, Family, OpIdentity, Outcome, Refusal};
use crate::island::{self, Caller, Lock};
use crate::lifecycle::rehire::{rehire_in, RehireOut};
use crate::lifecycle::topo::decided;
use crate::lifecycle::{pending_intent, require_authority, share_runtime, ISLAND, OUTSIDE, PENDING_INTENT};
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::Tx;

/// T0 read the node live: path L. Internal; never shown to a caller.
pub const PATH_L: &str = "rehire_path_l";
/// R read the node archived after T0 read it live: start again from T0.
pub const STATE_CHANGED: &str = "rename_state_changed";

pub const RESERVE_SQL: &str = "INSERT INTO agent_names (org_id, name, principal_id, kind, intent_id) VALUES ($1, $2, $3, 'reserved', $4)";
pub const INTENT_SQL: &str = "INSERT INTO folder_move_intents (org_id, intent_id, stack_root_id, path_kind, old_name, new_name, state, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', clock_timestamp())";
/// Path A: the stack's names change in the rehire's own transaction.
pub const RENAME_NOW_SQL: &str = "UPDATE agent_names SET name = $3 WHERE org_id = $1 AND name = $2 AND principal_id = $4 AND kind = 'active'";
pub const AGENT_NAME_SQL: &str = "UPDATE agents SET name = $3 WHERE org_id = $1 AND principal_id = $2";
/// Completion (RC): the intent pending → completed, then each generation's
/// name CAS from the old key to the reserved new key.
pub const COMPLETE_INTENT_SQL: &str = "UPDATE folder_move_intents SET state = 'completed', settled_at = clock_timestamp() \
    WHERE org_id = $1 AND intent_id = $2 AND state = 'pending' RETURNING stack_root_id, old_name, new_name";
pub const DROP_OLD_NAME_SQL: &str = "DELETE FROM agent_names WHERE org_id = $1 AND name = $2 AND principal_id = $3 AND kind = 'active' RETURNING name";
pub const ACTIVATE_SQL: &str = "UPDATE agent_names SET kind = 'active', intent_id = NULL WHERE org_id = $1 AND intent_id = $2 AND kind = 'reserved' RETURNING name, principal_id";
/// Undo (RC): the intent pending → undone; delete exactly its reservation.
pub const UNDO_INTENT_SQL: &str = "UPDATE folder_move_intents SET state = 'undone', settled_at = clock_timestamp() \
    WHERE org_id = $1 AND intent_id = $2 AND state = 'pending' RETURNING intent_id";
pub const UNRESERVE_SQL: &str = "DELETE FROM agent_names WHERE org_id = $1 AND intent_id = $2 AND kind = 'reserved'";

/// One generation of a renamed stack: `(principal, old key, new key)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Renamed {
    pub principal: Uuid,
    pub old: String,
    pub new: String,
}

/// What R (or path A) decided.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenameOut {
    /// None: the slug equals the current name (legacy's no-op).
    pub intent: Option<Uuid>,
    pub stack: Vec<Renamed>,
    pub warnings: Vec<String>,
}

/// The rename predicates shared by path A and R (`Org.rename`,
/// `ledger.py:9060-9140`), inside the island transaction, AFTER the node's
/// epoch row was taken `FOR SHARE`: authority (never the node itself), not a
/// lineage generation, the stack's new keys free, no pending intent (A2),
/// and legacy's mid-turn refusal on the stack's runtime rows read
/// `FOR SHARE`. Returns the stack's renames, or `None` for the same-slug
/// no-op.
async fn predicates<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, new_name: &str) -> Result<Option<Vec<Renamed>>, CmdError> {
    if caller.agent() == Some(node) {
        return island::refuse("forbidden", "an agent cannot rename itself");
    }
    require_authority(tx, org, caller, node, false).await?;
    if island::bearer_of(tx, org, node).await?.is_some() {
        return island::refuse("lineage_generation", "that is a lineage generation — rename the base id and its generations follow");
    }
    let new = island::slugify(new_name).map_err(CmdError::Refused)?;
    let cur = island::name_of(tx, org, node).await?.ok_or_else(|| island::defect("node without an active name"))?;
    if new == cur {
        return Ok(None);
    }
    if pending_intent(tx, org, node).await?.is_some() {
        return island::refuse(PENDING_INTENT, "a folder move of this agent is still pending — the rename runs once it completes");
    }
    let mut stack = vec![Renamed { principal: node, old: cur.clone(), new: new.clone() }];
    for b in island::stack(tx, org, node).await? {
        let old = island::name_of(tx, org, b.id).await?.ok_or_else(|| island::defect("bearer without an active name"))?;
        let suffix = old.strip_prefix(&cur).unwrap_or("").to_string();
        stack.push(Renamed { principal: b.id, old, new: format!("{new}{suffix}") });
    }
    for r in &stack {
        if island::name_taken(tx, org, &r.new).await? {
            return island::refuse("name_taken", format!("the name {:?} is already taken", r.new));
        }
    }
    // legacy's mid-turn refusal, on LOCKED rows (S3 §4.8 item 2)
    for r in &stack {
        let (busy, _) = share_runtime(tx, org, r.principal).await?;
        if busy {
            return island::refuse("mid_turn", "rename refused, so nothing was rehired: the agent (or one of its generations) is mid-turn");
        }
    }
    Ok(Some(stack))
}

async fn write_intent<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid, path: &str, stack: &[Renamed]) -> Result<Uuid, CmdError> {
    let intent = Uuid::new_v4();
    tx.exec("rename.intent", INTENT_SQL, &[Val::Uuid(org), Val::Uuid(intent), Val::Uuid(node), Val::text(path), Val::text(stack[0].old.clone()), Val::text(stack[0].new.clone())]).await?;
    Ok(intent)
}

// ---------------------------------------------------------------- T0 / path A

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RehireNamedOut {
    pub rename: RenameOut,
    pub rehire: RehireOut,
}

/// `lifecycle.rehire` (and the staff rehire mode) WITH a `name`: T0. Runs
/// under the call's key. Archived → path A, whole. Live → refuses [`PATH_L`].
#[derive(Clone, Debug)]
pub struct RehireNamed {
    pub node: Uuid,
    pub name: String,
}

impl Command for RehireNamed {
    type Output = RehireNamedOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        "rehire"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &RehireNamedOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RehireNamedOut>, CmdError> {
        decided(path_a_in(tx, b.op.org, &island::caller_of(b), self.node, &self.name).await)
    }
}

/// T0's body: the node's epoch `FOR SHARE` FIRST (it carries the lifecycle
/// state), then path A when archived.
pub async fn path_a_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, name: &str) -> Result<RehireNamedOut, CmdError> {
    let Some(ep) = island::lock_epoch(tx, "rename.t0_epoch", org, node, Lock::Share).await? else {
        return island::refuse("unknown_node", "no such node");
    };
    if ep.live() {
        return island::refuse(PATH_L, "the node is live: path L");
    }
    let stack = predicates(tx, org, caller, node, name).await?;
    let mut rename = RenameOut { intent: None, stack: vec![], warnings: vec![] };
    if let Some(stack) = stack {
        // path A step 1: the rename's database half, in this transaction
        for r in &stack {
            tx.exec("rename.names", RENAME_NOW_SQL, &[Val::Uuid(org), Val::text(r.old.clone()), Val::text(r.new.clone()), Val::Uuid(r.principal)]).await?;
            tx.exec("rename.agent_name", AGENT_NAME_SQL, &[Val::Uuid(org), Val::Uuid(r.principal), Val::text(r.new.clone())]).await?;
        }
        // step 3: the folder-move intent; no turn of the stack is admitted
        // while it is pending (WS5's admission reads it after its own lock)
        rename.intent = Some(write_intent(tx, org, node, "A", &stack).await?);
        rename.stack = stack;
    } else {
        rename.warnings.push("that is already its name".into());
    }
    let rehire = rehire_in(tx, org, caller, node, None).await?;
    Ok(RehireNamedOut { rename, rehire })
}

// ---------------------------------------------------------------- R

/// R, the rename on its own (path L step 1; also the standalone rename's
/// first transaction). SERIALIZABLE. Writes ONLY the reservation of the
/// stack's new keys and the pending intent: no row of the node changes.
#[derive(Clone, Debug)]
pub struct RenameR {
    pub node: Uuid,
    pub name: String,
    /// Path L of a rehire: refuse [`STATE_CHANGED`] if the node is not live.
    pub require_live: bool,
}

impl Command for RenameR {
    type Output = RenameOut;
    fn family(&self) -> &'static Family {
        &ISLAND
    }
    fn verb(&self) -> &'static str {
        "rename"
    }
    async fn anchor<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<(), CmdError> {
        island::anchor_caller(tx, b).await.map(|_| ())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &RenameOut) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RenameOut>, CmdError> {
        decided(r_in(tx, b.op.org, &island::caller_of(b), self.node, &self.name, self.require_live).await)
    }
}

pub async fn r_in<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, caller: &Caller, node: Uuid, name: &str, require_live: bool) -> Result<RenameOut, CmdError> {
    let Some(ep) = island::lock_epoch(tx, "rename.r_epoch", org, node, Lock::Share).await? else {
        return island::refuse("unknown_node", "no such node");
    };
    if require_live && !ep.live() {
        return island::refuse(STATE_CHANGED, "the node's state changed since T0");
    }
    let Some(stack) = predicates(tx, org, caller, node, name).await? else {
        return Ok(RenameOut { intent: None, stack: vec![], warnings: vec!["that is already its name".into()] });
    };
    let intent = write_intent(tx, org, node, "L", &stack).await?;
    for r in &stack {
        tx.exec("rename.reserve", RESERVE_SQL, &[Val::Uuid(org), Val::text(r.new.clone()), Val::Uuid(r.principal), Val::Uuid(intent)]).await?;
    }
    Ok(RenameOut { intent: Some(intent), stack, warnings: vec![] })
}

// ---------------------------------------------------------------- completion / undo

/// Path L step 3, both branches (RC compare-and-sets). `complete`: the
/// intent pending → completed, and each generation's old active key
/// removed and its reservation activated (matches only while the stack
/// still holds the intent's old keys). `undo`: the intent pending → undone
/// and its own reservation deleted. Either finding nothing to change writes
/// nothing (`settled = false`), which recovery reports.
#[derive(Clone, Debug)]
pub struct Settle {
    pub intent: Uuid,
    pub complete: bool,
    /// The stack as R recorded it (its old keys, for the name CAS).
    pub stack: Vec<Renamed>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settled {
    pub settled: bool,
}

impl Command for Settle {
    type Output = Settled;
    fn family(&self) -> &'static Family {
        &OUTSIDE
    }
    fn verb(&self) -> &'static str {
        if self.complete {
            "rename_complete"
        } else {
            "rename_undo"
        }
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Settled) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Settled>, CmdError> {
        let org = b.op.org;
        if self.complete {
            let done = tx.exec("rename.complete", COMPLETE_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(self.intent)]).await?;
            if done.is_empty() {
                return Ok(Decided::Applied(Settled { settled: false }));
            }
            for r in &self.stack {
                tx.exec("rename.drop_old", DROP_OLD_NAME_SQL, &[Val::Uuid(org), Val::text(r.old.clone()), Val::Uuid(r.principal)]).await?;
            }
            let act = tx.exec("rename.activate", ACTIVATE_SQL, &[Val::Uuid(org), Val::Uuid(self.intent)]).await?;
            for row in &act.0 {
                if let (Some(n), Some(p)) = (row.first().and_then(Val::as_text), row.get(1).and_then(Val::as_uuid)) {
                    tx.exec("rename.agent_name", AGENT_NAME_SQL, &[Val::Uuid(org), Val::Uuid(p), Val::text(n)]).await?;
                }
            }
        } else {
            let done = tx.exec("rename.undo", UNDO_INTENT_SQL, &[Val::Uuid(org), Val::Uuid(self.intent)]).await?;
            if done.is_empty() {
                return Ok(Decided::Applied(Settled { settled: false }));
            }
            tx.exec("rename.unreserve", UNRESERVE_SQL, &[Val::Uuid(org), Val::Uuid(self.intent)]).await?;
        }
        Ok(Decided::Applied(Settled { settled: true }))
    }
}

/// T of path L: the rehire without a name, addressing the node by name,
/// resolved in the transaction (a second rename in the gap → unknown node,
/// as legacy's rehire refuses).
#[derive(Clone, Debug)]
pub struct RehireAt {
    pub name: String,
}

impl Command for RehireAt {
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
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<RehireOut>, CmdError> {
        let org = b.op.org;
        decided(async {
            let Some(node) = island::resolve_name(tx, org, &self.name).await? else {
                return island::refuse("unknown_node", format!("no such node: {:?}", self.name));
            };
            rehire_in(tx, org, &island::caller_of(b), node, None).await
        }
        .await)
    }
}

// ---------------------------------------------------------------- drivers

/// Errata A2: run `cmd`; while it refuses [`PENDING_INTENT`], END (the
/// refusal rolled back) and re-run it with a fresh snapshot, bounded by
/// `bound` (past it the refusal stands, retryable, C8).
pub async fn run_waiting<C: Connector, Cmd: Command>(ex: &Executor<C>, cmd: &Cmd, b: &Binding, bound: Duration) -> Result<Outcome<Cmd::Output>, ExecError> {
    let start = std::time::Instant::now();
    loop {
        let o = ex.run(cmd, b).await?;
        match &o {
            Outcome::Refused(r) if r.code == PENDING_INTENT && start.elapsed() < bound => tokio::time::sleep(Duration::from_millis(20)).await,
            _ => return Ok(o),
        }
    }
}

/// The folder move (path L step 2): moves the stack's folders; `Err` is a
/// failed move whose completed parts it has already reversed. Outside the
/// database; P03 drives a fake.
pub trait FolderMover {
    fn run(&mut self, stack: &[Renamed]) -> impl Future<Output = Result<(), String>> + Send;
}

#[derive(Clone, Debug, PartialEq)]
pub enum NamedRehire {
    /// Path A (archived target): one transaction.
    PathA(RehireNamedOut),
    /// Path L: R (with its intent), the move's outcome, then T.
    PathL { rename: RenameOut, moved: bool, rehire: Option<Outcome<RehireOut>> },
}

fn minted(b: &Binding, tag: &str) -> Binding {
    let mut m = b.clone();
    m.op = OpIdentity::minted(b.op.org, format!("{}:{tag}", b.op.fingerprint), b.op.fingerprint_codec);
    m
}

/// A rehire with a `name`, either door (S3 §4.8): T0 → path A, or
/// R → move → complete/undo → T (the call's key is claimed only in T0/T).
pub async fn rehire_named<C: Connector, M: FolderMover>(ex: &Executor<C>, b: &Binding, node: Uuid, name: &str, mover: &mut M, bound: Duration) -> Result<Result<NamedRehire, Refusal>, ExecError> {
    loop {
        match run_waiting(ex, &RehireNamed { node, name: name.to_string() }, b, bound).await? {
            Outcome::Applied(o) | Outcome::Replayed(o) => return Ok(Ok(NamedRehire::PathA(o))),
            Outcome::Refused(r) if r.code == PATH_L => {}
            Outcome::Refused(r) => return Ok(Err(r)),
            other => return Ok(Err(Refusal::new("outcome", other.name()))),
        }
        // path L: R under a minted key (it leaves no receipt of the call)
        let r = match run_waiting(ex, &RenameR { node, name: name.to_string(), require_live: true }, &minted(b, "R"), bound).await? {
            Outcome::Applied(o) => o,
            Outcome::Refused(r) if r.code == STATE_CHANGED => continue,
            Outcome::Refused(r) => return Ok(Err(r)),
            other => return Ok(Err(Refusal::new("outcome", other.name()))),
        };
        let mut moved = true;
        if let Some(intent) = r.intent {
            moved = mover.run(&r.stack).await.is_ok();
            let settle = Settle { intent, complete: moved, stack: r.stack.clone() };
            ex.run(&settle, &minted(b, if moved { "complete" } else { "undo" })).await?;
            if !moved {
                return Ok(Err(Refusal::new("rename_failed", "rename refused, so nothing was rehired: moving the agent's folders failed")));
            }
        }
        // T: the rehire without a name, addressing the node BY THE NAME R
        // GAVE IT, resolved inside T (decision 8); the call's key is claimed
        // here (E7). Renamed again since, T refuses an unknown node.
        let new_key = r.stack.first().map(|x| x.new.clone()).unwrap_or_else(|| name.to_string());
        let t = ex.run(&RehireAt { name: new_key }, b).await?;
        return Ok(Ok(NamedRehire::PathL { rename: r, moved, rehire: Some(t) }));
    }
}

/// The standalone rename (`lifecycle.rename`, `operator.rename`): R under
/// the call's key, the move, then completion or undo.
pub async fn rename<C: Connector, M: FolderMover>(ex: &Executor<C>, b: &Binding, node: Uuid, name: &str, mover: &mut M, bound: Duration) -> Result<Result<RenameOut, Refusal>, ExecError> {
    let r = match run_waiting(ex, &RenameR { node, name: name.to_string(), require_live: false }, b, bound).await? {
        Outcome::Applied(o) | Outcome::Replayed(o) => o,
        Outcome::Refused(r) => return Ok(Err(r)),
        other => return Ok(Err(Refusal::new("outcome", other.name()))),
    };
    if let Some(intent) = r.intent {
        let moved = mover.run(&r.stack).await.is_ok();
        ex.run(&Settle { intent, complete: moved, stack: r.stack.clone() }, &minted(b, if moved { "complete" } else { "undo" })).await?;
        if !moved {
            return Ok(Err(Refusal::new("rename_failed", "moving the agent's folders failed; the rename was undone")));
        }
    }
    Ok(Ok(r))
}
