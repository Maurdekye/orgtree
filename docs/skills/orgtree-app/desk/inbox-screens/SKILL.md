---
name: orgtree-inbox-screens
description: Explain user and agent mail views, the org inbox viewer, record search and attachment transfer controls.
---
Up: [orgtree-desk](../SKILL.md)

# Inboxes and transfers

Private notification projections are excluded from function argument/return logging too; refreshing app notices must not copy mail or ask previews into diagnostics. The app still receives those notification bodies normally.

Single-message reader requests under the mail-by-id route omit their HTTP bodies and private handler returns from diagnostics in both logging modes, while preserving the message delivered to the reader.

User Inbox reads, including historical pages, omit HTTP bodies from wire diagnostics with verbose logging off or on. Private mail projections are also excluded from function-return logging; paths/status and normal client content remain available.

These surfaces share mail cards but have different owners and actions. An agent's or project's Mail tab, and its mail window (titled "· mail"), is its mailbox, with inbox and sent folders (a project's adds listeners); the user Inbox includes the user's incoming questions/mail and sent/record views; the org inbox is the organization's outside correspondence.

## Lists, read panes and replies

Inbox/Sent selects direction. A selected message opens the read pane with sender/time/body, attachments, quotes and exact references. User inbox read actions update read state; failed writes must not be treated as acknowledgment. Pending agent mail says it awaits delivery/next turn; a manual UI read is not proof that the agent consumed it.

Monitor-event list rows use the monitor name shown by the opened card, including
recorded names of spent monitors. Hover the sender for its full stable handle;
sender/body search also accepts that ID. If no name remains, the ID is the label.
Monitor senders use watchdog identity and detail navigation, even when their
name matches an agent. They never acquire that agent's model chip or desk link.
If live monitor metadata is unavailable, the recorded name and handle remain.

Mail bodies support inline Markdown images. Relative image paths resolve within the author's files; absolute Windows paths and HTTP(S) URLs use the checked image endpoint. PNG, JPEG, GIF and WebP are supported there; an image that cannot be loaded falls back to a link (local files can be revealed in their folder).

Mailbox modals collapse their message list into a menu-controlled overlay at 896 CSS pixels or less of reading-area width. Widening restores the column; popouts follow their own content width during snap-layout resizing as well. Moving or resizing retains the mounted list and its state. Inline agent-desk lists stay persistent.

User contextual replies target the original sender(s), can include attachments and notice delivery, and retain the source references. A composed or queued reply is not already delivered. Failed send/read acknowledgment is reported separately. Agent modal/tab shares the mailbox list without becoming an unrestricted human composer for every mailbox owner.

Mail links can switch to the folder containing the referenced message and perform an exact lookup outside the loaded window. A missing row in the current slice is not proof it never existed; failed lookup offers retry.

Loaded older pages reconcile read-state changes and deletion from other windows
when their mailbox revision changes. The reader refreshes its head and only the
IDs already retained, in batches of at most 200, keeping its older-page cursor.
An absent head row alone never proves deletion. Failed or incomplete refreshes
keep the retained rows and offer Retry; they do not silently remove mail.

## User-mail tags

The user's Inbox has one tag dropdown: search narrows a wrapping list of
coloured cards, and clicking cards toggles them on/off. Mail must carry ALL
selected tags (AND); matching ignores case. The list auto-populates only from
tags used by retained user mail and updates as mail arrives or is deleted,
including older mail outside the visible window. All used tags remain reachable
through cursor pages; search does not limit the list to a fixed first page.
Selections show on the closed control; clicking a row/read-pane chip adds it.
The filter intersects existing sender/body search; clear restores untagged mail
and asks. Older matching mail is queried before windowing and pages on scroll.
Sent and Record retain their own views. Opening a new mail reference clears
the tag filter so its target remains reachable. Unread counts still describe
the whole inbox. Failures offer Retry rather than an empty-result claim.

Each chip has a stable hue hashed from the normalized tag name, with fixed
saturation/lightness for the light/dark contrast palette. The first committed
spelling in the org supplies every chip's label. Agents use `orgtree_message`
with `tags:["alpha build"]`; see `orgtree-tool-message` (orgtree-working, mail).
The tool accepts up to eight tags for user-bound mail only; tags stay local.

Tag pills are 10px, never wrap, and ellipsize long labels. A list row puts one
pill plus +N at the start of the message preview, preserving sender/kind/time.
The reading pane and filter use the same pill. User-inbox reply.mail omits the
Mail reply kind label/icon; its In reply to quote and other kind labels remain.

The user's Inbox row context menu also offers **Delete** for a received message.
It asks for confirmation, then permanently removes only the user's copy; other
recipients' copies, sender history and attachment files remain. Tag membership
and unused tag suggestions disappear with the message. There is no bulk-delete,
toolbar or keyboard action.

Deletion is refused while that inbox copy is needed to acknowledge a project
job the user still holds. Open the message and use **Acknowledge job** (self-sent),
**Reply & acknowledge**, or **Acknowledge without reply**, then delete it.
Deleting, reading or leaving the queue never implicitly acknowledges a job.
After ACK, deletion works normally and keeps the project's original and history.
There is no user release/NACK action; agents cannot acknowledge the user's job
through their tools.

Within the current app session, reopening the user's Inbox restores and scrolls
to the last opened received message for that org when no new mail has arrived.
If new mail arrived, the message is no longer retained, or the active filters
exclude it, the inbox keeps its normal selection behavior. This memory does not
survive an app restart.

## Record

The user's Record view shows org operations/events. Search can request the wider record, while the plain view uses a recent window. Event kind, actor and detail are not a conversation transcript. Navigation to an object does not rewrite the recorded operation.

For the project Mail tab/window, listeners folder and queue history, see [orgtree-project-desk](../project-desk/SKILL.md).

## Org inbox

The org inbox viewer shows external received/sent entries, network custody/read state, attachments and holders. Its unread boundary uses the stored log position, not just the currently rendered tail. Holder controls identify which agents may receive outside mail; applicable org policy can restrict grants.

Human outside composition has moved to Hubchat: the org inbox is a viewer, not a hidden second compose window. Do not suggest a removed reply/composer action. External sender authority belongs to current trust rules; a delivery/read badge does not make content authoritative. See `orgtree-mail-basics` (orgtree-working › mail) for the communication rules.

## Attachment transfers

Transfers appears on supported mail surfaces, initially collapsed. Expand to inspect unfinished work, recent history and paged older transfers. A progress bar measures confirmed bytes; processed/sent/received bytes may be ahead of confirmed custody.

Retry, Cancel transfer and (for eligible failed/cancelled outgoing files) Remove file and send are different. Removing explicitly omits that attachment so the remaining ready message can proceed. Closing the panel does not cancel engine transfer work. Refresh retries a failed panel read, not a new send. Use `orgtree-tool-transfers` (orgtree-working › mail) for exact agent-side actions and custody rules.

## Reading and acknowledging project jobs

An unread real message whose body has been displayed is marked read when it leaves the reading pane: selecting another message, clearing selection, changing a folder/filter/tab, closing the panel, switching organizations or closing its native window all use that rule. Merely loading a row is not reading it; question cards have their own answer flow. Failed read saves remain failures. If a close-time save fails and the panel stays open, a later leave or close retries it. Pending saves coalesce, and a successful save is not sent again by that same displayed reader.

A project job delivered to the user in ACK mode adds the project-job tag and acknowledge pane. Reply & acknowledge sends an ordinary reply to its sender, then acknowledges the assignment; Acknowledge without reply sends no response. A self-sent job offers Acknowledge job without a reply box. Reading, closing or leaving the queue never acknowledges a held job. See [project desk](../project-desk/SKILL.md#the-users-own-slots-listeners-and-queue-place) for joining, changing the batch and leaving.

## See also

- See `orgtree-mail-basics` (orgtree-working › mail).
- [orgtree-ask-cards](../ask-cards/SKILL.md)

## Mail mentioning the user

Unread mail with a standalone @user in its visible prose, title/subject or quoted context shares urgent mailbox attention and clears when read. It is not labeled urgent unless its sender actually marked it urgent. The needs-attention list shows one mail row instead of a duplicate matching mention blurb. Failed reads restore unread attention.
