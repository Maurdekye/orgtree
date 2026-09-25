//! Preview of `reallocate` (WS4, r7 §6, C6, D10, D11: P03 previews
//! `reallocate` only).
//!
//! Preview is the real transition's decide function run over the same
//! declared read set, in a protected read (C5), and never applied:
//!
//! 1. argument handling as the real door;
//! 2. the output claim is registered before the snapshot (C5);
//! 3. ONE `REPEATABLE READ READ ONLY` snapshot reads the caller's identity,
//!    generation and visibility, the BEFORE projection (the
//!    `diagnostic.inspect` visible-set projection) and the transition's
//!    declared read set ([`crate::funding::load`], the same reads the real
//!    command takes under its locks), with no row or predicate locks;
//! 4. decide ([`crate::funding::decide_reallocate`], the real command's
//!    function): a refusal, or a write set and a result;
//! 5. the AFTER projection is the before projection with the write set
//!    applied in memory (each changed grant, and every `free` it moves);
//! 6. the diff in legacy's positional format (`statepreview._diff`);
//! 7. the answer is released through the claim ([`crate::strict::emit`]).
//!
//! No locks, no writes, no rollback: a preview can never be why a writer
//! waits or aborts (r7 §6.3). The run-and-roll-back alternative is kept only
//! as Q-P2's unsafe control.

use std::collections::BTreeMap;
use std::sync::Arc;

use orgtree_funding_core::pynum::PyNum;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::claims::{ClaimHandle, ClaimRegistry};
use crate::exec::{Binding, CmdError, Command, Decided, Executor, ExecError, Family, Isolation, Refusal};
use crate::funding::{self, Actor, ReadMode};
use crate::hooks::controls;
use crate::read::Read;
use crate::session::{Connector, Session};
use crate::strict;
use crate::value::Val;
use crate::Tx;

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &["Q-P1.whole_document", "Q-P2.run_and_roll_back", "Q-P4.fence_disabled", "Q-P5.org_wide_lock", "Q-P6.drop_children_read"];

/// `orgtree_preview {operation: "reallocate", args: {node, delta}}`.
pub struct PreviewReallocate {
    pub org: Uuid,
    /// The caller (agent) or None for the operator.
    pub me: Option<(Uuid, i64)>,
    pub node: Uuid,
    pub delta: PyNum,
    pub include_archived: bool,
}

/// What the preview decided, before rendering.
#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Refused(Refusal),
    /// (new grant, warnings, changed grants (node name → hundredths))
    Applied { grant: Value, warnings: Vec<String>, changes: BTreeMap<String, i64> },
}

impl Read for PreviewReallocate {
    type Output = Result<(Value, Decision), Refusal>;
    fn family(&self) -> &'static str {
        "preview"
    }
    fn verb(&self) -> &'static str {
        "reallocate"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let org = self.org;
        // the caller's identity and the BEFORE projection
        let before = match self.me {
            Some((me, generation)) => {
                let m = match strict::caller_ok(&strict::member(tx, org, me).await?, generation) {
                    Ok(m) => m,
                    Err(r) => return Ok(Err(r)),
                };
                let (vis, ids) = match strict::visible_ids(tx, org, me, &m, self.include_archived).await? {
                    Ok(x) => x,
                    Err(r) => return Ok(Err(r)),
                };
                strict::project_set(tx, org, &m.name, &vis, &ids).await?
            }
            None => {
                let ids = strict::all_ids(tx, org, self.include_archived).await?;
                strict::project_set(tx, org, "@user", "full", &ids).await?
            }
        };
        if controls::fire(&tx.scope(), "Q-P1.whole_document") {
            // legacy's isolated() clone: every retained section materialized
            for sql in [
                "SELECT message_id FROM mail_sent WHERE org_id = $1",
                "SELECT seq FROM work_item_versions WHERE org_id = $1",
                "SELECT seq FROM transcript_entries WHERE org_id = $1",
                "SELECT reservation_id FROM resource_reservations WHERE org_id = $1",
            ] {
                tx.exec("preview.whole_document", sql, &[Val::Uuid(org)]).await?;
            }
        }
        // the transition's declared read set, unlocked, in this snapshot
        let Some(mut l) = funding::load(tx, org, self.node, ReadMode { lock: false }).await? else {
            return Ok(Err(Refusal::new("funding.nosuchnode", format!("no such node {}", self.node))));
        };
        if controls::fire(&tx.scope(), "Q-P6.drop_children_read") {
            // the mutation: the payer's children are dropped from the read set
            let payer = l.chain.get(1).and_then(|p| l.name(*p).map(str::to_string));
            let keep: Vec<String> = l.chain.iter().filter_map(|c| l.name(*c).map(str::to_string)).collect();
            l.snap.nodes.retain(|n| n.parent != payer || keep.contains(&n.id));
        }
        tx.pause("after_snapshot").await?;
        let actor = match self.me {
            Some((me, _)) => Actor::Agent(me),
            None => Actor::User,
        };
        let decision = match funding::decide_reallocate(&l, actor, self.delta)? {
            Err(r) => Decision::Refused(r),
            Ok(plan) => match funding::kiosk_check_unlocked(tx, org, &l, &plan).await? {
                Some(r) => Decision::Refused(r),
                None => {
                let mut changes = BTreeMap::new();
                for (id, _old, new) in &plan.changes {
                    if let Some(n) = l.name(*id) {
                        changes.insert(n.to_string(), *new);
                    }
                }
                Decision::Applied { grant: funding::py_json(plan.new_grant), warnings: plan.warnings, changes }
                }
            },
        };
        Ok(Ok((before, decision)))
    }
}

fn credit(v: &Value) -> i64 {
    (v.as_f64().unwrap_or(0.0) * 100.0).round() as i64
}

fn py_credits(c: i64) -> Value {
    if c % 100 == 0 {
        json!(c / 100)
    } else {
        json!(c as f64 / 100.0)
    }
}

/// The AFTER projection: `before` with the write set applied in memory —
/// each changed grant, its own `free` raised by the change and its
/// (projected) parent's `free` lowered by it.
pub fn after_of(before: &Value, changes: &BTreeMap<String, i64>) -> Value {
    let mut after = before.clone();
    let Some(nodes) = after["nodes"].as_array_mut() else { return after };
    let deltas: Vec<(String, Option<String>, i64)> = nodes
        .iter()
        .filter_map(|n| {
            let id = n["id"].as_str()?.to_string();
            let new = *changes.get(&id)?;
            Some((id, n["parent"].as_str().map(str::to_string), new - credit(&n["grant"])))
        })
        .collect();
    for (id, parent, d) in deltas {
        for n in nodes.iter_mut() {
            if n["id"].as_str() == Some(id.as_str()) {
                n["grant"] = py_credits(credit(&n["grant"]) + d);
                if !n["free"].is_null() {
                    n["free"] = py_credits(credit(&n["free"]) + d);
                }
            } else if parent.as_deref().is_some_and(|p| n["id"].as_str() == Some(p)) && !n["free"].is_null() {
                n["free"] = py_credits(credit(&n["free"]) - d);
            }
        }
    }
    after
}

/// Legacy `statepreview._diff`: positional paths, before/after leaves.
pub fn diff(before: &Value, after: &Value, path: &str, out: &mut Vec<Value>) {
    match (before, after) {
        (Value::Object(b), Value::Object(a)) => {
            let mut keys: Vec<&String> = b.keys().chain(a.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let child = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                match (b.get(k), a.get(k)) {
                    (None, Some(x)) => out.push(json!({"path": child, "before": null, "after": x})),
                    (Some(x), None) => out.push(json!({"path": child, "before": x, "after": null})),
                    (Some(x), Some(y)) => diff(x, y, &child, out),
                    (None, None) => {}
                }
            }
        }
        (Value::Array(b), Value::Array(a)) => {
            for i in 0..b.len().max(a.len()) {
                let child = format!("{path}[{i}]");
                match (b.get(i), a.get(i)) {
                    (None, Some(x)) => out.push(json!({"path": child, "before": null, "after": x})),
                    (Some(x), None) => out.push(json!({"path": child, "before": x, "after": null})),
                    (Some(x), Some(y)) => diff(x, y, &child, out),
                    (None, None) => {}
                }
            }
        }
        (b, a) if b != a => out.push(json!({"path": path, "before": b, "after": a})),
        _ => {}
    }
}

/// The rendered preview (legacy `statepreview.preview`'s shape), or the
/// refusal the real command would give.
pub fn render(before: Value, d: &Decision) -> Result<Value, Refusal> {
    match d {
        Decision::Refused(r) => Err(r.clone()),
        Decision::Applied { grant, warnings, changes } => {
            let after = after_of(&before, changes);
            let mut ch = Vec::new();
            diff(&before, &after, "", &mut ch);
            let mut m = Map::new();
            m.insert("operation".into(), json!("reallocate"));
            m.insert("applied".into(), json!(false));
            m.insert("result".into(), json!({"grant": grant, "warnings": warnings}));
            m.insert("before".into(), before);
            m.insert("after".into(), after);
            m.insert("changes".into(), json!(ch));
            Ok(Value::Object(m))
        }
    }
}

/// Preview as a protected read: register (for an agent caller), one
/// snapshot, decide; the caller emits through [`strict::emit`] with the
/// Q-P4 fence id. The operator's own authority cannot be narrowed (S3 E2),
/// so an operator preview carries no claim.
pub async fn preview<C: Connector>(ex: &Executor<C>, reg: &Arc<ClaimRegistry>, q: PreviewReallocate) -> Result<(Option<ClaimHandle>, Result<(Value, Decision), Refusal>), ExecError> {
    let h = q.me.map(|(me, g)| strict::register(reg, q.org, me, g));
    let org = q.org;
    Ok((h, ex.read(&q, org, None).await?))
}

// ---------------------------------------------------------------- Q-P2's unsafe control

pub static PREVIEW_ROLLBACK: Family = Family { name: "preview", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Q-P2's unsafe control, "run-and-roll-back preview": the REAL command's
/// locks are taken and its plan computed, then the transaction is refused
/// (rolled back) — so writers wait on the preview.
pub struct RollbackPreview {
    pub node: Uuid,
    pub delta: PyNum,
    hint: std::sync::Mutex<std::collections::BTreeSet<Uuid>>,
}

impl RollbackPreview {
    pub fn new(node: Uuid, delta: PyNum) -> RollbackPreview {
        RollbackPreview { node, delta, hint: std::sync::Mutex::new(Default::default()) }
    }
}

impl Command for RollbackPreview {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &PREVIEW_ROLLBACK
    }
    fn verb(&self) -> &'static str {
        "reallocate_rollback"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let _ = controls::fire(&tx.scope(), "Q-P2.run_and_roll_back");
        let delta = self.delta;
        let r = funding::plan_locked(tx, b.op.org, Actor::User, self.node, None, false, &self.hint, &move |_| Ok(delta)).await?;
        tx.pause("after_plan").await?;
        let _ = r;
        Ok(Decided::Refused(Refusal::new("preview", "rolled back")))
    }
}
