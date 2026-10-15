---
name: orgtree-tool-swap
description: Exchange two live descendants' seats and assigned scope, grants and teams while preserving each identity.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_swap

Requires `team`. Both `a` and `b` are required names of distinct live agents **below you**. The caller is not one of the swapped agents: self, peers, superiors, unrelated targets and top-level reseating are refused. Use [self subjugate](../tool-self-subjugate/SKILL.md) when your own intended action is to step down.

This exchanges places, including parent/sibling position, grant, reports, team charter and configured scope. Each agent keeps its own identity, name, saved session, role charter, tier and mailbox. The model's seat price travels with its agent. For a nested pair, parent links and children are adjusted to retain a valid tree; inspect the resulting chart rather than assuming it is two independent moves.

Sibling or equal-seat swaps are budget-neutral at the affected payers. Different seat prices across different parents require the boundary payers' existing free credits to cover the difference. The swap never automatically raises grants; a shortage refuses with "reallocate first". The transaction applies both sides together or neither, then reconfigures affected branches for their new effective scope/team membership.

```json
{"a":"draft-checker","b":"notes-checker"}
```

This assumes two eligible live descendants and adequate capacity. The result returns `a`, `b` and `cascaded` (no grant-raising cascade for this operation). Inspect each new effective scope: changing a seat's position can change its rights and startup prefix even though its conversation identity survives.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
