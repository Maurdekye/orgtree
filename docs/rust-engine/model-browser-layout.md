# Model browser row height

The OpenRouter and Language Server browsers share the `.orr-list` flex column.
It caps its height and scrolls internally. Its children must use `flex-shrink: 0`:
otherwise a full page squeezes each grid row below its name/detail content height,
overlapping the detail lines and leaving the final row clipped.
The Providers tab's scoped `button { min-height: 28px }` rule makes this visible:
it permits rows to shrink below their automatic content minimum. A standalone
picker without that ancestor does not reproduce the compression.

The row padding, columns, horizontal ellipsis, price/selection alignment and
pagination stay unchanged. Sticky provider headings also retain their natural
height. The existing pager stays outside the list's scrolling region.

User report: 2026-10-13, OpenRouter 25-row page compressed in a narrow panel.
Verification uses the real React picker markup and production stylesheet in
headless Edge, with the old stylesheet as the negative control. Both shared
browsers are checked at narrow/wide viewports in dark/light themes, including
natural row height, content containment, internal scrolling and final-row reach.

Measured 2026-10-13: 25 real React rows in the Providers-tab context, flat and
grouped OpenRouter plus Language Server, at 722×1188 and 1200×900 viewports
(680px/1000px panels), dark/light themes. The old CSS compresses OpenRouter rows
to 28px versus their 39.875px content height. The fixed CSS keeps them 39.875px;
Language Server rows stay 42.5px. All 12 fixed cases retain internal scrolling,
visible footer and reachable last row. Scroll-boundary checks allow one CSS
pixel for integer scroll-size versus fractional rectangle rounding.

Existing `openrouter.test.tsx` and `langserver.test.tsx`: 22 passed, no skips.
Typecheck passed with explicit read-only paths to existing dependencies; no
dependency links, installs, live provider calls or application builds. This is
isolated rendered proof, not an observation of the user's installed application.
