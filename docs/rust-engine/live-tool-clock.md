# Live tool clocks and Codex generation observation

User 2026-10-14 16:40:49UTC requires floor(elapsed) whole seconds while writing,
with ticks on the true elapsed-second boundaries. Completed duration precision
stays unchanged. Docket `in-progress-writing-timers-should-tick-in-whole-s`.

The previous clock formatted elapsed milliseconds with the completed formatter
and ran a 1-second interval from arbitrary component mount time. A component
mounted 200ms into a call consequently showed 1.2s, 2.2s, and so on. The shared
live hook now schedules its next timeout from the observed start timestamp,
recomputes actual elapsed time after delayed callbacks, and shows 0s/1s/2s.
Both writing and executing tool timers share this fix for every harness. Final
observed 1.2s and 200ms clocks still use the unchanged precise formatter.
Changing the start cancels the old timer; inactive execution stops ticking;
missing/invalid observations add no clock. No persisted duration is changed.

User requests 2026-10-14 17:36–17:38UTC remove the entire writing-time slot
(pencil, unavailable dash, and its separator) when no duration or live writing
start was observed, including old rows. A measured zero keeps its pencil and
`0 ms`; observed live writing retains the whole-second timer. This is based
on the call's observation fields, with no provider-name inference. Execution
time and its own unavailable placeholder remain unchanged. Executing tool rows
use the same `ArrowRightIcon` as their execution-time display, preserving the
status class, size, title and aria-label. Writing pencils and finished/error
icons retain their existing behavior. All desk/popout/list transcript hosts use
the shared ToolChip; other PlayIcon usages are resume/rehire actions.

The separate source commits for these requests have three new observation
cases and an explicit running `ArrowForwardIcon` assertion prepared for the
next rig batch. Independent red controls restore only the historical behavior
from the named product commits, within the current composed source: writing
(2 failures/1 known-duration control) and running icon (1 failure/6 controls).
They preserve the separate running-turn clock fix. With presentation/file splits,
green union expects 41 tests, plus root typecheck and four
before/after dark/light captures of real ToolChip rows. These new checks have
not run. Their fixture checks preserved writing/completed states and execution
durations as well as omission and the running icon; PNGs require inspection.

## Presented-document row and card (2026-10-14 17:40–17:41UTC)

The successful orgtree_present call now renders the ordinary tool line with
name/argument summary, clocks, fold/expand and transcript row actions, followed
by the existing PresentationCard with document icon/title and no times. It uses
the same PresentationCard/presentationMenu as desk document badges, canvas
chips and gallery cards, with no copied menu. Gallery rows additionally have
close/dismiss actions from their own collection context. Failed presentations
keep the ordinary error row. Card opening retains its existing document route.
The title-only body matches the parent of history commit e8e2457; the timed
ordinary row is now retained instead of the old early return.

Four prepared presentation tests cover split/fold/open, unknown-writing omission,
markdown/HTML menu parity with desk badges, and error fallback. Red substitutes
only the old presentation early return: two split-row failures and two existing-behavior controls.
Combined four themed captures include the presentation before/after, with timing
placement checks. This new request is unverified until rig receipt/PNG review.

## Sent-file row and card (2026-10-14 18:00–18:03UTC)

Sent files follow the same split: the ordinary orgtree_send_file row owns
timing and expanded input/result details; its sibling keeps the pre-timing
download card (name/size/note/link), or image card with ImgCardCaption and the
existing lightbox/download route. Exact earlier card markup was checked in
e8e2457's parent. Error sends render only the error tool row.

There is no canonical sent-file context menu or file object-nav kind in the
current source. Coordinator explicitly corrected that extrapolated requirement:
preserve existing browser link and containing transcript-row menus, build no
new file menu. Five prepared tests include normal/image split and links,
expanded details, unknown-writing omission, error fallback, and a native-link
passing control. Restoring only the old file early returns expects four failures plus that
control; green union41/rootTS and four themed captures remain unrun. The visual
runner serves only generated assets and one synthetic SVG image over loopback,
awaits Electron exit, and closes the server before returning. Actual decode is
checked so image captures cannot silently show a broken image.

## Round 439 fixture correction (2026-10-14)

Rig measured two failures on the original display stack alone: the presentation
and file fold tests supplied inline `input` but the real completed row fetches
`toolinput/{input_seq}/{tool_id}`. The fixtures now carry that identity and mock
the exact GET response, asserting no read before expansion and one read after.
The product row already uses that contract; no runtime change was needed.

The composed batch additionally rejected the executing fixture as stale because
it supplied only the busy flag. Both the new slot test and the visual fixture
now supply their real synthetic turn start through `RunningTurnContext`, like
the existing clock tests. Red/visual controls no longer replace whole old files:
they restore only the old writing span, running icon or card early return from
`8508043`, `f2bc651`, `1713b74`, and `dd0b354`, leaving turn ownership intact.
The source-only `audit-controls` mode checks all four independent transformations
and their combination without compiling or starting processes beyond Git reads.
Its ten file transformations and syntax/diff checks pass. Rig picked the fixture
correction patch-identically as `bc737c0`: renderer41/41 and root typecheck exit0
are measured. Running, presentation and file reds fail their named assertions
with 6/2/1 passing controls. Writing red reports2 failures/1 passing known-duration
control, but its second failure is an array-allocation error while formatting a
DOM-versus-null assertion, so that case is not accepted as semantic evidence.
Slot-absence assertions now compare booleans; writing red must be rerun.

Canonical visuals still return stale dark paint events after the theme becomes
light. Rig's one-change `capturePage()` diagnostic passes all four themed frames,
and both rig and author inspected those PNGs. The canonical driver adopts that
capture method and preserves the background/semantic checks. A two-column
fixture at1000x760 makes all eight cases, including the full image caption,
fit Session0's1024x768 display; it now rejects out-of-viewport case bounds.
The old PNGs clip the image bottom despite successful decoding, so they do not
prove full image visibility. New committed captures still await rig receipt.

The diagnostic light presentation card has a dark background with dark text
in both before and after, a shared pre-existing style observation outside these
four display changes. It is reported to the coordinator without changing CSS;
no claim about its installed-app appearance is made.

Rig round 437 measured five fake-timer cases: actual alpha.3 `ae0b5fd`
toolclock red has four target failures and one completed-precision passing
control; green 5/5, writing/menu/shell regression 16/16, timing union 29/29,
and root typecheck exit 0. Test-suite typecheck retains the same 825 baseline
errors, with none new. Four committed-driver before/after dark/light captures
pass the painted-theme checks and were inspected by both rig and author.
At the fixed observed elapsed value of 1.2s, live writing/executing clocks
change from 1.2s to 1s; completed clocks remain 1.2s / 200ms. The capture driver
waits two animation frames after a theme toggle to avoid stale offscreen pixels.
This is synthetic renderer evidence, not installed-app or real-model acceptance.

## Codex tool-call writing timing investigation

The report initially described assistant text timing. Coordinator corrected
the scope on 2026-10-14 16:42:46UTC: the user means Claude's tool-call generation
timing; do not add a new assistant reply timer. Docket
`codex-agent-transcripts-show-no-writing-timing`.

Current alpha.3 Claude-compatible streams expose tool block starts, input JSON
deltas and stops. `runtime::toolwriting` measures this phase separately from
execution and projects ephemeral live previews. Codex's adapter receives tool
items with already-complete arguments. Its `item/started` → `item/completed`
span is execution, so it cannot stand in for generation. Previous item/turn
elapsed time also includes unrelated work/waits. Historical missing observations
must not receive a fabricated value or backfill.

Installed CLI metadata is Codex 0.160.0. The retained generated protocol schema
lists agent/reasoning text deltas, execution output deltas and MCP progress,
but no generic argument-generation delta notification. This is preliminary
schema/source evidence, not a measured claim that the installed process emits
no generation signal. The upstream source similarly maps dynamic-tool starts
with arguments already present; version-specific evidence still governs:
[OpenAI app-server event handling](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs).

Coordinator explicitly authorized an isolated installed-app-server probe on
2026-10-14 16:47:37UTC, only inside rig-opus's contained batch. The prepared
`tools/rig/proofs/codex-generation-signal.mjs` uses a fake HOME/CODEX_HOME under
the rig's D data root, an environment whitelist, no account/auth variables,
and a synthetic loopback Responses server. A preceding text item finishes,
then a 700ms unrelated gap precedes a deliberately 2.5s streamed function-call
argument span. UTC and monotonic timestamps capture each SSE event and actual
app-server notification. The inert dynamic tool returns a synthetic result;
no real tool, model or live profile is used. Shutdown closes stdin gracefully
first; any required forced tree kill records the owned PID/reason durably
before termination. The process must stop before the proof returns.

### Measured installed-Codex outcome (2026-10-14)

The approved real Codex 0.160.0 app-server probe passed 8/8 in rig round 437.
Retained `codex-generation-signal-20261014T170701/{result.json,timeline.json,
timestamps.jsonl}` records the following sequence, relative to probe start:

| Side | Event | Elapsed ms |
| --- | --- | ---: |
| Synthetic SSE | function_call `response.output_item.added` | 1045.333 |
| Synthetic SSE | `response.function_call_arguments.delta` | 1845.466 |
| Synthetic SSE | `response.function_call_arguments.delta` | 2746.514 |
| Synthetic SSE | `response.function_call_arguments.done` | 3546.646 |
| App-server | `item/started`, dynamicToolCall, complete arguments | 3560.200 |
| App-server | `item/tool/call`, complete arguments | 3560.382 |

The app-server emitted no event during the controlled argument-generation
span. It made two loopback requests. Graceful stdin close at 4772.707ms ended
the process at 4793.522ms (exit 0); no forced kill was required, and rig cleanup
reported no runs or strays. The fixture included an unrelated 700ms gap before
argument generation, so the preceding text item's end cannot substitute.

The coordinator closed the product request as **not truthfully available**
with this installed version. No Codex writing time was added or backfilled.
The probe is integrated for rechecking if a later app-server exposes an honest
argument-generation signal. This measures the installed CLI against synthetic
SSE, not a real account/model or every future protocol version.
