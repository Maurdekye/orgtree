---
name: orgtree-desk-chat
description: Explain transcript cards, tool displays, reply controls and the desk composer.
---
Up: [orgtree-desk](../SKILL.md)

# Desk Chat tab

File-reading/writing tool calls show an explicit path as a local-file link immediately after the tool chip. Skill reads link when the event includes the resolved `SKILL.md` path; name-only Skill calls remain unlinked until transcript writing can resolve a unique skill file.

Chat is the conversation surface. It includes messages, thoughts when supplied, tools, typed events, attachments and pending delivery rows. Opening another tab does not stop the agent. Earlier messages load on demand; failure offers retry rather than claiming the transcript ends there.

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

While responding, the button becomes Stop to interrupt; Enter can still queue text. Stopping the response is different from halting all future wakes. Send results can show queued/delivering/failure and restore failed text for retry. An optimistic clear of the composer is not proof the model read the message.

At the first/last line, plain Up/Down can browse local composer history; otherwise they move the caret normally. The app's Enter preference governs multiline composing rather than a fixed send-on-Enter assumption.

## See also

- [orgtree-agent-desk](../agent-desk/SKILL.md)
