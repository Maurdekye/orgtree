---
name: orgtree-docket-screens
description: Explain docket filters, agent/team subsets, item details and user reply or attention controls.
---
Up: [orgtree-desk](../SKILL.md)

# Work and agent dockets

The Work docket is the org work list. An agent Docket tab/modal narrows it to that agent's associated items; Team docket is opened from an agent's context menu and narrows by ownership in that agent's visible subtree. Team membership can require checking retained owners, so “checking membership” is not an empty result.

## Empty desk tabs and team defaults

Desk **Docket** and **Presented** tabs hide when neither the node nor its team has anything the tab would list under its default filters. A tab appears or disappears as content changes, but stays visible while you are on it; an empty tab disappears when you leave. Search and sorting do not hide tabs. The Docket check follows the existing list, including recently completed tickets during their one-hour window and attention exceptions. Show archived and Show backlogged include those groups when enabled. Presented starts with hired presenters; Show retired includes retired presenters.

When only the team has content, entering the tab starts with **Team** checked and auto-select works in that team scope. A manual untick is remembered for this organization and node across visits/restarts until own content arrives. Own content keeps the ordinary own-node default. Live arrivals do not switch the scope or selection of a reader you are using. These rules apply to both agent desks and project Presented tabs. A project Docket already lists its subtree and keeps that scope without a Team checkbox.

## Opening priority and remembered selection

A fresh opening selects the topmost ticket with a manual attention flag, or the oldest unread/changed presentation by its current update/creation time. Otherwise it restores the last viewed eligible item for that organization and collection scope (org, node/project or team), then the topmost row, or nothing for an empty list. Closed tickets and dismissed documents do not win the remembered-item preference. The preference survives close/reopen and restart, respects current filters, and does not mark a document viewed on an agent's behalf.

This applies to the top-bar buttons, agent/project Open submenus including team views, and entering a desk's Docket/Presented tab. Leaving a desk tab and returning is a fresh opening. Explicit item/document links keep their target. Bringing forward, resizing, pinning, popping out or restoring an already-open reader keeps its current selection, including a deliberate empty pane. Polls never replace a choice.

## Find work

Search matches ticket text. In a centered agent/team docket, Escape first clears a focused nonempty search and keeps focus; an empty or unfocused search closes the frame normally, matching the Work docket. View options expose Arrange (No group, Group by status, Group by agent) and Sort (Last updated, Newest first, Status changed). Initial defaults are no grouping and last-updated order; these display choices are stored locally, not as item state. Archived and backlog are separate inclusion controls. Load more expands a bounded result window.

Rows show readable slug/title, status/attention, relevant actor identity and age: how long ago, by the clock the list is sorted by, on one scale (minutes, hours, then days, weeks, months and years), with that clock and the full date and time on hover. An open ticket's header gives the full date and time it was updated (user 2026-10-29). Nested items expand/collapse; search can preserve context rather than pretending parents are direct matches. A collapsed group, hidden backlog or unopened page is not proof a ticket is absent.

## Item pane

Ticket links and rows in a live message-box context offer **Mention** then
**Reply**: insert the ticket reference at the caret, or stage an answer about
that exact ticket in the owning composer. Neither sends. This includes agent
and project desks, mail readers and canvas content sharing Quick chat; the
nearest enclosing composer wins. Standalone docket menus stay unchanged.
See [composer routing](../desk-chat/SKILL.md#composer).

Selecting an item opens its full pane. Read the description as authoritative scope, then current status/reason, owner/reviewer/participants, dependencies/parent references, current progress/next steps, evidence, attachments and history when supplied. The pane loads full detail on demand and can show retry/error.

Manual attention is visibly separate from an open question. **Dismiss** clears that flag and records its dismissal. Done and Review keep their status; every other status becomes Blocked, with a reason recording that the user dismissed the attention flag. It does not answer a question or approve an agent's implementation by implication. Linked question cards retain their own answer flow.

The item's **Attachments** section offers **Attach files…**. It copies selected files onto that item, up to 25 MiB per file, with unique stored names when filenames collide. Open or download a listed attachment from the item. **remove** asks for confirmation, then permanently deletes that attachment's stored item copy and its record; it leaves the original selected file and other copies alone. Item attachments are separate from evidence links and attachments staged in a reply.

User replies go through the ticket's reply UI with exact item context and supported attachment/notice controls. The owner and participants can receive replies; while an attention flag is active, its raiser is also an available recipient and is the default. Without an active attention flag, the owner remains the default. A reply to the attention raiser does not assign the item or grant docket access. Retired/unavailable recipients are shown rather than silently treated as current live holders. A local composed reply is not a saved scope change until the appropriate operation actually records it.

Do not interpret “review” as waiting for the user: status policy lives in `orgtree-docket-statuses` (orgtree-working › docket). For item mutations/actions, parameters and evidence use `orgtree-tool-work` there. This page describes the viewing surfaces, not another set of workflow rules.

Opening/closing a pane or changing filters does not assign, complete, archive or delete a ticket. A failed read is not an empty docket.

## Shared item menu and staffing

Double-click a docket row (the org Docket view, a desk **Docket** tab or the attention list) to copy the item's mention, `@item:<org>/<slug>`, with a brief **Copied!** where you clicked (user 2026-10-27; it used to copy the bare slug). The menu's **Copy slug** still copies just the slug, and a single click still selects the row.

Right-click a docket row or an item reference elsewhere for the same item menu: open, owner identity/actions, copy title, copy slug and copy item reference when its org is known. An item reference (`@item:<org>/<slug>`) shows the item's current full title rather than its slug, and follows renames (user 2026-10-27); Copy slug and the reference keep the slug. Inside an agent or project desk with a live message box, the menu starts with **Mention**, which inserts the item reference `@item:<org>/<slug> ` into that desk's message box at the caret (appended when the box is unfocused) without sending. Only an actual list has its local Show/Hide sub-items action. Hover any item link for the full current title.

An unarchived backlogged item offers Staff… using the app's Runtime > Docket > Quick staff behavior: request staffing from the assignee, hire under the assignee or hire at top level. Its disclosure states the effective mode and any fallback. Model, effort and account choices follow current availability; unavailable models are omitted, while a failed availability read says so. Opening the menu does nothing by itself; selecting a staffing action submits it, and changed authority, capacity or ownership can still cause refusal. See [Quick staff behavior](../../app-settings/app-quick-staff/SKILL.md) for the policy details.

## See also

- See `orgtree-docket-statuses` (orgtree-working › docket).
- See `orgtree-tool-work` (orgtree-working › docket).

## Reply to selected docket text

Select part of a title, description, current blocked/dropped reason, a progress entry or an evidence note and choose **Reply to selection**. One gesture covers one field/entry. The item reply box stages the excerpt and nearby context without replacing your draft or selected recipient. Remove individual passages or cancel all before sending.

Sending retains the ordinary item reply rules: the current owner/participant/attention-raiser recipient check, and attention clearing only after a successful send under its existing conditions. Every selected source is validated first; a changed field refuses without clearing attention. Duplicate list entries without stable identities refuse rather than guess. Captured quotes remain readable after later edits. The shared [selection limits](../inbox-screens/SKILL.md#reply-to-selected-mail-text) also apply here. Agents use the Working category's **orgtree-tool-read-reply-source** and **orgtree-tool-message** contract for equivalent scoped reads and selection replies.
