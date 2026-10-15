---
name: orgtree-agent-credit-grant
description: Explain the agent credit slider, immediate saving and available limits.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Credit grant slider

**Credit grant** in Scope controls `node:grant`, the selected agent's capacity for reports. Its current grant is the initial value; there is no separate fixed default in this control. It is shown for live agents, excluding the user and legacy bearer cards. Agents explain or recommend capacity changes; they do not operate settings themselves. See `orgtree-credits` (orgtree-working › team) for seat, grant, committed and free capacity.

This control saves immediately through a reallocation when the gesture commits. It does not wait for the form's Save, and the form's Cancel does not reverse an accepted grant.

- Drag from the bar; a six-pixel movement threshold prevents accidental drags. Hold in its rightmost 10% after starting a drag to expand the visible range over time. The visible scale is not the maximum allowance.
- Arrow keys step by one credit. Home selects the minimum; End selects the maximum. Key release or keyboard blur commits. Pointer release commits a drag.
- Escape cancels the unfinished gesture. Pointer cancellation or lost capture also cancels. A changed credit baseline during editing stops the gesture with a retry message.

## Limits

The minimum is committed capacity: `grant - free`, bounded below by zero, rounded up to a whole credit for the slider. It cannot withdraw capacity held by reports.

For a top-level agent, the maximum is the greater of the current grant and the organization's top-level cap. This keeps a grant already above a newly lowered cap visible without offering a further increase. For a descendant with allocation cascading off, the maximum is its grant plus the direct superior's nonnegative free capacity. With cascading on, available capacity propagates from the top-level cap down the ancestor chain, including each ancestor's free capacity and whole-credit raises; the displayed maximum rounds down.

The bar is disabled while saving, when no valid range is available, or when necessary superior details are missing. The latter says **Waiting for the superior's credit details**. The engine rechecks live state, the top-level cap, available upstream capacity and committed capacity when the request lands; a stale slider cannot override those checks. Errors appear below the bar.

Suggest increasing the grant when the agent needs capacity to staff reports. Suggest reducing only free capacity when returning unused headroom is intended. Model seat cost is a separate choice; dragging this bar does not change the agent's own model.

## See also

- `orgtree-credits` (orgtree-working › team).
- [orgtree-agent-config](../agent-config/SKILL.md).
