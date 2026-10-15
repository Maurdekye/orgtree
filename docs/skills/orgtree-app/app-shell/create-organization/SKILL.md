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

## See also

- [orgtree-app-charters-and-templates](../../app-settings/app-charters-and-templates/SKILL.md)
- [orgtree-org-templates](../../org-settings/org-templates/SKILL.md)
