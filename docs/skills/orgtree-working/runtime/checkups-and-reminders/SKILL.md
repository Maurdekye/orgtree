---
name: orgtree-checkups-and-reminders
description: Understand when automatic working checkups and docket reminders can wake an idle agent.
---

Up: [orgtree-runtime](../SKILL.md)

# Checkups and reminders

Automatic reminders help work resume after an agent has become idle. They are waking system mail, not a promise of an exact wake time, fresh provider capacity or a cache hit. User switches and their defaults live in `orgtree-app-concurrency-and-checkups` (orgtree-app › app-settings).

## Eligibility and timing

The reminder sweep runs about every 20 seconds. A reminder becomes due only after **more than 20 minutes** since the relevant activity anchor. Recent turns, status reports and automatic-wake stamps defer it. An agent with no previous anchor is stamped first and waits its interval.

Candidates must be live, not halted/frozen/limit-locked, without an unfinished turn or waking/delivering mail, in an org whose stop latch is clear. Busy actors, slot waiters and actors running a cache keepalive are skipped. Passive notices are not waking mail and do not block an otherwise eligible wake.

The engine reserves a durable timestamp before sending and rechecks eligibility. If real work wins the race, the automatic wake is withdrawn when still pending; the timestamp remains as its cooldown. A restart therefore does not mean every old reminder is sent again immediately.

## Which reminder wins

1. A docket reminder names work whose next-action recipient is this agent. Ordinary candidates exclude blocked work, items flagged for user attention and items with an open attached question. It can wake an idle agent without requiring a `working` status. At most 20 item rows are shown, with an omitted count when needed.
2. If no docket reminder took the agent, a working checkup can run when the agent last reported `working` **and has actionable docket work**. The broad startup sentence about working status omits this additional source gate: `working` alone is insufficient.
3. The optional blocked-work reminder adds blocked items only when the org's unfinished, unarchived, non-backlogged work set is nonempty and entirely blocked, and the agent has no ordinary actionable item to name. It is not a detector that a particular external blocker has cleared.

The next-action recipient can be a reviewer for a review item rather than merely its owner. Keep the [docket](../../docket/tool-work/SKILL.md) accurate so reminders name the right person and work.

## What to do as an agent

Treat a reminder as a chance to re-read the work and continue or report a real blocker. Do not keep status `working` merely to obtain automatic wakeups. For a specific event, use a [watchdog](../../watchdogs/tool-watchdog/SKILL.md) rather than counting on a generic checkup. A blocked item still needs a concrete route by which the answer reaches its owner.

With working checkups disabled, the runtime can instead use billed disposable Claude prefix reads for eligible working sessions. That cache keeper does not advance the task or enter the prompt/answer in the main session, and it has its own eligibility/cadence limits. Disabling checkups is not a guarantee of no model-related activity or no cost; explain that tradeoff before suggesting the setting.

## See also

- `orgtree-app-concurrency-and-checkups` (orgtree-app › app-settings)
- [orgtree-tool-status](../tool-status/SKILL.md)
