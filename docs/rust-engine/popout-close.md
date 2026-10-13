# Close versus Pop in

The user approved this behavior on 2026-10-13 08:22 UTC: closing a popped-out
window must dismiss the modal instead of reopening it in the main window.
Explicit Pop in continues to return the same mounted content.

`MovableSurface` distinguishes the native child pagehide/closed-window poll
from `redock`. `PinFrame` supplies its existing owner `close` callback. Native
Close invalidates the detach transaction, closes the saved row without erasing
its geometry, disposes listeners/timers/registrations, adopts the content into
the main document offscreen and calls that callback once. It never places the
modal into its main destination. Existing owner close/draft storage rules
still apply; this path neither clears form content nor performs engine writes.
Native header Close reaches the existing desktop bridge; OS window closure
and keyboard window closure reach the same child lifecycle path.

The other production caller, `DeskHost`, owns persistent shared desk content.
Coordinator ruling 08:26 UTC: retain that registry and content. Native Close
returns content to an existing registered destination, but does not invoke
the no-slot `onJump` main-view activation. If no destination is connected, keep
the same composer mounted offscreen until a real slot registers. Do not create
a visible emergency recovery box on this Close path. Explicit Pop in retains
its existing destination activation. No new desk deletion/hiding policy is
introduced.

Keep these existing paths distinct:

- Temporary borrowing uses `returnHome(true)` and its mutually exclusive
  restore/release handle; it retains the open row and exact placement.
- Failure recovery returns the content, closes the saved row and reports the
  failure. All four established failure routes still use `recover`.
- `returnWindows`, organization transitions and explicit return controls use
  ordinary redock.
- A modal hosted in another window still returns before that parent unloads.
- Main-window exit uses the existing exit latch and restoration path; it does
  not dismiss the owning modal or mark the saved arrangement closed.

## Verification

Focused `popoutclose.test.tsx` exercises production `PinFrame`, `DeskHost` and
`MovableSurface` with a second DOM document and a synthetic desktop bridge.
Controls cover header Close, pagehide, closed polling, explicit Pop in, saved
geometry, retained draft content, temporary borrowing, main exit, returnWindows
and hosted-parent recovery. The desk control removes every slot while detached,
checks native Close does not activate a destination, and registers a real slot
again to verify the same composer returns. The explicit-return positive checks
the original activation remains. Existing popout recovery, aspect, modal pin
and Attention header suites provide focused regression controls.

These are production renderer paths with synthetic window events, not evidence
of installed Electron or real OS keyboard dispatch. No engine, live-data,
application build or install is required by this change. Exact counts and
predecessor comparison are recorded with the coordinator hand-in.

Measured on 2026-10-13 at desktop source `5ef4cae`: the same five focused
suites ran 59 tests on predecessor `d3de2dd` (55 pass, four targeted Close
failures) and on the corrected source (59 pass; zero failed, skipped or
cancelled). Typecheck passed. The new setup-loss control confirms a child lost
before detach commits still follows failed-open recovery, rather than dismissing
its modal. Tests/bundling used a shared machine slot and a 4096 MB, 150-second
Windows Job. Existing modal-pin act warnings are present on both snapshots;
they are not represented as an error-free console. No native OS close/key
dispatch, installed application or application build was exercised.
