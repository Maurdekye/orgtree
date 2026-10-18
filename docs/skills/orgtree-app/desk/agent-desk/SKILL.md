---
name: orgtree-agent-desk
description: Explain the desk header, runtime banners, tabs and available agent controls.
---
Up: [orgtree-desk](../SKILL.md)

# Agent desk

Open an agent's desk from its name/card or desk navigation. A focused desk, a pinned canvas window and a detached window show the same agent identity and work tabs. Pinning fixes it in screen space; pop-out opens its window surface. These view choices are not agent lifecycle changes.

## Header controls

| Control/indicator | Meaning |
| --- | --- |
| Agent name | Identity/navigation target; available menus can copy the name. |
| Context wheel | Context occupancy/window and compact threshold; where available it opens Normal compact / Cheap compact / Cancel. Normal uses the harness; cheap starts a fresh session with a summary handoff on the same agent. Unsupported normal compaction is disabled with a reason. |
| Process indicator | Current process lifecycle, warming/relaunch/pause information and an enabled process action when the engine provides one. |
| Turn status | Engine turn activity/result and reported status summary; a self-reported status is not proof a process runs. |
| Halt / Finish halt / Unhalt | Distinguishes blocking admission, a turn still ending, and explicit release; use the shown state rather than repeatedly clicking. |
| Retire / dissolve | A live agent without live children offers retire; one with live children offers dissolve, each with confirmation. |
| Rehire / dismiss | Retired desk actions; dismiss hides that retired view, rehire is a lifecycle operation. |
| Gear | Opens this agent's settings. |
| Pin, pop-out/window controls | Change the viewing surface rather than starting a different agent. |

The metadata row can show MCP count/readiness, cache forecast, last reported status, halt, freeze/limit, held-seat, cost, queued-mail and serving-account/route information when supplied. Queued account, model and effort chips describe pending configuration separately. Distinguish current versus “last” route/account evidence.

Idle age measures time since the last completed turn ended, including killed turns, across every harness. Open or legacy records without a completion time retain their start-time fallback. Active time measures the current turn's admission; ordinary Antigravity mid-turn hook mail keeps that original active clock. The card and tray use the same idle reference. Halted and usage-freeze clocks retain their own timestamps.

Freeze badges show the recorded cause/deadline/provenance rather than promising a guaranteed wake. The user unstick control is an explicit recovery override. For freeze mechanics see `orgtree-usage-freezes` (orgtree-working › accounts). For cache evidence see `orgtree-cache-continuity` there.

## Jump cards

The row above the conversation jumps up to the agent's superior; the row below jumps down to its reports, then its watchdogs. Projects pass through: an agent under projects gets an up card for its nearest agent superior and for each project in between (superior first, then outermost to innermost), and a report that is a project brings a card for each of its live members, through nested projects. A project's card shows a folder instead of a model letter. Long rows fold per **Collapse many jump cards on desks**.

## Composer banners

Halted/organization-stop banners identify the durable hold; waiting-for-turn-slot points to concurrency limits; model-loading reports startup work. Cache warnings describe send-time risk or configured compaction, not guaranteed provider behavior. A queued/compacting agent has no running steering window merely because it has pending work.

The separate Halt and Stop controls are consequential: Stop interrupts a response; Halt also blocks later wakes until explicitly released. View navigation itself does neither.

## Tabs and next destination

- [Chat](../desk-chat/SKILL.md): conversation and composing.
- [Inbox](../inbox-screens/SKILL.md): the agent's mailbox.
- [Docket](../docket-screens/SKILL.md): its work items.
- [Presented](../presentations/SKILL.md): document collection.

Agent event history is available in the agent settings panel when the agent has retained records. Scratch folders open in the OS file explorer through **Open → Scratch folder** in the agent menu or **Open scratch folder** in the settings header.

Counts appear for Inbox, Docket and Presented when nonzero. For configuration fields see [agent settings](../../agent-settings/agent-config/SKILL.md).

## See also

- [orgtree-desk-chat](../desk-chat/SKILL.md)
- [orgtree-agent-config](../../agent-settings/agent-config/SKILL.md)
