# Panel activation

User ruling: 2026-10-18 12:09Z, docket
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
panel is available. Open actions keep an already top pin open; its own close and
unpin controls retain their explicit meanings. This replaces the earlier rule
that a second opener click closed a pin once it was on top.

Shared node menus may retarget their single panel of a kind and reveal its same
window; tabs do not retarget unrelated panels. Global header/switchboard opens,
node menu opens and panel-corner routes all reuse these activation paths.

Focused renderer evidence uses synthetic windows and real desk/menu/movable
surface components. It verifies registry routing, exact native focus command,
single window creation, retained DOM/draft, identity guards and shared pin
stacking. It does not claim an OS foreground-window observation. The native
restore/show/focus implementation is reused without changes.
