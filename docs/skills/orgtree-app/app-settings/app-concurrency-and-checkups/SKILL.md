---
name: orgtree-app-concurrency-and-checkups
description: Explain machine-wide turn capacity, process warming, MCP readiness and automatic docket checkups.
---

Up: [orgtree-app-settings](../SKILL.md)

# Turns and agent processes

These Runtime settings apply across organizations and save immediately through `/api/app-settings/runtime`. Read the loaded payload for the current values. Agents explain and suggest changes; they do not change settings themselves. Saving shows a pending disabled state and reports failure. These controls do not increase provider allowances or an agent's credit grant.

| Control | Storage | Engine default | Effect and when to suggest it |
| --- | --- | --- | --- |
| most agent turns running at once | `rt:max_concurrent_turns` | 16 | Machine-wide admission cap. UI accepts integers 1–512, committed on blur or Enter; the endpoint accepts up to 1,024. Suggest reducing it for machine pressure, or increasing it only when the machine and provider lanes have room. |
| keep agent processes warm | `rt:warming_enabled` | On | Keeps eligible idle harness processes ready. Off asks idle processes to cool; it does not interrupt running turns. Suggest Off when idle process memory is more important than launch latency. |
| check on working agents after 20 minutes | `rt:working_checkups_enabled`, persisted as working_checkups | On | Enables working checkups with the actual eligibility and docket gates below. Suggest for continued authorized work that might otherwise remain idle. |
| wait until the MCP tool surface is ready | `rt:wait_for_mcp_tools_enabled` | Off | Enables the runtime's supported tool-surface readiness wait. It does not install a server, grant it, or guarantee a successful authenticated connection. Suggest when startup races leave granted tools unavailable at turn opening. |
| remind idle agents about unfinished docket items | `rt:idle_docket_reminders_enabled`, persisted as idle_docket_reminders | On | Enables reminders naming owed work. The unloaded UI checkbox fallback is Off, but the engine supplies the default On. Suggest when unfinished assigned work needs an automatic nudge. |
| also remind about blocked items when every ticket is blocked | `rt:blocked_docket_reminders_enabled` | Off | Adds blocked items only when the organization's entire nonterminal work set is nonempty and blocked. It does not detect that an external dependency became available. |

The concurrency cap changes admission immediately. Lowering it lets admitted turns finish; new turns wait until capacity becomes available. Waiting is first-come-first-served within an organization and round-robin across organizations. Local language-server caps can impose an additional wait. The displayed running/waiting counts are scheduler facts, not counts of credits or all live agents.

Warming is bounded by memory checks and the machine-wide parked-process cap, currently 64 idle processes with the longest parked closed first. It is not a promise that every live seat always has a process. Turning warming On requests warming; turning it Off requests cooling. A warm local process is separate from provider prompt-cache compatibility, receipts and expiry.

## Automatic wakes

Checkups/reminders are eligibility-based sweeps, not exact 20-minute alarms. They defer while the agent is busy, waiting for a turn slot, keeping a cache alive, halted, frozen, limit-locked, already has waking mail, or its org is halted. Passive notices alone do not count as waking mail. Activity and durable automatic-wake stamps determine when the agent is due and deduplicate across restarts.

A working checkup also requires actionable owed docket work: not blocked and not waiting on the user. An idle-docket reminder gets precedence when it can name the work, so the same sweep does not also send a generic checkup. The blocked option is additive to idle reminders; enabling it alone does not make blocked work executable or unblock a ticket. Use a real message or watchdog for an external event.

These switches change scheduling/runtime policy, not the already-sent instruction prefix. Explain any later process launch or actual wake separately; no toggle guarantees a provider cache hit.

## See also

- `orgtree-checkups-and-reminders` (orgtree-working › runtime).
