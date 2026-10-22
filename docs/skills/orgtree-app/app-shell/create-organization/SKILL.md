---
name: orgtree-create-organization
description: Understand the organization creation form, layouts, templates, and cancellation.
---

Up: [orgtree-app-shell](../SKILL.md)

# Create organization

Enter a name and choose Empty or a saved starting layout. Create requires a nonempty trimmed name; a selected template must finish loading and pass its plan checks. A failed request leaves the form available to correct and retry.

Advanced options contain initial folder grants, automatic connection to the local mail hub, and remote hub addresses. The local-hub option starts checked. Its detection hint reports current availability; the hub can connect later. Folder fields use the [folder picker](../folder-picker/SKILL.md).

The template picker offers Open templates folder and Reload. Invalid templates cannot be selected. Valid templates whose models are unavailable are dimmed and grouped, but remain selectable so their preview can be repaired. Expand the preview to inspect or change agent names, tiers, accounts, charters, seats, grants, and the top-level grant. Non-root entries can be omitted and restored. The preview also indicates an organization instruction file supplied by the template.

For a template coordinator, Send coordinator its first message now controls the initial kickoff. Leaving it off creates the organization without that message. The new-organization guide starts at hiring for Empty, or at the first-message step when the template already hired agents.

Changing the name, folders, remote addresses, local-hub choice, or layout makes the form dirty. Closing then uses the native discard confirmation. Cancel returns a reused homepage to the homepage and closes a separately opened creation window. This is an unsaved form, not a durable draft after a crash.

A template may include free project containers and optional shared/team/personal AGENTS.md copies. Project rows have no model selector or seat cost; the preview counts them separately. If copying a note fails after the org is committed, creation reports that the org exists and shows a warning plus Open organization, rather than encouraging a duplicate create. Inspect the notes before work. The field limits and Heavy dev shop layout are documented in [orgtree-org-templates](../../org-settings/org-templates/SKILL.md).

## See also

- [orgtree-app-charters-and-templates](../../app-settings/app-charters-and-templates/SKILL.md)
- [orgtree-org-templates](../../org-settings/org-templates/SKILL.md)

For the roles and workflow behind the bundled layouts, see `orgtree-dev-team` (orgtree-workflows › collaboration-patterns).

Deep templates retain every node, with no node-count or tree-depth limit and a 16 MiB file bound. The preview pages 100 rows at a time; visual indentation is bounded and deeper rows show their actual level/parent. Saved fast mode and explicit OpenRouter harness pins appear in the preview. Unsupported fast mode or an unavailable pin blocks Create until corrected using the speed/harness controls or a different model. Project queue and event policy is restored through the normal project configuration checks. See [organization templates](../../org-settings/org-templates/SKILL.md).
