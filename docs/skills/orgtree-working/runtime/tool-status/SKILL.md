---
name: orgtree-tool-status
description: Report your work status and understand which reports reach your superior.
---

Up: [orgtree-runtime](../SKILL.md)

# orgtree_status

## Call contract

Report working/done/blocked/idle. Optional dnd=true holds non-urgent mail for this turn on every harness, including Antigravity, avoiding mid-turn interrupt/cache loss. Only urgent mail bypasses it. DND clears when the turn actually ends; unread mail arrives as one ordered batch within the prompt size budget. dnd=false releases early. Explicit inbox fetch/chunk reads held mail without replay; previews do not. done is a report, not a turn end.

Report a meaningful change in your own work. Call it when finished (`done`) or stuck (`blocked`); use `working` when work resumes. It updates your status chip and history. It does not complete a docket item or end the turn that is currently running.

## Parameters

| Parameter | Required | Meaning |
|---|---|---|
| `status` | Yes | `working`, `done`, `blocked`, or `idle`. |
| `summary` | Yes | One or two sentences describing the result, next step, or blocker. The handler collapses whitespace and shortens it to a 600-character gist. Put durable detail in the docket. |

`done` records an idle current status, while the event records that you reported done. Do not follow it with a separate idle report. `blocked` describes work needing input or an external change; it does not install a wake trigger. Arrange how the answer or event will reach you.

## Delivery and permissions

This tool has no Orgtree tool-group prerequisite: status reporting stays available even when all groups are disabled. It still acts as your authenticated agent; it has no `node` argument for reporting somebody else's status.

Only `done` and `blocked` send the summary to your direct superior, as a passive notice. `working` and `idle` update the record without that mail. A top-level agent has no superior, so its report updates its chip without sending a duplicate user digest. Communicate actual results through the appropriate mail channel when needed.

A status never wakes the superior. If action is needed now, send a [message](../../mail/tool-message/SKILL.md) as well. Keep the [docket](../../docket/tool-work/SKILL.md) current separately.

An unsupported status is refused with `status must be working, done, blocked or idle`; a missing/empty status is refused as required. Supply both declared arguments even though the handler tolerates an absent summary as empty text.

## Example

```json
{"status":"done","summary":"The parser fix is committed and its focused checks pass; the review evidence is on the docket."}
```

## Do Not Disturb

Optional `dnd=true` holds incoming non-urgent mail for this running turn, on every harness, including Antigravity. `dnd=false` releases early; omission retains the current mode. Only urgent mail bypasses it, regardless of sender. DND clears on actual turn end, then unread mail is admitted in one ordered batch within the hard prompt size budget; overflow remains durable. A `done` status report does not itself end the turn. See [orgtree-do-not-disturb](../do-not-disturb/SKILL.md) for manual fetch/chunk reads and urgent controls.

## See also

- [orgtree-turns-and-wakes](../turns-and-wakes/SKILL.md)
- [orgtree-turn-envelope](../turn-envelope/SKILL.md)
- [orgtree-checkups-and-reminders](../checkups-and-reminders/SKILL.md)
- [orgtree-context-and-compaction](../context-and-compaction/SKILL.md)
- [orgtree-halts-and-restarts](../halts-and-restarts/SKILL.md)
