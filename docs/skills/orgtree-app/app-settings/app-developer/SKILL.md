---
name: orgtree-app-developer
description: Explain the engine debug view, verbose logging and opening the logs folder.
---

Up: [orgtree-app-settings](../SKILL.md)

# Developer controls

Agents explain and suggest these controls; the user operates them. They are diagnostic preferences rather than grants of authority or a way to restart a particular task.

**Show the engine debug view** is `ls:orgtree-engine-debug`, browser-local and Off by default. On mounts a live diagnostics panel. It shows each window's websocket backlog and dropped/reconnected counts, engine private memory or the available RSS fallback, docket-list traffic/cache metrics, and short history sparklines. The view reports numbers rather than issuing a memory-health verdict. It requests another sample only after the prior request finishes, roughly once per second, and retains at most sixty samples; Off mounts no panel and performs no debug-view polling. Errors are shown. Suggest it when the user needs to inspect observed memory or socket/docket traffic, not as proof of a suspected leak by itself.

**Verbose engine logging** is `rt:verbose_logging`, app-wide. Without a saved override, packaged release builds default Off and development builds default On; the runtime payload reports the actual process value. The UI describes normal logging as requests/responses/warnings/errors and verbose logging as additional engine-method entry/return and request-header detail, subject to source logging/redaction policy. It takes effect immediately and does not rewrite agent prompts. `ORGTREE_LOG_VERBOSE` values 0/false/off or 1/true/on override the saved preference for that process run; the disabled switch explains that it is fixed. Suggest verbose logging for a concrete diagnostic capture, taking the extra log volume into account.

**Open logs folder** is available when the desktop bridge supplies the opener. It disables while opening and reports a failed opener in a toast. It opens the location; it neither sends the logs to anyone nor proves that the relevant diagnostic event was recorded.

The quiet space below the last row rewards a hover; click there to enable **EPIC mode**, and untick it to make it disappear again.

While enabled, activity adds heat (no continuous drone): thinking, response
writing, tool writing/execution, waiting and compaction feed it.
Actions add impacts and sounds; heat spreads and cools as work changes. Idle status reports,
projects, retired, frozen and halted agents do not add activity. This is
an audiovisual display of observed activity, not a measure of useful progress.

The tray's **Mute EPIC sounds** checkbox is visible only while enabled. It saves
`epicMuted` (default false/audible) and follows preference changes in every
window/popout. Muting leaves visuals, heat and event detection running; unmute
returns to current activity without replaying missed sounds. Disabling the main
effect stops its audio/visual machinery. See [tray controls](../../app-shell/tray-and-windows/SKILL.md).

## UI freeze records

To help find intermittent freezes, the desktop app records each time a window or the app itself stops responding for about half a second or more (and each time a window or one of its helper processes quits unexpectedly). Records go to `diagnostics/ui-stalls.jsonl` in Orgtree's data folder (`%APPDATA%\Orgtree v2\data`), one line per freeze, kept to about 6 MB across three rotating files. Nothing is written while nothing freezes. A record holds only timings, counts and the kind of control being typed in, never message text, agent or people's names or file contents, and it stays on this computer: nothing is sent anywhere. While attract mode is running, the same recorder also keeps a short trace of what attract mode did (each step, panel it opened or closed, hand-over and stop, with kinds and timings only, never names or text) in a separate file, `diagnostics/ui-attract.jsonl` (about 2 MB across two rotating files), so it can never push out the freeze records. To turn the recorder off, start Orgtree with the environment variable `ORGTREE_STALLWATCH=0`.

## See also

- [orgtree-crash-and-restart](../../app-shell/crash-and-restart/SKILL.md).
