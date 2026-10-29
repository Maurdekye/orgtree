---
name: orgtree-pinned-windows
description: Distinguish pinned, detached and temporary desk hosting and explain what close or return does to each surface.
---
Up: [orgtree-canvas](../SKILL.md)

# One desk, several placements

A desk can be hosted on the canvas, pinned in screen space, detached to another window or borrowed temporarily. These are placements of the canonical desk and composer, not independent copied conversations. A placeholder can indicate the desk is already open elsewhere; Show raises it. See [agent desk](../../desk/agent-desk/SKILL.md) for the contents of that desk.

## Pinned windows

Pinning makes a screen-space window that stays put while the canvas pans/zooms. Drag its title bar to move and its edges/corners to resize. Escape or lost pointer capture cancels a placement gesture without saving it. With snapping enabled, releasing near an edge snaps; Shift allows free placement. A plain activation of the agent name navigates, while a name drag moves the window.

The pinned desk's close/unpin control minimizes it back to its original desk. If that card is off-screen, the toast explains where to find it; Show on canvas navigates there while keeping the pin open. An archived agent's pin can remain readable. The title bar is not an instruction to rehire it.

Pinnable modal surfaces (Org settings, App settings, Usage, the inbox, docket and presentations among them) dismiss when Escape is pressed or the backdrop is clicked. Inside an organization each can be pinned or popped out and remembers its placement per organization; at home, with no organization to pin into, Usage and App settings are centred only. Their centered form has no separate close button. Once pinned, the surface is a window and keeps its Close control; detached windows use their native window controls. Pinning is disabled while detached; closing a pinned window dismisses the modal rather than merely changing its pin state. The related overlap/fade, snap and jump-fold choices are in [Display: desk and chart](../../app-settings/app-display-desk-and-chart/SKILL.md).

## Several windows of one kind

Surfaces that belong to one agent, project or watchdog open one window per target: Mail, Docket, Team, Slots, Listeners, Settings, a watchdog's detail, a project's desk window and the presentation readers. Opening the Team of a second agent opens a second window beside the first instead of replacing it; opening one that is already open brings it to the front, and an agent's own card button closes only that agent's window. Each target remembers its own place, pin and pop-out. A target opened for the first time pins where the kind was last pinned, moved or resized, stepped 28 px right and down past any window already there; if the kind was last unpinned it opens centred instead. Only one centred window of a kind is open at a time, so the next one replaces it. Placements of closed windows are remembered for the 20 most recent targets of each kind in each organization.

## Separate windows and Close

Open detached windows are never removed by placement-history limits, including
when other organizations save their windows. Closed detached placements keep
the newest 20 for each kind in each organization, just like modal pins. Older
saved records are migrated to their target before applying that limit.

A project's Open → Slots entry opens the canonical slot list as a modal, only
while capacity is positive. The slots tab's shared pin, pop-out and modal
shortcuts target that same panel. Its standard controls remember placement per
org and project generation, close it independently, and retain live holders,
line, history, agent links and age updates. If capacity becomes zero while it
is open, it shows a safe empty state. Agent data access already exists through
`orgtree_project action=slots name=<project>`; no new tool is needed to read it.

Open in new window detaches the mounted surface. Explicit Pop in/Return to main window brings it back. Native window Close dismisses a closeable modal instead of reopening it in the main window. Its existing draft-storage rules still apply; closing is not an automatic engine mutation or a promise that a form was saved.

A persistent desk keeps its canonical content. Native Close returns it only to an already connected destination; if none is mounted it stays retained off-screen until a real destination appears. It does not force navigation to create a missing main-view slot. Explicit return retains its normal destination activation. Failure recovery, parent-window lifecycle and temporary borrowing follow their own restoration paths; do not treat an accidental popup failure as a deliberate dismiss.

## Temporary Desk modal

Open → Desk borrows the existing desk into a modal for a glance without changing focus, adding a pin or saving a layout of its own. Closing by Escape or backdrop returns the desk to its prior placement, including its draft and scroll state. Actions inside are the real desk's actions, not a read-only replica. If a Pin control is offered, the user can deliberately turn this temporary view into a persistent pin.

A browser can block a requested popup and report an error; native focusing and screen placement also depend on the available desktop capability. These descriptions are source behavior, not evidence that a particular device/window arrangement has been visually verified.

## See also

- [orgtree-app-display-desk-and-chart](../../app-settings/app-display-desk-and-chart/SKILL.md)
