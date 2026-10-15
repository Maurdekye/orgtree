---
name: orgtree-app-charters-and-templates
description: Explain bundled charter population, external charter folders and restoring organization templates.
---

Up: [orgtree-app-settings](../SKILL.md)

# Charter documents and organization templates

Runtime contains two different preset systems. Charter documents supply text choices to a hire form; organization templates supply starting layouts for a new organization. Agents explain and suggest these user actions; they do not operate settings themselves.

## Charter documents

**populate missing documents** copies missing bundled charter presets into the user's charter directory, shown by the result and normally `~/.orgtree/charters`. Existing files are left untouched, including edited presets. The result lists created and already-present counts and the directory. A failure leaves a retryable error; a successful count is not proof a particular hire used a preset. **open folder** asks the native opener to show the directory and reports an opener failure separately.

Suggest Populate when bundled charter choices are missing, including after a first-run population failure. It does not reopen onboarding, rewrite every agent's charter, or replace an existing custom file.

## Charter template folders

The ordered external folder list is `rt:charter-template-dirs`, saved through `/api/app-settings/charter-template-dirs` and persisted in app settings as charter_template_dirs. Its initial default is an empty list. Use an absolute folder path with **add** or Enter, choose one through the folder picker, or remove a row. Each operation saves the list immediately; removing an entry leaves the actual folder/files alone. The endpoint trims strings, drops blanks and keeps at most sixteen entries; it does not itself validate that each string is absolute or an existing directory.

Only directly contained, lower-case `.md` paths that pass the filesystem file check are offered; this is not recursive skill discovery. Orgtree reads external folders without creating, editing or copying files there. Same names in several places remain separate choices labelled by source folder. The current backend reports missing, unreadable, not-directory or OK scan status and counts matching paths. It uses ordinary filesystem checks that can follow links; the stronger link-refusal and bounded-listing hints in the UI are not implemented by this scanner. Reading an individual file can fail silently. Successful reads show at most 100,000 characters with a truncation flag, but the file is read before that display limit is applied. A list entry or scan count therefore does not promise usable, bounded-size charter contents.

Suggest an external folder when the user maintains reusable charter text elsewhere. Selecting a preset for a future hire is distinct from granting an agent access to that folder and from installing a skill or global instruction file. Existing agent prompts are not rewritten merely by listing a folder.

## Organization templates

**restore default templates** writes back missing built-in organization templates in the user's templates directory, normally `~/.orgtree/templates`, including defaults the user deleted. Existing files are not replaced. The result distinguishes restored and already-present templates. **open folder** uses the native opener and has its own failure state.

Suggest Restore when the built-in starting layouts are missing. It does not create an organization, staff any agent, or overwrite an existing customized layout. Saving an existing organization as a template belongs to [orgtree-org-templates](../../org-settings/org-templates/SKILL.md); applying one belongs to [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).

## See also

- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).
- [orgtree-org-templates](../../org-settings/org-templates/SKILL.md).
