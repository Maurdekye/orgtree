---
name: orgtree-agent-config
description: Explain agent settings saves, renaming, action buttons and confirmations.
---

Up: [orgtree-agent-settings](../SKILL.md)

# The agent settings window

This is `screen:agent-settings`; the Name action is `node:rename`. Agents explain these user controls and suggest changes; they do not operate settings themselves.

The window starts on Charter and has Model, Scope and Tools tabs. Switching tabs preserves draft edits. Unedited fields follow updated agent data; a field already edited keeps its local draft. The form reads configured scope when available, which can differ from the effective scope the running agent receives.

## Save and Cancel

The shared **save** button submits edits from all four tabs. It sends a model switch if the tier changed, otherwise an account assignment if the account changed, followed by the scope/settings save. The scope body includes instructions, team instructions, effort, the fresh-start override and a valid selected model version. Folders, tools, visibility and file/command access are included only when edited; the fallback override is included only when edited.

With undo history available, these steps form one settings gesture. The compatibility path performs them sequentially, so an earlier step can have succeeded if a later step fails. Read the returned error and current state before recommending a retry. Warnings appear in a toast; success closes the window. Model/account changes may be queued; see their leaves for timing.

**cancel** closes the form without applying its remaining draft fields. It does not undo an action already taken through Rename, Agent actions, Cancel change or the credit slider. Those controls have their own submission paths.

Saving a provider change, or any model change while the agent is busy, first opens a confirmation. Cancelling that confirmation submits none of the form. The confirmation describes a queued switch for a busy agent. Current Rust provider-switch behavior is described in [Model](../agent-model-tab/SKILL.md); the confirmation's legacy knowledge-bearer/lineage wording is not a promise that such a UI flow exists.

Scope saves mark affected processes for reconfiguration. An idle process is replaced; a running turn completes before replacement. Because the shared form sends fields beyond effort, it is not the effort-only control path even when effort is the only visible edit. Changing startup instructions or capability definitions changes the prompt prefix and can cost cached input reuse; a process replacement alone does not prove a provider cache miss.

## Name and Agent actions

**Name** has its own **rename** button, shown only after the text differs. It submits and closes the window independently of Save. Names are trimmed, leading `@` characters removed, and must be 1–64 ASCII letters/digits/`-`/`_`/`.` beginning with a letter or digit. `user`, `system`, `engine`, `org` and `net` are reserved, ignoring case; an existing nondeleted agent name is refused. Legacy bearer cards hide Rename.

Renaming updates the agent's name and name-based audience/request and activity-watchdog references. The stored scratch path remains authoritative. The UI hint says the folder and mailbox move, but the current rename handler does not move the scratch directory; do not instruct the user to look for a newly named folder on that basis.

The action row depends on the agent's state:

| Control | Availability and purpose |
|---|---|
| rescind | Live agent; confirms retirement of the subtree and reclaiming its stake from the superior's grant where there is one. |
| retire | Live agent without a nonarchived child in the displayed tree; confirms retirement. |
| dissolve subtree | Live agent with a nonarchived child in the displayed tree; confirms retirement of the subtree. |
| rehire (context intact) | Archived agent; submits rehire directly. |
| delete permanently | Opens a destructive confirmation before submitting deletion. |

The retirement buttons display seat plus grant. Read `orgtree-team-shape` and its lifecycle tools (orgtree-working › team) for what retirement, restoration and deletion retain, release or refuse. These are actions rather than defaults, and should be suggested for an intended lifecycle change, not to save a tab edit.

Permanent deletion's confirmation includes the descendant and prior-generation counts. With a foreground tree, it first reads the full deletion scope; **Loading full deletion scope…** offers Cancel, and a failed read offers Cancel and Retry. A changed/missing agent requires closing and reopening the dialog. The final confirmation warns that deletion cannot be undone and that session transcripts remain on disk; do not describe it as erasing every local conversation file.

## See also

- `orgtree-team-shape` (orgtree-working › team).
- [orgtree-agent-model-tab](../agent-model-tab/SKILL.md).
- [orgtree-agent-credit-grant](../agent-credit-grant/SKILL.md).
