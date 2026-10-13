# Middle-button canvas pan

Middle-button pointer gestures are captured at the visible viewport before
nodes, piles, watchdogs, the inbox or their nested controls can intercept them.
They use the existing background pan handlers, camera rebasing and saved view.
The switchboard click-to-focus flag is set only by the left button. A stationary
middle click therefore opens nothing. Mousedown and auxclick defaults are
suppressed to avoid browser autoscroll and opening links in another window.
Pointer release, cancellation and lost capture end the gesture. The handlers
belong to each mounted viewport, including a canvas in another window; there
is no main-window event binding. Left/right handlers and hidden-canvas gates
retain their existing behavior.

No existing canvas middle-button action was found by source search. Focused
actual-canvas tests cover middle drags over agent, switchboard, background and
a nested link that stops propagation in both layouts; still middle/right
presses; viewport persistence; release cleanup; and unchanged left background
pan. Existing pending move/reorder/Undo and eye-focus tests are the left-drag
and focus regression controls. Tests are prepared for rig-opus batch 2;
typecheck and runtime results will be recorded after execution. Native
autoscroll/link behavior and popout input remain acceptance gaps until measured.
