# Team in agent and project desks

User scope, 2026-10-18 10:53–10:56 UTC, 4.4.0 only: both desks offer a Team
tab containing the node itself and every descendant. It is the existing
`AgentTray`, including its hierarchy, ghost ancestors, text filter, Active
checkbox, archived toggle, row status and canonical node menus. Membership is
derived from parent edges in the current shared feed map, with a visited set;
opening Team starts no node reads or independent polling.

The canvas supplies its Agents List comparator and navigation to the shared
view. Thus row activation also exposes hidden pile members through the existing
`goToAgent` route. Standalone component hosts retain their supplied navigation
and source hierarchy order. A project's own row follows the existing list's
project presentation.

`agent-team` is a normal `PinFrame` surface. The tab's `PanelCorner` delegates
pin, pop-out and standalone opening to it. The existing modal and window stores
retain its organization, node, generation and geometry; restoration uses the
same generation check as inbox and docket windows. No native window lifecycle
is reimplemented. Agent/project Open menus offer Team beside other desk views;
the switchboard menu opens the global Agents list.

Focused author verification: the pre-implementation file at `54e6d4b` measured
five tests: one preservation pass and four intended failures (missing agent and
project tabs and menu entries). Final verification runs only the Team-focused
file and one synthetic dark project-desk capture. The final file also exercises
the real canvas's switchboard-to-global-list route. Native multiwindow behavior
and restart restoration rely on the existing shared components; the focused
checks do not claim an installed-app or native restart proof.
