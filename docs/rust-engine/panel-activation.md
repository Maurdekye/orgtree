# Panel activation

User rulings: 2026-10-18 12:09Z and 16:42Z, docket
`opening-an-already-popped-out-panel-inbox-docket` (4.4.0).

Opening an already detached panel reveals the same window. `windowlife` looks
up a live surface by kind and organization; a desk tab also requires the current
node and generation. `revealSurface` resolves the owning surface, whose existing
native `focusPopout` path restores a minimized window, shows it and focuses it.
No second window is created and the retained DOM, drafts and reader state stay
with the original surface. Closed registrations do not absorb an open action.

`revealOpenPanel` also handles mounted pins, using the existing modal store and
shared pin layer. A saved rectangle alone is not an open panel. Desk tabs leave
another node's pin alone and select their normal inline view when no matching
panel is available. Menus, explicit tab activation and pin/pop-out ensure-open requests
keep pins open. Their own close and unpin controls retain their meanings.

The 16:42Z ruling supersedes always-raise for panel buttons: the same button
hides its already open local pin, including a pin behind another panel. The next
click reopens at the saved rectangle. `toggleOrRaiseModal` applies this to the
global Inbox, Docket, Presentations, Usage, Usage history and Settings buttons;
Agents list and the org inbox use it too. App settings and defaults already
toggle their pins. `toggleNodePanel` shares that decision for node Inbox, Team,
Docket, Presentations, Settings, lineage and watchdog buttons. Another target or
scope retargets the existing panel; an ensure-open request never toggles it off.
Detached windows retain their existing restore/show/focus activation path.

Shared node menus may retarget their single panel of a kind and reveal its same
window; tabs do not retarget unrelated panels. Shell and node menus and
panel-corner routes pass ensure-open explicitly; header and card shortcut
buttons retain the toggle rule.

Focused renderer evidence uses synthetic windows and real desk/menu/movable
surface components. It verifies registry routing, exact native focus command,
single window creation, retained DOM/draft, identity guards and shared pin
stacking. It does not claim an OS foreground-window observation. The native
restore/show/focus implementation is reused without changes.
