---
name: orgtree-tool-project
description: Create a project node (a free, turn-less node with its own folder, mailbox and presentations), edit its description, or see and release its slots.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_project

Requires `team`. `action=describe` with `name` and `description` replaces a project's description (you must be above or below the project; its agents carry the new text from their next start). `action=create` makes a **project node** (what one is and who reaches it: [orgtree-projects](../projects/SKILL.md)).

- `name` (required): a new name in the organization, 1–64 letters, digits, `-`, `_` or `.`, unique among agents and projects.
- `index` (required): the zero-based final position among the live siblings under the parent, as for [orgtree-tool-hire](../tool-hire/SKILL.md).
- `parent` (optional): yourself by default; one of your reports at any depth; or a project you are inside (a nested project). Only the user creates a project at the top level.
- `description` (optional): what the project is. It is shown on its card and is the standing charter of every agent under the project.

A project costs nothing: it has no seat and never holds credits of its own. The agents you later hire under it are paid by the nearest agent above it, so hire under a project with [orgtree-tool-hire](../tool-hire/SKILL.md) `parent=<project>` from an agent above it; an agent below a project is refused (`hiring under project … is paid by the agent above it`).

```json
{"action":"create","name":"website","index":0,"description":"The company website."}
```

The result names the project, its parent, its final `index`, `live_sibling_count` and its `folder` (`<data>\scratch\<org>\_teams\<id>`). Write the project's `AGENTS.md` there: every agent under the project gets it at session start.

Everything else uses the usual tools with the project's name: [orgtree-tool-move](../tool-move/SKILL.md) agents into it, [orgtree-tool-rename](../tool-rename/SKILL.md), [orgtree-tool-reorder](../tool-reorder/SKILL.md), [orgtree-tool-retire](../tool-retire/SKILL.md) (its agents retire with it) and [orgtree-tool-rehire](../tool-rehire/SKILL.md) (restores the project, free). Model, account, scope, credit and compaction tools refuse a project (`… is a project, not an agent`).

**Slots.** A project with a slot count (Project settings, 0 by default) gives out that many slots, first come first served; claim one with an [orgtree-tool-watchdog](../../watchdogs/tool-watchdog/SKILL.md) of kind `slot`. Two actions go with them:

- `action=slots` with `name`: the project's slot count, its holders (agent, slot, lease, since, reminders), the line in order (place, agent, since) and its last 20 holds with how each ended. Agents above or below the project may look.
- `action=release_slot` with `lease` (and an optional `note`, e.g. `build ok 265s`): releases the slot you hold; the next in line is granted it at once. Only the holder releases its own lease; another agent is refused (`lease … is …'s; only its holder releases it`). A released or reclaimed lease is refused (`lease … has already ended (…)`).

```json
{"action":"release_slot","lease":"s3f1c2a9b0d4e","note":"build ok"}
```

## See also

- [orgtree-projects](../projects/SKILL.md)
- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
