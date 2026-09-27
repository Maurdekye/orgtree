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
Public route/projection integration, renderer references and loaded history
qualification (at most 5% growth while meeting absolute targets) remain open.
