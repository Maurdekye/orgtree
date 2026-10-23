# Complete ancestor reads

The canonical `domain/ops.rs::chain` is used by capability and credit checks.
It reads every ancestor, including through project containers, with no numeric
depth cutoff. A `UNION` of stable `(id,parent_id)` edges stops a malformed cycle;
the second CTE orders the connected chain from its root. No root means refusal.

The final SELECT sorts by root distance before `FOR UPDATE OF a`. This preserves
the previous helper's exact root-first row-lock acquisition order, while replacing
one query per ancestor with one batched locked read. Callers' scope clamps, credit
calculations and transaction boundaries are unchanged. Rust PLAN §2.2 has no org
revision lock row; this change adds no org-wide or revision lock.

The supplied disposable-database regression has 5,000 agent levels and restrictive
scope only at the outer root. The red parent returns 1,025 ancestors and loses
that restriction. The green check also verifies every returned name in root-first
order, retained tool/visibility/permission restrictions and cycle refusal.
Measurements and focused-check receipt are recorded with the exact-SHA hand-in.

Physical-root SQL lives in `domain/projects.rs::{locked_ancestor_rows,scope_ancestor_rows}`.
The first keeps the same row-locking query used by `ops::chain`; the second keeps
the ordered rows used by `tools::caller_tools_in`. Refusals and scope clamps stay
with their callers. The reporting guard still scans both central caller modules;
neither receives a file-wide structural exception.

## Presentation, delivery and gallery depth (2026-10-23)

The document presenter uses the same complete root-first scope rows for folder
clamps and project membership. The helper now appends node id as column 4;
the existing tool caller's scope/parent/depth/kind columns retain their indices.
An unresolved root or ancestry cycle refuses folder authority. This shared
presenter also serves file delivery, mail-file snapshots and logo Set; callers'
canonical containment, file bounds and audience rules remain unchanged.

Descendant project folders use stable-edge UNION recursion scoped to the root's
org, excluding the root. A separate acyclic ordering walk retains nearest-first
order and 256-row id pages. Human team galleries use UNION of stable node ids
in the selected org, retaining retired identities and their existing document
page limits. Neither has a 1,024-level cutoff; cycles terminate without duplicate
members. Project presentation replacement admission is unchanged (D4 is separate).

The owned native regression checks 1,500 project levels through the actual
presenter/project-present and human gallery page helpers, including root folder
clamps, no-user-audience membership, refusal outside the caller's project,
retained renamed presenters, page size/continuation and malformed-cycle controls.
User choice: m23e9823f7a3e, 2026-10-23, D2/D3 "change the app"; release 4.4.4.
