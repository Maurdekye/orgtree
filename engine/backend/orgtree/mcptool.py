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
    from . import deployment, opreceipts
else:
    # Sandboxed Claude runs this dependency-free server by its mounted file
    # path rather than with ``-m``. Preserve that supported entry point while
    # sharing the one authoritative policy parser.
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from orgtree import deployment, opreceipts

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
    ("On Windows (THIS MACHINE) the target is handed to cmd.exe with the "
     "backend service's PATH: grep, sed, awk, tr, $(...), $VAR and /tmp/... "
     "DO NOT WORK, and `find` is FIND.EXE, not GNU find. Write cmd: findstr, "
     "dir /b, %VAR%, %TEMP%. (On a POSIX host or inside a sandbox it is "
     "`sh`, without your interactive rc files or PATH additions.) "
     if os.name == "nt" else
     "The target is handed to `sh` with the backend service's environment — "
     "your interactive shell's aliases, rc files and PATH additions are NOT "
     "there, so use absolute paths for anything unusual. (On a Windows host "
     "it is cmd.exe instead, where grep/sed/awk/$(...)/$VAR/tmp all fail.) "))

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

TOOLS: list[dict[str, Any]] = [
    {
        "name": "orgtree_message",
        "description": (
            "Send a message to another agent in your organization. Allowed: any "
            "descendant (any depth — messaging a non-child descendant grants it an "
            "audience to reply), your direct superior, your peers, any superior you "
            "hold an audience with, 'user' (top-level agents only), or an OUTSIDE "
            "party — '@org:<slug>' (another organization's shared inbox), "
            "'@mcp:<id>' (a polling external chat) or "
            "'@net:<slug>' (a chat or org elsewhere, via the mail hub). A "
            "bare outside name also works: transport resolves automatically "
            "(local org or known @mcp: peer first — fewer hops — then the "
            "hub; an ambiguous name is refused with the candidates named). "
            "Outside mail is sent by ORG-INBOX AUDIENCE HOLDERS (a top-level "
            "agent sending without the audience is auto-granted it by the "
            "send), goes out AS THE ORG (not under your name), and should be "
            "a single coordinated reply. The recipient is driven on delivery; "
            "replies arrive in your own future turns. An ARCHIVED recipient "
            "still receives: the mail waits in its inbox and is acted on when "
            "rehired."),
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
                    "description": "files to send WITH the mail — paths "
                                   "relative to your working folder, ≤25 MB "
                                   "each. Recipients: 'user' (they get "
                                   "download cards on the mail — an IMAGE "
                                   "renders viewable in place — say what "
                                   "you attached in the body) and '@net:' "
                                   "peers (files land in the receiving "
                                   "agents' uploads/). Local agent "
                                   "recipients: use orgtree_send_file or "
                                   "just tell them the path",
                },
                "urgent": {
                    "type": "boolean",
                    "description": "USE SPARINGLY. Mail to 'user' only. The "
                                   "user's inbox PULSES and lights up the "
                                   "way an unanswered question does, and "
                                   "stays lit until they read it. Reach for "
                                   "it only when their attention is genuinely "
                                   "required NOW in a way that is not a "
                                   "question you could have asked with "
                                   "orgtree_ask. The signal only works while "
                                   "it is rare: mail marked urgent as a "
                                   "matter of course trains them to ignore "
                                   "the pulse, and then it is worth nothing "
                                   "to the agent that really needs it. "
                                   "Requires urgent_reason.",
                },
                "urgent_reason": {
                    "type": "string",
                    "description": "Required with urgent. ONE LINE, WRITTEN "
                                   "FOR THE USER, in their language: why they "
                                   "are being interrupted right now. It is "
                                   "SHOWN to them next to the mail, not "
                                   "logged — so it is the justification they "
                                   "will judge the interruption by. Not an "
                                   "internal note, not a summary of the mail.",
                },
            },
            "required": ["to", "body"],
        },
    },
    {
        "name": "orgtree_send_notice",
        "description": (
            "Send a PASSIVE notice to another agent in this organization — "
            "mail that never wakes anyone. It lands in the recipient's "
            "mailbox and is read at the start of their next turn, whenever "
            "that happens for its own reasons; if they are mid-turn right "
            "now it is slipped in like any mail. Same addressing rules as "
            "orgtree_message (reports at any depth, superior, peers, held "
            "audiences) but in-org agents only — 'user' and outside "
            "addresses (@org:/@mcp:/@net:) take orgtree_message, which is "
            "already passive for them. Use it for FYIs, progress notes and "
            "heads-ups that don't warrant interrupting or waking the "
            "recipient; expect NO reply — an idle recipient may not read it "
            "for a long time. Anything that needs action or an answer is a "
            "normal orgtree_message."),
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
            "Rename an agent BELOW you (full identity: its id, mailbox, "
            "working folder and session move with it). Allowed on any "
            "descendant; never on yourself or a peer. ⚠ Historical mail and "
            "logs keep the old name, and anyone addressing the old name "
            "bounces until they notice — tell your team."),
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
            "Ask the USER a structured question. It ALWAYS parks: an "
            "interactive card appears on your desk and in the user's inbox, "
            "and the answer arrives later as ordinary mail — so ask, then "
            "WRAP UP AND END YOUR TURN; never wait or poll. Optionally give "
            "2-4 options (the user can always answer free-text instead). "
            "Several related questions go in ONE card: pass `questions` "
            "(1-4 entries, each with its own options/multi/header) and the "
            "user answers every tab before one combined answer mail arrives. "
            "The question STAYS OPEN across turns — other mail waking you "
            "does NOT void it. You have ONE open request BATCH: asking again "
            "APPENDS more question tabs to it (re-asking the same question "
            "text amends that tab), and a credit or scope request joins the "
            "SAME card as its own tabs — everything resolves together at the "
            "user's single submit (they may skip tabs; a skipped tab returns "
            "unanswered). The batch ends only at that submit or when you "
            "withdraw it (orgtree_withdraw_ask). "
            "⚠ BECAUSE it outlives the turn, it is YOURS to take back: "
            "if a later turn brings information that answers it or makes it "
            "moot — the user says something that settles it, a peer reports "
            "the fact you were missing, the premise dies, you work it out "
            "yourself — withdraw it immediately instead of leaving the user a "
            "card they still have to deal with. An unanswered question they "
            "no longer need is a chore you handed them. If you hold no user "
            "audience and are not top-level, the "
            "question is routed to your superior as mail instead."),
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
                    "description": "2-4 answer options; the user can always "
                                   "answer free-text instead",
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
                              "description": "docket item NAME this question is "
                                             "about (orgtree_work). It shows "
                                             "inside that item and holds it in "
                                             "the user's attention until "
                                             "answered or withdrawn; you need "
                                             "read right on the item"},
                "questions": {
                    "type": "array", "minItems": 1, "maxItems": 4,
                    "description": "batch form — 1-4 questions asked as ONE "
                                   "card with tabs; every tab is answered "
                                   "before the single combined answer "
                                   "arrives. Overrides the single-form "
                                   "fields",
                    "items": {"type": "object", "properties": {
                        "question": {"type": "string"},
                        "header": {"type": "string",
                                   "description": "short tab label"},
                        "options": {"type": "array", "maxItems": 4,
                                    "items": {"type": "object", "properties": {
                                        "label": {"type": "string"},
                                        "description": {"type": "string"},
                                    }, "required": ["label"]}},
                        "multi": {"type": "boolean"},
                        "work_item": {"type": "string",
                                      "description": "docket item this tab is "
                                                     "about (per tab — one "
                                                     "batch may cover two "
                                                     "items)"},
                    }, "required": ["question"]},
                },
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_work",
        "description": (
            "THE DOCKET — the organization's durable record of substantive "
            "work, read by the user in a Work panel. Items survive "
            "retirement, compaction and reassignment. Actions: `list` (the "
            "items you may read; include_archived for finished ones, "
            "include_backlogged for ones nobody has started), `get` "
            "(one item in full), `create` (title, REQUIRED objective, kind "
            "code|non-code, owner = you or a subordinate, participants, "
            "acceptance conditions, optional first done_so_far/"
            "working_on_next). `objective` is the item's DESCRIPTION and may "
            "not be blank: state the PROBLEM being faced FIRST, then the "
            "proposed solution — the user reads it to know why the item "
            "exists, and a title alone never says what is wrong. `update` "
            "(THE status update: ALWAYS carries "
            "done_so_far AND working_on_next as lists of individual entries "
            "— either may be empty, both empty is refused — plus optional "
            "status backlogged|open|in_progress|blocked|review|"
            "dropped, blocked_reason, dropped_reason, "
            "attention:true + attention_reason for a concrete reason the user "
            "must see, reopen:true to resume an archived item), `assign` "
            "(owner), `participants` (add/remove collaborators: they may "
            "read, update, add evidence and attach questions), `evidence` "
            "(kind note|link|file|commit|log, ref, note — cap 50, refused "
            "not truncated), `claim` (a delivery stage implemented|committed|"
            "pushed|deployed|in_build with a sha for the git-checkable ones), "
            "`verify` (checks a committed/pushed/in_build claim against THIS "
            "repository's git — object exists / ancestor of the local "
            "origin/main tracking ref / ancestor of the booted commit; three-"
            "valued, never a functional check), `check` (mark acceptance "
            "condition `index` met with evidence_ref), `accept` (→ done; "
            "the user or a superior of the owner, never the owner — assert "
            "`review` and wait), `archive` (a closed item, early), "
            "`review` MEANS REVIEW BY AGENTS and is never how you ask the "
            "user for anything: their own review is the ATTENTION mechanism "
            "(attention:true, or a question via orgtree_ask work_item), and an "
            "item waiting only on the user is accepted straight from whatever "
            "status it is in — it does not pass through `review` first. Ask "
            "for their review ONLY when you decided something beyond the "
            "stated spec, chose a specialized edge case, filled a definition "
            "gap for them, or something is blocked on them that no attached "
            "question of yours is already asking — a QUESTION goes through "
            "orgtree_ask, the manual flag is for what is not one; being "
            "visible in the UI and who owns the item are NOT reasons. Work "
            "that matches the stated requirements exactly is covered by their "
            "standing authorization once agents have verified it. "
            "`supersede` (by another item). Authority: owner, creator, "
            "their superiors, the user, and listed participants; nothing is "
            "org-public. Done items archive by themselves an hour after "
            "their last update; a DROPPED item archives AT ONCE (user "
            "2026-09-07) — records kept either way. `delete` (user "
            "2026-09-07) REMOVES THE TICKET RECORD: it leaves the docket and "
            "its archive for good, other items' pointers to it are cleared, "
            "and its name is never minted again; historical mail and the org's "
            "audit log keep what they already say. Only the user, a superior "
            "of the owner, or a top-level owner may do it — never a "
            "subordinate on its own item, a participant or the reviewer; it "
            "refuses while children are nested under it or an attached "
            "question is open. Archive or drop is the normal way to close; "
            "delete is for a record that should not exist. "
            "ASSIGNMENT IS OWNERSHIP (user ruling 2026-09-05): the assigned "
            "agent holds the item's management rights, is who the docket "
            "names, and is where the user's replies on it go. `assign` TELLS "
            "it so. YOUR OWN UPDATE CLAIMS THE ITEM — so when you update "
            "somebody else's item, pass `owner` naming the agent that already "
            "holds it and it stays with them. `review` is the named "
            "reviewer's verdict (decision approve|changes): approve completes "
            "the item, changes sends it back to the owner as in_progress. A "
            "reviewer is named by the update that enters status review "
            "(`reviewer`), may never be the owner, and gets read + evidence + "
            "that one decision — never ownership. "
            "attention:true CLEARS a standing attention flag; a user "
            "dismissal makes the item blocked and an exact repeat of the "
            "dismissed reason is refused. `backlogged` means NOT YET "
            "APPROACHED OR APPROVED: it is kept out of the toolbar's active "
            "count and hidden behind its own toggle, so use it only for work "
            "genuinely not started — do not reclassify open work that is "
            "authorised or under way. AN ITEM IS IDENTIFIED SOLELY BY ITS "
            "READABLE SLUG (`git-review-workspace`), derived from its title "
            "and returned by create/list/get — pass it as `slug`. There is no "
            "other identifier: the old opaque `w########` ids are retired and "
            "are NOT translated, so a reference you are carrying from an "
            "older context will be refused rather than resolved. A slug is "
            "fixed at creation and does not follow a later title change, so a "
            "name already written down keeps working. The "
            "user's replies on an item go "
            "to the agent it is ASSIGNED to; question answers go to their "
            "asker (attach questions with orgtree_ask work_item)."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["list", "get", "create", "update", "assign",
                                    "review", "participants", "evidence",
                                    "claim", "verify", "check", "accept",
                                    "archive", "supersede", "move",
                                    "delete"]},
                "slug": {"type": "string", "description": "the work item's readable name, e.g. git-review-workspace (every action but list/create). Items have no other identifier"},
                "include_archived": {"type": "boolean", "description": "list: include archived items"},
                "include_backlogged": {"type": "boolean", "description": "list: include backlogged (not yet started) items"},
                "title": {"type": "string", "description": "create/update: short concrete title"},
                "objective": {"type": "string", "description": "create (REQUIRED) / update: the item's description — the PROBLEM faced first, then the proposed solution"},
                "kind": {"type": "string", "description": "create: code|non-code · evidence: note|link|file|commit|log"},
                "owner": {"type": "string", "description": "create/assign: owner node (you or a subordinate) · update: the explicit assignment — name the CURRENT owner to keep an item where it is when you update somebody else's"},
                "reviewer": {"type": "string", "description": "update entering status review: the agent that will check this work. Required there, never the owner, and it is read+evidence+the review decision — not ownership"},
                "decision": {"type": "string", "enum": ["approve", "changes"],
                             "description": "review: approve completes the item; changes returns it to its owner as in_progress (put what you want changed in `note`)"},
                "participants": {"type": "array", "items": {"type": "string"},
                                 "description": "create: collaborator node ids"},
                "add": {"type": "array", "items": {"type": "string"}, "description": "participants: node ids to add"},
                "remove": {"type": "array", "items": {"type": "string"}, "description": "participants: node ids to drop"},
                "acceptance": {"type": "array", "items": {"type": "string"},
                               "description": "create: acceptance conditions"},
                "dependencies": {"type": "array", "items": {"type": "string"},
                                 "description": "create: names of items this one depends on"},
                "done_so_far": {"type": "array", "items": {"type": "string"},
                                "description": "update (required) / create: what is complete — individual entries"},
                "working_on_next": {"type": "array", "items": {"type": "string"},
                                    "description": "update (required) / create: what you are doing now and the next steps"},
                "status": {"type": "string",
                           "description": "create/update: backlogged|open|in_progress|blocked|review|dropped (done only via accept). `review` = REVIEW BY AGENTS; asking the user to look at something is attention/orgtree_ask, not this status. `blocked` = cannot move until something outside this update happens — an answer, an event, another agent's work: it stays on your desk, counted as active, and is NEVER nudged by the idle reminder (user 2026-09-07); the answer or event itself, arriving as mail, is what resumes it, so the blocked_reason must say how you will hear of it. There is no `waiting` state any more (removed by the user 2026-09-07 — it duplicated blocked); a row recorded as waiting before then reads as blocked, with its reason, and carries legacy_status. `dropped` = the TERMINAL NON-SUCCESS outcome for work explicitly cancelled or failed unrecoverably: it needs a `dropped_reason`, archives AT ONCE (no one-hour grace — user 2026-09-07), and is never Done — never route dead work through review and acceptance instead"},
                "blocked_reason": {"type": "string", "description": "create/update: REQUIRED when you move an item to blocked — what is preventing progress, what would unblock it, and who can act when that is known. A blank string is refused rather than erasing what is recorded"},
                "dropped_reason": {"type": "string", "description": "update: REQUIRED when you end an item as `dropped` — why this work ended without being completed. Say plainly whether it was CANCELLED or FAILED UNRECOVERABLY, who decided, and what would have to change for it to be worth resuming. A blank string is refused rather than erasing what is recorded"},
                "attention": {"type": "boolean",
                              "description": "update: raise the manual attention flag (needs attention_reason)"},
                "attention_reason": {"type": "string", "description": "update: the concrete reason the user must see — what was asked against what was built, the exact decision, edge case or definition you added beyond the spec, and the confirmation you want. 'Ready for review' or 'please approve' is not enough; this is what they read to know what they are approving"},
                "reopen": {"type": "boolean", "description": "update: resume an archived/closed item"},
                "stage": {"type": "string",
                          "description": "claim/verify: implemented|committed|pushed|deployed|in_build"},
                "ref": {"type": "string", "description": "claim: lowercase hex sha (git stages) or a note · evidence: path/url/sha/log"},
                "note": {"type": "string", "description": "claim/evidence/check/accept: free text"},
                "index": {"type": "integer", "description": "check: acceptance condition index (0-based)"},
                "evidence_ref": {"type": "string", "description": "check: what shows the condition is met"},
                "by": {"type": "string", "description": "supersede: the replacing item's name"},
                "parent": {"type": "string", "description": "create/move: the name of the item to nest this one under. move with an empty string returns it to the top level. A child keeps its own owner, status and authority — nesting says how work is ORGANISED, it does not grant or inherit anything"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_withdraw_ask",
        "description": (
            "Withdraw your own ACTIVE request batch — every open question "
            "tab, the pending credit request and the pending scope items "
            "together — as soon as it stops "
            "applying. (Withdrawal is whole-batch: re-ask the tabs that "
            "still matter afterwards.) The usual trigger is NEW INFORMATION arriving in a "
            "later turn: the user answers something else that settles it, a "
            "peer or your superior tells you the fact you were missing, the "
            "work moves on, the premise dies, or you simply work it out "
            "yourself. Check your open request whenever a turn brings you "
            "something new — a question left standing after it stopped "
            "mattering is a chore on the user's screen with your name on it. "
            "Withdrawing is cheap and re-asking later is fine; leaving a dead "
            "card up is neither. The card is nulled and no answer will "
            "arrive. Benign no-op if you have "
            "nothing active. This is one of the only three ways a request "
            "ends besides the user acting on it: withdraw, pose a new "
            "request (replaces the old), or the user answers/dismisses."),
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "orgtree_self_restart",
        "description": (
            "Deploy THIS MACHINE's orgtree install and/or its mail hub from "
            "the repo's CURRENT state (git pull --ff-only + rebuild + "
            "restart) without waiting for an outside operator chat. What "
            "ships is whatever is COMMITTED in the repo right now — "
            "including commits made locally and never pushed. There is no "
            "'is this install behind?' precondition: the pull advancing "
            "nothing is normal and the rebuild+restart happens anyway, "
            "which is what makes a local merge actually reach the running "
            "backend. target: 'org' "
            "(the backend — ⚠ RESTARTS EVERY ORG on this machine; your own "
            "turn may be cut mid-flight and the org resumes on the new "
            "build), 'mailhub' (rebuilds the hub container in place — its "
            "data volume, ports and .env are NEVER touched), or 'both'. "
            "Runs detached and returns immediately with a log-file path. "
            "Verification: your own next turn existing IS the liveness "
            "check; a quiet remote peer is NOT evidence of breakage (the "
            "peer transport is unbounded). No automatic rollback — if the "
            "update misbehaves, tell the user. Top-level agents and "
            "user-audience holders only; kiosks sealed; one launch per 5 "
            "minutes machine-wide. ⚠ FORCE (force=true, and it needs a "
            "`reason`): deploy NOW even though agents are mid-turn. It does "
            "not skip the check — it STOPS every working agent on this "
            "machine, waits for their turns to actually finish, and then "
            "deploys, and its answer names everyone it stopped. THE AGENTS DO "
            "NOT RESUME BY THEMSELVES: each comes back idle on the new build "
            "with its mail unread and no turn pending, so after a forced "
            "deploy YOU must message them (or their managers) or the work you "
            "interrupted just stops. Use it when the wait is worse than that "
            "— an urgent fix on a machine that never goes quiet. Otherwise "
            "use orgtree_prime_restart, which costs nobody anything. ☞ USE "
            "THIS TOOL — never run update.ps1 / "
            "update.sh yourself from your own terminal. The update restarts "
            "the backend, which tears down the turn that launched it, so a "
            "script started from your shell dies mid-build and leaves the "
            "install half-updated (measured on a peer install: the log "
            "stopped at 'building the UI' and the backend never restarted). "
            "This tool spawns it DETACHED, which is the only shape that "
            "survives your own teardown. ⚠ target 'org'/'both' REFUSES while any "
            "agent on this machine is mid-turn, and names them — the restart "
            "would cut them off. That refusal is the precondition working: "
            "wait for the machine to go idle and call again — or arm "
            "orgtree_prime_restart, which fires by itself when it does. Only "
            "if the machine never goes quiet, see FORCE below. ⚠ A restart "
            "cuts every org on this machine, so call it when you have a "
            "REASON — code committed that needs to be running, or a backend "
            "that must be bounced. Not speculatively, not on a hunch, not "
            "'to make sure': there is no such thing as a free restart, and "
            "one with nothing to deploy is pure disruption."),
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
            "ARM A RESTART THAT FIRES BY ITSELF once this machine goes "
            "quiet — the deferred form of orgtree_self_restart. Nothing "
            "happens at the moment you call it. A background engine watches, "
            "and the deploy launches as soon as NO agent on this machine is "
            "mid-turn or holding queued mail, and none has been for a short "
            "settling period. Same deploy, same targets, same authority as "
            "orgtree_self_restart; only the timing is handed to the machine. "
            "☞ USE THIS INSTEAD OF WAITING. If self_restart refuses because "
            "agents are working, do NOT plan to 'call again next wake' — "
            "that plan dies with your session. Prime it and move on: an "
            "armed prime survives YOUR COMPACTION, YOUR RETIREMENT and a "
            "backend bounce, which is the entire reason this tool exists (a "
            "merged fix once sat undeployed for a day because the agent "
            "holding the intent was compacted before it ever called). "
            "action: 'arm' (default) · 'cancel' (disarm it) · 'status' "
            "(read-only: is one primed, by whom, for what). ARMING IS "
            "IDEMPOTENT — priming while one is already armed changes "
            "nothing, including the target; the answer says so and names who "
            "armed the existing one, so 'did mine take effect' is always "
            "answerable. While a prime is armed, EVERY org's header shows a "
            "'restart primed' chip, because the restart cuts every org. "
            "target: 'org' (the backend — restarts every org here), "
            "'mailhub' (rebuilds the hub container in place), or 'both'. "
            "Give a `reason`: it is what the person who sees the chip reads. "
            "⚠ NOT THE SAME TOOL AS force: this one WAITS for quiet and costs "
            "nobody a turn, and it is the right answer almost always. "
            "orgtree_self_restart force=true is the opposite trade — it "
            "deploys NOW by stopping the agents that are working. Reach for "
            "this one first; reach for force only when the machine will not "
            "go quiet and the wait is worse than the interruption. "
            "⚠ deadline_minutes (OPTIONAL, off by default, needs a `reason`): "
            "the bounded version — 'deploy when quiet, and if it is not quiet "
            "in N minutes, force'. WITHOUT it a prime waits forever, which is "
            "the failure this option exists for: one sat unfired for over two "
            "hours while ten commits stacked up behind it. When the deadline "
            "expires the restart ESCALATES — it stops whoever is working, "
            "waits for their turns to settle, and deploys anyway, exactly as "
            "force does. Two things to weigh before you set one. (1) NOBODY "
            "WILL BE PRESENT: the escalation happens unattended, which is the "
            "point (it survives your compaction, and force cannot) and also "
            "the risk, so the reason you give here is the only account "
            "anyone will ever read. (2) The agents it cuts are WOKEN AGAIN on "
            "the new build, one turn each, so they pick their own work back "
            "up — that is a real cost of the escalation and it is charged to "
            "their orgs. A quiet machine NEVER escalates: if it goes quiet "
            "before the deadline the ordinary path fires and the deadline is "
            "simply never reached. Minimum 5 minutes, maximum 1440. "
            "Top-level agents and user-audience holders only; kiosks sealed. "
            "⚠ Still a real restart — have a REASON (code committed that "
            "needs to be running, a backend that must be bounced). 'Primed' "
            "does not make it free; it makes it PATIENT."),
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
                    "description": "OPTIONAL, off by default. Force the "
                                   "deploy if the machine has not gone quiet "
                                   "within this many minutes (5–1440). "
                                   "Requires `reason`. The escalation stops "
                                   "whoever is working and wakes them again "
                                   "on the new build, unattended."},
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_restart_wake",
        "description": (
            "ARM A WAKING TURN ON NEXT RESTART for your node (or a subordinate report) — "
            "upgrade the passive restart notice into a full waking turn when orgtree "
            "next starts back up, telling you the deployed version so you can verify fixes. "
            "Always one-shot: fires once on the next restart, then reverts to passive notices. "
            "Survives compaction. If you need to wake on every restart, re-arm after waking. "
            "action: 'arm' (default) · 'cancel' (disarm and revert to passive notice) · 'status'. "
            "reason: why you need to be woken (e.g. 'verify commit abc'); carried "
            "forward into the wake turn and survives compaction. "
            "target: optional report node id if arming on behalf of a subordinate."
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
            "Present a DOCUMENT to the user for in-page reading — a plan, a "
            "proposal, a report. A small card appears beside your node; "
            "clicking it opens the markdown in a reader. This is a READING "
            "surface, not a download (use orgtree_send_file for files). "
            "Needs a DIRECT user audience: top-level agents and holders of "
            "a user-audience grant only — anyone else is refused (not "
            "routed; send the document to your superior instead). "
            "Non-blocking: nothing voids it and no reply is implied — keep "
            "working. Body is markdown, ≤64 KB; relative image paths "
            "(![](outbox/chart.png)) resolve against your working folder "
            "and render inline, so a report can carry its figures. Present "
            "again with "
            "`replaces` set to the returned id to update the same card in "
            "place instead of stacking a second one (newest 10 per agent "
            "are kept). HTML MOCKUPS: pass `path` (a .html/.htm file in your "
            "working folder, the workspace or a folder you hold, ≤4 MB) "
            "INSTEAD of `body` — the card then opens the page in a new "
            "browser tab. The file is snapshotted when you present it (edit "
            "and re-present with `replaces` to update). It runs SANDBOXED: "
            "inline CSS/JS work, but there is NO network — external "
            "scripts, stylesheets, fonts and images will not load (inline "
            "them, e.g. data: URLs), and it cannot reach the orgtree app or "
            "its API. The preview is operator-only; the HTML file remains "
            "downloadable to kiosk visitors like any outbox artifact."),
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
        "name": "orgtree_request_credits",
        "description": (
            "Ask the user directly for a larger credit grant — allowed for "
            "TOP-LEVEL agents and holders of a USER AUDIENCE (a deep grant "
            "cascades down your superior chain). Not mail — a structured "
            "request card on your desk and in the user's inbox. State the "
            "requested NEW TOTAL grant (not the increase) and a concrete "
            "reason. The user may grant the asked "
            "amount, MORE, LESS, or even reduce your grant — their decision "
            "arrives as mail, and you may take it as-is, re-ask, or route "
            "around it. If there are genuinely ZERO credits available to "
            "grant, the request is refused outright with no card. The "
            "request STAYS PENDING across turns — other mail does not void "
            "it. It rides your ONE open request BATCH as its own tab, beside "
            "any question or scope tabs (asking again amends the figure in "
            "place — the card always shows your CURRENT ask). The batch "
            "resolves together at the user's single submit; it ends only by "
            "their decision there, or your withdrawal "
            "(orgtree_withdraw_ask)."),
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
            "Ask the USER for a permission-scope increase you cannot get "
            "any other way: access to a folder, a built-in tool (bash, web, "
            "edit, subagents), an MCP server, or a higher permission mode. "
            "USER-ONLY grantor: if your SUPERIOR already holds what you "
            "need, just ask them — they can grant it directly with "
            "orgtree_retool, no card needed; this tool is for capabilities "
            "nobody below the user holds. Requests ride your ONE open batch "
            "beside any question or credit tabs: re-requesting merges items "
            "by identity, and the user decides approve/deny/skip PER ITEM "
            "at one submit — the outcome arrives as mail, and an approved "
            "grant is live from your next turn (a deep grant raises your "
            "whole chain automatically). Items you already hold are dropped "
            "as no-ops. If you hold no user audience and are not top-level, "
            "the request is mailed to your superior instead. It parks: "
            "request, then WRAP UP AND END YOUR TURN."),
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
        "name": "orgtree_watchdog",
        "description": (
            "Keep a WATCHDOG — a free, persistent pet that mails you (waking "
            "you with a turn) when its target produces a matching event. It "
            "survives orgtree restarts, unlike your session-bound Monitor "
            "shapes, so it is THE tool for 'tell me when X happens' across "
            "hours or days: a build/deploy finishing, an error appearing in "
            "a log, a file another process drops, a service going down. "
            "Kinds: file (poll a path; new content matching `pattern` fires "
            "— events during orgtree's own downtime are recovered), command "
            "(run a command each interval, matching output fires), process "
            "(pid:N or port:N liveness — fires on the DOWN edge), stream (a "
            "persistent LISTENING command, e.g. a tail; each matching output "
            "line fires the moment it occurs — realtime, but output during "
            "orgtree downtime is lost). A command/stream dog runs with YOUR "
            "AUTHORITY (needs your bash; runs in your sandbox if you have "
            "one) — but ⚠ NOT IN YOUR SHELL. " + _WD_SHELL_WARNING +
            "If you would rather write the POSIX idiom, pass "
            "shell:\"bash\" and the target runs in `bash -lc` instead — it "
            "REFUSES at create if no bash exists here rather than quietly "
            "using cmd.exe, so a create that succeeds means the shell you "
            "asked for is the shell you got. "
            "Every create SMOKE-RUNS your target once and returns its real "
            "output and exit code in `smoke`: READ IT — that is the five "
            "seconds that tells you whether this dog can ever fire. And "
            "`list` reports `checks_run`, `last_check`, `last_output` and a "
            "`health` line, because `armed, fired: 0` alone cannot "
            "distinguish 'armed a minute ago' from 'ran 700 times over nine "
            "days and matched nothing'. "
            "⚠ A DOG ALSO MAILS YOU WHEN THE THING IT WATCHES GOES QUIET, "
            "without being asked (D-176) — a file that has stopped growing "
            "across many consecutive checks, a command the shell cannot run "
            "at all, a `pid:` whose DOWN edge has already fired and can never "
            "fire again. That mail carries the facts (size, last write, "
            "checks run, what it last saw) and is NOT a report about orgtree "
            "restarting: restarts and deploys never produce it, because the "
            "counter only advances on checks that actually ran. For a FILE "
            "dog it says STALENESS and means it — a quiet file and a dead "
            "writer look identical from here, so the dog stays armed and it "
            "is you who goes and checks the producer. ⚠ And prefer a "
            "`process` dog on the producer's pid over a `file` dog on its "
            "log when you have the choice: a string dog cannot tell a slow "
            "producer from a dead one, while a pid dog fires either way. "
            "A dog WAKES you by default; pass notice:true at create to have "
            "it fire passively instead — the event still lands in your "
            "mailbox, but no turn is started for it and you read it whenever "
            "you next run. "
            "⚠ ONE-SHOT DOGS, and WHEN YOU MUST USE ONE (D-200): pass "
            "once:true at create and the dog fires EXACTLY ONCE and then "
            "REMOVES ITSELF — the fire mail says so, and `list` will not show "
            "it afterwards. Reach for this whenever the thing you are waiting "
            "for can only happen once. ☞ THE TRAP IT EXISTS FOR: a dog whose "
            "pattern encodes a DEADLINE rather than an EDGE is PERMANENTLY "
            "TRUE once that deadline passes, so it re-fires every single "
            "interval, forever, waking you each time with the same answer. A "
            "pattern like 'READY=yes' or 'ELAPSED>24h' is a deadline; 'BUILD "
            "FAILED' appearing in a log is an edge. This has actually "
            "happened here — a dog woke its owner every 15 minutes with an "
            "identical verdict until it was removed by hand. If your "
            "condition is a deadline, or your question has exactly one "
            "answer, set once:true; otherwise you must remove the dog "
            "yourself in the same turn you act on its first fire. "
            "Costs no credits; capped at 8 per agent — and a one-shot dog "
            "gives its slot back when it fires. Actions: create, list, "
            "pause, resume, remove — superiors may manage their subtree's. "
            "Prefer a watchdog over burning turns polling for a condition "
            "yourself."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["create", "list", "pause", "resume",
                                    "remove"]},
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
                           "description": "create: fire PASSIVELY — the "
                                          "event still lands in your mailbox "
                                          "but no turn is started for it, so "
                                          "you read it whenever you next run "
                                          "(default false = it wakes you). "
                                          "Use it for 'tell me the build "
                                          "finished' — worth knowing, not "
                                          "worth a turn"},
                "once": {"type": "boolean",
                         "description": "create: make it a ONE-SHOT DOG — it "
                                        "fires exactly once and REMOVES "
                                        "ITSELF as part of that fire (default "
                                        "false = it keeps watching forever). "
                                        "Use it whenever the condition can "
                                        "only happen once, and ALWAYS when "
                                        "your pattern encodes a DEADLINE "
                                        "rather than an EDGE — a deadline "
                                        "stays true, so a persistent dog on "
                                        "one re-fires every interval forever. "
                                        "Works with every kind, and combines "
                                        "with notice"},
                "shell": {"type": "string", "enum": ["native", "bash"],
                          "description": "create, command/stream only: which "
                                         "shell interprets `target`. Default "
                                         "\"native\" = this platform's own "
                                         "(cmd.exe on Windows). \"bash\" runs "
                                         "`bash -lc`, so grep/sed/awk/"
                                         "$(...)/$VAR work — and the create "
                                         "REFUSES if no bash is installed "
                                         "here rather than silently falling "
                                         "back to cmd, where your target "
                                         "would match nothing forever"},
                "id": {"type": "string",
                       "description": "pause/resume/remove: the watchdog id"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "orgtree_hire",
        "description": (
            "Hire a subagent under you (or deeper in your subtree), or INSERT "
            "a superior above a seat in your subtree (hire_type='superior'). "
            "There are NO defaults for you: write the hire's CHARTER in full "
            "(its role and standing instructions — injected into every one of "
            "its turns, editable later via orgtree_retool). TWO MODES, ONE "
            "RULE EACH, enforced by the server: an ORDINARY hire (hire_type "
            "omitted or 'subordinate') MUST state add_dirs, tools and "
            "org_visibility explicitly — refused if any is missing — and you "
            "cannot grant anything you do not hold yourself; a SUPERIOR "
            "insertion MUST OMIT add_dirs, tools, org_visibility and "
            "permission_mode — refused if any is present — because the seat "
            "takes the target's own. The schema therefore lists those fields "
            "as optional; which mode you are in decides whether they are "
            "required or forbidden. Seat costs: haiku 1, sonnet 2, "
            "opus 5, fable 10 (Claude); luna 0.2, terra 2, "
            "sol 5 (Codex — "
            "hireable only while the Codex CLI is signed in on this machine; "
            "luna runs on OpenAI's reserve capacity FIRST when the signed-in "
            "ChatGPT account holds that grant, and falls back to the direct "
            "Luna lane when reserve is spent or withdrawn — there is no "
            "separate reserve tier to hire); "
            "flash 1, pro 2 (Antigravity — hireable only while the "
            "Antigravity CLI is signed in on this machine); "
            "seat + grant must fit within YOUR free credits. "
            "ONE CALL IS ENOUGH: this tool also takes the fields you would "
            "otherwise have to orgtree_retool in straight afterwards "
            "(permission_mode — SET IT, see below; effort; team_charter), the "
            "`audiences` to grant, and a `kickoff` prompt that actually starts "
            "the agent. They apply in that order, kickoff LAST, so the hire's "
            "first turn never begins before it is fully the agent you "
            "described. Any refusal anywhere in the call refuses the WHOLE "
            "call — a hire that returns is a hire that got everything it "
            "asked for. ⚠ WITHOUT `kickoff`, HIRING STARTS NO ONE: the hire "
            "sits IDLE until it receives its first message — the charter is "
            "who it is, not a task to begin — so either pass `kickoff` here "
            "or follow up with an orgtree_message, or it will sit there doing "
            "nothing forever."),
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
                        "which side of `target` the seat lands on. "
                        "'subordinate' (default) = a report of the target, "
                        "today's behaviour. 'superior' = INSERT ABOVE the "
                        "target: the new agent takes the target's own "
                        "position under the target's superior, and the "
                        "target with its entire team becomes its report. ⚠ "
                        "In this mode OMIT add_dirs, tools, org_visibility "
                        "and permission_mode: the seat takes the TARGET's "
                        "(the team below it must stay within what it "
                        "holds), so passing ANY of them — even values equal "
                        "to the target's — is refused rather than silently "
                        "overwritten; retool it afterwards if it should hold "
                        "less. (In 'subordinate' mode the first three are "
                        "REQUIRED instead.) Costs you exactly what the same "
                        "ordinary hire costs; the insertion itself moves no "
                        "credits. With target=yourself this hires your own "
                        "replacement into your seat and puts you under it; "
                        "only the user may do it above a TOP-LEVEL "
                        "target."},
                # D-160 — the retool-only trio, now settable at hire. Same
                # rules retool enforces (it IS retool underneath): capped at
                # your own, and you cannot grant what you do not hold.
                "permission_mode": {
                    "type": "string",
                    "enum": ["plan", "default", "acceptEdits",
                             "bypassPermissions"],
                    "description":
                        "how much the hire is asked before acting. SET THIS: "
                        "the org default is usually 'default', which ASKS — "
                        "and a headless turn has nobody to answer, so the "
                        "hire cannot act at all. 'acceptEdits' is the normal "
                        "working seat; 'plan' is a read-only planning seat; "
                        "'bypassPermissions' asks nothing and is the only "
                        "mode that can write a path containing a .claude "
                        "segment — it removes guardrails on every path on the "
                        "machine, not just the one you had in mind, so grant "
                        "it only when the work needs it and say why. CAPPED "
                        "AT YOUR OWN."},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort for the hire — a "
                                          "cost/quality dial ('' = the CLI "
                                          "default)"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": "luna only: try OpenAI's reserve capacity "
                                   "FIRST (true, the default when omitted) or "
                                   "the plan's normal weekly usage first "
                                   "(false). The other pool is the fallback "
                                   "either way when the first is spent or "
                                   "withdrawn; ignored on every other tier"},
                "team_charter": {"type": "string",
                                 "description": "standing instructions binding "
                                                "the hire's OWN subtree — set "
                                                "it if it will hire in turn"},
                "audiences": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description":
                        "audiences to grant the hire on the spot — the same "
                        "targets orgtree_audience action=grant takes, and "
                        "enforced by that exact code: 'user' (a direct line "
                        "to the user's inbox — yours to give only if you are "
                        "top-level), 'extern' (the ORG INBOX: outside mail "
                        "reaches holders only), your own id, a live peer of "
                        "yours, or your direct superior. More than one is "
                        "fine. A target you could not grant the long way is "
                        "refused here too, and refuses the whole hire"},
                "kickoff": {
                    "type": "string",
                    "description":
                        "the hire's FIRST TASK — identical in effect to the "
                        "orgtree_message you would send it next, but "
                        "guaranteed to land after its scope, mode and "
                        "audiences are all in place. Pass it and the agent "
                        "starts working; omit it and the agent sits idle. "
                        "Write what to do NOW, not who it is (that is the "
                        "charter)"},
                "kickoff_kind": {"type": "string",
                                 "enum": ["message", "question", "request",
                                          "decision", "status"],
                                 "description": "kind of the kickoff mail "
                                                "(default 'request')"},
                "work_item": {
                    "type": "string",
                    "description":
                        "a docket item (its slug) to ASSIGN to the new agent "
                        "in this same call — assignment is OWNERSHIP, so it "
                        "becomes responsible for the item and the user's "
                        "replies on it come to it. It is told so by mail, and "
                        "that notification STARTS the agent by itself: with a "
                        "work_item and no kickoff the hire is already running "
                        "on its assignment. Use orgtree_staff instead when the "
                        "item does not exist yet"},
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
            "Re-scope an agent in your subtree — ANY depth, not just direct "
            "reports: its folder grants, "
            "tool set, MCP servers, org visibility, permission mode, charter, team "
            "charter, or its "
            "thinking effort (a cost/quality dial for your REPORTS — you never set "
            "your own). Only the fields you pass change. The capability rule still "
            "binds — you cannot grant anything you do not hold yourself, and "
            "shrinking a grant clamps everything beneath the target too. "
            "ON YOURSELF (node = your own id) exactly ONE field is legal: "
            "team_charter, the standing instruction you give your own subtree — "
            "how your team works is yours to direct, and re-stating it as you "
            "learn what the work needs is expected, not a liberty. Your OWN "
            "charter, scope, tools and mode are your superior's to set: ask "
            "them with orgtree_message."),
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
                        "how much this report is asked before acting. "
                        "'plan' is a read-only planning seat (it reasons, "
                        "never edits); "
                        "'default' asks (and a headless turn cannot answer, so "
                        "it fails); 'acceptEdits' auto-approves file edits, the "
                        "normal seat; 'bypassPermissions' asks nothing at all "
                        "and is the only mode that can write a path containing "
                        "a .claude segment. CAPPED AT YOUR OWN — you cannot set "
                        "a report above the mode you hold, and lowering yours "
                        "lowers your whole subtree with it. Raising a report to "
                        "bypassPermissions removes its guardrails on every path "
                        "on the machine, not just the one you had in mind: do "
                        "it when the work genuinely needs it, not as a "
                        "convenience, and say why in the same breath."},
                "charter": {"type": "string",
                            "description": "its standing role card (every turn). "
                                           "A REPORT's only — you cannot rewrite "
                                           "your own; ask your superior"},
                "team_charter": {"type": "string",
                                 "description": "standing instructions binding "
                                                "its whole subtree. You may set "
                                                "YOUR OWN (node = your own id): "
                                                "how your team works is yours to "
                                                "direct"},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort for this report "
                                          "('' clears to the CLI default)"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": "luna only: try OpenAI's reserve capacity "
                                   "FIRST (true, the default when omitted) or "
                                   "the plan's normal weekly usage first "
                                   "(false). The other pool is the fallback "
                                   "either way when the first is spent or "
                                   "withdrawn; ignored on every other tier"},
            },
            "required": ["node"],
        },
    },
    {
        "name": "orgtree_retire",
        "description": ("Retire a node in your subtree (frees its seat + grant "
                        "back to its parent), or yourself if you have no live reports. "
                        "Retiring a node that still has live reports dissolves its whole "
                        "subtree (you'll be told). "
                        "If the node (or any of its live reports) is MID-TURN, its turn "
                        "is interrupted first and this call waits for that turn to "
                        "actually settle before the node is archived — it never comes "
                        "back 'retired' while the agent is still running. A tool call "
                        "already in flight when the interrupt lands may still finish "
                        "and touch disk; you're warned if a turn had not settled in "
                        "time. "
                        "Its session is preserved and can be rehired with context intact. "
                        "Retirement is the MOST you can do — permanent deletion is the "
                        "user's alone; if you believe an agent should be deleted, retire "
                        "it and ask the user through your chain or inbox."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_cheap_compact",
        "description": (
            "Reset an idle agent's session in place instead of compacting it — "
            "the cache-cheap alternative when a long-context report has been "
            "idle for hours or days. A normal compact re-reads its ENTIRE "
            "transcript at that moment's cache price (cold = near-full input "
            "cost); this resets the session in place (retaining seat id, "
            "parent, scope, charter, grant, and team) while archiving the "
            "prior session as a knowledge bearer (<node>@<gen>). The successor "
            "starts with ZERO context, paying only for the history it chooses "
            "to read. Refused on yourself and on nodes with open background "
            "tasks."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_rehire",
        "description": (
            "Rehire an archived node in your subtree; it resumes with its full "
            "prior context. Rehiring under an archived superior rehires the "
            "whole chain first (costs bubble). You may also rehire YOUR OWN "
            "knowledge bearer (a past generation of yourself) — it then joins "
            "as your own subordinate. An unrecoverable node is re-seeded "
            "instead: fresh session, same role, credits and reports. The one "
            "refusal: a LOST generation (marked so in the chart) has no "
            "surviving transcript — there is no memory to wake, so it can "
            "never be rehired or consulted. "
            "ONE CALL IS ENOUGH (D-160): like orgtree_hire, this also takes "
            "`name` (rename it as it wakes), the scope fields you would "
            "otherwise orgtree_retool in (charter, tools, add_dirs, "
            "org_visibility, permission_mode, effort, team_charter), the "
            "`audiences` to grant, and a `kickoff` prompt. They apply in that "
            "order, kickoff LAST, so the agent never starts its turn as "
            "something other than what you described. ⚠ ONE ASYMMETRY worth "
            "knowing: everything except `name` is all-or-nothing — a refusal "
            "discards the lot. A RENAME cannot be, because it moves folders "
            "on disk outside any transaction; it therefore runs FIRST, and if "
            "a later step refuses you are told plainly that the node is still "
            "archived under its new name."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "node": {"type": "string"},
                "grant": {"type": "integer", "minimum": 0},
                "target": {"type": "string",
                           "description": "D-224: WHERE to restore it — "
                                          "yourself or any live agent in "
                                          "your subtree. Omit to wake it "
                                          "exactly where it was archived"},
                "hire_type": {
                    "type": "string", "enum": ["subordinate", "superior"],
                    "description":
                        "which side of `target` it lands on. 'subordinate' "
                        "(default) = a report of the target. 'superior' = "
                        "INSERT ABOVE the target: the restored agent takes "
                        "the target's position under the target's superior, "
                        "and the target with its whole team reports to it. "
                        "⚠ It takes the TARGET's folders, tools, visibility "
                        "and permission mode, so omit those four here — "
                        "passing them is refused, not overwritten. Only the "
                        "user may do this above a TOP-LEVEL target"},
                "name": {"type": "string",
                         "description": "rename it as it wakes (D-160). The "
                                        "one step that cannot be rolled back "
                                        "— it runs first; see the warning "
                                        "above"},
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
                    "description": "how much it is asked before acting — "
                                   "'default' ASKS, and a headless turn has "
                                   "nobody to answer, so it cannot act at "
                                   "all. CAPPED AT YOUR OWN"},
                "effort": {"type": "string",
                           "enum": ["low", "medium", "high", "xhigh", "max", ""],
                           "description": "thinking effort ('' = CLI default)"},
                "prefer_reserve": {
                    "type": "boolean",
                    "description": "luna only: try OpenAI's reserve capacity "
                                   "FIRST (true, the default when omitted) or "
                                   "the plan's normal weekly usage first "
                                   "(false). The other pool is the fallback "
                                   "either way when the first is spent or "
                                   "withdrawn; ignored on every other tier"},
                "team_charter": {"type": "string",
                                 "description": "standing instructions binding "
                                                "its own subtree"},
                "audiences": {
                    "type": "array", "items": {"type": "string"},
                    "description": "audiences to grant it — the same targets "
                                   "orgtree_audience action=grant takes "
                                   "('user', 'extern' for the org inbox, "
                                   "your own id, a live peer, your direct "
                                   "superior), enforced by that exact code"},
                "kickoff": {"type": "string",
                            "description": "its first task on waking — same "
                                           "effect as the orgtree_message you "
                                           "would send next, but guaranteed "
                                           "to land after everything else. "
                                           "A rehire with mail already "
                                           "waiting wakes anyway"},
                "kickoff_kind": {"type": "string",
                                 "enum": ["message", "question", "request",
                                          "decision", "status"],
                                 "description": "kind of the kickoff mail "
                                                "(default 'request')"},
                "work_item": {
                    "type": "string",
                    "description":
                        "a docket item (its slug) to ASSIGN to the restored "
                        "agent in this same call — assignment is OWNERSHIP, "
                        "and the notification wakes it, so a rehire that "
                        "carries one needs no kickoff to start"},
            },
            "required": ["node"]},
    },
    {
        "name": "orgtree_staff",
        "description": (
            "STAFF A PIECE OF WORK IN ONE CALL: the docket item, the agent, "
            "and the assignment that ties them together. It is the three calls "
            "you would otherwise make — orgtree_work create (or update), "
            "orgtree_hire (or orgtree_rehire), orgtree_work assign — with the "
            "gaps between them removed. ORDER, and it matters: the seat is "
            "created first, then the item is written with THAT SEAT as its "
            "owner, so the item's history holds ONE assignment to the agent "
            "actually doing the work rather than a moment of belonging to you. "
            "ASSIGNMENT IS OWNERSHIP (user ruling 2026-09-05): the agent holds "
            "the item's management rights, is who the docket names, and is "
            "where the user's replies on it go. It is TOLD so by mail, and "
            "that notification starts its first turn — `kickoff` is optional "
            "here and, when you send one too, the agent still runs exactly "
            "one first turn. hire vs rehire: pass `node` (an archived agent) "
            "to bring somebody back, or omit it to seat somebody new; "
            "`staff_mode` says it outright and is checked rather than obeyed. "
            "Every argument means what it means in the tool it came from, and "
            "the underlying permission checks, credit checks and refusals are "
            "those tools' own — a refusal anywhere refuses the WHOLE call, "
            "leaving no item, no seat and no mail. ⚠ ONE EXCEPTION TO THAT: "
            "`parent` here is the parent WORK ITEM (as in orgtree_work), never "
            "the seat's destination — say where the agent sits with `target` "
            "and `hire_type`. To hand an item to an agent that is already "
            "live, use orgtree_work action='assign' instead; to assign an "
            "EXISTING item to a new hire without touching its status, "
            "orgtree_hire/orgtree_rehire take `work_item`."),
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
                              "description": "create (REQUIRED): the item's "
                                             "description — the PROBLEM faced "
                                             "first, then the proposed solution"},
                "kind": {"type": "string", "description": "create: code|non-code"},
                "status": {"type": "string",
                           "description": "backlogged|open|in_progress|blocked|review"},
                "done_so_far": {"type": "array", "items": {"type": "string"},
                                "description": "what is complete — individual entries"},
                "working_on_next": {"type": "array", "items": {"type": "string"},
                                    "description": "what happens next — individual entries"},
                "participants": {"type": "array", "items": {"type": "string"},
                                 "description": "create: collaborator node ids"},
                "acceptance": {"type": "array", "items": {"type": "string"},
                               "description": "create: acceptance conditions"},
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
            },
            "required": [],
        },
    },
    {
        "name": "orgtree_list_orgs",
        "description": (
            "List the reachable outside recipients: the OTHER orgs on this "
            "backend (@org:<slug>) and every hub peer (@net:<slug>, orgs and "
            "independent chats, with online/last_seen). Each entry carries "
            "`transports` — which address forms resolve it (a local org "
            "that is also hub-registered reads ['org','net']; prefer fewer "
            "hops, or send the bare name and let transport resolve). Sealed "
            "kiosk orgs are not listed."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "orgtree_list_tiers",
        "description": (
            "List the model tiers this machine currently offers, with provider, "
            "model, seat price and advisory machine availability. Call this "
            "before orgtree_hire or orgtree_switch_model when choosing a tier. "
            "The actual operation rechecks fresh provider evidence plus your "
            "org's scope, credits, kiosk/headless rules, so a listed tier can "
            "still be refused."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "orgtree_move",
        "description": (
            "Reorganize: re-parent a node in your subtree under another node "
            "in your reach (promote toward you or demote under a descendant). "
            "Budget-neutral along the chain — a fully occupied tree can still "
            "reorganize (§4.5). The node's whole suborganization moves with "
            "it. Only the user can seat agents at top level. To apply SEVERAL "
            "re-parentings as ONE all-or-nothing transaction, pass `moves` "
            "instead — they run in order, and a refusal at any step applies "
            "none of them (the classic use: [a→parent(b), b→parent(a)] swaps "
            "two positions with each node keeping its own suborganization)."),
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
                    "description": "batch form — give EITHER node+new_parent "
                                   "OR this list ('' new_parent = top level, "
                                   "user only)"},
            }},
    },
    {
        "name": "orgtree_swap",
        "description": (
            "Two agents in your reach EXCHANGE SEATS: each takes over the "
            "other's position — superior, reports, grant, team charter and "
            "clamped scope (folders/tools/visibility/permission mode) stay "
            "with the SEAT; identity, session, charter and mailbox travel "
            "with the AGENT. Works for any pair, nested or disjoint; the "
            "tree's shape never changes, so no cycles are possible and a "
            "same-tier swap moves no credits at all. A swapped "
            "commander-and-subordinate pair that ends non-adjacent keeps a "
            "standing audience so they can still talk. To swap POSITIONS "
            "with each agent keeping its own team instead, batch the two "
            "moves via orgtree_move `moves`. Only the user may reseat the "
            "top level."),
        "inputSchema": {"type": "object",
                        "properties": {"a": {"type": "string"},
                                       "b": {"type": "string"}},
                        "required": ["a", "b"]},
    },
    {
        "name": "orgtree_self_subjugate",
        "description": (
            "Step down: swap SEATS with one of your own live subordinates "
            "(any depth). It takes your place — your superior, your reports, "
            "your grant, your team charter and your folder/tool scope stay "
            "with the seat — and you take its place, keeping your identity, "
            "session, charter and mailbox. Same-tier swaps move no credits; "
            "a non-direct target keeps you a standing audience with it. THE "
            "HAND-OVER PATTERN: hire a replacement (same tier, your full "
            "scope, a successor charter), self-subjugate to it, transfer "
            "loose ends, then orgtree_retire yourself (self-retire needs "
            "you to be a leaf). A top-level agent may voluntarily hand its "
            "OWN seat to its live descendant through this tool. Ordinary "
            "top-level swaps remain user-only; this cannot raise you or "
            "replace another chain's coordinator."),
        "inputSchema": {"type": "object",
                        "properties": {"target": {"type": "string"}},
                        "required": ["target"]},
    },
    {
        "name": "orgtree_dissolve",
        "description": ("Dissolve a node in your subtree AND everything beneath it "
                        "(recursive retire, deepest first). Any node in the subtree "
                        "that is MID-TURN is interrupted and waited on before the "
                        "archive commits — same guarantee as orgtree_retire."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_interrupt",
        "description": (
            "Stop a node's CURRENT turn in your subtree, at any depth, "
            "WITHOUT retiring it — the ⏸ control, in isolation. The process "
            "stays alive and the node is not archived: it goes idle, ready "
            "for its next turn. Anything queued behind the turn (a mid-turn "
            "orgtree_switch_model, which QUEUES rather than applying while "
            "the target is busy — asking for one and then interrupting to "
            "apply it at once is the standard pattern; any queued mail) "
            "delivers/applies right at the boundary this creates. Fires and "
            "returns immediately — it does not wait for that boundary to "
            "settle, unlike orgtree_retire/orgtree_dissolve, which archive "
            "the node and so do wait. A tool call the target had already "
            "started before the interrupt lands may still finish and touch "
            "disk; this stops the AGENT, not an in-flight write. No-op "
            "(with a reason) if the target is not mid-turn."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_unstick",
        "description": (
            "Release a frozen descendant and resume it using retained replay "
            "text. Your own node, peers, and unrelated nodes are refused; "
            "the user retains the broad override and organization-wide "
            "spending and storage controls remain in force."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"}},
                        "required": ["node"]},
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
        "description": ("Report your working status. REQUIRED when you finish or get "
                        "stuck: 'done' and 'blocked' notify your superior with your "
                        "summary; 'working' and 'idle' just record state. Reporting "
                        "'done' sends that report and then leaves you IDLE — "
                        "finished and idle are the same resting state, so there is "
                        "no need to follow a 'done' with an 'idle'. While you remain "
                        "working, enabled automatic checkups may wake you after "
                        "20 minutes without a real wake to verify progress and "
                        "continue unfinished work. Busy or queued work and normal "
                        "turn-admission limits can delay a check; the interval "
                        "does not guarantee a provider cache hit."),
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
            "Your current view of the organization (scoped to your "
            "org-visibility level), with your credits and scope. EVERY ROW "
            "CARRIES THAT AGENT'S STATUS — what it last reported via "
            "orgtree_status, and HOW OLD that report is — so 'who is "
            "finished, who is mid-flight, who is stuck' is one call instead "
            "of one turn per agent. ⚠ READ THE AGE, NOT JUST THE WORD: a "
            "status is self-reported, so an agent that died still reads the "
            "last thing it said. An old 'working' is marked; '▶ mid-turn' is "
            "the system's own observation and is the only part not "
            "self-reported. RETIRED "
            "agents are not listed by default — the chart shows who is "
            "working, and on a long-running org the archived outnumber the "
            "live several times over. They are hidden, not gone: each "
            "superior that retired anyone carries a count in their place. "
            "Pass include_archived=true to list every one of them by name. "
            "⚠ WORTH DOING BEFORE YOU HIRE: rehiring an agent that already "
            "did this work restores an expert that knows this codebase, its "
            "decisions and its dead ends — check the archived list before "
            "you pay to hire a stranger who has to learn them again."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_archived": {
                    "type": "boolean",
                    "description": "list every retired/archived agent by "
                                   "name instead of counting them — the "
                                   "rehire shortlist"},
            },
        },
    },
    {
        "name": "orgtree_read_transcript",
        "description": ("Read a report's conversation transcript (read access is "
                        "strictly DOWNWARD: yourself and your descendants only — you "
                        "can never read peers or superiors)."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "last": {"type": "integer", "minimum": 1,
                                                "maximum": 80,
                                                "description": "how many recent messages"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_read_scratch",
        "description": ("Browse or read a descendant's scratch space (downward-only). "
                        "Omit path to list the root; pass a file path to read it."),
        "inputSchema": {"type": "object",
                        "properties": {"node": {"type": "string"},
                                       "path": {"type": "string"}},
                        "required": ["node"]},
    },
    {
        "name": "orgtree_send_file",
        "description": (
            "Deliver a FILE to the user as a downloadable attachment: it is "
            "copied into your outbox/ (in your working folder) and appears in "
            "your chat as a DOWNLOAD CARD. ☞ This is THE answer whenever the "
            "user asks for a file — 'send me', 'give me', 'can I have' — a "
            "log, an export, an image, a build artifact. It is the only way "
            "they can actually receive the bytes: pasting the contents into a "
            "message, or naming the path it sits at, is not a delivery. "
            "An IMAGE file (png/jpg/gif/webp/svg/…) renders in the chat AS "
            "THE PICTURE, viewable in place (click = full size, download "
            "still on the card) — so this is also how you PRESENT an image: "
            "a screenshot, a render, a diagram. "
            "Sendable paths: files in your "
            "working folder (relative paths resolve there), the workspace, or "
            "any folder you hold. Announce the file in your reply or report — "
            "the card sits at the point in the chat where you sent it. "
            "(For a document meant to be READ in-page rather than downloaded, "
            "orgtree_present is the other surface — and your replies, mail "
            "to the user and presented documents can also EMBED images "
            "inline: a relative markdown image like ![](outbox/plot.png) "
            "resolves against your working folder.)"),
        "inputSchema": {"type": "object",
                        "properties": {
                            "path": {"type": "string",
                                     "description": "the file to deliver"},
                            "note": {"type": "string",
                                     "description": "one-line caption shown "
                                                    "on the download card"}},
                        "required": ["path"]},
    },
    {
        "name": "orgtree_switch_model",
        "description": (
            "Switch the model of an agent in your SUBTREE on the fly (never your "
            "own — your superior can). If the agent is MID-TURN the switch is "
            "QUEUED (result: queued=true), not applied: it stays on its model "
            "until that turn ends, then moves from its next turn — "
            "interrupting the turn applies it at once; asking again with "
            "another tier replaces the queued target, asking for its current "
            "tier cancels it. Within one provider its session and "
            "context survive; the next turn runs the new model. ACROSS providers "
            "the conversation cannot move: the agent's pre-switch self is "
            "archived in place as a knowledge bearer (<node>@<gen> — readable "
            "with orgtree_read_transcript, rehireable on its own provider) and "
            "the agent starts a fresh session from its next turn. Cheaper tier: "
            "the seat difference becomes "
            "the agent's own free allocation. Pricier: paid from its free first, "
            "any shortfall bubbles up the chain to YOU — refused only if the "
            "whole chain lacks it. Tiers: haiku 1 · sonnet 2 · opus 5 · "
            "fable 10 (Claude); luna 0.2 · terra 2 · sol 5 "
            "(Codex, needs the CLI signed in; luna prefers reserve capacity "
            "and falls back to the direct lane); flash 1 · pro 2 (Antigravity, needs the CLI "
            "signed in); any `or-…` tier returned by orgtree_list_tiers is an "
            "OpenRouter favorite (seat = its $/M input — floored to a whole "
            "number at or above $1, the price itself below it, never under "
            "0.1). Use orgtree_list_tiers for current offered ids, prices and "
            "advisory machine availability."),
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
            "Audience machinery (§7.3). action=request: open a request to speak with a "
            "distant superior (or 'user') — it climbs your chain one refusable hop at a "
            "time, starting at your direct superior. action=forward/deny: act on a "
            "request currently awaiting YOU (from= the requester, target= who they "
            "seek). action=grant: grant a descendant (from=) an audience — with you "
            "by default, or DELEGATED to anyone in your own reach via target=: a "
            "live peer, or your direct superior ('user' if you are top-level, which "
            "hands the descendant a direct line to the user's inbox), or "
            "target='extern' — audience with the ORG INBOX: outside mail "
            "addressed to the org (@org:/@mcp:/@net:) reaches HOLDERS "
            "ONLY, so grant it to whoever should read and answer for the org "
            "(from= yourself included, if you are top-level — the 'client "
            "contact' pattern). action=revoke: rescind an audience you "
            "granted (grantee=); an org-inbox holder may revoke ITSELF, and "
            "a top-level agent may revoke any org-inbox grant in its own "
            "subtree."),
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

_AGENT_RESTART_TOOLS = frozenset({
    "orgtree_self_restart", "orgtree_prime_restart",
})


def available_tools() -> list[dict[str, Any]]:
    """The tool catalogue permitted by the install-wide deployment policy."""

    if deployment.current_policy().allow_agent_restart:
        return TOOLS
    return [
        tool for tool in TOOLS
        if str(tool.get("name") or "") not in _AGENT_RESTART_TOOLS]


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
