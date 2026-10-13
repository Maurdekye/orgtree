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

Typecheck passed at implementation. Focused renderer regression and synthetic
light/dark visual verification are queued; native/installed behavior is untested.
