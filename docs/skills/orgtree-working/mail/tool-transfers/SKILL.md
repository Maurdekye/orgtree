---
name: orgtree-tool-transfers
description: Inspect bounded hub attachment progress and explicitly retry, cancel or omit eligible transfer jobs.
---

Up: [orgtree-mail](../SKILL.md)

# orgtree_transfers

Use the transfer IDs returned by [orgtree_message](../tool-message/SKILL.md) to inspect hub attachments. A queued mail waits for all remaining outgoing files to upload; incoming mail waits for its downloads before publication. This tool controls those jobs, not [local download cards](../../user/tool-send-file/SKILL.md).

Required tool group: `messaging`, through the ancestor chain. You see your own outgoing sends under your current agent identity/generation, plus incoming jobs when you are an effective live org-inbox holder. A guessed ID never gives access to another sender's transfer. Being top-level alone does not expose every transfer. Disabling the org inbox makes this outside-communication inspection/control unavailable.

## Actions and parameters

Only `action`, optional `id`, and optional `cursor` are accepted; extra fields refuse. `id` is required for every action except list.

| Action | Effect and eligibility |
| --- | --- |
| `list` | At most one hundred accessible jobs, unfinished first, then completed/removed history newest first. Pass returned `next_cursor` as cursor for the next page. |
| `get` | Inspect one accessible ID through the same authority check. Returns a transfers array, not a raw file path. |
| `retry` | Outgoing states failed/cancelled/retry_wait/paused; incoming states failed/cancelled/retry_wait. Clears the error and queues another attempt. |
| `cancel` | Stops an eligible network request and holds its message. Outgoing queued/retry_wait/preparing/uploading/confirming/failed/paused; incoming queued/retry_wait/downloading/failed. |
| `remove` | Explicitly omit a failed/cancelled outgoing file while its mail is still queued. Retains audit state and releases the message when all remaining files are ready. Never removes an incoming file. |

Minimal inventory call:

```json
{"action":"list"}
```

Then inspect `{"action":"get","id":"<returned-transfer-id>"}` as needed. A cursor is opaque; reuse the returned value unchanged. There is no limit/page-size argument.

## Interpret the result

Jobs expose direction, message ID, peer, state, attempt, error and update time. Uploads have filename and byte totals; incoming message jobs have a files list with file-level counters/completion/restart reason. Source paths and credentials are not exposed.

`processed` means bytes handled by the transfer work; `confirmed` means bytes confirmed at the other end. Neither alone is a completed job or a consumed message. Upload/file completion still precedes sending/publication of the message. Inspect every remaining file rather than assuming the first job is the whole delivery.

Successful progress/completion sends no separate notification. Terminal failures can generate a user notice and mail to involved agents; intentional user cancellation is silent. A rename does not transfer an outgoing job to another agent taking the old name, and old generations/legacy uncaptured identities remain outside the new agent's control.

## Recovery boundaries

Cancellation holds the message instead of sending a partial payload. A prior request may still be closing file handles: retry/remove can refuse with `transfer is still stopping; retry in a moment`. Completed/delivering/ineligible jobs refuse the action with an explanation; get/list may show newer state than the original send result.

Remove changes the intended payload. Use it only when omission is authorized; otherwise retry or report the error. An incoming message keeps every file, so its failed file cannot be discarded through remove. Retrying the original **message send** instead of its job can duplicate correspondence.

Typical refusals are malformed cursor, unknown action, extra fields, missing ID, inaccessible transfer, disabled org inbox, ineligible state, and remove on an incoming or still-active outgoing file. Inspect current state after an uncertain mutation before repeating it.

## See also

- [orgtree-mail-basics](../mail-basics/SKILL.md)
- [orgtree-chain-and-audiences](../chain-and-audiences/SKILL.md)
- [orgtree-external-mail](../external-mail/SKILL.md)
- [orgtree-org-inbox](../org-inbox/SKILL.md)
