//! The agents' `orgtree_*` tools: an MCP server living inside the engine,
//! reached over each CLI's own control channel (Claude Code `mcp_message`).
//! A call names no identity: the process it came from is the caller.

mod control;
mod defs;
mod mailtools;
mod orgview;
mod treetools;

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::domain::UserError;
use crate::engine::Engine;
use crate::runtime::{AgentMsg, Caller};


/// One JSON-RPC message from the CLI → the response it gets.
#[logged]
pub async fn handle_mcp(engine: &Arc<Engine>, caller: &Caller, msg: &Value) -> Value {
    let id = msg.get("id").cloned();
    let method = msg["method"].as_str().unwrap_or("");
    let Some(id) = id.filter(|i| !i.is_null()) else {
        // notifications (initialized, cancelled) need no answer
        return json!({ "jsonrpc": "2.0", "id": 0, "result": {} });
    };
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": msg.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "orgtree", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": defs::list() })),
        "tools/call" => Ok(call(engine, caller, &msg["params"]).await),
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        other => Err(json!({ "code": -32601, "message": format!("method not found: {other}") })),
    };
    match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    }
}

#[logged]
async fn call(engine: &Arc<Engine>, caller: &Caller, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let tool_use = params.pointer("/_meta/claudecode~1toolUseId").and_then(Value::as_str).map(str::to_string);
    let started = std::time::Instant::now();
    let out = dispatch(engine, caller, name, &args).await;
    let ms = started.elapsed().as_millis();
    if ms > 2000 {
        tracing::info!(agent = %caller.name, tool = name, ms, "slow tool call");
    }
    match out {
        Ok(Done { text, card }) => {
            if let (Some(card), Some(tid)) = (card, tool_use) {
                if let Some(h) = engine.agents.get(caller.agent_id) {
                    h.send(AgentMsg::ToolCard(tid, card));
                }
            }
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        Err(e) => {
            let text = match e.downcast_ref::<UserError>() {
                Some(u) => u.to_string(),
                None => {
                    tracing::warn!(agent = %caller.name, tool = name, error = %format!("{e:#}"), "tool failed");
                    format!("{name} failed inside the engine: {e:#}")
                }
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": true })
        }
    }
}

/// A tool's answer: text for the agent, and optionally a card for its chip.
#[derive(Debug, serde::Serialize)]
pub struct Done {
    pub text: String,
    pub card: Option<Value>,
}

#[logged]
impl Done {
    pub fn text(s: impl Into<String>) -> Result<Done> {
        Ok(Done { text: s.into(), card: None })
    }
    pub fn json(v: &Value) -> Result<Done> {
        Ok(Done { text: serde_json::to_string_pretty(v).unwrap_or_default(), card: None })
    }
}

#[logged]
async fn dispatch(engine: &Arc<Engine>, caller: &Caller, name: &str, args: &Value) -> Result<Done> {
    match name {
        "orgtree_message" => mailtools::message(engine, caller, args, false).await,
        "orgtree_send_notice" => mailtools::message(engine, caller, args, true).await,
        "orgtree_status" => mailtools::status(engine, caller, args).await,
        "orgtree_inbox" => mailtools::inbox(engine, caller, args).await,
        "orgtree_chart" => orgview::chart(engine, caller, args).await,
        "orgtree_state_inspect" => orgview::state_inspect(engine, caller, args).await,
        "orgtree_list_tiers" => orgview::list_tiers(engine).await,
        "orgtree_list_orgs" => orgview::list_orgs(engine, caller).await,
        "orgtree_read_transcript" => orgview::read_transcript(engine, caller, args).await,
        "orgtree_read_scratch" => orgview::read_scratch(engine, caller, args).await,
        "orgtree_interrupt" => control::interrupt(engine, caller, args).await,
        "orgtree_halt" => control::halt(engine, caller, args, true).await,
        "orgtree_unhalt" => control::halt(engine, caller, args, false).await,
        "orgtree_unstick" => control::unstick(engine, caller, args).await,
        "orgtree_continue_on" => control::continue_on(engine, caller, args).await,
        "orgtree_account_mark" => control::account_mark(engine, caller, args).await,
        "orgtree_ask" | "orgtree_request_credits" | "orgtree_request_scope" | "orgtree_withdraw_ask" => {
            ask_tool(engine, caller, name, args).await
        }
        "orgtree_present" | "orgtree_send_file" => doc_tool(engine, caller, name, args).await,
        "orgtree_watchdog" => dog_tool(engine, caller, args).await,
        "orgtree_work" => work_tool(engine, caller, args).await,
        "orgtree_staff" => {
            let Some(org) = engine.orgs.by_id(caller.org_id) else {
                crate::refuse!(NotFound, "organization not open");
            };
            let client = engine.db.get().await?;
            let m = me(&client, caller).await?;
            drop(client);
            Done::json(&crate::domain::staffing::staff(engine, &org, (m.id, m.name.as_str(), m.generation), args).await?)
        }
        "orgtree_audience" => audience_tool(engine, caller, args).await,
        "orgtree_hire" => treetools::run(engine, caller, args, "hire").await,
        "orgtree_rehire" => treetools::run(engine, caller, args, "rehire").await,
        "orgtree_retire" => treetools::run(engine, caller, args, "retire").await,
        "orgtree_dissolve" => treetools::run(engine, caller, args, "dissolve").await,
        "orgtree_move" => treetools::run(engine, caller, args, "move").await,
        "orgtree_rename" => treetools::run(engine, caller, args, "rename").await,
        "orgtree_reallocate" => treetools::run(engine, caller, args, "reallocate").await,
        "orgtree_switch_model" => treetools::run(engine, caller, args, "switch_model").await,
        "orgtree_cheap_compact" => treetools::run(engine, caller, args, "cheap_compact").await,
        "orgtree_retool" => treetools::run(engine, caller, args, "retool").await,
        "orgtree_swap" => treetools::run(engine, caller, args, "swap").await,
        "orgtree_self_subjugate" => treetools::run(engine, caller, args, "self_subjugate").await,
        other if other.starts_with("orgtree_") => {
            crate::refuse!(Unprocessable, "{other} is not available in this engine build yet")
        }
        other => crate::refuse!(NotFound, "unknown tool {other}"),
    }
}

// ------------------------------------------------------------ shared helpers

/// The caller's own row, read fresh.
#[derive(Debug, serde::Serialize)]
pub struct Me {
    pub id: i64,
    pub org_id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub generation: i32,
    pub visibility: String,
}

#[logged]
pub async fn me(client: &Client, caller: &Caller) -> Result<Me> {
    let r = client
        .query_one(
            "SELECT id, org_id, name, parent_id, generation, coalesce(scope->>'org_visibility', 'subtree')
               FROM ot.agents WHERE id = $1",
            &[&caller.agent_id],
        )
        .await?;
    Ok(Me { id: r.get(0), org_id: r.get(1), name: r.get(2), parent_id: r.get(3), generation: r.get(4), visibility: r.get(5) })
}

/// An agent of the caller's org by name (any state but deleted).
#[derive(Debug, serde::Serialize)]
pub struct Target {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub parent_id: Option<i64>,
}

#[logged]
pub async fn target(client: &Client, org_id: i64, name: &str) -> Result<Target> {
    let name = name.trim().trim_start_matches('@');
    let r = client
        .query_opt(
            "SELECT id, name, state, parent_id FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'",
            &[&org_id, &name],
        )
        .await?;
    match r {
        Some(r) => Ok(Target { id: r.get(0), name: r.get(1), state: r.get(2), parent_id: r.get(3) }),
        None => crate::refuse!(NotFound, "no agent named {name} in this organization"),
    }
}

/// Is `node` strictly below `ancestor`?
#[logged]
pub async fn is_descendant(client: &Client, ancestor: i64, node: i64) -> Result<bool> {
    let r = client
        .query_one(
            "WITH RECURSIVE up(id, parent_id, depth) AS (
               SELECT id, parent_id, 0 FROM ot.agents WHERE id = $2
               UNION ALL SELECT a.id, a.parent_id, up.depth + 1 FROM ot.agents a JOIN up ON a.id = up.parent_id
                WHERE up.depth < 1024)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = $1 AND depth > 0)",
            &[&ancestor, &node],
        )
        .await?;
    Ok(r.get(0))
}

/// Refuse unless `t` is strictly below the caller.
#[logged]
pub async fn downward(client: &Client, me: &Me, t: &Target, verb: &str) -> Result<()> {
    if t.id == me.id {
        crate::refuse!(Forbidden, "you cannot {verb} yourself");
    }
    if !is_descendant(client, me.id, t.id).await? {
        crate::refuse!(Forbidden, "you can only {verb} your reports and their reports; {} is not below you", t.name);
    }
    Ok(())
}

/// The agent ids the caller may see (`None` = everyone).
#[logged]
pub async fn visible(client: &Client, me: &Me) -> Result<Option<std::collections::HashSet<i64>>> {
    let mut set = std::collections::HashSet::new();
    set.insert(me.id);
    match me.visibility.as_str() {
        "full" => return Ok(None),
        "self" => return Ok(Some(set)),
        _ => {}
    }
    // team: superior, peers, reports
    let rows = client
        .query(
            "SELECT id FROM ot.agents WHERE org_id = $1 AND state <> 'deleted'
               AND (id = $2 OR parent_id = $3 OR parent_id IS NOT DISTINCT FROM $2)",
            &[&me.org_id, &me.parent_id, &me.id],
        )
        .await?;
    for r in rows {
        set.insert(r.get(0));
    }
    if me.parent_id.is_none() {
        // a top-level agent's peers are the other top-level agents
        let rows = client
            .query("SELECT id FROM ot.agents WHERE org_id = $1 AND parent_id IS NULL AND state <> 'deleted'", &[&me.org_id])
            .await?;
        for r in rows {
            set.insert(r.get(0));
        }
    }
    if me.visibility == "subtree" {
        let rows = client
            .query(
                "WITH RECURSIVE down(id, depth) AS (
                   SELECT id, 0 FROM ot.agents WHERE id = $1
                   UNION ALL SELECT a.id, d.depth + 1 FROM ot.agents a JOIN down d ON a.parent_id = d.id
                    WHERE d.depth < 1024 AND a.state <> 'deleted')
                 SELECT id FROM down",
                &[&me.id],
            )
            .await?;
        for r in rows {
            set.insert(r.get(0));
        }
    }
    Ok(Some(set))
}

#[logged]
pub fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

#[logged]
pub fn need_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    match arg_str(args, key) {
        Some(s) => Ok(s),
        None => crate::refuse!(BadRequest, "`{key}` is required"),
    }
}

/// orgtree_ask / request_credits / request_scope / withdraw_ask.
#[logged]
async fn ask_tool(engine: &Arc<Engine>, caller: &Caller, name: &str, args: &Value) -> Result<Done> {
    use crate::domain::asks;
    let Some(org) = engine.orgs.by_id(caller.org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let a = asks::asker(engine, caller.org_id, caller.agent_id).await?;
    let text = match name {
        "orgtree_ask" => asks::ask(engine, &org, &a, args).await?,
        "orgtree_request_credits" => {
            let Some(n) = args["new_limit"].as_f64() else {
                crate::refuse!(BadRequest, "new_limit is the requested new total grant");
            };
            asks::request_credits(engine, &org, &a, n, args["reason"].as_str().unwrap_or("")).await?
        }
        "orgtree_request_scope" => {
            let items = args["items"].as_array().cloned().unwrap_or_default();
            asks::request_scope(engine, &org, &a, &items, args["reason"].as_str().unwrap_or("")).await?
        }
        _ => asks::withdraw(engine, &org, a.id).await?,
    };
    Done::text(text)
}

/// orgtree_present / orgtree_send_file.
#[logged]
async fn doc_tool(engine: &Arc<Engine>, caller: &Caller, name: &str, args: &Value) -> Result<Done> {
    use crate::domain::docs;
    let Some(org) = engine.orgs.by_id(caller.org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let p = docs::presenter(engine, &org, caller.agent_id).await?;
    let (text, card) = if name == "orgtree_present" {
        docs::present(engine, &org, &p, args).await?
    } else {
        docs::send_file(engine, &org, &p, args).await?
    };
    Ok(Done { text, card: Some(card) })
}

/// orgtree_watchdog.
#[logged]
async fn dog_tool(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    use crate::runtime::watchdogs;
    let action = args["action"].as_str().unwrap_or("");
    let v = match action {
        "create" => watchdogs::create(engine, caller.org_id, caller.agent_id, args).await?,
        "list" => watchdogs::list(engine, caller.agent_id).await?,
        "pause" | "resume" | "remove" => {
            let Some(id) = args["id"].as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                crate::refuse!(BadRequest, "{action} needs the watchdog id (see list)");
            };
            watchdogs::act(engine, caller.org_id, Some(caller.agent_id), id, action, args["reason"].as_str()).await?
        }
        other => crate::refuse!(BadRequest, "action must be create, list, pause, resume or remove (not {other:?})"),
    };
    Done::json(&v)
}

/// orgtree_audience.
#[logged]
async fn audience_tool(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    use crate::domain::audiences;
    use crate::domain::ops::Actor;
    let Some(org) = engine.orgs.by_id(caller.org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let me = Actor::Agent { id: caller.agent_id, name: caller.name.clone() };
    let s = |k: &str| args[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    let reason = s("reason").unwrap_or("");
    let v = match args["action"].as_str().unwrap_or("") {
        "request" => {
            let Some(t) = s("target") else {
                crate::refuse!(BadRequest, "request needs a target: an agent, user, or extern");
            };
            audiences::request(engine, &org, (caller.agent_id, caller.name.as_str()), t, reason).await?
        }
        "grant" => {
            let target = s("target");
            let grantee = match s("from").or(s("grantee")) {
                Some(g) => g,
                None if target.map(|t| audiences::party(Some(t)) == audiences::EXTERN).unwrap_or(false) => caller.name.as_str(),
                None => crate::refuse!(BadRequest, "grant needs from: the agent that receives the audience"),
            };
            audiences::grant(engine, &org, &me, grantee, target, reason).await?
        }
        "deny" => {
            let Some(r) = s("from") else {
                crate::refuse!(BadRequest, "deny needs from: the agent whose request you decline");
            };
            audiences::deny(engine, &org, &me, r, s("target")).await?
        }
        "revoke" => {
            let Some(g) = s("grantee").or(s("from")) else {
                crate::refuse!(BadRequest, "revoke needs grantee: who holds the audience");
            };
            audiences::revoke(engine, &org, &me, g, s("target")).await?
        }
        "forward" => crate::refuse!(
            Unprocessable,
            "requests no longer climb the chain: each goes straight to whom it names, who grants or denies it"
        ),
        other => crate::refuse!(BadRequest, "action must be request, grant, deny or revoke (not {other:?})"),
    };
    Done::json(&v)
}

/// orgtree_work.
#[logged]
async fn work_tool(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    use crate::domain::docket::{self, Who};
    let Some(org) = engine.orgs.by_id(caller.org_id) else {
        crate::refuse!(NotFound, "organization not open");
    };
    let client = engine.db.get().await?;
    let m = me(&client, caller).await?;
    drop(client);
    let who = Who::Agent { id: m.id, name: m.name.clone(), generation: m.generation };
    let action = args["action"].as_str().unwrap_or("").trim();
    let slug = args["slug"].as_str().or(args["id"].as_str()).map(str::trim).filter(|s| !s.is_empty());
    let need = || -> Result<&str> {
        match slug {
            Some(s) => Ok(s),
            None => crate::refuse!(BadRequest, "{action} needs `slug`: the item's readable name"),
        }
    };
    let list = |k: &str| -> Vec<String> {
        match &args[k] {
            Value::Array(a) => a.iter().filter_map(|x| x.as_str()).map(|s| s.trim().trim_start_matches('@').to_string()).filter(|s| !s.is_empty()).collect(),
            Value::String(s) => s.split(',').map(|x| x.trim().trim_start_matches('@').to_string()).filter(|x| !x.is_empty()).collect(),
            _ => Vec::new(),
        }
    };
    let v = match action {
        "list" => docket::agent_list(engine, &org, &who, args).await?,
        "get" => docket::agent_get(engine, &org, &who, need()?, args).await?,
        "create" => docket::create(engine, &org, &who, args).await?,
        "update" => docket::update(engine, &org, &who, args).await?,
        "accept" => {
            let mut a = json!({ "slug": need()?, "status": "done", "keep_done": true, "keep_next": true });
            if let Some(n) = args["note"].as_str() {
                a["done_append"] = json!([n]);
            }
            docket::update(engine, &org, &who, &a).await?
        }
        "assign" => {
            let Some(owner) = args["owner"].as_str().filter(|o| !o.trim().is_empty()) else {
                crate::refuse!(BadRequest, "assign needs `owner`: you or a subordinate");
            };
            docket::assign(engine, &org, &who, need()?, owner).await?
        }
        "handoff" => docket::handoff(engine, &org, &who, need()?, args["target"].as_str(), args["reason"].as_str().unwrap_or("")).await?,
        "participants" => docket::participants(engine, &org, &who, need()?, &list("add"), &list("remove")).await?,
        "evidence" => docket::evidence(engine, &org, &who, need()?, args).await?,
        "archive" | "supersede" | "move" => docket::arrange(engine, &org, &who, action, need()?, args).await?,
        "delete" => docket::delete(engine, &org, &who, need()?).await?,
        "addendum" | "review" | "verdict" | "candidate_verdict" | "integration_verdict" | "review_verdict" | "review_request"
        | "review_grant" | "review_grants" | "review_revoke" | "decision" | "receipt" | "rangediff" | "receipts" | "artifact"
        | "artifact_read" | "grant" | "revoke" | "finding" | "dispose" | "claim" | "verify" | "check" => crate::refuse!(
            Unprocessable,
            "`{action}` is not part of the docket any more: acceptance checks, review seats and verdicts, receipts, artifacts, findings, claims and addenda were removed. Record evidence notes, and use the review / approved / done statuses (a reviewer is named with `reviewer` on update)"
        ),
        other => crate::refuse!(BadRequest, "unknown docket action {other:?} (list, get, create, update, assign, handoff, participants, evidence, archive, supersede, move, delete)"),
    };
    Done::json(&v)
}
