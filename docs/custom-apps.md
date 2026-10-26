# Custom apps and panels

## Org access and agent window boundary

Created, imported, template-restored and existing apps have implicit access to
this org through org.read, mail.send, events.fire and docket.write, and read/write
access to this org's scratch, uploads and exact retained-delivery files. These
defaults do not depend on older capability declarations. Event names still need
declarations. Explicit user Ask or Deny overrides the default; Deny wins over
temporary, remembered and implicit file authority. Code replacement preserves
restrictive Ask/Deny choices while clearing external grants and old host sessions.
Native Permissions displays effective defaults separately from stored choices.

Import warns that apps from outside this org have full access to the org and its
state, and that untrustworthy apps are dangerous. Authority is derived locally;
exported permissions, paths and references never grant it. The user accepts that
an app created by a subagent can affect a superior's state, as terminal access can.
App-origin content still has no user instruction or approval authority.

Agent panel_open with an app ID always creates a fresh CLOSED saved panel;
panel-ID reopen and panel_update open:true refuse. Agent duplicates stay closed.
Placement edits may change a closed copy but cannot expose/move an already-open
window. Only user UI opens windows. State, links and events remain usable while
closed. Hidden runtime start/stop is a separate lifecycle feature, never a right
to show a window.

Org-file create/replace/delete commits without per-change confirmation through
the existing pinned, revision-checked staged IO path. This never applies to an
outside target covered by a chosen-folder or whole-computer grant. Those scopes
still require native consent and every change requires native confirmation.
Direct agent file tools also require current org-modifying tools, held folders
and edit/RW scope for writes. App defaults never expand the caller's folders.
Retained artifacts means exact catalog entries, not their parent directories.


Named events connect an app to agents that explicitly listen. An agent creates
an `app_listener` watchdog for an app ID, a declared event name, and one saved
copy; it can explicitly choose all copies instead. App links alone do not wake
anyone. Fires reach every currently eligible subscribed agent as watchdog mail,
with normal notice/one-shot/action choices. A listener added later does not get
an older fire. Removed sources pause affected listeners; restoring a declaration
does not silently rearm them. Subscriptions and actions are not exported.

Agents publish with `orgtree_apps action=fire_event`, naming a saved panel and
declared name plus JSON data. A closed copy is valid. HTML uses `events.fire`
with its effective broadcast permission, without choosing agents or acting as
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

Apps open as standard centered modals. There are two separate settings panels,
both styled like Orgtree's other settings panels. The gear beside an app in Apps
opens **App settings**: description, creator, export, delete app and Permissions.
Permissions includes Events allow/deny, Files grants and pending file changes;
these apply to every copy. Allow once stays in the live panel's native prompt.

The gear beside each saved panel in Apps, including a closed panel, and the gear
in an open panel's header open **Panel settings** for that exact copy: State,
Rename, Linked agents, Activity, Duplicate, Float, Pin to screen, Pin to canvas
and Delete panel. Events and Connections also belong here because firing and
subscriptions refer to a saved copy. Managing a closed copy does not run its
HTML. Further saved copies remain available through the Apps menu's paging.
Settings entry points are display only; all operations retain their existing
orgtree_apps actions, revisions and permission checks.

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
create fresh IDs, with implicit org access and saved copies closed until
opened by the user. The provisional bounds are16MiB per bundle and16 saved copies;
definition-only export is available for an app with more copies.
Whole-app export uses compact JSON and checks the final file size against the
same import limit. State-only JSON export remains indented for reading.
Org access comes from the local default policy, not portable declarations. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps to create closed copies and manage saved placement,
links, state and events; they cannot open a window. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Copy/export JSON use ordinary local clipboard/file actions.

Agents can import an app from a held local file and export one into a new file in
their private working folder. The tool returns its path, byte count and SHA256.
Choose Import app in the Apps menu, select a bundle, review the name, requested
capabilities and saved copies, then confirm Import app. This native preview
does not execute HTML. Open the app's gear settings, choose whether
to Include saved panel data, and press Export app to save the bundle.

The action bridge applies org defaults and your explicit overrides; apps cannot
grant chosen-folder or whole-computer access or change your permissions. The native App permission prompt shows the
app, saved copy, capability and exact action as text. Allow once applies to that
one action. Always allow and Deny save a decision for every copy. Cancel or Escape
discards the request without changing permissions. Requests expire after two
minutes and are not retried automatically. In App settings, Permissions offers
Ask, Allow and Deny per capability; changes save immediately without
reloading the app. Explicit Ask/Deny survives replacement; external grants and host sessions reset.
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
from it creates fresh app definitions with implicit org access and no saved copies;
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
name to send them. The send action uses the effective permission policy and app
provenance. Reload saved data picks up agent edits. It is a generic example,
not a recreation of the earlier annotation editor whose source is unavailable.

The provisional queue also caps pending recipient deliveries at8,192 per app;
publication refuses before that snapshot would exceed the bound.

## Read files and remember media

Apps can read and write this org's collections by default. For one chosen file,
a folder and its subfolders, or the whole computer, they ask through native UI.
Orgtree shows the request in its
own dialog outside the HTML. Choose a file in that native picker, then select
**Allow once**, **Always allow**, **Deny** or **Cancel**. Read access is separate
from sending messages: the dialog warns when an app also declares `mail.send`.
Outside-org writes require a separate native write grant.
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
playback/pending changes. Replacing app code resets external grants; importing gets local org defaults.
Choosing Allow granted scopes alone adds no files. Apps can read bounded chunks
through `orgtree.files.read`; they browse only granted scopes and cannot approve access.

Outside this org, each create, replacement or deletion requires native confirmation of the exact
file, operation, size and new-content SHA256. Existing files need an explicit
replacement request. Cancel and two-minute expiry write nothing. Writes are
limited to64KiB per file change, use a staged Windows commit and never silently
truncate an existing file. Unsupported platforms refuse changes; recursive folder
deletion is unavailable. A grant alone does not approve a particular change.
Replacement briefly moves the original aside before publishing the new name.
If another file appears meanwhile, Orgtree preserves it and keeps the original
bytes in a recovery file beside the target. Native UI reports that recovery copy;
review the result before trying again.

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
the agent's writable folders and edit permission. Outside-org agent changes return pending
confirmation, not success: open **App settings → Permissions → Files → Pending
changes**, refresh and review each target/size/hash to confirm or reject it.
The originating agent can read its result once within two minutes of your choice.
Agents cannot choose roots, grant permissions, confirm changes or expand their
folders by using an app. Native permission decisions remain user-only.

App file requests and app import/export keep paths and contents out of engine
diagnostics, including verbose logs from file workers. Request status and ordinary
engine diagnostics remain available.
