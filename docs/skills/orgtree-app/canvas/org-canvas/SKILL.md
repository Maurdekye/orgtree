---
name: orgtree-org-canvas
description: Navigate the organization canvas and distinguish camera gestures from structural drag actions.
---
Up: [orgtree-canvas](../SKILL.md)

# The organization canvas

The canvas lays out the user root, agent reporting lines and related objects. It is a navigable projection of the org, not a free-positioning editor: changing the camera does not change who reports to whom. Use the agent list or a named jump when a card is outside the current view.

Drag the background with the primary button to pan. Middle-button drag pans from anywhere on the visible canvas, including a desk's header, transcript or composer, presentation cards, the org inbox tile and pinned frames. It moves the canvas camera, leaving the desk's scroll and a pinned frame's placement unchanged. It does not open a link or select text; left and right buttons keep their usual actions. A popped-out desk has no canvas to pan.

The wheel over canvas space zooms about the cursor; over a modal, desk, agent tray or pinned window it stays a scrolling gesture. Move the pointer out of the desk before trying to zoom the canvas. Touch navigation uses pan and two-pointer pinch rather than desktop reparent dragging.

The bottom-left HUD offers switchboard, full view, zoom in and zoom out. Off-screen neighbor chips jump to their agents; a hidden retiree is revealed when navigated to. Far zoom uses reduced locator cards rather than shrinking every desk control into an interactive target. The current layout and appearance choices are in [Display: desk and chart](../../app-settings/app-display-desk-and-chart/SKILL.md).

## Structural gestures

On desktop, drag an agent's card body to move its subtree; buttons, fields, the credit bar and desk content keep their own interactions. The moving group includes descendant cards and their watchdog satellites. Near an edge the camera can pan to expose a distant destination. Escape or pointer cancellation abandons the drag without committing its structural operation.

A valid drop on another live parent reparents the agent; a drop on the user root promotes it to top level through the human UI. Dropping among its current siblings uses the row/ring insertion preview for reordering. The engine still validates the operation; an optimistic landing can return on refusal. Do not describe an animation alone as a committed move. For exact tool-side authority/accounting, see `orgtree-tool-move` (orgtree-working › team) and `orgtree-tool-reorder` (orgtree-working › team).

Dropping on the org inbox tile is a different action: it grants that agent the org-inbox audience rather than reparenting it. Read [org inbox tile](../org-inbox-tile/SKILL.md) before suggesting this gesture. A toast may offer undo; the broader contract is [toasts and undo](../../app-shell/toasts-and-undo/SKILL.md).

Inspect the resulting parent/order and any error toast. A canvas gesture belongs to the human interface and does not give an agent permission to perform an equivalent action outside its tool scope.

## See also

- [orgtree-agent-card](../agent-card/SKILL.md)
- [orgtree-app-display-desk-and-chart](../../app-settings/app-display-desk-and-chart/SKILL.md)
