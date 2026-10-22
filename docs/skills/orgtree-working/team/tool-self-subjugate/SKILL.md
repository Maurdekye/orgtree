---
name: orgtree-tool-self-subjugate
description: Promote a live descendant into your position and move beneath it without increasing the external allocation.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_self_subjugate

Requires `team`. Its sole required parameter, `target`, names **one of your live descendant nodes**, agent or project, not necessarily a physical child. It is the caller's own act: the descendant takes the caller's former structural position, keeps its own team, and the caller moves beneath it with the rest of the caller's subtree. Self, peers, superiors, unrelated and non-live targets are refused.

A project remains a container: its identity, Summary, settings, listeners, queues, slot leases and audiences stay with it. Its seat costs zero and its grant mirrors its members rather than allocating a new budget. It does not become an agent manager; reports still go to the nearest agent ancestor. Every agent along the old funding path releases the extracted stake, preserving its free credits. Agent targets retain the existing seat and scope rules below.

This also works for a top-level caller: the promoted descendant becomes top-level. It is not permission to promote arbitrary peers, create credits or grant broader scope. The promoted agent receives the caller's configured scope; effective rights are still ancestor-clamped. Its own identity, tier and team remain. Unlike [swap](../tool-swap/SKILL.md), this does not exchange two descendants' seats/grants/teams symmetrically.

The external stake stays the caller's old seat plus grant. The promoted agent's grant is derived from that stake minus its seat cost; the caller receives the remaining grant after the promoted subtree's old stake is removed. The promoted agent must be able to fund both the caller's remaining subtree and its own reports. A shortage refuses with "reallocate before stepping down"; no credit cascade raises the external budget.

```json
{"target":"review-lead"}
```

This assumes review-lead is a live descendant and the existing stake is sufficient. The result names the caller as `node` and the promoted node as `promoted`. Inspect the chart, credits and effective scope afterward. If the promoted node is an agent, it becomes the caller's superior and can manage the former caller. If it is a project, reporting still skips it to the nearest agent ancestor. Leave ownership and work instructions clear before changing the reporting chain. For creating a new superior rather than promoting an existing descendant, use [hire](../tool-hire/SKILL.md) with its distinct self-parent funding rules.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
