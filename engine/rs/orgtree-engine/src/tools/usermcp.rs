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

mod questions;
mod settings;
mod accounts;
#[cfg(test)]
mod integration_tests;

/// Tools served without an org (`POST /api/mcp`): enough to find or create
/// the org to manage.
const ORGLESS_TOOLS: &[&str] = &["orgtree_list_orgs", "orgtree_list_tiers", "orgtree_create_org", "orgtree_client_tokens", "orgtree_settings", "orgtree_accounts"];
/// Tools served per org (`POST /api/orgs/{slug}/mcp`).
const ORG_TOOLS: &[&str] = &[
    "orgtree_chart", "orgtree_list_orgs", "orgtree_list_tiers", "orgtree_message", "orgtree_send_notice",
    "orgtree_inbox", "orgtree_work", "orgtree_hire", "orgtree_retire", "orgtree_interrupt",
    "orgtree_answer", "orgtree_create_org", "orgtree_move", "orgtree_reorder", "orgtree_retool",
    "orgtree_rehire", "orgtree_reallocate", "orgtree_questions", "orgtree_settings", "orgtree_accounts",
];

/// One JSON-RPC message from a remote MCP client → its response, the same
/// handshake shapes the in-process agent MCP server answers.
#[nolog]
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

/// Reuse shared operation fields, but describe user authority and replace
/// cards whose user handlers deliberately implement a smaller contract.
#[logged]
fn cards(org_scoped: bool) -> Vec<Value> {
    let names = if org_scoped { ORG_TOOLS } else { ORGLESS_TOOLS };
    let mut out: Vec<Value> = defs::list()
        .into_iter()
        .filter(|t| t["name"].as_str().map(|n| names.contains(&n)).unwrap_or(false))
        .collect();
    for card in &mut out {
        match card["name"].as_str().unwrap_or("") {
            "orgtree_message" | "orgtree_send_notice" => {
                let notice = card["name"] == "orgtree_send_notice";
                let mut metadata = json!({"to":{"anyOf":[{"type":"string"},
                    {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":1}],
                    "description":"one agent in this organization"}});
                if !notice {
                    metadata["notice"] = json!({"type":"boolean","description":"passive mail; default false"});
                }
                *card = user_card(if notice { "orgtree_send_notice" } else { "orgtree_message" },
                    if notice { "Send passive user mail to one agent in this org; wakes nobody. Metadata first, body last. Outside mail, question cards, attachments, reply quoting and other agent-mail options are unsupported." }
                    else { "Send user mail to one agent in this org. Wakes unless metadata.notice=true. Metadata first, body last. Outside mail, question cards, attachments, reply quoting and other agent-mail options are unsupported." },
                    json!({"metadata":{"type":"object","properties":metadata,"required":["to"],"additionalProperties":false},
                        "body":{"type":"string"}}), &["metadata","body"]);
            }
            "orgtree_inbox" => *card = user_card("orgtree_inbox",
                "Read the user's own inbox. list (default): limit 1–200 per pending/delivered/sent list, default 50. fetch: 1–20 message_ids. settings reads the org outside-inbox mode; configure with mode normal|dnd|closed changes it as the user. Each action accepts only its own fields; no project/org-inbox pulls, chunk or conversation reads.",
                json!({"action":{"type":"string","enum":["list","fetch","settings","configure"]},
                    "limit":{"type":"integer","minimum":1,"maximum":200},
                    "message_ids":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":20},
                    "mode":{"type":"string","enum":["normal","dnd","closed"]}}), &[]),
            "orgtree_interrupt" => *card = user_card("orgtree_interrupt",
                "Stop the named agent's current turn as the user. No running turn returns interrupted=false. Waits up to 60 seconds for the runtime; queued/restart orchestration is unsupported and refused.",
                json!({"node":{"type":"string"}}), &["node"]),
            "orgtree_chart" => card["description"] = json!("Read this organization's chart as the user: tiers, credits, status and audiences. include_archived includes retired nodes; include_standing_charter defaults true."),
            "orgtree_list_tiers" => card["description"] = json!("List available tiers and seat prices as the user. refresh=true requests coalesced provider discovery/sign-in checking; no agent permission group is required."),
            "orgtree_list_orgs" => card["description"] = json!("List active local organizations and connected hub peers as the user; no agent audience is required to read this metadata."),
            "orgtree_hire" => card["description"] = json!("Hire as the user, with ordinary credit/scope validation and Undo recording. No parent/target hires at top level. A superior insertion needs hire_type=superior and target. index is the zero-based live sibling position; ordinary hire needs explicit scope fields."),
            "orgtree_retire" => card["description"] = json!("Retire the named agent as the user through the desktop's Undo-recorded tree operation. Its saved context remains available for rehire."),
            "orgtree_move" => card["description"] = json!("Move nodes in this organization as the user. Use node/new_parent or moves[{node,new_parent}]; a batch is atomic. Ordinary tree and credit validation and desktop Undo apply."),
            "orgtree_reorder" => card["description"] = json!("Reorder a live node as the user: index is its zero-based final sibling position after removing it. Ordinary tree validation and desktop Undo apply."),
            "orgtree_retool" => card["description"] = json!("Change a named agent's supplied scope or charter fields as the user. Unspecified fields stay unchanged; folder restrictions propagate to descendants. Ordinary scope validation and desktop Undo apply."),
            "orgtree_rehire" => card["description"] = json!("Restore a retired node as the user. Omitted agent fields retain saved values; target/hire_type set placement and index is forbidden. Projects retain policy and reject agent overrides. Ordinary scope/credit validation and desktop Undo apply."),
            "orgtree_reallocate" => card["description"] = json!("Adjust a named agent's grant as the user: positive delta grants, negative takes unused credits back. Ordinary caps, committed-credit checks and the user's credit-bubbling setting apply."),
            "orgtree_work" => {
                card["description"] = json!("Manage this organization's docket as the user: list/get, create/update, complete with accept, assign/handoff, participants/evidence, archive/supersede/move/delete. The user authority path applies; progress preservation, revision and status/reason validation remain in effect.");
                card["inputSchema"]["properties"]["owner"]["description"] = json!("create/assign: named owner; update: retain the current owner when desired");
                card["inputSchema"]["properties"]["target"]["description"] = json!("handoff: explicit target agent");
            }
            _ => {}
        }
    }
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
            "description": "Answer an open question as the user; discover IDs with orgtree_questions. Ordinary cards take positional answers [{selected:[option labels],text:free text}], or dismiss:true, and the card's rev. Elicitation cards instead take action accept|decline|cancel and content for an accepted form. Submitted private form content is not echoed. Mixed question/credit/scope requests use orgtree_questions batch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ask": { "type": "string" },
                    "answers": { "type": "array", "items": { "type": "object" } },
                    "dismiss": { "type": "boolean" },
                    "rev": { "type": "integer" },
                    "action": { "type": "string", "enum": ["accept", "decline", "cancel"] },
                    "content": { "type": "object" }
                },
                "required": ["ask"]
            }
        }));
    }
    if names.contains(&"orgtree_questions") {
        out.push(questions::card());
    }
    if names.contains(&"orgtree_settings") {
        out.push(settings::card());
    }
    if names.contains(&"orgtree_accounts") {
        out.push(accounts::card());
    }
    if names.contains(&"orgtree_client_tokens") {
        out.push(user_card("orgtree_client_tokens",
            "Manage named standalone client tokens as the user. list (default) returns active id/name/created_at only; create needs name (1-100 characters) and returns a random secret ONCE; revoke needs id and immediately drops every HTTP/WS/MCP socket used with that token. Self-revoke disconnects you without a response promise; reconnect with another token or bootstrap key. Shared sockets close when any token used there is revoked. Bootstrap cannot be revoked; at most 128 active clients.",
            json!({"action":{"type":"string","enum":["list","create","revoke"]},
                "name":{"type":"string","minLength":1,"maxLength":100},"id":{"type":"string"}}), &[]));
    }
    for card in &mut out {
        card["inputSchema"]["additionalProperties"] = json!(false);
    }
    out
}

#[logged]
fn user_card(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object",
        "properties":properties,"required":required,"additionalProperties":false}})
}

/// Reject unsupported options before any provider, database or runtime action.
/// Keep the existing flat mail and identifier aliases as compatibility inputs.
#[nolog] // Account secrets and elicitation content must not enter argument logs.
fn validate_args(org_scoped: bool, name: &str, args: &Value) -> Result<()> {
    let Some(card) = cards(org_scoped).into_iter().find(|c| c["name"] == name) else {
        crate::refuse!(BadRequest, "{name} is not on this user MCP endpoint");
    };
    let properties = card["inputSchema"]["properties"].as_object().unwrap();
    let mail = matches!(name, "orgtree_message" | "orgtree_send_notice");
    let Some(object) = args.as_object() else {
        crate::refuse!(BadRequest, "arguments must be a JSON object");
    };
    for key in object.keys() {
        let alias = (mail && matches!(key.as_str(), "to" | "notice"))
            || (name == "orgtree_answer" && matches!(key.as_str(), "id" | "question_id"))
            || (name == "orgtree_work" && key == "id");
        if !properties.contains_key(key) && !alias {
            crate::refuse!(BadRequest, "{name}: unsupported user MCP field `{key}`");
        }
        if let Some(schema) = properties.get(key) {
            let value=&object[key];
            let typed=match schema["type"].as_str() {
                Some("string")=>value.is_string(), Some("object")=>value.is_object(),
                Some("array")=>value.is_array(), Some("boolean")=>value.is_boolean(),
                Some("integer")=>value.is_i64() || value.is_u64(), Some("number")=>value.is_number(),
                _=>true,
            };
            if !typed || schema["enum"].as_array().is_some_and(|choices|!choices.contains(value)) {
                crate::refuse!(BadRequest,"invalid value type or choice for user MCP field `{key}`");
            }
        }
    }
    if mail {
        if args.get("metadata").is_some_and(|v| !v.is_object()) {
            crate::refuse!(BadRequest, "metadata must be an object");
        }
        if args.get("metadata").is_some() && (args.get("to").is_some() || args.get("notice").is_some()) {
            crate::refuse!(BadRequest, "do not mix metadata and flat mail routing");
        }
        let metadata = args.get("metadata").unwrap_or(args);
        for key in metadata.as_object().unwrap().keys() {
            if key != "to" && !(name == "orgtree_message" && key == "notice")
                && !(args.get("metadata").is_none() && key == "body") {
                crate::refuse!(BadRequest, "{name}: unsupported user mail field `{key}`");
            }
        }
        if metadata.get("notice").is_some_and(|v| !v.is_boolean()) {
            crate::refuse!(BadRequest, "notice must be true or false");
        }
    }
    if name == "orgtree_inbox" {
        let fields: &[&str] = match args["action"].as_str().unwrap_or("list").trim() {
            "list" => &["action", "limit"],
            "fetch" => &["action", "message_ids"],
            "settings" => &["action"],
            "configure" => &["action", "mode"],
            other => crate::refuse!(BadRequest, "unsupported user inbox action {other:?}"),
        };
        if object.keys().any(|k| !fields.contains(&k.as_str())) {
            crate::refuse!(BadRequest, "unexpected field for this user inbox action");
        }
    }
    Ok(())
}

#[nolog]
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

#[nolog]
fn api(e: ApiError) -> anyhow::Error {
    anyhow::anyhow!(e.detail)
}

#[nolog]
fn need_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    match args[key].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Ok(s),
        None => crate::refuse!(BadRequest, "`{key}` is required"),
    }
}

#[nolog]
async fn dispatch(engine: &Arc<Engine>, org: Option<&Arc<OrgHandle>>, name: &str, args: &Value) -> Result<Done> {
    validate_args(org.is_some(), name, args)?;
    match name {
        "orgtree_list_tiers" => return super::orgview::list_tiers(engine, args).await,
        "orgtree_list_orgs" => return list_orgs(engine, org).await,
        "orgtree_create_org" => return create_org(engine, args).await,
        "orgtree_client_tokens" => return Ok(Done { text: serde_json::to_string(&crate::http::client_tokens::manage(engine, args).map_err(api)?)?, card: None }),
        "orgtree_settings" => return crate::util::boxed(||settings::run(engine, org, args)).await,
        "orgtree_accounts" => return crate::util::boxed(||accounts::run(engine, args)).await,
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
        "orgtree_hire" => crate::util::boxed(||tree_op(engine, org, "hire", args)).await,
        "orgtree_retire" => crate::util::boxed(||tree_op(engine, org, "retire", args)).await,
        "orgtree_move" => crate::util::boxed(||tree_op(engine, org, "move", args)).await,
        "orgtree_reorder" => crate::util::boxed(||tree_op(engine, org, "reorder", args)).await,
        "orgtree_retool" => crate::util::boxed(||tree_op(engine, org, "retool", args)).await,
        "orgtree_rehire" => crate::util::boxed(||tree_op(engine, org, "rehire", args)).await,
        "orgtree_reallocate" => crate::util::boxed(||tree_op(engine, org, "reallocate", args)).await,
        "orgtree_interrupt" => interrupt(engine, org, args).await,
        "orgtree_answer" => answer(engine, org, args).await,
        "orgtree_questions" => crate::util::boxed(||questions::run(engine, org, args)).await,
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
    let tags=crate::domain::mail_tags::normalize(meta.get("tags"))?;
    crate::domain::mail_tags::recipient(&to,&tags)?;
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
    if matches!(action,"settings"|"configure") {
        let keys:&[&str]=if action=="configure" {&["action","mode"]} else {&["action"]};
        if args.as_object().is_none_or(|a|a.keys().any(|k|!keys.contains(&k.as_str()))) {
            crate::refuse!(BadRequest,"unexpected org inbox policy field");
        }
        if action=="configure" {
            let mode=need_str(args,"mode")?;
            let _ = crate::http::settings::save_org(axum::extract::State(engine.clone()),axum::extract::Path(org.slug.clone()),
                axum::Json(serde_json::Map::from_iter([("org_inbox_mode".into(),json!(mode))]))).await.map_err(api)?;
        }
        let c=engine.db.get().await?;
        let settings:Value=c.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org.id]).await?.get(0);
        return Done::json(&json!({"mode":crate::domain::orginbox::mode(&settings),"enabled":crate::domain::orginbox::enabled(&settings),"can_configure":true}));
    }
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
    let req = tree_request(op, args)?;
    let op = req["op"].as_str().unwrap();
    let out = if crate::domain::undo::RECORDED_OPS.contains(&op) {
        crate::util::boxed(||crate::http::undo::single(engine, org, req)).await.map_err(api)?
    } else {
        crate::util::boxed(||ops::run(engine, org, Actor::User, &req)).await?
    };
    Done::json(&out)
}

#[logged]
fn tree_request(op: &str, args: &Value) -> Result<Value> {
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
    if op == "rehire" {
        if let Some(target) = args["target"].as_str() {
            req["parent"] = json!(target);
        }
    }
    if op == "move" && args["moves"].is_array() {
        req["op"] = json!("moves");
    }
    Ok(req)
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
#[nolog] // Native permission forms can contain private user input.
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
    let fields: &[&str] = if aid.starts_with("elicitation-") {
        &["ask", "question_id", "id", "action", "content"]
    } else {
        &["ask", "question_id", "id", "answers", "dismiss", "rev"]
    };
    questions::only(args, fields)?;
    let mut body = json!({});
    for key in ["answers", "dismiss", "rev", "action", "content"] {
        if !args[key].is_null() {
            body[key] = args[key].clone();
        }
    }
    if !aid.starts_with("elicitation-") && args.get("answers").is_some() {
        let answers=questions::answer_values(&args["answers"],false)?;
        let card=questions::open_card(engine,org,aid).await?;
        let count=card["questions"].as_array().map_or(1,Vec::len);
        if answers.len()!=count { crate::refuse!(BadRequest,"send one answer per question"); }
        body["selected"]=if count==1 { answers.into_iter().next().unwrap() } else { json!(answers) };
        body.as_object_mut().unwrap().remove("answers");
    }
    let out = crate::http::asks::answer(axum::extract::State(engine.clone()),
        axum::extract::Path((org.slug.clone(), aid.to_string())), axum::Json(body)).await.map_err(api)?;
    Ok(Done { text: serde_json::to_string(&out.0)?, card: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_tree_cards_and_request_mapping() {
        for name in ["orgtree_move", "orgtree_reorder", "orgtree_retool", "orgtree_rehire", "orgtree_reallocate"] {
            assert!(names(true).iter().any(|n| n == name), "missing {name}");
            assert!(!names(false).iter().any(|n| n == name));
        }
        assert_eq!(tree_request("move", &json!({"moves":[{"node":"a","new_parent":"b"}]})).unwrap()["op"], "moves");
        assert_eq!(tree_request("move", &json!({"node":"a","new_parent":"b"})).unwrap()["op"], "move");
        let rehire=tree_request("rehire", &json!({"node":"a","target":"b","hire_type":"superior"})).unwrap();
        assert_eq!(rehire["parent"], "b");
        assert_eq!(rehire["hire_type"], "superior");
        assert!(validate_args(true,"orgtree_rehire",&json!({"node":"a","index":0})).is_err());
    }
    #[test] fn org_dnd_mode_configure_is_only_on_the_user_card() {
        let user=cards(true).into_iter().find(|c|c["name"]=="orgtree_inbox").unwrap();
        let agent=defs::list().into_iter().find(|c|c["name"]=="orgtree_inbox").unwrap();
        assert!(user["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("configure")));
        assert!(!agent["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("configure")));
        assert!(agent["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("pull")));
        assert_eq!(user["inputSchema"]["properties"]["mode"]["enum"],json!(["normal","dnd","closed"]));
    }

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

    #[test]
    fn user_cards_do_not_advertise_agent_only_options() {
        let user = cards(true);
        assert!(user.iter().all(|c| c["inputSchema"]["additionalProperties"] == false));
        let card = |name: &str| user.iter().find(|c| c["name"] == name).unwrap();
        let interrupt = &card("orgtree_interrupt")["inputSchema"]["properties"];
        assert_eq!(interrupt.as_object().unwrap().len(), 1);
        assert!(interrupt.get("node").is_some());
        for name in ["orgtree_message", "orgtree_send_notice"] {
            let metadata = &card(name)["inputSchema"]["properties"]["metadata"];
            assert_eq!(metadata["additionalProperties"], false);
            assert_eq!(metadata["properties"]["to"]["anyOf"][1]["maxItems"], 1);
            for unsupported in ["attachments", "replies", "reply_to", "urgent", "kind", "options", "tags"] {
                assert!(metadata["properties"].get(unsupported).is_none(), "{name}: {unsupported}");
            }
        }
        let inbox = &card("orgtree_inbox")["inputSchema"]["properties"];
        for unsupported in ["project", "peer", "cursor", "org_inbox", "chunk_index"] {
            assert!(inbox.get(unsupported).is_none(), "inbox: {unsupported}");
        }
        let agent = defs::list();
        let agent_interrupt = agent.iter().find(|c| c["name"] == "orgtree_interrupt").unwrap();
        assert!(agent_interrupt["inputSchema"]["properties"].get("restart").is_some());
        let agent_mail = agent.iter().find(|c| c["name"] == "orgtree_message").unwrap();
        assert!(agent_mail["inputSchema"]["properties"]["metadata"]["properties"].get("attachments").is_some());
    }

    #[test]
    fn unsupported_user_arguments_refuse_before_dispatch() {
        for flag in ["queued", "restart"] {
            for value in [json!(true), json!(false), Value::Null] {
                let mut args = json!({"node":"worker"});
                args[flag] = value;
                assert!(validate_args(true, "orgtree_interrupt", &args).is_err());
            }
        }
        for field in ["attachments", "reply_to", "replies", "kind", "urgent", "urgent_reason", "options", "multiple", "tags"] {
            let mut args = json!({"metadata":{"to":"worker"},"body":"task"});
            args["metadata"][field] = json!([]);
            assert!(validate_args(true, "orgtree_message", &args).is_err(), "{field}");
            let mut flat = json!({"to":"worker","body":"task"});
            flat[field] = json!([]);
            assert!(validate_args(true, "orgtree_message", &flat).is_err(), "flat {field}");
        }
        for args in [json!({"action":"pull"}), json!({"project":"queue"}),
            json!({"action":"fetch","message_ids":["m1"],"limit":1}),
            json!({"action":"settings","mode":"closed"})] {
            assert!(validate_args(true, "orgtree_inbox", &args).is_err());
        }
        assert!(validate_args(false, "orgtree_interrupt", &json!({"node":"worker"})).is_err());
        assert!(validate_args(true, "orgtree_watchdog", &json!({})).is_err());
    }

    #[test]
    fn supported_user_arguments_and_compatibility_aliases_remain() {
        for (name, args) in [
            ("orgtree_interrupt", json!({"node":"worker"})),
            ("orgtree_message", json!({"metadata":{"to":"worker","notice":true},"body":"task"})),
            ("orgtree_message", json!({"to":["worker"],"notice":false,"body":"task"})),
            ("orgtree_send_notice", json!({"metadata":{"to":"worker"},"body":"task"})),
            ("orgtree_inbox", json!({"limit":2})),
            ("orgtree_inbox", json!({"action":"fetch","message_ids":["m1"]})),
            ("orgtree_inbox", json!({"action":"configure","mode":"dnd"})),
            ("orgtree_answer", json!({"question_id":"q1","dismiss":true})),
            ("orgtree_work", json!({"action":"get","id":"task"})),
        ] {
            validate_args(true, name, &args).unwrap();
        }
        validate_args(false, "orgtree_list_tiers", &json!({"refresh":false})).unwrap();
    }
}
