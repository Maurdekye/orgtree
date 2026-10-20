# Consecutive project bunches

User decisions, 2026-10-20 07:12–08:07 UTC: each maximal direct project-only run
becomes a tightly packed, roughly round serpentine. The 08:05 sketch feedback
replaces the initial tall spring links with short curves and an even small gap.
A split or intervening agent
ends a run; independent runs above and below it bunch separately. Singletons and
side-by-side projects retain the ordinary layout. Parent-to-child lines connect
the projects in actual order, using the ordinary superior/subordinate edge style.

Display > Desk > **bunch consecutive projects** defaults on. Its profile-local
`orgtree-project-bunches` preference updates existing windows through the same-tab
subscription and storage events; off uses the original layout. It does not
change organization structure or any project setting.

Display > Desk > **rearrange projects in a bunch** is a separate, default-off
setting (user 2026-10-20 09:15 UTC). The profile-local
`orgtree-project-bunch-rearrange` key uses the same same-tab subscription and
cross-window storage events. Off keeps ordinary whole-subtree dragging and
reparenting, even inside the bunch, with no bunch insertion point or identity
rotation. Turning it on enables the ordered insertion behavior below. Turning
it off during a drag hides the insertion marker and prevents a rotation on release.
Neither setting changes the other, and the rearranging preference only has an
effect while projects are displayed as a bunch.

`canvas/projectbunch.ts` finds runs against the full physical child lists,
including hidden-retired counts. A display prune must not erase a structural
break. Layout contracts each run to a block, reserves its complete footprint,
and expands it into separate full-size card positions. Row and circular layouts,
fit, and the reparent landing ghost use the same projection. Card/desk identity,
menus, badges, colors, and far-zoom hit targets remain the existing components.

In the circular chart a bunch is one entry on its ring with an arc slot for its
own block (user 2026-10-20 09:08 UTC). Every card's slot comes from its own
footprint, so ordinary cards beside a bunch keep the dense 190px pitch and their
arcs; a bunch, whole or either part of a split run, never spreads the rest of its
ring to its pitch or into the evenly spaced full circle. Ring radii still clear
the widest card on the ring and the one before it. A ring too full for an arc
grows until its mixed slots just close it. Rings of one card size keep the
original equal-step arithmetic, and spring settling centres each team on its
whole arc extent. `bunchring.test.ts` covers the review stacks split at
stack16-11, a whole bunch on a busy ring and a closing ring; the ring scenes of
`projectbunch-visual.tsx` (page script `projectbunch-ring-visual.cjs`) capture
them with measured world spacing.

Packing starts with `ceil(sqrt(count))` rows. Circle-chord weights allocate the
exact number of cards using largest remainders, with stable row-index tie breaks.
Rows are centred, then staggered by one third of the card pitch when they would
otherwise align. The stagger goes toward the previous row's exit so the turn
stays short. Every horizontal neighbour and overlapping neighbouring row has
8 world pixels of clearance. Alternate rows run in opposite directions; the
last project is always in the bottom row. This fills the blob instead of drawing
long links across an empty middle. Row count grows with the bunch, preserving
its round outline. Work is linear in the number of cards plus sorting the small
row list, and identical inputs give identical positions.

Links join the nearest rectangle edges with a small cubic bend, sharing `.edge`
colour, width and opacity. Drag insertion chooses the nearest gap along this
ordered path, including reversed rows, rather than sorting by horizontal position.

With rearranging enabled, dragging inside a bunch shows an insertion point and rotates the project
identities while retaining their settings and the bottom member group.
`projectbunchmove.ts` emits only existing `moves` (maximum 20 per batch) and
`reorder` steps, submitted together through one atomic `userGesture`.
Detach precedes insertion so every intermediate move is acyclic. The head keeps
the original outside sibling slot. A refusal removes the optimistic projection;
the successful gesture uses ordinary history undo. An incomplete or concurrently
split run is refused before writing. No project swap or backend operation is
added; swap remains agent-only.

Dragging out retains ordinary whole-subtree movement. Existing create-project-above
placement naturally extends a run above any project or above its sole bottom
agent. Above one of several children creates a split and does not extend the
upper bunch; a later direct run below that split can form a separate bunch.

Focused tests: `projectbunch.test.tsx` (shape, exact opt-out and break behavior,
Display persistence), `projectbunch-drag.test.tsx` (real canvas pointer gestures,
all insertion positions for 2–8 projects, atomic steps, rollback, cancel,
default-off ordinary dragging, same-tab/cross-window preference updates,
mid-drag opt-out, both insertion cases and split control).
`projectbunch-visual.mjs` captures the real renderer with synthetic data in
Session 0, including 2/3/5/7/8/12/20 projects, opt-out, breaks, far zoom, insertions and
reorder. It never opens or modifies live organization data.
