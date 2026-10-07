# Agent unread mail

2026-10-07. Source-verified and checked with synthetic data; no live data changed.

The jump card uses the destination node's `mail_pending`, supplied by
`feed/compute.rs::AGENT_SQL` and `domain/tree.rs::agent_body`. Canvas badges,
edge jump cards and the Agents List use that same field. Previously the desk
tab used `/chat`'s pending-only row count (at most 200), and mailbox folders
counted their loaded pending window (at most 150). Those counts could disagree
even when each read was fresh.

All agent totals now mean `pending` or `delivering`: mail queued or claimed but
not acknowledged. The desk and mailbox folder use the same node total as the
jump card. `/chat` uses the same state predicate and a window count before its
200-row limit. This matches the 3.x distinction between unconfirmed inflight
mail and mail positively present in the recipient's conversation.

## Delivery boundaries

- A turn's opening batch is recorded separately and acknowledged at its first
  CLI activity. A failure before activity keeps the batch replayable.
- Codex steer success, Claude's PostToolUse hook delivery, and Antigravity's
  consumed-handoff receipt acknowledge their exact batch after the conversation
  receipt is stored. An unconsumed Antigravity handoff is never included merely
  because its turn's opening mail was accepted.
- The update requires the recipient, turn, IDs and `delivering` state to match.
  Repeating it is harmless. Existing end-of-turn settlement remains as fallback.
- Every acknowledgement publishes `Change::Mailbox`, which refreshes both the
  mailbox and the agent record. Unstick continues using normal admission and
  delivery; it does not manufacture a receipt or mark a whole mailbox read.

These are the engine's existing delivery acknowledgement boundaries, not proof
that a model understood the text. The Claude hook boundary is preparing its
successful response; it does not provide an independent model-read receipt.

## Startup repair

Before automatic actor recovery, process `delivering` rows in pages of 256.
Settle a row only if its owning turn belongs to that recipient and was sent,
and a same-agent user conversation row at or after that turn's start contains
the exact mail UID in a well-formed `mail_ids` array. Return the remaining rows
to `pending` with no turn claim. A sent opening prompt alone cannot establish
that later handoffs were consumed. Failures are logged and stop automatic
startup admission rather than silently skipping repair.

Migration `0010_mail_receipts` indexes exact receipt lookup and the outstanding
delivery subset. Repair is idempotent, and uses existing receipts rather than
manual changes or a guess based on an agent being idle. Already settled rows
are untouched. Human inbox read state and org-inbox incoming/read state remain
separate from agent delivery state.

## Measured checks and limits

- Disposable PostgreSQL 18 cluster, production SQL extracted from source:
  176 claimed plus 3 pending reproduced 179 versus the old pending-only 3;
  exact acknowledgement reduced the canonical total to 3. Wrong agent/turn
  and repeated acknowledgements were harmless.
- 205 queued rows reported total 205 despite a 200-row chat window.
- 260 receipt-backed historical deliveries repaired in two bounded pages;
  stale, foreign, unsent, malformed and unconsumed receipts remained queued.
  A second recovery pass changed nothing. EXPLAIN used the receipt GIN index.
- Chromium smoke with real components: jump card, temporary desk tab and
  mailbox folder all displayed 179, 205, 3 and 0 together, even with a stale
  chat count and only three loaded mailbox rows. No browser errors.
- Rust check and renderer typecheck passed. The outside org's exact database
  was not available; its reported 179 cannot be conclusively attributed to
  either defect. Live provider delivery was not exercised.
