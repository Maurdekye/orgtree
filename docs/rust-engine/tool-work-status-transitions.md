# Docket status changes on tool-call rows

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

## Prepared verification and measured limits

Source/diff checks and JavaScript syntax checks passed. The following checks
are prepared for rig-opus's queued batch and **have not run yet**:

- Three new `runtime::convo::tool_refs_tests` cases (nine total) cover real
  changed results, serialization, no-op/unobserved/malformed/refused data,
  input poisoning, reads and other tools.
- Six mounted `workstatus.test.tsx` cases cover docket wording/colour classes,
  legacy/no-op/unknown/failed rows, writing/running input, ticket identity and
  navigation/fold preservation, and shared message serialize/reload.
- The renderer red control substitutes only the prior `830f0e2` ToolRefs
  implementation with the new tests. Expected: three transition cases fail,
  three omission controls pass. Green must pass all six.
- `tools/rig/proofs/work-status-transition.mjs` prepares 33 checks of actual
  synthetic MCP results, SQL-stored chips and fresh chat capture: seven
  transitions (including implicit/explicit reopen, drop, accept, supersede),
  eight non-status/refused controls, final archive semantics, and concurrent
  updates whose returned before/after pairs must form the serialized chain.
  It retains `persisted-and-reloaded.json` and fake CLI logs.
- Root typecheck and existing tool-writing/menu/shell renderer suites remain
  part of the batch regression gate.

No native/renderer/proof/visual pass, installed-app behaviour, real-provider
behaviour, device check, build, install or integration is claimed here.
Update this section with exact-source receipts after the batch returns.
