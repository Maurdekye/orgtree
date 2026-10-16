# Where the background engine starts (decision 79)

Orgtree 4.x starts its background engine at boot in Windows Session 0: the
"Orgtree Background Engine" task, boot trigger, S4U as the operator. Session 0
has no interactive desktop (no real cursor or input, a 1024x768 stand-in
display, none of the user's windows), Codex's sandbox cannot start there, and
the user's own sign-ins are not directly available. 3.x started the engine at
the user's sign-in, inside their own session. The user asked on 2026-10-15
(docket `option-to-run-the-background-engine-in-the-user-s`) for that as an
option. On an installation for all users on Windows, "Run on startup" now has
a second choice, "engine starts":

| Choice | What starts the engine | Where it runs | When |
| --- | --- | --- | --- |
| At boot, before sign-in (default) | "Orgtree Background Engine" task, boot trigger, S4U | Session 0 | from boot, across sign-out |
| At sign-in, in my session (opt-in) | "Orgtree Sign-in Engine" task, logon trigger, the operator's interactive token | the operator's own session | while they are signed in |

The default for new and existing installations is boot (user, 10:38Z).
Per-user installations, macOS and Linux have no such choice: their engine
already runs as the user, started at login or when Orgtree opens.

## Tasks and the installer's record

All three tasks belong to the installer (`tools/boot-engine-task.ps1`).
Administrators can change them; the operator can only read and run them. Each
task's description carries the installer record's id.

- **Boot task**, unchanged: `resources\engine\orgtree-engine.exe "host"`.
- **Sign-in engine task**: a logon trigger for the operator's SID only. The
  principal is the operator with an interactive token, at Normal priority
  (decision 46), with no time limit, IgnoreNew and restart on failure 1 min
  ×3. Marker `com.maurdekye.orgtree.signin-engine.v1:<id>`. The run level is
  least privilege, the token Explorer gives the user's own programs, or
  highest available while "Run Orgtree as administrator" is on. Its action is
  `resources\engine\orgtree-engine-host.exe`, with no arguments.
- **Credential helper**, unchanged; it now runs in both modes (below).

The protected record `HKLM\SOFTWARE\Orgtree\BootEngine` holds `RunOnStartup`
(DWORD, decision 70) and `StartupMode` (`signin`; absent or anything else means
boot). Which tasks are enabled:

| Run on startup | Boot task | Sign-in engine | Credential helper |
| --- | --- | --- | --- |
| off | disabled | disabled | disabled |
| on, at boot | enabled | disabled | enabled |
| on, at sign-in | disabled | enabled | enabled |

Tasks are disabled, never deleted (decision 70). Register re-creates all three
from the record, so an update keeps the mode, and starts only the active ones.
A sign-in Run made while the operator is not signed in waits for their next
sign-in and never fails the install. Prepare, Stop and Remove verify, disable
and stop the sign-in task together with the boot task. The engine is asked to
shut down first; only when it cannot be asked is the task ended. Each task's
enabled state is restored if the stop fails. Remove deletes all three. Sign-in
mode without the launcher binary is refused as an incomplete installation.

## The windowless launcher

`orgtree-engine.exe` is a console program. Run by an interactive-token task, it
would open a console window at every sign-in; decision 68 made the credential
broker a separate windowless binary for the same reason. So the sign-in task
runs `orgtree-engine-host.exe` (`src/engine_host.rs`, GUI subsystem, a few
dozen lines). The launcher:

- starts `orgtree-engine host` beside it with `CREATE_NO_WINDOW`, the same
  host the boot task runs (`src/host.rs`);
- waits for the host, so the task lasts exactly as long as the host and records
  the host's exit code (0 a requested stop, 75 another engine owns the data
  folder, 1 a failure);
- names itself to the host in `ORGTREE_HOST_LAUNCHER_PID`.

The host opens that process before doing anything else, so the id cannot pass
to another process. When the launcher is gone (the task was ended), the host
stops its engine the graceful way: the shutdown request with its own token, as
on a console stop. The engine does not inherit the variable. The host code
itself cannot be built into a second binary: `#[logged]` expands to
`crate::trace`, which needs the whole engine.

## Changing it

Settings › Desktop shows "engine starts" under "run on startup"
(`EngineStartSetting`, `desktop:engine-start` / `desktop:set-engine-start`):

- It is shown only where both engine tasks exist, and disabled, with the
  reason, while "run on startup" is off (coordinator rulings 10:57Z, items 5
  and 6). It is not in the tray.
- A change is one elevated script behind one Windows permission prompt
  (`runonstartup.ts` `elevatedStartupScript`). The script verifies all three
  tasks' markers before changing any, applies the table, and writes
  `RunOnStartup` and `StartupMode`. It never stops, starts or deletes a task.
- The choice flips only once the change reads back. A declined prompt says what
  still holds. It shares "run on startup"'s one-change-at-a-time guard, and
  turning "run on startup" off and on keeps the recorded mode.
- A running engine keeps running (decision 70). For an engine a task started,
  Settings then offers "Restart the background engine now" (ruling 4, the "Run
  Orgtree as administrator" pattern). The restart is a graceful stop with proof
  of exit, then whichever engine task is now enabled, then reattach. Otherwise
  the change applies at the next sign-in or boot.
- Crash recovery and both restarts start whichever engine task is enabled
  (`startEngineTask`); they used to start the boot task.
- "Run Orgtree as administrator" also re-registers the sign-in engine task with
  the matching run level. It changes only the installer's own task, and does
  so before writing its HKLM value, so a refusal leaves the setting as it was.

## One engine

The data root's lock (`launch::RootLock`, taken before anything else in
`serve`) decides, as it always has. At sign-in, the sign-in task and the
window's own sign-in entry ("run on startup") start together:

- When the task's engine holds the root, the desktop's own engine is refused,
  and the desktop adopts the task's engine through its existing "refused, then
  attach with retry" path. The sign-in task normally gets there first: logon
  tasks start before Explorer's startup programs (inferred, not measured).
- When the desktop's engine wins, it serves that session (also in the user's
  session) and the task's host leaves with 75.

IgnoreNew keeps a second sign-in (a second session of the same user) from
starting a second host, and a host that finds a live descriptor leaves at once.
Quit's logon-scoped barrier (`core_state::blocked`) applies unchanged.

## Credentials, Codex and the helper in the user's session

An engine in the user's session with an interactive logon gets no
credential-isolation warning (`credential_context::warning`: its session is not
0, and its logon type is not batch, service or network). So it injects no
credential adapters, and git and gh use the user's own helpers directly.
`codexrt::seat_sandbox` hosts Codex in the user's session only from Session 0,
so Codex starts directly with its own sandbox; Muse's sandbox stays on
(`musert::os_sandbox`). These decisions depend on the engine's real session,
not on the setting.

The helper still runs in sign-in mode (coordinator 11:13Z, replacing the
design's "helper disabled"). The engine a task's host started runs the "boot"
core lifecycle, which counts the helper as a member: `core_policy` reports "sign-in helper did not start
after sign-in", and a desktop transition completes only once the helper is
alive. Next to an engine in the user's session the helper only keeps its leases.

## Verification

Measured on branch `rig-opus/user-session-engine` (base `b77512f`), logs in
`C:\orgtree-build\rig-opus\user-session\logs`:

- **Installer harness** (`tests/boot-installer.test.ps1`, fake task folder,
  never a real task): 228 assertions pass. With the unchanged script the new
  section fails at its first call. Covered: the sign-in task's XML in both run
  levels, Register in both modes, off disables all three, an update keeps the
  mode, stop graceful-first / end the task / restore on failure, a changed or
  unowned task refused before any change, the missing launcher, Remove.
- **Engine:** `cargo check --all-targets` 0 warnings; clippy 106 warnings, none
  on changed lines; launcher unit tests 2/2; `x86_64-linux-android` check exit
  0 with the 4 known `core_monitor`/`core_startup` warnings.
- **Desktop:** `tests/engine-start-mode.test.mjs` 9/9, `startup-tray` 14/14,
  `run-as-administrator` 9 + 1 skipped (it needs an elevated process), and
  `disruptive-policy` 6/6. Every script parses in Windows PowerShell 5.1. At
  `b77512f` the 9 new tests and the new tray test fail and the 13 old tray
  tests pass.
- **Renderer:** `enginestart.test.tsx` 5/5, with `runasadmin`, `desktopstate` and
  `notificationsettings` 27/27. With the `b77512f` settings panel the new test
  cannot bundle (no `EngineStartSetting`).
- **Typechecks:** root 0 errors; renderer 29 and renderer tests 830, both the
  same files as at `b77512f`.
- **Pre-existing:** `tests/core-recovery-review.test.mjs` fails 6 of 12 at
  `b77512f` exactly as on this branch. Its restart slice runs TypeScript
  through `vm` untransformed.

Not run here: the rig proof `tools/rig/proofs/engine-start-signin.mjs` (launcher
→ host, one engine, ending the task; rig-sol-b runs it), the throwaway-task
measurement in `tests/disruptive/run-on-startup.test.mjs` (updated for three
tasks and the mode; it registers per-user tasks, so it needs authorization),
and any build, installation or real task.

## Only the user can confirm

- At a real sign-in with "At sign-in, in my session", the engine starts with no
  console window. Task Manager shows `orgtree-engine-host.exe`,
  `orgtree-engine.exe` and the agents in the user's session, not Session 0.
- Agents there see the real desktop: cursor, screen size, windows. Codex runs
  sandboxed without the helper hosting it, and git or gh use the user's own
  sign-ins.
- The real permission prompt switches both ways, and "Restart the background
  engine now" moves the engine at once.
- Signing out stops the engine (below), and the next sign-in starts it again.
  A reboot starts nothing until sign-in.

## Limits

- **Sign-out:** at sign-out Windows ends the session's processes. A sign-in
  engine stops then the way today's desktop-started engine does, and
  PostgreSQL recovers at its next start.
- **Ending the boot task:** since the 2026-10-12 recovery change, ending the
  boot task no longer stops the boot engine; the core lifecycle keeps it alive
  when its host exits. The installer's fallback now asks through its record
  first (decision 80), but a manual End on the boot task still leaves the
  engine running. The sign-in engine stops on End: its host asks the engine to
  stop when the launcher is ended.
- **Downgrade (inferred, not measured):** an older installer does not know the
  sign-in task. It stays registered, enabled in sign-in mode, and fails
  harmlessly at sign-in because its launcher binary is gone. The older
  version's boot task follows "Run on startup" again.
