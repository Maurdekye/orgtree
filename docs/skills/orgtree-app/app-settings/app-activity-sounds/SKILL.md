---
name: orgtree-app-activity-sounds
description: Explain independent response and task completion sounds, previews and audio output limits.
---

Up: [orgtree-app-settings](../SKILL.md)

# Activity sounds

Open App settings > Runtime > Sounds. These controls apply across every
organization on this machine and save immediately to native desktop preferences.
Agents can explain the controls; the user changes them.

| Control | Storage | Default | Meaning |
| --- | --- | --- | --- |
| Response sound | `np:responseSound` | On | One short tone when an agent successfully finishes a normal response. Failed, interrupted and cancelled turns, compaction and cache keepalive do not play it. |
| Task completion sound | `np:taskSound` | On | Three ascending notes when an agent reports done or a docket item enters a committed done state. Repeated done reports in one turn and unchanged done items do not replay the same declaration. |

Each control has a Preview button using `bridge:previewActivitySound`. A preview
plays even when its own switch is off, so the user can hear it before enabling it.
Older saved preferences acquire the defaults above; explicit saved choices remain.

Audio cues are independent of notification permissions, the Notifications master
switch and focus suppression. They can play while organization windows are hidden.
They are live events only: opening, refreshing or reconnecting does not replay old
responses or task completions. A docket completion and an agent's done report are
separate declarations and can each produce a task sound.

Playback is local synthesized audio from one hidden sandboxed desktop document.
The operating system's selected output and app volume can still silence it.
Preview success does not prove that a speaker was audible or a task was reviewed.

## See also

- [orgtree-app-notifications](../app-notifications/SKILL.md): desktop alert kinds and focus suppression.
