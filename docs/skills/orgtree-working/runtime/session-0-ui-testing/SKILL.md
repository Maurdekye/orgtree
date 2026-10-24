---
name: orgtree-session-0-ui-testing
description: Session 0's missing desktop and workable UI-test patterns for agents.
---

Up: [orgtree-runtime](../SKILL.md)

# Session 0 and UI testing

In Windows Session 0 there is no interactive desktop. An agent process may run there, but it cannot see or drive the user's desktop: tray popups are refused, UI Automation and `EnumWindows` see no user windows, `GetCursorPos` fails with 1459, `SendInput` sends zero, and click-to-visible timings are meaningless. A visible GUI launch from Session 0 does not prove the user's desktop UI works.

## Isolate every test window

Every test, rig, capture or fixture that opens an Orgtree, Electron or browser window must run in **Session 0 or on a never-switched private desktop**, isolated from the user's signed-in desktop. Never launch test windows in the user's signed-in session through an interactive scheduled task. A temporary profile or data root does not isolate the Windows desktop or clipboard.

A hidden or offscreen window launched directly from a turn runs in **that turn's session**. Agent turns normally run in the user's signed-in session when available (for example, Session 3; session IDs vary). Neither `show: false` nor `offscreen: true` moves a window to Session 0.

1. Read `orgtree_session({})` and check `(Get-Process -Id $PID).SessionId` in PowerShell before launching. To use Session 0, call `orgtree_session({use: 0})`, end the current turn with no children running, and verify `this_session: 0` in the next turn. Selecting the next session does not move the current turn. If that placement is unavailable, stop and ask the coordinator for an isolated route.
2. Verify the actual child window process PID and Windows `SessionId` before interacting with it. For a private desktop, verify it stays private and is never switched onto the user's desktop. State the session/desktop constraint when assigning UI work.
3. Use an isolated, initially empty clipboard and deny clipboard permissions before loading the fixture. Never read, write or clear the user's real clipboard. Deny renderer clipboard requests and prevent native clipboard bridges/paste paths from reaching the real clipboard; a fresh Electron profile alone does not do this.
4. Use only CDP or `PostMessage` directed to your own test windows. No OS input, global keystrokes, `SendInput` or automation of the user's windows. If a native assertion cannot run through the isolated route, report it as unverified and ask the coordinator; do not switch to the signed-in desktop.

## Capture evidence and limits

Every capture receipt must record the child window's PID and measured Windows **SessionId**, the private-desktop identity when used, and the **clipboard-denial state** (including whether renderer and native clipboard paths are blocked or isolated). Record unknown or failed checks honestly; the engine's Session 0 startup notice, parent placement, hidden-window flags or a temporary profile are not child-window isolation evidence. Do not claim isolation from an older receipt that omitted these fields.

- **Post window messages with a positive control.** To test a native window's message handler, post only to a known owned test window and assert an observable state change. Include a positive control proving the same message path and assertion can succeed. `PostMessage` returning success alone does not prove the window handled the message.
- **Capture after paint.** Before every `capturePage()`, wait for two `requestAnimationFrame` callbacks and a short delay, then inspect the image. DOM checks can pass while the saved PNG is stale or empty.
- **Complete a real spelling check.** Type a misspelling followed by a word boundary (for example, a space) through CDP and inspect the real native spelling event before asserting suggestions. An atomic insertion without a final boundary can leave Chromium's spelling markers empty at both normal and reduced text scale; it does not prove a canvas hit-test bug. Stub dictionary additions, never write the user's OS dictionary. A preview of the native template does not measure native popup layout.
- **Measure the isolated display.** Session 0 was measured at 1024×768 and Windows can clamp native windows to that size; keep fixtures around 1000×700 unless the isolated route's measured display permits more. An offscreen page's `window.open` child may never paint; create it as a hidden ordinary window through `setWindowOpenHandler` when it needs a capture, under the same isolation rules.

Session 0 cannot prove the user's native desktop, tray popups or click-to-visible timing. Its missing interactive desktop is a limitation to report, not permission to test in the user's session.

## See also

- [orgtree-tool-session](../tool-session/SKILL.md)
- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-builds-under-the-lock](../../workspace/builds-under-the-lock/SKILL.md)
