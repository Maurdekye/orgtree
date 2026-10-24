# Consecutive project bunches

User decisions, 2026-10-20 07:12–08:07 UTC: each maximal direct project-only run
becomes a tightly packed, roughly round serpentine. The 08:05 sketch feedback
replaces the initial tall spring links with short curves and an even small gap.
A split or intervening agent
ends a run; independent runs above and below it bunch separately. Singletons and
side-by-side projects retain the ordinary layout. Parent-to-child lines connect
the projects in actual order, using the ordinary superior/subordinate edge style.

Display > Desk > **Bunch consecutive projects** defaults on. Its profile-local
`orgtree-project-bunches` preference updates existing windows through the same-tab
subscription and storage events; off uses the original layout. It does not
change organization structure or any project setting.

Display > Desk > **Rearrange projects in a bunch** is a separate, default-off
setting (user 2026-10-20 09:15 UTC). The profile-local
`orgtree-project-bunch-rearrange` key uses the same same-tab subscription and
cross-window storage events. Off keeps ordinary whole-subtree dragging and
reparenting, even inside the bunch, with no bunch insertion point or identity
rotation. Turning it on enables the ordered insertion behavior below. Turning
it off during a drag hides the insertion marker and prevents a rotation on release.
Neither setting changes the other, and the rearranging preference only has an
effect while projects are displayed as a bunch.

`canvas/projectbunch.ts` checks physical child lists, with the hide-retired
exception described below. Pile compression never erases a structural
break. Layout contracts each run to a block, reserves its complete footprint,
and expands it into separate full-size card positions. Row and circular layouts,
fit, and the reparent landing ghost use the same projection. Card/desk identity,
menus, badges, colors, and far-zoom hit targets remain the existing components.

Retirement does not change those physical links. Loaded archived and partly
restored project columns use the same bunches (user bug report, 2026-10-20
18:37 UTC), with the same Display opt-out. Only the selected retired pile front's
visible chain contributes a bunch; changing fronts displays the newly selected
chain. While retired nodes are hidden, the detector ignores archived children
removed by that display projection and unloaded retired-child counts (user
2026-10-20 18:56 UTC). Shown retirees, knowledge bearers and archived parents
with live descendants still count as branches, as do siblings buried in a pile
when retired nodes are shown. The canvas and ordinary move landing ghosts pass
the same visibility setting to the detector. In a bunch, each project's retired
pill sits inside its own card so it cannot cover the next row; it opens the
existing bounded picker for that project.
This uses the existing bounded archive projection without reading more history.
The retired picker continues to list physical sibling roots separately, with
its existing cursor pages and search; siblings are never merged into a bunch.
Project rows use the shared folder badge. Its count says projects or agents only
when a complete unfiltered cohort is known; mixed or partially loaded cohorts
use the neutral "retirees", without fetching additional pages to infer their kind.
Project fronts use the same clickable stack layers and count as agent fronts.
Every project keeps its own desk and Restore action, which rehires that named
project, not the whole bunch.

In the circular chart a bunch is one entry on its ring with an arc slot for its
own block (user 2026-10-20 09:08 UTC). Every card's slot comes from its own
footprint, so ordinary cards beside a bunch keep the dense 190px pitch and their
arcs; a bunch, whole or either part of a split run, never spreads the rest of its
ring to its pitch or into the evenly spaced full circle. Ring radii still clear
the widest card on the ring and the one before it. A ring too full for an arc
grows until its mixed slots just close it. Rings of one card size keep the
original equal-step arithmetic, and spring settling centres each team on its
whole arc extent. Settling moves each run of leaf siblings as one block, so the
agents under a bunch stay one arc out to both ends (user report 2026-10-20 10:46
UTC; `ringteams.test.ts`, capture scene `ring-team-ends`). `bunchring.test.ts`
covers the review stacks split at stack16-11, a whole bunch on a busy ring and a
closing ring; the ring scenes of `projectbunch-visual.tsx` (page script
`projectbunch-ring-visual.cjs`) capture them with measured world spacing.

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

With rearranging enabled, dragging inside a wholly live bunch shows an insertion point and rotates the project
identities while retaining their settings and the bottom member group.
`projectbunchmove.ts` emits only existing `moves` (maximum 20 per batch) and
`reorder` steps, submitted together through one atomic `userGesture`.
Detach precedes insertion so every intermediate move is acyclic. The head keeps
the original outside sibling slot. A refusal removes the optimistic projection;
the successful gesture uses ordinary history undo. An incomplete or concurrently
split run is refused before writing. No project swap or backend operation is
added; swap remains agent-only.
An archived or partly restored bunch retains ordinary subtree dragging even
when rearranging is enabled. Existing move operations require live destination
parents, so these runs must not offer an insertion marker for an invalid rotation.
The same applies to a visual bunch joined across hidden archived side branches
or unknown children: rotation requires the complete physical run. Hiding a
retiree never moves it to a different parent.

Dragging out retains ordinary whole-subtree movement. Existing create-project-above
placement naturally extends a run above any project or above its sole bottom
agent. Above one of several children creates a split and does not extend the
upper bunch; a later direct run below that split can form a separate bunch.

Focused tests: `projectbunch.test.tsx` (shape, exact opt-out and break behavior,
Display persistence), `projectbunch-drag.test.tsx` (real canvas pointer gestures,
all insertion positions for 2–8 projects, atomic steps, rollback, cancel,
default-off ordinary dragging, same-tab/cross-window preference updates,
mid-drag opt-out, both insertion cases and split control).
`retiredprojectbunch.test.tsx` covers retirement/layout equivalence, selected
fronts, incomplete branches, partial restoration and individual restore targets;
the canvas drag suite also covers archived controls and the lazy pile picker.
`projectbunch-visual.mjs` captures the real renderer with synthetic data in
Session 0, including 2/3/5/7/8/12/20 projects, opt-out, breaks, far zoom, insertions and
reorder. It never opens or modifies live organization data.
`projectbunch-retired-visual.cjs` captures an archived front in row/circular
mode, Display opt-out, the sibling picker and another selected chain. It checks
the picker button's actual hit target as well as the rendered order links.
`hiddenretiredbunch.test.tsx` covers loaded/count-only hidden branches, shown
retirees, protected retired nodes and landing ghosts. The hidden-retired visual
fixture captures the three-project chain in row/circular mode and with retirees
shown, checking the pill's hit target, owner and bounded picker.
