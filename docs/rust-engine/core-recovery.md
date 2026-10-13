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

A refused launch is explained afterwards (laptop incident 2026-10-13: the
refusal's cause could not be recovered). `core-control begin` prints its
refusal as one JSON line of fixed words and numbers: `members` (every member
not proven gone, with role, `alive` or `unknown`, and for unknown the probe
call `open`, `wait` or `times` and its Windows error, e.g. 5 = access denied),
`session` or `quit` (that release failed). The desktop records each failed
`core-control` or `core-recovery` command as `core-control-failed` in
`diagnostics/desktop-engine-exits.jsonl`: command, action, duration, exit
code, Node error code, signal, timeout, and the refusal's allowed fields;
anything else in stderr is dropped. The same failure repeating (the 2-second
status tick) is recorded at most once a minute. The user's messages and every
lifecycle decision are unchanged.

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

## First review corrections (2026-10-12)

Actual attachment methods exposed a boot-topology state contradiction hidden
by earlier injected attachment tests: `attach()` requires an empty local slot,
but recovery marked that slot attached before both probes. Recovery now retains
the original boot topology separately while probing, restores task ownership
on failure, and still launches only the configured task after root release.
The regression executes the real first probe and real post-task retry method;
only the task invocation and root-release result are injected.

Initialized manual Restart now serializes with automatic recovery. A stamped
native engine-death result, without an intentional transition or Quit record,
uses the configured recovery callback (including window reattachment) instead
of requiring HTTP from the dead engine. Healthy/unknown cases retain the
authenticated transition. Explicit retry does not reset the automatic budget;
Quit during the native probe or transition prevents the later launch.

The matched predecessor runs nine composition cases with four failures; the
correction passes those nine and three additional cancellation/serialization
cases. No scheduled task, real desktop process, or live endpoint is used by
these tests. The prior process matrix remains historical evidence for its
recorded source: 18 behavior entries plus cleanup, 19 passing entries total.

## Composition audit and launch-refusal diagnostics (2026-10-13)

rig-opus audited the integrated recovery (438146e) on rust-engine 417083c.
No later merge touched its code; Muse's new processes use the same child jobs,
engine-wide kill-on-close job and graceful-first `stop_gracefully` as Codex.
The one gap found was diagnostic: a refused launch kept no cause (above).

Measured: the actual `core-control begin` of an engine built at 417083c and
one built with this change, each through its own commit's desktop module (real
`execFile`), against a crafted stopped generation in a private folder. Its
members were an idle child of the proof (alive), PID 4 (opening it is refused
to the non-elevated token: Windows error 5) and an absent PID. Before, the
refusal said only "still stopping" and the desktop recorded nothing; after, it
named the alive engine and the unreadable host with stage `open` and error 5,
and the desktop recorded exactly that, with no path or message text. Both kept
the stopped generation and showed the same message; with every member gone both
released it and recorded nothing (11/11 checks). The new desktop tests fail on
the unchanged module (5 of 18) and pass with it. This does not establish what
refused the laptop's launch: it makes the next refusal say.
