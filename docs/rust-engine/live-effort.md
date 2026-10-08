# Live effort changes

User report 2026-10-08 16:58Z: an agent retooled to effort max mid-turn kept
its old level until the next turn, which 3.x did not do (decision 23, PLAN C1).
3.x reference: `supervisor.py::send_live_effort` and its three callers (the
settings route, `orgtree_retool` in `_agent_call_in_run`, and
`lifecycle_door.retool_body`).

## Behaviour

Every saved effort change on an agent is delivered after its commit by
`runtime::deliver_effort`. That covers the settings route (`/nodes/{nid}/scope`,
the composer's effort dots, a granted scope request), `orgtree_retool` and the
user's `/ops {op: "retool"}`. A hire or rehire starts a new process anyway.

- The caller compares the levels the agent resolved to before and after the
  save (`catalog::effective_effort`: its own level, else the org default, else
  `high`; an unsupported stored level reads as `high`, as 3.x clamped it).
  The same level answers `unchanged` and nothing is sent.
- A running Claude turn on a tier with `live_effort` is sent
  `apply_flag_settings {effortLevel}` on the CLI's control channel. The level
  is always explicit: a clear back to inherit sends the level it falls back to.
- Anything else answers `next_turn` with 3.x's reason: `only Claude turns take
  an effort change mid-turn` (Codex, Antigravity, OpenRouter), `no turn is
  running`, `the CLI process has exited`, or `the running process could not be
  reached`.
- A process whose level no longer matches is not used for another turn, as
  3.x never parked a process that was sent a level. The next turn starts a
  fresh CLI (or Codex app-server) with the new level on the same session, and
  an idle one is replaced at once. Correctness never depends on the CLI
  honouring the request, and Codex, which passes its spawn-time effort on
  every `turn/start`, gets the change at its next turn.
- An effort-only retool reconfigures nobody else. Before, it restarted the
  target's whole subtree.

Both routes answer `effort_delivery` in 3.x's shape, which the shared renderer
reads for the composer's toast:
`{"delivery": "sent" | "unchanged" | "next_turn", "effort": "<level>", "reason"?: "..."}`.
`sent` means the line reached the running CLI. It does not mean the CLI
applied it.

The card's `pending_effort` (the next-turn effort card) is set only while a
turn runs on a process at another level. After a live delivery the running
process has the level, so no card shows.

## Measured on the real CLI

`tools/measure_live_effort.py` on Claude Code 2.1.292 with Opus 5.5,
2026-10-08 17:10Z. The script starts at `low` and sends `high` after the first
tool call. The CLI answered `success`. The transcript's `effort` read `low`
on the first two model calls and `high` on all nine after the request. The
same turn without the request stayed `low` on all ten.

Run the measurement outside the user's global hooks: the measured sessions
pick up the user's SessionStart hooks.

## Rig proof

`node tools/rig/rig.mjs run tools/rig/proofs/live-effort.mjs [--ui <bundle>]`
covers these paths mid-turn on a Claude agent: retool, the settings route,
a clear, and an unchanged level. It shows the control request reaching the
fake CLI, the card state, and the fresh process with `--effort` on the next
turn. It also covers an idle change, a Codex agent parked and mid-turn, and an
effort-only retool leaving a report's parked CLI alone. With a UI bundle it
drives the desk: no next-turn card after a retool mid-turn, and the
composer's toast.
