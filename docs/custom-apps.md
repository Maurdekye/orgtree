# Custom apps and panels

An app is a small HTML program kept by one organization. A panel is one saved
copy, with its own label and JSON data. Two copies keep separate data. Closing a
panel keeps it; deleting it removes that copy. App definitions and saved state
live in Orgtree's database and survive an engine restart.

The first4.5.0 engine milestone provides this storage and the agent/API controls;
the Apps menu, sandboxed host and import/export controls follow in later slices.
The defaults below are provisional for the morning review.

Opening an app reopens its most recently used copy, or creates the first one.
New panel always starts another copy from the app's initial JSON state. Agents
with Org-modifying tools can read or change an app or panel in their own org,
including a copy made by another agent. The same category contains the Logo tool.

An app definition accepts self-contained HTML up to4MiB and an initial JSON
object. Each panel's state is limited to2MiB; an event is limited to64KiB. Changes
use the current revision, so a concurrent edit is reported instead of replacing
another edit silently. A panel's recent event log keeps256 entries.

Declaring an engine capability does not grant it. No HTML engine-action channel
is exposed in this storage milestone. The following host slice will keep HTML
sandboxed with no network or same-origin access, and show permission decisions
in Orgtree's own UI outside the app.

For agents, use orgtree_apps: list apps/panels, get a definition or saved panel,
create/update/remove a definition, open/reopen/close/duplicate/remove a panel,
replace or merge JSON state, and send/read recent events. Lists are paged and do
not include HTML or saved state; request those explicitly by identity.
