---
name: orgtree-tool-inbox
description: Recall your own correspondence and read waiting or historical Orgtree mail with bounded pages and chunk continuations.
---

Up: [orgtree-mail](../SKILL.md)

# orgtree_inbox

Use to recover your own mail context, especially after a fresh session or compaction and before replying to a correspondent. This is not another agent's mailbox reader. Required tool group: `messaging`, through the ancestor chain; top-level agents have the same own-mail boundary.

## Actions and parameters

`action` is required. Each action accepts only its listed fields; a `node`, `agent`, `org` or `mailbox` argument is refused.

| Action | Fields and defaults | Returned content |
| --- | --- | --- |
| `list` | Optional `limit`, default 50, clamped to 1–200; optional `cursor`; optional `project`. | Your pending/delivering mail in ID order, with IDs, sender, kind, time, state, notice flag and previews. |
| `conversation` | Required `peer`; optional `limit`, default 20, clamped to 1–100; optional `cursor`. | Both directions with one correspondent, newest page first, oldest to newest within that page. Previews only. |
| `fetch` | Required `message_ids`, one to twenty strings; duplicate IDs collapse; optional `project`. | Mail you received or sent, including your own outside sends; first content chunk plus metadata, attachments and replies. |
| `chunk` | Required `delivery_id`, `message_id`, zero-based nonnegative `chunk_index`. | One content chunk from the immutable fetched message. |

`project=<name>` (list and fetch only) reads a project node's mailbox instead of yours: the mail still waiting there for a `fair_queue` watcher. It claims nothing, so the mail stays waiting. Only the user and agents above or below the project may read it ([orgtree-projects](../../team/projects/SKILL.md)).

`peer` accepts an agent name, `user`, `@org:<slug>` or `@net:<address>`. Historical agent mail can remain readable after retirement/deletion. You cannot select yourself as the correspondent. Bare outside-name resolution follows [mail routing](../tool-message/SKILL.md); prefer explicit prefixes to avoid ambiguity.

Minimal recall call:

```json
{"action":"conversation","peer":"coordinator"}
```

Use the returned message IDs for `fetch`, then use fetched handles for `chunk`; do not invent a handle or substitute a transfer ID.

## Paging and long bodies

`list` and `conversation` return `has_more` and `next_cursor`. Pass that exact cursor to the same action/peer for the next page. Conversation cursors page backward to older mail. A cursor is scoped to your identity; it is not an offset or a reusable cross-agent token.

Conversation previews stop at 500 characters, and a page has a 16,000-character preview budget, which can shorten it below the requested count. A `cut` marker means the message needs fetch for full context. Follow cursors until the range needed for the task is covered; do not infer missing history from a single page.

Fetch serves at most 256 KiB of content per response. Inspect `not_found` and `deferred_ids`; deferred entries can be fetched separately. Bodies are split at UTF-8 boundaries into chunks of at most 64 KiB. The result carries `body_bytes`, `body_sha256`, `chunk_index`, `chunk_total`, `chunk_sha256`, `content`, `content_state`, `complete`, and the `delivery_id` continuation handle. Concatenate content in chunk-index order to reconstruct the body. More than one chunk means the first fetch is not the whole text.

The handle binds your agent, message and body digest. It is valid across restart while that immutable mail remains available. Wrong handles, out-of-range indices, malformed/foreign cursors and inaccessible IDs refuse or appear in the response's missing list; do not retry with guessed identities.

## Delivery and outside-mail policy

Successful `fetch` and valid `chunk` consume the pending received messages whose content is actually returned, including outside DND. They count as read and delivered and will not enter automatic input again. Missing IDs and output-budget deferred messages are not consumed. A fetched sent row's state belongs to its recipient, not to you; fetching it sends no receipt on their behalf.

Opened received and project mail appears as ordinary mail entries immediately after the containing tool call in your transcript. Existing delivery receipts prevent duplicates, including repeated chunks and already displayed automatic deliveries. Sent history, `list` and `conversation` previews add no transcript entries. Project reads leave the queue unclaimed and unchanged.

Disabling the organization's outside inbox hides its outside history/related copies from these reads; it does not erase them. Re-enabling can restore access. Same-org mail remains separate. Reading an old external body does not reinstate a removed sender-authority note.

Use fetched IDs with [orgtree_message](../tool-message/SKILL.md) for replies. A manual read records an explicit content read; it does not prove understanding or human acceptance.

## Explicit reads during Do Not Disturb

During DND, the same explicit content-read rule excludes returned held messages from the end-of-turn batch and changes sender status to read. `list` and `conversation` previews stay held and unread. Project mailbox inspection remains non-consuming. See [orgtree-do-not-disturb](../../runtime/do-not-disturb/SKILL.md).

## See also

- [orgtree-mail-basics](../mail-basics/SKILL.md)
- [orgtree-chain-and-audiences](../chain-and-audiences/SKILL.md)
- [orgtree-external-mail](../external-mail/SKILL.md)
- [orgtree-org-inbox](../org-inbox/SKILL.md)
