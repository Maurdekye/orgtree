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
The host provides saved state, named events and permission-checked engine actions.
App import/export follows in a later slice.
Declaring an engine capability does not grant it. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps for the same lifecycle, placement, link, state and event
controls. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Copy/export JSON use ordinary local clipboard/file actions.

The action bridge accepts only declared capabilities with your permission; apps
cannot grant their own permissions. The native App permission prompt shows the
app, saved copy, capability and exact action as text. Allow once applies to that
one action. Always allow and Deny save a decision for every copy. Cancel or Escape
discards the request without changing permissions. Requests expire after two
minutes and are not retried automatically. In the title menu, Permissions offers
Ask, Allow and Deny per declared capability; changes save immediately without
reloading the app. These defaults are provisional. Replacing app code clears old permissions.
App messages identify the app and copy, and carry app content rather than user
instructions or approvals. No permission travels in an exported app.

The HTML API is `orgtree.call(action, args)`. Available actions are `org.read`
(paged chart metadata), `mail.send` (live local agent), `docket.create` (a new open
item), and `events.fire` (an app event for a live local agent). It cannot act as
you, choose another panel, call arbitrary engine routes, or approve work. Hiding,
closing or replacing a panel discards its host session and pending prompt.

The provisional `docket.write` permission lets an app create and assign a new
open item and wake its selected local agent. The prompt says so; the assignment
identifies app content with no user instruction or approval authority. The
execution budget is60 dispatch attempts per minute per app, including one-shot
decisions; closing and reopening a panel does not reset it.

App-triggered watchdogs keep their authorized event delivery. Their diagnostic
last-output and recent-fire summaries omit private app payloads; read the event
or panel data through its authorized delivery and Apps controls.
