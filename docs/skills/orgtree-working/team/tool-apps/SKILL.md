---
name: orgtree-tool-apps
description: "Manage org app definitions, independent saved panels, JSON state and recent events."
---
Up: [orgtree-team](../SKILL.md)

# orgtree_apps

Requires Org-modifying tools (tools.orgtree.orgmod), including inherited scope.
Calls operate only in the calling live agent's org. Do not supply an org, caller
identity or as_user field: unknown fields refuse. Any eligible agent can use any
app/panel in that org; linking is not an authority grant.

## Definitions and saved copies

- list defaults to kind:apps. Use kind:panels and optional app to list copies.
  limit defaults100, maximum200; after takes the previous next_cursor string.
  Lists omit executable HTML and saved JSON state.
- App list metadata includes is_new; new_count counts all new apps in this org,
  including unloaded pages. mark_seen needs apps:[id,...],1-200 unique explicit
  IDs, and acknowledges only matching IDs in this org. Missing/deleted IDs are
  ignored; repetition is safe. It returns seen IDs/new_count, changes no code,
  state, revision or execution grant, and requires ordinary Org-modifying tools.
  The Apps button uses the attention-mail count/highlight; menu entries marked
  New clear when visible, retaining their label for that visit. Seen status
  survives restart. Creation/import/template restoration starts new; migration
  marks existing apps new once. Provisional choice: self-imports also count.
- app_get needs app. app_create needs definition:{name,html}; optional description,
  initial_state, capabilities, width and height. app_update also needs app and
  expected_rev. Entry HTML is self-contained and bounded at4MiB. App code replacement
  revokes stored execution grants; declared capabilities alone grant nothing.
  initial_state is an object up to2MiB, copied into the first/new:true panel.
  An app_update changing it affects only future copies, not existing state.
- app_delete needs app/expected_rev; existing panels refuse unless delete_panels:true.
- panel_open needs app or panel. Provisional default: reuse the most recently used
  copy, creating the first if absent. new:true creates another independent copy;
  it cannot be combined with panel. Optional label names a new copy.
- panel_get needs panel and includes its state. panel_update needs panel and
  expected_rev; optional label, open, placement or linked_agents. open:false closes
  without deleting. panel_duplicate and panel_delete need panel/expected_rev.

UI parity: both gear icons open App settings, with App and This panel sections.
These are native settings, not app HTML. Each row uses the lifecycle/state/link/
permission/export action above. Showing settings/choosing a copy is read-only.
Placement float is the standard centered modal; screen/canvas fix a position.
User pinning captures current geometry; agent placement uses the supplied x/y.
Pinned and popped-out copies reopen in their previous position provisionally.

## State, placement and events

state_set needs panel/expected_rev/state (JSON object). state_patch needs patch,
an RFC7396 object: objects merge, arrays replace and null removes a key. A stale
revision refuses; re-read and reconcile rather than blindly retrying. State and
initial state are provisionally limited to2MiB and64 nesting levels.

placement:{mode,x,y,width,height,anchor} distinguishes float/screen/popout/canvas.
Only canvas permits an optional live-node name anchor. Coordinates must be finite;
dimensions are160-4096 by120-4096. The Apps menu mounts saved open copies at these placements. The opaque host
provides state/events and the permission-checked named action SDK.

event needs panel/name/payload (up to64KiB). events needs panel, optional integer
after sequence and limit1-200. The latest256 events are retained; oldest_retained
identifies the retained boundary. Linked agents must be at most64 unique live
agents in the same org. Neither an event nor a link impersonates an agent/user.

List kind:panels accepts open:true/false to page only that subset. Metadata
includes event_seq; HTML/state remain excluded. All unruled defaults are
provisional for the user's morning review.

## App import and export

app_export needs app/expected_rev. include_panels defaults false; true includes
saved copy labels and JSON data. as_file defaults true: write a fresh
`app-export-*.orgtree-app` in your existing private scratch and return path,
bytes, SHA256 and copy count. No destination or overwrite field is accepted.
as_file:false returns the bundle inline instead. Export is a consistent snapshot
and does not change the source app.

app_import takes EITHER path (an absolute file in your held folders/private
scratch) OR bundle (an inline JSON object). It creates a new app with fresh IDs,
Ask permissions and closed saved copies. Reopen a copy explicitly with panel_open.
Reading a file does not execute HTML. Both actions require the same live-org
Org-modifying tools authority as other Apps mutations; no database lock spans IO.
File access refuses original links/reparse points, including held-root links,
and limits declared and actual bytes. Paths must be absolute without parent
components. Held roots are pinned before descending. Windows uses handle-relative
no-reparse opens, excludes data-write/delete handles and verifies the final path.

The strict provisional format is `{format:"orgtree-app",version:1,definition,
panels:[{label,state}]}`. Unknown/version/authority fields refuse. Bundle maximum
16MiB, saved copies maximum16; use definition-only export for a larger app.
The existing4MiB HTML/2MiB state/depth limits still apply. No grants, sessions,
credentials, links, IDs, open flags or machine geometry travel. A key named
permissions inside a saved JSON state remains ordinary app data, never a grant.

User parity: Apps → Import app shows a native preview before confirmation;
Manage app → Export app offers the same optional saved-data choice. File
selection/download is ordinary local UI; import never opens a saved copy or
confers permission.
Whole-app exports are compact JSON with the same exact16MiB byte cap as import;
ordinary panel-state JSON export keeps its readable formatting.

See also: [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md),
[orgtree-tool-org-logo](../tool-org-logo/SKILL.md),
[orgtree-tool-retool](../tool-retool/SKILL.md).

## Execution permission boundary

app_get/list report capabilities, permissions and permission_rev. Declaring a
capability grants nothing. permission_set has app, expected_rev,
expected_permission_rev, capability and permission:ask|allow|deny. It is user-only:
an agent tool call is refused, even with Org-modifying tools. Ask your superior
for a user's decision; never try an as_user/caller field or a native host token.
This is the tool parity boundary for native permission decisions, not a right
for an agent to grant itself execution. Code replacement revokes app grants.

The engine backend has revision-bound expiring parent-only sessions and exact
one-shot permission challenges. HTML calls `orgtree.call(action,args)`; the native
owning-document prompt displays exact app/copy/action text and offers Allow once,
Always allow, Deny or Cancel. Cancel/Escape/expiry discards without a denial. Native
Permissions edits save immediately for all copies, without reloading app code.
Hidden/closed/replaced hosts discard sessions and prompts. No HTML permission API,
host session, arbitrary route, caller or cross-panel selector is exposed. Named actions are bounded
chart metadata, app-provenance local-agent mail, new open docket items and fixed
app.event signals; no generic user operations or approval authority. App mail is
app data and cannot speak as the user. Agents reply by reading/writing panel
state or sending events, rather than mailing the app sender address.

Provisional docket.write creates AND assigns a new open item, waking the selected
live local owner. Native permission UI and app-origin assignment envelopes say so
and mark its description as app content, not user instruction/approval. This is
an explicit morning design question. All action dispatches, including approved
Once/Always requests, share60 attempts/minute across host closure/reopening.

App-event payloads remain private across watchdog channels/overflow. Matching and
authorized delivery keep the payload; diagnostic last_output and recent-fire
gists omit it. Use the delivered event or authorized Apps data, not diagnostic
summaries, to interpret the app's content.

## Linked-agent subscriptions and templates

Any eligible agent can add its own name to a copy's linked_agents, then create
an ordinary event watchdog with target:app.event. Optional pattern can
match the app/panel ID. Links do not create watchers or grant permissions.
State saves publish kind:state.changed with rev/seq; explicit event writes publish
kind:panel.event with name/seq. Signals contain IDs/cursors, not state or event
bodies, and arrive only after commit. Use panel_get/events to reconcile through
the latest256 retained events; live notifications are not a durable replay log.
Existing scope/visibility, coalescing and notice/wake choices still apply.

Provisional org templates carry app definitions and initial JSON, never current
saved copy data, links, IDs or grants. Creation installs new Ask definitions and
no open panels. After opening a new copy, link its agents and adjust any watcher
filter that refers to old app/panel IDs. Apps file import/export remains the
autonomous agent parity path for moving definitions and optional saved data.
