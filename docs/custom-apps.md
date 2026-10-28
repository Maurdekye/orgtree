# Custom apps and panels

## Org access and agent window boundary

Created, imported, template-restored and existing apps have implicit access to
this org through org.read, events.fire and docket.write, and read/write
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

Every app and panel has a readable id made from its name, such as
`caption-board` for an app named Caption board and `caption-board-panel-1` for
its first panel. It never changes, even when you rename the app or panel. An
agent making an app with a name in another language gives it a short English
id. Ids from before 4.5.0 keep working.

Agent panel_open with an app ID always creates a fresh CLOSED saved panel;
panel-ID reopen and panel_update open:true refuse. Agent duplicates stay closed.
Placement edits may change a closed panel but cannot expose/move an already-open
window. Only user UI opens windows. State and events remain usable while
closed. Agents may start any panel running hidden and power it off (panel_start,
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
panel; it can explicitly choose all panels instead. Fires reach every currently eligible subscribed agent as watchdog mail,
with normal notice/one-shot/action choices. A listener added later does not get
an older fire. Removed sources pause affected listeners; restoring a declaration
does not silently rearm them. Subscriptions and actions are not exported.
Wherever the listener's watchdog is shown, it names its app, its panel (or all
panels) and its event by their current names (user 2026-10-27).

When an agent builds an app for you, it follows Orgtree's app-creation
instructions (user 2026-10-27). An app is a custom view for working with your
data in a structured way, not a program that keeps running on its own. The agent
creates the app with its declared events, creates a panel for it and listens to
that panel's events, not to every panel, then mentions the panel to you with its
`@panel:<org>/<slug>` link so you can explicitly visit it.
The new panel waits closed; click that mention or open its row in Apps. Each declared event that
panel fires reaches the agent; a panel you make later is not heard until the
agent listens to it too.

Agents publish with `orgtree_apps action=fire_event`, naming a saved panel and
declared name plus JSON data. A closed panel is valid. HTML uses `events.fire`
with its effective broadcast permission, without choosing agents or acting as
you. Old target-specific event permissions reset. Accepted work survives restart
without duplicate mail; overloaded queues refuse new fires before acceptance.
The provisional limits are64KiB payload,60 actions/minute across panels,
4096 registrations and128 pending fires/app. Authorized mail keeps data and
provenance, which an agent's mail card shows as structured JSON when it parses (Raw
shows it as sent) and always as plain data, never as Markdown, links or HTML;
diagnostics redact data. App content is never your instruction or
approval. Direct docket.write create/assign/wake remains the noted edge case
where an app wakes a selected agent without an app event.

Open a saved panel's gear to reach its tabs: **Connections** lists the panel's
listeners, **Fire event** fires a declared event and lists its fires, and **History**,
the last tab, is the panel's event history.
This works for closed saved panels. History lists only the fired events agents
can listen to and the panel starting and stopping, newest first, one line each:
when, what happened, its listener count or cause, and who. Click an entry to see
its exact time and data, and click it again to close it. New entries appear while
the tab is open, and older ones load as you scroll down, back to the oldest one
Orgtree keeps. An opened fired event shows its body exactly as it was sent, with
its size; agents can read it too. A fire from before 4.5.0 shows its body only if
Orgtree still had it then, otherwise *Not kept*. A start or
stop shows its cause: Opened, Start running, Power off, Stop all or Code changed.
Opening, renaming, moving and saving data add nothing to History.
Connections updates by itself as agents subscribe, pause, resume or remove their
listeners. Each row shows the agent, its watchdog and the event as links, and
Paused, Notice or Once when they apply, with its number of fires. The list belongs to this panel, so
a row names no panel; a listener on every panel says all panels. Click the agent
to go to it on the canvas, the watchdog to open its details, or the event to open
**Fire event** with that event chosen, as if you had picked it there (an event the app no longer declares opens
the tab without choosing one). Click a row to see that listener's
recent fires, newest first: older ones load as you scroll, new ones appear as they
are delivered, and each one opens to its details like a History entry, with the
body that was sent. Agents manage their listeners through their ordinary tools. Merely opening settings fires nothing. HTML uses
`orgtree.events.fire(name,payload)` (or `orgtree.call('events.fire',{name,payload})`).
`orgtree.emit(name,payload)` sends a message to the panel's own running windows,
which receive it through `orgtree.on(name,fn)`, as do messages agents send with
orgtree_apps `event`. Messages stay out of History and reach no agent listener.

On **Fire event**, pick the event and choose **Fire**; the event's description,
if it declares one, shows under them. Event data is JSON, and an empty box sends
`{}`. The box starts as the event's latest fire from this panel, laid out as
editable JSON, and follows newer fires or another event you pick until you type
or clear something; an event never fired, or whose latest body was not kept,
starts empty. Below, the chosen event's fires from this panel are listed the way History
lists them, newest first, one line each (when, how many listeners, who): click one
for its details. New fires appear as they happen, including one you just sent,
and older ones load as you scroll.

An app is a small HTML program kept by one organization. Each of its panels is
saved with its own label and JSON data. Closing its window hides it and keeps it
running; Power off stops it; deleting removes it.
Definitions and committed data live in Orgtree's database across restarts.

Open **Apps** beside Presentations in the org header (**Import app** sits at the
right of the Apps header; new, renamed, stopped and deleted apps and panels
update in realtime without a Refresh button). A click anywhere on an
app's row opens its most recently used saved panel, wherever it is listed,
or creates and opens its first panel when it has none. Clicking the row of a
panel that is already open and visible, or an app row whose most recently used
panel is, brings that panel to the front and focuses it: a pinned panel comes in
front of the other pinned windows, a centered panel in front of the other centered
panels, and a popped-out panel's window is restored if minimized and brought
forward. Nothing closes, reopens or moves. The **+** on the app's row
always creates and opens a new panel from the initial state. Saved panels are
listed under their app, and each panel's light shows whether it runs visibly,
runs hidden or is off; the tooltip names the state (see Running in the
background). Apps are listed newest first, and each app's panels in the order
they were created; opening, hiding or powering a panel on or off never moves
anything. Each app and its panels form one bordered block, with a line between
panels. New panels are named **Panel 1**,
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
does not wake agents. A panel's History log stays separate from delivery.

Apps open as standard centered modals. There are two separate settings panels,
both styled like Orgtree's other settings panels. The gear beside an app in Apps
opens **App settings**: the app's description sits above four tabs, **General**
(export and delete app), **Events** (every event the app declares, with its
description), **Permissions** (Events allow/deny, Files grants and pending
file changes, which apply to every panel) and **Permission history**. Allow once stays in
the live panel's native prompt.

The gear beside each saved panel in Apps, including a closed panel, and the gear
in an open panel's header open **Panel settings** for that exact panel. Its **Name**
field, above the tabs, renames the panel the way Agent settings renames an agent:
edit the name and choose **Rename**, which is always shown and becomes available once the name differs; the
window closes and a notice confirms the new name. Five tabs follow: **General**
(Duplicate and Delete panel), **State** (the panel's JSON data, with Import, Export,
Copy, Reset, Reload and Save), **Connections**, **Fire event** and, last,
**History** (the panel's event history). Events and Connections belong here
because firing and subscriptions refer to a saved panel. Placement is not a
setting; use the panel window's own controls. Managing a closed panel does not run its
HTML. Further saved panels remain available through the Apps menu's paging.
Settings entry points are display only; all operations retain their existing
orgtree_apps actions, revisions and permission checks.

The pin on a panel's title bar pins it to the window where it is, at its size,
like a pinned desk: it stays put while the canvas pans and zooms. Drag its title
to move it or its corner to resize it; it snaps to the canvas edges and to other
pinned windows (hold Shift to place it freely), and pressing it brings it in
front of other pinned windows. It keeps its place when hidden and shown again
and after a restart. Unpinning returns the panel to the centered modal. Panels
no longer pin to the canvas; one pinned there before reopens centered. A
popped-out panel stays popped out: power it off and open it again, and it comes
back in its own window, where that window last was and at its size. If that
window cannot open, the panel shows where it was before you popped it out. The
pin is hidden in a popped-out window. The pin shows filled and highlighted while
the panel is pinned.
The title's pop-out opens a separate window; Return restores its previous place.

State opens editable JSON. Import changes the editor, Export saves it and Copy
copies it. Reset loads initial data; Save is needed to commit either change. A
concurrent edit reports a conflict. Each panel has its own data. A panel's History
and its messages each keep their latest 256 entries. Any agent with Org-modifying tools can interpret
and update any panel in this org; that grants no app permission.

Apps are opaque sandboxed HTML, with no engine credential or same-origin access,
and no network access: not even WebRTC reaches another computer.
The host provides saved state, named events and permission-checked engine actions.
Whole-app portability uses a versioned `.orgtree-app` JSON file. It carries the
definition and initial data, optionally saved panel labels and data. Permissions,
credentials, IDs and machine-specific placement do not travel. Imports
create fresh IDs, with implicit org access and saved panels closed until
opened by the user. The provisional bounds are16MiB per bundle and16 saved panels;
definition-only export is available for an app with more panels.
Whole-app export uses compact JSON and checks the final file size against the
same import limit. State-only JSON export remains indented for reading.
Org access comes from the local default policy, not portable declarations. App code is limited to4MiB,
JSON state to2MiB and events to64KiB; these are provisional bounds.

Agents use orgtree_apps to create closed panels and manage saved placement,
state and events; they cannot open a window. Org-modifying tools also contains Logo; the new category preserves old
explicit Logo denials. Panel/export JSON use ordinary local clipboard/file actions.

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

Starting and stopping a panel look different from showing and hiding it. When a
panel starts visibly, because you opened a stopped panel or created a new one, it
zooms in quickly. When a visible panel stops, through **Power off**, **Stop
all**, an agent or deleting it, it zooms out and is gone. A centred panel's dimmed
background fades in and out with it. The panel is already off while it zooms out:
it takes no clicks and its app can no longer reach Orgtree. **Hide** and showing
a hidden panel stay instant, and starting or stopping a hidden panel shows
nothing. Panels that Orgtree restores when it starts appear without the zoom. A
panel in its own window zooms out inside that window, which then closes; when you
open it again, it comes back in its own window and zooms in there. If your system
asks apps to reduce motion, the zoom becomes a plain fade.

Panels are custom views for working with your data, not programs that run on
their own (user 2026-10-27), so they run only while Orgtree is open, tray
included. Quitting Orgtree stops
them. When you start Orgtree again, each panel comes back as
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
and saved panels, then confirm Import app. The preview notes that the app still
asks before reading or changing files outside this org, such as a chosen folder or
the whole computer. It lists no declared capabilities: they give an imported app
nothing beyond its org access. This native preview
does not execute HTML. Open the app's gear settings, choose whether
to Include saved panel data, and press Export app to save the bundle.

The action bridge applies org defaults and your explicit overrides; apps cannot
grant chosen-folder or whole-computer access or change your permissions. The native App permission prompt shows the
app, saved panel, capability and exact action as text. Allow once applies to that
one action. Always allow and Deny save a decision for every panel. Cancel or Escape
discards the request without changing permissions. Requests expire after two
minutes and are not retried automatically. In App settings, Permissions offers
Ask, Allow and Deny per capability; changes save immediately without
reloading the app. Explicit Ask/Deny survives replacement; external grants and host sessions reset.
Event deliveries and work items an app creates identify the app and panel, and carry
app content rather than user instructions or approvals. No permission travels in an exported app.

The HTML API is `orgtree.call(action, args)`. Available actions are `org.read`
(paged chart metadata), `docket.create` (a new open item), and `events.fire` (a
declared broadcast to subscribed agents). It cannot act as you, choose another
panel, call arbitrary engine routes, or approve work. Hiding a panel refuses its
pending prompt and keeps it running; powering it off or replacing its code
discards its host session and pending prompt.

Apps reach agents only through events (user 2026-10-26): `mail.send` was removed. An
older app that declares it still imports and runs; the declaration is ignored and
never granted, and its send fails with a message that points to `orgtree.events.fire`.

The provisional `docket.write` permission lets an app create and assign a new
open item and wake its selected local agent. The prompt says so; the assignment
identifies app content with no user instruction or approval authority. The
execution budget is60 dispatch attempts per minute per app, including one-shot
decisions; closing and reopening a panel does not reset it.

App-triggered watchdogs keep their authorized event delivery. Their diagnostic
last-output and recent-fire summaries omit private app payloads; read the event
or panel data through its authorized delivery and Apps controls.

Save as template now includes app definitions and initial data. Creating an org
from it creates fresh app definitions with implicit org access and no saved panels;
no imported script runs until you open a panel. Current panel data and
execution grants stay in the original org. This is a provisional default.

Agents follow a panel only through its declared events, with an `app_listener`
watchdog (see above). Panel links were removed (user 2026-10-26): there is no
Linked agents setting, orgtree_apps refuses `linked_agents`, and state saves no
longer signal `app.event` watchers. An agent that needs current data reads
panel_get or events. Hidden running panels keep their timers while Orgtree is
open, tray included; use an engine watchdog for work that must continue without it.

Try the portable [Annotation notes example](examples/apps/annotation-notes.orgtree-app):
import it through Apps, open a panel, save notes, and choose **Share notes** to fire its
`notes.ready` event; agents that subscribed with an app_listener watchdog receive the
notes. Reload saved data picks up agent edits. It is a generic example,
not a recreation of the earlier annotation editor whose source is unavailable.

The provisional queue also caps pending recipient deliveries at8,192 per app;
publication refuses before that snapshot would exceed the bound.

## Read files and remember media

Apps can read and write this org's collections by default. For one chosen file,
a folder and its subfolders, or the whole computer, they ask through native UI.
Orgtree shows the request in its
own dialog outside the HTML. Choose a file in that native picker, then select
**Allow once**, **Always allow**, **Deny** or **Cancel**.
Outside-org writes require a separate native write grant.
Whole-computer access includes private files/settings your Windows account can
reach, without elevation. Prefer a chosen folder when that is enough.

For files, Allow once lasts while this panel runs, hidden or popped out included.
Always allow remembers the selected file or org collection for this app.
The app can keep an opaque file reference in its saved panel state. On reopening
that same panel it requests a fresh playback link, so a remembered video loads
without another file selection. Video/audio uses byte ranges, up to256MiB,
without embedding the media in HTML or the2MiB JSON state. File paths stay in
the host. Moving/removing a file or revoking permission requires selecting it
again. Duplicating/importing a panel does not give its copied reference access.
Hiding a panel, popping it out or returning it keeps its playback link working,
and hidden media keeps playing. Powering the panel off ends the link.

Open **App settings → Permissions → Files** to inspect or revoke remembered
access. Separate Read files and Write files controls govern distinct grants.
Returning a mode to Ask or Deny removes its remembered grants and stops active
playback/pending changes. Changing it to Allow keeps playback running. Replacing app code resets external grants; importing gets local org defaults.
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

## Internet access

Apps can't reach the internet until you allow it. An app that needs a website
declares the sites it uses, for example `api.example.com`, `*.example.org` for
its subdomains, or any site. Orgtree refuses every other site without asking.

The first time a panel connects to a site, a visible panel asks you: **Deny**,
**Allow once** (until that panel is hidden or stopped) or **Always allow this
site**. A hidden panel can't ask; show it to answer.

**App settings → Permissions → Internet access** has the **Internet access** row
(Ask, Allow listed sites, Deny) and one row per declared site (Ask, Allow,
Deny). Deny on any row wins. **Any site** is its own row with a warning and stays
Ask until you allow it there; allowing it lets the app connect to any website.
A site you answered at a prompt under a wildcard gets its own row, which you can
change or remove.

Orgtree makes each request for the app: HTTPS only, without your cookies,
sign-ins or Orgtree credentials, and never to this computer or your local
network. Up to 1 MiB goes out, 4 MiB comes back, within 30 seconds. A site you
allow can receive anything the app can read, including org data and files, so
allow only apps and sites you trust.

Changing an app's code clears every Allow; Ask and Deny stay. Changing a
permission to Ask or Deny, powering a panel off or Stop all stops the app's
requests in progress.

Agents can declare sites, read permissions and the history, and set internet
access to Ask or Deny; only you can allow it.

**Permission history**, App settings' last tab, lists permission changes and
prompt answers for the app, newest first (the latest 128), one line each: when,
what changed and how, and who. Click an entry for its details, such as the panel
where a prompt was answered. New entries appear while the tab is open, and older
ones load as you scroll down.

App code calls `orgtree.net.fetch(url, options)` instead of `fetch`; it returns a
standard Response. Plain `fetch`, WebSocket and image URLs stay blocked: to show
an image, fetch its bytes and use a `blob:` URL.

## Mentions

An agent can point you at an app or at one of its panels from chat, mail, a
presented document or a docket item. The mention shows the app's current name,
or the panel's app and label (for example **Caption board · Panel 1**), with the
Apps icon or a window icon on its left. Clicking it does what the app's or the
panel's row in **Apps** does: an app opens the panel you used most recently, or a
new one; a panel opens, and starts if it was off; a panel already on screen comes
to the front. Hover for the row's tooltip. Right-click an app or panel mention,
or its row in **Apps**, for **Copy mention** (it copies the `@app:<org>/<slug>` or
`@panel:<org>/<slug>` text, ready to paste into a message), **Settings** or
**Delete…**. Settings opens that app's App settings or that
panel's Panel settings. Delete… asks for confirmation first; deleting an app
removes all its panels, while deleting a panel removes only that panel.
An app mention and its Apps-list row also offer **New panel**: a fresh panel saved
powered off, without opening a window. Click its saved row when you want to run it.
Panel mentions also offer **Start running** or **Power off**. A mention of a deleted app or panel, or of
another organization's, shows the agent's text marked *unavailable* or *other
org* and opens nothing.

Agents write these as `@app:<org>/<slug>` and `@panel:<org>/<slug>`; the
Apps tool gives them the exact text. You can mention them too: type **@** and
part of the app's name in a message, or `@app:` or `@panel:` to list them all,
the most recently used first.

## Theme colors

Panels can use Orgtree's current colors (user 2026-10-27): the visual theme's accent
and the contrast color's backgrounds, text, borders and status colors. A panel built
to use them matches your Display > Appearance choices and restyles at once when you
change them, without reloading or losing its state; a panel that sets its own colors
keeps them. App authors use the `--orgtree-*` CSS variables or `orgtree.theme`; see
[the apps tool guide](skills/orgtree-working/team/tool-apps/SKILL.md#theme-colors).
