---
name: orgtree-agent-folders-tab
description: Explain folder grants, read/write modes, revocation and the desktop save's whole-list behavior.
---

Up: [orgtree-agent-settings](../SKILL.md)

# Folders

The Scope tab's **Folders** list controls `node:add_dirs` in the selected agent's configured scope. It starts from that agent's configured list, falling back to the supplied scope. Agents explain and suggest grants; they do not change settings themselves.

| Control | Effect on the draft |
|---|---|
| RW / RO | Toggle a listed folder between writable and read-only. |
| revoke (×) | Remove that folder entry. |
| grant a folder the parent/org holds | Add an unlisted folder with the holder's current mode. Top-level agents use org holdings; other agents use their superior's folders. |
| Add a folder path + add | Trim and add a nonempty typed path as RW. Available at every tree depth. |
| browse for a folder | Open the shared folder picker and add the returned path as RW. |

These edits wait for the shared Save. Merely typing a path without adding it does not add a grant. New picker/typed entries begin RW, so choose RO before Save when read-only access is intended.

An edited list is sent in full: the desktop `add_dirs` save **replaces this agent's configured folder list**. This differs from the additive agent retool tool. Omitted, unedited folders are not resent by the form. Do not describe this user control as an incremental add operation at the API boundary.

The effective folder set is bounded by the ancestors and org holdings. A user save can grant a new path at any depth: actual additions or RW upgrades can expand org holdings, and the ancestor chain is raised to carry the grant. The form previews ancestor increases; the engine's returned cascade is authoritative. Revoking or downgrading a parent's grant restricts what descendants can effectively use, even where a broader configured grant remains stored. Folder removal here is not deletion of files on disk.

Folder access also depends on the edit tool and permission mode, plus the harness's enforcement. A RW entry alone does not make a read-only seat writable. Scratch, org-shared and team workspace access are handled separately by the runtime; see `orgtree-scope-and-permissions` (orgtree-working › team) for the effective grant rules. The picker itself is covered by [orgtree-folder-picker](../../app-shell/folder-picker/SKILL.md).

Suggest a narrowly scoped path and mode when a task needs files outside the current grant. Explain both ancestor expansion and descendant loss before recommending a broad change. The save reconfigures affected processes and changes their startup scope; see [orgtree-agent-config](../agent-config/SKILL.md) for timing/cache consequences.

## See also

- `orgtree-scope-and-permissions` (orgtree-working › team).
- [orgtree-folder-picker](../../app-shell/folder-picker/SKILL.md).
- [orgtree-agent-visibility-access](../agent-visibility-access/SKILL.md).
