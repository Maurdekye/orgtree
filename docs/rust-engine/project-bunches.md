# Consecutive project bunches

User decisions, 2026-10-20 07:12–07:25 UTC: each maximal direct project-only run
becomes a roughly round, compressed-spring zigzag. A split or intervening agent
ends a run; independent runs above and below it bunch separately. Singletons and
side-by-side projects retain the ordinary layout. Parent-to-child lines connect
the projects in actual order.

Display > Desk > **bunch consecutive projects** defaults on. Its profile-local
`orgtree-project-bunches` preference updates existing windows through the same-tab
subscription and storage events; off uses the original layout. It does not
change organization structure or any project setting.

`canvas/projectbunch.ts` finds runs against the full physical child lists,
including hidden-retired counts. A display prune must not erase a structural
break. Layout contracts each run to a block, reserves its complete footprint,
and expands it into separate full-size card positions. Row and circular layouts,
fit, and the reparent landing ghost use the same projection. Card/desk identity,
menus, badges, colors, and far-zoom hit targets remain the existing components.

Inside a bunch, dragging shows an insertion point and rotates the project
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
cross-window preference updates, both insertion cases and split control).
`projectbunch-visual.mjs` captures the real renderer with synthetic data in
Session 0, including 2/3/5/8 projects, opt-out, breaks, far zoom, insertions and
reorder. It never opens or modifies live organization data.
