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
and credit checks all still apply. Above a top-level target remains user-only.

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

The agent tool definitions and identity instructions change the cached prompt
prefix once when adopted. This feature does not change account routing or
the restricted parent-hire backlog work.

## Verification

Focused proof: `tools/rig/proofs/agent-ordering.mjs`, plus the existing
`hire-scope.mjs` updated to state the new required index. The proof exercises
descendant authority, malformed/omitted/conflicting inputs, first/middle/last
and empty/root positions, archived siblings, superior insertion, atomic staff
refusal/commit, tied/exhausted midpoint gaps, concurrent hires/reorders and
tool-group denial against a disposable database and fake CLI.

Execution and exact evidence will be recorded after the shared build slot is
available. Source implementation alone is not measured runtime proof.

Measured pre-proof check on source `559c862`: `cargo check --offline -j 2
-p orgtree-engine` exits 0 in 4m17s using the owner's isolated C target.
The clean rebase from `0e2b2c5` to `4fa41d4` has two `=` range-diff entries.
The subsequent explicit-user-destination and topology-writer isolation
refinements still require compilation and runtime proof.
