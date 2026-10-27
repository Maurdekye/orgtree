//! Tool cards: names, one-paragraph descriptions and argument schemas. The
//! names and argument names are the ones agents already know.

use serde_json::{json, Value};

#[cfg(test)]
mod watchdog_configure_tests {
    use super::*;

    #[test]
    fn watchdog_configure_is_available_for_existing_websocket_watchers() {
        let card = build_tool_watchdog();
        let properties = &card["inputSchema"]["properties"];
        assert!(properties["action"]["enum"].as_array().unwrap().contains(&json!("configure")),
            "agents must be able to change connection notifications without recreating the watcher");
        assert_eq!(properties["notify_on_connect"]["type"], "boolean");
        assert_eq!(properties["connection_messages"]["enum"], json!(["notice","wake","off"]));
        assert!(properties["id"]["description"].as_str().unwrap().contains("configure"));
    }
}

#[cfg(test)]
mod project_agent_tool_tests {
    use super::*;

    #[test]
    fn project_tools_existing_actions_control() {
        assert!(build_tool_project()["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("settings")));
        assert!(build_tool_inbox()["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("chunk")));
    }

    #[test]
    fn project_tools_mail_history_folders_and_status_are_advertised() {
        let card=build_tool_inbox(); let p=&card["inputSchema"]["properties"];
        assert_eq!(p["folder"]["enum"],json!(["inbox","sent"]));
        assert_eq!(p["status"]["enum"],json!(["waiting","delivered","claimed","acked","dead-letter"]));
        assert!(p["project"]["description"].as_str().unwrap().contains("chunk"));
    }

    #[test]
    fn project_tools_presentation_body_continuation_is_advertised() {
        assert_eq!(build_tool_project()["inputSchema"]["properties"]["chunk_index"]["minimum"],0);
    }

    #[test]
    fn project_tools_atomic_create_above_is_advertised() {
        assert_eq!(build_tool_project()["inputSchema"]["properties"]["above"]["type"],"string");
    }

    #[test]
    fn project_tools_broadcast_mail_metadata_is_advertised() {
        let card=build_tool_project(); let p=&card["inputSchema"]["properties"];
        for field in ["urgent","urgent_reason","reply_to","replies"] {
            assert!(p.get(field).is_some(),"missing broadcast {field}");
        }
    }
}

/// Tools this build serves (the rest are listed once they land).
#[logged]
pub fn implemented() -> &'static [&'static str] {
    &[
        "orgtree_message",
        "orgtree_send_notice",
        "orgtree_status",
        "orgtree_next_turn",
        "orgtree_session",
        "orgtree_apps",
        "orgtree_org_logo",
        "orgtree_transfers", "orgtree_inbox",
        "orgtree_chart",
        "orgtree_state_inspect",
        "orgtree_usage",
        "orgtree_list_tiers",
        "orgtree_list_orgs",
        "orgtree_read_transcript",
        "orgtree_read_reply_source",
        "orgtree_files",
        "orgtree_read_scratch",
        "orgtree_interrupt",
        "orgtree_halt",
        "orgtree_unhalt",
        "orgtree_unstick",
        "orgtree_continue_on",
        "orgtree_account_mark",
        "orgtree_ask",
        "orgtree_withdraw_ask",
        "orgtree_present",
        "orgtree_send_file",
        "orgtree_watchdog",
        "orgtree_audience",
        "orgtree_work",
        "orgtree_staff",
        "orgtree_request_credits",
        "orgtree_request_scope",
        "orgtree_hire",
        "orgtree_fast_defaults",
        "orgtree_project",
        "orgtree_rehire",
        "orgtree_retire",
        "orgtree_dissolve",
        "orgtree_move",
        "orgtree_reorder",
        "orgtree_rename",
        "orgtree_reallocate",
        "orgtree_switch_model",
        "orgtree_cheap_compact",
        "orgtree_compact",
        "orgtree_retool",
        "orgtree_swap",
        "orgtree_self_subjugate",
    ]
}

#[logged]
pub fn list() -> Vec<Value> {
    let on = implemented();
    all().into_iter().filter(|t| t["name"].as_str().map(|n| on.contains(&n)).unwrap_or(false)).collect()
}

#[logged]
pub fn scoped(tools: &Value) -> Vec<Value> {
    list().into_iter().filter(|t| {
        t["name"].as_str().is_some_and(|name| crate::domain::tool_groups::allows(tools, name))
    }).map(|mut card| {
        if card["name"] == "orgtree_project" && !crate::domain::tool_groups::enabled(tools,"team") {
            card["inputSchema"]["properties"].as_object_mut().unwrap()
                .retain(|key,_| ["action","name","lease","note","id","reason","include_dropped","limit","offset","body"].contains(&key.as_str()));
            card["inputSchema"]["properties"]["action"]["enum"] = json!(["slots","release_slot","dead_letters","retry_dead_letter","drop_dead_letter","fire_event","listeners"]);
            card["description"] = json!("Release your own concurrency slot: release_slot with lease and optional note. slots with project name shows holders, reasons, ages and the whole line; other agents' lease IDs are hidden. dead_letters (name; id reads one) lists a project's failed ack-queue jobs; retry_dead_letter (name, id) requeues one, drop_dead_letter (name, id, reason) closes it. fire_event (name, body?) fires its event; listeners lists them. Available with watchdogs or team; other project actions and force release require team. Normal project reach and lease ownership checks apply. Guide: orgtree-tool-project.");
        }
        card
    }).collect()
}

/// `scoped`, with the mail tools in `shape` (`MailShape`).
#[logged]
pub fn scoped_as(tools: &Value, shape: MailShape) -> Vec<Value> {
    let cards = scoped(tools);
    if shape == MailShape::Split {
        return cards;
    }
    let [message, notice] = mail_tools(shape);
    cards
        .into_iter()
        .map(|c| match c["name"].as_str() {
            Some("orgtree_message") => message.clone(),
            Some("orgtree_send_notice") => notice.clone(),
            _ => c,
        })
        .collect()
}

/// Server-wide eager loading would override rare per-card hints.
#[nolog]
pub fn sdk_server() -> Value { json!({ "type": "sdk", "name": "orgtree" }) }

#[nolog]
fn deferred(name: &str) -> bool {
    matches!(name,
        "orgtree_apps" | "orgtree_files" | "orgtree_fast_defaults" | "orgtree_org_logo" | "orgtree_transfers" | "orgtree_list_orgs" |
        "orgtree_halt" | "orgtree_unhalt" | "orgtree_unstick" | "orgtree_continue_on" |
        "orgtree_account_mark" | "orgtree_withdraw_ask" | "orgtree_project" | "orgtree_read_reply_source" |
        "orgtree_retire" | "orgtree_dissolve" | "orgtree_retool" | "orgtree_switch_model" |
        "orgtree_move" | "orgtree_rename" | "orgtree_reorder" | "orgtree_reallocate" |
        "orgtree_cheap_compact" | "orgtree_compact" | "orgtree_request_credits" | "orgtree_request_scope" |
        "orgtree_swap" | "orgtree_self_subjugate")
}

#[logged]
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let requirements = match name {
        "orgtree_hire" => "Required: name, tier, grant, charter, index; ordinary hire also add_dirs, org_visibility, tools{bash,web,edit,subagents,mcp}. Superior insertion omits scope fields.",
        "orgtree_rehire" => "Required: node. Other fields retain saved values when omitted; index is forbidden; superior insertion omits scope fields.",
        "orgtree_staff" => "Required: create title+objective, update slug; new seat name,tier,grant,charter,index plus ordinary add_dirs,org_visibility,tools{bash,web,edit,subagents,mcp}; restored seat node, no index. Superior insertion omits scope fields.",
        _ => "",
    };
    let description = if requirements.is_empty() { description.to_owned() } else { format!("{description}\n{requirements}") };
    let mut out = json!({
        "name": name,
        "description": format!("{description}\nGuide: orgtree-tool-{}.", name.strip_prefix("orgtree_").unwrap_or(name).replace('_', "-")),
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        // Common cards stay eager; explicit rare cards permit native tool search.
        "_meta": { "anthropic/alwaysLoad": !deferred(name) },
    });
    match name {
        "orgtree_hire" => out["inputSchema"]["allOf"] = json!([hire_scope_schema()]),
        "orgtree_rehire" => out["inputSchema"]["allOf"] = json!([
            {"not":{"required":["index"]}},
            {"if":{"required":["hire_type"],"properties":{"hire_type":{"const":"superior"}}},"then":no_inherited_scope_schema()}
        ]),
        "orgtree_staff" => {
            out["inputSchema"]["allOf"] = json!([
                {"if":{"anyOf":[
                    {"required":["node"]},
                    {"required":["staff_mode"],"properties":{"staff_mode":{"const":"rehire"}}}
                ]},"then":{"required":["node"],"not":{"required":["index"]},"allOf":[
                    {"if":{"required":["hire_type"],"properties":{"hire_type":{"const":"superior"}}},"then":no_inherited_scope_schema()}
                ]},"else":{"required":crate::domain::hire_requirements::BASE,"allOf":[hire_scope_schema()]}},
                {"if":{"anyOf":[
                    {"required":["action"],"properties":{"action":{"const":"create"}}},
                    {"not":{"anyOf":[{"required":["action"]},{"required":["slug"]}]}}
                ]},"then":{"required":["title","objective"]},"else":{"required":["slug"]}}
            ]);
            out["inputSchema"]["properties"]["node"]["minLength"] = json!(1);
        },
        _ => {}
    }
    out
}

#[nolog]
fn no_inherited_scope_schema() -> Value {
    json!({"not":{"anyOf":[{"required":["add_dirs"]},{"required":["tools"]},
        {"required":["org_visibility"]},{"required":["permission_mode"]}]}})
}

#[nolog]
fn hire_scope_schema() -> Value {
    json!({"if":{"required":["hire_type"],"properties":{"hire_type":{"const":"superior"}}},
        "then":no_inherited_scope_schema(),
        "else":{"required":crate::domain::hire_requirements::SCOPE,
            "properties":{"tools":{"required":crate::domain::hire_requirements::TOOLS}}}})
}

const KINDS: &[&str] = &["message", "question"];

/// The message tools take `metadata` (who the message is for and how it is
/// sent), written FIRST, then `body` (user and coordinator 2026-10-13, docket
/// show-agent-typing-in-hubchat-using-ordered-messa: 116/116 real calls kept
/// this order, so the bound is below 2.6%, not zero). The API sends each
/// top-level argument whole once it is complete, so the engine sees
/// `metadata` while the body is still being written and can show Hubchat
/// that the agent is typing (`net::typing`). The handler takes any order
/// and still the flat shape (`tools::mailtools::flat_args`).
const META_FIRST: &str = "Write this FIRST, before body: who the message is for and how it is sent";
const BODY_LAST: &str = "Write this LAST, after metadata: the message text";
const MESSAGE_DESC: &str = "Send mail to superior, descendants, peers or audience grantors; user requires top-level/user audience, outside @org/@net requires org-inbox audience. Peers share a physical parent; OFF or other parents need audiences. Up to 10 recipients; inspect each outcome. Wakes unless notice=true. Replies arrive in later turns; never wait for them. Attachments to local agents are shared as authorized path references; user/@net receive uploaded copies; @org attachments unsupported. Reply references are filtered per conversation.";
const MESSAGE_ORDER: &str = "Always write metadata (`to` and the other fields saying how it is sent) before body: metadata first, \
     body last.";
const NOTICE_DESC: &str = "Store passive mail for the recipient's next turn; wakes nobody. Accepts to, one_time and body; use orgtree_message notice=true for attachments, kind or replies.";
const NOTICE_ORDER: &str = "Always write metadata (`to`) before body: metadata first, body last.";

#[nolog]
fn one_time_schema() -> Value {
    json!({"type":"boolean","description":"One-time; no reply audience. Guide."})
}

#[nolog]
fn reply_identity_schema() -> Value {
    let identity = |kind: &str, field: &str| {
        let mut properties = serde_json::Map::new();
        properties.insert("kind".into(), json!({"type":"string","enum":[kind]}));
        properties.insert("org".into(), json!({"type":"string","minLength":1,"maxLength":200}));
        properties.insert(field.into(), json!({"type":"string","minLength":1,"maxLength":200}));
        json!({"type":"object","additionalProperties":false,"required":["kind","org",field],"properties":properties})
    };
    json!({
        "anyOf":[
            {"type":"string","minLength":1,"maxLength":200,"description":"legacy mail message ID"},
            {"type":"object","oneOf":[
                {"type":"object","additionalProperties":false,"required":["kind","org","id"],"properties":{"kind":{"type":"string","enum":["mail","document","presentation"]},"org":{"type":"string","minLength":1,"maxLength":200},"id":{"type":"string","minLength":1,"maxLength":200}}},
                identity("work_item","slug"),
                {"type":"object","additionalProperties":false,"required":["source_event_ref"],"properties":{"source_event_ref":{"type":"object","additionalProperties":false,"required":["org","agent","generation","eventId"],"properties":{"org":{"type":"string","minLength":1,"maxLength":200},"agent":{"type":"string","minLength":1,"maxLength":200},"generation":{"type":"integer","minimum":1},"eventId":{"type":"string","minLength":1,"maxLength":200}}},"mail_id":{"type":"string","minLength":1,"maxLength":200}}}
            ],"description":"Identity only. Supported forms: {kind: document|presentation, org, id}; {kind: work_item, org, slug}; or {source_event_ref: {org, agent, generation, eventId}, mail_id?}. Mail replies accept legacy message IDs or {kind: mail, org, id}. Do not supply quote text; the engine loads it from the authorized source."}
        ]
    })
}

#[nolog]
fn selection_part_properties() -> serde_json::Map<String, Value> {
    json!({
        "part":{"type":"string","enum":["text","thinking","cmd_out","tool.input","tool.result","tool.error","mail.body","document.body","document.title","work_item.title","work_item.objective","work_item.blocked_reason","work_item.dropped_reason","work_item.done_so_far","work_item.working_on_next","work_item.evidence.note"]},
        "tool_id":{"type":"string","minLength":1,"maxLength":200},
        "pointer":{"type":"string","maxLength":1024,"description":"tool.input/result: RFC6901 pointer; decoded strings, otherwise deterministic pretty JSON"},
        "role":{"type":"string","enum":["value","key"]},
        "entry":{"type":"integer","minimum":0,"maximum":49,"description":"required for a docket list entry; duplicate entries refuse"}
    }).as_object().unwrap().clone()
}

#[nolog]
fn plain_reply_schema() -> Value {
    let identity = |kind: &str, field: &str| {
        let mut properties = serde_json::Map::new();
        properties.insert("kind".into(), json!({"type":"string","enum":[kind]}));
        properties.insert("org".into(), json!({"type":"string","minLength":1,"maxLength":200}));
        properties.insert(field.into(), json!({"type":"string","minLength":1,"maxLength":200}));
        json!({"type":"object","additionalProperties":false,"required":["kind","org",field],"properties":properties})
    };
    json!({
        "anyOf":[
            {"type":"string","minLength":1,"maxLength":200,"description":"legacy mail message ID"},
            {"type":"object","oneOf":[
                {"type":"object","additionalProperties":false,"required":["kind","org","id"],"properties":{"kind":{"type":"string","enum":["document","presentation"]},"org":{"type":"string","minLength":1,"maxLength":200},"id":{"type":"string","minLength":1,"maxLength":200}}},
                identity("work_item","slug"),
                {"type":"object","additionalProperties":false,"required":["source_event_ref"],"properties":{"source_event_ref":{"type":"object","additionalProperties":false,"required":["org","agent","generation","eventId"],"properties":{"org":{"type":"string","minLength":1,"maxLength":200},"agent":{"type":"string","minLength":1,"maxLength":200},"generation":{"type":"integer","minimum":1},"eventId":{"type":"string","minLength":1,"maxLength":200}}},"mail_id":{"type":"string","minLength":1,"maxLength":200}}}
            ],"description":"Identity only. Supported forms: {kind: document|presentation, org, id}; {kind: work_item, org, slug}; or {source_event_ref: {org, agent, generation, eventId}, mail_id?}. Mail replies continue to use legacy message IDs. Do not supply quote text; the engine loads it from the authorized source."}
        ]
    })
}

#[nolog]
fn reply_target_schema() -> Value {
    let mut schema = plain_reply_schema();
    schema["anyOf"].as_array_mut().unwrap().push(json!({
        "type":"object","additionalProperties":false,"required":["target","selection"],
        "properties":{"target":{},"selection":{"type":"object"}},
        "description":"Selection wrapper; read orgtree_read_reply_source and its Guide for the selector contract."
    }));
    schema
}

#[cfg(test)]
mod reply_selection_tool_tests {
    use super::*;
    #[test]
    fn reply_selection_read_send_contract_survives_split_and_flat_shapes() {
        for shape in [MailShape::Split,MailShape::Flat] {
            let [mail,_]=mail_tools(shape);
            let props=if shape==MailShape::Split { &mail["inputSchema"]["properties"]["metadata"]["properties"] } else { &mail["inputSchema"]["properties"] };
            let wrapper=props["reply_to"]["anyOf"].as_array().unwrap().last().unwrap();
            assert_eq!(wrapper["required"],json!(["target","selection"]));
            assert_eq!(wrapper["properties"]["selection"]["type"],json!("object"));
            assert_eq!(props["replies"]["items"]["anyOf"].as_array().unwrap().last().unwrap(),wrapper);
        }
        let source=build_tool_read_reply_source();
        assert_eq!(source["inputSchema"]["required"],json!(["target","part"]));
        assert!(crate::domain::tool_groups::allows(&json!({}),"orgtree_read_reply_source"));
        assert!(!crate::domain::tool_groups::allows(&json!({"orgtree":{"inspection":false}}),"orgtree_read_reply_source"));
    }
}

/// How a harness is given the two mail tools (coordinator 2026-10-13 21:36Z):
/// split, `{metadata, body}`, wherever a no-spend check showed the CLI
/// passes it through (Claude Code, Codex, Muse); flat, the shape from before
/// the split, on Antigravity, whose CLI cannot be checked without the live
/// Google sign-in. It switches to split once a check passes there. The
/// handler takes both (`mailtools::flat_args`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailShape {
    Split,
    Flat,
}

/// orgtree_message's arguments but `body`, in their order: the split cards'
/// `metadata`, the flat cards' top level.
#[logged]
fn message_meta() -> Value {
    let mut props = json!({
        "to": TO.clone(),
        "kind": { "type": "string", "enum": ["message", "question", "request"], "description": "request is displayed as a request and otherwise treated as a message" },
        "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
        "one_time": one_time_schema(),
        "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                         "description": "files to send, relative to your working folder or absolute; local agents receive authorized path references, `user` and `@net:` receive uploaded copies, and `@org:` attachments are unsupported" },
        "urgent": { "type": "boolean", "description": "Requires urgent_reason. User mail keeps its urgent inbox pulse. Agent mail: only while the recipient is currently in DND; bypasses DND, with normal notice/wake rules. Plural sends report refusals per recipient." },
        "urgent_reason": { "type": "string", "description": "one line explaining why this must interrupt now" },
        "reply_to": null,
        "replies": null,
        "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                     "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
        "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
        "tags": { "type":"array", "maxItems":8, "items":{"type":"string","minLength":1,"maxLength":32}, "description":"Optional custom tags, only on mail to the user; up to 8, case-insensitive. Example: alpha build." },
    });
    props["reply_to"] = json!({
        "anyOf": reply_target_schema()["anyOf"].clone(),
        "description": "optional: the single identity this answers; if replies is also supplied, it must equal its first target"
    });
    props["replies"] = json!({
        "type":"array", "items":reply_target_schema(), "minItems":1, "maxItems":50,
        "description":"optional: identities this answers, in order; reply_to, if also supplied, must equal the first. String IDs must be mail you received or sent. Object targets are identity-only; the engine authorizes and resolves them. For multiple recipients, the engine filters each recipient's context to their conversation, including only targets belonging to it."
    });
    props
}

/// orgtree_message and orgtree_send_notice in `shape`.
#[logged]
fn mail_tools(shape: MailShape) -> [Value; 2] {
    match shape {
        MailShape::Split => [
            tool(
                "orgtree_message",
                &format!("{MESSAGE_DESC} {MESSAGE_ORDER}"),
                json!({
                    "metadata": { "type": "object", "description": META_FIRST, "required": ["to"], "properties": message_meta() },
                    "body": { "type": "string", "description": BODY_LAST },
                }),
                &["metadata", "body"],
            ),
            tool(
                "orgtree_send_notice",
                &format!("{NOTICE_DESC} {NOTICE_ORDER}"),
                json!({
                    "metadata": { "type": "object", "description": META_FIRST, "required": ["to"],
                                  "properties": { "to": TO.clone(), "one_time": one_time_schema() } },
                    "body": { "type": "string", "description": BODY_LAST },
                }),
                &["metadata", "body"],
            ),
        ],
        // the cards as they were before the split (rust-engine 536184d), so
        // a seat on this shape keeps its tool prefix
        MailShape::Flat => {
            let mut props = serde_json::Map::new();
            props.insert("to".into(), TO.clone());
            props.insert("body".into(), json!({ "type": "string" }));
            if let Value::Object(meta) = message_meta() {
                props.extend(meta.into_iter().filter(|(k, _)| k != "to"));
            }
            [
                tool("orgtree_message", MESSAGE_DESC, Value::Object(props), &["to", "body"]),
                tool("orgtree_send_notice", NOTICE_DESC, json!({ "to": TO.clone(), "body": { "type": "string" }, "one_time": one_time_schema() }), &["to", "body"]),
            ]
        }
    }
}

/// `to` on orgtree_message / orgtree_send_notice: one recipient or a list.
static TO: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    json!({ "anyOf": [
        { "type": "string" },
        { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10 },
    ], "description": "agent name, 'user', '@org:<slug>' or '@net:<slug>'; or a list of up to 10 of them" })
});

static OPTIONS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    json!({ "type": "array", "maxItems": 4,
            "description": "2-4 answer options; omit for a free-response question",
            "items": { "type": "object", "properties": {
                "label": { "type": "string", "description": "concise choice (1-5 words)" },
                "description": { "type": "string", "description": "what picking it means" } },
                "required": ["label"] } })
});
const VIS: &[&str] = &["self", "team", "subtree", "full"];
const PM: &[&str] = &["default", "acceptEdits", "bypassPermissions"];
/// Every level name a harness exposes (`catalog::EFFORT_ORDER`), and "" to
/// inherit; each tier takes its own harness and model's names (user
/// 2026-10-12), which the staffing options list and the engine checks.
const EFFORT: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max", ""];

/// What `add_dirs` does on each tool: a hire (and staff) sets the starting
/// list, a rehire replaces the list, a retool adds (user ruling 2026-10-10).
const DIRS_HIRE: &str = "folders it may use (within yours)";
const DIRS_REHIRE: &str = "its whole folder list, replacing the one it had (within yours)";
const DIRS_RETOOL: &str = "folders to add, or whose mode to change (within yours); its other folders stay";

#[logged]
fn scope_props(dirs: &str) -> Value {
    json!({
        "add_dirs": { "type": "array", "items": { "type": "object", "properties": {
            "path": { "type": "string" }, "mode": { "type": "string", "enum": ["rw", "ro"] } }, "required": ["path"] },
            "description": dirs },
        "tools": { "type": "object", "properties": {
            "bash": { "type": "boolean" }, "web": { "type": "boolean" }, "edit": { "type": "boolean" },
            "subagents": { "type": "boolean" },
            "orgtree_disabled": { "type": "boolean", "description": "Restore Orgtree-disabled native tools; fresh hire omission=false, rehire/retool omission preserves. Parent-clamped; does not change defaults or other permissions. See orgtree-agent-tools-tab." }, "mcp": { "type": "array", "items": { "type": "string" } },
            "orgtree": crate::domain::tool_groups::schema() } },
        "org_visibility": { "type": "string", "enum": VIS },
        "permission_mode": { "type": "string", "enum": PM },
          "effort": { "type": "string", "enum": EFFORT,
              "description": "a level its tier's own harness and model name (staffing options list them per tier); \"\" inherits" },
          "fast_mode": { "type": "boolean", "description": "next-turn speed; unsupported true refuses. Hire omission uses org tier default; rehire/retool omission keeps saved speed" },
        "account": { "type": "string", "description": "provider account id (default: inherited)" },
        "account_fallback": { "type": "boolean", "description": "move to another account of the same provider when this one hits its usage limit" },
        "clear_account_fallback": { "type": "boolean" },
        "team_charter": { "type": "string", "description": "standing instructions for its whole team" },
    })
}

#[logged]
fn seat_scope_props(dirs: &str) -> Value {
    merge(scope_props(dirs), json!({ "audiences": { "type": "array", "items": { "type": "string" },
        "description": "grant these audiences before kickoff" } }))
}

/// Creation-only preferences: restoration retains its already-saved values.
#[logged]
fn new_hire_scope_props(dirs: &str) -> Value {
    merge(seat_scope_props(dirs), json!({
        "permission_mode": { "type": "string", "enum": ["plan", "default", "acceptEdits", "bypassPermissions"] },
        "model_version": { "type": "string", "description": "New hire only: offered version key; empty uses latest" },
        "session": { "type": ["string", "array"], "items": { "type": "string" }, "minItems": 1,
            "description": "New hire only: Windows session preference; Guide" },
        "peer_mail": { "type": "boolean", "description": "New hire only: allow its direct reports to message each other" },
        "auto_cheap_compact": { "type": "object", "additionalProperties": false, "properties": {
            "enabled": { "type": "boolean" }, "occ": { "type": "number", "minimum": 0.05, "maximum": 0.95 } },
            "description": "New hire only: cold-turn override; empty inherits" }
    }))
}

#[logged]
fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(ao), Some(bo)) = (a.as_object_mut(), b.as_object()) {
        for (k, v) in bo {
            ao.insert(k.clone(), v.clone());
        }
    }
    a
}

// Keep tool literals in separate, non-inlined frames: constructing every card
// in one debug frame overflows the default engine worker stack during admission.
#[logged]
fn all() -> Vec<Value> {
    let [message, notice] = mail_tools(MailShape::Split);
    vec![
        message,
        notice,
        build_tool_apps(),
        build_tool_org_logo(),
        build_tool_status(),
        build_tool_next_turn(),
        build_tool_session(),
        build_tool_transfers(),
        build_tool_inbox(),
        build_tool_chart(),
        build_tool_state_inspect(),
        build_tool_usage(),
        build_tool_list_tiers(),
        build_tool_list_orgs(),
        build_tool_read_transcript(),
        build_tool_read_reply_source(),
        build_tool_files(),
        build_tool_read_scratch(),
        build_tool_interrupt(),
        build_tool_halt(),
        build_tool_unhalt(),
        build_tool_unstick(),
        build_tool_continue_on(),
        build_tool_account_mark(),
        build_tool_ask(),
        build_tool_withdraw_ask(),
        build_tool_present(),
        build_tool_send_file(),
        build_tool_hire(),
        build_tool_fast_defaults(),
        build_tool_project(),
        build_tool_rehire(),
        build_tool_retire(),
        build_tool_dissolve(),
        build_tool_retool(),
        build_tool_switch_model(),
        build_tool_move(),
        build_tool_rename(),
        build_tool_reorder(),
        build_tool_reallocate(),
        build_tool_cheap_compact(),
        build_tool_compact(),
        build_tool_request_credits(),
        build_tool_request_scope(),
        build_tool_audience(),
        build_tool_watchdog(),
        build_tool_work(),
        build_tool_staff(),
        build_tool_swap(),
        build_tool_self_subjugate(),
    ]
}

#[inline(never)]
#[nolog]
fn build_tool_org_logo() -> Value {
    tool(
        "orgtree_org_logo",
        "Set/remove your org's Logo immediately; requires org-modifying tools, no user/inbox audience. Set reads a held local PNG/JPEG/WebP, ≤5 MiB and 16 MP, stored as a square PNG; crop: Guide. Remove restores the letter. Logged and undoable; returns no image bytes.",
        json!({
            "action": {"type":"string", "enum":["set","remove"]},
            "path": {"type":"string", "description":"set: local image file in your folders"},
            "crop": {"type":"object", "additionalProperties":false, "properties":{
                "x":{"type":"number","minimum":0,"maximum":1},
                "y":{"type":"number","minimum":0,"maximum":1},
                "size":{"type":"number","minimum":0.1,"maximum":1}
            }, "required":["x","y","size"]}
        }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_status() -> Value {
    tool(
        "orgtree_status",
        "Report own work status; done does not end turn. Or node+dnd only: self or descendant (descendants need runtime). Idle arms next turn. false clears any setter's hold and triggers native delivery now, without a count cap; size limits remain. Urgent bypasses; turn end clears DND.",
        json!({
            "status": { "type": "string", "enum": ["working", "done", "blocked", "idle"] },
            "summary": { "type": "string", "description": "one or two sentences" },
            "dnd": {"type":"boolean","description":"Hold non-urgent mail; false releases now. Self: running turn; descendant: current or next turn"},
            "node": {"type":"string","description":"DnD target: self or descendant; requires dnd, omits status/summary. Descendants need runtime"},
        }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_next_turn() -> Value {
    tool(
        "orgtree_next_turn",
        "Read your own next-turn prefix/namespace changes and compaction forecast. No writes, provider calls or permission needed. Baselines and thresholds can be unknown; the rest of the turn can change the result. No cache-hit guarantee.",
        json!({}),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_session() -> Value {
    tool(
        "orgtree_session",
        "Read sign-in state and current/next turn placement. Session 0 has no desktop. prefer/use set placement; self interrupt with restart applies it now when allowed. No args only reads.",
        json!({
            "prefer": { "type": "string", "description": "signed-in (default: any of the user's sessions), session0, console, remote, or an ordered list such as \"remote,console\"; Session 0 is always the fallback" },
            "use": { "type": "integer", "description": "a session id from sessions for your next turn only; 0 for Session 0" },
        }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_transfers() -> Value {
    tool(
        "orgtree_transfers",
        "Inspect mail attachment transfers: list pages≤100, get by id. retry resumes failed/cancelled transfers; cancel stops the request and holds mail; remove omits a failed/cancelled outgoing file. Mail releases once every remaining file is ready. Success sends no notice.",
        json!({"action":{"type":"string","enum":["list","get","retry","cancel","remove"]},"id":{"type":"string"},"cursor":{"type":"string"}}),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_inbox() -> Value {
    tool(
        "orgtree_inbox",
        "Own mail: list previews, fetch<=20 IDs, chunk bodies, conversation recall. Fetch/chunk consume; previews do not. Project reads never claim/ack; keep project/folder/status on cursors. Org inbox: extern holders use settings, list org_inbox=true, or pull (consumes org-wide). Mode writes user-only.",
        json!({
            "action": { "type": "string", "enum": ["list", "fetch", "chunk", "conversation", "settings", "pull"] },
            "org_inbox": {"type":"boolean","description":"list only: true previews held outside mail; current extern audience required; previews do not consume"},
            "project": { "type": "string", "description": "list/fetch/chunk: project name; current project reach required on every read" },
            "folder": {"type":"string","enum":["inbox","sent"],"description":"project reads: explicit folder selects full history; omitted list defaults waiting inbox"},
            "status": {"type":"string","enum":["waiting","delivered","claimed","acked","dead-letter"],"description":"project reads: optional queue stage filter; keep folder/status unchanged across cursor pages"},
            "peer": { "type": "string", "description": "conversation: an agent's name, 'user', '@org:<slug>' or '@net:<address>'" },
            "limit": { "type": "integer", "description": "list: how many (default 50, max 200); conversation: default 20, max 100" },
            "message_ids": { "type": "array", "items": { "type": "string" }, "description": "fetch: 1 to 20 IDs from list or conversation" },
            "cursor": { "type": "string", "description": "list or conversation: next_cursor from the preceding page" },
            "delivery_id": { "type": "string", "description": "chunk: delivery_id returned with this fetched message" },
            "message_id": { "type": "string", "description": "chunk: the message ID" },
            "chunk_index": { "type": "integer", "minimum": 0, "description": "chunk: zero-based index" },
        }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_chart() -> Value {
    tool(
        "orgtree_chart",
        "Read the org within your visibility: tiers, credits, status, age and effective audiences with project sources. include_archived reveals retired agents; check them before hiring because rehire restores context.",
        json!({
            "include_archived": { "type": "boolean" },
            "include_standing_charter": { "type": "boolean", "description": "include team charters (default true)" },
        }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_state_inspect() -> Value {
    tool(
        "orgtree_state_inspect",
        "Inspect visible agents' structured folders, tools, permission mode and effective/explicit/inherited audiences with project sources, optionally archived. Excludes prompts, transcripts and mail.",
        json!({
            "node": { "type": "string" },
            "nodes": { "type": "array", "items": { "type": "string" } },
            "include_archived": { "type": "boolean" },
        }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_usage() -> Value {
    tool(
        "orgtree_usage",
        "Read cached provider usage with exact account/provider/window filters; missing/stale stays explicit. refresh floors 60s (Google 300) and provider cooldowns apply. No inference/account switch. Windows/account≤64; truncation explicit.",
        json!({
            "accounts":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32},
            "providers":{"type":"array","items":{"type":"string","enum":["claude","openai","google","muse","openrouter","langserver"]},"minItems":1,"maxItems":32},
            "windows":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32},
            "refresh":{"type":"boolean","description":"default false; exactly one explicit active account, runtime permission required"},
            "limit":{"type":"integer","minimum":1,"maximum":100,"description":"account page size, default 20"},
            "cursor":{"type":"string","description":"next_cursor from a previous cached account page"}
        }), &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_list_tiers() -> Value {
    tool("orgtree_list_tiers", "List tiers/prices; refresh rechecks logins (runtime).", json!({
        "refresh":{"type":"boolean","description":"default false; coalesced provider discovery, runtime required"}
    }), &[])
}

#[inline(never)]
#[nolog]
fn build_tool_list_orgs() -> Value {
    tool("orgtree_list_orgs", "List other local organizations (@org mail) and this org's connected hub peers (@net mail).", json!({}), &[])
}

#[inline(never)]
#[nolog]
fn build_tool_read_transcript() -> Value {
    tool(
        "orgtree_read_transcript",
        "Read recent conversation rows, supplied thinking and sealed markers for yourself or an agent below you. helpers lists observed helper agents; helper reads one retained helper transcript.",
        json!({
            "node": { "type": "string" },
            "last": { "type": "integer", "minimum": 1, "maximum": 80, "description": "how many recent rows (default 30)" },
            "helpers": {"type":"boolean","description":"true lists bounded live/recent helper identities and details; no native execution"},
            "helper": {"type":"object","additionalProperties":false,"required":["seq","tool"],"properties":{"seq":{"type":"integer","minimum":1},"tool":{"type":"string"}},"description":"read one listed helper's retained transcript; mutually exclusive with helpers"},
        }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_read_reply_source() -> Value {
    tool("orgtree_read_reply_source",
        "Read canonical reply-source parts (max4096 UTF-8 bytes/window). Inspection required: own mail, settled self/downward transcripts, readable tickets, authored/reachable project Markdown only. No consume/viewed effects. Continue with returned SHA256; changed digests refuse.",
        json!({"target":reply_identity_schema(),
            "part":{"type":"object","additionalProperties":false,"required":["part"],"properties":selection_part_properties()},
            "offset":{"type":"integer","minimum":0,"description":"Unicode-scalar offset, default 0"},
            "expected_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$","description":"required at nonzero offset; returned by the first source window"}}),
        &["target","part"])
}

#[inline(never)]
#[nolog]
fn build_tool_read_scratch() -> Value {
    tool(
        "orgtree_read_scratch",
        "Browse/read your own or a descendant's working folder. Omit path to list it.",
        json!({ "node": { "type": "string" }, "path": { "type": "string" } }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_interrupt() -> Value {
    tool(
        "orgtree_interrupt",
        "Interrupt yourself, or a descendant with runtime permission. restart wakes one turn by placement rules. queued: Claude/AGY held hooks; Codex/Muse/ACP completion notices may cut the next step off early. Background work blocks queued/restart. Inspect interrupt status.",
        json!({
            "node": { "type": "string" },
            "restart": { "type": "boolean", "description": "start one next turn after this turn settles" },
            "queued": { "type": "boolean", "description": "wait for a completion boundary before interrupting this turn" },
        }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_halt() -> Value {
    tool(
        "orgtree_halt",
        "Halt descendant agents until unhalt: stop processes, keep waiting mail and suppress wakes.",
        json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_unhalt() -> Value {
    tool(
        "orgtree_unhalt",
        "Unhalt descendant agents; waiting mail may start their next turn.",
        json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_unstick() -> Value {
    tool(
        "orgtree_unstick",
        "Release a descendant agent's usage freeze and let it continue.",
        json!({ "node": { "type": "string" } }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_continue_on() -> Value {
    tool(
        "orgtree_continue_on",
        "Switch a frozen descendant agent to a same-provider account and release its freeze.",
        json!({ "node": { "type": "string" }, "account": { "type": "string" } }),
        &["node", "account"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_account_mark() -> Value {
    tool(
        "orgtree_account_mark",
        "Inspect capacity marks or clear one using its exact expected values. A changed/missing mark writes nothing. Clearing is audited, adds no capacity and resumes nobody; frozen_here still needs unstick. Only org-visible accounts.",
        json!({
            "action": { "type": "string", "enum": ["inspect", "clear"] },
            "account": { "type": "string", "description": "inspect: account id or name. clear: the exact `account` of the mark entry" },
            "source": { "type": "string", "enum": ["registry", "legacy-roster"], "description": "clear: the mark entry's `source`" },
            "pool": { "type": "string", "description": "clear: the mark entry's `pool`" },
            "expected": { "type": "object", "description": "clear: the mark entry's `expected`" },
            "companion_expected": { "type": "object", "description": "clear, optional: the `companion.expected` of a pooled entry" },
            "reason": { "type": "string", "description": "clear, required: why, kept in the audit (500 max)" },
        }),
        &["action", "account"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_ask() -> Value {
    // ---- arriving with build step 5
    tool(
        "orgtree_ask",
        "Ask up to 4 user questions with2-4 options or free text. One open request; later calls add/amend tabs. End your turn; answers arrive as mail. Without user audience/top-level authority, routes to your superior. Withdraw moot questions.",
        json!({
            "question": { "type": "string", "description": "the complete question (or use `questions`)" },
            "header": { "type": "string", "description": "very short label chip (max ~12 chars)" },
            "options": OPTIONS.clone(),
            "multi": { "type": "boolean", "description": "several options may be selected" },
            "work_item": { "type": "string", "description": "docket item slug this is about" },
            "questions": { "type": "array", "minItems": 1, "maxItems": 4,
                           "description": "1-4 questions as one tabbed card; overrides the single form",
                           "items": { "type": "object", "properties": {
                               "question": { "type": "string" }, "header": { "type": "string" },
                               "options": OPTIONS.clone(), "multi": { "type": "boolean" },
                               "work_item": { "type": "string" } }, "required": ["question"] } },
        }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_withdraw_ask() -> Value {
    tool("orgtree_withdraw_ask", "Withdraw your open question card.", json!({}), &[])
}

/// orgtree_present's optional slug (user 2026-10-27 mdcb7ce9a8103, "Add the
/// field"; mea228250b31e, "encourage agents to use an english name for the slug").
const PRESENT_SLUG: &str = "New presentations only (refused with replaces): a short English id such as weekly-status. Pass one whenever the title isn't in English. Omitted: made from the title.";

#[inline(never)]
#[nolog]
fn build_tool_present() -> Value {
    tool(
        "orgtree_present",
        "Present documents the user should READ (reports, plans, Markdown). project places it under a reachable project; members (nested included) need no user audience for their own project. Otherwise requires user audience/top-level authority. body or .md path≤64KiB; self-contained HTML path≤4MiB, sandboxed without network. replaces updates a card. Otherwise send to your superior.",
        json!({ "title": { "type": "string" }, "body": { "type": "string" }, "path": { "type": "string" },
                "replaces": { "type": "string" },
                "slug": { "type": "string", "description": PRESENT_SLUG },
                "project": { "type": "string", "description": "a project's name: present under that project" } }),
        &["title"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_send_file() -> Value {
    tool(
        "orgtree_send_file",
        "Deliver a wanted FILE (installer, log, export, image, archive), with relative paths from your working folder. Documents to READ, including Markdown, use orgtree_present. Reuse delivery_id for the same delivery after a lost response.",
        json!({ "path": { "type": "string" }, "note": { "type": "string" },
            "delivery_id": { "type": "string", "description": "Reuse for the same delivery after a lost response; new ID for a new delivery" } }),
        &["path"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_files() -> Value {
    tool("orgtree_files", "List retained download cards from yourself or a descendant, newest first.",
        json!({"node":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100},"before":{"type":"string"}}), &[])
}

#[cfg(test)]
mod files_tab_tests {
    #[test]
    fn listing_card_is_deferred_scoped_and_small() {
        let card = super::build_tool_files();
        assert_eq!(card["_meta"]["anthropic/alwaysLoad"],false);
        assert!(crate::domain::tool_groups::allows(&serde_json::json!({}),"orgtree_files"));
        assert!(!crate::domain::tool_groups::allows(&serde_json::json!({"orgtree":{"inspection":false}}),"orgtree_files"));
        let bytes = serde_json::to_vec(&card).unwrap().len();
        eprintln!("FILES_CARD_BYTES {bytes}");
        assert!(bytes < 600);
    }
}

#[inline(never)]
#[nolog]
fn build_tool_hire() -> Value {
    tool(
        "orgtree_hire",
        "Hire within your team or insert a superior. index: zero-based live siblings 0..count, excluding insertion target. Seat+grant must fit; self-parent spends your free credits, external budget fixed. Insertion inherits scope. kickoff sends first mail.",
        merge(
            json!({
                "name": { "type": "string" }, "tier": { "type": "string" }, "grant": { "type": "integer" },
                "charter": { "type": "string" }, "parent": { "type": "string" }, "target": { "type": "string" },
                "hire_type": { "type": "string", "enum": ["subordinate", "superior"] },
                "index": { "type": "integer", "minimum": 0, "description": "required zero-based live sibling insertion position" },
                "kickoff": { "type": "string", "description": "first message to send it" },
                "harness": { "type": "string", "enum": ["claude-code", "codex-cli", "opencode"],
                             "description": "OpenRouter tiers only: pins this seat to the harness; omitted, it follows its key's harness" },
                "kickoff_kind": { "type": "string", "enum": KINDS }, "work_item": { "type": "string" },
            }),
            new_hire_scope_props(DIRS_HIRE),
        ),
        &["name", "tier", "grant", "charter", "index"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_project() -> Value {
    let mut project = tool(
        "orgtree_project",
        "Read/use projects above/below; only ancestors/user change settings/name/order or purge. create needs name/index, parent defaults you; above wraps node; initial settings atomic (name/description top-level). settings reads; configure atomic. Broadcast checks recipient authority; purge unclaimed only. Claim via slot watchdog; slots lists holders/line; release_slot releases yours. Ancestors force/unqueue.",
        json!({
            "action": { "type": "string", "enum": ["create","describe","settings","configure","slots","release_slot","unqueue_slot","purge_waiting","dead_letters","retry_dead_letter","drop_dead_letter","broadcast","fire_event","listeners","presentations","read_presentation"] },
            "id": {"type":"string","description":"dead_letters: read this dead letter in full; retry_dead_letter/drop_dead_letter: its mail id"},
            "reason": {"type":"string","description":"drop_dead_letter: why the job is dropped"},
            "include_dropped": {"type":"boolean","description":"dead_letters: list dropped letters too"},
            "lease": { "type": "string", "description": "release_slot: the lease your concurrency slot grant named" },
            "note": { "type": "string", "description": "release_slot: optional, e.g. build ok 265s" },
            "settings": {"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"description":{"type":"string"},"peer_mail":{"type":"boolean"},"mail_queue":{"type":"string","enum":["round_robin","ack"]},"exclude_sender":{"type":"boolean"},"ack_timeout":{"type":"boolean"},"max_attempts":{"type":"integer","minimum":1,"maximum":100},"ack_reminders":{"type":"integer","minimum":1,"maximum":10},"turn_end_reminder":{"type":"boolean"},"slots":{"type":"integer","minimum":0,"maximum":9999999},"event_listeners":{"type":"boolean"}}},
            "force": {"type":"boolean","description":"release_slot: any project ancestor may force release"},
            "agent": {"type":"string","description":"unqueue_slot: agent to remove from line"},
            "team": {"type":"boolean","description":"presentations/read_presentation: include the project subtree"},
            "document": {"type":"string","description":"read_presentation: document id"},
            "chunk_index": {"type":"integer","minimum":0,"description":"read_presentation: body chunk (default0); follow documents[].next_chunk_index with the same name/document/team"},
            "body_revision": {"type":"string","description":"read_presentation: required after chunk0; return its body_revision unchanged, restart at0 if replaced"},
            "limit": {"type":"integer","minimum":1,"maximum":100},
            "offset": {"type":"integer","minimum":0},
            "body": {"type":"string","description":"broadcast: message to live agent children through nested projects, stopping at each agent; fire_event: optional message carried to its event listeners"},
            "attachments": {"type":"array","items":{"type":"string"},"maxItems":10},
            "notice": {"type":"boolean"},
            "urgent": {"type":"boolean","description":"broadcast: requires urgent_reason; each agent recipient must currently be in DND"},
            "urgent_reason": {"type":"string","description":"broadcast: one line explaining why this must interrupt now"},
            "reply_to": {"type":"string","description":"broadcast: mail id you received or sent; filtered to its authorized conversation"},
            "replies": {"type":"array","items":{"type":"string"},"maxItems":50,"description":"broadcast: mail ids you received or sent; reply_to if supplied must match the first; each recipient gets only references from its conversation"},
            "name": { "type": "string" }, "parent": { "type": "string" },
            "above": {"type":"string","description":"create: atomically wrap this node, inheriting its position; canonical insertion authority and top-level restrictions apply"},
            "index": { "type": "integer", "minimum": 0, "description": "required zero-based live sibling insertion position unless above is supplied" },
            "description": { "type": "string", "description": "what the project is: shown on its card and to its agents" },
        }),
        &["action"],
    );
    project["inputSchema"]["properties"]["reply_to"] = json!({"anyOf":reply_target_schema()["anyOf"].clone(),"description":"broadcast: first reply target"});
    project["inputSchema"]["properties"]["replies"] = json!({"type":"array","items":reply_target_schema(),"minItems":1,"maxItems":50,"description":"broadcast: ordered reply targets"});
    project
}

#[inline(never)]
#[nolog]
fn build_tool_rehire() -> Value {
    tool(
        "orgtree_rehire",
        "Restore a retired agent/project; target/hire_type set placement. Projects keep policy, cost no seat and reject model/scope/grant overrides. kickoff sends first mail. Credit/authority limits apply.",
        merge(
            json!({ "node": { "type": "string" }, "grant": { "type": "integer" }, "target": { "type": "string" },
                    "hire_type": { "type": "string", "enum": ["subordinate", "superior"] }, "name": { "type": "string" },
                    "charter": { "type": "string" }, "kickoff": { "type": "string" },
                    "kickoff_kind": { "type": "string", "enum": KINDS }, "work_item": { "type": "string" } }),
            seat_scope_props(DIRS_REHIRE),
        ),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_retire() -> Value {
    tool("orgtree_retire", "Retire an agent below you; it can be rehired with its context.", json!({ "node": { "type": "string" } }), &["node"])
}

#[inline(never)]
#[nolog]
fn build_tool_dissolve() -> Value {
    tool("orgtree_dissolve", "Retire an agent below you and its whole team.", json!({ "node": { "type": "string" } }), &["node"])
}

#[inline(never)]
#[nolog]
fn build_tool_retool() -> Value {
    tool(
        "orgtree_retool",
        "Change a descendant's supplied scope/charter fields. Folder additions preserve others; removing/restricting folders also restricts descendants. Unspecified fields stay unchanged.",
        merge(json!({ "node": { "type": "string" }, "charter": { "type": "string" },
                      "remove_dirs": { "type": "array", "items": { "type": "string" },
                                       "description": "folders it holds to remove" } }),
              scope_props(DIRS_RETOOL)),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_switch_model() -> Value {
    tool(
        "orgtree_switch_model",
        "Move an agent below you to another tier at its next turn boundary.",
        json!({ "node": { "type": "string" }, "tier": { "type": "string" } }),
        &["node", "tier"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_move() -> Value {
    tool(
        "orgtree_move",
        "Move descendants within your subtree. Use node/new_parent or moves[{node,new_parent}]; a batch is all-or-nothing.",
        json!({ "node": { "type": "string" }, "new_parent": { "type": "string" },
                "moves": { "type": "array", "items": { "type": "object" },
                           "description": "several {node, new_parent} moves as one all-or-nothing act" } }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_rename() -> Value {
    tool("orgtree_rename", "Rename an agent below you.", json!({ "node": { "type": "string" }, "name": { "type": "string" } }), &["node", "name"])
}

#[inline(never)]
#[nolog]
fn build_tool_reorder() -> Value {
    tool(
        "orgtree_reorder",
        "Move a live descendant to a zero-based final sibling index (remove first, then 0..remaining_count). Parent/scope/credits unchanged; self, superior, peers and unrelated agents refused. state_inspect returns sibling counts.",
        json!({ "node": { "type": "string" }, "index": { "type": "integer", "minimum": 0 } }),
        &["node", "index"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_reallocate() -> Value {
    tool(
        "orgtree_reallocate",
        "Adjust a report's credits: positive delta grants; negative takes unused credits back.",
        json!({ "node": { "type": "string" }, "delta": { "type": "integer" } }),
        &["node", "delta"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_cheap_compact() -> Value {
    tool("orgtree_cheap_compact", "Restart a descendant agent on a fresh session with a summary handoff.", json!({ "node": { "type": "string" } }), &["node"])
}

#[inline(never)]
#[nolog]
fn build_tool_compact() -> Value {
    tool("orgtree_compact", "Check native compaction or request it for one agent below you. Team required; no self/bulk/cheap fallback. Returns node/supported/started/reason; started means admitted, never finished. Capability is read-only; agent calls grant no user contact.", json!({
        "node": { "type": "string" },
        "action": { "type": "string", "enum": ["capability", "compact"], "default": "compact" }
    }), &["node"])
}

#[inline(never)]
#[nolog]
fn build_tool_request_credits() -> Value {
    tool(
        "orgtree_request_credits",
        "Ask the user for a larger TOTAL grant with a reason.",
        json!({ "new_limit": { "type": "integer" }, "reason": { "type": "string" } }),
        &["new_limit", "reason"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_request_scope() -> Value {
    tool(
        "orgtree_request_scope",
        "Request more folders, tools or permissions (1-8 items) with a reason. A request grants nothing until approved.",
        json!({ "items": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "type": "object", "properties": {
                    "kind": { "type": "string", "enum": ["dir", "tool", "mcp", "permission_mode"] },
                    "path": { "type": "string", "description": "dir: the absolute folder path" },
                    "mode": { "type": "string", "description": "dir: ro|rw; permission_mode: the mode" },
                    "tool": { "type": "string", "enum": ["bash", "web", "edit", "subagents", "orgtree.docket", "orgtree.team", "orgtree.messaging", "orgtree.inspection", "orgtree.watchdogs", "orgtree.runtime", "orgtree.user", "orgtree.orgmod", "orgtree.logo"] },
                    "server": { "type": "string", "description": "mcp: the server name" } }, "required": ["kind"] } },
                "reason": { "type": "string" } }),
        &["items", "reason"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_audience() -> Value {
    tool(
        "orgtree_audience",
        "Manage directional audiences; requests grant nothing. Project grants reach direct live members, never nested; reverse needs its own grant. User contact does not add personal access while inherited; manual Acquire can. Project decisions go to nearest agent superior (user if none). External/org-inbox remains agent-only. Read guide for grant authority.",
        json!({ "action": { "type": "string", "enum": ["request", "grant", "deny", "revoke"] },
                "target": { "type": "string", "description": "request: agent/project/user/extern sought; grant/revoke: agent/project grantor when not you" },
                "from": { "type": "string", "description": "grant: agent/project receiving it; request: project you manage; deny: the requester" },
                "grantee": { "type": "string", "description": "revoke: agent/project holding it" },
                "reason": { "type": "string" } }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_watchdog() -> Value {
    tool(
        "orgtree_watchdog",
        "Proactively await builds, files, processes, mail/events or usage thresholds; never poll/sleep-wait. Uncapped/paged. create kind/target (usage default), command regex. command/stream smoke-run as you (cmd.exe or shell=bash). Ready once command/process/usage/slot/fair_queue: inline effects/actions; else register. usage cached, no probes. slot grants lease; other kinds/fire_actions: Guide. mqtt/websocket send needs live connection (MQTT topic).",
        json!({
            "action": { "type": "string", "enum": ["create", "list", "pause", "resume", "remove", "send", "configure"] },
            "cursor": {"type":"string","description":"list: next_cursor from the preceding page"},
            "limit": {"type":"integer","minimum":1,"maximum":100,"description":"list: page size (default 50, max 100)"},
            "name": { "type": "string", "description": "create: a short name, e.g. build-watch; its slug becomes the dog's id" },
            "kind": { "type": "string", "enum": ["file", "command", "process", "stream", "activity", "event", "usage", "fair_queue", "slot", "project_listener", "listener_watch", "app_listener", "mqtt", "websocket"] },
            "event_name":{"type":"string","description":"app_listener: exact declared event name; a panel fires its own events only while Orgtree is open, tray included"},
            "panel":{"type":"string","description":"app_listener: one saved panel ID; mutually exclusive with all_panels"},
            "all_panels":{"type":"boolean","description":"app_listener: explicitly listen to all current and future panels of this app"},
            "batch": { "type": "integer", "minimum": 1, "maximum": 20, "description": "fair_queue only: up to this many mails per wake; ACK capacity too. Default 1." },
            "slots": { "type": "integer", "minimum": 1, "maximum": 9999999, "description": "slot only: reserve this many slots together as one lease, in strict FIFO. Default 1; at most project capacity." },
            "credentials": { "anyOf": [
                { "type": "string" },
                { "type": "object", "properties": { "username": { "type": "string" }, "password": { "type": "string" }, "client_id": { "type": "string" },
                                                    "headers": { "type": "object" }, "bearer": { "type": "string" }, "query": { "type": "object" }, "hello": { "type": "array" } } }
              ], "description": "mqtt/websocket: a credentials file path in your folders (re-read on each connect), or inline: mqtt {username, password, client_id}; websocket {headers, bearer, username, password, query, hello}. Stored encrypted, never shown" },
            "hello": { "type": "array", "maxItems": 16, "items": { "anyOf": [{ "type": "string" }, { "type": "object" }, { "type": "array" }] },
                       "description": "websocket: messages sent in order after every (re)connect; a JSON value goes as compact JSON" },
            "protocols": { "type": "array", "maxItems": 8, "items": { "type": "string" }, "description": "websocket: Sec-WebSocket-Protocol subprotocols to offer" },
            "connection_messages": { "type":"string", "enum":["notice","wake","off"], "description":"mqtt/websocket health mail; default notice, configure without reconnect" },
            "notify_on_connect": { "type": "boolean", "description": "Compatibility alias: true=notice, false=off; conflicts refused" },
            "heartbeat": { "type": "object", "properties": { "message": { "anyOf": [{ "type": "string" }, { "type": "object" }] }, "every_s": { "type": "integer", "minimum": 5 } },
                           "required": ["message", "every_s"], "description": "websocket: a fixed message sent every every_s seconds while connected" },
            "message": { "anyOf": [{ "type": "string" }, { "type": "object" }, { "type": "array" }, { "type": "number" }, { "type": "boolean" }, { "type": "null" }],
                         "description": "send: text or compact JSON on this websocket/MQTT dog's own live connection; at most 64 KB" },
            "payload": { "description": "MQTT send: alias for message; any JSON value, compactly encoded; message takes precedence" },
            "topic": { "type": "string", "description": "MQTT send: required publish topic, nonempty, no + or # wildcards" },
            "qos": { "type": "integer", "minimum": 0, "maximum": 2, "description": "MQTT send: QoS 0 (default), 1 or 2; existing rumqttc supports all three" },
            "retain": { "type": "boolean", "description": "MQTT send: broker retains this value, default false; empty retained payload clears it. Distinct from retained (receive filter)." },
            "payload_pattern": { "type": "string", "description": "mqtt only: regex the payload text must match" },
            "retained": { "type": "boolean", "description": "mqtt only: also fire on retained messages (default false)" },
            "count": {"type":"integer","minimum":1,"maximum":1024,"description":"listener_watch only: armed project listeners that fire it"},
            "fire_actions": {"type":"array","maxItems":4,"items":{"type":"object","properties":{"tool":{"type":"string"},"args":{"type":"object"}},"required":["tool"]},"description":"create: orgtree_* tool calls run as you when it fires, results inline or in fire mail; authority rechecked at fire time; not for fair_queue"},
            "accounts": {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32,"description":"usage only: exact visible account ids; omitted = any"},
            "windows": {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32,"description":"usage only: exact kind, group or display label; omitted = any"},
            "usage_events": {"type":"array","items":{"type":"string","enum":["above","below","reset","limit","stale","unreadable","recovered","account_added","account_removed","refused","frozen"]},"minItems":1,"maxItems":32,"description":"usage only: omitted = all levels/edges (above/below need threshold_percent)"},
            "threshold_percent": {"type":"number","minimum":0,"maximum":100,"description":"usage only: percentage for above/below crossings; above means >=, below means <. Spend caps use the same percentage."},
            "fire_mode": { "type": "string", "enum": ["event", "silence"], "description": "create: on event (default), or after silence" },
            "threshold": {"type":"string","description":"event counts only: below N or at least N; fires only on false-to-true crossing, never repeatedly while satisfied"},
            "event_scope": {"type":"string","enum":["subtree","org"],"description":"count targets only: visible descendants (default), or org (requires full visibility); excludes the watcher"},
            "quiet_period_s": { "type": "integer", "minimum": 1, "description": "create, silence only: seconds without a matching event" },
            "target": { "type": "string", "description": "the path, command line, pid:N / port:N, (activity) agent name, (fair_queue, slot, project_listener, listener_watch) project name, (event) dotted event name/prefix ending in .*, (mqtt, needs your web tool) mqtt://host[:port] / mqtts://host[:port], or (websocket, needs your web tool) ws:// or wss:// URL" },
            "pattern": { "type": "string", "description": "regex an event line must match (required for command; optional for file/stream/activity = any line); (mqtt, required) the topic filter, + and # wildcards; (websocket) regex on text messages, optional = every message" },
            "interval_s": { "type": "integer", "minimum": 5, "description": "poll cadence (floor 15s); stream/activity/mqtt/websocket: the minimum gap between fires (floor 5s)" },
            "notice": { "type": "boolean", "description": "create: fire passively — the mail waits without starting a turn" },
            "once": { "type": "boolean", "description": "create: ONE-SHOT — fires once and removes itself" },
            "shell": { "type": "string", "enum": ["native", "bash"], "description": "create, command/stream only" },
            "id": { "type": "string", "description": "pause/resume/remove/send/configure: the watchdog's id as `list` shows it (owner/id for a team member's dog)" },
            "reason": { "type": "string", "description": "remove: why (optional)" },
        }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_work() -> Value {
    tool(
        "orgtree_work",
        "Docket by slug; read Guide first. Objective: problem/solution then scope. Updates claim ownership unless owner=current holder; supply lists or keep/append. Add participants before assignment/review. Blocked/dropped need reasons. Review=agents; ask(work_item)=user questions. Delete permanent/restricted; prefer archive/drop.",
        json!({
            "action": { "type": "string", "enum": ["list", "get", "create", "update", "accept", "assign", "handoff",
                                                  "participants", "evidence", "archive", "supersede", "move", "delete"] },
            "slug": { "type": "string", "description": "the item's readable name (every action but list/create)" },
            "include_archived": { "type": "boolean" }, "include_backlogged": { "type": "boolean" },
            "projection": { "type": "string", "enum": ["summary", "compact", "full"],
                            "description": "list/get: summary (list default), compact (get default), full" },
            "fields": { "type": "array", "items": { "type": "string" }, "description": "list/get: return only these fields" },
            "title": { "type": "string", "description": "create/update: short concrete title (max 200)" },
            "objective": { "type": "string", "description": "create (REQUIRED) / update: the description and scope" },
            "objective_append": { "type": "string", "description": "update: text added to the end of the description" },
            "kind": { "type": "string", "description": "create: code|non-code · evidence: note|link|file|commit|log" },
            "owner": { "type": "string", "description": "create/assign: the owner (you or a subordinate) · update: the CURRENT owner, to leave it with them" },
            "reviewer": { "type": "string", "description": "update: the agent that checks the work at review (never the owner)" },
            "status": { "type": "string", "description": "backlogged|open|in_progress|blocked|review|approved|deploy_ready|done|dropped" },
            "blocked_reason": { "type": "string", "description": "REQUIRED to enter blocked (max 2000)" },
            "dropped_reason": { "type": "string", "description": "REQUIRED to end as dropped (max 1500)" },
            "attention": { "type": "boolean", "description": "update: true raises the flag (needs attention_reason); false takes yours down" },
            "attention_reason": { "type": "string", "description": "the concrete thing the user must see (max 1500)" },
            "attention_amend": { "type": "boolean", "description": "update: edit the standing flag's reason without re-raising it" },
            "reopen": { "type": "boolean", "description": "update: resume a closed or archived item (with the new status)" },
            "done_so_far": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 40, "description": "what is complete, one entry each (max 500 chars, 40 entries)" },
            "working_on_next": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 40, "description": "current and next steps, one entry each" },
            "keep_done": { "type": "boolean" }, "keep_next": { "type": "boolean" },
            "done_append": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 40, "description": "update: add to the stored list (max 500 chars each)" },
            "next_append": { "type": "array", "items": { "type": "string", "maxLength": 500 }, "maxItems": 40, "description": "update: add to the stored list (max 500 chars each)" },
            "expected_rev": { "type": "integer", "description": "update: refuse if a field you replace changed since this rev" },
            "participants": { "type": "array", "items": { "type": "string" }, "description": "create: collaborators" },
            "add": { "type": "array", "items": { "type": "string" }, "description": "participants: agents to add" },
            "remove": { "type": "array", "items": { "type": "string" }, "description": "participants: agents to drop" },
            "dependencies": { "type": "array", "items": { "type": "string" }, "description": "create: items this one depends on" },
            "parent": { "type": "string", "description": "create/move: the parent item (move with no parent un-nests)" },
            "by": { "type": "string", "description": "supersede: the item that replaces this one" },
            "target": { "type": "string", "description": "handoff: who should take it (default your superior)" },
            "reason": { "type": "string", "description": "handoff: why" },
            "ref": { "type": "string", "description": "evidence: path/url/sha/log (max 500)" },
            "note": { "type": "string", "description": "evidence / accept: free text" },
            "items": { "type": "array", "items": { "type": "object" }, "description": "evidence: a batch of {kind, ref, note}" },
        }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_staff() -> Value {
    tool(
        "orgtree_staff",
        "Create/update a docket item and hire/rehire its owner atomically; assignment mail starts work. Live agent: use work assign. Requires docket+team permissions; credit/scope limits match hire/rehire. Omitted progress keeps stored lists. Read guide before assigning.",
        merge(
            json!({ "action": { "type": "string", "enum": ["create", "update"] }, "slug": { "type": "string" },
                    "title": { "type": "string" }, "objective": { "type": "string" },
                    "staff_mode": { "type": "string", "enum": ["hire", "rehire"] }, "node": { "type": "string" },
                    "name": { "type": "string" }, "tier": { "type": "string" }, "grant": { "type": "integer" },
                    "charter": { "type": "string" }, "kickoff": { "type": "string" },
                    "kind": { "type": "string", "enum": ["code", "non-code"] },
                    "status": { "type": "string" }, "blocked_reason": { "type": "string" },
                    "attention": { "type": "boolean" }, "attention_reason": { "type": "string" },
                    "attention_amend": { "type": "boolean" }, "reopen": { "type": "boolean" },
                    "done_so_far": { "type": "array", "items": { "type": "string" } },
                    "working_on_next": { "type": "array", "items": { "type": "string" } },
                    "participants": { "type": "array", "items": { "type": "string" } },
                    "dependencies": { "type": "array", "items": { "type": "string" } },
                    "parent": { "type": "string", "description": "parent WORK ITEM" },
                    "target": { "type": "string", "description": "seat destination" },
                    "hire_type": { "type": "string", "enum": ["subordinate", "superior"] },
                    "index": { "type": "integer", "minimum": 0, "description": "REQUIRED for a new hire: zero-based live sibling insertion position (superior insertion excludes target); rehire retains existing placement" },
                    "harness": { "type": "string", "enum": ["claude-code", "codex-cli", "opencode"],
                                 "description": "OpenRouter tiers only: pins this seat to the harness; omitted, it follows its key's harness" },
                    "kickoff_kind": { "type": "string", "enum": KINDS } }),
            new_hire_scope_props(DIRS_HIRE),
        ),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_swap() -> Value {
    tool("orgtree_swap", "Swap the seats of two agents below you.", json!({ "a": { "type": "string" }, "b": { "type": "string" } }), &["a", "b"])
}

#[inline(never)]
#[nolog]
fn build_tool_self_subjugate() -> Value {
    tool(
        "orgtree_self_subjugate",
        "Promote a live descendant node into your position; it keeps its team, you move beneath with yours. Projects keep policy, cost no seat and preserve agent reporting. External allocation stays fixed.",
        json!({ "target": { "type": "string" } }),
        &["target"],
    )
}

#[cfg(test)]
mod project_settings_contract_tests {
    use super::*;
    fn card() -> Value { list().into_iter().find(|c| c["name"] == "orgtree_project").unwrap() }

    #[test]
    fn ack_reminder_count_contract() {
        let c=card();let p=&c["inputSchema"]["properties"]["settings"]["properties"]["ack_reminders"];
        assert_eq!(p["type"],json!("integer"),"ack reminders tool field missing");
        assert_eq!(p["minimum"],json!(1));assert_eq!(p["maximum"],json!(10));
    }

    #[test]
    fn project_can_read_and_configure_settings() {
        let c=card();
        let actions=c["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        for action in ["settings","configure","purge_waiting","broadcast","presentations","read_presentation"] { assert!(actions.contains(&json!(action)),"missing project action {action}"); }
    }
    #[test]
    fn project_exposes_every_desktop_setting_with_typed_patch_fields() {
        let c=card();
        let settings=&c["inputSchema"]["properties"]["settings"];
        assert_eq!(settings["type"],json!("object"),"settings patch must be an object");
        for (name,kind) in [("name","string"),("description","string"),("peer_mail","boolean"),
            ("mail_queue","string"),("exclude_sender","boolean"),("ack_timeout","boolean"),
            ("max_attempts","integer"),("ack_reminders","integer"),("turn_end_reminder","boolean"),("slots","integer"),
            ("event_listeners","boolean")] {
            assert_eq!(settings["properties"][name]["type"],json!(kind),"setting {name}");
        }
        assert_eq!(settings["additionalProperties"],json!(false));
    }
    #[test]
    fn existing_slot_release_stays_available() {
        let c=card();
        assert!(c["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap().contains(&json!("release_slot")));
        assert_eq!(c["inputSchema"]["properties"]["lease"]["type"],json!("string"));
    }
    #[test]
    fn project_ancestors_can_request_force_release_and_remove_from_line() {
        let c=card();
        let p=&c["inputSchema"]["properties"];
        assert_eq!(p["force"]["type"],json!("boolean"));
        assert_eq!(p["agent"]["type"],json!("string"));
        assert!(p["action"]["enum"].as_array().unwrap().contains(&json!("unqueue_slot")));
    }
}

#[cfg(test)]
mod hire_contract_tests {
    use super::*;

    #[test]
    fn hire_contract_cards_emit_validation_schemas() {
        let cards: Vec<_> = list().into_iter().filter(|c| matches!(c["name"].as_str(),Some("orgtree_hire"|"orgtree_rehire"|"orgtree_staff"))).collect();
        assert_eq!(cards.len(),3);
        println!("HIRE_SCHEMAS {}",serde_json::to_string(&cards).unwrap());
    }
}

#[cfg(test)]
mod dnd_tests {
    use super::*;
    #[test]
    fn status_exposes_turn_local_do_not_disturb() {
        let card=list().into_iter().find(|c| c["name"]=="orgtree_status").unwrap();
        assert_eq!(card["inputSchema"]["properties"]["dnd"]["type"],"boolean","status needs DND control");
        assert_eq!(card["inputSchema"]["properties"]["node"]["type"],"string");
        assert_eq!(card["inputSchema"]["required"],json!([]),"node+dnd does not report status");
    }
    #[test]
    fn every_midturn_delivery_checks_dnd_before_harness_work() {
        let source=include_str!("../runtime/actor.rs");
        for name in ["steer_codex","steer_agy","on_hook"] {
            let body=source.split(&format!("async fn {name}(")).nth(1).unwrap().split("RETURNING id, to_jsonb(ot.mail.*)").next().unwrap();
            assert!(body.contains("ot.agent_dnd"),"{name} must hold ordinary mail before steering or interrupt");
        }
    }
    #[test]
    fn status_still_available_with_all_groups_off() {
        let off=json!({"orgtree":crate::domain::tool_groups::GROUPS.iter().map(|g|((*g).to_string(),json!(false))).collect::<serde_json::Map<_,_>>()});
        assert!(crate::domain::tool_groups::allows(&off,"orgtree_status"));
    }
}

#[cfg(test)]
mod slot_release_scope_tests {
    use super::*;

    fn check(team: bool, watchdogs: bool) {
        let scope=json!({"orgtree":{"team":team,"watchdogs":watchdogs}});
        let card=scoped(&scope).into_iter().find(|c| c["name"]=="orgtree_project");
        for action in ["release_slot","slots","dead_letters","retry_dead_letter","drop_dead_letter","fire_event","listeners"] {
            assert_eq!(crate::domain::tool_groups::allows_call(&scope,"orgtree_project",&json!({"action":action})),
                team||watchdogs,"{action} needs either team or watchdogs");
        }
        for action in ["create","describe","settings","configure","unqueue_slot","purge_waiting","broadcast","presentations","read_presentation",""] {
            assert_eq!(crate::domain::tool_groups::allows_call(&scope,"orgtree_project",&json!({"action":action})),team,"admin action {action}");
        }
        assert_eq!(crate::domain::tool_groups::allows_call(&scope,"orgtree_project",&json!({"action":"release_slot","force":true})),team,"force needs team");
        assert_eq!(card.is_some(),team||watchdogs,"project card needs either group");
        if let Some(card)=card {
            let actions=card["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
            assert!(actions.contains(&json!("release_slot")) && actions.contains(&json!("slots")));
            if team { assert!(actions.contains(&json!("configure"))); }
            else {
                assert_eq!(actions,&vec![json!("slots"),json!("release_slot"),json!("dead_letters"),json!("retry_dead_letter"),json!("drop_dead_letter"),json!("fire_event"),json!("listeners")]);
                let keys=card["inputSchema"]["properties"].as_object().unwrap();
                assert!(keys.keys().all(|k| ["action","name","lease","note","id","reason","include_dropped","limit","offset","body"].contains(&k.as_str())));
                assert!(card["description"].as_str().unwrap().contains("orgtree-tool-project"));
            }
        }
    }

    #[test] fn both_on() { check(true,true); }
    #[test] fn team_only() { check(true,false); }
    #[test] fn watchdogs_only() { check(false,true); }
    #[test] fn both_off() { check(false,false); }
}

#[cfg(test)]
mod startup_card_tests {
    use super::*;

    #[test]
    fn credit_request_card_defines_total_grant_and_reason() {
        assert_eq!(build_tool_request_credits()["description"],
            "Ask the user for a larger TOTAL grant with a reason.\nGuide: orgtree-tool-request-credits.");
    }

    /// User 2026-10-27 mea228250b31e ("encourage agents to use an english name
    /// for the slug") and mdcb7ce9a8103 ("Add the field"): an optional slug
    /// for a new card, asked for in English when the title isn't.
    #[test]
    fn present_card_takes_an_optional_english_slug_for_new_cards() {
        let card = build_tool_present();
        let slug = &card["inputSchema"]["properties"]["slug"];
        assert_eq!(slug["type"], "string", "slug parameter");
        let hint = slug["description"].as_str().unwrap_or_default();
        for needed in ["English", "title", "replaces"] {
            assert!(hint.contains(needed), "slug description lacks {needed}: {hint}");
        }
        assert_eq!(card["inputSchema"]["required"], json!(["title"]), "slug stays optional");
    }

    #[test]
    fn startup_card_measurements() {
        if let Some(file) = std::env::var_os("ORGTREE_TOOL_CARDS_FILE") {
            std::fs::write(file,serde_json::to_vec(&json!({
                "split":scoped_as(&json!({}),MailShape::Split),
                "flat":scoped_as(&json!({}),MailShape::Flat)
            })).unwrap()).unwrap();
        }
        let off = json!({"orgtree": crate::domain::tool_groups::GROUPS.iter().map(|g| ((*g).to_owned(), json!(false))).collect::<serde_json::Map<_,_>>()});
        for (lane, shape) in [("claude",MailShape::Split),("codex",MailShape::Split),
            ("antigravity",MailShape::Flat),("muse",MailShape::Split),("opencode",MailShape::Split)] {
            for (profile, scope) in [("all-groups",json!({})),("all-groups-off",off.clone())] {
                let cards = scoped_as(&scope,shape);
                let bytes = serde_json::to_vec(&cards).unwrap().len();
                let eager: Vec<_> = cards.iter().filter(|c| c["_meta"]["anthropic/alwaysLoad"] == true).collect();
                let descriptions: usize = cards.iter().map(|c| c["description"].as_str().unwrap().len()).sum();
                println!("TOOL_STARTUP {}",json!({"lane":lane,"profile":profile,"cards":cards.len(),"schema_bytes":bytes,
                    "description_bytes":descriptions,"tokens_est":bytes.div_ceil(2),"eager_cards":eager.len(),
                    "eligible_eager_bytes":serde_json::to_vec(&eager).unwrap().len(),
                    "token_method":"inferred bytes/2; canonical MCP JSON, native wrappers/external tools excluded; eager hint savings require client support"}));
            }
        }
    }

    #[test]
    fn startup_card_descriptions_fit_caps_and_point_to_real_guides() {
        let manifest: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../../docs/skills/tree.json"))).unwrap();
        for shape in [MailShape::Split,MailShape::Flat] {
            let cards = scoped_as(&json!({}),shape);
            let mut total = 0;
            for card in cards {
                let name = card["name"].as_str().unwrap();
                let guide = format!("orgtree-tool-{}",name.strip_prefix("orgtree_").unwrap().replace('_',"-"));
                assert!(manifest["nodes"].as_array().unwrap().iter().any(|n| n["name"] == guide),"missing guide {guide}");
                let description = card["description"].as_str().unwrap();
                assert!(description.contains(&guide),"{name}: missing guide pointer");
                assert!(description.len() <= 900,"{name}: {} bytes",description.len());
                total += description.len();
            }
            assert!(total <= 12000,"description total {total}");
        }
    }

    #[test]
    fn startup_watchdog_guides_proactive_waits_and_keeps_hiring_eager() {
        for shape in [MailShape::Split, MailShape::Flat] {
            let cards = scoped_as(&json!({}), shape);
            let dog = cards.iter().find(|c| c["name"] == "orgtree_watchdog").unwrap();
            let description = dog["description"].as_str().unwrap();
            for guidance in ["Proactively await", "builds", "files", "processes", "mail/events", "usage thresholds", "never poll/sleep-wait"] {
                assert!(description.contains(guidance), "missing upfront guidance: {guidance}");
            }
            for name in ["orgtree_watchdog", "orgtree_staff", "orgtree_hire", "orgtree_rehire"] {
                assert_eq!(cards.iter().find(|c| c["name"] == name).unwrap()["_meta"]["anthropic/alwaysLoad"], true, "eager {name}");
            }
        }
    }

    #[test]
    fn startup_card_rare_hints_preserve_scope_and_common_tools() {
        assert_eq!(sdk_server(), json!({"type":"sdk","name":"orgtree"}), "no server override of per-card load policy");
        let off = json!({"orgtree": crate::domain::tool_groups::GROUPS.iter().map(|g| ((*g).to_owned(), json!(false))).collect::<serde_json::Map<_,_>>()});
        assert_eq!(scoped(&off).len(),4,"scope must still omit denied groups");
        let cards = scoped(&json!({}));
        for name in ["orgtree_message","orgtree_status","orgtree_work","orgtree_inbox","orgtree_next_turn","orgtree_session"] {
            assert_eq!(cards.iter().find(|c| c["name"] == name).unwrap()["_meta"]["anthropic/alwaysLoad"],true,"common {name}");
        }
        for name in ["orgtree_org_logo","orgtree_transfers","orgtree_account_mark","orgtree_swap","orgtree_self_subjugate"] {
            assert_eq!(cards.iter().find(|c| c["name"] == name).unwrap()["_meta"]["anthropic/alwaysLoad"],false,"rare {name}");
        }
    }
}

#[cfg(test)]
mod typed_reply_target_contract_tests {
    use super::*;

    fn accepts_string_and_object(schema: &Value) -> bool {
        schema["anyOf"].as_array().is_some_and(|choices| {
            choices.iter().any(|choice| choice["type"] == "string")
                && choices.iter().any(|choice| choice["type"] == "object")
        })
    }

    fn assert_reply_shape(props: &Value, owner: &str) {
        assert!(accepts_string_and_object(&props["reply_to"]), "{owner}.reply_to must accept legacy mail IDs and typed targets");
        assert!(accepts_string_and_object(&props["replies"]["items"]), "{owner}.replies must accept legacy mail IDs and typed targets");
        let targets = &props["reply_to"]["anyOf"];
        let Some(object) = targets.as_array().and_then(|a| a.iter().find(|v| v["type"] == "object")) else {
            panic!("{owner}.reply_to lacks an object target schema");
        };
        let variants = object["oneOf"].as_array().expect("typed target variants");
        assert!(variants.iter().any(|v| v["properties"]["kind"]["enum"].as_array().is_some_and(|k| k.contains(&json!("document")) && k.contains(&json!("presentation")))), "{owner} must document document and presentation targets");
        assert!(variants.iter().any(|v| v["properties"]["kind"]["enum"] == json!(["work_item"])), "{owner} must document docket-item targets");
        assert!(variants.iter().any(|v| v["properties"]["source_event_ref"].is_object()), "{owner} must document transcript-event targets");
        assert!(variants.iter().all(|v| v["additionalProperties"] == false), "{owner} typed targets must be identity-only objects");
    }

    #[test]
    fn message_reply_fields_accept_legacy_ids_and_typed_targets_for_both_harness_shapes() {
        for shape in [MailShape::Flat, MailShape::Split] {
            let [message, _] = mail_tools(shape);
            let props = if shape == MailShape::Flat {
                &message["inputSchema"]["properties"]
            } else {
                &message["inputSchema"]["properties"]["metadata"]["properties"]
            };
            assert_reply_shape(props, "orgtree_message");
        }
    }

    #[test]
    fn project_broadcast_uses_the_same_typed_reply_target_contract() {
        let project = build_tool_project();
        assert_reply_shape(&project["inputSchema"]["properties"], "orgtree_project.broadcast");
    }
}

#[cfg(test)]
mod mail_shape_tests {
    use super::*;

    /// Antigravity keeps the flat mail-tool shape introduced before the split;
    /// this snapshot guards the flat schema and current mail contract.
    #[test]
    fn the_flat_cards_keep_the_flat_shape_and_current_mail_contract() {
        let to = json!({ "anyOf": [
            { "type": "string" },
            { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10 },
        ], "description": "agent name, 'user', '@org:<slug>' or '@net:<slug>'; or a list of up to 10 of them" });
        let mut message = json!({
            "name": "orgtree_message",
            "description": format!("{MESSAGE_DESC}\nGuide: orgtree-tool-message."),
            "inputSchema": { "type": "object", "properties": {
                "to": to.clone(),
                "body": { "type": "string" },
                "kind": { "type": "string", "enum": ["message", "question", "request"], "description": "request is displayed as a request and otherwise treated as a message" },
                "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
                "one_time": {"type":"boolean","description":"One-time; no reply audience. Guide."},
                "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                                 "description": "files to send, relative to your working folder or absolute; local agents receive authorized path references, `user` and `@net:` receive uploaded copies, and `@org:` attachments are unsupported" },
                "urgent": { "type": "boolean", "description": "Requires urgent_reason. User mail keeps its urgent inbox pulse. Agent mail: only while the recipient is currently in DND; bypasses DND, with normal notice/wake rules. Plural sends report refusals per recipient." },
                "urgent_reason": { "type": "string", "description": "one line explaining why this must interrupt now" },
                "reply_to": { "type": "string", "description": "optional: the id of the message you are answering (the id that ends its FROM line; orgtree_inbox lists them). The recipient sees it quoted; over the mail hub (@net:) the reply also carries a link to it. With several recipients, each gets the quote only if it belongs to that conversation." },
                "replies": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 50, "description": "optional: all message ids this one answers, in order; reply_to, if also supplied, must match the first. Every id must be mail you received or sent. With several recipients, each gets only references belonging to its conversation." },
                "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                             "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
                "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
                "tags": { "type":"array", "maxItems":8, "items":{"type":"string","minLength":1,"maxLength":32}, "description":"Optional custom tags, only on mail to the user; up to 8, case-insensitive. Example: alpha build." },
            }, "required": ["to", "body"] },
            "_meta": { "anthropic/alwaysLoad": true },
        });
        let meta = message_meta();
        message["inputSchema"]["properties"]["reply_to"] = meta["reply_to"].clone();
        message["inputSchema"]["properties"]["replies"] = meta["replies"].clone();
        let notice = json!({
            "name": "orgtree_send_notice",
            "description": format!("{NOTICE_DESC}\nGuide: orgtree-tool-send-notice."),
            "inputSchema": { "type": "object", "properties": { "to": to, "body": { "type": "string" }, "one_time": {"type":"boolean","description":"One-time; no reply audience. Guide."} }, "required": ["to", "body"] },
            "_meta": { "anthropic/alwaysLoad": true },
        });
        let [m, n] = mail_tools(MailShape::Flat);
        // serialized, so the key order counts too (serde_json keeps insertion order)
        assert_eq!(m.to_string(), message.to_string());
        assert_eq!(n.to_string(), notice.to_string());
    }

    /// The split cards carry exactly the flat cards' fields, in the same order
    /// and with the same schemas, metadata first and the order spelled out.
    #[test]
    fn the_split_cards_hold_every_flat_field_in_metadata() {
        let [fm, fnote] = mail_tools(MailShape::Flat);
        let [sm, snote] = mail_tools(MailShape::Split);
        for (flat, split) in [(&fm, &sm), (&fnote, &snote)] {
            let fp = flat["inputSchema"]["properties"].as_object().unwrap();
            let sp = split["inputSchema"]["properties"].as_object().unwrap();
            assert_eq!(sp.keys().collect::<Vec<_>>(), ["metadata", "body"]);
            assert_eq!(split["inputSchema"]["required"], json!(["metadata", "body"]));
            let meta = sp["metadata"]["properties"].as_object().unwrap();
            let flat_meta: Vec<(&String, &Value)> = fp.iter().filter(|(k, _)| *k != "body").collect();
            assert_eq!(meta.iter().collect::<Vec<_>>(), flat_meta);
            assert_eq!(sp["metadata"]["required"], json!(["to"]));
            let guide = format!("\nGuide: orgtree-tool-{}.", flat["name"].as_str().unwrap().strip_prefix("orgtree_").unwrap().replace('_', "-"));
            let desc = split["description"].as_str().unwrap().strip_suffix(&guide).expect("split guide pointer");
            let flat_desc = flat["description"].as_str().unwrap().strip_suffix(&guide).expect("flat guide pointer");
            assert!(desc.starts_with(flat_desc) && desc.ends_with("metadata first, body last."), "{desc}");
        }
        assert_eq!(fm["inputSchema"]["properties"]["kind"]["enum"], json!(["message", "question", "request"]));
        assert!(fm["description"].as_str().unwrap().contains("Attachments to local agents are shared as authorized path references"));
        assert!(fm["inputSchema"]["properties"]["replies"]["description"].as_str().unwrap().contains("filters each recipient's context to their conversation"));
    }

    /// Only the two mail cards change with the shape; every agent but an
    /// Antigravity seat gets the split ones.
    #[test]
    fn a_flat_scope_swaps_only_the_mail_cards() {
        let all_on = json!({});
        let split = scoped_as(&all_on, MailShape::Split);
        let flat = scoped_as(&all_on, MailShape::Flat);
        assert_eq!(split, scoped(&all_on));
        assert_eq!(split.len(), flat.len());
        for (s, f) in split.iter().zip(&flat) {
            assert_eq!(s["name"], f["name"]);
            let mail = matches!(s["name"].as_str(), Some("orgtree_message" | "orgtree_send_notice"));
            assert_eq!(s == f, !mail, "{}", s["name"]);
        }
        // a scope without messaging has no mail cards to swap
        let quiet = json!({ "orgtree": { "messaging": false } });
        assert_eq!(scoped_as(&quiet, MailShape::Flat), scoped(&quiet));
    }
}

#[cfg(test)]
mod effort_enum_tests {
    /// The tools offer every level a harness names, and "" (inherit).
    #[test]
    fn effort_enum_is_every_harness_name() {
        let mut want: Vec<&str> = crate::providers::catalog::EFFORT_ORDER.to_vec();
        want.push("");
        assert_eq!(super::EFFORT, want.as_slice());
    }
}

#[inline(never)]
#[nolog]
fn build_tool_fast_defaults() -> Value {
    tool("orgtree_fast_defaults", "Read per-tier fast-mode defaults for new hires (including Quick chat). set patches tiers and is restricted to top-level agents whose superior is the user. Supported tiers only; explicit hire fast_mode wins. Existing agents and rehires keep saved speed.",
        json!({"action":{"type":"string","enum":["read","set"]},
            "tiers":{"type":"object","additionalProperties":{"type":"boolean"},"maxProperties":64,"description":"set: tier-to-boolean patch, e.g. sol=true, luna=true"}}), &[])
}

#[cfg(test)]
mod fast_tools_tests {
    #[test]
    fn native_tools_four_scope_shapes_expose_optional_opt_in() {
        for name in ["orgtree_hire","orgtree_rehire","orgtree_staff","orgtree_retool"] {
            let card=super::list().into_iter().find(|c|c["name"]==name).unwrap();
            assert_eq!(card["inputSchema"]["properties"]["tools"]["properties"]["orgtree_disabled"]["type"],"boolean","{name}");
        }
    }

    #[test]
    fn fast_tools_defaults_card_is_implemented_and_team_gated() {
        let cards=super::list();
        assert!(cards.iter().any(|c| c["name"]=="orgtree_fast_defaults"));
        assert!(!crate::domain::tool_groups::allows(&serde_json::json!({"orgtree":{"team":false}}),"orgtree_fast_defaults"));
    }
    #[test]
    fn fast_tools_four_seat_cards_expose_boolean() {
        let cards=super::all();
        for name in ["orgtree_hire","orgtree_rehire","orgtree_staff","orgtree_retool"] {
            let card=cards.iter().find(|c|c["name"]==name).unwrap();
            assert_eq!(card["inputSchema"]["properties"]["fast_mode"]["type"],"boolean","{name}");
        }
    }
}

#[cfg(test)]
mod builder_stack_tests {
    use serde_json::{json,Value};
    /// Keep the pre-split card bytes/order, except the explicitly approved
    /// own-project presentation permission description (user 2026-10-18).
    #[test]
    fn reply_selection_all_tool_json_matches_pre_split_snapshot() {
        let mut expected: serde_json::Value = serde_json::from_slice(include_bytes!("../../testdata/tool-cards-c89111b.json")).unwrap();
        // User 2026-10-20: TOTAL moved from inline instructions to this card.
        let credit = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_request_credits").unwrap();
        credit["description"] = serde_json::json!("Ask the user for a larger TOTAL grant with a reason.\nGuide: orgtree-tool-request-credits.");
        let present = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_present").unwrap();
        present["description"] = serde_json::json!(concat!(
            "Present documents the user should READ (reports, plans, Markdown). project places it under a reachable project; members (nested included) need no user audience for their own project. Otherwise requires user audience/top-level authority. body or .md path≤64KiB; self-contained HTML path≤4MiB, sandboxed without network. replaces updates a card. Otherwise send to your superior.",
            "\nGuide: orgtree-tool-present."
        ));
        // an optional English slug for a new card, after replaces (user
        // 2026-10-27 mdcb7ce9a8103); the bytes compare in key order
        let mut properties = serde_json::Map::new();
        for (key, value) in present["inputSchema"]["properties"].as_object().unwrap().clone() {
            let replaces = key == "replaces";
            properties.insert(key, value);
            if replaces {
                properties.insert("slug".into(), serde_json::json!({"type":"string","description":"New presentations only (refused with replaces): a short English id such as weekly-status. Pass one whenever the title isn't in English. Omitted: made from the title."}));
            }
        }
        present["inputSchema"]["properties"] = Value::Object(properties);
        // project slots (user 2026-10-18 08:37Z-08:42Z, docket
        // project-slots-first-come-permits-claimed-through): orgtree_project
        // lists and releases slots, and orgtree_watchdog has the slot kind
        let project = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_project").unwrap();
        let actual: Vec<serde_json::Value> = serde_json::from_slice(&serde_json::to_vec(&super::all()).unwrap()).unwrap();
        let actual_project = actual.iter().find(|card| card["name"] == "orgtree_project").unwrap().clone();
        assert!(actual_project["description"].as_str().unwrap().contains("Claim via slot watchdog; slots lists holders/line; release_slot releases yours."));
        project["description"] = actual_project["description"].clone();
        let schema = &mut project["inputSchema"];
        schema["properties"]["action"]["enum"] = serde_json::json!(["create","describe","settings","configure","slots","release_slot","unqueue_slot","purge_waiting","dead_letters","retry_dead_letter","drop_dead_letter","broadcast","fire_event","listeners","presentations","read_presentation"]);
        schema["properties"]["id"] = serde_json::json!({"type":"string","description":"dead_letters: read this dead letter in full; retry_dead_letter/drop_dead_letter: its mail id"});
        schema["properties"]["reason"] = serde_json::json!({"type":"string","description":"drop_dead_letter: why the job is dropped"});
        schema["properties"]["include_dropped"] = serde_json::json!({"type":"boolean","description":"dead_letters: list dropped letters too"});
        schema["properties"]["settings"] = serde_json::json!({"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"description":{"type":"string"},"peer_mail":{"type":"boolean"},"mail_queue":{"type":"string","enum":["round_robin","ack"]},"exclude_sender":{"type":"boolean"},"ack_timeout":{"type":"boolean"},"max_attempts":{"type":"integer","minimum":1,"maximum":100},"ack_reminders":{"type":"integer","minimum":1,"maximum":10},"turn_end_reminder":{"type":"boolean"},"slots":{"type":"integer","minimum":0,"maximum":9999999},"event_listeners":{"type":"boolean"}}});
        schema["properties"]["force"] = serde_json::json!({"type":"boolean","description":"release_slot: any project ancestor may force release"});
        schema["properties"]["agent"] = serde_json::json!({"type":"string","description":"unqueue_slot: agent to remove from line"});
        schema["properties"]["team"] = serde_json::json!({"type":"boolean","description":"presentations/read_presentation: include the project subtree"});
        schema["properties"]["document"] = serde_json::json!({"type":"string","description":"read_presentation: document id"});
        schema["properties"]["limit"] = serde_json::json!({"type":"integer","minimum":1,"maximum":100});
        schema["properties"]["offset"] = serde_json::json!({"type":"integer","minimum":0});
        schema["properties"]["body"] = serde_json::json!({"type":"string","description":"broadcast: message to every live agent under the project; fire_event: optional message carried to its event listeners"});
        schema["properties"]["attachments"] = serde_json::json!({"type":"array","items":{"type":"string"},"maxItems":10});
        schema["properties"]["notice"] = serde_json::json!({"type":"boolean"});
        schema["properties"]["lease"] = serde_json::json!({ "type": "string", "description": "release_slot: the lease your concurrency slot grant named" });
        schema["properties"]["note"] = serde_json::json!({ "type": "string", "description": "release_slot: optional, e.g. build ok 265s" });
        schema["required"] = serde_json::json!(["action"]);
        let dog = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_watchdog").unwrap();
        dog["description"] = serde_json::json!(dog["description"].as_str().unwrap().replace(
            "fair_queue delivers project mail to one watcher.", "fair_queue delivers project mail to one watcher; slot (one-shot) claims a project concurrency slot, firing when granted."));
        dog["description"] = serde_json::json!(dog["description"].as_str().unwrap()
            .replace("Create requires kind/target;", "Create requires kind/target (usage defaults target=usage);")
            .replace("Event/count/silence semantics", "usage watches cached account/window edges with accounts/windows/usage_events filters and threshold_percent; unknown is never zero, and staying above never repeats. Event/count/silence semantics"));
        let dschema = &mut dog["inputSchema"];
        dschema["properties"]["cursor"] = serde_json::json!({"type":"string","description":"list: next_cursor from the preceding page"});
        dschema["properties"]["limit"] = serde_json::json!({"type":"integer","minimum":1,"maximum":100,"description":"list: page size (default 50, max 100)"});
        dschema["properties"]["batch"] = serde_json::json!({"type":"integer","minimum":1,"maximum":20,"description":"fair_queue only: up to this many mails per wake; ACK capacity too. Default 1."});
        dschema["properties"]["slots"] = serde_json::json!({"type":"integer","minimum":1,"maximum":9999999,"description":"slot only: reserve this many slots together as one lease, in strict FIFO. Default 1; at most project capacity."});
        dschema["properties"]["kind"]["enum"] = serde_json::json!(["file", "command", "process", "stream", "activity", "event", "usage", "fair_queue", "slot", "project_listener", "listener_watch"]);
        dschema["properties"]["count"] = serde_json::json!({"type":"integer","minimum":1,"maximum":1024,"description":"listener_watch only: armed project listeners that fire it"});
        dschema["properties"]["fire_actions"] = serde_json::json!({"type":"array","maxItems":4,"items":{"type":"object","properties":{"tool":{"type":"string"},"args":{"type":"object"}},"required":["tool"]},"description":"create: orgtree_* tool calls run as you when it fires, results inline or in fire mail; authority rechecked at fire time; not for fair_queue"});
        dschema["properties"]["accounts"] = serde_json::json!({"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32,"description":"usage only: exact visible account ids; omitted = any"});
        dschema["properties"]["windows"] = serde_json::json!({"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32,"description":"usage only: exact kind, group or display label; omitted = any"});
        dschema["properties"]["usage_events"] = serde_json::json!({"type":"array","items":{"type":"string","enum":["above","below","reset","limit","stale","unreadable","recovered","account_added","account_removed","refused","frozen"]},"minItems":1,"maxItems":32,"description":"usage only: omitted = all levels/edges (above/below need threshold_percent)"});
        dschema["properties"]["threshold_percent"] = serde_json::json!({"type":"number","minimum":0,"maximum":100,"description":"usage only: percentage for above/below crossings; above means >=, below means <. Spend caps use the same percentage."});
        dschema["properties"]["target"]["description"] = serde_json::json!(dschema["properties"]["target"]["description"].as_str().unwrap()
            .replace("(fair_queue) project name", "(fair_queue, slot, project_listener, listener_watch) project name"));
        // mqtt watchdogs (user 2026-10-19 17:40:50Z; docket native-mqtt-watchdog-
        // fire-on-a-topic-pattern-fro): the kind, its three fields, and the
        // target/pattern wording for a broker and a topic filter
        dschema["properties"]["kind"]["enum"].as_array_mut().unwrap().push(serde_json::json!("mqtt"));
        let actual_dog: serde_json::Value = serde_json::from_slice(&serde_json::to_vec(&super::all()).unwrap()).unwrap();
        let actual_dog = actual_dog.as_array().unwrap().iter().find(|c| c["name"] == "orgtree_watchdog").unwrap().clone();
        for key in ["credentials", "payload_pattern", "retained"] {
            dschema["properties"][key] = actual_dog["inputSchema"]["properties"][key].clone();
        }
        assert!(dschema["properties"]["credentials"]["anyOf"].is_array(), "credentials is a file path or an inline object");
        dschema["properties"]["target"]["description"] = serde_json::json!(dschema["properties"]["target"]["description"].as_str().unwrap()
            .replace(", or (event) dotted event name/prefix ending in .*",
                     ", (event) dotted event name/prefix ending in .*, or (mqtt, needs your web tool) mqtt://host[:port] / mqtts://host[:port]"));
        dschema["properties"]["pattern"]["description"] = serde_json::json!(format!("{}; (mqtt, required) the topic filter, + and # wildcards",
            dschema["properties"]["pattern"]["description"].as_str().unwrap()));
        // websocket watchdogs (user 2026-10-19 21:00Z/21:01:59Z; docket
        // native-websocket-watchdog-plus-a-tool-to-send-on): the kind, the send
        // action, their fields, and the target/pattern/interval/id wording
        dschema["properties"]["kind"]["enum"].as_array_mut().unwrap().push(serde_json::json!("websocket"));
        dschema["properties"]["action"]["enum"].as_array_mut().unwrap().push(serde_json::json!("send"));
        dschema["properties"]["action"]["enum"].as_array_mut().unwrap().push(serde_json::json!("configure"));
        for key in ["hello", "protocols", "heartbeat", "message", "payload", "topic", "qos", "retain"] {
            dschema["properties"][key] = actual_dog["inputSchema"]["properties"][key].clone();
        }
        dschema["properties"]["connection_messages"] = actual_dog["inputSchema"]["properties"]["connection_messages"].clone();
        dschema["properties"]["notify_on_connect"] = serde_json::json!({"type":"boolean","description":"Compatibility alias: true=notice, false=off; conflicts refused"});
        dschema["properties"]["target"]["description"] = serde_json::json!(dschema["properties"]["target"]["description"].as_str().unwrap()
            .replace(", or (mqtt, needs your web tool) mqtt://host[:port] / mqtts://host[:port]",
                     ", (mqtt, needs your web tool) mqtt://host[:port] / mqtts://host[:port], or (websocket, needs your web tool) ws:// or wss:// URL"));
        dschema["properties"]["pattern"]["description"] = serde_json::json!(format!("{}; (websocket) regex on text messages, optional = every message",
            dschema["properties"]["pattern"]["description"].as_str().unwrap()));
        dschema["properties"]["interval_s"]["description"] = serde_json::json!(dschema["properties"]["interval_s"]["description"].as_str().unwrap()
            .replace("stream/activity:", "stream/activity/mqtt/websocket:"));
        dschema["properties"]["id"]["description"] = serde_json::json!(dschema["properties"]["id"]["description"].as_str().unwrap()
            .replace("pause/resume/remove:", "pause/resume/remove/send/configure:"));
        // app event watchdogs (4.5.0 custom apps, 7ec8edb 2026-10-26; the
        // event_name clause is user 2026-10-27, a175058, worded m281f01b7bf36): the kind, before
        // mqtt, and its three fields
        let kinds = dschema["properties"]["kind"]["enum"].as_array_mut().unwrap();
        let at = kinds.iter().position(|k| k == "mqtt").unwrap();
        kinds.insert(at, serde_json::json!("app_listener"));
        dschema["properties"]["event_name"] = serde_json::json!({"type":"string","description":"app_listener: exact declared event name; a panel fires its own events only while Orgtree is open, tray included"});
        dschema["properties"]["panel"] = serde_json::json!({"type":"string","description":"app_listener: one saved panel ID; mutually exclusive with all_panels"});
        dschema["properties"]["all_panels"] = serde_json::json!({"type":"boolean","description":"app_listener: explicitly listen to all current and future panels of this app"});
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_audience").unwrap();
        card["description"] = serde_json::json!("Manage directional audiences: agent/project endpoints, request target (optional from=managed project), grant from, deny requester, revoke grantee. Projects pass their explicit grants to live direct members as their own; no nested relay. An audience with a project also reaches its direct agents; reverse access needs a reverse grant. User project mail/broadcast grants only the project; members inherit without personal grants. Direct contact adds no user grant while effective access exists; manual Acquire audience can. Project decisions belong to their nearest agent superior (user if none). External/org-inbox access remains agent-only. Requests do not grant access.\nGuide: orgtree-tool-audience.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_chart").unwrap();
        card["description"] = serde_json::json!("Read the org within your visibility: tiers, credits, status, age and effective audiences with project sources. include_archived reveals retired agents; check them before hiring because rehire restores context. Team charters default on.\nGuide: orgtree-tool-chart.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_state_inspect").unwrap();
        card["description"] = serde_json::json!("Inspect visible agents' structured folders, tools, permission mode and effective/explicit/inherited audiences with project sources, optionally archived. Excludes prompts, transcripts and mail.\nGuide: orgtree-tool-state-inspect.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_audience").unwrap();
        card["inputSchema"]["properties"]["target"]["description"] = serde_json::json!("request: agent/project/user/extern sought; grant/revoke: agent/project grantor when not you");
        card["inputSchema"]["properties"]["from"]["description"] = serde_json::json!("grant: agent/project receiving it; request: project you manage; deny: the requester");
        card["inputSchema"]["properties"]["grantee"]["description"] = serde_json::json!("revoke: agent/project holding it");
        // Approved DND contract changes: the status control and manual-read
        // exception, plus the existing urgent pair extended to DND agents.
        for name in ["orgtree_status","orgtree_inbox"] {
            let want=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]==name).unwrap();
            let got=actual.iter().find(|c|c["name"]==name).unwrap();
            want["description"]=got["description"].clone();
            if name=="orgtree_status" {
                want["inputSchema"]["properties"]["dnd"]=serde_json::json!({"type":"boolean","description":"Hold non-urgent mail; false releases now. Self: running turn; descendant: current or next turn"});
                want["inputSchema"]["properties"]["node"]=serde_json::json!({"type":"string","description":"DnD target: self or descendant; requires dnd, omits status/summary. Descendants need runtime"});
                want["inputSchema"]["required"]=serde_json::json!([]);
            } else {
                want["inputSchema"]["properties"]["action"]["enum"]=serde_json::json!(["list","fetch","chunk","conversation","settings","pull"]);
            }
        }
        for name in ["orgtree_message","orgtree_send_notice"] {
            let want=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]==name).unwrap();
            let props=&mut want["inputSchema"]["properties"];
            let props=if props["metadata"].is_object() { &mut props["metadata"]["properties"] } else { props };
            if props.get("urgent").is_some() {
                props["urgent"]["description"]=serde_json::json!("Requires urgent_reason. User mail keeps its urgent inbox pulse. Agent mail: only while the recipient is currently in DND; bypasses DND, with normal notice/wake rules. Plural sends report refusals per recipient.");
                props["urgent_reason"]["description"]=serde_json::json!("one line explaining why this must interrupt now");
            }
            // USER 2026-10-24: independent one-time marker, both mail tools.
            props["one_time"]=serde_json::json!({"type":"boolean","description":"One-time; no reply audience. Guide."});
        }
        expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]=="orgtree_send_notice").unwrap()["description"]=serde_json::json!(
            "Store passive mail for the recipient's next turn; wakes nobody. Accepts to, one_time and body; use orgtree_message notice=true for attachments, kind or replies. Always write metadata (`to`) before body: metadata first, body last.\nGuide: orgtree-tool-send-notice.");
        // Approved project tool parity: only these added/changed schema keys
        // differ from the earlier captured tool contract.
        for (name,keys) in [("orgtree_inbox",vec!["project","folder","status","org_inbox"]),
            ("orgtree_project",vec!["index","above","chunk_index","body_revision","urgent","urgent_reason","reply_to","replies"]),
            ("orgtree_message",vec!["reply_to","replies"])] {
            let want=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]==name).unwrap();
            let got=actual.iter().find(|c|c["name"]==name).unwrap();
            let nested=want["inputSchema"]["properties"]["metadata"].is_object();
            for key in keys {
                if nested {
                    want["inputSchema"]["properties"]["metadata"]["properties"][key]=got["inputSchema"]["properties"]["metadata"]["properties"][key].clone();
                } else {
                    want["inputSchema"]["properties"][key]=got["inputSchema"]["properties"][key].clone();
                }
            }
        }
        // Assigned 4.4.4 base 3c579c4 includes the published 4.4.3
        // agent-boundary broadcast rule. Keep its exact body wording guarded.
        let project=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]=="orgtree_project").unwrap();
        project["inputSchema"]["properties"]["body"]["description"]=serde_json::json!("broadcast: message to live agent children through nested projects, stopping at each agent; fire_event: optional message carried to its event listeners");
        // User 2026-10-19 20:35Z: physical siblings alone are default mail
        // coworkers; other project memberships need a directional audience.
        let message=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]=="orgtree_message").unwrap();
        let old="Same-actual-parent peers need a directional audience when peer mail is OFF.";
        assert!(message["description"].as_str().unwrap().contains(old));
        message["description"]=serde_json::json!(message["description"].as_str().unwrap()
            .replace(old,"Peers share a physical parent; OFF or other parents need audiences."));
        // Approved description-only trim; compare schemas and order unchanged.
        for (name, description) in [
            ("orgtree_work", "Docket by slug; read Guide first. Objective: problem/solution then scope. Updates claim ownership unless owner=current holder; supply lists or revision-checked keep/append. Add participants before assignment/review. Blocked/dropped need reasons. Review=agents; ask(work_item)=user questions. Delete permanent/restricted; prefer archive/drop.\nGuide: orgtree-tool-work."),
            ("orgtree_project", "Read/use projects above/below; only ancestors/user change settings/name/order or purge. create needs name/index, parent defaults you; above wraps node; initial settings atomic (name/description top-level). settings reads; configure atomic. Broadcast checks recipient authority; purge unclaimed only. Chunked presentations. Claim via slot watchdog; slots lists holders/line; release_slot releases yours. Ancestors force/unqueue.\nGuide: orgtree-tool-project."),
            ("orgtree_watchdog", "Proactively await builds, files, processes, mail/events or usage thresholds; never poll/sleep-wait. Uncapped/paged. create kind/target (usage default), command regex. command/stream smoke-run as you (cmd.exe or shell=bash). Ready once command/process/usage/slot/fair_queue: inline effects/actions; else register. usage cached, no probes. slot grants lease; other kinds/fire_actions: Guide. mqtt/websocket send needs live connection (MQTT topic). configure health mail (default notice), no reconnect.\nGuide: orgtree-tool-watchdog."),
            ("orgtree_inbox", "Own mail: list previews, fetch<=20 IDs, chunk bodies, conversation recall. Fetch/chunk consume; previews do not. Project reads never claim/ack; keep project/folder/status on cursors. Org inbox: extern holders use settings, list org_inbox=true, or pull (consumes org-wide). Mode writes user-only. Guide: limits/continuations.\nGuide: orgtree-tool-inbox."),
            ("orgtree_audience", "Manage directional audiences; requests grant nothing. request target/from managed project; grant from; deny requester; revoke grantee. Project grants reach direct live members, never nested; reverse needs its own grant. User contact does not add personal access while inherited; manual Acquire can. Project decisions go to nearest agent superior (user if none). External/org-inbox remains agent-only. Read guide for grant authority.\nGuide: orgtree-tool-audience."),
            ("orgtree_status", "Report own work status; done does not end turn. Or node+dnd only: self or descendant (descendants need runtime). Idle arms next turn. false clears any setter's hold and triggers native delivery now, without a count cap; size limits remain. Urgent bypasses; turn end clears DND.\nGuide: orgtree-tool-status."),
        ] {
            expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == name).unwrap()["description"] = serde_json::json!(description);
        }
        // The same assigned base exposes supplied thinking and sealed markers.
        let transcript=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]=="orgtree_read_transcript").unwrap();
        transcript["description"]=json!("Read recent conversation rows, supplied thinking and sealed markers for yourself or an agent below you; last defaults 30, maximum 80. helpers lists observed helper agents; helper reads one retained helper transcript.\nGuide: orgtree-tool-read-transcript.");
        transcript["inputSchema"]["properties"]["helpers"]=json!({"type":"boolean","description":"true lists bounded live/recent helper identities and details; no native execution"});
        transcript["inputSchema"]["properties"]["helper"]=json!({"type":"object","additionalProperties":false,"required":["seq","tool"],"properties":{"seq":{"type":"integer","minimum":1},"tool":{"type":"string"}},"description":"read one listed helper's retained transcript; mutually exclusive with helpers"});
        // Approved node-placement contracts (bfa9369) and their concise wording.
        // Keep the captured required-field text and guide; schemas/order stay guarded.
        for (name, description) in [
            ("orgtree_hire", "Hire within your team or insert a superior. index: zero-based live siblings 0..count, excluding insertion target. Seat+grant must fit; self-parent spends your free credits, external budget fixed. Insertion inherits scope. kickoff sends first mail."),
            ("orgtree_interrupt", "Interrupt yourself, or a descendant with runtime permission. restart wakes one turn by placement rules. queued: Claude/AGY held hooks; Codex/Muse/ACP completion notices may cut the next step off early. Background work blocks queued/restart. Inspect interrupt status."),
            ("orgtree_halt", "Halt descendant agents until unhalt: stop processes, keep waiting mail and suppress wakes."),
            ("orgtree_unhalt", "Unhalt descendant agents; waiting mail may start their next turn."),
            ("orgtree_unstick", "Release a descendant agent's usage freeze and let it continue."),
            ("orgtree_continue_on", "Switch a frozen descendant agent to a same-provider account and release its freeze."),
            ("orgtree_cheap_compact", "Restart a descendant agent on a fresh session with a summary handoff."),
            ("orgtree_rehire", "Restore a retired agent/project; target/hire_type set placement. Projects keep policy, cost no seat and reject model/scope/grant overrides. Agents retain omitted values; folders replace. kickoff sends first mail. Credit/authority limits apply."),
            ("orgtree_self_subjugate", "Promote a live descendant node into your position; it keeps its team, you move beneath with yours. Projects keep policy, cost no seat and preserve agent reporting. External allocation stays fixed."),
        ] {
            let card=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]==name).unwrap();
            let suffix=card["description"].as_str().unwrap().split_once('\n').unwrap().1;
            card["description"]=serde_json::json!(format!("{description}\n{suffix}"));
        }
        // User 2026-10-20: descendant restart and queued completion boundaries.
        let interrupt=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]=="orgtree_interrupt").unwrap();
        interrupt["inputSchema"]["properties"]["restart"]=serde_json::json!({"type":"boolean","description":"start one next turn after this turn settles"});
        interrupt["inputSchema"]["properties"]["queued"]=serde_json::json!({"type":"boolean","description":"wait for a completion boundary before interrupting this turn"});
        // Approved 4.5.0 startup-card trim (coordinator 2026-10-27, docket
        // 4-5-0-two-pre-existing-tools-defs-test-failures-s): text repeating a
        // card's own fields or Guide pointer leaves the card, and Logo's output
        // limits are left to its Guide, so the description total fits 12,000 bytes.
        // Schemas and order stay guarded.
        for (name, old, new) in [
            ("orgtree_watchdog",
             " configure health mail (default notice), no reconnect.",
             ""),
            ("orgtree_audience",
             " request target/from managed project; grant from; deny requester; revoke grantee.",
             ""),
            ("orgtree_staff",
             " parent is the WORK ITEM; target/hire_type place the seat.",
             ""),
            ("orgtree_inbox",
             " Guide: limits/continuations.",
             ""),
            ("orgtree_account_mark",
             " reason required for clear.",
             ""),
            ("orgtree_org_logo",
             "Set reads a held local PNG/JPEG/WebP, ≤5 MiB and 16 MP; normalizes to square PNG ≤512px/256KiB. Optional crop fractions use 0..1 travel and 0.1..1 size.",
             "Set reads a held local PNG/JPEG/WebP, ≤5 MiB and 16 MP, stored as a square PNG; crop: Guide."),
            ("orgtree_project",
             " Chunked presentations.",
             ""),
            ("orgtree_chart",
             " Team charters default on.",
             ""),
            ("orgtree_read_transcript",
             "; last defaults 30, maximum 80.",
             "."),
            ("orgtree_usage",
             " refresh needs inspection+runtime, one explicit active account; floors 60s (Google 300) and provider cooldowns apply. No inference/account switch. Account pages≤100, windows/account≤64;",
             " refresh floors 60s (Google 300) and provider cooldowns apply. No inference/account switch. Windows/account≤64;"),
            ("orgtree_rehire",
             " Agents retain omitted values; folders replace.",
             ""),
            ("orgtree_session",
             " prefer changes placement preference; use selects one next-turn session id (0=Session 0). Self interrupt with restart applies it now when allowed.",
             " prefer/use set placement; self interrupt with restart applies it now when allowed."),
        ] {
            let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == name).unwrap();
            let description = card["description"].as_str().unwrap();
            assert_eq!(description.matches(old).count(), 1, "{name}");
            card["description"] = serde_json::json!(description.replacen(old, new, 1));
        }
        // the edited cards must match in content (keys in any order); their
        // key order is the builder's
        for name in ["orgtree_project", "orgtree_watchdog", "orgtree_audience", "orgtree_inbox", "orgtree_message"] {
            let want = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == name).unwrap();
            let got = actual.iter().find(|card| card["name"] == name).unwrap();
            assert_eq!(*want, *got, "{name}: differs beyond the approved slot changes");
            *want = got.clone();
        }
        // Custom apps (user 2026-10-25, cf463f4; DECISIONS "Custom apps"): the
        // deferred orgtree_apps card after the mail cards, whose contract its own
        // tests cover; the org-modifying tools group, which holds Logo, in
        // scope requests; and Logo's requirement named after that group.
        assert!(!expected.as_array().unwrap().iter().any(|c| c["name"] == "orgtree_apps"));
        let at = expected.as_array().unwrap().iter().position(|c| c["name"] == "orgtree_send_notice").unwrap() + 1;
        expected.as_array_mut().unwrap().insert(at, super::build_tool_apps());
        let scope = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_request_scope").unwrap();
        let groups = scope["inputSchema"]["properties"]["items"]["items"]["properties"]["tool"]["enum"].as_array_mut().unwrap();
        let at = groups.iter().position(|g| g == "orgtree.logo").unwrap();
        groups.insert(at, serde_json::json!("orgtree.orgmod"));
        let logo = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_org_logo").unwrap();
        let old = "requires logo tools,";
        assert!(logo["description"].as_str().unwrap().contains(old));
        logo["description"] = serde_json::json!(logo["description"].as_str().unwrap().replace(old, "requires org-modifying tools,"));
        // Approved fast-mode additions: one card after hire and one shared
        // boolean on the four seat cards. Preserve every other byte.
        let fast=actual.iter().find(|c|c["name"]=="orgtree_fast_defaults").unwrap();
        let index=expected.as_array().unwrap().iter().position(|c|c["name"]=="orgtree_hire").unwrap()+1;
        expected.as_array_mut().unwrap().insert(index,fast.clone());
        for name in ["orgtree_hire","orgtree_rehire","orgtree_staff","orgtree_retool"] {
            let want=expected.as_array_mut().unwrap().iter_mut().find(|c|c["name"]==name).unwrap();
            let got=actual.iter().find(|c|c["name"]==name).unwrap();
            want["inputSchema"]["properties"]["fast_mode"]=got["inputSchema"]["properties"]["fast_mode"].clone();
            // Custom apps (cf463f4): the org-modifying tools group.
            want["inputSchema"]["properties"]["tools"]["properties"]["orgtree"]["properties"]["orgmod"]=serde_json::json!({"type":"boolean"});
            // Approved native replacement switch already in the assigned base.
            want["inputSchema"]["properties"]["tools"]["properties"]["orgtree_disabled"]=serde_json::json!({"type":"boolean","description":"Restore Orgtree-disabled native tools; fresh hire omission=false, rehire/retool omission preserves. Parent-clamped; does not change defaults or other permissions. See orgtree-agent-tools-tab."});
            if matches!(name, "orgtree_hire" | "orgtree_staff") {
                let fields = serde_json::json!({
        "permission_mode": { "type": "string", "enum": ["plan", "default", "acceptEdits", "bypassPermissions"] },
        "model_version": { "type": "string", "description": "New hire only: offered version key; empty uses latest" },
        "session": { "type": ["string", "array"], "items": { "type": "string" }, "minItems": 1,
            "description": "New hire only: Windows session preference; Guide" },
        "peer_mail": { "type": "boolean", "description": "New hire only: allow its direct reports to message each other" },
        "auto_cheap_compact": { "type": "object", "additionalProperties": false, "properties": {
            "enabled": { "type": "boolean" }, "occ": { "type": "number", "minimum": 0.05, "maximum": 0.95 } },
            "description": "New hire only: cold-turn override; empty inherits" }
    });
                for (key, schema) in fields.as_object().unwrap() {
                    want["inputSchema"]["properties"][key] = schema.clone();
                }
            }
            assert_eq!(*want,*got,"{name}: differs beyond fast_mode");
            *want=got.clone();
        }
        // G7 adds exactly one approved card; all older cards retain their bytes/order.
        let at = expected.as_array().unwrap().iter().position(|c| c["name"] == "orgtree_cheap_compact").unwrap() + 1;
        expected.as_array_mut().unwrap().insert(at, super::build_tool_compact());
        let tiers = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_list_tiers").unwrap();
        tiers["description"] = serde_json::json!("List tiers/prices; refresh rechecks logins (runtime).\nGuide: orgtree-tool-list-tiers.");
        tiers["inputSchema"]["properties"]["refresh"] = serde_json::json!({"type":"boolean","description":"default false; coalesced provider discovery, runtime required"});
        // Approved 4.4.4 selection-reply contract: identity strings/objects
        // remain nested unchanged; the additive wrapper is covered separately.
        let cards=expected.as_array_mut().unwrap();
        let mut baseline=cards.iter().find(|c|c["name"]=="orgtree_message").unwrap().clone();
        // The earlier fixture reconciliation already uses today's helper.
        // Restore its exact 4.4.2 identity schema for a real byte-cost control.
        // Frozen from assigned base 3b3a5c779795127af10f3c20e51a28ff2077e246.
        let legacy:Value=serde_json::from_str(include_str!("../../testdata/reply-target-schema-442.json")).unwrap();
        baseline["inputSchema"]["properties"]["metadata"]["properties"]["reply_to"]["anyOf"]=legacy["anyOf"].clone();
        baseline["inputSchema"]["properties"]["metadata"]["properties"]["replies"]["items"]=legacy;
        let [extended,_]=super::mail_tools(super::MailShape::Split);
        let [flat,_]=super::mail_tools(super::MailShape::Flat);
        let mut old_flat=flat.clone();
        for key in ["reply_to","replies"] { old_flat["inputSchema"]["properties"][key]=baseline["inputSchema"]["properties"]["metadata"]["properties"][key].clone(); }
        let bytes=|v:&Value|serde_json::to_vec(v).unwrap().len();
        let source=super::build_tool_read_reply_source();
        let costs=json!({"encoding":"compact UTF-8 JSON via serde_json::to_vec","source_tool_bytes":bytes(&source),
            "source_schema_bytes":bytes(&source["inputSchema"]),"source_deferred":super::deferred("orgtree_read_reply_source"),
            "message_split_base_bytes":bytes(&baseline),"message_split_extended_bytes":bytes(&extended),
            "message_split_delta_bytes":bytes(&extended) as i64-bytes(&baseline) as i64,
            "message_split_base_schema_bytes":bytes(&baseline["inputSchema"]),"message_split_extended_schema_bytes":bytes(&extended["inputSchema"]),
            "message_flat_base_bytes":bytes(&old_flat),"message_flat_extended_bytes":bytes(&flat),
            "message_flat_delta_bytes":bytes(&flat) as i64-bytes(&old_flat) as i64});
        assert!(costs["message_split_delta_bytes"].as_i64().unwrap()>0,"a zero delta means the predecessor control was overwritten");
        assert!(costs["message_split_delta_bytes"].as_i64().unwrap() <= 800, "keep eager selection schema compact");
        println!("SELECTION_TOOL_COST {costs}");
        if let Ok(path)=std::env::var("ORGTREE_SELECTION_TOOL_COST") {
            assert!(path.replace('\\',"/").starts_with("C:/orgtree-build/native-tools-sol/"));
            std::fs::write(path,serde_json::to_vec_pretty(&costs).unwrap()).unwrap();
        }
        assert!(super::deferred("orgtree_read_reply_source"));
        let position=cards.iter().position(|c|c["name"]=="orgtree_read_transcript").unwrap()+1;
        cards.insert(position,super::build_tool_read_reply_source());
        let message=cards.iter_mut().find(|c|c["name"]=="orgtree_message").unwrap();
        message["inputSchema"]["properties"]["metadata"]["properties"]["reply_to"]["anyOf"]=super::reply_target_schema()["anyOf"].clone();
        message["inputSchema"]["properties"]["metadata"]["properties"]["replies"]["items"]=super::reply_target_schema();
        // The assigned base f4ae0d7 adds the independently covered file-list
        // card immediately before scratch. Keep the older fixture intact.
        assert!(!expected.as_array().unwrap().iter().any(|c| c["name"] == "orgtree_files"));
        let at = expected.as_array().unwrap().iter().position(|c| c["name"] == "orgtree_read_scratch").unwrap();
        expected.as_array_mut().unwrap().insert(at, super::build_tool_files());
        // Fewer failed docket calls (USER 2026-10-27 m3f52496b06f6, proposals A
        // and D): keep/append need no revision, and the entry limits sit in the
        // schema. Only this clause and these five fields changed.
        let work = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_work").unwrap();
        let old = "supply lists or revision-checked keep/append.";
        assert_eq!(work["description"].as_str().unwrap().matches(old).count(), 1);
        work["description"] = serde_json::json!(work["description"].as_str().unwrap().replacen(old, "supply lists or keep/append.", 1));
        let got = actual.iter().find(|c| c["name"] == "orgtree_work").unwrap();
        for key in ["done_so_far", "working_on_next", "done_append", "next_append", "expected_rev"] {
            work["inputSchema"]["properties"][key] = got["inputSchema"]["properties"][key].clone();
        }
        assert!(serde_json::to_vec(&super::all()).unwrap() == serde_json::to_vec(&expected).unwrap(),
            "all() JSON differs from the pre-split capture beyond the approved project-presentation description");
    }

    #[test]
    fn draft_hire_preferences_are_available_only_on_creation_contracts() {
        let cards = super::all();
        for name in ["orgtree_hire", "orgtree_staff"] {
            let card = cards.iter().find(|card| card["name"] == name).unwrap();
            let props = &card["inputSchema"]["properties"];
            assert_eq!(props["model_version"]["type"], "string");
            assert_eq!(props["peer_mail"]["type"], "boolean");
            assert!(props["permission_mode"]["enum"].as_array().unwrap().contains(&serde_json::json!("plan")));
            assert_eq!(props["session"]["type"], serde_json::json!(["string","array"]));
            assert_eq!(props["auto_cheap_compact"]["properties"]["enabled"]["type"], "boolean");
        }
        for name in ["orgtree_rehire", "orgtree_retool"] {
            let card = cards.iter().find(|card| card["name"] == name).unwrap();
            for field in ["model_version", "peer_mail", "session", "auto_cheap_compact"] {
                assert!(card["inputSchema"]["properties"].get(field).is_none(), "{name}/{field}");
            }
        }
    }
}


#[cfg(test)]
mod normal_compact_tool_contract_tests {
    use super::*;

    #[test]
    fn normal_compact_tool_card_is_single_target_and_defaults_to_compact() {
        let card = list().into_iter().find(|c| c["name"] == "orgtree_compact")
            .expect("normal compaction must be exposed to agents");
        let schema = &card["inputSchema"];
        assert_eq!(schema["required"], json!(["node"]));
        assert_eq!(schema["properties"]["node"]["type"], "string");
        assert_eq!(schema["properties"]["action"]["enum"], json!(["capability", "compact"]));
        assert_eq!(schema["properties"]["action"]["default"], "compact");
        assert!(schema["properties"].get("nodes").is_none(), "no unapproved bulk form");
        assert!(card["description"].as_str().unwrap().contains("below"));
        assert!(card["description"].as_str().unwrap().contains("admitted"));
    }

    #[test]
    fn normal_compact_tool_requires_team_even_when_runtime_or_watchdogs_are_enabled() {
        let group = crate::domain::tool_groups::required("orgtree_compact");
        assert_eq!(group, Some(&["team"][..]));
        assert!(crate::domain::tool_groups::allows(&json!({}), "orgtree_compact"));
        assert!(!crate::domain::tool_groups::allows(
            &json!({"orgtree":{"team":false,"runtime":true,"watchdogs":true}}),
            "orgtree_compact"));
    }

    #[test]
    fn normal_compact_tool_keeps_existing_native_support_controls() {
        use crate::domain::compaction::normal_compact_capability as cap;
        for provider in ["claude", "muse"] {
            assert_eq!(cap(provider, None)["supported"], true);
        }
        for provider in ["openai", "google"] {
            let value = cap(provider, None);
            assert_eq!(value["supported"], false);
            assert!(value["reason"].as_str().is_some());
        }
        assert_eq!(cap("openrouter", Some("claude-code"))["supported"], true);
        assert_eq!(cap("openrouter", Some("opencode"))["supported"], false);
    }
}

#[cfg(test)]
mod mqtt_card_tests {
    /// The watchdog card offers the mqtt kind (user 2026-10-19 17:40:50Z):
    /// a broker target, a topic-filter pattern, and credentials as a file
    /// path or an inline object (docs/rust-engine/mqtt-watchdogs.md).
    #[test]
    fn the_watchdog_card_offers_the_mqtt_kind_and_its_fields() {
        let cards = super::all();
        let dog = cards.iter().find(|c| c["name"] == "orgtree_watchdog").unwrap();
        let props = &dog["inputSchema"]["properties"];
        assert!(props["kind"]["enum"].as_array().unwrap().iter().any(|k| k == "mqtt"), "{}", props["kind"]);
        for field in ["credentials", "payload_pattern", "retained"] {
            assert!(props.get(field).is_some(), "{field} is missing");
        }
        assert_eq!(props["topic"]["type"], "string");
        assert!(props.get("payload").is_some(), "MQTT payload alias is exposed");
        assert_eq!(props["qos"]["minimum"], 0);
        assert_eq!(props["qos"]["maximum"], 2);
        assert_eq!(props["retain"]["type"], "boolean");
        let creds = props["credentials"].to_string();
        assert!(creds.contains("\"string\"") && creds.contains("\"object\""), "a file path or an inline object: {creds}");
        let d = dog["description"].as_str().unwrap();
        assert!(d.contains("mqtt") && d.len() <= 900, "{} bytes: {d}", d.len());
    }

    /// mail.send was removed (user 2026-10-26: agents hear apps only through events).
    #[test]
    fn the_apps_card_offers_no_mail_send() {
        let cards = super::all();
        let apps = cards.iter().find(|c| c["name"] == "orgtree_apps").unwrap();
        assert!(!apps.to_string().contains("mail.send"), "the apps card still offers mail.send");
    }

    /// The websocket kind, its fields and the send action
    /// (docs/rust-engine/websocket-watchdogs.md).
    #[test]
    fn the_watchdog_card_offers_the_websocket_kind_and_send() {
        let cards = super::all();
        let dog = cards.iter().find(|c| c["name"] == "orgtree_watchdog").unwrap();
        let props = &dog["inputSchema"]["properties"];
        assert!(props["kind"]["enum"].as_array().unwrap().iter().any(|k| k == "websocket"), "{}", props["kind"]);
        assert!(props["action"]["enum"].as_array().unwrap().iter().any(|k| k == "send"), "{}", props["action"]);
        for field in ["hello", "protocols", "heartbeat", "message", "credentials"] {
            assert!(props.get(field).is_some(), "{field} is missing");
        }
        assert!(props["credentials"]["anyOf"][1]["required"].is_null(), "an inline websocket object needs no username");
        let d = dog["description"].as_str().unwrap();
        assert!(d.contains("websocket") && d.contains("send") && d.len() <= 900, "{} bytes: {d}", d.len());
    }
}


#[inline(never)]
#[nolog]
fn build_tool_apps()->Value {
    tool("orgtree_apps","Manage this org's app definitions and independent saved panels. Requires org-modifying tools. List pages omit HTML/state; app_get/panel_get read them. Agent panel_open creates a new closed panel; only user UI shows windows. Panels are the user's custom views and run only while Orgtree is open, tray included: Hide keeps one running, panel_stop powers it off. Mutations need the current expected_rev. Apps have implicit org access; user Deny overrides. External files need consent.",json!({
        "action":{"type":"string","enum":["list","app_get","app_create","app_update","app_delete","app_import","app_export","mark_seen","panel_open","panel_get","panel_update","panel_duplicate","panel_delete","state_set","state_patch","event","events","fire_event","listeners","listener_fires","permission_set","permission_history","panel_start","panel_stop","runtime","file_permissions","file_open","file_read","file_roots","file_list","file_child","file_write","file_delete","file_result"]},
        "apps":{"type":"array","minItems":1,"maxItems":200,"uniqueItems":true,"items":{"type":"string"},"description":"mark_seen: acknowledge these explicit app IDs for this org's New badge; does not grant actions or change app/panel revisions"},
        "bundle":{"type":"object","description":"app_import: strict orgtree-app version1 object with definition and optional panels:[{label,state}]; up to16MiB/16 saved panels. No permissions, IDs, links or geometry."},
        "path":{"type":"string","description":"app_import: absolute held .orgtree-app file; file_open: relative name inside root (artifacts uses retained delivery ID). No parent components or links."},
        "root":{"type":"string","enum":["scratch","uploads","artifacts"],"description":"file_open: this org's collection; implicit org access or user grant, intersected with your held folders"},
        "file":{"type":"string","description":"file_read: opaque reference from file_open or this panel's saved state; never a computer path"},
        "directory":{"type":"string","description":"file_list/child/write: opaque directory reference for this saved panel"},
        "base64":{"type":"string","description":"file_write: standard base64, at most65536 decoded bytes; requires effective app access and your writable scope; org changes commit directly, external changes need native confirmation"},
        "replace":{"type":"boolean","description":"file_write: default false refuses existing files; true permits replacement; external targets still need exact native confirmation"},
        "confirmation":{"type":"string","description":"file_result: one-shot result of your pending file change; agents cannot confirm changes or create grants"},
        "offset":{"type":"integer","minimum":0,"description":"file_read: byte offset, default 0"},
        "length":{"type":"integer","minimum":1,"maximum":65536,"description":"file_read: maximum bytes, default 65536; returns base64, offset and eof"},
        "include_panels":{"type":"boolean","description":"app_export: include up to16 saved panel JSON states; default false"},
        "as_file":{"type":"boolean","description":"app_export: default true writes a new .orgtree-app file in your scratch and returns path/bytes/SHA256; false returns bundle JSON. No overwrite or arbitrary destination."},
        "kind":{"type":"string","enum":["apps","panels"],"description":"list: apps by default"},
        "app":{"type":"string","description":"app id: its slug, such as caption-board (an old generic id still works); list panels may filter by app"},
        "panel":{"type":"string","description":"saved panel id: its slug, such as caption-board-panel-1 (an old generic id still works)"},
        "listener":{"type":"string","description":"listener_fires: one listener as owner/id, as listeners shows it; its finished fires, newest first, without app data"},
        "slug":{"type":"string","maxLength":120,"description":"app_create, or panel_open making a new panel: the id to make, cleaned to a-z, 0-9 and -, at most 48 characters, -2, -3... if taken, never changed. Default: the name (a panel: its app's slug and label). Pass a short English slug whenever the name is not in English."},
        "after":{"description":"list: previous next_cursor string; events, permission_history and listener_fires: rows newer than this seq, oldest first"},
        "before":{"type":"integer","minimum":0,"description":"events, permission_history and listener_fires: rows older than this seq; without after, pages run newest first and next_cursor continues as before"},
        "limit":{"type":"integer","minimum":1,"maximum":200},
        "expected_rev":{"type":"integer","minimum":1},
        "expected_permission_rev":{"type":"integer","minimum":1},
        "capability":{"type":"string","enum":["org.read","docket.write","events.fire","files.read","files.write","net.fetch"]},
        "permission":{"type":"string","enum":["ask","allow","deny","default"],"description":"permission_set decisions are the user's; agents may only set net.fetch (or one of its sites) to ask or deny, never allow or lift a deny. default removes a site row"},
        "site":{"type":"string","description":"permission_set for net.fetch: one declared site, or a host a declared *.domain or * covers; omit for the whole capability"},
        "new":{"type":"boolean","description":"panel_open: create a fresh closed saved panel; agents cannot open windows"},
        "label":{"type":"string","maxLength":120,"description":"panel_open default: Panel N, the app's lowest unused number"},
        "open":{"type":"boolean","description":"list panels: filter visible panels; panel_update: false hides the window and keeps the panel running; agents cannot set true or move an open window"},
        "running":{"type":"boolean","description":"list panels: filter running (true) or powered-off (false) panels; hidden panels can run"},
        "sample":{"type":"boolean","description":"runtime: ask the desktop for a fresh sampled CPU reading; waits up to3s"},
        "messages":{"type":"boolean","description":"events: true lists messages sent with event or orgtree.emit instead of History (fired events, starts and stops)"},
        "delete_panels":{"type":"boolean","description":"app_delete: explicit consent to delete all its saved panels"},
        "definition":{"type":"object","additionalProperties":false,"properties":{
            "name":{"type":"string","maxLength":120},"description":{"type":"string","maxLength":1000},
            "html":{"type":"string","description":"self-contained HTML up to4MiB; no network except orgtree.net.fetch to sites the user allows"},
            "initial_state":{"type":"object","description":"independent initial JSON object, up to2MiB"},
            "events":{"type":"array","maxItems":64,"description":"inert portable event declarations; unique exact names, no surrounding whitespace or execution grant","items":{"type":"object","additionalProperties":false,"properties":{"name":{"type":"string","minLength":1,"maxLength":80},"description":{"type":"string","maxLength":1000}},"required":["name"]}},
            "capabilities":{"type":"array","uniqueItems":true,"items":{"enum":["org.read","docket.write","events.fire","files.read","files.write","net.fetch"]}},
            "sites":{"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","maxLength":255},"description":"net.fetch: HTTPS sites the app may ask for (host, host:port, *.domain, or * for any site); inert until the user allows them"},
            "width":{"type":"integer","minimum":160,"maximum":4096},"height":{"type":"integer","minimum":120,"maximum":4096}
        },"required":["name","html"]},
        "placement":{"type":"object","additionalProperties":false,"description":"float: the centered window; window: pinned to the window like pinned desks, x,y px from the canvas area's top-left; popout: its own native window","properties":{
            "mode":{"enum":["float","window","popout"]},"x":{"type":"number"},"y":{"type":"number"},
            "width":{"type":"integer"},"height":{"type":"integer"}
        }},
        "state":{"type":"object","description":"state_set: replacement object, up to2MiB"},
        "patch":{"type":"object","description":"state_patch: RFC7396 merge; null removes a key"},
        "name":{"type":"string","description":"event name,1-80characters; events: only that event's fires (or messages)"},
        "payload":{"description":"event JSON, up to64KiB"}
    }),&["action"])
}

#[cfg(test)]
mod panel_word_tests {
    use serde_json::Value;
    /// USER 2026-10-27 22:32:48Z m55abf5a34460, verbatim: "use panel
    /// nomenclature everywhere; say "all panels"." A saved instance of an app
    /// is a panel in every card text agents read, never a copy.
    fn copy_word(text: &str) -> bool {
        text.split(|c: char| !c.is_ascii_alphabetic()).any(|w| w.eq_ignore_ascii_case("copy") || w.eq_ignore_ascii_case("copies"))
    }
    fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
        match value {
            Value::String(s) => out.push(s),
            Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
            Value::Object(map) => map.values().for_each(|v| strings(v, out)),
            _ => {}
        }
    }
    #[test]
    fn the_apps_and_watchdog_cards_call_saved_panels_panels() {
        for (name, card) in [("orgtree_apps", super::build_tool_apps()), ("orgtree_watchdog", super::build_tool_watchdog())] {
            let mut texts = Vec::new();
            strings(&card, &mut texts);
            let found: Vec<_> = texts.into_iter().filter(|t| copy_word(t)).collect();
            assert!(found.is_empty(), "{name} calls a panel a copy: {found:?}");
        }
        let dog = super::build_tool_watchdog();
        assert_eq!(dog["inputSchema"]["properties"]["all_panels"]["description"], "app_listener: explicitly listen to all current and future panels of this app");
        let apps = super::build_tool_apps();
        let description = apps["description"].as_str().unwrap();
        assert!(description.contains("Agent panel_open creates a new closed panel;"), "{description}");
    }
}
