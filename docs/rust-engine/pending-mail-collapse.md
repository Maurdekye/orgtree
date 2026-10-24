# Pending mail disclosure

Long queues can take over an agent's desk. The user approved collapsing runs of
six or more on 2026-10-11 22:33Z, via lead-astra (mail mee853a883c0d).
For 4.4.4, the user chose an always-available queue-group toggle with the same
automatic threshold (2026-10-23, m4f228e48f792).

Shared `DeskChat` applies this to its embedded, modal and detached placements.
The user's 2026-10-24 21:36Z correction replaces independent current/later
disclosures: current-turn mail appears normally above the live reply, and neither
is collapsed. Only later undelivered mail sits below the reply under ONE
separator/disclosure. While idle, all undelivered mail belongs to that one group.
It includes system cards such as “Backend restarted”, ordinary/typed messages,
queued answers and optimistic/failed sends with their dismiss/restore controls.
The threshold and summary count these visible waiting rows after event deduplication,
excluding current-turn input. MailList, Attention and delivered history retain
their grouping; pending system cards no longer form separate system bundles.

Current-turn membership requires the chat actor's `busy` snapshot, using the
tree only before a chat snapshot exists. A halted/idle chat has no current-turn
mail, even if old delivery flags remain. Native `stage:'turn'` is authoritative;
legacy `via:'turn'` applies only without a stage, and both require `delivering`.
This changes presentation, not durable delivery state or DnD.

`PendingRun` uses native `details`/`summary`. Since the user's 2026-10-24
19:35:03Z refinement, the arrow and count are in the separator line itself:
`▾ N queued / undelivered` or `▸ N queued / undelivered`. There is no second
count/Show/Hide row. Show/Hide remain the accessible action label and tooltip.
Native disclosure provides keyboard operation and expanded semantics.
Every nonempty queue has a summary, including one queued message. Untouched queues
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

`TranscriptFlow` puts every waiting card under the same `PendingRun` summary.
There is no static boundary for a leading system card and no extra queue label.
Card keys, native toggle timing and nullable manual choice are unchanged.
The shared `DeskChat` supplies this in desk, floating, pinned and popout bodies;
no new mail operation or agent-tool action is introduced.

## Cause and verification (2026-10-24)

Measured before the correction: all four shared DeskChat configurations with
`busy:false`, zero current-turn markers and two waiting rows (system restart,
agent notice) rendered labels “2 queued / undelivered” and “1 queued / undelivered”.
`TranscriptFlow` split system and ordinary entries inside the SAME later list;
no stale current-turn group was needed. A separate synthetic stale-flags case
also reproduced two labels because legacy classification ignored actor activity.
Rust startup recovery already settles/requeues unsettled deliveries; this
synthetic reproduction does not establish a recovery failure in the user's org.

The focused controls cover idle placement parity, native/legacy current-turn
markers, stale flags versus an idle actor snapshot, queue thresholds/manual
choice, ghosts, delivery transitions, reply reveal and delivered system history.
The isolated capture uses synthetic idle data and the real shared chat bodies;
it does not exercise native popout chrome or live provider/delivery operations.

## Historical verification (superseded grouping)

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
