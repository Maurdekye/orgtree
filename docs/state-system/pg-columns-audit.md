# PostgreSQL storage audit: every lookup inside JSON text, and every list stored inside a record

Docket item: `v3-storage-keep-indexed-fields-in-real-postgresq` (drag-opus, 2026-10-02).
Code audited: `v3/3.0.0-alpha.0` at `8d3aee9` (the commit 3.1.0 is built from).

## 0. Summary

**How v3 stores an org today.** Each org's data sits in a few PostgreSQL tables, and each row is one
block of JSON text under a key:

- one row per agent in `nodes`;
- one row per small setting, or per owner's mailbox, in `doc`;
- one row per log entry in `log_d` and `log_l`.

The engine's business logic (`ledger.Org`, about 20,000 lines, plus the supervisor and the API) works
on the whole org as one in-memory Python dictionary. `store.py` loads that dictionary from the rows
and saves it back by comparing serialized JSON.

Any question like "which agents are children of X", "which docket items does Y own" or "which events
mention Z" therefore has two possible answers today, and both are slow:

1. **Load the records and filter in Python.** Decoding every agent row costs about 73 ms. Decoding
   every archived docket item costs about 160 ms. Some paths do this on every agent turn or on every
   tree rebuild.
2. **Ask PostgreSQL to unpack the JSON of every row** (`val::jsonb->>'parent'`, `json_extract(...)`).
   This costs 40–300 ms per question, because no index can help.

To avoid both, v3 grew **trigger-maintained side tables** that unpack the JSON again on every write:

- `node_index`, `foreground_*` and `node_tree_val` for agents;
- `work_index`, `work_read_*` and `work_list_*` for the docket;
- `mail_sent` and `mail_archive_bounds` for mail.

The triggers cost **0.7–3.8 ms for every row written** (measured below). They are why a big tree
reshape still spends most of a second in the database.

**The ten most expensive findings** (all measured on the live-data copy; section 2 has the details):

| # | What | Where it runs | Cost today |
|---|---|---|---|
| 1 | The tree header's docket counts unpack all 1,075 archived items (43 MB of JSON) | every full org-tree rebuild (`GET /api/orgs/{slug}`, after every commit) | **1.0–1.2 s per rebuild** |
| 2 | Per-row triggers on agent rows | every agent row written; a big reshape writes 400–1,100 | **0.7–3.8 ms per row** (0.27–1.5 s per 400 rows) |
| 3 | The docket's access check walks up the agent tree by unpacking agent rows | every docket list, archive page and agent `orgtree_work list` | **58–71 ms per call** |
| 4 | The history panel unpacks every event and every notice | every open or poll of an agent's history | **≈145 ms per call** |
| 5 | Building an agent's prompt loads and decodes every agent row | every agent turn | **≈140 ms per turn** |
| 6 | Desk chat, desk detail and the audiences list load every agent row | every desk open (cold) and every audiences list | **130–245 ms** |
| 7 | "Which agents carry field X" helpers (frozen, halt, account, halt_queue …) unpack every agent row | supervisor ticks (every 30 s per org), every save, notifications every 5 s | **40–170 ms each** |
| 8 | Mail rows: two trigger families on every delivery | every mail delivered or archived | **1.2 ms per row** |
| 9 | Finding an archived docket item by name or owner without the side table | `_work_find` fallbacks, conversions, deletes | **108–130 ms per lookup** |
| 10 | The agent cost total unpacks every agent's `cost_usd` | every turn end, every tree header | **54 ms** |

**Lists stored inside records.** Section 4 lists 64 of them, each with the table that replaces it
under the user's rule: one link table for a many-to-many relationship, one foreign-key column for a
many-to-one relationship, and no lists stored inside a row. Examples:

- agents: folder grants, MCP servers, carriers, recent turns;
- docket items: participants, dependencies, holders, acceptance, evidence, history, review records,
  artifacts, findings;
- questions, audiences, reservations, delivery batches, steer records.

**What is already fast.** Several paths are index-bounded today and stay fast:

- reads that use the side tables (`node_index`, `work_read_access`, `mail_sent`, `foreground_asks`);
- the desk chat window's tail query;
- the Presentations gallery.

The design keeps those query shapes. It moves them onto real columns and drops the triggers that
keep the side tables.

## 1. Method, data and how to reproduce

- **Data.** One read-only `pg_dump` of the live cluster, taken 2026-10-02 11:38Z with the
  coordinator's approval. It was restored into a disposable dev cluster (`pg-custodian dev`) as
  database `livecopy`, and every benchmark ran on a fresh clone of it (`CREATE DATABASE … TEMPLATE
  livecopy`). The live cluster was never written to and no engine was started against it. The dump is
  deleted when this item closes.
- **The org measured.** `orgtree` (`org_2`), the operator's main org:

  | Record type | Count |
  |---|---|
  | agents | 1,208 (6 live, 1,202 archived; 15 MB of JSON, 12 KB average, 60 KB largest) |
  | docket items | 1,087 (12 active, 1,075 archived; 43 MB) |
  | mail archive | 17,813 messages for 529 recipients (40 MB) |
  | events | 53,829 (12 MB) |
  | notices | 12,431 (8 MB) |
  | steer records | 13,075 (41 MB) |
  | turn-log rows | 53,581 (8 MB) |

  The copy has migrations up to 0019. Every engine-level benchmark applied 0020 to its clone first, so
  the numbers describe 3.1.0.
- **Tools** (in the drag-opus scratch folder, `probe/`):
  - `sqlcost.py` times each JSON lookup as the engine writes it (`EXPLAIN ANALYZE`, median of 5) and
    each trigger family (the same statement with triggers on and off, inside a rolled-back
    transaction, deferred triggers fired with `SET CONSTRAINTS ALL IMMEDIATE`).
  - `decodecost.py` times fetching and `json.loads` of whole collections.
  - `readbench.py` drives the real request handlers (FastAPI `TestClient`, no lifespan, every process
    launch refused by `tools/scale/launch_guard`) and in-process engine calls on a clone, counting and
    timing every SQL statement.
  - `profile_fields.py` reports each record type's field shapes (types, presence, list sizes), without
    content.
- **Frequencies** come from the code paths (who calls what, at which loop interval). The live
  `diagnostics/slow-requests.jsonl` covers 2026-10-01 07:13Z to 2026-10-02 11:41Z (9,988 requests over
  500 ms). It shows:
  - `/foreground-tree`: 3,183 slow calls (p50 761 ms; mostly account/usage annotation, not storage);
  - `/work-items/{wid}/quick-staff`: p50 9 s;
  - `/nodes/{nid}/chat`: p50 631 ms;
  - `/api/agent`: 102 slow calls (p50 972 ms).
- **Labels.** "Measured" means run on the copy. "Inferred" means read from code. Every number in
  sections 2.1–2.4 is measured.

## 2. Measured costs

### 2.1 Hot screens and agent reads, end to end (before numbers)

`readbench.py`, results in `probe/results/read-base-2.json`. The first call is cold (a fresh engine
process); warm is the 2nd and 3rd call. "SQL" is the statement count and time of the cold call, and
"top statement" is the biggest one.

| Screen / call | Cold ms | Warm ms | SQL (n / ms) | Top statement |
|---|---|---|---|---|
| Org tree `GET /api/orgs/{slug}` | 1,624 | 2–56 | 17 / 1,267 | 1,183 ms: archive projection `json_extract(val,'$.slug','$.title','$.status','$.owner',…)` over every archived item |
| Org tree after a commit (rebuild) | 1,230 | 1,410–1,451 | 17 / 1,041 | 1,002 ms: the same archive projection |
| Foreground tree (desktop canvas) | 129 | 3 | 33 / 40 | docket candidates for the header |
| Foreground children page (big seat) | 39 | 3 | 27 / 10 | `node_index` page |
| Docket list (desktop foreground) | 84 | 66–70 | 25 / 70 | 61 ms: recursive parent CTE that unpacks `nodes.val` |
| Docket list (full view) | 583 | 52 | 65 / 187 | 64 ms: whole `log_l` docket sections; warm 46 ms is `json_to_record` over every agent row |
| Docket archive page | 83 | 86–87 | 20 / 73 | 65 ms: the same recursive parent CTE |
| Docket get (active item) | 6 | 5 | 19 / 2 | agent identity rows |
| Docket get (archived item) | 6 | 5 | 20 / 3 | agent identity rows |
| User inbox | 5 | 5 | 7 / 1 | `log_l` tail |
| Agent inbox (big seat) | 15 | 11–12 | 15 / 7 | `mail_sent` tail |
| Desk chat (big seat, last 300) | 244 | 158–162 | 32 / 42 | 29 ms: `SELECT id, val FROM nodes` (every agent row) |
| Desk detail (live seat) | 179 | 9 | 12 / 37 | 29 ms: every agent row |
| History panel (leaf seat) | 168 | 148–151 | 13 / 164 | 84 ms + 46 ms: every event and every notice unpacked |
| Presentations list | 11 | 8 | 8 / 7 | author state/model |
| Audiences list | 203 | 134–159 | 7 / 40 | whole-org load |
| Events page | 287 | 194–274 | 7 / 44 | 12 MB response |
| Staffing options | 481 | 3 | 0 / 0 | Python over the cached org |
| Lineage: detail of a retired seat | 5 | 5 | 0 / 0 | cached org |
| Agent `orgtree_work list` (leaf) | 72 | 62–68 | 18 / 71 | 67 ms: recursive parent CTE |
| Agent `orgtree_work list` (coordinator) | 79 | 68–73 | 21 / 77 | 71 ms: recursive parent CTE |
| Agent `orgtree_work get` (active) | 2 | 2 | 19 / 2 | – |
| Agent `orgtree_work get` (archived) | 4 | 3–4 | 21 / 3 | – |
| Per-turn prompt: identity + org state (coordinator) | 268 | 140–159 | 7 / 36 | 31 ms: every agent row (+ Python over all of them) |
| Per-turn prompt: identity + org state (leaf) | 142 | 140–218 | 7 / 32 | 27 ms: every agent row |

The reshaping operations were measured on the previous item
(`v3-moving-an-agent-takes-10-s-to-actually-regist`, artifact r1). After 8d3aee9 every reachable
reshape commits in 0.17–0.96 s; the unreachable top-level swap takes 1.64 s. Their remaining cost is
mostly per-row triggers and whole-row rewrites (2.3) and Python plan work.

### 2.2 SQL lookups that read JSON

`sqlcost.py`, results in `probe/sqlcost-base.json`: median of five runs, warm cache. "Plan" lists the
scan types. A "Seq" scan over `nodes` or `log_l` with a JSON expression means every row is unpacked.

| Lookup | Engine code | Rows | ms | Plan |
|---|---|---|---|---|
| live agents that carry a freeze | `store.frozen_live_nodes`, `desktop_notifications` (polled every 5 s) | 0 | **153** | Seq |
| agents with `frozen` | `store.node_ids_with` (supervisor freeze sweep) | 10 | **169** | Seq |
| agents with `halt` | `store.node_ids_with` (halt.py) | 56 | **40** | Seq |
| agents with `halt_queue` | `store.node_ids_with` (supervisor) | 86 | **40** | Seq |
| distinct agent `account` values | `store.node_field_values` (supervisor) | 1 | **93** | Seq |
| every agent's `cost_usd` | `store.lazy_node_costs` (cost total: turn end, tree header) | 1,208 | **54** | Seq |
| state/generation/seat/parent of every agent | `work_ui` identity rows | 1,208 | **65** | Seq + json_to_record |
| state of every agent | `store.read_transcript_nodes_page` | 1,208 | **170** | Seq |
| live agent ids | `store.live_node_ids` (via `node_index`) | 6 | 0.24 | Index |
| children of a 483-child seat | `store.lazy_children_index` (via `node_index`) | 483 | 1.2 | Index |
| top-level agents | `store.lazy_children_index(None)` | 63 | 0.4 | Index |
| ancestry (workread, key-following CTE) | `workread._Parents.prefetch` | 3 | 1.1 | Index |
| ancestry (identity, via `node_index`) | `identity_context` | 3 | 0.35 | Index |
| policy candidates | `ix_policy_candidates` (JSON partial index) | 16 | 0.13 | Index only |
| agent counts | `store._node_counts` (`node_index`) | 1 | 0.4 | Seq over `node_index` |
| id search | `foreground_store` (gram index) | 50 | 2.9 | Seq |
| docket order page | `workquery` (`summary->>` expression index) | 50 | 0.6 | Index |
| archive statuses | `LazyDoc.archive_statuses` (`work_index.summary`) | 4 | 7.4 | Seq |
| archive identity | `LazyDoc.archive_identity` | 1,075 | 11.5 | Seq |
| manual-attention raises | `workread.attention_raises_raw` | 0 | 11.4 | Seq |
| archived item by slug, no side table | `log_l` + `val::json->>'slug'` | 1 | **108** | Bitmap over every archive row |
| archived items by owner, no side table | `log_l` + `val->'owner'->>'node'` | 2 | **130** | Bitmap over every archive row |
| Sent folder from the mail JSON | `json_extract(val,'$.from')` over `mail_log` | 50 | **293** | Bitmap over every mail row |
| Sent folder via `mail_sent` | `store._mail_tails` | 50 | 0.06 | Index only |
| history: events mentioning an agent | `store._pg_node_history_rows` | 34 | **74** | Seq |
| history: notices of an agent | `store._pg_node_history_rows` | 6 | **38** | Bitmap over every notice |
| steered tail | `store.log_owner_tail` (`ix_log_d_steered_tail`) | 40 | 0.08 | Index |
| gallery list | `store._pg_document_gallery` (`val::jsonb - 'body'`) | 82 | 2.2 | Index (every body parsed) |
| audiences of one grantee | `identity_context` (`jsonb_array_elements` of the whole blob) | 0 | 0.35 | Index (whole blob parsed) |
| watchdog owners | `policy_reads` (`json_array_elements` + `json_extract` on agents) | 3 | 1.1 | Seq |

### 2.3 Per-row write triggers

The same statement with triggers on and off, deferred triggers fired before the rollback. 400 rows are
children of the 483-child seat.

| Statement | With triggers ms | Without ms | Trigger cost per row |
|---|---|---|---|
| Re-parent 400 agent rows | 1,006 | 468 | **1.34 ms** |
| Change only `cost_usd` on 400 agent rows | 717 | 443 | **0.69 ms** |
| Change `generation` (a lineage field) on 400 rows | 1,788 | 266 | **3.81 ms** (lineage recount) |
| Insert 200 `mail_log` rows | 243 | 3.4 | **1.20 ms** (bounds + Sent index) |
| Insert 200 events | 1.5 | 1.1 | 0.002 ms |
| Rewrite 12 active docket item rows | 10.4 | 1.5 | **0.74 ms** |

The "without" column is not free either: the statements above rebuild the JSON in SQL. The engine's
own write is cheaper per statement but has the same problem. Its batched compare-and-set
(`store._cas_nodes`: new text from Python, compared against the old text) writes 400 agent rows in
**657 ms with triggers and 440 ms without** (measured, `probe` ad-hoc run on the `proto` clone). Every
save rewrites the whole 12 KB JSON row, even when only `parent` changed.

The triggers on `nodes`, by migration:

| Migration | Trigger | Kind |
|---|---|---|
| 0004 | `foreground_node_commit` | deferred: meta row, counters, retired children, lineage recount |
| 0017 | `foreground_tree_val_commit` | deferred: trimmed copy for the tree |
| 0008 | `work_access_node` | docket access dirty marks |
| 0012 / 0020 | `work_list_node` | docket list revision |

Triggers on the other tables:

- `doc`: four more (0004, 0006, 0008, 0012).
- `log_d`: six (0005, 0007, 0012).
- `log_l`: two (0004, 0006).
- `work_index`: two (0008, 0012).

### 2.4 Decoding whole collections in Python

`decodecost.py`, results in `probe/decodecost-base.json`. This is the floor of any Python filter over a
collection: the walk cannot start before its rows are fetched and decoded.

| Collection | Rows | MB | Fetch ms | `json.loads` ms |
|---|---|---|---|---|
| All agent rows | 1,208 | 15.1 | 38 | 35 |
| Live agent rows only | 6 | 0.1 | 0.8 | 0.4 |
| Active docket items | 12 | 0.1 | 0.5 | 0.2 |
| Archived docket items | 1,075 | 42.7 | 93 | 67 |
| Docket scope log (all items) | 326 | 7.5 | 13 | 6 |
| Mail archive, one big recipient | 974 | 1.0 | 2.3 | 2.7 |
| Mail archive, all recipients | 17,813 | 39.7 | 96 | 64 |
| Unread mailboxes, all owners | 251 | 0.5 | 1.4 | 1.2 |
| Notices, all owners | 387 | 1.5 | 2.6 | 4.8 |
| Events log | 53,829 | 12.5 | 37 | 83 |
| Notice log | 12,431 | 8.2 | 20 | 39 |
| Steered log, one big agent | 987 | 1.8 | 5 | 4 |
| Turn log, all agents | 53,581 | 7.6 | 31 | 80 |
| Asks / audiences / reservations blobs | 1 each | 0.07 / 0.04 / 0.15 | <1 | <1 |
| Documents (presentations) | 82 | 0.75 | 1.8 | 0.9 |

A whole-table agent walk inside a transaction also heals and indexes every row
(`LazyNodesMap.materialize`, `Org.__init__` heals). The per-turn and desk numbers in 2.1 (≈140 ms for
about 30 ms of SQL) show that Python cost is several times the fetch and decode.

## 3. Inventory: every lookup on a field inside JSON

"Freq" uses these words:

- **turn**: once per agent turn;
- **request**: once per HTTP request of that route;
- **save**: once per committed write;
- **tick N s**: a supervisor loop interval;
- **op**: once per operator or agent operation of that kind;
- **rare**: maintenance, migration or repair.

"Cost" uses these terms:

- **full-agents**: a whole agent-table decode (≈73 ms and up, 2.4);
- **full-archive**: every archived docket item (≈160 ms, or 1–1.2 s through the projection, 2.1);
- **section**: the whole doc blob or log of that kind.

Line numbers are at `8d3aee9`.

### 3.1 SQL statements in the engine that read JSON

| Code | Table, field(s) | Operation | Freq | Cost (2.2) |
|---|---|---|---|---|
| `store.frozen_live_nodes` 3041; `desktop_notifications._FROZEN` 140 | nodes: `frozen`, `state` | filter | notifications poll 5 s; supervisor | 153 ms |
| `store.node_ids_with` 3116 (keys: halt, frozen, halt_queue, mail_drain, desktop_import, session_unrun, remote_controlled, switch_resume) | nodes: that key | filter | halt ops; supervisor startup/ticks; mail drain | 40–169 ms each |
| `store.node_field_values` 3128 (account) | nodes: `account` | distinct | supervisor 35672 | 93 ms |
| `store.lazy_node_costs` 3252 | nodes: `cost_usd` | sum input | turn end (supervisor 26653), tree header | 54 ms |
| `store.live_node_ids` 3104 | `node_index.meta->>'state'` | filter | supervisor 36162, maildrain, restart_wake | 0.24 ms |
| `store.lazy_children_index` 3381 / `lazy_children_of` 3419 | `node_index.meta->>'parent'` | filter | reshapes, `children()` | 0.4–1.2 ms |
| `store._node_counts` 6760; `org_summary` 61/101 | `node_index.meta->>'state'/'parent'` | count/filter | `GET /api/orgs` | <0.5 ms |
| `store.read_transcript_nodes_page` 7797 | nodes: `json_extract($.state)` | every row | transcript browser | 170 ms |
| `store.read_active_transcript_nodes` 7818/7822 | `node_index` state | filter | transcript browser | 0.1 ms |
| `store.read_stream_identity` 7278, `read_node_credential` 7302, `read_transcript_source` 7860 | one agent row, `json_extract` | single row | per stream / request | <0.5 ms |
| `store._pg_document_gallery` 6983/6990/7012 | log_l documents `val::jsonb - 'body'`; events `strpos(present_evicted)`; nodes state/model | list | Presentations | 2–3 ms |
| `store.read_document` 7034 | log_l documents `strpos(val, id)` | text search | open a presentation | 1.2 ms (every body read) |
| `store.read_document_gallery` 7070–7088 (SQLite path) | `json_extract` | – | SQLite only | – |
| `store.read_node_history_rows` 7389 (SQLite) / `_pg_node_history_rows` 7420/7427 | log_l events `detail.node/to/grantee/from`, `actor`, `at`; notice_log `node`, `at` | filter + sort | history panel (request, polled) | 74 + 38 ms |
| `store._mail_tails` 7543/7555/7569 | `mail_sent` (index); `json_extract($.from/$.at)` on user_mail_log (`ix_user_mail_sender`) | tail | agent inbox | <1 ms |
| `store.LazyDoc.project` 4158 | log_l work_items_archive: `json_extract` of 11 fields | projection of every archived item | **every full tree build** (`work_counts`, `work_attention_raises`), docket counts and list | **1.0–1.2 s** |
| `store.LazyDoc.archive_identity` 4203; `archive_statuses` 4241 | `work_index.summary->'_query'`, `summary->>'status'` | every archive row | every `orgtree_work` call (identity state); abandoned pass | 7–12 ms |
| `workquery` `_ORDER` 24, `_UNSUPPORTED` 25, `_select` 107 | `work_index.summary->>'docket_at'/'updated_at'/'_query'` | sort/filter | docket list, foreground | <1 ms (expression index) |
| `workread._Parents` 39/71 | nodes `val::json->'parent'` (key-following CTE) | ancestry | docket refresh after a save | ≈1 ms |
| `workread` reconcile 380–382 | `source.val::json->>'slug'` (every active and archived item) | join | maintenance | full-archive |
| `workread.attention_raises_raw` 484 | `summary->'manual_attention'->>'set_rev'` | filter | foreground tree header | 11 ms |
| `workdetail` `_NODE_IDENTITY` 19, parent chain 44 | nodes `val::jsonb->'parent'/'state'/'generation'/'seat_id'`; recursive CTE parsing every joined row | identity + ancestry | **docket list, archive page, agent list/get** | **58–71 ms** (2.1) |
| `worklistmeta` reconcile 153 | `source.val::json->>'slug'` | join | maintenance | full-archive |
| `work_ui` 88/92 | nodes `json_to_record` / `json_extract` state, generation, seat_id, parent | every row | docket full view | 46–65 ms |
| `identity_context` 77–87 | doc audiences `jsonb_array_elements`; log_l audiences; nodes `predecessor`; `node_index` parent | grants + ancestry | **every turn admission** (`turn_inputs`) | <1 ms (whole blob parsed) |
| `policy_candidates` 19/37 (`ix_policy_candidates`) | nodes `state`, `frozen`, `parent`, `predecessor` | filter + ancestry | supervisor policy snapshot (tick 30 s) | 0.13 ms + CTE |
| `policy_reads` 39 | doc watchdogs `dog->>'owner'`; nodes `json_extract($.state,$.scope,$.account)` | join | watchdog engine tick | 1.1 ms |
| `org_summary` 71–74, `org_listing` 38–40 | doc small keys `jsonb_typeof`, `val::jsonb->'slug'` | per key | `GET /api/orgs` | <1 ms |
| `settingstx` 76–79 | doc `pm_plan_stamp_heal` shape check | single row | settings write | <1 ms |
| `receiptmapping.owners_naming` 284 | receipts `val::json->>'node'` | filter, no index | rename | small table today |
| `assistant_messages` 293 | side SQLite store `json_extract(body,'$.ts')` | lookup | chat window index | not the org store |
| `foreground_store` 190–550 | `node_index.meta->>` parent, state, model, grant, order, created, successor, generation | tree reads | **every foreground-tree request** | <3 ms (side table) |

### 3.2 Triggers, derived side tables and JSON expression indexes

| Migration | Object | Reads from JSON | Fires | Replaced by (design) |
|---|---|---|---|---|
| 0001 | `json_extract(text, …)` function | any path | per call | gone (no JSON paths in lookups) |
| 0004 | `node_index` + `orgtree_foreground_meta()` + 5 indexes (active, children, predecessor, discovery, id grams) | 16 agent fields | deferred per agent row | agent columns + plain indexes |
| 0004 | `foreground_meta` (node/catalog/view revisions, node count, retired count, cost sum) | state, successor, cost | deferred per agent and doc row | engine-written revision columns; `count`/`sum` over indexed columns |
| 0004 | `foreground_parents` (retired children per parent) | parent, state, successor | per agent row | `count(*)` over a partial index |
| 0004 | `orgtree_foreground_lineage` (lineage count, consult id) | predecessor, state, bearer_state, generation | per lineage change, recursive | recursive query over `predecessor_id` at read time |
| 0004 | `foreground_asks` + 5 indexes | each ask's node, status, resolved_at | per write of the asks/credit/scope blob: **the whole array re-parsed** | `asks` table |
| 0004 | `foreground_documents`, `foreground_counts`, `foreground_blobs` | document node/title/at; org_inbox tail | per documents/org_inbox write | `documents`, `org_inbox` tables |
| 0005 | `mail_archive_bounds` + `orgtree_mail_ordinal` + `ix_mail_ordinal` | `recv_seq` (parsed twice per row) | BEFORE and AFTER every `log_d` row, advisory lock | `max(recv_seq)` over an index on `mail` |
| 0006 | `work_index` (`summary` jsonb of 31 fields) + 2 expression indexes | the whole item | per docket row write | `work_items` columns |
| 0007 | `mail_sent` + `ix_user_mail_sender` | `$.from`, `$.at` | per `mail_log` row; per `user_mail_log` insert | `mail.sender_id`, `mail.at` columns |
| 0008 | `work_read_*` (state, dirty, policy, access, totals, dependency, questions) | parent (agents); slug; asks | per agent parent change, docket row, asks write | access query over columns (design 3.4) |
| 0009 | `work_query_order`, `work_query_unsupported` | `summary->>` | per `work_index` write | plain column indexes |
| 0010 | `ix_policy_candidates` (partial on `val::jsonb->>'state'`, `frozen`) | state, frozen | per agent row | partial index on columns |
| 0012/0020 | `work_list_*` | state, generation, seat_id, parent (agents); scope log | per agent row, scope row, docket row | list query over columns |
| 0014 | `nodes_summary_cost_exceptions` | `cost_usd` shape | per agent row | typed `cost_usd` column with its own exception flag |
| 0016 | `ix_log_d_steered_tail` | the `at` column (not JSON) | – | same index on `steer_records` |
| 0017 | `node_tree_val` | `turns` (trimmed copy) | deferred per agent row | `agent_turns` with an index (newest 8 by query) |
| 0018 | `foreground_asks_resolved_recent(_visible)` | – (derived columns) | – | same index on `asks` |
| 0019 | `ix_log_l_present_evicted` (`strpos(val,'present_evicted')`) | text search | per events insert | `events.op` column |

### 3.3 Python code that walks a whole collection and filters by a field

This section is the in-memory half: the code loads records and filters, sorts, counts or joins in
Python. The table lists every site the three code surveys found, grouped by collection. "Hot" marks
sites on a per-turn, per-request (polled) or per-save path.

#### Agents (`org.nodes`)

- **parent (children maps, subtrees, peers).**
  - `ledger.children_index` 1781 builds a full children map. It is called by `tree` 12208,
    `tree_node` 12017 and `audit` 12000. **Hot:** every tree build, and supervisor `_org_state_parts`
    8008 on **every turn**.
  - `ledger.children` 1803 (the un-indexed path), `committed`/`free` 1819/1825 and `_peers_of` 4876.
    **Hot:** supervisor `_roster_facts` 8248–8253, two `children()` plus `free()` on **every turn**.
    The others run on every hire, retire, move, swap and insert.
  - `descendants`/`descendant_set` 1905/1941 go one generation per statement on lazy maps, and do a
    whole `children_index` on whole maps. Used by demote, promote, `_move`, revoke_dir and placement
    checks.
  - Others:
    - `_stranding_warnings` 2526;
    - `audience_grant` 4510;
    - `_new_node` 5298/5317 (max `ui_order` over siblings);
    - `reorder` 8468;
    - `credit_headroom` 10036;
    - `_taken_with` 6012;
    - `_sweep_dirs`/`_lazy_subtree_index` 7875/7915;
    - `drop_phantom_generation` 11818;
    - `_work_live_tops` 17628 (supervisor 20 s keeper);
    - lifecycle_tx `_dissolve_all_rows` 664;
    - supervisor `_render_chart`/`_subtree_ids` 7810–7901 (`orgtree_chart`);
    - `_invariant_sweep_org._new_orphan` 30892 (tick 30 s);
    - `org_summary.top_level_holds` 50.
- **state.**
  - `ledger.audit` 12001 runs on **every tree build** and every kiosk cap check.
  - Others:
    - `set_kiosk_ceiling` 2347;
    - `extern_recipients_preview` 4231;
    - halt `killswitch_release` 1661;
    - supervisor `remote_reap` 28330 (every save while a remote-control process runs, with a fresh full
      load);
    - `hard_freeze` 29298;
    - `_storage_check_disk`/`storage_check` 29412/29489 (20 s and per tool call);
    - `interrupt_all` 29781;
    - warmpool `_keeper_pass` 2832 (every save poke, ≤60 s) and `_pool_snapshot` 3004 (60 s).
- **predecessor / successor / lineage** (including scans by `nid@` id prefix):
  - `backfill_seat_ids` 761 (load heal);
  - `rename` 9578/9590;
  - `repair_rename_identity` 9910;
  - `drop_phantom_generation` 11843;
  - lifecycle_tx `_rename_plan` 335/339 and `_repair_plan` 903;
  - supervisor `_rename_locked` 4188 and `drop_phantom_generation.rows` 27410.

  `lineage_stack` 1888 and `ancestors` 1832 follow pointers one row at a time, and are fine.
- **session_id.** These scan to find an agent by session:
  - supervisor `_predecessor_generation` 4384;
  - `_transcript_root` 4641;
  - `_fork_bearer_session` 27153;
  - `_session_sharers` 27268;
  - `_phantom_evidence`/`recover_lost_generation` 27370/27543;
  - api `_disk_classify` 15179 (`GET /disk`: up to 500 files × every agent).
- **seat_id.** `backfill_seat_ids` 753 runs on every whole load and on materialize. `toolwait._destination`
  116 finds the newest generation of a seat.
- **model / account.**
  - `fable_limit_hit` 11416;
  - supervisor `_fable_limit_spec` 20761;
  - `announce_missing_rebind_candidates` 16857 (every org, materializes inside a transaction);
  - `node_field_values(account)` 35672.
- **Runtime flags** (frozen, limit_locked, halt, halt_queue, mail_drain, remote_controlled,
  pending_switch, inflight):
  - `_initialize_doc` 1372 (limit_locked pop on every load);
  - `unstick` 11495, `clear_fable_lock` 11521;
  - halt `killswitch_latch` 1616–1636;
  - `account_fallback.candidates` 433;
  - supervisor:
    - `_stamp_wakes_on_save` 6305 (**every save**);
    - `_resume_rows` 20829, `resume_frozen` 30110, `auto_resume_ready` 30637;
    - `_invariant_sweep_org` 30809/30829 (tick 30 s);
    - the auto-resume gate 31021/31048 (tick 30 s);
    - `clear_hard_freeze` 29331;
    - `_reconcile_block` 36328/36392 (startup).
- **cost_usd.**
  - `ledger.cost_total` 6054 is used by the tree header, supervisor `_after_turn` 26653 (**every turn
    end**), 14818, 27848, 28077 and api 2046/4110.
  - `tree_header` 12304 runs `any(cost_usd_unknown)` on every tree build.
- **Whole-table heals and hashes.**
  - `Org.__init__` heals run on every load of a whole map: 753/761, 1327, 1396, 1399 `convert_turns`,
    1441 scope/ui_order/charter, 1651, 1693.
  - `set_kiosk_ceiling` 2305 and api `_org_settings_apply` 3838 rewrite every agent's scope.
  - `tree_fast.StatusProjection.capture` 23 hashes every agent after each full rebuild of the delta
    tree.

#### Docket items (`work_items`, `work_items_archive`, `work_scope_log`)

- **Source lists.**
  - `_work_active` 12646.
  - `_work_archive` 12672 loads the whole archive.
  - The projection reads `_WORK_PROJ` (slug, title, status, owner, created_by, participants, reviewer,
    manual_attention, docket_at, updated_at) from **every archived row** through `LazyDoc.project`.
- **Lookups by slug.**
  - `_work_find` 12929 is a linear scan that loads the whole archive on a miss. It runs on most
    mutations, HTTP routes and get fallbacks.
  - Also: `_work_pointer_target` 12747, `_work_archived_item` 12772, `_work_get_for` 13400,
    `_work_children_of` 19810, `_work_parent_check`/`work_supersede` 19927/19956.
- **Identity and names.**
  - `work_identity_state` 12959 runs on **every `orgtree_work` call and HTTP read guard** (active
    items plus the archive index).
  - Also: `_work_names_in_use` 12857, `_work_backfill_slugs` 12898 (every mutation),
    `work_identity_migrate` 13042.
- **Access** (`_work_can_read` 13183, `_work_can_manage` 13170) is checked per item. The rule:

  | Who may read | Condition |
  |---|---|
  | the user | always |
  | owner | – |
  | creator | – |
  | strict ancestors | of the owner, or of the creator when there is no owner |
  | participants | – |
  | reviewer | – |

  On the indexed path the rule is precomputed into `work_read_access` after every save
  (`workread.refresh`).
- **Holders.** `_work_holders` 13244 and `_work_read_standing`/`work_item_read_grant` 13312/13326. The
  read grant iterates every active item for `orgtree_read_scratch`/`orgtree_read_transcript`.
- **Status, attention and age classifiers.**
  - `_work_attention`, `_work_eligible`, `_work_archived`, `_work_backlogged`, `_work_counts_active`
    13461–13599, applied per item.
  - `_work_sweep`/`_work_archive_eligible` 13601/13626 run **at the head of every docket mutation**.
- **Counts and lists.**
  - `work_counts` 14530 and `work_attention_raises` 14562 cover active items plus the archive
    projection. **Hot:** every full tree build (the 1.0–1.2 s of 2.1).
  - `work_list` 14799 and `_work_list_payload` 14921 sort by `docket_at‖updated_at, slug`.
- **Reminder and abandoned passes** (supervisor every 20 s): `_work_owed_active`, `work_blocked_only`,
  `work_idle_reminder_items`, `_work_nonterminal_org`, `work_org_all_blocked`,
  `work_docket_reminder_items` 14646–14755, and `_work_abandoned_candidates` 17590.
- **Questions joined to items.** `_work_questions` 13441 scans every ask per item (O(items × asks)).
  `notification_state.question_items`/`reconcile_attention` read all active items on every save that
  touches `work_items` or `asks`, and on every load.
- **Pointer rewrites.**
  - `_rekey_work_identity` 9786 rewrites every item on agent rename.
  - `_work_mark_deleted_holders` 13751 runs on agent delete.
  - `work_delete` 19814 rewrites dependencies and superseded_by in every item.
- **Other modules.**
  - `desktop_notifications._attention` 103 covers all active items with attention (polled 5 s).
  - `gitworkspace.org_facts` 92 deep-copies the whole document, so it loads the archive.
  - `gitworkspace.associations` 710 maps slugs over active plus archive.
  - `gitapi` 77–260; `quickstaff` 56; `staffdoor` 275; `rcdoor`/api reservation visibility (one
    `_work_get_for` per reservation row).

#### Mail, notices and delivery

- **Unread mailbox** (`mail<US>owner`, one row per owner).
  - `mailbox_in_receive_order` 3320 and `inbox.pending_rows`/`build_list` 244–353 sort by `recv_seq`.
  - `_assigned_recv_max` 3130, `deposit_mail` supersede 3228 and `waking_mail` 4747.
  - Supervisor turn-admission lookups by id: 11876–11968, 21339, 3083, 33216, 10874.
  - `_auto_wake_cancel_tx` 14242 filters the box **and the owner's whole mail archive**.
  - api `_send_receipt`, `_retract_mail` and `node_chat` lookups by id.
- **Mail archive** (`mail_log`).
  - The inbox route falls back from `from == nid` to **every owner** (api 15890–15915).
  - Lookups by id over the whole owner archive: `mail_one` 10159 and `resolve_reply_target` 20183.
  - `_work_mark_review_requests_stale` 17323 covers the reviewers' archives, and **every owner's
    archive** when history is folded.
  - `_scan_receive_order` and `migrate_mail_receive_order` 3384–3711; `mail_seq_state` 3160.
- **Delivery batches** (`delivering`), mail transitions, steer and manual attempts: about 60 sites in
  supervisor, mailruntime, mailownership, maildrain and inbox look up a batch by token, mail id or
  delivery id. Some of them walk **all owners**: supervisor 11598, 36029–36058, 36478 and
  ledger orphans 2865.
- **Notices** (`notices<US>owner`, `notice_log`). `_fold_notices` 4824 groups by event variant. The
  history panel scans the whole notice log (3.1).
- **User mail** (`user_inbox`, `user_mail_log`, `user_outbox`).
  - `file_read_mail` 275 **loads the whole `user_mail_log`** to insert one row in `at` order.
  - The tree header counts unread and urgent mail.
  - Every user send loads the whole `user_outbox` to append.
- **Org inbox** (`org_inbox`). Every external in or out message loads the whole log
  (`_org_inbox_log` 4373). net.py hub state rescans it by id or net_id.

#### Questions, audiences, watchdogs, documents, reservations, events

- **asks / credit_requests / scope_requests** (one doc blob each; credit and scope requests are never
  pruned).
  - `open_request` 11060 runs in the identity prompt on **every turn**.
  - `node_ask` 11077 runs once **per agent per tree build**.
  - `tree_header` 12239–12292 filters, sorts and keeps the last 12.
  - `ask_user`, `withdraw_ask`, `_moot_asks`, `request_credits`, `request_scope`, `resolve_batch`, the
    answer routes and `desktop_notifications._attention` (5 s).
  - The 0004 trigger re-parses the whole array on every write.
- **audiences** (one blob). `_has_audience` 4307 is a linear scan on **every send**, every ask,
  present and credit/scope request, and the per-turn prompts (supervisor 7596, 8079, 9459). Also:
  - `tree_node` 12168 scans audiences **per agent**;
  - `extern_holders` 4330;
  - `_sweep_audiences` 8484 on move, swap and insert;
  - `identity_context` (SQL over the parsed blob) on every turn admission.
- **watchdogs** (one blob, at most 32). Supervisor `_wd_tick` 35366 filters on the engine tick.
  `_watchdog` 9089 looks up by id. `watchdog_fire` 9374 **loads the whole `watchdog_history`** to
  append.
- **documents** (presentations).
  - `tree_node` 12184 runs per agent per full tree build.
  - The gallery parses every body (`val::jsonb - 'body'`); opening one text-searches all bodies.
  - `present_document` 10519 loads the whole log to replace one.
  - Download and mockup load the whole org.
- **reservations** (one blob, history never pruned). Every action in `reservations.py` 141–590 filters
  the whole list: by id, resource, state, owner, item, integration_key and path prefix.
- **events** (log). History panel (3.1). `repair_rename_identity`/`_repair_plan` scan all events for
  `op == 'rename'`. `document_gallery` is the fallback path.
- **op_receipts** (log, ≤500). `opreceipts.find` 579 reverse-scans the whole log on **every keyed
  agent call**. `applied_since` 858 is used by supervisor `_retry_replay`.
- **lifecycle** (log, ≤512). `latest`/`has_state` 239–253 scan the whole log (supervisor
  `_steer_late_sweep`).
- **Per-agent logs** (`steered_log`, `turn_log`, `turn_error_log`). The desk chat window is
  index-bounded (`ix_log_d_steered_tail`). But "load older" (chat_window `read_page`),
  `_read_chat_source`, `_trim_steer_attempts`, `_apply_steer_record`, `scan_steer_records` and
  `history._turn_log_rows_from` each read **the agent's whole log**.

### 3.4 Loops and routes that load the whole org

Periodic supervisor loops that read org state:

| Loop | Interval | Reads |
|---|---|---|
| auto-resume | 30 s per org | Policy-graph gate (live and frozen rows plus their parent and predecessor chains). Then `_auto_resume_org`: `auto_resume_ready` **walks every agent inside a `halt.txn`** (it decodes all 1,208 rows), plus `account_fallback.candidates` and `resume_frozen`. Then the invariant sweep. |
| working-cache keeper | 20 s | Abandoned-docket pass (`_work_live_tops` materializes the agents while any abandoned item exists), idle reminders (seats × items), checkup/keepalive |
| watchdog engine | 5 s | `policy_reads.watchdog_org` (one SQL, parses the watchdogs blob) |
| storage watchdog | 20 s | `storage_org`; `storage_check` with `load_org` + a live walk for kiosk/sandbox orgs |
| mail drain | 1 s (or kicked) | point reads for up to 32 seats |

HTTP routes:

| Kind | Routes |
|---|---|
| **Fresh whole-document load** (`store.load_org`) | `GET /api/accounts` (**every org**, plus a walk); the `/anthropic` proxy (once per model request from a sandboxed org); `GET /audiences`, `/net`, `/bridge-credential`, `/orgmd`; node file, scratch, toolimg, reply-events and upload; document download and mockup; docket attachment and artifact files; the disk routes; the ops pre-reads; the docket, history and events fallbacks. `list_orgs_with_docs` loads every org on a 5 s TTL for public-port and bridge traffic. |
| **Shared snapshot** (`cached_org`; rebuilt after a commit) | `GET /api/orgs/{slug}` (the tree, polled about every 6 s); node detail; staffing options; quick-staff; `orgtree_chart`; `orgtree_read_transcript` / `orgtree_read_scratch`; `orgtree_send_file` |
| **Partial loaders** (`load_runtime_org`) | `GET /nodes/{nid}/chat` (polled; it still reads every agent row, 2.1) and agent identity fallbacks |
| **Narrow readers** (SQL over the side tables, which this design moves onto columns) | foreground tree; docket foreground, archive page, references and get; inbox; documents; history; events; agent inbox |

## 4. Lists stored inside a record, and the table that replaces each

The rule (user, 2026-10-02, decisions 2–3 on the item) has three parts:

- A **many-to-one** link becomes a foreign-key column on the "many" side.
- A **many-to-many** link becomes a link table, one row per link, indexed on both sides.
- **No list or array is stored inside a row.**

A list of sub-records that belong to one parent (an item's evidence rows, an agent's turns) is a
one-to-many relationship. It becomes a child table whose rows carry the parent's key (a many-to-one
foreign key on the child), per the same rule.

Counts are from the live copy (`probe/fields-org2.json`). "max" is the longest list seen.

### 4.1 Agents (`nodes` rows)

| Embedded list (field) | Seen | Kind | Replacement |
|---|---|---|---|
| `scope.add_dirs[]` {path, mode} | every agent | many-to-many agent ↔ folder | `agent_dir_grants(agent_id, path, mode)`, PK (agent_id, path), index (path) |
| `scope.tools.mcp[]` (server names) | every agent | many-to-many agent ↔ MCP server | `agent_mcp_servers(agent_id, server)`, index (server) |
| `turns[]` (≤8 TurnStat; a copy of the newest turn-log rows) | 1,187, max 8 | one-to-many | rows of `agent_turns` (one table for the whole turn log, see 4.4); the newest 8 by index |
| `turn_est_cost[]`, `turn_est_toks[]` (fixed tuples) | 1,187 | fixed-shape tuple | columns `turn_est_cost_at/_usd/_extra`, `turn_est_toks_at/_n` on `agents` |
| `last_denials[]`, `last_approvals[]` {tool, arg, cwd} | 1,181 / 142, max 6 / 8 | one-to-many | `agent_tool_prompts(agent_id, kind, pos, tool, arg, cwd)` |
| `last_turn_mcp_tools[]` (names) | 1,045, max 366 | one-to-many | `agent_turn_tools(agent_id, tool)` |
| `halt_queue[]` (durable pending carriers), `native_held_carriers[]` | 86, max 2 | one-to-many | `agent_carriers(agent_id, carrier_id, pos, …)` + `carrier_mail(carrier_id, mail_id)` |
| `mail_drain.ids[]` | 13 | many-to-many agent ↔ mail | `agent_mail_drain(agent_id, mail_id)` |
| `external_handles[]` (retired, still stored) | rare | one-to-many | `agent_external_handles(agent_id, handle)` |
| `oracle_exchanges[]` | rare | one-to-many | `agent_oracle_exchanges(agent_id, pos, …)` |
| `frozen.resume_texts[]` / `resume_views[]` | 10 | one-to-many under the freeze | `agent_freeze_resume(agent_id, pos, text, view)` |
| `desktop_import.history` and nested lists | 387 | imported provenance record | see open question Q1 (design §8) |
| `codex_route_last.*`, `envelope.usage`, `cache_continuity.*`, `codex_usage_*` | 206–889 | provider-reported records | see Q1 |

The many-to-one links already in agent rows become foreign-key columns, not tables:

- `parent` → `parent_id`;
- `predecessor` → `predecessor_id`;
- `successor` → `successor_id`.

There is no stored list of parents. `lineage` is one string per agent (its lineage id), and ancestry
is derived by a recursive query over `parent_id` (design §3.4).

### 4.2 Docket items (active `doc` rows and archived `log_l` rows)

| Embedded list (field) | Seen in 1,087 items | Kind | Replacement |
|---|---|---|---|
| `participants[]` (agent ids) | 536 links, max 21 | many-to-many item ↔ agent | `work_item_participants(slug, agent_id)`, indexes both ways |
| `dependencies[]` (slugs) | 138 links, max 13 | many-to-many item ↔ item | `work_item_dependencies(slug, depends_on)`, indexes both ways |
| `holders[]` {node, generation, born, from, by, derived} | 863, max 12 | one-to-many | `work_item_holders(slug, seq, agent_id, generation, born, from_at, by_id, derived)` |
| `acceptance[]` {text, checked, check_history[]} | 2,627, max 10 | one-to-many (with a child list) | `work_item_acceptance(slug, idx, text)` + `work_item_acceptance_checks(slug, idx, seq, …)` |
| `done_so_far[]`, `working_on_next[]` | 4,689 / 948 | one-to-many | `work_item_progress(slug, list, pos, text)` |
| `evidence[]` | 4,618, max 50 | one-to-many | `work_item_evidence(slug, seq, at, by_id, kind, ref, note, …)` |
| `history[]` | 19,180, max 100 | one-to-many | `work_item_history(slug, seq, at, by_id, op, …)` |
| `dismissals[]` | 49 | one-to-many | `work_item_dismissals(slug, seq, at, by, set_rev, reason)` |
| `candidate_verdicts[]` (and `candidate_verdict` = latest) | 655 | one-to-many | `work_item_verdicts(slug, seq, candidate, decision, …)`; latest by query |
| `review_packets[]` (and `review_packet` = latest) | 881 | one-to-many | `work_item_review_packets(slug, seq, …)` |
| `review_seats[]` | 657 | one-to-many | `work_item_review_seats(slug, seq, reviewer_id, holder_id, …)` |
| `review_seat_requests[]` | 258 | one-to-many | `work_item_review_seat_requests(slug, seq, …)` |
| `scope[]` / `scope_archive[]` (inline) and `work_scope_log` rows | 1,290 + 326 | one-to-many | one table `work_item_scope(slug, seq, at, by_id, kind, before, after, mode, supersedes, superseded_by, text)` |
| `artifacts[]` {…, grants[]} | 547 | one-to-many + many-to-many | `work_item_artifacts(slug, id, …)` + `work_item_artifact_grants(slug, artifact_id, agent_id)` |
| `findings[]` {…, decisions[]} | 260 | one-to-many (+ child list) | `work_item_findings(slug, id, …)` + `work_item_finding_decisions(slug, finding_id, seq, …)` |
| `quick_staff_receipts{}` | 47 items | one-to-many | `work_item_quick_staff_receipts(slug, receipt_id, …)` |
| `delivery{stage: …}` | 1,017 | one-to-many (≤5 stages) | `work_item_delivery(slug, stage, sha, at, by, …)` |

The many-to-one links in docket items become columns, each with an index:

- `owner` → `owner_id`, `owner_generation`, `owner_born`;
- `created_by` → `created_by_id`, `created_by_generation`;
- `reviewer` → `reviewer_id`, `reviewer_generation`, `reviewer_born`;
- `last_updater` → `last_updater_id`, `last_updater_generation`;
- `parent` → `parent_slug`;
- `superseded_by` → `superseded_by`.

### 4.3 Mail, notices and delivery

| Embedded list | Kind | Replacement |
|---|---|---|
| `mail<US>owner` (a list per owner), `delivering` (list per owner), `mail_log` (rows per owner) | one-to-many recipient → mail | one `mail` table with `recipient_id` and a `state` column (queued / delivering / delivered); see design §3.3 |
| mail `attachments[]` (agent, user and outbox mail) | one-to-many | `mail_attachments(mail_id, pos, name, path, bytes, missing)` |
| `delivering` batch `mail[]` | many-to-many batch ↔ mail | `delivery_batch_mail(batch_tok, mail_id)` |
| `delivering` `notices[]`, `segments[]` | one-to-many | `delivery_batch_notices`, `delivery_batch_segments` |
| `delivering` `delivery_ids[]`, `acked_ids[]`, `recorded_ids[]`, `engines[]` | one-to-many | `delivery_batch_deliveries(batch_tok, delivery_id, role)`, `delivery_batch_engines(batch_tok, pid)` |
| `steered_log` rows: `mail_ids[]`, `delivery_ids[]`, `acked_ids[]`, `recorded_ids[]`, `segments[]` | many-to-many steer ↔ mail; one-to-many | `steer_record_mail(steer_seq, mail_id)`, `steer_record_deliveries(steer_seq, delivery_id, role)`, `steer_record_segments` |
| `steer_attempts` (dict per owner): `toks[]`, `mail_ids[]`, `views[]` | one-to-many / many-to-many | `steer_attempts`, `steer_attempt_mail`, `steer_attempt_tokens` |
| `manual_attempts` (dict per owner): `mail_ids[]`, `digests{}`, `chunk_calls[]`, `plan{}` | one-to-many | `manual_attempts`, `manual_attempt_mail`, `manual_chunk_calls`, `manual_chunks` |
| `mail_transitions` (dict of receipts): `deliveries{}`, `before{}` | one-to-many | `mail_transition_receipts` + `mail_transition_deliveries`. `receipt_carriers` (0013) already holds the custody carriers |
| `notices<US>owner` (list per owner) | one-to-many | `notices(id, agent_id, at, text, ev, state)`; `notice_log` becomes the delivered rows of the same table |
| `user_inbox[]`, `user_mail_log`, `user_outbox` | one-to-many | `user_mail` (inbox and archive, `state` column) and the user's sent rows in `mail` |
| `org_inbox` | one-to-many | `org_inbox(seq, dir, peer, by, at, state, net_id, body)` |

### 4.4 Questions, audiences, watchdogs, documents, reservations, logs, settings

| Embedded list | Kind | Replacement |
|---|---|---|
| `asks[]`, `credit_requests[]`, `scope_requests[]` (doc blobs) | one-to-many agent → request | `asks(id, agent_id, kind, status, at, resolved_at, …)` |
| ask `questions[]` / `options[]` / `answer.selected[]` | one-to-many | `ask_questions(ask_id, pos, …)`, `ask_question_options(ask_id, q_pos, pos, label, description)`, `ask_answer_selections(ask_id, q_pos, pos, value)` |
| ask `work_items[]` / question `work_item` | many-to-many ask ↔ item | `ask_work_items(ask_id, slug)`, indexes both ways |
| scope_request `items[]` | one-to-many | `scope_request_items(ask_id, pos, kind, path, mode, tool, decision)` |
| `audiences[]` | many-to-many agent ↔ agent (grantor, grantee) | `audience_grants(grantee_id, grantor_id, granted_at, reason, delegated_by)`, PK (grantee, grantor), index (grantor) |
| `audience_requests[]` | one-to-many | `audience_requests(id, from_id, target_id, …)` |
| `watchdogs[]`, `watchdog_tombs[]` | one-to-many owner → watchdog | `watchdogs(id, owner_id, …, spent_at)` |
| watchdog `events[]` ring and `watchdog_history` log | one-to-many | `watchdog_events(watchdog_id, seq, at, gist, body)` |
| `reservations[]` | one-to-many | `reservations(id, owner_id, item_slug, resource, state, …)` |
| reservation `paths[]` | one-to-many | `reservation_paths(reservation_id, path)`, index (path) |
| `documents` log | one-to-many agent → document | `documents(id, agent_id, title, at, format, file, bytes, body)` |
| `events` log: `detail.node`, `to`, `grantee`, `from`, `actor`, `removed[]`, `moved_from[]`, `which[]` | many-to-many event ↔ agent | `events(seq, op, actor_id, at, item_slug, detail)` + `event_agents(event_seq, agent_id, role)`, index (agent_id, seq DESC) |
| event `warnings[]` | one-to-many | `event_warnings(event_seq, pos, text)` |
| `turn_log` (rows per agent) and the agents' `turns[]` copy | one-to-many | `agent_turns(agent_id, seq, at, cost, ms, toks, …)` |
| `turn_error_log` | one-to-many | `agent_turn_errors(agent_id, seq, at, text, ran_as)` |
| `op_receipts` log: `targets{}`, `post_effects.expected[]` | one-to-many | `op_receipts(id, node_id, key, …)` + `op_receipt_effects(op_id, pos, effect)`, index (node_id, key) |
| `lifecycle` log | one-to-many | `lifecycle(operation_id, state, …)`, index (operation_id, state) |
| org `dirs[]`, `kiosk.max_scope.add_dirs[]` / `mcp[]`, `default_tools.mcp[]` | one-to-many | `org_dirs(path, mode)`, `org_kiosk_dirs`, `org_kiosk_mcp`, `org_default_mcp` |
| `net_hubs[]`, `net_state{hub: {seen_ids[]}}`, `net_spool{hub: [entries]}` | one-to-many | `net_hubs`, `net_hub_seen(hub_id, id)`, `net_spool(hub_id, entry_id, …)` |
| `desktop_import.active_nodes[]`, `warnings[]` | one-to-many | `desktop_import_nodes`, `desktop_import_warnings` |
| `tiers{}`, `models{}` (tier → price, tier → model) | one-to-many | `org_tiers(tier, price, model)` |
| `work_deleted_names[]` | one-to-many | `work_deleted_names(slug)` |

Derived side tables that hold lists today (`work_index.summary` with participants and dependencies,
`work_read_questions.questions`, `foreground_blobs.entries`) go away with their triggers.

## 5. What the audit means for the design

1. **The lookups need columns, not more side tables.** Every slow lookup in 2.2 filters on a field
   that the design makes a typed column of the record's own table. The side tables in 3.2 exist only
   because those columns did not. They are maintained by per-row triggers, which cost more than the
   lookups they serve on any write-heavy path.
2. **The biggest wins are in Python, not SQL.** The worst costs come from code that loads a whole
   collection to answer a narrow question:
   - the 1–1.2 s archive projection;
   - per-turn agent decodes;
   - per-tree-build scans of audiences, asks and documents;
   - whole-log appends.

   Columns only help once those call sites ask the database instead. The design therefore pairs each
   table with the queries that replace the scans in 3.3, in the same stage.
3. **Write cost.** A one-field change rewrites a whole 12 KB agent row today: 440 ms per 400 rows
   with the engine's own statement and no trigger, 657 ms with the triggers. With typed columns, a
   re-parent or state change updates small columns only. PostgreSQL keeps an unchanged large column
   in place, so the large free-form parts are rewritten only when they change.
4. **Already-bounded paths keep their shape:** Sent via `mail_sent`, the chat tail, the gallery
   evictions and the windowed card reads. The same query runs against real columns, and the trigger
   that kept its side table is dropped.
