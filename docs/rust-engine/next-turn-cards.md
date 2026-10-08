# Queued next-turn cards

A queued account, model or effort change keeps the current card and adds
`next turn -> <target>` beside it. Ambient account aliases display as `default`.
Hover text is `<agent>'s <kind> will change from <current> to <next> next turn`.
These are the user's 2026-10-08 09:03-09:06Z rulings.

`canvas/nextturn.tsx` owns the card and tooltip. Model cards use `tierLabel`,
including the independent Antigravity labels. Account cards prefer the serving
turn's account when describing the current value. The shared desk covers
pinned and popped-out desks; their external model header suppresses the
inner duplicate. Existing map, tray and jump model indicators use the same card.

Effort changes have no persisted queue row. The actor publishes presentation
metadata `effort_current` and `pending_effort` for a running turn. The target is refreshed alongside the forecast when
settings are re-read, including agent retool and org-default edits, and only
when it differs from the process level. A successful live delivery is not described as deferred. Turn start,
turn end and idle snapshots clear the queued metadata. This changes no
launch, account-switch or effort-delivery behavior.

The zoom card retains the current effort while a target waits. A desk that
normally has no effort tag shows the current/next pair during that wait.
The renderer runtime overlay must admit both effort fields; otherwise the
engine evidence is dropped before it reaches the cards.

## Rig proof

`node tools/rig/rig.mjs run tools/rig/proofs/next-turn-cards.mjs --ui <bundle>`
uses two fake Codex accounts and a long-running Luna turn. It verifies the
current cards, all queued values and exact tooltip text, a retarget to default,
cancellation, the retool path, and the pinned header's single copy of each queued card. It
captures before/after desk and zoom-card PNGs under the rig evidence folder.
A long Antigravity target label also exercises wrapping; every zoom-card badge
and the agent name must remain inside the card bounds.
