# Middle-button canvas pan

Middle-button pointer gestures use native DOM capture at the visible viewport before
nodes, piles, watchdogs, the inbox or their nested controls can intercept them.
They use the existing background pan handlers, camera rebasing and saved view.
The switchboard click-to-focus flag is set only by the left button. A stationary
middle click therefore opens nothing. Mousedown and auxclick defaults are
suppressed to avoid browser autoscroll and opening links in another window.
Pointer release, cancellation and lost capture end the gesture. The handlers
belong to each mounted viewport, including a canvas in another window; there
is no main-window event binding. Left/right handlers and hidden-canvas gates
retain their existing behavior. Active middle pans ignore other pointer IDs;
unmounting or hiding the canvas removes the listeners and releases owned capture.

## Desk portals (2026-10-16)

The original React capture handler missed focused desks. `DeskHosts` renders
`HostList` beside the viewport in the React tree, and `MovableSurface` portals
the real desk DOM into its slot. React's synthetic event ancestry therefore
skipped the viewport even though its DOM contained the desk. Native capture
on the actual viewport reaches that DOM before a transcript/composer can
claim the press. It uses the same background-pan functions and captures the
pointer on the viewport, never on a desk wrapper.

Pinned frames use `pinLayerFor`/`adoptPinLayer`: their layer is also a DOM child
of the viewport. Middle drag pans the camera while their rectangle stays fixed.
Presentation cards and the org-inbox tile are ordinary canvas descendants;
the same boundary handles them. A presentation in a pinned modal uses the same
adopted pin layer. Unpinned modal overlays, separate HTML-preview documents and
separate desk popout windows have no containing canvas viewport, so these native
listeners do not reach them. The hidden-canvas gate remains authoritative.

No existing canvas middle-button action was found by source search. Focused
actual-canvas tests cover middle drags over agent, switchboard, background and
a nested link that stops propagation in both layouts; still middle/right
presses; viewport persistence; release cleanup; and unchanged left background
pan. Existing pending move/reorder/Undo and eye-focus tests are the left-drag
and focus regression controls. The original integrated batch measured 54/54
passing across `pendingmove` and `eyepressleak`, with typecheck exit0.

The initial new test-only desk red (`fb0a821`) measured 54 pass/10 fail:
three genuine row-layout header/transcript/composer pan failures, five fixture
mount failures, and two pinned cases that passed pan/default/capture checks
but failed their unmodelled scroll fixture. Those seven are not additional
missed-pan findings. Follow-up fixtures isolate saved camera/pins and provide
scrollable geometry plus the reader's scroll event. Final tests also cover
both layouts' actual pinned title/transcript, pointer ownership/cancel/loss,
left/right event defaults and selection, and inbox/presentation cards. The
corrected red/green pair and source typecheck await rig verification.

Synthetic events and jsdom scroll dimensions do not measure physical browser
autoscroll, native text-selection gestures or separate-window input. Those
remain acceptance limits; no desktop app build is part of this change.
