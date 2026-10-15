---
name: orgtree-tool-rename
description: Rename a descendant without replacing its identity, conversation or stored scratch folder.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_rename

Requires `team`. Both parameters are required: `node` is the current descendant name; `name` is the desired new name. It may target an archived descendant too. Self, superiors, peers and unrelated agents are refused, including when the caller is top-level.

The new name must be 1–64 ASCII letters/digits, hyphens, underscores or dots, starting with a letter/digit. Names user, system, engine, org and net are reserved (case-insensitive). Another non-deleted agent in this org cannot hold the new name. The same current name returns `unchanged: true`.

Renaming changes the name on the existing agent row, updates audience names/pending audience requests and activity-watchdog targets, and asks the runtime to reconfigure that seat. It does not hire a new identity, clear history or rename its stored scratch directory. Use the working path actually supplied to the agent instead of constructing a new path from its display name. Durable docket slugs also remain fixed; inspect the current item instead of treating agent and item names as interchangeable.

```json
{"node":"draft-checker","name":"source-checker"}
```

The successful result includes `renamed: true`, `was` and the new `node`. Use that returned name for later management/mail calls and tell collaborators when their saved name references matter. A new name does not grant new audiences or permissions.
