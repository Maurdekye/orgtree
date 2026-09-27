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

### Wire shapes for the client implementation

The following field names are the version-1 contract. `nodes` is a flat map;
`children` and `roots` contain IDs, not recursively hydrated objects. A node is
the current display projection with these explicit additions/changes:
`parent: string|null`, `axis: "org"|"lineage"`,
`hidden_retired_children: number`, `lineage_count: number`,
`lineage_loaded: false`, `consultable_predecessor: {id,generation}|null`.
It omits the full `lineage` array. Existing archived `detail:false` and
`detail_rev` keep their meanings. **Live nodes also need lineage hydration:**
`lineage_loaded:false` is independent of the old archived-detail marker, so a
client must not let the live/full-node shortcut bypass an explicit lineage open.

```json
{
  "format": "orgtree.foreground-tree/v1",
  "kind": "snapshot", "revision": "opaque-content-token",
  "catalog_revision": "org-incarnation:catalog-counter",
  "org_rev": 42, "sync_rev": 19,
  "header": {"slug":"example", "hidden_retired_roots":2},
  "roots": ["boss"],
  "nodes": {
    "boss": {"id":"boss", "parent":null, "axis":"org",
             "children":["worker"], "hidden_retired_children":8,
             "lineage_loaded":false, "lineage_count":3,
             "consultable_predecessor":{"id":"boss@2","generation":2}}
  },
  "missing_requested": []
}
```

The example elides current display fields and header fields for readability;
it is not an allowlist that removes them. The complete header preserves the old
tree header after bounded dependencies are available. A compatible delta uses
`kind:"delta"`, `base:<exact token>`, `revision:<new token>`, replacement
`roots`, `header:{set:{...},unset:[...]}`,
`nodes:{id:{set:{...},unset:[...]}}`, and `removed:[id,...]`.
Watermarks and `catalog_revision` are always supplied. An unknown base sends a
snapshot. Unchanged content is HTTP304 with current watermark headers.

Children/search return `kind:"page"`, `catalog_revision`, `org_rev`, `matches`
(ordered IDs), `nodes` (matching projected rows plus ancestor rows), and
`next_cursor` (string or null). Ancestors that are not matches are ghost rows in
search; they are not false matches. Pages are not implicitly merged into the
background graph. Search pages have a deterministic ID order; each displayed
page's matching forest uses the existing hierarchy and local sibling position.

Exact lookup returns `kind:"lookup"`, `requested:<id>`, `found:true|false`,
`path:[root,...,requested]`, `nodes`, `catalog_revision` and `org_rev`.
An absent identity returns HTTP200 with `found:false`, empty path/map; a lookup
in flight is not absence. Off-axis results have `axis:"lineage"` plus their
stored parent and successor; clients must not insert them as ordinary root
children. A stale cursor is HTTP409 with
`{format,kind:"reset",reason:"catalog_changed",catalog_revision}`.
Malformed cursors/limits are HTTP400. Scope/authorization failures use the
existing route policy. Invalid ancestor cycles or index corruption are explicit
errors, never an apparently complete tree with silently missing agents.

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
