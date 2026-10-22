---
name: orgtree-tray-and-windows
description: Locate tray actions, organization and auxiliary windows, and native dialogs.
---

Up: [orgtree-app-shell](../SKILL.md)

# Tray and windows

Clicking the tray icon toggles its organization activity list. It is ordered by most recently opened org, remembered across restarts. At most ten org rows fit before the list scrolls; scrolling reaches the rest. Activity/attention and active/hired counts update independently of this ordering. Double-clicking when no window is visible opens the last-used organization or homepage. Right-click opens the native tray menu.

On Windows, right-clicking the **taskbar** icon offers **Home**, **New org** and the current organizations. Home opens a homepage window; New org opens the organization creation view. An org entry focuses that org's existing window or opens its own window. Entries follow the org switcher's slug order, exclude trashed orgs and update when organizations are added, removed or renamed. They also work when the app is closed or still starting: a launch hands its destination to the single running app. Windows controls the taskbar menu's layout and available space.

While running, organizations are grouped into their own taskbar identities using the org Logo when set. Attention-seeking unread mail, questions and docket flags drive their badge/dot and menu destinations; ordinary notice traffic does not demand attention by itself. Clicking an attention item opens its exact mail, question or docket destination, and transcript mentions open the mentioning Chat passage. A menu entry can outlive its source, so activation rechecks the current record. Notification switches control banners separately from explicit taskbar navigation.

| Menu entry | Action |
|---|---|
| Update status / Update now | Shows progress or applies a downloaded update when offered |
| Automatic updates / Check for updates | Controls or requests updates; unsupported development builds show a disabled explanation |
| Mail hub status | Shows running/stopped/error state and opens the hub in the browser when available |
| Connect your phone | Opens the phone panel in the last-used window, creating a homepage if needed |
| Run on boot ("Run on sign-in" where Orgtree cannot start at boot) | Changes the native startup preference; a pending change disables the checkbox |
| Run as admin | Same protected administrator setting as App settings: ON shows the full-admin warning then one Windows permission prompt; OFF asks permission once. Disabled while unavailable or changing; cancellation restores the saved checkmark. Applies at once: the engine restarts, and the sign-in helper follows with the same rights. |
| Exit on close | Changes the native last-window-close preference |
| Notifications | Master checkbox and per-event notification switches; subordinate switches are disabled when the master is off |
| Harness setup | Detected harness status and the corresponding installation destinations |
| Crash reports | Opens the local crash-report location |
| Restart engine / Start engine | Explicit engine restart, always in Session 0 through the boot task on an all-users install; the sign-in helper attaches to the new engine within seconds. Reads Start engine while the engine is stopped or unavailable. Visible even when unavailable, disabled during conflicting shutdown/restart activity |
| Quit Orgtree | Requests application shutdown |

For individual notification switches see [App notifications](../../app-settings/app-notifications/SKILL.md); startup and close semantics belong to the settings references below. A restart click is not a success receipt: the menu follows engine readiness and reports failure separately.

Each organization has one main window; opening it again focuses that window. Popouts are separate native windows whose controls apply to themselves. Pop in returns a panel to its owner; closing a panel window dismisses that surface. Closing a window and Quit Orgtree have different scope, governed by Exit on close and engine ownership.

Auxiliary artifact/mockup viewers display the supplied document in an isolated window without the normal app bridge or chrome. Startup data conversion can display a small progress window that closes when conversion finishes. Neither is a replacement organization window.

Native text context menus offer Cut/Copy/Paste/Select all according to the selected editable field; read-only selection offers Copy. Native discard, startup, update, and restart dialogs apply to their named action and window. Read their actual error or scope instead of treating every native prompt as the same confirmation.

## See also

- [orgtree-app-runtime-desktop](../../app-settings/app-runtime-desktop/SKILL.md)
- [orgtree-phone-link](../../mailhub/phone-link/SKILL.md)
