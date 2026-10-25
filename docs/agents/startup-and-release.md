# Startup and release

[Repository startup guide](../../AGENTS.md) · [All topics and entries](README.md)

Boot, shutdown, placement, installers, native integration, updates and release evidence.

These attributed records were moved from the root guide at `22daffd`; they retain the original substance, dates, verification limits and replacements. They are source evidence, not a declaration that every historical state is current. Read the signed decisions/current source before changing behavior. Inline source paths remain relative to the repository root; Markdown links were rebased. Add current detailed guidance here; preserve replaced records in history and update the coverage destination when moving one.

<a id="e-1df71884f6ecc434"></a>

## The tray left-click popup shows at most ten whole org rows, with native

Original section: AGENTS.md — working on Orgtree. Source lines 570–576.

<!-- preserved:e-1df71884f6ecc434 -->
- The tray left-click popup shows at most ten whole org rows, with native
  wheel/keyboard/scrollbar overflow and fresh-open scroll at the top. The existing
  window-state file's validated `recentOrgs` order tracks successful explicit
  open/focus/bind requests; startup restore, closing and geometry capture do not
  reorder it. Real deletion clears its entry. The popup remains scriptless and
  sorted unknown orgs retain engine order. See [tray recency](../../docs/rust-engine/tray-recency.md).
  [decided: user 2026-10-19 18:04Z; verified: `main/{traylist,org-placement,index}.ts`]
<!-- /preserved:e-1df71884f6ecc434 -->

<a id="e-b52bd7f16fe9c2fd"></a>

## Finish-page launch uses native Exec only when Setup's actual token is

Original section: AGENTS.md — working on Orgtree. Source lines 1580–1586.

<!-- preserved:e-b52bd7f16fe9c2fd -->
- Finish-page launch uses native Exec only when Setup's actual token is
  unelevated; elevated Setup keeps original-user shell dispatch. Both follow
  the exclusive launch claim; uncertain shell failure is never replayed with
  elevated rights. Dispatch does not prove engine readiness. See
  [Finish launch](../../docs/rust-engine/installer-finish-launch.md).
  [verified: `build/installer.nsh`; decided: coordinator/user 2026-10-19,
  4.3.3 slow fresh-install launch fix]
<!-- /preserved:e-b52bd7f16fe9c2fd -->

<a id="e-296151e6186b3f35"></a>

## EPIC tray mute (4.4.0) is the optional native boolean epicMuted, persisted

Original section: AGENTS.md — working on Orgtree. Source lines 1747–1753.

<!-- preserved:e-296151e6186b3f35 -->
- EPIC tray mute (4.4.0) is the optional native boolean `epicMuted`, persisted
  and broadcast with `epicMode`; its checkbox is visible only while EPIC is on
  and refreshes even in an open native menu. A 300ms final master gain fade
  silences ambience, events and reverb without stopping heat/motion. Saved
  mute applies before startup greetings. [decided: user 2026-10-17 11:06Z;
  verified: `main/tray-epic.ts`, `epic/{audio,pref,sync}.ts`; contract:
  [EPIC sound](../../docs/rust-engine/epic-activity-sound.md#tray-mute)]
<!-- /preserved:e-296151e6186b3f35 -->

<a id="e-894640a508e743c1"></a>

## Standalone engine (4.4.0): orgtree-engine standalone runs the engine with

Original section: AGENTS.md — working on Orgtree. Source lines 1848–1861.

<!-- preserved:e-894640a508e743c1 -->
- Standalone engine (4.4.0): `orgtree-engine standalone` runs the engine with
  no desktop — mandatory token (`ORGTREE_STANDALONE_TOKEN` or the generated
  `<data>/standalone-token`, also accepted as `Authorization: Bearer`),
  loopback bind unless `ORGTREE_BIND`, exact `ORGTREE_PORT`, fresh-root
  cluster bootstrap, no parent watcher. `serve`/`host` ignore all of it and
  are unchanged. Token headers are masked in the verbose wire log. The user
  MCP endpoint (`POST /api/mcp`, `/api/orgs/{slug}/mcp`, standalone only)
  acts as the user (user ruling 2026-10-16): `tools::usermcp` implements each
  tool against the desktop's own user paths (`Actor::User`, `Who::User`,
  `From::User`), never a fake agent caller; agent-only tools are not listed.
  Contract, deferred work (headless sign-in, Docker verification) and tests:
  [standalone engine](../../docs/rust-engine/STANDALONE-ENGINE.md).
  [decided: user 2026-10-12, 2026-10-16; verified: `config.rs`, `launch.rs`,
  `http/{mod,usermcp}.rs`, `tools/usermcp.rs`, `tools/rig/standalone-engine.mjs`]
<!-- /preserved:e-894640a508e743c1 -->

<a id="e-3c25e0bc01504ede"></a>

## Startup reveals every restored main window, including org-bound error windows;

Original section: AGENTS.md — working on Orgtree. Source lines 2074–2080.

<!-- preserved:e-3c25e0bc01504ede -->
- Startup reveals every restored main window, including org-bound error windows;
  background starts retain the set hidden. Quit/update/installer/signal/final
  Windows session paths capture all open placements before teardown; only the
  first final session event captures, so later closes cannot shrink membership.
  A cancelled session query and a refused installer do not latch shutdown.
  [decided: user/coordinator 2026-10-15; verified: `main/index.ts`; contract and
  measured limits: `docs/rust-engine/org-window-reopen.md`]
<!-- /preserved:e-3c25e0bc01504ede -->

<a id="e-1092df48f25d5191"></a>

## Run on boot changes one at a time (changeRunOnStartup, tray and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3243–3253.

<!-- preserved:e-1092df48f25d5191 -->
- **Run on boot** changes one at a time (`changeRunOnStartup`, tray and
  Settings alike). The checkmark is the SAVED value. It changes only once the
  change has finished: about 2 s in a non-elevated stand-in, never measured
  after a real Yes. Until then the tray item is disabled and reads "Run on
  boot (changing…)". The pending flag is
  set before anything asynchronous and cleared only in that change's `finally`.
  A second request is refused without touching it. Never show the new value
  early, and never force an open menu closed: a menu open when a change begins
  or ends is rebuilt after it closes.
  [decided: lead-astra 2026-10-11 20:00Z; verified: tests/startup-tray.test.mjs
  on the real closures; native menu view unverified (agents run in Session 0)]
<!-- /preserved:e-1092df48f25d5191 -->

<a id="e-ee741abd6133f57e"></a>

## Ending an engine's task does not stop a boot engine. Since the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3318–3328.

<!-- preserved:e-ee741abd6133f57e -->
- **Ending an engine's task does not stop a boot engine.** Since the
  core-lifecycle recovery (2026-10-12) an engine outlives its host, and a task
  End ends only the host. A manual End on the boot task therefore still leaves
  the engine running. An installer that cannot ask through the descriptor first
  writes `StopRequested` (REG_QWORD, Unix ms) into its HKLM record. A boot-mode
  engine polls that value every 2 s and stops gracefully on a request newer
  than its own start; a stale value never stops it and is never deleted. Only a
  rig run may read the request from HKCU (`ORGTREE_RIG_STOP_KEY`, under
  `crate::rig::active`). Never stop the engine by killing its host.
  [decided: coordinator 2026-10-15 11:54Z; verified: `src/install_stop.rs`,
  `tools/boot-engine-task.ps1`; proof `tools/rig/proofs/boot-host-stop.mjs` B/C; decision 80]
<!-- /preserved:e-ee741abd6133f57e -->

<a id="e-5f926d7012b68418"></a>

## Nothing on an engine's startup path may depend on powershell.exe. A

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3329–3342.

<!-- preserved:e-5f926d7012b68418 -->
- **Nothing on an engine's startup path may depend on `powershell.exe`.** A
  desktop-managed engine inherits its desktop's environment, and a desktop
  started from PowerShell 7 hands on a `PSModulePath` that lists PowerShell 7's
  modules first. Windows PowerShell 5.1 then cannot load the modules PowerShell
  7 also ships (`Get-Acl`: "found in the module 'Microsoft.PowerShell.Security',
  but the module could not be loaded"). The attach descriptor's DACL read-back
  ran `Get-Acl` that way, so in the v4.3.0 release smoke no managed engine
  started ("cannot publish managed engine attachment"); it now reads the ACL
  with `GetNamedSecurityInfoW` (`host::win::verify_restricted`). Use Win32 calls
  for such checks. A Windows PowerShell child that cannot avoid such a module
  gets `windowsPowerShellEnv()` and `WINDOWS_POWERSHELL` (`apps/desktop/main/policy.ts`),
  as the desktop's own `verifyDescriptorTrust` does for its `Get-Acl`.
  [verified 2026-10-15: CI runs 38786926928 and 38794172790, `src/host.rs` tests,
  `tests/attach.test.mjs`; details `docs/rust-engine/core-recovery.md`]
<!-- /preserved:e-5f926d7012b68418 -->

<a id="e-12cb0f7343c9dd07"></a>

## Agent settings has a horizontal grant bar (canvas/creditgrant.tsx). Grants

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3405–3411.

<!-- preserved:e-12cb0f7343c9dd07 -->
- Agent settings has a horizontal grant bar (`canvas/creditgrant.tsx`). Grants
  exclude the fixed own seat; the floor is grant minus free (reports' seats and
  grants). User cascade headroom propagates root-to-parent with whole-credit
  ancestor raises, matching `ops::ensure_room`. Release uses the existing
  `reallocate` action; refusal restores the saved value. No scope save or process
  restart. [verified-from-source and mounted renderer smoke: 2026-10-07;
  user request 13:49Z, DECISIONS 52]
<!-- /preserved:e-12cb0f7343c9dd07 -->

<a id="e-4e128ee2bb097321"></a>

## Windows core recovery preserves healthy peers: unexpected engine/desktop

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3508–3515.

<!-- preserved:e-4e128ee2bb097321 -->
- Windows core recovery preserves healthy peers: unexpected engine/desktop
  failure recovers only that component. Missing helpers, startup delay and
  exhausted retries do not request whole-app shutdown. Manual Quit persists a
  logon-scoped cancellation barrier before graceful drain; automatic startup
  cannot clear it. Native PID+creation stamps distinguish death from Unknown.
  This supersedes the October11 coupled-stop policy. [decided: user
  2026-10-12 09:14Z; verified: `core_state.rs`, `core_recovery.rs`,
  `apps/desktop/main/core-lifecycle.ts`; details `docs/rust-engine/core-recovery.md`]
<!-- /preserved:e-4e128ee2bb097321 -->

<a id="e-178f4b36d69d3fb6"></a>

## A refused launch says why: core-control begin prints one fixed-shape JSON

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3516–3522.

<!-- preserved:e-178f4b36d69d3fb6 -->
- A refused launch says why: `core-control begin` prints one fixed-shape JSON
  refusal (each member not proven gone: role, alive/unknown, and for unknown the
  probe stage and Windows error; or which release failed), and the desktop
  records failed lifecycle commands as `core-control-failed` in its exit log,
  never raw stderr, a repeat at most once a minute. Diagnosis never changes a
  decision: Unknown stays Unknown. [verified: `core_state.rs` begin,
  `core_process.rs` diagnose, `core-lifecycle.ts`, 2026-10-13]
<!-- /preserved:e-178f4b36d69d3fb6 -->

<a id="e-f5f320a50f70c397"></a>

## Desktop startup waits for stdio closure before classifying child exit: a

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3529–3533.

<!-- preserved:e-f5f320a50f70c397 -->
- Desktop startup waits for stdio closure before classifying child exit: a
  buffered root-owned refusal must reach attach retry; a dead child's buffered
  ready line is rejected. The silence timer still bounds an unclosed pipe.
  [verified: 2026-10-20 `apps/desktop/main/engine.ts`;
  `tests/engine-refusal-order.test.mjs`; `docs/startup-budget.md`]
<!-- /preserved:e-f5f320a50f70c397 -->

<a id="e-963073abf5afa506"></a>

## Anything running from the installation folder blocks an upgrade, including

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3534–3546.

<!-- preserved:e-963073abf5afa506 -->
- Anything running from the installation folder blocks an upgrade, including
  the desktop's core-recovery observer (`resources\engine\orgtree-engine.exe
  core-recovery watch`, started outside every job). A desktop closed for an
  install (installing transition) is not recovered: the observer stands down at
  once. The installer ends an older observer (4.3.0-alpha.0/alpha.1, which
  waited out 180 s and failed two real upgrades in Prepare's 150 s budget) only
  with this installation's engine image, that command line and its desktop
  verifiably gone; nothing else is killed. A boot-step timeout names what is
  still running (dialog: five; `%TEMP%\orgtree-installer-upgrade.log`: all).
  [decided: coordinator 2026-10-14; verified: `core_recovery.rs` stands_down,
  `tools/boot-engine-task.ps1`, `tools/installer-upgrade.ps1`; boundary test
  `tools/test-installer-recovery-observer.mjs`; details
  `docs/rust-engine/core-recovery.md`]
<!-- /preserved:e-963073abf5afa506 -->

<a id="e-c61bfdb1caeb6a53"></a>

## Three kinds of change never share a commit: the engine (engine/rs/); desktop changes the

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3839–3842.

<!-- preserved:e-c61bfdb1caeb6a53 -->
- **Three kinds of change never share a commit:** the engine (`engine/rs/**`); desktop changes the
  rewrite needs (launcher, packaging, boot task, renderer changes that follow from the feature
  differences); and purely visual UI work, which goes on a separate branch `rust-engine-ui`
  stacked on `rust-engine`. The canvas is not touched. [decided: user, DECISIONS 29–30; PLAN §12]
<!-- /preserved:e-c61bfdb1caeb6a53 -->

<a id="e-7b670aa6ae107e6a"></a>

## Prototype restarts. Every prototype install restarts Orgtree, which ends running turns and

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3843–3846.

<!-- preserved:e-7b670aa6ae107e6a -->
- **Prototype restarts.** Every prototype install restarts Orgtree, which ends running turns and
  kills every process agents started. Take only work that survives that: small committed steps,
  no long-running jobs. When a build is announced, commit and end your turn. Stop any task that
  restarts keep breaking. [decided: user, DECISIONS 39]
<!-- /preserved:e-7b670aa6ae107e6a -->

<a id="e-df3cdea727e6f716"></a>

## Builds and installs are the user's. Prototype builds are 4.0.0-alpha.N (N counts

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3847–3849.

<!-- preserved:e-df3cdea727e6f716 -->
- **Builds and installs are the user's.** Prototype builds are `4.0.0-alpha.N` (N counts
  delivered builds), delivered as local installers. No agent builds, tags, publishes, installs or
  restarts. [decided: user, DECISIONS 37–38]
<!-- /preserved:e-df3cdea727e6f716 -->

<a id="e-f3cf2d11de4165b7"></a>

## Read-only copies of live data are allowed for rehearsals (file copies or database dumps):

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 3850–3852.

<!-- preserved:e-f3cf2d11de4165b7 -->
- **Read-only copies of live data are allowed for rehearsals** (file copies or database dumps):
  they never change anything live, stay in your own scratch folder (they hold secrets), are never
  committed or sent, and are deleted when no longer needed. [decided: user, DECISIONS 40]
<!-- /preserved:e-f3cf2d11de4165b7 -->

<a id="e-79c3d6f6ce1ca992"></a>

## Custom native icon colors (2026-10-07, verified from source and Electron PNG smoke).

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4012–4018.

<!-- preserved:e-79c3d6f6ce1ca992 -->
**Custom native icon colors (2026-10-07, verified from source and Electron PNG smoke).**
Tray/window custom colors tint the neutral accent layer, preserving the `#18232d` iris
and its mixed edge pixels. Electron's BGRA bitmap is premultiplied by alpha. Keep tint
changes versioned in the generated taskbar icon filename so old cached artwork is not
reused. Preset/loading ICO assets stay unchanged; rainbow cycling is renderer-only CSS
and the native icon retains the selected custom color. [`main/tray-tint.ts`,
`main/index.ts`, `tools/generate-icon.mjs`, renderer `rainbow.ts`]
<!-- /preserved:e-79c3d6f6ce1ca992 -->

<a id="e-663e86618b46e12d"></a>

## Tray list status sizing (2026-10-07, verified from source and Electron smoke).

Original section: Orgtree 4.0.0 (Rust engine): read this first. Source lines 4020–4025.

<!-- preserved:e-663e86618b46e12d -->
**Tray list status sizing (2026-10-07, verified from source and Electron smoke).**
Pass zero rows for unavailable/loading/error and empty-list popups: they use a 260 px
width, with one 28 px nowrap message row plus 12 px border/padding. Keep populated
lists at 200 px and allow their usual vertical scroll when long. `Engine.orgActivity`
maps missing endpoint, failed request and malformed responses to the shared unavailable
message. [`main/traylist.ts`, `main/index.ts`, `main/engine.ts`]
<!-- /preserved:e-663e86618b46e12d -->

<a id="e-2a08a4d882f0c3b9"></a>

## Launch, idle recheck and forecast must use the same combined instruction/skill

Original section: Shared skills and installed plugin imports (2026-10-15). Source lines 5192–5196.

<!-- preserved:e-2a08a4d882f0c3b9 -->
- Launch, idle recheck and forecast must use the same combined instruction/skill
  startup digest; a raw-vs-combined comparison retires unchanged parked CLIs.
  The idle check retains applicable skill folders, not a frozen skill snapshot.
  [verified: `runtime/actor.rs`; regression: `tools/rig/proofs/skills-idle.mjs`;
  2026-10-15]
<!-- /preserved:e-2a08a4d882f0c3b9 -->

## The Changelog and the first launch after an update (2026-10-24, 4.4.5)

Docket changelog-window-one-row-per-version-pinnable-po. The engine bundles every
`docs/release-notes-<x.y.z>.md` and `docs/releases.json` at build time (build.rs
`release_notes`, `crate::changelog`): one row per published release, newest
first, dated by GitHub's `published_at` (`TIME_SOURCE`; user 2026-10-25
09:01:38Z "GitHub publish time"). Published releases only ("Published only"): a
pre-release build has no row of its own, which replaced its Unpublished build
row; a release build, which its own list cannot have yet, lists itself, dated by
the commit `ORGTREE_BUILD_COMMIT` names. The panel reads
`GET /api/changelog` and `/api/changelog/{version}`; agents read the same notes
as glossary files beside orgtree-app › app-shell › changelog
(`providers::skills::builtin`), so there is no Changelog tool.

Each notes file is its GitHub release description (release.yml `--notes-file`).
The 52 releases published before the panel were synced from GitHub on
2026-10-24: three differed (edited on GitHub after publishing) and twelve had no
file. Edit the file, not only the GitHub release. After publishing, add the
release to `docs/releases.json` ([release guide](../ci-release.md#add-it-to-the-changelog));
`tests/release-list.test.mjs` and the engine's `changelog` tests check the list
against the notes.

`main/changelog-launch.ts` keeps in `userData/changelog-seen.json` the newest
release the Changelog has listed, not the version run (coordinator
m4455f7a604f2): `newestListed` over the same `docs/releases.json`
(`main/index.ts` imports it; esbuild inlines it) and the running version, the
engine's top row. No record and no earlier update-log.json entry (read before
this run's own `startup` line) is a fresh install: it records that release and
opens nothing. A newer listed release than the record, or no record after
earlier runs, tells the first window once (`desktop:changelog-after-update`) and
records it only then, so a background start keeps it for a later window. The
record is never lowered: the same release, a downgrade and going back up open
nothing, and so does an alpha-to-alpha update that lists no newly published
release. 4.4.5-alpha.5 recorded the version it ran, which compares the same way.
The renderer opens the panel unless `ls:orgtree-changelog-after-update` is off.
[decided: user 2026-10-24 22:13:55Z–22:17:14Z, 2026-10-25 09:01:38Z; verified:
`changelog.rs`, `build.rs`, `main/changelog-launch.ts`, `changelog.tsx`]
