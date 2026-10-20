# Context-full recovery and size compaction

Claude and Codex turns that overflow their conversation window receive one
cheap fresh-session recovery attempt. Input/message length refusals, quota or
authentication failures, interrupts and killed turns retain their own policies.
A second overflow is terminal. A successful ordinary turn clears the native
retry counter. Language model server recovery retains its separate three-reset
policy.

The retry transaction locks only the affected agent. It ends the failed turn
and session, clears measured context and the cache receipt, returns unconsumed
mail claims, increments the durable native counter, and inserts one recovery
event keyed by the failed turn. Delivered original mail keeps its IDs and
single receipts. The wake recalls those messages with sender provenance and
existing bounded inbox references for large bodies; it never creates duplicate
original inbox rows or acknowledges them again. A crash after the transaction
commits leaves a pending wake, rather than an open failed turn that restart
could re-admit. Earlier conversation stays available through the existing
saved-history/handoff path. The recovery wake is an engine event, not a new
instruction from an original sender.

The after-turn size check restores the missing 3.x threshold behavior. It uses
the latest org threshold and agent measurements, refuses missing/zero or
estimated occupancy, a missing window/session, nonlive/held agents, bearers,
reported working status, and a CLI compaction during that turn. Each stand-down
logs one diagnostic with stage, reason, occupancy, window and threshold, without
mail bodies. A failed/interrupted turn logs its own stand-down reason. Rust no
longer implements 3.x knowledge bearers, but the legacy extra-field exclusion
is retained defensively.

Before a normal turn is sent to a CLI, the same size check is the backstop. It
uses `compact_at` as the boundary and is independent of reported working status
and cache temperature. The threshold is already capped at 95%, leaving room
before the wall. A reset clears the session and its measurement, so neither
an overflow recovery nor an after-turn split is repeated at admission. Native
compaction invalidates the precompaction measurement instead of treating its
earlier peak as the current occupancy.

Both size paths use the existing cheap fresh-session handoff, without a model
call for summarization. This changes the provider cache namespace. They do not
create a new agent or a consultable predecessor.

Focused evidence: `tools/rig/proofs/context-full-recovery.mjs` runs only the
synthetic rig, scratch PostgreSQL and fake Claude/Codex CLIs. It exercises
recovery, bounded exhaustion, input-length refusal, single original receipts,
after-turn and admission resets, duplicate-reset prevention, native-compaction
and working-status gates, diagnostics, and restart preservation. Policy unit
tests enumerate the stand-down reasons. These are synthetic checks; they do
not establish live provider behavior or a clean full-workspace baseline.
