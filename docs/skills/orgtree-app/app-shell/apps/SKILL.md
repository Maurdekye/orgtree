---
name: orgtree-apps
description: Open Apps and saved panels, pin or pop them out, and inspect each copy's JSON state.
---

Up: [orgtree-app-shell](../SKILL.md)

# Apps and saved panels

Open **Apps** in the org header, beside Presentations. Open an app to reopen its
most recently used panel, or choose **+ New panel** for an independent copy. Saved
panels show Open/Closed; closing preserves their data until Delete. The catalogue
is paged: use More apps / More saved panels. These are provisional4.5.0 defaults
for the morning review, not additional user rulings.

The panel title has a menu, pop-out, screen pin and Close. Drag the title or
resize the corner. The menu offers State, Rename, Linked agents, Activity,
Permissions, Duplicate, Float, Pin to screen, Pin to canvas and Delete panel.
Screen pins stay in the viewport. Canvas pins pan and zoom with the chart; far
zoom shows an icon, and offscreen/hidden canvas panels suspend their HTML.
Returning from a pop-out restores its preceding placement for this session.
Stored placements and open copies are read again after restart. Reopen a panel
from Apps if its canvas position is outside the current view.

**State** shows editable JSON for this copy. Save checks the revision and refuses
a conflicting edit. Import replaces the editor text; Save commits it. Export and
Copy use that text. Reset loads the app's initial state into the editor; Save is
still required. State must be a JSON object, provisionally at most2MiB. Deleting
a panel removes its state/events. Manage app > Delete app and panels explicitly
removes the definition and all copies. Confirmations belong to Orgtree, outside
the HTML. Links identify up to64 live same-org agents and grant no authority.

The embedded app is opaque sandboxed HTML (allow-scripts only), with a restrictive
no-connect CSP and no engine credential. Its async window.orgtree API provides
state.get/set/patch/onChange, storage.getItem/setItem/removeItem/clear, on and emit.
State is independent per copy; merge patch null deletes a key. Agent writes and
new named events arrive through the host. Activity retains the latest256 events.
This slice refuses engine.call: permission-granted actions and app import/export
are following slices. Declaring a capability does not grant it. This is a host
prototype, not a complete custom-app feature.

Agent parity: orgtree_apps provides every saved lifecycle, placement, label,
link, state and event action above. Copy/export JSON are ordinary local file or
clipboard operations; drag/resize use panel_update placement. Apps-button/menu
visibility and far-zoom culling are display only. See orgtree-tool-apps
(orgtree-working > team).
