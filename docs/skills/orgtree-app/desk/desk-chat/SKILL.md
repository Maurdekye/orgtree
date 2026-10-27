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

## Live helper badge (4.5.0)

When observed helpers are running, the header shows **N helpers**. Click it
to open the temporary **Helpers** panel in this desk's window. Select a helper
to inspect its type/description, reported model, observed start and status.
The panel refreshes while helpers run; it keeps recent finished entries while
open. Closing stops its readers. The badge hides at zero observed live helpers.
Transcript output follows the bottom until you scroll away; return to the
bottom to follow again. Missing models are **Not reported**, not borrowed from
the parent. A saturated list discloses its 64-identity bound.

Measured source/native-format support, without real-provider execution:

| Harness | Detection/details | Live transcript |
| --- | --- | --- |
| Claude Code | Explicit Agent/Task and background lifecycle; excludes shell jobs and nested helpers. | Captured first-level output during the parent's turn. |
| Codex | Parent-linked receiver IDs/explicit child states; spawn completion alone never means finished. | Not available for this harness. |
| Muse | Explicit subagent item lifecycle and supplied metadata. | Not available for this harness. |
| OpenCode | No verified negotiated child identity/lifecycle join. | Not available for this harness. |
| Antigravity | No verified child identity/lifecycle join. | Not available for this harness. |

Codex status is its latest parent-stream observation, not a separately
subscribed child heartbeat. Zero does not prove support for other harnesses.
Agent parity: orgtree-tool-read-transcript (orgtree-working › inspection), with
`helpers:true` or `helper:{seq,tool}`, under existing self/downward access.

The **↑ you** chip previews the last user-written communication in the nearest
earlier delivered batch above the visible transcript. Clicking it jumps back
to that batch. Messages, replies, question answers and initial hire instructions
can supply the preview; automatic lifecycle or policy notices cannot, even
when their event actor is the user. A notice-only history has no chip. A batch
contributes one preview, never a concatenation of event titles; its other
messages and event cards remain in the transcript.

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

The **↓ jump to bottom** card appears only when follow is off and the loaded
transcript overflows its visible scrollport. It stays hidden when everything
fits, including after resizing or folding content. This does not change follow
state or discard earlier history: scrolling down to within eight pixels of the
tail, or explicitly jumping to the bottom, resumes follow as before.

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

Pending/undelivered cards sit separately from delivered conversation. Every
nonempty queue group has a Show/Hide toggle in its arrow/count separator line,
including a single message. Click that line to toggle; there is no extra
duplicated count row below it. Until
you choose, fewer than six rows stay open and six or more collapse automatically;
the count uses rendered rows after deduplication. Your choice survives arrivals,
polling and count changes while that group stays on screen. It resets when the
group empties, the desk closes/reopens or the agent starts a new generation.
There is one undelivered group, including system cards and optimistic/failed
sends. During a turn it sits below the live reply; current-turn mail appears
normally above the reply and neither is collapsed. When idle, all undelivered
mail sits under that one separator. Its count excludes current-turn mail.
Delivered messages display normally; their five-line body previews are unchanged.
A quote/reply navigation can reveal a folded target;
opening a disclosure is not a read/delivery acknowledgment.

Event cards and reference links can open their exact related agent, mail, work item, watchdog or document when a route is available. Copy/reply menus use durable source identity; a missing exact source can disable a reply action rather than inventing a target.

Each mention wears its kind on the left (user 2026-10-27): an agent its model badge, a project its folder, a docket item the docket icon, a document or presentation the document icon, an app the Apps icon and a panel a window icon, with the name in strong text that takes the link colour and an underline on hover or focus. A docket item mention shows the item's current full title (user 2026-10-27), updated when the item changes; its slug stays in the ticket menu's Copy slug, and a slug written as a plain word in a docket description links by the item's title too, the words around it as written (unlinked prose keeps the slug). Every ticket link (a mention, a ticket a docket tool call such as orgtree_work names, an item of a docket reminder, a plain slug linked in a docket description) wears the ticket's docket status colour as an edge on its left (user 2026-10-27), follows the item when it changes, and its tooltip leads with the status (`In progress · title`). The tickets a tool call names and a docket reminder's items use the same link as a mention in chat, with the full title (the slug, or the title the reminder recorded, until it loads). A presentation mention wears the accent edge while you have never opened it and a duller one once it was replaced since you last read it, its tooltip leading with **Unread** or **Modified since you last read it**; a read presentation has none, and opening it clears them all at once. The presentation card under an orgtree_present tool row shows the presentation's current title and is highlighted the same way, as the desk header's badges and the canvas chips are. An app or panel mention shows the current name (a panel with its app's) and opens it as its row in Apps does; see orgtree-apps. A reference that cannot be followed shows the token as written with unavailable, other org or not from here, and no icon.

A network mention, @net: or @org:, names a party outside the org, so it sits on a pill tinted for its kind in Hubchat's colours (user 2026-10-27): an Orgtree org terracotta, an agent session blue, a person grey. A person's pill and picture are round, an org's or session's squared off, and an address no hub roster lists has a dashed outline instead. Its icon is the party's picture when Orgtree can see one (the logo of an org on this PC, or the picture a hub this org is registered on advertises), else the Hubchat mark when Hubchat is installed, else a globe. When the hub roster names the party, the chip shows that name on its outlined pill, and its icon marks it as outside (user 2026-10-27); a copy of the chip or of the message still gives the address as written; the hover gives the kind and name, the address, then what a click does. Without a name the text is the address as written, its @net: or @org: dimmed, and the hover gives the kind, then what a click does. An org on this PC keeps its organization hover and opens in a new window; any other address opens in Hubchat, and its chip is inert when Hubchat isn't installed. The menu keeps Mention (in a message box), Open in Hubchat and Copy identity.

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

The notice control arms the next send as passive; its visual state and Alt+N shortcut distinguish it from ordinary waking mail. A prepared reply shows its source and can be cleared; Escape can cancel that prepared reply. Text beginning with slash exposes available hints rather than making every possible CLI slash command valid. Typing `@` opens the mention menu of agents, projects, docket tickets, presentations, apps and panels (Tab or Enter completes `@<name> `, a ticket's reference `@item:<org>/<slug> `, a presentation's `@doc:<org>/<slug> `, an app's `@app:<org>/<slug> ` or a panel's `@panel:<org>/<slug> `); right-clicking any agent, project or ticket link inside an agent or project desk also offers **Mention** as the first context-menu item to insert `@<name> ` (a ticket's reference for a ticket) at the composer caret (or appended when unfocused) and focus the box without sending.

The effort control shows supported choices for the current model/login/pin. It saves a scope effort selection; provider-specific live/next-turn behavior determines when it applies. See [agent desk](../agent-desk/SKILL.md) for the other runtime indicators, and the app's agent-settings pages for the setting's semantics.

Mention suggestions include live agent/project identities and available hub contacts, the org's current and backlogged docket tickets (never archived ones) by full title with the docket icon, presentations in the org's galleries (never dismissed ones) by title with the document icon, and every app and saved panel by name (a panel as `<app> · <label>`) with the Apps or window icon. Every word typed after `@` must appear in a suggestion's name, title or slug. The list is newest first (user 2026-10-27): each suggestion by the latest time it was mentioned in the org's mail by anyone, operated on or presented, then by name. Operated on means an agent's latest turn, status report or turn in flight; a ticket's latest change; a presentation's latest presenting; an app's latest change or the latest use of one of its copies; a panel's latest use or change. A project has only its mentions. Typing narrows the list without reordering it. Names mentioned in the loaded transcript still come first, most recent first, a ticket counting as mentioned by its `@item:` reference and a presentation, app or panel by its own. The best suggestion sits nearest the composer. A kind prefix lists only that kind, all of it: `@agent:`, `@project:`, `@item:` (tickets), `@doc:` (presentations), `@app:` and `@panel:`. Text after the colon filters, and a long form being typed (`@doc:<org>/week`) filters by what follows the org; picking a suggestion inserts its usual reference (`@<name> ` for an agent or project). Another `@word:` opens no list. Tickets, presentations, apps and panels come from one bounded engine read that pages: the menu shows the first suggestions and reads more as you reach the end of the list, so they can appear a moment after the agents. Completion inserts text and never sends the message on its own. The mail reply box and Quick chat offer the same list.

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

Read / read_file / view_file counts describe the returned file text or slice,
not the short read summary or the whole file's line total. They remain `~`
estimates. Claude uses its native text-read result; Antigravity uses the exact
completed step in its selected session; Muse uses retained output from that
session and item. If retained text is unavailable, Antigravity/Muse omit the
count. Large outputs use bounded sampling. No file is reopened to invent a
historical count. This is display information and adds no tool action.

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

## Row token counts (4.5.0)

Every conversation row now ends with its token count beside the same I-beam
mark (user 2026-10-27: "token counts in messages of all kinds"; "and user
messages"), so you can see what fills an agent's context:

- **Agent responses:** Claude reports each response's output, so the count is
  plain (`412t`; hover: "412 output tokens reported by Claude for this
  response", covering its thinking, text and tool calls). Codex and Muse report
  a reply's count when the request produced only that reply; otherwise the
  response is estimated (`~`) from its text and tool calls.
- **Delivered messages:** your messages, agents' mail, watchdog and monitor
  events and org notices show an estimate of exactly what Orgtree sent the
  agent. A delivery shown as several cards has one count, under its last card
  that is not a folded system notice. Hover lists the parts: org state, provider
  usage, org notices and each message by sender. Text the CLI adds by itself is
  not included.
- **Tool calls:** the call's input count sits beside its arguments; the
  result's count stays with its timings. A row that is only one estimated call,
  or only one thought, shows its count there and not again below.
- **Not counted:** a dash with the reason on hover, never 0: rows only shown to
  you, compactions (a provider compaction also shows the context size it
  reported before compacting), slash commands, and mail the agent fetched with
  orgtree_inbox (counted in that tool result). Thinking whose tokens were not
  reported shows a dash too.

Rows from before 4.5.0 show no count. Agents read the same counts as each
row's `tokens` in orgtree_read_transcript; see `orgtree-tool-read-transcript`
(orgtree-working › inspection).

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

The selection menu also has **Copy** and **Select All**, with platform shortcut
hints; Select All selects the current document's text. Editable composers use
the native text menu: spelling suggestions and **Add to dictionary** for an
identified misspelling, Undo/Redo, Cut/Copy/Paste, Delete and Select All. Spelling
entries follow completed browser/OS spelling checks; they may be absent before
the browser checks the entered word. Rich
editors also offer Paste as plain text. Availability follows the current field
and selection. See App settings > Keyboard shortcuts for the detailed text-menu
commands. Menus stay at the pointer in their originating window.

Supported parts are prose, displayed unsealed thoughts, expanded retained tool inputs and results. Structured JSON keys and scalar values carry their own JSON pointer, so equal strings in different fields stay distinct. Select one source part per gesture. Live/current turns refuse at the engine until settled; hidden machine context, sealed thoughts, helper-private records and reconstructed clipped JSON are not selection sources. Source mapping mismatches refuse rather than guess.

A selection quote keeps its captured text after edits. Activate it to check the source: an exact or uniquely relocated passage may be highlighted after opening; changed or unavailable sources keep the quote and say so. The nearest owning reading surface scrolls. The shared [selection limits](../inbox-screens/SKILL.md#reply-to-selected-mail-text) also apply here. Agents use the Working category's **orgtree-tool-read-reply-source** and **orgtree-tool-message** pages for the equivalent bounded read/send contract.

A clipped prose/plain-result view may quote its visible prefix only after it matches version-bound canonical source windows. A clipped or repaired structured JSON view cannot quote invented closing text.

If a selected desk reply fails after you have started a new draft, the new draft stays intact. The failed message retains its original text, attachments and selected passages; use its **Restore** control to recover that submission. Source parts over 1 MiB refuse before DOM mapping; use a smaller retained field or JSON scalar.
