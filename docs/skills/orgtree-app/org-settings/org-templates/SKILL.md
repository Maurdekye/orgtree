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
| Scratch AGENTS.md files | No | Copies this org's shared, team/project and personal standing notes into the template file. Include only secret-free text; limits and refusals are below. |

An unticked group takes normal hire defaults when the template is used. Mail,
docket items, transcripts, watchdogs and audiences are never copied. Live agents and projects are saved; a node without a live saved parent becomes top level. Project Summary is included with charters; its slots and peer-mail policy retain the structural configuration. Projects are free and pass funding through to the nearest agent; the saved spare-credit calculation accounts for their descendants.

**Save template** is disabled with a blank name or while busy. An org with no
live agents is refused. A normalized filename collision is refused first and
offers **Replace it**, which overwrites that template file only after the user
chooses it. Filesystem failures remain visible for retry.

Saving can succeed while reporting **This template cannot be used as saved**.
The saver reads up to 200 live agents; template validation permits at most
24 total agent/project nodes and four levels and reports other layout problems. A saved JSON file
is not proof that its model/account choices can run on a different computer.

After saving, the dialog shows filename, agent count and path, with **Download**,
**open templates folder** and **close**. The file is offered under Starting
layout when creating an org. Suggest this for reusing a known team structure;
leave machine-specific groups off for portable layouts.

## Optional standing-notes copies

The save checkbox is off by default. It reads only AGENTS.md from this org's shared scratch, each live node's ID-based team/project folder, and each live agent's stored personal scratch within this org. It never walks arbitrary folders, reads other scratch files or imports another org's notes. Absent files add no field. Linked/reparse paths, non-regular files, invalid UTF-8, NUL, files over 16,000 UTF-8 bytes or more than 128,000 bytes combined refuse the save. Recognizable credential assignments, bearer tokens, private-key headers and common API-token forms are refused; this guard cannot prove arbitrary prose contains no secret. Review text before opting in. The complete template file is capped at 256 KiB; too much included text is refused rather than truncated. A refusal writes no new template file.

Portable template fields are shared_agents_md on the template, plus team_agents_md and scratch_agents_md on an agent slot; a project may carry team_agents_md but has no personal note. Values are UTF-8 text, never filenames. A slot with tier=project represents a container with optional description (Summary), slots (0–9,999,999) and peer_mail; other project policy keeps its defaults. Agent slots may request user or extern audiences explicitly through the usual atomic hire checks; audiences are still not captured from an existing org by Save as template. They grant contact only, not tool/folder rights. Project slots cannot carry model, credit, audience or other agent settings, and cannot be switched into a model through picker overrides.

Creation writes supplied note text into the new org's matching folders after the node transaction commits and before its warm/kickoff effects. It creates missing directories and uses create-new files, never overwriting an existing AGENTS.md. Missing fields add no template note; normal header seeding still applies. The response reports created/existing counts and any copy warnings. If a file write fails, the org remains created and the creation view shows the warning with an Open organization button; inspect its notes before starting work. The preview distinguishes free project rows from agent seats and shows how many AGENTS.md files will be copied. Removing a slot also removes its subtree and its notes from creation; renamed nodes get the correct new personal/team locations.

## Heavy dev shop

This bundled layout mimics the structure of the org used to develop Orgtree itself for significant software projects. It has an Opus/max Liaison over an Opus/max coordinator, with five developers using the Developer preset (Opus/max, Sonnet/high, Astra/xhigh, Sol/high and Argon/high), a Sol/high test-rig engineer and a Sol/high curator under a three-slot build project with peer mail ON. The Liaison owns conversation; the coordinator has an explicit user audience and retains execution and staffing. Nine agent seats cost 32 credits at the bundled catalog rates, plus 20 spare (52 total); the actual preview uses the current offered seats/accounts. No private paths or account names are supplied. Missing models must be replaced or left out before creation; there are no silent cross-provider fallbacks.

Generic operating practices live in shared, development-team, build-project and role-specific personal AGENTS.md files, with short role charters. The template starts in specification/feedback, requires user go-ahead for hardening and leaves the first message off until selected. The coordinator/test-rig engineer establish machine-specific resource floors and output roots before heavy work. See orgtree-dev-team (orgtree-workflows › collaboration-patterns) for the workflow. Existing four small templates stay unchanged; Restore default templates also restores a missing Heavy dev shop file without overwriting local edits.

## See also

- [orgtree-app-charters-and-templates](../../app-settings/app-charters-and-templates/SKILL.md).
- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).

For the roles and workflow behind the bundled layouts, see `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).
