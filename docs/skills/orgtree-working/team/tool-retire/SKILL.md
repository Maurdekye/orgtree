---
name: orgtree-tool-retire
description: Archive a seat to reclaim its allocation while preserving its context and files for later restoration.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_retire

Requires `team`. The single required parameter is `node`, the name of the agent or project to retire. A project remains a container: retirement archives its live subtree, retains project identity/policy/history and does not create a runtime or model seat. Use when finished expertise no longer needs live capacity; [halt](../../runtime/tool-halt/SKILL.md) instead keeps an agent's live seat and credits reserved.

**Retiring a descendant with live reports archives its whole live subtree.** It does not lift the reports to you. Transfer unfinished work and inspect the team before calling; use [dissolve](../tool-dissolve/SKILL.md) when the whole-team intent should be explicit.

The normal target must be below you. Self-retirement is permitted only when no live agent remains in your descendant subtree; intervening projects are transparent to that check. Archived descendants alone do not block it. Arrange unfinished work and leave the handoff before ending your own seat. An already archived authorized target returns `freed: 0` with a no-op warning; other non-live states are refused.

Retirement archives the live target/team, stops their processes, makes open request cards moot and pauses their owned watchdogs. The parent's held credits drop by the target's seat plus grant; its grant itself does not shrink. This is capacity, not a cash refund or recovered tokens. The result returns `node`, `freed` and a warning if retirement became dissolution.

Conversation history, scratch files and durable docket records remain. [Rehire](../tool-rehire/SKILL.md) can restore the identity; retiring the owner does not complete or reassign its work. Leave accurate docket state/evidence and breadcrumbs first. User-only rescind and permanent deletion have different consequences and are not parameters of this tool. Top-level status does not grant retirement authority over peers.

Retiring many seats takes one call each. Completion time depends on the target's live subtree, process shutdown and concurrent work; there is no fixed sub-second guarantee. From Claude Code they run one at a time, each after every earlier call in the same reply has finished, so a foreground subagent earlier in that reply holds them all until it ends: send them in a reply of their own. See `orgtree-harness-claude-code` (orgtree-app › harnesses). Retires that do arrive together run side by side; [team shape](../team-shape/SKILL.md) says what a collision between them does.

```json
{"node":"draft-checker"}
```

Use only after confirming draft-checker and any live descendants are ready to stop. A successful call is not proof that a previously running external operation finished; record interrupted work honestly.

## See also

- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-delegating](../delegating/SKILL.md)
- [orgtree-team-shape](../team-shape/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
- [orgtree-charters](../charters/SKILL.md)
- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
