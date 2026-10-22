# Queued next-turn badges

For the shared term, see the [badge definition](../skills/orgtree-app/desk/agent-desk/SKILL.md#badges).

A queued account, model, effort or speed change keeps the current card and adds
`next turn: <target>` in the badge rows below the status. The current model
chip and name keep the title line to themselves (user ruling 09:49Z).
Ambient account aliases display as `default`.
Hover text is `<agent>'s <kind> will change from <current> to <next> next turn`.
These are the user's 2026-10-08 09:03-09:06Z rulings.

User 2026-10-19 13:39Z: all four pending badges are grouped together in the
agent desk header (including pinned and popped-out desks) and the near-zoom
canvas badge row. None appears in the message box. The composer retains its
speed and effort controls. Targets and tooltips still use the shared
`NextTurnBadge`; reverting, applying or clearing the pending metadata removes
the corresponding badge without leaving a duplicate in another surface.

User 2026-10-19 13:46Z: a queued control shows the requested value in the
pending shade. Its hover names the current value as well as the queued target.
The shared header badge says `next turn: <value>`.

`canvas/nextturn.tsx` owns the badge and tooltip. Model badges use `tierLabel`,
including the independent Antigravity labels. Account badges prefer the serving
turn's account when describing the current value. The shared desk covers
pinned and popped-out desks, including their queued-model badge row. Existing
map, tray and jump model indicators use the same badge.

Effort changes have no persisted queue row. The actor publishes presentation
metadata `effort_current` and `pending_effort` for a running turn. The target is refreshed alongside the forecast when
settings are re-read, including agent retool and org-default edits, and only
when it differs from the process level. A successful live delivery is not described as deferred. Turn start,
turn end and idle snapshots clear the queued metadata. This changes no
launch, account-switch or effort-delivery behavior.

The zoom card retains the current effort while a target waits. A desk that
normally has no effort badge shows the current/next pair during that wait.
The renderer runtime overlay must admit both effort fields; otherwise the
engine evidence is dropped before it reaches the badges.

## Rig proof

`node tools/rig/rig.mjs run tools/rig/proofs/next-turn-cards.mjs --ui <bundle>`
uses two fake Codex accounts and a long-running Luna turn. It verifies the
current badges, all queued values and exact tooltip text, a retarget to default,
cancellation, the retool path, and the pinned header's single copy of each queued badge. It
captures before/after desk and zoom-card PNGs under the rig evidence folder.
A long Antigravity target label also exercises wrapping; every zoom-card badge
and the agent name must remain inside the card bounds.

The driver matches the signed colon label exactly, including default-account
targets and current-to-target tooltips, and opens the shared Open → Desk as a
pinned window action for its pinned-header control. Each semantic and layout guard is saved
in the stage's `checks.json` and recorded as a named `Proof.check` in the proof's
`result.json`. A setup or desktop-driver error records a durable FAIL; a driver
completion without counted guards cannot pass. This proof uses synthetic
accounts only. [verified: `tools/rig/{proofs/next-turn-cards.mjs,desktop/next-turn-cards.cjs}`;
2026-10-22]
