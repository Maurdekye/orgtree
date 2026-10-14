# Closing a competing desk host

When the pinned Agent desk in Attention shows an agent, opening the same
agent in the switchboard moves the shared desk there. Closing that switchboard
copy must immediately restore the live desk to the eligible remaining slot.
No click is needed and that slot must not show a placeholder beside the desk.
This is the user's report of 2026-10-14 18:36 UTC.

`Desks.remove` already defers empty-host disposal until the current React
commit ends so a slot migration can reuse the host. At that same boundary it
now resolves the remaining owner through `pick` before publishing a revision.
Previously the subscribed slot could render its placeholder using the departed
owner, then `DeskHost` changed ownership during that render and physically
adopted the desk into the same slot. That second assignment published no
revision. The Attention desk's flex layout then divided its width between the
stale placeholder and the returned desk until another interaction rendered it.

This resolution is triggered by unregistration. Ordinary prop updates still
do not claim the desk; a competing registered owner remains the incumbent.
The existing eligible-slot order, borrowing restore/release, detached ownership,
generation identity and commit-time migration rules are retained. No new CSS,
pin geometry, native Close activation or engine behavior is introduced.

## Verification scope

`attentiondeskreclaim.test.tsx` mounts the real pinned Attention panel, opens
an ordinary switchboard desk slot and removes it without refreshing the
Attention element. It checks that the same composer and unfinished draft
return, the placeholder disappears, and only one composer exists, twice.
A second control starts with an earlier hidden slot and confirms owner removal
publishes the eligible remaining owner and its matching placeholder state.
The unchanged element references prevent incidental prop updates from repairing
the bug. DOM identity assertions use booleans to avoid huge failed DOM reports.

The isolated `tools/rig/desk-reclaim-visual.mjs --out <artifact-folder>` fixture
uses the same pinned Attention panel and ordinary shared desk slot, with fake
fetch responses and blocked external requests. It saves light/dark open and
closed captures and measures placeholder count, composer identity/count and
returned desk width. Run on both the tests-only predecessor and the corrected
tip for before/after evidence. It never launches an engine or connects a real
organization. Regression checks include `deskowner`, `attentionpopout`,
`popoutclose` and `tempdesk` so the ownership and native-window rules stay
distinct. Rig-opus runs these in the shared batch; author syntax/whitespace
checks are not test execution or pixel evidence. Counts, screenshots and
remaining limits belong to the docket evidence after the batch completes.
