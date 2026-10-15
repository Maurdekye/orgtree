---
name: orgtree-org-policies-cost
description: Explain the org's hire and allocation credit-bubbling switches.
---

Up: [orgtree-org-settings](../SKILL.md)

# Credit cost bubbling

**Org settings > Policies > Credit cost bubbling** controls whether a credit
operation may raise intervening grants to use free credits higher in its
authorized chain. Agents suggest; the user edits. Both switches are org
booleans, default **on**, saved with the panel footer.

| Switch | Storage key | Operations |
| --- | --- | --- |
| hires bubble their cost up the chain | `org:cascade_hire` | Hire and rehire funding. |
| allocations & model upgrades bubble their cost up the chain | `org:cascade_alloc` | Grant increases and model/seat upgrades, including swaps that need more capacity. |

On allows intervening descendant grants to rise enough to fund an operation.
For an agent caller this stops at its own current allocation: it cannot raise
its own grant or draw from above itself. A user-initiated operation may fund
up through the chain but remains subject to the top-level grant cap.

Off requires the funding parent to hold the needed free credits already.
Insufficient room, or a cap that would be exceeded, refuses the operation
atomically rather than leaving part of a cascade applied. The error names the
agent's free credits and amount needed, or the cap. Non-boolean setting values
are refused. Saving the switch does not itself allocate credits or resize
existing grants.

Suggest on when the user wants authorized operations to use available capacity
within a caller's budget without manually resizing each intermediate grant.
Suggest off when the user wants each immediate funding parent prepared
explicitly. For capacity accounting and credit requests, see `orgtree-credits`
(orgtree-working › team).

## See also

- `orgtree-credits` (orgtree-working › team).
- [orgtree-org-basic](../org-basic/SKILL.md).
