---
name: orgtree-apps
description: Open Apps and saved panels, pin or pop them out, and inspect each copy's JSON state.
---

Up: [orgtree-app-shell](../SKILL.md)

# Apps and saved panels

The header Apps button counts new apps with the unread attention-mail highlight.
Each new menu entry is marked New. Only entries visible in the menu clear from
the count; scrolling and More apps expose the rest. Labels remain for that visit.
Seen status is stored per org across restarts. Existing apps start new once when
this feature is added. Provisional choice: your own imports also count as new.
Updating a definition does not mark it new again. Agent parity is orgtree_apps
list (is_new/new_count) and mark_seen with explicit apps:[id,...], up to200 IDs.

Open **Apps** in the org header, beside Presentations. Open an app to reopen its
most recently used panel, or choose **+ New panel** for an independent copy. Saved
panels show Open/Closed; closing preserves their data until Delete. The catalogue
is paged: use More apps / More saved panels. These are provisional4.5.0 defaults
for the morning review, not additional user rulings.

An unpinned panel opens as a standard centered modal, with pop-out, screen pin
and Close. The gears in the panel frame and Apps list open App settings directly,
without a dropdown. Its App section contains permissions, export and app deletion.
This panel lists State, Rename, Linked agents, Activity, Duplicate, Float, Pin to
screen, Pin to canvas and Delete panel, with a saved-copy selector and paging.
Manage a closed copy here without running it. Float returns to the centered
modal; pinning fixes the current position. Drag a pinned title or resize its corner.
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
The SDK exposes fixed permission-checked actions through orgtree.call. Apps
supports whole-app import/export, with grants starting at Ask. Declaring a
capability grants nothing. Native frames, settings, import/export and permission
prompts use Orgtree's existing modal/settings design system outside app HTML.

Agent parity: orgtree_apps provides every saved lifecycle, placement, label,
link, state and event action above. Copy/export JSON are ordinary local file or
clipboard operations; drag/resize use panel_update placement. Apps-button/menu
visibility and far-zoom culling are display only. See orgtree-tool-apps
(orgtree-working > team).
