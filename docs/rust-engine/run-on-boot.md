# Run on boot, and agents in the signed-in session (decision 83)

Orgtree 4.x starts its background engine at boot in Windows Session 0: the
"Orgtree Background Engine" task, boot trigger, S4U as the operator. Session 0
has no interactive desktop (no real cursor or input, a 1024x768 stand-in
display, none of the user's windows). Decision 79 (2026-10-15) let the
operator move the whole engine into their session at sign-in instead ("engine
starts": at boot, or at sign-in), at the cost of nothing running while they
were signed out. On 2026-10-16 the user replaced that choice (docket
`option-to-run-the-background-engine-in-the-user-s`, 09:37Z): "agents always
start at boot, and then automatically get upgraded when signed in". So the
engine always starts at boot, and while the operator is signed in its agents'
CLIs run in their session, started there by the sign-in helper.

## The switch

One checkbox, **Run on boot** (09:38Z; it was "Run on startup", and it is
still stored as `startAtLogin`), in App settings › Runtime › Desktop, in
first-run setup and in the tray. The tray item mirrors the setting.

- **On** (the default): the boot task starts the engine at boot, and the
  "Orgtree Credential Helper" task starts the helper at the operator's
  sign-in. The window's own sign-in entry follows the switch as before.
- **Off:** both tasks are disabled, never deleted, and nothing of Orgtree
  starts by itself (decision 70).
- **Where Orgtree cannot start at boot** (a per-user installation, macOS,
  Linux) the same switch reads **Run on sign-in** and starts Orgtree at
  sign-in as before (coordinator ruling A). The desktop names it from the
  tasks it reads (`desktop:startup-kind`): an installation without the boot
  task is "sign-in".
- A change on an all-users Windows installation is one elevated script behind
  one Windows permission prompt (`runonstartup.ts` `elevatedStartupScript`).
  It verifies both tasks' markers before changing either, switches both, and
  writes `RunOnStartup` to the installer's record. It never stops, starts or
  deletes a task: a running engine keeps running. The switch flips only once
  the change reads back; a declined prompt says what still holds ("so Orgtree
  still runs on boot"). One change at a time, from the tray or Settings.
- Crash recovery and "Restart the background engine now" start the boot task
  (`startEngineTask`).
- **Run Orgtree as administrator** re-registers the helper task with the
  matching run level, highest available or least privilege (ruling C), before
  it writes its own value. The helper's run level is what the agents' CLIs it
  starts get.

## Tasks and the installer's record

Both tasks belong to the installer (`tools/boot-engine-task.ps1`).
Administrators can change them; the operator can only read and run them. Each
task's description carries the installer record's id.

- The protected record `HKLM\SOFTWARE\Orgtree\BootEngine` holds `RunOnStartup`
  (DWORD, decision 70). `StartupMode` (decision 79) is deleted from it at the
  next Prepare.
- **Upgrade from 4.3.x** (ruling E): Register deletes the obsolete "Orgtree
  Sign-in Engine" task after stopping it, only when it is the installer's own
  (marker `com.maurdekye.orgtree.signin-engine.v1:<id>` and the expected
  principal and action), and never registers it again. Both earlier choices,
  boot and sign-in, become "Run on boot" on; off stays off. Uninstall deletes
  a leftover one too. `orgtree-engine-host.exe`, the sign-in task's windowless
  launcher, is no longer shipped.
- Toggling "Run on boot" still disables rather than deletes (decision 70).

## Where agents run

The engine stays in Session 0. When an agent's turn starts, its CLI starts
where it should run (`runtime/session_host.rs` `wanted`):

- **In the operator's signed-in session** while the sign-in helper holds the
  bridge's host role (`Bridge::can_host`: a live 20 s lease, the helper's
  process alive), through the helper (decision 68, phase 2, now for every
  harness): Claude, Codex, Muse, Antigravity and OpenCode. bypassPermissions
  seats are hosted too (the user 09:43Z: "Yes, all agents"; the one-line switch
  `session_host::HOST_BYPASS_SEATS`), superseding decision 68's Q1.
- **In Session 0**, started by the engine, while no helper hosts, and when a
  hosted start fails (the engine logs `the sign-in helper could not start the
  CLI; starting it in Session 0`).
- An engine that is not in Session 0 (a per-user installation, a desktop-
  started engine) runs every CLI in the signed-in session already; nothing is
  hosted.

The helper starts only the five harness CLIs, by absolute path
(`credential_broker_host::hostable`: `claude.exe`, `codex.exe`, `agy.exe`,
`opencode.exe`, `muse-bin-<version>.exe`). The request carries the child's
whole environment (the engine's own, or the harness's cleared one, with its
changes), so neither side logs more than pids and fixed codes. Per-agent
limits are unchanged, and so are the forced-kill records of Codex and Muse:
a hosted CLI's graceful exit or forced end goes to `codex-kills.log` like a
local one's.

Harness details: Muse drops `--disable-sandbox` when hosted (its OS sandbox
works in the user's session); Codex keeps its own seat logic
(`codexrt::seat_sandbox`, the sandbox chosen once per launch); OpenCode is
hosted through its ACP connection; the Claude keepalive CLI that holds a
prompt cache warm stays in Session 0.

## Moves happen at a turn boundary

Placement is chosen at each turn's start (`actor` `want_hosted`), never during
a turn. A warm CLI in the other placement is replaced at that turn's start
through the existing reuse checks. A CLI that still holds background work
(`bg_pending`) is not replaced: it moves at a later turn.

**Sign-out** ends the helper, its jobs and every hosted CLI. A turn whose
hosted CLI ends while the helper is gone (checked for up to 2 s) stops
cleanly as `the user's Windows session ended`: no failure report and no error
left on the agent, a `session` row in its conversation ("it continues in
Session 0"), its claimed mail requeued when the CLI had done nothing yet (the
usual rule), and a waking message: "The user's Windows session ended while
you were working, so your turn stopped. Continue where you left off." Its
next turn runs in Session 0.

## What agents are told

- **A real move, either way**, delivers an `[ORGTREE SESSION NOTICE]` in the
  turn where it took effect: into the signed-in session ("with access to their
  desktop and apps"), or down to Session 0 ("desktop access is lost, because
  the user signed out or Orgtree's sign-in helper stopped"). It is plain
  system mail, claimed into that turn.
- **No notice** on an agent's first turn ever, and none when a restart comes
  back in the same session: the last placement is kept per agent
  (`ot.agents.extra.session`, `signed-in` or `session0`).
- **The RESTART NOTICE** an agent receives at its first turn after an engine
  start gets a last line, `Session access at start: Session 0.` or
  `Session access at start: signed-in session.`, from where that turn's CLI
  really runs. The stored notice is updated to match.
- **Restarts while signed in:** after an engine start the helper registers
  again within seconds. An agent whose last turn ran in the signed-in session
  waits at its first turn until 15 s after the engine's start for the helper
  (ruling D), so a restart is no move down and back up. When the wait runs
  out the engine logs once `the sign-in helper did not register again after
  the engine's start; agents start in Session 0`, and the agent moves down,
  told so.

## Decisions beyond the user's words

The coordinator ruled A (the "Run on sign-in" label), C (the helper's run
level), D (15 s, logged) and E (delete the old task at upgrade). These were
chosen in the implementation (rig-opus) and are flagged for the user on the
docket item:

- the settle wait runs at an agent's first turn, not during the engine's
  recovery, which runs before the engine serves the helper;
- the restart-notice line is added when the notice is delivered, from the
  turn's real placement;
- the session notices are plain system mail, not typed events;
- an engine not in Session 0 counts as the signed-in session;
- an agent's first turn ever is no move;
- a CLI holding background work moves at a later turn;
- the Claude keepalive CLI stays in Session 0.

## Verification

Measured on branch `rig-opus/session-upgrade` (base `64d862f`); logs in
`D:\orgtree-work\tmp\rig-opus\batch-session-upgrade\logs` and
`C:\orgtree-build\rig-opus\session-upgrade\logs`:

- **Installer** (`tests/boot-installer.test.ps1`, fake task folder, never a
  real task): 203 assertions pass; at the base script the new section fails
  at the helper's run level.
- **Engine:** `cargo check --all-targets` and clippy with no warning on a
  changed line; the `x86_64-linux-android` check (cfg(unix)) with only the 4
  known `core_monitor`/`core_startup` warnings; unit tests: the harness
  modules and `session_host` 33/33, the actor 9/9, the helper's 6/6 including
  `the_five_harness_clis_by_absolute_path_and_nothing_else`.
- **Desktop:** `tests/run-on-boot.test.mjs` 8/8 and `tests/startup-tray.test.mjs`
  15/15, in a set of 15 desktop test files whose 10 failures are the same at
  the base (pre-existing). Renderer `runonboot`, `desktopstate`, `onboarding`,
  `notificationsettings` and `runasadmin` 33/33. Typechecks: root 0 errors,
  renderer 29 and renderer tests 830, the same as at the base.

Not run by rig-opus: the rig proof `tools/rig/proofs/session-upgrade.mjs` (it
needs a rig home under the operator's profile and an interactive session for
the helper), the throwaway-task measurement in
`tests/disruptive/run-on-startup.test.mjs` (updated for two tasks; it
registers real per-user tasks), and any build, installation or real task.

## Only the user can confirm

- After a real boot and sign-in, Task Manager shows the engine in Session 0
  and the agents' CLIs, children of `orgtree-credential-broker.exe`, in the
  user's session; agents see the real desktop.
- At a real sign-out the hosted CLIs end, the engine keeps running, and the
  agents' next turns run in Session 0 with the downgrade notice; at the next
  sign-in they move back up, told so.
- The real permission prompt switches "Run on boot" both ways, and an upgrade
  from 4.3.x deletes the "Orgtree Sign-in Engine" task.

## Limits

- **Before the first sign-in after a reboot** everything runs in Session 0;
  Windows offers no interactive token before then.
- **A second Windows session** of the same user starts its own helper; the
  bridge's hold rule keeps the first.
- **Downgrade (inferred, not measured):** a 4.3.x installer reads no
  `StartupMode`, which it takes as boot, and registers its sign-in task
  disabled; its launcher is gone, so nothing starts from it.
