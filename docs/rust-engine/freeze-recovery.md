# Imported freeze recovery

## Cause and repair

Source and historical read-only log evidence, 2026-10-07: the imported 3.x record
had a human-readable `until` and a numeric `until_ts`. The original Rust schedule
accepted only RFC 3339 `until`, returned immediately, and never reached the
auto-resume check. Missing verbose method traces alone did not prove missing
startup recovery.

Commits `8cc8a77` and `da10249` already repair this on local `rust-engine`.
`runtime::freeze::deadline` accepts canonical `until`, a version-matched legacy
`wake` promise, or numeric `until_ts`. Both importers call `normalize`; existing
rows work without migration. `wake_at` adds the limit reset's 60-second grace.
`recover` reads frozen agents in bounded pages. Scheduled tasks retry transient
errors or disabled auto-resume every 30 seconds and compare the exact original
record before releasing it. `Actor::on_wake` logs why a frozen wake is blocked,
including its due state and the effective auto-resume setting, without verbose
logging.

## 3.x comparison

Reference: `origin/dev`, `engine/backend/orgtree/supervisor.py`,
`start_auto_resume_loop`, `_auto_resume_org`, and `auto_resume_ready`.
Subscription-limit probes require auto-resume, and wake one minute after reset.
Pure connection retries bypass the toggle. The Python scheduler also has
metered-route exceptions, account fallback and shared probe admission; this
verification concerns subscription freezes with an explicit reset, not blanket
parity of those separate policies. No provider usage is fabricated or probed.

## Verification

Measured on 2026-10-07 against alpha.11 source `b6818d4`, in a private
SAFE_START debug engine and fresh scratch PostgreSQL database. A temporary HTTP
adapter invoked the production deadline, normalization, recovery and Wake
functions; it was restored byte-for-byte after the debug build. No adapter is
committed. SAFE_START deliberately skips automatic startup recovery, so the
smoke explicitly called the same `freeze::recover` after each start.

| Record | Timing | Auto-resume on | Auto-resume off |
| --- | --- | --- | --- |
| Imported `probe`, display `until` plus numeric epoch | Already overdue | Thawed | Held |
| Imported `probe`, display `until` plus numeric epoch | Future reset | Thawed after real 60-second grace | Held |
| Native RFC3339 `until` | Already overdue | Thawed | Held |
| Native RFC3339 `until` | Future reset | Thawed after real 60-second grace | Held |

All eight cases passed. Additional measured controls:

- All eight shapes normalize without changing the reset deadline.
- An obsolete timer leaves a replacement freeze intact.
- A pure connection retry resumes with subscription auto-resume off.
- Nonverbose logs record blocked Wake, disabled auto-resume and recovery.
- Enabling auto-resume releases existing due timers without another Wake,
  explicit recovery, or restart.
- After an actual scratch-engine shutdown/start, recovery thaws all eight
  persisted overdue records and leaves pending continuation mail for each.
- Every fixture was halted; zero provider turns ran. The halt and replacement
  freeze remain effective. The private engine/database were stopped and removed.

The first adapter build needed a type correction (`normalize` takes `Value`).
The first restart harness incorrectly reused a connection after engine shutdown
also stopped its database; the restart-only control was corrected to reconnect
and passed. These were harness failures, not production changes. The matrix
itself completed before that harness error.

Debug build passed (1m43s). Production-source `cargo check -j 2` passed
(1m40s), with the temporary adapter removed and target output on E:.

Source-verified, not separately executed: both complete importer pipelines call
the tested normalizer, and normal non-SAFE_START runtime startup calls recovery.
Not measured: a paid provider probe or live release behavior. The original
incident's logs establish the parser failure; they do not establish the org's
historical auto-resume setting. No new engine fix was necessary for this report.
