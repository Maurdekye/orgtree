//! Tool cards: names, one-paragraph descriptions and argument schemas. The
//! names and argument names are the ones agents already know.

use serde_json::{json, Value};

/// Tools this build serves (the rest are listed once they land).
#[logged]
pub fn implemented() -> &'static [&'static str] {
    &[
        "orgtree_message",
        "orgtree_send_notice",
        "orgtree_status",
        "orgtree_next_turn",
        "orgtree_session",
        "orgtree_org_logo",
        "orgtree_transfers", "orgtree_inbox",
        "orgtree_chart",
        "orgtree_state_inspect",
        "orgtree_usage",
        "orgtree_list_tiers",
        "orgtree_list_orgs",
        "orgtree_read_transcript",
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
                .retain(|key,_| ["action","name","lease","note"].contains(&key.as_str()));
            card["inputSchema"]["properties"]["action"]["enum"] = json!(["slots","release_slot"]);
            card["description"] = json!("Release your own concurrency slot: release_slot with lease and optional note. slots with project name reads only your holds, line entries and history. Available with watchdogs or team; other project actions and force release require team. Normal project reach and lease ownership checks apply. Guide: orgtree-tool-project.");
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
        "orgtree_org_logo" | "orgtree_transfers" | "orgtree_list_orgs" |
        "orgtree_halt" | "orgtree_unhalt" | "orgtree_unstick" | "orgtree_continue_on" |
        "orgtree_account_mark" | "orgtree_withdraw_ask" | "orgtree_project" |
        "orgtree_retire" | "orgtree_dissolve" | "orgtree_retool" | "orgtree_switch_model" |
        "orgtree_move" | "orgtree_rename" | "orgtree_reorder" | "orgtree_reallocate" |
        "orgtree_cheap_compact" | "orgtree_request_credits" | "orgtree_request_scope" |
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
const MESSAGE_DESC: &str = "Send mail to superior, descendants, peers or audience grantors; user requires top-level/user audience, outside @org/@net requires org-inbox audience. Same-actual-parent peers need a directional audience when peer mail is OFF. Up to 10 recipients; inspect each outcome. Wakes unless notice=true. Replies arrive in later turns; never wait for them. Attachments to local agents are shared as authorized path references; user/@net receive uploaded copies; @org attachments unsupported. Reply references are filtered per conversation.";
const MESSAGE_ORDER: &str = "Always write metadata (`to` and the other fields saying how it is sent) before body: metadata first, \
     body last.";
const NOTICE_DESC: &str = "Store passive mail for the recipient's next turn; wakes nobody. Only routing and body are accepted; use orgtree_message with notice=true for attachments, kind or reply references.";
const NOTICE_ORDER: &str = "Always write metadata (`to`) before body: metadata first, body last.";

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
    json!({
        "to": TO.clone(),
        "kind": { "type": "string", "enum": ["message", "question", "request"], "description": "request is displayed as a request and otherwise treated as a message" },
        "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
        "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                         "description": "files to send, relative to your working folder or absolute; local agents receive authorized path references, `user` and `@net:` receive uploaded copies, and `@org:` attachments are unsupported" },
        "urgent": { "type": "boolean", "description": "RARELY; mail to the user only: their inbox pulses until read. Requires urgent_reason." },
        "urgent_reason": { "type": "string", "description": "one line for the user: why this interrupts them now" },
        "reply_to": { "type": "string", "description": "optional: the id of the message you are answering (the id that ends its FROM line; orgtree_inbox lists them). The recipient sees it quoted; over the mail hub (@net:) the reply also carries a link to it. With several recipients, each gets the quote only if it belongs to that conversation." },
        "replies": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 50, "description": "optional: all message ids this one answers, in order; reply_to, if also supplied, must match the first. Every id must be mail you received or sent. With several recipients, each gets only references belonging to its conversation." },
        "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                     "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
        "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
        "tags": { "type":"array", "maxItems":8, "items":{"type":"string","minLength":1,"maxLength":32}, "description":"Optional custom tags, only on mail to the user; up to 8, case-insensitive. Example: alpha build." },
    })
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
                                  "properties": { "to": TO.clone() } },
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
                tool("orgtree_send_notice", NOTICE_DESC, json!({ "to": TO.clone(), "body": { "type": "string" } }), &["to", "body"]),
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
            "subagents": { "type": "boolean" }, "mcp": { "type": "array", "items": { "type": "string" } },
            "orgtree": crate::domain::tool_groups::schema() } },
        "org_visibility": { "type": "string", "enum": VIS },
        "permission_mode": { "type": "string", "enum": PM },
        "effort": { "type": "string", "enum": EFFORT,
            "description": "a level its tier's own harness and model name (staffing options list them per tier); \"\" inherits" },
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
        "Set/remove your org's Logo immediately; requires logo tools, no user/inbox audience. Set reads a held local PNG/JPEG/WebP, ≤5 MiB and 16 MP; normalizes to square PNG ≤512px/256KiB. Optional crop fractions use 0..1 travel and 0.1..1 size. Remove restores the letter. Logged and undoable; returns no image bytes.",
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
        "Report working/done/blocked/idle with a short summary. Required on finishing or blocking; done/blocked sends your superior a passive notice. done leaves you idle. To wake someone, send mail.",
        json!({
            "status": { "type": "string", "enum": ["working", "done", "blocked", "idle"] },
            "summary": { "type": "string", "description": "one or two sentences" },
        }),
        &["status", "summary"],
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
        "Read sign-in state and current/next turn placement. Session 0 has no desktop. prefer changes placement preference; use selects one next-turn session id (0=Session 0). Self interrupt with restart applies it now when allowed. No args only reads.",
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
        "Read own mail: list previews; fetch≤20 ids; chunk larger bodies by delivery_id/message_id/index. conversation pages one correspondent, newest page first. After fresh session/compaction recall that conversation before replying. Reads do not change automatic delivery. project list/fetch reads reachable project mail without claiming it.",
        json!({
            "action": { "type": "string", "enum": ["list", "fetch", "chunk", "conversation"] },
            "project": { "type": "string", "description": "list/fetch: a project's name: its waiting (unread) mail, read-only" },
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
        "Read the org within your visibility: tiers, credits, status, age and effective audiences with project sources. include_archived reveals retired agents; check them before hiring because rehire restores context. Team charters default on.",
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
        "Read cached provider usage with exact account/provider/window filters; missing/stale stays explicit. refresh needs inspection+runtime, one explicit active account; floors 60s (Google 300) and provider cooldowns apply. No inference/account switch. Account pages≤100, windows/account≤64; truncation explicit.",
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
    tool("orgtree_list_tiers", "List hireable model tiers and seat prices in credits.", json!({}), &[])
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
        "Read recent conversation rows of yourself or an agent below you; last defaults 30, maximum 80.",
        json!({
            "node": { "type": "string" },
            "last": { "type": "integer", "minimum": 1, "maximum": 80, "description": "how many recent rows (default 30)" },
        }),
        &["node"],
    )
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
        "Stop a descendant's turn with runtime permission, or your own turn without it. Self restart=true starts exactly one new turn using placement rules. Self-interrupt is refused while your CLI runs background work. Waiting mail can start a later turn; this does not retire anyone.",
        json!({
            "node": { "type": "string" },
            "restart": { "type": "boolean", "description": "yourself only: start one new turn at once" },
        }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_halt() -> Value {
    tool(
        "orgtree_halt",
        "Halt agents below you until unhalt: stop their processes, preserve waiting mail and suppress wakes.",
        json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_unhalt() -> Value {
    tool(
        "orgtree_unhalt",
        "Unhalt agents below you; waiting mail starts their next turn.",
        json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
        &[],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_unstick() -> Value {
    tool(
        "orgtree_unstick",
        "Release a usage-limit freeze on an agent below you and let it continue.",
        json!({ "node": { "type": "string" } }),
        &["node"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_continue_on() -> Value {
    tool(
        "orgtree_continue_on",
        "Move a frozen agent below you to another account of the same provider and release its freeze.",
        json!({ "node": { "type": "string" }, "account": { "type": "string" } }),
        &["node", "account"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_account_mark() -> Value {
    tool(
        "orgtree_account_mark",
        "Inspect capacity marks or clear one using its exact expected values. A changed/missing mark writes nothing. Clearing is audited, adds no capacity and resumes nobody; frozen_here still needs unstick. Only org-visible accounts. reason required for clear.",
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

#[inline(never)]
#[nolog]
fn build_tool_present() -> Value {
    tool(
        "orgtree_present",
        "Present documents the user should READ (reports, plans, Markdown). project places it under a reachable project; members (nested included) need no user audience for their own project. Otherwise requires user audience/top-level authority. body or .md path≤64KiB; self-contained HTML path≤4MiB, sandboxed without network. replaces updates a card. Otherwise send to your superior.",
        json!({ "title": { "type": "string" }, "body": { "type": "string" }, "path": { "type": "string" },
                "replaces": { "type": "string" },
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
fn build_tool_hire() -> Value {
    tool(
        "orgtree_hire",
        "Hire a report (target in your team) or insert a superior. index is zero-based among live siblings, 0..count, excluding a superior's target. Seat+grant must fit; above yourself spends your free credits with fixed external budget. Ordinary hire needs explicit scope; superior insertion inherits its target's scope. kickoff sends first mail.",
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
            seat_scope_props(DIRS_HIRE),
        ),
        &["name", "tier", "grant", "charter", "index"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_project() -> Value {
    tool(
        "orgtree_project",
        "Create/control projects above or below you: no turns/credits. create requires name/index; parent defaults you. settings reads all values; configure (name, settings) patches name/description, peer mail, queue/ack policy and concurrency slots atomically. purge_waiting retracts unclaimed mail; broadcast uses normal per-recipient mail/attachment authority. presentations lists project/team cards; read_presentation reads document. Concurrency slots: claim with a slot watchdog; slots (name) lists holders and line; release_slot (lease) releases yours. Any ancestor may force release or unqueue_slot (name, agent).",
        json!({
            "action": { "type": "string", "enum": ["create","describe","settings","configure","slots","release_slot","unqueue_slot","purge_waiting","broadcast","presentations","read_presentation"] },
            "lease": { "type": "string", "description": "release_slot: the lease your concurrency slot grant named" },
            "note": { "type": "string", "description": "release_slot: optional, e.g. build ok 265s" },
            "settings": {"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"description":{"type":"string"},"peer_mail":{"type":"boolean"},"mail_queue":{"type":"string","enum":["round_robin","ack"]},"exclude_sender":{"type":"boolean"},"ack_timeout":{"type":"boolean"},"max_attempts":{"type":"integer","minimum":1,"maximum":100},"ack_reminders":{"type":"integer","minimum":1,"maximum":10},"slots":{"type":"integer","minimum":0,"maximum":64}}},
            "force": {"type":"boolean","description":"release_slot: any project ancestor may force release"},
            "agent": {"type":"string","description":"unqueue_slot: agent to remove from line"},
            "team": {"type":"boolean","description":"presentations/read_presentation: include the project subtree"},
            "document": {"type":"string","description":"read_presentation: document id"},
            "limit": {"type":"integer","minimum":1,"maximum":100},
            "offset": {"type":"integer","minimum":0},
            "body": {"type":"string","description":"broadcast: message to every live agent under the project"},
            "attachments": {"type":"array","items":{"type":"string"},"maxItems":10},
            "notice": {"type":"boolean"},
            "name": { "type": "string" }, "parent": { "type": "string" },
            "index": { "type": "integer", "minimum": 0, "description": "required zero-based live sibling insertion position" },
            "description": { "type": "string", "description": "what the project is: shown on its card and to its agents" },
        }),
        &["action"],
    )
}

#[inline(never)]
#[nolog]
fn build_tool_rehire() -> Value {
    tool(
        "orgtree_rehire",
        "Restore a retired agent with its context. Supplied folder list replaces the old list; omitted fields retain saved values. kickoff sends first mail. Credit and placement limits still apply.",
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
    tool("orgtree_cheap_compact", "Restart an agent below you on a fresh session with a summary of the old one.", json!({ "node": { "type": "string" } }), &["node"])
}

#[inline(never)]
#[nolog]
fn build_tool_request_credits() -> Value {
    tool(
        "orgtree_request_credits",
        "Ask the user for a larger credit grant with a reason.",
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
                    "tool": { "type": "string", "enum": ["bash", "web", "edit", "subagents", "orgtree.docket", "orgtree.team", "orgtree.messaging", "orgtree.inspection", "orgtree.watchdogs", "orgtree.runtime", "orgtree.user", "orgtree.logo"] },
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
        "Manage directional audiences: agent/project endpoints, request target (optional from=managed project), grant from, deny requester, revoke grantee. Projects pass their explicit grants to direct members only; nested projects do not relay them. Project decisions belong to their nearest agent superior (user if none). User project messages grant the project user access. External/org-inbox access remains agent-only. Requests do not grant access.",
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
        "Create/list/pause/resume/remove persistent watchers; max 8/agent. Create requires kind/target; command requires regex. command/stream use YOUR authority and smoke-run at create: Windows defaults cmd.exe, or shell=bash. Read smoke output. once removes after a fire; always use it for deadlines. file matches new appends; process fires on observed UP->DOWN. fair_queue delivers project mail to one watcher; slot (one-shot) claims a project concurrency slot, firing when granted. Event/count/silence semantics and catalog are in the guide. No added authority.",
        json!({
            "action": { "type": "string", "enum": ["create", "list", "pause", "resume", "remove"] },
            "name": { "type": "string", "description": "create: a short name, e.g. build-watch; its slug becomes the dog's id" },
            "kind": { "type": "string", "enum": ["file", "command", "process", "stream", "activity", "event", "fair_queue", "slot"] },
            "fire_mode": { "type": "string", "enum": ["event", "silence"], "description": "create: on event (default), or after silence" },
            "threshold": {"type":"string","description":"event counts only: below N or at least N; fires only on false-to-true crossing, never repeatedly while satisfied"},
            "event_scope": {"type":"string","enum":["subtree","org"],"description":"count targets only: visible descendants (default), or org (requires full visibility); excludes the watcher"},
            "quiet_period_s": { "type": "integer", "minimum": 1, "description": "create, silence only: seconds without a matching event" },
            "target": { "type": "string", "description": "the path, command line, pid:N / port:N, (activity) agent name, (fair_queue, slot) project name, or (event) dotted event name/prefix ending in .*" },
            "pattern": { "type": "string", "description": "regex an event line must match (required for command; optional for file/stream/activity = any line)" },
            "interval_s": { "type": "integer", "minimum": 5, "description": "poll cadence (floor 15s); stream/activity: the minimum gap between fires (floor 5s)" },
            "notice": { "type": "boolean", "description": "create: fire passively — the mail waits without starting a turn" },
            "once": { "type": "boolean", "description": "create: ONE-SHOT — fires once and removes itself" },
            "shell": { "type": "string", "enum": ["native", "bash"], "description": "create, command/stream only" },
            "id": { "type": "string", "description": "pause/resume/remove: the watchdog's id as `list` shows it (owner/id for a team member's dog)" },
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
        "Manage durable work by readable slug. create requires objective (problem/solution first, full scope after). update supplies both progress lists or revision-checked keep/append; it CLAIMS ownership unless owner=current holder. blocked/dropped need reasons. Add participants before assignment/review requests. Review is agent review; user questions use ask(work_item), nonquestion attention needs a reason. delete is permanent, limited to user/owner's superior/top-level owner and refused with children/open questions; prefer archive/dropped. Read guide before first docket write.",
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
            "done_so_far": { "type": "array", "items": { "type": "string" }, "description": "what is complete, one entry each (max 500 chars, 40 entries)" },
            "working_on_next": { "type": "array", "items": { "type": "string" }, "description": "current and next steps, one entry each" },
            "keep_done": { "type": "boolean" }, "keep_next": { "type": "boolean" },
            "done_append": { "type": "array", "items": { "type": "string" } },
            "next_append": { "type": "array", "items": { "type": "string" } },
            "expected_rev": { "type": "integer", "description": "update: refuse if the item moved since you read it" },
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
        "Create/update a docket item and hire/rehire its owner atomically; assignment mail starts work. parent is the WORK ITEM; target/hire_type place the seat. Live agent: use work assign. Requires docket+team permissions; credit/scope limits match hire/rehire. Omitted progress keeps stored lists. Read guide before assigning.",
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
            seat_scope_props(DIRS_HIRE),
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
        "Step down under one live descendant: target takes your seat under your superior, keeps its team, and you become its report with the rest of yours.",
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
            ("max_attempts","integer"),("ack_reminders","integer"),("slots","integer")] {
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
mod slot_release_scope_tests {
    use super::*;

    fn check(team: bool, watchdogs: bool) {
        let scope=json!({"orgtree":{"team":team,"watchdogs":watchdogs}});
        let card=scoped(&scope).into_iter().find(|c| c["name"]=="orgtree_project");
        for action in ["release_slot","slots"] {
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
                assert_eq!(actions,&vec![json!("slots"),json!("release_slot")]);
                let keys=card["inputSchema"]["properties"].as_object().unwrap();
                assert!(keys.keys().all(|k| ["action","name","lease","note"].contains(&k.as_str())));
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
        let message = json!({
            "name": "orgtree_message",
            "description": format!("{MESSAGE_DESC}\nGuide: orgtree-tool-message."),
            "inputSchema": { "type": "object", "properties": {
                "to": to.clone(),
                "body": { "type": "string" },
                "kind": { "type": "string", "enum": ["message", "question", "request"], "description": "request is displayed as a request and otherwise treated as a message" },
                "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
                "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                                 "description": "files to send, relative to your working folder or absolute; local agents receive authorized path references, `user` and `@net:` receive uploaded copies, and `@org:` attachments are unsupported" },
                "urgent": { "type": "boolean", "description": "RARELY; mail to the user only: their inbox pulses until read. Requires urgent_reason." },
                "urgent_reason": { "type": "string", "description": "one line for the user: why this interrupts them now" },
                "reply_to": { "type": "string", "description": "optional: the id of the message you are answering (the id that ends its FROM line; orgtree_inbox lists them). The recipient sees it quoted; over the mail hub (@net:) the reply also carries a link to it. With several recipients, each gets the quote only if it belongs to that conversation." },
                "replies": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 50, "description": "optional: all message ids this one answers, in order; reply_to, if also supplied, must match the first. Every id must be mail you received or sent. With several recipients, each gets only references belonging to its conversation." },
                "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                             "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
                "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
                "tags": { "type":"array", "maxItems":8, "items":{"type":"string","minLength":1,"maxLength":32}, "description":"Optional custom tags, only on mail to the user; up to 8, case-insensitive. Example: alpha build." },
            }, "required": ["to", "body"] },
            "_meta": { "anthropic/alwaysLoad": true },
        });
        let notice = json!({
            "name": "orgtree_send_notice",
            "description": format!("{NOTICE_DESC}\nGuide: orgtree-tool-send-notice."),
            "inputSchema": { "type": "object", "properties": { "to": to, "body": { "type": "string" } }, "required": ["to", "body"] },
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
        assert!(fm["inputSchema"]["properties"]["replies"]["description"].as_str().unwrap().contains("each gets only references belonging to its conversation"));
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

#[cfg(test)]
mod builder_stack_tests {
    /// Keep the pre-split card bytes/order, except the explicitly approved
    /// own-project presentation permission description (user 2026-10-18).
    #[test]
    fn all_tool_json_matches_pre_split_snapshot() {
        let mut expected: serde_json::Value = serde_json::from_slice(include_bytes!("../../testdata/tool-cards-c89111b.json")).unwrap();
        let present = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_present").unwrap();
        present["description"] = serde_json::json!(concat!(
            "Present documents the user should READ (reports, plans, Markdown). project places it under a reachable project; members (nested included) need no user audience for their own project. Otherwise requires user audience/top-level authority. body or .md path≤64KiB; self-contained HTML path≤4MiB, sandboxed without network. replaces updates a card. Otherwise send to your superior.",
            "\nGuide: orgtree-tool-present."
        ));
        // project slots (user 2026-10-18 08:37Z-08:42Z, docket
        // project-slots-first-come-permits-claimed-through): orgtree_project
        // lists and releases slots, and orgtree_watchdog has the slot kind
        let project = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_project").unwrap();
        let actual: Vec<serde_json::Value> = serde_json::from_slice(&serde_json::to_vec(&super::all()).unwrap()).unwrap();
        let actual_project = actual.iter().find(|card| card["name"] == "orgtree_project").unwrap().clone();
        assert!(actual_project["description"].as_str().unwrap().contains("Concurrency slots: claim with a slot watchdog; slots (name) lists holders and line; release_slot (lease) releases yours."));
        project["description"] = actual_project["description"].clone();
        let schema = &mut project["inputSchema"];
        schema["properties"]["action"]["enum"] = serde_json::json!(["create","describe","settings","configure","slots","release_slot","unqueue_slot","purge_waiting","broadcast","presentations","read_presentation"]);
        schema["properties"]["settings"] = serde_json::json!({"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"},"description":{"type":"string"},"peer_mail":{"type":"boolean"},"mail_queue":{"type":"string","enum":["round_robin","ack"]},"exclude_sender":{"type":"boolean"},"ack_timeout":{"type":"boolean"},"max_attempts":{"type":"integer","minimum":1,"maximum":100},"ack_reminders":{"type":"integer","minimum":1,"maximum":10},"slots":{"type":"integer","minimum":0,"maximum":64}}});
        schema["properties"]["force"] = serde_json::json!({"type":"boolean","description":"release_slot: any project ancestor may force release"});
        schema["properties"]["agent"] = serde_json::json!({"type":"string","description":"unqueue_slot: agent to remove from line"});
        schema["properties"]["team"] = serde_json::json!({"type":"boolean","description":"presentations/read_presentation: include the project subtree"});
        schema["properties"]["document"] = serde_json::json!({"type":"string","description":"read_presentation: document id"});
        schema["properties"]["limit"] = serde_json::json!({"type":"integer","minimum":1,"maximum":100});
        schema["properties"]["offset"] = serde_json::json!({"type":"integer","minimum":0});
        schema["properties"]["body"] = serde_json::json!({"type":"string","description":"broadcast: message to every live agent under the project"});
        schema["properties"]["attachments"] = serde_json::json!({"type":"array","items":{"type":"string"},"maxItems":10});
        schema["properties"]["notice"] = serde_json::json!({"type":"boolean"});
        schema["properties"]["lease"] = serde_json::json!({ "type": "string", "description": "release_slot: the lease your concurrency slot grant named" });
        schema["properties"]["note"] = serde_json::json!({ "type": "string", "description": "release_slot: optional, e.g. build ok 265s" });
        schema["required"] = serde_json::json!(["action"]);
        let dog = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == "orgtree_watchdog").unwrap();
        dog["description"] = serde_json::json!(dog["description"].as_str().unwrap().replace(
            "fair_queue delivers project mail to one watcher.", "fair_queue delivers project mail to one watcher; slot (one-shot) claims a project concurrency slot, firing when granted."));
        let dschema = &mut dog["inputSchema"];
        dschema["properties"]["kind"]["enum"] = serde_json::json!(["file", "command", "process", "stream", "activity", "event", "fair_queue", "slot"]);
        dschema["properties"]["target"]["description"] = serde_json::json!(dschema["properties"]["target"]["description"].as_str().unwrap()
            .replace("(fair_queue) project name", "(fair_queue, slot) project name"));
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_audience").unwrap();
        card["description"] = serde_json::json!("Manage directional audiences: agent/project endpoints, request target (optional from=managed project), grant from, deny requester, revoke grantee. Projects pass their explicit grants to direct members only; nested projects do not relay them. Project decisions belong to their nearest agent superior (user if none). User project messages grant the project user access. External/org-inbox access remains agent-only. Requests do not grant access.\nGuide: orgtree-tool-audience.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_chart").unwrap();
        card["description"] = serde_json::json!("Read the org within your visibility: tiers, credits, status, age and effective audiences with project sources. include_archived reveals retired agents; check them before hiring because rehire restores context. Team charters default on.\nGuide: orgtree-tool-chart.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_state_inspect").unwrap();
        card["description"] = serde_json::json!("Inspect visible agents' structured folders, tools, permission mode and effective/explicit/inherited audiences with project sources, optionally archived. Excludes prompts, transcripts and mail.\nGuide: orgtree-tool-state-inspect.");
        let card = expected.as_array_mut().unwrap().iter_mut().find(|c| c["name"] == "orgtree_audience").unwrap();
        card["inputSchema"]["properties"]["target"]["description"] = serde_json::json!("request: agent/project/user/extern sought; grant/revoke: agent/project grantor when not you");
        card["inputSchema"]["properties"]["from"]["description"] = serde_json::json!("grant: agent/project receiving it; request: project you manage; deny: the requester");
        card["inputSchema"]["properties"]["grantee"]["description"] = serde_json::json!("revoke: agent/project holding it");
        // the edited cards must match in content (keys in any order); their
        // key order is the builder's
        for name in ["orgtree_project", "orgtree_watchdog", "orgtree_audience"] {
            let want = expected.as_array_mut().unwrap().iter_mut().find(|card| card["name"] == name).unwrap();
            let got = actual.iter().find(|card| card["name"] == name).unwrap();
            assert_eq!(*want, *got, "{name}: differs beyond the approved slot changes");
            *want = got.clone();
        }
        assert!(serde_json::to_vec(&super::all()).unwrap() == serde_json::to_vec(&expected).unwrap(),
            "all() JSON differs from the pre-split capture beyond the approved project-presentation description");
    }
}
