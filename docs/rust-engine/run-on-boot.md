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
you were working, so your turn stopped. Continue where you left off." That
message starts one new turn at once, in Session 0, the way a turn cut off by
an engine restart resumes (the user, 2026-10-16 11:03Z, decision 84): nothing
else has to wake the agent. A turn that had been interrupted, halted, timed
out or retired is not resumed (`continues_in_session0`). Windows ended the
CLI, not the engine: the engine log says `the user's Windows session ended
during the turn; it continues in Session 0` with the pid, and the kill record
(`diagnostics\logs\codex-kills.log`) gets one `codex-session-ended pid=...
who="<agent>" reason="the user's Windows session ended" status="..."` line.

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
- **The session notices end** "orgtree_session tells you where you run at any
  time."

## Asking where you run: `orgtree_session`

The user, 2026-10-16 11:01Z: "allow agents to query the current machine
state: whether its logged in, and whether their current turn is running on
session 0 or the logged in session (and whether or not their next turn will
change)" (docket `let-agents-query-machine-sign-in-state-and-which`, decision
84). `orgtree_session` takes no arguments and needs no tool group, like
`orgtree_status`, so every agent has it on every harness
(`tools/session.rs`). It answers:

| Field | From |
|---|---|
| `signed_in` | `core_state::sessions`, the core monitor's reading of the engine user's Windows sessions (console, remote or disconnected), so a debug rig engine's stand-in `<data>\core-rig-signed-out` applies; `null` when Windows cannot say, or not Windows |
| `this_turn` | the caller's actor (`AgentMsg::Session`, `session_view`): where its CLI runs (`signed-in` when hosted, or when the engine is not in Session 0; else `session0`); `null` with no CLI |
| `next_turn` | the same actor, by the rule a turn's start applies: `session_host::wanted`, except that a CLI other than Codex that holds background work stays where it is |
| `next_turn_moves` | `this_turn` and `next_turn` differ |
| `sign_in_helper` | `credential_bridge.can_host()` |
| `summary` | the above in sentences, including why a turn stays (background work) or cannot move (no helper) |

Asking the actor from a tool cannot deadlock: Claude's control requests and
Codex's tool calls are answered in spawned tasks, and the other harnesses
reach the tools through the engine's `mcp-bridge` pipe. A change to the
placement rule (`want_hosted`, `codex_seat`) must change `session_view` with
it. The tool card is new in every agent's tool list, so each agent's prompt
cache misses once, at its first turn after the upgrade.

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

The `orgtree_session` follow-up (decision 84), measured on branch
`rig-opus/session-query` (base `4ade769`), same logs folder, `sq-*`:

- **Red** at the test commit: `domain::tool_groups` and
  `runtime::actor::session_end_tests` 3 pass, 2 fail (the tool is not served;
  a deliberate end would resume).
- **Green** at the tip: those plus `runtime::actor`, `tools::`,
  `domain::runtime_notices`, `codex_kills` and `runtime::session_host`, 30/30;
  `cargo check --all-targets` with no warning; clippy with no warning on a
  changed line; the `x86_64-linux-android` check with the same 4 known
  warnings; `tests/skills-tree-coverage.test.mjs` with only its known
  failure (two canvas background labels, the same at the base); the source
  audits as at the base.

Not run by rig-opus: the rig proofs `tools/rig/proofs/session-upgrade.mjs` and
`session-query.mjs` (they need a rig home under the operator's profile and an
interactive session for the helper; rig-sol-b runs them in review), the throwaway-task measurement in
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
