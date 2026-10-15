---
name: orgtree-app-quick-staff
description: Explain whether Staff on a backlogged ticket asks its owner or creates a seat immediately.
---

Up: [orgtree-app-settings](../SKILL.md)

# Quick staff behavior

Runtime > Docket > **Quick staff behavior** is app-wide, stored as `rt:quick_staff_behavior` through `/api/app-settings/runtime`. The built-in default is `request`. The selector saves immediately, shows a pending disabled state during the request, and displays an error if it fails. Agents explain and suggest the choice; they do not change settings themselves.

| Choice | Stored value | Staff action on a backlogged ticket |
| --- | --- | --- |
| Request staffing | `request` | Ask the assigned agent to arrange staffing. |
| Staff immediately (under assignee) | `under_assignee` | Offer model/account choices and create the owner under the current live assignee. |
| Staff immediately (top level) | `top_level` | Offer model/account choices and create the owner at top level. |

If the configured path relies on an assignee who is no longer live, Quick staff falls back to immediate top-level staffing. Its preview discloses that fallback and asks for a model. Do not describe Request staffing as an absolute guarantee that no immediate staffing can occur when the assignee is unavailable.

This applies to the user's **Staff…** workflow for backlogged tickets. It is distinct from the agent `orgtree_staff` tool; see `orgtree-tool-staff` (orgtree-working › docket). It does not alter normal assignment ownership rules or make every existing ticket start running merely because the setting changed. Quick staff refuses a ticket that is no longer backlogged when its preview or commit is checked.

Immediate choices remain subject to installed harness, provider/account eligibility, model entitlement and credit checks. The setting does not reserve capacity or sign into an account. Request mode uses the assignee's delegation rather than making a model choice on its behalf.

Suggest Request staffing when the user wants the assigned agent to decide how to divide the work. Suggest under assignee when the new worker should stay in that manager's team; top level when the user wants an independent owner. Explain the unavailable-assignee fallback before recommending a setting for a specific ticket.

Changing this control does not restart existing agents or change their prompt prefix. The eventual staffing action has its own effects; inspect its result before claiming a seat or assignment exists.

## See also

- `orgtree-tool-staff` (orgtree-working › docket).
