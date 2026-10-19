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

Executing calls use the execution-time right arrow in the status position
(user 2026-10-14 17:38UTC, replacing the play icon). Finished dots and
colours remain. Writing and execution durations display only their icons and
numbers, with full wording kept in accessible labels/tooltips. Both observed
live clocks start immediately; the former ten-second execution threshold is
removed. Interrupted inactive calls stop counting. Missing writing observations
omit the whole writing-time slot, including its pencil, dash and separator
(user 2026-10-14 17:36UTC). A measured zero stays visible. Missing execution
observations retain the accessible explanation and dash. Unknown fields are absent from active chips.
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

## Clocks belong to their turn (2026-10-14)

Docket `tool-calls-left-open-by-an-earlier-turn-count-up`. The user saw a
Muse call from the day before count "23h 08m" during a new turn. That call
never got a result on its chip: its turn ended at the silence limit while the
command hung in Muse's Session 0 sandbox. The clock ran because the desk knew only that
SOME turn was active (`TurnActiveContext`, per desk). That flag also turns on
for the composer's optimistic busy right after a send and while the agent
waits for a slot or compacts, before any turn exists.

Rule: a live execution clock, and the executing icon, run only for a call of
the turn running now. A writing clock stops once the call is known to be an
earlier turn's. A call an earlier turn left open shows the existing
unavailable form (arrow and dash), never a live count. No end time is
written for it and no duration is shown: the chip is not changed.

- **Engine.** The running turn's admission (`turn.admitted_at`, taken before
  the turn claims its mail, so every call of the turn starts after it) is
  published as `turn_started_at`. It sits beside `busy` in the actor's runtime
  view (the node's overlay) and in the chat payload's live view, and is null
  while idle (`idle_runtime`).
- **Renderer.** The desk provides the newer of its two copies as
  `RunningTurnContext` while a turn is active. `useLiveCall` times a call only
  when its `started_at` is at or after that start; an unknown start times none.
  The optimistic send clears the copy it carries.

A test that mounts a running chip under `TurnActiveContext` must also provide
`RunningTurnContext` with a start at or before the call's, or the chip shows the
dash, as the desk does before its turn is known.

Verification, measured in batch round 439 (2026-10-14):
- Renderer `toolclock-turn` 5/5. Against the renderer of the base `0f8638f` the
  file first reported nothing: its checks for absent elements handed jsdom
  elements to `assert.equal`, and the failing ones ran out of memory (AGENTS.md).
  With those five checks as booleans, as the file now has them, 4 fail and only
  the running turn's own clock (the control) passes; one of the 4 fails because
  the base has no `ofRunningTurn`.
- `toolclock-live`, `toolwriting` and `toolwriting-slot` pass (their running
  chips now name their turn).
- Engine `domain::tree::idle_runtime_tests` 1.
- Rig `turn-start-clock.mjs` 6/6: idle null, the same start on both copies
  during the turn, the call at or after it, the start this turn's, a control,
  null again after. Against the base engine 1 passes (the control) and 5 fail.
- Captures: `toolclock-turn-pages.mjs` builds the fixture `toolclock-turn-visual.tsx`
  against this tree and the base, `toolclock-turn-capture.cjs` paints both in
  dark and light and checks them (`passed: true`, four distinct pictures; the
  page builder ran with its dependency paths pointed at shared modules):
  before, the earlier call counts live with the executing icon; after, it shows
  the finished dot and the dash, marked unavailable; the running call shows
  "33s" in both.

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
not acquire a fabricated writing clock. Historical/unobserved writing slots are
omitted; missing execution observations display as unavailable. This is a concrete signal limit,
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

Monitor fire/quiet cards retain a spent or removed watchdog's recorded name as
an object link. Its label and tooltip say "no longer exists"; its menu offers
copy name/ID, with no live-dog actions or fabricated details (user 2026-10-19).

Ticket rows and links share `ticketReferenceActions` and `ticketOwnerAction`.
The transcript order stays canonical; docket rows append their contextual fold
and eligible quick-staff actions after one separator (user 2026-10-14: match +
keep extras). Row-draw staffing warm-up and catalog gates stay intact. A surface
without the corresponding route offers no invented action. Watchdog menus and detail buttons
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
