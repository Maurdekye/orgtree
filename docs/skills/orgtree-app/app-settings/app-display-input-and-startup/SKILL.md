---
name: orgtree-app-display-input-and-startup
description: Explain quick chat placement, Enter behavior and which windows or canvas view open at startup.
---

Up: [orgtree-app-settings](../SKILL.md)

# Input and startup display

These Display controls describe how the user interacts with the app. Agents explain and suggest settings; they do not change them themselves. Each control saves on selection without an organization Save, and none changes an agent's instructions or inference account.

| Control | Storage | Default | Choices and effect |
| --- | --- | --- | --- |
| Quick chat position | `ls:orgtree-quickchat-position` | top | Top centers it in the header; Bottom in the footer strip; None hides it everywhere, leaving Attention without its new-chat box. |
| Enter key | `rt:enter_key_behavior`, app runtime settings | send | Send message uses Enter or Ctrl/Command+Enter to send, Shift+Enter for a newline. Insert new line uses Enter for a newline and Ctrl/Command+Enter to send. |
| on startup | `np:startupMode`, native preferences | restore | Restore previous windows in saved positions, or open a fresh homepage. This control is absent when the shell cannot provide multi-window startup. |
| open an org at | `ls:orgtree-start-view` | org | The full org fitted to the window, the switchboard, or where I left off. |
| play the starting zoom | `ls:orgtree-start-zoom` | On | Animates the initial view; disabled for where I left off because a restored camera does not glide. A brand-new org with no saved camera plays the starting zoom once. |

Quick chat placement and canvas-view choices are browser-local preferences. Native startupMode governs desktop windows; it is different from Run on startup, which controls whether Orgtree starts automatically at all. A canvas destination is not an engine start mode. See [desktop startup](../app-runtime-desktop/SKILL.md).

The Enter setting is app-wide and is reflected in the read-only shortcut reference. The special quick-chat hire composer retains its own Enter-to-hire/Shift+Enter behavior; use its screen leaf for that workflow. A message-history arrow shortcut also depends on the caret position, not just the Enter preference.

Suggest None only when the user wants to remove quick chat and understands the Attention consequence. Suggest Insert new line for multi-line composition without accidental sends, or restore/homepage according to the desired launch arrangement. A saved startup choice does not immediately close, move or recreate existing windows.

## See also

- [orgtree-quick-chat](../../app-shell/quick-chat/SKILL.md).
- [orgtree-app-runtime-desktop](../app-runtime-desktop/SKILL.md).
- [orgtree-app-keyboard-shortcuts](../app-keyboard-shortcuts/SKILL.md).
