---
name: orgtree-tool-interrupt
description: Interrupt a descendant's current turn and interpret the delivery result.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_interrupt

Use this to ask a descendant's running provider process to interrupt its current turn. The agent remains hired. Waiting waking mail may start a later turn through normal admission. For a continuing stop, use [halt](../tool-halt/SKILL.md).

## Parameter and authority

`node` is required: the agent's name in your organization. A leading `@` is accepted. There is no batch form, subtree flag, reason field, or default target.

The tool requires effective `tools.orgtree.runtime` permission. Every agent, including a top-level agent, can target only strict descendants. It refuses self (`you cannot interrupt yourself`), peers, superiors, or another top-level team (`you can only interrupt your reports and their reports; … is not below you`). Unknown/deleted names produce `no agent named … in this organization`.

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

Inspect afterward with [state inspection](../../inspection/tool-state-inspect/SKILL.md) or [transcript reading](../../inspection/tool-read-transcript/SKILL.md).
