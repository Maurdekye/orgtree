# Context-full recovery and size compaction

Claude and Codex turns that overflow their conversation window receive one
cheap fresh-session recovery attempt. Input/message length refusals, quota or
authentication failures, interrupts and killed turns retain their own policies.
A second overflow is terminal. A successful ordinary turn clears the native
retry counter. Language model server recovery retains its separate three-reset
policy.

**Antigravity (2026-11-13, 4.5.13).** AGY's own pre-invocation summary can stall at its hard 256k
token clamp and fail with a five-minute stream-idle timeout. A GOOGLE-provider error naming
`context summarization` together with `stream idle timeout` or `context deadline exceeded` now takes
the same one-per-run fresh-session retry and carry-over note; a plain step timeout does not.
All Antigravity tiers also reset at a measured 230k tokens between turns, or earlier if the org's
size threshold is lower, through the existing admission/after-turn gate and its unchanged notices
and stand-downs. Context windows and the cold-cache 25% policy stay on the real window; other
providers are unchanged. [decided: user 2026-11-13 m6af74181ac75, m015e95fd031c; verified:
`runtime/{actor,recovery,context_reset}.rs`, `providers/catalog.rs`]

The retry transaction locks only the affected agent. It ends the failed turn
and session, clears measured context and the cache receipt, returns unconsumed
mail claims, increments the durable native counter, and inserts one recovery
event keyed by the failed turn. Delivered original mail keeps its IDs and
single receipts. The wake recalls those messages with sender provenance and
existing bounded inbox references for large bodies; it never creates duplicate
original inbox rows or acknowledges them again. The transaction also preserves
recovery re-admission markers for unconsumed messages:
the prompt contains their bodies, while the new transcript row references the
single original authored segment. Its ID receipt still proves delivery after
a restart; positive acknowledgement clears the marker. A crash after commit
leaves a pending wake, rather than an open failed turn that restart
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

The AGY regression checks exercise the production actor error predicate and actual retry transaction
in a guarded synthetic PostgreSQL fixture: session clearing, one recovery wake with recalled mail,
same-turn idempotency, exhaustion on the next failed turn, and plain-timeout preservation. Pure
threshold/size-gate tests cover the 230k boundary and stand-downs. They do not run the full actor
`end_turn` loop, a native AGY CLI, or the database-backed `size_reset` path.
