---
name: orgtree-inbox-screens
description: Explain user and agent mail views, the org mailbox viewer and attachment transfer controls.
---
Up: [orgtree-desk](../SKILL.md)

# Inboxes and transfers

## Your inbox as chats

Since 4.7.0 the user's Inbox opens as chats, like Hubchat: a list of chats on the left, one conversation on the right and one message box under it. It is a second view of the same mail, requests and audiences the classic mailbox shows; sending, delivery, read state and audiences work exactly as before. Its icon is a chat bubble in the header, on the eye card and in the panel title. The panel is still called Inbox, and each organization has its own, listing only that organization's agents.

**Which chats are listed.** One chat for every live top-level agent (an agent with no agent above it; projects in between do not count), and one for every agent or project that holds an audience with the user. An agent whose audience comes only through a project has a chat under that project's, whether or not it has written. Orgtree's own notices and decisions (sender `@system`) share one chat named **System**: its picture is the system's icon, not an agent's letter, and each of its messages is tagged **S**. Any other sender is listed only while something of theirs is unread or one of their requests is open, so unread mail is never hidden. Retired audience holders come last and dimmed, and are left out while **Hide retired agents** is on. Chats with messages are ordered newest first; chats without any follow in the tree's order. A row shows the last message (**You:** before the user's own), its age, the unread count, and **?** while a request from that agent waits on an answer. The search box filters by name, and **Mark all read** shows while anything is unread.

**Agents under their project.** An agent that reaches the user only through a project's audience is listed under that project's row, indented, as a sub-item is under its ticket in the docket. Within a project the most recently active agent comes first and those that have never written come last, and the project is placed in the list by the newest activity of itself or of those agents. The arrow on the project's row folds the group; it is open by default, and a fold lasts while the panel is open. A fold hides only agents with nothing waiting: one with unread mail or an open request, and the chat on screen, stay listed under the project. A search shows through folds. An agent that also holds its own audience, and a top-level agent, are listed on their own.

**A row's menu.** Right-click a chat row for **Open chat**, what its close does by name, **Copy mention** (the chat's @name), and **Agent…** or **Project…**: the full menu that agent or project has on the canvas, as a submenu. An agent listed under a project also has **Acquire audience** at the top: the same action as in its Agent… submenu. It gives the agent its own audience, so it moves out from under the project and reads **(and via** the project**)**. The System chat has no such entry.

**Audience requests.** An agent or project that asks for an audience with the user appears as a new chat, marked and first in the list, the newest request on top. Its chat shows who asks and why, with **Approve** and **Deny**. Writing to that chat approves the request too: the audience is granted and then the message is sent. Closing the chat denies the request, at once and without a confirmation.

**Closing a chat.** The close control is in the chat's header and on its row (on hover). For an audience holder it revokes exactly that audience grant, at once and without a confirmation. The mail is kept; the chat comes back when the audience is granted again or that agent has unread mail. A top-level agent's chat cannot be closed: the control is disabled and its tooltip says the agent always has a direct line. For a top-level agent that also holds a grant, close revokes the grant and the chat stays; the tooltip says so before the click. The System chat cannot be closed. A chat that is only an audience request closes by denying the request.

**Audiences through a project.** Beside the audience badge, an agent that reaches the user only through a project shows **via** and that project as a link; an agent that also holds its own audience shows **(and via** the project**)**. Closing an agent that has only the project's audience closes the PROJECT's audience, exactly as closing the project's own chat does. With both, the first close revokes the agent's own audience and the chat stays; the next close is the project's. Hovering or focusing a close that would revoke a project's audience marks the project's row and the row of every agent that would lose its audience with it (an agent with its own audience, and a top-level agent, lose nothing). If any agent would lose it, that close asks first, in the app's own confirmation, and names them. It is the only close that asks.

**New chat** (beside the search box) sweeps the canvas's agents list out from the left, over the chat list: the same rows, filter box, archived fold, active-only checkbox and agent menus, in the same size. It fills the chat list's column and scrolls inside it, and the open chat stays in view beside it. Picking an agent opens its chat; one that cannot write to the user yet is given an audience first. Its close button, Escape, a pick and a press anywhere outside it sweep it back; none of them closes the Inbox, also in a pinned or popped-out Inbox. That outside press still does what it was for (a chat row's press opens that chat). Presses inside it, including in a row's menu and its submenus, keep it out.

**Who is listed.** A chat needs someone the user can write to: a top-level agent, or a live agent or project that holds an audience (its own or through its project). A retired agent that held an audience, and a name the organization no longer has, get no row. A retired agent's chat can still be opened (from a reference to its mail, or New chat with the archived fold open): it is then listed as the selected row and marked retired, its history can be read, it cannot be written to, and the row leaves when another chat is selected. Unread mail is never hidden, whoever sent it.

**Messages.** Mail runs oldest to newest with the user's own on the right, day separators, and an **N new messages** line where the unread mail began when the chat was opened. A notice keeps a message's fill and has a thick dashed border in the colour of the chat's background, with no label; request, question and decision mail carry a small label; files are the usual chips and image previews. Hover a message for **Reply** and **Copy**; its context menu adds Mark as read, Delete and **Sender…**, then its View in entries together: **View in classic inbox** (the classic mailbox on the message's folder, with it selected and scrolled into view), **View in transcript** and **View in @agent's inbox** (that agent's mailbox, at this message; for mail in both directions), then Copy reference. The user's own message that the agent has not taken yet has a small **×** after its check: it takes the message back exactly as the desk's queued-strip × does (also **Retract (undelivered)** in its menu); a refusal names the reason and keeps the message. **View in chat** is on the user's mail with an agent or project in the classic mailbox, that agent's mailbox and its desk's Mail tab: it switches the Inbox to the chats, opens that chat and flashes the message. While the chats are on, a click on a mail link to such mail anywhere opens it the same way; a mail link's menu offers **View in chat** and **View in classic inbox**, each switching the Inbox's view first. With notice sending on, the message box's bell is crossed out and its dashed border is sparser. **Sender…** on an agent's message is that agent's full menu, the one its links and its card open; the user's own messages have none. The user's own message can be answered too: **Reply** on it sends the reply to the chat's agent with that message quoted. **View in transcript** opens the agent's desk at the message's row: the message in which the agent sent it, or the row where the agent received yours. The agent's own messages always have the entry; yours has it once the agent has taken the message (the check mark below) and not before. As the desk lands on it, the message flashes once (for a message the agent sent, the line of the call that sent it), also when the row first had to load with older history. If the row is in the transcript no more, the desk shows the nearest time and says so, without a flash.

**The @ menu.** In a chat's message box the @ menu lists what that chat's loaded messages mention first, newest mention first, as a desk does with its transcript. The rest follow in the usual order, tickets by their latest status change.

**Stream privacy.** With Streamer mode on, the chats hide what the classic mailbox hides: addresses, keys and outside names in a message, in a quote card, in a chat row's preview and in the reply bar, and an outside sender's name in the chat list and the chat's header. Agents' and projects' names are never hidden.

**Keyboard.** As in Hubchat: **Shift+Tab** in the message box highlights the newest message; **Shift+Tab** again goes to older ones and **Tab** to newer ones, loading older messages as it reaches them. **R** stages a reply to the highlighted message, the Menu key opens its menu, and **Escape**, or **Tab** past the newest message, returns to the message box. **Escape** with a file in the message box removes the file added last, one a press, before it does anything else.

**Agent links open the chat.** Anywhere in the app, a click on the name of an agent that has an audience with the user (its own or through its project) opens the user's chat with it, also a name written in a message, a presentation or a ticket. Other agents' links go to the desk, as before, and so does the name in the header of the chat that is already open. Every agent's and project's menu has **Open ▸ Chat**, which also grants a missing audience first (see context menus), and keeps **Focus** for the desk. The classic mailbox leaves every link as it was.

**Read mark.** Each of the user's own messages to an agent has one check after its time: grey while the agent has not read it yet (it is busy, on Do Not Disturb or not running; the tooltip says which), green once it has. Read means the agent's CLI took the mail into its context, or the agent fetched it from its inbox. It turns green by itself. An organization on an older engine shows no mark.

**Typing.** While an agent is writing a message to the user, its row in the chat list reads **typing…** and its open chat shows three dots with "<name> is typing…" under the last message. Only Claude Code agents report it; other agents show nothing, and nothing is guessed. The classic mailbox does not show it. Reply stages that message above the box (several can be staged; Escape clears them). A reply's quote card shows its original in the same chat and marks it, also for an older message, which is loaded first; only a message that is not in this chat's history opens where the quote would open elsewhere. A typed reply has no Context fold in a chat. A project job keeps its acknowledge pane.

**Long chats.** A chat draws its newest 50 messages when it opens. Older ones come by themselves as the top comes near, 50 at a time: first the mail already loaded, then the next page; the message in view stays exactly where it is. There is no button. A chat that does not fill its view when it opens loads older mail the same way until it does or the history ends. An agent's chat and the System chat read their own history, so every page holds 50 messages of that chat. A project's chat reads the whole mailbox's history, one list for every chat: after three pages in a row with nothing of this chat, a full view waits until the reader scrolls, and a view that does not scroll reads on by itself, a page a second, until it fills or the history ends. A chat in an organization on an older engine reads the same way as a project's. Back at the newest message with more than 300 drawn, the chat keeps 100.

**Staying at the newest message** works as in Hubchat. Within 80 px of the bottom the chat is stuck there: a message sent or received, the typing row or a picture that loads late keeps the newest message in view, and sending always goes to the bottom. Scrolled further up, the chat stays where the user is and a round button at the lower right ("Jump to the newest message") goes back down and sticks again.

**Requests** (questions, credit requests and scope requests) appear in the asking agent's chat and work as on its desk: the same choices, one submit, the same recorded answers. In a chat each tab of a request is its own bubble, all of them on screen, with the submit under the last. A question with options offers **Other** for a typed answer; one without options is a free answer. Resolved requests stay in the chat as their answered cards.

**A project's chat.** A project that holds an audience with the user has a chat (the user wrote to it, or it was granted one), and that chat is one thread, as an outside conversation is for a project that holds the org mailbox. The user's message to a project is a job in its mail queue: its bubble says **waiting in the queue**, **held by** the agent the queue handed it to, **acknowledged by** that agent, or that nobody took it. The copies the queue makes for a hand-out, a relay or a re-hand-out are not shown as messages. A member's answer to its job is in the project's chat under that agent's name; mail the member writes on its own stays in its own chat. **Reply** on a member's bubble writes to that member. **Follow up on this message**, on the user's own message, writes to the project naming that message: while its job waits it is bundled with it, while an agent holds the job un-acknowledged it goes to that agent, and otherwise it is a new job. A new message typed in the project's chat is always a new job. The project chat's message box has the project desk's megaphone button, in the same place (on the box's right, above send), with the desk's wording and Alt+B: armed, the next message goes to every live agent under the project (through sub-projects, not below an agent) by the desk's own broadcast, and the megaphone turns off after that one send; it is disabled while no agent works under the project. As on the desk, the box says **Messages sent here may not be read by anyone** while no agent listens on the project's inbox and the megaphone is off, and it offers the urgent option when an armed send would reach an agent in Do Not Disturb. A megaphone send (from the chat or the desk) shows in each member's chat and once in the project's chat, as a record that names how many agents it went to; megaphone messages have their own teal fill. A project appears with its own icon and colour everywhere in the chats: its row, its header, the **via** link and the megaphone label.

**The header and the message box.** The name in a chat's header is the agent link used everywhere (click to go to the agent, right-click for its menu). Right-click the header (outside the name) for **Copy mention**. The gear beside the close control opens that agent's or project's settings window over the Inbox, which stays open under it: the chat, its place and what was typed are there when the settings close. The chips beside the name (top-level, audience, retired) share one shape. Hovering anywhere on a chat's row shows the agent link's hover.

**Reading.** A chat's unread mail is marked read while that chat is on screen in the window the user is using; in a window that is not in front it stays unread until they return. A chat opens at its first unread message, else at its first open request, else at its newest message. The header count keeps its rule: open requests and urgent mail come before the plain unread count.

**Writing.** The message box is the desk's message box: the notice toggle over the attach button at the left, the text, and at the right fast mode over effort and the round send button (for an agent; an agent in Do Not Disturb also has the urgent option). It grows with its text, takes attachments and mentions, and follows the app's Enter key setting. Up and Down on the first or last row recall what was sent to that agent, the same history its desk's box walks and records into; the draft is set aside and comes back with Down or Escape. Each chat keeps its unsent text, attached files and reply targets while the app runs: they are there after another chat was opened and after the Inbox was closed. Nothing is written under the box. A sent message shows in the chat at once, with a clock until the engine has it; then the engine's own message takes its place. A refused one stays in the chat, marked **Not sent** with the reason, and a toast says why: **Retry** sends it again, **Discard** removes it and puts its text and files back in the box (both also in its right-click menu). Files dropped anywhere on the chat are attached as pasted ones are. Right-clicking a web link in a message gives **Open link** and **Copy link**; selected text keeps its own menu (**Reply to selection**, **Copy**, **Select All**). A message whose files are still moving shows each file's progress and state, over a picture and under a file card, from the same list as the mailbox's transfers tab. A new message typed here (not a reply, not a notice) tells the agent that it came from the user's chats and must be answered by mail to the user, because the chats show only mail; see `orgtree-reaching-the-user` (orgtree-working › user). Retired agents and the Orgtree chat cannot be written to.

**Narrow windows.** At 896 CSS pixels or less of reading width the chat list becomes the menu-controlled overlay the other mail lists use; picking a chat closes it. New chat sweeps out inside that overlay, and the agent picked there closes it.

**The frame.** The two panes fill the Inbox edge to edge in its modal (under its title row, which keeps classic, pop out, pin and close), pinned and popped out.

**Classic mailbox.** The **classic** checkbox in the panel's title bar, and **App settings > Display > Mailbox > Classic mailbox**, bring back the mailbox the rest of this page describes, with the mail icon. The choice is saved on this computer for every organization and window. The tag filter exists only in the classic mailbox. While the chats are on, replying to a presentation or a ticket opens the chat of the agent that received the reply; see [input and startup display](../../app-settings/app-display-input-and-startup/SKILL.md).

Agents reach the same actions through their tools: an audience is granted or revoked with `orgtree-tool-audience` (orgtree-working › mail), and mail to the user is `orgtree-tool-message` (orgtree-working › mail). The view, its icon and the two settings are the user's display choices; no tool changes them.

## Reply to selected mail text

In a live mail reply context, highlight a passage and right-click **Reply to
selection**. The shared menu also offers **Copy** and **Select All**, with
platform shortcut hints. Copy uses the selected text; Select All selects text
in the current document without editing it. The passage stages
beside the owning reply box without sending, replacing its text, or changing
the recipient. Several passages can be staged; remove one, **Cancel all
selections**, or Escape in the composer clears them. Explicit whole-message
reply targets can accompany selected passages. A refused selected reply returns
to an empty composer. If you started a newer draft, its text, attachments and
selections stay intact; the refused reply appears separately as **Reply not
sent**, with its original text, attachments, whole-message target and all its
selected passages. Expand it to inspect the retained content. **Restore reply**
fills an empty composer without sending; send or clear the current draft first.
Each refused reply is retained separately, so restoration never combines or
truncates selections beyond the eight-passage limit. A changed recipient keeps
the refused reply under its original recipient; return there to restore it.
Recovery is local to this open reply box, not a persisted draft archive.

Quotes retain exact source text (including Markdown syntax inside the selected
range), nearby context and a source version. **Nearby context** expands the
snapshot. Activating the quote checks current source text, opens only a verified
source, and reports **Source unchanged**, **Passage relocated**, **Source changed**
or **Source unavailable**. The saved excerpt remains readable in every case.

One gesture must stay within one source part; a rendering/source mismatch
disables the reply action with a reason. Ref chips and rendered math map to
whole original tokens. Copy buttons and other display-only chrome are excluded.
Limit eight passages, 4,096 UTF-8 bytes each and 48 KiB combined metadata.
Ordinary editable-field menus stay intact. The org mailbox remains a viewer;
selection does not add outside composition or acknowledge project jobs.
Agents have matching exact source reads (`orgtree-tool-read-reply-source`,
orgtree-working › inspection) and selection replies (`orgtree-tool-message`,
orgtree-working › mail).

Ticket and presentation links in a mail reading pane offer Mention and Reply
while its reply box is live, including Reply & acknowledge for queue jobs.
They insert a reference or stage that object as
the reply context in this box, keeping its recipient and draft text. Sending
uses the selected object context; remove it to return to the original mail
reply. A failed send restores the draft and its selected object. See
[composer routing](../desk-chat/SKILL.md#composer).

Tag-filtered user Inbox pages have the same diagnostic privacy boundary as ordinary reads: the HTTP body and private handler return are omitted in both logging modes; filtering results and tag labels remain available to the client.

The org mailbox viewer omits retained outside-mail bodies from HTTP and handler-return diagnostics with verbose logging off or on. The viewer still receives complete entries and counts, and route/status metadata remains logged.

Agent and project mailbox reads, including history pages, omit private HTTP bodies and mailbox helper returns from diagnostics in both logging modes. The reader still receives full message content; route/status metadata remains logged.

Private notification projections are excluded from function argument/return logging too; refreshing app notices must not copy mail or ask previews into diagnostics. The app still receives those notification bodies normally.

Single-message reader requests under the mail-by-id route omit their HTTP bodies and private handler returns from diagnostics in both logging modes, while preserving the message delivered to the reader.

User Inbox reads, including historical pages, omit HTTP bodies from wire diagnostics with verbose logging off or on. Private mail projections are also excluded from function-return logging; paths/status and normal client content remain available.

These surfaces share mail cards but have different owners and actions. An agent's or project's Mail tab, and its mail window (titled "· mail"), is its mailbox, with inbox and sent folders (a project's adds listeners); the user Inbox includes the user's incoming questions/mail and sent views (drawn as [chats](#your-inbox-as-chats) unless the classic mailbox is chosen); the org mailbox is the organization's outside correspondence.

## Lists, read panes and replies

Inbox/Sent selects direction. Each row says how long ago the message arrived or was sent, on the one scale every list uses (minutes, hours, then days, weeks, months and years), with the full date and time on hover (user 2026-10-29). A selected message opens the read pane with sender/time/body, attachments, quotes and exact references. User inbox read actions update read state; failed writes must not be treated as acknowledgment. Pending agent mail says it awaits delivery/next turn; a manual UI read is not proof that the agent consumed it.

Monitor-event list rows use the monitor name shown by the opened card, including
recorded names of spent monitors. Hover the sender for its full stable handle;
sender/body search also accepts that ID. If no name remains, the ID is the label.
Monitor senders use watchdog identity and detail navigation, even when their
name matches an agent. They never acquire that agent's model chip or desk link.
If live monitor metadata is unavailable, the recorded name and handle remain.

Mail bodies support inline Markdown images. Relative image paths resolve within the author's files; absolute local file paths and HTTP(S) URLs use the checked image endpoint. PNG, JPEG, GIF and WebP are supported there; an image that cannot be loaded falls back to a link (local files can be revealed in their folder).

The checked image endpoint has shared [Markdown image limits](../desk-chat/SKILL.md#markdown-image-limits), including size/dimensions, private-address and local-link refusals. A link fallback can mean an embed was rejected rather than that the message's URL is absent.

Mailbox modals collapse their message list into a menu-controlled overlay at 896 CSS pixels or less of reading-area width. Widening restores the column; popouts follow their own content width during snap-layout resizing as well. Moving or resizing retains the mounted list and its state. Inline agent-desk lists stay persistent.

User contextual replies target the original sender(s), can include attachments and notice delivery, and retain the source references. A composed or queued reply is not already delivered. Failed send/read acknowledgment is reported separately. Agent modal/tab shares the mailbox list without becoming an unrestricted human composer for every mailbox owner.

Mail links can switch to the folder containing the referenced message and perform an exact lookup outside the loaded window. A missing row in the current slice is not proof it never existed; failed lookup offers retry.

A message that cannot be displayed shows "This message could not be shown" in its place, in the list or the read pane. The rest of the mailbox keeps working, and a crash report is saved.

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
Sent retains its own view. Opening a new mail reference clears
the tag filter so its target remains reachable. Unread counts still describe
the whole inbox. Failures offer Retry rather than an empty-result claim.

Each chip has a stable hue hashed from the normalized tag name, with fixed
saturation/lightness for the light/dark contrast palette. The first committed
spelling in the org supplies every chip's label. Agents use `orgtree_message`
with `tags:["alpha build"]`; see `orgtree-tool-message` (orgtree-working, mail).
The tool accepts up to eight tags for user-bound mail only; tags stay local.

Tag pills are 10px, never wrap within a label, and ellipsize long labels. Every
mail list row shows up to four tags in stored order. Active filter matches
come first in filter order, then other stored tags fill the remaining places.
Five or more tags show four plus **(+n)**, counting every hidden tag; hover
the count for their names. It does not expand on click. Chips may wrap within
a narrow row, preserving sender/kind/time. The open message, tag picker and
filter bar keep all tags. User-inbox reply.mail omits the
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

For the project Mail tab/window, listeners folder and queue history, see [orgtree-project-desk](../project-desk/SKILL.md).

## Org mailbox

The org mailbox viewer shows external received/sent entries, network custody/read state, attachments and holders. Its unread boundary uses the stored log position, not just the currently rendered tail. Holder controls identify which agents may receive outside mail; applicable org policy can restrict grants. A received message's detail names, after its sender, every agent the engine delivered it to (`-> @agent as @org:<slug> @agent as @org:<slug>`, the outbox's attribution line the other way round, each agent followed by the Sent tab's own "as @org:<slug>"): a live agent is a link to its desk, a retired or removed one is still named in a dim chip that goes nowhere, and a message with no delivery record (older mail, or mail held under Do not disturb that nobody has pulled) names no one. The list row names only the sender. The list is never sent outside: no hub message, receipt or reply quote carries it.

A link into the org mailbox opens Received or Sent, whichever holds the message, including one older than the loaded list. Picking the other folder then shows that folder. Back in the first one, the linked message is still open unless you opened another message meanwhile.

Contacts are shown as network contact links: click to open in Hubchat, right-click for more. **Open in org mailbox** on any outside address link (a mail header, a message, a contact list) opens this viewer on that address: filtered to it, on the folder of the newest mail exchanged with it, with that mail selected. Edit or clear the filter to see everything again. While the org mailbox is closed off, the entry says so. Your own account's link is the exception: it opens your chat with the org it is shown in, never your Hubchat settings.

Human outside composition has moved to Hubchat: the org mailbox is a viewer, not a hidden second compose window. Do not suggest a removed reply/composer action. External sender authority belongs to current trust rules; a delivery/read badge does not make content authoritative. See `orgtree-mail-basics` (orgtree-working › mail) for the communication rules.

## Attachment transfers

Transfers is its own **transfers** tab beside **inbox** and **sent** in every mailbox that has transfers: the user Inbox, an agent's or project's Mail tab and mail window, and the org mailbox. The tab appears once the mailbox has any transfers; its badge counts the unfinished ones. Opening it lists the unfinished transfers at once; tick **recent history** to see finished ones too. The user Inbox no longer has a Record view. The list fills the whole tab and scrolls like inbox and sent. Older transfers load by themselves as you scroll near the end of the history; there is no Load more button. A page that fails to load shows its error with Retry. A progress bar measures confirmed bytes; processed/sent/received bytes may be ahead of confirmed custody.

Retry, Cancel transfer and (for eligible failed/cancelled outgoing files) Remove file and send are different. Removing explicitly omits that attachment so the remaining ready message can proceed. Closing the panel does not cancel engine transfer work. Refresh retries a failed panel read, not a new send. Use `orgtree-tool-transfers` (orgtree-working › mail) for exact agent-side actions and custody rules.

## Reading and acknowledging project jobs

An unread real message whose body has been displayed is marked read when it leaves the reading pane: selecting another message, clearing selection, changing a folder/filter/tab, closing the panel, switching organizations or closing its native window all use that rule. Merely loading a row is not reading it; question cards have their own answer flow. Failed read saves remain failures. If a close-time save fails and the panel stays open, a later leave or close retries it. Pending saves coalesce, and a successful save is not sent again by that same displayed reader.

A project job delivered to the user in ACK mode adds the project-job tag and acknowledge pane. Reply & acknowledge sends an ordinary reply to its sender, then acknowledges the assignment; Acknowledge without reply sends no response. A self-sent job offers Acknowledge job without a reply box. Reading, closing or leaving the queue never acknowledges a held job. See [project desk](../project-desk/SKILL.md#the-users-own-slots-listeners-and-queue-place) for joining, changing the batch and leaving.

## See also

- See `orgtree-mail-basics` (orgtree-working › mail).
- [orgtree-ask-cards](../ask-cards/SKILL.md)

## Mail mentioning the user

Unread mail with a standalone @user in its visible prose, title/subject or quoted context shares urgent mailbox attention and clears when read. It is not labeled urgent unless its sender actually marked it urgent. The needs-attention list shows one mail row instead of a duplicate matching mention blurb. Failed reads restore unread attention.
