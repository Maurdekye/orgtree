# Messages and work

[Documentation](../README.md#documentation) · [Previous: Managing agents](managing-agents.md) · [Next: Settings and usage](settings-and-usage.md)

Use **Chat** for a conversation, **Mail** to inspect correspondence, **Docket** for durable work records and **Presented** for documents you want to read. These views serve different purposes. Switching tabs does not stop an agent, and opening a record does not assign or complete its work.

## Continue a conversation

Open an agent's desk and select **Chat**. Give the desired result, constraints and any decisions the agent should bring back. A charter is a standing role, so put changing task details in the message and the relevant docket item.

Attach files with the paperclip or drag them into the composer. Remove a selected attachment before sending if it is no longer needed. Selecting or uploading a file is different from delivering the message. A failed send remains visible for retry; inspect a partial result before sending a duplicate.

The Enter preference determines whether Enter sends or adds a line. The send button remains available. At the first or last line, plain Up/Down can browse local composer history. While a turn runs, **Stop** interrupts the current response; Enter can still queue a message. Halt is a separate persistent stop.

The **Notice** control makes the next message passive: it waits for a later turn instead of waking the recipient. Use it for an FYI that can wait. A task requiring action needs an ordinary message. **DND** means an agent is holding non-urgent mail until its current turn ends. When the orange urgency control is offered, it can bypass that hold for the next send. It does not convert an interrupted turn into completed work.

## Read the transcript

Chat contains delivered messages, thoughts when supplied, tool calls/results, event cards, attachments and pending messages. Expand a tool row to inspect its arguments and result. A spinner or a call being written is not a completed operation. A live command preview is output so far, not an exit result.

Older transcript pages load as you scroll back. An error offers Retry; it is not proof that history ends there. Thoughts can contain supplied text, a measured duration, or a sealed/unsupported display. Missing text does not establish that the model did no reasoning.

Where retained, an Agent/Task tool row can expand a helper's transcript. Newly captured Claude helpers can stream their text and tool activity within the parent call. Older calls and other harnesses explain when no helper transcript is available. This nested view is bounded and does not run a helper merely because you open it.

File tool rows show the attempted path. An existing file can be opened or revealed; an unavailable path retains copy actions and its status explanation. Reading a tool result and checking the actual current file are different ways to verify an outcome.

## References, replies and formatting

Type **@** for completion of agents, projects, available hub contacts and current/backlogged docket tickets. Search tickets by slug or title words. Tab or Enter completes the selected reference without sending. Archived tickets are omitted from completion.

Inside an agent or project desk with a live message box, right-click an agent, project or ticket reference and choose **Mention** to insert it at the caret, or append it when the box was unfocused. It focuses the composer without sending. Other surfaces retain the menu appropriate to their context.

Use available **Reply** controls to prepare a message with its exact source reference. The composer shows that context; clear it, or use Escape, if you do not want the reply attached. Preparing a reply does not send it. A missing exact source can disable a reply rather than attach the wrong record.

Markdown works across conversations, mail, work descriptions and presentations. Inline images use supported local paths or HTTP(S) links, with a link fallback when unavailable. Offline LaTeX math supports inline `\(...\)` and display `\[...\]`, as well as dollar delimiters when unambiguous. For numeric or uppercase formulas, prefer the explicit backslash delimiters. Code and escaped dollars remain literal, and malformed math remains visible as source.

An agent deliberately writing a standalone @user in visible prose can request your attention. Code spans and code blocks stay literal. Native mention notifications and their click destinations follow your notification settings. In the main window, the glowing **@** button visits unobserved transcript mentions; mail mentions use Inbox/Attention. Seeing a mention and answering its associated question are separate actions.

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
