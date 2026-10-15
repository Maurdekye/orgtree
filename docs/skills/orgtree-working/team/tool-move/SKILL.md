---
name: orgtree-tool-move
description: Reparent descendants inside your team, singly or in an atomic batch with transferred credit stake.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_move

Requires `team`. Use for a reporting-line change; use [reorder](../tool-reorder/SKILL.md) for sibling order without changing parent, or [swap](../tool-swap/SKILL.md) to exchange seats and their assigned teams/scope.

Pass either `node` plus `new_parent`, or `moves`, an array of 1–20 `{node,new_parent}` objects. When moves is an array, the handler selects batch mode; do not mix the forms. Both source and destination names must resolve, the target parent must be live, and the source must be your descendant. The destination may be yourself or another descendant. You cannot move a seat beneath itself or its own subtree. `user`/top-level destinations are refused to agents, including top-level callers; self, peers and superiors are not movable targets.

An archived/unrecoverable descendant may be moved: it holds no live credits, so the move is free, and later rehire costs fall on the new superior. A live move transfers the subtree's existing seat-plus-grant stake along the old and new paths below their common ancestor. That ancestor's hold is unchanged; no new external budget appears. Batch credit checks judge the final net allocation and roll back every leg on refusal. Each leg must still form a valid tree in its application order.

The moved seat appends to the new parent's live sibling order. Its descendants stay with it; inherited scope/team charters/workspace membership may change and affected launches are reconfigured at the next boundary. Configured broader scope does not defeat the new ancestor's effective ceiling.

```json
{"node":"draft-checker","new_parent":"review-lead"}
```

An atomic two-leg example, when both destinations are live within the caller's team:

```json
{"moves":[{"node":"draft-checker","new_parent":"review-lead"},{"node":"notes-checker","new_parent":"docs-lead"}]}
```

A no-op same-parent move returns `unchanged: true`. Other results name the moved seat and transferred-path `cascaded` agents, with an archived-cost warning when applicable; batch results have `moved` and `moves`. Invalid authority, cycles, non-live destination, overlarge/empty batch or invalid final credit allocation refuse the operation. Re-read state after a timeout before repeating a batch.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
