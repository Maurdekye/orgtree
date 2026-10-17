# Live reply cadence and settled row reuse

Synthetic timed replay across Claude Code, Codex, Antigravity, Muse and
OpenCode showed prompt token delivery through the engine. Text stdout-to-actor
p95 was below 0.2 ms for four lanes and 1.1 ms for OpenCode; actor-to-socket
p95 was below 0.2 ms. Renderer receipt-to-paint p95 was 30–49 ms. These are
synthetic debug measurements, not measurements of provider networks or native
CLIs. Antigravity's replay omits thoughts; folded durable OpenCode thoughts
are not counted as visible paint.

The avoidable work was in settled transcript rows: the same user row rendered
247–690 times during the short replay. File-card deduplication now preserves
row identity unless it removes a duplicate card. The desk reuses its durable
message-list projection until that list changes, then rebuilds all duplicate
claims before drawing live rows. TranscriptFlow retains segmented projections
for unchanged source rows even while another row grows. Its per-surface weak
cache retains original source indexes and anonymous-row keys when paging moves
rows. Msg ignores reply callbacks when there are no chat replies. Actual mail
reply controls compare their rendered availability; navigation uses the desk's
latest handler through a stable callback. Content, routes, availability and
external handler changes still invalidate the memo.

Token transport, ordering, frame/timer publication, durable handoff and HTTP
recovery remain on their existing paths. No synthetic text is generated and no
reveal delay is added. Only subscribed transcript rooms receive token frames.

`stream-cadence.mjs`, `stream-cadence-report.mjs` and `stream-render-contract.mjs`
under `tools/rig` measure stage denominators, text sizes, cadence and row renders.
`stream-load.mjs` measures one and ten agents with engine timing probes off.
The renderer measurement bundle injects counters at build time; those counters
are absent from production source. Engine probes require both a synthetic rig
root and the opt-in stream-probe flag and record only stage, kind, time and byte
count, never token content. Keep exact source/binary provenance with results.

Render limits count mounted Msg components. A single durable mail carrier may
expand into several segments sharing one row_id; summing those segments gives
a misleading count. The same probe bundle can target either source worktree
with ORGTREE_STREAM_SOURCE, so before/after runs use identical instrumentation.

## Author measurement, 2026-10-17

The final paired replay used the same injected probe on baseline `bac345a`
and candidate `4b45d0e`, with the same debug engine built at `da2c3c7`.
All stdout/actor/room/socket/receipt token counts and byte sizes matched.
All text tokens reached paint; text receipt-to-paint p95 stayed 30–49 ms
before and 30–48 ms after. Token receipt intervals stayed about 20 ms.
The change reduces settled-row work; it does not add transport buffering.

| Harness | Maximum renders per settled component, before | After |
| --- | ---: | ---: |
| Claude Code | 134 | 6 |
| Codex | 137 | 5 |
| Antigravity | 103 | 5 |
| Muse | 134 | 5 |
| OpenCode | 247 | 7 |

With timing probes off and one transcript open, both variants completed all
one-agent and ten-agent turns, saved exactly one/ten durable final replies,
and received zero token frames from the other nine agents.

| Concurrent agents | Engine CPU seconds, before → after | Renderer task seconds, before → after | Renderer script seconds, before → after |
| --- | --- | --- | --- |
| 1 | 0.438 → 0.484 | 1.512 → 0.637 | 0.676 → 0.319 |
| 10 | 2.922 → 2.672 | 1.387 → 0.937 | 0.913 → 0.568 |

These are single synthetic debug runs including fixture overhead, not a
statistical estimate or provider/native CLI performance claim. Engine behavior
is unchanged; the one-agent CPU variation is 47 ms. Focused renderer tests
passed 87/87; measurement controls passed 3/3. The strict compiler reported
the same 30 baseline diagnostics on both sources, with none introduced.
