# A turn that could not start is told once

Report: the neoja org, 2026-10-08. A Codex agent's turn "failed before the CLI
could run". It was not retried, and the agent stalled for two hours. 3.x
reference: `supervisor.py`'s terminal belt and `_turn_abandoned` (SH-4, user
ruling 2026-09-12).

## What happened on nick-pc (measured in its logs)

The quoted wording is 3.x's. At 10:07:41Z the desktop shut the 3.2 backend down
to install 4.0.0. The turn being started died a second later, when its database
connections closed. 3.x's belt announced it with the generic text "account
binding, environment or arguments are wrong". It always printed "Error: no
output" there, because it passed an empty error on purpose; the detail went to
`last_error`. 4.0.0 then failed to import the org (missing
`work_items.attention_reason`, fixed in 4.0.1). So nothing ran the agent until
4.0.1 imported the org at 12:11:43Z.

## The 4.0 behaviour

A turn can fail after admission and before its provider runs. Causes include a
CLI or app-server that does not start, an account gate refusing the launch, and
a Codex `turn/start` that is refused. In those cases the turn's mail goes back to
the mailbox and its error goes to `last_error`, as before. A Codex refusal now
carries the app-server's reason. In addition, as 3.x did:

- The agent gets its own copy, `runtime.turn_failed_terminal`, as a notice. It
  waits for the agent's next turn and does not wake it. It is stored with no
  wake at all: a live agent is otherwise sent a wake for a notice too, and with
  the failed turn's mail back in the mailbox, that wake would retry the launch at
  once. The rig measured that retry before this was fixed.
- Its superior is told with `runtime.report_stalled` (cause `terminal`), which
  wakes the superior. With no superior, the user is told. Both carry how the
  turn died and the error.
- It is announced once per run of failures. `hard_fail_run` counts the failed
  turns, a completed turn clears it, and the next failure is news again.
- Nothing retries it. A launch that cannot start would fail the same way, and
  the superior or the next mail decides.
- A freeze, halt, limit lock, killswitch, a seat that is not live and an engine
  shutdown own the stopped state, and are never announced as failures.

Rig proof: `node tools/rig/rig.mjs run tools/rig/proofs/launch-failure.mjs`.
