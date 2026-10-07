//! Tree operations: hire, rehire, retire, rescind, delete, dissolve, move,
//! rename, reorder, reallocate, switch model, account, cheap compact. Shared
//! by the canvas (`POST /ops`, user) and the agents' tools (agent: downward
//! only). Each is one short transaction that locks only the rows it changes;
//! credit chains are locked top-down so cascades in different subtrees never
//! wait on each other. Deadlocks and serialization failures are retried.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;

use crate::domain::scope;
use crate::engine::Engine;
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
pub(crate) struct Effects {
    agents: HashSet<i64>,
    stop: Vec<i64>,
    reconfigure: Vec<i64>,
    wake: Vec<i64>,
    /// agents whose CLI warming starts after commit (hires)
    warm: Vec<i64>,
    events: bool,
    mailboxes: Vec<i64>,
    docket: Option<crate::domain::docket::AfterCommit>,
    scratch: Vec<String>,
    registry: bool,
    pulses: Vec<crate::changes::Change>,
    /// watchdogs to stop / start after commit
    dogs_off: Vec<String>,
    dogs_on: Vec<String>,
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
/// descendant grants just enough, stopping at the acting agent's allocation.
/// Plan before writing: a raised child must not be counted twice at its parent.
#[logged]
async fn ensure_room(
    tx: &Transaction<'_>,
    actor: &Actor,
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
    let floor = match actor {
        Actor::User => None,
        Actor::Agent { id, name } => {
            if !ch.iter().any(|n| n.id == *id) {
                refuse!(Conflict, "insufficient credits: {name} cannot draw from outside its allocation");
            }
            Some(*id)
        }
    };
    let mut need = need;
    let mut plan = Vec::new();
    for n in ch.iter().rev() {
        let free = n.grant - hold(tx, n.id).await?;
        if free + 1e-9 >= need { break; }
        if floor == Some(n.id) || !cascade {
            refuse!(Conflict,
                "insufficient credits: {} has {:.2} credits free and this needs {:.2}; ask its superior to raise its grant",
                n.name, free, need);
        }
        let d = (need - free).ceil();
        if n.parent.is_none() && n.grant + d > max_top + 1e-9 {
            refuse!(Conflict, "insufficient credits: {} would need a grant of {:.0}, over the top-level cap of {:.0}",
                n.name, n.grant + d, max_top);
        }
        plan.push((n.id, n.name.clone(), d));
        need = d;
    }
    let mut raised = Vec::new();
    for (id, name, delta) in plan {
        tx.execute(
            "UPDATE ot.agents SET grant_credits = grant_credits + $2::float8::numeric, row_version = row_version + 1 WHERE id = $1",
            &[&id, &delta],
        ).await?;
        fx.agents.insert(id);
        raised.push(name);
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

/// An OpenRouter seat keeps the harness it starts on: stamped at hire (and
/// on a move into the lane), kept on a rehire.
#[logged]
async fn stamp_harness(engine: &Engine, tx: &Transaction<'_>, agent: i64, tier: &str, replace: bool) -> Result<()> {
    if !catalog::is_openrouter(tier) {
        return Ok(());
    }
    let h = crate::openrouter::selected_harness(engine);
    tx.execute(
        "UPDATE ot.agents SET extra = CASE WHEN $3 OR NOT (coalesce(extra, '{}'::jsonb) ? 'harness')
                                    THEN coalesce(extra, '{}'::jsonb) || jsonb_build_object('harness', $2::text)
                                    ELSE extra END
          WHERE id = $1",
        &[&agent, &h, &replace],
    )
    .await?;
    Ok(())
}

/// Validate a selector before storing it; qualified primary selectors also name a provider.
#[logged]
fn validate_account(engine: &Engine, org_slug: &str, tier: &str, raw: Option<&str>) -> Result<()> {
    let provider = catalog::provider_of(tier);
    if let Some(prefix) = raw.and_then(|v| v.strip_suffix("/primary")) {
        if prefix != provider {
            refuse!(BadRequest, "{prefix}/primary cannot serve {provider}");
        }
    }
    if let crate::accounts::Choice::Account(id) = crate::accounts::choice(raw) {
        let view = engine.accounts.view();
        // a legacy org key is refused exactly like an id that does not exist
        let Some(a) = view.get(&id).filter(|a| a.available_to(Some(org_slug))) else { refuse!(NotFound, "no account {id}") };
        if a.provider != provider {
            refuse!(BadRequest, "{id} is a {} account and {tier} runs on {provider}", a.provider);
        }
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
async fn event(tx: &Transaction<'_>, org_id: i64, op: &str, actor: &Actor, subject: Option<i64>, detail: Value, fx: &mut Effects) -> Result<()> {
    tx.execute(
        "INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail) VALUES ($1, $2, $3, $4, $5)",
        &[&org_id, &op, &actor.label(), &subject, &detail],
    )
    .await?;
    fx.pulses.extend(crate::runtime::watchdogs::events::operation(org_id,op,subject,&detail).into_iter().map(crate::changes::Change::EngineEvent));
    fx.mailboxes.extend(super::lifecycle::record(tx, org_id, op, &actor.label(), subject, &detail).await?);
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
async fn run_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, _op: &str, req: &Value, fx: &mut Effects) -> Result<Value> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let out = run_in_tx(engine, org, &tx, actor, req, fx).await?;
    tx.commit().await?;
    Ok(out)
}

/// Caller owns commit/rollback and publishes Effects only after commit.
#[logged]
pub(crate) async fn run_in_tx(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor,
                            req: &Value, fx: &mut Effects) -> Result<Value> {
    let op = req["op"].as_str().unwrap_or("");
    let mut out = match op {
        "hire" => hire(engine, org, &tx, actor, req, fx).await?,
        "rehire" => rehire(engine, org, &tx, actor, req, fx).await?,
        "retire" => retire(org, &tx, actor, req, fx, false).await?,
        "rescind" => retire(org, &tx, actor, req, fx, true).await?,
        "dissolve" => dissolve(org, &tx, actor, req, fx).await?,
        "delete" => delete(org, &tx, actor, req, fx).await?,
        "move" | "promote" | "demote" => move_node(engine, org, &tx, actor, req, fx).await?,
        "rename" => rename(org, &tx, actor, req, fx, false).await?,
        "reallocate" => reallocate(engine, org, &tx, actor, req, fx).await?,
        "switch_model" => switch_model(engine, org, &tx, actor, req, fx).await?,
        "reorder" => reorder(org, &tx, actor, req, fx).await?,
        "account" => account(engine, org, &tx, actor, req, fx).await?,
        "cheap_compact" => cheap_compact(engine, org, &tx, actor, req, fx).await?,
        "swap" => swap(engine, org, &tx, actor, req, fx).await?,
        "self_subjugate" => self_subjugate(engine, org, &tx, actor, req, fx).await?,
        "retool" => retool(engine, org, &tx, actor, req, fx, false).await?,
        "moves" => moves(engine, org, &tx, actor, req, fx).await?,
        other => refuse!(BadRequest, "unknown op {other}"),
    };
    if op == "hire" || op == "rehire" {
        let node = out["node"].as_str().unwrap_or_default().to_string();
        let who = match actor {
            Actor::User => crate::domain::docket::Who::User,
            Actor::Agent { id, name } => {
                let generation: i32 = tx.query_one("SELECT generation FROM ot.agents WHERE id = $1", &[id]).await?.get(0);
                crate::domain::docket::Who::Agent { id: *id, name: name.clone(), generation }
            }
        };
        if let Some(audiences) = req.get("audiences").filter(|v| !v.is_null()) {
            let Some(audiences) = audiences.as_array() else { refuse!(BadRequest, "audiences must be an array") };
            if audiences.len() > 64 { refuse!(BadRequest, "at most 64 audiences per composite"); }
            for target in audiences {
                let Some(target) = target.as_str() else { refuse!(BadRequest, "audience targets must be strings") };
                let (grant, id) = crate::domain::audiences::grant_tx(engine, tx, org, actor, &node, Some(target), "granted with staffing").await?;
                fx.agents.insert(id);
                fx.pulses.push(crate::changes::Change::EngineEvent(crate::runtime::watchdogs::events::event("audience.granted",crate::runtime::watchdogs::events::Scope::Agent(org.id,id),json!({"agent_id":id}))));
                if grant["answered"] == true { fx.wake.push(id); }
                fx.pulses.push(crate::changes::Change::Mailbox(id));
                fx.pulses.push(crate::changes::Change::OrgInbox);
            }
            fx.events = true;
        }
        if let Some(docket) = req.get("staff_item") {
            let mut post = crate::domain::docket::AfterCommit::default();
            let item = crate::domain::docket::staff_tx(&*tx, org, &who, docket, &node, &mut post).await?;
            out["item"] = item["slug"].clone();
            crate::domain::docket::copy_notice_metadata(&item, &mut out);
            fx.docket = Some(post);
        } else if let Some(item) = str_arg(req, "work_item") {
            let mut post = crate::domain::docket::AfterCommit::default();
            crate::domain::docket::assign_tx(&*tx, org, &who, item, &node, true, &mut post).await?;
            out["item"] = json!(item);
            fx.docket = Some(post);
        }
        if let Some(kick) = str_arg(req, "kickoff") {
            let kind = str_arg(req, "kickoff_kind").unwrap_or("request");
            if !["message", "question", "request", "decision", "status"].contains(&kind) {
                refuse!(BadRequest, "unknown kickoff_kind {kind}");
            }
            let target = node_by_name(&tx, org.id, &node).await?;
            let (sender, generation) = match &who {
                crate::domain::docket::Who::User => (None, None),
                crate::domain::docket::Who::Agent { id, generation, .. } => (Some(*id), Some(*generation)),
            };
            let uid = crate::util::uid("m");
            let target_generation: i32 = tx.query_one("SELECT generation FROM ot.agents WHERE id = $1", &[&target.id]).await?.get(0);
            let reason = if req.get("staff_item").is_some() { "staff" } else { op };
            let ev = crate::events::typed("lifecycle.kickoff", &actor.label(), crate::events::node_ref(&org.slug, &node, target_generation as i64),
                json!({ "body": kick, "hired_by": actor.label(), "reason": reason, "tier": target.tier, "grant": target.grant }));
            tx.execute("INSERT INTO ot.mail (uid, org_id, sender, sender_agent_id, sender_generation, recipient_kind, recipient_agent_id, recipient_name, kind, notice, body, state, ev)
                VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, false, $9, 'pending', $10)",
                &[&uid, &org.id, &actor.label(), &sender, &generation, &target.id, &node, &kind, &crate::util::pg_text(&kick).as_ref(), &crate::util::pg_json(&ev).as_ref()]).await?;
            fx.pulses.push(crate::changes::Change::Mailbox(target.id));
            fx.wake.push(target.id);
            out["kickoff"] = json!(uid);
        }
    }
    if crate::runtime::watchdogs::events::interested(engine,"agents.live") {
        let ids=tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state='live'", &[&org.id]).await?.iter().map(|r|r.get(0)).collect();
        fx.pulses.push(crate::changes::Change::EngineEvent(crate::runtime::watchdogs::events::live_count(org.id,ids)));
    }
    Ok(out)
}

#[logged]
pub(crate) async fn apply_effects(engine: &Arc<Engine>, org: &Arc<OrgHandle>, fx: Effects) {
    for path in &fx.scratch { let _ = std::fs::create_dir_all(path); }
    if let Some(post) = fx.docket { post.publish(engine, org); }
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
    for d in &fx.dogs_off {
        crate::runtime::watchdogs::disarm(engine, d);
    }
    for d in &fx.dogs_on {
        crate::runtime::watchdogs::arm(engine, d);
    }
    use crate::changes::Change;
    let mut ch: Vec<Change> = fx.agents.iter().map(|id| Change::Agent(*id)).collect();
    ch.extend(fx.agents.iter().map(|id| Change::History(*id)));
    if crate::runtime::watchdogs::events::interested(engine,"credits.changed") && fx.pulses.iter().any(|p| matches!(p,Change::EngineEvent(e) if matches!(e.name.as_str(),"agent.hired"|"agent.rehired"|"agent.retired"|"agent.moved"|"agent.settings.changed"|"credits.changed"))) {
        let mut credit_ids=fx.agents.clone();
        if let Ok(c)=engine.db.get().await {
            let ids:Vec<i64>=fx.agents.iter().copied().collect();
            if let Ok(rows)=c.query("SELECT DISTINCT parent_id FROM ot.agents WHERE id=ANY($1) AND parent_id IS NOT NULL", &[&ids]).await {for r in rows{credit_ids.insert(r.get(0));}}
        }
        for id in &credit_ids { ch.push(Change::EngineEvent(crate::runtime::watchdogs::events::event("credits.changed",crate::runtime::watchdogs::events::Scope::Agent(org.id,*id),json!({"agent_id":id})))); }
    }
    ch.push(Change::Credits);
    ch.push(Change::Audiences);
    if fx.events {
        ch.push(Change::Events);
    }
    if fx.registry {
        ch.push(Change::Registry);
    }
    if !fx.dogs_off.is_empty() || !fx.dogs_on.is_empty() {
        ch.push(Change::Watchdogs);
    }
    ch.extend(fx.mailboxes.iter().map(|id| Change::Mailbox(*id)));
    ch.extend(fx.pulses);
    crate::changes::notify(engine, org, ch);
    for id in &fx.wake {
        crate::runtime::wake(engine, org.id, *id);
    }
    for id in &fx.warm {
        crate::runtime::warm(engine, org.id, *id);
    }
}

// ------------------------------------------------------------ hire

/// Scope authority is captured under the operation transaction, never a runtime view.
#[logged]
async fn capability(tx: &Transaction<'_>, id: i64, settings: &Value) -> Result<Value> {
    let mut sc = scope::org_ceiling(&settings["dirs"]);
    for n in chain(tx, id).await? { sc = scope::clamp(&n.scope, &sc); }
    Ok(sc)
}

#[logged]
async fn insertion_authority(tx: &Transaction<'_>, actor: &Actor, target: &Node) -> Result<()> {
    if target.state != "live" { refuse!(Conflict, "superior insertion needs a live target"); }
    if let Actor::Agent { id, .. } = actor {
        if target.parent.is_none() { refuse!(Forbidden, "only the user can insert above a top-level agent"); }
        if !within(tx, *id, target.id).await? { refuse!(Forbidden, "insert a superior only above yourself or your reports"); }
    }
    Ok(())
}

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
            if anchor.is_none() && p.id != *id && !within(tx, *id, p.id).await? {
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
        Some(p) => ensure_room(tx, actor, Some(p.id), need, caps.cascade_hire, caps.max_top, fx).await?,
        None => {
            if grant > caps.max_top + 1e-9 {
                refuse!(Conflict, "a top-level grant of {grant:.0} is over this organization's cap of {:.0}", caps.max_top);
            }
            Vec::new()
        }
    };
    let sc = if let Some(a) = &anchor {
        if a.state != "live" { refuse!(Conflict, "superior insertion needs a live target"); }
        insertion_authority(tx, actor, a).await?;
        for field in ["add_dirs", "tools", "org_visibility", "permission_mode"] {
            if !req[field].is_null() { refuse!(BadRequest, "superior insertion inherits target scope; omit {field}"); }
        }
        let target_scope = capability(tx, a.id, &caps.settings).await?;
        let mut inherited = hire_scope(&caps, req);
        for k in ["add_dirs", "tools", "org_visibility", "permission_mode"] { inherited[k] = target_scope[k].clone(); }
        inherited
    } else { hire_scope(&caps, req) };
    // An omitted choice uses only a valid compatible org default, never the
    // parent's bound account. Explicit empty/primary means provider primary.
    let explicit = req.get("account").and_then(Value::as_str);
    let selected = if let Some(raw) = explicit {
        validate_account(engine, &org.slug, &tier, Some(raw))?;
        Some(raw)
    } else {
        caps.settings["default_account"].as_str().filter(|raw| validate_account(engine, &org.slug, &tier, Some(raw)).is_ok())
    };
    let account = match crate::accounts::choice(selected) {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
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
    stamp_harness(engine, tx, id, &tier, true).await?;
    if let Some(h) = str_arg(req, "harness") {
        if !catalog::is_openrouter(&tier) || !["claude-code", "codex-cli"].contains(&h) {
            refuse!(BadRequest, "harness is claude-code or codex-cli for an OpenRouter hire");
        }
        tx.execute("UPDATE ot.agents SET extra = extra || jsonb_build_object('harness', $2::text) WHERE id = $1", &[&id, &h]).await?;
    }
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
                "above": anchor.as_ref().map(|a| a.name.clone()), "cascaded": raised }), fx)
    .await?;
    fx.agents.insert(id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    fx.warm.push(id);
    fx.scratch.push(scratch);
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
    authorize(tx, actor, &n, "rehire").await?;
    let caps = caps(engine, tx, org.id).await?;
    let anchor = if str_arg(req, "hire_type") == Some("superior") {
        let target = str_arg(req, "target").or_else(|| str_arg(req, "parent")).unwrap_or_else(|| match actor { Actor::Agent { name, .. } => name, Actor::User => "@user" });
        let a = node_by_name(tx, org.id, target).await?;
        insertion_authority(tx, actor, &a).await?;
        if a.state != "live" || a.id == n.id || within(tx, n.id, a.id).await? {
            refuse!(Conflict, "superior insertion needs a live target outside the archived subtree");
        }
        for field in ["add_dirs", "tools", "org_visibility", "permission_mode"] {
            if !req[field].is_null() { refuse!(BadRequest, "superior insertion inherits target scope; omit {field}"); }
        }
        Some(a)
    } else { None };
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
    if let Some(a) = &anchor {
        parent = match a.parent { Some(id) => Some(node_by_id(tx, id).await?), None => None };
    }
    if let Some(p) = &parent {
        if p.state != "live" || p.id == n.id || within(tx, n.id, p.id).await? {
            refuse!(Conflict, "rehire destination must be live and outside the archived subtree");
        }
    }
    if let Actor::Agent { id, name } = actor {
        match &parent {
            Some(p) if anchor.is_some() || p.id == *id || within(tx, *id, p.id).await? => {}
            _ => refuse!(Forbidden, "{name} can only rehire under itself or its reports"),
        }
    }
    let tier = str_arg(req, "tier").map(str::to_string).unwrap_or(n.tier.clone());
    let seat = seat_of(engine, &tier)?;
    if !engine.settings.provider_enabled(catalog::provider_of(&tier)) {
        refuse!(Conflict, "provider is disabled for {tier}");
    }
    validate_account(engine, &org.slug, &tier, str_arg(req, "account").or(n.account.as_deref()))?;
    let anchor_stake = anchor.as_ref().map(|a| a.seat + a.grant).unwrap_or(0.0);
    let grant = req["grant"].as_f64().unwrap_or(n.grant);
    if grant < 0.0 { refuse!(BadRequest, "a grant cannot be negative"); }
    let grant = grant + anchor_stake;
    let raised = match &parent {
        Some(p) => ensure_room(tx, actor, Some(p.id), seat + grant - anchor_stake, caps.cascade_hire, caps.max_top, fx).await?,
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
    let inherited_scope = match &anchor {
        Some(a) => {
            let mut inherited = scope::normalize(&n.scope);
            let target_scope = capability(tx, a.id, &caps.settings).await?;
            for k in ["add_dirs", "tools", "org_visibility", "permission_mode"] { inherited[k] = target_scope[k].clone(); }
            Some(inherited)
        }, None => None,
    };
    tx.execute(
        "UPDATE ot.agents SET state = 'live', archived_at = NULL, parent_id = $2, sibling_order = $3, tier = $4,
                seat = $5::float8::numeric, grant_credits = $6::float8::numeric, halt = NULL, row_version = row_version + 1
          WHERE id = $1",
        &[&n.id, &parent_id, &order, &tier, &seat, &grant],
    )
    .await?;
    if let Some(a) = &anchor {
        tx.execute("UPDATE ot.agents SET scope = $2, provider = $3, sibling_order = (SELECT sibling_order FROM ot.agents WHERE id = $4) WHERE id = $1",
            &[&n.id, inherited_scope.as_ref().unwrap(), &catalog::provider_of(&tier), &a.id]).await?;
        tx.execute("UPDATE ot.agents SET parent_id = $2, sibling_order = 1, row_version = row_version + 1 WHERE id = $1", &[&a.id, &n.id]).await?;
        fx.agents.insert(a.id);
        fx.reconfigure.push(a.id);
    } else {
        tx.execute("UPDATE ot.agents SET provider = $2 WHERE id = $1", &[&n.id, &catalog::provider_of(&tier)]).await?;
    }
    let mut scope_req = req.clone();
    if let Some(raw) = str_arg(req, "account") {
        let selected = match crate::accounts::choice(Some(raw)) {
            crate::accounts::Choice::Account(a) => Some(a), _ => None,
        };
        tx.execute("UPDATE ot.agents SET account = $2, pending_account = NULL WHERE id = $1", &[&n.id, &selected]).await?;
        event(tx, org.id, "account", actor, Some(n.id), json!({ "node": n.name, "account": selected }), fx).await?;
        scope_req.as_object_mut().unwrap().remove("account");
    }
    // Placement was authorized before mutation. Self-superior insertion has
    // now moved this caller beneath the restored seat; do not reauthorize
    // that already-approved composite against its changed topology.
    retool(engine, org, tx, actor, &scope_req, fx, anchor.is_some()).await?;
    let name = if let Some(new) = str_arg(req, "name") {
        rename(org, tx, actor, &json!({ "node": n.name, "name": new }), fx, anchor.is_some()).await?;
        new.to_string()
    } else { n.name.clone() };
    stamp_harness(engine, tx, n.id, &tier, false).await?;
    event(tx, org.id, "rehire", actor, Some(n.id), json!({ "node": n.name, "parent": parent.as_ref().map(|p| p.name.clone()),
          "tier": tier, "grant": grant, "cascaded": raised }), fx)
    .await?;
    fx.agents.insert(n.id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    fx.wake.push(n.id);
    fx.warm.push(n.id);
    let woke = crate::runtime::watchdogs::resume_owned(tx, n.id).await?;
    let mut warnings = Vec::new();
    if !woke.is_empty() {
        warnings.push(format!(
            "{} watchdog(s) paused by the archive are armed again: {}",
            woke.len(),
            woke.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    fx.dogs_on.extend(woke.into_iter().map(|(id, _)| id));
    Ok(json!({ "node": name, "cascaded": raised, "warnings": warnings }))
}

/// Closed seats cannot leave actionable request cards behind.
#[logged]
async fn moot_asks(tx: &Transaction<'_>, ids: &[i64], fx: &mut Effects) -> Result<()> {
    tx.execute("UPDATE ot.asks SET status = 'withdrawn', resolved_at = now(), reason = 'requester is no longer live' WHERE agent_id = ANY($1) AND status = 'open'", &[&ids]).await?;
    fx.pulses.extend([crate::changes::Change::Asks, crate::changes::Change::Docket]);
    Ok(())
}

#[logged]
async fn retire(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, rescind: bool) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !rescind && n.state == "archived" {
        if !matches!(actor, Actor::Agent { id, .. } if *id == n.id) { authorize(tx, actor, &n, "retire").await?; }
        return Ok(json!({"freed":0,"warnings":[format!("{} was already archived — nothing to do",n.name)]}));
    }
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    if rescind && !matches!(actor, Actor::User) {
        refuse!(Forbidden, "only the user can rescind");
    }
    let team = subtree(tx, n.id).await?;
    match actor {
        // an agent may retire itself once it has no live reports
        Actor::Agent { id, .. } if *id == n.id => {
            if !team.is_empty() {
                refuse!(Conflict, "you still have live reports; retire or hand them over first");
            }
        }
        _ => authorize(tx, actor, &n, "retire").await?,
    }
    // a seat with live reports takes its whole team with it
    let mut ids = team.clone();
    ids.push(n.id);
    let rows = tx
        .query(
            "UPDATE ot.agents SET state = 'archived', archived_at = now(), inflight_at = NULL, row_version = row_version + 1
              WHERE id = ANY($1) AND state = 'live' RETURNING id",
            &[&ids],
        )
        .await?;
    let kids: Vec<i64> = rows.iter().map(|r| r.get::<_, i64>(0)).filter(|id| *id != n.id).collect();
    moot_asks(tx, &ids, fx).await?;
    fx.dogs_off.extend(crate::runtime::watchdogs::pause_owned(tx, &ids).await?);
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
          json!({ "node": n.name, "team_retired": kids.len(), "clawed_back": clawed }), fx)
    .await?;
    fx.agents.insert(n.id);
    fx.agents.extend(kids.iter().copied());
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.stop.push(n.id);
    fx.stop.extend(kids.iter().copied());
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
    moot_asks(tx, &done, fx).await?;
    fx.dogs_off.extend(crate::runtime::watchdogs::pause_owned(tx, &done).await?);
    event(tx, org.id, "dissolve", actor, Some(n.id), json!({ "node": n.name, "nodes": done.len() }), fx).await?;
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
    moot_asks(tx, &ids, fx).await?;
    let gone = tx
        .query(
            "UPDATE ot.watchdogs SET state = 'removed' WHERE owner_agent_id = ANY($1) AND state IN ('armed', 'paused', 'exited') RETURNING uid",
            &[&ids],
        )
        .await?;
    fx.dogs_off.extend(gone.iter().map(|r| r.get::<_, String>(0)));
    event(tx, org.id, "delete", actor, Some(n.id), json!({ "node": n.name, "nodes": ids.len() }), fx).await?;
    fx.agents.extend(ids.iter().copied());
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.stop.extend(ids.iter().copied());
    fx.events = true;
    Ok(json!({ "node": n.name, "nodes": ids.len() }))
}

/// The batch stages parent changes in its existing transaction, accumulating
/// exact 3.x release/acquire deltas before checking or writing any grants.
#[derive(Debug, Default)]
struct MoveCredits {
    deltas: BTreeMap<i64, f64>,
    check: BTreeSet<i64>,
}

#[logged]
async fn finish_move_credits(engine: &Engine, org: &OrgHandle, tx: &Transaction<'_>, credits: MoveCredits, fx: &mut Effects) -> Result<()> {
    let caps = caps(engine, tx, org.id).await?;
    let ids: Vec<i64> = credits.deltas.keys().copied().collect();
    let deltas: Vec<f64> = credits.deltas.values().copied().collect();
    for id in &credits.check {
        let n = node_by_id(tx, *id).await?;
        let grant = n.grant + credits.deltas.get(id).copied().unwrap_or(0.0);
        let hold: f64 = tx.query_one(
            "SELECT coalesce(sum(a.seat + a.grant_credits + coalesce(d.delta,0)),0)::float8
               FROM ot.agents a LEFT JOIN unnest($2::bigint[], $3::float8[]) AS d(id,delta) ON d.id=a.id
              WHERE a.parent_id=$1 AND a.state='live'", &[id, &ids, &deltas]).await?.get(0);
        if grant < -1e-9 || grant + 1e-9 < hold {
            refuse!(Conflict, "insufficient credits: moving would leave {} with grant {:.2} for {:.2} held credits", n.name, grant, hold);
        }
        if n.parent.is_none() && grant > caps.max_top + 1e-9 {
            refuse!(Conflict, "insufficient credits: moving would put {} over the top-level grant cap of {:.0}", n.name, caps.max_top);
        }
    }
    for (id, delta) in credits.deltas {
        if delta.abs() < 1e-9 { continue; }
        tx.execute("UPDATE ot.agents SET grant_credits=grant_credits+$2::float8::numeric, row_version=row_version+1 WHERE id=$1", &[&id,&delta]).await?;
        fx.agents.insert(id);
    }
    Ok(())
}

#[logged]
async fn move_node(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let mut credits = MoveCredits::default();
    let out = move_planned(org, tx, actor, req, &mut credits, fx).await?;
    finish_move_credits(engine, org, tx, credits, fx).await?;
    Ok(out)
}

#[logged]
async fn move_planned(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, credits: &mut MoveCredits, fx: &mut Effects) -> Result<Value> {
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
    let stake = n.seat + n.grant + credits.deltas.get(&n.id).copied().unwrap_or(0.0);
    let old_chain = match n.parent { Some(id) => chain(tx, id).await?, None => Vec::new() };
    let new_chain = match &target { Some(t) => chain(tx, t.id).await?, None => Vec::new() };
    let shared = old_chain.iter().zip(&new_chain).take_while(|(a,b)| a.id == b.id).count();
    // The LCA keeps exactly the same hold/free. Both sides carry the same
    // subtree stake, even if an earlier batch leg changed that subtree's grant.
    for hop in old_chain.iter().skip(shared) {
        *credits.deltas.entry(hop.id).or_default() -= stake;
    }
    let mut raised = Vec::new();
    for hop in new_chain.iter().skip(shared) {
        *credits.deltas.entry(hop.id).or_default() += stake;
        if stake > 1e-9 { raised.push(hop.name.clone()); }
    }
    credits.check.insert(n.id);
    credits.check.extend(old_chain.iter().chain(&new_chain).map(|n| n.id));
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
    event(tx, org.id, "move", actor, Some(n.id), json!({ "node": n.name, "to": target.as_ref().map(|t| t.name.clone()), "old_parent_id": n.parent,
          "cascaded": raised }), fx)
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
async fn rename(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, preauthorized: bool) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !preauthorized { authorize(tx, actor, &n, "rename").await?; }
    let new = valid_name(str_arg(req, "name").unwrap_or(""))?;
    if new == n.name {
        return Ok(json!({ "node": new, "unchanged": true }));
    }
    name_free(tx, org.id, &new).await?;
    tx.execute("UPDATE ot.agents SET name = $2, row_version = row_version + 1 WHERE id = $1", &[&n.id, &new]).await?;
    // names are how audiences address agents
    tx.execute("UPDATE ot.audiences SET grantee = $3 WHERE org_id = $1 AND grantee = $2", &[&org.id, &n.name, &new]).await?;
    tx.execute("UPDATE ot.audiences SET grantor = $3 WHERE org_id = $1 AND grantor = $2", &[&org.id, &n.name, &new]).await?;
    tx.execute(
        "UPDATE ot.audience_requests SET requester = CASE WHEN requester = $2 THEN $3 ELSE requester END,
                target = CASE WHEN target = $2 THEN $3 ELSE target END, holder = CASE WHEN holder = $2 THEN $3 ELSE holder END
          WHERE org_id = $1 AND status = 'pending' AND (requester = $2 OR target = $2 OR holder = $2)",
        &[&org.id, &n.name, &new],
    )
    .await?;
    tx.execute("UPDATE ot.watchdogs SET target = $3 WHERE org_id = $1 AND kind = 'activity' AND target = $2", &[&org.id, &n.name, &new])
        .await?;
    event(tx, org.id, "rename", actor, Some(n.id), json!({ "was": n.name, "node": new }), fx).await?;
    fx.agents.insert(n.id);
    fx.reconfigure.push(n.id);
    fx.events = true;
    fx.pulses.push(crate::changes::Change::Pulse {
        node: new.clone(),
        event: "renamed",
        extra: Some(json!({ "was": n.name })),
    });
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
            Some(p) => raised = ensure_room(tx, actor, Some(p), delta, caps.cascade_alloc, caps.max_top, fx).await?,
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
    event(tx, org.id, "reallocate", actor, Some(n.id), json!({ "node": n.name, "delta": delta, "cascaded": raised }), fx).await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.events = true;
    Ok(json!({ "node": n.name, "grant": n.grant + delta, "cascaded": raised }))
}

#[logged]
async fn busy(tx: &Transaction<'_>, id: i64) -> Result<bool> {
    Ok(tx.query_one("SELECT inflight_at IS NOT NULL OR EXISTS (SELECT 1 FROM ot.turns WHERE agent_id = $1 AND ended_at IS NULL) FROM ot.agents WHERE id = $1", &[&id]).await?.get(0))
}

/// The agent row is locked by the caller. row_version is the durable request
/// order, so equal wall-clock timestamps never reorder two configuration intents.
#[logged]
async fn queue_config(tx: &Transaction<'_>, n: &Node, actor: &Actor, mut intent: Value, model: bool) -> Result<Option<Value>> {
    let column = if model { "pending_switch" } else { "pending_account" };
    let row = tx.query_one(&format!("SELECT {column}, row_version FROM ot.agents WHERE id = $1"), &[&n.id]).await?;
    let previous: Option<Value> = row.get(0);
    let seq: i64 = row.get::<_, i64>(1) + 1;
    intent["seq"] = json!(seq);
    intent["at"] = json!(chrono::Utc::now().to_rfc3339());
    intent["by"] = json!(actor.label());
    intent["actor_id"] = match actor { Actor::User => Value::Null, Actor::Agent { id, .. } => json!(id) };
    tx.execute(&format!("UPDATE ot.agents SET {column} = $2, row_version = $3 WHERE id = $1"), &[&n.id, &intent, &seq]).await?;
    Ok(previous)
}

#[logged]
async fn switch_model(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    authorize(tx, actor, &n, "switch the model of").await?;
    let tier = str_arg(req, "tier").unwrap_or("").to_string();
    if tier == n.tier {
        let previous: Option<Value> = tx.query_one("SELECT pending_switch FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
        tx.execute("UPDATE ot.agents SET pending_switch = NULL, row_version = row_version + 1 WHERE id = $1", &[&n.id]).await?;
        if let Some(previous) = previous {
            event(tx, org.id, "switch_cancelled", actor, Some(n.id), json!({ "node": n.name, "target": previous["tier"], "by": actor.label() }), fx).await?;
            fx.events = true;
        }
        fx.agents.insert(n.id);
        return Ok(json!({ "node": n.name, "tier": tier, "unchanged": true }));
    }
    let seat = seat_of(engine, &tier)?;
    let from = catalog::provider_of(&n.tier);
    let to = catalog::provider_of(&tier);
    if !engine.settings.provider_enabled(to) {
        refuse!(Conflict, "{} is turned off in App settings", catalog::provider_label(to));
    }
    validate_account(engine, &org.slug, &tier, str_arg(req, "account"))?;
    if busy(tx, n.id).await? {
        let replaced = queue_config(tx, &n, actor, json!({ "tier": tier, "from": n.tier, "crossing": from != to, "account": req["account"] }), true).await?;
        event(tx, org.id, "switch_queued", actor, Some(n.id), json!({ "node": n.name, "old": n.tier, "new": tier, "by": actor.label() }), fx).await?;
        fx.agents.insert(n.id);
        fx.events = true;
        return Ok(json!({ "node": n.name, "queued": true, "pending_switch": tier, "replaced": replaced }));
    }
    let caps = caps(engine, tx, org.id).await?;
    let raised = if seat > n.seat && n.state == "live" {
        ensure_room(tx, actor, n.parent, seat - n.seat, caps.cascade_alloc, caps.max_top, fx).await?
    } else {
        Vec::new()
    };
    validate_account(engine, &org.slug, &tier, str_arg(req, "account"))?;
    let picked = crate::accounts::choice(str_arg(req, "account"));
    let clear = picked == crate::accounts::Choice::Primary;
    let account = match picked {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
    let mut warnings = Vec::new();
    if from != to {
        // a new provider starts a fresh session; the old transcript stays in the folder
        // the next turn starts with a summary of the conversation (the CLIs
        // cannot resume each other's sessions)
        let why = format!("moved from {} to {}", catalog::provider_label(from), catalog::provider_label(to));
        tx.execute(
            "UPDATE ot.agents SET tier = $2, seat = $3::float8::numeric, provider = $4, session_id = NULL,
                    account = $5, extra = jsonb_set(extra, '{handoff_due}', to_jsonb($6::text)),
                    occupancy = NULL, row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &tier, &seat, &to, &account, &why],
        )
        .await?;
        tx.execute(
            "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'provider switch' WHERE agent_id = $1 AND ended_at IS NULL",
            &[&n.id],
        )
        .await?;
        stamp_harness(engine, tx, n.id, &tier, true).await?;
        warnings.push(format!(
            "{} moved from {} to {}: it continues on a fresh session that starts with a summary of its conversation (the whole conversation is saved in its folder)",
            n.name,
            catalog::provider_label(from),
            catalog::provider_label(to)
        ));
    } else {
        tx.execute(
            "UPDATE ot.agents SET tier = $2, seat = $3::float8::numeric,
                    account = CASE WHEN $5 THEN NULL ELSE coalesce($4, account) END, row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &tier, &seat, &account, &clear],
        )
        .await?;
    }
    tx.execute("UPDATE ot.agents SET pending_switch = NULL WHERE id = $1", &[&n.id]).await?;
    event(tx, org.id, "switch_model", actor, Some(n.id), json!({ "node": n.name, "from": n.tier, "to": tier, "seat_old": n.seat, "old_session": n.session, "cascaded": raised }), fx).await?;
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
    let pending: Option<Value> = tx.query_one("SELECT pending_switch FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
    let target_tier = pending.as_ref().and_then(|p| p["tier"].as_str()).unwrap_or(&n.tier);
    validate_account(engine, &org.slug, target_tier, str_arg(req, "account"))?;
    let acc = match crate::accounts::choice(str_arg(req, "account")) {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
    if busy(tx, n.id).await? {
        if acc == n.account {
            tx.execute("UPDATE ot.agents SET pending_account = NULL, row_version = row_version + 1 WHERE id = $1", &[&n.id]).await?;
            event(tx, org.id, "account_queue_cancelled", actor, Some(n.id), json!({ "node": n.name, "account": acc }), fx).await?;
            fx.agents.insert(n.id); fx.events = true;
            return Ok(json!({ "node": n.name, "queued": false, "cancelled": true }));
        }
        let replaced = queue_config(tx, &n, actor, json!({ "account": acc.clone().unwrap_or_else(|| "primary".into()), "from": n.account.clone().unwrap_or_else(|| "primary".into()) }), false).await?;
        event(tx, org.id, "account_queued", actor, Some(n.id), json!({ "node": n.name, "account": acc, "by": actor.label() }), fx).await?;
        fx.agents.insert(n.id); fx.events = true;
        return Ok(json!({ "node": n.name, "queued": true, "pending_account": acc, "replaced": replaced }));
    }
    let frozen: Option<Value> = tx.query_one("SELECT frozen FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
    let auth = frozen.as_ref().is_some_and(|f| matches!(f["cause"].as_str(), Some("auth" | "balance")) || f["untrusted"] == true);
    if frozen.as_ref().is_some_and(|f| f["limit"] == true) && !auth {
        refuse!(Conflict, "usage-limit freeze requires continue-on or unstick; an account rebind cannot release it");
    }
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
    tx.execute("UPDATE ot.agents SET account = $2, pending_account = NULL, frozen = CASE WHEN $3 THEN NULL ELSE frozen END, row_version = row_version + 1 WHERE id = $1", &[&n.id, &acc, &auth])
        .await?;
    event(tx, org.id, "account", actor, Some(n.id), json!({ "node": n.name, "account": acc }), fx).await?;
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
    // the next turn starts with the handoff (last status, recent conversation)
    // and the whole conversation is saved in the agent's folder (sign-off I2)
    tx.execute(
        "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true, compacted_unrun = true,
                extra = jsonb_set(extra, '{handoff_due}', to_jsonb('your context was compacted (cheap compact)'::text)),
                row_version = row_version + 1 WHERE id = $1",
        &[&n.id],
    )
    .await?;
    tx.execute(
        "UPDATE ot.agent_sessions SET ended_at = now(), end_reason = 'cheap compact' WHERE agent_id = $1 AND session_id = $2",
        &[&n.id, &session],
    )
    .await?;
    event(tx, org.id, "cheap_compact", actor, Some(n.id), json!({ "node": n.name, "old_session": session }), fx).await?;
    fx.agents.insert(n.id);
    fx.reconfigure.push(n.id);
    fx.stop.push(n.id);
    fx.events = true;
    Ok(json!({ "node": n.name, "compacted": true }))
}

// ------------------------------------------------------------ seats

/// Two agents exchange seats: each seat keeps its superior, reports, grant,
/// team charter and scope; each agent keeps its identity, session, charter,
/// tier and mailbox. Only the tier's seat price moves with the agent.
#[logged]
async fn swap(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let a = node_by_name(tx, org.id, str_arg(req, "a").unwrap_or("")).await?;
    let b = node_by_name(tx, org.id, str_arg(req, "b").unwrap_or("")).await?;
    if a.id == b.id {
        refuse!(BadRequest, "an agent cannot swap with itself");
    }
    if a.state != "live" || b.state != "live" {
        refuse!(Conflict, "both agents must be live");
    }
    authorize(tx, actor, &a, "swap").await?;
    authorize(tx, actor, &b, "swap").await?;
    if matches!(actor, Actor::Agent { .. }) && (a.parent.is_none() || b.parent.is_none()) {
        refuse!(Forbidden, "only the user reseats the top level");
    }
    let caps = caps(engine, tx, org.id).await?;
    // the superior of each seat now holds the other agent's seat price
    let mut raised = Vec::new();
    if b.seat > a.seat {
        raised.extend(ensure_room(tx, actor, a.parent.filter(|p| *p != b.id), b.seat - a.seat, caps.cascade_alloc, caps.max_top, fx).await?);
    }
    if a.seat > b.seat {
        raised.extend(ensure_room(tx, actor, b.parent.filter(|p| *p != a.id), a.seat - b.seat, caps.cascade_alloc, caps.max_top, fx).await?);
    }
    let a_parent = if b.parent == Some(a.id) { Some(b.id) } else { b.parent };
    let b_parent = if a.parent == Some(b.id) { Some(a.id) } else { a.parent };
    // reports follow the seat
    tx.execute(
        "UPDATE ot.agents SET parent_id = CASE WHEN parent_id = $1 THEN $2 ELSE $1 END, row_version = row_version + 1
          WHERE parent_id IN ($1, $2) AND id NOT IN ($1, $2) AND state <> 'deleted'",
        &[&a.id, &b.id],
    )
    .await?;
    let ra = tx
        .query_one("SELECT sibling_order, grant_credits::float8, team_charter, scope FROM ot.agents WHERE id = $1", &[&a.id])
        .await?;
    let rb = tx
        .query_one("SELECT sibling_order, grant_credits::float8, team_charter, scope FROM ot.agents WHERE id = $1", &[&b.id])
        .await?;
    for (id, parent, r) in [(a.id, a_parent, &rb), (b.id, b_parent, &ra)] {
        let order: f64 = r.get(0);
        let grant: f64 = r.get(1);
        let team: Option<String> = r.get(2);
        let sc: Value = r.get(3);
        tx.execute(
            "UPDATE ot.agents SET parent_id = $2, sibling_order = $3, grant_credits = $4::float8::numeric, team_charter = $5,
                    scope = $6, row_version = row_version + 1 WHERE id = $1",
            &[&id, &parent, &order, &grant, &team, &sc],
        )
        .await?;
    }
    event(tx, org.id, "swap", actor, Some(a.id), json!({ "a": a.name, "b": b.name, "old_parent_a": a.parent, "old_parent_b": b.parent, "cascaded": raised }), fx).await?;
    for id in [Some(a.id), Some(b.id), a.parent, b.parent].into_iter().flatten() {
        fx.agents.insert(id);
    }
    let mut moved = subtree(tx, a.id).await?;
    moved.extend(subtree(tx, b.id).await?);
    fx.agents.extend(moved.iter().copied());
    fx.reconfigure.extend([a.id, b.id]);
    fx.reconfigure.extend(moved);
    fx.events = true;
    Ok(json!({ "a": a.name, "b": b.name, "cascaded": raised }))
}

/// The caller steps down: one of its live descendants takes its place under
/// its superior (keeping its own team) and the caller becomes its report
/// with the rest of its subtree.
#[logged]
async fn self_subjugate(_engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let Actor::Agent { id: me_id, .. } = actor else {
        refuse!(Forbidden, "self-subjugation is an agent's own act");
    };
    let me = node_by_id(tx, *me_id).await?;
    let d = node_by_name(tx, org.id, str_arg(req, "target").unwrap_or("")).await?;
    if d.state != "live" {
        refuse!(Conflict, "{} is not live", d.name);
    }
    if d.id == me.id || !within(tx, me.id, d.id).await? {
        refuse!(Forbidden, "{} is not below you; you can only raise one of your own descendants", d.name);
    }
    // the superior's hold is unchanged: the promoted agent takes over the caller's whole stake
    let stake = me.seat + me.grant;
    let d_grant = (stake - d.seat).max(0.0);
    // what the promoted agent then holds: the caller (seat + its remaining grant) and its own team
    let d_team_hold = hold(tx, d.id).await?;
    let me_grant = (me.grant - (d.seat + d.grant)).max(hold(tx, me.id).await? - (d.seat + d.grant)).max(0.0);
    let need = me.seat + me_grant + d_team_hold - d_grant;
    let raised = if need > 1e-9 {
        refuse!(
            Conflict,
            "{} would need {:.2} more credits to hold you and its own team; reallocate before stepping down",
            d.name, need
        );
    } else {
        Vec::<String>::new()
    };
    let old_parent = d.parent;
    tx.execute(
        "UPDATE ot.agents SET parent_id = $2, sibling_order = (SELECT sibling_order FROM ot.agents WHERE id = $3),
                grant_credits = $4::float8::numeric, scope = $5, row_version = row_version + 1 WHERE id = $1",
        &[&d.id, &me.parent, &me.id, &d_grant, &me.scope],
    )
    .await?;
    tx.execute(
        "UPDATE ot.agents SET parent_id = $2, sibling_order = 1, grant_credits = $3::float8::numeric, row_version = row_version + 1 WHERE id = $1",
        &[&me.id, &d.id, &me_grant],
    )
    .await?;
    event(tx, org.id, "self_subjugate", actor, Some(me.id), json!({ "node": me.name, "promoted": d.name, "old_parent_id": old_parent, "cascaded": raised }), fx).await?;
    for id in [Some(me.id), Some(d.id), me.parent, old_parent].into_iter().flatten() {
        fx.agents.insert(id);
    }
    fx.reconfigure.extend([me.id, d.id]);
    fx.events = true;
    Ok(json!({ "node": me.name, "promoted": d.name }))
}

/// Several moves as one all-or-nothing act (`moves: [{node, new_parent}]`).
#[logged]
async fn moves(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let list = req["moves"].as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        refuse!(BadRequest, "moves is a list of {{node, new_parent}}");
    }
    let mut done = Vec::new();
    let mut credits = MoveCredits::default();
    if list.len() > 20 { refuse!(BadRequest, "at most 20 moves per batch (got {})", list.len()); }
    for m in list {
        let one = json!({ "op": "move", "node": m["node"], "new_parent": m["new_parent"] });
        done.push(move_planned(org, tx, actor, &one, &mut credits, fx).await?);
    }
    finish_move_credits(engine, org, tx, credits, fx).await?;
    Ok(json!({ "moved": done.len(), "moves": done }))
}

/// Re-scope a node below the caller (folders, tools, visibility, permission
/// mode, effort, charter, team charter, account); on itself only the team
/// charter. Grants are checked against the caller and raised through intermediates.
#[logged]
async fn retool(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, preauthorized: bool) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    let own = matches!(actor, Actor::Agent { id, .. } if *id == n.id);
    if own {
        let fields: Vec<&str> = req.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
        if fields.iter().any(|k| !["op", "node", "team_charter"].contains(k)) {
            refuse!(Forbidden, "on yourself only team_charter can change; ask your superior for the rest");
        }
    } else if !preauthorized {
        authorize(tx, actor, &n, "retool").await?;
    }
    let mut sc = scope::normalize(&n.scope);
    let o = sc.as_object_mut().unwrap();
    if let Some(d) = req.get("add_dirs").filter(|v| v.is_array()) {
        o.insert("add_dirs".into(), scope::normalize(&json!({ "add_dirs": d }))["add_dirs"].clone());
    }
    if let Some(t) = req.get("tools").filter(|v| v.is_object()) {
        let mut cur = o.get("tools").cloned().unwrap_or_else(scope::default_tools);
        crate::settings::deep_merge(&mut cur, t);
        o.insert("tools".into(), scope::normalize_tools(&cur));
    }
    if let Some(v) = str_arg(req, "org_visibility") {
        if !scope::VIS_LEVELS.contains(&v) {
            refuse!(BadRequest, "unknown visibility {v}");
        }
        o.insert("org_visibility".into(), json!(v));
    }
    if let Some(v) = str_arg(req, "permission_mode") {
        if !scope::PM_LEVELS.contains(&v) {
            refuse!(BadRequest, "unknown permission mode {v}");
        }
        o.insert("permission_mode".into(), json!(v));
    }
    if let Some(v) = req.get("effort").and_then(Value::as_str) {
        if v.is_empty() {
            o.remove("effort");
        } else if catalog::EFFORTS.contains(&v) {
            o.insert("effort".into(), json!(v));
        } else {
            refuse!(BadRequest, "unknown effort {v}");
        }
    }
    if req.get("clear_account_fallback").and_then(Value::as_bool).unwrap_or(false) {
        o.remove("account_fallback");
    } else if let Some(b) = req.get("account_fallback").and_then(Value::as_bool) {
        o.insert("account_fallback".into(), json!(b));
    }
    let mut granted = json!({});
    for k in ["add_dirs", "tools", "org_visibility", "permission_mode"] {
        if req.get(k).is_some_and(|v| !v.is_null()) { granted[k] = sc[k].clone(); }
    }
    let settings = caps(engine, tx, org.id).await?.settings;
    if let Actor::Agent { id, .. } = actor {
        scope::require_grant(&granted, &capability(tx, *id, &settings).await?)?;
    }
    let mut cascaded = Vec::new();
    if granted.as_object().is_some_and(|o| !o.is_empty()) {
        let ancestors = chain(tx, n.id).await?;
        let mut below_actor = matches!(actor, Actor::User);
        for a in ancestors.iter().filter(|a| a.id != n.id) {
            if matches!(actor, Actor::Agent { id, .. } if *id == a.id) { below_actor = true; continue; }
            if !below_actor { continue; }
            let raised = scope::raise(&a.scope, &granted);
            if raised != scope::normalize(&a.scope) {
                tx.execute("UPDATE ot.agents SET scope=$2, row_version=row_version+1 WHERE id=$1", &[&a.id,&raised]).await?;
                cascaded.push(a.name.clone());
                fx.agents.insert(a.id);
                fx.reconfigure.push(a.id);
                let descendants = subtree(tx, a.id).await?;
                fx.agents.extend(descendants.iter().copied());
                fx.reconfigure.extend(descendants);
                event(tx,org.id,"retool",actor,Some(a.id),json!({"node":a.name,"change":granted,"cascade_for":n.name}),fx).await?;
            }
        }
        // A user grant reaching the top level enters the org's defaults too.
        if matches!(actor, Actor::User) {
            let stored: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR UPDATE", &[&org.id]).await?.get(0);
            let base = json!({"add_dirs":settings["dirs"],"tools":settings["default_tools"],"org_visibility":settings["default_visibility"],"permission_mode":settings["permission_mode"]});
            let raised = scope::raise(&base,&granted);
            let mut next = stored;
            for (key, field) in [("add_dirs","dirs"),("tools","default_tools"),("org_visibility","default_visibility"),("permission_mode","permission_mode")] {
                if granted.get(key).is_some() { next[field] = raised[key].clone(); }
            }
            tx.execute("UPDATE ot.orgs SET settings=$2 WHERE id=$1", &[&org.id,&next]).await?;
            fx.pulses.push(crate::changes::Change::Org);
        }
    }
    let charter = str_arg(req, "charter").map(str::to_string);
    let team = str_arg(req, "team_charter").map(str::to_string);
    let account_result = if str_arg(req, "account").is_some() {
        Some(account(engine, org, tx, actor, req, fx).await?)
    } else { None };
    tx.execute(
        "UPDATE ot.agents SET scope = $2, charter = coalesce($3, charter), team_charter = coalesce($4, team_charter),
                row_version = row_version + 1 WHERE id = $1",
        &[&n.id, &sc, &charter, &team],
    )
    .await?;
    event(tx, org.id, "retool", actor, Some(n.id), json!({ "node": n.name, "change": req }), fx).await?;
    fx.agents.insert(n.id);
    let below = subtree(tx, n.id).await?;
    if granted.as_object().is_some_and(|o| !o.is_empty()) {
        let settings = caps(engine, tx, org.id).await?.settings;
        let mut effective = std::collections::HashMap::new();
        effective.insert(n.id, capability(tx,n.id,&settings).await?);
        for id in &below {
            let child = node_by_id(tx,*id).await?;
            let Some(parent) = child.parent.and_then(|id| effective.get(&id)) else { refuse!(Conflict,"scope subtree changed during retool"); };
            let bounded = scope::clamp(&child.scope,parent);
            if bounded != scope::normalize(&child.scope) {
                tx.execute("UPDATE ot.agents SET scope=$2,row_version=row_version+1 WHERE id=$1", &[id,&bounded]).await?;
            }
            effective.insert(*id,bounded);
        }
    }
    fx.agents.extend(below.iter().copied());
    fx.reconfigure.push(n.id);
    fx.reconfigure.extend(below);
    fx.events = true;
    let mut out = account_result.unwrap_or_else(|| json!({}));
    out["cascaded"] = json!(cascaded);
    if !cascaded.is_empty() { out["warnings"] = json!([format!("cascaded permission increase to agents {}", cascaded.join(", "))]); }
    out["node"] = json!(n.name);
    Ok(out)
}

/// Consume pending intents only after a turn has settled. An operation failure
/// rolls back to the savepoint; dropping the request and its explanation commit
/// together, leaving the former configuration intact.
#[logged]
pub(crate) async fn apply_pending(engine: &Arc<Engine>, org: &Arc<OrgHandle>, id: i64) -> Result<bool> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let n = node_by_id(&tx, id).await?;
    if n.state != "live" || busy(&tx, id).await? { return Ok(false); }
    let row = tx.query_one("SELECT pending_switch, pending_account FROM ot.agents WHERE id = $1", &[&id]).await?;
    let mut sw: Option<Value> = row.get(0);
    let ap: Option<Value> = row.get(1);
    if sw.is_none() && ap.is_none() { return Ok(false); }
    let mut fx = Effects::default();
    // Newer account intent wins; an older account still composes with a model
    // request that did not choose its own account. Legacy stamps break only
    // legacy ties; all new intents have a monotonic per-row sequence.
    if let (Some(model), Some(account)) = (sw.as_mut(), ap.as_ref()) {
        let newer = match (account["seq"].as_i64(), model["seq"].as_i64()) {
            (Some(a), Some(b)) => a > b, (Some(_), None) => true, (None, Some(_)) => false,
            _ => account["at"].as_str().unwrap_or("") > model["at"].as_str().unwrap_or(""),
        };
        let want = account["account"].as_str().unwrap_or("primary");
        if newer || model["account"].as_str().map_or(true, str::is_empty) {
            match validate_account(engine, &org.slug, model["tier"].as_str().unwrap_or(""), Some(want)) {
                Ok(()) => model["account"] = json!(want),
                Err(e) => event(&tx, org.id, "account_queue_dropped", &Actor::User, Some(id), json!({ "node": n.name, "account": want, "reason": e.to_string() }), &mut fx).await?,
            }
        } else {
            event(&tx, org.id, "account_queue_dropped", &Actor::User, Some(id), json!({ "node": n.name, "account": want, "reason": "superseded by a later model/account choice" }), &mut fx).await?;
        }
    }
    let intent = sw.as_ref().or(ap.as_ref()).unwrap();
    let authority = pending_actor(&tx, org.id, intent).await;
    let actor = authority.as_ref().cloned().unwrap_or(Actor::User);
    // Clear before applying: account validation must not see an obsolete target.
    tx.execute("UPDATE ot.agents SET pending_switch = NULL, pending_account = NULL, row_version = row_version + 1 WHERE id = $1", &[&id]).await?;
    tx.batch_execute("SAVEPOINT apply_pending_config").await?;
    let mut req = intent.clone();
    req["node"] = json!(n.name);
    let result = match authority {
        Err(e) => Err(e),
        Ok(_) if sw.is_some() => switch_model(engine, org, &tx, &actor, &req, &mut fx).await,
        Ok(_) => account(engine, org, &tx, &actor, &req, &mut fx).await,
    };
    if let Err(e) = result {
        tx.batch_execute("ROLLBACK TO SAVEPOINT apply_pending_config").await?;
        fx = Effects::default();
        event(&tx, org.id, if sw.is_some() { "switch_dropped" } else { "account_queue_dropped" }, &actor, Some(id),
            json!({ "node": n.name, "target": intent["tier"], "account": intent["account"], "kept": n.tier, "reason": format!("{e:#}") }), &mut fx).await?;
        tracing::warn!(agent = id, error = %format!("{e:#}"), "queued configuration dropped at turn boundary");
    }
    fx.agents.insert(id); fx.events = true;
    tx.commit().await?;
    drop(client);
    apply_effects(engine, org, fx).await;
    Ok(true)
}

/// Imported intents have a name but no immutable actor id. Missing or retired
/// callers lose the request; never promote an unknown caller to user authority.
#[logged]
async fn pending_actor(tx: &Transaction<'_>, org: i64, intent: &Value) -> Result<Actor> {
    let name = intent["by"].as_str().unwrap_or("");
    if intent["actor_id"].is_null() && matches!(name, "user" | "@user") { return Ok(Actor::User); }
    let row = if let Some(id) = intent["actor_id"].as_i64() {
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND id = $2 AND state = 'live'", &[&org, &id]).await?
    } else {
        tx.query_opt("SELECT id, name FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org, &name]).await?
    };
    let Some(row) = row else { refuse!(Forbidden, "the caller of this queued change is no longer live") };
    Ok(Actor::Agent { id: row.get(0), name: row.get(1) })
}
