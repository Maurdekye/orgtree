---
name: orgtree-tool-project
description: Create a project node (a free, turn-less node with its own folder, mailbox and presentations), edit its Summary, or see and release its concurrency slots.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_project

For worked coordination calls and their limits, open `orgtree-concurrency-primitives` (orgtree-workflows > collaboration-patterns). This tool page owns authority, fields and refusals.

## Call contract

`action=create` accepts optional `settings` for initial policy in the same transaction as creation: `peer_mail`, `mail_queue`, `exclude_sender`, `ack_timeout`, `max_attempts`, `ack_reminders`, `turn_end_reminder`, `slots` and `event_listeners`, with the same types and bounds as configure. Omitted fields keep the ordinary new-project defaults; explicit false and zero are retained. An empty settings object also keeps defaults. Put creation `name` and `description` at the top level; those identity fields inside creation settings are refused. Invalid policy refuses without creating the project. This mirrors the canvas draft's gear and grants no ongoing policy authority over a project created above the caller.

Nested projects do not impose a fixed depth cutoff on broadcasts or queue
listener eligibility. This tool pages broadcast recipients and applies ordinary
mail authority to each one; queue ownership, ACK limits and above/below reach
rules still apply.

Create/control projects above or below you: no turns/credits. create requires name/index; parent defaults you. above wraps a node atomically in its existing position instead of index/parent. settings reads all values; configure (name, settings) patches settings atomically. purge_waiting retracts unclaimed mail; broadcast uses normal per-recipient mail/attachment/DND/reply authority and reports each outcome. presentations lists project/team cards; read_presentation reads a bounded body chunk with next_chunk_index continuation. Concurrency slots: claim with a slot watchdog; slots (name) lists holders and line; release_slot (lease) releases yours. Any ancestor may force release or unqueue_slot (name, agent). Dead letters: dead_letters (name; id reads one); retry_dead_letter, drop_dead_letter (name, id[, reason]); event project.dead_letter alerts. Event listeners: fire_event (name, optional body) fires the project's event to its armed `project_listener` watchdogs at once; listeners (name) lists them and their `listener_watch` watches.

`orgtree_project` slot release and status need **either team or watchdogs**. With watchdogs on and team off, its card exposes only `action=release_slot` (your own lease, optional note), the dead-letter actions below, `action=slots` (all holders with reasons and ages, the full ordered line and recent holds; other agents' lease IDs are hidden), and the event actions `action=fire_event` / `action=listeners` below. Project reach and lease ownership still apply. All other project actions and force release require team. Full slot coordination status is available without team, subject to project reach. With both groups off, the project tool is absent and calls are refused. Missing switches still default on; inherited denials still apply.

## Read the Summary without changing it

Use `action=settings` with no `settings` argument to read a project. The Summary is returned as `settings.description`:

```json
{"action":"settings","name":"build-slot"}
```

**4.4.0-alpha.12 and earlier: `action=describe` with no `description` CLEARS the Summary.** It is a write, never a read. Always supply the intended `description` when deliberately replacing a Summary; an explicit empty string clears it. Use the settings read above on all versions.

## Create or edit a project

Project administration requires `team`. `action=describe` with `name` alone reads its Summary for agents above or below the project. Only the user or an agent strictly above the project may replace it with an explicit `description` string; an explicit empty string clears it. Its agents carry changed text from their next start. `action=settings` reads all values without changing them. `action=create` makes a **project node** (what one is and who reaches it: [orgtree-projects](../projects/SKILL.md)).

- `name` (required): a new name in the organization, 1–64 letters, digits, `-`, `_` or `.`, unique among agents and projects.
- `index` (required unless `above` is supplied): the zero-based final position among the live siblings under the parent, as for [orgtree-tool-hire](../tool-hire/SKILL.md).
- `above` (optional): wrap this node atomically at its current position; see Atomic create above below.
- `parent` (optional): yourself by default; one of your descendant nodes; or a project you are inside (a nested project). Only the user creates a project at the top level.
- `description` (optional): the project’s **Summary**, shown on the **summary** tab of its desk and used as the standing charter of every agent under the project. The wire field keeps its `description` name for compatibility.

A project costs nothing: it has no seat and never holds credits of its own. The agents you later hire under it are paid by the nearest agent above it, so hire under a project with [orgtree-tool-hire](../tool-hire/SKILL.md) `parent=<project>` from an agent above it; an agent below a project is refused (`hiring under project … is paid by the agent above it`).

```json
{"action":"create","name":"website","index":0,"description":"The company website."}
```

The result names the project, its parent, its final `index`, `live_sibling_count` and its `folder` (`<data>\scratch\<org>\_teams\<id>`). Write the project's `AGENTS.md` there: every agent under the project gets it at session start.

Everything else uses the usual tools with the project's name: [orgtree-tool-move](../tool-move/SKILL.md) agents into it, [orgtree-tool-rename](../tool-rename/SKILL.md), [orgtree-tool-reorder](../tool-reorder/SKILL.md), [orgtree-tool-retire](../tool-retire/SKILL.md) (its agents retire with it) and [orgtree-tool-rehire](../tool-rehire/SKILL.md) (restores the project, free). Model, account, scope, credit and compaction tools refuse a project (`… is a project, not an agent`).

**Concurrency slots.** A collaboration semaphore, not a limit: holding one throttles or permits nothing by itself, it only counts agents who agreed to claim before some shared work (see [orgtree-projects](../projects/SKILL.md#concurrency-slots)). A project with a slot count (Project settings, 0 by default) gives out that many concurrency slots, first come first served; claim one with an [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md) of kind `slot`. Two actions go with them:

- `action=slots` with `name`: the project's slot count, its holders (agent, lease, since, reminders; no slot number), the line in order (place, agent, since) and its newest **30** ended holds with how each ended. Agents above or below the project may look. This is a fixed status-history page: `limit`/`offset` do not shrink or page it. A returned `history_next` belongs to the separate history-read path used by the desktop; this agent action exposes no older-history cursor input. Limit/offset on other actions apply only where documented below.
- `action=release_slot` with `lease` (and an optional `note`, e.g. `build ok 265s`): releases the concurrency slot you hold; the next in line is granted it at once. The holder releases its own lease; any project ancestor may use force=true; another member or unrelated agent is refused (`lease … is …'s; only its holder releases it`). A released or reclaimed lease is refused (`lease … has already ended (…)`).

Retiring an agent releases all its leases across every project and removes its
waiting claims from the active line. Dissolve and delete also clean up each
affected descendant. Whole multi-slot leases end together; after commit the
existing strict FIFO line is checked immediately for complete grants. Recent
holds preserve each lease and quantity with `retired` as the end reason.
User-owned holds are unaffected. Automatic bookkeeping release does not itself
stop protected work or grant permission to overlap an old process.

```json
{"action":"release_slot","lease":"s3f1c2a9b0d4e","note":"build ok"}
```

**Event listeners (the project's sync/monitor).** A project carries a manual event. An agent above or below it arms an [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md) of kind `project_listener` (one per agent per project) and receives every fired event as watchdog mail; `once=true` is the usual sync shape. `action=fire_event name=P` (optional `body`, the message the listeners receive, up to 8000 characters) fires it: every armed listener that still reaches the project gets the event through durable, paged delivery, one-shots are spent, and the result names who received it (`delivered`, `delivered_to`). Firing with nobody listening succeeds and reports 0 while the project's event listeners are on; while they are off it is refused. The project's **Project events** setting (`event_listeners`, off by default) governs the whole feature: arming a `project_listener` or `listener_watch` on the project (create or resume) switches it on and says so; only the user or an agent above the project switches it off (`configure settings={"event_listeners":false}`), which disables every listener and watch on the project with the reason and tells their owners; switching it on again re-arms those dogs. `action=listeners name=P` lists the project's listeners and watches (agent, dog, state, once, fire-action tools; watches with their `count`) and the armed count. To wait until a group is ready, arm a `listener_watch` (kind `listener_watch`, `count=N`) instead of polling: it fires when N listeners are armed — and with a `fire_actions` entry calling `orgtree_project action=fire_event`, the waiting superior queues a release event when the watch fires; deliveries are paged and agents start work independently. The desktop draws cyan lines from listeners and watches to their project, cyan header cards with the count (`x/y` per armed watch), a magenta mail-queue card (waiting mail, plus ack-mode in-flight), and an **events** desk tab with the same fire control. Event watchdogs can also observe `project.event`.

```json
{"action":"fire_event","name":"sync","body":"go: start the build"}
```

**Dead letters.** An ACK job becomes a dead letter when an outstanding
attempt is reclaimed after reaching `max_attempts` (1–100, default 3), with
Runtime working checkups on. This includes halt/retire/stop-listening releases
and manual take-back; project Ack timeout only gates idle-timeout reclaim.
Reaching the limit on hand-out alone does not dead-letter a job. The original
mail, sender, final reason and attempt history remain.

User and agents above/below the project may resolve them; agents need team
**or** watchdogs enabled. Reading does not claim or acknowledge a job; retry
may trigger another assignment after commit:

- `action=dead_letters name=P` lists open letters newest first, default 50,
  `limit=1..100`, `offset=0`; `include_dropped=true` adds dropped letters.
- Add `id=<project-mail-id>` to read a letter, including a dropped one, with
  body, attachments, attempt history and retry records.
- `action=retry_dead_letter name=P id=...` resets attempts, retains history
  and records the retry; dispatch runs after commit when a listener can take it.
- `action=drop_dead_letter name=P id=... reason=...` closes an open letter,
  removes its open count and keeps it readable. A dropped letter cannot be
  retried directly. Neither resolution undoes earlier work.

The desk's **Dead letters** tab appears only while the open count is positive;
after resolving the last open letter, use the tool for dropped history.
`orgtree_inbox project=P folder=inbox status=dead-letter` is a separate,
side-effect-free history filter that also includes dropped dead letters.

Automatic system mail goes up through parent projects to the first real-agent
ancestor if live, else the user. Members and original senders are not all
notified automatically. Independently, an armed event watchdog
`orgtree_watchdog action=create kind=event target=project.dead_letter`
(optionally a regex `pattern` for the project) receives permitted events with
project, mail ID, sender, attempts, last holder and reason. A matching prefix
such as `project.*` works too. Reach, not general org visibility, controls
access. This is different from a `project_listener` hearing a manual project
event, and from `fair_queue` receiving a job.

**Dead Letter Line** in Mail → listeners lists at most 200 matching armed or
paused event watchdogs, not dead-letter jobs. Paused rows receive nothing.
Its regex preview uses a synthetic event line with project name and empty job
details; payload-specific filters can be absent from this preview. The
automatic superior notice is separate from that subscriber list.

## Concurrency analogies in Project settings

- Round-robin works like a load balancer: each job goes to the least recently woken listener.
- ACK works like a FIFO work queue: jobs in order, up to each listener's batch size unacked (default 1), with retries and dead letters.
- One slot works like a shared lock (mutex); several slots work like a counting semaphore. 0 = no concurrency slots.

These describe cooperative patterns: slot holders agree to claim and release permits; the engine does not enforce a limit on the work itself. FIFO describes job handout order, not completion order across listeners. Retry/dead-letter behavior follows the acknowledgement settings below.

## Settings and desktop parity

`action=settings name=P` reads all Project settings. `action=configure name=P settings={...}` changes only the supplied fields, atomically, with the same authority, value validation and post-commit queue/slot/listener notifications as the desktop. Omitted fields stay unchanged; explicit false, zero and an empty Summary are retained. Unknown fields, nulls and invalid types/ranges are refused before any write. Rename is applied last; the result uses the new name. Only the user or an agent above the project may configure it; agents below it (members) may read its settings.

| Field in settings | Type/default |
| --- | --- |
| name | Valid project name; rename keeps the project identity |
| description | Project Summary; string, empty clears it |
| peer_mail | Boolean, true |
| mail_queue | round_robin (default) or ack |
| exclude_sender | Boolean, false |
| ack_timeout | Boolean, true; effective timeout needs Runtime working checkups |
| max_attempts | Integer 1–100, default 3; terminal reclaim requires Runtime working checkups, including non-timeout release/take-back |
| ack_reminders | Integer 1–10, default 3; reminders before reclaiming held un-acked mail or an idle concurrency slot |
| turn_end_reminder | Boolean, true; ACK mode: queue one immediate nudge per consumed outstanding assignment after a successful ordinary turn; a fresh nonempty blocked status suppresses it. Independent of the timeout switches and checkup budget; full gates below. |
| slots | Integer 0–9,999,999, default 0 (no concurrency slots). Claims cannot exceed capacity minus that holder's held/pending units. |
| event_listeners | Boolean, false; the **Project events** setting controls the project's event listeners and its desk's **events** tab. An agent's first armed listener or watch switches it on; false disables every listener and watch on the project, true re-arms them |

Example: `{"action":"configure","name":"build-slot","settings":{"slots":1,"ack_timeout":true}}`. Existing create and describe calls remain valid.

For example, `settings={"ack_reminders":5}` allows five 20-minute checkup reminders before reclaim at the next checkup, for both held mail and idle concurrency slots. Ack timeout and Runtime working checkups must be on. The immediate turn-end nudge is independent of these timeout switches and does not consume the reminder budget. It requires a consumed copy and a successful ordinary turn; failed, interrupted, compacting or session-ended turns do not trigger it. The desktop groups Ack timeout, Max attempts and Ack reminders in **Acknowledgement** at the bottom of Project settings, visible only in ack mode or with at least one concurrency slot. Hidden controls retain their saved values; tools can read/configure them regardless of whether the section is shown.

More actions:

- `release_slot lease=L force=true`: **any ancestor agent** of the project may release another holder's concurrency slot; a holder releases its own without force. Members/peers cannot force another holder.
- `unqueue_slot name=P agent=A`: any project ancestor (or the user) removes A's waiting claim. It does not release a held lease.
- `purge_waiting name=P`: retract currently pending/unassigned mail, including returned jobs with earlier attempts; delivered/acked/dead-letter records stay. Normal project-control reach applies.
- `broadcast name=P body=...`, optional attachments (up to 10), notice, urgent/urgent_reason and reply_to/replies: sends to each live agent child reached through live sub-projects, stopping at every agent recipient. It also requires the messaging tool group. Each recipient goes through ordinary mail reach, peer-mail, attachment, DND and reply checks. Urgent requires a reason and a recipient currently in DND; the result can mix sends and refusals. Reply references accept legacy message IDs or identity-only document/presentation, docket-item and transcript-event targets. String IDs must be mail you sent or received; typed references carry identities only, quote text is resolved from the authorized source, and each recipient receives only references from its own conversation. When both are supplied, `reply_to` must match the first `replies` target. The result reports sent/refused/failed outcomes per recipient; no peer-mail bypass and no inherited authority to act for the user.
  Broadcast reads recipients in 100-row ID pages through the initial maximum agent ID. Unlike the desktop's 1,000-recipient send cap, 100 is a page size, not a total recipient limit.
- `presentations name=P`, optional team (false), limit (1–100, default 50), offset (0): list project gallery metadata; team includes descendants.
- `read_presentation name=P document=ID`, optional team: read a card in that gallery. Body is read in Unicode-aligned windows of at most 16,384 characters (64 KiB UTF-8). Start at `chunk_index=0` (default), then repeat the same name/document/team with `documents[].next_chunk_index` and the returned `body_revision` until the next index is null. Concatenate each body in index order; `chunk_total`, `complete` and `truncated` describe the bounded window. Invalid indices refuse. A changed/replaced body or missing revision on continuation refuses: restart at index0 rather than mixing edits. Reading does not mark the user’s document viewed or dismissed. Both gallery actions require project reach, not a user audience.

Rename/move/reorder/retire/dissolve/restore remain on their existing tree tools. Permanent deletion remains user-only. Acquire/drop project audiences uses orgtree_audience. Fair-queue watch and slot claim/pause/resume/remove use orgtree_watchdog; ack is a reply to the project. Project-folder inspection accepts project reach via orgtree_read_scratch. Desktop navigation (focus, pin/popout, viewport) is not a state tool.

## Entries the user made themselves

`action=slots` and `action=listeners` also list the user's own entries (their slot holds, event listener and listener watch), named `user` (no agent can have that name); the mail queue hands the user jobs like any listener. They are made and ended only by the user from the project desk. `release_slot` of the user's lease, `unqueue_slot` with `agent=user` and a take back of the user's job are refused to every agent, `force=true` and project ancestors included. They count toward capacity, the FIFO line, `listener_watch` counts and queue round-robin like yours. See `orgtree-projects` for what that means when you wait behind one.

## Project audiences

A live project may hold an audience with the user, another agent or another project. Every live agent directly under it can use that audience exactly as if it held the grant itself: user mail, questions, presentations, file delivery and agent mail all accept effective inherited access. Tool groups and other independent permissions still apply. Only direct members inherit; a nested project never relays its parent's inherited grants to deeper agents. Moving out, retiring, pausing or revoking the source grant removes that inherited route. An agent's independent explicit grants remain.

An audience is directional: a grant to project A from project B lets A's direct agents write to B and B's direct agents while **both projects' peer-mail switches are ON**. It does not let B's agents write back. A reverse grant enables that reverse direction, subject to the same switches. Turning either switch OFF suspends that project-to-project route; explicit agent-to-agent, agent-to-project and project-to-agent grants keep their ordinary override. Members of nested projects, unrelated organizations and retired members are excluded. No personal audience rows are copied to members.

When the user sends to a project's mailbox or uses its megaphone broadcast, only the project receives an explicit user audience after successful delivery. The broadcast reaches live agent children through live sub-projects, stopping at each agent, but creates no personal user grants on any recipient. Fair-queue copies and system nudges likewise create no personal user grants. A post-delivery project grant failure is reported as delivered but audience grant failed.

Direct user mail or commands create an agent's own user grant only when it has no effective user audience already. While it inherits user access from a project, user mail of any kind does not give it an independent grant. To give it one, the user can choose Acquire audience in that agent's context menu, even while it inherits access; alternatively, remove the project's user audience and then mail the agent directly. Once an inherited-only agent leaves the project, its inherited access ends; direct user contact can then grant it access normally. Existing explicit grants are not removed automatically.

A project's nearest real-agent superior manages its audience requests and decisions; the user does so if there is no such superior. Members cannot manage the project's grants. Use orgtree_audience action=request from=project-name target=agent-or-project for a managed project; its context menu also offers Acquire/Drop audience. Chart and state inspection identify inherited source projects. Drop audience acts on explicit grants, not inherited-only routes; change the source project's grant to remove an inherited route. The org-inbox/outside-mail audience remains agent-only. The separate permission to present within one's own project includes nested members and does not imply recursive audience inheritance.

## Running clients with stale tools

A CLI keeps the tool definitions it loaded at startup. New orgtree_project actions or watchdog kinds do not appear in an already-running CLI after an app update. If a tool/action/kind is missing, start a fresh CLI. Before claiming a concurrency slot, verify you have BOTH orgtree_watchdog kind=slot AND orgtree_project release_slot; otherwise you cannot release it. A project ancestor may force-release a lease already stranded this way. The filesystem build-lock protocol is retired: follow the current build project's Summary, and do not invent a fallback or live-API workaround.

## See also

- [orgtree-projects](../projects/SKILL.md)
- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)

## Atomic create above

`action=create name=P above=A` inserts P at A’s existing position and moves A under P in one canonical operation. Index is unnecessary with above; parent/index cannot override the anchor placement. The same insertion authority, retained subtree, credits and top-level restrictions as the UI apply. Ordinary create without above still requires index and defaults parent to the caller. This adds no authority to create unrelated or ordinary root projects.
