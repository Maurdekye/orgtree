# Bounded docket readers

The public `work_list`/`work_get` and desktop transport are unchanged by this
first reader slice. `workquery.Snapshot` selects internal records for their
future projections. A selected summary is **not** a public list response:
recipient state, pointer disclosure, objective notices and scope summaries
still require the existing ledger projection.

## Raw connection contract

The caller resolves the org using the existing authority boundary and owns an
open PostgreSQL `REPEATABLE READ READ ONLY` transaction. Construct
`Snapshot(raw, org_id, viewer=..., now_ts=...)` and consume its rows before ending
that transaction. The reader neither opens nor commits a transaction. It must
not be used as an overlay on a mutable or uncommitted `Org`.

Every query joins the maintained viewer access table. `lookup(slug)` returns a
summary record or `None`; missing and unreadable names are indistinguishable.
Exact slug lookup accepts real names shaped like old opaque IDs. `detail(slug)`
returns `(raw_body_dict, physically_archived)` after fetching and checking the
hash of exactly one authorized source body. It preserves unknown body fields.
It does not replace `_work_find`, whose callers can mutate its returned record.

`foreground(include_backlogged=False)` returns summaries only for the visible
foreground set. Attached questions and manual attention keep a physically
archived item visible. The canonical ledger classifiers handle the strict
one-hour boundary, malformed dates, old statuses and backlog. Summary records
exclude evidence and other historical bodies; `_query` metadata is internal.

`archive(limit=50, cursor='')` returns at most 100 summaries per call plus an
optional continuation cursor. Order is the existing descending tuple
`(docket_at or updated_at or '', slug)`, with PostgreSQL C collation matching
Python's lexicographic string order. Unsupported non-string dates require the
compatibility path instead of changing the existing Python conversion.

The signed, process-local cursor binds org, viewer, index/access revisions,
page size, ordering position and classification time. Subsequent pages use the
first page's clock for at most 60 seconds. A catalog or permission change,
changed viewer/page size, malformed token, expiry or process restart raises
`CursorReset`; restart at page one. No page is silently combined with a new
catalog. No server-side collection of historical rows is retained per cursor.

## Refusal and fallback

Missing migration, unhealthy metadata, dirty policy dependencies, mixed legacy
identity, unsupported ordering or body/hash disagreement raises
`CompatibilityRequired`. The outer reader must select the **whole exact
compatibility path**, not substitute empty lists or combine snapshots. Unknown
database errors propagate. The subsequent route integration must translate
these explicit states while preserving current error and identity guidance.

Migration 0009 changes only derived summaries and indexes. It preserves raw
text, reconciles from source and composes the SQL org creator for both runtime
creation and import. Summary updates invalidate access metadata. Startup
therefore refreshes dirty initialized schemas as well as new schemas; ordinary
clean startup still skips them. Reconciliation refusal rolls back the complete
migration. Independent migration-cost evidence for 0004–0008 does not cover
this new migration.

## Evidence limits

The fixtures compare 40 and 400 archived bodies. The old `_work_find` path
materializes 40/400 records; `detail` decodes 1/1 and foreground summaries remain
identical. This is a cardinality control, not a latency or memory qualification.
List projections, renderer references and loaded history qualification (at most
5% growth while meeting absolute targets) remain open.

## Single-item public reads

`workdetail.get` serves the existing desktop and agent `get` responses through
the canonical ledger projection methods. Its context is not an `Org`, has no
document or mutation surface, and cannot be saved. One read-only repeatable-read
transaction holds the index, authorized raw body, current actor identities,
dependency permissions, questions and this item's spilled scope history.

The selected item's complete scope is intentionally available. Other item bodies
and other agents' rows are not hydrated. Actor lookups have a 128-entry cache
local to the request; nothing persists between requests. Named historical links
use indexed summaries with the caller's authority. Missing and hidden items keep
the ledger's identical refusal, including retired-ID guidance. Agent callers
must still be live. Full, compact, summary and field selection use the same pure
ledger methods as the old path.

Unhealthy indexes, legacy blobs, missing identity normalization, or a scope-count
mismatch return `None` to the route, which then executes the complete existing
reader and identity guard. This is compatibility fallback, not an empty answer.
Unknown database errors propagate. Reusing a writer transaction is refused.
No mutations or list routes are changed by this integration.
# Static list metadata (migration 0012)

`worklistmeta` maintains the three history-derived desktop list fields using
the canonical ledger methods: `objective_notice`, `status_at`, and
`scope_archive_summary`. The payload includes the existing thin raw summary;
it is an internal list input, not a full item or a viewer-authorized wire view.
Raw work bodies and scope records remain authoritative and unchanged.

Work-index and scope-owner triggers record dirty item IDs. Relevant agent
identity/topology and ask changes advance an input revision without enumerating
historical nodes. Scope-only changes also participate in the existing
`work_read_state` writer lock, so refresh cannot discard another transaction's
invalidation. `workread.refresh` processes this separate queue even when the
access metadata is clean. Its existing save/import/bootstrap callers keep their
transaction ownership; statistics initialization still follows refresh.

Bootstrap first recomputes static fields from raw bodies and reconciles hashes,
payloads and total rows. Explicit reconciliation is available for tests and
diagnostics. Unsupported scope layouts/counts log an error and disable this
index; partial results are never eligible for a list answer. Ordinary clean
saves do not decode history. A changed item may read its own scope history;
this does not claim that write cost is independent of that item's history.

This stage enables no public route. A subsequent foreground-list reader must
check this index and the existing access/index health together, and apply
canonical viewer permissions, current actor identities, attention and archive
aging inside one snapshot. Missing or unsupported metadata requests the whole
exact compatibility path. Existing full-list and single-item routes are intact.

## Opt-in desktop foreground routes

The `/work-items-foreground?backlogged=1` route returns `format:
orgtree.work-foreground/v1`, canonical light `items`, optional `backlogged`,
viewer `counts`, `now`, `attention`, `references`, and a content `revision`.
The row shape is exactly the existing work-items-view light row. References
contain only returned rows. Hidden archives are neither projected nor retained.
Attention-held physical archives remain foreground. The existing full routes,
agent list contract, and work-items-view stay unchanged in this stage.

`/work-items-archive-page?limit=50&cursor=...` returns at most 100 light rows
in `archived`, their `references`, `next_cursor` (null at the end), and an opaque
catalog. The existing order and classification rules apply. Cursors expire in
60 seconds and bind viewer, org, page size, body/access revisions, and the list
revision (including scope and actor identity changes). A 409 `kind: reset`
requires restarting the page chain. Invalid limits return 400.

`/work-item-reference/{wid}` returns `found` and one `reference` or null. Missing
and unauthorized names are indistinguishable. This resolves historical links
on demand; absence from the foreground reference array never means not found.
The existing exact single-item GET remains the detail reader.

All three use one repeatable-read read-only transaction and refuse writer
connection reuse. Canonical ledger projection applies dynamic identity,
recipients, pointer visibility and attention; only history-derived fields use
maintained metadata. The result is explicitly a light list, never a full item.
Unsupported/dirty metadata returns 409 `kind: compatibility` and `legacy_url`:
the client must switch its complete reader to the legacy path, not mix an empty
fallback or an old page into a new snapshot. Unexpected database errors remain
errors. Foreground content supports ETag/304; no server-side historical result
cache is created. A 304 still performs bounded foreground selection.

This stage enables the routes but does not switch the renderer. Archive search,
page lifecycle and on-demand references must preserve visible behavior in that
subsequent client stage. Cardinality controls are not loaded latency/memory
qualification; the <=5% history gate remains open.
