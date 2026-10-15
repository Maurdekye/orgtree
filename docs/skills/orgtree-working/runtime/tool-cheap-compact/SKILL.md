---
name: orgtree-tool-cheap-compact
description: Reset an idle descendant's session and seed its next turn with a handoff summary.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_cheap_compact

Use this to replace a descendant's current conversation context with a fresh session when a handoff summary is enough. Prepare durable breadcrumbs and docket progress first. This operation loses the old session's full conversational context; it cannot transfer an in-flight external process by summarizing it.

## Parameter and authority

`node` is required: one agent name in your organization, with an optional leading `@`. There are no batch, threshold, summary, or immediate-wake arguments.

The permission group is **`team`**, despite this leaf living under runtime: effective `tools.orgtree.team` must allow it. All agent callers, including top-level agents, may compact only strict descendants. Self and agents outside that downward chain are refused.

## Behavior

The target must be live, idle and have a session. The operation clears that same agent record's session and occupancy, marks a handoff due, and stops/reconfigures its process. It does not retire the agent, hire a replacement, change its tier/grant/team, or restart the engine. Successful output includes `node` and `compacted: true`; it does not mean a new model turn has run.

At the next turn, the runtime constructs a handoff from the last status, recent conversation, docket and correspondence hints, and any standing request. It directs the fresh session to read `breadcrumbs.md` first. It also attempts to save up to the newest 5,000 desk rows, oldest first, as `earlier-conversation-<timestamp>.md` in the target's scratch folder. A save failure is logged and the handoff can proceed without that file; the file is not a guaranteed complete lifetime transcript.

Earlier stored history remains readable through [read transcript](../../inspection/tool-read-transcript/SKILL.md), and the scratch export through [read scratch](../../inspection/tool-read-scratch/SKILL.md). The session change creates a new cache namespace; do not promise a provider cache hit based on a previously warm process.

This tool does not call the provider's within-session `/compact` operation. Some older desk confirmation text describes forks, knowledge bearers or replacement hires; the current engine operation resets the same record as described here.

## Refusals and example

Refusals include `you cannot compact yourself`, `you can only compact agents below you; … is not`, `… is not live`, `… is in the middle of a turn; compact it when it is idle`, and `… has no conversation to compact yet`. No threshold is required or inferred by this manual call.

```json
{"node":"worker"}
```

## See also

- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
- [orgtree-checkups-and-reminders](../checkups-and-reminders/SKILL.md)
- [orgtree-context-and-compaction](../context-and-compaction/SKILL.md)
- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
