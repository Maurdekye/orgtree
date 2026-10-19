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
| run Orgtree as administrator | `bridge:setRunAsAdministrator`, protected Windows installation record | Off | Changes the background engine's rights and therefore the agents it starts. Requires a Windows permission prompt and a subsequent engine start. Suggest only for an intended task requiring those rights. |

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

The stored startup key retains the older name startAtLogin; the switch was called "run on startup" before 4.3.1. On an all-users Windows installation, the switch controls the boot engine task, the sign-in credential-helper task and the desktop's login entry. Turning it Off disables both tasks without deleting them. A running engine keeps running. Changing the switch uses one elevated Windows prompt and records the installer's choice. The actual boot-task state wins over a disagreeing saved preference when reconciled.

On per-user Windows installs, macOS and Linux, startup uses the applicable login registration. Turning startup Off leaves an engine already running alone; it prevents the next automatic start. It is not an interrupt or shutdown control. A second startup change while the first is pending is refused; wait for the result before advising another attempt.

There is no separate engine-start choice (4.3.1 removed "engine starts" and its sign-in engine task). The engine always starts at boot, in Windows Session 0. While the user is signed in, the sign-in helper starts the agents' CLIs in their session, with their desktop and apps, from each agent's next turn; at sign-out the agents continue in Session 0. Agents are told when they move; what that means for them is in `orgtree-halts-and-restarts` (orgtree-working › runtime). Where Orgtree cannot start at boot the switch reads **run on sign-in** and starts Orgtree, engine and agents in the user's session, at sign-in.

Automatic updates are disabled when the installation cannot perform an unattended install, for example because it cannot write its installation directory. The hint explains the detected limitation and points to Update now with the Windows prompt. A checked preference alone does not prove an update is available, eligible, installed or running. Update progress and version checks are described in [About](../app-about/SKILL.md).

## Administrator changes and engine restart

This setting is available only on Windows while Orgtree uses its background task. Otherwise its disabled explanation describes the actual limitation. It also sets the run level of the sign-in helper task, which is what the agents' CLIs in the user's session get. Merely saving the rights preference does not change the current engine's token. After changing it, **Restart the background engine now** appears under apply the change. Restarting interrupts running agent turns; the desktop requests the authenticated stop and then reattaches to the started task. A busy restart/update refuses another restart, and a reconnect failure is reported rather than presented as success.

The desktop preference switches do not rewrite agent instructions by themselves. An engine restart can replace local processes; process replacement alone proves neither a provider cache hit nor a miss. Explain the restart's interruption before suggesting immediate application.

## See also

- [orgtree-tray-and-windows](../../app-shell/tray-and-windows/SKILL.md).
- [orgtree-app-about](../app-about/SKILL.md).
