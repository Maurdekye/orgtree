# Agent descendant ordering and explicit hire placement

2026-10-11. User request mb137ddaf7c1d and explicit-value correction
m848012229292, relayed by lead-astra. The correction replaces the initial
optional-index assumption: **new agent hires require `index` explicitly**.

`orgtree_reorder {node, index}` places a live strict descendant among its
existing live siblings. It cannot reorder the caller, a superior, peer or
unrelated subtree, and cannot change a parent, credit, account or scope.
The tool belongs to the `team` group, including inherited denial.

Indices are nonnegative integers, zero based, in `sibling_order, id` order.
Archived/unrecoverable/deleted seats consume no live slot. Reorder removes
the target before inserting at `0..remaining_count`; zero is first, the last
allowed index is last. `orgtree_hire` and the new-hire form of `orgtree_staff`
require `index`, accepting `0..existing_live_child_count`. The existing
superior-insertion rules remain: its target becomes the new seat's child,
so its former sibling set excludes that target before indexing the new
superior under the old parent. Existing authority, inherited capabilities
and credit checks all still apply. Above a top-level target other than the
calling agent remains user-only. Root self-parent hiring is allowed by the
parent-hire ruling: its seat and requested free grant must come from the
caller's own available credits, its effective capabilities cannot widen,
and its explicit index selects the final root sibling position excluding
the caller. See [parent-hire accounting and authority](parent-hire.md).

The ordering proof now checks both root self-insertion at the requested index
and atomic refusal above an unrelated root. This supersedes its former blanket
root-superior refusal expectation; historical 63-check results below predate
that feature, and the updated proof has 64 checks.

`orgtree_state_inspect` exposes `sibling_index` (null for archived rows),
`live_sibling_count`, `live_child_count` and the stored `sibling_order`.
These counts and ranks use the complete structural snapshot before name
and visibility filtering. Hire/reorder results report the selected `index`,
`live_sibling_count` and `sibling_order`; hires also report the parent.

Malformed, missing agent-hire/reorder or out-of-range indices are refused;
index/before/after conflicts and parent-changing reorder arguments are refused.
Rehire is restoration, retains its existing placement rules and does not
acquire an index requirement; passing the new index there is refused rather
than ignored. Existing required charter/grant and subordinate folders/tool
switches/visibility remain explicit. Superior capability inheritance remains
its established exception. Non-agent/internal hires may still omit placement,
using the historical append calculation. Existing user before/after reorder
requests retain their midpoint behavior.
Nullable legacy `before`/`after` fields still mean omission; an explicit null
`index` is malformed and refused.

Hire (including staff's hire), reorder and the existing sibling membership/order
writers (rehire, moves, swaps, self-subjugation, retirement, dissolution and
deletion) use serializable operation transactions and the existing bounded
deadlock/serialization retry. Live
siblings are fetched/locked in pages of 256. This protects concurrent empty,
root, and ordinary sibling-set mutations without a global ordering lock.
Placement and hire/docket/credit effects commit together, with no separate
post-hire reorder. Midpoint ordering normally updates only the placed seat;
equal or exhausted floating-point gaps normalize that live sibling set in
the same transaction, preserving its order and publishing every changed row.

Promote and Demote are existing Move aliases. Dispatch and isolation policy
share one `canonical_op` helper, so both aliases participate in Move's
serializable transaction without changing request/retry labels or existing
move authorization and audit meaning. Initial independent review reproduced
nonserial results for both aliases while Move retried correctly. The controlled
`ordering-alias-race.mjs` proof pauses each operation after its destination
order read, executes an agent reorder, then verifies conflict/retry and final
order. Correction `1a05fe6` passes all seven controlled checks on a newly
compiled binary; both aliases now log a first-attempt conflict and retry.

The agent tool definitions and identity instructions change the cached prompt
prefix once when adopted. This feature does not change account routing or
the restricted parent-hire backlog work.

## Verification

Focused proofs: `tools/rig/proofs/agent-ordering.mjs`,
`ordering-alias-race.mjs`, plus the existing
`hire-scope.mjs` updated to state the new required index. The proof exercises
descendant authority, malformed/omitted/conflicting inputs, first/middle/last
and empty/root positions, archived siblings, superior insertion, atomic staff
refusal/commit, tied/exhausted midpoint gaps, concurrent hires/reorders and
tool-group denial against a disposable database and fake CLI.

Measured 2026-10-12 on engine source `1a05fe6`, based on `rust-engine`
`4fa41d4`, using the owner's isolated C target and the shared build queue:

- `cargo check --offline -j 2 -p orgtree-engine`: exit 0, 22.76 seconds.
- `cargo build --offline -j 2 -p orgtree-engine`: exit 0, 50.40 seconds.
- `ordering-alias-race.mjs`: **7/7 checks passed**. A scratch trigger pauses
  each of Demote, Promote and Move after its destination max-order read;
  an actual descendant reorder runs before release. Each operation detects
  a conflict, retries with its original request label and commits `b,a,x`
  with orders `2,3,4`. The fixture verifies the arriving seat has the older
  ID, so the predecessor's equal-order result cannot accidentally pass.
- `agent-ordering.mjs`: **63/63 checks passed**, including the MCP-served
  hire/reorder required index and conditional staff schema, discovery under
  tool-group denial, direct/deep authority, all placement boundaries, atomic
  refusals, legacy nullable inputs, rehire compatibility and midpoint recovery.
- `hire-scope.mjs`: **12/12 checks passed** on the same final binary.
- Concurrent hires, reorders, deep moves and root moves each logged an actual
  first-attempt write conflict and successful retry; their final ranks/counts
  passed. These are small two-request cases, not a throughput qualification.
- JavaScript syntax and `git diff --check` pass. No TypeScript changed;
  desktop typecheck, app builds and real provider launches were not run.
- All three runners completed teardown. A subsequent scoped process/run inventory
  found no remaining own rig runs or processes. Own C artifacts total
  3,124,806,425 bytes, below the 100 GB owned-build cap.

Final debug engine SHA-256:
`71EA83FDE4B8FE9A8D88B4A5767B201BB66A166C70D641984E93EDEA6F216A95`.
The evidence records the freshly built local source and hash, not a release
commit stamp. Secret-free proof records remain in the owner's rig evidence:
`ordering-alias-race-20261012T003920/result.json` and `engine-excerpt.log`,
`agent-ordering-20261012T003939/result.json`, its `ordering-schemas.json` and
`engine-excerpt.log`, and `hire-scope-20261012T004010/result.json`.

The unchanged alias proof first ran against the predecessor binary
(`7BE750EEC267F124A3F0BDE62067DABDF28544C0E0E8C7A574B8E7CFD7FEE9B9`):
**3/7 checks passed**. Both aliases failed final order and retry assertions;
the fixture and identical Move control passed. Receipt:
`ordering-alias-race-20261012T003218/result.json`. The same four failures
turn green on the corrected binary. This independently repeats the reviewer's
controlled red cases; it does not imply approval or integration.

The earlier ordering run had 58/60 passes: only legacy null `before`/`after`
failed. Fix `9542958` changed those same two checks to pass while null `index`
still refuses. That red-to-green evidence remains in
`agent-ordering-20261012T000247/result.json`. The initial clean rebase from
`0e2b2c5` to `4fa41d4` had two equal range-diff entries.

Limits: no live hierarchy change, real provider schema acceptance or installed
app verification; no >256-sibling paging or 1,000-agent scale measurement;
contention on swap/self-subjugation was not separately exercised. Existing
superior authority/capability/credit logic remains shared and its focused
insertion/refusal cases passed. Coordinator review/integration is separate
from this source and isolated verification.
