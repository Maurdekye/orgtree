---
name: orgtree-crash-and-restart
description: Recognize renderer crashes, backend restart notices, and the browser freeze log.
---

Up: [orgtree-app-shell](../SKILL.md)

# Crashes and restarts

A renderer exception can replace the app with Orgtree hit a problem and had to stop, its error message, and Reload. Native window controls remain available. The crash reporter attempts to retain the report locally and submit it to the local engine; the screen's appearance alone does not prove successful delivery. Reload retries the renderer and can discard unsaved form state.

After a backend restart, a notice offers Reload now and, when deferral is available, Keep working. Editable popouts or an existing deferred notice hold automatic reload so unsaved work can be considered. Other windows can reload automatically. Keeping work open does not prove that an interrupted operation completed; inspect its current state before repeating a write.

The `/debug/freezes` page is a separate diagnostic view of locally recorded browser observations. It shows frame gaps, long tasks, visibility/lifecycle events, tab identities, and optional heap readings, newest first. It reads the current browser profile's stored log; it does not run its own sampling loop. Refresh rereads, Copy JSON exports, and Clear removes those local records. Retention is bounded to 200 entries per tab, ten tabs, and seven days. A frame-gap record begins at 250 ms.

These UI stalls differ from an agent frozen by provider usage limits. For agent lifecycle handling see `orgtree-halts-and-restarts` (orgtree-working › runtime). The [tray and windows](../tray-and-windows/SKILL.md) page locates the explicit engine restart action and local crash reports.

## See also

- [orgtree-app-developer](../../app-settings/app-developer/SKILL.md)
