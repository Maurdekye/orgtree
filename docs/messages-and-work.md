# Messages and work

[Documentation](../README.md#documentation) · [Previous: Managing agents](managing-agents.md) · [Next: Settings and usage](settings-and-usage.md)

Use **Chat** for a conversation, **Mail** to inspect correspondence, **Docket** for durable work records and **Presented** for documents you want to read. These views serve different purposes. Switching tabs does not stop an agent, and opening a record does not assign or complete its work.

## Desk tabs with content

Desk **Docket** and **Presented** tabs hide when neither the node nor its team has anything the tab would list under its default filters. A tab appears or disappears as content changes, but stays visible while you are on it; an empty tab disappears when you leave. Search and sorting do not hide tabs. If availability cannot be confirmed, the desk retains its last confirmed tab availability while retrying; an incomplete reply does not close the desk. The Docket check follows the existing list, including recently completed tickets during their one-hour window and attention exceptions. Show archived and Show backlogged include those groups when enabled. Presented starts with hired presenters; Show retired includes retired presenters.

When only the team has content, entering the tab starts with **Team** checked and auto-select works in that team scope. A manual untick is remembered for this organization and node across visits/restarts until own content arrives. Own content keeps the ordinary own-node default. Live arrivals do not switch the scope or selection of a reader you are using. These rules apply to both agent desks and project Presented tabs. A project Docket already lists its subtree and keeps that scope without a Team checkbox.

## Continue a conversation

Open an agent's desk and select **Chat**. Give the desired result, constraints and any decisions the agent should bring back. A charter is a standing role, so put changing task details in the message and the relevant docket item.

Attach files with the paperclip or drag them into the composer. Remove a selected attachment before sending if it is no longer needed. Selecting or uploading a file is different from delivering the message. A failed send remains visible for retry; inspect a partial result before sending a duplicate.

The Enter preference determines whether Enter sends or adds a line. The send button remains available. At the first or last line, plain Up/Down can browse local composer history. While a turn runs, **Stop** interrupts the current response; Enter can still queue a message. Halt is a separate persistent stop.

After sending, feedback such as **steering in mid-task** appears above the bottom jump cards. Those cards stay above the message box. The feedback describes the send outcome; it does not establish that the agent has finished acting on your message.

The **↓ jump to bottom** card is shown only while follow is off and the loaded
transcript is taller than its visible area. A transcript that fits has no card,
even after an upward gesture or after content folds. Resizing or expanding
content refreshes this check. Returning to the tail resumes follow; hiding the
card alone does not change follow or remove earlier history.

All undelivered mail shares one **Show/Hide** group, even for one message.
This includes system cards such as “Backend restarted” and messages still
sending or showing a send failure. During a turn, the group sits below the live
reply. Mail in the current turn appears normally above the reply; both stay
visible when you collapse the queue. While idle, all undelivered mail sits
under the one separator. The count excludes mail already in the current turn.
Click the arrow/count separator line itself to toggle the group; the count
appears once, with no extra toggle row below it.
Groups start open below six messages and close automatically at six or more.
Clicking Show or Hide keeps your choice as messages arrive or leave that group.
The choice resets when the group empties, you close/reopen the desk or the agent
starts a new conversation generation. Delivered messages display normally;
individual message-body previews are unchanged. Folding the queue does not
deliver, retract or acknowledge its messages.

The **Notice** control makes the next message passive: it waits for a later turn instead of waking the recipient. Use it for an FYI that can wait. A task requiring action needs an ordinary message. **DND** means an agent is holding non-urgent mail for the current turn; **DND next turn** is an idle armed hold. The desk-header button controls it, and clearing it releases held mail at supported delivery boundaries. When the orange urgency control is offered for active DND, it can bypass that hold for the next send. It does not convert an interrupted turn into completed work. [Managing agents](managing-agents.md#hold-mail-for-focused-work) explains the full lifecycle.

## Read the transcript

Chat contains delivered messages, thoughts when supplied, tool calls/results, event cards, attachments and pending messages. Expand a tool row to inspect its arguments and result. A spinner or a call being written is not a completed operation. A live command preview is output so far, not an exit result.

When an earlier message from you is above the visible transcript, **↑ you**
previews one message and jumps back to its delivered batch. If that batch
contains several messages from you, the preview uses the last one. Automatic
hire and other operation notices keep their event cards but do not replace
your message in this preview. A history containing only those notices has no
**↑ you** preview.

An idle docket reminder can contain interactive ticket cards. Open them to inspect the actual scope and status; their reference menus use the same message-box routing as other tickets. A reminder is a nudge about unfinished work, not evidence that the item was assigned again or completed.

Older transcript pages load as you scroll back. An error offers Retry; it is not proof that history ends there. Thoughts can contain supplied text, a measured duration, or a sealed/unsupported display. Missing text does not establish that the model did no reasoning.

New Codex thoughts retain their measured item duration, using the same display
as Claude, including sealed thoughts. Native start/end timestamps take priority;
otherwise matching observed boundaries supply the time. Missing starts and old
rows without timing stay unknown. Open a readable thought to inspect its supplied
text; a sealed thought cannot reveal text the harness did not provide.

Where retained, an Agent/Task tool row can expand a helper's transcript. Newly captured Claude helpers can stream their text and tool activity within the parent call. Older calls and other harnesses explain when no helper transcript is available. This nested view is bounded and does not run a helper merely because you open it.

When a chat has observed running helper agents, its header also shows **N
helpers**. Click it to open **Helpers**, select a helper, and review its type,
description, reported model, observed start and status. New captured Claude Code
output updates live; scrolling away from the bottom pauses following until you
return. Closing the panel stops its readers. The badge disappears at zero;
recent finished helpers remain inspectable while the panel is open.

| Harness | Helper details | Live transcript |
| --- | --- | --- |
| Claude Code | Explicit Agent/Task and background helper activity; shell jobs are excluded. | New first-level capture during the parent's turn. |
| Codex | Explicit reported child identities/statuses; a spawn call ending does not mean its helper ended. | Currently unavailable. |
| Muse | Reported subagent lifecycle and details. | Currently unavailable. |
| OpenCode / Antigravity | Reliable child identity/lifecycle is not currently available in the adapter. | Currently unavailable. |

Models not reported by the harness stay unknown. Start means when Orgtree
observed the helper; Codex status is its latest parent-stream observation.
The bounded list says when its 64-identity limit is reached. Opening this
inspector never launches a helper or reads native transcript files.

File tool rows show the attempted path. An existing file can be opened or revealed; an unavailable path retains copy actions and its status explanation. Reading a tool result and checking the actual current file are different ways to verify an outcome.

The I-beam mark with `t` or `kt` is a tool's observed text-output token estimate; `~` stays an estimate even after completion, and hover shows the full number. It differs from billed usage and context occupancy. A file-read count uses the returned text or slice, rather than the short summary or the file's total line count. Large outputs use bounded sampling. If retained read text is unavailable, its count stays unknown; Orgtree does not reopen the file to estimate an older read. Live shell previews retain at most 32 KiB per tool and eight tools per agent, with an omission marker when clipped. Codex/Muse can supply live output; OpenCode does not currently emit shell progress snapshots, and Claude/Antigravity have no live shell preview here. Final results replace these transient previews.

New Muse thoughts also retain the measured interval between Muse's reported
reasoning item start and completion, with the same thought display as Claude.
The duration survives reopening the chat. Missing starts and older rows without
timing stay unknown; a sealed thought can show its duration without exposing
text. This is the reported item interval, not the whole turn's runtime.

## Play media in a conversation

Video and audio file cards offer **Play video** or **Play audio** in every chat
placement, including pinned and popped-out chats. Media loads only after Play;
use the player's controls to pause, seek or change volume. Scrolling the card
out of view, hiding the window or changing chats stops playback. It stays stopped
when you return. Images keep their inline picture and click-to-view behavior.

Playback supports MP4/WebM video and MP3/WAV/Ogg/M4A/AAC/FLAC audio where Chromium
supports the codec, up to 256 MiB per file. Larger, unsupported or unavailable
files keep their Download action. Video fits the conversation and stays at most
320 px tall. Files stay within their existing organization permissions; the player
does not open arbitrary paths or fetch remote media. Composer previews and the
separate Files list keep their compact layout.

## References, replies and formatting

Type **@** for completion of agents, projects, available hub contacts and current/backlogged docket tickets. Search tickets by slug or title words. Tab or Enter completes the selected reference without sending. Archived tickets are omitted from completion.

Ticket and presentation cards/links offer **Mention** and **Reply** in every live message-box context: agent/project desks, mail reply panes and canvas content sharing Quick chat. Mention inserts the object's reference at the caret, or appends when unfocused. Reply stages that exact object while keeping your draft text. Neither sends. Agent/project links retain their Mention action too.

The nearest enclosing composer owns the action. A canvas reference uses Quick chat only while it is live and no nearer desk/mail box owns the link. Standalone galleries and dockets keep their existing menus. The selected object does not change the composer's recipient to the ticket owner or presenter. Project broadcasts keep the reference. In a mail reply, remove the object annotation to return to its original mail context; a failed send restores the draft and selection. Quick chat first hires a new agent when you send, then delivers the object reference with its initial task.

Use available **Reply** controls to prepare a message with its exact source reference. The composer shows that context; clear it, or use Escape, if you do not want the reply attached. Preparing a reply does not send it. A missing exact source can disable a reply rather than attach the wrong record.

Markdown works across conversations, mail, work descriptions and presentations. Inline images use supported local paths or HTTP(S) links, with a link fallback when unavailable. Offline LaTeX math supports inline `\(...\)` and display `\[...\]`, as well as dollar delimiters when unambiguous. For numeric or uppercase formulas, prefer the explicit backslash delimiters. Code and escaped dollars remain literal, and malformed math remains visible as source.

An agent deliberately writing a standalone @user in visible prose can request your attention. Code spans and code blocks stay literal. Native mention notifications and their click destinations follow your notification settings. In the main window, the glowing **@** button visits unobserved transcript mentions; mail mentions use Inbox/Attention. Seeing a mention and answering its associated question are separate actions.

**Shift+F4** searches the retained mention navigation history across transcript, mail and docket sources, including seen entries. It opens the source and highlights the passage; later presses step backward. [Settings and usage](settings-and-usage.md#keyboard-shortcuts) explains its 4.4.2 history baseline and limits.

### Image embedding limits

The checked image route accepts PNG/JPEG/GIF/WebP up to 10 MiB, 16 million pixels and 8,192 pixels per dimension. It refuses unsafe local-link/device paths and private/LAN/loopback remote image destinations, even when you can reach them elsewhere. Public HTTP(S) redirects are rechecked. A rejected embed falls back to a link; that does not prove the file or URL is missing. These limits apply across Markdown reading surfaces, including mail and presentations.

## Text editing menus

Right-click editable text for **Undo**, **Redo**, **Cut**, **Copy**, **Paste**,
**Delete** and **Select All**. Commands are disabled when the field cannot use
them; Cut and Delete require a selection. Rich editable text also offers
**Paste as plain text**. Shortcut hints follow the platform convention.

When the default Electron/OS spellchecker identifies a misspelled word under
the pointer, its spelling suggestions replace that word and **Add to dictionary**
adds it to the current session's spelling dictionary. Suggestions depend on the
default spelling language and the browser's completed spelling checks; they may
be absent before the browser checks the entered word. Orgtree does not choose
another language here.

Selected read-only text offers **Copy** and **Select All**. Exact-passage menus
retain **Reply to selection** alongside those commands. Select All selects text
in the current document; it does not edit it or send a message. These menus stay
with their originating canvas, floating, pinned or popped-out reading surface.

## Replies to an exact passage

In a live mail reply context, highlight text, right-click **Reply to selection**,
then enter your feedback in the existing reply box. Nothing sends until you
press Send. Add several passages, remove one, or use **Cancel all selections**
or Escape to clear the staged passages. Your draft text and recipient stay in
place. A refused selected reply returns to an empty composer. If you have
started a newer draft, that draft stays intact and the refused reply appears
separately as **Reply not sent**. Expand it to read its original text,
attachments and selected passages. **Restore reply** fills an empty composer
without sending; send or clear the current draft first. Each refused reply is
kept whole and separately, with at most eight passages in any restored reply.
If the recipient changed, return to the original recipient to recover it.
These saved replies last while this reply box remains open.

A reply can include at most **eight selected passages**, each at most **4,096
UTF-8 bytes**, with **48 KiB** of combined selection metadata. These limits apply
across mail, transcripts, Markdown presentations and docket fields. A longer
passage must be shortened; the engine refuses oversized selections rather than
silently cutting the quote.

The quote's **Nearby context** expands the saved surroundings. Activate the quote
to check its current source; changed/unavailable sources keep the saved excerpt.
Selections across source boundaries do not offer the action. Display-only text
that cannot be mapped exactly shows a disabled action with an explanation. Normal Copy and editable-field menus remain available.

An agent can attach a verified passage to a reply, keeping its exact text and
nearby context. The quote remains readable when its source is edited or removed;
opening live context still follows that agent's permissions. A changed source
before sending requires a fresh selection. Quotes from mail, settled transcripts,
Markdown presentations and readable docket fields use the existing reply system.
Interactive HTML and persistent comment threads are outside this feature.

An agent can recover exact source context in bounded windows without consuming
mail or marking a document viewed. A running transcript turn must finish first.
Duplicate docket-list entries cannot be safely distinguished and are refused.
Selected replies currently stay within the organization; outside mail retains
its existing whole-message reply behavior.

## Opening Work and Presentations

A fresh opening selects the topmost ticket with a manual attention flag, or the oldest unread/changed presentation by its current update/creation time. Otherwise it restores the last viewed eligible item for that organization and collection scope (org, node/project or team), then the topmost row, or nothing for an empty list. Closed tickets and dismissed documents do not win the remembered-item preference. The preference survives close/reopen and restart, respects current filters, and does not mark a document viewed on an agent's behalf.

This applies to the top-bar buttons, agent/project Open submenus including team views, and entering a desk's Docket/Presented tab. Leaving a desk tab and returning is a fresh opening. Explicit item/document links keep their target. Bringing forward, resizing, pinning, popping out or restoring an already-open reader keeps its current selection, including a deliberate empty pane. Polls never replace a choice.

## Use Mail and the user Inbox

An agent's **Mail** tab is that agent's inbox and sent history. Your **Inbox** is your own received mail, questions and sent/record views. The **organization inbox** is outside correspondence. Reading one is not the same as becoming its owner or gaining a composer for all of its contacts.

Select a mail to see its full body, sender, time, attachments and reply references. A link can locate a message outside the currently loaded page. Contextual user replies target the original sender or eligible recipients and retain the source reference. Composed, queued, delivered and consumed describe different stages.

For ordinary unread user mail, displaying the body and then leaving the reading pane marks it read: changing selection/filter/tab, clearing selection or closing also uses that rule. Merely loading a list row does not read it. A failed read save is shown as a failure, and attention can return. Reading an agent's mailbox in the UI does not prove the agent consumed its pending mail.

Search sender/body to narrow the user Inbox. The tag filter requires **all** selected tags, ignoring case. Tag choices come from retained user mail, including older pages. Counts still describe the whole inbox, and opening an exact mail reference clears a tag filter that would hide it.

Each mail list row shows up to three tags in their stored order. Active filter
matches come first in filter order, followed by other tags to fill three places.
With four or more tags, **(+n)** counts the tags not shown; hover it to read their
names. The count does not expand on click. Open the message to see all its tags;
the tag picker and filter bar also keep the full list.

The received-mail context menu can permanently delete **your copy** after confirmation. It leaves sender history, other recipients' copies and attachment files. An outstanding project ACK job must be acknowledged first. There is no bulk delete or keyboard-delete command in this release.

**Transfers** shows file-delivery progress and errors. Retry resumes a failed transfer; Cancel stops it; **Remove file and send**, when offered, explicitly omits that failed attachment so the remaining message can proceed. Closing the panel does not cancel an engine transfer. Confirmed bytes and a queued count are not proof that a human read the file.

The outside-org inbox is a viewer. Human outside composition belongs in [Hubchat](collaborating.md#connect-hubchat-and-the-mail-hub), not a hidden reply box in that viewer.

## Answer questions and permission requests

Open question/request cards appear in the conversation, Inbox or Attention. Choose the offered option(s) and add free text where available, then submit. A draft selection is not a recorded answer. Dismissal is a distinct outcome reported to the agent.

A batch can mix questions, credit decisions and scope requests. Decide or explicitly skip every tab before submitting. Credit requests allow a grant, denial or counteroffer within the shown limits. Scope requests name the specific folder, tool, MCP server or permission being requested.

An **MCP permission** card can show required form fields or a link you open yourself. Accept, Decline or Cancel decides that request only; it is not a permanent grant of all server access. These requests expire after five minutes. A failed submit can be retried while still valid. Resolved, withdrawn, superseded and interrupted cards are history, not unanswered live questions.

With the per-agent **Disabled by Orgtree** opt-in, supported native Claude/Codex/Muse questions can use private cards in these same surfaces. The heading names the harness. Choose options or answer in your own words, then submit; plan approval requires the explicit **Approve** choice, with none preselected. Decline, Cancel, expiry or process cancellation returns without approval. Each card decides only that request and grants no lasting scope.

Native requests allow one to four questions and up to 16 options per question; a free-text answer is limited to 500 characters. Cards expire after five minutes. Oversized or unsupported requests are refused. Native questions without direct user reach are routed as ordinary question mail to the agent's superior instead. Granting the tool does not grant a direct audience. [Managing agents](managing-agents.md#opt-into-native-replacement-tools) describes the opt-in and its harness differences.

## Keep work in the Docket

Use the header's **Work** control for the organization docket, the agent's **Docket** tab for associated work, or **Team docket** for a subtree's ownership view. Search and the archive/backlog inclusion controls help find older work. Group by status or agent, and sort by last update, creation or status change. Hidden groups and unloaded pages are not proof an item is absent.

A useful item states the problem, desired result and scope in its description, then records the owner, current progress, next steps and evidence. Parent items, dependencies and participants preserve context across conversations. Ask the agent to keep these records current at milestones rather than relying on a long transcript alone.

| State | Meaning |
| --- | --- |
| Backlogged | Work not yet approached or approved to start. |
| Open | Accepted work available to start. |
| In progress | Work is under way. |
| Blocked | A concrete missing input/event prevents progress; the reason identifies what unblocks it. |
| Review / approved | An agent review and its outcome. This is not automatically a question for you. |
| Deploy ready | Preparation is complete but deployment is a separate authorized step. |
| Done | The actual objective is complete. |
| Dropped / superseded | Cancelled/non-successful work, or work replaced by another item. |

Archiving changes visibility, not whether work succeeded. Retiring an owner does not complete its items. A manual **attention flag** identifies a decision or result you need to see; it is separate from linked question cards. **Dismiss** clears the flag and records the dismissal. Done and Review keep their status; every other status becomes Blocked, with a reason recording the dismissed attention. This does not answer a question or approve an implementation by implication.

In an item's **Attachments** section, choose **Attach files…** to copy files onto that item, up to 25 MiB per file. Duplicate filenames receive unique stored names. You can open or download the item copy later. **remove** asks for confirmation and permanently deletes that stored item copy and its attachment record; your original file and other copies remain. These item attachments are separate from evidence links and files staged in a reply.

The item reply UI retains exact context. Its recipient can be the owner or a participant; while attention is active, the flag raiser is also eligible and is the default. Replying does not assign the item. Use a linked question to answer a decision that needs a structured response.

An unarchived backlog item can offer **Staff…**. The action follows the app's Quick staff mode: request staffing from the assignee, hire under it, or hire at top level. Read the disclosure before selecting it. It submits real staffing work and can be refused if authority, capacity or ownership changed.

## Read documents in Presented

Ask for a **presentation** when you want a plan, report or other document to read. Open **Presentations** in the header, or **Presented** in a desk. Team presentations include documents below an agent or project. Use **Show retired** to include retained documents from retired presenters.

Team galleries include the whole selected team, even through very deep project nesting. File delivery and presentation-file reads likewise follow the complete folder authority chain; restrictions from higher in the tree still apply. Deep project membership keeps the ordinary presentation and audience rules.

Unread or changed documents have highlighted titles. Opening one marks it viewed **by you**; an agent reading it does not. A fresh reader normally selects the oldest unread/changed document, then the last viewed eligible document for this collection, then the topmost card if all are read. Explicit document links take priority. Later refreshes do not continually replace your selection.

The reader supports Markdown and HTML previews, source identity, downloads and the reply/dismiss controls available to that surface. HTML presentations carry an **HTML presentation** tag and run inline in the reader: their scripts and controls work, but they stay offline in a sandbox and cannot send anything back to the agent. **Fit width** scales a wide presentation down to the reader's width; **100%** shows its actual size. **Open in a new window** opens it in its own window, which is also the only way to view a presentation whose stored preview is over 4 MiB. Multiple readers can coexist for different agent, project or team scopes. A document link raises a suitable existing reader when possible. Pin/pop-out changes where you read it, not its author or contents.

Presentations store a snapshot. Markdown text or a Markdown file is limited to 64 KiB; an HTML source file is limited to 4 MiB. HTML previews run in a sandbox offline: network resources are blocked, and missing local dependencies are shown in the preview notice. A single HTML file is downloaded as its stored snapshot; an HTML folder is captured as an immutable ZIP bundle, up to 25 MiB and 4,096 files. Later edits to the original files do not change the saved presentation; ask the agent to update it. For a file delivery rather than a presentation, the limit is 256 MiB.

Project presentations belong to the project's shared collection. Any agent authorized to present into that project can update an existing card there, even one first presented by another agent. The project stays its owner and **presented by** changes to the replacing agent. An agent's personal collection remains limited to that agent's own replacements.

Closing a reader leaves the document in its collection. **Dismiss** is a separate document operation. A download saves a file and does not prove that it was read. For an installer, image, export or log wanted as a file, ask for a file delivery instead. Moving a scratch file alone does not publish it into Presented.

## Find files an agent delivered

Open an agent's desk and select **Files**, beside **Presented**. This tab
shows a compact row for each retained delivery, with filename, size, time and
a download action. Hover a filename to read its delivery note. Earlier
deliveries appear too when Orgtree still has their records.

The newest file is at the bottom, where the tab opens. Scroll up to load
older files automatically; the visible file stays in place as rows appear
above it. Incoming files append at the bottom and stay out of your way while
you read older rows. This updates live in both the canvas desk and a popped-out
desk. When you are at the bottom, the list follows new files without a refresh.
**Refresh** returns to the newest page and scrolls to the bottom.

Click a filename or its download icon for the original delivered copy.
Pictures also have **View** to open the image viewer. Editing the agent's
source file later does not change the delivered copy. If its saved copy was
removed outside Orgtree, the row can remain while its download fails.
Renaming or retiring an agent does not change its retained deliveries.

Files downloads also work from a desk in a separate window: choose the filename
or Download. The download limit is 256 MiB; errors appear beside the link.
When View opens a picture, Escape closes that viewer while leaving the desk
open. The viewer's Close button and backdrop remain available too.

Files contains local download cards, including delivered pictures, archives,
logs and exports. Readable reports stay in **Presented**. Mail attachments and
hub transfer jobs keep their existing mail and transfer views; project
presentations keep their existing placement.

Agents can read the same delivery history with **orgtree_files** for themselves
or a descendant, with inspection permission. It is a listing action: it does
not deliver another copy or prove that a person downloaded the file.

Continue with [Settings and usage](settings-and-usage.md) for shortcuts, notifications, limits and the settings that affect these workflows.

### Reply to part of a transcript

Highlight retained prose, an open thought, or text in expanded tool details and choose **Reply to selection**. In structured tool JSON, each key and scalar value is a separate source part. Your current desk draft stays in place. The quote includes the exact excerpt and nearby context; you can stage several passages before sending through that desk's normal reply box.

The running turn must finish before its text can be quoted this way. Hidden context, sealed thoughts and reconstructed truncated JSON are excluded. If a source changes before sending, the send refuses and your draft is restored. After delivery, the captured excerpt remains readable; opening it checks for the original passage or a unique verified relocation. Otherwise it shows **Source changed** or **Source unavailable**.

### Reply to part of a presentation or docket item

Highlight text in a Markdown presentation title/body, or a docket title, description, current reason, progress entry or evidence note. **Reply to selection** adds its exact excerpt and nearby context to that reader's reply box. Keep typing in your existing draft, remove individual passages, or cancel all. Each gesture selects one field or entry; identical list entries cannot be safely distinguished and are refused.

Presentation replies retain their direct/project broadcast destination. Docket replies retain the ordinary recipient and attention rules: a changed selected source refuses before mail is sent or attention is cleared. HTML presentations do not offer this action. Delivered quotes survive later edits; opening a quote checks the current source and highlights only a verified passage.

If a selected desk reply fails after you have started a new draft, the new draft stays intact. The failed message retains its original text, attachments and selected passages; use its **Restore** control to recover that submission. Source parts over 1 MiB refuse before DOM mapping; use a smaller retained field or JSON scalar.

The image viewer's download link uses the same authenticated download path,
256 MiB limit and visible failure handling, including in a separate window.
