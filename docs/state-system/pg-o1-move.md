# Parent-only native moves for 3.2.0-alpha.1

Proposal 2, 2026-10-04. Base: v3 `4afac9a2bd38702d0c806c9b8b8769da4ede2679`.
Design approval from drag-opus AND review-sol precedes implementation. This is the
real native move path in alpha.1; legacy storage retains its existing behavior.
Implementation approve_stage with deliberate faults precedes the pre-granted v3
landing. The coordinator alone builds alpha.1 after that landing.

This revision carries O1 item decision4 (the user's audience, warning and running-turn
choices), decision5 (the design owner's reduced architecture), decision6 (bounded
subscription replacements) and decision7 (every changed placement root is captured).
Proposal1's lineage slots and client-side capability
fold are withdrawn. Decisions40/41 on the umbrella authorize configured scope
restoration through current ancestors.

## 1. Bound and measured motivation

The target is independence from descendant count S. Normal aligned lineage costs
O(h + L), plus index costs and O(B) required notice recipients: h is ancestor depth,
L is the moved agent's OWN predecessor chain, B is the old/new peer output. There
is no descendant walk, lock, rewrite or deferred capture expansion at move time.
A move is not independent of h, L or required output. Separate total COMMIT and
revision-row hold time from the later read/projection work.

MEASURED prerequisite: speed-audit commit0799f5f, immutable audit r4/r5, actual A8
move of coordinator-opus under coordinator-astra-2 on an owned live copy. N=1208,
S=1144, L=62. Of 787.024 ms exclusive profiled time, bearer body rewrites consume
321.737 ms, the root body rewrite 6.318 ms and subtree-walking stages 145.215 ms.
No ordinary descendant body changed in that case, but all1208 agents were locked.
The 62 full child-table reconstructions are replaced with one scalar batch. These
are old-path measurements, not evidence that the new implementation is fast yet.

If historical bearers have different current parents, keep those parents until the
actual move, as today. Lock and maintain the union U of their old paths plus the
new path; its worst bound is O(L*h). This is still independent of S. Do not claim
O(h+L) for that exceptional shape without measuring its distinct paths. No second
placement authority or migration normalization is introduced.

## 2. State representation and read costs

`agents.parent_id` remains the ONLY placement authority, with its existing FK.
Names, born/generation, predecessor/successor, archive state, sort keys and stranded
bearer children keep their existing meanings. Follow `Org.lineage_stack`'s canonical
PREDECESSOR chain (`ledger.py:1833`), not every reverse-successor row: the measured
copy has multiple reverse-successor candidates.

| State | Stored or derived | Move work |
| --- | --- | --- |
| Moved root parent | Existing parent_id and row_version | One scalar header |
| Own lineage bearer parents | Existing parent_id, unchanged payload/child rows | One version-fenced UPDATE FROM batch over L rows |
| Ordinary descendant parents | Existing direct edges | None |
| Ancestors/depth | One current upward CTE or a consistent-snapshot memo, O(h) per selected read | Root/destination/authority paths only |
| Effective capability scope | Python intersection of configured scopes on the current chain, O(h times scope payload) | No descendant scope writes |
| Own subtree height/count | Typed `agent_subtree_stats`, eagerly maintained | Affected ancestor paths only |
| Grants/free | Exact existing scalar grants and seat-cost rules | LCA-path scalar deltas, O(h) |
| Audiences | Stored grant plus current anchor ancestry predicate | No whole-org sweep; explicit revoke alone deletes |
| Notices and move log | Existing exact roles/count tail, approved short scope summary | O(B) required output, no S enumeration |
| Record bodies | Python effective values, read-side expansion of scopes for every changed placement root | O(L) scope markers, no S expansion under revision |

### 2.1 Small, exact subtree aggregates

Add `agent_subtree_stats(agent_id PK FK->agents, parent_agent_id, descendants,
height, org_children_count, visible_children)`. Only a column with a named existing reader belongs:
- `descendants`: the move notice tail (`ledger.py:7233`), counting all ordinary
  descendant rows the current `descendants(..., live_only=False)` returns;
- `height`: the existing root-only depth-cap check (`ledger.py:7144`), leaf=0,
  archived nodes counted as today;
- `org_children_count`: the existing child-cap check (`ledger.py:7156`), using
  EXACTLY `org_children` (`ledger.py:1805`): exclude an ARCHIVED node with a truthy
  successor, not every successor and not every non-live node.
- `visible_children`: direct non-tombstone physical children, including archived
  bearers; `graph.clean_stats` uses it through the tombstone-parent partial index.

The cached parent deliberately duplicates agents.parent_id. Add it to main design
A.7 and the independent verifier; equality must be checked. Index
`(parent_agent_id, height DESC, agent_id)` gives one tallest-child probe. No closure
table, persisted depth, embedded child multiset or lineage-slot tables.

### 2.1.1 Clean-graph gate for decoded parity (decision32)

The stats answer only while the org has no exception rows; otherwise the decoded
path decides. Exceptions are visible children of a physical tombstone parent and
exceptional decoded-parent encodings, including parent misfits and NULL/empty-name
aliases. The existing decoded children/descendants reader remains the parity oracle.
An org with exceptions, or a document with unsaved parent/state/successor changes,
uses that reader for cap, depth and count decisions. This exceptional path costs
O(S); it is disclosed by `graph.DECISION_STATS` and a warning log line. It does not
normalize history or expand aliases into the physical cache.

`visible_children` counts every non-tombstone physical direct child, maintained
eagerly alongside the other path deltas. A partial index selects stats rows with
height=-1 and visible_children>0. Another partial index selects exceptional parent
encodings. Two ordered LIMIT 1 probes after the body locks require no new lock and
do not scan the org. The independent verifier also checks visible_children. Loaded
mutation checks preserve staged births/deletions/parent/state/successor changes;
successful scalar moves already represented in SQL remain eligible for the stats.

Known limit: a raw writer creating an exception concurrently is not serialized
against this read-only gate. One decision can follow the physical value, while
eager aggregate maintenance and final cycle assertions still protect stored stats
and topology. The clean-path O(h+L) measurements do not establish exceptional-path
performance. Controls must witness fallback/clean selection, exact cap/depth/count
and notice output, staged edits and a removed-gate mutant. Count both exception
kinds on the owned 2026-10-02 live copy under P03 before closing this change.

One migration backfill builds the stats bottom-up from existing parents. Validate
against a recursive reference in the same transaction. A backfill mismatch is a
bug: raise and roll back, with normal Q12 per-org unavailability. It does not
normalize historical topology. A reconcile tool reports aggregate/reference and
cached-parent discrepancies. Missing/corrupt stats never authorize a depth/count
check through a silent S-scan fallback called constant-time.

### 2.2 Eager, non-bypassable maintenance

AFTER STATEMENT triggers on agents INSERT, UPDATE and DELETE use transition tables.
PostgreSQL does not allow UPDATE OF with transition relations: use AFTER UPDATE
and filter OLD/NEW structural/count-relevant columns inside the function. Name-only,
permission/tool/folder-only, grant-only and other irrelevant UPDATEs return without
locking or modifying stats. Test those cases, including G1's in-place rename.

The trigger, including its named helpers, may lock/write ONLY path stats rows,
never agents/items/mailboxes/revision. It is the design5 exception to A6's general
statement-trigger rule; the static allowlist names this function and table exactly.
No general permission for other triggers to acquire upstream rows is introduced.

For a scalar move, transfer the root's cached branch size along old/new paths;
common-path deltas cancel. Each changed parent gets direct-child count deltas and
an indexed height maximum. Propagate height only until unchanged. Process the
whole transition set together, coalescing shared paths rather than one Python or
SQL transaction per bearer. Preserve OLD structural images and cached sizes before
changes; multi-row/nested changes must derive the final bottom-up affected graph,
not double-count a moved branch twice. Affected descendants are never expanded.

Every writer is covered, including raw SQL: hire, archive/rescind/rehire, physical
delete or tombstone, compaction/reseed, rename with structural effects, swaps,
self-subjugation and multi-leg moves. A later statement sees the earlier statement's
completed stats; no deferred maintenance or SET CONSTRAINTS IMMEDIATE. Tests cover
multi-row overlapping branches, leaf/subtree deletion and tombstone transitions,
including FK cascades and availability of OLD sizes. A raw writer that omits the
native pre-lock plan may deadlock and retry; it must not corrupt stats.

Normal native writers pre-lock every required stats path row. Trigger path reads
are refreshed after any wait; stale pre-wait paths cannot guide propagation. A
native plan miss rolls the whole transaction back and widens the plan, never takes
a new earlier-tier row after the structural write. This invariant is traced, not
inferred only from a SQL source scan.

## 3. Move transaction and native seams

1. Narrow planning snapshot selects root, its canonical L bearers, old/new parent
   paths, actor paths, caps and cached height/counts. No all-node prefetch, histories,
   whole audiences section or subtree enumeration in either planning or re-derive.
2. Pre-lock the bound request first, then agents by physical id, then stats by id,
   then existing item/mailbox/other tiers, revision LAST. Root/bearers and all grant
   legs are UPDATE; decided-on ancestor scope/authority paths are SHARE. Acquire
   ALL body locks before the first structural statement, not halfway through it.
3. Re-read parent/lineage/path coverage, grants and effective authority under those
   locks. If the planned identities or coverage changed, rollback and widen/retry
   through pgdoor. Child admission and caps serialize on the same parent/stats rows.
4. Keep Python's USER/SYSTEM/allow_self/downward rules. Refuse a non-live destination,
   bearer-only move, live predecessor, cycle, cap or inconsistent credit release.
   The cycle check walks UP from destination and rejects meeting root OR ANY of its
   moving bearers. The depth refusal remains exactly
   `depth(new_parent) + 1 + height(root) >= max_depth`; it does not newly inspect a
   stranded bearer branch. The child count uses the exact cached predicate above.
5. Compute credit deltas through the LCA with existing numeric quantization and
   top-grant cap. Root's cost is seat+grant only when LIVE, otherwise zero. Old
   release cannot become negative. All free balances and global credits keep their
   pre-move values, including cross-root and composite legs.
6. One/few scalar UPDATE FROM statements write root/bearer parents and grant deltas,
   fenced by physical id and row_version. Require every expected row returned;
   any mismatch rolls back. Preserve configured payload, runtime, text and child
   rows byte-for-byte. Do not call full node_put or its child-table delete/reinsert.
   Eager stats triggers finish before the next structural leg.
7. Keep exact old/new manager and peer/self notices, archived-cost warning, one
   move log and cached subtree-count tail. Replace scope/audience loss enumeration
   with the approved short scope summary. `_quiet` still suppresses per-leg notices
   and log; no-op behavior is unchanged unless an existing check refuses it.
8. Revision/counters/capture settle once at COMMIT. No org_topology lock. Retain a
   final-state cycle assertion AFTER revision over the union of changed roots'
   current ancestor paths. Coalesce shared suffixes, O(U+L) indexed reads rather
   than L repeated query loops; no new row locks or mutation. It is defense for raw/bulk writers, not a
   substitute for the body checks. Rollback publishes nothing; reused connections
   have no transaction-local capture or trigger residue.

The new owned native graph/scope module supplies the common planner/check/scalar
seams. Operator, agent, promote/demote and every internal native `Org._move` leg use
it. Both pre-lock derivation and locked re-derive must use the same narrow protocol.
Native persistence must mark these scalar patches handled so the compatibility save
cannot repeat a full node rewrite or overwrite them. The legacy move remains its
existing implementation. Actual endpoint tests prove dispatch and prohibit a
benchmark-only or fallback full-body path.

Design5 withdraws the never-implemented main-design2.2 deferred org_topology guard.
The landing updates2.2,2.4 and A.7 plus the static/traced lock-order checks. Sorted
shared path locks and authoritative re-derive serialize crossing native moves;
final no-lock cycle assertions at revision see earlier committed revisions. Two
barrier-controlled sessions must measure this, including direct raw writers.

## 4. Configured versus effective scope

Stored scope is configured. Effective scope intersects it with EVERY current
ancestor using the existing folder coverage/rw-ro rules, booleans, MCP wildcard
semantics and ordered visibility/permission levels. USER at the root is unbounded.
Effort/model/account/charter are preferences, not mechanically intersected grants.

Expose `effective_scope(snapshot, agent_id)` and a READ-ONLY effective-agent view.
Mutation/seat-copy/storage codecs read explicit configured values. Scope edits
update the selected configured rows only and invalidate derived reads. Hire/rehire,
actor/granter/parent limits use EFFECTIVE scopes. Missing ancestors refuse rather
than act unlimited. Moves back, scope expansion and wildcard restoration can make
previous configured capabilities effective again: the user authorized that change.

Authoritative engine actions resolve the current chain on their actual org
connection, under chain/path SHARE locks held through the authorized write. Cached
chains can plan, but must be re-derived under locks. Display/read memos are confined
to one consistent UUID/incarnation/revision snapshot. A process cache hit is never
write permission; no invalidation walk over descendants is necessary.

Provider/MCP/warm/new dispatch configuration gets the effective-agent view. A RUNNING
turn finishes with its already-issued filesystem sandbox (user decision4); engine
tool/file/watchdog/approval actions still check the current chain. No descendant
cancellation or claim that a cache stamp revoked an issued sandbox. Existing B5
run identity/epoch fencing stays. Changes to actual tool definitions or prompt
prefix make previous provider-cache compatibility ineligible; an OS warm process
is not proof of a provider cache hit. Retain session/account/model lineage where
it remains compatible rather than switching it gratuitously.

### 4.1 Consumer migration inventory

Add a static/AST inventory that classifies each direct capability read as effective,
configured writer/codec, or unrelated; unclassified reads fail review. Retain the
complete match list in implementation evidence. These base groups must be covered:

| Base consumers | Required behavior |
| --- | --- |
| ledger.py:1923,:7292,:7310,:7408; hire:4590, rehire:5483, set_scope:7695; asks:8182/:8203, watchdog:8731 | Current effective actor/parent/granter authority; native sweep does not visit descendants; writes retain configured values |
| ledger.py:2100, tree_node:11563, tree:11747; foreground_view/context | Effective displayed capability/visibility; configured values separately where needed to edit |
| api.py:2251,:3178,:10160,:10440,:13857,:14950 | Editor/file access, actor ceilings and inherited grant defaults use the authoritative effective view |
| supervisor.py:2330,:4627,:7060/:7088/:7137,:7955,:8846,:12304/:12880,:16912/:17009,:17695/:17814/:18487/:27506 | Launch/MCP/provider sandbox/approval receives effective scope; non-capability preferences remain configured |
| supervisor.py:34114/:34142, ledger.py:8731 | Watchdog command/folder permission checked at each dispatch/use |
| warmpool.py:955, antigravity_session.py:91, subproxy scope transport | Effective new transport configuration and warm eligibility; never relabel an issued old sandbox |
| policy_reads.py:48, scope_diagnostics.py | Include current ancestor capability chain; distinguish configured/effective diagnostics and deny from effective scope |
| identity_context.py, handoff.py, chat/scratch/upload callers | Pass complete effective view, not a selected-node snapshot missing its ancestors |
| store.py, orgdb/mappers/agents.py, orgdb/compat/rows.py | Preserve configured payload; no logical-parent projection or persistence of clamping |

## 5. Accepted audience, warning and migration behavior

Audiences PAUSE instead of being swept away. Keep the stored grant and test current
anchor ancestry on every use; it works again if the chain is restored. Explicit
revoke remains permanent. Preserve delegated anchors, EXTERN and USER exceptions
exactly (`ledger.py:8039`). Lists/capability summaries distinguish availability
without treating a paused grant as usable. No move-time whole-org audience load.

Move warnings give a short summary that scopes follow the new chain. Detailed
per-descendant losses are on-demand diagnostics, outside the move transaction.
Peer/manager notice roles, the count tail and move log remain exact.

Existing already-clamped scope rows are the INITIAL configured values. Deleted
historical grants are not guessed or reconstructed. Restoration applies to future
narrowing; disclose this limitation. All-ancestor mode intersection supersedes the
old D-101 above-parent exception, as the user already authorized. Unknown/misfit
fields, identities, list order, histories and CHECK/FK inventory are preserved.
The migration takes the next free org number AT LANDING; no private reservation.

## 6. Record feed: Python bodies, read-side subtree scopes

Alpha.1 retains today's committed changed notification plus normal refetch. The
new effective reader runs while building a read snapshot, OUTSIDE the move, so
this task does not wait for private B4a's landing. Measure read cost separately.

Design5/6, amended by decision7 for review finding f1, amend the step6 addendum:
every row whose parent_id changes records `subtree:<that agent id>`, and every
configured-scope change records the same scope. A move therefore captures the
root X AND each changed canonical predecessor B: O(L) markers, without naming S
descendant ids at flush. A relevant state change that changes descendants'
effective values also records its affected root. Duplicate root markers in one
revision can coalesce. This applies to every structural writer, not just move.
B4a owns that capture/reader extension. Bodies remain EFFECTIVE values computed
by Python effective_scope; no TypeScript capability fold.

Why X alone is insufficient: after X and its predecessor B move from P to Q,
a retained child C still has parent B. Its current chain is C->B->Q, not C->X->Q.
Different P/Q scope changes C's body; a subscription pinned to C must drop P and
gain Q. `subtree:B` covers both changes, while parent-pile Rule M alone does not.
The same rule covers multiple predecessor branches and unchanged child rows.

Host runner and HTTP catch-up expand subtree scopes in their own consistent read
snapshot. Recompute held records whose current chain contains ANY captured root.
For affected active subscriptions (pinned records and ancestors), send a typed SET REPLACEMENT
with the full current membership at R, including entrant and leaver ancestors.
The active subscription already travels with catch-up; at most128 pinned agents
plus bounded ancestor paths. A replacement above the declared bound is record_reset.
Shared live membership is unchanged; old/new retired piles affected by O(L) bearers
still use flush-time Rule M. No mutation-dependent resolver walks S under revision.

Controls: pinned AND unpinned retained children of moved bearers, multiple
predecessors, and effective-body plus pinned-ancestor parity for C->B->Q; a move
during catch-up, two moves in one cursor window, combined move/scope edits and an
ancestor scope edit followed by moving out; pinned archived/non-archived descendants,
ancestor entrants/leavers, reconnect/delayed baseline/replaced UUID-incarnation,
replacement crossing reconnect, and legacy tree parity at each step. Scope reads, subscription
replacement and bodies share one snapshot/identity. Cache stamps never authorize
engine actions. Coordinate final concrete interfaces with deltas-sol before either
branch makes an incompatible capture/response shape.

## 7. Ownership, verification and implementation sequence

jobs-sol's agreed boundary: O1 owns the new graph/scope module and narrow scalar
CAS updater; G1-G11 owns payload codecs, current-reference/rename logic, its store
rename prepass, compat rows lookup/write/rename, sql node CAS handlers and migration.
Agree exact small common hook call sites before editing shared hunks. conn's commit/
revision seam is B4a's. Whichever lands second verifies combined rename/structural/
revision behavior. Stats maintenance ignores a name-only rename. No jobs.py or
start_turn protocol edit is required.

After drag-opus and review-sol approve THIS design:
1. Implement typed stats/backfill/trigger plus reference verifier; pure scope fold
   and classified consumer views; narrow native planner/scalar CAS and persistence.
2. Base/tip touched lifecycle/move/scope/native reader modules, compare failing NAMES;
   real 2026-10-02 copy rehearsal, including62 bearers and stranded-child witnesses.
3. Under P03 on owned fsync-off cluster, compare ACTUAL old/new move endpoints at
   S=1,100,1000,10000,100000 with fixed h,L,B. Build fixtures outside the timing.
   Report SQL calls/commands/affected rows and lock keys, exact credits/counts,
   configured/effective restoration and rollback, total COMMIT and revision hold.
   Effective reads at depths1/5/20 include cold and same-snapshot timings.
   Explicit baseline timeouts remain timeouts, not estimated samples; no setup or
   import failures/skips count as executed tests. Measure L/U sensitivity separately.
4. Two-session barriers: crossing moves in both orders; hire/hire plus move sharing
   ancestor stats; child cap races; scope shrink versus engine action; raw writer
   versus native move; multi-leg and overlapping batch changes; rename; trigger
   deletes/tombstones; rollback and reused connection. Measure ancestor hot-row waits.
5. Deliberate faults: missing lock/re-derive/CAS, disabled or late stats maintenance,
   wrong height/count/child predicate, unintended name-only stats work, upstream
   trigger/revision lock, omitted bearers, configured/stale scope authorization,
   incorrect rw-ro/wildcard fold, bad credit release/top cap, paused audience allowed
   or deleted, scope-loss enumeration, root-only capture that omits a changed bearer,
   missing subtree or subscription replacement.
   Each mutant fails its intended ACTUAL method. Existing running/new dispatch
   controls prove the accepted sandbox boundary rather than claiming instant revoke.
6. Separate review-sol IMPLEMENTATION approve_stage; current-v3 replay and affected
   gates, source audits/required vector anchors, landing reservation, FF push and
   fresh matching ls-remote, then docket claim. Alpha.1 build belongs to coordinator.

No prototype implementation or new-path performance is claimed by this document.

## 8. Owner measurements at ded21a94 (implementation still in review preparation)

MEASURED on the owned disposable fsync-off PostgreSQL cluster, under the heavy
P03 lock, through the actual native API move handler. Four plain endpoint samples
per case exclude fixture setup, tracing and invariant checks. Fixed depth h=1,
no predecessors L=0 and fixed peer output:

| Subtree rows S | Median move milliseconds | Client SQL calls | Agent / stats lock keys |
| --- | ---: | ---: | ---: |
| 1 | 28.40 | 155 | 3 / 3 |
| 100 | 30.07 | 155 | 3 / 3 |
| 1,000 | 32.08 | 155 | 3 / 3 |
| 10,000 | 34.70 | 155 | 3 / 3 |
| 100,000 | 35.08 | 155 | 3 / 3 |

All eleven size/path/predecessor cases completed. Ordinary descendant headers and
child fingerprints remained equal; independent ancestor statistics and exact free
balances agreed. No full agent-body rewrite ran. Depth5/20 costs41.46/93.63ms;
62 predecessors cost137.51ms aligned and189.99ms with distinct old paths. These
are measured sensitivities, not a claim of independence from depth or lineage.
The path union has65/127 agent and stats keys respectively.

Selected effective reads at depths1/5/20 decode2/6/21 configured rows. A fresh
Python snapshot memo measured3.36-4.89/9.33-14.13/31.64-45.62ms; OS and PostgreSQL
caches were warm. Fifty repeated reads in the same snapshot averaged about0.005ms
and issued zero SQL. This display memo does not authorize writes. At100k, the
observed interval from revision UPDATE start through COMMIT was1.074ms, and from
UPDATE return through COMMIT0.982ms. These bound the held interval; they do not
measure the instant at which PostgreSQL acquired the revision-row lock.

Immutable evidence: artifacts/queue-sol-o1-scale/new-ded21a94a1de-887d945c9c,
compact-grid.json SHA256
689329f6b38a6acd4e13e24a034f84def00d9def250ad7ceff93ba34338f57fb;
full original reports and hashes are O1 evidence48.

MEASURED at ee89434, with unchanged implementation bytes: all48 actual methods
pass (11 concurrency controls and37 aggregate methods), with no skips or cleanup
errors. Barrier-controlled two-session runs cover crossing moves, current-chain
scope checks, child-cap races and hires. A direct raw/raw INSERT pair reaches an
actual ancestor `agent_subtree_stats` tuple lock and transaction-id wait. A native
hire versus the complete compatibility raw writer instead waits on an earlier
agent row; most native/native conflicts wait on early advisory locks. Those
controlled waits establish the lock boundary; their durations are not ordinary
move or hire latency. Immutable five-stage concurrency retention packet:
artifacts/queue-sol-o1-concurrency-retention-ee89434.json, SHA256
13485b300f940b970a00dd30bf70cd98f417edc6648eb6d14d494e1be1050749,
recorded by O1 decision22.

MEASURED actual2026-10-02 copy move of coordinator-opus under
coordinator-astra-2: N=1208, S=1144, canonical predecessor chain L=62.
The instrumented endpoint is110.66ms,176 client SQL calls,64 agent and64 stats
lock keys, with zero full-body rewrites. The outer hot-tool1586.05ms includes
excluded invariant reads and is not endpoint time. All63 root/bearer parents
reach the destination. Header changes are only63 parent pointers/null flags,
64 row-version counters and one grant. All ordinary/retained headers, child rows,
unrelated changed-row payload, independent free balances and before/after stats
references agree. Input copies are unchanged and private resources are cleaned up.
This real copy has zero stranded bearer children; separate synthetic controls
retain that witness. Five original attempt receipts, including the earlier
measurement-helper negatives, are retained in
artifacts/queue-sol-o1-live-retention-ee89434.json, SHA256
71fc06c770e4edcc7e55014996009d35fbd7459202681b01d871f62c4c19cff8,
recorded by O1 decision23. The final SQL control explicitly verifies the omitted
fingerprint keys use `text[]`; an uncast parameter did not remove those keys.

The old/new size comparison is complete below. Final current-G/B4a composition,
source/vector gates and independent implementation fault review remain gates.
These owner measurements do not approve landing or an alpha build.

## 9. Complete old/new comparison and the capacity control

MEASURED actual API move endpoints, with h=1, L=0 and fixed peer output. Each
median uses four plain samples, excluding setup, two warmups, tracing and invariant
reads. The small cases use the same private cluster's original lock capacity64.
The large cases use capacity4096 for BOTH paths; max_connections=40 and
max_prepared_transactions=0 stay equal. fsync, synchronous_commit and full_page_writes
are off only on this owned disposable cluster. OS/PostgreSQL caches are warm;
these are sequential measurements, not latency guarantees under contention.

| Subtree rows S | Old median milliseconds | New median milliseconds | Old / new client SQL calls |
| --- | ---: | ---: | ---: |
| 1 | 47.20 | 28.40 | 181 / 155 |
| 100 | 59.02 | 30.07 | 181 / 155 |
| 1,000 | 237.92 | 32.08 | 182 / 155 |
| 10,000 | 5,521.90 | 36.20 | 182 / 155 |
| 100,000 | 172,736.81 | 32.56 | 207 / 155 |

The old100k instrumented trace takes174,520.93ms separately from its plain median.
Its exclusive stages include104,884.10ms in the ledger move body,26,855.81ms in
planning/re-derive and38,977.05ms in endpoint/door work. It retains a whole-agent
lock declaration and100,009 lock declarations including non-agent entries. Three
full agent rewrites run (root plus two grant rows); unchanged descendants still
cost reads/walks. The new100k trace takes42.89ms, with155 client calls, three
agent and three stats keys, no whole-agent plan and no full rewrites. The observed
revision-UPDATE-start/return through COMMIT bounds are1.288/1.188ms; these do not
observe PostgreSQL's exact lock-acquisition instant. Independent preservation,
free-balance and aggregate-reference checks pass outside every timer. Descendant
scope-clamp behavior differs as already accepted by the user.

The original old10k attempt fails during excluded warmup with SQLSTATE53200,
`out of shared memory`, and the server's max_locks_per_transaction hint. It has
zero timing samples. The second diagnostic confirms that cause at capacity64,
then changes ONLY the owned cluster to4096 and restarts it. A fresh read confirms
4096; the new comparison independently reads the identical settings. Both negative
receipts remain alongside successful old/new receipts. No timeout was converted
to a sample. All completed drivers retain unchanged source/helper hashes and
successful database/temp cleanup; both private postmasters are stopped.

At a107de65, all39 full-schema aggregate methods pass, including actual self-parent
INSERT and cyclic COPY refusal, statement/savepoint rollback, valid same-connection
INSERT/COPY and independent aggregate references. These are owner checks, not the
separate independent implementation/fault approval. Product bytes are unchanged
from ded21a94; the intervening commits add tests and the main-design amendment.

Immutable consolidated packet: artifacts/queue-sol-o1-scale/comparison-retention-a107de65.json,
SHA256071bf3f6fc0c8552477d2d374b8e9597c221961125e2b4a1c76984db49bb29c5.
It pins all four successful drivers, all samples/traces, both negatives, configuration
receipts and the39-method verification receipt. Original full reports remain
unchanged; earlier eleven-case depth/lineage evidence also stays in the packet.

## 10. Clean-graph gate verification (decision32)

MEASURED at212a2ad: the corrected affected comparison retains the original
d9f1d39 base65 passing methods and executes74 passing tip methods:41 aggregate,
8 actual endpoint,11 concurrency,7 child-candidate and7 decision-gate controls.
There are no new failing names, skips, unexecuted methods or cleanup errors.
The alias fixture preserves decoded cap/depth/count and notice-tail decisions;
removing the gate deliberately permits its forbidden move and the control catches
that fault. Clearing the alias uses stats. Staged parent/state/birth/deletion
changes use the decoded view; already-written scalar parent patches stay on the
clean path. Both ordered partial-index probes are observed at5000 rows. Original
fixture/discovery/staged-deletion failures remain in the initial receipt.

MEASURED read-only on all four org databases converted from the2026-10-02 copy:

| Org | Visible agents | Children of tombstone parents | Parent encoding exceptions |
| --- | ---: | ---: | ---: |
| maurdekye-works | 8 | 0 | 0 |
| orgtree | 1,208 | 0 | 0 |
| resonite | 145 | 0 | 0 |
| unity | 6 | 0 | 0 |

Every clean probe is true and every independent stats verifier reports zero
issues. This is a count at one copied snapshot, not a guarantee about future raw
writers. The input dump hash and both source fingerprints remain unchanged;
the disposable databases and folders are removed and the owned postmaster stops.

MEASURED actual API moves after the gate, with h=1/L=0 and fixed peer output:

| Subtree rows S | Median milliseconds (four plain samples) | Client calls | Agent / stats keys |
| --- | ---: | ---: | ---: |
| 1 | 22.81 | 157 | 3 / 3 |
| 100,000 | 29.82 | 157 | 3 / 3 |

Both cases use the same owned capacity4096 configuration, two excluded warmups,
warm caches and no full agent rewrite. The gate adds two client calls to the
previous155-call trace, with no descendant lock or write. Traced revision
UPDATE-start/return through COMMIT bounds are0.485/0.437ms atS=1 and0.838/0.745ms
atS=100k; the exact acquisition instant is not observed. Preservation, credits
and recursive stats references pass outside the timers. These new sequential
measurements do not establish a speedup over the earlier grid. Source/helper
hashes remain unchanged and all owned databases and temporary folders are cleaned.

Immutable receipts:
- artifacts/queue-sol-o1-gate-212a2ad7a9db-corrected-comparison.json,
  SHA25674a97c09fff8bfa4c983ffd73ed3cf50655dab793407f8cecaf3e779b6a9f50f;
- artifacts/queue-sol-o1-live-exceptions-212a2ad7a9db-51038dceac14.json,
  SHA2562c4c0025e57e15a274e6187c9d6c17426da3f2b824430ab2a928223b8aa8fb85;
- artifacts/queue-sol-o1-scale/validate-new-212a2ad7a9db-6a62fa1323/driver.json,
  SHA256c241b4e5425df2ad3d7e5f1b2632deefd683cdffcc4bed5eee3493ddd76d6459.

This correction still requires independent review. The original implementation's
d9f1d39 approval does not approve the new gate or a v3 push.
