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
