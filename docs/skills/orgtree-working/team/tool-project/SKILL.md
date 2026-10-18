---
name: orgtree-tool-project
description: Create a project node (a free, turn-less node with its own folder, mailbox and presentations), edit its Summary, or see and release its concurrency slots.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_project

## Call contract

Create/control projects above or below you: no turns/credits. create requires name/index; parent defaults you. above wraps a node atomically in its existing position instead of index/parent. settings reads all values; configure (name, settings) patches settings atomically. purge_waiting retracts unclaimed mail; broadcast uses normal per-recipient mail/attachment/DND/reply authority and reports each outcome. presentations lists project/team cards; read_presentation reads a bounded body chunk with next_chunk_index continuation. Concurrency slots: claim with a slot watchdog; slots (name) lists holders and line; release_slot (lease) releases yours. Any ancestor may force release or unqueue_slot (name, agent). Dead letters: dead_letters (name; id reads one); retry_dead_letter, drop_dead_letter (name, id[, reason]); event project.dead_letter alerts.

`orgtree_project` slot release and status need **either team or watchdogs**. With watchdogs on and team off, its card exposes only `action=release_slot` (your own lease, optional note), the dead-letter actions below and `action=slots` (all holders with reasons and ages, the full ordered line and recent holds; other agents' lease IDs are hidden). Project reach and lease ownership still apply. All other project actions and force release require team. Full slot coordination status is available without team, subject to project reach. With both groups off, the project tool is absent and calls are refused. Missing switches still default on; inherited denials still apply.

Project administration requires `team`. `action=describe` with `name` and `description` replaces a project's Summary (you must be above or below the project; its agents carry the new text from their next start). `action=create` makes a **project node** (what one is and who reaches it: [orgtree-projects](../projects/SKILL.md)).

- `name` (required): a new name in the organization, 1–64 letters, digits, `-`, `_` or `.`, unique among agents and projects.
- `index` (required unless `above` is supplied): the zero-based final position among the live siblings under the parent, as for [orgtree-tool-hire](../tool-hire/SKILL.md).
- `above` (optional): wrap this node atomically at its current position; see Atomic create above below.
- `parent` (optional): yourself by default; one of your reports at any depth; or a project you are inside (a nested project). Only the user creates a project at the top level.
- `description` (optional): the project’s **Summary**, shown on the **summary** tab of its desk and used as the standing charter of every agent under the project. The wire field keeps its `description` name for compatibility.

A project costs nothing: it has no seat and never holds credits of its own. The agents you later hire under it are paid by the nearest agent above it, so hire under a project with [orgtree-tool-hire](../tool-hire/SKILL.md) `parent=<project>` from an agent above it; an agent below a project is refused (`hiring under project … is paid by the agent above it`).

```json
{"action":"create","name":"website","index":0,"description":"The company website."}
```

The result names the project, its parent, its final `index`, `live_sibling_count` and its `folder` (`<data>\scratch\<org>\_teams\<id>`). Write the project's `AGENTS.md` there: every agent under the project gets it at session start.

Everything else uses the usual tools with the project's name: [orgtree-tool-move](../tool-move/SKILL.md) agents into it, [orgtree-tool-rename](../tool-rename/SKILL.md), [orgtree-tool-reorder](../tool-reorder/SKILL.md), [orgtree-tool-retire](../tool-retire/SKILL.md) (its agents retire with it) and [orgtree-tool-rehire](../tool-rehire/SKILL.md) (restores the project, free). Model, account, scope, credit and compaction tools refuse a project (`… is a project, not an agent`).

**Concurrency slots.** A collaboration semaphore, not a limit: holding one throttles or permits nothing by itself, it only counts agents who agreed to claim before some shared work (see [orgtree-projects](../projects/SKILL.md#concurrency-slots)). A project with a slot count (Project settings, 0 by default) gives out that many concurrency slots, first come first served; claim one with an [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md) of kind `slot`. Two actions go with them:

- `action=slots` with `name`: the project's slot count, its holders (agent, lease, since, reminders; no slot number), the line in order (place, agent, since) and its last 20 holds with how each ended. Agents above or below the project may look.
- `action=release_slot` with `lease` (and an optional `note`, e.g. `build ok 265s`): releases the concurrency slot you hold; the next in line is granted it at once. The holder releases its own lease; any project ancestor may use force=true; another member or unrelated agent is refused (`lease … is …'s; only its holder releases it`). A released or reclaimed lease is refused (`lease … has already ended (…)`).

```json
{"action":"release_slot","lease":"s3f1c2a9b0d4e","note":"build ok"}
```

**Dead letters.** An ack-queue job handed out the project's **max attempts** times without an ack (the 20-minute checkup took it back from a listener that never acked, or from one that was halted, retired or stopped listening) stops going to listeners and becomes a **dead letter**: the project keeps the original mail, its sender, an attempt history (who held it, when, and how each hand-out ended: acked, released or timed_out, with the reason) and the final reason. Agents above or below the project, and the user, work with them: `action=dead_letters name=P` lists the open ones (id, sender, preview, attempts, last holder, reason; `include_dropped=true` adds dropped ones, `limit`/`offset` page); with `id=<mail id>` it reads one in full (whole mail, attachments, attempt history, retries). `action=retry_dead_letter name=P id=...` puts the job back in the queue with its attempts reset (the history stays, the retry is recorded) and hands it out as soon as a listener can take it. `action=drop_dead_letter name=P id=... reason=...` closes it: it leaves the list and the count but stays readable (`include_dropped`). An agent outside the project's reach is refused. These three actions need either team or watchdogs, as the slot actions do. The project desk shows a **dead letters** tab, with the count, while it holds open dead letters (details, retry, drop with a reason). To be alerted, attach an event watchdog: `orgtree_watchdog action=create kind=event target=project.dead_letter` (optionally `pattern=<project name>`); it fires only for agents above or below the project, with the project, mail id, sender, attempts, last holder and reason. The project's superior (the user for a top-level project) is also mailed when a job dies.

## Concurrency analogies in Project settings

- Round-robin works like a load balancer: each job goes to the least recently woken listener.
- ACK works like a FIFO work queue: jobs in order, one per listener until it acks, with retries and dead letters.
- One slot works like a shared lock (mutex); several slots work like a counting semaphore. 0 = no concurrency slots.

These describe cooperative patterns: slot holders agree to claim and release permits; the engine does not enforce a limit on the work itself. FIFO describes job handout order, not completion order across listeners. Retry/dead-letter behavior follows the acknowledgement settings below.

## Settings and desktop parity

`action=settings name=P` reads all Project settings. `action=configure name=P settings={...}` changes only the supplied fields, atomically, with the same project reach, value validation and post-commit queue/slot notifications as the desktop. Omitted fields stay unchanged; explicit false, zero and an empty Summary are retained. Unknown fields, nulls and invalid types/ranges are refused before any write. Rename is applied last; the result uses the new name. Agents above or below the project may configure it.

| Field in settings | Type/default |
| --- | --- |
| name | Valid project name; rename keeps the project identity |
| description | Project Summary; string, empty clears it |
| peer_mail | Boolean, true |
| mail_queue | round_robin (default) or ack |
| exclude_sender | Boolean, false |
| ack_timeout | Boolean, true; effective timeout needs Runtime working checkups |
| max_attempts | Integer 1–100, default 3 |
| ack_reminders | Integer 1–10, default 3; reminders before reclaiming held un-acked mail or an idle concurrency slot |
| turn_end_reminder | Boolean, true; ack mode: a listener that ends its turn still holding an un-acked job gets ONE reminder turn right away (not sent if it is blocked with a reason, halted, frozen or out of usage); the 20-minute ack timeout applies afterwards |
| slots | Integer 0–64, default 0 (no concurrency slots) |

Example: `{"action":"configure","name":"build-slot","settings":{"slots":1,"ack_timeout":true}}`. Existing create and describe calls remain valid.

For example, `settings={"ack_reminders":5}` allows five 20-minute checkup reminders before reclaim at the next checkup, for both held mail and idle concurrency slots. Ack timeout and Runtime working checkups must be on. The desktop groups Ack timeout, Max attempts and Ack reminders in **Acknowledgement** at the bottom of Project settings, visible only in ack mode or with at least one concurrency slot. Hidden controls retain their saved values; tools can read/configure them regardless of whether the section is shown.

More actions:

- `release_slot lease=L force=true`: **any ancestor agent** of the project may release another holder's concurrency slot; a holder releases its own without force. Members/peers cannot force another holder.
- `unqueue_slot name=P agent=A`: any project ancestor (or the user) removes A's waiting claim. It does not release a held lease.
- `purge_waiting name=P`: retract only mail nobody has claimed; delivered/acked/dead-letter records stay. Normal project-control reach applies.
- `broadcast name=P body=...`, optional attachments (up to 10), notice, urgent/urgent_reason and reply_to/replies (mail IDs): sends to every live agent under the project, nested projects included. It also requires the messaging tool group. Each recipient goes through ordinary mail reach, peer-mail, attachment, DND and reply checks. Urgent requires a reason and a recipient currently in DND; the result can mix sends and refusals. Reply IDs must be mail you sent or received, `reply_to` must match the first of `replies` when both are supplied, and each recipient gets only its own authorized conversation context. The result reports sent/refused/failed outcomes per recipient; no peer-mail bypass and no inherited authority to act for the user.
- `presentations name=P`, optional team (false), limit (1–100, default 50), offset (0): list project gallery metadata; team includes descendants.
- `read_presentation name=P document=ID`, optional team: read a card in that gallery. Body is read in Unicode-aligned windows of at most 16,384 characters (64 KiB UTF-8). Start at `chunk_index=0` (default), then repeat the same name/document/team with `documents[].next_chunk_index` and the returned `body_revision` until the next index is null. Concatenate each body in index order; `chunk_total`, `complete` and `truncated` describe the bounded window. Invalid indices refuse. A changed/replaced body or missing revision on continuation refuses: restart at index0 rather than mixing edits. Reading does not mark the user’s document viewed or dismissed. Both gallery actions require project reach, not a user audience.

Rename/move/reorder/retire/dissolve/restore remain on their existing tree tools. Permanent deletion remains user-only. Acquire/drop project audiences uses orgtree_audience. Fair-queue watch and slot claim/pause/resume/remove use orgtree_watchdog; ack is a reply to the project. Project-folder inspection accepts project reach via orgtree_read_scratch. Desktop navigation (focus, pin/popout, viewport) is not a state tool.

## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents. It does not let B's agents write back. A reverse grant enables that reverse direction; with both grants, the two projects' direct agents may all correspond with one another. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agents below it, including nested agents, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

## Running clients with stale tools

A CLI keeps the tool definitions it loaded at startup. New orgtree_project actions or watchdog kinds do not appear in an already-running CLI after an app update. If a tool/action/kind is missing, start a fresh CLI. Before claiming a concurrency slot, verify you have BOTH orgtree_watchdog kind=slot AND orgtree_project release_slot; otherwise you cannot release it. A project ancestor may force-release a lease already stranded this way. Follow the coordinator's fallback machine-lock protocol when directed; do not invent a live-API workaround.

## See also

- [orgtree-projects](../projects/SKILL.md)
- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)

## Atomic create above

`action=create name=P above=A` inserts P at A’s existing position and moves A under P in one canonical operation. Index is unnecessary with above; parent/index cannot override the anchor placement. The same insertion authority, retained subtree, credits and top-level restrictions as the UI apply. Ordinary create without above still requires index and defaults parent to the caller. This adds no authority to create unrelated or ordinary root projects.
