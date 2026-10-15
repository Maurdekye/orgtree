---
name: orgtree-tool-retire
description: Archive a seat to reclaim its allocation while preserving its context and files for later restoration.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_retire

Requires `team`. The single required parameter is `node`, the name of the agent to retire. Use when finished expertise no longer needs live capacity; [halt](../../runtime/tool-halt/SKILL.md) instead keeps a live seat and its credits reserved.

**Retiring a descendant with live reports archives its whole live subtree.** It does not lift the reports to you. Transfer unfinished work and inspect the team before calling; use [dissolve](../tool-dissolve/SKILL.md) when the whole-team intent should be explicit.

The normal target must be below you. Source also allows retiring yourself only when its descendant check is empty; that check includes non-deleted archived descendants, despite the refusal saying "you still have live reports". Do not depend on self-retirement while any descendants remain; ask your superior to retire you after leaving the handoff. An already archived authorized target returns `freed: 0` with a no-op warning; other non-live states are refused.

Retirement archives the live target/team, stops their processes, makes open request cards moot and pauses their owned watchdogs. The parent's held credits drop by the target's seat plus grant; its grant itself does not shrink. This is capacity, not a cash refund or recovered tokens. The result returns `node`, `freed` and a warning if retirement became dissolution.

Conversation history, scratch files and durable docket records remain. [Rehire](../tool-rehire/SKILL.md) can restore the identity; retiring the owner does not complete or reassign its work. Leave accurate docket state/evidence and breadcrumbs first. User-only rescind and permanent deletion have different consequences and are not parameters of this tool. Top-level status does not grant retirement authority over peers.

```json
{"node":"draft-checker"}
```

Use only after confirming draft-checker and any live descendants are ready to stop. A successful call is not proof that a previously running external operation finished; record interrupted work honestly.
