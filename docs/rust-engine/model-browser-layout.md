# Model browser row height

The OpenRouter and Language Server browsers share the `.orr-list` flex column.
It caps its height and scrolls internally. Its children must use `flex-shrink: 0`:
otherwise a full page squeezes each grid row below its name/detail content height,
overlapping the detail lines and leaving the final row clipped.

The row padding, columns, horizontal ellipsis, price/selection alignment and
pagination stay unchanged. Sticky provider headings also retain their natural
height. The existing pager stays outside the list's scrolling region.

User report: 2026-10-13, OpenRouter 25-row page compressed in a narrow panel.
Verification uses the real React picker markup and production stylesheet in
headless Edge, with the old stylesheet as the negative control. Both shared
browsers are checked at narrow/wide viewports in dark/light themes, including
natural row height, content containment, internal scrolling and final-row reach.
