//! Turn admission and input-confirmed Read: WS5's minimal runtime claims
//! (S3 §8 P08 obligations (2); v6 TRANSACTIONS-AND-RUNTIME:62, I13; Q-CR r2
//! `runtime.admit`; v6 MAIL-STAGES "Read").
//!
//! A turn of seat S:
//! 1. **capture** (WS4 owns `charter.capture`; [`Capture`] here is a
//!    STAND-IN with the same vector, used until WS4's lands): one
//!    `REPEATABLE READ READ ONLY` snapshot of S's chain versions and charter
//!    heads, closed before the claim;
//! 2. **admit** ([`Admit`], READ COMMITTED): S's authority-epoch row, then the
//!    edge and scope rows of every node on the captured chain, S included,
//!    `FOR SHARE`; the captured versions compared field by field
//!    (`lifecycle`, `generation`, `halted`; never `audience_version` or
//!    `requests_version`); any mismatch refuses and forces a COMPLETE
//!    recapture (bounded, counted). Then S's runtime row is updated and a
//!    pending folder-move intent for S's stack DEFERS the turn; otherwise the
//!    claim is admitted and the seat's pending wake/kickoff intents are
//!    consumed;
//! 3. **input** ([`ClaimInput`] → fake provider → [`ConfirmInput`]): pending
//!    mail is claimed into an input batch (`delivering`); the provider's
//!    consumption evidence confirms it (`delivered`). No SQL transaction is
//!    open while the provider consumes input;
//! 4. **settle** ([`Settle`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::exec::{Binding, CmdError, Command, Decided, Family, Isolation, Refusal};
use crate::hooks::controls;
use crate::mail::hints::{self, Hint};
use crate::read::Read;
use crate::session::Session;
use crate::value::{Rows, Val};
use crate::Tx;

pub static RUNTIME: Family = Family { name: "runtime", isolation: Isolation::ReadCommitted, retry_unique: &[] };

pub const CONTROLS: &[&str] = &[
    "Q-CR2.no_claim_recheck",
    "Q-CR2.no_anchor",
    "Q-CR2.partial_recapture",
    "Q-CR2.snapshot_held_over_input",
    "Q-CR3.cached_fallback",
    "Q-CR3.skip_missing",
    "Q-ST7.admit_ignores_intent",
];

pub const MAX_RECAPTURE: u32 = 8;
const MAX_DEPTH: usize = 64;

/// One node of the captured chain (S first, then its ancestors upward).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainNode {
    pub node: Uuid,
    pub parent: Option<Uuid>,
    pub edge_version: i64,
    pub scope_version: i64,
    /// The node's current charter head version, if any (vector CONTENT: it is
    /// not rechecked by admission, Q-CR r2 "Charter heads are not rechecked").
    pub charter_version: Option<i64>,
}

/// The captured vector (Q-CR r2 "The vector").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vector {
    pub seat: Uuid,
    pub lifecycle: String,
    pub generation: i64,
    pub halted: bool,
    pub chain: Vec<ChainNode>,
}

pub const CAP_EPOCH_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const CAP_NODE_SQL: &str = "SELECT e.parent_id, e.version, s.version, h.current_version FROM topology_edges e \
    JOIN scope_rows s ON s.org_id = e.org_id AND s.principal_id = e.principal_id \
    LEFT JOIN charter_heads h ON h.org_id = e.org_id AND h.principal_id = e.principal_id \
    WHERE e.org_id = $1 AND e.principal_id = $2";
pub const CAP_BODY_SQL: &str = "SELECT 1 FROM charter_versions WHERE org_id = $1 AND principal_id = $2 AND version = $3";

/// STAND-IN for WS4's `charter.capture`: the vector in ONE snapshot. A node
/// whose charter head names a missing body fails closed (coordinator ruling
/// on Q-CR3 (c)) unless the Q-CR3.skip_missing control skips it.
pub struct Capture {
    pub org: Uuid,
    pub seat: Uuid,
    /// Q-CR2.snapshot_held_over_input: keep this snapshot open until notified.
    pub hold: Option<std::sync::Arc<tokio::sync::Notify>>,
}

impl Read for Capture {
    type Output = Result<Vector, Refusal>;
    fn family(&self) -> &'static str {
        "charter"
    }
    fn verb(&self) -> &'static str {
        "capture"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Result<Vector, Refusal>, CmdError> {
        let org = self.org;
        let e = tx.exec("capture.epoch", CAP_EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(self.seat)]).await?;
        tx.pause("after_first_read").await?;
        let Some(er) = e.first() else { return Ok(Err(Refusal::new("not_found", "no such seat"))) };
        let mut v = Vector {
            seat: self.seat,
            lifecycle: er.first().and_then(Val::as_text).unwrap_or("").to_string(),
            generation: er.get(1).and_then(Val::as_int).unwrap_or(-1),
            halted: er.get(2) == Some(&Val::Bool(true)),
            chain: Vec::new(),
        };
        let mut cur = Some(self.seat);
        while let Some(n) = cur {
            if v.chain.len() >= MAX_DEPTH {
                break;
            }
            let r = tx.exec("capture.node", CAP_NODE_SQL, &[Val::Uuid(org), Val::Uuid(n)]).await?;
            let Some(row) = r.first() else { return Ok(Err(Refusal::new("incomplete_chain", "a chain node has no edge or scope row"))) };
            let node = ChainNode {
                node: n,
                parent: row.first().and_then(Val::as_uuid),
                edge_version: row.get(1).and_then(Val::as_int).unwrap_or(0),
                scope_version: row.get(2).and_then(Val::as_int).unwrap_or(0),
                charter_version: row.get(3).and_then(Val::as_int),
            };
            if let Some(cv) = node.charter_version {
                let body = tx.exec("capture.body", CAP_BODY_SQL, &[Val::Uuid(org), Val::Uuid(n), Val::Int(cv)]).await?;
                if body.is_empty() && !controls::fire(&tx.scope(), "Q-CR3.skip_missing") {
                    return Ok(Err(Refusal::new("incomplete_charter", "a charter body in the vector is missing: the turn is not started")));
                }
            }
            cur = node.parent;
            v.chain.push(node);
        }
        if let Some(h) = &self.hold {
            if controls::fire(&tx.scope(), "Q-CR2.snapshot_held_over_input") {
                h.notified().await;
            }
        }
        Ok(Ok(v))
    }
}

pub const PARTIAL_NODE_SQL: &str = "SELECT e.parent_id, e.version, s.version FROM topology_edges e     JOIN scope_rows s ON s.org_id = e.org_id AND s.principal_id = e.principal_id WHERE e.org_id = $1 AND e.principal_id = $2";

/// Q-CR2.partial_recapture's unsafe re-read: the old chain's nodes only.
pub struct PartialRecapture {
    pub org: Uuid,
    pub old: Vector,
}

impl Read for PartialRecapture {
    type Output = Result<Vector, Refusal>;
    fn family(&self) -> &'static str {
        "charter"
    }
    fn verb(&self) -> &'static str {
        "partial_recapture"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Result<Vector, Refusal>, CmdError> {
        let mut v = self.old.clone();
        let e = tx.exec("capture.epoch", CAP_EPOCH_SQL, &[Val::Uuid(self.org), Val::Uuid(v.seat)]).await?;
        if let Some(er) = e.first() {
            v.lifecycle = er.first().and_then(Val::as_text).unwrap_or("").to_string();
            v.generation = er.get(1).and_then(Val::as_int).unwrap_or(-1);
            v.halted = er.get(2) == Some(&Val::Bool(true));
        }
        for n in v.chain.iter_mut() {
            let r = tx.exec("capture.partial_node", PARTIAL_NODE_SQL, &[Val::Uuid(self.org), Val::Uuid(n.node)]).await?;
            if let Some(row) = r.first() {
                n.parent = row.first().and_then(Val::as_uuid);
                n.edge_version = row.get(1).and_then(Val::as_int).unwrap_or(0);
                n.scope_version = row.get(2).and_then(Val::as_int).unwrap_or(0);
            }
        }
        Ok(Ok(v))
    }
}

pub const EPOCH_SHARE_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const EPOCH_READ_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const EDGE_SHARE_SQL: &str = "SELECT parent_id, version FROM topology_edges WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const EDGE_READ_SQL: &str = "SELECT parent_id, version FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const SCOPE_SHARE_SQL: &str = "SELECT version FROM scope_rows WHERE org_id = $1 AND principal_id = $2 FOR SHARE";
pub const SCOPE_READ_SQL: &str = "SELECT version FROM scope_rows WHERE org_id = $1 AND principal_id = $2";
pub const RUNTIME_ROW_SQL: &str = "UPDATE runtime_state SET version = version + 1, updated_at = $3 WHERE org_id = $1 AND principal_id = $2 RETURNING busy";
pub const PENDING_MOVE_SQL: &str = "SELECT intent_id FROM folder_move_intents WHERE org_id = $1 AND stack_root_id = $2 AND state = 'pending'";
pub const ACTIVE_CLAIM_SQL: &str = "SELECT claim_id, state FROM runtime_claims WHERE org_id = $1 AND principal_id = $2 \
    AND state IN ('admitted', 'active', 'settling', 'deferred') ORDER BY created_at LIMIT 1";
pub const INSERT_CLAIM_SQL: &str = "INSERT INTO runtime_claims (org_id, claim_id, principal_id, generation, turn_id, state, charter_vector, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";
pub const PROMOTE_CLAIM_SQL: &str = "UPDATE runtime_claims SET state = 'admitted', charter_vector = $3 WHERE org_id = $1 AND claim_id = $2 AND state = 'deferred'";
pub const BUSY_SQL: &str = "UPDATE runtime_state SET busy = $3 WHERE org_id = $1 AND principal_id = $2";
pub const CONSUME_INTENTS_SQL: &str = "WITH c AS (UPDATE outgoing_intents SET stage = 'settled', settled_at = $3 \
    WHERE org_id = $1 AND dest_ref = $2 AND kind IN ('wake', 'kickoff') AND stage = 'pending' RETURNING 1) SELECT count(*) FROM c";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "admission", rename_all = "snake_case")]
pub enum Admission {
    /// Admitted: the claim, and how many wake/kickoff demands it consumed.
    Admitted { claim_id: Uuid, consumed: i64 },
    /// A folder-move intent is pending for the seat's stack: the turn waits
    /// (its demands stay pending) and is admitted once the intent closes.
    Deferred { claim_id: Uuid, intent_id: Uuid },
}

/// `runtime.admit` (Q-CR r2 step 2).
pub struct Admit {
    pub vector: Vector,
    pub turn_id: Uuid,
}

fn mismatch(what: &str) -> Decided<Admission> {
    Decided::Refused(Refusal::new("recapture", format!("the captured vector is stale: {what}")))
}

impl Command for Admit {
    type Output = Admission;
    fn family(&self) -> &'static Family {
        &RUNTIME
    }
    fn verb(&self) -> &'static str {
        "admit"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Admission) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Admission>, CmdError> {
        let org = b.op.org;
        let v = &self.vector;
        if v.lifecycle != "live" || v.halted {
            return Ok(Decided::Refused(Refusal::new("not_admissible", "the seat is not live, or is halted")));
        }
        let skip_recheck = controls::fire(&tx.scope(), "Q-CR2.no_claim_recheck");
        if !skip_recheck {
            let no_anchor = controls::fire(&tx.scope(), "Q-CR2.no_anchor");
            let (epoch_sql, edge_sql, scope_sql) = if no_anchor { (EPOCH_READ_SQL, EDGE_READ_SQL, SCOPE_READ_SQL) } else { (EPOCH_SHARE_SQL, EDGE_SHARE_SQL, SCOPE_SHARE_SQL) };
            let e = tx.exec("admit.epoch", epoch_sql, &[Val::Uuid(org), Val::Uuid(v.seat)]).await?;
            let Some(er) = e.first() else { return Ok(mismatch("seat gone")) };
            if er.first().and_then(Val::as_text) != Some(v.lifecycle.as_str()) {
                return Ok(mismatch("lifecycle"));
            }
            if er.get(1).and_then(Val::as_int) != Some(v.generation) {
                return Ok(mismatch("generation"));
            }
            if (er.get(2) == Some(&Val::Bool(true))) != v.halted {
                return Ok(mismatch("halted"));
            }
            for n in &v.chain {
                let ed = tx.exec("admit.edge", edge_sql, &[Val::Uuid(org), Val::Uuid(n.node)]).await?;
                let Some(r) = ed.first() else { return Ok(mismatch("edge gone")) };
                if r.first().and_then(Val::as_uuid) != n.parent || r.get(1).and_then(Val::as_int) != Some(n.edge_version) {
                    return Ok(mismatch("topology"));
                }
                let sc = tx.exec("admit.scope", scope_sql, &[Val::Uuid(org), Val::Uuid(n.node)]).await?;
                if sc.first().and_then(|r| r.first()).and_then(Val::as_int) != Some(n.scope_version) {
                    return Ok(mismatch("scope"));
                }
            }
            tx.pause("after_recheck").await?;
        }
        let now = tx.now().await?;
        let vector_json = serde_json::to_value(v).unwrap_or(Value::Null);
        // S3 §8 (2): update the seat's runtime row, THEN look for a pending
        // folder-move intent of its stack. The Q-ST7 control looks first (or
        // not at all).
        let ignore_intent = controls::fire(&tx.scope(), "Q-ST7.admit_ignores_intent");
        let rt = tx.exec("admit.runtime_row", RUNTIME_ROW_SQL, &[Val::Uuid(org), Val::Uuid(v.seat), Val::Ts(now)]).await?;
        if rt.is_empty() {
            return Ok(Decided::Refused(Refusal::new("not_found", "the seat has no runtime row")));
        }
        let pending_move = if ignore_intent {
            None
        } else {
            let r = tx.exec("admit.pending_move", PENDING_MOVE_SQL, &[Val::Uuid(org), Val::Uuid(v.seat)]).await?;
            r.first().and_then(|x| x.first()).and_then(Val::as_uuid)
        };
        let active = tx.exec("admit.active_claim", ACTIVE_CLAIM_SQL, &[Val::Uuid(org), Val::Uuid(v.seat)]).await?;
        let existing: Option<(Uuid, String)> = active.first().and_then(|r| Some((r.first()?.as_uuid()?, r.get(1)?.as_text()?.to_string())));
        if let Some(intent_id) = pending_move {
            let claim_id = match existing {
                Some((c, s)) if s == "deferred" => c,
                Some(_) => return Ok(Decided::Refused(Refusal::new("busy", "the seat already has an active turn"))),
                None => {
                    let c = Uuid::new_v4();
                    tx.exec("admit.defer", INSERT_CLAIM_SQL, &[Val::Uuid(org), Val::Uuid(c), Val::Uuid(v.seat), Val::Int(v.generation), Val::Uuid(self.turn_id), Val::text("deferred"), Val::Json(vector_json), Val::Ts(now)]).await?;
                    c
                }
            };
            return Ok(Decided::Applied(Admission::Deferred { claim_id, intent_id }));
        }
        let claim_id = match existing {
            Some((c, s)) if s == "deferred" => {
                tx.exec("admit.promote", PROMOTE_CLAIM_SQL, &[Val::Uuid(org), Val::Uuid(c), Val::Json(vector_json)]).await?;
                c
            }
            Some(_) => return Ok(Decided::Refused(Refusal::new("busy", "the seat already has an active turn"))),
            None => {
                let c = Uuid::new_v4();
                tx.exec("admit.claim", INSERT_CLAIM_SQL, &[Val::Uuid(org), Val::Uuid(c), Val::Uuid(v.seat), Val::Int(v.generation), Val::Uuid(self.turn_id), Val::text("admitted"), Val::Json(vector_json), Val::Ts(now)]).await?;
                c
            }
        };
        tx.exec("admit.busy", BUSY_SQL, &[Val::Uuid(org), Val::Uuid(v.seat), Val::Bool(true)]).await?;
        let consumed = tx.exec("admit.consume", CONSUME_INTENTS_SQL, &[Val::Uuid(org), Val::Uuid(v.seat), Val::Ts(now)]).await?;
        let consumed = consumed.first().and_then(|r| r.first()).and_then(Val::as_int).unwrap_or(0);
        Ok(Decided::Applied(Admission::Admitted { claim_id, consumed }))
    }
}

// ---------------------------------------------------------------- input-confirmed Read

pub const OPEN_MAILBOX_SQL: &str = "SELECT mailbox_id FROM mailboxes WHERE org_id = $1 AND owner_kind = 'agent' AND owner_id = $2 AND state = 'open' \
    ORDER BY incarnation DESC LIMIT 1";
pub const HEAD_LOCK_SQL: &str = "SELECT recv_seq FROM mailboxes WHERE org_id = $1 AND mailbox_id = $2 FOR UPDATE";
pub const CLAIM_ROW_SQL: &str = "SELECT claim_id, generation FROM runtime_claims WHERE org_id = $1 AND claim_id = $2 AND state = 'admitted' FOR NO KEY UPDATE";
pub const PENDING_INPUT_SQL: &str = "SELECT original_message_id FROM mailbox_messages \
    WHERE org_id = $1 AND mailbox_id = $2 AND state = 'pending' ORDER BY recv_ord";
pub const INSERT_BATCH_SQL: &str = "INSERT INTO mail_input_batches (org_id, batch_id, mailbox_id, principal_id, generation, claim_id, state, created_at) \
    VALUES ($1, $2, $3, $4, $5, $6, 'claimed', $7)";
pub const MARK_DELIVERING_SQL: &str = "UPDATE mailbox_messages SET state = 'delivering', batch_id = $4 \
    WHERE org_id = $1 AND mailbox_id = $2 AND original_message_id = $3 AND state = 'pending'";
pub const BATCH_LOCK_SQL: &str = "SELECT mailbox_id, state FROM mail_input_batches WHERE org_id = $1 AND batch_id = $2 FOR NO KEY UPDATE";
pub const BATCH_ROWS_SQL: &str = "SELECT original_message_id FROM mailbox_messages WHERE org_id = $1 AND batch_id = $2 ORDER BY recv_ord";
pub const CONFIRM_ROWS_SQL: &str = "UPDATE mailbox_messages SET state = 'delivered', delivered_at = $3, batch_id = NULL \
    WHERE org_id = $1 AND batch_id = $2 AND state = 'delivering'";
pub const ABANDON_ROWS_SQL: &str = "UPDATE mailbox_messages SET state = 'pending', batch_id = NULL WHERE org_id = $1 AND batch_id = $2 AND state = 'delivering'";
pub const SETTLE_BATCH_SQL: &str = "UPDATE mail_input_batches SET state = $3, evidence = $4, settled_at = $5 WHERE org_id = $1 AND batch_id = $2";

/// The evidence a provider reports for consuming exactly these messages, in
/// this order (the fake provider computes the same function).
pub fn input_evidence(ids: &[Uuid]) -> String {
    use orgtree_op_receipt_codec::sha256::{hex, sha256};
    let mut s = String::new();
    for id in ids {
        s.push_str(&id.to_string());
        s.push('\n');
    }
    hex(&sha256(s.as_bytes()))
}

/// The fake provider (P03: no real model): it "consumes" an input batch and
/// reports matching input evidence. `tamper` makes it report the wrong
/// evidence (a provider that did not consume what was claimed).
pub struct FakeProvider {
    pub tamper: bool,
}

impl FakeProvider {
    pub fn consume(&self, ids: &[Uuid]) -> String {
        if self.tamper {
            return input_evidence(&[Uuid::nil()]);
        }
        input_evidence(ids)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputBatch {
    pub batch_id: Uuid,
    pub messages: Vec<Uuid>,
}

/// Claim the seat's pending mail as ONE input batch of an admitted claim:
/// the head row `FOR UPDATE` (the pending set is the receiver's), then the
/// rows move `pending → delivering`.
pub struct ClaimInput {
    pub seat: Uuid,
    pub claim_id: Uuid,
}

impl Command for ClaimInput {
    type Output = Option<InputBatch>;
    fn family(&self) -> &'static Family {
        &RUNTIME
    }
    fn verb(&self) -> &'static str {
        "claim_input"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Option<InputBatch>) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Option<InputBatch>>, CmdError> {
        let org = b.op.org;
        let claim = tx.exec("input.claim_row", CLAIM_ROW_SQL, &[Val::Uuid(org), Val::Uuid(self.claim_id)]).await?;
        let Some(generation) = claim.first().and_then(|r| r.get(1)).and_then(Val::as_int) else {
            return Ok(Decided::Refused(Refusal::new("no_admitted_claim", "the claim is not admitted")));
        };
        let mb = tx.exec("input.mailbox", OPEN_MAILBOX_SQL, &[Val::Uuid(org), Val::Uuid(self.seat)]).await?;
        let Some(mailbox) = mb.first().and_then(|r| r.first()).and_then(Val::as_uuid) else { return Ok(Decided::Applied(None)) };
        tx.exec("input.head", HEAD_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let rows: Rows = tx.exec("input.pending", PENDING_INPUT_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let ids: Vec<Uuid> = rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
        if ids.is_empty() {
            return Ok(Decided::Applied(None));
        }
        let now = tx.now().await?;
        let batch = Uuid::new_v4();
        tx.exec("input.batch", INSERT_BATCH_SQL, &[Val::Uuid(org), Val::Uuid(batch), Val::Uuid(mailbox), Val::Uuid(self.seat), Val::Int(generation), Val::Uuid(self.claim_id), Val::Ts(now)]).await?;
        for id in &ids {
            tx.exec("input.delivering", MARK_DELIVERING_SQL, &[Val::Uuid(org), Val::Uuid(mailbox), Val::Uuid(*id), Val::Uuid(batch)]).await?;
        }
        Ok(Decided::Applied(Some(InputBatch { batch_id: batch, messages: ids })))
    }
}

/// Confirm an input batch from the provider's evidence (v6 "Read": agent
/// input delivery is confirmed by matching runtime input evidence). Evidence
/// that does not match the batch confirms nothing.
pub struct ConfirmInput {
    pub batch_id: Uuid,
    pub evidence: String,
}

impl Command for ConfirmInput {
    type Output = usize;
    fn family(&self) -> &'static Family {
        &RUNTIME
    }
    fn verb(&self) -> &'static str {
        "confirm_input"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &usize) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<usize>, CmdError> {
        let org = b.op.org;
        let bt = tx.exec("input.batch_lock", BATCH_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id)]).await?;
        if bt.first().and_then(|r| r.get(1)).and_then(Val::as_text) != Some("claimed") {
            return Ok(Decided::Refused(Refusal::new("not_claimed", "the batch is not open")));
        }
        let rows = tx.exec("input.batch_rows", BATCH_ROWS_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id)]).await?;
        let ids: Vec<Uuid> = rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect();
        if input_evidence(&ids) != self.evidence {
            return Ok(Decided::Refused(Refusal::new("evidence_mismatch", "the provider's input evidence does not match the claimed batch")));
        }
        let now = tx.now().await?;
        tx.exec("input.confirm_rows", CONFIRM_ROWS_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id), Val::Ts(now)]).await?;
        tx.exec("input.settle_batch", SETTLE_BATCH_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id), Val::text("confirmed"), Val::text(self.evidence.clone()), Val::Ts(now)]).await?;
        Ok(Decided::Applied(ids.len()))
    }
}

/// Abandon an input batch (the provider did not consume it): its rows are
/// pending again, for the next turn.
pub struct AbandonInput {
    pub batch_id: Uuid,
}

impl Command for AbandonInput {
    type Output = ();
    fn family(&self) -> &'static Family {
        &RUNTIME
    }
    fn verb(&self) -> &'static str {
        "abandon_input"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &()) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<()>, CmdError> {
        let org = b.op.org;
        let bt = tx.exec("input.batch_lock", BATCH_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id)]).await?;
        let Some(mailbox) = bt.first().and_then(|r| r.first()).and_then(Val::as_uuid) else { return Ok(Decided::Applied(())) };
        tx.exec("input.head", HEAD_LOCK_SQL, &[Val::Uuid(org), Val::Uuid(mailbox)]).await?;
        let now = tx.now().await?;
        tx.exec("input.abandon_rows", ABANDON_ROWS_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id)]).await?;
        tx.exec("input.settle_batch", SETTLE_BATCH_SQL, &[Val::Uuid(org), Val::Uuid(self.batch_id), Val::text("abandoned"), Val::Null, Val::Ts(now)]).await?;
        Ok(Decided::Applied(()))
    }
}

pub const SETTLE_CLAIM_SQL: &str = "UPDATE runtime_claims SET state = 'settled', settled_at = $3 WHERE org_id = $1 AND claim_id = $2 \
    AND state IN ('admitted', 'active', 'settling') RETURNING principal_id";

/// End a turn: the claim settles and the seat is no longer busy.
pub struct Settle {
    pub claim_id: Uuid,
}

impl Command for Settle {
    type Output = bool;
    fn family(&self) -> &'static Family {
        &RUNTIME
    }
    fn verb(&self) -> &'static str {
        "settle"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &bool) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<bool>, CmdError> {
        let org = b.op.org;
        let now = tx.now().await?;
        let r = tx.exec("settle.claim", SETTLE_CLAIM_SQL, &[Val::Uuid(org), Val::Uuid(self.claim_id), Val::Ts(now)]).await?;
        let Some(seat) = r.first().and_then(|x| x.first()).and_then(Val::as_uuid) else { return Ok(Decided::Applied(false)) };
        tx.exec("settle.busy", BUSY_SQL, &[Val::Uuid(org), Val::Uuid(seat), Val::Bool(false)]).await?;
        let h = Hint::Runtime { org, principal: seat };
        tx.after_commit(move || hints::emit(h));
        Ok(Decided::Applied(true))
    }
}

/// A vector description for traces and results.
pub fn describe(v: &Vector) -> Value {
    json!({"seat": v.seat.to_string(), "generation": v.generation, "chain": v.chain.iter().map(|n| n.node.to_string()).collect::<Vec<_>>()})
}
