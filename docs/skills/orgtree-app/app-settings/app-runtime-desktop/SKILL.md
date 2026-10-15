---
name: orgtree-app-runtime-desktop
description: Explain desktop startup, closing, automatic updates and administrator rights.
---

Up: [orgtree-app-settings](../SKILL.md)

# Desktop behavior

These Runtime-tab controls apply to the desktop installation on this machine. They save immediately through the desktop bridge, independently of an organization's Save button. Agents explain and suggest changes; the user operates them. A missing bridge hides these controls; loading, an active save, or an unavailable platform capability disables the relevant control. Errors appear in the group.

| Control | Storage | Built-in default | Effect and when to suggest it |
| --- | --- | --- | --- |
| run on startup | `np:startAtLogin`, native desktop preferences plus platform startup registration | On | Start Orgtree without opening it manually. Suggest Off when the user wants startup only after a manual launch. |
| exit when the last window closes | `np:exitOnClose`, native preferences | Off | With Off, closing leaves Orgtree available in the tray. With On, closing the last visible window quits the desktop; other visible windows prevent that final-window exit. Suggest On for deliberate desktop exit on close. |
| automatic updates | `np:automaticUpdates`, native preferences | On | Allows the automatic check/download/install path while idle. Off selects manual updates; a download already started may finish. Suggest manual updates when the user wants to schedule them. |
| run Orgtree as administrator | `bridge:setRunAsAdministrator`, protected Windows installation record | Off | Changes the background engine's rights and therefore the agents it starts. Requires a Windows permission prompt and a subsequent engine start. Suggest only for an intended task requiring those rights. |

## Startup and updates

The stored startup key retains the older name startAtLogin. On an all-users Windows installation, the switch controls both the boot engine task and the sign-in credential-helper task, together with the desktop's login entry. The change uses one elevated Windows prompt and records the installer's choice. It disables tasks rather than deleting them. The actual boot-task state wins over a disagreeing saved preference when reconciled.

On per-user Windows installs, macOS and Linux, startup uses the applicable login registration. Turning startup Off leaves an engine already running alone; it prevents the next automatic start. It is not an interrupt or shutdown control. A second startup change while the first is pending is refused; wait for the result before advising another attempt.

[orgtree-engine-start-mode](../engine-start-mode/SKILL.md) arrives with the start-mode option and owns the choice of engine start mode. This page's startup description is the landed behavior at its source snapshot; update the two together when that option lands.

Automatic updates are disabled when the installation cannot perform an unattended install, for example because it cannot write its installation directory. The hint explains the detected limitation and points to Update now with the Windows prompt. A checked preference alone does not prove an update is available, eligible, installed or running. Update progress and version checks are described in [About](../app-about/SKILL.md).

## Administrator changes and engine restart

This setting is available only on Windows while Orgtree uses its background task. Otherwise its disabled explanation describes the actual limitation. Merely saving the rights preference does not change the current engine's token. After changing it, **Restart the background engine now** appears under apply the change. Restarting interrupts running agent turns; the desktop requests the authenticated stop and then reattaches to the started task. A busy restart/update refuses another restart, and a reconnect failure is reported rather than presented as success.

The desktop preference switches do not rewrite agent instructions by themselves. An engine restart can replace local processes; process replacement alone proves neither a provider cache hit nor a miss. Explain the restart's interruption before suggesting immediate application.

## See also

- [orgtree-engine-start-mode](../engine-start-mode/SKILL.md).
- [orgtree-tray-and-windows](../../app-shell/tray-and-windows/SKILL.md).
- [orgtree-app-about](../app-about/SKILL.md).
