# Cancelling a draft hire restores the previous view

The alpha.7 follow-up (2026-10-07) fixes the missing camera snapshot in
`OrgCanvas`. The earlier change only captured an actually mounted agent desk.
Opening the draft replaced whole-org fit, switchboard focus and manual camera
position, leaving Cancel with nothing to restore for those views.

All draft entry points share `openDraft`: subordinate tier menus and chips,
top-level hires from the switchboard, sibling hires and superior insertion.
The first draft saves the camera intent and raw view. Replacing a draft keeps
that original snapshot. Cancel, Escape and plain click-away remove the draft,
wait for layout springs to settle, and restore the original intent. A manually
panned/zoomed view restores its exact transform without creating a follow mode.
Existing desk keyboard/caret restoration and generation validation remain.
Confirmation still clears the snapshot and uses the existing new-agent focus.

## Verification and the earlier smoke's blind spot

Measured in a disposable headless Edge fixture using production `OrgCanvas`
and `styles.css`, with real DOM geometry, camera animation and spring layout.
Provider/mail APIs were mocked and no live engine was contacted.

The same actual gestures (fit whole org, right-click boss, subordinate tier
submenu, haiku, Cancel) failed on alpha.7 source and passed with the fix:

- Before draft: `translate(-7167.6px,165.9px) scale(1.3)`.
- Draft: `translate(-9289.2px,-523.4px) scale(1.7)`.
- Baseline Cancel stayed at the draft transform.
- Fixed Cancel returned exactly to the original transform.

Additional browser checks cover switchboard/top-level-chip Cancel, manual
pan/zoom/submenu Escape, and full desk restoration with its composer selection.
The desk checks use subordinate-chip Cancel, sibling-chip Escape and
superior-chip click-away (edge hover and real pointer clicks).
No operation was emitted on cancellation and no browser page error occurred.
This is production renderer code in an isolated browser, not a claim of
verification in the installed desktop build.

The earlier jsdom smoke asserted that cancelling from overview did not reopen
an old desk. It never asserted the overview camera position or zoom, and its
fixed synthetic element geometry did not exercise real canvas framing. It
therefore passed within its limited desk-only coverage while missing this case.
