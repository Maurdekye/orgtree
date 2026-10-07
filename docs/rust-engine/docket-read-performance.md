# Docket and mail read performance (2026-10-07)

The alpha.6 docket archived-list path returned every archived item, and each
item's logged view call formatted the whole shared context. A reference lookup
also fell back to loading that archive when the Rust endpoint returned 409.

## Measurements before these changes

Existing verbose logs covered 316 seconds, with 32,331 per-item view calls.
Active lists (27 samples, 20 items) had median 31.4 ms and p95 35.1 ms.
Archive lists (25 samples, 1,197 items) had median 1,548 ms and p95 2,887 ms.
Summed per-item view durations accounted for median 1,280 ms per archive read.
These are inclusive method timings, not individual SQL timings.

Read-only HTTP samples on the installed engine measured:

| Response | Bytes | Time to headers |
| --- | ---: | ---: |
| Active docket | 53,971 | 53.2 ms |
| Archive and backlog | 5,987,476 | 1,703.5 ms |
| Inbox | 322,811 | 35.1 ms |
| One mail | 2,753 | 2.3 ms |

An isolated renderer replay of the real components measured JSON parsing at
0.8 ms active / 12.5 ms archive / 1.3 ms inbox. React work was 36.6 ms for the
first mail mount and 3.8–5.8 ms warm; docket was 18.3 ms first and 6.3–8.0 ms
warm. This excludes the enclosing application's rerenders. Hidden Electron
frame scheduling was throttled, so its click-to-frame values are invalid and
are deliberately not reported as live click-to-paint. Mail opening issued no
request in this retained-inbox replay. The user's full-shell 250–750 ms mail
delay therefore remains unlocalized; these numbers do not establish its cause.

## Changes

- Per-item `view` is `#[nolog]`, as the user directed at 07:45Z. Request-level
  logs remain. Logging a bounded context reference would also avoid formatting
  its hundreds of kilobytes, but this patch simply exempts the hot helper.
- Named references use an org-scoped lookup capped at 128 names. They no
  longer need a complete archive response from the Rust engine.
- `/work-items-page` returns at most 100 rows from a selected active, archived
  or backlogged group. SQL applies search, sort and agent/team scope before
  LIMIT. Counts cover all matching rows independently of the loaded pages.
- The global, agent, team, desk and attention lists request more at the scroll
  boundary; a Load more button also supports folded/short lists. Polls refresh
  only already-loaded pages, never walk unseen archive pages. Disabled groups
  are dropped. Search is performed on the server across each enabled group.
- Revision and page-time cursors prevent combining different docket revisions
  and hold the one-hour archive boundary stable during a paging sequence.

## Verification and limits

`cargo check --offline -j 2` and renderer typecheck passed. A synthetic real
DocketModal smoke used 350 active, 420 archived and 220 backlogged items: first
page only; repeated scroll coalesced to one next-page request; archive/backlog
first pages only; no background drain; toggle retention/drop; and server search
beyond loaded rows all passed. No live mail was changed.

Read-only EXPLAIN ANALYZE on the production-shaped SQL (implicit parameter type
inference) measured 1–3 ms unfiltered page execution and 30.1 ms for an archive
text search. These are single SQL samples, excluding context loading, counts,
serialization, HTTP and rendering. They are not a deployed endpoint benchmark.
No product binary was built or installed. Deployed p95 under 100 ms and full
live click-to-paint remain to be measured after the coordinator installs it.

## Installed alpha.7 reads and next-frame instrumentation

Measured on installed alpha.7 `1c4be6a`, 25 sequential read-only samples per
endpoint. Total includes HTTP transfer and Python JSON parsing; no live data
was changed and no response bodies were retained.

| Endpoint | p50 ms | p95 ms |
| --- | ---: | ---: |
| Active docket | 18.982 | 26.114 |
| First archive page | 42.615 | 51.514 |
| Backlog | 19.867 | 28.897 |
| Inbox | 29.642 | 32.860 |
| One mail | 2.244 | 12.424 |
| Named references | 12.792 | 23.174 |

Archive returned 100 of 1,196 items, next offset 100, 569,578 bytes. Read latency
is below the target in this sample; this does not establish click-to-paint.

User/coordinator ruling 2026-10-07 09:28Z: instrument real UI opens instead of
computer-use. `opentiming.ts` marks the click, ready React layout commit and
next requestAnimationFrame for mail panel, mail row, global docket, archive
toggle and ticket row opens. Full ticket readiness includes its detail GET;
list and mail readiness excludes loading placeholders. Mail row and ticket
timings include the selected identity so stale selections cannot finish them.
One bounded `UI_OPEN action=... sample=... commit_ms=... frame_ms=... hidden=...
focused=...` measurement line is sent through the authenticated HTTP and engine
trace path. No general renderer-to-engine log endpoint existed; a typed
`/api/diagnostics/ui-open` sink avoids abusing crash reports (which create files
and may send mail). Ordinary request/method tracing remains unchanged.

The existing API response path carries `X-Orgtree-Verbose`; no settings poll is
added. Off means no marks, measurements, observers, animation callbacks or
diagnostic requests. Turning off cancels pending measurements; the engine also
checks verbose before emitting the measurement line. The payload contains only
an enumerated action, counter, finite bounded durations and visibility booleans,
never a mail body, ticket title, account, token or user-entered text.

`frame_ms` is the next paint opportunity after commit, not a physical display or
GPU presentation timestamp. Exclude hidden/unfocused windows from foreground
latency distributions; an occluded Chromium window can still report visible.
Canceled or superseded opens are dropped, not reported as successful paints.
Sampling uses the real user's clicks; no synthetic clicks or data mutations run
in the installed app. Pinned-window raises and programmatic jumps are not new
panel-open samples. Actual distributions await the next installed build.

Verification: cargo check and typecheck pass. A brief isolated renderer smoke
checks docket, fetched ticket, archive and mail-row readiness, all five action
types, one line per completed open, disabled operation, canceled frame and mark
cleanup. The smoke substitutes frame scheduling for deterministic control;
its durations are NOT performance measurements. No renderer performance fix
was inferred from these functional checks.

## Alpha.8 packaged transport check (2026-10-07 12:34Z)

The instrumentation works in the packaged app. The renderer loads from the
engine origin, so cross-origin response-header exposure is not required.
A live read returned verbose=true and X-Orgtree-Verbose:1; the served asset
contains the gate and reporting path. Four earlier events and four successful
diagnostic POSTs had rotated into `2026-10-07_14-01-26.log.*.gz`. Searching only
the current plain log falsely suggested no events. Readers/watchdogs must
include compressed segments belonging to the selected engine run, and match
the full event format at end of line to exclude tool/mail echoes.

The two alpha.8 runs contained these focused, visible samples at measurement:

| Action | n | Frame p50 ms | Frame p95 ms |
| --- | ---: | ---: | ---: |
| Ticket | 2 | 56.0 | 85.4 |
| Mail panel | 3 | 25.1 | 42.7 |
| Mail item | 3 | 4.0 | 9.1 |
| Docket | 1 | 29.7 | 29.7 |
| Archive | 0 | unavailable | unavailable |

These very small samples use nearest-rank p95 (the observed maximum here),
not a stable population estimate. No measured sample exceeds 100 ms; archive
and more repeated opens are still needed. Values can increase as new events
arrive, so always state the sample count.

A separate instrumentation bug was found: reporting through `req(POST)` ran
the product mutation hook, invalidating detail caches and broadcasting
`bumpLive`. Reporting now uses the same authenticated fetch transport and
restart/verbose header processing, with a five-second timeout, but bypasses
mutation invalidation. It cannot itself cause extra docket/mail refreshes.
Renderer typecheck passed. An isolated synthetic API-transport smoke confirms
real header gating, one diagnostic POST with zero live bumps, a normal mutation
still bumping, the off header disabling reporting, and no retained marks.
No engine change or build was needed for this follow-up.
