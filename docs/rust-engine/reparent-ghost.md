# Reparent landing preview

Dragging a live agent over a different live parent or the switchboard shows a
card-sized, rounded, unfilled outline at the future landing slot in tree and
ring layouts. It uses the reorder separator's accent and has no pointer events.
The outline disappears when leaving the target, dropping or cancelling with Escape.
Own descendants, the current parent, retired parents and the org inbox do not
produce a reparent ghost; the inbox retains its audience-grant behavior.

`moveghost.tsx` mirrors `moveShown`'s pending-state transition: replace that
agent's move, remove orders containing it, and retain other pending operations.
It shares `canvaslayout.ts` with the real canvas: draft, retired canonicalization,
display pruning, pile selection, hidden members, layout, watchdogs, inbox clearance
and vertical headroom. The outline therefore predicts the final animation target,
including a crowd member's pile slot. No engine, move, animation or Undo semantics
change. Escape restores the captured group and prevents a later release committing.

Typecheck passes. The focused renderer run passes all 58 tests across
`reorderpreview`, `pendingmove` and `hideretired`, including six actual-canvas
ghost cases: agent/switchboard landing and invalid/leave/Escape cancellation in
both layouts. These compare the outline with a separately mounted confirmed
tree and the subsequent move animation. The jsdom viewport and pointer capture
are stubbed; native/installed behavior is untested.

Synthetic light/dark visual verification remains queued. The first visual
harness rejected vertical SVG lines because its generic visibility predicate
requires nonzero bounding-box width. The harness has been corrected to wait
for the SVG element itself; product source is unchanged.
