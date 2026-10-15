---
name: orgtree-tool-dissolve
description: Archive a live descendant and its entire live team while retaining their history and scratch files.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_dissolve

Requires `team`; `node` is the only parameter and is required. It must name a live descendant. This is the explicit whole-subtree operation; [retire](../tool-retire/SKILL.md) on a manager also archives its live subtree but warns about that expansion.

All live seats in the selected subtree become archived and their processes stop. Open request cards become moot; owned watchdogs are paused. The result returns the root `node`, the count of archived `nodes`, and `freed` equal to that root's seat plus grant. Do not sum every descendant's grant again: their allocations were already inside the root grant.

History and files survive. A later [rehire](../tool-rehire/SKILL.md) of the root restores that identity only; former reports are not all automatically live. Docket scope and incomplete work survive, so arrange ownership and leave evidence/handoffs before dissolution. Use [halt](../../runtime/tool-halt/SKILL.md) to stop named live workers temporarily without freeing capacity.

Self, peers, superiors and unrelated targets are refused. A top-level agent has the same downward restriction; it cannot dissolve the org or peer teams. Unlike an already-archived retire no-op, dissolving a non-live root is refused with "is not live".

```json
{"node":"finished-review-team"}
```

This assumes a live descendant team whose outstanding work has been handed off. Read the returned count and freed capacity before staffing replacement work.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
