---
name: orgtree-attention-view
description: Triage the needs-attention queue beside an independently managed agent desk.
---

Up: [orgtree-app-shell](../SKILL.md)

# Attention view

The header's Attention mode places Needs attention beside an agent desk. The two panels can be pinned or popped out independently. A pinned panel can remain visible when returning to Canvas; an existing visible desk is not silently stolen by a competing pane. Use the offered existing-surface action when the desk is already open elsewhere.

The queue merges manually flagged docket items, unread urgent mail, and open questions into a newest-first feed. Flags can come from active, archived, or backlogged work. Questions can concern agents outside the currently displayed tree. Batch questions remain question cards rather than being converted into work items.

Each row uses the corresponding inbox or docket detail/actions. Dismissing a flag hides it optimistically and restores it if the request fails. An urgent message selected for reading can remain visible until selection changes; answered questions leave the open-question feed. A work status change does not itself clear a manual attention flag. Loading, stale, and failed feed states must not be read as a verified empty queue.

The desk panel's agent drawer offers search and archive inclusion. Choose an agent to open its desk, and dismiss the drawer with Escape or an outside click. The divider resizes the panels, including keyboard operation. Pinning or popping out changes where the surface lives, not who owns the work item or question.

## See also

- `orgtree-docket-review-and-attention` (orgtree-working › docket)
- [orgtree-ask-cards](../../desk/ask-cards/SKILL.md)

## User-mention mail

Unread mail mentioning @user in visible content uses the same mail entry and read/selection retention as urgent mail, without an urgent tag or fabricated reason. Its matching sender/prose mention blurb is suppressed while that mail represents it; reading clears that matching marker, and unrelated mention rows remain.

Click a selected mail, question or ticket row again to clear its reading pane,
or press Escape while the queue list has focus. A read mail then leaves the
queue. Refreshing keeps a deliberately cleared pane empty and does not read
another mail. Choose a row, use the arrow keys or open a notification to resume.
Initial entries, new arrivals into an empty queue and the neighbor of a resolved
entry still select automatically.

## Jump to a transcript mention

The header’s glowing @ button, just left of STOP ALL, has the same count and behavior as in Canvas. It opens the newest unobserved transcript mention in the Attention desk, switches to Chat when necessary, and uses the existing text highlight and observed clearing. Mail mentions remain on the Inbox attention path.
