---
name: orgtree-tool-interrupt
description: Interrupt a descendant's current turn, or end your own and start a new one at once; interpret the result.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_interrupt

Use this to ask a descendant's running provider process to interrupt its current turn. The agent remains hired. Waiting waking mail may start a later turn through normal admission. For a continuing stop, use [halt](../tool-halt/SKILL.md). You can also point it at yourself (below).

## Parameter and authority

`node` is required: the agent's name in your organization. A leading `@` is accepted. There is no batch form, subtree flag, reason field, or default target.

For another agent the tool requires effective `tools.orgtree.runtime` permission (`orgtree_interrupt is disabled by your Orgtree tool group scope (you may still interrupt yourself)`), and the target must be a strict descendant: it refuses peers, superiors, or another top-level team (`you can only interrupt your reports and their reports; … is not below you`). `restart` is refused for another agent (`restart is for your own turn only: name yourself as node`). Unknown/deleted names produce `no agent named … in this organization`.

## Yourself

`node` = your own name ends your current turn, whatever your tool groups: every agent has this. With `restart: true`, exactly one new turn starts at once, through a system message ("You ended your previous turn yourself with orgtree_interrupt and asked for a new one, so this turn started at once. Continue where you left off."). That turn runs wherever a turn's start places you: in the user's signed-in session when one is available, unless your preference keeps you elsewhere (see [orgtree_session](../tool-session/SKILL.md)). Use it to move into the signed-in session at once when `next_turn_moves` is true, to apply a new preference or an on-demand session at once, or to start a fresh turn. Without `restart`, your turn just ends, and waiting mail starts the next one as usual.

It is refused while your CLI still runs background work (`your CLI still runs background work: finish or stop it, then call orgtree_interrupt again`) and when no turn runs (`no turn is running`). The call itself is cut short: the new turn sees the message above, not this call's result. A halt that comes first wins: the new turn waits until you are unhalted. A sign-out at the same moment adds no second turn.

## Result and limits

The response contains `node` and a nested `result`:

| Result | Interpretation |
|---|---|
| `interrupted: true` | The interrupt was sent to the current process; this is not proof that all work has settled. |
| `interrupted: false`, `reason: no turn is running` | No current turn was available to interrupt; a queued future turn is not cancelled. |
| `interrupted: false`, `reason: the process could not be reached` | The request could not reach the process. |
| `error: the agent's runtime is stopping` or `the agent did not answer in time` | Runtime handoff failed or its bounded 30-second wait expired. |

An interrupt is not an undo of tool side effects. Check the descendant's state or transcript before assuming an interrupted command finished, failed, or left no changes. A timeout may leave the result uncertain; inspect before retrying.

## Example

```json
{"node":"worker"}
```

```json
{"node":"<your own name>","restart":true}
```

Inspect afterward with [state inspection](../../inspection/tool-state-inspect/SKILL.md) or [transcript reading](../../inspection/tool-read-transcript/SKILL.md).

## See also

- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
- [orgtree-checkups-and-reminders](../checkups-and-reminders/SKILL.md)
- [orgtree-context-and-compaction](../context-and-compaction/SKILL.md)
- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
