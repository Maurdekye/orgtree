# Reopening organization windows

Every org window open at shutdown must return at the next ordinary startup,
at its saved placement. Deliberately closing one org while others remain
still removes only that org from the reopen set. Startup mode Homepage and
`--background` keep their existing behavior; background construction stays
hidden. A saved org that cannot load keeps its own org-bound error window.

The reported one-window restart had two source defects. All saved windows
were constructed with `show:false`, but only the first was revealed. Normal
Quit, installer shutdown, updater handoff and maintenance restart could
therefore preserve the full saved set while showing one window. Console
signal shutdown with a core lifecycle bypassed the normal capture and left
`quitting` false, so close callbacks removed orgs. Windows session shutdown
had no final-event handler to capture the set before close callbacks.

Startup now reveals every main window and then focuses the original first
window. A shared synchronous capture saves the current geometry and full
membership for Quit, updater handoff, successful installer shutdown, console
signals and final Windows `session-end`. The first final event latches
`quitting`; later events cannot replace the snapshot with a smaller set.
Installer refusal and cancelable `query-session-end` do not latch this state.
Engine-only restart keeps its existing window objects and membership.

Electron documents that Windows system shutdown/restart and logout skip
[`app.before-quit`](https://www.electronjs.org/docs/latest/api/app#event-before-quit).
The native [`session-end`](https://www.electronjs.org/docs/latest/api/browser-window#event-session-end-windows)
event is final; a `query-session-end` can still be cancelled. The capture
does not await renderer work or attempt to delay OS shutdown.

## Verification

Before the fix, rig-sol-b executed the tests-only `4c784f5` on product base
`b77512f`: 17 executed, 6 passed, 11 genuine assertion failures, no skipped
or cancelled tests, exit1. Normal routes failed visibility; signals and
final Windows teardown retained only the last org. All six controls passed.

`tests/org-reopen-routes.test.mjs` runs selected production shell callbacks
with the real placement JSON store in a synthetic host, using only the
assigned C build directory. The green suite adds repeated final-session
callbacks, synchronous geometry inspection before any close, and an
unavailable org window. Green and adjacent placement/window-close checks
ran through rig-sol-b on exact `6a4a009`: 19/19 route cases passed, no skips
or cancellations, exit0/1s. Root TypeScript had 0 diagnostics across 310
checkout files, exit0/6s. The exact source was approved for the release cut.

Five adjacent suites at `b77512f` and `6a4a009` each executed 109 cases:
108 passed and the same pre-existing source assertion failed. Its regex in
`multi-window-wiring.test.mjs` omits `coreStopRequested = true` from the
unchanged `stopCoreApplication` helper. Both narrow real Electron probes
(sender/popout/discard/placement and native popout bounds) passed at both
revisions. There was no new adjacent failure; the full adjacent run is not
claimed all-green. Initial dependency/resolver failures were preserved and
excluded from the final native execution evidence.

The route suite does not start Electron, an installer, an engine or a
provider. Actual installed Electron/NSIS/Windows event order, interactive
focus and on-screen geometry remain unmeasured. The updater case exercises
its actual pre-handoff capture block, not the full updater or an installer
process. The adjacent native probes cover their narrow fixtures rather than
the complete lifecycle routes.
