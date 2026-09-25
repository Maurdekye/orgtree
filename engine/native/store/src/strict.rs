//! Strict (protected) reads (WS4, r7 C5): `material.transcript`,
//! `material.scratch` (r7 §4), `diagnostic.inspect`,
//! `diagnostic.capabilities` (r7 §5) and `chart.read` (S3 §4.2).
//!
//! Each follows C5: (2) an output claim is registered at the read service
//! BEFORE the snapshot ([`register`]); (3) ONE `REPEATABLE READ READ ONLY`
//! snapshot reads the caller's membership, every authority fact of the route
//! and every database-resident content row, with no row or predicate locks;
//! (4) file content (scratch) is read after the snapshot, outside SQL; (5)
//! the answer is released only through [`emit`], which withholds it with a
//! retryable refusal once a restriction revoked the claim. Restrictions are
//! recorded by the narrowing writers in their own transactions
//! ([`crate::restrict::record`]); the read service applies them
//! ([`consume_restrictions`]: revoke matching claims, let emitting ones
//! finish, acknowledge).
//!
//! **P03 narrowings (disclosed).** Answers are structured JSON of the facts
//! each legacy renderer prints; the text rendering and every wire shape are
//! the wire owners' (`chart.wire`, `diagnostic.wire`, `material.wire`).
//! Fields with no P03 column (account binding, frozen, pending switch, mail
//! drain, bearer state, archived_at of a node) project as null. The item
//! route's holder roster is derived from the P03-only `work_item_versions`
//! encoding (each version records the item's owner); an item's "entry into
//! the active set" is its `created_at`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::claims::{ClaimHandle, ClaimRegistry, Restriction, Withheld};
use crate::exec::{Binding, CmdError, Command, Decided, Executor, ExecError, Family, Isolation, OpIdentity, Refusal};
use crate::hooks::{controls, Scope};
use crate::read::Read;
use crate::session::{Connector, Session};
use crate::value::{Rows, Val};
use crate::Tx;

/// Unsafe controls compiled into this module (static list for the handshake).
pub const CONTROLS: &[&str] = &[
    "Q-M1.fence_disabled",
    "Q-M2.match_by_name",
    "Q-M3.positional_last_row",
    "Q-M4.end_at_close",
    "Q-M5.scan_all_items",
    "Q-M6.org_wide_lock",
    "Q-M7.mint_without_key",
    "Q-D1.two_snapshots",
    "Q-D2.fence_disabled",
    "Q-D3.fence_disabled",
    "Q-D4.org_wide_lock",
    "Q-D5.whole_document",
    "Q-D6.unknown_widens",
    "Q-CH1.fence_disabled",
    "Q-CH2.separate_snapshots",
];

/// Legacy content bounds (r7 §4.2): entries, total characters, per message.
pub const MAX_ENTRIES: i64 = 200;
pub const MAX_TOTAL_CHARS: usize = 20_000;
pub const MAX_MESSAGE_CHARS: usize = 1_200;

/// Legacy's one refusal for every non-granting material case (`api.py`
/// `_agent_read_access`), with the target named.
pub fn material_refusal(target: &str) -> Refusal {
    Refusal::new(
        "not_readable",
        format!(
            "read access is strictly DOWNWARD (§7.6) — you may read yourself and your descendants, and nobody else, EXCEPT through a shared docket item: if you are currently listed on an OPEN item (its holder, a participant, or its named reviewer) that {target} held BEFORE you, its scratch and transcript are readable to you on the strength of that item. Neither applies here. Three things end that route and each is deliberate: the item closing or archiving, you no longer being listed on it, and the target being its CURRENT holder rather than a previous one. `orgtree_work get` shows an item's `holders` — the agents that have held it, current one last — and every row but that last one is readable to you while you are listed on the item."
        ),
    )
}

/// The retryable refusal a withheld answer becomes (r7 D5).
pub fn withheld_refusal() -> Refusal {
    Refusal::new("withheld", "the answer was withheld because your authority changed while it was being built; retry")
}

// ---------------------------------------------------------------- the C5 service side

/// Step 2: register the output claim BEFORE the snapshot.
pub fn register(reg: &Arc<ClaimRegistry>, org: Uuid, principal: Uuid, generation: i64) -> ClaimHandle {
    reg.register(org, principal, generation)
}

fn scope_for<'a>(hooks: &'a crate::hooks::Hooks, op: &'a OpIdentity) -> Scope<'a> {
    Scope { hooks, family: "strict", verb: "emit", op: Some(op), op_tag: None, attempt: 1 }
}

/// Step 5: release `answer` through the claim, or withhold it. `fence` is the
/// schedule's unsafe-control id ("fence disabled": the answer is released
/// even after the claim was revoked).
pub async fn emit<C: Connector, T>(ex: &Executor<C>, org: Uuid, handle: ClaimHandle, fence: &str, answer: T) -> Result<T, Refusal> {
    let op = OpIdentity::minted(org, "", "none");
    if controls::fire(&scope_for(ex.hooks(), &op), fence) {
        drop(handle);
        return Ok(answer);
    }
    handle.emit(|| async { answer }).await.map_err(|Withheld| withheld_refusal())
}

pub const PENDING_OBLIGATIONS_SQL: &str = "SELECT o.restriction_id FROM restriction_obligations o \
    WHERE o.org_id = $1 AND o.service_incarnation = $2 AND o.acked_at IS NULL ORDER BY o.restriction_id";

struct PendingObligations {
    org: Uuid,
    service: Uuid,
}

impl Read for PendingObligations {
    type Output = Vec<Uuid>;
    fn family(&self) -> &'static str {
        "strict"
    }
    fn verb(&self) -> &'static str {
        "obligations"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Vec<Uuid>, CmdError> {
        let rows = tx.exec("strict.pending_obligations", PENDING_OBLIGATIONS_SQL, &[Val::Uuid(self.org), Val::Uuid(self.service)]).await?;
        Ok(rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect())
    }
}

/// The read service's restriction consumer (C5 step 6): for every pending
/// obligation of `service`, revoke intersecting claims not yet emitting (the
/// coarse, correct org-wide match r7 C5 allows), wait for emitting ones,
/// then acknowledge. Returns the restrictions it made Effective.
pub async fn consume_restrictions<C: Connector>(ex: &Executor<C>, reg: &Arc<ClaimRegistry>, org: Uuid, service: Uuid) -> Result<Vec<Uuid>, ExecError> {
    let pending = ex.read(&PendingObligations { org, service }, org, None).await?;
    let mut effective = Vec::new();
    for id in pending {
        reg.restrict(&Restriction { id, org, principals: None }).await;
        if ex.ack_restriction(org, id, service).await? {
            effective.push(id);
        }
    }
    Ok(effective)
}

// ---------------------------------------------------------------- shared facts

pub const MEMBER_SQL: &str = "SELECT a.name, e.lifecycle, e.generation, e.halted, s.visibility, s.permission_mode, s.tools, t.parent_id \
    FROM agents a JOIN authority_epoch e ON e.org_id = a.org_id AND e.principal_id = a.principal_id \
    JOIN topology_edges t ON t.org_id = a.org_id AND t.principal_id = a.principal_id \
    LEFT JOIN scope_rows s ON s.org_id = a.org_id AND s.principal_id = a.principal_id \
    WHERE a.org_id = $1 AND a.principal_id = $2";
pub const PARENT_SQL: &str = "SELECT parent_id FROM topology_edges WHERE org_id = $1 AND principal_id = $2";
pub const CHILDREN_SQL: &str = "SELECT t.principal_id FROM topology_edges t JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2 AND ($3 OR e.lifecycle <> 'archived') ORDER BY t.ord, a.created_at, t.principal_id";
pub const ROOTS_SQL: &str = "SELECT t.principal_id FROM topology_edges t JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id IS NULL AND ($2 OR e.lifecycle <> 'archived') ORDER BY t.ord, a.created_at, t.principal_id";
pub const CLOCK_SQL: &str = "SELECT clock_timestamp()";

#[derive(Clone, Debug)]
pub struct Member {
    pub name: String,
    pub lifecycle: String,
    pub generation: i64,
    pub halted: bool,
    pub visibility: Option<String>,
    pub permission_mode: Option<String>,
    pub tools: Option<Value>,
    pub parent: Option<Uuid>,
}

pub async fn member<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, who: Uuid) -> Result<Option<Member>, CmdError> {
    let rows = tx.exec("strict.member", MEMBER_SQL, &[Val::Uuid(org), Val::Uuid(who)]).await?;
    Ok(rows.first().map(|r| Member {
        name: r.first().and_then(Val::as_text).unwrap_or("").to_string(),
        lifecycle: r.get(1).and_then(Val::as_text).unwrap_or("").to_string(),
        generation: r.get(2).and_then(Val::as_int).unwrap_or(-1),
        halted: r.get(3) == Some(&Val::Bool(true)),
        visibility: r.get(4).and_then(|v| v.as_text().map(str::to_string)),
        permission_mode: r.get(5).and_then(|v| v.as_text().map(str::to_string)),
        tools: r.get(6).and_then(Val::as_json).cloned(),
        parent: r.get(7).and_then(Val::as_uuid),
    }))
}

/// The caller's membership as a C5 read checks it: live, current generation,
/// not halted.
pub fn caller_ok(m: &Option<Member>, generation: i64) -> Result<Member, Refusal> {
    match m {
        Some(m) if m.lifecycle == "live" && m.generation == generation && !m.halted => Ok(m.clone()),
        Some(m) if m.halted => Err(Refusal::new("halted", "the caller is halted")),
        Some(m) if m.generation != generation && m.lifecycle == "live" => Err(Refusal::new("stale_generation", "the caller's session generation is not current")),
        _ => Err(Refusal::new("not_live", "the caller is not live")),
    }
}

fn uuids(rows: &Rows) -> Vec<Uuid> {
    rows.0.iter().filter_map(|r| r.first().and_then(Val::as_uuid)).collect()
}

/// Is `anc` a strict ancestor of `node`? An indexed walk upward (bounded by
/// the depth cap in the real schema; a cycle guard here).
async fn is_ancestor<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, anc: Uuid, node: Uuid) -> Result<bool, CmdError> {
    let mut cur = node;
    let mut seen = BTreeSet::from([node]);
    loop {
        let p = tx.exec("strict.parent", PARENT_SQL, &[Val::Uuid(org), Val::Uuid(cur)]).await?.first().and_then(|r| r.first()).and_then(Val::as_uuid);
        match p {
            Some(p) if p == anc => return Ok(true),
            Some(p) if seen.insert(p) => cur = p,
            _ => return Ok(false),
        }
    }
}

async fn descendants<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, root: Uuid, archived: bool, out: &mut Vec<Uuid>) -> Result<(), CmdError> {
    let kids = uuids(&tx.exec("strict.children", CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(root), Val::Bool(archived)]).await?);
    for k in kids {
        if !out.contains(&k) {
            out.push(k);
            Box::pin(descendants(tx, org, k, archived, out)).await?;
        }
    }
    Ok(())
}

/// The visible set (r7 §5.2 / legacy `_visible_ids`), in tree order. `Err`
/// names a node whose stored visibility is not recognized (D9).
pub async fn visible_ids<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, me: Uuid, m: &Member, archived: bool) -> Result<Result<(String, Vec<Uuid>), Refusal>, CmdError> {
    let raw = m.visibility.clone().unwrap_or_else(|| "full".into());
    let vis = match raw.as_str() {
        "self" | "team" | "subtree" | "full" => raw.clone(),
        _ if controls::fire(&tx.scope(), "Q-D6.unknown_widens") => "full".into(),
        _ => {
            return Ok(Err(Refusal::new(
                "unknown_visibility",
                format!("the stored visibility of {} ({raw:?}) is not recognized; it is never widened to full (D9)", m.name),
            )))
        }
    };
    let mut ids: Vec<Uuid> = match vis.as_str() {
        "self" => vec![me],
        "team" => {
            let mut v = vec![me];
            let sibs = match m.parent {
                Some(p) => uuids(&tx.exec("strict.children", CHILDREN_SQL, &[Val::Uuid(org), Val::Uuid(p), Val::Bool(archived)]).await?),
                None => uuids(&tx.exec("strict.roots", ROOTS_SQL, &[Val::Uuid(org), Val::Bool(archived)]).await?),
            };
            for s in sibs {
                if !v.contains(&s) {
                    v.push(s);
                }
            }
            v
        }
        "subtree" => {
            let mut v = vec![me];
            descendants(tx, org, me, archived, &mut v).await?;
            v
        }
        _ => {
            let mut v = Vec::new();
            for r in uuids(&tx.exec("strict.roots", ROOTS_SQL, &[Val::Uuid(org), Val::Bool(archived)]).await?) {
                v.push(r);
                descendants(tx, org, r, archived, &mut v).await?;
            }
            v
        }
    };
    if !archived {
        let mut live = Vec::new();
        for id in ids {
            let st = tx.exec("strict.lifecycle", "SELECT lifecycle FROM authority_epoch WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(id)]).await?;
            if st.first().and_then(|r| r.first()).and_then(Val::as_text) == Some("live") {
                live.push(id);
            }
        }
        ids = live;
    }
    Ok(Ok((vis, ids)))
}

// ---------------------------------------------------------------- node projection (diagnostic.inspect, preview)

pub const NODE_SQL: &str = "SELECT a.name, e.lifecycle, t.parent_id, e.generation, a.tier, coalesce(f.grant_centi, 0), \
    s.visibility, s.permission_mode, s.tools, st.last_status \
    FROM agents a JOIN authority_epoch e ON e.org_id = a.org_id AND e.principal_id = a.principal_id \
    JOIN topology_edges t ON t.org_id = a.org_id AND t.principal_id = a.principal_id \
    LEFT JOIN funding_edges f ON f.org_id = a.org_id AND f.child_id = a.principal_id \
    LEFT JOIN scope_rows s ON s.org_id = a.org_id AND s.principal_id = a.principal_id \
    LEFT JOIN status_rows st ON st.org_id = a.org_id AND st.principal_id = a.principal_id \
    WHERE a.org_id = $1 AND a.principal_id = $2";
pub const PRICES_SQL: &str = "SELECT p.tier, p.seat_centi FROM price_catalog p JOIN catalog_current c ON c.org_id = p.org_id AND c.catalog_version = p.catalog_version WHERE p.org_id = $1";
pub const KIDS_FUNDING_SQL: &str = "SELECT a.tier, coalesce(f.grant_centi, 0) FROM topology_edges t JOIN agents a ON a.org_id = t.org_id AND a.principal_id = t.principal_id \
    JOIN authority_epoch e ON e.org_id = t.org_id AND e.principal_id = t.principal_id \
    LEFT JOIN funding_edges f ON f.org_id = t.org_id AND f.child_id = t.principal_id \
    WHERE t.org_id = $1 AND t.parent_id = $2 AND e.lifecycle <> 'archived'";

fn py_credits(centi: i64) -> Value {
    if centi % 100 == 0 {
        json!(centi / 100)
    } else {
        json!(centi as f64 / 100.0)
    }
}

async fn prices<S: Session>(tx: &mut Tx<'_, S>, org: Uuid) -> Result<BTreeMap<String, i64>, CmdError> {
    let mut m = BTreeMap::new();
    for r in tx.exec("strict.prices", PRICES_SQL, &[Val::Uuid(org)]).await?.0 {
        if let (Some(t), Some(c)) = (r.first().and_then(Val::as_text), r.get(1).and_then(Val::as_int)) {
            m.insert(t.to_string(), c);
        }
    }
    Ok(m)
}

/// `free` exactly as legacy `Org.free`: grant minus the immediate
/// non-archived children's grants and seat prices.
async fn free_of<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, id: Uuid, grant: i64, prices: &BTreeMap<String, i64>) -> Result<i64, CmdError> {
    let mut used = 0;
    for r in tx.exec("strict.kids_funding", KIDS_FUNDING_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?.0 {
        let tier = r.first().and_then(Val::as_text).unwrap_or("");
        used += r.get(1).and_then(Val::as_int).unwrap_or(0) + prices.get(tier).copied().unwrap_or(0);
    }
    Ok(grant - used)
}

/// One node's allowlist projection (legacy `statepreview._safe_node`).
/// `with_free` = false: the funding facts are omitted (Q-D1's torn control
/// reads them in a second snapshot).
pub async fn project_node<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, id: Uuid, prices: &BTreeMap<String, i64>, with_free: bool) -> Result<Option<Value>, CmdError> {
    let rows = tx.exec("strict.node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(id)]).await?;
    let Some(r) = rows.first() else { return Ok(None) };
    let name = r.first().and_then(Val::as_text).unwrap_or("").to_string();
    let state = r.get(1).and_then(Val::as_text).unwrap_or("").to_string();
    let parent = r.get(2).and_then(Val::as_uuid);
    let parent_name = match parent {
        Some(p) => tx.exec("strict.parent_name", "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(p)]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)),
        None => None,
    };
    let tier = r.get(4).and_then(Val::as_text).unwrap_or("").to_string();
    let grant = r.get(5).and_then(Val::as_int).unwrap_or(0);
    let tools = r.get(8).and_then(Val::as_json).cloned().unwrap_or(json!({}));
    let seat = prices.get(&tier).copied();
    let free = if with_free && state == "live" { Some(free_of(tx, org, id, grant, prices).await?) } else { None };
    let last = r.get(9).and_then(Val::as_json).cloned();
    Ok(Some(json!({
        "id": name,
        "title": name,
        "state": state,
        "parent": parent_name,
        "generation": r.get(3).and_then(Val::as_int).unwrap_or(0),
        "model": tier,
        "grant": py_credits(grant),
        "seat_cost": seat.map(py_credits),
        "free": free.map(py_credits),
        "archived_at": Value::Null,
        "bearer_state": Value::Null,
        "account_binding": Value::Null,
        "scope": {
            "org_visibility": r.get(6).and_then(|v| v.as_text().map(str::to_string)),
            "permission_mode": r.get(7).and_then(|v| v.as_text().map(str::to_string)),
            "tools": {
                "bash": tools.get("bash").and_then(Value::as_bool).unwrap_or(true),
                "web": tools.get("web").and_then(Value::as_bool).unwrap_or(true),
                "edit": tools.get("edit").and_then(Value::as_bool).unwrap_or(true),
                "subagents": tools.get("subagents").and_then(Value::as_bool).unwrap_or(true),
            },
            "mcp": tools.get("mcp").cloned().unwrap_or(json!([])),
        },
        "frozen": Value::Null,
        "pending_switch": Value::Null,
        "last_status": last.map(|s| json!({"status": s.get("status"), "at": s.get("at")})),
        "mail_blocked": Value::Null,
    })))
}

/// Every node in tree order (the operator's full view).
pub async fn all_ids<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, archived: bool) -> Result<Vec<Uuid>, CmdError> {
    let mut v = Vec::new();
    for r in uuids(&tx.exec("strict.roots", ROOTS_SQL, &[Val::Uuid(org), Val::Bool(archived)]).await?) {
        v.push(r);
        descendants(tx, org, r, archived, &mut v).await?;
    }
    Ok(v)
}

/// The `diagnostic.inspect` answer for a set of ids (legacy `inspect_state`'s shape).
pub async fn project_set<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, actor: &str, vis: &str, ids: &[Uuid]) -> Result<Value, CmdError> {
    let prices = prices(tx, org).await?;
    let mut nodes = Vec::new();
    for id in ids {
        if let Some(n) = project_node(tx, org, *id, &prices, true).await? {
            nodes.push(n);
        }
    }
    Ok(json!({"actor": actor, "visibility": vis, "nodes": nodes}))
}

// ---------------------------------------------------------------- diagnostic.inspect

/// `orgtree_state_inspect {targets?, include_archived?}` (r7 §5.2).
pub struct Inspect {
    pub org: Uuid,
    pub me: Uuid,
    pub generation: i64,
    pub targets: Vec<Uuid>,
    pub include_archived: bool,
    /// Q-D1's torn control: project the rows without their funding facts
    /// (read in a second snapshot by [`inspect`]).
    pub skip_free: bool,
}

impl Read for Inspect {
    type Output = Result<Value, Refusal>;
    fn family(&self) -> &'static str {
        "diagnostic"
    }
    fn verb(&self) -> &'static str {
        "inspect"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let (org, me) = (self.org, self.me);
        let m = match caller_ok(&member(tx, org, me).await?, self.generation) {
            Ok(m) => m,
            Err(r) => return Ok(Err(r)),
        };
        if controls::fire(&tx.scope(), "Q-D5.whole_document") {
            // legacy's whole-document load: every retained history row too
            for sql in [
                "SELECT message_id FROM mail_sent WHERE org_id = $1",
                "SELECT seq FROM work_item_versions WHERE org_id = $1",
                "SELECT seq FROM transcript_entries WHERE org_id = $1",
                "SELECT reservation_id FROM resource_reservations WHERE org_id = $1",
            ] {
                tx.exec("strict.whole_document", sql, &[Val::Uuid(org)]).await?;
            }
        }
        let (vis, visible) = match visible_ids(tx, org, me, &m, self.include_archived).await? {
            Ok(x) => x,
            Err(r) => return Ok(Err(r)),
        };
        let ids = if self.targets.is_empty() {
            visible
        } else {
            if let Some(h) = self.targets.iter().find(|t| !visible.contains(t)) {
                let n = tx.exec("strict.parent_name", "SELECT name FROM agents WHERE org_id = $1 AND principal_id = $2", &[Val::Uuid(org), Val::Uuid(*h)]).await?;
                let n = n.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string)).unwrap_or_else(|| h.to_string());
                return Ok(Err(Refusal::new("outside_scope", format!("state inspection is outside your visible scope: {n}"))));
            }
            self.targets.clone()
        };
        let prices = prices(tx, org).await?;
        tx.pause("after_snapshot").await?;
        let mut nodes = Vec::new();
        for id in ids {
            if let Some(n) = project_node(tx, org, id, &prices, !self.skip_free).await? {
                nodes.push(n);
            }
        }
        Ok(Ok(json!({"actor": m.name, "visibility": vis, "nodes": nodes})))
    }
}

/// The funding facts of the named rows, in their own snapshot (Q-D1's torn
/// control only).
struct FreeOnly {
    org: Uuid,
    names: Vec<String>,
}

impl Read for FreeOnly {
    type Output = BTreeMap<String, (i64, Option<i64>)>;
    fn family(&self) -> &'static str {
        "diagnostic"
    }
    fn verb(&self) -> &'static str {
        "inspect_free"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let prices = prices(tx, self.org).await?;
        let mut out = BTreeMap::new();
        for n in &self.names {
            let r = tx
                .exec(
                    "strict.by_name",
                    "SELECT a.principal_id, coalesce(f.grant_centi, 0), e.lifecycle FROM agents a JOIN authority_epoch e ON e.org_id = a.org_id AND e.principal_id = a.principal_id \
                     LEFT JOIN funding_edges f ON f.org_id = a.org_id AND f.child_id = a.principal_id WHERE a.org_id = $1 AND a.name = $2",
                    &[Val::Uuid(self.org), Val::text(n.clone())],
                )
                .await?;
            if let Some(row) = r.first() {
                let id = row.first().and_then(Val::as_uuid).unwrap_or_default();
                let grant = row.get(1).and_then(Val::as_int).unwrap_or(0);
                let live = row.get(2).and_then(Val::as_text) == Some("live");
                let free = if live { Some(free_of(tx, self.org, id, grant, &prices).await?) } else { None };
                out.insert(n.clone(), (grant, free));
            }
        }
        Ok(out)
    }
}

/// `diagnostic.inspect` as a protected read: register, one snapshot, return
/// the claim with the answer (the caller emits through [`emit`]). Under
/// `Q-D1.two_snapshots` the grants and `free` come from a SECOND snapshot.
pub async fn inspect<C: Connector>(ex: &Executor<C>, reg: &Arc<ClaimRegistry>, mut q: Inspect) -> Result<(ClaimHandle, Result<Value, Refusal>), ExecError> {
    let h = register(reg, q.org, q.me, q.generation);
    let op = OpIdentity::minted(q.org, "", "none");
    let torn = controls::fire(&Scope { hooks: ex.hooks(), family: "diagnostic", verb: "inspect", op: Some(&op), op_tag: None, attempt: 1 }, "Q-D1.two_snapshots");
    q.skip_free = torn;
    let org = q.org;
    let mut v = ex.read(&q, org, None).await?;
    if torn {
        if let Ok(ans) = &mut v {
            let names: Vec<String> = ans["nodes"].as_array().map(|a| a.iter().filter_map(|n| n["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
            let facts = ex.read(&FreeOnly { org, names }, org, None).await?;
            for n in ans["nodes"].as_array_mut().into_iter().flatten() {
                // the rows (and their grants) from snapshot 1, `free` from snapshot 2
                if let Some((_g, f)) = n["id"].as_str().and_then(|k| facts.get(k)) {
                    n["free"] = f.map(py_credits).unwrap_or(Value::Null);
                }
            }
        }
    }
    Ok((h, v))
}

// ---------------------------------------------------------------- diagnostic.capabilities

/// The install-wide tool catalogue (process-local, deployment profile).
pub const TOOL_CATALOGUE: &[&str] = &[
    "orgtree_message", "orgtree_send_notice", "orgtree_status", "orgtree_chart", "orgtree_work", "orgtree_reservation",
    "orgtree_read_transcript", "orgtree_read_scratch", "orgtree_state_inspect", "orgtree_capabilities", "orgtree_preview",
    "orgtree_reallocate", "orgtree_request_credits",
];

/// `orgtree_capabilities` (r7 §5.3): the caller's own membership and scope
/// in one snapshot plus the catalogue; discloses nothing about others.
pub struct Capabilities {
    pub org: Uuid,
    pub me: Uuid,
    pub generation: i64,
}

impl Read for Capabilities {
    type Output = Result<Value, Refusal>;
    fn family(&self) -> &'static str {
        "diagnostic"
    }
    fn verb(&self) -> &'static str {
        "capabilities"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let m = match caller_ok(&member(tx, self.org, self.me).await?, self.generation) {
            Ok(m) => m,
            Err(r) => return Ok(Err(r)),
        };
        tx.pause("after_snapshot").await?;
        Ok(Ok(json!({
            "actor": m.name,
            "scope": {"org_visibility": m.visibility, "permission_mode": m.permission_mode, "tools": m.tools},
            "operations": TOOL_CATALOGUE,
        })))
    }
}

// ---------------------------------------------------------------- chart.read

pub const CHARTER_SQL: &str = "SELECT v.body FROM charter_heads h JOIN charter_versions v ON v.org_id = h.org_id AND v.principal_id = h.principal_id \
    AND v.charter_kind = h.charter_kind AND v.version = h.current_version WHERE h.org_id = $1 AND h.principal_id = $2 AND h.charter_kind = $3";
pub const OPEN_REQUEST_SQL: &str = "SELECT kind, legacy_id, payload FROM request_batches WHERE org_id = $1 AND asker_id = $2 AND state = 'pending' ORDER BY created_at LIMIT 1";
pub const USER_AUDIENCE_SQL: &str = "SELECT 1 FROM audience_grants WHERE org_id = $1 AND grantee_id = $2 AND target_kind = 'user'";

/// `orgtree_chart {include_archived?, include_standing_charter?}` (S3 §4.2):
/// the visible roster, the caller's own and inherited charters, and its
/// credits, all from ONE snapshot.
pub struct Chart {
    pub org: Uuid,
    pub me: Uuid,
    pub generation: i64,
    pub include_archived: bool,
    pub include_standing_charter: bool,
    /// Q-CH2's control: the roster only (credits read in a second snapshot).
    pub roster_only: bool,
    /// Q-CH2's control: the credits only.
    pub credits_only: bool,
}

async fn credits<S: Session>(tx: &mut Tx<'_, S>, org: Uuid, me: Uuid) -> Result<Value, CmdError> {
    let prices = prices(tx, org).await?;
    let r = tx.exec("strict.node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?;
    let tier = r.first().and_then(|r| r.get(4)).and_then(Val::as_text).unwrap_or("").to_string();
    let grant = r.first().and_then(|r| r.get(5)).and_then(Val::as_int).unwrap_or(0);
    let free = free_of(tx, org, me, grant, &prices).await?;
    Ok(json!({"seat_cost": prices.get(&tier).copied().map(py_credits), "grant": py_credits(grant), "free": py_credits(free)}))
}

impl Read for Chart {
    type Output = Result<Value, Refusal>;
    fn family(&self) -> &'static str {
        "chart"
    }
    fn verb(&self) -> &'static str {
        "read"
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let (org, me) = (self.org, self.me);
        let m = match caller_ok(&member(tx, org, me).await?, self.generation) {
            Ok(m) => m,
            Err(r) => return Ok(Err(r)),
        };
        if self.credits_only {
            return Ok(Ok(json!({"credits": credits(tx, org, me).await?})));
        }
        let (vis, ids) = match visible_ids(tx, org, me, &m, self.include_archived).await? {
            Ok(x) => x,
            Err(r) => return Ok(Err(r)),
        };
        let mut rows = Vec::new();
        for id in &ids {
            let r = tx.exec("strict.node", NODE_SQL, &[Val::Uuid(org), Val::Uuid(*id)]).await?;
            if let Some(r) = r.first() {
                let parent = r.get(2).and_then(Val::as_uuid);
                rows.push(json!({
                    "id": r.first().and_then(Val::as_text),
                    "principal": id.to_string(),
                    "parent": parent.map(|p| p.to_string()),
                    "state": r.get(1).and_then(Val::as_text),
                    "status": r.get(9).and_then(Val::as_json).and_then(|s| s.get("status").cloned()),
                    "grant": py_credits(r.get(5).and_then(Val::as_int).unwrap_or(0)),
                }));
            }
        }
        // the caller's own charter, and the team charters of its ancestors
        let own = tx.exec("strict.charter", CHARTER_SQL, &[Val::Uuid(org), Val::Uuid(me), Val::text("role")]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string));
        let mut inherited = Vec::new();
        if self.include_standing_charter {
            let mut cur = m.parent;
            let mut seen = BTreeSet::new();
            while let Some(p) = cur {
                if !seen.insert(p) {
                    break;
                }
                let body = tx.exec("strict.charter", CHARTER_SQL, &[Val::Uuid(org), Val::Uuid(p), Val::text("team")]).await?.first().and_then(|r| r.first()).and_then(|v| v.as_text().map(str::to_string));
                inherited.push(json!({"principal": p.to_string(), "team_charter": body}));
                cur = tx.exec("strict.parent", PARENT_SQL, &[Val::Uuid(org), Val::Uuid(p)]).await?.first().and_then(|r| r.first()).and_then(Val::as_uuid);
            }
        }
        let req = tx.exec("strict.open_request", OPEN_REQUEST_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?;
        let open_request = req.first().map(|r| json!({"kind": r.first().and_then(Val::as_text), "id": r.get(1).and_then(Val::as_text), "payload": r.get(2).and_then(Val::as_json)}));
        let user_audience = !tx.exec("strict.user_audience", USER_AUDIENCE_SQL, &[Val::Uuid(org), Val::Uuid(me)]).await?.is_empty();
        let credits = if self.roster_only { Value::Null } else { credits(tx, org, me).await? };
        tx.pause("after_snapshot").await?;
        Ok(Ok(json!({
            "actor": m.name,
            "visibility": vis,
            "rows": rows,
            "charter": own,
            "standing_charters": inherited,
            "credits": credits,
            "open_request": open_request,
            "user_audience": user_audience,
        })))
    }
}

/// `chart.read` as a protected read (register, one snapshot; under
/// `Q-CH2.separate_snapshots` the credits come from a second snapshot).
pub async fn chart<C: Connector>(ex: &Executor<C>, reg: &Arc<ClaimRegistry>, mut q: Chart) -> Result<(ClaimHandle, Result<Value, Refusal>), ExecError> {
    let h = register(reg, q.org, q.me, q.generation);
    let op = OpIdentity::minted(q.org, "", "none");
    let split = controls::fire(&Scope { hooks: ex.hooks(), family: "chart", verb: "read", op: Some(&op), op_tag: None, attempt: 1 }, "Q-CH2.separate_snapshots");
    q.roster_only = split;
    let org = q.org;
    let mut v = ex.read(&q, org, None).await?;
    if split {
        let c = Chart { org, me: q.me, generation: q.generation, include_archived: false, include_standing_charter: false, roster_only: false, credits_only: true };
        if let (Ok(ans), Ok(cr)) = (&mut v, ex.read(&c, org, None).await?) {
            ans["credits"] = cr["credits"].clone();
        }
    }
    Ok((h, v))
}

// ---------------------------------------------------------------- material.* (r7 §4)

pub const LISTINGS_SQL: &str = "SELECT w.item_id, w.name, w.title, w.owner_id, w.reviewer_id, w.status, w.created_at, \
    (w.owner_id = $2) AS holder, (w.reviewer_id = $2) AS reviewer, \
    EXISTS (SELECT 1 FROM work_participants p WHERE p.org_id = w.org_id AND p.item_id = w.item_id AND p.principal_id = $2) AS participant \
    FROM work_items w WHERE w.org_id = $1 AND w.archived_at IS NULL AND ( \
      w.owner_id = $2 OR w.reviewer_id = $2 OR w.item_id IN (SELECT p.item_id FROM work_participants p WHERE p.org_id = $1 AND p.principal_id = $2)) \
    ORDER BY w.created_at, w.item_id";
/// Q-M5's unsafe control: every active item in the organization is scanned
/// and filtered in memory (legacy's loop over `_work_active()`).
pub const ALL_ACTIVE_SQL: &str = "SELECT w.item_id, w.name, w.title, w.owner_id, w.reviewer_id, w.status, w.created_at, \
    (w.owner_id = $2) AS holder, (w.reviewer_id = $2) AS reviewer, \
    EXISTS (SELECT 1 FROM work_participants p WHERE p.org_id = w.org_id AND p.item_id = w.item_id AND p.principal_id = $2) AS participant \
    FROM work_items w WHERE w.org_id = $1 AND w.archived_at IS NULL ORDER BY w.created_at, w.item_id";
pub const ROSTER_SQL: &str = "SELECT seq, body, at FROM work_item_versions WHERE org_id = $1 AND item_id = $2 AND kind IN ('create', 'update') ORDER BY seq";
pub const TRANSCRIPT_SQL: &str = "SELECT seq, role, body, at FROM transcript_entries WHERE org_id = $1 AND principal_id = $2 ORDER BY seq DESC LIMIT $3";

/// What a material read returns from its snapshot.
#[derive(Clone, Debug)]
pub struct MaterialAnswer {
    pub access: Value,
    pub target_name: String,
    pub entries: Vec<Value>,
}

/// `orgtree_read_transcript {node, last}` / `orgtree_read_scratch {node}`
/// authorization (and the transcript's DB content) in one snapshot.
pub struct Material {
    pub org: Uuid,
    pub me: Uuid,
    pub generation: i64,
    pub target: Uuid,
    /// transcript entries to read (0 = none: a scratch read)
    pub last: i64,
}

struct Stretch {
    owner: Uuid,
    owner_name: Option<String>,
    from: i64,
}

fn roster(rows: &Rows) -> Vec<Stretch> {
    let mut out: Vec<Stretch> = Vec::new();
    for r in &rows.0 {
        let body = r.get(1).and_then(Val::as_json).cloned().unwrap_or(Value::Null);
        let Some(owner) = body.get("owner").and_then(Value::as_str).and_then(|s| s.parse::<Uuid>().ok()) else { continue };
        let at = r.get(2).and_then(Val::as_ts).unwrap_or(0);
        if out.last().map(|s| s.owner) != Some(owner) {
            out.push(Stretch { owner, owner_name: body.get("owner_name").and_then(Value::as_str).map(str::to_string), from: at });
        }
    }
    out
}

impl Read for Material {
    type Output = Result<MaterialAnswer, Refusal>;
    fn family(&self) -> &'static str {
        "material"
    }
    fn verb(&self) -> &'static str {
        if self.last > 0 {
            "transcript"
        } else {
            "scratch"
        }
    }
    async fn run<S: Session>(&self, tx: &mut Tx<'_, S>) -> Result<Self::Output, CmdError> {
        let (org, me, target) = (self.org, self.me, self.target);
        if let Err(r) = caller_ok(&member(tx, org, me).await?, self.generation) {
            return Ok(Err(r));
        }
        let Some(t) = member(tx, org, target).await? else { return Ok(Err(material_refusal(&target.to_string()))) };
        let access = if target == me {
            Some(json!({"via": "self"}))
        } else if is_ancestor(tx, org, me, target).await? {
            Some(json!({"via": "chart", "note": format!("{} is your descendant — the ordinary downward read (§7.6)", t.name)}))
        } else {
            self.item_route(tx, target, &t.name).await?
        };
        let Some(access) = access else { return Ok(Err(material_refusal(&t.name))) };
        let mut entries = Vec::new();
        if self.last > 0 {
            let rows = tx.exec("material.transcript", TRANSCRIPT_SQL, &[Val::Uuid(org), Val::Uuid(target), Val::Int(self.last.min(MAX_ENTRIES))]).await?;
            let mut total = 0usize;
            for r in rows.0.iter().rev() {
                let body: String = r.get(2).and_then(Val::as_text).unwrap_or("").chars().take(MAX_MESSAGE_CHARS).collect();
                total += body.chars().count();
                if total > MAX_TOTAL_CHARS {
                    break;
                }
                entries.push(json!({"seq": r.first().and_then(Val::as_int), "role": r.get(1).and_then(Val::as_text), "text": body}));
            }
        }
        tx.pause("after_snapshot").await?;
        Ok(Ok(MaterialAnswer { access, target_name: t.name, entries }))
    }
}

impl Material {
    /// Route 3, the shared item (r7 §4.2): the reader's own current listings
    /// on items not yet archived, in entry order; the first item whose
    /// holder roster has an EARLIER stretch of the target, and on which the
    /// target is not the current holder (D7), grants.
    async fn item_route<S: Session>(&self, tx: &mut Tx<'_, S>, target: Uuid, target_name: &str) -> Result<Option<Value>, CmdError> {
        let (org, me) = (self.org, self.me);
        let scan_all = controls::fire(&tx.scope(), "Q-M5.scan_all_items");
        let sql = if scan_all { ALL_ACTIVE_SQL } else { LISTINGS_SQL };
        let items = tx.exec("material.listings", sql, &[Val::Uuid(org), Val::Uuid(me)]).await?;
        let end_at_close = controls::fire(&tx.scope(), "Q-M4.end_at_close");
        let by_name = controls::fire(&tx.scope(), "Q-M2.match_by_name");
        let positional = controls::fire(&tx.scope(), "Q-M3.positional_last_row");
        for r in &items.0 {
            let listed = [7usize, 8, 9].iter().any(|i| r.get(*i) == Some(&Val::Bool(true)));
            if !listed {
                continue;
            }
            let item = r.first().and_then(Val::as_uuid).unwrap_or_default();
            let status = r.get(5).and_then(Val::as_text).unwrap_or("");
            if end_at_close && matches!(status, "done" | "dropped") {
                continue;
            }
            let current = r.get(3).and_then(Val::as_uuid);
            let stretches = roster(&tx.exec("material.roster", ROSTER_SQL, &[Val::Uuid(org), Val::Uuid(item)]).await?);
            let earlier: &[Stretch] = if stretches.is_empty() { &[] } else { &stretches[..stretches.len() - 1] };
            let matches = |s: &Stretch| if by_name { s.owner_name.as_deref() == Some(target_name) } else { s.owner == target };
            let hit = earlier.iter().rev().find(|s| matches(s));
            let Some(hit) = hit else { continue };
            if !positional && current == Some(target) {
                // D7: the item's current holder is never readable through it
                continue;
            }
            let standing = if r.get(7) == Some(&Val::Bool(true)) {
                "holder"
            } else if r.get(9) == Some(&Val::Bool(true)) {
                "participant"
            } else {
                "reviewer"
            };
            return Ok(Some(json!({
                "via": "item",
                "item": r.get(1).and_then(Val::as_text),
                "title": r.get(2).and_then(Val::as_text),
                "standing": standing,
                "held_from": crate::reservation::stamp(hit.from),
                "derived": false,
                "note": format!("{target_name} held this item before you; you are listed on it as its {standing}"),
            })));
        }
        Ok(None)
    }
}

/// `material.transcript` / `material.scratch` as a protected read. The
/// scratch folder's files are read AFTER the snapshot, outside SQL, within
/// legacy's bounds and under a realpath containment check of
/// `scratch_root/<target name>` (r7 §4.2 step 4).
pub async fn material<C: Connector>(ex: &Executor<C>, reg: &Arc<ClaimRegistry>, q: Material, scratch_root: Option<&std::path::Path>) -> Result<(ClaimHandle, Result<Value, Refusal>), ExecError> {
    let h = register(reg, q.org, q.me, q.generation);
    let org = q.org;
    let transcript = q.last > 0;
    let ans = match ex.read(&q, org, None).await? {
        Err(r) => return Ok((h, Err(r))),
        Ok(a) => a,
    };
    if transcript {
        return Ok((h, Ok(json!({"access": ans.access, "node": ans.target_name, "entries": ans.entries}))));
    }
    let files = match scratch_root {
        Some(root) => read_scratch(root, &ans.target_name),
        None => Vec::new(),
    };
    Ok((h, Ok(json!({"access": ans.access, "node": ans.target_name, "files": files}))))
}

/// Bounded scratch listing with legacy's containment rule: a path is read
/// only if its canonical form stays inside the canonical folder.
pub fn read_scratch(root: &std::path::Path, name: &str) -> Vec<Value> {
    let Ok(base) = std::fs::canonicalize(root.join(name)) else { return Vec::new() };
    let mut out = Vec::new();
    let mut total = 0usize;
    let Ok(rd) = std::fs::read_dir(&base) else { return out };
    let mut names: Vec<std::path::PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    names.sort();
    for p in names.into_iter().take(MAX_ENTRIES as usize) {
        let Ok(real) = std::fs::canonicalize(&p) else { continue };
        if !real.starts_with(&base) || !real.is_file() {
            continue;
        }
        let text: String = std::fs::read_to_string(&real).unwrap_or_default().chars().take(MAX_MESSAGE_CHARS).collect();
        total += text.chars().count();
        if total > MAX_TOTAL_CHARS {
            break;
        }
        out.push(json!({"file": p.file_name().map(|s| s.to_string_lossy().to_string()), "text": text}));
    }
    out
}

// ---------------------------------------------------------------- the cold-read identity mint (Q-M7)

pub static MATERIAL_MINT: Family = Family { name: "material", isolation: Isolation::ReadCommitted, retry_unique: &["transcript_identities_seat"] };
pub const MINT_READ_SQL: &str = "SELECT transcript_id FROM transcript_identities WHERE org_id = $1 AND principal_id = $2";
pub const MINT_INSERT_SQL: &str = "INSERT INTO transcript_identities (org_id, principal_id, transcript_id, minted_at) VALUES ($1, $2, $3, clock_timestamp()) ON CONFLICT DO NOTHING";

/// A cold transcript read's identity mint: an idempotent upsert keyed by the
/// seat, in its own short transaction, then read back (r7 §4.2 "Side
/// writes"). Never inside the authority snapshot, never an org-wide lock.
pub struct MintTranscriptIdentity {
    pub target: Uuid,
    pub candidate: Uuid,
}

impl Command for MintTranscriptIdentity {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &MATERIAL_MINT
    }
    fn verb(&self) -> &'static str {
        "mint"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let key = [Val::Uuid(org), Val::Uuid(self.target)];
        let existing = tx.exec("material.mint_read", MINT_READ_SQL, &key).await?;
        if let Some(id) = existing.first().and_then(|r| r.first()).and_then(Val::as_uuid) {
            return Ok(Decided::Applied(json!({"transcript_id": id.to_string(), "minted": false})));
        }
        tx.pause("before_mint").await?;
        // Q-M7's control records a run whose harness dropped the seat key.
        let _ = controls::fire(&tx.scope(), "Q-M7.mint_without_key");
        tx.exec("material.mint_insert", MINT_INSERT_SQL, &[Val::Uuid(org), Val::Uuid(self.target), Val::Uuid(self.candidate)]).await?;
        let back = tx.exec("material.mint_read", MINT_READ_SQL, &key).await?;
        let id = back.first().and_then(|r| r.first()).and_then(Val::as_uuid).ok_or_else(|| CmdError::Defect("minted identity not visible".into()))?;
        Ok(Decided::Applied(json!({"transcript_id": id.to_string(), "minted": id == self.candidate})))
    }
}

// ---------------------------------------------------------------- DOC_LOCK emulation for the "org-wide lock" controls

pub static READ_UNDER_LOCK: Family = Family { name: "strict.locked", isolation: Isolation::ReadCommitted, retry_unique: &[] };

/// Q-M6 / Q-D4: legacy's reads under an organization-wide lock. The read runs
/// as a READ COMMITTED command holding the organization row `FOR UPDATE`
/// (the `DOC_LOCK` stand-in) while it reads; any writer that inserts a row
/// referencing the organization (its foreign-key check takes `FOR KEY
/// SHARE` on that row) then waits for the read.
pub struct OrgLockedRead {
    pub control: &'static str,
}

impl Command for OrgLockedRead {
    type Output = Value;
    fn family(&self) -> &'static Family {
        &READ_UNDER_LOCK
    }
    fn verb(&self) -> &'static str {
        "read"
    }
    async fn anchor<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding) -> Result<(), CmdError> {
        Ok(())
    }
    async fn may_disclose<S: Session>(&self, _tx: &mut Tx<'_, S>, _b: &Binding, _o: &Value) -> Result<bool, CmdError> {
        Ok(true)
    }
    async fn execute<S: Session>(&self, tx: &mut Tx<'_, S>, b: &Binding) -> Result<Decided<Value>, CmdError> {
        let org = b.op.org;
        let _ = controls::fire(&tx.scope(), self.control);
        tx.exec("strict.org_lock", "SELECT 1 FROM organizations WHERE org_id = $1 FOR UPDATE", &[Val::Uuid(org)]).await?;
        let n = tx.exec("strict.locked_read", "SELECT count(*) FROM agents WHERE org_id = $1", &[Val::Uuid(org)]).await?;
        tx.pause("after_snapshot").await?;
        Ok(Decided::Applied(json!({"agents": n.first().and_then(|r| r.first()).and_then(Val::as_int)})))
    }
}

/// DECLARED-CONTACTS for the strict reads.
pub fn declared() -> Value {
    let base = json!({
        "agents": {"modes": ["read"], "required": true},
        "authority_epoch": {"modes": ["read"], "required": true},
        "topology_edges": {"modes": ["read"], "required": true},
        "scope_rows": {"modes": ["read"], "required": true}
    });
    let with = |extra: Value| {
        let mut m = base.clone();
        for (k, v) in extra.as_object().unwrap() {
            m[k] = v.clone();
        }
        m
    };
    json!({
        "diagnostic.inspect": {"relations": with(json!({
            "funding_edges": {"modes": ["read"], "required": false},
            "status_rows": {"modes": ["read"], "required": false},
            "price_catalog": {"modes": ["read"], "required": true},
            "catalog_current": {"modes": ["read"], "required": true}
        })), "p01_contract": "diagnostic.inspect", "source": "r7 §5.2: one snapshot, no locks"},
        "diagnostic.capabilities": {"relations": with(json!({})), "p01_contract": "diagnostic.capabilities", "source": "r7 §5.3"},
        "chart.read": {"relations": with(json!({
            "funding_edges": {"modes": ["read"], "required": true},
            "status_rows": {"modes": ["read"], "required": false},
            "price_catalog": {"modes": ["read"], "required": true},
            "catalog_current": {"modes": ["read"], "required": true},
            "charter_heads": {"modes": ["read"], "required": false},
            "charter_versions": {"modes": ["read"], "required": false},
            "request_batches": {"modes": ["read"], "required": true},
            "audience_grants": {"modes": ["read"], "required": true}
        })), "p01_contract": "chart.read", "source": "S3 §4.2: one snapshot, no locks"},
        "material.transcript": {"relations": with(json!({
            "work_items": {"modes": ["read"], "required": false},
            "work_participants": {"modes": ["read"], "required": false},
            "work_item_versions": {"modes": ["read"], "required": false},
            "transcript_entries": {"modes": ["read"], "required": false}
        })), "p01_contract": "material.transcript", "source": "r7 §4.2"},
        "material.scratch": {"relations": with(json!({
            "work_items": {"modes": ["read"], "required": false},
            "work_participants": {"modes": ["read"], "required": false},
            "work_item_versions": {"modes": ["read"], "required": false}
        })), "p01_contract": "material.scratch", "source": "r7 §4.2 (files read after the snapshot)"},
        "material.mint": {"relations": {
            "transcript_identities": {"modes": ["read", "write"], "required": true},
            "operation_receipts": {"modes": ["read", "write"], "required": true}
        }, "p01_contract": null, "source": "r7 §4.2 side write: own short transaction, keyed upsert"}
    })
}

