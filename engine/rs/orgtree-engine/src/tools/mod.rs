//! The agents' `orgtree_*` tools: an MCP server living inside the engine,
//! reached over each CLI's own control channel (Claude Code `mcp_message`).
//! A call names no identity: the process it came from is the caller.

mod control;
mod defs;
mod mailtools;
mod orgview;

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::domain::UserError;
use crate::engine::Engine;
use crate::runtime::{AgentMsg, Caller};


/// One JSON-RPC message from the CLI → the response it gets.
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
pub struct Done {
    pub text: String,
    pub card: Option<Value>,
}

impl Done {
    pub fn text(s: impl Into<String>) -> Result<Done> {
        Ok(Done { text: s.into(), card: None })
    }
    pub fn json(v: &Value) -> Result<Done> {
        Ok(Done { text: serde_json::to_string_pretty(v).unwrap_or_default(), card: None })
    }
}

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
        other if other.starts_with("orgtree_") => {
            crate::refuse!(Unprocessable, "{other} is not available in this engine build yet")
        }
        other => crate::refuse!(NotFound, "unknown tool {other}"),
    }
}

// ------------------------------------------------------------ shared helpers

/// The caller's own row, read fresh.
pub struct Me {
    pub id: i64,
    pub org_id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub generation: i32,
    pub visibility: String,
}

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
pub struct Target {
    pub id: i64,
    pub name: String,
    pub state: String,
    pub parent_id: Option<i64>,
}

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

pub fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub fn need_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    match arg_str(args, key) {
        Some(s) => Ok(s),
        None => crate::refuse!(BadRequest, "`{key}` is required"),
    }
}
