---
name: orgtree-watchdogs
description: "Watching for events without polling: watchdogs and how to wait."
---

Up: [orgtree-working](../SKILL.md)

# watchdogs

Watching for events without polling: watchdogs and how to wait.

## Workflows and rules

- [orgtree-waiting-for-events](waiting-for-events/SKILL.md): How to wait for a build, file, process or event: a watchdog, never a polling loop or a sleeping turn.

## Tools

- [orgtree-tool-watchdog](tool-watchdog/SKILL.md): Persistent watchers (file/command/process/stream/activity/event/usage, the project-bound fair_queue, slot, project_listener and listener_watch, fire-time tool calls, and `project=P` watchdogs a project owns) that mail you.

A superior can create a watchdog its report owns (`orgtree_watchdog create owner=<report>`), so the report is woken without spending its turn.

For another topic, return to the category above. References to another category use its skill name and breadcrumb; open that category to locate them.
