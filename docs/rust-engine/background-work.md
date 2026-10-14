# Background work keeps an agent's process open

An agent's CLI can run work in the background that outlives the turn that
started it: a Claude Code command run with `run_in_background` or a background
subagent, a shell command Muse moves to the background after about 10 s. With
warming off, Orgtree closed every process at its turn's end, so that work died
with it and its result never reached the agent (muse-code.md gap 11). The
user's ruling (2026-10-14 09:44:51Z, mb0530d71c4ee, relayed by coordinator-opus,
decision 77) is **keep open, for Muse and Claude Code**: the process stays open
while it runs background work, and the results reach the agent the way
[`muse-code.md`](muse-code.md) describes for Muse. The memory a held process
costs is accepted.

## When a process is held

A process is **held** (`proc_held` on the desk) instead of closed when one of
these closes it while background work is pending:

- the end of a turn with warming off;
- warming being switched off (`cool_all`) while it is parked;
- the idle cap evicting it while it is parked (warming on).

Background work is pending while any of these holds (`bg_pending`):

- a background task runs: one in Claude Code's own live set
  (`background_tasks_changed`), or a call Muse moved to the background;
- a result reached the CLI while no turn ran: the CLI gives it to the next turn
  on that process, so the process is kept for that turn (`bg_unread`);
- results settled during the turn that just ended, for 3 s (`BG_GRACE`): a
  turn the CLI starts by itself in that time shows that the ended turn did not
  take them (below).

A held process is not parked: the idle cap neither counts it nor evicts it,
and it never makes another agent's warm process close. Its background tasks
show in the desk's `bg_tasks`. A turn starting on it uses it as usual (the CLI
gives that turn what it holds), and at that turn's end the rule applies again.
Once nothing is pending it closes (`release_held`) the way an idle process
closes: Claude Code's input is closed and it exits by itself; the Muse host is
closed. There is no time cap: a command that never ends keeps the process
until one of the closes below.

With warming on, a parked process is a warm process like any other (it counts
toward the cap) until the cap evicts it or warming is switched off; only then
does its pending background work hold it.

## What still ends it (unchanged)

Halt, the process's stop control, a turn killed at its time limit, a turn that
ends at a usage limit, a settings change that restarts the process (including
an effort change and queued configuration), engine shutdown, and a retire or
delete. Each still closes or kills the process, and each background command
lost with it is reported: Claude Code's as the orphan card (P33) and on its
chip ("ended with its CLI (the CLI was closed) before it finished"), Muse's on
its chip and in one waking message ([`muse-code.md`](muse-code.md)).

**A startup-file edit does not replace a held process** (muse-code-opus
2026-10-14, within the ruling; reported to coordinator-opus). Decision 61
replaces an idle agent's CLI at once after an edit of its startup files (its
`CLAUDE.md`, `AGENTS.md`, rules, auto-memory), so that the next turn starts
warm. Replacing a held process would end its background work, and such a
process is not kept for warmth: it is left alone, the desk says the next turn
starts a fresh process (`proc_relaunch`), and that turn does (decision 61
still holds for every turn). A held process whose work ends first simply
closes.

## Claude Code: how a background task's end reaches the agent

Measured on Claude Code 2.1.292 (2026-10-14, haiku, synthetic scratch turns
with Orgtree's own stream-json flags, `--setting-sources project,local
--no-session-persistence`; probe `claude-bg-probe.mjs`, results under
`C:/orgtree-build/muse-code-opus/tmp/claudebg/`):

- A Bash call with `run_in_background: true` prints `background_tasks_changed`
  (the live set) and `task_started` (`task_type: local_bash`,
  `is_backgrounded: true`, the call's `tool_use_id`), and its result at once:
  "Command running in background with ID: X. Output is being written to:
  `<temp>\claude\<project>\<session>\tasks\X.output`. You will be notified when
  it completes." Foreground calls get a task id and a `task_started` too
  (`is_backgrounded: false`), never in the live set.
- Its end prints `task_updated`, `task_notification` (`status` completed or
  failed, `summary` `Background command "<cmd>" completed (exit code 0)` or
  `… failed with exit code 3`, `output_file`) and an empty live set.
- What the model gets is that notification, quoted verbatim by the model:
  `<task-notification>` with the task id, tool-use id, output file, status
  and summary. **Never the output**: the model reads the file if it wants it.
- When the task ends while a turn runs, the CLI puts the notification into
  that turn's next model call. When no turn runs, **it starts a turn of its
  own 40-110 ms later** (a new `system init`, a model call, a `result`) with
  no input from Orgtree. An idle CLI prints nothing before its first input, so
  any `system init` while Orgtree runs no turn is such a turn.
- Interrupted at its `system init` (Orgtree's interrupt control request), that
  turn ends at once with `[Request interrupted by user]` and a
  `result` of `error_during_execution` with every usage count 0; the CLI does
  not start it again (unlike Muse); the notification stays in the session and
  the next turn quoted it.
- With its input closed while a task runs, the CLI waits for the task, runs
  that turn of its own and exits (3.x's drain-to-exit). Orgtree's close waits
  5 s and then kills it, so a running task died with it before this change.

What Orgtree does (the same delivery as for Muse):

- A background task is followed past its turn from its `task_started`, with
  its chip. When its notification arrives, the chip gets what the command
  printed, read from its output file (at most 1 MiB, only a `<task>.output`
  file inside the CLI's folder in the temp directory), with its line count and
  end time; for a task that did not complete, the summary is the error and the
  full output is kept for reading on demand, as for any failed shell call. A
  background subagent's chip gets the summary.
- Every turn the CLI starts by itself is interrupted (Orgtree admits turns),
  warned about at most once a minute with the count, and its lines and result
  are no turn's of the agent.
- An idle agent is woken through its mailbox with one system message per
  ended task, naming the call as its chip does and how it ended: "Your
  background command has finished (it completed, exit code 0): Bash `npm run
  build`. Claude Code has put its notification (status, exit code and output
  file) into your context; this message only wakes you so you can act on it."
  It never carries the output. The message waits until the CLI's own turn has
  been interrupted (or 3 s if none comes), so the agent's turn never races
  that turn. A task the CLI reports as stopped without finishing keeps its
  existing waking card (P33) instead, not both.
- A turn running when the task ends gets the notification from the CLI and no
  message is sent. A result that settles during a turn's last model step is
  not taken by it: the CLI starts its own turn right after the turn, Orgtree
  interrupts it, and only then wakes the agent (`BG_GRACE`). Muse has the same
  race and the same handling.

## Known limits

- **Mail at the same moment.** Mail that starts the agent's turn in the
  40-110 ms between a notification and the CLI's own turn can let that own
  turn's result end the agent's turn early, and its own query then be
  interrupted. This existed before with warming on; Orgtree's own wake avoids
  it by waiting for the own turn.
- **A process replaced before its owed result is taken** (a settings change,
  or the next turn starting a fresh process after a startup-file edit): Claude
  Code resumes the session, whose transcript holds the notification
  (inferred, not measured); a Muse host's undelivered result may be lost (not
  proven either way, muse-code.md).
- **An agent that cannot run** (halted, frozen, the org's killswitch, waiting
  long for a turn slot) keeps a held process until it runs or the process is
  closed by one of the ends above.
- Interrupted Claude turns reported no usage (measured). Whether a Muse
  delivery turn cancelled during its model step costs usage is unmeasured
  (muse-code.md gap 10).

## Verification

Engine unit tests (with the item's commits): `runtime::tasks::background_tests`
(3: background versus foreground tasks as the real CLI reports them, the exit
code read from the summary, the output file's folder check and 1 MiB bound)
and `runtime::actor::claude_bg_tests` (2: the wake note, the settled chip).

Rig proofs, on the fake CLIs with the measured behaviour (the fake Claude CLI's
`bg` step and the fake Muse host's `miss_running_turn`, test-rig.md). **Not yet
run when this was written; the expected counts below are part of the item, and
a different count fails it:**

| Proof | Expected on this engine | Expected red control (engine 2e3d287) |
|---|---|---|
| `claude-bg-result.mjs` (warming on) | 16/16 | 5 pass (hire, desk count, the three fake-side facts), 11 fail |
| `bg-keep-open.mjs` (cap 1, warming toggled) | 17/17 | 1 pass (hire), 16 fail |

`muse-bg-result.mjs` (24), `background-and-mail.mjs`, `claude-close.mjs`,
`muse-tool-silence.mjs`, `muse-lane.mjs`, `turn-failures.mjs` and
`cache-keeper.mjs` keep their counts.

## Files

- `engine/rs/orgtree-engine/src/runtime/actor.rs`: `hold`, `release_held`,
  `bg_pending`, `bg_result`, `own_turn_cancelled`, `follow_claude_background`,
  `on_claude_late`, `claude_lost`, `claude_settle_chip`, `claude_finished_note`;
  `end_turn` and `CloseIdle` hold; the startup-file check leaves a held
  process; `proc_held` on the desk.
- `engine/rs/orgtree-engine/src/runtime/tasks.rs`: `command_output`,
  `reported_exit_code`, `is_background`, `asked_background`.
- `engine/rs/orgtree-engine/src/runtime/sched.rs`: the rig's cap
  (`ORGTREE_RIG_MAX_PARKED`).
- `tools/rig/fakecli/src/main.rs` (Claude `bg` step), `muse.rs`
  (`miss_running_turn`); `tools/rig/proofs/claude-bg-result.mjs`,
  `bg-keep-open.mjs`; `maxParked` in `rig.mjs`, `lib.mjs`, `keeper.mjs`.
