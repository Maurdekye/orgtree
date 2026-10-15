---
name: orgtree-toasts-and-undo
description: Use transient Undo notices and durable organization undo or redo safely.
---

Up: [orgtree-app-shell](../SKILL.md)

# Toasts and undo

Toasts display operation results and errors. They expire after 12 seconds and can be dismissed by clicking the notice. When an Undo callback is offered, it can be consumed once. A transient callback's availability expires with its deadline; a vanished toast does not erase durable organization history.

Outside text editors, Ctrl/Cmd+Z requests undo; Ctrl+Y or Ctrl/Cmd+Shift+Z requests redo. Text fields, selects, contenteditable controls, and supported editors retain their own editing shortcuts. Durable organization history takes priority; otherwise the newest available transient Undo can handle the shortcut. Repeated keys and composition are excluded.

The durable journal retains up to 100 entries per organization for supported explicit user gestures, including moving, hiring, retiring, and retooling agents. New recorded actions clear redo. Agent tool actions, messages, file edits, general organization settings changes, and cheap compaction are not a blanket undoable history.

The specific agent-tool exception is `orgtree_org_logo`: autonomous Logo set
and remove changes are logged and undoable here. Undo/redo restores with a fresh
revision; an intervening independent edit refuses the old entry and keeps the
newer Logo. See `orgtree-tool-org-logo` (orgtree-working › team).

Undoing a hire that has started at least one turn asks for confirmation: it retires the agent and keeps its work/context archived. If further turns change that confirmation's basis, confirmation is requested again. Cancel leaves the hire in place. Conflicting entries can be refused; the same key press does not silently skip to an older action.

The organization History screen is an inspection surface, distinct from the undo/redo journal. Read each result, especially when an intervening change prevents reversal.

## See also

- [orgtree-confirm-dialogs](../confirm-dialogs/SKILL.md)
- [orgtree-org-history](../../org-settings/org-history/SKILL.md)
