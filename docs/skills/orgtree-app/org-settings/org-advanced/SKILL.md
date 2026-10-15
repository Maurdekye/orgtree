---
name: orgtree-org-advanced
description: Explain the legacy new-org advanced modal and its General and Mail hub fields.
---

Up: [orgtree-org-settings](../SKILL.md)

# Advanced organization form

`screen:advanced-org` is the **advanced…** modal used by the legacy inline
**New organization** form, including its onboarding use. It is not a second
settings panel inside the current Org settings modal. For the main creation
screen see [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).
Agents explain this form; the user chooses the creation values.

The modal title uses the typed org name, or **new organization**, followed by
**advanced**. It opens on the first tab and has two tabs:

| Tab | Fields | Initial value |
| --- | --- | --- |
| General | **also grant existing folders**, using editable path rows, folder browsing, add and remove controls | No extra folders. |
| Mail hub | **connect to this computer's mail hub** | On. |
| Mail hub | **remote mail hubs**, with editable address rows, remove buttons and **+ add a remote mail hub address** | No remote addresses; adding a row starts it empty. |

Opening advanced probes the local hub and reports checking, detected hub name,
or **not running right now — the org will connect when it starts**. Detection
is information, not a prerequisite for leaving local connection enabled.
Remote rows accept addresses (placeholder `http://host:7370`); names are
discovered on connection. The parent form trims paths/addresses and omits empty
rows when it submits creation.

**done** closes this modal and returns to the inline form; it does not create
or save an org. Tab changes and done preserve the values held by the parent
form. The parent creation action sends them with the new org. The advanced
button's summary shows extra-folder count and whether a hub is configured.
For established-org hub identity, secrets, connection status and enable/remove
actions, use [orgtree-org-connections](../../mailhub/org-connections/SKILL.md).

Suggest opening this disclosure when someone using the inline creation form
needs initial folder grants or local/remote hub choices. Explain that listing
the org on a hub permits peers to mail it and thereby start its agents; local
connection defaults on even while the local hub is unavailable.

## See also

- [orgtree-create-organization](../../app-shell/create-organization/SKILL.md).
- [orgtree-org-connections](../../mailhub/org-connections/SKILL.md).
