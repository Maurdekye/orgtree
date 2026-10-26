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
- app_get needs app. app_create needs definition:{name,html}; optional description,
  initial_state, capabilities, width and height. app_update also needs app and
  expected_rev. Entry HTML is self-contained and bounded at4MiB. App code replacement
  revokes stored execution grants; declared capabilities alone grant nothing.
- app_delete needs app/expected_rev; existing panels refuse unless delete_panels:true.
- panel_open needs app or panel. Provisional default: reuse the most recently used
  copy, creating the first if absent. new:true creates another independent copy;
  it cannot be combined with panel. Optional label names a new copy.
- panel_get needs panel and includes its state. panel_update needs panel and
  expected_rev; optional label, open, placement or linked_agents. open:false closes
  without deleting. panel_duplicate and panel_delete need panel/expected_rev.

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
includes event_seq; HTML/state remain excluded. App import/export and agent
subscriptions are subsequent slices. All unruled defaults are provisional for the user's morning review.

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
