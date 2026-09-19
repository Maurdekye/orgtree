# State-access rearchitecture — route/invariant inventory, measured baseline, and phased design

Docket item: `rearchitect-data-access-so-reading-one-thing-doe`.
Branch: `state-io/state-access-rearchitecture` from main `cb702e7`.
Author: state-io. Status: design + inventory (Phase 0 deliverable); updated as phases land.

## 1. The measured baseline (2026-09-19, live-org copy)

Source: `VACUUM INTO` snapshot of the live `orgtree.db` taken 2026-09-19T14:35Z
(101.0 MB vacuumed; the live file was 108 MB + 11 MB WAL). Machine: the user's
own. Python 3.10 (system; the packaged runtime is 3.13 — same order of costs).

| table | rows | bytes |
|---|---:|---:|
| `doc` | 57 | 2,399,169 |
| `nodes` | 709 | 8,794,660 |
| `log_d` | 20,734 | 49,626,495 |
| `log_l` | 38,556 | 24,566,925 |

Eager load = `doc` + `nodes` = **11.19 MB**. Biggest doc blobs: `notices`
1,010 KB · `work_items` 576 KB · `mail` 379 KB · `asks` 142 KB · `lifecycle`
119 KB · `delivering` 118 KB.

Measured costs (uncontended, single thread):

| operation | cost |
|---|---|
| `load_org` | 165–263 ms |
| — of which: SQL read doc+nodes | 52 ms |
| — of which: `json.loads` doc blobs | 17 ms |
| — of which: `json.loads` 709 node rows | 107 ms |
| — of which: `Org.__init__` node-migration walk + backfills | remainder (~40–90 ms) |
| `save_org` with **zero** changes | 138 ms |
| — of which: `json.dumps` of all 709 nodes (compare-on-save) | 81 ms |
| classic write cycle (`DOC_LOCK` → load → 1-field mutate → save) | **260–400 ms** |

The write cycle costs the same whether it changes one byte or one megabyte:
the load parses 11.19 MB and the save re-serializes ~11 MB to discover what
changed. Every one of the ~210 write sites pays this **serialized behind one
process-global `DOC_LOCK`**, and a single agent tool call performs 3–6 loads
(identity gates, halt gate, admission, dispatch) plus 1–3 save cycles.
340 ms × queueing under concurrent agents ≈ the observed ~2.9 Hz aggregate
tool-call cap, and UI writes (answer a question, mark mail read, save agent
settings) queue behind the same lock — which is the user's experienced
timeout symptom. Live confirmation during this work: a docket `update`
through the API took >20 s to commit under concurrent agent load (the MCP
client timed out; the write later proved applied).

### Why this is architectural, not engine-level

SQLite delivers the 11.19 MB in 52 ms; WAL lets readers run beside the
writer; per-row storage for nodes and logs already exists; a lazy-section
mechanism already works (the 74 MB of logs are not the problem — they load
on demand). The remaining cost is **Python materialization of everything to
touch anything**: `json.loads`/`json.dumps` of the whole eager document plus
the `Org.__init__` whole-tree walk, on every cycle, under a global lock.

## 2. Route inventory

Call sites at `cb702e7` (grep-verified):

| module | `load_org` | `save_org` | `load_org_snapshot` | `cached_org` |
|---|---:|---:|---:|---:|
| api.py | 108 | 52 | 5 | 3 |
| supervisor.py | 116 | 115 | 0 | 7 |
| net.py | 19 | 15 | 0 | 0 |
| halt.py | 12 | 8 | 0 | 3 |
| maildrain.py | 6 | 7 | 0 | 0 |
| desktop_recovery.py | 7 | 2 | 0 | 0 |
| sandbox.py | 4 | 2 | 0 | 0 |
| store.py (internal) | 6 | 2 | 1 | 2 |
| 15 other modules | 1–2 each | 0–2 each | 0 | 0–3 |
| **total** | **≈315** | **≈210** | 6 | 20 |

Concentration points (traffic, not site count):

* **`api.py:agent_call`** — the single authenticated MCP dispatch door. Main
  cycle at `api.py:10737`: `with _op_inflight(body), store.DOC_LOCK:` → one
  `load_org` → per-verb dispatch on the loaded `Org` → `save_org`. Several
  additional pre-gate loads per call (`_agent_identity`, `halt.blocked`,
  op-epoch, retire/dissolve pre-checks).
* **`supervisor.py`** — turn lifecycle, delivery, background loops: 115 save
  cycles, each `DOC_LOCK` → load → mutate → save.
* **`maildrain.py`** — the notice/mail delivery worker: per-delivery write
  cycles touching `mail`, `delivering`, `notices`, `mail_log`.
* **HTTP read endpoints** (api.py) — org tree, chat, inboxes, work list:
  per-request `load_org` **outside** the lock (№22), plus a handful already
  on `cached_org`/`load_org_snapshot`/bounded SQL reads
  (`read_events_page`, `read_mail_tails`, `read_user_inbox`,
  `read_document_gallery`, `node_row_exists`, archived-count).
* **Background loops** — already on the shared seq-validated snapshot
  (`cached_org`), but every save pops the whole cached doc, so the next
  loop tick after any write re-parses 11.19 MB.

## 3. Invariant inventory — what the current design actually guarantees

1. **Load–modify–save atomicity (the `DOC_LOCK` contract).** A writer sees
   the latest committed state and its read-check-mutate sequence is not
   interleaved with any other writer's. Protects against: lost updates
   (double delivery of the same notice, two hires spending the same credits,
   two answers consuming one ask), stale authority checks (authority read
   at dispatch time must still hold at mutation time), torn multi-record
   transitions (a mail send = sender's `mail_log` append + recipient queue
   entry + `delivering` journal + event row — all in one save).
2. **Snapshot coherence for readers.** A reader must see one committed
   document state: eager fields and any named lazy sections from one SQLite
   read transaction (`_load_lazy`, `load_org_snapshot`). Readers never
   block the writer (WAL) and never take `DOC_LOCK` (№22).
3. **Save is the change.** `REVISION`/`org_seq` bump, `on_save` fanout,
   `save_hooks`, `pre_save_hooks`, and `reconcile_attention` all ride
   `save_org` — any new write path must preserve exactly this fanout.
4. **Abandoned mutations must not persist.** Today a validation failure
   after partial in-place mutation discards the private loaded copy. Any
   resident/cached-document design must reproduce this discard property.
5. **One backend process per data root** (`.owner` claim) — in-process
   authority over all state is legitimate; there is no cross-process writer
   to coordinate with. `delete_org`/`rename` close pooled connections and
   move files; caches must invalidate on those paths.
6. **Cross-org operations exist** (desktop import, org rename/delete,
   `orgtree_move` between orgs) — a per-org locking scheme needs an ordered
   multi-org acquisition or a global fallback for those.
7. **The JSON backend stays live** as rollback target: every behavioral
   guarantee must hold under `ORGTREE_STORE=json` too (where partial
   loading is impossible — the design degrades to whole-doc there).

## 4. Target architecture

The principle the user set: reads should cost what is read; independent
writes should proceed concurrently where their data and invariants do not
overlap; writes sharing an invariant keep the smallest correct atomic
boundary. Applied to the measured facts, the big wins in order:

### Phase 0 — Instrumentation (before any conversion)

New module `stateprobe.py`: cheap, always-compiled-in counters behind one
`enabled` flag (operator-controlled, like profile-timing), a contextvar
carrying the current operation label (route template or tool verb), and
hooks in store.py:

* `DOC_LOCK` wait and hold duration per operation;
* `load_org` / `load_org_snapshot`: count, ms, eager bytes;
* lazy materialization: section, owner-count, bytes, ms, **operation that
  triggered it** (acceptance condition 1: which lazy sections each hot
  path materializes);
* `save_org`: ms, serialized bytes, changed doc keys / node ids / log rows
  (the differ knows exactly what changed — record it);
* `Org.__init__` construction ms.

Surfaced through the existing operator-only diagnostics timing endpoint
(new allowed fields) plus an aggregate per-operation table endpoint.
This is also the evidence base for the Rust evaluation (§7) and the
symptom-linked verification (§8).

### Phase A — Read paths: cost proportional to what is read

* **A1. Section-granular shared snapshot.** Extend the `org_seq`-validated
  `cached_org` into a per-section cache: every save publishes the exact doc
  keys / node ids / log sections it changed (the differ already computes
  this); the next snapshot rebuild re-reads and re-parses **only those**,
  reusing parsed values for untouched sections and untouched node rows.
  Rebuild after a typical save (one node + `events` + one mailbox) becomes
  a few tens of KB instead of 11.19 MB. Snapshots stay immutable-by-contract
  and are never handed to a write path.
* **A2. Convert read-only API endpoints** from per-request `load_org` to the
  shared snapshot (the heavy ones first: org tree, desk chat reads, mail
  and notice views, work list; the middleware profile identifies the rest).
  Handlers that mutate keep their private write-path copies.
* **A3. Narrow read primitives** where a whole-org object is not needed:
  single-node read (`read_node`) for agent-settings/desk lookups
  (acceptance condition 3), plus bounded SQL reads in the pattern of
  `read_mail_tails` for any remaining tail/page view.

### Phase B — Write paths: cost proportional to what is written

* **B1. Resident write document.** Per org, one long-lived `Org` behind the
  write lock: `store.write_org(slug)` context manager yields it; first use
  loads it, `save_org` (unchanged differ) adopts baselines after each save,
  so subsequent cycles skip the 11.19 MB parse AND the `Org.__init__` walk
  entirely. Invalidation: on exception inside the context (the discard
  property, invariant 4), on `delete_org`/rename/migration/backend restore,
  on any save not made through the resident instance.
* **B2. Access-scoped save.** The remaining per-save cost is the differ's
  full re-serialize (81 ms nodes dump + doc dumps). Track, on the resident
  document only, which top-level doc keys and which individual node ids were
  *exposed mutably* since the last save (top-level `__getitem__` marking on
  the LazyDoc dict + a node-map wrapper with per-id marking); the differ
  then re-serializes only marked entries. Anything untracked falls back to
  the full compare (plain-dict docs, JSON backend, fixtures). A debug/test
  mode re-runs the full compare after each op and asserts the marked set
  covered every actual change — that assertion is the mutation-testable
  control for the tracking.
* **B3. Convert write cycles to `write_org`.** Mechanical, incremental:
  agent_call's central cycle and pre-gates, supervisor cycles, maildrain,
  net, halt, the rest of api.py. The idiom `with store.DOC_LOCK: org =
  store.load_org(slug) … store.save_org(org)` becomes `with
  store.write_org(slug) as org: … store.save_org(org)`.
* **B4. Save-fanout gating.** `reconcile_attention` runs only when
  `work_items`/`asks`/attention inputs are among the changed sections (it
  is a no-op otherwise by construction).

Expected effect of A+B together: the serialized region per write drops from
~340 ms to single-digit ms (mutate + dump of touched entries + one small
WAL commit); read endpoints stop paying per-request parses entirely.

### Phase C — Concurrency: locks match actual invariants

* **C1. Per-org write locks.** `write_org(slug)` takes that org's lock;
  different orgs stop serializing behind one global mutex (they share no
  invariant — separate database files). Cross-org operations take the locks
  of every org involved in canonical slug order (or a global two-phase
  mutex), preserving invariant 6. `DOC_LOCK` remains as the compatibility
  alias during conversion and for the rare whole-root operations.
* **C2. Intra-org concurrency where sections are independent.** After B,
  the per-org serialized region is milliseconds, and SQLite WAL allows only
  one writing transaction per database at an instant anyway — so intra-org
  write parallelism buys little unless measurement says the per-org lock
  still binds under the user's real load. The prerequisite that IS worth
  building now is storage-shape: see Phase D. A finer lock manager
  (per-section/per-owner acquisition in canonical order) is designed and
  documented but implemented only if the equal-demand measurements show
  per-org serialization as a remaining binding constraint. This is the
  "smallest correct atomic boundary" rule applied honestly: correctness
  boundaries stay; speculative lock granularity that measurement does not
  justify is complexity risk, not parallelism.
* **C3. Event-loop hygiene.** All store IO and lock waits already moved off
  the event loop for 18 handlers (`0622230`); verify the remainder at the
  API boundary with the Phase 0 instrumentation (lock-wait on-loop = stall
  for every request, including pure reads) and fix stragglers.

### Phase D — Storage shape for the mutable hot sections

`notices` (1.01 MB), `mail` (379 KB), `delivering` (118 KB), `asks`
(142 KB) are single doc blobs today: delivering one notice re-serializes
1 MB (and, before B2, the whole document). Convert them to per-owner rows
(the `SectionMap`/`AppendLog` machinery already stores dict-of-list
sections as per-owner rows with row-level diffing, including in-place
mutation — `steer_attempts` proves the mutable case). They also become
lazy: a delivery touches one owner's rows only. Same no-operator-migration
path as `work_items_archive` used (doc-blob loads once, converts to rows on
next save). `work_items` (576 KB, whole-docket blob today) gets the same
treatment per item if measurements keep it hot after A+B.

Non-goals, still binding: no storage-engine change, no history pruning, no
rewrite-as-substitute. Everything above stays inside SQLite/WAL + the
existing JSON rollback behavior.

## 5. Compatibility and rollout

* Each phase lands separately, all three suites green at every step
  (acceptance 6): `node-root`, `python-backend` (sanctioned runner),
  `renderer`, compared through `tools/test-baseline.mjs`.
* The JSON backend keeps whole-document behavior (loads are already
  atomic there); `write_org` and the caches apply above the backend split,
  so its semantics are unchanged.
* No push to main until independent review approves the candidate.

## 6. Verification plan (acceptance 4 + user's 2026-09-19 requirements)

Real API doors, concurrent schedules:

1. **Lost-update:** two concurrent writers through the HTTP/tool door
   mutating sibling fields (two settings saves; two credit spends; two
   notice deliveries to one owner) — both effects present afterward.
   Negative control: bypass the write lock / force a stale baseline in a
   test-only hook and show the same test FAIL.
2. **Torn transition:** hammer readers on a mail send / question answer /
   staffing composite while it commits; no reader observes the partial
   state. Negative control: split the composite into two saves in a
   test-only mutation and show the reader catches it.
3. **Stale check:** revoke authority concurrently with a dispatch loop;
   no op applies under revoked authority.
4. **Inconsistent snapshot:** section-cache assembly is seq-consistent —
   a reader never sees section X from seq N and section Y from seq N+1.
   Negative control: skip one section's invalidation deliberately; test
   fails.
5. **Duplicate delivery:** the original DOC_LOCK motivation — concurrent
   drain + send never double-delivers a notice.
6. **Equal-work vs equal-demand, separately:** (a) fixed operation set,
   before/after per-op latency (medians + tails); (b) fixed offered
   concurrency (N synthetic agents + UI poll mix), throughput and tail
   latency curves, before/after, on the 101 MB live-org copy and on a
   small org for scale-independence (acceptance 5). Clearly labelled
   stress curves distinct from observed-load replays.
7. **Symptom-linked routes:** the user-named operations (open inbox,
   answer question, mark mail read, save agent settings) measured
   end-to-end at the HTTP door before/after under concurrent load.

## 7. Rust evaluation (user addition 2026-09-19, "ala
`rebuild-the-backend-in-rust-with-an-opengl-rende`")

Measured on the user's machine against a coherent copy of the live 101 MB
org, at the real HTTP door (uvicorn, full middleware stack), main
`cb702e7` versus this branch at `261e360`. The question, per the user: if
and how much would a Rust backend alleviate the slowness — evaluated
against the actual proposal (Rust behind the existing HTTP+WS JSON
contract), component by component.

### The component table

| cost component | baseline share of a write op | what the Python rearchitecture did | what Rust would add on top |
|---|---|---|---|
| JSON parse of the document (11.19 MB/load, 124 ms; 3–6 loads/call) | ~55 % | **Removed the work**: resident document + section refresh — a warm cycle parses 0 bytes, a snapshot refresh parses only what changed (KBs) | serde parses the same bytes ~3–10× faster — it would have made the *waste* cheaper (≈30–70 ms/cycle instead of ≈250 ms). Applied to the rearchitected access pattern it accelerates KB-scale work: **microseconds** |
| JSON serialize on save (11 MB re-dumped to find a 6 KB change, 81–100 ms) | ~30 % | **Removed the work**: access-scoped save dumps 6 KB for a one-node change | same shape as above: big factor on work that no longer exists |
| `Org.__init__` whole-tree construction (54.6 ms/load) | ~15 % | Paid **once per process** (residency), and skipped for carried nodes on snapshot refreshes | Rust structs would build faster, but a cost paid once per process is not on the hot path in either language |
| lock queueing under concurrency (p50 2,257 ms at 8 writers — the experienced stall) | dominant under load | Cycle shrank 333→~5 ms, so the same global-lock discipline now clears 31.6 ops/s instead of 3.15 | **None intrinsically** — queueing is architecture, not language. A Rust port of the *old* access pattern would have queued the same way; the fix was not loading/serializing the world per write, which is language-independent |
| SQLite commit (WAL, `synchronous=FULL` fsync) | 1–3 ms/write | unchanged (correctness boundary) | **Zero** — same library, same disk, same fsync |
| HTTP/framework/dispatch/verb bookkeeping | ~9 ms/verb residual (13.9 ms door vs ~5 ms storage cycle) | untouched so far | Real: axum/actix + serde validation typically cut framework overhead 5–20×, plausibly ~2–4 ms/verb total. Matters at sustained >100 ops/s; invisible below that |
| CPU-parallel reads under load (org-tree render p50 519 ms under 8 writers; annotate + ~1 MB payload build, GIL-crowded) | the remaining visible UI cost | not yet addressed (next target: seq-validated annotated-tree cache — the same section-refresh idea one level up) | **Genuine**: no GIL means concurrent tree builds/annotates parallelize across cores. This is the one component where Rust buys something the current architecture has not already reached — though the planned Python-side cache attacks the same number from the other side (build once per change instead of per request) |
| renderer / OpenGL half | out of backend scope | — | unmeasured; the item's own coordinator analysis stands (renderer profile still INFERRED — a Chrome trace is the precursor, not a rewrite) |

### Reading of the table

The baseline slowness was ~90 % *avoidable work* — parsing and serializing
megabytes nobody asked for, under one lock — and that is now removed in
Python: 10.0× concurrent throughput and 9–13× on the user-named UI
operations, measured at the door. A Rust rewrite executing the OLD access
pattern would have delivered roughly 3–10× on the same waste (serde speed)
and none of the queueing fix; a Rust rewrite of the NEW access pattern
would take the residual ~14 ms write op to perhaps 2–4 ms and would
genuinely parallelize CPU-heavy concurrent reads. Against that stand the
proposal's own recorded costs: ~120k lines including an MCP tool surface
whose exact behavior (refusals included) every agent is written against,
and the storage/fsync floor it cannot move.

**Recommendation** (evaluation only; implementation needs explicit user
authorization): do not start the Rust backend for performance. The
measured bottleneck was access-pattern, not language, and its removal is
already delivered and verifiable in the beta. Revisit only if, after the
swarm retest plus the tree-payload cache and Phases C/D land, the product
still needs sustained >100 write ops/s or sub-5 ms verbs — those are the
regimes where the remaining language-bound ~10 ms and the GIL become the
binding constraint. The OpenGL frontend half remains ungated by any of
this and still wants its profiling pass first.

## 8. Risks

* **Resident-doc staleness** if any writer bypasses `write_org` after B3 —
  mitigated by save-through-resident detection (a save whose object is not
  the resident instance invalidates it and logs loudly in dev), plus the
  full-compare debug assertion in tests.
* **Marking misses a mutation** (B2) — mitigated by conservative fallback
  (anything reached without tracking = full compare), the debug-mode
  assertion, and negative-control tests that deliberately mutate untracked
  state and require the assertion to fire.
* **Cache coherence across delete/rename/migrate** — single choke points
  in store.py; each already closes pooled connections, extended to drop
  resident + section caches.
* **JSON rollback parity** — suites run against both backends where they
  already do; write_org on JSON is just DOC_LOCK + load (no residency).
