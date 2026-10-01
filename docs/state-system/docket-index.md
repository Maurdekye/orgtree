# Docket index storage slice

Migration 0006 derives per-org `work_index` rows from active per-item document
rows and archived `log_l` rows. It never replaces or rewrites those raw bodies.
The index stores physical location, exact slug, a compact stored-field summary
and a SHA-256 of the original UTF-8 body. This summary is **not** the desktop wire
view: authority, questions, recipient projection and derived presentation still
use the existing ledger path. No public reads switch in this slice.

Row triggers update the index, physical active/archive counts and an index
revision in the writer's transaction. They cover ordinary CAS saves, COPY
imports, archive/reopen moves and rollback. A deferred unique slug constraint
allows insert-before-delete moves but refuses duplicate identities at commit.
The new-schema SQL wrapper preserves the previous creator, including any earlier
migration wrappers, and also covers importers that bypass Python org creation.

Migration locks source tables, validates the active layout and identities,
backfills summaries, then independently reads raw rows to compare locations,
summaries, body hashes and counts. Unknown layouts and mismatches abort the
migration. The receipt records a count and ordered raw-source checksum. Unknown
body fields and numeric text are untouched. The summary intentionally excludes
evidence, scope history and attachments; those remain in the original body.

`workindex.reconcile(raw, org_id)` is the same explicit maintenance control after
migration. It locks source tables against concurrent writes, recomputes from raw
rows and marks the index unavailable on mismatch, logging an ERROR. It does not
silently repair an index or return a successful empty result. Future bounded
readers must check `ready` inside their read snapshot and use the exact existing
path when it is false. Schema/JSON errors propagate. Normal requests must not
run reconciliation. The migration boundary satisfies the reconciliation gate;
this slice adds no repeated startup scan.

Physical row counts are not authority-filtered user counts. A later read slice
must preserve the existing authority and attention predicates and reconcile its
maintained access metadata before opting into bounded reads. It must also add
archive paging and exact historical references before the renderer changes.

The small/10x-history control keeps one active item with 40/400 archived bodies,
checks identical active summary answers and one returned body for exact first,
middle and last historical lookups. This proves stored shape and reachability,
not loaded p95 or memory targets. Triggers serialize their small counter update
per organization; loaded write overhead remains a qualification requirement.
