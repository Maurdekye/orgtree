---
name: orgtree-waiting-for-events
description: Arrange an event-driven wake while keeping long-job ownership and cleanup explicit.
---

Up: [orgtree-watchdogs](../SKILL.md)

# Waiting for events

For account allowance thresholds, resets, stale/recovered readings and usage
refusals, choose `kind=usage` instead of a periodic tick command. It consumes
existing usage observations, not secrets or provider refreshes. Example:
`accounts:["claude-5"], windows:["weekly"], usage_events:["above"], threshold_percent:98`.
Current high values seed quietly; only later crossings fire, once until the
reading falls below or resets. Unknown is never zero. See the watchdog tool
page for exact filters, event names, notice and once behavior.

Choose an observable completion signal and arrange a persistent watcher before yielding. The [watchdog tool](../tool-watchdog/SKILL.md) owns the exact kinds, parameters, event catalog, shell rules and limits; use that reference to make the watcher concrete.

## Pick a signal you can verify

| What you need to know | Start with |
|---|---|
| A durable log gains a completion/error line | File watcher. |
| A safe finite probe prints a condition | Command watcher. |
| A particular process or local port goes down | Process watcher; inspect its current baseline first. |
| A long-lived command emits live events | Stream watcher, accepting offline gaps. |
| A descendant stops reporting turn/tool activity | Activity watcher with a matching or silence condition. |
| The engine publishes a lifecycle or count transition | Event watcher. |
| A superior releases the group, or everyone has arrived | `project_listener` on the shared project (sync wake), and `listener_watch count=N` for the one waiting for the group — never a poll of who has armed. |

A vague signal makes a vague wake. Prefer a unique completion marker or a definite down edge over repeated broad text. A deadline/completion condition should normally be one-shot; recurring alerts should have a reason to repeat. Passive delivery is useful only when another event will eventually give you a turn to read it.

## Own the job and the wake

Keep your own long-running task in the foreground until it reaches a safe milestone. Do not start a turn-bound background job, add a watcher and assume that permits ending the turn; the [turn-lifetime rule](../../runtime/turns-and-wakes/SKILL.md) still applies. A watcher is appropriate for an independently owned process, another agent's job, a durable service or another external event that can continue without your current turn.

For build/test work, first follow [the concurrency-slot permit practice](../../workspace/builds-under-the-lock/SKILL.md). A watchdog grants no build authorization or queue priority. Do independent work while waiting when available; do not hold a sleeping model turn open or create a loop that repeatedly asks whether the event happened.

Read create-time smoke and confirm that the target is runnable and its output matches the intended signal. A successfully armed but broken watcher is not a plan for resumption. If watcher tools or required scope are unavailable, ask the responsible superior for a concrete completion message rather than silently falling back to an endless poll.

Record the watched condition, owner and ID in the work item when it matters to handoff. On waking, inspect the event and actual result, act once, and remove any remaining spent-purpose watcher. Paused/exited dogs still occupy kept capacity; a stream's final diagnostic can leave it exited. Use the tool's list/management evidence to clean up intentionally.

## See also

- [orgtree-tool-watchdog](../tool-watchdog/SKILL.md)
- [orgtree-turns-and-wakes](../../runtime/turns-and-wakes/SKILL.md)
- [orgtree-builds-under-the-lock](../../workspace/builds-under-the-lock/SKILL.md)
