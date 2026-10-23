# Orgtree 4.4.4

Orgtree 4.4.4 lets you reply to a highlighted passage, adds keyboard navigation for the org, opens Work and Presentations on what needs you, hides empty desk tabs, and fixes a long list of smaller issues found in a full review of the app and its documentation.

## Messages and transcripts

- **Reply to a highlighted passage.** Select part of a mail, a transcript (replies, visible thinking, tool calls and their output), a Markdown presentation or a ticket's text and reply to just that passage. Quoted passages survive later edits to the source. Agents can do the same through their tools.
- **Codex agents keep their sealed thinking steps in history** as placeholders, as Claude agents already did, and `orgtree_read_transcript` now includes thinking for every AI tool.
- **Queued messages always have Show/Hide.** The queue of not-yet-delivered messages can be folded at any size; it still folds on its own at six or more.
- The "↑ you" preview above the message box shows your last real message, not a run of "Agent hired" notices.

## Navigation and desks

- **Shift+Alt keyboard navigation.** Shift+Alt+Up/Down/Left/Right move to the manager, the centre-most report and coworkers (wrapping); Shift+Alt+Space fits the whole org; Shift+Alt+Backspace goes back through earlier agents; Shift+Alt+S opens the switchboard. Alt+Left/Right switches desk tabs. Shift+F6 and Shift+F8 are replaced by these; Shift+F7 stays.
- **Work and Presentations open on what needs you**: a ticket flagged for attention or the oldest unread presentation first, then the last one you viewed, then the top of the list.
- **Empty desk tabs are hidden.** A desk's Presentations and Docket tabs appear only when there is something to show; if only the team has items, the tab opens with Team ticked. Project desks gain the Team checkbox and desk Presentations gain Show retired.
- **Tooltips on Retire, Dissolve and Do Not Disturb** explain what each does.

## Projects and teams

- **Project draft cards have a settings gear**, so you can set a project up before creating it.
- **Very deep teams work everywhere**: presentations, file delivery, the logo and team galleries no longer stop at 1,024 levels.
- Checkups and reminders work through every held record in batches, so none is left waiting.

## Settings and safety

- **The "keep PC awake" option is removed**; it never prevented sleep.
- **Charter folders are read safely**: links and online-only placeholders are skipped and large files are refused before reading.
- The tool list Orgtree offers to your own AI assistant shows only the options that work there.
- Setting labels and hints were corrected throughout, including the effort default and how turn-limit changes apply to running turns.
- **Org windows no longer flicker a scrollbar at some window sizes and display scales**, which also made agents impossible to focus.

## Notes

- The user documentation and the agents' glossary were reviewed in full against the app for this release and corrected where they disagreed.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
