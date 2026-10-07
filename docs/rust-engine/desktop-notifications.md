# Desktop notification parity (2026-10-07)

F06-F08 restore the 3.x notification contract. The shared `domain/notices.rs`
projection feeds both app-socket notices and the HTTP notification inventory.

- Typed `runtime.turn_failed_terminal`, `runtime.background_task_stopped`,
  `runtime.subagent_died`, and `runtime.report_stalled` with `cause=terminal`
  produce `terminal-failure`, ahead of urgent/routine classification. Default
  desktop preferences therefore allow these alerts.
- Every category is read to exhaustion in indexed keyset batches of 200. Open
  requests belong to live agents; manual attention survives archival; frozen
  agents must be live. Undismissed documents never expire by age. HTTP keeps
  its 500-item pages, full active-identity list and complete total; orgs and
  rows have deterministic ordering. The complete inventory is still assembled
  in memory, as required by the app-feed replacement and active-identity contract.
- Migration `0011_notification_attention` stores an epoch and effective active
  flag separately from `manual_attention.set_rev`. Deferred triggers reconcile
  the final transaction state of manual attention OR attached open requests.
  Only a committed false-to-true edge increments the epoch. A rewrite, an
  atomic source handoff or a rolled-back clear keeps it. Reconciliation takes
  only the affected work-item row locks, and looks up open requests through a
  partial GIN index. Metadata writes do not bump docket revision or timestamps.
- Existing 4.x rows initialize from their dismissal revision (or 1); past edges
  cannot be reconstructed. PostgreSQL 3.x and JSON/SQLite import paths preserve
  explicit epochs/active flags. Missing older fields initialize at commit.
  Identity uses the epoch; dismissal continues to use the current `set_rev`.

## Measured

`cargo check -j 2` passed with `CARGO_TARGET_DIR=E:\cargo-target\desk-astra`.
A disposable PostgreSQL cluster ran the real migration and production Rust
notice functions (only logging attributes omitted in the scratch executable):
205 rows in every category, 1,025 complete identities, two-day-old documents,
eight typed terminal/urgent/routine controls, dismissal/read filtering,
archived attention, legacy initialization, repeated raises, both manual/question
handoffs, separate clear/re-raise, atomic clear/re-raise, rollback, ask
answer/reopen/delete, and explicit imported epoch versus dismissal revision.
The cluster was stopped and deleted. Evidence is in the local gitignored
`artifacts/desk-notification-parity` folder.

Not measured: a full HTTP/Electron/OS alert round trip, a full historical data
import, or competing concurrent writers. HTTP pagination was checked against
500-item slices of the real projection; actual transport behavior is inferred
from the unchanged endpoint paging and desktop preference/gate code.
