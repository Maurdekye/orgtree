# Tray list toggle

The primary tray click toggles the org activity list. Pending activity reads count
as open intent: another click cancels the read, and its late result cannot create
a popup. Every close invalidates the request generation. A loading popup also
closes immediately, and a late HTML load cannot show the destroyed window.

Windows can blur the list before delivering the tray click. A blur with the cursor
inside the current tray icon bounds records a monotonic timestamp; one click
within 250 ms consumes that dismissal instead of opening another list. Other
blur locations do not arm suppression, and old timestamps do not eat later
independent clicks. This short event-ordering guard is independent of the time
between the first and second clicks. macOS/Linux retain ordinary blur handling.

Escape and org selection dismiss the list. Double-click retains the existing
open-app behavior and invalidates pending reads. Late blur/closed events from an
old popup cannot dismiss a replacement. The popup retains its capability-free
sandbox and cancelled-navigation selection mechanism.

`tests/tray-toggle.test.mjs` executes the actual main-process closure and tray
event handlers with fake Electron objects and deferred engine/HTML responses.
It covers toggle, cancellation, stale callbacks, dismissal and double-click;
the companion tray-list tests cover content, geometry and routing. These checks
do not establish installed OS event timing or native tray interaction acceptance.
