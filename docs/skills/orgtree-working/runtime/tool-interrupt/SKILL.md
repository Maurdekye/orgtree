---
name: orgtree-tool-interrupt
description: Interrupt yourself or a report, optionally at a completion boundary, and restart its next turn.
---
Up: [orgtree-runtime](../SKILL.md)

# orgtree_interrupt

`node` names one agent in your organization; a leading `@` is accepted. For a
different agent, you need effective runtime permission and a strict descendant
(through projects too). Peers, superiors, projects and unknown names are refused.
Self-interruption needs no runtime permission.

| Option | Meaning |
| --- | --- |
| omitted flags | Interrupt the current turn now. Waiting mail can wake it later. |
| `restart: true` | After this turn settles, wake one new turn through normal placement. Works for yourself or an authorized descendant. |
| `queued: true` | Record a request for this turn and wait for a completion boundary below. |
| both flags | Wait for the boundary, interrupt, then start the next turn. |

For a pending account/model/session change or retool, use
`{"node":"worker","queued":true,"restart":true}` to apply it promptly.
Background work refuses queued/restart requests; finish or stop it first.
Immediate self-interrupt also retains that guard.

## Harness boundaries

| Harness actually running | Queued boundary |
| --- | --- |
| Claude Code (including OpenRouter routed through Claude) | Held PostToolUse callback after active tools finish. No streamed thought/response pause is claimed. |
| Antigravity | Held PostInvocation callback after active tools finish. This is an invocation hook, not a post-tool RPC. |
| Codex | Attributed completed tool, reasoning or response item, after observed active items finish. |
| Muse | Attributed completed tool, reasoning or response item, after observed active items finish. |
| OpenCode / ACP (OpenRouter and local server lanes) | Completed/failed tool-call update. ACP text/thought chunks have no completion marker. |

Codex, Muse and ACP completion notices are asynchronous: the next step may
already have started and be cut off near its start. This trade-off is intentional
(user 2026-10-20). Other observed active parallel calls must finish first.
The result's `boundary` describes the current harness, not a pending model switch.

If the turn finishes naturally first, the queued stop is a no-op;
`restart: true` still requests one next turn. Requests cannot interrupt a later
turn. Halt/retire/shutdown cancels an unapplied request. Repeated requests report
the first request's options; they do not add restarts or change those options.
No running turn is a refusal, not a request to stop a future turn.

## Results and observation

Results contain `node` and nested `result`. `queued: true` means accepted, not
already stopped. `interrupted: true` means an interrupt was sent, not proof all
work settled or a replacement turn started. `restart` describes the requested
wake; normal halt, placement, usage and admission rules still apply. A lost
process or runtime handoff reports a reason. Timeouts are uncertain: inspect
before retrying. An interrupt does not undo a tool's external effects.

`orgtree_state_inspect` includes the visible agent's latest runtime `interrupt`
record: `status` (`queued`, `applied`, `noop`, `refused`, `cancelled`), `turn_id`,
`restart`, `boundary`, requester and timestamp. It lasts for that actor's lifetime,
not across an engine restart. The scoped `agent.interrupt` event carries the same
small record. A boundary-time refusal appears there; it does not schedule a restart.
Queued state is never restored onto a new turn.

Use [halt](../tool-halt/SKILL.md) for a continuing stop, and
[state inspection](../../inspection/tool-state-inspect/SKILL.md) or
[transcript reading](../../inspection/tool-read-transcript/SKILL.md) to verify
settlement. [Session placement](../tool-session/SKILL.md) explains next-turn placement.
