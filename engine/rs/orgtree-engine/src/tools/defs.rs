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
        "orgtree_inbox",
        "orgtree_chart",
        "orgtree_state_inspect",
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
        "orgtree_request_credits",
        "orgtree_request_scope",
        "orgtree_hire",
        "orgtree_rehire",
        "orgtree_retire",
        "orgtree_dissolve",
        "orgtree_move",
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
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        // an agent's own hands are never deferred behind tool search
        "_meta": { "anthropic/alwaysLoad": true },
    })
}

const KINDS: &[&str] = &["message", "question", "request", "decision", "status"];

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
const EFFORT: &[&str] = &["low", "medium", "high", "xhigh", "max", ""];

#[logged]
fn scope_props() -> Value {
    json!({
        "add_dirs": { "type": "array", "items": { "type": "object", "properties": {
            "path": { "type": "string" }, "mode": { "type": "string", "enum": ["rw", "ro"] } }, "required": ["path"] },
            "description": "folders it may use (within yours)" },
        "tools": { "type": "object", "properties": {
            "bash": { "type": "boolean" }, "web": { "type": "boolean" }, "edit": { "type": "boolean" },
            "subagents": { "type": "boolean" }, "mcp": { "type": "array", "items": { "type": "string" } } } },
        "org_visibility": { "type": "string", "enum": VIS },
        "permission_mode": { "type": "string", "enum": PM },
        "effort": { "type": "string", "enum": EFFORT },
        "account": { "type": "string", "description": "provider account id (default: inherited)" },
        "account_fallback": { "type": "boolean", "description": "move to another account of the same provider when this one hits its usage limit" },
        "clear_account_fallback": { "type": "boolean" },
        "team_charter": { "type": "string", "description": "standing instructions for its whole team" },
    })
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
    vec![
        tool(
            "orgtree_message",
            "Send mail. You may write to your superior, your reports and their reports (writing to a non-child \
             descendant grants it an audience to reply), your peers, anyone who granted you an audience, 'user' \
             (top-level agents and holders of a user audience), another org's inbox '@org:<slug>', or a hub peer \
             '@net:<slug>'. The recipient is woken (notice: true stores it without waking). Replies arrive in your \
             later turns; never wait for them.",
            json!({
                "to": { "type": "string", "description": "agent name, 'user', '@org:<slug>' or '@net:<slug>'" },
                "body": { "type": "string" },
                "kind": { "type": "string", "enum": KINDS },
                "notice": { "type": "boolean", "description": "FYI only: stored, read at the recipient's next turn, wakes nobody" },
                "attachments": { "type": "array", "maxItems": 10, "items": { "type": "string" },
                                 "description": "files to send, relative to your working folder or absolute" },
                "urgent": { "type": "boolean", "description": "RARELY; mail to the user only: their inbox pulses until read. Requires urgent_reason." },
                "urgent_reason": { "type": "string", "description": "one line for the user: why this interrupts them now" },
            }),
            &["to", "body"],
        ),
        tool(
            "orgtree_send_notice",
            "Same as orgtree_message with notice: true — stored for the recipient's next turn, wakes nobody.",
            json!({ "to": { "type": "string" }, "body": { "type": "string" } }),
            &["to", "body"],
        ),
        tool(
            "orgtree_status",
            "Report your status. Required when you finish ('done') or get stuck ('blocked'): your superior gets \
             your summary as a notice. A status wakes nobody; to make your superior act, send a message.",
            json!({
                "status": { "type": "string", "enum": ["working", "done", "blocked", "idle"] },
                "summary": { "type": "string", "description": "one or two sentences" },
            }),
            &["status", "summary"],
        ),
        tool(
            "orgtree_inbox",
            "Your own mail. list: waiting and recent messages (ids, senders, previews). fetch: the full text of up \
             to 20 ids. Waiting mail is also delivered to you automatically.",
            json!({
                "action": { "type": "string", "enum": ["list", "fetch"] },
                "limit": { "type": "integer", "description": "list: how many (default 30, max 200)" },
                "message_ids": { "type": "array", "items": { "type": "string" }, "description": "fetch: ids from list" },
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
            "Structured state of agents within your visibility (no prompts, transcripts or mail).",
            json!({
                "node": { "type": "string" },
                "nodes": { "type": "array", "items": { "type": "string" } },
                "include_archived": { "type": "boolean" },
            }),
            &[],
        ),
        tool("orgtree_list_tiers", "Model tiers you can hire on, with seat prices in credits.", json!({}), &[]),
        tool("orgtree_list_orgs", "Other organizations on this machine (for '@org:<slug>' mail).", json!({}), &[]),
        tool(
            "orgtree_read_transcript",
            "Read the recent conversation of yourself or an agent below you.",
            json!({
                "node": { "type": "string" },
                "last": { "type": "integer", "minimum": 1, "maximum": 80, "description": "how many recent rows (default 20)" },
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
            "Read (inspect) or clear an account's usage-limit marks. Clearing adds no capacity and resumes nobody.",
            json!({
                "action": { "type": "string", "enum": ["inspect", "clear"] },
                "account": { "type": "string" },
                "pool": { "type": "string", "description": "clear: the mark's pool" },
                "reason": { "type": "string", "description": "clear: why (kept in the audit)" },
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
            "Present a document (plan, proposal, report) for the user to read: a card beside your seat opens it. \
             `body` is markdown (64 KB max), or `path` a self-contained .html mockup (4 MB max, shown sandboxed with \
             no network). `replaces` updates an earlier card in place. Needs a user audience (top-level agents hold one).",
            json!({ "title": { "type": "string" }, "body": { "type": "string" }, "path": { "type": "string" },
                    "replaces": { "type": "string" } }),
            &["title"],
        ),
        tool(
            "orgtree_send_file",
            "Deliver a file to the user as a download card in your chat (images show as the picture). Use it \
             whenever the user asks for a file. Relative paths start in your working folder.",
            json!({ "path": { "type": "string" }, "note": { "type": "string" } }),
            &["path"],
        ),
        tool(
            "orgtree_hire",
            "Hire a report under you or under `target` in your team (or, with hire_type 'superior', insert a \
             superior above `target`). Write its charter in full. Seat + grant must fit your free credits (with \
             credit cascade on, your chain is raised as needed). `kickoff` sends it a first message.",
            merge(
                json!({
                    "name": { "type": "string" }, "tier": { "type": "string" }, "grant": { "type": "integer" },
                    "charter": { "type": "string" }, "parent": { "type": "string" }, "target": { "type": "string" },
                    "hire_type": { "type": "string", "enum": ["subordinate", "superior"] },
                    "kickoff": { "type": "string", "description": "first message to send it" },
                    "kickoff_kind": { "type": "string", "enum": KINDS }, "work_item": { "type": "string" },
                }),
                scope_props(),
            ),
            &["name", "tier", "grant", "charter"],
        ),
        tool(
            "orgtree_rehire",
            "Bring a retired agent back with its context.",
            merge(
                json!({ "node": { "type": "string" }, "grant": { "type": "integer" }, "target": { "type": "string" },
                        "hire_type": { "type": "string", "enum": ["subordinate", "superior"] }, "name": { "type": "string" },
                        "charter": { "type": "string" }, "kickoff": { "type": "string" },
                        "kickoff_kind": { "type": "string", "enum": KINDS }, "work_item": { "type": "string" } }),
                scope_props(),
            ),
            &["node"],
        ),
        tool("orgtree_retire", "Retire an agent below you (it can be rehired later).", json!({ "node": { "type": "string" } }), &["node"]),
        tool("orgtree_dissolve", "Retire an agent below you together with its whole team.", json!({ "node": { "type": "string" } }), &["node"]),
        tool(
            "orgtree_retool",
            "Change an agent's scope (folders, tools, visibility, permission mode, effort, account) or charter.",
            merge(json!({ "node": { "type": "string" }, "charter": { "type": "string" } }), scope_props()),
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
                        "tool": { "type": "string", "enum": ["bash", "web", "edit", "subagents"] },
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
             resume, remove (reason optional). Superiors may manage their subtree's dogs.",
            json!({
                "action": { "type": "string", "enum": ["create", "list", "pause", "resume", "remove"] },
                "name": { "type": "string", "description": "create: a short name, e.g. build-watch" },
                "kind": { "type": "string", "enum": ["file", "command", "process", "stream", "activity"] },
                "fire_mode": { "type": "string", "enum": ["event", "silence"], "description": "create: on event (default), or after silence" },
                "quiet_period_s": { "type": "integer", "minimum": 1, "description": "create, silence only: seconds without a matching event" },
                "target": { "type": "string", "description": "the path, command line, pid:N / port:N, or (activity) agent name" },
                "pattern": { "type": "string", "description": "regex an event line must match (required for command; optional for file/stream/activity = any line)" },
                "interval_s": { "type": "integer", "minimum": 5, "description": "poll cadence (floor 15s); stream/activity: the minimum gap between fires (floor 5s)" },
                "notice": { "type": "boolean", "description": "create: fire passively — the mail waits without starting a turn" },
                "once": { "type": "boolean", "description": "create: ONE-SHOT — fires once and removes itself" },
                "shell": { "type": "string", "enum": ["native", "bash"], "description": "create, command/stream only" },
                "id": { "type": "string", "description": "pause/resume/remove: the watchdog id" },
                "reason": { "type": "string", "description": "remove: why (optional)" },
            }),
            &["action"],
        ),
        tool(
            "orgtree_work",
            "The work docket: list, get, create, update, assign, archive and move items.",
            json!({
                "action": { "type": "string", "enum": ["list", "get", "create", "update", "assign", "handoff", "participants",
                                                      "evidence", "archive", "supersede", "move", "delete"] },
                "slug": { "type": "string" }, "title": { "type": "string" }, "objective": { "type": "string" },
                "kind": { "type": "string" }, "owner": { "type": "string" }, "reviewer": { "type": "string" },
                "status": { "type": "string" }, "blocked_reason": { "type": "string" }, "dropped_reason": { "type": "string" },
                "attention": { "type": "boolean" }, "attention_reason": { "type": "string" },
                "done_so_far": { "type": "array", "items": { "type": "string" } },
                "working_on_next": { "type": "array", "items": { "type": "string" } },
                "participants": { "type": "array", "items": { "type": "string" } },
                "dependencies": { "type": "array", "items": { "type": "string" } }, "parent": { "type": "string" },
                "note": { "type": "string" }, "ref": { "type": "string" }, "include_archived": { "type": "boolean" },
                "expected_rev": { "type": "integer" },
            }),
            &["action"],
        ),
        tool(
            "orgtree_staff",
            "Create or update a docket item and hire (or rehire) its owner in one call.",
            merge(
                json!({ "action": { "type": "string", "enum": ["create", "update"] }, "slug": { "type": "string" },
                        "title": { "type": "string" }, "objective": { "type": "string" },
                        "staff_mode": { "type": "string", "enum": ["hire", "rehire"] }, "node": { "type": "string" },
                        "name": { "type": "string" }, "tier": { "type": "string" }, "grant": { "type": "integer" },
                        "charter": { "type": "string" }, "kickoff": { "type": "string" } }),
                scope_props(),
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
