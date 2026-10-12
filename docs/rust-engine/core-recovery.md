# Independent Windows component recovery

User ruling, October 12 2026 09:14 UTC: recover the failed engine or desktop,
leaving its healthy counterpart alive. Only manual Quit terminates the whole
application. This replaces the coupled-stop behavior documented historically
in core-lifecycle.md. Ordinary agent child exits are unrelated.

The desktop admits automatic engine recovery only after native stamped death,
a five-second reconciliation delay, and native resource/admission checks. A
boot host may recover first: a new generation triggers attachment without
permission to spawn another engine. Managed engines publish the same private,
verified descriptor as boot engines so a replacement desktop can attach to the
surviving engine. Engine root/guardian locks still prevent duplicate ownership. Windows managed
engines are detached from libuv's desktop-owned child job while retaining their
control pipes and their own descendant job. Recovered boot engines use the
existing configured task; recovery never silently substitutes desktop rights.

A detached native observer retains exact process handles and derives the
replacement desktop executable from its native handle. One named owner per
canonical data root and role prevents duplicate observers. A second publication
owner serializes the final desktop launch with manual Quit. Recovery launches
are marked automatic and cannot clear a Quit barrier. Unknown native process or
Windows session state never authorizes a launch. Normal sign-out ends
interactive recovery and leaves the background engine behavior intact.

Admission uses one claim and one budget file per role: at most three distinct
failure identities in ten minutes, with five-second initial delay and
15/45-second inter-attempt backoff. It requires at least 3 GiB available physical
memory and 4 GiB commit headroom. Engine admission waits at most 120 seconds per
observed failed generation; desktop observation waits at most 300 seconds,
including any original 180-second installer/restart allowance. Exhaustion
leaves healthy survivors alive. Intent deadlines are never extended by retries.
Startup/conversion retains existing phase deadlines. A failed initial startup
leaves the desktop tray available; native recovery or explicit Restart engine
resumes the initializer without registering duplicate UI handlers. Conversion
failure is not automatically retried.

Manual Quit first writes a durable operator-logon barrier, even before the first
engine snapshot. This covers overlapping old/new engine generations and blocks
late automatic desktop launches. Launch cancellation is also checked by the
in-process Engine controller. If cancellation cannot be recorded, Quit reports
a retryable error before teardown. Successful Quit then uses the existing
bounded layout save, graceful Codex shutdown and durable forced-kill path.
An explicit new user launch can clear a stopped session after old members exit.

Diagnostics contain only fixed event names, generation/PID, native exit status
and time; raw stderr, credentials and message content are excluded. Native and
desktop exit logs each rotate at 256 KiB with one retained previous file.

## Verification and remaining limits

Measured on Windows against the committed source, rebased onto a2e6963:

- 18 production-path process checks: real Rust managed engine and production
  Node Engine/CoreLifecycle controller; engine replacement keeps desktop PID,
  desktop death keeps engine PID, replacement attaches, manual Quit confirms
  release, pending recovery is cancelled, exhausted budget keeps the survivor.
  A small native desktop stand-in separately proves actual native observer
  launch, exit status, duplicate/stale admission, transition suppression and
  Quit suppression. See `tools/rig/proofs/core-recovery.mjs` and its two fixtures.
- 22 focused desktop/controller checks, including preserving the configured
  boot-task path, cancellation during task launch, and update/ Quit separation.
- 38 existing Quit and Restart engine tests pass, including graceful-first,
  guarded force, refusal on changed identity, and installer stop behavior.
- 17 focused native checks pass; workspace check and TypeScript typecheck pass.
  The post-rebase native binary builds cleanly; the process proof records its
  SHA256 and the source/controller identities.

The first process proof exposed desktop-parent job coupling and a redundant
job escape on native replacement; the next exposed a managed descriptor left
behind after graceful shutdown. Matching process paths now pass. Managed
shutdown removes only its own descriptor while still holding the root lock.
Source inspection also corrected update preparation's accidental manual-Quit
barrier and ensured boot recovery retains the configured task/rights.

No installed app failure, real Windows sign-out, UAC prompt, scheduled-task
mutation, installer, packaged Electron launch or non-Windows execution was
performed. The native launch target is explicitly a stand-in, not Electron.
Task launch is injected in controller tests; renderer reloading/recreation is
source checked, not mounted native-window acceptance. Session-unknown,
sign-out, missing-helper and pre-ready policies have focused native tests;
full slow-conversion and helper/task integration were not rerun. The previous
Codex graceful-drain fixture is historical evidence of unchanged shutdown
machinery, not a new end-to-end Codex run. No performance improvement claim.

Isolated processes are stopped after proof, exact disposable profile-state
paths are checked before removal, and evidence remains outside live state.
Independent source/evidence review is required before integration.
