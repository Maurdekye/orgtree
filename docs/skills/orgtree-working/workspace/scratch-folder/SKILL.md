---
name: orgtree-scratch-folder
description: "Use your scratch folder and standing notes while leaving generated launch files to the engine."
---

Up: [orgtree-workspace](../SKILL.md)

# Your scratch folder

Your working folder is persistent scratch space for drafts, evidence and your own notes. Use the path supplied to your session; imported or renamed agents can retain a stored path rather than one reconstructed from their current name. An agent's scratch is not a private secret store: an authorized ancestor can inspect a descendant's files with [orgtree_read_scratch](../../inspection/tool-read-scratch/SKILL.md). It is also distinct from folders granted for source work.

Keep new standing memories in `AGENTS.md` in that folder. Existing `CLAUDE.md` notes still apply; no automatic rename or migration is needed. The engine accounts for notes loaded natively by the selected harness and mirrors otherwise omitted notes, avoiding duplicate delivery. Engine-mirrored own notes have a 12,000-character cap with a truncation notice; read the file if the delivered copy is cut. Native CLI limits can differ.

Keep standing notes short: stable decisions, important paths, current ownership and where to resume. Put the changing narrative in [breadcrumbs](../breadcrumbs/SKILL.md). Editing startup notes can change the delivered prompt prefix on a later session; a resumed local process does not guarantee provider cache reuse.

## Generated files are not standing notes

Claude launch setup writes `.orgtree-identity.md`, `.orgtree-settings.json` and `.orgtree-mcp.json` into scratch. Leave these engine-generated identity/configuration files alone: the engine writes them again for launch. Use `AGENTS.md` for memories and the authorized configuration route for an actual scope or charter change.

## Opening and sharing

The native desktop's agent menu offers **Open > Open scratch folder** for live and archived agents. It opens an existing directory in the OS file manager; a missing folder reports an error rather than being created. That native action is unavailable in a plain browser or phone client.

Next to it, **Open team scratch folder** opens the team that agent leads,
keyed by its numeric agent id, even when it has no reports. It does not select
the parent's team for a leaf. The switchboard context menu and **Org settings
> Basic** both offer **Open shared scratch folder** for the org-wide `_shared`
folder. Missing team/shared folders are created on demand only inside that
org's scratch root. Personal/imported scratch keeps its no-create behavior.
These entries need scoped support in the native shell and local engine;
older shells do not expose them, and an unsupported engine reports an error.

For collaboration use [shared folders](../shared-folders/SKILL.md), choosing the smallest audience that needs the file. A saved draft is not a delivery to its reader; use the appropriate mail or user-delivery tool when handing it over.

## See also

- [orgtree-breadcrumbs](../breadcrumbs/SKILL.md)
- [orgtree-shared-folders](../shared-folders/SKILL.md)
- [orgtree-tool-read-scratch](../../inspection/tool-read-scratch/SKILL.md)
