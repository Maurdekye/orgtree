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
including a restart's original 180-second allowance. A desktop that exits
inside its own installing transition is not recovered: the observer stands
down at once (see Installer transitions below). Exhaustion
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

## Installer transitions (2026-10-14)

Two real upgrades from 4.3.0-alpha.0 to alpha.1 failed in the installer's
Prepare step with "did not stop within 150 seconds" (docket
installer-can-t-replace-a-running-orgtree-an-ins). When Setup closed the
desktop, the desktop entered an installing transition (`transition_until` 180 s
ahead, `installing`). This observer runs from `resources\engine`, outside every
job. It waited the allowance out after the desktop exited, then relaunched the
old application with `--core-recovered`. The boot step waits for every process
of the engine folder, so it gave up first. Alpha.0 came back 180 s after each
close. Measured from the user's installer logs: within 1.3 s of the engine's
stop, every agent descendant had gone (the engine's root job is kill-on-close
without breakaway); only the observer and its console host were left.

Coordinator rulings, 2026-10-14:

- **D2:** the observer stands down as soon as its desktop exits inside that
  desktop's own installing transition, and records
  `desktop-recovery-stood-down-for-install`. The installer's relaunch path
  covers a failed install. Restart transitions and crashes keep their recovery.
  This narrows decision 72.
- **D1:** an older observer (alpha.0, alpha.1) is ended by the installer
  itself, only under exact checks (`tools/boot-engine-task.ps1`,
  `tools/installer-upgrade.ps1`; see `docs/windows-release.md`).

Measured with `tools/test-installer-recovery-observer.mjs` at ceca38b: real
observers of an alpha.1-equivalent engine (b8a00b5; its core files are
identical to 63095f4 and 2e3d287) and of the fixed engine, the real installer
scripts, and a scratch installation and data root. The task is a test double,
and a 30 s allowance against a 20 s budget stands in for 180 s against 150 s.
All 11 scenarios passed (71 checks):

- **Red, alpha.1 boot step:** times out at 21.3 s. The observer relaunches the
  desktop 31 s after it closed.
- **Red, alpha.1 close helper (per-user):** times out at 21.2 s.
- **Fixed boot step:** ends that observer and completes in 4.4 s.
- **Fixed close helper:** completes in 6.1 s, per-user and all-users.
- **Fixed observer:** gone within 3 s of the close, so even the unchanged boot
  step completes in 0.9 s.
- **After either fix,** the engine binary opens for writing within 53 ms.
- **Regressions:** a crashed desktop is still relaunched (6 s). A restart
  transition keeps its allowance (relaunch at 30 s). An observer whose desktop
  runs is never ended; the step refuses and names it.

The coordinator's other lead was an agent's tool commands outliving the
engine. Rig proof `tools/rig/proofs/agent-tree-stop.mjs` checks it with a fake
Claude CLI that leaves two long tool commands: one running under its shell,
and one orphaned in the background (invisible to the installer's parent-id
walk). After the installer's own shutdown request, the engine stopped in
504 ms and both commands were gone by 2.2 s. The rig's keeper had nothing to
reap, so the engine's kill-on-close root job had ended them. No engine change
was needed for that part.

Limits:

- No packaged installer, real scheduled task, UAC elevation or live
  installation was used.
- The test's process reading is not elevated, so it leaves out unreadable
  processes that do not name the scratch installation.
- The boot step's own refusal of unverifiable processes remains.

## Descriptor read-back without PowerShell (2026-10-15)

The v4.3.0 release smoke (CI run 38786926928) failed. The desktop it started
under the smoke's basic-user token stayed up, but every managed engine it
started stopped about a second after its PostgreSQL was ready. The desktop's
recovery then spent its whole budget (one start and three admitted retries) as
designed. Version 4.2.0 had passed the same smoke because a managed engine did
not publish a descriptor then.

Diagnostic run 38794172790 (smoke-only changes on `ci-test/orgtree-release`)
found the cause:

- All four engines exited with code 1 and logged "engine stopped with an error
  error=cannot publish managed engine attachment".
- The publication's DACL read-back spawned `powershell.exe` to run `Get-Acl` in
  the environment the engine inherited. In CI every Orgtree process descends
  from the step's PowerShell 7, whose `PSModulePath` lists PowerShell 7's
  module folders first. Windows PowerShell 5.1 then cannot load
  `Microsoft.PowerShell.Security`: "The 'Get-Acl' command was found in the
  module 'Microsoft.PowerShell.Security', but the module could not be loaded."
- The same failure stopped a managed engine started directly as a plain
  standard user. The token was never the cause: opening the token and the
  process, the explicit-owner create and the rename all worked.

`host::win::verify_restricted` now reads the owner and DACL with
`GetNamedSecurityInfoW` and applies the same rule: the owner is the operator,
and the DACL's allow and deny entries, none inherited, name exactly the
operator, SYSTEM and Administrators. No child process runs, so the inherited
environment, a missing or blocked `powershell.exe` and PowerShell's language
mode no longer matter. The boot host's publication uses the same function. A
managed engine's fatal error now names the failed step ("cannot publish managed
engine attachment: <reason>").

Measured (logs in `D:/orgtree-work/tmp/rig-opus/batch-smoke430/logs` and the CI
runs named here):

- Local, red (`7c6d78c`, the tests with the PowerShell read-back): 2 passed, and
  `verification_ignores_an_incompatible_powershell_module_path` failed. That
  test puts a PowerShell 7-style `Microsoft.PowerShell.Security` first in
  `PSModulePath`; locally it reproduces the CI error string exactly.
- Local, green (`ad3fbda`): 3 of 3 passed. The read-back took 0.01 s, against
  3.39 s for the PowerShell one.
- `cargo clippy --all-targets`: 109 warnings at `ff3fadc` and at the fix,
  identical. None is on a changed line.
- CI, red (run 38800365123, the runner's own PowerShell 7 environment): 1
  passed and 2 failed. Even `protected_descriptor_verifies` failed there, which
  is the production failure itself. The smoke failed as before.
- CI, green (run 38800661874, the fix in that same environment): 3 of 3
  passed. The launch smoke passed: attempt B's desktop stayed up and its engine
  answered, as in 4.2.0. Its `engine-attach.json` carried exactly
  `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<operator>)`. A managed engine started
  directly answered and published its descriptor both as a plain standard user
  (owner and operator entry: that user) and under the basic-user token.

Limits:

- No real user's machine was used. That a desktop started from a PowerShell 7
  prompt passes this environment to its engine is inferred from the CI
  environment, not observed on a desktop.
- The smoke's attempt A, Orgtree.exe as the standard user through
  CreateProcessWithLogonW, still exits with code 1 during Chromium's first
  startup lines, before any Orgtree code runs. It did the same in 4.2.0.
- The desktop's own descriptor check (`verifyDescriptorTrust` in
  `apps/desktop/main/policy.ts`) still runs `Get-Acl` through `powershell.exe`
  in the desktop's environment. That is the docket item
  desktop-can-t-verify-the-engine-descriptor-when-l (4.3.1).
- The Android type-check was not run: every changed line is Windows-only.
