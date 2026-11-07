---
name: orgtree-org-mailbox-tile
description: Read the canvas org-mailbox tile and recognize its viewer, connectivity indicator and audience-drop action.
---
Up: [orgtree-canvas](../SKILL.md)

# The org mailbox tile

This globe-marked tile represents outside mail addressed to the organization. It is separate from the user's inbox and individual agent mailboxes. The canvas shows it only when org mailbox is enabled and the engine marks it visible; outside-mail/inbox-audience activity can make it relevant. Its placement stays clear of the reporting tree rather than making it an agent node.

Click opens the org-mailbox viewer or raises an already pinned viewer. At far zoom it becomes a globe locator. At normal zoom its last-correspondent line indicates incoming/outgoing direction, or no mail yet. It deliberately has no unread-count demand for the user: agents answer the organization's mail. The full viewer is [inbox screens](../../desk/inbox-screens/SKILL.md).

The hub dot summarizes enabled, non-hidden connections: all connected, some connected or none connected use distinct styles. Hover for each hub's name/address and connected version, error or connecting state. It is connection evidence, not proof that a particular recipient has read a message. See [org connections](../../mailhub/org-connections/SKILL.md) for configuration.

The org's first outside mail also sparks: the tile appears just after that mail arrives, so the spark waits for the tile and then plays along the line between it and the other end. Later mail sparks at once, as described under mail sparks in [the organization canvas](../org-canvas/SKILL.md#mail-sparks).

On desktop, dropping an agent on this tile grants the org-mailbox audience; it does not change the agent's parent. The action can be refused by policy and reports an error. For routing, holder selection and outside-sender authority see `orgtree-org-mailbox` (orgtree-working › mail) and `orgtree-external-mail` (orgtree-working › mail). Hiding/disabling the tile is not a way to clear an agent's individual pending mail.

## See also

- [orgtree-inbox-screens](../../desk/inbox-screens/SKILL.md)
- `orgtree-org-mailbox` (orgtree-working › mail)
