# Transcript bottom pin and user scroll intent

The alpha.7 regression came from two checks treating a changed scroll position
as user input: the scroll handler released when the viewport was away from the
bottom, and `pin()` released on upward movement before a scroll event arrived.
Browser anchoring and content reflow can produce both conditions.

The user ruled on 2026-10-07 at 09:31Z that only real scrolling may release the
pin. At 09:37Z they also called out expansion/collapse of the jump cards:
clicking a disclosure is not scroll intent.

## Input rule

- Upward wheel/trackpad or scrolling keys release immediately, before the
  asynchronous native scroll event. Ignore prevented events, control-wheel
  zoom, editing controls and Space used to activate a button/link/disclosure.
- Pointer presses qualify only on the scroller itself in its scrollbar gutter.
  An active scrollbar gesture releases on upward movement, including movement
  observed by `pin()` before its native event. Document-level pointer release
  and cancellation end the gesture; a final movement awaiting its scroll event
  is retained on pointer release.
- A one-finger touch drag tracks vertical direction. A downward finger movement
  is an upward transcript scroll and releases immediately.
- Directional input stays recent for one second for general scroll/anchor
  handling. A remembered downward direction also permits a later momentum
  scroll to resume follow, only when scrollTop actually increases into the
  bottom margin and the event is not our anchor's echo. Upward input, blur,
  explicit navigation and gesture cancellation clear that permission. No
  timer is scheduled; document listeners are removed when the desk unmounts.
- Ordinary content clicks and pointer presses carry no scrolling permission.
  While pinned, layout scrolls pin back to the bottom. While reading history,
  layout alone does not resume follow; user movement down to the bottom or the
  jump-to-bottom button does. User feedback on 2026-10-18 at 13:36Z gives the
  return an eight-pixel bottom margin, replacing the one-pixel rounding-only
  allowance. Reattachment hides the jump card, leaves history and follows new
  output through the existing pin path; another upward gesture detaches again.

The shared DeskChat path covers full, temporary, mini and detached desks.
Existing row-based history anchors and the context-menu hold remain in place.
`centerTranscriptTarget` remains the only centered-jump path and scrolls only
the transcript list, preserving its desk frame.

## Measured smoke and limits

A mounted DeskChat with the actual conversation store, fake server and modelled
geometry reproduces the alpha.7 failure: a content-driven scroll after growth
leaves scrollTop at 1596 instead of the new bottom 1680. The same smoke passes
with the fix.

Passing scenarios: content-generated scrolls, growing streamed rows, late-image
ResizeObserver sizing, an actual cursor page prepend, viewport resize, actual
jump-card expansion/collapse, tool-result and thought disclosure clicks. All
stay pinned. Half-pixel wheel escape, Up/PageUp/Home/Shift+Space, scrollbar
movement before its scroll event, pointer release before that event, and touch
drag escape survive streaming. Content pointer presses do not release follow;
being near the bottom and layout-only movement to the bottom do not resume it.
User wheel/touch return to the bottom and jump-to-bottom resume following.

The focused `transcriptfollow` regression covers an eight-pixel return in full,
pinned and second-document desk hosts, output growth after reattachment,
upward detachment, delayed downward momentum and layout/blur controls.

The smoke uses jsdom and synthetic geometry/events; it is not a native browser
measurement of Windows scrollbar or touch delivery. It touches no live data or
installed UI. Scratch source: `transcript-intent-smoke.tsx`; bundles are ignored
under `artifacts/transcript-intent-*.cjs`. Renderer typecheck also passes.
