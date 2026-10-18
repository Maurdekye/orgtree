---
name: orgtree-app-developer
description: Explain the engine debug view, verbose logging and opening the logs folder.
---

Up: [orgtree-app-settings](../SKILL.md)

# Developer controls

Agents explain and suggest these controls; the user operates them. They are diagnostic preferences rather than grants of authority or a way to restart a particular task.

**show the engine debug view** is `ls:orgtree-engine-debug`, browser-local and Off by default. On mounts a live diagnostics panel. It shows each window's websocket backlog and dropped/reconnected counts, engine private memory or the available RSS fallback, docket-list traffic/cache metrics, and short history sparklines. The view reports numbers rather than issuing a memory-health verdict. It requests another sample only after the prior request finishes, roughly once per second, and retains at most sixty samples; Off mounts no panel and performs no debug-view polling. Errors are shown. Suggest it when the user needs to inspect observed memory or socket/docket traffic, not as proof of a suspected leak by itself.

**verbose engine logging** is `rt:verbose_logging`, app-wide. Without a saved override, packaged release builds default Off and development builds default On; the runtime payload reports the actual process value. The UI describes normal logging as requests/responses/warnings/errors and verbose logging as additional engine-method entry/return and request-header detail, subject to source logging/redaction policy. It takes effect immediately and does not rewrite agent prompts. `ORGTREE_LOG_VERBOSE` values 0/false/off or 1/true/on override the saved preference for that process run; the disabled switch explains that it is fixed. Suggest verbose logging for a concrete diagnostic capture, taking the extra log volume into account.

**Open logs folder** is available when the desktop bridge supplies the opener. It disables while opening and reports a failed opener in a toast. It opens the location; it neither sends the logs to anyone nor proves that the relevant diagnostic event was recorded.

The quiet space below the last row rewards a hover; click there to enable EPIC Mode, and untick it to make it disappear again.

EPIC activity audio has six shared machinery layers: thinking, response writing,
tool argument writing, tool execution, waiting and compaction. Unclassified work
adds heat without a background audio layer. Discrete event sounds remain, and
the tray's **Mute EPIC sounds** fades all EPIC audio while heat and motion continue.
See [EPIC activity sound](../../../../rust-engine/epic-activity-sound.md).

## See also

- [orgtree-crash-and-restart](../../app-shell/crash-and-restart/SKILL.md).
