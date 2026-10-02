# Orgtree v3 data model on PostgreSQL: design

Docket item: `v3-storage-keep-indexed-fields-in-real-postgresq` (drag-opus, 2026-10-02). Read with the
audit, [`pg-columns-audit.md`](pg-columns-audit.md), which measures today's costs on a copy of the live
data. Status: **design for review**. Only stage 1 is meant to start before the coordinator (and, if
it chooses, the user) has read this.

## 0. The decisions in one page

1. **One table per kind of record, with typed columns.** Agents, docket items, mail, notices,
   questions, audiences, watchdogs, documents, reservations and every log become their own tables.
   Every field the engine filters, joins, sorts or counts on is a typed column with an index.
2. **Links follow the user's rule.**
   - A many-to-one link is a foreign-key column on the "many" side: `agents.parent_id`,
     `work_items.owner_id`, `mail.recipient_id`.
   - A many-to-many link is a link table indexed both ways: `work_item_participants`,
     `work_item_dependencies`, `agent_dir_grants`, `audience_grants`, `event_agents`.
   - A list of sub-records that belongs to one parent (an item's evidence, an agent's turns) is a child
     table that points at its parent.
   - No list is stored inside a row.
3. **The columns are the only copy.** Nothing is stored twice. The engine writes the columns itself
   in the statement that writes the record. There are no per-row triggers and no derived side
   tables. The 0004–0020 side tables and their 18 triggers are retired.
4. **JSON stays only for free-form payloads** that nothing filters on: provider-reported records
   (`cache_continuity`, `envelope`, `codex_route_last` …) and per-event detail variants. Each lives
   in its own JSON column of the record it belongs to. Whether that is acceptable, or whether those
   should be normalized too, is open question **Q1** (§9).
5. **The engine keeps working while the storage changes underneath it.** `ledger.Org` keeps its
   in-memory dictionary interface. `store.py` loads and saves each kind of record through a mapper
   to the new tables, and the hot paths (§4.5) stop walking whole collections and ask the database
   instead. This is how 70,000 lines of business logic move in landable stages, not one rewrite.
6. **One conversion path for every starting version.** A v2.1.14 install goes through the existing
   SQLite→PostgreSQL import (`tools/pypg/pgimport.py`, unchanged), which produces the same old
   key+JSON tables a v3.0.9 or 3.1.0 install already has. Then the same converter runs on both. It
   runs at engine start, one transaction per org per stage, and reads every record back. Every
   record must match, or the engine refuses to start and names the record. The old tables are never
   modified, and are kept for rollback.
7. **Stages:**

   | Stage | Scope |
   |---|---|
   | 1 | agents and their turns |
   | 2 | the docket |
   | 3 | mail, notices, delivery and steer records |
   | 4 | questions, audiences, watchdogs, documents, reservations, events, receipts and settings |
   | 5 | removal of the old tables, a release later |

   Each stage has its own migration, converter step, tests and before/after table.
8. **Expected gains** (prototype on the live-data copy, §7):

   | Operation | Today | Prototype |
   |---|---|---|
   | Re-parent 400 agents | 1.0 s | 6 ms |
   | Org-tree docket counts | 1.0–1.2 s | 0.2 ms |
   | Docket "items I can read" | 58–71 ms | 0.5–2 ms |
   | History panel lookups | 112 ms | 0.3 ms |
   | Delivering 200 mails | 243 ms | 2.4 ms |

   End to end, every hot screen and reshape should land well under 100 ms of storage time. The
   rest is Python work this design does not change.

## 1. What the user asked for, and what this design does not do

The user's direction, 2026-10-02:

- 11:35Z: "take advantage of postgres's structure indexing, and keep data that we want to index in
  their own postgres columns".
- 11:36Z: "a rewrite of the data model … to take advantage of postgres indexed lookups".
- 11:40Z and 11:42Z (decision 3): "only many to many relationships get a separate linking table,
  many to one get a new column in the many side". There are no embedded lists, and lineage is
  `parent_id` plus a recursive query.
- 11:42Z: "standard database design" (third normal form).
- 11:43Z (decision 4): the conversion must work from both v3.0.9 and v2.1.14, rehearsed on copies
  of real data.

**Not in this design:**

- changing what the product does;
- changing one-schema-per-org;
- rewriting the ledger's business rules (they keep running in Python, on the same dictionaries);
- moving side stores outside the org database (reply events, chat-window index, file deliveries).

Section 4.7 lists which whole-document paths go away and when.

## 2. Principles

| # | Principle |
|---|---|
| P1 | **Columns are the source of truth.** A value lives in exactly one place. The two deliberate exceptions are listed in §3.12, with the reason for each. |
| P2 | **The engine writes every column itself, in the statement that writes the record.** No trigger derives data from another row. Statement-level "revision bumps" (one tiny `UPDATE` per statement, §4.6) are the only triggers left. |
| P3 | **Every lookup has an index, and a test proves it.** A test runs `EXPLAIN` on every repository query and fails on a sequential scan of a growing table, or on a JSON operator in a lookup. |
| P4 | **Exact round trip.** dictionary → rows → dictionary gives back the same dictionary: the same keys, values and JSON types, int and float kept apart, absent kept apart from null. Key order is canonical (the order `schema.py` declares), not the order of the original text (§3.1). |
| P5 | **Old data is never modified.** The converter reads the old tables and writes new ones. The old tables stay, unchanged and unused, until stage 5 (a later release). |
| P6 | **Refuse rather than guess.** Any value the mapper cannot represent exactly stops the conversion, and the engine does not start. The message names the org, the record, the field and both values. |
| P7 | **Nothing grows with archived history on a hot path.** Every hot query is bounded by an index on live rows, or on the rows of one agent or one item. The tests in the style of `test_reshape_history_pg.py` count statements and rows against 1× and 10× history. |
| P8 | **Landable stages.** Each stage adds tables and a converter step, switches its readers and writers, and leaves every later kind of record on the old layout. The engine runs correctly at every stage boundary. |

## 3. The schema

Everything below lives in each org's schema (`org_<id>`), beside the old tables.

### 3.1 Conventions

- **Ids.** These stay as they are: text agent ids (`drag-opus`, `coordinator-opus@61`), docket slugs,
  mail ids and the other record ids. Log-like records keep a `bigint` sequence.
- **Timestamps.** `text COLLATE "C"`, exactly as the engine writes them, with a format `CHECK`
  (ISO-8601, `Z` or an offset). Three reasons:
  - The engine compares and sorts timestamps as strings everywhere. The C collation gives
    PostgreSQL the identical order.
  - The round trip is exact. 1,843 restart-notice mails carry `+HH:MM` offsets, and a `timestamptz`
    column would rewrite them.
  - The format check still rejects garbage.

  Open question **Q2** asks whether to prefer `timestamptz`.
- **Numbers.**
  - Always-integer fields are `bigint` or `integer`.
  - Always-float fields are `double precision`. PostgreSQL prints the shortest exact form, so a
    Python float round-trips exactly.
  - Fields whose stored values mix the two (`grant`: 1,198 ints and 10 floats on the live copy) are
    `numeric`. The mapper writes a Python float by its `repr`, so `62.0` keeps its scale, and reads a
    value without a fractional part or exponent back as an int.
- **Absent versus null.** SQL `NULL` means the key is absent. Some fields are both left absent and
  stored as an explicit `null` on real data:

  | Record | Fields |
  |---|---|
  | agents | `occupancy`, `cli_compactions`, `team_charter`, `last_status`, `prev_status`, `frozen`, `inflight`, `halt`, `pending_switch`, `remote_controlled` |
  | docket items | `waiting_reason`, `dropped_reason`, `parent`, `reviewer`, `candidate_verdict`, `review_packet` |

  For those, a scalar column gets a companion `<field>_null boolean`, and a JSON column stores JSON
  `null`. A field that is always present uses `NULL` for null.
- **Strings containing U+0000.** PostgreSQL text cannot hold them (neither can `jsonb`). 17 records
  on the live copy have one, in mail bodies, steer logs and archived docket items. The mapper keeps
  such a field in the record's `extra` column (JSON text, where `\u0000` is legal) and leaves the
  column `NULL`. Lookups never filter on those fields (bodies and notes). The conversion report
  counts them.
- **Unknown fields.** Each record table has `extra text` (a JSON object of top-level keys the schema
  does not know: legacy or future fields). It is expected to be empty. The converter reports every
  key it puts there, and nothing reads it except the mapper.
- **Compare-and-set.** Each mutable table has `row_version bigint NOT NULL DEFAULT 1`. A save is
  `UPDATE … SET <changed columns>, row_version = row_version + 1 WHERE id = $1 AND row_version = $2`.
  This replaces today's comparison of the whole old JSON text, and has the same guarantee: a lost
  update raises `StaleWrite`.
- **Foreign keys.**
  - **Enforced** where the engine guarantees the target exists while the referencing row exists:
    the tree links (`parent_id`, `predecessor_id`, `successor_id`) and records an agent owns (its
    mailbox, notices, grants, turns). Owned records use `ON DELETE CASCADE`, which matches `Org.delete`
    erasing them. Every enforced key is `ON UPDATE CASCADE`, so a future SQL rename re-points them.
  - **Indexed but not enforced** where the record deliberately outlives the agent, or may name a
    non-agent principal (`@user`, `system`, `@org:…`): docket owner, creator, reviewer and holder
    after a permanent delete (the item keeps the id with a `deleted` mark), mail sender and event
    actor.

  Every such column is named `*_id` and indexed. The rule for each column is in its table below.

### 3.2 Agents (stage 1)

**`agents`.** One row per agent (today's `nodes` row). It replaces `nodes`, `node_index`,
`foreground_meta`, `foreground_parents` and `node_tree_val`. The groups of columns:

| Group | Columns |
|---|---|
| identity and tree | `id text PK`; `ord integer` (table order); `parent_id text FK agents NULL` (NULL = top level); `state text CHECK (live, archived, unrecoverable)`; `title`; `model`; `credit_grant numeric`; `charter`; `team_charter` (+`_null`); `created`; `archived_at`; `rescinded_at`; `ui_order double precision` |
| lineage | `seat_id`; `lineage`; `generation integer`; `predecessor_id FK`; `successor_id FK`; `bearer_state CHECK`; `lost_reason` |
| session | `session_id`; `transcript_incarnation`; `reply_incarnation`; `pid`; `session_began_at`; `session_unrun boolean`; `cheap_compacted boolean`; `compacted_unrun boolean` |
| accounts | `account`; `account_primary boolean`; `codex_account`; `codex_thread`; `codex_native_home`; `antigravity_account`; `antigravity_conversation` |
| mail | `mailbox_id text UNIQUE`; `mail_seq integer` |
| scope (today a nested object) | `permission_mode`; `org_visibility`; `effort`; `account_fallback boolean`; `model_version`; `prefer_reserve boolean`; `tool_bash`, `tool_web`, `tool_edit`, `tool_subagents` (boolean); `cheap_compact_enabled boolean`; `cheap_compact_occ numeric` |
| usage and cost | `cost_usd double precision`; `cost_usd_unknown boolean`; `context_window`; `occupancy` (+`_null`); `occupancy_est`; `cli_compactions` (+`_null`); `cli_boundary_offset`; `turn_seq`; `turn_est_cost_at`, `turn_est_cost_usd`, `turn_est_cost_extra`; `turn_est_toks_at`, `turn_est_toks_n` (the two fixed tuples, as columns) |
| status | `last_status_status`, `last_status_summary`, `last_status_at` (+`last_status_null`); the same four for `prev_status` |
| runtime counters and markers | `docket_reminder_at`; `working_activity_at`; `cache_keepalive_at`; `limit_locked boolean`; `config_seq`; `hard_fail_run`; `limit_run`; `net_fail_run`; `net_fail_since_ms bigint`; `untrusted_limit_run`; `last_turn_mcp_tool_count`; `last_turn_mcp_fingerprint`; `last_turn_mcp_tools_id text FK tool_lists` |
| runtime records (JSON, Q1) | `frozen`, `halt`, `inflight`, `turn_ended`, `pending_switch`, `remote_controlled`, `admit_once`, `unstuck`, `last_wall`, `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_total`, `codex_usage_reset`, `desktop_import`: `json` columns. SQL `NULL` = absent; JSON `null` = present null. |
| mail drain (today an object) | `mail_drain_retry_at`; `mail_drain_failures`; `mail_drain_suspended` (its `ids` list moves to a table) |
| bookkeeping | `extra text`; `row_version bigint` |

Indexes on `agents`:

| Index | Serves | Today's equivalent |
|---|---|---|
| `(parent_id, ui_order, created, ord)` | children in display order, peers, subtree walks | `node_index_children` |
| `(ord) WHERE state = 'live'` | live agents | `node_index_active` |
| `(parent_id, ui_order, created, ord) WHERE state = 'archived' AND successor_id IS NULL` | the retired pile under a seat | `node_index_children` |
| `(predecessor_id)`, `(successor_id)` | lineage walks | `node_index_predecessor` |
| `(seat_id)`, `(session_id)`, `(lineage)`, `UNIQUE (mailbox_id)` | lookups by seat, session or lineage | none (walks) |
| `(ord) WHERE frozen IS NOT NULL AND frozen::text <> 'null'`, and the same for `halt`, `remote_controlled`, `pending_switch`, `inflight` | "which agents carry a freeze, a halt …" | `strpos` + parse over every row |
| `(account) WHERE account IS NOT NULL` | distinct accounts | parse over every row |
| `(ord) WHERE state = 'live' OR frozen IS NOT NULL` | policy candidates | `ix_policy_candidates` (JSON) |
| id gram search (0004's GIN over `orgtree_id_grams(id)`, now on `agents`) | the canvas search box | `node_index_search` |

**Child and link tables**

| Table | Kind | Keys and columns |
|---|---|---|
| `agent_dir_grants` | many-to-many agent ↔ folder | `agent_id FK CASCADE`, `pos`, `path`, `mode CHECK (rw, ro)`; PK (agent_id, pos); index (path) |
| `agent_mcp_servers` | many-to-many agent ↔ MCP server | `agent_id`, `pos`, `server`; index (server) |
| `agent_tool_prompts` | owned list (`last_denials`, `last_approvals`) | `agent_id`, `kind CHECK (denial, approval)`, `pos`, `tool`, `arg`, `cwd` |
| `tool_lists`, `tool_list_items` | value shared by many agents | `last_turn_mcp_tools` is one of only 40 distinct lists across 1,045 agents (measured). Stored once per distinct list (`id` = sha256 of the list; `pos`, `tool`), referenced by `agents.last_turn_mcp_tools_id`. 71,000 embedded strings become about 2,700 rows. |
| `agent_carriers`, `agent_carrier_mail`, `agent_carrier_tokens` | owned list (`halt_queue`, `native_held_carriers`) | one row per carrier (`halt_id`, `text`, `view`, `ping`, `ping_reason`, `from_id`, `at`, `delivery_id`, `claim json`); its `mail_ids` and `toks` as link rows |
| `agent_mail_drain` | many-to-many agent ↔ mail | `agent_id`, `mail_id` (`mail_drain.ids`) |
| `agent_external_handles`, `agent_oracle_exchanges` | owned lists | retired and rare fields, kept exactly |
| `agent_turns` | owned log | `agent_id FK CASCADE`, `n` (the turn number), `at`, `cost`, `ms`, `toks`, `denials`, `approvals`, `ran_as`, `killed`, `estimated`, `cost_complete`, `cost_source`, `route json`, `reported json`, …; PK (agent_id, n); index (agent_id, n DESC). It replaces **both** the agent's `turns` list and the `turn_log` section (below). |
| `agent_turn_errors` | owned log | `agent_id`, `seq`, `at`, `text`, `ran_as` (today `turn_error_log`) |

Why one turns table: on the live copy, for **1,106 of 1,187 agents the `turns` list stored in the
agent row is exactly the last 8 rows of that agent's `turn_log`** (measured). The other 81 agents
predate `turn_log`; their stored turns become their only turn rows.

- The dictionary view gets `turns` = the newest 8 rows by `n`, and `turn_log` = all rows.
- A turn appends one row. Today it rewrites the whole agent row.
- `node_tree_val` (0017, a trigger-kept trimmed copy for the tree) goes away: the tree reads
  `LIMIT 8` from the index.

### 3.3 The tree: children, ancestors, descendants, lineage

The tree is `agents.parent_id`, and nothing else stores it. All four queries are plain indexed SQL;
times are on the prototype tables of the live copy (§7):

| Query | SQL shape | Measured |
|---|---|---|
| Children of a seat, in display order | `WHERE parent_id = $1 ORDER BY ui_order, created, ord` (top level: `parent_id IS NULL`) | 0.09–0.2 ms, 483 children |
| Ancestors (for access, chain clamps, `is_ancestor`) | recursive CTE up `parent_id`, one primary-key probe per level | 0.23 ms |
| Descendants (subtree moves, dissolve, chart) | recursive CTE down the `(parent_id, …)` index | 3.6 ms for 1,145 descendants |
| Lineage (generations of a seat, "consult" target) | recursive CTE over `predecessor_id` | 0.19 ms for 62 generations |

**No ancestry (closure) table.** The live tree is at most 6 levels deep (1.9 on average, measured),
and the recursive queries above already cost well under a millisecond per agent. A closure table
would have to be rewritten on every move: up to 1,145 descendants × depth rows for the big seat. It
would turn today's trigger cost into a closure-maintenance cost. If org depth ever grows past about
20 levels, the queries in `test_reshape_history_pg` will show it first.

### 3.4 Docket (stage 2)

**`work_items`.** One row per item, active and archived together. It replaces the active `doc` rows,
the `work_items_archive` log rows, the header row, `work_index`, `work_list_summary` and every
`work_read_*` table. The groups of columns:

| Group | Columns |
|---|---|
| identity | `slug text PK`; `rev integer`; `kind CHECK (code, non-code)`; `title`; `objective` |
| status | `status CHECK (…)`; `status_at`; `blocked_reason`; `waiting_reason` (+`_null`); `dropped_reason` (+`_null`) |
| owner and creator (today `WorkActor` objects) | `owner_id`, `owner_generation`, `owner_born`, `owner_deleted`; `created_by_id`, `created_by_generation`, `created_by_user boolean` (today the creator is either an agent or the string `@user`) |
| reviewer and last updater | `reviewer_id`, `reviewer_generation`, `reviewer_born` (+`reviewer_null`); `last_updater_id`, `last_updater_generation` |
| times | `at`; `updated_at`; `docket_at`; `archived_at` (NULL = active: the physical move to the archive becomes this column) |
| links | `parent_slug FK work_items` (+`_null`); `superseded_by FK work_items` |
| attention | `attention_reason`, `attention_at`, `attention_by`, `attention_set_rev`, `manual_attention_rev`; `notification_attention_active`, `notification_attention_epoch` |
| completion | `accepted_at`, `accepted_by`, `accepted_note`, `accepted_via`, `accepted_evidence_gap`; `post_completion json` |
| sequences | `scope_seq`, `scope_guard`, `scope_rolled`, `scope_logged`, `artifact_seq`, `finding_seq` |
| bookkeeping | `extra`; `row_version` |

Indexes on `work_items`:

| Index | Serves |
|---|---|
| `((coalesce(nullif(docket_at, ''), updated_at, '')) DESC, slug DESC)`, C collation | the list order |
| `(status) WHERE archived_at IS NULL` | active-only filters |
| `(owner_id)`, `(created_by_id)`, `(reviewer_id)` | lookups by person |
| `((coalesce(owner_id, created_by_id)))` | the access rule's anchor (§3.5) |
| `(parent_slug)`, `(superseded_by)` | child items and supersessions |
| `(attention_set_rev) WHERE attention_reason IS NOT NULL` | attention raises |

**Child and link tables** (the audit's §4.2 lists the live counts):

| Table | Kind | Keys and indexes |
|---|---|---|
| `work_item_participants(slug, agent_id)` | many-to-many | PK (slug, agent_id); index (agent_id, slug) |
| `work_item_dependencies(slug, depends_on)` | many-to-many | PK (slug, depends_on); index (depends_on, slug) |
| `work_item_holders(slug, seq, agent_id, generation, born, from_at, by_id, derived)` | owned list | index (agent_id) for the item-scoped read grant |
| `work_item_acceptance(slug, idx, text)` + `work_item_acceptance_checks(slug, idx, seq, …)` | owned list + its list | |
| `work_item_progress(slug, list CHECK (done, next), pos, text)` | owned list | |
| `work_item_evidence(slug, seq, at, by_id, kind, ref, note, execution, classification, artifact, runner, result, receipt json)` | owned list | |
| `work_item_history(slug, seq, at, by_id, op, …)` | owned list | |
| `work_item_dismissals(slug, seq, at, by_id, set_rev, reason)` | owned list | |
| `work_item_verdicts(slug, seq, …)`, `work_item_review_packets(slug, seq, …)` | owned lists | today's `candidate_verdict` and `review_packet` are "the newest row" of each, read by query, not stored twice |
| `work_item_review_seats(slug, seq, …)`, `work_item_review_seat_requests(slug, seq, …)` | owned lists | |
| `work_item_scope(slug, seq, at, by_id, kind, before, after, mode, supersedes, superseded_by, text)` | owned list | one table for today's inline `scope` / `scope_archive` and the `work_scope_log` rows |
| `work_item_artifacts(slug, id, …)` + `work_item_artifact_grants(slug, artifact_id, agent_id)` | owned list + many-to-many | |
| `work_item_findings(slug, id, …)` + `work_item_finding_decisions(slug, finding_id, seq, …)` | owned list + its list | |
| `work_item_delivery(slug, stage, claimed_at, claimed_by_id, ref, note, verified, method, detail, resolved_oid, target, ref_as_of, observed_at)` | owned (≤5 stages) | |
| `work_item_quick_staff_receipts(slug, receipt_id, …)` | owned list | |
| `work_deleted_names(slug)` | | today a doc list |

### 3.5 Docket access is a query, not a precomputed table

Today the engine computes who may read each item in Python after every save, and stores the answer
in `work_read_access` (5,041 rows on the live copy). Five tables and two triggers keep it fresh. The
rule (`Org._work_can_read`) is: the user; the owner; the creator; the reviewer; a participant; or a
strict ancestor of the owner (of the creator when there is no owner).

The same rule as SQL over the new columns:

```sql
WITH RECURSIVE down(id) AS (SELECT id FROM agents WHERE parent_id = $viewer
                            UNION SELECT a.id FROM agents a JOIN down d ON a.parent_id = d.id)
SELECT i.* FROM work_items i
WHERE $viewer = '@user' OR i.owner_id = $viewer OR i.created_by_id = $viewer OR i.reviewer_id = $viewer
   OR EXISTS (SELECT 1 FROM work_item_participants p WHERE p.slug = i.slug AND p.agent_id = $viewer)
   OR coalesce(i.owner_id, i.created_by_id) IN (SELECT id FROM down)
ORDER BY coalesce(nullif(i.docket_at, ''), i.updated_at, '') DESC, i.slug DESC
```

**Measured on the live copy, written against the old JSON rows: it returns exactly the engine's
5,041 (item, reader) pairs, with 0 differences either way** (`probe/access_rule_check.sql`).

On the prototype tables it costs:

| Viewer | Time |
|---|---|
| a leaf agent | 0.46 ms |
| the 1,145-descendant coordinator | 2.1 ms |
| the user | 0.2 ms |

So `work_read_state`, `work_read_dirty`, `work_read_policy`, `work_read_access`, `work_read_totals`,
`work_read_dependency` and `work_read_questions` are all dropped. So are the `work_access_*`
triggers and `workread.refresh` from every save.

The Python predicate stays as the oracle. A test compares the query with `_work_can_read` for every
(viewer, item) pair on fixtures, and on the live-copy rehearsal.

### 3.6 Mail, notices and delivery (stage 3)

- **`mailboxes`.** One row per recipient: `agent_id PK FK CASCADE`, `next_recv_seq`. It replaces
  `mail_archive_bounds`, and is the row a delivery locks.
- **`mail`.** One row per delivered copy (each recipient gets its own copy today, measured: 17,813
  ids, none shared). Columns:
  - `seq bigint` (identity) and `id text UNIQUE`;
  - `recipient_id FK CASCADE` and `sender_id` (indexed, not enforced: `@user`, `system`, outside
    parties);
  - `kind`, `relationship`, `at`;
  - `state CHECK (queued, delivering, delivered)`;
  - `recv_seq`, `seq_origin`, `mailbox`, `message_id`, `operation_id`, `client_op`;
  - `restart_notice`, `model_only`, `retracted`, `stale` (+ `stale_at`, `stale_revision`,
    `stale_candidate`), `redelivered`, `net_id`;
  - `body`, `reply_to json`, `ev json`;
  - `extra`, `row_version`.

  Today's per-owner unread list (`mail<US>owner`), the `delivering` batches and the `mail_log`
  archive become the `state` of the same rows. Mail no longer moves between sections.
- **Indexes on `mail`:**

  | Index | Serves |
  |---|---|
  | `(recipient_id, state, recv_seq)` | the inbox |
  | `(recipient_id, seq DESC)` | the archive tail |
  | `(sender_id, at DESC, seq DESC)` | Sent (replaces `mail_sent`, 0007) |
  | `(recipient_id, recv_seq DESC) WHERE recv_seq IS NOT NULL` | the next sequence number |
  | `UNIQUE (message_id)` | lookups by message |

- **Other mail tables:**
  - `mail_attachments(mail_id, pos, name, path, bytes, missing)`.
  - `delivery_batches(tok PK, agent_id, at, via, mode, attempt, drive json, claim json, …)`, with link
    tables `delivery_batch_mail(tok, mail_id)`, `delivery_batch_deliveries(tok, delivery_id, role)`,
    `delivery_batch_notices` and `delivery_batch_segments`.
  - `mail_transition_receipts`, `mail_transition_deliveries` (the dict of receipts).
  - `manual_attempts`, `manual_attempt_mail`, `manual_chunk_calls`, `manual_chunks`.
  - `steer_records(seq, agent_id, at, level, text, visible_id, delivery_id, attempts, retried,
    confirmed_duplicate, fold, where_, outcome, segments → steer_record_segments)`. Its id lists
    become `steer_record_mail(steer_seq, mail_id)` and `steer_record_deliveries(steer_seq,
    delivery_id, role)`. It keeps today's tail index `(agent_id, at DESC, seq DESC)` (0016).
  - `steer_attempts` + `steer_attempt_mail`, `steer_attempt_tokens`.
- **`notices(seq, agent_id FK CASCADE, at, text, ev json, state CHECK (pending, delivered))`.**
  Today's pending notices and `notice_log` are the two states of one table. Indexes:
  `(agent_id, state, seq)` and `(agent_id, at DESC, seq DESC)` (the history panel).
- **User mail.** `user_mail(seq, id, sender_id, kind, at, urgent, urgent_reason, read_at, body, ev
  json, …)`. Today's `user_inbox` and the dismissed `user_mail_log` become one table with a state.
  The user's Sent rows (`user_outbox`) become a `user_outbox` table with `recipient_id`.
- **Org inbox.** `org_inbox(seq, id, dir, peer, by_id, at, state, state_at, net_id, body)` +
  `org_inbox_attachments`.

### 3.7 Questions and requests (stage 4)

| Table | Contents |
|---|---|
| `asks` | `id PK`, `agent_id`, `kind CHECK (ask, credit, scope)`, `status`, `at`, `resolved_at`, `rev`, `reason`, `header`, `question`, `answer_mail`; credit fields `old_grant`, `new_grant`, `granted`, `notice` |
| `ask_questions(ask_id, pos, question, header, multi)` | the tabs of an ask |
| `ask_question_options(ask_id, q_pos, pos, label, description)` | the options of each tab |
| `ask_answer_selections(ask_id, q_pos, pos, value)` | the answer |
| `ask_work_items(ask_id, q_pos, slug)` | many-to-many ask ↔ item |
| `scope_request_items(ask_id, pos, kind, path, mode, tool, decision)` | the items of a scope request |

Indexes on `asks`: `(agent_id, status)`, `(status, coalesce(resolved_at, at) DESC, id)` (the
resolved-recent window that 0018 serves today), and `(kind, status)`.

These replace three doc blobs that are rewritten whole on every change today, and the
`foreground_asks` trigger.

### 3.8 Audiences, watchdogs, documents, reservations (stage 4)

| Table | Replaces | Columns and indexes |
|---|---|---|
| `audience_grants` | the audiences blob | `grantee_id`, `grantor_id`, `granted_at`, `reason`, `delegated_by_id`. PK (grantee_id, grantor_id); indexes (grantor_id) and (delegated_by_id). `_has_audience` on every send becomes one primary-key probe. |
| `audience_requests` | the requests blob | `id`, `from_id`, `target_id`, `currently_at_id`, … |
| `watchdogs` | `watchdogs` and `watchdog_tombs` | `id PK`, `owner_id FK CASCADE`, `name`, `kind`, `target`, `pattern`, `interval_s`, `state`, `notice`, `once`, `at`, `fired`, `last_check`, `last_check_ts`, `checks_run`, `last_output`, `last_exit`, `last_fired`, `paused_why`, `history_retained`, `spent_at`, `high_water json`. Index (owner_id), partial index on active ones. |
| `watchdog_events` | each dog's event ring and the `watchdog_history` log | `watchdog_id`, `seq`, `at`, `gist`, `body`, `agent_id` |
| `documents` | the presentations log | `id PK`, `agent_id FK CASCADE`, `seq`, `title`, `at`, `format`, `file`, `bytes`, `body`. Index (agent_id, seq DESC). The gallery reads the columns without the body, and opening one is a primary-key read: no more JSON parse of every body, no more `strpos` over every document. |
| `reservations` | the reservations blob (history never pruned) | `id PK`, `owner_id`, `item_slug`, `resource`, `candidate`, `base`, `state`, `created_at` / `_ts`, `updated_at` / `_ts`, `expires_at` / `_ts`, `heartbeat_at` / `_ts`, `stale_s`, `integration_key UNIQUE`, `integration_receipt`, `landed_at`, `release_receipt`, `successor`. Indexes (resource, state), (item_slug, state), (owner_id). |
| `reservation_paths` | each reservation's `paths` list | `reservation_id`, `path`; index (path) |

### 3.9 Logs and receipts (stage 4)

- **`events`** (seq, `op`, `actor_id`, `at`, `item_slug`, `detail json`), plus
  `event_agents(event_seq, agent_id, role)` and `event_warnings(event_seq, pos, text)`.
  - `event_agents` is the many-to-many link "this event concerns this agent, in this role":
    actor, node, to, grantee, from, and the members of `removed` / `moved_from` / `which`.
  - Its index `(agent_id, event_seq DESC)` serves the history panel: 0.14–0.2 ms, against 74 ms today.
  - `detail` keeps each operation's own payload variant (70 distinct operations on the live copy; Q1).
  - `op` is a column, so `ix_log_l_present_evicted`'s text search becomes `WHERE op = 'present_evicted'`.
- **`op_receipts`** (id, `node_id`, `gen`, `tool`, `key`, `fp`, `cls`, `outcome`, `at`, `mint_ms`,
  `targets json`, `result json`) + `op_receipt_effects`. Index (node_id, key): `opreceipts.find` on
  every keyed call becomes one probe instead of a reverse scan.
- **`lifecycle`** (operation_id, kind, state, at, …). Index (operation_id, state).
- **The custody receipts** (`receipts`, `receipt_owners`, `receipt_carriers`, 0013) are already
  relational and stay. Only `owners_naming` gains an indexed `node_id` column instead of
  `val::json->>'node'`.

### 3.10 Org settings and small sections (stage 4)

- **`org_settings`.** One row, typed columns for the scalar settings in `OrgDoc`: version, slug,
  name, created, workspace, permission_mode, default_visibility, default_effort, max_top_grant,
  default_top_grant, compact_at, the fable policies, the cascade switches, max_depth, max_children,
  the auto-resume fields, the storage flags, the net switches, the API-key fallback fields, the cost
  accumulators and the migration markers.
- **Tables for the setting lists:** `org_dirs(path, mode)`, `org_tiers(tier, price, model)` (today
  `tiers{}` + `models{}`), `org_default_mcp`, `org_kiosk_dirs`, `org_kiosk_mcp`, `net_hubs`,
  `net_hub_seen`, `net_spool`.
- **Object-valued settings** (`killswitch`, `kiosk`, `sandbox`, `disk`, `net_identity`,
  `fable_lock`, `auto_cheap_compact`, `_migrations`, `desktop_import`): flattened into columns where
  their shape is fixed, otherwise one JSON column each (Q1).
- `meta` (`key_order`, `owners:*`, `heal_epoch`, `schema_version`) stops being needed for the
  converted kinds: key order and owner order are properties of the old text layout.

### 3.11 What is removed, and when

| Object | Migration | Stops being written | Dropped |
|---|---|---|---|
| `node_index`, `foreground_meta`, `foreground_parents`, `orgtree_foreground_lineage`, `node_tree_val`; the triggers `foreground_node_commit`, `foreground_tree_val_commit`, `work_access_node`, `work_list_node` | 0004, 0008, 0012, 0017, 0020 | stage 1 (nothing writes `nodes`, so the triggers never fire) | stage 5 |
| `nodes_summary_cost_exceptions`, `ix_policy_candidates` | 0010, 0014 | stage 1 | stage 5 |
| `work_index`, `work_index_state`, `work_read_*`, `work_list_*`, `orgtree_work_*` functions and their triggers | 0006, 0008, 0009, 0012, 0020 | stage 2 | stage 5 |
| `mail_sent`, `mail_archive_bounds` and their five triggers, `ix_mail_ordinal`, `ix_user_mail_sender` | 0005, 0007 | stage 3 | stage 5 |
| `foreground_asks`, `foreground_counts`, `foreground_documents`, `foreground_blobs`, the doc and log commit triggers | 0004, 0018 | stage 4 | stage 5 |
| `doc`, `nodes`, `log_d`, `log_l`, `meta` (the old data) | 0001 | at each stage, for its kinds | stage 5, a release after the last conversion (Q3) |

Until stage 5 every old object stays, unchanged, so the previous release can still run on it after a
rollback (§5.4).

### 3.12 The two deliberate duplicates

1. **`agents.ord`.** It keeps the table order the old layout gave the dictionary, so a whole walk
   yields agents in the same order as today. It is not derived from anything else.
2. **Revision counters per kind of record (§4.6).** Caches need "did any agent row change since X"
   in one probe. One counter row per kind is bumped once per statement, not per row.

## 4. How the engine maps onto the schema

### 4.1 Today

`ledger.Org` (and the supervisor and API) operate on `org.d`, a dictionary per org. `store.py`
presents that dictionary lazily:

- agents load on demand per id (`LazyNodesMap`);
- per-owner sections load per owner (`LazySplitSection`, `SectionMap`);
- logs load whole on first touch (`LazyDoc.__missing__`);
- docket items load as references (`_WorkRowRef`).

Saving compares each touched record's JSON with the text it was loaded from, and writes changed rows
by compare-and-set. `org_tx` locks rows by agent id, doc key and log owner before the body runs.

### 4.2 Mappers behind the same dictionary

Each kind of record gets a **mapper** in a new module, `store_model.py` (store.py is already 9,000
lines). A mapper has four parts:

| Part | Job |
|---|---|
| `split(record) -> RowSet` | the main row's column values, the child-table rows, and `extra` |
| `join(row, children) -> record` | the dictionary, in canonical key order |
| `load(conn, ids)` | one statement for the main rows, plus one per child table, for a batch of ids |
| `save(conn, changes)` | the statements for a batch of changed records (§4.3) |

The lazy containers keep their interface:

- `LazyNodesMap._fetch` calls `AgentMapper.load`.
- `LazySplitSection` and `SectionMap` call the mail, notice and steer mappers per owner.
- Logs become row-backed lists whose rows come from their tables.

`ledger.py` does not change for the storage switch. It changes only where §4.5 replaces a walk with
a query.

A test-mode check (like today's `ORGTREE_SCOPED_SAVE_VERIFY`) re-reads every record after each save
and compares it with the dictionary. The concurrency and lifecycle suites run with it on.

### 4.3 Writes: changed columns only

Today a one-field change rewrites the whole 12 KB agent row. That costs 440 ms per 400 rows with
the engine's own statement and no trigger, measured. The mapper instead diffs the new `RowSet`
against the one it loaded:

- **Main row.** It updates only the changed columns, batched by shape:
  `UPDATE agents SET parent_id = u.p, row_version = row_version + 1 FROM unnest(…) u WHERE id = u.id
  AND row_version = u.v`. Unchanged large columns are not rewritten: PostgreSQL keeps an unchanged
  toasted value in place. A re-parent of 400 agents costs 6 ms on the prototype; the same write
  today costs 657 ms (440 ms without triggers).
- **Child tables.**
  - Owned lists that are replaced whole (dir grants, tool prompts, progress lists) are replaced as a
    set: `DELETE … WHERE agent_id = ANY` plus one `INSERT … SELECT FROM unnest`, only when they
    changed.
  - Append-only logs (turns, events, mail, history) are appends: one `INSERT`, or `COPY` for large
    batches.
- **Lost updates.** A changed row whose `row_version` moved raises `StaleWrite` exactly as today.
  `org_tx` retries its body as today.

### 4.4 Locks

`org_tx`'s lock plan keeps its shape and its fixed order. Its targets change:

| `org_tx` names | Locks (new) |
|---|---|
| nodes | `agents` rows, `FOR UPDATE` / `FOR SHARE` |
| a docket item | its `work_items` row |
| `("mail", nid)` | `mailboxes(nid)` |
| `("notices", nid)` / `("steered_log", nid)` | the `agents` row of that owner, `FOR SHARE`, which serializes appends per owner |
| a whole small section (asks, audiences …) | a per-kind row in `org_locks(kind)` |

Appends need no lock beyond that, as today.

### 4.5 Reads: the walks that become queries

Each row of the audit's §3.3 maps to a repository function in `store_model.py`. The busiest ones:

| Today (audit) | Becomes | Stage |
|---|---|---|
| `children_index` / `children` / `free` / `committed` / `_peers_of` walks (every turn, every tree build, every lifecycle op) | `children(parent)`, `children_index(parents)`, `committed(parent)` = `SELECT sum(credit_grant) … WHERE parent_id = $1 AND state <> 'archived'` | 1 |
| `descendants` / `descendant_set` / `_taken_with` | recursive CTE down `parent_id` | 1 |
| `cost_total` (every turn end, tree header; 54 ms) | `SELECT sum(cost_usd), bool_or(cost_usd_unknown)` (0.13 ms) | 1 |
| `node_ids_with(key)`, `frozen_live_nodes`, `node_field_values` (40–170 ms) | partial-index queries on the columns (0.03–0.07 ms) | 1 |
| per-turn ORG STATE block (`_org_state_parts`, `_roster_facts`: 4 whole walks, ≈140 ms per turn) | children, peers and free credit of the caller's chain by query | 1 |
| auto-resume `auto_resume_ready` (whole walk every 30 s) | `WHERE frozen IS NOT NULL` partial index | 1 |
| session / seat / lineage lookups by walking | indexed `session_id`, `seat_id`, `predecessor_id` | 1 |
| docket access, lists, counts, attention (58–71 ms list; 1.0–1.2 s tree header) | §3.5 query; `count(*) … GROUP BY status`; partial attention index | 2 |
| `_work_find` (loads the whole archive on a miss) | primary-key read | 2 |
| `_work_questions` (items × asks) | join `ask_work_items` | 2/4 |
| inbox, mailbox in receive order, Sent, archive tails, reply targets | indexed `mail` queries | 3 |
| delivery batches by token or mail id, all-owner walks | primary keys and link-table indexes | 3 |
| history panel (events + notices: 112 ms) | `event_agents` + `notices` indexes (0.2 ms) | 3/4 |
| `_has_audience` on every send, `tree_node` audiences per agent | primary key on `audience_grants`; one grouped query per tree | 4 |
| `node_ask` per agent, `open_request` per turn | `asks (agent_id, status)` | 4 |
| documents per agent per tree, gallery body parse, `strpos` open | `documents` columns | 4 |
| `opreceipts.find` reverse scan on every keyed call | index (node_id, key) | 4 |
| whole-log appends (`watchdog_history`, `user_outbox`, `user_mail_log`, `org_inbox`, documents) | single-row inserts | 3/4 |

### 4.6 Caches and revisions

Today the foreground cache stamps `node_revision`, `catalog_revision` and `view_revision`
(`foreground_meta`, kept by per-row deferred triggers) and `work_revision` (`orgs`).

The new `org_revisions(kind text PK, revision bigint)` has one row per kind (agents, agents_catalog,
work_items, mail, notices, asks …). A **statement-level** trigger on each table bumps its kind once
per statement: a reshape that updates 483 rows in one statement bumps it once. This keeps the
property the 0004 design relied on, "a direct SQL writer also invalidates the cache", at the cost of
one tiny update per statement instead of 1–4 ms per row.

The org-level `orgs.revision` and `NOTIFY org_rev` stay as they are.

### 4.7 Whole-document paths that go away

| Stage | Paths that go away |
|---|---|
| 1 | The whole-agent decode on a stale heal epoch (heals run inside the converter instead, §5.2). Every per-turn and per-tick agent walk listed in §4.5. The full-agent load in desk chat, desk detail, the audiences list and the per-turn prompt. `tree_fast` hashing every agent (it hashes the `row_version` of changed rows). |
| 2 | The 1.0–1.2 s archive projection in every tree rebuild. `_work_find` archive loads. `workread.refresh` / `worklistmeta.refresh` on every save. `notification_state.reconcile_attention` over all items on every save (a partial index answers it). |
| 3 | Whole owner-log reads for steer trims and records. All-owner delivery walks. Whole-log appends of user mail. |
| 4 | Whole-blob rewrites of asks, audiences, watchdogs and reservations on every change. The per-agent list scans in `tree_node`. |

What remains whole on purpose:

- `export_json` and the migration verifier.
- The operator diagnostics.
- `gitworkspace.org_facts`, which deep-copies the document. It moves to queries in stage 2.

## 5. Converting existing data

### 5.1 One conversion path for every starting version

| Starting point | How it reaches the converter |
|---|---|
| **v3.0.9, 3.1.0 and the other 3.0.x** (PostgreSQL, old layout) | `pgstore.migrate` applies the pending migrations at start (0020 on 3.0.9, then 0021+), exactly as every release has. The 3.0.x releases differ only in which of 0001–0020 they have applied, and all of them are applied before the converter runs. So the converter always sees the same old layout. |
| **v2.1.14** (SQLite) | The first-launch conversion runs `tools/pypg/pgimport.py`. It applies every migration (including 0021+), creates each org's schema, COPYs the SQLite rows into the old five tables, and checks counts and checksums. That is unchanged, and it works because 0021+ only **add** tables and never remove the old ones. The engine then starts, and the same converter runs on the same old layout. |

This is why stage migrations never alter or drop old tables: the importer writes into them.

### 5.2 What the converter does

A new `orgtree/model_convert.py` runs at engine start, after `pgstore.migrate` and before
`workread.bootstrap` and before the API binds (the place `store.claim_data_root` already runs
bootstraps). For each org and each stage that is not yet converted, in **one transaction**, with no
other process writing (the engine has not started serving):

1. **Read** every record of the stage's kinds from the old tables with today's loaders, including
   the heal that a new build's first load applies today (`Org.__init__` heals,
   `heal_decoded_box`). This is what the engine would see.
2. **Write** each record through the new mapper (`split`), using `COPY` for bulk rows.
3. **Read everything back** through the new mapper (`join`). Compare each record with step 1 under
   canonical JSON (sorted keys, exact types). Separately, compare the raw old rows with themselves
   before and after (P5: nothing old changed).
4. **Record** the conversion in `org_<id>.model_state(stage, format, converted_at, records,
   source_sha256, result_sha256, healed_records, extra_keys, nul_fields)`, and in
   `public.receipts(op_key = 'data-model/<stage>/v1')`.
5. **Commit.** From then on the engine reads and writes that stage's kinds only through the new
   tables.

Ordering is enforced. A stage cannot convert before the stage it depends on (the docket references
agents). An engine build that knows stage N refuses an org whose `model_state` shows a later stage
than it knows.

**Time** (inferred from the decode costs in audit §2.4; measured in each stage's rehearsal). The
largest org on the live copy has about 165,000 rows and 190 MB of JSON text. Reading and decoding
it takes about 1–2 s, `COPY` a few seconds, and the read-back about the same. Total: under a minute
per stage, once. The host shows "updating the database" progress as the first-launch conversion
already does.

### 5.3 Checks, and refusing to start

The engine refuses to start, with a message naming the org, the kind, the record id, the field and
the two values, when any of these happens:

- a record does not round-trip;
- a value does not fit its column (for example a string agent id containing U+0000, or a
  non-numeric `grant`);
- a link that must resolve does not (a `parent_id` naming no agent);
- a count or checksum differs.

The transaction rolls back, so the org stays fully on the old layout. Nothing is half-converted.
The error is also written to `diagnostics/model-conversion.json` for the support path.

On the live copy today there are no dangling tree links, owners, participants, dependencies or item
parents (measured). 35 mail recipients and 4,848 mail senders are not agents (the user, `system`,
outside parties). That is why `sender_id` is not an enforced key and `recipient_id` is. The 35
non-agent recipients are checked in the stage 3 rehearsal before that constraint is final.

### 5.4 Old data and rollback

The old tables are never written after their stage converts. They stay until stage 5. The previous
release can therefore run on them again, but **writes made after the conversion are lost**. This is
the same rule `pgimport`'s rollback already states.

**Rollback** is an offline tool, `tools/pypg/model_rollback.py` (operator only, refuses while the
engine runs). For a chosen stage it:

1. drops that stage's new tables;
2. deletes its `schema_migrations` rows, so the older build's drift check passes;
3. deletes its `model_state` row.

The custodian's pre-upgrade backup is the second line of defence.

### 5.5 Rehearsals (decision 4)

Every stage is rehearsed on copies of real data from both starting points before it is offered for
review:

- **v3.0.9.** A fresh clone of the live-copy dump. That dump is the 3.0.9 data (migrations up to
  0019). Apply 0020 (= 3.1.0) and the stage migration, run the converter, then run the read and
  reshape benchmarks on the result. The intermediate 3.0.x states are the same layout with fewer
  migrations applied, so they are shown identical by migrating the same clone from 0017 (the state
  of the 2026-09-29 import).
- **v2.1.14.** The user's real SQLite data as it was converted on 2026-09-29
  (`Orgtree v2/data/pre-postgres/orgs/*.db`, 4 orgs, 242 MB for the largest). It is copied with
  SQLite's online-backup API into a throwaway root, imported with `pgimport` into a dev cluster, and
  then converted. Two points need confirming:
  - that these files are v2.1.14 data. They are the data the user's v2 install held at its
    conversion; the exact app version is to be confirmed;
  - whether a separate pristine v2.1.14 export exists that the coordinator prefers.
- **For each rehearsal, recorded on the item:**
  - per org and kind, the record counts and checksums before and after, and the heal counts;
  - the `extra` keys found, and the U+0000 fields;
  - the time taken;
  - the full test modules of the stage.

## 6. Stages

Each stage lands separately, with review, rehearsals, a before/after table and its tests.

| Stage | Migration | Converts | Engine changes | Retires |
|---|---|---|---|---|
| **1 Agents** | 0021 | `nodes`; the `turns` lists; `turn_log`; `turn_error_log` | `AgentMapper`; `LazyNodesMap` on `agents`; `org_tx` agent locks; the agent helpers in store.py; foreground_store, foreground_context, identity_context, policy_candidates, policy_reads, workdetail, work_ui, workread `_Parents`, org_summary and org_listing read `agents`. The ledger and supervisor hot walks of §4.5 (stage 1 rows) become queries. The docket access tables are still live, so the save path marks dirty items explicitly in one statement per save when a `parent_id` changes. | the agent triggers and side tables (not written) |
| **2 Docket** | 0022 | active items, the archive, `work_scope_log` | `WorkMapper`; workquery, workdetail, worklist and work_ui on the new tables; access, list, counts and attention by query | `work_index`, `work_read_*`, `work_list_*` and the explicit dirty marks |
| **3 Mail** | 0023 | `mail`, `delivering`, `mail_log`, `notices`, `notice_log`, `steered_log`, `steer_attempts`, `manual_attempts`, `mail_transitions`, user mail, org inbox | mail, notice and steer mappers; inbox, mailruntime, maildrain and supervisor delivery paths by query | `mail_sent`, `mail_archive_bounds` |
| **4 The rest** | 0024 | asks, credit and scope requests, audiences, watchdogs, documents, reservations, events, op_receipts, lifecycle, settings, net | the remaining mappers and the §4.5 stage-4 queries | the `foreground_*` side tables |
| **5 Cleanup** | 0025 (a later release) | – | the converters become refusals for unconverted orgs | the old tables, the derived objects, the converter code paths, `json_extract` |

Stage 1 is the reshaping hot path the item asked for first. It is also the smallest end-to-end proof
of the mapper, converter, rehearsal and test machinery the later stages reuse.

## 7. Expected gains

**Measured** on the prototype tables (`probe/proto_schema.sql`): a clone of the live copy, with
typed columns and indexes for the lookups below, and the rest of each record in a text column so
row sizes are realistic. Method as in the audit: median of 5, warm, and writes in rolled-back
transactions with deferred constraints fired.

| Lookup or write | Today (audit) | Prototype |
|---|---|---|
| Re-parent 400 agents (with FK checks) | 1,006 ms (triggers) / 657 ms (engine CAS) | **6.2 ms** |
| Generation change on 400 agents | 1,788 ms | **5.1 ms** |
| Cost-only change on 400 agents | 717 ms | **4.3 ms** |
| Deliver 200 mails | 243 ms | **2.4 ms** |
| Children of the 483-child seat | 1.2 ms (`node_index`) | 0.2 ms |
| Descendants of the big seat (1,145) | one statement per generation over `node_index` | 3.6 ms |
| Live agents / frozen live / with halt / accounts | 0.24 / 153 / 40 / 93 ms | 0.04 / 0.07 / 0.05 / 0.03 ms |
| Cost total | 54 ms | 0.13 ms |
| State/generation/seat/parent of every agent | 65 ms | 0.15 ms |
| Lineage count of the 62-generation seat | trigger-kept | 0.19 ms |
| Docket counts by status (active + archive) | 1,000–1,183 ms (projection) | **0.22 ms** |
| Docket readable by a viewer, first page (leaf / coordinator / user) | 58–71 ms (recursive JSON CTE) | 0.46 / 2.1 / 0.2 ms |
| Archived item by slug / by owner | 108 / 130 ms without the side table | 0.05 / 0.03 ms |
| History: events of an agent / notices of an agent | 74 / 38 ms | 0.14–0.2 / 0.07 ms |
| Sent (newest 50) | 0.06 ms via `mail_sent` (293 ms without it) | 0.07 ms, with no side table and no trigger |
| Next receive sequence | 0.07 ms via the trigger-kept bounds | 0.09 ms |

**Estimated end to end** (inferred: today's measured total minus the storage part the prototype
removes; each stage's before/after table replaces these with measurements):

| Screen or operation | Today (measured) | Expected after |
|---|---|---|
| Org tree rebuild after a commit | 1.2–1.45 s | under 0.3 s (stage 2; the rest is Python tree building) |
| Docket list (desktop) / archive page / agent `orgtree_work list` | 66–87 ms | 5–15 ms (stage 2) |
| History panel | 148–168 ms | under 10 ms (stages 3/4) |
| Per-turn prompt build | ≈140 ms | 10–30 ms (stage 1) |
| Desk chat open (big seat) | 158–244 ms | under 60 ms (stages 1/3) |
| Big tree reshape (move, demote, insert-above, self-subjugate) | 0.74–0.96 s | 0.15–0.35 s (stage 1; plan and lock work remain) |
| Unreachable top-level swap | 1.64 s | under 0.3 s (stage 1) |

## 8. Tests

1. **Round trip.** For each mapper, a property test: generated records, every live-copy record in the
   rehearsal, and the hand-made edge cases. The edge cases are absent versus null, int versus float,
   U+0000, unknown keys, empty lists, and the legacy shapes `heal` handles. Each must give
   `join(split(r)) == r` under canonical JSON.
2. **No JSON in lookups.**
   - Every repository query runs under `EXPLAIN (FORMAT JSON)` on a seeded org with 10× archived
     history. The test fails on a sequential scan of a growing table, on any JSON operator or
     `json_extract`, or on a plan that is not index-backed.
   - A source scan (in `tools/source-audits.py`) refuses `::json`, `::jsonb`, `->>` and
     `json_extract` in the store's query strings, outside the converter and an allowlist.
3. **No growth with history.** `test_reshape_history_pg.py` already counts statements across 15
   reshape operations. The new modules add the same check for every §4.5 query family: statement
   count, and rows read via `pg_stat_statements` or `EXPLAIN` buffers, at 1× and 10× archived
   agents, items, mail and events.
4. **Conversion.**
   - Fixtures for both paths: a synthetic v2 SQLite org run through `pgimport`, and a synthetic old
     PostgreSQL layout. The converter must accept both, record matching checksums, and refuse each
     planted fault (a mismatched row, a dangling parent, a bad type, an extra key) with the right
     message and nothing written.
   - Rollback tool tests.
5. **Access equivalence.** The §3.5 query against `_work_can_read`, for every (viewer, item) pair on
   fixtures.
6. **Mutants (reviewer, risky code).** For example:
   - a mapper that drops a column;
   - a save that rewrites unchanged columns;
   - a compare-and-set without `row_version`;
   - a converter that skips the read-back;
   - an access query missing the ancestor term;
   - a missing index.

## 9. Open questions

These are for the coordinator, or the user through it. Everything else in this document is an
implementation choice I have made, and is listed here only where it changes what the product stores.

- **Q1. Free-form records.** Some records are provider-reported or engine runtime records that
  nothing filters on. Their shapes change with providers. They are stored whole today:
  - on agents: `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_*`,
    `desktop_import`, `frozen`, `halt`, `inflight`, `turn_ended`, `pending_switch`,
    `remote_controlled`, `admit_once`, `unstuck`, `last_wall`;
  - on events: the per-operation `detail`;
  - the turn `route` and `reported`;
  - mail `ev` and `reply_to`;
  - settings such as `kiosk` and `sandbox`.

  **Recommendation:** keep each as one JSON column of its own record. A lookup that needs their
  *presence* gets a partial index. The relationships inside them are still promoted: for example the
  mail ids inside `mail_drain` and `halt_queue` go to link tables. The alternative is to normalize
  them too: about 15 more tables and 150 columns, and a migration every time a provider changes a
  report format.
- **Q2. Timestamps.** Exact ISO text with C collation (recommended: identical ordering to the
  engine's own, lossless) or `timestamptz` (proper time type, but 1,843 mails' offset spelling would
  be normalized)?
- **Q3. Keeping old data.** How long to keep the old tables after a stage converts: one release
  (recommended), or until the user confirms?
- **Q4. Mixed-number fields.** The design stores them exactly (`numeric`), rather than normalizing
  legacy integer `grant` values to floats. Agreed?
- **Q5. Landing.** Stage 1 lands on its own, ahead of the docket, with its own rehearsal and review?

## 10. Risks

| Risk | Mitigation |
|---|---|
| A mapper bug silently changes data | The converter's read-back refuses to start; the test-mode read-back after every save; round-trip property tests; mutants |
| The seam hides a whole-collection walk that the stage did not convert to a query | The statement and row-count growth tests at 10× history catch it; the audit's §3.3 list is the checklist per stage |
| A mixed-version mistake: an older engine on a newer database | `pgstore.migrate` already refuses a database with migrations the build does not know (`MigrationDrift`) |
| Long first start on a big org | One conversion per stage, timed in rehearsal, with the host's progress display. Under a minute on the largest real org (inferred, to be measured) |
| Importer coupling (`pgimport` writes the old tables) | Stage migrations only add. Stage 5 updates the importer before dropping the old tables |

## Appendix A. Agent fields and where each goes

| Field (`NodeDoc`) | Goes to |
|---|---|
| `session_id`, `model`, `state`, `title`, `charter`, `created`, `archived_at`, `rescinded_at`, `seat_id`, `pid`, `ui_order`, `lineage`, `generation`, `bearer_state`, `team_charter`, `cost_usd`, `cost_usd_unknown`, `occupancy`, `occupancy_est`, `compacted_unrun`, `context_window`, `cache_keepalive_at`, `working_activity_at`, `last_turn_mcp_tool_count`, `last_turn_mcp_fingerprint`, `limit_locked`, `cli_compactions`, `cli_boundary_offset`, `lost_reason`, `net_fail_run`, `net_fail_since_ms`, `hard_fail_run`, `untrusted_limit_run`, `cheap_compacted`, `session_began_at`, `session_unrun`, `mail_seq`, `mailbox_id`, `transcript_incarnation`, `reply_incarnation`, `account`, `account_primary`, `codex_account`, `codex_thread`, `codex_native_home`, `antigravity_account`, `antigravity_conversation`, `docket_reminder_at`, `config_seq`, `limit_run`, `turn_seq` | `agents` columns of the same name |
| `grant` | `agents.credit_grant` (numeric) |
| `parent`, `predecessor`, `successor` | `agents.parent_id`, `predecessor_id`, `successor_id` (enforced keys) |
| `scope.permission_mode`, `org_visibility`, `effort`, `account_fallback`, `model_version`, `prefer_reserve`, `tools.{bash, web, edit, subagents}`, `auto_cheap_compact.{enabled, occ}` | `agents` columns |
| `scope.add_dirs[]` | `agent_dir_grants` |
| `scope.tools.mcp[]` | `agent_mcp_servers` |
| `last_status`, `prev_status` {status, summary, at} | `agents.last_status_*`, `prev_status_*` |
| `turn_est_cost`, `turn_est_toks` (fixed tuples) | `agents` columns |
| `turns[]` | `agent_turns` (with `turn_log`) |
| `last_denials[]`, `last_approvals[]` | `agent_tool_prompts` |
| `last_turn_mcp_tools[]` | `tool_lists` via `agents.last_turn_mcp_tools_id` |
| `halt_queue[]`, `native_held_carriers[]` | `agent_carriers` + link tables |
| `mail_drain` {ids, retry_at, failures, suspended} | `agent_mail_drain` + `agents.mail_drain_*` |
| `external_handles[]`, `oracle_exchanges[]` | `agent_external_handles`, `agent_oracle_exchanges` |
| `frozen`, `halt`, `inflight`, `turn_ended`, `pending_switch`, `remote_controlled`, `admit_once`, `unstuck`, `last_wall`, `cache_continuity`, `envelope`, `codex_route_last`, `codex_usage_total`, `codex_usage_reset`, `desktop_import` | one JSON column each (Q1) |
| anything else | `agents.extra` (expected empty; reported) |

## Appendix B. Docket item fields and where each goes

| Field (`WorkItem`) | Goes to |
|---|---|
| `slug`, `rev`, `kind`, `title`, `objective`, `status`, `status_at`, `blocked_reason`, `waiting_reason`, `dropped_reason`, `at`, `updated_at`, `docket_at`, `archived_at`, `manual_attention_rev`, `notification_attention_active`, `notification_attention_epoch`, `scope_seq`, `scope_guard`, `scope_rolled`, `artifact_seq`, `finding_seq`, `scope_logged` | `work_items` columns |
| `owner`, `created_by`, `reviewer`, `last_updater` (`WorkActor` or `@user`) | `*_id`, `*_generation`, `*_born`, `*_deleted` / `created_by_user` columns |
| `parent`, `superseded_by` | `parent_slug`, `superseded_by` (enforced keys to `work_items`) |
| `manual_attention` {reason, at, by, set_rev} | `attention_*` columns |
| `accepted` {at, by, note, via, evidence_gap} | `accepted_*` columns |
| `participants[]`, `dependencies[]` | link tables |
| `holders[]`, `acceptance[]` (+ `check_history[]`), `done_so_far[]`, `working_on_next[]`, `evidence[]`, `history[]`, `dismissals[]`, `candidate_verdicts[]`, `review_packets[]`, `review_seats[]`, `review_seat_requests[]`, `scope[]`, `scope_archive[]`, `artifacts[]` (+ `grants[]`), `findings[]` (+ `decisions[]`), `quick_staff_receipts{}`, `delivery{}` | child tables (§3.4) |
| `candidate_verdict`, `review_packet` (the latest of each list) | not stored: the newest row of `work_item_verdicts` / `work_item_review_packets`, plus a `_null` flag for an explicit null. Measured on the live copy: of 740 items carrying `candidate_verdict`, 420 equal the last list entry and 320 are null. All 52 non-null `review_packet` values equal the last entry. |
| `post_completion`, `scope_frozen` | JSON columns (Q1) |
| anything else | `work_items.extra` |
