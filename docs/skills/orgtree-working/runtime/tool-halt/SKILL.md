---
name: orgtree-tool-halt
description: Halt named descendants persistently while retaining their seats and waiting mail.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_halt

Halt an agent when it must stay stopped until explicitly released. The runtime cancels its slot wait, ends its process and active turn, and persists the halt. Its mail waits. Halting retains the agent's record, session and seat; it does not retire it or free its hiring credits.

## Parameters

| Parameter | Meaning |
|---|---|
| `node` | One agent name. Required when `nodes` is omitted. |
| `nodes` | Array of agent names for a batch. When supplied, this takes precedence over `node`. |

There is no default target or automatic subtree expansion: list every agent that should be halted. An empty list is refused. Exact duplicate submitted names are deduplicated first. One submitted name remaining after that step returns the single-agent response, like `node`; otherwise the response is a batch. Aliases are resolved afterward: `nodes: ["worker", "@worker"]` acts on one agent but returns a batch with one result entry.

## Authority and execution

Requires effective `tools.orgtree.runtime`. Each target must be a strict descendant in your org. Top-level agents use the same rule; being top-level gives no authority over peer teams or self.

All target names and downward permissions are checked before any actor is told to halt. An invalid target refuses the whole request before execution. After validation, actor calls run concurrently and each waits at most 30 seconds; a multi-agent batch can contain both successful and failed outcomes. It is not an all-or-nothing transaction across actors.

The halt cuts background work that depends on the agent's process. It is not a rollback of file writes or other external actions. Watchdogs are separate monitors; this tool targets agents and does not remove their watchdog definitions.

## Results and refusals

A settled single-agent result includes `node`, `halted: true`, `settled: true`, and `status: halted`. A multi-agent result has `batch` and a `nodes` object keyed by target name; inspect every entry. This returned status describes the halt operation, not a new `orgtree_status` report.

Common refusals include `name the agent (node) or agents (nodes)`, `nodes must be a list of node ids`, `you cannot halt yourself`, an unknown name, or a target outside your descendants. A single runtime failure becomes `could not halt …: …`; batch failures appear in the relevant result entry. An answer timeout does not prove no halt occurred: [inspect state](../../inspection/tool-state-inspect/SKILL.md) before retrying.

## Example

```json
{"nodes":["builder","reviewer"]}
```

Use [unhalt](../tool-unhalt/SKILL.md) to release the persistent halt, or [interrupt](../tool-interrupt/SKILL.md) when only the current turn should be stopped.
