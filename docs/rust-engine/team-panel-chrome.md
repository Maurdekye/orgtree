# Team panel chrome

User ruling, 2026-10-18 14:22Z, Orgtree 4.4.0: pinned Team and Agents
panels share the same frame, filter, Active control placement, rows and scrollbar.
Only their heading and scoped content differ. The centered Team panel also loses
its bottom Close button and the inner list border/padding.

`TeamModal` uses `PinFrame` with `tray-panel`, a direct `AgentTray` child and
`ActiveAgentsFilter` in `headerActions`, just as the canvas Agents panel does.
The old settings wrapper and nested Team list box no longer apply. The shared
frame's pin, pop-out, backdrop and Escape behavior stays in place. Pinning and
unpinning keep the same list/filter DOM and local filter state.

The inline desk Team tab keeps its existing filter-row Active control. Both
hosts use the same local list hook, current-feed membership and canonical menus;
there are no new reads or changes to membership, sorting or permissions.

Focused tests mount the actual canvas Agents panel beside `TeamModal`; the
synthetic Electron capture compares their computed chrome and displays both
pinned panels in one image. The same renderer checks the centered list is flat.
This does not establish native operating-system pop-out behavior.
