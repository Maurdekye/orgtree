---
name: orgtree-mobile-layout
description: Find agent controls and hiring in the narrow layout and recognize the legacy drawer.
---

Up: [orgtree-app-shell](../SKILL.md)

# Narrow layout

The current Rust app keeps the desktop canvas and desk layout at narrow widths. Its dedicated mobile/compact mode and agent-sheet gate are disabled; shrinking the window does not enable a phone-style agent sheet or hire sheet.

Use the ordinary canvas hire drafts, desk tabs, application menu and window controls. Individual panels still adapt to their available width: mailbox and presentation modals collapse the list into an overlay at 896 CSS pixels of reading-area width, and Quick chat folds its options into a dropdown. Pinned and separate windows measure their own width.

Older renderer code includes mobile sheet and drawer presentations, but those are not a currently enabled navigation route. Use the [header and application menu](../org-header-and-menu/SKILL.md) for organizations, settings and usage.

The agent desk's tabs and lifecycle actions retain their normal meanings; use its detailed reference for those controls rather than inferring different permissions from the smaller layout.

## See also

- [orgtree-agent-desk](../../desk/agent-desk/SKILL.md)
