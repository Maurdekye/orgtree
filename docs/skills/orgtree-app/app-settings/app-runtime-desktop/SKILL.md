---
name: orgtree-app-runtime-desktop
description: Explain desktop startup, closing, automatic updates and administrator rights.
---

Up: [orgtree-app-settings](../SKILL.md)

# Desktop behavior

For operation without the desktop, see `orgtree-standalone-engine`
(orgtree-working › runtime): configuration, persistence, authentication and
the separate user MCP endpoint. These installation controls do not configure it.

These Runtime-tab controls apply to the desktop installation on this machine. They save immediately through the desktop bridge, independently of an organization's Save button. Agents explain and suggest changes; the user operates them. A missing bridge hides these controls; loading, an active save, or an unavailable platform capability disables the relevant control. Errors appear in the group.

| Control | Storage | Built-in default | Effect and when to suggest it |
| --- | --- | --- | --- |
| Run on boot ("Run on sign-in" where Orgtree cannot start at boot) | `np:startAtLogin`, native desktop preferences plus platform startup registration | On | Start Orgtree without opening it manually: on an all-users Windows installation the background engine at boot, and while the user is signed in its agents run in their session. Suggest Off when the user wants nothing of Orgtree to run until they open it. |
| Exit when the last window closes | `np:exitOnClose`, native preferences | Off | With Off, closing leaves Orgtree available in the tray. With On, closing the last visible window quits the desktop; other visible windows prevent that final-window exit. Suggest On for deliberate desktop exit on close. |
| Automatic updates | `np:automaticUpdates`, native preferences | On | Allows the automatic check/download/install path while idle. Off selects manual updates; a download already started may finish. Suggest manual updates when the user wants to schedule them. |
| Run as admin | `bridge:setRunAsAdministrator`, protected Windows installation record | Off | One switch for the engine in Session 0 and the sign-in helper in the user's session, always together, and so for every agent they start. On means full administrator rights at boot, sign-in, restarts and updates with no further prompts. Switching it on shows a warning, then one Windows permission prompt; switching it off asks once too. The change applies at once: the engine and the helper restart, which interrupts running turns. Suggest only for an intended task requiring those rights. |

## Startup and updates

The installer's **Run Orgtree** Finish action launches directly when Setup is
already unelevated. Elevated Setup dispatches through the original user's
shell; the installation's per-user/all-users choice alone does not establish
its current rights. Both routes retain exclusive launch ownership. A dispatch
success does not confirm engine readiness. If Setup reports a launch failure,
the desktop shortcut remains available; collect `orgtree-installer.log` beside
Setup (or in `%TEMP%`) for the exact dispatch result. An engine log may not yet
exist if no desktop process started. This is an installer action, not an agent
tool or the Run on boot preference.

The stored startup key retains the older name startAtLogin; the switch was called "run on startup" before 4.3.1. On an all-users Windows installation, the switch controls the automatic boot and sign-in triggers of Orgtree's two tasks (the boot engine and the sign-in credential helper) and the desktop's login entry. Turning it Off disables every one of those triggers. The tasks stay installed and enabled, so a restart or recovery can still start them. A running engine keeps running. Changing the switch uses one elevated Windows prompt and records the installer's choice. A change that fails after the prompt changes nothing and says why, as Run as admin does (below). The actual boot-task state wins over a disagreeing saved preference when reconciled.

On per-user Windows installs, macOS and Linux, startup uses the applicable login registration. Turning startup Off leaves an engine already running alone; it prevents the next automatic start. It is not an interrupt or shutdown control. A second startup change while the first is pending is refused; wait for the result before advising another attempt.

There is no separate engine-start choice (4.3.1 removed "engine starts" and its sign-in engine task). The engine starts at boot in Windows Session 0 and always runs there, through restarts, updates and crash recovery (alphas 27 to 32 of 4.4.0 moved it into the user's session instead; an update deletes their "Orgtree User Session Engine" task). While the user is signed in, the sign-in helper starts the agents' CLIs in their session, with their desktop and apps, from each agent's next turn. After a restart or an update, a turn waits up to 60 seconds for the helper rather than starting in Session 0. At sign-out the agents continue in Session 0. Agents are told when they move; what that means for them is in `orgtree-halts-and-restarts` (orgtree-working › runtime). Where Orgtree cannot start at boot the switch reads **Run on sign-in** and starts Orgtree, engine and agents in the user's session, at sign-in.

Automatic updates are disabled when the installation cannot perform an unattended install, for example because it cannot write its installation directory. The hint explains the detected limitation and points to Update now with the Windows prompt. A checked preference alone does not prove an update is available, eligible, installed or running. Update progress and version checks are described in [About](../app-about/SKILL.md).

## Administrator changes and engine restart

Run as admin is also beside Run on boot in the tray context menu. Both controls use `bridge:setRunAsAdministrator` / `desktop:set-run-as-admin`'s shared change handler; they accept only one administrator change at a time. Switching OFF also asks for Windows permission once. Declining the warning or permission prompt leaves the setting unchanged, and the tray restores its saved checkmark. A change that fails after the prompt leaves it unchanged too and gives the elevated script's own reason, for example `Changing the setting failed: Refusing to change a task Orgtree did not install: Orgtree Credential Helper.`; only when the script left none does it give the exit code. From either place an accepted change applies at once: the desktop restarts the engine. These protected desktop controls are operated by the user; agents explain them rather than bypassing the permission prompt.

Run as admin is available only on Windows while Orgtree uses its boot task. Otherwise its disabled explanation describes the actual limitation. One permission prompt sets the run level of both Orgtree tasks: the boot engine and the sign-in helper. The helper task's run level is what the helper and the agents' CLIs it starts get. The boot task always gets the account's full token, so its host starts the engine without administrator rights unless Run as admin is on; its own process, `orgtree-engine.exe host`, stays elevated in Task Manager with either setting. The engine and the helper are always both elevated or neither: the engine starts agents in the user's session only through a helper with its own rights, and a helper left with the other rights after a change is replaced at once. Rights are measured as Task Manager's Elevated column shows them. Agents' restart notices give the setting and the rights measured for the engine and the helper, for example `Administrator rights (Run as admin: off), measured: neither the engine in Session 0 nor the sign-in helper is elevated.` Signed out, the notice says no sign-in helper runs; with no helper 60 s after the engine's start, that none had connected; it names a helper refused for its rights, and an engine whose measured rights do not match the setting. The notice waits for the helper (up to 60 s after the engine's start), so a turn that starts first gets it at its next turn.

There is no one-off "Run this session as admin" in 4.4.0 (alphas 27 to 32 had it): elevation comes only from this switch.

Administrator rights never reach Orgtree's bundled database. PostgreSQL refuses to run with them, so an elevated engine always starts it without them, as PostgreSQL's own tools do. The engine and its agents keep their rights.

Restarting interrupts running agent turns. The old engine stops gracefully first; the boot task starts the new one in Session 0, also with Run on boot off, and the desktop reattaches to it. While the user is signed in, the sign-in helper attaches to the new engine within seconds. If the new engine does not come back, the restart says so, and the tray offers **Start engine** while the engine is stopped. If Orgtree cannot read its background engine task, it starts no engine of its own: the start or restart refuses with "Orgtree could not read its background engine task, so it started no engine.", stops nothing, and **Start engine** in the tray tries again. A busy restart/update refuses another restart, and a reconnect failure is reported rather than presented as success.

The desktop preference switches do not rewrite agent instructions by themselves. An engine restart can replace local processes; process replacement alone proves neither a provider cache hit nor a miss. Explain the restart's interruption before suggesting immediate application.

## Git and GitHub credentials in Session 0

The signed-in desktop or helper relays git HTTPS and GitHub CLI credentials to isolated agent processes without moving the engine. A lookup can take up to 20 seconds; its pipe and engine request have 25/30-second bounds. `[gh-timeout]` reports an unfinished lookup, not proof of a missing login. The command then tries GitHub CLI's native sign-in path. Local `gh --version` and help skip credential lookup. API/network commands still use the bridge, with explicit tokens retaining precedence. No new credential caching is added; general Windows vault access remains isolated. For diagnosis, report elapsed time and the fixed error code without tokens or tool stderr.

## See also

- [orgtree-tray-and-windows](../../app-shell/tray-and-windows/SKILL.md).
- [orgtree-app-about](../app-about/SKILL.md).
