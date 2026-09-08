# Background import operations

Import uses the operator-authenticated `/api/desktop/import-v1/jobs` routes.
The old synchronous POST returns 409 with an upgrade message; the internal
copy helper remains available for isolated tests and the job worker.

- POST `/jobs`: existing import fields plus client-generated UUID `request_id`.
  Responds 202 `{job}`. The request ID is also the job ID. Identical retries
  return the recorded job, including terminal results. Changed payloads for an
  existing ID and concurrent new imports are refused with 409.
- GET `/jobs/current`: `{job}` or `{job:null}` for the last recorded operation.
- GET `/jobs/{request_id}`: exact recorded operation, or 404 if absent. Neither
  GET performs copy, publication or recovery. Both remain independent of the
  organization lock held during file copying.

Job states are `queued`, `running`, `succeeded`, `failed`, `interrupted`.
Phases are `queued`, `reading`, `copying`, `native`, `validating`, `publishing`,
`recovering`, `finished`. The job includes source root, selected organizations,
current organization, timestamps, error and the existing Imported result shape.
`publications` records each organization's publication intent/confirmation and
recovery intent/return; it is not proof that a provider completed any work.

`files_copied` and `bytes_copied` count completed, verified copies performed by
the import copy helper. They are not total source size or a percentage. Files
are counted again when a later independent copy is made; other native-provider
operations can proceed during their named phase without increasing these counters.
Progress is kept in memory and checkpointed at most once per second. Phase and
mutation boundaries are persisted immediately. After interruption the counters
may lag the last second of work, and only completed checkpoints are reported.

A destination OS lease prevents competing workers, including other processes.
The lease releases when the process exits. A subsequent status read marks an
unfinished job `interrupted`, retaining its last phase and mutation receipts.
No operation is automatically replayed. A crash between publication and its
confirmation can leave a published organization with only an intent receipt;
the error explicitly requires inspection. A recovery intent is likewise not
treated as proof of admission. Existing per-node recovery reconciliation applies.

The client retains only the request ID. After a lost start response it looks up
that exact ID. Transport failure must not unlock a new import. An authoritative
404 permits only an explicit same-ID retry; after remount the operator must
reenter the request and acknowledge it. The server's payload fingerprint guards
against a delayed earlier request colliding with different reentered details.

No cancellation, automatic retry, resumed partial file copy, or automatic cleanup
of retained staging is added. Terminal jobs remain on disk for reconnect and
deduplication. Unsupported native layouts and all source-isolation checks keep
their existing behavior. This protocol does not retrofit a running older engine.
