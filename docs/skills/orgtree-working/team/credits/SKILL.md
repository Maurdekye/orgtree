---
name: orgtree-credits
description: Interpret staffing capacity and choose whether to reuse seats, reallocate free grants or request more allocation.
---
Up: [orgtree-team](../SKILL.md)

# Read capacity before staffing

Credits measure concurrent staffing capacity. The seat is the model tier's reservation, the grant is capacity allocated to that agent's team, and free credits are the grant not committed to its live direct reports. They are not tokens, a dollar balance or a promise of remaining turns. [Hire](../tool-hire/SKILL.md) contains the exact held/free arithmetic and superior-insertion funding cases.

Read the current ORG STATE and use state inspection when you need exact balances; an old charter can describe a different allocation. A live but idle or halted team can still hold capacity. First decide whether an existing worker can own the task, whether finished expertise should be retired for room, or whether another live branch needs its unused grant back.

Use [reallocate](../tool-reallocate/SKILL.md) for an authorized redistribution; its negative-delta refusal protects credits already held by the target's reports. If the caller's allocation is insufficient, use [request credits](../../user/tool-request-credits/SKILL.md) through the permitted request route. A cascade is not permission to silently raise your own grant.

The two cost-bubbling switches affect hiring and allocation/model-price changes separately; exact effects and refusal boundaries are in the corresponding tool pages. See `orgtree-org-policies-cost` (orgtree-app › org-settings) for their user settings. Moving an existing team transfers its stake rather than funding new work; use [move](../tool-move/SKILL.md) for that conservation rule.

When a tool refuses capacity, report the actual payer, available room and required action. Do not derive token budgets from the credit bar, repeatedly retry unchanged balances, or change user settings yourself to bypass a refusal.

## See also

- [orgtree-tool-reallocate](../tool-reallocate/SKILL.md)
- [orgtree-tool-request-credits](../../user/tool-request-credits/SKILL.md)
- `orgtree-org-policies-cost` (orgtree-app › org-settings)
