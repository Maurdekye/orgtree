---
name: orgtree-tool-reallocate
description: Increase or reduce a live descendant's grant within available team capacity.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_reallocate

Requires `team`. Required `node` names a live descendant and required integer `delta` is added to its grant: positive gives capacity, negative takes unused capacity back, zero returns the current grant without a change. Source authorizes any descendant, not just a direct report. Self, peers, superiors and unrelated seats are refused; top-level callers cannot raise their own allocation.

Each live direct report reserves `seat + grant` from its parent's grant; free is the parent's grant minus that hold. Increasing a target grant needs room at its parent. If allocation cascade is enabled, intermediate descendant grants may rise just enough to fund it, stopping at the caller's existing allocation. Insufficient free room at that boundary, or disabled cascade with inadequate room, refuses atomically. It cannot draw extra credits from above the acting agent.

Decreasing a grant cannot reclaim credits already held by the target's live children. The refusal reports how many credits are free and that the rest is held by reports. Retiring a finished report is a separate way to free that hold; do not retire unfinished work merely to make a grant edit fit. Credits are concurrent staffing capacity, not inference tokens or money.

```json
{"node":"review-lead","delta":2}
```

This requires at least the relevant fundable capacity. Taking one unused credit back uses `delta: -1`. The result returns `node`, final `grant` and any `cascaded` intermediate agents. It does not change the seat's tier, scope or task assignment. User-originated top-level allocation has its own org cap; an agent call never inherits user authority from being top-level.
