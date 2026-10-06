//! Tree operations: hire, rehire, retire, rescind, delete, dissolve, move,
//! rename, reorder, reallocate, switch model, account, cheap compact. Shared
//! by the canvas (`POST /ops`, user) and the agents' tools (agent: downward
//! only). Each is one short transaction that locks only the rows it changes;
//! credit chains are locked top-down so cascades in different subtrees never
//! wait on each other. Deadlocks and serialization failures are retried.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;

use crate::domain::scope;
use crate::engine::Engine;
use crate::feed::Key;
use crate::orgs::OrgHandle;
use crate::providers::catalog;
use crate::refuse;
use crate::runtime::AgentMsg;

/// Who asks.
#[derive(Clone, Debug)]
pub enum Actor {
    User,
    Agent { id: i64, name: String },
}

impl Actor {
    fn label(&self) -> String {
        match self {
            Actor::User => "@user".into(),
            Actor::Agent { name, .. } => name.clone(),
        }
    }
}

/// What an op touched, for the feed and the runtime after commit.
#[derive(Default, Debug)]
struct Effects {
    agents: HashSet<i64>,
    stop: Vec<i64>,
    reconfigure: Vec<i64>,
    wake: Vec<i64>,
    events: bool,
    registry: bool,
    pulses: Vec<Value>,
}

/// A locked agent row.
#[derive(Debug, Clone)]
struct Node {
    id: i64,
    name: String,
    parent: Option<i64>,
    state: String,
    tier: String,
    seat: f64,
    grant: f64,
    scope: Value,
    account: Option<String>,
    session: Option<String>,
}

const NODE_COLS: &str = "id, name, parent_id, state, tier, seat::float8, grant_credits::float8, scope, account, session_id";

fn node_of(r: &tokio_postgres::Row) -> Node {
    Node {
        id: r.get(0),
        name: r.get(1),
        parent: r.get(2),
        state: r.get(3),
        tier: r.get(4),
        seat: r.get(5),
        grant: r.get(6),
        scope: r.get(7),
        account: r.get(8),
        session: r.get(9),
    }
}

#[logged]
async fn node_by_name(tx: &Transaction<'_>, org_id: i64, name: &str) -> Result<Node> {
    let name = name.trim().trim_start_matches('@');
    let r = tx
        .query_opt(
            &format!("SELECT {NODE_COLS} FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted' FOR UPDATE"),
            &[&org_id, &name],
        )
        .await?;
    match r {
        Some(r) => Ok(node_of(&r)),
        None => refuse!(NotFound, "no agent named {name} in this organization"),
    }
}

#[logged]
async fn node_by_id(tx: &Transaction<'_>, id: i64) -> Result<Node> {
    let r = tx
        .query_one(&format!("SELECT {NODE_COLS} FROM ot.agents WHERE id = $1 FOR UPDATE"), &[&id])
        .await?;
    Ok(node_of(&r))
}

/// Credits an agent holds for its live reports.
#[logged]
async fn hold(tx: &Transaction<'_>, id: i64) -> Result<f64> {
    Ok(tx
        .query_one(
            "SELECT coalesce(sum(seat + grant_credits), 0)::float8 FROM ot.agents WHERE parent_id = $1 AND state = 'live'",
            &[&id],
        )
        .await?
        .get(0))
}

/// `id` and its ancestors, root first, locked in that order.
#[logged]
async fn chain(tx: &Transaction<'_>, id: i64) -> Result<Vec<Node>> {
    let ids: Vec<i64> = tx
        .query(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $1
               UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id
                WHERE up.depth < 1024)
             SELECT id FROM up ORDER BY depth DESC",
            &[&id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let mut out = Vec::with_capacity(ids.len());
    for i in ids {
        out.push(node_by_id(tx, i).await?);
    }
    Ok(out)
}

/// Is `node` inside the subtree of `root` (or `root` itself)?
#[logged]
async fn within(tx: &Transaction<'_>, root: i64, node: i64) -> Result<bool> {
    Ok(tx
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
               UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id
                WHERE up.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = $1)",
            &[&root, &node],
        )
        .await?
        .get(0))
}

/// The live subtree under `id` (excluding it), deepest last.
#[logged]
async fn subtree(tx: &Transaction<'_>, id: i64) -> Result<Vec<i64>> {
    Ok(tx
        .query(
            "WITH RECURSIVE down(id, depth) AS (
               SELECT id, 1 FROM ot.agents WHERE parent_id = $1 AND state <> 'deleted'
               UNION ALL SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id
                WHERE d.depth < 1024 AND a.state <> 'deleted')
             SELECT id FROM down ORDER BY depth",
            &[&id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

struct OrgCaps {
    max_top: f64,
    cascade_hire: bool,
    cascade_alloc: bool,
    settings: Value,
}

#[logged]
async fn caps(engine: &Engine, tx: &Transaction<'_>, org_id: i64) -> Result<OrgCaps> {
    let s: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let eff = crate::feed::groups::effective_settings(&s, &engine.settings.defaults());
    Ok(OrgCaps {
        max_top: eff["max_top_grant"].as_f64().unwrap_or(1000.0),
        cascade_hire: eff["cascade_hire"].as_bool().unwrap_or(true),
        cascade_alloc: eff["cascade_alloc"].as_bool().unwrap_or(true),
        settings: eff,
    })
}

/// Make `need` credits free under `parent` (the user when `None`): raise
/// each ancestor's grant just enough, whole credits, up to the user and
/// within the top-level cap. Returns who was raised.
#[logged]
async fn ensure_room(
    tx: &Transaction<'_>,
    parent: Option<i64>,
    need: f64,
    cascade: bool,
    max_top: f64,
    fx: &mut Effects,
) -> Result<Vec<String>> {
    let Some(pid) = parent else { return Ok(Vec::new()) };
    if need <= 0.0 {
        return Ok(Vec::new());
    }
    let ch = chain(tx, pid).await?;
    let mut need = need;
    let mut raised = Vec::new();
    for n in ch.iter().rev() {
        let free = n.grant - hold(tx, n.id).await?;
        if free + 1e-9 >= need {
            break;
        }
        if !cascade {
            refuse!(
                Conflict,
                "{} has {:.2} credits free and this needs {:.2}; raise its grant first (credit cascade is off)",
                n.name, free, need
            );
        }
        let d = (need - free).ceil();
        if n.parent.is_none() && n.grant + d > max_top + 1e-9 {
            refuse!(
                Conflict,
                "{} would need a grant of {:.0}, over this organization's top-level cap of {:.0}",
                n.name,
                n.grant + d,
                max_top
            );
        }
        tx.execute(
            "UPDATE ot.agents SET grant_credits = grant_credits + $2::float8::numeric, row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &d],
        )
        .await?;
        fx.agents.insert(n.id);
        raised.push(n.name.clone());
        need = d;
        if n.parent.is_none() {
            break;
        }
    }
    Ok(raised)
}

/// May `actor` act on `target`? The user always; an agent downward only.
#[logged]
async fn authorize(tx: &Transaction<'_>, actor: &Actor, target: &Node, verb: &str) -> Result<()> {
    if let Actor::Agent { id, .. } = actor {
        if *id == target.id {
            refuse!(Forbidden, "you cannot {verb} yourself");
        }
        if !within(tx, *id, target.id).await? {
            refuse!(Forbidden, "you can only {verb} agents below you; {} is not", target.name);
        }
    }
    Ok(())
}

#[logged]
fn valid_name(name: &str) -> Result<String> {
    let n = name.trim().trim_start_matches('@');
    let ok = !n.is_empty()
        && n.len() <= 64
        && n.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !ok {
        refuse!(BadRequest, "a name is 1–64 letters, digits, '-', '_' or '.', starting with a letter or digit");
    }
    if ["user", "system", "engine", "org", "net"].contains(&n.to_ascii_lowercase().as_str()) {
        refuse!(BadRequest, "{n} is a reserved name");
    }
    Ok(n.to_string())
}

#[logged]
async fn name_free(tx: &Transaction<'_>, org_id: i64, name: &str) -> Result<()> {
    let taken = tx
        .query_opt("SELECT 1 FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&org_id, &name])
        .await?;
    if taken.is_some() {
        refuse!(Conflict, "an agent named {name} already exists in this organization");
    }
    Ok(())
}

/// The seat price of a tier (catalog or an OpenRouter favorite).
#[logged]
fn seat_of(engine: &Engine, tier: &str) -> Result<f64> {
    if let Some(t) = catalog::tier(tier) {
        return Ok(t.seat);
    }
    if let Some((_, seat, _)) = engine.providers.openrouter_tiers().into_iter().find(|(t, _, _)| t == tier) {
        return Ok(seat);
    }
    refuse!(BadRequest, "unknown tier {tier}")
}

#[logged]
async fn event(tx: &Transaction<'_>, org_id: i64, op: &str, actor: &Actor, subject: Option<i64>, detail: Value) -> Result<()> {
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, $2, $3, $4, $5)",
        &[&org_id, &op, &actor.label(), &subject, &detail],
    )
    .await?;
    Ok(())
}

fn str_arg<'a>(req: &'a Value, k: &str) -> Option<&'a str> {
    req.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Run one op from the canvas or an agent tool.
#[logged]
pub async fn run(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: Actor, req: &Value) -> Result<Value> {
    let op = req["op"].as_str().unwrap_or("").to_string();
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut fx = Effects::default();
        let res = run_once(engine, org, &actor, &op, req, &mut fx).await;
        match res {
            Ok(v) => {
                apply_effects(engine, org, fx).await;
                return Ok(v);
            }
            Err(e) if attempt < 4 && retryable(&e) => {
                tracing::warn!(op = %op, attempt, "op conflicted with another write; retrying");
                tokio::time::sleep(std::time::Duration::from_millis(20 * attempt as u64)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

fn retryable(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<tokio_postgres::Error>()
            .and_then(|pe| pe.code())
            .map(|code| code.code() == "40001" || code.code() == "40P01")
            .unwrap_or(false)
    })
}

#[logged]
async fn run_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, op: &str, req: &Value, fx: &mut Effects) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let out = match op {
        "hire" => hire(engine, org, &tx, actor, req, fx).await?,
        "rehire" => rehire(engine, org, &tx, actor, req, fx).await?,
        "retire" => retire(org, &tx, actor, req, fx, false).await?,
        "rescind" => retire(org, &tx, actor, req, fx, true).await?,
        "dissolve" => dissolve(org, &tx, actor, req, fx).await?,
        "delete" => delete(org, &tx, actor, req, fx).await?,
        "move" | "promote" | "demote" => move_node(engine, org, &tx, actor, req, fx).await?,
        "rename" => rename(org, &tx, actor, req, fx).await?,
        "reallocate" => reallocate(engine, org, &tx, actor, req, fx).await?,
        "switch_model" => switch_model(engine, org, &tx, actor, req, fx).await?,
        "reorder" => reorder(org, &tx, actor, req, fx).await?,
        "account" => account(engine, org, &tx, actor, req, fx).await?,
        "cheap_compact" => cheap_compact(engine, org, &tx, actor, req, fx).await?,
        other => refuse!(BadRequest, "unknown op {other}"),
    };
    tx.commit().await?;
    Ok(out)
}

#[logged]
async fn apply_effects(engine: &Arc<Engine>, org: &Arc<OrgHandle>, fx: Effects) {
    for id in &fx.stop {
        if let Some(h) = engine.agents.get(*id) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            if h.send(AgentMsg::Stop(tx)) {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(10), rx).await;
            }
        }
    }
    for id in &fx.reconfigure {
        if let Some(h) = engine.agents.get(*id) {
            h.send(AgentMsg::Reconfigured);
        }
    }
    let mut keys: Vec<Key> = fx.agents.iter().map(|id| Key::Agent(*id)).collect();
    keys.push(Key::Group("cost"));
    keys.push(Key::Group("audit"));
    if fx.events {
        keys.push(Key::Events);
    }
    keys.push(Key::Audiences);
    org.invalidate(keys);
    for p in fx.pulses {
        org.emit(p);
    }
    for id in &fx.wake {
        crate::runtime::wake(engine, org.id, *id);
    }
    engine.app.org_changed(org.id);
    if fx.registry {
        engine.app.registry_changed();
    }
}

// ------------------------------------------------------------ hire

/// The configured scope of a new hire: what the op says over the org defaults.
#[logged]
fn hire_scope(caps: &OrgCaps, req: &Value) -> Value {
    let s = &caps.settings;
    let mut tools = s["default_tools"].clone();
    if let Some(t) = req.get("tools").filter(|v| v.is_object()) {
        crate::settings::deep_merge(&mut tools, t);
    }
    let mut out = json!({
        "permission_mode": str_arg(req, "permission_mode").unwrap_or(s["permission_mode"].as_str().unwrap_or("acceptEdits")),
        "org_visibility": str_arg(req, "org_visibility").unwrap_or(s["default_visibility"].as_str().unwrap_or("subtree")),
        "add_dirs": req.get("add_dirs").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
        "tools": tools,
    });
    if let Some(e) = str_arg(req, "effort") {
        out["effort"] = json!(e);
    }
    if let Some(b) = req.get("account_fallback").and_then(Value::as_bool) {
        out["account_fallback"] = json!(b);
    }
    scope::normalize(&out)
}

#[logged]
async fn hire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let name = valid_name(str_arg(req, "name").unwrap_or(""))?;
    let tier = str_arg(req, "tier").unwrap_or("").to_string();
    let seat = seat_of(engine, &tier)?;
    let provider = catalog::provider_of(&tier);
    if !engine.settings.provider_enabled(provider) {
        refuse!(Conflict, "{} is turned off in App settings", catalog::provider_label(provider));
    }
    let grant = req["grant"].as_f64().unwrap_or(0.0);
    if grant < 0.0 {
        refuse!(BadRequest, "a grant cannot be negative");
    }
    let caps = caps(engine, tx, org.id).await?;
    name_free(tx, org.id, &name).await?;
    // where it goes: under `parent` (null = the user), or as `above`'s new superior
    let anchor = match str_arg(req, "above") {
        Some(a) => Some(node_by_name(tx, org.id, a).await?),
        None => None,
    };
    let parent: Option<Node> = match (&anchor, str_arg(req, "parent")) {
        (Some(a), _) => match a.parent {
            Some(p) => Some(node_by_id(tx, p).await?),
            None => None,
        },
        (None, Some(p)) if p != "user" && p != "@user" => Some(node_by_name(tx, org.id, p).await?),
        _ => match actor {
            Actor::Agent { id, .. } => Some(node_by_id(tx, *id).await?),
            Actor::User => None,
        },
    };
    if let Some(p) = &parent {
        if p.state != "live" {
            refuse!(Conflict, "{} is not live", p.name);
        }
        if let Actor::Agent { id, name } = actor {
            if p.id != *id && !within(tx, *id, p.id).await? {
                refuse!(Forbidden, "{name} can only hire under itself or its reports");
            }
        }
    } else if matches!(actor, Actor::Agent { .. }) {
        refuse!(Forbidden, "only the user hires at the top level");
    }
    // a superior inserted above `anchor` also carries the anchor's stake
    let anchor_stake = anchor.as_ref().map(|a| a.seat + a.grant).unwrap_or(0.0);
    let grant = grant + anchor_stake;
    let need = seat + grant - anchor_stake;
    let raised = match &parent {
        Some(p) => ensure_room(tx, Some(p.id), need, caps.cascade_hire, caps.max_top, fx).await?,
        None => {
            if grant > caps.max_top + 1e-9 {
                refuse!(Conflict, "a top-level grant of {grant:.0} is over this organization's cap of {:.0}", caps.max_top);
            }
            Vec::new()
        }
    };
    let sc = hire_scope(&caps, req);
    let account = str_arg(req, "account")
        .map(str::to_string)
        .or_else(|| caps.settings["default_account"].as_str().filter(|s| !s.is_empty()).map(str::to_string))
        .or_else(|| parent.as_ref().and_then(|p| p.account.clone()));
    if let Some(acc) = &account {
        let view = engine.accounts.view();
        match view.get(acc) {
            Some(a) if a.provider != provider && !(provider == catalog::OPENROUTER) => {
                refuse!(BadRequest, "{acc} is a {} account and {tier} runs on {}", a.provider, provider)
            }
            None => refuse!(NotFound, "no account {acc}"),
            _ => {}
        }
    }
    let parent_id = parent.as_ref().map(|p| p.id);
    let order: f64 = tx
        .query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &parent_id],
        )
        .await?
        .get(0);
    let charter = str_arg(req, "charter").map(str::to_string);
    let team_charter = str_arg(req, "team_charter").map(str::to_string);
    let title = str_arg(req, "title").map(str::to_string).unwrap_or_default();
    let scratch = engine.cfg.scratch_root(&org.slug).join(&name).to_string_lossy().to_string();
    let born = uuid::Uuid::new_v4().to_string();
    let id: i64 = tx
        .query_one(
            "INSERT INTO ot.agents (org_id, name, parent_id, sibling_order, state, title, charter, team_charter, tier, account,
                                    seat, grant_credits, scope, generation, born, provider, scratch_dir)
             VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, $9, $10::float8::numeric, $11::float8::numeric, $12, 1, $13, $14, $15)
             RETURNING id",
            &[
                &org.id, &name, &parent_id, &order, &title, &charter, &team_charter, &tier, &account, &seat, &grant, &sc,
                &born, &provider, &scratch,
            ],
        )
        .await?
        .get(0);
    if let Some(a) = &anchor {
        tx.execute("UPDATE ot.agents SET parent_id = $2, sibling_order = 1, row_version = row_version + 1 WHERE id = $1", &[&a.id, &id])
            .await?;
        fx.agents.insert(a.id);
    }
    event(
        tx,
        org.id,
        "hire",
        actor,
        Some(id),
        json!({ "node": name, "parent": parent.as_ref().map(|p| p.name.clone()), "tier": tier, "grant": grant,
                "above": anchor.as_ref().map(|a| a.name.clone()), "cascaded": raised }),
    )
    .await?;
    fx.agents.insert(id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    let _ = std::fs::create_dir_all(&scratch);
    Ok(json!({ "node": name, "cascaded": raised }))
}

#[logged]
async fn rehire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state == "live" {
        refuse!(Conflict, "{} is already live", n.name);
    }
    if n.state == "unrecoverable" {
        refuse!(Conflict, "{} cannot be rehired: its session is lost", n.name);
    }
    let caps = caps(engine, tx, org.id).await?;
    // back under its old superior if that one is live, else the nearest live ancestor
    let mut parent: Option<Node> = None;
    let mut cur = n.parent;
    while let Some(pid) = cur {
        let p = node_by_id(tx, pid).await?;
        if p.state == "live" {
            parent = Some(p);
            break;
        }
        cur = p.parent;
    }
    if let Some(p) = str_arg(req, "target").or_else(|| str_arg(req, "parent")) {
        parent = if p == "user" { None } else { Some(node_by_name(tx, org.id, p).await?) };
    }
    if let Actor::Agent { id, name } = actor {
        match &parent {
            Some(p) if p.id == *id || within(tx, *id, p.id).await? => {}
            _ => refuse!(Forbidden, "{name} can only rehire under itself or its reports"),
        }
    }
    let tier = str_arg(req, "tier").map(str::to_string).unwrap_or(n.tier.clone());
    let seat = seat_of(engine, &tier)?;
    let grant = req["grant"].as_f64().unwrap_or(n.grant).max(0.0);
    let raised = match &parent {
        Some(p) => ensure_room(tx, Some(p.id), seat + grant, caps.cascade_hire, caps.max_top, fx).await?,
        None => {
            if grant > caps.max_top + 1e-9 {
                refuse!(Conflict, "a top-level grant of {grant:.0} is over this organization's cap of {:.0}", caps.max_top);
            }
            Vec::new()
        }
    };
    let parent_id = parent.as_ref().map(|p| p.id);
    let order: f64 = tx
        .query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &parent_id],
        )
        .await?
        .get(0);
    tx.execute(
        "UPDATE ot.agents SET state = 'live', archived_at = NULL, parent_id = $2, sibling_order = $3, tier = $4,
                seat = $5::float8::numeric, grant_credits = $6::float8::numeric, halt = NULL, row_version = row_version + 1
          WHERE id = $1",
        &[&n.id, &parent_id, &order, &tier, &seat, &grant],
    )
    .await?;
    event(tx, org.id, "rehire", actor, Some(n.id), json!({ "node": n.name, "parent": parent.as_ref().map(|p| p.name.clone()),
          "tier": tier, "grant": grant, "cascaded": raised }))
    .await?;
    fx.agents.insert(n.id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    fx.wake.push(n.id);
    Ok(json!({ "node": n.name, "cascaded": raised }))
}

#[logged]
async fn retire(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, rescind: bool) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    if rescind && !matches!(actor, Actor::User) {
        refuse!(Forbidden, "only the user can rescind");
    }
    authorize(tx, actor, &n, "retire").await?;
    // its live reports move up to its superior
    let kids: Vec<i64> = tx
        .query("SELECT id FROM ot.agents WHERE parent_id = $1 AND state = 'live' FOR UPDATE", &[&n.id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if !kids.is_empty() {
        tx.execute("UPDATE ot.agents SET parent_id = $2, row_version = row_version + 1 WHERE parent_id = $1 AND state = 'live'", &[&n.id, &n.parent])
            .await?;
    }
    tx.execute(
        "UPDATE ot.agents SET state = 'archived', archived_at = now(), inflight_at = NULL, row_version = row_version + 1 WHERE id = $1",
        &[&n.id],
    )
    .await?;
    let mut clawed = 0.0;
    if rescind {
        if let Some(pid) = n.parent {
            // the freed stake goes back to the user, not the superior
            let p = node_by_id(tx, pid).await?;
            let h = hold(tx, pid).await?;
            clawed = (n.seat + n.grant).min((p.grant - h).max(0.0));
            tx.execute(
                "UPDATE ot.agents SET grant_credits = grant_credits - $2::float8::numeric, row_version = row_version + 1 WHERE id = $1",
                &[&pid, &clawed],
            )
            .await?;
        }
    }
    event(tx, org.id, if rescind { "rescind" } else { "retire" }, actor, Some(n.id),
          json!({ "node": n.name, "reports_moved": kids.len(), "clawed_back": clawed }))
    .await?;
    fx.agents.insert(n.id);
    fx.agents.extend(kids.iter().copied());
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.stop.push(n.id);
    fx.events = true;
    Ok(json!({ "node": n.name, "freed": n.seat + n.grant }))
}

#[logged]
async fn dissolve(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    authorize(tx, actor, &n, "dissolve").await?;
    let mut ids = subtree(tx, n.id).await?;
    ids.push(n.id);
    let rows = tx
        .query(
            "UPDATE ot.agents SET state = 'archived', archived_at = now(), inflight_at = NULL, row_version = row_version + 1
              WHERE id = ANY($1) AND state = 'live' RETURNING id",
            &[&ids],
        )
        .await?;
    let done: Vec<i64> = rows.iter().map(|r| r.get(0)).collect();
    event(tx, org.id, "dissolve", actor, Some(n.id), json!({ "node": n.name, "nodes": done.len() })).await?;
    fx.agents.extend(done.iter().copied());
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.stop.extend(done.iter().copied());
    fx.events = true;
    Ok(json!({ "node": n.name, "nodes": done.len(), "freed": n.seat + n.grant }))
}

#[logged]
async fn delete(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    if !matches!(actor, Actor::User) {
        refuse!(Forbidden, "only the user deletes agents");
    }
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    let mut ids = subtree(tx, n.id).await?;
    ids.push(n.id);
    tx.execute(
        "UPDATE ot.agents SET state = 'deleted', archived_at = coalesce(archived_at, now()), inflight_at = NULL,
                row_version = row_version + 1 WHERE id = ANY($1)",
        &[&ids],
    )
    .await?;
    tx.execute(
        "UPDATE ot.mail SET state = 'retracted' WHERE recipient_agent_id = ANY($1) AND state IN ('pending', 'delivering')",
        &[&ids],
    )
    .await?;
    tx.execute("UPDATE ot.watchdogs SET state = 'removed' WHERE owner_agent_id = ANY($1) AND state IN ('armed', 'paused')", &[&ids])
        .await?;
    event(tx, org.id, "delete", actor, Some(n.id), json!({ "node": n.name, "nodes": ids.len() })).await?;
    fx.agents.extend(ids.iter().copied());
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.stop.extend(ids.iter().copied());
    fx.events = true;
    Ok(json!({ "node": n.name, "nodes": ids.len() }))
}

#[logged]
async fn move_node(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    authorize(tx, actor, &n, "move").await?;
    let target = match str_arg(req, "new_parent").filter(|p| *p != "user" && *p != "@user") {
        Some(p) => Some(node_by_name(tx, org.id, p).await?),
        None => None,
    };
    if let Some(t) = &target {
        if t.state != "live" {
            refuse!(Conflict, "{} is not live", t.name);
        }
        if within(tx, n.id, t.id).await? {
            refuse!(Conflict, "{} cannot move under {} (that is inside its own team)", n.name, t.name);
        }
    }
    if let Actor::Agent { id, name } = actor {
        match &target {
            Some(t) if t.id == *id || within(tx, *id, t.id).await? => {}
            _ => refuse!(Forbidden, "{name} can only move agents within its own team"),
        }
    }
    if target.as_ref().map(|t| t.id) == n.parent {
        return Ok(json!({ "node": n.name, "unchanged": true }));
    }
    let caps = caps(engine, tx, org.id).await?;
    let stake = n.seat + n.grant;
    let raised = match &target {
        Some(t) => ensure_room(tx, Some(t.id), stake, caps.cascade_alloc, caps.max_top, fx).await?,
        None => {
            if n.grant > caps.max_top + 1e-9 {
                refuse!(Conflict, "{} holds a grant of {:.0}, over the top-level cap of {:.0}", n.name, n.grant, caps.max_top);
            }
            Vec::new()
        }
    };
    let new_parent = target.as_ref().map(|t| t.id);
    let order: f64 = tx
        .query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &new_parent],
        )
        .await?
        .get(0);
    tx.execute(
        "UPDATE ot.agents SET parent_id = $2, sibling_order = $3, row_version = row_version + 1 WHERE id = $1",
        &[&n.id, &new_parent, &order],
    )
    .await?;
    event(tx, org.id, "move", actor, Some(n.id), json!({ "node": n.name, "to": target.as_ref().map(|t| t.name.clone()),
          "cascaded": raised }))
    .await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    if let Some(t) = &target {
        fx.agents.insert(t.id);
    }
    // its effective scope now comes from a new chain
    fx.reconfigure.push(n.id);
    fx.reconfigure.extend(subtree(tx, n.id).await?);
    fx.events = true;
    Ok(json!({ "node": n.name, "cascaded": raised }))
}

#[logged]
async fn rename(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "rename").await?;
    let new = valid_name(str_arg(req, "name").unwrap_or(""))?;
    if new == n.name {
        return Ok(json!({ "node": new, "unchanged": true }));
    }
    name_free(tx, org.id, &new).await?;
    tx.execute("UPDATE ot.agents SET name = $2, row_version = row_version + 1 WHERE id = $1", &[&n.id, &new]).await?;
    // names are how audiences address agents
    tx.execute("UPDATE ot.audiences SET grantee = $3 WHERE org_id = $1 AND grantee = $2", &[&org.id, &n.name, &new]).await?;
    tx.execute("UPDATE ot.audiences SET grantor = $3 WHERE org_id = $1 AND grantor = $2", &[&org.id, &n.name, &new]).await?;
    event(tx, org.id, "rename", actor, Some(n.id), json!({ "was": n.name, "node": new })).await?;
    fx.agents.insert(n.id);
    fx.reconfigure.push(n.id);
    fx.events = true;
    fx.pulses.push(json!({ "type": "node_event", "node": new, "event": "renamed", "was": n.name }));
    Ok(json!({ "renamed": true, "was": n.name, "node": new }))
}

#[logged]
async fn reallocate(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    authorize(tx, actor, &n, "reallocate credits of").await?;
    let delta = req["delta"].as_f64().unwrap_or(0.0);
    if delta == 0.0 {
        return Ok(json!({ "node": n.name, "grant": n.grant }));
    }
    let caps = caps(engine, tx, org.id).await?;
    let mut raised = Vec::new();
    if delta > 0.0 {
        match n.parent {
            Some(p) => raised = ensure_room(tx, Some(p), delta, caps.cascade_alloc, caps.max_top, fx).await?,
            None => {
                if n.grant + delta > caps.max_top + 1e-9 {
                    refuse!(Conflict, "a top-level grant of {:.0} is over this organization's cap of {:.0}", n.grant + delta, caps.max_top);
                }
            }
        }
    } else {
        let free = n.grant - hold(tx, n.id).await?;
        if free + 1e-9 < -delta {
            refuse!(Conflict, "{} has only {:.2} credits free; the rest is held by its reports", n.name, free);
        }
    }
    tx.execute(
        "UPDATE ot.agents SET grant_credits = grant_credits + $2::float8::numeric, row_version = row_version + 1 WHERE id = $1",
        &[&n.id, &delta],
    )
    .await?;
    event(tx, org.id, "reallocate", actor, Some(n.id), json!({ "node": n.name, "delta": delta, "cascaded": raised })).await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.events = true;
    Ok(json!({ "node": n.name, "grant": n.grant + delta, "cascaded": raised }))
}

#[logged]
async fn switch_model(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "switch the model of").await?;
    let tier = str_arg(req, "tier").unwrap_or("").to_string();
    if tier == n.tier {
        tx.execute("UPDATE ot.agents SET pending_switch = NULL WHERE id = $1", &[&n.id]).await?;
        fx.agents.insert(n.id);
        return Ok(json!({ "node": n.name, "tier": tier, "unchanged": true }));
    }
    let seat = seat_of(engine, &tier)?;
    let from = catalog::provider_of(&n.tier);
    let to = catalog::provider_of(&tier);
    if !engine.settings.provider_enabled(to) {
        refuse!(Conflict, "{} is turned off in App settings", catalog::provider_label(to));
    }
    let caps = caps(engine, tx, org.id).await?;
    let raised = if seat > n.seat && n.state == "live" {
        ensure_room(tx, n.parent, seat - n.seat, caps.cascade_alloc, caps.max_top, fx).await?
    } else {
        Vec::new()
    };
    let account = str_arg(req, "account").map(str::to_string);
    let mut warnings = Vec::new();
    if from != to {
        // a new provider starts a fresh session; the old transcript stays in the folder
        tx.execute(
            "UPDATE ot.agents SET tier = $2, seat = $3::float8::numeric, provider = $4, session_id = NULL,
                    account = $5,
                    occupancy = NULL, row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &tier, &seat, &to, &account],
        )
        .await?;
        tx.execute(
            "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'provider switch' WHERE agent_id = $1 AND ended_at IS NULL",
            &[&n.id],
        )
        .await?;
        warnings.push(format!(
            "{} moved from {} to {}: it starts a fresh session (its previous conversation stays in its folder)",
            n.name,
            catalog::provider_label(from),
            catalog::provider_label(to)
        ));
    } else {
        tx.execute(
            "UPDATE ot.agents SET tier = $2, seat = $3::float8::numeric, account = coalesce($4, account), row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &tier, &seat, &account],
        )
        .await?;
    }
    event(tx, org.id, "switch_model", actor, Some(n.id), json!({ "node": n.name, "from": n.tier, "to": tier, "cascaded": raised })).await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.reconfigure.push(n.id);
    fx.events = true;
    Ok(json!({ "node": n.name, "tier": tier, "cascaded": raised, "warnings": warnings }))
}

#[logged]
async fn reorder(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "reorder").await?;
    let sibs = tx
        .query(
            "SELECT name, sibling_order FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'
               AND id <> $3 ORDER BY sibling_order, id",
            &[&org.id, &n.parent, &n.id],
        )
        .await?;
    let list: Vec<(String, f64)> = sibs.iter().map(|r| (r.get(0), r.get(1))).collect();
    let pos = match (str_arg(req, "before"), str_arg(req, "after")) {
        (Some(b), _) => list.iter().position(|(nm, _)| nm == b),
        (None, Some(a)) => list.iter().position(|(nm, _)| nm == a).map(|i| i + 1),
        _ => Some(list.len()),
    };
    let Some(pos) = pos else { refuse!(NotFound, "that sibling is not beside {}", n.name) };
    let prev = if pos > 0 { list[pos - 1].1 } else { list.first().map(|x| x.1 - 2.0).unwrap_or(0.0) };
    let next = if pos < list.len() { list[pos].1 } else { prev + 2.0 };
    let order = (prev + next) / 2.0;
    tx.execute("UPDATE ot.agents SET sibling_order = $2, row_version = row_version + 1 WHERE id = $1", &[&n.id, &order]).await?;
    fx.agents.insert(n.id);
    Ok(json!({ "node": n.name, "sibling_order": order }))
}

#[logged]
async fn account(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "change the account of").await?;
    let acc = str_arg(req, "account").map(str::to_string);
    let view = engine.accounts.view();
    let info = match &acc {
        Some(a) => match view.get(a) {
            Some(i) => {
                let provider = catalog::provider_of(&n.tier);
                if i.provider != provider {
                    refuse!(BadRequest, "{a} is a {} account and {} runs on {}", i.provider, n.name, provider);
                }
                Some(i.clone())
            }
            None => refuse!(NotFound, "no account {a}"),
        },
        None => None,
    };
    tx.execute("UPDATE ot.agents SET account = $2, pending_account = NULL, row_version = row_version + 1 WHERE id = $1", &[&n.id, &acc])
        .await?;
    event(tx, org.id, "account", actor, Some(n.id), json!({ "node": n.name, "account": acc })).await?;
    fx.agents.insert(n.id);
    fx.reconfigure.push(n.id);
    fx.events = true;
    let now = chrono::Utc::now();
    Ok(json!({
        "account": acc.clone().unwrap_or_default(),
        "label": info.as_ref().map(|i| i.display()).unwrap_or_else(|| "default".into()),
        "billing_mode": info.as_ref().map(|i| if i.is_apikey() { "metered" } else { "subscription" }).unwrap_or("subscription"),
        "standing": info.as_ref().map(|i| match i.limited(now) {
            Some(u) => json!({ "state": "limited", "until": u.timestamp(), "provenance": "observed" }),
            None => json!({ "state": "ready" }),
        }),
        "session_boundary": false,
    }))
}

/// Start the agent on a fresh session seeded with a digest of the old one;
/// the old transcript is saved in its folder.
#[logged]
async fn cheap_compact(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "compact").await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    let busy = engine.agents.get(n.id).map(|h| h.view.load().get("busy").and_then(Value::as_bool).unwrap_or(false)).unwrap_or(false);
    if busy {
        refuse!(Conflict, "{} is in the middle of a turn; compact it when it is idle", n.name);
    }
    let Some(session) = n.session.clone() else {
        refuse!(Conflict, "{} has no conversation to compact yet", n.name);
    };
    let digest = crate::runtime::convo::digest(tx, n.id, 40).await?;
    let status: Option<Value> = tx.query_one("SELECT last_status FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
    let mut text = String::from(
        "[Orgtree] Your context was compacted: you now run on a fresh session. Here is what you were working on.\n\n",
    );
    if let Some(s) = status.as_ref().and_then(|s| s.get("summary")).and_then(Value::as_str) {
        text.push_str(&format!("Your last status: {s}\n\n"));
    }
    text.push_str(&digest);
    tx.execute(
        "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true, compacted_unrun = true,
                row_version = row_version + 1 WHERE id = $1",
        &[&n.id],
    )
    .await?;
    tx.execute(
        "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'cheap compact' WHERE agent_id = $1 AND session_id = $2",
        &[&n.id, &session],
    )
    .await?;
    let uid = crate::util::uid("m");
    tx.execute(
        "INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_agent_id, recipient_name, kind, notice, body, state)
         VALUES ($1, $2, '@system', 'agent', $3, $4, 'system', true, $5, 'pending')",
        &[&uid, &org.id, &n.id, &n.name, &text],
    )
    .await?;
    event(tx, org.id, "cheap_compact", actor, Some(n.id), json!({ "node": n.name, "old_session": session })).await?;
    fx.agents.insert(n.id);
    fx.reconfigure.push(n.id);
    fx.stop.push(n.id);
    fx.events = true;
    Ok(json!({ "node": n.name, "compacted": true }))
}
