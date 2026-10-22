---
name: orgtree-tool-status
description: Report your work status and understand which reports reach your superior.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_status

## Call contract

Report your own working/done/blocked/idle status, optionally changing your current turn's DnD. Alternatively, name `node` with `dnd` to change only that agent's DnD; omit status/summary. A descendant needs runtime permission and descendant authority. A named self target needs no group. Work status reports always describe yourself; a targeted call never changes anyone's status chip or sends a status report.

Report a meaningful change in your own work. Call it when finished (`done`) or stuck (`blocked`); use `working` when work resumes. It updates your status chip and history. It does not complete a docket item or end the turn that is currently running.

## Parameters

| Parameter | Required | Meaning |
|---|---|---|
| `status` | Self report | `working`, `done`, `blocked`, or `idle`; omit with `node`. |
| `summary` | Self report | One or two sentences describing the result, next step, or blocker. The handler collapses whitespace and shortens it to a 600-character gist. Put durable detail in the docket; omit with `node`. |
| `dnd` | With `node` | Boolean: hold ordinary mail, or clear the hold and release held mail now. Optional on a self report; omission retains the mode. |
| `node` | No | Self or a descendant agent. A named target requires `dnd` and forbids `status`/`summary`. |

`done` records an idle current status, while the event records that you reported done. Do not follow it with a separate idle report. `blocked` describes work needing input or an external change; it does not install a wake trigger. Arrange how the answer or event will reach you.

## Delivery and permissions

Self status and self DnD stay available even when all groups are disabled. Controlling another agent's DnD rechecks your current runtime tool group and requires a live descendant agent; peers, superiors, projects and retired targets are refused. Visibility and audiences do not grant this control.

Only `done` and `blocked` send the summary to your nearest agent superior, skipping intervening projects, as a passive notice. `working` and `idle` update the record without that mail. An agent with no agent superior is top-level for this purpose even inside a project, so its report updates its chip without sending a duplicate user digest. Communicate actual results through the appropriate mail channel when needed.

A status never wakes the superior. If action is needed now, send a [message](../../mail/tool-message/SKILL.md) as well. Keep the [docket](../../docket/tool-work/SKILL.md) current separately.

An unsupported status is refused with `status must be working, done, blocked or idle`; a missing/empty status is refused as required. Supply both declared arguments even though the handler tolerates an absent summary as empty text.

## Example

```json
{"status":"done","summary":"The parser fix is committed and its focused checks pass; the review evidence is on the docket."}
```

DnD-only calls:

```json
{"node":"worker","dnd":true}
{"node":"worker","dnd":false}
```

Their result includes `node`, `dnd` (active now), `dnd_next_turn` (armed for an idle target), and `turn` (current turn ID or null). Setting an idle descendant returns `dnd:false,dnd_next_turn:true`; clearing it returns both false. There is no silent idle no-op. A named self target can disarm its own pending flag too.

## Do Not Disturb

Self `dnd=true` needs your running turn. A superior/user setting an idle target arms its next turn: the opening batch is admitted normally, then the flag is consumed atomically into that turn's DnD. The desk shows **DND next turn** while armed. Active DnD clears at actual turn end; `done` does not end the turn.

Any authorized `dnd=false` clears active/armed DnD whoever set it, including your own superior's hold, and triggers native delivery immediately without a message-count cap. Codex/Muse steer the exact turn; Claude takes mail at PostToolUse, Antigravity at its next invocation hook, and supported OpenCode at its next tool boundary. No interrupt/restart or turn-end wait is added. Existing size/chunking budgets keep overflow durable for follow-up deliveries; halt/freeze/kill-switch still govern admission. Only urgent mail bypasses an active hold. Explicit inbox fetch/chunk consumes selected held mail; previews do not. See [orgtree-do-not-disturb](../do-not-disturb/SKILL.md).

## See also

- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
- [orgtree-checkups-and-reminders](../checkups-and-reminders/SKILL.md)
- [orgtree-context-and-compaction](../context-and-compaction/SKILL.md)
- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
