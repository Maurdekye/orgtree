---
name: orgtree-shared-folders
description: "Hierarchical shared memory: personal, team, project and org folders, inherited notes and safe shared edits."
---

Up: [orgtree-workspace](../SKILL.md)

# Hierarchical shared memory

Orgtree layers persistent working files and standing notes by their intended readers. Use the exact paths supplied in your session; the paths below show the usual layout, not a new folder grant. Shared workspaces are separate from ordinary granted source folders.

| Folder under `<data>/scratch/<org>/` | Readers and purpose |
| --- | --- |
| `<agent>/` | The agent's own scratch: personal working notes, drafts, evidence and recovery breadcrumbs. Authorized ancestors can inspect it; it is not a secret store. Imported or renamed agents can retain another stored path. |
| `_teams/<agent-id>/` | That agent and all agents in its subtree: the workspace of the team it leads, even if it has no reports. |
| `_teams/<project-id>/` | Agents under that project and supervisors above it: the project's workspace, using the same ID-based layout as teams. Projects may nest. |
| `_shared/` | Every agent in this organization, including future hires: org-wide conventions, decisions and files. Other orgs are outside this implicit access. |

You hold your own team workspace and every ancestor team or project workspace, nearest first. This is upward workspace access, not permission to read an ancestor's personal scratch. A sibling's own team folder is not one you implicitly hold. Supervisors also reach the folders of projects below them. Team and project folders use stable node IDs, so a rename does not move them. A move changes the held set for the next CLI launch.

Organization templates may optionally seed shared, team/project and personal AGENTS.md text into a new org before warm/kickoff effects, without overwriting existing files. Save as template captures these fixed files only when the user opts in; see orgtree-org-templates (orgtree-app › org-settings) for limits and credential checks.

The engine creates shared folders and a header-only `AGENTS.md` when missing, including existing folders at startup or first use. It never overwrites an existing file, even an empty one. A writable seat may create, change and delete files there without a separate folder grant. A read-only seat can read them. Retiring a team root does not delete its workspace. Read the session's effective access rather than inferring write permission solely from a path appearing in a prompt.

Your own scratch is your working folder; its writes also depend on your scope and tools. For native note loading and generated files, see [orgtree-scratch-folder](../scratch-folder/SKILL.md).

## Which standing notes you inherit

Each layer can hold an `AGENTS.md`. At session start, the memory layers contribute notes in this order:

1. Your own scratch notes, loaded by the harness or mirrored by Orgtree without duplicating native delivery.
2. Your own team's notes, then every ancestor team or project's notes up the chain, nearest first. Nested projects each contribute their notes.
3. The org's `_shared/AGENTS.md`, after the team and project notes.

This describes the scratch-memory layers; granted-folder and personal global instructions can also contribute to the complete prompt. You inherit an ancestor **workspace's** notes, not its agent's personal scratch notes. A supervisor can use a project folder below it, but does **not** receive that project's `AGENTS.md` automatically: project notes go to agents under the project.

Engine-mirrored own notes and each team/project/org note file have a 12,000-character cap with explicit truncation; native harness limits can differ. Missing or blank notes add no block. Read the file for content omitted from a truncated copy.

The prompt's copy is from CLI start. Another agent may have edited the file since, and their edit alone does not restart your warm CLI. Re-read the actual file before relying on a recent note or editing it; if the file does not exist yet, create it within your write scope. Make small in-place changes; never write the old prompt copy over a newer file. These shared-note entrypoints use `AGENTS.md`, not a replacement shared `CLAUDE.md`.

## Choose the narrowest common space

While working, write findings and decisions to the shared workspace above you whose readers need them, within your write access. Choose the team, project or org-wide layer to match the scope and breadth of the work; use the narrowest workspace those readers share. Use descriptive names or a topic/agent subfolder. Keep personal memories in [your own scratch notes](../scratch-folder/SKILL.md). Never store secrets, tokens or credentials in shared space.

Keep personal recovery details in your scratch, team practices in the relevant team workspace, project decisions in the project workspace, and organization-wide conventions in `_shared`. Keep `AGENTS.md` short and link to larger working files rather than copying their full contents into standing notes.

Shared storage does not deliver anything to the user. To hand off work, send its intended reader a message or use the user delivery route; keep the source file in the appropriate common folder.

## See also

- [orgtree-scratch-folder](../scratch-folder/SKILL.md)
- [orgtree-projects](../../team/projects/SKILL.md)
