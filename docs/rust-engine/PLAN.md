# Orgtree 4: the engine rewritten in Rust — plan

This ships as **Orgtree 4** (4.0.0): the rewrite removes notable functionality (§10), so it is a
major version (user 2026-10-06). It upgrades from 3.x data (§8).

**The user's standing decisions are in [`DECISIONS.md`](DECISIONS.md) and override anything here
that disagrees with them.**

Status: **approved by the user 2026-10-06**, with the changes recorded in §10 and §11. Branch
`rust-engine`, cut from `origin/dev` at `4ddbfb1`.

The current Python engine freezes with about a dozen running agents: org-wide locks, long
transactions that do file and provider work while holding them, whole-org reads on hot paths,
polling loops, and a GIL. This plan replaces the whole engine with a new Rust program designed
from the renderer's contract, not from the Python code. The desktop UI keeps its look and
behaviour; the desktop-side change the engine needs is the launcher starting the new executable.
Loading and actions stay HTTP (keep-alive); pushed updates use the existing sockets (decided
2026-10-06, after first trying one socket per window: HTTP keeps big replies from blocking live
updates and needs no renderer rewrite).

Targets: 1,000+ live agents per machine; UI reads p95 < 100 ms; an agent's tool call never waits
on an unrelated agent; no global locks of any kind.

---

## 1. What I will build

One executable, `orgtree-engine.exe`, in a new Cargo workspace at `engine/rs/`:

| Piece | What it does |
|---|---|
| HTTP server (axum/tokio) | The renderer bundle and every `/api/*` route the UI calls (loads and actions, keep-alive connections, ETag/304 where the UI sends `If-None-Match`) |
| Push sockets | The org socket (`/api/orgs/{slug}/ws`: record feed, runtime overlay, live desk frames) and the app socket (`/api/app/ws`: registry, notices, pushed values), exactly as the renderer already uses them; nothing polls |
| Agent runtime | One lightweight task (actor) per agent that is doing something; drives the provider CLI for that agent; owns that agent's live state |
| Provider drivers | Claude Code, Codex, Antigravity, OpenRouter (through the Claude Code or Codex CLI) |
| Agent channels | The agents' `orgtree_*` tools and mid-turn mail travel over each CLI's own stdin/stdout: Claude Code's stream-json control channel (in-process MCP server + hook callbacks), Codex app-server dynamic tools and `turn/steer`. Antigravity uses the engine binary as a tiny stdio MCP bridge over a Windows named pipe. No HTTP, no tokens and no helper processes on the agent path |
| Feeds | Per-org record feed and app feed, pushed to the UI; no UI polling for tree, inbox, events, history, mailbox |
| Storage | One new PostgreSQL database `orgtree_engine` in the existing bundled cluster, new schema `ot` |
| Importer | One-time copy of the existing 3.2 per-org databases into the new schema at first start; the old databases are only read, never changed |
| Supervisor for children | Starts and stops the bundled PostgreSQL and the bundled mail hub (the existing `orgtree-mailhub` product, unchanged, still on port 7370) |

The Python engine stays in the tree untouched, so going back is "run the old build".

## 2. Architecture

### 2.1 Process and threads

- One process. Tokio multi-threaded runtime, one worker thread per core. Blocking work (file
  scans, process spawning, JSONL parsing of old transcripts) runs on the blocking pool, never on a
  worker.
- All provider CLIs, PostgreSQL and the mail hub are children inside one Windows Job object with
  kill-on-close, so the engine dying takes every child with it.
- The engine keeps no Python, no SQLite side stores, and no per-agent helper processes (today
  every agent also runs a Python MCP process and a Python hook script per tool call).
- Transport: HTTP for loads and actions, the org and app sockets for pushed updates; agents reach
  the engine over their CLI's own pipes, never over HTTP.

### 2.2 Concurrency rules (no global locks)

1. **No lock is ever shared across agents or orgs.** State is owned, not shared:
   - each running agent's live state is owned by its actor and changed only by messages on its
     channel; readers see a lock-free snapshot (`ArcSwap`) the actor publishes;
   - each org's feed is owned by one feed task per org (a queue consumer, not a lock);
   - registries (agent → actor handle, token → agent) are lock-free concurrent maps.
2. **Database transactions are short and narrow.** One transaction per action, touching only the
   rows it changes, locked by primary key (`FOR UPDATE` on those rows only). No org-wide lock row,
   no "revision row taken last", no advisory org lock. Tree-shape invariants (no cycles, credit
   balance along a chain) use `SERIALIZABLE` over the involved rows and retry on conflict.
3. **Nothing slow runs inside a transaction.** Provider calls, file IO, process control, JSON
   rendering of large payloads all happen before or after, never during.
4. **Writers never wait for readers or for the UI.** After a commit the writer drops a
   "these keys changed" note on the org feed's channel and returns. The feed task re-reads those
   rows (batched, indexed) and pushes the new bodies to subscribed windows.
5. **Bounded everything.** Every queue has a bound; every list read has a `LIMIT`; history tables
   are reached only by index ranges, so archived agents, closed tickets and read mail cost nothing
   on hot paths.
6. **The concurrent-turn limit** (App settings > Runtime, default 16) is a counting admission
   queue run by one scheduler task (FIFO within an org, round-robin across orgs), not a lock. It
   bounds how many CLIs run model turns at once; it never blocks tool calls, mail or the UI.

### 2.3 A turn, end to end

1. Mail lands for an agent (from the user, another agent, a watchdog, a docket reply): one
   `INSERT` into `ot.mail`, then a message to the recipient's actor (spawned on demand).
2. The idle actor asks the scheduler for a slot (the desk shows "waiting for a free turn" while
   queued).
3. With a slot, it claims its pending mail (`UPDATE … SET state='delivering' … RETURNING`),
   renders it into one prompt, makes sure its CLI process is running, and writes the prompt.
4. The driver turns the CLI's output stream into events: thinking/text deltas go straight to the
   org socket as live frames; complete messages, tool calls and tool results are appended to
   `ot.convo` in small batches; activity/phase changes go to the runtime overlay.
5. Mail that arrives mid-turn is handed over at the next tool boundary: for Claude Code through a
   `PostToolUse` hook callback on the CLI's control channel (no script process, no HTTP); for
   Codex through `turn/steer` on the app-server pipe; for Antigravity at the next turn boundary.
6. At the result the actor marks the claimed mail delivered, records the turn's cost, tokens and
   duration, updates context occupancy, releases the slot and, if more mail is waiting, goes again.
7. After the turn the CLI process stays alive for a keep-alive window (default 10 minutes, at
   most 64 idle processes machine-wide, least recently used closed first) so the next turn starts
   instantly; after that it exits and the next turn resumes the session with `--resume`.

### 2.4 A mutation, end to end

`POST /api/orgs/{slug}/ops {op:"hire",…}` → validate → one short transaction (insert agent row,
update parent's credits, insert event row) → commit → note `{agent:new, agent:parent, org:cost,
org:audit, events}` to the org feed → respond. The feed task re-reads those records and pushes one
`record_changes` frame to every open window of that org within ~20–50 ms.

## 3. Storage

New database `orgtree_engine` in the existing bundled cluster (`<data>\pg\cluster`), schema `ot`.
One database for all orgs (rows carry `org_id`): one connection pool, cross-org operations in one
transaction, no per-org database lifecycle. Migrations are embedded in the binary and applied at
start, one transaction per file. The engine starts PostgreSQL itself with settings sized for this
load (`max_connections` 200, `shared_buffers` 512 MB, `jit` off) and a pool of ~48 connections.

Main tables (all with partial indexes over the active subset only):

| Table | Holds |
|---|---|
| `orgs` | slug, name, uuid, state (active/trashed), org settings (jsonb), org.md text, killswitch |
| `agents` | name, parent, sibling order, title, charter, team charter, tier, model version, provider, account, state (live/archived/deleted), seat, grant, scope (jsonb: dirs, tools, visibility, permission mode, effort), session id / provider thread id, cost, context window, occupancy, last/prev status, frozen record, halt record, pending switch/account, generation, scratch dir |
| `turns` | per-agent turn ledger: start/end, cost, tokens, duration, denials, killed, error, account |
| `convo` | per-agent conversation rows, already in the shape the desk renders; `(agent_id, seq)` index; a per-agent version counter for incremental reads |
| `mail` | every message (agent↔agent, agent↔user, notices, system wakes): sender, recipient, kind, body, attachments, reply-to quote, urgent, state (pending/delivering/delivered/read/retracted), timestamps |
| `asks` | user questions and request batches (question tabs, credit tab, scope tabs), status, answer |
| `work_items` + `work_events` + `work_attachments` | the docket (simplified, see ledger) and its history |
| `documents` | presented documents (markdown/html) |
| `deliveries` | files sent to the user (`orgtree_send_file`) |
| `events` | the org event log (the Record tab and per-agent History) |
| `watchdogs` | watchdog definitions and state |
| `audiences` | audience grants and pending requests |
| `accounts`, `account_marks` | machine-wide provider accounts and their "limited until" marks |
| `app_kv` | app-wide settings (runtime settings, OpenRouter key reference and favorites, defaults) |

## 4. What the UI receives

The renderer already has a push protocol (the "record feed") that it switches to when the engine
says `capabilities.record_changes_v1: true`. The new engine speaks only that protocol for the
tree and the panels it covers, so nothing polls.

- **Org socket** `/api/orgs/{slug}/ws`: `record_changes` frames (agent records and the 12 org
  groups), `record_subscribed` answers for windows a panel opens (one agent's mailbox, one agent's
  history, retired agents under a parent, all retired agents, explicit agents), `agent_runtime`
  overlay frames (busy, responding, phase, activity, waiting-for-slot, process state, tasks…),
  `node_stream` live frames for the desk (thinking/text deltas, durable-row nudges), `node_event`
  pulses (turn done, frozen, renamed, file presented), and `mail` sparks.
- **Rooms (user 2026-10-06).** The org socket works like topic subscriptions: each window joins
  only what it shows. Every agent has a transcript room; live token deltas, thinking clocks and
  durable-row nudges for an agent go only to windows whose open desk joined that agent's room
  (the renderer joins on desk mount, leaves on unmount, and re-sends its room set on reconnect —
  a small renderer change, `streamrooms.ts`, its own commit). Panels that open a mailbox, a
  history or a retired-agent list already join their own sets through the record feed's
  subscriptions. Org-wide frames stay org-wide only where the canvas needs them for every agent:
  record changes, the runtime overlay (busy, phase, activity...), turn pulses and mail sparks. So
  1,000 busy agents cost a window only what it is looking at.
- **Org recovery requests** (HTTP): `/records` (snapshot), `/changes?after=` (catch-up from a ring
  of recent frames, or a fresh snapshot), `/records/selection` (name → id resolution, search over
  retired agents).
- **App socket** `/api/app/ws` + `GET /api/app/records`: org registry and summaries, desktop
  notices (questions, urgent mail, ticket attention), and pushed values (`providers`, `accounts`,
  `openrouter`, usage peeks, `prefer_reserve_default`).
- **Desk**: `GET …/nodes/{id}/chat?last=&before=&after=` reads `convo` by index (incremental with
  `after`), plus pending mail and the live tail the actor holds.
- **Docket, gallery, audiences, org.md, settings, providers, accounts, usage**: ordinary HTTP
  routes with ETags where the UI sends `If-None-Match`.
- Electron's main process keeps its HTTP calls (`/api/desktop/*`: identity, liveness, status for
  the tray, shutdown, maintenance) and its own app-feed socket, unchanged.
- The newer "selected tree" and "docket foreground" routes answer `409 {kind:"compatibility"}`,
  which the renderer already treats as "use the full read"; in record mode it never needs them.

Each org feed keeps its records in memory (built from the database at start, kept current by the
re-read-on-change rule above). That makes snapshots and catch-ups memory reads, and costs roughly
2–4 KB per live agent.

## 5. Providers

| Provider | How it runs | Tools | Mid-turn mail | Interrupt |
|---|---|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`, one long-lived process per active agent, `--resume <session>` across restarts | in-process MCP server on the CLI's control channel (`mcp_message`) | `PostToolUse` hook callback on the control channel returns waiting mail as additional context | control-channel `interrupt`, then kill if it does not settle |
| Codex | `codex app-server` (JSON-RPC over stdio), `CODEX_HOME` per account | dynamic tools (`item/tool/call`) | `turn/steer` | `turn/interrupt` |
| Antigravity | `agy -p --input-format stream-json --output-format stream-json`, `--conversation <id>` to resume | stdio MCP bridge (`orgtree-engine.exe mcp-bridge`) over a named pipe | next turn boundary | kill |
| OpenRouter | the Claude Code CLI (or Codex, per the existing harness setting) pointed at OpenRouter's API with the stored key | as the harness | as the harness | as the harness |

**Cache forecasting (kept, decided 2026-10-06).** The engine predicts, per agent, whether the
next turn will hit the provider's prompt cache, and publishes it as the agent's `cache_forecast`
runtime value (the card/desk badge, its expiry countdown and the send warnings render it as today):

- Every turn's prompt prefix is fingerprinted component by component: system prompt (identity,
  charter, team charter, org.md), tool list, model, effort, permission mode, folders, account. The
  fingerprint of what the last turn actually sent is kept beside the one the next turn would send;
  a difference is `prefix_changed`, naming the changed components (never their values).
- The cache receipt comes from the provider's own usage report: Claude's cache read/write token
  counts and their 5-minute or 1-hour TTL give `expires_at`; Codex's cached-token counts with a
  fixed 30-minute estimate; providers that publish no cache data show the grey "this lane publishes
  no cache data".
- Verdicts: no completed turn → nothing shown; prefix changed → red with the changed parts; no
  cache read/write in the last turn → red; entry past its TTL → red; otherwise green with the
  countdown. Mid-turn only "the prefix changed since this turn was sent" is shown (the steer-window
  warning). A timer per agent flips green to red at expiry without waiting for anything else.
- Recomputed only when something it depends on changes (turn end, scope/charter/model/effort/
  account/org.md edits), so it costs nothing while agents are idle.
- The prefix is kept stable on purpose so caches actually hit: the system prompt holds only
  slow-changing content (who the agent is, its charter, org.md, tool guidance); fast-changing org
  state (team status, mail) goes into the turn's message instead. A change to a prefix input while
  a CLI is parked closes that CLI at its next turn (the desk's "relaunch needed" mark shows why).
- Automatic cheap compaction before a turn that is known cold (org setting, off by default) is
  kept, driven by the same forecast and the compaction threshold.

Usage limits: a turn that ends on a provider usage limit freezes the agent until the stated reset
(plus a 60 s grace), marks the account limited until then, and — with the org's auto-resume on —
continues it automatically with a short "continue" prompt. Turn time limits (total ceiling and
silence limit from App settings) are enforced by the actor.

## 6. Agent tools

Served over each CLI's own pipe (§5). Same names agents already know, fewer of them, one
consistent argument style:

`orgtree_message` (absorbs `orgtree_send_notice` via `notice: true`; keeps the old name as an
alias), `orgtree_inbox`, `orgtree_ask`, `orgtree_withdraw_ask`, `orgtree_status`, `orgtree_present`,
`orgtree_send_file`, `orgtree_work`, `orgtree_hire`, `orgtree_rehire`, `orgtree_retire`,
`orgtree_dissolve`, `orgtree_retool`, `orgtree_switch_model`, `orgtree_move`, `orgtree_rename`,
`orgtree_interrupt`, `orgtree_halt`, `orgtree_unhalt`, `orgtree_reallocate`,
`orgtree_cheap_compact`, `orgtree_request_credits`, `orgtree_request_scope`, `orgtree_audience`,
`orgtree_watchdog`, `orgtree_chart`, `orgtree_list_tiers`, `orgtree_list_orgs`,
`orgtree_read_transcript`, `orgtree_read_scratch`, `orgtree_staff`, `orgtree_swap`,
`orgtree_self_subjugate`, `orgtree_unstick`, `orgtree_continue_on`, `orgtree_account_mark`,
`orgtree_state_inspect`.

Removed tools are listed in the ledger (§10, P). The managed agent instructions (the system prompt
every agent gets) are rewritten to match: shorter, and stable across turns so provider prompt
caching keeps working.

## 7. Startup, shutdown, desktop integration

- Same launch protocol the desktop already speaks: environment (`ORGTREE_DATA`,
  `ORGTREE_V2_TOKEN`, `ORGTREE_V2_UI_DIR`, `ORGTREE_V2_PARENT_PID`), stdout `startup-progress`
  lines, the `ready` line, the `refused` line when another engine owns the data folder, the data-root
  lock file, `engine-port.json` (same preferred port, so the window's saved layout survives), and
  `/api/desktop/identity|alive|status|shutdown|notifications|hub|maintenance/*`.
- Desktop changes: `apps/desktop/main/engine.ts` starts `resources/engine/orgtree-engine.exe`
  when it exists (or `ORGTREE_ENGINE_BIN` in development), otherwise the Python engine as today;
  packaging adds the binary to `resources/engine`. The renderer's data layer is unchanged.
- **Background engine (boot task), part of the MVP.** `orgtree-engine.exe host` is a small
  supervisor mode of the same binary, run by the existing "Orgtree Background Engine" scheduled
  task (S4U, least privilege, at boot) in place of `service_host.py`. It starts the engine as the
  normal user (or with its own rights when "Run Orgtree as administrator" is on in HKLM), waits for
  the `ready` line, writes `engine-attach.json` with the same owner-restricted ACL the desktop's
  trust check requires, probes liveness with the same rules the desktop uses (every 30 s; hung after
  300 s of silence and 3 failed probes; at most 3 restarts an hour, logged to
  `diagnostics\engine-liveness.jsonl`), restarts a hung or crashed engine, and removes the
  descriptor on stop. The desktop attaches as it does today. The installer's task registration
  (`tools/boot-engine-task.ps1`) points the task's action at the new binary.
- Start order: lock data root → start PostgreSQL (create the cluster on a fresh data folder) →
  migrate `orgtree_engine` → first-start import → start the mail hub → load org feeds → resume
  agents that were mid-turn → `ready`. Expected: well under 5 s on the current data.
- Shutdown: stop admitting turns, interrupt running turns (they resume on next start), close CLIs,
  stop the mail hub, stop PostgreSQL cleanly.

## 8. Importing your existing data

On first start (and only if `orgtree_engine` has not been imported yet) the engine reads the 3.2
per-org databases (`orgtree_app` registry + `orgtree_org_<n>`) **read-only** and copies:
orgs and their settings, agents (live and retired, with charters, scope, tiers, accounts, credits,
session ids, cost, status), open and recent mail, open questions and requests, the docket (items,
history, attachments), documents, watchdogs, audiences, the last 5,000 events per org, and the
account registry. Nothing in the old databases or the old files is modified or deleted.

Conversation history: the desk of an imported Claude agent shows its recent history read once from
the Claude CLI's own session transcript (`~/.claude*/projects/…/<session>.jsonl`), lazily the first
time its desk opens. Codex and Antigravity agents start with an empty desk history (their sessions
still resume, so the agents themselves remember).

## 9. How you will test it

1. I build `orgtree-engine.exe` and give you a one-line dev launch (`ORGTREE_ENGINE_BIN=… npm start`)
   against a **copy** of your data folder that I prepare (PostgreSQL cluster, scratch folders,
   profiles), so the installed app and live data stay untouched.
2. When you are satisfied, a packaged build swaps the engine; rollback is reinstalling the current
   build (the old databases were never modified).

## 10. User-facing differences — complete ledger

Everything not listed here is meant to behave as it does today. "Inert" means the setting has no
effect; per the user (2026-10-06) such controls are removed from the settings menus rather than
left in place (UI clean-up is allowed outside the canvas). "Refused" means using it shows an error
toast saying this engine does not support it.

### A. Engine, startup, data

| # | Today | After the rewrite |
|---|---|---|
| A1 | Python engine | Rust engine; same windows, same tray, same launch/attach protocol |
| A2 | Optional boot-time background engine (all-users install, scheduled task "Orgtree Background Engine") that the desktop attaches to; "Run Orgtree as administrator" | Kept, same behaviour. The task now runs `orgtree-engine.exe host` instead of the Python service host; the desktop attaches exactly as today |
| A3 | First start of 3.x converts a 2.x SQLite data folder | Not in the first builds (they import from 3.x PostgreSQL data only); a direct 2.x upgrade path is **required before 4.0.0 is published** (user 2026-10-06) |
| A4 | Per-org databases; an org can be "unavailable" with a Retry button | One database; orgs are never "unavailable"; Retry is inert |
| A5 | Trash and purge of orgs | Delete moves an org to trash (soft delete) as today; no purge |
| A6 | Engine diagnostics files (slow-requests, slow-transactions, stall stacks, liveness log) | One `diagnostics\engine.log`; slow operations are logged there |
| A7 | Developer › Engine debug view shows Python engine counters | Shows the new engine's counters (sockets, queues, memory); some old fields absent |
| A8 | Windows load over HTTP and receive pushed updates over the org and app sockets | Unchanged |

### B. Organizations and canvas

| # | Today | After the rewrite |
|---|---|---|
| B1 | Lineage stack: knowledge bearers (`agent@3`) as separate archived nodes after cheap compact or a cross-provider switch; "Show lineage"; rehire or consult an old generation | Removed. Cheap compact and cross-provider switches continue on the **same** agent on a fresh session that starts with a handoff note (last status, recent conversation); the whole desk history is saved as a file in the agent's folder (decision 43). No "gen N" button, lineage panel or "Show lineage" |
| B2 | Prompt-cache forecast badge on cards and desk (ready / not ready / unknown, expiry countdown, changed parts, send warnings) | Kept (§5), also on idle agents and across engine restarts (the last receipt and prompt fingerprint are stored). Cache keep-alive pings that kept an idle agent's cache warm are not kept |
| B3 | MCP tool-count badge and "waiting for MCP tools" state | Kept. Orgtree's own tools are always ready (served by the engine); external MCP servers granted to an agent (from your `~/.claude.json` registry) are tracked per process: the engine reads each server's connection state from the CLI (init report and `mcp_status` queries), shows the waiting state while any is still connecting, and, with "wait for MCP tools" on, holds a fresh process's first prompt until they connect or fail (bounded wait) |
| B4 | Warm-process indicators; every live agent keeps a parked CLI from boot | As in 3.x (decision 42): every live agent's CLI starts at engine start and on hire and stays parked between turns; at most 64 idle CLIs (longest idle closed first); warming pauses below 6 GB of free commit memory. Desk start/stop control kept |
| B5 | Codex "luna" reserve-pool routing (prefer reserve first, reserve card, `gpt-reserve`) | Removed; luna runs on its model directly. The "prefer reserve" switch is not shown (decision 31) |
| B6 | Remote control (hand a session to claude.ai / mobile) | Removed; the control is refused |
| B7 | Org inbox card and network hub chips on the canvas | Kept (see D2) |
| B8 | "Primed restart" header chip | Removed (never shown) |
| B9 | Fable lock and Fable limit/filter policies | Removed; their settings and the lock are not shown (decision 31) |
| B10 | Hire with automatic credit cascade (cascade hire / cascade allocate settings) | Kept: a hire, allocation or model upgrade that needs more than the superior holds raises each ancestor's grant just enough (whole credits) up the chain to you, within the top-level grant cap; off = refused. The chain's rows are locked top-down in one short transaction, so cascades in different subtrees never wait on each other |
| B11 | Account fallback (opt-in per org with per-agent override: a usage-limited agent switches to another signed-in account of the same provider with capacity, and keeps it) | Kept, same rules; "continue on another account" stays as the manual action |
| B12 | Everything else on cards: tiers, credits, occupancy, cost, status, frozen countdown and resume, halt, killswitch, waiting-for-slot banner, watchdog satellites, ask cards, documents, mail sparks, serving account | Kept |
| B13 | Tree actions: hire, insert superior, rehire, retire, rescind, dissolve, delete, move/promote/demote, reorder, rename, switch model, change account, edit scope, reallocate credits, cheap compact, quick staff | Kept |

### C. Agent desk

| # | Today | After the rewrite |
|---|---|---|
| C1 | Effort change reaches a running Claude turn mid-flight (the call in flight finishes at the old level, the next model call uses the new one); the change reports `effort_delivery` sent / unchanged / next_turn | Kept, same behaviour: sent as `apply_flag_settings {effortLevel}` on the CLI's control channel; Codex and others apply it from the next turn, as today |
| C2 | Mid-turn mail delivery for Codex and Antigravity (steer pump) | Claude: next tool boundary (as today); Codex: `turn/steer` (as today, without the polling pump); Antigravity: next turn boundary |
| C3 | Delivery evidence levels on steered rows (recorded / accepted / handoff) | One state: delivered |
| C4 | Slash commands: several are answered locally (`/compact`, `/context`, `/cost`, …) | `/compact` kept; other slash commands are sent to the CLI as typed and may do nothing in headless mode |
| C5 | Old conversation history comes from the 14 GB transcript store | Claude agents: recent history read from the CLI's own transcript on first open; Codex/Antigravity agents: history starts at the switch. New turns are complete for everyone |
| C6 | Cost diagnostics (unknown cost fields, OpenRouter "reported model" disclosure, cache-break diagnoser) | Removed; cost and tokens per turn kept |
| C7 | Turn stats, denials list, context occupancy, thinking, tool chips with diffs, images, progress checklist (TodoWrite / Codex plan), subagent counts, pending mail bubbles, attachments, reply quotes, notice toggle, interrupt, halt, compact, cheap compact, scratch browser, file links, upload, history and mailbox tabs | Kept |
| C8 | After an engine crash, interrupted turns resume with reconciled tool results | Interrupted turns resume with a "the engine restarted during your turn; continue" message; tool calls that were in flight are not reconciled |

### D. Mail and inbox

| # | Today | After the rewrite |
|---|---|---|
| D1 | System messages arrive as typed cards (docket assigned, review requested, decisions, lifecycle notices) | Kept: the engine emits the same typed event envelopes (`ev`, schema in `renderer/src/generated/events.schema.json`) |
| D2 | Mail between orgs (`@org:`), over the mail hub (`@net:`), the org inbox panel (read, send, attachments), extern-mail holders and the multi-holder setting, hub settings and connection status, peer roster, network identity reveal, hub probe | Kept. Local `@org:` mail is a single database transaction; `@net:` mail goes through a native client for the bundled mail hub (same hub protocol as today, so Claude Code sessions and other hosts keep working) |
| D3 | User inbox (pending / read / sent), mark read, clear, urgent tag, retract unsent mail, notices, reply quoting | Kept |

### E. Questions and requests

| # | Today | After the rewrite |
|---|---|---|
| E1 | Question cards (1–4 tabs, options, multi-select, free text, dismiss), batch cards with credit and scope tabs, credit counter-offers | Kept |
| E2 | Audience requests that climb the chain one refusable hop at a time (forward/deny by intermediate agents) | Simplified: an audience request goes to the agent it names (or the user) for a yes/no; grants and revokes kept |

### F. Docket

| # | Today | After the rewrite |
|---|---|---|
| F1 | Items with slug, title, kind, description, status, blocked/dropped reasons, owner, reviewer, participants, parent/sub-items, dependencies, superseded-by, done-so-far / next lists, attention flag + dismiss, linked questions, attachments, history, reply to ticket, archive rules (dropped at once, done after an hour, attention keeps it active), counts and badge | Kept |
| F2 | Acceptance criteria and check history (W09/W10) | Removed |
| F3 | W08 evidence: receipts with captured git tree state, artifacts with named grants, findings with dispositions | Removed; evidence is simple notes (kind, reference, note) |
| F4 | Review machinery: review seats and seat requests, candidate verdicts, `approve_stage`, review packets, `approved` reachable only through a verdict | Removed: `review` and `approved` are ordinary statuses an owner or reviewer sets |
| F5 | Post-completion addenda, objective notices / scope archive, earlier-holder read rights | Removed |
| F6 | Resource reservations and landing slots (`orgtree_reservation`) | Removed |
| F7 | Quick staff from a ticket (request / under assignee / top level) | Kept |

### G. Presentations, files, watchdogs

| # | Today | After the rewrite |
|---|---|---|
| G1 | Document gallery, reader (markdown/html), isolated HTML preview, download, dismiss; file delivery cards; images inline | Kept |
| G2 | Watchdogs (file, command, process, stream, activity; event/silence; one-shot; pause/resume/remove) | Kept; "supersede" action removed |

### H. Providers, accounts, usage

| # | Today | After the rewrite |
|---|---|---|
| H1 | Providers page, enable/disable, install/sign-in detection, model tiers and versions, legacy models toggle, conditional Gemini tiers | Kept |
| H2 | Codex CLI version-drift report | Removed |
| H3 | API-key accounts (add with a key, metered spend shown in Usage), per-provider "use API-key accounts as fallback" and "use subscriptions for inference" switches | Kept. The API-key fallback switch stays; the per-provider "use subscriptions" switch became an active checkbox on every account, the native sign-in included (decision 41). Only the legacy `claude setup-token` key rows (`/api/accounts/readout`, no longer reachable from the UI) are not carried over |
| H4 | Account registry (add managed profile, import, remove, sign in, identity check, tint), limit marks list and clear | Kept |
| H5 | Usage window: Claude bars per account, Codex rate limits, Antigravity usage, OpenRouter credits, usage glow | Kept |
| H6 | OpenRouter key, catalog search, favorites as tiers, harness choice | Kept |

### I. Settings

| # | Today | After the rewrite |
|---|---|---|
| I1 | Org settings: folders, grants, compact threshold, default tools/visibility/account/permission mode/effort, auto-resume | Kept. The compact threshold is handed to the CLI: Claude Code compacts at it (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) and Codex at that share of its context window (`model_auto_compact_token_limit`); a running CLI keeps the value it started with. Antigravity has no such setting |
| I2 | Org settings: auto cheap compact (before a known-cold turn) | Kept: before a turn whose prompt cache is known to be cold (expired, or the prompt prefix changed) and whose context is above the setting's occupancy, the agent continues on a fresh session seeded with a summary of the old one. An unknown forecast never resets |
| I2b | Org settings: account fallback default, org-inbox multi-holder, network hubs and autoconnect | Kept |
| I2c | Org settings: cheap-compact before auto-resume, headless | Inert |
| I3 | Runtime: max concurrent turns, turn time limits | Kept |
| I4 | Runtime: "keep agents warm" | "keep agent processes warm" works as in 3.x (B4, decision 42); off = close each CLI after its turn |
| I5 | Runtime: wait for MCP tools | Kept (see B3) |
| I5b | Runtime: git periodic fetch, working checkups, idle docket reminders, blocked docket reminders, include account selection when requesting staffing | Inert |
| I6 | Charters (presets, user folder, external template folders), org.md, hire defaults, app defaults | Kept |
| I7 | Enter sends in message composers | App settings › Display › Typing › Enter key: Send message (default; Shift+Enter for a new line) or Insert new line (Ctrl+Enter sends). Shared across desks, inboxes, docket replies and multiline question answers; single-line inputs unchanged (decision 48) |

### J. Mail hub, notifications, updates

| # | Today | After the rewrite |
|---|---|---|
| J1 | The engine hosts the local mail hub on port 7370; hub hosting settings | Kept (same hub product, started the same way) |
| J2 | Desktop notifications and the Attention view (questions, urgent mail, ticket attention) | Kept |
| J3 | Updater maintenance handshake (install at idle) | Kept |

### P. Agent tools removed

`orgtree_self_restart`, `orgtree_prime_restart`, `orgtree_restart_wake`, `orgtree_self_relaunch`,
`orgtree_prime_relaunch` (agents restarting Orgtree itself) · `orgtree_reservation`,
`orgtree_resource_reservation` · `orgtree_submit_report` (use `orgtree_present`) ·
`orgtree_preview`, `orgtree_capabilities` (user 2026-10-06: not needed).

Kept at the user's decision (2026-10-06): `orgtree_staff`, `orgtree_swap`,
`orgtree_self_subjugate`, `orgtree_unstick`, `orgtree_continue_on`, `orgtree_account_mark`,
`orgtree_state_inspect`, and `orgtree_list_orgs`. `orgtree_send_notice` becomes
`orgtree_message` with `notice: true` (old name kept as an alias).

## 11. Decisions I need from you

1. **New schema + one-time import** (recommended), rather than running on the 3.2 per-org schema.
   The old schema's design (org lock, revision row, compatibility view) is what we are leaving.
2. **The ledger above** — approved 2026-10-06. Decided along the way: HTTP for loading and
   actions with the existing push sockets (one-socket-per-window was considered and dropped),
   agents over their CLIs' own pipes; kept in the MVP: the boot-time background engine, cache
   forecasting, the MCP waiting state, the org inbox with `@org:`/`@net:` mail, the hiring credit
   cascade, account fallback, mid-turn effort changes for Claude, typed system-message cards (D1),
   API-key accounts with the fallback and subscription-inference switches (H3), and the agent
   tools listed as kept in §10 P. Everything else as written.
3. **Process keep-alive defaults** (B4): 10 minutes idle, at most 64 idle CLIs. A Claude CLI
   process measured 300 MB working set / 550 MB private on this machine today, so one parked CLI
   per agent at 1,000 agents is not possible here (it would need hundreds of GB).

## 12. Build order (after approval)

1. Workspace, config, logging, data-root lock, PostgreSQL start/stop, migrations, launch protocol,
   desktop routes, static UI → the app opens and lists orgs.
2. Importer → your orgs, agents, docket and mail appear.
3. Record feed + app feed + tree/ops/settings routes → canvas fully live; hire/move/retire work.
4. Agent runtime + Claude driver (control channel: tools, hooks, interrupt) + chat route →
   agents run and talk.
5. Mail, inbox, asks, docket, documents, files, watchdogs, audiences, killswitch/halt/freeze.
6. Codex, Antigravity, OpenRouter drivers; accounts, usage, providers.
7. Mail hub hosting, notifications, maintenance, Electron launcher change, packaging (version
   4.0.0).
8. Background engine: `host` mode (supervisor, attach descriptor, liveness, unelevated start) and
   the boot task registration pointing at the new binary.
9. Before publishing 4.0.0: the direct upgrade from 2.x data (A3).

Each step lands as commits on `rust-engine`; I tell you when a step is usable.

**Keeping the changes separable (user 2026-10-06).** Three kinds of change never share a commit:
1. the engine itself (`engine/rs/**`), on `rust-engine`;
2. the desktop changes the rewrite requires (the launcher picking the binary, packaging, the
   boot-task registration, the renderer joining transcript rooms, and UI changes that follow from
   the featureset differences, such as removing controls for settings that no longer exist), on
   `rust-engine`, in their own commits;
3. purely visual UI work (tidying settings menus and the like; never the canvas), on a separate
   branch `rust-engine-ui` stacked on `rust-engine`, so it can be dropped without touching
   anything else.
