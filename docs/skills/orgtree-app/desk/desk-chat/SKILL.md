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

File-reading/writing tool calls show a local-file link immediately after the tool chip, labelled with only the filename; hovering shows the full path. A path already shown by the link is omitted from the tool argument so it appears once. Skill reads link when the event includes the resolved `SKILL.md` path or when a name-only call resolves to exactly one file in the selected, materialized skill registry; missing or ambiguous names stay unlinked.

Chat is the conversation surface. It includes messages, thoughts when supplied, tools, typed events, attachments and pending delivery rows. Opening another tab does not stop the agent. Earlier messages load on demand; failure offers retry rather than claiming the transcript ends there.

Returning to the latest messages or reopening a desk keeps earlier history
available to scroll back into. The start-of-conversation marker means the loaded
history has reached the actual beginning, including on Antigravity agents; it
does not mean that older rows were merely released from the screen's cache.

Chat Markdown can display inline images. Relative image paths resolve within the author's files; absolute Windows paths and HTTP(S) URLs use the checked image endpoint. PNG, JPEG, GIF and WebP are supported there; an image that cannot be loaded falls back to a link (local files can be revealed in their folder).

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

Type a message, attach files or drop supported attachments, and send with the configured Enter behavior or send button. Attachment chips name files and allow removal before sending. Uploads land in the target's upload area; a selected file is not already a delivered message.

The notice control arms the next send as passive; its visual state and Alt+N shortcut distinguish it from ordinary waking mail. A prepared reply shows its source and can be cleared; Escape can cancel that prepared reply. Text beginning with slash exposes available hints rather than making every possible CLI slash command valid. Typing `@` opens the agent/project mention menu (Tab or Enter completes `@<name> `); right-clicking any agent or project link inside an agent or project desk also offers **Mention** as the first context-menu item to insert `@<name> ` at the composer caret (or appended when unfocused) and focus the box without sending.

The effort control shows supported choices for the current model/login/pin. It saves a scope effort selection; provider-specific live/next-turn behavior determines when it applies. See [agent desk](../agent-desk/SKILL.md) for the other runtime indicators, and the app's agent-settings pages for the setting's semantics.

Mention suggestions include live agent/project identities and available hub contacts. Names mentioned most recently in the loaded transcript appear nearest the composer at the bottom of the menu; unmentioned candidates keep their ordinary order above them. Completion inserts text and never sends the message on its own.

The DND badge means this turn holds non-urgent mail until it ends. While that recipient is in DND, the round orange urgency control can bypass the hold for the next send; the user's desk interrupt does not ask for a reason. Urgency is cleared when DND ends rather than saved as a preference. A project broadcast offers this control when a live recipient is in DND and applies it per recipient; it does not make the project itself a running agent.

While responding, the button becomes Stop to interrupt; Enter can still queue text. Stopping the response is different from halting all future wakes. Send results can show queued/delivering/failure and restore failed text for retry. An optimistic clear of the composer is not proof the model read the message.

At the first/last line, plain Up/Down can browse local composer history; otherwise they move the caret normally. The app's Enter preference governs multiline composing rather than a fixed send-on-Enter assumption.

## Jumping to a user mention

A transcript-mention notification, the header @ button or an Attention mention row opens the agent's Chat tab and centers the mentioning passage in that desk's scroll area. It reveals folded pending/system rows and can load older transcript pages to reach the target. New content and pending layout/resize work do not immediately pull a deliberate mention jump back to the bottom; scrolling is still under your control. Simply observing a mention in an already-visible chat clears its attention marker without forcing a new scroll jump.

Tool and supplied-thought durations use seconds for short runs and minutes/seconds for longer ones; hover preserves the exact duration where supplied. A live shell preview appears only inside the expanded, currently executing tool row. It is a preview of output, not evidence the command has completed.

## See also

- [orgtree-agent-desk](../agent-desk/SKILL.md)
