---
name: orgtree-desk-chat
description: Explain transcript cards, tool displays, reply controls and the desk composer.
---
Up: [orgtree-desk](../SKILL.md)

Composer controls use matching 24px heights. Effort grows wide enough to show
its complete chosen or queued level, without ellipsis; urgency, speed,
send/interrupt, notice, attach and project broadcast stay 24px square. Urgency
sits immediately left of speed where speed is available.

# Desk Chat tab

Chat HTTP request/response bodies, including transcript text and thinking, are omitted from wire diagnostics with verbose logging off or on. Chat paths, paging queries and status remain logged; normal client transcript delivery is unchanged. This also covers rejected requests and unknown children of the chat endpoint.

Clicking empty space anywhere in the message box, including beside its lower controls, focuses the text field. Buttons and pickers keep their own behavior. The same focus rule applies to project desks, Quick chat and reply boxes. Speed, effort and send/interrupt controls use the same 24px height as the bell and attachment controls.

The agent and project desk message boxes grow as text wraps or new lines are
added, up to 30 lines beyond their two-row base (32 visible text rows). Longer
drafts scroll inside the field. Deleting or sending text shrinks the box again;
changing the panel width also recalculates its height. Quick chat uses its own
single-line input.

File-reading/writing tool calls show the attempted file immediately after the
tool chip. Existing files keep a filename-only link; hover shows the full path.
Missing files, unavailable file-status checks and relative paths without a
working directory show the full attempted path, with its directory dimmed.
Their tooltip keeps that path and explains its status. They cannot open or
reveal a file, but their context menu retains **Copy path** and **Copy file
name**. The same rule covers every tool kind and harness with recorded file
paths, including read, write, edit and glob calls. File status is checked when
the row appears, when the tool completes, and on hover or keyboard focus.
A path already shown beside the tool is omitted from its argument so it
appears once. Skill reads use the resolved `SKILL.md` path or exactly one file
in the selected, materialized skill registry; missing or ambiguous skill names
remain unlinked because no attempted file path is known.

Chat is the conversation surface. It includes messages, thoughts when supplied, tools, typed events, attachments and pending delivery rows. Opening another tab does not stop the agent. Earlier messages load on demand; failure offers retry rather than claiming the transcript ends there.

Completed Codex reasoning steps without readable text retain a sealed thought
placeholder in saved history, like Claude's sealed thoughts. The placeholder
records that thinking occurred; it does not reveal encrypted reasoning or
invent a duration or token count. Supplied readable summaries remain expandable.
This applies to newly received steps; it does not backfill previously omitted
sealed rows. Thought rows can also contain ordinary tool chips, which stay visible.

Returning to the latest messages or reopening a desk keeps earlier history
available to scroll back into. The start-of-conversation marker means the loaded
history has reached the actual beginning, including on Antigravity agents; it
does not mean that older rows were merely released from the screen's cache.

Chat Markdown can display inline images. Relative image paths resolve within the author's files; absolute Windows paths and HTTP(S) URLs use the checked image endpoint. PNG, JPEG, GIF and WebP are supported there; an image that cannot be loaded falls back to a link (local files can be revealed in their folder).

## Markdown image limits

The checked image endpoint accepts PNG, JPEG, GIF or WebP up to **10 MiB**
(10,485,760 bytes), **16,000,000 pixels** and **8192 pixels per dimension**.
A supported format can still exceed these limits and fall back to a link.
The checked absolute local-file route refuses links/reparse points, device
paths and alternate data streams; an unavailable or non-regular file cannot
be embedded. Relative images continue through the author's file-access route.

Remote embedding requires a public HTTP(S) destination without URL
credentials. Private/LAN, loopback and other non-public destinations are
refused, so a reachable LAN image can still remain a link. Each redirect is
validated again, with at most five redirects. Use a supported smaller image
or an authorized local file when an embed is rejected; a link fallback is not
evidence that the file or remote host is missing.

## Markdown math formatting

Every Markdown reading surface supports offline LaTeX mathematics: `$x^2$` or
`\(x^2\)` inline, `$$x^2$$` or `\[x^2\]` as a display. Displays may contain
multiline alignment. The same formatting works in transcripts, thoughts,
helper responses, mail, docket descriptions, quick chat and presentations,
including their detached windows. The fonts ship with the app.

Currency such as `$5 and $10`, shell variables, escaped dollars (`\$`),
backtick code and fenced code stay literal. Dollar math needs no spaces at its
inner edges; plain amounts and bare uppercase identifiers stay literal. Use
`\(...\)` for ambiguous numeric or uppercase formulas. Invalid LaTeX stays
visible as its delimited source. Math commands cannot fetch images or create
trusted HTML links, and a formula's macro definitions do not affect later math.

## Finished thinking times

Claude thoughts keep their measured duration when the live block finishes and
when Chat is reopened. Each thought has its own clock, including sealed reasoning.
When the harness supplies a thinking duration, that value takes precedence;
otherwise the clock uses the engine's observed block start and stop.
Old thoughts show a recorded time when available; without a real measurement they
keep “a moment”. No historical time is invented from a message timestamp.

## Read activity accurately

A tool chip distinguishes call-writing from execution and can expand to show arguments/result. Completed tool behavior is not inferred from the spinner alone. Successful docket status-change chips can show captured old → new states; failure/no-op or missing historical before-state does not invent one. Thoughts can expose supplied reasoning or only elapsed duration; absence of text is not evidence the model did not think.

Pending/undelivered cards sit separately from delivered conversation. Runs of six or more pending rows collapse behind Show/Hide within their current/later delivery group. Optimistic or failed sends remain visible. A quote/reply navigation can reveal a folded target; opening a disclosure is not a read/delivery acknowledgment.

Event cards and reference links can open their exact related agent, mail, work item, watchdog or document when a route is available. Copy/reply menus use durable source identity; a missing exact source can disable a reply action rather than inventing a target.

## Helper activity inside a tool call

Expand a helper Agent/Task tool row to see its retained transcript inline.
New Claude Code helpers stream text, supplied thoughts and tool activity while
their parent turn runs. This first slice supports one transcript level: the
helper's own helper tools expand ordinary input/result details only.

Helper prose uses the same Markdown and message styling as the agent's Chat
transcript, with the same thinking disclosures and expandable tool chips.
New captures keep native content order. Supplied timing/token fields use normal
slots; missing values remain unknown. The nested view stays visibly marked as
a helper and scrolls within its own bound.

Helper tool inputs hide inline MQTT/WebSocket credentials and secret URL
values, while keeping ordinary arguments and credential-file paths. Incomplete
or clipped JSON says "Arguments withheld until complete JSON can be redacted."
The same protection applies when older retained helper snapshots are opened.

Collapsed calls do not read helper snapshots. Completed captures remain
available on reopening; read errors offer Retry, and a size-limit note means
some activity was omitted. Older calls and other harnesses explain when no
transcript was retained. Historical recovery and helpers continuing after the
parent turn are not included yet. Missing activity is not evidence the helper
did nothing. Opening this view never runs a helper or sends it a message.

## Composer

Ticket and presentation context menus offer **Mention** and **Reply** wherever
they belong to a live message box: agent desks, project desks, mail readers,
and canvas content sharing Quick chat. Mention inserts the object's reference
at the caret (or appends when unfocused) and focuses the box. Reply stages that
exact object, keeps the draft text, and focuses the box. Neither sends. Remove
the reply annotation or press Escape to cancel it.

The nearest enclosing box wins. Canvas links use Quick chat only when no
nearer desk/mail composer owns them and Quick chat is live. Standalone galleries
and dockets keep their existing menus. A reply uses the owning box's recipient;
it never switches to the ticket owner or presenter. Project broadcasts retain
the selected object reference.

Agents can insert these references in `orgtree_message.body`. Reply parity is
`orgtree_message.metadata.reply_to` or `metadata.replies` with a work_item
identity (`org`, `slug`) or document/presentation identity (`org`, `id`), within
ordinary recipient and visibility permissions. Draft staging is local.

Type a message, attach files or drop supported attachments, and send with the configured Enter behavior or send button. Attachment chips name files and allow removal before sending. Uploads land in the target's upload area; a selected file is not already a delivered message.

The notice control arms the next send as passive; its visual state and Alt+N shortcut distinguish it from ordinary waking mail. A prepared reply shows its source and can be cleared; Escape can cancel that prepared reply. Text beginning with slash exposes available hints rather than making every possible CLI slash command valid. Typing `@` opens the mention menu of agents, projects and docket tickets (Tab or Enter completes `@<name> `, or a ticket's reference `@item:<org>/<slug> `); right-clicking any agent, project or ticket link inside an agent or project desk also offers **Mention** as the first context-menu item to insert `@<name> ` (a ticket's reference for a ticket) at the composer caret (or appended when unfocused) and focus the box without sending.

The effort control shows supported choices for the current model/login/pin. It saves a scope effort selection; provider-specific live/next-turn behavior determines when it applies. See [agent desk](../agent-desk/SKILL.md) for the other runtime indicators, and the app's agent-settings pages for the setting's semantics.

Mention suggestions include live agent/project identities and available hub contacts, and the org's current and backlogged docket tickets (never archived ones), shown with the docket icon and their slug and found by slug or title words. Tickets come from the docket's own search as you type, so they can appear a moment after the agents. Names mentioned most recently in the loaded transcript appear nearest the composer at the bottom of the menu, a ticket counting as mentioned by its `@item:` reference; unmentioned candidates keep their ordinary order above them, tickets after agents and projects. Completion inserts text and never sends the message on its own. The mail reply box and Quick chat offer the same list.

The DND badge means this turn holds non-urgent mail until it ends. While that recipient is in DND, the round orange urgency control can bypass the hold for the next send; the user's desk interrupt does not ask for a reason. Urgency is cleared when DND ends rather than saved as a preference. A project broadcast offers this control when a live recipient is in DND and applies it per recipient; it does not make the project itself a running agent.

While responding, the button becomes Stop to interrupt; Enter can still queue text. Stopping the response is different from halting all future wakes. Send results can show queued/delivering/failure and restore failed text for retry. An optimistic clear of the composer is not proof the model read the message.

If a turn stops with unfinished streamed text, that text stays visible as an
**incomplete response**, including after closing and reopening the desk. An
interrupted or killed turn also shows **interrupted**. Other early turn endings
keep the incomplete label. Thinking stays separate. Retention applies across
streaming harnesses; OpenCode marks its already-saved chunks. Where a supported
later native event matches the retained message identity and text prefix, it
replaces the partial in place and clears the marker, including after an actor
restart. OpenCode has no general post-turn completion reconciliation path here.
A marker may therefore remain when no matching completion is received. Unrelated
messages with identical wording stay separate. This preserves received text,
not words the harness never sent.

At the first/last line, plain Up/Down can browse local composer history; otherwise they move the caret normally. The app's Enter preference governs multiline composing rather than a fixed send-on-Enter assumption.

## Jumping to a user mention

A transcript-mention notification, the header @ button or an Attention mention row opens the agent's Chat tab and centers the mentioning passage in that desk's scroll area. It reveals folded pending/system rows and can load older transcript pages to reach the target. New content and pending layout/resize work do not immediately pull a deliberate mention jump back to the bottom; scrolling is still under your control. Simply observing a mention in an already-visible chat clears its attention marker without forcing a new scroll jump.

Tool and supplied-thought durations use seconds for short runs and minutes/seconds for longer ones; hover preserves the exact duration where supplied.

## Tool-output token counts

The I-beam text-cursor mark beside a tool's timing labels is its observed
text-output token count. Counts use `t` below 1,000 and `kt` from 1,000, rounded
to one decimal where needed; hover and the accessible label give the full
number. `~` means estimated, including in the full-number tooltip.

Current tool-output counts are estimates, even after completion: no current
harness supplies a proven exact per-result encoding/receipt. Large observed
outputs can use bounded text samples. Images, request-wide usage, helper-agent
totals and numbers printed inside tool text are not one tool's token receipt.
An absent/unattributed observation stays absent rather than becoming zero.
Completed thinking can show a reported count only when one completed thought
unambiguously owns the response's reasoning receipt.

These counts are separate from billed usage, provider allowance and the live
header's input/context occupancy. See the [desk indicators](../agent-desk/SKILL.md)
for measured/estimated occupancy; an output estimate does not increase that
header by the same number.

## Live shell preview

An expanded executing shell tool can show a live output tail when its harness
emits supported updates. Each tail retains at most **32 KiB of UTF-8 text**;
up to **eight tools / 256 KiB per actor** are retained. **Earlier output omitted**
marks truncation. An additional simultaneous tool can have no live preview
while still retaining its ordinary final result.

Codex command-output deltas and Muse output deltas/in-progress snapshots feed
this preview. OpenCode content snapshots are supported if emitted, but the
checked 2.0.28 emitter does not emit shell progress output. Claude and
Antigravity have no live-tail mapping in this integration. A missing preview
does not mean the command is stalled or silent.

The final result replaces the live display. Interrupt, process exit and turn
replacement discard transient preview bytes; they are not stored as a complete
terminal recording. A live preview is not a completion receipt.

## See also

- [orgtree-agent-desk](../agent-desk/SKILL.md)

## Reply to selected transcript text

Select a passage in a retained transcript row, then right-click **Reply to selection**. The owning desk reply box keeps its existing text and stages the exact excerpt plus nearby context. Several passages from the same conversation may be staged; remove one or cancel all. Sending uses the normal conversation recipient and notice/urgent controls. A refused send restores the selected reply draft.

Supported parts are prose, displayed unsealed thoughts, expanded retained tool inputs and results. Structured JSON keys and scalar values carry their own JSON pointer, so equal strings in different fields stay distinct. Select one source part per gesture. Live/current turns refuse at the engine until settled; hidden machine context, sealed thoughts, helper-private records and reconstructed clipped JSON are not selection sources. Source mapping mismatches refuse rather than guess.

A selection quote keeps its captured text after edits. Activate it to check the source: an exact or uniquely relocated passage may be highlighted after opening; changed or unavailable sources keep the quote and say so. The nearest owning reading surface scrolls. Agents use the Working category's **orgtree-read-reply-source** and **orgtree-tool-message** pages for the equivalent bounded read/send contract.
