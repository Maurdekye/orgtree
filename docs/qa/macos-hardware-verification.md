# macOS hardware verification (VER-01)

ROADMAP's VER-01 requires: "A user can package, launch, and run a full agent
job on macOS... with no manual workarounds." No CI run can fully prove this —
it is a claim about real Apple Silicon hardware and Gatekeeper behavior, not
something `tests/acceptance/run_agent_turn.mjs` can observe from a build
machine. This checklist records that one verification step, the same way
PKG-03 (Phase 1) already documents a manual verification step for the same
reason (see docs/macos-first-launch.md).

The one pre-documented exception to "no manual workarounds" is the
right-click-to-Open Gatekeeper approval PKG-03 already documents — that step
is expected and pre-documented, not a silent workaround.

## Checklist

1. Build the unsigned, ad-hoc-signed `.app` per PKG-01 (`npm run package:mac`
   or `npm run package:mac:dir`).
2. Copy the built `.app` to a real Apple Silicon Mac (not the machine that
   built it — see docs/macos-first-launch.md's Flow 2).
3. Double-click the app. If Gatekeeper blocks it, follow the PKG-03-documented
   right-click-to-Open flow (docs/macos-first-launch.md, Flow 2's Recovery
   steps). This is the one allowed workaround — it is pre-documented, not
   silent.
4. Once launched, hire one real agent and send it one real task through the
   app's own chat UI.
5. Confirm the response and the `orgtree_chart` tool call are visible in the
   app.
6. Record pass/fail and today's date in the Result section below.

## Result

**Status:** PASS

**Date:** 2026-09-23

**Verified by:** WhoReallyKnowsAnything

**Notes:** Build d0bb47e (`npm run package:mac:dir`, ad-hoc signed, arm64), run on
the build machine (Apple Silicon), not a second Mac. The downloaded state was
simulated by setting com.apple.quarantine; the app launched (via `open`) from an
App Translocation path with no Gatekeeper block, although `spctl -a` reported
"rejected". A real Claude provider account was added, one agent was hired and
completed a real task; the reply and the `orgtree_chart` tool call were visible
in the app. Checklist step 2 (copy to a separate Mac) was not followed exactly.
