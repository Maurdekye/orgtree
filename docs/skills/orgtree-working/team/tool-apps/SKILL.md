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
dimensions are160-4096 by120-4096. The storage milestone records placements; its
HTML host and UI mounting follow in the next implementation slice.

event needs panel/name/payload (up to64KiB). events needs panel, optional integer
after sequence and limit1-200. The latest256 events are retained; oldest_retained
identifies the retained boundary. Linked agents must be at most64 unique live
agents in the same org. Neither an event nor a link impersonates an agent/user.

Permissions, no-network opaque sandbox hosting, import/export and subscriptions
are subsequent implementation slices; do not claim they are in this storage-only
milestone. All unruled defaults are provisional for the user's morning review.

See also: [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md),
[orgtree-tool-org-logo](../tool-org-logo/SKILL.md),
[orgtree-tool-retool](../tool-retool/SKILL.md).
