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
surviving engine. Engine root/guardian locks still prevent duplicate ownership.

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

## Verification status

Implementation checkpoint, not a review hand-in. Workspace check and focused
native/controller checks have run; production-path process recovery, launcher
and Quit-race proof are still pending. No live failure, sign-out, installer or
application build has been performed. Unit tests are not actual Electron
acceptance and old coupled-stop matrices do not validate this implementation.
