# Presets unavailable on this machine

The New organization starting-layout list keeps its existing filename order.
That is the template folder's stable, user-visible ordering key, so unavailable
presets are not moved to a second group.

For a valid preset, the engine uses the existing staffing offers and default
template plan, including each slot's fallbacks. A nonempty plan is unavailable
here only when no slot has an offered tier and the first sign-in check has
finished. A partial plan stays normal; invalid template files retain their
existing disabled validation state. Checking and unknown availability are
never presented as confirmed unavailability.

`GET /api/templates?name=...` adds an optional availability summary per valid
preset and the existing checking flag. The name uses the same slug/account
context as the selected preview. It computes offers once for the whole list;
there is no sign-in probe or preset-by-preset HTTP fan-out. The renderer rereads
after Reload or a name change, and asks again while the first check is pending.

An unavailable unselected preset is a single dimmed name/reason row. It remains
an enabled choice. Selecting it expands the existing plan and model selectors,
with a warning: its agents cannot be hired unless their models are changed.
The selected row and this all-unavailable warning follow the current edited
plan; once any slot is offered the warning clears. Remaining blocked slots
keep the existing per-slot notes and creation gate, so a partially repaired
layout cannot accidentally be created while an agent is still blocked.

User requirement: 2026-10-14 17:56:42Z. Verification hand-in includes one engine
summary/plan matrix (none, partial, fallback, checking, invalid/empty), six
renderer cases, and a standalone fake-data visual surface. The renderer red
control is the tests-only commit on the original base; expected red is three
named failures and three passes, green six passes. The visual runner captures
dark/light list and selected-warning states and writes a JSON receipt. These
checks await rig-opus's batch; no owner compilation, test, capture, app build,
install, push or live-provider work has been performed.

Run the capture under the batch's containment/queue with an empty assigned C:
artifact folder:

```text
node tools/rig/template-availability-visual.mjs --out <assigned-C-folder> --deps-root <existing-node_modules> --electron <electron-binary>
```

It bundles only the test fixture, uses a private Electron data/session folder
inside the artifact folder, intercepts all fetches with fake presets, and blocks
network requests. It creates four PNGs and `result.json`, then exits. No
dependency copies or source junctions are created. Inspect the PNGs as well
as the receipt; this is a synthetic UI check, not installed-app acceptance.
