# Pending mail disclosure

Long queues can take over an agent's desk. The user approved collapsing runs of
six or more on 2026-10-11 22:33Z, via lead-astra (mail mee853a883c0d).

Shared `DeskChat` applies this to its embedded, modal and detached placements.
Each existing run is separate: current-turn mail above the live response and
waiting mail below it. The threshold and summary count the rows surviving the
existing event deduplication pass. Ordinary messages, typed events and queued
answer rows participate. Optimistic sends and failures remain outside, retaining
their existing dismiss/restore controls. The global pending divider still counts
all pending rows. MailList, Attention and delivered transcript content are unchanged.

`PendingRun` uses native `details`/`summary`: `N queued / undelivered — Show` and
`— Hide`. Native disclosure provides keyboard operation and expanded semantics.
Small runs stay open without a summary. Each mounted desk/run owns its disclosure;
updates to the same run retain an explicit expansion, and an emptied run resets.
Cards remain mounted inside the disclosure, retaining their content, individual
folds, reply anchors, attachment links and retraction controls. This saves vertical
space, not payload or DOM memory. Nothing is acknowledged, delivered or fetched by
opening the group. Reply navigation opens a containing pending disclosure
synchronously before scrolling to its target. Disclosure changes call the desk's existing pin/header recalculation: only a reader already following the bottom is pinned.

## Verification

Measured: TypeScript no-emit check passes. The new mounted `pendingrun` cases and
existing `turnpend`, `pending-style`, `pendexpand`, `noticeborder`, `askhandoff`
suites pass: 52 tests, zero failures. Tests cover five/six threshold, arrivals and
shrinking queues, retained card DOM, independent runs around a live response,
deduplicated counts, typed notices, optimistic/failed send visibility, delivery
handover, reply-target reveal before scroll, and bottom-follow versus upward-scroll intent. Existing suites emit React act
warnings. The test process is bounded to 2 GB, 120 seconds and one file at a time.

No engine or live data was used. jsdom proves DOM state/order, not painted layout,
real keyboard events or native accessibility-tree output. Those remain unmeasured;
the native HTML disclosure supplies the standard keyboard/accessibility behavior.
