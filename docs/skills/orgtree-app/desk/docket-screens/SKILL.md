---
name: orgtree-docket-screens
description: Explain docket filters, agent/team subsets, item details and user reply or attention controls.
---
Up: [orgtree-desk](../SKILL.md)

# Work and agent dockets

The Work docket is the org work list. An agent Docket tab/modal narrows it to that agent's associated items; Team docket is opened from an agent's context menu and narrows by ownership in that agent's visible subtree. Team membership can require checking retained owners, so “checking membership” is not an empty result.

## Find work

Search matches ticket text. View options expose Arrange (No group, Group by status, Group by agent) and Sort (Last updated, Newest first, Status changed). Initial defaults are no grouping and last-updated order; these display choices are stored locally, not as item state. Archived and backlog are separate inclusion controls. Load more expands a bounded result window.

Rows show readable slug/title, status/attention, relevant actor identity and age. Nested items expand/collapse; search can preserve context rather than pretending parents are direct matches. A collapsed group, hidden backlog or unopened page is not proof a ticket is absent.

## Item pane

Selecting an item opens its full pane. Read the description as authoritative scope, then current status/reason, owner/reviewer/participants, dependencies/parent references, current progress/next steps, evidence, attachments and history when supplied. The pane loads full detail on demand and can show retry/error.

Manual attention is visibly separate from an open question. Dismiss attention clears that user flag; it does not answer a question or approve an agent's implementation by implication. Linked question cards retain their own answer flow.

User replies go through the ticket's reply UI with exact item context and supported attachment/notice controls. The owner and participants can receive replies; while an attention flag is active, its raiser is also an available recipient and is the default. Without an active attention flag, the owner remains the default. A reply to the attention raiser does not assign the item or grant docket access. Retired/unavailable recipients are shown rather than silently treated as current live holders. A local composed reply is not a saved scope change until the appropriate operation actually records it.

Do not interpret “review” as waiting for the user: status policy lives in `orgtree-docket-statuses` (orgtree-working › docket). For item mutations/actions, parameters and evidence use `orgtree-tool-work` there. This page describes the viewing surfaces, not another set of workflow rules.

Opening/closing a pane or changing filters does not assign, complete, archive or delete a ticket. A failed read is not an empty docket.

## Shared item menu and staffing

Right-click a docket row or an item reference elsewhere for the same item menu: open, owner identity/actions, copy title, copy slug and copy item reference when its org is known. Only an actual list has its local Show/Hide sub-items action. Hover any item link for the full current title.

An unarchived backlogged item offers Staff… using the app's Runtime > Docket > Quick staff behavior: request staffing from the assignee, hire under the assignee or hire at top level. Its disclosure states the effective mode and any fallback. Model, effort and account choices follow current availability; unavailable models are omitted, while a failed availability read says so. Opening the menu does nothing by itself; selecting a staffing action submits it, and changed authority, capacity or ownership can still cause refusal. See [Quick staff behavior](../../app-settings/app-quick-staff/SKILL.md) for the policy details.

## See also

- See `orgtree-docket-statuses` (orgtree-working › docket).
- See `orgtree-tool-work` (orgtree-working › docket).
