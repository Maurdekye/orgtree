---
name: orgtree-apps
description: Open Apps and saved panels, pin or pop them out, and inspect each panel's JSON state.
---

Up: [orgtree-app-shell](../SKILL.md)

# Apps and saved panels

Panel settings shows a saved panel's Connections, Fire event and History tabs
(History last), including for closed panels. History lists only fired events agents can listen to and the panel starting and
stopping, newest first (user ruling 2026-10-26); a fired event shows its listener
count, and expanded, its body exactly as it was sent with its size (user ruling
2026-10-27; Not kept for a fire from before 4.5.0 that Orgtree no longer holds),
and a start or stop its cause. It is a live list (user ruling
2026-10-27): one line per entry (time, what happened, listener count or cause, who)
that expands on click to the exact time and the row's data and collapses on a second
click; new entries appear while the tab is open, older ones load as you scroll down
to the oldest kept, and there is no Refresh button. Fire event (user ruling
2026-10-27) has the declared event and Fire on one line, the event's description
under them and a JSON data box (empty sends {}); opening the tab fires nothing.
Below, the chosen event's fires from this panel are a live list like History: one
line each (time, listener count, who) that expands to History's details, with
new fires (one sent from the tab included) arriving and older ones loading as you
scroll. Connections are agent-owned
app_listener watchdogs in a live list with no buttons (user ruling 2026-10-27):
rows appear, change and disappear as agents subscribe, pause, resume or remove.
A row shows the agent as its mention link, its watchdog as a watchdog link, all
panels for a listener on every panel (no panel otherwise: the list is the panel's own, user ruling 2026-10-27),
the event name as a link, and Paused, Notice or Once when they apply beside its
fire count. The agent link focuses that agent on the canvas and the watchdog link
opens the watchdog's window; from a centered settings window either closes the
window first. The event link switches to Fire
event with that event chosen as if picked there, focusing the picker; an event
the app no longer declares opens Fire event without choosing one. Clicking a row lists that listener's
delivered fires like History: newest first, older ones on scroll, new ones live,
each expanding to its time, who fired it, its panel, its delivery, event ID and
body as sent. Agents manage their registrations through orgtree_watchdog;
orgtree_apps fire_event/listeners/listener_fires provide publication/list parity. HTML orgtree.events.fire(name,payload) uses
the permission-checked broadcast; orgtree.emit sends a message to the panel's own
running windows (orgtree.on) and never enters History.
App data is not a user instruction or approval. Direct docket.write assignment
and wake remains the user-approved edge case that needs no app event.

App definitions may carry a portable named event catalog in `events`:
`[{name:"submitted",description:"Notes ready for review"}]`. The provisional
limit is64 events, unique exact names1–80 characters with no surrounding
whitespace or controls, and descriptions up to1,000 characters. Whole-app
export/import and templates retain these declarations. Declarations alone do
not grant permissions, create listeners or wake agents; durable named-event
delivery uses explicit app_listener subscriptions.

An agent that builds an app for you follows the app-creation instructions in
`orgtree-tool-apps` (orgtree-working > team; user 2026-10-27): it creates the
app with its declared events, creates one panel for you and listens to that
panel's events, not to every panel, then mentions the panel to you with its
`@panel:<org>/<slug>` ref. The new panel waits closed; click that mention
to visit it, or open its row in Apps. Its Connections tab lists the agent's listener, and each declared event
that panel fires reaches the agent.

The header Apps button counts new apps with the unread attention-mail highlight.
Each new menu entry is marked New. Only entries visible in the menu clear from
the count; scrolling and More apps expose the rest. Labels remain for that visit.
Seen status is stored per org across restarts. Existing apps start new once when
this feature is added. Provisional choice: your own imports also count as new.
Updating a definition does not mark it new again. Agent parity is orgtree_apps
list (is_new/new_count) and mark_seen with explicit apps:[id,...], up to200 IDs.

## Running in the background

Closing a panel's window hides it; the panel keeps running (user 2026-10-26).
The window header has two run controls: Power off (the power symbol) stops the
panel and closes the window, and Hide (the X at the far right) closes the window
and keeps the panel running. Each saved-panel row
shows its state on its light: filled for running and visible, an accent ring for
running hidden, a hollow grey ring for off; the tooltip says Running · visible,
Running · hidden or Off. Running rows show their CPU, sampled every 3 seconds while
Apps is open (100% = one core; "shared" marks a figure for the whole renderer
process), and a Power off button. Right-click a row for Start running (stopped
rows; runs it without opening its window) or Power off (running rows). Right-click an app or a panel row, or an `@app:`/`@panel:` chip, for **Copy mention**, which copies its `@app:<org>/<slug>` or `@panel:<org>/<slug>` mention. Opening a stopped panel starts it. Stop all powers off every app panel;
releasing Stop all starts none of them.

Starting and stopping look different from showing and hiding (user 2026-10-27).
A panel that starts visibly (a stopped panel opened, or a new one) zooms in
quickly, and a visible panel that stops (Power off, Stop all, an agent's power
off or deletion) zooms out, each in about 180 ms. A centred panel's dimmed
backdrop fades with it. A stopping panel is already off while it zooms out: it
takes no input and its app reaches nothing. Hide and show stay instant, starting
or stopping a hidden panel shows nothing, and panels restored at launch appear
without a zoom. A popped-out panel zooms out inside its own window, which then
closes; opened again, it comes back popped out and zooms in there. With the
system's reduce-motion setting the zoom is a plain fade. Display only: orgtree_apps
panel_start and panel_stop are unchanged.

Panels are custom views, not background programs (user 2026-10-27): they run
only while Orgtree is open, tray included. Hidden
panels keep their timers, messages and Dedicated Workers running at full speed; a
window that hosts running panels is never throttled. Animation frames run only
while a panel shows, so apps tick game loops from timers. Closing one of several org windows that runs
panels hides it until its panels stop. Quitting stops them; the next launch
restores each panel as it was: running hidden, visible in its placement, or off.
A hidden panel never shows a permission prompt: show it to answer. Moving a panel
into or out of a pop-out restarts its HTML from its saved data. Provisional:
replacing an app's code powers off its hidden running panels.

Open **Apps** in the org header, beside Presentations; **Import app** is at the
right of the Apps header. App and panel Settings gears share one right-aligned
column, with app **+** and panel **Power off** aligned in the preceding column
(user ruling 2026-10-27). An empty org shows "No apps yet. Ask an agent to make
an app for you, and it will appear here."; the message disappears when an app
appears in the live list. There is no Refresh button (new, renamed, stopped
or removed apps and panels appear in realtime; user rulings 2026-10-27). A click anywhere on an
app's row opens its most recently used saved panel, wherever it is listed,
or creates and opens its first panel when it has none. A row whose panel is
already open and visible (a saved panel's row, or an app row whose most recently
used panel is) brings that panel to the front and focuses it: a window pin rises
above the other pinned windows and desks, a centered panel above the other
centered panels, and a pop-out's own window is restored if minimized and focused.
It still counts as a use; nothing closes, reopens, moves or resizes (user ruling
2026-10-27). Centered panels stack like window pins: the one shown or raised last
is in front, and Esc hides that one. The **+** on the app's row
always creates and opens a new panel. New panels are named Panel 1, Panel 2 and
so on, with the app's lowest unused number; other names never change. Saved
panels are listed under their app; the dot shows whether each runs visibly,
runs hidden or is off, with the state in its tooltip (see Running in the
background). Apps are listed newest first, and each app's panels in the order
they were created, oldest first: opening, hiding or powering a panel on or off
never moves an app or a panel. Each app and its panels form one bordered block,
with the panels on a guide line under the app and a rule between panel rows
(provisional). Hiding or powering off preserves their data until Delete. The
catalogue is paged: use More apps / More saved panels (user rulings 2026-10-26).

An unpinned panel opens as a standard centered modal, with pop-out, a window pin,
Hide and Power off. There are two separate settings panels (user ruling2026-10-26).
The app-row gear in Apps opens App settings: the app's description above four
tabs, General (export and app deletion), Events (each declared event with its
description, read-only, following the definition live; user ruling 2026-10-27),
Permissions (Events allow/deny, Files
grants and pending changes and Internet access per site, with their existing
app-wide behavior) and Permission history (user ruling 2026-10-27). Allow once remains
in the active host's native prompt.

Each saved-panel row has its own gear, even when closed. That gear and the open
panel header gear open Panel settings for that exact panel. Its Name field, above the
tabs, renames the panel as Agent settings renames an agent: Rename is always shown,
is enabled once the trimmed text is a different, non-empty name, and applies at once, then the window closes with a notice; Enter does
not submit, and a refused name shows the error. Five tabs follow: General (Duplicate
and Delete panel), State (the panel's JSON data: Import, Export, Copy, Reset, Reload,
Save), Connections, Fire event and, last, History (event history). No tab repeats
its name as a section header or opens with an intro paragraph (user ruling 2026-10-28). Event publication/connections are panel-specific;
their permission remains app-wide. Placement is not a setting. No saved-panel selector or app actions appear
here. Manage a closed panel without running its HTML; menu paging exposes further
panels. The title-bar pin pins a panel to the window where it is, at its size,
like a pinned desk (user ruling 2026-10-26): it stays put while the canvas pans
and zooms, shares the pinned desks' stacking and edge snapping (Shift places
freely) and keeps its place after a restart; unpinning returns it to the
centered modal. Drag a pinned title or resize its corner. Canvas pins are gone
(user ruling 2026-10-26): a panel pinned there before reopens centered, and
orgtree_apps refuses mode canvas. The pin is hidden in a pop-out.
The pin shows filled and highlighted while the panel is pinned.
Returning from a pop-out restores its preceding placement for this session.
A popped-out panel stays popped out (user 2026-10-27): powered off and opened
again, it opens its own window again at that window's last place and size. Where
that window cannot open (pop-ups blocked, or no desktop), it shows at its
preceding placement, else centered.
Stored placements and running or open panels are restored after restart. Reopen a panel
from Apps if its canvas position is outside the current view.

**State** shows editable JSON for this panel. Save checks the revision and refuses
a conflicting edit. Import replaces the editor text; Save commits it. Export and
Panel use that text. Reset loads the app's initial state into the editor; Save is
still required. State must be a JSON object, provisionally at most2MiB. Deleting
a panel removes its state/events. Manage app > Delete app and panels explicitly
removes the definition and all panels. Confirmations belong to Orgtree, outside
the HTML. Panel links were removed (user 2026-10-26): agents follow a panel only
through app_listener subscriptions to its declared events.

The embedded app is opaque sandboxed HTML (allow-scripts only), with a restrictive
no-connect CSP and no engine credential; WebRTC is sealed off as well. Its async window.orgtree API provides
state.get/set/patch/onChange, storage.getItem/setItem/removeItem/clear, on and emit.
State is independent per panel; merge patch null deletes a key. Agent writes and
messages (orgtree.emit, orgtree_apps event) arrive through the host. History and
messages each keep their latest256 entries.
The SDK exposes fixed permission-checked actions through orgtree.call. Apps
supports whole-app import/export, with implicit local org access and no portable grants. Org defaults apply
independently of old capability declarations. Native frames, settings, import/export and permission
prompts use Orgtree's existing modal/settings design system outside app HTML.

Agent parity: orgtree_apps creates closed saved panels, starts any panel hidden
(panel_start), powers panels off (panel_stop), lists running panels with CPU
(runtime), and provides saved placement, label, state and event actions above; its events action reads the History log in the same pages (newest first, before for older rows, after for newer ones). Panel/export JSON are ordinary local file or
clipboard operations; drag/resize use panel_update placement. Apps-button/menu
visibility and far-zoom culling are display only. See orgtree-tool-apps
(orgtree-working > team).

## Org access and agent window boundary

Created, imported, template-restored and existing apps have implicit access to
this org through org.read, events.fire and docket.write, and read/write
access to this org's scratch, uploads and exact retained-delivery files. These
defaults do not depend on older capability declarations. Event names still need
declarations. Explicit user Ask or Deny overrides the default; Deny wins over
temporary, remembered and implicit file authority. Code replacement preserves
restrictive Ask/Deny choices while clearing external grants and old host sessions.
Native Permissions displays effective defaults separately from stored choices.

Apps reach agents only through events (user 2026-10-26): `mail.send` was removed. An
older app that declares it still imports and runs; the declaration is ignored and
never granted, and its send fails with a message that points to `orgtree.events.fire`.

Import warns that apps from outside this org have full access to the org and its
state, and that untrustworthy apps are dangerous. Authority is derived locally;
exported permissions, paths and references never grant it. The user accepts that
an app created by a subagent can affect a superior's state, as terminal access can.
App-origin content still has no user instruction or approval authority.
The import preview labels the app's name, notes that the app still asks before
reading or changing files outside this org (a chosen folder or the whole computer)
and counts saved panels. It lists no declared capabilities: they give an imported
app nothing beyond its org access.

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

## Files

Org collections have default read/write access. For outside files, ask through a native dialog. Select a
single file, a folder with descendants, this org's scratch/uploads/retained-delivery
collection, or the whole computer. Whole-computer access uses your Windows account
without elevation and can include private files/settings; prefer a narrower folder.
Allow once lasts while the panel runs, hidden or popped out included; Always
allow remembers that file or collection. Deny saves a refusal; Cancel leaves grants unchanged.
Imported apps and replaced code have no remembered grants.

App settings → Permissions → Files shows Read files and remembered scopes with
Revoke. Separate Read files and Write files controls govern distinct grants.
Ask/Deny clears remembered grants for that mode; revocation stops active media
streams and pending changes. Allow granted scopes creates no grant itself.
File paths stay native; an app passes readable contents on only through its events
or the work items it creates.
File requests and app import/export omit paths and contents from engine
diagnostics, including verbose file-worker logs; ordinary diagnostics stay enabled.
An app's docket assignment notices and event deliveries (and mail it sent before
mail.send was removed) appear in engine
diagnostics by mail ID only, also when they wake their recipient; agents still
receive them, and ordinary mail logs as before.

Every outside-org create, replacement or deletion needs native confirmation of its target,
operation, size and new-content hash. Existing files need explicit replacement;
folders cannot be deleted recursively. Changes are at most64KiB and use a staged
Windows commit. Unsupported platforms refuse writes. Cancel/expiry changes nothing.
Outside-org agent changes wait under Files → Pending changes; Refresh shows pending requests.
If a replacement conflicts, native UI reports any retained recovery copy beside
the original target. Review the result before retrying; concurrent files stay intact.
Only the user confirms them, and agents need their own writable folders as well.

The SDK adds files.choose(), files.open(root,path), files.read(file,{offset,limit})
and files.media(file). Store the returned opaque id in this panel's JSON, not
a temporary media URL. Reopening gets a fresh playback link automatically from
the remembered grant. Media uses byte ranges up to256MiB, outside the HTML/state
limits. A playback link keeps working while the panel runs: hiding, popping out
and returning keep it, and hidden media keeps playing (user 2026-10-26). Power
off, Deny, revoking access or a change that removes access ends it; moved,
deleted or revoked files need selection again. A duplicated panel cannot borrow another panel's file id.

Agent parity is orgtree_apps file_permissions/file_open/file_read/file_roots/file_list/
file_child/file_write/file_delete/file_result, requiring
the app grant AND the agent's held folders. Native picking/consent/revoke is
user-only; agents never self-grant. See orgtree-tool-apps for exact fields/limits.

## Internet access

Apps have no internet access until you allow it. An app declares the sites it
uses (a host, `*.domain` for subdomains, or any site), and anything else is
refused without asking. A visible panel asks the first time it connects to a site:
Deny, Allow once (until that panel is hidden or stopped) or Always allow this site.
A hidden panel can't ask; show it to answer.

App settings → Permissions → Internet access has the Internet access row (Ask,
Allow listed sites, Deny) and a row per declared site (Ask, Allow, Deny). Deny on
any row wins. Any site is its own row with a warning; Allow listed sites never
includes it. Hosts answered at a prompt under a wildcard get their own rows with
Remove.

Orgtree makes each request itself, over HTTPS, without cookies or sign-ins and
never to this computer or the local network. A site you allow can receive
anything the app can read. A code change clears every Allow; changing a
permission to Ask or Deny stops requests in progress.

Permission history, App settings' last tab, lists every permission change and
prompt answer for the app, newest first (the latest 128), as the same live list as
a panel's History: one line per entry (time, what changed and how, who) that expands
to its details, new entries while it is open and older ones as you scroll down.

Agent parity: orgtree_apps definition.sites, permission_set with site (agents may
set Ask or Deny only) and permission_history. See orgtree-tool-apps for exact
fields and limits.

## Mentions

Agents can point you at an app or one of its panels in chat, mail, presented
documents and docket text (user 2026-10-27). The mention shows the app's current
name, or the panel's app and label (for example Caption board · Panel 1), with
the Apps icon or a window icon on its left. Click it to do what its row in Apps
does: an app opens its most recently used panel, or a new one; a panel opens, and
starts if it was off; a panel already on screen comes to the front. Hovering shows
the row's tooltip. Right-click either kind for Settings (that app's App settings
or that exact panel's Panel settings) and Delete… (the existing confirmation,
never immediate deletion). App deletion removes its definition and all saved
panels; panel deletion removes only that panel. A panel mention also offers the
row's Start running or Power off. An app mention and its Apps-list row also offer
New panel: create a fresh closed, powered-off panel without opening its window.
Agent parity is orgtree_apps panel_open with app, which already creates closed/off.
A mention of a deleted app or panel, or of another
organization's, shows its token marked unavailable or other org and opens
nothing. The composer's @ menu offers every app and saved panel by name, newest
first; `@app:` or `@panel:` lists all of them (see orgtree-desk-chat).

Agent parity: every orgtree_apps app and panel result carries its mention token
in `ref`. See orgtree-tool-apps.

## Theme colors

Panels can use Orgtree's current theme colors (user 2026-10-27). A panel built to
use them follows your visual theme and contrast color (Display > Appearance) and
restyles at once when you change either, without reloading or losing its state; a
panel that sets its own colors keeps them. Agents read how in `orgtree-tool-apps`
(orgtree-working › team), under Theme colors.
