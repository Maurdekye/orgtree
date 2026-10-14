# Docket status changes on tool-call rows

Live Claude path checked 2026-10-14 17:47UTC: the user's screenshot of the
coordinator's actual changed presentation-ticket update shows `Open → In progress`
beside the ticket ref with docket colours. A preceding example on the running-icon
item was a no-op (already in progress), so omitted previous_status/transition
was correct. Coordinator ended the investigation with no source fix or live
write. Earlier unseen calls predating install or being no-ops is an inference,
not a measured audit of all stored rows.

User 2026-10-14 12:44:47UTC requested an inline, colour-coded `old → new`
status on an `orgtree_work` call that changes a ticket. Docket:
`transcript-show-a-ticket-s-status-change-inline-o`. The user did not require
inclusion in the next alpha.

## Source and display contract

The successful mutation result carries `previous_status` only when status
actually changed. `update_tx` captures it from the existing `FOR UPDATE` row,
alongside the final `status`. This covers update, accept (which calls
`update_tx`), dropped status, and reopen including its implicit `in_progress`
default. Supersede captures the same pair from its locked row. Both results
reach callers only after transaction commit. No extra read, global lock, schema
change or longer transaction is added. Archive preserves status and adds no
transition; create has no previous state; ordinary assign, move, evidence,
participants, handoff, delete and reads add none.

`runtime::convo::tool_refs` projects the pair into the affected ticket's
`status_change: { from, to }`. It accepts known, distinct docket statuses from
a successful mutation result with its actual returned ticket identity, never
from input or a later lookup. Existing Claude, Codex, Antigravity, ACP, Muse and
history result paths already use this shared function on the uncut result.
The small reference metadata persists with the row, independent of output
clipping, and remains on a fresh chat/feed projection.

The shared `ToolRefs` row draws the transition beside the existing ticket
reference. Each label uses the same `statusLabel` function as the docket and
the existing `.docket-status.status-*` colour classes. Existing wording is
preserved, including `Agent review` and `Approved — not landed`. The arrow
has no separate palette. The ticket retains its link/context-menu identity.
Clicking inside the reference/transition does not toggle the tool fold.
Failed calls suppress references through the existing error gate. Unknown,
identical or missing states show no transition. Legacy transcripts without a
recorded previous status show **nothing extra**, keeping their old ticket
presentation. No guessed single new-state label is added.

## Round 435 measured verification and limits

Source/diff and syntax checks passed. Rig-opus's source-exact batch
`f2707c6` on `c8f4577` passed the focused gates; actual logs and durable
result were inspected after delivery:

- Three new `runtime::convo::tool_refs_tests` cases (nine total, all passed) cover real
  changed results, serialization, no-op/unobserved/malformed/refused data,
  input poisoning, reads and other tools.
- Six mounted `workstatus.test.tsx` cases passed 6/6 and cover docket wording/colour classes,
  legacy/no-op/unknown/failed rows, writing/running input, ticket identity and
  navigation/fold preservation, and shared message serialize/reload.
- The renderer red control substitutes only the prior `830f0e2` ToolRefs
  implementation with the new tests. Actual: three transition cases failed,
  three omission controls passed, exactly as predicted.
- `tools/rig/proofs/work-status-transition.mjs` passed 33/33 checks of actual
  synthetic MCP results, SQL-stored chips and fresh chat capture: seven
  transitions (including implicit/explicit reopen, drop, accept, supersede),
  eight non-status/refused controls, final archive semantics, and concurrent
  updates whose returned before/after pairs must form the serialized chain.
  It retains `persisted-and-reloaded.json` and fake CLI logs. The base-engine
  red passed 11 controls and failed the 22 target checks, exactly as predicted.
- Root typecheck exited 0; writing/menu/shell regressions passed 16/16.

Logs: `D:/orgtree-work/tmp/rig-opus/batch-435/logs/{b-test-union-f27,
s1-green,s1-red,s1-typecheck,s1-tool-regression,proof-f27-work-status-transition,
proof-red-work-status-transition}.log`. Durable proof:
`D:/orgtree-work/rig/rig-opus/evidence/work-status-transition-20261014T152326`.
Final union500/502 retains the two base-identical contextmenu B4/B4b failures;
they are not counted as passing. Coordinator marked the item done and integrated
batch f2707c6 into local rust-engine6a299ee, subsequently included in alpha.3
source ae0b5fd. No fresh visual, installed-app, real-provider or device
verification is inferred from that integration or restart.
