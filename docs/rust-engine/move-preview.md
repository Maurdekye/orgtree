# Immediate sibling move preview

User 2026-10-11 reported that moved agents no longer animate to their new
location until the update finishes. The measured defect is the sibling-reorder
drag path; the user's exact gesture remains unknown. Coordinator authorized
this bounded fix without treating the reproduction as proof of that identity.

## Diagnosis

At rust-engine d0789c9, all 20 existing pendingmove tests passed, including
delayed reparenting in row and circular layouts, shared list order, success,
refusal, stale reads and Undo. History b62603b/e3d0898 provided the reparent
overlay and its identity guards; d8017ae corrected its ordering. None supplied
an overlay to the sibling-reorder endpoint.

A new mounted OrgCanvas test dragged x past its last sibling and held the real
fetch route `/nodes/x/reorder` unresolved. It emitted `{after:'c'}`, but x
returned near x=5814 instead of its confirmed x=6186. Baseline: 20 pass, this
one failure, process exit 1. The common spring loop follows `targetRef` without
waiting for requests; reparenting already changes the shared layout tree before
calling its operation, while sibling reorder previously did not.

## Change

Sibling drag and toast Undo publish an operation-scoped pending order before
running the existing sequential reorder requests. The immutable transform uses
Rust reorder's midpoint between live sibling keys, then the common sibling
comparator. This preserves archived interleaving, subtree identity, and chart/list
agreement. It never reparents nodes or invents missing members/anchors.

Unanswered operations survive matching or stale snapshots. Refusal removes
only that operation's preview, revealing the current authoritative tree. After
success, an agreeing tree ends it; otherwise the existing five-second confirmed
move fallback bounds its lifetime. Replaced entries protect newer drags and Undo
from older responses and timers. Reparenting supersedes the same node's reorder
preview. Server validation, request order, sequential block semantics, errors,
and reparent behavior are unchanged.

## Measured verification

Rebased onto e901c7d. The focused `pendingmove` renderer suite passes **30/30**,
zero failures/skips, process exit 0 (16.675 seconds test time). TypeScript noEmit
also exits 0. Tests cover unresolved placement; row/circular success without a
return spring; refusal; chart/list and child-subtree agreement; root Undo; stale
snapshots; an old failure during a second drag; old timers; pending versus
confirmed timeout; invalid concurrent anchors; immutable branches; archived
midpoint interleaving and sequential block ordering. All original 20 reparent
tests remain included.

These are bounded jsdom renderer tests with mocked routes and a sized viewport;
positions are measured from rendered transforms. Existing act warnings are
present. No live hierarchy mutation, native pixel inspection, server operation
test, app build or installation was performed. This fixes the reproduced sibling
gap; it does not establish every possible live reparent gesture works.
