# Desk-tab window origins

User ruling, 2026-10-19 13:32Z: pin or pop-out pressed on an inline agent or
project desk tab starts at that tab content's on-screen position and size.
The same buttons in the separate modal continue using the modal's own box.

`PanelCorner` measures its closest `.desk-tabpanel` before `show()` can replace
the tab. The existing shared request channel carries a one-shot rectangle and
owning window through a delayed modal mount. A new pin translates that box to
the frame's viewport/canvas coordinates, then uses the existing minimum and
visible-area clamp. The coordinator's 13:38Z edge-case ruling explicitly keeps
those minimums: a small tab does not create a smaller-than-minimum pin, and no
pin persistence format changes.

For a new pop-out, `MovableSurface.openFrom()` uses the source window's opener
and exact client rectangle. The native handler maps through content origin,
browser zoom and display DPI, then fits the resulting bounds to the matching
display's work area. Its clamp flag is specific to this tab request; ordinary
modal pop-outs, lifecycle restores and existing exact temporary-desk launches
keep their current behavior. The source override is never retained for a later
modal-button press or saved as a separate preference.

All current button-bearing desk surfaces share this path: inbox, docket,
presented documents, Team, and project Slots. Listeners currently has no such
buttons; this change adds none. Already detached surfaces still raise their
existing window; an existing pin's corner button still unpins it. A missing or
zero-size tab host falls back to the established modal measurement.

Focused renderer tests cover every current kind/action request, delayed mount,
source snapshot timing, pin minima/canvas offsets/clamping, exact popup client
features and subsequent modal-origin preservation. Native-boundary controls
exercise the request-only work-area clamp with a synthetic monitor inventory.
The Electron fixture mounts actual agent/project desks and their Team modal,
measures new pins/pop-outs against tab bounds, and records a screenshot. Its
native minimize/maximize commands are stubs; no live app install or acceptance
is implied.
