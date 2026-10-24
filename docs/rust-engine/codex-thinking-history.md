# Codex sealed thinking and agent transcript reads

Completed Codex reasoning items without readable summary/content now append a
normal assistant row with empty response/thinking text and `thinking_sealed:
true`. The existing desk renderer displays its sealed thought placeholder.
Readable native summaries keep the existing 20,000-character storage bound.
Ciphertext, fabricated reasoning, duration and token counts are not added by
the row constructor. Measured lifecycle timing is attached separately below.
This records new completed items; there is no historical sealed-row backfill.

The actor reuses the native item's row sequence for repeated completion receipts
within its turn. A later readable receipt replaces the marker; an empty replay
cannot hide an already supplied summary. Tool chips already attached to that row
survive updates. Codex rows keep the ordinary unordered form because later tools
attach there; adding only an ordered thinking block would hide those chips.

`orgtree_read_transcript` now projects supplied readable thinking for every
harness, independently capped at 1,200 Unicode characters per row. It reports
`thinking_truncated` and `thinking_sealed`; the latter recognizes both row flags
and sealed ordered thought blocks. A mixed Claude row may supply text and also
contain a sealed block. Existing role/prose/tool, incomplete/interrupted,
authorization, paging and activity metadata remain unchanged. No encrypted text
is recovered and no read starts a provider turn.

The constructor, native item handler and thinking projection are unlogged
content-bearing helpers. Tests cover source red controls, sealed/readable row
construction, same-item upgrades and tools, isolated PostgreSQL history reload,
all-harness projection shapes and Unicode bounds, plus existing renderer sealed
and readable thought forms. No real provider invocation is needed.

Verbose traces also redact supplied thinking in the shared JSON formatter.
Ordinary structured thinking fields are masked; thought blocks and JSON text
inside Done/MCP/legacy results are omitted when they contain thinking, including
nested encodings. Log-only decoding has size/depth bounds and fails closed.
Actual tool replies remain intact, with ordinary call/return diagnostics kept.
The captured-trace regression exercises Done.json and logged outer wrappers.

## Reasoning item duration (2026-10-24, 4.4.5)

New Codex reasoning rows use the same thought disclosure and seconds formatter
as Claude. The installed Codex 0.160.0 protocol schema supplies `threadId`,
`turnId`, `item.id`, and outer `startedAtMs` / `completedAtMs` Unix milliseconds
on reasoning item start/completion notifications. A valid pair takes precedence;
when those timestamps are absent or invalid, the observed monotonic interval
between the matching native boundaries is used. This measures the reported item
lifecycle, not unavailable model-internal computation or a whole turn.

The actor observes each boundary before diagnostic/database awaits. Timing is
private to one turn, limited to 1,024 native item IDs (512 bytes each), and
validated against the current process's thread and admitted turn. Duplicate
starts cannot restart a clock; the first completion freezes its duration.
A completion without a start remains unknown, including after a later replayed
start. Different item types/IDs/threads/turns cannot donate time. There is no
historical inference or backfill from row timestamps or token counts.

The existing ordinary row retains `think_secs`, including measured zero, after
JSON storage/reload, sealed-to-readable upgrades and attached tool updates.
Readable thoughts remain expandable; sealed thoughts retain the existing
placeholder. Unknown time keeps the existing unknown-time presentation.
No new tool/action is introduced. The actor, row and timing helpers are unlogged;
the clock holds identity and timing metadata only, never reasoning content.

Verification uses recorded notification shapes and actual product modules with
a deterministic clock, plus the ordinary renderer. Protocol schema inspection
is not a real-provider turn or hands-on acceptance proof.
