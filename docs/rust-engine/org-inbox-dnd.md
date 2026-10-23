# Org Do not disturb (4.4.2)

USER 2026-10-23 06:32–06:36Z: accept all outside mail without automatic agent
delivery/wakes; three Connections modes; no Hubchat/user-sender exemption;
show a visible warning that Hubchat communications are not read/delivered
automatically. Coordinator 06:36–06:38Z: extern holders pull, consumption is
org-wide, returning to Normal publishes unread-by-agents held mail once,
oldest first. Mode writes retain user-only authority.

## Storage and admission

`org_inbox_mode=normal|dnd|closed` lives in org settings JSON. All writers
normalize it with `org_inbox_enabled`; legacy enable writes map to Normal
or Closed. Existing closed/history/network SQL gates continue using the
boolean. Neither field inherits app defaults. Templates preserve both.

Migration 0055 adds `dnd_held`, `pulled_by`, and a partial `(org_id,id)` held
index. Existing rows are not re-published. The viewer's `read` flag is
independent of extraction. A human can inspect/mark read while held; it
does not consume the agent's pending item.

Local and hub inbound transactions take the org policy row lock before
retaining mail and deciding whether to publish. DnD creates no agent mail,
fallback notice, audience grant, or wake. Canonical kind, body, attachments,
reply snapshots and hub references survive. Duplicate hub retries cannot
reinsert or republish the item. Incoming attachment-failure notifications
also wait; authorized outgoing traffic is unchanged.

The same lock serializes mode changes, pulls and release. Returning to Normal
drains in oldest-first pages of 100 under short transactions, publishing
copies and clearing held state atomically, waking only after commit. New
arrivals join an existing held backlog rather than overtake it. Each copy
then uses normal native size/chunking budgets. The existing runtime tick
recovers one page after a crash or failed drain; no inactive history scan.
With no route, held mail waits. Normal's runnable/fallback routing is retained.

## Explicit tool and UI paths

Agent `orgtree_inbox action=settings`, `list org_inbox=true`, and `pull`
require current extern audience (plus messaging). Closed permits settings
inspection but refuses preview/extraction. Pull consumes oldest held rows
for the whole org and creates read personal copies only for the pulling
agent, with no wake/event fanout. Initial chunks use the existing 64 KiB
UTF-8 split and 256 KiB content budget; remaining bodies use ordinary
personal chunk handles. Receipt-backed transcript insertion reuses normal
manual-read provenance and deduplication. Preview never consumes.

Only user HTTP settings and standalone user MCP
`orgtree_inbox action=configure mode=...` may change mode. Agent configure
always refuses, regardless of top-level status or extern audience.

Connections shows the three-mode dropdown, multi-holder boolean and the
Hubchat warning when DnD is selected, using the shared Save. It remains
available without a hub identity. Mode changes do not restart agents.

## Phase 1 evidence scope

Focused unit contracts cover mode/legacy compatibility, cross-org default
isolation, malformed input, pull bounds/cursor binding, and user/agent tool
card authority. The renderer test mounts the actual SettingsPanel, changes
all modes and verifies warning/save behavior. The red control restores only
the base App component. One synthetic Electron capture shows Connections.
No live data, real providers, rig, database migration rehearsal, concurrent
database proof, or native-mouse proof is authorized in this phase. Transaction
atomicity and delivery behavior are source-derived until those later proofs.
