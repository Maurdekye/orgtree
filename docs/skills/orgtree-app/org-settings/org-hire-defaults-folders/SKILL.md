---
name: orgtree-org-hire-defaults-folders
description: Explain org folder holdings, revocation effects and the dissolve-all action.
---

Up: [orgtree-org-settings](../SKILL.md)

# Hire-default folders and agent actions

**Org settings > Hire defaults > Org folders** edits `org:org_dirs`: the
folders this org's agents can use. The subtitle says, “Folders this org's
agents can use. New hires get all of them by default.” Agents explain these
controls; the user changes holdings. Folder edits use the shared footer Save
described in [orgtree-org-basic](../org-basic/SKILL.md).

The engine's extra-folder default is an empty list, before app defaults or
org-specific holdings. The org workspace is shown separately, permanently RW;
this list cannot remove it. **Add a folder path** plus **add**, or the folder
browser, appends an RW holding. Each extra row has an RW/RO toggle and remove
button. Nonexistent paths are accepted with a warning that agents cannot use
them until they exist. Malformed folder entries are refused.

Additions and RO-to-RW upgrades affect future hires; they do not restore or
expand an existing agent's explicit grant. Removing a holding revokes matching
top-level grants. RW-to-RO downgrades them; descendants' effective permissions
follow the parent chain. Revocations/downward changes are not restored by
adding the holding back later. The response warns about affected grants.
Saving edited holdings reconfigures org processes before subsequent turns.

Suggest adding a holding when the user wants future agents to work in that
folder, or RO access when they only need reference material. Explain the
existing-grant consequences before suggesting removal or downgrade. The full
scope and folder authority rules live in `orgtree-scope-and-permissions`
(orgtree-working › team).

## Dissolve all agents

The same tab's **Agent actions > dissolve all agents** is `action:retire-all`.
It opens **dissolve ALL agents?** and acts only after **dissolve all** is chosen;
cancelling closes the confirmation. It retires the organization's agents,
keeps context for rehire, reports the number and freed credits, and closes the
settings panel on success. It acts independently of the footer Save.
The engine dissolves one top-level subtree per operation; an error partway
through can leave earlier subtrees already retired. Inspect the chart before
retrying rather than assuming the entire org action rolled back.

Suggest this only when the user wants the whole organization retired while
retaining its agents' context. For retirement/rehire semantics see
`orgtree-team-shape` (orgtree-working › team).

## See also

- `orgtree-scope-and-permissions` (orgtree-working › team).
- [orgtree-org-basic](../org-basic/SKILL.md).
