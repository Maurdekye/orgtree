# Run on boot, and agents in the signed-in session (decisions 84 and 94)

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
CLIs run in their session, started there by the sign-in helper. Decision 93
(2026-10-21) moved the engine itself into the operator's session when it
restarted or updated while they were signed in; decision 94 (2026-10-22)
reverts that: the engine always runs in Session 0, and the sign-in helper
hosts the agents in each signed-in session. See
[the engine stays in Session 0](#the-engine-stays-in-session-0-decision-94).

## The switch

One checkbox, **Run on boot** (09:38Z; it was "Run on startup", and it is
still stored as `startAtLogin`), in App settings › Runtime › Desktop, in
first-run setup and in the tray. The tray item mirrors the setting.

- **On** (the default): the boot task starts the engine at boot, and the
  "Orgtree Credential Helper" task starts the helper at the operator's
  sign-in. The window's own sign-in entry follows the switch as before.
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
  triggers, and writes `RunOnStartup` to the installer's record. It never stops, starts or
  deletes a task: a running engine keeps running. The switch flips only once
  the change reads back; a declined prompt says what still holds ("so Orgtree
  still runs on boot"). One change at a time, from the tray or Settings.
- Crash recovery and "Restart the background engine now" start the engine
  through the boot task, in Session 0, also with Run on boot off (decision
  94, coordinator Q4).
- **Run as admin** (it was "Run Orgtree as administrator"; still stored as
  `RunAsAdministrator`) re-registers both owned tasks with the matching run
  level, highest available or least privilege, in one permission prompt,
  before it writes its own value: the boot engine (still S4U) and the helper
  (ruling C). The helper task's run level is what the helper and the agents'
  CLIs it starts get. The boot task's S4U logon gets the account's full token
  at either level (measured 2026-09-30 and again 2026-10-22), so its host
  decides: it starts the engine with that token only when Run as admin is on,
  and otherwise with a restricted copy Windows reads as not elevated
  (decision 94, 7 and 8). Switching it on first warns that every agent then runs with
  full administrator rights on this PC, with no further prompts (the user,
  2026-10-21 15:27Z). The change applies at once: the desktop restarts the
  engine, and a helper with the old rights is replaced (decision 94,
  coordinator Q1). The one-off "Run this session as admin" button is
  retired for 4.4.0 (the user's Q2).
- **A failed change says why.** The elevated PowerShell runs hidden, so its
  own output never reaches the desktop, which gets only the exit code. Each
  change has a fresh nonce (`runasadmin.ts` `failureReport`). After its
  rollback, a failed script leaves the nonce and its message (and any task
  the rollback could not restore) in `LastChangeFailure` under the protected
  `HKLM\SOFTWARE\Orgtree\Runtime`, which SYSTEM and Administrators write and
  users only read; a change that succeeds deletes it. Once the elevated
  PowerShell has failed, the non-elevated launcher reads the value and
  passes back only a message under its own nonce (base64 UTF-8, so localized
  Windows text survives). The desktop then says `Changing the setting
  failed: <message>.` or `Changing "run on boot" failed: <message>.`, and
  the exit code only when there is no message. Never a temp file: an
  elevated write to a path the user, and so every agent, can write could be
  redirected by a link planted there.

## Tasks and the installer's record

The two tasks belong to the installer (`tools/boot-engine-task.ps1`).
Administrators can change them; the operator can only read and run them. Each
task's description carries the installer record's id. The "Orgtree User
Session Engine" task of 4.4.0 alphas 27 to 32 (decision 93) is stopped and
deleted at the next update, only when it is the installer's own, and never
registered again; uninstall deletes a leftover (decision 94).

- The protected record `HKLM\SOFTWARE\Orgtree\BootEngine` holds `RunOnStartup`
  (DWORD, decision 70). `StartupMode` (decision 79) is deleted from it at the
  next Prepare.
- **Operator by SID.** Each task's principal is the record's `OperatorSid`.
  The elevated scripts of Run on boot and Run as admin resolve a task's
  operator to a SID before they compare (`runasadmin.ts`
  `OPERATOR_FUNCTIONS`): the XML `UserId` first, which holds what the
  installer registered and is what its own ownership check reads, else the
  COM `Principal.UserId`, a SID or a name that Windows translates. Task
  Scheduler's COM principal gives the account NAME for a task registered by
  SID (both owned tasks on alpha.34, measured read-only on the user's PC,
  2026-10-22 13:10Z), so the raw comparison up to alpha.34 refused the
  installer's own tasks: Run as admin could not be turned on ("Changing the
  setting failed (exit code 1)."), and Run on boot's script compared the
  same way. A principal that resolves to another account or to nothing
  refuses before any change, and so does a record without an operator.
- **Upgrade from 4.3.x** (ruling E): Register deletes the obsolete "Orgtree
  Sign-in Engine" task after stopping it, only when it is the installer's own
  (marker `com.maurdekye.orgtree.signin-engine.v1:<id>` and the expected
  principal and action), and never registers it again. Both earlier choices,
  boot and sign-in, become "Run on boot" on; off stays off. Uninstall deletes
  a leftover one too. `orgtree-engine-host.exe`, the sign-in task's windowless
  launcher, is no longer shipped.
- Toggling "Run on boot" still disables rather than deletes (decision 70).

## Where agents run

The engine runs in Session 0, also after a restart, an update or a recovery
(decision 94). When an agent's turn starts, its CLI starts where it should
run (`runtime/session_host.rs` `wanted`):

- **In the operator's signed-in session** while the sign-in helper holds the
  bridge's host role (`Bridge::can_host`: a live 20 s lease, the helper's
  process alive), through the helper (decision 68, phase 2, now for every
  harness): Claude, Codex, Muse, Antigravity and OpenCode. bypassPermissions
  seats are hosted too (the user 09:43Z: "Yes, all agents"; the one-line switch
  `session_host::HOST_BYPASS_SEATS`), superseding decision 68's Q1.
- **In Session 0**, started by the engine, while no helper hosts, and when a
  hosted start fails (the engine logs `the sign-in helper could not start the
  CLI; starting it in Session 0`).
- An engine that is not in Session 0 runs every CLI in its own signed-in
  session; nothing is hosted. That covers a per-user installation and a
  desktop-started engine. From there `orgtree_session`
  refuses a `use` of Session 0 or another session. A stored preference that
  would pick another place is kept and reported as not followed
  (`preference_followed: false`; coordinator 2026-10-21 23:13Z).

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
  `orgtree_session`'s answer and the session notices'. An engine in Session 0
  on Windows adds a line with the Run as admin setting and the administrator
  rights measured for the engine and its sign-in helper (decision 94,
  invariant 7; the wordings are under "Administrator rights are measured as
  Windows reads them" below).
- **Restarts while signed in:** after an engine start the helper registers
  again within seconds. Every turn start waits for it while the user is
  signed in and no helper hosts, until 60 s after the engine's start or
  after a helper last hosted (decision 94, invariants 3 and 5; the 60 s are
  the 2026-10-20 startup-transient fix, replacing ruling D's 15 s), whatever
  the agent's last turn did. Signed out, or with the agent's own Session 0
  preference or next-turn choice, it starts at once. A reconnect within the
  grace is no move down and back up. When the wait runs out the engine logs,
  once per stretch without a helper, `the sign-in helper did not connect in
  time while the user is signed in; turns start in Session 0 until it does`,
  and the agent moves down, told so.
- **Warm CLIs** (docket `after-an-engine-restart-codex-clis-and-their-mcp`;
  invariants 3 and 5): warming (App settings' "keep agent processes warm")
  starts a CLI where the agent's next turn would run, and waits for the
  helper exactly as a turn start does (`Actor::warm`, `session_settle`).
  Before that, the warming that follows every engine start went straight to
  Session 0: on alpha.35 (2026-10-22 14:03:56Z) it started 7 Codex and 5
  Claude CLIs there in the 7.6 s before the helper came back. It keeps the
  next turn's `use` pick for that turn. When a helper starts hosting, the
  engine's own start included, every idle CLI parked in Session 0 closes
  (Codex by its graceful exit) and is warmed again in the signed-in session,
  3 at a time and only while warming is on and commit memory allows
  (`runtime::rehost_all`; the user, 2026-10-22 14:21Z: "Move them at
  sign-in"). Left alone: a CLI in a turn (it moves at its next turn), one
  holding background work, and one whose agent's own choice is Session 0
  (its preference, the next turn's `use` 0, or a preference no hosted
  session matches). With warming off, a parked CLI closes on its own.
- **A CLI is reused for a turn only where that turn runs it**, for every
  harness: its reuse check compares the placement as well as the prompt.
  Codex's compared the prompt only, on the reasoning that a move changes the
  sandbox and so the prompt. A full-access seat's sandbox is
  danger-full-access in both sessions, so on alpha.34 rig-sol-b's Codex,
  warmed in Session 0 at 12:49:33Z, ran its 13:24:15Z turn there while the
  helper hosted, and the agent was told it moved to Session 0.
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
| `signed_in` | `core_state::sessions`, the core monitor's reading of the engine user's Windows sessions (console, remote or disconnected), so a debug rig engine's stand-in `<data>\core-rig-signed-out` applies; `null` when Windows cannot say, or not Windows. A session Windows lists as being torn down (WTSDown, WTSReset) is nobody's. On alpha.34 (2026-10-22 12:57:07Z) every reading was `null` for the 77 s a sign-out took, so the sign-out notice said the user was still signed in; most likely the departing session's queries failed (inferred: the failing call was not logged then). Any other failed query keeps the reading `null` (fail closed); the first failing call of a stretch is logged with its session and Windows error, as is the reading that ends it |
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
passive line. Readings and helper keepalive start immediately. A helper
that comes or goes within the 60 s startup grace is part of the engine's own
start: agents count as told without a notice, since the restart notice
covers it (decision 94, invariant 6 as refined by the user 2026-10-22
07:34:52Z). The first observed helper closes that grace early, so real later
loss still needs only the ordinary three checks. The notices are `[ORGTREE
SIGN-IN NOTICE]` or `[ORGTREE SIGN-OUT NOTICE]`; the sign-out one says
whether the user signed out or only the helper stopped while they are still
signed in (then the next turn waits up to 60 s for it). The sign-in line says where the
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
executed). A helper the engine refused for other administrator rights
leaves, and once it is gone the engine starts the task at once, without the
30 s wait (decision 94, invariant 7). A rig engine never starts the
machine's own task, only a proof's task named in
`<data>\rig-helper-task.txt`.

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

## The engine stays in Session 0 (decision 94)

The user, 2026-10-22 07:27Z-07:38Z (docket
`4-4-0-restarts-and-updates-go-back-into-session-0`), replacing decision
93's restart target: "the main engine should always run in session 0,
through restarts, updates, reboots, etc. the helper engine runs on sign-in
in session 1 / whatever, as long as the user is signed in" (07:28Z). The
sign-in helper is the per-session host while the user is signed in.

**The strict invariants** (the user, 07:30:14Z: "record all that as the
strict invariants of this feature"; any violation is a bug):

1. The main engine ALWAYS runs in Session 0: through restarts, updates, reboots and crash recovery. It never runs in the user's session.
2. The session-1 host (sign-in helper) runs in the user's session(s) while the user is signed in.
3. At each turn start, agents run in the signed-in session whenever it is reachable. They fall back to Session 0 only when it isn't: the user is signed out, or the helper is truly unreachable after the bounded grace, which is logged.
4. At sign-out, running turns are cut off and resume in Session 0.
5. After a restart or update, both sessions are available immediately. No agent starts a turn in Session 0 when it could start in session 1.
6. Agents are notified whenever the session-1 host goes up or down while the Session 0 engine keeps running: one notice per debounced transition, none on the engine's own restart.
7. Elevation is all-or-nothing: the Session 0 engine and the session-1 host are both elevated or neither, with no in-between state.
8. Elevation costs exactly one UAC prompt when the setting changes. There are no repeat prompts on restart, update, reboot, sign-in or helper restart. The one-off "Run this session as admin" button: one prompt per click, elevating both together until the next normal restart.

Recorded with them:

- 9 (07:32:22Z): "Agents running in Session 0 have working GitHub credentials (git and gh) through the Session 0 host's credential bridge." This holds whether or not the user is signed in, and after every restart and update. Credentials are never serialized into logs, transcripts or prompts. Where Windows has no credential access, the bridge refuses with a clear error rather than hang.
- 6, refined (07:34:52Z): "agents should *only* be told when the session 1 host goes up or down if the session 0 host also does not go up or down at the same time". When the engine also restarts, stops or starts around that time (a restart, an update, a reboot, a recovery), only the restart notice is sent.
- 10 (07:35:09Z): agents whose turns run in Session 0 show a "Session 0" card on their desk header and zoom card. It is shown while the current or most recent turn placement is Session 0, says why in its tooltip (signed out, helper unreachable, or the agent's own preference), and comes from the engine's real placement.
- Q2 (07:38:29Z): the one-off "Run this session as admin" button is retired for 4.4.0, so the last sentence of 8 has nothing to apply to. Elevation comes only from the Run as admin setting.

**How each holds:**

- **1.** Every restart, update and recovery starts the engine through the
  boot task ("Orgtree Background Engine", S4U, Session 0). The desktop's
  restart (`sessionlaunch.ts` `launchBackground`, route `boot` whenever the
  boot task is installed, also with Run on boot off: coordinator Q4) stops
  the engine gracefully, runs the boot task and attaches again. Crash
  recovery does the same, and the installer runs the boot task last. The
  boot host (`orgtree-engine host`) is the one from before decision 93: it
  runs one engine, replaces a hung one itself, and otherwise exits with it,
  and Task Scheduler's restart-on-failure starts it again. Gone: the
  "Orgtree User Session Engine" task, `orgtree-engine session-launch`, the
  helper's `session-engine` and the boot supervisor. An update stops that
  task with the boot tree and deletes it, only when it is the installer's
  own; uninstall deletes a leftover too. An installed build that cannot
  read its tasks (a Task Scheduler, COM or PowerShell failure, or output it
  cannot parse) starts no engine of its own. A first start, a restart or a
  recovery then refuses, before anything is stopped: "Orgtree could not read
  its background engine task, so it started no engine. Use Start engine in
  the tray to try again." The engine shows as unavailable with that reason,
  and the tray offers Start engine (`sessionlaunch.ts` `route`, `'unknown'`;
  rig-sol-b's finding on a1f6c43). Only a task read as absent (a per-user
  installation) or a development build keeps the desktop's own engine.
- **2.** The "Orgtree Credential Helper" task (interactive token) starts the
  helper at sign-in while Run on boot is on; it stays enabled for runs on
  demand. The helper outlives an engine restart: every 5 s it attaches to
  the engine the descriptor names and registers again. An update stops it,
  runs its task again, then the boot task.
- **3 and 5.** `session_host::turn_waits_for_helper`: every turn start waits
  while the user is signed in (or that is not read yet) and no helper hosts,
  until 60 s after the engine's start or after a helper last hosted. It
  starts at once when the user is signed out or the agent chose Session 0
  itself. Running out of the grace is logged once per stretch without a
  helper: `the sign-in helper did not connect in time while the user is
  signed in; turns start in Session 0 until it does`. That holds also when
  the grace ran out before the stretch's first turn arrived: that turn
  starts at once in Session 0 and logs it
  (`session_host::falls_back_for_want_of_helper`, one decision for both
  paths; rig-sol-b's finding on a1f6c43). A turn that waited and
  got the helper logs `the turn waited for the sign-in helper, which
  connected` with the wait.
- **4.** Unchanged (decision 85): the hosted CLIs end with the session and
  the turn resumes in Session 0.
- **6.** The session watch's 60 s startup grace now absorbs a helper that
  comes or goes with the engine's own start: agents count as told, with no
  notice (the restart notice covers it). After the grace, each debounced
  change notifies. A helper that stops while the user is still signed in
  is told as such: "Orgtree's sign-in helper stopped while the user is
  still signed in: Orgtree starts it again, and your next turn waits up to
  60 s for it before it runs in Windows Session 0...". A real sign-out says
  "The user signed out". What agents count as told is written to
  `session-placement.json` also when the engine's start changed it silently.
- **7 and 8.** Run as admin re-registers both owned tasks, the boot task and
  the helper's, at highest or least privilege, in one UAC prompt
  (`runasadmin.ts` `elevatedWriteScript`). The desktop then restarts the
  engine at once (coordinator Q1). At every registration the helper says
  whether it is elevated, measured as the engine measures itself
  (`token_rights`, below): Windows' own reading, Administrators enabled, or a
  High label (`credential_broker` `elevated`). The engine hosts agents
  only through a helper with its own rights (`credential_bridge::same_rights`)
  and answers any other with `412 [rights]`. That helper leaves once its
  CLIs are gone, and the engine runs the helper's task at once
  (`session_watch::keepalive_due`), at the setting's level. Only the host
  role is checked: the desktop's credentials role has no rights to match.
  The restart notice gives the setting and both measurements (below).
- **9.** While the user is signed in, the helper (or the open app) brokers
  git and gh credentials. The engine keeps what a broker served in memory
  (`credential_bridge::ServedCache`, the user's Q3), exactly as served
  (kind, host, path and username), so Session 0 turns can use it after
  sign-out. It is never written, logged or serialized: it has no Debug or
  Serialize, it is zeroed when dropped, and a restart loses it. A broker's
  lookup failure for the same request forgets the entry. With nothing kept,
  the refusal stays the clear `[no-desktop]` one. An answer from memory
  passes the same grant, process and agent checks as a broker's, and its
  first use per stretch is logged without the credential.
- **10.** The engine records each turn's placement and reason
  (`ot.agents.extra`: `session`, `session_reason`, `session_at`), and the
  tree gives every agent `session_placement` (below). The badge itself is a
  renderer change, assigned separately (coordinator Q5).

**`session_placement`** (tree agent record; `domain/tree.rs`): `null` until
the agent's first recorded turn, else `{ "session", "reason", "at" }`:

| Field | Value |
|---|---|
| `session` | `session0` or `signed-in`: where the CLI of the agent's current or most recent turn runs, as the engine started it |
| `reason` | for `session0` only, else `null`: `signed-out` (the user was signed out), `helper-unreachable` (signed in or unread, no helper in time), `preference` (the agent's `session` preference or its `use` 0), `background-work` (its CLI held background work and stayed); `null` for a record from before this field |
| `at` | ISO time of the first turn with this placement and reason |

The record changes only when the placement or the reason does, and its
change refreshes the agent's tree record. An engine that is not in Session 0
(a per-user installation) records `signed-in`.

**Kept from decision 93:** each engine the boot host starts gets its own
readiness window (`host.rs` `Handshake`); the database never runs as
administrator; and the engine's pipes stay its user's, both below. The core
monitor still restores its state after a refused or unwritten command
(`core_monitor.rs` `keep_or_restore`): the revert had dropped that, so a
failed write left a refused Member or Transition for a later tick to
persist (rig-sol-b's finding on a1f6c43). Gone with
the handover: its journal (`core-handover.json`, `core-handover.lock`,
`session-launch-request.json`), the boot supervisor's loss memory and its
`boot-host.lock`. An update leaves such files from an earlier alpha in the
data folder; nothing reads them.

**The database never runs as administrator** (`pg.rs` `spawn_postmaster`,
`winproc::spawn_restricted`). PostgreSQL refuses administrator rights
("Execution of PostgreSQL by a user with administrative permissions is not
permitted"). An engine started elevated on the user's PC died of it
(alpha.29, 2026-10-21 22:47Z). On Windows the engine therefore always starts
the postmaster with a restricted copy of its own token, as pg_ctl starts it.
That token is `restricted_medium_token`, the one the boot host gives an
engine without Run as admin:

- Administrators and Power Users are deny-only (PostgreSQL's own test is
  `CheckTokenMembership` on those two groups).
- It is a LUA token (UAC's own filtering), so every other group Windows
  counts as elevated is deny-only too, and Windows reads it as not elevated
  (below).
- Every privilege but SeChangeNotify is removed, and the label is Medium.
- The default DACL grants the user, SYSTEM and Administrators. An elevated
  token's default DACL names only Administrators and SYSTEM, so without this
  the postmaster could not open its own objects.

The postmaster stays the engine's own child. `pg-attach.json` records its
real pid, and stdout and stderr both append to `postgres.log`; those are its
only inherited handles, with stdin on NUL. `pg_ctl stop`, then a kill and a
wait, still end it, and it stays in the engine's kill-on-close job. initdb
drops the rights itself (it starts itself again with a restricted token
unless `PG_RESTRICT_EXEC=1`), so the engine removes an inherited
`PG_RESTRICT_EXEC` from its environment. The engine itself, its agents,
`pg_ctl` and the mail hub keep the engine's rights. Measured on
`rig-opus/pg-restricted` over `24aa387`: `pg::rights_tests` read the
postmaster's token from outside (SeChangeNotify only, Medium); the test
process was not elevated, so PostgreSQL's refusal and an elevated parent's
token are unmeasured here.

**The engine's pipes stay its user's** (`winproc::create_user_pipe`; the
coordinator 2026-10-22 00:24Z: "Grant the engine's own user SID and give it
a Medium label, nothing broader"): the stdio of a CLI the helper hosts, the
agents' tool bridge (`bridge.rs`) and OpenCode's mail hook
(`opencode_mail.rs`) are created with the default pipe security, the
engine's own user in the owner's entry and a Medium label. An elevated
engine's default would let the helper and its CLIs only read them (inferred
from a measured elevated token's defaults; not run elevated).

**Administrator rights are measured as Windows reads them** (docket
`session-0-engine-and-mail-hub-run-elevated-while`; the user 2026-10-22
11:21Z-11:22Z: keep Run as admin, make both settings correct, and have the
restart notice report the measured elevation of the engine and the helper,
never the setting alone). On alpha.33 with Run as admin off, Task Manager
showed `orgtree-engine.exe serve` and its `orgtree-mailhub.exe` "Elevated:
Yes", while the restart notice said the rights were off. Measured read-only
on those live processes (2026-10-22): Administrators deny-only, a Medium
label and only SeChangeNotify, but "Local account and member of
Administrators group" (S-1-5-114) enabled, and Windows' `TokenElevation`, the
column's value, 1. The sign-in helper's UAC-filtered token has that group
deny-only and reads 0. The engine's own test then (Administrators enabled,
or a High label) said not elevated, so the both-or-neither check let the
unelevated helper host.

- **The engine's token without Run as admin**
  (`winproc::restricted_medium_token`, also every postmaster's) is a LUA
  token (`CreateRestrictedToken` with `LUA_TOKEN`): every group Windows counts
  as elevated is deny-only. A LUA token alone keeps the High label, so the
  Medium step stays. Measured read-only on the token an S4U batch logon of
  the user's own account gets (the boot task's logon, at Identification
  level: an unsplit full token, `TokenElevation` 1): the old copy read 1, the
  LUA copy 0. The linked token of the user's session gave the same.
- **One measurement** (`token_rights.rs`, shared by the engine, the boot host
  and the sign-in helper's binary): elevated when Windows says so
  (`TokenElevation`), when Administrators is an enabled group, or with a High
  label or above. An engine Windows reads as elevated now refuses an
  unelevated helper (`412 [rights]`); alpha.33's would have.
- **The restart notice's line** (`runtime_notices::admin_line`) gives the
  setting, then what was measured:
  - `Administrator rights (Run as admin: off), measured: neither the engine in Session 0 nor the sign-in helper is elevated.`
  - `Administrator rights (Run as admin: on), measured: the engine in Session 0 and the sign-in helper are both elevated.`
  - Signed out: `Administrator rights (Run as admin: off), measured: the engine in Session 0 is not elevated; no sign-in helper runs while the user is signed out.`
  - No helper 60 s after the engine's start: `...; no sign-in helper had connected 60 s after the engine started.`
  - A helper refused for its rights, with none hosting: `...; a sign-in helper that is elevated was refused, so none hosts.`
  - A hosting helper with other rights (the refusal prevents it): `... is not elevated, but the sign-in helper is elevated.`
  - An engine whose measurement differs from the setting adds `The engine's rights do not match the setting.`
- **The passive restart notice waits for the helper** as a turn start does
  (`session_host::turn_waits_for_helper`, for an agent without a Session 0
  choice): until a helper hosts, the user is signed out, or 60 s after the
  engine's start. The waking restart message of an interrupted turn and the
  start's other wakes do not wait; a turn that starts before the notice gets
  it at its next turn. Each start logs `the engine's administrator rights,
  measured` (Windows' reading, Administrators, the label and the setting) and
  the notice's line.
- **The boot host itself stays elevated** with either setting: its S4U logon
  always has the full token, it runs no agent code, and it must be able to
  start an elevated engine when Run as admin is on (coordinator 2026-10-22
  11:32Z: no boot-task change).

What Task Manager's Details tab should show (User name, Session ID and
Elevated; inferred from the measurements above, for the user to confirm):

| Process | Run as admin off | Run as admin on |
|---|---|---|
| `orgtree-engine.exe`, command line `host` (the boot task) | the user's account (an S4U logon of the operator, not SYSTEM), Session 0, Elevated Yes | the same, Elevated Yes |
| `orgtree-engine.exe serve` (the engine) | the user's account, Session 0, Elevated No | the user's account, Session 0, Elevated Yes |
| `orgtree-mailhub.exe serve` (the engine's child) | Session 0, Elevated No | Session 0, Elevated Yes |
| `postgres.exe` (the engine's database) | Session 0, Elevated No | Session 0, Elevated No |
| `orgtree-credential-broker.exe` (the sign-in helper) | the user's session, Elevated No | the user's session, Elevated Yes |

Agent CLIs have their parent's rights: the engine's in Session 0, the
helper's in the user's session.

**Rig seams** (debug builds on a rig root only):
`<data>\core-rig-signed-out` stands for the sign-out, `ORGTREE_RIG_SESSION0=1`
makes an engine report Session 0, `ORGTREE_RIG_HELPER_SESSION` stands a
helper for another session, `ORGTREE_RIG_HELPER_ELEVATED` (1 or 0) makes a
helper report rights it does not have, and `ORGTREE_RIG_STOP_KEY` (HKCU)
carries the installer's stop request. A release build reads none of them.
The proof is `tools/rig/proofs/session0-handover.mjs`.

**Windows limits:**

- **9, signed out with nothing kept (measured):** the S4U engine's logon
  (type 4) has no access to the user's saved credentials. On the user's PC
  (2026-10-21 14:45Z log) it said so: "Agents started before Windows
  sign-in can't use your saved git/GitHub credentials". So a request that no
  broker served while the user was signed in since the engine's start is
  refused with `[no-desktop]`, at once.
- **7, with UAC off (inferred, unmeasured):** every administrator's
  process then holds the full token, so the helper is elevated even at least
  privilege, while the engine without Run as admin gets the restricted token
  and is not. The engine refuses that helper, so agents run in Session 0, and
  each refused helper that leaves has its task run again at once. Run as
  admin on makes the two match. The old test called that engine not elevated
  either, so this predates the measured rights. (This entry used to say the
  two still match.)
- **7, the refused helper's stamp (unmeasured):** if an unelevated engine
  cannot read an elevated helper's process stamp, it treats the refused
  helper as gone at once. The helper task's run may then be ignored while
  the old helper still runs (one instance at a time), and the next attempt
  comes from the ordinary keepalive (30 s, then 2, 5 and 10 minutes).
- **1 and 7 on a per-user installation:** it has no boot task, so the
  desktop's own engine runs in the user's session, as before decision 93,
  and nothing runs in Session 0.

**Verification**, measured on `rig-opus/session0-revert` over `rust-engine`
`ef7f3d2`, in one build-slot batch (logs in
`C:\orgtree-build\rig-opus\session0-revert\batch\logs`):

- **Engine:**
  - Red at the engine test commit: 53 pass, 11 fail, exactly the new tests;
    the helper's red: 10 pass, 1 fail.
  - Green: 109/109 focused (`session_host`, `session_watch`,
    `credential_bridge`, `runtime_notices`, `domain::tree`, `runtime::actor`,
    `tools::session`, `host::` and the `core_*`, `install_stop` and
    `http::desktop` modules); the helper's 11/11.
  - `cargo check --all-targets`: only the base's `domain/tree.rs` warning.
  - Clippy: 173 warning locations, none on a changed line.
  - The `x86_64-linux-android` check: only the 4 known
    `core_monitor`/`core_startup` warnings and the base's.
  - The whole-engine test binary ran out of the 6144 MB Job with
    incremental compilation and fit without it (`CARGO_INCREMENTAL=0`).
- **Installer** (fake task folder, no real task): task definitions 45/45 and
  `tests/boot-installer.test.ps1` 251 assertions; at the red commit the
  retired functions and the leftover task's deletion fail.
- **Desktop:**
  - Node tests (the 44 files that read main's changed modules, and
    `disruptive-policy`): 527 pass, 24 fail at the tip. 23 of the failures
    also fail at the base. The 24th, `org-reopen-routes`, runs only from a
    `C:/orgtree-build` copy, where it passes 19/19. The base's 15 further
    failures come from its exported copy, which has no engine source or
    assets.
  - Red control, the red commit's tests against its old source: 14 more
    failures than the base, all in the changed tests.
  - `run-on-boot.test.mjs`, updated for decision 94: 9/9; against the base
    source, 4 pass and 5 fail, exactly the updated tests.
  - Renderer suites (`runasadmin`, `runonboot`, `desktopstate`,
    `notificationsettings`, `taskbarquestion`): red 28 pass, 2 fail; tip
    30/30.
  - Typechecks: root 0 errors at the base and the tip; renderer tests 42
    at both, the same 42.
  - Glossary coverage 9/9 (base 9/9).
- **Rig proofs:**
  - `session0-handover.mjs`, unsplit: 35/35 in 93 s. From the boot task's
    run to the helper connected took 7.0 s for a restart, 5.1 s for an
    update and 5.9 s for a recovery; the engine served after about 1 s of
    each. A turn sent the moment the engine served ran signed in every
    time. A turn sent in a helper-only gap waited 11.6 s and ran signed in.
  - `session-startup-grace.mjs`: 12/12 in 178 s. A turn after a real helper
    loss waited 59.8 s, then ran in Session 0 (`helper-unreachable`). With
    no helper after a restart, the fallback came after 60.4 s.
  - `session-blip-admission.mjs`: 20/20 in 197 s.
  - `run-on-startup.mjs`: 7/7.
- **After rig-sol-b's three findings on `a1f6c43`**, a second slot batch (logs
  `f*` in the same folder):
  - Engine red: 12 pass, 2 fail, exactly the two new tests (the late
    fallback's decision, the monitor's rollback). Green: 111/111 focused.
    Check, clippy (none on a changed line) and the Android check as above.
  - Desktop red: `session-launch` 3 pass, 2 fail and `run-on-boot` 8 pass,
    1 fail (the unreadable-task refusal and its wiring); green 5/5 and 9/9.
    The node set: 529 pass, 24 fail, the same failures as before. Root
    typecheck 0 errors.
  - `session0-handover.mjs` step J against `a1f6c43`'s engine: a first turn
    after the grace started in 0.9 s in Session 0 with no fallback logged
    (36 pass, 2 fail: the finding at runtime). With the fix: 38/38 in
    164 s, exactly one fallback logged, none for the next turn. Restart →
    helper-connected took 6.8, 5.0 and 6.0 s.
  - `session-startup-grace.mjs` 12/12, `session-blip-admission.mjs` 20/20.
- **Not run here** (they need real Task Scheduler tasks):
  `session-choice.mjs`, `session-upgrade.mjs` and `session-query.mjs`.
  No e2e proof of the credential cache either: the rig has no synthetic
  signed-in broker, so its unit tests stand alone. Helper-attached proofs
  need a rig home whose ancestors no other user can replace (here
  `%LOCALAPPDATA%\orgtree-rig-rig-opus`).

**Verification of the measured rights**, on `rig-opus/session0-elevation`
over `rust-engine` `7698e1a`, in one build-slot batch (logs in
`C:\orgtree-build\rig-opus\session0-elev\batch\logs`), the test process not
elevated:

- Engine red (`token_rights`, `winproc`, `runtime_notices`): 22 pass, 4 fail,
  exactly the new tests. Both token tests copy the linked full token of the
  test's UAC session (`token_probe::elevated_source`), so they measured the
  elevated case without running anything elevated. The helper's red: 11
  pass, 1 fail. Green: 88/88 focused (also `credential_bridge`,
  `session_host`, `session_watch`, `host::`, `http::desktop`,
  `runtime::actor`); the helper's 12/12.
- `cargo check --all-targets`: only the base's `domain/tree.rs` warning.
  Clippy: 172 warning locations, none on a changed line. The
  `x86_64-linux-android` check: only the known warnings.
- `session0-handover.mjs` against `7698e1a`'s engine: 35 pass, 5 fail, the 5
  rights lines (A, D, E, F and J still said "off, ... alike"). At the tip:
  40/40 in 161 s, with the signed-out, both-measured and no-helper wordings.
  `session-startup-grace.mjs` 12/12, `session-blip-admission.mjs` 20/20.
- Not measured: a real elevated or UAC-off engine, the real boot task, and
  Task Manager itself. The rig never runs anything elevated.

**Verification of the operator match and the failure message**, on
`rig-opus/runasadmin-principal` over `rust-engine` `a33a07a`, in one
build-slot batch (logs in `C:\orgtree-build\rig-opus\runasadmin\batch\logs`),
the test process not elevated:

- Measured read-only on the user's PC, not elevated: both owned tasks' COM
  `Principal.UserId` is the bare account name and their XML `UserId` the
  SID; both resolve to the record's `OperatorSid`, and alpha.34's raw
  comparison throws for both.
- Focused node tests (`run-as-administrator`, `run-on-boot`,
  `session-task-settings`, `startup-tray`, `tray-admin`, `update-channel`,
  `disruptive-policy`): base 82 pass, 1 skipped; red 81 pass, 11 fail,
  exactly the 10 new tests and the `allowDowngrade` guard's positive control
  (the bare account name failed with "Task operator does not match the
  installation"); tip 92 pass, 0 fail, 1 skipped (the HKLM write test needs
  an elevated process). The new cases resolve the test's own account
  through Windows and run the scripts and the launcher against in-memory
  Task Scheduler and registry doubles.
- Typecheck: 0 errors at the base and at the tip (1284 files).
- Not measured: a real elevated script, a real permission prompt and a real
  task registration. The user's checklist steps 4 to 6 on the next alpha
  are the proof.

**Only the user can confirm** a real task run, the real permission prompt,
a real sign-in, sign-out and update, and real credentials: the rig's
Session 0 is a stand-in, every proof process runs in the proof's own
session, and a rig engine never runs a real task.

## Decisions beyond the user's words

The coordinator ruled A (the "Run on sign-in" label), C (the helper's run
level), D (15 s, logged) and E (delete the old task at upgrade). These were
chosen in the implementation (rig-opus) and are flagged for the user on the
docket item:

- the settle wait runs at a turn's start (every turn since decision 94), not
  during the engine's recovery, which runs before the engine serves the
  helper;
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
- The real permission prompt switches Run as admin on and off (alpha.34
  failed here), Task Manager then shows the rights it set, and a change
  that fails says why.

## Limits

- **Before the first sign-in after a reboot** everything runs in Session 0;
  Windows offers no interactive token before then.
- **A second Windows session** of the same user starts its own helper; the
  bridge's hold rule keeps the first.
- **Downgrade (inferred, not measured):** a 4.3.x installer reads no
  `StartupMode`, which it takes as boot, and registers its sign-in task
  disabled; its launcher is gone, so nothing starts from it.
