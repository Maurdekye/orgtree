# Parent-only native moves for 3.2.0-alpha.1

Proposal 1, 2026-10-04. Design review required from drag-opus and review-sol before
implementation. Base: v3 `4afac9a2bd38702d0c806c9b8b8769da4ede2679`.
This is the real native move path, not a benchmark-only shortcut. Legacy storage
keeps its existing path. Umbrella decisions 40/41 authorize the filesystem model
and restoration of configured scopes when the current chain allows them again.
The alpha.1 landing is pre-granted after implementation approve_stage; no build or
restart is part of this item.

## 1. Target and evidence

Moving a subtree must not enumerate, lock, update or capture every descendant.
Change the moved agent's parent and the small old/new ancestor paths. The target
is independent of descendant count S, with O(h) path work and indexed aggregate
lookups. It is not independent of path depth h, notification recipients B, or
records the client actually displays. Index probes also have logarithmic index
cost. Do not call a COMMIT O(1) while hiding an O(S) deferred trigger inside it.

The prerequisite speed audit is commit `0799f5f` on queue-sol-speed, audit artifacts
r4/r5. MEASURED: the actual A8 native move of coordinator-opus under
coordinator-astra-2, on an owned disposable live copy, has N=1208, S=1144 and
62 predecessor bearers. Of 787.024 ms exclusive profiled time, bearer rewrites use
321.737 ms; the root rewrite uses 6.318 ms; subtree-walking stages use 145.215 ms.
No ordinary descendant body is rewritten in that case. Nevertheless the current
plan locks all 1208 agents. The native adapter's apparent batch update loops over
64 changed agents and rebuilds their child rows. The design must remove both the
subtree walk and the bearer rewrite; optimizing the root UPDATE alone misses them.

## 2. Stored and derived state

PG remains authoritative, one database per org, typed columns and FK links on
the many side. No closure table, nested descendant list or persisted depth/path.
Configured scope stays in the existing scope columns and owned folder/tool rows.
Move does not change it. Effective scope and ancestors are projections.

| State | Representation and cost | Writes on a move |
| --- | --- | --- |
| Root placement | Existing root `agents.parent_id` FK; row_version raised by the scalar patch | One root header |
| Ordinary descendant placement/depth | Existing direct parent edges; one upward CTE O(h) per selected read, or a memo within that snapshot | None |
| Bearer placement | Stable lineage slot and current holder, described below; bearer parent is derived from the holder's parent | None on bearer agents |
| Effective folders/tools/visibility/mode | Fold configured scopes on the current ancestor path; O(h times scope payload), fixed child-table batches | None |
| Root subtree height/count | Maintained own-branch aggregates, including archived nodes as today's depth/count methods do | Unchanged for the moved root; O(h) ancestors change |
| Whole lineage forest totals | Maintained slot aggregate over root plus canonical predecessor branches | O(h) affected parent branches; no scan over L bearers |
| Child height maximum | Indexed per-child-slot branch height, not an embedded multiset | Root branch changes parent; O(h) updated maxima |
| Grants/free | Existing credit_grant; exact seat+grant delta on LCA paths | O(h), batched scalar headers |
| Parent/global/retired counters | Existing foreground counters plus exact slot-summary deltas | O(h) or two direct-parent deltas, global total unchanged |
| Audiences | Anchor ancestry checked at use; permanent revocation question in section 7 | Depends on ruling; no whole-org sweep |
| Notices and move log | Exact existing roles and one typed move event; subtree tail reads aggregate | O(B) output, batched; no S walk |
| Records/display scopes | Root/ancestor changes plus a compressed derived-view invalidation | No S per-agent capture at COMMIT; section 6 needs B4 agreement |

### 2.1 Lineage is placement indirection, not copied parents

Today's move rewrites each member of `Org.lineage_stack` (`ledger.py:1833`, :7226),
including archived bearers with stranded children. Leaving their parent columns
authoritative would split their placement and can create cycles. Introduce a
stable `agent_lineage_slots(id, holder_agent_id FK)` and an FK `agents.lineage_slot_id`.
Every ordinary agent has a one-member slot. Only the canonical predecessor chain
shares its holder's slot. A compaction/reseed switches the slot holder, not every
older bearer's placement. The slot persists across generations.

`agent_tree_edges` is the typed logical-parent projection: the holder uses its
stored parent_id; other members use the holder's parent_id. Ordinary children
retain their own direct parent IDs, including children attached to a bearer.
Stored bearer parent_id is historical compatibility data, not a second authority.
Legacy-shaped exports/read models project the logical parent. Names, born/generation,
predecessor/successor links, archived state, children and sort keys retain their
existing meanings. Do not merge every row with the same successor_id: the measured
copy has more than one such predecessor candidate; the canonical predecessor walk
is the contract. Backfill checks chains for overlap/cycles instead of guessing.

The upward cycle test rejects a destination whose ancestor chain reaches ANY
member of the moved slot. This covers a child stranded below an old bearer without
enumerating that bearer's descendants. Raw-parent indexes cannot answer logical
bearer placement: native children, counts, authorization, archive piles, exports,
and record bodies must use this projection. Measure the actual join plans.

### 2.2 Exact height/count maintenance

Use typed maintained tables, with FK keys:

- `agent_subtree_stats(agent_id, descendants, height, live_children, ...)`: own
  logical branch; leaf height=0. The root's existing notice tail and depth cap use
  its own descendants/height, rather than silently substituting a different count.
- `agent_slot_stats(slot_id, members, forest_nodes, forest_height, retired_members, ...)`:
  combined placement branches, including bearer-owned children. This transfers one
  summarized forest between parents without L updates.
- `agent_child_branches(parent_agent_id, child_slot_id, nodes, height, ...)`:
  one branch per child placement slot. Index `(parent_agent_id, height DESC, child_slot_id)`.
  Removing the tallest branch uses an indexed maximum, not a sibling scan.

These are maintained caches of the logical graph, not another topology authority.
One-time backfill is O(N); move touches O(h) stats. Height changes propagate upward
until unchanged. Counts propagate to the LCA; common-path deltas cancel. If a parent
is itself a bearer, recompute its own branch and its slot summary before continuing
upward. Slot maxima use a membership/height index; maintain sums by deltas. No MAX
over all descendants or SELECT SUM over all slot members at move time.

Every structural writer must maintain them: hire, parent changes, archive/rescind,
rehire, delete, compaction/reseed/lineage-holder replacement, swap, self-subjugate
and composite moves. State transitions update only state-dependent counts. The
shared native persistence hook must see old and final structural headers; it cannot
be an optional call only on the new move endpoint. A pure scope/title/cost edit does
not rebuild these stats. Reconcile/backfill verifies against a recursive reference.
Corrupt/missing aggregates refuse structural authorization; do not scan S silently
and label the fallback constant-time.

**Review boundary:** aggregate maintenance must also work across several structural
steps in one transaction. Later checks see the transaction's own earlier deltas.
Do not force deferred checks IMMEDIATE to obtain fresh aggregates. Prefer explicit
eager maintenance during the normal write phase with prelocked aggregate/path rows;
the commit guard validates the final graph/caches, rather than repairing them while
holding the revision row. New structural raw-SQL writers must enter this protocol.
The design owner must settle its database bypass guard before approval (section 8).

## 3. Move transaction

1. Narrow typed planning snapshot: find root, slot identity, old parent, destination,
   their parent paths, actor path, caps, root height and slot totals. Do not load all
   nodes, their histories, or whole audience/scopes sections.
2. Build a physical-id-sorted row lock plan. A bound request is first; agents next;
   items/mailboxes retain existing tiers; aggregate rows follow; revision is last.
   Root, old/new credit paths and destination get UPDATE; decided-on ancestors get
   SHARE. Aggregate keys are sorted. No descendant locks, no provider/app wait inside
   the org transaction. Parent FK references and slot-holder rows are included.
3. Re-read paths/versions under these locks. If parents/slot/path coverage changed,
   roll back and re-plan through pgdoor's existing widening/retry contract. Never
   discover a lower-id lock and acquire it after a higher tier. Concurrent child
   creation holds the same parent row/aggregate rows, so child caps cannot race.
4. Run the existing Python authority distinctions (USER/SYSTEM, allow_self,
   downward-only). Reject non-live destination, bearer-only move, live predecessor,
   cycle, depth and child cap, inconsistent credit release and top grant cap.
   Depth remains `new_parent.depth + 1 + root.height >= max_depth` refusal. Keeping
   this exact root-branch rule must be distinguished from fixing old bearer-branch
   depth anomalies; the latter is not an implicit permission to change behavior.
5. Derive credit deltas through the LCA. Use exact numeric quantization; all affected
   free balances and global credits retain their pre-move values. Persist scalar
   parent/grant patches with CAS/version checks in one/few UPDATE FROM statements.
   Do not call full node_put or delete/reinsert text, runtime or scope children.
6. Move one slot branch between parents and propagate count/height changes through
   prelocked paths. No descendant or bearer rows change. Notices use current exact
   sibling roles/counts; audience handling follows section 7. A no-op retains today's
   operation behavior rather than inventing a special acknowledgement.
7. Write one move log and derived-view invalidation, bump revision once, maintain
   foreground flag counters once per transaction, then COMMIT. Rollback loses all
   patches, cache publication, notices and invalidations. No SET CONSTRAINTS IMMEDIATE.
8. Publish cache/host notifications after commit. Re-read/use functions derive the
   new chain. No providers are launched by a move.

The same native path must serve operator and agent move/promote/demote and internal
`Org._move` legs of composite verbs. The pure legacy ledger remains the behavioral
reference except for the explicit scope change. Sparse header persistence is a
narrow P1 slice; coordinate compat/mapper overlaps with jobs-sol and drag-opus.

## 4. Configured versus effective scope

Stored scope is the agent's configured request. Effective capabilities are its own
intersection with every current ancestor's effective capabilities. Use existing
folder-tree coverage/rw-ro rules, boolean tools, MCP `*` set semantics, and ordered
visibility/permission levels. Top-level USER authority is unbounded as today;
org policy/default handling stays explicit. Effort/model/account/charter and other
non-capability settings are not mechanically intersected.

Expose `effective_scope(snapshot, agent_id)` and a read-only effective-agent view.
Writers use explicit configured scope; a projection cannot be saved as a document.
Scope edits update the chosen agent's configured rows and invalidate effective
views; they do not destructively clamp descendants. Hire validates against the
granter/parent's EFFECTIVE holdings. Rehire uses existing configured values and the
current chain. Moves back, parent scope expansions and wildcard restoration can
make configured capabilities effective again: this is the accepted paradigm.

Authorization never trusts a process cache because it once had the right scope.
Each action gets a current authoritative chain in the actual org transaction and
holds the relevant ancestor scope/path SHARE locks while authorizing and writing.
The pre-lock cached chain can plan, but must be re-derived under locks. Read-only
views memoize only within a single consistent snapshot, keyed by UUID/incarnation/
revision/agent; a host cache hit is not write authorization. A topology or scope
revision makes earlier memo entries ineligible without visiting descendants.

Provider/MCP launch and warm transport selection receive the effective-agent view,
never configured capability rows. Existing B5 request/epoch fencing still applies.
An already running provider holds a previously issued sandbox configuration; the
new function cannot pretend to rotate its OS/filesystem permissions in RAM.
Section 7 asks for an explicit in-flight enforcement boundary. Engine tool actions,
file delivery, watchdog commands and approval callbacks must recheck current scope.

### 4.1 Reader migration inventory

This is a capability inventory, not every unrelated field named `scope` in docket
artifacts or transcript records. Implementation adds an AST/static inventory test
so unclassified direct capability reads fail review; the exhaustive matches are
retained as an implementation evidence file with reader/writer/non-capability labels.

| Consumers on the base | Required change |
| --- | --- |
| `ledger.py:1923`, :7292, :7310, :7408; hire :4590, rehire :5483, set_scope :7695; asks :8182/:8203, watchdog :8731 | Parent/granter/actor limits use effective scopes. Mutation/seat-copy helpers explicitly use configured scopes. Native sweep stops touching descendants. |
| `ledger.py:2100`, tree_node :11563, tree :11747; `foreground_view.py` / `foreground_context.py` reuse these methods | UI/chart/visibility uses effective scope; projection exposes configured scope separately only where needed to edit it. |
| `api.py:2251`, :3178, :10160, :10440, :13857, :14950 | Editor/file access, orgtree actor ceilings, hire-above inheritance and operator defaults use current effective capabilities. |
| `supervisor.py:2330`, :4627, :7060/:7088/:7137, :7955, :8846, :12304/:12880, :16912/:17009, :17695/:17814/:18487/:27506 | Launch/MCP/Claude/Codex/Antigravity folders, tools, permissions, sandbox and approval checks use the effective-agent view. Non-capability preference reads remain configured. |
| `supervisor.py:34114/:34142`, `ledger.py:8731` | Command/stream watchdog and folder authorization recheck effective holdings at each dispatch/use. |
| `warmpool.py:955`, `antigravity_session.py:91`, subproxy's granted transport scope | Warm eligibility and transport configuration use effective scopes; old transport scope is never relabeled as newly authorized. |
| `policy_reads.py:48`, `scope_diagnostics.py` | Narrow policy snapshots include the ancestor capability chain; diagnostics report configured and effective values distinctly and deny from effective values. |
| `identity_context.py`, `handoff.py`, chat/scratch/upload context callers | Identity/transfer read paths pass the effective-agent view rather than letting an incomplete selected-node snapshot treat missing ancestors as unlimited. |
| `store.py`, `orgdb/mappers/agents.py`, `orgdb/compat/rows.py` | Codec/export/storage keeps configured values; logical parent projection is explicit. Never persist read-time clamping. |

## 5. Migration and real-data behavior

Use the next free org migration at landing, not a privately reserved number.
Backfill slots, logical graph stats and child-branch indexes once, in an owned
conversion/migration transaction. Check topology/lineage and aggregate counts
before publishing the org as active. Preserve all stored unknown/misfit fields,
normalized list order, birth identities, histories and existing CHECK/FK inventory.

Existing stored, already-clamped scopes become the INITIAL configured scopes.
Old deleted grants cannot be reconstructed safely from missing information; do not
invent wider grants or scrape history to restore them. Future narrowing/restoration
uses the new rule. State this limitation in release behavior, and get the coordinator's
confirmation (section 7). New intersection includes permission mode: the old D-101
exception for a user mode above an ancestor cannot be silently retained as a bypass
of the newly stated all-ancestor intersection; flag that interaction explicitly.

## 6. Record feed: keep move COMMIT independent of S

B4a is still private; coordinate before implementing an incompatible capture shape.
The approved step-6 addendum74bc2c7 currently resolves scope-derived membership/body
changes at the revision flush. A resolver that lists S changed agent IDs there
would defeat this task, even if no descendant agent row is written.

Proposed extension: one typed topology/scope invalidation names the moved stable
slot/root, old/new parents and revision; root/ancestor scalar records are captured
normally. Record bodies carry configured capability facts needed for the projection.
The client derives effective capabilities and logical placement for its HELD nodes
from parent/slot facts, and re-projects them after the invalidation. This costs
O(visible affected records) in the client, not inside the move's transaction.
Membership/window refresh work is bounded by subscriptions/output and performed
in the feed's one-snapshot read phase, with the existing latest-revision/reset rules.
No stale cached record can authorize an engine action.

This is a protocol amendment requiring drag-opus/B4a agreement, not permission to
break the existing no-refetch/parity contract. Selected archived records must have
enough ancestor/slot facts; unseen entrants/leavers cannot be ignored. Reconnect,
delayed baselines, replaced UUID/incarnation, moves during capture and missing
ancestors require actual controls. If compressed invalidation cannot satisfy that
contract, state the conflict before claiming flat-S move timings.

## 7. Product decisions still needed

Only scope restoration is pre-approved. Recommended choices below are proposals,
not implementation defaults; coordinator-opus asks the user.

1. **Audiences:** current move permanently deletes non-ancestral grants. A current-chain
   predicate would suppress them while invalid and revive them if moved back. Recommend
   that filesystem behavior for agent/delegated grants, retaining USER exemptions and
   explicit revoke as permanent. If permanence must remain, design a durable historical
   revocation barrier first; a lazy filter alone is incorrect.
2. **Move warnings:** today the response can enumerate every lost descendant folder/tool.
   Exact enumeration is O(S) and conflicts with no descendant walk. Recommend a stable
   summary that effective scope follows the new chain; detailed scope diagnostics remain
   on demand. Exact peer/manager notices, count tail and move log stay unchanged.
3. **Existing scopes:** recommend current stored values as the initial configured scope,
   with no retroactive resurrection. Future intersection/restoration is accepted; this
   limitation and the D-101 interaction must be visible to the coordinator/user.
4. **In-flight provider permissions:** recommend current-scope checks for every engine
   action and effective scopes on new provider dispatches, plus explicit treatment of
   a provider already holding an older filesystem sandbox. If immediate provider
   revocation is required, a durable move/scope barrier and self-fencing dispatch loop
   must be specified; enumerating/killing descendants during the move is incompatible
   with the requested bound. Do not claim the old sandbox was revoked by a cache stamp.

No credit, depth cap, displayed counts, retained identity/history, or notification
role change is proposed. Lineage placement and record invalidation change their
representation and must preserve their observable results. Any unavoidable deviation
found in the controls returns here for an explicit user ruling.

## 8. Design-owner boundaries before approval

- Approve the stable-slot logical-parent projection and maintained aggregate tables;
  define raw-writer enforcement. Main design section2.2 describes a deferred topology
  guard taking org_topology; section2.4/A6 forbids deferred upstream locks. On this base
  the table exists but no org migration function uses it. Resolve this conflict, rather
  than adding a late topology lock under the revision lock. Candidate: a final-state
  recursive cycle check AFTER taking revision, with no new agent locks, while all
  normal structural writers lock and maintain paths during their body. Aggregate
  correctness still needs enforceable raw-writer entry, not a caller-set trusted flag.
- Settle scalar-persistence/aggregate hooks with jobs-sol's G1-G11 compat/mapper work.
- Agree compressed derived invalidation and minimum ancestor facts with deltas-sol;
  measure commit hold time separately from feed/projection work.
- Rule on the old root-only depth cap versus stranded bearer branches without silently
  making the cap stricter; proposal preserves the existing root rule.

## 9. Implementation and measurements after design approval

1. Typed graph/slot/aggregate schema and verified backfill; pure effective-scope fold
   and narrow native readers. Contract/inventory tests first.
2. Common structural maintenance and sparse parent/grant CAS; root/path-only native
   plan/body on the actual operator/agent/composite seams. No full node_put fallback
   under a constant-time claim. Integrate all capability consumers and record protocol.
3. Base/tip touched lifecycle/move/scope/native reader modules, compare failing NAMES;
   real 2026-10-02 live-copy rehearsal including 62 bearers/stranded-child witnesses.
4. Under P03/private fsync-off: today's actual move and new actual move at S=1,100,
   1000,10000,100000, fixed h and B. Build synthetic trees separately from timing.
   Report successful endpoints, SQL calls/rows/changed IDs, height/count equality,
   exact credit balances, scope restoration, lock sets, revision hold time and total
   COMMIT. Timed methods must execute, not skip; setup/import errors are not samples.
   Baseline is time-bounded; an explicit timeout stays a timeout, never an estimated
   timing. Effective-scope cold and same-snapshot reads at depths1/5/20 are measured.
5. Fault review: remove ancestor coverage/re-derive, corrupt height/count, skip an
   aggregate writer, remove version CAS, omit bearer placement, use configured scope
   for authorization, accept a stale cache, invert folder rw/ro or wildcard logic,
   skip credit release/cap, remove audience gate, omit capture or apply stale frame.
   Each mutant must fail an intended actual method. Two-session crossing moves,
   competing hires/caps, scope shrink versus a tool call, multi-leg transactions,
   explicit constraint flush, rollback/reused connection and replacement are barriers.
6. review-sol implementation approve_stage, current-v3 replay and affected gates,
   source audits/required vector anchors, reservation/fast-forward push/fresh ls-remote
   and docket claim. Alpha.1 is built by the coordinator only after this real path lands.

No prototype code or new measurement is claimed by this design document.
