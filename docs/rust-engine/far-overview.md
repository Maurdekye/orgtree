# Far overview

User rulings, 2026-10-13 19:00?19:01Z: hide attached cards, simplify the
mailbox, hide the retired marker when Hide Retired is on, hide the infinite
switchboard credit bar, and colour agent left-edge accents by model.
Coordinator confirmed at 19:05Z that ?outbox? means the existing org inbox.

The existing `z < Z_MINI` tier (0.55) remains the only threshold. Watchdog
satellites and their wires, side presentation chips and the user
credit bar do not mount there. Hidden-retired tokens do not mount when
Hide Retired is on; the off setting preserves its current behaviour.
The mailbox keeps its location, hit area and opening callback, displaying
only an OutboxOutlined tray glyph with an accessible org-inbox label.
Model colour is the existing `--tier-accent`, falling back to
`--provider-accent` for unknown tiers; normal zoom is unchanged.

Sent-file download cards belong to the separate deliveries/desk feed, not the
canvas side-chip surface; the normal mini desk exclusions already apply.
Tree data and open document/watchdog panels are retained; no dismiss action
is invoked. Zooming back in remounts the same attachment surfaces. Agent
hire controls and far status indicators retain their existing behaviour.

Verification pending shared queue; no packaged application claim.


## Verification fixture corrections (2026-10-13)

The shared batch root typecheck and 14 focused tests pass. Visual acceptance
is still pending. The original synthetic camera aimed at x=450 rather than
the canvas's fixed x=6000 eye anchor, so agent/watchdog cards were culled.
The corrected fixture derives its camera from EYE_ANCHOR_X and NODE_W.
Opening the mailbox also queried `/transfers`; its generic fake reply lacked
`transfers`, causing TransferPanel to throw. The fixture now returns the
actual empty-transfer schema. A local WebSocket stub prevents real DNS or
transport attempts. These changes affect proof data only; no product API
or rendering semantics were changed. The baseline reverses only this item's
rendering hunks in current combined source, preserving other batch work.

Round 431 passed 14/14 focused tests and 12/16 browser cases. The four
remaining failures were the proof's rapid zoom clicks: each HUD click starts
a 220 ms animation, and the next click cancels it from its intermediate zoom.
The proof now waits for each intended scale in the real `.space` transform,
records every step and both restored/far measurements, and explicitly checks
that the round trip crosses Z_MINI. Acceptance still requires the full 16-case
rerun by rig-opus. The Python proof is committed in renderer/tests; the shared
D:/orgtree-work/far-overview-proof.py copy is identical. No product change.
