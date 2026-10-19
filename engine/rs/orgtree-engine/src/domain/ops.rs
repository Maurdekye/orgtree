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

mod ordering;
mod fast_defaults;

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
    /// A self-hired parent is promoted only after composite authorization, before commit.
    self_parent: Option<(String, Value)>,
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
    dogs_off: Vec<i64>,
    dogs_on: Vec<i64>,
    /// a retool that set or cleared an agent's effort: (agent, the levels it
    /// resolved to before and after), delivered after commit
    effort: Option<(i64, String, String)>,
    /// agents whose switch or account was queued because a turn is on
    /// record: an idle one applies it at once (decision 62)
    queued: Vec<i64>,
    /// projects whose mail queue mode changed: (id, name, ack mode), whose
    /// watchers are told after commit (`projects::mode_changed`)
    queue_modes: Vec<(i64, String, bool)>,
    /// projects whose free slots go to their line after commit (`slots::grant`)
    slot_grants: Vec<i64>,
    /// projects whose mail queue runs after commit (a retried dead letter is waiting again)
    queue_runs: Vec<i64>,
    /// project events to fire after commit (`listeners::fire`): (project, firer label, message)
    project_fires: Vec<(i64, String, Option<String>)>,
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
    /// `agent` or `project` (docs/rust-engine/PROJECT-NODES.md)
    kind: String,
}

const NODE_COLS: &str = "id, name, parent_id, state, tier, seat::float8, grant_credits::float8, scope, account, session_id, kind";

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
        kind: r.get(10),
    }
}

impl Node {
    #[nolog]
    fn project(&self) -> bool {
        self.kind == crate::domain::projects::KIND
    }
}

/// Operations that only make sense for an agent (a model, an account, a
/// session, folders, credits of its own) refuse a project node.
#[logged]
fn agent_only(n: &Node, verb: &str) -> Result<()> {
    if n.project() {
        refuse!(BadRequest, "{} is a project, not an agent: it has no model, account, session or scope, so it cannot {verb}", n.name);
    }
    Ok(())
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

/// Reporting/payer relation; raw Node.parent is exclusively structural placement.
#[logged]
async fn agent_superior(tx: &Transaction<'_>, id: i64) -> Result<Option<i64>> {
    Ok(tx.query_one("SELECT ot.superior_of($1)", &[&id]).await?.get(0))
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

#[cfg(test)]
mod fast_tools_tests {
    use super::*;

    #[test]
    fn fast_tools_hire_explicit_false_overrides_tier_default() {
        let caps = OrgCaps { max_top: 100., cascade_hire: true, cascade_alloc: true,
            settings: json!({"default_fast_mode":{"sol":true,"luna":false}}) };
        for (req, want) in [(json!({"tier":"sol"}),true),
            (json!({"tier":"sol","fast_mode":false}),false),
            (json!({"tier":"luna","fast_mode":true}),true),
            (json!({"tier":"luna"}),false), (json!({"tier":"haiku"}),false)] {
            assert_eq!(hire_scope(&caps,&req)["fast_mode"],json!(want),"{req}");
        }
    }
}

#[logged]
async fn caps(engine: &Engine, tx: &Transaction<'_>, org_id: i64) -> Result<OrgCaps> {
    let s: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org_id]).await?.get(0);
    let eff = crate::feed::groups::effective_settings(&s, &engine.settings.defaults());
    Ok(OrgCaps {
        // 0 is uncapped, as in 3.x (D-014) and as the credit request's
        // headroom and the desk's credit bar read it
        max_top: eff["max_top_grant"].as_f64().map(|c| if c > 0.0 { c } else { f64::INFINITY }).unwrap_or(1000.0),
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
    for (i, n) in ch.iter().enumerate().rev() {
        // a project is transparent in the credit hierarchy (user 2026-10-16
        // 20:40Z): it holds exactly its children's stakes, never free credits,
        // so it passes the need straight up to the agent above it
        if n.project() {
            if floor == Some(n.id) {
                refuse!(Conflict, "insufficient credits: project {} holds no credits; the agent above it pays", n.name);
            }
            plan.push((n.id, n.name.clone(), need));
            continue;
        }
        let free = n.grant - hold(tx, n.id).await?;
        if free + 1e-9 >= need { break; }
        if floor == Some(n.id) || !cascade {
            refuse!(Conflict,
                "insufficient credits: {} has {:.2} credits free and this needs {:.2}; ask its superior to raise its grant",
                n.name, free, need);
        }
        let d = (need - free).ceil();
        // the user's top-level cap binds an agent with no agent above it,
        // under a top-level project too
        let credit_top = ch[..i].iter().all(|a| a.project());
        if credit_top && n.grant + d > max_top + 1e-9 {
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

/// General project reach includes ancestors and members. Policy mutations use
/// authorize_project_policy instead (user 2026-10-19); operational reach remains.
#[logged]
async fn authorize(tx: &Transaction<'_>, actor: &Actor, target: &Node, verb: &str) -> Result<()> {
    if let Actor::Agent { id, .. } = actor {
        if *id == target.id {
            refuse!(Forbidden, "you cannot {verb} yourself");
        }
        if within(tx, *id, target.id).await? {
            return Ok(());
        }
        if target.project() && within(tx, target.id, *id).await? {
            return Ok(());
        }
        refuse!(Forbidden, "you can only {verb} agents below you (or a project you are above or below); {} is not", target.name);
    }
    Ok(())
}

/// Project policy belongs to the user and strict agent ancestors. Membership,
/// including membership in a root project, grants operational reach only.
#[logged]
async fn authorize_project_policy(tx: &Transaction<'_>, actor: &Actor, target: &Node, verb: &str) -> Result<()> {
    if let Actor::Agent { id, .. } = actor {
        if *id == target.id || !within(tx, *id, target.id).await? {
            refuse!(Forbidden, "only the user or an agent above project {} may {verb}; members may read and use it", target.name);
        }
    }
    Ok(())
}

/// An agent may not retire or dissolve a project it is inside: that would
/// archive the caller with it in the middle of its turn. Its superiors can
/// (user 2026-10-16 20:40Z, confirming the implementer's choice).
#[logged]
async fn not_inside(tx: &Transaction<'_>, actor: &Actor, n: &Node, verb: &str) -> Result<()> {
    if let Actor::Agent { id, .. } = actor {
        if n.project() && *id != n.id && within(tx, n.id, *id).await? {
            refuse!(Forbidden, "you are inside project {}: to {verb} it would archive you with it; ask an agent above it", n.name);
        }
    }
    Ok(())
}

#[logged]
pub(crate) fn valid_name(name: &str) -> Result<String> {
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

/// `extra.harness` is the harness a seat's session runs on. An OpenRouter
/// seat is stamped at hire (and on a move into the lane) with its key's
/// harness, which unpins it (`extra.harness_pin`); a rehire keeps the stamp
/// and the pin. An unpinned seat follows its key's later changes at its next
/// turn boundary (the actor's `start_turn`). A language-server seat runs on
/// its server's harness, stamped the same way for every reader of
/// `extra.harness` (the server's own setting stays the authority at launch).
#[logged]
async fn stamp_harness(engine: &Engine, tx: &Transaction<'_>, agent: i64, tier: &str, replace: bool) -> Result<()> {
    let h = if catalog::is_openrouter(tier) {
        let account: Option<String> = tx.query_one("SELECT account FROM ot.agents WHERE id = $1", &[&agent]).await?.get(0);
        if replace {
            tx.execute("UPDATE ot.agents SET extra = coalesce(extra, '{}'::jsonb) - 'harness_pin' WHERE id = $1", &[&agent]).await?;
        }
        crate::openrouter::seat_harness(engine, account.as_deref(), None, false)
    } else if catalog::is_langserver(tier) {
        match crate::langserver::route_of(engine, tier).and_then(|(s, _)| s["harness"].as_str().map(str::to_string)) {
            Some(h) => h,
            None => return Ok(()),
        }
    } else {
        return Ok(());
    };
    // a language server's harness is fixed: always restamp it
    let replace = replace || catalog::is_langserver(tier);
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

/// The harness a language-server agent runs on now: its stamp, else (an
/// agent stamped before the stamp existed) its server's.
#[logged]
async fn langserver_harness(engine: &Engine, tx: &Transaction<'_>, agent: i64, tier: &str) -> Result<Option<String>> {
    let stamped: Option<String> = tx.query_one("SELECT extra->>'harness' FROM ot.agents WHERE id = $1", &[&agent]).await?.get(0);
    Ok(stamped.or_else(|| crate::langserver::route_of(engine, tier).and_then(|(s, _)| s["harness"].as_str().map(str::to_string))))
}

/// A harness as people name it.
#[logged]
fn harness_label(harness: &str) -> &'static str {
    crate::harnesses::get(harness).map(|h| h.name).unwrap_or("Claude Code")
}

/// Validate a selector before storing it; qualified primary selectors also name a provider.
#[logged]
fn validate_account(engine: &Engine, org_slug: &str, tier: &str, raw: Option<&str>) -> Result<()> {
    let provider = catalog::provider_of(tier);
    let agy_login = crate::providers::agy_auth::login_of(&engine.accounts.view(), raw);
    if agy_login == crate::providers::agy_auth::Login::Primary {
        if let Some(reason) = crate::usage::antigravity_limit(engine, tier) {
            refuse!(Conflict, "{reason}");
        }
    }
    if let Some(prefix) = raw.and_then(|v| v.strip_suffix("/primary")) {
        if prefix != provider {
            refuse!(BadRequest, "{prefix}/primary cannot serve {provider}");
        }
    }
    // the org's account list (Org settings › Accounts): an OpenRouter tier
    // is its key's lane (the first key unless one is named), a
    // language-server tier its server's, an explicit primary the default login
    // (an OpenRouter tier naming no key is placed on a key the org uses: no
    // lane to check yet)
    let unnamed_key = catalog::is_openrouter(tier) && !matches!(crate::accounts::choice(raw), crate::accounts::Choice::Account(_));
    if let Some(lane) = crate::org_accounts::seat_lane(engine, tier, raw).filter(|_| !unnamed_key) {
        if !crate::org_accounts::allowed(Some(org_slug), &lane) {
            refuse!(Conflict, "{}", crate::org_accounts::refusal(engine, org_slug, &lane, provider));
        }
    }
    if crate::accounts::choice(raw) == crate::accounts::Choice::Primary && provider != catalog::OPENROUTER {
        let lane = crate::org_accounts::default_lane(provider);
        if !crate::org_accounts::allowed(Some(org_slug), &lane) {
            refuse!(Conflict, "{}", crate::org_accounts::refusal(engine, org_slug, &lane, provider));
        }
    }
    if let crate::accounts::Choice::Account(id) = crate::accounts::choice(raw) {
        let view = engine.accounts.view();
        // a lane the org switched off is refused, naming the ones it allows
        if let Some(a) = view.get(&id).filter(|a| a.available_origin(org_slug) && !a.available_to(Some(org_slug))) {
            refuse!(Conflict, "{}", crate::org_accounts::refusal(engine, org_slug, &crate::org_accounts::lane_of(a), &a.provider));
        }
        // a legacy org key is refused exactly like an id that does not exist
        let Some(a) = view.get(&id).filter(|a| a.available_to(Some(org_slug))) else { refuse!(NotFound, "no account {id}") };
        if a.provider != provider {
            refuse!(BadRequest, "{id} is a {} account and {tier} runs on {provider}", a.provider);
        }
        if provider == catalog::GOOGLE {
            if matches!(agy_login, crate::providers::agy_auth::Login::Profile { .. }) {
                if let Some(reason) = crate::usage::at_limit(engine, Some(a), tier) {
                    refuse!(Conflict, "{id}: {reason}");
                }
            }
            if let Some(until) = a.limited_for(tier, chrono::Utc::now()) {
                refuse!(Conflict, "{id} has exhausted this Antigravity model group's quota until {until}");
            }
        }
        if provider == catalog::MUSE {
            if let Some(until) = a.limited_for(tier, chrono::Utc::now()) {
                refuse!(Conflict, "Muse refused {tier} on {id} for its quota until {until}");
            }
        }
    }
    Ok(())
}

/// A Muse seat's placement, judged by the login it will run on (`account`: a
/// registered id, else the user's own login) and the exact model it runs
/// (`version` pinned): that login's own catalog must offer it (user
/// 2026-10-12 19:57Z: a bundled row, another login's catalog or a guess
/// never does). A login never read, or whose read failed, is refused as
/// unknown, not inferred. The reads happen before the transaction
/// (`ops::run`, `providers::muse_logins_refresh`); this only consults them.
#[logged]
fn muse_admit(engine: &Engine, tier: &str, version: Option<&str>, account: Option<&str>) -> Result<()> {
    if !catalog::is_muse(tier) {
        return Ok(());
    }
    let view = engine.accounts.view();
    let login = account.and_then(|id| view.get(id)).filter(|a| a.provider == catalog::MUSE).cloned();
    match crate::providers::muse_offer(engine, login.as_ref(), &catalog::model_for(tier, version)) {
        crate::providers::MuseOffer::Offered(_) => Ok(()),
        crate::providers::MuseOffer::NotOffered(why) => {
            refuse!(Conflict, "{why} now, so it cannot run {tier} (App settings › Providers › Muse lists what each login offers)")
        }
        crate::providers::MuseOffer::Unknown(why) => refuse!(Conflict, "{why}: {tier} is not placed on a login whose catalog is unknown; try again in a moment"),
    }
}

#[cfg(test)]
mod agy_placement_tests {
    use super::validate_account;
    use crate::usage::agy_reading_tests::placement_engine;

    #[tokio::test]
    async fn placement_uses_selected_profile_quota_and_preserves_native_refusal() {
        let engine = placement_engine(100, 12);
        assert!(validate_account(&engine, "synthetic-agy-placement", "flash", Some("google-2")).is_ok());
        for native in [None, Some("google/primary"), Some("google-native-alias")] {
            assert!(validate_account(&engine, "synthetic-agy-placement", "flash", native).is_err());
        }

        let engine = placement_engine(4, 100);
        assert!(validate_account(&engine, "synthetic-agy-placement", "flash", Some("google-2")).is_err());
        for native in [None, Some("google/primary"), Some("google-native-alias")] {
            assert!(validate_account(&engine, "synthetic-agy-placement", "flash", native).is_ok());
        }
        assert!(validate_account(&engine, "synthetic-agy-placement", "flash", Some("google-missing")).is_err());
    }
}

/// The seat's pinned model version (its scope's `model_version`).
#[nolog]
fn pinned(scope: &Value) -> Option<&str> {
    scope.get("model_version").and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// Whether an op places or tunes a Muse seat: its tier, or the tier of the
/// node it names. Its logins are read before the transaction (bounded).
#[logged]
async fn muse_op(engine: &Engine, org: &OrgHandle, req: &Value) -> bool {
    if !matches!(req["op"].as_str().unwrap_or(""), "hire" | "rehire" | "switch_model" | "account" | "retool") {
        return false;
    }
    if str_arg(req, "tier").is_some_and(catalog::is_muse) {
        return true;
    }
    let Some(node) = str_arg(req, "node") else { return false };
    let Ok(client) = engine.db.get().await else { return false };
    client.query_opt("SELECT tier FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted' LIMIT 1", &[&org.id, &node])
        .await.ok().flatten().is_some_and(|r| catalog::is_muse(&r.get::<_, String>(0)))
}

/// A conditional Antigravity tier (Argon, Barium, Carbon) is placed only
/// while the account's `agy models` lists it (3.x `provider_hire_gate`):
/// a hire, a model switch, or a rehire NAMING the tier. A plain rehire on the
/// stored tier is the recovery door and is not gated (3.x D-197), and seats
/// already running on the tier are never touched.
#[logged]
async fn agy_admit(engine: &Engine, op: &str, req: &Value) -> Result<()> {
    if !matches!(op, "hire" | "rehire" | "switch_model") {
        return Ok(());
    }
    let Some(tier) = str_arg(req, "tier") else { return Ok(()) };
    let Some(t) = catalog::tier(tier).filter(|t| t.conditional && t.provider == catalog::GOOGLE) else { return Ok(()) };
    if crate::providers::agy_admits(engine, tier).await {
        return Ok(());
    }
    refuse!(Conflict, "{tier} is a conditional Antigravity tier and is not available to this account right now: model '{}' is not in the model list the Antigravity CLI returns for this account yet", t.model)
}

/// The seat price of a tier (catalog, an OpenRouter favorite, or a language server's model).
#[logged]
fn seat_of(engine: &Engine, tier: &str) -> Result<f64> {
    if catalog::antigravity_claude(tier) && !engine.settings.antigravity_claude_enabled() {
        refuse!(Conflict, "Claude models through Antigravity are turned off in App settings > Runtime");
    }
    // a Muse tier's placement is judged once its login is known (`muse_admit`)
    if let Some(t) = catalog::tier(tier) {
        return Ok(t.seat);
    }
    if let Some((_, seat, _)) = engine.providers.openrouter_tiers().into_iter().find(|(t, _, _)| t == tier) {
        return Ok(seat);
    }
    if catalog::is_langserver(tier) {
        if let Some(seat) = crate::langserver::seat_of_tier(engine, tier) {
            return Ok(seat);
        }
        refuse!(NotFound, "{tier} is not a model of any language server this app knows (App settings › Providers › Language servers)");
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
    if matches!(actor,Actor::Agent {..}) && op=="hire" { super::hire_requirements::require_hire(req)?; }
    prepare(engine, org, req).await?;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let mut fx = Effects::default();
        let res = run_once(engine, org, &actor, &op, req, &mut fx).await;
        match res {
            Ok(mut v) => {
                finish(engine, org, fx, &mut v).await;
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

/// What an op reads before its transaction, never inside it.
#[logged]
pub(crate) async fn prepare(engine: &Arc<Engine>, org: &Arc<OrgHandle>, req: &Value) -> Result<()> {
    // a Muse seat is placed by its own login's catalog: read stale logins now,
    // before the transaction, never inside it
    if muse_op(engine, org, req).await {
        crate::providers::muse_logins_refresh(engine, &org.slug).await;
    }
    agy_admit(engine, req["op"].as_str().unwrap_or(""), req).await
}

/// Publish an op's effects after its transaction committed.
#[logged]
pub(crate) async fn finish(engine: &Arc<Engine>, org: &Arc<OrgHandle>, mut fx: Effects, out: &mut Value) {
    let effort = fx.effort.take();
    apply_effects(engine, org, fx).await;
    // 3.x: the level is committed now, so a running Claude turn may be sent it
    if let Some((id, previous, level)) = effort {
        out["effort_delivery"] = crate::runtime::deliver_effort(engine, id, &previous, &level).await;
    }
}

pub(crate) fn retryable(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<tokio_postgres::Error>()
            .and_then(|pe| pe.code())
            .map(|code| code.code() == "40001" || code.code() == "40P01")
            .unwrap_or(false)
    })
}

/// Dispatch and transaction policy share aliases; request/audit labels stay intact.
#[nolog]
fn canonical_op(op: &str) -> &str {
    match op {
        "promote" | "demote" => "move",
        _ => op,
    }
}

#[logged]
async fn run_once(engine: &Arc<Engine>, org: &Arc<OrgHandle>, actor: &Actor, _op: &str, req: &Value, fx: &mut Effects) -> Result<Value> {
    let mut client = engine.db.get().await?;
    // Position is chosen from a sibling snapshot. Predicate conflict detection
    // protects empty/root sets. Membership/order writers participate too,
    // so a move/restore/archive cannot escape the placement snapshot.
    // run retries 40001; no global topology lock is introduced.
    let isolation = if canonical_op(_op)=="reorder" || super::audience_notices::topology_changes_audiences(canonical_op(_op)) {
        tokio_postgres::IsolationLevel::Serializable
    } else { tokio_postgres::IsolationLevel::ReadCommitted };
    let tx = client.build_transaction().isolation_level(isolation).start().await?;
    let out = run_in_tx(engine, org, &tx, actor, req, fx).await?;
    tx.commit().await?;
    Ok(out)
}

/// Caller owns commit/rollback and publishes Effects only after commit.
#[logged]
pub(crate) async fn run_in_tx(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor,
                            req: &Value, fx: &mut Effects) -> Result<Value> {
    let before = if super::audience_notices::topology_changes_audiences(canonical_op(req["op"].as_str().unwrap_or(""))) {
        Some(super::audience_notices::snapshot(tx,org.id).await?)
    } else { None };
    let out=run_in_tx_without_audience_notices(engine,org,tx,actor,req,fx).await?;
    if let Some(before)=before {
        let after=super::audience_notices::snapshot(tx,org.id).await?;
        fx.mailboxes.extend(super::audience_notices::record_delta_tx(tx,org.id,&before,&after).await?);
    }
    Ok(out)
}

/// Multi-step undo/gesture callers record one net audience delta at their
/// transaction boundary, so an intermediate move cannot send a false notice.
#[logged]
pub(crate) async fn run_in_tx_without_audience_notices(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor,
                            req: &Value, fx: &mut Effects) -> Result<Value> {
    let op = req["op"].as_str().unwrap_or("");
    // User retool/rehire can raise org defaults. Staffing audience composites
    // also acquire the org in grant_tx, for either actor. Take it before any
    // node lock, matching settings and HTTP folder approval/direct edits.
    let user_scope = matches!(actor, Actor::User) && matches!(canonical_op(op), "retool" | "rehire");
    let staffing_audiences = matches!(canonical_op(op), "hire" | "rehire")
        && req.get("audiences").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    if user_scope || staffing_audiences {
        tx.query_one("SELECT id FROM ot.orgs WHERE id=$1 FOR NO KEY UPDATE", &[&org.id]).await?;
    }
    let mut out = match canonical_op(op) {
        "hire" => hire(engine, org, &tx, actor, req, fx).await?,
        "create_project" => create_project(engine, org, &tx, actor, req, fx).await?,
        "rehire" => rehire(engine, org, &tx, actor, req, fx).await?,
        "retire" => retire(org, &tx, actor, req, fx, false).await?,
        "rescind" => retire(org, &tx, actor, req, fx, true).await?,
        "dissolve" => dissolve(org, &tx, actor, req, fx).await?,
        "delete" => delete(org, &tx, actor, req, fx).await?,
        "move" => move_node(engine, org, &tx, actor, req, fx).await?,
        "rename" => rename(org, &tx, actor, req, fx, false).await?,
        "set_description" => set_description(org, &tx, actor, req, fx).await?,
        "set_mail_queue" => set_mail_queue(org, &tx, actor, req, fx).await?,
        "purge_mail_queue" => purge_mail_queue(org, &tx, actor, req, fx).await?,
        "dead_letters" => dead_letters(org, &tx, actor, req).await?,
        "dead_letter_retry" => dead_letter_retry(org, &tx, actor, req, fx).await?,
        "dead_letter_drop" => dead_letter_drop(org, &tx, actor, req, fx).await?,
        "set_slots" => set_slots(org, &tx, actor, req, fx).await?,
        "project_settings" => project_settings(org, &tx, actor, req).await?,
        "configure_project" => configure_project(org, &tx, actor, req, fx).await?,
        "project_presentations" => project_presentations(org, &tx, actor, req).await?,
        "slot_release" => slot_release(org, &tx, actor, req, fx).await?,
        "slot_status" | "slot_history" => slot_status(org, &tx, actor, req).await?,
        "slot_unqueue" => slot_unqueue(org, &tx, actor, req, fx).await?,
        "fire_project_event" => fire_project_event(org, &tx, actor, req, fx).await?,
        "project_listeners" => project_listeners(org, &tx, actor, req).await?,
        "reallocate" => reallocate(engine, org, &tx, actor, req, fx).await?,
        "switch_model" => switch_model(engine, org, &tx, actor, req, fx).await?,
        "reorder" => reorder(org, &tx, actor, req, fx).await?,
        "account" => account(engine, org, &tx, actor, req, fx).await?,
        "cheap_compact" => cheap_compact(engine, org, &tx, actor, req, fx).await?,
        "swap" => swap(engine, org, &tx, actor, req, fx).await?,
        "self_subjugate" => self_subjugate(engine, org, &tx, actor, req, fx).await?,
        "retool" => retool(engine, org, &tx, actor, req, fx, false, Dirs::Add).await?,
        "fast_defaults" => fast_defaults::run(engine, org, tx, actor, req, fx).await?,
        "moves" => moves(engine, org, &tx, actor, req, fx).await?,
        "reprice" => reprice(engine, org, &tx, actor, fx).await?,
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
            let raw_kind = str_arg(req, "kickoff_kind").unwrap_or("message");
            let kind = match raw_kind {
                "message" | "question" => raw_kind,
                // retired kinds (user ruling 2026-10-15) are stored as message
                "request" | "decision" | "status" => "message",
                other => refuse!(BadRequest, "unknown kickoff_kind {other}"),
            };
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
    if let Some((name, inherited_scope)) = fx.self_parent.take() {
        // All composite rights were checked while this newly admitted seat was
        // still a report. No warm, mail, or topology effect escapes before commit.
        self_subjugate(engine, org, tx, actor, &json!({"target": name}), fx).await?;
        let parent = node_by_name(tx, org.id, &name).await?;
        // Promotion normally takes the caller's configured scope. A new hire
        // gets only the effective capability captured at admission instead.
        // self_subjugate restores the old position. A parent hire instead keeps
        // the explicit placement chosen in the final sibling set at admission.
        let order = out["sibling_order"].as_f64().expect("hire returns sibling order");
        tx.execute("UPDATE ot.agents SET scope=$2, sibling_order=$3 WHERE id=$1", &[&parent.id, &inherited_scope, &order]).await?;
        if let Some(uid) = out["kickoff"].as_str() {
            // The kickoff was authorized as a report, but describes the final
            // parent allocation. Keep its mail and metadata in this transaction.
            tx.execute("UPDATE ot.mail SET ev=jsonb_set(ev,'{grant}',$3::jsonb) WHERE org_id=$1 AND uid=$2",
                &[&org.id, &uid, &json!(parent.grant)]).await?;
        }
        out["above_self"] = json!(true);
    }
    // projects stay transparent in the credit hierarchy (user 2026-10-16 20:40Z)
    fx.agents.extend(crate::domain::projects::settle_credits(tx, org.id).await?);
    if crate::runtime::watchdogs::events::interested(engine,"agents.live") {
        let ids=tx.query("SELECT id FROM ot.agents WHERE org_id=$1 AND state='live' AND kind='agent'", &[&org.id]).await?.iter().map(|r|r.get(0)).collect();
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
        crate::runtime::watchdogs::disarm(engine, *d);
    }
    // listeners paused or removed with their owners (an archive) changed
    // the count their projects' watches read; refresh those edges
    if !fx.dogs_off.is_empty() {
        if let Ok(client) = engine.db.get().await {
            if let Ok(rows) = client.query(
                "SELECT DISTINCT (memo->>'target_id')::bigint FROM ot.watchdogs
                  WHERE id = ANY($1) AND kind = 'project_listener' AND memo->>'target_id' IS NOT NULL",
                &[&fx.dogs_off]).await {
                for r in &rows {
                    let p: i64 = r.get(0);
                    if let Err(e) = Box::pin(crate::domain::listeners::evaluate(engine, org.id, p)).await {
                        tracing::warn!(project = p, error = %format!("{e:#}"), "listener watch evaluation after an archive failed");
                    }
                }
            }
        }
    }
    for d in &fx.dogs_on {
        crate::runtime::watchdogs::arm(engine, *d);
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
    for id in &fx.queued {
        crate::runtime::apply_queued(engine, org.id, *id);
    }
    for id in &fx.warm {
        crate::runtime::warm(engine, org.id, *id);
    }
    for (id, name, ack) in &fx.queue_modes {
        if let Err(e) = crate::domain::projects::mode_changed(engine, org.id, *id, name, *ack).await {
            tracing::warn!(project = %name, error = %format!("{e:#}"), "telling a project's watchers of its new queue mode failed");
        }
    }
    // a retired or stopped holder's un-acked project mail goes back to its queue
    for id in &fx.stop {
        crate::domain::projects::recheck_holder(engine, org.id, *id).await;
    }
    for p in &fx.queue_runs {
        if let Err(e) = Box::pin(crate::domain::projects::dispatch(engine, org.id, *p)).await {
            tracing::warn!(project = p, error = %format!("{e:#}"), "running a project's queue after a dead-letter retry failed");
        }
    }
    for (p, by, message) in &fx.project_fires {
        if let Err(e) = Box::pin(crate::domain::listeners::fire(engine, org.id, *p, by, message.as_deref())).await {
            tracing::warn!(project = p, error = %format!("{e:#}"), "firing a project's event failed");
        }
    }
    for p in &fx.slot_grants {
        if let Err(e) = Box::pin(crate::domain::slots::grant(engine, org.id, *p)).await {
            tracing::warn!(project = p, error = %format!("{e:#}"), "granting a project's free concurrency slots failed");
        }
    }
}

// ------------------------------------------------------------ hire

/// Scope authority is captured under the operation transaction, never a runtime view.
#[logged]
async fn capability(tx: &Transaction<'_>, id: i64, settings: &Value) -> Result<Value> {
    let mut sc = scope::org_ceiling(&settings["dirs"]);
    for n in chain(tx, id).await? { if !n.project() { sc = scope::clamp(&n.scope, &sc); } }
    Ok(sc)
}

#[logged]
async fn insertion_authority(tx: &Transaction<'_>, actor: &Actor, target: &Node) -> Result<()> {
    if target.state != "live" { refuse!(Conflict, "superior insertion needs a live target"); }
    if let Actor::Agent { id, .. } = actor {
        if agent_superior(tx,target.id).await?.is_none() { refuse!(Forbidden, "only the user can insert above a top-level agent"); }
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
        "fast_mode": req.get("fast_mode").cloned().unwrap_or_else(|| json!(
            s["default_fast_mode"][req["tier"].as_str().unwrap_or("")].as_bool().unwrap_or(false))),
    });
    if let Some(e) = str_arg(req, "effort") {
        out["effort"] = json!(e);
    }
    if let Some(b) = req.get("account_fallback").and_then(Value::as_bool) {
        out["account_fallback"] = json!(b);
    }
    scope::normalize(&out)
}

/// A self-hired parent may narrow fallback, never enable what its caller lacks.
#[nolog]
fn self_parent_fallback(requested: Option<bool>, effective: Option<bool>, default: Option<bool>) -> bool {
    requested.unwrap_or(true) && effective.or(default).unwrap_or(false)
}

#[cfg(test)]
mod parent_hire_tests {
    use super::self_parent_fallback;

    #[test]
    fn self_parent_fallback_respects_caller_and_explicit_opt_out() {
        for (effective, default, ceiling) in [
            (Some(false), Some(true), false),
            (Some(true), Some(false), true),
            (None, Some(false), false),
            (None, Some(true), true),
            (None, None, false),
        ] {
            assert_eq!(self_parent_fallback(None, effective, default), ceiling);
            assert_eq!(self_parent_fallback(Some(true), effective, default), ceiling);
            assert!(!self_parent_fallback(Some(false), effective, default));
        }
    }
}

/// 3.x's hire rules for a new hire's scope (PLAN I6, hire defaults kept). An
/// agent's hire has no defaults: it states its folders, every tool and its
/// visibility. A user's hire that names no folders gets its superior's (at
/// the top level, the organization's). A folder the superior does not hold,
/// or holds read-only when read/write is asked, is refused (3.x №30) rather
/// than stored where it can never take effect, and an agent cannot pass on
/// a tool or MCP server the hire's superior does not hold. A user's hire (or
/// a default) is clamped to the superior's tools and visibility instead,
/// with a warning; an agent asking for more visibility than the superior
/// holds is refused (D-021). Returns the warnings.
#[logged]
async fn hire_scope_rules(tx: &Transaction<'_>, actor: &Actor, parent: Option<&Node>, caps: &OrgCaps, req: &Value, sc: &mut Value) -> Result<Vec<String>> {
    // 3.x: a visibility or permission mode that is not one of the levels is
    // refused (an arbitrary string used to reach --permission-mode, D-030)
    if let Some(v) = str_arg(req, "org_visibility").filter(|v| !scope::VIS_LEVELS.contains(v)) {
        refuse!(BadRequest, "org_visibility must be one of {} (got '{v}')", scope::levels_text(scope::VIS_LEVELS));
    }
    if let Some(m) = str_arg(req, "permission_mode").filter(|m| !scope::PM_LEVELS.contains(m)) {
        refuse!(BadRequest, "permission_mode must be one of {} (got '{m}')", scope::levels_text(scope::PM_LEVELS));
    }
    let agent = matches!(actor, Actor::Agent { .. });
    let holder = match parent {
        Some(p) => Some(capability(tx, p.id, &caps.settings).await?),
        None => None,
    };
    match (req["add_dirs"].as_array(), &holder) {
        (None, Some(h)) => sc["add_dirs"] = h["add_dirs"].clone(),
        (None, None) => sc["add_dirs"] = caps.settings["dirs"].clone(),
        (Some(list), Some(h)) => {
            for d in list {
                let path = d["path"].as_str().unwrap_or("");
                let mut held: Option<&str> = None;
                for x in h["add_dirs"].as_array().into_iter().flatten() {
                    if scope::path_within(path, x["path"].as_str().unwrap_or("")) {
                        held = Some(if held == Some("rw") || x["mode"] == "rw" { "rw" } else { "ro" });
                    }
                }
                match held {
                    None => refuse!(Forbidden, "cannot grant dirs the parent does not hold (№30): [{path}]"),
                    Some("ro") if d["mode"].as_str().unwrap_or("rw") == "rw" => {
                        refuse!(Forbidden, "the parent holds {path} read-only; cannot grant read/write (№30)")
                    }
                    _ => {}
                }
            }
        }
        (Some(_), None) => {}
    }
    if let (true, Some(h), Some(t)) = (agent, &holder, req["tools"].as_object()) {
        for k in ["bash", "web", "edit", "subagents"] {
            if t.get(k) == Some(&json!(true)) && h["tools"][k] != json!(true) {
                refuse!(Forbidden, "the parent does not hold '{k}'; cannot grant it");
            }
        }
        let held: Vec<&str> = h["tools"]["mcp"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if !held.contains(&"*") {
            let extra: Vec<&str> = t.get("mcp").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
                .filter(|s| *s != "*" && !held.contains(s)).collect();
            if !extra.is_empty() {
                refuse!(Forbidden, "the parent does not hold MCP server(s) {extra:?}; cannot grant");
            }
        }
    }
    let mut warnings = Vec::new();
    if let Some(h) = &holder {
        if !agent {
            let mut lost: Vec<String> = Vec::new();
            for k in ["bash", "web", "edit", "subagents"] {
                if sc["tools"][k] == json!(true) && h["tools"][k] != json!(true) {
                    sc["tools"][k] = json!(false);
                    lost.push(k.to_string());
                }
            }
            let held: Vec<Value> = h["tools"]["mcp"].as_array().cloned().unwrap_or_default();
            if !held.contains(&json!("*")) {
                let want: Vec<Value> = sc["tools"]["mcp"].as_array().cloned().unwrap_or_default();
                if want.contains(&json!("*")) {
                    sc["tools"]["mcp"] = json!(held);
                } else {
                    lost.extend(want.iter().filter(|s| !held.contains(s)).filter_map(Value::as_str).map(|s| format!("mcp:{s}")));
                    sc["tools"]["mcp"] = json!(want.into_iter().filter(|s| held.contains(s)).collect::<Vec<_>>());
                }
            }
            if !lost.is_empty() {
                warnings.push(format!("tool grants clamped to the parent's own: {}", lost.join(", ")));
            }
        }
        let want = sc["org_visibility"].as_str().unwrap_or("subtree").to_string();
        let own = h["org_visibility"].as_str().unwrap_or("full");
        if scope::vis_rank(&want) > scope::vis_rank(own) {
            if agent && str_arg(req, "org_visibility").is_some() {
                refuse!(
                    Forbidden,
                    "org_visibility '{want}' exceeds the parent's own '{own}' — visibility is a capability and only shrinks downward"
                );
            }
            sc["org_visibility"] = json!(own);
            warnings.push(format!("org_visibility clamped to the parent's own ({own})"));
        }
    }
    *sc = scope::normalize(sc);
    Ok(warnings)
}

#[logged]
async fn hire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let agent = matches!(actor, Actor::Agent { .. });
    if agent { super::hire_requirements::require_hire(req)?; }
    ordering::index(req, agent)?;
    super::tool_groups::validate(&req["tools"])?;
    let name = valid_name(str_arg(req, "name").unwrap_or(""))?;
    let tier = str_arg(req, "tier").unwrap_or("").to_string();
    let seat = seat_of(engine, &tier)?;
    let provider = catalog::provider_of(&tier);
    if !engine.settings.provider_enabled(provider) {
        refuse!(Conflict, "{}", catalog::turned_off(provider));
    }
    // a Muse seat's level is judged with its login below
    if let Some(e) = str_arg(req, "effort").filter(|_| !catalog::is_muse(&tier)) {
        crate::providers::check_effort(engine, &tier, e)?;
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
        None if req["hire_type"] == "superior" => match actor {
            Actor::Agent { id, .. } => Some(node_by_id(tx, *id).await?),
            Actor::User => refuse!(BadRequest, "superior hiring needs a target"),
        },
        None => None,
    };
    let self_parent = matches!((actor, &anchor), (Actor::Agent { id, .. }, Some(a)) if *id == a.id);
    if self_parent {
        let a = anchor.as_ref().unwrap();
        if a.state != "live" { refuse!(Conflict, "self-superior hiring needs a live caller"); }
        let generation: i32 = tx.query_one("SELECT generation FROM ot.agents WHERE id=$1", &[&a.id]).await?.get(0);
        if req["_caller_generation"].as_i64() != Some(generation as i64) {
            refuse!(Conflict, "caller changed before parent hiring; retry from the current session");
        }
    }
    let parent: Option<Node> = match (&anchor, str_arg(req, "parent")) {
        (Some(a), _) if self_parent => Some(a.clone()),
        (Some(a), _) => match a.parent {
            Some(p) => Some(node_by_id(tx, p).await?),
            None => None,
        },
        (None, Some("user" | "@user")) => None,
        (None, Some(p)) => Some(node_by_name(tx, org.id, p).await?),
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
                if p.project() && within(tx, p.id, *id).await? {
                    refuse!(Forbidden, "hiring under project {} is paid by the agent above it: a project holds no credits and you cannot spend your superiors' (user 2026-10-16); ask the agent above the project to hire", p.name);
                }
                refuse!(Forbidden, "{name} can only hire under itself or its reports");
            }
        }
    } else if matches!(actor, Actor::Agent { .. }) {
        refuse!(Forbidden, "only the user hires at the top level");
    }
    if let Some(a) = &anchor { if !self_parent { insertion_authority(tx, actor, a).await?; } }
    let parent_id = parent.as_ref().map(|p| p.id);
    // Funding/composites use the temporary report; placement uses the final
    // parent's siblings, excluding the caller whose old position it takes.
    let placement_parent = if self_parent {
        match anchor.as_ref().unwrap().parent {
            Some(id) => Some(node_by_id(tx, id).await?),
            None => None,
        }
    } else { parent.clone() };
    let mut siblings = ordering::siblings(tx, org.id, placement_parent.as_ref().map(|p| p.id), anchor.as_ref().map(|a| a.id)).await?;
    let index = ordering::position(req, &siblings, agent)?;
    // a superior inserted above `anchor` also carries the anchor's stake
    let anchor_stake = anchor.as_ref().filter(|_| !self_parent).map(|a| a.seat + a.grant).unwrap_or(0.0);
    let grant = grant + anchor_stake;
    let need = seat + grant - anchor_stake;
    // an agent under a top-level project has no agent above it: the
    // user's top-level cap binds its grant as at the top level
    if let Some(p) = parent.as_ref().filter(|p| p.project()) {
        let credit_top: bool = tx.query_one("SELECT ot.superior_of($1) IS NULL", &[&p.id]).await?.get(0);
        if credit_top && grant > caps.max_top + 1e-9 {
            refuse!(Conflict, "a grant of {grant:.0} under top-level project {} is over this organization's top-level cap of {:.0}", p.name, caps.max_top);
        }
    }
    let raised = match &parent {
        Some(p) => ensure_room(tx, actor, Some(p.id), need, caps.cascade_hire, caps.max_top, fx).await?,
        None => {
            if grant > caps.max_top + 1e-9 {
                refuse!(Conflict, "a top-level grant of {grant:.0} is over this organization's cap of {:.0}", caps.max_top);
            }
            Vec::new()
        }
    };
    let mut warnings: Vec<String> = Vec::new();
    let mut sc = if let Some(a) = &anchor {
        if a.state != "live" { refuse!(Conflict, "superior insertion needs a live target"); }
        if !self_parent { insertion_authority(tx, actor, a).await?; }
        for field in ["add_dirs", "tools", "org_visibility", "permission_mode"] {
            if !req[field].is_null() { refuse!(BadRequest, "superior insertion inherits target scope; omit {field}"); }
        }
        let target_scope = capability(tx, a.id, &caps.settings).await?;
        if self_parent {
            let tool = if req.get("staff_item").is_some() { "orgtree_staff" } else { "orgtree_hire" };
            if !super::tool_groups::allows(&target_scope["tools"], tool) {
                refuse!(Forbidden, "caller no longer holds {tool}");
            }
        }
        let mut inherited = hire_scope(&caps, req);
        for k in ["add_dirs", "tools", "org_visibility", "permission_mode"] { inherited[k] = target_scope[k].clone(); }
        if self_parent {
            inherited["account_fallback"] = json!(self_parent_fallback(
                req["account_fallback"].as_bool(), target_scope["account_fallback"].as_bool(),
                caps.settings["account_fallback_default"].as_bool()));
        }
        inherited
    } else {
        let mut sc = hire_scope(&caps, req);
        warnings = hire_scope_rules(tx, actor, parent.as_ref(), &caps, req, &mut sc).await?;
        sc
    };
    sc["fast_mode"] = json!(crate::providers::fast_mode::hire_enabled(
        &engine.providers.state.load(), &tier, req, &caps.settings)?);
    // An omitted choice uses only a valid compatible org default, never the
    // parent's bound account. Explicit empty/primary means provider primary.
    let explicit = req.get("account").and_then(Value::as_str);
    let selected = if let Some(raw) = explicit {
        validate_account(engine, &org.slug, &tier, Some(raw))?;
        Some(raw)
    } else {
        caps.settings["default_account"].as_str().filter(|raw| validate_account(engine, &org.slug, &tier, Some(raw)).is_ok())
    };
    let mut account = match crate::accounts::choice(selected) {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
    // the default login switched off for this org: an omitted account is
    // placed on the best one it allows (ruling 2026-10-10); an explicit
    // primary was refused above
    let provider = catalog::provider_of(&tier);
    // every OpenRouter key is alike: a hire naming none is placed on the best
    // key the org uses (balancing at placement) and bound to it
    let or_tier = catalog::is_openrouter(&tier);
    if account.is_none() && !catalog::is_langserver(&tier)
        && (or_tier || !crate::org_accounts::allowed(Some(&org.slug), &crate::org_accounts::default_lane(provider))) {
        // (an explicit default names no OpenRouter key: it is placed too)
        match (explicit.is_none() || or_tier, crate::org_accounts::best_allowed(engine, &org.slug, &tier)) {
            (true, Some(best)) => account = Some(best),
            _ if or_tier => refuse!(Conflict, "no OpenRouter key this org uses can run {tier} now; name one, or add or switch on \
                                               a key in App settings › Providers › OpenRouter (Org settings › Accounts)"),
            _ => refuse!(Conflict, "{}", crate::org_accounts::refusal(engine, &org.slug, &crate::org_accounts::default_lane(provider), provider)),
        }
    }
    // a Muse seat: the login it lands on (explicit, the org's default, the
    // best allowed, or the user's own) must offer the model, and its level
    // must be one that model names there
    if catalog::is_muse(&tier) {
        muse_admit(engine, &tier, None, account.as_deref())?;
        if let Some(e) = str_arg(req, "effort") {
            let view = engine.accounts.view();
            crate::providers::check_effort_on(engine, &tier, None, account.as_deref().and_then(|id| view.get(id)), e)?;
        }
    }
    // A user/internal hire without placement keeps the historical append rule,
    // including a superior insertion (whose anchor used to count in max).
    let order = if req.get("index").is_none() && req.get("before").is_none() && req.get("after").is_none() {
        tx.query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &parent_id]).await?.get(0)
    } else {
        let (order, changed) = ordering::place(tx, &mut siblings, index).await?;
        fx.agents.extend(changed);
        order
    };
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
        if catalog::is_openrouter(&tier) {
            // only a harness installed here (user 2026-10-13)
            crate::harnesses::require_choice(engine, catalog::OPENROUTER, h)?;
            // an explicit harness pins the seat: it wins over its key's
            // harness, now and after the key changes (user ruling 2026-10-13)
            tx.execute("UPDATE ot.agents SET extra = extra || jsonb_build_object('harness', $2::text, 'harness_pin', true) WHERE id = $1",
                &[&id, &h]).await?;
        } else {
            // any other tier always runs on its own CLI: naming that one is a no-op
            let native = match catalog::provider_of(&tier) {
                catalog::OPENAI => "codex-cli".to_string(),
                catalog::GOOGLE => "antigravity".to_string(),
                // a language server's harness is the one it was added with
                catalog::LANGSERVER => crate::langserver::route_of(engine, &tier)
                    .and_then(|(s, _)| s["harness"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "claude-code".to_string()),
                _ => "claude-code".to_string(),
            };
            if h != native {
                refuse!(BadRequest, "harness only applies to OpenRouter tiers; {tier} always runs on {native}");
            }
        }
    }
    if self_parent {
        fx.self_parent = Some((name.clone(), sc.clone()));
    } else if let Some(a) = &anchor {
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
                "above": anchor.as_ref().map(|a| a.name.clone()), "cascaded": raised, "fast_mode": sc["fast_mode"] }), fx)
    .await?;
    fx.agents.insert(id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    fx.warm.push(id);
    fx.scratch.push(scratch);
    let mut out = json!({ "node": name, "cascaded": raised, "parent": placement_parent.as_ref().map(|p| &p.name),
        "index": index, "sibling_order": order, "live_sibling_count": siblings.len() + 1 });
    if !warnings.is_empty() {
        out["warnings"] = json!(warnings);
    }
    Ok(out)
}

/// A new project node (docs/rust-engine/PROJECT-NODES.md): under `parent`
/// (an agent's default: itself; the user's: the top level), at `index`
/// among the live siblings (required from agents, as for hires). Free: no
/// seat, no credits, no CLI. Its folder is its team workspace.
#[logged]
async fn create_project(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let agent = matches!(actor, Actor::Agent { .. });
    let name = valid_name(str_arg(req, "name").unwrap_or(""))?;
    name_free(tx, org.id, &name).await?;
    // `above`: the project takes that node's place and the node goes under it
    // (the hire token's top edge, user 2026-10-16 21:02Z)
    let anchor = match str_arg(req, "above") {
        Some(a) => Some(node_by_name(tx, org.id, a).await?),
        None => None,
    };
    if anchor.is_none() {
        ordering::index(req, agent)?;
    }
    let parent: Option<Node> = match (&anchor, str_arg(req, "parent")) {
        (Some(a), _) => {
            insertion_authority(tx, actor, a).await?;
            match a.parent { Some(p) => Some(node_by_id(tx, p).await?), None => None }
        }
        (None, Some("user" | "@user")) => None,
        (None, Some(p)) => Some(node_by_name(tx, org.id, p).await?),
        (None, None) => match actor {
            Actor::Agent { id, .. } => Some(node_by_id(tx, *id).await?),
            Actor::User => None,
        },
    };
    if let (Some(p), None) = (&parent, &anchor) {
        if p.state != "live" {
            refuse!(Conflict, "{} is not live", p.name);
        }
        if let Actor::Agent { id, name } = actor {
            let ok = p.id == *id || within(tx, *id, p.id).await? || (p.project() && within(tx, p.id, *id).await?);
            if !ok {
                refuse!(Forbidden, "{name} can create a project only under itself, its reports, or a project it is inside");
            }
        }
    } else if agent && anchor.is_none() {
        refuse!(Forbidden, "only the user creates a project at the top level");
    }
    let parent_id = parent.as_ref().map(|p| p.id);
    let mut siblings = ordering::siblings(tx, org.id, parent_id, anchor.as_ref().map(|a| a.id)).await?;
    let index = match &anchor {
        // the anchor's own slot among its siblings
        Some(a) => {
            let order: f64 = tx.query_one("SELECT sibling_order FROM ot.agents WHERE id = $1", &[&a.id]).await?.get(0);
            siblings.iter().filter(|s| s.order < order).count()
        }
        None => ordering::position(req, &siblings, agent)?,
    };
    let order: f64 = if let Some(a) = &anchor {
        tx.query_one("SELECT sibling_order FROM ot.agents WHERE id = $1", &[&a.id]).await?.get(0)
    } else if req.get("index").is_none() && req.get("before").is_none() && req.get("after").is_none() {
        tx.query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &parent_id]).await?.get(0)
    } else {
        let (order, changed) = ordering::place(tx, &mut siblings, index).await?;
        fx.agents.extend(changed);
        order
    };
    let description = str_arg(req, "description").map(str::to_string);
    let title = str_arg(req, "title").map(str::to_string).unwrap_or_default();
    let born = uuid::Uuid::new_v4().to_string();
    let id: i64 = tx
        .query_one(
            "INSERT INTO ot.agents (org_id, name, parent_id, sibling_order, state, title, charter, tier, seat, grant_credits,
                                    scope, generation, born, kind)
             VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, 0, 0, $8, 1, $9, $10) RETURNING id",
            &[&org.id, &name, &parent_id, &order, &title, &description, &crate::domain::projects::TIER, &scope::transparent(),
              &born, &crate::domain::projects::KIND],
        )
        .await?
        .get(0);
    let folder = crate::domain::teams::workspace(&engine.cfg.teams_dir(&org.slug), id).to_string_lossy().to_string();
    tx.execute("UPDATE ot.agents SET scratch_dir = $2 WHERE id = $1", &[&id, &folder]).await?;
    if let Some(a) = &anchor {
        // the wrapped node and its team move in; the project is transparent
        // for scope and credits, so only their folders and notes change
        tx.execute("UPDATE ot.agents SET parent_id = $2, sibling_order = 1, row_version = row_version + 1 WHERE id = $1",
            &[&a.id, &id]).await?;
        fx.agents.insert(a.id);
        fx.reconfigure.push(a.id);
        fx.reconfigure.extend(subtree(tx, a.id).await?);
    }
    event(tx, org.id, "create_project", actor, Some(id),
          json!({ "node": name, "kind": "project", "parent": parent.as_ref().map(|p| p.name.clone()),
                  "above": anchor.as_ref().map(|a| a.name.clone()) }), fx).await?;
    fx.agents.insert(id);
    if let Some(p) = &parent {
        fx.agents.insert(p.id);
    }
    fx.events = true;
    fx.scratch.push(folder.clone());
    Ok(json!({ "node": name, "kind": "project", "parent": parent.as_ref().map(|p| &p.name), "index": index,
               "sibling_order": order, "live_sibling_count": siblings.len() + 1, "folder": folder }))
}

/// `rehire` of a retired project: it comes back where it was, free, with
/// no model or account to choose. Its retired agents stay retired.
#[logged]
async fn restore_project(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, n: &Node, fx: &mut Effects) -> Result<Value> {
    authorize(tx, actor, n, "restore").await?;
    if n.state == "live" {
        return Ok(json!({ "node": n.name, "cost": 0, "warnings": [format!("project {} is already live — nothing to do", n.name)] }));
    }
    if n.state != "archived" {
        refuse!(Conflict, "project {} cannot be restored from state {}", n.name, n.state);
    }
    if let Some(p) = n.parent {
        let p = node_by_id(tx, p).await?;
        if p.state != "live" {
            refuse!(Conflict, "restore {} first: project {} goes back under it", p.name, n.name);
        }
    } else if !matches!(actor, Actor::User) {
        refuse!(Forbidden, "only the user restores a top-level project");
    }
    let order: f64 = tx
        .query_one(
            "SELECT coalesce(max(sibling_order), 0)::float8 + 1 FROM ot.agents WHERE org_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND state = 'live'",
            &[&org.id, &n.parent]).await?.get(0);
    tx.execute(
        "UPDATE ot.agents SET state = 'live', archived_at = NULL, seat = 0, grant_credits = 0, sibling_order = $2,
                row_version = row_version + 1 WHERE id = $1",
        &[&n.id, &order],
    )
    .await?;
    event(tx, org.id, "rehire", actor, Some(n.id), json!({ "node": n.name, "kind": "project" }), fx).await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.events = true;
    Ok(json!({ "node": n.name, "cost": 0, "kind": "project" }))
}

#[logged]
async fn rehire(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    if req.get("index").is_some() {
        refuse!(BadRequest, "index places a new hire; rehire retains existing placement. Use reorder after restoration");
    }
    super::tool_groups::validate(&req["tools"])?;
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.project() {
        return restore_project(org, tx, actor, &n, fx).await;
    }
    if n.state == "live" {
        // asking for what is already true is a no-op, not an error (3.x)
        authorize(tx, actor, &n, "rehire").await?;
        return Ok(json!({ "node": n.name, "cost": 0, "warnings": [format!("{} is already live — nothing to do", n.name)] }));
    }
    // 3.x re-seeded an unrecoverable agent (one whose session is lost, as
    // imported 3.x agents may be): it comes back on a fresh session, which
    // here starts with the handoff note (decision 43)
    let fresh = n.state == "unrecoverable";
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
    muse_admit(engine, &tier, pinned(&n.scope), str_arg(req, "account").or(n.account.as_deref()))?;
    let anchor_stake = anchor.as_ref().map(|a| a.seat + a.grant).unwrap_or(0.0);
    let grant = req["grant"].as_f64().unwrap_or(n.grant);
    if grant < 0.0 { refuse!(BadRequest, "a grant cannot be negative"); }
    let grant = grant + anchor_stake;
    let credit_top=match &parent {None=>true,Some(p)=>p.project() && agent_superior(tx,p.id).await?.is_none()};
    if credit_top && grant > caps.max_top + 1e-9 {
        refuse!(Conflict, "a top-level grant of {grant:.0} is over this organization's cap of {:.0}", caps.max_top);
    }
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
    // An explicit tier is the newer model choice: a switch queued before the
    // retire is cancelled, as an explicit account cancels a queued account
    // below (3.x applied the queue before archiving; decision 62)
    if str_arg(req, "tier").is_some() {
        let queued: Option<Value> = tx.query_one("SELECT pending_switch FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
        if let Some(queued) = queued {
            tx.execute("UPDATE ot.agents SET pending_switch = NULL, row_version = row_version + 1 WHERE id = $1", &[&n.id]).await?;
            event(tx, org.id, "switch_cancelled", actor, Some(n.id), json!({ "node": n.name, "target": queued["tier"], "by": actor.label() }), fx).await?;
            fx.events = true;
        }
    }
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
        let queued: Option<Value> = tx.query_one("SELECT pending_account FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
        tx.execute("UPDATE ot.agents SET account = $2, pending_account = NULL WHERE id = $1", &[&n.id, &selected]).await?;
        if let Some(queued) = queued {
            event(tx, org.id, "account_queue_cancelled", actor, Some(n.id), json!({ "node": n.name, "account": queued["account"] }), fx).await?;
        }
        event(tx, org.id, "account", actor, Some(n.id), json!({ "node": n.name, "account": selected }), fx).await?;
        scope_req.as_object_mut().unwrap().remove("account");
    }
    // Placement was authorized before mutation. Self-superior insertion has
    // now moved this caller beneath the restored seat; do not reauthorize
    // that already-approved composite against its changed topology.
    // a rehire's folders are its whole list, as at hire (3.x)
    retool(engine, org, tx, actor, &scope_req, fx, anchor.is_some(), Dirs::Replace).await?;
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
    if fresh {
        tx.execute(
            "UPDATE ot.agents SET session_id = NULL, occupancy = NULL, occupancy_est = true,
                    extra = jsonb_set(extra, '{handoff_due}', to_jsonb('your earlier session could not be recovered'::text)),
                    row_version = row_version + 1 WHERE id = $1",
            &[&n.id],
        )
        .await?;
        tx.execute(
            "UPDATE ot.agent_sessions SET ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'unrecoverable')
              WHERE agent_id = $1 AND ended_at IS NULL",
            &[&n.id],
        )
        .await?;
        warnings.push(format!(
            "{name} was unrecoverable (its earlier session is lost): it starts on a fresh session with a handoff note"
        ));
    }
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

/// Closed seats cannot leave actionable request cards behind. The card reads
/// "moot — the agent left" as in 3.x, not "withdrawn": the agent did not act.
#[logged]
async fn moot_asks(tx: &Transaction<'_>, ids: &[i64], fx: &mut Effects) -> Result<()> {
    tx.execute("UPDATE ot.asks SET status = 'moot', resolved_at = now(), reason = 'the asking agent left before an answer arrived' WHERE agent_id = ANY($1) AND status = 'open'", &[&ids]).await?;
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
            if tx.query_opt("SELECT 1 FROM ot.agents WHERE id=ANY($1) AND kind='agent' AND state='live' LIMIT 1", &[&team]).await?.is_some() {
                refuse!(Conflict, "you still have live reports; retire or hand them over first");
            }
        }
        _ => {
            authorize(tx, actor, &n, "retire").await?;
            not_inside(tx, actor, &n, "retire").await?;
        }
    }
    // a seat with live reports takes its whole team with it
    let reports: Vec<String> = tx
        .query("SELECT name FROM ot.agents WHERE id IN (SELECT ot.reports_of($1,$2)) AND state='live' ORDER BY sibling_order,id", &[&org.id,&n.id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
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
        if let Some(pid) = agent_superior(tx,n.id).await? {
            // the freed stake goes back to the user, not the superior
            let p = node_by_id(tx, pid).await?;
            // The archived reports have already released their stakes, but
            // structural project mirrors are settled only at commit.
            let h:f64=tx.query_one("SELECT coalesce(sum(seat+grant_credits),0)::float8 FROM ot.agents
                WHERE id IN (SELECT ot.reports_of($1,$2)) AND state='live'", &[&org.id,&pid]).await?.get(0);
            clawed = (n.seat + n.grant).min((p.grant - h).max(0.0));
            tx.execute(
                "UPDATE ot.agents SET grant_credits = grant_credits - $2::float8::numeric, row_version = row_version + 1 WHERE id = $1",
                &[&pid, &clawed],
            )
            .await?;
            fx.agents.insert(pid);
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
    let mut out = json!({ "node": n.name, "freed": n.seat + n.grant });
    if !reports.is_empty() {
        // 3.x said so: the retire was a dissolve of the whole subtree
        out["warnings"] = json!([format!(
            "{} had live reports [{}] — retire became dissolve (the whole subtree is archived)",
            n.name,
            reports.join(", ")
        )]);
    }
    Ok(out)
}

#[logged]
async fn dissolve(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.state != "live" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    authorize(tx, actor, &n, "dissolve").await?;
    not_inside(tx, actor, &n, "dissolve").await?;
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
            "UPDATE ot.watchdogs SET state = 'removed' WHERE owner_agent_id = ANY($1) AND state IN ('armed', 'paused', 'exited') RETURNING id",
            &[&ids],
        )
        .await?;
    fx.dogs_off.extend(gone.iter().map(|r| r.get::<_, i64>(0)));
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
        let credit_top: bool = !n.project()
            && tx.query_one("SELECT ot.superior_of($1) IS NULL", &[id]).await?.get(0);
        if credit_top && grant > caps.max_top + 1e-9 {
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
    if n.state == "deleted" {
        refuse!(Conflict, "{} is not live", n.name);
    }
    // 3.x: an archived (or unrecoverable) agent may be moved too; it holds no
    // credits, so the move is free, and its rehire cost falls on the new superior
    let live = n.state == "live";
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
            // its own reports may also go into a project it is inside (the
            // project counts as its subordinate, user 2026-10-16 16:11Z)
            Some(t) if t.project() && n.id != *id && within(tx, t.id, *id).await? && within(tx, *id, n.id).await? => {}
            _ => refuse!(Forbidden, "{name} can only move agents within its own team, or its own reports into a project it is inside"),
        }
    }
    if target.as_ref().map(|t| t.id) == n.parent {
        return Ok(json!({ "node": n.name, "unchanged": true }));
    }
    let stake = if live { n.seat + n.grant + credits.deltas.get(&n.id).copied().unwrap_or(0.0) } else { 0.0 };
    let old_chain = match n.parent { Some(id) => chain(tx, id).await?, None => Vec::new() };
    let old_superior: Option<i64> = tx.query_one("SELECT ot.superior_of($1)", &[&n.id]).await?.get(0);
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
          "old_superior_id": old_superior, "cascaded": raised }), fx)
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
    let mut out = json!({ "node": n.name, "cascaded": raised });
    if !live {
        let payer=match agent_superior(tx,n.id).await? {
            Some(id)=>node_by_id(tx,id).await?.name,
            None=>"the user".to_owned(),
        };
        out["warnings"] = json!([format!("{} is archived: moving it is free, but its rehire cost ({}) now falls on {} (§4.5)",
            n.name, n.seat + n.grant, payer)]);
    }
    Ok(out)
}

#[logged]
async fn rename(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, preauthorized: bool) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.project() { authorize_project_policy(tx, actor, &n, "rename it").await?; }
    else if !preauthorized { authorize(tx, actor, &n, "rename").await?; }
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
    tx.execute("UPDATE ot.watchdogs SET target = $3 WHERE org_id = $1 AND kind IN ('activity', 'fair_queue', 'slot', 'project_listener', 'listener_watch') AND target = $2",
        &[&org.id, &n.name, &new])
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

/// Replace a project's description, the standing charter of every agent
/// under it (user 2026-10-17 19:14Z, 20:06Z). Only the user and agents above
/// may write it (user 2026-10-19); members may still read it.
#[logged]
async fn set_description(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: set_description edits a project's description (an agent's charter changes with retool)", n.name);
    }
    authorize(tx, actor, &n, "describe").await?;
    // Omission reads. Only an explicit string may change or clear a Summary;
    // treating an absent optional argument as "" silently destroyed it.
    let Some(description) = req.get("description").filter(|v| !v.is_null()) else {
        let text: Option<String> = tx.query_one("SELECT charter FROM ot.agents WHERE id=$1", &[&n.id]).await?.get(0);
        return Ok(json!({"node":n.name,"description":text.unwrap_or_default()}));
    };
    let Some(text) = description.as_str() else { refuse!(BadRequest,"description must be a string"); };
    authorize_project_policy(tx, actor, &n, "change its Summary").await?;
    let text = text.trim().to_string();
    tx.execute("UPDATE ot.agents SET charter = $2, row_version = row_version + 1 WHERE id = $1",
        &[&n.id, &(!text.is_empty()).then_some(text.clone())]).await?;
    event(tx, org.id, "set_description", actor, Some(n.id), json!({ "node": n.name }), fx).await?;
    fx.agents.insert(n.id);
    // the agents under it carry the description in their instructions
    fx.reconfigure.extend(subtree(tx, n.id).await?);
    Ok(json!({ "node": n.name, "description": text }))
}

/// Set a project's mail queue (user 2026-10-18 08:01Z-08:08Z): `mode`,
/// `round_robin` (the default) or `ack`, and/or `exclude_sender`, which keeps
/// a sender's own mail from being handed back to it (off by default).
/// Whoever controls the project may. On a mode change its watchers are told
/// after commit, and the queue runs.
#[logged]
async fn set_mail_queue(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has a mail queue", n.name);
    }
    authorize_project_policy(tx, actor, &n, "set its mail queue").await?;
    let ack = match str_arg(req, "mode") {
        None => None,
        Some(m) if m == crate::domain::projects::MODE_ACK => Some(true),
        Some(m) if m == crate::domain::projects::MODE_ROUND_ROBIN => Some(false),
        Some(_) => refuse!(BadRequest, "mode is round_robin or ack"),
    };
    let flag = |k: &str| -> Result<Option<bool>> {
        match req.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => Ok(Some(v.as_bool().ok_or_else(|| anyhow::Error::new(
                crate::domain::UserError::BadRequest(format!("{k} is true or false"))))?)),
        }
    };
    let exclude = flag("exclude_sender")?;
    let timeout = flag("ack_timeout")?;
    let reminder = flag("turn_end_reminder")?;
    let attempts = match req.get("max_attempts") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_i64().filter(|n| (1..=100).contains(n)) {
            Some(n) => Some(n),
            None => refuse!(BadRequest, "max_attempts is a number from 1 to 100"),
        },
    };
    let reminders = match req.get("ack_reminders") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_i64().filter(|n| (1..=super::projects::MAX_ACK_REMINDERS).contains(n)) {
            Some(n) => Some(n),
            None => refuse!(BadRequest, "ack_reminders is an integer from 1 to 10"),
        },
    };
    if ack.is_none() && exclude.is_none() && timeout.is_none() && attempts.is_none() && reminders.is_none() && reminder.is_none() {
        refuse!(BadRequest, "set_mail_queue needs mode (round_robin or ack), exclude_sender, ack_timeout, max_attempts, ack_reminders or turn_end_reminder");
    }
    let before: Value = tx.query_one("SELECT scope FROM ot.agents WHERE id = $1 FOR UPDATE", &[&n.id]).await?.get(0);
    let mut next = if before.is_object() { before.clone() } else { json!({}) };
    if let Some(a) = ack {
        next["mail_queue"] = json!(if a { crate::domain::projects::MODE_ACK } else { crate::domain::projects::MODE_ROUND_ROBIN });
    }
    if let Some(x) = exclude {
        next["mail_queue_exclude_sender"] = json!(x);
    }
    if let Some(x) = timeout {
        next["mail_queue_ack_timeout"] = json!(x);
    }
    if let Some(n) = attempts {
        next["mail_queue_max_attempts"] = json!(n);
    }
    if let Some(n) = reminders {
        next["mail_queue_ack_reminders"] = json!(n);
    }
    if let Some(x) = reminder {
        next["mail_queue_turn_end_reminder"] = json!(x);
    }
    let mode_changed = ack.is_some_and(|a| crate::domain::projects::ack_mode(&before) != a);
    tx.execute("UPDATE ot.agents SET scope = $2, row_version = row_version + 1 WHERE id = $1", &[&n.id, &next]).await?;
    event(tx, org.id, "set_mail_queue", actor, Some(n.id),
        json!({ "node": n.name, "mode": next["mail_queue"], "exclude_sender": next["mail_queue_exclude_sender"] }), fx).await?;
    fx.agents.insert(n.id);
    if mode_changed {
        fx.queue_modes.push((n.id, n.name.clone(), ack == Some(true)));
    }
    Ok(json!({ "node": n.name, "mode": next["mail_queue"].as_str().unwrap_or(crate::domain::projects::MODE_ROUND_ROBIN),
               "exclude_sender": crate::domain::projects::exclude_sender(&next),
               "ack_timeout": crate::domain::projects::ack_timeout(&next),
               "max_attempts": crate::domain::projects::max_attempts(&next),
               "ack_reminders": crate::domain::projects::ack_reminders(&next),
               "turn_end_reminder": crate::domain::projects::turn_end_reminder(&next), "mode_changed": mode_changed }))
}

/// Read the complete Project settings values with the desktop's project reach.
#[logged]
async fn project_settings(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value) -> Result<Value> {
    let n=node_by_name(tx,org.id,str_arg(req,"node").unwrap_or("")).await?;
    if !n.project() { refuse!(BadRequest,"{} is not a project",n.name); }
    authorize(tx,actor,&n,"read project settings").await?;
    let description:Option<String>=tx.query_one("SELECT charter FROM ot.agents WHERE id=$1", &[&n.id]).await?.get(0);
    Ok(json!({"node":n.name,"state":n.state,"settings":{
        "name":n.name,"description":description.unwrap_or_default(),"peer_mail":super::peer_mail::enabled(&n.scope),
        "mail_queue":if super::projects::ack_mode(&n.scope) {super::projects::MODE_ACK} else {super::projects::MODE_ROUND_ROBIN},
        "exclude_sender":super::projects::exclude_sender(&n.scope),"ack_timeout":super::projects::ack_timeout(&n.scope),
        "max_attempts":super::projects::max_attempts(&n.scope),"ack_reminders":super::projects::ack_reminders(&n.scope),
        "turn_end_reminder":super::projects::turn_end_reminder(&n.scope),"slots":super::slots::capacity(&n.scope)
    }}))
}

/// Prepare an explicit patch; canonical operations retain value validation and effects.
#[nolog]
fn project_setting_ops(node:&str, settings:&Value) -> Result<Vec<Value>> {
    let Some(fields)=settings.as_object() else { refuse!(BadRequest,"settings must be an object"); };
    if fields.is_empty() { refuse!(BadRequest,"configure needs at least one setting"); }
    for (k,v) in fields {
        let valid=match k.as_str() {
            "name"|"description"=>v.is_string(),
            "peer_mail"|"exclude_sender"|"ack_timeout"|"turn_end_reminder"=>v.is_boolean(),
            "mail_queue"=>matches!(v.as_str(),Some("ack"|"round_robin")),
            "slots"=>v.as_i64().is_some_and(|n|(0..=super::slots::MAX_CAPACITY).contains(&n)),
            "max_attempts"=>v.as_i64().is_some_and(|n|(1..=100).contains(&n)),
            "ack_reminders"=>v.as_i64().is_some_and(|n|(1..=super::projects::MAX_ACK_REMINDERS).contains(&n)),
            _=>refuse!(BadRequest,"unknown project setting {k}"),
        };
        if !valid { refuse!(BadRequest,"invalid project setting {k}"); }
    }
    let mut out=Vec::new();
    if let Some(v)=settings.get("description") { out.push(json!({"op":"set_description","node":node,"description":v})); }
    let mut queue=json!({"op":"set_mail_queue","node":node});
    for (from,to) in [("mail_queue","mode"),("exclude_sender","exclude_sender"),("ack_timeout","ack_timeout"),("max_attempts","max_attempts"),("ack_reminders","ack_reminders"),("turn_end_reminder","turn_end_reminder")] {
        if let Some(v)=settings.get(from) { queue[to]=v.clone(); }
    }
    if queue.as_object().unwrap().len()>2 { out.push(queue); }
    if let Some(v)=settings.get("slots") { out.push(json!({"op":"set_slots","node":node,"capacity":v})); }
    if let Some(v)=settings.get("peer_mail") { out.push(json!({"op":"project_peer_mail","node":node,"peer_mail":v})); }
    // Rename last: every earlier operation addresses the original identity.
    if let Some(v)=settings.get("name") { valid_name(v.as_str().unwrap())?; out.push(json!({"op":"rename","node":node,"name":v})); }
    Ok(out)
}

#[logged]
async fn configure_project(org:&Arc<OrgHandle>,tx:&Transaction<'_>,actor:&Actor,req:&Value,fx:&mut Effects)->Result<Value> {
    let n=node_by_name(tx,org.id,str_arg(req,"node").unwrap_or("")).await?;
    if !n.project() { refuse!(BadRequest,"{} is not a project",n.name); }
    authorize_project_policy(tx,actor,&n,"configure it").await?;
    let settings=&req["settings"];
    for step in project_setting_ops(&n.name,settings)? {
        match step["op"].as_str().unwrap() {
            "set_description"=>{set_description(org,tx,actor,&step,fx).await?;},
            "set_mail_queue"=>{set_mail_queue(org,tx,actor,&step,fx).await?;},
            "set_slots"=>{set_slots(org,tx,actor,&step,fx).await?;},
            "rename"=>{rename(org,tx,actor,&step,fx,false).await?;},
            "project_peer_mail"=>{
                let current:Value=tx.query_one("SELECT scope FROM ot.agents WHERE id=$1",&[&n.id]).await?.get(0);
                let next=super::peer_mail::with_setting(&current,step["peer_mail"].as_bool().unwrap());
                tx.execute("UPDATE ot.agents SET scope=$2,row_version=row_version+1 WHERE id=$1",&[&n.id,&next]).await?;
                event(tx,org.id,"scope",actor,Some(n.id),json!({"node":n.name,"change":{"peer_mail":step["peer_mail"]}}),fx).await?;
                fx.agents.insert(n.id);
            },
            _=>unreachable!(),
        }
    }
    let name=settings["name"].as_str().unwrap_or(&n.name);
    project_settings(org,tx,actor,&json!({"node":name})).await
}

#[logged]
async fn project_presentations(org:&Arc<OrgHandle>,tx:&Transaction<'_>,actor:&Actor,req:&Value)->Result<Value> {
    let n=node_by_name(tx,org.id,str_arg(req,"node").unwrap_or("")).await?;
    if !n.project() { refuse!(BadRequest,"{} is not a project",n.name); }
    authorize(tx,actor,&n,"read project presentations").await?;
    let mut members=if req["team"].as_bool().unwrap_or(false) {subtree(tx,n.id).await?} else {Vec::new()};
    members.push(n.id);
    let document=str_arg(req,"document");
    if req["action"]=="read_presentation" && document.is_none() {refuse!(BadRequest,"read_presentation needs document id");}
    let (chunk_index,chunk_start)=super::presentation_chunks::index(req)?;
    let limit=req["limit"].as_i64().unwrap_or(50).clamp(1,100);
    let offset=req["offset"].as_i64().unwrap_or(0).max(0);
    let rows=tx.query("SELECT d.uid,d.node_name,d.title,d.at,d.format,d.bytes,
        CASE WHEN $4::text IS NULL THEN NULL ELSE substring(coalesce(d.body,''),$7::integer,$8::integer) END,
        CASE WHEN $4::text IS NULL THEN NULL ELSE char_length(coalesce(d.body,'')) END,d.xmin::text
        FROM ot.documents d WHERE d.org_id=$1 AND (d.agent_id=ANY($2) OR (d.agent_id IS NULL AND d.node_name=$3))
        AND ($4::text IS NULL OR d.uid=$4) ORDER BY d.id DESC OFFSET $5 LIMIT $6",
        &[&org.id,&members,&n.name,&document,&offset,&limit,&chunk_start,&super::presentation_chunks::CHARS]).await?;
    if document.is_some() && rows.is_empty() {refuse!(NotFound,"presentation is not in the requested project gallery");}
    let docs:Vec<Value>=rows.iter().map(|r|->Result<Value>{
        let mut d=json!({"id":r.get::<_,String>(0),"node":r.get::<_,String>(1),"title":r.get::<_,String>(2),"at":crate::util::iso(r.get(3)),"format":r.get::<_,String>(4),"bytes":r.get::<_,i32>(5)});
        if let Some(body)=r.get::<_,Option<String>>(6) {
            let revision:String=r.get(8);
            super::presentation_chunks::revision(req,chunk_index,&revision)?;
            d["body_revision"]=json!(revision);
            let mut part=super::presentation_chunks::body(body,r.get::<_,Option<i32>>(7).unwrap_or(0),chunk_index)?;
            d.as_object_mut().unwrap().append(part.as_object_mut().unwrap());
        }
        Ok(d)
    }).collect::<Result<_>>()?;
    Ok(json!({"project":n.name,"documents":docs,"offset":offset,"next_offset":if rows.len()==limit as usize {Some(offset+limit)} else {None}}))
}

/// Set a project's slot count (domain/slots.rs; user 2026-10-18 08:42Z: a
/// count, 0 is none). Whoever controls the project may. Lowering it takes no
/// slot from a holder; the new count applies as slots free up. Free slots
/// go to the line after commit.
#[logged]
async fn set_slots(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has concurrency slots", n.name);
    }
    authorize_project_policy(tx, actor, &n, "set its concurrency slots").await?;
    let Some(count) = req.get("capacity").and_then(Value::as_i64).filter(|c| (0..=crate::domain::slots::MAX_CAPACITY).contains(c)) else {
        refuse!(BadRequest, "capacity is the number of concurrency slots, 0 (none) to {}", crate::domain::slots::MAX_CAPACITY);
    };
    tx.execute("UPDATE ot.agents SET scope = jsonb_set(coalesce(scope, '{}'::jsonb), '{slots_capacity}', to_jsonb($2::bigint)),
                       row_version = row_version + 1 WHERE id = $1", &[&n.id, &count]).await?;
    event(tx, org.id, "set_slots", actor, Some(n.id), json!({ "node": n.name, "capacity": count }), fx).await?;
    fx.agents.insert(n.id);
    fx.slot_grants.push(n.id);
    Ok(json!({ "node": n.name, "slots": count }))
}

/// Release a held slot (`orgtree_project action=release_slot`). Its holder
/// releases; the project's superior (an agent above it) or the user may
/// force-release any. The next in line is granted after commit.
#[logged]
async fn slot_release(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let lease = str_arg(req, "lease").unwrap_or("").trim().trim_start_matches('#').to_string();
    let Some(l) = tx
        .query_opt(
            "SELECT l.id, l.project_id, l.holder_agent_id, l.slot_no, l.ended_at IS NOT NULL, coalesce(l.end_reason, ''), a.name, p.name
               FROM ot.slot_leases l JOIN ot.agents a ON a.id = l.holder_agent_id JOIN ot.agents p ON p.id = l.project_id
              WHERE l.org_id = $1 AND l.uid = $2",
            &[&org.id, &lease],
        )
        .await?
    else {
        refuse!(NotFound, "no concurrency slot lease {lease}; orgtree_project action=slots name=<project> lists the leases");
    };
    let (id, project, holder, slot, ended, how, holder_name, pname): (i64, i64, i64, i32, bool, String, String, String) =
        (l.get(0), l.get(1), l.get(2), l.get(3), l.get(4), l.get(5), l.get(6), l.get(7));
    if ended {
        refuse!(Conflict, "lease {lease} has already ended ({how})");
    }
    let force = req.get("force").and_then(Value::as_bool).unwrap_or(false);
    let how = match actor {
        Actor::Agent { id: me, .. } if *me == holder => "released".to_string(),
        Actor::Agent { id: me, .. } if force && within(tx, *me, project).await? => format!("released (forced by {})", actor.label()),
        Actor::Agent { .. } => refuse!(Forbidden, "lease {lease} is {holder_name}'s; its holder releases it, or any project ancestor uses force=true. If orgtree_project is absent from your CLI, start a fresh CLI to load current tools before claiming another concurrency slot"),
        _ => format!("released (forced by {})", actor.label()),
    };
    // the project's row first, as the grant takes it
    tx.query_one("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&project]).await?;
    crate::domain::slots::end(tx, id, &how, &actor.label()).await?;
    event(tx, org.id, "slot_release", actor, Some(holder),
        json!({ "project": pname, "lease": lease, "slot": slot, "how": how, "note": str_arg(req, "note") }), fx).await?;
    fx.agents.insert(holder);
    fx.agents.insert(project);
    fx.slot_grants.push(project);
    Ok(json!({ "project": pname, "lease": lease, "released": true, "how": how,
               "next": "the concurrency slot goes to the next in line, if any" }))
}

/// A project's slots: holders, the line, recent history (`orgtree_project
/// action=slots`). Agents above or below the project may look.
#[logged]
async fn slot_status(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has concurrency slots", n.name);
    }
    if let Actor::Agent { id, .. } = actor {
        if !crate::domain::projects::reaches(tx, *id, n.id).await? {
            refuse!(Forbidden, "only the agents above or below project {} see its concurrency slots", n.name);
        }
    }
    if str_arg(req, "op") == Some("slot_history") {
        return crate::domain::slot_history::page(tx, n.id, str_arg(req, "history_before")).await;
    }
    let scope: Value = tx.query_one("SELECT scope FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
    crate::domain::slots::status(tx, n.id, &n.name, &scope).await
}

/// Fire a project's event to its armed listeners (`orgtree_project
/// action=fire_event`; the desk's Listeners tab fire button). Agents
/// above or below the project, or the user. Delivery runs after commit
/// (`listeners::fire`); the result reports who is listening now.
#[logged]
async fn fire_project_event(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project carries an event", n.name);
    }
    if n.state != "live" {
        refuse!(Conflict, "project {} is retired; its event cannot be fired", n.name);
    }
    if let Actor::Agent { id, .. } = actor {
        if !crate::domain::projects::reaches(tx, *id, n.id).await? {
            refuse!(Forbidden, "only the agents above or below project {} fire its event", n.name);
        }
    }
    let message = str_arg(req, "body").map(str::to_string);
    if message.as_deref().map(|m| m.chars().count()).unwrap_or(0) > crate::domain::listeners::MAX_MESSAGE {
        refuse!(BadRequest, "a project event message is at most {} characters", crate::domain::listeners::MAX_MESSAGE);
    }
    let armed = crate::domain::listeners::armed_count(tx, org.id, n.id).await?;
    fx.agents.insert(n.id);
    fx.project_fires.push((n.id, actor.label(), message));
    Ok(json!({ "project": n.name, "listeners_armed": armed }))
}

/// A project's event listeners and listener watches (`orgtree_project
/// action=listeners`). Agents above or below the project may look.
#[logged]
async fn project_listeners(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has event listeners", n.name);
    }
    if let Actor::Agent { id, .. } = actor {
        if !crate::domain::projects::reaches(tx, *id, n.id).await? {
            refuse!(Forbidden, "only the agents above or below project {} see its listeners", n.name);
        }
    }
    crate::domain::listeners::status(tx, org.id, n.id, &n.name).await
}

/// Remove an agent from a project's slot line (the project's superior or the
/// user): its claim is removed, so it is not granted.
#[logged]
async fn slot_unqueue(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has concurrency slots", n.name);
    }
    if let Actor::Agent { id, .. } = actor {
        if !within(tx, *id, n.id).await? {
            refuse!(Forbidden, "only an agent above the project (any ancestor), or the user, removes an agent from its concurrency slot line");
        }
    }
    let who = str_arg(req, "agent").unwrap_or("");
    let rows = tx
        .query(
            "UPDATE ot.watchdogs w SET state = 'removed', memo = memo || jsonb_build_object('reason', $3::text)
               FROM ot.agents a WHERE a.id = w.owner_agent_id AND a.name = $2 AND w.org_id = $4 AND w.kind = 'slot'
                AND w.state IN ('armed', 'paused') AND (w.memo->>'target_id')::bigint = $1 AND NOT w.memo ? 'lease'
             RETURNING w.id, a.id",
            &[&n.id, &who, &format!("removed from the line by {}", actor.label()), &org.id],
        )
        .await?;
    if rows.is_empty() {
        refuse!(NotFound, "{who} is not in project {}'s concurrency slot line", n.name);
    }
    for r in &rows {
        fx.dogs_off.push(r.get(0));
        fx.agents.insert(r.get(1));
    }
    event(tx, org.id, "slot_unqueue", actor, Some(n.id), json!({ "node": n.name, "agent": who }), fx).await?;
    Ok(json!({ "node": n.name, "removed": who }))
}

/// Purge a project's waiting mail (user 2026-10-18 08:11Z): every mail no
/// watcher holds yet is retracted; handed, acked and dead-letter mail stay.
#[logged]
async fn purge_mail_queue(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project's mail queue can be purged", n.name);
    }
    authorize_project_policy(tx, actor, &n, "purge its mail queue").await?;
    tx.query_one("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&n.id]).await?;
    let purged = crate::domain::projects::purge_waiting(tx, n.id, &actor.label()).await?;
    event(tx, org.id, "purge_mail_queue", actor, Some(n.id), json!({ "node": n.name, "purged": purged }), fx).await?;
    fx.mailboxes.push(n.id);
    Ok(json!({ "node": n.name, "purged": purged }))
}

/// The project a dead-letter op addresses, for an actor with its reach: the
/// user, or an agent above or below it (the mail queue's reach rule).
#[logged]
async fn dead_letter_project(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, verb: &str) -> Result<Node> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if !n.project() {
        refuse!(BadRequest, "{} is an agent: only a project has dead letters", n.name);
    }
    if let Actor::Agent { id, .. } = actor {
        if !crate::domain::projects::reaches(tx, *id, n.id).await? {
            refuse!(Forbidden, "only the agents above or below project {} {verb} its dead letters", n.name);
        }
    }
    Ok(n)
}

/// List a project's dead letters, or (with `id`) read one in full (docket
/// project-dead-letter-queue-failed-ack-queue-jobs-a; user 2026-10-18 19:38Z).
#[logged]
async fn dead_letters(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value) -> Result<Value> {
    let n = dead_letter_project(org, tx, actor, req, "see").await?;
    if let Some(id) = str_arg(req, "id") {
        return crate::domain::dead_letters::read(tx, n.id, &n.name, id).await;
    }
    let limit = req.get("limit").and_then(Value::as_i64).unwrap_or(50).clamp(1, 100);
    let offset = req.get("offset").and_then(Value::as_i64).unwrap_or(0).max(0);
    let dropped = req.get("include_dropped").and_then(Value::as_bool).unwrap_or(false);
    crate::domain::dead_letters::list(tx, n.id, &n.name, limit, offset, dropped).await
}

/// Retry a dead letter: back in the queue with its attempts reset, handed out
/// after commit.
#[logged]
async fn dead_letter_retry(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = dead_letter_project(org, tx, actor, req, "retry").await?;
    let Some(id) = str_arg(req, "id") else { refuse!(BadRequest, "retry_dead_letter needs id: the dead letter's mail id (dead_letters lists them)") };
    tx.query_one("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&n.id]).await?;
    crate::domain::dead_letters::retry(tx, n.id, &n.name, id, &actor.label()).await?;
    event(tx, org.id, "dead_letter_retry", actor, Some(n.id), json!({ "node": n.name, "mail": id }), fx).await?;
    fx.mailboxes.push(n.id);
    fx.agents.insert(n.id);
    fx.queue_runs.push(n.id);
    Ok(json!({ "node": n.name, "retried": id, "note": "back in the queue with its attempts reset; it is handed out as soon as a listener can take it" }))
}

/// Drop a dead letter with a reason: out of the open list and count, still readable.
#[logged]
async fn dead_letter_drop(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = dead_letter_project(org, tx, actor, req, "drop").await?;
    let Some(id) = str_arg(req, "id") else { refuse!(BadRequest, "drop_dead_letter needs id: the dead letter's mail id (dead_letters lists them)") };
    let Some(reason) = str_arg(req, "reason") else { refuse!(BadRequest, "drop_dead_letter needs a reason: why is this job being dropped?") };
    tx.query_one("SELECT 1 FROM ot.agents WHERE id = $1 FOR NO KEY UPDATE", &[&n.id]).await?;
    crate::domain::dead_letters::drop_letter(tx, n.id, &n.name, id, &actor.label(), reason).await?;
    event(tx, org.id, "dead_letter_drop", actor, Some(n.id), json!({ "node": n.name, "mail": id, "reason": reason }), fx).await?;
    fx.mailboxes.push(n.id);
    fx.agents.insert(n.id);
    Ok(json!({ "node": n.name, "dropped": id, "reason": reason }))
}

#[logged]
async fn reallocate(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.project() {
        refuse!(BadRequest, "{} is a project: projects hold no credits (the agent above a project pays for the agents under it)", n.name);
    }
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
        if agent_superior(tx,n.id).await?.is_none() && n.grant+delta > caps.max_top+1e-9 {
            refuse!(Conflict, "a top-level grant of {:.0} is over this organization's cap of {:.0}", n.grant+delta,caps.max_top);
        }
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
    agent_only(&n, "switch models")?;
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
        refuse!(Conflict, "{}", catalog::turned_off(to));
    }
    validate_account(engine, &org.slug, &tier, str_arg(req, "account"))?;
    // A language server's harness is fixed per server, so a move to a model
    // on a server with the other harness (Claude Code <-> Codex) is a crossing
    // too: neither CLI can resume the other's session (coordinator ruling
    // 2026-10-10). Between servers on one harness the session carries on: the
    // lane keeps one config folder per harness.
    let harnesses = if from == catalog::LANGSERVER && to == catalog::LANGSERVER {
        let now = langserver_harness(engine, tx, n.id, &n.tier).await?;
        let next = crate::langserver::route_of(engine, &tier).and_then(|(s, _)| s["harness"].as_str().map(str::to_string));
        match (now, next) {
            (Some(a), Some(b)) if a != b => Some((a, b)),
            _ => None,
        }
    } else {
        None
    };
    let crossing = from != to || harnesses.is_some();
    // the login the seat runs on after the switch: the one named, else (same
    // provider) the one it is on, else the new provider's own login
    let lands = match crate::accounts::choice(str_arg(req, "account")) {
        crate::accounts::Choice::Account(a) => Some(a),
        crate::accounts::Choice::Primary => None,
        crate::accounts::Choice::Unset => if from == to { n.account.clone() } else { None },
    };
    muse_admit(engine, &tier, pinned(&n.scope), lands.as_deref())?;
    if busy(tx, n.id).await? {
        let replaced = queue_config(tx, &n, actor, json!({ "tier": tier, "from": n.tier, "crossing": crossing, "account": req["account"] }), true).await?;
        event(tx, org.id, "switch_queued", actor, Some(n.id), json!({ "node": n.name, "old": n.tier, "new": tier, "by": actor.label() }), fx).await?;
        fx.agents.insert(n.id);
        fx.queued.push(n.id);
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
    if crossing {
        // a new provider (or harness) starts a fresh session; the old transcript stays in the folder
        // the next turn starts with a summary of the conversation (the CLIs
        // cannot resume each other's sessions)
        let (was, now) = match &harnesses {
            Some((a, b)) => (harness_label(a), harness_label(b)),
            None => (catalog::provider_label(from), catalog::provider_label(to)),
        };
        let why = format!("moved from {was} to {now}");
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
        if crate::domain::asks::moot_for_fresh_session(tx, n.id, "the asking session was replaced by a provider switch; the fresh session never posed it").await? {
            fx.pulses.extend([crate::changes::Change::Asks, crate::changes::Change::Docket]);
        }
        stamp_harness(engine, tx, n.id, &tier, true).await?;
        warnings.push(format!(
            "{} moved from {was} to {now}: it continues on a fresh session that starts with a summary of its conversation (the whole conversation is saved in its folder)",
            n.name
        ));
    } else {
        tx.execute(
            "UPDATE ot.agents SET tier = $2, seat = $3::float8::numeric,
                    account = CASE WHEN $5 THEN NULL ELSE coalesce($4, account) END, row_version = row_version + 1 WHERE id = $1",
            &[&n.id, &tier, &seat, &account, &clear],
        )
        .await?;
    }
    if catalog::antigravity_claude(&tier) {
        tx.execute("UPDATE ot.agents SET context_window = NULL, scope = scope - 'model_version' WHERE id = $1", &[&n.id]).await?;
    }
    tx.execute("UPDATE ot.agents SET pending_switch = NULL WHERE id = $1", &[&n.id]).await?;
    event(tx, org.id, "switch_model", actor, Some(n.id), json!({ "node": n.name, "from": n.tier, "to": tier, "seat_old": n.seat, "old_session": n.session, "cascaded": raised }), fx).await?;
    fx.agents.insert(n.id);
    if let Some(p) = n.parent {
        fx.agents.insert(p);
    }
    fx.reconfigure.push(n.id);
    fx.events = true;
    Ok(json!({ "node": n.name, "previous_tier": n.tier, "tier": tier, "cascaded": raised, "warnings": warnings }))
}

/// Bring this org's live agents on language-server models to their
/// server's seat price (a price set in App settings, or the move from the
/// old flat 0.10 to the default 1). The price is the server's own: the op
/// takes none from the request. A rise makes room the way a model switch
/// does (the org's credit cascade, refused when there is none); a fall
/// frees the difference.
#[logged]
async fn reprice(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, fx: &mut Effects) -> Result<Value> {
    let prefix = format!("{}%", crate::langserver::TIER_PREFIX);
    let rows = tx
        .query(
            "SELECT id, name, parent_id, seat::float8, tier FROM ot.agents
              WHERE org_id = $1 AND state = 'live' AND tier LIKE $2 ORDER BY id FOR UPDATE",
            &[&org.id, &prefix],
        )
        .await?;
    let mut repriced = Vec::new();
    let mut caps_now: Option<OrgCaps> = None;
    for r in rows {
        let (id, name, parent, old, tier): (i64, String, Option<i64>, f64, String) = (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
        let Some(seat) = crate::langserver::seat_of_tier(engine, &tier) else { continue };
        if (seat - old).abs() < 1e-9 {
            continue;
        }
        let raised = if seat > old {
            if caps_now.is_none() {
                caps_now = Some(caps(engine, tx, org.id).await?);
            }
            let c = caps_now.as_ref().expect("caps loaded above");
            ensure_room(tx, actor, parent, seat - old, c.cascade_alloc, c.max_top, fx).await?
        } else {
            Vec::new()
        };
        tx.execute("UPDATE ot.agents SET seat = $2::float8::numeric, row_version = row_version + 1 WHERE id = $1", &[&id, &seat]).await?;
        event(tx, org.id, "reprice", actor, Some(id), json!({ "node": name, "tier": tier, "seat_old": old, "seat": seat, "cascaded": raised }), fx).await?;
        fx.agents.insert(id);
        if let Some(p) = parent {
            fx.agents.insert(p);
        }
        repriced.push(json!({ "node": name, "from": old, "to": seat }));
    }
    if !repriced.is_empty() {
        fx.events = true;
    }
    Ok(json!({ "repriced": repriced }))
}

#[logged]
async fn reorder(org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    if n.project() { authorize_project_policy(tx, actor, &n, "reorder it").await?; }
    else { authorize(tx, actor, &n, "reorder").await?; }
    if n.state != "live" { refuse!(Conflict, "reorder needs a live target"); }
    for field in ["parent", "new_parent", "target", "above"] {
        if req.get(field).is_some() { refuse!(BadRequest, "reorder changes only sibling position; omit {field}"); }
    }
    let mut list = ordering::siblings(tx, org.id, n.parent, Some(n.id)).await?;
    let pos = ordering::position(req, &list, matches!(actor, Actor::Agent { .. }))?;
    let (order, changed) = ordering::place(tx, &mut list, pos).await?;
    fx.agents.extend(changed);
    tx.execute("UPDATE ot.agents SET sibling_order = $2, row_version = row_version + 1 WHERE id = $1", &[&n.id, &order]).await?;
    fx.agents.insert(n.id);
    Ok(json!({ "node": n.name, "index": pos, "live_sibling_count": list.len() + 1, "sibling_order": order }))
}

#[logged]
async fn account(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    agent_only(&n, "change accounts")?;
    authorize(tx, actor, &n, "change the account of").await?;
    let pending: Option<Value> = tx.query_one("SELECT pending_switch FROM ot.agents WHERE id = $1", &[&n.id]).await?.get(0);
    let target_tier = pending.as_ref().and_then(|p| p["tier"].as_str()).unwrap_or(&n.tier);
    validate_account(engine, &org.slug, target_tier, str_arg(req, "account"))?;
    let acc = match crate::accounts::choice(str_arg(req, "account")) {
        crate::accounts::Choice::Account(a) => Some(a),
        _ => None,
    };
    muse_admit(engine, target_tier, pinned(&n.scope), acc.as_deref())?;
    if busy(tx, n.id).await? {
        if acc == n.account {
            tx.execute("UPDATE ot.agents SET pending_account = NULL, row_version = row_version + 1 WHERE id = $1", &[&n.id]).await?;
            event(tx, org.id, "account_queue_cancelled", actor, Some(n.id), json!({ "node": n.name, "account": acc }), fx).await?;
            fx.agents.insert(n.id); fx.events = true;
            return Ok(json!({ "node": n.name, "queued": false, "cancelled": true }));
        }
        let replaced = queue_config(tx, &n, actor, json!({ "account": acc.clone().unwrap_or_else(|| "primary".into()), "from": n.account.clone().unwrap_or_else(|| "primary".into()) }), false).await?;
        event(tx, org.id, "account_queued", actor, Some(n.id), json!({ "node": n.name, "account": acc, "by": actor.label() }), fx).await?;
        fx.agents.insert(n.id); fx.queued.push(n.id); fx.events = true;
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
    agent_only(&n, "be compacted")?;
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

#[cfg(test)]
mod project_settings_tests {
    use super::*;
    #[test]
    fn ack_reminder_default_control() {
        assert_eq!(super::super::projects::ACK_WAKES, 3);
    }
    #[test]
    fn ack_reminder_count_controls_mail_and_slot_thresholds() {
        use super::super::projects::{ack_reminders, ack_reminders_exhausted};
        let default=json!({});assert_eq!(ack_reminders(&default),3);
        assert!(!ack_reminders_exhausted(&default,2));assert!(ack_reminders_exhausted(&default,3));
        for n in [1,5,10] {
            let scope=json!({"mail_queue_ack_reminders":n});
            assert_eq!(ack_reminders(&scope),n);
            assert!(!ack_reminders_exhausted(&scope,n-1));assert!(ack_reminders_exhausted(&scope,n));
        }
        assert!(!ack_reminders_exhausted(&json!({"mail_queue_ack_timeout":false,"mail_queue_ack_reminders":1}),10));
        for invalid in [json!(0),json!(11),json!(1.5),json!("3"),json!(null)] {
            assert_eq!(ack_reminders(&json!({"mail_queue_ack_reminders":invalid})),3);
        }
    }
    #[test]
    fn ack_reminder_patch_accepts_counts_and_rejects_invalid_values() {
        for n in [1,3,10] {
            assert_eq!(project_setting_ops("alpha",&json!({"ack_reminders":n})).unwrap(),
                vec![json!({"op":"set_mail_queue","node":"alpha","ack_reminders":n})]);
        }
        for n in [json!(0),json!(11),json!(1.5),json!("3"),json!(null)] {
            assert!(project_setting_ops("alpha",&json!({"ack_reminders":n})).is_err());
        }
    }
    #[test]
    fn full_patch_preserves_false_zero_and_renames_last() {
        let ops=project_setting_ops("alpha",&json!({"name":"beta","description":"","peer_mail":false,
            "mail_queue":"ack","exclude_sender":false,"ack_timeout":false,"max_attempts":100,"slots":0})).unwrap();
        assert_eq!(ops.len(),5);
        assert_eq!(ops.last().unwrap(),&json!({"op":"rename","node":"alpha","name":"beta"}));
        assert_eq!(ops[1]["ack_timeout"],false);
        assert_eq!(ops[1]["exclude_sender"],false);
        assert_eq!(ops[2]["capacity"],0);
        assert_eq!(ops[3]["peer_mail"],false);
    }
    #[test]
    fn partial_patch_never_resets_untouched_values() {
        assert_eq!(project_setting_ops("alpha",&json!({"slots":1})).unwrap(),vec![json!({"op":"set_slots","node":"alpha","capacity":1})]);
        assert_eq!(project_setting_ops("alpha",&json!({"description":""})).unwrap(),vec![json!({"op":"set_description","node":"alpha","description":""})]);
    }
    #[test]
    fn invalid_patch_fails_before_any_canonical_write() {
        for bad in [json!(null),json!([]),json!({}),json!({"account":"secret"}),json!({"peer_mail":"false"}),
            json!({"slots":-1}),json!({"slots":65}),json!({"slots":1.5}),json!({"max_attempts":0}),json!({"max_attempts":101}),
            json!({"mail_queue":"fifo"}),json!({"name":"bad/name"}),json!({"description":null})] {
            assert!(project_setting_ops("alpha",&bad).is_err(),"accepted invalid patch {bad}");
        }
    }
}

/// Two agents exchange seats: each seat keeps its superior, reports, grant,
/// team charter and scope; each agent keeps its identity, session, charter,
/// tier and mailbox. Only the tier's seat price moves with the agent.
#[logged]
async fn swap(_engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let a = node_by_name(tx, org.id, str_arg(req, "a").unwrap_or("")).await?;
    let b = node_by_name(tx, org.id, str_arg(req, "b").unwrap_or("")).await?;
    agent_only(&a, "swap seats")?;
    agent_only(&b, "swap seats")?;
    if a.id == b.id {
        refuse!(BadRequest, "an agent cannot swap with itself");
    }
    if a.state != "live" || b.state != "live" {
        refuse!(Conflict, "both agents must be live");
    }
    authorize(tx, actor, &a, "swap").await?;
    authorize(tx, actor, &b, "swap").await?;
    let a_superior=agent_superior(tx,a.id).await?;
    let b_superior=agent_superior(tx,b.id).await?;
    if matches!(actor, Actor::Agent { .. }) && (a_superior.is_none() || b_superior.is_none()) {
        refuse!(Forbidden, "only the user reseats the top level");
    }
    // As in 3.x, grants ride the seats: a same-tier exchange, or one between
    // siblings, is budget-neutral at every agent, and a cross-tier exchange
    // surfaces exactly the seat-price difference at the boundary payers. It
    // must fit their free credits, or the swap is refused before anything
    // changes ("reallocate first"); nobody's grant is raised for it.
    let raised: Vec<String> = Vec::new();
    let siblings = a_superior==b_superior;
    if (a.seat - b.seat).abs() > 1e-9 && !siblings {
        // the commander of a nested pair first
        let (top, low) = if within(tx, b.id, a.id).await? { (&b, &a) } else { (&a, &b) };
        let top_superior=if top.id==a.id {a_superior} else {b_superior};
        let low_superior=if low.id==a.id {a_superior} else {b_superior};
        let direct = low_superior == Some(top.id);
        let free = |n: &Node| {
            let (id, grant) = (n.id, n.grant);
            async move { Ok::<f64, anyhow::Error>(grant - hold(tx, id).await?) }
        };
        let short = |payer: &str, have: f64, need: f64| {
            format!("seating it costs {need} more than {payer}'s free ({have}) — reallocate first (§4.6)")
        };
        if let Some(pid) = top_superior {
            let p = node_by_id(tx, pid).await?;
            let have = free(&p).await?;
            if have + top.seat - low.seat < -1e-9 {
                refuse!(Conflict, "\"{}\" ({}, seat {}) where \"{}\" ({}, seat {}) sat: {}", low.name, low.tier, low.seat,
                    top.name, top.tier, top.seat, short(&p.name, have, low.seat - top.seat));
            }
        }
        if direct {
            let have = free(top).await?;
            if have + low.seat - top.seat < -1e-9 {
                refuse!(Conflict, "\"{}\" would fund \"{}\"'s seat ({}) out of the exchanged grant with free {} — the seat-cost difference does not fit; reallocate first (§4.6)",
                    low.name, top.name, top.seat, have + low.seat - top.seat);
            }
        } else if let Some(pid) = low_superior {
            let p = node_by_id(tx, pid).await?;
            let have = free(&p).await?;
            if have + low.seat - top.seat < -1e-9 {
                refuse!(Conflict, "\"{}\" ({}, seat {}) where \"{}\" ({}, seat {}) sat: {}", top.name, top.tier, top.seat,
                    low.name, low.tier, low.seat, short(&p.name, have, top.seat - low.seat));
            }
        }
    }
    let a_parent = if b.parent == Some(a.id) { Some(b.id) } else { b.parent };
    let b_parent = if a.parent == Some(b.id) { Some(a.id) } else { a.parent };
    // Snapshot before projects move with their seats. Resolving an old raw
    // project parent afterwards can name the OTHER agent as former superior.
    let old_superior_a = a_superior;
    let old_superior_b = b_superior;
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
    event(tx, org.id, "swap", actor, Some(a.id), json!({ "a": a.name, "b": b.name, "old_parent_a": a.parent, "old_parent_b": b.parent,
        "old_superior_a":old_superior_a,"old_superior_b":old_superior_b,"cascaded": raised }), fx).await?;
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
    agent_only(&d, "take your seat")?;
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
    let old_superior: Option<i64> = tx.query_one("SELECT ot.superior_of($1)", &[&d.id]).await?.get(0);
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
    event(tx, org.id, "self_subjugate", actor, Some(me.id), json!({ "node": me.name, "promoted": d.name, "old_parent_id": old_parent,
        "old_superior_id":old_superior,"cascaded": raised }), fx).await?;
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

/// What a retool's `add_dirs` does to the agent's folder list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dirs {
    /// add the folders, a held one taking the new mode (the agent tool and
    /// the ops route; user ruling 2026-10-10, 3.x replaced)
    Add,
    /// set the whole list, as a hire does (a rehire, as in 3.x)
    Replace,
}

/// Re-scope a node below the caller (folders, tools, visibility, permission
/// mode, effort, charter, team charter, account); on itself only the team
/// charter. Grants are checked against the caller and raised through intermediates.
/// `remove_dirs` removes folders the agent holds; removing or narrowing one
/// clamps everything beneath, and the result lists every folder change.
#[allow(clippy::too_many_arguments)]
#[logged]
async fn retool(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>, actor: &Actor, req: &Value, fx: &mut Effects, preauthorized: bool, dirs_mode: Dirs) -> Result<Value> {
    super::tool_groups::validate(&req["tools"])?;
    let n = node_by_name(tx, org.id, str_arg(req, "node").unwrap_or("")).await?;
    agent_only(&n, "be re-scoped")?;
    let own = matches!(actor, Actor::Agent { id, .. } if *id == n.id);
    if own {
        let fields: Vec<&str> = req.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
        if fields.iter().any(|k| !["op", "node", "team_charter"].contains(k)) {
            refuse!(Forbidden, "on yourself only team_charter can change; ask your superior for the rest");
        }
    } else if !preauthorized {
        authorize(tx, actor, &n, "retool").await?;
    }
    let fast = req.get("fast_mode").map(|value| crate::providers::fast_mode::validate(
        &engine.providers.state.load(), &n.tier, pinned(&n.scope), value)).transpose()?;
    // Speed is node-local and read at the next turn. A speed-only tool call
    // must not restart the CLI or walk/reconfigure its descendants.
    if let Some(enabled) = fast.filter(|_| req.as_object().is_some_and(|o|
        o.keys().all(|k| matches!(k.as_str(), "op" | "node" | "fast_mode")))) {
        let mut next=n.scope.clone(); next["fast_mode"]=json!(enabled);
        tx.execute("UPDATE ot.agents SET scope=$2,row_version=row_version+1 WHERE id=$1", &[&n.id,&next]).await?;
        event(tx,org.id,"retool",actor,Some(n.id),json!({"node":n.name,"change":{"fast_mode":enabled}}),fx).await?;
        fx.agents.insert(n.id); fx.events=true;
        return Ok(json!({"node":n.name,"fast_mode":enabled,"applies":"next_turn","cascaded":[]}));
    }
    let mut sc = scope::normalize(&n.scope);
    if let Some(enabled) = fast { sc["fast_mode"]=json!(enabled); }
    let dirs_before = sc["add_dirs"].as_array().cloned().unwrap_or_default();
    let same = |d: &Value, path: &str| scope::norm_path(d["path"].as_str().unwrap_or("")) == scope::norm_path(path);
    // the folders this call names: they alone are granted, and checked against the caller
    let named = match req.get("add_dirs") {
        None | Some(Value::Null) => None,
        Some(d) if d.is_array() => Some(scope::normalize(&json!({ "add_dirs": d }))["add_dirs"].as_array().cloned().unwrap_or_default()),
        Some(_) => refuse!(BadRequest, "add_dirs is a list of {{path, mode}}"),
    };
    let removed = match req.get("remove_dirs") {
        None | Some(Value::Null) => None,
        Some(Value::Array(list)) => {
            let mut paths = Vec::new();
            for x in list {
                let Some(p) = x.as_str().or_else(|| x["path"].as_str()) else { refuse!(BadRequest, "remove_dirs is a list of folder paths") };
                paths.push(p.to_string());
            }
            Some(paths)
        }
        Some(_) => refuse!(BadRequest, "remove_dirs is a list of folder paths"),
    };
    let mut dirs = match (dirs_mode, &named) {
        (Dirs::Replace, Some(named)) => named.clone(),
        _ => dirs_before.clone(),
    };
    if let (Dirs::Add, Some(named)) = (dirs_mode, &named) {
        for d in named {
            match dirs.iter().position(|x| same(x, d["path"].as_str().unwrap_or(""))) {
                Some(i) => dirs[i]["mode"] = d["mode"].clone(),
                None => dirs.push(d.clone()),
            }
        }
    }
    for p in removed.iter().flatten() {
        if named.iter().flatten().any(|d| same(d, p.as_str())) {
            refuse!(BadRequest, "{p} is in both add_dirs and remove_dirs");
        }
        // a path it does not hold is refused, so a mistyped removal never passes as done
        if !dirs_before.iter().any(|d| same(d, p.as_str())) {
            let held: Vec<String> = dirs_before.iter()
                .map(|d| format!("{} ({})", d["path"].as_str().unwrap_or(""), d["mode"].as_str().unwrap_or("rw"))).collect();
            if held.is_empty() {
                refuse!(BadRequest, "{} holds no folder {p}; it holds no folders", n.name);
            }
            refuse!(BadRequest, "{} holds no folder {p}; its folders: {}", n.name, held.join(", "));
        }
        dirs.retain(|d| !same(d, p.as_str()));
    }
    let dirs_touched = named.is_some() || removed.is_some();
    let o = sc.as_object_mut().unwrap();
    if dirs_touched {
        o.insert("add_dirs".into(), Value::Array(dirs));
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
        } else {
            // the agent's own harness and model name its levels (user 2026-10-12):
            // for Muse, the exact model's row on the login it runs on once this
            // call lands, so an account named alongside is the one asked (it
            // moves below, now or at the turn boundary; independent review
            // 2026-10-13). With none named, the login its next turn runs on:
            // an account change already queued behind a running turn, as the
            // settings route judges it (independent review R3 2026-10-13).
            // Nothing is written before this check.
            let view = engine.accounts.view();
            let version = req.get("model_version").and_then(Value::as_str).filter(|s| !s.is_empty()).or(pinned(&n.scope));
            let login = match str_arg(req, "account") {
                None => {
                    let queued: Option<String> = tx.query_one("SELECT pending_account->>'account' FROM ot.agents WHERE id = $1", &[&n.id])
                        .await?.get(0);
                    crate::accounts::next_turn_login(n.account.as_deref(), queued.as_deref()).and_then(|id| view.get(&id))
                }
                Some(raw) => match crate::accounts::choice(Some(raw)) {
                    crate::accounts::Choice::Account(a) => match view.get(&a) {
                        Some(i) => Some(i),
                        None => refuse!(NotFound, "no account {a}"),
                    },
                    // `primary`, `default`, `<provider>/primary`: the provider's own login
                    _ => None,
                },
            };
            crate::providers::check_effort_on(engine, &n.tier, version, login, v)?;
            o.insert("effort".into(), json!(v));
        }
    }
    if req.get("clear_account_fallback").and_then(Value::as_bool).unwrap_or(false) {
        o.remove("account_fallback");
    } else if let Some(b) = req.get("account_fallback").and_then(Value::as_bool) {
        o.insert("account_fallback".into(), json!(b));
    }
    let mut granted = json!({});
    for k in ["tools", "org_visibility", "permission_mode"] {
        if req.get(k).is_some_and(|v| !v.is_null()) { granted[k] = sc[k].clone(); }
    }
    if let Some(named) = &named { granted["add_dirs"] = json!(named); }
    let settings = caps(engine, tx, org.id).await?.settings;
    if let Actor::Agent { id, .. } = actor {
        scope::require_grant(&granted, &capability(tx, *id, &settings).await?)?;
    }
    if req.get("effort").is_some_and(Value::is_string) {
        let level = |s: &Value| catalog::effective_effort(s, &settings);
        fx.effort = Some((n.id, level(&n.scope), level(&sc)));
    }
    // an effort change alone restarts nobody's process (the delivery after
    // commit settles the agent's own), as on the user's settings path
    let effort_only = req.as_object().is_some_and(|o| {
        o.iter().all(|(k, v)| ["op", "node", "effort", "fast_mode"].contains(&k.as_str()) || v.is_null())
    });
    let mut cascaded = Vec::new();
    // the folders each raised ancestor gained, and each descendant lost
    let mut raised_dirs = Vec::new();
    let mut clamped = Vec::new();
    if granted.as_object().is_some_and(|o| !o.is_empty()) {
        let ancestors = chain(tx, n.id).await?;
        let mut below_actor = matches!(actor, Actor::User);
        for a in ancestors.iter().filter(|a| a.id != n.id) {
            if matches!(actor, Actor::Agent { id, .. } if *id == a.id) { below_actor = true; continue; }
            if !below_actor || a.project() { continue; }
            let raised = scope::raise(&a.scope, &granted);
            if raised != scope::normalize(&a.scope) {
                tx.execute("UPDATE ot.agents SET scope=$2, row_version=row_version+1 WHERE id=$1", &[&a.id,&raised]).await?;
                cascaded.push(a.name.clone());
                let diff = scope::dirs_diff(scope::normalize(&a.scope)["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default(),
                    raised["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default());
                if scope::dirs_changed(&diff) {
                    raised_dirs.push(json!({ "node": a.name, "added": diff["added"], "changed": diff["changed"] }));
                }
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
            let stored: Value = tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR NO KEY UPDATE", &[&org.id]).await?.get(0);
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
    // a grant may narrow (a folder's mode, a tool) and a removal always does
    if granted.as_object().is_some_and(|o| !o.is_empty()) || removed.is_some() {
        let settings = caps(engine, tx, org.id).await?.settings;
        let mut effective = std::collections::HashMap::new();
        effective.insert(n.id, capability(tx,n.id,&settings).await?);
        for id in &below {
            let child = node_by_id(tx,*id).await?;
            let Some(parent) = child.parent.and_then(|id| effective.get(&id)) else { refuse!(Conflict,"scope subtree changed during retool"); };
            // A project stores policy, never an agent grant. Pass the cap
            // through by kind even if an old cascade damaged its marker.
            if child.project() {
                effective.insert(*id,parent.clone());
                continue;
            }
            let bounded = scope::clamp(&child.scope,parent);
            let stored = scope::normalize(&child.scope);
            if bounded != stored {
                tx.execute("UPDATE ot.agents SET scope=$2,row_version=row_version+1 WHERE id=$1", &[id,&bounded]).await?;
                let diff = scope::dirs_diff(stored["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default(),
                    bounded["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default());
                if scope::dirs_changed(&diff) {
                    clamped.push(json!({ "node": child.name, "removed": diff["removed"], "changed": diff["changed"] }));
                }
            }
            effective.insert(*id,bounded);
        }
    }
    fx.agents.extend(below.iter().copied());
    if !effort_only {
        fx.reconfigure.push(n.id);
        fx.reconfigure.extend(below);
    }
    fx.events = true;
    let mut out = account_result.unwrap_or_else(|| json!({}));
    out["cascaded"] = json!(cascaded);
    let mut warnings = Vec::new();
    if !cascaded.is_empty() { warnings.push(format!("cascaded permission increase to agents {}", cascaded.join(", "))); }
    if dirs_touched {
        out["folders"] = scope::dirs_diff(&dirs_before, sc["add_dirs"].as_array().map(Vec::as_slice).unwrap_or_default());
    }
    if !raised_dirs.is_empty() { out["raised"] = json!(raised_dirs); }
    if !clamped.is_empty() {
        let lost: Vec<String> = clamped.iter().map(|c| {
            let count = |k: &str| c[k].as_array().map_or(0, Vec::len);
            let what = match (count("removed"), count("changed")) {
                (r, 0) => format!("{r} removed"),
                (0, ch) => format!("{ch} made read-only"),
                (r, ch) => format!("{r} removed, {ch} made read-only"),
            };
            format!("{} ({what})", c["node"].as_str().unwrap_or(""))
        }).collect();
        warnings.push(format!("folders taken from agents beneath {}: {}", n.name, lost.join(", ")));
        out["clamped"] = json!(clamped);
    }
    if !warnings.is_empty() { out["warnings"] = json!(warnings); }
    out["node"] = json!(n.name);
    Ok(out)
}

/// What a turn boundary found for an agent's queued switch or account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Boundary {
    /// nothing is queued, or the seat is not live
    Nothing,
    /// the queued intent was applied, or dropped with its explanation
    Applied,
    /// a turn is on record (`busy`), so nothing was looked at: the caller
    /// that runs no turn knows that record is stale (decision 62)
    Busy,
}

/// Consume pending intents only after a turn has settled. An operation failure
/// rolls back to the savepoint; dropping the request and its explanation commit
/// together, leaving the former configuration intact.
#[logged]
pub(crate) async fn apply_pending(engine: &Arc<Engine>, org: &Arc<OrgHandle>, id: i64) -> Result<Boundary> {
    let mut client = engine.db.get().await?;
    let tx = client.transaction().await?;
    let n = node_by_id(&tx, id).await?;
    if n.state != "live" { return Ok(Boundary::Nothing); }
    if busy(&tx, id).await? { return Ok(Boundary::Busy); }
    let row = tx.query_one("SELECT pending_switch, pending_account FROM ot.agents WHERE id = $1", &[&id]).await?;
    let mut sw: Option<Value> = row.get(0);
    let ap: Option<Value> = row.get(1);
    if sw.is_none() && ap.is_none() { return Ok(Boundary::Nothing); }
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
    Ok(Boundary::Applied)
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
