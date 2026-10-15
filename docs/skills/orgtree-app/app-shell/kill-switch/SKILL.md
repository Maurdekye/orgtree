---
name: orgtree-kill-switch
description: Arm, engage, and release STOP ALL while understanding the organization latch.
---

Up: [orgtree-app-shell](../SKILL.md)

# STOP ALL

Open the guard to arm STOP ALL. The button becomes usable after half a second, and the guard automatically closes after five seconds. Closing it cancels arming. F10 arms the control; Shift+F10 requests the halt directly. F10 never releases an existing halt.

Pressing STOP ALL persists an organization-wide latch, requests interruption of currently busy agent turns, and pauses armed watchdogs. New agent turns cannot start while the latch is set. This is an organization gate rather than a rewrite of every agent's individual halt flag.

When latched, the control reads HALTED — RELEASE. Release clears the organization latch. It does not clear individual agent halts, resume paused watchdogs, or itself give agents a new task. Inspect the remaining holds and explicitly resume the watchers that should continue.

Treat the operation result as the evidence of what was requested; stopping a turn does not reverse an external command or change already made by that turn.

## See also

- `orgtree-halts-and-restarts` (orgtree-working › runtime)
