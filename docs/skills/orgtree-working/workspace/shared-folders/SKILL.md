---
name: orgtree-shared-folders
description: "Choose org or team scratch space and edit shared standing notes without overwriting newer work."
---

Up: [orgtree-workspace](../SKILL.md)

# Shared files and shared notes

Use the exact org and team paths supplied in your session. These are implicit collaboration folders, separate from ordinary granted source folders.

| Folder | Readers and purpose |
| --- | --- |
| `<data>/scratch/<org>/_shared` | Every agent in this organization, including future hires; org-wide material. Other orgs are outside this implicit access. |
| `<data>/scratch/<org>/_teams/<root-agent-id>` | Agents inside that root's subtree; material needed by that team. |

You hold your own team workspace and every ancestor team's workspace, nearest first, including when you have no reports. This is upward workspace access, not permission to read an ancestor's personal scratch. A sibling's own team folder is not one you implicitly hold. Team folders use stable agent IDs, so a rename does not move them. A move changes the held set for the next CLI launch.

The engine creates shared folders and a header-only `AGENTS.md` when missing, including existing folders at startup or first use. It never overwrites an existing file, even an empty one. A writable seat may create, change and delete files there without a separate folder grant. A read-only seat can read them. Retiring a team root does not delete its workspace. Read the session's effective access rather than inferring write permission solely from a path appearing in a prompt.

## Choose the narrowest common space

Put a peer collaboration file in the smallest team folder both readers hold. Use `_shared` when the whole org needs it. Use descriptive names or a topic/agent subfolder. Keep personal memories in [your own scratch notes](../scratch-folder/SKILL.md). Never store secrets, tokens or credentials in shared space.

Each shared folder has an `AGENTS.md`. Org notes reach every org agent; team notes reach that subtree, delivered nearest team first, followed by the org notes. Each engine-delivered file is capped at 12,000 characters with explicit truncation. Missing or blank notes add no block.

The prompt's copy is from CLI start. Another agent may have edited the file since, and their edit alone does not restart your warm CLI. Re-read the actual file before relying on a recent note or editing it; if the file does not exist yet, create it within your write scope. Make small in-place changes; never write the old prompt copy over a newer file. These shared-note entrypoints use `AGENTS.md`, not a replacement shared `CLAUDE.md`.

Shared storage does not deliver anything to the user. To hand off work, send its intended reader a message or use the user delivery route; keep the source file in the appropriate common folder.

## See also

- [orgtree-scratch-folder](../scratch-folder/SKILL.md)
