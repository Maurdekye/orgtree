# Custom apps and panels

Named events connect an app to agents that explicitly listen. An agent creates
an `app_listener` watchdog for an app ID, a declared event name, and one saved
copy; it can explicitly choose all copies instead. App links alone do not wake
anyone. Fires reach every currently eligible subscribed agent as watchdog mail,
with normal notice/one-shot/action choices. A listener added later does not get
an older fire. Removed sources pause affected listeners; restoring a declaration
does not silently rearm them. Subscriptions and actions are not exported.

Agents publish with `orgtree_apps action=fire_event`, naming a saved panel and
declared name plus JSON data. A closed copy is valid. HTML uses `events.fire`
with a fresh native broadcast permission, without choosing agents or acting as
you. Old target-specific event permissions reset. Accepted work survives restart
without duplicate mail; overloaded queues refuse new fires before acceptance.
The provisional limits are64KiB payload,60 actions/minute across copies,
4096 registrations and128 pending fires/app. Authorized mail keeps data and
provenance; diagnostics redact data. App content is never your instruction or
approval. Direct docket.write create/assign/wake remains the noted edge case
where an app wakes a selected agent without an app event.

Open a saved copy's gear, choose **Events…**, and inspect its Connections list
or fire a declared event with JSON data. This works for closed saved copies.
Refresh/More connections page the registrations; agents manage those watchdogs
through their ordinary tools. Merely opening settings fires nothing. HTML uses
`orgtree.events.fire(name,payload)` (or `orgtree.call('events.fire',{name,payload})`).
`orgtree.emit` stays separate panel activity and does not broadcast to listeners.

An app is a small HTML program kept by one organization. A panel is one saved
copy with its own label and JSON data. Closing keeps it; deleting removes it.
Definitions and committed data live in Orgtree's database across restarts.

Open **Apps** beside Presentations in the org header. Clicking an app reopens its
most recently used copy or creates the first one. **+ New panel** makes another
copy from the initial state. Open and closed saved panels are listed below it.
These defaults are provisional for the morning review.

The Apps button highlights and counts new apps like unread attention mail. The
menu marks them **New**. An entry clears from the count when you see it in the
menu; entries below the scroll area or on another page stay new. Labels stay for
that menu visit. Seen status belongs to the org and survives restarts. Existing
apps start new when this feature is first added. Provisional choice: apps you
import yourself also count as new. Updating an app does not mark it new again.

Agents can set an app's initial JSON state. The first panel and **+ New panel**
copy that state. Changing the definition's initial state affects future panels;
existing saved panels keep their data.

An app definition can declare named events in `events`, for example
`[{"name":"submitted","description":"Notes ready for review"}]`. Declarations
travel with whole-app export/import and templates. Names are exact and unique,
without surrounding whitespace or control characters. The provisional catalog
limit is64 events, with names up to80 characters and descriptions up to1,000.
Declarations grant no permission and create no listeners. Named-event listener
delivery uses explicit app_listener subscriptions; declaring an event alone
does not wake agents. Existing panel activity and linked-agent metadata stay
separate.

Apps open as standard centered modals. Use the gear on a panel or beside an app
in Apps to open **App settings**, styled like Orgtree's other settings panels.
The **App** section contains permissions, export and app deletion. **This panel**
lists State, Rename, Linked agents, Activity, Duplicate, placement and Delete
panel; choose a saved copy to manage it without running its HTML. Further copies
remain available through paging. Permissions apply to every copy of the app.

**Float** returns to the centered modal. **Pin to screen** fixes the current
position; drag its title or resize its corner. **Pin to canvas** moves and zooms
with the chart. Screen/canvas pins retain their saved position when reopened;
pop-outs use the existing saved-window restoration (provisional reopen default).
Far zoom shows an icon, and hidden canvas HTML pauses until visible again.
The title's pop-out opens a separate window; Return restores its previous place.

State opens editable JSON. Import changes the editor, Export saves it and Copy
copies it. Reset loads initial data; Save is needed to commit either change. A
concurrent edit reports a conflict. Each copy has its own data. A panel's recent
Activity retains256 events. Linked agents can interpret/update any copy in this
org with Org-modifying tools; linking does not grant permission.

Apps are opaque sandboxed HTML, with no engine credential or same-origin access.
The host provides saved state, named events and permission-checked engine actions.
Whole-app portability uses a versioned `.orgtree-app` JSON file. It carries the
definition and initial data, optionally saved copy labels and data. Permissions,
credentials, links, IDs and machine-specific placement do not travel. Imports
create fresh IDs, with every permission set to Ask and saved copies closed until
explicitly opened. The provisional bounds are16MiB per bundle and16 saved copies;
definition-only export is available for an app with more copies.
Whole-app export uses compact JSON and checks the final file size against the
same import limit. State-only JSON export remains indented for reading.
Declaring an engine capability does not grant it. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps for the same lifecycle, placement, link, state and event
controls. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Copy/export JSON use ordinary local clipboard/file actions.

Agents can import an app from a held local file and export one into a new file in
their private working folder. The tool returns its path, byte count and SHA256.
Choose Import app in the Apps menu, select a bundle, review the name, requested
capabilities and saved copies, then confirm Import app. This native preview
does not execute HTML. Open the app's gear settings, choose whether
to Include saved panel data, and press Export app to save the bundle.

The action bridge accepts only declared capabilities with your permission; apps
cannot grant their own permissions. The native App permission prompt shows the
app, saved copy, capability and exact action as text. Allow once applies to that
one action. Always allow and Deny save a decision for every copy. Cancel or Escape
discards the request without changing permissions. Requests expire after two
minutes and are not retried automatically. In App settings, Permissions offers
Ask, Allow and Deny per declared capability; changes save immediately without
reloading the app. These defaults are provisional. Replacing app code clears old permissions.
App messages identify the app and copy, and carry app content rather than user
instructions or approvals. No permission travels in an exported app.

The HTML API is `orgtree.call(action, args)`. Available actions are `org.read`
(paged chart metadata), `mail.send` (live local agent), `docket.create` (a new open
item), and `events.fire` (a declared broadcast to subscribed agents). It cannot act as
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

Save as template now includes app definitions and initial data. Creating an org
from it creates fresh app definitions with Ask permissions and no saved copies;
no imported script runs until you open a panel. Current panel data, links and
execution grants stay in the original org. This is a provisional default.

For an agent to follow a copy, add its name under Linked agents and have it create
an event watchdog for `app.event`, optionally filtering the app/panel IDs with
pattern. State saves and named panel events publish a sequence cursor
after commit. The watcher can read panel_get/events for the data. Linking alone
does not wake anyone, and no watcher is created automatically. Existing watcher
scope, coalescing and notice/wake choices apply. Browser timers pause with hidden
HTML; use an engine watchdog for work that must continue in the background.

Try the portable [Annotation notes example](examples/apps/annotation-notes.orgtree-app):
import it through Apps, open a copy, save notes, and enter a live local agent's
name to send them. The send action uses the native permission prompt and app
provenance. Reload saved data picks up agent edits. It is a generic example,
not a recreation of the earlier annotation editor whose source is unavailable.

The provisional queue also caps pending recipient deliveries at8,192 per app;
publication refuses before that snapshot would exceed the bound.

## Read files and remember media

An app declaring `files.read` can ask to read one chosen file, a folder and its
subfolders, this org's scratch/uploads/retained deliveries, or the whole computer.
Orgtree shows the request in its
own dialog outside the HTML. Choose a file in that native picker, then select
**Allow once**, **Always allow**, **Deny** or **Cancel**. Read access is separate
from sending messages: the dialog warns when an app also declares `mail.send`.
Write access requires a separate `files.write` declaration and native grant.
Whole-computer access includes private files/settings your Windows account can
reach, without elevation. Prefer a chosen folder when that is enough.

For files, Allow once lasts while this panel host stays open and visible.
Always allow remembers the selected file or org collection for this app.
The app can keep an opaque file reference in its saved panel state. On reopening
that same panel it requests a fresh playback link, so a remembered video loads
without another file selection. Video/audio uses byte ranges, up to256MiB,
without embedding the media in HTML or the2MiB JSON state. File paths stay in
the host. Moving/removing a file or revoking permission requires selecting it
again. Duplicating/importing a panel does not give its copied reference access.

Open **App settings → Permissions → Files** to inspect or revoke remembered
access. Separate Read files and Write files controls govern distinct grants.
Returning a mode to Ask or Deny removes its remembered grants and stops active
playback/pending changes. Replacing app code resets grants; importing starts at Ask.
Choosing Allow granted scopes alone adds no files. Apps can read bounded chunks
through `orgtree.files.read`; they browse only granted scopes and cannot approve access.

Every create, replacement or deletion requires native confirmation of the exact
file, operation, size and new-content SHA256. Existing files need an explicit
replacement request. Cancel and two-minute expiry write nothing. Writes are
limited to64KiB per file change, use a staged Windows commit and never silently
truncate an existing file. Unsupported platforms refuse changes; recursive folder
deletion is unavailable. A grant alone does not approve a particular change.

The SDK adds `files.grant(scope,mode)` for `orgtree`, `folder` or `computer`, and
`read` or `write`. Save returned opaque roots in that panel's state.
`files.roots()` returns current readable roots; `files.list(directory,options)`
and `files.collection(root,options)` browse names/references with a page limit
of1–200. `files.child(directory,path)` opens a relative descendant. Listings
scan at most20,000 entries and disclose that limit. `files.write(directory,name,
base64,{replace:false})` and `files.delete(file)` request confirmed changes.

Agent parity: `orgtree_apps` exposes `file_permissions`, `file_open`, `file_read`,
`file_roots`, `file_list`, `file_child`, `file_write`, `file_delete` and `file_result`.
Reads need both the app's grant and the agent's current folders. Writes also need
the agent's writable folders and edit permission. Agent changes return pending
confirmation, not success: open **App settings → Permissions → Files → Pending
changes**, refresh and review each target/size/hash to confirm or reject it.
The originating agent can read its result once within two minutes of your choice.
Agents cannot choose roots, grant permissions, confirm changes or expand their
folders by using an app. Native permission decisions remain user-only.
