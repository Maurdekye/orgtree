# AGENTS.md — working on Orgtree

This is the one file every agent working in this repository reads first. It collects the
design facts, user rulings, architecture and working practices that are otherwise spread
across `docs/`, past agents' notes, tickets and conversations, and it links to the detailed
docs instead of copying them. Codex reads `AGENTS.md`, and Claude Code reads it when the
repository has no `CLAUDE.md`, so **do not add a root `CLAUDE.md`**. [decided: user
2026-10-05]

## Keep this file current

**When you find an engine gotcha or a design invariant, or a new decision or ruling is
made, update this file in the same landing as the change it concerns.** If no code
changed, land a small follow-up commit that touches only this file.

- Keep entries short. Date each one (UTC) and tag it **[verified: `<file>`]** (you checked
  the source) or **[decided: `<who>` `<date>`]** (a recorded ruling: "user" is the product
  owner, "design" is [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md),
  "coordinator" is the team coordinator). Link the detailed doc.
- Describe only what has landed on `v3/3.0.0-alpha.0`. Work still in review or on a private
  branch is not current behaviour: its entry goes in the landing that ships it.
- When a rule changes, edit its entry in place and say what it replaced. Dead rules live
  only in [Removed and dead ideas](#removed-and-dead-ideas).
- Reviewers check this: a landing that adds a gotcha, an invariant or a ruling without
  updating this file is not finished.
- Agent sessions load this whole file, so keep it dense; long explanations belong in
  `docs/` with a one-line pointer here.
- `main` is public. Never put secrets, tokens, email addresses, user names, personal paths
  or live data in this file.

This first version was compiled on 2026-10-05 against `v3/3.0.0-alpha.0` at `6e53697`.

## Read this first

These rules prevent the mistakes that have cost the most: lost work, a crashed machine,
wrong test verdicts and re-argued decisions.

1. **What we build.** Orgtree 3 (3.x): an Electron desktop app, a Python engine and a
   bundled PostgreSQL. All work lands on branch `v3/3.0.0-alpha.0`; `main` is moved to it
   at each release. The current project is **3.2.0, the data-model rewrite** (one
   PostgreSQL database per org), designed in
   [`docs/state-system/pg-data-model-design.md`](docs/state-system/pg-data-model-design.md);
   its owner and integrator is drag-opus. [decided: user 2026-10-02; team charter]
2. **Never touch live Orgtree data, and never build an installer, tag, release, publish,
   deploy, install or restart the app.** Those belong to the coordinator and the release
   owner it names. The installed app's data root is `%APPDATA%\Orgtree v2\data`; agents'
   scratch folders live inside it, so touch only your own. [decided: team charter;
   verified: `apps/desktop/main/policy.ts`]
3. **Work in your own git worktree.** `git fetch origin`, then
   `python tools/worktree.py add <name> --base origin/v3/3.0.0-alpha.0` (the tool's default
   base is `main`, and the local branch refs in the shared checkout are stale: always use
   `origin/...`). Never junction or symlink `node_modules` into a worktree (removing it
   deletes through the link: 783 MB was lost this way), and never copy it. Never work in
   another agent's worktree, and never use a bare `git stash` (the stash is shared).
   [verified: [`docs/worktree-operations.md`](docs/worktree-operations.md)]
4. **In agent shells a bare `python` imports the installed app, not your checkout.** Run
   Python tests only through `python tools/run-python-verification.py tests/test_X.py` and
   read `import_provenance` in its output. Count `tests_ran_total`: a module that ran
   nothing is "not executed", not a pass. Scratch scripts start with the
   `tools/assert_repo_import.py` guard. [verified: `tests/import_provenance.py`]
5. **Tests are slow and the machine is short on memory.** Run only the test modules your
   change touches, at the base and at your tip, and compare the failing test names. Never
   run the full baseline (`test-baseline.mjs compare`); only the coordinator or release
   owner runs it, once, before a release. Anything heavy takes the machine lock with
   `tools/p03-run.ps1 -Wait`. Start only with 15 GB of free commit memory; stop below
   10 GB. [decided: user 2026-09-26; team charter] → [Tests](#tests)
6. **Landing:** an independent reviewer approves your exact commit; you rebase, re-run your
   targeted tests, run `python tools/source-audits.py`, fast-forward push and record the
   `git ls-remote` line. [decided: team charter] → [Reviews and landing](#reviews-and-landing)
7. **The storage rules are easy to break without noticing:** no transaction spans two
   databases; every writer takes its locks in one order, with the org's revision row last;
   only the org-lifecycle module holds the admin connection; no read may grow with inactive
   history. → [Design rules and invariants](#design-rules-and-invariants)
8. **Commit before you probe the base or mutate code for a test.** `git checkout --`,
   `git restore`, `git stash` and `git reset` have silently destroyed uncommitted fixes.
   [decided: team charter]
9. **Evidence:** label every claim measured or inferred. Treat a surprising pass like a
   surprising failure and check that your control really ran. After a timed-out call that
   may have applied, re-read the state before repeating a write. [decided: team charter]
10. **This machine has traps** (CRLF, heredocs, PowerShell encodings, MSYS path rewriting,
    slow git on drive E:). Read [Machine traps](#machine-traps) and
    [`docs/machine-traps.md`](docs/machine-traps.md) before your first command.
11. **Before changing behaviour, grep for the ruling behind it.** About 900 source comments
    cite user rulings ("user ruling", "user requirement", "user spec"), most with a date,
    mostly in `ledger.py`, `supervisor.py`, `api.py` and the renderer canvas. A cited ruling
    binds until the user changes it. [verified 2026-10-05]
12. **Do not revive dead ideas** (kiosk mode, the per-org Docker sandbox, the frozen
    profile, v1 import, SQLite as primary storage). → [Removed and dead ideas](#removed-and-dead-ideas)

## What Orgtree is, and where it stands

- **The product.** A Windows desktop app for running a persistent team of coding agents.
  The user sits at the top of an org chart (the canvas); agents work beneath, each with a
  desk (live conversation and tool activity), mail and notices, a shared docket of tickets,
  questions to the user, audiences (extra communication links), watchdogs, presentations
  and file delivery. Agents run through Claude Code, Codex and Antigravity, or OpenRouter,
  on one or more signed-in accounts per provider. **Credits** are a capacity budget, not
  money: each agent occupies a model-priced seat, its grant funds the agents beneath it,
  and retiring it frees the capacity. [verified: `README.md`]
- **Lineage.** claude-orgtree (v1) → Orgtree 2 (Electron around the v1 Python engine, on
  SQLite; last release 2.1.14) → Orgtree 3 (storage on PostgreSQL; 3.0.0 published
  2026-10-01, 3.1.0 on 2026-10-02). [verified: git tags `v3.0.0`, `v3.1.0`]
- **The mission of v3** is performance and memory, not UI: the app must stay responsive
  with hundreds or thousands of active agents. [decided: user 2026-09-26]
- **Scale targets** at 1,000 agents: UI reads p95 under 250 ms; tool calls p95 under
  500 ms and never waiting on unrelated agents; clicks under 100 ms; engine memory flat
  over an hour; screen feed under 1 s with no drops; at 2,000 agents, usable with no stall
  over 2 s. They are best effort, not a release gate, while the engine stays Python, and the
  separate scale-qualification test was dropped. [decided: user 2026-09-26, 2026-09-28,
  2026-09-30]
- **3.2.0** rewrites the data model as if Orgtree were built for PostgreSQL from the ground
  up, and ships it all at once: one database per org, jobs in place of every polling loop,
  a change log that feeds the renderer records instead of refetches, a durable turn queue
  with leases, and a second engine process. [decided: user 2026-10-02, design decisions 7,
  10, 12]

**3.2.0 status on 2026-10-05** (check `git log origin/v3/3.0.0-alpha.0` before relying on it):

- **Landed:** phase A (per-org databases, converter with `unavailable` and Retry,
  compatibility view, native agent and docket readers, accounts in the app database; new
  storage on by default since `4f1ddf0`); durable turn requests and queue (B5, `305c472`);
  schema conformance G1–G11 (`c162ca0`); the O(1) agent move (O1, `3535fb4`); the alpha.1
  startup repairs (`d1c4e8c`); one shared registry connection cache (`ebb2af6`).
- **Builds delivered** (local, never published): 3.2.0-alpha.0 on 2026-10-04 and
  3.2.0-alpha.1 on 2026-10-05; the user runs them on live data. alpha.1's startup failures
  are fixed on v3 by `d1c4e8c`.
- **In flight:** the record feed, step 6: B4a (backend core and the tree) and B4b (the app
  feed); B4c1 (inbox, events, mail, history), B4c2 (gallery, docket, audiences) and B4d
  (time and retention jobs) follow.
- **Remaining:** B1 mail and watchdog modules with jobs; B2 questions, audiences,
  documents, reservations, events and settings modules, with every remaining polling loop
  a job; B3 the host's job scheduler and sweep; B6 the worker process and deletion of the
  compatibility view; then final rehearsals and the release candidate, including installer
  upgrade rehearsals from 2.1.14, 3.0.9 and 3.1.0 with a rollback. [decided: umbrella
  ticket `v3-storage-keep-indexed-fields-in-real-postgresq`, decisions 23 and 34]

## Architecture

As built on `v3/3.0.0-alpha.0` on 2026-10-05; where 3.2.0 will differ, the table at the
end of this section says so.

### Processes and the desktop–engine boundary

- **Desktop** (`apps/desktop`): Electron 44. `main/` owns windows (one main window per
  org), tray, updater and the engine's lifecycle (`index.ts`, `engine.ts`, `policy.ts`).
  `preload/` exposes `window.orgtreeDesktop` only to the top frame at the exact engine
  origin. `renderer/` is React 18 + MUI 9 + TypeScript, built by Vite into `dist/renderer`
  and served by the engine as `resources/ui`; it has no state library (`App.tsx` state plus
  module-level stores). [verified: `package.json`, `apps/desktop/preload/index.ts`]
- **Engine** (`engine/`): Python 3.13 (embedded runtime, `engine/runtime`, gitignored and
  provisioned by `npm run runtime:provision`). `engine/launch.py` validates the data root,
  sets Windows High priority, arms the guardian, starts PostgreSQL and serves the FastAPI
  app (`engine/backend/orgtree/api.py`) on `127.0.0.1`. [verified: `engine/launch.py`]
- **Guardian** (`engine/process_lifetime.py`): holds the data-root lock
  (`.desktop-engine.lock`) and a Windows kill-on-close job containing the engine and every
  descendant (PostgreSQL, provider CLIs), so a dead engine never leaves orphans. [verified]
- **Boot host** (`engine/service_host.py`): run at Windows boot by the "Orgtree Background
  Engine" scheduled task (all-users installs only; S4U, LeastPrivilege). It starts the
  engine unelevated and writes `engine-attach.json` so the desktop can attach.
  [verified: `tools/boot-engine-task.ps1`, `build/installer.nsh`]
- **PostgreSQL 18.6**, bundled, run by the Rust `pg-custodian` (`engine/native/pg-custodian`)
  through `engine/pg_process.py`; the cluster lives in `<data>\pg\cluster`; roles
  `orgtree_admin` and `orgtree_runtime`; connection strings use a passfile and SCRAM, never
  a password. [verified]
- **Mail hub**: the `engine/mailhub` submodule (orgtree-mailhub) runs as a child process;
  changes land in orgtree-mailhub first and Orgtree moves only the pin.
  [verified: [`docs/mailhub-sync.md`](docs/mailhub-sync.md)]
- **Boundary.** All domain traffic is HTTP and WebSocket from the engine origin; IPC
  (`desktop:*`) is only for native operations. The desktop sends a fresh per-boot token in
  `X-Orgtree-Desktop-Token`; the engine drops it from its environment before importing
  anything that spawns children. The port is preferred from 20000–49151 and kept in
  `engine-port.json`, because moving the origin strands the browser's local storage.
  [verified: `engine/launch.py`; [`docs/engine-contract.md`](docs/engine-contract.md)]
- **Agents** call back through the MCP server `python -m orgtree.mcptool`, which posts to
  `/api/agent` with `X-Orgtree-Agent-Token` (an HMAC over org, node, generation and seat,
  keyed per engine process) and `X-Orgtree-Turn-Token` (binds the call to the running
  turn). [verified: `mcptool.py`, `agentauth.py`]

### Storage

- **Backend choice:** `ORGTREE_STORE`, then `<data>/store-backend.json`, then SQLite.
  Packaged builds set `ORGTREE_PG_BOOTSTRAP=1`: a fresh data root binds to PostgreSQL, and
  an existing 2.x SQLite root is converted at first launch (old files moved to
  `pre-postgres/`). An unpackaged dev run stays on SQLite unless told otherwise.
  [verified: `engine/pg_process.py`, `apps/desktop/main/postgres-runtime.ts`]
- **The layout switch `ORGTREE_STORAGE`:** unset or empty means `orgdb` (one database per
  org) whenever the engine runs on PostgreSQL; `legacy` is the developer escape hatch.
  Agent children never inherit it. [verified: `engine/pg_process.py`, `devguard.py`]
- **Legacy layout** (3.0–3.1): one database `orgtree` with a schema `org_<n>` of key+JSON
  tables per org; migrations `pg_migrations/0001`–`0020`, frozen (published checksums are
  pinned by `tests/test_published_migrations.py`). 3.2.0 never migrates or writes it.
- **Per-org layout** (3.2.0): `orgtree_app` plus `orgtree_org_<n>`, all tables in schema
  `orgtree`. Migrations live in `pg_migrations/app/` and `pg_migrations/org/` and run per
  database, one transaction per file; editing an applied file raises `MigrationDrift`; an
  org database newer than the build is not served. Database names come only from
  `orgdb/names.py`. [verified: `orgdb/migrate.py`]
- **Startup with `orgdb`:** prepare the app database → the one-time converter pass (a child
  process) → resume interrupted lifecycle claims → migrate each active org (a failure makes
  only that org `unavailable`) → retry unavailable orgs once per new build → start the turn
  host. [verified: `orgdb/startup.py`]
- **Compatibility view** (`orgdb/compat`): `store.py` keeps issuing its own SQL against the
  legacy tables, and an org-database connection answers each statement from the new
  tables; an unknown statement raises. It is deleted in B6. [verified]
- **Connections:** one idle cache per process for app and org sessions (at most 4 idle app,
  2 idle per org database, 16 in all; 10-minute expiry; keyed by the full runtime connection
  settings plus the database). Every org checkout re-checks `org_identity`, and a mismatch
  refuses. Only a failed pre-body checkout reconnects: transaction bodies and ambiguous
  commits are never repeated. Dirty or listening sessions are closed, never reused. The turn
  heartbeat has its own thread and connection (5 s connect and statement timeouts). There
  is deliberately no blanket idle-in-transaction timeout (org-exclusive file-move fences
  must survive). An active cap and a FIFO queue arrive with B6. [verified:
  `orgdb/registry.py`, `orgdb/turn_runtime.py`; decided: coordinator 2026-10-05, outage
  ticket decision 3]

### Turns, jobs and the feed: built today vs. 3.2.0

| Part | On v3 now | 3.2.0 target |
| --- | --- | --- |
| Turn admission | With `orgdb`: a durable `turn_requests` row in the org database, a `start_turn` job, then a `turn_tickets` row in `orgtree_app` claimed by the turn host. Otherwise the in-memory `turnslots.FairSlots`. Limit: App settings `max_concurrent_turns`, default 16 | the same, shared with the worker |
| Jobs | `orgdb/jobs.py` exists, but only `start_turn` is enqueued. The polling loops (auto-resume, watchdogs, mail drain, keepers) still run as threads started by `api._recover_startup` | every loop that reads org tables becomes a job (B1–B3) |
| Screen feed | `pgfeed.RevisionFeed`: each commit bumps `org_revision` and sends `NOTIFY`; the renderer gets a coalesced `changed` frame and refetches, and some panels poll | a per-org change log whose frames carry records; no refetch and no polling. The renderer consumer exists behind capability `record_changes_v1`, which the engine does not advertise yet |
| Processes | one engine process per data root | an engine host plus one worker (B6) |

### Code map

- `engine/backend/orgtree/`: `supervisor.py` (about 37,600 lines: turns, provider legs,
  polling loops, the managed agent instructions), `ledger.py` (about 20,000: the `Org`
  domain model, credits, hire/move/retire, scope clamps), `api.py` (about 15,400: every
  HTTP and WebSocket route), `store.py` (the storage seam), `orgtx.py` (`org_tx` and lock
  plans), `orgdb/` (per-org storage), `turnslots.py` and `turnqueue.py`, `mcptool.py`,
  `agentauth.py`, `halt.py`, `pgfeed.py`, `warmpool.py`, and the provider modules
  (`codexrun.py`, `antigravityrun.py`, `openrouter*.py`, `providers.py`).
- **Name collisions:** four "lifecycle" modules (`lifecycle.py`, `lifecycle_tx.py`,
  `lifecycle_door.py`, `orgdb/lifecycle.py`); two "registry" modules (accounts
  `registry.py`, orgs `orgdb/registry.py`); Python `store.py` versus the Rust `store` crate.
- **`engine/native/`:** only `pg-custodian` (with its `prototype-guard` library) runs in the
  product. The `store*` crates are a shelved Rust store prototype. `backend-codec`,
  `funding-core`, `op-receipt-codec`, `scope-clamp` and `work-name-codec` are parity models
  checked against vectors generated from the Python sources. `engine/winservice/` is not
  wired. [verified]
- **Generated files:** `apps/desktop/renderer/src/generated/events.ts` says it comes from
  `tools/gen_events.py`, which does not exist; regenerate it with
  `orgtree.events.emit_typescript()`. [verified]

## Design rules and invariants

Break one of these and the damage is usually silent until it reaches real data. "§" refers
to [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md).

### Data model (3.2.0)

- **PostgreSQL is the only source of truth.** No engine process holds org state; a cache is
  allowed only when keyed by `(org, revision)` and dropped when that org's feed moves past
  it. [decided: user 2026-10-02, design decision 7; §2.9]
- **One database per org, plus one small app database.** An org's database holds everything
  the org owns; `<n>` in `orgtree_org_<n>` is the registry's `org_id`, so a rename never
  renames a database. `orgtree_app` holds only the org registry, machine-wide accounts, the
  turn queue, engine instances and a one-row `app_settings` of cutover markers (the user's
  App settings stay in `app-settings.json`). Creating or importing an org is one database
  plus one registry row; deleting moves it to the trash; purging drops it. [decided: user
  2026-10-02, decisions 10 and 11; §2.10]
- **Normalized design (about 3NF).** A many-to-one link is a foreign-key column on the
  "many" side; a many-to-many link is a link table with one row per link; no embedded
  lists. Every deliberate duplicate is justified in the design (Appendix A.7). [decided:
  user 2026-10-02, decisions 2–3]
- **Keys and names.** Every record has a surrogate `id`; visible names (agent name, ticket
  slug, mail id) stay unique natural keys, so a rename is one `UPDATE`. A deleted agent
  keeps a tombstone row. Ticket slugs are never reused. [decided: §2.2, §3.0]
- **Agent identity is the node, not the lineage.** Each agent and each archived generation
  (`x`, `x@3`) is its own row, mailbox and principal; `lineage_born` is a shared lineage
  token, not an identity. "Current holder" references (ticket owner, mail recipient) point
  at the node's row; "historical" ones (creator, sender, event actor) keep the recorded name
  and generation with no foreign key. [decided: design rev 6, finding f17; §3.0]
- **Exact round trips.** Timestamps are `timestamptz` at microsecond precision, with the
  original text kept beside a non-canonical value; unknown keys go to an `extra` JSON column
  that is expected to be empty; a JSON column holds only a shapeless payload that nothing
  filters inside. PostgreSQL's JSON operators fail on a `\u0000` escape anywhere in a value,
  so such text stays in `extra`. [decided: design Q1, Q2; §3.0]
- **Migration numbers are taken at landing:** the next free number on v3 when your migration
  lands, never reserved earlier. [decided: drag-opus 2026-10-04, decision 32]

### Transactions and locks

- **One short transaction per action**, on its own org's database, over only its rows, at
  READ COMMITTED. A serialization failure or deadlock re-runs the whole function, so domain
  functions must have no side effects outside the database. Business rules stay in Python.
  [decided: §2.1]
- **No transaction spans two databases.** An action that touches two (cross-org mail,
  starting a turn) records its intent durably in the first, then finishes with an
  idempotent job keyed by a stable id. [decided: §2.1, §2.7]
- **One lock order for every org-database writer** [decided: §2.4, revs 7.4–7.8; verified:
  `tests/test_orgdb_lock_order.py`]:
  1. the running turn's request row (`FOR SHARE` for tools and results; `FOR UPDATE` to
     finish, cancel or reclaim);
  2. advisory locks: the org lock, then the settings fence, then node, key and log-owner
     locks in sorted plan order, then the operation-receipt lock;
  3. rows by tier: agents by physical id, then `agent_subtree_stats`, then docket items,
     then mailboxes, then other planned rows. A structural writer takes every lock before
     its first structural statement; a plan that proves too narrow raises `Widen` (roll
     back, rerun wider). Never lock a row late;
  4. the revision row `orgtree.org_revision` **last**, taken only by
     `OrgDbConn.on_save_commit`, the commit-time triggers, or a job's last statement;
  5. after it, only `foreground_parent_counts` and `docket_counters`.
- **Triggers.** A statement-time trigger writes only link rows of its own statement's rows
  and takes no row lock; the one allowlisted exception is the `agents` subtree-stats
  triggers. Writers do not force deferred checks (`SET CONSTRAINTS … IMMEDIATE`); the single
  exception is the migration runner checking two named docket-pointer foreign keys for
  migration 0016 (2026-10-05). A value derived from other rows is a generated column, kept
  at statement time under the writer's own locks, kept under the revision row (the two
  counter tables), or computed by the reader. Changing any of this means changing the
  lock-order test, whose negative controls must keep failing. [decided: design revs 7.5,
  7.8; verified: `orgdb/migrate.py`]
- **Every foreign key to `agents` is immediate**, never deferred: a commit-time check would
  wait for an agent row after the revision row. [verified: `tests/test_orgdb_lock_order.py`]
- **Deferred foreign-key checks queued by a backfill block later DDL:** an `ALTER TABLE` in
  the same transaction fails with "pending trigger events". This broke migration 0016 on the
  user's data in alpha.1. [verified: `orgdb/migrate.py`, `61c15ce`, 2026-10-05]
- **The tree.** `agents.parent_id` is the only placement authority (no closure table, no
  stored depth). A move checks cycles and the depth cap under its sorted locks, and a final
  lock-free assertion after the revision row catches any writer, raw SQL and `COPY`
  included. An agent's effective scope is computed from its current ancestors, so moving it
  back restores its configured scope. [decided: design rev 7.8; user 2026-10-04;
  [`pg-o1-move.md`](docs/state-system/pg-o1-move.md)]
- **The admin connection** (create, rename, drop databases) belongs only to
  `orgdb/lifecycle.py` in the engine host; a source-scan test enforces it. [decided: design
  Q10; verified: `tests/test_orgdb_static.py`]

### History must cost nothing

- **Performance tracks active data only:** retired agents, archived tickets and read mail
  must not slow anything down. [decided: user 2026-09-27]
- **Acceptance:** with at least 10× inactive history, p95 at most 5% slower and engine memory
  at most 5% higher; for a lookup that still grows with history, at most 100 ms added at a
  simulated 5,000 agent-hours of history. [decided: user 2026-09-27, 2026-10-03]
- **How:** partial indexes over active rows only (live agents, open tickets, undelivered
  mail, queued jobs, open questions); archived rows are reached only by key or a `LIMIT`ed
  range; tests seed 10× history and require the same statement counts and rows read; the
  hot-path guards fail on a JSON predicate in a hot query or a sequential scan of a large
  table. [decided: §2.3; verified: `tests/test_orgdb_hot_paths_static.py`]
- An agent's docket list totals count non-archived items only; an archived total comes only
  with `include_archived`. The desktop keeps its archived and backlog totals. [decided: user
  2026-10-02, decision 21]

### Background work, the feed and turns

- **Every polling loop that reads org tables becomes a job row** in the org database, written
  by the transaction that creates the condition and claimed with `FOR UPDATE SKIP LOCKED`.
  Timers that read outside state (provider usage, update checks, the mail hub) stay timers
  in the engine host. [decided: user 2026-10-02 (Q9); §2.7]
- **The change feed** (target): each org database records its changes in the committing
  transaction; revisions are handed out in commit order with no gaps; a cursor is
  `(org_uuid, incarnation, rev)`; baselines and catch-ups are single-snapshot reads, and the
  state at the frame's end revision decides. The desktop is the only audience; agents never
  use the websocket. [decided: §2.5;
  [`pg-step6-record-feed.md`](docs/state-system/pg-step6-record-feed.md)]
- **Turn admission is machine-wide:** at most N turns at once (a setting, default 16), first
  come first served within an org, round-robin across orgs; lowering the limit never stops
  a running turn; a queued agent's desk explains the limit. [decided: user 2026-09-26;
  verified: `turnslots.py`]
- **A turn has a durable identity** (a request row, then a ticket keyed by its id), numbered
  claims and process leases. A stale process can change nothing, and a slot is reused only
  after the old run is verified dead. [decided: §2.4]
- **"A turn cannot run while its agent is halted."** Halt is not interrupt: it ends the turn,
  closes every admission and delivery path, and keeps queued mail unread until an explicit
  unhalt. [decided: user 2026-09-12; [`docs/agent-halt.md`](docs/agent-halt.md)]
- **Turn time limits:** a total ceiling (default 24 h) and a silence limit (default 10 min),
  both configurable and disableable in App settings > Runtime. [decided: user 2026-10-02;
  verified: `appsettings.py`]

### Processes, privileges and startup

- **Unelevated by default.** The engine, PostgreSQL and agents run as the normal user;
  PostgreSQL refuses an administrator token. The only opt-in is "Run Orgtree as
  administrator", stored in HKLM and written through UAC, never in the data folder (agents
  can write there). [decided: user 2026-09-09, 2026-09-30; verified:
  `apps/desktop/main/runasadmin.ts`, `engine/service_host.py`]
- **The engine runs at Windows High priority** so busy apps cannot starve it. [decided: user
  2026-10-04; verified: `engine/launch.py`]
- **Untrusted output never gains privileges.** Agent Markdown, HTML and presentations get no
  desktop bridge; the desktop token never reaches provider or MCP children; each agent's
  credential is bound to its org, node and generation. [decided: user 2026-09-05; engine
  contract]
- **Agent children never inherit the engine's storage variables.** A script an agent runs
  must set its own throwaway `ORGTREE_DATA` before importing `store`, or the import raises.
  Bind it before importing any `orgtree` module (`store.DATA_ROOT` binds at import).
  [verified: `engine/backend/orgtree/devguard.py`]
- **Startup deadlines measure silence:** 60 s for the desktop and 120 s for the boot host
  between structured progress checkpoints; every migration and conversion step runs under a
  `database-convert…` phase with a one-hour window. Long startup work must emit checkpoints:
  alpha.1 died on this. [decided: user 2026-10-05; verified: `apps/desktop/main/policy.ts`,
  [`docs/startup-budget.md`](docs/startup-budget.md)]
- **One failing org never stops the others.** It becomes `unavailable` with its reason and a
  Retry; only a failure of the app database or of the accounts refuses the whole start.
  [decided: user 2026-10-02 (Q12); §2.12, §2.13]

### Desktop and renderer

- **Circular layout order:** in the circular org chart, siblings (rings, the agents list and
  the floating jump cards) follow tree order counterclockwise; never sort them by x/y
  position. Only the row layout orders siblings by position. [verified:
  `apps/desktop/renderer/src/canvas/OrgCanvas.tsx`, `8c25e5e`, 2026-10-05]
- **Window bounds at fractional DPI:** Windows can add an invisible frame allowance to a
  frameless window's size, even through `setBounds`, and Electron's `did-create-window` does
  not carry the original window features. Temporary desks pass their exact rectangle and
  `setExactPopoutBounds` measures and corrects the real bounds; pinning uses the modal's
  outer rectangle, and pop-out ends the modal only after the window adopts the desk.
  [verified: `apps/desktop/main/windows.ts`, `canvas/tempdesk.tsx`, `6e53697`, 2026-10-05]
- **CSS `app-region` is inherited,** and only `initial` stops it (`unset` and `none` do not):
  scrolled-out no-drag children once punched holes in the header's drag region. [verified:
  `apps/desktop/renderer/src/styles.css`]
- **jsdom does no layout.** Geometry, drag regions and native window behaviour need the
  Electron probes (`tools/test-*.mjs`), not renderer unit tests. [verified:
  [`docs/verification-recipes.md`](docs/verification-recipes.md)]

## Product rulings

The user's standing rulings about how Orgtree behaves. The older ones (up to 2026-09-15)
are recorded in full in [`docs/v2-user-decisions.md`](docs/v2-user-decisions.md); new
rulings go here and on their ticket.

### Org, agents and topology

- **Scope containment:** a child's folders, tools and visibility always lie within its
  parent's. Moving an agent pauses audiences whose anchor is no longer an ancestor and
  restores them if it moves back; an explicit revoke is permanent; the move result is a
  short summary, and running turns finish. [decided: user 2026-09-12, 2026-10-04]
- `swap`, `subjugate` and `move_batch` stay agent-only, with no operator door.
  `self_subjugate` is a subtree promotion: the target rises with its own team, its team
  charter does not transfer, and grants are untouched. Inserting a superior has one
  implementation (`insert_parent`). [decided: user 2026-09-12, 2026-09-15]
- **Credits:** grants are whole credits (rounded up when a raise saturates a superior);
  seats may be fractional with a 0.10 floor; "a promo never sets a seat"; the user is the
  root with unlimited credit. [decided: user 2026-09-03, 2026-09-04]
- Retiring keeps history, and rehire restores the agent. Retire, dissolve and compaction
  stop an agent's background tasks. [decided: user 2026-09-29]

### Turns, mail and notices

- Delivering a message never interrupts a turn; only an explicit interrupt does. Mid-turn
  mail arrives at the next safe tool boundary or at the turn's result boundary. An accepted
  message is injected once or queued, never neither; "delivered" is final only when the
  provider transcript shows it. [decided: user 2026-09-03, 2026-09-05;
  [`docs/mail-delivery-boundaries.md`](docs/mail-delivery-boundaries.md)]
- Notices never start a turn. Status reports (`orgtree_status`) arrive as passive notices;
  anything that needs action is a question. [decided: user 2026-10-03]
- A mid-turn model switch is queued for the next turn (an interrupt applies it at once). A
  switch to another provider is a lineage split and asks for confirmation. [decided: user
  2026-08-29, 2026-09-03]
- Warm processes: one parked CLI per live agent, started at boot and on hire; no idle reaper
  or cap; warming is a user setting, on by default. [decided: user 2026-08-30, 2026-09-26]
- After a crash or restart, agents that were mid-turn resume with session continuity, and
  uncertain tool results are reconciled, never repeated. [decided: user 2026-09-07]

### Docket, questions and attention

- A ticket is identified only by its readable slug. Its description states the problem
  first, then the solution, and is its authoritative scope; decisions are append-only.
  Assignment is ownership. [decided: user 2026-09-05, 2026-09-12]
- `review` means review by agents. The user is reached through an attached question or the
  attention flag, which stays up until the user replies or dismisses it or an agent takes
  it down explicitly; a dismissal moves the ticket to `blocked`. [decided: user 2026-09-05,
  2026-09-19]
- Dropped tickets archive at once; done tickets an hour after their last update. There is
  no `waiting` status; `blocked` states its reason. Over-long fields are refused, never cut.
  An item's earlier holders are readable only while you are listed on it. [decided: user
  2026-09-04 to 2026-09-16]
- These rules are written into the managed agent instructions in `supervisor.py`. Editing
  those strings changes every agent's cached prompt, so batch such changes and say so.

### Providers, accounts and usage

- Provider, model, harness, account and route are separate concepts, and provider
  differences are shown honestly. [decided: user 2026-09-05]
- Accounts are machine-wide and symmetric (any org may use any account), except legacy
  org-key accounts, which keep their origin org. Account ids are immutable; the primary
  account shows as `default`. An account at its limit waits; fallback to another account is
  opt-in per agent (off by default) and keeps the new account; API-key accounts are an
  off-by-default last resort. Agents choose the account on hire, rehire, retool and staff;
  usage readings guide them but are never a server-side admission gate. [decided: user
  2026-09-07 to 2026-09-12; [`docs/v2-user-decisions.md`](docs/v2-user-decisions.md)]
- A provider that is not installed is absent from the UI; installed but signed out shows
  greyed hire tokens; a disabled provider refuses new hires while live agents keep running.
  Legacy models (Terra, Gemini Pro) appear only with "Show legacy models". [decided: user
  2026-08-30, 2026-09-30]

### Desktop UI

- Performance comes before UI work; keep and improve the existing layout rather than
  redesigning it. [decided: user 2026-09-07, 2026-09-26]
- Every app-generated time is shown in the user's local time zone; no visible UTC.
  [decided: user 2026-09-04]
- One main window per org; opening an open org focuses it; startup restores the previous
  windows; a saved window whose org is gone opens as an error window. Pinned means pinned.
  [decided: user 2026-09-04, 2026-09-21]
- Notifications default to needs-attention only (questions, urgent mail, ticket attention).
  Clicking a file link reveals the file in Explorer and never opens or runs it. [decided:
  user 2026-09-07, 2026-09-13]

### Installer, updates and data

- PostgreSQL ships inside the installer, with its data under `<data>\pg`. Uninstall keeps
  data and history; history, documents and work records are kept until the user removes
  them. [decided: user 2026-09-07, 2026-09-26]
- Automatic updates (on by default) check in the background and install only at a safe idle
  point (engine idle plus 60 s of user inactivity), never interrupting a turn. [decided: user
  2026-09-07; verified: `README.md`]
- An upgrade never modifies the old data: the legacy database and files are kept for one
  release, so rolling back means running the old build again (from 2.1.14, also move
  `pre-postgres/orgs` back). 3.2.0 never touches the old org markers in `orgs/`. [decided:
  design §3.9, §5.3]

## Development workflow

### Branches and worktrees

- All work lands on `v3/3.0.0-alpha.0` by fast-forward. `main` is moved to v3 at each
  release, and releases are cut from it; the user's README-only commits go to `main` first
  and are cherry-picked to v3. 2.x maintenance lives on `release/2.x`. [decided: team
  charter; user 2026-09-30; verified: [`docs/windows-release.md`](docs/windows-release.md)]
- Worktrees: `python tools/worktree.py add|verify|remove`; `remove` refuses when it finds a
  link leading out of the worktree. Settle overlapping files with the agent whose ticket
  owns them; never edit another agent's files. [verified:
  [`docs/worktree-operations.md`](docs/worktree-operations.md); decided: team charter]

### Tests

- **Python:** `python tools/run-python-verification.py tests/test_X.py [...]` gives each module
  a fresh interpreter in isolated mode and a fresh `ORGTREE_DATA`, with a 300 s default
  timeout per module (`--timeout`). Compare `failed_tests` names between base and tip. A
  worktree has no `engine/runtime`; the runner finds the main checkout's interpreter by
  walking up, and anything else should use that interpreter (or
  `npm run runtime:stage -- --from <checkout>`). PostgreSQL tests skip unless
  `ORGTREE_TEST_PG_ADMIN_URL` is set: a skip is not a pass. Spawn child processes with
  `tests/child_python.argv`. [verified]
- **Node and renderer:** `npm test` (root `tests/*.test.mjs`), `npm run test:renderer`
  (`apps/desktop/renderer/tests/run.mjs`, whose filters are substrings and OR together),
  `npm run typecheck`; keep `ORGTREE_TEST_CONCURRENCY=4`. Also run any renderer count or
  inventory test your change could affect. `run.mjs --output DIR` creates a `node_modules`
  junction inside DIR, so never point it into a worktree; `--prebuilt DIR` creates none.
  [verified: `package.json`, `apps/desktop/renderer/tests/run.mjs`]
- **The baseline:** `node tools/test-baseline.mjs show` (or `npm run test:known-failures`)
  lists known failures and runs nothing. `compare` and `record`, `npm run test:compare`,
  `npm run test:baseline:record`, `npm run verify:release` and `npm run release:windows`
  all run the full suites: coordinator or release owner only. [decided: user 2026-09-26]
- **Per landing:** run only the modules your change touches, at base and tip, each call under
  20 minutes; land if no new test name fails. After a rebase that only moved the base,
  re-run only tests touching files that changed on v3 in between. [decided: team charter]
- **The machine lock:** one heavy run at a time on the whole machine (scale runs,
  rehearsals, database batches, and any test stream that creates or drops PostgreSQL
  databases: each `DROP DATABASE` waits for a checkpoint, and two such streams stalled the
  cluster on 2026-10-02; concurrent suite runs crashed the machine on 2026-09-18). Use
  `tools/p03-run.ps1 -Agent <you> -Wait -Run @('python', '<script>', ...)`; `-Status`
  prints JSON; `-Small` allows two small runs; `-Dequeue` drops all of your entries.
  [decided: team charter; verified: `tools/p03-run.ps1`]
- **Memory (this machine):** start a run only with 15 GB of free commit memory and stop below
  10 GB; a single static source-scan module may start at 10 GB (`-MinFreeCommitGB 10`). Wait
  with `-Wait` or a watchdog, not by polling. [decided: team charter]
- **Your own PostgreSQL cluster:** drive E: syncs slowly (about 3 s per fsync, 2026-10-03), so
  set `fsync`, `synchronous_commit` and `full_page_writes` to `off` on your own disposable
  cluster only, never the live one or anyone else's. The live-data copy
  (`artifacts/livecopy-20261002/`) loads only into such a cluster under the lock; drop the
  databases afterwards and never commit or copy it. [decided: team charter]
- **Risky code** (locking, transactions, leases, queues, data import, halt, the killswitch):
  reviewers break the code on purpose and check that a test fails ("mutants"); race fixes
  come with two-session barrier tests; `org_tx` silently retries deadlock victims, so race
  tests run with retries off. [decided: team charter; design §9]

### Reviews and landing

1. An independent reviewer records `approve_stage` on your exact commit; the coordinator
   grants the landing (often pre-granted in the ticket). The reviewer never lands.
2. Rebase onto the current v3 and check `git range-diff` (all `=`, or explain each `!`).
3. Re-run your targeted tests, then `python tools/source-audits.py` (about a minute, no
   database): the one import-guard line in every test module, hub isolation, the
   child-spawn allowlist, duplicate definitions and BOMs, and the native vector anchors. If
   you changed `ledger.py`, `api.py`, `agentauth.py`, `openrouter.py` or `opreceipts.py`, run
   the affected crate's vector test; regenerate with the main checkout's
   `engine\runtime\python.exe engine/native/<crate>/oracle/generate_vectors.py --write`
   only if it fails on the anchors alone. Any other difference means an encoded rule
   changed: stop and find out why. [verified: `tools/source-audits.py`]
4. Fast-forward push (`git push origin HEAD:refs/heads/v3/3.0.0-alpha.0`), then put the
   `git ls-remote origin refs/heads/v3/3.0.0-alpha.0` output in your claim note. The
   docket's `pushed` claim checks the installed app, not this repo, so it refuses; record
   the ls-remote line as evidence instead. [decided: coordinator 2026-10-03]
5. Update this file if you found a gotcha, an invariant or a ruling.

Never rewrite pushed history or force-push. [decided: team charter; user 2026-10-03]

### Evidence and reporting

- Label every claim measured (you ran it and saw it) or inferred. Quote the module's own
  `Ran N tests … OK` line; treat zero executed tests as "did not run".
- Check that a control can fail: plant the fault, see red, restore. A guard that passes with
  the guard removed is worthless.
- Keep `breadcrumbs.md` in your scratch folder current; it is what a successor reads.
- Crash forensics: the engine logs to `<data>\diagnostics\engine.log` (with
  `engine-stall-stacks.txt` and `engine-liveness.jsonl` beside it); for a silent death,
  check the Windows event log, `update-log.json` (updater and installer) and
  `Crashpad\reports\` (Electron). The hardware has a history of memory faults: consider that
  only after the ordinary causes. [verified: `engine/enginelog.py`, `engine/stall_watch.py`]

## Releases, builds and updates

- Only the coordinator and the release owner it names build, tag, publish or install.
  [decided: team charter]
- **No build or publish until the whole 3.2.0 rewrite has landed**, apart from local alpha
  builds for the user. [decided: user 2026-10-02]
- **Alphas are local and never published:** no tag, no GitHub release, no updater feed. They
  are built from a side branch and delivered as a file. Release notes never name
  unpublished builds. The alpha number counts delivered builds. [decided: user 2026-09-30,
  2026-10-02]
- **Public releases** are cut from `main` with `npm run release:windows -- <version>
  --publish`, which verifies one exact candidate before any tag or GitHub change, then
  publishes a normal (not prerelease) release with six canonical assets. Without
  `--publish` it is local only. The version lives in `package.json` and both
  `package-lock.json` fields, and needs `docs/release-notes-<version>.md`; `-RCn` labels are
  refused. [verified: [`docs/windows-release.md`](docs/windows-release.md)]
- **Every upgrade path is tested:** 3.2.0 must upgrade from 2.1.14, 3.0.9 and 3.1.0, with
  converter rehearsals on real-data copies before an alpha and installer upgrade rehearsals
  plus a rollback before the publish. [decided: user 2026-10-02, decision 14]
- **Dev builds** (`npm run package:dev`) install beside the published app under their own
  identity and data folder. [verified: [`docs/dev-builds.md`](docs/dev-builds.md)]

## Machine traps

Most damaging first. Every trap here was hit on this machine and is recorded in past agents'
notes or in [`docs/machine-traps.md`](docs/machine-traps.md), which also lists the safe
commands. [verified: incidents 2026-08-26 to 2026-10-05]

1. **Concurrent heavy runs exhaust commit memory**: the engine dies and the window goes white
   (2026-09-16 and 2026-09-18). Use the machine lock and the memory floors; never kill
   another agent's processes.
2. **`node_modules` links**: three real deletions through junctions. Use
   `tools/worktree.py`; a leftover `orgtree-renderer-tests-*` folder in the temp directory
   holds a junction, so unlink it (`cmd /c rmdir <dir>\node_modules` from PowerShell) before
   deleting the folder.
3. **Background work dies with the turn**, and a turn with no output for an hour is killed.
   Keep long work in the foreground, split into calls that finish well inside the shell
   tool's timeout, and never end a turn with a background task still running.
4. **Tests that silently run the wrong tree**: `python -I` does not help, because the packaged
   runtime's `python313._pth` lists `../backend`; the system Python is 3.10 and lacks the
   dependencies; use the runner and read `import_provenance`.
5. **Slow git on drive E:** a commit can take minutes, a first `git status` in a worktree over
   a minute, `git worktree list` over a minute. Use long timeouts, never kill a slow git
   command, filter `git worktree list`, and never `find` or `grep -r` from the repository
   root (hundreds of worktrees).
6. **PowerShell 5.1:** `>` writes UTF-16; native stderr under `ErrorActionPreference=Stop`
   becomes an error; `-match` ignores case; `DateTime.Parse('…Z')` converts to local time
   (use `DateTimeOffset`); `@(...) + $null` adds an empty argument; use `git commit -F` for
   messages with quotes. `Get-Command bash` may find WSL.
7. **Git Bash:** MSYS rewrites `/flag` arguments (`MSYS_NO_PATHCONV=1`, or run from
   PowerShell); `cmd /c rmdir` and `mklink` through it can silently do nothing; the working
   directory persists between calls, so use absolute paths; long heredocs mangle
   backslashes and backticks, so write scripts with the edit tool.
8. **CRLF:** `.gitattributes` makes text CRLF; Python `newline=""`, `sed -i` and script writes
   flip files to LF. Vector anchors hash the CRLF bytes; migration checksums are
   LF-normalized. Check `git diff --check`.
9. **Elevated shells:** PostgreSQL refuses an administrator token, so start disposable
   clusters unelevated and check that the PostgreSQL tests actually ran.
10. **8.3 short paths** (`C:\Users\ABCDEF~1\...` from `%TEMP%`) trip a permission prompt that
    a headless agent cannot answer; expand them to the long name.
11. **Windows command-line limit** (32,767 characters): put large settings in a file, not on
    the command line (it broke every agent spawn on 2026-09-01).
12. **Time:** the machine clock is UTC+3; org timestamps are UTC.

## Gotchas in Orgtree's own agent tools

Agents that build Orgtree also run on it; these bite repeatedly. [verified: agents' notes
2026-08 to 2026-10]

- **Mail that arrives while a subagent (the Agent tool) runs is injected into the
  subagent's tool result.** The parent never sees it, and `orgtree_inbox fetch` returns
  `already_moved` until the next turn. Check your inbox after subagents finish. [verified
  2026-10-05]
- `orgtree_send_notice` never starts a turn; an idle agent reads it only when something else
  wakes it.
- A timed-out mutating call may have applied ("UNKNOWN"): re-read before repeating, and use
  `expected_rev` on docket writes.
- Docket: field names differ per action; caps of 40 artifacts and 50 evidence rows per item;
  `artifact_read` and `orgtree_read_scratch` stop near 20,000 characters; use `fields=[...]`
  or a projection on large items.
- Watchdog command targets run in `cmd.exe` unless `shell: "bash"`; read the create-time
  smoke output; a dog aimed at a retired agent never fires.
- Never put a headless agent in plan mode: it blocks every orgtree tool.
- Claude agents see tools as `mcp__orgtree__<tool>`; Codex and Gemini register bare names.

## Removed and dead ideas

Do not rebuild, re-propose or "restore" these without a new ruling from the user.

| Idea | Status | Source |
| --- | --- | --- |
| Kiosk mode (public renderer and visitors) | Removed on v3 for 3.2.0 (published 3.0.x and 3.1.0 still contain it); no feed path, tables or columns | [decided: user 2026-10-02, design decision 17] `dba5f5c` |
| Per-org Docker sandbox, org disk, bridge, frozen profile | Removed on v3 for 3.2.0. The converter keeps the org-level `sandbox` key for the credential catch-up. Codex's and Antigravity's own CLI sandboxes are different and stay | [decided: user 2026-10-02] `3f379f4`, `ab95345` |
| Orgtree v1 import | Deprecated: the App settings Import tab is gone; the engine's import routes are still present, pending removal. The 2.x first-launch conversion stays | [decided: user 2026-09-29] `e2a112f` |
| SQLite as primary storage | Replaced by PostgreSQL in 3.0. SQLite remains for side stores (transcript records, chat-window index, the mail hub) and for converting 2.x data | [decided: user 2026-09-25] |
| A Rust port of the engine | Deferred, not ruled out; one consolidated backlog ticket and the store branches are kept | [decided: user 2026-09-27, 2026-09-28, 2026-10-01] |
| Windows service mode | Dropped; boot start stays the scheduled-task host | [decided: user 2026-09-29] |
| A bounded pool of warm processes | Not built; warming is a user setting | [decided: user 2026-09-26] |
| A separate "Orgtree Private Alpha" app identity | Dropped: v3 installs as normal Orgtree over 2.x | [decided: user 2026-09-28] |
| Design rev 5's `org_topology` lock row | Withdrawn in rev 7.8 (it broke the lock order) | [decided: design rev 7.8] |
| A seat table / one "head" per lineage | Withdrawn in rev 6: one `agents` row per node | [decided: design rev 6] |
| A stored "Sent tail" key on mail rows | Withdrawn in rev 7.5: the reader computes it | [decided: design rev 7.5] |
| Archived docket totals in agents' list calls | Removed: only with `include_archived` | [decided: user 2026-10-02, decision 21] |
| A 2.1.13 hotfix for the 2.1.9–2.1.12 lost-save bug | Not made: the fix is v3 only | [decided: user 2026-09-27] |

## Where the detail lives

- **Start here:** [`pg-data-model-design.md`](docs/state-system/pg-data-model-design.md) (the
  3.2.0 design, every finding and decision), [`machine-traps.md`](docs/machine-traps.md),
  [`worktree-operations.md`](docs/worktree-operations.md),
  [`known-failures.md`](docs/known-failures.md) (the baseline and the import-provenance
  trap), [`engine-contract.md`](docs/engine-contract.md) (desktop–engine transport, tokens,
  attach), [`v2-user-decisions.md`](docs/v2-user-decisions.md) (user decisions up to
  2026-09-15; newest entry wins).
- **3.2.0 data model** (`docs/state-system/`): `pg-o1-move.md` (the O(1) move),
  `pg-step6-record-feed.md` (the record feed), `pg-columns-audit.md` (measured costs on the
  live copy), `docket-bounded-readers.md`, `org-enum-inventory.md`,
  `pg-o1-scope-consumers.md`; conversion and runtime in `pypg-cutover-runbook.md`,
  `pypg-cutover-verification.md` and `pypg-packaged-runtime.md`.
- **Engine behaviour:** `agent-halt.md`, `mail-delivery-boundaries.md`,
  `frozen-turn-lifecycle.md`, `mcp-connection-recovery.md`, `assistant-message-identity.md`,
  `foreground-tree-api.md`, `startup-budget.md`, `scope-diagnostics.md`,
  `provider-capability-evidence.md`, `antigravity-provider-parity.md`,
  `copy-title-surfaces.md` (all in `docs/`).
- **Process and release:** `verification-recipes.md`, `windows-release.md`, `dev-builds.md`,
  `update-rehearsal.md`, `mailhub-sync.md`, and the release notes (latest
  `release-notes-3.1.0.md`).
- **History** (v1/v2 era; do not use for current behaviour): `v1-parity-inventory.md`,
  `v2-acceptance.md`, `v2-import*.md`, `v2-original-design-brief.md`,
  `supplied-design-decisions.md`, `alpha-6-handoff.md`, `performance-2026-09-09.md`,
  `private-alpha-packaging.md`, `engine/docs/state-access-rearchitecture.md`.

**Stale statements to ignore** (each superseded as shown):

- `docs/known-failures.md` tells every agent to run `compare`: only the coordinator or
  release owner does (user 2026-09-26).
- `docs/verification-recipes.md` shows a bare `python -m unittest` for backend tests: use
  `tools/run-python-verification.py`.
- `docs/worktree-operations.md`: `--base` defaults to `main`; pass
  `--base origin/v3/3.0.0-alpha.0`.
- `docs/engine-contract.md` predates PostgreSQL and the account system. It is still right
  for transport, tokens and attach, but the app does elevate (through UAC) when the user
  changes the Run-as-administrator setting, and an explicit Quit stops an attached engine.
- `engine/README.md` describes an `ORGTREE_V1_ROOT` launch input that the desktop no longer
  provides.
- `docs/state-system/pypg-packaged-runtime.md` speaks of an "external cutover", and
  `postgresql-qualification.md` of PostgreSQL "not adopted": both are superseded by the
  automatic first-launch conversion.
- `docs/v2-user-decisions.md` and `engine-contract.md` name a GitHub prerelease channel:
  public releases are normal releases.
- `docs/v3-qualification.md` and `synthetic-migration-harness.md` exercise the SQLite-era
  layout, not the per-org databases.
