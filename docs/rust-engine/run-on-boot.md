# Run on boot, and agents in the signed-in session (decisions 84 and 93)

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
CLIs run in their session, started there by the sign-in helper. Since
decision 93 (2026-10-21) the engine itself moves into the operator's session
when it restarts or updates while they are signed in: see
[restarts and updates while signed in](#restarts-and-updates-while-signed-in-decision-93).

## The switch

One checkbox, **Run on boot** (09:38Z; it was "Run on startup", and it is
still stored as `startAtLogin`), in App settings › Runtime › Desktop, in
first-run setup and in the tray. The tray item mirrors the setting.

- **On** (the default): the boot task starts the engine at boot, and the
  "Orgtree Credential Helper" task starts the helper at the operator's
  sign-in; while **Run as admin** is on too, the "Orgtree User Session
  Engine" task moves the engine into their session at sign-in (decision 93).
  The window's own sign-in entry follows the switch as before.
- **Off:** every boot and logon trigger of every owned task is disabled.
  The tasks stay installed and enabled, so a restart or recovery can still
  start them on demand, and nothing of Orgtree starts by itself (decision 70;
  coordinator 2026-10-21 15:38Z, replacing "both tasks are disabled").
- **Where Orgtree cannot start at boot** (a per-user installation, macOS,
  Linux) the same switch reads **Run on sign-in** and starts Orgtree at
  sign-in as before (coordinator ruling A). The desktop names it from the
  tasks it reads (`desktop:startup-kind`): an installation without the boot
  task is "sign-in".
- A change on an all-users Windows installation is one elevated script behind
  one Windows permission prompt (`runonstartup.ts` `elevatedStartupScript`).
  It verifies every owned task's marker before changing any, switches their
  triggers (the user-session task's only while Run as admin is on), and
  writes `RunOnStartup` to the installer's record. It never stops, starts or
  deletes a task: a running engine keeps running. The switch flips only once
  the change reads back; a declined prompt says what still holds ("so Orgtree
  still runs on boot"). One change at a time, from the tray or Settings.
- Crash recovery and "Restart the background engine now" start the engine
  through the user-session task while the operator is at the console, and
  through the boot task otherwise (decision 93).
- **Run as admin** (it was "Run Orgtree as administrator"; still stored as
  `RunAsAdministrator`) re-registers all three tasks with the matching run
  level, highest available or least privilege, in one permission prompt,
  before it writes its own value: the boot engine (still S4U), the helper
  (ruling C) and the user-session engine. A task's run level is what the
  engine or the agents' CLIs it starts get. Switching it on first warns that
  every agent then runs with full administrator rights on this PC, with no
  further prompts (the user, 2026-10-21 15:27Z).

## Tasks and the installer's record

The three tasks belong to the installer (`tools/boot-engine-task.ps1`).
Administrators can change them; the operator can only read and run them. Each
task's description carries the installer record's id. The third, "Orgtree
User Session Engine", is described under
[restarts and updates while signed in](#restarts-and-updates-while-signed-in-decision-93).

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

After a cold boot the engine runs in Session 0 until it restarts while the
operator is signed in (decision 93). When an agent's turn starts, its CLI
starts where it should run (`runtime/session_host.rs` `wanted`):

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
hosted CLI ends while the helper that started it is gone (checked for up to
2 s; that helper's own lease, by session, helper pid and process creation
stamp, so another of the user's sessions that stays hosted does not hide
it: rig-sol-b's finding, 2026-10-16) stops cleanly as `the user's Windows
session ended`: no failure report and no error left on the agent, a
`session` row in its conversation ("a new turn continues it"), its claimed
mail requeued when the CLI had done nothing yet (the usual rule), and a
waking message: "The user's Windows session ended while you were working,
so your turn stopped. Continue where you left off." That message starts one
new turn at once, placed by the turn-start rule (Session 0, or another of
the user's sessions whose helper still runs), the way a turn cut off by
an engine restart resumes (the user, 2026-10-16 11:03Z, decision 85): nothing
else has to wake the agent. A turn that had been interrupted, halted, timed
out or retired is not resumed (`may_be_session_end`). Windows ended the
CLI, not the engine: the engine log says `the user's Windows session ended
during the turn; a new turn continues it` with the pid, and the kill record
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
- **The RESTART NOTICE** says where the engine itself started:
  `Engine session at start: Session 0.`, `Engine session at start: Windows
  session <n>.` or `...: unknown or not applicable.` (decision 93). It
  replaced the line `Session access at start: ...`, which named where the
  agent's first CLI ran and so could say "signed-in session" for an engine
  in Session 0 (the user's report, 2026-10-21). Where a turn runs is
  `orgtree_session`'s answer and the session notices'.
- **Restarts while signed in:** after an engine start the helper registers
  again within seconds. An agent whose last turn ran in the signed-in session
  waits at its first turn until 60 s after the engine's start for the helper
  (2026-10-20 startup-transient fix, replacing ruling D's 15 s). An explicit
  Session 0 preference or next-turn choice skips the wait. The first observed
  hosting closes startup grace for all agents; a subsequent real loss follows
  normal debounce, even for an agent that has not yet run since restart.
  A reconnect within the grace is no move down and back up. When the wait runs
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

## Sign-in and sign-out notices

The user, 2026-10-16 12:07Z (`runtime/session_watch.rs`): an engine in
Session 0 watches whether any sign-in helper hosts. Since the user's
2026-10-17 transient-loss fix, sign-out requires three consecutive two-second
misses and recovery takes the first good check. Overdue ticks are skipped;
short recovered losses log once and retain turn placement without extending
authenticated leases. See [session blips](session-placement-blips.md).
A confirmed change from what agents were last told (kept in
`<data>\session-placement.json`, baseline Session 0, so a restart while
the user stays signed in tells nobody anything), sends every live agent one
passive line. Readings and helper keepalive start immediately, but startup
absence cannot count as sign-out until the 60 s grace expires. The first
observed helper closes that grace early, so real later loss still needs only
the ordinary three checks. The notices are `[ORGTREE SIGN-IN
NOTICE]` or `[ORGTREE SIGN-OUT NOTICE]`. The sign-in line says where the
agent's next turn runs as its own runtime would start that turn (asked
for its `orgtree_session` view, 5 s at most, every agent at once): in the
signed-in session; or in Session 0, because its CLI still runs background
work, because it picked Session 0 for that turn (`use`), or by its
preference. An agent whose runtime does not run gets the line its stored
preference gives (rig-sol-b's finding, 2026-10-16). `mail::send` wakes an agent whose
actor runs, so a running turn takes the line at its next tool boundary
(Claude's hook, Codex's and Muse's steer, Antigravity's hook); an idle
agent reads it at its next turn. The move notices stay as they were.
The same change fires the machine-wide watchdog events `session.signed_in`
and `session.signed_out`, and at sign-in every working agent that sits
idle with its last turn in Session 0 gets its checkup at once, docket
work or not, or the docket reminder instead if one is due at that moment
(`reminders::checkups_at_sign_in`; its stamp restarts its 20 minutes, so
no extra checkup over time; 2c).

## The helper keepalive

While the user is signed in (`core_state::sessions`) and no helper
connects, the engine starts the helper's own logon task with
`%SystemRoot%\System32\schtasks.exe /Run /TN "\Orgtree Credential
Helper"` after 30 s, then after 2, 5 and 10 minutes, then every 10
minutes, logging each result (2d). A disabled task (Run on boot off)
refuses. Measured 2026-10-16, read-only: the installed task's ACL gives
the engine's user RX, which allows an on-demand run (inferred, not
executed). A rig engine never starts the machine's own task, only a
proof's task named in `<data>\rig-helper-task.txt`.

## Ending your own turn: `orgtree_interrupt`

The user, 2026-10-16 12:05Z: an agent may point `orgtree_interrupt` at
itself, with no tool group. The turn ends as a deliberate interrupt (so a
sign-out at the same moment adds no resume); with `restart: true`,
`end_turn`, which takes a turn once, wakes exactly one new turn at once,
placed by the turn-start rule. It is refused while the CLI holds
background work or no turn runs; another agent still needs the runtime
group, and `restart` is for one's own turn only. Both ends are logged.

## Choosing among the user's sessions

The user, 2026-10-16 12:12Z and 12:13Z (only the engine user's own
sessions): the bridge holds one host lease per Windows session
(`credential_bridge::HostLeases`), side by side; the first helper is the
core's helper member. `session_host::choose` takes the agent's on-demand
pick while its session hosts (`orgtree_session` `use`, next turn only; 0
is Session 0), then its preference (scope `session`: absent =
`signed-in`, any session; `console`, `remote`, `session0`, or an ordered
list), an active session before a disconnected one and the lowest id
first, then Session 0. Kinds come from Windows (`WTSClientProtocolType`:
RDP is `remote`). Agent settings › Access › "Desktop session" shows and
saves the preference; undo restores it. `orgtree_session` lists Session 0
and each hosting session (id, kind, state, user). A debug rig engine lets a
proof's helper name a synthetic session (`rig_session`, from
`ORGTREE_RIG_HELPER_SESSION` in a debug helper) described in
`<data>\rig-sessions.json`. A helper runs once per Windows session and
data root (the mutex `Local\OrgtreeCredentialBroker-<root key>`: a second
start leaves at once, silently); a synthetic-session helper takes its own
(`...-rig<N>`), so it runs beside the real session's helper. A release
helper never reads the variable. Windows 11 Pro gives a user one interactive
session, so two real sessions occur only on Server or multi-session
editions: proven here with synthetic helpers only.

## Restarts and updates while signed in (decision 93)

The user, 2026-10-21 15:03Z (docket
`after-an-update-or-engine-restart-while-the-user`): an update or engine
restart while they were signed in brought the engine back in Session 0,
because every restart ran the S4U boot task. Now, while a console user is
signed in, an update, a restart or crash recovery starts the engine (and the
mail hub it hosts) in their session. A cold boot with nobody signed in keeps
the boot task.

**The route** (`sessionlaunch.ts` `route`): `session` when the user-session
task is installed and the desktop runs in the console session; `boot` when
the boot task is installed and Run on boot is on; otherwise the desktop's own
engine (`managed`). For `session` the desktop writes the ask
`<data>\session-launch-request.json` (`{by, restart, atMs}`, fixed words
only) and runs the task. A restart then waits for its own attempt's record
to read `ready` or `failed`.

**The "Orgtree User Session Engine" task** (`New-InteractiveTaskXml`) runs
as the operator's SID with their interactive token. Its one action is the
installed broker, `orgtree-credential-broker.exe session-engine`, which
starts `orgtree-engine.exe session-launch signin` beside it without a console
window and returns its exit code. Instances run in parallel (the new start
runs beside the host it replaces), and there is no RestartOnFailure, so a
failed handover never loops in the Task Scheduler. Its run level follows Run
as admin, so the engine and every agent it starts are elevated exactly when
Run as admin is on. Its logon trigger is on only while Run on boot and Run
as admin are both on (coordinator Q1, 16:27Z): then signing in moves the
engine into the session. With Run as admin off, decision 84 stands until the
next restart.

**The handover** (`session_launch.rs` `launch`), one attempt at a time
across sessions:

1. The launcher takes an ask once, only while fresh (120 s; `by` is
   `desktop` or `boot-host`), and only in the console session.
2. It takes the cross-session lock `<data>\core-handover.lock` (an exclusive
   open; it waits up to 200 s) and writes the durable record
   `<data>\core-handover.json`. The record holds an id, who asked, the phase
   (`begun`, `stopping`, `starting`, `ready` or `failed`), the session,
   whether the engine is elevated, whether the old engine was stopped, the
   sign-in the record belongs to (`epoch`), a fixed failure reason and the
   rollback (`done` or `failed`).
3. It asks the running engine for admission (`POST
   /api/desktop/session-handover`, Begin). Admission is given only to a
   native peer (a live process of the engine's own executable, matched by
   its creation stamp and run by the same user), only for the engine's
   current generation, and never while another live owner holds a
   transition. A transition whose owner has ended (a launcher that failed
   after its stop) goes to the next launcher.
4. It stops the old engine gracefully (`POST /api/desktop/shutdown`, up to
   150 s) and waits up to 30 s for the data root to be released.
5. It runs the engine host in this session (`host::run_in_session`). Once
   the new engine serves, it sends Complete and records `ready`.

A failure before the stop (not at the console, no admission, the task
refused) leaves the old engine untouched. A replacement that fails after the
stop gets exactly one rollback: the launcher runs the boot task once, and the
record says rollback `done`, or `failed` when that engine does not start
either.

**Run this session as admin** (`sessionlaunch.ts` `runSessionAsAdmin`)
shows one Windows permission prompt per click. The prompt starts
`orgtree-engine.exe session-launch prepare <request>` elevated. The request
names only the data root and the UI folder, which the launcher checks (the
root must be the installation's own; the UI folder must hold `index.html`),
and the launcher then makes the same handover elevated. The button never
changes Run as admin, and a declined prompt leaves the engine untouched. It
is disabled while Run as admin is on and when nobody is at the console.

**The boot host** (`boot_supervisor.rs`, the boot task's `orgtree-engine
host`) now supervises instead of always starting an engine. Every 2 s a pure
`decide` step chooses from what it sees:

- Nobody signed in at the console, or no user-session task: it runs the
  engine in Session 0 as before.
- The operator at the console: it never starts a Session 0 engine itself.
  While another engine holds the data root or an attempt runs, it waits.
- The engine lost while the operator stays signed in: the desktop recovers
  it. After 120 s with no engine, the boot host claims the one recovery and
  runs the user-session task once. The claim is the same durable claim the
  desktop's recovery takes, so the two never both act. If that fails, it
  starts the Session 0 engine, which counts as the one rollback (coordinator
  Q3).
- Sign-out: after three empty readings 2 s apart, as for the sign-out
  notices, it starts the engine in Session 0 again, and never before.
- After a failed rollback it stays out for that sign-in (`epoch`), until the
  user's Start engine.
- One boot host runs per data root (`<data>\boot-host.lock`), and the
  installer's stop request ends it.

The installer runs the boot task last at every Register (install, upgrade
and repair). So after an update the boot host is running, and with the
operator at the console it hands the engine to their session.

**What the user and agents see.** The desktop says so once per attempt,
with the reason from the record: a warning when the engine came back in
Session 0, and an error ("Orgtree's engine is stopped.") when the rollback
failed too. A failed restart also reports its own error. The tray's Restart
engine reads **Start engine** while the engine is stopped or unavailable.
After a
rollback, the restart notice gets one more line: "Orgtree could not start the
engine in the signed-in session (<why>), so it started the engine in Session
0 instead." or "..., and it did not start in Session 0 either, so it stayed
stopped until it was started again." That line is reported once (`reported`
in the record).

**Rig seams** apply only in debug builds on a rig root
(`core_state::rig_root`):

- `<data>\rig-user-session-task.json` and `<data>\rig-boot-task.json` name
  what a task run starts;
- `<data>\core-rig-signed-out` stands for the sign-out;
- `ORGTREE_RIG_SESSION0=1` makes an engine report Session 0;
- `ORGTREE_RIG_FAKE_ELEVATED=1` stands for the elevated launcher;
- `ORGTREE_RIG_STOP_KEY` (HKCU) carries the installer's stop request.

A release build reads none of them. The proof is `tools/rig/proofs/session0-handover.mjs`.

**Verification**, measured on branch `rig-opus/session0-restart` over
`rust-engine` `de59b1f`. Logs are in
`D:\orgtree-work\tmp\rig-opus\batch-session0\logs`.

- **Engine:**
  - `cargo check --all-targets`: only the base's `domain/tree.rs` warning.
  - Clippy: no warning on a changed line.
  - `x86_64-linux-android` check: only the 4 known `core_monitor`/`core_startup` warnings and the base's.
  - Focused tests, 72/72: `session_handover`, `core_monitor`, `boot_supervisor`, `session_launch`, `restart_session`, `core_recovery`, `core_state`, `core_process`, `install_stop`, `host::`, `runtime_notices` and `http::desktop`.
  - The broker's tests: 12/12.
  - Reds: the engine red ran 28 pass / 11 fail, and the admission red (a dead launcher's transition) 15 / 1.
- **Installer** (fake task folder; no real task):
  - Task definitions: 84/84; red, 11 failures.
  - `tests/boot-installer.test.ps1`: 278 assertions.
- **Desktop:**
  - Root typecheck: 0 errors, as at the base.
  - Node tests: 66/66. Against the base desktop, 20 failures: 17 intended, and 3 known failures of the exported copy ("Python engine exited before readiness").
  - Renderer settings suites: 32/32. The restored restart row's red ran 6 / 1.
  - Renderer typecheck: 42 errors, the same 42 as at the base.
- **Rig proof** (`session0-handover.mjs`, a `recover` run in two parts):
  - Part 1 (A B C D F G): 23/23.
  - Part 2 (A B E H, with the real 120 s backstop): 10/10.

**Only the user can confirm** a real task run, the real permission prompt, a
real sign-in and sign-out, and a real update. The task definitions are
checked as XML against a fake task folder. The rig's Session 0 is a stand-in:
every proof process runs in the proof's own console session. Two things are
unmeasured: the native-peer check across integrity levels (an elevated engine
asked by an unelevated launcher), which falls back to the image and the
process creation stamp, and whether a console window ever shows.

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

The `orgtree_session` follow-up (decision 85), measured on branch
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
