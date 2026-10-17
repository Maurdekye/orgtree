---
name: orgtree-inbox-screens
description: Explain user and agent mail views, the org inbox viewer, record search and attachment transfer controls.
---
Up: [orgtree-desk](../SKILL.md)

# Inboxes and transfers

These surfaces share mail cards but have different owners and actions. An agent's Inbox tab/modal is its mailbox; the user Inbox includes the user's incoming questions/mail and sent/record views; the org inbox is the organization's outside correspondence.

## Lists, read panes and replies

Inbox/Sent selects direction. A selected message opens the read pane with sender/time/body, attachments, quotes and exact references. User inbox read actions update read state; failed writes must not be treated as acknowledgment. Pending agent mail says it awaits delivery/next turn; a manual UI read is not proof that the agent consumed it.

Mail bodies support inline Markdown images. Relative image paths resolve within the author's files; absolute Windows paths and HTTP(S) URLs use the checked image endpoint. PNG, JPEG, GIF and WebP are supported there; an image that cannot be loaded falls back to a link (local files can be revealed in their folder).

Mailbox modals collapse their message list into a menu-controlled overlay at 896 CSS pixels or less of reading-area width. Widening restores the column; popouts follow their own content width during snap-layout resizing as well. Moving or resizing retains the mounted list and its state. Inline agent-desk lists stay persistent.

User contextual replies target the original sender(s), can include attachments and notice delivery, and retain the source references. A composed or queued reply is not already delivered. Failed send/read acknowledgment is reported separately. Agent modal/tab shares the mailbox list without becoming an unrestricted human composer for every mailbox owner.

Mail links can switch to the folder containing the referenced message and perform an exact lookup outside the loaded window. A missing row in the current slice is not proof it never existed; failed lookup offers retry.

## Record

The user's Record view shows org operations/events. Search can request the wider record, while the plain view uses a recent window. Event kind, actor and detail are not a conversation transcript. Navigation to an object does not rewrite the recorded operation.

## Org inbox

The org inbox viewer shows external received/sent entries, network custody/read state, attachments and holders. Its unread boundary uses the stored log position, not just the currently rendered tail. Holder controls identify which agents may receive outside mail; applicable org policy can restrict grants.

Human outside composition has moved to Hubchat: the org inbox is a viewer, not a hidden second compose window. Do not suggest a removed reply/composer action. External sender authority belongs to current trust rules; a delivery/read badge does not make content authoritative. See `orgtree-mail-basics` (orgtree-working › mail) for the communication rules.

## Attachment transfers

Transfers appears on supported mail surfaces, initially collapsed. Expand to inspect unfinished work, recent history and paged older transfers. A progress bar measures confirmed bytes; processed/sent/received bytes may be ahead of confirmed custody.

Retry, Cancel transfer and (for eligible failed/cancelled outgoing files) Remove file and send are different. Removing explicitly omits that attachment so the remaining ready message can proceed. Closing the panel does not cancel engine transfer work. Refresh retries a failed panel read, not a new send. Use `orgtree-tool-transfers` (orgtree-working › mail) for exact agent-side actions and custody rules.

## See also

- See `orgtree-mail-basics` (orgtree-working › mail).
- [orgtree-ask-cards](../ask-cards/SKILL.md)
