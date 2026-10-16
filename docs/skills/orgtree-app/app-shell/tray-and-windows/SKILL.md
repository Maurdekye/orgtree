---
name: orgtree-tray-and-windows
description: Locate tray actions, organization and auxiliary windows, and native dialogs.
---

Up: [orgtree-app-shell](../SKILL.md)

# Tray and windows

Clicking the tray icon toggles its organization activity list. Double-clicking when no window is visible opens the last-used organization or homepage. Right-click opens the native tray menu.

| Menu entry | Action |
|---|---|
| Update status / Update now | Shows progress or applies a downloaded update when offered |
| Automatic updates / Check for updates | Controls or requests updates; unsupported development builds show a disabled explanation |
| Mail hub status | Shows running/stopped/error state and opens the hub in the browser when available |
| Connect your phone | Opens the phone panel in the last-used window, creating a homepage if needed |
| Run on boot ("Run on sign-in" where Orgtree cannot start at boot) | Changes the native startup preference; a pending change disables the checkbox |
| Exit on close | Changes the native last-window-close preference |
| Notifications | Master checkbox and per-event notification switches; subordinate switches are disabled when the master is off |
| Harness setup | Detected harness status and the corresponding installation destinations |
| Crash reports | Opens the local crash-report location |
| Restart engine | Explicit engine restart; visible even when unavailable, disabled during conflicting shutdown/restart activity |
| Quit Orgtree | Requests application shutdown |

For individual notification switches see [App notifications](../../app-settings/app-notifications/SKILL.md); startup and close semantics belong to the settings references below. A restart click is not a success receipt: the menu follows engine readiness and reports failure separately.

Each organization has one main window; opening it again focuses that window. Popouts are separate native windows whose controls apply to themselves. Pop in returns a panel to its owner; closing a panel window dismisses that surface. Closing a window and Quit Orgtree have different scope, governed by Exit on close and engine ownership.

Auxiliary artifact/mockup viewers display the supplied document in an isolated window without the normal app bridge or chrome. Startup data conversion can display a small progress window that closes when conversion finishes. Neither is a replacement organization window.

Native text context menus offer Cut/Copy/Paste/Select all according to the selected editable field; read-only selection offers Copy. Native discard, startup, update, and restart dialogs apply to their named action and window. Read their actual error or scope instead of treating every native prompt as the same confirmation.

## See also

- [orgtree-app-runtime-desktop](../../app-settings/app-runtime-desktop/SKILL.md)
- [orgtree-phone-link](../../mailhub/phone-link/SKILL.md)
