---
name: orgtree-tool-project
description: Create a project node (a free, turn-less node with its own folder, mailbox and presentations), or edit its description.
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

## See also

- [orgtree-projects](../projects/SKILL.md)
- [orgtree-hiring](../hiring/SKILL.md)
- [orgtree-credits](../credits/SKILL.md)
