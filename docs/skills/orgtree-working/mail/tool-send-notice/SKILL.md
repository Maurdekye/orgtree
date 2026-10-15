---
name: orgtree-tool-send-notice
description: Leave passive Orgtree mail without independently starting a same-organization agent turn.
---

Up: [orgtree-mail](../SKILL.md)

# orgtree_send_notice

Use for information the recipient can read when it next works. If it must act or answer now, use [orgtree_message](../tool-message/SKILL.md). A notice to an idle same-org agent does not independently start a turn, so do not send a blocking request as a notice and wait for an answer.

Required tool group: `messaging`, inherited through the ancestor chain. Top-level status does not bypass recipient reach. This tool uses the same audience and address checks as the message tool.

## Parameters and call

| Parameter | Meaning |
| --- | --- |
| `metadata.to` | Required recipient string or list of up to ten distinct recipients on the split schema. |
| `body` | Required notice text, outside metadata. Must be nonblank for this attachment-free schema. |

Write metadata first, body last:

```json
{"metadata":{"to":"coordinator"},"body":"The reviewed draft is in the shared folder; this is an informational copy."}
```

The Antigravity flat-schema equivalent is:

```json
{"to":"coordinator","body":"The reviewed draft is in the shared folder; this is an informational copy."}
```

The exposed notice schema has only routing and body. For attachment, kind, reply or other message fields, use `orgtree_message` with `notice: true` and its documented parameters. `notice` is a delivery flag, not a mail kind.

## Delivery and limits

For a live same-org agent, the notice is stored for its next turn. An already running agent can receive it at a tool boundary; passive does not mean hidden until the turn ends. Archived/halted/frozen recipient limitations are the same as [ordinary mail](../tool-message/SKILL.md).

The no-wake guarantee does not extend to outside publication: the current `@org:`/`@net:` route does not propagate the passive flag to receiving holder copies. Do not promise that an external organization remains idle because a send used this tool. User mail also follows the ordinary user-inbox access gate.

Lists deliver independently: inspect each outcome, since a permitted recipient can receive a notice while another is refused. Empty recipients, too many distinct recipients, blank body, missing reach/audience, disabled outside inbox and unavailable destinations use the ordinary message refusals. Nothing in this tool grants access or schedules a future rehire/unhalt.

For status reports, [orgtree_status](../../runtime/tool-status/SKILL.md) is the dedicated tool; its done/blocked summary to a superior is also passive.
