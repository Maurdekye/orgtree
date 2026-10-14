# Tool-call writing time and link menus

User requested these transcript improvements on 2026-10-13 at 17:47UTC, then
specified immediate tool-name display, two final durations (not two events),
and pencil/arrow icons. Docket: show-tool-call-writing-time-and-context-menus-on.

## 2026-10-14 refinements

The shared tool-chip layout now renders in-progress calls. Writing uses a
pencil in the status position and shows the name and summary derived from the
input already streamed. The transient preview holds at most 64,000 UTF-8 bytes
per call, tolerates unfinished strings, omits incomplete keys/unknown values,
and updates expanded structured input in place. Preview helpers and transport
are unlogged, and preview input never enters conversation storage.

Executing calls use a play icon in the status position. Finished dots and
colours remain. Writing and execution durations display only their icons and
numbers, with full wording kept in accessible labels/tooltips. Both observed
live clocks start immediately; the former ten-second execution threshold is
removed. Interrupted inactive calls stop counting. Missing finished observations
remain explicitly unavailable through the icon's accessible label/tooltip and
a dash, never a fabricated zero. Unknown fields are absent from active chips.
Line counts are shown only when a chip is expanded.

Muse/ACP and Antigravity updates refresh the known input summary/references on
the existing chip without resetting identity or execution start. Complete-input
events from any harness use the shared execution chip. The existing provider
signal limitation remains: no fabricated generation phase or writing duration
where the harness does not expose that observation.

Ticket reference menus now contain Open details, Owner…, one separator, then
Copy ticket title / Copy slug / Copy reference. The Owner submenu obtains its
full entries from the same current agent-menu registry and renders through the
same context-menu component as direct agent targets. Click or Enter on Owner
executes that menu's actual Focus action and closes; hover/Right opens the
submenu without acting. Missing/unavailable Focus stays disabled, and current
agent permission/availability gates remain. Contextual fold/staff actions on
direct docket rows retain their existing routes.

Round 434 verified these refinements: seven tool-writing renderer cases, six
object-menu cases and three shell-error regressions passed 16/16; four native
tracker cases passed; the actual synthetic stream-to-chat proof passed 11/11,
including both partial-preview checks, persistence/reload and cancellation.
Root typecheck passed with zero errors. Timing red failed the five expected
new-behaviour cases with two passing controls; menu red failed the two expected
cases with four passing controls. The base-engine preview-only control failed
exactly the two new preview checks. Detailed provenance and limits are below.

## Earlier timing contract (historical wording; refinements above supersede it)

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

## Round 434 measured verification (2026-10-14)

Final author source was `e4261a1` on `830f0e2`; the added commit only normalizes
DOM whitespace in three clock assertions. It was picked as patch-identical
`ecbb2e2`. Batch `9006950` also includes the shortcut-list composition correction
`1483fcb`, which documents Enter on an actionable Owner submenu parent. The
final renderer helper passed 16/16 in 17 seconds at `9006950`. Root typecheck
checked 301 worktree files, zero errors, in 5 seconds at that same tip. Native
`runtime::toolwriting::tests` passed all four named cases in the 22-test union;
compilation/execution took 41 seconds. Stream proof passed 11/11 in 24 seconds
using the batch's retained `2dc1d56` engine, unchanged by the renderer fixups.

The retained evidence is under `D:/orgtree-work/tmp/rig-opus/batch-434/logs`:
`o6-green-434c.log`, `o6-red-434c.log`, `o6-red-menu.log`, `o-test-union.log`,
`proof-A-tool-writing.log`, `red-tool-writing-preview.log`, and
`tc-root-434c.log`. The proof's durable result and captured chips are under
`D:/orgtree-work/rig/rig-opus/evidence/tool-writing-20261014T123111`.
Receipt engine SHA256 is
`1b98eef25efa29315ec69fd1f8f8cff12a9d7ae59b8a132f3017bb84d38ddb32`;
fake CLI SHA256 is
`3445ebee8389c762a68ad3f6177eb9dde2973c1e67511d6151d803549df1a775`.

The first 15/16 renderer result was an assertion comparing adjacent DOM text
spaces; the test-only correction retains the expected icon/clock behaviour.
The first typecheck exposed another item's missing import; after its fix the
root check passed. Final renderer union was 439/441, with only contextmenu
§B4/§B4b failing identically on the base; those failures are recorded separately,
not counted as passing. The same-millisecond retirement and rejected menu
lookup regressions now pass in the focused helper.

Coordinator marked the item done and integrated it locally through batch
`920ebb6` into `rust-engine` tip `601deef`, intended for `4.3.0-alpha.2`.
This records source integration and synthetic acceptance only. No fresh
installed-app, screenshot, real-provider turn, device or publication check is
claimed. Provider generation-signal gaps described above remain.
