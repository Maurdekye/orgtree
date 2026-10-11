# Coupled Windows core lifecycle

Implementation and evidence notes, 2026-10-11. Not yet merged or installed.

The user ruled that a signed-in operator must not be left with a partly running
application after a core process dies. The cohort comprises the desktop, engine,
sign-in helper and boot supervisor in boot-task mode. Manual startup with startup
disabled has only its desktop and managed engine. Agent children and window
visibility are not cohort membership.

Membership uses the existing authenticated desktop pipe proof (same SID,
interactive token, pipe server PID and broker secret). A separate registration
operation means the desktop remains a member even when the helper owns the
credential lease. Process observations compare PID and creation time; an HTTP
timeout, lease expiration or unreadable process is not evidence of death.

The engine writes a small atomic identity journal. A stop record is immutable and
names that exact generation. Survivors request the normal engine shutdown/drain;
the helper drains its hosted Codex jobs through their existing bounded shutdown
path. Automatic task retries see the stopped generation and exit successfully.
A new desktop launch can release it only after its old members have exited.

## Startup and bounds

The missing-member grace is 120 seconds, chosen as an implementation value. It
begins when authenticated HTTP registration becomes available, not at Windows
sign-in or raw engine spawn: a converting engine cannot yet accept members.
An early observer records identities already known (parent host or managed
desktop, and members carried across an authenticated replacement) and detects
their death during startup. It does not restart the missing-member clock.

Existing pre-readiness limits remain:

- Boot host: 120 seconds without a startup progress checkpoint; 3,600 seconds
  between checkpoints during conversion/import (`host.rs`).
- PostgreSQL recovery: up to 3,600 seconds (`pg.rs`).
- Desktop attaching during conversion: a checkpoint can be at most 3,600 + 120
  seconds old, with an absolute four-hour attachment ceiling (`engine.ts`).
- Managed desktop startup retains its existing 60-second ordinary silence budget
  and conversion-specific window.

An authenticated explicit restart or installer replacement has one 180-second
transition allowance. Repeated calls cannot extend it. Ordinary retries cannot
clear stopped-generation evidence. An expired transition stops the cohort.
Desktop completion can precede replacement helper registration. Its completion
request therefore remains pending within the original deadline until all required
native identities are alive. Member registration can finish that pending request;
completion cannot clear an expired allowance before the periodic observer runs.

Windows tears down interactive processes slightly before WTS may report logoff.
Known interactive process death therefore gets five seconds for session
reconciliation. A real normal sign-out removes the interactive membership and
keeps existing background engine behavior; an unknown WTS reading is not sign-out.

## Verification

The isolated rig runs actual Windows engine, boot host and sign-in helper
executables, plus the production desktop lifecycle and credential controllers
bundled into a Node process. It does not run the Electron UI or an installer.

- Fault/startup matrix: 33 checks passed. Each core member was terminated in
  turn; all survivors stopped and automatic task retry did not revive the cohort.
  Ordinary child exit left it alive. A known parent death stopped pre-ready
  startup, a valid 130-second conversion delay survived, and a missing helper
  stopped the application after the 120-second registration grace.
- Restart matrix: 13 checks passed. Authenticated replacement kept the desktop
  and helper alive, the successor inherited its deadline, completion cleared it,
  repeated requests could not extend it, and the actual 180-second timeout
  stopped all members.
- Sign-out/drain matrix: 9 checks passed. Debug-only simulated WTS sign-out kept
  the background host and engine running. On a separate desktop fault, a hosted
  Codex protocol fixture exited through the production graceful drain, with a
  durable graceful-exit record and no forced-termination record.
- Desktop controller tests: 7 checks passed, including automatic versus explicit
  launch, uncertain probes, definite native stop, and transition actions.
- Installer-style replacement and pre-ready expiry: 12 checks passed. Replaced
  desktop/helper identities registered without extending the deadline; completion
  restored fault detection. A converting successor stopped at the inherited
  deadline before becoming ready, and task retry did not recreate it.
- Final source checks: workspace cargo check passed; workspace tests 85/85
  passed (helper 3, engine 82); renderer typecheck passed. Final native build
  took 18.73 seconds; cargo check took 22.00 seconds.

Evidence is produced by `tools/rig/proofs/core-lifecycle.mjs`; the docket records
the exact run paths and source versions. The first matrices precede final startup
edge refinements, which have their own targeted replacement proof.

| Rig run suffix (UTC, 2026-10-11) | Checks | Coverage |
| --- | ---: | --- |
| `161843` | 33/33 | Faults, startup, slow conversion |
| `162508` | 13/13 | Restart and real transition deadline |
| `163318` | 9/9 | Simulated sign-out, graceful hosted drain |
| `163835` | 12/12 | Installer member replacement, pre-ready expiry |
| `164856` | expected failure | Original binary, desktop completes before helper starts |
| `165047` | 8/8 | Fixed desktop-first completion, delayed helper registration |

Each run is under `rig/agy-astra/evidence/core-lifecycle-20261011T<suffix>`
in the D: work area, with result JSON and preserved diagnostics. All four
temporary profile-state copies were removed after exact resolved-path validation
and checking that their processes were gone; their temporary interactive tasks
were removed. No ACL was changed. Build locks were released.

Independent review found that the initial installer proof waited for both members
before completing, hiding production's asynchronous startup order. The new
desktop-first case fails against the original binary and passes against the fix:
completion stays pending beyond the five-second death grace, keeps the same
deadline, and finishes when the delayed helper registers. Both additional
temporary profile-state copies were checked and removed too. Native boundary
tests cover completion at/past expiry and each required member already gone.
After the review fix, workspace tests passed 88/88 (helper 3, engine 85),
including all three new completion-boundary tests. The fixed native build
passed in 35.33 seconds. Earlier desktop checks are unchanged by this engine-only
fix; the revised production-order rig passed all eight checks.

Limits: normal Windows logoff is simulated, not performed on the live session;
the hosted child is a scripted Codex protocol fixture, not a model inference run.
Manual startup's optional boot roles are covered by policy tests. The Electron
installer and real Windows sign-out remain release-environment checks. No live
process fault injection has been performed.

The approved profile directory is disposable rig state only. Build artifacts,
script bundles and evidence stay on D:. The hand-in must record checked cleanup.
