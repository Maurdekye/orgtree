//! The user's persistent undo history (docs/rust-engine/undo-history.md):
//! one entry per user gesture (move, hire, retire, retool), undone and
//! redone through the same operations and checks as the forward action
//! (`Actor::User`). An entry keeps only typed facts (numeric agent ids,
//! positions, configured field values); a conflict refuses that entry and
//! leaves the next older one as the target (refuse-then-older).
//!
//! Lock order: the org's history head, then the org row, then agent rows.
//! Guards compare only the facts an entry touched, never a whole row.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Map, Value};
use tokio_postgres::{GenericClient, Transaction};

use crate::domain::ops::{self, Actor, Effects};
use crate::domain::scope;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::refuse;

/// Entries kept per org, all states counted (coordinator 2026-10-14).
pub const BOUND: i64 = 100;
/// Steps in one gesture.
pub const MAX_STEPS: usize = 100;
/// Members of one retired team an entry records; a larger retire is not recorded.
const MAX_MEMBERS: usize = 2000;
const LABEL_MAX: usize = 120;
const REQUEST_MAX: usize = 64;

const MOVE_OPS: &[&str] = &["move", "moves", "reorder", "promote", "demote"];
const RETOOL_OPS: &[&str] = &["retool", "switch_model", "account", "scope"];
/// The `/ops` operations a user request records.
pub const RECORDED_OPS: &[&str] = &["move", "moves", "reorder", "promote", "demote", "hire", "retire", "retool", "switch_model", "account"];
/// The agent's own configured settings a retool entry restores.
const SCOPE_FIELDS: &[&str] = &["add_dirs", "tools", "org_visibility", "permission_mode", "effort", "model_version", "account_fallback", "auto_cheap_compact", "session"];
/// Step fields that may name an earlier step's agent (`"$0.node"`).
const REF_FIELDS: &[&str] = &["node", "target", "parent", "new_parent", "above", "before", "after"];
/// Org settings a user grant may raise (folders by the scope save; all four
/// by a retool reaching the top level).
const ORG_KEYS: &[&str] = &["dirs", "default_tools", "default_visibility", "permission_mode"];
/// Request metadata, never passed on to an operation.
const META: &[&str] = &["history_label", "request_id"];

/// A refusal with a machine-readable code (`gesture_mixed`, `history_moved`, …).
#[derive(Debug)]
pub struct Coded {
    pub status: u16,
    pub code: &'static str,
    pub detail: String,
    pub extra: Value,
}

impl std::fmt::Display for Coded {
    #[nolog]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for Coded {}

#[nolog]
fn coded(status: u16, code: &'static str, detail: impl Into<String>, extra: Value) -> anyhow::Error {
    anyhow::Error::new(Coded { status, code, detail: detail.into(), extra })
}

/// Undo or redo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Undo,
    Redo,
}

// ------------------------------------------------------------ requests

/// The metadata a recording request may carry: its label and idempotence key.
#[logged]
pub fn meta(b: &Value) -> Result<(Option<String>, Option<String>)> {
    let label = match b.get("history_label") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Some(_) => refuse!(BadRequest, "history_label must be a string"),
    };
    if label.as_ref().is_some_and(|l| l.chars().count() > LABEL_MAX) {
        refuse!(BadRequest, "history_label is at most {LABEL_MAX} characters");
    }
    let request = match b.get("request_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= REQUEST_MAX => Some(s.clone()),
        Some(_) => refuse!(BadRequest, "request_id is a string of 1 to {REQUEST_MAX} characters"),
    };
    Ok((label, request))
}

/// A step body without request metadata.
#[nolog]
fn strip(step: &Value) -> Value {
    let mut s = step.clone();
    if let Some(o) = s.as_object_mut() {
        for k in META {
            o.remove(*k);
        }
    }
    s
}

#[nolog]
fn op_of(step: &Value) -> &str {
    step["op"].as_str().unwrap_or("")
}

/// The gesture's kind, or 400 `gesture_mixed`.
#[logged]
pub fn kind_of(steps: &[Value]) -> Result<&'static str> {
    let ops: Vec<&str> = steps.iter().map(op_of).collect();
    for op in &ops {
        if !(MOVE_OPS.contains(op) || RETOOL_OPS.contains(op) || matches!(*op, "hire" | "retire")) {
            return Err(coded(400, "gesture_op", format!("{op:?} is not an undoable step (move, moves, reorder, hire, retire, retool, switch_model, account, scope)"), Value::Null));
        }
    }
    let all = |set: &[&str]| ops.iter().all(|op| set.contains(op));
    let kind = if ops.contains(&"hire") {
        ops.iter().all(|op| *op == "hire" || MOVE_OPS.contains(op)).then_some("hire")
    } else if ops.contains(&"retire") {
        all(&["retire"]).then_some("retire")
    } else if all(MOVE_OPS) {
        Some("move")
    } else if all(RETOOL_OPS) {
        Some("retool")
    } else {
        None
    };
    kind.ok_or_else(|| coded(400, "gesture_mixed", "one gesture is one kind: hires with their placement, retires, moves, or settings changes", Value::Null))
}

/// `"$<i>.node"` → Some(i).
#[nolog]
fn ref_index(v: &Value) -> Option<Result<usize, ()>> {
    let s = v.as_str()?.strip_prefix('$')?;
    Some(s.strip_suffix(".node").and_then(|i| i.parse::<usize>().ok()).ok_or(()))
}

/// Every back-reference names an earlier step.
#[logged]
fn check_refs(steps: &[Value]) -> Result<()> {
    for (i, step) in steps.iter().enumerate() {
        let mut values: Vec<&Value> = REF_FIELDS.iter().filter_map(|k| step.get(*k)).collect();
        for m in step["moves"].as_array().into_iter().flatten() {
            values.extend(["node", "new_parent"].iter().filter_map(|k| m.get(*k)));
        }
        for v in values {
            match ref_index(v) {
                None => {}
                Some(Ok(j)) if j < i => {}
                Some(_) => return Err(coded(400, "gesture_ref", format!("step {i}: {} must name an earlier step as \"$<index>.node\"", v), Value::Null)),
            }
        }
    }
    Ok(())
}

/// Replace back-references with the earlier steps' agents.
#[nolog]
fn resolve(step: &Value, results: &[Value]) -> Result<Value> {
    let mut s = strip(step);
    let sub = |v: &mut Value| -> Result<()> {
        if let Some(Ok(j)) = ref_index(v) {
            match results.get(j).and_then(|r| r["node"].as_str()) {
                Some(name) => *v = json!(name),
                None => return Err(coded(400, "gesture_ref", format!("step {j} answered no agent to refer to"), Value::Null)),
            }
        }
        Ok(())
    };
    for k in REF_FIELDS {
        if let Some(v) = s.get_mut(*k) {
            sub(v)?;
        }
    }
    if let Some(moves) = s.get_mut("moves").and_then(Value::as_array_mut) {
        for m in moves {
            for k in ["node", "new_parent"] {
                if let Some(v) = m.get_mut(k) {
                    sub(v)?;
                }
            }
        }
    }
    Ok(s)
}

/// The agents a step places or tunes, by the names it gives (not references).
#[nolog]
fn named(step: &Value) -> Vec<String> {
    let lit = |v: &Value| v.as_str().filter(|s| !s.starts_with('$')).map(|s| s.trim().trim_start_matches('@').to_string());
    let mut out = Vec::new();
    match op_of(step) {
        "moves" => {
            for m in step["moves"].as_array().into_iter().flatten() {
                out.extend(lit(&m["node"]));
            }
        }
        "hire" => out.extend(lit(&step["above"])),
        _ => out.extend(lit(&step["node"])),
    }
    out.retain(|n| !n.is_empty() && n != "user");
    out
}

// ------------------------------------------------------------ facts

/// Where an agent stands: parent, stored order, state, live neighbours.
#[derive(Debug, Clone, PartialEq)]
struct Place {
    parent: Option<i64>,
    order: f64,
    state: String,
    prev: Option<i64>,
    next: Option<i64>,
}

#[nolog]
fn place_json(p: &Place) -> Value {
    json!({ "parent": p.parent, "order": p.order, "prev": p.prev, "next": p.next })
}

#[logged]
async fn place(tx: &Transaction<'_>, org: i64, id: i64) -> Result<Option<Place>> {
    let Some(r) = tx.query_opt("SELECT parent_id, sibling_order, state FROM ot.agents WHERE id = $1 AND org_id = $2", &[&id, &org]).await? else {
        return Ok(None);
    };
    let parent: Option<i64> = r.get(0);
    let order: f64 = r.get(1);
    let state: String = r.get(2);
    let (mut prev, mut next) = (None, None);
    if state == "live" {
        prev = tx.query_opt(
            "SELECT id FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live' AND id <> $3
               AND (sibling_order, id) < ($4, $3) ORDER BY sibling_order DESC, id DESC LIMIT 1",
            &[&org, &parent, &id, &order]).await?.map(|r| r.get(0));
        next = tx.query_opt(
            "SELECT id FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live' AND id <> $3
               AND (sibling_order, id) > ($4, $3) ORDER BY sibling_order, id LIMIT 1",
            &[&org, &parent, &id, &order]).await?.map(|r| r.get(0));
    }
    Ok(Some(Place { parent, order, state, prev, next }))
}

#[logged]
async fn id_of(tx: &Transaction<'_>, org: i64, name: &str) -> Result<Option<i64>> {
    Ok(tx.query_opt("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&org, &name]).await?.map(|r| r.get(0)))
}

/// An agent's current name and state.
#[logged]
async fn who(tx: &Transaction<'_>, org: i64, id: i64) -> Result<(String, String)> {
    match tx.query_opt("SELECT name, state FROM ot.agents WHERE id = $1 AND org_id = $2", &[&id, &org]).await? {
        Some(r) => Ok((r.get(0), r.get(1))),
        None => refuse!(Conflict, "an agent of this entry no longer exists"),
    }
}

/// The name a placement step gives a parent: `user` for the top level.
#[logged]
async fn parent_name(tx: &Transaction<'_>, org: i64, parent: Option<i64>) -> Result<String> {
    let Some(p) = parent else { return Ok("user".into()) };
    let (name, state) = who(tx, org, p).await?;
    if state != "live" {
        refuse!(Conflict, "{name} is no longer live");
    }
    Ok(name)
}

#[nolog]
fn absent() -> Value {
    json!({ "absent": true })
}

#[nolog]
fn is_absent(v: &Value) -> bool {
    v.is_null() || *v == absent()
}

/// An account choice as stored: `primary`, `default` and empty are none.
#[nolog]
fn account_value(v: Option<&str>) -> Value {
    match v.map(str::trim) {
        None | Some("" | "primary" | "default") => absent(),
        Some(a) if a.ends_with("/primary") => absent(),
        Some(a) => json!(a),
    }
}

/// The agent's configured settings as a retool entry sees them; a queued
/// switch or account counts as configured.
#[nolog]
async fn retool_facts(tx: &Transaction<'_>, org: i64, id: i64) -> Result<Option<Map<String, Value>>> {
    let Some(r) = tx.query_opt(
        "SELECT scope, charter, team_charter, tier, account, pending_switch, pending_account FROM ot.agents WHERE id = $1 AND org_id = $2",
        &[&id, &org]).await? else { return Ok(None) };
    let sc = scope::normalize(&r.get::<_, Value>(0));
    let mut out = Map::new();
    for k in SCOPE_FIELDS {
        out.insert((*k).into(), sc.get(*k).filter(|v| !v.is_null()).cloned().unwrap_or_else(absent));
    }
    for (i, k) in [(1usize, "charter"), (2usize, "team_charter")] {
        let v: Option<String> = r.get(i);
        out.insert(k.into(), v.filter(|s| !s.is_empty()).map(Value::String).unwrap_or_else(absent));
    }
    let tier: String = r.get(3);
    let account: Option<String> = r.get(4);
    let switch: Option<Value> = r.get(5);
    let queued: Option<Value> = r.get(6);
    out.insert("tier".into(), json!(switch.as_ref().and_then(|s| s["tier"].as_str()).unwrap_or(&tier)));
    let acc = match (&queued, &switch) {
        (Some(q), _) => account_value(q["account"].as_str()),
        (None, Some(s)) if s["account"].as_str().is_some_and(|a| !a.is_empty()) => account_value(s["account"].as_str()),
        _ => account_value(account.as_deref()),
    };
    out.insert("account".into(), acc);
    Ok(Some(out))
}

/// A live team under `root` (root excluded), top-down, siblings in order.
#[logged]
async fn live_team(tx: &Transaction<'_>, root: i64) -> Result<Vec<(i64, i64, f64)>> {
    let rows = tx.query(
        "WITH RECURSIVE down(id, parent_id, sibling_order, depth) AS (
             SELECT id, parent_id, sibling_order, 1 FROM ot.agents WHERE parent_id = $1 AND state = 'live'
           UNION ALL
             SELECT c.id, c.parent_id, c.sibling_order, d.depth + 1 FROM ot.agents c JOIN down d ON c.parent_id = d.id
              WHERE c.state = 'live' AND d.depth < 1024)
         SELECT id, parent_id, sibling_order FROM down ORDER BY depth, parent_id, sibling_order, id",
        &[&root]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect())
}

#[nolog]
fn same_order(a: f64, b: &Value) -> bool {
    b.as_f64().is_some_and(|b| (a - b).abs() < 1e-9)
}

#[nolog]
fn opt_id(v: &Value) -> Option<i64> {
    v.as_i64()
}

/// The agents a retool of `ids` can raise or clamp besides themselves: their
/// ancestors and everything beneath them (deleted rows excluded).
#[logged]
async fn around(tx: &Transaction<'_>, ids: &[i64]) -> Result<Vec<i64>> {
    let rows = tx.query(
        "WITH RECURSIVE up(id, parent_id, d) AS (
             SELECT id, parent_id, 0 FROM ot.agents WHERE id = ANY($1)
           UNION ALL
             SELECT a.id, a.parent_id, u.d + 1 FROM ot.agents a JOIN up u ON a.id = u.parent_id WHERE u.d < 1024),
         down(id, d) AS (
             SELECT id, 0 FROM ot.agents WHERE id = ANY($1)
           UNION ALL
             SELECT c.id, w.d + 1 FROM ot.agents c JOIN down w ON c.parent_id = w.id WHERE c.state <> 'deleted' AND w.d < 1024)
         SELECT DISTINCT x.id FROM (SELECT id FROM up UNION SELECT id FROM down) x
           JOIN ot.agents a ON a.id = x.id
          WHERE a.state <> 'deleted' AND NOT (x.id = ANY($1)) ORDER BY x.id",
        &[&ids]).await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Stored scopes, locked, in id order.
#[nolog]
async fn scopes(tx: &Transaction<'_>, ids: &[i64]) -> Result<Vec<(i64, Value)>> {
    let rows = tx.query("SELECT id, scope FROM ot.agents WHERE id = ANY($1) ORDER BY id FOR UPDATE", &[&ids]).await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

/// The org settings a grant may raise, as stored (absent marked).
#[nolog]
async fn org_keys(tx: &Transaction<'_>, org: i64) -> Result<Map<String, Value>> {
    let settings: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org]).await?.get(0);
    Ok(ORG_KEYS.iter().map(|k| ((*k).to_string(), settings.get(*k).cloned().unwrap_or_else(absent))).collect())
}

/// What a retool did to other rows: `{scopes: [{agent, before, after}], org: {key: {before, after}}}`.
#[nolog]
fn side_diff(before: &[(i64, Value)], after: &[(i64, Value)], org_before: &Map<String, Value>, org_after: &Map<String, Value>) -> Value {
    let mut sc = Vec::new();
    for (id, b) in before {
        if let Some((_, a)) = after.iter().find(|(x, _)| x == id) {
            if a != b {
                sc.push(json!({ "agent": id, "before": b, "after": a }));
            }
        }
    }
    let mut o = Map::new();
    for (k, b) in org_before {
        let a = org_after.get(k).cloned().unwrap_or_else(absent);
        if a != *b {
            o.insert(k.clone(), json!({ "before": b, "after": a }));
        }
    }
    json!({ "scopes": sc, "org": o })
}

// ------------------------------------------------------------ the head

/// The org's history head: created on first use, locked for the transaction.
#[logged]
async fn lock_head(tx: &Transaction<'_>, org: i64) -> Result<()> {
    tx.execute("INSERT INTO ot.undo_heads (org_id) VALUES ($1) ON CONFLICT DO NOTHING", &[&org]).await?;
    tx.query_one("SELECT rev FROM ot.undo_heads WHERE org_id = $1 FOR UPDATE", &[&org]).await?;
    // the org row before any agent row, as every settings writer takes it
    tx.query_one("SELECT id FROM ot.orgs WHERE id = $1 FOR NO KEY UPDATE", &[&org]).await?;
    Ok(())
}

#[logged]
async fn bump(tx: &Transaction<'_>, org: i64) -> Result<()> {
    tx.execute("UPDATE ot.undo_heads SET rev = rev + 1 WHERE org_id = $1", &[&org]).await?;
    Ok(())
}

// ------------------------------------------------------------ reading

#[nolog]
fn at(r: &tokio_postgres::Row, i: usize) -> Value {
    json!(r.get::<_, chrono::DateTime<chrono::Utc>>(i).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Whether undoing this hire entry must ask first, and what it would say:
/// (agent name, turns started) of the first hired agent that has run.
#[nolog]
async fn worked<C: GenericClient + Sync>(client: &C, org: i64, data: &Value) -> Result<Option<(String, i64, String)>> {
    let mut ids = Vec::new();
    let mut total = 0i64;
    let mut first: Option<(String, i64)> = None;
    for h in data["hires"].as_array().into_iter().flatten() {
        let Some(id) = opt_id(&h["agent"]) else { continue };
        let turns: i64 = client.query_one("SELECT count(*) FROM ot.turns WHERE agent_id = $1", &[&id]).await?.get(0);
        ids.push(format!("{id}x{turns}"));
        total += turns;
        if turns > 0 && first.is_none() {
            let name: Option<String> = client.query_opt("SELECT name FROM ot.agents WHERE id = $1 AND org_id = $2", &[&id, &org]).await?.map(|r| r.get(0));
            first = Some((name.unwrap_or_default(), turns));
        }
    }
    Ok(first.map(|(name, turns)| (name, total.max(turns), ids.join("."))))
}

#[nolog]
async fn target<C: GenericClient + Sync>(client: &C, org: i64, dir: Dir) -> Result<Option<Value>> {
    let sql = match dir {
        Dir::Undo => "SELECT id, kind, label, created_at, data FROM ot.undo_entries WHERE org_id = $1 AND state = 'done' ORDER BY id DESC LIMIT 1",
        Dir::Redo => "SELECT id, kind, label, created_at, data FROM ot.undo_entries WHERE org_id = $1 AND state = 'undone' ORDER BY id LIMIT 1",
    };
    let Some(r) = client.query_opt(sql, &[&org]).await? else { return Ok(None) };
    let kind: String = r.get(1);
    let mut out = json!({ "id": r.get::<_, i64>(0), "kind": kind, "label": r.get::<_, String>(2), "at": at(&r, 3) });
    if dir == Dir::Undo {
        let confirm = kind == "hire" && worked(client, org, &r.get::<_, Value>(4)).await?.is_some();
        out["confirm_required"] = json!(confirm);
    }
    Ok(Some(out))
}

/// The feed's `undo_history`: the revision and both targets.
#[logged]
pub async fn head<C: GenericClient + Sync>(client: &C, org: i64) -> Result<Value> {
    let rev: i64 = client.query_opt("SELECT rev FROM ot.undo_heads WHERE org_id = $1", &[&org]).await?.map(|r| r.get(0)).unwrap_or(0);
    Ok(json!({ "rev": rev, "undo": target(client, org, Dir::Undo).await?, "redo": target(client, org, Dir::Redo).await? }))
}

/// `GET …/undo-history`: the head and the entries, newest first.
#[logged]
pub async fn history<C: GenericClient + Sync>(client: &C, org: i64) -> Result<Value> {
    let mut out = head(client, org).await?;
    let rows = client.query(
        "SELECT id, kind, label, state, created_at, reason FROM ot.undo_entries WHERE org_id = $1 ORDER BY id DESC LIMIT $2",
        &[&org, &BOUND]).await?;
    let entries: Vec<Value> = rows.iter().map(|r| {
        let mut e = json!({ "id": r.get::<_, i64>(0), "kind": r.get::<_, String>(1), "label": r.get::<_, String>(2),
                            "state": r.get::<_, String>(3), "at": at(r, 4) });
        if let Some(reason) = r.get::<_, Option<String>>(5) {
            e["reason"] = json!(reason);
        }
        e
    }).collect();
    out["bound"] = json!(BOUND);
    out["entries"] = json!(entries);
    out.as_object_mut().unwrap().remove("rev");
    Ok(out)
}

#[logged]
async fn history_now(engine: &Engine, org: i64) -> Result<Value> {
    let client = engine.db.get().await?;
    history(&**client, org).await
}

// ------------------------------------------------------------ recording

/// What a gesture's steps leave to publish after commit.
#[derive(Default)]
struct Pending {
    ops: Vec<(usize, Effects)>,
    scopes: Vec<(usize, crate::http::nodes::ScopeEffects)>,
    /// agents whose scope an inverse wrote back directly
    rescoped: Vec<i64>,
    /// the org's settings were written back directly
    org_settings: bool,
    /// A Logo inverse uses the same feed/publication path as an explicit edit.
    logo: bool,
}

#[logged]
async fn publish(engine: &Arc<Engine>, org: &Arc<OrgHandle>, pending: Pending, results: &mut [Value]) {
    if pending.logo {
        crate::profile_pictures::published(engine, org.id);
        tracing::info!(org=org.id, action="restore", "organization Logo changed by undo/redo");
    }
    for (i, fx) in pending.ops {
        ops::finish(engine, org, fx, &mut results[i]).await;
    }
    for (i, sfx) in pending.scopes {
        results[i] = crate::http::nodes::apply_scope_effects(engine, org, sfx).await;
    }
    let mut ch: Vec<crate::changes::Change> = pending.rescoped.iter().map(|id| crate::changes::Change::Agent(*id)).collect();
    if pending.org_settings {
        ch.push(crate::changes::Change::Org);
    }
    if !ch.is_empty() {
        crate::changes::notify(engine, org, ch);
    }
    // their effective scope changed: the running CLIs pick it up
    for id in &pending.rescoped {
        if let Some(h) = engine.agents.get(*id) {
            h.send(crate::runtime::AgentMsg::Reconfigured);
        }
    }
}

#[logged]
fn changed(engine: &Engine, org: &OrgHandle) {
    crate::changes::notify(engine, org, vec![crate::changes::Change::UndoHistory]);
}

/// Run a user gesture: every step in one serializable transaction, recorded
/// as one entry. A single user route is a gesture of one step.
#[logged]
pub async fn gesture(engine: &Arc<Engine>, org: &Arc<OrgHandle>, steps: &[Value], label: Option<String>, request: Option<String>) -> Result<Value> {
    if steps.is_empty() {
        refuse!(BadRequest, "steps is a list of 1 to {MAX_STEPS} operations");
    }
    if steps.len() > MAX_STEPS {
        return Err(coded(400, "gesture_too_large", format!("at most {MAX_STEPS} steps per gesture (got {})", steps.len()), Value::Null));
    }
    if steps.iter().any(|s| !s.is_object()) {
        refuse!(BadRequest, "each step is an operation object");
    }
    let kind = kind_of(steps)?;
    check_refs(steps)?;
    for step in steps {
        if op_of(step) == "scope" {
            if let Some(node) = step["node"].as_str().filter(|n| !n.starts_with('$')) {
                crate::http::nodes::prepare_user_scope(engine, org, node, step).await?;
            }
        } else {
            ops::prepare(engine, org, step).await?;
        }
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        match gesture_once(engine, org, steps, kind, label.as_deref(), request.as_deref()).await {
            Ok((mut out, pending, recorded)) => {
                let mut results: Vec<Value> = out["results"].as_array().cloned().unwrap_or_default();
                publish(engine, org, pending, &mut results).await;
                out["results"] = json!(results);
                if recorded {
                    changed(engine, org);
                }
                return Ok(out);
            }
            Err(e) if attempt < 4 && ops::retryable(&e) => {
                tracing::warn!(attempt, "gesture conflicted with another write; retrying");
                tokio::time::sleep(std::time::Duration::from_millis(20 * attempt as u64)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[logged]
async fn duplicate(tx: &Transaction<'_>, org: i64, request: &str) -> Result<Option<Value>> {
    let Some(r) = tx.query_opt("SELECT id, kind, label, data FROM ot.undo_entries WHERE org_id = $1 AND request_id = $2", &[&org, &request]).await? else {
        return Ok(None);
    };
    let data: Value = r.get(3);
    let mut results = Vec::new();
    for s in data["steps"].as_array().into_iter().flatten() {
        let node = match opt_id(s) {
            Some(id) => tx.query_opt("SELECT name FROM ot.agents WHERE id = $1 AND org_id = $2", &[&id, &org]).await?.map(|r| r.get::<_, String>(0)),
            None => None,
        };
        results.push(json!({ "node": node }));
    }
    Ok(Some(json!({
        "duplicate": true,
        "history_entry": { "id": r.get::<_, i64>(0), "kind": r.get::<_, String>(1), "label": r.get::<_, String>(2) },
        "results": results,
    })))
}

#[allow(clippy::type_complexity)]
#[logged]
async fn gesture_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, steps: &[Value], kind: &str, label: Option<&str>, request: Option<&str>)
    -> Result<(Value, Pending, bool)> {
    let mut client = engine.db.get().await?;
    let tx = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::Serializable).start().await?;
    lock_head(&tx, org.id).await?;
    if let Some(rid) = request {
        if let Some(out) = duplicate(&tx, org.id, rid).await? {
            tx.commit().await?;
            return Ok((out, Pending::default(), false));
        }
    }
    // the facts before: every agent a step names (a newborn has none)
    let mut before: Vec<(i64, Place)> = Vec::new();
    let mut retool_before: Vec<(i64, Map<String, Value>)> = Vec::new();
    let mut teams: Vec<(i64, Place, Vec<(i64, i64, f64)>)> = Vec::new();
    for step in steps {
        for name in named(step) {
            let Some(id) = id_of(&tx, org.id, &name).await? else { continue };
            if kind == "retool" {
                if !retool_before.iter().any(|(x, _)| *x == id) {
                    if let Some(f) = retool_facts(&tx, org.id, id).await? { retool_before.push((id, f)); }
                }
            } else if kind == "retire" {
                if !teams.iter().any(|(x, _, _)| *x == id) {
                    if let Some(p) = place(&tx, org.id, id).await? {
                        let team = if p.state == "live" { live_team(&tx, id).await? } else { Vec::new() };
                        teams.push((id, p, team));
                    }
                }
            } else if !before.iter().any(|(x, _)| *x == id) {
                if let Some(p) = place(&tx, org.id, id).await? { before.push((id, p)); }
            }
        }
    }
    // a retool also raises ancestors and the org's grants and clamps the
    // agents beneath: their stored values before, to restore exactly
    let mains: Vec<i64> = retool_before.iter().map(|(id, _)| *id).collect();
    // the agents' own stored scopes too, so a restore is exact, not only field-equal
    let side_ids = if kind == "retool" {
        let mut ids = around(&tx, &mains).await?;
        ids.extend(&mains);
        ids.sort_unstable();
        ids
    } else { Vec::new() };
    let side_before = scopes(&tx, &side_ids).await?;
    let org_before = if kind == "retool" { Some(org_keys(&tx, org.id).await?) } else { None };
    let mut results: Vec<Value> = Vec::new();
    let mut pending = Pending::default();
    let mut step_agents: Vec<Option<i64>> = Vec::new();
    let mut hired: Vec<i64> = Vec::new();
    for (i, raw) in steps.iter().enumerate() {
        let step = resolve(raw, &results)?;
        if op_of(&step) == "scope" {
            let node = step["node"].as_str().unwrap_or("").trim().to_string();
            let mut body = step.clone();
            if let Some(o) = body.as_object_mut() {
                o.remove("op");
                o.remove("node");
            }
            let sfx = crate::http::nodes::apply_user_scope_in_tx(engine, org, &tx, &node, &body, None).await?;
            results.push(json!({ "node": node }));
            pending.scopes.push((i, sfx));
        } else {
            let mut fx = Effects::default();
            let out = ops::run_in_tx(engine, org, &tx, &Actor::User, &step, &mut fx).await?;
            results.push(out);
            pending.ops.push((i, fx));
        }
        let node = results[i]["node"].as_str().map(str::to_string)
            .or_else(|| step["node"].as_str().map(str::to_string));
        let id = match node { Some(n) => id_of(&tx, org.id, &n).await?, None => None };
        if op_of(&step) == "hire" {
            if let Some(id) = id { hired.push(id); }
        }
        step_agents.push(id);
    }
    // the facts after, and the entry's typed data
    let mut data = match kind {
        "move" | "hire" => {
            let mut moved = Vec::new();
            for (id, b) in &before {
                if hired.contains(id) { continue; }
                let Some(a) = place(&tx, org.id, *id).await? else { continue };
                // the same parent, rank and state is no move (a live agent's
                // rank is its neighbours; an archived one's its stored order)
                let same_rank = if a.state == "live" { a.prev == b.prev && a.next == b.next } else { (a.order - b.order).abs() < 1e-9 };
                if a.parent == b.parent && a.state == b.state && same_rank { continue; }
                moved.push(json!({ "agent": id, "live": a.state == "live", "before": place_json(b), "after": place_json(&a) }));
            }
            if kind == "move" {
                if moved.is_empty() { None } else { Some(json!({ "moved": moved })) }
            } else {
                let mut hires = Vec::new();
                for id in &hired {
                    if let Some(a) = place(&tx, org.id, *id).await? {
                        hires.push(json!({ "agent": id, "after": place_json(&a) }));
                    }
                }
                if hires.is_empty() { None } else { Some(json!({ "hires": hires, "moved": moved })) }
            }
        }
        "retire" => {
            let mut retires = Vec::new();
            let mut too_large = false;
            // a team retired inside another retired team is that one's (in step order)
            let mut claimed: HashSet<i64> = HashSet::new();
            for (root, b, team) in &teams {
                if b.state != "live" || claimed.contains(root) { continue; }
                let Some(a) = place(&tx, org.id, *root).await? else { continue };
                if a.state != "archived" { continue; }
                claimed.insert(*root);
                let mut members = Vec::new();
                for (id, parent, order) in team {
                    if claimed.contains(id) { continue; }
                    let state: Option<String> = tx.query_opt("SELECT state FROM ot.agents WHERE id = $1", &[id]).await?.map(|r| r.get(0));
                    if state.as_deref() == Some("archived") {
                        claimed.insert(*id);
                        members.push(json!({ "agent": id, "parent": parent, "order": order }));
                    }
                }
                too_large |= members.len() > MAX_MEMBERS;
                retires.push(json!({ "root": root, "before": place_json(b), "members": members }));
            }
            if retires.is_empty() {
                None
            } else if too_large {
                // recorded, so Ctrl+Z never silently skips it, but refused when reached
                // (coordinator 2026-10-14 19:07Z)
                let n: usize = retires.iter().map(|r| 1 + r["members"].as_array().map_or(0, Vec::len)).sum();
                for r in &mut retires { r["members"] = json!([]); }
                Some(json!({ "retires": retires, "team": true,
                             "not_undoable": format!("this retire is too large to undo ({n} agents; at most {MAX_MEMBERS} per team)") }))
            } else {
                Some(json!({ "retires": retires }))
            }
        }
        _ => {
            let mut agents = Vec::new();
            for (id, b) in &retool_before {
                let Some(a) = retool_facts(&tx, org.id, *id).await? else { continue };
                let mut fields = Map::new();
                for (k, bv) in b {
                    let av = a.get(k).cloned().unwrap_or_else(absent);
                    if av != *bv {
                        fields.insert(k.clone(), json!({ "before": bv, "after": av }));
                    }
                }
                if !fields.is_empty() {
                    agents.push(json!({ "agent": id, "fields": fields }));
                }
            }
            let side_after = scopes(&tx, &side_ids).await?;
            let org_after = org_keys(&tx, org.id).await?;
            let side = side_diff(&side_before, &side_after, org_before.as_ref().unwrap_or(&Map::new()), &org_after);
            let side_changed = side["scopes"].as_array().is_some_and(|a| !a.is_empty())
                || side["org"].as_object().is_some_and(|o| !o.is_empty());
            if agents.is_empty() && !side_changed { None } else { Some(json!({ "agents": agents, "side": side })) }
        }
    };
    let mut out = json!({ "results": results, "history_entry": Value::Null });
    let recorded = if let Some(data) = data.as_mut() {
        data["steps"] = json!(step_agents);
        let label = match label {
            Some(l) => l.to_string(),
            None => default_label(&tx, org.id, kind, data).await?,
        };
        let label: String = label.chars().take(LABEL_MAX).collect();
        // a new action clears redo, and the oldest beyond the bound go
        tx.execute("DELETE FROM ot.undo_entries WHERE org_id = $1 AND state = 'undone'", &[&org.id]).await?;
        let id: i64 = tx.query_one(
            "INSERT INTO ot.undo_entries (org_id, kind, label, request_id, data) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            &[&org.id, &kind, &label, &request, &*data]).await?.get(0);
        tx.execute(
            "DELETE FROM ot.undo_entries WHERE org_id = $1 AND id NOT IN
               (SELECT id FROM ot.undo_entries WHERE org_id = $1 ORDER BY id DESC LIMIT $2)",
            &[&org.id, &BOUND]).await?;
        bump(&tx, org.id).await?;
        out["history_entry"] = json!({ "id": id, "kind": kind, "label": label });
        true
    } else { false };
    tx.commit().await?;
    Ok((out, pending, recorded))
}

#[nolog]
async fn default_label(tx: &Transaction<'_>, org: i64, kind: &str, data: &Value) -> Result<String> {
    let name = |v: &Value| {
        let id = opt_id(v);
        async move {
            match id {
                Some(id) => who(tx, org, id).await.map(|(n, _)| n).unwrap_or_default(),
                None => String::new(),
            }
        }
    };
    Ok(match kind {
        "hire" => {
            let hires = data["hires"].as_array().cloned().unwrap_or_default();
            match hires.len() {
                1 => format!("Hire {}", name(&hires[0]["agent"]).await),
                n => format!("Hire {n} agents"),
            }
        }
        "retire" => {
            let r = data["retires"].as_array().cloned().unwrap_or_default();
            match r.len() {
                1 => {
                    let team = r[0]["members"].as_array().map_or(0, Vec::len) + usize::from(data["team"] == true);
                    let root = name(&r[0]["root"]).await;
                    if team > 0 { format!("Retire {root} and its team") } else { format!("Retire {root}") }
                }
                n => format!("Retire {n} agents"),
            }
        }
        "move" => {
            let moved = data["moved"].as_array().cloned().unwrap_or_default();
            if moved.len() == 1 {
                let m = &moved[0];
                let agent = name(&m["agent"]).await;
                if m["before"]["parent"] == m["after"]["parent"] {
                    format!("Reorder {agent}")
                } else {
                    match opt_id(&m["after"]["parent"]) {
                        Some(_) => format!("Move {agent} under {}", name(&m["after"]["parent"]).await),
                        None => format!("Move {agent} to the top level"),
                    }
                }
            } else {
                format!("Move {} agents", moved.len())
            }
        }
        _ => {
            let agents = data["agents"].as_array().cloned().unwrap_or_default();
            match agents.len() {
                1 => format!("Settings: {}", name(&agents[0]["agent"]).await),
                n => format!("Settings of {n} agents"),
            }
        }
    })
}

// ------------------------------------------------------------ undo and redo

/// The user explicitly made agent Logo changes undoable (2026-10-15).
/// No payload-bearing argument or journal data may enter automatic tracing.
#[nolog]
pub(crate) async fn logo(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&crate::runtime::Caller,
    generation:i32,record:crate::profile_pictures::wire::PictureRecord,source:Option<(&str,&std::path::Path)>)->Result<Value> {
    record.decoded()?;
    let mut attempt=0;
    let out=loop {
        attempt+=1;
        match logo_once(engine,org,caller,generation,&record,source).await {
            Ok(out)=>break out,
            Err(e) if attempt<4 && ops::retryable(&e)=>{
                tokio::time::sleep(std::time::Duration::from_millis(20*attempt)).await;
            }
            Err(e)=>return Err(e),
        }
    };
    crate::profile_pictures::published(engine,org.id);
    changed(engine,org);
    tracing::info!(org=org.id,agent=caller.agent_id,name=%caller.name,
        action=if record.data.is_some(){"set"}else{"remove"},entry=out["history_entry"]["id"].as_i64(),
        "organization Logo changed");
    Ok(out)
}

#[nolog]
async fn logo_once(engine:&Arc<Engine>,org:&Arc<OrgHandle>,caller:&crate::runtime::Caller,
    generation:i32,record:&crate::profile_pictures::wire::PictureRecord,source:Option<(&str,&std::path::Path)>)->Result<Value> {
    let mut client=engine.db.get().await?;
    // All picture/scope writers serialize on the org row. Read committed
    // deliberately sees a scope change that committed while lock_head waited.
    let tx=client.transaction().await?;
    lock_head(&tx,org.id).await?;
    let live=tx.query_opt("SELECT name,generation FROM ot.agents WHERE id=$1 AND org_id=$2 AND state='live'",&[&caller.agent_id,&org.id]).await?;
    if caller.org_id!=org.id || live.as_ref().is_none_or(|r|r.get::<_,String>(0)!=caller.name || r.get::<_,i32>(1)!=generation) {
        refuse!(Forbidden,"the calling agent changed or is no longer live in this organization");
    }
    if !crate::domain::tool_groups::allows(&crate::tools::caller_tools_in(&*tx,caller).await?,"orgtree_org_logo") {
        refuse!(Forbidden,"orgtree_org_logo is disabled by your Orgtree tool group scope");
    }
    if let Some((raw,path))=source {
        let presenter=crate::domain::docs::presenter_in(engine,org,caller.agent_id,&*tx).await?;
        if crate::domain::docs::readable(&presenter,raw)?!=path {
            refuse!(Forbidden,"Logo source changed while it was being read; retry the edit");
        }
    }
    let before=crate::profile_pictures::load_in(&*tx,org.id).await?;
    let after=crate::profile_pictures::save_in(&tx,org.id,record.clone(),true).await?;
    let label=format!("{} Logo: {}",if after.data.is_some(){"Set"}else{"Remove"},caller.name);
    let label:String=label.chars().take(LABEL_MAX).collect();
    let data=json!({"agent":caller.agent_id,"generation":generation,"before":before,"after":after});
    tx.execute("DELETE FROM ot.undo_entries WHERE org_id=$1 AND state='undone'",&[&org.id]).await?;
    let id:i64=tx.query_one("INSERT INTO ot.undo_entries(org_id,kind,label,data) VALUES($1,'logo',$2,$3) RETURNING id",&[&org.id,&label,&data]).await?.get(0);
    tx.execute("DELETE FROM ot.undo_entries WHERE org_id=$1 AND id NOT IN (SELECT id FROM ot.undo_entries WHERE org_id=$1 ORDER BY id DESC LIMIT $2)",&[&org.id,&BOUND]).await?;
    bump(&tx,org.id).await?;
    tx.commit().await?;
    Ok(json!({"revision":after.meta.revision,"sha256":after.meta.sha256,"width":after.meta.width,
        "height":after.meta.height,"bytes":after.meta.bytes,"removed":after.data.is_none(),
        "history_entry":{"id":id,"kind":"logo","label":label}}))
}

/// A history replay is a new explicit revision, never a replay of old wire
/// bytes/revision. Rebind snapshots of that exact restored revision in older
/// and redoable entries so several consecutive Logo undos/redos remain valid.
/// An unrelated UI or remote edit has a different revision and cannot pass.
#[nolog]
async fn apply_logo(org:&Arc<OrgHandle>,tx:&Transaction<'_>,dir:Dir,data:&Value,pending:&mut Pending)->Result<Value> {
    use crate::profile_pictures::{self as pictures,wire::PictureRecord};
    let (from,to)=sides(dir);
    let expected:Option<PictureRecord>=serde_json::from_value(data[from].clone())?;
    let current=pictures::load_in(tx,org.id).await?;
    if current!=expected { refuse!(Conflict,"the organization Logo was changed again since this entry"); }
    let destination:Option<PictureRecord>=serde_json::from_value(data[to].clone())?;
    let original=destination.as_ref().map(|p|p.meta.revision.clone());
    let desired=destination.unwrap_or_else(||PictureRecord::removed(String::new()));
    let mut desired=desired;
    // An initially absent record restores to a versioned removal.
    desired.meta.revision=pictures::wire::next_revision(current.as_ref().map(|p|&p.meta))?;
    let restored=pictures::save_in(tx,org.id,desired,false).await?;
    if let Some(original)=original {
        for side in ["before","after"] {
            tx.execute("UPDATE ot.undo_entries SET data=jsonb_set(data,ARRAY[$2::text,'revision'],to_jsonb($4::text))
                WHERE org_id=$1 AND kind='logo' AND state IN ('done','undone') AND data->$2->>'revision'=$3",
                &[&org.id,&side,&original,&restored.meta.revision]).await?;
        }
    }
    let mut next=data.clone();
    next[to]=serde_json::to_value(&restored)?;
    pending.logo=true;
    Ok(next)
}

/// `POST …/undo-history/undo|redo {id, confirm?}`.
#[logged]
pub async fn step(engine: &Arc<Engine>, org: &Arc<OrgHandle>, dir: Dir, id: i64, confirm: Option<&str>) -> Result<Value> {
    // what the inverse places is read before the transaction, as the forward op does
    let mut switches = Vec::new();
    {
        let client = engine.db.get().await?;
        let row = client.query_opt("SELECT kind, data FROM ot.undo_entries WHERE id = $1 AND org_id = $2", &[&id, &org.id]).await?;
        let side = if dir == Dir::Undo { "before" } else { "after" };
        if let Some(r) = row.filter(|r| r.get::<_, String>(0) == "retool") {
            let data: Value = r.get(1);
            for a in data["agents"].as_array().into_iter().flatten() {
                let Some(tier) = a["fields"]["tier"][side].as_str() else { continue };
                let name = client.query_opt("SELECT name FROM ot.agents WHERE id = $1", &[&a["agent"].as_i64()]).await?;
                if let Some(name) = name.map(|r| r.get::<_, String>(0)) {
                    switches.push(json!({ "op": "switch_model", "node": name, "tier": tier }));
                }
            }
        }
    }
    for req in &switches {
        ops::prepare(engine, org, req).await?;
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        match step_once(engine, org, dir, id, confirm).await {
            Ok((mut out, pending)) => {
                if let Some(mut pending) = pending {
                    // an inverse's answers are not returned: one slot per applied op
                    let base = pending.ops.len();
                    for (n, (i, _)) in pending.scopes.iter_mut().enumerate() { *i = base + n; }
                    let mut results = vec![json!({}); base + pending.scopes.len()];
                    publish(engine, org, pending, &mut results).await;
                    changed(engine, org);
                }
                out["history"] = history_now(engine, org.id).await?;
                return Ok(out);
            }
            Err(e) if attempt < 4 && ops::retryable(&e) => {
                tracing::warn!(attempt, "undo conflicted with another write; retrying");
                tokio::time::sleep(std::time::Duration::from_millis(20 * attempt as u64)).await;
            }
            Err(e) => {
                if let Some(c) = e.downcast_ref::<Coded>() {
                    if c.code.starts_with("history_") {
                        let mut extra = c.extra.clone();
                        extra["history"] = history_now(engine, org.id).await?;
                        if c.code == "history_conflict" {
                            changed(engine, org);
                        }
                        return Err(coded(c.status, c.code, c.detail.clone(), extra));
                    }
                }
                return Err(e);
            }
        }
    }
}

/// Why a step request no longer names the target: `history_moved` when another entry is the target or
/// the requested entry still exists (another window consumed it), `history_empty` otherwise.
#[nolog]
fn stale(current: Option<i64>, id: i64, known: bool) -> Option<&'static str> {
    match current {
        Some(t) if t == id => None,
        Some(_) => Some("history_moved"),
        None if known => Some("history_moved"),
        None => Some("history_empty"),
    }
}

#[logged]
async fn step_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, dir: Dir, id: i64, confirm: Option<&str>) -> Result<(Value, Option<Pending>)> {
    let mut client = engine.db.get().await?;
    let tx = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::Serializable).start().await?;
    lock_head(&tx, org.id).await?;
    let current = target(&*tx, org.id, dir).await?.and_then(|t| t["id"].as_i64());
    // A second window stepping the entry another window just consumed gets history_moved even
    // when that was the last one, so only an id this org never had (or one trimmed away) is empty.
    let known = current.is_none() && tx.query_opt("SELECT 1 FROM ot.undo_entries WHERE org_id = $1 AND id = $2", &[&org.id, &id]).await?.is_some();
    if let Some(code) = stale(current, id, known) {
        return Err(match code {
            "history_empty" => coded(404, code, if dir == Dir::Undo { "nothing to undo" } else { "nothing to redo" }, json!({})),
            _ => coded(409, code, "the history changed; this is no longer the entry to step", json!({})),
        });
    }
    let r = tx.query_one("SELECT kind, label, data FROM ot.undo_entries WHERE id = $1", &[&id]).await?;
    let kind: String = r.get(0);
    let label: String = r.get(1);
    let data: Value = r.get(2);
    if dir == Dir::Undo && kind == "hire" {
        if let Some((agent, turns, binding)) = worked(&*tx, org.id, &data).await? {
            let token = format!("h{id}.{binding}");
            if confirm != Some(token.as_str()) {
                return Ok((json!({ "status": "confirm", "id": id, "label": label, "agent": agent, "turns": turns, "confirm": token }), None));
            }
        }
    }
    tx.batch_execute("SAVEPOINT undo_apply").await?;
    let mut pending = Pending::default();
    let applied = match kind.as_str() {
        "move" => apply_move(engine, org, &tx, dir, &data, &mut pending).await,
        "hire" => apply_hire(engine, org, &tx, dir, &data, &mut pending).await,
        "retire" => apply_retire(engine, org, &tx, dir, &data, &mut pending).await,
        "logo" => apply_logo(org, &tx, dir, &data, &mut pending).await,
        _ => apply_retool(engine, org, &tx, dir, &data, &mut pending).await,
    };
    match applied {
        Ok(next) => {
            let state = if dir == Dir::Undo { "undone" } else { "done" };
            tx.execute("UPDATE ot.undo_entries SET state = $2, data = $3, changed_at = now() WHERE id = $1", &[&id, &state, &next]).await?;
            bump(&tx, org.id).await?;
            tx.commit().await?;
            let status = if dir == Dir::Undo { "undone" } else { "redone" };
            Ok((json!({ "status": status, "id": id, "label": label }), Some(pending)))
        }
        Err(e) if ops::retryable(&e) => Err(e),
        Err(e) => {
            let Some(u) = e.downcast_ref::<crate::domain::UserError>() else { return Err(e) };
            let reason: String = u.to_string().chars().take(500).collect();
            tx.batch_execute("ROLLBACK TO SAVEPOINT undo_apply").await?;
            tx.execute("UPDATE ot.undo_entries SET state = 'refused', reason = $2, changed_at = now() WHERE id = $1", &[&id, &reason]).await?;
            bump(&tx, org.id).await?;
            tx.commit().await?;
            Err(coded(409, "history_conflict", reason.clone(), json!({ "id": id, "label": label, "reason": reason })))
        }
    }
}

/// One forward operation as the user, its effects kept for after commit.
#[logged]
async fn run(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, req: Value, pending: &mut Pending) -> Result<Value> {
    let mut fx = Effects::default();
    let out = ops::run_in_tx(engine, org, tx, &Actor::User, &req, &mut fx).await?;
    pending.ops.push((pending.ops.len(), fx));
    Ok(out)
}

/// Put a live agent back in its recorded slot among its live siblings: after
/// its recorded previous sibling, else before its recorded next one. A
/// recorded neighbour that is no longer a live sibling there refuses (no
/// nearest-slot fallback).
#[logged]
async fn reslot(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, id: i64, slot: &Value, pending: &mut Pending) -> Result<()> {
    let (name, _) = who(tx, org.id, id).await?;
    let parent = opt_id(&slot["parent"]);
    let req = if let Some(p) = opt_id(&slot["prev"]) {
        let beside = neighbour(tx, org.id, p, parent, &name).await?;
        json!({ "op": "reorder", "node": name, "after": beside })
    } else if let Some(n) = opt_id(&slot["next"]) {
        let beside = neighbour(tx, org.id, n, parent, &name).await?;
        json!({ "op": "reorder", "node": name, "before": beside })
    } else {
        json!({ "op": "reorder", "node": name, "index": 0 })
    };
    run(engine, org, tx, req, pending).await?;
    Ok(())
}

/// A recorded neighbour's name, while it is still a live sibling under `parent`.
#[logged]
async fn neighbour(tx: &Transaction<'_>, org: i64, id: i64, parent: Option<i64>, name: &str) -> Result<String> {
    let r = tx.query_opt("SELECT name, parent_id, state FROM ot.agents WHERE id = $1 AND org_id = $2", &[&id, &org]).await?;
    match r {
        Some(r) if r.get::<_, Option<i64>>(1) == parent && r.get::<_, String>(2) == "live" => Ok(r.get(0)),
        _ => refuse!(Conflict, "the place {name} had no longer exists (a neighbour it stood beside was moved or retired)"),
    }
}

/// Check that each moved agent stands where the entry left it (`from`).
#[nolog]
async fn guard_moved(tx: &Transaction<'_>, org: i64, moved: &[Value], from: &str) -> Result<()> {
    for m in moved {
        let Some(id) = opt_id(&m["agent"]) else { continue };
        let (name, state) = who(tx, org, id).await?;
        let Some(p) = place(tx, org, id).await? else { refuse!(Conflict, "{name} no longer exists") };
        if state == "deleted" { refuse!(Conflict, "{name} was deleted"); }
        if (state == "live") != (m["live"] == true) {
            refuse!(Conflict, "{name} was {} since", if state == "live" { "rehired" } else { "retired" });
        }
        if p.parent != opt_id(&m[from]["parent"]) { refuse!(Conflict, "{name} was moved again since"); }
        if !same_order(p.order, &m[from]["order"]) { refuse!(Conflict, "{name} was reordered since"); }
    }
    Ok(())
}

/// Move each agent to its `to` parent (latest first).
#[nolog]
async fn reparent(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, moved: &[Value], from: &str, to: &str, pending: &mut Pending) -> Result<()> {
    for m in moved.iter().rev() {
        let Some(id) = opt_id(&m["agent"]) else { continue };
        if m[from]["parent"] == m[to]["parent"] { continue; }
        let (name, _) = who(tx, org.id, id).await?;
        let parent = parent_name(tx, org.id, opt_id(&m[to]["parent"])).await?;
        run(engine, org, tx, json!({ "op": "move", "node": name, "new_parent": parent }), pending).await?;
    }
    Ok(())
}

/// Put each agent in its `to` slot (in that side's order) and return the
/// list with the orders that now stand.
#[nolog]
async fn reslot_all(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, moved: &[Value], to: &str, pending: &mut Pending) -> Result<Vec<Value>> {
    let mut idx: Vec<usize> = (0..moved.len()).collect();
    idx.sort_by(|a, b| moved[*a][to]["order"].as_f64().unwrap_or(0.0).total_cmp(&moved[*b][to]["order"].as_f64().unwrap_or(0.0)));
    for i in idx {
        let m = &moved[i];
        let Some(id) = opt_id(&m["agent"]) else { continue };
        if m["live"] == true {
            reslot(engine, org, tx, id, &m[to], pending).await?;
        } else {
            let order = m[to]["order"].as_f64().unwrap_or(0.0);
            tx.execute("UPDATE ot.agents SET sibling_order = $2, row_version = row_version + 1 WHERE id = $1", &[&id, &order]).await?;
        }
    }
    let mut out = Vec::new();
    for m in moved {
        let mut m = m.clone();
        if let Some(id) = opt_id(&m["agent"]) {
            if let Some(p) = place(tx, org.id, id).await? {
                m[to]["order"] = json!(p.order);
            }
        }
        out.push(m);
    }
    Ok(out)
}

#[nolog]
fn sides(dir: Dir) -> (&'static str, &'static str) {
    match dir {
        Dir::Undo => ("after", "before"),
        Dir::Redo => ("before", "after"),
    }
}

#[nolog]
async fn apply_move(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, dir: Dir, data: &Value, pending: &mut Pending) -> Result<Value> {
    let (from, to) = sides(dir);
    let moved = data["moved"].as_array().cloned().unwrap_or_default();
    guard_moved(tx, org.id, &moved, from).await?;
    reparent(engine, org, tx, &moved, from, to, pending).await?;
    let moved = reslot_all(engine, org, tx, &moved, to, pending).await?;
    let mut next = data.clone();
    next["moved"] = json!(moved);
    Ok(next)
}

#[nolog]
async fn apply_hire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, dir: Dir, data: &Value, pending: &mut Pending) -> Result<Value> {
    let (from, to) = sides(dir);
    let hires = data["hires"].as_array().cloned().unwrap_or_default();
    let moved = data["moved"].as_array().cloned().unwrap_or_default();
    let mut next = data.clone();
    for h in &hires {
        let Some(id) = opt_id(&h["agent"]) else { continue };
        let (name, state) = who(tx, org.id, id).await?;
        let parent: Option<i64> = tx.query_one("SELECT parent_id FROM ot.agents WHERE id = $1", &[&id]).await?.get(0);
        match dir {
            Dir::Undo if state != "live" => refuse!(Conflict, "{name} is no longer live"),
            Dir::Redo if state != "archived" => refuse!(Conflict, "{name} is no longer archived ({state})"),
            _ => {}
        }
        if parent != opt_id(&h["after"]["parent"]) {
            refuse!(Conflict, "{name} was moved since");
        }
    }
    guard_moved(tx, org.id, &moved, from).await?;
    match dir {
        Dir::Undo => {
            // anchors leave the hired agent first, so it retires alone
            reparent(engine, org, tx, &moved, from, to, pending).await?;
            for h in hires.iter().rev() {
                let Some(id) = opt_id(&h["agent"]) else { continue };
                let (name, _) = who(tx, org.id, id).await?;
                let reports: Vec<String> = tx.query("SELECT name FROM ot.agents WHERE parent_id = $1 AND state = 'live' ORDER BY sibling_order, id", &[&id])
                    .await?.iter().map(|r| r.get(0)).collect();
                if !reports.is_empty() {
                    refuse!(Conflict, "{name} has live reports of its own now ({}); they are never retired with it", reports.join(", "));
                }
                run(engine, org, tx, json!({ "op": "retire", "node": name }), pending).await?;
            }
            next["moved"] = json!(reslot_all(engine, org, tx, &moved, to, pending).await?);
        }
        Dir::Redo => {
            let mut again = Vec::new();
            for h in &hires {
                let mut h = h.clone();
                if let Some(id) = opt_id(&h["agent"]) {
                    let (name, _) = who(tx, org.id, id).await?;
                    let parent = parent_name(tx, org.id, opt_id(&h["after"]["parent"])).await?;
                    // the same record comes back, never a fresh namesake
                    run(engine, org, tx, json!({ "op": "rehire", "node": name, "target": parent }), pending).await?;
                    reslot(engine, org, tx, id, &h["after"], pending).await?;
                    if let Some(p) = place(tx, org.id, id).await? { h["after"]["order"] = json!(p.order); }
                }
                again.push(h);
            }
            next["hires"] = json!(again);
            reparent(engine, org, tx, &moved, from, to, pending).await?;
            next["moved"] = json!(reslot_all(engine, org, tx, &moved, to, pending).await?);
        }
    }
    Ok(next)
}

#[nolog]
async fn apply_retire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, dir: Dir, data: &Value, pending: &mut Pending) -> Result<Value> {
    if let Some(why) = data["not_undoable"].as_str() {
        refuse!(Conflict, "{why}");
    }
    let retires = data["retires"].as_array().cloned().unwrap_or_default();
    let mut next = data.clone();
    match dir {
        Dir::Undo => {
            let mut back = Vec::new();
            for r in retires.iter().rev() {
                let mut r = r.clone();
                let Some(root) = opt_id(&r["root"]) else { continue };
                let members = r["members"].as_array().cloned().unwrap_or_default();
                let mut all = vec![(root, opt_id(&r["before"]["parent"]))];
                all.extend(members.iter().filter_map(|m| opt_id(&m["agent"]).map(|id| (id, opt_id(&m["parent"])))));
                for (id, parent) in &all {
                    let (name, state) = who(tx, org.id, *id).await?;
                    match state.as_str() {
                        "archived" => {}
                        "live" => refuse!(Conflict, "{name} is live again"),
                        "deleted" => refuse!(Conflict, "{name} was deleted"),
                        _ => refuse!(Conflict, "{name} can no longer be recovered ({state})"),
                    }
                    let now: Option<i64> = tx.query_one("SELECT parent_id FROM ot.agents WHERE id = $1", &[id]).await?.get(0);
                    if now != *parent { refuse!(Conflict, "{name} was moved since"); }
                }
                // exactly the recorded set, each under its recorded parent,
                // top-down so every parent is live before its reports
                for (id, parent) in &all {
                    let (name, _) = who(tx, org.id, *id).await?;
                    let p = parent_name(tx, org.id, *parent).await?;
                    run(engine, org, tx, json!({ "op": "rehire", "node": name, "target": p }), pending).await?;
                }
                reslot(engine, org, tx, root, &r["before"], pending).await?;
                if let Some(p) = place(tx, org.id, root).await? { r["before"]["order"] = json!(p.order); }
                let mut ms = Vec::new();
                for m in members {
                    let mut m = m.clone();
                    if let Some(p) = opt_id(&m["agent"]) { if let Some(pl) = place(tx, org.id, p).await? { m["order"] = json!(pl.order); } }
                    ms.push(m);
                }
                r["members"] = json!(ms);
                back.push(r);
            }
            back.reverse();
            next["retires"] = json!(back);
        }
        Dir::Redo => {
            for r in &retires {
                let Some(root) = opt_id(&r["root"]) else { continue };
                let (name, state) = who(tx, org.id, root).await?;
                if state != "live" { refuse!(Conflict, "{name} is no longer live"); }
                let now = place(tx, org.id, root).await?.and_then(|p| p.parent);
                if now != opt_id(&r["before"]["parent"]) { refuse!(Conflict, "{name} was moved since"); }
                let members: Vec<(i64, Option<i64>)> = r["members"].as_array().into_iter().flatten()
                    .filter_map(|m| opt_id(&m["agent"]).map(|id| (id, opt_id(&m["parent"])))).collect();
                let team = live_team(tx, root).await?;
                let set: HashSet<i64> = members.iter().map(|(id, _)| *id).collect();
                let extra: Vec<i64> = team.iter().map(|(id, _, _)| *id).filter(|id| !set.contains(id)).collect();
                if !extra.is_empty() {
                    let mut names = Vec::new();
                    for id in &extra { names.push(who(tx, org.id, *id).await?.0); }
                    refuse!(Conflict, "{name} has new reports since ({}); they are never retired with it", names.join(", "));
                }
                for (id, parent) in &members {
                    let (m, state) = who(tx, org.id, *id).await?;
                    if state != "live" { refuse!(Conflict, "{m} is no longer live"); }
                    if !team.iter().any(|(x, p, _)| x == id && Some(*p) == *parent) { refuse!(Conflict, "{m} was moved since"); }
                }
                run(engine, org, tx, json!({ "op": "retire", "node": name }), pending).await?;
            }
        }
    }
    Ok(next)
}

/// The request that sets one side of a retool entry's fields.
#[nolog]
fn scope_body(fields: &Map<String, Value>, side: &str) -> Value {
    let mut b = Map::new();
    for (k, f) in fields {
        let v = &f[side];
        let gone = is_absent(v);
        match k.as_str() {
            "add_dirs" => { b.insert(k.clone(), if gone { json!([]) } else { v.clone() }); }
            "tools" | "org_visibility" | "permission_mode" if !gone => { b.insert(k.clone(), v.clone()); }
            "effort" | "model_version" | "charter" | "team_charter" => { b.insert(k.clone(), if gone { json!("") } else { v.clone() }); }
            "account_fallback" => {
                if gone { b.insert("clear_account_fallback".into(), json!(true)); } else { b.insert(k.clone(), v.clone()); }
            }
            "auto_cheap_compact" => { b.insert(k.clone(), if gone { json!({}) } else { v.clone() }); }
            "session" => { b.insert(k.clone(), if gone { json!("signed-in") } else { v.clone() }); }
            _ => {}
        }
    }
    Value::Object(b)
}

#[nolog]
async fn apply_retool(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, dir: Dir, data: &Value, pending: &mut Pending) -> Result<Value> {
    let (from, to) = sides(dir);
    let agents = data["agents"].as_array().cloned().unwrap_or_default();
    for a in &agents {
        let Some(id) = opt_id(&a["agent"]) else { continue };
        let (name, state) = who(tx, org.id, id).await?;
        if state == "deleted" { refuse!(Conflict, "{name} was deleted"); }
        let Some(now) = retool_facts(tx, org.id, id).await? else { refuse!(Conflict, "{name} no longer exists") };
        let fields = a["fields"].as_object().cloned().unwrap_or_default();
        for (k, f) in &fields {
            if now.get(k).cloned().unwrap_or_else(absent) != f[from] {
                refuse!(Conflict, "{name}'s {} was changed again since", k.replace('_', " "));
            }
        }
    }
    // every other row the entry touched must stand as it left them
    let side = &data["side"];
    let recorded: Vec<(i64, Value)> = side["scopes"].as_array().into_iter().flatten()
        .filter_map(|x| opt_id(&x["agent"]).map(|id| (id, x.clone()))).collect();
    for (id, x) in &recorded {
        let (name, state) = who(tx, org.id, *id).await?;
        if state == "deleted" { refuse!(Conflict, "{name} was deleted"); }
        let now: Value = tx.query_one("SELECT scope FROM ot.agents WHERE id = $1 FOR UPDATE", &[id]).await?.get(0);
        if now != x[from] {
            refuse!(Conflict, "{name}'s folders, tools or permissions were changed since (this entry changed them too)");
        }
    }
    let org_now = org_keys(tx, org.id).await?;
    let org_rec = side["org"].as_object().cloned().unwrap_or_default();
    for (k, f) in &org_rec {
        if org_now.get(k).cloned().unwrap_or_else(absent) != f[from] {
            refuse!(Conflict, "the organization's {} was changed since (this entry changed it too)", k.replace('_', " "));
        }
    }
    // what the inverse may touch besides the entry's own rows stays as it is now
    let mains: Vec<i64> = agents.iter().filter_map(|a| opt_id(&a["agent"])).collect();
    let mut ids = around(tx, &mains).await?;
    for id in recorded.iter().map(|(id, _)| *id).chain(mains.iter().copied()) {
        if !ids.contains(&id) { ids.push(id); }
    }
    ids.sort_unstable();
    let keep = scopes(tx, &ids).await?;
    for a in &agents {
        let Some(id) = opt_id(&a["agent"]) else { continue };
        let (name, _) = who(tx, org.id, id).await?;
        let fields = a["fields"].as_object().cloned().unwrap_or_default();
        let acc = |v: &Value| v.as_str().map(str::to_string).unwrap_or_else(|| "primary".into());
        // the model and login first: the levels below are judged on them
        if let Some(t) = fields.get("tier") {
            let mut req = json!({ "op": "switch_model", "node": name, "tier": t[to] });
            if let Some(a) = fields.get("account") { req["account"] = json!(acc(&a[to])); }
            run(engine, org, tx, req, pending).await?;
        } else if let Some(a) = fields.get("account") {
            run(engine, org, tx, json!({ "op": "account", "node": name, "account": acc(&a[to]) }), pending).await?;
        }
        let body = scope_body(&fields, to);
        if body.as_object().is_some_and(|o| !o.is_empty()) {
            let sfx = crate::http::nodes::apply_user_scope_in_tx(engine, org, tx, &name, &body, None).await?;
            pending.scopes.push((pending.scopes.len(), sfx));
        }
    }
    // the other rows exactly: the entry's recorded side, everything else as it was
    // (coordinator 2026-10-14 19:07Z: restore ancestors' and the org's grants and
    // the folders clamped beneath, or refuse)
    for (id, was) in &keep {
        let want = recorded.iter().find(|(x, _)| x == id).map(|(_, x)| x[to].clone()).unwrap_or_else(|| was.clone());
        let now: Value = tx.query_one("SELECT scope FROM ot.agents WHERE id = $1", &[id]).await?.get(0);
        if now != want {
            tx.execute("UPDATE ot.agents SET scope = $2, row_version = row_version + 1 WHERE id = $1", &[id, &want]).await?;
            pending.rescoped.push(*id);
        }
    }
    let mut settings: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org.id]).await?.get(0);
    let before_settings = settings.clone();
    for k in ORG_KEYS {
        let want = org_rec.get(*k).map(|f| f[to].clone()).unwrap_or_else(|| org_now.get(*k).cloned().unwrap_or_else(absent));
        if let Some(o) = settings.as_object_mut() {
            if is_absent(&want) { o.remove(*k); } else { o.insert((*k).to_string(), want); }
        }
    }
    if settings != before_settings {
        tx.execute("UPDATE ot.orgs SET settings = $2, row_version = row_version + 1 WHERE id = $1", &[&org.id, &settings]).await?;
        pending.org_settings = true;
    }
    // every field must now stand as recorded; anything else is not this entry's inverse
    for a in &agents {
        let Some(id) = opt_id(&a["agent"]) else { continue };
        let (name, _) = who(tx, org.id, id).await?;
        let fields = a["fields"].as_object().cloned().unwrap_or_default();
        let Some(now) = retool_facts(tx, org.id, id).await? else { refuse!(Conflict, "{name} no longer exists") };
        for (k, f) in &fields {
            if now.get(k).cloned().unwrap_or_else(absent) != f[to] {
                refuse!(Conflict, "{name}'s {} could not be restored as recorded", k.replace('_', " "));
            }
        }
    }
    Ok(data.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_consumed_last_entry_answers_moved_not_empty() {
        assert_eq!(stale(Some(7), 7, false), None);
        assert_eq!(stale(Some(6), 7, true), Some("history_moved"));
        assert_eq!(stale(None, 7, true), Some("history_moved"), "the second window after the last entry was consumed");
        assert_eq!(stale(None, 7, false), Some("history_empty"));
    }

    #[test]
    fn kinds_follow_the_contract() {
        let s = |ops: &[&str]| ops.iter().map(|o| json!({ "op": o })).collect::<Vec<_>>();
        assert_eq!(kind_of(&s(&["move"])).unwrap(), "move");
        assert_eq!(kind_of(&s(&["moves", "reorder"])).unwrap(), "move");
        assert_eq!(kind_of(&s(&["hire", "reorder", "move"])).unwrap(), "hire");
        assert_eq!(kind_of(&s(&["retire", "retire"])).unwrap(), "retire");
        assert_eq!(kind_of(&s(&["switch_model", "account", "scope"])).unwrap(), "retool");
        for mixed in [&["hire", "retire"][..], &["move", "scope"], &["retire", "move"], &["hire", "scope"]] {
            let e = kind_of(&s(mixed)).unwrap_err();
            assert_eq!(e.downcast_ref::<Coded>().unwrap().code, "gesture_mixed", "{mixed:?}");
        }
        let e = kind_of(&s(&["rename"])).unwrap_err();
        assert_eq!(e.downcast_ref::<Coded>().unwrap().code, "gesture_op");
    }

    #[test]
    fn references_name_only_earlier_steps() {
        let ok = vec![json!({ "op": "hire", "parent": "bob" }), json!({ "op": "reorder", "node": "$0.node", "after": "carol" })];
        check_refs(&ok).unwrap();
        let resolved = resolve(&ok[1], &[json!({ "node": "dana" })]).unwrap();
        assert_eq!(resolved["node"], "dana");
        assert_eq!(resolved["after"], "carol");
        for bad in [json!({ "op": "reorder", "node": "$1.node" }), json!({ "op": "reorder", "node": "$0.name" }), json!({ "op": "move", "node": "$x" })] {
            let e = check_refs(&[json!({ "op": "hire" }), bad.clone()]).unwrap_err();
            assert_eq!(e.downcast_ref::<Coded>().unwrap().code, "gesture_ref", "{bad}");
        }
        let moves = json!({ "op": "moves", "moves": [{ "node": "$0.node", "new_parent": "user" }] });
        check_refs(&[json!({ "op": "hire" }), moves.clone()]).unwrap();
        assert_eq!(resolve(&moves, &[json!({ "node": "eve" })]).unwrap()["moves"][0]["node"], "eve");
        // a result without an agent cannot be referred to
        assert!(resolve(&ok[1], &[json!({ "moved": 1 })]).is_err());
    }

    #[test]
    fn metadata_is_bounded_and_never_reaches_an_op() {
        let (l, r) = meta(&json!({ "history_label": " Move a ", "request_id": "r1" })).unwrap();
        assert_eq!((l.as_deref(), r.as_deref()), (Some("Move a"), Some("r1")));
        assert!(meta(&json!({ "history_label": "x".repeat(121) })).is_err());
        assert!(meta(&json!({ "request_id": "x".repeat(65) })).is_err());
        assert!(meta(&json!({ "request_id": "" })).is_err());
        let s = strip(&json!({ "op": "move", "node": "a", "history_label": "l", "request_id": "r" }));
        assert_eq!(s, json!({ "op": "move", "node": "a" }));
    }

    #[test]
    fn named_agents_skip_references_and_the_user() {
        assert_eq!(named(&json!({ "op": "move", "node": "@alice" })), vec!["alice"]);
        assert_eq!(named(&json!({ "op": "reorder", "node": "$0.node" })), Vec::<String>::new());
        assert_eq!(named(&json!({ "op": "hire", "parent": "bob", "above": "carol" })), vec!["carol"]);
        assert_eq!(named(&json!({ "op": "moves", "moves": [{ "node": "a" }, { "node": "$0.node" }] })), vec!["a"]);
    }

    #[test]
    fn retool_sides_restore_absent_values() {
        let fields = json!({
            "effort": { "before": { "absent": true }, "after": "high" },
            "charter": { "before": "old", "after": { "absent": true } },
            "account_fallback": { "before": { "absent": true }, "after": true },
            "auto_cheap_compact": { "before": { "absent": true }, "after": { "enabled": true, "occ": 70 } },
            "tools": { "before": { "web": true }, "after": { "web": false } },
            "tier": { "before": "sonnet", "after": "opus" },
        });
        let f = fields.as_object().unwrap();
        let undo = scope_body(f, "before");
        assert_eq!(undo["effort"], "");
        assert_eq!(undo["charter"], "old");
        assert_eq!(undo["clear_account_fallback"], true);
        assert_eq!(undo["auto_cheap_compact"], json!({}));
        assert_eq!(undo["tools"], json!({ "web": true }));
        assert!(undo.get("tier").is_none(), "the model goes through switch_model, never the scope body");
        let redo = scope_body(f, "after");
        assert_eq!(redo["effort"], "high");
        assert_eq!(redo["charter"], "");
        assert_eq!(redo["account_fallback"], true);
    }

    #[test]
    fn account_choices_normalize() {
        for none in [None, Some(""), Some("primary"), Some("default"), Some("claude/primary")] {
            assert_eq!(account_value(none), absent(), "{none:?}");
        }
        assert_eq!(account_value(Some("claude-5")), json!("claude-5"));
    }
}
