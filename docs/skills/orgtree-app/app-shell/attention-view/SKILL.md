---
name: orgtree-attention-view
description: Triage the needs-attention queue beside an independently managed agent desk.
---

Up: [orgtree-app-shell](../SKILL.md)

# Attention view

The header's Attention mode places Needs attention beside an agent desk. The two panels can be pinned or popped out independently. In their places in the view they have no X; a pinned panel's X puts it back, and a popped-out one closes with its window's ×. A pinned panel can remain visible when returning to Canvas; an existing visible desk is not silently stolen by a competing pane. Use the offered existing-surface action when the desk is already open elsewhere. While Attention is the view on screen, an agent link, or any action that focuses an agent, opens that agent in the agent desk. The same holds when the agent desk is popped out and the main window is closed or minimized: the popped-out desk takes the agent and its window comes forward. With the main window on screen in Canvas, the canvas takes the jump instead.

The queue merges manually flagged docket items, unread urgent mail, and open questions into a newest-first feed. Flags can come from active, archived, or backlogged work. Questions can concern agents outside the currently displayed tree. Batch questions remain question cards rather than being converted into work items.

Each row uses the corresponding inbox or docket detail/actions. Right-click an urgent mail or a question for the menu the Inbox shows for that row: **Open** or **Close**, **Reply** (opens the mail and puts the caret in its reply box), **Mark as read**, **Delete** (the Inbox's confirmation; the mail leaves the queue) and the copy entries; a ticket row keeps the docket row's menu. Dismissing a flag hides it optimistically and restores it if the request fails. An urgent message selected for reading can remain visible until selection changes; answered questions leave the open-question feed. A work status change does not itself clear a manual attention flag. Loading, stale, and failed feed states must not be read as a verified empty queue.

The desk panel's agent drawer offers search and archive inclusion. Choose an agent to open its desk, and dismiss the drawer with Escape or an outside click. The divider resizes the panels: drag it, or focus it and use the arrow keys. A panel stops at a fifth of the width. Drag on to the edge of the view (or keep pressing the arrow, or press Home for the left panel and End for the right) and that panel is hidden, so the other one takes the whole view; drag the divider back in, or press the opposite arrow, and it returns at its smallest width. Clicking the divider (or pressing Enter or Space on it) makes the two panels trade places without moving the divider; a press that moves less than 4 pixels is a click, 4 or more is a drag. The small Swap panels button in the middle of the divider does the same, and dragging from it moves the divider like dragging anywhere else. The divider and its button are one hover target: the button shows while the divider is hovered or focused, and always on touch screens. With one panel hidden, swapping shows the hidden one and hides the other, and a second click goes back. The divider's right-click menu has Swap panels and Reset to center (the divider back to the middle, a hidden panel shown, the panels not swapped). Hidden and swapped are remembered for each organization. A hidden panel comes back by itself when something asks for it: choosing an agent (an agent link or a mention row) brings back a hidden Agent desk, a notification that opens its entry brings back a hidden Needs attention panel, and a pinned or popped-out panel that returns to the view is shown. While a panel is pinned or popped out, its empty place in the view can be hidden the same way; the panel's own window has no divider. Pinning or popping out changes where the surface lives, not who owns the work item or question.

## See also

- `orgtree-docket-review-and-attention` (orgtree-working › docket)
- [orgtree-ask-cards](../../desk/ask-cards/SKILL.md)

## User-mention mail

Unread mail mentioning @user in visible content uses the same mail entry and read/selection retention as urgent mail, without an urgent tag or fabricated reason. A matching sender/prose transcript mention is represented by the mail only when the mail was created at or after that mention and within ten seconds of it. Reading clears only that matching marker. Older mail, later independent repeats, and missing/invalid timestamps keep the transcript mention visible; uncertainty may leave a duplicate rather than hide an unseen mention.

Mentions appearing only inside inline, fenced, indented or HTML code do not
qualify as visible prose, including code in quoted mail content. Inbox and native
attention counts use that same rule across all unread mail, including mail beyond
the first loaded page. A real mention outside code still qualifies, and explicitly
urgent mail retains its attention signal regardless of its body.

Click a selected mail, question or ticket row again to clear its reading pane,
or press Escape while the queue list has focus. A read mail then leaves the
queue. Refreshing keeps a deliberately cleared pane empty and does not read
another mail. Choose a row, use the arrow keys or open a notification to resume.
Initial entries, new arrivals into an empty queue and the neighbor of a resolved
entry still select automatically.

## Jump to a transcript mention

The header’s glowing @ button, just left of STOP ALL, has the same count and behavior as in Canvas. It opens the newest unobserved transcript mention in the Attention desk, switches to Chat when necessary, centers the mentioning passage and uses the existing text highlight and observed clearing. Older transcript pages or a desk resize may be needed before the target can be centered; the jump is retained through that layout work instead of snapping back to the bottom. Mail mentions remain on the Inbox attention path.
