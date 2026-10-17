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


## Refusal reset selection (2026-10-17)

A new refusal is current evidence. The former anchor-once rule reused an old
wall for an identical countdown, then replaced it with a five-minute probe once
that wall expired. Read-only incident logs showed a repeated 16,525-second
Antigravity countdown taking that branch twice. A fresh refusal now anchors its
reported duration again and retains an older deadline only if it is later.

`runtime/usage_reset.rs` chooses the latest valid future reset from relative
h/m/s combinations, ISO timestamps with UTC/offset, a Claude-style local clock,
legacy pipe epoch, Claude `resetsAt`, Codex exhausted primary/secondary windows,
and Muse's typed millisecond quota reset. Local clock times that passed today
roll to tomorrow; an ambiguous local clock chooses the later instant. Named
IANA zones are unsupported; no timezone dependency was added. Malformed or
missing times retain the previous generic one-hour limit fallback, and Muse's
generic failures retain their separate recovery path.

Structured events belong to the active turn, not the actor's next login. A
cache-only lookup uses its captured serving account/provider/tier, rejects a
missing or mismatched registered account, and never probes the provider. Only a
successful available observation newer than the refusal, on an applicable full
window, may extend the deadline. Unrelated model pools, failed/stale/future-dated
readings and shorter resets cannot shorten or replace the parsed refusal.

The freeze record stores the selected reset for its held-until notice;
`freeze::wake_at` still adds 60 seconds before automatic wake/replay. No changes
were made to manual unstick, continue-on, halt/unhalt, timer compare-and-clear,
or the auto-resume setting. Their existing overrides and guards remain.

Author verification: eight regression tests at the red checkpoint executed with
seven expected failures and one unchanged fallback pass. Focused green tests
cover the incident countdown, typed reset units, ISO offset and local rollover,
later-evidence selection, grace, malformed input, and failed/unrelated cached
windows. No live writes, provider calls, installation or restart were used.


### 4.4.0 registered Antigravity logins

The 4.4.0 login feature stores registered profile observations under `agy:<id>`.
The freeze lookup follows the same account isolation rule as `agy_auth::login_of`
and `antigravity_account`: an ambient row or one without a nonempty profile
folder uses native `agy`; a registered profile reads only its own key. Missing
profile evidence does not borrow another login's deadline. This is 4.4.0-only;
the 4.3.2 line still serves only the native Antigravity login.

A cache-only regression uses synthetic native/profile resets of 24h/5h and a
second profile with no observation. Before the fix it chose the native 24h hold
for the registered profile. It also checks native aliases and missing-folder
fallback. No provider process or live data is involved.
