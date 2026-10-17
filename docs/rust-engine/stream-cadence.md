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
