//! `charter.capture` (WS4): the turn-start charter-read snapshot
//! (v6 TRANSACTIONS-AND-RUNTIME:62, I13; Q-CR r2 "The vector" and "The
//! mechanism"). WS5's `runtime.admit` consumes the vector and rechecks the
//! captured versions; WS3 owns the pure charter edit it races.
//!
//! **One `REPEATABLE READ READ ONLY` transaction, no locks.** The snapshot
//! is fixed by the FIRST statement (N1), which is S's role-charter head, so
//! every "after the snapshot" order pauses at `charter.capture.after_first_read`.
//! Heads are read in the vector's fixed order (F4): S's role charter, S's
//! team charter, then each strict ancestor's team charter upward; with each
//! node its `topology_edges.version` and `scope_rows.version`, S included,
//! and S's epoch fields `lifecycle`, `generation`, `halted` (compared field by
//! field by the claim; `audience_version`/`requests_version` are not in it).
//! `org.md` is outside the P03 vector (coordinator ruling 2).
//!
//! **Fail closed (coordinator ruling 1).** A head whose body row is missing
//! refuses `incomplete_charter`: no vector, so no claim and no turn. A
//! "last applicable body" fallback would be I13's stale vector.
//!
//! Statement labels: `capture.epoch`, `capture.node` (a chain node's
//! versions; WS5's schedules hold on it), and `head.<principal>.<role|team>`
//! for each head (Q-CR1/Q-CR3's per-head points
//! `charter.capture.stmt.head.<principal>.<kind>.before`).

use std::sync::Arc;

use uuid::Uuid;

use crate::exec::{CmdError, Executor, ExecError, OpIdentity, Refusal};
use crate::hooks::{controls, Scope};
use crate::read::Read;
use crate::runtime::admit::{ChainNode, Vector};
use crate::session::{Connector, Session};
use crate::value::Val;
use crate::Tx;

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &["Q-CR1.per_statement_reads", "Q-CR3.skip_missing", "Q-CR2.snapshot_held_over_input"];

const MAX_DEPTH: usize = 64;

pub const HEAD_SQL: &str = "SELECT h.current_version, v.body_sha256 FROM charter_heads h \
    LEFT JOIN charter_versions v ON v.org_id = h.org_id AND v.principal_id = h.principal_id AND v.charter_kind = h.charter_kind AND v.version = h.current_version \
    WHERE h.org_id = $1 AND h.principal_id = $2 AND h.charter_kind = $3";
pub const EPOCH_SQL: &str = "SELECT lifecycle, generation, halted FROM authority_epoch WHERE org_id = $1 AND principal_id = $2";
pub const NODE_SQL: &str = "SELECT e.parent_id, e.version, s.version FROM topology_edges e \
    JOIN scope_rows s ON s.org_id = e.org_id AND s.principal_id = e.principal_id WHERE e.org_id = $1 AND e.principal_id = $2";

/// One head read: `Ok(None)` = no charter of that kind; `Err` = the head
/// names a body that is missing (fail closed).
async fn head<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, node: Uuid, kind: &str) -> Result<Result<Option<(i64, String)>, Refusal>, CmdError> {
    let label = format!("head.{node}.{kind}");
    let rows = tx.exec(&label, HEAD_SQL, &[Val::Uuid(org), Val::Uuid(node), Val::text(kind)]).await?;
    let Some(r) = rows.first() else { return Ok(Ok(None)) };
    let version = r.first().and_then(Val::as_int).unwrap_or(0);
    match r.get(1).and_then(|v| v.as_text().map(str::to_string)) {
        Some(sha) => Ok(Ok(Some((version, sha)))),
        None if controls::fire(&tx.scope(), "Q-CR3.skip_missing") => Ok(Ok(None)),
        None => Ok(Err(Refusal::new(
            "incomplete_charter",
            format!("a charter body in the vector is missing ({kind} charter of {node}): the turn is not started"),
        ))),
    }
}

/// The capture (normal path: ONE snapshot).
pub struct Capture {
    pub org: Uuid,
    pub seat: Uuid,
    /// Q-CR2.snapshot_held_over_input: keep this snapshot open until notified
    /// (WS5's turn driver passes it; the control decides whether it is used).
    pub hold: Option<Arc<tokio::sync::Notify>>,
}

fn node(n: Uuid, row: &[Val], role: Option<i64>, team: Option<i64>) -> ChainNode {
    ChainNode {
        node: n,
        parent: row.first().and_then(Val::as_uuid),
        edge_version: row.get(1).and_then(Val::as_int).unwrap_or(0),
        scope_version: row.get(2).and_then(Val::as_int).unwrap_or(0),
        role_charter: role,
        team_charter: team,
    }
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
        let (org, seat) = (self.org, self.seat);
        let mut bodies = Vec::new();
        // 1. S's role charter: the FIRST statement fixes the snapshot (N1)
        let role = match head(tx, org, seat, "role").await? {
            Ok(h) => h,
            Err(r) => return Ok(Err(r)),
        };
        tx.pause("after_first_read").await?;
        if let Some((v, sha)) = &role {
            bodies.push((seat, "role".to_string(), *v, sha.clone()));
        }
        let e = tx.exec("capture.epoch", EPOCH_SQL, &[Val::Uuid(org), Val::Uuid(seat)]).await?;
        let Some(er) = e.first() else { return Ok(Err(Refusal::new("not_found", "no such seat"))) };
        let mut v = Vector {
            seat,
            lifecycle: er.first().and_then(Val::as_text).unwrap_or("").to_string(),
            generation: er.get(1).and_then(Val::as_int).unwrap_or(-1),
            halted: er.get(2) == Some(&Val::Bool(true)),
            chain: Vec::new(),
            bodies: Vec::new(),
        };
        // 2-3. S's team charter, then each ancestor's team charter, upward
        let mut cur = Some(seat);
        while let Some(n) = cur {
            if v.chain.len() >= MAX_DEPTH {
                break;
            }
            let team = match head(tx, org, n, "team").await? {
                Ok(h) => h,
                Err(r) => return Ok(Err(r)),
            };
            if let Some((ver, sha)) = &team {
                bodies.push((n, "team".to_string(), *ver, sha.clone()));
            }
            let r = tx.exec("capture.node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(n)]).await?;
            let Some(row) = r.first() else { return Ok(Err(Refusal::new("incomplete_chain", "a chain node has no edge or scope row"))) };
            let cn = node(n, row, if n == seat { role.as_ref().map(|x| x.0) } else { None }, team.map(|x| x.0));
            cur = cn.parent;
            v.chain.push(cn);
        }
        v.bodies = bodies;
        if let Some(h) = &self.hold {
            // Q-CR2's unsafe control: the snapshot is left OPEN across the
            // provider's input step.
            if controls::fire(&tx.scope(), "Q-CR2.snapshot_held_over_input") {
                h.notified().await;
            }
        }
        Ok(Ok(v))
    }
}

/// One head in its own snapshot (Q-CR1's unsafe control: per-statement
/// READ COMMITTED reads).
struct OneHead {
    org: Uuid,
    node: Uuid,
    kind: &'static str,
}

impl Read for OneHead {
    type Output = Result<Option<(i64, String)>, Refusal>;
    fn family(&self) -> &'static str {
        "charter"
    }
    fn verb(&self) -> &'static str {
        "capture"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        head(tx, self.org, self.node, self.kind).await
    }
}

/// The chain and its versions without the heads (the control's first read).
struct ChainOnly {
    org: Uuid,
    seat: Uuid,
}

impl Read for ChainOnly {
    type Output = Result<Vector, Refusal>;
    fn family(&self) -> &'static str {
        "charter"
    }
    fn verb(&self) -> &'static str {
        "capture"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let e = tx.exec("capture.epoch", EPOCH_SQL, &[Val::Uuid(self.org), Val::Uuid(self.seat)]).await?;
        let Some(er) = e.first() else { return Ok(Err(Refusal::new("not_found", "no such seat"))) };
        let mut v = Vector {
            seat: self.seat,
            lifecycle: er.first().and_then(Val::as_text).unwrap_or("").to_string(),
            generation: er.get(1).and_then(Val::as_int).unwrap_or(-1),
            halted: er.get(2) == Some(&Val::Bool(true)),
            chain: Vec::new(),
            bodies: Vec::new(),
        };
        let mut cur = Some(self.seat);
        while let Some(n) = cur {
            if v.chain.len() >= MAX_DEPTH {
                break;
            }
            let r = tx.exec("capture.node", NODE_SQL, &[Val::Uuid(self.org), Val::Uuid(n)]).await?;
            let Some(row) = r.first() else { return Ok(Err(Refusal::new("incomplete_chain", "a chain node has no edge or scope row"))) };
            let cn = node(n, row, None, None);
            cur = cn.parent;
            v.chain.push(cn);
        }
        Ok(Ok(v))
    }
}

/// `charter.capture`: one snapshot, or — under `Q-CR1.per_statement_reads`
/// — each head in its own snapshot, S's role head first, then S's team head,
/// then each ancestor's (the control's order, Q-CR r2 F1).
pub async fn capture<C: Connector>(ex: &Executor<C>, org: Uuid, seat: Uuid, hold: Option<Arc<tokio::sync::Notify>>) -> Result<Result<Vector, Refusal>, ExecError> {
    let op = OpIdentity::minted(org, "", "none");
    let scope = Scope { hooks: ex.hooks(), family: "charter", verb: "capture", op: Some(&op), op_tag: None, attempt: 1 };
    if !controls::fire(&scope, "Q-CR1.per_statement_reads") {
        return ex.read(&Capture { org, seat, hold }, org, None).await;
    }
    let mut v = match ex.read(&ChainOnly { org, seat }, org, None).await? {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let mut bodies = Vec::new();
    let order: Vec<(Uuid, &'static str)> = std::iter::once((seat, "role")).chain(v.chain.iter().map(|n| (n.node, "team"))).collect();
    for (n, kind) in order {
        let h = match ex.read(&OneHead { org, node: n, kind }, org, None).await? {
            Ok(h) => h,
            Err(r) => return Ok(Err(r)),
        };
        if let Some((ver, sha)) = h {
            bodies.push((n, kind.to_string(), ver, sha));
            if let Some(c) = v.chain.iter_mut().find(|c| c.node == n) {
                if kind == "role" {
                    c.role_charter = Some(ver);
                } else {
                    c.team_charter = Some(ver);
                }
            }
        }
    }
    v.bodies = bodies;
    Ok(Ok(v))
}

/// DECLARED-CONTACTS for `charter.capture`.
pub fn declared() -> serde_json::Value {
    serde_json::json!({
        "charter.capture": {
            "relations": {
                "charter_heads": {"modes": ["read"], "required": true},
                "charter_versions": {"modes": ["read"], "required": false},
                "authority_epoch": {"modes": ["read"], "required": true},
                "topology_edges": {"modes": ["read"], "required": true},
                "scope_rows": {"modes": ["read"], "required": true}
            },
            "p01_contract": null,
            "source": "v6 TRANSACTIONS-AND-RUNTIME:62, I13; Q-CR r2 (one REPEATABLE READ READ ONLY snapshot, no locks)"
        }
    })
}
