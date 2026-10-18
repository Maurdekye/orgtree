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

User follow-up, 2026-10-18 14:44Z: the inline agent/project desk Team tab puts
Active and its existing pin/pop-out/modal cluster in an in-flow toolbar above
the scrolling tray. The cluster keeps the shared button sizes and routes;
the filter uses the tray's full width, without a hard-coded corner margin.
This gives narrow desks a reserved control row and keeps controls off the
list's scrollbar. The centered/pinned Team panel still uses its frame header.
Both hosts use the same local list hook, current-feed membership and canonical menus;
there are no new reads or changes to membership, sorting or permissions.

Focused tests mount the actual canvas Agents panel beside `TeamModal`; the
synthetic Electron capture compares their computed chrome and displays both
pinned panels in one image. The same renderer checks the centered list is flat.
This does not establish native operating-system pop-out behavior.

`teamactions` controls and a synthetic four-pane capture cover normal/narrow
agent and project desks. The capture checks actual action/tray/filter bounds
and shared 14px button sizing, with a constrained flex host like the desk's
real placement.
