---
name: orgtree-org-templates
description: Explain Save as template, include choices, replacement and portability limits.
---

Up: [orgtree-org-settings](../SKILL.md)

# Save as template

**Org settings > Basic > Templates > save as template…** opens
`action:save-as-template`. It saves this org's live agent layout into a JSON
file in `~/.orgtree/templates`, independently of the footer Save. It reads the
current stored org, not unsaved edits in the settings panel. Agents suggest
using it; the user saves or replaces templates.

**Template name** starts as `<org name> layout` and must contain letters or
digits after normalization. **Description** is optional, starts empty, and
appears in the creation picker's list. Tree, names and tiers are always included.

| Include choice | Initially checked | Content |
| --- | --- | --- |
| Charters and team charters | Yes | Each live agent's instructions and team instructions. |
| Credits | Yes | Each agent's spare credits. |
| Effort | Yes | Saved agent effort selections. |
| Tool switches, visibility and permission mode | Yes | Saved scope controls. |
| org.md | Yes | Org charter content. |
| Quick chat defaults | Yes | Starting superior, model and effort. A superior absent from the saved live layout becomes top level. |
| Org-wide settings | Yes | Portable settings the org explicitly saved, including grant/default/compaction/resume choices; excludes folders, accounts and hubs. |
| Account binding | No | Preferred accounts and saved per-agent fallback overrides; where an account is unavailable at creation, another runnable account is selected. |
| Folder scopes | No | Machine-specific agent folders, trimmed to folders held by the new org when used. |

An unticked group takes normal hire defaults when the template is used. Mail,
docket items, transcripts, watchdogs and audiences are never copied. Only live
agents are saved; an agent without a live saved parent becomes top level.

**Save template** is disabled with a blank name or while busy. An org with no
live agents is refused. A normalized filename collision is refused first and
offers **Replace it**, which overwrites that template file only after the user
chooses it. Filesystem failures remain visible for retry.

Saving can succeed while reporting **This template cannot be used as saved**.
The saver reads up to 200 live agents; template validation permits at most
24 agents and four levels and reports other layout problems. A saved JSON file
is not proof that its model/account choices can run on a different computer.

After saving, the dialog shows filename, agent count and path, with **Download**,
**open templates folder** and **close**. The file is offered under Starting
layout when creating an org. Suggest this for reusing a known team structure;
leave machine-specific groups off for portable layouts.

## See also

- [orgtree-app-charters-and-templates](../../app-settings/app-charters-and-templates/SKILL.md).
- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).
