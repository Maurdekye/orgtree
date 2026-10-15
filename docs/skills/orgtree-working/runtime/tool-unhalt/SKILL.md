---
name: orgtree-tool-unhalt
description: Release named descendants' persistent halts and understand remaining admission gates.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_unhalt

Release an agent's [persistent halt](../tool-halt/SKILL.md) when it may run again. The runtime clears its halt and checks for waiting waking mail. Unhalting alone does not supply a task.

## Parameters

| Parameter | Meaning |
|---|---|
| `node` | One agent name. Required when `nodes` is omitted. |
| `nodes` | Array of names. When supplied, it takes precedence over `node`. |

There is no default target or subtree expansion. Empty input is refused. Exact duplicate submitted names are deduplicated first. One submitted name remaining after that step uses the single-agent result shape; otherwise the response is a batch. Aliases are resolved afterward: `nodes: ["worker", "@worker"]` acts on one agent but returns a batch with one result entry.

Requires effective `tools.orgtree.runtime`. Every target must be a strict descendant in your organization. Top-level callers have the same downward-only authority; they cannot unhalt themselves or another top-level team through this tool.

## Results and limits

All target names and permissions are validated before execution. The runtime then contacts each actor concurrently with a bounded 30-second wait. A single result includes `node`, `unhalted: true`, and `status: idle`. That `status` is the operation result; it does not replace the agent's last reported work status or guarantee a new turn has started. Releasing an already clear halt is harmless.

For a batch, `batch` is the number of resolved agents and a `nodes` result map reports each outcome. Runtime failures can leave a mixed batch even though permission validation happened first. Re-read uncertain outcomes before repeating a timed-out call.

A usage freeze, org stop latch, account eligibility problem, or turn-capacity wait can still prevent a turn. Use [unstick](../tool-unstick/SKILL.md) for a usage freeze when appropriate; unhalt does not clear it. It does not rehire a retired agent.

Common refusals are `name the agent (node) or agents (nodes)`, `nodes must be a list of node ids`, `you cannot unhalt yourself`, unknown names, and targets outside your descendants. Single runtime failures report `could not unhalt …: …`; batch errors stay in their per-agent entry.

## Example

```json
{"node":"worker"}
```

Use [state inspection](../../inspection/tool-state-inspect/SKILL.md) to distinguish a remaining freeze, halt, retirement or mid-turn state.
