# Orgtree on PostgreSQL, built for it from the ground up: target design (rev 3.1)

Docket item: `v3-storage-keep-indexed-fields-in-real-postgresq` (drag-opus, 2026-10-02).

This is the target design. The user approved rev 3 on 2026-10-02 (decision 12 on the item), with
one condition. review-sol (Sol 6.1, effort max) reviews this design before the build starts, and
reviews the implementation again before the local alpha build. The companion
[`pg-columns-audit.md`](pg-columns-audit.md) measures today's costs on a copy of the live data.

**What changed:**

- **Rev 3.1 is rev 3 plus the answers** (rev 3 is commit `9cfb8b1`). It adds the user's answers to
  Q9 and Q12 and the coordinator's rulings on Q10 and Q11, and what follows from them. Nothing
  else in the design changed. Sections touched:
  - §0 summary, §1 constraints;
  - §2.2 and §2.10–§2.13 (the `unavailable` org state, the admin connection, `max_connections`,
    migration failures, retry);
  - §2.4 (the turn queue is live; requests reach the process that owns a turn);
  - §2.5 (the screen feed carries the changed records);
  - §2.7 (every polling loop becomes a job);
  - §2.9 (the second engine process);
  - §4 (the mapping table);
  - §5 (a failed org no longer stops the start);
  - §6 (the release scope and landing order);
  - §7, §8.2, §9, §10.
- **Rev 3 replaced rev 2** (commit `833f6a2`). It followed decision 10 (one PostgreSQL database per
  org, plus a minimal shared app database) and decision 11 (adding or deleting a whole org is adding
  or dropping one body of data).
  - **Kept from rev 2:** the ground-up architecture (decision 7), the table design and the
    conversion checks.
  - **Changed in rev 3:** where the tables live, and everything that follows from it: connections,
    migrations, the screen feed, jobs, cross-org reads, the org lifecycle, the conversion and
    multi-process.

**Answers already given:**

| Question | Answer |
|---|---|
| Q1 | one JSON column per shapeless payload that nothing filters inside |
| Q2 | `timestamptz` |
| Q3 | keep the old data for one release |
| Q4 | `numeric` for mixed numbers |
| Q5 | stages land on v3 one at a time |
| Q6 | surrogate keys and tombstones |
| Q7 | a dedicated schema; with a database per org this becomes "dedicated databases" |
| Q8 | change log kept 24 h, and at least 10,000 revisions |
| Q9 (user) | **everything at once.** 3.2.0 converts the data and also ships the live turn queue with leases, a second engine process, a renderer that applies changes without refetching, and every remaining polling loop moved to jobs (§6.1) |
| Q10 (coordinator) | only the org-lifecycle module gets the admin connection, and only inside the engine host (§2.11) |
| Q11 (coordinator) | `max_connections` 100, written by the custodian for fresh installs and upgrades (§2.11) |
| Q12 (user) | **start without the failed org.** The converted orgs start. The failed org is shown as unavailable with the reason and can be retried later. Its old data stays untouched (§2.13, §5.2) |

Decision 6 still stands: no build or publish until the whole data-model rewrite is in, apart from
the local alpha. Decision 9: the release line is 3.2.0, and the local alpha build is
3.2.0-alpha.0.

## 0. Summary

**Layout** (§2.10):

- **One database per org** (`orgtree_org_<n>`). It holds everything the org owns: agents, docket,
  mail, questions, audiences, watchdogs, documents, reservations, logs, its change log, its jobs,
  and the org-owned rows that today sit in machine-level side files (reply events, file
  deliveries).
- **One small app database** (`orgtree_app`). It holds only what cannot live in any org's database:

  | Table | Holds |
  |---|---|
  | `orgs` | the registry of orgs and their databases |
  | `accounts` | the machine-wide billing accounts, their limit marks and spend |
  | `turn_tickets`, `turn_admission` | the machine-wide fair turn queue |
  | `engine_instances` | engine processes, for leases |

  An org's whole footprint there is its registry row, plus its tickets and its org-key account rows
  while they exist. All of them are removed in the same step as the org.
- **Importing an org** is creating one database and adding one registry row. **Deleting** it moves
  that database and the org's folder to the trash; purging the trash drops them (§2.13).

**Architecture** (unchanged from rev 2):

- PostgreSQL is the only source of truth.
- Each action is one short transaction over only its rows.
- Integrity is enforced by the database.
- Partial indexes keep history out of hot paths.
- Turn admission and background work are `SKIP LOCKED` queues.
- A numbered change log drives the screen feed.
- Code is split into domain modules.
- The engine is stateless.

**One data migration.**

- On upgrade, the engine creates the app database and one database per org.
- It converts each org from today's layout and reads everything back.
- An org that does not convert, or does not match on read-back, is left out (Q12). It shows as
  unavailable with the reason and can be retried. The other orgs start. Only a failure that no org
  can run without (the app database, the accounts) still stops the start.
- Today's database is not modified at all, so rolling back to 3.1.0 is "run 3.1.0 again" (§5.3).
- A 2.1.14 install takes the same path after the existing first-launch import. That import now
  holds back only the org that fails, instead of refusing every org (§5.1).

**What ships in 3.2.0: everything** (Q9, §6.1). That means the new data model, plus the live turn
queue, a second engine process, a screen feed the renderer applies without refetching, and jobs in
place of every polling loop.

**What the move to one database per org costs** (measured on my dev cluster, §8):

| Cost | Value |
|---|---|
| Opening a connection | ≈17 ms |
| Memory per idle connection | ≈4 MB private |
| Creating an empty database | 0.63 s |
| Dropping a database | 0.26 s |
| Dumping one org / restoring it | 2.2 s / 5.7 s |
| Every org-internal lookup and write | the same as in rev 2's prototype, re-measured inside a dedicated database |

## 1. Starting point and constraints

- **Today.** One PostgreSQL database (`orgtree`), with one schema per org (`org_<n>`) holding five
  key+JSON tables and 18 trigger-kept side tables, plus `public.orgs`, `public.receipts` and the
  migration bookkeeping. Around it sit machine-level files:
  - `accounts-registry.json`, `app-settings.json`;
  - `reply-events.sqlite3`, `file-deliveries.db`, `chat-window-index.sqlite3`;
  - the mail hub's folder;
  - each org's marker in `orgs/` and its workspace and scratch folders.
- **The user's rules** (decisions 2–11). Foreign keys for many-to-one; link tables for many-to-many;
  no embedded lists; a normalized design. Conversion from v3.0.9 and from v2.1.14, rehearsed on
  real data. No build or publish until the rewrite is in, apart from a local alpha after the first
  prototype. The ground-up architecture. One database per org and a minimal app database, with an
  org being one body of data.
- **Hard constraints.**
  - Old data must not be lost.
  - A check that fails stops what it covers, with a clear reason. One org's failure keeps that org
    from starting while the others start (Q12). A failure in the app database or the accounts
    stops the whole start.
  - The 2.1.14 first-launch importer (`tools/pypg/pgimport.py`) writes into today's layout.

## 2. Target architecture

### 2.1 The unit of work: one short transaction per action, inside one org

Every operation (an API call, an agent tool call, a job) is a function in a domain module. It runs
in one transaction **on its org's database**:

```python
def move_agent(t: OrgTx, agent: AgentRef, new_parent: AgentRef | None, actor: Actor) -> MoveResult:
    a = t.agents.lock(agent)                 # SELECT … FOR UPDATE on the rows it will change
    p = t.agents.get(new_parent)
    rules.check_move(a, p, actor)            # the business rule, in Python, on these rows only
    t.agents.set_parent(a, p)                # UPDATE agents SET parent_id = …, row_version + 1
    t.feed.changed("agent", a.id)            # appended to `changes` at commit (§2.5)
    return MoveResult(...)
```

- **`OrgTx`** is a transaction (READ COMMITTED) on a connection from that org's pool (§2.11).
- **Committing** bumps the org's revision and writes the change-log rows.
- **Retries.** Serialization failures and deadlocks retry the whole function. Functions are pure
  apart from the database, as `org_tx_call` already requires.
- **Idempotency.** Operation keys (today `public.receipts`, keyed by org) move into the org's own
  database.
- **Locks are taken in one order:** agents by id, then items by id, then mailboxes, then other rows.
- **Business rules stay in Python** and run on the rows the function read. Rules over sets
  (ancestry, free credits, docket access) ask the org database (§2.6).

**No transaction ever spans two databases.** The few actions that touch two (cross-org mail,
starting a turn) are written as two steps. The first step records the intent durably, and the
second is an idempotent job (§2.7). Nothing relies on both commits happening together.

### 2.2 Integrity enforced by the database

| Rule | How (inside one org database) |
|---|---|
| Every link points at a real row | foreign keys. The database itself scopes everything to the org, so keys carry no `org_id` |
| Valid statuses and kinds | `CHECK (… IN …)` on every enumerated column |
| Agent names unique | `UNIQUE (name) WHERE state <> 'deleted'`. A deleted agent keeps a tombstone row, so historical references stay valid keys (§3.0) |
| Docket slugs unique and never reused | `UNIQUE (slug)` + `retired_slugs(slug)`, checked in the create transaction |
| No overlapping reservations | `UNIQUE (resource) WHERE state = 'held'` (today's rule), `UNIQUE (integration_key)` |
| No loop in the tree | a statement-level constraint trigger on `agents` when `parent_id` changes: walk up from the new parent (at most the tree depth, 6 today) and raise on meeting the moved row. It refuses; it derives nothing. |
| The database belongs to this org | a one-row `org_identity(org_uuid, slug)` table. The engine compares it with the registry row on every pool open, so a database restored under the wrong name is not served: the org becomes `unavailable` (step `identity`, §2.13). |
| Counts and sequences sane | `CHECK`s |

Across databases, integrity is by construction. The app database never holds org content, so there
is nothing to keep consistent with it except the registry row and the small references listed in
§2.10. All of those are deleted with the org.

### 2.3 History costs nothing

Partial indexes cover active rows only:

| Table | Active rows indexed |
|---|---|
| agents | live |
| docket items | open (`archived_at IS NULL`) |
| mail | not yet delivered |
| jobs | queued |
| questions | open |

Archived rows are reached only by key, or by `LIMIT`ed index ranges. The tests seed 10× history and
require the same statement counts and rows read (§9).

### 2.4 Concurrency

- **Inside an org:** row locks on exactly the rows an action changes or decides on, plus
  `row_version` compare-and-set on every mutable row. The docket's visible `rev` stays its own
  column.
- **Across orgs: turn admission.** Today `turnslots.FairSlots` is in memory: at most 16 turns at
  once across all orgs, first come first served within an org, round-robin across orgs. This is
  the one scheduling decision that is machine-wide by definition, so it lives in the app database:
  - `turn_tickets` holds one row per waiting or running turn (org, agent, lane, enqueued_at,
    state, lease owner, lease_until), with `UNIQUE (org_id, agent_id) WHERE state IN ('waiting',
    'running')`.
  - The admitting function locks the single `turn_admission` row (the limit and the org served
    last), counts running tickets, and picks the next waiting ticket in fair order with
    `FOR UPDATE SKIP LOCKED`. It marks the ticket running, with a lease.
  - The engine process running the turn renews the lease. A crashed process's lease expires and
    frees the slot.
  - This queue is live in 3.2.0 (Q9): `turnslots.FairSlots` is removed, with the same limit and
    the same fairness.
- **Starting a turn takes two steps.** The org transaction that decides an agent should run writes a
  `start_turn` job in the org database. The job inserts the ticket in the app database: `INSERT …
  ON CONFLICT DO NOTHING` on the unique key, so a retry never queues twice.
- **Interrupt, halt and retire** cancel the ticket in the same idempotent way. Today's
  `wake()`-after-cancel calls disappear.
- **Requests reach the process that owns the turn through the database.**
  - Mid-task mail is already pulled by the running turn: its hook calls the engine's steer door,
    or the lane's own loop asks in-process. Both read the pending rows from the org database, so
    any process can serve them.
  - An interrupt, halt or retire must act on the provider process itself. It is written as the
    ticket's new state and announced with `NOTIFY turn_tickets` in the app database. The process
    named in `lease_owner` stops the provider process it started.
  - Nothing depends on a request reaching the right process directly.
  - Per-turn memory that today lives in `supervisor.state(slug, nid)` stays in the owning process
    only while it is a cache. Anything another process must see becomes a row.

### 2.5 The change log and the screen feed: per org database

- **Each org database has `changes(rev, pos, entity, entity_id, op)`** and a one-row
  `org_revision(rev)`. A transaction takes the revision row's lock **last**, just before commit. So
  revisions are handed out in commit order with no gaps, and the lock lasts only the commit.
- **`NOTIFY` is per database**, which suits this layout. Each org's transactions send
  `NOTIFY org_rev, '<rev>'` in their own database.
- **Listening.** An engine process holds one `LISTEN` connection per org it is actively serving: an
  org with a desktop client watching it, or with agents running in that process. The engine host
  (§2.9) pushes frames to that org's websocket clients.
- **Frames carry the changed records (Q9).** For each new revision, the host reads the changed
  records once, by id, with the same targeted reads the screens use. It pushes one frame:
  `{rev, changes: [{entity, id, op, record}]}`. A deleted record carries no body. The renderer
  applies the frame to its store with no refetch, and no screen polls any more.
- **Catching up.** A client that sees a gap, or reconnects, calls
  `GET /api/orgs/{slug}/changes?after=N`. It returns the same frame shape: every record changed
  after N, once each, in its current state. A client older than the retention window does one full
  load.
- **Who sees what.** The desktop is the user, who can read everything in the org. Any other
  audience of the feed receives only the records its own reads would return. For the docket, that
  is the access rule.
- **The org list** (orgs created, deleted, renamed, unavailable) is the app database's own feed:
  `NOTIFY app_orgs` from the registry transactions, and one listener per engine process.
- **This replaces** the per-process frame `rev` (`api._sync_revs`), the coalesced `changed`
  broadcast, and the whole-tree rebuild after every commit (1.2–1.45 s on the live copy today).
- **Retention:** 24 h, and at least the last 10,000 revisions (Q8), pruned by a job in each org.

### 2.6 Targeted reads, and reads that cross orgs

**Inside an org,** every screen and agent read is one or a few indexed queries, never a whole-org
load (rev 2 §2.6, unchanged):

| Read | How | Cost |
|---|---|---|
| Docket list | the access rule as SQL with the list-order index | 0.2–1.6 ms in a dedicated database (§8) |
| Header counts | `count(*)` over the active partial indexes | |
| Per-turn prompt | only the agent's neighbourhood: its row, at most 6 ancestors, children, peers, its chain's free credits, its open questions and audiences | |
| Lineage | a recursive query over `predecessor_id` | |

**Across orgs,** a read is a fan-out: one targeted query per org database, run in parallel through
each org's pool and merged in Python. There are three such reads today.

| Read | Today | Rev 3 |
|---|---|---|
| `GET /api/accounts` (which agents are bound to which account) | loads every org's whole document and walks every agent (audit §3.4) | per org: `SELECT account, count(*) FROM agents WHERE state = 'live' AND account IS NOT NULL GROUP BY account` (partial index), merged with the `accounts` rows from the app database |
| `GET /api/orgs` (the org list with summary counts) | the registry and per-org summaries | the registry from the app database, plus one summary query per org (live agents, open items, unread mail, all by partial index) |
| `list_orgs_with_docs` (public and bridge traffic, 5 s TTL) | loads every org | the registry plus the needed per-org columns |

**Cost** (measured, §8): about 0.05 ms per query once a pool connection exists, and about 17 ms per
org whose pool is cold, in parallel. With 4 orgs that is under 2 ms warm and about 20 ms cold. With
50 orgs: about 3 ms warm, about 100–200 ms cold, bounded by a fan-out concurrency of 8.

### 2.7 Background work as job rows, per org database

Each org database has `jobs(id, kind, agent_id, item_id, watchdog_id, run_at, state, attempts,
lease_owner, lease_until, last_error, dedupe_key)`. It has a partial index on queued jobs by
`run_at`, and `UNIQUE (kind, dedupe_key) WHERE state IN ('queued', 'running')`.

- **Who writes a job:** the org transaction that creates the condition. Examples:
  - a deposit to an idle agent → `deliver`;
  - a freeze → `resume` at its until-time;
  - a watchdog → its next `check`;
  - a "working" status → `checkup` at +20 min;
  - an archivable item → `archive` at its deadline;
  - a decision to run an agent → `start_turn` (§2.4);
  - a cross-org mail → `deliver_external` (below).
- **Who runs it.** Each engine process runs a scheduler per org it serves.
  - It keeps the org's next due time from `SELECT min(run_at) … WHERE state = 'queued'`, and wakes
    on that time or on `NOTIFY org_jobs` from the org database.
  - It claims due jobs with `FOR UPDATE SKIP LOCKED … ORDER BY run_at LIMIT n`, leases them, and
    runs each as its own org transaction.
  - Several processes can schedule the same org: `SKIP LOCKED` hands each job to exactly one.
- **Orgs nobody is serving** (no desktop client, no running agent) still have due jobs: a freeze
  ending, a watchdog. A slow sweep reads `min(run_at)` from every registered org: one cheap query,
  every 60 s. It starts serving an org whose next job is due within the sweep interval. Idle orgs
  therefore cost one connection-minute check, not a held connection.
- **Cross-org mail** (`@org:<slug>`) already happens in two separate writes today. The sender's org
  transaction records the outgoing row; then `supervisor.deliver_org_inbox` writes the receiver.
  Here:
  1. The sender's transaction writes the outgoing row and a `deliver_external` job, in the sender's
     database.
  2. The job inserts into the receiver's `org_inbox`, keyed by the message's global id
     (`UNIQUE (message_id)`, so a retry is a no-op).
  3. The job marks the sender's row delivered.

  This needs no shared table.
- **What jobs replace: every polling loop, in 3.2.0 (Q9).** The supervisor loops of audit §3.4:

  | Loop today | Job |
  |---|---|
  | auto-resume, every 30 s per org (decodes every agent) | `resume` at each freeze's until-time; `start_turn` from the transaction that makes an agent runnable |
  | working-cache keeper, every 20 s (abandoned docket items, idle reminders, checkup and keepalive) | `archive`, `remind` and `checkup` at their own due times, written by the transaction that sets them up |
  | watchdog engine, every 5 s | each watchdog's next `check` |
  | storage watchdog, every 20 s | a `storage_check` that requeues itself, only for orgs that have a storage limit (kiosk and sandbox orgs). Disk use changes outside the database, so this one stays periodic, as a job |
  | mail drain, every 1 s or when kicked | `deliver` from the transaction that deposits the mail |
  | docket reminder scans, retries | `remind`, and a retry `run_at` on the failed job itself |

  The renderer's polling (the tree about every 6 s, the desk chat, notifications every 5 s) is
  replaced by the feed (§2.5).

  Timers that read state outside Orgtree (provider usage, update checks, the mail hub) are not
  database polling and have no due time in any org. They stay timers in the engine host, which is
  one process (§2.9). The stage that moves the loops lists every remaining timer and why it stays.

### 2.8 Domain modules

| Module | Owns |
|---|---|
| `agents` | tree and lifecycle, scope and grants, lineage |
| `docket` | items, access, list, update, reviews, archive |
| `mail` | mail, mailboxes, notices, delivery, steer records, user mail, org inbox, cross-org delivery jobs |
| `questions` | asks, credit and scope requests |
| `audiences` | grants and requests |
| `watchdogs` | dogs and their events |
| `documents` | presentations |
| `reservations` | reservations |
| `scheduling` | org jobs, the scheduler, turn tickets |
| `feed` | the change log and catch-up |
| `org` | settings, tiers, kiosk, net |
| `registry` (new, app database) | org lifecycle, accounts, engine instances |
| existing provider modules | provider and usage logic |

Each module owns its tables. Others call its functions inside the same transaction, never its SQL.
The ledger's rules move into the modules. Today's behaviour suites are the contract for each move.

### 2.9 Stateless engine, several processes, large texts out of hot rows

- **No process holds org state.** Caches are allowed only when keyed by `(org, rev)` and dropped
  when that org's feed moves past them.
- **Several engine processes coordinate only through the databases:**
  - **Row locks and `SKIP LOCKED`** inside org databases.
  - **The app database** holds the turn tickets, the `engine_instances` heartbeats that leases
    refer to, and the registry state, which every process watches through `NOTIFY app_orgs`.
  - **Turn processes** (provider CLIs) are owned by the engine process that started them. Their
    ticket records the owner and lease, so no second process starts a second turn for that agent,
    and a dead owner's tickets expire.
- **Each process has its own pools** (§2.11). With P processes the connection budget is P times the
  per-process one.
- **The two processes of 3.2.0 (Q9).** Today one engine process holds the data root's owner lock
  (`claim_data_root`), serves the loopback port and runs everything. In 3.2.0:

  | | Engine host (process 1) | Worker (process 2) |
  |---|---|---|
  | Started by | the desktop or the boot host, as today | the engine host, as its child; it exits when the host exits |
  | Data root owner lock | holds it | does not take it |
  | Loopback port, HTTP, websocket, agents' tool calls | serves them | none |
  | Admin connection (Q10) | the org-lifecycle module only | never |
  | Per-org schedulers and jobs | runs them | runs them |
  | Admits and runs turns | yes | yes |
  | Timers for outside state (§2.7) | runs them | none |

  - Both processes are registered in `engine_instances` with a heartbeat. Work is shared only
    through `SKIP LOCKED` and leases.
  - If the worker dies, the host restarts it. Its leases expire, so its jobs and tickets go back
    to the queue, and the host takes them meanwhile.
  - The design allows more workers; 3.2.0 runs exactly one.
- **Large texts** (charters, descriptions, mail and document bodies, steer texts) live in one-to-one
  content tables, and provider JSON payloads in `agent_runtime`. Hot rows stay about 200 bytes.
  Transcripts stay on disk in the org's folder.

### 2.10 One database per org, and a minimal app database

**Names.** `orgtree_app` is the app database. `orgtree_org_<n>` is one database per org; `<n>` is
the registry's `org_id`, so a rename never renames a database. Today's `orgtree` database becomes
the frozen legacy store: it is not modified, and is dropped one release after conversion (§5.3).

**The app database holds exactly these tables.** For each, why it cannot live in an org's database:

| Table | Holds | Why it cannot be per-org | Org footprint |
|---|---|---|---|
| `orgs` | `org_id`, `slug` (`UNIQUE … WHERE state <> 'trashed'`, so a trashed org's name can be reused as today, and a restore picks a free name if it was), `org_uuid UNIQUE`, `database UNIQUE`, `state CHECK (provisioning, converting, active, unavailable, trashed, purging)`, `unavailable_step CHECK (import, conversion, migration, identity)` (set only while `unavailable`), `state_reason` (one line for the org list), `report_path` (the full report under `<data>/conversion/`), `attempts`, `attempted_build`, `state_at`, `created_at`, `trashed_at` | The engine must find an org's database before it can open it. A row inside the org's own database cannot answer "which database is org X". | one row |
| `accounts` | `id` (the stable account slug), `provider`, `harness`, `credential_ref` (a path or token-store reference, never key material), `mode`, `enabled`, `tint_ordinal`, `origin_org_id` → orgs (`ON DELETE CASCADE`), plus `account_marks(account_id, pool, until, window, observed_at, provenance)` and `account_spend(account_id, usd_total, turns, since, updated_at)` | `registry.py` defines accounts as "machine-global, every provider together". One account serves agents in every org. A limit mark set by a turn in org A must stop turns in org B, and spend is metered machine-wide. Today this is `accounts-registry.json`; it moves here so several processes can update marks and spend in transactions. | org-key account rows (legacy org keys bound to one org) |
| `turn_tickets`, `turn_admission` | the machine-wide fair queue (§2.4) | the slot limit and round-robin fairness are defined across orgs | transient tickets (`ON DELETE CASCADE`) |
| `engine_instances` | `id`, `host`, `pid`, `started_at`, `heartbeat_at` | a process is not owned by any org; leases in every database refer to it | none |
| `schema_migrations` | the app database's own migrations | bookkeeping | none |

**Deliberately not in the app database:**

| What | Why not |
|---|---|
| Provider usage readouts | caches of provider answers, kept in memory as today; not data that must exist |
| Cross-org mail routing | the sender's and receiver's databases plus an idempotent job (§2.7) are enough |
| Operation receipts | move into each org's database. Org creation and deletion are idempotent by slug and registry state |
| `app-settings.json` | stays a file. It is written rarely, by the UI, and read on change |
| Credentials | stay in their profile folders, never in a database |
| The mail hub's store | separate infrastructure, unchanged |
| `chat-window-index.sqlite3` | stays a per-machine cache (it is rebuildable). Its keys include the org's `org_uuid`, so a purged or re-imported org can never read another's cache |
| `reply-events.sqlite3`, `file-deliveries.db` | **move into each org's database**: they are org-owned durable records keyed by org and agent, and decision 11 makes an org one body of data |

**An org's whole body** is therefore its database plus its folder (workspace and scratch,
including transcripts). Its registry row, org-key accounts and live tickets are the only traces in
the app database, and the org lifecycle removes them in the same step (§2.13).

### 2.11 Connections

**Measured** on my dev cluster (§8):

| Fact | Value |
|---|---|
| Opening a connection, first query included | 16.7 ms median |
| An idle backend | 4.2 MB private memory (19.8 MB working set, mostly shared pages) |
| `max_connections` | 40, on both my cluster and the live one (`instance.json`) |

**Pools.** One small pool per org database per engine process, opened lazily on the org's first use
and closed after 10 idle minutes:

- 0 connections while idle;
- 1 kept while serving;
- at most 4.

Plus one `LISTEN` connection per org the process actively serves (§2.5), and one pool plus one
listener for the app database.

**Budget:**

| Situation | Connections |
|---|---|
| Today's 4 orgs, all active, one process | about 4 × (1 listener + 1–2 pooled) + 2 for the app database = 10–14 |
| A heavy day: 10 active orgs, 2 processes | up to 2 × (10 × 3 + 2) = 64, which needs `max_connections` raised |

An idle org costs nothing. With 3.2.0's two processes (§2.9), today's 4 orgs use about 20–28.

**`max_connections` is 100 (Q11, decided).** The custodian writes it into the cluster settings it
owns, for fresh installs and on upgrade. Memory cost: about 4 MB private per backend, so 0.4 GB at
the full 100. The engine enforces a global per-process cap and queues requests for a connection
rather than failing.

**The admin connection (Q10, decided).** Creating, renaming and dropping databases needs the
cluster's admin role; the runtime role cannot do it.

- The engine host opens the admin connection and gives it only to the org-lifecycle module.
- That module does create, trash and restore (rename), purge (drop), import (restore), the
  conversion's database creation, and the migrations of the app and org databases.
- No other module, and never the worker process, holds it.
- A source scan test fails if any other module reads the admin URL or opens that connection.

### 2.12 Migrations, once per database

- **The app database** has its own migration folder (`pg_migrations/app/`), applied by
  `pgstore.migrate` at start exactly as today: one transaction per file, an advisory lock, and drift
  refusal.
- **Every org database** has the org migration folder (`pg_migrations/org/`). Each org database
  records its own `schema_migrations`.
  - At start, the engine migrates every registered `active` org, one org at a time, each file in
    its own transaction under that org's advisory lock.
  - An org created later is born at the current level.
  - An org whose migration fails becomes `unavailable` (step `migration`), with the reason, and the
    other orgs start (the Q12 rule, applied to migrations too). The failed file rolled back, so
    its database stays exactly at its last good level. It is retried as in §2.13.
  - A failure of the **app** database's migrations still refuses the start: no org can run without
    it.
- **A partly migrated set is safe by construction.** Every org database is always at exactly one
  migration level: each file commits in its own transaction, and its row in `schema_migrations`
  commits with it. So a crash between orgs leaves some orgs at N+1 and others at N, and the next
  start finishes the rest. The engine never serves an org whose level differs from the one it
  expects:

  | Org's level | What the engine does |
  |---|---|
  | lower than expected | migrates it before serving |
  | higher than the engine knows (a newer build ran) | does not serve it: `unavailable` (step `migration`, "written by a newer Orgtree"), with the other orgs starting. The app database at a newer level still refuses the start (`MigrationDrift`, as today) |

### 2.13 The org lifecycle, end to end

Every step is idempotent and driven by the registry's `state`. A crash at any point is finished by
the next start, which finds the row in its intermediate state.

**Create** (≈1 s; measured: `CREATE DATABASE` 0.63 s, plus the schema):

1. App transaction: insert the registry row (`provisioning`, new `org_id`, `org_uuid`, database
   name). `UNIQUE (slug)` makes a retried create a no-op.
2. `CREATE DATABASE orgtree_org_<n>`, through the admin connection that only this module holds
   (Q10, §2.11).
3. Org transaction: apply the org migrations, insert `org_identity(org_uuid, slug)` and the
   org's default settings, and grant the runtime role its rights.
4. App transaction: `active`; `NOTIFY app_orgs`.
5. Create the org's workspace folder.

**Delete (to the trash, reversible as today).** Today's `delete_org` renames the org's file into
`<data>/deleted/`, and putting it back is the restore. In rev 3:

1. App transaction: `trashed`, `trashed_at`; `NOTIFY app_orgs`. Every process closes the org's
   pools and listeners.
2. The org's turn tickets are cancelled. Its org-key accounts are disabled; they stay attached to
   the trashed org until purge.
3. The org's folder moves into `<data>/deleted/<slug>-<stamp>/`.

The database itself stays. Once its connections are closed it is renamed to
`orgtree_trash_<n>_<stamp>`, so its name shows its state and the slug is free for a new org, as
today. A crash after this step is completed at the next start, from the registry state.

**Restore:** reverse the rename and the folder move, then `active`.

**Purge** (empty the trash):

1. `purging`.
2. `DROP DATABASE … WITH (FORCE)` (0.26 s, measured).
3. Remove the trash folder.
4. Delete the registry row, which cascades the org-key accounts and any tickets.

After purge nothing of the org remains.

**Export** (≈2–3 s for the largest org, measured):

1. `pg_dump -Fc` of the org database: 2.2 s for the live org's tables, 25 MB.
2. Plus the org's folder.
3. Plus a manifest:
   - `org_uuid`, slug and schema level;
   - per-table counts and checksums;
   - the org-key account rows;
   - the account ids its agents are bound to.

The existing human-readable `export_json` stays, built from queries.

**Import / move** (≈6–8 s for the largest org, measured):

1. Read the manifest. If the `org_uuid` is already registered, refuse, or import under a new slug
   with a new uuid if the user chooses. Pick a free slug and database name.
2. Registry row `provisioning` → `CREATE DATABASE` → `pg_restore` (5.7 s measured for the live
   org).
3. Migrate the org database forward if its level is older; refuse it if newer.
4. Check the counts and checksums against the manifest, and `org_identity` against the registry
   row.
5. Restore the folder.
6. Recreate the org-key accounts.
7. Report the account ids bound in the org but unknown here. Those agents show as unbound and fall
   back by the existing rules; nothing is silently rebound.
8. `active`.

**Unavailable, and retry (Q12).** An org becomes `unavailable` when one of four steps fails for it:

| Step | What failed |
|---|---|
| `import` | the 2.1.14 first-launch import held it back (§5.1) |
| `conversion` | converting or reading it back (§5.2) |
| `migration` | an org migration, or its database is newer than the build (§2.12) |
| `identity` | its `org_identity` does not match its registry row |

What happens then:

- **Its old data stays untouched.** A failed conversion drops only the half-built new database. The
  legacy schema and the old files are never written. A failed migration rolls back its file.
- **The other orgs start and run normally.**
- **What the user sees.** The org list shows the org as unavailable, with the one-line reason and
  a **Retry** action. The full report (org, step, kind, record, field, both values) is in
  `<data>/conversion/<time>-<pid>/`, and the org list links to it. Nothing else opens the org.
- **Its traces elsewhere.**
  - Its turn tickets are cancelled.
  - Mail sent to it from another org waits in the sender's outbox as a `deliver_external` job that
    backs off (1 minute, doubling, at most 1 hour) until the org is `active`.
  - `/api/accounts` and `/api/orgs` list it as unavailable instead of counting its agents.
- **Retry** runs the failed step again for that org alone, from the untouched old data:
  - `import`: the per-org import from `pre-postgres/orgs/<slug>.db`, then the conversion;
  - `conversion`: the conversion from the legacy schema;
  - `migration`: the pending migrations;
  - `identity`: the check again.

  If it succeeds, the org becomes `active` and starts. If not, it stays unavailable with the new
  reason, and `attempts` goes up by one.
- **When retry runs.** It runs when the user asks. It also runs once automatically when a
  different build starts (`attempted_build` differs), because the new build may contain the fix.
  It does not run at every restart.
- **What 3.2.0 does not offer** for an unavailable org: trash and purge. Its data is not in the new
  layout yet.

## 3. The schema

### 3.0 Conventions

These are rev 2's conventions, with one change: **no table in an org database carries `org_id`**,
because the database is the org.

- **Keys.** Every record table has a surrogate key, `id bigint GENERATED ALWAYS AS IDENTITY`. Visible
  names stay unique natural keys: agent `name` (today's node id), item `slug`, mail `public_id`.
  Renaming an agent is one `UPDATE agents SET name` (Q6).
- **Timestamps** are `timestamptz`, kept to the millisecond. API output keeps today's
  `YYYY-MM-DDTHH:MM:SS.mmmZ`. The 1,843 offset-stamped restart notices convert to the same instant.
- **Numbers.** `bigint`/`integer` for integers, `double precision` for floats, and `numeric` where
  stored values mix the two. For example, `grant` holds 1,198 ints and 10 floats on the live copy.
- **Absent versus null.** A `<field>_null` boolean marks a present null for the fields stored both
  ways on real data. For JSON columns, SQL `NULL` means absent and JSON `null` means null.
- **Strings containing U+0000** (17 records on the live copy) go to the record's `extra` JSON, and the
  conversion report counts them.
- **`extra json`** holds unknown top-level keys and is expected to be empty. **`row_version`** is on
  every mutable row.
- **Principals.** `<role>_kind CHECK (agent, user, engine, outside)` + `<role>_id` → agents +
  `<role>_ref` (outside address).
- **Deleting an agent** erases its own records and keeps a tombstone row (`state = 'deleted'`) for
  historical references (Q6).
- **`org_identity(org_uuid, slug)`** is a one-row table. The engine checks it against the registry
  on every pool open.

### 3.1 The app database

| Table | Columns | Notes |
|---|---|---|
| `orgs` | as §2.10 | `NOTIFY app_orgs` on every change |
| `accounts` | as §2.10 | |
| `account_marks` | as §2.10 | PK `(account_id, pool)` |
| `account_spend` | as §2.10 | PK `account_id` |
| `turn_tickets` | `id`, `org_id` → orgs `ON DELETE CASCADE`, `agent_id` (the org database's surrogate key), `agent_name` (for display), `lane`, `enqueued_at`, `state CHECK (waiting, running, done, cancelled)`, `lease_owner` → engine_instances, `lease_until` | `UNIQUE (org_id, agent_id) WHERE state IN ('waiting', 'running')`; partial index on waiting by `(org_id, enqueued_at)` |
| `turn_admission` | `singleton`, `slot_limit` (today's setting, default 16), `last_org_id` | |
| `engine_instances` | `id`, `host`, `pid`, `started_at`, `heartbeat_at` | |
| `schema_migrations` | | |

### 3.2–3.8 The org database

Every table of rev 2 §3.1–§3.8 moves into each org database **without its `org_id` column**: agents
and their cold, child and link tables; the docket; mail, notices and delivery; questions; audiences;
watchdogs; documents; reservations; events and receipts; jobs; and `changes`. Every index loses its
`(org_id, …)` prefix, and every composite foreign key becomes a plain one.

Rev 2's per-org settings table (`org_settings`, plus the lists `org_dirs`, `org_tiers` …) becomes
the org database's settings tables, unchanged apart from the key.

Additions:

| Table | Contents |
|---|---|
| `org_identity` | §3.0 |
| `org_revision(rev)` | §2.5 |
| `op_receipts` | today's `public.receipts` rows for this org, plus today's `op_receipts` log |
| `reply_events(agent_id, generation, id, text, scope)` | today's `reply-events.sqlite3` rows for this org |
| `file_deliveries(id, agent_id, fingerprint, result)` | today's `file-deliveries.db` rows for this org |
| `conversion_runs` | §5.2 |

Appendix A gives the full detail: the tables, column groups, indexes, child and link tables, the
measured reasons (the turns table, the tool lists, the access rule) and the deliberate duplicates.
It is rev 2 §3.2–§3.10 with `org_id` removed.

### 3.9 What is removed

These go:

- the 18 per-row triggers and their side tables;
- the JSON expression indexes;
- `json_extract`;
- `public.receipts`;
- the per-org schema creator chain (`orgtree_create_org_schema` and its 14 wrappers);
- the org markers in `orgs/`. The registry is the only record of which orgs exist; today the markers
  and `public.orgs` must agree.

The legacy `orgtree` database stays untouched for one release (Q3), then is dropped.

## 4. How today's code maps onto the target

| Today | Rev 3 |
|---|---|
| `store` / `pgstore`: one database, org schemas, `LazyDoc`, compare-on-save | `db.org_pool(org)` (§2.11), `OrgTx`, domain modules. During the transition, a compatibility view (the rev 1 mappers, §6.2) presents the old dictionary over one org's database for code not yet moved. |
| `orgtx.org_tx` lock plans | `OrgTx` row locks inside the org database |
| `ledger.Org` methods (≈400) | domain functions over rows. Audit §3.3 is the checklist. |
| Supervisor loops (30 s, 20 s, 5 s, 1 s) | per-org jobs + scheduler (§2.7) |
| `turnslots.FairSlots` (memory) | `turn_tickets` in the app database (§2.4) |
| `api._sync_revs`, `hub_changed`, whole-tree refetch, renderer polling | per-org `changes` + `NOTIFY`; frames carry the changed records; catch-up (§2.5) |
| `registry.py` + `accounts-registry.json` | the `accounts` tables in the app database (§2.10) |
| `reply_events.py`, `filedelivery.py` side SQLite files | tables in each org database |
| `pgfeed.RevisionFeed` (one listener) | one listener per actively served org + one for the app database |
| `store.create_org` / `delete_org` / markers / `pgstore.revive_marked` | the registry lifecycle (§2.13) |
| `GET /api/accounts`, `GET /api/orgs`, `list_orgs_with_docs` whole-org loads | fan-out queries (§2.6) |

## 5. Converting existing data: one data migration

### 5.1 One path for every starting version

| Starting point | Route |
|---|---|
| **v3.0.9, 3.1.0 and the other 3.0.x** (one database, per-org schemas) | Start the engine. It migrates the legacy database only if it is behind 0020 (0020 on 3.0.9), as every release has. **Measured:** importing at 0017 and then migrating to 0020 leaves the five base tables of all 4 orgs unchanged, and equal to an import made at 0020, by count and sha256 (`probe/v3x-states-0017.json`). So every 3.0.x and 3.1.0 state gives the converter identical input. |
| **v2.1.14** (SQLite) | The first-launch import (`tools/pypg/pgimport.py`, driven by `pg_process.convert_existing_root`) writes the SQLite rows into the legacy layout, with its counts and checksums. Then the engine starts and runs the same converter. **Rehearsed, step 1:** the user's real pre-conversion SQLite data, copied with SQLite's backup API, imported with pgimport's own code (4 orgs, byte-for-byte read-back, 39 s). The same was done with a v2.1.14 re-save of it (§5.4). |

**One change to the first-launch import, for Q12.** Today it is all or nothing:

- one refused org refuses the whole dry run;
- the cutover requires every org;
- the engine does not start, and the user is told to reinstall 2.1.14.

In 3.2.0 it holds back only the failing org:

1. The dry run's refusals are already per org (`<slug>: …`). An org with a refusal is held back;
   the others are imported (`import_root(only=…)` exists today).
2. The cutover record lists each held-back org with its reason. The cutover still moves every old
   file, held back or not, unchanged, to `pre-postgres/orgs`.
3. The converter registers each held-back org as `unavailable` (step `import`).
4. Retry imports that one file and then converts it. On success, the legacy database gains that
   org's schema; nothing already in it changes.

A failure that is not about one org still refuses the start, with today's message: the database
will not start, the importer is missing, the root is wrong.

### 5.2 The converter

It runs at engine start, after the app database's migrations, and before anything serves.

1. **Create the app database** if it is missing, and migrate it.
2. **For each org in the legacy database not yet `active` in the registry:**
   1. Registry row `converting`. `CREATE DATABASE orgtree_org_<n>`. Apply the org migrations and
      `org_identity`.
   2. Read every record of the org's legacy schema, with the heal a new build's first load applies
      today. One `REPEATABLE READ` snapshot of the legacy database; nothing in it is written.
   3. Map each record to rows (the rev 1 mappers) and `COPY` them into the org database.
      - Timestamps are parsed. One that cannot be parsed keeps its original text in `extra`, and
        is reported, never dropped (Q2).
      - Today's `public.receipts` rows for the org move into its `op_receipts`.
      - Its rows from `reply-events.sqlite3` and `file-deliveries.db` are read read-only and
        copied in.
   4. Read everything back and compare each record with step 2, as canonical JSON with exact types,
      and timestamps as instants. Count and checksum per kind. Write `conversion_runs` in the org
      database.
   5. App transaction: registry row `active`. **This is the commit point.** Before it, the new
      database is disposable.
   6. **A failure in one org** (any exception, or any mismatch in step 4) drops that org's new
      database. It writes the report (org, kind, record, field and both values) to
      `<data>/conversion/<time>-<pid>/`. The registry row becomes `unavailable` (step
      `conversion`) with a one-line reason. **The converter then goes on to the next org, and the
      engine starts with the orgs that converted (Q12).** Retry is described in §2.13.
3. **Accounts.** `accounts-registry.json` is read and inserted into the app database, read back and
   compared, in the app database's first transaction. The file is kept, untouched.
   - A failure here still refuses the start: accounts are machine-wide, and every org's turns
     need them.
   - An account bound only to an org that is unavailable is still converted, because it lives in
     the app database.

**A partly converted set** (a crash, or failures in some orgs):

- converted orgs are `active` and are skipped next time;
- orgs the crash interrupted (`converting`) are converted again from scratch at the next start;
- `unavailable` orgs wait for their retry (§2.13).

The legacy database is never written, so a retry always starts from the same input.

**Time** (inferred from the audit's decode costs, plus measured database creation): about 1 s to
create each database, 1–2 s to read and decode the largest org, a few seconds to `COPY`, about the
same to read back. Under a minute for the whole machine, once, with the existing "updating the
database" progress.

### 5.3 Old data and rollback

**Nothing old is modified.** The legacy `orgtree` database (with its `schema_migrations`),
`accounts-registry.json` and the side files stay exactly as they were. So **a rollback to 3.1.0 is
simply running 3.1.0**: it opens the legacy database it always used, and does not know the new
databases exist. Writes made after the conversion are lost, as `pgimport`'s rollback already
states. A cleanup tool drops the new databases if the user wants the space back.

One release later, the cleanup release drops the legacy database and the old side files (Q3).
It does not drop them while any org is still `unavailable` from the import or the conversion. That
org's old data is the only copy, so the cleanup keeps it and says why.

### 5.4 Rehearsals (decisions 4 and 8)

Every input is ready, built from copies in my dev cluster and recorded on the item:

| Input | Contents |
|---|---|
| 3.x | a read-only `pg_dump` of the live cluster (3.0.9 data, migrations up to 0019), restored as `livecopy` |
| 2.1.12/13 | the user's real pre-conversion SQLite orgs (backup-API copy) imported by pgimport, as `v2import` |
| 2.1.14 | the same copy loaded and saved once through tag v2.1.14's own store code, then imported, as `v2114import` |
| 3.0.x states | an import at 0017 migrated to 0020, as `v3x0017`; base tables identical to `v2import` |

The 2.1.14 input is a **synthetic re-save**, approved by the coordinator. No copy written by exactly
2.1.14 exists: the user's last v2 writer was 2.1.12/13. From v2.1.12 to v2.1.14, `store.py` and
`schema.py` do not change; `ledger.py` only adds load-time value heals. Measured, the re-save
changed exactly `models.sol` and the Sol agents' version pins (46 / 38 / 2 agents), and nothing
else.

Each rehearsal runs the converter on every input and records:

- per org and kind, counts and checksums before and after;
- heals, `extra` keys, U+0000 fields and unparseable timestamps;
- the time taken;
- the tests;
- the read and reshape benchmarks on the result.

## 6. Release plan

### 6.1 What ships in 3.2.0: everything (Q9)

The user chose to ship the whole target at once. 3.2.0 converts the data and contains every part
of decision 7. Nothing is left for a later release.

| Target point | In 3.2.0 |
|---|---|
| Schema, integrity, partial indexes; one database per org; the app database | all of it: both migration folders and every table |
| Database as the source of truth; one transaction per action | every read and write goes through domain functions. **The compatibility view is deleted before the release:** a second process must not hold org state, so no path may still use it |
| Domain modules | all of §2.8 |
| Change log + `NOTIFY` | per-org `changes` and listeners. Frames carry the changed records, and the renderer applies them with no refetch (§2.5). Every renderer poll is removed |
| Jobs | per-org jobs, schedulers and the sweep. Every polling loop of §2.7 is a job: delivery, watchdogs, cross-org mail, auto-resume, keepers, reminders, storage checks, retries |
| Turn queue | `turn_tickets` with leases replace `turnslots.FairSlots` (§2.4) |
| Several processes | the engine host and one worker process (§2.9) |
| Failed orgs | the `unavailable` state, its report and retry (§2.13) |

The compatibility view still exists during development. The first prototype (§6.2) and the local
alpha use it, with one process.

### 6.2 The first prototype (decision 8)

**Definition: the smallest slice that converts real data and runs the app on the new databases.**

1. Both migration folders (app and org) and the provisioning path (`CREATE DATABASE` per org,
   through the lifecycle module's admin connection).
2. The converter for every kind of record, the accounts registry and the two side files, with the
   read-back check and the report. One failing org becomes `unavailable` while the others convert
   (Q12). The 2.1.14 first-launch import holds back only a failing org (§5.1). Retry works.
3. The compatibility view: the storage layer loads and saves every kind of record through the rev 1
   mappers on the org's own database, through a per-org pool. All existing engine code therefore
   runs on the new databases, and the legacy database is never read again after conversion.
4. Native agents and docket modules: reshaping, tree reads, the per-turn neighbourhood, and docket
   access, list, get and counts, as targeted queries and short transactions.
5. The registry lifecycle for create, delete-to-trash and purge (used by the converter and the
   tests), and the `/api/accounts` and `/api/orgs` fan-outs. The org list shows an unavailable
   org with its reason and Retry.
6. Tests (§9) for all of the above.

The prototype runs as one process, with today's in-memory turn slots and today's frames. The other
3.2.0 parts (§6.1) follow in landing steps 4–8.

When the prototype passes:

1. review-sol reviews the implementation (decision 12).
2. The rehearsals run on every input (§5.4).
3. I report to the coordinator, who gives p03-ws4-rcfamilies the go for the local 3.2.0-alpha.0
   build.

### 6.3 Landing order on v3 (no release in between)

Each step is reviewed (`approve_stage`) before it lands.

| Step | Contents |
|---|---|
| 1 | App and org migrations, provisioning, the converter with the `unavailable` state and retry, the first-launch import's hold-back, and the compatibility view. Lands as one step, because a conversion is all or nothing per org. |
| 2 | The native agents module. |
| 3 | The native docket module, the lifecycle and the fan-outs, and the org list's unavailable entry. **This completes the first prototype:** review-sol's implementation review, the rehearsals, then the alpha build. |
| 4 | The mail and watchdogs modules with their jobs; cross-org mail jobs. |
| 5 | Questions, audiences, documents, reservations, events and org settings modules. Every remaining polling loop becomes a job (§2.7). |
| 6 | The per-org change log. Frames carry the changed records, and the renderer applies them with no refetch; renderer polling is removed. |
| 7 | The turn queue goes live: `turn_tickets` with leases and `start_turn` jobs replace `turnslots`. |
| 8 | The worker process (§2.9). The compatibility view is deleted, since no path uses it any more. |
| 9 | **3.2.0 release candidate:** final rehearsals, then the coordinator's build and publish. |

## 7. Effort and risk (inferred)

| Part | Size | Main risk |
|---|---|---|
| Two migration folders, provisioning | small–medium | the admin connection leaking past the lifecycle module (a source scan test, Q10) |
| Converter + mappers (about 40 kinds) + accounts + side files | large | a legacy shape the mapper did not foresee (that org is unavailable, never lost) |
| The `unavailable` state, retry, the first-launch import's hold-back | medium | an org left half-converted (the next start redoes `converting` orgs from scratch) |
| Compatibility view per org database | medium | a whole-collection walk left on a hot path (the growth tests catch it) |
| Native agents and docket modules | large | behaviour drift (today's suites are the contract) |
| Org lifecycle, fan-outs, listeners per org | medium | a pool or listener leak (tests count open connections) |
| Mail, jobs, the other modules | large | delivery ordering and duplicates (the custody tests stay) |
| Every polling loop as a job | medium | a condition that no transaction schedules (each loop's behaviour test must pass with the loop removed) |
| Feed frames with records; the renderer applying them | medium–large | the renderer drifting from the database (a test compares its state after frames with a full load) |
| Turn tickets with leases; the worker process | medium–large | lease handling; a turn started twice; a request that never reaches the owning process |
| Deleting the compatibility view | medium | a rare path still on it (a source scan test: no import of it remains) |

## 8. Measurements

### 8.1 What does not change

**Inside an org.** All 25 lookups and 4 writes of the rev 2 prototype were re-run inside a dedicated
database holding only the live org's prototype tables (`porg2`, restored from a one-org dump).
Results are in `probe/proto-cost-porg2.json`; the "shared tables" column is the rev 2 prototype
(`probe/proto-cost.json`).

| Lookup or write | Today (audit) | Shared tables (rev 2) | Own database (rev 3) |
|---|---|---|---|
| Re-parent 400 agents | 1,006 ms with triggers; 657 ms engine CAS | 6.2 ms | **6.4 ms** |
| Generation change on 400 agents | 1,788 ms | 5.1 ms | **4.3 ms** |
| Cost-only change on 400 agents | 717 ms | 4.3 ms | **4.1 ms** |
| Deliver 200 mails | 243 ms | 2.4 ms | **1.9 ms** |
| Children of the 483-child seat | 1.2 ms | 0.20 ms | 0.18 ms |
| Ancestors / descendants (1,145) | – | 0.23 / 3.6 ms | 0.11 / 3.1 ms |
| Live / frozen-live / halted / accounts | 0.24 / 153 / 40 / 93 ms | 0.04 / 0.07 / 0.05 / 0.03 ms | 0.06 / 0.04 / 0.04 / 0.03 ms |
| Cost total | 54 ms | 0.13 ms | 0.13 ms |
| Lineage count (62 generations) | trigger-kept | 0.19 ms | 0.16 ms |
| Docket counts by status | 1,000–1,183 ms | 0.22 ms | **0.18 ms** |
| Docket readable, first page (leaf / coordinator / user) | 58–71 ms | 0.46 / 2.1 / 0.2 ms | **0.38 / 1.6 / 0.19 ms** |
| Archived item by slug / by owner | 108 / 130 ms | 0.05 / 0.03 ms | 0.02 / 0.03 ms |
| History: events / notices | 74 / 38 ms | 0.14–0.20 / 0.07 ms | 0.13–0.24 / 0.04 ms |
| Sent, newest 50 | 0.06 ms (side table) / 293 ms (JSON) | 0.07 ms | 0.05 ms |

As expected, nothing moves: every query was already per org. Without the `org_id` prefix the
indexes are slightly smaller.

### 8.2 What is new

| Cost | Measured | Where it matters |
|---|---|---|
| Opening a connection (first query included) | 16.7 ms median (15.5–22.7) | the first request to a cold org; the fan-outs (§2.6) |
| An idle backend | 4.2 MB private, 19.8 MB working set | the connection budget (§2.11) |
| `CREATE DATABASE` (empty) | 0.63 s | create, import, conversion |
| `DROP DATABASE` | 0.26 s | purge |
| One-org dump (the live org's tables, compressed) | 2.2 s, 25 MB | export, move |
| One-org restore (into a new database, indexes included) | 5.7 s, 112 MB on disk | import, move |
| `max_connections` | 40 today (dev and live); 100 from 3.2.0 | Q11, decided |

### 8.3 Expected end to end

The same estimates as rev 2 (inferred, replaced by measurements at the first prototype):

| Screen or operation | Today | Expected |
|---|---|---|
| Tree after a commit | 1.2–1.45 s | under 50 ms (change-log catch-up) |
| Docket list | 66–87 ms | 5–15 ms |
| History panel | about 150 ms | under 10 ms |
| Per-turn prompt | ≈140 ms | 10–30 ms |
| Desk chat | 158–244 ms | under 60 ms |
| Big reshape | 0.74–0.96 s | 0.1–0.3 s |
| `GET /api/accounts` | loads every org whole | under 2 ms warm / about 20 ms cold for 4 orgs |
| The first request to a cold org | – | +17 ms to open its pool |

## 9. Tests

Rev 2's tests, unchanged:

- round trip per kind;
- no JSON in lookups (`EXPLAIN` guards and a source scan);
- no growth with history at 1× and 10×;
- integrity refusals;
- concurrency;
- access equivalence with `_work_can_read`;
- the behaviour suites as the contract;
- mutants on the risky code.

Added for rev 3:

1. **Per-database migrations.** A partly migrated set (org A at N+1, org B at N) is finished at the
   next start. An org newer than the build, or with a failing migration, becomes `unavailable`
   with its reason while the other orgs start. Its database stays at its last good level. A
   failing or newer app database refuses the start.
2. **Lifecycle.** Each step of create, trash, restore, purge, export and import is killed at every
   intermediate state and finished by the next start. After purge, no row in the app database and
   no database or folder of the org remains. An import of an `org_uuid` already registered is
   refused. `org_identity` mismatch refuses to serve.
3. **Connections.** Pools open lazily and close when idle. A fan-out over N orgs opens at most its
   concurrency limit of connections. The per-process cap queues rather than failing.
4. **Cross-database steps.** A crash between the sender's commit and the delivery job, retried,
   delivers exactly once. Likewise a crash between the `start_turn` job and the ticket insert.
5. **Conversion.** Fixtures for both starting points, including the accounts file and the side
   files. For every planted fault:
   - the faulty org becomes `unavailable` with its message, and its half-built database is gone;
   - the other orgs convert and start;
   - nothing is written to the legacy store or the old files (checksums before and after);
   - the partly converted set resumes correctly.

   A fault in the accounts file refuses the start.
6. **Failed orgs (Q12).**
   - The first-launch import holds back only the faulty SQLite org, and its file still moves to
     `pre-postgres/orgs` unchanged.
   - After the fault is removed, Retry converts the org for each of the four steps.
   - Automatic retry happens once per new build and not at every restart.
   - Mail to an unavailable org waits and is delivered once after retry.
   - The org list and `/api/accounts` show the org as unavailable.
7. **Jobs instead of loops.** With every polling loop removed, each loop's behaviour test still
   passes, driven only by jobs. A test fails if any process sleeps in a loop that reads org
   tables.
8. **Feed.** After any sequence of frames, the renderer's store equals a full load. A missed
   frame is detected as a gap and caught up. Other audiences receive only what their reads would
   return.
9. **Turn queue and two processes.**
   - Fairness across orgs and the slot limit hold, as in today's `turnslots` tests.
   - A killed worker's leases expire, and its jobs and tickets run once elsewhere.
   - No turn is started twice.
   - An interrupt sent to the host stops a turn the worker owns.
10. **Admin connection (Q10).** A source scan fails if any module other than the org-lifecycle
    module reads the admin URL or opens that connection, or if the worker can reach it.

## 10. Questions: all answered

Q9–Q12 are answered (see the table at the top) and folded in.

**Details I filled in while folding in the answers.** These are mine, not the user's. The
coordinator may overrule any of them.

| # | Detail | Where |
|---|---|---|
| D1 | The Q12 rule also covers an org whose later migration fails, whose database is newer than the build, or whose identity check fails. A failure in the app database or the accounts still refuses the start, because no org can run without them. | §2.12, §5.2 |
| D2 | The 2.1.14 first-launch import holds back only the failing org, instead of refusing every org. The held-back org's file still moves, unchanged, to `pre-postgres/orgs`. | §5.1 |
| D3 | Retry runs when the user asks, and once automatically when a different build starts. It does not run at every restart. | §2.13 |
| D4 | An unavailable org offers only Retry in 3.2.0, with no trash or purge, because its data is not in the new layout. | §2.13 |
| D5 | The cleanup release keeps the legacy database and the old files while any org is still unavailable from the import or the conversion. | §5.3 |
| D6 | The second process is one worker, a child of the engine host, with no port, no owner lock and no admin connection. Both processes run jobs and turns. | §2.9 |
| D7 | Timers that read outside state (provider usage, update checks, the mail hub) stay timers in the engine host. They do not scan the database for work. | §2.7 |

## Appendix A. The org database's tables in full

This is rev 2 §3.1–§3.10 with `org_id` removed. Every key is a plain surrogate `id`; every foreign key
is a plain one inside the org database.

### A.1 Settings

**`org_settings`** is one row of typed columns for the scalar settings in `OrgDoc`:

- name, version, workspace;
- permission_mode, default_visibility, default_effort;
- max_top_grant, default_top_grant, compact_at;
- fable policies, cascade switches, max_depth, max_children;
- auto-resume fields, storage flags, net switches, API-key fallback fields;
- cost accumulators and heal markers.

The object-valued settings (`killswitch`, `kiosk`, `sandbox`, `disk`, `net_identity`, `fable_lock`,
`auto_cheap_compact`) are flattened into columns where their shape is fixed; otherwise they are one
JSON column each.

Setting lists, one row each:

| Table | Holds |
|---|---|
| `org_dirs(path, mode)` | folder grants |
| `org_tiers(tier, price, model)` | today's `tiers` and `models` |
| `org_default_mcp(server)` | default MCP servers |
| `org_kiosk_dirs`, `org_kiosk_mcp` | kiosk limits |
| `net_hubs(id, address, enabled, name)` | hubs |
| `net_hub_seen(hub_id, message_id)` | seen hub messages |
| `net_spool(hub_id, seq, …)` | outgoing hub spool |
| `retired_slugs(slug)` | docket names that can't be reused |

### A.2 Agents

**`agents`** holds hot columns only, one row per agent generation. It replaces `nodes`,
`node_index`, `foreground_meta`, `foreground_parents` and `node_tree_val`.

| Group | Columns |
|---|---|
| keys | `id`; `name`; `ord` (the stable display order today's walks produce) |
| tree | `parent_id` → agents (NULL = top level); `ui_order`; `created`; `archived_at`; `rescinded_at` |
| state | `state CHECK (live, archived, unrecoverable, deleted)`; `title`; `model`; `credit_grant numeric` |
| lineage | `seat_id`; `lineage`; `generation`; `predecessor_id` → agents; `successor_id` → agents; `bearer_state CHECK`; `lost_reason` |
| session | `session_id`; `transcript_incarnation`; `reply_incarnation`; `pid`; `session_began_at`; `session_unrun`; `cheap_compacted`; `compacted_unrun` |
| accounts | `account`; `account_primary`; `codex_account`; `codex_thread`; `antigravity_account`; `antigravity_conversation`. These name accounts in the app database by their stable id: a soft reference, since it crosses databases. |
| mail | `mailbox_id UNIQUE`; `mail_seq` |
| scope (flattened) | `permission_mode`; `org_visibility`; `effort`; `account_fallback`; `model_version`; `prefer_reserve`; `tool_bash`, `tool_web`, `tool_edit`, `tool_subagents`; `cheap_compact_enabled`, `cheap_compact_occ` |
| usage | `cost_usd`; `cost_usd_unknown`; `context_window`; `occupancy`; `occupancy_est`; `cli_compactions`; `cli_boundary_offset`; `turn_seq`; the two estimate tuples as columns |
| status | `last_status_status`, `_summary`, `_at`; `prev_status_*` |
| runtime markers | `limit_locked`; `config_seq`; `hard_fail_run`; `limit_run`; `net_fail_run`; `net_fail_since`; `untrusted_limit_run`; `docket_reminder_at`; `working_activity_at`; `cache_keepalive_at` |
| tool inventory | `last_turn_mcp_tool_count`; `last_turn_mcp_fingerprint`; `tool_list_id` → `tool_lists` |
| presence flags (partial-index targets) | `is_frozen`, `is_halted`, `is_remote_controlled`, `has_pending_switch`, `is_inflight` |
| bookkeeping | `extra`; `row_version` |

**Indexes on `agents`:**

| Index | Serves |
|---|---|
| `(parent_id, ui_order, created, ord)` | children in display order |
| `(ord) WHERE state = 'live'` | live agents |
| `(parent_id, ui_order, created, ord) WHERE state = 'archived' AND successor_id IS NULL` | the retired pile under a seat |
| `(predecessor_id)`, `(successor_id)` | lineage walks |
| `(seat_id)`, `(session_id)` | lookups by seat and session |
| `UNIQUE (name) WHERE state <> 'deleted'` | names |
| partial indexes per presence flag | "which agents are frozen, halted …" |
| `(account) WHERE account IS NOT NULL` | distinct accounts |
| a name gram index (today's `orgtree_id_grams`) | canvas search |

**One-to-one cold tables:**

- `agent_texts(agent_id PK, charter, team_charter, team_charter_null)`.
- `agent_runtime(agent_id PK)`, one JSON column per shapeless payload (Q1): `frozen`, `halt`,
  `inflight`, `turn_ended`, `pending_switch`, `remote_controlled`, `admit_once`, `unstuck`,
  `last_wall`, `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_total`,
  `codex_usage_reset`, `desktop_import`, `mail_drain_state` (its id list moves to a link table).

**Child and link tables:**

| Table | Kind | Notes |
|---|---|---|
| `agent_dir_grants(agent_id, pos, path, mode CHECK (rw, ro))` | many-to-many agent ↔ folder | index (path) |
| `agent_mcp_servers(agent_id, pos, server)` | many-to-many agent ↔ server | index (server) |
| `agent_tool_prompts(agent_id, kind CHECK (denial, approval), pos, tool, arg, cwd)` | owned list | `last_denials`, `last_approvals` |
| `tool_lists(id, sha256 UNIQUE)`, `tool_list_items(list_id, pos, tool)` | a value shared by many agents | measured: 40 distinct lists over 1,045 agents, so 71,000 stored names become about 2,700 rows |
| `agent_carriers(agent_id, pos, halt_id, text, view, ping, ping_reason, from_*, at, delivery_id, claim json)`, `carrier_mail(carrier_id, mail_id)`, `carrier_tokens(carrier_id, tok)` | owned list + links | `halt_queue`, `native_held_carriers` |
| `agent_mail_drain(agent_id, mail_id)` | many-to-many | the waking mail ids |
| `agent_turns(agent_id, n, at, cost, ms, toks, denials, approvals, ran_as, killed, estimated, cost_complete, cost_source, route json, reported json, …)` | owned log | PK (agent_id, n); index (agent_id, n DESC). One table for **both** the agent's `turns` list and the `turn_log`. Measured: for 1,106 of 1,187 agents, the stored list is exactly the log's last 8 rows; the other 81 predate the log. The tree reads `LIMIT 8` from the index; `node_tree_val` goes away. |
| `agent_turn_errors(agent_id, seq, at, text, ran_as)` | owned log | today's `turn_error_log` |
| `agent_external_handles`, `agent_oracle_exchanges` | owned lists | retired and rare fields, kept exactly |

**Tree queries** (indexed SQL; times in a dedicated database, §8):

| Query | Time |
|---|---|
| children of the 483-child seat | 0.18 ms |
| ancestors (at most 6 levels on live data) | 0.11 ms |
| descendants of the 1,145-agent subtree | 3.1 ms |
| lineage count of 62 generations | 0.16 ms |

**No closure table.** The tree is at most 6 levels deep (average 1.9). A closure table would rewrite
up to 1,145 × depth rows on a big move: today's trigger cost again, under another name. Decision 3
asks for this justification.

### A.3 Docket

**`work_items`** holds active and archived items together. It replaces the active `doc` rows, the
archive log rows, `work_index`, `work_list_summary` and all of `work_read_*`.

| Group | Columns |
|---|---|
| keys | `id`; `slug UNIQUE`; `rev` |
| identity | `kind CHECK`; `title` |
| status | `status CHECK`; `status_at`; `blocked_reason`; `waiting_reason`; `dropped_reason` |
| people | `owner_id` → agents (+ `owner_generation`); creator principal columns; `reviewer_id` (+ `reviewer_generation`); `last_updater_*` |
| times | `created`; `updated_at`; `docket_at`; `archived_at` (NULL = active) |
| links | `parent_item_id` → work_items; `superseded_by_id` → work_items |
| attention | `attention_reason`, `attention_at`, `attention_by_*`, `attention_set_rev`; `manual_attention_rev`; `notification_attention_active`, `notification_attention_epoch` |
| completion | `accepted_at`, `accepted_by_*`, `accepted_note`, `accepted_via`, `accepted_evidence_gap`; `post_completion json` |
| sequences | `scope_seq`, `scope_guard`, `scope_rolled`, `scope_logged`, `artifact_seq`, `finding_seq` |
| bookkeeping | `extra`; `row_version` |

The description (`objective`) lives in `work_item_texts(item_id PK, objective)`.

**Indexes on `work_items`:**

| Index | Serves |
|---|---|
| `(coalesce(docket_at, updated_at) DESC, slug DESC)` | the list order |
| `(status) WHERE archived_at IS NULL` | active-only filters |
| `(owner_id)`, `(reviewer_id)`, `(created_by_id)` | lookups by person |
| `(coalesce(owner_id, created_by_id))` | the access rule's anchor |
| `(parent_item_id)`, `(superseded_by_id)` | child items and supersessions |
| `(attention_set_rev) WHERE attention_reason IS NOT NULL` | attention raises |

**Child and link tables:**

| Table | Kind |
|---|---|
| `work_item_participants(item_id, agent_id)` | many-to-many; indexes both ways |
| `work_item_dependencies(item_id, depends_on_id)` | many-to-many; indexes both ways |
| `work_item_holders(item_id, seq, agent_id, generation, from_at, by_*, derived)` | owned list; index (agent_id) for the item-scoped read grant |
| `work_item_acceptance(item_id, idx, text)` + `work_item_acceptance_checks(item_id, idx, seq, …)` | owned list + its list |
| `work_item_progress(item_id, list CHECK (done, next), pos, text)` | owned list |
| `work_item_events(item_id, seq, at, by_*, kind CHECK (history, evidence, decision, scope, verdict, review_packet, dismissal, …), …)` | the item's **append-only history as rows** (decision 7 point 2): one sequence of typed events, with kind-specific columns and a content column for free text. The latest verdict and review packet are the newest event of that kind. Measured: 420 of 740 stored `candidate_verdict` values equal the last list entry and the other 320 are null; all 52 non-null `review_packet` values equal the last entry. |
| `work_item_review_seats(item_id, seq, reviewer_id, holder_id, …)`, `work_item_review_seat_requests(item_id, seq, …)` | owned lists with state |
| `work_item_artifacts(item_id, artifact_id, …)` + `work_item_artifact_grants(item_id, artifact_id, agent_id)` | owned list + many-to-many |
| `work_item_findings(item_id, finding_id, …)` + `work_item_finding_decisions(…)` | owned list + its list |
| `work_item_delivery(item_id, stage, …)` | owned, at most 5 stages |
| `work_item_quick_staff_receipts(item_id, receipt_id, …)` | owned list |

**Docket access is a query.** The rule (`Org._work_can_read`) is that these may read an item: the
user; the owner; the creator; the reviewer; a participant; a strict ancestor of the owner (of the
creator when there is no owner). As SQL:

```sql
WITH RECURSIVE down(id) AS (SELECT id FROM agents WHERE parent_id = $viewer
                            UNION SELECT a.id FROM agents a JOIN down d ON a.parent_id = d.id)
SELECT i.* FROM work_items i
WHERE $viewer_is_user
   OR i.owner_id = $viewer OR i.created_by_id = $viewer OR i.reviewer_id = $viewer
   OR EXISTS (SELECT 1 FROM work_item_participants p WHERE p.item_id = i.id AND p.agent_id = $viewer)
   OR coalesce(i.owner_id, i.created_by_id) IN (SELECT id FROM down)
ORDER BY coalesce(i.docket_at, i.updated_at) DESC, i.slug DESC
```

**Measured:** against the old JSON rows of the live copy, it returns exactly the engine's 5,041 (item,
reader) pairs, with 0 differences (`probe/access_rule_check.sql`). In a dedicated database it costs:

| Viewer | Time |
|---|---|
| a leaf agent | 0.38 ms |
| the coordinator (1,145 descendants) | 1.6 ms |
| the user | 0.19 ms |

The seven `work_read_*` tables, their triggers and the per-save refresh go away. The Python
predicate stays as the test oracle.

### A.4 Mail, notices and delivery

- **`mailboxes(agent_id PK, next_recv_seq)`.** The row a delivery locks; it replaces
  `mail_archive_bounds`.
- **`mail`.** One row per delivered copy (measured: no id or message id is shared between
  recipients). Columns:
  - `id`, `public_id UNIQUE`;
  - `recipient_id` → agents;
  - sender principal;
  - `kind`, `relationship`, `at`;
  - `state CHECK (queued, delivering, delivered)`;
  - `recv_seq`, `seq_origin`, `mailbox`, `message_id UNIQUE`, `operation_id`, `client_op`;
  - flags: `restart_notice`, `model_only`, `retracted`, `stale` (+ details), `redelivered`;
  - `net_id`, `reply_to json`, `ev json`;
  - `extra`, `row_version`.

  The body lives in `mail_bodies(mail_id PK, body)`. Today's unread list, `delivering` batches and
  `mail_log` archive are three states of one row: mail no longer moves between sections.
- **Indexes on `mail`:**

  | Index | Serves |
  |---|---|
  | `(recipient_id, recv_seq) WHERE state <> 'delivered'` | the inbox queue |
  | `(recipient_id, id DESC)` | the archive tail |
  | `(sender_id, at DESC, id DESC)` | Sent; replaces `mail_sent` and its trigger |
  | `(recipient_id, recv_seq DESC) WHERE recv_seq IS NOT NULL` | the next sequence number |

- **Delivery.**
  - `mail_attachments(mail_id, pos, name, path, bytes, missing)`.
  - `delivery_batches(id, tok UNIQUE, agent_id, at, via, mode, attempt, drive json, claim json, …)`
    with `delivery_batch_mail(batch_id, mail_id)`, `delivery_batch_deliveries(batch_id,
    delivery_id, role)`, `delivery_batch_notices` and `delivery_batch_segments`.
  - `mail_transition_receipts` + `mail_transition_deliveries`.
  - `manual_attempts` + `manual_attempt_mail`, `manual_chunk_calls`, `manual_chunks`.
- **Steer records.**
  - `steer_records(id, agent_id, at, level, visible_id, delivery_id, attempts, retried,
    confirmed_duplicate, fold, where_, outcome)`, with the text in `steer_texts`, plus
    `steer_record_segments`, `steer_record_mail(steer_id, mail_id)` and
    `steer_record_deliveries(steer_id, delivery_id, role)`. The chat tail index
    `(agent_id, at DESC, id DESC)` is kept (0016's shape).
  - `steer_attempts` + `steer_attempt_mail`, `steer_attempt_tokens`.
- **`notices(id, agent_id, at, text, ev json, state CHECK (pending, delivered))`.** Today's pending
  notices and `notice_log` are two states of one table. Indexes `(agent_id, id) WHERE state =
  'pending'` and `(agent_id, at DESC, id DESC)`.
- **User mail and the org inbox:**
  - `user_mail(id, public_id, sender_*, kind, at, urgent, urgent_reason, read_at, ev json)` +
    `user_mail_bodies`;
  - `user_outbox(id, recipient_id, …)` + bodies;
  - `org_inbox(id, public_id, dir, peer, by_*, at, state, state_at, net_id, message_id UNIQUE)` +
    body + `org_inbox_attachments`. The `message_id` uniqueness is what makes cross-org delivery
    idempotent (§2.7).

### A.5 Questions, audiences, watchdogs, documents, reservations

| Table | Replaces | Notes |
|---|---|---|
| `asks(id, public_id, agent_id, kind CHECK (ask, credit, scope), status CHECK, at, resolved_at, rev, reason, header, question, answer_mail, old_grant, new_grant, granted, notice)` | three doc blobs, each rewritten whole on every change | with `ask_questions`, `ask_question_options`, `ask_answer_selections`, `ask_work_items(ask_id, item_id)` (many-to-many) and `scope_request_items`. Indexes `(agent_id, status)`, `(status) WHERE status IN ('open', 'pending')`, and the resolved-recent order (0018's shape). |
| `audience_grants(grantee_id, grantor_*, granted_at, reason, delegated_by_id)` | the audiences blob | PK (grantee, grantor); index (grantor). `_has_audience` on every send becomes one key probe. |
| `audience_requests(…)` | the requests blob | |
| `watchdogs(id, public_id, owner_id, name, kind CHECK, target, pattern, interval_s, state CHECK, notice, once, at, fired, last_check, checks_run, last_output, last_exit, last_fired, paused_why, history_retained, spent_at, high_water json)` | `watchdogs` and `watchdog_tombs` | Each live dog has one `check` job. |
| `watchdog_events(watchdog_id, seq, at, gist, body)` | each dog's ring and the history log | |
| `documents(id, public_id, agent_id, at, title, format, file, bytes)` + `document_bodies(document_id PK, body)` | the presentations log | The gallery lists columns; opening a document is a key read. |
| `reservations(id, public_id, owner_id, item_id, resource, candidate, base, state CHECK, created_at, updated_at, expires_at, heartbeat_at, stale_s, integration_key, integration_receipt, landed_at, release_receipt, successor)` + `reservation_paths(reservation_id, path)` | the reservations blob (never pruned) | `UNIQUE (resource) WHERE state = 'held'`, `UNIQUE (integration_key)` |

### A.6 Logs, receipts, scheduling, feed

- **`events(id, at, op, actor_*, item_id, detail json)`**, with `event_agents(event_id, agent_id,
  role)` (many-to-many: actor, node, to, grantee, from and list members) and
  `event_warnings(event_id, pos, text)`. Index `(agent_id, event_id DESC)` on `event_agents`: the
  history panel takes 0.13–0.24 ms (74 ms today). `detail` keeps each operation's own payload (70
  distinct operations on the live copy; Q1).
- **`op_receipts(id, public_id, agent_id, gen, tool, key, fp, cls, outcome, at, mint_ms, targets
  json, result json)`** + `op_receipt_effects`. Index `(agent_id, key)`. Today's `public.receipts`
  rows for the org move here too.
- **`lifecycle(id, operation_id, kind, state, at, …)`.** Index `(operation_id, state)`.
- **The custody receipts** (0013: `receipts`, `receipt_owners`, `receipt_carriers`). Already
  relational; they move into the org database unchanged apart from the key.
- **`jobs`** (§2.7), **`changes`** and **`org_revision`** (§2.5).

### A.7 Deliberate duplicates (denormalization), with the reason for each

1. **The agent presence flags** (`is_frozen` …) beside their payload in `agent_runtime`. The hot row
   must answer "is it frozen" without reading the cold row. One function writes both in one
   statement, and a test asserts they agree.
2. **`agents.ord`.** The stable display order the product has today.
3. **`org_revision` and `changes`.** The commit log the feed needs (§2.5).
4. **`turn_tickets.agent_name`** in the app database. Copied so the admission view can show who is
   waiting without opening every org database. It is refreshed when the ticket is written.

Nothing else is stored twice.
