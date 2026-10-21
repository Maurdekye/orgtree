---
name: orgtree-app-runtime-desktop
description: Explain desktop startup, closing, automatic updates and administrator rights.
---

Up: [orgtree-app-settings](../SKILL.md)

# Desktop behavior

These Runtime-tab controls apply to the desktop installation on this machine. They save immediately through the desktop bridge, independently of an organization's Save button. Agents explain and suggest changes; the user operates them. A missing bridge hides these controls; loading, an active save, or an unavailable platform capability disables the relevant control. Errors appear in the group.

| Control | Storage | Built-in default | Effect and when to suggest it |
| --- | --- | --- | --- |
| run on boot ("run on sign-in" where Orgtree cannot start at boot) | `np:startAtLogin`, native desktop preferences plus platform startup registration | On | Start Orgtree without opening it manually: on an all-users Windows installation the background engine at boot, and while the user is signed in its agents run in their session. Suggest Off when the user wants nothing of Orgtree to run until they open it. |
| exit when the last window closes | `np:exitOnClose`, native preferences | Off | With Off, closing leaves Orgtree available in the tray. With On, closing the last visible window quits the desktop; other visible windows prevent that final-window exit. Suggest On for deliberate desktop exit on close. |
| automatic updates | `np:automaticUpdates`, native preferences | On | Allows the automatic check/download/install path while idle. Off selects manual updates; a download already started may finish. Suggest manual updates when the user wants to schedule them. |
| Run as admin | `bridge:setRunAsAdministrator`, protected Windows installation record | Off | One switch for both engines, the Session 0 engine at boot and the engine in the user's signed-in session, and so for every agent they start. On means full administrator rights at boot, sign-in, restarts and updates with no further prompts. Switching it on shows a warning and one Windows permission prompt, and the change applies at the next engine start. Suggest only for an intended task requiring those rights. |

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

The stored startup key retains the older name startAtLogin; the switch was called "run on startup" before 4.3.1. On an all-users Windows installation, the switch controls the automatic boot and sign-in triggers of Orgtree's three tasks (the boot engine, the sign-in credential helper and the user-session engine) and the desktop's login entry. Turning it Off disables every one of those triggers. The tasks stay installed and enabled, so a restart or recovery can still start them. A running engine keeps running. Changing the switch uses one elevated Windows prompt and records the installer's choice. The actual boot-task state wins over a disagreeing saved preference when reconciled.

On per-user Windows installs, macOS and Linux, startup uses the applicable login registration. Turning startup Off leaves an engine already running alone; it prevents the next automatic start. It is not an interrupt or shutdown control. A second startup change while the first is pending is refused; wait for the result before advising another attempt.

There is no separate engine-start choice (4.3.1 removed "engine starts" and its sign-in engine task). The engine starts at boot in Windows Session 0. While the user is signed in, the sign-in helper starts the agents' CLIs in their session, with their desktop and apps, from each agent's next turn. An engine restart, an update or crash recovery while the user is signed in at the console starts the engine itself in their session, so the agents run there too. With Run as admin on, signing in also moves the engine into their session. At sign-out Orgtree starts the engine in Session 0 again, and the agents continue there. Agents are told when they move; what that means for them is in `orgtree-halts-and-restarts` (orgtree-working › runtime). Where Orgtree cannot start at boot the switch reads **run on sign-in** and starts Orgtree, engine and agents in the user's session, at sign-in.

Automatic updates are disabled when the installation cannot perform an unattended install, for example because it cannot write its installation directory. The hint explains the detected limitation and points to Update now with the Windows prompt. A checked preference alone does not prove an update is available, eligible, installed or running. Update progress and version checks are described in [About](../app-about/SKILL.md).

## Administrator changes and engine restart

Run as admin is also beside Run on boot in the tray context menu. Both controls use `bridge:setRunAsAdministrator` / `desktop:set-run-as-admin`'s shared change handler; they accept only one administrator change at a time. Switching OFF also asks for Windows permission once. Declining the warning or permission prompt leaves the setting unchanged, and the tray restores its saved checkmark. The tray changes the next-start preference without restarting the engine. These protected desktop controls are operated by the user; agents explain them rather than bypassing the permission prompt.

Run as admin is available only on Windows while Orgtree uses its boot task. Otherwise its disabled explanation describes the actual limitation. One permission prompt sets the run level of all three Orgtree tasks: the boot engine, the sign-in helper and the user-session engine. A task's run level is what the engine or the agents' CLIs it starts get. Merely saving the rights preference does not change the current engine's token. After changing it, **Restart the background engine now** appears under apply the change.

**Run this session as admin**, next to the switch, restarts the engine and its agents elevated in the user's current session, with one Windows permission prompt per click. It never changes the switch, and a later automatic restart or update follows the switch again. It is disabled while Run as admin is on and when nobody is signed in at the console. A declined prompt leaves the running engine untouched.

Restarting interrupts running agent turns. While the user is signed in at the console, the restart starts the new engine in their session: the old one stops gracefully first, and the desktop reattaches to the new one. Otherwise the desktop requests the authenticated stop and reattaches to the started boot task. If the new engine cannot start in the user's session after the old one stopped, Orgtree starts it once in Session 0 instead and says so, in a message and in the agents' restart notice. If that fails too, the engine stays stopped and the tray offers **Start engine**. A busy restart/update refuses another restart, and a reconnect failure is reported rather than presented as success.

The desktop preference switches do not rewrite agent instructions by themselves. An engine restart can replace local processes; process replacement alone proves neither a provider cache hit nor a miss. Explain the restart's interruption before suggesting immediate application.

## See also

- [orgtree-tray-and-windows](../../app-shell/tray-and-windows/SKILL.md).
- [orgtree-app-about](../app-about/SKILL.md).
