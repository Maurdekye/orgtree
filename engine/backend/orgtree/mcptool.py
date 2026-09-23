# pyright: strict
"""The orgtree MCP server every agent node loads — its hands on the org.

A minimal, dependency-free MCP stdio server (JSON-RPC 2.0). Identity comes from env
(ORGTREE_ORG / ORGTREE_NODE, set by the supervisor at spawn); every call forwards to
the orgtree API on localhost with that identity as the actor, so the LEDGER enforces
authority, budgets, capability subsets, addressing rules, and the no-defaults hire
rule — the schemas here mirror those rules so agents see them up front.

Run: python -m orgtree.mcptool   (spawned by Claude Code via --mcp-config)
"""

from __future__ import annotations

import json
import os
import sys
import socket
import urllib.error
import urllib.request
from typing import Any, cast

if __package__:
    from . import deployment, opreceipts, workfields
else:
    # Sandboxed Claude runs this dependency-free server by its mounted file
    # path rather than with ``-m``. Preserve that supported entry point while
    # sharing the one authoritative policy parser.
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from orgtree import deployment, opreceipts, workfields

ORG: str = os.environ.get("ORGTREE_ORG", "")
NODE: str = os.environ.get("ORGTREE_NODE", "")
PORT: str = os.environ.get("ORGTREE_PORT", "7360")
# sandboxed kiosk orgs (containers) reach the backend through the bridge
# listener instead of loopback: an explicit base URL + the org's secret
BASE: str = os.environ.get("ORGTREE_BASE") or f"http://127.0.0.1:{PORT}"
BRIDGE_SECRET: str = os.environ.get("ORGTREE_BRIDGE_SECRET", "")

# ⚠ THE SHELL A WATCHDOG'S TARGET ACTUALLY GETS (2026-08-22).
#
# `supervisor._wd_popen` spawns command/stream dogs with `shell=True` and the
# BACKEND SERVICE's environment. On Windows that is cmd.exe with the service
# PATH — no Git usr\bin, so no grep/sed/awk/tr, no `$(...)`, no `$VAR`, no
# /tmp, and `find` is Windows FIND.EXE. This card previously said a dog "runs
# WITH YOUR HANDS (needs your bash)", agents reasonably read that as "write
# bash", and their dogs then matched nothing forever while reporting
# `state: armed, fired: 0` — which is also exactly what a healthy dog waiting
# on a condition reports. Three dogs on this machine were dead that way for
# up to nine days before anyone could tell.
#
# `os.name` here is the right proxy: this server runs beside the shell its
# dogs get — on the host for a host org, inside the container for a sandboxed
# one. Both idioms are spelled out anyway, so a wrong guess still leaves the
# reader informed rather than confidently mistaken.
_WD_SHELL_WARNING: str = (
    ("On Windows (THIS MACHINE) the target runs in cmd.exe with the backend "
     "service's PATH: grep, sed, awk, tr, $(...), $VAR and /tmp DO NOT WORK "
     "and `find` is FIND.EXE. Write cmd (findstr, dir /b, %VAR%, %TEMP%) or "
     "pass shell:\"bash\". "
     if os.name == "nt" else
     "The target runs in `sh` with the backend service's environment, not "
     "your interactive shell: no aliases, rc files or PATH additions, so use "
     "absolute paths. (On Windows hosts it is cmd.exe.) "))

def _cap(field: str) -> str:
    """The limit sentence for a BOUNDED docket field, in the tool card.

    ⚠ THE NUMBER IS READ FROM THE ONE CONTRACT (`workfields.LIMITS`), never
    typed here. An undocumented cap is how an agent ends up bisecting its way
    down to a length that fits — and a cap documented in two places is how it
    ends up trusting the stale one.
    """
    return (f" Max {workfields.limit_of(field)} chars; over it the whole "
            f"call is refused (nothing written), never truncated.")


#: the counterpart for the fields that have no limit at all
_NOCAP = " No length limit; never truncated."

# JSON-schema fragments/tool cards for the MCP wire — freeform JSON by nature
TOOLS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "bash": {"type": "boolean", "description": "terminal access"},
        "web": {"type": "boolean", "description": "web search + fetch"},
        "edit": {"type": "boolean", "description": "file editing"},
        "subagents": {"type": "boolean", "description": "ephemeral subagent (Task) tool"},
        "mcp": {"type": "array", "items": {"type": "string"},
                "description": "MCP server names to grant (must be ones YOU hold)"},
    },
    "required": ["bash", "web", "edit", "subagents", "mcp"],
}

# ⚠ ACCOUNT SELECTION — ONE DEFINITION, FOUR SURFACES (user decision
# 2026-09-12: "yes, the agent hire / rehire / retool tools should be able to
# decide which account to hire on").
#
# The backend has read `args["account"]` on the hire path for as long as the
# account registry has existed, and `supervisor.assign_account` has been the
# one writer for a rebind. NEITHER WAS IN ANY SCHEMA, so the field was
# reachable only by an agent that had read the source: the turn envelope told
# it which account had capacity, and nothing told it how to place work there.
# Exposing the field is the whole difference between guidance and an action.
#
# Managed IDs are shared by the UI and board. Primary's UI-only `default`
# token is explained here so every selector teaches the same accepted value.
_ACCOUNT_VALUE: str = (
    "Pass the immutable managed account ID or provider/primary selector from "
    "the `account=` roster of [PROVIDER USAGE] (e.g. `claude-4`, "
    "`openai/primary`). The UI's `account-id · email` display token "
    "`default` means provider/primary, never a new ID. `primary` = the "
    "tier's ambient account and clears a secondary binding; qualified "
    "primary names must match the target provider. Labels and emails never "
    "select billing. Unknown, wrong-provider or another org's restricted "
    "accounts are refused.")


ACCOUNT_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description":
        "Provider account this agent runs on. " + _ACCOUNT_VALUE
        + " Omit for the org default; '' leaves the seat unbound (ambient "
          "sign-in) — prefer `primary`.",
}

#: ⚠ THE CODEX SESSION BOUNDARY, stated wherever an EXISTING agent can be
#: moved. `CODEX_HOME` is never repointed under a live session, so a Codex
#: agent that changes Codex account cannot carry its thread across: its
#: pre-switch self is archived in place as a readable knowledge bearer
#: (`<node>@<gen>`) and it starts fresh. Saying so is the difference between
#: an agent choosing that cost and discovering it.
_ACCOUNT_BOUNDARY: str = (
    "A change starts a new provider cache namespace. Moving a Codex agent "
    "(even back to primary) is a SESSION BOUNDARY: its old self is archived "
    "as a readable knowledge bearer and it starts fresh; a no-op keeps the "
    "session. Use `primary` to clear a binding ('' only on new hires).")


#: The same field on the surface that rebinds a LIVE agent.
ACCOUNT_REBIND_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description":
        "REBIND this agent to another provider account. " + _ACCOUNT_VALUE
        + " Subordinates only, never yourself. If it is mid-turn the change "
          "is queued until the turn ends. "
        + _ACCOUNT_BOUNDARY,
}

#: …and on the surface that brings an ARCHIVED agent back. Omitted, the agent
#: returns on whatever account it was archived with — which is the behaviour a
#: rehire has always had, and is why this field defaults to changing nothing.
ACCOUNT_RESTORE_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description":
        "Provider account it comes back on; omit to keep the one it was "
        "archived with (which may be exhausted). " + _ACCOUNT_VALUE
        + " " + _ACCOUNT_BOUNDARY,
}

#: …and on `orgtree_staff`, which is whichever of the two its `staff_mode`
#: chose. It says so rather than describing one of them and hoping: staff
#: composes the same two helpers, so it must not be a route to an account
#: binding that either tool on its own would refuse.
ACCOUNT_STAFF_SCHEMA: dict[str, Any] = {
    "type": "string",
    "description":
        "Provider account for the staffed agent: orgtree_hire's `account` "
        "on a hire, orgtree_rehire's with staff_mode='rehire' (omit = the "
        "archived account). " + _ACCOUNT_VALUE + " " + _ACCOUNT_BOUNDARY,
}

#: The one `verify` sentence of the orgtree_work card. It is a separate
#: constant because the desktop-managed catalogue removes the `verify` action
#: and must remove exactly this sentence with it, leaving the rest of the card
#: intact (the old partition-based strip cut the card off after `verify`).
_WORK_VERIFY_SENTENCE: str = (
    "`verify` — checks a committed/pushed/in_build claim against this "
    "repository's git (object exists / ancestor of origin/main / ancestor of "
    "the booted commit); three-valued, never a functional check. ")

TOOLS: list[dict[str, Any]] = [
    {
        "name": "orgtree_message",
        "description": (
            "Send mail to another agent. Allowed recipients: any descendant "
             "(messaging a non-child descendant grants it an audience to reply), "
             "your superior, your peers, a superior you hold an audience with, "
             "'user' (top-level agents only), or an outside party: '@org:<slug>' "
             "(another org's inbox), '@mcp:<id>' (polling external chat), "
             "'@net:<slug>' (via the mail hub). A bare outside name resolves "
             "automatically (local first, then hub; ambiguous names are "
             "refused). Outside mail needs the ORG-INBOX audience (top-level "
             "agents get it automatically), goes out AS THE ORG, and should be "
             "one coordinated reply. The recipient is woken; replies arrive in "
             "your later turns. Archived recipients keep the mail until rehired."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "recipient node id, or 'user'"},
                "body": {"type": "string"},
                "kind": {"type": "string", "enum": ["message", "question", "request",
                                                    "decision", "status"],
                         "description": "what kind of message this is"},
                "attachments": {
                    "type": "array", "maxItems": 10,
                    "items": {"type": "string"},
                    "description": ("files to send with the mail, relative to "
                                    "your working folder. 'user' mail: download "
                                    "cards (images render), no product per-file "
                                    "byte cap; say what you attached. '@net:' "
                                    "peers: land in their uploads/, 25 MB "
                                    "per-file cap. For local agents use "
                                    "orgtree_send_file or give the path"),
                },
                "urgent": {
                    "type": "boolean",
                    "description": ("RARELY. 'user' mail only: their inbox "
                                    "pulses until read. Only when their "
                                    "attention is needed NOW and it is not a "
                                    "question for orgtree_ask; overuse trains "
                                    "them to ignore it. Requires urgent_reason."),
                },
                "urgent_reason": {
                    "type": "string",
                    "description": ("Required with urgent: one line shown to the "
                                    "user explaining why they are interrupted "
                                    "now. Written for them, not a mail summary."),
                },
            },
            "required": ["to", "body"],
        },
    },
    {
        "name": "orgtree_send_notice",
        "description": (
            "Send a PASSIVE notice: mail that never wakes anyone. The recipient "
             "reads it at the start of its next turn (or mid-turn if already "
             "running). Same addressing as orgtree_message but in-org agents "
             "only ('user' and outside addresses use orgtree_message). Use for "
             "FYIs and progress notes; expect NO reply. Anything needing action "
             "or an answer is an orgtree_message."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string",
                       "description": "recipient agent id (in this org)"},
                "body": {"type": "string"},
            },
            "required": ["to", "body"],
        },
    },
    {
        "name": "orgtree_rename",
        "description": (
            "Rename a descendant (its id, mailbox, folder and session move with "
             "it); never yourself or a peer. ⚠ Old mail and logs keep the old "
             "name and mail to the old name bounces — tell your team."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string", "description": "the agent to rename"},
                "name": {"type": "string", "description": "the new name"},
            },
            "required": ["node", "name"],
        },
    },
    {
        "name": "orgtree_ask",
        "description": (
            "Ask the USER a structured question. It ALWAYS parks: a card "
             "appears on your desk and in the user's inbox and the answer "
             "arrives later as mail, so ask and then END YOUR TURN; never wait "
             "or poll. Give 2-4 options, or omit `options` for a dedicated "
             "free-response question (free text is always allowed). Related "
             "questions go in ONE card via `questions` (1-4 tabs). You have ONE "
             "open request batch: asking again adds tabs (the same question text "
             "amends its tab), and credit/scope requests join the same card; all "
             "resolve at the user's single submit (skipped tabs return "
             "unanswered). Other mail does not void it; it ends only at that "
             "submit or orgtree_withdraw_ask. ⚠ Withdraw it yourself as soon as "
             "new information answers it or makes it moot. Without a user "
             "audience (and not top-level) it is mailed to your superior "
             "instead."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {"type": "string",
                             "description": "the complete question (single "
                                            "form; or use `questions`)"},
                "header": {"type": "string",
                           "description": "very short label chip (max ~12 "
                                          "chars), e.g. 'Approach'"},
                "options": {
                    "type": "array", "maxItems": 4,
                    "description": "2-4 answer options; omit this field when "
                                   "the question should be presented as a "
                                   "dedicated free-response field",
                    "items": {"type": "object", "properties": {
                        "label": {"type": "string",
                                  "description": "concise choice (1-5 words)"},
                        "description": {"type": "string",
                                        "description": "what picking it means"},
                    }, "required": ["label"]},
                },
                "multi": {"type": "boolean",
                          "description": "several options may be selected"},
                "work_item": {"type": "string",
                              "description": ("docket item slug this question is about; "
                                              "it shows on the item and holds the "
                                              "user's attention until answered or "
                                              "withdrawn (needs read on the item)")},
                "questions": {
                    "type": "array", "minItems": 1, "maxItems": 4,
                    "description": ("batch form: 1-4 questions as one tabbed "
                                    "card, answered together. Overrides the "
                                    "single-form fields"),
                    "items": {"type": "object", "properties": {
                        "question": {"type": "string"},
                        "header": {"type": "string",
                                   "description": "short tab label"},
                        "options": {"type": "array", "maxItems": 4,
                                    "description": "omit for a dedicated "
                                                   "free-response tab",
                                    "items": {"type": "object", "properties": {
                                        "label": {"type": "string"},
                                        "description": {"type": "string"},
                                    }, "required": ["label"]}},
                        "multi": {"type": "boolean"},
                        "work_item": {"type": "string",
                                      "description": "docket item this tab is about (per tab)"},
                    }, "required": ["question"]},
                },
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_work",
        "description": (
            ("THE DOCKET: the org's durable record of substantive work, read by "
            "the user. Items survive retirement, compaction and reassignment. "
            "An item is identified ONLY by its readable `slug` (fixed at "
            "creation; old `w########` ids are refused). Access: owner, "
            "creator, their superiors, the user and listed participants."
            "ACTIONS: `list` — items you may read; include_archived / "
            "include_backlogged return those in their own keys, never inside "
            "`items` (`groups` gives every group's size). `get` — one item "
            "(narrow with projection/fields). `create` — title, REQUIRED "
            "objective, kind code|non-code, owner (you or a subordinate), "
            "participants, acceptance, optional first progress lists. `update` "
            "— THE status update: always carries done_so_far AND "
            "working_on_next (either may be empty, not both) plus optional "
            "status, blocked_reason, dropped_reason, attention, reopen. YOUR "
            "OWN UPDATE CLAIMS THE ITEM: on someone else's item pass `owner` = "
            "its current holder. To avoid re-sending lists pass expected_rev "
            "with keep_done/keep_next or done_append/next_append. `assign` — "
            "changes ownership ONLY, never status (a backlogged item stays "
            "backlogged; to hand over and start, `update` with a status or use "
            "orgtree_staff). `handoff` — the owner asks its superior to take "
            "the item; ownership unchanged. `participants` — add/remove "
            "collaborators; participants have full state control (any status "
            "incl. done, dropped, reopen) plus evidence and questions; "
            "retitling, re-scoping and assigning stay owner-level. `decision` — "
            "record a ruling (text, optional supersedes) in the append-only "
            "scope record; a ruling put in done_so_far is lost at the next "
            "update. `evidence` (kind note|link|file|commit|log, ref, note; "
            "`items` for a batch; max 50, refused not truncated). `claim` — a "
            "delivery stage implemented|committed|pushed|deployed|in_build, "
            "with a sha where git-checkable. "
            + _WORK_VERIFY_SENTENCE
            + "`receipt` — a check with backend-captured provenance (candidate, "
            "checkout, command, execution, result) bound to the commit and a "
            "tree fingerprint, so dirty trees, half-applied rebases and stale "
            "logs are disclosed. `rangediff` — records all four endpoints of a "
            "rebase comparison. `receipts` — read them back with a staleness "
            "note computed now. `artifact` — record a file as immutable "
            "evidence; scope `named` limits it to you plus agents you `grant` "
            "it to (one file each; `revoke` ends it); `artifact_read` reads "
            "one. `finding` — raise a defect with a citable id; `dispose` "
            "records the decision (fixed|rejected|deferred|duplicate + reason), "
            "keeping earlier ones. `check` — mark acceptance condition `index` "
            "met with evidence_ref (`checks` = atomic batch). `accept`, or "
            "status done — complete the item (owner or participant). `review` — "
            "the named reviewer's decision (approve | approve_stage | changes). "
            "`review_request` / `review_grant` / `review_revoke` — peer review "
            "seats (see `reviewer`). `addendum` — correct "
            "done_so_far/working_on_next on a done or dropped item: needs a "
            "`note`, touches only the lists you pass, keeps status, acceptance "
            "and evidence; use reopen=true only when work genuinely resumes (it "
            "clears acceptance). `archive` (close early), `supersede` (by "
            "another item), `move` (nest under `parent`), `delete` — "
            "permanently removes the record (its name is never reused); only "
            "the user, a superior of the owner or a top-level owner, and "
            "refused while it has children or an open attached question. Prefer "
            "archive or dropped."
            "DESCRIPTION (`objective`): the FIRST PARAGRAPH states the PROBLEM, "
            "then briefly the solution; EVERY SUBSEQUENT PARAGRAPH carries all "
            "specifications, requirements, defaults, exclusions, edge cases and "
            "rulings. It is the item's AUTHORITATIVE STANDALONE SCOPE: "
            "acceptance conditions and mail may test or coordinate it but never "
            "stand in for it. Markdown, no length limit, never truncated. Omit "
            "only what the user has not specified and ask material gaps as an "
            "explicit question. Every change (objective or objective_append) is "
            "versioned in the append-only `scope` record with full "
            "before/after."
            "STATUSES: backlogged (not yet approached or approved; hidden from "
            "the active count — never reclassify started work), open, "
            "in_progress, blocked (needs blocked_reason; never nudged), review "
            "(review BY AGENTS; name a `reviewer`), deploy_ready "
            "(implementation complete, awaiting deployment; active and nudged), "
            "done, dropped (terminal non-success; needs dropped_reason; "
            "archives at once). `approved` is reachable only through a "
            "reviewer's approve_stage. Done items archive an hour after their "
            "last update."
            "USER ATTENTION: `review` is never how you ask the user. A question "
            "goes through orgtree_ask with work_item; attention:true + "
            "attention_reason is for something they must see that is not a "
            "question, and only when you decided beyond the spec, chose an edge "
            "case, filled a definition gap, or are blocked on them. Work that "
            "exactly matches the stated spec needs no user acceptance once "
            "agents verify it. Omitting `attention` leaves a standing flag in "
            "place: retract your own with attention:false, refine it with "
            "attention_amend. A user dismissal blocks the item and an exact "
            "repeat is refused. ⚠ `addendum` IS HOW YOU WITHDRAW A STALE "
            "ATTENTION FLAG on a done or dropped item (attention:false + "
            "`note`; nothing else changes). The user's replies on an item go to "
            "its owner; question answers go to the asker.")),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["list", "get", "create", "update", "addendum",
                           "assign", "handoff",
                           "review", "verdict", "candidate_verdict",
                           "integration_verdict", "review_verdict",
                           "review_request", "review_grant", "review_grants",
                           "review_revoke",
                           "participants", "evidence",
                                    "decision",
                                    "receipt", "rangediff", "receipts",
                                    "artifact", "artifact_read", "grant",
                                    "revoke", "finding", "dispose",
                                    "claim", "verify", "check", "accept",
                                    "archive", "supersede", "move",
                                    "delete"]},
                "slug": {"type": "string", "description": ("the item's readable name, e.g. "
                                                           "git-review-workspace (every action but "
                                                           "list/create). There is no other "
                                                           "identifier")},
                "include_archived": {"type": "boolean", "description": ("list: include archived items, returned "
                                                                        "in the `archived` key (not in `items`)")},
                "include_backlogged": {"type": "boolean", "description": ("list: include backlogged items, returned "
                                                                          "in the `backlogged` key (never in "
                                                                          "`items`)")},
                "projection": {"type": "string", "description": ("list/get: `summary` (identity and state; "
                                                                 "list default), `compact` (adds "
                                                                 "description and acceptance) or `full` "
                                                                 "(everything; get default). What is left "
                                                                 "out is declared in `omissions_how`")},
                "fields": {"type": "array", "items": {"type": "string"}, "description": ("list/get: return ONLY these fields per "
                                                                                         "item (list or comma-separated); `slug` "
                                                                                         "is always included. Unknown names are "
                                                                                         "refused with the valid list")},
                "compact": {"type": "boolean", "description": ("list/get: shorthand for "
                                                               "projection=compact")},
                "title": {"type": "string", "description": "create/update: short concrete title." + _cap("title")},
                "objective": {"type": "string", "description": "create (REQUIRED) / update: the item's description and authoritative "
                              "standalone scope — first paragraph the PROBLEM then the "
                              "solution; later paragraphs every other requirement and "
                              "ruling. Markdown." + _NOCAP},
                "kind": {"type": "string", "description": "create: code|non-code · evidence: note|link|file|commit|log"},
                "owner": {"type": "string", "description": ("create/assign: owner node (you or a "
                                                            "subordinate) · update: name the CURRENT "
                                                            "owner to keep it with them when updating "
                                                            "someone else's item")},
                "target": {"type": "string", "description": "handoff: the current owner's immediate superior; omitted means that superior (or the user for a top-level owner)"},
                "reason": {"type": "string", "description": "handoff: why the owner needs an upward handoff; this sends a request and does not change assignment"},
                "reviewer": {"type": "string", "description": ("update entering review: the agent that "
                                                               "will check the work (never the owner). "
                                                               "It gets read, evidence, the review "
                                                               "decision and participant-level state "
                                                               "control, but not ownership. ⚠ You may "
                                                               "name only yourself, your subtree or your "
                                                               "superior; a PEER needs a REVIEW SEAT "
                                                               "first: `review_request` asks the nearest "
                                                               "agent above you both, `review_grant` is "
                                                               "their answer, and each seat covers ONE "
                                                               "entry into review (a recheck after "
                                                               "`changes` needs a fresh grant). Also "
                                                               "names the reviewer for "
                                                               "review_request/review_grant/review_revoke")},
                "decision": {"type": "string", "enum": ["approve", "approve_stage", "changes"],
                             "description": ("review: `approve` completes the item "
                                             "(approved AND landed); `approve_stage` "
                                             "approves one exact commit (pass "
                                             "`candidate`) without completing it — the "
                                             "item goes to `approved` until landed; "
                                             "use it by default when the code is not "
                                             "on main yet. `changes` returns it to the "
                                             "owner as in_progress (say what in "
                                             "`note`)")},
                # ⚠ `candidate` IS DEFINED ONCE, further down, and it describes
                # all three of its uses there. It used to be declared twice in
                # this same dict literal — here and at the receipt block — and
                # Python keeps the LAST one silently, so this copy never
                # reached an agent: the verdict meaning of the field was
                # invisible in the published schema while looking present in
                # the source. Found while adding `approve_stage`, which cannot
                # work unless callers know the field exists.
                "candidate_sha": {"type": "string", "description": "verdict: alias for candidate"},
                "next_actor": {"type": "string", "description": "verdict: existing item holder who acts next; defaults to the owner"},
                "verdict": {"type": "string", "enum": ["approve", "changes"], "description": "verdict: alias for decision"},
                "review_candidate": {"type": "string", "description": "update: exact lowercase Git SHA included in the atomic review packet"},
                "review_note": {"type": "string", "description": "update entering review: review packet prose stored with the transition" + _NOCAP},
                "review_evidence": {"type": "array", "items": {"type": "object"}, "description": "update entering review: evidence refs stored atomically with review_note"},
                "participants": {"type": "array", "items": {"type": "string"},
                                 "description": "create: collaborator node ids"},
                "add": {"type": "array", "items": {"type": "string"}, "description": "participants: node ids to add"},
                "remove": {"type": "array", "items": {"type": "string"}, "description": "participants: node ids to drop"},
                "acceptance": {"type": "array", "items": {"type": "string"},
                               "description": "create/update: acceptance conditions, one testable sentence each. On "
                               "`update` it REWRITES the whole list (owner-level, never "
                               "empty), versioned in the `scope` record; changed "
                               "conditions lose their checks and must be re-checked."
                               + _cap("acceptance")},
                "dependencies": {"type": "array", "items": {"type": "string"},
                                 "description": "create: names of items this one depends on"},
                "done_so_far": {"type": "array", "items": {"type": "string"},
                                "description": "update (required) / create / addendum: what is complete, as individual "
                                "entries." + _cap("done_so_far") + " Put detail in `evidence`."},
                "working_on_next": {"type": "array", "items": {"type": "string"},
                                    "description": "update (required) / create / addendum: current and next steps, as "
                                    "individual entries." + _cap("working_on_next")},
                "status": {"type": "string",
                           "description": ("create/update: "
                                           "backlogged|open|in_progress|blocked|review|deploy_ready|dropped, "
                                           "and on update also done (any "
                                           "collaborator may complete). See the tool "
                                           "description for meanings. blocked needs "
                                           "blocked_reason (say how you will hear it "
                                           "is unblocked); dropped needs "
                                           "dropped_reason. You cannot set "
                                           "`approved` — only a reviewer's "
                                           "approve_stage reaches it; leave it by "
                                           "recording the landing and setting done")},
                "blocked_reason": {"type": "string", "description": "REQUIRED to enter blocked: what prevents progress, what would unblock "
                              "it, who can act. Blank is refused." + _cap("blocked_reason")},
                "dropped_reason": {"type": "string", "description": "REQUIRED to end as dropped: CANCELLED or FAILED UNRECOVERABLY, who "
                              "decided, and what would make it worth resuming. Blank is "
                              "refused." + _cap("dropped_reason")},
                "attention": {"type": "boolean",
                              "description": ("update: true raises the flag (needs "
                                              "attention_reason); false takes a "
                                              "standing flag down. ⚠ Omitting it leaves "
                                              "the flag as it is — retracting your own "
                                              "flag is your job. addendum: false "
                                              "retracts a stale flag on a done/dropped "
                                              "item (the `note` is the reason); true is "
                                              "refused there")},
                "attention_reason": {"type": "string", "description": "the concrete thing the user must see: what was asked vs. built, the "
                              "decision/edge case/definition you added, and the "
                              "confirmation wanted — not 'please approve'." + _cap("attention_reason")},
                "reopen": {"type": "boolean", "description": ("update: RESUME a closed item because "
                                                              "work restarted (clears the acceptance "
                                                              "record). Not for correcting the summary "
                                                              "of finished work — use `addendum`. May "
                                                              "carry done|dropped in the same call (a "
                                                              "reopen to dropped needs a fresh "
                                                              "dropped_reason)")},
                "stage": {"type": "string",
                          "description": "claim/verify: implemented|committed|pushed|deployed|in_build"},
                "ref": {"type": "string", "description": "claim: 7-40 lowercase hex sha · evidence: path/url/sha/log." + _cap("ref")
                        + " Prose goes in `note`."},
                "note": {"type": "string", "description": "free text for claim/evidence/check/accept/review; the reason for "
                          "review_request/grant/revoke; REQUIRED on addendum (what "
                          "happened after closing)." + _NOCAP},
                "index": {"type": "integer", "description": ("check: acceptance condition index "
                                                             "(0-based). REQUIRED for a single check "
                                                             "and in each `checks` element")},
                "evidence_ref": {"type": "string", "description": "check: what shows the condition is met (path/url/sha/log). REQUIRED "
                              "for check." + _cap("evidence_ref") + " Prose goes in `note`."},
                "classification": {"type": "string", "enum": ["met", "not_exercised", "environment_limited", "known_negative"],
                                    "description": ("check/evidence: "
                                                    "met|not_exercised|environment_limited|known_negative "
                                                    "(met and a successful known_negative "
                                                    "complete a condition). When supplied, "
                                                    "artifact, runner, execution and a "
                                                    "compatible result are REQUIRED")},
                "artifact": {"type": "string", "description": ("check/evidence: exact artifact name or "
                                                               "path measured (REQUIRED when "
                                                               "classification is supplied; e.g. a test "
                                                               "log, not an r1 id) · "
                                                               "artifact_read/grant/revoke: the artifact "
                                                               "record id (r1, r2…)")},
                "runner": {"type": "string", "description": ("check/evidence: runner or interpreter "
                                                             "identity (REQUIRED when classification "
                                                             "is supplied) · receipt: runner identity "
                                                             "if the command does not show it")},
                "gate": {"type": "string", "description": ("check: the exact gate a known-negative "
                                                           "control exercised (REQUIRED for "
                                                           "known_negative, with blocked_count)")},
                "blocked_count": {"type": "integer", "minimum": 0, "description": ("check: exact number of requests the gate "
                                                                                   "blocked (REQUIRED for known_negative, "
                                                                                   "with gate)")},
                "composition": {"type": "string", "description": ("check/evidence: composition surface "
                                                                  "(e.g. installer, script), especially "
                                                                  "when unit tests do not exercise it")},
                "by": {"type": "string", "description": "supersede: the replacing item's name"},
                # ---- W03. Every one of these is OPTIONAL: a call that omits
                # them behaves exactly as it did before they existed.
                "checks": {"type": "array", "items": {"type": "object"},
                           "description": ("check: an atomic BATCH [{index, "
                                           "evidence_ref, classification, artifact, "
                                           "runner, execution, result, gate, "
                                           "blocked_count, composition, note}]. A "
                                           "refusal lists every missing or invalid "
                                           "field across every element at once and "
                                           "writes nothing; success writes one "
                                           "history row. Not combinable with "
                                           "single-check fields; duplicate indexes "
                                           "refused")},
                "items": {"type": "array", "items": {"type": "object"},
                          "description": ("review_grant: item slugs to grant the "
                                          "seat on (or `slug` for one); validated "
                                          "as a group · evidence: an atomic BATCH "
                                          "[{kind, ref, note, execution}] written "
                                          "as one history row; not combinable with "
                                          "kind/ref/note. Receipts use the "
                                          "`receipt` action")},
                "text": {"type": "string", "description": "decision: the ruling, trade-off or constraint and enough of why that "
                          "nobody re-argues it." + _NOCAP},
                "supersedes": {"type": "integer", "description": ("decision: `seq` of the earlier scope "
                                                                  "record this ruling replaces (the old row "
                                                                  "keeps its text and gains a back-pointer)")},
                "expected_rev": {"type": "integer", "description": ("COMPARE-AND-SET on update, addendum, "
                                                                     "evidence, finding, dispose, artifact, "
                                                                     "grant, revoke, check and accept — AND NO "
                                                                     "OTHER ACTION: every other action REFUSES "
                                                                     "it (receipt and rangediff run their own "
                                                                     "compare-and-set). Pass the item `rev` "
                                                                     "you read; if it changed, the whole call "
                                                                     "is refused before any write. REQUIRED "
                                                                     "with "
                                                                     "keep_done/keep_next/done_append/next_append")},
                "objective_append": {"type": "string", "description": "update: text appended to the description instead of replacing it "
                              "(owner-level; not with `objective`); versioned in `scope`."
                              + _NOCAP},
                "keep_done": {"type": "boolean", "description": ("update/addendum: keep the stored "
                                                                 "done_so_far. Needs expected_rev")},
                "keep_next": {"type": "boolean", "description": ("update/addendum: keep the stored "
                                                                 "working_on_next. Needs expected_rev")},
                "done_append": {"type": "array", "items": {"type": "string"},
                                "description": ("update/addendum: entries appended to the "
                                                "stored done_so_far; the complete merged "
                                                "list is stored and returned (40-entry "
                                                "cap). Needs expected_rev")},
                "next_append": {"type": "array", "items": {"type": "string"},
                                "description": ("update/addendum: entries appended to the "
                                                "stored working_on_next, same rule. Needs "
                                                "expected_rev")},
                "attention_amend": {"type": "boolean", "description": ("update/addendum: edit the standing "
                                                                       "flag's reason in place (not a new raise, "
                                                                       "no new ping). Needs attention_reason; "
                                                                       "refused with no standing flag, with "
                                                                       "attention:true, or for a reason the user "
                                                                       "dismissed. On `addendum` it refines a "
                                                                       "flag on finished work")},
                # ── W08: verification receipts, scoped artifacts, findings ──
                "execution": {"type": "string",
                              "enum": ["independent", "owner_report",
                                       "source_inspection"],
                              "description": ("receipt/check/evidence (REQUIRED for "
                                              "check/evidence when classification is "
                                              "supplied): `independent` = you ran it "
                                              "and saw the result; `owner_report` = "
                                              "another agent's claim; "
                                              "`source_inspection` = you read "
                                              "code/output and ran nothing")},
                "result": {"type": "string",
                           "enum": ["passed", "expected_negative", "failed",
                                    "crashed", "not_executed"],
                           "description": ("receipt/check/evidence (REQUIRED for "
                                           "check/evidence when classification is "
                                           "supplied): `passed`; `expected_negative` "
                                           "= failed exactly as designed (a pass); "
                                           "`failed`; `crashed` = no verdict (died, "
                                           "timed out); `not_executed` = never ran, "
                                           "never a pass")},
                "candidate": {"type": "string", "description": ("exact commit, 7-40 lowercase hex. "
                                                                "receipt: the commit measured · verdict: "
                                                                "the candidate judged · review with "
                                                                "approve_stage: REQUIRED")},
                "base": {"type": "string", "description": ("receipt: the candidate's base commit "
                                                           "(default: its git parent)")},
                "checkout": {"type": "string", "description": ("receipt/rangediff: REQUIRED — the "
                                                               "worktree the check ran in (a directory "
                                                               "you hold); its commit, dirtiness and "
                                                               "rebase state are recorded")},
                "command": {"type": "array", "items": {"type": "string"},
                            "description": ("receipt: the argv actually run (a string "
                                            "is shell-split). Required for "
                                            "`independent`; include "
                                            "--repo-root/--tree to make the replay "
                                            "portable")},
                "logs": {"type": "array", "items": {"type": "string"},
                         "description": ("receipt: up to 8 captured log paths; "
                                         "encoding is detected (UTF-8/16) and a "
                                         "sha256 recorded; unreadable logs are "
                                         "disclosed")},
                "old_base": {"type": "string", "description": "rangediff: the base of the range BEFORE the rebase"},
                "old_tip": {"type": "string", "description": ("rangediff: the tip BEFORE the rebase "
                                                              "(the reviewed commit)")},
                "new_base": {"type": "string", "description": "rangediff: the base of the range AFTER the rebase"},
                "new_tip": {"type": "string", "description": ("rangediff: the tip AFTER the rebase "
                                                              "(what you intend to land)")},
                "path": {"type": "string", "description": ("artifact: the file to record as "
                                                           "immutable evidence; must be in your "
                                                           "working folder, the workspace or a "
                                                           "folder you hold")},
                "scope": {"type": "string", "enum": ["item", "named"],
                          "description": ("artifact: `item` (default) = anyone who "
                                          "can read the item; `named` = only you, "
                                          "agents you grant, and the user (not the "
                                          "owner by default)")},
                "grant_to": {"type": "array", "items": {"type": "string"},
                             "description": ("artifact: agents granted read of THIS "
                                             "ONE FILE (no item read, nothing else)")},
                "to": {"type": "string", "description": ("grant/revoke: the agent gaining or "
                                                         "losing read of that artifact; only the "
                                                         "agent that recorded it may grant or "
                                                         "revoke")},
                "detail": {"type": "string", "description": "finding: the diagnosis, reproduction and argument." + _NOCAP},
                "severity": {"type": "string", "description": "finding: your own severity word, free text (blocking, minor, question…)"},
                "finding": {"type": "string", "description": "dispose: the finding's id (f1, f2…)"},
                "disposition": {"type": "string",
                                "enum": ["open", "fixed", "rejected",
                                         "deferred", "duplicate"],
                                "description": ("dispose: the decision on the finding; "
                                                "anything but `open` needs a `note` "
                                                "saying why. Earlier decisions are kept")},
                "parent": {"type": "string", "description": ("create/move: item to nest under ('' on "
                                                             "move = top level). Nesting grants and "
                                                             "inherits nothing")},
            },
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_withdraw_ask",
        "description": (
            "Withdraw your whole active request batch (all question tabs plus "
             "any pending credit and scope requests); re-ask what still matters "
             "afterwards. Do it as soon as new information answers it or makes "
             "it moot — a dead card is a chore on the user's screen. No answer "
             "will arrive. No-op if nothing is open. A request otherwise ends "
             "only when the user answers/dismisses it or you pose a new one."),
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "orgtree_self_restart",
        "description": (
            "Deploy THIS MACHINE's orgtree backend and/or mail hub from the "
             "repo's CURRENT committed state (git pull --ff-only + rebuild + "
             "restart), including unpushed local commits; it rebuilds and "
             "restarts even if the pull brings nothing. target: 'org' (⚠ "
             "RESTARTS EVERY ORG here; your turn may be cut), 'mailhub' "
             "(rebuilds the hub container; its data volume, ports and .env are "
             "never touched) or 'both'. Runs detached and returns a log path; "
             "your own next turn is the liveness check. No automatic rollback — "
             "tell the user if it misbehaves. Top-level agents and user-audience "
             "holders only; kiosks sealed; one launch per 5 minutes per machine. "
             "⚠ 'org'/'both' REFUSES while any agent is mid-turn and names them: "
             "wait, or arm orgtree_prime_restart, which fires when the machine "
             "goes quiet. force=true (needs `reason`) STOPS every working agent, "
             "waits for their turns to end, then deploys; they come back idle "
             "and do NOT resume — you must message them. Always use this tool, "
             "never run update.ps1/update.sh from your own shell (the restart "
             "kills that shell mid-build). Only restart for a real reason "
             "(committed code to run, a backend to bounce). This is a backend "
             "deployment operation; it does not update any installed Electron "
             "desktop application — use the tray's Update now action or the "
             "Windows installer for that."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string",
                           "enum": ["org", "mailhub", "both"],
                           "description": "what to update (default 'org')"},
                # ⚠ NO DEFAULT AND NO CLEVERNESS: absent means false, which
                # means today's refusal. The only way to force is to write
                # force=true AND say why — see ledger.self_restart_checks.
                "force": {"type": "boolean",
                          "description": "DANGEROUS, default false. Deploy "
                                         "even though agents are mid-turn, by "
                                         "STOPPING them first and waiting for "
                                         "their turns to settle. Requires "
                                         "`reason`. They come back idle and do "
                                         "NOT resume on their own — you have "
                                         "to message them afterwards."},
                "reason": {"type": "string",
                           "description": "REQUIRED with force=true: why this "
                                          "could not wait. Recorded against "
                                          "you, and it is what the "
                                          "interrupted agents' managers read."},
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_prime_restart",
        "description": (
            "ARM a restart that fires by itself once this machine is quiet (no "
             "agent mid-turn or holding queued mail, for a short settling "
             "period) — the deferred form of orgtree_self_restart, with the same "
             "targets and authority. Use it instead of planning to 'call again "
             "later': an armed prime survives your compaction, retirement and "
             "backend bounces. action: 'arm' (default), 'cancel', 'status'. "
             "Arming is idempotent: an existing prime (and its target) is kept "
             "and its owner named. Every org shows a 'restart primed' chip while "
             "armed. target: 'org' (restarts every org here), 'mailhub', or "
             "'both'. Give a one-line `reason`. Prefer this over self_restart "
             "force=true, which interrupts working agents now. ⚠ Optional "
             "deadline_minutes (5-1440, needs `reason`): if the machine is not "
             "quiet by then, it ESCALATES unattended like force — stops working "
             "agents, deploys, and wakes them on the new build (a turn each, "
             "charged to their orgs). Without it a prime waits forever. "
             "Top-level agents and user-audience holders only; kiosks sealed. "
             "Still a real restart: have a reason. This is a backend deployment "
             "operation; it does not update any installed Electron desktop "
             "application — use the tray's Update now action or the Windows "
             "installer."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["arm", "cancel", "status"],
                           "description": "arm (default), cancel, or status"},
                "target": {"type": "string",
                           "enum": ["org", "mailhub", "both"],
                           "description": "what to deploy (default 'org')"},
                "reason": {"type": "string",
                           "description": "why — shown on the chip and in "
                                          "the record; keep it one line"},
                # ⚠ NO DEFAULT. Absent means "wait for quiet, however long
                # that takes" — FR-27's behaviour, unchanged. A default here
                # would put a scheduled forced deploy on every prime ever
                # armed, which nobody asked for.
                "deadline_minutes": {
                    "type": "integer",
                    "description": ("OPTIONAL, off by default. Force the deploy "
                                    "if not quiet within this many minutes "
                                    "(5-1440). Requires `reason`. Stops working "
                                    "agents and wakes them on the new build, "
                                    "unattended.")},
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_restart_wake",
        "description": (
            "Arm a one-shot WAKING turn for you (or a subordinate via `target`) "
             "on the next orgtree restart, instead of the passive restart "
             "notice; the wake names the deployed version so you can verify "
             "fixes. Survives compaction; re-arm after waking if needed again. "
             "action: 'arm' (default), 'cancel', 'status'. `reason` is carried "
             "into the wake turn."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["arm", "cancel", "status"],
                    "description": "arm (default), cancel, or status",
                },
                "reason": {
                    "type": "string",
                    "description": "why — carried forward to the waking turn and survives compaction",
                },
                "target": {
                    "type": "string",
                    "description": "subordinate node id (default: yourself)",
                },
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_present",
        "description": (
            "Present a DOCUMENT (plan, proposal, report) for the user to read "
             "in-page: a card beside your node opens it in a reader. Not a "
             "download (use orgtree_send_file). Needs a DIRECT user audience "
             "(top-level or granted); others are refused — send it to your "
             "superior instead. Non-blocking; no reply implied. `body`: markdown "
             "≤64 KB; relative images (![](outbox/chart.png)) resolve against "
             "your working folder. Pass `replaces` with a returned id to update "
             "a card in place. Or pass `path`: a .html/.htm mockup (≤4 MB) in a "
             "folder you hold, snapshotted and opened in a sandboxed tab with NO "
             "network (inline all CSS/JS/fonts/images) and no access to orgtree."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string",
                          "description": "short document title (the card "
                                         "label)"},
                "body": {"type": "string",
                         "description": "the document, as markdown (≤64 KB). "
                                        "Exactly one of body | path"},
                "path": {"type": "string",
                         "description": "a self-contained .html/.htm mockup "
                                        "to present instead of a markdown "
                                        "body (≤4 MB, no network at "
                                        "render time). Exactly one of "
                                        "body | path"},
                "replaces": {"type": "string",
                             "description": "id of an earlier presentation "
                                            "to update in place"},
            },
            "required": ["title"],
        },
    },
    {
        "name": "orgtree_submit_report",
        "description": (
            "Submit one report through the chain. It always goes to your direct "
             "superior. If you are top-level or hold a DIRECT user audience it "
             "also creates one immutable user presentation; otherwise your "
             "superior gets a scoped forwarding action and no user presentation "
             "is created. You may cite W08 artifacts (work item + artifact id) "
             "only if you can already read them; citing never grants access. "
             "Returns the presentation reference (if any), mail reference and "
             "delivery receipt."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "short report title"},
                "body": {"type": "string", "description": "report body in markdown"},
                "artifacts": {
                    "type": "array", "maxItems": 20,
                    "description": "scoped W08 citations; each object has work_item and artifact",
                    "items": {
                        "type": "object",
                        "properties": {
                            "work_item": {"type": "string"},
                            "artifact": {"type": "string"},
                        },
                        "required": ["work_item", "artifact"],
                    },
                },
            },
            "required": ["title", "body"],
        },
    },
    {
        "name": "orgtree_request_credits",
        "description": (
            "Ask the user for a larger credit grant (top-level agents and "
             "user-audience holders only). Creates a request card, not mail. "
             "State the requested NEW TOTAL (not the increase) and a concrete "
             "reason. The user may grant more, less or even reduce your grant; "
             "the decision arrives as mail. Refused with no card if zero credits "
             "exist to grant. It stays pending across turns as a tab of your ONE "
             "open request batch (asking again amends the figure) and ends at "
             "the user's submit or orgtree_withdraw_ask."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "new_limit": {"type": "integer", "minimum": 1,
                              "description": "the requested new TOTAL grant"},
                "reason": {"type": "string",
                           "description": "why you need it — required"},
            },
            "required": ["new_limit", "reason"],
        },
    },
    {
        "name": "orgtree_request_scope",
        "description": (
            "Ask the USER for scope nobody below them holds: a folder, a "
             "built-in tool (bash, web, edit, subagents), an MCP server, or a "
             "higher permission mode. If your superior already holds it, ask "
             "them instead (orgtree_retool). Items join your ONE open request "
             "batch (re-requests merge); the user decides each item at one "
             "submit, the outcome arrives as mail, and grants apply from your "
             "next turn. Items you already hold are dropped. Without a user "
             "audience (and not top-level) it is mailed to your superior. It "
             "parks: request, then END YOUR TURN."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array", "minItems": 1, "maxItems": 8,
                    "description": "what you are asking for — each item is "
                                   "one concrete grant",
                    "items": {"type": "object", "properties": {
                        "kind": {"type": "string",
                                 "enum": ["dir", "tool", "mcp",
                                          "permission_mode"]},
                        "path": {"type": "string",
                                 "description": "dir: the absolute folder "
                                                "path"},
                        "mode": {"type": "string",
                                 "description": "dir: ro|rw (default rw); "
                                                "permission_mode: plan|"
                                                "default|acceptEdits|"
                                                "bypassPermissions"},
                        "tool": {"type": "string",
                                 "enum": ["bash", "web", "edit",
                                          "subagents"],
                                 "description": "tool: which built-in "
                                                "switch"},
                        "server": {"type": "string",
                                   "description": "mcp: the server name"},
                    }, "required": ["kind"]},
                },
                "reason": {"type": "string",
                           "description": "what the access is for — "
                                          "required"},
            },
            "required": ["items", "reason"],
        },
    },
    {
        "name": "orgtree_reservation",
        "description": (
            "Reserve a shared resource with durable candidate/base identity. "
             "Actions: acquire, renew, recover, release, overlap, land, list, "
             "landing, invalidate. Paths are declarations only and never grant "
             "file access; an integration_key makes retries idempotent. LANDING "
             "SLOT: to serialize merges onto a shared branch, `acquire` "
             "resource='main' with `base` = the commit you rebased onto and "
             "`candidate` = the commit to land. One holder at a time; others are "
             "refused and told who holds it until when. `list` with the resource "
             "shows the holder to anyone. Renew while working, `land` after the "
             "push, `release` when done (a `successor` is woken). A dead "
             "holder's slot can be recovered once its heartbeat is quiet (at "
             "once if it is no longer live, else after the lease). An empty "
             "store is empty, not broken."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": [
                    "acquire", "renew", "recover", "release", "overlap",
                    "land", "list", "landing", "invalidate"]},
                "reservation": {"type": "string"},
                "item": {"type": "string"},
                "resource": {"type": "string"},
                "candidate": {"type": "string", "description": "7-40 lowercase hex commit SHA"},
                "base": {"type": "string", "description": "7-40 lowercase hex commit SHA"},
                "paths": {"type": "array", "items": {"type": "string"},
                          "maxItems": 128},
                "lease_s": {"type": "number"},
                "stale_s": {"type": "number"},
                "integration_key": {"type": "string"},
                "successor": {"type": "string"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_resource_reservation",
        "description": "Alias of orgtree_reservation.",
        "inputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string"}},
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_watchdog",
        "description": (
            (
            "Keep a WATCHDOG: a free, persistent watcher that mails you (waking "
            "you) when its target produces a matching event. It survives orgtree "
            "restarts, so use it instead of polling for 'tell me when X "
            "happens'. Kinds: file (poll a path; new matching content fires; "
            "downtime events recovered), command (run each interval; matching "
            "output fires), process (pid:N or port:N; fires when it goes DOWN), "
            "stream (a persistent command such as a tail; each matching line "
            "fires at once; downtime output lost). command/stream dogs run with "
            "your authority (need bash; inside your sandbox if any) but ⚠ NOT IN "
            "YOUR SHELL. " + _WD_SHELL_WARNING +
            "shell:\"bash\" uses `bash -lc` and is refused at create if bash is "
            "missing. Create SMOKE-RUNS the target once and returns output and "
            "exit code in `smoke` — read it. `list` shows checks_run, "
            "last_check, last_output and health. A dog also mails you when its "
            "target goes quiet (a file stops growing, a command cannot run, a "
            "pid already fired); for a file that means check the producer. "
            "Prefer a process dog on the producer's pid over a file dog on its "
            "log. notice:true fires passively (no turn). ⚠ once:true fires "
            "exactly once and removes itself — use it whenever the condition "
            "can happen only once and ALWAYS when the pattern is a DEADLINE "
            "('READY=yes', 'ELAPSED>24h') rather than an EDGE ('BUILD FAILED' "
            "appearing): a deadline stays true and a persistent dog re-fires "
            "every interval forever. Otherwise remove the dog when you act on "
            "its first fire. Free; max 8 per agent (a fired one-shot frees its "
            "slot). Actions: create, list, pause, resume, remove, supersede "
            "(cancels an obsolete wait; needs reason). Superiors may manage "
            "their subtree's dogs.")),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["create", "list", "pause", "resume",
                                    "remove", "supersede"]},
                "name": {"type": "string",
                         "description": "create: a short name, e.g. "
                                        "build-watch"},
                "kind": {"type": "string",
                         "enum": ["file", "command", "process", "stream"]},
                "target": {"type": "string",
                           "description": "the path, command line, or "
                                          "pid:N / port:N. ⚠ command/stream: "
                                          + _WD_SHELL_WARNING},
                "pattern": {"type": "string",
                            "description": "regex an event line must match "
                                           "(required for command; optional "
                                           "for file/stream = any line)"},
                "interval_s": {"type": "integer", "minimum": 5,
                               "description": "poll cadence (floor 15s); "
                                              "for stream: the minimum gap "
                                              "between fires (floor 5s)"},
                "notice": {"type": "boolean",
                           "description": ("create: fire passively — the event lands "
                                           "in your mailbox without starting a turn "
                                           "(default false = wakes you)")},
                "once": {"type": "boolean",
                         "description": ("create: ONE-SHOT — fires once and "
                                         "removes itself (default false = watches "
                                         "forever). Use whenever the condition "
                                         "happens only once, and ALWAYS when the "
                                         "pattern is a DEADLINE rather than an "
                                         "EDGE. Any kind; combines with notice")},
                "shell": {"type": "string", "enum": ["native", "bash"],
                          "description": ("create, command/stream only: \"native\" "
                                          "(default; cmd.exe on Windows) or \"bash\" "
                                          "(`bash -lc`; refused at create if bash "
                                          "is not installed)")},
                "id": {"type": "string",
                       "description": "pause/resume/remove/supersede: the watchdog id"},
                "reason": {"type": "string",
                           "description": "supersede (or optional remove): durable cancellation reason"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_hire",
        "description": (
            "Hire an agent under you or anywhere in your subtree (`target`), or "
             "INSERT a superior above a seat in your subtree "
             "(hire_type='superior'). No defaults: write the CHARTER in full "
             "(role and standing instructions, shown every turn). An ordinary "
             "hire MUST state add_dirs, tools and org_visibility, and you cannot "
             "grant what you do not hold; a superior insertion MUST OMIT "
             "add_dirs, tools, org_visibility and permission_mode (it takes the "
             "target's). Seat costs: haiku 1, sonnet 2, opus 4, fable 10 "
             "(Claude); luna 0.1, terra 2, sol 2 (Codex, needs the Codex CLI "
             "signed in; luna uses reserve capacity first when available); flash "
             "1, pro 2 (Antigravity, needs its CLI signed in). Seat + grant must "
             "fit your free credits. `account` chooses which signed-in provider "
             "account it runs on (id from the `accounts:` roster of [PROVIDER "
             "USAGE]; omit for the org default). The same call can set "
             "permission_mode (SET IT), effort, team_charter, `audiences` and a "
             "`kickoff`; they apply in that order with kickoff last, and any "
             "refusal refuses the whole call. ⚠ Without `kickoff` (or "
             "`work_item`) the hire sits IDLE until it gets a message."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "1-2 words, the node id"},
                "tier": {"type": "string",
                         "description": "tier id from orgtree_list_tiers; "
                                        "the backend rechecks availability, "
                                        "scope and credits before hiring"},
                "grant": {"type": "integer", "minimum": 0,
                          "description": "credits it may spend on ITS OWN hires"},
                "charter": {"type": "string",
                            "description": "the hire's role + standing "
                                           "instructions, written in full — "
                                           "required"},
                "add_dirs": {"type": "array",
                             "items": {"type": "object",
                                       "properties": {"path": {"type": "string"},
                                                      "mode": {"type": "string",
                                                               "enum": ["rw", "ro"]}},
                                       "required": ["path", "mode"]},
                             "description":
                                 "folder grants; [] means scratch-only. "
                                 "REQUIRED for an ordinary (subordinate) "
                                 "hire; MUST BE OMITTED for hire_type="
                                 "'superior' (the seat takes the target's)"},
                "tools": {**TOOLS_SCHEMA,
                          "description":
                              "every switch stated explicitly. REQUIRED for "
                              "an ordinary (subordinate) hire; MUST BE "
                              "OMITTED for hire_type='superior' (the seat "
                              "takes the target's)"},
                "org_visibility": {"type": "string",
                                   "enum": ["self", "team", "subtree", "full"],
                                   "description":
                                       "REQUIRED for an ordinary "
                                       "(subordinate) hire; MUST BE OMITTED "
                                       "for hire_type='superior' (the seat "
                                       "takes the target's)"},
                "parent": {"type": "string",
                           "description": "the older spelling of `target` — "
                                          "still honoured; omit to hire "
                                          "directly under yourself"},
                "target": {"type": "string",
                           "description": "WHERE the seat goes: yourself "
                                          "(default) or any live agent in "
                                          "your subtree — never anything "
                                          "outside it"},
                "hire_type": {
                    "type": "string", "enum": ["subordinate", "superior"],
                    "description":
                        ("'subordinate' (default) = a report of `target`. "
                         "'superior' = INSERT ABOVE the target: it takes the "
                         "target's place and the target's team becomes its "
                         "report. ⚠ Then OMIT add_dirs, tools, org_visibility "
                         "and permission_mode (passing any, even equal values, "
                         "is refused); retool afterwards to narrow. Costs the "
                         "same as an ordinary hire. With target=yourself it "
                         "seats your replacement above you; above a TOP-LEVEL "
                         "target only the user may do it.")},
                # D-160 — the retool-only trio, now settable at hire. Same
                # rules retool enforces (it IS retool underneath): capped at
                # your own, and you cannot grant what you do not hold.
                "permission_mode": {
                    "type": "string",
                    "enum": ["plan", "default", "acceptEdits",
                             "bypassPermissions"],
                    "description":
                        ("SET THIS: 'default' ASKS, and a headless turn has "
                         "nobody to answer, so the hire cannot act. "
                         "'acceptEdits' = normal working seat; 'plan' = "
                         "read-only planning; 'bypassPermissions' asks nothing, "
                         "is the only mode that can write a .claude path, and "
                         "removes guardrails on every path — grant only when "
                         "needed and say why. CAPPED AT YOUR OWN.")},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort for the hire — a "
                                          "cost/quality dial ('' = the CLI "
                                          "default)"},
                "account": ACCOUNT_SCHEMA,
                "account_fallback": {"type": "boolean",
                    "description": "override this agent's org default for automatic account switching after a usage limit. Default off; verified same-lane subscription capacity only; keeps the replacement account."},
                "clear_account_fallback": {"type": "boolean",
                    "description": "clear the override and follow the org default again"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": ("luna only: use OpenAI reserve capacity "
                                    "first (true, default) or the normal weekly "
                                    "usage first (false); the other pool is the "
                                    "fallback")},
                "team_charter": {"type": "string",
                                 "description": "standing instructions binding "
                                                "the hire's OWN subtree — set "
                                                "it if it will hire in turn"},
                "audiences": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description":
                        ("audiences to grant at hire, same rules as "
                         "orgtree_audience grant: 'user' (only if you are "
                         "top-level), 'extern' (the org inbox), your own id, a "
                         "live peer, or your direct superior. A target you could "
                         "not grant refuses the whole hire")},
                "kickoff": {
                    "type": "string",
                    "description":
                        ("the hire's FIRST TASK (what to do now; the charter is "
                         "who it is). Delivered after scope, mode and audiences "
                         "are set. Omit it and the agent sits idle")},
                "kickoff_kind": {"type": "string",
                                 "enum": ["message", "question", "request",
                                          "decision", "status"],
                                 "description": "kind of the kickoff mail "
                                                "(default 'request')"},
                "work_item": {
                    "type": "string",
                    "description":
                        ("docket item slug to ASSIGN to the hire in this call "
                         "(assignment is ownership). The assignment mail starts "
                         "the agent even without a kickoff. Use orgtree_staff if "
                         "the item does not exist yet")},
                "review_items": {
                    "type": "array", "items": {"type": "string"},
                    "description": "hire: review item slugs granted to this seat before kickoff; the group is atomic"},
            },
            # add_dirs / tools / org_visibility are deliberately NOT here:
            # they are REQUIRED in subordinate mode and FORBIDDEN in
            # superior mode, and a flat `required` list cannot say that. A
            # client that enforced the old list could never construct a
            # superior insertion at all (Astra audit 2026-09-04, §11). The
            # per-mode rule is enforced at the API door and in the ledger —
            # the schema is the honest surface of it, not the enforcement.
            # test_hire_schema_contract.py holds both halves to it.
            "required": ["name", "tier", "grant", "charter"],
        },
    },
    {
        "name": "orgtree_retool",
        "description": (
            "Re-scope an agent anywhere in your subtree: folders, tools, MCP "
             "servers, org visibility, permission mode, charter, team charter, "
             "effort, or the provider `account` it runs on (a rebind; see that "
             "field for the Codex session cost). Only fields you pass change. "
             "You cannot grant what you do not hold, and shrinking a grant "
             "clamps everything beneath the target. ON YOURSELF only "
             "team_charter is allowed; ask your superior for changes to your own "
             "charter, scope, tools or mode. An account change on a mid-turn "
             "agent is queued until its turn ends (a later request replaces it; "
             "requesting the current account cancels it); the result reports "
             "`queued`, `pending_account` and `replaced`."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string", "description": "the agent to re-scope"},
                "add_dirs": {"type": "array",
                             "items": {"type": "object",
                                       "properties": {"path": {"type": "string"},
                                                      "mode": {"type": "string",
                                                               "enum": ["rw", "ro"]}},
                                       "required": ["path", "mode"]},
                             "description": "REPLACES its folder grants when passed"},
                "tools": TOOLS_SCHEMA,
                "org_visibility": {"type": "string",
                                   "enum": ["self", "team", "subtree", "full"]},
                "permission_mode": {
                    "type": "string",
                    "enum": ["plan", "default", "acceptEdits",
                             "bypassPermissions"],
                    "description":
                        ("'plan' = read-only planning; 'default' asks (fails "
                         "headless); 'acceptEdits' = normal seat; "
                         "'bypassPermissions' asks nothing and is the only mode "
                         "that can write a .claude path. CAPPED AT YOUR OWN, and "
                         "lowering yours lowers your subtree. bypassPermissions "
                         "removes guardrails on every path: use only when the "
                         "work needs it and say why.")},
                "charter": {"type": "string",
                            "description": "its standing role card (every turn). "
                                           "A REPORT's only — you cannot rewrite "
                                           "your own; ask your superior"},
                "team_charter": {"type": "string",
                                 "description": ("standing instructions for its whole "
                                                 "subtree; you may set your own (node = "
                                                 "your id)")},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort for this report "
                                          "('' clears to the CLI default)"},
                "account": ACCOUNT_REBIND_SCHEMA,
                "account_fallback": {"type": "boolean",
                    "description": "override this agent's org default for automatic account switching after a usage limit. Default off; verified same-lane subscription capacity only; keeps the replacement account."},
                "clear_account_fallback": {"type": "boolean",
                    "description": "clear the override and follow the org default again"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": ("luna only: use OpenAI reserve capacity "
                                    "first (true, default) or the normal weekly "
                                    "usage first (false); the other pool is the "
                                    "fallback")},
            },
            "required": ["node"],
        },
    },
    {
        "name": "orgtree_retire",
        "description": ("Retire a node in your subtree (its seat and grant "
                         "return to its parent), or yourself if you have no live "
                         "reports. A node with live reports takes its whole "
                         "subtree with it. Mid-turn agents are interrupted and "
                         "waited on before archiving; a tool call already in "
                         "flight may still touch disk (you are warned if a turn "
                         "did not settle). The session is kept and can be "
                         "rehired. Permanent deletion is the user's alone."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_cheap_compact",
        "description": (
            "Reset an idle long-context agent's session in place instead of "
             "compacting it (a normal compact re-reads the whole transcript at "
             "cold-cache prices). The seat, parent, scope, charter, grant and "
             "team stay; the old session is archived as a knowledge bearer "
             "(<node>@<gen>) and the successor starts with zero context, reading "
             "only the history it chooses. Refused on yourself and on nodes with "
             "open background tasks."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_rehire",
        "description": (
            "Rehire an archived node in your subtree with its full prior "
             "context. An archived superior chain is rehired first (costs bubble "
             "up). You may rehire your own knowledge bearer (a past generation "
             "of you) as your subordinate. An unrecoverable node is re-seeded "
             "(fresh session, same role, credits and reports); a LOST generation "
             "(no transcript) can never be rehired. Like orgtree_hire, one call "
             "can also rename it (`name`), set scope fields (charter, tools, "
             "add_dirs, org_visibility, permission_mode, effort, team_charter), "
             "choose the provider `account` (omit to keep the archived one, "
             "which may be exhausted), grant `audiences` and send a `kickoff` "
             "(applied last). Everything except `name` is all-or-nothing; the "
             "rename runs first and is not rolled back if a later step is "
             "refused."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string"},
                "grant": {"type": "integer", "minimum": 0},
                "target": {"type": "string",
                           "description": ("where to restore it: yourself or a live "
                                           "agent in your subtree. Omit to restore "
                                           "it where it was archived")},
                "hire_type": {
                    "type": "string", "enum": ["subordinate", "superior"],
                    "description":
                        ("'subordinate' (default) = a report of `target`. "
                         "'superior' = INSERT ABOVE the target, taking its "
                         "folders, tools, visibility and permission mode, so "
                         "omit those four (passing them is refused). Above a "
                         "TOP-LEVEL target only the user may do it")},
                "name": {"type": "string",
                         "description": ("rename it as it wakes; runs first and "
                                         "cannot be rolled back")},
                "charter": {"type": "string",
                            "description": "replace its standing role card"},
                "add_dirs": {"type": "array",
                             "items": {"type": "object",
                                       "properties": {"path": {"type": "string"},
                                                      "mode": {"type": "string",
                                                               "enum": ["rw", "ro"]}},
                                       "required": ["path", "mode"]},
                             "description": "REPLACES its folder grants when passed"},
                "tools": TOOLS_SCHEMA,
                "org_visibility": {"type": "string",
                                   "enum": ["self", "team", "subtree", "full"]},
                "permission_mode": {
                    "type": "string",
                    "enum": ["plan", "default", "acceptEdits",
                             "bypassPermissions"],
                    "description": ("'default' ASKS and a headless turn cannot "
                                    "answer, so it cannot act. CAPPED AT YOUR "
                                    "OWN")},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort ('' = CLI default)"},
                "account": ACCOUNT_RESTORE_SCHEMA,
                "account_fallback": {"type": "boolean",
                    "description": "override this agent's org default for automatic account switching after a usage limit. Default off; verified same-lane subscription capacity only; keeps the replacement account."},
                "clear_account_fallback": {"type": "boolean",
                    "description": "clear the override and follow the org default again"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": ("luna only: use OpenAI reserve capacity "
                                    "first (true, default) or the normal weekly "
                                    "usage first (false); the other pool is the "
                                    "fallback")},
                "team_charter": {"type": "string",
                                 "description": "standing instructions binding "
                                                "its own subtree"},
                "audiences": {
                    "type": "array", "items": {"type": "string"},
                    "description": ("audiences to grant it, same rules as "
                                    "orgtree_audience grant ('user', 'extern', "
                                    "your id, a live peer, your direct superior)")},
                "kickoff": {"type": "string",
                            "description": ("its first task on waking, delivered "
                                            "after everything else. It wakes anyway "
                                            "if mail is already waiting")},
                "kickoff_kind": {"type": "string",
                                 "enum": ["message", "question", "request",
                                          "decision", "status"],
                                 "description": "kind of the kickoff mail "
                                                "(default 'request')"},
                "work_item": {
                    "type": "string",
                    "description":
                        ("docket item slug to ASSIGN to it in this call; the "
                         "assignment mail wakes it, so no kickoff is needed")},
                "review_items": {
                    "type": "array", "items": {"type": "string"},
                    "description": "rehire: review item slugs granted to this seat before kickoff; the group is atomic"},
            },
            "required": ["node"]},
    },
    {
        "name": "orgtree_staff",
        "description": (
            "STAFF WORK IN ONE CALL: orgtree_work create (or update) + "
             "orgtree_hire (or rehire) + orgtree_work assign. The seat is "
             "created first and the item is written with that agent as owner "
             "(assignment is ownership: it holds the item and gets the user's "
             "replies). The assignment mail starts the agent; `kickoff` is "
             "optional. Pass `node` to rehire an archived agent or omit it to "
             "hire (`staff_mode` is checked, not obeyed). Arguments and checks "
             "are the underlying tools'; any refusal refuses the WHOLE call. ⚠ "
             "`parent` here is the parent WORK ITEM; place the seat with "
             "`target`/`hire_type`. For an already-live agent use orgtree_work "
             "assign; to assign an existing item to a new hire without changing "
             "its status use orgtree_hire `work_item`. ⚠ PROGRESS IS OPTIONAL "
             "HERE: omit done_so_far and working_on_next and the stored "
             "summaries are PRESERVED (or a generated 'staffed' line is written "
             "if none exist); send either and they REPLACE the pair, so send "
             "both. A standalone orgtree_work update still has to carry readable "
             "progress."),
        "inputSchema": {
            "type": "object",
            "properties": {
                # -- the docket half (orgtree_work's vocabulary)
                "action": {"type": "string", "enum": ["create", "update"],
                           "description": "create a new item (default), or "
                                          "update an existing one named by "
                                          "`slug` and hand it over"},
                "slug": {"type": "string",
                         "description": "update: the existing item's readable name"},
                "title": {"type": "string", "description": "create: short concrete title"},
                "objective": {"type": "string",
                              "description": ("create (REQUIRED): the item's "
                                              "description and authoritative standalone "
                                              "scope — first paragraph the problem then "
                                              "the solution, later paragraphs every "
                                              "other requirement and ruling. Markdown, "
                                              "no length limit")},
                "kind": {"type": "string", "description": "create: code|non-code"},
                "status": {"type": "string",
                           "description": "backlogged|open|in_progress|blocked|review|deploy_ready"},
                "done_so_far": {"type": "array", "items": {"type": "string"},
                                "description": ("OPTIONAL here. Omit both progress fields "
                                                "to preserve the stored summaries; send "
                                                "either and the pair is replaced (the "
                                                "omitted half is cleared)")},
                "working_on_next": {"type": "array", "items": {"type": "string"},
                                    "description": ("OPTIONAL here. Same rule as done_so_far: "
                                                    "omit both to preserve, send either to "
                                                    "replace the pair")},
                "participants": {"type": "array", "items": {"type": "string"},
                                 "description": "create: collaborator node ids"},
                "acceptance": {"type": "array", "items": {"type": "string"},
                               "description": ("create/update: acceptance conditions, "
                                               "one testable sentence each; on update it "
                                               "rewrites the whole list (versioned)")},
                "dependencies": {"type": "array", "items": {"type": "string"},
                                 "description": "create: names of items this one depends on"},
                "parent": {"type": "string",
                           "description": "the parent WORK ITEM to nest this "
                                          "item under — NOT the seat's "
                                          "destination (that is `target`)"},
                # -- the seat half (orgtree_hire / orgtree_rehire's vocabulary)
                "staff_mode": {"type": "string", "enum": ["hire", "rehire"],
                               "description": "hire somebody new (default), or "
                                              "rehire the archived agent named "
                                              "by `node`"},
                "node": {"type": "string",
                         "description": "rehire: the archived agent to bring back"},
                "name": {"type": "string",
                         "description": "hire: 1-2 words, the node id · rehire: "
                                        "rename it as it comes back"},
                "tier": {"type": "string", "description": "hire: tier id from orgtree_list_tiers"},
                "grant": {"type": "integer", "minimum": 0,
                          "description": "credits it may spend on ITS OWN hires"},
                "charter": {"type": "string",
                            "description": "the agent's role + standing "
                                           "instructions, written in full — "
                                           "required on a hire"},
                "add_dirs": {"type": "array", "items": {"type": "object"},
                             "description": "folder grants, exactly as orgtree_hire takes them"},
                "tools": {"type": "object", "description": "the tool switches, exactly as orgtree_hire takes them"},
                "org_visibility": {"type": "string", "description": "full|subtree|self"},
                "permission_mode": {"type": "string",
                                    "description": "the seat's permission mode "
                                                   "(capped at your own)"},
                "effort": {"type": "string", "description": "reasoning effort"},
                "team_charter": {"type": "string",
                                 "description": "standing instruction for the "
                                                "agent's own team"},
                "account": ACCOUNT_STAFF_SCHEMA,
                "account_fallback": {"type": "boolean",
                    "description": "override this agent's org default for automatic account switching after a usage limit. Default off; verified same-lane subscription capacity only; keeps the replacement account."},
                "clear_account_fallback": {"type": "boolean",
                    "description": "clear the override and follow the org default again"},
                "prefer_reserve": {"type": "boolean",
                                   "description": "prefer reserve capacity for this seat"},
                "target": {"type": "string",
                           "description": "where the seat goes (default: under you)"},
                "hire_type": {"type": "string", "enum": ["subordinate", "superior"],
                              "description": "which side of `target` to seat it"},
                "audiences": {"type": "array", "items": {"type": "string"},
                              "description": "audiences to grant it"},
                "kickoff": {"type": "string",
                            "description": "OPTIONAL here: the assignment "
                                           "notification already starts the "
                                           "agent. Send one only when there is "
                                           "something to say beyond the item"},
                "kickoff_kind": {"type": "string",
                                 "enum": ["message", "question", "request",
                                          "decision", "status"],
                                 "description": "kind of the kickoff mail "
                                                "(default 'request')"},
                "review_items": {"type": "array", "items": {"type": "string"},
                                 "description": "hire/rehire: review item slugs granted before kickoff"},
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_list_orgs",
        "description": (
            "List reachable outside recipients: other orgs on this backend "
             "(@org:<slug>) and hub peers (@net:<slug>, with online/last_seen). "
             "Each entry's `transports` lists the address forms that reach it; "
             "prefer fewer hops or send the bare name. Sealed kiosk orgs are not "
             "listed."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "orgtree_list_tiers",
        "description": (
            "List the model tiers this machine offers (provider, model, seat "
             "price, advisory availability). Check it before orgtree_hire or "
             "orgtree_switch_model; the real call rechecks availability, scope "
             "and credits and may still refuse."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "orgtree_move",
        "description": (
            "Re-parent a node in your subtree under another node in your reach; "
             "its whole suborganization moves with it. Budget-neutral, so it "
             "works in a full tree. Only the user can seat agents at top level. "
             "`moves` applies several re-parentings in order as ONE "
             "all-or-nothing transaction (e.g. swap two positions, each keeping "
             "its own team)."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string"},
                "new_parent": {"type": "string"},
                "moves": {
                    "type": "array", "maxItems": 20,
                    "items": {"type": "object",
                              "properties": {
                                  "node": {"type": "string"},
                                  "new_parent": {"type": "string"}},
                              "required": ["node", "new_parent"]},
                    "description": ("batch form: EITHER node+new_parent OR this "
                                    "list ('' new_parent = top level, user only)")},
            }},
    },
    {
        "name": "orgtree_swap",
        "description": (
            "Two agents in your reach EXCHANGE SEATS. The seat keeps its "
             "superior, reports, grant, team charter and scope; the agent keeps "
             "its identity, session, charter and mailbox. Works for any pair; a "
             "same-tier swap moves no credits. A former commander/subordinate "
             "pair left non-adjacent keeps an audience. To swap positions with "
             "each keeping its own team, use orgtree_move `moves`. Only the user "
             "may reseat the top level."),
        "inputSchema": {"type": "object",
                        "properties": {"a": {"type": "string"},
                                       "b": {"type": "string"}},
                        "required": ["a", "b"]},
    },
    {
        "name": "orgtree_self_subjugate",
        "description": (
            "Step down by PROMOTING one of your live descendants over you. Not "
             "a swap: it takes your place under your superior and KEEPS ITS OWN "
             "TEAM; you become its direct report with the rest of your subtree. "
             "Both keep identity, session, charter, mailbox, history and docket "
             "items; credits re-seat with no free-credit change. It inherits "
             "your folders, tools, visibility and permission mode but NOT your "
             "team charter — set its team charter with orgtree_retool first if "
             "needed. Your authority over the promoted branch ends at once. "
             "Atomic: any refusal applies nothing. Hand-over pattern: hire a "
             "replacement, self-subjugate to it, hand off loose ends, then "
             "retire yourself. A top-level agent may hand its own seat to a "
             "descendant this way; it cannot raise you or reach another chain. "
             "For a plain seat exchange use orgtree_swap."),
        "inputSchema": {"type": "object",
                        "properties": {"target": {"type": "string"}},
                        "required": ["target"]},
    },
    {
        "name": "orgtree_dissolve",
        "description": ("Retire a node in your subtree AND everything beneath "
                         "it (deepest first). Mid-turn nodes are interrupted and "
                         "waited on first, as with orgtree_retire."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_interrupt",
        "description": (
            "Stop a descendant's CURRENT turn without retiring it (the ⏸ "
             "control): it goes idle, ready for its next turn. Queued mail and a "
             "queued orgtree_switch_model apply at that boundary (switch then "
             "interrupt = apply now). Returns immediately without waiting for "
             "the turn to settle. A tool call already started may still finish "
             "and touch disk. No-op if the target is not mid-turn."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_unstick",
        "description": (
            "Release a frozen descendant and resume it using its retained "
             "replay text. Refused on yourself, peers and unrelated nodes."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_continue_on",
        "description": (
            "Move a FROZEN descendant to another provider account AND release "
             "its freeze in one act (the agent-side `/continue-on`) — the way to "
             "rescue a report that hit a usage limit (orgtree_retool account= "
             "refuses a limit-frozen target; orgtree_unstick alone restarts it "
             "on the exhausted account). The target account's capacity is "
             "checked live; no room refuses the whole call and changes nothing. "
             "The account moves first and the freeze is released only after that "
             "succeeds; if the release fails you get `state: "
             "switched_not_resumed` with the retry. The result's `agent` field "
             "says `running` or `idle` (idle means you still owe it a message). "
             "Downward only; never yourself, a peer or a superior. No halt "
             "needed."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string",
                         "description": "the frozen descendant to move"},
                "account": {
                    "type": "string",
                    "description": ("account to continue on (same selectors as "
                                    "orgtree_retool `account`): a signed-in "
                                    "profile of the same provider, not the "
                                    "current one, with room now")},
            },
            "required": ["node", "account"],
        },
    },
    {
        "name": "orgtree_halt",
        "description": (
            "Halt a descendant until orgtree_unhalt: kills its provider process "
             "and waits for the turn to end. Success is halted=true, "
             "settled=true; 'halting' means cleanup is still pending. Mail stays "
             "queued and unread; nothing (mail, watchdogs, checkups, restarts, "
             "rehire, model/account changes) can wake it. Unlike "
             "orgtree_interrupt, pending mail does not run. Never yourself, a "
             "peer or a superior. `nodes` halts several in parallel with "
             "per-node results."),
        "inputSchema": {"type": "object",
                        "properties": {
                            "node": {"type": "string"},
                            "nodes": {"type": "array",
                                      "items": {"type": "string"},
                                      "description": "batch form: halt every "
                                      "listed descendant in one call"}}},
    },
    {
        "name": "orgtree_unhalt",
        "description": (
            "Release a descendant's halt after its turn has fully ended. "
             "Pending work resumes once through normal delivery; other holds "
             "still apply; an idle agent with nothing waiting stays idle; "
             "repeating it adds no turn. `nodes` releases several with per-node "
             "results."),
        "inputSchema": {"type": "object",
                        "properties": {
                            "node": {"type": "string"},
                            "nodes": {"type": "array",
                                      "items": {"type": "string"},
                                      "description": "batch form: unhalt "
                                      "every listed descendant in one call"}}},
    },
    {
        "name": "orgtree_reallocate",
        "description": "Move grant credits between one of your reports and its parent: positive delta grants more, negative claws back unused credits.",
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "delta": {"type": "integer"}},
                        "required": ["node", "delta"]},
    },
    {
        "name": "orgtree_status",
        "description": ("Report your working status. REQUIRED when you finish "
                         "or get stuck: 'done' and 'blocked' notify your "
                         "superior with your summary; 'working' and 'idle' only "
                         "record state. 'done' leaves you idle (no separate "
                         "'idle' needed). While 'working', automatic checkups "
                         "may wake you after about 20 minutes to continue "
                         "unfinished work."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["working", "done", "blocked", "idle"]},
                "summary": {"type": "string", "description": "one or two sentences"},
            },
            "required": ["status", "summary"],
        },
    },
    {
        "name": "orgtree_chart",
        "description": (
            "Your view of the org (per your visibility level) with your credits "
             "and scope. Each row shows the agent's last self-reported status "
             "and its AGE — read the age: a dead agent still shows its last "
             "status; only '▶ mid-turn' is observed by the system. Retired "
             "agents are only counted unless include_archived=true. Check the "
             "archived list before hiring: rehiring an agent that did this work "
             "restores its context."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_archived": {
                    "type": "boolean",
                    "description": ("list every retired agent by name (the "
                                    "rehire shortlist)")},
                "include_standing_charter": {
                    "type": "boolean",
                    "description": ("include inherited/team standing charters "
                                    "(default true); the agent's own charter is "
                                    "always included")},
            },
        },
    },
    {
        "name": "orgtree_state_inspect",
        "description": (
            "Read-only structural state inspection, limited to nodes within "
             "your visibility; never returns prompts, transcripts, mail, "
             "credentials or session contents. `node`/`nodes` narrow it; "
             "include_archived adds archived rows."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "nodes": {"type": "array", "items": {"type": "string"}},
                "node": {"type": "string"},
                "include_archived": {"type": "boolean"},
            },
        },
    },
    {
        "name": "orgtree_capabilities",
        "description": (
            "Report the operations this authenticated actor can dispatch. "
            "The result reflects the actor's agent/operator surface and does "
            "not create an operator door for agent-only topology operations."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "orgtree_preview",
        "description": (
            "Dry-run one ledger operation against an isolated copy with the "
             "same authority checks. Returns bounded before/after state, diff "
             "and warnings; changes nothing (store, files, mail, credits, "
             "processes, external services)."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "operation": {"type": "string"},
                "args": {"type": "object"},
                "include_archived": {"type": "boolean"},
            },
            "required": ["operation"],
        },
    },
    {
        "name": "orgtree_read_transcript",
        "description": ("Read an agent's transcript. Access is DOWNWARD "
                         "(yourself and descendants), plus one item-scoped "
                         "exception: while you are listed on an open docket item "
                         "(holder, participant or named reviewer) you may read "
                         "any EARLIER holder of that same item, even archived. "
                         "It covers only that item, never the current holder, "
                         "and ends when you stop being listed or the item "
                         "closes. `orgtree_work get` lists `holders` (current "
                         "last). The result's `access` says which route allowed "
                         "the read."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "last": {"type": "integer", "minimum": 1,
                                                "maximum": 80,
                                                "description": "how many recent messages"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_read_scratch",
        "description": ("Browse or read an agent's scratch folder (e.g. its "
                         "breadcrumbs.md). Same access as "
                         "orgtree_read_transcript: DOWNWARD, plus earlier "
                         "holders of an open docket item you are listed on (see "
                         "`holders` in orgtree_work get). Omit path to list the "
                         "root; pass a file path to read it. The result's "
                         "`access` names the route."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "path": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_send_file",
        "description": (
            "Deliver a FILE to the user as a download card in your chat (copied "
             "to outbox/). Use it WHENEVER the user asks for a file ('send me', "
             "'give me'); pasting contents or naming a path is not delivery. "
             "Images render in the chat as the picture, so this is also how you "
             "show a screenshot or diagram. Sendable: your working folder "
             "(relative paths resolve there), the workspace, or folders you "
             "hold. Mention the file in your reply. For in-page reading use "
             "orgtree_present; user-facing markdown can also embed relative "
             "images like ![](outbox/plot.png)."),
        "inputSchema": {"type": "object",
                        "properties": {
                            "path": {"type": "string",
                                     "description": "the file to deliver"},
                            "delivery_id": {"type": "string",
                                            "description": ("optional retry id: reuse it for the same "
                                                            "delivery after a lost response; use a "
                                                            "new one for a new delivery")},
                            "note": {"type": "string",
                                     "description": "one-line caption shown "
                                                    "on the download card"}},
                        "required": ["path"]},
    },
    {
        "name": "orgtree_switch_model",
        "description": (
            "Switch the model of an agent in your SUBTREE (never your own). If "
             "it is mid-turn the switch is QUEUED (queued=true) until the turn "
             "ends; interrupt to apply now, ask again to replace, or ask for its "
             "current tier to cancel. Same provider: session and context "
             "survive. ACROSS providers: its old self is archived as a knowledge "
             "bearer (<node>@<gen>, readable, rehireable) and it starts fresh. "
             "Cheaper tier: the difference becomes its free credit; pricier: "
             "paid from its free credit, then up the chain to you (refused if "
             "the chain lacks it). Seats: haiku 1, sonnet 2, opus 4, fable 10 "
             "(Claude); luna 0.1, terra 2, sol 2 (Codex, CLI signed in; luna "
             "prefers reserve); flash 1, pro 2 (Antigravity, CLI signed in); "
             "`or-…` tiers are OpenRouter favorites priced from $/M input (whole "
             "number at or above $1, min 0.1). See orgtree_list_tiers for "
             "current ids and prices."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "tier": {"type": "string",
                                                "description": "tier id from "
                                                "orgtree_list_tiers; the backend "
                                                "rechecks availability and "
                                                "credits before switching"}},
                        "required": ["node", "tier"]},
    },
    {
        "name": "orgtree_audience",
        "description": (
            "Audience machinery. request: ask to speak with a distant superior "
             "(or 'user'); it climbs your chain one refusable hop at a time. "
             "forward/deny: act on a request waiting on YOU (from= requester, "
             "target= who they seek). grant: give a descendant (from=) an "
             "audience with you, or via target= with a live peer, your direct "
             "superior, 'user' (if you are top-level), or 'extern' = the ORG "
             "INBOX (outside @org:/@mcp:/@net: mail reaches holders only; a "
             "top-level agent may grant it to itself). revoke: rescind one you "
             "granted (grantee=); an org-inbox holder may revoke itself and a "
             "top-level agent any org-inbox grant in its subtree."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["request", "forward", "grant", "deny", "revoke"]},
                "target": {"type": "string"},
                "from": {"type": "string"},
                "grantee": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["action"],
        },
    },
]

# These cards intentionally live outside TOOLS.  TOOLS is the standard
# backend catalogue; desktop-managed V2 replaces the two deployment cards at
# the profile boundary below.  Keeping the replacement here makes the two
# surfaces impossible to accidentally merge while still sharing all other
# tools and their schemas.
_DESKTOP_RELAUNCH_CARDS: tuple[dict[str, Any], dict[str, Any]] = (
    {
        "name": "orgtree_self_relaunch",
        "description": (
            "Request an idle relaunch of the installed Orgtree desktop and its "
             "managed engine; it waits for engine and OS idle. Relaunch only: it "
             "never rebuilds the repository, runs update.ps1/update.sh, replaces "
             "installed Electron files, invokes an installer, publishes a "
             "release or rebuilds the mail hub. To update installed files use "
             "the tray's Update now action or the Windows installer. Durable and "
             "idempotent; optional reason recorded."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "why the desktop relaunch is needed; "
                                   "recorded with the durable request",
                },
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_prime_relaunch",
        "description": (
            "Arm a durable relaunch of the installed Orgtree desktop and its "
             "managed engine that fires only when the engine is idle and the OS "
             "has been idle for at least 60 seconds. Relaunch only: it never "
             "rebuilds the repository, runs update.ps1/update.sh, replaces "
             "installed Electron files, invokes an installer, publishes a "
             "release or rebuilds the mail hub. action='status' inspects, "
             "action='cancel' disarms; arming is idempotent. To update installed "
             "files use the tray's Update now action or the Windows installer."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["arm", "cancel", "status"],
                    "description": "arm (default), cancel, or status",
                },
                "reason": {
                    "type": "string",
                    "description": "why the desktop relaunch is needed; "
                                   "shown with the durable request",
                },
            },
            "required": [],
        },
    },
)

_AGENT_RESTART_TOOLS = frozenset({
    "orgtree_self_restart", "orgtree_prime_restart",
})


def _desktop_relaunch_catalogue(
        tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace standard deployment cards with the V2 relaunch surface."""
    replacements = {card["name"]: card for card in _DESKTOP_RELAUNCH_CARDS}
    out: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name") or "")
        if name == "orgtree_self_restart":
            out.append(replacements["orgtree_self_relaunch"])
        elif name == "orgtree_prime_restart":
            out.append(replacements["orgtree_prime_relaunch"])
        else:
            out.append(tool)
    return out


# File delivery retains its actual response: the transcript turns `sent` into
# a download card. A generic ten-second running/result-mail response loses that
# card. Its own durable retry ID covers a lost HTTP answer without replaying
# copies; the filesystem work still runs off the event loop.
MANAGED_WAIT_TOOLS = frozenset({'orgtree_staff', 'orgtree_hire', 'orgtree_rehire',
                              'orgtree_retire', 'orgtree_dissolve', 'orgtree_cheap_compact',
                              'orgtree_watchdog',
                              # forces a live provider read of the TARGET
                              # account before it moves anything — for Codex
                              # that starts an app-server, which is exactly the
                              # wait this path exists for
                              'orgtree_continue_on'})


def available_tools() -> list[dict[str, Any]]:
    """The tool catalogue permitted by the install-wide deployment policy."""

    tools = TOOLS if deployment.current_policy().allow_agent_restart else [
        tool for tool in TOOLS
        if str(tool.get("name") or "") not in _AGENT_RESTART_TOOLS]
    tools = [{**tool, 'description': tool['description'] +
              ' If this call takes over ten seconds, it may return state=running '
              'with an operation_id. That is not completion: the original backend '
              'operation continues once, independently of your turn, and sends its '
              'result as durable mail. Handle incoming mail; do not repeat the call.'}
             if tool['name'] in MANAGED_WAIT_TOOLS else tool for tool in tools]
    if os.environ.get('ORGTREE_DESKTOP_MANAGED') != '1':
        return tools
    tools = json.loads(json.dumps(_desktop_relaunch_catalogue(tools)))
    for tool in tools:
        if tool['name'] == 'orgtree_work':
            actions = tool['inputSchema']['properties']['action']['enum']
            actions.remove('verify')
            tool['description'] = tool['description'].replace(
                _WORK_VERIFY_SENTENCE, '')
    return tools


def _lost_kind(exc: Exception) -> str:
    """Was the request DELIVERED before the answer went missing?

    A refused connection or a name that does not resolve means no bytes ever
    reached a backend, so nothing can have applied — that is `unsent`, and it
    is the ordinary "the backend is not running" case, answered immediately
    without a pointless second round trip. Everything else — a timeout, a
    reset, a half-read response — means the request may well have been
    processed and only the ANSWER was lost. That is `lost`, and it is the
    case receipts exist for.
    """
    seen: list[object] = [exc]
    reason = getattr(exc, "reason", None)
    if reason is not None:
        seen.append(reason)
    for x in seen:
        if isinstance(x, (ConnectionRefusedError, socket.gaierror)):
            return "unsent"
    return "lost"


def _post(payload: dict[str, Any], timeout: float = 30) -> tuple[str, str]:
    """POST once. Returns (kind, text) where kind is:

        ok        the backend answered
        refused   the backend answered with an HTTP error — a DEFINITE answer
        unsent    no connection was ever made, so nothing can have applied
        lost      the request may have been processed and the ANSWER went
                  missing. Whether the call applied is UNKNOWN from here.

    That last case is the whole reason receipts exist. Every failure used to
    be reported as `orgtree API unreachable`, which reads like a refusal and
    is not one: the mutation may have committed and the response died on the
    way back.
    """
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if os.environ.get("ORGTREE_AGENT_TOKEN"):
        headers["X-Orgtree-Agent-Token"] = os.environ["ORGTREE_AGENT_TOKEN"]
    if BRIDGE_SECRET:
        headers["X-Orgtree-Bridge"] = BRIDGE_SECRET
    req = urllib.request.Request(f"{BASE}/api/agent",
                                 data=json.dumps(payload).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return "ok", r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return "refused", e.read().decode("utf-8", "replace")[:500]
    except Exception as e:                                   # noqa: BLE001
        return _lost_kind(e), str(e)


def _old_build_refusal(text: str, verb: str) -> bool:
    """The refusal a backend WITHOUT receipts gives one of the receipt verbs —
    measured against the real pre-receipts build (a0fac2f):

        422 {"detail": "unknown orgtree tool 'orgtree_op_call'"}

    Both halves are required. The server's own complaints about a malformed
    wrapper name the verb too, and treating one of those as "this build has no
    receipts" would drop the key and reissue the call unprotected — turning a
    client bug into the duplicate this whole file exists to prevent."""
    return "unknown orgtree tool" in text and verb in text


def _stale_epoch_refusal(text: str) -> bool:
    """The backend's refusal of a key bound to an epoch it has since rotated.
    Both halves again: the marker the server writes for THIS reason, and the
    reason itself."""
    return "op_key refused" in text and "stale_epoch" in text


# The epoch this process was issued for this org, and the one thing it is
# for: binding a key to the backend's own custody of the receipt log. Held
# for the life of the process — it changes only when the backend restarts or
# the document is restored, and both of those refuse the next call carrying
# the old one, which is when we go and get another.
_EPOCH: dict[str, str] = {}


def _fetch_epoch() -> tuple[str, str]:
    """(epoch, problem). One of them is always empty.

    `problem` is `unsupported_build` when this backend has no receipts at all
    — the one case in which a mutating call may go out unprotected, and it is
    established HERE, by a read, before any mutation has been attempted."""
    for attempt in (1, 2):
        kind, text = _post({"org": ORG, "node": NODE,
                            "tool": opreceipts.OP_EPOCH, "args": {}},
                           timeout=15)
        if kind == "ok":
            try:
                got = str((json.loads(text) or {}).get("epoch") or "")
            except json.JSONDecodeError:
                got = ""
            if got:
                return got, ""
            return "", f"the backend answered {opreceipts.OP_EPOCH} without " \
                       f"an epoch"
        if kind == "refused":
            if _old_build_refusal(text, opreceipts.OP_EPOCH):
                return "", "unsupported_build"
            return "", f"the backend refused {opreceipts.OP_EPOCH}: " \
                       f"{text[:200]}"
        if kind == "unsent" or attempt == 2:
            return "", f"{kind}: {text[:200]}"
        # `lost` on a READ that mutates nothing — asking again costs nothing
        # and cannot double anything
    return "", "unreachable"


def _epoch(refresh: bool = False) -> tuple[str, str]:
    if refresh:
        _EPOCH.pop(ORG, None)
    got = _EPOCH.get(ORG)
    if got:
        return got, ""
    got, problem = _fetch_epoch()
    if got:
        _EPOCH[ORG] = got
    return got, problem


def _finish_plain(answer: tuple[str, str]) -> str:
    """An UNPROTECTED call's four outcomes — the shape this client had before
    receipts existed. Reached in exactly two cases, both of which have already
    established that no receipt is possible: a receipt verb calling itself,
    and a backend that refused the epoch read as an unknown verb."""
    kind, text = answer
    if kind == "ok":
        return text
    if kind == "refused":
        return json.dumps({"error": text})
    if kind == "unsent":
        return json.dumps({"error": f"orgtree API unreachable: {text}"})
    return json.dumps({
        "error": f"orgtree API gave no answer for this call ({text}), and no "
                 f"operation receipt covers it, so whether it applied CANNOT "
                 f"be established. Check the org before repeating it.",
        "state": "unknown", "reason": "unsupported_build"})


def call_api(tool: str, args: dict[str, Any]) -> str:
    """One tool call, with an operation key so a LOST answer can be resolved
    instead of guessed at.

    The call is issued as `orgtree_op_call`, which CARRIES the real call. That
    shape is the safety property: a backend old enough to have no receipts
    refuses the unknown verb and executes nothing, so this client never leaves
    an unrecorded effect behind for a later lookup to misread as "never
    applied". When the answer is lost we ASK — `orgtree_op_lookup`, refused by
    those same older backends — and report what the org can actually prove. We
    never reissue the call automatically: `not_applied` is handed to the agent
    as a fact to act on, not acted on here."""
    # The receipt verbs are never themselves keyed: a lookup is a QUESTION,
    # and wrapping it would make asking whether something applied an
    # operation with its own key.
    if tool == 'orgtree_send_file':
        import uuid
        args = dict(args)
        args.setdefault('delivery_id', uuid.uuid4().hex)
        # A distinct transport verb is refused by older backends, before any
        # copy; an unknown optional argument would otherwise be ignored.
        answer = _post({'org': ORG, 'node': NODE, 'tool': 'orgtree_send_file_once', 'args': args})
        if answer[0] in ('lost', 'unsent'):
            return json.dumps({'error': answer[1], 'delivery_id': args['delivery_id'],
                               'status': 'Retry this same file with this delivery_id; do not create a new delivery for a lost response.'})
        return _finish_plain(answer)
    plain = {"org": ORG, "node": NODE, "tool": tool, "args": args}
    if tool in opreceipts.VERBS or not opreceipts.receipted(tool, args):
        # Nothing to protect, so nothing to preflight: a receipt verb is a
        # question, and a NONE-class verb (a chart, a transcript read, a
        # rename) never reaches the document transaction a receipt rides —
        # the backend drops the key for exactly those, and reading the org
        # must not start failing because a preflight could not be answered.
        return _finish_plain(_post(plain))
    epoch, problem = _epoch()
    if problem == "unsupported_build":
        # This backend predates receipts. It cannot execute a keyed call at
        # all (measured, `probe_old_build.py`), and it has just told us so
        # through a READ that applied nothing — which is the only moment at
        # which dropping to an unprotected call is safe, because nothing has
        # been attempted yet. From here this call is exactly what this client
        # made before receipts existed.
        return _finish_plain(_post(plain))
    if not epoch:
        if problem.startswith("unsent"):
            # no connection was ever made, so this is the ordinary
            # backend-is-down case and deserves its ordinary words
            return json.dumps({"error": f"orgtree API unreachable: {problem}"})
        # ⚠ NOT DEMOTED TO AN UNPROTECTED CALL. We could not establish
        # coverage, and running the mutation anyway would leave precisely the
        # unrecorded effect this module exists to prevent. Nothing was sent.
        return json.dumps({
            "error": f"orgtree: this call was NOT made. Its operation "
                     f"coverage could not be established ({problem}), and a "
                     f"mutating call is not sent unprotected. Nothing has "
                     f"changed; try again.",
            "state": "not_applied", "reason": "no_epoch"})
    key = opreceipts.mint_key()
    kind, text = _post({"org": ORG, "node": NODE, "tool": opreceipts.OP_CALL,
                        "args": {"tool": tool, "args": args, "op_key": key,
                                 "op_epoch": epoch}})
    if kind == "refused" and _stale_epoch_refusal(text):
        # ⚠ NO AUTOMATIC REISSUE UNDER A FRESH KEY (Astra, 2026-09-05). This
        # refusal proves THIS attempt did nothing. It says nothing about any
        # earlier attempt: the epoch rotated because the backend restarted or
        # the document was restored, and either could have taken the receipt
        # of a call that already applied. Refreshing the cached epoch is for
        # the agent's NEXT, independent call; this one is reported, not
        # retried.
        _epoch(refresh=True)
        return json.dumps({
            "error": "orgtree: this call was refused before it ran, because "
                     "its operation epoch is no longer current — the backend "
                     "restarted, or the org document was restored. NOTHING "
                     "was done by this attempt. If you had an earlier attempt "
                     "at this same operation, its outcome is UNKNOWN: check "
                     "the org before repeating it.",
            "state": "stale", "reason": "stale_epoch",
            "detail": text[:400]})
    if kind == "ok":
        return text
    if kind == "refused":
        return json.dumps({"error": text})
    if kind == "unsent":
        # no connection was made, so the call was never delivered: the old
        # wording, and it is still the true one for this case
        return json.dumps({"error": f"orgtree API unreachable: {text}"})
    lost = text
    # ⚠ THE ORIGINAL KEY AND THE EPOCH IT WAS BOUND TO — never a refreshed
    # one. The question is whether THAT call applied, and asking it under a
    # newer epoch would be asking about a different world.
    lkind, ltext = _post({"org": ORG, "node": NODE,
                          "tool": opreceipts.OP_LOOKUP,
                          "args": {"op_key": key, "op_epoch": epoch,
                                   "for_tool": tool,
                                   "for_args": args}}, timeout=15)
    if lkind == "ok":
        try:
            parsed = json.loads(ltext)
        except json.JSONDecodeError:
            parsed = None
        # a line may parse as ANY json value — coerce once, so nothing below
        # calls .get on a list
        ans: dict[str, Any] = (cast("dict[str, Any]", parsed)
                               if isinstance(parsed, dict) else {})
        state = str(ans.get("state") or "")
        head = (f"orgtree: no answer came back from the backend for this "
                f"call ({lost}). Its receipt was then looked up, and the org "
                f"reports: ")
        if state == "applied":
            return json.dumps({
                "replayed": True, "state": "applied",
                "status": head + "the operation DID apply — its document "
                                 "transaction committed. Do not issue it "
                                 "again. Post-commit effects (waking a "
                                 "recipient, outbound transport) are not "
                                 "covered by the receipt.",
                "receipt": ans.get("receipt")})
        if state == "not_applied":
            return json.dumps({
                "error": head + "the operation did NOT apply, and its key is "
                                "now fenced so the lost call can never take "
                                "effect. It is safe to issue this call again.",
                "state": state, "op_lookup": ans})
        why = str(ans.get("status") or "the outcome cannot be established")
        return json.dumps({
            "error": head + f"{state or 'unknown'} — {why}. Do NOT assume it "
                            f"failed: check the org (your mailbox, the chart, "
                            f"the docket) before doing anything that would "
                            f"repeat it.",
            "state": state or "unknown", "op_lookup": ans})
    if lkind == "refused" and "orgtree_op_lookup" in ltext:
        return json.dumps({
            "error": f"orgtree API gave no answer for this call ({lost}), and "
                     f"this backend does not support operation receipts, so "
                     f"whether it applied CANNOT be established. Check the "
                     f"org before repeating it.",
            "state": "unknown", "reason": "unsupported_build"})
    return json.dumps({
        "error": f"orgtree API gave no answer for this call ({lost}), and the "
                 f"follow-up lookup also failed ({ltext[:200]}) — whether it "
                 f"applied is UNKNOWN. Check the org before repeating it.",
        "state": "unknown", "reason": "lookup_failed"})


def reply(id_: int | str | None, result: Any = None, error: Any = None) -> None:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = {"code": -32000, "message": str(error)}
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main() -> None:
    # ⚠ Windows defaults stdio to cp1252 — the CLI speaks UTF-8 JSON-RPC, so
    # without this every non-ASCII char in mail bodies (em-dashes…) arrived
    # mojibake'd (observed live: "—" → "â€\"")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")    # type: ignore[attr-defined]  # TextIO stub lacks reconfigure; runtime TextIOWrapper has it (hasattr-guarded)
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # type: ignore[attr-defined]  # ditto
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        # ⚠ a line may parse as ANY json value — 5, "x", null, or a JSON-RPC 2.0
        # BATCH (a list), which is legal on the wire. `msg.get(...)` on those
        # raised AttributeError out of the loop and the process EXITED: an
        # agent whose MCP server dies mid-turn loses its only way to act, with
        # no error it can see. Same for a `params` that is not an object.
        if not isinstance(msg, dict):
            continue
        msg = cast("dict[str, Any]", msg)
        method = msg.get("method", "")
        id_ = msg.get("id")
        raw_params = msg.get("params")
        params: dict[str, Any] = (cast("dict[str, Any]", raw_params)
                                  if isinstance(raw_params, dict) else {})
        if id_ is None:
            # a notification draws NO response (JSON-RPC 2.0 / MCP): the
            # unsolicited `"id": null` this used to emit for an id-less
            # tools/call is a frame no client can match to a request
            continue
        if method == "initialize":
            reply(id_, {
                "protocolVersion": params.get("protocolVersion",
                                              "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "orgtree", "version": "1.0.0"},
            })
        elif method == "tools/list":
            reply(id_, {"tools": available_tools()})
        elif method == "tools/call":
            raw_args = params.get("arguments")
            out = call_api(str(params.get("name", "")),
                           cast("dict[str, Any]", raw_args)
                           if isinstance(raw_args, dict) else {})
            try:
                parsed = json.loads(out)
                is_err = isinstance(parsed, dict) and ("error" in parsed or "detail" in parsed)
                pd = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else None
                text = pd.get("error") or pd.get("detail") or out \
                    if pd is not None else out
            except json.JSONDecodeError:
                is_err, text = False, out
            reply(id_, {"content": [{"type": "text", "text": str(text)}],
                        "isError": bool(is_err)})
        else:                      # unknown request — answer, don't wedge the client
            reply(id_, {})


if __name__ == "__main__":
    main()
