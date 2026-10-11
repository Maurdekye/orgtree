# Coupled Windows core lifecycle

Draft implementation and evidence notes, 2026-10-11. Not yet merged or installed.

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

Windows tears down interactive processes slightly before WTS may report logoff.
Known interactive process death therefore gets five seconds for session
reconciliation. A real normal sign-out removes the interactive membership and
keeps existing background engine behavior; an unknown WTS reading is not sign-out.

## Verification status

- Measured: seven native/policy tests passed at `26baf24`, including Windows
  creation-stamp probes and WTS session enumeration, plus stale-generation guards.
- Measured: engine/broker debug build passed after the pre-readiness changes;
  desktop typecheck passed at `8027558`.
- In progress: real isolated lifecycle matrix using production native components
  and the production desktop controller without an Electron window.
- Not yet proved: complete explicit-transition/sign-out matrix and hosted Codex
  graceful-drain evidence. No live process fault injection has been performed.

The approved profile directory is disposable rig state only. Build artifacts,
script bundles and evidence stay on D:. The hand-in must record checked cleanup.
