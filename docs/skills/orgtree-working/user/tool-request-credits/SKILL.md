---
name: orgtree-tool-request-credits
description: Request a new total credit grant while preserving other open request tabs and respecting available headroom.
---

Up: [orgtree-user](../SKILL.md)

# orgtree_request_credits

Use when additional concurrent staffing capacity requires a larger grant. Credits are capacity, not inference tokens or a monetary balance. A request does not allocate credits immediately. For ordinary agent-to-superior coordination use [mail](../../mail/tool-message/SKILL.md).

Required tool group: `user`, inherited through the ancestor chain. Only top-level agents and live, unpaused user-audience holders can request credits through this tool. A lower caller without the audience is **refused**, not automatically routed to its superior; send the superior the amount and reason by mail.

## Parameters and call

| Field | Meaning |
| --- | --- |
| `new_limit` | Required integer in the exposed schema, the requested **total grant**, not the extra delta. No default. |
| `reason` | Required explanation of why the capacity is needed. Nonblank when requesting an increase. |

For an agent needing a total grant of twelve:

```json
{"new_limit":12,"reason":"The approved work needs capacity for two additional reports."}
```

Use the amount justified by actual staffing. Compatibility numeric input is normalized by rounding to two decimal places then taking the ceiling; nonfinite input refuses. Prefer a whole-credit total as the schema specifies.

## Existing grants and headroom

If the normalized requested total is at or below the current grant, no increase is created. Any pending credit tab is removed and the result says the current grant already covers it; other request tabs remain unchanged. This is not a credit reduction/reallocation. This no-increase path can clear an obsolete credit request without a new reason.

The handler checks available whole-credit headroom in the superior chain and the configured top-level cap. With cascading allocation off, the direct superior's free capacity bounds room; with cascade on, chain room and top-level capacity matter. A zero top-level cap means no top-level cap. If room is zero or negative, it refuses with `there are ZERO credits available to grant` and creates no request. Free capacity or ask the user to raise the relevant cap before trying again; a repeated request cannot create capacity.

A request may still require the user to choose an achievable counter-offer; a positive room check is not a promise that the full requested increase fits or will be approved. Grant application rechecks current capacity rather than treating old headroom as reserved.

## Shared request lifecycle

The credit tab joins your one open [desktop request](../tool-ask/SKILL.md), alongside questions and scope items. Asking again replaces the credit part instead of opening another independent card. The user decides the batch; the answer arrives as mail. End your turn if the decision blocks more work. Do not treat a card appearing, silence, or a skipped/dismissed request as a grant.

[orgtree_withdraw_ask](../tool-withdraw-ask/SKILL.md) withdraws the entire request, including unrelated question/scope tabs. To clear only the credit tab, the already-covered total path above preserves the other parts.

Typical refusals are missing/non-numeric new_limit, nonfinite total, missing reason for an increase, no user audience, no available headroom, non-live requester, or an unresolved/incomplete supported ancestor chain. Report the concrete capacity constraint instead of repeatedly submitting the same blocked amount.

## See also

- [orgtree-reaching-the-user](../reaching-the-user/SKILL.md)
