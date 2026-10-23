# Pending mail disclosure

Long queues can take over an agent's desk. The user approved collapsing runs of
six or more on 2026-10-11 22:33Z, via lead-astra (mail mee853a883c0d).
For 4.4.4, the user chose an always-available queue-group toggle with the same
automatic threshold (2026-10-23, m4f228e48f792).

Shared `DeskChat` applies this to its embedded, modal and detached placements.
Each existing run is separate: current-turn mail above the live response and
waiting mail below it. The threshold and summary count the rows surviving the
existing event deduplication pass. Ordinary messages, typed events and queued
answer rows participate. Optimistic sends and failures remain outside, retaining
their existing dismiss/restore controls. The global pending divider still counts
all pending rows. MailList, Attention and delivered transcript content are unchanged.

`PendingRun` uses native `details`/`summary`: `N queued / undelivered — Show` and
`— Hide`. Native disclosure provides keyboard operation and expanded semantics.
Every nonempty run has a summary, including one queued message. Untouched runs
stay open below six rows and auto-collapse at six or more. A nullable local
choice retains a manual Show or Hide through polling and count changes while
that run stays mounted. Initial/count-driven native toggle events must not
become manual choices. Emptying the run, closing/reopening its desk or starting
a new agent generation resets the choice. Delivery uses normal transcript
presentation; the separate five-line body preview is unchanged.
Cards remain mounted inside the disclosure, retaining their content, individual
folds, reply anchors, attachment links and retraction controls. This saves vertical
space, not payload or DOM memory. Nothing is acknowledged, delivered or fetched by
opening the group. Reply navigation opens a containing pending disclosure
synchronously before scrolling to its target. Disclosure changes call the desk's existing pin/header recalculation: only a reader already following the bottom is pinned.

## Verification

For the 2026-10-23 change: three expected baseline failures, then eight focused
`pendingrun`/`pendingtoggle` cases and TypeScript passed. The first focused run
caught a bottom-follow regression from overriding the summary click; keeping
native disclosure timing fixed it. One inspected 1000×700 synthetic capture
shows a one-message group open with Hide and a six-message group collapsed
with Show; the capture also clicked the one-message group closed and open.
No engine or live data was used. The earlier broad result below is historical.

### Original verification

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
