//! The user MCP endpoint's tool set (standalone mode, user ruling
//! 2026-10-16: remote MCP acts as the user). The HTTP side is
//! `http::usermcp`; every call there already carries the standalone token.
//!
//! This is deliberately NOT the agent dispatcher with a fake caller: agent
//! tools read the caller's own row and chain of command. Here each tool is
//! implemented against the same internal paths the desktop's user actions
//! take (`Actor::User` ops, `Who::User` docket, `From::User` mail, the
//! user's inbox), so authority is the user's by construction. Only the
//! tools listed here exist on this endpoint; agent-only tools (status,
//! audiences, watchdogs, asking, presenting…) stay with agents, and the
//! full HTTP API remains available beside it.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};

use super::{defs, mcp_handshake, Done};
use crate::domain::docket::Who;
use crate::domain::mail::{self, From, Outgoing};
use crate::domain::ops::{self, Actor};
use crate::domain::UserError;
use crate::engine::Engine;
use crate::http::error::ApiError;
use crate::orgs::OrgHandle;

/// Tools served without an org (`POST /api/mcp`): enough to find or create
/// the org to manage.
const ORGLESS_TOOLS: &[&str] = &["orgtree_list_orgs", "orgtree_list_tiers", "orgtree_create_org"];
/// Tools served per org (`POST /api/orgs/{slug}/mcp`).
const ORG_TOOLS: &[&str] = &[
    "orgtree_chart", "orgtree_list_orgs", "orgtree_list_tiers", "orgtree_message", "orgtree_send_notice",
    "orgtree_inbox", "orgtree_work", "orgtree_hire", "orgtree_retire", "orgtree_interrupt",
    "orgtree_answer", "orgtree_create_org",
];

/// One JSON-RPC message from a remote MCP client → its response, the same
/// handshake shapes the in-process agent MCP server answers.
#[logged]
pub async fn handle(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>, msg: &Value) -> Value {
    let method = msg["method"].as_str().unwrap_or("");
    if method == "tools/call" {
        if let Some(id) = msg.get("id").cloned().filter(|i| !i.is_null()) {
            return json!({ "jsonrpc": "2.0", "id": id, "result": call(engine, org, &msg["params"]).await });
        }
        return json!({ "jsonrpc": "2.0", "id": 0, "result": {} });
    }
    if method == "tools/list" {
        return mcp_handshake(msg, cards(org.is_some()));
    }
    let mut res = mcp_handshake(msg, Vec::new());
    if method == "initialize" {
        let whereabouts = match org {
            Some(o) => format!("organization {} ({})", o.name.load(), o.slug),
            None => "no organization yet: orgtree_list_orgs lists them, orgtree_create_org makes one, then connect to /api/orgs/<slug>/mcp".to_string(),
        };
        res["result"]["instructions"] = json!(format!(
            "You are connected as the USER of this Orgtree engine, for {whereabouts}. \
             orgtree_message sends user mail to one named agent; orgtree_inbox is the user's own inbox; \
             orgtree_hire with no parent or target hires at the top level; orgtree_work acts as the user on the docket. \
             Agent-only tools are not listed here."
        ));
    }
    res
}

/// The endpoint's tool cards: the agent cards for the shared names (same
/// argument shapes), plus the two user-only tools.
#[logged]
fn cards(org_scoped: bool) -> Vec<Value> {
    let names = if org_scoped { ORG_TOOLS } else { ORGLESS_TOOLS };
    let mut out: Vec<Value> = defs::list()
        .into_iter()
        .filter(|t| t["name"].as_str().map(|n| names.contains(&n)).unwrap_or(false))
        .collect();
    if names.contains(&"orgtree_create_org") {
        out.push(json!({
            "name": "orgtree_create_org",
            "description": "Create a new organization on this engine, as the user. `name` is required (letters or digits; the slug is derived from it); `dirs` optionally lists the org's granted folders. Then manage it through /api/orgs/<slug>/mcp.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "dirs": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["name"]
            }
        }));
    }
    if names.contains(&"orgtree_answer") {
        out.push(json!({
            "name": "orgtree_answer",
            "description": "Answer one open question card an agent asked the user, as the user. `ask` is the question's id (question cards arrive in the user's inbox and agent transcripts); `answers` is one entry per question, positionally: {selected: [chosen option labels], text: free text}. `dismiss: true` dismisses instead of answering. Pass `rev` back when the card shows one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ask": { "type": "string" },
                    "answers": { "type": "array", "items": { "type": "object" } },
                    "dismiss": { "type": "boolean" },
                    "rev": { "type": "integer" }
                },
                "required": ["ask"]
            }
        }));
    }
    out
}

#[logged]
async fn call(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(a) if a.is_object() => a.clone(),
        Some(_) => {
            return json!({ "content": [{ "type": "text", "text": format!("{name}: the arguments must be a JSON object") }], "isError": true });
        }
    };
    match dispatch(engine, org, name, &args).await {
        Ok(done) => json!({ "content": [{ "type": "text", "text": done.text }] }),
        Err(e) => {
            let text = match e.downcast_ref::<UserError>() {
                Some(u) => u.to_string(),
                None => format!("{e:#}"),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": true })
        }
    }
}

#[logged]
fn api(e: ApiError) -> anyhow::Error {
    anyhow::anyhow!(e.detail)
}

#[logged]
fn need_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    match args[key].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Ok(s),
        None => crate::refuse!(BadRequest, "`{key}` is required"),
    }
}

#[logged]
async fn dispatch(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>, name: &str, args: &Value) -> Result<Done> {
    match name {
        "orgtree_list_tiers" => return super::orgview::list_tiers(engine).await,
        "orgtree_list_orgs" => return list_orgs(engine, org).await,
        "orgtree_create_org" => return create_org(engine, args).await,
        _ => {}
    }
    let Some(org) = org else {
        crate::refuse!(BadRequest, "{name} needs an organization: call it on /api/orgs/<slug>/mcp (orgtree_list_orgs names them)");
    };
    match name {
        "orgtree_chart" => super::orgview::chart_as_user(engine, org, args).await,
        "orgtree_message" => message(engine, org, args, false).await,
        "orgtree_send_notice" => message(engine, org, args, true).await,
        "orgtree_inbox" => inbox(engine, org, args).await,
        "orgtree_work" => super::work_with(engine, org, &Who::User, args).await,
        "orgtree_hire" => tree_op(engine, org, "hire", args).await,
        "orgtree_retire" => tree_op(engine, org, "retire", args).await,
        "orgtree_interrupt" => interrupt(engine, org, args).await,
        "orgtree_answer" => answer(engine, org, args).await,
        other => crate::refuse!(BadRequest, "{other} is not on the user MCP endpoint: these tools act as the user, and agent-only tools stay with agents"),
    }
}

/// The orgs on this machine (and hub peers), the agent tool's read with no
/// caller org required.
#[logged]
async fn list_orgs(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>) -> Result<Done> {
    let client = engine.db.get().await?;
    // Public metadata only: never select the identity secret or full net blob.
    let rows = client.query("SELECT slug, name, net->'identity'->>'slug' FROM ot.orgs WHERE state='active' ORDER BY slug", &[]).await?;
    let locals: Vec<(String, String, Option<String>)> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
    let current = org.map(|o| o.slug.as_str()).unwrap_or("");
    Done::json(&crate::net::discovery_rows(current, &locals, crate::net::remote_peers(engine)))
}

/// Create an org through the desktop's own create handler (same checks,
/// same seeding), with a name and optional granted folders.
#[logged]
async fn create_org(engine: &Arc<Engine>, args: &Value) -> Result<Done> {
    let name = need_str(args, "name")?;
    let dirs: Vec<Value> = args["dirs"].as_array().cloned().unwrap_or_default();
    let parsed: crate::http::orgops::CreateOrg = serde_json::from_value(json!({ "name": name, "dirs": dirs }))
        .map_err(|e| anyhow::anyhow!("invalid orgtree_create_org arguments: {e}"))?;
    let out = crate::http::orgops::create(axum::extract::State(engine.clone()), axum::Json(parsed))
        .await
        .map_err(api)?;
    Done::json(&out.0)
}

/// User mail to one agent in this org (`From::User`, the desktop composer's
/// own path). One recipient; attachments and reply quoting are not on this
/// endpoint yet.
#[logged]
async fn message(engine: &Arc<Engine>, org: &Arc<OrgHandle>, args: &Value, force_notice: bool) -> Result<Done> {
    let meta = if args["metadata"].is_object() { &args["metadata"] } else { args };
    let to = match &meta["to"] {
        Value::String(s) => s.trim().to_string(),
        Value::Array(a) if a.len() == 1 => a[0].as_str().unwrap_or("").trim().to_string(),
        Value::Array(_) => crate::refuse!(BadRequest, "the user's mail names one recipient agent at a time"),
        _ => crate::refuse!(BadRequest, "`to` (in metadata) is required: an agent's name"),
    };
    if to.is_empty() || to == "user" {
        crate::refuse!(BadRequest, "`to` must name an agent in this organization");
    }
    if to.starts_with("@org:") || to.starts_with("@net:") || to == "extern" {
        crate::refuse!(BadRequest, "outside mail goes through an agent holding the org inbox audience, not the user's own mail");
    }
    if meta["kind"].as_str() == Some("question") {
        crate::refuse!(BadRequest, "send a plain message; question cards are what agents send the user (answer them with orgtree_answer)");
    }
    if meta.get("attachments").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false) {
        crate::refuse!(BadRequest, "attachments are not on the user MCP endpoint yet; name the file's path on the engine host in the body");
    }
    if meta.get("reply_to").is_some_and(|v| !v.is_null()) || meta.get("replies").is_some_and(|v| !v.is_null()) {
        crate::refuse!(BadRequest, "reply quoting is not on the user MCP endpoint yet");
    }
    let body = match args["body"].as_str() {
        Some(b) if !b.trim().is_empty() => b,
        _ => crate::refuse!(BadRequest, "`body` is required"),
    };
    let a = crate::http::nodes::agent(engine, org, &to).await.map_err(api)?;
    let notice = force_notice || meta["notice"].as_bool().unwrap_or(false);
    let mut out = Outgoing::new(From::User, &a.name, body);
    out.notice = notice;
    let sent = mail::send(engine, org.id, out).await?;
    Done::json(&json!({
        "sent": true, "id": sent.uid, "to": a.name, "notice": notice,
        "delivery": sent.delivery, "deferred": sent.deferred, "recipient_state": sent.recipient_state,
    }))
}

/// The user's own inbox in this org: the renderer's lists, bounded.
#[logged]
async fn inbox(engine: &Arc<Engine>, org: &Arc<OrgHandle>, args: &Value) -> Result<Done> {
    let action = args["action"].as_str().unwrap_or("list").trim();
    let client = engine.db.get().await?;
    let (pending, read, sent) = crate::feed::compute::user_mail(&client, org.id).await?;
    drop(client);
    let pick = |v: Vec<(i64, Value)>| -> Vec<Value> { v.into_iter().map(|(_, m)| m).collect() };
    match action {
        "list" => {
            let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 200) as usize;
            let take = |v: Vec<(i64, Value)>| -> Vec<Value> { pick(v).into_iter().take(limit).collect() };
            Done::json(&json!({ "pending": take(pending), "delivered": take(read), "sent": take(sent) }))
        }
        "fetch" => {
            let ids: Vec<String> = args["message_ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if ids.is_empty() || ids.len() > 20 {
                crate::refuse!(BadRequest, "fetch needs 1 to 20 `message_ids` (from action list)");
            }
            let all: Vec<Value> = [pick(pending), pick(read), pick(sent)].concat();
            let id_of = |m: &Value| m["uid"].as_str().or_else(|| m["id"].as_str()).unwrap_or("").to_string();
            let found: Vec<Value> = ids
                .iter()
                .filter_map(|id| all.iter().find(|m| &id_of(m) == id).cloned())
                .collect();
            if found.len() != ids.len() {
                crate::refuse!(NotFound, "one of those message ids is not in the user's inbox for this org");
            }
            Done::json(&json!({ "messages": found }))
        }
        other => crate::refuse!(BadRequest, "the user inbox here supports action list and fetch, not {other:?}"),
    }
}

/// Hire and retire as the user: the agent tools' argument shapes over
/// `Actor::User` ops, through the same undo recording the desktop's own
/// hire/retire take. No parent means the top level.
#[logged]
async fn tree_op(engine: &Arc<Engine>, org: &Arc<OrgHandle>, op: &str, args: &Value) -> Result<Done> {
    let mut req = if args.is_object() { args.clone() } else { json!({}) };
    req["op"] = json!(op);
    if op == "hire" {
        let named = args["target"].as_str().or_else(|| args["parent"].as_str());
        if args["hire_type"].as_str() == Some("superior") {
            match named {
                Some(t) => req["above"] = json!(t),
                None => crate::refuse!(BadRequest, "a superior hire needs `target`: the agent to insert above"),
            }
        } else if let Some(t) = named {
            req["parent"] = json!(t);
        }
    }
    let out = if crate::domain::undo::RECORDED_OPS.contains(&op) {
        crate::http::undo::single(engine, org, req).await.map_err(api)?
    } else {
        ops::run(engine, org, Actor::User, &req).await?
    };
    Done::json(&out)
}

/// Stop an agent's current turn, as the user's desk button does.
#[logged]
async fn interrupt(engine: &Arc<Engine>, org: &Arc<OrgHandle>, args: &Value) -> Result<Done> {
    let node = need_str(args, "node")?;
    let a = crate::http::nodes::agent(engine, org, node).await.map_err(api)?;
    if engine.agents.get(a.id).is_none() {
        return Done::json(&json!({ "interrupted": false, "reason": "no turn is running" }));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !crate::runtime::actor(engine, org.id, a.id).send(crate::runtime::AgentMsg::Interrupt(tx)) {
        crate::refuse!(Conflict, "the agent's runtime is stopping");
    }
    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(v)) => Done::json(&v),
        _ => crate::refuse!(Conflict, "the agent did not answer in time"),
    }
}

/// Answer (or dismiss) an open question card, as the user.
#[logged]
async fn answer(engine: &Arc<Engine>, org: &Arc<OrgHandle>, args: &Value) -> Result<Done> {
    let aid = args["ask"]
        .as_str()
        .or_else(|| args["question_id"].as_str())
        .or_else(|| args["id"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(aid) = aid else {
        crate::refuse!(BadRequest, "`ask` is required: the question card's id");
    };
    let mut body = json!({});
    for key in ["answers", "dismiss", "rev"] {
        if !args[key].is_null() {
            body[key] = args[key].clone();
        }
    }
    let out = crate::domain::asks::answer(engine, org, aid, &body).await?;
    Done::json(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(org_scoped: bool) -> Vec<String> {
        cards(org_scoped).iter().map(|c| c["name"].as_str().unwrap_or("").to_string()).collect()
    }

    #[test]
    fn orgless_cards_find_and_create_but_do_not_manage() {
        let n = names(false);
        assert!(n.iter().any(|x| x == "orgtree_list_orgs"));
        assert!(n.iter().any(|x| x == "orgtree_create_org"));
        assert!(!n.iter().any(|x| x == "orgtree_chart"));
        assert!(!n.iter().any(|x| x == "orgtree_message"));
    }

    #[test]
    fn org_cards_carry_the_user_tools_once_each() {
        let n = names(true);
        for want in ["orgtree_chart", "orgtree_message", "orgtree_inbox", "orgtree_work", "orgtree_hire", "orgtree_answer", "orgtree_create_org"] {
            assert_eq!(n.iter().filter(|x| *x == want).count(), 1, "{want} listed once");
        }
        // agent-only tools never leak onto the user endpoint
        for banned in ["orgtree_status", "orgtree_ask", "orgtree_audience", "orgtree_watchdog", "orgtree_present"] {
            assert!(!n.iter().any(|x| x == banned), "{banned} is agent-only");
        }
        let mut sorted = n.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), n.len(), "no duplicate cards");
    }
}
