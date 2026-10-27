# Custom apps and saved panels (4.5.0)

## Background panels (2026-10-26)

User rulings 2026-10-26 (forwarded in m904ca9fb891f, plus m74c6e82ee894, the
answers m6ba7f81fde6c and the light ruling m5ff0338a79da):
closing a panel's visual does not stop it; a visible panel is always running and
a hidden one need not be stopped. Opening starts a copy, Start running (saved-row
context menu) starts it hidden, Power off (row and header) stops and hides it and
Stop all powers off every app. Restart restores each copy as it was. Panels run
only in the desktop app, including the tray, with no count cap. The window
header's Hide is its far-right X, after Power off (USER2026-10-26 m02d3caf61db2,
m4bff476c3659).

USER 2026-10-27 (m49226c1da1fb "for now make sure its known that rhey only run
while the main window is open"; principle me7bdb85fd566: apps are a custom UI for
the user to manipulate data in a structured way, not persistent program
environments; wording m281f01b7bf36, the user's choice "While Orgtree is open"):
the Apps menu shows "Panels are custom views; they run only while Orgtree is
open, tray included." under the saved panels, and the orgtree_apps description
and the app_listener event_name field carry the same clause. A main window
closed to the tray stays alive and keeps its panels running
(`main/window-close.ts`, `main/windows.ts`); quitting stops them. Running panels
without the desktop app is backlogged.

Migration 0067 adds is_running and run_generation (>0) with CHECK (NOT is_open
OR is_running); copies open at migration become running. Panel metadata reports
running/run_generation and list kind:panels filters running. Under the existing
app-then-panel locks: Open/Show sets both flags and bumps the generation only for
a stopped copy, so showing a hidden copy reveals the same runtime. Hide
(panel_update open:false) clears only is_open: it keeps host sessions and the
copy's file and media links, so hidden media keeps playing, and ends only
pending file requests and changes; the desktop refuses its open prompts (see
[links of a running copy](#links-of-a-running-copy-2026-10-26), which replaced
"Hide ends playback"). panel_start runs any copy hidden (user
or agent; running is a no-op). panel_stop clears both, bumps the
generation and revokes sessions, file links and the runtime lease. Both take an
optional expected_rev, checked only when given: power changes carry no data, and a
running copy's own state saves bump its revision faster than an agent can read and
act (author decision, phase 1; not a user ruling). User duplicates
open and run; agent-created/duplicated and imported copies stay closed and off.
Starts lock their app row, then refuse while the org killswitch is latched; Stop
all locks every app row in ID order and powers off every copy with panel.stopped
{reason:"stop all"}, so a racing start sees the latch or is stopped. Release
starts nothing.

Start/stop motion (USER 2026-10-27 m056a5c0bde3c: "a rapid zoom in / out", to
tell starting and stopping from opening and closing): display only, no engine or
tool change. usePanelMotion (canvas/apps/motion.ts) derives during render, from
consecutive listings, which copies started (running and open now, not running
before) or stopped (running and open before, not running now). Starts zoom in;
the first full listing (the store's `loaded`) restores and plays nothing. A
stopped copy keeps rendering its last running snapshot for PANEL_MOTION_MS (CSS
in apps.css matches) at its previous list index, since a DOM move reloads a
centred panel's iframe; PanelHtml's `stopping` releases its lease, bridge and
prompts at once, and the window is inert. Reduced motion keeps only the fade.

PROVISIONAL, not a user ruling: app_update restarts running copies with a new
generation. Visible ones reload the new code as before; hidden ones power off
with panel.stopped {reason:"code changed"} and stay off after a restart.

Bridge sessions bind the execution generation (session_open takes an optional
generation; absent binds the current one). The snapshot admits a running current
generation of the bound code without a latch, replacing the open check. A hidden
copy's consent request refuses with interaction_required before any Ask challenge,
file grant or HTML file-change confirmation is recorded; agent file changes still
wait under Pending changes. Agent scoped file calls need a running copy (formerly
an open one).

domain/apps/runtime.rs holds desktop leases per org/panel: one window owner per
generation, 20 s, renewed by POST apps/runtime heartbeat (desktop root header,
at most 4096 items). A heartbeat for a stopped/replaced generation
or a duplicate window gets that panel back in stop. Reports carry on-demand CPU
{cpu_percent, method: sampled CPU | shared process CPU}. orgtree_apps runtime
pages running copies with status running, error or not hosted plus the last CPU
report; sample:true emits custom_apps_sample and waits up to 3 s without holding
a database client. Leases never survive an engine restart; saved intent does.
The 4096 host-session bound stays a registry safety bound, not a panel cap.

Desktop: AppsWorkspace mounts every running copy. A hidden one is parked at its
own size, fixed in the viewport, transparent, inert and under everything, because
Chromium throttles cross-origin frames that are display:none, visibility:hidden or
outside the viewport (measured: display:none and offscreen sandboxed frames got 0
animation frames and 1 timer tick a second; parked ones kept full timer rates).
Parked frames get animation frames only when their window repaints, and none while
it is hidden, so requestAnimationFrame is not a background clock; app loops tick
from timers or a MessageChannel. MovableSurface preserveFrames moves use
Node.moveBefore, so hiding, pinning and unpinning (moves into and out of the org
pin layer) keep one browsing context. A move between documents (pop-out, return) still restarts the runtime.
PanelHtml no longer suspends on hide or a hidden owner document. Each window keeps
a sessionStorage owner ID and heartbeats every 5 s; a stop entry refreshes the
list. Main keeps a hosting window's and its popouts' background throttling off;
closing one of several org windows that hosts running panels hides it and finishes
the close when its count reaches zero; exit-on-close quitting is unchanged. Hide
in a pop-out hides that window natively. CPU sampling runs only while the Apps menu
is open or a tool asks. Chromium runs a window's sandboxed panel frames out of
process, all in one renderer process (measured, Electron 44.2.0). Each frame root's
own script time (CDP Performance ScriptDuration over about 1 s) is attributed
through the owner iframe's data-orgtree-runtime attribute (DOM.getFrameOwner).
Stack-sampling profiles cannot separate copies: copies of one app share compiled
scripts in that process, and a concurrent profile charged 1 of 8 busy copies with
everything (measured). Otherwise the cumulative CPU time of the processes hosting
the window's frames is reported, labelled shared and never divided;
getAppMetrics' percentCPUUsage is not used because it averages since whichever
call came before. Dedicated workers are not attributed per panel.

Measured 2026-10-26 (Session 0, a real 1024x768 window, Electron 44.2.0, 16
logical processors): the panel process used 28-34 MB private memory for 1 copy and
63-71 MB for 8 (each copy with a Dedicated Worker); a timer-driven loop doing 1 ms
of work every 20 ms cost 5% of one core per copy (sampled 4.7-5.0%) and 40% for 8,
the same with the window hidden. Idle copies with 100 ms timers sampled 0.02%
each. Hidden native windows: throttling on gave 1 timer tick a second and no
frames; throttling off gave 100 ticks and 60 frames a second for a plain page.

The CSP allows worker-src blob: only: Dedicated Workers built from local blob
scripts inherit the policy (no network) and end with their frame.

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

Migration0066 stores app origin and marks engine-owned implicit orgtree grant
rows. Their stable per-app/code/mode IDs preserve panel-bound references across
restart without storing a user Allow. Current Deny and org membership are checked
on every use; these rows do not count as explicit external grants. Metadata adds
default_permissions while permissions remains the stored override map.


## Durable declared event delivery

Apps privacy begins before logged agent adapters (MCP, direct tool, Codex and
the test-only rig transport), not merely inside the Apps domain handler. This
also protects read results and reflected refusals; ordinary tools retain normal
diagnostics. Independent dispatch tasks establish their own private scope.

`orgtree_apps fire_event` takes a saved `panel`, exact declared `name` and JSON
`payload` (64 KiB). Agents publish with org-modifying tools; a closed copy is
valid. HTML uses its bound `events.fire` action with no recipient or caller
selector. Migration0063 removes previous target-specific events.fire decisions;
broadcast uses effective defaults/overrides. Definition replacement
revokes external grants and sessions but preserves restrictive user choices. The shared60/minute execution budget survives host closure.

An agent creates `orgtree_watchdog kind=app_listener target=<stable app ID>`
with `event_name` and either one `panel` or explicit `all_panels:true`. Its
current live owner needs watchdog and Apps tools. Overlapping registrations for
the same owner/event are refused. Creator identity confers no right.
Pause/resume/remove, once, notice and explicit fire_actions keep watchdog meaning.
App deletion, removed declarations and specific panel deletion pause affected
registrations with a reason; returning sources do not silently rearm them.
Subscriptions/actions never travel in templates or portable bundles.
Shown dogs name their source (USER 2026-10-27 m7a692fd13b1d): the desktop
watchdog reads (watchdog_inventory) and orgtree_watchdog list add the current
app_name/panel_name through events::listener_names, one bounded read of
custom_apps/custom_panels per page, or app_deleted/panel_deleted once the row is
gone. Renaming or deleting an app or panel that has listeners announces
Change::Watchdogs, so the desktop rereads the names.

Publication locks the app and snapshots armed matching watchdog IDs atomically.
Provisional bounds:4096 registrations/app,128 pending fires/app, retained latest
128 completed fires. Overflow refuses before acceptance; zero subscribers is an
accepted zero-listener result. A listener added or resumed after the snapshot
cannot join that fire. Each recipient transaction locks one owner's ancestry
root-first, then app and watchdog, and rechecks live owner/tools/state/source.
Mail, one-shot spend and durable delivery are committed together. Actions are
claimed durably before execution (an uncertain crash may skip one, never repeat
it). No app gate or database connection spans nested action execution. The
shutdown-bound dispatcher recovers pending work and caps concurrent app drains
at four. Mail uniqueness is event×listener; diagnostics contain metadata only.
Authorized mail retains JSON and server-derived org/app/panel/event/time/producer
provenance. App content is not user instruction or approval. `listeners` lists
registrations in bounded pages. Each accepted fire also appends a metadata-only
`event.fired` row (`{event,id,subscribers}`, actor user/agent/app) to that copy's
bounded panel log inside the publishing transaction, after the app row lock. The
payload never enters that log, and the host does not relay the row into the app
(USER2026-10-26 mc8711410a925, History tab).

By the user's2026-10-26 ruling, docket.write create/assign/wake remains the
documented edge case that wakes a selected local agent without an app event.

Native Panel settings shows the copy's History on its History tab: only event.fired,
panel.started and panel.stopped rows (USER 2026-10-26 md6edfebc1975, "make it only
for fired events agents can listen to and starting / stopping, dont record anything
else"; answers mcbcd7b3cb6c0). Opening, showing or a user duplicate starting a
stopped copy records panel.started {reason:"opened"}; Start running records it
without a reason; Power off, Stop all and code changes record panel.stopped. Opens of
running copies, agent-created closed copies, label/placement changes and state
saves record nothing. The event action and orgtree.emit store kind message rows
apart from History (answer "Keep, separate"); events lists History and
messages:true lists messages. Each kind keeps its latest 256 rows and both advance
event_seq. Migration0071 added the kind, deleted the old panel.opened,
panel.created, panel.changed, panel.duplicated and state.changed rows ("Delete on
upgrade") and marked the remaining non-History rows as messages.
History is a live list (USER 2026-10-27 md2006b10cf40, "make the hidtory tab reload in
realtime, be more list like wity expandable rows, and lazily losd as you sfrollcdown
(remof3 th4 refresh button)"): canvas/apps/loglist.tsx shows one row per entry that
expands to its details and payload, reads the newest page of 50 first, then older
pages (events before) as the list's end scrolls into view, and on each live change
reads rows newer than its newest (events after), merged by seq; there is no Refresh
button. events pages newest first: before walks back, after reads newer rows oldest
first, both together are refused, and next_cursor continues the same way. Each writer
of one copy's log holds a lock the others need before it inserts (the panel row or
the app row for update), so its seqs commit in order and an after cursor never skips
a row. Live changes come from the org feed: custom_apps_changed, and
custom_apps_history {panel}, which an app's own orgtree.events.fire emits after
commit. That fire changes no Apps row, and the custom_apps_changed store refresh
re-posts state.changed to running apps, so an app firing on state.changed would loop.
Panel settings lists actual scoped
connections with bounded cursor paging on Connections, and permits explicit user
Fire event from that saved copy on Fire event, displaying acceptance/backpressure
without automatic retries.
Agent parity is Apps listeners/fire_event; agent subscription ownership stays
in watchdog controls. SDK orgtree.events.fire forwards only name/payload to
the existing parent-only action client. The native broadcast prompt explicitly
identifies every-listener delivery; no recipient/caller selector is accepted.

## Named event declarations

Migration0062 adds `custom_apps.declared_events`, defaulting to an empty array.
Definition `events` is a portable list of strict `{name,description?}` objects;
create/update/import, full reads, catalog metadata, export and template
capture/restore preserve it. Event names are unique, exact,1–80 characters,
without surrounding whitespace or controls; descriptions allow0–1,000 characters.
The provisional catalog limit is64. Declarations contain no grants, listeners,
recipients or fire actions. Old bundles without the field remain valid.

Declarations alone create no listeners. Durable publication and effective
broadcast permission use the separate explicit paths described above; the copy's
History log remains separate. The user explicitly retains docket
create/assign/wake as the direct-wake edge case without an app event
(USER2026-10-26 m556cde76bd33).

Source ruling: USER2026-10-25, custom panels headline. An org owns app definitions;
each app has zero or more saved panels. Every panel owns an independent JSON
object. Any live agent with org-modifying tools can operate on any copy in its
current org. An app's author does not acquire user authority.

## File access (2026-10-26)

Migration0064 stores app/code-bound native read grants and panel-bound opaque
references. Files are chosen in native Orgtree UI or opened from this org's
scratch/uploads/retained-delivery catalog. Native paths never enter the iframe
SDK or portable bundles. Once grants live in engine memory with the running copy;
Always grants persist in PG. Ask/Deny overrides org defaults; grant revoke/code
replacement clears external authority. Links outlive Hide, pop-out and host-session
renewal (see [links of a running copy](#links-of-a-running-copy-2026-10-26)).
Imported/duplicated state cannot reuse a file id
from another panel. Files settings live in App settings' Permissions tab.

POST apps/files requires the exact native desktop header. It accepts native
Call/Decide/Permissions/Revoke/Browse/Confirm/Confirmations; iframe methods are the fixed file SDK,
validated by parent and engine. Bounded reads allocate at most64KiB. Agent actions
file_permissions/file_open/file_read additionally require live orgmod and current
held folders, rechecked before disclosure; agents never decide grants. Orgtree
artifacts means this org's retained deliveries, not a global output directory.

Sandbox frames never receive desktop headers. Only exact GET apps/media bypasses
the general header check and independently validates a64-hex asset ticket bound
to the running copy (org/app/code/panel/execution generation) and its file
grant. Each range revalidates, under the app gate, that the copy still runs with
the same code and generation and still has file authority; active bodies end
when the copy's links end. A copy keeps its64 newest tickets. CSP adds only the exact generated
host media endpoint; connect stays none and other API paths remain blocked.
Private-app logging omits ticket queries and file/stream data. Opened handles
use the existing ancestor-pinned no-reparse IO. No PG handle/transaction spans
disk IO, native consent or playback. Media cap256MiB; no video is embedded in state.

Migration0065 adds separate read/write modes and folder/computer scopes. Existing
grants remain read-only. Native consent warns about whole-computer access under the
current Windows user, without elevation (its readable-data-plus-mail.send warning went
with mail.send, USER 2026-10-26). A chosen folder covers descendants; links/reparse points are refused.
Read and write remain separately overridable capabilities. Grant limits128/app,
refs1024/panel, registry4096/class; prompts120s, host sessions30min (renewal
keeps links); media tickets live with their running copy, 64 per copy.

files.grant(scope,mode) requests native consent for orgtree/folder/computer and
read/write. It returns opaque directory roots; persist these in that panel's
state. files.list(directory,{after,limit}) and files.collection(root,options)
page up to200 entries, scanning at most20,000 with scan_limited disclosure.
Directory enumeration uses the opened directory handle, not path-based read_dir.
files.child(directory,relativeName) opens a descendant reference after checking
the current grant. files.write(directory,name,base64,{replace:false}) changes at
most64KiB; an existing file refuses unless replace:true. files.delete(file)
deletes a regular file only. Every outside-org create/replace/delete needs native confirmation
outside HTML of the exact target, operation, size and new-content SHA256. No
recursive delete, shell command, arbitrary endpoint or permission method exists.

Changes retain no-reparse directory/target handles while consent is pending.
The Windows target pin excludes ordinary data writes/delete. Replacements stage
and flush bytes, rename the exact old handle to a fresh recovery name, then publish
the new handle without overwriting a destination. There is a brief name gap;
a concurrent destination is never overwritten. Failure restores the original
name when possible; otherwise original bytes remain in the reported recovery
file beside the target. Native UI reports retained recovery copies, independently
of the HTML. No path-based fallback or in-place truncation exists. Platforms
without these mutation primitives refuse writes.
Pending changes are bounded64/engine, expire120s with target-pin cleanup, and are
discarded on grant/code/host revocation. Outside-org data never changes before confirmation.

Agent parity adds file_roots/file_list/file_child/file_write/file_delete/file_result. Reads
need current read folders; writes need current edit permission and writable
folders AND effective write authority for the target. The fresh scope chain includes parent
ceilings and implicit shared folders. The readable org instruction workspace is
not an implicit writable folder; writing there requires an explicit effective
RW grant. Outside-org agent changes wait in native App settings → Permissions → Files →
Pending changes; refresh shows exact target/size/hash.
Agents get a pending confirmation ID and can read their own one-shot result for
120s after a decision. They never choose roots, grant permission or confirm a
change. All callbacks recheck the saved panel/code/grant and live caller scope.

## Links of a running copy (2026-10-26)

USER 2026-10-26 22:09Z mf7add4fda093 "yes please", via @coordinator-opus
me5464e3d35c4 and @liaison-opus m5bc999edb0cc. The user rejected an SDK notice event
first (mb26ead2c2190: "that would involve a generic video link locating system,
wouldnt it? seems not very agnostic to app strufture, tightly coupled"). This
replaces "Hide ends playback" and "Closing/hiding ends host links". [decided:
user 2026-10-26]

An app's file and media links (Once grants and Once references, media tickets)
belong to the running copy: its panel, code revision and execution generation,
not the host session that asked for them. Any host of that copy can use them; agents
never see Once links.

| Event | Links |
|---|---|
| Hide, Show, pop-out, return, a closed window | kept; hidden media keeps playing |
| Host session close, expiry or renewal | kept; that session's open questions end |
| Files change that grants or keeps access (Ask to Allow, default to Allow) | kept |
| Files change that removes access (to Deny; Allow or default to Ask) | ended |
| Grant revoke, Deny in a prompt | ended |
| Power off, Stop all, delete, code change | ended |

Ended links refuse at once, and active media bodies stop. Hide and a closed,
expired or renewed session end pending file requests and changes, because those
are questions for one host. A permission change is judged on effective access
(`policy::org_allowed`) before and after; Deny always ends links, since it also
overrides Once grants. Each media range revalidates the copy (running, same
generation and code) and its file authority under the app gate. A ticket no longer
expires with its session; a copy keeps its64 newest, and a newer one ends the
oldest. [verified: `domain/apps/{file_access,file_scopes,bridge,storage}.rs`,
`http/{app_files,media_file}.rs`]

Cause (measured 2026-10-26): the caption-placement App's remembered video
loaded, and Play then failed. The live engine log shows one element's ticket
refused (403) ~22 times right before the user's report. The ticket died with a
Hide, a Files change or a session renewal while the App's iframe survived it, and
the App asks for its video only once. Proof: a Session 0 rig repro (synthetic
silent MP4, agent file_open plus state_patch as the user's agent did) failed at
the base on Hide/Show, hidden play, renewal and Allow, floating and popped out,
and passed at the fix; power off and Deny refuse the ticket in both.

## Internet access (2026-10-27)

USER 2026-10-26 21:39:08Z m95c57abc95fb "build internet access as a permission
for the apps" (after md17a57ff4b17 "can apps have internet access (as a
permission)?"). Design note m0a85164bc1d8, accepted provisionally by the liaison
(m232e1d1ccb57); the user may override it.

Shape:
- Capability `net.fetch` ("Internet access"). It is not in ORG_CAPABILITIES, so
  it is off for created, imported, template and legacy apps alike.
- `definition.sites`, at most 32: `host`, `host:port` (443 when omitted),
  `*.domain` (subdomains, never the apex) or `*` (any site); lowercase names or
  IP literals, IPv6 in brackets. Inert portable data like events: create, update,
  import, export and templates carry them, never a grant; an empty list is
  omitted from exports so an older Orgtree still imports them. Stored in
  `custom_apps.declared_sites` (migration 0072).
- Decision (`policy::net_decision`): no declaration covering the host refuses
  without a prompt; capability Deny refuses; any stored row covering the host
  that says Deny refuses (Deny wins, `*` Deny over a narrower Allow included);
  else a covering Allow allows and a covering Ask asks; else capability Allow
  ("Allow listed sites") allows hosts a non-`*` declaration covers; else Ask.
  `*` needs its own Allow.
- Rows (`custom_apps.site_permissions`, at most 128): a declared site, or a
  concrete host a prompt answered under a `*.domain` or `*` declaration
  (`policy::net_site`: the exact declared site that covers the host, else the
  host itself). permission_set takes `site` and ask/allow/deny/default for
  net.fetch; default removes a row, even one no declaration covers any more.
- Agents: permission_set from a caller may only set net.fetch (capability or a
  site) to ask or deny, and may not replace a stored deny. Allow, default and
  every other capability stay the user's.
- Prompt (visible copies only; a hidden copy gets interaction_required): method,
  URL and the row name, never headers or body. Deny stores a site Deny and aborts
  the app's requests in flight; Always allow stores a site Allow; Allow once is
  held in engine memory for (panel, run generation, site) and ends on hide,
  stop, restart, code change, delete, Stop all or a net.fetch change short of
  Allow.
- Permission history (`custom_app_permission_log`, migration 0072): every stored
  permission change (via change), prompt answer including Allow once (via
  prompt) and each Allow a code change clears (via code, permission default),
  for every capability. Written in the change's own transaction; latest 128 per
  app; `permission_history` reads it newest first (a GET read; agents included),
  paged like events: limit 1-200 (default 100), before for older entries, after
  for newer ones, never both. App settings shows it on its own last tab (USER
  2026-10-27 m838e66af753b, "ssme for permission history, and put tgat on i6s own
  tab") as the same live LogList as History; it follows custom_apps_changed only.
- A code change clears every Allow, capability and site rows alike, as for
  outside file grants; Ask and Deny stay.

The request (`domain/apps/net.rs`). PANEL_CSP (connect-src 'none') and the
window session are unchanged. orgtree.net.fetch(input, init) builds a Request in
the frame and posts one bridge call `{action:"net.fetch", url, method,
headers:[[name,value]], body}` (base64); the reply `{status, headers, body, url,
redirected}` becomes a Response. Under the app gate the bridge checks the
running generation, Stop all and the decision, admits the request (120 a minute
and 8 in flight per app, apart from the 60/min action budget) and releases the
gate before any I/O, so a revoke never waits behind a slow site: it cancels the
request.
- HTTPS only; GET, POST, PUT, PATCH, DELETE, HEAD; no Cookie, Host, Proxy-* or
  hop-by-hop header; at most 64 headers and 64 KiB of them; URL up to 8192;
  body up to 1 MiB (the bridge route admits 1.5 MiB for net.fetch only, every
  other action keeps its 72 KiB bound); response up to 4 MiB; 30 s for the whole
  request, every hop and the body included.
- reqwest without its cookies feature (no jar; Set-Cookie dropped), no proxy, no
  Referer, no default headers, no engine credential.
- The resolver refuses a name if any address is non-public (the
  `http/markdown_image.rs` classification) or this machine's own (a connected
  UDP socket picks the address itself as its source; nothing is sent), and the
  client connects only to the vetted address, so DNS rebinding cannot move it.
  Redirects are followed by hand, at most 5, each hop re-checked against the
  grant and the resolver; 307/308 keep method and body, others continue as GET;
  Authorization is dropped when the host changes.
- Logs name app, panel and capability only. URLs, headers and bodies are private
  app content (`trace::private_app`; `Fetched` has an opaque Debug).

Plain fetch, XHR, WebSocket, EventSource and URL images stay blocked; an app
shows a fetched image through a blob: URL. WebSocket is out of scope.

Verification (measured 2026-10-27, Session 0, one build-slot permit):
- Engine `domain::apps` 61/61, including a local TLS server (rcgen) reached only
  through the test-only `TEST_ROUTES`. A granted host answers, with no Cookie sent
  and Set-Cookie dropped. Ungranted hosts, a cross-host redirect, loopback, a LAN
  address and http are refused; Authorization does not follow a host change; a
  revoke aborts an in-flight request.
- The engine test binary no longer fits a 6144 MiB Job: the front end alone
  reached 5.3 GB RSS before codegen and the Job peaked at 6.3 GB. It runs in
  8192 MiB (coordinator, 2026-10-27). `tools::defs` has 2 failures identical at
  base 393c80c (description total 12477 over 12000; the watchdog card snapshot).
- `tools/rig/proofs/app-internet.mjs` 22/22 through the real bridge, storage
  and tool routes, with nothing leaving the machine. With a renderer build it
  also captures the real prompt and the Permissions tab in Session 0, muted,
  with the clipboard and permissions refused.
- Renderer `customapps*` 55/55. The new tests fail 4/4 against the base app
  sources.

## Storage milestone

Migration0058 creates org-scoped custom_apps, custom_panels and a bounded panel
event stream. Composite foreign keys prohibit cross-org panel/app references.
Code and state are separate columns: paged catalog queries exclude both. Closing
sets open=false; it does not delete a panel. Explicit panel deletion removes its
events. App deletion refuses saved copies unless delete_panels=true.

The authenticated user route is POST /api/orgs/{slug}/apps; orgtree_apps is the
agent parity route. Both parse the same deny-unknown-fields request vocabulary.
The agent identity/org come from the trusted Caller, never JSON arguments. Agent
mutations re-read live identity and inherited tool scope under canonical
root-first scope locks, then lock app before panel. These transactions never take
the org revision lock. After commit an org custom_apps_changed frame invalidates
readers (an app's own fire sends custom_apps_history {panel}, which only History
lists follow); reconnecting readers must perform a fresh bounded read.

Migration0061 adds org-owned `is_new` metadata and a partial unseen-app index.
App list pages include the org's complete `new_count`, independent of the page;
metadata includes `is_new`. Creation/import/template restoration default new,
including existing definitions at migration. Provisional self-import choice:
native user imports count too. Definition updates never reset seen status.
`mark_seen` takes1-200 unique explicit app IDs. It locks matches in ID order,
ignores unknown/deleted/other-org IDs, and returns seen IDs plus the remaining
count. It requires ordinary Apps scope, grants no authority, changes no app/panel
revision and emits the existing invalidation only after a committed change.
GET refuses it. User and agent operations share this contract.

The menu acknowledges only intersecting entries in its owning scroll viewport,
keeping New labels for that visit. Background catalog loads acknowledge nothing.
The header reuses attention-mail glow/count CSS. Reads begun before a local
acknowledgement cannot resurrect the count; local acknowledgements serialize.
Seen flags are UI metadata and never travel in app bundles or templates.

Metadata/state mutations and duplication/deletion require expected_rev (power
changes take it optionally, see Background panels). A stale
revision refuses409 rather than silently overwriting. State patch uses RFC7396:
objects merge, arrays replace and null removes a key. State set can retain a null
value inside its replacement object. Events use monotonic sequence cursors, newest
first with before or oldest first with after, and retain the latest256 per panel and
kind; oldest_retained makes truncation explicit.

## Provisional defaults for morning review

The app row opens its most recently used panel by explicit panel ID, wherever
the list shows it (the copy panel_open with only the app would pick: used_at,
then ID), or sends panel_open with only the app when it lists none, so the
engine creates the first; its + sends new=true and always creates another.
USER2026-10-26 m0d853b77c816 named the first listed copy, which was the most
recently used; since panels now list in creation order, @coordinator-opus
2026-10-26 keeps the most recently used one (provisional). A row whose panel is
open and visible first brings it to the front (USER 2026-10-27 mffd8da23dc8f): a
pop-out's live window is revealed (restored and focused, never reopened), a window
pin raised in the pin layer, a centered panel put in front of the other centered
panels, which take .custom-app-behind (z 29, 39 on mobile) and stop answering Esc
(provisional stacking); then its window takes the focus, so Esc still hides a centered
one and Tab enters its content. The click still sends only
panel_open, the use, so used_at and the app row follow it. Rows go through
openAppPanel(slug, {panel} or {app}) in `canvas/apps/ui.tsx`, the one entry point
mentions reuse; for an app it raises the engine's pick only if that copy was
already visible. A new panel without an explicit label is
named "Panel N", the app's lowest unused positive number among exact automatic
labels, chosen under the app row lock (USER me02e165c08fe;
`domain/apps/labels.rs`). Existing, explicit, imported and duplicated labels never
change. Saved-panel rows show state by their light alone, filled while visible,
an accent ring while running hidden and hollow grey when off, with the state in
the tooltip and accessible label (USER m5ff0338a79da; three states since hidden
panels keep running). The Apps list shows apps newest first by created_at and
each app's panels in creation order, oldest first; opening, hiding and power
never move a row (USER 2026-10-26 mf87be90ee3c8, m1e0117740c5f "newest first",
"Fixed order"). List, app_get and panel_get metadata carry created_at, but list
pages stay in ID order, so past one page (100 apps) a newer app from a later
page joins the top only after More apps. Each app and its panels form one
bordered block with ruled panel rows (USER m68e69e302bc4; provisional;
`canvas/apps/{store.ts,ui.tsx,apps.css}`). Definition initial_state is copied, not shared.
Updating initial_state never overwrites existing saved-panel data; it applies
only when a new panel is created. The focused apps-new real-PG proof covers this.

The signed centered-modal rule supersedes the original fixed floating default:
placement float renders a viewport-centered overlay (stored x/y are unused in
that mode). The header pin pins the copy to the window like a pinned desk (USER
2026-10-26 m5bf326d39c4b, "i meant pin it to the window like other pinned
panels"): mode window stores the panel's current on-screen box as x/y pixels from
the org canvas area's top-left plus width/height. A window pin renders in the
org pin layer (pinLayerFor) and shares canvas-area coordinates, stacking
(usePinSurface, raised on press) and snapping (findPinSnap, Shift for free
placement) with pinned desks; render and commit clamp it into the canvas area,
and a drag commits once, from where the pointer ended. Unpin returns to float;
the pin is hidden in a pop-out, and native pop-outs keep the existing
saved-window lifecycle. Canvas placement is retired (USER 2026-10-26
m2b682426170d, "Remove canvas pinning"): the wire refuses mode canvas, the
retired mode screen (pointing at window) and any node anchor; the anchor field
still parses as null for older clients. Migration0069 reopens stored canvas
pins as float (provisional, liaison: they reopen centered). The iframe remains
the same subtree across pin/unpin.

Separate native settings replace the former combined App/This panel view
(USER2026-10-26 m9f3ddc116f78). App-row gear opens AppSettings: the description
above the tab row, export/delete in its General tab with no section header or
creator row (USER2026-10-26 m7d07ebe438b4, mc6d6096f5206) and the embedded
AppPermissions in a second Permissions tab (USER2026-10-26 m1fcbeca9488e): Files grants, pending
changes and events.fire allow/deny. Panel-row and open-header gears open
PanelSettings bound to one explicit panel ID, including closed copies; no MRU
selection, HTML startup or app actions. Its Name row reuses the Agent settings
rename row (USER md4315f720ecc): panel_update label on Rename, which shows once the
text differs, then the app toast (ObjectMenuBoundary's CopyFeedback) and close; no
Enter submit, and refusals toast the engine's message. Its General tab keeps
duplicate/delete and its State tab (USER m1d9d1f971c9a) the JSON editor (panel_get,
revision-checked state_set, Reload), all on their existing tool calls, with no section
header (USER m5e1010314d2c). Connections and Fire event have their own tabs (USER
meb312360e19f) and History comes last (USER m547bae9b0585); it holds the copy's
log (USER mc8711410a925), merged from the former Activity view. All three stay
per-copy, no tab repeats its name as a section header, and History follows the
live change feed (no Refresh button or remount after a fire). Delete panel/app confirmations are compact content-sized
AppDialogs (custom-app-confirm, USER mf913dbdf1494). Linked agents (USER
m66c0f064351c) and placement (USER m79ee175a5283, m5fca61662c5b) left settings;
placement stays on the window and in orgtree_apps. Once stays in live native
host consent. Both use the shared SettingsTabs/SetRow/AppDialog design system and independent
pin identities; owner-document context also wraps their nested dialogs. All
three settings entry points are display only; orgtree_apps retains action parity.

Entry HTML is limited to4MiB, state/initial state to2MiB compact JSON, nesting to64,
and event payloads to64KiB. Pages
default100, maximum200. These are provisional bounds, not new user rulings.

The bound HTML bridge exposes fixed org actions under the effective policy above.
General user operations, question answers, publishing, arbitrary HTTP and caller
selection remain excluded.

Org-modifying tools uses tools.orgtree.orgmod. Logo moves into the category.
The legacy logo key remains an accepted compatibility alias: when orgmod is
absent, an explicit old Logo denial also denies the replacement category. An
explicit orgmod value takes precedence. Parent intersection still clamps the
category. orgtree.logo scope requests resolve to the canonical orgmod grant.

Other provisional choices retained for the next slices: per-app default/Ask/Allow/Deny
outside HTML, exact-request Allow once, no network/no same-origin, suspend hidden
scripts (superseded 2026-10-26: running copies keep running hidden, see Background
panels), optional accumulated state in export, no portable execution grants,
and template definitions/initial state only.
Mail identity and creator-retirement policy remain morning questions; no default
may silently turn an agent panel into general user authority.

## Apps host milestone

Migration0059 adds a panel event high-water mark and an open-panel partial index.
The active workspace pages open:true; historical saved copies are fetched only
when the menu is opened. GET /api/orgs/{slug}/apps?request=<JSON> whitelists list,
app_get, panel_get and events; mutations remain POST. The renderer uses dedicated
custom_apps_changed invalidation, not the generic live-bump loop on every edit.

AppsButton/AppsWorkspace own one org menu and stable per-panel MovableSurfaces.
Window pins join the org pin layer, not the chart, so they add no chart nodes
and never change tree layout; the canvas wheel ignores a panel's frame and title
bar. A hidden running copy is parked (Background panels).
Panel state, not renderer geometry globals, persists placements and open copies.

PanelHtml uses sandbox=allow-scripts (no same-origin), an opaque-origin exact-frame
message check, a per-mount random channel and a restrictive prefixed CSP.
The iframe supplies a reply MessagePort in its ready handshake. Replies use that
port: adopted pop-out handlers still execute in the main JS realm, so their
window.postMessage sender would not equal the iframe's new parent window. The
parent binds state and events to its own panel ID, serializes writes, checks
revisions and caps messages/rate. It exposes no credential, generic HTTP endpoint,
permission decision or caller selection. Frame content is untrusted even after
the envelope check. The bridge rechecks engine-side app revision, panel and
capability and invalidates mounted sessions on code replacement/closure. Self-navigation network containment
requires native-window verification before a no-network execution claim.
WebRTC is outside CSP: since 2026-10-27 main seals it for every webContents
(no UDP) and for the window session (a proxy that does not exist for all TCP but
the engine's host 127.0.0.1), measured closed on panel frames, chat HTML replies
and inline and windowed presentations. See [sandboxed agent HTML](../agents/desktop-and-renderer.md#sandboxed-agent-html-has-no-network-webrtc-included-2026-10-27-450).

The async SDK is window.orgtree state.get/set/patch/onChange; storage.getItem,
setItem, removeItem, clear; on(name,fn); emit(name,payload). Storage values are
JSON, not strings only. State patch follows RFC7396; null removes keys. The host
does not replay retained messages on opening. It reads new messages (events
messages:true) after that panel's initial event_seq and forwards each to on();
History rows never reach the app. Until 2026-10-26 hidden/closed
frame scripts were discarded; a hidden running copy now keeps its scripts and
timers (Background panels). A powered-off copy reconstructs from committed state.

## Permission-checked backend bridge milestone

The engine now owns ephemeral host sessions at POST /api/orgs/{slug}/apps/bridge.
This route and permission_set require the exact desktop root header, not an agent
or standalone client token/bearer. Request/response bodies under apps and every
descendant are excluded from HTTP body logging, including malformed refusals.
Sessions are bound to org, panel and app code revision, expire after30 minutes,
and revoke on host close, power off (panel close until 2026-10-26), panel delete
and app code replacement/delete.
A closed, expired or renewed session ends only its own open questions; its
copy's file and media links stay (since 2026-10-26, [links of a running copy](#links-of-a-running-copy-2026-10-26)).
No session survives engine restart. The registry holds at most4096 sessions.

Local org policy derives defaults; explicit stored choices override them. A Call validates a strict
named action and checks current code revision, running generation (formerly open
panel) and capability under a
per-app async gate. Permission, code and panel mutations acquire that same gate
BEFORE agent/database locks. The gate remains held through dispatch; no database
client is held while another domain service acquires its own. Weak gate entries
are pruned rather than growing with inactive app history. Per-app action rate is
provisionally60 dispatch attempts/minute across all its copies. One admission
point covers direct Allow and successful Once/Always decisions immediately before
dispatch. Ask/Cancel/Deny do not execute. Rate history survives the last session
and weak gate; only inactive histories past the full60s window are pruned.

The private Apps HTTP boundary strips query strings and wraps all awaited nested
services in a task-local opaque-log scope. Logged method arguments/results and
manual event fields are omitted there; request path/status remain visible and
ordinary callers retain diagnostics. Bridge dispatch also enters the scope for
non-HTTP internal callers. The scope does not propagate across spawned tasks.
Every file-access and import/export blocking worker uses
`trace::private_app_blocking`, which enters `PRIVATE_APP.sync_scope` inside the
worker: nested logged path normalizers and manual events remain private there,
including after cancellation of the async caller. The previous worker scope is
restored on return or unwind. Independent async consumers establish their own
scope. A real-file verbose canary covers reads, listing, Windows changes and
bundle IO, preserving authorized results and ordinary worker-log positives.
Invalid read requests return a fixed parser refusal rather than reflecting caller
content.

Mail carries app content past the private request. The notice of a docket item an
app creates and assigns, its named event's delivery and any mail it sent before
mail.send was removed are written
inside the scope, but the recipient's actor reads them back from the database
outside it, and its turn start logs that input (`Actor.session_notes`,
`Actor.rels_of`, `envelope::ping_for`, `alert_turn`). The log renderer therefore
recognizes app content by value, as it does reply selections and thinking:
`trace::private_app_content` matches a stored row or the agent's `Mail` with an
`app:` sender, an `app:` actor on its event or an `extra.app_event` delivery
(`Mail.private_app`, set by `mail_of`), and any object an app caused or that quotes
or lists its mail (an `app:` `actor`, `sender` or `from`). Each renders as
`[private app mail <uid> omitted]` in call/return members and REQUEST/RESPONSE
lines. Ordinary mail renders unchanged, and the agent still receives the content.
The composed turn and steer texts already render as `[thinking omitted]`: the
encoded-payload rule fails closed on their `[` block header, and a unit canary
pins this for app content. The rig control `tools/rig/proofs/app-mail-wake-privacy.mjs`
covers an ordinary-only wake and a mixed wake (event delivery and docket notice since
mail.send was removed). Limit: an app-created item's own
title and objective are ordinary docket content once read back; the desktop's read
logs them (`domain.docket.load`, `http.docket.get` and its RESPONSE line, as the
control's closing note measures).

App event privacy also travels in Event provenance through subscriber channels
and overflow cells. Its Debug formatter is opaque even outside the producer task.
The receiving runner scopes the complete mixed batch and pending delivery before
Access/Pending/save/fire services. Payload remains available for authorized regex
matching and delivery. Diagnostic last_output and fire-history gists omit private
app content, so persisted progress cannot leak it on a later ordinary load. Error
retries retain metadata only. A canary uses actual emit/subscription/overflow with
an independent consumer created before the producer's private scope; it verifies
the original delivery bytes and ordinary-log positives as well as omitted logs.

Ask stores one exact action under an opaque challenge for120 seconds. Decide
consumes it once. Once executes only that action; Always stores Allow for its
capability; Deny stores Deny. permission_set requires current app expected_rev
and expected_permission_rev. Grants have their own revision (migration0060), so
changing a grant does not reload code or lose the action reply. Agent callers
are explicitly forbidden from deciding permissions. Code replacement resets
external grants and revokes sessions, retaining restrictive Ask/Deny. Import/export never carries decisions.

The action vocabulary is limited to org.read (paged active chart metadata, not
private mail/files), docket.create (one new open non-code item with
title/objective/owner) and events.fire (a declared named event broadcast to
subscribed app_listener watchdogs). No general ops/HTTP, identity selection,
question answering, release actions, outside mail, user mail or project mail.

Apps reach agents only through events: mail.send was removed (USER 2026-10-26
m61de6ee6429c "i want to keep agent notification purely through the event system,
no targeting agents directly"; mdacb9d629e59 "Remove; import, never grant"). The app
mail sender (domain::mail From::App) and its reply-audience and target guards went
with it. Old definitions that declare mail.send still validate
(wire::RETIRED_CAPABILITIES), so they import and run, but the declaration is dropped
before storage (wire::current_capabilities) and from app metadata, also for apps
stored earlier (policy::metadata), and stored grants never allow it
(policy::available). An app's mail.send call and permission_set for it refuse with
wire::MAIL_SEND_REMOVED, which points to orgtree.events.fire and app_listener; the
desktop action client refuses first with the same text. App content is not a user
instruction or approval. Docket creation records an app/panel actor. events.fire cannot spoof
an arbitrary engine event kind. All payloads/actions are bounded to64KiB.

Provisional docket.write authorizes creation AND assignment, waking the selected
live local owner. The native grant states this explicitly. Both fallback mail
and typed assignment envelopes label app-origin work as app content with no user
instruction/approval authority. The user explicitly retains this direct-wake edge case.

## Whole-app portability backend

Provisional version1 `.orgtree-app` JSON carries format/version, a strict
Definition and optional `{label,state}` copies. Limits:16MiB serialized bundle,
16 copies, existing4MiB HTML/2MiB state/depth bounds. Imports validate before DB
access, generate new IDs, derive local org authority without portable grants, and create copies closed
with default placement. Neither script execution nor host creation happens on
import. No runtime IDs, grants, sessions, geometry or credentials travel.

Export takes expected_rev and the app row lock shared by all panel writers,
giving one app/copy snapshot. It refuses more than16 selected copies rather than
silently truncating; definition-only export is still available. Import is atomic.
HTTP uses strict app_import/app_export requests. Agent tools share that service,
adding import path or export as_file (defaulttrue) adapters with fresh live/orgmod
checks. Authority comes from the original lexical held root, pinned without
following its components, never from canonicalizing a mutable root. Original
relative descendants use pinned handles (Unix openat, Windows NtCreateFile with
RootDirectory and no-reparse options). Windows pins deny data-write/delete
sharing, including pre-opened data mutators; attribute-only writes may not conflict,
so the handle-relative opens are required. Every opened Windows handle's final
path must also match its pinned path.
Final opens refuse links/reparse points. Absolute paths cannot contain parent
components. Imports stay within held roots, bounded by both file metadata and
actual bytes. Exports create_new only in the agent's existing private scratch,
returning path/bytes/SHA256; no DB connection or lock spans file IO. Native Apps-menu
file selection shows a plaintext preview before app_import (labelled name, any
description, the outside-file consent note and the saved-copy count; no declared
capabilities, which add nothing to an imported app's org authority);
it mounts no imported HTML. Manage app exports through the same app_export route
with an unchecked-by-default saved-data option and an owning-document file anchor.
Whole-app file exports serialize compactly and check the exact UTF-8 bytes before
Blob creation, so valid deep state does not expand past the import cap. Ordinary
panel-state JSON export retains its readable formatting.
These defaults await morning review.

## Templates and the retired panel links

Provisional Save as template carries strict app definitions/initial state only,
within its existing16MiB total file bound. It does not query saved copies,
permissions or runtime IDs. Template App has opaque Debug and generic
validation errors, including when a logged template service returns it. The
new-org transaction inserts fresh implicit-org-authority definitions atomically alongside
its nodes. No panel/iframe/host session is created and no script executes.

Panel links are removed (USER2026-10-26 mbb2b54092d1f, "Remove completely";
m66c0f064351c: agents are linked by listening for panel events now). Panel
metadata omits linked_agents; any Apps request carrying linked_agents is refused
with directions to app_listener; duplicates copy no links; state set/patch and
explicit panel events no longer emit app.event watchdog signals. Migration0068
empties the inert linked_agents column, kept so an older build still reads its
rows. The watchdog event bus keeps its private-payload handling for the retired
app.event name as defensive code with no producer. Agents reconcile through
panel_get/events and their cursor; the latest256 boundary stays explicit.

docs/examples/apps/annotation-notes.orgtree-app is a small inert portable sample:
independent state, explicit save/reload and a declared notes.ready event fired with
orgtree.events.fire.
It is not auto-installed or auto-opened and does not reproduce an unavailable
historical annotation editor. The focused wire check validates its actual file.

The explicitly assigned narrow real-engine persistence/privacy proof is
tools/rig/proofs/custom-apps.mjs. It uses isolated PG and fake CLIs, checks the
actual routes/dispatcher, restart/cascade, portability/templates, permission
revocation and the already-running DB watchdog's private-event mail path.
Keep its raw diagnostics and positive delivery controls; unit synthetic Access
coverage alone is not an end-to-end privacy claim.

## Native action host implementation

The SDK exposes `orgtree.call(action,args)`, forwarding only the fixed vocabulary
above. The parent rejects extra identity/action/panel selectors and bounds action
JSON to64KiB before the engine independently validates it. Main-realm requests keep
native desktop authentication after a portal adopts the React DOM. Only the parent
keeps the expiring engine session; replies to HTML contain operation results only.

Permission-required responses render a native owning-document modal OUTSIDE the
iframe, with complete action JSON as text. Buttons send only the engine's exact
session/challenge/choice. Once/Always/Deny are provisional defaults. Cancel,
Escape and120s prompt expiry close the session and discard the action without
persisting Deny. No ambiguous action failure retries automatically. SDK action
timeout150s allows the120s prompt; state requests retain30s.

Lifecycle effects create disposable clients, including StrictMode replay. Unmount
(power off), owner/channel/generation/code changes abort pending native prompts,
close reply ports and sessions, and close a delayed session_open result before it
can dispatch. Since 2026-10-26 Hide only refuses open prompts (interaction_required)
and keeps the session.
Permission edits use their separate revision and do not reload code. Native
Permissions saves Ask/Allow/Deny immediately for all copies. Real-PostgreSQL
persistence and capability execution/refusals remain part of the proof before alpha.

The provisional queue also caps pending recipient deliveries at8,192 per app;
publication refuses before that snapshot would exceed the bound.
