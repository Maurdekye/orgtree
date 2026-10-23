# Messages and work

[Documentation](../README.md#documentation) · [Previous: Managing agents](managing-agents.md) · [Next: Settings and usage](settings-and-usage.md)

Use **Chat** for a conversation, **Mail** to inspect correspondence, **Docket** for durable work records and **Presented** for documents you want to read. These views serve different purposes. Switching tabs does not stop an agent, and opening a record does not assign or complete its work.

## Continue a conversation

Open an agent's desk and select **Chat**. Give the desired result, constraints and any decisions the agent should bring back. A charter is a standing role, so put changing task details in the message and the relevant docket item.

Attach files with the paperclip or drag them into the composer. Remove a selected attachment before sending if it is no longer needed. Selecting or uploading a file is different from delivering the message. A failed send remains visible for retry; inspect a partial result before sending a duplicate.

The Enter preference determines whether Enter sends or adds a line. The send button remains available. At the first or last line, plain Up/Down can browse local composer history. While a turn runs, **Stop** interrupts the current response; Enter can still queue a message. Halt is a separate persistent stop.

After sending, feedback such as **steering in mid-task** appears above the bottom jump cards. Those cards stay above the message box. The feedback describes the send outcome; it does not establish that the agent has finished acting on your message.

The **Notice** control makes the next message passive: it waits for a later turn instead of waking the recipient. Use it for an FYI that can wait. A task requiring action needs an ordinary message. **DND** means an agent is holding non-urgent mail for the current turn; **DND next turn** is an idle armed hold. The desk-header button controls it, and clearing it releases held mail at supported delivery boundaries. When the orange urgency control is offered for active DND, it can bypass that hold for the next send. It does not convert an interrupted turn into completed work. [Managing agents](managing-agents.md#hold-mail-for-focused-work) explains the full lifecycle.

## Read the transcript

Chat contains delivered messages, thoughts when supplied, tool calls/results, event cards, attachments and pending messages. Expand a tool row to inspect its arguments and result. A spinner or a call being written is not a completed operation. A live command preview is output so far, not an exit result.

An idle docket reminder can contain interactive ticket cards. Open them to inspect the actual scope and status; their reference menus use the same message-box routing as other tickets. A reminder is a nudge about unfinished work, not evidence that the item was assigned again or completed.

Older transcript pages load as you scroll back. An error offers Retry; it is not proof that history ends there. Thoughts can contain supplied text, a measured duration, or a sealed/unsupported display. Missing text does not establish that the model did no reasoning.

Where retained, an Agent/Task tool row can expand a helper's transcript. Newly captured Claude helpers can stream their text and tool activity within the parent call. Older calls and other harnesses explain when no helper transcript is available. This nested view is bounded and does not run a helper merely because you open it.

File tool rows show the attempted path. An existing file can be opened or revealed; an unavailable path retains copy actions and its status explanation. Reading a tool result and checking the actual current file are different ways to verify an outcome.

The I-beam mark with `t` or `kt` is a tool's observed text-output token estimate; `~` stays an estimate even after completion, and hover shows the full number. It differs from billed usage and context occupancy. A missing observation stays unknown. Live shell previews retain at most 32 KiB per tool and eight tools per agent, with an omission marker when clipped. Codex/Muse can supply live output; OpenCode does not currently emit shell progress snapshots, and Claude/Antigravity have no live shell preview here. Final results replace these transient previews.

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

## Replies to an exact passage

In a live mail reply context, highlight text, right-click **Reply to selection**,
then enter your feedback in the existing reply box. Nothing sends until you
press Send. Add several passages, remove one, or use **Cancel all selections**
or Escape to clear the staged passages. Your draft text and recipient stay in
place. A failed send restores the draft and excerpts; a changed recipient keeps
the failed selection draft with its original recipient.

The quote's **Nearby context** expands the saved surroundings. Activate the quote
to check its current source; changed/unavailable sources keep the saved excerpt.
Selecting across source boundaries or display-only text explains why the action
is unavailable. Normal Copy and editable-field menus remain available.

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

## Use Mail and the user Inbox

An agent's **Mail** tab is that agent's inbox and sent history. Your **Inbox** is your own received mail, questions and sent/record views. The **organization inbox** is outside correspondence. Reading one is not the same as becoming its owner or gaining a composer for all of its contacts.

Select a mail to see its full body, sender, time, attachments and reply references. A link can locate a message outside the currently loaded page. Contextual user replies target the original sender or eligible recipients and retain the source reference. Composed, queued, delivered and consumed describe different stages.

For ordinary unread user mail, displaying the body and then leaving the reading pane marks it read: changing selection/filter/tab, clearing selection or closing also uses that rule. Merely loading a list row does not read it. A failed read save is shown as a failure, and attention can return. Reading an agent's mailbox in the UI does not prove the agent consumed its pending mail.

Search sender/body to narrow the user Inbox. The tag filter requires **all** selected tags, ignoring case. Tag choices come from retained user mail, including older pages. Counts still describe the whole inbox, and opening an exact mail reference clears a tag filter that would hide it.

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

Archiving changes visibility, not whether work succeeded. Retiring an owner does not complete its items. A manual **attention flag** identifies a decision or result you need to see; it is separate from status and linked question cards. Dismissing a flag does not answer a question or approve an implementation by implication.

The item reply UI retains exact context. Its recipient can be the owner or a participant; while attention is active, the flag raiser is also eligible and is the default. Replying does not assign the item. Use a linked question to answer a decision that needs a structured response.

An unarchived backlog item can offer **Staff…**. The action follows the app's Quick staff mode: request staffing from the assignee, hire under it, or hire at top level. Read the disclosure before selecting it. It submits real staffing work and can be refused if authority, capacity or ownership changed.

## Read documents in Presented

Ask for a **presentation** when you want a plan, report or other document to read. Open **Presentations** in the header, or **Presented** in a desk. Team presentations include documents below an agent or project. Use **Show retired** to include retained documents from retired presenters.

Unread or changed documents have highlighted titles. Opening one marks it viewed **by you**; an agent reading it does not. A fresh reader normally selects the oldest unread/changed document, or the most recently created/changed one if all are read. Explicit document links take priority. Later refreshes do not continually replace your selection.

The reader supports Markdown and HTML previews, source identity, downloads and the reply/dismiss controls available to that surface. Multiple readers can coexist for different agent, project or team scopes. A document link raises a suitable existing reader when possible. Pin/pop-out changes where you read it, not its author or contents.

Closing a reader leaves the document in its collection. **Dismiss** is a separate document operation. A download saves a file and does not prove that it was read. For an installer, image, export or log wanted as a file, ask for a file delivery instead. Moving a scratch file alone does not publish it into Presented.

Continue with [Settings and usage](settings-and-usage.md) for shortcuts, notifications, limits and the settings that affect these workflows.

### Reply to part of a transcript

Highlight retained prose, an open thought, or text in expanded tool details and choose **Reply to selection**. In structured tool JSON, each key and scalar value is a separate source part. Your current desk draft stays in place. The quote includes the exact excerpt and nearby context; you can stage several passages before sending through that desk's normal reply box.

The running turn must finish before its text can be quoted this way. Hidden context, sealed thoughts and reconstructed truncated JSON are excluded. If a source changes before sending, the send refuses and your draft is restored. After delivery, the captured excerpt remains readable; opening it checks for the original passage or a unique verified relocation. Otherwise it shows **Source changed** or **Source unavailable**.
