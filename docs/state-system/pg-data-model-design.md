# Orgtree on PostgreSQL, built for it from the ground up: target design (rev 2)

Docket item: `v3-storage-keep-indexed-fields-in-real-postgresq` (drag-opus, 2026-10-02).

This design is the target. It must be read by the coordinator, and presented to the user, before
any code beyond the first prototype is written (decisions 7 and 8 on the item). The companion
[`pg-columns-audit.md`](pg-columns-audit.md) measures today's costs on a copy of the live data. The
numbers here come from that audit, or from the prototype tables described in §8.

**Rev 2 replaces rev 1** (commit `e86d209`).

- **Rev 1** kept the engine's in-memory org dictionary and mapped it onto tables.
- **Rev 2 follows decision 7 (user, 2026-10-02 12:23Z).** It designs the backend as if it had
  been built for PostgreSQL from the start: the database is the only source of truth, and every
  action is one short transaction over its own rows.
- **Carried over from rev 1:** the measurements, the table design and the conversion plan, where
  they still fit.
- **Answers already given** (decision 7 and the coordinator's mail): Q1 (one JSON column per
  shapeless payload), Q2 (`timestamptz`), Q3 (keep the old tables for one release), Q4 (`numeric`
  for mixed numbers) and Q5 (stages land on v3 one at a time; no build or publish until the whole
  data-model rewrite is in, decision 6).

## 0. Summary

**What changes for the user.** One upgrade converts all of an org's data into a new set of
tables. It runs automatically on the first start, from either a 3.x install or a 2.1.14 install.
It is checked record by record, and refuses to start if anything does not match. After it:

- reshaping the org, the docket, the inbox, the history panel, the per-turn prompt and the tree
  feed stop slowing down as archived history grows;
- the engine stops doing whole-org work in the background every few seconds;
- the backend becomes able to run as several processes.

**The target, in ten points** (decision 7's list, each mapped to a mechanism in §2):

| # | Point | Mechanism |
|---|---|---|
| 1 | PostgreSQL is the source of truth | Each action is one short transaction that locks and writes only its own rows. No whole-org dictionary. |
| 2 | Normalized tables | One table per kind of record, with typed columns. Many-to-one links are foreign-key columns, many-to-many links are link tables, and history is rows. JSON only for shapeless provider payloads that nothing filters on. |
| 3 | Integrity in the database | Foreign keys, `CHECK`s on every status, unique names per org, at most one held reservation per resource, and a tree-loop check in the transaction that moves an agent. |
| 4 | History costs nothing | Partial indexes cover active rows only: live agents, open items, unread mail, queued jobs. Archived rows never enter a hot path. |
| 5 | Concurrency | Row locks, a `row_version` column for compare-and-set, and turn admission as a `SKIP LOCKED` queue. |
| 6 | Screen feed | Every transaction appends to a numbered `changes` table and sends `NOTIFY`. The UI catches up by number, and a gap means a missed update. This replaces whole-tree rebuilds and polling. |
| 7 | Reads are targeted queries | The docket access rule in SQL; header counts by indexed count; the prompt reads only the agent's neighbourhood. |
| 8 | Background work as job rows | Delivery, watchdog checks, turn starts, retries, reminders and resumes become rows in a `jobs` table with a due time, not 5–30 s scans. |
| 9 | Domain modules | agents, docket, mail, questions, scheduling, feed, providers, accounts, org. Each module owns its tables and queries. |
| 10 | A stateless engine | Several engine processes can serve at once. Large texts live outside the hot rows. One shared set of tables with an `org_id` column, not a copy per org. |

**One data migration.** The schema in §3 is the complete end state. It includes the tables that
later engine work uses (`jobs`, `turn_queue`, `changes`). Everything that ships after the migration
release changes code only, never user data (§6).

**First prototype** (decision 8, defined in §6.2). It contains:

- the full schema;
- the full conversion of real data from both starting points;
- the whole app running on nothing but the new tables, with the agents and docket modules native.

It is the point at which the local alpha build is made, after both rehearsals pass.

**Expected gains** (measured on prototype tables built from the live data, §8):

| Operation | Today | New tables |
|---|---|---|
| Re-parent 400 agents | 1.0 s | 6 ms |
| The docket counts every tree rebuild pays | 1.0–1.2 s | 0.2 ms |
| Docket "items I can read" | 58–71 ms | 0.5–2 ms |
| History lookups | 112 ms | 0.3 ms |
| Delivering 200 mails | 243 ms | 2.4 ms |

On the live copy, the SQL access rule returns exactly the engine's 5,041 (item, reader) answers
(measured, §3.4).

## 1. Starting point and constraints

- **The engine today.** About 70,000 lines (`ledger.py`, `supervisor.py`, `api.py`) operate on one
  dictionary per org. `store.py` loads it lazily from five key+JSON tables per org, and saves it by
  comparing serialized JSON. Eighteen per-row triggers keep side tables (`node_index`,
  `work_read_*`, `mail_sent` …) so that a few reads avoid unpacking JSON. The audit measures the
  cost.
- **The user's rules for this item** (decisions 2–8):
  - foreign keys for many-to-one, link tables for many-to-many, no embedded lists;
  - a standard normalized design;
  - conversion from v3.0.9 and from v2.1.14, both rehearsed on real data;
  - no build or publish until the whole rewrite is in;
  - the ground-up architecture above;
  - a local alpha build after the first prototype, once both rehearsals pass.
- **Hard constraints.**
  - Old data must not be lost.
  - Every migration must refuse to start, with a clear reason, if a check fails.
  - The first-launch importer for 2.1.14 data (`tools/pypg/pgimport.py`) writes into today's tables
    (§5.1).

## 2. The target architecture

### 2.1 The unit of work: one short transaction per action

Every operation (an API call, an agent tool call, a job) is one function in a domain module, with
this shape:

```python
def move_agent(t: Tx, agent: AgentRef, new_parent: AgentRef | None, actor: Actor) -> MoveResult:
    a = t.agents.lock(agent)                 # SELECT … FOR UPDATE on the rows it will change
    p = t.agents.get(new_parent)             # plain read, or FOR SHARE if the decision depends on it
    rules.check_move(a, p, actor)            # the business rule, in Python, on these rows only
    t.agents.set_parent(a, p)                # UPDATE agents SET parent_id = …, row_version + 1
    t.feed.changed("agent", a.id)            # appended to `changes` at commit (§2.5)
    return MoveResult(...)
```

- **`Tx`** is a database transaction (READ COMMITTED), opened by the request or job runner.
- **Committing** bumps the org's revision and writes the change-log rows (§2.5).
- **Retries.** A serialization failure or deadlock retries the whole function. Functions are pure
  apart from the database, as `org_tx_call` already requires.
- **Idempotency.** Operation keys stay (`public.receipts`, `op_receipts`), written in the same
  transaction.
- **Locks are taken in one order:** org row (shared), then agents by id, then items by id, then
  mailboxes, then other rows. This is the lock-plan idea `orgtx` already uses, applied to named
  rows instead of whole sections.
- **The business rules stay in Python** (hire limits, grants, docket rules, visibility). They run
  on the rows the function read, not on a whole-org dictionary. Rules that need a set ("is X an
  ancestor of Y", "the free credits under P", "the items X can read") ask the database (§2.6).

### 2.2 Integrity enforced by the database

| Rule | How |
|---|---|
| Every link points at a real row of the same org | Composite foreign keys `(org_id, x_id) → (org_id, id)`. A cross-org link is impossible by construction. |
| Valid statuses and kinds | `CHECK (state IN …)` on every enumerated column (agent state, bearer state, item status and kind, mail state, job state, reservation state …) |
| Agent names unique per org | `UNIQUE (org_id, name) WHERE state <> 'deleted'`. A deleted agent keeps a tombstone row, so historical references stay valid keys, and its name can be reused (§3.2). |
| Docket slugs unique per org, never reused | `UNIQUE (org_id, slug)` on items, plus `retired_slugs(org_id, slug)`. The create function refuses a retired name, inside the same transaction. |
| No overlapping reservations | `UNIQUE (org_id, resource) WHERE state = 'held'` (today's rule: one held reservation per resource), and `UNIQUE (org_id, integration_key)` |
| No loop in the tree | A statement-level constraint trigger on `agents`, run when `parent_id` changes. For each moved row it walks up from the new parent (at most the tree depth, 6 today) and raises if it meets the row. It runs in the moving transaction, at commit. It derives no data; it only refuses. |
| One running turn per agent; one queued delivery per mailbox | Partial unique indexes on `turn_queue` / `jobs` (§2.4, §2.7) |
| Counts never negative, sequences monotonic | `CHECK`s on counter and sequence columns |

### 2.3 History costs nothing

Hot paths only ever see active rows, through partial indexes:

| Table | Partial indexes |
|---|---|
| `agents` | `WHERE state = 'live'`; children `(org_id, parent_id, ui_order, created, …)`; retired pile `WHERE state = 'archived' AND successor_id IS NULL` |
| `work_items` | `WHERE archived_at IS NULL` (status, attention, order) |
| `mail` | `WHERE state <> 'delivered'` (the inbox queue) |
| `jobs` | `WHERE state = 'queued'` |
| `turn_queue` | `WHERE state = 'waiting'` |
| `asks` | `WHERE status IN ('open', 'pending')` |

Archived and historical rows are reached only by key (one item, one agent's history page) or by a
`LIMIT`ed index range ("newest 50 events of this agent").

The tests (§9) seed 10× archived history and require the same statement count and rows read on
every hot path. Partitioning the append-only logs by time stays possible later without a data
change, and is not needed at today's sizes.

### 2.4 Concurrency

- **Row locks** (`FOR UPDATE` / `FOR SHARE`) on exactly the rows an action changes or decides on.
- **Compare-and-set.** Every mutable row carries `row_version`. A save is
  `UPDATE … WHERE id = $1 AND row_version = $2`. An editor that read an old version gets a
  conflict, never a silent overwrite. The docket's user-visible `rev` stays as its own column.
- **Turn admission.** The fair queue becomes rows. `turnslots.FairSlots` is in memory today: a
  machine-wide limit of 16, first come first served within an org, round-robin across orgs.
  - `turn_queue(org_id, agent_id, enqueued_at, state, lane, …)` holds one waiting row per agent
    (`UNIQUE … WHERE state IN ('waiting', 'running')`).
  - The admitting function locks the single `turn_admission` row (the limit and the org served
    last), counts running rows, and picks the next waiting row in fair order with
    `FOR UPDATE SKIP LOCKED`. It marks that row running, with a lease.
  - The process running the turn renews the lease. An expired lease frees the slot after a crash.
  - Interrupt, halt and retire mark the row cancelled in their own transaction. Today they must call
    `wake()`; here they need nothing more.

### 2.5 The change log and the screen feed

`changes(org_id, rev, pos, entity, entity_id, op)` holds one row per record a transaction changed.
`rev` is the org's commit revision (`orgs.revision`, which exists today and is bumped once per
commit).

- **Ordering.** The transaction takes the org's revision-row lock **last**, just before commit. So
  revisions are handed out in commit order with no gaps, and the lock is held only for the commit
  itself.
- **Notification.** `NOTIFY org_rev, '<org>:<rev>'` (the channel `pgfeed.py` already listens on).
  The engine pushes a frame carrying `rev` to the org's websocket clients.
- **Catching up.** A client that sees rev N+2 after N, or reconnects, asks
  `GET /api/orgs/{slug}/changes?after=N`. It gets the changed `(entity, id, op)` list and fetches
  just those records through the targeted read endpoints. A client too far behind (older than the
  retention window) does one full load.
- **This replaces three mechanisms:**
  - the per-process frame `rev` (`api._sync_revs`): it lives in one process, so it cannot serve
    several;
  - the coalesced `changed` broadcast;
  - the whole-tree rebuild after every commit (1.2–1.45 s on the live copy today).
- **Retention.** Change rows older than a window (default 24 h, and at least the last 10,000
  revisions) are deleted by a job.

### 2.6 Reads are targeted queries

Each screen and each agent read is one or a few queries over indexed columns. It never loads an
org. Examples, with prototype costs (§8):

- **Docket list.** The access rule as SQL (§3.4) with the list order index: 0.2–2.1 ms.
- **Header counts.** `count(*)` over the active partial indexes: open items by status, unread mail,
  open questions, live agents. All are cheap because the active sets are small: 12 open items, 6
  live agents. A counter row updated in the same transaction is reserved for a count over a large
  set, if one ever appears.
- **The per-turn prompt.** It reads only the agent's neighbourhood: its row; its ancestors (at most
  6); its children and peers; the free credits of its chain (`sum(credit_grant)` per parent); its
  open questions and audiences. Today it decodes every agent (≈140 ms).
- **Tree screens.**
  - The canvas loads live agents plus, per seat, a page of the retired pile.
  - Changes arrive through the feed (§2.5).
  - Lineage is a recursive query over `predecessor_id` (0.19 ms for 62 generations).

### 2.7 Background work as job rows

`jobs(org_id, job_id, kind, agent_id, item_id, watchdog_id, run_at, state, attempts, lease_owner,
lease_until, last_error, dedupe_key)`, with a partial index on queued jobs by `run_at`, and
`UNIQUE (org_id, kind, dedupe_key) WHERE state IN ('queued', 'running')` so the same work is never
queued twice.

- **Who writes a job.** The transaction that creates the condition: a deposit to an idle agent
  queues `deliver(mailbox)`; a freeze queues `resume(agent)` at its until-time; a watchdog queues
  its next `check` at `now + interval`; a status of "working" queues `checkup(agent)` at +20 min; an
  item becoming archivable queues `archive(item)` at its deadline.
- **Who runs it.** Workers in any engine process take due jobs with
  `FOR UPDATE SKIP LOCKED … ORDER BY run_at LIMIT n`, lease them, run each as its own transaction
  (§2.1), and finish or reschedule them.
- **What it replaces:** the 30 s auto-resume scan (it decodes every agent, audit §3.4), the 20 s
  keeper passes, the 5 s watchdog tick, the 1 s mail-drain loop, and the docket reminder scans.
  Nothing scans for work; the work is a row with a due time.

### 2.8 Domain modules

`engine/backend/orgtree/domain/`:

| Module | Owns |
|---|---|
| `agents.py` | the tree, hire / retire / move / swap / promote / insert / dissolve / rename, scope and grants, lineage |
| `docket.py` | items, access, list, update, review and acceptance, evidence, archive |
| `mail.py` | mail, mailboxes, notices, delivery batches, steer records, user mail, org inbox |
| `questions.py` | asks, credit and scope requests |
| `audiences.py` | grants and requests |
| `watchdogs.py` | dogs and their events |
| `documents.py` | presentations |
| `reservations.py` | reservations |
| `scheduling.py` | jobs, turn queue, leases, workers |
| `feed.py` | the change log and catch-up |
| `org.py` | settings, tiers, kiosk, net |
| existing `providers` / `accounts` modules | provider and account state; they keep their own stores |

Each module owns its tables. Others call its functions inside the same `Tx`, never its SQL.

`ledger.py`'s rules move into the modules as plain functions over row objects. The test suites that
assert today's behaviour (lifecycle, docket, mail, visibility) are the contract for each move.

### 2.9 A stateless engine; large texts out of hot rows

- **No process holds org state.** Process memory may cache read results only when they are keyed by
  `(org, rev)` and dropped when the feed moves past them. Turn processes (provider CLIs) are owned
  by the engine process that started them. Their `turn_queue` row records the owner and a lease, so
  another process never starts a second turn for that agent, and cleans up after a dead owner.
- **Several processes** can then serve requests, run jobs and run turns at once. Coordination goes
  only through rows, locks and `NOTIFY`.
- **Large texts live in one-to-one content tables, not in the hot rows:** charters, docket
  descriptions, mail bodies, document bodies and steer texts. Session transcripts stay on disk as
  today. The provider-reported JSON payloads of an agent go to `agent_runtime`. A row the tree or a
  list scans stays small (≈200 bytes for an agent instead of 12 KB).

### 2.10 One shared set of tables, keyed by org

Recommendation: **shared tables, `org_id` leading every key and index.** It is preferred by
decision 7, and nothing measured argues for keeping a copy per org.

| | Per-org schemas (today) | Shared tables with `org_id` |
|---|---|---|
| Migrations | a creator function re-wrapped by most migrations (14 of 0004–0019 wrap `orgtree_create_org_schema`) and a loop per org | one DDL statement per table |
| Queries | schema name built into SQL text; plans cached per schema | fixed SQL text, prepared once, shared by every org |
| Cross-org reads | `GET /api/accounts` loads every org's whole document (audit §3.4) | one query |
| Several engine processes | each process resolves schemas | nothing to resolve |
| Isolation between orgs | physical | `org_id` in every composite key and foreign key, so a cross-org link cannot be written. Every query takes `org_id` |
| Deleting an org | `DROP SCHEMA` | `DELETE FROM orgs WHERE org_id = $1` with `ON DELETE CASCADE` |
| Exporting one org | `pg_dump -n org_N` | the existing `export_json` path (by query) |

Today's data: 4 orgs, and one holds 93% of the rows. An `(org_id, …)` index prefix costs nothing
measurable at this size. If a future install holds very large orgs, `LIST` partitioning by `org_id`
can be added without changing the data model.

## 3. The schema

All tables live in `public`, or in a `orgtree` schema if the coordinator prefers.

### 3.0 Conventions

- **Keys.** Every record table has a surrogate key, `id bigint GENERATED ALWAYS AS IDENTITY`, plus
  `org_id bigint NOT NULL`, with `UNIQUE (org_id, id)` as the target of composite foreign keys. The
  names users and agents see stay natural keys with their own unique constraints:
  - agent `name` (today's node id: `drag-opus`, `coordinator-opus@61`);
  - item `slug`;
  - mail `public_id`.

  Renaming an agent is then one `UPDATE agents SET name`. Today `ledger.rename` rewrites every
  reference in the org (parent, predecessor, successor, items, mail, audiences, asks, documents …).
- **Timestamps** are `timestamptz` (Q2 answer), kept to the millisecond. API output keeps today's
  spelling (`YYYY-MM-DDTHH:MM:SS.mmmZ`). The 1,843 stored values with a `+HH:MM` offset (all restart
  notices) convert to the same instant and print in UTC.
- **Numbers.**
  - `bigint` / `integer` for whole numbers.
  - `double precision` for always-float values (exact round trip).
  - `numeric` where stored values mix ints and floats (Q4 answer). One example is `grant`: on the
    live copy 1,198 values are ints and 10 are floats such as `62.0`. The mapper keeps the stored
    form exactly.
- **Absent versus null.** For the fields stored both ways on real data, a `<field>_null` boolean
  marks a present null. These are:

  | Record | Fields |
  |---|---|
  | agents | `occupancy`, `cli_compactions`, `team_charter`, `last_status`, `prev_status` |
  | docket items | `waiting_reason`, `dropped_reason`, `parent`, `reviewer`, the latest verdict and packet |

  For JSON payload columns, SQL `NULL` means absent and JSON `null` means present null.
- **Strings containing U+0000.** Neither text nor `jsonb` can hold them. 17 records on the live copy
  have one, in mail bodies, steer logs and archived items. Such a field goes into the record's
  `extra` (JSON text, where `\u0000` is legal), its column stays `NULL`, and the conversion report
  counts it.
- **Unknown fields.** Each record table has `extra json` for top-level keys the schema does not know
  (legacy or future). It is expected to be empty; the conversion reports every key it puts there.
- **`row_version bigint NOT NULL DEFAULT 1`** on every mutable table (§2.4).
- **Who did something.** A table names its principal with a set of columns:

  | Column | Meaning |
  |---|---|
  | `actor_kind CHECK (agent, user, engine, outside)` | which kind of principal |
  | `actor_id` | a foreign key to `agents`, when the principal is an agent |
  | `actor_ref` | the address of an outside party (`@org:…`, `@net:…`) |

  The engine principal is called `system` today. So "sent by the user" is a value, not a magic
  string, and agent references stay real keys.
- **Deleting an agent** (user-only, permanent today) erases the agent's own records: mail, notices,
  turns, grants, audiences, questions (`ON DELETE CASCADE` from a tombstone purge). It keeps a
  tombstone `agents` row (`state = 'deleted'`, the name, no content), so historical references
  remain valid keys and still show the name: docket owner, holders, history, events. This matches
  what the product shows today: the item keeps `{node: name, deleted: true}`.

### 3.1 Orgs and settings

- `orgs` (exists): `org_id`, `slug`, `revision` (the commit counter of §2.5), `created_at`,
  `deleted_at`.
- `org_settings(org_id PK)`: one row of typed columns for the scalar settings in `OrgDoc`:
  - name, version, workspace;
  - permission_mode, default_visibility, default_effort;
  - max_top_grant, default_top_grant, compact_at;
  - fable policies, cascade switches, max_depth, max_children;
  - auto-resume fields, storage flags, net switches, API-key fallback fields;
  - cost accumulators and heal markers.

  The object-valued settings (`killswitch`, `kiosk`, `sandbox`, `disk`, `net_identity`,
  `fable_lock`, `auto_cheap_compact`) are flattened into columns where their shape is fixed;
  otherwise they are one JSON column each.
- Setting lists (one row each):

  | Table | Holds |
  |---|---|
  | `org_dirs(org_id, path, mode)` | folder grants |
  | `org_tiers(org_id, tier, price, model)` | today's `tiers` and `models` |
  | `org_default_mcp(org_id, server)` | default MCP servers |
  | `org_kiosk_dirs`, `org_kiosk_mcp` | kiosk limits |
  | `net_hubs(org_id, id, address, enabled, name)` | hubs |
  | `net_hub_seen(org_id, hub_id, message_id)` | seen hub messages |
  | `net_spool(org_id, hub_id, seq, …)` | outgoing hub spool |
  | `retired_slugs(org_id, slug)` | docket names that can't be reused |

### 3.2 Agents

**`agents`.** Hot columns only, one row per agent generation. It replaces `nodes`, `node_index`,
`foreground_meta`, `foreground_parents` and `node_tree_val`.

| Group | Columns |
|---|---|
| keys | `id`; `org_id`; `name`; `ord` (the stable display order today's walks produce) |
| tree | `parent_id` → agents (NULL = top level); `ui_order double precision`; `created`; `archived_at`; `rescinded_at` |
| state | `state CHECK (live, archived, unrecoverable, deleted)`; `title`; `model`; `credit_grant numeric` |
| lineage | `seat_id`; `lineage`; `generation`; `predecessor_id` → agents; `successor_id` → agents; `bearer_state CHECK`; `lost_reason` |
| session | `session_id`; `transcript_incarnation`; `reply_incarnation`; `pid`; `session_began_at`; `session_unrun`; `cheap_compacted`; `compacted_unrun` |
| accounts | `account`; `account_primary`; `codex_account`; `codex_thread`; `antigravity_account`; `antigravity_conversation` |
| mail | `mailbox_id UNIQUE`; `mail_seq` |
| scope (flattened) | `permission_mode`; `org_visibility`; `effort`; `account_fallback`; `model_version`; `prefer_reserve`; `tool_bash`, `tool_web`, `tool_edit`, `tool_subagents`; `cheap_compact_enabled`, `cheap_compact_occ` |
| usage | `cost_usd`; `cost_usd_unknown`; `context_window`; `occupancy`; `occupancy_est`; `cli_compactions`; `cli_boundary_offset`; `turn_seq`; the two estimate tuples as columns |
| status | `last_status_status`, `_summary`, `_at`; `prev_status_*` |
| runtime markers | `limit_locked`; `config_seq`; `hard_fail_run`; `limit_run`; `net_fail_run`; `net_fail_since`; `untrusted_limit_run`; `docket_reminder_at`; `working_activity_at`; `cache_keepalive_at` |
| tool inventory | `last_turn_mcp_tool_count`; `last_turn_mcp_fingerprint`; `tool_list_id` → `tool_lists` |
| presence flags (partial-index targets) | `is_frozen`, `is_halted`, `is_remote_controlled`, `has_pending_switch`, `is_inflight` |
| bookkeeping | `extra`; `row_version` |

The presence flags are set in the same statement as their payload (in `agent_runtime`) by the one
function that writes both. A `CHECK`-style test asserts they agree (§9). See §3.10, duplicate 1.

**Indexes on `agents`:**

| Index | Serves |
|---|---|
| `(org_id, parent_id, ui_order, created, ord)` | children in display order |
| `(org_id, ord) WHERE state = 'live'` | live agents |
| `(org_id, parent_id, ui_order, created, ord) WHERE state = 'archived' AND successor_id IS NULL` | the retired pile under a seat |
| `(org_id, predecessor_id)`, `(org_id, successor_id)` | lineage walks |
| `(org_id, seat_id)`, `(org_id, session_id)` | lookups by seat and session |
| `UNIQUE (org_id, name) WHERE state <> 'deleted'` | names |
| partial indexes per presence flag | "which agents are frozen, halted …" |
| `(org_id, account) WHERE account IS NOT NULL` | distinct accounts |
| a name gram index (today's `orgtree_id_grams`) | canvas search |

**One-to-one cold tables:**

- `agent_texts(agent_id PK, charter, team_charter, team_charter_null)`.
- `agent_runtime(agent_id PK)`, one JSON column per shapeless payload (Q1): `frozen`, `halt`,
  `inflight`, `turn_ended`, `pending_switch`, `remote_controlled`, `admit_once`, `unstuck`,
  `last_wall`, `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_total`,
  `codex_usage_reset`, `desktop_import`, `mail_drain_state` (its id list moves to a link table).

**Child and link tables** (counts are from the audit's §4.1):

| Table | Kind | Notes |
|---|---|---|
| `agent_dir_grants(agent_id, pos, path, mode CHECK (rw, ro))` | many-to-many agent ↔ folder | index (org_id, path) |
| `agent_mcp_servers(agent_id, pos, server)` | many-to-many agent ↔ server | index (org_id, server) |
| `agent_tool_prompts(agent_id, kind CHECK (denial, approval), pos, tool, arg, cwd)` | owned list | `last_denials`, `last_approvals` |
| `tool_lists(id, sha256 UNIQUE)`, `tool_list_items(list_id, pos, tool)` | a value shared by many agents | 40 distinct lists over 1,045 agents (measured): 71,000 stored names become about 2,700 rows |
| `agent_carriers(agent_id, pos, halt_id, text, view, ping, ping_reason, from_*, at, delivery_id, claim json)`, `carrier_mail(carrier_id, mail_id)`, `carrier_tokens(carrier_id, tok)` | owned list + links | `halt_queue`, `native_held_carriers` |
| `agent_mail_drain(agent_id, mail_id)` | many-to-many | the waking mail ids |
| `agent_turns(agent_id, n, at, cost, ms, toks, denials, approvals, ran_as, killed, estimated, cost_complete, cost_source, route json, reported json, …)` | owned log | PK (agent_id, n); index (agent_id, n DESC). One table for **both** the agent's `turns` list and the `turn_log`. Measured: for 1,106 of 1,187 agents, the stored list is exactly the log's last 8 rows; the other 81 predate the log. The tree reads `LIMIT 8` from the index; `node_tree_val` goes away. |
| `agent_turn_errors(agent_id, seq, at, text, ran_as)` | owned log | today `turn_error_log` |
| `agent_external_handles`, `agent_oracle_exchanges` | owned lists | retired and rare fields, kept exactly |

**Tree queries.** All are plain indexed SQL; times on the prototype (§8).

| Query | Time |
|---|---|
| children of the 483-child seat | 0.2 ms |
| top level | 0.09 ms |
| ancestors (recursive, at most 6 levels on live data) | 0.23 ms |
| descendants of the 1,145-agent subtree | 3.6 ms |
| lineage count of 62 generations | 0.19 ms |

**No closure table.** The tree is at most 6 levels deep (average 1.9). Maintaining a closure would
rewrite up to 1,145 × depth rows on a big move, which would turn today's trigger cost into
closure-maintenance cost. Decision 3 asks for a justification; this is it.

### 3.3 Docket

**`work_items`.** Active and archived together. It replaces the active `doc` rows, the archive
log rows, `work_index`, `work_list_summary` and all `work_read_*`.

| Group | Columns |
|---|---|
| keys | `id`; `org_id`; `slug UNIQUE (org_id, slug)`; `rev` |
| identity | `kind CHECK`; `title` |
| status | `status CHECK`; `status_at`; `blocked_reason`; `waiting_reason`; `dropped_reason` |
| people | `owner_id` → agents (+ `owner_generation`); creator principal columns (§3.0); `reviewer_id` (+ `reviewer_generation`); `last_updater_*` |
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
| `(org_id, coalesce(docket_at, updated_at) DESC, slug DESC)` | the list order |
| `(org_id, status) WHERE archived_at IS NULL` | active-only filters |
| `(org_id, owner_id)`, `(org_id, reviewer_id)`, `(org_id, created_by_id)` | lookups by person |
| `(org_id, coalesce(owner_id, created_by_id))` | the access rule's anchor |
| `(org_id, parent_item_id)`, `(org_id, superseded_by_id)` | child items and supersessions |
| `(org_id, attention_set_rev) WHERE attention_reason IS NOT NULL` | attention raises |

**Child and link tables:**

| Table | Kind |
|---|---|
| `work_item_participants(item_id, agent_id)` | many-to-many; indexes both ways |
| `work_item_dependencies(item_id, depends_on_id)` | many-to-many; indexes both ways |
| `work_item_holders(item_id, seq, agent_id, generation, from_at, by_*, derived)` | owned list; index (agent_id) for the item-scoped read grant |
| `work_item_acceptance(item_id, idx, text)` + `work_item_acceptance_checks(item_id, idx, seq, …)` | owned list + its list |
| `work_item_progress(item_id, list CHECK (done, next), pos, text)` | owned list |
| `work_item_events(item_id, seq, at, by_*, kind CHECK (history, evidence, decision, scope, verdict, review_packet, dismissal, …), …)` | the item's **append-only history as rows** (decision 7 point 2): one sequence of typed events instead of today's lists. Kind-specific columns hold each kind's fields; free text sits in a content column. The latest verdict and review packet are "the newest event of that kind": measured, 420 of 740 stored `candidate_verdict` values equal the last list entry and the other 320 are null, and all 52 non-null `review_packet` values equal the last entry. |
| `work_item_review_seats(item_id, seq, reviewer_id, holder_id, …)`, `work_item_review_seat_requests(item_id, seq, …)` | owned lists with state |
| `work_item_artifacts(item_id, artifact_id, …)` + `work_item_artifact_grants(item_id, artifact_id, agent_id)` | owned list + many-to-many |
| `work_item_findings(item_id, finding_id, …)` + `work_item_finding_decisions(…)` | owned list + its list |
| `work_item_delivery(item_id, stage, …)` | owned, at most 5 stages |
| `work_item_quick_staff_receipts(item_id, receipt_id, …)` | owned list |

### 3.4 Docket access is a query

The rule (`Org._work_can_read`) lets these read an item: the user; the owner; the creator; the
reviewer; a participant; a strict ancestor of the owner (of the creator when there is no owner).
As SQL:

```sql
WITH RECURSIVE down(id) AS (SELECT id FROM agents WHERE org_id = $org AND parent_id = $viewer
                            UNION SELECT a.id FROM agents a JOIN down d ON a.parent_id = d.id)
SELECT i.* FROM work_items i
WHERE i.org_id = $org AND ($viewer_is_user
   OR i.owner_id = $viewer OR i.created_by_id = $viewer OR i.reviewer_id = $viewer
   OR EXISTS (SELECT 1 FROM work_item_participants p WHERE p.item_id = i.id AND p.agent_id = $viewer)
   OR coalesce(i.owner_id, i.created_by_id) IN (SELECT id FROM down))
ORDER BY coalesce(i.docket_at, i.updated_at) DESC, i.slug DESC
```

**Measured:** run against the old JSON rows of the live copy, it returns exactly the engine's
5,041 (item, reader) pairs, with 0 differences either way (`probe/access_rule_check.sql`).

On the prototype tables it costs:

| Viewer | Time |
|---|---|
| a leaf agent | 0.46 ms |
| the 1,145-descendant coordinator | 2.1 ms |
| the user | 0.2 ms |

The seven `work_read_*` tables, their triggers and the per-save refresh go away. The Python
predicate stays as the test oracle.

### 3.5 Mail, notices and delivery

- **`mailboxes(agent_id PK, next_recv_seq)`.** The row a delivery locks; it replaces
  `mail_archive_bounds`.
- **`mail`.** One row per delivered copy (measured: no id or message id is shared between
  recipients). Columns:
  - `id`, `public_id UNIQUE`;
  - `recipient_id` → agents;
  - sender principal (§3.0);
  - `kind`, `relationship`, `at`;
  - `state CHECK (queued, delivering, delivered)`;
  - `recv_seq`, `seq_origin`, `mailbox`, `message_id UNIQUE`, `operation_id`, `client_op`;
  - flags: `restart_notice`, `model_only`, `retracted`, `stale` (+ details), `redelivered`;
  - `net_id`, `reply_to json`, `ev json`;
  - `extra`, `row_version`.

  The body lives in `mail_bodies(mail_id PK, body)`. Today's unread list, `delivering` batches and
  `mail_log` archive are the three states of one row: mail no longer moves between sections.
- **Indexes on `mail`:**

  | Index | Serves |
  |---|---|
  | `(org_id, recipient_id, recv_seq) WHERE state <> 'delivered'` | the inbox queue |
  | `(org_id, recipient_id, id DESC)` | the archive tail |
  | `(org_id, sender_id, at DESC, id DESC)` | Sent; replaces `mail_sent` and its trigger |
  | `(org_id, recipient_id, recv_seq DESC) WHERE recv_seq IS NOT NULL` | the next sequence number |

- **Delivery.**
  - `mail_attachments(mail_id, pos, name, path, bytes, missing)`.
  - `delivery_batches(id, tok UNIQUE, agent_id, at, via, mode, attempt, drive json, claim json, …)`
    with `delivery_batch_mail(batch_id, mail_id)`, `delivery_batch_deliveries(batch_id,
    delivery_id, role)`, `delivery_batch_notices` and `delivery_batch_segments`.
  - `mail_transition_receipts` + `mail_transition_deliveries`.
  - `manual_attempts` + `manual_attempt_mail`, `manual_chunk_calls`, `manual_chunks`.
- **Steer records.**
  - `steer_records(id, agent_id, at, level, visible_id, delivery_id, attempts, retried,
    confirmed_duplicate, fold, where_, outcome)`, with the text in `steer_texts` and
    `steer_record_segments`, `steer_record_mail(steer_id, mail_id)` and
    `steer_record_deliveries(steer_id, delivery_id, role)`. The chat tail index
    `(org_id, agent_id, at DESC, id DESC)` is kept (0016's shape).
  - `steer_attempts` + `steer_attempt_mail`, `steer_attempt_tokens`.
- **`notices(id, agent_id, at, text, ev json, state CHECK (pending, delivered))`.** Today's
  pending notices and `notice_log` are two states of one table. Indexes
  `(org_id, agent_id, id) WHERE state = 'pending'` and `(org_id, agent_id, at DESC, id DESC)`.
- **User mail and the org inbox:**
  - `user_mail(id, public_id, sender_*, kind, at, urgent, urgent_reason, read_at, ev json)` +
    `user_mail_bodies`; today's inbox and the dismissed archive are its states;
  - `user_outbox(id, recipient_id, …)` + bodies;
  - `org_inbox(id, public_id, dir, peer, by_*, at, state, state_at, net_id)` + body +
    `org_inbox_attachments`.

### 3.6 Questions, audiences, watchdogs, documents, reservations

| Table | Replaces | Notes |
|---|---|---|
| `asks(id, public_id, agent_id, kind CHECK (ask, credit, scope), status CHECK, at, resolved_at, rev, reason, header, question, answer_mail, old_grant, new_grant, granted, notice)` | three doc blobs, each rewritten whole on every change | with `ask_questions(ask_id, pos, …)`, `ask_question_options(…)`, `ask_answer_selections(…)`, `ask_work_items(ask_id, item_id)` (many-to-many) and `scope_request_items(ask_id, pos, kind, path, mode, tool, decision)`. Indexes `(org_id, agent_id, status)`, `(org_id, status) WHERE status IN ('open', 'pending')`, and the resolved-recent order (0018's shape). |
| `audience_grants(grantee_id, grantor_*, granted_at, reason, delegated_by_id)` | the audiences blob | PK (grantee, grantor); index (grantor). `_has_audience` on every send becomes one key probe. |
| `audience_requests(…)` | the requests blob | |
| `watchdogs(id, public_id, owner_id, name, kind CHECK, target, pattern, interval_s, state CHECK, notice, once, at, fired, last_check, checks_run, last_output, last_exit, last_fired, paused_why, history_retained, spent_at, high_water json)` | `watchdogs` and `watchdog_tombs` | Each live dog has one `check` job (§2.7). |
| `watchdog_events(watchdog_id, seq, at, gist, body)` | each dog's ring and the history log | |
| `documents(id, public_id, agent_id, at, title, format, file, bytes)` + `document_bodies(document_id PK, body)` | the presentations log | The gallery lists columns; opening a document is a key read. |
| `reservations(id, public_id, owner_id, item_id, resource, candidate, base, state CHECK, created_at, updated_at, expires_at, heartbeat_at, stale_s, integration_key, integration_receipt, landed_at, release_receipt, successor)` + `reservation_paths(reservation_id, path)` | the reservations blob (never pruned) | `UNIQUE (org_id, resource) WHERE state = 'held'` and `UNIQUE (org_id, integration_key)` (§2.2) |

### 3.7 Logs and receipts

- **`events(id, at, op, actor_*, item_id, detail json)`**, with `event_agents(event_id, agent_id,
  role)` (many-to-many: actor, node, to, grantee, from and list members) and
  `event_warnings(event_id, pos, text)`. Index `(org_id, agent_id, event_id DESC)` on
  `event_agents`, so the history panel takes 0.14–0.2 ms (74 ms today). `detail` keeps each
  operation's own payload (70 distinct operations; Q1).
- **`op_receipts(id, public_id, agent_id, gen, tool, key, fp, cls, outcome, at, mint_ms, targets
  json, result json)`** + `op_receipt_effects`. Index `(org_id, agent_id, key)`.
- **`lifecycle(id, operation_id, kind, state, at, …)`.** Index `(org_id, operation_id, state)`.
- **The custody receipts** (0013: `receipts`, `receipt_owners`, `receipt_carriers`) are already
  relational. They move to the shared layout with `org_id`.

### 3.8 Scheduling and the feed

| Table | Purpose |
|---|---|
| `jobs(id, org_id, kind CHECK, agent_id, item_id, watchdog_id, run_at, state CHECK (queued, running, done, failed, cancelled), attempts, lease_owner, lease_until, last_error, dedupe_key)` | §2.7 |
| `turn_queue(id, org_id, agent_id, lane, enqueued_at, state CHECK (waiting, running, done, cancelled), lease_owner, lease_until, pid)` + `turn_admission(singleton, slot_limit, last_org_id)` | §2.4 |
| `engine_instances(id, host, pid, started_at, heartbeat_at)` | the process leases refer to it |
| `changes(org_id, rev, pos, entity, entity_id, op CHECK (insert, update, delete))` | PK (org_id, rev, pos); §2.5 |

### 3.9 What is removed

These go, along with their triggers and functions:

- the side tables of migrations 0004–0019: `node_index`, `foreground_*`, `node_tree_val`,
  `work_index`, `work_read_*`, `work_list_*`, `mail_sent`, `mail_archive_bounds`;
- the JSON expression indexes;
- `json_extract`.

The old per-org schemas (`org_N.doc`, `nodes`, `log_d`, `log_l`, `meta`) stay, unchanged and
unused, for one release (Q3 answer). The release after drops them.

### 3.10 Deliberate duplicates (denormalization), with the reason for each

1. **The agent presence flags** (`is_frozen` …) beside their payload in `agent_runtime`. The hot
   row must answer "is it frozen" without the cold row. One function writes both in one statement,
   and a test asserts they agree.
2. **`agents.ord`.** The stable display order the product has today.
3. **`orgs.revision` and `changes`.** The commit log the feed needs (§2.5).

Nothing else is stored twice.

## 4. How today's code maps onto the target

| Today | Target |
|---|---|
| `store.load_org` / `cached_org` / `LazyDoc` / compare-on-save; `orgtx.org_tx` lock plans | `Tx` + domain modules. During the transition, a compatibility view (rev 1's mappers, §6.2) presents the old dictionary for code not yet moved |
| `ledger.Org` methods (≈400) | domain functions over rows. Rules kept; whole-org walks replaced (audit §3.3 is the checklist) |
| supervisor loops (30 s auto-resume, 20 s keeper, 5 s watchdogs, 1 s drain) | jobs (§2.7) |
| `turnslots.FairSlots` (in memory) | `turn_queue` (§2.4) |
| `api._sync_revs` frame revs, `hub_changed` coalescing, whole-tree refetch | the change log, catch-up by rev (§2.5) |
| `node_index`, `work_index`, `work_read_*`, `work_list_*`, `mail_sent` … read models | the base tables' own columns and partial indexes |
| `workread.refresh` / `worklistmeta.refresh` on every save | gone (§3.4) |
| per-process `cached_org` snapshots | gone. Reads are targeted; caches are `(org, rev)`-keyed |
| `rename` rewriting every reference | `UPDATE agents SET name` |

## 5. Converting existing data: one data migration

### 5.1 One path for every starting version

| Starting point | Route to the converter |
|---|---|
| **v3.0.9, 3.1.0 and the other 3.0.x** (PostgreSQL, per-org key+JSON schemas) | `pgstore.migrate` applies what is pending (0020 on 3.0.9, then the new migration), as every release does. The 3.0.x releases differ only in which of 0001–0020 they have applied, and all are applied before the converter runs. |
| **v2.1.14** (SQLite) | The first-launch import (`tools/pypg/pgimport.py`) applies every migration, creates each org's legacy schema, and COPYs the SQLite rows into the old tables with counts and checksums. It is unchanged, so **the new migration only adds the shared tables and never alters or drops the old per-org layout**. Then the engine starts and runs the same converter. |

**Rehearsed (measured, today):** the user's real pre-conversion SQLite data (4 orgs, 242 MB for the
largest) was copied with SQLite's backup API into a throwaway root and imported with the product's
own `pgimport` code into my dev cluster. All four orgs imported, every row was read back byte for
byte, in 39 s (`probe/v2import-report.json`). The converter is the next step of the same rehearsal.

### 5.2 The converter

`orgtree/convert/` runs at engine start, after `pgstore.migrate` and before anything serves. For
each org not yet converted, in **one transaction**:

1. **Read** every record of every kind from the legacy schema, with the heal a new build's first
   load applies today (`Org.__init__` heals, `heal_decoded_box`), so the new rows hold what the
   engine would see.
2. **Map** each record to rows (rev 1's mappers: `split`), resolve names to surrogate keys, and
   `COPY` the rows into the shared tables.
3. **Read everything back** through the inverse mapping (`join`). Compare each record with step 1,
   as canonical JSON with exact types. Timestamps compare as instants at millisecond precision. A
   timestamp that cannot be parsed is not dropped: its column stays `NULL`, its original text goes
   to the record's `extra`, and the report lists it (Q2 answer).
4. **Check the old rows** by checksum, before and after (they are never written).
5. **Record** the result in `conversion_runs(org_id, format, started_at, finished_at, per-kind
   counts, source_sha256, result_sha256, healed, extra_keys, nul_fields, bad_timestamps)` and in
   `public.receipts`.
6. **Commit.** If any check fails, roll back. The org stays on the old layout, and the engine
   refuses to start with the org, kind, record, field and both values. They are also written to
   `diagnostics/model-conversion.json`.

**Time** (inferred from the audit's decode costs; measured in each rehearsal). The largest org has
about 165,000 rows and 190 MB of JSON text. Reading and decoding it takes 1–2 s, `COPY` a few
seconds, and the read-back about the same: under a minute in total, once, with the host's existing
"updating the database" progress.

### 5.3 Old data and rollback

The legacy per-org schemas are never written after conversion and stay for one release. A rollback
to 3.1.0 is the offline tool `tools/pypg/model_rollback.py` (operator only, refuses while the engine
runs). It:

1. drops the shared tables;
2. deletes the new migration's `schema_migrations` row;
3. deletes the `conversion_runs` rows.

The previous release then runs on the untouched legacy schemas. Writes made after the conversion
are lost, which is the rule `pgimport`'s rollback already states.

### 5.4 Rehearsals (decisions 4 and 8)

Before the local alpha build, and again before the release:

- **3.x data.** A fresh `pg_dump` of the live cluster (read-only, coordinator-approved). It is
  restored into my dev cluster, migrated (0020 = 3.1.0, then the new migration) and converted. The
  intermediate 3.0.x states are the same layout with fewer migrations applied, and are shown
  identical by also converting a clone migrated only to 0017 (the state of the 2026-09-29 import).
- **2.1.14 data.** The pre-conversion SQLite files, copied with the backup API, then `pgimport`,
  then the converter (step 1 done today, §5.1).
- **For each rehearsal, recorded on the item:**
  - per org and kind, record counts and checksums before and after;
  - heal counts, `extra` keys, U+0000 fields and unparseable timestamps;
  - the time taken;
  - the tests.

## 6. Release plan

### 6.1 What ships with the migration, and what comes later

There is **one data migration**: the release that converts data (the first published after 3.1.0;
decision 6) contains the whole schema of §3. Later releases change code only.

| Target point (decision 7) | In the migration release | Later, with no data change |
|---|---|---|
| 2, 3, 4: schema, integrity, partial indexes | **all** | – |
| 1: database as the source of truth, one transaction per action | **all writes** go through domain functions over rows, and every hot read (§2.6) is targeted. The compatibility view (§4) remains only for rare paths not yet moved, each listed in the release notes. | moving the remaining rare paths; deleting the compatibility view |
| 9: domain modules | agents, docket, mail, questions, audiences, documents, reservations, feed, org (those §2.8 lists as owning tables) | providers and accounts keep their stores |
| 7: targeted reads | every screen in the before/after table, the per-turn prompt, the agent tools | – |
| 6: change log + `NOTIFY` | the engine writes `changes` in every transaction, and the websocket frames carry `rev`. The renderer keeps "refetch on change", through the targeted endpoints, so no whole-tree rebuild. | the renderer applies changes by rev with no refetch, and the polling goes away |
| 8: jobs | the table ships. Delivery and watchdog checks move in this release; their 1 s and 5 s scans are the ones that wake on idle orgs. | auto-resume, keepers, reminders and retries move one by one. The scans they replace are already cheap on the new tables (partial indexes), so this is architecture, not speed. |
| 5: turn queue | the table ships | `turnslots` moves to `turn_queue` together with the leases of point 10 |
| 10: stateless engine, several processes | no whole-org snapshots; large texts out of hot rows | run a second process: needs the turn queue and job leases first |

### 6.2 The first prototype (decision 8)

**Definition: the smallest slice that converts real data and runs the app on the new tables.**

1. **The schema.** The migration that creates all of §3 (shared tables, constraints, indexes).
2. **The converter.** For every kind of record, with the read-back check, the report and the
   refusal (§5.2).
3. **The compatibility view.** The storage layer loads and saves every kind of record through the
   rev 1 mappers onto the new tables. All existing engine code therefore runs unchanged on the new
   tables, and the old tables are never read again.
4. **Native agents and docket modules.** Reshaping, the tree reads, the per-turn neighbourhood, the
   docket access, list, get and counts run as targeted queries and short transactions. These are the
   paths that motivated the item, and the first proof of the module pattern.
5. **Tests.** Round trip, the conversion tests, the access-equivalence test, the
   no-JSON-in-lookups `EXPLAIN` guards and the history-growth tests (§9), for the parts above.

When (1)–(5) pass, both rehearsals (§5.4) run. I report to the coordinator, who gives
p03-ws4-rcfamilies the go for a local alpha build (decision 8). The before/after table in §8 is
measured on the prototype at that point.

### 6.3 Landing order on v3 (no release in between; decision 6)

| Step | Contents |
|---|---|
| 1 | The schema migration and the converter, with the compatibility view, so the app runs on the new tables. It lands only when all three are complete, because the converter leaves no org half-converted. |
| 2 | The native agents module (reshapes, tree, prompt neighbourhood). |
| 3 | The native docket module. **This completes the first prototype: rehearsals, then the alpha build.** |
| 4 | The mail module and delivery jobs; the watchdogs module and its jobs. |
| 5 | Questions, audiences, documents, reservations, events and org settings modules. |
| 6 | The change log driving the websocket frames. |
| 7 | **The release candidate:** final rehearsals, then the coordinator's build and publish. |

Each step is reviewed separately, with targeted tests, and its before/after numbers are recorded on
the item.

## 7. Effort and risk (inferred)

| Part | Size | Main risk |
|---|---|---|
| Schema and migration | small | getting a constraint wrong on real data (the rehearsals catch it) |
| Converter + mappers for about 40 record kinds | large | a legacy shape the mapper did not foresee (refused, never lost) |
| Compatibility view | medium | one whole-collection walk left on a hot path (the growth tests catch it) |
| Native agents and docket modules | large | behaviour drift (today's suites are the contract) |
| Mail, delivery jobs, the other modules, the feed | large | delivery ordering and duplicates (the custody-receipt tests stay) |
| Turn queue and multi-process (later) | medium | lease handling |

The first prototype (§6.2) is the large majority of the risk. Everything after it moves paths
already running on the new tables.

## 8. Expected gains

**Measured** on prototype tables (`probe/proto_schema.sql`, a clone of the live copy, with the
columns and indexes these lookups need). Median of 5, warm. Writes run in rolled-back transactions
with deferred constraints fired.

| Lookup or write | Today (audit) | Prototype |
|---|---|---|
| Re-parent 400 agents (with FK checks) | 1,006 ms with triggers; 657 ms engine CAS (440 ms without triggers) | **6.2 ms** |
| Generation change on 400 agents | 1,788 ms | **5.1 ms** |
| Cost-only change on 400 agents | 717 ms | **4.3 ms** |
| Deliver 200 mails | 243 ms | **2.4 ms** |
| Children of the 483-child seat | 1.2 ms (`node_index`) | 0.2 ms |
| Descendants of the big seat (1,145) | one statement per generation | 3.6 ms |
| Live / frozen-live / halted agents; distinct accounts | 0.24 / 153 / 40 / 93 ms | 0.04 / 0.07 / 0.05 / 0.03 ms |
| Cost total | 54 ms | 0.13 ms |
| Lineage count of 62 generations | trigger-kept | 0.19 ms |
| Docket counts by status | 1,000–1,183 ms (archive projection) | **0.22 ms** |
| Docket readable by viewer, first page (leaf / coordinator / user) | 58–71 ms | 0.46 / 2.1 / 0.2 ms |
| Archived item by slug / by owner | 108 / 130 ms (without the side table) | 0.05 / 0.03 ms |
| History: events / notices of an agent | 74 / 38 ms | 0.14–0.2 / 0.07 ms |
| Sent, newest 50 | 0.06 ms (side table + trigger) / 293 ms (JSON) | 0.07 ms (plain index) |

**Expected end to end** (inferred: the measured total today minus the storage part removed;
replaced by measurements at the first prototype):

| Screen or operation | Today | Expected |
|---|---|---|
| Tree after a commit | 1.2–1.45 s full rebuild | a change-log catch-up plus refetch of the changed records: under 50 ms |
| Docket list / archive page / agent `orgtree_work list` | 66–87 ms | 5–15 ms |
| History panel | 148–168 ms | under 10 ms |
| Per-turn prompt | ≈140 ms | 10–30 ms |
| Desk chat open (big seat) | 158–244 ms | under 60 ms |
| Big reshape (move, demote, insert-above, self-subjugate) | 0.74–0.96 s | 0.1–0.3 s |
| Unreachable top-level swap | 1.64 s | under 0.3 s |
| Background idle cost | whole-agent decodes every 30 s per org; scans every 1–20 s | none: a worker sleeps until the next due job or `NOTIFY` |

## 9. Tests

1. **Round trip** per record kind: property tests, every live-copy record in the rehearsals, and
   edge cases. The edge cases are absent versus null, int versus float, U+0000, unknown keys,
   timestamp offsets, and the legacy shapes `heal` handles.
2. **No JSON in lookups.** Every repository query under `EXPLAIN` on a seeded org with 10× history
   fails on a sequential scan of a growing table or on a JSON operator. A source scan in
   `tools/source-audits.py` refuses `->>`, `::json` and `json_extract` in query strings outside the
   converter.
3. **No growth with history.** Statement counts and rows read, at 1× and 10× archived agents, items,
   mail and events, for every hot path and every reshape. This extends `test_reshape_history_pg.py`.
4. **Integrity.** Each constraint refuses its violation inside the transaction: a tree loop, a second
   held reservation, a cross-org link, a duplicate slug, a reused retired slug.
5. **Concurrency.** Two writers on the same row are stopped by `row_version`. A turn-queue fairness
   test (first come within an org, round-robin across orgs) and a lease-expiry test.
6. **Conversion.** Fixtures for both starting points. Every planted fault is refused with its
   message and nothing written: a mismatched row, a dangling parent, a bad type, an extra key, an
   unparseable timestamp. Rollback-tool tests.
7. **Access equivalence.** The SQL rule against `_work_can_read` for every (viewer, item) pair.
8. **The behaviour suites** (lifecycle, docket, mail, visibility, receipts) stay green at every
   landing step: they are the contract for moving rules into modules.
9. **Mutants on the risky code**, for the reviewer: the converter, compare-and-set, the access rule,
   the tree-loop check, and leases.

## 10. Questions still open

- **Q6. Surrogate keys and tombstones** (§3.0). This makes rename trivial and keeps every reference
  a real key. The cost is one name-to-id lookup at the API boundary. Deleting an agent keeps a
  tombstone row; today the row is removed outright and items keep a name with a `deleted` mark.
  Same visible result. Agreed?
- **Q7. Shared tables in `public`, or in a dedicated `orgtree` schema?** I recommend a dedicated
  schema: it separates the engine's tables from the custodian's bookkeeping.
- **Q8. Change-log retention.** 24 h and at least 10,000 revisions?
- **Q9. Scope of the migration release** (§6.1). Is it right that the jobs move for delivery and
  watchdogs only, the renderer keeps refetching, and multi-process comes in a later release?
