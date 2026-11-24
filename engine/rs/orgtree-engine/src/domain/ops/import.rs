//! The nodes of an import or a duplicate: the plan, and its creation in one
//! transaction (docs/rust-engine/agent-export.md, "Import", step 1).
//!
//! Every live node is created by the canonical operation a hire or a new
//! project runs (`hire`, `create_project`), as the importer: the same
//! authority, the same credit rules (`ensure_room`), the same events. What an
//! import adds is decided before, by `portable::plan`, from facts read under
//! this transaction: names are numbered, settings are clamped to what the
//! destination holds, grants are shrunk to what can be drawn. Nodes that come
//! in retired are stored as a retire leaves them, and cost nothing.
//!
//! The agents are created held (the halt record, by "import"): none can take
//! a turn before its history and its files are in place. `portable::import`
//! lets them go when it has finished with each.
//!
//! Nothing here reads the export file or touches a folder: a refusal rolls the
//! whole of it back, and nothing was unpacked.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Transaction;

use super::{capability, caps, chain, event, hold, node_by_name, seat_of, within, Actor, Effects, Node, OrgCaps};
use crate::domain::scope;
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::portable::credits::Shrink;
use crate::portable::format::{self, End};
use crate::portable::plan::{self, Facts, Plan, Planned, Wanted};
use crate::providers::catalog;
use crate::refuse;

/// What to create.
pub(crate) struct Request<'a> {
    pub nodes: &'a [format::Node],
    pub audiences: &'a [format::Audience],
    /// The node it goes under; `None` is the top level.
    pub dest: Option<String>,
    /// Where among the destination's live children; `None` is the end.
    pub index: Option<usize>,
    pub strategy: Option<Shrink>,
    /// Where the nodes came from, kept on each (`extra.ported`).
    pub origin: Value,
    /// The digest of the plan the importer was shown.
    pub expect: Option<String>,
    /// A duplicate: the cost ledger does not come along (USER 2026-11-23 20:30Z, question 6).
    pub duplicate: bool,
    /// The user's own import from a window: one entry of the undo history (20:44Z, U2).
    pub record: bool,
}

/// What was created.
pub(crate) struct Created {
    pub plan: Plan,
    /// The new id of each node, in the file's order.
    pub ids: Vec<i64>,
    /// What was not restored as it was, beyond the plan's own warnings.
    pub notes: Vec<String>,
    pub audiences: usize,
    /// The undo history's entry, when one was recorded.
    pub history_entry: Option<Value>,
}

/// The charter an agent's hire of a node without one is made with; it is taken off again.
const NO_CHARTER: &str = "(none)";

/// The settings of a project as its creation takes them, from its stored scope: each one
/// checked as `project_setting_ops` checks it, and left at its default when it is not valid.
#[nolog]
fn project_settings(stored: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (key, from) in [("peer_mail", "peer_mail"), ("mail_queue", "mail_queue"), ("exclude_sender", "mail_queue_exclude_sender"),
        ("ack_timeout", "mail_queue_ack_timeout"), ("max_attempts", "mail_queue_max_attempts"), ("ack_reminders", "mail_queue_ack_reminders"),
        ("turn_end_reminder", "mail_queue_turn_end_reminder"), ("slots", "slots_capacity"), ("event_listeners", "event_listeners")] {
        let Some(value) = stored.get(from).filter(|v| !v.is_null()) else { continue };
        if super::project_setting_ops("draft", &json!({ key: value })).is_ok() {
            out.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(out)
}

/// A node's settings with everything dropped that this computer would refuse at a hire: the
/// checks `hire` makes, made first, so one stale preference does not stop a whole team.
#[nolog]
fn settings_here(engine: &Engine, tier: &str, stored: &Value, pin: Option<&str>, notes: &mut Vec<String>) -> (Value, Option<String>) {
    let mut sc = if stored.is_object() { stored.clone() } else { json!({}) };
    let members = sc.as_object_mut().expect("an object");
    for (key, levels) in [("permission_mode", scope::PM_LEVELS), ("org_visibility", scope::VIS_LEVELS)] {
        if members.get(key).is_some_and(|v| !v.as_str().is_some_and(|s| levels.contains(&s))) {
            members.remove(key);
        }
    }
    if members.get("tools").is_some_and(|tools| crate::domain::tool_groups::validate(tools).is_err()) {
        if let Some(tools) = members.get_mut("tools").and_then(Value::as_object_mut) {
            tools.remove("orgtree");
        }
        notes.push("its Orgtree tool groups were not ones this version knows; it has them all".into());
    }
    if let Some(version) = members.get("model_version").cloned() {
        match catalog::version_choice(tier, &version) {
            Ok(Some(_)) => {}
            Ok(None) => {
                members.remove("model_version");
            }
            Err(_) => {
                members.remove("model_version");
                notes.push(format!("its pinned model version ({}) is not offered here; it runs the latest", version.as_str().unwrap_or("?")));
            }
        }
    }
    let version = members.get("model_version").and_then(Value::as_str).map(str::to_string);
    if let Some(level) = members.get("effort").and_then(Value::as_str).map(str::to_string) {
        if crate::providers::check_effort_on(engine, tier, version.as_deref(), None, &level).is_err() {
            members.remove("effort");
            notes.push(format!("its effort level ({level}) is not one {tier} has here; it takes the default"));
        }
    } else {
        members.remove("effort");
    }
    if members.get("fast_mode") == Some(&json!(true)) && !crate::providers::fast_mode::supported(&engine.providers.state.load(), tier, version.as_deref()) {
        members.insert("fast_mode".into(), json!(false));
        notes.push("fast mode is not available for its model here; it is off".into());
    }
    if members.get("peer_mail").is_some_and(|v| !v.is_boolean()) {
        members.remove("peer_mail");
    }
    if members.get("account_fallback").is_some_and(|v| !v.is_boolean()) {
        members.remove("account_fallback");
    }
    if let Some(value) = members.get("session").cloned() {
        if crate::runtime::session_host::parse_pref(&value).is_err() {
            members.remove("session");
            notes.push("its Windows session preference is not one this computer reads; it takes the default".into());
        }
    }
    if let Some(value) = members.get("auto_cheap_compact").cloned() {
        if crate::settings::cheap_compact(&value, &Value::Null, false).is_err() {
            members.remove("auto_cheap_compact");
        }
    }
    // a harness of its own: only where the seat can have one, and only one this computer can run
    let pin = pin.filter(|_| catalog::is_openrouter(tier) || catalog::is_langserver(tier)).and_then(|pin| match crate::harnesses::require_seat_choice(engine, tier, pin) {
        Ok(()) => Some(pin.to_string()),
        Err(_) => {
            notes.push(format!("its own harness ({pin}) cannot run here; it follows its key or its server"));
            None
        }
    });
    (sc, pin)
}

/// The credits that can be drawn under `dest`, as `ensure_room` would give them, and the cap
/// on a top agent's grant when no agent stands at or above `dest`.
#[logged]
async fn drawable(tx: &Transaction<'_>, actor: &Actor, dest: Option<&Node>, caps: &OrgCaps) -> Result<(f64, Option<f64>)> {
    let Some(dest) = dest else { return Ok((f64::INFINITY, Some(caps.max_top))) };
    let above = chain(tx, dest.id).await?;
    if above.iter().all(Node::project) {
        return Ok((f64::INFINITY, Some(caps.max_top)));
    }
    // an agent always draws up to its own allocation; the user's draw follows the app's switch
    let (cascade, floor) = match actor {
        Actor::Agent { id, .. } => (true, Some(*id)),
        Actor::User => (caps.cascade_hire, None),
    };
    // from the top down: what each agent can make free, with what the one above can raise it by
    let mut free_here = 0.0f64;
    for (at, node) in above.iter().enumerate() {
        if node.project() {
            continue;
        }
        let free = node.grant - hold(tx, node.id).await?;
        let top = above[..at].iter().all(Node::project);
        let raise = if floor == Some(node.id) || !cascade {
            0.0
        } else if top {
            if caps.max_top.is_finite() { (caps.max_top - node.grant + 1e-9).floor().max(0.0) } else { f64::INFINITY }
        } else {
            // a raise is whole credits, drawn from what the agent above can make free
            free_here.floor().max(0.0)
        };
        free_here = free + raise;
    }
    Ok((free_here.max(0.0), None))
}

/// Everything the plan reads, under this transaction.
struct Gathered {
    wanted: Vec<Wanted>,
    /// Each node's own harness, when it keeps one here.
    pins: Vec<Option<String>>,
    facts: Facts,
    dest: Option<Node>,
}

#[nolog]
async fn gather(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Request<'_>) -> Result<Gathered> {
    let caps = caps(engine, tx, org.id).await?;
    let dest = match req.dest.as_deref().map(|d| d.trim().trim_start_matches('@')).filter(|d| !d.is_empty() && *d != "user") {
        Some(name) => Some(node_by_name(tx, org.id, name).await?),
        None => None,
    };
    // where an import may go is where a hire may go (`hire`): the user anywhere, an agent under itself or its reports
    match &dest {
        None => {
            if matches!(actor, Actor::Agent { .. }) {
                refuse!(Forbidden, "only the user imports at the top level; name a node of your own team to import under");
            }
        }
        Some(d) => {
            if d.state != "live" {
                refuse!(Conflict, "{} is not live", d.name);
            }
            if let Actor::Agent { id, name } = actor {
                if d.id != *id && !within(tx, *id, d.id).await? {
                    if d.project() && within(tx, d.id, *id).await? {
                        refuse!(Forbidden, "an import under project {} is paid by the agent above it: a project holds no credits and you cannot spend your superiors'; ask the agent above the project", d.name);
                    }
                    refuse!(Forbidden, "{name} can only import under itself or its reports");
                }
            }
        }
    }
    let taken: HashSet<String> = tx.query("SELECT lower(name) FROM ot.agents WHERE org_id = $1 AND state <> 'deleted'", &[&org.id]).await?.iter().map(|r| r.get(0)).collect();
    let avail = crate::domain::templates::avail(engine, &org.slug);
    let tiers: HashMap<String, plan::Tier> = avail
        .tiers
        .iter()
        .map(|(name, offer)| {
            (name.clone(), plan::Tier { seat: seat_of(engine, name).unwrap_or(offer.seat), accounts: offer.accounts.clone(), default_ok: offer.default_ok,
                                        billed: offer.provider != catalog::LANGSERVER })
        })
        .collect();
    let mut checking: Vec<String> = Vec::new();
    let mut wanted = Vec::with_capacity(req.nodes.len());
    let mut pins = Vec::with_capacity(req.nodes.len());
    for node in req.nodes {
        let project = node.kind == crate::domain::projects::KIND;
        let mut notes = Vec::new();
        let staffed = !project && tiers.contains_key(&node.tier);
        if !project && !staffed && avail.checking && matches!(catalog::provider_of(&node.tier), catalog::CLAUDE | catalog::OPENAI) && !checking.contains(&node.tier) {
            checking.push(node.tier.clone());
        }
        let (scope, pin) = if project {
            (node.scope.clone(), None)
        } else if staffed {
            settings_here(engine, &node.tier, &node.scope, node.harness_pin.as_deref(), &mut notes)
        } else {
            // it comes in retired: its settings are kept as they are for whoever rehires it
            (node.scope.clone(), None)
        };
        pins.push(pin);
        wanted.push(Wanted { name: node.name.clone(), parent: node.parent, project, retired: node.retired, tier: node.tier.clone(),
                             account: node.account.as_ref().map(|a| a.id.clone()), grant: node.grant, scope, notes });
    }
    let (ceiling, above) = match &dest {
        Some(d) => (capability(tx, d.id, &caps.settings).await?, d.name.clone()),
        None => (scope::org_ceiling(&caps.settings["dirs"]), "the organization".to_string()),
    };
    let (available, top_cap) = drawable(tx, actor, dest.as_ref(), &caps).await?;
    let facts = Facts { taken, tiers, checking, ceiling, above, available, top_cap, by_agent: matches!(actor, Actor::Agent { .. }) };
    Ok(Gathered { wanted, pins, facts, dest })
}

/// What an import of these nodes under `dest` would do now. Nothing is created.
#[nolog]
pub(crate) async fn preview(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, req: &Request<'_>) -> Result<Plan> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let gathered = gather(engine, org, &tx, actor, req).await?;
    tx.rollback().await?;
    Ok(plan::build(&gathered.wanted, &gathered.facts, req.strategy))
}

/// Create the nodes. On success the transaction has committed; the caller publishes `Effects`.
#[nolog]
pub(crate) async fn create(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, req: &Request<'_>) -> Result<(Created, Effects)> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut fx = Effects::default();
        match create_once(engine, org, actor, req, &mut fx).await {
            Ok(created) => return Ok((created, fx)),
            Err(e) => super::conflict_retry("import", attempt, e).await?,
        }
    }
}

#[nolog]
fn hire_request(planned: &Planned, node: &format::Node, parent: &str, index: usize, pin: Option<&str>, renamed: &HashMap<String, String>) -> (Value, bool) {
    let sc = &planned.scope;
    let charter = node.charter.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(|c| crate::portable::names::rewrite_mentions(c, renamed));
    let charter = charter.as_deref();
    let mut req = json!({
        "op": "hire", "name": planned.name, "tier": planned.tier, "grant": planned.grant, "parent": parent, "index": index,
        "charter": charter.unwrap_or(NO_CHARTER),
        "add_dirs": sc["add_dirs"], "org_visibility": sc["org_visibility"], "permission_mode": sc["permission_mode"], "tools": sc["tools"],
        "fast_mode": sc["fast_mode"].as_bool().unwrap_or(false),
    });
    for key in ["effort", "account_fallback", "model_version", "session", "peer_mail", "auto_cheap_compact"] {
        if let Some(value) = sc.get(key).filter(|v| !v.is_null()) {
            req[key] = value.clone();
        }
    }
    if !node.title.trim().is_empty() {
        req["title"] = json!(node.title);
    }
    if let Some(text) = node.team_charter.as_deref().filter(|t| !t.trim().is_empty()) {
        req["team_charter"] = json!(crate::portable::names::rewrite_mentions(text, renamed));
    }
    if let Some(account) = &planned.account {
        req["account"] = json!(account);
    }
    if let Some(pin) = pin {
        req["harness"] = json!(pin);
    }
    (req, charter.is_none())
}

#[nolog]
fn project_request(planned: &Planned, node: &format::Node, parent: &str, index: usize, renamed: &HashMap<String, String>) -> Value {
    let mut req = json!({ "op": "create_project", "name": planned.name, "parent": parent, "index": index });
    if let Some(description) = node.charter.as_deref().filter(|d| !d.trim().is_empty()) {
        req["description"] = json!(crate::portable::names::rewrite_mentions(description, renamed));
    }
    if !node.title.trim().is_empty() {
        req["title"] = json!(node.title);
    }
    let settings = project_settings(&planned.scope);
    if settings.as_object().is_some_and(|s| !s.is_empty()) {
        req["settings"] = settings;
    }
    req
}

/// What is kept on a node of where it came from.
#[nolog]
fn ported(req: &Request<'_>, node: &format::Node) -> Value {
    json!({ "ported": { "from": req.origin, "was": node.name, "born": node.born, "at": crate::util::now_iso(), "duplicate": req.duplicate } })
}

#[nolog]
async fn create_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, req: &Request<'_>, fx: &mut Effects) -> Result<Created> {
    let mut client = engine.db.get().await?;
    let tx = client.build_transaction().isolation_level(tokio_postgres::IsolationLevel::Serializable).start().await?;
    // the history's head, then the organization, before any node: the order every writer of them takes
    if req.record {
        crate::domain::undo::import_begin(&tx, org.id).await?;
    } else {
        tx.query_one("SELECT id FROM ot.orgs WHERE id = $1 FOR NO KEY UPDATE", &[&org.id]).await?;
    }
    let gathered = gather(engine, org, &tx, actor, req).await?;
    let plan = plan::build(&gathered.wanted, &gathered.facts, req.strategy);
    if req.expect.as_ref().is_some_and(|expect| *expect != plan.digest()) {
        refuse!(Conflict, "what this would create has changed since it was previewed (a name was taken, credits moved, or a model came or went); preview it again");
    }
    if let Some(why) = &plan.refusal {
        refuse!(Conflict, "{why}");
    }
    let before = crate::domain::audience_notices::snapshot(&*tx, org.id).await?;
    let dest_id = gathered.dest.as_ref().map(|d| d.id);
    let dest_name = gathered.dest.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| "user".to_string());
    let siblings: i64 = tx.query_one("SELECT count(*) FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'", &[&org.id, &dest_id]).await?.get(0);
    let root_index = req.index.unwrap_or(usize::MAX).min(siblings.max(0) as usize);
    let hold_record = {
        let at = crate::util::now_iso();
        json!({ "phase": "halted", "requested_at": at, "at": at, "by": "import" })
    };
    let scratch_root = engine.cfg.scratch_root(&org.slug);
    let teams_root = engine.cfg.teams_dir(&org.slug);
    // a mention of a node that got another name follows it, in charters and descriptions (question 4)
    let renamed: HashMap<String, String> = plan.nodes.iter().filter(|p| p.was != p.name).map(|p| (p.was.clone(), p.name.clone())).collect();
    let mut ids: Vec<i64> = Vec::with_capacity(plan.nodes.len());
    let mut held: Vec<i64> = Vec::new();
    let mut placed: HashMap<usize, usize> = HashMap::new();
    for (at, planned) in plan.nodes.iter().enumerate() {
        let node = &req.nodes[at];
        let (parent_id, parent_name) = match planned.parent {
            Some(above) => (Some(ids[above]), plan.nodes[above].name.clone()),
            None => (dest_id, dest_name.clone()),
        };
        let mark = ported(req, node);
        let (cost, api_cost, cost_unknown) = if req.duplicate { (0.0, 0.0, false) } else { (node.cost_usd.max(0.0), node.api_cost_usd.max(0.0), node.cost_unknown) };
        if planned.retired {
            // as a retire leaves a node: its seat and grant kept for a rehire, holding nothing meanwhile
            let project = planned.project;
            let tier = if project { crate::domain::projects::TIER } else { planned.tier.as_str() };
            let kind = if project { crate::domain::projects::KIND } else { "agent" };
            let provider = (!project).then(|| catalog::provider_of(tier));
            let scratch = (!project).then(|| scratch_root.join(&planned.name).to_string_lossy().to_string());
            let charter = node.charter.as_deref().filter(|c| !c.trim().is_empty()).map(|c| crate::portable::names::rewrite_mentions(c, &renamed));
            let team_charter = node.team_charter.as_deref().filter(|c| !c.trim().is_empty()).map(|c| crate::portable::names::rewrite_mentions(c, &renamed));
            let id: i64 = tx.query_one(
                "INSERT INTO ot.agents (org_id, name, parent_id, sibling_order, state, title, charter, team_charter, tier, seat, grant_credits,
                                        scope, generation, born, provider, scratch_dir, kind, archived_at, extra, cost_usd, api_cost_usd, cost_unknown)
                 VALUES ($1, $2, $3, (SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $3),
                         'archived', $4, $5, $6, $7, $8::float8::numeric, $9::float8::numeric, $10, 1, $11, $12, $13, $14, now(), $15,
                         $16::float8::numeric, $17::float8::numeric, $18)
                 RETURNING id",
                &[&org.id, &planned.name, &parent_id, &node.title, &charter, &team_charter, &tier, &(if project { 0.0 } else { node.seat }),
                  &(if project { 0.0 } else { planned.saved_grant }), &planned.scope, &uuid::Uuid::new_v4().to_string(), &provider, &scratch, &kind, &mark,
                  &cost, &api_cost, &cost_unknown]).await?.get(0);
            if project {
                let folder = crate::domain::teams::workspace(&teams_root, id).to_string_lossy().to_string();
                tx.execute("UPDATE ot.agents SET scratch_dir = $2 WHERE id = $1", &[&id, &folder]).await?;
            }
            fx.agents.insert(id);
            ids.push(id);
            continue;
        }
        let index = match planned.parent {
            None => root_index,
            Some(above) => {
                let next = placed.entry(above).or_insert(0);
                *next += 1;
                *next - 1
            }
        };
        let (request, no_charter) = if planned.project {
            (project_request(planned, node, &parent_name, index, &renamed), false)
        } else {
            hire_request(planned, node, &parent_name, index, gathered.pins[at].as_deref(), &renamed)
        };
        super::run_in_tx_without_audience_notices(engine, org, &tx, actor, &request, fx)
            .await
            .map_err(|err| err.context(format!("{} could not be created", planned.name)))?;
        let id: i64 = tx.query_one("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state = 'live'", &[&org.id, &planned.name]).await?.get(0);
        if planned.project {
            // its colour and its built-in icon are settings too; an uploaded icon comes with its file
            let mut theme = serde_json::Map::new();
            if let Some(colour) = planned.scope["theme_color"].as_str().filter(|c| crate::domain::projects::valid_theme_color(c)) {
                theme.insert("theme_color".into(), json!(colour.to_lowercase()));
            }
            if let Some(icon) = planned.scope["theme_icon"].as_str().filter(|i| crate::domain::projects::valid_theme_icon(i)) {
                theme.insert("theme_icon".into(), json!(icon));
            }
            tx.execute("UPDATE ot.agents SET scope = scope || $2, extra = extra || $3, row_version = row_version + 1 WHERE id = $1", &[&id, &Value::Object(theme), &mark]).await?;
        } else {
            tx.execute(
                "UPDATE ot.agents SET charter = CASE WHEN $2 THEN NULL ELSE charter END, extra = extra || $3, halt = $4,
                        cost_usd = $5::float8::numeric, api_cost_usd = $6::float8::numeric, cost_unknown = $7, context_window = $8,
                        row_version = row_version + 1
                  WHERE id = $1",
                &[&id, &no_charter, &mark, &hold_record, &cost, &api_cost, &cost_unknown, &node.context_window]).await?;
            held.push(id);
        }
        ids.push(id);
    }
    // nobody starts before its history and files are in place
    fx.warm.retain(|id| !held.contains(id));
    fx.wake.retain(|id| !held.contains(id));
    // each of them arrives with its team and is told so by the import's own notice. What a hire leaves for the
    // superior and the peers of the newcomer (`lifecycle::record`) stays for the nodes that were here before,
    // and not for these: nothing else has been written to a node this transaction created.
    tx.execute("DELETE FROM ot.mail WHERE org_id = $1 AND recipient_agent_id = ANY($2) AND sender = '@system' AND state = 'pending'", &[&org.id, &ids]).await?;

    // the audiences between the nodes, and with the user and outside mail, each as the importer may grant it
    let mut notes = Vec::new();
    let mut audiences = 0;
    for audience in req.audiences {
        let end = |end: &End| -> (String, bool) {
            match end {
                End::Node(at) => (plan.nodes[*at].name.clone(), !plan.nodes[*at].retired),
                End::User => (crate::domain::audiences::USER.to_string(), true),
                End::Extern => (crate::domain::audiences::EXTERN.to_string(), true),
            }
        };
        let ((grantee, grantee_live), (grantor, grantor_live)) = (end(&audience.grantee), end(&audience.grantor));
        if !matches!(audience.grantee, End::Node(_)) {
            continue;
        }
        if outside_mail(audience) {
            notes.push(format!("the org mailbox audience of {grantee} was ignored: an import never gives or moves the org mailbox"));
            continue;
        }
        if !grantee_live || !grantor_live {
            notes.push(format!("the audience of {grantee} with {grantor} was not restored: one of them came in retired"));
            continue;
        }
        tx.batch_execute("SAVEPOINT import_audience").await?;
        match crate::domain::audiences::grant_tx(engine, &*tx, org, actor, &grantee, Some(&grantor), "restored by an import").await {
            Ok((_, id)) => {
                tx.batch_execute("RELEASE SAVEPOINT import_audience").await?;
                fx.agents.insert(id);
                fx.pulses.push(crate::changes::Change::Mailbox(id));
                audiences += 1;
            }
            Err(error) if error.downcast_ref::<crate::domain::UserError>().is_some() => {
                tx.batch_execute("ROLLBACK TO SAVEPOINT import_audience; RELEASE SAVEPOINT import_audience").await?;
                notes.push(format!("the audience of {grantee} with {grantor} was not restored: {error}"));
            }
            Err(error) => return Err(error),
        }
    }
    if audiences > 0 {
        fx.pulses.push(crate::changes::Change::OrgInbox);
    }

    let root = ids[0];
    let live = plan.nodes.iter().filter(|p| !p.retired).count();
    event(&tx, org.id, if req.duplicate { "duplicate" } else { "import" }, actor, Some(root),
          json!({ "node": plan.nodes[0].name, "parent": gathered.dest.as_ref().map(|d| d.name.clone()), "nodes": plan.nodes.len(), "live": live,
                  "retired": plan.nodes.len() - live, "cost": plan.cost, "from": req.origin, "was": plan.nodes[0].was }), fx).await?;
    fx.events = true;
    fx.agents.extend(crate::domain::projects::settle_credits(&*tx, org.id).await?);
    super::record_audience_delta(&tx, org.id, &before, fx).await?;
    let history_entry = if req.record {
        Some(crate::domain::undo::import_record(&tx, org.id, req.duplicate, &plan.nodes[0].name, &ids).await?)
    } else {
        None
    };
    tx.commit().await?;
    Ok(Created { plan, ids, notes, audiences, history_entry })
}

/// Let the agents an import held go, each when its history and files are in place: the hold
/// is the import's own, so one the user put on meanwhile stays. Returns the ones released.
#[logged]
pub(crate) async fn release(engine: &Arc<Engine>, org: &Arc<OrgHandle>, ids: &[i64]) -> Result<Vec<i64>> {
    let client = engine.db.get().await?;
    let rows = client
        .query("UPDATE ot.agents SET halt = NULL, row_version = row_version + 1 WHERE id = ANY($1) AND halt->>'by' = 'import' RETURNING id", &[&ids])
        .await?;
    let freed: Vec<i64> = rows.iter().map(|r| r.get(0)).collect();
    crate::changes::notify(engine, org, freed.iter().map(|id| crate::changes::Change::Agent(*id)).collect());
    Ok(freed)
}

/// An audience with the org mailbox. No import or duplicate grants one, whatever file it reads
/// (USER 2026-11-24 m63824e37d3d6: "the org inbox audience should never move / be saved with an
/// import"): granting it would take the org mailbox from whoever holds it here. Exports written
/// since do not hold one; a file from 4.7.0-alpha.1 may.
#[nolog]
fn outside_mail(audience: &format::Audience) -> bool {
    matches!(audience.grantor, End::Extern) || matches!(audience.grantee, End::Extern)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_audience_with_the_org_mailbox_in_a_file_is_never_one_to_grant() {
        let from_an_older_file: Vec<format::Audience> = serde_json::from_value(json!([
            { "grantee": { "node": 0 }, "grantor": "extern" }, { "grantee": { "node": 1 }, "grantor": "user" }, { "grantee": { "node": 1 }, "grantor": { "node": 0 } },
        ])).unwrap();
        assert_eq!(from_an_older_file.iter().map(outside_mail).collect::<Vec<_>>(), [true, false, false]);
    }

    #[test]
    fn a_projects_settings_are_read_back_from_its_stored_scope_and_only_valid_ones() {
        let stored = json!({ "transparent": true, "peer_mail": false, "mail_queue": "ack", "mail_queue_exclude_sender": true, "mail_queue_max_attempts": 4,
                             "slots_capacity": 3, "event_listeners": true, "theme_color": "#e11d48" });
        assert_eq!(project_settings(&stored), json!({ "peer_mail": false, "mail_queue": "ack", "exclude_sender": true, "max_attempts": 4, "slots": 3, "event_listeners": true }));
        // what no project may be set to is left at its default
        let odd = json!({ "transparent": true, "mail_queue": "lifo", "slots_capacity": -1, "mail_queue_max_attempts": 1000, "peer_mail": "yes", "mail_queue_ack_reminders": null });
        assert_eq!(project_settings(&odd), json!({}));
        assert_eq!(project_settings(&json!({ "transparent": true })), json!({}));
    }

    #[test]
    fn a_hire_is_asked_for_with_what_the_plan_settled() {
        let planned = Planned { was: "lead".into(), name: "lead-2".into(), parent: None, project: false, retired: false, retired_why: None, tier: "big".into(),
            account: Some("second".into()), seat: 4.0, grant: 12.0, saved_grant: 20.0,
            scope: json!({ "permission_mode": "acceptEdits", "org_visibility": "team", "add_dirs": [{ "path": "C:\\work", "mode": "ro" }],
                           "tools": { "bash": false, "web": true, "edit": true, "subagents": false, "mcp": ["files"] }, "effort": "high", "fast_mode": true,
                           "peer_mail": false, "session": null }),
            warnings: Vec::new() };
        let node = format::Node { name: "lead".into(), title: " Team lead ".into(), charter: Some("Leads the team with @worker.".into()), team_charter: Some("  ".into()), ..format::Node::default() };
        let renamed: HashMap<String, String> = [("worker".to_string(), "worker-2".to_string())].into_iter().collect();
        let (req, no_charter) = hire_request(&planned, &node, "boss", 2, Some("opencode"), &renamed);
        assert!(!no_charter);
        assert_eq!(req, json!({ "op": "hire", "name": "lead-2", "tier": "big", "grant": 12.0, "parent": "boss", "index": 2, "charter": "Leads the team with @worker-2.",
            "add_dirs": [{ "path": "C:\\work", "mode": "ro" }], "org_visibility": "team", "permission_mode": "acceptEdits",
            "tools": { "bash": false, "web": true, "edit": true, "subagents": false, "mcp": ["files"] }, "fast_mode": true, "effort": "high", "peer_mail": false,
            "title": " Team lead ", "account": "second", "harness": "opencode" }));
        // an agent hire has no defaults: every field `require_hire` asks for is there, a charter too
        let bare = format::Node { name: "lead".into(), ..format::Node::default() };
        let (req, no_charter) = hire_request(&Planned { account: None, ..planned.clone() }, &bare, "boss", 0, None, &renamed);
        assert!(no_charter && req["charter"] == NO_CHARTER);
        assert!(crate::domain::hire_requirements::missing_hire(&req).is_empty(), "{:?}", crate::domain::hire_requirements::missing_hire(&req));
        assert!(req.get("account").is_none() && req.get("harness").is_none() && req.get("title").is_none());
    }

    #[test]
    fn a_project_is_asked_for_with_its_description_and_settings() {
        let planned = Planned { was: "P".into(), name: "P-2".into(), parent: Some(0), project: true, retired: false, retired_why: None, tier: "project".into(), account: None,
            seat: 0.0, grant: 0.0, saved_grant: 0.0, scope: json!({ "transparent": true, "slots_capacity": 2 }), warnings: Vec::new() };
        let node = format::Node { name: "P".into(), kind: "project".into(), charter: Some("The build queue.".into()), ..format::Node::default() };
        assert_eq!(project_request(&planned, &node, "lead-2", 1, &HashMap::new()),
                   json!({ "op": "create_project", "name": "P-2", "parent": "lead-2", "index": 1, "description": "The build queue.", "settings": { "slots": 2 } }));
        let plain = Planned { scope: json!({ "transparent": true }), ..planned };
        assert_eq!(project_request(&plain, &format::Node::default(), "user", 0, &HashMap::new()), json!({ "op": "create_project", "name": "P-2", "parent": "user", "index": 0 }));
    }
}
