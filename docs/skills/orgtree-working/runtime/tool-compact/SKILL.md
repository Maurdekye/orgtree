---
name: orgtree-tool-compact
description: Check native normal-compaction support or request admission for one descendant.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_compact

Ask the target's harness to compact its existing conversation. Use capability first
when support is uncertain. This is separate from [cheap compact](../tool-cheap-compact/SKILL.md),
which replaces the session with a summary handoff. There is no automatic fallback.

## Parameters and reach

- `node` (required): one agent name in your organization, optionally prefixed with `@`.
- `action`: `capability` or `compact`; omitted means `compact`. Other values, including
  null, are refused. There is no self or bulk form.

The **team** tool group must be enabled through the effective inherited scope.
Every caller, including a top-level agent, may target only strict descendants.
Self, peers, superiors, other organizations and project nodes are refused. Authority
and team scope are checked again at actor admission, in case the hierarchy or scope changed.

## Capability and result

`capability` only reads the effective harness route. It creates no actor, starts no
process and performs no compaction. Claude Code and Muse support normal compaction.
OpenRouter and local routes support it only through Claude Code. Codex, Antigravity,
OpenCode and unknown routes report `supported:false` with a reason.

Both actions return `node`, `supported`, `started` and `reason`. Capability always
returns `started:false`. For compact, **started:true means admitted**, never finished.
Wait for the target's ordinary runtime/transcript evidence to learn the outcome.
There is no completion promise, forced interruption, replacement hire or cheap fallback.

Busy turns, missing sessions, retired/halted/stopped targets and unavailable runtimes
can refuse admission with `started:false` and their actual reason. Examples include
`a turn is running; wait for it or interrupt it`, `this agent is not running
(retired, halted or stopped)`, and `Normal compaction is not available for Codex
in Orgtree.` A runtime timeout/stopping error also returns `started:false`.
Unsupported capability is distinct from an otherwise supported harness refusing now.

Agent-origin admission does not grant user contact or send deep-reach notices.
A desk command retains its existing user-origin behavior.

```json
{"node":"worker","action":"capability"}
```

```json
{"node":"worker"}
```

## See also

- [orgtree-tool-cheap-compact](../tool-cheap-compact/SKILL.md)
- [orgtree-context-and-compaction](../context-and-compaction/SKILL.md)
