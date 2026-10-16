# Working checkups and docket reminders

An agent reporting `working` could remain quiet indefinitely when it had no
actionable docket item. On 2026-10-16 the user replaced that rule: wake any
working agent after about 20 minutes without activity. Docket reminders remain
a separate mechanism.

## Contract

- The working-checkup switch enables checks for current `working` status,
  independently of docket items, ownership, blocked items and user-held docket
  decisions. `blocked`, `idle` and `done` statuses earn no working checkup.
- The docket-reminder switch independently enables reminders naming actionable
  work owed to an agent. Its existing blocked-item, attention and attached-question
  exclusions and optional all-blocked-org behavior remain unchanged.
- If both are due for the same agent in one sweep, the docket reminder takes
  precedence. There is one wake. Its resulting turn refreshes the real-activity
  anchor, so a generic checkup does not follow on the next sweep.
- Both retain the existing admission safeguards: live agent, no halt, freeze,
  limit lock, inflight/open turn, queued waking mail or delivery, and no org stop
  latch; busy actors, slot waiters and cache keepalives defer automatic wakes.
  Ordinary idle-only turn admission is rechecked before running.
- The sweep runs about every 20 seconds. Eligibility requires strictly more than
  20 minutes since the latest turn/status/activity stamp. Missing anchors are
  initialized first. Durable reservation stamps provide restart deduplication
  and failed-admission cooldown. This is not a precise timer.

## Diagnosis and revised rule

The overnight investigation read 640 successful sweeps from 05:20–08:53 UTC on
2026-10-16. All admitted the coordinator past durable and runtime checks, with
both switches enabled, but neither reminder function was entered. The branch
path established an empty actionable docket set. This was deliberate prior
behavior, introduced in Python commit `7436df1` and retained in Rust. User rulings
at 10:01–10:03 UTC replace it for working checkups only, preserve independent
docket wakes, and explicitly preserve docket precedence when both are due.

## Verification

The independent tests-first run at `4a29b39` against base engine `b3791bb`
measured 13 passing checks and three expected assertion failures: working with
no items, working with blocked-only items, and the checkups-only recipient set.
Its JSON verdict was false, although the old proof returned `save()` and exited
zero; the proof now returns `summary()` so a failing verdict reaches the runner.
The product change follows that measured red. Final green verification is pending.

The tests-first `tools/rig/proofs/reminders.mjs` proof covers working with no
docket items, working with blocked-only items, non-working status controls,
each mechanism enabled alone, docket precedence when both are due, cooldown
after the docket turn, and both switches disabled. It retains the existing
reviewer/deployer routing, passive-notice, blocked-option and user-held-item
controls. `reminder-race.mjs` exercises the preserved idle-only admission path.

Run these only through the isolated synthetic rig and fake CLI. Source syntax
checks do not establish that the runtime proof passed; compiled results and
exact source/binary provenance belong in the review receipt. No live scheduler
or provider experiment is needed for this change.

The built-in instruction wording changes the startup prefix for future sessions
that load it. A process restart alone does not prove a provider cache miss or hit;
existing sent prefixes are not rewritten by the documentation change.
