---
name: orgtree-app-credit-bubbling
description: Explain the user's two app-wide credit-bubbling switches and why agents always bubble.
---

Up: [orgtree-app-settings](../SKILL.md)

# Credit cost bubbling

**App settings > Runtime > Credit cost bubbling** holds two switches. They are
app-wide (one value for every organization), default **on**, and save
immediately through `/api/app-settings/runtime`. They govern only **your own
actions** as the user; they moved here from each organization's settings
(Org settings > Policies) and from the new-org defaults, and any value stored
there earlier is ignored.

| Switch | Storage | Your operations |
| --- | --- | --- |
| your hires bubble their cost up the chain | `rt:credit_bubble_hire_enabled` | Hire and re-hire funding. |
| your allocations & model upgrades bubble their cost up the chain | `rt:credit_bubble_alloc_enabled` | Grant increases and model/seat upgrades, including swaps that need more capacity. |

**On** lets the grants between the paying parent and the chain above rise just
enough to fund the operation, as far as the top-level grant cap allows. **Off**
requires the immediate funding parent to hold the needed free credits already;
otherwise the operation is refused, naming the agent's free credits and the
amount needed, and nothing is changed. Saving a switch does not itself allocate
credits or resize existing grants.

**Agents always bubble.** An agent's hire, re-hire, reallocation, model upgrade
and credit-request headroom raise the chain above the paying parent whatever
these switches say, because the switches only save the user steps. An agent's
own allocation is still the floor: it cannot raise its own grant, draw from
above itself, or exceed the top-level cap, and a refusal stays atomic. Agents do
not change these switches themselves; there is no agent tool for them.

Suggest **off** when the user wants every funding parent prepared by hand.
Suggest **on** (the default) when the user wants their own operations to use
available capacity without resizing each intermediate grant. For capacity
accounting and credit requests see `orgtree-credits` (orgtree-working › team).

## See also

- `orgtree-credits` (orgtree-working › team).
- [orgtree-app-concurrency-and-checkups](../app-concurrency-and-checkups/SKILL.md): the other Runtime switches.
