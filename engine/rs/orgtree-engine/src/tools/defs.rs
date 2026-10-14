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

#[logged]
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let mut out = json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        // an agent's own hands are never deferred behind tool search
        "_meta": { "anthropic/alwaysLoad": true },
    });
    if name == "orgtree_staff" {
        // New hires require placement; archived-seat restoration retains its
        // existing optional fields. Staff may select rehire with either form.
        out["inputSchema"]["allOf"] = json!([{
            "if": { "not": { "anyOf": [
                { "required": ["node"] },
                { "required": ["staff_mode"], "properties": { "staff_mode": { "const": "rehire" } } }
            ] } },
            "then": { "required": ["name", "tier", "grant", "charter", "index"] }
        }]);
    }
    out
}

const KINDS: &[&str] = &["message", "question", "request", "decision", "status"];

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
const MESSAGE_DESC: &str = "Send mail. You may write to your superior, your reports and their reports (writing to a non-child \
     descendant grants it an audience to reply), your peers, anyone who granted you an audience, 'user' \
     (top-level agents and holders of a user audience), another org's inbox '@org:<slug>', or a hub peer \
     '@net:<slug>'. The recipient is woken (notice: true stores it without waking). Replies arrive in your \
     later turns; never wait for them. `to` may be a LIST (up to 10) to send the same message to several \
     recipients in one call, e.g. [\"user\", \"@net:<their hub address>\"] to reach the user in their inbox \
     and over the hub at once: each recipient gets its own delivery, reach is checked per recipient, and the \
     result lists every recipient's outcome (refused ones are named with the reason; the rest still get it).";
const MESSAGE_ORDER: &str = "Always write metadata (`to` and the other fields saying how it is sent) before body: metadata first, \
     body last.";
const NOTICE_DESC: &str = "Same as orgtree_message with notice: true — stored for the recipient's next turn, wakes nobody.";
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
        "kind": { "type": "string", "enum": KINDS },
        "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
        "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                         "description": "files to send, relative to your working folder or absolute" },
        "urgent": { "type": "boolean", "description": "RARELY; mail to the user only: their inbox pulses until read. Requires urgent_reason." },
        "urgent_reason": { "type": "string", "description": "one line for the user: why this interrupts them now" },
        "reply_to": { "type": "string", "description": "optional: the id of the message you are answering (the id that ends its FROM line; orgtree_inbox lists them). The recipient sees it quoted; over the mail hub (@net:) the reply also carries a link to it" },
        "replies": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 50, "description": "optional: all message ids this one answers, in order; reply_to, if also supplied, must match the first. Every id must be mail you received or sent. Each recipient sees only references belonging to that conversation." },
        "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                     "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
        "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
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

#[logged]
fn all() -> Vec<Value> {
    let [message, notice] = mail_tools(MailShape::Split);
    vec![
        message,
        notice,
        tool(
            "orgtree_status",
            "Report your status. Required when you finish ('done') or get stuck ('blocked'): your superior gets \
             your summary as a notice. 'done' leaves you idle (no separate 'idle' needed). A status wakes nobody; \
             to make your superior act, send a message.",
            json!({
                "status": { "type": "string", "enum": ["working", "done", "blocked", "idle"] },
                "summary": { "type": "string", "description": "one or two sentences" },
            }),
            &["status", "summary"],
        ),
        tool(
            "orgtree_transfers",
            "Inspect attachment transfers for mail you sent, and incoming mail if you hold the org inbox audience. list returns up to 100, unfinished first, then newest history; pass next_cursor as cursor for the next page. get takes id. Byte counts distinguish processed from confirmed bytes. retry resumes a failed or cancelled transfer; cancel stops its network request and holds the message. remove explicitly omits a failed/cancelled outgoing file and releases the message when all remaining files are ready. Messages wait until every file is ready. Success sends no notification.",
            json!({"action":{"type":"string","enum":["list","get","retry","cancel","remove"]},"id":{"type":"string"},"cursor":{"type":"string"}}),
            &["action"],
        ),
        tool(
            "orgtree_inbox",
            "Your own mail. list: messages waiting for you (ids, senders, previews). fetch: the full text of up to \
             20 ids (mail you received or sent), with bodies above 64 KB served in chunks. chunk: read the remaining \
             content using its delivery_id. conversation: the mail you and one correspondent exchanged (peer = an \
             agent's name, 'user', '@org:<slug>' or '@net:<address>'), both directions, oldest to newest, the newest \
             page first (20 by default, at most 100, previews only: fetch gives the full text; next_cursor pages back \
             to older mail). AFTER A FRESH SESSION OR A COMPACTION, recall your conversation with someone this way \
             before you reply to them. Manual reads leave automatic delivery unchanged.",
            json!({
                "action": { "type": "string", "enum": ["list", "fetch", "chunk", "conversation"] },
                "peer": { "type": "string", "description": "conversation: an agent's name, 'user', '@org:<slug>' or '@net:<address>'" },
                "limit": { "type": "integer", "description": "list: how many (default 50, max 200); conversation: default 20, max 100" },
                "message_ids": { "type": "array", "items": { "type": "string" }, "description": "fetch: 1 to 20 IDs from list or conversation" },
                "cursor": { "type": "string", "description": "list or conversation: next_cursor from the preceding page" },
                "delivery_id": { "type": "string", "description": "chunk: delivery_id returned with this fetched message" },
                "message_id": { "type": "string", "description": "chunk: the message ID" },
                "chunk_index": { "type": "integer", "minimum": 0, "description": "chunk: zero-based index" },
            }),
            &["action"],
        ),
        tool(
            "orgtree_chart",
            "The org as you may see it (your visibility), with each agent's tier, credits, last reported status and \
             its age. Retired agents are counted unless include_archived is set (check them before hiring: \
             rehiring restores their context).",
            json!({
                "include_archived": { "type": "boolean" },
                "include_standing_charter": { "type": "boolean", "description": "include team charters (default true)" },
            }),
            &[],
        ),
        tool(
            "orgtree_state_inspect",
            "Structured state of agents within your visibility, including the folders, tools and permission mode each \
             one runs with (no prompts, transcripts or mail).",
            json!({
                "node": { "type": "string" },
                "nodes": { "type": "array", "items": { "type": "string" } },
                "include_archived": { "type": "boolean" },
            }),
            &[],
        ),
        tool(
            "orgtree_usage",
            "Read provider usage during a turn. Default: saved cache only; no probes. Exact accounts/providers/windows filters, OR within each list and AND across lists. Account IDs match the usage board; windows match kind or group, not display label. Missing/stale/unsupported readings remain explicit, never zero. inspection permission is required. refresh=true attempts one explicit active account, additionally requiring inherited runtime permission; it may reuse a recent reading or report cooldown/in_progress. Manual floors are 60 seconds (Google 300), longer provider cooldowns remain. No inference or account switching. Accounts page by ID (20, at most 100); next_cursor continues. At most 64 matching windows per account, with explicit truncation.",
            json!({
                "accounts":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32},
                "providers":{"type":"array","items":{"type":"string","enum":["claude","openai","google","muse","openrouter","langserver"]},"minItems":1,"maxItems":32},
                "windows":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32},
                "refresh":{"type":"boolean","description":"default false; exactly one explicit active account, runtime permission required"},
                "limit":{"type":"integer","minimum":1,"maximum":100,"description":"account page size, default 20"},
                "cursor":{"type":"string","description":"next_cursor from a previous cached account page"}
            }), &[],
        ),
        tool("orgtree_list_tiers", "Model tiers you can hire on, with seat prices in credits.", json!({}), &[]),
        tool("orgtree_list_orgs", "Other organizations: on this machine ('@org:<slug>' mail) and on the mail hubs this organization uses ('@net:<address>' mail, under \"remote\").", json!({}), &[]),
        tool(
            "orgtree_read_transcript",
            "Read the recent conversation of yourself or an agent below you.",
            json!({
                "node": { "type": "string" },
                "last": { "type": "integer", "minimum": 1, "maximum": 80, "description": "how many recent rows (default 30)" },
            }),
            &["node"],
        ),
        tool(
            "orgtree_read_scratch",
            "Browse or read the working folder of yourself or an agent below you (omit path to list it).",
            json!({ "node": { "type": "string" }, "path": { "type": "string" } }),
            &["node"],
        ),
        tool(
            "orgtree_interrupt",
            "Stop a report's (or their reports') current turn without retiring it; waiting mail starts its next turn.",
            json!({ "node": { "type": "string" } }),
            &["node"],
        ),
        tool(
            "orgtree_halt",
            "Halt agents below you until orgtree_unhalt: the process is stopped and nothing wakes them; their mail waits.",
            json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
            &[],
        ),
        tool(
            "orgtree_unhalt",
            "Release halted agents below you; waiting mail starts their next turn.",
            json!({ "node": { "type": "string" }, "nodes": { "type": "array", "items": { "type": "string" } } }),
            &[],
        ),
        tool(
            "orgtree_unstick",
            "Release a frozen agent below you (usage-limit freeze) and let it continue.",
            json!({ "node": { "type": "string" } }),
            &["node"],
        ),
        tool(
            "orgtree_continue_on",
            "Move a frozen agent below you to another account of the same provider and release its freeze.",
            json!({ "node": { "type": "string" }, "account": { "type": "string" } }),
            &["node", "account"],
        ),
        tool(
            "orgtree_account_mark",
            "Read or clear an account's capacity mark (the record that its usage limit is used up until a reset \
             time). `inspect` lists every stored mark with its pool, reset time, age, provenance and the `expected` \
             values a clear must send back. `clear` removes one mark only if it still matches `expected`; otherwise \
             it answers `changed` or `missing` and writes nothing (an expired mark is removed too). Clearing the pooled/default mark also \
             removes an inferred `fable` mark with the same reset time. Each clear is audited. It adds no capacity and \
             resumes nobody: `frozen_here` names agents that still need orgtree_unstick. Works on any account your org can see.",
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
        ),
        // ---- arriving with build step 5
        tool(
            "orgtree_ask",
            "Ask the user a question (or up to 4 as `questions` tabs) on a card; give 2-4 options or none for a \
             free answer. You have ONE open request: asking again adds or amends tabs. End your turn after asking; \
             the answer arrives as mail. Withdraw it when it becomes moot. Without a user audience (and not \
             top-level) it goes to your superior as mail.",
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
        ),
        tool("orgtree_withdraw_ask", "Withdraw your open question card.", json!({}), &[]),
        tool(
            "orgtree_present",
            "Present anything the user is meant to read themselves (report, plan, proposal, write-up, summary, any \
             .md): ALWAYS this, never a download card. A card beside your seat opens it. `body` is markdown (64 KB \
             max), or `path` a .md file (read as the markdown, 64 KB max) or a self-contained .html mockup (4 MB \
             max, shown sandboxed with no network). `replaces` updates an earlier card in place. Needs a user \
             audience (top-level agents hold one); without one, send the document to your superior.",
            json!({ "title": { "type": "string" }, "body": { "type": "string" }, "path": { "type": "string" },
                    "replaces": { "type": "string" } }),
            &["title"],
        ),
        tool(
            "orgtree_send_file",
            "Deliver a file the user wants AS A FILE (installer, log, export, image, archive) as a download card in \
             your chat; images show as the picture. Never for a document they are meant to read (report, plan, any \
             .md): that goes through orgtree_present. Relative paths start in your working folder.",
            json!({ "path": { "type": "string" }, "note": { "type": "string" },
                "delivery_id": { "type": "string", "description": "Reuse for the same delivery after a lost response; new ID for a new delivery" } }),
            &["path"],
        ),
        tool(
            "orgtree_hire",
            "Hire a report under you or under `target` in your team (or, with hire_type 'superior', insert a \
             superior above `target`, default yourself, even at top level). Above yourself, seat + grant come from \
             your free credits: grant is the new parent's free allocation; your external budget stays fixed. \
             Scope is inherited: omit scope fields. Write its charter in full. Other hires' seat + grant must fit (with \
             credit cascade on, your chain is raised as needed). `index` is REQUIRED: zero-based among live siblings, \
             0..existing_count (last appends). Superior insertion excludes its target, which becomes its child. \
             Use orgtree_state_inspect for sibling_index/live_sibling_count. `kickoff` sends it a first message.",
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
        ),
        tool(
            "orgtree_rehire",
            "Bring a retired agent back with its context.",
            merge(
                json!({ "node": { "type": "string" }, "grant": { "type": "integer" }, "target": { "type": "string" },
                        "hire_type": { "type": "string", "enum": ["subordinate", "superior"] }, "name": { "type": "string" },
                        "charter": { "type": "string" }, "kickoff": { "type": "string" },
                        "kickoff_kind": { "type": "string", "enum": KINDS }, "work_item": { "type": "string" } }),
                seat_scope_props(DIRS_REHIRE),
            ),
            &["node"],
        ),
        tool("orgtree_retire", "Retire an agent below you (it can be rehired later).", json!({ "node": { "type": "string" } }), &["node"]),
        tool("orgtree_dissolve", "Retire an agent below you together with its whole team.", json!({ "node": { "type": "string" } }), &["node"]),
        tool(
            "orgtree_retool",
            "Change an agent's scope (folders, tools, visibility, permission mode, effort, account) or charter. Only the \
             fields you pass change; removing a folder or making it read-only does the same to the agents beneath.",
            merge(json!({ "node": { "type": "string" }, "charter": { "type": "string" },
                          "remove_dirs": { "type": "array", "items": { "type": "string" },
                                           "description": "folders it holds to remove" } }),
                  scope_props(DIRS_RETOOL)),
            &["node"],
        ),
        tool(
            "orgtree_switch_model",
            "Move an agent below you to another tier (applied at its next turn boundary).",
            json!({ "node": { "type": "string" }, "tier": { "type": "string" } }),
            &["node", "tier"],
        ),
        tool(
            "orgtree_move",
            "Move an agent below you under another parent within your subtree.",
            json!({ "node": { "type": "string" }, "new_parent": { "type": "string" },
                    "moves": { "type": "array", "items": { "type": "object" },
                               "description": "several {node, new_parent} moves as one all-or-nothing act" } }),
            &[],
        ),
        tool("orgtree_rename", "Rename an agent below you.", json!({ "node": { "type": "string" }, "name": { "type": "string" } }), &["node", "name"]),
        tool(
            "orgtree_reorder",
            "Place a live descendant at a zero-based final index among its current live siblings. Remove it first, \
             then insert at index 0..remaining_count. Parent, scope and credits stay unchanged. Self, superior, peers \
             and unrelated agents are refused. orgtree_state_inspect exposes sibling_index/live_sibling_count.",
            json!({ "node": { "type": "string" }, "index": { "type": "integer", "minimum": 0 } }),
            &["node", "index"],
        ),
        tool(
            "orgtree_reallocate",
            "Give credits to (positive delta) or take unused credits from (negative) a report.",
            json!({ "node": { "type": "string" }, "delta": { "type": "integer" } }),
            &["node", "delta"],
        ),
        tool("orgtree_cheap_compact", "Restart an agent below you on a fresh session with a summary of the old one.", json!({ "node": { "type": "string" } }), &["node"]),
        tool(
            "orgtree_request_credits",
            "Ask the user for a larger credit grant.",
            json!({ "new_limit": { "type": "integer" }, "reason": { "type": "string" } }),
            &["new_limit", "reason"],
        ),
        tool(
            "orgtree_request_scope",
            "Ask the user for more folders, tools or permissions.",
            json!({ "items": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "type": "object", "properties": {
                        "kind": { "type": "string", "enum": ["dir", "tool", "mcp", "permission_mode"] },
                        "path": { "type": "string", "description": "dir: the absolute folder path" },
                        "mode": { "type": "string", "description": "dir: ro|rw; permission_mode: the mode" },
                        "tool": { "type": "string", "enum": ["bash", "web", "edit", "subagents", "orgtree.docket", "orgtree.team", "orgtree.messaging", "orgtree.inspection", "orgtree.watchdogs", "orgtree.runtime", "orgtree.user"] },
                        "server": { "type": "string", "description": "mcp: the server name" } }, "required": ["kind"] } },
                    "reason": { "type": "string" } }),
            &["items", "reason"],
        ),
        tool(
            "orgtree_audience",
            "Audiences let an agent write outside its chain of command. request: ask `target` (an agent, 'user', or \
             'extern' = the org inbox) for an audience; the request goes straight to that agent (or the user; an \
             org-inbox request to your top-level agent) for a yes or no, and the answer arrives as mail. grant: give \
             `from` an audience with you (a report, or anyone whose request waits on you), or via `target` with a \
             live peer, your direct superior, 'user' (if you are top-level) or 'extern' (outside @org:/@net: mail \
             reaches holders only; a top-level agent may grant it to itself). deny: decline a request waiting on \
             you (`from` = requester). revoke: rescind one you granted (`grantee`); an org-inbox holder may revoke \
             itself and a top-level agent any user or org-inbox grant in its subtree.",
            json!({ "action": { "type": "string", "enum": ["request", "grant", "deny", "revoke"] },
                    "target": { "type": "string", "description": "request: whom you seek; grant/revoke: the grantor when not you" },
                    "from": { "type": "string", "description": "grant: who receives it; deny: the requester" },
                    "grantee": { "type": "string", "description": "revoke: who holds it" },
                    "reason": { "type": "string" } }),
            &["action"],
        ),
        tool(
            "orgtree_watchdog",
            "Keep a WATCHDOG: a free, persistent watcher that mails you (waking you) when its target produces a \
             matching event. It survives orgtree restarts, so use it instead of polling for 'tell me when X happens'. \
             Kinds: file (poll a path; new matching content fires; downtime events recovered), command (run each \
             interval; matching output fires), process (pid:N or port:N; fires when it goes DOWN), stream (a \
             persistent command such as a tail; each matching line fires at once; downtime output lost), activity \
             (target = your name or any descendant's; events: turn_started, turn_done, tool_call NAME). \
             fire_mode='event' is the default. fire_mode='silence' requires quiet_period_s: fires after that many \
             seconds without a matching event; every match and every fire resets the timer. command/stream dogs run \
             with your authority (need bash) but NOT IN YOUR SHELL: on Windows the target runs in cmd.exe with the \
             engine's PATH (grep, sed, awk, $(...), $VAR and /tmp do not work; `find` is FIND.EXE) — write cmd \
             (findstr, dir /b, %VAR%, %TEMP%) or pass shell:\"bash\" (`bash -lc`, refused if bash is missing). \
             Create SMOKE-RUNS the target once and returns its output in `smoke` — read it. `list` shows checks_run, \
             last_check, last_output and health. A dog also mails you when its target goes quiet (a file stops \
             growing, a command cannot run, a pid already fired). notice:true fires passively (no turn). once:true \
             fires exactly once and removes itself — use it whenever the condition can happen only once and ALWAYS \
             when the pattern is a DEADLINE rather than an EDGE. Free; max 8 per agent. Actions: create, list, pause, \
             resume, remove (reason optional). Superiors may manage their subtree's dogs. \
             A dog's ID IS THE SLUG OF ITS NAME (lowercase letters, digits and dashes, e.g. build-watch): its mail \
             and `list` show it, and pause/resume/remove take it. A second dog of yours with the same name gets \
             build-watch-2, and a dog created without a name gets one from its kind and target. Dogs made before \
             keep their older ids. Two agents may each keep a build-watch: name a team member's dog as owner/id. \
             kind=event is pushed by the engine (no polling): target is a dotted name or prefix ending .*; \
             pattern matches only safe JSON payload. Current-state smoke does not fire. No offline replay; \
             recovered dogs see engine.started. Catalog: credentials.bridge.available/unavailable, \
             credentials.isolated/ready, engine.started; agent.hired/retired/rehired/halted/unhalted/frozen/unfrozen/moved/renamed/changed, \
             agent.settings.changed (field names only); turn.started/finished/failed/stalled/limited; \
             mail.waiting/delivered/changed; docket.created/status.changed/attention/question.answered; \
             account.signed_in/signed_out/limit.reached/limit.reset; hub.up/down/changed; credits.changed; \
             documents.created/updated/changed; audience.requested/granted/denied/revoked; cli.started/ready/cold/evicted; \
             agents.active/live. Agent/item/account events respect visibility. Count threshold is below N or at least N \
             (false-to-true crossing); counts exclude the watcher. event_scope subtree is default, org requires full visibility. \
             interval_s is a minimum fire gap (5s floor); bursts coalesce into bounded summaries. Storage failures retry with health diagnostics. Resume/restart refresh count baselines. Watchdog mail and its owner turn events never feed that owner's event dogs. Own cli.* events are excluded to prevent idle-eviction wake loops.",
            json!({
                "action": { "type": "string", "enum": ["create", "list", "pause", "resume", "remove"] },
                "name": { "type": "string", "description": "create: a short name, e.g. build-watch; its slug becomes the dog's id" },
                "kind": { "type": "string", "enum": ["file", "command", "process", "stream", "activity", "event"] },
                "fire_mode": { "type": "string", "enum": ["event", "silence"], "description": "create: on event (default), or after silence" },
                "threshold": {"type":"string","description":"event counts only: below N or at least N; fires only on false-to-true crossing, never repeatedly while satisfied"},
                "event_scope": {"type":"string","enum":["subtree","org"],"description":"count targets only: visible descendants (default), or org (requires full visibility); excludes the watcher"},
                "quiet_period_s": { "type": "integer", "minimum": 1, "description": "create, silence only: seconds without a matching event" },
                "target": { "type": "string", "description": "the path, command line, pid:N / port:N, (activity) agent name, or (event) dotted event name/prefix ending in .*" },
                "pattern": { "type": "string", "description": "regex an event line must match (required for command; optional for file/stream/activity = any line)" },
                "interval_s": { "type": "integer", "minimum": 5, "description": "poll cadence (floor 15s); stream/activity: the minimum gap between fires (floor 5s)" },
                "notice": { "type": "boolean", "description": "create: fire passively — the mail waits without starting a turn" },
                "once": { "type": "boolean", "description": "create: ONE-SHOT — fires once and removes itself" },
                "shell": { "type": "string", "enum": ["native", "bash"], "description": "create, command/stream only" },
                "id": { "type": "string", "description": "pause/resume/remove: the watchdog's id as `list` shows it (owner/id for a team member's dog)" },
                "reason": { "type": "string", "description": "remove: why (optional)" },
            }),
            &["action"],
        ),
        tool(
            "orgtree_work",
            "THE DOCKET: the org's durable record of substantive work, read by the user. Items survive retirement, \
             compaction and reassignment. An item is identified ONLY by its readable `slug` (fixed at creation). Access: \
             owner, creator, their superiors, the user, listed participants and the reviewer.\n\n\
             ACTIONS: `list` — items you may read; include_archived / include_backlogged return those in their own keys, \
             never inside `items` (`groups` gives every group's size). `get` — one item (compact by default; \
             projection=full adds history and attachments). `create` — title, REQUIRED objective, kind code|non-code, owner \
             (you or a subordinate), participants, dependencies, parent, optional first progress lists. `update` — THE \
             status update: carries done_so_far AND working_on_next (either may be empty, not both) plus optional status, \
             blocked_reason, dropped_reason, reviewer, attention, reopen. YOUR OWN UPDATE CLAIMS THE ITEM: on someone \
             else's item pass `owner` = its current holder. To avoid re-sending lists pass expected_rev with \
             keep_done/keep_next or done_append/next_append. `assign` — changes ownership ONLY, never status. `handoff` — \
             the owner asks its superior to take the item (ownership unchanged). `participants` — add/remove \
             collaborators; participants control state and evidence; retitling, re-scoping and assigning stay \
             owner-level. `evidence` (kind note|link|file|commit|log, ref, note; `items` for a batch; max 50, refused not \
             truncated). `accept` or status done — complete the item. `archive` (close early), `supersede` (by another \
             item: `by`), `move` (nest under `parent`), `delete` — permanently removes the record (its name is never \
             reused); only the user, a superior of the owner or a top-level owner, and refused while it has sub-items or \
             an open attached question. Prefer archive or dropped.\n\n\
             DESCRIPTION (`objective`): the FIRST PARAGRAPH states the PROBLEM, then briefly the solution; every later \
             paragraph carries the specifications, requirements, edge cases and rulings. It is the item's authoritative \
             standalone scope. Markdown, never truncated; `objective_append` adds to it.\n\n\
             STATUSES: backlogged (not yet approached or approved; not counted as active), open, in_progress, blocked \
             (needs blocked_reason; say how you will hear it is unblocked), review (checked by the agent named in \
             `reviewer`), approved, deploy_ready (complete, awaiting deployment), done, dropped (terminal non-success; \
             needs dropped_reason; archives at once). Done items archive an hour after their last update.\n\n\
             USER ATTENTION: `review` is never how you ask the user. A question goes through orgtree_ask with work_item; \
             attention:true + attention_reason is for something the user must see that is not a question. Omitting \
             `attention` leaves a standing flag in place: retract your own with attention:false, refine it with \
             attention_amend. A user dismissal keeps done/review and blocks other statuses; an exact repeat of a dismissed \
             flag is refused. The user's replies on an item go to its owner; question answers go to the asker.",
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
        ),
        tool(
            "orgtree_staff",
            "STAFF WORK IN ONE CALL: orgtree_work create (or update) + orgtree_hire (or rehire) + orgtree_work assign. \
             The seat is created first and the item is written with that agent as owner (assignment is ownership: it \
             holds the item and gets the user's replies). The assignment mail starts the agent; `kickoff` is optional. \
             Pass `node` to rehire an archived agent or omit it to hire. ⚠ `parent` here is the parent WORK ITEM; place \
             the seat with `target`/`hire_type`. For an already-live agent use orgtree_work assign; to give an existing \
             item to a new hire use orgtree_hire `work_item` (staffed backlog opens). Progress is optional here: \
             omit done_so_far and working_on_next to keep the stored lists (a 'staffed' line is written on a new item).",
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
        ),
        tool("orgtree_swap", "Swap the seats of two agents below you.", json!({ "a": { "type": "string" }, "b": { "type": "string" } }), &["a", "b"]),
        tool(
            "orgtree_self_subjugate",
            "Step down: one of your live descendants (target) takes your seat under your superior, keeping its own \
             team, and you become its report with the rest of yours.",
            json!({ "target": { "type": "string" } }),
            &["target"],
        ),
    ]
}

#[cfg(test)]
mod mail_shape_tests {
    use super::*;

    /// Antigravity keeps the mail tools of before the split (coordinator
    /// 2026-10-13 21:36Z), byte for byte as rust-engine 536184d served them,
    /// so its seats keep their tool prefix.
    #[test]
    fn the_flat_cards_are_the_cards_of_before_the_split() {
        let to = json!({ "anyOf": [
            { "type": "string" },
            { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10 },
        ], "description": "agent name, 'user', '@org:<slug>' or '@net:<slug>'; or a list of up to 10 of them" });
        let message = json!({
            "name": "orgtree_message",
            "description": "Send mail. You may write to your superior, your reports and their reports (writing to a non-child \
             descendant grants it an audience to reply), your peers, anyone who granted you an audience, 'user' \
             (top-level agents and holders of a user audience), another org's inbox '@org:<slug>', or a hub peer \
             '@net:<slug>'. The recipient is woken (notice: true stores it without waking). Replies arrive in your \
             later turns; never wait for them. `to` may be a LIST (up to 10) to send the same message to several \
             recipients in one call, e.g. [\"user\", \"@net:<their hub address>\"] to reach the user in their inbox \
             and over the hub at once: each recipient gets its own delivery, reach is checked per recipient, and the \
             result lists every recipient's outcome (refused ones are named with the reason; the rest still get it).",
            "inputSchema": { "type": "object", "properties": {
                "to": to.clone(),
                "body": { "type": "string" },
                "kind": { "type": "string", "enum": ["message", "question", "request", "decision", "status"] },
                "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
                "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                                 "description": "files to send, relative to your working folder or absolute" },
                "urgent": { "type": "boolean", "description": "RARELY; mail to the user only: their inbox pulses until read. Requires urgent_reason." },
                "urgent_reason": { "type": "string", "description": "one line for the user: why this interrupts them now" },
                "reply_to": { "type": "string", "description": "optional: the id of the message you are answering (the id that ends its FROM line; orgtree_inbox lists them). The recipient sees it quoted; over the mail hub (@net:) the reply also carries a link to it" },
                "replies": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 50, "description": "optional: all message ids this one answers, in order; reply_to, if also supplied, must match the first. Every id must be mail you received or sent. Each recipient sees only references belonging to that conversation." },
                "options": { "type": "array", "minItems": 2, "maxItems": 10, "items": { "type": "string" },
                             "description": "kind question to @net: addresses only: 2-10 preset answers (one line each, up to 100 characters). Hubchat shows them as buttons under the question; the answer comes back as mail with \"Answer: <option>\". The person can also reply in their own words, or skip (a reply with no text). Their first answer or skip is final: to ask again, send a new question" },
                "multiple": { "type": "boolean", "description": "with options: they may pick more than one" },
            }, "required": ["to", "body"] },
            "_meta": { "anthropic/alwaysLoad": true },
        });
        let notice = json!({
            "name": "orgtree_send_notice",
            "description": "Same as orgtree_message with notice: true — stored for the recipient's next turn, wakes nobody.",
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
            let desc = split["description"].as_str().unwrap();
            assert!(desc.starts_with(flat["description"].as_str().unwrap()) && desc.ends_with("metadata first, body last."), "{desc}");
        }
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
