---
name: orgtree-app-charters-and-templates
description: Explain bundled charter population, external charter folders and restoring organization templates.
---

Up: [orgtree-app-settings](../SKILL.md)

# Charter documents and organization templates

Runtime contains two different preset systems. Charter documents supply text choices to a hire form; organization templates supply starting layouts for a new organization. Agents explain and suggest these user actions; they do not operate settings themselves.

## Charter documents

The seven built-in choices are business, coordinator, curator, developer, implementer, liaison and redteam. Their introductions describe the role and expected capabilities, and are part of the actual charter: the hire form inserts the whole selected file, including its heading and separator, before any manual text. No copying into the charter box is needed. Selecting a preset supplies text only; it does not change the chosen placement, tier, tools or audiences.

**Developer** is a complete standalone charter for implementation and assigned peer review in any org. It covers private worktrees, red-first focused tests, exact-SHA hand-ins with measured/inferred evidence and limits, docs/glossary upkeep, peer coordination, author-owned fixes and done/blocked reporting. Reviews follow the current phase and waivers; the role starts no review or release on its own. Heavy dev shop uses it for all eleven developer seats and keeps development-role rules out of lower notes; universal shared reporting policy remains for the other roles. Implementer and Redteam remain separate choices for the smaller role-separated layout.

**liaison** is intended for a large org with dozens or more workers: insert it above the existing coordinator, directly under the user. It handles discussion, options, durable user decisions and briefs; the coordinator remains its single report and owns execution and staffing. Keep tool capabilities available through the new superior so the coordinator retains them, while the liaison's charter limits its own work. User contact and any separate org-inbox audience follow their ordinary rules. See orgtree-charters (orgtree-working › team) for the role and tool-based insertion.

**Populate missing documents** copies missing bundled charter presets into the user's charter directory, shown by the result and normally `~/.orgtree/charters`. Existing files are left untouched, including edited presets. The result lists created and already-present counts and the directory. A failure leaves a retryable error; a successful count is not proof a particular hire used a preset. **open folder** asks the native opener to show the directory and reports an opener failure separately.

Suggest Populate when bundled charter choices are missing, including after a first-run population failure. It does not reopen onboarding, rewrite every agent's charter, or replace an existing custom file. A same-named file in the user directory shadows the bundled version, so an existing local copy can retain an older introduction; Populate deliberately leaves it alone. Changes to bundled text apply when that bundled choice is used for a new hire, not retroactively to live agents.

## Charter template folders

The ordered external folder list is `rt:charter-template-dirs`, saved through `/api/app-settings/charter-template-dirs` and persisted in app settings as charter_template_dirs. Its initial default is an empty list. Use an absolute folder path with **add** or Enter, choose one through the folder picker, or remove a row. Each operation saves the list immediately; removing an entry leaves the actual folder/files alone. The endpoint trims strings, drops blanks and keeps at most sixteen entries; it does not itself validate that each string is absolute or an existing directory.

Only directly contained `.md` files (suffix case-insensitive) are candidates; subfolders are not searched. Orgtree reads external folders without creating, editing or copying files there. Same names in several places remain separate choices labelled by source folder. The scanner refuses a folder or ancestor that is a link, junction, reparse point or cloud placeholder; offline/recall attributes are checked before opening. Relative paths and paths containing `..` report `invalid_path`. A missing, unreadable or non-directory folder reports its own status without hiding other folders or bundled choices.

Each scan examines at most 500 matching entries per folder, including rejected ones, and reports `listing_truncated` when more remain. It checks a 1,000,000-byte file bound before opening contents, rechecks the opened regular file and reads at most one byte beyond the bound to detect growth. Links/placeholders, non-files, oversize and unreadable/invalid-UTF-8 files appear in separate skip lists. The settings scan lists names/paths without reading bodies; a later content read can therefore report a new failure. Successful content reads retain the 100,000-character display bound, original character count and truncation flag. These checks also cover user-preset discovery and direct preset lookup; an unreadable/refused user copy does not shadow a usable bundled preset. They do not cap text entered directly into an agent charter. Skill bundles use their own separate scanner and limits.

Suggest an external folder when the user maintains reusable charter text elsewhere. Selecting a preset for a future hire is distinct from granting an agent access to that folder and from installing a skill or global instruction file. Existing agent prompts are not rewritten merely by listing a folder.

## Organization templates

**Restore default templates** writes back missing built-in organization templates in the user's templates directory, normally `~/.orgtree/templates`, including defaults the user deleted. Existing files are not replaced. The result distinguishes restored and already-present templates. **open folder** uses the native opener and has its own failure state.

The built-ins include the four small devteam layouts and Heavy dev shop, a larger mixed-model layout with a Liaison, coordinator, eleven developers, test-rig engineer, curator and three-slot project. It mimics the org used to develop Orgtree itself. Its generic practices are supplied as shared/team/project/personal AGENTS.md text; its coordinator explicitly holds a user audience. The creation preview shows actual availability, grants and free project rows; it does not authorize execution. Optional note-copy limits and save behavior belong to [orgtree-org-templates](../../org-settings/org-templates/SKILL.md).

Suggest Restore when the built-in starting layouts are missing. It does not create an organization, staff any agent, or overwrite an existing customized layout. Saving an existing organization as a template belongs to [orgtree-org-templates](../../org-settings/org-templates/SKILL.md); applying one belongs to [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).

## See also

- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).
- [orgtree-org-templates](../../org-settings/org-templates/SKILL.md).
