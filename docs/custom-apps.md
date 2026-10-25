# Custom apps and panels

An app is a small HTML program kept by one organization. A panel is one saved
copy with its own label and JSON data. Closing keeps it; deleting removes it.
Definitions and committed data live in Orgtree's database across restarts.

Open **Apps** beside Presentations in the org header. Clicking an app reopens its
most recently used copy or creates the first one. **+ New panel** makes another
copy from the initial state. Open and closed saved panels are listed below it.
These defaults are provisional for the morning review.

Use the panel title menu for State, Rename, Linked agents, Activity, Permissions,
Duplicate, placement or Delete. Drag the title or resize its corner. Float and
Pin to screen stay in the viewport; Pin to canvas moves and zooms with the chart.
Far zoom shows an icon, and hidden canvas HTML pauses until visible again.
The title's pop-out opens a separate window; Return restores its previous place.

State opens editable JSON. Import changes the editor, Export saves it and Copy
copies it. Reset loads initial data; Save is needed to commit either change. A
concurrent edit reports a conflict. Each copy has its own data. A panel's recent
Activity retains256 events. Linked agents can interpret/update any copy in this
org with Org-modifying tools; linking does not grant permission.

Apps are opaque sandboxed HTML, with no engine credential or same-origin access.
The current prototype provides saved state and named events, and refuses engine
actions. Per-app permission prompts and app import/export follow in later slices.
Declaring an engine capability does not grant it. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps for the same lifecycle, placement, link, state and event
controls. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Copy/export JSON use ordinary local clipboard/file actions.
