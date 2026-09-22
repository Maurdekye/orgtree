# Whole-App Electron composition probe

Run from the repository root:

```text
node tools/run-app-composition-probe.mjs .probe-app-composition baseline
node tools/run-app-composition-probe.mjs .probe-app-composition first-use
node tools/run-app-composition-probe.mjs .probe-app-composition no-bus
node tools/run-app-composition-probe.mjs .probe-app-composition no-readiness
node tools/run-app-composition-probe.mjs .probe-app-composition no-lifecycle
node tools/run-app-composition-probe.mjs .probe-app-composition no-compact-header
```

Each invocation creates a fresh child directory, Electron profile and Preferences
file. It records source identity, complete Electron logs, HTTP requests, assertion
details and screenshots there. It never deletes a caller's directory and does not
start the engine or installed application. A negative control deliberately exits
nonzero; inspect the named failures, rather than treating any failure as success.

`electron-outcome.json` separately records the raw Electron `spawnSync` status,
signal and spawn error under schema `orgtree.app-composition-process/v1`.
Consumers must require status 0 for the baseline or 1 for an intended negative,
with null signal/error, alongside the exact assertion results. The CLI retains
its existing pass/fail exit convention: exit 1 alone does not distinguish an
expected assertion failure from an unexpected child exit after writing a receipt.

## Shipping paths exercised

The renderer entry is the unmodified shipping `renderer/src/main.tsx`, built with
production React just as the shipping Vite build does. It starts the real held-event
bus and mounts the real App, callbacks, panels and CSS. The production preload is
bundled without substitutions. The main fixture imports production held-event IPC
registration, sender/route/token guards, organization registry and open-org
decisions, outbox, document lifecycle, load recovery, popup policy and Preferences.

The assertions cover cold and navigation-time exact Presentations targets;
Homepage/Create identity and paths despite a saved legacy org; Create errors,
dirty publication and successful binding; shared persisted settings in two live
windows with independent modal visibility; keyboard menus; header geometry at
640 and 1180 pixels, including expanded and halted kill-switch states; actual
Attention/Desk/pin/popout interactions and mixed-row mutations; and three distinct
org windows with independent camera/mode and synthetic WebSocket updates while
unfocused, including two surviving windows after the third closes.

The baseline also drives first-use onboarding through real creation, hire-token,
name, Hire and chat controls. `first-use` runs that slice plus the cold-reveal
prerequisite alone. It checks empty existing orgs, failed creation/hire/message,
cleared names, canceled/reloaded drafts, the actual unobstructed token geometry,
and completion surviving a new native window. HTTP results remain canned; no
provider agent is hired or messaged. The tutorial stores UI progress per org in
the current browser profile and begins only after the actual Create form succeeds.

Two different terminal loads are exercised: failure before document commit, and
an HTML response that commits then truncates its advertised Content-Length. Each
must reach the production holding page, preserve its target and reveal that exact
document after the holding page's actual Refresh control is used.

## Boundaries

This does **not** launch `main/index.ts`. The fixture owns window construction and
IPC bindings other than the imported held-event channels. In particular,
Preferences read/write/broadcast IPC, request-org/adopt-identity glue, Create and
dirty-state bindings, window close/refresh and popout action bindings are fixture
code using the production helpers. Remaining status reads are canned. This proves
those shipping modules compose with the App, not that all production startup and
IPC glue executed.

Main BrowserWindows are offscreen, frameless and have background throttling
disabled. Rendered DOM geometry, screenshots and Chromium keyboard events are
measured; no claim is made about OS dialog display or OS notification dispatch.
Create cancellation checks a real registry decision, not a native confirmation
dialog. The HTTP data and WebSocket frames are synthetic, not a running engine.
The camera independence case uses the existing no-intro preference so it does not
mistake the intentional startup glide for a cross-window camera change.

Development React StrictMode effect replay is a separate configuration. This
probe's production build does not establish development-mode buffering behavior.
No installer, updater, public release, restart, crash restoration or live user
data is exercised.

## Discriminating controls

* `no-bus` removes only `startHeldEvents()` at build time. `cold-visible-exact`
  must fail while the cold event was demonstrably queued.
* `no-readiness` blocks both readiness IPC paths at registration time.
  `cold-visible-exact` must fail and the held event must remain pending.
* `no-lifecycle` omits the production document lifecycle attachment.
  `reload-visible-exact` must fail after an actual navigation start and before
  commit; a new document alone is insufficient.
* `no-compact-header` removes only the shell's compact-header CSS rule at build
  time. The narrow-header geometry checks must fail, with screenshots showing
  the lost title and overlap. Wider layout and unrelated scenarios must pass.

The main-owned scenario context exposes windows, evaluation, assertions and
stacked HTTP/upgrade handlers. The Attention and multiwindow modules use those
seams for canned server state; they do not replace App callbacks. `until` returns
the last observed value on timeout, so callers must assert the accepted condition
or throw for missing prerequisites.
