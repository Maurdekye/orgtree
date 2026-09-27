# Foreground tree API, version 1

This is a new projection. `/api/orgs/{slug}` and its lossless delta remain
unchanged. A client must opt into the foreground contract; it must not treat an
omitted historical identity as deleted.

## Routes and identity

* `GET /api/orgs/{slug}/foreground-tree`: the active organization graph, plus
  archived ancestors connecting active nodes. `include` is a repeated exact ID
  parameter for currently revealed or pinned historical nodes. Its ancestors
  are included too. Revealing a node does not reveal all its descendants.
* `GET /api/orgs/{slug}/foreground-tree/children?parent=...`: a page of archived
  direct children on the organization axis, including their ancestor paths.
  The root parent is the empty string. Default limit 50, maximum 100.
* `GET /api/orgs/{slug}/foreground-tree/search?q=...`: explicit, case-insensitive
  substring ID lookup, with state filtering and ancestor paths. Pages are
  bounded; there is no hidden full archive response. Empty searches use the
  hierarchy browser, not an unbounded search.
* `GET /api/orgs/{slug}/foreground-tree/lookup/{nid}`: one exact identity and its
  coherent ancestor path. A historical identity may exist without being on the
  organization axis. Predecessor/successor links are preserved.
* Full node details remain a separate read. The foreground includes
  `lineage_count`, immediate predecessor/successor identities and the newest
  consultable archived predecessor (maximum generation, excluding lost bearers)
  used by the fresh-session desk; expanding the
  lineage loads the historical entries explicitly. No generation is renamed,
  merged or replaced by a synthetic identity.

The graph format is `orgtree.foreground-tree/v1`. Returned node rows retain the
existing display fields; live and unrecoverable nodes are included. An archived
predecessor with a successor remains off the organization axis unless explicitly
revealed, just as in `Org.org_children`. Explicit results carry their axis and
parent metadata, rather than silently attaching them to a different parent.

`hidden_retired_children` counts omitted **direct organization-axis child
roots**, the quantity the current retired badge displays. It is not a count of
all descendants. A revealed child or an archived connector is subtracted from
that count. There are no arrays of all hidden IDs. The tray's overall historical
count is separate from the per-parent badge.

## Versions and paging

Every read uses one short repeatable-read database snapshot. Responses carry an
organization incarnation and committed revision. A separate catalog revision
changes when identity, parent, state, order or searchable metadata changes;
ordinary status ticks do not invalidate a historical page cursor. Cursors bind
the org incarnation, catalog revision, route/filter and last stable ordering
key. An incompatible cursor produces an explicit reset response; it is never
silently continued against a different catalog.

Child order follows stored sibling order (`ui_order`, `created`, insertion
ordinal). Search supplies matching IDs plus ancestors; the renderer preserves
its hierarchy/ghost-ancestor display and local sibling-position ordering.
Pagination must remain explicit in that UI. The client must not combine pages
from different catalog revisions.

Graph content revisions and deltas are partitioned by public/private view and
the explicit include set. An unavailable exact base returns a full foreground
projection. Archive growth must not enlarge the cached graph or status patches.
Runtime annotations and public scrubbing retain the current route's rules.

## Indexed storage and boundaries

`foreground_store.py` owns the PostgreSQL node projection, migration 0004 and
transactional index maintenance. It exposes bounded active-node, exact-node,
ancestor, retired-child and substring-search readers. Storage results are not
public API responses and never bypass route authorization or public scrubbing.
The transcript scheduler may consume bounded ID/state/session identity pages
from this index; it must not iterate all history on every pass.

Node metadata, direct retired-child counts, lifetime cost aggregates and lineage
counts are maintained with the node writes, including import, rename, deletion,
reparent, retirement, revival and rollback. A raw node value is still the sole
source of truth. No writer changes its row-CAS semantics. No request repairs an
index by scanning all history; incomplete migration/index state fails explicitly
and leaves the compatibility route available.

The whole tree header also needs E's bounded active/attention docket counts and
org-inbox ordinal/preview readers. Those are explicit integration dependencies,
not permission to publish zero counts or to claim history independence while
loading the full old header. Until these dependencies and the client consumers
land, the new indexed graph is not whole-UI qualification.

## Evidence required

At equal active data and 1x/10x inactive history, assert equal returned active
identities and constant materialized-node/cache cardinality. Exercise first,
middle and last hidden IDs, live/unrecoverable descendants of archived parents,
lineage navigation, pinned historical nodes, cursor resets, rollback and
concurrent cross-process changes. Mutate risky invalidation/index maintenance to
prove the controls fail. Measure repeated CPU and database work before claiming
the user's 5% runtime/memory target; both history arms must also meet every
absolute latency target. No load run is authorized by this contract.
