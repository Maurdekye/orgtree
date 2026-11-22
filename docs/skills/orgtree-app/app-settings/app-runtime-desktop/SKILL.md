---
name: orgtree-app-runtime-desktop
description: Explain desktop startup, closing, automatic updates, administrator rights and data location.
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
| Run as admin (Windows only) | `bridge:setRunAsAdministrator`, protected Windows installation record | Off | Shown on Windows only (hidden on macOS and Linux). One switch for the engine in Session 0 and the sign-in helper in the user's session, always together, and so for every agent they start. On means full administrator rights at boot, sign-in, restarts and updates with no further prompts. Switching it on shows a warning, then one Windows permission prompt; switching it off asks once too. The change applies at once: the engine and the helper restart, which interrupts running turns. Suggest only for an intended task requiring those rights. |
| Current folder (Data location) | `bridge:moveDataLocation`, `<userData>/data-location.json` | `<userData>/data` (`%APPDATA%\Orgtree v2\data` on Windows) | Moves organizations, the PostgreSQL database, transcripts, diagnostics and managed CLI profiles to another local folder or drive, copying and verifying every file before switching over. Suggest when the system drive is low on space. |
| Previous folder (Data location) | `bridge:moveDataLocation`, `previousRoot` in `<userData>/data-location.json` | Shown only while the previous folder still exists after a move | Opens or deletes the untouched previous data folder once the new location is running cleanly. |

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

The stored startup key retains the older name startAtLogin; the switch was called "run on startup" before 4.3.1. On an all-users Windows installation, the switch controls the automatic boot and sign-in triggers of Orgtree's two tasks (the boot engine and the sign-in credential helper) and the desktop's login entry. Turning it Off disables every one of those triggers. The tasks stay installed and enabled, so a restart or recovery can still start them. A running engine keeps running. Changing the switch uses one elevated Windows prompt and records the installer's choice. A change that fails after the prompt changes nothing and says why, as Run as admin does (below). Automatic trigger state wins over a disagreeing saved preference when reconciled; a fully disabled task is a separate failure and does not turn the operator's choice off.

An initial engine-start failure shows its actual reason with **Retry** and
**Quit**. Retry repeats the same startup path; the tray's existing Start engine
action or admitted native recovery can also resume it and dismiss the error.
A fully disabled boot task refuses before launch. Repair it by running Setup
as administrator, then Retry; no engine is started in the user's session as a
fallback. These are protected desktop recovery controls, not permission for an
agent to repair a live installation.

Setup snapshots owned task enablement and all trigger states before Prepare,
restores them on ordinary failure/cancellation/exit, and defers task starts until
commit. Restoration does not start tasks or restore replaced application files.
Its boot action, exit code and bounded helper failure text are persisted in
`orgtree-installer.log` beside Setup or in `%TEMP%`; a failed restoration keeps
the protected snapshot for diagnosis/repair. Abrupt process termination may
also leave a snapshot. A completed installation logs optional task launch
failures separately. An absent Uninstall-key InstallLocation is expected: the
path is stored on the application key. Missing success markers after a partial
copy can require the full setup flow instead of Upgrade.

On per-user Windows installs, macOS and Linux, startup uses the applicable login registration. Turning startup Off leaves an engine already running alone; it prevents the next automatic start. It is not an interrupt or shutdown control. A second startup change while the first is pending is refused; wait for the result before advising another attempt.

There is no separate engine-start choice (4.3.1 removed "engine starts" and its sign-in engine task). The engine starts at boot in Windows Session 0 and always runs there, through restarts, updates and crash recovery (alphas 27 to 32 of 4.4.0 moved it into the user's session instead; an update deletes their "Orgtree User Session Engine" task). While the user is signed in, the sign-in helper starts the agents' CLIs in their session, with their desktop and apps, from each agent's next turn. After a restart or an update, a turn waits up to 60 seconds for the helper rather than starting in Session 0. At sign-out the agents continue in Session 0. Agents are told when they move; what that means for them is in `orgtree-halts-and-restarts` (orgtree-working › runtime). Where Orgtree cannot start at boot the switch reads **Run on sign-in** and starts Orgtree, engine and agents in the user's session, at sign-in.

Automatic updates are disabled when the build has no update feed (such as packaged macOS or non-AppImage Linux builds, explaining "Automatic updates are not available for this build.") or when the installation cannot perform an unattended install, for example because it cannot write its installation directory. On Windows the hint explains the detected limitation and points to Update now with the Windows prompt; on a non-writable Linux AppImage it explains moving the AppImage to a writable folder or downloading updates manually. A checked preference alone does not prove an update is available, eligible, installed or running. Update progress and version checks are described in [About](../app-about/SKILL.md).

### Linux AppImage without FUSE

On a Steam Frame, SteamOS or any Linux without FUSE (`libfuse2`), the AppImage must be started with `APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1` in its environment, not with the `--appimage-extract-and-run` argument. The AppImage's launcher removes the argument, so the restart after an update would try FUSE and fail, while `NO_CLEANUP=1` prevents a second launch from deleting the live extraction directory; the variables carry over to the restarted app. Steam launch options: `APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 %command%`. The file must stay at one fixed, space-free path in a folder the user can write to: an update replaces it in place, and the background engine's login registration names that path. Once started in extract-and-run mode (Orgtree 4.6.9 or later), Orgtree creates or repairs its own visible `~/.local/share/applications/orgtree.desktop` (marked with `X-Orgtree-Version=`, using `env APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1` and a bare path when plain) and installs its icon if missing, while leaving hand-written and system-installed entries untouched. If a restart after an update does not come back, the update is already in place; start the AppImage again the same way. See `docs/steamos-steam-frame.md` in the repository for the SteamOS / Steam Frame guide.

## Administrator changes and engine restart

On Windows, Run as admin is also beside Run on boot in the tray context menu (both the settings group and the tray item are hidden on macOS and Linux). Both controls use `bridge:setRunAsAdministrator` / `desktop:set-run-as-admin`'s shared change handler; they accept only one administrator change at a time. Switching OFF also asks for Windows permission once. Declining the warning or permission prompt leaves the setting unchanged, and the tray restores its saved checkmark. A change that fails after the prompt leaves it unchanged too and gives the elevated script's own reason, for example `Changing the setting failed: Refusing to change a task Orgtree did not install: Orgtree Credential Helper.`; only when the script left none does it give the exit code. From either place an accepted change applies at once: the desktop restarts the engine. These protected desktop controls are operated by the user; agents explain them rather than bypassing the permission prompt.

Run as admin is available only on Windows while Orgtree uses its boot task (per-user Windows installs show the disabled explanation; macOS and Linux hide the control). One permission prompt sets the run level of both Orgtree tasks: the boot engine and the sign-in helper. The helper task's run level is what the helper and the agents' CLIs it starts get. The boot task always gets the account's full token, so its host starts the engine without administrator rights unless Run as admin is on; its own process, `orgtree-engine.exe host`, stays elevated in Task Manager with either setting. The engine and the helper are always both elevated or neither: the engine starts agents in the user's session only through a helper with its own rights, and a helper left with the other rights after a change is replaced at once. Rights are measured as Task Manager's Elevated column shows them. Agents' restart notices give the setting and the rights measured for the engine and the helper, for example `Administrator rights (Run as admin: off), measured: neither the engine in Session 0 nor the sign-in helper is elevated.` Signed out, the notice says no sign-in helper runs; with no helper 60 s after the engine's start, that none had connected; it names a helper refused for its rights, and an engine whose measured rights do not match the setting. The notice waits for the helper (up to 60 s after the engine's start), so a turn that starts first gets it at its next turn.

There is no one-off "Run this session as admin" in 4.4.0 (alphas 27 to 32 had it): elevation comes only from this switch.

Administrator rights never reach Orgtree's bundled database. PostgreSQL refuses to run with them, so an elevated engine always starts it without them, as PostgreSQL's own tools do. The engine and its agents keep their rights.

Restarting interrupts running agent turns. The old engine stops gracefully first; the boot task starts the new one in Session 0, also with Run on boot off, and the desktop reattaches to it. While the user is signed in, the sign-in helper attaches to the new engine within seconds. If the new engine does not come back, the restart says so, and the tray offers **Start engine** while the engine is stopped. If Orgtree cannot read its background engine task, it starts no engine of its own: the start or restart refuses with "Orgtree could not read its background engine task, so it started no engine.", stops nothing, and **Start engine** in the tray tries again. A busy restart/update refuses another restart, and a reconnect failure is reported rather than presented as success.

The desktop preference switches do not rewrite agent instructions by themselves. An engine restart can replace local processes; process replacement alone proves neither a provider cache hit nor a miss. Explain the restart's interruption before suggesting immediate application.

## Git and GitHub credentials in Session 0

The signed-in desktop or helper relays git HTTPS and GitHub CLI credentials to isolated agent processes without moving the engine. A lookup can take up to 20 seconds; its pipe and engine request have 25/30-second bounds. `[gh-timeout]` reports an unfinished lookup, not proof of a missing login. The command then tries GitHub CLI's native sign-in path. Local `gh --version` and help skip credential lookup. API/network commands still use the bridge, with explicit tokens retaining precedence. No new credential caching is added; general Windows vault access remains isolated. For diagnosis, report elapsed time and the fixed error code without tokens or tool stderr.

## Data location

**Runtime > Data location** controls where Orgtree stores this computer's organizations, bundled PostgreSQL cluster, scratch folders, transcripts, diagnostics and managed provider profiles (`profiles/`). Native desktop preferences (`preferences.json`, window state) and the pointer file `<userData>/data-location.json` stay in `<userData>` (`%APPDATA%\Orgtree v2` on Windows). Precedence everywhere — the desktop main process, `orgtree-engine host`, `orgtree-credential-broker`, and installer/task scripts — is `ORGTREE_V2_DATA` first, then `dataRoot` in `data-location.json`, then `<userData>/data`. The panel shows the configured folder paths and enables **Open folder**, **Change location…**, **Use default location…** and **Delete previous folder** immediately while measuring directory byte totals in the background (`Measuring size…`, at most one walk per folder cached for the session). While `ORGTREE_V2_DATA` is set for the process, **Change location…** is disabled. Standalone engines (`orgtree-engine standalone`) keep their own `ORGTREE_DATA` and ignore `data-location.json`. In a remote-organization window, Data location appears under the **this computer** group and moves only this desktop's local data folder, never the remote engine's.

Choosing **Change location…** (or **Use default location…** when a custom folder is active) runs preflight checks before stopping anything (with live file/size progress and **Cancel** if the current folder is still being measured):

- **Target folder**: an empty or not-yet-existing folder is used directly; a non-empty folder such as a drive root (`S:\`) uses `<picked>\Orgtree data` inside it, disclosed in the confirmation dialog. Paths overlapping the current data folder, `<userData>` itself, the installation folder, system root, or any symlink/junction/reparse ancestor are refused.
- **Permissions, free space and unreadable entries**: Orgtree applies owner-only permissions to the folder it creates (on Windows an owner-only NTFS ACL for `SYSTEM`, `Administrators` and the current user; `0700` on Linux/macOS), checks every ancestor directory above the drive/filesystem root against the descriptor-trust rule, verifies exclusive file locking, and requires `sourceBytes + max(2 GiB, 10%)` free on the destination volume. If the preflight scan finds unreadable entries inside the current data folder (such as restrictive permission fixtures), it lists every unreadable entry by path with a count before stopping anything and offers **Move without them** or **Cancel** (with zero unreadable entries, the dialog is unchanged).
- **Move flow, rollback and durable move log**: if agent turns are running and no unreadable entries need confirmation, the dialog warns with the count (**Stop turns and move**). Orgtree saves open windows, opens one offline progress window with live GB/file progress and **Cancel**, stops the Session 0 engine and PostgreSQL cleanly, waits until every other Orgtree process writing to the old folder (the sign-in helper `orgtree-credential-broker`, the boot host and the desktop recovery watch) has exited — if one does not stop within 60 s the move ends before copying anything —, watches the old folder for about 12 s and lists any file another program is still writing (**Continue anyway** or **Cancel**, which copies nothing), copies every regular file once, as it is when it is read, checking that each copy holds every byte read (no second pass after the copy: a file another program is still writing is copied in whatever state it is in then), without touching the old folder (or skips preflight-approved unreadable entries and their contents completely while still rolling back on any newly unreadable entry mid-copy), stamps `.data-location-moved.json`, switches `data-location.json`, starts the engine on the new folder, and relaunches your windows once `/api/desktop/identity` responds for the new path. Every phase, refusal, skipped path, cleanup result and rollback is recorded in `<userData>/data-location-move.log` (**Open move log**), and after a restart with skipped entries Orgtree reports `Moved; N folders could not be read and stayed in <old folder>: …` with **Open move log**. Cancelling before the switch or failing to start cleans up the partial destination, restores `data-location.json`, and reopens on the untouched original folder.
- **Old folder**: **Delete the old folder once the new location starts cleanly** in the move dialog is **unticked by default** and stays usable even when unreadable entries are skipped. When ticked, once the new location starts cleanly Orgtree deletes everything readable in the old folder except the skipped unreadable entries and the parent folders holding them (never following symlinks or NTFS junctions), naming any remaining paths in the move log and result. While the old folder or any skipped entries still exist, **Previous folder** offers **Open folder** and **Delete previous folder (<size>)** (which applies the same selective safe-delete rule); there is no unsolicited prompt when unticked and no automatic timer.
- **Path relocation and offline drives**: on first boot at the moved folder, the engine runs an idempotent, crash-resumable relocation across stored scratch/profile/attachment paths in PostgreSQL and Claude Code session directories before starting organizations or watchdogs, recording a receipt in `diagnostics/data-relocation.jsonl`. Transcripts keep the paths they were written with; their images, videos and file links that name an earlier data folder open from the same place in the current one. External workspace grants (such as project checkouts) are untouched. If a configured custom drive is unplugged or missing at startup, Orgtree never creates a blank database silently: it prompts **Retry**, **Choose folder…**, **Use default location**, or **Quit**, and installer upgrades refuse while `.data-move-in-progress.json` names a live move process.

## Startup failure, background helpers and shader warm-up

- **Failed start.** When the desktop itself cannot start, it appends one `{at, event: "startup-failed", message}` line (message cut at 500 characters) to `diagnostics/desktop-engine-exits.jsonl` in the data folder, waiting at most 2 s, marks the tray ("Orgtree could not start - right-click for the error"; first menu row "Orgtree could not start: show the error"), and then shows the error box.
- **No program launches on the main thread.** Status checks (the 2 s core-control check, the streamer task list), credential helpers, registry and PowerShell queries and similar bounded programs run in one background worker process, and settings are saved in the background, so a slow antivirus scan or disk does not freeze windows. The engine itself, the interactive provider login, the AppImage relaunch and the updater handoff still start from the main process.
- **Shader warm-up.** On every launch, 15 s after launch and once you have been idle for 5 s (but no more than 30 s later: then it runs anyway), Orgtree draws a sample canvas in an offscreen window that is never shown or focused, so the graphics card's shaders are ready in this run before real windows need them. It is skipped when the GPU does not rasterize; `ORGTREE_SHADER_WARMUP=0` turns it off.

## See also

- [orgtree-tray-and-windows](../../app-shell/tray-and-windows/SKILL.md).
- [orgtree-app-about](../app-about/SKILL.md).
