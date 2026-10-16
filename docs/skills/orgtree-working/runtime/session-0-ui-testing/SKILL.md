---
name: orgtree-session-0-ui-testing
description: Session 0's missing desktop and workable UI-test patterns for agents.
---

Up: [orgtree-runtime](../SKILL.md)

# Session 0 and UI testing

In Windows Session 0 there is no interactive desktop. An agent process may run there, but it cannot see or drive the user's desktop: tray popups are refused, UI Automation and `EnumWindows` see no user windows, `GetCursorPos` fails with 1459, `SendInput` sends zero, and click-to-visible timings are meaningless. A visible GUI launch from Session 0 does not prove the user's desktop UI works.

## Check before UI work

Check `(Get-Process -Id $PID).SessionId` in PowerShell or call [`orgtree-tool-session`](../tool-session/SKILL.md). `orgtree_session` reports where this turn and the next turn run; a user signing in during this turn does not move the current turn. When assigning UI work, state the session constraint and whether the test has an interactive desktop.

## Patterns that work from Session 0

- **Post window messages with a positive control.** To test a native window's message handler, post the relevant message to a known test window and assert an observable state change. Include a positive control that proves the same message path and assertion can succeed. `PostMessage` returning success alone does not prove the window handled the message.
- **Use hidden or offscreen Electron captures for renderer visuals.** DOM checks can pass while the saved image is stale or empty. Before every `capturePage()`, wait for two `requestAnimationFrame` callbacks and a short delay, then inspect the captured image. Session 0's display is 1024×768 and Windows clamps native windows to it; keep fixtures within about 1000×700. An offscreen page's `window.open` child may never paint; create that child as a hidden ordinary window from `setWindowOpenHandler` when it needs a capture.
- **Use a one-off interactive scheduled task for native desktop behavior.** Set its principal to the signed-in user's interactive logon, launch the app from that task, and give Electron a temporary `userData` directory. This runs in the user's session without reusing live app data or colliding with the session-0 instance. Remove the task when the probe ends.

Do not use UI Automation, `EnumWindows`, cursor APIs, `SendInput`, tray-popup assertions, or click-to-visible timing from Session 0; those tests cannot observe the user's desktop. If an assertion requires a real user-visible window, run it in the signed-in session through the scheduled-task route.

## See also

- [orgtree-tool-session](../tool-session/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-builds-under-the-lock](../../workspace/builds-under-the-lock/SKILL.md)