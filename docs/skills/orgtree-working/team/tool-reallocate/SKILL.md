---
name: orgtree-tool-reallocate
description: Increase or reduce a live descendant's grant within available team capacity.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_reallocate

Requires `team`. Required `node` names a live descendant and required integer `delta` is added to its grant: positive gives capacity, negative takes unused capacity back, zero returns the current grant without a change. Source authorizes any descendant, not just a direct report. Self, peers, superiors and unrelated seats are refused; top-level callers cannot raise their own allocation.

Each live direct report reserves `seat + grant` from its parent's grant; free is the parent's grant minus that hold. Increasing a target grant needs room at its parent. Agent calls always bubble through intermediate descendant grants just enough to fund it, stopping at the caller's existing allocation. The app's allocation-bubbling switch controls user actions only. Insufficient free room at the agent's boundary refuses atomically; an agent call cannot draw extra credits from above its own allocation.

Decreasing a grant cannot reclaim credits already held by the target's live children. The refusal reports how many credits are free and that the rest is held by reports. Retiring a finished report is a separate way to free that hold; do not retire unfinished work merely to make a grant edit fit. Credits are concurrent staffing capacity, not inference tokens or money.

```json
{"node":"review-lead","delta":2}
```

This requires at least the relevant fundable capacity. Taking one unused credit back uses `delta: -1`. The result returns `node`, final `grant` and any `cascaded` intermediate agents. It does not change the seat's tier, scope or task assignment. User-originated top-level allocation has its own org cap; an agent call never inherits user authority from being top-level.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
