# Tool-call writing time and link menus

User requested these transcript improvements on 2026-10-13 at 17:47UTC, then
specified immediate tool-name display, two final durations (not two events),
and pencil/arrow icons. Docket: show-tool-call-writing-time-and-context-menus-on.

## Timing

Claude-compatible `content_block_start` tool-use events begin an observed clock
keyed by the actual tool-use ID. The active transcript line immediately reads
`Writing <name>` with the pencil icon and elapsed time; it has no display delay.
Block indices associate interleaved stop events with their tool IDs. Duplicate
start/stop observations do not restart clocks. A completed full call also ends
generation if the provider omitted its block-stop event. The tracker stores no
argument text.

Admission stores `writing_secs` in the existing durable tool chip; execution
retains its independent `started_at` and `ended_at` conventions. The final line
shows a pencil beside `written in …` and an arrow beside `ran for …`, with
separate accessible labels/tooltips. The same timing component also renders on
file and presentation cards and in expanded tool detail. The existing execution
running-counter threshold is unchanged; it does not govern writing activity.

Active writing rows share one ordinal with draft/thinking partials, and are
included in both node-stream frames and HTTP live snapshots. Replacements and
retirement use the same conversation update, so one still-writing parallel call
does not disappear when another is admitted. Taking a turn clears its active
writing snapshots. A delayed HTTP fetch preserves the newer stream's writing
snapshot; a current HTTP snapshot repairs missed frames/reconnects. Generated
durations remain beside the admitted chip across transcript reload. An interrupted
call never admitted as a chip loses its transient activity; no fictitious final
call is created.

Current Codex, Muse and Antigravity adapters provide completed argument objects
or execution steps, not an observed start/end of argument generation. They do
not acquire a fabricated writing clock. Historical/unobserved writing and missing
execution observations display as unavailable. This is a concrete signal limit,
not proof that those providers cannot expose the phase through another protocol.
Claude-compatible gateway/local-server harnesses share the implemented path if
their CLI emits the corresponding blocks.

## Menus

Per-window object navigation follows the existing agent-navigation registry.
The host reads the current org and uses existing ticket/watchdog routes. Ticket
React chips, sanitized Markdown chips, bare ticket mentions and tool-output
links are marked with the exact target. Watchdog desk/tool cards, canvas satellites
and detail headings carry the owner-qualified dog ID. Foreign/unavailable refs
remain inert. Dog IDs resolve against the current tree; spent/deleted dogs receive
no management actions. Tickets are fetched by exact current-org ID when needed;
missing targets produce no operative menu. Opening a menu does not execute an
object action. Path/query-shaped ticket IDs are refused before lookup.

Ticket rows and links share `ticketActions`, preserving the existing navigation,
owner, slug/reference copy and contextual fold actions. Backlogged eligible links
reuse the existing quick-staff builder and catalog gate. A surface without the
corresponding route offers no invented action. Watchdog menus and detail buttons
share `watchdogActions` and the existing pause/resume/remove HTTP route and spent
gate. Normal left clicks retain their original routes. Inner object links win
over a containing transcript/row menu, as agent links already do. Late ticket
lookups cannot replace a newer menu or survive a current-org change. Native menu
deferral for editing, selection and ordinary links stays in the shared mechanism;
menu position/portal/focus use the clicked element's document.

## Verification status at source checkpoint

Typecheck and diffcheck passed. Prepared `runtime::toolwriting` native cases and
renderer `toolwriting.test.tsx` / `objectnav.test.tsx` synthetic cases cover the
observed clock and independent ID bookkeeping, immediate name/icon rendering,
both completed/reloaded durations, interleaved transient retirement, canonical
link menus, owner scope, invalid/foreign/missing targets and stale completions.
These tests have **not executed yet**: coordinator external-heavy HOLD applies.
Native build/check, focused renderer runs, any required changed-path rig receipt
and independent review remain. No real-provider, live-data, installed-app or
publication acceptance is claimed. Update this section with measured receipts
before final hand-in.
