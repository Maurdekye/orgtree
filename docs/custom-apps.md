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
window. Only user UI opens windows. State and events remain usable while
closed. Agents may start any copy running hidden and power it off (panel_start,
panel_stop); starting never shows a window or grants a permission.

Org-file create/replace/delete commits without per-change confirmation through
the existing pinned, revision-checked staged IO path. This never applies to an
outside target covered by a chosen-folder or whole-computer grant. Those scopes
still require native consent and every change requires native confirmation.
Direct agent file tools also require current org-modifying tools, held folders
and edit/RW scope for writes. App defaults never expand the caller's folders.
Retained artifacts means exact catalog entries, not their parent directories.


Named events connect an app to agents that explicitly listen. An agent creates
an `app_listener` watchdog for an app ID, a declared event name, and one saved
copy; it can explicitly choose all copies instead. Fires reach every currently eligible subscribed agent as watchdog mail,
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

Open a saved copy's gear to reach its tabs: **Connections** lists the copy's
listeners, **Fire event** fires a declared event with JSON data and **History**,
the last tab, reads the copy's event history.
This works for closed saved copies. History lists opens, changes, state saves and
events, newest first; a fired event shows its listener count, while its data goes
only to the subscribed agents.
Refresh/More connections page the registrations; agents manage those watchdogs
through their ordinary tools. Merely opening settings fires nothing. HTML uses
`orgtree.events.fire(name,payload)` (or `orgtree.call('events.fire',{name,payload})`).
`orgtree.emit` adds a History entry and does not broadcast to listeners.

An app is a small HTML program kept by one organization. A panel is one saved
copy with its own label and JSON data. Closing its window hides it and keeps it
running; Power off stops it; deleting removes it.
Definitions and committed data live in Orgtree's database across restarts.

Open **Apps** beside Presentations in the org header. A click anywhere on an
app's row opens the first saved panel listed under it (the most recently used),
or creates and opens its first panel when it has none. The **+** on the app's row
always creates and opens a new panel from the initial state. Saved panels are
listed under their app, and each panel's light shows whether it runs visibly,
runs hidden or is off; the tooltip names the state (see Running in the
background). New panels are named **Panel 1**,
**Panel 2** and so on, with the lowest number not yet used in that app; renamed,
imported and duplicated panels keep their own names.

The Apps button highlights and counts new apps like unread attention mail. The
menu marks them **New**. An entry clears from the count when you see it in the
menu; entries below the scroll area or on another page stay new. Labels stay for
that menu visit. Seen status belongs to the org and survives restarts. Existing
apps start new when this feature is first added. Provisional choice: apps you
import yourself also count as new. Updating an app does not mark it new again.

Agents can set an app's initial JSON state. The first panel and each panel made
with **+** copy that state. Changing the definition's initial state affects future panels;
existing saved panels keep their data.

An app definition can declare named events in `events`, for example
`[{"name":"submitted","description":"Notes ready for review"}]`. Declarations
travel with whole-app export/import and templates. Names are exact and unique,
without surrounding whitespace or control characters. The provisional catalog
limit is64 events, with names up to80 characters and descriptions up to1,000.
Declarations grant no permission and create no listeners. Named-event listener
delivery uses explicit app_listener subscriptions; declaring an event alone
does not wake agents. A copy's History log stays separate from delivery.

Apps open as standard centered modals. There are two separate settings panels,
both styled like Orgtree's other settings panels. The gear beside an app in Apps
opens **App settings**: the app's description sits above two tabs, **General**
(export and delete app) and **Permissions** (Events allow/deny, Files grants and pending
file changes, which apply to every copy). Allow once stays in the live panel's native prompt.

The gear beside each saved panel in Apps, including a closed panel, and the gear
in an open panel's header open **Panel settings** for that exact copy. Its **Name**
field, above the tabs, renames the copy the way Agent settings renames an agent:
edit the name and choose **Rename**, which appears once the text differs; the
window closes and a notice confirms the new name. Five tabs follow: **General**
(Duplicate and Delete panel), **State** (the copy's JSON data, with Import, Export,
Copy, Reset, Reload and Save), **Connections**, **Fire event** and, last,
**History** (the copy's event history). Events and Connections belong here
because firing and subscriptions refer to a saved copy. Placement is not a
setting; use the panel window's own controls. Managing a closed copy does not run its
HTML. Further saved copies remain available through the Apps menu's paging.
Settings entry points are display only; all operations retain their existing
orgtree_apps actions, revisions and permission checks.

The pin on a panel's title bar pins it to the canvas, centred in the visible
canvas, and switches the org window to the canvas view; drag its title or resize
its corner there. A canvas pin moves and zooms with the chart and keeps its saved
position when reopened. Unpinning returns the panel to the centered modal. Panels
no longer pin to the screen; one pinned there before reopens centered. Pop-outs
use the existing saved-window restoration (provisional reopen default), and the
pin is hidden in a popped-out window. The pin shows filled and highlighted while
the panel is pinned.
Far zoom shows an icon; a canvas panel out of view keeps running.
The title's pop-out opens a separate window; Return restores its previous place.

State opens editable JSON. Import changes the editor, Export saves it and Copy
copies it. Reset loads initial data; Save is needed to commit either change. A
concurrent edit reports a conflict. Each copy has its own data. A panel's History
retains its latest 256 entries. Any agent with Org-modifying tools can interpret
and update any copy in this org; that grants no app permission.

Apps are opaque sandboxed HTML, with no engine credential or same-origin access.
The host provides saved state, named events and permission-checked engine actions.
Whole-app portability uses a versioned `.orgtree-app` JSON file. It carries the
definition and initial data, optionally saved copy labels and data. Permissions,
credentials, IDs and machine-specific placement do not travel. Imports
create fresh IDs, with implicit org access and saved copies closed until
opened by the user. The provisional bounds are16MiB per bundle and16 saved copies;
definition-only export is available for an app with more copies.
Whole-app export uses compact JSON and checks the final file size against the
same import limit. State-only JSON export remains indented for reading.
Org access comes from the local default policy, not portable declarations. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps to create closed copies and manage saved placement,
state and events; they cannot open a window. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Copy/export JSON use ordinary local clipboard/file actions.

## Running in the background

Closing a panel's window hides it; the panel keeps running. Use **Power off** to
stop it: the power button in the panel's title bar, or on its row in Apps. The
title bar's **Hide** button (the X at its far right) only hides the window. A visible panel is
always running; a hidden one can be running or off.

In Apps, each saved panel's light shows its state: filled while it runs visibly,
an accent ring while it runs hidden, and a hollow grey ring when it is off. Hover
for the state. Running rows also show sampled CPU, where 100% is one processor
core; "(shared)" means the figure covers the whole renderer process that the
panel shares with others. Right-click a stopped panel's row and choose **Start
running** to run it without opening its window. Opening a stopped panel starts it.

Panels run only while Orgtree's desktop app is open, including when it sits in the
tray; quitting stops them. When you start Orgtree again, each panel comes back as
it was: running hidden, visible where you placed it, or off. Hidden panels keep
their timers, messages and background work running at full speed, also while
Orgtree sits in the tray. Animation frames (`requestAnimationFrame`) run only while
a panel shows, so drive a game or other continuous work from timers and count the
real time that passed, and draw in animation frames. Apps can also start
Dedicated Workers from scripts they build themselves; workers have no network
access either, and they stop with the panel. Closing one of several Orgtree
windows that runs panels hides it until those panels stop. **Stop all** powers off
every app panel too, including hidden ones, and releasing it starts none of them.

A hidden panel never pops up a permission prompt: its request fails, and you can
show the panel and try again. Moving a panel into or out of its own window
restarts its HTML from its saved data. There is no limit on how many panels run.
Provisional choice: when an app's code is replaced, its visible panels reload the
new code and its hidden running panels power off.

Agents can start any panel running hidden and power panels off, but they cannot
open or show a window, and starting grants nothing.

Agents can import an app from a held local file and export one into a new file in
their private working folder. The tool returns its path, byte count and SHA256.
Choose Import app in the Apps menu, select a bundle, review its name, description
and saved copies, then confirm Import app. The preview notes that the app still
asks before reading or changing files outside this org, such as a chosen folder or
the whole computer. It lists no declared capabilities: they give an imported app
nothing beyond its org access. This native preview
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
you, choose another panel, call arbitrary engine routes, or approve work. Hiding a
panel refuses its pending prompt and keeps it running; powering it off or
replacing its code discards its host session and pending prompt.

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
no imported script runs until you open a panel. Current panel data and
execution grants stay in the original org. This is a provisional default.

Agents follow a copy only through its declared events, with an `app_listener`
watchdog (see above). Panel links were removed (user 2026-10-26): there is no
Linked agents setting, orgtree_apps refuses `linked_agents`, and state saves no
longer signal `app.event` watchers. An agent that needs current data reads
panel_get or events. Hidden running panels keep their timers while the desktop
app runs; use an engine watchdog for work that must continue without it.

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

App messages, the notice of a docket item an app assigns, and app event deliveries
also stay out of engine diagnostics when they wake an agent: the log names each
by its message ID. The agent still receives the content, and ordinary messages
are logged as before.
